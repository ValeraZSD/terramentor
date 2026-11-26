// The course link the app was opened with (`…/#course=…`, see courseLink.ts).
//
// It is taken off the address at start, before anything routes: a lock screen,
// a sign-in or the welcome may come first and change the address, and a 22 KB
// fragment left in the address bar is copied by every "share this page". It is
// kept for this tab until the New course dialog that offers it closes, so a
// screen that moves the app on (the welcome's last step) cannot lose it: the
// app goes back to Projects for as long as a link waits (App.tsx).

import { packedCourseIn } from './courseLink';

const KEY = 'opened-course-link';
/** Where the link waits when this tab's storage refuses it (private windows). */
let held: string | null = null;

/**
 * Called once at start: moves a `#course=` link from the address into this
 * tab's keeping. The whole link is kept, so the field it lands in shows the
 * address the learner opened rather than a run of letters.
 */
export function keepOpenedCourseLink(): void {
    if (!packedCourseIn(window.location.hash)) return;
    held = window.location.href;
    try { sessionStorage.setItem(KEY, held); } catch { /* `held` keeps it */ }
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
}

/** The waiting link, or null. Reading it does not spend it. */
export function openedCourseLink(): string | null {
    try { return sessionStorage.getItem(KEY) ?? held; } catch { return held; }
}

/** Spends the link: the dialog that offered it closed, added or not. */
export function forgetOpenedCourseLink(): void {
    held = null;
    try { sessionStorage.removeItem(KEY); } catch { /* nothing kept there */ }
}
