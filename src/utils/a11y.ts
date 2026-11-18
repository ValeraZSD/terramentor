/**
 * Accessibility helpers.
 *
 * When a non-native element (a `<div>`/`<span>`) has to act like a button, it
 * needs `role="button"`, `tabIndex={0}` **and** a keyboard handler so Enter/Space
 * activate it the way they would a real `<button>`. `onActivateKey` supplies that
 * handler; the element still needs `role="button"` and `tabIndex={0}` of its own.
 */
import type { KeyboardEvent } from 'react';

/**
 * onKeyDown handler that fires `handler` on Enter or Space (like a button).
 *
 * Only for a key pressed ON the element. One that bubbled up from a control
 * inside it (the Study button on a project card, a link in a notes preview)
 * belongs to that control: taking it here called preventDefault, which
 * cancelled the inner button's own click and opened the card instead.
 */
export function onActivateKey(handler: () => void) {
    return (e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            handler();
        }
    };
}

/**
 * Focus that no control holds: nowhere (the body), or a surface that took it
 * only to keep the keyboard inside it (`data-owns-keyboard`, focused when it
 * opens by `useDialogFocus`). A screen may move focus on from there; from a
 * control the learner moved to, never.
 */
export function focusIsLost(active: Element | null): boolean {
    if (!active || active === active.ownerDocument.body) return true;
    return active.hasAttribute('data-owns-keyboard');
}

let announcer: HTMLElement | null = null;

/**
 * Say `text` once to a screen reader, through one polite live region for the
 * whole page. For a change made from a menu (Move up, Move earlier): the menu
 * item that was pressed is gone by the time the change lands, so nothing on
 * screen reports it. The region is visually hidden.
 */
export function announce(text: string, doc: Document = document): void {
    if (!announcer || !announcer.isConnected || announcer.ownerDocument !== doc) {
        announcer = doc.createElement('div');
        announcer.setAttribute('aria-live', 'polite');
        announcer.setAttribute('aria-atomic', 'true');
        announcer.setAttribute('data-announcer', '');
        Object.assign(announcer.style, {
            position: 'absolute', width: '1px', height: '1px', margin: '-1px', padding: '0',
            overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: '0',
        });
        doc.body.appendChild(announcer);
    }
    // Emptied first and filled a moment later: the same words twice (two
    // moves to the same place) are still a change, and a region that has only
    // just been added is not missed.
    const region = announcer;
    region.textContent = '';
    setTimeout(() => { region.textContent = text; }, 100);
}
