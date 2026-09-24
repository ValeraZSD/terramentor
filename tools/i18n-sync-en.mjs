#!/usr/bin/env node
/**
 * Bring `en.json` back in step with the source WITHOUT rewriting any source.
 *
 * `tools/i18n-extract.mjs` does this as a side effect of its real job — walking
 * every file and wrapping untranslated copy in `t(…)`. That is the wrong tool
 * to reach for in the middle of a refactor: it rewrites sources, and it drops
 * keys a branch is still using. This one only reads the source and edits
 * en.json: it adds the entries new keys need (a plural key gets `_one`/`_other`
 * seeded from the key itself) and, with `--prune`, removes entries no call site
 * asks for any more.
 *
 *   node tools/i18n-sync-en.mjs            report
 *   node tools/i18n-sync-en.mjs --write    add missing entries
 *   node tools/i18n-sync-en.mjs --write --prune   also drop orphans
 *
 * Orphaned keys in the OTHER locales are a separate chore — print them with
 * `node tools/i18n-gates.mjs`; they are removed by hand, because a reworded key
 * usually wants its old translation carried across rather than deleted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectKeys, englishEntries } from './lib/i18nKeys.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcDir = join(root, 'src');
const file = join(srcDir, 'locales', 'en.json');

const write = process.argv.includes('--write');
const prune = process.argv.includes('--prune');

const keys = collectKeys(srcDir);
const wanted = new Map();
for (const [key, { plural }] of keys) {
    for (const [k, v] of Object.entries(englishEntries(key, plural))) wanted.set(k, v);
}

const raw = readFileSync(file, 'utf8');
const en = JSON.parse(raw);
const missing = [...wanted.keys()].filter((k) => !(k in en));
const orphans = Object.keys(en).filter((k) => !wanted.has(k));

for (const k of missing) process.stdout.write(`  + ${JSON.stringify(k)}\n`);
for (const k of orphans) process.stdout.write(`  - ${JSON.stringify(k)}\n`);

if (write) {
    for (const k of missing) en[k] = wanted.get(k);
    if (prune) for (const k of orphans) delete en[k];
    const sorted = Object.fromEntries(
        Object.keys(en).sort((a, b) => a.localeCompare(b, 'en')).map((k) => [k, en[k]]),
    );
    // Written back in the ending the file already has, as `i18n-put.mjs` does:
    // the working tree is CRLF on Windows, and an LF rewrite turned en.json
    // into the one LF file among twelve (2026-09-23) — invisible in `git diff`
    // under autocrlf, announced only by a new "LF will be replaced" warning.
    const text = `${JSON.stringify(sorted, null, 2)}\n`;
    writeFileSync(file, raw.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
}

process.stdout.write(`\n${missing.length} missing, ${orphans.length} orphaned${write ? ` — en.json written${prune ? ' (pruned)' : ''}` : ' (report only; pass --write)'}\n`);
