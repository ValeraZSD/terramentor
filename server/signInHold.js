/* A sign-in that takes the app's own window to another site.
 *
 * "Continue with ChatGPT" (chatgptAuth.js) and "Connect OpenRouter"
 * (routes/providers.js) send the window to the provider and back. While it is
 * away the page is gone: its heartbeat stops and its `pagehide` says goodbye
 * (src/hooks/useDesktop.ts). Where no tray icon keeps the process up (Linux,
 * macOS) the desktop shutdown rule in desktop.js read that as the last window
 * closing, and stopped the server a few seconds into the sign-in, taking the
 * callback the provider returns to with it, while the launcher closed the
 * window.
 *
 * So each flow holds the server open while its attempt is pending, for as long
 * as the attempt can live, and lets go when the attempt ends, however it ends.
 * desktop.js counts the end of a hold as the last sign of life, so the page that
 * comes back has the whole idle limit to ping. A person who closed the window
 * on the provider's page leaves a server that stops once the attempt lapses and
 * that limit has passed.
 */
const holds = new Map();   // flow → the moment its hold ends (ms since the epoch)
let clock = Date.now;

/** The clock the flows' holds read. A gate pins one instant; `null` restores the real one. */
export function setHoldClock(now) {
    clock = now ?? Date.now;
}

/** Hold the server open for `ms` from `now`, under `flow` (one hold per flow). */
export function holdOpen(flow, ms, now = clock()) {
    holds.set(flow, now + ms);
}

/** The flow's attempt ended: its hold ends at `now`, never later than it would have. */
export function releaseHold(flow, now = clock()) {
    const until = holds.get(flow);
    if (until !== undefined) holds.set(flow, Math.min(until, now));
}

/** The latest moment any hold reaches: 0 when no sign-in has been started. */
export function heldUntil() {
    let latest = 0;
    for (const until of holds.values()) if (until > latest) latest = until;
    return latest;
}
