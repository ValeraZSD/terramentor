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
//      separator is perfectly valid code. It covers DATES as well, and a
//      locale written out as `undefined` as well as one left off — the scan
//      read neither, which is what let a date blob keep the machine's
//      weekday names.

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
//
// THE RULE USED TO SEE ONLY HALF OF THAT. It tested `\.toLocaleString\(\s*\)`,
// so a call that OMITS the locale was caught and a call that spells it
// `undefined` was not — which is the same call, and is how
// `AssistantDrawer`'s date blobs kept printing their weekday and their long
// date in the machine's language under translated chrome. Dates were the other
// half it could not see: the bug has never been about numbers, so the rule now
// covers all three `toLocale*` formatters and both ways of not naming a locale.
const DEVICE_LOCALE_CALL = /\.toLocale(?:String|DateString|TimeString)\s*\(\s*(?:\)|undefined\s*[,)])/;

// Re-run against the shapes it was written for, and against the safe
// neighbours it must not flag — a source scan that has never been shown a
// positive is a regex nobody has proved reads anything.
const flags = (src) => DEVICE_LOCALE_CALL.test(src);
for (const [why, src] of [
    ['a bare .toLocaleString()', 'const s = n.toLocaleString();'],
    ['a bare .toLocaleDateString()', "const when = iso ? new Date(iso).toLocaleDateString() : '—';"],
    ['a bare .toLocaleTimeString()', 'return new Date(iso).toLocaleTimeString();'],
    ['whitespace inside the empty call', 'n.toLocaleString(  )'],
    ['an explicit undefined locale on a date, with options',
        "if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });"],
    ['an explicit undefined locale on a date, with nothing else', 'd.toLocaleDateString(undefined)'],
    ['an explicit undefined locale on a time', "d.toLocaleTimeString(undefined, { hour: '2-digit' })"],
    ['an explicit undefined locale on a number', 'n.toLocaleString(undefined, { maximumFractionDigits: 2 })'],
]) check(`the rule catches ${why}`, flags(src), src);
for (const [why, src] of [
    ['a locale is named', "d.toLocaleDateString(uiLocale(), { weekday: 'long' })"],
    ['a locale and a time zone', "d.toLocaleDateString(uiLocale(), { timeZone: 'UTC' })"],
    ['a literal language tag', "n.toLocaleString('en-US')"],
    ['a locale held in a variable', 'd.toLocaleTimeString(locale, opts)'],
    ['an undefined OPTION beside a named locale', 'n.toLocaleString(uiLocale(), undefined)'],
    ['Intl, which carries the locale itself', 'new Intl.DateTimeFormat(uiLocale(), opts).format(d)'],
    ['a longer method that merely starts the same way', 'd.toLocaleDateStringish()'],
]) check(`the rule leaves alone: ${why}`, !flags(src), src);

const walk = (dir) => readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : (/\.tsx?$/.test(f) ? [p] : []);
});
// numberFormat.ts documents the bug it fixed, and says the words.
const DOCUMENTED = ['src/utils/numberFormat.ts'];
// Empty, and asserted to be EXACT below: the scan fails both when a new offender
// appears and when a listed one is fixed without its entry going. An exemption
// nobody has to come back to is how a known bug becomes a permanent one. The
// last entry here was the FSRS panel's `when()` helper in Settings.tsx, which
// printed the date a parameter set was fitted against the machine's regional
// settings while every other date on that panel followed the interface language.
const KNOWN_OFFENDERS = [];
const offenders = walk(join(repoRoot, 'src'))
    .map(p => relative(repoRoot, p).replace(/\\/g, '/'))
    .filter(p => !DOCUMENTED.includes(p))
    .filter(p => DEVICE_LOCALE_CALL.test(readFileSync(join(repoRoot, p), 'utf8')));
const fresh = offenders.filter(p => !KNOWN_OFFENDERS.includes(p));
check('no surface formats a number or a date against the device locale',
    fresh.length === 0, fresh.join(', '));
const settled = KNOWN_OFFENDERS.filter(p => !offenders.includes(p));
check('the known-offender list names nothing that is already fixed',
    settled.length === 0, settled.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
