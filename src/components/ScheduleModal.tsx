import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useStore } from '../store';
import { api } from '../api';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useNumberFormat } from '../hooks/useNumberFormat';
import { todayStr } from '../utils/tree';
import { isoDayShort } from '../utils/locale';
import { CONTROL_BASE, CONTROL_VARIANT } from './ui/vocabulary';
import type { PaceData, PaceOffer, PaceVerdict } from '../types';
import { Button, IconButton } from './ui/Button';
import { TextInput } from './ui/Field';
import { DIALOG_BODY, DIALOG_SHELL } from './ui/Dialog';
import Checkbox from './Checkbox';
import PlanStrip from './plan/PlanStrip';
import { VerdictIcon, oneStop, shortDay, verdictHeadline, verdictSentences } from './plan/verdict';

/**
 * The plan of one course: will the date work, what can be done if not, and the
 * date itself. It replaced a dialog that judged the date against the dates it
 * had written itself (so "Recalibrate" turned 75 days behind into 12 ahead with
 * nothing studied) and offered three fixed paces nobody had measured.
 *
 * Everything it says comes from one verdict (`GET /api/projects/:id/pace`,
 * server/paceModel.js): the pace the date needs, the learner's recent pace and
 * their best four weeks. Offers are the server's, in its order; each states
 * what it does before it is pressed. A date marked "Exam date, cannot move" is
 * read-only here and is never offered a move.
 *
 * Writes go through ONE path, `POST /api/projects/:id/schedule` (the store's
 * `scheduleProject`): the dates, the study days and the mark together, and the
 * server lays a course under way out from today.
 */
export default function ScheduleModal() {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const open = useStore(s => s.showScheduleModal);
    const projectId = useStore(s => s.scheduleModalProjectId);
    const setOpen = useStore(s => s.setShowScheduleModal);
    const projects = useStore(s => s.projects);
    const scheduleProject = useStore(s => s.scheduleProject);
    const removeSchedule = useStore(s => s.removeSchedule);
    const showConfirm = useStore(s => s.showConfirm);
    const openPlacement = useStore(s => s.openPlacement);
    const setWorkspaceView = useStore(s => s.setWorkspaceView);
    const project = projects.find(p => p.id === projectId);

    const today = todayStr();
    const [start, setStart] = useState(today);
    const [deadline, setDeadline] = useState('');
    const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
    // The mark as the learner set it, or null while they have not touched it:
    // then it follows the project, and a save does not name it, so a lock set
    // meanwhile (another device) is not undone by a draft that never saw it.
    const [fixedDraft, setFixedDraft] = useState<boolean | null>(null);
    const [pace, setPace] = useState<PaceData | null>(null);
    const [paceFailed, setPaceFailed] = useState(false);
    const [busy, setBusy] = useState<null | 'save' | 'plan' | 'remove'>(null);

    const dialogRef = useRef<HTMLDivElement>(null);
    const deadlineRef = useRef<HTMLInputElement>(null);
    const titleId = useId();
    // The panel is read first and edited second: opening on the start-date
    // field put a caret and a selected "07" in the middle of the verdict.
    const closeRef = useRef<HTMLButtonElement>(null);
    // Started when the dialog exists: opened before its project arrived, the
    // hook found no container and never trapped focus.
    useDialogFocus(open && !!project, dialogRef, { onEscape: () => setOpen(false), initialFocus: closeRef });

    const savedDays = (() => {
        try {
            const d = JSON.parse(project?.study_days || '[1,2,3,4,5]');
            return Array.isArray(d) && d.length ? (d as number[]) : [1, 2, 3, 4, 5];
        } catch { return [1, 2, 3, 4, 5]; }
    })();
    const savedFixed = !!project?.deadline_fixed;
    const fixed = fixedDraft ?? savedFixed;

    // The form is filled when the panel opens for a project, keyed on its id:
    // the projects list is re-read often, and filling on every read reset what
    // was being typed. A project the store does not hold yet (a refetch in
    // flight) fills the form when it arrives (`known`).
    const known = !!project;
    useEffect(() => {
        if (!open || !project) return;
        setStart(project.start_date || today);
        setDeadline(project.deadline || '');
        setDays(savedDays);
        setFixedDraft(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, projectId, known]);

    // One opening of the panel. A write that ends after the panel was closed
    // (or opened on another course) neither refreshes nor closes it.
    const session = useRef(0);
    useEffect(() => { session.current++; }, [open, projectId]);

    // Only the newest request may fill the panel: closing on one course and
    // opening another let the first answer land late under the second name.
    const paceRequest = useRef(0);
    const loadPace = () => {
        if (!projectId) return;
        const n = ++paceRequest.current;
        setPaceFailed(false);
        api.getProjectPace(projectId).then(
            d => { if (paceRequest.current === n) setPace(d); },
            () => { if (paceRequest.current === n) { setPace(null); setPaceFailed(true); } },
        );
    };
    useEffect(() => {
        paceRequest.current++;
        setPace(null);
        setPaceFailed(false);
        if (open) loadPace();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, projectId]);

    if (!open || !project) return null;

    const hasDate = !!(project.start_date && project.deadline);
    const verdict: PaceVerdict | null = hasDate ? pace?.verdict ?? null : null;
    // The date stays where it is while it carries the mark, here as on the
    // server: taking the mark off is what lets it move. While the learner has
    // not touched the mark, a locked date is the saved one, whatever was typed
    // before the lock arrived; untick, type, tick again keeps the typed date
    // (a write that names the mark may move it).
    const deadlineLocked = savedFixed && fixed;
    const end = deadlineLocked && fixedDraft === null ? (project.deadline || '') : deadline;
    const datesEdited = start !== (project.start_date || today) || end !== (project.deadline || '');
    const markEdited = fixed !== savedFixed;
    const dirty = datesEdited || markEdited
        || [...days].sort().join() !== [...savedDays].sort().join();
    // Taking the mark off starts the field from the saved date; ticking it
    // again with that date untouched is no edit at all, so the locked field
    // goes back to following the saved date.
    const toggleMark = (on: boolean) => {
        const saved = project.deadline || '';
        if (!on && deadlineLocked) setDeadline(saved);
        setFixedDraft(on === savedFixed && (!on || deadline === saved) ? null : on);
    };
    const reversed = !!start && !!end && start > end;
    // Seven cells share a phone row: a language whose short day names run
    // past four letters (Polish "niedz") takes the smaller size, all seven at once.
    const dayNames = [1, 2, 3, 4, 5, 6, 7].map(isoDayShort);
    const longDayNames = dayNames.some(n => n.length > 4);
    const canSave = dirty && !!start && !!end && !reversed && days.length > 0 && busy === null;

    async function save() {
        if (!projectId || !canSave) return;
        const s = session.current;
        setBusy('save');
        const ok = await scheduleProject(projectId, {
            startDate: start, deadline: end, studyDays: days,
            ...(fixedDraft !== null ? { deadlineFixed: fixedDraft } : {}),
        });
        setBusy(null);
        if (ok && session.current === s) { setFixedDraft(null); loadPace(); }
    }

    async function planWeekly() {
        if (!projectId || !project?.start_date || !project.deadline) return;
        const s = session.current;
        setBusy('plan');
        const ok = await scheduleProject(projectId, {
            startDate: project.start_date, deadline: project.deadline, studyDays: savedDays,
        });
        setBusy(null);
        if (ok && session.current === s) loadPace();
    }

    async function remove() {
        if (!projectId) return;
        // Before the confirm: the panel may close and reopen while it asks.
        const s = session.current;
        const confirmed = await showConfirm({
            title: t("Remove schedule"),
            message: t("Remove this project's dates? Its topics lose their planned days. Your progress is not affected."),
            confirmLabel: t("Remove schedule"),
            variant: 'warning',
        });
        if (!confirmed || session.current !== s) return;
        setBusy('remove');
        const ok = await removeSchedule(projectId);
        setBusy(null);
        if (ok && session.current === s) setOpen(false);
    }

    const offerRow = (offer: PaceOffer, v: PaceVerdict) => {
        const date = v.deadline ? shortDay(v.deadline, today) : '';
        switch (offer.kind) {
            // A deck has no topics to choose between or to lay out: what it
            // can do is meet new cards, which the sentence above already prices.
            case 'fit_subset':
                if (v.unit === 'cards') return null;
                return {
                    key: offer.kind,
                    // The sentence above says how many fit and by when.
                    title: t("Study only the topics that fit"),
                    body: t("Choose in the outline what to study and skip the rest."),
                    action: t("Choose topics"),
                    run: () => { setWorkspaceView('tree'); setOpen(false); },
                };
            case 'plan_weekly': {
                if (v.unit === 'cards') return null;
                // Its rate is the saved date's: with other dates typed it
                // would price a plan it does not make, and Save lays the
                // topics out over the typed dates anyway.
                // A changed mark alone is saved without laying anything out
                // (the server writes the mark by itself), so "Save and plan"
                // would not plan: the offer returns once the mark is saved.
                if (datesEdited || markEdited) return null;
                // With the study days edited, laying the topics out IS saving
                // them (the one write path), so the button says it saves. A
                // window that starts later is laid out from its start, not
                // from today.
                const from = project.start_date || today;
                return {
                    key: offer.kind,
                    // The weekly amount, the topics left and the date are
                    // each on the panel once already: the strip's line, the
                    // sentences and the headline.
                    title: t("Plan your weeks"),
                    body: from > today
                        ? t("Lays the open topics out on your study days, from {{from}} up to your date.", { from: shortDay(from, today) })
                        : t("Lays the open topics out on your study days, up to your date."),
                    action: dirty ? t("Save and plan") : t("Plan it"),
                    run: dirty ? save : planWeekly,
                    disabled: dirty && !canSave,
                    busy: busy === 'plan' || (dirty && busy === 'save'),
                };
            }
            case 'check_known':
                return {
                    key: offer.kind,
                    title: t("Check what you already know"),
                    // A head start, never a pass: the topic's own check still decides.
                    body: t("Topics you already know get a head start: a short review, then their mastery check."),
                    action: t("Start check"),
                    run: () => { setOpen(false); openPlacement(project.id, project.name); },
                };
            case 'move_date': {
                // The mark as the box shows it, before the verdict is re-read:
                // ticked, the button would focus a field that does not move;
                // unticked, the field is free and the offer is back.
                if (fixed) return null;
                const { recent, best } = v.ranges;
                const span = (r: { from: string; to: string }) => ({ from: shortDay(r.from, today), to: shortDay(r.to, today) });
                return {
                    key: offer.kind,
                    title: t("Move the date"),
                    // The recent range is drawn on the strip above.
                    body: recent
                        // Near the end: under pace, the date can already sit inside it.
                        ? t("Pick a date near the end of the likely-done range, or after it.")
                        : best
                            ? t("At your best pace everything is done between {{from}} and {{to}}.", span(best))
                            : t("Pick a date your pace can reach."),
                    action: t("Change date"),
                    run: () => deadlineRef.current?.focus(),
                };
            }
            // Pausing the other courses needs one plan across the library,
            // which does not exist yet: it is not offered until it does.
            default:
                return null;
        }
    };
    const offers = verdict ? verdict.offers.map(o => offerRow(o, verdict)).filter(o => o != null) : [];

    const label = 'text-sm font-medium text-slate-700 dark:text-slate-300';

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center safe-p-0 bg-black/50"
            onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}
        >
            <div
                ref={dialogRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                data-dialog="plan"
                className={`bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl mx-4 ${DIALOG_SHELL} outline-none`}
            >
                <div className="shrink-0 flex items-start justify-between gap-3 px-6 pt-5 pb-4 border-b border-slate-200 dark:border-slate-700">
                    <div className="min-w-0">
                        <p className="text-xs text-slate-500 dark:text-slate-400">{t("Plan")}</p>
                        {/* Two lines at most: a long course name took three on a
                            phone, a fifth of the screen above a scrolling body. */}
                        <h2 id={titleId} title={project.name} className="text-lg font-semibold text-slate-900 dark:text-white line-clamp-2">{project.name}</h2>
                    </div>
                    <IconButton ref={closeRef} size="sm" onClick={() => setOpen(false)} label={t("Close")} tooltip={false} icon={<X className="w-5 h-5" />} className="-me-1.5" />
                </div>

                <div className={`${DIALOG_BODY} px-6 py-5 space-y-6`}>
                    {hasDate && paceFailed && (
                        // Without this the top of the panel was simply empty.
                        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
                            <span>{t("Could not read your pace.")}</span>
                            <Button size="sm" onClick={loadPace}>{t("Try again")}</Button>
                        </div>
                    )}
                    {verdict && (
                        <section aria-labelledby={`${titleId}-verdict`} className="space-y-2">
                            {/* The headline names the band in words, so no pill
                                above it: "On pace" over "On pace for May 1" said
                                it twice. Its icon keeps the band's colour. */}
                            <h3 id={`${titleId}-verdict`} className="flex items-start gap-2 text-xl font-semibold text-slate-900 dark:text-white">
                                <VerdictIcon verdict={verdict} className="h-[1em] w-[1em] mt-[0.2em]" />
                                <span className="min-w-0">{verdictHeadline(verdict, t, today)}</span>
                            </h3>
                            <p className="text-sm text-slate-600 dark:text-slate-300 max-w-prose">
                                {verdictSentences(verdict, t, num, today).join(' ')}
                            </p>
                        </section>
                    )}
                    {!hasDate && (
                        <p className="text-sm text-slate-600 dark:text-slate-300 max-w-prose">
                            {t("Pick the date you want this course done by. The app then compares it with your own pace.")}
                        </p>
                    )}

                    {verdict && <PlanStrip verdict={verdict} week={pace?.weekSoFar} today={today} />}

                    {offers.length > 0 && (
                        <section aria-labelledby={`${titleId}-offers`}>
                            <h3 id={`${titleId}-offers`} className={`${label} mb-2`}>{t("What you can do")}</h3>
                            <ul className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700">
                                {offers.map(o => (
                                    <li key={o.key} data-offer={o.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                                        <div className="min-w-[12rem] flex-1">
                                            <p className="text-sm font-medium text-slate-900 dark:text-white">{o.title}</p>
                                            <p className="text-sm text-slate-500 dark:text-slate-400">{oneStop(o.body)}</p>
                                        </div>
                                        <Button onClick={o.run} disabled={o.disabled || busy !== null} busy={o.busy} className="shrink-0 min-w-[9rem]">
                                            {o.action}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    <section aria-labelledby={`${titleId}-dates`} className="space-y-3">
                        <h3 id={`${titleId}-dates`} className={label}>{t("Dates")}</h3>
                        <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
                            <div>
                                <label htmlFor={`${titleId}-start`} className="block text-xs text-slate-500 dark:text-slate-400 mb-1">{t("Start Date")}</label>
                                {/* Held while a write is in flight: an edit made then
                                    was shown as saved (and locked) when it was not. */}
                                <TextInput id={`${titleId}-start`} type="date" value={start} max={end || undefined}
                                    readOnly={busy !== null}
                                    aria-invalid={reversed || undefined} onChange={e => setStart(e.target.value)} />
                            </div>
                            <div>
                                <label htmlFor={`${titleId}-deadline`} className="block text-xs text-slate-500 dark:text-slate-400 mb-1">{t("Deadline")}</label>
                                <TextInput ref={deadlineRef} id={`${titleId}-deadline`} type="date" value={end} min={start || undefined}
                                    // Read-only, not disabled: a disabled field greys the
                                    // very date the mark protects until it cannot be read.
                                    // A flat grey well, so it does not look like the
                                    // editable field beside it.
                                    readOnly={deadlineLocked || busy !== null} className="read-only:bg-slate-100 dark:read-only:bg-slate-800 read-only:cursor-default"
                                    aria-invalid={reversed || undefined}
                                    aria-describedby={deadlineLocked ? `${titleId}-locked` : undefined}
                                    onChange={e => setDeadline(e.target.value)} />
                            </div>
                        </div>
                        <label className="flex items-start gap-2.5 text-sm text-slate-700 dark:text-slate-200 cursor-pointer">
                            <Checkbox checked={fixed} onChange={toggleMark}disabled={!end || busy !== null} className="mt-0.5" aria-describedby={fixed ? `${titleId}-locked` : undefined} />
                            <span>
                                {t("Exam date, cannot move")}
                                {/* Only while ticked: "untick it" beside an empty box
                                    told the reader to do what was already done.
                                    Hidden from the label's name, read once as the
                                    box's description (a reference reads hidden text). */}
                                {fixed && (
                                    <span id={`${titleId}-locked`} aria-hidden="true" className="block text-xs text-slate-500 dark:text-slate-400">
                                        {t("The app never offers to move it. Untick it to change the date.")}
                                    </span>
                                )}
                            </span>
                        </label>
                        {reversed && (
                            <p role="alert" className="text-sm text-red-700 dark:text-red-400">{t("The deadline is before the start.")}</p>
                        )}
                    </section>

                    <section aria-labelledby={`${titleId}-days`}>
                        <h3 id={`${titleId}-days`} className={`${label} mb-2`}>{t("Study days")}</h3>
                        {/* Seven columns across the full width, edges in line
                            with the date fields above: a wrapping row left
                            Sunday alone on a phone, a short one stopped
                            halfway. A picked day is FILLED, as a picked Chip
                            is; an accent tint read as switched off. */}
                        <div className="grid grid-cols-7 gap-1.5">
                            {dayNames.map((name, i) => {
                                const iso = i + 1;
                                const on = days.includes(iso);
                                return (
                                    <button
                                        key={iso}
                                        type="button"
                                        data-day-toggle
                                        aria-pressed={on}
                                        disabled={busy !== null}
                                        onClick={() => setDays(d => d.includes(iso) ? d.filter(x => x !== iso) : [...d, iso].sort())}
                                        // The ring stands off the button: on a filled
                                        // day an accent ring flush with the accent
                                        // fill read as one bigger button.
                                        className={`${CONTROL_BASE} focus-visible:ring-offset-2 ring-offset-white dark:ring-offset-slate-800 min-w-0 w-full h-10 touch:h-11 px-0 ${longDayNames ? 'text-xs' : 'text-sm'} border ${on
                                            ? 'bg-accent border-accent text-white can-hover:hover:bg-accent/90'
                                            : CONTROL_VARIANT.neutral}`}
                                    >
                                        {name}
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                </div>

                <div className="shrink-0 px-6 py-4 bg-slate-50 dark:bg-slate-700/30 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3">
                    <div>
                        {hasDate && !savedFixed && (
                            <Button variant="quiet" onClick={remove} disabled={busy !== null} busy={busy === 'remove'}>
                                {t("Remove schedule")}
                            </Button>
                        )}
                    </div>
                    <Button variant="primary" onClick={save} disabled={!canSave} busy={busy === 'save'}>
                        {t("Save")}
                    </Button>
                </div>
            </div>
        </div>
    );
}
