#!/usr/bin/env node
/**
 * Every file in `src/locales/` is in the one shape the locale writer writes.
 *
 * The shape is `tools/lib/localeJson.mjs`: 2-space indent, keys sorted by
 * `localeCompare(…, 'en')`, a trailing newline. A key pasted in by hand at the
 * top of a file breaks it in two ways: `tools/i18n-put.mjs` refuses the file
 * from then on, and every other branch that adds a key by hand puts its key on
 * the same lines, so two such branches conflict in every locale they touch.
 * In sorted order each new key lands where it sorts, and two branches adding
 * different keys change different lines.
 *
 * The check: each file comes back byte for byte through the writer (line
 * endings aside: git checks the files out with CRLF on Windows). The first
 * assertions hold the check itself to examples written out by hand.
 *
 *   node tools/locale-format-gates.mjs
 *
 * Fix a failing file with `node tools/i18n-put.mjs --settle`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneLinePerKey, roundTrips, serialiseLocale } from './lib/localeJson.mjs';

const localesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) passed++; else failed++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/** null when the text is in the writer's shape, else what is wrong with it. */
function shapeProblem(text) {
    if (roundTrips(text)) return null;
    let data;
    try { data = JSON.parse(text); } catch (err) { return `not JSON: ${err.message}`; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return `not a JSON object: ${JSON.stringify(text.trim().slice(0, 40))}`;
    }
    const have = text.replace(/\r\n/g, '\n').split('\n');
    const want = serialiseLocale(data).split('\n');
    // Over the longer of the two: a missing last newline differs only past the end of `have`.
    const at = Array.from({ length: Math.max(have.length, want.length) }, (_, i) => i).find((i) => have[i] !== want[i]) ?? 0;
    const fix = 'Fix: node tools/i18n-put.mjs --settle';
    if (at >= have.length) return `the file ends after line ${have.length}; the writer ends it with a newline. ${fix}`;
    return `line ${at + 1} is ${JSON.stringify((have[at] ?? '').slice(0, 70))}, the writer puts ${JSON.stringify((want[at] ?? '').slice(0, 70))} there. Fix: node tools/i18n-put.mjs --settle`;
}

// ── 1. The check itself, against texts written out by hand ────────────────────
console.log('the round-trip check');
check('a sorted file round-trips', roundTrips('{\n  "Apple": "a",\n  "banana": "b",\n  "Cherry": "c"\n}\n'));
check('the same file with CRLF endings round-trips', roundTrips('{\r\n  "Apple": "a",\r\n  "banana": "b",\r\n  "Cherry": "c"\r\n}\r\n'));
check('a key added at the top does not', !roundTrips('{\n  "Written by AI": "w",\n  "Apple": "a",\n  "banana": "b"\n}\n'));
check('4-space indent does not', !roundTrips('{\n    "Apple": "a"\n}\n'));
check('no trailing newline does not', !roundTrips('{\n  "Apple": "a"\n}'));
check('a key twice does not', !roundTrips('{\n  "Apple": "a",\n  "Apple": "b"\n}\n'));
check('text that is not JSON does not', !roundTrips('{\n  "Apple": "a",\n}\n'));
check('the writer sorts case-blind, as localeCompare does',
    serialiseLocale({ b: '2', A: '1', 'a {{count}}': '3' }) === '{\n  "A": "1",\n  "a {{count}}": "3",\n  "b": "2"\n}\n');
for (const text of ['false', '0', '""', 'null', '[]']) {
    check(`a file holding only ${text} is refused`, shapeProblem(text) !== null);
}
check('a sorted file has no problem', shapeProblem('{\n  "Apple": "a"\n}\n') === null);

console.log('\nthe one-entry-per-line check (what --settle and the merge driver rely on)');
const entryCheck = (text) => oneLinePerKey(text, JSON.parse(text));
check('one entry per line passes', entryCheck('{\n  "Apple": "a",\n  "banana": "b"\n}\n'));
check('a value holding "x": is not taken for a key', entryCheck('{\n  "Apple": "say \\"x\\": then go",\n  "banana": "b"\n}\n'));
check('a key written twice is refused', !entryCheck('{\n  "a": "first",\n  "a": "last"\n}\n'));
check('two entries on one line plus a repeated key is refused (the counts alone match)',
    !entryCheck('{\n  "a": "first", "b": "bee",\n  "a": "last"\n}\n'));
check('two entries on one line are refused', !entryCheck('{\n  "a": "1", "b": "2"\n}\n'));

// ── 2. Every locale file ──────────────────────────────────────────────────────
console.log('\nsrc/locales');
const files = readdirSync(localesDir).filter((f) => f.endsWith('.json')).sort();
check('there are locale files to check', files.length >= 2, `found ${files.length}`);
for (const f of files) {
    const text = readFileSync(join(localesDir, f), 'utf8');
    const problem = shapeProblem(text);
    check(`${f} is in the writer's shape`, problem === null, problem ?? '');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
