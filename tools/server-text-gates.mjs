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
//   2b. Text the server keeps and shows later, made on the same app: a task
//      that failed (its dock line and its failure record), a course creation
//      that failed (its error line, the record's copy, its dock task), a file
//      the vault could not read (the stored row, read back later, and a file
//      dropped into New course), the last update check's failure; and refusals
//      built outside a route (a link's safety check, a search address, a
//      project's fields). Each row keeps its key beside its English.
//   3. The collector (tools/lib/i18nKeys.mjs) reads those same sentences out of
//      the server source, and no setting name or code with them.
//   4. The client: serverText() in English, in a language holding the key, in
//      one without it, and with a plural key; then every row from 2b, rendered
//      the way its screen renders it, in German from the real de.json.

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'server-text-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';
// The model settings are this library's rows, never a shell's overrides
// (server/ai.js getAISettings reads these last).
for (const name of ['AI_PROVIDER', 'AI_BASE_URL', 'AI_OLLAMA_URL', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY']) delete process.env[name];

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
// Rows the server kept, read back the way a screen reads them, rendered in
// section 4: [what it is, its shape, the row, the key it must carry].
// `line` = { error, errorKey, errorParams } (a dock line, a run's error line,
// the update check); `record` = a failure record { message, messageKey,
// params }; `body` = { error, messageKey, params } (a document, a staged file).
const STORED = [];
const URL_SCHEME = 'This link starts with {{scheme}}; only http and https links can be saved.';
const OLLAMA_DOWN = 'Ollama is not running at {{url}}. Please start Ollama first.';
{
    const { default: db } = await import(B + 'database.js');
    const { createApp } = await import(B + 'app.js');
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const send = (method, path, headers, payload) => new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, Host: `127.0.0.1:${port}` } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: json, text }); });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
    const call = (method, path, body) => send(method, path, { 'Content-Type': 'application/json' }, body ? JSON.stringify(body) : null);
    // One file, as the vault's upload field sends it.
    const upload = (path, fields, filename, bytes) => {
        const boundary = `----gate${Date.now()}`;
        const parts = [
            ...Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ];
        const payload = Buffer.concat([Buffer.from(parts.join('')), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
        return send('POST', path, { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, payload);
    };
    const frames = (text) => text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
    const taskList = async () => { const b = (await call('GET', '/api/tasks')).body; return Array.isArray(b) ? b : b?.tasks || []; };
    try {
        for (const [what, method, path, body, status, key] of MET) {
            const got = await call(method, path, body);
            const b = got.body || {};
            ok(`a learner who ${what} gets ${status}, keyed "${key}"`, got.status === status && b.messageKey === key, `${got.status} ${show(b)}`);
            ok('…its English is the key filled from its values', b.error === fill(key, b.params || {}) && !/\{\{/.test(b.error || '{{'), show(b));
            ok('…and en.json holds the key', inEn(key));
        }

        console.log('\n--- text the server keeps and shows later ---');
        const { setSettingValue } = await import(B + 'settingsStore.js');
        const project = (await call('POST', '/api/projects', { name: 'Stored text' })).body;
        const node = (await call('POST', '/api/nodes', { project_id: project?.id, title: 'Light' })).body;
        ok('a project and a topic to fail on', !!project?.id && !!node?.id, show(node));

        // A task that fails: cards asked for while AI is switched off.
        setSettingValue('ai_enabled', 'false');
        await call('POST', '/api/ai/flashcards/stream', { nodeId: node.id });
        const cards = (await taskList()).find((t) => t.kind === 'flashcards');
        ok('the cards task failed', cards?.status === 'error', show(cards));
        STORED.push(['a failed task\'s line in the dock', 'line', cards, 'AI features are disabled']);
        STORED.push(['…its failure record', 'record', cards?.failure, 'AI features are disabled']);

        // A creation that fails: a model address nothing listens on, the way a
        // learner's run fails when Ollama is not started.
        const closed = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
        setSettingValue('ai_enabled', 'true');
        setSettingValue('ai_provider', 'ollama');
        setSettingValue('ai_ollama_url', `http://127.0.0.1:${closed}`);
        setSettingValue('ai_model', 'm');
        const stream = frames((await call('POST', '/api/ai/create-project', { name: 'Stored run' })).text);
        const errorFrame = stream.find((f) => f.phase === 'error');
        ok('the creation run failed on its stream', !!errorFrame, show(stream.at(-1)));
        STORED.push(['a failed creation\'s error frame', 'line', errorFrame, OLLAMA_DOWN]);
        const run = ((await call('GET', '/api/ai/creation-status')).body?.generations || []).find((g) => g.name === 'Stored run');
        ok('…and is kept for a page that reattaches', run?.outcome === 'error', show(run));
        STORED.push(['a failed creation\'s error line, read back', 'line', run, OLLAMA_DOWN]);
        STORED.push(['…the failure copy beside it', 'record', run?.failure, OLLAMA_DOWN]);
        STORED.push(['…and its task in the dock', 'line', (await taskList()).find((t) => t.kind === 'create_project'), OLLAMA_DOWN]);

        // A file the vault cannot read, then read back on a later visit.
        const notPdf = Buffer.from('plain words, not a PDF');
        const uploaded = await upload('/api/documents/upload', { projectId: project.id }, 'notes.pdf', notPdf);
        STORED.push(['a file the vault could not read, as answered', 'body', uploaded.body?.documents?.[0], 'File does not look like a valid PDF.']);
        const listed = (await call('GET', `/api/documents?projectId=${project.id}`)).body;
        STORED.push(['…and on a later visit', 'body', (Array.isArray(listed) ? listed : listed?.documents || []).find((d) => d.status === 'failed'), 'File does not look like a valid PDF.']);
        const staged = await upload('/api/documents/staged', {}, 'notes.pdf', notPdf);
        STORED.push(['a file dropped into New course that cannot be read', 'body', staged.body?.documents?.[0], 'File does not look like a valid PDF.']);

        // The last update check's failure, as the poll stores it.
        setSettingValue('update_last_error', 'GitHub responded 403');
        STORED.push(['the last update check\'s failure', 'line', (await call('GET', '/api/updates')).body, 'GitHub responded {{status}}']);

        for (const [what, shape, row, key] of STORED) {
            const [text, gotKey, params] = shape === 'line' ? [row?.error, row?.errorKey, row?.errorParams]
                : shape === 'record' ? [row?.message, row?.messageKey, row?.params] : [row?.error, row?.messageKey, row?.params];
            ok(`${what} keeps "${key}" beside its English`, gotKey === key && text === fill(key, params || {}), show(row));
        }

        // Refusals built outside a route: a module's result, a field check.
        const OUTSIDE = [
            ['saved a link that runs script', 'POST', '/api/resources', { node_id: node.id, title: 'x', url: 'javascript:alert(1)' }, URL_SCHEME],
            ['added a search address over plain http', 'POST', '/api/search-providers',
                { id: 'mine', kind: 'search_provider', label: 'Mine', urlTemplate: 'http://example.com/?q={query}' }, 'urlTemplate must use https'],
            ['pasted a search provider with a made-up kind', 'POST', '/api/search-providers', { id: 'mine', kind: 'plugin', label: 'Mine' }, 'kind must be one of: {{kinds}}'],
            ['named a project with spaces only', 'POST', '/api/projects', { name: '   ' }, 'A project needs a name'],
            // A program's mistakes are answered in English and carry no key:
            // no screen sends them, so no learner reads them.
            ['(a program) sent a description that is not text', 'POST', '/api/projects', { name: 'x', description: 5 }, null],
            ['(a program) sent topic notes that are not text', 'POST', '/api/nodes', { project_id: project.id, title: 'x', notes: 5 }, null],
        ];
        for (const [what, method, path, body, key] of OUTSIDE) {
            const got = await call(method, path, body);
            const b = got.body || {};
            if (key === null) { ok(`${what}: 400, English, no key`, got.status === 400 && typeof b.error === 'string' && !('messageKey' in b), `${got.status} ${show(b)}`); continue; }
            ok(`a learner who ${what} gets 400, keyed "${key}"`, got.status === 400 && b.messageKey === key && b.error === fill(key, b.params || {}), `${got.status} ${show(b)}`);
            ok('…and en.json holds the key', inEn(key));
        }

        // Every form the update check can fail in (server/version.js, which may
        // import Node built-ins only) is keyed where it is read, or is one the
        // panel already says as "could not reach GitHub".
        const { updateErrorBody } = await import(B + 'updatePoll.js');
        const versionSrc = readFileSync(join(repo, 'server/version.js'), 'utf8');
        const fetchSrc = versionSrc.slice(versionSrc.indexOf('function fetchLatestRelease'));
        const forms = [...fetchSrc.slice(0, fetchSrc.indexOf('\n}\n')).matchAll(/error:\s*(['"`])((?:(?!\1).)*)\1/g)].map((m) => m[2].replace(/\$\{[^}]*\}/g, '403'));
        const offline = /fetch failed|timed out|ENOTFOUND|ECONN|EAI_AGAIN|network/i; // src/components/update/updateView.ts isOfflineError
        const unkeyed = forms.filter((text) => { const b = typeof updateErrorBody === 'function' ? updateErrorBody(text) : {}; return !(b.messageKey && inEn(b.messageKey) && b.error === text) && !offline.test(text); });
        ok(`every update-check failure in version.js is keyed or said as offline (${forms.length} read)`, forms.length >= 4 && unkeyed.length === 0, unkeyed.join(' | '));
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
                contents: `export * from './src/utils/serverText';\nexport { default as i18n } from './src/i18n';`,
                resolveDir: repo, loader: 'ts',
            },
        });
        const { serverText, storedError, failureMessage, i18n } = await import(pathToFileURL(outfile).href);
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

        // The rows the server kept (section 2b), each rendered by the helper its
        // screen uses, in German from the shipped de.json.
        console.log('\n--- what the server kept, in German ---');
        const de = JSON.parse(readFileSync(join(repo, 'src/locales/de.json'), 'utf8'));
        i18n.addResourceBundle('de', 'translation', de, true, true);
        ok('the client renders a kept line and a failure record (storedError, failureMessage)',
            typeof storedError === 'function' && typeof failureMessage === 'function');
        const render = { line: storedError, record: failureMessage, body: serverText };
        for (const [what, shape, row, key] of STORED) {
            const params = (shape === 'line' ? row?.errorParams : row?.params) || {};
            const german = typeof de[key] === 'string' ? fill(de[key], params) : null;
            const shown = typeof render[shape] === 'function' ? render[shape](row) : undefined;
            ok(`${what} reads in German`, !!german && german !== fill(key, params) && shown === german, `${show(shown)} ≠ ${show(german)}`);
        }
        await i18n.changeLanguage('en');
        const [, , firstLine] = STORED[0] || [];
        ok('…and in English, the sentence the server wrote', !!firstLine && storedError?.(firstLine) === firstLine.error, show(firstLine));
        ok('a line with no key, or none at all, is its English or nothing',
            storedError?.({ error: 'Failed' }) === 'Failed' && storedError?.({ error: null }) === undefined && failureMessage?.(null) === undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
