/**
 * Where the atlas's floating card goes, inside the map's own box.
 *
 * Pure arithmetic, out here rather than inline in the renderer, because the
 * thing it has to get right is invisible in the common case and only shows up
 * at one screen size — so it needs a test, and a test needs a function.
 *
 * The card opens above the dot it describes, which is the right side while
 * there is room above. There often is not: measured at 390×844, a topic in the
 * top fifth of the map anchored its 127px card at y=82 in a box starting at
 * y=201, so 118 of those pixels were outside the map — which is
 * `overflow-hidden` — and the tap's whole answer was an 8px sliver with the
 * Open button cut off it. So it flips below when above does not fit, and both
 * edges are clamped against the card's MEASURED size: the horizontal clamp used
 * to assume a 160px card and the real one is up to 240px, wider again at a
 * large `ui_scale`.
 */

/** The centre of the thing the card describes, and the radius it must clear. */
export interface CardAnchor { x: number; y: number; r: number }
export interface CardBox { w: number; h: number }
export interface MapSize { w: number; h: number }

export interface CardPlacement {
    left: number;
    top: number;
    /**
     * True only before the card has been measured once — one frame, positioned
     * the legacy way (`translateY(-100%)` from a point above the dot) and
     * corrected by a layout effect before anything is painted.
     */
    unmeasured: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Breathing room between the card and the edge of the map. */
export const CARD_EDGE = 6;

export function placeCard(anchor: CardAnchor, card: CardBox, size: MapSize): CardPlacement {
    const { w, h } = size;
    if (!card.h) {
        return { left: clamp(anchor.x, 80, Math.max(80, w - 80)), top: anchor.y - anchor.r, unmeasured: true };
    }
    const above = anchor.y - anchor.r - card.h;
    const below = anchor.y + anchor.r;
    // Above wins on a tie: it is where the card has always opened, and flipping
    // a card that fits both ways would move it for no reason. Below is taken
    // only when above does not fit AND below does.
    const up = above >= CARD_EDGE || below + card.h > h - CARD_EDGE;
    const half = card.w / 2;
    return {
        // `left` is the card's CENTRE (it is drawn with translateX(-50%)), so a
        // card wider than the map collapses to the middle rather than inverting.
        left: clamp(anchor.x, Math.min(half + CARD_EDGE, w / 2), Math.max(w - half - CARD_EDGE, w / 2)),
        top: clamp(up ? above : below, CARD_EDGE, Math.max(CARD_EDGE, h - card.h - CARD_EDGE)),
        unmeasured: false,
    };
}
