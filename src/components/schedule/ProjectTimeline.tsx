import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Clock, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { onActivateKey } from '../../utils/a11y';
import { useStore } from '../../store';
import { branchesAbove, buildGanttData, defaultOpenBranches, parseDate, todayStr } from '../../utils/tree';
import { countsInCards } from '../../utils/projectShape';
import { daysBetween, pretty } from '../../utils/scheduleAxis';
import { dateRangeLabel, uiLocale } from '../../utils/locale';
import { paceHeadline } from '../../utils/pace';
import { CardPlanSection, GanttItem, PaceData, Project, TimelineState } from '../../types';
import { useScrollToSelected } from '../../hooks/useScrollToSelected';
import { scrollIntoViewWithin } from '../../utils/scrollWithin';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { k } from '../../i18n';
import { Button } from '../ui/Button';
import { useFittedAxis, AxisHeader, Lane, FittedAxis } from './laneAxis';

/**
 * One project's plan on a time axis: which topics run when, how much of each
 * is done, and where today and the deadline fall. It answers "am I on plan,
 * and what is in front of me" — the screen it replaced drew a wall of red bars
 * that said only "late", with no way to tell a topic three-quarters done from
 * one never opened.
 *
 * WHAT CARRIES THE SCREEN.
 *
 *  1. A SUMMARY FIRST. One line in words — how far off the plan, done against
 *     planned, what is left, the deadline — and the one action that fixes
 *     being behind (Recalibrate). A finished course, one not started and one
 *     past its deadline each say so instead.
 *  2. A BAR IS PROGRESS. Every bar fills with the share done (green); what is
 *     not done yet takes the row's state colour — red only for the unfinished
 *     part of a window that has ended, and the word "Overdue" beside it. No
 *     row tint, red title or dot on top of that.
 *  3. IT OPENS WHERE YOU ARE. No detail-level switch: the branches holding
 *     the first unfinished topic and today's topics open, the rest stay shut
 *     with their own bar and percentage, and every chevron still works.
 *  4. CONTAINER WIDTH, NEVER THE VIEWPORT. The detail panel opens beside this
 *     screen when a row is clicked; a viewport breakpoint kept the two-column
 *     layout at ~215px and the bars vanished. The layout is chosen from this
 *     element's own width.
 */

/** At or under this many rows, everything opens. */
const SMALL_PLAN_ROWS = 30;

/** What a row SHOWS: its state, except in a finished course, where the plan
 *  is over and an unfinished topic is only that — not "Overdue", not "Now". */
type Shown = TimelineState | 'closed';
const shownState = (row: GanttItem, finished: boolean): Shown =>
    finished && row.state !== 'done' && row.state !== 'skipped' ? 'closed' : row.state;

/** The word a row's meta line ends with; null = nothing to add. */
const STATE_WORD: Record<Shown, string | null> = {
    done: k("Done"),
    skipped: k("Skipped"),
    ready: k("Ready to prove"),
    late: k("Overdue"),
    now: k("Now"),
    upcoming: null,
    unscheduled: null,
    closed: null,
};

const STATE_WORD_CLASS: Record<Shown, string> = {
    done: 'text-emerald-700 dark:text-emerald-400',
    skipped: '',
    ready: 'font-medium text-accent-fg',
    late: 'font-medium text-red-600 dark:text-red-400',
    now: 'font-medium text-slate-800 dark:text-slate-100',
    upcoming: '',
    unscheduled: '',
    closed: '',
};

/** The colour of the part of a bar NOT done yet. The done part is always
 *  green. Ready to prove is late but known: the accent, never the late red. */
const REST_FILL: Record<Shown, string> = {
    done: 'bg-emerald-500',
    skipped: 'bg-slate-300 dark:bg-slate-600',
    ready: 'bg-accent/60',
    late: 'bg-red-400/80 dark:bg-red-500/70',
    now: 'bg-slate-400 dark:bg-slate-400',
    upcoming: 'bg-slate-300 dark:bg-slate-600',
    unscheduled: 'bg-slate-300 dark:bg-slate-600',
    closed: 'bg-slate-300 dark:bg-slate-600',
};

type RangeFormat = Intl.DateTimeFormat & { formatRange?: (from: Date, to: Date) => string };
/** One formatter per locale: a plan of 300 rows built 300 on every render. */
const dayMonthFormats = new Map<string, RangeFormat>();
function dayMonthFormat(locale: string): RangeFormat {
    let f = dayMonthFormats.get(locale);
    if (!f) {
        f = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
        dayMonthFormats.set(locale, f);
    }
    return f;
}

/** A date range as the reader's language writes it, without the year when
 *  both ends are in the current one. */
function shortRange(start: string, end: string, year: number): string {
    const s = parseDate(start);
    const e = parseDate(end);
    if (s.getUTCFullYear() !== year || e.getUTCFullYear() !== year) return dateRangeLabel(s, e);
    const fmt = dayMonthFormat(uiLocale());
    return typeof fmt.formatRange === 'function' ? fmt.formatRange(s, e) : `${fmt.format(s)} – ${fmt.format(e)}`;
}

export default function ProjectTimeline() {
    const { t } = useTranslation();
    const tree = useStore(s => s.tree);
    const projects = useStore(s => s.projects);
    const currentProjectId = useStore(s => s.currentProjectId);
    const selectNode = useStore(s => s.selectNode);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const paceData = useStore(s => s.paceData);
    const fmt = useNumberFormat();

    /** Branches the reader opened or shut by hand, on this screen. */
    const [overrides, setOverrides] = useState<Record<number, boolean>>({});

    const rootRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    useScrollToSelected(selectedNodeId, scrollRef);
    const width = useElementWidth(rootRef);
    const rem = useRootFontSize();

    const project = projects.find(p => p.id === currentProjectId);
    const today = todayStr();
    // A project measured in cards stores no topic dates: its rows are the plan's
    // sections (`cardPlan`, served with the pace of the project on screen).
    const cardPlan = paceData?.basis === 'cards' ? paceData.cardPlan ?? null : null;
    // Measured in cards, its rows are not final until its plan has arrived:
    // before that every section reads "not scheduled" and the first of them
    // looks like the next thing to do.
    const cardsOnly = !!project && countsInCards({
        teaches: project.teaches, topics: project.topic_count, cards: project.card_count,
    });
    const rowsFinal = !cardsOnly || cardPlan != null;

    const items = useMemo(
        () => (project?.start_date && project?.deadline ? buildGanttData(tree, cardPlan) : []),
        [tree, project?.start_date, project?.deadline, cardPlan],
    );

    /** Open by default: everything on a small plan; otherwise the branches
     *  holding the first unfinished topic and today's topics. Not the
     *  selection: a default that followed it shut the last selection's branch
     *  on the next click, and the rows jumped under the pointer. */
    const openByDefault = useMemo<Set<number> | null>(() => defaultOpenBranches(items, SMALL_PLAN_ROWS), [items]);

    // A selection made elsewhere (the detail panel, a link) opens the branches
    // above it, as if by hand, so it stays open when the next row is clicked.
    useEffect(() => {
        if (selectedNodeId == null) return;
        const above = branchesAbove(items, selectedNodeId);
        if (above.length === 0) return;
        setOverrides(o => (above.every(id => o[id] === true) ? o : { ...o, ...Object.fromEntries(above.map(id => [id, true])) }));
    }, [items, selectedNodeId]);

    const isOpen = (item: GanttItem) =>
        overrides[item.id] ?? (openByDefault ? openByDefault.has(item.id) : true);

    const visibleItems = useMemo<GanttItem[]>(() => {
        const result: GanttItem[] = [];
        const skipDepths: number[] = [];
        for (const item of items) {
            while (skipDepths.length > 0 && item.depth <= skipDepths[skipDepths.length - 1]) {
                skipDepths.pop();
            }
            if (skipDepths.length > 0) continue;
            result.push(item);
            if (item.hasChildren && !isOpen(item)) skipDepths.push(item.depth);
        }
        return result;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, overrides, openByDefault]);

    /** The project's own window belongs on the axis even where no topic reaches
     *  it, or a plan whose topics stop in March draws as if it ended in March. */
    const spans = useMemo(
        () => [
            [project?.start_date, project?.deadline],
            ...items.map(i => [i.scheduledStart, i.scheduledEnd]),
        ],
        [project?.start_date, project?.deadline, items],
    );
    const geom = useFittedAxis(spans, today, project?.deadline ?? null);

    /** Once per project, the list starts at the first topic not yet done, with
     *  one row above it for context — not at the finished work above it. On
     *  a course in its third month that was ten "Done" rows before anything
     *  the learner could act on. A selection is useScrollToSelected's to place;
     *  a finished course has no next topic and opens at its top. Waits for the
     *  measured width, which decides every row's height, and for the rows to
     *  be final (a card plan's sections, `rowsFinal`). */
    const landedFor = useRef<number | null>(null);
    useEffect(() => {
        const list = scrollRef.current;
        if (!project || !list || width === 0 || visibleItems.length === 0 || !rowsFinal) return;
        if (landedFor.current === project.id) return;
        landedFor.current = project.id;
        if (selectedNodeId != null || project.status === 'completed') return;
        const first = visibleItems.find(i => !i.hasChildren && i.state !== 'done' && i.state !== 'skipped');
        const row = first ? list.querySelector<HTMLElement>(`li[data-node-id="${first.id}"]`) : null;
        if (!row) return;
        const header = list.querySelector<HTMLElement>('[data-axis-header]');
        const above = row.previousElementSibling as HTMLElement | null;
        scrollIntoViewWithin(row, {
            boundary: list,
            block: 'start',
            padding: (header?.offsetHeight ?? 0) + (above?.offsetHeight ?? 0),
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project?.id, width, visibleItems, rowsFinal]);

    // The root element carries the measured ref in EVERY branch (React keeps
    // the same <div> across them): an empty state without it left
    // `useElementWidth` measuring nothing on a cold load, before the projects
    // had arrived, and the width stayed 0 for good.
    if (!project?.start_date || !project?.deadline) {
        return (
            <div ref={rootRef} className="flex-1 flex items-center justify-center text-slate-500 dark:text-slate-400">
                <div className="text-center">
                    <Clock className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p className="text-lg font-medium">{t("No schedule set")}</p>
                    <p className="text-sm mt-1">{t("Set a schedule to lay this project out on a timeline")}</p>
                </div>
            </div>
        );
    }

    // Two columns while the label column and a usable lane both fit; below
    // that the lane goes under its title. Width 0 = not measured yet.
    const wide = width === 0 || width >= 36 * rem;
    // Capped at 28rem: on a 2000px monitor 22rem cut long titles off beside
    // a lane with room to spare.
    const labelW = Math.round(Math.min(28 * rem, Math.max(13 * rem, width * 0.34)));
    const columns = wide ? { gridTemplateColumns: `${labelW}px minmax(0, 1fr)` } : undefined;
    const pad = wide ? 'px-4' : 'px-3';
    const thisYear = parseDate(today).getUTCFullYear();
    const finished = project.status === 'completed';

    const renderRow = (row: GanttItem) => {
        const open = isOpen(row);
        const selected = row.id === selectedNodeId;
        const dated = !!(row.scheduledStart && row.scheduledEnd);
        const range = dated
            ? shortRange(row.scheduledStart!, row.scheduledEnd!, thisYear)
            : t("not scheduled");
        const state = shownState(row, finished);
        const word = STATE_WORD[state];
        // A share is news for open work in or past its window, or begun early.
        // Not "0%" beside Ready to prove (known from a head start, not from
        // work done here), nor on a finished course's untouched rows.
        const showPct = state !== 'done' && state !== 'skipped' && state !== 'unscheduled'
            && (row.done > 0 || state === 'now' || state === 'late');
        const indent = { paddingLeft: `${Math.min(row.depth, 5) * (wide ? 1 : 0.75)}rem` };

        const label = (
            <div className="min-w-0 flex items-center gap-1" style={indent}>
                {row.hasChildren ? (
                    <button
                        type="button"
                        data-row-fold
                        onClick={() => setOverrides(o => ({ ...o, [row.id]: !open }))}
                        aria-expanded={open}
                        aria-label={open ? t("Collapse {{title}}", { title: row.title }) : t("Expand {{title}}", { title: row.title })}
                        className="shrink-0 grid place-items-center w-6 h-6 rounded hover:bg-slate-200 dark:hover:bg-slate-600"
                    >
                        <ChevronRight className={`w-4 h-4 transition-transform text-slate-500 dark:text-slate-400 ${open ? 'rotate-90' : ''}`} />
                    </button>
                ) : (
                    <span className="w-6 shrink-0" />
                )}
                <div
                    className="min-w-0 flex-1 cursor-pointer rounded"
                    onClick={() => selectNode(row.id)}
                    onKeyDown={onActivateKey(() => selectNode(row.id))}
                    role="button"
                    tabIndex={0}
                    aria-current={selected || undefined}
                >
                    <span
                        title={row.title}
                        className={`block truncate text-sm text-slate-800 dark:text-slate-100 ${row.hasChildren ? 'font-semibold' : ''}`}
                    >
                        {row.title}
                    </span>
                    {/* The dates in words, the share done and the state — the
                        bar can only ever say roughly. */}
                    <span className="block truncate text-xs leading-tight text-slate-500 dark:text-slate-400 tabular-nums">
                        {range}
                        {showPct && <> · {fmt(Math.round(row.done * 100))}%</>}
                        {word && <> · <span className={STATE_WORD_CLASS[state]}>{t(word)}</span></>}
                    </span>
                </div>
            </div>
        );

        const lane = (
            <Lane geom={geom} className={wide ? 'self-stretch' : 'h-4 mt-1'}>
                {dated && <Bar row={row} state={state} geom={geom} title={`${row.title} · ${range}`} />}
            </Lane>
        );

        return (
            <li
                key={row.id}
                data-node-id={row.id}
                data-state={state}
                className={`${wide ? 'grid gap-x-3' : 'py-1.5'} ${pad} ${selected
                    ? 'bg-accent/10'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/30'}`}
                style={columns}
            >
                {wide ? <div className="py-1.5 min-w-0">{label}</div> : label}
                {lane}
            </li>
        );
    };

    return (
        <div ref={rootRef} className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-slate-800">
            <PlanSummary project={project} pace={paceData} items={items} cardsOnly={cardsOnly} cardPlan={cardPlan} today={today} pad={pad} wide={wide} />

            {visibleItems.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-slate-500 dark:text-slate-400 p-8">
                    <p>{t("No topics to lay out on this timeline.")}</p>
                </div>
            ) : (
                // Scroll padding the height of the sticky axis header (in rem,
                // so it follows ui_scale): a row reached by Tab is scrolled
                // to below the header, not under it.
                <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scroll-pt-16">
                    {/* Sticks 1px above the edge: at 150% scaling a header at
                        exactly 0 left the list's first device row uncovered. */}
                    <div
                        data-axis-header
                        className={`${wide ? 'grid gap-x-3' : ''} ${pad} sticky -top-px z-10 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700`}
                        style={columns}
                    >
                        {wide && <div />}
                        <AxisHeader geom={geom} />
                    </div>
                    <ul className="pb-4">{visibleItems.map(renderRow)}</ul>
                </div>
            )}
        </div>
    );
}

/** A row's bar: the window, green for the share done, the state's colour for
 *  the rest. A section is drawn thicker than a topic. */
function Bar({ row, state, geom, title }: { row: GanttItem; state: Shown; geom: FittedAxis; title: string }) {
    return (
        <div
            aria-hidden="true"
            title={title}
            className={`absolute top-1/2 -translate-y-1/2 ${row.hasChildren ? 'h-3.5' : 'h-2.5'} rounded-full overflow-hidden ${REST_FILL[state]}`}
            style={{
                left: `${geom.pctOf(row.scheduledStart!)}%`,
                width: `${geom.spanPct(row.scheduledStart!, row.scheduledEnd!)}%`,
            }}
        >
            {row.done > 0 && state !== 'done' && (
                <div data-done-fill className="h-full bg-emerald-500" style={{ width: `${row.done * 100}%` }} />
            )}
        </div>
    );
}

/**
 * The plan in one line of words, and the one action that answers it.
 *
 * Counts, never a predicted finishing date: the app does not forecast when a
 * learner will be done, only where the plan puts them today.
 */
function PlanSummary({ project, pace, items, cardsOnly, cardPlan, today, pad, wide }: {
    project: Project;
    pace: PaceData | null;
    items: GanttItem[];
    cardsOnly: boolean;
    cardPlan: CardPlanSection[] | null;
    today: string;
    pad: string;
    wide: boolean;
}) {
    const { t } = useTranslation();
    const fmt = useNumberFormat();
    const recalibrateSchedule = useStore(s => s.recalibrateSchedule);
    const setShowScheduleModal = useStore(s => s.setShowScheduleModal);
    const [busy, setBusy] = useState(false);

    const start = project.start_date!;
    const deadline = project.deadline!;
    const work = items.filter(i => !i.hasChildren);
    const workLeft = work.filter(i => i.state !== 'done' && i.state !== 'skipped').length;
    const cards = cardsOnly;
    const cardsLeft = cardPlan ? cardPlan.reduce((sum, s) => sum + Math.max(0, s.cards - s.seen), 0) : 0;
    // A card plan not loaded yet has no count to give: nothing, not "0 cards".
    const leftFacts = cards
        ? (cardPlan ? [t("{{n}} cards left", { count: cardsLeft, n: fmt(cardsLeft) })] : [])
        : [t("{{n}} topics left", { count: workLeft, n: fmt(workLeft) })];
    const deadlineFact = t("Deadline {{date}}", { date: pretty(deadline) });

    let headline: string;
    let tone = 'text-slate-800 dark:text-slate-100';
    let facts: string[];
    let action: ReactNode = null;

    if (project.status === 'completed') {
        headline = t("Finished");
        const total = work.length;
        const done = total - workLeft;
        // Green only when the work is all done: a course closed with most of
        // it untouched under a green "Finished" read as a contradiction.
        if (workLeft === 0) tone = 'text-emerald-700 dark:text-emerald-400';
        facts = [t("{{done}} of {{n}} topics done", { count: total, n: fmt(total), done: fmt(done) })];
    } else if (today < start) {
        headline = t("Starts {{date}}", { date: pretty(start) });
        facts = [...leftFacts, deadlineFact];
    } else if (today > deadline) {
        const over = daysBetween(deadline, today);
        headline = t("{{n}} days over", { count: over, n: fmt(over) });
        tone = 'text-red-600 dark:text-red-400';
        facts = [...leftFacts, deadlineFact];
        action = (
            <Button size="sm" onClick={() => setShowScheduleModal(true, project.id)}>
                {t("Edit Schedule")}
            </Button>
        );
    } else {
        const status = pace?.hasSchedule ? pace.paceStatus : undefined;
        const offset = pace?.drift != null && pace.totalDays
            ? Math.round((Math.abs(pace.drift) / 100) * pace.totalDays)
            : pace?.daysBehind ?? 0;
        if (status === 'falling_behind') tone = 'text-amber-700 dark:text-amber-400';
        if (status === 'critical') tone = 'text-red-600 dark:text-red-400';
        if (status === 'ahead') tone = 'text-emerald-700 dark:text-emerald-400';
        const daysLeft = daysBetween(today, deadline);
        const daysLeftText = t("{{n}} days left", { count: daysLeft, n: fmt(daysLeft) });
        if (status) {
            headline = paceHeadline(status, offset, t, { terse: true });
            facts = [
                t("{{actual}}% done · {{expected}}% planned by today", {
                    actual: fmt(pace!.actualProgress), expected: fmt(pace!.expectedProgress),
                }),
                ...leftFacts,
                `${deadlineFact} · ${daysLeftText}`,
            ];
        } else {
            // Pace not here yet: say only what is certain. "On track" before
            // the answer flashed over a course that was weeks behind.
            headline = daysLeftText;
            facts = [...leftFacts, deadlineFact];
        }
        // Recalibrating re-spreads what is left over the days that remain; a
        // deck has no topic dates to re-spread.
        if (!cards && (status === 'falling_behind' || status === 'critical')) {
            action = (
                <Button
                    size="sm"
                    busy={busy}
                    icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}
                    onClick={async () => {
                        setBusy(true);
                        try { await recalibrateSchedule(project.id); } finally { setBusy(false); }
                    }}
                >
                    {t("Recalibrate Schedule")}
                </Button>
            );
        }
    }

    // Narrow: the action goes under the words, or it squeezes them into a
    // column three words wide. Opaque and stacked over the list below: at 150%
    // display scaling Chromium paints a scrolled row 1–2px past the list's top
    // edge, which showed as a sliver of text above the sticky axis.
    return (
        <div
            data-plan-summary
            className={`relative z-20 shrink-0 flex ${wide ? 'items-center gap-x-4' : 'flex-col items-start gap-y-2'} ${pad} py-3 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800`}
        >
            <div className="min-w-0 flex-1">
                <p className={`text-base font-semibold ${tone}`}>{headline}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400 tabular-nums">{facts.join(' · ')}</p>
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </div>
    );
}
