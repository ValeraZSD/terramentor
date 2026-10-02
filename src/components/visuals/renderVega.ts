import { parseLooseJson, type VisualRenderer } from './registry';
import { normalizeVegaLite, findEmptyEncodingChannel, findUnboundEncodingField } from './sanitizeVega';
import { appendCaption, takeTitle } from './chartTitle';
import { validateVegaView, type VegaViewLike } from './validateVega';
import { planLogScales, applyLogScales } from './vegaScales';
type VegaNamespace = typeof import('vega-embed').vega;

/**
 * vega's own loader, refusing every address. A chart in an imported course or
 * a model's answer may name a `data.url`: off this origin, fetching it unasked
 * tells that host who opened the page and when; on it, the address can be an
 * API route that does work when requested. A chart here draws the data written
 * into it, and nothing the app writes needs more.
 */
function noFetchLoader(vega: VegaNamespace, refused: string[]) {
    const base = vega.loader();
    return {
        ...base,
        async sanitize(uri: string) {
            const reason = `the chart asks for data from an address (${uri}); a chart here draws only the data written into it, as "values".`;
            // Vega logs a loader error and carries on with no rows, so the
            // reason is kept here and becomes the chart's error below.
            refused.push(reason);
            throw new Error(reason);
        },
    };
}

/**
 * The widest a chart is drawn. A 720px left-aligned cap in the assistant
 * panel on a desktop — 1100px of card — fills the left 60% and leaves the
 * rest as bare dark background, which reads as a chart that has failed to
 * scale. Past this width a five-bar chart is five slabs; below it, on the
 * phone, every pixel is used.
 */
const MAX_CHART_WIDTH = 960;

/** Approximate glyph width at Vega's default 10px axis label, plus padding. */
const LABEL_PX_PER_CHAR = 6.2;

/** The scale type of a positional channel, when it is a band (bar/tick) axis. */
function isDiscrete(def: unknown): def is Record<string, unknown> {
    if (!def || typeof def !== 'object') return false;
    const d = def as Record<string, unknown>;
    return d.type === 'nominal' || d.type === 'ordinal';
}

/**
 * Whether the category labels along a discrete x axis FIT upright, from the
 * data the spec carries. Vega-Lite's default for a nominal x axis is to write
 * every label vertically (270°), which is right for thirty long names and
 * wrong for five short words — "I saw the cat" printed sideways under its
 * bars was the complaint. Decided from the inline values when they are there
 * (the only case with real labels to measure); a sequence's labels are
 * numbers, which always fit.
 */
function labelAngleForX(spec: Record<string, unknown>, plotWidth: number): number | null {
    const enc = spec.encoding as Record<string, unknown> | undefined;
    const x = enc?.x;
    if (!isDiscrete(x) || typeof x.field !== 'string') return null;
    const axis = x.axis as Record<string, unknown> | undefined;
    if (axis && typeof axis === 'object' && 'labelAngle' in axis) return null;   // the author chose
    const data = spec.data as Record<string, unknown> | undefined;
    const values = Array.isArray(data?.values) ? data!.values as Record<string, unknown>[] : null;
    if (!values) return 0;
    const field = x.field;
    const labels = new Set<string>();
    for (const row of values) {
        if (row && typeof row === 'object' && field in row) labels.add(String(row[field]));
    }
    if (labels.size === 0) return 0;
    const band = plotWidth / labels.size;
    const longest = Math.max(...[...labels].map(l => l.length));
    return longest * LABEL_PX_PER_CHAR + 6 <= band ? 0 : -40;
}

/**
 * A Vega expression for one quantitative axis's labels: plain digits in the
 * range people read them in, e-notation outside it. The test is on the axis's
 * DOMAIN (`domain('x')`), not the label, so an axis never mixes the two forms.
 * On a scale name that does not exist `domain` returns an empty array, the max
 * is NaN, and the default label stands.
 */
function magnitudeLabel(scale: 'x' | 'y'): string {
    const m = `max(abs(domain('${scale}')[0]), abs(domain('${scale}')[1]))`;
    // d3 writes a positive exponent as "e+30"; the plus is noise on an axis.
    return `(${m} > 0 && (${m} < 0.001 || ${m} >= 1e9)) ? (datum.value == 0 ? '0' : replace(format(datum.value, '.2~e'), 'e+', 'e')) : datum.label`;
}

// Vega-Lite names user-data flows source_N / data_N (see validateVega.ts).
const USER_DATASET_RE = /^(source|data)_\d+$/;

/** The rows the chart's marks were drawn from: the largest dataset carrying both positional fields. */
function drawnRows(view: VegaViewLike, spec: Record<string, unknown>): Record<string, unknown>[] {
    const enc = spec.encoding as Record<string, Record<string, unknown> | undefined> | undefined;
    const xf = enc?.x?.field, yf = enc?.y?.field;
    if (typeof xf !== 'string' || typeof yf !== 'string') return [];
    let best: Record<string, unknown>[] = [];
    try {
        const state = view.getState({ data: () => true, signals: () => false });
        for (const name of Object.keys(state.data ?? {}).filter(n => USER_DATASET_RE.test(n))) {
            const rows = view.data(name) as Record<string, unknown>[];
            if (Array.isArray(rows) && rows.length > best.length && rows.every(r => r && xf in r && yf in r)) best = rows;
        }
    } catch { /* introspection failure: no redraw */ }
    return best;
}

/** Data charts (bar/line/scatter/area/pie/…) from a Vega-Lite JSON spec. */
const renderVega: VisualRenderer = async (el, code, ctx) => {
    const embedModule = await import('vega-embed');
    const embed = embedModule.default;

    let parsed: unknown;
    try {
        parsed = await parseLooseJson(code);
    } catch {
        throw new Error('the chart spec is not valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('the chart spec must be a JSON object (a Vega-Lite specification).');
    }
    // Drop the invalid top-level channel/scale props and malformed transforms
    // small models invent — Vega-Lite throws an opaque error on them otherwise.
    const spec = normalizeVegaLite(parsed as Record<string, unknown>);

    // A channel bound to nothing (an empty `y` with only scale/axis) draws a
    // hollow chart that validateVega can't catch — finite rows, no NaN. The
    // sanitizer auto-binds the unambiguous single-orphan case; anything left
    // is genuinely under-specified, so throw for the repair loop.
    const emptyChannel = findEmptyEncodingChannel(spec);
    if (emptyChannel) {
        throw new Error(
            `the "${emptyChannel}" encoding channel maps to no data — it has a scale/axis but no "field". ` +
            'Give it a "field" (e.g. the value a "calculate" transform produced) or a constant "value"; ' +
            'a channel with only scale/axis draws nothing.',
        );
    }

    // A channel bound to a field the data never produces (the phantom-field bug):
    // Vega drops those rows as invalid → blank chart, no error. When the field
    // universe is fully knowable, name the missing field AND the real fields so
    // the repair loop fixes it on the first try instead of guessing.
    const unbound = findUnboundEncodingField(spec);
    if (unbound) {
        const have = unbound.available.length
            ? unbound.available.map((f) => `"${f}"`).join(', ')
            : 'none';
        throw new Error(
            `an encoding channel maps to the field "${unbound.field}", but the data never produces it, ` +
            `so every row is empty and the chart renders blank. The only fields that exist here are: ${have}. ` +
            `Either point the channel at one of those fields, or add a "transform" with a "calculate" ` +
            `that computes "${unbound.field}" from a formula (never hard-code numbers). ` +
            `If there is no quantity to plot, this concept should not be a chart — use a diagram or prose instead.`,
        );
    }

    spec.$schema ??= 'https://vega.github.io/schema/vega-lite/v6.json';

    // The title is drawn as clipped SVG text; render it as wrapping HTML above
    // the chart instead (see chartTitle.ts).
    const title = takeTitle(spec);

    // Numeric width — the scratch element is detached, so width:'container'
    // would resolve to 0, and a width the model hard-coded is a guess about a
    // screen it cannot see. The container is the only real number, so the chart
    // always spans it: capping alone fixed the hard-coded 800 that overflows a
    // phone but kept the hard-coded 300 that leaves a third of the card empty.
    // A hard-coded height is scaled by the same factor so a deliberate aspect
    // ratio survives; without one, Vega-Lite's own default applies.
    const available = Math.max(220, Math.min(ctx.width, MAX_CHART_WIDTH));
    const specWidth = typeof spec.width === 'number' && spec.width > 0 ? spec.width : null;
    if (specWidth !== null && typeof spec.height === 'number' && spec.height > 0) {
        spec.height = Math.max(120, Math.min(460, Math.round(spec.height * (available / specWidth))));
    }
    spec.width = available;
    // A height in proportion to the width, when the spec names none: Vega-
    // Lite's default is 200px whatever the width, which at 960px is a strip.
    // Only a continuous y is sized this way — a discrete y (horizontal bars)
    // is one step per category, and is left to grow with its categories.
    const continuousHeight = Math.max(200, Math.min(420, Math.round(available * 0.5)));
    // Upright category labels when they fit, angled when they do not — the
    // plot is the width minus a y axis of roughly 60px.
    const labelAngle = labelAngleForX(spec, available - 60);
    // With `fit-x`, `width` means the TOTAL width including axes and labels, so
    // the chart shrinks to the viewport rather than pushing its y-axis out of
    // frame. Vega-Lite ignores (and warns about) autosize on multi-view specs,
    // so only single/layered specs opt in.
    const multiView = ['facet', 'hconcat', 'vconcat', 'concat', 'repeat'].some(k => k in spec);
    if (!multiView) spec.autosize ??= { type: 'fit-x', contains: 'padding' };
    spec.background = 'transparent';

    appendCaption(el, title);
    // …then embed into a CHILD, never into `el`. vega-embed opens with
    // `element.innerHTML = ''` (embed.js, "clear container"), so embedding into
    // the element the caption was just appended to deleted EVERY chart title in
    // the app — the one thing chartTitle.ts exists to preserve, thrown away on
    // the next line, silently. renderPlot never had the bug because it always
    // built its own stage div; this is that, for the same reason.
    const stage = document.createElement('div');
    // Centred in the card: with `fit-x` the svg is exactly `available` wide,
    // and a chart narrower than its card sits in the middle of it, not
    // against the left edge with the rest of the card empty.
    stage.style.width = `${available}px`;
    stage.style.maxWidth = '100%';
    stage.style.margin = '0 auto';
    el.appendChild(stage);

    // Vega's built-in `dark` theme is a two-state switch against ITS idea of a
    // dark page, so on `warm` it drew stock-slate axes on cream and on `black`
    // it drew a near-black chart on true black. The config below is the app's
    // own palette instead: one set of tokens, four themes, and a chart
    // generated months ago follows whichever one it is being read in (the
    // palette is a render dependency — see VisualBlock).
    const p = ctx.palette;
    const refused: string[] = [];
    const draw = (s: Record<string, unknown>) => embed(stage, s as never, {
        actions: false,
        renderer: 'svg',
        loader: noFetchLoader(embedModule.vega, refused) as never,
        theme: ctx.isDark ? 'dark' : undefined,
        // Hover (or tap) reads the value off a mark. The chart is otherwise a
        // picture of numbers nobody can read exactly; vega-tooltip's own
        // dark/light skins follow the theme the chart is drawn for.
        tooltip: { theme: ctx.isDark ? 'dark' : 'light' },
        config: {
            background: 'transparent',
            font: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            title: { color: p.fg, subtitleColor: p.muted },
            axis: {
                labelColor: p.muted, titleColor: p.fg,
                domainColor: p.border, tickColor: p.border, gridColor: p.border,
                labelFontSize: 11, titleFontSize: 12, titlePadding: 8,
            },
            // Numbers too small or too large for plain digits are written in
            // e-notation, decided per AXIS from its domain so every label on
            // it takes the same form. Vega's default printed a scattering
            // cross-section as "0.000000000045", fifteen characters a tick,
            // and a gravity chart's newtons the same way — the labels took a
            // third of the width and read as a row of zeros.
            axisXQuantitative: { labelExpr: magnitudeLabel('x') },
            axisYQuantitative: { labelExpr: magnitudeLabel('y') },
            ...(labelAngle !== null ? { axisX: { labelAngle } } : {}),
            legend: { labelColor: p.muted, titleColor: p.fg },
            view: { stroke: p.border, continuousHeight, discreteHeight: { step: 28 } },
            // A single-series chart is the common case here, so its one mark
            // takes the learner's accent; a multi-series one takes the
            // categorical ramp, which is fixed and validated against this
            // theme's background rather than being tints of that accent.
            mark: { color: p.accent, tooltip: { content: 'encoding' } },
            bar: { cornerRadiusEnd: 2 },
            line: { strokeWidth: 2.5 },
            point: { size: 60 },
            range: { category: p.series },
        },
    });
    let result = await draw(spec);

    // A chart whose x spans decades and does all its changing in the first
    // sliver of a linear axis is redrawn on a log one (vegaScales.ts) — judged
    // on the rows Vega computed, since under "function, not values" the data
    // does not exist until the chart has been drawn once.
    if (!multiView && !('layer' in spec)) {
        const rows = drawnRows(result.view as unknown as VegaViewLike, spec);
        const plan = planLogScales(spec, rows);
        if (plan.x || plan.y) {
            const enc = spec.encoding as Record<string, Record<string, unknown>>;
            const range = (field: unknown): [number, number] => {
                const vs = rows.map(r => r[field as string] as number);
                return [Math.min(...vs), Math.max(...vs)];
            };
            result.finalize();
            result = await draw(applyLogScales(spec, plan, { x: range(enc.x.field), y: range(enc.y.field) }));
        }
    }

    // Numeric sanity check over the *computed* datasets (NaN rows, zero rows
    // render as a silently blank chart). Throwing here keeps the last good
    // render on screen and feeds the descriptive message to the repair loop.
    try {
        if (refused.length) throw new Error(refused[0]);
        validateVegaView(result.view as unknown as VegaViewLike);
    } catch (e) {
        result.finalize();
        throw e;
    }
    return () => result.finalize();
};

export default renderVega;
