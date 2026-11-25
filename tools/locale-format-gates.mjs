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
import { roundTrips, serialiseLocale } from './lib/localeJson.mjs';

const localesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) passed++; else failed++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
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

// ── 2. Every locale file ──────────────────────────────────────────────────────
console.log('\nsrc/locales');
const files = readdirSync(localesDir).filter((f) => f.endsWith('.json')).sort();
check('there are locale files to check', files.length >= 2, `found ${files.length}`);
for (const f of files) {
    const text = readFileSync(join(localesDir, f), 'utf8');
    let detail = '';
    if (!roundTrips(text)) {
        let data = null;
        try { data = JSON.parse(text); } catch (err) { detail = `not JSON: ${err.message}`; }
        if (data) {
            const have = text.replace(/\r\n/g, '\n').split('\n');
            const want = serialiseLocale(data).split('\n');
            const at = have.findIndex((line, i) => line !== want[i]);
            detail = `line ${at + 1} is ${JSON.stringify((have[at] ?? '').slice(0, 70))}, the writer puts ${JSON.stringify((want[at] ?? '').slice(0, 70))} there. Fix: node tools/i18n-put.mjs --settle`;
        }
    }
    check(`${f} is in the writer's shape`, !detail, detail);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
