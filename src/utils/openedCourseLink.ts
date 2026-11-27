// The course link the app was opened with (`…/#course=…`, see courseLink.ts).
//
// It is taken off the address at start, before anything routes: a lock screen,
// a sign-in or the welcome may come first and change the address, and a 22 KB
// fragment left in the address bar is copied by every "share this page". It is
// kept for this tab until the course page (or, for a link that cannot be read,
// the New course dialog) that offers it closes, so a
// screen that moves the app on (the welcome's last step) cannot lose it: the
// app goes back to Projects for as long as a link waits (App.tsx).
//
// A link opened in a tab where the app already runs changes only the part
// after `#`, which reloads nothing, so `hashchange` takes it the same way and
// tells the screens that offer it.
//
// The desktop app opens a course FILE the same way: a .studyvault double-clicked
// in the file manager reaches the running app (desktop/launcher.js), which
// opens a window at `#open-file=<token>`. The token names the file for one read
// (GET /api/desktop/opened-file/:token, server/openedFiles.js); the path itself
// never reaches an address.

import { packedCourseIn } from './courseLink';

/** The desktop app's `#open-file=<token>` (OPEN_FILE_PARAM in desktop/lib.js). */
const OPEN_FILE = /^#open-file=([0-9a-f]{64})$/;

/** The token of an opened course file, when `link` is one rather than a course link. */
export function openedFileToken(link: string | null): string | null {
    const hash = link?.indexOf('#') ?? -1;
    return hash < 0 ? null : OPEN_FILE.exec(link!.slice(hash))?.[1] ?? null;
}

const KEY = 'opened-course-link';
/** Set for the rest of this tab once a link opened the app: the welcome waits for a later visit. */
const ARRIVED_KEY = 'opened-course-link-arrived';
const EVENT = 'terramentor:course-link-opened';
/** Where the link waits when this tab's storage refuses it (private windows). */
let held: string | null = null;
let arrived = false;

/**
 * Moves a `#course=` link from the address into this tab's keeping. The whole
 * link is kept, so the field it lands in shows the address the learner opened
 * rather than a run of letters. True when there was one.
 */
export function keepOpenedCourseLink(): boolean {
    // Only a `<format>.<data>` link or a whole file token counts: a stray
    // `#course=x` neither moves the welcome aside nor opens the dialog.
    if (!OPEN_FILE.test(window.location.hash) && !/^\d+\./.test(packedCourseIn(window.location.hash) ?? '')) return false;
    held = window.location.href;
    arrived = true;
    try {
        sessionStorage.setItem(KEY, held);
        sessionStorage.setItem(ARRIVED_KEY, '1');
    } catch { /* `held` keeps it */ }
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    return true;
}

/** Called once at start: takes the link the app opened with, and any opened in this tab later. */
export function watchOpenedCourseLinks(): void {
    keepOpenedCourseLink();
    window.addEventListener('hashchange', () => {
        if (keepOpenedCourseLink()) window.dispatchEvent(new Event(EVENT));
    });
}

/** Runs `then` each time a link is opened in this tab while the app runs. */
export function onOpenedCourseLink(then: () => void): () => void {
    window.addEventListener(EVENT, then);
    return () => window.removeEventListener(EVENT, then);
}

/** The waiting link, or null. Reading it does not spend it. */
export function openedCourseLink(): string | null {
    try { return sessionStorage.getItem(KEY) ?? held; } catch { return held; }
}

/** Whether a course link opened the app in this tab (spent or not). */
export function arrivedByCourseLink(): boolean {
    try { return arrived || sessionStorage.getItem(ARRIVED_KEY) === '1'; } catch { return arrived; }
}

/** Spends the link: the page or dialog that offered it closed, added or not. */
export function forgetOpenedCourseLink(): void {
    held = null;
    try { sessionStorage.removeItem(KEY); } catch { /* nothing kept there */ }
}
