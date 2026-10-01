import { parseLooseJson, type VisualRenderer } from './registry';
import { normalizePlotOptions, sanitizePlotExpression } from './sanitizePlot';
import { appendCaption, takeTitle } from './chartTitle';
import { readCurve, validatePlotRender } from './validatePlot';
import { fitYDomain } from './plotDomain';

/**
 * Mathematical function graphs via function-plot. Accepts either a JSON config
 * ({"data":[{"fn":"sin(x)"}], "xAxis":{"domain":[-5,5]}}) or the shorthand of
 * one bare expression per line ("x^2"). Expression strings are mechanically
 * de-JS-ified first (Math.cos → cos, ** → ^, PI → literal) — see sanitizePlot.
 */
/**
 * Room a tick label needs from the next one before it stops being a label and
 * becomes a smudge: the type is 10px, so vertically that is the height of two
 * lines, and horizontally the width of the widest label a linear axis writes
 * ("−0.25"). function-plot hands d3 no tick count, and d3's default is ten
 * ticks WHATEVER the axis measures in pixels — so a y domain of [-1.5, 1.5]
 * asks for sixteen labels whether the plot is 300px tall or 100.
 */
const MIN_TICK_GAP_Y_PX = 15;
const MIN_TICK_GAP_X_PX = 26;

/**
 * Drop tick labels until the ones left have room, keeping every nth so the
 * axis still reads as a scale. The GRIDLINE stays — a grid with unlabelled
 * lines between the labelled ones is how every other chart in the app draws —
 * and the origin is kept as the anchor, because an axis whose 0 is unlabelled
 * reads as the wrong axis.
 */
function thinAxisLabels(stage: HTMLElement, axis: 'x' | 'y', minGap: number): void {
    const ticks = Array.from(stage.querySelectorAll(`g.${axis}.axis g.tick`));
    if (ticks.length < 3) return;
    const at = (t: Element): number => {
        const m = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(t.getAttribute('transform') || '');
        return m ? parseFloat(axis === 'x' ? m[1] : m[2]) : NaN;
    };
    const placed = ticks
        .map(t => ({ t, at: at(t), zero: (t.textContent || '').trim() === '0' }))
        .filter(p => Number.isFinite(p.at))
        .sort((a, b) => a.at - b.at);
    if (placed.length < 3) return;
    let gap = Infinity;
    for (let i = 1; i < placed.length; i++) gap = Math.min(gap, Math.abs(placed[i].at - placed[i - 1].at));
    if (!(gap > 0)) return;
    const stride = Math.ceil(minGap / gap);
    if (stride <= 1) return;
    const anchor = Math.max(0, placed.findIndex(p => p.zero));
    placed.forEach((p, i) => {
        if ((i - anchor) % stride === 0) return;
        p.t.querySelector('text')?.remove();
    });
}

const renderPlot: VisualRenderer = async (el, code, ctx) => {
    const { default: functionPlot, EvalBuiltIn } = await import('function-plot');

    const trimmed = code.trim();
    let options: Record<string, unknown>;

    if (trimmed.startsWith('{')) {
        try {
            options = (await parseLooseJson(trimmed)) as Record<string, unknown>;
        } catch {
            throw new Error('the plot config is not valid JSON (or a list of expressions, one per line).');
        }
        options = normalizePlotOptions(options);
    } else {
        const fns = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
        options = { data: fns.map(fn => ({ fn: sanitizePlotExpression(fn) })) };
    }

    const data = options.data;
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('the plot config needs a non-empty "data" array of functions.');
    }

    // function-plot draws the title as unwrapped SVG text that the svg viewport
    // clips on a phone — hoist it into an HTML caption instead (chartTitle.ts).
    const title = takeTitle(options);

    // A model-supplied size is a guess about a screen it cannot see, so the
    // container decides: the graph always spans the width it has. Capping (the
    // old behaviour) only fixed the hard-coded 800 that overflows a phone and
    // left the equally common hard-coded 300 drawing a postage stamp in the
    // middle of the card. A model-supplied height is scaled by the same factor
    // so a deliberate aspect ratio survives, and clamped so neither a squashed
    // strip nor a full-screen block gets through.
    // A 680px ceiling sits the graph against the left edge of a 1100px
    // assistant panel with the rest of the card empty; a function graph past
    // ~820px is all margin, so that is the ceiling and the graph is centred in
    // whatever is left.
    const available = Math.max(260, Math.min(ctx.width, 820));
    const specWidth = typeof options.width === 'number' && options.width > 0 ? options.width : null;
    const specHeight = typeof options.height === 'number' && options.height > 0 ? options.height : null;
    const width = available;
    // function-plot spends a fixed 60px of the width and 40px of the height on
    // margins, so a phone-width graph needs a taller box than a desktop one to
    // leave the plot itself a sane shape.
    const defaultRatio = width < 400 ? 0.78 : 0.62;
    // A host with a fixed stage (the settings thumbnail) says how much height
    // there is; the ratio is the default, not a right. Without this the svg is
    // drawn at its own height and the stage CLIPS it — the sample came out as
    // the top half of a sine wave with no x axis, which looks broken rather
    // than cropped. The 180 floor is a floor on what a graph is worth drawing
    // at, so it too gives way to a ceiling below it.
    const ceiling = Math.min(460, typeof ctx.maxHeight === 'number' && ctx.maxHeight > 0 ? ctx.maxHeight : 460);
    const height = Math.max(Math.min(180, ceiling), Math.min(ceiling, Math.round(
        specHeight === null
            ? width * defaultRatio
            : specHeight * (specWidth === null ? 1 : width / specWidth),
    )));

    // Curve colours. function-plot falls back to a d3 categorical scheme picked
    // for white paper; the app's own series ramp is validated against whichever
    // theme is live (palette.ts), and a colour the spec set explicitly is left
    // alone — a model that named a colour was making a point with it. ONE curve
    // is the learner's accent, exactly as a single-series chart is (renderVega):
    // a lone function has nothing to be told apart from, and a fixed blue on an
    // accent-coloured page reads as a colour the app forgot to theme. Two or
    // more take the categorical ramp, which is fixed so what a series MEANS
    // does not change with the accent.
    const single = data.length === 1;
    for (let i = 0; i < data.length; i++) {
        const entry = data[i] as Record<string, unknown>;
        if (entry && typeof entry === 'object' && !entry.color) {
            entry.color = single ? ctx.palette.accent : ctx.palette.series[i % ctx.palette.series.length];
        }
        // function-plot draws a scatter point with a radius of ONE pixel — four
        // measured points were four specks nobody could find on the grid.
        if (entry && typeof entry === 'object' && entry.graphType === 'scatter' && !entry.attr) {
            entry.attr = { r: 4 };
        }
    }

    appendCaption(el, title);
    const stage = document.createElement('div');
    stage.style.width = `${width}px`;
    stage.style.maxWidth = '100%';
    stage.style.margin = '0 auto';
    el.appendChild(stage);

    // A y range the spec did not give is fitted to the curves (plotDomain.ts):
    // function-plot's own default is x's span about zero, which drew 1 ± x on
    // x ∈ ±0.3 in y ∈ ±0.15 — an empty grid with both lines above it.
    // The drawing area's shape (function-plot's margins are 40+20 across, 20+20
    // down), so a circle drawn parametrically stays a circle.
    const aspect = (height - 40) / Math.max(1, width - 60);
    const fitted = fitYDomain(options, (d, prop, vars) => EvalBuiltIn(d, prop, vars), aspect);
    if (fitted) {
        const yAxis = options.yAxis && typeof options.yAxis === 'object' && !Array.isArray(options.yAxis)
            ? options.yAxis as Record<string, unknown> : {};
        options.yAxis = { ...yAxis, domain: fitted };
    }

    // Which curves were left to function-plot's default graph type. It fills
    // those in on the datum during the first draw, so this is read before.
    const defaulted = data.map(d => !!d && typeof d === 'object' && !('graphType' in (d as object)));

    // function-plot throws synchronously on unparseable expressions — exactly
    // what we want; the shell catches it and shows the source.
    type Chart = { meta?: { zoomBehavior?: { filter?: (f: (e: Event) => boolean) => unknown } } };
    const draw = (): Chart => functionPlot({
        grid: true,
        ...options,
        target: stage,
        width,
        height,
    } as never) as unknown as Chart;
    let chart = draw();

    // function-plot's default graph evaluates with INTERVAL arithmetic, which
    // cannot raise to a variable or fractional power: 2^x and x^0.5 draw
    // nothing at all, silently, while the curve beside them draws fine. Such a
    // curve is redrawn as a plain sampled line, which evaluates it point by
    // point exactly as the y fit above already did.
    const blank = data.flatMap((d, i) => {
        if (!defaulted[i]) return [];
        const own = Array.from(stage.querySelectorAll(`path.line-${i}`));
        return own.length && own.every(p => readCurve(p.getAttribute('d') ?? '').ys.length === 0) ? [i] : [];
    });
    if (blank.length) {
        for (const i of blank) Object.assign(data[i] as Record<string, unknown>, { graphType: 'polyline', sampler: 'builtIn' });
        stage.replaceChildren();
        chart = draw();
    }

    // A graph sits in a page that scrolls. d3-zoom takes EVERY wheel event over
    // it, so scrolling the feed past a graph zoomed the graph instead — and left
    // it at whatever scale the scroll happened to reach (the Doppler lines were
    // found again at x ∈ [-4, 5], a range the lesson never meant). A wheel with
    // Ctrl/⌘ held still zooms (so does a trackpad pinch, which arrives as one);
    // a plain wheel scrolls the page. Dragging to pan is unchanged.
    chart.meta?.zoomBehavior?.filter?.((e: Event) => {
        if (e.type === 'wheel') return (e as WheelEvent).ctrlKey || (e as WheelEvent).metaKey;
        return !(e as MouseEvent).ctrlKey && !(e as MouseEvent).button;   // d3-zoom's own default
    });

    thinAxisLabels(stage, 'y', MIN_TICK_GAP_Y_PX);
    thinAxisLabels(stage, 'x', MIN_TICK_GAP_X_PX);

    // Now that the curve exists in the DOM, assert it is actually a curve. A
    // flat or NaN-filled line renders without complaint, so this is the only
    // place the failure is visible to anything but the learner.
    validatePlotRender(stage, height, data.flatMap((d, index) => {
        const e = d as Record<string, unknown>;
        return e && typeof e.fn === 'string' && (e.fnType === undefined || e.fnType === 'linear')
            ? [{ index, label: e.fn }] : [];
    }));
};

export default renderPlot;
