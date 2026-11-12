#!/usr/bin/env node
/**
 * A hosted copy (server/hosted.js): one person's library on a server someone
 * else runs, reachable from the internet.
 *
 *   1. The start-up decision: bound beyond loopback it needs a password or the
 *      operator's setup token; the two "open it up" switches refuse it.
 *   2. A real `node server/index.js` in hosted mode with neither exits 1 with
 *      the reason, and never says it is listening.
 *   3. A real hosted copy given a setup token: the token is never printed, a
 *      wrong one is refused, the right one sets the password.
 *   4. Once in, what acts on the server is refused, whoever asks (this machine
 *      included), and reading and the library's own settings still work.
 *   5. The operator's tool: a generated password set before the first start
 *      signs in; an online backup while the copy runs holds its projects;
 *      restoring it into an emptied library brings them back.
 *   6. The same requests off hosted mode are not refused by it.
 *
 * Every server here binds 127.0.0.1 (a wide bind opens a firewall prompt on a
 * desktop); "from elsewhere" is a request whose Host is the copy's public name,
 * which is how the app tells a proxied visitor from this machine. The model
 * address points at a closed port, so nothing here can reach a model.
 *
 *   node tools/hosted-gates.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const ENTRY = join(repoRoot, 'server', 'index.js');
const CLI = join(repoRoot, 'server', 'hostedCli.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).slice(0, 400)}` : ''}`); }
};

const scratchRoots = [];
function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'tm-hosted-'));
    scratchRoots.push(dir);
    return { dir, env: { DB_PATH: join(dir, 'terramentor.db'), VAULT_ROOT: join(dir, 'vault') } };
}

/** The child's environment: none of the operator's own, no model reachable. */
function childEnv(extra) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
        if (/^(AI_|OPENAI_|TERRAMENTOR_|AUTH_|ALLOW_|ALLOWED_|HOST$|PORT$|DB_PATH$|VAULT_ROOT$|DATA_DIR$|SECRETS_PATH$)/.test(k)) delete env[k];
    }
    return { ...env, AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:9/v1', AI_MODEL: 'none', ...extra };
}

function freePort() {
    return new Promise((res) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

/** Start the server; resolve when it listens or exits. */
function startServer(env, { timeoutMs = 60_000 } = {}) {
    const child = spawn(process.execPath, [ENTRY], { cwd: repoRoot, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    return new Promise((res) => {
        const timer = setTimeout(() => res({ child, out, listening: false, code: null, timedOut: true }), timeoutMs);
        const poll = setInterval(() => {
            if (/Server running at/.test(out)) { clearInterval(poll); clearTimeout(timer); res({ child, get out() { return out; }, listening: true }); }
        }, 50);
        child.on('exit', (code) => { clearInterval(poll); clearTimeout(timer); res({ child, out, listening: false, code }); });
    });
}

function stop(child) {
    return new Promise((res) => {
        if (child.exitCode !== null) return res();
        child.once('exit', () => res());
        child.kill('SIGKILL');
    });
}

function request(port, method, path, { host, body, cookie } = {}) {
    return new Promise((res) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, method, path,
            headers: {
                host: host || `127.0.0.1:${port}`,
                ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
                ...(cookie ? { cookie } : {}),
            },
        }, (r) => {
            let text = '';
            r.on('data', d => { text += d; });
            r.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                const set = [].concat(r.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('sp_sid='));
                res({ status: r.statusCode, json, text, cookie: set || null });
            });
        });
        req.on('error', (e) => res({ status: 0, error: e.message }));
        if (data) req.write(data);
        req.end();
    });
}

const PUBLIC_NAME = 'alice.example.test';
const TOKEN = 'TOKEN-0123456789ABCDEF-XYZW';

try {
    // ---------------------------------------------------------------- 1
    console.log('\n--- 1. the start-up decision ---');
    const hosted = await import(pathToFileURL(join(repoRoot, 'server', 'hosted.js')).href);
    const decide = (env, passwordSet = false) => hosted.hostedStartProblem({ env, passwordSet });
    ok('off hosted mode nothing changes, even bound wide with no password', decide({ HOST: '0.0.0.0' }) === null);
    ok('hosted on loopback with no password starts (only this machine reaches it)', decide({ TERRAMENTOR_HOSTED: '1', HOST: '127.0.0.1' }) === null);
    for (const host of ['0.0.0.0', '::', '10.0.0.4', 'alice.example.test']) {
        const why = decide({ TERRAMENTOR_HOSTED: '1', HOST: host });
        ok(`hosted bound to ${host} with no password and no token is refused, and says how to fix it`,
            !!why && /TERRAMENTOR_SETUP_TOKEN/.test(why) && /set-password/.test(why), why);
    }
    ok('…with a password set it starts', decide({ TERRAMENTOR_HOSTED: '1', HOST: '0.0.0.0' }, true) === null);
    ok('…with a long enough setup token it starts', decide({ TERRAMENTOR_HOSTED: '1', HOST: '0.0.0.0', TERRAMENTOR_SETUP_TOKEN: TOKEN }) === null);
    ok('…a short token is refused', /at least/.test(decide({ TERRAMENTOR_HOSTED: '1', HOST: '0.0.0.0', TERRAMENTOR_SETUP_TOKEN: 'short-token' }) || ''));
    ok('AUTH_ALLOW_OPEN_REMOTE=1 refuses a hosted copy even with a password',
        /AUTH_ALLOW_OPEN_REMOTE/.test(decide({ TERRAMENTOR_HOSTED: '1', HOST: '0.0.0.0', AUTH_ALLOW_OPEN_REMOTE: '1' }, true) || ''));
    ok('ALLOW_PRIVATE_FETCH=1 refuses a hosted copy even on loopback',
        /ALLOW_PRIVATE_FETCH/.test(decide({ TERRAMENTOR_HOSTED: '1', HOST: '127.0.0.1', ALLOW_PRIVATE_FETCH: '1' }) || ''));
    ok('the token is read only in hosted mode', hosted.operatorSetupToken({ TERRAMENTOR_SETUP_TOKEN: TOKEN }) === '');
    ok('a hosted copy trusts the proxy on its private network; off hosted mode only loopback',
        JSON.stringify(hosted.trustProxySetting({ TERRAMENTOR_HOSTED: '1' })) === '["loopback","uniquelocal"]'
        && hosted.trustProxySetting({}) === 'loopback');

    // ---------------------------------------------------------------- 2
    console.log('\n--- 2. a hosted copy with no lock does not start ---');
    {
        const s = scratch();
        const r = await startServer({ ...s.env, TERRAMENTOR_HOSTED: '1', HOST: '0.0.0.0', PORT: String(await freePort()) });
        ok('it exits with code 1', r.code === 1, `code ${r.code}, listening ${r.listening}\n${r.out.slice(-600)}`);
        ok('it says why, naming the fix', /\[hosted\] Refusing to start: bound to 0\.0\.0\.0 with no password and no TERRAMENTOR_SETUP_TOKEN/.test(r.out), r.out.slice(-600));
        ok('it never said it was listening', !/Server running at/.test(r.out));
        if (r.listening) await stop(r.child);
    }

    // ---------------------------------------------------------------- 3, 4
    console.log('\n--- 3. a hosted copy given a setup token ---');
    {
        const s = scratch();
        const port = await freePort();
        const r = await startServer({
            ...s.env, TERRAMENTOR_HOSTED: '1', HOST: '127.0.0.1', PORT: String(port),
            TERRAMENTOR_SETUP_TOKEN: TOKEN, ALLOWED_HOSTS: PUBLIC_NAME,
        });
        ok('it starts', r.listening, r.out.slice(-600));
        if (r.listening) {
            const status = await request(port, 'GET', '/api/auth/status', { host: PUBLIC_NAME });
            ok('a visitor is asked to set up', status.json?.setupRequired === true, status.text);
            const wrong = await request(port, 'POST', '/api/auth/setup', { host: PUBLIC_NAME, body: { password: 'a-long-password-1', setupCode: 'NOT-THE-TOKEN-AT-ALL-0000' } });
            ok('a wrong token is refused', wrong.status === 403, `${wrong.status} ${wrong.text}`);
            const right = await request(port, 'POST', '/api/auth/setup', { host: PUBLIC_NAME, body: { password: 'a-long-password-1', setupCode: TOKEN.toLowerCase() } });
            ok('the token sets the first password and signs the setter in', right.status === 200 && !!right.cookie, `${right.status} ${right.text}`);
            ok('the token never appeared in the log', !r.out.includes(TOKEN) && !r.out.toUpperCase().includes(TOKEN));
            ok('no random setup code was printed instead', !/setup code: [0-9A-F]{4}-/.test(r.out));

            console.log('\n--- 4. what a hosted copy refuses ---');
            const cookie = right.cookie;
            const refusedCalls = [
                ['PUT', '/api/settings/ai_openai_base_url', { value: 'http://169.254.169.254/v1' }],
                ['PUT', '/api/settings/ai_ollama_url', { value: 'http://10.0.0.5:11434' }],
                ['PUT', '/api/settings/searxng_url', { value: 'http://10.0.0.5:8080' }],
                ['PUT', '/api/settings/ai_provider', { value: 'ollama' }],
                ['POST', '/api/ai/connections', { name: 'x', baseUrl: 'http://10.0.0.5/v1' }],
                ['PUT', '/api/ai/key', { key: 'sk-test' }],
                ['POST', '/api/ai/openrouter/start', {}],
                ['POST', '/api/ai/chatgpt/start', {}],
                ['POST', '/api/ai/models/pull', { name: 'qwen3:8b' }],
                ['PUT', '/api/ai/jobs/chat', { connections: [] }],
                ['POST', '/api/searxng/test', { url: 'http://10.0.0.5:8080' }],
                ['POST', '/api/updates/check', {}],
                ['PUT', '/api/updates/auto', { enabled: true }],
                ['PUT', '/api/devices/tailscale', { enabled: true }],
                ['POST', '/api/devices/tailscale/serve', {}],
                ['POST', '/api/desktop/quit', {}],
                ['POST', '/api/auth/disable', { password: 'a-long-password-1' }],
            ];
            for (const [method, path, body] of refusedCalls) {
                const a = await request(port, method, path, { host: PUBLIC_NAME, body, cookie });
                const b = await request(port, method, path, { body, cookie });
                ok(`${method} ${path} is refused as hosted, signed in from elsewhere and from this machine alike`,
                    a.status === 403 && a.json?.hosted === true && b.status === 403 && b.json?.hosted === true,
                    `elsewhere ${a.status} ${a.text?.slice(0, 120)} | here ${b.status} ${b.text?.slice(0, 120)}`);
            }
            const settings = await request(port, 'GET', '/api/settings', { host: PUBLIC_NAME, cookie });
            ok('reading the settings still works', settings.status === 200, settings.status);
            const updates = await request(port, 'GET', '/api/updates', { host: PUBLIC_NAME, cookie });
            ok('reading the update panel still works', updates.status === 200, updates.status);
            const theme = await request(port, 'PUT', '/api/settings/theme', { host: PUBLIC_NAME, body: { value: 'dark' }, cookie });
            ok('the library\'s own settings are still written', theme.status === 200, `${theme.status} ${theme.text}`);
            const login = await request(port, 'POST', '/api/auth/login', { host: PUBLIC_NAME, body: { password: 'a-long-password-1' } });
            ok('the password still signs in after the refused removal', login.status === 200 && !!login.cookie, `${login.status} ${login.text}`);
            await stop(r.child);
        }
    }

    // ---------------------------------------------------------------- 5
    console.log('\n--- 5. the operator\'s tool: password before the first start, backup, restore ---');
    {
        const s = scratch();
        const cli = (args, input) => spawnSync(process.execPath, [CLI, ...args], { cwd: repoRoot, env: childEnv(s.env), input, encoding: 'utf8', timeout: 60_000 });
        const short = cli(['set-password'], 'short');
        ok('a short password is refused', short.status === 1 && /at least/.test(short.stderr), short.stderr);
        const gen = cli(['set-password', '--generate']);
        const password = gen.stdout.trim();
        ok('--generate sets a password and prints it once', gen.status === 0 && /^[a-z2-9]{4}(?:-[a-z2-9]{4}){3}$/.test(password), `${gen.status} ${gen.stdout} ${gen.stderr}`);
        const again = cli(['set-password'], 'another-long-password');
        ok('a second set-password is refused (the app changes it, with the old one)', again.status === 1 && /already has a password/.test(again.stderr), again.stderr);

        const port = await freePort();
        const r = await startServer({ ...s.env, TERRAMENTOR_HOSTED: '1', HOST: '127.0.0.1', PORT: String(port), ALLOWED_HOSTS: PUBLIC_NAME });
        ok('the copy starts with the password already set', r.listening, r.out.slice(-600));
        if (r.listening) {
            const status = await request(port, 'GET', '/api/auth/status', { host: PUBLIC_NAME });
            ok('a visitor is asked to sign in, not to set up', status.json?.enabled === true && !status.json?.setupRequired, status.text);
            const login = await request(port, 'POST', '/api/auth/login', { host: PUBLIC_NAME, body: { password } });
            ok('the generated password signs in', login.status === 200 && !!login.cookie, `${login.status} ${login.text}`);
            const made = await request(port, 'POST', '/api/projects', { host: PUBLIC_NAME, body: { title: 'Backup probe', name: 'Backup probe' }, cookie: login.cookie });
            ok('a project is made to back up', made.status === 200 || made.status === 201, `${made.status} ${made.text?.slice(0, 200)}`);

            const backupDir = join(s.dir, 'backup-1');
            const backup = cli(['backup', backupDir]);
            ok('an online backup while the copy runs succeeds and counts the project', backup.status === 0 && /backup ok: 1 project/.test(backup.stdout), `${backup.status} ${backup.stdout} ${backup.stderr}`);
            ok('the backup holds the credentials beside the database', existsSync(join(backupDir, 'terramentor.secrets.json')));
            const twice = cli(['backup', backupDir]);
            ok('a backup never writes over an existing one', twice.status === 1, twice.stderr);
            await stop(r.child);

            // Empty the library, as a lost volume would be, then restore.
            for (const f of ['terramentor.db', 'terramentor.db-wal', 'terramentor.db-shm', 'terramentor.secrets.json']) rmSync(join(s.dir, f), { force: true });
            const restore = cli(['restore', backupDir]);
            ok('restore puts the library back', restore.status === 0 && /restore ok: 1 project/.test(restore.stdout), `${restore.status} ${restore.stdout} ${restore.stderr}`);
            const port2 = await freePort();
            const r2 = await startServer({ ...s.env, TERRAMENTOR_HOSTED: '1', HOST: '127.0.0.1', PORT: String(port2), ALLOWED_HOSTS: PUBLIC_NAME });
            ok('the restored copy starts', r2.listening, r2.out.slice(-600));
            if (r2.listening) {
                const login2 = await request(port2, 'POST', '/api/auth/login', { host: PUBLIC_NAME, body: { password } });
                ok('the same password signs in to the restored copy', login2.status === 200 && !!login2.cookie, `${login2.status} ${login2.text}`);
                const list = await request(port2, 'GET', '/api/projects', { host: PUBLIC_NAME, cookie: login2.cookie });
                ok('the project is back', Array.isArray(list.json) && list.json.some(p => p.title === 'Backup probe' || p.name === 'Backup probe'), list.text?.slice(0, 300));
                await stop(r2.child);
            }
        }
    }

    // ---------------------------------------------------------------- 6
    console.log('\n--- 6. off hosted mode nothing is refused by it ---');
    {
        const s = scratch();
        const port = await freePort();
        const r = await startServer({ ...s.env, HOST: '127.0.0.1', PORT: String(port) });
        ok('a desktop-style copy starts', r.listening, r.out.slice(-600));
        if (r.listening) {
            const set = await request(port, 'PUT', '/api/settings/searxng_url', { body: { value: 'http://127.0.0.1:8080' } });
            ok('this machine still sets an address', set.status === 200, `${set.status} ${set.text}`);
            const check = await request(port, 'POST', '/api/searxng/test', { body: { url: 'http://127.0.0.1:9' } });
            ok('…and tests one', check.json?.hosted !== true && check.status !== 403, `${check.status} ${check.text}`);
            await stop(r.child);
        }
    }

    // The source half: the guard is in front of the public auth routes.
    const appSrc = readFileSync(join(repoRoot, 'server', 'app.js'), 'utf8');
    const guardAt = appSrc.indexOf("app.use('/api', hostedGuard)");
    const authAt = appSrc.indexOf('mount(authApi.routes)');
    ok('the hosted guard is mounted before the public auth routes', guardAt > 0 && guardAt < authAt);
} finally {
    for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
