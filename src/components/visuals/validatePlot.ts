/**
 * Post-render sanity validation for ```plot function graphs — the "validate"
 * step of sanitize → parse → render → validate, and the sibling of
 * validateVega.ts.
 *
 * sanitizePlot.ts is purely syntactic: it de-JS-ifies expressions and normalises
 * options. It cannot see that the curve which came out is not a curve. The
 * failures that reach the learner look perfect on screen:
 *   - the expression is undefined across the domain (log of a negative, a
 *     division by zero) → function-plot writes literal NaN into the path data
 *     and draws a broken or empty line, throwing nothing;
 *   - the plotted function is essentially CONSTANT over the window chosen, so
 *     the card shows a flat line under a caption promising a pattern, a peak or
 *     a decay. This is what a reused example formula looks like when it is
 *     relabelled as the topic's own function.
 *
 * Both throw a descriptive error so the repair loop gets the text as its prompt.
 *
 * Deliberately conservative, for the reason validateVega.ts states: no
 * monotonicity or shape assertions. Whether a curve is the RIGHT curve is a
 * semantic question decided upstream by the visual check in feedQuality.js,
 * which reads the spec against the prose beside it. This file only asserts what
 * is mechanically certain — that something was drawn, and that it varies.
 */

/** A rendered path long enough to be the function curve rather than an axis. */
const MIN_CURVE_POINTS = 12;
/**
 * Vertical extent below which a curve is flat for teaching purposes, as a
 * fraction of the drawing area. 1.5% of a ~300px plot is under 5px — a line
 * whose "variation" is thinner than its own stroke.
 */
const FLAT_FRACTION = 0.015;
/**
 * Share of the curve allowed to sit outside the drawing box before the y-domain
 * counts as wrong. A genuine peak briefly leaving the top of a deliberately
 * cropped chart is normal; a third of the curve outside it is a scale error.
 */
const OFF_CANVAS_FRACTION = 0.3;

interface Curve {
    ys: number[];
    hasNaN: boolean;
}

/** Pull the y-coordinates out of an SVG path's `d` attribute. */
function readCurve(d: string): Curve {
    const ys: number[] = [];
    let hasNaN = false;
    // Path data from function-plot is a flat run of "L x,y" / "M x y" commands.
    const numbers = d.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|NaN/gi) ?? [];
    for (let i = 0; i < numbers.length; i++) {
        if (/nan/i.test(numbers[i])) { hasNaN = true; continue; }
        // Coordinates come in x,y pairs; odd indices are the y values.
        if (i % 2 === 1) ys.push(parseFloat(numbers[i]));
    }
    return { ys: ys.filter(Number.isFinite), hasNaN };
}

/**
 * @param stage the element function-plot rendered into
 * @param height the plot height in px, used to judge "flat" in the same units
 */
export function validatePlotRender(stage: HTMLElement, height: number): void {
    const paths = Array.from(stage.querySelectorAll('path'));
    if (paths.length === 0) {
        throw new Error('the plot drew nothing — check that every "fn" is a valid expression of x.');
    }

    const curves = paths
        .map((p) => readCurve(p.getAttribute('d') ?? ''))
        .filter((c) => c.hasNaN || c.ys.length >= MIN_CURVE_POINTS);

    if (curves.length === 0) {
        throw new Error(
            'the plot drew axes but no curve — the "fn" expression produced no plottable points ' +
            'over the given "xAxis" domain.',
        );
    }

    if (curves.some((c) => c.hasNaN)) {
        throw new Error(
            'the plot computed NaN over part of its domain — the expression is undefined there ' +
            '(a log or sqrt of a negative value, or a division by zero). ' +
            'Narrow the "xAxis" domain to where the function is defined, or fix the expression.',
        );
    }

    // Flatness is judged across ALL curves together: a spec that overlays three
    // damping curves is fine if any of them moves.
    const ys = curves.flatMap((c) => c.ys);
    const extent = Math.max(...ys) - Math.min(...ys);
    if (extent < Math.max(2, height * FLAT_FRACTION)) {
        throw new Error(
            'the curve is flat over this domain — it draws a straight horizontal line, so the graph ' +
            'shows nothing. Either the expression is not the function meant, or the "xAxis" domain is ' +
            'far too narrow to show its behaviour. Plot the actual function over a range where it visibly changes.',
        );
    }

    // A yAxis domain far smaller than the function's actual range leaves most of
    // the curve outside the drawing box, where the SVG clips it: the learner
    // sees flat-topped slabs instead of peaks, and every other check passes
    // because the data itself is fine. Points land at real coordinates outside
    // 0..height, so this is measurable rather than guessed.
    const offCanvas = ys.filter((y) => y < -height * 0.05 || y > height * 1.05).length;
    if (offCanvas / ys.length > OFF_CANVAS_FRACTION) {
        throw new Error(
            `${Math.round((offCanvas / ys.length) * 100)}% of the curve falls outside the visible area, so it is ` +
            'drawn clipped. The "yAxis" domain is far too small for the values this function actually reaches — ' +
            'widen it to cover the function\'s real range over the chosen x domain, or remove "yAxis" entirely and ' +
            'let the graph scale itself.',
        );
    }
}
