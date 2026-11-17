/**
 * The dot nearest the pointer along time, so sliding across a chart walks the
 * dots in order at any height. Dots within half a pixel of the nearest time
 * share it (answers on one day, or a row held back to its neighbour's time):
 * among those the pointer's height picks, and a full tie goes to the later dot.
 *
 * Two passes, so the half-pixel band is measured from the nearest time itself
 * and cannot creep from dot to dot. Returns -1 for no dots.
 */
export function pickDot(xy: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): number {
    const dx = (i: number) => Math.abs(xy[i].x - x);
    const dy = (i: number) => Math.abs(xy[i].y - y);
    let closest = Infinity;
    for (let i = 0; i < xy.length; i++) closest = Math.min(closest, dx(i));
    let best = -1;
    for (let i = 0; i < xy.length; i++) {
        if (dx(i) - closest > 0.5) continue;
        if (best < 0 || dy(i) <= dy(best)) best = i;
    }
    return best;
}
