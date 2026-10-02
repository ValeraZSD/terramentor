/**
 * Deterministic function-plot normalizer.
 *
 * The `plot` kind is the preferred channel for the "function, not values"
 * contract (VISUALS_GUIDE): the model emits an expression string and
 * function-plot samples it adaptively at render time, so no model-computed
 * number ever exists in the spec. This normalizer mechanically fixes what
 * local models get wrong about that contract's syntax:
 *   - JS-isms in expressions: `Math.cos(x)`, `x ** 2`, `pow(x, 2)`, `Math.PI` / `π`
 *     (function-plot's parser wants `cos(x)`, `x^2`, and knows no PI constant
 *     reliably — constants are inlined as numeric literals);
 *   - shape confusions: a bare `{"fn": "..."}` with no `data` array, or
 *     invented `xDomain`/`yDomain` keys instead of `xAxis:{domain:[...]}`.
 * Anything deeper still throws and falls through to the repair loop.
 */

const PI_LITERAL = '3.141592653589793';

/**
 * `pow(a, b)` → `(a)^(b)`. function-plot's evaluator has no `pow`, and says
 * nothing: the curve is simply not drawn. `pow(2,x)` beside a constant 10 left
 * a lone horizontal line under a lesson about doubling, and `0.002*pow(x,0.5)`
 * dropped half of a stress–strain graph. Arguments may hold their own
 * parentheses and commas (`pow(max(x,1), 2)`), so this walks the brackets.
 */
export function rewritePow(expr: string): string {
    let out = expr;
    for (let guard = 0; guard < 20; guard++) {
        const m = /\bpow\s*\(/.exec(out);
        if (!m) break;
        const open = m.index + m[0].length - 1;
        let depth = 0, comma = -1, close = -1;
        for (let i = open; i < out.length; i++) {
            const c = out[i];
            if (c === '(') depth++;
            else if (c === ')') { depth--; if (depth === 0) { close = i; break; } }
            else if (c === ',' && depth === 1 && comma < 0) comma = i;
        }
        if (close < 0 || comma < 0) break;   // malformed: leave it for the repair loop
        const a = out.slice(open + 1, comma).trim();
        const b = out.slice(comma + 1, close).trim();
        out = `${out.slice(0, m.index)}((${a})^(${b}))${out.slice(close + 1)}`;
    }
    return out;
}

export function sanitizePlotExpression(fn: string): string {
    return rewritePow(fn
        .replace(/\bMath\.\s*/g, '') // Math.cos → cos, Math.PI → PI (inlined below)
        .replace(/π/g, `(${PI_LITERAL})`)
        .replace(/\bPI\b/g, `(${PI_LITERAL})`)
        .replace(/\bpi\b/g, `(${PI_LITERAL})`)
        .replace(/\*\*/g, '^')); // JS power → function-plot power
}

export function normalizePlotOptions(options: Record<string, unknown>): Record<string, unknown> {
    const out = { ...options };

    // {"fn": "..."} at the top level (no data array) — wrap it.
    if (!Array.isArray(out.data) && typeof out.fn === 'string') {
        out.data = [{ fn: out.fn }];
        delete out.fn;
    }

    // Axes written INSIDE the first series ({"data":[{"fn":"…","xAxis":{…}}]})
    // instead of at the top level. function-plot silently ignores them there and
    // auto-scales, so a deliberate domain — often the only thing making the
    // interesting part of the curve visible — is dropped without any error.
    // Hoist them; a top-level axis already present wins.
    if (Array.isArray(out.data) && out.data.length > 0) {
        const first = out.data[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
            const series = first as Record<string, unknown>;
            for (const axisKey of ['xAxis', 'yAxis'] as const) {
                if (series[axisKey] && !out[axisKey]) out[axisKey] = series[axisKey];
                delete series[axisKey];
            }
            out.data = [series, ...out.data.slice(1)];
        }
    }

    // Invented domain keys → the axis objects function-plot expects.
    const mergeDomain = (axisKey: 'xAxis' | 'yAxis', domain: unknown) => {
        if (!Array.isArray(domain) || domain.length !== 2) return;
        const existing = out[axisKey];
        const axis: Record<string, unknown> =
            existing && typeof existing === 'object' && !Array.isArray(existing)
                ? { ...(existing as Record<string, unknown>) }
                : {};
        axis.domain ??= domain;
        out[axisKey] = axis;
    };
    mergeDomain('xAxis', out.xDomain ?? out.domain);
    mergeDomain('yAxis', out.yDomain);
    delete out.xDomain;
    delete out.yDomain;
    delete out.domain;

    // The app owns sizing (VISUALS_GUIDE: "Do not set width/height"), but models
    // set them anyway — and renderPlot honours a number if it finds one, which
    // pins the chart to e.g. 500px and breaks responsiveness on a phone. Drop
    // them so the container width wins.
    delete out.width;
    delete out.height;

    // An axis name written as `title` (the Vega-Lite word, which models carry
    // over) is dropped by function-plot, whose word is `label`: "Time (s)" and
    // "Position (m)" were in the spec and on no axis.
    for (const axisKey of ['xAxis', 'yAxis'] as const) {
        const axis = out[axisKey];
        if (!axis || typeof axis !== 'object' || Array.isArray(axis)) continue;
        const a = { ...(axis as Record<string, unknown>) };
        if (typeof a.title === 'string' && typeof a.label !== 'string') a.label = a.title;
        delete a.title;
        out[axisKey] = a;
    }

    if (Array.isArray(out.data)) {
        out.data = out.data.map((d) => {
            if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
            const datum = { ...(d as Record<string, unknown>) };
            // A piece of a piecewise curve written as `min`/`max` — function-
            // plot's word is `range`, and without it every piece is drawn over
            // the whole axis (a stress–strain graph became four crossing lines).
            if (!Array.isArray(datum.range) && typeof datum.min === 'number' && typeof datum.max === 'number' && datum.min < datum.max) {
                datum.range = [datum.min, datum.max];
            }
            delete datum.min;
            delete datum.max;
            // fn = y(x); x/y = parametric; r = polar — all expression strings.
            for (const key of ['fn', 'x', 'y', 'r'] as const) {
                if (typeof datum[key] === 'string') datum[key] = sanitizePlotExpression(datum[key] as string);
            }
            return datum;
        });
    }

    return out;
}
