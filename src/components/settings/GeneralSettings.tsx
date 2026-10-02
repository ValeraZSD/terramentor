import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MOD_KEY, usePhysicalKeyboard } from '../../utils/platform';
import { useStore, MIN_UI_SCALE, MAX_UI_SCALE, DEFAULT_UI_SCALE, UI_SCALE_STEP } from '../../store';
import { RotateCcw } from 'lucide-react';
import { IconButton } from '../ui/Button';
import { Select } from '../ui/Field';
import SegmentedControl from '../ui/SegmentedControl';
import Stepper from '../ui/Stepper';
import Slider from '../ui/Slider';
import { SettingGroup, SettingRow, GROUP_CAPTION } from '../ui/SettingRow';
import { Explain } from '../ui/Disclosure';
import { ThemeCards, LanguageRow } from './AppearanceControls';
import AppIconPanel from './AppIconPanel';
import { ThemeTintField, AccentField } from './ColourFields';
import ThisComputerSection from './ThisComputerSection';
import AboutSection from './AboutSection';
import { NUMBER_STYLES, AUTO as NUMBER_AUTO, formatNumber } from '../../utils/numberFormat';

// Theme picker data lives beside ThemeCards in AppearanceControls.tsx, shared
// with the welcome screen.

/** Settings → General: appearance, language and region, this computer, about,
 *  and the keyboard shortcuts. */
export default function GeneralSettings({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    // Theme, tint, accent and UI language are their own components (ThemeCards,
    // ThemeTintField, AccentField, LanguageRow), which read the store themselves.
    const uiScale = useStore(s => s.uiScale);
    const setUiScale = useStore(s => s.setUiScale);
    const weekStartDay = useStore(s => s.weekStartDay);
    const setWeekStartDay = useStore(s => s.setWeekStartDay);
    const numberFormat = useStore(s => s.numberFormat);
    const setNumberFormat = useStore(s => s.setNumberFormat);
    // Quit has been pressed and the window is on its way out: the screen waits
    // for the server to be gone before it says so, and hands the app back if it
    // is still serving.
    const [quitting, setQuitting] = useState(false);
    const addToast = useStore(s => s.addToast);
    // The quit screen's way back: it is still serving, so there is an app to
    // hand back to. Declared here rather than beside `quitting` because it
    // needs the toast, and stable because the screen watches it.
    const quitFailed = useCallback(() => {
        setQuitting(false);
        addToast('error', tr("Could not stop the app"));
    }, [addToast, tr]);
    const hasKeyboard = usePhysicalKeyboard();

    return (
        <>
            {/* APPEARANCE — four settings, four rows, no paragraphs.
                What each control does is visible the moment it is
                used: the theme repaints the page, the accent
                repaints this card, the size resizes the words you
                are reading. A sentence explaining any of that is a
                sentence describing what the reader can already see.
                The app icon is the exception, because it is the one
                appearance choice whose effect is somewhere else —
                so it keeps its line, and its caveats sit closed
                inside its own disclosure (AppIconPanel). */}
            <section className={active ? '' : 'hidden'}>
                <SettingGroup title={tr("Appearance")}>
                    <SettingRow label={tr("Theme")} block control={<ThemeCards />} />
                    {/* …and what colour it is. The card above
                        answers light or dark; this answers the
                        other half, which a fixed set of themes can
                        only ever answer for you. */}
                    <SettingRow
                        label={tr("Page colour")}
                        hint={tr("Tints every surface. Both themes above show it.")}
                        block
                        control={<ThemeTintField />}
                    />
                    <SettingRow
                        label={tr("Accent colour")}
                        hint={tr("Projects keep their own colour.")}
                        block
                        control={<AccentField />}
                    />
                    {/* THE APP'S OWN ICON — the tab, and what an install
                        puts on a home screen. It sits with the theme and
                        the accent because it is the same question, and it
                        is a disclosure because it is three controls and a
                        caveat for a picture most readers never change. */}
                    <AppIconPanel />
                    {/* UI SCALE. Not a font-size preference — it moves the
                        root font size, and this app's sizes are `rem`, so
                        the interface grows as a piece instead of becoming
                        large text in boxes built for small text. Three
                        controls over one number on one 40px line: drag it,
                        nudge it, or put it back. The stepper steps by 5
                        because the SLIDER does — at ±10 a value reached
                        with one could not be nudged back to itself with
                        the other. Reset is disabled at 100%, not hidden: a
                        control that appears and disappears moves
                        everything beside it. */}
                    <SettingRow
                        label={tr("Text & interface size")}
                        block
                        control={
                            // The slider is the one control here whose width IS its
                            // precision, so it takes the row and the stepper and reset
                            // keep their own size beside it.
                            <div className="flex flex-wrap items-center gap-3 w-full">
                                <Slider
                                    min={MIN_UI_SCALE}
                                    max={MAX_UI_SCALE}
                                    step={UI_SCALE_STEP}
                                    value={uiScale}
                                    onChange={v => void setUiScale(v)}
                                    label={tr("Interface size")}
                                    valueText={`${uiScale}%`}
                                    className="flex-1 min-w-[8rem]"
                                />
                                <Stepper
                                    value={uiScale}
                                    min={MIN_UI_SCALE}
                                    max={MAX_UI_SCALE}
                                    step={UI_SCALE_STEP}
                                    onChange={v => void setUiScale(v)}
                                    label={tr("Interface size")}
                                    suffix="%"
                                />
                                <IconButton
                                    variant="neutral"
                                    onClick={() => void setUiScale(DEFAULT_UI_SCALE)}
                                    disabled={uiScale === DEFAULT_UI_SCALE}
                                    label={tr("Reset to {{DEFAULT_UI_SCALE}}%", { DEFAULT_UI_SCALE })}
                                    icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}
                                />
                            </div>
                        }
                    />
                </SettingGroup>
            </section>

            {/* LANGUAGE & REGION — the interface language, how numbers
                are written, and which day a week starts on. These were
                two sections ("Language" and a "Calendar" section holding
                one control), which is a heading and a card spent on a
                single two-way choice. They are one group for the same
                reason every desktop OS groups them: they are all "how
                this app should read where I live".

                The language here is the CHROME, never the content — a
                Dutch course stays Dutch under an English interface and
                the reverse. 'auto' follows the browser's language list,
                and the choice is applied before the round trip, like the
                theme. */}
            <section className={active ? '' : 'hidden'}>
                <SettingGroup title={tr("Language & region")}>
                    <SettingRow
                        label={tr("Interface language")}
                        hint={tr("Lessons and questions follow each project's own language.")}
                        htmlFor="ui-language"
                        control={<LanguageRow id="ui-language" />}
                        more={
                            <Explain summary={tr("About the translations")}>
                                {/* What is TRUE here is that English is the
                                    source the other eleven were made from.
                                    It said "the only language written by a
                                    person", which claims an authorship the
                                    English text does not have either. */}
                                {tr("English is the app’s original language. The rest were translated from it by machine and then corrected by hand where mistakes were found, so a sentence here and there may read oddly. If you spot one, corrections are welcome: each language is a single file in the app’s source.")}
                            </Explain>
                        }
                    />
                    {/* The options carry NO labels, in any language: the
                        example IS the option. "1.234,5" says what it does to
                        anyone who reads a number, where "point group, comma
                        decimal" has to be decoded — and it needs no
                        translating, so the twelve locale files do not grow a
                        row of near-identical sentences. */}
                    <SettingRow
                        label={tr("Numbers")}
                        hint={tr("A comma and a point are always both accepted when you type.")}
                        htmlFor="number-format"
                        control={
                            <Select
                                id="number-format"
                                fit
                                value={numberFormat}
                                onChange={e => void setNumberFormat(e.target.value)}
                                className="tabular-nums"
                            >
                                <option value={NUMBER_AUTO}>{tr("Same as the language")} ({formatNumber(1234.5, NUMBER_AUTO)})</option>
                                {NUMBER_STYLES.map(style => (
                                    <option key={style.id} value={style.id}>{style.id}</option>
                                ))}
                            </Select>
                        }
                    />
                    {/* Was a Mon-Sun / Sun-Sat toggle living in the
                        calendar's own toolbar as component state: it reset
                        to Monday on every navigation, the global calendar
                        ignored it, and on a phone it spent 100px of a
                        toolbar that also carries the month, the view mode
                        and the arrows. Nobody sets it twice. */}
                    <SettingRow
                        label={tr("Week starts on")}
                        control={
                            <SegmentedControl
                                label={tr("Week starts on")}
                                value={weekStartDay}
                                onChange={d => void setWeekStartDay(d as 0 | 1)}
                                options={[
                                    { value: 1, label: tr("Monday") },
                                    { value: 0, label: tr("Sunday") },
                                ]}
                            />
                        }
                    />
                </SettingGroup>
            </section>

            <ThisComputerSection active={active} onQuit={() => setQuitting(true)} />

            <AboutSection active={active} quitting={quitting} onStillRunning={quitFailed} />

            {/* KEYBOARD SHORTCUTS — only where there are keys to press.
                Input capability is not a width breakpoint: this is a
                whole section of unusable instructions on a phone. */}
            {hasKeyboard && (
            <section className={active ? 'mb-8' : 'hidden'}>
                <h2 className={GROUP_CAPTION}>{tr("Keyboard shortcuts")}</h2>
                <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
                    {/* Keycaps follow the platform (⌘ on Apple, Ctrl elsewhere) — the
                        handlers always accepted both. Listed in full: the capture and
                        assistant keys existed but were documented nowhere. */}
                    <ul className="space-y-2.5 text-sm text-slate-600 dark:text-slate-400">
                        {[
                            [tr("Open search"), `${MOD_KEY} + K`],
                            [tr("Capture something to study later"), 'C'],
                            [tr("Open the assistant"), 'A'],
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
            </section>
            )}
        </>
    );
}
