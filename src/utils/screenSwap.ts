/**
 * Moving from one screen to the next in ONE step.
 *
 * A route used to be drawn the moment the address changed, before anything it
 * shows had arrived: one click showed the old screen, then an empty page, then
 * the new screen arriving piece by piece (the tree, then the dashboard's
 * sections, then the pace pill), each piece moving the ones below it. Filmed
 * frame by frame, opening a course from the Projects grid went through six
 * states in half a second, 300 ms of them a blank page.
 *
 * So a move keeps the OLD screen on view while the new one is drawn and its
 * first reads come in, and swaps when the new screen is whole: no read it
 * started still open, no route still downloading. The browser's view
 * transition does the holding (it shows a picture of the old screen while the
 * page underneath changes) and a short cross-fade does the swap. A screen
 * that is not whole by `HOLD_CAP_MS` is shown as it is: a page that looks
 * frozen is worse than one still filling in.
 *
 * Where the browser has no view transitions, or the page is hidden, the new
 * screen is drawn at once, as before.
 */

/** The longest the old screen is held for a new one. Nothing on screen
 *  answers the click while it is held, and much past half a second that
 *  reads as a click that was missed. A local read takes 10-300 ms. */
export const HOLD_CAP_MS = 600;
/** Checks in a row with nothing open before the new screen counts as whole:
 *  one more than the first, since a read that finishes often starts the next
 *  (the tree, then the dashboard that reads it). */
const QUIET_CHECKS = 2;
const CHECK_MS = 16;

/** Reads in flight, by when each started (`performance.now()`). */
const reads = new Map<number, number>();
let readSeq = 0;

/**
 * Reads no screen waits on to look whole: anything that may go to a model
 * provider over the network (health probes, model lists, thinking levels,
 * serving endpoints: hundreds of ms to seconds), the update and build checks,
 * and the report marks on items, which add a small badge. Waiting on these
 * held every visit to the home page and to Settings to the cap.
 */
const BACKGROUND_READ = /^\/api\/(?:ai\/(?:status|generation-status|models|endpoints|efforts|model-facts|connections\/\d+\/models)|embeddings\/(?:status|models)|media-descriptions\/status|updates|build|version|item-reports)(?:[/?]|$)/;

/** Count a read while it is open. Only GETs: a screen waits on what it reads. */
export function trackRead<T>(work: Promise<T>, method?: string, url?: string): Promise<T> {
    if (method && method.toUpperCase() !== 'GET') return work;
    if (url && BACKGROUND_READ.test(url)) return work;
    const id = ++readSeq;
    reads.set(id, performance.now());
    const done = () => { reads.delete(id); };
    work.then(done, done);
    return work;
}

/** Reads started at or after `since` that have not finished. */
export function readsOpenSince(since: number): number {
    let n = 0;
    for (const at of reads.values()) if (at >= since) n++;
    return n;
}

/** A route still downloading, or a part of the screen saying it is not ready. */
function screenBusy(): boolean {
    return !!document.querySelector('main [aria-busy="true"]:not(button)');
}

let swapSeq = 0;

/** The screen on view changed without a swap (a move back to it, or within
 *  it): a swap still waiting must not hold the page for a screen it no longer
 *  draws. */
export function endHold(): void { swapSeq++; }

/** Resolves once the screen drawn after `since` is whole, or at the cap, or
 *  when a newer move takes over. */
function whole(since: number, seq: number): Promise<void> {
    return new Promise((resolve) => {
        let quiet = 0;
        // setTimeout, never requestAnimationFrame: while the old screen is
        // held the page does not paint, so a frame callback would never run.
        const check = () => {
            if (seq !== swapSeq || performance.now() - since >= HOLD_CAP_MS) return resolve();
            quiet = readsOpenSince(since) > 0 || screenBusy() ? 0 : quiet + 1;
            if (quiet >= QUIET_CHECKS) return resolve();
            setTimeout(check, CHECK_MS);
        };
        setTimeout(check, CHECK_MS);
    });
}

/** The longest the app is kept out of sight while it starts. Longer than a
 *  move's cap: the first screen also waits for the app's own code. */
export const FIRST_SCREEN_CAP_MS = 1500;

/**
 * Show the app once its first screen is whole. Until then `#root` is hidden
 * (`html[data-first-screen]`, index.css) and the page shows only its
 * background, so opening the app is one step from the empty window to the
 * screen, not a header over an empty page, then cards, then each card's dates.
 * "Whole" is the move's test plus something drawn at all: before the app
 * knows whether a password or the welcome comes first it draws nothing.
 */
export function revealFirstScreen(): void {
    const root = document.documentElement;
    const reveal = () => root.removeAttribute('data-first-screen');
    const started = performance.now();
    let quiet = 0;
    const check = () => {
        if (performance.now() - started >= FIRST_SCREEN_CAP_MS) return reveal();
        const drawn = (document.getElementById('root')?.childElementCount ?? 0) > 0;
        quiet = !drawn || readsOpenSince(0) > 0 || screenBusy() ? 0 : quiet + 1;
        if (quiet >= QUIET_CHECKS) return reveal();
        setTimeout(check, CHECK_MS);
    };
    root.setAttribute('data-first-screen', 'pending');
    setTimeout(check, CHECK_MS);
}

type ViewTransitionStart = (update: () => Promise<void>) => {
    ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void>;
};

/**
 * Draw the next screen with `draw` (which must render it synchronously, e.g.
 * through `flushSync`), keeping the current one on view until the new one is
 * whole. `draw` always runs, exactly once, whatever the browser supports.
 */
export function swapScreen(draw: () => void): void {
    const seq = ++swapSeq;
    const start = (document as Document & { startViewTransition?: ViewTransitionStart }).startViewTransition;
    if (typeof start !== 'function' || document.visibilityState !== 'visible') { draw(); return; }
    let drawn = false;
    try {
        const transition = start.call(document, async () => {
            const since = performance.now();
            drawn = true;
            draw();
            await whole(since, seq);
        });
        // A transition skipped by a newer one, or by the page being hidden,
        // rejects these; the screen is drawn either way.
        transition.ready.catch(() => {});
        transition.finished.catch(() => {});
        transition.updateCallbackDone.catch(() => {});
    } catch {
        if (!drawn) draw();
    }
}
