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
    /**
     * The top edge of each box, when the path is function-plot's interval
     * graph (one `M` per sample). A sample outside the window is drawn as a
     * box of minimum height that STARTS above the canvas (`M x -1 v 1`), so
     * this, not every y, is what says how much of the curve is off it.
     */
    boxes: number[] | null;
    hasNaN: boolean;
}

/**
 * Pull the y-coordinates out of an SVG path's `d` attribute, command by
 * command. function-plot writes two shapes: a polyline ("M x,y L x,y …") and,
 * for its DEFAULT graph type, one box per sample ("M x y v h …") — a relative
 * `v` carries a height, not a coordinate. Reading the numbers as flat x,y pairs
 * (the old parser) took the box's height for a y and every other x for one,
 * so the flat and off-canvas checks measured nothing on most graphs: an empty
 * grid with both curves clamped above its top edge passed.
 */
export function readCurve(d: string): Curve {
    const ys: number[] = [];
    let hasNaN = false;
    const moves: number[] = [];
    const tokens = d.match(/[MLHVCSQTAZmlhvcsqtaz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|NaN/gi) ?? [];
    let cmd = 'M', cx = 0, cy = 0;
    const args: number[] = [];
    // Numbers each command takes per repetition, and which of them is the end point.
    const arity: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
    const flush = () => {
        const lower = cmd.toLowerCase();
        const n = arity[lower] ?? 2;
        const rel = cmd === lower; // a lowercase command is relative
        while (n > 0 && args.length >= n) {
            const a = args.splice(0, n);
            if (lower === 'h') cx = rel ? cx + a[0] : a[0];
            else if (lower === 'v') cy = rel ? cy + a[0] : a[0];
            else { cx = rel ? cx + a[n - 2] : a[n - 2]; cy = rel ? cy + a[n - 1] : a[n - 1]; }
            ys.push(cy);
            if (lower === 'm') moves.push(cy);
        }
    };
    for (const t of tokens) {
        if (/^nan$/i.test(t)) { hasNaN = true; args.push(NaN); continue; }
        if (/^[a-z]$/i.test(t)) { flush(); args.length = 0; cmd = t; continue; }
        args.push(parseFloat(t));
    }
    flush();
    return { ys: ys.filter(Number.isFinite), boxes: moves.length > 1 ? moves.filter(Number.isFinite) : null, hasNaN };
}

/**
 * @param stage the element function-plot rendered into
 * @param height the plot height in px, used to judge "flat" in the same units
 * @param expected each plotted function's index in `data` and how to name it
 */
export function validatePlotRender(
    stage: HTMLElement,
    height: number,
    expected: ReadonlyArray<{ index: number; label: string }> = [],
): void {
    const paths = Array.from(stage.querySelectorAll('path'));
    if (paths.length === 0) {
        throw new Error('the plot drew nothing — check that every "fn" is a valid expression of x.');
    }

    const curves = paths
        .map((p) => readCurve(p.getAttribute('d') ?? ''))
        .filter((c) => c.hasNaN || c.ys.length >= MIN_CURVE_POINTS);

    // A scatter of points is drawn as circles, not a path, and says nothing
    // about flatness or a clipped curve, so it is not refused as "no curve".
    if (curves.length === 0 && stage.querySelector('.graph circle')) return;

    if (curves.length === 0) {
        throw new Error(
            'the plot drew axes but no curve — the "fn" expression produced no plottable points ' +
            'over the given "xAxis" domain.',
        );
    }

    // Each function, on its own. The checks below judge the graph as a whole,
    // so a curve function-plot could not evaluate at all (a `pow` it does not
    // know, a log of a negative everywhere in the window) hid behind the one
    // beside it that did draw — one horizontal line, no error, and the half of
    // the lesson the missing curve carried simply gone.
    for (const { index, label } of expected) {
        const own = Array.from(stage.querySelectorAll(`path.line-${index}`));
        if (own.length === 0) continue;   // a graph type this check does not know
        if (own.some((p) => readCurve(p.getAttribute('d') ?? '').ys.length > 0)) continue;
        throw new Error(
            `the curve "${label}" drew nothing over this x domain — the expression uses a function the ` +
            'graph does not know (write powers as a^b, not pow(a, b)) or is undefined everywhere here.',
        );
    }

    if (curves.some((c) => c.hasNaN)) {
        throw new Error(
            'the plot computed NaN over part of its domain — the expression is undefined there ' +
            '(a log or sqrt of a negative value, or a division by zero). ' +
            'Narrow the "xAxis" domain to where the function is defined, or fix the expression.',
        );
    }

    // A yAxis domain far smaller than the function's actual range leaves most of
    // the curve outside the drawing box, where the SVG clips it: the learner
    // sees flat-topped slabs instead of peaks, or nothing at all, and every
    // other check passes because the data itself is fine. Checked BEFORE
    // flatness: a curve wholly off the canvas is drawn as a row of clamped
    // boxes along its edge, which would otherwise be reported as "flat".
    // The polyline's clamped points land far outside 0..height; the interval
    // graph's start just above 0 (see `boxes`), so the margin is half a pixel.
    const samples = curves.flatMap((c) => c.boxes ?? c.ys);
    const outside = (y: number) => y < -0.5 || y > height + 0.5;
    const offCanvas = samples.filter(outside).length;
    if (samples.length && offCanvas / samples.length > OFF_CANVAS_FRACTION) {
        throw new Error(
            `${Math.round((offCanvas / samples.length) * 100)}% of the curve falls outside the visible area, so it is ` +
            'drawn clipped. The "yAxis" domain is far too small for the values this function actually reaches — ' +
            'widen it to cover the function\'s real range over the chosen x domain, or remove "yAxis" entirely and ' +
            'let the graph scale itself.',
        );
    }

    // Flatness is judged across ALL curves together, on what is drawn inside
    // the box: a spec that overlays three damping curves is fine if any moves.
    const ys = curves.flatMap((c) => c.ys).filter((y) => !outside(y));
    const extent = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
    if (extent < Math.max(2, height * FLAT_FRACTION)) {
        throw new Error(
            'the curve is flat over this domain — it draws a straight horizontal line, so the graph ' +
            'shows nothing. Either the expression is not the function meant, or the "xAxis" domain is ' +
            'far too narrow to show its behaviour. Plot the actual function over a range where it visibly changes.',
        );
    }
}
