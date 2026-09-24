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
    CalendarClock, CalendarPlus, AlertTriangle, Pencil, ArrowRight, X, Check, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../../i18n';

/**
 * The scheduling screen: one card per project, and the dates are changed by
 * pressing the dates.
 *
 * Each card owns its width, so it can be legible: what the project is, when it runs,
 * progress against the plan, what is left. **The dates are a control**: pressing the
 * strip turns that same strip into the editor, so nothing crosses the screen.
 *
 * No cross-project axis: across a multi-year library it shrinks short projects to
 * stubs, and "what overlaps what" is `/calendar`'s question. This screen answers
 * "which is in trouble" with the sort (soonest deadline first) and a pace line.
 *
 * Applying a window also RESCHEDULES the open topics, with no confirm dialog: a typed
 * date behind an explicit tick cannot happen by accident, and the tick's label names
 * the count. Cancel and Escape write nothing. Topics outside a window are REPORTED as
 * drift, and that report opens this editor, where the tick brings them back in line.
 */

const SORTS = [
    { key: 'deadline' as const, label: k("Deadline") },
    { key: 'start' as const, label: k("Start") },
    { key: 'load' as const, label: k("Workload") },
    { key: 'name' as const, label: k("Name") },
];

type SortKey = typeof SORTS[number]['key'];

/**
 * The card grid. `auto-fill` with a floor, never a breakpoint: this screen is also
 * mounted in a ~390px workspace panel on a wide screen, where `md:` says "desktop".
 *
 * The floor is 21.25rem (340px) so THE EDITOR FITS ON ONE LINE in the narrowest card
 * the grid makes. A native date field clips its year below ~106px, which only a
 * screenshot shows (`scrollWidth` never exceeds `clientWidth` on a date input): 340 −
 * 32 padding − 5 borders − two 32px buttons − three 6px gaps leaves 110px a field.
 *
 * `auto-rows-fr` makes every card in a section equally tall (as the Projects grid);
 * with the facts pinned to the bottom (`mt-auto`), a card's extra line grows into
 * space its neighbours also have, and the row stays level.
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
     * Three sections, and a project is in exactly one. Finished work gets its own:
     * the sort orders by what a project asks of you, and a finished one asks
     * nothing (in the grid, a dimmed "19 / 52 topics done" reads as trouble).
     * Being finished outranks having dates.
     */
    const { live, unscheduled, finished } = useMemo(() => {
        const cmp: Record<SortKey, (a: ScheduleOverviewRow, b: ScheduleOverviewRow) => number> = {
            // Soonest deadline first; ties by start, so a later-starting project
            // sits after the long one it overlaps.
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
            // Most recently finished first. The row has no completion date, so the
            // deadline stands in; one without a window sorts last, by name.
            finished: rows.filter(done).sort((a, b) =>
                (b.deadline || '').localeCompare(a.deadline || '') || a.name.localeCompare(b.name)),
        };
    }, [rows, sortKey]);

    /**
     * The ONE write path. Applying a window RESCHEDULES the open topics across it
     * (keeping their dates would produce the drift the card warns about). So an
     * unchanged window is still a write when there are open topics: that is how
     * the drift warning's "Reschedule them" works.
     */
    const commit = async (row: ScheduleOverviewRow, next: { start: string; end: string }) => {
        const unchanged = next.start === row.start_date && next.end === row.deadline;
        if (unchanged && row.openLeaves === 0) { setEditingId(null); return; }

        setSavingId(row.id);
        // Optimistic; `load()` reconciles either way, including on failure.
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

    /** "83 days left" / "12 days over" / "completed". A FINISHED project is never
     *  overdue: its deadline is past because it was met. */
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

    /** Pace in days, the deadline's own unit. `daysBehind` is clamped to ≥ 0
     *  server-side, so the magnitude comes from the raw drift, as in `PaceIndicator`. */
    const paceOf = (row: ScheduleOverviewRow) => {
        const p = row.pace;
        if (!p || p.paceStatus === 'no_schedule' || p.paceStatus === 'no_tasks') return null;
        const days = Math.abs(Math.round(((p.drift || 0) / 100) * (p.totalDays || 0)));
        // A whole sentence per `count` key: word order and plural forms (Russian
        // has one for 2–4) are the translator's and `Intl.PluralRules`'.
        const label = p.paceStatus === 'on_track'
            ? t("On track")
            : p.paceStatus === 'ahead'
                ? t("{{n}} days ahead", { count: days, n: num(days) })
                : t("{{n}} days behind", { count: days, n: num(days) });
        return { ...p, label, tone: PACE_TONE[p.paceStatus] || PACE_TONE.on_track };
    };

    const renderCard = (row: ScheduleOverviewRow) => {
        const { daysLeft, done, overdue } = stateOf(row);
        const drift = driftOf(row);
        const pace = paceOf(row);
        const open = editingId === row.id;
        const hasWindow = !!(row.start_date && row.deadline);
        const doneLeaves = Math.max(0, row.totalLeaves - row.openLeaves);
        // What the project is counted IN, by `ProjectCard`'s rule: a deck in cards
        // met (it has no topics to complete), a taught course with cards in both.
        const cards = row.cardCount || 0;
        const isDeck = (row.teaches === false || row.totalLeaves === 0) && cards > 0;
        const alsoHasCards = !isDeck && cards > 0;
        const cardsMet = t("{{value}} / {{value2}} cards met", { count: cards,
            value: num(row.seenCardCount || 0), value2: num(cards),
        });

        return (
            <article
                key={row.id}
                // The project's colour is a 4px LEFT BORDER (as the feed's
                // `ChapterGroup` / `FeedCardShell`): a border follows the radius,
                // a positioned strip is cut flat by it. Set INLINE because
                // `dark:border-slate-700` and the hover/open states set all four
                // sides and beat any border-left class. Raw `row.color`, not
                // `accentSolidTriplet`, so it matches the pace bar's fill.
                style={{ borderLeftColor: row.color }}
                className={`flex flex-col rounded-xl border border-l-4 bg-white dark:bg-slate-800 overflow-hidden transition-colors ${open
                    ? 'border-accent shadow-md'
                    : 'border-slate-200 dark:border-slate-700 can-hover:hover:border-slate-300 dark:can-hover:hover:border-slate-600'}
                    ${done ? 'opacity-75 can-hover:hover:opacity-100' : ''}`}
            >
                {/* Plain `p-4`: the border sits outside the padding box. */}
                <div className="flex flex-col gap-3 p-4 flex-1">
                    <div className="flex items-start gap-2">
                        <button
                            onClick={() => navigate(`/project/${row.id}/timeline`)}
                            title={t("Open the plan for {{name}}", { name: row.name })}
                            className="group min-w-0 flex-1 text-left text-[15px] font-semibold leading-snug text-slate-900 dark:text-white can-hover:hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded min-h-[2.6rem]"
                        >
                            {/* The arrow is inside the clamp, trailing the last
                                word; as a sibling it adds a third line. */}
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
                        {/* Every screen that names a course offers Study. Icon-only
                            beside the pace chip (the title names the course), with
                            the word in its accessible name, at the touch floor. */}
                        {!done && (
                            <button
                                type="button"
                                onClick={() => navigate(`/project/${row.id}/study`)}
                                aria-label={t("Study {{name}}", { name: row.name })}
                                title={t("Study {{name}}", { name: row.name })}
                                className="shrink-0 flex items-center justify-center w-9 h-9 touch:w-11 touch:h-11 rounded-lg bg-accent text-white can-hover:hover:brightness-95 active:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition"
                            >
                                <Play size={15} aria-hidden="true" />
                            </button>
                        )}
                    </div>

                    {/* Only this strip changes when editing: the editor is the
                        same row at the same height, so nothing below moves. */}
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

                    {/* `mt-auto`: facts on the card's floor, level across the row. */}
                    <p className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600 dark:text-slate-400 tabular-nums">
                        {hasWindow && (
                            <>
                                <span className={overdue ? 'font-semibold text-red-600 dark:text-red-400' : ''}>
                                    {done
                                        ? t("Finished")
                                        : overdue
                                            ? t("{{n}} days over", { count: -daysLeft, n: num(-daysLeft) })
                                            : t("{{n}} days left", { count: daysLeft, n: num(daysLeft) })}
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
                        {/* Its own line (`basis-full`): as a third `·` clause it
                            wraps and leaves the separator dangling. */}
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
                    {/* Counts the live grid only: a finished project is off the plan. */}
                    {live.length > 0 && (
                        <span className="text-sm text-slate-500 dark:text-slate-400 tabular-nums">
                            {live.length === 1
                                ? t("{{n}} project scheduled", { n: num(1) })
                                : t("{{n}} projects scheduled", { count: live.length, n: num(live.length) })}
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
                                {/* The same card, so the same press does the same thing. */}
                                <div className={GRID}>{unscheduled.map(renderCard)}</div>
                            </section>
                        )}

                        {/* Last, under everything that still wants something done. */}
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
 * One bar: the FILL (project colour) is what is done, the NOTCH is where today's
 * plan puts you; the pill above states the gap in days. One bar with a mark asks
 * the reader to compare a position, not two lengths.
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
 * One line at the strip's own height — two equal date fields, then cancel and
 * apply — so nothing below moves and the card does not grow. The fields are
 * `flex-1 min-w-0` to fit any card width; start left, deadline right, as the
 * closed strip prints them, each with an accessible label instead of a caption.
 *
 * Writes nothing itself: it hands a window up. `end` may not precede `start`:
 * `min`/`max` say so and the state checks again, since `min` is advisory in some
 * browsers.
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

    // The editor replaces the button that opened it, so focus must follow.
    useEffect(() => { firstField.current?.focus(); }, []);

    // A half-typed date is a normal state, so the pair is judged here, not
    // repaired per keystroke: saveable only when both exist and run forwards.
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
            {/* WHATEVER IS TYPED IS KEPT, including nothing. A date field is typed
                a segment at a time, so intermediates are empty or out of range.
                Not `if (v)`: React then restores the last good date and eats the
                keystroke. Not a clamp (`v < from ? from : v`): it snaps a deadline
                being typed onto the start date. `min`/`max` only grey the picker
                and mark the field invalid. */}
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
            {/* The label is the disclosure: it names how many open topics the tick
                reschedules, for the tooltip and the screen reader alike. */}
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
