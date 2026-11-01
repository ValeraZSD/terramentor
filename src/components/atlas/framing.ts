/**
 * Where a framed course may go: the part of the map ABOVE the bottom strip.
 *
 * While a course is traced, its player (and on a narrow map the row of map
 * controls above it) sits in a strip along the bottom of the map
 * (`MapOverlay`). A course framed on the whole box puts its lower part under
 * that strip, and a replay's arrow flies under it. So every course fit (the
 * pick, the refit after the phone's sheet folds, the replay's following
 * camera, its ending) is worked out for the box above the strip, on both
 * surfaces: the plane moves its camera, the planet lifts its disc.
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

/**
 * The plane's camera for a set of world points: their box in the middle of the
 * view above the strip, at the zoom that fills `fill` of it.
 *
 * The plane draws world (x, y) at `(x - cam.x) * s + w / 2` (and the same in
 * y), with `s = base * k`, so a camera `lift / s` further down the world puts
 * the box's middle `lift` pixels above the middle of the map.
 */
export function frameBox(
    points: { x: number; y: number }[],
    size: { w: number; h: number },
    inset: number,
    opts: { base: number; fill: number; minSpan: number; minK: number; maxK: number },
): { x: number; y: number; k: number } | null {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    if (!Number.isFinite(x0)) return null;
    const view = viewAbove(size.w, size.h, inset);
    // A floor on the span, because a journey inside ONE bubble has a bounding
    // box of nearly zero and dividing by it asks for the maximum zoom.
    const spanX = Math.max(x1 - x0, opts.minSpan);
    const spanY = Math.max(y1 - y0, opts.minSpan);
    const k = Math.min(opts.maxK, Math.max(opts.minK,
        Math.min((view.w * opts.fill) / (spanX * opts.base), (view.h * opts.fill) / (spanY * opts.base))));
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 + view.lift / (opts.base * k), k };
}

/** The planet's disc: its centre and the side its radius is a share of, for
 *  a given lift (eased toward `viewAbove(…).lift` while a course is traced). */
export function discView(w: number, h: number, lift: number): { cx: number; cy: number; side: number } {
    return { cx: w / 2, cy: h / 2 - lift, side: Math.max(1, Math.min(w, h - 2 * lift)) };
}
