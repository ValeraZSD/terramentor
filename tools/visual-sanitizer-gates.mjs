// tools/visual-sanitizer-gates.mjs — the mechanical layer under the visual specs.
//
// Run:  node tools/visual-sanitizer-gates.mjs
//
// WHY. This repo's standing preference is a deterministic repair over a model
// round-trip: a sanitizer that fixes a class of mistake fixes it for every
// model, for free, forever, while a repair prompt fixes one instance and bills
// for it. These are the assertions for the fixes that are pure arithmetic over
// a spec — no DOM, no model, no network, so they can be asserted at all.
//
// The case that earned this file: a Doppler lesson's chart died with
// `Unrecognized signal name: "vs"`. Vega's expression language has no bare
// field references — an unqualified name is looked up as a SIGNAL — and the
// model had written `"calculate": "440*(343/(343-vs))"` one line under
// `"sequence": {…, "as": "vs"}`. The field name is declared in the spec itself,
// so this is not an ambiguity the app has to ask a model about.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'visual-sanitizer-gates-'));
const out = join(scratch, 'vega.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/visuals/sanitizeVega.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
});
const { default: normalizeVegaLite, qualifyDatumFields, sanitizeVegaExpression } = await import(pathToFileURL(out).href);

// The two sanitizers that read text and the one that reads a drawing, bundled
// the same way. The drawing's needs a DOM: a jsdom stands in for the page.
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body></body>');
for (const k of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Node', 'NodeFilter', 'SVGElement', 'CSSStyleSheet']) {
    globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const bundle = async (src, name) => {
    const outfile = join(scratch, name);
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL(src, import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
    });
    return import(pathToFileURL(outfile).href);
};
const svgAnim = await bundle('../src/components/visuals/sanitizeSvgAnim.ts', 'svg-anim.mjs');
const { sanitizeMermaid } = await bundle('../src/components/visuals/sanitizeMermaid.ts', 'mermaid.mjs');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

section('Vega — a declared field referenced bare is a field, not a signal');
{
    // The exact spec that failed on screen, reduced to its load-bearing parts.
    const screenshot = {
        mark: 'line',
        data: { sequence: { start: -300, stop: 300, step: 10, as: 'vs' } },
        transform: [{ calculate: '440*(343/(343-vs))', as: 'f_obs' }],
        encoding: {
            x: { field: 'vs', type: 'quantitative', title: 'Source speed (m/s)' },
            y: { field: 'f_obs', type: 'quantitative', title: 'Observed frequency (Hz)' },
        },
    };
    const fixed = normalizeVegaLite(structuredClone(screenshot));
    check('the sequence field is bound in the calculate that uses it',
        fixed.transform[0].calculate === '440*(343/(343-datum.vs))', fixed.transform[0].calculate);

    // A field a transform PRODUCES is a field too, for every later expression.
    const chained = {
        mark: 'line',
        data: { sequence: { start: 0, stop: 10, step: 1, as: 'x' } },
        transform: [{ calculate: 'x * 2', as: 'y' }, { calculate: 'y + 1', as: 'z' }],
        encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'z', type: 'quantitative' } },
    };
    const chainedOut = normalizeVegaLite(structuredClone(chained));
    check('a transform output is bound in a later expression',
        chainedOut.transform[0].calculate === 'datum.x * 2' && chainedOut.transform[1].calculate === 'datum.y + 1',
        JSON.stringify(chainedOut.transform));

    // Keys of inline `values` are fields as well.
    const inline = {
        mark: 'bar',
        data: { values: [{ year: 2020, sales: 5 }, { year: 2021, sales: 8 }] },
        transform: [{ filter: 'sales > 6' }],
        encoding: { x: { field: 'year', type: 'ordinal' }, y: { field: 'sales', type: 'quantitative' } },
    };
    check('an inline data key is bound inside a filter',
        normalizeVegaLite(structuredClone(inline)).transform[0].filter === 'datum.sales > 6');

    // AND THE OTHER HALF: this may only ever bind a name the data can satisfy.
    // A pass that qualified anything that looked like an identifier would break
    // every function call and every constant in the language.
    const fields = new Set(['vs', 'x', 'sin']);
    const table = [
        ['440*(343/(343-vs))', '440*(343/(343-datum.vs))', 'a bare field is qualified'],
        ['datum.vs * 2', 'datum.vs * 2', 'an already-qualified reference is untouched'],
        ['parent.vs', 'parent.vs', 'a reference through any other object is untouched'],
        ['sin(x)', 'sin(datum.x)', 'a function call keeps its name, its argument is qualified'],
        ['sin(vs) + cos(vs)', 'sin(datum.vs) + cos(datum.vs)', 'every occurrence is qualified'],
        ["format(vs, '.2f') + ' vs '", "format(datum.vs, '.2f') + ' vs '", 'a field name inside a string literal is left alone'],
        ['pow(x,2) + PI', 'pow(datum.x,2) + PI', 'a constant is not a field'],
        ['unknown * 3', 'unknown * 3', 'a name the spec never declares is left alone'],
        ['x', 'datum.x', 'a whole expression that is one field'],
    ];
    for (const [input, want, why] of table) {
        const got = qualifyDatumFields(input, fields);
        check(why, got === want, `${JSON.stringify(input)} → ${JSON.stringify(got)}`);
    }

    check('nothing is rewritten when the spec declares no fields',
        qualifyDatumFields('a + b', new Set()) === 'a + b');

    // A spec whose data source is a URL declares no field names here, so a bare
    // reference stays as written — guessing would be the cardinal sin.
    const remote = {
        mark: 'line',
        data: { url: 'https://example.invalid/d.json' },
        transform: [{ calculate: 'value * 2', as: 'doubled' }],
        encoding: { y: { field: 'doubled', type: 'quantitative' } },
    };
    check('an unknowable schema leaves an unrecognised name alone',
        normalizeVegaLite(structuredClone(remote)).transform[0].calculate === 'value * 2');
}

section('Vega — an exponent keeps the function it applies to');
{
    // `Math.sin(x) ** 2`: the operand could not include the function name, so
    // the paren group matched alone and the result was `sinpow((x),2)`, an
    // unknown function that sent the commonest "sin squared" to the repair loop.
    const table = [
        ['Math.sin(x) ** 2', 'pow(sin(x),2)', 'a call on the left'],
        ['2 ** Math.cos(x)', 'pow(2,cos(x))', 'a call on the right'],
        ['abs(x - 1) ** 2 + 3', 'pow(abs(x - 1),2) + 3', 'a call with spaces inside, and a tail'],
        ['x ** 2', 'pow(x,2)', 'a plain identifier'],
        ['datum.a ** (b+1)', 'pow(datum.a,(b+1))', 'a field and a paren group'],
        ['(a+b) ** 2', 'pow((a+b),2)', 'a bare paren group'],
        ['3 ** 2', 'pow(3,2)', 'two numbers'],
    ];
    for (const [input, want, why] of table) {
        const got = sanitizeVegaExpression(input);
        check(why, got === want, `${JSON.stringify(input)} → ${JSON.stringify(got)}`);
    }
}

section('Vega — a dollar sign is only removed from maths');
{
    // Two currency signs in one title paired up and everything between them,
    // the unit included, lost its delimiters: "Cost (M) vs revenue (K)".
    const title = (t) => normalizeVegaLite({ mark: 'bar', title: t, data: { values: [{ a: 1 }] }, encoding: { x: { field: 'a', type: 'quantitative' } } }).title;
    const table = [
        ['Cost ($M) vs revenue ($K)', 'Cost ($M) vs revenue ($K)', 'two units in one title are left alone'],
        ['$5 and $10', '$5 and $10', 'two prices are left alone'],
        ['Price in $ per kg ($/kg)', 'Price in $ per kg ($/kg)', 'a bare dollar sign is left alone'],
        ['Speed $v_0$ over time', 'Speed v_0 over time', 'a subscript is maths'],
        ['Energy $E = mc^2$', 'Energy E = mc^2', 'a superscript is maths'],
        ['Angle $\\theta$ (rad)', 'Angle \\theta (rad)', 'a LaTeX command is maths'],
        ['$x$ against $t$', 'x against t', 'a single-letter symbol is maths'],
    ];
    for (const [input, want, why] of table) {
        const got = title(input);
        check(why, got === want, `${JSON.stringify(input)} → ${JSON.stringify(got)}`);
    }
}

section('Mermaid — a header above the diagram does not hide its kind');
{
    // `%%{init}%%`, a `%%` comment and `---` front matter are all supported,
    // and each one made the first non-blank line something other than
    // `flowchart`, so label quoting was skipped and `A[f(x)]` failed to parse.
    const quoted = 'A["f(x)"] --> B';
    const header = {
        directive: '%%{init: {"flowchart": {"curve": "basis"}}}%%',
        comment: '%% a note about (this)',
        frontMatter: '---\ntitle: Demo (draft)\nconfig:\n  flowchart:\n    curve: basis\n---',
        multiLine: '%%{init: {\n  "flowchart": {"curve": "basis"}\n}}%%',
        blanks: '\n\n%% one\n\n%% two',
    };
    for (const [name, head] of Object.entries(header)) {
        const got = sanitizeMermaid(`${head}\nflowchart TD\n  A[f(x)] --> B`);
        check(`[${name}] a flowchart under it still has its labels quoted`, got.includes(quoted), got);
        check(`[${name}] and the header is passed through exactly as written`, got.startsWith(head), got);
    }
    const seq = `${header.directive}\nsequenceDiagram\n  A->>B: f(x)`;
    check('a sequence diagram under a header is not touched', sanitizeMermaid(seq) === seq, sanitizeMermaid(seq));
    check('no header: unchanged behaviour', sanitizeMermaid('flowchart TD\n  A[f(x)] --> B').includes(quoted));
}

section('SVG animation — a stylesheet reference to the drawing\'s own #id survives');
{
    // A browser serialises `fill: url(#g)` back as `url("#g")`, and the pattern
    // that tested the character after an optional quote backtracked to "no
    // quote" and turned the quoted fragment into `none`: the gradient, marker or
    // clip silently disappeared. Attribute values are checked as written.
    const scene = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300">${inner}<circle cx="10" cy="10" r="5"><animate attributeName="cx" values="10;50;10" dur="2s" repeatCount="indefinite"/></circle></svg>`;
    const run = (inner) => new XMLSerializer().serializeToString(svgAnim.sanitizeAnimatedSvg(scene(inner)));
    for (const ref of ['url(#g)', 'url("#g")', "url('#g')", 'url( #g)', 'url( "#g")', "url( '#g' )"]) {
        const got = run(`<rect width="5" height="5" fill="${ref.replace(/"/g, '&quot;')}"/>`);
        check(`fill=${ref} is kept`, /fill="url\(\s*(&quot;|')?#g(&quot;|')?\s*\)"/.test(got), got);
    }
    const sheet = run('<style>rect { fill: url("#g"); stroke: url(\'#g\') }</style><rect width="5" height="5"/>');
    check('a quoted fragment in a stylesheet is kept', /fill:\s*url\(["']?#g["']?\)/.test(sheet) && /stroke:\s*url\(["']?#g["']?\)/.test(sheet), sheet);
    // And it is still the same boundary: nothing off-document gets through.
    for (const ref of ['url(https://tracker.example/p.svg#g)', 'url("https://tracker.example/p.svg#g")', "url('//tracker.example/p')", 'url( "http://tracker.example/p")', 'url("data:image/svg+xml,x#g")']) {
        const got = run(`<rect width="5" height="5" fill="${ref.replace(/"/g, '&quot;')}"/>`) + run(`<style>rect { fill: ${ref} }</style><rect width="5" height="5"/>`);
        check(`${ref} is still refused`, !/tracker\.example|data:image/.test(got), got);
    }
}

section('SVG animation — a relative font size in a stylesheet is left alone');
{
    // Only a bare number or px is a user unit. `0.8em` was read as 0.8 units,
    // raised to the floor and left in front of its real unit (`12pxem`), which
    // the browser drops, along with the size the author meant.
    const parse = (css) => new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><style>${css}</style><text x="5" y="20">label</text></svg>`,
        'image/svg+xml').documentElement;
    const keep = ['.a{font-size:0.8em}', '.a{font-size:1.2rem}', '.a{font:0.9em sans-serif}', '.a{font-size:90%}', '.a{font:italic 0.75rem/1.2 serif}'];
    for (const css of keep) {
        const svg = parse(css);
        const raised = svgAnim.floorLabelSizes(svg);
        check(`${css} is not rewritten`, raised === 0 && svg.querySelector('style').textContent === css,
            `${raised} raised → ${svg.querySelector('style').textContent}`);
        check(`${css} does not read as a tiny label`, svgAnim.smallestLabelUnits(svg) === 16, String(svgAnim.smallestLabelUnits(svg)));
    }
    const px = parse('.a{font-size:8px} .b{font:bold 9px sans-serif} .c{font-size:7}');
    svgAnim.floorLabelSizes(px);
    check('a px (or bare) size under the floor is still raised',
        px.querySelector('style').textContent === '.a{font-size:12px} .b{font:bold 12px sans-serif} .c{font-size:12px}',
        px.querySelector('style').textContent);
    check('and still counted as the smallest label', svgAnim.smallestLabelUnits(parse('.a{font-size:8px}')) === 8);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
