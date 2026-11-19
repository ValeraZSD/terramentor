import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Play, RotateCcw } from 'lucide-react';
import { useStore } from '../../store';
import { MOD_KEY, usePhysicalKeyboard, usePointerVerb } from '../../utils/platform';
import {
    CONTRAST_PREFS, DEFAULT_A11Y, MAX_SPEECH_RATE, MIN_SPEECH_RATE, MOTION_PREFS, SPACING_LEVELS,
    SPEECH_RATE_STEP, systemReducesMotion, systemWantsMoreContrast, watchSystemPreferences,
    type ContrastPref, type MotionPref, type SpacingLevel,
} from '../../utils/accessibility';
import { listFormat } from '../../utils/locale';
import { currentSpeaker, localVoices, speak, speechAvailable, stopSpeaking, voicesReady, watchVoices } from '../../utils/readAloud';
import { DRILL_TIME_SCALES, type DrillTimeScale } from '../drills/parseDrill';
import { CALENDAR_KEYCAPS } from '../calendar/calendarKeys';
import { Button, IconButton } from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import Slider from '../ui/Slider';
import Stepper from '../ui/Stepper';
import Switch from '../ui/Switch';
import { SettingGroup, SettingRow } from '../ui/SettingRow';

/** The system's answer to the two questions a choice of "System" defers to,
 *  kept live: the OS setting can change while this page is open. */
function useSystemPreferences() {
    const read = () => ({ reduce: systemReducesMotion(), more: systemWantsMoreContrast() });
    const [state, setState] = useState(read);
    useEffect(() => watchSystemPreferences(() => setState(read())), []);
    return state;
}

/** The languages this computer can speak with its own voices, by name. */
function useVoiceLanguages(enabled: boolean): string[] | null {
    const { i18n } = useTranslation();
    const [langs, setLangs] = useState<string[] | null>(null);
    useEffect(() => {
        if (!enabled || !speechAvailable()) { setLangs(null); return; }
        let live = true;
        const read = () => {
            const names = new Intl.DisplayNames([i18n.language], { type: 'language' });
            const seen = new Set<string>();
            for (const v of localVoices()) {
                const base = v.lang.split(/[-_]/)[0]?.toLowerCase();
                if (!base) continue;
                try { seen.add(names.of(base) ?? base); } catch { seen.add(base); }
            }
            if (live) setLangs([...seen].sort((a, b) => a.localeCompare(b, i18n.language)));
        };
        void voicesReady().then(read);
        const stop = watchVoices(read);
        return () => { live = false; stop(); };
    }, [enabled, i18n.language]);
    return langs;
}

/**
 * Settings → Accessibility: how the app looks, reads, sounds and times for
 * someone it does not fit by default. Every row starts where the system is
 * (contrast and motion say "System" and follow the OS) or where the app was
 * before the row existed, so nobody's app changes by opening this page.
 *
 * Every row is in the settings registry, and every row but the drill time
 * limit (a learning row) is one the assistant can set too
 * (`src/utils/assistantSettings.ts`).
 */
export default function AccessibilitySettings({ active }: { active: boolean }) {
    const { t: tr, i18n } = useTranslation();
    const a11y = useStore(s => s.a11y);
    const setA11y = useStore(s => s.setA11y);
    const addToast = useStore(s => s.addToast);
    const drillTimeScale = useStore(s => s.drillTimeScale);
    const setDrillTimeScale = useStore(s => s.setDrillTimeScale);
    const keyShortcuts = useStore(s => s.keyShortcuts);
    const setKeyShortcuts = useStore(s => s.setKeyShortcuts);
    const hasKeyboard = usePhysicalKeyboard();
    const pointerVerb = usePointerVerb();
    const navigate = useNavigate();
    const system = useSystemPreferences();
    const canSpeak = speechAvailable();
    const voices = useVoiceLanguages(active && a11y.readAloud);

    // Stop a test sentence when the page is left: unmounted, or another
    // Settings tab chosen (the tabs stay mounted, hidden). `shown` is read
    // after the voices wait, so a tab left during it starts nothing.
    const shown = useRef(active);
    const testing = useRef(false);
    useEffect(() => {
        shown.current = active;
        const stopTest = () => { if (currentSpeaker() === 'settings-test') stopSpeaking(); };
        if (!active) stopTest();
        return () => { shown.current = false; stopTest(); };
    }, [active]);

    const followLabel = tr("System");
    const motionHint = a11y.motion === 'system'
        ? (system.reduce ? tr("Following your system, which asks for less motion.") : tr("Following your system, which allows motion."))
        : a11y.motion === 'reduce' ? tr("Animations and moving transitions are stopped.") : tr("Animations play even if your system asks for less motion.");
    const contrastHint = a11y.contrast === 'system'
        ? (system.more ? tr("Following your system, which asks for more contrast.") : tr("Following your system, which asks for standard contrast."))
        : a11y.contrast === 'more' ? tr("Darker text, stronger borders and lines.") : tr("The app's usual colours.");

    const spacingOptions = SPACING_LEVELS.map(level => ({
        value: level,
        label: level === 'normal' ? tr("Normal") : level === 'wider' ? tr("Wider") : tr("Widest"),
    }));

    const testVoice = async () => {
        if (testing.current) return;
        testing.current = true;
        try { await voicesReady(); } finally { testing.current = false; }
        if (!shown.current) return;
        const result = speak('settings-test', tr("This is how fast cards and lessons will be read."), i18n.language, a11y.speechRate);
        if (result === 'no-voice') {
            const name = (() => {
                try { return new Intl.DisplayNames([i18n.language], { type: 'language' }).of(i18n.language) ?? i18n.language; }
                catch { return i18n.language; }
            })();
            addToast('info', tr("This computer has no {{language}} voice installed. Add one in your system's speech settings, then reload the app.", { language: name }));
        }
    };

    return (
        <section className={active ? '' : 'hidden'}>
            {/* SEEING — what the page looks like. The theme stays in General
                with the colours; its "System" card follows the OS the way
                these two rows do. */}
            <SettingGroup title={tr("Seeing")}>
                <SettingRow
                    label={tr("Contrast")}
                    hint={contrastHint}
                    block
                    control={
                        <SegmentedControl<ContrastPref>
                            label={tr("Contrast")}
                            value={a11y.contrast}
                            onChange={v => void setA11y('contrast', v)}
                            options={CONTRAST_PREFS.map(v => ({
                                value: v,
                                label: v === 'system' ? followLabel : v === 'more' ? tr("Higher") : tr("Standard"),
                            }))}
                        />
                    }
                />
                <SettingRow
                    label={tr("Motion")}
                    hint={motionHint}
                    block
                    control={
                        <SegmentedControl<MotionPref>
                            label={tr("Motion")}
                            value={a11y.motion}
                            onChange={v => void setA11y('motion', v)}
                            options={MOTION_PREFS.map(v => ({
                                value: v,
                                label: v === 'system' ? followLabel : v === 'reduce' ? tr("Reduced") : tr("Full"),
                            }))}
                        />
                    }
                />
            </SettingGroup>

            {/* READING — spacing for every text in the app. "Widest" is the
                spacing WCAG 1.4.12 asks a page to survive, so nothing here
                may clip at it. Text size stays in General, one control; the
                first row is the way there, because this is where people look. */}
            <SettingGroup title={tr("Reading")}>
                <SettingRow
                    label={tr("Text size")}
                    hint={tr("Set in General, for the whole app.")}
                    control={
                        <Button
                            variant="neutral"
                            onClick={() => navigate('/settings#general/text-size')}
                            aria-label={tr("Open text size in General")}
                            icon={<ArrowRight className="w-4 h-4" aria-hidden="true" />}
                        >
                            {tr("Open")}
                        </Button>
                    }
                />
                <SettingRow
                    label={tr("Larger text and buttons")}
                    hint={tr("Small text grows to normal size, and every button gets bigger so it is easier to press.")}
                    control={<Switch checked={a11y.largerUi} onChange={on => void setA11y('largerUi', on)} label={tr("Larger text and buttons")} />}
                />
                {([
                    ['letterSpacing', tr("Letter spacing"), tr("Space between the letters of a word.")],
                    ['wordSpacing', tr("Word spacing"), tr("Space between words.")],
                    ['lineSpacing', tr("Line spacing"), tr("Space between lines and paragraphs.")],
                ] as const).map(([field, label, hint]) => (
                    <SettingRow
                        key={field}
                        label={label}
                        hint={hint}
                        block
                        control={
                            <SegmentedControl<SpacingLevel>
                                label={label}
                                value={a11y[field]}
                                onChange={v => void setA11y(field, v)}
                                options={spacingOptions}
                            />
                        }
                    />
                ))}
                <SettingRow
                    label={tr("Reading line")}
                    hint={tr("A band under the line you point at in lessons and notes, to keep your place.")}
                    control={<Switch checked={a11y.readingLine} onChange={on => void setA11y('readingLine', on)} label={tr("Reading line")} />}
                />
            </SettingGroup>

            {/* LISTENING — read aloud with the computer's own voices, and the
                card clips. No voice is fetched from anywhere. */}
            <SettingGroup title={tr("Listening")}>
                <SettingRow
                    label={tr("Read aloud")}
                    hint={canSpeak
                        ? tr("Adds a speaker button to cards, questions, lessons, notes and assistant replies. Uses this computer's voices.")
                        : tr("This browser cannot speak text.")}
                    control={<Switch checked={a11y.readAloud && canSpeak} onChange={on => void setA11y('readAloud', on)} label={tr("Read aloud")} disabled={!canSpeak} />}
                />
                {a11y.readAloud && canSpeak && (
                    <>
                        <SettingRow
                            label={tr("Reading speed")}
                            hint={voices === null ? undefined
                                : voices.length === 0 ? tr("No voices are installed on this computer. Add one in your system's speech settings.")
                                : tr("Voices on this computer: {{languages}}", { languages: listFormat(voices) })}
                            block
                            control={
                                <div className="flex flex-wrap items-center gap-3 w-full">
                                    <Slider
                                        min={MIN_SPEECH_RATE}
                                        max={MAX_SPEECH_RATE}
                                        step={SPEECH_RATE_STEP}
                                        value={a11y.speechRate}
                                        onChange={v => void setA11y('speechRate', v)}
                                        label={tr("Reading speed")}
                                        valueText={`${a11y.speechRate}%`}
                                        // The row's hint lists the installed
                                        // voices: true of the row, not a
                                        // description of a speed slider.
                                        aria-describedby={undefined}
                                        className="flex-1 min-w-[8rem]"
                                    />
                                    <Stepper
                                        value={a11y.speechRate}
                                        min={MIN_SPEECH_RATE}
                                        max={MAX_SPEECH_RATE}
                                        step={SPEECH_RATE_STEP}
                                        onChange={v => void setA11y('speechRate', v)}
                                        label={tr("Reading speed")}
                                        suffix="%"
                                    />
                                    <IconButton
                                        variant="neutral"
                                        onClick={() => void setA11y('speechRate', DEFAULT_A11Y.speechRate)}
                                        disabled={a11y.speechRate === DEFAULT_A11Y.speechRate}
                                        label={tr("Reset to {{DEFAULT_UI_SCALE}}%", { DEFAULT_UI_SCALE: DEFAULT_A11Y.speechRate })}
                                        icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}
                                    />
                                    <Button
                                        variant="neutral"
                                        onClick={() => void testVoice()}
                                        icon={<Play className="w-4 h-4" aria-hidden="true" />}
                                    >
                                        {tr("Try it")}
                                    </Button>
                                </div>
                            }
                        />
                    </>
                )}
                <SettingRow
                    label={tr("Play card recordings by themselves")}
                    hint={a11y.cardAudioAutoplay
                        ? tr("A recording that came with a card plays as soon as the card appears.")
                        : tr("A recording that came with a card waits for its play button.")}
                    control={<Switch checked={a11y.cardAudioAutoplay} onChange={on => void setA11y('cardAudioAutoplay', on)} label={tr("Play card recordings by themselves")} />}
                />
            </SettingGroup>

            {/* TIME AND ANSWERS — the clock, and how a press becomes a grade. */}
            <SettingGroup title={tr("Time and answers")}>
                <SettingRow
                    label={tr("Time limits")}
                    hint={drillTimeScale === 'off' ? tr("Timed drills run without a clock.") : tr("More time on every timed drill, or no clock at all.")}
                    block
                    control={
                        <SegmentedControl<DrillTimeScale>
                            label={tr("Time limits")}
                            value={drillTimeScale}
                            onChange={v => void setDrillTimeScale(v)}
                            options={DRILL_TIME_SCALES.map(s => ({
                                value: s,
                                label: s === '1' ? tr("Normal")
                                    : s === 'off' ? tr("No clock")
                                    : tr("×{{n}}", { n: Number(s) }),
                            }))}
                        />
                    }
                />
                <SettingRow
                    label={tr("Confirm before grading")}
                    hint={hasKeyboard
                        ? tr("The first press on an answer or a rating, or on its key, selects it. The second grades it.")
                        : tr("{{pointerVerb}} an answer or a rating once to choose it, and again to grade it.", { pointerVerb })}
                    control={<Switch checked={a11y.confirmAnswers} onChange={on => void setA11y('confirmAnswers', on)} label={tr("Confirm before grading")} />}
                />
            </SettingGroup>

            {/* KEYBOARD — only where there are keys to press. Input capability
                is not a width breakpoint: this is a whole section of unusable
                instructions on a phone. */}
            {hasKeyboard && (
                <SettingGroup title={tr("Keyboard shortcuts")}>
                    <SettingRow
                        label={tr("Single-key shortcuts")}
                        hint={tr("Turn off if you use speech input or press keys by accident. Shortcuts with {{key}} keep working.", { key: MOD_KEY })}
                        control={<Switch checked={keyShortcuts} onChange={on => void setKeyShortcuts(on)} label={tr("Single-key shortcuts")} />}
                    />
                    <div className="px-4 py-3">
                        {/* Keycaps follow the platform (⌘ on Apple, Ctrl elsewhere) — the
                            handlers always accepted both. */}
                        <ul aria-label={tr("Keyboard shortcuts")} className="space-y-2.5 text-sm text-slate-600 dark:text-slate-400">
                            {[
                                [tr("Open search"), `${MOD_KEY} + K`],
                                [tr("Open the assistant"), 'A'],
                                [tr("Cards: show the answer"), tr("Space")],
                                [tr("Cards: rate Again, Hard, Good or Easy"), '1 2 3 4'],
                                [tr("Cards: take back the last rating"), `Z  ·  ${MOD_KEY} + Z`],
                                [tr("Calendar: previous or next period"), `${CALENDAR_KEYCAPS.prev} ${CALENDAR_KEYCAPS.next}`],
                                [tr("Calendar: go to today"), CALENDAR_KEYCAPS.today],
                                [tr("Calendar: month, week or day view"), `${CALENDAR_KEYCAPS.month} ${CALENDAR_KEYCAPS.week} ${CALENDAR_KEYCAPS.day}`],
                                [tr("Save notes while editing"), `${MOD_KEY} + Enter`],
                                [tr("Close panels and modals"), 'Esc'],
                            ].map(([label, combo]) => (
                                <li key={label} className="flex items-center justify-between gap-3">
                                    <span>{label}</span>
                                    <kbd className="bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded text-xs whitespace-nowrap">{combo}</kbd>
                                </li>
                            ))}
                        </ul>
                    </div>
                </SettingGroup>
            )}
        </section>
    );
}
