// Service-worker lifecycle — the imperative half of the "new version available"
// flow. Kept out of React so it runs once at startup; the UI half is
// `components/UpdatePrompt.tsx`, which subscribes via `onUpdateReady`.
//
// Behaviour:
//  - DEV: never keep a SW registered. It only causes stale-asset confusion while
//    Vite HMR already does live updates, so we proactively unregister any SW left
//    over from a previous standalone run on this origin.
//  - PROD (the standalone build): register, then watch for an updated worker. When
//    one finishes installing *and* an app is already running (i.e. this is an
//    upgrade, not the first install), surface it. The user taps "Reload" →
//    `applyUpdate` tells the waiting worker to take over → `controllerchange` →
//    one clean reload onto the new build. No more "works but a refresh behind".

let waitingWorker: ServiceWorker | null = null;
let updateCb: (() => void) | null = null;
let reloading = false;

/**
 * A tab-scoped note that we have already asked a waiting worker to hand over.
 *
 * It has to survive a reload, because that is exactly what it is for: a plain
 * reload does NOT activate a waiting worker — only `skipWaiting()` or closing
 * every tab does — so a page that reloads without asking for the handover comes
 * back to find the same worker still waiting, decides it is out of date again,
 * and reloads again. That loop is what "the update screen never ends" was: an
 * app reloading itself every few seconds, purging its cache and re-downloading
 * the whole bundle each time round.
 *
 * Cleared the moment a load finds nothing waiting, so the ordinary
 * rebuild → reload → rebuild cycle keeps reloading automatically; it only latches
 * when a handover was asked for and did not happen.
 */
const HANDOVER_KEY = 'terramentor:sw-handover';

function noteHandoverAsked(): void {
    try { sessionStorage.setItem(HANDOVER_KEY, '1'); } catch { /* private mode */ }
}

function forgetHandover(): void {
    try { sessionStorage.removeItem(HANDOVER_KEY); } catch { /* private mode */ }
}

/** Did a previous load in this tab ask for a handover that still has not
 *  happened? Then reloading is not the cure and the banner is: it puts the
 *  decision back with the person, instead of spending their bandwidth on the
 *  same reload forever. */
export function updateStalled(): boolean {
    try { return sessionStorage.getItem(HANDOVER_KEY) === '1'; } catch { return false; }
}

/** Subscribe to "a new version is ready". Fires immediately if one already is.
 *  Returns an unsubscribe fn. */
export function onUpdateReady(cb: () => void): () => void {
    updateCb = cb;
    if (waitingWorker) cb();
    return () => { if (updateCb === cb) updateCb = null; };
}

/**
 * Activate the waiting worker and reload onto it (called from the prompt).
 *
 * Returns whether there was anything to hand over to: `true` means the reload is
 * now the controllerchange handler's job and the caller must NOT navigate on its
 * own — a reload that races the handover is a reload the handover loses, and the
 * loop described at `HANDOVER_KEY` is what that looks like from the outside.
 */
export function applyUpdate(): boolean {
    if (!waitingWorker) return false;
    reloading = true;                          // this reload is intentional
    noteHandoverAsked();
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    // The actual reload happens in the controllerchange handler below, once the
    // new worker has taken control.
    return true;
}

/** How long to let the browser look for a new worker before giving up and
 *  reloading without one. A local `/sw.js` answers in milliseconds. */
const LOOKUP_MS = 1_500;

/**
 * Ask the browser to check for a new worker NOW, and say whether one ended up
 * waiting.
 *
 * The freshness watcher usually gets there first: it asks the server directly,
 * while the browser only re-fetches `/sw.js` on a navigation. Without this the
 * page reloads once to make the browser notice the worker and then again to hand
 * over to it — two reloads, and because the first purges the cache, the whole
 * bundle downloaded twice. Measured in a real browser before it was added.
 */
export async function findWaitingWorker(): Promise<boolean> {
    if (waitingWorker) return true;
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return false;
    try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) return false;
        await reg.update();                    // fetch /sw.js and install if it moved
        const deadline = Date.now() + LOOKUP_MS;
        while (!reg.waiting && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }
        if (reg.waiting) waitingWorker = reg.waiting;
    } catch { /* offline, or the registration went away: reload without it */ }
    return waitingWorker !== null;
}

export function registerSW(): void {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

    if (import.meta.env.DEV) {
        navigator.serviceWorker.getRegistrations()
            .then(regs => regs.forEach(r => r.unregister()))
            .catch(() => { /* best-effort */ });
        return;
    }

    // Reload only when WE triggered the update (applyUpdate set `reloading`). The
    // first-ever install also fires controllerchange via clients.claim(); that
    // one must NOT reload, or a fresh install would bounce on load.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        forgetHandover();                       // it happened: nothing to guard
        if (reloading) window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(reg => {
            // Nothing waiting: whatever handover was asked for last time has
            // happened (or there never was one), so the note goes away and the
            // next update is free to install itself again.
            if (!reg.waiting) forgetHandover();

            const promote = () => {
                // Only an *upgrade* of an already-controlled page counts as an
                // update to surface; a first install has no controller yet.
                if (reg.waiting && navigator.serviceWorker.controller) {
                    waitingWorker = reg.waiting;
                    updateCb?.();
                }
            };
            promote();   // a worker may already be waiting from a previous visit
            reg.addEventListener('updatefound', () => {
                const installing = reg.installing;
                installing?.addEventListener('statechange', () => {
                    if (installing.state === 'installed') promote();
                });
            });
        }).catch(() => { /* registration is best-effort */ });
    });
}
