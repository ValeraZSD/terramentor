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
const { default: normalizeVegaLite, qualifyDatumFields } = await import(pathToFileURL(out).href);

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

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
