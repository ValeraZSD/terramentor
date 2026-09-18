import { useState, useMemo, useEffect } from 'react';
import { useStore } from '../store';
import { todayStr, addDays, parseDate, getLeafNodes } from '../utils/tree';
import { Calendar, Target, Zap, AlertTriangle, CheckCircle, X, RefreshCw, Trash2, TrendingUp, TrendingDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';
import { uiLocale, isoDayLabel } from '../utils/locale';
import { paceHeadline as buildPaceHeadline } from '../utils/pace';

interface SchedulePreset {
    id: string;
    label: string;
    emojiStr: string;
    studyDays: number[];
    /** What a preset IS: how many topics a study day should carry. It picks the
     *  deadline that lands that pace; the scheduler reads days, never hours. */
    targetTopicsPerDay: number;
    color: string;
    bgColor: string;
    borderColor: string;
    description: string;
}

const PRESETS: SchedulePreset[] = [
    {
        id: 'casual',
        label: k("Casual"),
        emojiStr: '🌿',
        // Three days a week, not five. A preset is a study WEEK plus a target
        // pace, and against a deadline the learner has already fixed the week is
        // the only half that can still change anything — so two presets sharing
        // Mon-Fri showed the same "~0.5/day" twice and made the choice look inert.
        studyDays: [1, 3, 5],
        targetTopicsPerDay: 1.0,
        color: 'text-emerald-700 dark:text-emerald-300',
        bgColor: 'bg-emerald-50 dark:bg-emerald-900/20',
        borderColor: 'border-emerald-200 dark:border-emerald-800',
        description: k("1 topic/day · Mon/Wed/Fri"),
    },
    {
        id: 'standard',
        label: k("Standard"),
        emojiStr: '📘',
        studyDays: [1, 2, 3, 4, 5],
        targetTopicsPerDay: 2.0,
        color: 'text-blue-700 dark:text-blue-300',
        bgColor: 'bg-blue-50 dark:bg-blue-900/20',
        borderColor: 'border-blue-200 dark:border-blue-800',
        description: k("2 topics/day · Weekdays"),
    },
    {
        id: 'intensive',
        label: k("Intensive"),
        emojiStr: '🔥',
        studyDays: [1, 2, 3, 4, 5, 6],
        targetTopicsPerDay: 3.0,
        color: 'text-red-700 dark:text-red-300',
        bgColor: 'bg-red-50 dark:bg-red-900/20',
        borderColor: 'border-red-200 dark:border-red-800',
        description: k("3 topics/day · Mon-Sat"),
    },
];

function computePresetDeadline(
    startDate: string,
    leafCount: number,
    studyDaysPerWeek: number,
    targetTopicsPerDay: number
): string {
    if (leafCount === 0 || studyDaysPerWeek === 0) return '';
    const totalStudyDays = Math.ceil(leafCount / targetTopicsPerDay);
    const calendarDays = Math.ceil(totalStudyDays * (7 / studyDaysPerWeek));
    return addDays(startDate, Math.max(calendarDays, 7));
}

/**
 * How hard a pace is, in the only unit this app measures: topics per study day.
 * The thresholds are `allocateSchedule`'s own warning bands, so the dialog and
 * the server can never disagree about whether a plan is intense.
 */
function paceLevel(topicsPerDay: number): { level: 'intense' | 'moderate' | 'comfortable'; label: string } {
    if (topicsPerDay > 3) return { level: 'intense', label: k("Intense pace") };
    if (topicsPerDay > 2) return { level: 'moderate', label: k("Moderate pace") };
    return { level: 'comfortable', label: k("Comfortable pace") };
}

export default function ScheduleModal() {
    const { t } = useTranslation();
    const showScheduleModal = useStore(s => s.showScheduleModal);
    const scheduleModalProjectId = useStore(s => s.scheduleModalProjectId);
    const setShowScheduleModal = useStore(s => s.setShowScheduleModal);
    const scheduleProject = useStore(s => s.scheduleProject);
    const projects = useStore(s => s.projects);
    const tree = useStore(s => s.tree);
    const paceData = useStore(s => s.paceData);
    const currentProjectId = useStore(s => s.currentProjectId);
    const recalibrateSchedule = useStore(s => s.recalibrateSchedule);
    const removeSchedule = useStore(s => s.removeSchedule);
    const showConfirm = useStore(s => s.showConfirm);

    const project = projects.find(p => p.id === scheduleModalProjectId);

    const [startDate, setStartDate] = useState(todayStr());
    const [deadline, setDeadline] = useState('');
    const [studyDays, setStudyDays] = useState<number[]>([1, 2, 3, 4, 5]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [activePreset, setActivePreset] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState<null | 'recalibrate' | 'remove'>(null);

    // Initialise the form only when the modal opens (keyed on the project id, NOT
    // the project object). Depending on `project` re-ran this whenever the projects
    // array was refetched (e.g. NodeTree's 3s poll), silently resetting the user's
    // in-progress Start Date / Deadline edits.
    useEffect(() => {
        if (!showScheduleModal) return;
        const p = projects.find(pr => pr.id === scheduleModalProjectId);
        if (!p) return;
        if (p.start_date) setStartDate(p.start_date);
        if (p.deadline) setDeadline(p.deadline);
        if (p.study_days) {
            try {
                const parsed = JSON.parse(p.study_days);
                if (Array.isArray(parsed) && parsed.length > 0) setStudyDays(parsed);
            } catch { }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showScheduleModal, scheduleModalProjectId]);

    const leafCount = useMemo(() => getLeafNodes(tree).length, [tree]);

    /**
     * This box used to classify on "utilization" - the share of your study time
     * the work demands - which needs hours per topic, and the code invented that
     * as a flat 1.5h. So the headline ("~62 hours of study", "Over capacity") was
     * arithmetic on a number nothing had measured, presented as a finding.
     * Topics/day says less and is true.
     */
    const paceIndicator = useMemo(() => {
        if (!deadline || !startDate || leafCount === 0) return null;
        const start = parseDate(startDate);
        const end = parseDate(deadline);
        const totalDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        if (totalDays <= 0) return null;
        const validDays = Math.max(1, Math.round(totalDays * (studyDays.length / 7)));

        const topicsPerDay = leafCount / validDays;
        const { level, label } = paceLevel(topicsPerDay);

        const color = level === 'intense' ? 'text-red-500' : level === 'moderate' ? 'text-amber-500' : 'text-emerald-500';
        const bg = level === 'intense' ? 'bg-red-50 dark:bg-red-900/20' : level === 'moderate' ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-emerald-50 dark:bg-emerald-900/20';
        const emoji = level === 'intense' ? '🔴' : level === 'moderate' ? '🟡' : '🟢';

        return {
            level, color, bg, label, emoji,
            topicsPerDay: Math.round(topicsPerDay * 10) / 10,
            studyDayCount: validDays,
            totalDays,
        };
    }, [startDate, deadline, studyDays, leafCount]);

    const presetDeadlines = useMemo(() => {
        const result: Record<string, string> = {};
        for (const preset of PRESETS) {
            result[preset.id] = computePresetDeadline(startDate, leafCount, preset.studyDays.length, preset.targetTopicsPerDay);
        }
        return result;
    }, [startDate, leafCount]);

    // When a deadline is already fixed (e.g. an exam date), a preset can only
    // change the study DAYS - it must not silently push the exam out. So each
    // preset then reports the pace its week would actually produce against that
    // deadline, which is the number the learner is choosing between.
    const presetPace = useMemo(() => {
        const result: Record<string, { label: string; tone: string } | null> = {};
        const start = deadline ? parseDate(startDate) : null;
        const end = deadline ? parseDate(deadline) : null;
        const totalDays = start && end ? Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) : 0;
        for (const p of PRESETS) {
            if (!deadline || leafCount === 0 || totalDays <= 0) { result[p.id] = null; continue; }
            const validDays = Math.max(1, Math.round(totalDays * (p.studyDays.length / 7)));
            const perDay = leafCount / validDays;
            const { level } = paceLevel(perDay);
            result[p.id] = {
                label: t("~{{perDay}}/day", { perDay: Math.round(perDay * 10) / 10 }),
                tone: level === 'intense' ? 'text-red-500' : level === 'moderate' ? 'text-amber-500' : 'text-emerald-500',
            };
        }
        return result;
        // `t` is listed because the label is a translated string: without it the
        // pace stayed in whatever language was set when the dialog first opened.
    }, [startDate, deadline, leafCount, t]);

    useEffect(() => {
        // A preset is its study days AND the deadline they were chosen to hit.
        // Matching on the days alone cannot work now that hours are gone: Casual
        // and Standard are both Mon-Fri and differ only in the pace, i.e. in the
        // deadline. A hand-picked deadline simply matches no preset, which is the
        // truth rather than a highlight on whichever one sorted first.
        const daysMatch = (p: SchedulePreset) =>
            JSON.stringify([...p.studyDays].sort()) === JSON.stringify([...studyDays].sort());
        const matching = PRESETS.find(p => daysMatch(p) && deadline === presetDeadlines[p.id]);
        setActivePreset(matching?.id ?? null);
    }, [studyDays, deadline, presetDeadlines]);

    // Close on Escape, matching the X button / backdrop click.
    useEffect(() => {
        if (!showScheduleModal) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setShowScheduleModal(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [showScheduleModal, setShowScheduleModal]);

    // Seven labels from one source, so the row cannot be half English again.
    const DAY_LABELS = [1, 2, 3, 4, 5, 6, 7].map(iso => ({ iso, label: isoDayLabel(iso) }));

    function toggleStudyDay(iso: number) {
        setStudyDays(prev => prev.includes(iso) ? prev.filter(d => d !== iso) : [...prev, iso].sort());
    }

    function applyPreset(preset: SchedulePreset) {
        setStudyDays([...preset.studyDays]);
        // Only propose a deadline when none is set. If one already exists (e.g.
        // an exam date) keep it - the preset then only sets the study week, and
        // the chip under it says what pace that produces.
        if (!deadline) setDeadline(presetDeadlines[preset.id]);
        setError('');
    }

    function formatDeadlineShort(dateStr: string): string {
        if (!dateStr) return '';
        // parseDate yields a UTC-midnight Date; format in UTC so the label can't
        // drift to the previous day in negative-offset timezones.
        return parseDate(dateStr).toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }

    async function handleSubmit() {
        if (!scheduleModalProjectId) return;
        if (!startDate || !deadline) { setError('Please set both start date and deadline.'); return; }
        if (studyDays.length === 0) { setError('Please select at least one study day.'); return; }
        setSubmitting(true);
        setError('');
        const success = await scheduleProject(scheduleModalProjectId, { startDate, deadline, studyDays });
        setSubmitting(false);
        if (success) setShowScheduleModal(false);
    }

    async function handleRecalibrate() {
        if (!scheduleModalProjectId) return;
        setActionLoading('recalibrate');
        await recalibrateSchedule(scheduleModalProjectId);
        setActionLoading(null);
        setShowScheduleModal(false);
    }

    async function handleRemove() {
        if (!scheduleModalProjectId) return;
        const confirmed = await showConfirm({
            title: t("Remove Schedule"),
            message: t("Remove the schedule from this project? This clears all date assignments. Your progress is not affected."),
            confirmLabel: t("Remove Schedule"),
            variant: 'warning',
        });
        if (!confirmed) return;
        setActionLoading('remove');
        await removeSchedule(scheduleModalProjectId);
        setActionLoading(null);
        setShowScheduleModal(false);
    }

    if (!showScheduleModal) return null;

    const isEditing = !!(project?.start_date && project?.deadline);
    const busy = submitting || actionLoading !== null;

    // Live pace for THIS project (paceData tracks the current workspace project).
    const pace = (isEditing && paceData?.hasSchedule && scheduleModalProjectId === currentProjectId)
        ? paceData
        : null;
    const paceOffsetDays = (pace && pace.drift != null && pace.totalDays)
        ? -Math.round((pace.drift / 100) * pace.totalDays)
        : 0;
    const paceStatusText: Record<string, string> = {
        ahead: 'text-emerald-600 dark:text-emerald-400',
        on_track: 'text-blue-600 dark:text-blue-400',
        falling_behind: 'text-amber-600 dark:text-amber-400',
        critical: 'text-red-600 dark:text-red-400',
        no_schedule: 'text-slate-500 dark:text-slate-400',
        no_tasks: 'text-slate-500 dark:text-slate-400',
    };
    const paceBarFill: Record<string, string> = {
        ahead: 'bg-emerald-500',
        on_track: 'bg-blue-500',
        falling_behind: 'bg-amber-500',
        critical: 'bg-red-500',
        no_schedule: 'bg-slate-400',
        no_tasks: 'bg-slate-400',
    };
    const paceNeedsRecalibrate = pace?.paceStatus === 'falling_behind' || pace?.paceStatus === 'critical';

    // Single, non-redundant pace headline. The raw server `message` (used on the
    // dashboard) repeats the day count already shown as the offset badge and
    // tacks on "consider recalibrating" — which duplicates the Recalibrate
    // button beside it. Here we derive one clean phrase from the same offset.
    const paceOffsetAbs = Math.abs(paceOffsetDays);
    const isBehind = pace?.paceStatus === 'falling_behind' || pace?.paceStatus === 'critical';
    // One translated sentence for every surface that says how far off the plan
    // a project is: this copy built its own English with an appended "s".
    const headline = !pace ? '' : buildPaceHeadline(pace.paceStatus, paceOffsetAbs, t, { terse: true });
    const PaceTrendIcon = !pace
        ? null
        : pace.paceStatus === 'ahead'
            ? TrendingUp
            : pace.paceStatus === 'on_track'
                ? CheckCircle
                : TrendingDown;
    // Gap between where the plan expects you and where you are (points of progress).
    const paceGap = pace ? pace.expectedProgress - pace.actualProgress : 0;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={(e) => { if (e.target === e.currentTarget) setShowScheduleModal(false); }}
        >
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden max-h-[90vh] overflow-y-auto">
                <div className="px-6 pt-6 pb-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-accent/20 flex items-center justify-center">
                                <Calendar className="w-5 h-5 text-accent-fg" />
                            </div>
                            <div>
                                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                                    {isEditing ? t("Edit Schedule") : t("Set the schedule")}
                                </h2>
                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                    {project?.name || t("Set your study timeline")}
                                </p>
                            </div>
                        </div>
                        <button onClick={() => setShowScheduleModal(false)} aria-label={t("Close")} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    {leafCount > 0 && (
                        <div className="mt-4 p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                            <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                                <Target className="w-4 h-4" />
                                <span><strong>{leafCount}</strong> {t("topics to schedule")}</span>
                            </div>
                        </div>
                    )}
                </div>

                <div className="px-6 pb-4 space-y-5">
                    {pace && (
                        <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-700/40">
                            <div className="flex items-center justify-between gap-2 mb-2.5">
                                <div className="flex items-center gap-1.5 min-w-0">
                                    {PaceTrendIcon && (
                                        <PaceTrendIcon className={`w-4 h-4 shrink-0 ${paceStatusText[pace.paceStatus] || paceStatusText.no_schedule}`} />
                                    )}
                                    <span className={`text-sm font-semibold truncate ${paceStatusText[pace.paceStatus] || paceStatusText.no_schedule}`}>
                                        {headline}
                                    </span>
                                </div>
                                {paceNeedsRecalibrate && (
                                    <button
                                        onClick={handleRecalibrate}
                                        disabled={busy}
                                        className="flex items-center gap-1.5 shrink-0 px-2.5 py-1 text-xs font-medium rounded-lg text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 ring-1 ring-inset ring-amber-200 dark:ring-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50 transition-colors"
                                        title={t("Reschedule remaining topics from today")}
                                    >
                                        <RefreshCw className={`w-3.5 h-3.5 ${actionLoading === 'recalibrate' ? 'animate-spin' : ''}`} />
                                        {t("Recalibrate")}
                                    </button>
                                )}
                            </div>
                            <div className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                    <span className="text-[11px] text-slate-500 dark:text-slate-400 w-16 shrink-0">{t("Expected")}</span>
                                    <div className="flex-1 h-2 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                                        <div className="h-full bg-slate-400 dark:bg-slate-500 rounded-full transition-all duration-500" style={{ width: `${pace.expectedProgress}%` }} />
                                    </div>
                                    <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400 w-9 text-right">{pace.expectedProgress}%</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-[11px] text-slate-500 dark:text-slate-400 w-16 shrink-0">{t("Completed")}</span>
                                    <div className="flex-1 h-2 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                                        <div className={`h-full ${paceBarFill[pace.paceStatus] || paceBarFill.no_schedule} rounded-full transition-all duration-500`} style={{ width: `${pace.actualProgress}%` }} />
                                    </div>
                                    <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400 w-9 text-right">{pace.actualProgress}%</span>
                                </div>
                                {isBehind && paceGap > 0 && (
                                    <p className="text-[11px] text-slate-500 dark:text-slate-400 pl-[4.5rem]">
                                        {t("{{paceGap}}% gap to close", { paceGap })}
                                    </p>
                                )}
                            </div>
                        </div>
                    )}
                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                            {t("Quick Setup")}
                        </label>
                        <div className="grid grid-cols-3 gap-2">
                            {PRESETS.map(preset => {
                                const isActive = activePreset === preset.id;
                                const dl = presetDeadlines[preset.id];
                                const fit = presetPace[preset.id];
                                return (
                                    <button
                                        key={preset.id}
                                        onClick={() => applyPreset(preset)}
                                        className={`relative p-3 rounded-xl border-2 text-left transition-all ${isActive
                                                ? `${preset.borderColor} ${preset.bgColor} ring-2 ring-offset-1 ring-current`
                                                : 'border-slate-200 dark:border-slate-600 hover:border-slate-300 dark:hover:border-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                                            }`}
                                    >
                                        {isActive && (
                                            <div className={`absolute top-1.5 right-1.5 w-4 h-4 rounded-full ${preset.id === 'casual' ? 'bg-emerald-500' : preset.id === 'standard' ? 'bg-blue-500' : 'bg-red-500'
                                                } flex items-center justify-center`}>
                                                <CheckCircle className="w-3 h-3 text-white" />
                                            </div>
                                        )}
                                        <div className="text-lg mb-1">{preset.emojiStr}</div>
                                        <p className={`text-sm font-semibold ${isActive ? preset.color : 'text-slate-800 dark:text-slate-100'}`}>
                                            {t(preset.label)}
                                        </p>
                                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-tight">
                                            {t(preset.description)}
                                        </p>
                                        {leafCount > 0 && (
                                            fit ? (
                                                <p className={`text-[11px] font-medium mt-1.5 ${fit.tone}`}>
                                                    {fit.label}
                                                </p>
                                            ) : dl ? (
                                                <p className={`text-[11px] font-medium mt-1.5 ${isActive ? preset.color : 'text-slate-500 dark:text-slate-400'}`}>
                                                    {t("done ~{{deadlineShort}}", { deadlineShort: formatDeadlineShort(dl) })}
                                                </p>
                                            ) : null
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">{t("Start Date")}</label>
                            <input
                                type="date"
                                value={startDate}
                                onChange={e => setStartDate(e.target.value)}
                                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-accent focus:border-transparent"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">{t("Deadline")}</label>
                            <input
                                type="date"
                                value={deadline}
                                onChange={e => setDeadline(e.target.value)}
                                min={startDate}
                                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-accent focus:border-transparent"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">{t("Study Days")}</label>
                        <div className="flex justify-evenly">
                            {DAY_LABELS.map(({ iso, label }) => (
                                <button
                                    key={iso}
                                    onClick={() => toggleStudyDay(iso)}
                                    className={`w-10 h-10 rounded-lg text-sm font-medium transition-all ${studyDays.includes(iso)
                                        ? 'bg-accent/10 text-accent-fg ring-1 ring-inset ring-accent/50'
                                        : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* No hours-per-day slider. It set a project column the
                        allocator multiplied in and divided straight back out, so
                        it never moved a date; what it did do was let this dialog
                        price the work in hours at an invented 1.5h per topic.
                        How long a topic takes is the learner's to judge. */}

                    {paceIndicator && (
                        <div className={`p-3 rounded-lg ${paceIndicator.bg} flex items-start gap-2`}>
                            <span className="text-lg leading-none mt-0.5">{paceIndicator.emoji}</span>
                            <div className="min-w-0">
                                <div className={`text-sm font-medium ${paceIndicator.color}`}>{t(paceIndicator.label)}</div>
                                <div className="text-sm text-slate-500 dark:text-slate-400">
                                    ~<strong>{paceIndicator.topicsPerDay}</strong> {t("topics per study day")}
                                </div>
                                <div className="text-sm text-slate-500 dark:text-slate-400">
                                    {t("{{leafCount}} topics · {{studyDayCount}} study days · {{totalDays}} days in all", { leafCount, studyDayCount: paceIndicator.studyDayCount, totalDays: paceIndicator.totalDays })}
                                </div>
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-sm rounded-lg">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            {error}
                        </div>
                    )}
                </div>

                <div className="px-6 py-4 bg-slate-50 dark:bg-slate-700/30 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3">
                    <div>
                        {isEditing && (
                            <button
                                onClick={handleRemove}
                                disabled={busy}
                                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
                                title={t("Remove schedule from this project")}
                            >
                                <Trash2 className={`w-4 h-4 ${actionLoading === 'remove' ? 'animate-pulse' : ''}`} />
                                <span className="hidden sm:inline">{t("Remove schedule")}</span>
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-3">
                    <button
                        onClick={() => setShowScheduleModal(false)}
                        className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg transition-colors"
                    >
                        {t("Cancel")}
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={busy || !deadline || studyDays.length === 0}
                        className="px-5 py-2 text-sm font-semibold text-accent-fg bg-accent/10 hover:bg-accent/20 ring-1 ring-inset ring-accent/40 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2"
                    >
                        {submitting ? (
                            <>
                                <div className="w-4 h-4 border-2 border-accent/30 border-t-accent-fg rounded-full animate-spin" />
                                {t("Generating...")}
                            </>
                        ) : (
                            <>
                                <Zap className="w-4 h-4" />
                                {isEditing ? t("Regenerate Schedule") : t("Generate Schedule")}
                            </>
                        )}
                    </button>
                    </div>
                </div>
            </div>
        </div>
    );
}