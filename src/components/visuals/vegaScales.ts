/**
 * Scales a Vega-Lite chart needs and its author did not ask for.
 *
 * A chart of log₁₀(x) for x from 0.01 to 1000 — "five orders of magnitude on
 * the horizontal axis", as the lesson beside it said — was drawn on a LINEAR
 * x axis: every value below 10 fell into the first pixel column, the curve was
 * a vertical wall against the y axis and then a flat line, and the axis ran on
 * to 1,100 because the last sample was 1000.01. The spec was valid, the data
 * was finite and the validator was satisfied; only the picture was wrong.
 *
 * So after the first draw, the renderer hands this the rows Vega computed. An
 * x whose values are all positive and span three decades or more, AND against
 * which the curve does its changing in the first (or last) twentieth of a
 * linear axis, is redrawn on a log scale. Both halves are required: y = 2x over
 * 1…1000 also spans three decades, and on a log axis it would look like an
 * exponential it is not — its change is spread evenly, so it stays linear.
 *
 * A sampled function (a `sequence` feeding x) is re-sampled geometrically for
 * the log axis, because a step of 1 from 0.01 puts one point in the first two
 * decades and draws them as a straight chord. The samples are still COMPUTED
 * (an index sequence and a `calculate`), so "function, not values" holds.
 */

export type Row = Record<string, unknown>;

/** Three decades: the least a log axis earns its unfamiliar ticks for. */
const MIN_DECADES_RATIO = 1000;
/** The share of the axis a squashed curve does its changing in. */
const SQUASH_SHARE = 0.05;
/** How much of the change must happen there before the axis is wrong. */
const SQUASHED_IF = 0.5;
const RESAMPLE_POINTS = 240;
const INDEX_FIELD = '__logIndex';

const MARKS = new Set(['line', 'area', 'point', 'circle', 'square', 'trail', 'tick']);

function obj(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function markType(spec: Record<string, unknown>): string | null {
    const m = spec.mark;
    if (typeof m === 'string') return m;
    const o = obj(m);
    return o && typeof o.type === 'string' ? o.type : null;
}

/** The field on a channel, when the channel is a plain quantitative one the author left unscaled. */
function freeQuantField(spec: Record<string, unknown>, channel: 'x' | 'y'): string | null {
    const def = obj(obj(spec.encoding)?.[channel]);
    if (!def || def.type !== 'quantitative' || typeof def.field !== 'string') return null;
    if (def.aggregate || def.bin || def.stack) return null;
    const scale = obj(def.scale);
    if (scale && ('type' in scale || 'domain' in scale)) return null;   // the author chose
    return def.field;
}

function numbers(rows: Row[], field: string): number[] | null {
    const out: number[] = [];
    for (const r of rows) {
        const v = r[field];
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        out.push(v);
    }
    return out;
}

const spansDecades = (vs: number[]): boolean => {
    const lo = Math.min(...vs), hi = Math.max(...vs);
    return lo > 0 && hi / lo >= MIN_DECADES_RATIO;
};

/**
 * x is squashed when, walking the curve left to right, at least half of its
 * total vertical travel happens in the first (or last) twentieth of the x axis.
 */
export function xIsSquashed(xs: number[], ys: number[]): boolean {
    const pts = xs.map((x, i) => [x, ys[i]] as const).sort((a, b) => a[0] - b[0]);
    const lo = pts[0][0], hi = pts[pts.length - 1][0];
    const edge = (hi - lo) * SQUASH_SHARE;
    let total = 0, early = 0, late = 0;
    for (let i = 1; i < pts.length; i++) {
        const dy = Math.abs(pts[i][1] - pts[i - 1][1]);
        total += dy;
        if (pts[i][0] <= lo + edge) early += dy;
        if (pts[i - 1][0] >= hi - edge) late += dy;
    }
    return total > 0 && Math.max(early, late) / total >= SQUASHED_IF;
}

/** y is squashed when half the points sit in the bottom (or top) twentieth of its linear range. */
export function yIsSquashed(ys: number[]): boolean {
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const edge = (hi - lo) * SQUASH_SHARE;
    const low = ys.filter(y => y <= lo + edge).length;
    const high = ys.filter(y => y >= hi - edge).length;
    return Math.max(low, high) / ys.length >= SQUASHED_IF;
}

export interface LogPlan { x: boolean; y: boolean }

/** Which axes of this spec should be logarithmic, judged on the rows it drew. */
export function planLogScales(spec: Record<string, unknown>, rows: Row[]): LogPlan {
    const none = { x: false, y: false };
    const mark = markType(spec);
    if (!mark || !MARKS.has(mark) || rows.length < 8) return none;
    const xf = freeQuantField(spec, 'x'), yf = freeQuantField(spec, 'y');
    const xs = xf ? numbers(rows, xf) : null;
    const ys = yf ? numbers(rows, yf) : null;
    const x = !!(xs && ys && spansDecades(xs) && xIsSquashed(xs, ys));
    // y goes logarithmic only WITH x (a power law, drawn log-log). On its own a
    // squashed y is usually the lesson — the hockey stick of 2ˣ is what
    // "exponential growth" looks like, and a log axis would straighten it into
    // something else. An area is filled down to zero, which a log axis lacks.
    const y = x && mark !== 'area' && !!(ys && spansDecades(ys) && yAfterLogX(xs!, ys));
    return { x, y };
}

/**
 * Whether y is still squashed once x is logarithmic: judged on points spread
 * evenly in log x, which is what the re-sampled chart will draw. 1/x from
 * 0.01 to 100 is; log₁₀(x) never reaches the ratio test at all.
 */
function yAfterLogX(xs: number[], ys: number[]): boolean {
    const pts = xs.map((x, i) => [Math.log10(x), ys[i]] as const).sort((a, b) => a[0] - b[0]);
    const lo = pts[0][0], hi = pts[pts.length - 1][0];
    const picked: number[] = [];
    const n = 60;
    let j = 0;
    for (let k = 0; k < n; k++) {
        const target = lo + (hi - lo) * k / (n - 1);
        while (j < pts.length - 1 && Math.abs(pts[j + 1][0] - target) <= Math.abs(pts[j][0] - target)) j++;
        picked.push(pts[j][1]);
    }
    return yIsSquashed(picked);
}

/**
 * The spec redrawn with those axes logarithmic. Returns a NEW object; the
 * sequence behind x is re-sampled geometrically over the range it drew.
 */
export function applyLogScales(
    spec: Record<string, unknown>,
    plan: LogPlan,
    ranges: { x?: [number, number]; y?: [number, number] },
): Record<string, unknown> {
    const out = structuredClone(spec) as Record<string, unknown>;
    const enc = obj(out.encoding)!;
    const xRange = ranges.x ?? null;
    for (const ch of ['x', 'y'] as const) {
        if (!plan[ch]) continue;
        const def = obj(enc[ch])!;
        def.scale = { ...(obj(def.scale) ?? {}), type: 'log' };
        // One tick per decade. d3's log ticks add every 2…9 multiple whenever
        // the count asked for exceeds the decades on the axis — a gridline
        // each, forty lines behind one straight curve — so the count IS the
        // number of decades.
        const r = ranges[ch];
        const axis = obj(def.axis);
        if (r && r[0] > 0 && def.axis !== null && !(axis && 'tickCount' in axis)) {
            def.axis = { ...(axis ?? {}), tickCount: Math.max(2, Math.floor(Math.log10(r[1] / r[0]))) };
        }
    }
    // The x axis ends where the curve does. Left to `nice`, a log scale rounds
    // out to whole decades, and 0.01…1000.01 became 0.01…10,000: a fifth of the
    // chart empty to the right of the line.
    if (plan.x && xRange && xRange[0] > 0) {
        const def = obj(enc.x)!;
        def.scale = { ...(obj(def.scale) ?? {}), domain: xRange, nice: false };
    }
    const xField = obj(enc.x)?.field;
    const seq = obj(obj(out.data)?.sequence);
    if (plan.x && xRange && seq && seq.as === xField && xRange[0] > 0) {
        const [lo, hi] = xRange;
        out.data = { sequence: { start: 0, stop: RESAMPLE_POINTS, step: 1, as: INDEX_FIELD } };
        const transforms = Array.isArray(out.transform) ? out.transform : [];
        out.transform = [
            { calculate: `${lo} * pow(${hi / lo}, datum.${INDEX_FIELD} / ${RESAMPLE_POINTS - 1})`, as: xField },
            ...transforms,
        ];
    }
    return out;
}
