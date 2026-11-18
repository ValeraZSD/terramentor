import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useElementWidth } from './useElementWidth';
import { useRootFontSize } from './useRootFontSize';

/** The title's least width in the row, the `min-w-[8rem]` it carries. */
const TITLE_MIN_REM = 8;

/**
 * Whether the detail header's Close should be drawn as just its X.
 *
 * With larger text and buttons the header row (title, Study, two icon buttons,
 * Close) does not fit a phone, and it wraps: Close alone on a second line. The
 * worded Close is the widest of the buttons, so drawing it as the X is often
 * what makes the row fit again. It is drawn so only when that is TRUE: the
 * word does not fit beside the title's least width and the other buttons, and
 * the X does. When even the X would not fit, the row wraps anyway, and a wrapped
 * Close keeps its word.
 *
 * Measured on the row's own width, never a breakpoint: the same phone header is
 * wider or narrower with the text size, the language and the buttons a topic
 * has. The word's width is read while it is drawn and kept per `wordKey` (the
 * language) and text size, so a row showing the X can still tell when the word
 * would fit again. A new key draws the word once to measure it, before the paint.
 *
 * `row` is a flex row whose children are the controls: the title is
 * `[data-row="title"]`, Close is `[data-close="word"]` or `[data-close="icon"]`.
 */
export function useIconOnlyClose(row: RefObject<HTMLElement | null>, active: boolean, wordKey: string): boolean {
    const width = useElementWidth(row);
    const rootPx = useRootFontSize();
    const [iconOnly, setIconOnly] = useState(false);
    const word = useRef<{ key: string; px: number } | null>(null);

    // Every render: the other buttons come and go with the topic (Study is
    // not offered on a note, nothing but Close shows while renaming), and the
    // answer is a comparison of what is on screen now.
    useLayoutEffect(() => {
        const el = row.current;
        const title = el?.querySelector<HTMLElement>(':scope > [data-row="title"]');
        const close = el?.querySelector<HTMLElement>(':scope > [data-close]');
        if (!active || !el || !title || !close || width <= 0) {
            setIconOnly(false);
            return;
        }
        // Kept per language AND text size: a width read at 160% would keep the
        // X after the size went back to 100%, where the word fits again.
        const key = `${wordKey}|${rootPx}`;
        if (close.dataset.close === 'word') word.current = { key, px: close.getBoundingClientRect().width };
        if (word.current?.key !== key) {
            setIconOnly(false);
            return;
        }
        const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
        let rest = TITLE_MIN_REM * rootPx + gap * (el.children.length - 1);
        for (const child of el.children) {
            if (child !== title && child !== close) rest += child.getBoundingClientRect().width;
        }
        const x = Math.max(2.75 * rootPx, 44);
        const room = width + 0.5;
        setIconOnly(rest + word.current.px > room && rest + x <= room);
    });

    return iconOnly;
}
