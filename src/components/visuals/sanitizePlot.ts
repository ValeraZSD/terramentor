/**
 * Deterministic function-plot normalizer.
 *
 * The `plot` kind is the preferred channel for the "function, not values"
 * contract (VISUALS_GUIDE): the model emits an expression string and
 * function-plot samples it adaptively at render time, so no model-computed
 * number ever exists in the spec. This normalizer mechanically fixes what
 * local models get wrong about that contract's syntax:
 *   - JS-isms in expressions: `Math.cos(x)`, `x ** 2`, `Math.PI` / `π`
 *     (function-plot's parser wants `cos(x)`, `x^2`, and knows no PI constant
 *     reliably — constants are inlined as numeric literals);
 *   - shape confusions: a bare `{"fn": "..."}` with no `data` array, or
 *     invented `xDomain`/`yDomain` keys instead of `xAxis:{domain:[...]}`.
 * Anything deeper still throws and falls through to the repair loop.
 */

const PI_LITERAL = '3.141592653589793';

export function sanitizePlotExpression(fn: string): string {
    return fn
        .replace(/\bMath\.\s*/g, '') // Math.cos → cos, Math.PI → PI (inlined below)
        .replace(/π/g, `(${PI_LITERAL})`)
        .replace(/\bPI\b/g, `(${PI_LITERAL})`)
        .replace(/\bpi\b/g, `(${PI_LITERAL})`)
        .replace(/\*\*/g, '^'); // JS power → function-plot power
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

    if (Array.isArray(out.data)) {
        out.data = out.data.map((d) => {
            if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
            const datum = { ...(d as Record<string, unknown>) };
            // fn = y(x); x/y = parametric; r = polar — all expression strings.
            for (const key of ['fn', 'x', 'y', 'r'] as const) {
                if (typeof datum[key] === 'string') datum[key] = sanitizePlotExpression(datum[key] as string);
            }
            return datum;
        });
    }

    return out;
}
