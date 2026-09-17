import { useCallback, useRef, useState } from 'react';

/**
 * The three-panel swipe carousel both calendars used to carry a private copy of.
 *
 * The shape: a viewport with `overflow-hidden`, holding a track of exactly three
 * equal panels (prev | curr | next). At rest the track is shifted left by one
 * panel width so the CURRENT period is the one on screen; a horizontal drag
 * translates it, and a far-enough swipe animates the rest of the way and then
 * commits — at which point the caller has stepped its own date state, so the
 * newly-centred panel is re-rendered as `curr` and the offset resets with no
 * animation. That commit-after-the-transition ordering is the whole trick: step
 * the date first and the panel visibly jumps before it slides.
 *
 * The viewport is measured through a CALLBACK ref, not a layout effect. On a
 * cold reload straight into a calendar the empty-state placeholder renders
 * first and the real body mounts a tick later, so a one-shot `useLayoutEffect`
 * measures the absent node once and leaves the width at 0 — which collapses the
 * track to nothing. A callback ref re-fires when the node actually arrives.
 */
export interface SwipeCarousel {
    /** Ref for the `overflow-hidden` viewport element. */
    viewportRef: (el: HTMLDivElement | null) => void;
    /** Spread onto the flex track that holds the three panels. */
    trackProps: {
        style: React.CSSProperties;
        onTransitionEnd: (e: React.TransitionEvent) => void;
        onTouchStart: (e: React.TouchEvent) => void;
        onTouchMove: (e: React.TouchEvent) => void;
        onTouchEnd: () => void;
    };
    /** Style for each of the three panel wrappers. */
    panelStyle: React.CSSProperties;
}

export function useSwipeCarousel(onPrev: () => void, onNext: () => void): SwipeCarousel {
    const roRef = useRef<ResizeObserver | null>(null);
    const [trackW, setTrackW] = useState(0);
    const [dragX, setDragX] = useState(0);
    const [animating, setAnimating] = useState(false);
    const pendingNav = useRef<'prev' | 'next' | null>(null);
    const touch = useRef<{ x: number; y: number; locked: 'h' | 'v' | null; active: boolean }>({
        x: 0, y: 0, locked: null, active: false,
    });

    const viewportRef = useCallback((el: HTMLDivElement | null) => {
        roRef.current?.disconnect();
        if (!el) { roRef.current = null; return; }
        const measure = () => setTrackW(el.clientWidth);
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        roRef.current = ro;
    }, []);

    const onTouchStart = (e: React.TouchEvent) => {
        if (animating || e.touches.length !== 1) return;
        touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, locked: null, active: true };
    };

    const onTouchMove = (e: React.TouchEvent) => {
        const t = touch.current;
        if (!t.active) return;
        const dx = e.touches[0].clientX - t.x;
        const dy = e.touches[0].clientY - t.y;
        // Lock to one axis on the first 8px so a vertical scroll through a day's
        // tasks never drags the period sideways underneath it.
        if (t.locked === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
            t.locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
        }
        if (t.locked === 'h') setDragX(dx);
    };

    const onTouchEnd = () => {
        const t = touch.current;
        t.active = false;
        if (t.locked !== 'h') return;
        const threshold = Math.min(80, trackW * 0.25);
        if (dragX <= -threshold) { pendingNav.current = 'next'; setAnimating(true); setDragX(-trackW); }
        else if (dragX >= threshold) { pendingNav.current = 'prev'; setAnimating(true); setDragX(trackW); }
        else { setAnimating(true); setDragX(0); }   // snap back
    };

    const onTransitionEnd = (e: React.TransitionEvent) => {
        // transitionend bubbles — ignore a child's colour transition and react
        // only to the track's own transform finishing.
        if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
        setAnimating(false);
        const nav = pendingNav.current;
        pendingNav.current = null;
        if (nav === 'next') onNext();
        else if (nav === 'prev') onPrev();
        setDragX(0);   // re-centre on the (now updated) current panel, un-animated
    };

    return {
        viewportRef,
        trackProps: {
            style: {
                width: trackW ? trackW * 3 : '300%',
                transform: `translateX(${-trackW + dragX}px)`,
                transition: animating ? 'transform 220ms ease-out' : 'none',
            },
            onTransitionEnd,
            onTouchStart,
            onTouchMove,
            onTouchEnd,
        },
        panelStyle: { width: trackW || undefined },
    };
}
