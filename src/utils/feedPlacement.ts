import type { FeedCard, LessonWrite } from '../types';

/**
 * The background pull's throttle, trailing. A signal that "something new
 * exists" inside the window (or while a page is still in flight, composed
 * before the new thing was written) is not dropped: it becomes ONE pull at the
 * end of the window. Dropped, the generator's last tick of a burst usually fell
 * inside the window of the tick before it, and the lesson it announced stayed
 * off the open page until some later signal or a reload.
 * `admit` answers whether the caller may pull now; when not, `retry` runs once,
 * later, and goes through `admit` again.
 */
export function pullGate(minMs: number, clock: { now: () => number; later: (fn: () => void, ms: number) => void } = {
    now: () => Date.now(),
    later: (fn, ms) => { setTimeout(fn, ms); },
}) {
    let last = -Infinity;
    let pending = false;
    return function admit({ busy = false, force = false }: { busy?: boolean; force?: boolean }, retry: () => void): boolean {
        const t = clock.now();
        const wait = busy ? minMs : force ? 0 : Math.max(0, last + minMs - t);
        if (wait === 0) { last = t; return true; }
        if (!pending) {
            pending = true;
            clock.later(() => { pending = false; retry(); }, wait);
        }
        return false;
    };
}

/** The topic a teaching card belongs to (flashcards are placed by the page's order). */
const topicOf = (c: FeedCard): number | null =>
    c.kind !== 'flashcard' && 'nodeId' in c && typeof c.nodeId === 'number' ? c.nodeId : null;

/** A card the page draws inside its topic's chapter (FeedView's `isChapterCard`):
 *  a landed lesson goes after one of these, never after a recall card drawn
 *  on its own. */
const chapterTopicOf = (c: FeedCard): number | null =>
    c.kind === 'lesson' || c.kind === 'question' || c.kind === 'checkpoint' || c.kind === 'practice' ? topicOf(c) : null;

/**
 * Merge a pulled page into the stream. Everything held keeps its order, and a
 * topic's checkpoint stays the END of its chapter:
 * - a pulled checkpoint goes straight after the last card its topic already
 *   has on screen; when this page carries teaching cards of that topic too,
 *   the server's order already ends the chapter and it is appended in place;
 * - a pulled teaching card of a topic whose checkpoint is on screen goes in
 *   just before that checkpoint (a lesson written while the page held only the
 *   Overview standing in for it), never under it.
 * - a pulled teaching card of `slotTopic`, whose first lesson the page was
 *   waiting on (`lessonPending`), goes after the topic's own chapter cards,
 *   not under a flashcard served after them. With
 *   `replaceStandIn` (the page showed only "Writing the lesson", so the
 *   Overview standing in for it was never on screen) the written lesson takes
 *   that stand-in's place, as a reload would serve it.
 * Anything else is appended in the page's order.
 */
export function placeCheckpoints(held: FeedCard[], fresh: FeedCard[], slotTopic: number | null = null, replaceStandIn = false): FeedCard[] {
    const out = [...held];
    const pulledTopics = new Set<number>();
    // Where the next card of the slot's topic goes; moves on as each lands.
    let slotAt = -1;
    const standIn = replaceStandIn && slotTopic != null && fresh.some(c => c.kind === 'lesson' && c.nodeId === slotTopic && !c.degraded)
        ? out.findIndex(c => c.kind === 'lesson' && c.nodeId === slotTopic && c.degraded)
        : -1;
    if (standIn >= 0) {
        out.splice(standIn, 1);
        slotAt = standIn;
    } else if (slotTopic != null) {
        for (let i = out.length - 1; i >= 0; i--) {
            if (chapterTopicOf(out[i]) === slotTopic) { slotAt = i + 1; break; }
        }
    }
    for (const c of fresh) {
        const topic = topicOf(c);
        if (c.kind === 'checkpoint') {
            let at = -1;
            if (!pulledTopics.has(c.nodeId)) {
                // After the topic's own chapter, never after a recall card of
                // the same topic: that one sits in the review round at the
                // top, and a checkpoint there would cut the round in two.
                for (let i = out.length - 1; i >= 0; i--) {
                    if (chapterTopicOf(out[i]) === c.nodeId) { at = i; break; }
                }
            }
            if (at < 0) out.push(c);
            else out.splice(at + 1, 0, c);
            continue;
        }
        // Flashcards are skipped here as in the lookup above: a pulled card of
        // topic 1 must not send checkpoint-1 below topic 2's cards.
        if (c.kind === 'flashcard' || topic == null) { out.push(c); continue; }
        pulledTopics.add(topic);
        const end = out.findIndex(o => o.kind === 'checkpoint' && o.nodeId === topic);
        if (end >= 0) out.splice(end, 0, c);
        else if (topic === slotTopic && slotAt >= 0) out.splice(slotAt++, 0, c);
        else out.push(c);
    }
    return out;
}

/**
 * What a page sends as held: every card on screen, plus the stand-in a landed
 * lesson replaced (`replaceStandIn`). The server reads a held `read-N` as "this
 * chapter closed over a stand-in, so what is written since still comes"
 * (composeFeed's `closedOverStandIn`); without it the question written just
 * after the lesson was refused once the checkpoint was held.
 */
export function heldKeys(cards: FeedCard[], replaced: readonly string[]): string[] {
    return [...cards.map(c => c.key), ...replaced];
}

/** Keys a merge left out of the held cards: the stand-in a lesson replaced. */
export function replacedKeys(before: FeedCard[], after: FeedCard[]): string[] {
    const kept = new Set(after.map(c => c.key));
    return before.filter(c => !kept.has(c.key)).map(c => c.key);
}

/** The written lesson of a topic on screen (not the Overview standing in for it). */
const hasLesson = (cards: FeedCard[], nodeId: number) =>
    cards.some(c => c.kind === 'lesson' && c.nodeId === nodeId && !c.degraded);

/**
 * The topic's first lesson is being written, or failed to be, and is not on
 * screen: the page shows "Writing the lesson" (or why it could not be, with
 * Try again) instead of the stream (no "Got it, continue" over an Overview
 * with no lesson behind it, no junction, no "Writing more lessons · 0%"). A
 * topic with no Overview at all is the same wait. The state comes only on the
 * topic's own page (`composeFeed`'s `lessonWrite`). A lesson that landed ends
 * it on the same render, whatever the state still says.
 */
export function lessonPending(cards: FeedCard[], write: LessonWrite | null): boolean {
    return write != null && !hasLesson(cards, write.nodeId);
}

/**
 * The lesson state a pulled page brings. A page asked for before Try again was
 * pressed (`retriedSince`) was composed before the writer started again: its
 * `failed` is stale and would put the failure back over "Writing the lesson".
 */
export function pulledLessonWrite(pulled: LessonWrite | null | undefined, current: LessonWrite | null, retriedSince: boolean): LessonWrite | null {
    return retriedSince && pulled?.state === 'failed' ? current : (pulled ?? null);
}

/**
 * What the page pulls on: every background-writer task's state, newest
 * included. A failed burst's task stays listed for minutes as the OLDEST one,
 * and a signal read from it alone never moved while the retry wrote the lesson.
 */
export function feedGenSignal(tasks: { kind: string; status: string; progress: { percent?: number | null; message?: string | null } }[]): string {
    return tasks
        .filter(t => t.kind === 'feed')
        .map(t => `${t.status}|${t.progress.percent ?? ''}|${t.progress.message ?? ''}`)
        .join(';');
}
