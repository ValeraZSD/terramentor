// tools/plot-scaling-gates.mjs — a chart is drawn where its data IS.
//
// Run:  node tools/plot-scaling-gates.mjs
//
// WHY. Three charts from one learner's library, all valid specs, none an error:
//   - f/f₀ = 1 ± x on x ∈ [-0.3, 0.3] (a Doppler lesson) drew an EMPTY grid.
//     function-plot's default y window is x's span about zero, ±0.15, and both
//     lines sat at ≈1, above it;
//   - log₁₀(x) for x from 0.01 to 1000 ("five orders of magnitude") drew on a
//     linear axis: a wall against the y axis, then a flat line, the axis
//     running on to 1,100;
//   - pow(2, x) beside a constant 10 drew only the 10 — function-plot's default
//     graph cannot raise to a variable power and says nothing.
// And the validator that exists to catch an empty graph passed every one: the
// default graph draws a box per sample (`M x y v h`) and it read those numbers
// as x,y pairs. Pure halves here (no DOM, no model); the rendered half is
// photographed by temp/chart-audit (shoot.mjs) against the real library.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const scratch = mkdtempSync(join(tmpdir(), 'plot-scaling-gates-'));
const load = async (name) => {
    const outfile = join(scratch, `${name}.mjs`);
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL(`../src/components/visuals/${name}.ts`, import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
    });
    return import(pathToFileURL(outfile).href);
};
const { fitYDomain } = await load('plotDomain');
const { readCurve } = await load('validatePlot');
const { rewritePow, normalizePlotOptions } = await load('sanitizePlot');
const { planLogScales, applyLogScales } = await load('vegaScales');
rmSync(scratch, { recursive: true, force: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

// A stand-in for function-plot's evaluator: its grammar is JS's with ^ for power.
const FNS = ['sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'abs', 'max', 'min'];
const evaluate = (d, prop, vars) => {
    const body = String(d[prop]).replace(/\^/g, '**');
    const f = new Function(...FNS, ...Object.keys(vars), `return (${body});`);
    return f(...FNS.map(n => Math[n]), ...Object.values(vars));
};
// function-plot's own default y window (chart.js computeYScale): x's span,
// scaled by the drawing area's shape, centred on zero. The pre-fix behaviour.
const functionPlotDefault = (x, aspect) => [-(x[1] - x[0]) * aspect / 2, (x[1] - x[0]) * aspect / 2];
const within = (d, lo, hi) => d[0] <= lo && d[1] >= hi;

section('plot — a y range the spec did not give is fitted to the curves');
{
    const doppler = { data: [{ fn: '1 + x' }, { fn: '1 - x' }], xAxis: { domain: [-0.3, 0.3] } };
    const before = functionPlotDefault([-0.3, 0.3], 0.55);
    check('control: the pre-fix window misses both lines entirely', before[1] < 0.7, JSON.stringify(before));
    const y = fitYDomain(doppler, evaluate, 0.55);
    check('the Doppler lines (0.7…1.3) are inside the fitted window', y && within(y, 0.7, 1.3), JSON.stringify(y));
    check('…and fill it: zero is not dragged in under a curve that never nears it', y && y[0] > 0.5, JSON.stringify(y));

    const decay = fitYDomain({ data: [{ fn: '10*exp(-x*log(2)/5730)' }], xAxis: { domain: [0, 20000] } }, evaluate);
    check('a decay keeps zero on the axis and is not padded below it', decay && decay[0] === 0 && decay[1] >= 10, JSON.stringify(decay));

    const parabola = fitYDomain({ data: [{ fn: 'x^2-4' }, { fn: '2*x+1' }], xAxis: { domain: [-4, 4] } }, evaluate);
    check('a parabola keeps its vertex (-4) and both ends (12)', parabola && within(parabola, -4, 12), JSON.stringify(parabola));

    check('an explicit y domain is the author\'s and is left alone',
        fitYDomain({ data: [{ fn: 'x' }], yAxis: { domain: [0, 3] } }, evaluate) === null);

    const spiky = fitYDomain({ data: [{ fn: '1/x' }, { fn: 'x^3' }], xAxis: { domain: [-3, 3] } }, evaluate);
    check('an asymptote\'s spike does not set the range; x³ over [-3, 3] does', spiky && within(spiky, -27, 27) && spiky[1] < 40, JSON.stringify(spiky));
    const alone = fitYDomain({ data: [{ fn: '1/x' }], xAxis: { domain: [-3, 3] } }, evaluate);
    check('1/x alone is not fitted to its ±133 spike', alone && alone[1] < 20, JSON.stringify(alone));

    const noX = fitYDomain({ data: [{ fn: 'sin(x)' }] }, evaluate);
    check('no x domain: fitted over function-plot\'s own default window', noX && within(noX, -1, 1) && noX[1] < 1.2, JSON.stringify(noX));

    const circle = fitYDomain({ data: [{ fnType: 'parametric', x: '3*cos(t)', y: '3*sin(t)+5' }], xAxis: { domain: [-4, 4] } }, evaluate, 1);
    check('a circle keeps equal units on both axes (y span = x span × aspect)',
        circle && Math.abs((circle[1] - circle[0]) - 8) < 1e-9, JSON.stringify(circle));
    const squeezed = fitYDomain({ data: [{ fnType: 'parametric', x: '3*cos(t)', y: '3*sin(t)+5' }], xAxis: { domain: [-4, 4] } }, evaluate, 0.5);
    check('…and grows past that only when the shape would not fit', squeezed && within(squeezed, 2, 8), JSON.stringify(squeezed));
    const wide = fitYDomain({ data: [{ fnType: 'parametric', x: '3*cos(t)', y: '3*sin(t)+5' }], xAxis: { domain: [-8, 8] } }, evaluate, 0.5);
    check('…centred on the shape, not on zero', wide && Math.abs((wide[0] + wide[1]) / 2 - 5) < 1e-6 && Math.abs((wide[1] - wide[0]) - 8) < 1e-9, JSON.stringify(wide));

    const flat = fitYDomain({ data: [{ fn: '10' }], xAxis: { domain: [0, 5] } }, evaluate);
    check('a constant gets a window about itself, not a zero-height one', flat && flat[0] < 10 && flat[1] > 10, JSON.stringify(flat));
    check('an unevaluable expression gives no fit (the validator reports it)',
        fitYDomain({ data: [{ fn: 'nosuch(x)' }], xAxis: { domain: [0, 1] } }, evaluate) === null);
}

section('plot validator — reads the default graph\'s boxes');
{
    // The exact path function-plot drew for the Doppler lines, clamped above the top edge.
    const d = ' M 0.25 -1 v 1 M 0.75 -1 v 1 M 1.25 -1 v 1 M 1.75 -1 v 1';
    const oldYs = (d.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|NaN/gi) ?? []).filter((_, i) => i % 2 === 1).map(Number);
    check('control: the old pair-reading parser saw nothing off the canvas', oldYs.every(y => y >= -0.05 * 344), JSON.stringify(oldYs));
    const c = readCurve(d);
    check('every box starts above the canvas', c.boxes && c.boxes.length === 4 && c.boxes.every(y => y < -0.5), JSON.stringify(c.boxes));
    check('a box\'s height is a relative step, not a coordinate', JSON.stringify(c.ys) === '[-1,0,-1,0,-1,0,-1,0]', JSON.stringify(c.ys));
    const poly = readCurve('M0,10L5,20L10,30');
    check('a polyline reads as its points and has no boxes', JSON.stringify(poly.ys) === '[10,20,30]' && poly.boxes === null, JSON.stringify(poly));
    check('a relative line accumulates', JSON.stringify(readCurve('M0,10l5,5l5,5').ys) === '[10,15,20]');
    check('NaN in a path is reported', readCurve('M0,NaNL5,3').hasNaN === true);
}

section('plot sanitizer — the words function-plot does not know');
{
    check('pow(2,x) → a power', rewritePow('pow(2,x)') === '((2)^(x))');
    check('nested arguments with their own commas', rewritePow('0.002*pow(max(x,1), 0.5)') === '0.002*((max(x,1))^(0.5))', rewritePow('0.002*pow(max(x,1), 0.5)'));
    check('two in one expression', rewritePow('pow(x,2)+pow(x,3)') === '((x)^(2))+((x)^(3))');
    check('an unclosed pow is left for the repair loop', rewritePow('pow(x,2') === 'pow(x,2');
    const o = normalizePlotOptions({ data: [{ fn: 'x', min: 0, max: 0.2 }], xAxis: { domain: [0, 1], title: 'Strain' } });
    check('an axis "title" becomes the "label" function-plot draws', o.xAxis.label === 'Strain' && !('title' in o.xAxis));
    check('a piece\'s min/max becomes its "range"', JSON.stringify(o.data[0].range) === '[0,0.2]' && !('min' in o.data[0]));
}

section('vega — a log axis when the data spans decades and the linear one squashes it');
{
    const seq = (start, stop, step, f) => {
        const rows = [];
        for (let x = start; x < stop; x += step) rows.push({ x, y: f(x) });
        return rows;
    };
    const spec = (mark = 'line') => ({
        mark, data: { sequence: { start: 0.01, stop: 1001, step: 1, as: 'x' } },
        transform: [{ calculate: 'log(datum.x)/log(10)', as: 'y' }],
        encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } },
    });
    const log10 = seq(0.01, 1001, 1, Math.log10);
    const plan = planLogScales(spec(), log10);
    check('log₁₀ over 0.01…1000: x goes log, y (−2…3) does not', plan.x && !plan.y, JSON.stringify(plan));
    check('y = 2x over 1…1000 spans three decades and stays linear',
        JSON.stringify(planLogScales(spec(), seq(1, 1001, 5, x => 2 * x))) === '{"x":false,"y":false}');
    check('the 2ˣ hockey stick stays linear — its shape is the lesson',
        JSON.stringify(planLogScales(spec(), seq(0, 20.1, 0.5, x => 2 ** x))) === '{"x":false,"y":false}');
    check('1/x over 0.01…100 goes log-log',
        JSON.stringify(planLogScales(spec(), seq(0.01, 100, 0.5, x => 1 / x))) === '{"x":true,"y":true}');
    check('an area keeps a linear y (it is filled down to zero)', planLogScales(spec('area'), seq(0.01, 100, 0.5, x => 1 / x)).y === false);
    const chose = spec(); chose.encoding.x.scale = { type: 'linear' };
    check('an x scale the author chose is left alone', planLogScales(chose, log10).x === false);
    check('a bar chart is never re-scaled', planLogScales(spec('bar'), log10).x === false);

    const out = applyLogScales(spec(), plan, { x: [0.01, 1000.01], y: [-2, 3] });
    check('the axis ends at the data, not the next decade', JSON.stringify(out.encoding.x.scale) === '{"type":"log","domain":[0.01,1000.01],"nice":false}', JSON.stringify(out.encoding.x.scale));
    check('one tick per decade (5 decades → 5)', out.encoding.x.axis?.tickCount === 5, JSON.stringify(out.encoding.x.axis));
    check('the sequence is re-sampled geometrically, still computed', out.data.sequence?.as === '__logIndex'
        && /pow\(/.test(out.transform[0].calculate) && out.transform[0].as === 'x' && out.transform[1].as === 'y', JSON.stringify(out.transform));
    check('the spec handed in is not mutated', spec().encoding.x.scale === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
