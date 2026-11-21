/**
 * The phone's Back button, the browser's Back (a mouse's back key, Alt+Left,
 * an iPhone's edge swipe) closes the topmost open dialog, and never leaves the
 * page behind it.
 *
 * Back is a history traversal, so a dialog that wants it needs an entry of its
 * own: every open dialog owns one entry above the page's, at the same address,
 * marked with its depth (`tmDialog: 1, 2, …`). Back pops the top one, and the
 * dialog that owned it is asked to close, the way Escape asks it. This is the
 * pattern Android's own web apps and the "back stack overlay" hooks use; the
 * platform's `CloseWatcher` hears a phone's Back but not the browser's, and
 * Safari has none.
 *
 * The entries are not tied to dialogs one by one. There is ONE rule, applied
 * after every change (a dialog opened or closed, a Back, a route change): the
 * entry the browser is on carries as many marks as there are open dialogs.
 *  - Fewer: push the missing ones (a dialog opened, or one refused a Back:
 *    a form that asks before discarding stays open, so it gets its entry back).
 *  - More: go back over the extra ones (a dialog closed by its ✕, a button,
 *    Escape or a tap outside). Those entries share the page's address, so the
 *    page does not move.
 * A dialog whose action navigates (Go to project) leaves its entry under the
 * new page; Back from that page lands on it, finds no dialog to own it and
 * steps over it, so one press still reaches the page the dialog was opened
 * on. Forward cannot get past such an entry; nothing else is lost.
 */

import { useEffect, useRef } from 'react';

type Open = { back: () => void };

const KEY = 'tmDialog';
const open: Open[] = [];
/** The depth of the entry the browser was on when we last looked. */
let known = 0;
/** A `history.go` of ours is under way: its popstate is not a Back. */
let traversing = false;
let traverseTimer: ReturnType<typeof setTimeout> | null = null;
let scheduled = false;
let listening = false;

function depthOf(state: unknown): number {
    const d = (state as Record<string, unknown> | null)?.[KEY];
    return typeof d === 'number' && d > 0 ? d : 0;
}

function withoutMark(state: unknown): Record<string, unknown> {
    if (!state || typeof state !== 'object') return {};
    const { [KEY]: _mark, ...rest } = state as Record<string, unknown>;
    return rest;
}

function reconcile() {
    if (traversing || typeof window === 'undefined') return;
    const cur = depthOf(window.history.state);
    const want = open.length;
    if (cur < want) {
        // The router's own fields (its key and index) are copied, so it reads
        // these entries as the page they sit on.
        const base = withoutMark(window.history.state);
        try {
            for (let d = cur + 1; d <= want; d++) window.history.pushState({ ...base, [KEY]: d }, '');
        } catch {
            // A browser that rate-limits history calls (Safari refuses past
            // ~100 in 30 s) throws: the dialogs stay open as they are, and Back
            // over them acts as it did before this rule.
        }
        known = depthOf(window.history.state);
    } else if (cur > want) {
        traversing = true;
        // A traversal that never reports (out of range) must not stop the
        // rule for good.
        traverseTimer = setTimeout(() => { traversing = false; traverseTimer = null; schedule(); }, 1000);
        try {
            window.history.go(want - cur);
        } catch {
            traversing = false;
            if (traverseTimer) clearTimeout(traverseTimer);
            traverseTimer = null;
            known = cur;
        }
    } else {
        known = cur;
    }
}

/** After the current task: a close and the dialog it reveals settle first, so
 *  a refused Back and a ConfirmDialog it opened are counted together. */
function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; reconcile(); }, 0);
}

function onPop(e: PopStateEvent) {
    const now = depthOf(e.state);
    if (traversing) {
        traversing = false;
        if (traverseTimer) clearTimeout(traverseTimer);
        traverseTimer = null;
        known = now;
        schedule();
        return;
    }
    const dropped = known - now;
    known = now;
    // Back over N marks closes the top N dialogs, top first. Landing on a mark
    // from below (Back from a page a dialog navigated to, or Forward) closes
    // nothing: the rule then steps over the stale entry.
    if (dropped > 0) for (const d of open.slice(-dropped).reverse()) d.back();
    schedule();
}

function listen() {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    window.addEventListener('popstate', onPop);
    // A reload while a dialog was open comes back on a marked entry with no
    // dialog: step off it, or the first Back would seem to do nothing.
    known = depthOf(window.history.state);
    if (known) schedule();
}

listen();

/**
 * A dialog is open: Back calls `back` while it is the topmost. Returns the
 * close: call it when the dialog goes away by any route.
 */
export function holdBackEntry(back: () => void): () => void {
    listen();
    const entry: Open = { back };
    open.push(entry);
    schedule();
    return () => {
        const i = open.indexOf(entry);
        if (i >= 0) open.splice(i, 1);
        schedule();
    };
}

/**
 * A floating list or menu (Select, MenuPopover, the model picker) that is not
 * a `useDialogFocus` overlay: while it is open, Back closes it, as Escape
 * does, and not the dialog it sits in.
 */
export function useBackClose(isOpen: boolean, close: () => void) {
    const closeRef = useRef(close);
    closeRef.current = close;
    useEffect(() => {
        if (!isOpen) return;
        return holdBackEntry(() => closeRef.current());
    }, [isOpen]);
}

/** The route changed: a dialog that stayed open over the new page needs its
 *  entry above that page, not under it, and the new entry's depth is the one
 *  the next Back is measured from. */
export function dialogHistoryRouteChanged() {
    schedule();
}
