import { useState, useCallback, useEffect } from 'react';
import { holdReload } from '../utils/freshness';

/**
 * Shared review-queue navigation for flashcard sessions.
 *
 * Both the node-level (`FlashcardView`) and project-level
 * (`GlobalFlashcardReview`) review surfaces previously reimplemented this
 * logic by hand, with subtle stale-closure and off-by-one differences. This
 * hook is the single implementation.
 *
 * ## Cards that come back inside the session
 *
 * FSRS's (re)learning steps schedule in minutes: "Again" on a mature card is
 * due in ten, not tomorrow. Every other layer can honour that by writing a
 * timestamp, but the queue could not — `advance()` marked a card reviewed and
 * `isComplete` fired at `reviewed.size >= total`, so a rated card never came
 * round again no matter what its due date said. Turning short-term steps on
 * without this would have scheduled the repetition and then not shown it, which
 * is worse than not having it at all: the card would be due, invisible until
 * the next session, and counted against the day's budget.
 *
 * So `advance(requeueAt)` takes the timestamp the card is next due at. Given
 * one, the card is NOT marked reviewed; it goes into `pending` and is served
 * again later in this session. `advance()` with nothing is a card leaving for a
 * future day, exactly as before.
 *
 * **Order of preference, which is Anki's own** (its manual: learning cards "are
 * fetched from all decks at once and shown in the order they are due"): a
 * pending card whose time has come, oldest due first; then the next card never
 * seen; then — when nothing new is left — the earliest-due pending card,
 * *provided it is within `LEARN_AHEAD_MS`*.
 *
 * That last clause is Anki's **learn ahead limit**, and it is a real fork rather
 * than a detail. Serving early costs a little: answering a card while it is
 * still well remembered earns a shorter interval than waiting would have.
 * Refusing to serve early costs a lot: the session ends on a card the learner
 * cannot reach, and they are asked to sit and watch a clock. Anki's answer is a
 * 20-minute window, chosen so the default learning steps all fall inside it —
 * i.e. in ordinary use the card is always shown early, and the limit exists for
 * the collection whose steps are longer than a coffee break. Ours are 1m/10m/10m,
 * so it never binds today; it is here so that a longer ladder degrades into
 * "come back in 40 minutes" rather than into an hour of pretending.
 *
 * When it does bind, `waitingUntil` is the moment the next card is ready. The
 * hook wakes itself up then — a queue that needs its caller to poll it is a
 * queue that will be polled wrongly.
 */

/**
 * How far ahead a (re)learning card may be pulled when nothing else is left.
 * Anki's default, and its reasoning: long enough that every default step falls
 * inside it, short enough that "study ahead" never quietly becomes "study the
 * whole deck".
 */
export const LEARN_AHEAD_MS = 20 * 60_000;
export interface ReviewQueue {
    index: number;
    flipped: boolean;
    reviewedCount: number;
    total: number;
    isComplete: boolean;
    /** How many cards are on a (re)learning ladder and will come round again. */
    pendingCount: number;
    /**
     * Epoch ms at which the next card becomes servable, when every card has been
     * dealt with and the only ones left are further out than `LEARN_AHEAD_MS`.
     * `null` whenever there is something to show right now — which, with the
     * default ladder, is always. The session is neither finished nor stuck while
     * this is set: it is waiting, and it says so.
     */
    waitingUntil: number | null;
    /** Serve the earliest pending card now, ignoring the learn-ahead limit. */
    serveNow: () => void;
    setFlipped: React.Dispatch<React.SetStateAction<boolean>>;
    /**
     * Mark the current card done and move on.
     *
     * `requeueAt` (epoch ms) keeps it in the session instead: the card is due
     * again at that moment and will be served once every card never seen has
     * been. Pass nothing for a card that has left for a later day.
     */
    advance: (requeueAt?: number | null) => void;
    /** Move to the next unreviewed card without marking the current one reviewed. */
    skip: () => void;
    /** Restart the session from the beginning. */
    reset: () => void;
    /**
     * Step back to the card left by the last `advance`/`skip` and un-review it.
     * Returns that card's index, or null when there is nothing to go back to —
     * the caller uses it to look up what to undo. See `canGoBack`.
     */
    back: () => number | null;
    /** True while there is a step to take back. */
    canGoBack: boolean;
    /** Which card `back()` would return to, without moving. Lets a caller look
     *  up (and undo) what it is about to step onto BEFORE the queue moves. */
    peekBack: number | null;
    /**
     * Forget the history. For a step that cannot be taken back — a DELETED card
     * is gone, so stepping past it would land on a card that no longer exists.
     */
    clearHistory: () => void;
}

/**
 * One step taken, and enough of the queue's state to put it back exactly.
 *
 * A card can leave the current position in three different ways — reviewed,
 * requeued onto a ladder, or skipped — so "un-review it" is not a single
 * action. Recording which one happened is the difference between an undo and an
 * undo that mostly works: taking back the Again that put a card into relearning
 * has to remove it from `pending` as well as return the cursor to it.
 */
interface Step {
    index: number;
    /** The card's `pending` due time before this step, or null if it held none. */
    wasPendingAt: number | null;
    /** Whether this step added the card to `reviewed`. */
    markedReviewed: boolean;
}

/** The pending card due soonest, as `[index, dueAt]`; `[null, Infinity]` if none. */
function earliestPending(pd: Map<number, number>): [number | null, number] {
    let soonest: number | null = null;
    let soonestAt = Infinity;
    for (const [i, at] of pd) {
        if (at < soonestAt) { soonest = i; soonestAt = at; }
    }
    return [soonest, soonestAt];
}

export function useReviewQueue(total: number): ReviewQueue {
    // A session in progress outranks a pending update. The ratings themselves are
    // already written, but the queue — what has been requeued to "soon", what the
    // undo stack still holds — lives only here, and a reload would silently end
    // the session mid-deck. `UpdatePrompt` shows its banner instead.
    useEffect(() => (total > 0 ? holdReload('review-session') : undefined), [total > 0]);

    const [index, setIndex] = useState(0);
    const [flipped, setFlipped] = useState(false);
    const [reviewed, setReviewed] = useState<Set<number>>(new Set());
    /**
     * Cards on a (re)learning ladder: index → the epoch ms they are next due.
     * Deliberately not part of `reviewed`, so the progress readout counts cards
     * that have genuinely left the session rather than cards that have been
     * touched once.
     */
    const [pending, setPending] = useState<Map<number, number>>(new Map());
    /**
     * The cards left behind, newest last. A review session is the one surface
     * in this app where a single mis-tap is unrecoverable — the rating has
     * already been written to the card's schedule and the queue never returns
     * to it — so the way back is part of the queue, not a feature bolted onto
     * one screen. Indices, because the queue tracks position by index and the
     * card array is never spliced (see `handleDeleted`).
     */
    const [history, setHistory] = useState<Step[]>([]);
    /** The learner has chosen to be served early; see `waitingUntil` below. */
    const [waitingOverride, setWaitingOverride] = useState(false);

    /**
     * Where to go next, given the state this step is about to produce.
     *
     * Takes the post-step sets rather than reading them from the closure: React
     * state is not yet updated when this runs, and computing "the next card"
     * from the previous card's world is exactly the off-by-one this hook exists
     * to have only one copy of.
     */
    const findNext = (
        from: number,
        rv: Set<number>,
        pd: Map<number, number>,
        now: number,
        ignoreLimit = false,
    ): number | null => {
        const settled = (i: number) => rv.has(i) || pd.has(i);
        // 1. A ladder card whose minute has arrived, oldest due first.
        let ready: number | null = null;
        let readyAt = Infinity;
        for (const [i, at] of pd) {
            if (at <= now && at < readyAt) { ready = i; readyAt = at; }
        }
        if (ready !== null) return ready;
        // 2. The next card nobody has seen, wrapping once.
        for (let i = from + 1; i < total; i++) if (!settled(i)) return i;
        for (let i = 0; i <= from; i++) if (!settled(i)) return i;
        // 3. Nothing new left: the ladder card due soonest, served early rather
        //    than making the learner watch a clock — but only inside the
        //    learn-ahead window. Past it, null means "wait", not "finished".
        const [soonest, soonestAt] = earliestPending(pd);
        if (soonest === null) return null;
        return ignoreLimit || soonestAt - now <= LEARN_AHEAD_MS ? soonest : null;
    };

    const step = useCallback((requeueAt: number | null, markReviewed: boolean) => {
        setFlipped(false);
        setWaitingOverride(false);
        const wasPendingAt = pending.has(index) ? (pending.get(index) as number) : null;

        const nextReviewed = new Set(reviewed);
        const nextPending = new Map(pending);
        // A card being served off the ladder is off it until this step says
        // otherwise — deleting first means a requeue re-adds with a new time and
        // a graduation leaves it out, without a branch for each case.
        nextPending.delete(index);
        if (requeueAt != null) nextPending.set(index, requeueAt);
        else if (markReviewed) nextReviewed.add(index);

        setReviewed(nextReviewed);
        setPending(nextPending);
        setHistory(h => [...h, {
            index, wasPendingAt,
            markedReviewed: markReviewed && requeueAt == null,
        }]);

        const target = findNext(index, nextReviewed, nextPending, Date.now());
        if (target !== null && target !== index) setIndex(target);
    }, [reviewed, pending, index, total]);

    const advance = useCallback((requeueAt: number | null = null) => {
        step(requeueAt ?? null, true);
    }, [step]);

    const skip = useCallback(() => {
        setFlipped(false);
        // A skip settles nothing: the card keeps whatever ladder position it had
        // and is simply passed over.
        const target = findNext(index, reviewed, pending, Date.now());
        if (target === null || target === index) return;
        setIndex(target);
        // Recorded even though nothing was written: "I skipped that by mistake"
        // is the same wish as "I rated that by mistake".
        setHistory(h => [...h, {
            index,
            wasPendingAt: pending.has(index) ? (pending.get(index) as number) : null,
            markedReviewed: false,
        }]);
    }, [reviewed, pending, index, total]);

    const reset = useCallback(() => {
        setIndex(0);
        setFlipped(false);
        setReviewed(new Set());
        setPending(new Map());
        setHistory([]);
        setWaitingOverride(false);
    }, []);

    const back = useCallback((): number | null => {
        if (history.length === 0) return null;
        const last = history[history.length - 1];
        setHistory(h => h.slice(0, -1));
        if (last.markedReviewed) {
            setReviewed(prev => {
                if (!prev.has(last.index)) return prev;
                const next = new Set(prev);
                next.delete(last.index);
                return next;
            });
        }
        // Put the ladder back exactly as it was: the step may have added the
        // card (an Again), moved it (a second Again on the same card), or taken
        // it off (a graduation). One restore covers all three.
        setPending(prev => {
            const had = prev.has(last.index) ? (prev.get(last.index) as number) : null;
            if (had === last.wasPendingAt) return prev;
            const next = new Map(prev);
            if (last.wasPendingAt == null) next.delete(last.index);
            else next.set(last.index, last.wasPendingAt);
            return next;
        });
        setIndex(last.index);
        // The answer is shown again: the learner has already seen it, and this
        // exists to correct the rating, not to re-ask the question.
        setFlipped(true);
        return last.index;
    }, [history]);

    const clearHistory = useCallback(() => setHistory([]), []);

    /**
     * Waiting, and waking up from it.
     *
     * `tick` exists only to re-run this: `waitingUntil` is a function of the
     * clock, and nothing else in the session changes when a minute passes. The
     * timer is capped at 30s per hop so a long wait still repaints a countdown
     * the learner can trust, and it is torn down the moment there is something
     * to serve.
     */
    const [tick, setTick] = useState(0);
    const unseen = total - reviewed.size - pending.size;
    const [soonest, soonestAt] = earliestPending(pending);
    // `waitingOverride` is the learner having pressed "show it now anyway".
    // Without it `serveNow` put the card on screen and left `waitingUntil` set,
    // so the session drew the waiting panel OVER the card it had just been asked
    // for — the state said "nothing to show" while something was being shown.
    // Cleared by the next rating, because that re-decides everything.
    const waitingUntil = !waitingOverride && unseen === 0 && soonest !== null
        && soonestAt - Date.now() > LEARN_AHEAD_MS
        ? soonestAt
        : null;

    useEffect(() => {
        if (soonest === null || unseen > 0 || waitingOverride) return;
        const wait = soonestAt - Date.now() - LEARN_AHEAD_MS;
        if (wait <= 0) {
            // Servable, and the last step left the cursor elsewhere (it returned
            // null because the window had not opened yet). Move to it.
            if (index !== soonest) { setIndex(soonest); setFlipped(false); }
            return;
        }
        const t = setTimeout(() => setTick(n => n + 1), Math.min(wait + 250, 30_000));
        return () => clearTimeout(t);
        // `tick` is a dependency on purpose: each expiry re-runs the check.
    }, [soonest, soonestAt, unseen, index, tick, waitingOverride]);

    const serveNow = useCallback(() => {
        const target = findNext(index, reviewed, pending, Date.now(), true);
        if (target === null) return;
        setFlipped(false);
        setWaitingOverride(true);
        if (target !== index) setIndex(target);
    }, [index, reviewed, pending, total]);

    return {
        index,
        flipped,
        setFlipped,
        reviewedCount: reviewed.size,
        total,
        // A card still on a ladder has not left the session, so a session with
        // one relearning card left is not complete however many have graduated.
        isComplete: total > 0 && reviewed.size >= total && pending.size === 0,
        pendingCount: pending.size,
        waitingUntil,
        serveNow,
        advance,
        skip,
        reset,
        back,
        canGoBack: history.length > 0,
        peekBack: history.length > 0 ? history[history.length - 1].index : null,
        clearHistory,
    };
}
