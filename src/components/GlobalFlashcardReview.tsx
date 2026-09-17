import { useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { onActivateKey } from '../utils/a11y';
import { usePortalAccent } from '../hooks/usePortalAccent';
import { usePhysicalKeyboard } from '../utils/platform';
import { api } from '../api';
import { Flashcard } from '../types';
import { parseCardMedia } from './CardMedia';
import CardFace from './CardFace';
import FlashcardEditor from './FlashcardEditor';
import { useStore } from '../store';
import { useReviewQueue } from '../hooks/useReviewQueue';
import { useFlashcardKeys } from '../hooks/useFlashcardKeys';
import { computeSrsUpdate, computeNextInterval, formatInterval, srsSnapshot, requeueAt, ReviewRating } from '../utils/srs';
import {
    ArrowLeft, RotateCcw, ThumbsUp, ThumbsDown, Brain,
    BookOpen, ChevronRight, CheckCircle2,
    Loader2, Sparkles, SkipForward, Pencil, Undo2, CircleStop
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';

interface EnrichedFlashcard extends Flashcard {
    node_title?: string;
    categoryTitle?: string;
    categoryId?: number | null;
    // Present only in the cross-project session (GET /api/flashcards/due).
    project_name?: string;
    project_color?: string;
}

interface Props {
    /** Omit for a cross-project session over every active project's due cards. */
    projectId?: number;
    /**
     * Where this session's cards come from. Defaults to the due-flashcard
     * endpoints, which is right for a curriculum project's handful of cards on a
     * topic — and wrong for a deck, where "never reviewed" is not "due" and the
     * queue has to be rationed (see server/decks.js). A deck passes its own
     * fetcher rather than this component learning what a deck is.
     */
    fetchCards?: () => Promise<EnrichedFlashcard[]>;
    /** Header label. A stage session says which stage it is. */
    title?: string;
    onClose: () => void;
    onComplete: () => void;
}

const DIFFICULTY_CONFIG: Record<ReviewRating, {
    label: string;
    color: string;
    bg: string;
    border: string;
    icon: typeof RotateCcw;
}> = {
    again: {
        label: k("Again"),
        color: 'text-red-700 dark:text-red-300',
        bg: 'bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50',
        border: 'border-red-300 dark:border-red-700',
        icon: RotateCcw,
    },
    hard: {
        label: k("Hard"),
        color: 'text-orange-700 dark:text-orange-300',
        bg: 'bg-orange-100 dark:bg-orange-900/30 hover:bg-orange-200 dark:hover:bg-orange-900/50',
        border: 'border-orange-300 dark:border-orange-700',
        icon: ThumbsDown,
    },
    good: {
        label: k("Good"),
        color: 'text-emerald-700 dark:text-emerald-300',
        bg: 'bg-emerald-100 dark:bg-emerald-900/30 hover:bg-emerald-200 dark:hover:bg-emerald-900/50',
        border: 'border-emerald-300 dark:border-emerald-700',
        icon: ThumbsUp,
    },
    easy: {
        label: k("Easy"),
        color: 'text-blue-700 dark:text-blue-300',
        bg: 'bg-blue-100 dark:bg-blue-900/30 hover:bg-blue-200 dark:hover:bg-blue-900/50',
        border: 'border-blue-300 dark:border-blue-700',
        icon: Sparkles,
    },
};

const RATING_ORDER: ReviewRating[] = ['again', 'hard', 'good', 'easy'];

/**
 * What a step back has to put back.
 *
 * A rating is written to the server the moment it is pressed, so undo is not a
 * UI state change — it is a restore. The snapshot is taken from the card the
 * client already holds, before the update is sent, which is why this needs no
 * schema change and no server-side history: every field the scheduler touches
 * is on the row we are looking at. `review_count` is in it because the endpoint
 * bumps that whenever `last_reviewed` is stamped, and putting a card back has to
 * put the tally back too.
 *
 * A skip wrote nothing, so its record carries no snapshot.
 *
 * **These are a STACK, not a map keyed by card.** They used to be keyed by the
 * card's index, which was sound only while a card could be rated at most once
 * per session. (Re)learning steps make a second rating of the same card the
 * normal case, and a map lets the second snapshot overwrite the first: undoing
 * twice then restored the state before the second rating and, on the way back
 * past the first, found nothing to restore and silently moved the cursor over a
 * rating that still stood. One entry per step, popped in step order, is the only
 * shape that matches `history`.
 */
type UndoStep =
    | { kind: 'rate'; index: number; rating: ReviewRating; snapshot: Partial<Flashcard> }
    | { kind: 'skip'; index: number };



/**
 * A review session takes the whole screen.
 *
 * It used to render inside the workspace, under the app header AND the
 * workspace's own tab rail — three stacked bars. Measured at 412x686 (the
 * phone this is actually studied on) that was 170px of chrome above the card
 * and a 146px rating footer below it, leaving the thing being studied 278px:
 * 41% of the screen, for the only content on it. A session is a mode, not a
 * page inside a project — the learner is doing one thing, hundreds of times in
 * a row — so it takes the surface, and closing it puts the dashboard back
 * exactly where it was.
 *
 * `z-[45]` sits above the TaskDock (z-40) and below dialogs (z-50). The dock
 * normally wins that argument so a running generation stays visible, but it is
 * pinned bottom-centre, which is precisely where the four rating buttons are;
 * covering the control pressed hundreds of times a session to show a progress
 * chip is the wrong trade. It reappears the moment the session closes.
 */
const SURFACE = 'fixed inset-0 z-[45] flex flex-col overflow-hidden bg-slate-100 dark:bg-slate-900';

/**
 * …and it is rendered at the end of the BODY, never where it was written.
 *
 * `inset: 0` is only half of "the whole screen": the box is still a child of
 * whatever element it was written in, and a MARGIN still applies to it. The
 * deck screen stacks its panels with Tailwind's `space-y-*`, which is a margin
 * on every sibling after the first (`> :not([hidden]) ~ :not([hidden])`) — and
 * a session started from there was written as one of those siblings, so it
 * inherited `margin-top: 24px`: the surface began 24px down the screen and the
 * app header showed above it, sliced in half, for the whole session.
 *
 * The same escape as `Modal`, for one more reason besides: `opacity`,
 * `transform` and `filter` on any ancestor would make that ancestor the
 * containing block, and a surface that claims the screen must not depend on
 * which screen opened it.
 */
function SessionSurface({ className = '', children }: { className?: string; children: ReactNode }) {
    const { anchor, accent } = usePortalAccent(true);
    return (
        <>
            <span ref={anchor} hidden aria-hidden="true" />
            {createPortal((
                <div className={className ? `${SURFACE} ${className}` : SURFACE} style={accent}>
                    {children}
                </div>
            ), document.body)}
        </>
    );
}

/**
 * The two chips at the top of a card.
 *
 * They used to be two hand-written spans and they had visibly drifted apart —
 * `tracking-widest` against `tracking-wider`, so the same 10px uppercase label
 * was set at two different letter-spacings a few hundred pixels apart. They
 * sit side by side on the same row, which is the one place a reader will
 * actually notice, and the difference read as "these are two different kinds of
 * thing" when they are the same kind of thing: a one-word tag on this card.
 *
 * So the geometry lives in ONE place and only the tone varies. Colour still
 * means something — accent for the flipped state (matching the card's own
 * border), the traffic-light scale for difficulty — but a tone is a fill and a
 * text colour, never a different shape.
 */
type ChipTone = 'neutral' | 'accent' | 'easy' | 'medium' | 'hard';

const CHIP_TONE: Record<ChipTone, string> = {
    neutral: 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
    accent: 'bg-accent/20 dark:bg-accent/25 text-accent-fg',
    easy: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400',
    medium: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
    hard: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
};

function CardChip({ tone, children }: { tone: ChipTone; children: React.ReactNode }) {
    return (
        <span className={`text-[10px] uppercase tracking-widest font-semibold px-2 py-1 rounded-md ${CHIP_TONE[tone]}`}>
            {children}
        </span>
    );
}

/**
 * "in about 4 minutes" — the only place in this app that counts DOWN.
 *
 * Rounded up and hedged on purpose: the exact second is not information the
 * learner can act on, and a countdown ticking through 0:03, 0:02 invites them to
 * sit and watch it, which is precisely the behaviour the learn-ahead limit
 * exists to avoid.
 */
function readyIn(at: number, now: number): string {
    const mins = Math.max(1, Math.ceil((at - now) / 60_000));
    return mins === 1 ? 'in about a minute' : `in about ${mins} minutes`;
}

/** Higher difficulty = harder card (the app's 0-5 display value, derived from
 *  FSRS). Kept beside the chip so the label and the colour cannot disagree. */
const difficultyTone = (d: number): ChipTone => (d >= 3 ? 'hard' : d >= 2 ? 'medium' : 'easy');
const difficultyLabel = (d: number): string => (d >= 3 ? k("Hard") : d >= 2 ? k("Medium") : k("Easy"));

export default function GlobalFlashcardReview({ projectId, fetchCards, title, onClose, onComplete }: Props) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const hasKeyboard = usePhysicalKeyboard();

    const [cards, setCards] = useState<EnrichedFlashcard[]>([]);
    const [loading, setLoading] = useState(true);
    const [skipped, setSkipped] = useState(0);
    const [removed, setRemoved] = useState(0);
    const [editing, setEditing] = useState(false);
    const [endedEarly, setEndedEarly] = useState(false);
    const [results, setResults] = useState<Record<ReviewRating, number>>({
        again: 0, hard: 0, good: 0, easy: 0,
    });

    const queue = useReviewQueue(cards.length);
    // One entry per step taken, newest last — the same shape as the queue's own
    // history, so the two cannot drift. The index it carries stays meaningful
    // because `cards` is never spliced (see `handleDeleted`).
    const undoSteps = useRef<UndoStep[]>([]);
    const [undoing, setUndoing] = useState(false);

    useEffect(() => {
        loadDueCards();
        // `fetchCards` is a closure the caller rebuilds each render, so it is
        // deliberately not a dependency — a session must not reload itself out
        // from under the learner because its parent re-rendered.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    const loadDueCards = async () => {
        setLoading(true);
        try {
            const dueCards = fetchCards
                ? await fetchCards()
                : projectId != null
                    ? await api.getDueFlashcards(projectId)
                    : await api.getAllDueFlashcards();
            setCards(dueCards);
        } catch (e: any) {
            addToast('error', t("Failed to load flashcards"), e.message);
        } finally {
            setLoading(false);
        }
    };

    const currentCard = cards[queue.index];
    const cardMedia = parseCardMedia(currentCard?.media);

    const handleRate = useCallback(async (rating: ReviewRating) => {
        if (!currentCard) return;
        const snapshot = srsSnapshot(currentCard as unknown as Record<string, unknown>) as Partial<Flashcard>;
        const update = computeSrsUpdate(currentCard, rating);
        try {
            const saved = await api.updateFlashcard(currentCard.id, update);
            // Keep the local row in step with the server, or a second rating of
            // the same card in one session would be computed from stale state.
            // This is load-bearing now rather than merely tidy: a card on a
            // (re)learning ladder IS rated more than once per session.
            setCards(prev => prev.map(c => (c.id === currentCard.id ? { ...c, ...saved } : c)));
            undoSteps.current.push({ kind: 'rate', index: queue.index, rating, snapshot });
            setResults(prev => ({ ...prev, [rating]: prev[rating] + 1 }));
            // A rating that leaves the card on a (re)learning step schedules it
            // minutes out, not days: it stays in the session and comes round
            // again. `requeueAt` reads FSRS's state rather than thresholding the
            // interval, because a relearning card can be scheduled a day out and
            // still belong on the ladder.
            queue.advance(requeueAt(update));
        } catch (e: any) {
            addToast('error', t("Failed to update card"), e.message);
        }
    }, [currentCard, queue, addToast]);

    /**
     * Take back the last rating — the one thing in this app a single mis-tap
     * used to make permanent. The rating is already on the server, so this
     * writes the pre-review snapshot back before stepping the queue: undo that
     * only moved the cursor would leave the card scheduled by a rating the
     * learner has just been told was undone.
     *
     * The write goes first for the same reason: if it fails, nothing moves and
     * the screen still describes the truth.
     */
    const handleUndo = useCallback(async () => {
        if (undoing || !queue.canGoBack) return;
        const step = undoSteps.current[undoSteps.current.length - 1];
        if (!step) return;
        const card = cards[step.index];
        setUndoing(true);
        try {
            if (step.kind === 'rate' && card) {
                const restored = await api.updateFlashcard(card.id, step.snapshot);
                setCards(prev => prev.map(c => (c.id === card.id ? { ...c, ...restored } : c)));
                setResults(prev => ({ ...prev, [step.rating]: Math.max(0, prev[step.rating] - 1) }));
            } else if (step.kind === 'skip') {
                setSkipped(n => Math.max(0, n - 1));
            }
            // Popped only once the restore has landed: a failed write leaves the
            // step on the stack and the screen still describing the truth.
            undoSteps.current.pop();
            queue.back();
        } catch (e: any) {
            addToast('error', t("Couldn't undo that"), e.message);
        } finally {
            setUndoing(false);
        }
    }, [undoing, queue, cards, addToast]);

    const handleSkip = () => {
        undoSteps.current.push({ kind: 'skip', index: queue.index });
        setSkipped(s => s + 1);
        queue.skip();
    };

    // A deleted card is treated as reviewed rather than spliced out of `cards`:
    // the queue tracks its position by INDEX, so removing an element mid-session
    // would silently renumber every card it has already seen.
    const handleDeleted = useCallback(() => {
        setRemoved(n => n + 1);
        queue.advance();
        // Nothing before this point can be stepped back to any more: the card
        // just removed is still in `cards` (indices must stay stable) but no
        // longer on the server, so walking back over it would offer to restore
        // a row that isn't there.
        queue.clearHistory();
        undoSteps.current = [];
    }, [queue]);

    const handleSaved = useCallback((saved: Flashcard) => {
        setCards(prev => prev.map(c => (c.id === saved.id ? { ...c, ...saved } : c)));
    }, []);

    useFlashcardKeys({
        // The editor owns the keyboard while it is open, or typing a card's
        // answer would flip the card under the dialog and rate it "1".
        enabled: !editing,
        flipped: queue.flipped,
        onFlip: () => queue.setFlipped(f => !f),
        onRate: (i) => handleRate(RATING_ORDER[i]),
        onUndo: handleUndo,
    });

    const sessionComplete = !loading && (cards.length === 0 || queue.isComplete || endedEarly);
    /**
     * Every card has been answered and the only ones left are further out than
     * the learn-ahead window. This is neither "finished" nor a stuck screen, and
     * showing either of those would be a lie — so it gets its own state, with
     * the two things the learner can actually do about it.
     *
     * With the default 1m/10m ladder against a 20-minute window this is
     * unreachable; it is what a longer ladder degrades into. See
     * `LEARN_AHEAD_MS` in useReviewQueue.
     */
    const waiting = !loading && !sessionComplete && queue.waitingUntil !== null;

    if (loading) {
        return (
            <SessionSurface>
                <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                        <Loader2 className="w-10 h-10 text-accent-fg animate-spin mx-auto mb-4" />
                        <p className="text-slate-600 dark:text-slate-300 font-medium">{t("Loading due flashcards…")}</p>
                    </div>
                </div>
            </SessionSurface>
        );
    }

    if (waiting) {
        return (
            <SessionSurface className="items-center justify-center p-8">
                <div className="max-w-sm w-full text-center space-y-5">
                    <div className="w-20 h-20 mx-auto rounded-full flex items-center justify-center bg-slate-100 dark:bg-slate-700">
                        <RotateCcw className="w-10 h-10 text-slate-400" aria-hidden="true" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-slate-900 dark:text-white">{t("Nothing to show just yet")}</h2>
                        <p className="mt-2 text-slate-600 dark:text-slate-300">
                            {/* One sentence, one key. It used to be five — a count
                                phrase, "still being learned and", a bare "comes"
                                or "come", and the tail — and no language whose
                                verb agreement or word order differs from
                                English's could be written in those pieces. */}
                            {t("{{count}} cards are still being learned and come back {{readyIn}}.", {
                                count: queue.pendingCount,
                                readyIn: readyIn(queue.waitingUntil as number, Date.now()),
                            })}
                        </p>
                    </div>
                    <div className="flex flex-col gap-2">
                        {/* Answering early is not free — the card is still well
                            remembered, so FSRS earns it a shorter interval than
                            waiting would have. That is the learner's call, and
                            the button says which way it goes rather than hiding
                            the trade behind "Continue". */}
                        <button
                            onClick={queue.serveNow}
                            className="w-full px-5 py-2.5 bg-accent text-white rounded-xl hover:bg-accent/90 transition font-medium"
                        >
                            {t("Show them now anyway", { count: queue.pendingCount })}
                        </button>
                        <button
                            onClick={() => setEndedEarly(true)}
                            className="w-full px-5 py-2.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl transition font-medium"
                        >
                            {t("End session")}
                        </button>
                    </div>
                </div>
            </SessionSurface>
        );
    }

    if (sessionComplete) {
        const totalReviewed = results.again + results.hard + results.good + results.easy;
        // Three states reached this screen and only two messages existed, so
        // ending a session early with nothing reviewed announced "No Cards Due
        // - all flashcards are up to date", which is the one thing that is
        // certainly false: the cards are still due, the learner just left. It
        // also offered no way back in, because the resume button was gated on
        // having reviewed something - so a mis-tapped End session read as an
        // empty deck and stranded you on Done.
        const nothingDue = cards.length === 0;
        const remaining = cards.length - queue.reviewedCount;
        const stoppedShort = !nothingDue && endedEarly && !queue.isComplete && remaining > 0;
        // Cards finished, not buttons pressed. With a (re)learning ladder one
        // card can take three or four answers, and "you reviewed 92 flashcards"
        // out of a deck of 88 is a number that cannot be true. The answer count
        // is still worth having — it is the work done — so it rides along in
        // brackets, and only when the two actually differ.
        const finished = queue.reviewedCount;
        const reviewedLine = t("You reviewed {{count}} flashcards", { count: finished })
            + (totalReviewed > finished ? t(" ({{answers}} answers)", { answers: totalReviewed }) : '')
            + (skipped > 0 ? t(", skipped {{skipped}}", { skipped }) : '')
            + (removed > 0 ? t(", deleted {{removed}}", { removed }) : '');
        return (
            <SessionSurface className="items-center justify-center p-8 overflow-y-auto">
                <div className="max-w-md w-full text-center space-y-6">
                    <div className={`w-24 h-24 mx-auto rounded-full flex items-center justify-center ${totalReviewed > 0 && !stoppedShort ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-slate-100 dark:bg-slate-700'}`}>
                        {stoppedShort ? (
                            <CircleStop className="w-12 h-12 text-slate-400" />
                        ) : totalReviewed > 0 ? (
                            <CheckCircle2 className="w-12 h-12 text-emerald-500" />
                        ) : (
                            <BookOpen className="w-12 h-12 text-slate-400" />
                        )}
                    </div>

                    <div>
                        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
                            {nothingDue ? t("No Cards Due") : stoppedShort ? t("Session Paused") : t("Session Complete!")}
                        </h2>
                        <p className="text-slate-500 dark:text-slate-400 mt-2">
                            {nothingDue
                                ? t("All flashcards are up to date. Check back later!")
                                : stoppedShort
                                    ? `${t("{{count}} cards still due", { count: remaining })}${totalReviewed > 0 ? `. ${reviewedLine}` : ''}`
                                    : reviewedLine
                            }
                        </p>
                    </div>

                    {totalReviewed > 0 && (
                        <div className="flex flex-wrap justify-center gap-3">
                            {RATING_ORDER.map(rating => {
                                const config = DIFFICULTY_CONFIG[rating];
                                const count = results[rating];
                                if (count === 0) return null;
                                return (
                                    <div key={rating} className={`w-24 p-3 rounded-xl border ${config.border} ${config.bg}`}>
                                        <p className={`text-2xl font-bold ${config.color}`}>{count}</p>
                                        <p className={`text-xs font-medium ${config.color} mt-1`}>{t(config.label)}</p>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <div className="flex gap-3 justify-center">
                        {/* Resuming is not "Review Again": the queue still holds
                            its position and its history, so going back in must
                            not reload and restart at card 1. */}
                        {stoppedShort ? (
                            <button
                                onClick={() => setEndedEarly(false)}
                                className="flex items-center gap-2 px-5 py-2.5 bg-accent text-white rounded-xl hover:bg-accent/90 transition font-medium"
                            >
                                <ChevronRight className="w-4 h-4" />
                                {t("Resume session")}
                            </button>
                        ) : totalReviewed > 0 && (
                            <button
                                onClick={() => {
                                    undoSteps.current = [];
                                    queue.reset();
                                    setSkipped(0);
                                    setEndedEarly(false);
                                    setResults({ again: 0, hard: 0, good: 0, easy: 0 });
                                    loadDueCards();
                                }}
                                className="flex items-center gap-2 px-5 py-2.5 bg-accent text-white rounded-xl hover:bg-accent/90 transition font-medium"
                            >
                                <RotateCcw className="w-4 h-4" />
                                {t("Review Again")}
                            </button>
                        )}
                        <button
                            onClick={onComplete}
                            className="flex items-center gap-2 px-5 py-2.5 border border-slate-200 dark:border-slate-600 rounded-xl text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition font-medium"
                        >
                            {t("Done")}
                        </button>
                    </div>
                </div>
            </SessionSurface>
        );
    }

    if (!currentCard) return null;

    const progressPercent = cards.length > 0 ? Math.round((queue.reviewedCount / cards.length) * 100) : 0;

    return (
        <SessionSurface>
            {/* Header. ONE row, not a title over a subtitle: the second line
                cost 16px of a screen whose scarcest resource is vertical space,
                to repeat a word ("Flashcard Review") that the four rating
                buttons at the bottom already make obvious. The count is the
                part worth keeping, so it moves up onto the row. */}
            <div className="flex items-center gap-2 px-2 py-1.5 sm:px-6 sm:py-3 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 shrink-0">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    <button
                        onClick={onClose}
                        aria-label={t("Close review")}
                        className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg text-slate-500 dark:text-slate-400 transition shrink-0"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <Brain className="w-5 h-5 text-accent-fg shrink-0" aria-hidden="true" />
                    <h2 className="font-semibold text-slate-900 dark:text-white hidden sm:inline shrink-0 truncate">
                        {title ?? t("Flashcard Review")}
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 tabular-nums truncate">
                        <span className="sm:hidden">{Math.min(queue.reviewedCount + 1, cards.length)} / {cards.length}</span>
                        <span className="hidden sm:inline">
                            {t("{{min}} of {{length}} cards", { min: Math.min(queue.reviewedCount + 1, cards.length), length: cards.length })}
                            {skipped > 0 && t("• {{skipped}} skipped", { skipped })}
                            {removed > 0 && t("• {{removed}} deleted", { removed })}
                        </span>
                    </p>
                    {/* Why the count did not move. Rating a card Again puts it on
                        a (re)learning ladder: it is answered but not finished, so
                        it is deliberately NOT counted here — and a counter that
                        stands still after an answer reads as broken unless
                        something says what happened to the card. The icon is the
                        Again button's own, which is the whole explanation for
                        anyone who has just pressed it. */}
                    {queue.pendingCount > 0 && (
                        <span
                            className="flex items-center gap-1 shrink-0 text-xs font-medium tabular-nums px-1.5 py-0.5 rounded-md bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                            title={t("{{count}} cards will come round again in this session", { count: queue.pendingCount })}
                        >
                            <RotateCcw className="w-3 h-3" aria-hidden="true" />
                            <span className="sr-only">{t("Coming back again:")}{' '}</span>
                            {queue.pendingCount}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                    <div className={`text-xs text-slate-500 dark:text-slate-400 ${hasKeyboard ? 'block' : 'hidden'}`}>
                        <kbd className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-[10px]">Space</kbd> {t("flip")}
                        <span className="mx-1">•</span>
                        <kbd className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-[10px]">1-4</kbd> {t("rate")}
                        <span className="mx-1">•</span>
                        <kbd className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-[10px]">Z</kbd> {t("undo")}
                    </div>
                    {/* Undo. Rendered only when there IS a step back — a control
                        that is permanently there and permanently disabled is
                        furniture. It sits before Edit because it is the one
                        pressed in a hurry, right after the mis-tap. */}
                    {queue.canGoBack && (
                        <button
                            onClick={() => void handleUndo()}
                            disabled={undoing}
                            // The label is `hidden sm:inline`, so on a phone the
                            // button is an icon and a title attribute — neither
                            // of which a screen reader announces.
                            aria-label={t("Undo the last rating")}
                            className="flex items-center justify-center gap-1.5 px-3 py-1.5 touch:min-h-11 touch:min-w-11 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition disabled:opacity-50"
                            title={t("Go back to the previous card and take back its rating")}
                        >
                            {undoing
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : <Undo2 className="w-4 h-4" />}
                            <span className="hidden sm:inline">{t("Undo")}</span>
                        </button>
                    )}
                    {/* Fixing a card where you met it. A bad card is only ever
                        noticed mid-review, and "remember to fix it later" means
                        never. */}
                    <button
                        onClick={() => setEditing(true)}
                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 touch:min-h-11 touch:min-w-11 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition"
                        title={t("Edit or delete this card")}
                    >
                        <Pencil className="w-4 h-4" />
                        <span className="hidden sm:inline">{t("Edit")}</span>
                    </button>
                    <button
                        onClick={handleSkip}
                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 touch:min-h-11 touch:min-w-11 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition"
                        title={t("Skip this card")}
                    >
                        <SkipForward className="w-4 h-4" />
                        <span className="hidden sm:inline">{t("Skip")}</span>
                    </button>
                    {/* The icon is not decoration here. Every button in this row
                        hides its label below `sm:`, so a button with no icon
                        renders as an EMPTY 44px tap target on a phone — present,
                        pressable, invisible. This one shipped without one. */}
                    <button
                        onClick={() => setEndedEarly(true)}
                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 touch:min-h-11 touch:min-w-11 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition"
                        title={t("End this review session")}
                        aria-label={t("End this review session")}
                    >
                        <CircleStop className="w-4 h-4" />
                        <span className="hidden sm:inline">{t("End session")}</span>
                    </button>
                </div>
            </div>

            {/* Progress bar */}
            <div className="h-1 bg-slate-200 dark:bg-slate-700 shrink-0">
                <div
                    className="h-full bg-gradient-to-r from-accent to-accent transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                />
            </div>

            {/* Card area. The CARD is the scroll region, and that is the whole
                fix: the frame around it (header, rating footer) never moves, so
                the four buttons stay under the thumb, while a card with three
                supporting lines, a picture and two clips scrolls INSIDE its own
                plate instead of overflowing it. Before, nothing scrolled and
                nothing was clipped either — the content simply overlapped
                itself and ran off the bottom of the card (see CardFace).

                There is deliberately no second scroller wrapping this one: a
                scroll region inside a scroll region on a phone means the
                browser guessing which one a drag meant, and it guesses wrong
                near the boundary. */}
            <div className="flex-1 min-h-0 flex justify-center p-2 sm:p-6">
                <div className="w-full max-w-2xl min-h-0 flex flex-col">
                    {/* Category context */}
                    {(currentCard.categoryTitle || currentCard.project_name) && (
                        <div className={`items-center justify-center gap-1.5 mb-3 flex-wrap ${projectId != null ? 'hidden sm:flex' : 'flex'}`}>
                            <span className="text-xs text-slate-500 dark:text-slate-400">{t("From:")}</span>
                            {currentCard.project_name && (
                                <>
                                    <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">
                                        <span
                                            className="w-2 h-2 rounded-full shrink-0"
                                            style={{ backgroundColor: currentCard.project_color || '#64748B' }}
                                            aria-hidden="true"
                                        />
                                        {currentCard.project_name}
                                    </span>
                                    {currentCard.categoryTitle && <ChevronRight className="w-3 h-3 text-slate-300 dark:text-slate-600" />}
                                </>
                            )}
                            {currentCard.categoryTitle && (
                                <span className="text-xs font-medium text-accent-fg bg-accent/10 px-2 py-0.5 rounded-full">
                                    {currentCard.categoryTitle}
                                </span>
                            )}
                            {currentCard.node_title && currentCard.node_title !== currentCard.categoryTitle && (
                                <>
                                    <ChevronRight className="w-3 h-3 text-slate-300 dark:text-slate-600" />
                                    <span className="text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">
                                        {currentCard.node_title}
                                    </span>
                                </>
                            )}
                        </div>
                    )}

                    {/* The card */}
                    {/* The card is one surface in the THEME's colour on both
                        sides. Accent belongs to the things that are accents —
                        the ANSWER chip, the answer line, a playing clip — not
                        to the whole plate behind them: tinting the block makes
                        every picture on it look like it is sitting in a
                        coloured box, and turns "flipped" into a change of
                        wallpaper rather than a change of content.

                        `focus-visible` only, and no ring on a mouse click: the
                        card is a div with a tabindex, so clicking it drew a
                        hard focus box around the whole thing. Keyboard users
                        still get a visible ring. */}
                    <div
                        onClick={() => queue.setFlipped(!queue.flipped)}
                        onKeyDown={onActivateKey(() => queue.setFlipped(!queue.flipped))}
                        role="button"
                        tabIndex={0}
                        aria-label={t("Flip flashcard")}
                        className="cursor-pointer select-none flex-1 min-h-0 flex flex-col rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                    >
                        <div className={`flex flex-1 min-h-0 flex-col rounded-2xl border-2 transition-colors duration-300 bg-white dark:bg-slate-800 shadow-lg shadow-slate-200/50 dark:shadow-slate-900/30 ${queue.flipped
                            ? 'border-accent/40'
                            : 'border-slate-200 dark:border-slate-600'
                            }`}>
                            {/* The two chips are a real row, not absolute
                                overlays. Pinned to the plate they would have
                                sat ON the card's first line the moment the
                                content scrolled under them, and they were
                                costing 48px of top padding to clear. */}
                            <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2.5 sm:px-5 sm:pt-4">
                                <CardChip tone={queue.flipped ? 'accent' : 'neutral'}>
                                    {queue.flipped ? t("Answer") : t("Question")}
                                </CardChip>

                                {/* Difficulty badge (higher difficulty = harder card) */}
                                {currentCard.difficulty > 0 && (
                                    <CardChip tone={difficultyTone(currentCard.difficulty)}>
                                        {t(difficultyLabel(currentCard.difficulty))}
                                    </CardChip>
                                )}
                            </div>

                            {/* Content. Autoplay is right here — this is a
                                session the learner opened, and on a listening
                                card the clip IS the question.

                                `min-h-full` on the inner column is what makes
                                one rule serve both cases: a short card has free
                                space and `justify-center` centres it, while a
                                long card grows the column past the scrollport,
                                which leaves no free space to distribute — so
                                centring quietly stops applying instead of
                                pushing content out of both ends. */}
                            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-10 sm:py-6">
                                <div className="flex min-h-full flex-col justify-center">
                                    <CardFace
                                        front={currentCard.front}
                                        back={currentCard.back}
                                        extra={currentCard.extra}
                                        extraFront={currentCard.extra_front}
                                        flipped={queue.flipped}
                                        media={cardMedia}
                                        autoPlay
                                        size="review"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
            </div>

            {/* Rating footer. Outside the scroll area on purpose: these four
                buttons are the only thing the learner presses hundreds of times
                a session, so they are in the same place, at the same size, on
                every card — reachable by thumb without looking. They are laid
                out (not removed) before the flip, so revealing the answer never
                moves them either. */}
            <div className="shrink-0 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 pb-2 pt-1.5 sm:px-8 sm:py-3">
                <div className="w-full max-w-2xl mx-auto space-y-1.5 sm:space-y-2">
                        <p className="text-center text-xs sm:text-sm text-slate-500 dark:text-slate-400">
                            {queue.flipped ? (
                                t("How well did you know this?")
                            ) : (
                                hasKeyboard ? (
                                    <>{t("Click the card or press")}{' '}<kbd className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">Space</kbd> {t("to reveal the answer")}</>
                                ) : (
                                    t("Tap the card to reveal the answer")
                                )
                            )}
                        </p>
                        <div className={`grid grid-cols-4 gap-2 sm:gap-3 transition-opacity ${queue.flipped ? '' : 'invisible opacity-0'}`} aria-hidden={!queue.flipped}>
                            {RATING_ORDER.map((rating, idx) => {
                                const config = DIFFICULTY_CONFIG[rating];
                                const Icon = config.icon;
                                const previewDays = computeNextInterval(currentCard, rating).intervalDays;
                                return (
                                    <button
                                        key={rating}
                                        onClick={() => handleRate(rating)}
                                        disabled={!queue.flipped}
                                        tabIndex={queue.flipped ? 0 : -1}
                                        className={`flex flex-col items-center gap-0.5 sm:gap-1 px-1 py-2 sm:px-3 sm:py-2.5 rounded-xl border-2 transition font-medium ${config.bg} ${config.border}`}
                                    >
                                        {/* The digit is a KEYCAP, not a rank —
                                            it names the key that presses this
                                            button. On a device with no keys it
                                            is a line of meaningless numerals
                                            across the busiest control in the
                                            app, so it follows the same rule as
                                            every other keyboard hint here
                                            (usePhysicalKeyboard, never a width
                                            breakpoint). */}
                                        {hasKeyboard && (
                                            <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">{idx + 1}</span>
                                        )}
                                        <Icon className={`w-5 h-5 ${config.color}`} />
                                        <span className={`text-sm font-semibold ${config.color}`}>{t(config.label)}</span>
                                        <span className="text-[10px] text-slate-500 dark:text-slate-400">{formatInterval(previewDays)}</span>
                                    </button>
                                );
                            })}
                        </div>
                </div>
            </div>

            {editing && currentCard && (
                <FlashcardEditor
                    card={currentCard}
                    onClose={() => setEditing(false)}
                    onSaved={handleSaved}
                    onDeleted={handleDeleted}
                />
            )}
        </SessionSurface>
    );
}