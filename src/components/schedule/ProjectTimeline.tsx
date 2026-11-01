import { ReactNode, RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Clock, Flag, Play, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import { buildGanttData, parseDate, todayStr } from '../../utils/tree';
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
import { FOCUS_RING } from '../ui/vocabulary';

/**
 * One project's plan as a ROUTE: every topic is a stop on one line from the
 * start to the deadline flag, in course order. Two marks sit on it — the
 * learner ("You are here", the first stop not done) and where the plan stands
 * today ("Plan for today") — and the line between them is red: how far behind,
 * in stops one can count. An experiment (01 Nov 2026): the gantt rows before it
 * read as a wall of bars the learner had to decode.
 *
 *  - STOPS ARE EVENLY SPACED. Time is not the axis; order is. A topic's dates
 *    are in its tooltip, its row on a narrow screen and its detail panel.
 *  - WIDE: the line snakes across the width in rows joined by U-turns, each
 *    phase named above where it starts. NARROW: it runs down the screen like a
 *    stop list, with names on every stop and phases that fold.
 *  - CONTAINER WIDTH, NEVER THE VIEWPORT: the detail panel opens beside it.
 *  - Clicking a stop selects it (the detail panel holds its date fields).
 */

/** At or under this many stops, every phase opens in the narrow list. */
const SMALL_PLAN_STOPS = 12;

/** What a stop SHOWS: its state, except in a finished course, where the plan
 *  is over and an unfinished topic is only that — not "Overdue", not "Now". */
type Shown = TimelineState | 'closed';
const shownState = (row: GanttItem, finished: boolean): Shown =>
    finished && row.state !== 'done' && row.state !== 'skipped' ? 'closed' : row.state;

/** The word a stop's meta line ends with; null = nothing to add. */
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

/** A stop's dot. Done is filled green; late a red ring; ready the accent;
 *  everything still to come a grey ring. */
const DOT: Record<Shown, string> = {
    done: 'bg-emerald-500 border-emerald-500',
    skipped: 'bg-slate-400 border-slate-400 dark:bg-slate-500 dark:border-slate-500',
    ready: 'bg-white dark:bg-slate-800 border-accent',
    late: 'bg-white dark:bg-slate-800 border-red-500 dark:border-red-400',
    now: 'bg-white dark:bg-slate-800 border-slate-500 dark:border-slate-300',
    upcoming: 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-500',
    unscheduled: 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-500',
    closed: 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-500',
};

type LineColour = 'done' | 'behind' | 'ahead';
const STROKE: Record<LineColour, string> = {
    done: 'stroke-emerald-500',
    behind: 'stroke-red-500 dark:stroke-red-400',
    ahead: 'stroke-slate-300 dark:stroke-slate-600',
};
const FILL: Record<LineColour, string> = {
    done: 'bg-emerald-500',
    behind: 'bg-red-500 dark:bg-red-400',
    ahead: 'bg-slate-300 dark:bg-slate-600',
};

type RangeFormat = Intl.DateTimeFormat & { formatRange?: (from: Date, to: Date) => string };
/** One formatter per locale: a plan of 300 stops built 300 on every render. */
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

const isClosed = (s: GanttItem) => s.state === 'done' || s.state === 'skipped';

/** A stretch of the route: one top-level phase and the stops under it, or a
 *  top-level topic standing alone (`phase` null). */
interface Stretch {
    id: number;
    phase: GanttItem | null;
    /** Index of its first stop on the route, and how many. */
    from: number;
    count: number;
}

/**
 * The route, in numbers. `you` is the first stop not done (`stops.length`
 * when every stop is); `plan` is where the plan stands today: the first stop
 * whose window has not ended (null without dates).
 *
 * The line is split into GAPS: gap i runs from stop i−1 to stop i (gap 0 from
 * the start, gap n to the flag). A gap is green up to You, red from You to the
 * plan's mark, grey after. The mark sits in the middle of gap `plan`, so that
 * gap is red above the mark and grey below it.
 *
 * A stop with no dates says nothing about where the plan stands and is passed
 * over. Past the deadline the plan stands at the flag: red runs all the way to
 * it. In a FINISHED course the plan is over and nothing is red.
 */
export function routeOf(items: GanttItem[], today: string, { finished = false, over = false } = {}) {
    const stops = items.filter(i => !i.hasChildren);
    const n = stops.length;
    const firstOpen = stops.findIndex(s => !isClosed(s));
    const you = firstOpen === -1 ? n : firstOpen;
    const dated = stops.some(s => s.scheduledEnd);
    const firstAhead = stops.findIndex(s => !!s.scheduledEnd && s.scheduledEnd >= today);
    const plan = !dated ? null : firstAhead === -1 ? n : firstAhead;
    const behind = stops.filter(s => s.state === 'late' || s.state === 'ready').length;
    const closed = stops.filter(isClosed).length;

    const stretches: Stretch[] = [];
    const phaseById = new Map(items.filter(i => i.hasChildren).map(i => [i.id, i]));
    stops.forEach((s, idx) => {
        const key = s.rootPhaseId ?? s.id;
        const last = stretches[stretches.length - 1];
        if (last && last.id === key && key !== s.id) last.count++;
        else stretches.push({ id: key, phase: key === s.id ? null : phaseById.get(key) ?? null, from: idx, count: 1 });
    });

    const gap = (i: number, part: 'upper' | 'lower'): LineColour => {
        if (you > 0 && i <= you) return 'done';
        if (!finished && plan != null && you < plan && (i < plan || (i === plan && (part === 'upper' || over)))) return 'behind';
        return 'ahead';
    };
    return { stops, n, you, plan, behind, closed, stretches, gap };
}
type Route = ReturnType<typeof routeOf>;

export default function ProjectTimeline() {
    const { t } = useTranslation();
    const tree = useStore(s => s.tree);
    const projects = useStore(s => s.projects);
    const currentProjectId = useStore(s => s.currentProjectId);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const paceData = useStore(s => s.paceData);

    const rootRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(rootRef);
    const rem = useRootFontSize();
    // The snake needs room for a dozen stops a row; below that, the list.
    const wide = width === 0 || width >= 44 * rem;
    // Again on a change of layout: selecting a stop opens the detail panel,
    // which narrows this screen from the snake to the list under the pointer.
    useScrollToSelected(selectedNodeId, scrollRef, [wide]);

    const project = projects.find(p => p.id === currentProjectId);
    const today = todayStr();
    // A project measured in cards stores no topic dates: its stops are the
    // plan's sections (`cardPlan`, served with the pace of the project on screen).
    const cardPlan = paceData?.basis === 'cards' ? paceData.cardPlan ?? null : null;
    // Measured in cards, its stops are not final until its plan has arrived:
    // before that every section reads "not scheduled".
    const cardsOnly = !!project && countsInCards({
        teaches: project.teaches, topics: project.topic_count, cards: project.card_count,
    });
    const rowsFinal = !cardsOnly || cardPlan != null;

    const items = useMemo(
        () => (project?.start_date && project?.deadline ? buildGanttData(tree, cardPlan) : []),
        [tree, project?.start_date, project?.deadline, cardPlan],
    );
    const finished = project?.status === 'completed';
    const over = !!project?.deadline && today > project.deadline;
    const route = useMemo(() => routeOf(items, today, { finished, over }), [items, today, finished, over]);

    // Once per project, the route starts scrolled to You (`useLanding`, run by
    // whichever layout is drawn, once it has drawn its stops).
    const landedFor = useRef<number | null>(null);

    // The root element carries the measured ref in EVERY branch (React keeps
    // the same <div> across them): an empty state without it left
    // `useElementWidth` measuring nothing on a cold load, and the width stayed 0.
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

    const pad = wide ? 'px-6' : 'px-4';
    const showPlan = !finished && route.plan != null && today >= project.start_date && today <= project.deadline;
    const landing: Landing = { box: scrollRef, landedFor, projectId: project.id, ready: rowsFinal, selected: selectedNodeId };

    return (
        <div ref={rootRef} className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-slate-800">
            <PlanSummary project={project} pace={paceData} route={route} cardsOnly={cardsOnly} cardPlan={cardPlan} today={today} pad={pad} wide={wide} />
            {route.n === 0 ? (
                <div className="flex-1 flex items-center justify-center text-slate-500 dark:text-slate-400 p-8">
                    <p>{t("No topics to lay out on this timeline.")}</p>
                </div>
            ) : (
                <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                    {wide && width > 0 ? (
                        <Snake project={project} route={route} rem={rem} finished={finished} showPlan={showPlan} today={today} land={landing} />
                    ) : !wide ? (
                        <StopList project={project} route={route} finished={finished} showPlan={showPlan} today={today} land={landing} />
                    ) : null}
                </div>
            )}
        </div>
    );
}

interface Landing {
    box: RefObject<HTMLDivElement | null>;
    /** The project the route last opened at You; survives a change of layout. */
    landedFor: RefObject<number | null>;
    projectId: number;
    /** False while a deck's stops wait for its card plan. */
    ready: boolean;
    selected: number | null;
}

/**
 * Once per project, scroll the route to You. Run by the layout on screen once
 * it has DRAWN its stops: the snake measures its own width first, and a
 * landing tried before that found no stop and never came back.
 */
function useLanding(land: Landing, route: Route, drawn: boolean) {
    useEffect(() => {
        const box = land.box.current;
        if (!drawn || !land.ready || !box || route.n === 0 || land.landedFor.current === land.projectId) return;
        // A selection made elsewhere, or a route with no stop left: no landing.
        if (land.selected != null || route.you >= route.n) { land.landedFor.current = land.projectId; return; }
        const el = box.querySelector<HTMLElement>(`[data-node-id="${route.stops[route.you].id}"]`);
        if (!el) return;
        land.landedFor.current = land.projectId;
        scrollIntoViewWithin(el, { boundary: box, block: 'center' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [land.projectId, land.ready, route, drawn]);
}

/** The meta line of a stop: its dates and the word for its state. */
function useStopMeta(finished: boolean, today: string) {
    const { t } = useTranslation();
    const year = parseDate(today).getUTCFullYear();
    return (row: GanttItem): { range: string; state: Shown; node: ReactNode } => {
        const state = shownState(row, finished);
        const range = row.scheduledStart && row.scheduledEnd
            ? shortRange(row.scheduledStart, row.scheduledEnd, year)
            : t("not scheduled");
        const word = STATE_WORD[state];
        return {
            range,
            state,
            node: <>{range}{word && <> · <span className={STATE_WORD_CLASS[state]}>{t(word)}</span></>}</>,
        };
    };
}

/** A label printed under the line: where it is centred and how wide it is. */
export interface LineLabel { key: string; x: number; w: number; lines: number }

/**
 * Lanes for the labels under one row of the line (0 = just under it): each
 * takes the first lane where it overlaps no label already placed, so "You are
 * here", "Plan for today", the start date and the deadline never print on top
 * of each other when they fall close together. In order of `labels`, which is
 * also their priority (the first keeps lane 0).
 */
export function stackLabels(labels: LineLabel[], margin: number): Record<string, number> {
    const placed: { from: number; to: number; lane: number; lines: number }[] = [];
    const out: Record<string, number> = {};
    for (const l of labels) {
        const from = l.x - l.w / 2 - margin;
        const to = l.x + l.w / 2 + margin;
        let lane = 0;
        for (; ; lane++) {
            const clash = placed.some(p => p.from < to && from < p.to && p.lane < lane + l.lines && lane < p.lane + p.lines);
            if (!clash) break;
        }
        placed.push({ from, to, lane, lines: l.lines });
        out[l.key] = lane;
    }
    return out;
}

/** About how wide a line of `text-sm` text is: CJK glyphs ~1em, the rest ~0.55em. */
function textWidth(text: string, rem: number): number {
    let em = 0;
    for (const ch of text) em += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 1 : 0.55;
    return em * 0.875 * rem;
}

/**
 * WIDE: the route snakes across the width. Slots are evenly spaced along
 * straight rows — the start, every stop, the flag — and consecutive rows are
 * joined by a half circle on alternating sides. Each gap between two slots is
 * drawn as two halves so the plan's mark can split one.
 *
 * It measures ITS OWN box, inside the scroller: once the route is taller than
 * the view, the scrollbar takes its width out of that box, and a route laid
 * out on the outer width ran under it and scrolled sideways.
 */
function Snake({ project, route, rem, finished, showPlan, today, land }: {
    project: Project; route: Route; rem: number; finished: boolean; showPlan: boolean; today: string; land: Landing;
}) {
    const { t } = useTranslation();
    const selectNode = useStore(s => s.selectNode);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const meta = useStopMeta(finished, today);
    const fmt = useNumberFormat();
    // By stop id, not index: an index outlives a tree that shrank under it.
    const [hover, setHover] = useState<number | null>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(boxRef);
    useLanding(land, route, width > 0);

    const geo = useMemo(() => {
        const rowH = 7 * rem;
        const R = rowH / 2;
        const padX = 1.5 * rem;
        const minStep = 4.5 * rem;
        const usable = Math.max(minStep, width - 2 * padX - 2 * R);
        const slots = route.n + 2;
        // At most 16 a row: on a 2000px screen 26 a row left two thin lines in a
        // screen of empty space.
        const perRow = Math.max(2, Math.min(slots, 16, Math.floor(usable / minStep) + 1));
        const step = usable / (perRow - 1);
        const rows = Math.ceil(slots / perRow);
        // Room above the first row for a stop's tooltip (two lines).
        const top = 4.75 * rem;
        const pos = (k: number) => {
            const r = Math.floor(k / perRow);
            const c = k % perRow;
            const x = padX + R + (r % 2 === 0 ? c : perRow - 1 - c) * step;
            return { x, y: top + r * rowH, r };
        };
        // Gap i joins slot i (the start or stop i−1) to slot i+1.
        const gaps = Array.from({ length: route.n + 1 }, (_, i) => {
            const a = pos(i);
            const b = pos(i + 1);
            if (a.r === b.r) {
                const m = { x: (a.x + b.x) / 2, y: a.y, r: a.r };
                return { i, m, upper: `M${a.x} ${a.y}L${m.x} ${m.y}`, lower: `M${m.x} ${m.y}L${b.x} ${b.y}`, turn: 0 };
            }
            const dir = a.r % 2 === 0 ? 1 : -1;
            const sweep = dir === 1 ? 1 : 0;
            const m = { x: a.x + dir * R, y: a.y + R, r: a.r };
            return {
                i, m, turn: dir,
                upper: `M${a.x} ${a.y}A${R} ${R} 0 0 ${sweep} ${m.x} ${m.y}`,
                lower: `M${m.x} ${m.y}A${R} ${R} 0 0 ${sweep} ${b.x} ${b.y}`,
            };
        });
        return { rowH, R, step, rows, top, pos, gaps };
    }, [route.n, width, rem]);
    const { rows, top, pos, gaps } = geo;

    const start = pos(0);
    const flag = pos(route.n + 1);
    const planMark = showPlan && route.plan != null ? gaps[route.plan] : null;
    const youPos = !finished && route.you < route.n ? pos(route.you + 1) : null;

    // The labels under the line, stacked into lanes per row where they would
    // collide. On a U-turn the plan's label sits inside the bend instead.
    const youText = t("You are here");
    const planText = t("Plan for today");
    // "Start", as the narrow list says it: a bare date by a grey dot was read
    // as anything but the start.
    const startText = `${t("Start")} · ${pretty(project.start_date!)}`;
    const deadlineText = t("Deadline");
    const deadlineDate = pretty(project.deadline!);
    const lineH = 1.3 * rem;
    const under: (LineLabel & { r: number })[] = [];
    if (youPos) under.push({ key: 'you', x: youPos.x, r: youPos.r, w: textWidth(youText, rem) * 1.05, lines: 1 });
    if (planMark && planMark.turn === 0) under.push({ key: 'plan', x: planMark.m.x, r: planMark.m.r, w: textWidth(planText, rem), lines: 1 });
    under.push({ key: 'start', x: start.x, r: start.r, w: textWidth(startText, rem), lines: 1 });
    under.push({ key: 'flag', x: flag.x, r: flag.r, w: Math.max(textWidth(deadlineText, rem) * 1.05, textWidth(deadlineDate, rem)), lines: 2 });
    const lanes: Record<string, number> = {};
    for (let r = 0; r < rows; r++) Object.assign(lanes, stackLabels(under.filter(l => l.r === r), 0.5 * rem));
    const laneTop = (key: string, y: number) => y + 0.9 * rem + (lanes[key] ?? 0) * lineH;
    const lastRowLines = Math.max(0, ...under.filter(l => l.r === rows - 1).map(l => (lanes[l.key] ?? 0) + l.lines));
    const height = top + (rows - 1) * geo.rowH + 1.4 * rem + lastRowLines * lineH;

    // Phase names above the row where each phase starts, as wide as the room
    // to the next name on that row (in the row's reading direction) or to the
    // box's edge. A phase that starts in the last slot or two of a row, with
    // too little room left for its name, is named at its first stop on the
    // next row instead: at the edge it read "Phase 5 — …".
    const phases = route.stretches.filter(s => s.phase);
    const pad = 0.75 * rem;
    const roomAt = (p: { x: number; r: number }, all: { x: number; r: number }[]) => {
        const ltr = p.r % 2 === 0;
        const edge = ltr ? width - (p.x - pad) - 0.5 * rem : p.x + pad - 0.5 * rem;
        const ahead = all.filter(o => o.r === p.r && (ltr ? o.x > p.x : o.x < p.x)).map(o => Math.abs(o.x - p.x) - pad);
        return Math.min(edge, ...ahead);
    };
    const firsts = phases.map(s => pos(s.from + 1));
    const anchors = phases.map((s, idx) => {
        const p = firsts[idx];
        const need = Math.min(textWidth(s.phase!.title, rem) * 1.05, 10 * rem);
        if (roomAt(p, firsts) >= need) return p;
        for (let k = s.from + 1; k < s.from + s.count; k++) {
            const q = pos(k + 1);
            if (q.r > p.r) return q;
        }
        return p;
    });
    const labels = phases.map((s, idx) => {
        const p = anchors[idx];
        const w = Math.min(roomAt(p, anchors), 22 * rem);
        return { s, p, w, total: s.count, closed: route.stops.slice(s.from, s.from + s.count).filter(isClosed).length };
    });

    // The line and the stops change with the route, never with the pointer:
    // a hover redraws the tooltip only.
    const line = useMemo(() => gaps.map(g => (
        <g key={g.i} fill="none" strokeWidth={4} strokeLinecap="round">
            <path d={g.upper} className={STROKE[route.gap(g.i, 'upper')]} />
            <path d={g.lower} className={STROKE[route.gap(g.i, 'lower')]} />
        </g>
    )), [gaps, route]);
    const stops = useMemo(() => route.stops.map((s, idx) => {
        const p = pos(idx + 1);
        const { state, range } = meta(s);
        const you = idx === route.you && !finished;
        const selected = s.id === selectedNodeId;
        const word = STATE_WORD[state];
        const label = [s.title, range, word && t(word), you && t("You are here")].filter(Boolean).join(' · ');
        return (
            <button
                key={s.id}
                type="button"
                data-stop
                data-node-id={s.id}
                data-state={state}
                aria-label={label}
                aria-current={selected || undefined}
                onClick={() => selectNode(s.id)}
                onMouseEnter={() => setHover(s.id)}
                onMouseLeave={() => setHover(h => (h === s.id ? null : h))}
                onFocus={() => setHover(s.id)}
                onBlur={() => setHover(h => (h === s.id ? null : h))}
                className={`absolute w-11 h-11 -translate-x-1/2 -translate-y-1/2 grid place-items-center rounded-full ${FOCUS_RING}`}
                style={{ left: p.x, top: p.y }}
            >
                <span
                    className={`block w-5 h-5 rounded-full border-[3px] ${DOT[state]} ${you || selected ? 'ring-4 ring-accent/50' : ''}`}
                />
            </button>
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [route, pos, finished, selectedNodeId, today, t]);

    const tipIdx = hover != null ? route.stops.findIndex(s => s.id === hover) : -1;
    const tip = tipIdx >= 0 ? route.stops[tipIdx] : null;
    const tipPos = tip ? pos(tipIdx + 1) : null;
    const tipMeta = tip ? meta(tip) : null;

    return (
        <div ref={boxRef}>
            {width > 0 && (
                <div className="relative" style={{ height }}>
                    <svg aria-hidden="true" width={width} height={height} className="absolute inset-0 overflow-visible">
                        {line}
                    </svg>

                    {labels.map(({ s, p, w, total, closed }) => (
                        <div
                            key={s.id}
                            className={`absolute text-sm leading-tight ${p.r % 2 === 0 ? '' : 'text-right'}`}
                            style={{
                                top: p.y - 2.75 * rem,
                                left: p.r % 2 === 0 ? p.x - 0.75 * rem : undefined,
                                right: p.r % 2 === 0 ? undefined : width - p.x - 0.75 * rem,
                                width: w,
                            }}
                        >
                            <span className="block font-semibold text-slate-800 dark:text-slate-100 truncate" title={s.phase!.title}>
                                {s.phase!.title}
                            </span>
                            <span className="block text-slate-500 dark:text-slate-400 truncate">
                                {t("{{done}} of {{n}} done", { n: fmt(total), done: fmt(closed) })}
                            </span>
                        </div>
                    ))}

                    {/* The start: a small grey dot and its date. */}
                    <span aria-hidden="true" className="absolute w-3 h-3 rounded-full bg-slate-400 dark:bg-slate-500 -translate-x-1/2 -translate-y-1/2" style={{ left: start.x, top: start.y }} />
                    <span data-line-label="start" className="absolute text-sm text-slate-500 dark:text-slate-400 -translate-x-1/2 whitespace-nowrap" style={{ left: start.x, top: laneTop('start', start.y) }}>
                        {startText}
                    </span>

                    {stops}

                    {youPos && (
                        <span data-line-label="you" className="absolute -translate-x-1/2 whitespace-nowrap text-sm font-semibold text-accent-fg pointer-events-none" style={{ left: youPos.x, top: laneTop('you', youPos.y) }}>
                            {youText}
                        </span>
                    )}

                    {planMark && (
                        <>
                            <span aria-hidden="true" className="absolute w-3 h-3 rotate-45 bg-slate-800 dark:bg-slate-100 -translate-x-1/2 -translate-y-1/2" style={{ left: planMark.m.x, top: planMark.m.y }} />
                            <span
                                data-line-label="plan"
                                // On a U-turn the label goes INSIDE the bend, towards
                                // the middle of the screen: outside it ran off the edge.
                                className={`absolute whitespace-nowrap text-sm font-medium text-slate-700 dark:text-slate-200 pointer-events-none ${planMark.turn === 0 ? '-translate-x-1/2' : planMark.turn === 1 ? '-translate-x-full -translate-y-1/2 -ml-3' : 'translate-x-3 -translate-y-1/2'}`}
                                style={{ left: planMark.m.x, top: planMark.turn === 0 ? laneTop('plan', planMark.m.y) : planMark.m.y }}
                            >
                                {planText}
                            </span>
                        </>
                    )}

                    {/* The flag: the deadline. */}
                    <span className="absolute text-slate-700 dark:text-slate-200 -translate-x-1/2 -translate-y-full" style={{ left: flag.x, top: flag.y + 0.5 * rem }}>
                        <Flag className="w-6 h-6" aria-hidden="true" />
                    </span>
                    <span data-line-label="flag" className="absolute -translate-x-1/2 whitespace-nowrap text-sm text-center" style={{ left: flag.x, top: laneTop('flag', flag.y) }}>
                        <span className="block font-semibold text-slate-800 dark:text-slate-100">{deadlineText}</span>
                        <span className="block text-slate-500 dark:text-slate-400">{deadlineDate}</span>
                    </span>

                    {tip && tipPos && tipMeta && (
                        <div
                            role="tooltip"
                            className="absolute z-10 pointer-events-none -translate-x-1/2 -translate-y-full rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-2 text-sm shadow-lg w-max max-w-[22rem]"
                            // Always ABOVE the stop: below it covered "You are
                            // here" and the next row's phase names. The first
                            // row starts low enough (`top`) for it to fit.
                            style={{
                                left: Math.min(width - 11.5 * rem, Math.max(11.5 * rem, tipPos.x)),
                                top: tipPos.y - rem,
                            }}
                        >
                            <span className="block font-medium">{tip.title}</span>
                            <span className="block opacity-80">{tipMeta.range}{STATE_WORD[tipMeta.state] && <> · {t(STATE_WORD[tipMeta.state]!)}</>}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * NARROW: the route runs down the screen. Every stop is a row with its name;
 * a phase is a row that folds. The phases holding You and the plan's mark
 * open by default, the rest show one line each.
 */
function StopList({ project, route, finished, showPlan, today, land }: {
    project: Project; route: Route; finished: boolean; showPlan: boolean; today: string; land: Landing;
}) {
    const { t } = useTranslation();
    const selectNode = useStore(s => s.selectNode);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const fmt = useNumberFormat();
    const meta = useStopMeta(finished, today);
    const [overrides, setOverrides] = useState<Record<number, boolean>>({});
    useLanding(land, route, true);

    const holds = (s: Stretch, idx: number | null) => idx != null && idx >= s.from && idx < s.from + s.count;
    const selectedIdx = route.stops.findIndex(s => s.id === selectedNodeId);
    const isOpen = (s: Stretch) => !s.phase || (overrides[s.id] ?? (
        route.n <= SMALL_PLAN_STOPS || holds(s, route.you) || (showPlan && holds(s, route.plan)) || holds(s, selectedIdx)
    ));
    // A click keeps every phase open that is open now: the phase the last
    // selection opened would otherwise shut, and every row below it would
    // move up under the pointer.
    const holdOpen = () => setOverrides(o => {
        const next = { ...o };
        for (const s of route.stretches) if (s.phase && isOpen(s)) next[s.id] = true;
        return next;
    });

    /** One row: the line through the marker column, the marker, the content. */
    const row = (key: string | number, upper: LineColour | null, lower: LineColour | null, marker: ReactNode, content: ReactNode, extra?: Record<string, unknown>) => (
        <li key={key} className="relative grid grid-cols-[3rem_minmax(0,1fr)] min-h-[3.5rem]" {...extra}>
            <div className="relative" aria-hidden="true">
                {upper && <span className={`absolute left-1/2 -translate-x-1/2 top-0 h-1/2 w-1 ${FILL[upper]}`} />}
                {lower && <span className={`absolute left-1/2 -translate-x-1/2 bottom-0 h-1/2 w-1 ${FILL[lower]}`} />}
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center">{marker}</span>
            </div>
            <div className="min-w-0 flex items-center py-2 pr-4">{content}</div>
        </li>
    );

    const planRow = (key: string) => row(
        key,
        route.gap(route.plan!, 'upper'),
        route.gap(route.plan!, 'lower'),
        <span className="block w-3 h-3 rotate-45 bg-slate-800 dark:bg-slate-100" />,
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{t("Plan for today")}</span>,
    );

    const out: ReactNode[] = [];
    out.push(row(
        'start', null, route.gap(0, 'upper'),
        <span className="block w-3 h-3 rounded-full bg-slate-400 dark:bg-slate-500" />,
        <span className="text-sm text-slate-500 dark:text-slate-400">{t("Start")} · {pretty(project.start_date!)}</span>,
    ));

    for (const s of route.stretches) {
        const open = isOpen(s);
        const last = s.from + s.count - 1;
        // The plan's mark just before a phase's first stop is drawn above
        // the phase's row, open or shut; one further in, below it.
        const planBefore = showPlan && route.plan === s.from;
        const planInside = showPlan && route.plan != null && route.plan > s.from && route.plan <= last;
        if (s.phase) {
            if (planBefore) out.push(planRow(`plan-before-${s.id}`));
            const stops = route.stops.slice(s.from, s.from + s.count);
            const closed = stops.filter(isClosed).length;
            const late = finished ? 0 : stops.filter(x => x.state === 'late' || x.state === 'ready').length;
            const square = closed === s.count ? 'bg-emerald-500 border-emerald-500'
                : late > 0 ? 'bg-white dark:bg-slate-800 border-red-500 dark:border-red-400'
                    : 'bg-white dark:bg-slate-800 border-slate-400 dark:border-slate-500';
            out.push(row(
                `p${s.id}`,
                route.gap(s.from, 'lower'),
                open ? route.gap(s.from, 'lower') : planInside ? route.gap(route.plan!, 'upper') : route.gap(last + 1, 'upper'),
                <span className={`block w-4 h-4 rounded-sm border-[3px] ${square}`} />,
                <button
                    type="button"
                    data-row
                    aria-expanded={open}
                    onClick={() => setOverrides(o => ({ ...o, [s.id]: !open }))}
                    className={`w-full min-h-11 flex items-center gap-2 text-left rounded-lg ${FOCUS_RING}`}
                >
                    <span className="min-w-0 flex-1">
                        <span className="block text-base font-semibold text-slate-800 dark:text-slate-100">{s.phase.title}</span>
                        <span className="block text-sm text-slate-500 dark:text-slate-400 tabular-nums">
                            {t("{{done}} of {{n}} done", { n: fmt(stops.length), done: fmt(closed) })}
                            {late > 0 && !finished && <> · <span className="font-medium text-red-600 dark:text-red-400">{t("{{n}} late", { n: fmt(late) })}</span></>}
                        </span>
                    </span>
                    <ChevronRight className={`w-5 h-5 shrink-0 text-slate-500 dark:text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
                </button>,
            ));
        }
        if (!open) {
            if (planInside) out.push(planRow(`plan-in-${s.id}`));
            continue;
        }
        for (let idx = s.from; idx <= last; idx++) {
            if (showPlan && route.plan === idx && !(s.phase && planBefore)) out.push(planRow('plan'));
            const stop = route.stops[idx];
            const { state, node } = meta(stop);
            const you = idx === route.you && !finished;
            const selected = stop.id === selectedNodeId;
            out.push(row(
                stop.id,
                route.gap(idx, 'lower'),
                route.gap(idx + 1, 'upper'),
                <span className={`block w-5 h-5 rounded-full border-[3px] ${DOT[state]} ${you || selected ? 'ring-4 ring-accent/50' : ''}`} />,
                <button
                    type="button"
                    data-row
                    aria-current={selected || undefined}
                    onClick={() => { holdOpen(); selectNode(stop.id); }}
                    className={`w-full min-h-11 text-left rounded-lg ${selected ? 'bg-accent/10' : ''} ${FOCUS_RING}`}
                >
                    <span className="block text-base text-slate-800 dark:text-slate-100">{stop.title}</span>
                    <span className="block text-sm text-slate-500 dark:text-slate-400 tabular-nums">
                        {you && <><span className="font-semibold text-accent-fg">{t("You are here")}</span> · </>}
                        {node}
                    </span>
                </button>,
                { 'data-node-id': stop.id, 'data-state': state },
            ));
        }
    }
    if (showPlan && route.plan === route.n) out.push(planRow('plan-end'));

    out.push(row(
        'flag', route.gap(route.n, 'lower'), null,
        <Flag className="w-5 h-5 text-slate-700 dark:text-slate-200" aria-hidden="true" />,
        <span className="text-sm">
            <span className="font-semibold text-slate-800 dark:text-slate-100">{t("Deadline")}</span>
            <span className="text-slate-500 dark:text-slate-400"> · {pretty(project.deadline!)}</span>
        </span>,
    ));

    return <ul className="py-2">{out}</ul>;
}

/**
 * The plan in words, what is next, and the one action that answers being
 * behind. Counts, never a predicted finishing date. "N topics behind" is the
 * number of red and accent stops on the route below — the same stops, counted.
 */
function PlanSummary({ project, pace, route, cardsOnly, cardPlan, today, pad, wide }: {
    project: Project;
    pace: PaceData | null;
    route: Route;
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
    const studyNode = useStore(s => s.studyNode);
    const [busy, setBusy] = useState(false);

    const start = project.start_date!;
    const deadline = project.deadline!;
    const total = route.n;
    const left = total - route.closed;
    // On a phone the actions are its primary controls: 44px.
    const size = wide ? 'sm' : 'lg';
    const cardsLeft = cardPlan ? cardPlan.reduce((sum, s) => sum + Math.max(0, s.cards - s.seen), 0) : 0;
    // A card plan not loaded yet has no count to give: nothing, not "0 cards".
    const doneFacts = cardsOnly
        ? (cardPlan ? [t("{{n}} cards left", { count: cardsLeft, n: fmt(cardsLeft) })] : [])
        : [t("{{done}} of {{n}} topics done", { count: total, n: fmt(total), done: fmt(route.closed) })];
    const deadlineFact = t("Deadline {{date}}", { date: pretty(deadline) });
    const next = route.you < route.n ? route.stops[route.you] : null;

    let headline: string;
    let tone = 'text-slate-800 dark:text-slate-100';
    let facts: string[];
    let action: ReactNode = null;

    if (project.status === 'completed') {
        headline = t("Finished");
        if (left === 0) tone = 'text-emerald-700 dark:text-emerald-400';
        facts = [t("{{done}} of {{n}} topics done", { count: total, n: fmt(total), done: fmt(route.closed) })];
    } else if (today < start) {
        headline = t("Starts {{date}}", { date: pretty(start) });
        facts = [...doneFacts, deadlineFact];
    } else if (today > deadline) {
        const over = daysBetween(deadline, today);
        headline = t("{{n}} days over", { count: over, n: fmt(over) });
        tone = 'text-red-600 dark:text-red-400';
        facts = [...doneFacts, deadlineFact];
        action = (
            <Button size={size} onClick={() => setShowScheduleModal(true, project.id)}>
                {t("Edit Schedule")}
            </Button>
        );
    } else {
        const daysLeft = daysBetween(today, deadline);
        const daysLeftText = t("{{n}} days left", { count: daysLeft, n: fmt(daysLeft) });
        facts = [...doneFacts, `${deadlineFact} · ${daysLeftText}`];
        if (cardsOnly) {
            // A deck's stops are sections measured in cards: the pace says it.
            const status = pace?.hasSchedule ? pace.paceStatus : undefined;
            const offset = pace?.drift != null && pace.totalDays
                ? Math.round((Math.abs(pace.drift) / 100) * pace.totalDays)
                : pace?.daysBehind ?? 0;
            if (status === 'critical') tone = 'text-red-600 dark:text-red-400';
            headline = status ? paceHeadline(status, offset, t, { terse: true }) : daysLeftText;
        } else if (route.behind > 0) {
            headline = t("{{n}} topics behind the plan", { count: route.behind, n: fmt(route.behind) });
            tone = 'text-red-600 dark:text-red-400';
            action = (
                <Button
                    size={size}
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
        } else {
            headline = t("On plan");
        }
    }

    return (
        <div
            data-plan-summary
            className={`relative z-20 shrink-0 flex ${wide ? 'items-center gap-x-4' : 'flex-col items-stretch gap-y-3'} ${pad} py-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800`}
        >
            <div className="min-w-0 flex-1">
                <p className={`text-lg font-semibold ${tone}`}>{headline}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400 tabular-nums">{facts.join(' · ')}</p>
                {next && project.status !== 'completed' && (
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                        {t("Next up")}: <span className="font-medium text-slate-800 dark:text-slate-100">{next.title}</span>
                    </p>
                )}
            </div>
            {(next && project.status !== 'completed') || action ? (
                // Study is what the learner came for: the one primary, last.
                // Recalibrate only moves dates, so it stays secondary.
                <div className={`flex items-center gap-2 ${wide ? 'shrink-0' : ''}`}>
                    {action}
                    {next && project.status !== 'completed' && (
                        <Button
                            size={size}
                            variant="primary"
                            data-study
                            icon={<Play className="w-4 h-4" aria-hidden="true" />}
                            onClick={() => studyNode(project.id, next.id)}
                        >
                            {t("Study")}
                        </Button>
                    )}
                </div>
            ) : null}
        </div>
    );
}
