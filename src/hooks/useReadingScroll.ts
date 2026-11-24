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

/** Text hidden by less than this does not count as "more below": half a line, a subpixel. */
const BELOW_SLACK = 8;

/**
 * How many px of written text lie below the visible part of a scroller: the
 * last line ends at `lastBottom`, the scroller's box ends at `scrollerBottom`
 * (viewport px) and its bottom padding is not part of the visible text area.
 */
export function textBelow(lastBottom: number, scrollerBottom: number, padBottom: number): number {
    return lastBottom - (scrollerBottom - padBottom);
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

    /**
     * How far the last written line ends below what the reader can see, in px
     * (zero or less: it is in view). Measured to the last message, never to
     * the box's bottom, which may be the empty room made for the question.
     */
    const hiddenBelow = () => {
        const el = ref.current;
        const last = contentRef.current?.lastElementChild;
        if (!el || !last) return 0;
        return textBelow(last.getBoundingClientRect().bottom, el.getBoundingClientRect().bottom, padding(el).bottom);
    };

    /**
     * Whether text continues below the view. A log that does not follow the
     * stream must say so, or a reply written past the bottom edge looks like a
     * reply that stopped there.
     */
    const [below, setBelow] = useState(false);
    const belowRef = useRef(false);
    // Called on every render of a streaming answer: no setState unless the
    // answer changed, so a stream frame never schedules a render of its own.
    const measure = useCallback(() => {
        const b = hiddenBelow() > BELOW_SLACK;
        if (b === belowRef.current) return;
        belowRef.current = b;
        setBelow(b);
    }, []);

    /** Bring the last written line into view, at the bottom edge. */
    const toEnd = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollTop + hiddenBelow(), behavior: motionReduced() ? 'auto' : 'smooth' });
    }, []);

    // The scroller resized (the panel dragged, a phone keyboard opened) or was
    // rebuilt (docked or undocked): measure the room again. Scrolling only
    // changes what is below the view.
    useEffect(() => {
        if (!scroller) return;
        fit();
        measure();
        scroller.addEventListener('scroll', measure, { passive: true });
        if (typeof ResizeObserver === 'undefined') return () => scroller.removeEventListener('scroll', measure);
        const ro = new ResizeObserver(() => { if (anchorRef.current) fit(); measure(); });
        ro.observe(scroller);
        return () => { ro.disconnect(); scroller.removeEventListener('scroll', measure); };
    }, [scroller, fit, measure]);

    // One memoised object: callers list it in effect dependency arrays.
    return useMemo(
        () => ({ ref, scrollerRef, contentRef, anchor, toBottom, toTop, release, below, measure, toEnd }),
        [scrollerRef, anchor, toBottom, toTop, release, below, measure, toEnd],
    );
}
