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
