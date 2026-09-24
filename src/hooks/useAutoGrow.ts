import { useLayoutEffect, useRef, RefObject } from 'react';

/**
 * Grow a `<textarea>` to fit what has been typed into it, up to a ceiling.
 *
 * A fixed `rows` is a guess about how long an answer will be, and the guess is
 * always wrong in the same direction: the learner writes a four-line derivation
 * into a three-line box and can then only see the last line of their own work
 * while checking it. Both places a learner types prose — the "check your
 * understanding" answer box and the assistant composer — share this, so they
 * behave the same way.
 *
 * The ceiling matters as much as the growth: past it the field scrolls instead
 * of growing, so a long answer can never push the Check-answer button (or the
 * conversation above the composer) off the screen.
 *
 * @param value the controlled value — resizing is driven by content, not events,
 *              so a programmatic change (reset, restored draft) resizes too.
 * @param max   the ceiling: a number of px, or `{ rows: n }` when the natural
 *              unit is lines of text (a chat composer is "grow to five lines";
 *              an answer box is "grow to this much of the card"). Rows are
 *              measured from the element's own computed line-height and box
 *              spacing, so it holds under any font size the user has set.
 */
export function useAutoGrow(
    value: string,
    max: number | { rows: number } = 320,
): RefObject<HTMLTextAreaElement> {
    const ref = useRef<HTMLTextAreaElement>(null);
    const rows = typeof max === 'number' ? null : max.rows;
    const px = typeof max === 'number' ? max : null;

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        // Collapse first: scrollHeight can only report a box at least as tall as
        // the current one, so measuring without this makes the field a ratchet
        // that never shrinks when text is deleted.
        el.style.height = 'auto';
        let ceiling = px ?? 320;
        if (rows !== null) {
            const style = window.getComputedStyle(el);
            const lineHeight = parseFloat(style.lineHeight) || 20;
            const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
            const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
            ceiling = lineHeight * rows + paddingY + borderY;
        }
        el.style.height = `${Math.min(el.scrollHeight, ceiling)}px`;
        el.style.overflowY = el.scrollHeight > ceiling ? 'auto' : 'hidden';
    }, [value, px, rows]);

    return ref;
}
