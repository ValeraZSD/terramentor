import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarPlus, Check, Edit2, X } from 'lucide-react';
import { useStore } from '../../store';
import { Project, ScheduleOverviewRow } from '../../types';
import { parseDate, todayStr } from '../../utils/tree';
import { VerdictPill, verdictLine } from '../plan/verdict';
import { dateRangeLabel, pretty } from '../../utils/locale';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { Button, IconButton } from '../ui/Button';

/**
 * A project's dates on its Projects card: when it runs, whether it is on pace,
 * and the control that changes both. This was the `/schedule` screen, a second
 * grid of the same projects with the same counts; the one thing it had that the
 * Projects card did not is this strip, so the strip moved and the screen went.
 *
 * **The dates are the control.** Pressing the strip turns that same strip into
 * the editor (two date fields, cancel, apply) in the same place, so nothing
 * crosses the card; the card grows only by what the editor adds (its row of
 * buttons, the reversed-dates sentence). Applying a window also RESCHEDULES the open topics,
 * with no confirm dialog: a typed date behind an explicit tick cannot happen by
 * accident, and the tick's label names the count. Cancel and Escape write
 * nothing. Topics outside the window are REPORTED as drift, and the report
 * opens the editor, where the tick brings them back in line. The editor also
 * holds Remove schedule (the card owns its confirm), so the three things one
 * does to dates (set, change, remove) start from one press.
 *
 * The pill is the date's verdict against the learner's own pace (`judgeDate`,
 * on each row of `GET /api/schedule/overview`), the same one the plan panel and
 * the course header show. Until that row arrives, or if it fails, the strip
 * still prints the project's own dates and simply has no pill: a missing
 * verdict is said by saying nothing.
 */

/** "Aug 7 – Dec 17, 2026": one year when both ends share it (`formatRange`). */
const range = (from: string, to: string) => dateRangeLabel(parseDate(from), parseDate(to));

export default function ProjectDates({ project, row, isDeck, editing, onEditingChange, onSaved, onRemove, className = '' }: {
    project: Project;
    /** The project's row of the schedule overview; undefined until it loads. */
    row: ScheduleOverviewRow | undefined;
    /** Measured in cards: no topic dates to move (`allocateCardWindow`). */
    isDeck: boolean;
    /** Held by the CARD, which also owns removing the schedule (its menu has
     *  the same item, behind the same confirm). */
    editing: boolean;
    onEditingChange: (editing: boolean) => void;
    /** Remove schedule, offered in the editor while there is a window. */
    onRemove?: () => void;
    /** After a write that went through. A reschedule inside an UNCHANGED window
     *  changes no field of the project, so the grid, which re-reads the overview
     *  when a project's fields change, would keep a drift line just answered. */
    onSaved?: () => void;
    /** Spacing from the card, applied only when there is something to show. */
    className?: string;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const updateProject = useStore(s => s.updateProject);
    const scheduleProject = useStore(s => s.scheduleProject);
    const setEditing = onEditingChange;
    const [saving, setSaving] = useState(false);
    // The editor replaces the strip, so closing it (cancel, save, Escape,
    // Remove schedule) would drop focus on the page body: it goes back to the
    // strip instead, the element that opened it. Only on a close, never on mount.
    const stripRef = useRef<HTMLButtonElement>(null);
    const wasEditing = useRef(editing);
    useEffect(() => {
        if (wasEditing.current && !editing) stripRef.current?.focus();
        wasEditing.current = editing;
    }, [editing]);

    const status = project.status ?? 'active';
    const start = project.start_date;
    const end = project.deadline;
    const hasWindow = !!(start && end);
    // An archived project is off the plan, and a finished one with no dates
    // never needs any: neither offers "Set dates".
    if (status === 'archived' || (status === 'completed' && !hasWindow)) return null;

    const done = status === 'completed';
    const today = todayStr();
    // Until the overview arrives (or if it failed), the project's own counts
    // stand in: reading "no open topics" there sent a save down the plain
    // window write, and the open topics silently kept their old dates.
    const openLeaves = row
        ? row.openLeaves
        : Math.max(0, (project.topic_count ?? 0) - (project.completed_topic_count ?? 0));

    /** The date judged against the learner's own pace (`judgeDate`): the same
     *  verdict as the plan panel and the course header. "Done" says nothing a
     *  finished course needs, so it shows no pill. A verdict judged on another
     *  date (the overview not yet re-read after a move) is not shown beside
     *  the new one. */
    const verdict = hasWindow && !done && row?.verdict && row.verdict.band !== 'done'
        && row.verdict.deadline === end ? row.verdict : null;
    const line = verdict ? verdictLine(verdict, t, num) : null;
    // The project record first: it is re-read on every write, the overview row
    // only after it.
    const locked = !!(project.deadline_fixed ?? row?.deadline_fixed);

    /** Topics outside the window, in EITHER direction: moving a project forward
     *  strands its topics behind it, moving it back strands them ahead. */
    const drift = (() => {
        const a = row?.firstScheduledStart, b = row?.lastScheduledEnd;
        if (!a || !b || !start || !end || done) return null;
        return a < start || b > end ? { from: a, to: b } : null;
    })();

    /**
     * The ONE write path. Applying a window RESCHEDULES the open topics across it
     * (keeping their dates would produce the drift the card warns about), so an
     * unchanged window is still a write when there are open topics: that is how
     * the drift report's "Reschedule them" works. A refused write keeps the
     * editor open with what was typed; the store has already said why.
     */
    const commit = async (next: { start: string; end: string }) => {
        if (next.start === start && next.end === end && openLeaves === 0) { setEditing(false); return; }
        setSaving(true);
        try {
            let ok: boolean;
            if (openLeaves > 0) {
                let studyDays: number[] = [1, 2, 3, 4, 5];
                try { studyDays = JSON.parse(project.study_days || '[1,2,3,4,5]'); } catch { /* default */ }
                ok = await scheduleProject(project.id, { startDate: next.start, deadline: next.end, studyDays });
            } else {
                ok = await updateProject(project.id, { start_date: next.start, deadline: next.end });
            }
            if (ok) { setEditing(false); onSaved?.(); }
        } finally {
            setSaving(false);
        }
    };

    return (
        // The card opens the project on a press anywhere else; nothing pressed
        // or typed in here may reach it.
        <div className={`flex flex-col gap-2 ${className}`} onClick={e => e.stopPropagation()}>
            {/* ABOVE the strip, so every strip in a row of cards sits on the
                same line (directly over the footer) whether or not its card
                has something to report. */}
            {drift && !editing && (
                <button
                    type="button"
                    data-link="drift"
                    onClick={() => setEditing(true)}
                    title={t("Its topics are planned from {{from}} to {{to}}.", { from: pretty(drift.from), to: pretty(drift.to) })}
                    className="relative flex items-start gap-1.5 text-start text-sm text-amber-700 dark:text-amber-400 can-hover:hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
                >
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                        {t("Some topics are planned outside these dates.")}
                        {' '}<span className="font-medium underline underline-offset-2">{t("Reschedule them")}</span>
                        <span className="sr-only"> {t("Its topics are planned from {{from}} to {{to}}.", { from: pretty(drift.from), to: pretty(drift.to) })}</span>
                    </span>
                </button>
            )}

            {editing ? (
                // A first window starts today and asks for the end: the
                // deadline is the one date only the learner knows, and a
                // made-up month-long plan was one careless tick away.
                <DateEditor
                    start={start || today}
                    end={end || ''}
                    openLeaves={isDeck ? 0 : openLeaves}
                    deadlineLocked={locked}
                    busy={saving}
                    onCancel={() => setEditing(false)}
                    onSave={commit}
                    onRemove={hasWindow && !locked ? onRemove : undefined}
                />
            ) : (
                <button
                    ref={stripRef}
                    type="button"
                    data-strip="dates"
                    onClick={() => setEditing(true)}
                    // The name is the action AND what the strip shows: an
                    // aria-label would replace the range and the pace with the
                    // verb alone, so the verb rides in front as hidden text
                    // and the visible text stays part of the name.
                    aria-label={hasWindow ? undefined : t("Set dates for {{name}}", { name: project.name })}
                    // No dates yet is an EMPTY SLOT, dashed and unfilled: a row of
                    // undated courses read as a wall of grey bars, each as loud as
                    // a real plan. Same box, same height, so setting dates moves
                    // nothing.
                    // `relative`: its `sr-only` name stays inside the grid's scroller.
                    className={`group relative flex items-center gap-2 w-full min-h-10 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors touch:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${hasWindow
                        ? 'border border-transparent bg-slate-100 dark:bg-slate-700/60 text-slate-700 dark:text-slate-200 can-hover:hover:bg-slate-200 dark:can-hover:hover:bg-slate-700'
                        : 'border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700/60'}`}
                >
                    {/* The pencil says "press to change": a filled strip of dates
                        read as a label, and nobody found the editor behind it. */}
                    {hasWindow
                        ? <Edit2 size={15} className="shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                        : <CalendarPlus size={15} className="shrink-0 text-accent-fg" aria-hidden="true" />}
                    {hasWindow && <span className="sr-only">{t("Change the dates for {{name}}", { name: project.name })}: </span>}
                    <span className="min-w-0 flex-1 text-start tabular-nums">
                        {hasWindow ? range(start!, end!) : t("Set dates")}
                    </span>
                    {verdict && <VerdictPill verdict={verdict} t={t} />}
                </button>
            )}
            {/* Under the strip, so every strip in a row of cards still sits on
                one line; it says what the pill is based on. */}
            {line && !editing && (
                <p data-verdict-line className="text-xs text-slate-500 dark:text-slate-400">{line}</p>
            )}
        </div>
    );
}

/**
 * The dates, editable, where the strip was: ONE TWO-COLUMN GRID, the same on
 * every card. The fields on top; under the start, Remove schedule; under the
 * deadline, cancel and apply, splitting that column. Every edge in the second
 * row is an edge of the first and every control is the fields' height: a row
 * of buttons that started and stopped a few pixels off the fields above read
 * as a mistake. A reversed pair adds a sentence below.
 *
 * A native date field clips its own year below ~108px and says nothing about
 * it (`scrollWidth` never exceeds `clientWidth` on one); the grid's floor
 * (ProjectsGrid) keeps each column well above that.
 *
 * Writes nothing itself: it hands a window up. `end` may not precede `start`:
 * `min`/`max` say so and the state checks again, since `min` is advisory in
 * some browsers.
 */
function DateEditor({
    start, end, openLeaves, deadlineLocked = false, busy, onCancel, onSave, onRemove,
}: {
    start: string;
    end: string;
    openLeaves: number;
    /** An exam date marked "cannot move": shown, never edited here (the plan panel takes the mark off). */
    deadlineLocked?: boolean;
    busy: boolean;
    onCancel: () => void;
    onSave: (next: { start: string; end: string }) => void;
    /** Only when there is a window to remove. */
    onRemove?: () => void;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const [from, setFrom] = useState(start);
    const [typedTo, setTo] = useState(end);
    // A locked date is the saved one, whatever was typed before the lock
    // arrived (another device): sending the typed one would be refused.
    const to = deadlineLocked ? end : typedTo;
    const firstField = useRef<HTMLInputElement>(null);
    const endField = useRef<HTMLInputElement>(null);
    const reversedId = useId();
    const lockedId = useId();

    // The editor replaces the button that opened it, so focus must follow: to
    // the start, or to the deadline when that is the date still to choose.
    useEffect(() => { (end ? firstField : endField).current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // A half-typed date is a normal state, so the pair is judged here, not
    // repaired per keystroke: saveable only when both exist and run forwards.
    const reversed = !!from && !!to && from > to;
    const saveable = !!from && !!to && !reversed;
    // The sentence waits for a whole year: one typed digit by digit passes
    // through 0002, 0020 and 0202, each "before the start", and an alert shown
    // per keystroke flickered and was announced again on every digit. Not "on
    // blur": a phone's date picker hands the value back without leaving the
    // field. The red edge and the greyed tick still follow every keystroke.
    const sayReversed = reversed && from.slice(0, 4) >= '1000' && to.slice(0, 4) >= '1000';

    const field = 'w-full h-10 px-2 rounded-lg border '
        + 'bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-white tabular-nums '
        + 'touch:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
    // Each field's name sits IN its top border (the outlined-field pattern),
    // on the card's own colour so it cuts the line: two bare date boxes left
    // every stranger guessing which was the deadline, and a caption row above
    // them would make the editor taller than the strip it replaces.
    const box = 'relative min-w-0';
    const name = 'pointer-events-none absolute -top-1.5 start-2 z-10 px-1 text-xs leading-none '
        + 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400';
    const ok = 'border-slate-300 dark:border-slate-600';
    const bad = 'border-red-400 dark:border-red-500';

    return (
        <div className="flex flex-col gap-1.5">
            <div
                className="grid grid-cols-2 items-start gap-2"
                onKeyDown={e => {
                    // While a save is in flight Escape is swallowed, not obeyed:
                    // closing then would let the write land behind a closed editor.
                    if (e.key === 'Escape') { e.stopPropagation(); if (!busy) onCancel(); }
                    // Enter in a FIELD saves. On the buttons Enter is their own
                    // press: on Cancel it saved and rescheduled, the one thing
                    // Cancel promises not to do.
                    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && !busy && saveable) {
                        e.preventDefault();
                        onSave({ start: from, end: to });
                    }
                }}
            >
                {/* WHATEVER IS TYPED IS KEPT, including nothing. A date field is typed
                    a segment at a time, so intermediates are empty or out of range.
                    Not `if (v)`: React then restores the last good date and eats the
                    keystroke. Not a clamp (`v < from ? from : v`): it snaps a deadline
                    being typed onto the start date. `min`/`max` only grey the picker
                    and mark the field invalid. */}
                <label className={box}>
                    {/* "Start Date", the noun: "Start" is translated as the verb
                        in most locales ("Начать", "Iniciar"). */}
                    <span className={name}>{t("Start Date")}</span>
                    <input
                        ref={firstField}
                        type="date"
                        value={from}
                        max={to || undefined}
                        aria-invalid={reversed || undefined}
                        aria-describedby={sayReversed ? reversedId : undefined}
                        onChange={e => setFrom(e.target.value)}
                        className={`${field} ${reversed ? bad : ok}`}
                    />
                </label>
                <label className={box}>
                    <span className={name}>{t("Deadline")}</span>
                    <input
                        ref={endField}
                        type="date"
                        value={to}
                        min={from || undefined}
                        readOnly={deadlineLocked}
                        aria-invalid={reversed || undefined}
                        aria-describedby={sayReversed ? reversedId : deadlineLocked ? lockedId : undefined}
                        onChange={e => setTo(e.target.value)}
                        className={`${field} ${reversed ? bad : ok}`}
                    />
                </label>
                {/* Remove schedule is the third thing one does to dates, so it
                    sits with the editor's own buttons, not in the card's Study
                    corner, so Study never hides while dates are open. It fills
                    the start column, under the field, away from the tick it
                    must not be mistaken for. With no dates there is nothing to
                    remove and the cell stays empty, so cancel and apply never
                    move. No icon: with one, the English label wrapped to two
                    lines in a ~150px column. `wrap`: a longer translation
                    takes a second line rather than spilling out of it. */}
                {onRemove ? (
                    <Button
                        variant="danger"
                        block
                        wrap
                        disabled={busy}
                        onClick={onRemove}
                    >
                        {t("Remove schedule")}
                    </Button>
                ) : deadlineLocked ? (
                    // Said on the card, not in a tooltip a phone never shows:
                    // why the date will not change and why Remove is gone.
                    <p id={lockedId} className="self-center text-xs text-slate-500 dark:text-slate-400">{t("Exam date, cannot move")}</p>
                ) : <span aria-hidden="true" />}
                {/* Cancel and apply split the deadline column between them,
                    edge to edge, so the second row lines up with the first.
                    Cancel has a border: a borderless box has no edge to align. */}
                <div className="flex gap-2">
                    <IconButton
                        variant="neutral"
                        className="flex-1"
                        label={t("Cancel")}
                        icon={<X size={16} aria-hidden="true" />}
                        disabled={busy}
                        onClick={onCancel}
                    />
                    {/* The label is the disclosure: it names how many open topics the
                        tick reschedules, for the tooltip and the screen reader alike. */}
                    <IconButton
                        variant="primary"
                        className="flex-1"
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
            </div>
            {/* A red edge and a greyed tick said "wrong" without saying what;
                the sentence appears only while it is true. */}
            {sayReversed && (
                <p id={reversedId} role="alert" className="text-sm text-red-700 dark:text-red-400">
                    {t("The deadline is before the start.")}
                </p>
            )}
        </div>
    );
}
