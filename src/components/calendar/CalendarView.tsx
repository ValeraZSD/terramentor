import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { onActivateKey } from '../../utils/a11y';
import { api } from '../../api';
import { useStore } from '../../store';
import {
    buildCalendarScaffold,
    assignTasksToDays,
    leafCalendarTasks,
    cardPlanCalendarTasks,
    getWeekNumber,
    getWeekStartDate,
    parseDate,
    formatDate,
    todayStr,
    findNode,
    isReadyToProve,
    splitLateTasks,
    CalendarTaskInput,
} from '../../utils/tree';
import { CalendarViewMode, CalendarDay } from '../../types';
import { Chip } from '../ui/Chip';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { useScrollToSelected } from '../../hooks/useScrollToSelected';
import { scrollIntoViewWithin } from '../../utils/scrollWithin';
import { useSwipeCarousel } from '../../hooks/useSwipeCarousel';
import { useRootFontSize } from '../../hooks/useRootFontSize';
import { CalendarDays, ChevronRight, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CalendarNav } from './CalendarNav';
import { useCalendarKeys, useCalendarFocusOnOpen } from './calendarKeys';
import { isNarrowCalendar, isCompactCalendar, isWeekGrid, chipsNameCourse } from './calendarLayout';
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
 *   • global  — the course filter and colour-by-project, tasks fetched from
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

/** The two kinds of late work, each a group on today and a list in its Day view. */
const LATE_KINDS = ['overdue', 'ready'] as const;
type LateKind = typeof LATE_KINDS[number];
/** How many late topics a group's tooltip names before "…". */
const LATE_TITLE_NAMES = 5;

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
     * A viewport media query (`useIsMobile()`) is the wrong test: this
     * component has two mount contexts, and in the second one it is a panel
     * beside the navigation tree, about 390px wide on a 1200px screen. The
     * viewport would say "desktop", so a week would render as seven columns of
     * ~55px, every task truncated. Seven columns need real width wherever they
     * are, so the layout asks the CONTAINER.
     */
    const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(1024);
    const rootFontSize = useRootFontSize();
    useEffect(() => {
        if (!rootEl) return;
        const ro = new ResizeObserver(() => setWidth(rootEl.clientWidth || 1024));
        ro.observe(rootEl);
        setWidth(rootEl.clientWidth || 1024);
        return () => ro.disconnect();
    }, [rootEl]);
    const narrow = isNarrowCalendar(width);
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
        projects: { id: number; name: string; color: string; scheduled?: boolean }[];
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
                        provable: t.provable,
                    })),
                });
            })
            .catch((e: any) => { if (!cancelled) addToast('error', tr("Failed to load calendar"), e.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [isProject, from, to, addToast]);

    // A project measured in cards stores no topic dates; its days are the plan's
    // sections (`cardPlan`), served with the pace of the project on screen.
    const paceData = useStore(s => s.paceData);
    const cardPlan = isProject && paceData?.basis === 'cards' ? paceData.cardPlan ?? null : null;

    const tasks = useMemo<CalendarTaskInput[]>(() => {
        if (!isProject) return remote?.tasks || [];
        if (cardPlan) return cardPlanCalendarTasks(tree, cardPlan, project?.color || '#3B82F6');
        return leafCalendarTasks(tree, project?.color || '#3B82F6');
    }, [isProject, remote, tree, project?.color, cardPlan]);

    /**
     * THE COURSE KEY IS A FILTER, and the same row in every view. As a key it
     * listed whatever the three periods on screen touched, so it changed as
     * the learner paged, and it vanished wherever the chips named their course
     * (a wide week, the day list), so the same calendar had a key in one view
     * and none in the next. It lists every course with dates (or work on
     * screen), so it holds still while paging, and a press narrows everything
     * to the courses picked: the chips, the late groups and Today's count.
     */
    const filterProjects = useMemo(() => {
        if (isProject || !remote) return [];
        const ids = new Set(remote.tasks.map(t => remote.ownerOf.get(t.nodeId)));
        return remote.projects.filter(p => p.scheduled || ids.has(p.id));
    }, [isProject, remote]);
    /** The courses picked; none picked = every course. Only a course still in
     *  the row counts: one archived while picked would otherwise filter the
     *  calendar to nothing with no pill pressed, and a row that hides (one
     *  course left) would leave a filter on that nothing can clear. */
    const [pickedIds, setPicked] = useState<number[]>([]);
    const picked = useMemo(() => filterProjects.length > 1
        ? pickedIds.filter(id => filterProjects.some(p => p.id === id))
        : [], [pickedIds, filterProjects]);
    // ...and forgotten, so a course that comes back is not silently re-picked.
    // Guarded: it writes only when a pick actually left the row.
    useEffect(() => {
        if (remote && picked.length !== pickedIds.length) setPicked(picked);
    }, [remote, picked, pickedIds]);
    const togglePicked = (id: number) =>
        setPicked(picked.includes(id) ? picked.filter(p => p !== id) : [...picked, id]);
    const shown = useMemo(() => {
        if (isProject || picked.length === 0 || !remote) return tasks;
        return tasks.filter(t => picked.includes(remote.ownerOf.get(t.nodeId) ?? -1));
    }, [isProject, picked, remote, tasks]);

    // Late work leaves its days and is owed TODAY (`splitLateTasks`).
    const today = todayStr();
    const late = useMemo(() => splitLateTasks(shown, today), [shown, today]);

    const panels = useMemo(() => {
        // Fresh scaffold copies, so stale task assignments never accumulate.
        const fresh = (base: CalendarDay[]) => base.map(d => ({ ...d, tasks: [] as CalendarDay['tasks'] }));
        return {
            prev: assignTasksToDays(fresh(scaffolds.prev), late.onDays),
            curr: assignTasksToDays(fresh(scaffolds.curr), late.onDays),
            next: assignTasksToDays(fresh(scaffolds.next), late.onDays),
        };
    }, [scaffolds, late]);
    const todayInView = panels.curr.some(d => d.date === today);

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
            // Landing on the week of the 1st would show a week the learner did
            // not ask for and had usually already finished. The 1st is still
            // the right answer for any OTHER month, where there is no day the
            // learner is implicitly pointing at.
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

    /** A late group opens the Day view of today, where its topics are listed:
     *  the group is a count, the list is the day it is owed on. The list sits
     *  UNDER the day's plan, so the one pressed is brought to the learner. */
    const [lateTarget, setLateTarget] = useState<LateKind | null>(null);
    function openLateList(kind: LateKind) {
        const t = todayStr();
        setWeekRefDate(t);
        setViewYear(parseDate(t).getUTCFullYear());
        setViewMonth(parseDate(t).getUTCMonth());
        setViewMode('day');
        setLateTarget(kind);
    }

    const carousel = useSwipeCarousel(prev, next);

    // Keys (`calendarKey` says which and when), and focus as the calendar opens
    // so they work before the learner has clicked into it.
    useCalendarKeys(rootEl, { prev, next, today: goToday, view: switchViewMode });
    useCalendarFocusOnOpen(rootEl);

    // ---- selection sync (project scope only) ------------------------------

    const bodyRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!isProject || selectedNodeId == null) return;
        const node = findNode(tree, selectedNodeId);
        // A late topic is drawn on today, not on its planned days, so selecting
        // one shows today (its group is ringed there).
        const isLateNode = [...late.overdue, ...late.ready].some(t => t.nodeId === selectedNodeId);
        const sched = isLateNode ? todayStr() : node?.scheduled_start || node?.scheduled_end;
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

    // A pressed late group: its list, under the day's plan, is scrolled to the
    // top of the calendar (only the calendar's own scroller moves) and its
    // heading takes focus, so a screen reader lands where the eye does.
    useEffect(() => {
        if (!lateTarget || viewMode !== 'day') return;
        setLateTarget(null);
        const heading = bodyRef.current?.querySelector<HTMLElement>(`[data-late-list="${lateTarget}"] > h3`);
        if (!heading) return;
        heading.focus({ preventScroll: true });
        scrollIntoViewWithin(heading.parentElement, { boundary: rootEl, block: 'start', padding: 12 });
    }, [lateTarget, viewMode, rootEl]);

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
        // The dates lead and the week number follows: the dates are what the
        // columns below are labelled with, the number is for those who count
        // school weeks. Hand-joining "start without the year" and "end with
        // it" is the English shape: Chinese came out as "9月14日 – 2026年9月20日".
        const start = parseDate(getWeekStartDate(weekRefDate, weekStartDay));
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 6);
        return dateRangeLabel(start, end);
    }, [viewMode, viewMonth, viewYear, weekRefDate, weekStartDay, language]);

    const subLabel = useMemo(() => {
        if (viewMode === 'day') return String(parseDate(weekRefDate).getUTCFullYear());
        if (viewMode === 'month') return null;
        return tr("Week {{n}}", { n: getWeekNumber(weekRefDate, weekStartDay) });
    }, [viewMode, weekRefDate, weekStartDay, tr, language]);

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

    const weekGrid = isWeekGrid(viewMode, width);
    const chipsNameOwner = chipsNameCourse(viewMode, width, rootFontSize);

    /** Past its end and known well enough to pass its check: it says "Ready
     *  to prove" and is not painted red (`isReadyToProve`, src/utils/tree.ts). */
    const isReady = (task: CalendarDay['tasks'][number]) =>
        isReadyToProve({ status: task.status, scheduled_end: task.end, provable: task.provable }, today);

    /** Still open after its own last day and not yet known — the one state a
     *  calendar exists to show. */
    const isLate = (task: CalendarDay['tasks'][number]) =>
        task.end < today && task.status !== 'completed' && task.status !== 'skipped' && !isReady(task);

    /** Sat/Sun in the library calendar (projects disagree on study days); a
     *  project's own non-study days inside a project. Shaded, never hidden. */
    const isRestDay = (day: CalendarDay) =>
        isProject ? !day.isStudyDay : day.dayOfWeek === 0 || day.dayOfWeek === 6;

    /**
     * Chip styling. The dot is always the PROJECT's colour (whose work this is);
     * how it is going is the chip's BODY — done, skipped, under way, late. A
     * dot recoloured by status would paint a finished topic emerald like a
     * green course and an under-way one amber like an orange course, so one
     * colour would mean three things. Every chip has a body and an
     * edge, because a bare line of text on the page reads as part of the page.
     */
    function chipClass(task: CalendarDay['tasks'][number], isSelected: boolean, compact: boolean) {
        // Hover brightens via `filter` only. A `transition-colors` here would
        // animate every chip that changes status when the period changes, which
        // reads as the whole grid slowly fading.
        const hover = 'transition-[filter] duration-150 ease-out hover:brightness-95 dark:hover:brightness-110';
        const base = compact
            ? `flex items-center gap-1 min-w-0 text-xs leading-tight px-1 py-px rounded border ${hover}`
            // `h-full`: a button centres its content, so in the Day view's grid a
            // short chip floated in the middle of a row its neighbour made tall.
            : `flex items-start gap-1.5 min-w-0 h-full text-sm leading-snug px-2 py-1.5 rounded-md border ${hover}`;
        const { status } = task;
        if (isSelected) return `${base} ring-2 ring-accent border-transparent bg-accent/15 dark:bg-accent/25 text-accent-fg font-medium`;
        if (status === 'completed') return `${base} bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-900/30 dark:border-emerald-800/60 dark:text-emerald-200 line-through`;
        if (status === 'skipped') return `${base} bg-slate-100 border-slate-200 text-slate-500 dark:bg-slate-700/60 dark:border-slate-600 dark:text-slate-400 line-through`;
        if (isLate(task)) return `${base} bg-red-50 border-red-200 text-red-800 dark:bg-red-900/30 dark:border-red-800/60 dark:text-red-200`;
        // Late but known: not red, and not an on-time chip either — the accent
        // the sidebar's shield and the dashboard's "Ready to prove" group use.
        if (isReady(task)) return `${base} bg-accent/10 border-accent/40 text-accent-fg dark:bg-accent/20 dark:border-accent/50`;
        if (status === 'in_progress') return `${base} bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-900/30 dark:border-amber-800/60 dark:text-amber-200`;
        return `${base} bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-700/70 dark:border-slate-600 dark:text-slate-100`;
    }

    /** The project a chip belongs to, by name — only the library calendar mixes them. */
    const projectNameOf = (nodeId: number) => {
        if (isProject || !remote) return null;
        const pid = remote.ownerOf.get(nodeId);
        return remote.projects.find(p => p.id === pid)?.name ?? null;
    };

    /**
     * A chip is drawn once, on the first day of its span this period shows, so
     * the title alone no longer says when the topic actually runs. Its hover
     * says it everywhere; a `roomy` chip also prints it, a month cell has no
     * width to spare for it.
     */
    const taskLabel = (task: CalendarDay['tasks'][number]) =>
        task.start === task.end
            ? task.title
            : `${task.title} · ${dateRangeLabel(parseDate(task.start), parseDate(task.end))}`;

    /** `roomy`: the day list and a wide week's columns, which have the room to
     *  say which days a topic runs and, where `chipsNameOwner`, whose topic it
     *  is. Without the span a topic running Fri 30 – Mon 2 looked like a
     *  duplicate in the next week and like a carry-over in the day view. */
    const chip = (task: CalendarDay['tasks'][number], compact: boolean, trailing?: React.ReactNode, roomy = false) => {
        const owner = roomy && chipsNameOwner ? projectNameOf(task.nodeId) : null;
        const span = roomy && task.start !== task.end
            ? dateRangeLabel(parseDate(task.start), parseDate(task.end), { year: false })
            : null;
        const ready = isReady(task);
        // The state is said once, by the group or the Day list's heading that
        // holds a late chip; the chip itself only carries it in its tooltip and
        // its colour. Eleven chips each saying "Overdue" was the wall.
        const lateWord = isLate(task) ? tr("Overdue") : ready ? tr("Ready to prove") : null;
        // A month cell has no room for the owner, but its tooltip does: a deck's
        // "Stage 4" names nothing on its own, and three decks have one each.
        const hoverOwner = projectNameOf(task.nodeId);
        return (
            <div key={task.nodeId} className="flex items-stretch gap-0.5 min-w-0">
                <button
                    data-node-id={task.nodeId}
                    onClick={e => { e.stopPropagation(); openTask(task.nodeId); }}
                    className="flex-1 text-left block min-w-0"
                    title={[taskLabel(task), hoverOwner, lateWord].filter(Boolean).join(' · ')}
                >
                    <div className={chipClass(task, isProject && task.nodeId === selectedNodeId, compact)}>
                        <span
                            className={`${compact ? 'w-2 h-2' : 'w-2.5 h-2.5 mt-1'} rounded-full shrink-0`}
                            style={{ backgroundColor: task.color }}
                            aria-hidden="true"
                        />
                        {compact ? (
                            <>
                                {/* A month cell has no room for the words. */}
                                {ready && <ShieldCheck className="w-3 h-3 shrink-0" aria-hidden="true" />}
                                <span className="min-w-0 truncate">{task.title}</span>
                            </>
                        ) : (
                            <span className="min-w-0 flex-1">
                                <span className="block line-clamp-2 break-words">{task.title}</span>
                                {span && <span className="block text-xs no-underline opacity-90">{span}</span>}
                                {/* The course on a line of its own, WRAPPED, never cut:
                                    a course has no short name, and a cut drops the
                                    tail that tells "Organic Chemistry: Reactions"
                                    from "Organic Chemistry: Synthesis". */}
                                {owner && <span className="block text-xs no-underline opacity-90 break-words">{owner}</span>}
                            </span>
                        )}
                    </div>
                </button>
                {trailing}
            </div>
        );
    };

    // ---- late work: one group per state, on today -------------------------

    const asChip = (t: CalendarTaskInput): CalendarDay['tasks'][number] => ({
        nodeId: t.nodeId,
        title: t.title,
        status: t.status as CalendarDay['tasks'][number]['status'],
        color: t.color,
        start: t.scheduled_start,
        end: t.scheduled_end,
        provable: !!t.provable,
    });
    const lateLabel = (kind: LateKind) => kind === 'overdue'
        ? tr("{{count}} overdue", { count: late.overdue.length })
        : tr("{{count}} ready to prove", { count: late.ready.length });
    const lateCount = late.overdue.length + late.ready.length;

    /**
     * The late work on today's cell, column or row: a COUNT per state that opens
     * the Day view's list, never the topics themselves. Red for overdue; the
     * accent and the shield for late-but-known, as everywhere else.
     */
    const lateGroups = (compact: boolean) => LATE_KINDS.map(kind => {
        const list = late[kind];
        if (list.length === 0) return null;
        const selected = isProject && list.some(t => t.nodeId === selectedNodeId);
        const hover = 'transition-[filter] duration-150 ease-out hover:brightness-95 dark:hover:brightness-110';
        const shape = compact
            ? 'flex items-center gap-1 min-w-0 text-xs leading-tight px-1 py-px rounded border font-semibold'
            : 'flex items-center gap-1.5 min-w-0 text-sm leading-snug px-2 py-1.5 rounded-md border font-semibold';
        const tone = selected
            ? 'ring-2 ring-accent border-transparent bg-accent/15 dark:bg-accent/25 text-accent-fg'
            : kind === 'overdue'
                ? 'bg-red-50 border-red-200 text-red-800 dark:bg-red-900/30 dark:border-red-800/60 dark:text-red-200'
                : 'bg-accent/10 border-accent/40 text-accent-fg dark:bg-accent/20 dark:border-accent/50';
        return (
            <button
                key={kind}
                type="button"
                data-late-group={kind}
                onClick={e => { e.stopPropagation(); openLateList(kind); }}
                className="block w-full text-left min-w-0"
                /* The first few names on hover, never all: a title is read
                   aloud as the button's description, and 200 late topics
                   would be 200 names. The list is one press away. */
                title={list.slice(0, LATE_TITLE_NAMES).map(t => t.title).join(' · ')
                    + (list.length > LATE_TITLE_NAMES ? ' · …' : '')}
            >
                <span className={`${shape} ${tone} ${hover}`}>
                    {kind === 'ready' && <ShieldCheck className={`${compact ? 'w-3 h-3' : 'w-4 h-4'} shrink-0`} aria-hidden="true" />}
                    <span className={`min-w-0 flex-1 ${compact ? 'truncate' : ''}`}>{lateLabel(kind)}</span>
                    <ChevronRight className={`${compact ? 'w-3 h-3' : 'w-4 h-4'} shrink-0 opacity-70`} aria-hidden="true" />
                </span>
            </button>
        );
    });

    // ---- per-mode panels --------------------------------------------------

    /** Cap a month cell at 4 rows; the overflow becomes a "+N" beside the last
     *  one rather than stealing a fifth row to announce itself. */
    const MAX_ROWS = 4;

    function renderMonthGrid(days: CalendarDay[]) {
        return (
            <div className="h-full grid grid-cols-7 grid-rows-6 auto-rows-fr bg-white dark:bg-slate-800">
                {days.map((day, idx) => {
                    const owedHere = day.date === today && lateCount > 0;
                    const groupRows = owedHere ? LATE_KINDS.filter(k => late[k].length > 0).length : 0;
                    const visible = day.tasks.slice(0, MAX_ROWS - groupRows);
                    const hidden = day.tasks.length - visible.length;
                    const dim = outOfRange(day.date);
                    // One background per cell, in this order: today, a day of
                    // another month, a rest day, an ordinary day (the grid's own).
                    const surface = day.isToday ? 'bg-accent/10 ring-2 ring-inset ring-accent/45'
                        : !day.isCurrentMonth ? 'bg-slate-100 dark:bg-slate-900/50 [&>*]:opacity-60'
                            : isRestDay(day) ? 'bg-slate-50 dark:bg-slate-900/25'
                                : 'hover:bg-slate-50 dark:hover:bg-slate-700/30';
                    return (
                        <div
                            key={idx}
                            data-date={day.date}
                            onClick={() => openDay(day.date)}
                            onKeyDown={onActivateKey(() => openDay(day.date))}
                            role="button"
                            tabIndex={0}
                            title={tr("Open this day")}
                            /* TODAY IS A MARKED DAY, NOT AN ALERT. A full-strength
                               accent ring on a red course reads as an error state,
                               so the ring is the accent at 45% — but it is TWO
                               pixels and the cell is tinted, because a fainter
                               one-pixel ring is 1.05:1 against the page on a
                               tinted theme and today cannot be found. Cell
                               edges are a full border rung for the same
                               reason. */
                            className={`group relative flex flex-col overflow-hidden border-b border-r border-slate-200 dark:border-slate-700 p-1 min-h-[60px] sm:min-h-[80px] cursor-pointer ${surface} ${dim ? 'opacity-60' : ''}`}
                        >
                            <span className={`text-xs font-semibold mb-1 shrink-0 ${day.isToday
                                ? 'bg-accent text-white w-5 h-5 rounded-full inline-flex items-center justify-center leading-none'
                                : day.isCurrentMonth ? 'text-slate-800 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400 font-normal'}`}>
                                {parseDate(day.date).getUTCDate()}
                            </span>

                            {narrow ? (
                                /* A phone cell is ~50px wide: a title is unreadable there,
                                   so the cell carries status dots and the tap opens the day.
                                   Today's cell leads with the count of what is owed. */
                                (day.tasks.length > 0 || owedHere) && (
                                    <div className="flex flex-wrap items-center gap-0.5 min-w-0">
                                        {owedHere && LATE_KINDS.map(kind => late[kind].length > 0 && (
                                            <span key={kind} data-late-count={kind} title={lateLabel(kind)}
                                                className={`px-1 leading-4 text-3xs font-bold rounded-full ${kind === 'overdue' ? 'bg-red-600 text-white' : 'bg-accent text-white'}`}>
                                                <span aria-hidden="true">{late[kind].length}</span>
                                                <span className="sr-only">{lateLabel(kind)}</span>
                                            </span>
                                        ))}
                                        {day.tasks.slice(0, 4).map(t => (
                                            <span key={t.nodeId} className={`w-2 h-2 rounded-full shrink-0 ${isLate(t) ? 'ring-2 ring-red-500' : ''}`} style={{ backgroundColor: t.color }} />
                                        ))}
                                        {day.tasks.length > 4 && (
                                            <span className="text-3xs leading-none font-medium text-slate-500 dark:text-slate-400">
                                                +{day.tasks.length - 4}
                                            </span>
                                        )}
                                    </div>
                                )
                            ) : (
                                <div className="space-y-0.5 min-w-0 overflow-hidden">
                                    {owedHere && lateGroups(true)}
                                    {visible.map((task, tIdx) => chip(task, true,
                                        hidden > 0 && tIdx === visible.length - 1 ? (
                                            <span
                                                title={tr("{{hidden}} more", { hidden })}
                                                className="shrink-0 flex items-center text-xs leading-tight px-1 py-px rounded border border-slate-200 dark:border-slate-600 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
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
            <div ref={attachRef ? bodyRef : undefined} className="h-full grid grid-cols-7 overflow-hidden bg-white dark:bg-slate-800">
                {days.map((day, idx) => {
                    const dim = outOfRange(day.date);
                    const rest = isRestDay(day);
                    const owedHere = day.date === today && lateCount > 0;
                    return (
                        <div
                            key={idx}
                            data-date={day.date}
                            className={`flex flex-col border-r border-slate-200 dark:border-slate-700 last:border-r-0 ${day.isToday ? 'bg-accent/[0.07]' : rest ? 'bg-slate-50 dark:bg-slate-900/25' : ''
                                } ${dim ? 'opacity-60' : ''}`}
                        >
                            {/* A header band, not more page: the weekday and date sit
                                on their own rung so the column under them reads as a
                                column. A rest day says so in words, because shading
                                alone is a code nobody was told. */}
                            <div className={`px-1 sm:px-2 py-2 text-center border-b border-slate-200 dark:border-slate-700 shrink-0 ${day.isToday ? 'bg-accent/15' : 'bg-slate-100 dark:bg-slate-900/40'}`}>
                                <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                                    {dayHeaders[idx]}
                                </div>
                                <div className={`font-semibold mt-0.5 mx-auto w-8 h-8 flex items-center justify-center ${day.isToday
                                    ? 'bg-accent text-white rounded-full text-base'
                                    : 'text-lg text-slate-800 dark:text-slate-100'}`}>
                                    {parseDate(day.date).getUTCDate()}
                                </div>
                                {isProject && rest && (
                                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 hidden sm:block">
                                        {tr("day off")}
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 p-1 sm:p-1.5 space-y-1 overflow-y-auto">
                                {/* A column of a wide week has the room for the days a
                                    topic runs and, on a big screen, its course: the key
                                    above was up to 2000px away, and two courses can
                                    share a colour. */}
                                {owedHere && lateGroups(false)}
                                {day.tasks.map(task => chip(task, false, undefined, true))}
                                {day.tasks.length === 0 && !owedHere && (
                                    <div className="text-xs text-slate-500 dark:text-slate-400 text-center mt-4">{rest ? '—' : tr("No tasks")}</div>
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
            <div ref={attachRef ? bodyRef : undefined} className="h-full overflow-y-auto divide-y divide-slate-200 dark:divide-slate-700 bg-white dark:bg-slate-800">
                {days.map((day, idx) => {
                    const dim = outOfRange(day.date);
                    const owedHere = day.date === today && lateCount > 0;
                    return (
                        <div
                            key={idx}
                            data-date={day.date}
                            className={`flex items-stretch gap-2 px-2 py-2 ${day.isToday ? 'bg-accent/10' : isRestDay(day) ? 'bg-slate-50 dark:bg-slate-900/25' : ''
                                } ${dim ? 'opacity-60' : ''}`}
                        >
                            <div className="w-11 shrink-0 flex flex-col items-center pt-0.5">
                                <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                                    {dayHeaders[idx]}
                                </div>
                                <div className={`text-base font-semibold mt-0.5 ${day.isToday
                                    ? 'bg-accent text-white w-7 h-7 rounded-full flex items-center justify-center text-sm'
                                    : 'text-slate-700 dark:text-slate-300'}`}>
                                    {parseDate(day.date).getUTCDate()}
                                </div>
                            </div>
                            <div className="flex-1 min-w-0 flex flex-wrap content-start gap-1">
                                {owedHere && LATE_KINDS.map((kind, i) => late[kind].length > 0 && (
                                    <div key={kind} className="max-w-full">{lateGroups(false)[i]}</div>
                                ))}
                                {day.tasks.length === 0 ? (owedHere ? null :
                                    <span className="text-xs text-slate-500 dark:text-slate-400 self-center">
                                        {isRestDay(day) ? '—' : tr("No tasks")}
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

    /**
     * THE DAY VIEW USES ITS WIDTH. One centred column 42rem wide left two
     * thirds of a big screen empty while the list ran on below the fold; the
     * chips now fill as many columns as fit, each at least 18rem (or the whole
     * width when narrower), so a phone still reads one column.
     */
    const DAY_GRID = 'grid gap-1.5 grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))]';

    function renderDayList(days: CalendarDay[], attachRef: boolean) {
        const day = days[0];
        const owedHere = day?.date === today && lateCount > 0;
        const heading = 'text-sm font-semibold mb-1.5';
        if (owedHere) {
            // The day's own plan FIRST. Twenty-four late cards above it pushed
            // "Planned for today" below the fold at 1280 and off a phone; the
            // late list the learner pressed is brought to them instead.
            return (
                <div ref={attachRef ? bodyRef : undefined} className="h-full overflow-y-auto px-3 sm:px-4 py-3 space-y-4">
                    {(day?.tasks.length ?? 0) > 0 && (
                        <section data-day-planned>
                            <h3 className={`${heading} text-slate-600 dark:text-slate-300`}>{tr("Planned for today")}</h3>
                            <div data-day-list className={DAY_GRID}>
                                {day!.tasks.map(task => chip(task, false, undefined, true))}
                            </div>
                        </section>
                    )}
                    {LATE_KINDS.map(kind => late[kind].length > 0 && (
                        <section key={kind} data-late-list={kind}>
                            <h3 tabIndex={-1} className={`${heading} outline-none ${kind === 'overdue' ? 'text-red-700 dark:text-red-300' : 'text-accent-fg'}`}>
                                {lateLabel(kind)}
                            </h3>
                            <div data-day-list className={DAY_GRID}>
                                {late[kind].map(t => chip(asChip(t), false, undefined, true))}
                            </div>
                        </section>
                    ))}
                </div>
            );
        }
        return (
            <div ref={attachRef ? bodyRef : undefined} className="h-full overflow-y-auto px-3 sm:px-4 py-3">
                <div data-day-list className={DAY_GRID}>
                    {(day?.tasks.length ?? 0) === 0 ? (
                        <div className="col-span-full text-center text-slate-500 dark:text-slate-400 mt-16">
                            <CalendarDays className="w-10 h-10 mx-auto mb-2 opacity-50" />
                            <p className="text-sm font-medium">{tr("No tasks scheduled")}</p>
                            <p className="text-xs mt-1">
                                {isMobile ? tr("Swipe left or right to browse other days") : tr("Use the arrows to browse other days")}
                            </p>
                        </div>
                    ) : (
                        day?.tasks.map(task => chip(task, false, undefined, true))
                    )}
                </div>
            </div>
        );
    }

    function renderPanel(days: CalendarDay[], attachRef: boolean) {
        if (viewMode === 'month') return renderMonthGrid(days);
        if (viewMode === 'day') return renderDayList(days, attachRef);
        return weekGrid ? renderWeekGrid(days, attachRef) : renderWeekRows(days, attachRef);
    }

    // ---- render -----------------------------------------------------------

    return (
        // `tabIndex={-1}`: the calendar can hold focus (`useCalendarFocusOnOpen`)
        // without becoming a tab stop of its own; no ring, it is not a control.
        // Named, so a screen reader landing on it says where focus went.
        <div ref={setRootEl} tabIndex={-1} role="region" aria-label={tr("Calendar")} className="h-full flex-1 flex flex-col overflow-hidden outline-none">
            <CalendarNav
                narrow={narrow}
                compact={isCompactCalendar(width, rootFontSize)}
                viewMode={viewMode}
                onMode={switchViewMode}
                onPointerPick={() => rootEl?.focus({ preventScroll: true })}
                onPrev={prev}
                onNext={next}
                onToday={goToday}
                title={viewLabel}
                subtitle={subLabel}
                loading={loading}
                /* Said once: on screen, today's group already carries it. */
                overdue={todayInView ? 0 : late.overdue.length}
            />

            {/* The course filter — the library calendar only (in a workspace
                every chip is this project), with two courses or more, and the
                same row in every view and width. */}
            {filterProjects.length > 1 && (
                /* A filter, not the place a course name is read: each pill is
                   capped at 14rem with the whole name in its tooltip (whole names
                   wrapped two rows at 1280 and five on a phone). A narrow
                   calendar gets ONE row that scrolls sideways (~300 of a phone's
                   844px before); a wide one wraps, capped at 22vh. */
                <div role="group" aria-label={tr("Show courses")} data-course-filter
                    className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 border-b border-slate-200 dark:border-slate-700 shrink-0 ${narrow
                        ? 'flex-nowrap overflow-x-auto overscroll-x-contain [scrollbar-width:thin]'
                        : 'flex-wrap max-h-[22vh] overflow-y-auto'}`}>
                    <Chip tone={picked.length === 0 ? 'picked' : 'neutral'} aria-pressed={picked.length === 0}
                        onClick={() => setPicked([])}>
                        {tr("All courses")}
                    </Chip>
                    {filterProjects.map(p => (
                        /* `shrink` only where the row wraps: in a one-row scroller a
                           shrinking pill is squeezed to its dot instead of the row
                           scrolling. The cap holds either way. */
                        <Chip key={p.id} shrink={!narrow} className="max-w-[14rem]" tone={picked.includes(p.id) ? 'picked' : 'neutral'}
                            aria-pressed={picked.includes(p.id)} title={p.name}
                            onClick={() => togglePicked(p.id)}
                            icon={<span className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-white/70" style={{ backgroundColor: p.color }} aria-hidden="true" />}>
                            <span className="min-w-0 truncate">{p.name}</span>
                        </Chip>
                    ))}
                </div>
            )}

            {/* Weekday headers — month only. The week grid carries its own per-column
                headers with dates, so printing these too would duplicate them. */}
            {viewMode === 'month' && (
                <div className="grid grid-cols-7 border-b border-slate-200 dark:border-slate-700 shrink-0 bg-slate-100 dark:bg-slate-900/40">
                    {dayHeaders.map(h => (
                        <div key={h} className="py-1.5 text-center text-xs font-semibold text-slate-600 dark:text-slate-300">
                            {h}
                        </div>
                    ))}
                </div>
            )}

            {/* Vertical overflow SCROLLS; horizontal stays hidden for the swipe.
                A month is six rows with a px floor per cell, and the chrome above
                it (toolbar, legend, weekday header) is sized in `rem` — so at a
                large UI scale the chrome grows, the grid does not shrink, and the
                bottom week would run past an `overflow-hidden` edge with no way to
                reach it. The axis the swipe does not use is given back to the
                reader. */}
            <div ref={carousel.viewportRef} className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto touch-pan-y">
                <div className="flex min-h-full" {...carousel.trackProps}>
                    <div data-panel="prev" className="shrink-0 min-h-full" style={carousel.panelStyle}>{renderPanel(panels.prev, false)}</div>
                    <div data-panel="curr" className="shrink-0 min-h-full" style={carousel.panelStyle}>{renderPanel(panels.curr, true)}</div>
                    <div data-panel="next" className="shrink-0 min-h-full" style={carousel.panelStyle}>{renderPanel(panels.next, false)}</div>
                </div>
            </div>
        </div>
    );
}
