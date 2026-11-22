// tools/server-text-gates.mjs — the server's refusals, in the learner's language.
//
// Run:  node tools/server-text-gates.mjs
//
// The server calls no t(). A refusal a learner may read is sent as its English
// `error` plus the English template it was filled from (`messageKey`, the key
// in src/locales/en.json) and the values (`params`); the app renders
// t(messageKey, params) when the interface language holds the key, and the
// English `error` otherwise (server/clientError.js, src/utils/serverText.ts).
//
//   1. The helpers: `keyed`, `apiError`, `errorBody` on a KeyedError and on an
//      internal error, a module's KeyedError subclass, paths in params.
//   2. The real app on a scratch library: refusals a learner meets, named here
//      by the sentence they should read, arrive keyed, with `error` equal to
//      the key filled from the params, and every key is in en.json.
//   3. The collector (tools/lib/i18nKeys.mjs) reads those same sentences out of
//      the server source, and no setting name or code with them.
//   4. The client: serverText() in English, in a language holding the key, in
//      one without it, and with a plural key.

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'server-text-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';

const repo = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const show = (v) => JSON.stringify(v)?.slice(0, 240);

const en = JSON.parse(readFileSync(join(repo, 'src/locales/en.json'), 'utf8'));
const inEn = (key) => key in en || `${key}_other` in en;
// i18next's filling, written out here rather than borrowed from clientError.js.
const fill = (key, params = {}) => key.replace(/\{\{\s*(\w+)\s*\}\}/g, (slot, name) => (name in params ? String(params[name]) : slot));

const B = new URL('../server/', import.meta.url).href;
const { keyed, apiError, errorBody, statusError, KeyedError } = await import(B + 'clientError.js');

// ── 1. the helpers ───────────────────────────────────────────────────────────
console.log('\n--- the helpers ---');
{
    const a = keyed('Project not found');
    ok('keyed() with no values: the English is the key', a.error === 'Project not found' && a.messageKey === 'Project not found' && !('params' in a), show(a));

    const b = keyed('Password must be at least {{count}} characters', { count: 8 });
    ok('keyed() with values: error filled, key kept, values sent',
        b.error === 'Password must be at least 8 characters' && b.messageKey === 'Password must be at least {{count}} characters' && b.params?.count === 8, show(b));

    const c = apiError('retention must be a number from 0.7 to 0.97');
    ok('apiError() carries no key: a program reads it, not a learner', c.error === 'retention must be a number from 0.7 to 0.97' && !('messageKey' in c), show(c));

    const d = errorBody(statusError(404, 'No such connection'), 404);
    ok('a thrown statusError keeps its key through errorBody', d.messageKey === 'No such connection' && d.error === 'No such connection', show(d));

    const thrown = new KeyedError('Could not read {{file}}', { file: 'C:\\Users\\ana\\Documents\\notes.pdf' });
    const e = errorBody(Object.assign(thrown, { status: 400 }), 400);
    ok('a file path inside a param is replaced, in params and in the English',
        e.messageKey === 'Could not read {{file}}' && !/ana/.test(e.params?.file || 'ana') && !/ana/.test(e.error), show(e));

    // A key built from a template literal is filled text; one quoting a path
    // goes out as English with the path replaced, and carries no key.
    const filled = errorBody(Object.assign(new KeyedError('Invalid bundle: ENOENT open C:\\Users\\ana\\x.json'), { status: 400 }), 400);
    ok('a key that quotes a path is not sent: the English goes, path replaced',
        !/ana/.test(JSON.stringify(filled)) && !('messageKey' in filled) && /<path>/.test(filled.error || ''), show(filled));

    const realError = console.error;
    console.error = () => {};
    const sqlite = Object.assign(new Error('UNIQUE constraint failed: nodes.uuid'), { name: 'SqliteError', code: 'SQLITE_CONSTRAINT_UNIQUE' });
    const f = errorBody(sqlite, 500);
    console.error = realError;
    const ref = f.params?.ref;
    ok('an internal error is the fixed sentence, keyed, with its reference as a value',
        !!ref && inEn(f.messageKey) && f.error === fill(f.messageKey, f.params) && !/nodes\.uuid/.test(f.error), show(f));

    const { EditError } = await import(B + 'assistantEdits.js');
    const g = errorBody(new EditError(404, 'Topic not found'), 404);
    ok('a module\'s KeyedError subclass is sent with its key', g.messageKey === 'Topic not found' && g.error === 'Topic not found', show(g));

    const h = errorBody(Object.assign(new Error('Some English nobody keyed'), { status: 400 }), 400);
    ok('a plain Error still answers in its words, with no key to mistranslate', h.error === 'Some English nobody keyed' && !('messageKey' in h), show(h));
}

// ── 2. on the real app ───────────────────────────────────────────────────────
console.log('\n--- on the real app ---');
const MET = [
    // [what the learner did, method, path, body, status, the sentence they should read]
    ['opened a deck that is gone', 'GET', '/api/projects/987654/deck', null, 404, 'Project not found', {}],
    ['chose a password that is too short', 'POST', '/api/auth/setup', { password: 'ab' }, 400, 'Password must be at least {{count}} characters', null],
    ['changed a password when none is set', 'POST', '/api/auth/change', {}, 409, 'No password is set', {}],
    ['let the assistant add an empty card', 'POST', '/api/assistant/cards', {}, 400, 'A card needs a front and a back.', {}],
];
{
    const { default: db } = await import(B + 'database.js');
    const { createApp } = await import(B + 'app.js');
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const call = (method, path, body) => new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: json }); });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
    try {
        for (const [what, method, path, body, status, key] of MET) {
            const got = await call(method, path, body);
            const b = got.body || {};
            ok(`a learner who ${what} gets ${status}, keyed "${key}"`, got.status === status && b.messageKey === key, `${got.status} ${show(b)}`);
            ok('…its English is the key filled from its values', b.error === fill(key, b.params || {}) && !/\{\{/.test(b.error || '{{'), show(b));
            ok('…and en.json holds the key', inEn(key));
        }
    } finally {
        server.close();
        try { db.close(); } catch { /* closing a closed handle */ }
    }
}

// ── 3. the collector ─────────────────────────────────────────────────────────
console.log('\n--- the collector ---');
{
    const { collectServerKeys } = await import(pathToFileURL(join(repo, 'tools/lib/i18nKeys.mjs')).href);
    const keys = collectServerKeys(join(repo, 'server'));
    for (const [, , , , , key] of MET) ok(`the source scan finds "${key}"`, keys.has(key));
    ok('a {{count}} key is collected as plural', keys.get('Password must be at least {{count}} characters')?.plural === true);
    ok('a creation frame\'s messageKey is collected', keys.get('Reading {{count}} files')?.plural === true);
    const notKeys = ['ai_provider', 'notice-ai', 'time_zone', '...', 'Some English nobody keyed'];
    const leaked = notKeys.filter((s) => keys.has(s));
    ok('setting names, codes and comment text are not collected as keys', leaked.length === 0, leaked.join(', '));

    // A slot with no value renders as "{{name}}" in every language that has
    // the key. Every literal key with slots, passed with an object literal of
    // values, must name each slot in it (a spread `...x` is not read).
    const STR = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
    const SITE = new RegExp(String.raw`(?:\b(?:keyed|learnerError|KeyedError)\(\s*|\bstatusError\(\s*[^,()]+,\s*)${STR}\s*,\s*\{([^{}]*)\}`, 'g');
    const slotGaps = (src) => {
        const out = [];
        for (const m of src.matchAll(SITE)) {
            const key = m[1].slice(1, -1);
            const slots = [...key.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((s) => s[1]);
            if (!slots.length || /\.\.\./.test(m[2])) continue;
            const names = new Set([...m[2].matchAll(/(?:^|,)\s*(\w+)\s*(?=[:,]|$)/g)].map((n) => n[1]));
            const missing = slots.filter((s) => !names.has(s));
            if (missing.length) out.push({ key, missing, index: m.index });
        }
        return out;
    };
    const { readdirSync, statSync } = await import('node:fs');
    const walk = (dir, acc = []) => {
        for (const f of readdirSync(dir)) {
            const p = join(dir, f);
            if (statSync(p).isDirectory()) walk(p, acc); else if (f.endsWith('.js')) acc.push(p);
        }
        return acc;
    };
    const gaps = [];
    let sites = 0;
    for (const file of walk(join(repo, 'server'))) {
        const src = readFileSync(file, 'utf8');
        sites += [...src.matchAll(SITE)].length;
        for (const g of slotGaps(src)) gaps.push(`${file.slice(repo.length)}:${src.slice(0, g.index).split('\n').length} "${g.key}" lacks ${g.missing.join(', ')}`);
    }
    ok(`every slot in a key gets a value where it is sent (${sites} sites read)`, sites > 20 && gaps.length === 0, gaps.slice(0, 5).join(' | '));
    ok('…and the check fires on a slot named differently from its value',
        slotGaps(`keyed('Topic {{id}} not found', { nodeId: 7 })`).length === 1
        && slotGaps(`statusError(404, 'Topic {{id}} not found', { id: Math.max(a, b) })`).length === 0);
}

// ── 4. the client ────────────────────────────────────────────────────────────
console.log('\n--- serverText() in the app ---');
{
    const { build } = await import('esbuild');
    // Under node_modules so the bundle resolves `i18next` from the repo.
    const cache = join(repo, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const dir = mkdtempSync(join(cache, 'server-text-gates-'));
    const outfile = join(dir, 'serverText.mjs');
    try {
        await build({
            bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent', packages: 'external',
            stdin: {
                contents: `export { serverText } from './src/utils/serverText';\nexport { default as i18n } from './src/i18n';`,
                resolveDir: repo, loader: 'ts',
            },
        });
        const { serverText, i18n } = await import(pathToFileURL(outfile).href);
        await i18n.changeLanguage('en');

        ok('English shows the server\'s own sentence', serverText(keyed('Project not found')) === 'Project not found');
        ok('English picks the singular form of a plural key',
            serverText(keyed('Password must be at least {{count}} characters', { count: 1 })) === 'Password must be at least 1 character',
            serverText(keyed('Password must be at least {{count}} characters', { count: 1 })));
        ok('a body with no key shows its English', serverText({ error: 'retention must be a number from 0.7 to 0.97' }) === 'retention must be a number from 0.7 to 0.97');
        ok('no body, or no words, is nothing to show', serverText(null) === undefined && serverText('x') === undefined && serverText({ error: '' }) === undefined);

        i18n.addResourceBundle('de', 'translation', {
            'Topic {{id}} not found': 'Thema {{id}} nicht gefunden',
            'Attach at most {{count}} files at a time._one': 'Höchstens {{count}} Datei auf einmal anhängen.',
            'Attach at most {{count}} files at a time._other': 'Höchstens {{count}} Dateien auf einmal anhängen.',
        }, true, true);
        await i18n.changeLanguage('de');
        ok('a language holding the key shows it, filled from the values',
            serverText(keyed('Topic {{id}} not found', { id: 7 })) === 'Thema 7 nicht gefunden', serverText(keyed('Topic {{id}} not found', { id: 7 })));
        ok('…with the plural form its count asks for',
            serverText(keyed('Attach at most {{count}} files at a time.', { count: 3 })) === 'Höchstens 3 Dateien auf einmal anhängen.');
        ok('a language without the key shows the server\'s filled English, never the template',
            serverText(keyed('No such {{thing}} here', { thing: 'deck' })) === 'No such deck here');
        ok('a key that only looks like one (no locale has it) is the English as sent',
            serverText({ error: 'Node 12 not found', messageKey: 'Node {{id}} not found' }) === 'Node 12 not found');
        await i18n.changeLanguage('en');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
