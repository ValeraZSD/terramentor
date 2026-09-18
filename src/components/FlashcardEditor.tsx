import { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import Modal from './Modal';
import CardText from './CardText';
import { api } from '../api';
import { useStore } from '../store';
import { Flashcard } from '../types';
import { hasRichCardText } from '../utils/cardText';
import { useTranslation } from 'react-i18next';

interface Props {
    card: Flashcard;
    onClose: () => void;
    /** The saved card, so the session can show the edit without a reload. */
    onSaved: (card: Flashcard) => void;
    onDeleted: (id: number) => void;
}

/**
 * Fix a card where you met it.
 *
 * A review session is the only place a bad card is ever noticed — a typo, an
 * answer that is wrong, an imported card whose sides came across the wrong way
 * round — and until now the only thing to do about it was to remember and go
 * looking later, which nobody does. So the two repairs are here: edit it, or
 * remove it.
 *
 * Deleting is deliberately plain "delete" rather than Anki's suspend/bury. This
 * app has one queue and no notion of a hidden card, and a "suspended" state that
 * only one screen understands is a card that has quietly stopped being studied
 * while still being counted. Removing it says what happened.
 *
 * The live preview under the fields is not decoration: card text carries
 * conventions (a `漢字[かな]` reading, a `**marked**` word) that are markup on
 * one line and content on the next, so an editor that showed only the raw
 * string would be asking the learner to compile it in their head.
 */
export default function FlashcardEditor({ card, onClose, onSaved, onDeleted }: Props) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);
    const [front, setFront] = useState(card.front ?? '');
    const [back, setBack] = useState(card.back ?? '');
    const [extra, setExtra] = useState(card.extra ?? '');
    const [extraFront, setExtraFront] = useState(card.extra_front ?? '');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setFront(card.front ?? '');
        setBack(card.back ?? '');
        setExtra(card.extra ?? '');
        setExtraFront(card.extra_front ?? '');
    }, [card.id]);

    const dirty = front !== (card.front ?? '') || back !== (card.back ?? '') || extra !== (card.extra ?? '')
        || extraFront !== (card.extra_front ?? '');

    const save = async () => {
        if (!front.trim() || !back.trim()) {
            addToast('error', t("A card needs both sides"), t("Question and answer cannot be empty."));
            return;
        }
        setBusy(true);
        try {
            // Text only — no `last_reviewed`, so editing a card never counts as
            // a review and never moves its schedule.
            const saved = await api.updateFlashcard(card.id, {
                front: front.trim(), back: back.trim(), extra: extra.trim(),
                extra_front: extraFront.trim() || null,
            });
            onSaved({ ...card, ...saved });
            addToast('success', t("Card updated"));
            onClose();
        } catch (e: any) {
            addToast('error', t("Could not save the card"), e.message);
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        const ok = await showConfirm({
            title: t("Delete this card?"),
            message: t("It is removed from this deck for good. Its review history goes with it."),
            confirmLabel: t("Delete"),
            variant: 'danger',
        });
        if (!ok) return;
        setBusy(true);
        try {
            await api.deleteFlashcard(card.id);
            onDeleted(card.id);
            addToast('success', t("Card deleted"));
            onClose();
        } catch (e: any) {
            addToast('error', t("Could not delete the card"), e.message);
        } finally {
            setBusy(false);
        }
    };

    const field = (label: string, value: string, set: (v: string) => void, rows: number, hint?: string) => (
        <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</span>
            <textarea
                value={value}
                onChange={e => set(e.target.value)}
                rows={rows}
                className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 resize-y"
            />
            {hint && <span className="block text-sm text-slate-500 dark:text-slate-400 mt-1">{hint}</span>}
            {hasRichCardText(value) && (
                <span className="mt-1.5 block rounded-lg bg-slate-50 dark:bg-slate-900/40 px-3 py-2 text-sm text-slate-700 dark:text-slate-200">
                    <CardText content={value} />
                </span>
            )}
        </label>
    );

    return (
        <Modal isOpen onClose={onClose} title={t("Edit card")} maxWidth="max-w-lg">
            <div className="space-y-4">
                {field('Question', front, setFront, 2)}
                {/* What the card shows WITH the question — a phrasebook asks
                    "French" over "Hello", a vocabulary deck shows the word in a sentence.
                    Its own field, not a line among the answer's supporting
                    lines: the card shows it before the flip, not after. */}
                {field('With the question', extraFront, setExtraFront, 2,
                    'Shown under the question before the flip — the phrase being asked for, the word in a sentence.')}
                {field('Answer', back, setBack, 2)}
                {field('Supporting lines', extra, setExtra, 3,
                    'Shown under the answer — a reading, an example sentence, its translation. One per line.')}

                <div className="flex items-center gap-2 pt-1">
                    <button
                        onClick={save}
                        disabled={busy || !dirty}
                        className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-white font-medium hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                    >
                        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                        {t("Save")}
                    </button>
                    <button
                        onClick={onClose}
                        disabled={busy}
                        className="rounded-lg border border-slate-200 dark:border-slate-600 px-4 py-2.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50"
                    >
                        {t("Cancel")}
                    </button>
                    <button
                        onClick={remove}
                        disabled={busy}
                        aria-label={t("Delete this card")}
                        title={t("Delete this card")}
                        className="rounded-lg border border-red-200 dark:border-red-900 px-3 py-2.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>
        </Modal>
    );
}
