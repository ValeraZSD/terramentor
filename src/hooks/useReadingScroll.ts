import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motionReduced } from '../utils/accessibility';

/**
 * The attribute each turn's row carries (`data-turn-id={m.id}` in the JSX), so
 * a question can be found again after a re-render replaced its element.
 */
const TURN_ATTR = 'data-turn-id';

/**
 * Height the content box needs so a question `offset` px down it can sit at the
 * top of a scroller `clientHeight` tall with vertical padding `padTop`/`padBottom`.
 */
export function roomFor(offset: number, clientHeight: number, padTop: number, padBottom: number): number {
    return Math.max(0, offset + clientHeight - padTop - padBottom);
}

/**
 * The scrollTop that puts an element whose top is `targetTop` (viewport px) at
 * the top of the scroller, one padding below its edge, as the first message sits.
 */
export function scrollTargetFor(targetTop: number, scrollerTop: number, scrollTop: number, padTop: number): number {
    return targetTop - scrollerTop + scrollTop - padTop;
}

/**
 * How a chat log scrolls while a model writes into it: like a page being
 * written, not like a terminal.
 *
 * Sending a question moves that question to the TOP of the view, once. The
 * answer is then written below it and the view never moves on its own: the
 * reader reads down at their own pace and scrolls when they reach the edge,
 * the way a printed page is read. A log that follows every token moves the
 * line being read up the screen several times a second, and a reader who
 * scrolled up to re-read was pulled back down.
 *
 * Putting the question at the top needs room under it, while the answer is
 * still short: the content box gets a `min-height` that lets the question
 * reach the top, and the answer then fills that room instead of making the
 * log longer. So nothing below the reader changes height while they read, and
 * the browser never has to clamp the scroll position.
 *
 * `scrollerRef` goes on the scroller (a callback ref: the panel rebuilds it
 * when it docks or undocks), `contentRef` on the box holding the messages,
 * directly inside it; each turn's row carries `TURN_ATTR`.
 */
export function useReadingScroll<T extends HTMLElement, C extends HTMLElement = HTMLDivElement>() {
    const ref = useRef<T | null>(null);
    const [scroller, setScroller] = useState<T | null>(null);
    const contentRef = useRef<C>(null);
    /** The anchored turn's id, and where it last stood inside the content box. */
    const anchorRef = useRef<{ id: string; offset: number } | null>(null);

    const scrollerRef = useCallback((node: T | null) => {
        ref.current = node;
        setScroller(node);
    }, []);

    /** The scroller's vertical padding, which the content box does not include. */
    const padding = (el: HTMLElement) => {
        const s = getComputedStyle(el);
        return { top: parseFloat(s.paddingTop) || 0, bottom: parseFloat(s.paddingBottom) || 0 };
    };

    /** The anchored row, found again: a re-render may have replaced the element. */
    const target = (content: HTMLElement, id: string) =>
        content.querySelector<HTMLElement>(`[${TURN_ATTR}="${CSS.escape(id)}"]`);

    /**
     * Give the content box enough height for the anchored question to reach the
     * top. The offset is measured again each time (text above it rewraps when
     * the panel is resized); `min-height` only changes what lies BELOW it.
     */
    const fit = useCallback(() => {
        const el = ref.current;
        const content = contentRef.current;
        if (!el || !content) return;
        const a = anchorRef.current;
        if (!a) { content.style.minHeight = ''; return; }
        const row = target(content, a.id);
        if (row) a.offset = row.getBoundingClientRect().top - content.getBoundingClientRect().top;
        const pad = padding(el);
        content.style.minHeight = `${roomFor(a.offset, el.clientHeight, pad.top, pad.bottom)}px`;
    }, []);

    /** Drop the room made for an anchored question. */
    const release = useCallback(() => {
        anchorRef.current = null;
        fit();
    }, [fit]);

    /** Go to the newest message: opening the panel or a conversation. */
    const toBottom = useCallback(() => {
        release();
        const el = ref.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [release]);

    /** Back to the top: the conversation list, a new empty chat. */
    const toTop = useCallback(() => {
        release();
        if (ref.current) ref.current.scrollTop = 0;
    }, [release]);

    /**
     * Put the turn `id` (a question just sent) at the top of the view, smoothly
     * unless the reader asked for less motion. The only scroll a turn causes.
     */
    const anchor = useCallback((id: string | number) => {
        const el = ref.current;
        const content = contentRef.current;
        if (!el || !content) return;
        anchorRef.current = { id: String(id), offset: 0 };
        // Twice: the room added can bring in a scrollbar, which narrows the
        // text above and moves the question; the second pass measures that.
        fit();
        fit();
        const row = target(content, String(id));
        if (!row) return;
        el.scrollTo({
            top: scrollTargetFor(row.getBoundingClientRect().top, el.getBoundingClientRect().top, el.scrollTop, padding(el).top),
            behavior: motionReduced() ? 'auto' : 'smooth',
        });
    }, [fit]);

    // The scroller resized (the panel dragged, a phone keyboard opened) or was
    // rebuilt (docked or undocked): measure the room again.
    useEffect(() => {
        if (!scroller) return;
        fit();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => { if (anchorRef.current) fit(); });
        ro.observe(scroller);
        return () => ro.disconnect();
    }, [scroller, fit]);

    // One memoised object: callers list it in effect dependency arrays.
    return useMemo(
        () => ({ ref, scrollerRef, contentRef, anchor, toBottom, toTop, release }),
        [scrollerRef, anchor, toBottom, toTop, release],
    );
}
