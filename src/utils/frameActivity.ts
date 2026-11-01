/**
 * "The learner is using something inside a frame", passed from the frame's
 * host to the study clock.
 *
 * A widget or a p5 sketch is its own sandboxed document, so its key presses
 * and drags never reach this one; its harness posts `{type: 'active'}` to the
 * parent instead. The clock used to listen for that on `window` itself and
 * accept any message of that shape — from any frame, any window that held a
 * reference to this one, with no token and no source — so anything that could
 * post a message here could keep the clock counting.
 *
 * The frame's HOST is the one place that can tell a real report from a
 * look-alike: it made the frame, holds its `contentWindow` and the random
 * token it handed it, and already checks both on every message
 * (renderWidget.ts, renderP5.ts). So the host is what reports, here, after
 * those checks, and the clock listens to this instead of to `window`.
 */

const listeners = new Set<() => void>();

/** Called by a frame's host for an `active` message that passed its source
 *  and token checks. */
export function reportFrameActivity(): void {
    for (const l of listeners) l();
}

/** Hear those reports; returns the unsubscribe. */
export function onFrameActivity(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
