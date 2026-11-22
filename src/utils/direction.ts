// Reading direction for code that cannot use a logical CSS property: arrow
// keys, scroll positions, pointer maths. The interface is right to left when
// <html dir="rtl"> (an Arabic interface, `i18n/index.ts`); a chart or a code
// block can still be a left-to-right island inside it, so a caller that has
// the element passes it and gets the direction that element is laid out in.

export function isRtl(el?: Element | null): boolean {
    const node = el ?? (typeof document !== 'undefined' ? document.documentElement : null);
    if (!node) return false;
    return getComputedStyle(node).direction === 'rtl';
}

/** ArrowLeft/ArrowRight as "towards the start/end of the line": in right to
 *  left, the key that points at the next item is ArrowLeft. Code written for
 *  left to right passes the key through this and keeps its own logic. */
export function inlineArrow(key: string, el?: Element | null): string {
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && isRtl(el)) {
        return key === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
    }
    return key;
}

/** A sideways pointer movement as "towards the end of the line": a drag
 *  that nests a row by moving it inwards moves LEFT in right to left. */
export function inlineDelta(dx: number, el?: Element | null): number {
    return isRtl(el) ? -dx : dx;
}

/** The pointer's distance from the window's inline-start edge: what a panel
 *  docked at the start is as wide as while its edge is dragged. */
export function fromInlineStart(clientX: number): number {
    return isRtl() ? window.innerWidth - clientX : clientX;
}

/** How far a horizontally scrolled box is from its inline start. In right to
 *  left, `scrollLeft` starts at 0 and goes NEGATIVE as the box scrolls towards
 *  its end, so a test like `scrollLeft > 4` never fires there. */
export function scrolledFromStart(el: Element): number {
    return Math.abs(el.scrollLeft);
}
