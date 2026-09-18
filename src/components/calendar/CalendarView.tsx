import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { onActivateKey } from '../../utils/a11y';
import { api } from '../../api';
import { useStore } from '../../store';
import {
    buildCalendarScaffold,
    assignTasksToDays,
    leafCalendarTasks,
    getWeekNumber,
    getWeekStartDate,
    parseDate,
    formatDate,
    todayStr,
    findNode,
    CalendarTaskInput,
} from '../../utils/tree';
import { CalendarViewMode, CalendarDay } from '../../types';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { useScrollToSelected } from '../../hooks/useScrollToSelected';
import { useSwipeCarousel } from '../../hooks/useSwipeCarousel';
import { ChevronLeft, ChevronRight, CalendarDays, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { uiLocale, monthName, dayHeaders as localeDayHeaders, dateRangeLabel } from '../../utils/locale';

/**
 * THE calendar. One component, two scopes.
 *
 * A private copy per scope drifts apart in exactly the ways duplicated views
 * do: one shows a topic as in-progress and the other cannot, one hardcodes
 * Monday, and each has a different idea of what tapping a day should open.
 * What actually differs between the scopes is where the tasks COME FROM and
 * what a click MEANS; the rest is duplication.
 *
 * What each scope keeps, and why:
 *   • project — study-day shading and out-of-range dimming (both need a project
 *     window, which is meaningless across projects), selection sync with the
 *     rest of the workspace, and tasks read straight off the in-memory tree so
 *     marking a topic done recolours it instantly instead of after a refetch.
 *   • global  — the project legend and colour-by-project, tasks fetched from
 *     `GET /api/calendar` over the whole prev→next window so all three carousel
 *     panels have data and a swipe is instant.
 *
 * Two behaviours are shared across scopes rather than re-decided per scope:
 * status colouring (a cross-project view has no reason to be blinder than the
 * per-project one, so "done or not" is not the vocabulary) and the "+N"
 * overflow badge, which sits inline beside the last visible task instead of
 * spending a whole extra row announcing that a row was dropped.
 *
 * The Mon-Sun / Sun-Sat toggle lives in Settings → General, not in this
 * toolbar: it is a preference you set once, component state would reset it to
 * Monday on every navigation, and on a phone 100px of a toolbar still has to
 * hold the month, the mode and the arrows.
 */

/** Study-day shading is a per-project setting, so globally every day is neutral. */
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

export type CalendarScope =
    | { kind: 'project'; projectId: number }
    | { kind: 'global' };

export default function CalendarView({ scope }: { scope: CalendarScope }) {
    // `language` is in the dependency list of every memo that FORMATS a date:
    // `uiLocale()` reads the current one when it runs, so a memo that does not
    // name it keeps whatever language was set the first time it ran. The week
    // range under the calendar's title stayed English after a switch to Chinese.
    const { t: tr, i18n: { language } } = useTranslation();
    const navigate = useNavigate();
    const isMobile = useIsMobile();

    /**
     * HOW WIDE THIS CALENDAR IS, not how wide the SCREEN is.
     *
     * The layout used to branch on `useIsMobile()`, a viewport media query —
     * but this component has two mount contexts, and in the second one it is a
     * panel beside the navigation tree, about 390px wide on a 1200px screen.
     * The viewport said "desktop", so a week rendered as seven columns of
     * ~55px, every task truncated to "The D…". Seven columns need real width
     * wherever they are, so the layout asks the CONTAINER.
     */
    const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(1024);
    useEffect(() => {
        if (!rootEl) return;
        const ro = new ResizeObserver(() => setWidth(rootEl.clientWidth || 1024));
        ro.observe(rootEl);
        setWidth(rootEl.clientWidth || 1024);
        return () => ro.disconnect();
    }, [rootEl]);
    /** Below this a 7-column grid stops being readable, whatever the screen is. */
    const narrow = width < 640;
    const addToast = useStore(s => s.addToast);
    const weekStartDay = useStore(s => s.weekStartDay);

    const isProject = scope.kind === 'project';
    const projectId = scope.kind === 'project' ? scope.projectId : null;

    const projects = useStore(s => s.projects);
    const tree = useStore(s => s.tree);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const selectNode = useStore(s => s.selectNode);

    const project = projectId != null ? projects.find(p => p.id === projectId) : undefined;

    const now = new Date();
    /**
     * WHICH VIEW OPENS. A month grid is a shape, not a plan: on a desktop it is
     * six rows of four-chip stacks with a "+8" on most of them, and on a phone
     * each cell is fifty pixels wide and can only show coloured dots. Neither
     * answers "what am I doing", which is the question a calendar is opened
     * with. So the default is the densest view that still shows TITLES at that
     * width — a week on a desktop, a single day on a phone — and the month is
     * one tap away for when the question really is about the shape of the
     * month. `useIsMobile` reads `matchMedia` in its own initialiser, so this
     * is already correct on the first render rather than flipping after mount.
     */
    const [viewMode, setViewMode] = useState<CalendarViewMode>(isMobile ? 'day' : 'week');
    const [viewYear, setViewYear] = useState(now.getFullYear());
    const [viewMonth, setViewMonth] = useState(now.getMonth());
    const [weekRefDate, setWeekRefDate] = useState(todayStr());

    const dayHeaders = useMemo(() => localeDayHeaders(weekStartDay), [weekStartDay, language]);

    const studyDays = useMemo(() => {
        if (!isProject) return ALL_DAYS;
        try {
            return project?.study_days ? JSON.parse(project.study_days) : [1, 2, 3, 4, 5];
        } catch {
            return [1, 2, 3, 4, 5];
        }
    }, [isProject, project?.study_days]);

    // ---- period scaffolds (prev | curr | next) ----------------------------

    const scaffolds = useMemo(() => {
        const buildFor = (offset: number): CalendarDay[] => {
            if (viewMode === 'month') {
                let y = viewYear;
                let m = viewMonth + offset;
                if (m < 0) { m += 12; y -= 1; }
                else if (m > 11) { m -= 12; y += 1; }
                return buildCalendarScaffold(y, m, studyDays, { mode: viewMode, weekStartDay, weekRefDate });
            }
            const step = viewMode === 'day' ? 1 : 7;
            const d = parseDate(weekRefDate);
            d.setUTCDate(d.getUTCDate() + step * offset);
            return buildCalendarScaffold(viewYear, viewMonth, studyDays, {
                mode: viewMode, weekStartDay, weekRefDate: formatDate(d),
            });
        };
        return { prev: buildFor(-1), curr: buildFor(0), next: buildFor(1) };
    }, [viewYear, viewMonth, viewMode, weekStartDay, weekRefDate, studyDays]);

    // ---- tasks ------------------------------------------------------------

    const from = scaffolds.prev[0]?.date;
    const to = scaffolds.next[scaffolds.next.length - 1]?.date;

    const [remote, setRemote] = useState<{
        projects: { id: number; name: string; color: string }[];
        tasks: CalendarTaskInput[];
        ownerOf: Map<number, number>;
    } | null>(null);
    const [loading, setLoading] = useState(!isProject);

    useEffect(() => {
        if (isProject || !from || !to) return;
        let cancelled = false;
        setLoading(true);
        api.getCalendarRange(from, to)
            .then(d => {
                if (cancelled) return;
                const colorOf = new Map(d.projects.map(p => [p.id, p.color]));
                setRemote({
                    projects: d.projects,
                    ownerOf: new Map(d.tasks.map(t => [t.nodeId, t.projectId])),
                    tasks: d.tasks.map(t => ({
                        nodeId: t.nodeId,
                        title: t.title,
                        status: t.status,
                        color: colorOf.get(t.projectId) || '#3B82F6',
                        scheduled_start: t.scheduled_start,
                        scheduled_end: t.scheduled_end,
                    })),
                });
            })
            .catch((e: any) => { if (!cancelled) addToast('error', tr("Failed to load calendar"), e.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [isProject, from, to, addToast]);

    const tasks = useMemo<CalendarTaskInput[]>(() => {
        if (!isProject) return remote?.tasks || [];
        return leafCalendarTasks(tree, project?.color || '#3B82F6');
    }, [isProject, remote, tree, project?.color]);

    /** Projects that actually appear in the visible range — the legend. */
    const visibleProjects = useMemo(() => {
        if (isProject || !remote) return [];
        const ids = new Set(remote.tasks.map(t => remote.ownerOf.get(t.nodeId)));
        return remote.projects.filter(p => ids.has(p.id));
    }, [isProject, remote]);

    const panels = useMemo(() => {
        // Fresh scaffold copies, so stale task assignments never accumulate.
        const fresh = (base: CalendarDay[]) => base.map(d => ({ ...d, tasks: [] as CalendarDay['tasks'] }));
        return {
            prev: assignTasksToDays(fresh(scaffolds.prev), tasks),
            curr: assignTasksToDays(fresh(scaffolds.curr), tasks),
            next: assignTasksToDays(fresh(scaffolds.next), tasks),
        };
    }, [scaffolds, tasks]);

    // ---- navigation -------------------------------------------------------

    function prev() {
        if (viewMode === 'month') {
            if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
            else setViewMonth(m => m - 1);
        } else {
            const d = parseDate(weekRefDate);
            d.setUTCDate(d.getUTCDate() - (viewMode === 'day' ? 1 : 7));
            setWeekRefDate(formatDate(d));
        }
    }

    function next() {
        if (viewMode === 'month') {
            if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
            else setViewMonth(m => m + 1);
        } else {
            const d = parseDate(weekRefDate);
            d.setUTCDate(d.getUTCDate() + (viewMode === 'day' ? 1 : 7));
            setWeekRefDate(formatDate(d));
        }
    }

    function goToday() {
        setViewYear(now.getFullYear());
        setViewMonth(now.getMonth());
        setWeekRefDate(todayStr());
    }

    /** Switch mode while keeping the date context, so the view never teleports. */
    function switchViewMode(mode: CalendarViewMode) {
        if (mode === viewMode) return;
        if ((mode === 'week' || mode === 'day') && viewMode === 'month') {
            // TODAY, not the 1st, whenever today is in the month on screen.
            // Zooming into September from the month grid landed on the week of
            // 1 September regardless of the date — so "Week" showed a week the
            // learner had not asked for and had usually already finished, and
            // getting to this one meant pressing Today afterwards. The 1st is
            // still the right answer for any OTHER month, where there is no
            // day the learner is implicitly pointing at.
            const t = todayStr();
            const inView = parseDate(t).getUTCFullYear() === viewYear
                && parseDate(t).getUTCMonth() === viewMonth;
            setWeekRefDate(inView ? t : formatDate(new Date(Date.UTC(viewYear, viewMonth, 1))));
        } else if (mode === 'month' && (viewMode === 'week' || viewMode === 'day')) {
            const ref = parseDate(weekRefDate);
            setViewYear(ref.getUTCFullYear());
            setViewMonth(ref.getUTCMonth());
        }
        // week ↔ day share `weekRefDate`, so that context carries over untouched.
        setViewMode(mode);
    }

    /** Tapping a month cell opens that day — as a WEEK on desktop, where the
     *  surrounding days are context worth having, and as a single DAY on a
     *  phone, where a 7-column week is seven unreadable columns. */
    function openDay(date: string) {
        setWeekRefDate(date);
        const d = parseDate(date);
        setViewYear(d.getUTCFullYear());
        setViewMonth(d.getUTCMonth());
        setViewMode(narrow ? 'day' : 'week');
    }

    const carousel = useSwipeCarousel(prev, next);

    // ---- selection sync (project scope only) ------------------------------

    const bodyRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!isProject || selectedNodeId == null) return;
        const node = findNode(tree, selectedNodeId);
        const sched = node?.scheduled_start || node?.scheduled_end;
        if (!sched) return;
        if (viewMode === 'week' || viewMode === 'day') {
            setWeekRefDate(sched);
        } else {
            const d = parseDate(sched);
            setViewYear(d.getUTCFullYear());
            setViewMonth(d.getUTCMonth());
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedNodeId, isProject]);
    useScrollToSelected(isProject ? selectedNodeId : null, bodyRef, [weekRefDate, viewMonth, viewYear, viewMode]);

    /** A click means "show me this topic" — in a workspace that is a selection,
     *  from the global calendar it is a deep link into the owning project. */
    const openTask = (nodeId: number) => {
        if (isProject) { void selectNode(nodeId); return; }
        const pid = remote?.ownerOf.get(nodeId);
        if (pid != null) navigate(`/project/${pid}/calendar/${nodeId}`);
    };

    // ---- labels -----------------------------------------------------------

    const viewLabel = useMemo(() => {
        if (viewMode === 'month') return `${monthName(viewMonth)} ${viewYear}`;
        if (viewMode === 'day') {
            return parseDate(weekRefDate).toLocaleDateString(uiLocale(), {
                weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC',
            });
        }
        return tr("Week {{n}}", { n: getWeekNumber(weekRefDate, weekStartDay) });
    }, [viewMode, viewMonth, viewYear, weekRefDate, weekStartDay, tr, language]);

    const subLabel = useMemo(() => {
        if (viewMode === 'day') return String(parseDate(weekRefDate).getUTCFullYear());
        if (viewMode === 'month') return null;
        const start = parseDate(getWeekStartDate(weekRefDate, weekStartDay));
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 6);
        // Hand-joining "start without the year" and "end with it" is the English
        // shape: Chinese came out as "9月14日 – 2026年9月20日".
        return dateRangeLabel(start, end);
    }, [viewMode, weekRefDate, weekStartDay, language]);

    // ---- empty state ------------------------------------------------------

    if (isProject && !(project?.start_date && project?.deadline)) {
        return (
            <div className="flex-1 flex items-center justify-center text-slate-500 dark:text-slate-400">
                <div className="text-center">
                    <CalendarDays className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p className="text-lg font-medium">{tr("No schedule set")}</p>
                    <p className="text-sm mt-1">{tr("Set a schedule to see this project day by day")}</p>
                </div>
            </div>
        );
    }

    // ---- chips ------------------------------------------------------------

    const outOfRange = (date: string) =>
        !!(isProject && project?.start_date && project?.deadline &&
            (date < project.start_date || date > project.deadline));

    /**
     * Chip styling. `task.color` already carries the status override applied in
     * `assignTasksToDays` (completed green / skipped grey / in-progress amber,
     * otherwise the project's colour), so the dot says WHOSE work this is and,
     * once it has moved, how it went — in both scopes.
     */
    function chipClass(status: string, isSelected: boolean, compact: boolean) {
        // Hover brightens via `filter` only. A `transition-colors` here would
        // animate every chip that changes status when the period changes, which
        // reads as the whole grid slowly fading.
        const hover = 'transition-[filter] duration-150 ease-out hover:brightness-95 dark:hover:brightness-110';
        const base = compact
            ? `flex items-center gap-1 min-w-0 text-xs leading-tight px-1 py-0.5 rounded ${hover}`
            : `flex items-center gap-1.5 min-w-0 text-xs leading-snug px-2 py-1.5 rounded-md ${hover}`;
        if (isSelected) return `${base} ring-2 ring-accent bg-accent/20 dark:bg-accent/25 text-accent-fg font-medium`;
        if (status === 'completed') return `${base} bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 line-through`;
        if (status === 'skipped') return `${base} bg-slate-100 dark:bg-slate-700/60 text-slate-500 dark:text-slate-400 line-through`;
        if (status === 'in_progress') return `${base} bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300`;
        return `${base} bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300`;
    }

    const chip = (task: CalendarDay['tasks'][number], compact: boolean, trailing?: React.ReactNode) => (
        <div key={task.nodeId} className="flex items-stretch gap-0.5 min-w-0">
            <button
                data-node-id={task.nodeId}
                onClick={e => { e.stopPropagation(); openTask(task.nodeId); }}
                className="flex-1 text-left block min-w-0"
                title={task.title}
            >
                <div className={chipClass(task.status, isProject && task.nodeId === selectedNodeId, compact)}>
                    <span
                        className={`${compact ? 'w-1.5 h-1.5' : 'w-2 h-2'} rounded-full shrink-0`}
                        style={{ backgroundColor: task.color }}
                        aria-hidden="true"
                    />
                    <span className="min-w-0 truncate">{task.title}</span>
                </div>
            </button>
            {trailing}
        </div>
    );

    // ---- per-mode panels --------------------------------------------------

    /** Cap a month cell at 4 rows; the overflow becomes a "+N" beside the last
     *  one rather than stealing a fifth row to announce itself. */
    const MAX_ROWS = 4;

    function renderMonthGrid(days: CalendarDay[]) {
        return (
            <div className="h-full grid grid-cols-7 grid-rows-6 auto-rows-fr">
                {days.map((day, idx) => {
                    const visible = day.tasks.slice(0, MAX_ROWS);
                    const hidden = day.tasks.length - visible.length;
                    const dim = outOfRange(day.date);
                    return (
                        <div
                            key={idx}
                            onClick={() => openDay(day.date)}
                            onKeyDown={onActivateKey(() => openDay(day.date))}
                            role="button"
                            tabIndex={0}
                            title={tr("Open this day")}
                            /* TODAY IS A MARKED DAY, NOT AN ALERT. This cell was
                               `bg-accent/10 ring-1 ring-inset ring-accent`, and
                               inside a project the accent IS the project's own
                               colour — so on a red course the current day drew a
                               full-saturation red box around a mostly empty cell,
                               which reads as an error state rather than as
                               "today". The filled number pill below already says
                               which day it is unmistakably; the cell only has to
                               agree with it quietly. */
                            className={`group relative flex flex-col overflow-hidden border-b border-r border-slate-100 dark:border-slate-700/50 p-1 min-h-[60px] sm:min-h-[80px] cursor-pointer ${!day.isCurrentMonth ? 'bg-slate-50/50 dark:bg-slate-800/30' : ''
                                } ${dim ? 'opacity-40' : ''} ${day.isToday ? 'bg-accent/5 ring-1 ring-inset ring-accent/35' : 'hover:bg-slate-50 dark:hover:bg-slate-700/30'}`}
                        >
                            <span className={`text-xs font-medium mb-1 shrink-0 ${day.isToday
                                ? 'bg-accent text-white w-5 h-5 rounded-full inline-flex items-center justify-center leading-none'
                                : day.isCurrentMonth ? 'text-slate-700 dark:text-slate-300' : 'text-slate-500 dark:text-slate-400'}`}>
                                {parseDate(day.date).getUTCDate()}
                            </span>

                            {narrow ? (
                                /* A phone cell is ~50px wide: a title is unreadable there,
                                   so the cell carries status dots and the tap opens the day. */
                                day.tasks.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-0.5 min-w-0">
                                        {day.tasks.slice(0, 4).map(t => (
                                            <span key={t.nodeId} className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                                        ))}
                                        {day.tasks.length > 4 && (
                                            <span className="text-[10px] leading-none font-medium text-slate-500 dark:text-slate-400">
                                                +{day.tasks.length - 4}
                                            </span>
                                        )}
                                    </div>
                                )
                            ) : (
                                <div className="space-y-0.5 min-w-0 overflow-hidden">
                                    {visible.map((task, tIdx) => chip(task, true,
                                        hidden > 0 && tIdx === visible.length - 1 ? (
                                            <span
                                                title={tr("{{hidden}} more", { hidden })}
                                                className="shrink-0 flex items-center text-xs leading-tight px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                                            >
                                                +{hidden}
                                            </span>
                                        ) : undefined,
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        );
    }

    /** Desktop week: 7 columns, each its own scrollable task list. */
    function renderWeekGrid(days: CalendarDay[], attachRef: boolean) {
        return (
            <div ref={attachRef ? bodyRef : undefined} className="h-full grid grid-cols-7 overflow-hidden">
                {days.map((day, idx) => {
                    const dim = outOfRange(day.date);
                    return (
                        <div
                            key={idx}
                            className={`flex flex-col border-r border-slate-200 dark:border-slate-700/50 last:border-r-0 ${!day.isStudyDay ? 'bg-slate-50/50 dark:bg-slate-800/30' : ''
                                } ${dim ? 'opacity-40' : ''} ${day.isToday ? 'bg-accent/5' : ''}`}
                        >
                            <div className={`px-1 sm:px-2 py-2 text-center border-b border-slate-100 dark:border-slate-700/50 shrink-0 ${day.isToday ? 'bg-accent/10' : ''}`}>
                                <div className="text-[10px] sm:text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                    {dayHeaders[idx]}
                                </div>
                                <div className={`font-semibold mt-0.5 mx-auto w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center ${day.isToday
                                    ? 'bg-accent text-white rounded-full text-sm'
                                    : 'text-base sm:text-lg text-slate-700 dark:text-slate-300'}`}>
                                    {parseDate(day.date).getUTCDate()}
                                </div>
                                {isProject && day.isStudyDay && (
                                    <div className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400 hidden sm:block">
                                        {tr("study day")}
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 p-1 sm:p-1.5 space-y-1 overflow-y-auto">
                                {day.tasks.map(task => chip(task, false))}
                                {day.tasks.length === 0 && (
                                    <div className="text-xs text-slate-500 dark:text-slate-400 text-center mt-4">{tr("No tasks")}</div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    }

    /** Mobile week: one row per day, day label pinned left, tasks wrapping right,
     *  the whole list scrolling vertically — nothing overflows the panel. */
    function renderWeekRows(days: CalendarDay[], attachRef: boolean) {
        return (
            <div ref={attachRef ? bodyRef : undefined} className="h-full overflow-y-auto divide-y divide-slate-100 dark:divide-slate-700/50">
                {days.map((day, idx) => {
                    const dim = outOfRange(day.date);
                    return (
                        <div
                            key={idx}
                            className={`flex items-stretch gap-2 px-2 py-2 ${!day.isStudyDay ? 'bg-slate-50/50 dark:bg-slate-800/30' : ''
                                } ${dim ? 'opacity-40' : ''} ${day.isToday ? 'bg-accent/5' : ''}`}
                        >
                            <div className="w-11 shrink-0 flex flex-col items-center pt-0.5">
                                <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                    {dayHeaders[idx]}
                                </div>
                                <div className={`text-base font-semibold mt-0.5 ${day.isToday
                                    ? 'bg-accent text-white w-7 h-7 rounded-full flex items-center justify-center text-sm'
                                    : 'text-slate-700 dark:text-slate-300'}`}>
                                    {parseDate(day.date).getUTCDate()}
                                </div>
                            </div>
                            <div className="flex-1 min-w-0 flex flex-wrap content-start gap-1">
                                {day.tasks.length === 0 ? (
                                    <span className="text-xs text-slate-500 dark:text-slate-400 self-center">
                                        {day.isStudyDay ? tr("No tasks") : '—'}
                                    </span>
                                ) : (
                                    day.tasks.map(task => (
                                        <div key={task.nodeId} className="max-w-full">
                                            {chip(task, false)}
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    }

    function renderDayList(days: CalendarDay[], attachRef: boolean) {
        const day = days[0];
        return (
            <div ref={attachRef ? bodyRef : undefined} className="h-full overflow-y-auto px-3 sm:px-4 py-3">
                <div className="max-w-2xl mx-auto space-y-1.5">
                    {(day?.tasks.length ?? 0) === 0 ? (
                        <div className="text-center text-slate-500 dark:text-slate-400 mt-16">
                            <CalendarDays className="w-10 h-10 mx-auto mb-2 opacity-50" />
                            <p className="text-sm font-medium">{tr("No tasks scheduled")}</p>
                            <p className="text-xs mt-1">
                                {isMobile ? tr("Swipe left or right to browse other days") : tr("Use the arrows to browse other days")}
                            </p>
                        </div>
                    ) : (
                        day?.tasks.map(task => chip(task, false))
                    )}
                </div>
            </div>
        );
    }

    function renderPanel(days: CalendarDay[], attachRef: boolean) {
        if (viewMode === 'month') return renderMonthGrid(days);
        if (viewMode === 'day') return renderDayList(days, attachRef);
        return narrow ? renderWeekRows(days, attachRef) : renderWeekGrid(days, attachRef);
    }

    // ---- render -----------------------------------------------------------

    return (
        <div ref={setRootEl} className="h-full flex-1 flex flex-col overflow-hidden">
            {/* One toolbar that wraps, at every width. The old per-project header
                absolutely-centred its month label and let the controls flow around
                it, which only holds while the controls happen to be narrower than
                the gap on either side. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 shrink-0">
                <div className="flex items-baseline gap-2 min-w-0 mr-auto">
                    <h2 className="flex items-center gap-2 text-base sm:text-lg font-semibold text-slate-800 dark:text-white truncate">
                        <CalendarDays className="w-5 h-5 text-accent-fg shrink-0 self-center" aria-hidden="true" />
                        {viewLabel}
                    </h2>
                    {subLabel && (
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">{subLabel}</span>
                    )}
                    {loading && <Loader2 className="w-4 h-4 text-slate-400 animate-spin shrink-0 self-center" aria-label={tr("Loading")} />}
                </div>

                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-slate-700 rounded-lg p-0.5" role="group" aria-label={tr("Calendar view mode")}>
                        {(['month', 'week', 'day'] as CalendarViewMode[]).map(mode => (
                            <button
                                key={mode}
                                onClick={() => switchViewMode(mode)}
                                aria-pressed={viewMode === mode}
                                className={`px-2.5 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${viewMode === mode
                                    ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm'
                                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}
                            >
                                {mode === 'month' ? tr("Month") : mode === 'week' ? tr("Week") : tr("Day")}
                            </button>
                        ))}
                    </div>
                    <button
                        onClick={goToday}
                        className="px-3 py-1.5 text-xs font-medium text-accent-fg bg-accent/10 rounded-lg hover:bg-accent/20"
                    >
                        {tr("Today")}
                    </button>
                    <div className="flex items-center">
                        <button onClick={prev} aria-label={tr("Previous period")} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400">
                            <ChevronLeft className="w-5 h-5" />
                        </button>
                        <button onClick={next} aria-label={tr("Next period")} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400">
                            <ChevronRight className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Legend — global scope only; in a workspace every chip is this project. */}
            {visibleProjects.length > 0 && (
                /* Capped: at 160% six project names stacked one per line took ~400
                   of 812px — the key to the calendar taking half the calendar. */
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 sm:px-4 py-2 border-b border-slate-200 dark:border-slate-700 shrink-0 max-h-[22vh] overflow-y-auto">
                    {visibleProjects.map(p => (
                        <span key={p.id} className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 min-w-0">
                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: p.color }} aria-hidden="true" />
                            <span className="truncate max-w-[180px]">{p.name}</span>
                        </span>
                    ))}
                </div>
            )}

            {/* Weekday headers — month only. The week grid carries its own per-column
                headers with dates, so printing these too would duplicate them. */}
            {viewMode === 'month' && (
                <div className="grid grid-cols-7 border-b border-slate-200 dark:border-slate-700 shrink-0">
                    {dayHeaders.map(h => (
                        <div key={h} className="py-1.5 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            {h}
                        </div>
                    ))}
                </div>
            )}

            {/* Vertical overflow SCROLLS; horizontal stays hidden for the swipe.
                A month is six rows with a px floor per cell, and the chrome above
                it (toolbar, legend, weekday header) is sized in `rem` — so at a
                large UI scale the chrome grows, the grid does not shrink, and the
                bottom week ran 4px past an `overflow-hidden` edge with no way to
                reach it. Measured at 160% on a 375x812 phone: the last row sat at
                756-816 in an 812px viewport. A week of the month being quietly
                unreachable is not a rounding error, so the axis the swipe does
                not use is given back to the reader. */}
            <div ref={carousel.viewportRef} className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto touch-pan-y">
                <div className="flex min-h-full" {...carousel.trackProps}>
                    <div className="shrink-0 min-h-full" style={carousel.panelStyle}>{renderPanel(panels.prev, false)}</div>
                    <div className="shrink-0 min-h-full" style={carousel.panelStyle}>{renderPanel(panels.curr, true)}</div>
                    <div className="shrink-0 min-h-full" style={carousel.panelStyle}>{renderPanel(panels.next, false)}</div>
                </div>
            </div>
        </div>
    );
}
