import { useState, useRef } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { onActivateKey } from '../utils/a11y';
import { Flashcard } from '../types';
import { parseCardMedia } from './CardMedia';
import CardFace from './CardFace';
import FlashcardEditor from './FlashcardEditor';
import { ArrowLeft, RotateCcw, ThumbsUp, Pencil, Undo2 } from 'lucide-react';
import { useReviewQueue } from '../hooks/useReviewQueue';
import { useFlashcardKeys } from '../hooks/useFlashcardKeys';
import { computeNextInterval, formatInterval, requeueAt, isStaleUndo, retryOrNew, ReviewRating, UnsentRating } from '../utils/srs';
import { useTranslation } from 'react-i18next';
import { RATING_ORDER, RATING_STYLES } from './flashcards/ratingStyles';

interface Props {
    flashcards: Flashcard[];
    onClose: () => void;
    onDelete: (id: number) => void;
}

export default function FlashcardView({ flashcards, onClose, onDelete }: Props) {
    const { t } = useTranslation();
    const queue = useReviewQueue(flashcards.length);
    /**
     * The scheduler state each rated card had before its rating, so the step can
     * be taken back. Same mechanism as the full review session — a mis-tap must
     * not be permanent on one surface and recoverable on the other, and for the
     * same reason it is a STACK rather than a map keyed by card index: with
     * (re)learning steps a card is rated more than once per session, and a map
     * lets the second snapshot overwrite the first.
     */
    const undoSnapshots = useRef<{ index: number; snapshot: Record<string, unknown> }[]>([]);
    const [undoing, setUndoing] = useState(false);
    const addToast = useStore(s => s.addToast);
    /**
     * A rating or an undo is on its way to the server. A REF, not state: two
     * presses inside one frame (a double click, a key and a click) both run
     * before a re-render, and both would read a `saving` state as false.
     */
    const writing = useRef(false);
    /** The rating write that failed, resent as-is if the same card gets the same rating (`retryOrNew`). */
    const unsent = useRef<UnsentRating | null>(null);
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState(false);
    const [edits, setEdits] = useState<Record<number, Flashcard>>({});
    const stored = flashcards[queue.index];
    // A card edited in this session is shown as edited without a reload —
    // `flashcards` is owned by the caller and only refetched when the session
    // closes, so the local override is what keeps the card on screen honest.
    const currentCard = stored ? { ...stored, ...(edits[stored.id] ?? {}) } : stored;
    const media = parseCardMedia(currentCard?.media);

    const handleRate = async (rating: ReviewRating) => {
        if (!currentCard || writing.current) return;
        writing.current = true;
        setSaving(true);
        try {
            // Built inside the try: a card whose stored state the scheduler
            // cannot read throws here, and outside it the lock stayed on for
            // the rest of the session.
            const { update, snapshot } = retryOrNew(unsent, currentCard, rating);
            const saved = await api.updateFlashcard(currentCard.id, update);
            unsent.current = null;
            // The saved row is folded into `edits` for the same reason the
            // session surface keeps its array in step: a card on a (re)learning
            // ladder is rated again in this same session, and computing that
            // second rating from the pre-review state would restart the ladder.
            // `edits` is already the local-override layer `currentCard` reads.
            setEdits(prev => ({ ...prev, [currentCard.id]: { ...currentCard, ...saved } }));
            // Only a rating the server took moves the session, and only it gets
            // an undo. A failed one used to advance anyway, so a session could
            // end "all reviewed" over ratings that were never stored; now the
            // card stays on screen to be rated again, as in the full session.
            undoSnapshots.current.push({ index: queue.index, snapshot });
            queue.advance(requeueAt(update));
        } catch (e: any) {
            addToast('error', t("Failed to update card"), e?.message);
        } finally {
            writing.current = false;
            setSaving(false);
        }
    };

    /** Put the previous card's schedule back and return to it. */
    const handleUndo = async () => {
        if (writing.current || !queue.canGoBack) return;
        const step = undoSnapshots.current[undoSnapshots.current.length - 1];
        if (!step) return;
        const card = flashcards[step.index];
        writing.current = true;
        setUndoing(true);
        try {
            if (card) {
                const restored = await api.updateFlashcard(card.id, step.snapshot as Partial<Flashcard>);
                setEdits(prev => ({ ...prev, [card.id]: { ...card, ...(prev[card.id] ?? {}), ...restored } }));
            }
            // Popped after the write lands, so a failed restore leaves the step
            // on the stack and the screen honest.
            undoSnapshots.current.pop();
            queue.back();
        } catch (e: any) {
            if (isStaleUndo(e)) {
                // Rated again since, in another tab or on another device: that
                // rating stands and this one can no longer be taken back, so
                // the step leaves the undo stack — the one before it still undoes.
                undoSnapshots.current.pop();
                queue.forgetLast();
                addToast('error', t("Couldn't undo that"), t("This card was reviewed again since, so that rating stays."));
            } else {
                addToast('error', t("Couldn't undo that"), e?.message);
            }
        } finally {
            writing.current = false;
            setUndoing(false);
        }
    };

    useFlashcardKeys({
        enabled: !editing,
        flipped: queue.flipped,
        onFlip: () => queue.setFlipped(f => !f),
        onRate: (i) => handleRate(RATING_ORDER[i]),
        onUndo: () => void handleUndo(),
    });

    if (queue.isComplete) {
        return (
            <div className="p-4 space-y-6">
                <button
                    onClick={onClose}
                    className="flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
                >
                    <ArrowLeft className="w-4 h-4" />
                    {t("Back")}
                </button>

                <div className="text-center py-12">
                    <div className="w-20 h-20 mx-auto bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
                        <ThumbsUp className="w-10 h-10 text-green-500" />
                    </div>
                    <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">{t("Session Complete!")}</h2>
                    <p className="text-slate-500 dark:text-slate-400 mt-2">{t("You reviewed all {{length}} flashcards", { count: flashcards.length, length: flashcards.length })}</p>

                    <div className="flex gap-3 mt-8 justify-center">
                        <button
                            onClick={() => queue.reset()}
                            className="flex items-center gap-2 px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent/90"
                        >
                            <RotateCcw className="w-5 h-5" />
                            {t("Study Again")}
                        </button>
                        <button
                            onClick={onClose}
                            className="px-4 py-2.5 border border-slate-200 dark:border-slate-600 rounded-xl text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
                        >
                            {t("Done")}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (!currentCard) return null;

    return (
        <div className="p-4 space-y-4 h-full flex flex-col">
            <div className="flex items-center justify-between">
                <button
                    onClick={onClose}
                    className="flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
                >
                    <ArrowLeft className="w-4 h-4" />
                    {t("Exit")}
                </button>
                <div className="flex items-center gap-3">
                    {queue.canGoBack && (
                        <button
                            onClick={() => void handleUndo()}
                            disabled={undoing}
                            aria-label={t("Undo the last rating")}
                            title={t("Go back to the previous card and take back its rating")}
                            className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 disabled:opacity-50"
                        >
                            <Undo2 className="w-4 h-4" />
                            {t("Undo")}
                        </button>
                    )}
                    <span className="text-sm text-slate-500 dark:text-slate-400">
                        {t("{{min}} of {{length}}", { min: Math.min(queue.reviewedCount + 1, flashcards.length), length: flashcards.length })}
                    </span>
                </div>
            </div>

            {/* Progress reflects cards actually reviewed, not the current card's
                position — otherwise the bar reads as already-full before the
                last card is rated. */}
            <div className="h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${(queue.reviewedCount / flashcards.length) * 100}%` }}
                />
            </div>

            {/* Card */}
            <div
                onClick={() => queue.setFlipped(f => !f)}
                onKeyDown={onActivateKey(() => queue.setFlipped(f => !f))}
                role="button"
                tabIndex={0}
                aria-label={t("Flip flashcard")}
                className="flex-1 min-h-[12.5rem] cursor-pointer select-none rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
                {/* One surface in the theme's colour on both sides — accent is
                    for the answer line and the controls, not for the plate. */}
                {/* The plate is bounded and its CONTENT scrolls — same rule as
                    the full review session. `min-h-full` centres a short card
                    and simply stops applying once the card is taller than the
                    plate, instead of overflowing out of both ends. */}
                <div className={`h-full overflow-y-auto overscroll-contain p-4 sm:p-6 rounded-2xl border-2 transition-colors duration-300 bg-white dark:bg-slate-800 ${queue.flipped
                    ? 'border-accent/40'
                    : 'border-slate-200 dark:border-slate-600'
                    }`}>
                    <div className="flex flex-col items-center justify-center min-h-full text-center">
                        <span className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                            {queue.flipped ? t("Answer") : t("Question")}
                        </span>
                        {/* A dedicated review session is the one place Anki's
                            autoplay is right: the learner opened it, and on a
                            listening card the clip IS the question. */}
                        <CardFace
                            front={currentCard.front}
                            back={currentCard.back}
                            extra={currentCard.extra}
                            extraFront={currentCard.extra_front}
                            flipped={queue.flipped}
                            media={media}
                            autoPlay
                            size="review"
                        />
                        {!queue.flipped && (
                            <p className="text-sm text-slate-500 dark:text-slate-400 mt-4">{t("Tap to reveal answer")}</p>
                        )}
                    </div>
                </div>
            </div>

            {/* Actions */}
            {queue.flipped && (
                <div className="space-y-3">
                    <p className="text-center text-sm text-slate-500">{t("How well did you know this?")}</p>
                    <div className="flex gap-2">
                        {RATING_ORDER.map(rating => (
                            <button
                                key={rating}
                                onClick={() => handleRate(rating)}
                                disabled={saving}
                                className={`flex-1 py-3 rounded-xl flex flex-col items-center gap-0.5 disabled:opacity-50 ${RATING_STYLES[rating].cls}`}
                            >
                                <span className="font-medium">{t(RATING_STYLES[rating].label)}</span>
                                <span className="text-xs">
                                    {formatInterval(computeNextInterval(currentCard, rating).intervalDays, t)}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Fix it where you met it — editing and deleting are the same
                door, because a card you want gone and a card you want corrected
                are noticed at the same moment and by the same glance. */}
            <button
                onClick={() => setEditing(true)}
                className="flex items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
                <Pencil className="w-4 h-4" />
                {t("Edit this card")}
            </button>

            {editing && currentCard && (
                <FlashcardEditor
                    card={currentCard}
                    onClose={() => setEditing(false)}
                    onSaved={saved => setEdits(prev => ({ ...prev, [saved.id]: saved }))}
                    onDeleted={id => {
                        // The caller owns the list and its own bookkeeping; the
                        // row is already gone from the server by now, so this
                        // only tells it to stop counting the card.
                        onDelete(id);
                        queue.advance();
                        // Nothing before this can be stepped back to: the card
                        // is still in `flashcards` (indices must stay stable)
                        // but gone from the server, so walking back over it
                        // would offer to restore a row that is not there.
                        queue.clearHistory();
                        undoSnapshots.current = [];
                    }}
                />
            )}
        </div>
    );
}