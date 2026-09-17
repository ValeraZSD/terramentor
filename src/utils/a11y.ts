/**
 * Accessibility helpers.
 *
 * When a non-native element (a `<div>`/`<span>`) has to act like a button, it
 * needs `role="button"`, `tabIndex={0}` **and** a keyboard handler so Enter/Space
 * activate it the way they would a real `<button>`. `onActivateKey` supplies that
 * handler; the element still needs `role="button"` and `tabIndex={0}` of its own.
 */
import type { KeyboardEvent } from 'react';

/** onKeyDown handler that fires `handler` on Enter or Space (like a button). */
export function onActivateKey(handler: () => void) {
    return (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            handler();
        }
    };
}
