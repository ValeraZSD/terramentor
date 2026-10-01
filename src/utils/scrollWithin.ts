/**
 * Scroll a row into view inside ITS OWN list, and inside nothing else.
 *
 * `Element.scrollIntoView` is not scoped: it scrolls every scrollable ancestor
 * up to and including the page, because its contract is "make this element
 * visible", not "move this list". That is the right behaviour for a link to a
 * heading and the wrong behaviour for every list this app keeps in sync with a
 * selection, because those lists sit beside something the learner is looking
 * at — and on a phone the "ancestor" is the page.
 *
 * The bug it caused, measured on a 390px phone: tapping a topic on the atlas
 * pinned a card on the map and then scrolled the page 1,013px to bring the
 * matching region row into view, putting the map — and the card that had just
 * opened on it — 322px above the top of the screen. The answer to the tap was
 * off-screen, which is the opposite of what a card anchored to the thing you
 * tapped is for.
 *
 * So: find the nearest ancestor that REALLY scrolls (declares `overflow-y` and
 * has somewhere to go), stop at a boundary the caller names, and move that one
 * element's `scrollTop` by hand. Nothing above it can move, because nothing
 * above it is touched. When the list has no scroller of its own — the same
 * markup on a narrow screen, where the page does the scrolling for everything —
 * there is nothing to scroll and the answer is to leave the screen alone.
 *
 * Vertical only. A horizontal rail scrolled with `inline: 'nearest'` is not in
 * this class: `nearest` does nothing when the element is already visible, so a
 * rail in a sticky header never moves the page.
 */

export type ScrollWithinBlock = 'start' | 'center' | 'nearest';

export interface ScrollWithinOptions {
    /**
     * The list. Required, and fail-closed: the search for a scroller stops here
     * (this element is searched, then given up on), and a null boundary scrolls
     * nothing at all.
     *
     * Not optional, because "the page" is a div in a single-page app — there is
     * no reliable outer edge to stop at on its own, and a caller who has not
     * said which list they mean is a caller about to move the screen. Null is
     * the normal reading of `someRef.current` before it attaches, and doing
     * nothing is the right answer then too.
     */
    boundary: HTMLElement | null;
    /** Where in the scroller the element should land. Default `nearest`. */
    block?: ScrollWithinBlock;
    behavior?: ScrollBehavior;
    /** Breathing room at the edge, in px. */
    padding?: number;
}

/** True when this element declares a vertical scroll AND has room to use it. */
function scrolls(el: HTMLElement): boolean {
    if (el.scrollHeight - el.clientHeight <= 1) return false;
    const overflowY = getComputedStyle(el).overflowY;
    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

/**
 * The scroll container `el` sits in, searching upwards and never leaving
 * `boundary` (or the document body, whichever comes first). Null when nothing
 * between the two scrolls — which is the phone layout of most of these lists.
 */
export function scrollerFor(
    el: HTMLElement | null | undefined,
    boundary: HTMLElement | null,
): HTMLElement | null {
    if (!boundary) return null;
    let node = el?.parentElement ?? null;
    while (node && node !== document.body && node !== document.documentElement) {
        if (scrolls(node)) return node;
        if (node === boundary) return null;
        node = node.parentElement;
    }
    return null;
}

/**
 * Bring `el` into view inside its own scroll container.
 *
 * @returns whether a container was found — false means the page is the only
 *          scroller here and nothing was moved.
 */
export function scrollIntoViewWithin(
    el: HTMLElement | null | undefined,
    { boundary, block = 'nearest', behavior = 'auto', padding = 0 }: ScrollWithinOptions,
): boolean {
    if (!el) return false;
    const scroller = scrollerFor(el, boundary);
    if (!scroller) return false;

    const box = el.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    // Where the element starts within the scrolled CONTENT. Read from the two
    // rects rather than `offsetTop`, which is measured against the nearest
    // positioned ancestor and so is wrong the moment anything between the row
    // and the scroller is `relative` — which, in this codebase, most rows are.
    const top = box.top - frame.top + scroller.scrollTop;
    const view = scroller.clientHeight;
    const limit = scroller.scrollHeight - view;

    let target: number;
    if (block === 'start') {
        target = top - padding;
    } else if (block === 'center') {
        target = top - (view - box.height) / 2;
    } else {
        const from = scroller.scrollTop;
        if (top >= from + padding && top + box.height <= from + view - padding) return true;
        target = top < from + padding ? top - padding : top + box.height - view + padding;
    }

    const next = Math.max(0, Math.min(target, limit));
    if (Math.abs(next - scroller.scrollTop) < 1) return true;
    scroller.scrollTo({ top: next, behavior });
    return true;
}
