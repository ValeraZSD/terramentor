/**
 * The arithmetic behind Terra — the atlas drawn on a sphere.
 *
 * Out here rather than inside the renderer for the reason `mapLabels.ts` is:
 * every way this can be wrong produces a PICTURE, not an exception. A cap drawn
 * with its axes swapped is a perfectly smooth ellipse pointing the wrong way; a
 * topic placed with the tangent basis taken from the camera instead of the
 * point drifts as you turn the planet, which reads as a rendering bug and is a
 * geometry one. None of this touches React, the canvas or the camera — it takes
 * numbers and returns numbers — so it can be asserted directly
 * (`tools/globe-gates.mjs`).
 *
 * Conventions, once:
 *  • A direction is a UNIT 3-vector in the library's own frame, the one the
 *    server computed. Turning the planet rotates the camera, never the data.
 *  • View space is right-handed with +z toward the reader, so a point is on the
 *    near side exactly when `z > 0`.
 *  • Screen space has y DOWN, which is the one sign this file has to keep
 *    straight: `screenY = cy − v.y · R`.
 */

export type Vec3 = [number, number, number];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function unit3(v: Vec3): Vec3 {
    const n = Math.hypot(v[0], v[1], v[2]);
    return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 1];
}

export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];

/** The great-circle angle between two unit vectors, in radians. */
export const angleBetween = (a: Vec3, b: Vec3) => Math.acos(clamp(dot3(a, b), -1, 1));

/**
 * Two perpendicular directions in the tangent plane at `u`.
 *
 * Derived from `u` and a fixed world axis, so a region's basis is a property of
 * WHERE IT IS and nothing else. Taking it from anything that moves — the camera
 * being the obvious temptation — would slide every topic around inside its own
 * region as the planet turns, which is the failure this exists to make
 * impossible rather than to catch later.
 *
 * The world axis is swapped near the poles: `cross(up, u)` degenerates to zero
 * when `u` IS up, and a basis of length zero puts every topic in a region on
 * top of its centre.
 */
export function tangentBasis(u: Vec3): [Vec3, Vec3] {
    const up: Vec3 = Math.abs(u[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
    const e1 = unit3(cross3(up, u));
    const e2 = unit3(cross3(u, e1));
    return [e1, e2];
}

/**
 * How much of a cap its topics are allowed to fill.
 *
 * The flat map fences its dots at `radius − dotRadius` so a dot is never drawn
 * half outside its own bubble; this is the same fence one level up, and it also
 * leaves the cap's rim visible as a rim rather than as a ring of topics.
 */
export const CAP_FILL = 0.86;

/**
 * Put a topic on its region's cap.
 *
 * `ox`/`oy` are the topic's offsets inside its bubble on the FLAT map, in units
 * of the bubble's radius — so the arrangement inside a region is the same
 * arrangement in both views, and the globe costs nothing per topic on the wire.
 * The offsets are read onto the tangent plane at `u` and walked out along a
 * great circle (the exponential map), which is what makes a cap look the same
 * from every side instead of shearing as it approaches the limb.
 */
export function capPoint(u: Vec3, e1: Vec3, e2: Vec3, ox: number, oy: number, cap: number): Vec3 {
    const r = Math.hypot(ox, oy);
    if (r < 1e-9) return u;
    const theta = Math.min(r, 1) * cap * CAP_FILL;
    const c = Math.cos(theta), s = Math.sin(theta) / r;
    return unit3([
        u[0] * c + (e1[0] * ox + e2[0] * oy) * s,
        u[1] * c + (e1[1] * ox + e2[1] * oy) * s,
        u[2] * c + (e1[2] * ox + e2[2] * oy) * s,
    ]);
}

/**
 * A topic's offsets inside its bubble, read back out of the flat layout.
 *
 * The server sends topic coordinates in the map's own units; dividing by the
 * bubble's radius gives the unit-disc offsets `packInside` actually produced.
 * A region with a zero radius (one topic, clamped to the floor) has no inside,
 * so its topic sits on the centre.
 */
export function topicOffset(
    region: { x: number; y: number; radius: number },
    topic: { x: number; y: number },
): [number, number] {
    if (!(region.radius > 1e-9)) return [0, 0];
    return [(topic.x - region.x) / region.radius, (topic.y - region.y) / region.radius];
}

/**
 * Turn the planet: yaw about the world's z axis, then pitch toward the reader.
 *
 * Two angles rather than a free trackball, on purpose. A trackball accumulates
 * roll, and a planet whose north wanders is one you cannot navigate back across
 * — you lose the "up" that lets a reader remember they came from above the blue
 * region. Yaw and a clamped pitch keep the axis upright, which is how every
 * globe anyone has ever used behaves.
 */
export function rotate(v: Vec3, yaw: number, pitch: number): Vec3 {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // Yaw spins the planet under a fixed axis…
    const x1 = v[0] * cy - v[1] * sy;
    const y1 = v[0] * sy + v[1] * cy;
    // …and pitch tips that axis toward the reader. At pitch 0 the world's z is
    // straight up the screen, which is what makes north stay north.
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [x1, v[2] * cp - y1 * sp, v[2] * sp + y1 * cp];
}

/** The inverse of `rotate` — view space back to the library's own frame. */
export function unrotate(v: Vec3, yaw: number, pitch: number): Vec3 {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const z = v[1] * cp + v[2] * sp;
    const y1 = v[2] * cp - v[1] * sp;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    return [v[0] * cy + y1 * sy, -v[0] * sy + y1 * cy, z];
}

export interface Projected { x: number; y: number; z: number }

/** A view-space direction to a point on the drawn globe. `z > 0` is the near side. */
export function project(v: Vec3, cx: number, cy: number, R: number): Projected {
    return { x: cx + v[0] * R, y: cy - v[1] * R, z: v[2] };
}

/**
 * Where the yaw and pitch have to be for `u` to face the reader.
 *
 * What "fly to this region" means on a sphere: not a pan, a turn. Solved rather
 * than iterated, so it is one number the camera can ease toward.
 */
export function faceOn(u: Vec3): { yaw: number; pitch: number } {
    // Facing the reader is view-space +z. The yaw that swings `u` onto the
    // world's +y axis is `atan2(x, y)`, which leaves it at (0, h, z); the pitch
    // that lifts that onto +z is then `atan2(z, h)`.
    const h = Math.hypot(u[0], u[1]);
    return { yaw: Math.atan2(u[0], u[1]), pitch: Math.atan2(u[2], h) };
}

export interface CapEllipse {
    /** Centre of the projected circle — NOT the projection of the cap's centre:
     *  the circle's own plane sits `cos ρ` of the way out. */
    x: number;
    y: number;
    /** Radial semi-axis — the foreshortened one, pointing away from the globe's
     *  centre on screen. */
    rx: number;
    /** Tangential semi-axis, always the full `R · sin ρ`. */
    ry: number;
    /** Rotation of `rx` from the screen's +x, for `ctx.ellipse`. */
    rotation: number;
    /** How much of the cap faces the reader: `cos` of the angle from the view
     *  axis at its centre. Below zero the whole cap is round the back. */
    facing: number;
}

/**
 * The outline of a spherical cap, under the orthographic projection a globe is
 * drawn in.
 *
 * A circle on a sphere projects to an ELLIPSE, and both of its axes are exact:
 * the tangential one is always `R · sin ρ` (that direction lies in the screen
 * plane and is never foreshortened), and the radial one is `R · sin ρ · |z|`,
 * which is what squashes a cap into a sliver as it reaches the limb. Drawing
 * caps as plain circles — the obvious shortcut — makes every region near the
 * edge of the disc bulge off the planet, which is precisely the tell that a
 * "3D" view is a flat picture with a shadow on it.
 */
export function capEllipse(v: Vec3, cap: number, cx: number, cy: number, R: number): CapEllipse {
    const sin = Math.sin(cap), cos = Math.cos(cap);
    // The radial screen direction: straight out from the centre of the disc.
    // At the exact centre there is no such direction and none is needed — the
    // ellipse is then a circle and the rotation is arbitrary.
    const rotation = Math.atan2(-v[1], v[0]);
    return {
        x: cx + v[0] * cos * R,
        y: cy - v[1] * cos * R,
        rx: sin * R * Math.abs(v[2]),
        ry: sin * R,
        rotation,
        facing: v[2],
    };
}
