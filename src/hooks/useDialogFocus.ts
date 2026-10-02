import { RefObject, useEffect, useRef } from 'react';
import { hasPhysicalKeyboard } from '../utils/platform';

/**
 * What a modal dialog owes the keyboard, in one place for `Modal` and
 * `ConfirmDialog`: focus goes IN when it opens, Tab and Shift+Tab stay inside
 * it, Escape closes only the TOPMOST one, the page cannot scroll behind it, and
 * focus goes back to what had it when it closes.
 *
 * Before this, Shift+Tab from "Close dialog" landed on the "New Project" button
 * behind the overlay, a dialog opened from a button left focus on that button
 * underneath it, and a ConfirmDialog over a Modal closed both on one Escape.
 *
 * Deliberately NOT here: making the rest of the page `inert`. Toasts and the
 * task dock are portals that live beside a dialog and must stay reachable, so
 * the trap is a wrap at the two ends of the dialog, not a wall around it.
 */

// Open dialogs, oldest first. Only the last one answers Tab and Escape.
const stack: symbol[] = [];

// The page-scroll lock is counted: closing a ConfirmDialog over a Modal must not
// give the page its scroll back while the Modal is still open. Exported for an
// overlay that needs the lock without the rest of the contract: each writing
// `overflow` itself is how closing one unlocked the page under another.
let scrollLocks = 0;
let savedOverflow = '';
export function lockScroll() {
    if (scrollLocks++ === 0) savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
}
export function unlockScroll() {
    if (--scrollLocks <= 0) {
        scrollLocks = 0;
        document.body.style.overflow = savedOverflow;
    }
}

const FOCUSABLE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[tabindex]', '[contenteditable="true"]', 'audio[controls]', 'video[controls]',
].join(',');

const NOT_A_TEXT_FIELD = ['checkbox', 'radio', 'hidden', 'button', 'submit', 'reset', 'file', 'color', 'range', 'image'];

/** Would the browser actually put focus on this? Computed style rather than
 *  `offsetParent`, which is null for every `position: fixed` box. */
function reachable(el: HTMLElement, container: HTMLElement): boolean {
    if ((el as HTMLButtonElement).disabled) return false;
    if (el.tabIndex < 0) return false;
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') return false;
    if (el.closest('[inert]')) return false;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none') return false;
        if (n === el && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
        if (n === container) break;
    }
    // A closed <details> hides everything but its summary without touching the
    // children's computed display.
    const closed = el.closest('details:not([open])');
    if (closed && container.contains(closed) && !(el.tagName === 'SUMMARY' && el.parentElement === closed)) return false;
    return true;
}

export function focusableIn(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => reachable(el, container));
}

/** The first thing a form dialog should put the cursor in. Buttons and ticks are
 *  not it: landing on "Close dialog" or a checkbox says nothing about the task. */
function firstField(container: HTMLElement): HTMLElement | null {
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('input, select, textarea'))) {
        if (el.tagName === 'INPUT' && NOT_A_TEXT_FIELD.includes((el as HTMLInputElement).type)) continue;
        if (reachable(el, container)) return el;
    }
    return null;
}

/**
 * Tab at the dialog's ends wraps; Tab from outside it (focus escaped, or was
 * never in) is pulled in. Another modal that is not ours, open above this one,
 * keeps its own Tab. Returns true when it moved focus.
 */
export function trapTab(e: Pick<KeyboardEvent, 'shiftKey' | 'preventDefault'>, container: HTMLElement): boolean {
    const active = document.activeElement as HTMLElement | null;
    const inside = !!active && container.contains(active);
    if (!inside && active && active !== document.body && active.closest('[aria-modal="true"]')) return false;
    const items = focusableIn(container);
    if (items.length === 0) {
        e.preventDefault();
        container.focus({ preventScroll: true });
        return true;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (!inside || active === container) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return true;
    }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); return true; }
    if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); return true; }
    return false;
}

interface Options {
    /** Escape, while this is the topmost dialog. */
    onEscape?: (e: KeyboardEvent) => void;
    /** Where focus starts. Absent: the first text field, else the dialog itself. */
    initialFocus?: RefObject<HTMLElement | null>;
}

export function useDialogFocus(open: boolean, containerRef: RefObject<HTMLElement | null>, opts: Options = {}) {
    // The latest callbacks without re-running the effect: re-running it would
    // re-lock the page and re-take the opener on every render.
    const optsRef = useRef(opts);
    optsRef.current = opts;

    // What had focus when the dialog opened is read while it is RENDERING, not in
    // the effect: a child's `autoFocus` runs in the commit, before any effect, so
    // by then the focused element is already inside the dialog and "the opener"
    // would be the thing about to be deleted.
    const openerRef = useRef<HTMLElement | null>(null);
    const wasOpen = useRef(false);
    if (open && !wasOpen.current) openerRef.current = document.activeElement as HTMLElement | null;
    wasOpen.current = open;

    useEffect(() => {
        if (!open) return;
        const container = containerRef.current;
        const token = Symbol('dialog');
        const opener = openerRef.current;
        stack.push(token);
        lockScroll();

        // A child that focused itself (autoFocus, its own effect) already chose.
        // The first field only with a keyboard at hand: on a touchscreen,
        // focusing it opens the on-screen keyboard over half the dialog before
        // the learner has read what it asks.
        if (container && !container.contains(document.activeElement)) {
            const field = hasPhysicalKeyboard() ? firstField(container) : null;
            const target = optsRef.current.initialFocus?.current ?? field ?? container;
            target.focus({ preventScroll: true });
        }

        const onKey = (e: KeyboardEvent) => {
            if (stack[stack.length - 1] !== token) return;
            if (e.key === 'Escape') {
                if (!e.isComposing) optsRef.current.onEscape?.(e);
            } else if (e.key === 'Tab' && !e.defaultPrevented && container) {
                trapTab(e, container);
            }
        };
        document.addEventListener('keydown', onKey);

        return () => {
            document.removeEventListener('keydown', onKey);
            const i = stack.indexOf(token);
            if (i >= 0) stack.splice(i, 1);
            unlockScroll();
            // Give focus back only if the dialog still held it (its own node is
            // gone by now, so that reads as the body): a close that moved focus
            // somewhere on purpose keeps it there.
            const active = document.activeElement;
            const stillOurs = !active || active === document.body || !!container?.contains(active);
            if (stillOurs && opener && opener !== document.body && opener.isConnected) opener.focus();
        };
    }, [open, containerRef]);
}
