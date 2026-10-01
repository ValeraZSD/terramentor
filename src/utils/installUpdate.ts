// Getting the page ONTO the build that is waiting — the last step of the
// freshness story, and the one whose order decides whether it happens at all.
//
// Two things can say the page is out of date and they know different halves of
// it: the service worker knows a new worker is installed and WAITING
// (`sw-register.ts`), the freshness watcher knows what build is on disk
// (`utils/freshness.ts`). Neither of them installs anything; this does, and both
// the automatic path and the banner's Reload button go through it: two roads
// around one handover are how a shortcut reappears.
//
// Why a reload without the handover is a loop: a plain reload does NOT
// activate a waiting service worker — only `skipWaiting()` or closing every
// tab does. So the page reloads, comes back controlled by the same old worker
// with the same new one still waiting, is told again that it is out of date,
// and reloads again. From the outside: an app that never finishes updating,
// re-downloading the whole bundle every few seconds because each round purges
// the cache first.
//
// So the order lives here. Ask for the handover, and then the reload is the
// worker's to trigger (`sw-register` reloads on `controllerchange`); navigating
// ourselves in the same moment can beat the message to the worker, and then
// nothing has changed except the download. With no worker waiting — the desktop
// window, plain http on the LAN, workers switched off — there is nothing to hand
// over to and the reload is ours, cache purge and all.

import { applyUpdate, findWaitingWorker, updateStalled } from '../sw-register';
import { canReloadNow, reloadOntoNewBuild } from './freshness';

/** How long the handover gets before we reload anyway. Long enough for a worker
 *  to activate and claim the page, short enough that a message which never
 *  arrived does not leave the page on a build we have already called stale. */
export const HANDOVER_GRACE_MS = 2_000;

/**
 * Is reloading by ourselves, right now, the right answer?
 *
 * `canReloadNow()` is about cost — a stream in flight, a review session, text
 * somebody typed. `updateStalled()` is about effect: we asked for this handover
 * on an earlier load and it did not happen, so another reload would only ask for
 * it again. Either one says no and the caller raises the banner instead, which
 * puts a working way through in front of the person rather than spending their
 * bandwidth in a circle.
 */
export function shouldInstallNow(): boolean {
    return canReloadNow() && !updateStalled();
}

/** Install the build that is waiting, whichever half of the app noticed it. */
export async function installNewBuild(): Promise<void> {
    // The freshness watcher asks the server, so it usually knows before the
    // browser has re-fetched `/sw.js`. Give the worker a moment to turn up, or
    // this reloads once to make the browser notice it and again to hand over.
    await findWaitingWorker();

    if (!applyUpdate()) { void reloadOntoNewBuild(); return; }

    // Handover asked for; `controllerchange` reloads when it lands. If it never
    // does, reload anyway rather than sit on a build we know is old — but drop
    // that fallback the moment the handover succeeds, or it fires into the
    // loading page and throws away the cache the new worker has just filled.
    const fallback = window.setTimeout(() => { void reloadOntoNewBuild(); }, HANDOVER_GRACE_MS);
    navigator.serviceWorker?.addEventListener(
        'controllerchange',
        () => window.clearTimeout(fallback),
        { once: true },
    );
}
