/**
 * How much of an outline the flat map needs at the zoom it is drawn at.
 *
 * The land's outlines are traced on a mesh about half a degree fine, so the
 * whole map is some 33,000 points (coasts, the waterlines round them and every
 * territory's loop). Zoomed out, a dozen of those points fall inside one screen
 * pixel, and the sheet re-projects every one of them on every frame of a drag,
 * through a projection with five trig calls a point. Most of them change
 * nothing on screen.
 *
 * So each line is ranked once, Douglas–Peucker style: a point's IMPORTANCE is
 * how far the line would stray if it were left out, given the points ranked
 * above it. A frame keeps the points whose importance is over the angle one
 * fraction of a pixel spans at its zoom (`sheetTolerance`), which is the
 * simplified line Douglas–Peucker would give at that tolerance, without
 * running it per frame. Zoomed in, the tolerance shrinks and the points come
 * back.
 *
 * Distances are measured on the sphere, so the ranking holds for any camera;
 * the frame turns the tolerance into an angle through the sheet's largest
 * scale. Two things besides a point's own distance keep it:
 * - a segment drawn straight between two kept points is a straight line on
 *   the screen, but the stretch of sphere it stands for projects as a curve,
 *   so a segment may not get so long that the curve's bow shows (`BEND`);
 * - a line's two ends are always kept.
 */

/** The furthest a left-out point may be from the line drawn in its place,
 *  in screen pixels, where the sheet is stretched most (`SHEET_SCALE`). In the
 *  middle of the sheet, where the land is, it is about half that. */
export const DETAIL_PX = 0.5;

/**
 * The sheet's largest scale, in sheet units per radian of arc, anywhere up to
 * 72° from the camera's equator (Winkel tripel; 1.76 at 60°, 1.96 at 72°,
 * re-measured by `tools/atlas-world-gates.mjs`). Nearer the pole the east-west
 * scale grows without bound, since the pole is a line, but the planet is
 * turned so that no land lies there.
 */
export const SHEET_SCALE = 2;

/** How short a segment must be for its bow to stay under the tolerance: a
 *  segment of `L` radians is split while `BEND · L²` is over it. */
export const BEND = 0.5;

/** The angle a kept segment may stray by on a sheet drawn `R` pixels to a unit. */
export function sheetTolerance(R: number): number {
    return R > 0 ? DETAIL_PX / (R * SHEET_SCALE) : 0;
}

/**
 * Rank every point of a line of unit vectors (x, y, z flat): the importance of
 * a point is the error a simplification would make by leaving it out, never
 * more than that of the point whose split brought it in, so "importance over
 * the tolerance" picks exactly the points a Douglas–Peucker pass at that
 * tolerance would keep. The ends are infinitely important.
 */
export function lineImportance(pts: Float64Array): Float32Array {
    const n = Math.floor(pts.length / 3);
    const imp = new Float32Array(n);
    if (n === 0) return imp;
    imp[0] = Infinity;
    imp[n - 1] = Infinity;
    // [first, last, the importance of the split that made this segment]
    const stack: number[] = [0, n - 1, Infinity];
    while (stack.length) {
        const cap = stack.pop()!, b = stack.pop()!, a = stack.pop()!;
        if (b - a < 2) continue;
        const ia = a * 3, ib = b * 3;
        const ax = pts[ia], ay = pts[ia + 1], az = pts[ia + 2];
        const bx = pts[ib], by = pts[ib + 1], bz = pts[ib + 2];
        // The plane of the great circle through the ends.
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const nl = Math.hypot(nx, ny, nz);
        const chord = Math.hypot(ax - bx, ay - by, az - bz);
        let worst = -1, at = a + 1;
        if (nl > 1e-12) { nx /= nl; ny /= nl; nz /= nl; }
        for (let i = a + 1; i < b; i++) {
            const k = i * 3;
            const px = pts[k], py = pts[k + 1], pz = pts[k + 2];
            let d: number;
            const s = px * nx + py * ny + pz * nz;
            // The foot of the point on the great circle lies between the ends
            // when it is on the inner side of both: then the distance is to
            // the arc, otherwise to the nearer end. (Small angles throughout,
            // so chord lengths stand in for arcs.)
            const qx = px - s * nx, qy = py - s * ny, qz = pz - s * nz;
            const inA = nx * (ay * qz - az * qy) + ny * (az * qx - ax * qz) + nz * (ax * qy - ay * qx);
            const inB = nx * (qy * bz - qz * by) + ny * (qz * bx - qx * bz) + nz * (qx * by - qy * bx);
            if (nl > 1e-12 && inA >= 0 && inB >= 0) d = Math.abs(s);
            else d = Math.min(Math.hypot(px - ax, py - ay, pz - az), Math.hypot(px - bx, py - by, pz - bz));
            if (d > worst) { worst = d; at = i; }
        }
        const bow = BEND * chord * chord;
        // A long straight stretch is split in the middle, not at whichever
        // point happens to stray most from it by a hair.
        if (bow > worst) at = (a + b) >> 1;
        const here = Math.min(Math.max(worst, bow), cap);
        imp[at] = here;
        stack.push(a, at, here, at, b, here);
    }
    return imp;
}

const ranked = new WeakMap<Float64Array, Float32Array>();

/** `lineImportance`, worked out once per line and kept with it. */
export function importanceOf(pts: Float64Array): Float32Array {
    let imp = ranked.get(pts);
    if (!imp) {
        imp = lineImportance(pts);
        ranked.set(pts, imp);
    }
    return imp;
}
