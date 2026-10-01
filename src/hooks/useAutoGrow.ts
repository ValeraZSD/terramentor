import { useLayoutEffect, useRef, RefObject } from 'react';
import { useRootFontSize, readRootFontSize } from './useRootFontSize';

/**
 * How tall the field may grow before it scrolls: a number of lines (`rows` — a
 * chat composer is "grow to five lines") or a length in `rem` (an answer box is
 * "grow to this much of the card"). Never px: a px ceiling is a different
 * number of lines at every `ui_scale`.
 */
export type GrowCeiling = { rows: number } | { rem: number };

/**
 * Size one textarea to its text, now. Exported for the gate; components use
 * the hook.
 *
 * Every length is read off the element's own computed style, so it holds at
 * any `ui_scale`. The height written is a BORDER-BOX height when the element
 * is border-box (every element here — Tailwind's preflight): `scrollHeight`
 * counts content and padding but not the border, and writing it straight in
 * made every auto-grown field two pixels shorter than its own text — the
 * composer's placeholder sat on the bottom border at 100% and was visibly cut
 * at 150%.
 */
export function fitTextarea(el: HTMLTextAreaElement, max: GrowCeiling): void {
    // A field that is not laid out (display:none, a closed panel) measures 0;
    // writing that down would leave it 0 tall when it appears. The width
    // observer in the hook re-fits it on the frame it gets a width.
    if (el.clientWidth === 0) return;
    // Collapse first: scrollHeight can only report a box at least as tall as
    // the current one, so measuring without this makes the field a ratchet
    // that never shrinks when text is deleted.
    el.style.height = 'auto';
    const style = window.getComputedStyle(el);
    const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const borderY = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    const fontPx = parseFloat(style.fontSize) || readRootFontSize();
    // Both in border-box terms.
    const need = el.scrollHeight + borderY;
    const ceiling = 'rows' in max
        ? (parseFloat(style.lineHeight) || fontPx * 1.25) * max.rows + paddingY + borderY
        : max.rem * readRootFontSize();
    const height = Math.min(need, ceiling);
    el.style.height = `${style.boxSizing === 'border-box' ? height : height - paddingY - borderY}px`;
    el.style.overflowY = need > ceiling ? 'auto' : 'hidden';
}

/**
 * Grow a `<textarea>` to fit what has been typed into it, up to a ceiling.
 *
 * A fixed `rows` is a guess about how long an answer will be, and the guess is
 * always wrong in the same direction: the learner writes a four-line derivation
 * into a three-line box and can then only see the last line of their own work
 * while checking it. Every place a learner types prose — the "check your
 * understanding" answer box, the assistant composer, the tutor, Capture —
 * shares this, so they behave the same way.
 *
 * The ceiling matters as much as the growth: past it the field scrolls instead
 * of growing, so a long answer can never push the Check-answer button (or the
 * conversation above the composer) off the screen.
 *
 * The height it writes is px, measured — so it is re-measured whenever anything
 * that decides it changes, not only the text:
 *   - the VALUE (a programmatic change — reset, restored draft — too);
 *   - the TYPE SIZE: `ui_scale` moves the root font size under a mounted
 *     field, and a height measured at 100% clipped the text at 150%;
 *   - the WIDTH: the same text wraps onto more lines in a narrower box (a
 *     dragged drawer, a rotated phone);
 *   - the ELEMENT: a hook in a component that is mounted before its field is
 *     (the assistant drawer, closed) never measured the field at all.
 */
export function useAutoGrow(
    value: string,
    max: GrowCeiling = { rem: 20 },
): RefObject<HTMLTextAreaElement> {
    const ref = useRef<HTMLTextAreaElement>(null);
    const rows = 'rows' in max ? max.rows : null;
    const rem = 'rem' in max ? max.rem : null;
    const rootPx = useRootFontSize();

    const fit = useRef<() => void>(() => { });
    fit.current = () => {
        const el = ref.current;
        if (el) fitTextarea(el, rows !== null ? { rows } : { rem: rem ?? 20 });
    };

    useLayoutEffect(() => { fit.current(); }, [value, rows, rem, rootPx]);

    // The element and its width. Runs after every render, but does nothing
    // unless the field itself was swapped — one comparison.
    const watched = useRef<HTMLTextAreaElement | null>(null);
    const observer = useRef<ResizeObserver | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (el === watched.current) return;
        watched.current = el;
        observer.current?.disconnect();
        observer.current = null;
        if (!el) return;
        fit.current();
        if (typeof ResizeObserver === 'undefined') return;
        let width = el.clientWidth;
        observer.current = new ResizeObserver(() => {
            // Only a change of WIDTH: the height is the one this hook writes,
            // and re-fitting on it would answer its own write.
            if (el.clientWidth === width) return;
            width = el.clientWidth;
            fit.current();
        });
        observer.current.observe(el);
    });
    useLayoutEffect(() => () => observer.current?.disconnect(), []);

    return ref;
}
