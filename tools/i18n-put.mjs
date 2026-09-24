#!/usr/bin/env node
/**
 * Add or change keys in the locale files without churning them.
 *
 * A locale file is 2,000 sorted lines, and re-serialising one with a different
 * writer rewrites every line — the real edit then hides inside a 5,700-line
 * diff nobody can review. So this writes with EXACTLY the shape
 * `tools/i18n-extract.mjs` writes (2-space indent, keys sorted by
 * `localeCompare(…, 'en')`, trailing newline) and refuses to touch a file that
 * does not already round-trip to itself: if rewriting a file unchanged would
 * move a line, that is a formatting difference to settle first, not something
 * to bulldoze inside an unrelated edit.
 *
 *   node tools/i18n-put.mjs <patch.json>
 *
 * The patch is { "<locale>": { "<key>": "<value>", … }, … }. A null value
 * DELETES the key. Prints one line per file: added, changed, removed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(here, '..', 'src', 'locales');

const serialise = (obj) => {
    const sorted = Object.fromEntries(
        Object.keys(obj).sort((a, b) => a.localeCompare(b, 'en')).map((k) => [k, obj[k]]),
    );
    return `${JSON.stringify(sorted, null, 2)}\n`;
};

/**
 * The line ENDING is not a formatting difference to settle.
 *
 * This repo's working tree is CRLF on Windows (git normalises on checkout), and
 * the round-trip guard below compared a CRLF file against an LF rewrite — so
 * every locale failed the guard and the tool that exists to edit them in place
 * could not edit any of them. The guard is about key order and indentation;
 * endings are compared with, and written back in, whatever the file already uses.
 */
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const withEol = (text, eol) => (eol === '\n' ? text : text.replace(/\n/g, eol));
const sameShape = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

const patchPath = process.argv[2];
if (!patchPath) { process.stdout.write('usage: node tools/i18n-put.mjs <patch.json>\n'); process.exit(2); }
const patch = JSON.parse(readFileSync(patchPath, 'utf8'));

let failed = 0;
for (const [locale, entries] of Object.entries(patch)) {
    const file = join(localesDir, `${locale}.json`);
    const before = readFileSync(file, 'utf8');
    const data = JSON.parse(before);

    // Round-trip first: this writer must already be this file's writer.
    if (!sameShape(serialise(data), before)) {
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
    const after = withEol(serialise(data), eolOf(before));
    if (after !== before) writeFileSync(file, after);
    process.stdout.write(`ok    ${locale}.json  +${added} ~${changed} -${removed}\n`);
}
process.exit(failed ? 1 : 0);
