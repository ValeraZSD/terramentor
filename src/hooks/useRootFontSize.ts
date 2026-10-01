import { useSyncExternalStore } from 'react';

/**
 * The root font size in CSS pixels — what `ui_scale` sets — tracked as it
 * changes.
 *
 * Almost nothing needs this: a size written in `rem` follows the setting by
 * itself. It is for code that MEASURES in px and keeps the answer — a textarea
 * that grows to fit its text writes `height: 42px`, and that number was right
 * only for the type size it was measured at. Moving the setting from 100% to
 * 150% left the assistant's composer 42px tall around 21px type, its
 * placeholder cut off at the bottom, until something was typed into it.
 *
 * `applyUiScale` (store.ts) and the boot script in `index.html` are the only
 * writers, and both write the root element's INLINE font size — so an observer
 * on that one attribute hears every change, and the inline value is the answer
 * without a style recalculation. (`style` also carries the theme's colour
 * variables; a colour change reads the same size back and re-renders nobody.)
 */
export const BASE_ROOT_PX = 16;

export function readRootFontSize(): number {
    if (typeof document === 'undefined') return BASE_ROOT_PX;
    const px = parseFloat(document.documentElement.style.fontSize);
    return px > 0 ? px : BASE_ROOT_PX;
}

export function subscribeRootFontSize(onChange: () => void): () => void {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => { };
    let last = readRootFontSize();
    const mo = new MutationObserver(() => {
        const now = readRootFontSize();
        if (now === last) return;
        last = now;
        onChange();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => mo.disconnect();
}

/** Reactive `readRootFontSize()`: re-renders when `ui_scale` moves. */
export function useRootFontSize(): number {
    return useSyncExternalStore(subscribeRootFontSize, readRootFontSize, () => BASE_ROOT_PX);
}
