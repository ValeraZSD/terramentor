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

/** Share of the visible text one press of "More below" moves on. */
const PAGE_SHARE = 0.8;

/**
 * How far one press of "More below" scrolls: one page, keeping the last fifth
 * of the view (the lines the button sat over) at the top as the place to go
 * on from, and never past the last written line. `hidden` is `textBelow`,
 * `view` the height of the scroller's text area (client height minus padding).
 */
export function pageStep(hidden: number, view: number): number {
    return Math.max(0, Math.min(hidden, Math.round(view * PAGE_SHARE)));
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
 *
 * Returns `[scroll, below]`: `scroll` keeps one identity for the life of the
 * panel, so effects can list it without re-running, and `below` (text runs on
 * out of sight) changes on its own. Bundling the two once made the panel's
 * open effect re-run, and jump to the bottom, each time `below` flipped.
 */
export function useReadingScroll<T extends HTMLElement, C extends HTMLElement = HTMLDivElement>() {
    const ref = useRef<T | null>(null);
    const [scroller, setScroller] = useState<T | null>(null);
    const contentRef = useRef<C>(null);
    /** The anchored turn's id, and where it last stood inside the content box. */
    const anchorRef = useRef<{ id: string; offset: number } | null>(null);
    /** Where the reader was, for a scroller rebuilt when the panel docks or undocks. */
    const readerRef = useRef({ top: 0, pastAnchor: 0 });
    /** Whether a scroller was attached before this one (a rebuild, not an opening). */
    const attachedRef = useRef(false);

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
     * The anchored question's row now carries `id`: its provisional copy was
     * swapped for the stored one. It is already in place, so nothing moves;
     * only later measuring must find the new row.
     */
    const retarget = useCallback((id: string | number) => {
        if (!anchorRef.current) return;
        anchorRef.current.id = String(id);
        fit();
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
    /**
     * Watches the last message (it grows inside the room without the scroller
     * changing size) and the content box (an earlier row growing moves the
     * last one down once the box is past its room).
     */
    const rowsRef = useRef<{ observer: ResizeObserver; watched: Element[] } | null>(null);
    // Called on every render of a streaming answer: no setState unless the
    // answer changed, so a stream frame never schedules a render of its own.
    const measure = useCallback(() => {
        const rows = rowsRef.current;
        const content = contentRef.current;
        const want = [content, content?.lastElementChild].filter((e): e is NonNullable<typeof e> => !!e);
        if (rows && (want.length !== rows.watched.length || want.some((e, i) => e !== rows.watched[i]))) {
            for (const e of rows.watched) rows.observer.unobserve(e);
            for (const e of want) rows.observer.observe(e);
            rows.watched = want;
        }
        const b = hiddenBelow() > BELOW_SLACK;
        if (b === belowRef.current) return;
        belowRef.current = b;
        setBelow(b);
    }, []);

    /**
     * Turn one page: move on by `pageStep`, so a reader never skips the text
     * between where they are and the end. The press that reaches the last line
     * leaves keyboard focus on the log: the control goes away once nothing is
     * hidden, and focus must not fall back to the page.
     */
    const nextPage = useCallback((event?: { currentTarget: EventTarget | null }) => {
        const el = ref.current;
        if (!el) return;
        const pad = padding(el);
        const hidden = hiddenBelow();
        const step = pageStep(hidden, el.clientHeight - pad.top - pad.bottom);
        if (step >= hidden - BELOW_SLACK && event?.currentTarget && event.currentTarget === document.activeElement) el.focus({ preventScroll: true });
        el.scrollTo({ top: el.scrollTop + step, behavior: motionReduced() ? 'auto' : 'smooth' });
    }, []);

    // The scroller resized (the panel dragged, a phone keyboard opened) or was
    // rebuilt (docked or undocked): measure the room again, and put a rebuilt
    // one back where the reader was. Scrolling only changes what is below.
    useEffect(() => {
        if (!scroller) { attachedRef.current = false; return; }
        const rebuilt = attachedRef.current;
        attachedRef.current = true;
        fit();
        /** The scrollTop that puts the anchored question at the top, or null. */
        const anchorTop = () => {
            const a = anchorRef.current;
            const row = a && contentRef.current ? target(contentRef.current, a.id) : null;
            return row ? scrollTargetFor(row.getBoundingClientRect().top, scroller.getBoundingClientRect().top, scroller.scrollTop, padding(scroller).top) : null;
        };
        if (rebuilt) {
            // How far the reader had read past the question, kept across the
            // rebuild (the text rewraps to the new width, so pixels are close,
            // not exact); with no question placed, the old position.
            const at = anchorTop();
            scroller.scrollTop = at != null ? at + readerRef.current.pastAnchor : readerRef.current.top;
        }
        const onScroll = () => {
            const at = anchorTop();
            readerRef.current = { top: scroller.scrollTop, pastAnchor: at != null ? scroller.scrollTop - at : 0 };
            measure();
        };
        scroller.addEventListener('scroll', onScroll, { passive: true });
        if (typeof ResizeObserver === 'undefined') {
            measure();
            return () => scroller.removeEventListener('scroll', onScroll);
        }
        const ro = new ResizeObserver(() => { if (anchorRef.current) fit(); measure(); });
        ro.observe(scroller);
        rowsRef.current = { observer: new ResizeObserver(() => measure()), watched: [] };
        measure();
        return () => {
            ro.disconnect();
            rowsRef.current?.observer.disconnect();
            rowsRef.current = null;
            scroller.removeEventListener('scroll', onScroll);
        };
    }, [scroller, fit, measure]);

    // One identity for the life of the panel: `below` is NOT in it (see above).
    const scroll = useMemo(
        () => ({ scrollerRef, contentRef, anchor, retarget, toBottom, toTop, release, measure, nextPage }),
        [scrollerRef, anchor, retarget, toBottom, toTop, release, measure, nextPage],
    );
    return [scroll, below] as const;
}
