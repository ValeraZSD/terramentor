// The interface's translatable keys, read from the source itself.
//
// One collector, two readers: `i18n-extract.mjs` writes `en.json` from it after
// a rewrite, `i18n-gates.mjs` compares every locale against it. Keys are the
// first string argument of `t(…)`, `tr(…)` (the alias a file uses when it
// already binds `t`), `i18n.t(…)`, and `k(…)` — the no-op marker that tags a
// string in a module-level table so the render site can `t(row.label)` and
// this scan still sees the key.
//
// A key whose value carries a `count` option is plural: `en.json` carries it
// as `key_one` / `key_other` (i18next's suffixes, resolved with Intl.PluralRules
// per language), and other locales carry whichever forms their language has.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const KEY_CALL = /\b(?:t|tr|i18n\.t|k)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

/** Read a JS/TS string literal as written in source. */
export function unquote(lit) {
    if (lit[0] === '"') return JSON.parse(lit);
    // Single-quoted: convert to a JSON string.
    return JSON.parse(`"${lit.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
}

export function walkSources(dir, out = []) {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== 'locales') walkSources(p, out); }
        else if (/\.(tsx?|mjs|js)$/.test(f) && !/\.d\.ts$/.test(f)) out.push(p);
    }
    return out;
}

/**
 * Every key used under `srcDir`, with whether it is used with a `count`.
 * Returns Map<key, { plural: boolean, files: Set<string> }>.
 */
export function collectKeys(srcDir) {
    const keys = new Map();
    for (const file of walkSources(srcDir)) {
        const src = readFileSync(file, 'utf8');
        let m;
        KEY_CALL.lastIndex = 0;
        while ((m = KEY_CALL.exec(src))) {
            let key;
            try { key = unquote(m[1]); } catch { continue; }
            if (!key.trim()) continue;
            // Plural: the options object right after the key mentions `count`.
            const after = src.slice(m.index + m[0].length, m.index + m[0].length + 160);
            const plural = /^\s*,\s*\{[^}]*\bcount\b/.test(after);
            const entry = keys.get(key) || { plural: false, files: new Set() };
            entry.plural = entry.plural || plural;
            entry.files.add(file);
            keys.set(key, entry);
        }
    }
    return keys;
}

/** The plural suffixes a language distinguishes, per Intl.PluralRules. */
export function pluralCategories(lang) {
    try {
        return new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
    } catch {
        return ['one', 'other'];
    }
}

/** The entries `en.json` must hold for a key: itself, or its plural forms. */
export function englishEntries(key, plural) {
    if (!plural) return { [key]: key };
    return { [`${key}_one`]: key.replace(/\{\{count\}\}\s+(\w+?)s\b/, (m, w) => `{{count}} ${w}`), [`${key}_other`]: key };
}
