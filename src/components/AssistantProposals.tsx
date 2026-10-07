import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AlertTriangle, ArrowDown, ArrowRight, BookmarkPlus, Bug, Check, ExternalLink, Inbox, Layers, Lightbulb, Link2, Loader2,
    MessageSquareWarning, Pencil, Plus, RotateCcw, ShieldCheck,
} from 'lucide-react';
import { FileGlyph } from './attachments/AttachmentChips';
import { api } from '../api';
import { useStore } from '../store';
import Markdown from './Markdown';
import { Button } from './ui/Button';
import ReportProblemDialog from './ReportProblemDialog';
import { ProjectIcon, PROJECT_ICONS } from './ProjectIcon';
import { useLanguages } from './ProjectFormFields';
import {
    similarFront, PROJECT_FIELDS, type CardProposal, type CheckTarget, type CourseDraftProposal, type LinkProposal,
    type ProjectEditProposal, type ProjectField, type ReportProposal, type SaveProposal, type TopicEditProposal,
} from '../utils/assistantWrites';
import { REPORT_FORMS } from '../utils/report';
import { accentSolidTriplet } from '../utils/color';
import { projectColourName } from '../../server/projectFields.js';
import { useCreationRuns } from './creation/creationRuns';
import { useNumberFormat } from '../hooks/useNumberFormat';
import { uiLocale } from '../utils/locale';
import { k } from '../i18n';
import { cx } from './ui/vocabulary';
import { useElementWidth } from '../hooks/useElementWidth';
import { useRootFontSize } from '../hooks/useRootFontSize';
import type { AssistantCheck, AssistantEditKind, ChatAttachment } from '../types';

/**
 * What the assistant PREPARED, drawn under its answer for the learner to press
 * (src/utils/assistantWrites.ts). Nothing here happens on the model's say-so.
 *
 * Every title on these controls came back from the database through
 * /api/nodes/labels; a topic id the model invented resolves to nothing and its
 * proposal is not drawn, the same silence an invented `[[open:…]]` gets.
 */

/** A topic id resolved by the drawer. */
export interface TopicLabel {
    id: number;
    projectId: number;
    title: string;
    projectName: string;
    status?: string;
    projectStatus?: string;
    /** Only a `topic` takes a check; a card hangs on a topic or a deck's stage. */
    kind?: 'topic' | 'section' | 'note' | 'stage';
}

/**
 * What happened to each proposal, for the life of the page. The drawer redraws
 * a turn under a new key when a history reload swaps its provisional id for
 * the stored one; kept in the component, "Added" would turn back into "Add".
 */
const outcomes = new Map<string, { state: 'added' | 'existed' | 'undone' | 'kept' | 'saved' | 'opened'; cardId?: number; nodeId?: number; projectId?: number }>();

/** Open the app's own mastery check on a topic. The gate mode is read on the press. */
export function CheckButtons({ checks, labels }: { checks: CheckTarget[]; labels: Record<number, TopicLabel> }) {
    const { t } = useTranslation();
    const openMasteryGate = useStore(s => s.openMasteryGate);
    // A check is taken on a topic: a section, a note or a deck's stage draws
    // nothing, the same silence an invented id gets.
    const resolved = checks.map(c => labels[c.nodeId]).filter((l): l is TopicLabel => l?.kind === 'topic');
    if (!resolved.length) return null;
    const open = async (l: TopicLabel) => {
        // The learner's own setting, never assumed: an enforced gate that the
        // learner switched to advisory must open as advisory.
        let advisory = true;
        try { advisory = (await api.getSettings()).mastery_gate_mode !== 'enforced'; } catch { /* the default is advisory */ }
        openMasteryGate(l.id, l.title, advisory, l.projectId);
    };
    return (
        <div className="flex flex-col items-start gap-1.5">
            {resolved.map(l => (
                // A topic title can be any length and a phone's drawer is 390px:
                // the label truncates, and the whole of it is the tooltip.
                <Button
                    key={l.id} variant="neutral" className="max-w-full"
                    icon={<ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />}
                    onClick={() => open(l)} title={`${l.title} · ${l.projectName}`}
                >
                    {/* A completed topic's check is a retake: it stays completed whatever the score. */}
                    <span className="min-w-0 truncate">{l.status === 'completed'
                        ? t("Retake the mastery check: {{topic}}", { topic: l.title })
                        : t("Take the mastery check: {{topic}}", { topic: l.title })}</span>
                </Button>
            ))}
        </div>
    );
}

/**
 * What a check said, as one line under a preview. `undefined` is a check still
 * running; a verdict's reason is the server's (English, like its other notes).
 */
function CheckLine({ check, what }: { check: AssistantCheck | null | undefined; what: 'card' | 'link' }) {
    const { t } = useTranslation();
    if (check === null) return null;
    if (check === undefined) {
        return (
            <p className="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                {what === 'card' ? t("Checking the answer…") : t("Opening the page…")}
            </p>
        );
    }
    // Each line says what was TESTED and no more: two answers agreeing is not
    // proof, and a page that opens was not read for what it says.
    if (check.verdict === 'ok') {
        return (
            <p className="inline-flex items-start gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                <Check className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                {what === 'card' ? t("Checked: a second AI, not shown this answer, gave the same one.") : t("Checked: the page opens.")}
            </p>
        );
    }
    if (check.verdict === 'disputed') {
        return (
            <p className="inline-flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                {what === 'card' && check.detail?.answer
                    ? t("Not offered: this answer looks wrong. A second AI, not shown it, answered “{{answer}}”, and when shown both answers it chose that one.", { answer: check.detail.answer })
                    : t("Not offered: {{reason}}.", { reason: check.reason })}
            </p>
        );
    }
    return (
        <p className="inline-flex items-start gap-1.5 text-sm text-slate-500 dark:text-slate-400">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            {t("Not checked: {{reason}}.", { reason: check.reason })}
        </p>
    );
}

/** One request per message for its cards or its links, kept for the page's life. */
const checksByTurn = new Map<string, AssistantCheck[]>();
function useChecks(key: string, ask: () => Promise<AssistantCheck[]>, enabled: boolean): (AssistantCheck | undefined)[] | null {
    const [checks, setChecks] = useState<AssistantCheck[] | null>(() => checksByTurn.get(key) ?? null);
    useEffect(() => {
        if (!enabled || checksByTurn.has(key)) return;
        let live = true;
        ask()
            .then(list => { checksByTurn.set(key, list); if (live) setChecks(list); })
            // The request itself failed: say so per item rather than spin for ever.
            .catch(e => { if (live) setChecks([{ verdict: 'unchecked', reason: e instanceof Error ? e.message : String(e) }]); });
        return () => { live = false; };
        // `ask` is rebuilt every render; the key says what it asks about.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, enabled]);
    return checks;
}

function CardPreview({ card, label, turnKey, index, check }: { card: CardProposal; label: TopicLabel; turnKey: string; index: number; check: AssistantCheck | undefined }) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const key = `${turnKey}:card:${index}`;
    const [outcome, setOutcome] = useState(() => outcomes.get(key));
    const [busy, setBusy] = useState(false);
    const record = (o: NonNullable<typeof outcome>) => { outcomes.set(key, o); setOutcome(o); };
    // The model cannot see this topic's cards, so it may reword one the
    // learner already has; the preview names it before Add is pressed.
    const [similar, setSimilar] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        api.getFlashcards(label.id)
            .then(existing => { if (live) setSimilar(similarFront(card.front, existing.map(c => c.front))); })
            .catch(() => { /* no hint is not a failure */ });
        return () => { live = false; };
    }, [label.id, card.front]);
    const inactive = label.projectStatus != null && label.projectStatus !== 'active';

    const add = async () => {
        setBusy(true);
        try {
            const r = await api.addAssistantCard({ nodeId: label.id, front: card.front, back: card.back, extra: card.extra });
            record({ state: r.existed ? 'existed' : 'added', cardId: r.id });
        } catch (e) {
            addToast('error', t("Could not add the card"), e instanceof Error ? e.message : String(e));
        } finally { setBusy(false); }
    };
    const undo = async () => {
        if (!outcome?.cardId) return;
        setBusy(true);
        try {
            // Removed only while nobody has studied it: a reviewed card keeps
            // its history, and deleting it is the card editor's job.
            const r = await api.undoAssistantCard(outcome.cardId);
            record(r.kept ? { ...outcome, state: 'kept' } : { state: 'undone' });
        } catch (e) {
            addToast('error', t("Could not remove the card"), e instanceof Error ? e.message : String(e));
        } finally { setBusy(false); }
    };

    return (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
            <div className="flex items-center gap-2 px-3 pt-2.5 text-sm text-slate-500 dark:text-slate-400">
                <Layers className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">
                    {t("New card for {{topic}}", { topic: label.title })}
                    <span> · {label.projectName}</span>
                </span>
            </div>
            <div className="px-3 py-2 space-y-2">
                <Markdown content={card.front} className="text-sm leading-6 font-medium text-slate-800 dark:text-slate-100" />
                <div className="border-t border-slate-200 dark:border-slate-700" />
                {/* A back the check rejected is still shown — the learner may
                    want to see what was claimed — but never as an answer. */}
                <Markdown
                    content={card.back}
                    className={check?.verdict === 'disputed' && !outcome
                        ? 'text-sm leading-6 text-slate-500 dark:text-slate-400 line-through'
                        : 'text-sm leading-6 text-slate-700 dark:text-slate-200'}
                />
                {card.extra && <Markdown content={card.extra} className="text-sm leading-6 text-slate-500 dark:text-slate-400" />}
            </div>
            {!outcome && (
                <div className="px-3 pb-2 space-y-1 text-sm text-slate-500 dark:text-slate-400">
                    <CheckLine check={check} what="card" />
                    {similar && <p>{t("You already have a similar card: “{{front}}”", { front: similar })}</p>}
                    {inactive && <p>{t("This course is not active, so the card will not come up in your reviews.")}</p>}
                </div>
            )}
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3 empty:hidden">
                {(!outcome || outcome.state === 'undone') && check?.verdict === 'disputed' ? null : !outcome || outcome.state === 'undone' ? (
                    <>
                        <Button size="sm" variant="neutral" icon={<Layers className="w-3.5 h-3.5" aria-hidden="true" />} busy={busy} disabled={check === undefined} onClick={add}>{t("Add card")}</Button>
                        {!outcome && <span className="text-sm text-slate-500 dark:text-slate-400">{t("Nothing has changed yet.")}</span>}
                        {outcome?.state === 'undone' && <span className="text-sm text-slate-500 dark:text-slate-400">{t("Removed")}</span>}
                    </>
                ) : outcome.state === 'existed' ? (
                    <span className="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                        <Check className="w-4 h-4" aria-hidden="true" />{t("Already one of your cards")}
                    </span>
                ) : outcome.state === 'kept' ? (
                    <span className="inline-flex items-start gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                        <Check className="w-4 h-4 mt-0.5 shrink-0 text-accent-fg" aria-hidden="true" />
                        {t("Kept: you have reviewed this card since, so its history stays. To delete it, open it where you review it.")}
                    </span>
                ) : (
                    <>
                        <span className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                            <Check className="w-4 h-4 text-accent-fg" aria-hidden="true" />{t("Added")}
                        </span>
                        <Button size="sm" variant="quiet" icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />} busy={busy} onClick={undo}>{t("Undo")}</Button>
                    </>
                )}
            </div>
        </div>
    );
}

/** Each proposed card as a preview with an Add button — once it is checked. */
export function CardProposals({ cards, labels, turnKey }: { cards: CardProposal[]; labels: Record<number, TopicLabel>; turnKey: string }) {
    const shown = cards.map((card, i) => ({ card, i, label: labels[card.nodeId] }))
        .filter(x => x.label?.kind === 'topic' || x.label?.kind === 'stage');
    // All of a message's cards in one request: the server asks one cold pass
    // per topic rather than one per card.
    const checkKey = `${turnKey}:cards:${shown.map(x => `${x.card.nodeId}|${x.card.front}|${x.card.back}`).join('\u0000')}`;
    const checks = useChecks(checkKey,
        () => api.checkAssistantProposals({ cards: shown.map(x => ({ nodeId: x.card.nodeId, front: x.card.front, back: x.card.back })) }).then(r => r.cards),
        shown.length > 0);
    if (!shown.length) return null;
    return (
        <div className="space-y-2">
            {shown.map((x, k) => (
                <CardPreview key={x.i} card={x.card} label={x.label!} turnKey={turnKey} index={x.i}
                    check={checks ? (checks[k] ?? checks[0]) : undefined} />
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Changes to a course, a topic's title, a saved page, a new course
// ---------------------------------------------------------------------------

type EditOutcome = {
    state: 'applied' | 'undone';
    editId: number;
    /** What the preview showed before Apply: the "before" side of an applied change. */
    before: Record<string, string | number | null>;
    /** Fields Undo left alone because the learner changed them since. */
    kept?: string[];
};
const editOutcomes = new Map<string, EditOutcome>();

/** `source` names the block in a STORED message; a turn still under its
 *  provisional id has none yet, and its Undo lives for the page only. */
const sourceOf = (turnKey: string, kind: string, index: number) => (/^\d+$/.test(turnKey) ? `${turnKey}:${kind}:${index}` : null);

const sameValue = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');

/**
 * The shared half of every Apply/Undo preview: the target's values now, the
 * record of an Apply (found again after a reload by `source`), and the three
 * presses. A target that does not exist draws nothing.
 */
function useAppliedChange({ kind, targetId, projectId, changes, outcomeKey, source }: {
    kind: AssistantEditKind; targetId: number; projectId?: number;
    changes: Record<string, string | number>; outcomeKey: string; source: string | null;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const loadProjects = useStore(s => s.loadProjects);
    const [current, setCurrent] = useState<Record<string, string | number> | null | 'missing'>(null);
    const [outcome, setOutcomeState] = useState<EditOutcome | undefined>(() => editOutcomes.get(outcomeKey));
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const setOutcome = (o: EditOutcome) => { editOutcomes.set(outcomeKey, o); setOutcomeState(o); };

    useEffect(() => {
        let live = true;
        api.getAssistantTarget(kind, targetId)
            .then(v => { if (live) setCurrent(v); })
            .catch(() => { if (live) setCurrent('missing'); });
        // A preview drawn again after a reload: its Apply is on record.
        if (!editOutcomes.has(outcomeKey) && source) {
            api.getAssistantEdit(source)
                .then(({ edit }) => {
                    if (!live || !edit) return;
                    setOutcome({ state: edit.undone ? 'undone' : 'applied', editId: edit.id, before: edit.before });
                })
                .catch(() => { /* no record is a fresh preview */ });
        }
        return () => { live = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, targetId, outcomeKey, source]);

    const fields = Object.keys(changes);
    const values = current && current !== 'missing' ? current : null;
    const inPlace = !!values && fields.every(f => sameValue(values[f], changes[f]));

    const apply = async () => {
        if (!values) return;
        setBusy(true);
        setNote(null);
        try {
            const expect = Object.fromEntries(fields.map(f => [f, values[f]]));
            const r = await api.applyAssistantEdit({ kind, targetId, projectId, changes, expect, source });
            setCurrent(r.current);
            if (!r.unchanged && r.id != null) setOutcome({ state: 'applied', editId: r.id, before: expect });
            if (kind === 'project' || kind === 'topic') void loadProjects({ silent: true });
        } catch (e) {
            const data = (e as { data?: { stale?: string[]; current?: Record<string, string | number> } }).data;
            if (data?.stale && data.current) {
                // Something moved since the preview was drawn: show it as it is
                // now, and let the learner decide again.
                setCurrent(data.current);
                setNote(t("Nothing was changed: this was edited after the assistant wrote its suggestion. The box now shows it as it is now; press the button again to replace that."));
            } else {
                addToast('error', t("Could not apply the change"), e instanceof Error ? e.message : String(e));
            }
        } finally { setBusy(false); }
    };
    const undo = async () => {
        if (!outcome) return;
        setBusy(true);
        try {
            const r = await api.undoAssistantEdit(outcome.editId);
            if (r.current) setCurrent(r.current);
            setOutcome({ ...outcome, state: 'undone', kept: r.kept ?? [] });
            if (kind === 'project' || kind === 'topic') void loadProjects({ silent: true });
        } catch (e) {
            addToast('error', t("Could not undo the change"), e instanceof Error ? e.message : String(e));
        } finally { setBusy(false); }
    };
    return { current: values, missing: current === 'missing', outcome, busy, note, inPlace, apply, undo };
}

/** Something moved since the preview was drawn: Apply would now replace a newer
 *  value, so this is said as loudly as a refusal. */
function StaleNote({ text }: { text: string }) {
    return (
        <p className="inline-flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-300">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            {text}
        </p>
    );
}

/** Apply, Applied + Undo, Undone + Apply: the foot of every change preview. */
function ApplyFoot({ outcome, busy, inPlace, canApply, onApply, onUndo, applyLabel, appliedLabel }: {
    outcome: EditOutcome | undefined; busy: boolean; inPlace: boolean; canApply: boolean;
    onApply: () => void; onUndo: () => void; applyLabel: string; appliedLabel: string;
}) {
    const { t } = useTranslation();
    if (outcome?.state === 'applied') {
        return (
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
                <span className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                    <Check className="w-4 h-4 text-accent-fg" aria-hidden="true" />{appliedLabel}
                </span>
                <Button size="sm" variant="quiet" icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />} busy={busy} onClick={onUndo}>{t("Undo")}</Button>
            </div>
        );
    }
    if (inPlace && !outcome) {
        return (
            <p className="inline-flex items-center gap-1.5 px-3 pb-3 text-sm text-slate-500 dark:text-slate-400">
                <Check className="w-4 h-4" aria-hidden="true" />{t("Already like this")}
            </p>
        );
    }
    if (!canApply) return null;
    return (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
            <Button size="sm" variant="neutral" icon={<Check className="w-3.5 h-3.5" aria-hidden="true" />} busy={busy} disabled={inPlace} onClick={onApply}>{applyLabel}</Button>
            {/* A proposal and a done thing look alike from a distance: say
                which this is until the button is pressed. */}
            <span className="text-sm text-slate-500 dark:text-slate-400">
                {outcome?.state === 'undone' ? t("Undone: it is back as it was.") : t("Nothing has changed yet.")}
            </span>
        </div>
    );
}

/** A course's tile as its card draws it: the colour made safe for white, the drawing on it. */
function CourseTile({ icon, color, size = 'md' }: { icon: string | null | undefined; color: string | null | undefined; size?: 'sm' | 'md' }) {
    return (
        <span
            className={`flex shrink-0 items-center justify-center rounded-lg text-white ${size === 'sm' ? 'h-7 w-7' : 'h-9 w-9'}`}
            style={{ backgroundColor: `rgb(${accentSolidTriplet(String(color || '#3B82F6'))})` }}
            aria-hidden="true"
        >
            <ProjectIcon icon={icon} className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        </span>
    );
}

const ICON_LABEL = new Map(PROJECT_ICONS.map(d => [d.name, d.label]));

/** One short value's before → after, on one line (a topic's title). */
function ChangeRow({ label, before, after }: { label: string; before: ReactNode; after: ReactNode }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-1">
            <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="min-w-0 break-words text-slate-500 dark:text-slate-400">{before}</span>
                <ArrowRight className="w-3.5 h-3.5 shrink-0 text-slate-400" role="img" aria-label={t("becomes")} />
                <span className="min-w-0 break-words font-medium text-slate-800 dark:text-slate-100">{after}</span>
            </div>
        </div>
    );
}

const STATUS_WORDS: Record<string, string> = { active: k("Active"), completed: k("Finished"), archived: k("Archived") };
const FIELD_LABEL = new Map<string, string>([
    ['name', k("Name")], ['icon', k("Icon")], ['color', k("Colour")], ['description', k("Description")],
    ['status', k("Status")], ['new_per_day', k("New cards a day")],
]);

type CourseValues = Record<string, string | number | null | undefined>;

/** "Icon, Colour and Name", in the interface's language. `Intl.ListFormat` is
 *  ES2021 and the project's `lib` is ES2020, hence the narrow cast. */
function listFormat(items: string[]): string {
    const ListFormat = (Intl as unknown as {
        ListFormat?: new (locale: string, options: { style: string; type: string }) => { format(list: string[]): string };
    }).ListFormat;
    try {
        if (ListFormat) return new ListFormat(uiLocale(), { style: 'long', type: 'conjunction' }).format(items);
    } catch { /* an unknown locale: the plain join */ }
    return items.join(', ');
}

/**
 * A course drawn the way its card in Projects draws it, small: the tile, the
 * name, the description, and — only when the change is about them — its status
 * and its daily new cards. On the course it BECOMES (`mark`), every part that
 * changes is lit and every part that does not is dimmed, so the difference is
 * read off one card; `muted` is the course as it is, drawn beside it.
 */
function MiniCourseCard({ v, changed, show, muted = false, mark = false }: {
    v: CourseValues; changed: Set<string>; show: { status: boolean; perDay: boolean };
    muted?: boolean; mark?: boolean;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const lookChanged = changed.has('icon') || changed.has('color');
    // One rule on every state, so the light means "this changes" wherever it is.
    const lit = (f: string) => (mark && changed.has(f) ? 'rounded-md bg-accent/10 px-1 -mx-1' : '');
    const tone = (f: string, strong: string) => (muted || (mark && !changed.has(f)) ? 'text-slate-500 dark:text-slate-400' : strong);
    const words = (icon: unknown, hex: unknown) => {
        const colour = projectColourName(String(hex ?? ''));
        return `${ICON_LABEL.get(String(icon ?? '')) ?? String(icon ?? '')}, ${colour ? t(colour) : String(hex ?? '')}`;
    };
    const description = String(v.description ?? '').trim();
    return (
        <div className={cx(
            'min-w-0 space-y-2 rounded-xl border p-3',
            muted
                ? 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40'
                : 'border-slate-300 bg-white shadow-sm dark:border-slate-600 dark:bg-slate-800',
        )}>
            <div className="flex min-w-0 items-center gap-2.5">
                {/* An unchanged tile is never dimmed: a faded colour reads as a
                    new, lighter one. */}
                <span className={cx(
                    'shrink-0 rounded-lg',
                    mark && lookChanged && 'ring-2 ring-accent/50 ring-offset-2 ring-offset-white dark:ring-offset-slate-800',
                )}>
                    <CourseTile icon={String(v.icon ?? '')} color={String(v.color ?? '')} />
                </span>
                <div className="min-w-0">
                    <p className={cx('break-words text-sm font-semibold', tone('name', 'text-slate-900 dark:text-white'), lit('name'))}>
                        {String(v.name ?? '')}
                    </p>
                    {/* A colour two shades from the old one is easy to miss as
                        a swatch, so a change of look is also said in words. */}
                    {lookChanged
                        ? <p className="break-words text-sm text-slate-500 dark:text-slate-400">{words(v.icon, v.color)}</p>
                        : <span className="sr-only">{words(v.icon, v.color)}</span>}
                </div>
            </div>
            <p className={cx(
                'whitespace-pre-line break-words text-sm leading-6',
                // The old description is there to recognise, not to read again.
                muted && 'line-clamp-2',
                tone('description', 'text-slate-700 dark:text-slate-200'),
                lit('description'),
            )}>
                {description || <span className="italic">{t("No description")}</span>}
            </p>
            {show.status && (
                <p className={cx('text-sm', tone('status', 'text-slate-700 dark:text-slate-200'), lit('status'))}>
                    {t("Status")}: {t(STATUS_WORDS[String(v.status)] ?? String(v.status ?? ''))}
                </p>
            )}
            {show.perDay && (
                <p className={cx('text-sm', tone('new_per_day', 'text-slate-700 dark:text-slate-200'), lit('new_per_day'))}>
                    {t("New cards a day")}: {num(Number(v.new_per_day))}
                </p>
            )}
        </div>
    );
}

/**
 * The course before and after, as two of its own cards with one arrow between
 * them — the course is recognised as a whole, where a field list made the
 * reader rebuild it from label/value pairs: side by side where the box is wide enough for two readable
 * cards, one above the other where it is not (a phone's drawer). Measured on
 * the box itself, never the window. The cards keep their own heights — a short
 * old card stretched to a long new one read as an empty grey box.
 */
function CourseChangeCards({ before, after, changed, applied }: {
    before: CourseValues; after: CourseValues; changed: Set<string>; applied: boolean;
}) {
    const { t } = useTranslation();
    const ref = useRef<HTMLDivElement>(null);
    const width = useElementWidth(ref);
    const rootPx = useRootFontSize();
    const show = { status: changed.has('status'), perDay: changed.has('new_per_day') };
    // Two cards of at least 10rem each, the arrow and the gaps between them.
    const wide = width > 0 && width >= 22 * rootPx;
    const label = 'text-sm text-slate-500 dark:text-slate-400';
    return (
        <div ref={ref} className={wide ? 'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2' : 'flex flex-col gap-1.5'}>
            <div className="flex min-w-0 flex-col gap-1">
                {/* "Now" is only ever the left card: once applied, the left one
                    is "Before" and the right one "After", never "Now". */}
                <p className={label}>{applied ? t("Before") : t("Now")}</p>
                <MiniCourseCard v={before} changed={changed} show={show} muted />
            </div>
            {wide
                ? <ArrowRight className="mt-11 h-4 w-4 text-slate-400" role="img" aria-label={t("becomes")} />
                : <ArrowDown className="h-4 w-4 self-center text-slate-400" role="img" aria-label={t("becomes")} />}
            <div className="flex min-w-0 flex-col gap-1">
                <p className={label}>{applied ? t("After") : t("After you apply")}</p>
                <MiniCourseCard v={after} changed={changed} show={show} mark />
            </div>
        </div>
    );
}

function ProjectChangePreview({ proposal, turnKey, index }: { proposal: ProjectEditProposal; turnKey: string; index: number }) {
    const { t } = useTranslation();
    const outcomeKey = `${turnKey}:project:${index}`;
    const change = useAppliedChange({
        kind: 'project', targetId: proposal.projectId, changes: proposal.changes as Record<string, string | number>,
        outcomeKey, source: sourceOf(turnKey, 'project', index),
    });
    if (change.missing || !change.current) return null;
    const now = change.current;
    // The before side: what Apply replaced, once it has; until then, now.
    const was = (f: string) => (change.outcome?.state === 'applied' && f in change.outcome.before ? change.outcome.before[f] : now[f]);
    const willBe = (f: string) => (f in proposal.changes ? proposal.changes[f as ProjectField] : was(f));
    const look = 'icon' in proposal.changes || 'color' in proposal.changes;
    const changedWords = PROJECT_FIELDS.filter(f => f in proposal.changes).map(f => t(FIELD_LABEL.get(f) ?? f));
    const fields = PROJECT_FIELDS.filter(f => f in proposal.changes && f !== 'icon' && f !== 'color');
    // A change that is only the course's status is named by what it does.
    const onlyStatus = fields.length === 1 && fields[0] === 'status' && !look;
    const nextStatus = String(willBe('status'));
    const onlyName = fields.length === 1 && fields[0] === 'name' && !look;
    const applyLabel = onlyStatus
        // Verbs with their object: "Archive" alone is already the NOUN in six
        // of the locales (the grid's section).
        ? (nextStatus === 'archived' ? t("Archive the course") : nextStatus === 'completed' ? t("Mark the course finished") : t("Restore the course"))
        : onlyName ? t("Rename the course") : t("Apply");
    // The course as it was named when the change was suggested; once applied,
    // the box is a record of a change made, not a suggestion.
    const courseName = String(change.outcome?.state === 'applied' ? was('name') : now.name);

    return (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
            <div className="flex items-center gap-2 px-3 pt-2.5 text-sm text-slate-500 dark:text-slate-400">
                <Pencil className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{change.outcome?.state === 'applied'
                    ? t("Changed “{{course}}”", { course: courseName })
                    : t("Suggested change for “{{course}}”", { course: courseName })}</span>
            </div>
            <div className="px-3 py-2 space-y-3">
                {/* What changes, in words, before the cards: two cards ask the
                    eye to find the differences, and a colour two shades apart
                    is easy to miss. */}
                {changedWords.length > 0 && (
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        {t("What changes: {{list}}.", { list: listFormat(changedWords) })}
                    </p>
                )}
                {/* What was asked for and refused, before the cards: read after
                    them, the cards had already promised the missing icon. */}
                {proposal.refused.map(r => (
                    <p key={r.field} className="inline-flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                        {r.field === 'icon' ? t("“{{value}}” is not one of the app's icons, so the icon stays as it is.", { value: r.value })
                            : r.field === 'color' ? t("“{{value}}” is not a colour the app can paint, so the colour stays as it is.", { value: r.value })
                                : t("“{{value}}” is not a value the app accepts for this, so it stays as it is.", { value: r.value })}
                    </p>
                ))}
                <CourseChangeCards
                    before={Object.fromEntries(PROJECT_FIELDS.map(f => [f, was(f)]))}
                    after={Object.fromEntries(PROJECT_FIELDS.map(f => [f, willBe(f)]))}
                    changed={new Set(Object.keys(proposal.changes))}
                    applied={change.outcome?.state === 'applied'}
                />
                {'status' in proposal.changes && nextStatus !== String(was('status')) && nextStatus !== 'active' && (
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                        {nextStatus === 'archived'
                            ? t("An archived course leaves your lists and your reviews. Nothing in it is deleted, and it can be restored.")
                            : t("A finished course moves to Finished. Nothing in it is deleted.")}
                    </p>
                )}
                {change.note && <StaleNote text={change.note} />}
                {change.outcome?.state === 'undone' && !!change.outcome.kept?.length && (
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                        {t("Kept what you changed since: {{fields}}. The rest is back as it was.", {
                            fields: change.outcome.kept.map(f => t(FIELD_LABEL.get(f) ?? f)).join(', '),
                        })}
                    </p>
                )}
            </div>
            <ApplyFoot
                outcome={change.outcome} busy={change.busy} inPlace={change.inPlace}
                canApply={Object.keys(proposal.changes).length > 0}
                onApply={change.apply} onUndo={change.undo}
                applyLabel={applyLabel} appliedLabel={t("Applied")}
            />
        </div>
    );
}

/** Each proposed change to a course, as before → after with Apply. */
export function ProjectChangeProposals({ projects, turnKey }: { projects: ProjectEditProposal[]; turnKey: string }) {
    if (!projects.length) return null;
    return (
        <div className="space-y-2">
            {projects.map((p, i) => <ProjectChangePreview key={i} proposal={p} turnKey={turnKey} index={i} />)}
        </div>
    );
}

function TopicChangePreview({ proposal, label, turnKey, index }: { proposal: TopicEditProposal; label: TopicLabel; turnKey: string; index: number }) {
    const { t } = useTranslation();
    const change = useAppliedChange({
        kind: 'topic', targetId: proposal.nodeId, projectId: proposal.projectId, changes: { title: proposal.title },
        outcomeKey: `${turnKey}:topic:${index}`, source: sourceOf(turnKey, 'topic', index),
    });
    if (change.missing || !change.current) return null;
    const was = change.outcome?.state === 'applied' ? change.outcome.before.title : change.current.title;
    return (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
            <div className="flex items-center gap-2 px-3 pt-2.5 text-sm text-slate-500 dark:text-slate-400">
                <Pencil className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{t("Rename a topic in {{course}}", { course: label.projectName })}</span>
            </div>
            <div className="px-3 py-2 space-y-2">
                <ChangeRow label={t("Title")} before={String(was ?? '')} after={proposal.title} />
                {change.note && <StaleNote text={change.note} />}
                {change.outcome?.state === 'undone' && !!change.outcome.kept?.length && (
                    <p className="text-sm text-slate-600 dark:text-slate-300">{t("Kept: you renamed it again since.")}</p>
                )}
            </div>
            <ApplyFoot
                outcome={change.outcome} busy={change.busy} inPlace={change.inPlace} canApply
                onApply={change.apply} onUndo={change.undo}
                applyLabel={t("Rename")} appliedLabel={t("Renamed")}
            />
        </div>
    );
}

/** Each proposed topic title, as before → after with Rename. */
export function TopicChangeProposals({ topics, labels, turnKey }: { topics: TopicEditProposal[]; labels: Record<number, TopicLabel>; turnKey: string }) {
    const shown = topics.map((p, i) => ({ p, i, label: labels[p.nodeId] }))
        .filter(x => x.label && x.label.projectId === x.p.projectId);
    if (!shown.length) return null;
    return (
        <div className="space-y-2">
            {shown.map(x => <TopicChangePreview key={x.i} proposal={x.p} label={x.label!} turnKey={turnKey} index={x.i} />)}
        </div>
    );
}

type LinkOutcome = { state: 'saved' | 'existed' | 'undone'; editId?: number; title?: string };
const linkOutcomes = new Map<string, LinkOutcome>();

function LinkPreview({ link, label, turnKey, index, check }: { link: LinkProposal; label: TopicLabel; turnKey: string; index: number; check: AssistantCheck | undefined }) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const key = `${turnKey}:link:${index}`;
    const source = sourceOf(turnKey, 'link', index);
    const [outcome, setOutcomeState] = useState<LinkOutcome | undefined>(() => linkOutcomes.get(key));
    const [busy, setBusy] = useState(false);
    const setOutcome = (o: LinkOutcome) => { linkOutcomes.set(key, o); setOutcomeState(o); };
    useEffect(() => {
        if (linkOutcomes.has(key) || !source) return;
        let live = true;
        api.getAssistantEdit(source)
            .then(({ edit }) => { if (live && edit) setOutcome({ state: edit.undone ? 'undone' : 'saved', editId: edit.id, title: String(edit.after.title ?? '') }); })
            .catch(() => { });
        return () => { live = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, source]);

    // The page's own title once it was opened; the model's name for it until then.
    const title = outcome?.title || check?.detail?.title || link.title || link.url;
    const save = async () => {
        setBusy(true);
        try {
            const r = await api.saveAssistantLink({ projectId: link.projectId, nodeId: link.nodeId, url: link.url, title: link.title, source });
            setOutcome(r.existed ? { state: 'existed' } : { state: 'saved', editId: r.id, title: r.title });
        } catch (e) {
            addToast('error', t("Could not save the link"), e instanceof Error ? e.message : String(e));
        } finally { setBusy(false); }
    };
    const undo = async () => {
        if (!outcome?.editId) return;
        setBusy(true);
        try {
            await api.undoAssistantEdit(outcome.editId);
            setOutcome({ ...outcome, state: 'undone' });
        } catch (e) {
            addToast('error', t("Could not remove the link"), e instanceof Error ? e.message : String(e));
        } finally { setBusy(false); }
    };
    const refused = check?.verdict === 'disputed';

    return (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
            <div className="flex items-center gap-2 px-3 pt-2.5 text-sm text-slate-500 dark:text-slate-400">
                <Link2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{t("A page for {{topic}}", { topic: label.title })}<span> · {label.projectName}</span></span>
            </div>
            <div className="px-3 py-2 space-y-1">
                <p className="text-sm leading-6 font-medium text-slate-800 dark:text-slate-100 break-words">{title}</p>
                {/* A page that is not there is not a place to send anyone:
                    its address stays as text. */}
                <p className="text-sm">
                    {refused ? (
                        <span className="block truncate text-slate-500 dark:text-slate-400">{link.url.replace(/^https?:\/\//, '')}</span>
                    ) : (
                        <a
                            href={link.url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex max-w-full items-center gap-1 text-accent-fg hover:underline"
                        >
                            <span className="min-w-0 truncate">{link.url.replace(/^https?:\/\//, '')}</span>
                            <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        </a>
                    )}
                </p>
                {!outcome && <div className="pt-1"><CheckLine check={check} what="link" /></div>}
            </div>
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3 empty:hidden">
                {outcome?.state === 'saved' ? (
                    <>
                        <span className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                            <Check className="w-4 h-4 text-accent-fg" aria-hidden="true" />{t("Saved on the topic")}
                        </span>
                        <Button size="sm" variant="quiet" icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />} busy={busy} onClick={undo}>{t("Undo")}</Button>
                    </>
                ) : outcome?.state === 'existed' ? (
                    <span className="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                        <Check className="w-4 h-4" aria-hidden="true" />{t("Already saved on this topic")}
                    </span>
                ) : refused ? null : (
                    <>
                        <Button size="sm" variant="neutral" icon={<Link2 className="w-3.5 h-3.5" aria-hidden="true" />} busy={busy} disabled={check === undefined} onClick={save}>{t("Save link")}</Button>
                        {!outcome && <span className="text-sm text-slate-500 dark:text-slate-400">{t("Nothing has changed yet.")}</span>}
                        {outcome?.state === 'undone' && <span className="text-sm text-slate-500 dark:text-slate-400">{t("Removed")}</span>}
                    </>
                )}
            </div>
        </div>
    );
}

type SaveOutcome = { state: 'saved' | 'existed' | 'undone'; editId?: number; projectId?: number; nodeId?: number | null };
const saveOutcomes = new Map<string, SaveOutcome>();

/** The heading of a prepared save — where it goes — or null when the place does not exist. */
function saveHeading(t: (k: string, o?: Record<string, unknown>) => string, to: SaveProposal['to'], labels: Record<number, TopicLabel>, projects: { id: number; name: string }[]): string | null {
    // Its own sentence: "your Inbox" spliced into "Save to …" does not decline.
    if (to.kind === 'inbox') return t("Save to Inbox");
    if (to.kind === 'topic') {
        const l = labels[to.nodeId];
        return l && l.projectId === to.projectId ? t("Save to {{place}}", { place: `${l.title} · ${l.projectName}` }) : null;
    }
    const name = projects.find(p => p.id === to.projectId)?.name;
    return name ? t("Save to {{place}}", { place: name }) : null;
}

function SavePreview({ save, attachment, heading, turnKey, index, conversationId, onOpen }: {
    save: SaveProposal; attachment: ChatAttachment; heading: string; turnKey: string; index: number;
    conversationId: number | null; onOpen: (projectId: number, nodeId: number | null) => void;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const key = `${turnKey}:save:${index}`;
    const source = sourceOf(turnKey, 'save', index);
    const [outcome, setOutcomeState] = useState<SaveOutcome | undefined>(() => saveOutcomes.get(key));
    const [busy, setBusy] = useState(false);
    const [whole, setWhole] = useState(false);
    // The words go into the library as they are, so all of them can be read
    // first: cut to four lines, with "Show all" whenever the cut hid something.
    const descRef = useRef<HTMLParagraphElement>(null);
    const [cut, setCut] = useState(false);
    useLayoutEffect(() => {
        const el = descRef.current;
        if (el && !whole) setCut(el.scrollHeight > el.clientHeight + 1);
    }, [save.description, whole]);
    const setOutcome = (o: SaveOutcome) => { saveOutcomes.set(key, o); setOutcomeState(o); };
    useEffect(() => {
        if (saveOutcomes.has(key) || !source) return;
        let live = true;
        api.getAssistantEdit(source)
            .then(({ edit }) => {
                if (!live || !edit) return;
                setOutcome({ state: edit.undone ? 'undone' : 'saved', editId: edit.id, projectId: Number(edit.after.projectId), nodeId: edit.after.nodeId == null ? null : Number(edit.after.nodeId) });
            })
            .catch(() => { });
        return () => { live = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, source]);

    // A picture is saved with words, or a later search has nothing to find it by.
    const needsWords = attachment.kind === 'image' && !save.description.trim();
    const title = save.title || attachment.name;
    const doSave = async () => {
        setBusy(true);
        try {
            const r = await api.saveAssistantAttachment(attachment.id, {
                projectId: save.to.kind === 'inbox' ? null : save.to.projectId,
                nodeId: save.to.kind === 'topic' ? save.to.nodeId : null,
                inbox: save.to.kind === 'inbox',
                title: save.title, description: save.description, conversationId, source,
            });
            setOutcome(r.existed ? { state: 'existed' } : { state: 'saved', editId: r.id, projectId: r.projectId, nodeId: r.nodeId ?? null });
        } catch (e) {
            addToast('error', t("Could not save the file"), e instanceof Error ? e.message : String(e));
        } finally { setBusy(false); }
    };
    const undo = async () => {
        if (!outcome?.editId) return;
        setBusy(true);
        try {
            await api.undoAssistantEdit(outcome.editId);
            setOutcome({ ...outcome, state: 'undone' });
        } catch (e) {
            addToast('error', t("Could not remove the file"), e instanceof Error ? e.message : String(e));
        } finally { setBusy(false); }
    };

    return (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
            <div className="flex items-center gap-2 px-3 pt-2.5 text-sm text-slate-500 dark:text-slate-400">
                <BookmarkPlus className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{heading}</span>
            </div>
            <div className="flex gap-3 px-3 py-2">
                {attachment.kind === 'image' ? (
                    <img src={api.attachmentFileUrl(attachment.id)} alt="" className="w-16 h-16 shrink-0 rounded-lg object-cover border border-slate-200 dark:border-slate-600" />
                ) : (
                    <span className="flex items-center justify-center w-16 h-16 shrink-0 rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-200">
                        <FileGlyph fileType={attachment.fileType} name={attachment.name} className="w-6 h-6" />
                    </span>
                )}
                <div className="min-w-0 space-y-1">
                    <p className="text-sm leading-6 font-medium text-slate-800 dark:text-slate-100 break-words">{title}</p>
                    {save.description && (
                        <>
                            <p ref={descRef} className={cx('text-sm leading-6 text-slate-700 dark:text-slate-200 whitespace-pre-line break-words', !whole && 'line-clamp-3')}>{save.description}</p>
                            {(cut || whole) && (
                                <Button size="sm" variant="quiet" onClick={() => setWhole(w => !w)}>{whole ? t("Show less") : t("Show all")}</Button>
                            )}
                        </>
                    )}
                    {needsWords && <p className="text-sm text-amber-700 dark:text-amber-300">{t("A picture is saved with words saying what it shows, and none came with this one. Ask the assistant to describe it.")}</p>}
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
                {outcome?.state === 'saved' ? (
                    <>
                        <span className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                            <Check className="w-4 h-4 text-accent-fg" aria-hidden="true" />{t("Saved to the library")}
                        </span>
                        {outcome.projectId != null && <Button size="sm" variant="quiet" onClick={() => onOpen(outcome.projectId!, outcome.nodeId ?? null)}>{t("Open")}</Button>}
                        <Button size="sm" variant="quiet" icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />} busy={busy} onClick={undo}>{t("Undo")}</Button>
                    </>
                ) : outcome?.state === 'existed' ? (
                    <span className="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                        <Check className="w-4 h-4" aria-hidden="true" />{t("Already saved there")}
                    </span>
                ) : (
                    <>
                        <Button size="sm" variant="neutral" icon={<BookmarkPlus className="w-3.5 h-3.5" aria-hidden="true" />} busy={busy} disabled={needsWords} onClick={doSave}>{t("Save")}</Button>
                        {!outcome && <span className="text-sm text-slate-500 dark:text-slate-400">{t("Nothing is saved until you press Save.")}</span>}
                        {outcome?.state === 'undone' && <span className="text-sm text-slate-500 dark:text-slate-400">{t("Removed")}</span>}
                    </>
                )}
            </div>
        </div>
    );
}

/**
 * Files from this conversation the assistant prepared to keep in the library,
 * each with the words it wrote for it — saved only on the press. A file that is
 * not this conversation's, or a place that does not exist, draws nothing.
 */
export function SaveProposals({ saves, attachments, labels, turnKey, conversationId, onOpen }: {
    saves: SaveProposal[];
    attachments: Map<number, ChatAttachment>;
    labels: Record<number, TopicLabel>;
    turnKey: string;
    conversationId: number | null;
    onOpen: (projectId: number, nodeId: number | null) => void;
}) {
    const { t } = useTranslation();
    const projects = useStore(s => s.projects);
    const shown = saves.map((s, i) => ({ s, i, att: attachments.get(s.attachmentId), heading: saveHeading(t, s.to, labels, projects) }))
        .filter((x): x is { s: SaveProposal; i: number; att: ChatAttachment; heading: string } => !!x.att && !!x.heading);
    if (!shown.length) return null;
    return (
        <div className="space-y-2">
            {shown.map(x => (
                <SavePreview key={x.i} save={x.s} attachment={x.att} heading={x.heading} turnKey={turnKey} index={x.i} conversationId={conversationId} onOpen={onOpen} />
            ))}
        </div>
    );
}

/** Each page the assistant found worth keeping on a topic — opened first. */
export function LinkProposals({ links, labels, turnKey }: { links: LinkProposal[]; labels: Record<number, TopicLabel>; turnKey: string }) {
    const shown = links.map((l, i) => ({ l, i, label: labels[l.nodeId] }))
        .filter(x => x.label && x.label.projectId === x.l.projectId);
    const checks = useChecks(`${turnKey}:links:${shown.map(x => x.l.url).join(' ')}`,
        () => api.checkAssistantProposals({ links: shown.map(x => x.l.url) }).then(r => r.links),
        shown.length > 0);
    if (!shown.length) return null;
    return (
        <div className="space-y-2">
            {shown.map((x, k) => (
                <LinkPreview key={x.i} link={x.l} label={x.label!} turnKey={turnKey} index={x.i}
                    check={checks ? (checks[k] ?? checks[0]) : undefined} />
            ))}
        </div>
    );
}

/** A language's name in the interface's language, asked of `Intl` (the catalog's English name where it has none). */
function displayLanguage(code: string, fallback: string) {
    try {
        const name = new Intl.DisplayNames([uiLocale()], { type: 'language' }).of(code);
        if (name && name !== code) return name;
    } catch { /* an unknown code: the catalog's name */ }
    return fallback;
}

/**
 * A new course the assistant drafted. Nothing is written from here: the button
 * opens the New course dialog filled in, where the learner can change any of
 * it, add their files, and press Create.
 */
export function CourseDraftProposals({ courses, onOpen }: { courses: CourseDraftProposal[]; onOpen: () => void }) {
    const { t } = useTranslation();
    const languages = useLanguages(courses.some(c => !!c.language));
    if (!courses.length) return null;
    const languageOf = (raw: string | null) => {
        if (!raw) return null;
        const v = raw.trim().toLowerCase();
        return languages.find(l => l.code.toLowerCase() === v || l.name.toLowerCase() === v) ?? null;
    };
    return (
        <div className="space-y-2">
            {courses.map((c, i) => {
                const lang = languageOf(c.language);
                const open = () => {
                    useCreationRuns.setState({
                        draft: { name: c.name, description: c.goal, color: c.color ?? '', icon: c.icon ?? '', language: lang?.code ?? '', documents: [] },
                    });
                    onOpen();
                };
                return (
                    <div key={i} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                        <div className="flex items-center gap-2 px-3 pt-2.5 text-sm text-slate-500 dark:text-slate-400">
                            <Plus className="w-4 h-4 shrink-0" aria-hidden="true" />
                            {t("A new course")}
                        </div>
                        <div className="px-3 py-2 space-y-2">
                            <div className="flex items-center gap-2.5">
                                <CourseTile icon={c.icon} color={c.color} />
                                <p className="min-w-0 text-sm font-medium text-slate-800 dark:text-slate-100 break-words">{c.name || t("Untitled course")}</p>
                            </div>
                            {c.goal && <p className="text-sm leading-6 text-slate-700 dark:text-slate-200 whitespace-pre-line break-words">{c.goal}</p>}
                            {lang && <p className="text-sm text-slate-500 dark:text-slate-400">{t("Lessons written in {{language}}", { language: displayLanguage(lang.code, lang.name) })}</p>}
                            {/* The dialog's own button, named as it is labelled there. */}
                            <p className="text-sm text-slate-500 dark:text-slate-400">{t("Nothing is created until you press “{{create}}” in the dialog, which then writes the course.", { create: t("Create with AI") })}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
                            <Button size="sm" variant="neutral" icon={<Plus className="w-3.5 h-3.5" aria-hidden="true" />} onClick={open}>{t("Open in New course")}</Button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

/** A note for the Inbox, saved on the press — the same capture the header's button makes. */
export function CaptureProposals({ captures, turnKey, onOpen }: { captures: string[]; turnKey: string; onOpen: (projectId: number, nodeId: number) => void }) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const [, redraw] = useState(0);
    const [busy, setBusy] = useState(false);
    if (!captures.length) return null;

    const save = async (text: string, key: string) => {
        setBusy(true);
        try {
            // `once`: this button is drawn again on every re-read of the
            // conversation, and a second press must find the first note.
            const r = await api.capture({ text, once: true });
            outcomes.set(key, { state: 'saved', nodeId: r.nodeId, projectId: r.projectId });
            redraw(n => n + 1);
        } catch (e) {
            addToast('error', t("Could not save the note"), e instanceof Error ? e.message : String(e));
        } finally { setBusy(false); }
    };

    return (
        <div className="space-y-2">
            {captures.map((text, i) => {
                const key = `${turnKey}:capture:${i}`;
                const done = outcomes.get(key);
                return (
                    <div key={key} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                        <div className="flex items-center gap-2 px-3 pt-2.5 text-sm text-slate-500 dark:text-slate-400">
                            <Inbox className="w-4 h-4 shrink-0" aria-hidden="true" />
                            {t("Note for your Inbox")}
                        </div>
                        <Markdown content={text} className="px-3 py-2 text-sm leading-6 text-slate-700 dark:text-slate-200" />
                        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
                            {done?.nodeId && done.projectId ? (
                                <>
                                    <span className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                                        <Check className="w-4 h-4 text-accent-fg" aria-hidden="true" />{t("Saved to your Inbox")}
                                    </span>
                                    <Button size="sm" variant="quiet" onClick={() => onOpen(done.projectId!, done.nodeId!)}>{t("Open")}</Button>
                                </>
                            ) : (
                                <Button size="sm" variant="neutral" icon={<Inbox className="w-3.5 h-3.5" aria-hidden="true" />} busy={busy} onClick={() => save(text, key)}>{t("Save to Inbox")}</Button>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

const REPORT_ICON = { bug: Bug, content: MessageSquareWarning, idea: Lightbulb } as const;

/**
 * A problem report the assistant drafted from what the learner told it, in
 * their words. Review opens the app's own Report a problem dialog, filled in:
 * they read it, change it, and only then does "Continue on GitHub" open the
 * issue form — and even that sends nothing from the app, GitHub gets the text
 * when they submit it there. So there is no Undo and no dedupe: nothing was
 * written, and pressing Review on a re-read conversation is harmless.
 */
export function ReportProposals({ reports, turnKey }: { reports: ReportProposal[]; turnKey: string }) {
    const { t } = useTranslation();
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    const [, redraw] = useState(0);
    if (!reports.length) return null;
    return (
        <div className="space-y-2">
            {reports.map((report, i) => {
                const key = `${turnKey}:report:${i}`;
                const form = REPORT_FORMS[report.kind];
                const Icon = REPORT_ICON[report.kind];
                // The first answer the draft has, as a glimpse; the dialog has all of it.
                const first = form.fields.find(f => report.fields[f.id]);
                const opened = outcomes.get(key)?.state === 'opened';
                return (
                    <div key={key} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                        <div className="flex items-center gap-2 px-3 pt-2.5 text-sm text-slate-500 dark:text-slate-400">
                            <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 truncate">{t("Draft report: {{kind}}", { kind: t(form.name) })}</span>
                        </div>
                        <div className="px-3 py-2 space-y-1">
                            {report.title && (
                                <p className="text-sm leading-6 font-medium text-slate-800 dark:text-slate-100 break-words">{report.title}</p>
                            )}
                            {first && (
                                <p className="text-sm leading-6 text-slate-600 dark:text-slate-300 whitespace-pre-line break-words line-clamp-3">
                                    {report.fields[first.id]}
                                </p>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
                            <Button size="sm" variant="neutral" icon={<Icon className="w-3.5 h-3.5" aria-hidden="true" />} onClick={() => setOpenIndex(i)}>
                                {t("Review report")}
                            </Button>
                            {opened && (
                                <span className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                                    <Check className="w-4 h-4 text-accent-fg" aria-hidden="true" />{t("Opened on GitHub")}
                                </span>
                            )}
                        </div>
                        <ReportProblemDialog
                            open={openIndex === i}
                            onClose={() => setOpenIndex(null)}
                            prefill={report}
                            draftKey={`assistant:${key}`}
                            onOpened={() => { outcomes.set(key, { state: 'opened' }); redraw(n => n + 1); }}
                        />
                    </div>
                );
            })}
        </div>
    );
}
