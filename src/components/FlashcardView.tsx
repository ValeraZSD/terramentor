import { useState, useRef } from 'react';
import { api } from '../api';
import { onActivateKey } from '../utils/a11y';
import { Flashcard } from '../types';
import { parseCardMedia } from './CardMedia';
import CardFace from './CardFace';
import FlashcardEditor from './FlashcardEditor';
import { ArrowLeft, RotateCcw, ThumbsUp, Pencil, Undo2 } from 'lucide-react';
import { useReviewQueue } from '../hooks/useReviewQueue';
import { useFlashcardKeys } from '../hooks/useFlashcardKeys';
import { computeSrsUpdate, computeNextInterval, formatInterval, srsSnapshot, requeueAt, ReviewRating } from '../utils/srs';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';

interface Props {
    flashcards: Flashcard[];
    onClose: () => void;
    onDelete: (id: number) => void;
}

const RATINGS: { rating: ReviewRating; label: string; cls: string }[] = [
    { rating: 'again', label: k("Again"), cls: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50' },
    { rating: 'hard', label: k("Hard"), cls: 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 hover:bg-orange-200' },
    { rating: 'good', label: k("Good"), cls: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400 hover:bg-yellow-200' },
    { rating: 'easy', label: k("Easy"), cls: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 hover:bg-green-200' },
];

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
    const undoSnapshots = useRef<{ index: number; snapshot: Record<string, unknown> | null }[]>([]);
    const [undoing, setUndoing] = useState(false);
    const [editing, setEditing] = useState(false);
    const [edits, setEdits] = useState<Record<number, Flashcard>>({});
    const stored = flashcards[queue.index];
    // A card edited in this session is shown as edited without a reload —
    // `flashcards` is owned by the caller and only refetched when the session
    // closes, so the local override is what keeps the card on screen honest.
    const currentCard = stored ? { ...stored, ...(edits[stored.id] ?? {}) } : stored;
    const media = parseCardMedia(currentCard?.media);

    const handleRate = async (rating: ReviewRating) => {
        if (!currentCard) return;
        const snapshot = srsSnapshot(currentCard as unknown as Record<string, unknown>);
        const update = computeSrsUpdate(currentCard, rating);
        let wrote = false;
        try {
            const saved = await api.updateFlashcard(currentCard.id, update);
            // The saved row is folded into `edits` for the same reason the
            // session surface keeps its array in step: a card on a (re)learning
            // ladder is rated again in this same session, and computing that
            // second rating from the pre-review state would restart the ladder.
            // `edits` is already the local-override layer `currentCard` reads.
            setEdits(prev => ({ ...prev, [currentCard.id]: { ...currentCard, ...saved } }));
            wrote = true;
        } catch (error) {
            console.error('Failed to update flashcard:', error);
        }
        // The step is recorded either way, because the queue advances either way
        // and the undo stack has to stay in lockstep with the queue's history —
        // a step present in one and missing from the other makes every earlier
        // undo restore the wrong card. A failed write left nothing to put back,
        // hence the null snapshot; and it scheduled nothing, so there is no
        // ladder to requeue onto.
        undoSnapshots.current.push({ index: queue.index, snapshot: wrote ? snapshot : null });
        queue.advance(wrote ? requeueAt(update) : null);
    };

    /** Put the previous card's schedule back and return to it. */
    const handleUndo = async () => {
        if (undoing || !queue.canGoBack) return;
        const step = undoSnapshots.current[undoSnapshots.current.length - 1];
        if (!step) return;
        const card = flashcards[step.index];
        setUndoing(true);
        try {
            // A skipped card has no snapshot: nothing was written, so there is
            // nothing to put back and stepping the queue is the whole undo.
            if (card && step.snapshot) {
                const restored = await api.updateFlashcard(card.id, step.snapshot as Partial<Flashcard>);
                setEdits(prev => ({ ...prev, [card.id]: { ...card, ...(prev[card.id] ?? {}), ...restored } }));
            }
            // Popped after the write lands, so a failed restore leaves the step
            // on the stack and the screen honest.
            undoSnapshots.current.pop();
            queue.back();
        } catch (error) {
            console.error('Failed to undo review:', error);
        } finally {
            setUndoing(false);
        }
    };

    useFlashcardKeys({
        enabled: !editing,
        flipped: queue.flipped,
        onFlip: () => queue.setFlipped(f => !f),
        onRate: (i) => handleRate(RATINGS[i].rating),
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
                className="flex-1 min-h-[200px] cursor-pointer select-none rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
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
                        {RATINGS.map(({ rating, label, cls }) => (
                            <button
                                key={rating}
                                onClick={() => handleRate(rating)}
                                className={`flex-1 py-3 rounded-xl flex flex-col items-center gap-0.5 ${cls}`}
                            >
                                <span className="font-medium">{t(label)}</span>
                                <span className="text-[10px] opacity-70">
                                    {formatInterval(computeNextInterval(currentCard, rating).intervalDays)}
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