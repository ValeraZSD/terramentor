import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { api } from '../../api';
import { todayStr } from '../../utils/tree';
import { daysBetween, shift, pretty } from '../../utils/scheduleAxis';
import { ScheduleOverviewRow } from '../../types';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { IconButton } from '../ui/Button';
import { Select } from '../ui/Field';
import {
    CalendarClock, CalendarPlus, AlertTriangle, Pencil, ArrowRight, X, Check,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../../i18n';

/**
 * The scheduling screen: one card per project, and the dates are changed by
 * clicking the dates.
 *
 * ## What this replaced, and why
 *
 * Two designs have now failed here, and both failed the same way: they asked
 * the reader to hold a chart in their head.
 *
 * The first was a GANTT YOU DRAGGED — pinned label column, px/day scroller,
 * a Fit/Year/Quarter/Month zoom, bars you grabbed behind a 350ms hold and a
 * 4px slop threshold at a scale where one day was under a pixel.
 *
 * The second — the one this replaces — fixed the geometry and kept the shape:
 * a table of thin rows against one shared, always-fitting axis. The geometry
 * was right and the SCREEN was still wrong, for two reasons.
 *
 *  • It was unreadable. Nine projects spanning May 2026 → Sep 2028 on one axis
 *    means the axis is two and a half years wide, so a one-month project is a
 *    20px stub and a two-year one is a full-width slab. Every row's facts were
 *    11px grey text under a 13px title, and the cross-project comparison that
 *    cost all of it said only "everything overlaps everything", which is true
 *    of every learner with more than two courses and is not an action.
 *  • **Editing crossed the whole window.** The chevron that opened the editor
 *    sat mid-screen at x≈455; the date fields opened at x≈80; Save was pinned
 *    to the far right at x≈1437. Measured at 1500px: ~1350px of
 *    pointer travel, in three directions, to change one date. The unscheduled
 *    list below was worse — the project's name on the left edge, its only
 *    control on the right.
 *
 * ## What this is
 *
 * A grid of cards, one per project, each of which is allowed to be legible
 * because it owns its own width. A card says what the project is, when it
 * runs, how far through it you are against how far the plan says you should
 * be, and what is left. **The dates are a control**, not a caption: it reads
 * as a field, it sits where the information is, and pressing it turns that
 * same strip into the editor. Nothing moves across the screen.
 *
 * The cross-project axis is gone rather than shrunk. What it answered — what
 * overlaps what, on which day — is what `/calendar` is for, and it answers it
 * at a scale where the answer is legible. What a schedule screen is actually
 * asked is "which of these is in trouble", and that is now the sort order
 * (soonest deadline first) plus one pace line per card.
 *
 * ## The two confirm dialogs are gone too
 *
 * A project's window is two dates, but its topics carry their own, and moving
 * the window does not move them — so the write used to ask twice: a confirm to
 * move, then a confirm to spread the topics. That existed because a DRAG could
 * start by accident and could not be taken back; a typed date behind an
 * explicit tick cannot. So applying a window also reschedules the open topics,
 * which is what that second dialog defaulted to, and the tick's own label says
 * how many it will move. Cancel and Escape still write nothing — that was the
 * real rule the "three answers = two questions" fix protected, and it survives.
 * Topics that end up outside a window (a hand-edited node, an older plan) are
 * still REPORTED as drift on the card, and that report is the button back into
 * this editor: open it, press the tick, and the topics come back in line.
 */

const SORTS = [
    { key: 'deadline' as const, label: k("Deadline") },
    { key: 'start' as const, label: k("Start") },
    { key: 'load' as const, label: k("Workload") },
    { key: 'name' as const, label: k("Name") },
];

type SortKey = typeof SORTS[number]['key'];

/**
 * The card grid. `auto-fill` with a floor is the layout rule this screen needs
 * and a breakpoint is not: `/schedule` is a full window at 1500px and a ~390px
 * workspace panel beside the navigation tree on the same machine, where an
 * `md:` query says "desktop" and a fixed three-column grid draws three 120px
 * cards. One column when there is room for one, four when there is room for
 * four, no query and nothing to measure.
 *
 * `items-start` rather than the default stretch: every card's resting content
 * is the same height (the title reserves two lines for exactly this reason), so
 * the only cards that differ are the ones with something extra to say — a drift
 * warning — and those should grow alone. Stretching instead pads the OTHER
 * three cards in the row with an empty strip, which reads as a card that failed
 * to load.
 *
 * The floor is 21.25rem (340px) because THE EDITOR HAS TO FIT ON ONE LINE in
 * the narrowest card the grid can make, and a grid like this really does render
 * cards at its floor (measured: a 1312px window gave 304px cards at a 19rem
 * floor). A native date field clips its own year below ~106px — measured, by
 * photographing one at 96/102/108/114/120px, because `scrollWidth` never
 * exceeds `clientWidth` on a date input and every DOM-level check says it fits
 * while the screenshot shows `07.07.20`. 340px card − 32px padding − 5px
 * borders − two 32px buttons − three 6px gaps leaves 110px a field, with the
 * margin that measurement asks for. Nothing else on the card needs this width;
 * the editor does.
 */
/**
 * `auto-rows-fr` is what makes every card in a section the same height — the
 * device the Projects grid already uses. It was `items-start`, which is exactly
 * as tall as each card's own content and was right while every resting card
 * held the same lines; the moment one card in a row carried a second number
 * (its cards met) the row read as ragged. Equal rows plus a bottom-pinned facts
 * block (`mt-auto`) means the extra line grows DOWNWARD into space its
 * neighbours also have, instead of making one card taller than the rest.
 */
const GRID = 'grid auto-rows-fr gap-3 sm:gap-4 [grid-template-columns:repeat(auto-fill,minmax(21.25rem,1fr))]';

/** One heading for every section below the live grid, so "Not scheduled yet"
 *  and "Finished" read as two of the same thing rather than two decisions. */
const SECTION_HEADING = 'mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400';

/** Pace, as a phrase and a colour. The statuses and thresholds are the
 *  server's (`calculatePace`); the words are built here because server-written
 *  text stays English. */
const PACE_TONE: Record<string, string> = {
    ahead: 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10',
    on_track: 'text-slate-600 dark:text-slate-300 bg-slate-500/10',
    falling_behind: 'text-amber-700 dark:text-amber-300 bg-amber-500/10',
    critical: 'text-red-700 dark:text-red-300 bg-red-500/10',
};

export default function ScheduleBoard() {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const projects = useStore(s => s.projects);
    const updateProject = useStore(s => s.updateProject);
    const scheduleProject = useStore(s => s.scheduleProject);
    const addToast = useStore(s => s.addToast);
    const navigate = useNavigate();

    const [rows, setRows] = useState<ScheduleOverviewRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [sortKey, setSortKey] = useState<SortKey>('deadline');
    const [editingId, setEditingId] = useState<number | null>(null);
    const [savingId, setSavingId] = useState<number | null>(null);

    const today = todayStr();

    const load = useCallback(async () => {
        try {
            const data = await api.getScheduleOverview();
            setRows(data.projects);
        } catch (e: any) {
            addToast('error', t("Could not load the schedule board"), e.message);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addToast]);

    useEffect(() => { void load(); }, [load, projects.length]);

    /**
     * Three sections, and a project is in exactly one of them.
     *
     * Finished work is its own place for the same reason unscheduled work is:
     * the sort at the top of the screen orders projects by what they ask of
     * you this week, and a finished project asks nothing. Sinking it to the
     * end of the live grid (what this did before) still left it in the grid,
     * where a dimmed card with "Finished · 19 / 52 topics done" reads as a
     * project in trouble until you have looked at it twice. A heading says it
     * once.
     *
     * Being finished outranks having dates, so a completed project with no
     * window files under Finished rather than under "Not scheduled yet" —
     * nothing is going to be scheduled there.
     */
    const { live, unscheduled, finished } = useMemo(() => {
        const cmp: Record<SortKey, (a: ScheduleOverviewRow, b: ScheduleOverviewRow) => number> = {
            // Soonest deadline first — the only order that answers "what is
            // about to hurt me". Ties break on start, so a shorter project that
            // starts later sits after the long one it overlaps.
            deadline: (a, b) => a.deadline!.localeCompare(b.deadline!) || a.start_date!.localeCompare(b.start_date!),
            start: (a, b) => a.start_date!.localeCompare(b.start_date!) || a.deadline!.localeCompare(b.deadline!),
            load: (a, b) => b.openLeaves - a.openLeaves,
            name: (a, b) => a.name.localeCompare(b.name),
        };
        const done = (r: ScheduleOverviewRow) => r.status === 'completed';
        const hasWindow = (r: ScheduleOverviewRow) => !!(r.start_date && r.deadline);

        return {
            live: rows.filter(r => hasWindow(r) && !done(r)).sort(cmp[sortKey]),
            unscheduled: rows.filter(r => !hasWindow(r) && !done(r)),
            // Most recently finished first, which is the only thing anyone
            // comes back here to look at. There is no completion date on this
            // row, so the deadline stands in for it; one without a window
            // (finished before it was ever planned) sorts to the end by name.
            finished: rows.filter(done).sort((a, b) =>
                (b.deadline || '').localeCompare(a.deadline || '') || a.name.localeCompare(b.name)),
        };
    }, [rows, sortKey]);

    /**
     * The ONE write path.
     *
     * Applying a window RESCHEDULES the open topics across it — the thing the
     * old two-dialog flow asked about and defaulted to yes. It is not asked any
     * more because there is no longer a question in the editor to ask it with,
     * and because the alternative ("keep the topic dates") produces exactly the
     * drift the card then warns about. What that buys: the drift warning's own
     * "Reschedule them" now works by opening this editor and pressing the tick,
     * with no dates changed at all — which is why an unchanged window is still
     * a write when there are open topics to move.
     */
    const commit = async (row: ScheduleOverviewRow, next: { start: string; end: string }) => {
        const unchanged = next.start === row.start_date && next.end === row.deadline;
        if (unchanged && row.openLeaves === 0) { setEditingId(null); return; }

        setSavingId(row.id);
        // Optimistic: the card shows the new window while the write lands. It
        // is reconciled by `load()` either way, including on failure.
        setRows(rs => rs.map(r => (r.id === row.id ? { ...r, start_date: next.start, deadline: next.end } : r)));
        try {
            if (row.openLeaves > 0) {
                let studyDays: number[] = [1, 2, 3, 4, 5];
                try { studyDays = JSON.parse(row.study_days || '[1,2,3,4,5]'); } catch { /* default */ }
                await scheduleProject(row.id, { startDate: next.start, deadline: next.end, studyDays });
            } else {
                await updateProject(row.id, { start_date: next.start, deadline: next.end });
            }
            setEditingId(null);
        } catch (e: any) {
            addToast('error', t("Could not save the dates"), e.message);
        } finally {
            setSavingId(null);
            await load();
        }
    };

    /** "83 days left" / "12 days over" / "completed". A FINISHED project cannot
     *  be late: its deadline is in the past because it was met, and printing
     *  "60d over" in red against work already closed is the screen telling the
     *  learner off for finishing. */
    const stateOf = (row: ScheduleOverviewRow) => {
        const daysLeft = row.deadline ? daysBetween(today, row.deadline) : 0;
        const done = row.status === 'completed';
        return { daysLeft, done, overdue: daysLeft < 0 && !done };
    };

    /** Topics outside the window, in EITHER direction: moving a project forward
     *  strands its topics behind it, moving it back strands them ahead. */
    const driftOf = (row: ScheduleOverviewRow) => {
        const a = row.firstScheduledStart, b = row.lastScheduledEnd;
        if (!a || !b || !row.start_date || !row.deadline) return null;
        return a < row.start_date || b > row.deadline ? { from: a, to: b } : null;
    };

    /** The one thing the card says about being on schedule. Signed days, not a
     *  percentage: "12 days behind" is the same unit as the deadline above it,
     *  and `daysBehind` is clamped to ≥ 0 server-side so the ahead magnitude is
     *  derived from the raw drift — the same arithmetic `PaceIndicator` does. */
    const paceOf = (row: ScheduleOverviewRow) => {
        const p = row.pace;
        if (!p || p.paceStatus === 'no_schedule' || p.paceStatus === 'no_tasks') return null;
        const days = Math.abs(Math.round(((p.drift || 0) / 100) * (p.totalDays || 0)));
        // A whole sentence per key, never "day" + "s" + "behind": word order and
        // declension are the translator's, and a plural assembled here can only
        // be assembled in English. Two keys rather than i18next's `_one`/`_other`
        // because English loads no resources at all, so the plural suffixes never
        // fire in English and `{{n}} days behind` would render for n = 1.
        const label = p.paceStatus === 'on_track'
            ? t("On track")
            : p.paceStatus === 'ahead'
                ? (days === 1 ? t("{{n}} day ahead", { n: num(days) }) : t("{{n}} days ahead", { n: num(days) }))
                : (days === 1 ? t("{{n}} day behind", { n: num(days) }) : t("{{n}} days behind", { n: num(days) }));
        return { ...p, label, tone: PACE_TONE[p.paceStatus] || PACE_TONE.on_track };
    };

    const renderCard = (row: ScheduleOverviewRow) => {
        const { daysLeft, done, overdue } = stateOf(row);
        const drift = driftOf(row);
        const pace = paceOf(row);
        const open = editingId === row.id;
        const hasWindow = !!(row.start_date && row.deadline);
        const doneLeaves = Math.max(0, row.totalLeaves - row.openLeaves);
        // What this project can be counted IN, by the rule `ProjectCard` uses,
        // so the two screens never describe the same project differently. A
        // collection of cards has nothing that will ever be marked complete —
        // this board said "0 / 1 topic done" about a 300-card deck while the
        // Projects grid said how many were met — and a taught import has both
        // halves, both true, so it prints both.
        const cards = row.cardCount || 0;
        const isDeck = (row.teaches === false || row.totalLeaves === 0) && cards > 0;
        const alsoHasCards = !isDeck && cards > 0;
        const cardsMet = t("{{value}} / {{value2}} cards met", {
            value: num(row.seenCardCount || 0), value2: num(cards),
        });

        return (
            <article
                key={row.id}
                // The project's colour is the card's own LEFT BORDER at 4px
                // against the other three at 1px — the same device, drawn the
                // same way, as the feed's `ChapterGroup` / `FeedCardShell`. A
                // border follows `rounded-xl`, so the colour sweeps around the
                // top-left and bottom-left arcs and thins into the hairline;
                // the absolutely-positioned `inset-y-0 w-1` strip this replaces
                // is a RECTANGLE, so the card's radius cut it off flat where
                // the curve begins. The colour is set INLINE for the same
                // reason it is there: `dark:border-slate-700` (and the hover
                // and open states) set `border-color` on all four sides at a
                // specificity no border-left class can beat, which is what
                // turns the rail grey. Raw `row.color`, deliberately NOT
                // `accentSolidTriplet` as in the feed: the pace bar below is
                // filled with the same value, and a rail clamped for white
                // text would no longer be the same colour as the bar it sits
                // beside.
                style={{ borderLeftColor: row.color }}
                className={`flex flex-col rounded-xl border border-l-4 bg-white dark:bg-slate-800 overflow-hidden transition-colors ${open
                    ? 'border-accent shadow-md'
                    : 'border-slate-200 dark:border-slate-700 can-hover:hover:border-slate-300 dark:can-hover:hover:border-slate-600'}
                    ${done ? 'opacity-75 can-hover:hover:opacity-100' : ''}`}
            >
                {/* `p-4`, not the old `pl-5`: the rail used to overlap the
                    padding box, so the left inset had to carry its 4px itself.
                    A border sits outside it. */}
                <div className="flex flex-col gap-3 p-4 flex-1">
                    <div className="flex items-start gap-2">
                        <button
                            onClick={() => navigate(`/project/${row.id}/timeline`)}
                            title={t("Open the plan for {{name}}", { name: row.name })}
                            className="group min-w-0 flex-1 text-left text-[15px] font-semibold leading-snug text-slate-900 dark:text-white can-hover:hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded min-h-[2.6rem]"
                        >
                            {/* The arrow trails the last WORD, inside the
                                clamp. As a sibling of the span it was a block
                                of its own, so it added a third line to every
                                title — measured 62px where two lines are 41px,
                                which is why a one-line card sat 21px higher
                                than its neighbours. */}
                            <span className="line-clamp-2">
                                {row.name}
                                <ArrowRight className="inline-block ml-1 w-3.5 h-3.5 align-[-0.15em] opacity-0 can-hover:group-hover:opacity-70 transition-opacity" aria-hidden="true" />
                            </span>
                        </button>
                        {hasWindow && (
                            <span
                                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${done
                                    ? 'bg-slate-500/10 text-slate-600 dark:text-slate-300'
                                    : overdue
                                        ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                                        : pace?.tone || PACE_TONE.on_track}`}
                            >
                                {done ? t("Completed") : overdue ? t("Overdue") : pace?.label || t("Not started")}
                            </span>
                        )}
                    </div>

                    {/* Only this strip changes when you edit. The editor is
                        the same row at the same height, so the bar and the
                        facts below it do not move and the card does not grow —
                        which is what makes an open card sit in the grid
                        exactly where the closed one did. */}
                    {open ? (
                        <DateEditor
                            start={row.start_date || today}
                            end={row.deadline || shift(today, 30)}
                            openLeaves={row.openLeaves}
                            busy={savingId === row.id}
                            onCancel={() => setEditingId(null)}
                            onSave={next => commit(row, next)}
                        />
                    ) : (
                        <button
                            onClick={() => setEditingId(row.id)}
                            aria-label={hasWindow
                                ? t("Change the dates for {{name}}", { name: row.name })
                                : t("Set dates for {{name}}", { name: row.name })}
                            className="group flex items-center gap-2 w-full h-10 px-3 rounded-lg text-sm font-medium bg-slate-100 dark:bg-slate-700/60 text-slate-700 dark:text-slate-200 can-hover:hover:bg-slate-200 dark:can-hover:hover:bg-slate-700 transition-colors touch:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            {hasWindow
                                ? <CalendarClock size={15} className="shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                                : <CalendarPlus size={15} className="shrink-0 text-accent-fg" aria-hidden="true" />}
                            <span className="min-w-0 flex-1 truncate text-left tabular-nums">
                                {hasWindow
                                    ? `${pretty(row.start_date!)} → ${pretty(row.deadline!)}`
                                    : t("Set dates")}
                            </span>
                            {hasWindow && (
                                <Pencil size={14} className="shrink-0 text-slate-500 dark:text-slate-400 can-hover:group-hover:text-slate-700 dark:can-hover:group-hover:text-slate-200" aria-hidden="true" />
                            )}
                        </button>
                    )}

                    {hasWindow && <PaceBar row={row} pace={pace} />}

                    {/* `mt-auto`: the facts sit on the FLOOR of the card, so a
                        card with a second number grows down into the height the
                        row already has and the numbers stay on one line across
                        the row. Same device as the Projects card's footer. */}
                    <p className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600 dark:text-slate-400 tabular-nums">
                        {hasWindow && (
                            <>
                                <span className={overdue ? 'font-semibold text-red-600 dark:text-red-400' : ''}>
                                    {done
                                        ? t("Finished")
                                        : overdue
                                            ? (-daysLeft === 1 ? t("{{n}} day over", { n: num(1) }) : t("{{n}} days over", { n: num(-daysLeft) }))
                                            : (daysLeft === 1 ? t("{{n}} day left", { n: num(1) }) : t("{{n}} days left", { n: num(daysLeft) }))}
                                </span>
                                <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">·</span>
                            </>
                        )}
                        <span>
                            {isDeck
                                ? cardsMet
                                : row.totalLeaves === 0
                                    ? t("No topics yet")
                                    : row.totalLeaves === 1
                                        ? t("{{done}} / {{total}} topic done", { done: num(doneLeaves), total: num(1) })
                                        : t("{{done}} / {{total}} topics done", { done: num(doneLeaves), total: num(row.totalLeaves) })}
                        </span>
                        {/* Its OWN line (`basis-full`), not a third clause on
                            this one. Chained after the topics with a `·` it
                            wrapped on most cards anyway, and a wrap leaves the
                            separator dangling at the end of the line above —
                            the dot cannot know it is now the last thing on its
                            row. Stacked, it also reads the way the Projects
                            grid stacks the same two numbers. The card it makes
                            taller no longer makes the row ragged: the grid is
                            `auto-rows-fr` and this line is the last thing in a
                            block pinned to the bottom of the card. */}
                        {alsoHasCards && <span className="basis-full">{cardsMet}</span>}
                    </p>

                    {drift && (
                        <button
                            onClick={() => setEditingId(row.id)}
                            className="flex items-start gap-1.5 text-left text-sm text-amber-700 dark:text-amber-400 can-hover:hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
                        >
                            <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                            <span>
                                {t("Topics run {{from}} → {{to}}, outside this window.", { from: pretty(drift.from), to: pretty(drift.to) })}
                                {' '}<span className="font-medium">{t("Reschedule them")}</span>
                            </span>
                        </button>
                    )}

                </div>
            </article>
        );
    };

    if (loading) {
        return <div className="p-8 text-sm text-slate-500 dark:text-slate-400">{t("Loading the schedule board…")}</div>;
    }

    return (
        <div className="h-full overflow-y-auto">
            <header className="sticky top-0 z-10 px-4 sm:px-6 pt-4 pb-3 bg-slate-50/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-700">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <h1 className="text-lg sm:text-xl font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                        <CalendarClock size={20} className="text-accent-fg" aria-hidden="true" />
                        {t("Schedule")}
                    </h1>
                    {/* The count belongs to the grid under it — the live one.
                        A finished project is not "scheduled" in the sense this
                        sentence is asked: it is not on the plan any more. */}
                    {live.length > 0 && (
                        <span className="text-sm text-slate-500 dark:text-slate-400 tabular-nums">
                            {live.length === 1
                                ? t("{{n}} project scheduled", { n: num(1) })
                                : t("{{n}} projects scheduled", { n: num(live.length) })}
                        </span>
                    )}
                    <label className="ml-auto flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                        <span className="hidden sm:inline">{t("Sort")}</span>
                        <Select
                            size="sm"
                            value={sortKey}
                            onChange={e => setSortKey(e.target.value as SortKey)}
                            className="w-auto"
                            aria-label={t("Sort")}
                        >
                            {SORTS.map(s => <option key={s.key} value={s.key}>{t(s.label)}</option>)}
                        </Select>
                    </label>
                </div>
            </header>

            <div className="px-4 sm:px-6 py-4 sm:py-5 space-y-6">
                {rows.length === 0 ? (
                    <p className="max-w-lg text-sm text-slate-600 dark:text-slate-400">
                        {t("No project has a schedule yet. Give one a start date and a deadline and it will appear here.")}
                    </p>
                ) : (
                    <>
                        {live.length > 0 && <div className={GRID}>{live.map(renderCard)}</div>}

                        {unscheduled.length > 0 && (
                            <section>
                                <h2 className={SECTION_HEADING}>
                                    {t("Not scheduled yet")}
                                </h2>
                                {/* The same card, so the same click does the
                                    same thing. The old screen filed these as a
                                    separate full-width list whose only control
                                    was pinned to the far right of the window. */}
                                <div className={GRID}>{unscheduled.map(renderCard)}</div>
                            </section>
                        )}

                        {/* Last, under everything that still wants something
                            done. The card is unchanged — it is already dimmed
                            and already says "Completed", and this is where you
                            come to read those numbers back. */}
                        {finished.length > 0 && (
                            <section>
                                <h2 className={SECTION_HEADING}>
                                    {t("Finished")}
                                </h2>
                                <div className={GRID}>{finished.map(renderCard)}</div>
                            </section>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/**
 * How far through you are, against how far the plan says you should be.
 *
 * One bar, two readings: the FILL is what is done (the project's own colour,
 * because that is the project's), and the NOTCH is where today's plan puts you.
 * The gap between them is what the pill above says in days. Drawing both as
 * separate bars — which is what the header's `PaceIndicator` does, where there
 * is no room for anything else — makes the reader compare two lengths; one bar
 * with a mark on it makes them compare a position.
 */
function PaceBar({ row, pace }: {
    row: ScheduleOverviewRow;
    pace: { expectedProgress: number; actualProgress: number } | null;
}) {
    const { t } = useTranslation();
    const actual = Math.max(0, Math.min(100, pace?.actualProgress ?? 0));
    const expected = Math.max(0, Math.min(100, pace?.expectedProgress ?? 0));
    return (
        <div
            className="relative h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden"
            role="img"
            aria-label={t("{{actual}}% done; the plan expects {{expected}}%", { actual: Math.round(actual), expected: Math.round(expected) })}
        >
            <div
                className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
                style={{ width: `${actual}%`, background: row.color }}
            />
            {expected > 0 && expected < 100 && (
                <span
                    aria-hidden="true"
                    className="absolute inset-y-0 w-0.5 bg-slate-500 dark:bg-slate-300"
                    style={{ left: `calc(${expected}% - 1px)` }}
                />
            )}
        </div>
    );
}

/**
 * The dates, editable, in the ROW THEY ALREADY OCCUPY.
 *
 * It is one line at the same height as the strip it replaces — two date fields
 * of equal width, then cancel and apply — so the bar and the facts under it do
 * not move and the card does not grow. The version before this one opened a
 * block underneath: labelled fields, a ±1/±7 window nudge, a day count, a
 * tickbox and two text buttons, about 150px tall. Every part of it was
 * defensible on its own and together they pushed the card's own content down
 * the screen to ask four questions where the reader had come to change two
 * dates.
 *
 * The fields are `flex-1 min-w-0` rather than sized, so the row fits the
 * narrowest card the grid can make as well as the widest. Left is the start
 * and right is the deadline, in the order the closed strip prints them; each
 * still carries its own label for a screen reader, which is where a visible
 * caption for a date field was only ever repeating the format.
 *
 * It writes nothing itself: it hands a window up and the caller performs it.
 * `end` can never precede `start` — the fields say so with `min`/`max` and the
 * state says it again, because `min` is advisory in some browsers.
 */
function DateEditor({
    start, end, openLeaves, busy, onCancel, onSave,
}: {
    start: string;
    end: string;
    openLeaves: number;
    busy: boolean;
    onCancel: () => void;
    onSave: (next: { start: string; end: string }) => void;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const [from, setFrom] = useState(start);
    const [to, setTo] = useState(end);
    const firstField = useRef<HTMLInputElement>(null);

    // The editor replaces the control that opened it, so focus has to follow or
    // a keyboard user is left on a button that no longer exists.
    useEffect(() => { firstField.current?.focus(); }, []);

    // A half-typed date is a NORMAL state and both fields must be allowed to
    // hold one — see the two handlers below. So the pair is judged here rather
    // than repaired on every keystroke: a window is saveable only when both
    // dates exist and run forwards.
    const reversed = !!from && !!to && from > to;
    const saveable = !!from && !!to && !reversed;

    const field = 'flex-1 min-w-0 h-10 px-2 rounded-lg border '
        + 'bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-white tabular-nums '
        + 'touch:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
    const ok = 'border-slate-300 dark:border-slate-600';
    const bad = 'border-red-400 dark:border-red-500';

    return (
        <div
            className="flex items-center gap-1.5"
            onKeyDown={e => {
                if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
                if (e.key === 'Enter' && !busy && saveable) { e.preventDefault(); onSave({ start: from, end: to }); }
            }}
        >
            {/* WHATEVER IS TYPED IS KEPT, including nothing.
                A date field is typed one segment at a time, so half of every
                keystroke sequence is an incomplete or out-of-range date — and
                the two guards that used to be here made those unreachable
                states permanent. `if (v)` dropped the empty value a partly
                typed segment produces, so the state never changed, so React
                restored the node to the last good date and the keystroke
                vanished. The clamp (`v < from ? from : v`) then rewrote any
                intermediate that fell outside the other end: typing 01122027
                into the deadline snapped it to the START date on the third
                keystroke and pinned it there for the rest of the sequence,
                and typing into the start field committed years like 0099
                before snapping back. Measured, key by key, with
                `temp/schedule-typing-probe.mjs`.
                `min`/`max` stay: they grey out impossible days in the picker
                and mark the field invalid, neither of which touches the value.
                The ORDER of the pair is judged once, above, not per keystroke. */}
            <input
                ref={firstField}
                type="date"
                value={from}
                max={to || undefined}
                aria-label={t("Start")}
                aria-invalid={reversed || undefined}
                onChange={e => setFrom(e.target.value)}
                className={`${field} ${reversed ? bad : ok}`}
            />
            <input
                type="date"
                value={to}
                min={from || undefined}
                aria-label={t("Deadline")}
                aria-invalid={reversed || undefined}
                onChange={e => setTo(e.target.value)}
                className={`${field} ${reversed ? bad : ok}`}
            />
            <IconButton
                size="sm"
                variant="quiet"
                label={t("Cancel")}
                icon={<X size={16} aria-hidden="true" />}
                disabled={busy}
                onClick={onCancel}
            />
            {/* What the tick DOES is the whole disclosure now that the tickbox
                is gone: it saves the window and spreads the open topics across
                it, which is what the old flow's confirm defaulted to. The count
                is in the label so the tooltip and the screen reader both name
                the work before it happens. */}
            <IconButton
                size="sm"
                variant="primary"
                busy={busy}
                label={openLeaves > 0
                    ? (openLeaves === 1
                        ? t("Save and reschedule {{n}} open topic", { n: num(1) })
                        : t("Save and reschedule {{n}} open topics", { n: num(openLeaves) }))
                    : t("Save")}
                icon={<Check size={16} aria-hidden="true" />}
                disabled={!saveable}
                onClick={() => onSave({ start: from, end: to })}
            />
        </div>
    );
}
