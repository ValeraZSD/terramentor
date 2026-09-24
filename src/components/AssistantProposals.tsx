import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Inbox, Layers, RotateCcw, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import Markdown from './Markdown';
import { Button } from './ui/Button';
import { similarFront, type CardProposal, type CheckTarget } from '../utils/assistantWrites';

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
const outcomes = new Map<string, { state: 'added' | 'existed' | 'undone' | 'kept' | 'saved'; cardId?: number; nodeId?: number; projectId?: number }>();

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

function CardPreview({ card, label, turnKey, index }: { card: CardProposal; label: TopicLabel; turnKey: string; index: number }) {
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
                <Markdown content={card.back} className="text-sm leading-6 text-slate-700 dark:text-slate-200" />
                {card.extra && <Markdown content={card.extra} className="text-sm leading-6 text-slate-500 dark:text-slate-400" />}
            </div>
            {!outcome && (similar || inactive) && (
                <div className="px-3 pb-2 space-y-1 text-sm text-slate-500 dark:text-slate-400">
                    {similar && <p>{t("You already have a similar card: “{{front}}”", { front: similar })}</p>}
                    {inactive && <p>{t("This course is not active, so the card will not come up in your reviews.")}</p>}
                </div>
            )}
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
                {!outcome || outcome.state === 'undone' ? (
                    <>
                        <Button size="sm" variant="neutral" icon={<Layers className="w-3.5 h-3.5" aria-hidden="true" />} busy={busy} onClick={add}>{t("Add card")}</Button>
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

/** Each proposed card as a preview with an Add button. */
export function CardProposals({ cards, labels, turnKey }: { cards: CardProposal[]; labels: Record<number, TopicLabel>; turnKey: string }) {
    const shown = cards.map((card, i) => ({ card, i, label: labels[card.nodeId] }))
        .filter(x => x.label?.kind === 'topic' || x.label?.kind === 'stage');
    if (!shown.length) return null;
    return (
        <div className="space-y-2">
            {shown.map(x => <CardPreview key={x.i} card={x.card} label={x.label!} turnKey={turnKey} index={x.i} />)}
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
