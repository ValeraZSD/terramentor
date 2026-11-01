import type { FeedCard } from '../types';

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

/**
 * Merge a pulled page into the stream. Everything held keeps its order, and a
 * topic's checkpoint stays the END of its chapter:
 * - a pulled checkpoint goes straight after the last card its topic already
 *   has on screen; when this page carries teaching cards of that topic too,
 *   the server's order already ends the chapter and it is appended in place;
 * - a pulled teaching card of a topic whose checkpoint is on screen goes in
 *   just before that checkpoint (a lesson written while the page held only the
 *   Overview standing in for it), never under it.
 * Anything else is appended in the page's order.
 */
export function placeCheckpoints(held: FeedCard[], fresh: FeedCard[]): FeedCard[] {
    const out = [...held];
    const pulledTopics = new Set<number>();
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
        if (end < 0) out.push(c);
        else out.splice(end, 0, c);
    }
    return out;
}
