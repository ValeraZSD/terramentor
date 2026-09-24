import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Film, RotateCcw } from 'lucide-react';
import Modal from '../Modal';
import { Button, ButtonLink } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import { SettingGroup, SettingRow } from '../ui/SettingRow';
import { useStore } from '../../store';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { AtlasRegion, AtlasSurface } from '../../types';
import { AtlasColorMode, CourseHue } from './atlasColors';
import { CourseTrace, HOLD_MAX_MS, SPEED_MAX, SPEED_MIN } from './coursePaths';
import {
    ASPECTS, AspectId, AtlasSettings, FPS_CHOICES, OUTPUTS, OutputId, RESOLUTIONS,
    isDefaultAtlasSettings, outputFps, outputFrame,
} from './atlasSettings';
import AtlasRenderStage, { filmLengthMs } from './AtlasRenderStage';
import { GIF_FORMAT, Recording, canRenderGif, canRenderVideo, pickVideoFormat, videoFileName } from './videoRecorder';

/** The dial's resolution. A quarter-step is a change you can see; a hundredth is not. */
const SPEED_STEP = 0.25;
/** …and the dwell's, in ms. Quarter-seconds, because that is how it is read. */
const HOLD_STEP = 250;
/** How long a dwell the slider offers, short of what the arithmetic allows. */
const HOLD_SLIDER_MAX = 3000;

type Mode = 'settings' | 'rendering' | 'done';

interface Props {
    open: boolean;
    onClose: () => void;
    regions: AtlasRegion[];
    trace: CourseTrace | null;
    courseName: string;
    surface: AtlasSurface;
    dark: boolean;
    themeTint: string;
    accent: string;
    colorMode: AtlasColorMode;
    hues: Map<number, CourseHue>;
}

/**
 * The atlas viewer's own settings, and the one thing they are for that is not a
 * setting: making a video of the course you have traced.
 *
 * It opens from the gear beside Play, which is where the reader already is when
 * any of this becomes a question — a replay running too fast to read the topic
 * names is a thing you notice while watching one, not while reading a settings
 * page two screens away. Everything in it is a PREFERENCE and outlives the
 * dialog, so the same course replays at the same pace tomorrow and on the other
 * surface.
 *
 * The render lives here rather than behind its own button for the same reason
 * the dials do: fps and aspect ratio are settings of the same thing, the reader
 * has just chosen the pace the film will run at, and a second dialog to carry
 * three more fields would be a second place to look for the same subject. So
 * the dialog has three faces — the settings, the film being made, and the film
 * — and only ever one of them at a time.
 */
export default function AtlasSettingsModal({
    open, onClose, regions, trace, courseName, surface,
    dark, themeTint, accent, colorMode, hues,
}: Props) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const settings = useStore(s => s.atlasSettings);
    const setAtlasSettings = useStore(s => s.setAtlasSettings);
    const resetAtlasSettings = useStore(s => s.resetAtlasSettings);
    const showConfirm = useStore(s => s.showConfirm);
    const addToast = useStore(s => s.addToast);

    const [mode, setMode] = useState<Mode>('settings');
    const [result, setResult] = useState<{ url: string; recording: Recording } | null>(null);

    const videoFormat = useMemo(() => pickVideoFormat(), []);
    const canVideo = useMemo(() => canRenderVideo(), []);
    const canGif = useMemo(() => canRenderGif(), []);
    const gif = settings.output === 'gif';
    const format = gif ? GIF_FORMAT : videoFormat;
    const canRender = gif ? canGif : canVideo;
    const steps = trace?.journey.length ?? 0;
    const frame = outputFrame(settings);
    const fps = outputFps(settings);

    // The blob URL outlives the element that showed it — a reader can press
    // Download and close in the same second, and revoking on that frame kills
    // the download the press just started. So it is released a tick late, when
    // the dialog has moved on from it, and never while it is still on screen.
    useEffect(() => () => {
        if (result) setTimeout(() => URL.revokeObjectURL(result.url), 0);
    }, [result]);

    // Closing the dialog abandons a render in progress rather than leaving it
    // recording something nobody is watching. The stage's own cleanup stops the
    // recorder; this is only about which face the dialog opens on next time.
    useEffect(() => { if (!open) setMode('settings'); }, [open]);

    const patch = (next: Partial<AtlasSettings>) => void setAtlasSettings(next);

    const reset = async () => {
        const ok = await showConfirm({
            title: tr("Back to the standard viewer?"),
            message: tr("The replay’s speed and pause, the region names and the video settings all go back to how they arrived. Nothing about your courses changes."),
            confirmLabel: tr("Reset"),
            cancelLabel: tr("Keep mine"),
            // `info`, not `warning`. Nothing here is destroyed — six dial
            // positions go back to where they started — and an amber triangle
            // over an orange "Reset" says something is at stake that is not.
            variant: 'info',
        });
        if (ok) await resetAtlasSettings();
    };

    const startRender = () => {
        // The effect above releases whatever was there; this only clears it.
        setResult(null);
        setMode('rendering');
    };

    const onDone = (recording: Recording) => {
        setResult({ url: URL.createObjectURL(recording.blob), recording });
        setMode('done');
    };

    const onFailed = (message: string) => {
        setMode('settings');
        addToast('error', tr("The render stopped"), message);
    };

    const title = mode === 'rendering' ? tr("Rendering the journey")
        : mode === 'done' ? (result?.recording.format.extension === 'gif' ? tr("Your GIF") : tr("Your video"))
            : tr("Atlas viewer");

    return (
        <Modal isOpen={open} onClose={onClose} title={title} maxWidth="max-w-2xl">
            {mode === 'rendering' && trace && format ? (
                <AtlasRenderStage
                    regions={regions}
                    trace={trace}
                    courseName={courseName}
                    surface={surface}
                    settings={settings}
                    format={format}
                    dark={dark}
                    themeTint={themeTint}
                    accent={accent}
                    colorMode={colorMode}
                    hues={hues}
                    onDone={onDone}
                    onFailed={onFailed}
                    onCancel={() => setMode('settings')}
                />
            ) : mode === 'done' && result ? (
                <div className="space-y-4">
                    {/* The file itself, played by the browser that wrote it —
                        the only honest preview there is, and the one place a
                        reader finds out that the thing they are about to post
                        is what they wanted. */}
                    {result.recording.format.extension === 'gif' ? (
                        <img
                            src={result.url}
                            alt={tr("The journey through {{course}}, as a GIF", { course: courseName })}
                            className="mx-auto max-w-full max-h-[50vh] rounded-xl bg-slate-900"
                        />
                    ) : (
                        <video
                            src={result.url}
                            controls
                            autoPlay
                            loop
                            playsInline
                            className="w-full max-h-[50vh] rounded-xl bg-slate-900"
                        />
                    )}
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        {/* A frame size and a rate are IDENTIFIERS, not
                            quantities: nobody writes 1 920 × 1 080, and the
                            reader's grouping separator would be the only thing
                            that made them look like measurements. The file's
                            size is a quantity and is written the reader's way. */}
                        {tr("{{width}} × {{height}}, {{fps}} frames a second, {{size}} MB.", { count: fps,
                            width: frame.width,
                            height: frame.height,
                            fps,
                            size: num(Math.max(0.1, Math.round(result.recording.blob.size / 1e5) / 10)),
                        })}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <ButtonLink
                            variant="primary"
                            href={result.url}
                            download={videoFileName(courseName, result.recording.format)}
                            icon={<Download className="w-4 h-4" aria-hidden="true" />}
                        >
                            {tr("Download")}
                        </ButtonLink>
                        <Button variant="subtle" icon={<Film className="w-4 h-4" aria-hidden="true" />} onClick={startRender}>
                            {tr("Render again")}
                        </Button>
                        <Button variant="quiet" onClick={() => setMode('settings')}>{tr("Settings")}</Button>
                    </div>
                </div>
            ) : (
                // The dialog's body is RECESSED, bleeding to the panel's own
                // edges. `SettingGroup`'s cards are `bg-white dark:bg-slate-800`
                // — which is exactly what a modal panel is made of, so on the
                // Settings page they lift off a slate-50 page and in here they
                // were invisible: three captions over one flat surface, with the
                // hairlines between rows doing all the work and the gap between
                // groups reading as a gap in a list. One background, and the
                // rows become cards again.
                <div className="-mx-6 -my-4 px-6 py-4 bg-slate-50 dark:bg-slate-900/60">
                    <SettingGroup title={tr("The replay")}>
                        <SettingRow
                            label={tr("Speed")}
                            hint={tr("How fast the arrow crosses the library.")}
                            control={
                                <div className="flex items-center gap-3">
                                    <Slider
                                        className="w-40 sm:w-52"
                                        min={SPEED_MIN}
                                        max={SPEED_MAX}
                                        step={SPEED_STEP}
                                        value={settings.speed}
                                        onChange={speed => patch({ speed })}
                                        label={tr("Speed")}
                                        valueText={tr("{{times}} times the standard speed", { count: settings.speed, times: num(settings.speed) })}
                                    />
                                    <span className="w-12 shrink-0 text-right text-sm tabular-nums text-slate-600 dark:text-slate-300">
                                        ×{num(settings.speed)}
                                    </span>
                                </div>
                            }
                        />
                        <SettingRow
                            label={tr("Pause on each topic")}
                            hint={tr("Time to read the name it has just landed on.")}
                            control={
                                <div className="flex items-center gap-3">
                                    <Slider
                                        className="w-40 sm:w-52"
                                        min={0}
                                        max={Math.min(HOLD_SLIDER_MAX, HOLD_MAX_MS)}
                                        step={HOLD_STEP}
                                        value={Math.min(settings.holdMs, HOLD_SLIDER_MAX)}
                                        onChange={holdMs => patch({ holdMs })}
                                        label={tr("Pause on each topic")}
                                        valueText={tr("{{seconds}} seconds", { count: settings.holdMs / 1000, seconds: num(settings.holdMs / 1000) })}
                                    />
                                    <span className="w-12 shrink-0 text-right text-sm tabular-nums text-slate-600 dark:text-slate-300">
                                        {num(settings.holdMs / 1000)}s
                                    </span>
                                </div>
                            }
                        />
                    </SettingGroup>

                    <SettingGroup title={tr("The map")}>
                        <SettingRow
                            label={tr("Region names")}
                            hint={tr("Off leaves the course’s line on a map of colour alone.")}
                            control={
                                <Switch
                                    checked={settings.regionNames}
                                    onChange={regionNames => patch({ regionNames })}
                                    label={tr("Region names")}
                                />
                            }
                        />
                    </SettingGroup>

                    <SettingGroup
                        title={tr("Video")}
                        intro={canRender ? undefined
                            : tr("This browser cannot record a canvas, so a video cannot be made here. Chrome, Edge and Firefox can.")}
                    >
                        <SettingRow
                            label={tr("Format")}
                            hint={gif
                                ? tr("{{width}} × {{height}}, {{fps}} frames a second. Plays anywhere an image does — a README, a chat, a slide.", { count: fps,
                                    width: frame.width, height: frame.height, fps,
                                })
                                : tr("The sharpest and smallest for the size. Posts to video sites; needs a player.")}
                            control={
                                <SegmentedControl<OutputId>
                                    size="sm"
                                    label={tr("Format")}
                                    value={settings.output}
                                    onChange={output => patch({ output })}
                                    options={OUTPUTS.map(o => ({
                                        value: o,
                                        label: o === 'gif' ? 'GIF' : (videoFormat?.label ?? tr("Video")),
                                    }))}
                                />
                            }
                        />
                        <SettingRow
                            label={tr("Shape")}
                            control={
                                <SegmentedControl<AspectId>
                                    size="sm"
                                    label={tr("Shape")}
                                    value={settings.aspect}
                                    onChange={aspect => patch({ aspect })}
                                    options={ASPECTS.map(a => ({
                                        value: a.id,
                                        label: a.id,
                                        title: {
                                            '16:9': tr("Wide, for a screen"),
                                            '9:16': tr("Upright, for a phone"),
                                            '1:1': tr("Square"),
                                        }[a.id],
                                    }))}
                                />
                            }
                        />
                        {!gif && <SettingRow
                            label={tr("Size")}
                            hint={tr("{{width}} × {{height}} pixels", { count: frame.height, width: frame.width, height: frame.height })}
                            control={
                                <SegmentedControl<number>
                                    size="sm"
                                    label={tr("Size")}
                                    value={settings.resolution}
                                    onChange={resolution => patch({ resolution })}
                                    options={RESOLUTIONS.map(r => ({ value: r, label: `${r}p` }))}
                                />
                            }
                        />}
                        {!gif && <SettingRow
                            label={tr("Frames a second")}
                            control={
                                <SegmentedControl<number>
                                    size="sm"
                                    label={tr("Frames a second")}
                                    value={settings.fps}
                                    onChange={fps => patch({ fps })}
                                    options={FPS_CHOICES.map(f => ({ value: f, label: String(f) }))}
                                />
                            }
                        />}
                        <SettingRow
                            label={gif ? tr("Make the GIF") : tr("Make the video")}
                            hint={steps < 2
                                ? tr("This course has no journey to film yet — two finished topics make one.")
                                : tr("About {{length}} of the course replaying, from the whole shape to the last topic.", {
                                    length: spokenLength(trace ? filmLengthMs(trace, settings) : 0, tr, num),
                                })}
                            control={
                                <Button
                                    variant="primary"
                                    icon={<Film className="w-4 h-4" aria-hidden="true" />}
                                    disabled={!canRender || !trace || steps < 2}
                                    onClick={startRender}
                                >
                                    {tr("Render")}
                                </Button>
                            }
                        />
                    </SettingGroup>

                    <div className="flex justify-end pt-1">
                        <Button
                            variant="quiet"
                            icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}
                            disabled={isDefaultAtlasSettings(settings)}
                            onClick={() => void reset()}
                        >
                            {tr("Reset to defaults")}
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
}

/**
 * A length of film the way someone says it out loud: seconds under a minute,
 * minutes and seconds over. Rounded to the second, because the number is about
 * whether a reader will sit through it.
 */
function spokenLength(
    ms: number, tr: (k: string, o?: any) => string, num: (n: number) => string,
): string {
    const total = Math.max(1, Math.round(ms / 1000));
    if (total < 60) return tr("{{seconds}}s", { seconds: num(total) });
    return tr("{{minutes}}m {{seconds}}s", { minutes: num(Math.floor(total / 60)), seconds: num(total % 60) });
}
