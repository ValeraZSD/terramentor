/**
 * The arm every camera in the atlas hangs on.
 *
 * One axis of a CRITICALLY DAMPED spring, integrated EXACTLY over `dt`.
 *
 * Exactly, not by steps of Euler, because the frame times a browser hands out
 * are not even and a spring integrated roughly gains energy on the long ones —
 * a camera that overshoots more the slower the machine is.
 *
 * Critical damping is the fastest approach to a target that never overshoots,
 * which is what lets a camera hang on a soft arm without the picture wobbling:
 * all of the weight, none of the bounce.
 *
 * And the reason it is a spring at all rather than an exponential ease, which
 * is what both surfaces started with: an ease is first-order, so its speed is
 * proportional to the distance it has left. It is therefore FASTEST on its very
 * first frame and slows from there — every move begins with a jump and ends
 * with a crawl, and a move handed to it while the camera was already travelling
 * ignores that travel completely. A spring carries velocity across, so a camera
 * let go of at the end of a replay leaves the journey along a curve instead of
 * snapping onto a new line. Measured on the planet, whose ending was an ease:
 * the first frame of the pull-out moved 1479px/s against 6px/s the frame before
 * it.
 *
 * Both surfaces share it, because a replay is meant to mean the same thing on
 * each of them and "the camera has weight" is part of what it means.
 */
export function spring(x: number, v: number, to: number, omega: number, dt: number) {
    const decay = Math.exp(-omega * dt);
    const d = x - to;
    const impulse = v + omega * d;
    return {
        x: to + (d + impulse * dt) * decay,
        v: (v - omega * impulse * dt) * decay,
    };
}

/**
 * The longest frame a spring may be integrated over in one go.
 *
 * A spring integrated across a 400ms stall is not a slow camera, it is a
 * catapult: the analytic step is exact for the equation, but the equation has
 * stopped describing anything a reader watched. A gap that long is the loop
 * having been idle, which each surface's own `IDLE_GAP_MS` catches first — this
 * is the floor under the ones that slip past it.
 */
export const MAX_STEP_MS = 50;
