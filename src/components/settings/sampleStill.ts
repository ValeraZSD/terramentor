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
    el.querySelectorAll('svg').forEach(node => {
        const svg = node as SVGSVGElement;
        if (typeof svg.pauseAnimations !== 'function') return;
        try {
            if (at !== null) {
                svg.pauseAnimations();
                svg.setCurrentTime(at);
            } else if (mayMove) {
                svg.unpauseAnimations();
            }
        } catch { /* not an SMIL document */ }
    });
}
