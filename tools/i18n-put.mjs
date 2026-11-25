#!/usr/bin/env node
/**
 * Add or change keys in the locale files without churning them.
 *
 * A locale file is 2,000 sorted lines, and re-serialising one with a different
 * writer rewrites every line — the real edit then hides inside a 5,700-line
 * diff nobody can review. So this writes with the one locale writer,
 * `tools/lib/localeJson.mjs` (2-space indent, keys sorted by
 * `localeCompare(…, 'en')`, trailing newline), and refuses to touch a file that
 * does not already round-trip to itself: if rewriting a file unchanged would
 * move a line, that is a formatting difference to settle first, not something
 * to bulldoze inside an unrelated edit.
 *
 *   node tools/i18n-put.mjs <patch.json>
 *
 * The patch is { "<locale>": { "<key>": "<value>", … }, … }. A null value
 * DELETES the key. Prints one line per file: added, changed, removed.
 *
 *   node tools/i18n-put.mjs --settle
 *
 * rewrites, in that shape, every locale file that does not round-trip (a key
 * pasted in by hand), changing no key or value. `tools/locale-format-gates.mjs`
 * fails until it has run.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundTrips, serialiseLike } from './lib/localeJson.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(here, '..', 'src', 'locales');

const patchPath = process.argv[2];
if (!patchPath) { process.stdout.write('usage: node tools/i18n-put.mjs <patch.json> | --settle\n'); process.exit(2); }

// --settle: rewrite every locale file that does not round-trip, keys and values
// unchanged, so the patch mode can edit it. Refuses a file whose rewrite would
// lose an entry: JSON.parse keeps only the last of two equal keys, and the
// files are flat, one `  "key": "value"` line per entry.
if (patchPath === '--settle') {
    let refused = 0;
    for (const f of readdirSync(localesDir).filter((n) => n.endsWith('.json')).sort()) {
        const file = join(localesDir, f);
        const before = readFileSync(file, 'utf8');
        if (roundTrips(before)) continue;
        const data = JSON.parse(before);
        const lines = before.split(/\r?\n/).filter((l) => /^ {2}"/.test(l)).length;
        if (lines !== Object.keys(data).length) {
            process.stdout.write(`FAIL  ${f}  ${lines} entry lines but ${Object.keys(data).length} keys: a key appears twice, settle it by hand\n`);
            refused++;
            continue;
        }
        writeFileSync(file, serialiseLike(data, before));
        process.stdout.write(`ok    ${f}  rewritten sorted, ${Object.keys(data).length} keys\n`);
    }
    process.exit(refused ? 1 : 0);
}

const patch = JSON.parse(readFileSync(patchPath, 'utf8'));

let failed = 0;
for (const [locale, entries] of Object.entries(patch)) {
    const file = join(localesDir, `${locale}.json`);
    const before = readFileSync(file, 'utf8');
    const data = JSON.parse(before);

    // Round-trip first: this writer must already be this file's writer.
    if (!roundTrips(before)) {
        process.stdout.write(`FAIL  ${locale}.json does not round-trip through this writer — settle the formatting first\n`);
        failed++;
        continue;
    }

    let added = 0; let changed = 0; let removed = 0;
    for (const [key, value] of Object.entries(entries)) {
        if (value === null) { if (key in data) { delete data[key]; removed++; } continue; }
        if (!(key in data)) { data[key] = value; added++; }
        else if (data[key] !== value) { data[key] = value; changed++; }
    }
    const after = serialiseLike(data, before);
    if (after !== before) writeFileSync(file, after);
    process.stdout.write(`ok    ${locale}.json  +${added} ~${changed} -${removed}\n`);
}
process.exit(failed ? 1 : 0);
