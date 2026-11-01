import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, CalendarDays, Loader2 } from 'lucide-react';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Button, IconButton } from '../ui/Button';
import { CalendarViewMode } from '../../types';
import { usePhysicalKeyboard } from '../../utils/platform';
import { CALENDAR_ARIA_KEYS, CALENDAR_KEYCAPS } from './calendarKeys';

/**
 * A wrapped date breaks between whole dates, never inside one: the space
 * between a number and the word beside it is made non-breaking ("1 нояб.",
 * "Nov 1", "2026 г."). On a 320px phone "26 окт. – 1 нояб. 2026 г." broke
 * as "26 окт. – 1" over "нояб. 2026 г.".
 */
export const keepDatePartsTogether = (label: string): string =>
    label.replace(/(\d\.?) (?=\p{L})/gu, '$1 ').replace(/(\p{L}\.?) (?=\d)/gu, '$1 ');

interface Props {
    /** The calendar is narrower than a week of columns needs (a phone, a side panel). */
    narrow: boolean;
    /** Narrower still (under 20rem: a phone at a large interface scale): the
     *  name, the switch, and Today with the arrows each get a full row. */
    compact?: boolean;
    viewMode: CalendarViewMode;
    onMode: (mode: CalendarViewMode) => void;
    /** Month / Week / Day was picked with a pointer: hand focus back to the calendar. */
    onPointerPick: () => void;
    onPrev: () => void;
    onNext: () => void;
    onToday: () => void;
    title: string;
    subtitle: string | null;
    loading: boolean;
}

/**
 * The calendar's navigation: which period is on screen, the arrows that move it,
 * Today, and Month / Week / Day.
 *
 * WHY EVERYTHING SITS IN ONE CLUSTER AT THE LEFT. On a 2560px screen the old
 * toolbar put the period's name at the far left and every control at the far
 * right, so each press meant crossing the screen to read where it had landed.
 * A first redesign kept Month / Week / Day at the right edge: three strangers
 * reviewing it all named the width of the screen between it and Today as what
 * was still in their way. So: the view, Today, back, forward, then the period
 * they change. The name comes LAST, so a name that changes width ("Nov 2 – 8,
 * 2026" vs "Oct 26 – Nov 1, 2026", or "November 2026") never moves a control
 * out from under a pointer pressing it again.
 *
 * The keys each control answers to (`calendarKeys.ts`) are in its tooltip,
 * only on a device with a keyboard, and in `aria-keyshortcuts` for a screen
 * reader, so the accessible NAME stays "Previous period" rather than reading
 * the arrow aloud. The controls are the shared `ui/` ones: on a tinted page the
 * hand-rolled pills before them had no track and no edge, so "Month · Week ·
 * Day" and "Today" read as loose words.
 */
export function CalendarNav({ narrow, compact = false, viewMode, onMode, onPointerPick, onPrev, onNext, onToday, title, subtitle, loading }: Props) {
    const { t: tr } = useTranslation();
    const hasKeyboard = usePhysicalKeyboard();
    const size = narrow ? 'sm' : 'md';
    const name = keepDatePartsTogether(title);
    /** "Month (M)": the key beside the name, where there are keys to press. */
    const hint = (label: string, action: keyof typeof CALENDAR_KEYCAPS) =>
        hasKeyboard ? tr("{{label}} ({{key}})", { label, key: CALENDAR_KEYCAPS[action] }) : undefined;
    /** The same key for a screen reader, on the same devices: a phone's reader
     *  would otherwise announce "ArrowLeft" for a control with no key to press. */
    const ariaKeys = (action: keyof typeof CALENDAR_ARIA_KEYS) =>
        hasKeyboard ? CALENDAR_ARIA_KEYS[action] : undefined;

    // A radio clicked with a mouse keeps focus, and on a radiogroup ←/→ walk
    // the radios: the next → meant for "Next period" switched the view instead.
    // A pointer pick (click `detail` > 0) hands focus back to the calendar; a
    // keyboard pick (Space, the arrows) leaves it where the keyboard user is.
    const modes = (
        <div className={!narrow ? 'contents' : compact ? 'min-w-0 col-span-2' : 'min-w-0'} onClick={e => { if (e.detail > 0) onPointerPick(); }}>
            <SegmentedControl
                size={size}
                block={narrow}
                // The bar sits on the page's own grey, the same step as the
                // track's: in the light theme the track vanished and Month / Day
                // read as loose words. A hairline edge, light theme only (the
                // dark track already stands off its page).
                className="shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)] dark:shadow-none"
                label={tr("Calendar view mode")}
                value={viewMode}
                onChange={onMode}
                options={(['month', 'week', 'day'] as const).map(mode => {
                    const label = mode === 'month' ? tr("Month") : mode === 'week' ? tr("Week") : tr("Day");
                    return { value: mode, label, title: hint(label, mode), keyshortcuts: ariaKeys(mode) };
                })}
            />
        </div>
    );
    const today = (
        <Button size={size} variant="neutral" onClick={onToday} block={narrow}
            title={hint(tr("Today"), 'today')} aria-keyshortcuts={ariaKeys('today')}>
            {tr("Today")}
        </Button>
    );
    const arrows = (
        <div className={narrow ? 'flex w-full gap-1' : 'flex items-center gap-1'}>
            <IconButton size={size} variant="neutral" onClick={onPrev} className={narrow ? 'flex-1' : undefined}
                label={tr("Previous period")} title={hint(tr("Previous period"), 'prev') ?? tr("Previous period")}
                aria-keyshortcuts={ariaKeys('prev')}
                icon={<ChevronLeft className="w-5 h-5" />} />
            <IconButton size={size} variant="neutral" onClick={onNext} className={narrow ? 'flex-1' : undefined}
                label={tr("Next period")} title={hint(tr("Next period"), 'next') ?? tr("Next period")}
                aria-keyshortcuts={ariaKeys('next')}
                icon={<ChevronRight className="w-5 h-5" />} />
        </div>
    );
    const spinner = loading
        ? <Loader2 className="w-4 h-4 text-slate-400 animate-spin shrink-0 self-center" aria-label={tr("Loading")} />
        : null;

    // A phone or a side panel: two full-width rows, in every language. The name
    // with Today at its right edge (Today is about the date the name shows), then
    // Month / Week / Day stretched over the width with the arrows flush right.
    // One row of all five left a strip of nothing at the right in English, and in
    // Russian ("Месяц Неделя День", "Сегодня") wrapped to a third row at 390px.
    //
    // A grid, so Today and the arrows share ONE column: Today fills it and the
    // two arrows split it, so Today's edges line up with the arrows' outer edges
    // whichever is wider in this language ("Сегодня" in a side panel is).
    //
    // Compact (under 20rem, `isCompactCalendar`): three full-width rows, in
    // reading order — the name, the switch, then Today filling the first column
    // with the arrows in the second. Two rows there broke the switch into chips.
    if (narrow) {
        return (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 px-3 py-2.5 border-b border-slate-200 dark:border-slate-700 shrink-0">
                {/* The icon sits OUTSIDE the baseline group: inside the heading
                    it was the first flex item, an SVG has no text baseline, so
                    the heading's baseline became the icon's bottom edge and the
                    year sat a few pixels below the date beside it. */}
                <div className={compact ? 'flex items-center gap-2 min-w-0 col-span-2' : 'flex items-center gap-2 min-w-0'}>
                    <CalendarDays className="w-5 h-5 text-accent-fg shrink-0" aria-hidden="true" />
                    {/* On the name's baseline when both fit; when they do not (a
                        Russian week: "26 окт. – 1 нояб. 2026 г." and "44-я неделя"
                        beside a Today as wide as the arrows) the small label drops
                        under the name instead of both being cut off. Two lines,
                        24 + 16px, still fit inside Today's 44px. Where even the
                        name alone does not fit (a 320px phone, 160% text) it
                        wraps too: the date is what the bar is for, never "…". */}
                    <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                        <h2 className="min-w-0 max-w-full break-words text-balance text-base font-semibold text-slate-800 dark:text-white">{name}</h2>
                        {subtitle && <span className="max-w-full truncate text-xs text-slate-600 dark:text-slate-300">{subtitle}</span>}
                    </div>
                    {spinner}
                </div>
                {compact ? <>{modes}{today}{arrows}</> : <>{today}{modes}{arrows}</>}
            </div>
        );
    }

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 shrink-0">
            {modes}
            {today}
            {arrows}
            <div className="flex items-baseline gap-2 min-w-0">
                <h2 className="text-lg font-semibold text-slate-800 dark:text-white whitespace-nowrap tabular-nums">{title}</h2>
                {subtitle && <span className="text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">{subtitle}</span>}
                {spinner}
            </div>
        </div>
    );
}
