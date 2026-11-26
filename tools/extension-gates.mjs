// tools/extension-gates.mjs — the optional extension point (server/extension.js,
// src/clientExtension.ts): where a module may come from, and that every hook
// does what its comment says, proved on the REAL app.
//
// Run:  node tools/extension-gates.mjs
//
// createApp() on a loopback port against a scratch library (DB_PATH,
// VAULT_ROOT and DATA_DIR set in-process, before the first import). The
// fixture modules are written into the scratch folder.
//
//   1. Where a module comes from. Only server/extension.js reads
//      TERRAMENTOR_EXTENSION, only server/index.js loads it, and the repository
//      ships no client module.
//   2. Loading. With none named there are no hooks and trust proxy is loopback;
//      a module that names a hook the server does not have, gives one of the
//      wrong type, exports no object, or is named by a relative path is refused.
//   3. Every hook, through the app: the request guard runs first, the sign-in
//      hook decides a request and adds its fields to the 401 and the status,
//      a refused setting is not written, the update controls go away, trust
//      proxy follows it, a given setup code is checked and never printed, the
//      model chain and the model fetch are wrapped, a sign-in hook's odd answer
//      fails the request, and a final refusal keeps its own sentence, is sent
//      once through a real model call and falls over to no other model.
//   4. Start. A real `node server/index.js` refuses to start on the module's
//      start problem and on an unknown hook, before anything listens; with a
//      quiet start and a socket of its own it listens there.

import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'extension-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';
delete process.env.TERRAMENTOR_EXTENSION;
delete process.env.AUTH_ALLOW_OPEN_REMOTE;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

// --- 1. where a module comes from -------------------------------------------
console.log('\n--- 1. where a module comes from ---');
{
    const serverFiles = (dir) => readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : serverFiles(rel);
        return /\.(m?js|cjs)$/.test(e.name) ? [rel] : [];
    });
    const files = [...serverFiles('server'), ...serverFiles('desktop')];
    const readers = files.filter((f) => readFileSync(join(repoRoot, f), 'utf8').includes('TERRAMENTOR_EXTENSION'));
    ok('only server/extension.js reads TERRAMENTOR_EXTENSION', readers.length === 1 && readers[0] === 'server/extension.js', readers.join(', '));
    const loaders = files.filter((f) => /\bloadExtension\(/.test(readFileSync(join(repoRoot, f), 'utf8')) && f !== 'server/extension.js');
    ok('only server/index.js loads it, once', loaders.length === 1 && loaders[0] === 'server/index.js'
        && (readFileSync(join(repoRoot, 'server/index.js'), 'utf8').match(/\bloadExtension\(/g) || []).length === 1, loaders.join(', '));
    const shipped = readdirSync(join(repoRoot, 'src', 'extensions')).filter((n) => n !== 'README.md');
    ok('the repository ships no client module and no texts (src/extensions/ holds its README only)', shipped.length === 0, shipped.join(', '));
    const client = readFileSync(join(repoRoot, 'src', 'clientExtension.ts'), 'utf8');
    const i18n = readFileSync(join(repoRoot, 'src', 'i18n', 'index.ts'), 'utf8');
    ok('the client reads that folder at build time only', client.includes("import.meta.glob<{ default?: ClientExtension }>('./extensions/*.{ts,tsx}', { eager: true })")
        && i18n.includes("import.meta.glob<{ default: Record<string, string> }>('../extensions/texts/*.json', { eager: true })"));
}

// --- 2. loading ----------------------------------------------------------------
console.log('\n--- 2. loading ---');
const B = new URL('../server/', import.meta.url).href;
const ext = await import(B + 'extension.js');
{
    const none = await ext.loadExtension();
    ok('with none named there are no hooks', Object.keys(none).length === 0 && Object.keys(ext.extension()).length === 0 && Object.isFrozen(ext.extension()));
    const misspelt = join(scratch, 'misspelt.mjs');
    writeFileSync(misspelt, 'export default { startProblem: () => null, authenticte: () => null };\n');
    let refused = '';
    try { await ext.loadExtension(misspelt); } catch (e) { refused = e.message; }
    ok('a hook the server does not have is refused by name', /names hooks this server does not have: authenticte/.test(refused), refused);
    const bare = join(scratch, 'bare.mjs');
    writeFileSync(bare, 'export const startProblem = () => null;\n');
    refused = '';
    try { await ext.loadExtension(bare); } catch (e) { refused = e.message; }
    ok('a module with no default object is refused', /has no default export object/.test(refused), refused);
    const mistyped = join(scratch, 'mistyped.mjs');
    writeFileSync(mistyped, "export default { requestGuard: true, listenPath: 5, serverControls: 'no', trustProxy: 'loopback' };\n");
    refused = '';
    try { await ext.loadExtension(mistyped); } catch (e) { refused = e.message; }
    ok('a hook of the wrong type is refused by name', /wrong type: requestGuard, listenPath, serverControls$/.test(refused), refused);
    refused = '';
    try { await ext.loadExtension('extension.mjs'); } catch (e) { refused = e.message; }
    ok('a relative path is refused, before anything is loaded', /is not an absolute path/.test(refused), refused);
    ok('...and none of them left a hook behind', Object.keys(ext.extension()).length === 0);

    // No module: the app trusts a forwarded address from loopback only, as always.
    const plainApp = (await import(B + 'app.js')).createApp();
    ok('with no module, trust proxy is loopback', plainApp.get('trust proxy') === 'loopback', String(plainApp.get('trust proxy')));
}

// --- 3. every hook, through the app -------------------------------------------
console.log('\n--- 3. every hook, through the app ---');
const fixture = join(scratch, 'hooks.mjs');
writeFileSync(fixture, `
globalThis.__extensionSeen = [];
export default {
    trustProxy: false,
    requestGuard(req, res, next) {
        if (req.headers['x-refuse'] === '1') return res.status(418).json({ error: 'guarded' });
        next();
    },
    authenticate(req) {
        const who = req.headers['x-person'];
        if (who === 'in') return { signedIn: true };
        if (who === 'out') return { signedIn: false, fields: { signInPath: '/elsewhere', authRequired: false } };
        if (who === 'odd') return false;
        return null;
    },
    setupCode: () => 'abcd-1234',
    settingRefusal: (spec, key) => (key === 'theme_tint' ? 'Not on this copy' : null),
    serverControls: false,
    modelChain(chain, job) {
        if (job === 'vision') throw Object.assign(new Error('no vision now'), { unavailable: true });
        if (globalThis.__finalMode) return [{ ...chain[0], provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'final-model', enabled: true }];
        return chain.map((s) => ({ ...s, model: 'swapped-' + job }));
    },
    modelFetch: (inner, settings) => async (url, init) => {
        globalThis.__extensionSeen.push(String(url));
        if (globalThis.__finalMode) {
            throw Object.assign(new Error('Paused until June'), { final: true, messageKey: 'Paused until {{when}}', params: { when: 'June' }, httpStatus: 503 });
        }
        return inner(url, init);
    },
};
`);
await ext.loadExtension(fixture);

const { default: db, DB_PATH } = await import(B + 'database.js');
if (!DB_PATH.startsWith(scratch)) { console.error(`refusing: the library is ${DB_PATH}, not the scratch one`); process.exit(2); }
const { createApp } = await import(B + 'app.js');
const auth = await import(B + 'auth.js');
const aiJobs = await import(B + 'aiJobs.js');
const aiWire = await import(B + 'aiWire.js');
const tasks = await import(B + 'tasks.js');
const embeddings = await import(B + 'embeddings.js');
const clientError = await import(B + 'clientError.js');
const ai = await import(B + 'ai.js');

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

function call(path, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, ...headers } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}

{
    ok('trust proxy is the module\'s', app.get('trust proxy') === false, String(app.get('trust proxy')));

    const guarded = await call('/api/auth/status', { headers: { 'X-Refuse': '1' } });
    ok('the request guard runs first, before the public auth routes', guarded.status === 418 && guarded.json?.error === 'guarded', `${guarded.status}`);

    const plain = await call('/api/projects');
    ok('a request the sign-in hook leaves alone meets the password gate as before (no password, this machine: in)', plain.status === 200, `${plain.status}`);
    const out = await call('/api/projects', { headers: { 'X-Person': 'out' } });
    ok('signed out by the hook: 401, authRequired, with its fields (which cannot override the core ones)', out.status === 401 && out.json?.authRequired === true && out.json?.signInPath === '/elsewhere' && out.json?.messageKey === 'Sign in again', JSON.stringify(out.json));
    const odd = await call('/api/projects', { headers: { 'X-Person': 'odd' } });
    ok('a sign-in hook answering neither null nor { signedIn } fails the request, never lets it by', odd.status === 500, `${odd.status}`);
    const status = await call('/api/auth/status', { headers: { 'X-Person': 'out' } });
    ok('...and the auth status says so, with the same fields', status.status === 200 && status.json?.enabled === true && status.json?.authenticated === false && status.json?.signInPath === '/elsewhere', JSON.stringify(status.json));
    const inside = await call('/api/projects', { headers: { 'X-Person': 'in' } });
    ok('signed in by the hook: through', inside.status === 200, `${inside.status}`);

    const refused = await call('/api/settings/theme_tint', { method: 'PUT', body: { value: '#336699' } });
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'theme_tint'").get();
    ok('a setting the module refuses: 403 with its keyed sentence, nothing written', refused.status === 403 && refused.json?.messageKey === 'Not on this copy' && !stored, JSON.stringify(refused.json));
    const allowed = await call('/api/settings/theme', { method: 'PUT', body: { value: 'dark' } });
    ok('...and the others are written as before', allowed.status === 200, JSON.stringify(allowed.json));

    const updates = await call('/api/updates');
    ok('serverControls false: the update panel offers no controls, even on this machine', updates.status === 200 && updates.json?.controls === false, JSON.stringify(updates.json?.controls));

    const logged = [];
    const log = console.log;
    console.log = (...a) => { logged.push(a.join(' ')); };
    let code;
    try { code = auth.announceSetupCode(); } finally { console.log = log; }
    ok('a given setup code is never printed', code === null && !logged.some((l) => /abcd|ABCD/.test(l)), logged.join(' | '));
    ok('...and is the one a remote first password is checked against', auth.checkSetupCode('ABCD-1234') && auth.checkSetupCode(' abcd-1234 ') && !auth.checkSetupCode('ABCD-1235'));
    auth.clearSetupCode();

    const chain = aiJobs.chainFor('courses');
    ok('the model chain is the module\'s', chain.length > 0 && chain.every((s) => s.model === 'swapped-courses'), JSON.stringify(chain.map((s) => s.model)));
    let thrown = null;
    try { aiJobs.chainFor('vision'); } catch (e) { thrown = e; }
    ok('...it may refuse a job', thrown?.unavailable === true);
    const head = aiJobs.firstChoice('vision');
    ok('...and a capability probe then reads "no model" instead of failing', head?.unavailable === true);

    const fake = async () => new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const send = aiWire.wireFetch({ provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }, { fetchImpl: fake });
    const res = await send('http://127.0.0.1:9/v1/models', { method: 'GET', headers: {} });
    ok('every model request goes through the module\'s fetch, and its answer comes back', res.status === 200 && globalThis.__extensionSeen.includes('http://127.0.0.1:9/v1/models'), globalThis.__extensionSeen.join(', '));

    const finalErr = Object.assign(new Error('Paused until next month'), { final: true, messageKey: 'Paused until {{when}}', params: { when: 'June' }, httpStatus: 503 });
    ok('a final refusal keeps its own keyed sentence for the page', JSON.stringify(tasks.finalSentence(finalErr)) === JSON.stringify({ final: true, messageKey: 'Paused until {{when}}', params: { when: 'June' } }));
    ok('...any other error carries none', Object.keys(tasks.finalSentence(Object.assign(new Error('x'), { messageKey: 'x' }))).length === 0);
    ok('...falls over to no other model, where the same status otherwise would', !aiJobs.fallsOver(finalErr) && aiJobs.fallsOver(Object.assign(new Error('x'), { httpStatus: 503 })));
    ok('...and leaves a document waiting for a model rather than broken', embeddings.isUnavailable(finalErr) === true);
    ok('...and a route answering with it says its own sentence, not "the endpoint answered 503"', clientError.errorBody(finalErr, 500)?.messageKey === 'Paused until {{when}}', JSON.stringify(clientError.errorBody(finalErr, 500)));

    // The same refusal thrown by the module's fetch, through a real model call.
    globalThis.__finalMode = true;
    const before = globalThis.__extensionSeen.length;
    let called = null;
    try { await ai.generateResponse('Say ready.', '', [], { job: 'courses', operation: 'default' }); } catch (e) { called = e; }
    globalThis.__finalMode = false;
    const sent = globalThis.__extensionSeen.length - before;
    ok('a final refusal from the module\'s fetch, through a real model call: sent once, never retried', sent === 1 && called?.final === true, `sent ${sent}, ${called?.message}`);

    // The credentials backup and restore a module may use never go through a link.
    const secrets = await import(B + 'secrets.js');
    const file = secrets.secretsFile();
    const elsewhere = join(scratch, 'elsewhere.secrets.json');
    writeFileSync(elsewhere, '{"not":"this library"}');
    rmSync(file, { force: true });
    let linked = true;
    try { symlinkSync(elsewhere, file, 'file'); } catch { linked = false; }
    if (!linked) console.log('  (link checks skipped: this account cannot make a link)');
    else {
        const backup = join(scratch, 'backup.secrets.json');
        let refused = '';
        try { secrets.copyCredentialsTo(backup); } catch (e) { refused = e.message; }
        ok('a credentials file that is a link is not copied into a backup', /is a link/.test(refused) && !existsSync(backup), refused);
        rmSync(file, { force: true });
        const victim = join(scratch, 'victim.txt');
        writeFileSync(victim, 'untouched');
        symlinkSync(victim, `${file}.restoring`, 'file');
        const from = join(scratch, 'from.secrets.json');
        writeFileSync(from, '{"format":"terramentor-secrets","version":1,"secrets":{}}');
        secrets.replaceCredentialsFrom(from);
        ok('a restore writes nothing through a link left at its temporary name', readFileSync(victim, 'utf8') === 'untouched' && readFileSync(file, 'utf8') === readFileSync(from, 'utf8'));
    }
}
server.close();

// --- 4. start --------------------------------------------------------------------
console.log('\n--- 4. start ---');
function start(moduleFile, waitFor, ms = 60_000) {
    const dir = mkdtempSync(join(scratch, 'start-'));
    const env = { ...process.env, DB_PATH: join(dir, 'test.db'), VAULT_ROOT: join(dir, 'vault'), DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', TERRAMENTOR_EXTENSION: moduleFile, NODE_ENV: 'production' };
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [join(repoRoot, 'server', 'index.js')], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let done = false;
        const finish = (code) => { if (done) return; done = true; clearTimeout(timer); child.kill(); resolve({ code, out }); };
        const timer = setTimeout(() => finish('timeout'), ms);
        const seen = (c) => { out += c; if (waitFor && waitFor.test(out)) finish('seen'); };
        child.stdout.setEncoding('utf8').on('data', seen);
        child.stderr.setEncoding('utf8').on('data', seen);
        child.on('exit', (code) => finish(code));
    });
}
{
    const refuse = join(scratch, 'refuse.mjs');
    writeFileSync(refuse, "export default { startProblem: () => 'the fixture says no' };\n");
    const r = await start(refuse);
    ok('a start problem stops the server before it listens', r.code === 1 && /Refusing to start: the fixture says no/.test(r.out) && !/Server running at|listening on its socket/.test(r.out), `${r.code} ${r.out.slice(-300)}`);

    const misspelt = join(scratch, 'misspelt.mjs');
    const m = await start(misspelt);
    ok('so does a hook the server does not have', m.code === 1 && /Refusing to start: TERRAMENTOR_EXTENSION: .* names hooks this server does not have: authenticte/.test(m.out) && !/Server running at/.test(m.out), `${m.code} ${m.out.slice(-300)}`);

    const sock = process.platform === 'win32' ? `\\\\.\\pipe\\tm-extension-gates-${process.pid}` : join(scratch, 'app.sock');
    const quiet = join(scratch, 'quiet.mjs');
    writeFileSync(quiet, `export default { quietStart: true, listenPath: ${JSON.stringify(sock)} };\n`);
    const q = await start(quiet, /Server listening on its socket/);
    ok('a quiet start on a socket of its own: no start-up model work, listening there and on no port',
        q.code === 'seen' && /Quiet start: start-up model work is not started/.test(q.out) && !/Server running at/.test(q.out), `${q.code} ${q.out.slice(-300)}`);
    if (process.platform !== 'win32' && existsSync(sock)) rmSync(sock, { force: true });
}

try { db.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment longer */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
