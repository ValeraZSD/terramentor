// "This is wrong": the one control every surface that tests or teaches the
// learner carries, in the same place (the item's top-right corner) and with the
// same look. Quiet at rest — a small flag that does not compete with the
// answer — and there both before an answer (a question with no right option
// must not force a guess that counts) and after one (a key that marked them
// wrong). The press asks in a dialog: a reason, an optional note, and what
// will happen. Afterwards the flag becomes a short "Reported" with Undo, and
// the learner's own card offers its editor.
//
// One endpoint behind it and behind the assistant's prepared report
// (`api.reportItem`); one store, so the item reads as reported everywhere.
//
// A flag in a corner is easy to miss: in the outside review all three
// strangers told "Not quite" about an answer they knew was right found
// nothing on the screen to press. So a wrong verdict also ends with a line,
// "Think the app got this one wrong? Report it" (`ReportLink`), and "Report it"
// opens the SAME flag's dialog: the flag and its line share a `ReportScope`.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Flag } from 'lucide-react';
import Modal from '../Modal';
import Radio from './Radio';
import Checkbox from '../Checkbox';
import { Button, IconButton } from './Button';
import { Field, TextArea } from './Field';
import { cx, FOCUS_RING } from './vocabulary';
import { api } from '../../api';
import { useStore } from '../../store';
import { useItemReports, useReportOn, useScreenItem } from '../../utils/itemReportStore';
import {
    REPORT_NOTE_MAX, REPORT_REASONS, type ItemReport, type ItemReportTarget, type ReportReason, type ReportSurface,
} from '../../utils/itemReports';

/** The reasons, in the learner's words. */
export function reasonLabel(t: (s: string) => string, reason: ReportReason): string {
    switch (reason) {
        case 'wrong': return t('The answer or the content is wrong');
        case 'unclear': return t('It is unclear or ambiguous');
        case 'off_topic': return t('It is not about this topic');
        default: return t('Something else');
    }
}

interface ReportItemProps {
    /** The item's ref (`utils/itemReports.ts`); null renders nothing. */
    itemRef: string | null;
    surface: ReportSurface;
    /** What the screen shows of the learner's answer — told to the assistant, never graded. */
    shown?: { answer?: string; correct?: boolean };
    /** Called once the report is filed (a session may move on) and after Undo. */
    onReported?: (report: ItemReport) => void;
    onUndone?: (report: ItemReport) => void;
    /** Opens the editor for the learner's own card. */
    onEdit?: () => void;
    /** The dialog opened or closed: a timed drill holds its clock while it is up. */
    onOpenChange?: (open: boolean) => void;
    /** The answer is not on the screen yet (a card not flipped, a drill item
     *  not answered): the dialog quotes the prompt only, or a learner who
     *  cancels has been shown the key. */
    hideKey?: boolean;
    /** One card of a scrolling feed: mounting does not tell the assistant
     *  this is the item on screen (every card mounts at once); an answer does. */
    inStream?: boolean;
    /** One row of a results list: told to the assistant, never as the item on screen. */
    listed?: boolean;
    className?: string;
}

/** The flag of a `ReportScope`: its item, and the way to open its dialog. */
interface ScopedFlag { ref: string; open: () => void }
const ScopeFlag = createContext<ScopedFlag | null>(null);
const ScopeRegister = createContext<Dispatch<SetStateAction<ScopedFlag | null>> | null>(null);

/**
 * One item's report controls: its flag and the line under its verdict. The
 * flag inside registers itself; `ReportLink` opens that flag's dialog, so
 * there is one dialog per item whichever of the two is pressed. Wrap one item
 * only (a results list wraps each row).
 */
export function ReportScope({ children }: { children: ReactNode }) {
    const [flag, setFlag] = useState<ScopedFlag | null>(null);
    return (
        <ScopeRegister.Provider value={setFlag}>
            <ScopeFlag.Provider value={flag}>{children}</ScopeFlag.Provider>
        </ScopeRegister.Provider>
    );
}

export default function ReportItem({ itemRef, surface, shown, onReported, onUndone, onEdit, onOpenChange, hideKey, inStream, listed, className }: ReportItemProps) {
    const { t } = useTranslation();
    const report = useItemReports(s => (itemRef ? s.byRef[itemRef] ?? null : null));
    const [open, setOpenState] = useState(false);
    const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
    useScreenItem(itemRef, shown, { inStream, listed, hideKey });
    useEffect(() => { if (itemRef) void useItemReports.getState().load([itemRef]); }, [itemRef]);
    // The line under the verdict opens THIS dialog, through the same setter
    // as the flag, so `onOpenChange` hears it (a timed drill holds its clock).
    const register = useContext(ScopeRegister);
    const openRef = useRef(setOpen);
    useLayoutEffect(() => { openRef.current = setOpen; });
    useLayoutEffect(() => {
        if (!register || !itemRef) return;
        const flag: ScopedFlag = { ref: itemRef, open: () => openRef.current(true) };
        register(flag);
        return () => register(f => (f === flag ? null : f));
    }, [register, itemRef]);
    if (!itemRef) return null;

    return (
        <span className={cx('inline-flex shrink-0 items-center', className)}>
            {report
                ? <ReportedNote report={report} onUndone={onUndone} onEdit={onEdit} />
                : (
                    <IconButton
                        size="sm"
                        variant="quiet"
                        label={t('This is wrong')}
                        icon={<Flag className="h-4 w-4" aria-hidden="true" />}
                        onClick={() => setOpen(true)}
                    />
                )}
            {open && (
                <ReportItemDialog
                    itemRef={itemRef}
                    surface={surface}
                    hideKey={hideKey}
                    onClose={() => setOpen(false)}
                    onReported={r => { setOpen(false); onReported?.(r); }}
                />
            )}
        </span>
    );
}

/** The flag once pressed: what it did, and the way back. Shared with the assistant's proposal. */
export function ReportedNote({ report, onUndone, onEdit, className }: {
    report: ItemReport; onUndone?: (r: ItemReport) => void; onEdit?: () => void; className?: string;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const [busy, setBusy] = useState(false);
    const undo = async () => {
        setBusy(true);
        try {
            const { report: back } = await undoItemReport(report.id);
            useItemReports.getState().setReport(back.ref, null);
            onUndone?.(back);
        } catch {
            addToast('error', t("Couldn't undo the report. Try again."));
        } finally {
            setBusy(false);
        }
    };
    return (
        <span className={cx('inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300', className)} role="status">
            <Flag className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
            <span className="whitespace-nowrap">{t('Reported')}</span>
            {/* Worded, not bare icons: a pencil and a curved arrow beside
                "Reported" were read as decoration by people who had just
                pressed it. */}
            {report.editable && onEdit && (
                <Button size="sm" variant="neutral" className="ml-1" onClick={onEdit}>{t('Edit card')}</Button>
            )}
            <Button size="sm" variant="neutral" className="ml-1" aria-label={t('Undo report')} busy={busy} onClick={undo}>{t('Undo')}</Button>
        </span>
    );
}

/**
 * The line under a wrong verdict: "Think the app got this one wrong? Report it".
 * "Report it" opens the dialog of the flag in the same `ReportScope`; with no
 * flag there it draws nothing, so it can never file a report of its own. Once
 * the item stands reported it is the reported line, in the same type. The
 * surface decides WHEN: an answer the learner gave, marked wrong.
 */
export function ReportLink({ className }: { className?: string }) {
    const { t } = useTranslation();
    const flag = useContext(ScopeFlag);
    const report = useReportOn(flag?.ref ?? null);
    if (!flag) return null;
    const line = cx('text-sm text-slate-600 dark:text-slate-400', className);
    if (report) return <p className={line}>{reportedLine(t, report)}</p>;
    return (
        <p className={line}>
            {t("Think the app got this one wrong?")}{' '}
            {/* A link in a sentence: the sentence's type; the padding only
                takes the hit area to 24px without moving the line. */}
            <button
                type="button"
                data-link="report"
                onClick={flag.open}
                className={cx('-my-0.5 inline-block rounded py-0.5 font-medium text-accent-fg underline underline-offset-2 can-hover:hover:decoration-2', FOCUS_RING)}
            >
                {t("Report it")}
            </button>
        </p>
    );
}

/** The one client call that undoes a report — the flag and the assistant's proposal both use it. */
export const undoItemReport = (id: number) => api.undoItemReport(id);

/** What a report does to this item, in one line: in the dialog before it is
 *  filed, and in a sitting where the item's answer would have been. */
export function reportedLine(t: (s: string) => string, target: Pick<ItemReportTarget, 'kind' | 'editable'> | null): string {
    if (!target) return t("It won't count for or against you, and you can undo this.");
    if (target.kind === 'card') {
        return target.editable
            ? t("Your card is set aside until you edit it. Its ratings won't count. You can undo this.")
            : t("The card is removed and its ratings won't count. You can undo this.");
    }
    if (target.kind === 'lesson' || target.kind === 'paper') return t('It is taken off your feed. You can undo this.');
    return t("It won't count for or against you, and it won't be asked again. You can undo this.");
}

function ReportItemDialog({ itemRef, surface, hideKey, onClose, onReported }: {
    itemRef: string; surface: ReportSurface; hideKey?: boolean; onClose: () => void; onReported: (r: ItemReport) => void;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const group = useId();
    const [target, setTarget] = useState<ItemReportTarget | null>(null);
    const [reason, setReason] = useState<ReportReason>('wrong');
    const [note, setNote] = useState('');
    const [rewrite, setRewrite] = useState(true);
    const [busy, setBusy] = useState(false);
    // Said inside the dialog: a toast sits under a dialog opened over the
    // mastery check or a drill, and the typed note must survive a failed send.
    const [failed, setFailed] = useState<'none' | 'unknown' | null>(null);

    useEffect(() => {
        let live = true;
        api.itemReportTarget(itemRef).then(tg => { if (live) setTarget(tg); }).catch(() => { /* the dialog works without the preview */ });
        return () => { live = false; };
    }, [itemRef]);

    const send = async () => {
        setBusy(true);
        setFailed(null);
        try {
            const { report } = await api.reportItem({ ref: itemRef, reason, note: note.trim() || null, surface });
            let filed = report;
            // Only where the server offered it: with AI off a new question
            // or card cannot be written, and the box was not shown.
            if (rewrite && target?.canRewrite && report.canRewrite && !report.rewrite) {
                try { filed = (await api.rewriteItemReport(report.id)).report; }
                catch { addToast('error', t("Reported, but a new one couldn't be started.")); }
            }
            useItemReports.getState().setReport(filed.ref, filed);
            onReported(filed);
        } catch {
            // The answer may be what was lost, with the report filed: asked,
            // a saved report reads as filed; nothing saved means nothing
            // changed; no answer at all means it is not known which.
            const saved = await api.itemReportTarget(itemRef).then(tg => tg.report, () => undefined);
            if (saved && !saved.undoneAt) {
                useItemReports.getState().setReport(saved.ref, saved);
                onReported(saved);
                return;
            }
            setFailed(saved === undefined ? 'unknown' : 'none');
            setBusy(false);
        }
    };

    return (
        <Modal isOpen onClose={onClose} title={t('This is wrong')} maxWidth="max-w-md" layer="z-[65]">
            <div className="space-y-4">
                {target?.item && <ItemQuote item={target.item} kind={target.kind} hideKey={hideKey} />}
                <fieldset>
                    <legend className="mb-2 text-sm font-medium text-slate-900 dark:text-white">{t("What's wrong with it?")}</legend>
                    <div className="space-y-1">
                        {REPORT_REASONS.map(r => (
                            <label key={r} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-slate-50 dark:hover:bg-slate-700/50">
                                <Radio name={`report-reason-${group}`} value={r} checked={reason === r} onChange={() => setReason(r)} />
                                <span className="text-sm text-slate-800 dark:text-slate-100">{reasonLabel(t, r)}</span>
                            </label>
                        ))}
                    </div>
                </fieldset>
                <Field label={t('What is right? (optional)')}>
                    {id => (
                        <TextArea
                            id={id}
                            rows={3}
                            value={note}
                            maxLength={REPORT_NOTE_MAX}
                            onChange={e => setNote(e.target.value)}
                        />
                    )}
                </Field>
                {target?.canRewrite && (
                    <label className="flex cursor-pointer items-center gap-3 text-sm text-slate-800 dark:text-slate-100">
                        <Checkbox checked={rewrite} onChange={setRewrite} />
                        {t('Write a new one to replace it')}
                    </label>
                )}
                <p className="text-sm text-slate-600 dark:text-slate-400">{reportedLine(t, target)}</p>
                {failed && (
                    <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                        {failed === 'none'
                            ? t("Couldn't send the report. Nothing was changed.")
                            : t("Couldn't tell whether the report was sent. Sending it again will not file it twice.")}
                    </p>
                )}
                <div className="flex items-center justify-end gap-3 pt-1">
                    <Button variant="quiet" onClick={onClose}>{t('Cancel')}</Button>
                    <Button variant="primary" busy={busy} onClick={send}>{t('Report')}</Button>
                </div>
            </div>
        </Modal>
    );
}

/** The item as the app holds it, a few lines, so the learner sees what they are reporting. */
export function ItemQuote({ item, kind, hideKey = false }: { item: Record<string, unknown>; kind: string; hideKey?: boolean }) {
    const text = (k: string) => (typeof item[k] === 'string' ? (item[k] as string) : '');
    const lines = kind === 'card' ? [text('front'), hideKey ? '' : text('back')]
        : kind === 'drill' ? [text('prompt'), hideKey ? '' : text('answer')]
        : kind === 'lesson' ? [text('text')]
        : kind === 'paper' ? [text('brief')]
        : [text('question')];
    const shown = lines.filter(Boolean).map(l => l.replace(/```[\s\S]*?```/g, '…').replace(/\s+/g, ' ').trim());
    if (!shown.length) return null;
    return (
        <blockquote className="rounded-lg border-l-4 border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-600 dark:bg-slate-900/40 dark:text-slate-200">
            {shown.map((l, i) => <p key={i} className="line-clamp-3 break-words">{l}</p>)}
        </blockquote>
    );
}
