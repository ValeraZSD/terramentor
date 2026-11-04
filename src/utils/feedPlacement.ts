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
 *  the lesson slot is drawn beside one of these, never beside a recall card
 *  drawn on its own. */
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
 *   waiting on (`lessonSlot`), goes where that slot was drawn: after the
 *   topic's own cards, not under a flashcard served after them.
 * Anything else is appended in the page's order.
 */
export function placeCheckpoints(held: FeedCard[], fresh: FeedCard[], slotTopic: number | null = null): FeedCard[] {
    const out = [...held];
    const pulledTopics = new Set<number>();
    // Where the next card of the slot's topic goes; moves on as each lands.
    let slotAt = -1;
    if (slotTopic != null) {
        for (let i = out.length - 1; i >= 0; i--) {
            if (chapterTopicOf(out[i]) === slotTopic) { slotAt = i + 1; break; }
        }
    }
    for (const c of fresh) {
        const topic = topicOf(c);
        if (c.kind === 'checkpoint') {
            let at = -1;
            if (!pulledTopics.has(c.nodeId)) {
                for (let i = out.length - 1; i >= 0; i--) {
                    const o = out[i];
                    if (o.kind !== 'flashcard' && 'nodeId' in o && o.nodeId === c.nodeId) { at = i; break; }
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

/** The written lesson of a topic on screen (not the Overview standing in for it). */
const hasLesson = (cards: FeedCard[], nodeId: number) =>
    cards.some(c => c.kind === 'lesson' && c.nodeId === nodeId && !c.degraded);

/**
 * Where a topic's page draws the slot of the lesson still being written (or
 * that failed to be): right after the topic's last card, or just above its
 * End of chapter. Null when there is no state, the topic has no card on
 * screen, or its lesson is already there: a lesson that landed takes the slot
 * on the same render, whatever the state still says.
 */
export function lessonSlot(cards: FeedCard[], write: LessonWrite | null): { key: string; place: 'before' | 'after' } | null {
    if (!write || hasLesson(cards, write.nodeId)) return null;
    const end = cards.find(c => c.kind === 'checkpoint' && c.nodeId === write.nodeId);
    if (end) return { key: end.key, place: 'before' };
    for (let i = cards.length - 1; i >= 0; i--) {
        if (chapterTopicOf(cards[i]) === write.nodeId) return { key: cards[i].key, place: 'after' };
    }
    return null;
}

/**
 * The stream has not ended while its topic's lesson is being written: no
 * junction ("That's all of this topic") and no "Writing more lessons · 0%"
 * line under the slot that already says it.
 */
export function lessonPending(cards: FeedCard[], write: LessonWrite | null): boolean {
    return write?.state === 'writing' && lessonSlot(cards, write) != null;
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
