import { useStore } from '../store';
import { TrendingUp, TrendingDown, AlertTriangle, CheckCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { uiLocale } from '../utils/locale';
import { paceHeadline } from '../utils/pace';

export default function PaceIndicator() {
    const { t } = useTranslation();
    const paceData = useStore(s => s.paceData);

    if (!paceData || !paceData.hasSchedule) return null;

    const { expectedProgress, actualProgress, paceStatus, startDate, deadline, drift, totalDays } = paceData;

    const statusDot: Record<string, string> = {
        ahead: 'bg-emerald-500',
        on_track: 'bg-blue-500',
        falling_behind: 'bg-amber-500',
        critical: 'bg-red-500',
        no_schedule: 'bg-slate-400',
        no_tasks: 'bg-slate-400',
    };

    const statusIcon: Record<string, typeof CheckCircle> = {
        ahead: TrendingUp,
        on_track: CheckCircle,
        falling_behind: TrendingDown,
        critical: AlertTriangle,
        no_schedule: CheckCircle,
        no_tasks: CheckCircle,
    };

    const barColor: Record<string, string> = {
        ahead: 'bg-emerald-500',
        on_track: 'bg-blue-500',
        falling_behind: 'bg-amber-500',
        critical: 'bg-red-500',
        no_schedule: 'bg-slate-400',
        no_tasks: 'bg-slate-400',
    };

    const statusText: Record<string, string> = {
        ahead: 'text-emerald-600 dark:text-emerald-400',
        on_track: 'text-blue-600 dark:text-blue-400',
        falling_behind: 'text-amber-600 dark:text-amber-400',
        critical: 'text-red-600 dark:text-red-400',
        no_schedule: 'text-slate-500 dark:text-slate-400',
        no_tasks: 'text-slate-500 dark:text-slate-400',
    };

    const Icon = statusIcon[paceStatus] || CheckCircle;
    const dot = statusDot[paceStatus] || statusDot.no_schedule;
    const bar = barColor[paceStatus] || barColor.no_schedule;
    const text = statusText[paceStatus] || statusText.no_schedule;

    // Signed pace offset in days: positive = ahead, negative = behind.
    // The server clamps `daysBehind` to >= 0 (dropping the "ahead" magnitude),
    // so derive the signed value from the raw drift instead. drift = expected -
    // actual, so ahead (actual > expected) → negative drift → positive offset.
    const offsetDays = (drift != null && totalDays)
        ? -Math.round((drift / 100) * totalDays)
        : 0;
    const offsetLabel = offsetDays > 0 ? `+${offsetDays}d` : `${offsetDays}d`;

    // The server's own `message` is English prose built with a template
    // literal; it stayed English between two translated lines here.
    const headline = paceHeadline(paceStatus, Math.abs(offsetDays), t);

    function formatDateShort(dateStr: string): string {
        const [y, m, d] = dateStr.split('-').map(Number);
        const d2 = new Date(Date.UTC(y, m - 1, d));
        return d2.toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }

    return (
        <>
            {/* Compact: phone & tablet (below xl). Signed days offset + two thin bars. */}
            <div
                className="flex xl:hidden items-center gap-2 px-2 py-1 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200/60 dark:border-slate-700/60"
                title={headline}
            >
                <span className={`text-xs font-semibold tabular-nums ${text}`}>{offsetLabel}</span>
                <div className="flex flex-col gap-0.5" aria-hidden="true">
                    <div className="w-12 h-2 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                        <div className="h-full bg-slate-400 dark:bg-slate-500 rounded-full transition-all duration-500" style={{ width: `${expectedProgress}%` }} />
                    </div>
                    <div className="w-12 h-2 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                        <div className={`h-full ${bar} rounded-full transition-all duration-500`} style={{ width: `${actualProgress}%` }} />
                    </div>
                </div>
            </div>

            {/* Full: desktop (xl+). */}
            <div className="hidden xl:flex items-center gap-3 px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200/60 dark:border-slate-700/60">
                <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`w-2 h-2 rounded-full ${dot}`} />
                    <Icon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap">{headline}</span>
                </div>
                <div className="w-px h-4 bg-slate-200 dark:bg-slate-600" />
                <div className="flex flex-col gap-1 shrink-0">
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs text-slate-500 dark:text-slate-400 w-7">{t("Exp")}</span>
                        <div className="w-16 h-1.5 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                            <div className="h-full bg-slate-400 dark:bg-slate-500 rounded-full transition-all duration-500" style={{ width: `${expectedProgress}%` }} />
                        </div>
                        <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400 w-9 text-right">{expectedProgress}%</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs text-slate-500 dark:text-slate-400 w-7">{t("Act")}</span>
                        <div className="w-16 h-1.5 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                            <div className={`h-full ${bar} rounded-full transition-all duration-500`} style={{ width: `${actualProgress}%` }} />
                        </div>
                        <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400 w-9 text-right">{actualProgress}%</span>
                    </div>
                </div>
                {startDate && deadline && (
                    <>
                        <div className="w-px h-4 bg-slate-200 dark:bg-slate-600" />
                        <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                            {formatDateShort(startDate)} → {formatDateShort(deadline)}
                        </span>
                    </>
                )}
            </div>
        </>
    );
}
