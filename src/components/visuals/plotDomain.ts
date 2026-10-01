/**
 * The y range a function graph is drawn over, when its spec names none.
 *
 * function-plot's own default is not a fit: it derives y from x so that one
 * unit is the same length on both axes, centred on zero. That suits sin(x) on
 * [-6, 6] and nothing else. A spec that gives only an x domain — which is what
 * a model writes almost every time — gets a y window of the same size about 0,
 * wherever the function actually is:
 *   - f/f₀ = 1 ± x on x ∈ [-0.3, 0.3] was drawn in y ∈ [-0.15, 0.15], so both
 *     lines at ≈1 were off the canvas and the learner saw an empty grid;
 *   - a decay from 10 over 20,000 years was drawn in y ∈ [-6000, 6000], one
 *     flat line on the floor;
 *   - x² − 4 on [-4, 4] lost its vertex under the bottom edge.
 *
 * So the range is FITTED to what the curves reach over the x domain they are
 * drawn on, the way any plotting tool autoscales. Pure: the caller passes the
 * evaluator (function-plot's own, so the fitted numbers are the drawn ones).
 */

export type Domain = [number, number];

/** Evaluate datum[prop] with the given variables; may throw or return NaN. */
export type PlotEvaluator = (datum: Record<string, unknown>, prop: string, vars: Record<string, number>) => unknown;

/** function-plot's own default x window when the spec names none. */
export const DEFAULT_X_DOMAIN: Domain = [-6, 6];
const DEFAULT_LOG_DOMAIN: Domain = [1, 10];
const SAMPLES = 400;
/** Share of the span added above and below, so a curve never runs along the frame. */
const PAD = 0.06;
/**
 * An asymptote (1/x near 0) reaches values nothing else on the graph does.
 * When the middle 96% of a curve's samples span less than a quarter of its
 * full range, the rest is a spike, and the fit takes the middle.
 */
const SPIKE_RATIO = 4;
const TRIM = 0.02;

export function isDomain(d: unknown): d is Domain {
    return Array.isArray(d) && d.length === 2
        && typeof d[0] === 'number' && typeof d[1] === 'number'
        && Number.isFinite(d[0]) && Number.isFinite(d[1]) && d[0] < d[1];
}

function axisOf(options: Record<string, unknown>, key: 'xAxis' | 'yAxis'): Record<string, unknown> {
    const a = options[key];
    return a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : {};
}

function space(lo: number, hi: number, n: number, log: boolean): number[] {
    if (log) {
        const a = Math.log10(lo), b = Math.log10(hi);
        return Array.from({ length: n }, (_, i) => 10 ** (a + (b - a) * i / (n - 1)));
    }
    return Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1));
}

const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/** Every y one datum reaches inside the x window, finite values only. */
function samplesOf(d: Record<string, unknown>, x: Domain, xLog: boolean, evaluate: PlotEvaluator): number[] {
    const ys: number[] = [];
    const fnType = typeof d.fnType === 'string' ? d.fnType : 'linear';
    const inX = (v: number) => v >= x[0] && v <= x[1];
    const safe = (f: () => unknown): number => { try { return num(f()); } catch { return NaN; } };
    if (fnType === 'points') {
        if (!Array.isArray(d.points)) return ys;
        for (const p of d.points) {
            if (Array.isArray(p) && inX(num(p[0])) && Number.isFinite(num(p[1]))) ys.push(num(p[1]));
        }
    } else if (fnType === 'linear') {
        if (typeof d.fn !== 'string') return ys;
        const r = isDomain(d.range) ? d.range : null;
        const lo = r ? Math.max(x[0], r[0]) : x[0];
        const hi = r ? Math.min(x[1], r[1]) : x[1];
        if (!(lo < hi)) return ys;
        for (const xv of space(lo, hi, SAMPLES, xLog)) {
            const y = safe(() => evaluate(d, 'fn', { x: xv }));
            if (Number.isFinite(y)) ys.push(y);
        }
    } else if (fnType === 'parametric' || fnType === 'polar') {
        const polar = fnType === 'polar';
        const r = isDomain(d.range) ? d.range : polar ? [-Math.PI, Math.PI] as Domain : [0, 2 * Math.PI] as Domain;
        for (const t of space(r[0], r[1], SAMPLES, false)) {
            let xv: number, yv: number;
            if (polar) {
                const rad = safe(() => evaluate(d, 'r', { theta: t }));
                xv = rad * Math.cos(t); yv = rad * Math.sin(t);
            } else {
                xv = safe(() => evaluate(d, 'x', { t }));
                yv = safe(() => evaluate(d, 'y', { t }));
            }
            if (inX(xv) && Number.isFinite(yv)) ys.push(yv);
        }
    }
    return ys;
}

/** The range one curve occupies, with an asymptote's spike cut off. */
function rangeOf(ys: number[]): Domain | null {
    if (ys.length === 0) return null;
    const s = [...ys].sort((a, b) => a - b);
    const full: Domain = [s[0], s[s.length - 1]];
    if (s.length < 20) return full;
    const k = Math.floor(s.length * TRIM);
    const mid: Domain = [s[k], s[s.length - 1 - k]];
    const fullSpan = full[1] - full[0], midSpan = mid[1] - mid[0];
    return midSpan > 0 && fullSpan > SPIKE_RATIO * midSpan ? mid : full;
}

/**
 * The x window the graph is drawn over: the spec's, else function-plot's own
 * default (which the fit must use too, or it fits a window nobody sees).
 */
export function xDomainOf(options: Record<string, unknown>): Domain {
    const ax = axisOf(options, 'xAxis');
    if (isDomain(ax.domain)) return ax.domain;
    return ax.type === 'log' ? DEFAULT_LOG_DOMAIN : DEFAULT_X_DOMAIN;
}

/**
 * The fitted y domain, or null when the spec already has one or nothing could
 * be evaluated (the renderer then leaves function-plot's default, and the
 * post-render check reports whatever came out).
 */
export function fitYDomain(options: Record<string, unknown>, evaluate: PlotEvaluator, aspect?: number): Domain | null {
    const yAxis = axisOf(options, 'yAxis');
    if (isDomain(yAxis.domain)) return null;
    const yLog = yAxis.type === 'log';
    const x = xDomainOf(options);
    const xLog = axisOf(options, 'xAxis').type === 'log';
    if (xLog && !(x[0] > 0)) return null;
    const data = Array.isArray(options.data) ? options.data : [];

    let lo = Infinity, hi = -Infinity;
    let shapesOnly = data.length > 0;
    for (const d of data) {
        if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
        const t = (d as Record<string, unknown>).fnType;
        if (t !== 'parametric' && t !== 'polar') shapesOnly = false;
        // A throwaway copy: function-plot caches its compiled expression ON the
        // datum, and the fit must leave the spec exactly as it found it.
        let ys = samplesOf({ ...(d as Record<string, unknown>) }, x, xLog, evaluate);
        if (yLog) ys = ys.filter(v => v > 0);
        const r = rangeOf(ys);
        if (!r) continue;
        lo = Math.min(lo, r[0]);
        hi = Math.max(hi, r[1]);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;

    if (yLog) {
        // A decade either side of a flat curve, a fifth of one otherwise.
        if (hi / lo < 1.0001) return [lo / 10, hi * 10];
        const f = (hi / lo) ** PAD;
        return [lo / f, hi * f];
    }

    // A graph of nothing but closed shapes (a circle, an orbit, a rose) is
    // geometry: one unit is the same length on both axes, or the circle is
    // drawn as an ellipse. So y gets x's scale, centred on the shapes, and grows
    // past it only if they would not otherwise fit.
    if (shapesOnly && !xLog && typeof aspect === 'number' && aspect > 0) {
        const span = Math.max((x[1] - x[0]) * aspect, (hi - lo) * (1 + 2 * PAD));
        const mid = (lo + hi) / 2;
        return [mid - span / 2, mid + span / 2];
    }

    if (hi - lo <= 1e-9 * Math.max(1, Math.abs(hi))) {
        // A constant: centre it in a window its own size, or ±1 about zero.
        const pad = lo === 0 ? 1 : Math.abs(lo) / 2;
        return [lo - pad, hi + pad];
    }
    // Keep zero on the axis when the curve comes near it, so a decay reads as
    // a decay towards nothing; a curve far from zero (1 ± x about 1) is not
    // squashed against a baseline it never approaches.
    const touchesFloor = lo >= 0 && lo < (hi - lo) * 0.5;
    const touchesCeiling = hi <= 0 && -hi < (hi - lo) * 0.5;
    if (touchesFloor) lo = 0;
    if (touchesCeiling) hi = 0;
    const pad = (hi - lo) * PAD;
    return [touchesFloor ? lo : lo - pad, touchesCeiling ? hi : hi + pad];
}
