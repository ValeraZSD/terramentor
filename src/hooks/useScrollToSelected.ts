import { RefObject, useEffect } from 'react';
import { scrollIntoViewWithin } from '../utils/scrollWithin';

/**
 * Scrolls the element marked `data-node-id="<selectedNodeId>"` inside `containerRef`
 * into view whenever the selection (or any extra dep) changes. Used to keep the
 * sidebar, tree, timeline and calendar in sync with the globally selected node.
 *
 * Smoothly animates the target to the vertical centre of its scroll container,
 * and runs on the next frame so freshly-revealed (expanded) rows are laid out first.
 *
 * "Its scroll container" is the load-bearing half, and `scrollIntoView` does not
 * honour it: that moves every scrollable ancestor including the page. All four
 * of these surfaces are also mounted in a ~390px workspace panel where the page
 * is the only scroller, so selecting a node in one pane used to drag the whole
 * screen to wherever the row happened to be — including away from the pane the
 * learner selected it in. `scrollIntoViewWithin` moves the container itself and
 * nothing above it, and does nothing at all when the list has no scroller of its
 * own (the page already shows the row; there is nowhere to put it).
 */
export function useScrollToSelected(
    selectedNodeId: number | null,
    containerRef: RefObject<HTMLElement>,
    extraDeps: unknown[] = [],
) {
    useEffect(() => {
        if (selectedNodeId == null) return;
        const container = containerRef.current;
        if (!container) return;
        const raf = requestAnimationFrame(() => {
            const el = container.querySelector<HTMLElement>(`[data-node-id="${selectedNodeId}"]`);
            // Centre the target vertically with a smooth transition (respects
            // reduced-motion: browsers fall back to an instant jump automatically).
            scrollIntoViewWithin(el, { boundary: container, block: 'center', behavior: 'smooth' });
        });
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedNodeId, containerRef, ...extraDeps]);
}
