import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * "Follow the stream, unless the reader is reading" — the scroll behaviour every
 * chat surface in the app must share.
 *
 * A chat that always jams itself to the bottom is unusable while a model is
 * generating: the learner scrolls up to re-read the derivation the answer refers
 * to, and the next token yanks them back down. A chat that never follows is just
 * as bad — you sit watching a static screen while the reply happens off-frame.
 * The rule that works is *stickiness*, and getting it right is fiddly enough
 * (programmatic scrolls that look like user scrolls, panels hidden with
 * `display: none`, the "back at the bottom" threshold) that it must exist once
 * rather than be re-derived per surface. It was originally solved in the node
 * tutor; the global assistant scrolled with `scrollIntoView` and so had none of
 * it — this hook is that logic lifted out, and both now run the same code.
 *
 * Stickiness is decided by DIRECTION, not distance: any upward movement releases
 * the follow immediately, and it only resumes once the reader is genuinely back
 * at the bottom. Programmatic scrolls only ever move down, so they can never
 * unstick by accident.
 *
 * @param active false while the container is hidden. A panel hidden with
 *        `display: none` loses its scroll box, so the browser zeroes scrollTop
 *        and fires a scroll event that would otherwise be read as "the user
 *        jumped to the top". Call `restore()` when it comes back.
 */
export function useStickToBottom<T extends HTMLElement>(active = true) {
    const ref = useRef<T>(null);
    /** Whether new content should pull the view down. */
    const stuckRef = useRef(true);
    /** Last observed scrollTop — gives direction, and the position to restore to. */
    const lastTopRef = useRef(0);
    const activeRef = useRef(active);

    useEffect(() => { activeRef.current = active; }, [active]);

    const scrollToBottom = useCallback((smooth = false) => {
        const el = ref.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
        // Remember where we just put it, so the downward scroll event this
        // causes is not mistaken for the reader moving.
        lastTopRef.current = el.scrollTop;
    }, []);

    /** Re-arm following and go to the bottom — what sending a message should do. */
    const stick = useCallback((smooth = false) => {
        stuckRef.current = true;
        scrollToBottom(smooth);
    }, [scrollToBottom]);

    /** Follow new content only if the reader has not scrolled away. */
    const follow = useCallback(() => {
        if (stuckRef.current) scrollToBottom();
    }, [scrollToBottom]);

    const onScroll = useCallback(() => {
        const el = ref.current;
        if (!el || !activeRef.current) return;
        const top = el.scrollTop;
        if (top < lastTopRef.current - 1) {
            // The slightest upward movement hands control back to the reader.
            stuckRef.current = false;
        } else if (el.scrollHeight - top - el.clientHeight < 4) {
            // Back at the very bottom — resume following.
            stuckRef.current = true;
        }
        lastTopRef.current = top;
    }, []);

    /**
     * Put the view back where it was after the container was hidden and shown
     * again — at the bottom if the reader was following a live stream, otherwise
     * exactly where they had scrolled to.
     */
    const restore = useCallback(() => {
        const target = lastTopRef.current;
        requestAnimationFrame(() => {
            const el = ref.current;
            if (!el) return;
            if (stuckRef.current) scrollToBottom();
            else el.scrollTop = target;
        });
    }, [scrollToBottom]);

    // Memoised as one object: callers list it in effect dependency arrays, and a
    // fresh literal every render would re-run "snap to the bottom" on every
    // render instead of only when the messages actually changed.
    return useMemo(
        () => ({ ref, onScroll, scrollToBottom, stick, follow, restore, stuckRef }),
        [onScroll, scrollToBottom, stick, follow, restore],
    );
}
