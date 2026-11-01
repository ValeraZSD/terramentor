import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, CalendarDays, Loader2 } from 'lucide-react';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Button, IconButton } from '../ui/Button';
import { CalendarViewMode } from '../../types';
import { usePhysicalKeyboard } from '../../utils/platform';

interface Props {
    /** The calendar is narrower than a week of columns needs (a phone, a side panel). */
    narrow: boolean;
    viewMode: CalendarViewMode;
    onMode: (mode: CalendarViewMode) => void;
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
 * reviewing it all named the ~2300px between it and Today as what was still in
 * their way. So: the view, Today, back, forward, then the period they change.
 * The name comes LAST, so a name that changes width ("Nov 2 – 8, 2026" vs "Oct
 * 26 – Nov 1, 2026", or "November 2026") never moves a control out from under a
 * pointer pressing it again.
 *
 * The keys each control answers to (`calendarKeys.ts`) are named in its
 * tooltip, only on a device with a keyboard. The controls are the shared `ui/`
 * ones: on a tinted page the hand-rolled pills before them had no track and no
 * edge, so "Month · Week · Day" and "Today" read as loose words.
 */
export function CalendarNav({ narrow, viewMode, onMode, onPrev, onNext, onToday, title, subtitle, loading }: Props) {
    const { t: tr } = useTranslation();
    const hasKeyboard = usePhysicalKeyboard();
    const size = narrow ? 'sm' : 'md';

    const modes = (
        <SegmentedControl
            size={size}
            label={tr("Calendar view mode")}
            value={viewMode}
            onChange={onMode}
            options={[
                { value: 'month', label: tr("Month"), title: hasKeyboard ? tr("Month (m)") : undefined },
                { value: 'week', label: tr("Week"), title: hasKeyboard ? tr("Week (w)") : undefined },
                { value: 'day', label: tr("Day"), title: hasKeyboard ? tr("Day (d)") : undefined },
            ]}
        />
    );
    const today = (
        <Button size={size} variant="neutral" onClick={onToday} title={hasKeyboard ? tr("Today (t)") : undefined}>
            {tr("Today")}
        </Button>
    );
    const arrows = (
        <div className="flex items-center gap-1">
            <IconButton size={size} variant="neutral" onClick={onPrev}
                label={hasKeyboard ? tr("Previous period (←)") : tr("Previous period")}
                icon={<ChevronLeft className="w-5 h-5" />} />
            <IconButton size={size} variant="neutral" onClick={onNext}
                label={hasKeyboard ? tr("Next period (→)") : tr("Next period")}
                icon={<ChevronRight className="w-5 h-5" />} />
        </div>
    );
    const spinner = loading
        ? <Loader2 className="w-4 h-4 text-slate-400 animate-spin shrink-0 self-center" aria-label={tr("Loading")} />
        : null;

    // A phone or a side panel keeps the wrapping toolbar it had: the name on the
    // left, the controls on the right, wrapping under it when they do not fit.
    if (narrow) {
        return (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 shrink-0">
                <div className="flex items-baseline gap-2 min-w-0 mr-auto">
                    <h2 className="flex items-center gap-2 text-base sm:text-lg font-semibold text-slate-800 dark:text-white truncate">
                        <CalendarDays className="w-5 h-5 text-accent-fg shrink-0 self-center" aria-hidden="true" />
                        {title}
                    </h2>
                    {subtitle && <span className="text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">{subtitle}</span>}
                    {spinner}
                </div>
                <div className="flex items-center gap-2">
                    {modes}
                    {today}
                    {arrows}
                </div>
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
