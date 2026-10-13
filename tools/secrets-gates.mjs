#!/usr/bin/env node
/**
 * Credentials leave the library file, and stay out of it.
 *
 * Keys, sign-ins and the password live in a file beside the library
 * (server/secrets.js), so the library's SQLite file, and every copy of it (the
 * snapshots the app takes before an upgrade, a backup, a library handed to
 * someone), carries none of them. A library written by 1.2.0 or earlier still
 * holds them in plain text, and is emptied on its next start. That move is
 * where a key can be lost — a learner who cannot study until they find it
 * again — so it is proved the way it happens: a library seeded in the shape
 * 1.2.0 writes, booted by a SECOND process.
 *
 * What has to hold:
 *   - every credential is in the new file afterwards, and reads back;
 *   - the library file's BYTES hold none of them (SQLite leaves deleted rows
 *     in free pages and the WAL, so the rows being empty is not enough), and
 *     neither does the snapshot that start takes;
 *   - a connection still works: its key reaches a stub model on loopback;
 *   - a second start changes nothing;
 *   - a library moved without the file asks for each connection's key again,
 *     sends no key, starts without a password, and takes a key typed again;
 *   - a key an older build writes back into the library after a downgrade is
 *     moved again, and wins (it is the newer copy);
 *   - a backup from before the upgrade, restored, brings back no old secret:
 *     today's bearer key stands, and a ChatGPT sign-in keeps its rotated token;
 *   - a move that cannot write loses nothing, keeps the password working and
 *     refuses changes, and the next start that can write moves them;
 *   - a damaged credentials file is never written over, a byte-order mark is
 *     read, a crash's temporary file is swept, an unreadable file fails closed;
 *   - .gitignore and .dockerignore leave the file out;
 *   - no server module writes a credential into the library (a source scan,
 *     the half a boot cannot see).
 *
 *   node tools/secrets-gates.mjs                 this checkout
 *   node tools/secrets-gates.mjs --server <dir>  another copy of server/ (HEAD's fails)
 */
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';
import Database from 'better-sqlite3';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = process.argv.indexOf('--server');
const serverDir = at > 0 ? resolve(process.argv[at + 1]) : join(repoRoot, 'server');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond || !detail ? '' : `  (${detail})`}`);
};

// ── the credentials, as markers ────────────────────────────────────────────
// Fake values, each carrying TAG, so one byte search finds any of them — and
// any OLDER copy of them — wherever SQLite left it.
const TAG = 'tmsecret';
const K = {
    active: 'sk-tmsecret-active-1111',
    removed: 'sk-tmsecret-removed-0000',
    freed: 'sk-tmsecret-freed-5656',
    anthropic: 'sk-ant-tmsecret-2222',
    session: 'tmsecret-session-5555',
    bearer: 'sk_tmsecret_bearer_6666',
    tavily: 'tvly-tmsecret-7777',
    brave: 'brave-tmsecret-8888',
    jina: 'jina_tmsecret_9999',
    refresh: 'tmsecret-refresh-3333',
    reentered: 'sk-tmsecret-reentered-4444',
    downgrade: 'sk-tmsecret-downgrade-1212',
    rotated: 'tmsecret-refresh-rotated-7373',
};
const PASSWORD = 'correct horse battery staple';
// Older than any release, so the first start is an upgrade and takes its snapshot.
const OLD_VERSION = '0.0.1-gate';
const salt = randomBytes(16);
const hashHex = scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
const PASSWORD_HASH = `scrypt$16384$${salt.toString('hex')}$${hashHex}`;
const CHATGPT = {
    email: 'learner@example.com', issuer: 'https://auth.openai.com', subject: 'sub-1', client_id: 'oaiapp_stub',
    id_token: 'tmsecret-idtoken-3333', access_token: 'tmsecret-access-3333', refresh_token: K.refresh,
    token_type: 'Bearer', expires_at: 4_102_444_800_000, scopes: ['openid', 'chatgpt.tokens.use.direct'],
};

/** A file's bytes, or none: against a server that writes no credentials
 *  file, every check below still runs and fails rather than the gate dying. */
const fileOr = (f) => (existsSync(f) ? readFileSync(f) : Buffer.alloc(0));

/** Every place a credential could still be: the file and its WAL. */
function bytesOf(file) {
    return [file, `${file}-wal`].filter(existsSync).map(f => readFileSync(f));
}
function leaks(file) {
    const found = [];
    for (const buf of bytesOf(file)) {
        if (buf.includes(Buffer.from(TAG))) found.push(TAG);
        if (buf.includes(Buffer.from(hashHex.slice(0, 32)))) found.push('password hash');
    }
    return [...new Set(found)];
}
/** Every file beside the library but the credentials file itself (and a copy
 *  of it set aside on purpose): a temporary file, a snapshot, the WAL. */
function folderLeaks(dir) {
    return readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && !/\.secrets\.json(\.unreadable-\d+)?$/.test(e.name))
        .flatMap(e => leaks(join(dir, e.name)).map(what => `${e.name}: ${what}`));
}

// ── a model on loopback that wants one of two keys ─────────────────────────
const seen = [];   // { phase, url, auth }
let phase = 'seed';
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        const auth = String(req.headers.authorization || '');
        seen.push({ phase, url: req.url, auth });
        // No keep-alive: a socket left open is a handle the child has to close on exit.
        const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(body)); };
        if (auth !== `Bearer ${K.active}` && auth !== `Bearer ${K.reentered}`) return json(401, { error: { message: 'Incorrect API key provided' } });
        if (req.method === 'GET' && req.url.startsWith('/v1/models')) return json(200, { data: [{ id: 'stub-model' }] });
        if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
            return json(200, { choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }], usage: { completion_tokens: 1 } });
        }
        json(404, { error: { message: 'no such route' } });
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

// ── one start of the server under test, in its own process ─────────────────
const scratch = mkdtempSync(join(tmpdir(), 'secrets-gates-'));
const probeFile = join(scratch, 'probe.mjs');
writeFileSync(probeFile, `
const S = process.env.GATE_SERVER_URL;
const mode = process.env.GATE_MODE;
const db = (await import(S + 'database.js')).default;
if (mode === 'schema') process.exit(0);
const ai = await import(S + 'ai.js');
const conns = await import(S + 'aiConnections.js');
const auth = await import(S + 'auth.js');
const search = await import(S + 'searchBackends.js');
const cauth = await import(S + 'chatgptAuth.js');
// Never a whole key on stdout: the last four characters say which one it is.
const tail = (k) => (k || '').slice(-4);
const list = () => conns.listConnections().connections.map(c => ({
    id: c.id, kind: c.kind, hasKey: c.hasKey, keyHint: c.keyHint, keyMissing: c.keyMissing ?? null,
    signedIn: c.signedIn ?? null, active: c.active,
}));
// A reader that throws is an answer too (a credentials file that cannot be read).
const tryIt = (fn) => { try { return fn(); } catch (e) { return 'threw:' + String(e.code || e.message).slice(0, 40); } };
const out = { list: tryIt(list) };
out.list2 = tryIt(list);
out.apiKey = tryIt(() => tail(ai.getAISettings().apiKey));
out.authOn = tryIt(() => auth.isAuthEnabled());
out.passwordOk = tryIt(() => auth.checkPassword(process.env.GATE_PASSWORD));
out.bearer = tryIt(() => tail(auth.getApiKey()));
out.search = tryIt(() => search.searchKeysStatus());
out.plan = tryIt(() => cauth.hasPlanSignIn(3));
if (mode === 'rotate') {
    // What happens after the upgrade: the bearer key is replaced, and OpenAI
    // rotates the ChatGPT refresh token.
    out.newBearer = tail(auth.regenerateApiKey());
    const row3 = db.prepare('SELECT * FROM ai_connections WHERE id = 3').get();
    const c = conns.credentialsOf?.(row3);
    if (c) conns.saveCredentials(3, { ...c, refresh_token: process.env.GATE_ROTATED });
}
if (mode === 'tryset' || mode === 'tryall') out.changed = tryIt(() => { auth.regenerateApiKey(); return 'changed'; });
if (mode === 'tryall') {
    // Changing a connection while the library still holds the credentials:
    // refused before anything is written, so nothing is half-made.
    out.updated = tryIt(() => { conns.updateConnection(2, { model: 'changed-model' }); return 'changed'; });
    try { await conns.removeConnection(2); out.removed = 'removed'; } catch (e) { out.removed = 'threw:' + String(e.code || e.message).slice(0, 40); }
    out.after = tryIt(() => conns.listConnections().connections.map(c => ({ id: c.id, model: c.model })));
}
if (mode === 'migrate' || mode === 'moved') {
    const t = await conns.testConnection(1);
    out.test = { ok: t.ok, step: t.step, reason: t.reason || '' };
}
if (mode === 'moved') {
    conns.updateConnection(1, { apiKey: process.env.GATE_REENTER });
    const t = await conns.testConnection(1);
    out.reentered = { list: list(), apiKey: tail(ai.getAISettings().apiKey), test: { ok: t.ok, step: t.step, reason: t.reason || '' } };
}
console.log('RESULT ' + JSON.stringify(out));
(await import(S + 'database.js')).closeDatabase?.();
setTimeout(() => process.exit(0), 50);
`);

function boot(dataDir, mode, extra = {}) {
    return new Promise((done) => {
        const env = {
            ...process.env, DATA_DIR: dataDir, GATE_MODE: mode, GATE_PASSWORD: PASSWORD, GATE_REENTER: K.reentered, GATE_ROTATED: K.rotated,
            GATE_SERVER_URL: `${pathToFileURL(serverDir).href}/`, ALLOW_PRIVATE_FETCH: '1', PYTHONIOENCODING: 'utf-8',
        };
        for (const k of ['DB_PATH', 'VAULT_ROOT', 'SECRETS_PATH', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY', 'AI_EXTRA_BODY']) delete env[k];
        Object.assign(env, extra);
        const child = spawn(process.execPath, [probeFile], { cwd: repoRoot, env });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
        child.on('close', (code) => {
            clearTimeout(timer);
            const line = stdout.split('\n').find(l => l.startsWith('RESULT '));
            // On Windows, libuv can abort while closing a socket handle at
            // process exit, AFTER the probe has reported: the start itself
            // finished, so that one exit signature is not a crash of it.
            const exitAbort = !!line && /UV_HANDLE_CLOSING/.test(stdout + stderr);
            done({ code: exitAbort ? 0 : code, out: line ? JSON.parse(line.slice(7)) : null, log: stdout + stderr });
        });
    });
}

const tableRows = (file) => {
    const d = new Database(file, { readonly: true });
    try {
        return JSON.stringify({
            settings: d.prepare('SELECT key, value FROM settings ORDER BY key').all(),
            connections: d.prepare('SELECT * FROM ai_connections ORDER BY id').all(),
        });
    } finally { d.close(); }
};
const MOVED = ['ai_openai_api_key', 'auth_password_hash', 'auth_session_secret', 'auth_api_key', 'search_tavily_key', 'search_brave_key', 'search_jina_key'];

try {
    // ── 1. a library in the shape the previous release wrote ───────────────
    console.log('--- a library written by the previous release ---');
    const A = join(scratch, 'library');
    mkdirSync(A);
    const dbFile = join(A, 'terramentor.db');
    const storeFile = join(A, 'terramentor.secrets.json');
    const schema = await boot(A, 'schema');
    ok('the server under test made a library', schema.code === 0 && existsSync(dbFile), schema.log.slice(-300));
    {
        const d = new Database(dbFile);
        const cols = d.prepare('PRAGMA table_info(ai_connections)').all().map(c => c.name);
        if (cols.includes('secret_ref')) d.exec('ALTER TABLE ai_connections DROP COLUMN secret_ref');
        const put = d.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        const origin = STUB;
        for (const [k, v] of Object.entries({
            ai_provider: 'openai', ai_openai_base_url: `${STUB}/v1`, ai_openai_model: 'stub-model', ai_enabled: 'true',
            ai_openai_api_key: K.active, ai_openai_api_key_origin: origin, ai_active_connection: '1',
            auth_password_hash: PASSWORD_HASH, auth_session_secret: K.session, auth_api_key: K.bearer,
            search_tavily_key: K.tavily, search_brave_key: K.brave, search_jina_key: K.jina,
            app_version: OLD_VERSION,
        })) put.run(k, v);
        const now = new Date().toISOString();
        const conn = d.prepare(`INSERT INTO ai_connections (id, kind, base_url, api_key, key_origin, model, account, credentials, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        conn.run(1, 'custom', `${STUB}/v1`, K.active, origin, 'stub-model', '', null, now);
        conn.run(2, 'anthropic', 'https://api.anthropic.com/v1', K.anthropic, 'https://api.anthropic.com', 'claude-x', '', null, now);
        conn.run(3, 'chatgpt', 'https://api.openai.com/v1', '', '', 'plan-model', CHATGPT.email, JSON.stringify(CHATGPT), now);
        // A connection the learner removed: its row is gone, its bytes are not
        // (SQLite leaves a deleted row in the page), which is where a carved
        // copy of a key would come from.
        conn.run(9, 'openai', 'https://api.openai.com/v1', K.removed, 'https://api.openai.com', 'gpt-x', '', null, now);
        d.prepare('DELETE FROM ai_connections WHERE id = 9').run();
        // And pages the library once kept a key on and has since freed (a
        // table rebuilt by a migration): on SQLite's free list, untouched by
        // any row the move clears. Only compacting the file removes them.
        d.exec('CREATE TABLE gate_rebuilt (k TEXT, v TEXT)');
        const old = d.prepare('INSERT INTO gate_rebuilt VALUES (?, ?)');
        for (let i = 0; i < 200; i++) old.run(`ai_openai_api_key_${i}`, `${K.freed}-${'x'.repeat(40)}`);
        d.exec('DROP TABLE gate_rebuilt');
        d.pragma('wal_checkpoint(TRUNCATE)');
        d.close();
    }
    const before = leaks(dbFile);
    ok('control: the seeded library file holds the credentials in its bytes', before.includes(TAG) && before.includes('password hash'), before.join(', '));
    ok("control: a removed connection's key is still in its bytes, though no row holds it",
        bytesOf(dbFile).some(b => b.includes(Buffer.from(K.removed))));
    ok('control: so is the key on the freed pages',
        bytesOf(dbFile).some(b => b.includes(Buffer.from(K.freed))));
    ok('control: no credentials file yet', !existsSync(storeFile));
    // The same library as it was before this build ever opened it: a backup
    // taken by the previous release, restored later in section 6.
    const seedCopy = join(scratch, 'seed.db');
    copyFileSync(dbFile, seedCopy);

    // ── 2. the start that moves them ───────────────────────────────────────
    console.log('\n--- the first start of this build moves them out ---');
    phase = 'migrate';
    const first = await boot(A, 'migrate');
    const r1 = first.out || {};
    ok('the start finished', first.code === 0 && !!first.out, first.log.slice(-400));
    ok('a credentials file now sits beside the library', existsSync(storeFile));
    let stored = {};
    try { stored = JSON.parse(readFileSync(storeFile, 'utf8')).secrets || {}; } catch { /* reported below */ }
    const values = Object.values(stored);
    for (const [name, v] of Object.entries({
        'the key in use': K.active, 'the Anthropic connection\'s key': K.anthropic, 'the password hash': PASSWORD_HASH,
        'the session secret': K.session, 'the bearer key': K.bearer, 'the Tavily key': K.tavily, 'the Brave key': K.brave, 'the Jina key': K.jina,
    })) ok(`it holds ${name}`, values.includes(v));
    ok('it holds the ChatGPT sign-in, refresh token included', values.some(v => v.includes(K.refresh) && v.includes(CHATGPT.client_id)));
    if (process.platform !== 'win32') ok('it is readable by its owner only (0600)', existsSync(storeFile) && (statSync(storeFile).mode & 0o777) === 0o600);

    const afterLeaks = leaks(dbFile);
    ok('the library file holds none of them, in any byte (rows, free pages, WAL)', afterLeaks.length === 0, afterLeaks.join(', '));
    ok("…nor the removed connection's key, which no row held", !bytesOf(dbFile).some(b => b.includes(Buffer.from(K.removed))));
    ok('…nor the key on the freed pages', !bytesOf(dbFile).some(b => b.includes(Buffer.from(K.freed))));
    const snapshot = join(A, `terramentor.db.pre-${OLD_VERSION}.bak`);
    ok('this upgrade took its snapshot', existsSync(snapshot));
    const snapLeaks = existsSync(snapshot) ? leaks(snapshot) : ['(no snapshot)'];
    ok('the snapshot holds none of them', snapLeaks.length === 0, snapLeaks.join(', '));
    const besides = folderLeaks(A);
    ok('no other file beside the library holds one (no temporary file left)', besides.length === 0, besides.join('; '));

    {
        const d = new Database(dbFile, { readonly: true });
        const left = d.prepare(`SELECT key FROM settings WHERE key IN (${MOVED.map(() => '?').join(',')})`).all(...MOVED).map(r => r.key);
        ok('no settings row is a credential', left.length === 0, left.join(', '));
        const rows = d.prepare('SELECT * FROM ai_connections ORDER BY id').all();
        ok('no connection row holds a key or a sign-in', rows.length === 3 && rows.every(r => !r.api_key && !r.credentials));
        ok('each keeps the address its key was saved for (the half that is not secret)',
            rows[0]?.key_origin === STUB && rows[1]?.key_origin === 'https://api.anthropic.com');
        ok('each names its place in the credentials file by a random reference, not its row id',
            rows.every(r => /^[0-9a-f]{16,}$/.test(r.secret_ref || '')) && new Set(rows.map(r => r.secret_ref)).size === 3);
        ok('the key in use keeps its origin row in the library', d.prepare("SELECT value FROM settings WHERE key = 'ai_openai_api_key_origin'").get()?.value === STUB);
        d.close();
    }

    const byId = (list, id) => (list || []).find(c => c.id === id) || {};
    ok('the connections list still shows both keys, by their last four characters',
        byId(r1.list, 1).hasKey && byId(r1.list, 1).keyHint === '…1111' && byId(r1.list, 2).hasKey && byId(r1.list, 2).keyHint === '…2222');
    ok('…and nothing needs its key again', (r1.list || []).length === 3 && r1.list.every(c => c.keyMissing === false));
    ok('the ChatGPT sign-in is still signed in, with its plan', byId(r1.list, 3).signedIn === true && r1.plan === true);
    ok('reading the list twice writes nothing back over it', JSON.stringify(r1.list) === JSON.stringify(r1.list2));
    ok('the key in use is the one model calls send', r1.apiKey === '1111');
    ok('the password still opens the app', r1.authOn === true && r1.passwordOk === true);
    ok('the bearer key still answers', r1.bearer === '6666');
    ok('all three search keys are still saved', r1.search?.tavily && r1.search?.brave && r1.search?.jina);
    ok('a connection still works: tested to a reply', r1.test?.ok === true && r1.test?.step === 'reply', JSON.stringify(r1.test));
    const migrated = seen.filter(s => s.phase === 'migrate');
    ok('…and its key reached the model on loopback', migrated.some(s => s.url.startsWith('/v1/chat/completions') && s.auth === `Bearer ${K.active}`));

    // ── 3. a second start ──────────────────────────────────────────────────
    console.log('\n--- a second start changes nothing ---');
    const storeBytes = existsSync(storeFile) ? readFileSync(storeFile) : Buffer.alloc(0);
    const storeTime = existsSync(storeFile) ? statSync(storeFile).mtimeMs : 0;
    const rowsBefore = tableRows(dbFile);
    const filesBefore = readdirSync(A).filter(f => !/-(wal|shm)$/.test(f)).sort().join(',');
    phase = 'reboot';
    const second = await boot(A, 'reboot');
    ok('the second start finished', second.code === 0 && !!second.out, second.log.slice(-300));
    ok('it moved nothing', !/\[Secrets\] Moved/.test(second.log));
    ok('the credentials file is byte for byte the same, and not rewritten',
        existsSync(storeFile) && readFileSync(storeFile).equals(storeBytes) && statSync(storeFile).mtimeMs === storeTime);
    ok('the library\'s settings and connections are the same', tableRows(dbFile) === rowsBefore);
    ok('no file appeared beside the library (no snapshot, nothing set aside)', readdirSync(A).filter(f => !/-(wal|shm)$/.test(f)).sort().join(',') === filesBefore);
    ok('…and it reads every credential as before', JSON.stringify(second.out?.list) === JSON.stringify(r1.list) && second.out?.passwordOk === true);

    // ── 4. the library moved without its credentials ───────────────────────
    console.log('\n--- a library moved without its credentials file ---');
    const B = join(scratch, 'moved');
    mkdirSync(B);
    {
        const d = new Database(dbFile);
        d.pragma('wal_checkpoint(TRUNCATE)');
        d.close();
    }
    copyFileSync(dbFile, join(B, 'terramentor.db'));
    phase = 'moved';
    const moved = await boot(B, 'moved');
    const r3 = moved.out || {};
    ok('it starts (no crash)', moved.code === 0 && !!moved.out, moved.log.slice(-400));
    ok('each key connection says it needs its key again', byId(r3.list, 1).keyMissing === true && byId(r3.list, 2).keyMissing === true
        && !byId(r3.list, 1).hasKey && !byId(r3.list, 2).hasKey, JSON.stringify(r3.list));
    ok('…and the ChatGPT connection, its sign-in', byId(r3.list, 3).keyMissing === true && byId(r3.list, 3).signedIn === false && r3.plan === false);
    ok('…and still does after the list is read again', JSON.stringify(r3.list) === JSON.stringify(r3.list2));
    ok('no key is handed to a model call', r3.apiKey === '');
    ok('there is no password, so the app answers only its own machine', r3.authOn === false && r3.bearer === '');
    ok('no search key is saved', r3.search && !r3.search.tavily && !r3.search.brave && !r3.search.jina);
    ok('testing the connection fails on the KEY, not on anything else', r3.test?.ok === false && r3.test?.reason === 'key', JSON.stringify(r3.test));
    const movedCalls = seen.filter(s => s.phase === 'moved' && !s.auth.includes(K.reentered));
    ok('…having sent the model no key at all', movedCalls.length > 0 && movedCalls.every(s => !/tmsecret/.test(s.auth)), movedCalls.map(s => s.auth || '(none)').join(' | '));
    ok('typing the key again brings the connection back', byId(r3.reentered?.list, 1).keyMissing === false && byId(r3.reentered?.list, 1).keyHint === '…4444'
        && r3.reentered?.apiKey === '4444' && r3.reentered?.test?.ok === true, JSON.stringify(r3.reentered));
    ok('…into a credentials file of its own, beside the moved library', existsSync(join(B, 'terramentor.secrets.json'))
        && fileOr(storeFile).equals(storeBytes));
    ok('the moved library file holds no credential either', leaks(join(B, 'terramentor.db')).length === 0);

    // ── 5. an older build writes a key back ────────────────────────────────
    // A downgrade and back: the library carries the mark of having been
    // opened by this build, so what the older build wrote is the newer copy.
    console.log('\n--- a key an older build writes back is moved again, and wins ---');
    {
        const d = new Database(dbFile);
        d.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_openai_api_key', ?)").run(K.downgrade);
        d.prepare("UPDATE ai_connections SET api_key = ? WHERE id = 1").run(K.downgrade);
        d.pragma('wal_checkpoint(TRUNCATE)');
        d.close();
    }
    phase = 'downgrade';
    const back = await boot(A, 'reboot');
    let again = {};
    try { again = JSON.parse(readFileSync(storeFile, 'utf8')).secrets || {}; } catch { /* reported below */ }
    ok('the next start moves it, replacing the older copy in the credentials file',
        back.code === 0 && again.ai_openai_api_key === K.downgrade && Object.values(again).filter(v => v === K.downgrade).length === 2);
    ok('…and the library holds it no longer', leaks(dbFile).length === 0);
    ok('…and it is the key in use', back.out?.apiKey === '1212');

    // ── 6. a backup from before the upgrade, restored ──────────────────────
    console.log('\n--- a backup from before the upgrade, restored, brings back no old secret ---');
    phase = 'rotate';
    const rot = await boot(A, 'rotate');
    ok('after the upgrade the bearer key is replaced and the refresh token rotates', rot.code === 0 && /^[0-9a-f]{4}$/.test(rot.out?.newBearer || '')
        && fileOr(storeFile).toString('utf8').includes(K.rotated), rot.log.slice(-300));
    for (const f of ['terramentor.db', 'terramentor.db-wal', 'terramentor.db-shm']) rmSync(join(A, f), { force: true });
    copyFileSync(seedCopy, dbFile);
    phase = 'restored';
    const restored = await boot(A, 'reboot');
    const r6 = restored.out || {};
    let after6 = {};
    try { after6 = JSON.parse(readFileSync(storeFile, 'utf8')).secrets || {}; } catch { /* reported below */ }
    ok('the restored library starts', restored.code === 0 && !!restored.out, restored.log.slice(-300));
    ok("the bearer key is today's, not the backup's", r6.bearer === rot.out?.newBearer && r6.bearer !== '6666', `${r6.bearer} vs ${rot.out?.newBearer}`);
    ok('the restored ChatGPT connection keeps the rotated sign-in, never the spent one',
        Object.values(after6).some(v => v.includes(K.rotated)) && !Object.values(after6).some(v => v.includes(K.refresh)) && r6.plan === true);
    ok('the log names what the backup carried and was not used', /older copies of [^\n]*auth_api_key/.test(restored.log) && /kept the newer tokens/.test(restored.log), restored.log.slice(-500));
    ok('the password still opens it', r6.passwordOk === true);
    ok('the restored library file is emptied of them too', leaks(dbFile).length === 0, leaks(dbFile).join(', '));

    // ── 7. a move that cannot write ────────────────────────────────────────
    console.log('\n--- a move that cannot write loses nothing and keeps the password ---');
    const C = join(scratch, 'blocked');
    mkdirSync(C);
    copyFileSync(seedCopy, join(C, 'terramentor.db'));
    const blocker = join(scratch, 'not-a-folder');
    writeFileSync(blocker, 'a file where the credentials folder would be');
    phase = 'blocked';
    const blocked = await boot(C, 'tryall', { SECRETS_PATH: join(blocker, 'terramentor.secrets.json') });
    const r7 = blocked.out || {};
    ok('the start finishes and says the move failed', blocked.code === 0 && !!blocked.out && /Could not move the credentials/.test(blocked.log), blocked.log.slice(-400));
    ok('the password still opens it: a failed move does not open the gate', r7.authOn === true && r7.passwordOk === true, JSON.stringify({ a: r7.authOn, p: r7.passwordOk }));
    ok('the key in use and every saved connection still work from the library', r7.apiKey === '1111' && byId(r7.list, 1).keyHint === '…1111'
        && byId(r7.list, 2).keyHint === '…2222' && byId(r7.list, 3).signedIn === true, JSON.stringify(r7.list));
    ok('a change is refused, saying why, rather than half-made', /^threw:Saved keys cannot be changed/.test(String(r7.changed)), String(r7.changed));
    ok('…and so is changing or removing a connection, with nothing half-done',
        /^threw:Saved keys/.test(String(r7.updated)) && /^threw:Saved keys/.test(String(r7.removed))
        && byId(r7.after, 2).model === 'claude-x', JSON.stringify({ u: r7.updated, r: r7.removed, after: r7.after }));
    ok('…and nothing left the library', (() => {
        const d = new Database(join(C, 'terramentor.db'), { readonly: true });
        try { return MOVED.every(k => !!d.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value); } finally { d.close(); }
    })());
    const cSnap = join(C, `terramentor.db.pre-${OLD_VERSION}.bak`);
    ok("that start's snapshot is made without them (it is kept for three upgrades)", existsSync(cSnap) && leaks(cSnap).length === 0,
        existsSync(cSnap) ? leaks(cSnap).join(', ') : 'no snapshot');
    phase = 'unblocked';
    const unblocked = await boot(C, 'reboot');
    ok('the next start that can write moves them', unblocked.code === 0 && /\[Secrets\] Moved/.test(unblocked.log)
        && unblocked.out?.passwordOk === true && unblocked.out?.apiKey === '1111', unblocked.log.slice(-300));
    ok('…and leaves the library without them', leaks(join(C, 'terramentor.db')).length === 0);
    ok('…and no file beside it holds one either', folderLeaks(C).length === 0, folderLeaks(C).join('; '));

    // ── 7a. the file is written, then the library cannot be cleared ────────
    console.log('\n--- a library that cannot be cleared keeps the run from changing anything ---');
    const G = join(scratch, 'uncleared');
    mkdirSync(G);
    copyFileSync(seedCopy, join(G, 'terramentor.db'));
    {
        const d = new Database(join(G, 'terramentor.db'));
        // The clear fails on the mark it writes last. The snapshot's scrub
        // writes no mark, so it can still succeed, and is checked below.
        d.exec(`CREATE TRIGGER gate_block BEFORE INSERT ON settings WHEN new.key = 'secrets_moved_at'
                BEGIN SELECT RAISE(ABORT, 'gate: the clear fails'); END`);
        d.close();
    }
    phase = 'uncleared';
    const uncleared = await boot(G, 'tryset');
    ok('the start finishes and says the move failed', uncleared.code === 0 && /Could not move the credentials/.test(uncleared.log), uncleared.log.slice(-300));
    ok('the password and the key in use still work', uncleared.out?.passwordOk === true && uncleared.out?.apiKey === '1111');
    ok('a change is refused, so nothing deleted now can come back later', /^threw:Saved keys cannot be changed/.test(String(uncleared.out?.changed)), String(uncleared.out?.changed));
    const gSnap = join(G, `terramentor.db.pre-${OLD_VERSION}.bak`);
    ok("that start's snapshot exists and is made without them", existsSync(gSnap) && leaks(gSnap).length === 0,
        existsSync(gSnap) ? leaks(gSnap).join(', ') : `no snapshot: ${readdirSync(G).join(',')}`);
    {
        const d = new Database(join(G, 'terramentor.db'));
        d.exec('DROP TRIGGER gate_block');
        // The file already holds row 2's key under the ref that start gave it;
        // make the file's copy the newer one (as another process saving it
        // would), so the next start has to choose.
        let ref2 = '';
        try { ref2 = d.prepare('SELECT secret_ref FROM ai_connections WHERE id = 2').get()?.secret_ref; } catch { /* a server with no refs */ }
        d.close();
        const gStore = join(G, 'terramentor.secrets.json');
        if (ref2 && existsSync(gStore)) {
            const doc = JSON.parse(readFileSync(gStore, 'utf8'));
            doc.secrets[`connection:${ref2}:api_key`] = 'sk-ant-tmsecret-newer-9090';
            writeFileSync(gStore, JSON.stringify(doc, null, 2));
        }
    }
    phase = 'cleared';
    const cleared = await boot(G, 'reboot');
    ok('the next start clears the library', cleared.code === 0 && leaks(join(G, 'terramentor.db')).length === 0 && cleared.out?.passwordOk === true
        && cleared.out?.bearer === '6666', cleared.log.slice(-300));
    ok("…keeping the file's newer key for a row the library still carried", byId(cleared.out?.list, 2).keyHint === '…9090', JSON.stringify(byId(cleared.out?.list, 2)));

    // ── 7b. a library from before saved connections existed ────────────────
    // 1.1.0 and earlier: a settings table with the key and the password, and no
    // ai_connections table at all.
    console.log('\n--- a library from before saved connections existed ---');
    const E = join(scratch, 'older');
    mkdirSync(E);
    {
        const d = new Database(join(E, 'terramentor.db'));
        d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
        const put = d.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
        for (const [k, v] of Object.entries({
            ai_provider: 'openai', ai_openai_base_url: `${STUB}/v1`, ai_openai_model: 'stub-model',
            ai_openai_api_key: K.active, ai_openai_api_key_origin: STUB, auth_password_hash: PASSWORD_HASH, app_version: OLD_VERSION,
        })) put.run(k, v);
        d.close();
    }
    phase = 'older';
    const older = await boot(E, 'reboot');
    ok('it moves the key and the password like any other', older.code === 0 && /\[Secrets\] Moved/.test(older.log) && !/Could not move/.test(older.log), older.log.slice(-300));
    ok('…and both still work', older.out?.passwordOk === true && older.out?.apiKey === '1111', JSON.stringify({ p: older.out?.passwordOk, k: older.out?.apiKey }));
    ok('…and the library holds neither', leaks(join(E, 'terramentor.db')).length === 0);

    // ── 7c. a restored sign-in, and a clear that fails ─────────────────────
    console.log('\n--- a restored sign-in keeps its newer tokens even when the clear fails ---');
    const H = join(scratch, 'restored-uncleared');
    mkdirSync(H);
    copyFileSync(seedCopy, join(H, 'terramentor.db'));
    if (existsSync(storeFile)) copyFileSync(storeFile, join(H, 'terramentor.secrets.json'));
    {
        const d = new Database(join(H, 'terramentor.db'));
        d.exec(`CREATE TRIGGER gate_block BEFORE INSERT ON settings WHEN new.key = 'secrets_moved_at'
                BEGIN SELECT RAISE(ABORT, 'gate: the clear fails'); END`);
        d.close();
    }
    phase = 'restored-uncleared';
    const hFirst = await boot(H, 'reboot');
    ok('that run signs in with the newer tokens already saved', hFirst.code === 0 && /Could not move/.test(hFirst.log) && hFirst.out?.plan === true,
        JSON.stringify({ plan: hFirst.out?.plan }));
    {
        const d = new Database(join(H, 'terramentor.db'));
        d.exec('DROP TRIGGER gate_block');
        d.close();
    }
    phase = 'restored-cleared';
    const hNext = await boot(H, 'reboot');
    const hStore = fileOr(join(H, 'terramentor.secrets.json')).toString('utf8');
    ok('the next start keeps the rotated token and never moves the spent one over it',
        hNext.code === 0 && hNext.out?.plan === true && hStore.includes(K.rotated) && !hStore.includes(K.refresh), hNext.log.slice(-300));
    ok('…and empties the library', leaks(join(H, 'terramentor.db')).length === 0);

    // ── 8. a credentials file that is not one, and what a crash leaves ─────
    console.log('\n--- a damaged credentials file is never written over ---');
    const D = join(scratch, 'damaged');
    mkdirSync(D);
    copyFileSync(dbFile, join(D, 'terramentor.db'));
    const dStore = join(D, 'terramentor.secrets.json');
    // Saved again by Notepad or PowerShell 5.1: a byte-order mark in front.
    writeFileSync(dStore, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fileOr(storeFile)]));
    // A temporary file a crash left an hour ago, and one being written now.
    const staleTmp = join(D, 'terramentor.secrets.json.4242.0badf00d.tmp');
    const freshTmp = join(D, 'terramentor.secrets.json.4243.0badf00e.tmp');
    writeFileSync(staleTmp, `{"secrets":{"x":"${K.active}"}}`);
    writeFileSync(freshTmp, '{}');
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(staleTmp, hourAgo, hourAgo);
    phase = 'bom';
    const bom = await boot(D, 'reboot');
    ok('a file with a byte-order mark still reads', bom.code === 0 && bom.out?.passwordOk === true && bom.out?.bearer === rot.out?.newBearer, JSON.stringify(bom.out?.bearer));
    ok("a crash's temporary file is removed once it is old, one being written is not", !existsSync(staleTmp) && existsSync(freshTmp));
    rmSync(freshTmp, { force: true });
    const garbage = 'this is not a credentials file';
    writeFileSync(dStore, garbage);
    phase = 'garbage';
    const bad = await boot(D, 'tryset');
    const asideFiles = readdirSync(D).filter(f => /\.secrets\.json\.unreadable-\d+$/.test(f));
    ok('a file that is not a credentials file reads as no saved keys, without a crash', bad.code === 0 && bad.out?.authOn === false && /not a credentials file/.test(bad.log));
    ok('the next save sets it aside untouched instead of writing over it', bad.out?.changed === 'changed' && asideFiles.length === 1
        && readFileSync(join(D, asideFiles[0]), 'utf8') === garbage && JSON.parse(readFileSync(dStore, 'utf8')).format === 'terramentor-secrets', asideFiles.join(','));
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        // A file that is there and cannot be read must not read as "no password".
        writeFileSync(dStore, fileOr(storeFile));
        chmodSync(dStore, 0o000);
        phase = 'locked';
        const locked = await boot(D, 'reboot');
        chmodSync(dStore, 0o600);
        ok('an unreadable credentials file fails closed: the password check errors, it does not switch off', String(locked.out?.authOn).startsWith('threw:'), String(locked.out?.authOn));
    }
} finally {
    stub.close();
}

// ── 9. no build or commit picks the file up ───────────────────────────────
console.log('\n--- the credentials file stays out of commits and images ---');
{
    const lines = (f) => readFileSync(join(repoRoot, f), 'utf8').split(/\r?\n/).map(l => l.trim());
    ok('.gitignore leaves it out', lines('.gitignore').includes('*.secrets.json'));
    ok('.dockerignore leaves it out of the build context at every depth (COPY server takes the folder)', lines('.dockerignore').includes('**/*.secrets.json*'));
}

// ── 6. nothing writes a credential into the library ────────────────────────
console.log('\n--- no server module writes a credential into the library ---');
{
    const files = readdirSync(serverDir, { recursive: true }).filter(f => /\.js$/.test(f)).map(f => String(f).replace(/\\/g, '/'));
    const RULES = [
        [/INSERT INTO ai_connections\s*\([^)]*\b(api_key|credentials)\b/, 'inserts a key or sign-in into ai_connections'],
        [/\b(api_key|credentials)\s*=\s*\?/, 'updates ai_connections with a key or sign-in'],
        [/INTO settings.*'(ai_openai_api_key|auth_password_hash|auth_session_secret|auth_api_key|search_(tavily|brave|jina)_key)'/, 'writes a credential row into settings'],
        [/\.run\(\s*'(ai_openai_api_key|auth_password_hash|auth_session_secret|auth_api_key)'/, 'writes a credential row into settings'],
    ];
    let offences = 0;
    for (const f of files) {
        if (f === 'secrets.js') continue;   // the mover: it only ever empties those columns
        const lines = readFileSync(join(serverDir, f), 'utf8').split('\n');
        lines.forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith('//') || t.startsWith('*')) return;
            if (/\bDELETE\b/.test(line)) return;   // taking one out is the opposite
            const hit = RULES.find(([re]) => re.test(line));
            if (hit) { offences++; ok(`${f}:${i + 1} ${hit[1]}`, false); }
        });
    }
    ok(`${files.length} server modules scanned; none writes a credential into the library`, offences === 0, `${offences} lines`);
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
