/**
 * A switched-off animation sample STANDS STILL, on the frame that says what it
 * is: greying the card alone left the ball flying round its arc for ever under
 * the grey, which reads as a kind that is still running. The p5 card says
 * "off" by slowing down (`muteSketch`); an SMIL scene has a clock, so it is
 * stopped and set to one moment.
 *
 * `at` is the moment, in seconds of the scene's own clock; `null` lets it run
 * again. A reader who asked for less movement is not started by switching a
 * kind on — the scene stays on the still, which is a better first frame than
 * the empty card the renderer's own reduced-motion pause would leave.
 *
 * No imports, so the gate can run it as it ships.
 */
export function holdSampleStill(el: ParentNode, at: number | null, mayMove = true): void {
    el.querySelectorAll('svg').forEach(node => holdScene(node as SVGSVGElement, at, mayMove));
}

function holdScene(svg: SVGSVGElement, at: number | null, mayMove: boolean): void {
    if (typeof svg.pauseAnimations !== 'function') return;
    try {
        if (at !== null) {
            svg.pauseAnimations();
            svg.setCurrentTime(at);
        } else if (mayMove) {
            svg.unpauseAnimations();
        }
    } catch { /* not an SMIL document */ }
}

/**
 * The first top of the arc at or after `now`: the ball is at the top at
 * `first`, then once a `period` for as long as the scene runs. Before the
 * first throw (the build is still drawing) the answer is the first top.
 */
export function nextTop(now: number, first: number, period: number): number {
    if (!(now > first) || !(period > 0)) return first;
    return first + Math.ceil((now - first) / period - 1e-9) * period;
}

type Wait = (run: () => void, ms: number) => () => void;
const timeout: Wait = (run, ms) => {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
};

/**
 * Switched off while it moves, the scene is not stopped where it is: the ball
 * finishes the throw it is on (or the next, if it is past the top) and stands
 * still when it reaches the top — the same ending as the website's Animations
 * tile, which plays half a loop more and stops in the middle position. A wait that is cancelled (switched on again, a redraw) does
 * nothing; the final `setCurrentTime` makes the frame exact whatever the timer
 * was late by. Returns the cancel.
 */
export function stillAtNextTop(el: ParentNode, first: number, period: number, wait: Wait = timeout): () => void {
    const cancels: Array<() => void> = [];
    el.querySelectorAll('svg').forEach(node => {
        const svg = node as SVGSVGElement;
        if (typeof svg.getCurrentTime !== 'function') return;
        let now: number;
        try { now = svg.getCurrentTime(); } catch { return; }
        const top = nextTop(now, first, period);
        cancels.push(wait(() => holdScene(svg, top, true), Math.max(0, (top - now) * 1000)));
    });
    return () => cancels.forEach(c => c());
}
