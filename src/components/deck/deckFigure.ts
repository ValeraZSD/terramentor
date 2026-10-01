/**
 * How a set of cards is drawn — the arithmetic half, kept free of React.
 *
 * Split out for the same reason `src/components/atlas/mapLabels.ts` was: these
 * two functions decide whether a figure is legible, and a decision with nothing
 * to catch it is one that quietly stops being made. As plain arithmetic over a
 * width and a count, `tools/deck-gates.mjs` can assert the phone cases without
 * a browser — which matters here because the failure they exist to prevent only
 * shows up at a width no desktop ever has.
 */

/**
 * Below this a square stops reading as a card and the row becomes a texture.
 *
 * Tuned against the two real decks that straddle it, not picked round: a
 * 50-card stage in the 234px a row gets on a 390px phone is 3.7px per
 * card and still reads as fifty things, while another deck's 86- and
 * 103-card sections are 1.7px and 1.4px, which is the moiré that started this.
 * Anything that moves this constant has to be re-checked against both.
 */
export const MIN_TICK = 3.5;

/**
 * How to draw `count` ticks in `width` pixels, or `null` for "use the bar".
 *
 * The choice was a card count — the server sends a per-card map up to 240 cards,
 * draw ticks if you got one — and that is wrong in the only place it matters:
 * the same 103-card row that reads perfectly at 716px on a desktop is 1.7px per
 * card in the 234px a stage row gets on a phone, which is not small squares but
 * a moiré pattern. The marks come from the data and the space comes from the
 * device, so only the two together can answer it.
 *
 * Gaps are tried widest-first and the first that still leaves a legible square
 * wins. **Zero is not among them on purpose** — with no gap the squares fuse
 * into a solid bar, so it *is* the bar, drawn expensively and with a ragged
 * edge where the rounding falls.
 */
export function tickPlan(width: number, count: number): { gap: number; tick: number } | null {
    if (!(width > 0) || count <= 0) return null;
    for (const gap of [2, 1]) {
        const tick = (width - gap * (count - 1)) / count;
        if (tick >= MIN_TICK) return { gap, tick };
    }
    return null;
}

/**
 * The gap between stage blocks on the strip, in px.
 *
 * Also measured rather than assumed, because at the extreme the GAPS are the
 * thing that overflows: 240 stages at one pixel apart is 239px of air, which on
 * its own does not fit a 200px strip however thin the blocks get. Widest first,
 * and a gap is only affordable while it costs less than half the figure.
 */
export function stripGap(width: number, count: number): number {
    if (!(width > 0) || count <= 1) return 2;
    for (const gap of [2, 1]) {
        if (gap * (count - 1) <= width / 2) return gap;
    }
    return 0;
}

/** Widest a stage block on the strip may be floored to. */
export const MAX_MIN_BLOCK = 7;
/** Floor for a state segment inside one of those blocks. */
export const MIN_SEGMENT = 3;

/**
 * The smallest a stage block on the strip is allowed to be.
 *
 * A stage worth 2 cards of 521 is 4px of the strip and its green is half of
 * that — a 2px sliver with a 2px corner radius taken off each end, i.e.
 * nothing. Measured on a real maths deck, which is the case this has to
 * answer: "2 met" must be visible or the strip is lying about the one thing it
 * is for. So the block gets a floor and the segment inside it gets a floor —
 * and the block floor is clamped to an equal share of the real width, so sixty
 * stages on a phone still fit instead of overflowing the card.
 */
export function blockFloor(width: number, count: number, gap: number): number {
    if (!(width > 0) || count <= 0) return 4;
    const avail = width - gap * (count - 1);
    // The equal share is the ceiling on the floor, and there is no `Math.max`
    // rescuing it: a minimum of 2px across 120 stages on a phone is 359px of
    // blocks in a 300px strip, i.e. the floor that exists to keep a stage
    // visible would push the last stages out of the figure entirely. A deck cut
    // that fine genuinely has hairline blocks; the strip says so instead of
    // overflowing the card it sits in.
    return Math.max(0, Math.min(MAX_MIN_BLOCK, Math.floor(avail / count)));
}
