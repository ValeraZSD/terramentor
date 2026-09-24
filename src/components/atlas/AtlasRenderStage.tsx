import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AtlasRegion } from '../../types';
import { AtlasColorMode, CourseHue } from './atlasColors';
import AtlasMap from './AtlasMap';
import GlobeMap from './GlobeMap';
import { CourseTrace, END_HOLD_MS, stepDurationMs } from './coursePaths';
import { AtlasSettings, ASPECTS, outputFps, outputFrame, paceOf } from './atlasSettings';
import { AtlasStage, useJourneyReplay } from './useJourneyReplay';
import { CanvasRecorder, Recording, VideoFormat, recordCanvas, recordCanvasGif } from './videoRecorder';
import { Button } from '../ui/Button';
import { useNumberFormat } from '../../hooks/useNumberFormat';

/**
 * How long the opening shot is held before the walk starts.
 *
 * A video that starts moving on frame one gives the viewer nowhere to stand —
 * they have to work out what they are looking at while it is already sliding.
 * A beat of the finished shape first is what makes the walk legible.
 */
const OPENING_HOLD_MS = 1300;
/**
 * How long the finished shot is held once the ending has come to rest.
 *
 * A film is played on a loop as often as it is played once, and a loop is only
 * seamless if the last frame IS the first: the whole course, framed, still. So
 * the recorder opens only once the surface has settled on that shot (the camera
 * is cut to it, not flown, and nothing is still fading in), and it stops only
 * once the ending's pull-out has settled back on the very same shot — however
 * long that takes — and been held for this long.
 */
const CLOSING_HOLD_MS = 700;
/**
 * The ending's pull-out, for the length ESTIMATE only (`filmLengthMs`): the
 * camera lets go and drifts out over about a second and a half (`END_OMEGA` in
 * `journeyStyle.ts`). The film itself waits for the surface to say it settled.
 */
const ENDING_ESTIMATE_MS = 1900 + CLOSING_HOLD_MS;
/** Longer than any settle can take: past this something is still moving on purpose. */
const SETTLE_LIMIT_MS = 8000;

/**
 * How long the canvas is given to reach the frame's pixel size before the
 * recorder gives up on it, in frames.
 *
 * It matters because a `MediaRecorder` takes the track's dimensions at START
 * and never revisits them: opened one frame too early it films a 300×150
 * default canvas and writes a perfectly valid video of the wrong size. So the
 * recorder waits for the sizing observer rather than assuming it has run.
 */
const SIZE_WAIT_FRAMES = 120;

type Phase = 'opening' | 'walking' | 'ending' | 'saving';

interface Props {
    regions: AtlasRegion[];
    trace: CourseTrace;
    courseName: string;
    surface: 'map' | 'globe';
    settings: AtlasSettings;
    format: VideoFormat;
    dark: boolean;
    /** The theme tint — see the same prop on `AtlasMap`. */
    themeTint: string;
    accent: string;
    colorMode: AtlasColorMode;
    hues: Map<number, CourseHue>;
    onDone: (recording: Recording) => void;
    onFailed: (message: string) => void;
    onCancel: () => void;
}

/**
 * The atlas being filmed: a second copy of whichever surface the reader is on,
 * laid out at the video's own shape, replaying the traced course while a
 * recorder pulls frames off its canvas.
 *
 * A SECOND surface rather than the page's, because the frame is not the page:
 * the video is 16:9 or 9:16 at a size the reader chose, and the map behind the
 * dialog is whatever shape the window left it. Filming the page's canvas would
 * mean either cropping the picture or resizing the reader's map under them, and
 * it would also mean the replay they are watching and the one being recorded are
 * the same replay — so pausing to look at something would land in the file.
 *
 * The preview IS the frame, scaled down by nothing but its own box: the canvas
 * backing store is the video's exact pixel size and the box is where it is
 * drawn (`atlasCapture.ts`). So what the reader watches here is what the file
 * holds, down to which region names fitted.
 */
export default function AtlasRenderStage({
    regions, trace, courseName, surface, settings, format,
    dark, themeTint, accent, colorMode, hues, onDone, onFailed, onCancel,
}: Props) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const boxRef = useRef<HTMLDivElement | null>(null);
    const stageRef = useRef<AtlasStage | null>(null);
    const recorderRef = useRef<CanvasRecorder | null>(null);
    const [phase, setPhase] = useState<Phase>('opening');

    const frame = useMemo(() => outputFrame(settings), [settings]);
    // Memoised, or every render of this component would hand the surface a new
    // object and its sizing observer would be torn down and rebuilt mid-film.
    const capture = useMemo(() => ({ width: frame.width, height: frame.height }), [frame.width, frame.height]);
    const pace = useMemo(() => paceOf(settings), [settings]);
    const aspect = ASPECTS.find(a => a.id === settings.aspect) ?? ASPECTS[0];

    const total = trace.journey.length;
    const finish = useRef<() => void>(() => { });
    const replay = useJourneyReplay(trace, stageRef, pace, () => finish.current());
    const { step, restart } = replay;

    // Everything the run needs that must not restart it. The film is one
    // sequence with its own clock; a dependency change halfway through would
    // stop the recorder and leave a truncated file.
    const live = useRef({ onDone, onFailed, restart });
    live.current = { onDone, onFailed, restart };

    // ---- the run -------------------------------------------------------------
    // One effect for the whole film, armed once. It waits for the canvas to
    // reach the frame's size, opens the recorder, holds the opening shot, and
    // sets the replay going; the ending is handed to it by the replay's own
    // clock through `finish`.
    useEffect(() => {
        let cancelled = false;
        let frames = 0;
        let raf = 0;
        let openingTimer = 0;
        let tailTimer = 0;
        let settleRaf = 0;

        /** Call `then` on the first frame the surface reports nothing moving. */
        const whenSettled = (then: () => void) => {
            const since = performance.now();
            const check = () => {
                if (cancelled) return;
                if (stageRef.current?.settled() || performance.now() - since > SETTLE_LIMIT_MS) { then(); return; }
                settleRaf = requestAnimationFrame(check);
            };
            settleRaf = requestAnimationFrame(check);
        };

        const begin = () => {
            const canvas = stageRef.current?.canvas();
            if (cancelled) return;
            // Not sized yet. The observer runs at the end of a frame, so this
            // is normally one or two of them — but a document that is not being
            // painted never gets one at all, which is why it gives up rather
            // than waiting for ever.
            if (!canvas || canvas.width !== capture.width || canvas.height !== capture.height) {
                if (++frames > SIZE_WAIT_FRAMES) {
                    live.current.onFailed(tr("The frame never reached its size, so nothing was recorded."));
                    return;
                }
                raf = requestAnimationFrame(begin);
                return;
            }
            // The whole course, CUT to rather than flown to, and settled before
            // the first frame is taken: the film opens on the shot it ends on.
            stageRef.current?.frameOnCourse(trace, { instant: true });
            whenSettled(() => {
                try {
                    recorderRef.current = format.extension === 'gif'
                        ? recordCanvasGif(canvas, outputFps(settings))
                        : recordCanvas(canvas, outputFps(settings), format);
                } catch (e: any) {
                    live.current.onFailed(e?.message || tr("This browser would not start a recording."));
                    return;
                }
                openingTimer = window.setTimeout(() => {
                    if (cancelled) return;
                    setPhase('walking');
                    live.current.restart();
                }, OPENING_HOLD_MS);
            });
        };

        finish.current = () => {
            if (cancelled) return;
            setPhase('ending');
            // The pull-out runs until it has come to rest on the opening shot,
            // then that shot is held — so the last frame and the first match.
            whenSettled(() => {
                tailTimer = window.setTimeout(async () => {
                    if (cancelled) return;
                    setPhase('saving');
                    const rec = recorderRef.current;
                    recorderRef.current = null;
                    if (!rec) return;
                    try {
                        live.current.onDone(await rec.stop());
                    } catch (e: any) {
                        live.current.onFailed(e?.message || tr("The recording could not be saved."));
                    }
                }, CLOSING_HOLD_MS);
            });
        };

        raf = requestAnimationFrame(begin);
        return () => {
            cancelled = true;
            if (raf) cancelAnimationFrame(raf);
            if (settleRaf) cancelAnimationFrame(settleRaf);
            window.clearTimeout(openingTimer);
            window.clearTimeout(tailTimer);
            recorderRef.current?.cancel();
            recorderRef.current = null;
        };
        // Armed once, on purpose: see `live` above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- how big the preview may be -----------------------------------------
    // The box is the largest rectangle of the frame's own shape that fits the
    // room the dialog has, capped in HEIGHT as well as width — a 9:16 frame
    // given a 600px-wide dialog would otherwise be over a thousand pixels tall
    // and the progress bar under it would be off the bottom of the screen.
    const [room, setRoom] = useState({ w: 0, h: 0 });
    useEffect(() => {
        const measure = () => setRoom({
            w: boxRef.current?.clientWidth ?? 0,
            h: Math.max(180, Math.min(420, window.innerHeight * 0.42)),
        });
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, []);
    const box = useMemo(() => {
        const w0 = room.w > 0 ? room.w : 320;
        const byWidth = { w: w0, h: (w0 * aspect.h) / aspect.w };
        if (byWidth.h <= room.h || room.h === 0) return byWidth;
        return { w: (room.h * aspect.w) / aspect.h, h: room.h };
    }, [room, aspect]);

    const walked = phase === 'opening' ? 0 : step == null ? total : step;
    const done = phase === 'ending' || phase === 'saving' ? 1 : total > 0 ? walked / total : 0;
    const caption = {
        opening: tr("Setting up the shot…"),
        walking: tr("Step {{at}} of {{steps}}", { at: num(walked), steps: num(total) }),
        ending: tr("Pulling back to the whole course…"),
        saving: tr("Writing the file…"),
    }[phase];

    const shared = {
        regions,
        selectedId: null,
        onSelect: () => { },
        onOpenTopic: () => { },
        matches: null,
        dark, themeTint, accent, colorMode, hues,
        trace,
        journeyStep: step,
        pace,
        regionNames: settings.regionNames,
        capture,
        fullscreen: false,
        onToggleFullscreen: () => { },
    };

    return (
        <div ref={boxRef} className="space-y-3">
            {/* The frame, drawn at its own shape and centred in whatever the
                dialog has room for. The ring is the dialog's, not the map's:
                the surface draws no border of its own while capturing, because
                a rounded edge would be baked into the video. */}
            <div
                className="mx-auto overflow-hidden rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 bg-slate-100 dark:bg-slate-900"
                style={{ width: box.w, height: box.h }}
            >
                {surface === 'globe'
                    ? <GlobeMap ref={h => { stageRef.current = h; }} {...shared} />
                    : <AtlasMap ref={h => { stageRef.current = h; }} {...shared} />}
            </div>

            <div>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-slate-700 dark:text-slate-200">{caption}</span>
                    <span className="tabular-nums text-slate-500 dark:text-slate-400">
                        {num(Math.round(done * 100))}%
                    </span>
                </div>
                <div
                    role="progressbar"
                    aria-label={tr("Rendering {{course}}", { course: courseName })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(done * 100)}
                    className="mt-1.5 h-2 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700"
                >
                    <div
                        className="h-full bg-accent transition-[width] duration-200 ease-out"
                        style={{ width: `${Math.round(done * 100)}%` }}
                    />
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Said plainly rather than hidden, because it is the one thing
                    a reader can do wrong here: the frames are pulled off a
                    canvas the browser only paints while this tab is in front,
                    so a render left in a background tab comes out as a stutter
                    nobody can explain afterwards. */}
                <p className="text-xs text-slate-500 dark:text-slate-400 basis-full sm:basis-auto sm:flex-1 sm:min-w-[14rem]">
                    {tr("Keep this window in front while it records — a background tab stops drawing.")}
                </p>
                <Button variant="quiet" onClick={onCancel}>{tr("Cancel")}</Button>
            </div>
        </div>
    );
}

/**
 * How long the film will run, in ms — the replay's own beats, added up, plus
 * the opening shot and the ending.
 *
 * Deterministic arithmetic over the course, not a prediction about a machine:
 * every one of these numbers is a timeout this app sets. What it cannot promise
 * is that a browser gives every frame it is asked for, which is why the dialog
 * says "about" and the progress bar counts STEPS rather than counting down.
 */
export function filmLengthMs(trace: CourseTrace, settings: AtlasSettings): number {
    const pace = paceOf(settings);
    let ms = OPENING_HOLD_MS + END_HOLD_MS + ENDING_ESTIMATE_MS;
    for (let step = 1; step <= trace.journey.length; step++) {
        ms += stepDurationMs(trace, step, pace);
    }
    return ms;
}
