// tools/number-format-gates.mjs — how a number is written, and what that must
// never change.
//
// Run:  node tools/number-format-gates.mjs
//
// The separators are a preference (Settings → General → Numbers) with the
// interface language as the default. Three things have to stay true:
//
//   1. **Every option's label is what it actually produces.** The options carry
//      no words in any language — the example IS the option — so a style whose
//      output drifts from its own id is a control that lies about itself, in
//      twelve languages at once, and nothing else would catch it.
//   2. **It never narrows what a learner may TYPE.** `parseNumber` takes no
//      preference and accepts both separators from everyone. A display choice
//      deciding whether 0.5 is a correct answer would mark physics wrong for a
//      formatting setting.
//   3. **Nothing goes back to the device locale.** 41 of 44 call sites used a
//      bare `.toLocaleString()`, which follows the operating system's regional
//      settings rather than the language the app is being read in — so two
//      panels on one screen disagreed. That is a source scan, because a wrong
//      separator is perfectly valid code.

import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'number-format-gates-'));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

const stub = join(scratch, 'stub.js');
require('node:fs').writeFileSync(stub, "export const currentLocale = () => 'en-US';\nexport const uiLocale = () => 'en-US';\nexport const k = (s) => s;\nexport default {};\n");
async function bundleClient(entry) {
    const outfile = join(scratch, entry.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '.mjs'));
    await esbuild.build({
        entryPoints: [join(repoRoot, entry)],
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
        plugins: [{
            name: 'stub-runtime',
            setup(build) { build.onResolve({ filter: /(^|\/)(i18n|locale)$/ }, () => ({ path: stub })); },
        }],
    });
    return outfile;
}
const fmt = await import(pathToFileURL(await bundleClient('src/utils/numberFormat.ts')).href);
const formats = await import(pathToFileURL(await bundleClient('src/components/answer/formats.ts')).href);

// ---------------------------------------------------------------------------
section('every option is its own worked example');

// A normal space in the id, a non-breaking one in the output: a grouped number
// must not wrap across two lines, and the two are indistinguishable on screen.
const seen = (s) => s.replace(/ /g, ' ');
for (const style of fmt.NUMBER_STYLES) {
    check(`the option "${style.id}" writes 1234.5 as exactly that`,
        seen(fmt.formatNumber(1234.5, style.id)) === style.id,
        seen(fmt.formatNumber(1234.5, style.id)));
}
check('grouping uses a NON-BREAKING space, so a number never wraps',
    fmt.formatNumber(1234.5, '1 234,5').includes(' '));
check('the group and the decimal separator are never the same character',
    fmt.NUMBER_STYLES.every(s => !s.group || s.group !== s.decimal));
check('every style id is unique', new Set(fmt.NUMBER_STYLES.map(s => s.id)).size === fmt.NUMBER_STYLES.length);
check('"auto" is a style nobody can also define', !fmt.NUMBER_STYLES.some(s => s.id === fmt.AUTO));
check('an unknown stored value is accepted as nothing, not crashed on',
    !fmt.isNumberStyle('1;234!5') && fmt.isNumberStyle(fmt.AUTO) && fmt.isNumberStyle('1.234,5'));
check('with no preference the interface language decides',
    fmt.formatNumber(1234.5, fmt.AUTO) === (1234.5).toLocaleString('en-US'));

// ---------------------------------------------------------------------------
section('precision is not lost or invented');

check('a key authored as "4.170" keeps its three significant figures',
    fmt.formatNumber(4.17, '1,234.5', { decimals: fmt.writtenDecimals('4.170') }) === '4.170');
check('…and one authored as "4.17" is not padded',
    fmt.formatNumber(4.17, '1,234.5', { decimals: fmt.writtenDecimals('4.17') }) === '4.17');
check('an integer key claims no decimals', fmt.writtenDecimals('19') === undefined);
check('a decimal comma is read as a decimal here too', fmt.writtenDecimals('19,64') === 2);
check('a big number still groups', seen(fmt.formatNumber(5168000, '1 234,5')) === '5 168 000');
check('a negative number keeps its sign', fmt.formatNumber(-5.5, '1.234,5') === '-5,5');
check('infinity and NaN are not formatted into nonsense',
    fmt.formatNumber(Infinity, '1,234.5') === 'Infinity' && fmt.formatNumber(NaN, '1,234.5') === 'NaN');

// ---------------------------------------------------------------------------
section('display never decides whether an answer is right');

// The parser takes no preference at all, which is the structural guarantee —
// asserted by BEHAVIOUR here, and by the absence of any wiring below.
// Each case states the VALUE it must read as, not merely that the three agree:
// a parser that had been made to refuse a decimal comma outright returns null
// under every preference, which "they all agree" calls a pass. It did, once.
for (const [written, expected] of [['0.5', 0.5], ['0,5', 0.5], ['1 000', 1000], ['1,000.5', 1000.5], ['1.000,5', 1000.5]]) {
    fmt.setNumberPreference(fmt.AUTO);
    const auto = formats.parseNumber(written);
    fmt.setNumberPreference('1.234,5');
    const underComma = formats.parseNumber(written);
    fmt.setNumberPreference('1,234.5');
    const underPoint = formats.parseNumber(written);
    check(`${JSON.stringify(written)} is ${expected} under every display preference`,
        auto === expected && underComma === expected && underPoint === expected,
        `${auto} / ${underComma} / ${underPoint}`);
}
fmt.setNumberPreference(fmt.AUTO);
const parserSrc = readFileSync(join(repoRoot, 'src/components/answer/formats.ts'), 'utf8');
check('the parser does not import the display preference at all',
    !/numberFormat|NumberStyle|setNumberPreference/.test(parserSrc));

// ---------------------------------------------------------------------------
section('nothing falls back to the device locale');

// `.toLocaleString()` with no argument follows the OPERATING SYSTEM's regional
// settings. `locale.ts` settled years ago that the app follows the interface
// language instead; numbers were the half that never got converted.
const walk = (dir) => readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : (/\.tsx?$/.test(f) ? [p] : []);
});
const offenders = walk(join(repoRoot, 'src'))
    .map(p => relative(repoRoot, p).replace(/\\/g, '/'))
    // numberFormat.ts documents the bug it fixed, and says the words.
    .filter(p => p !== 'src/utils/numberFormat.ts')
    .filter(p => /\.toLocaleString\(\s*\)/.test(readFileSync(join(repoRoot, p), 'utf8')));
check('no surface formats a number or a date against the device locale',
    offenders.length === 0, offenders.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
