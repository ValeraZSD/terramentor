#!/usr/bin/env node
/**
 * Credentials leave the library file, and stay out of it.
 *
 * Every key, sign-in and password used to sit in plain text in the library's
 * SQLite file, and so in every copy of it: the three snapshots the app takes
 * before an upgrade, a backup, a library handed to someone. They now live in
 * a file beside the library (server/secrets.js), and a library that holds
 * them is emptied on its next start. That move is the whole risk of the
 * change — a key lost on the way is a learner who cannot study until they
 * find it again — so it is proved the way it happens: a library seeded in the
 * shape the previous release wrote, booted by a SECOND process.
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
 *   - a key an older build writes back into the library is moved again;
 *   - no server module writes a credential into the library (a source scan,
 *     the half a boot cannot see).
 *
 *   node tools/secrets-gates.mjs                 this checkout
 *   node tools/secrets-gates.mjs --server <dir>  another copy of server/ (HEAD's fails)
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const out = { list: list() };
out.list2 = list();
out.apiKey = tail(ai.getAISettings().apiKey);
out.authOn = auth.isAuthEnabled();
out.passwordOk = auth.checkPassword(process.env.GATE_PASSWORD);
out.bearer = tail(auth.getApiKey());
out.search = search.searchKeysStatus();
out.plan = cauth.hasPlanSignIn(3);
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

function boot(dataDir, mode) {
    return new Promise((done) => {
        const env = {
            ...process.env, DATA_DIR: dataDir, GATE_MODE: mode, GATE_PASSWORD: PASSWORD, GATE_REENTER: K.reentered,
            GATE_SERVER_URL: `${pathToFileURL(serverDir).href}/`, ALLOW_PRIVATE_FETCH: '1', PYTHONIOENCODING: 'utf-8',
        };
        for (const k of ['DB_PATH', 'VAULT_ROOT', 'SECRETS_PATH', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY', 'AI_EXTRA_BODY']) delete env[k];
        const child = spawn(process.execPath, [probeFile], { cwd: repoRoot, env });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
        child.on('close', (code) => {
            clearTimeout(timer);
            const line = stdout.split('\n').find(l => l.startsWith('RESULT '));
            done({ code, out: line ? JSON.parse(line.slice(7)) : null, log: stdout + stderr });
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
        && readFileSync(storeFile).equals(storeBytes));
    ok('the moved library file holds no credential either', leaks(join(B, 'terramentor.db')).length === 0);

    // ── 5. an older build writes a key back ────────────────────────────────
    console.log('\n--- a key an older build writes back is moved again ---');
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
} finally {
    stub.close();
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
