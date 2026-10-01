// "Am I still the build that is installed?" — asked by the page, about itself.
//
// The complaint this exists for: rebuild the app, restart it, and the window
// that is already open keeps running the old JavaScript and the old stylesheet.
// Nothing in the app ever told it otherwise, so the only cure was a hard reload
// — which is a keystroke most people do not know, for a problem they should
// never have had.
//
// How it works: the server hashes `dist/index.html`, which names every hashed
// asset, so its id changes if and only if the app the browser WOULD load has
// changed (`server/buildId.js`). The page records the id it started with and
// re-asks at the three moments a mismatch can appear without a page load:
//
//   * the window is looked at again (`focus`, `visibilitychange`) — a rebuild
//     almost always happens while the window is in the background,
//   * a stream reconnects after the server went away and came back
//     (`noteServerReconnected`), which is exactly what a relaunch looks like
//     from in here,
//   * and slowly on a timer, for the desktop window that is never unfocused.
//
// Reloading is deliberately not unconditional. `canReloadNow` refuses while
// something is streaming or the learner has typed into a field, because
// throwing away a half-written note to install a stylesheet is a worse bug than
// the stale stylesheet. When it refuses, the caller shows the update prompt
// instead — the same one the service worker uses — so the reload is one tap
// away rather than lost.

const CHECK_URL = '/api/build';

/** Slow enough not to be a poll, quick enough that a desktop window that never
 *  loses focus still catches up on its own within a couple of minutes. */
const IDLE_CHECK_MS = 120_000;

/** Two checks closer together than this collapse into one: `focus` and
 *  `visibilitychange` both fire when a window is brought forward. */
const MIN_GAP_MS = 5_000;

let bootId: string | null = null;
let lastCheck = 0;
let started = false;
let onStale: (() => void) | null = null;

/** Reasons a reload would destroy something. Registered by the surfaces that
 *  know — a stream in flight, a review session, a modal mid-edit.
 *
 *  Keyed by a token rather than by the reason string, so two surfaces holding
 *  for the same reason are two holds: the review queue is mounted by both
 *  flashcard screens, and a shared key would let the first to unmount release
 *  the other's. */
const holds = new Map<symbol, string>();

/** Hold off automatic reloads while `reason` is in progress. Returns the
 *  release; call it in the effect's cleanup. */
export function holdReload(reason: string): () => void {
    const token = Symbol(reason);
    holds.set(token, reason);
    return () => { holds.delete(token); };
}

/** Is this a moment where reloading loses nothing? */
export function canReloadNow(): boolean {
    if (holds.size > 0) return false;
    // Anything typed into and not yet saved. `closest` rather than a tag test:
    // the assistant's composer and the note editors are contenteditable.
    const el = document.activeElement as HTMLElement | null;
    if (el) {
        const tag = el.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable) {
            const value = (el as HTMLInputElement).value ?? el.textContent ?? '';
            if (value.trim().length > 0) return false;
        }
    }
    return true;
}

async function readBuildId(): Promise<string | null> {
    try {
        const res = await fetch(CHECK_URL, { credentials: 'include', cache: 'no-store' });
        if (!res.ok) return null;
        const json = await res.json();
        return typeof json?.buildId === 'string' ? json.buildId : null;
    } catch {
        return null;    // server asleep or restarting: not news, ask again later
    }
}

/**
 * Compare the running build with the one on disk. Calls the stale handler once
 * they differ; never calls it twice for the same mismatch, because the handler
 * either reloads (and there is no "again") or raises a prompt that stays up.
 */
export async function checkFreshness(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - lastCheck < MIN_GAP_MS) return;
    lastCheck = now;
    const id = await readBuildId();
    if (!id) return;                      // dev, or unreachable
    if (bootId === null) { bootId = id; return; }
    if (id === bootId) return;
    bootId = id;                          // don't fire again for this one
    onStale?.();
}

/** A stream reconnected — the server went away and came back, which is what a
 *  relaunch looks like from the client. Worth an immediate check. */
export function noteServerReconnected(): void {
    void checkFreshness(true);
}

/**
 * Start watching. `stale` is called on the first mismatch; it is the caller's
 * job to decide between reloading and prompting (see `canReloadNow`).
 */
export function watchFreshness(stale: () => void): void {
    if (started) return;
    started = true;
    onStale = stale;
    void checkFreshness(true);
    window.addEventListener('focus', () => void checkFreshness());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkFreshness();
    });
    window.setInterval(() => {
        if (document.visibilityState === 'visible') void checkFreshness();
    }, IDLE_CHECK_MS);
}

/** Reload onto the build that is on disk, throwing away every cached asset of
 *  the old one first. Without the cache purge a reload can be served the old
 *  bundle straight back out of the service worker's store. */
export async function reloadOntoNewBuild(): Promise<void> {
    try {
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        }
    } catch { /* private mode, or storage denied: the reload still helps */ }
    window.location.reload();
}

