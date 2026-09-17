import { Vec3, angleBetween, dot3, unit3 } from './globeProjection';
import { MAX_HANDLE, ARC_STEPS } from './coursePaths';

/**
 * The route a replay flies across Terra — the sphere's answer to the curve in
 * `coursePaths.ts`.
 *
 * WHEN the arrow is between two topics is settled once for both surfaces
 * (`advanceFlight`); WHERE it is, is not, and cannot be. A journey on the plane
 * is a cubic Bézier through the topics' own places. On a sphere there is no
 * such thing as a straight line between two places, and a curve built out of
 * the plane's arithmetic does not merely look wrong — it leaves the surface.
 * Interpolating two directions componentwise and normalising afterwards gives a
 * path that IS on the sphere but crosses it at the wrong speed (fastest at the
 * ends, slowest in the middle, by up to the chord's own foreshortening), which
 * is the same fault `legParam` exists to kill on the plane, arriving through a
 * different door.
 *
 * So every operation here is the spherical one. Interpolation is `slerp`.
 * Distance is the great-circle angle. The handles that bend a leg are built in
 * the TANGENT PLANE at the topic they belong to and walked onto the sphere by
 * the exponential map, so a corner turns the way the surface turns rather than
 * being drawn flat and projected. The curve still passes exactly through every
 * topic — it is only the route between them that bends.
 *
 * Pure arithmetic on unit vectors: no DOM, no camera, no canvas. Which is the
 * point — every way this can be wrong draws a plausible picture rather than
 * throwing, so it is asserted directly in `tools/globe-gates.mjs`.
 */

/** One leg of the flight: a cubic Bézier whose four control points are all on the sphere. */
export interface SphereLeg {
    p0: Vec3;
    /** First control handle — in the tangent plane at `p0`, walked onto the sphere. */
    c1: Vec3;
    /** Second handle, the same at `p3`. */
    c2: Vec3;
    p3: Vec3;
}

// `MAX_HANDLE` (how long a handle may be, as a share of the leg's own chord) and
// `ARC_STEPS` (the pieces a leg is measured in) come from `coursePaths.ts`. Both
// are dimensionless and both mean the same thing on either surface — a cubic
// whose handles outrun its chord loops wherever it is drawn.

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/**
 * Interpolate two directions along the great circle between them.
 *
 * Constant angular speed, which is what makes it the right primitive for a
 * planet: the alternative — lerp the components and normalise — is the same
 * curve traversed unevenly, and at the distances a real journey covers (a hop
 * across the library is a quarter of the way round) that unevenness is a
 * visible surge in the middle of every long leg.
 *
 * Two directions that are the same, or exactly opposite, have no unique great
 * circle between them; both answer with the start rather than a NaN.
 */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
    const omega = angleBetween(a, b);
    const s = Math.sin(omega);
    if (!(s > 1e-9)) return a;
    const k0 = Math.sin((1 - t) * omega) / s;
    const k1 = Math.sin(t * omega) / s;
    return [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1];
}

/**
 * The tangent vector at `a` that points at `b`, with the great-circle distance
 * as its length — the logarithmic map. Zero when there is no direction to give.
 */
function logMap(a: Vec3, b: Vec3): Vec3 {
    const d = dot3(a, b);
    const theta = angleBetween(a, b);
    if (!(theta > 1e-9)) return [0, 0, 0];
    const dir = unit3([b[0] - a[0] * d, b[1] - a[1] * d, b[2] - a[2] * d]);
    return scale3(dir, theta);
}

/** Walk from `a` along the tangent `v` by its own length — the exponential map. */
function expMap(a: Vec3, v: Vec3): Vec3 {
    const theta = len3(v);
    if (!(theta > 1e-9)) return a;
    const c = Math.cos(theta), s = Math.sin(theta) / theta;
    return unit3([a[0] * c + v[0] * s, a[1] * c + v[1] * s, a[2] * c + v[2] * s]);
}

/**
 * One handle: where the curve leaves `anchor` on its way to `to`, given where
 * it came from.
 *
 * Catmull-Rom's rule, in the tangent plane. The outgoing direction and the
 * continuation of the incoming one are averaged, which is what makes the curve
 * pass through a topic without a corner in it — but the incoming one is
 * RESCALED to this leg's own chord first, and that rescaling is the spherical
 * stand-in for the plane's centripetal parameterisation. It answers the same
 * failure: this map hands the curve coincident and near-coincident points all
 * the time (two topics finished in one bubble), and a neighbour far away must
 * not buy a long handle on a short hop, or the leg bulges out of its own
 * bubble and the arrow flies a detour nobody walked.
 */
function handle(anchor: Vec3, from: Vec3, to: Vec3): Vec3 {
    const out = logMap(anchor, to);
    const chord = len3(out);
    if (!(chord > 1e-9)) return anchor;
    const back = logMap(anchor, from);
    const backLen = len3(back);
    // The way the curve was already travelling, as a vector of THIS leg's
    // length: `back` points at the previous topic, so its negative continues
    // the journey through this one.
    const cont: Vec3 = backLen > 1e-9 ? scale3(back, -chord / backLen) : out;
    let m = scale3(add3(out, cont), 1 / 6);
    const reach = len3(m);
    const max = chord * MAX_HANDLE;
    if (reach > max) m = scale3(m, max / reach);
    return expMap(anchor, m);
}

/**
 * The legs of the flight through these directions, one per gap.
 *
 * Returns [] for fewer than two points — a journey of one finished topic is a
 * place, not a route, and the renderer draws it as a marker.
 */
export function spherePath(points: Vec3[]): SphereLeg[] {
    const n = points.length;
    if (n < 2) return [];
    const legs: SphereLeg[] = [];
    for (let i = 0; i < n - 1; i++) {
        const prev = points[i === 0 ? 0 : i - 1];
        const p0 = points[i];
        const p3 = points[i + 1];
        const next = points[i + 2 <= n - 1 ? i + 2 : n - 1];
        legs.push({ p0, c1: handle(p0, prev, p3), c2: handle(p3, next, p0), p3 });
    }
    return legs;
}

/** Where the flight is at `t` along one leg — de Casteljau, every step a slerp. */
export function sphereLegAt(leg: SphereLeg, t: number): Vec3 {
    const a = slerp(leg.p0, leg.c1, t);
    const b = slerp(leg.c1, leg.c2, t);
    const c = slerp(leg.c2, leg.p3, t);
    const d = slerp(a, b, t);
    const e = slerp(b, c, t);
    return slerp(d, e, t);
}

// There is deliberately no `legUpTo` here, and the plane has one.
//
// On a plane, de Casteljau's subdivision is exact: the first `t` of a leg IS a
// cubic Bézier, so the flat map builds one and strokes it. On a sphere that
// identity quietly fails — a slerp-built Bézier is not a polynomial, and the
// sub-curve it hands back is a DIFFERENT curve through the same two ends
// (measured on this map's own shapes: up to 2.0e-3 radians away from the
// original, about a pixel, but wrong by construction rather than by rounding).
// So the part already flown is drawn by walking the WHOLE leg's curve up to the
// arrow's own parameter, which needs no identity to be true and is the same
// sampling loop either way.

/** How far a leg runs, in radians along its own curve. Exported for the gate that
 *  asserts no leg outruns its own chord — a loop is the one failure this curve can
 *  have that still draws something plausible. */
export function sphereLegSpan(leg: SphereLeg): number {
    let total = 0;
    let prev = leg.p0;
    for (let i = 1; i <= ARC_STEPS; i++) {
        const p = sphereLegAt(leg, i / ARC_STEPS);
        total += angleBetween(prev, p);
        prev = p;
    }
    return total;
}

/**
 * The curve parameter at which this leg is `u` of its LENGTH along.
 *
 * `legParam`'s job, in radians: a cubic is not traversed at constant speed by
 * its own parameter, so equal milliseconds of `t` buy wildly unequal arcs — the
 * arrow crawls out of a topic and then bolts. Chop the curve up, add the pieces,
 * invert the table linearly, and equal milliseconds buy equal degrees of the
 * planet instead.
 */
export function sphereLegParam(leg: SphereLeg, u: number): number {
    if (!(u > 0)) return 0;
    if (u >= 1) return 1;
    const lens: number[] = [0];
    let total = 0;
    let prev = leg.p0;
    for (let i = 1; i <= ARC_STEPS; i++) {
        const p = sphereLegAt(leg, i / ARC_STEPS);
        total += angleBetween(prev, p);
        lens.push(total);
        prev = p;
    }
    // A leg with no length at all — two topics drawn at the same place — has
    // no distance to divide by, and its own parameter is as good an answer as
    // exists.
    if (!(total > 0)) return u;
    const want = u * total;
    for (let i = 1; i <= ARC_STEPS; i++) {
        if (lens[i] < want) continue;
        const span = lens[i] - lens[i - 1];
        const within = span > 0 ? (want - lens[i - 1]) / span : 0;
        return (i - 1 + within) / ARC_STEPS;
    }
    return 1;
}

/**
 * The mean direction of a set of places — where "the middle of this" is on a
 * sphere.
 *
 * The straight average of the vectors, renormalised, which is the standard
 * spherical mean and is what the camera aims at. Weights ride along because the
 * camera's window fades its points in and out rather than switching them.
 * Returns null when the weights cancel — a set with no middle, which the caller
 * must not invent one for.
 */
export function meanDirection(points: { u: Vec3; w: number }[]): Vec3 | null {
    let x = 0, y = 0, z = 0;
    for (const p of points) { x += p.u[0] * p.w; y += p.u[1] * p.w; z += p.u[2] * p.w; }
    return Math.hypot(x, y, z) > 1e-9 ? unit3([x, y, z]) : null;
}
