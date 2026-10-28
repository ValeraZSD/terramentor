/**
 * Which settings rows the SERVER names in its source, found by the shapes the
 * code actually uses to reach the `settings` table. Shared by
 * settings-registry-gates.mjs, which holds every name found here to the
 * registry in server/settingsSchema.js, so a row added without an entry there
 * fails the build instead of quietly becoming writable by a client.
 *
 * Static on purpose: no route has to run for its key to be seen. The price is
 * that a NEW shape of read is invisible, so the gate also checks that this
 * finds every key on a fixed list (`MUST_FIND`) — an extractor that stops
 * matching after a refactor fails there rather than passing on an empty set.
 *
 * Keys built at run time (`deck_new_per_day_${id}`) are reported by their
 * literal prefix with a trailing `*`.
 */
import { readFileSync, globSync } from 'node:fs';
import path from 'node:path';

const KEY = '[a-z][a-zA-Z0-9_]*';

/** Each pattern's first group is a key (or a quoted list of keys for `IN`). */
const SHAPES = [
    // getSetting('x'), readSetting('x'), setSettingValue('x', …), settingStmt('x')
    new RegExp(`\\b\\w*[sS]etting\\w*\\(\\s*'(${KEY})'`, 'g'),
    // SQL: key = 'x'   key LIKE 'x%'
    new RegExp(`\\bkey\\s*(?:=|LIKE)\\s*'(${KEY})%?'`, 'g'),
    // SQL: VALUES ('x', ?)
    new RegExp(`INTO settings \\(key, value\\) VALUES \\('(${KEY})'`, 'g'),
    // SQL: key IN ('a', 'b')
    /\bkey IN \(((?:\s*'[a-zA-Z0-9_]+'\s*,?)+)\)/g,
    // const INBOX_SETTING = 'x';  const DISMISSED_KEY = 'x';
    new RegExp(`const [A-Z_]*(?:SETTING|KEY)[A-Z_]* = '(${KEY})'`, 'g'),
    // getAISettings and friends: s.key === 'x'   r.key === 'x'   (a row, not a connection kind's `k.key`)
    new RegExp(`\\b(?:s|r|row)\\.key === '(${KEY})'`, 'g'),
    // const FEED_SETTING_KEYS = { focusTotal: 'feed_focus_total', … }
    /const [A-Z_]*SETTING_KEYS = \{([^}]*)\}/g,
    // a settings statement asked for one key: prepare('… FROM settings …').get('x')
    new RegExp(`FROM settings[^\\n]*\\.get\\('(${KEY})'\\)`, 'g'),
    // a key built at run time: `deck_new_per_day_${id}`
    /[`]([a-z][a-zA-Z0-9_]*_)\$\{/g,
];

/** A statement on the settings table, from `prepare(` to the end of the
 *  statement: the key is then the first argument it is run with, written out
 *  or named by a constant (`.run(OPENAI_ADDRESS_MIGRATION)`). */
const SETTINGS_STATEMENT = /prepare\(\s*[`'"][^`'"]*\bsettings\b[\s\S]*?;/g;
const STATEMENT_ARG = /\.(?:get|run|all)\(\s*(?:'([a-z][a-zA-Z0-9_]*)'|([A-Z][A-Z0-9_]*)\b)/g;
/** A statement kept in a variable and run later: `const insertSetting = db.prepare('… settings …')`. */
const NAMED_STATEMENT = /(?:const|let)\s+(\w+)\s*=\s*db\.prepare\(\s*[`'"][^`'"]*\bsettings\b/g;

/** Lines that are about settings rows at all: the run-time shape above would
 *  otherwise collect every template string in the server. */
const TEMPLATE_CONTEXT = /settings|Setting|SETTING|\bkey\b/;

const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));

/**
 * @param {string} root  the repository root
 * @param {string[]} [globs]  server sources to read
 * @returns {Map<string, string[]>}  key → the files naming it (`prefix*` for a built key)
 */
export function settingKeysInServer(root, globs = ['server/*.js', 'server/routes/*.js']) {
    const found = new Map();
    const add = (key, file) => {
        if (!found.has(key)) found.set(key, []);
        if (!found.get(key).includes(file)) found.get(key).push(file);
    };
    const files = globs.flatMap((g) => globSync(g, { cwd: root })).map((f) => f.replace(/\\/g, '/')).sort();
    for (const file of files) {
        const src = stripComments(readFileSync(path.join(root, file), 'utf8'));
        if (!/settings|Setting/.test(src)) continue;
        for (const [i, shape] of SHAPES.entries()) {
            for (const m of src.matchAll(shape)) {
                if (i === SHAPES.length - 1) {
                    const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
                    if (TEMPLATE_CONTEXT.test(line)) add(`${m[1]}*`, file);
                    continue;
                }
                if (m[1].includes("'")) {
                    for (const k of m[1].match(/'([a-zA-Z0-9_]+)'/g)) add(k.slice(1, -1), file);
                } else add(m[1], file);
            }
        }
        // String constants in this file, to resolve a key passed by name.
        const constants = new Map([...src.matchAll(/(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*=\s*'([a-z][a-zA-Z0-9_]*)'/g)].map(m => [m[1], m[2]]));
        const argsOf = (text) => {
            for (const m of text.matchAll(STATEMENT_ARG)) {
                const key = m[1] ?? constants.get(m[2]);
                if (key) add(key, file);
            }
        };
        for (const m of src.matchAll(SETTINGS_STATEMENT)) argsOf(m[0]);
        for (const m of src.matchAll(NAMED_STATEMENT)) {
            const runs = new RegExp(`\\b${m[1]}(\\.(?:get|run|all)\\([^)]*)`, 'g');
            for (const r of src.matchAll(runs)) argsOf(r[1]);
        }
    }
    return found;
}
