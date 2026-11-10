/**
 * Where a framed course may go: the part of the map ABOVE the bottom strip.
 *
 * While a course is traced, its player (and on a narrow map the row of map
 * controls above it) sits in a strip along the bottom of the map
 * (`MapOverlay`). A course framed on the whole box puts its lower part under
 * that strip, and a replay's arrow flies under it. So every course fit (the
 * pick, the refit after the phone's sheet folds, the replay's following
 * camera, its ending) is worked out for the box above the strip: the map
 * lifts its middle, on the planet and on the unrolled sheet alike.
 *
 * `inset` is the strip's measured height in CSS pixels, from the bottom of the
 * map to the top of the strip plus a gap; zero when no course is traced.
 */

/** The strip never takes more than this share of the map's height: on a map
 *  that short (a phone on its side at a large interface scale) a course framed
 *  into what is left would be a sliver, and some of it under the strip is the
 *  lesser fault. */
export const MAX_INSET_SHARE = 0.5;

/** The box a course is framed in, and how far its middle sits above the
 *  middle of the whole map. */
export function viewAbove(w: number, h: number, inset: number): { w: number; h: number; lift: number } {
    const b = Math.min(Math.max(0, inset || 0), h * MAX_INSET_SHARE);
    return { w, h: h - b, lift: b / 2 };
}

/** The planet's disc (or, on the Map, the sheet's middle): its centre and the
 *  side its radius is a share of, for a given lift (eased toward
 *  `viewAbove(…).lift` while a course is traced). */
export function discView(w: number, h: number, lift: number): { cx: number; cy: number; side: number } {
    return { cx: w / 2, cy: h / 2 - lift, side: Math.max(1, Math.min(w, h - 2 * lift)) };
}
