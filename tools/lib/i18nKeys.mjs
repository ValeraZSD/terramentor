// The interface's translatable keys, read from the source itself.
//
// One collector, three readers: `i18n-extract.mjs` and `i18n-sync-en.mjs` write
// `en.json` from it, `i18n-gates.mjs` compares every locale against it. The
// server's message keys are read too (`collectServerKeys`), so the list is the
// app's, not only the interface's (`collectAppKeys`). Keys are the
// first string argument of `t(…)`, `tr(…)` (the alias a file uses when it
// already binds `t`), `i18n.t(…)`, and `k(…)` — the no-op marker that tags a
// string in a module-level table so the render site can `t(row.label)` and
// this scan still sees the key.
//
// A key whose value carries a `count` option is plural: `en.json` carries it
// as `key_one` / `key_other` (i18next's suffixes, resolved with Intl.PluralRules
// per language), and other locales carry whichever forms their language has.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

const STRING = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;

/**
 * The server's message keys (server/clientError.js). The server calls no
 * `t()`: a sentence a person may read is sent as `messageKey` + `params`
 * beside its English, and the app translates it. A key is the first quoted
 * string of `k(…)`, `keyed(…)`, `learnerError(…)`, `new KeyedError(…)` or of a
 * class that extends it (after a leading status, as in `new EditError(404, …)`),
 * the second of `statusError(status, …)`, the first of a file's own helper
 * written `const bad = (key, params) => …`, and a quoted `messageKey: '…'`
 * (a creation frame's progress line).
 * A key holding `{{count}}` is plural: the server fills it with a count.
 * Template literals are not keys: their English is sent as is.
 */
export function collectServerKeys(serverDir) {
    const sources = new Map(walkSources(serverDir).map((f) => [f, readFileSync(f, 'utf8')]));
    const classes = new Set(['KeyedError']);
    for (let grew = true; grew;) {
        grew = false;
        for (const src of sources.values()) {
            for (const m of src.matchAll(/\bclass\s+(\w+)\s+extends\s+(\w+)/g)) {
                if (classes.has(m[2]) && !classes.has(m[1])) { classes.add(m[1]); grew = true; }
            }
        }
    }
    const keys = new Map();
    for (const [file, src] of sources) {
        const helpers = new Set(['k', 'keyed', 'learnerError']);
        for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*\(\s*key\s*,\s*params\s*\)\s*=>/g)) helpers.add(m[1]);
        // Not a method (`x.k(…)`); a spread (`...keyed(…)`) is a call.
        const call = new RegExp(String.raw`(?:(?<![\w$])(?<![\w$)\]]\.)(?:${[...helpers].join('|')})\(\s*|\bstatusError\(\s*[^,()]+,\s*|\bnew\s+(?:${[...classes].join('|')})\(\s*(?:[\w.]+\s*,\s*)?|\bmessageKey:\s*)${STRING}`, 'g');
        for (const m of src.matchAll(call)) {
            let key;
            try { key = unquote(m[1]); } catch { continue; }
            if (!key.trim()) continue;
            const entry = keys.get(key) || { plural: false, files: new Set() };
            entry.plural = entry.plural || /\{\{\s*count\s*\}\}/.test(key);
            entry.files.add(file);
            keys.set(key, entry);
        }
    }
    return keys;
}

/** Every key the app uses: the interface's (`src/`) and the server's message keys (`server/`). */
export function collectAppKeys(root) {
    const keys = collectKeys(join(root, 'src'));
    // A fixture tree (tools/tsx-ast-gates.mjs) has no server; nothing to add.
    const serverDir = join(root, 'server');
    if (!existsSync(serverDir)) return keys;
    for (const [key, entry] of collectServerKeys(serverDir)) {
        const have = keys.get(key);
        if (!have) { keys.set(key, entry); continue; }
        have.plural = have.plural || entry.plural;
        for (const f of entry.files) have.files.add(f);
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
