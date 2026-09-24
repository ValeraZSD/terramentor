/**
 * A BOX THAT SCROLLS SAYS SO BEFORE YOU SCROLL IT.
 *
 * The activity log is a 384px window onto a list of 1,744 events. Nothing at
 * its edges said that: the last row was cut off mid-line by the panel's
 * divider, which looks exactly like a list that happens to end there, and on
 * Android the scrollbar is invisible until a finger is already moving. So
 * nothing on the screen says the box scrolls until somebody scrolls it, which
 * is the one moment the affordance is no longer needed.
 *
 * So the edges fade INTO the surface behind them, and only on the side that
 * has more to show — a shade at the bottom means "there is more below", and it
 * disappears at the end of the list, which is how the reader learns the rule.
 * Measured against the alternatives: a permanent inset shadow says the same
 * thing when there is nothing more, and a "scroll for more" caption spends a
 * row saying what a gradient says in nothing.
 *
 * The shades are drawn as siblings, not as a `mask-image` on the scroller —
 * a mask composites the whole subtree, which makes it the containing block for
 * anything `position: fixed` inside it (the trap `overlay-gates.mjs` exists
 * for) and forces text through a second paint on every scroll frame.
 *
 * `surface` is the colour the fade lands in, as a Tailwind `from-*` pair; the
 * scroller usually sits on a card, so it defaults to the card's white/slate.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cx } from './vocabulary';

const EDGE = 4; // px of slack: a subpixel scrollTop must not leave a shade on

export default function ScrollShade({
    children, className = '', surface = 'from-white dark:from-slate-800', ...rest
}: {
    children: React.ReactNode;
    className?: string;
    surface?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
    const ref = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ top: false, bottom: false });

    const measure = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        const top = el.scrollTop > EDGE;
        const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - EDGE;
        setEdges(prev => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    }, []);

    // The content arrives after the first paint (the log is fetched), and it
    // changes length when the filter changes — so the measurement follows the
    // ELEMENT, not the mount.
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        for (const child of Array.from(el.children)) ro.observe(child);
        return () => ro.disconnect();
    }, [measure, children]);

    return (
        <div className="relative">
            <div ref={ref} onScroll={measure} className={cx('overflow-y-auto', className)} {...rest}>
                {children}
            </div>
            <div
                aria-hidden="true"
                className={cx(
                    'pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b to-transparent transition-opacity duration-150',
                    surface, edges.top ? 'opacity-100' : 'opacity-0',
                )}
            />
            <div
                aria-hidden="true"
                className={cx(
                    'pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t to-transparent transition-opacity duration-150',
                    surface, edges.bottom ? 'opacity-100' : 'opacity-0',
                )}
            />
        </div>
    );
}
