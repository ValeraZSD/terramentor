/**
 * When a recorder should take the next frame, on the browser's own refresh.
 *
 * The next frame is due one period after the last one was DUE, not after it
 * was taken. Measuring from the take lets every late refresh push the whole
 * schedule back: at 30 fps on refreshes that come every 20 ms, a frame is
 * taken on every second one — 40 ms apart, 25 fps, whatever was asked for
 * (measured 2026-09-30: 24.2 fps in a GIF set to 30). Scheduling from the due
 * time takes them 40, 20, 40… apart instead, which averages the rate asked
 * for whenever the refreshes come at least that often. A stall longer than a
 * period (a background tab, a blocked frame) restarts the schedule rather
 * than firing a burst of catch-up frames.
 */
export function framePacer(fps: number) {
    const period = 1000 / fps;
    let due = -Infinity;
    return (now: number): boolean => {
        if (now < due - 1) return false;
        due = now - due > period ? now + period : due + period;
        return true;
    };
}
