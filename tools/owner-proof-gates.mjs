// tools/owner-proof-gates.mjs — on a computer shared by several accounts, only
// the library's owner gets in over loopback (server/auth.js, server/instanceKey.js).
//
// Run:  node tools/owner-proof-gates.mjs
//
// createApp() on a loopback port against a scratch library (DB_PATH, VAULT_ROOT
// and DATA_DIR set in-process), started the way the desktop launcher starts it
// (TERRAMENTOR_DESKTOP=1). Every account on a computer reaches 127.0.0.1, so a
// request that arrives over loopback with a loopback Host is "this computer",
// not yet "the owner". The owner is whoever can read `instance.key` beside the
// library, which only the owning account can.
//
// The proofs here are made by THIS file, from the format written down in
// server/instanceKey.js and the key file on disk, never by the server's own
// helpers: a gate that minted its proofs with the code under test would agree
// with any mistake in it.
//
//   1. Another account: no cookie and no proof is refused for library data, and
//      told how to get in (launchRequired), not sent to a setup code.
//   2. The launcher's one-time URL is taken once, sets an HttpOnly SameSite=Strict
//      cookie, and redirects to a clean "/" that keeps no proof.
//   3. A spent, expired, other-port, wrong-key or malformed proof sets nothing,
//      and a second cookie jar cannot reuse a proof the first one spent.
//   4. A program on the computer sends a fresh proof per request; a replayed one
//      is refused.
//   5. The cookie: a forged or month-old one is refused, a day-old one renewed.
//   6. Another account cannot set the first password, and relayed or LAN-addressed
//      requests stay "another device" with or without the cookie.
//   7. Outside the desktop launcher (npm run dev, standalone) nothing changes.
//   8. The MCP server on stdio reads the key and proves itself; with no key it
//      is refused and says what to set, and makes none. Its HTTP listener,
//      which any account can call, sends no proof.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'owner-proof-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';
process.env.TERRAMENTOR_DESKTOP = '1';
delete process.env.AUTH_ALLOW_OPEN_REMOTE;

const B = new URL('../server/', import.meta.url).href;
const { default: db, DB_PATH } = await import(B + 'database.js');
const { createApp } = await import(B + 'app.js');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

if (!DB_PATH.startsWith(scratch)) { console.error(`refusing: the library is ${DB_PATH}, not the scratch one`); process.exit(2); }

// A gate never reads the wall clock: proofs and cookies expire against Date.now.
const T0 = Date.parse('2026-11-27T12:00:00Z');
const WALL_CLOCK = Date.now;
let clockAt = T0;
Date.now = () => clockAt;
const seconds = () => Math.floor(clockAt / 1000);

const server = createApp().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const port = server.address().port;

// The key the server made beside the library on its first start.
const keyText = readFileSync(join(scratch, 'instance.key'), 'utf8').trim();
ok('the server made the library\'s key file', /^[0-9a-f]{64}$/.test(keyText), keyText.slice(0, 8));
const KEY = Buffer.from(keyText, 'hex');

/** An owner proof as server/instanceKey.js describes it: v1.<seconds>.<nonce>.<hmac>. */
function proof({ key = KEY, at = seconds(), nonce = crypto.randomBytes(16).toString('hex'), forPort = port } = {}) {
    const mac = crypto.createHmac('sha256', key).update(`terramentor-owner\n${at}\n${nonce}\n${forPort}`).digest('hex');
    return `v1.${at}.${nonce}.${mac}`;
}
/** A window cookie as server/instanceKey.js describes it. */
function cookieValue({ key = KEY, at = seconds(), nonce = crypto.randomBytes(16).toString('hex') } = {}) {
    const mac = crypto.createHmac('sha256', key).update(`terramentor-owner-cookie\n${at}\n${nonce}`).digest('hex');
    return `v1.${at}.${nonce}.${mac}`;
}
const COOKIE = `sp_own_${port}`;

function call(path, { method = 'GET', cookie, host, headers: extra = {}, body } = {}) {
    const headers = { Host: host || `127.0.0.1:${port}`, ...extra };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', c => { text += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, body: json, setCookie: res.headers['set-cookie'] || [], headers: res.headers });
            });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}
const ownCookieOf = (r) => r.setCookie.find(c => c.startsWith(`${COOKIE}=`)) || '';
const launch = (p, opts) => call(`/api/auth/launch?proof=${encodeURIComponent(p)}`, opts);

console.log('\n--- 1. another account on this computer ---');
{
    const r = await call('/api/projects');
    ok('no cookie and no proof: library data refused', r.status === 401, `status ${r.status}`);
    ok('…and told to open the app from its icon (launchRequired)', r.body?.launchRequired === true, JSON.stringify(r.body));
    const s = await call('/api/auth/status');
    ok('the status says the same, so the page shows the way in', s.body?.authenticated === false && s.body?.launchRequired === true, JSON.stringify(s.body));
    const w = await call('/api/settings');
    ok('settings refused too', w.status === 401);
    const pub = await call('/api/desktop/status');
    ok('the launcher\'s public probe still answers', pub.status === 200 && pub.body?.app === 'terramentor');
}

console.log('\n--- 2. the launcher\'s one-time URL ---');
let jar = '';
{
    const p = proof();
    const r = await launch(p);
    ok('a good proof is answered with a redirect', r.status === 303, `status ${r.status}`);
    ok('…to a clean "/" that keeps no proof (nothing left in history)', r.headers.location === '/', r.headers.location);
    const set = ownCookieOf(r);
    ok('…setting the owner cookie', !!set, r.setCookie.join(' | '));
    ok('…HttpOnly, SameSite=Strict, Path=/', /;\s*HttpOnly/i.test(set) && /;\s*SameSite=Strict/i.test(set) && /;\s*Path=\//i.test(set), set);
    ok('…not cached anywhere', /no-store/.test(String(r.headers['cache-control'])), r.headers['cache-control']);
    jar = set.split(';')[0];
    const data = await call('/api/projects', { cookie: jar });
    ok('with the cookie the library answers', data.status === 200, `status ${data.status}`);
    const s = await call('/api/auth/status', { cookie: jar });
    ok('…and the status says signed in', s.body?.authenticated === true && !s.body?.launchRequired, JSON.stringify(s.body));

    const again = await launch(p);
    ok('the same URL a second time sets nothing', !ownCookieOf(again), again.setCookie.join(' | '));
    ok('…and still lands on the app\'s own page rather than an error', again.status === 303 && again.headers.location === '/');
    const other = await call('/api/projects', { cookie: ownCookieOf(again).split(';')[0] || undefined });
    ok('a second cookie jar cannot reuse the spent URL', other.status === 401);
}

console.log('\n--- 3. proofs that must not work ---');
{
    const cases = [
        ['made with another key', proof({ key: crypto.randomBytes(32) })],
        ['made for another port', proof({ forPort: port + 1 })],
        ['older than five minutes', proof({ at: seconds() - 5 * 60 - 1 })],
        ['from the future', proof({ at: seconds() + 120 })],
        ['malformed', 'v1.abc.def.0123'],
        ['empty', ''],
        ['a window cookie offered as a proof', cookieValue()],
    ];
    for (const [label, p] of cases) {
        const r = await launch(p);
        ok(`${label}: no cookie`, !ownCookieOf(r), r.setCookie.join(' | '));
    }
    const fresh = await launch(proof({ at: seconds() - 4 * 60 }));
    ok('a proof four minutes old still opens the window (a slow browser start)', !!ownCookieOf(fresh));
    const relayed = await launch(proof(), { headers: { 'X-Forwarded-For': '192.168.1.50' } });
    ok('a good proof relayed from another device sets nothing', !ownCookieOf(relayed));
}

console.log('\n--- 4. a program on the computer (the MCP server) ---');
{
    const p = proof();
    const first = await call('/api/projects', { headers: { 'X-Terramentor-Proof': p } });
    ok('a fresh proof in the header is let in', first.status === 200, `status ${first.status}`);
    const replay = await call('/api/projects', { headers: { 'X-Terramentor-Proof': p } });
    ok('the same header again is refused', replay.status === 401, `status ${replay.status}`);
    const wrong = await call('/api/projects', { headers: { 'X-Terramentor-Proof': proof({ key: crypto.randomBytes(32) }) } });
    ok('a proof made with another key is refused', wrong.status === 401);
    const lan = await call('/api/projects', { headers: { 'X-Terramentor-Proof': proof() }, host: '192.168.1.20:3001' });
    ok('a proof on a request addressed to a LAN name is still another device', lan.status === 401);
}

console.log('\n--- 5. the cookie itself ---');
{
    const forged = `${COOKIE}=${cookieValue({ key: crypto.randomBytes(32) })}`;
    ok('a cookie signed with another key is refused', (await call('/api/projects', { cookie: forged })).status === 401);
    const stale = `${COOKIE}=${cookieValue({ at: seconds() - 31 * 24 * 60 * 60 })}`;
    ok('a cookie older than thirty days is refused', (await call('/api/projects', { cookie: stale })).status === 401);
    const otherPort = `sp_own_${port + 1}=${cookieValue()}`;
    ok('a cookie named for another port is not this server\'s', (await call('/api/projects', { cookie: otherPort })).status === 401);
    const dayOld = `${COOKIE}=${cookieValue({ at: seconds() - 2 * 24 * 60 * 60 })}`;
    const r = await call('/api/projects', { cookie: dayOld });
    ok('a two-day-old cookie works', r.status === 200);
    ok('…and comes back renewed', !!ownCookieOf(r) && ownCookieOf(r).split(';')[0] !== dayOld, r.setCookie.join(' | '));
    const today = await call('/api/projects', { cookie: jar });
    ok('a cookie issued today is not sent again', today.status === 200 && !ownCookieOf(today));
    clockAt = T0 + 3 * 60 * 60 * 1000;
    ok('the window keeps working hours later (an update restarts the server under it)', (await call('/api/projects', { cookie: jar })).status === 200);
    clockAt = T0;
}

console.log('\n--- 6. what stays another device ---');
{
    const setup = await call('/api/auth/setup', { method: 'POST', body: { password: 'a-long-password-1' } });
    ok('another account cannot choose the first password', setup.status === 403, `status ${setup.status}`);
    const relayed = await call('/api/projects', { cookie: jar, headers: { 'X-Forwarded-For': '192.168.1.50' } });
    ok('the cookie on a relayed request is still another device', relayed.status === 401);
    const lan = await call('/api/projects', { cookie: jar, host: '192.168.1.20:3001' });
    ok('…and on a request addressed to a LAN name', lan.status === 401);
    const out = await call('/api/auth/sign-out-everywhere', { method: 'POST', body: {} });
    ok('another account cannot end the connected devices', out.status === 401);
}

console.log('\n--- 7. outside the desktop launcher ---');
{
    delete process.env.TERRAMENTOR_DESKTOP;
    const r = await call('/api/projects');
    ok('npm run dev / standalone: this computer is let in as before', r.status === 200, `status ${r.status}`);
    const l = await launch(proof());
    ok('…and a launch URL there just goes to the app', l.status === 303 && l.headers.location === '/');
    process.env.TERRAMENTOR_DESKTOP = '1';
}

console.log('\n--- 8. the MCP server a harness starts ---');
{
    // The child process signs with the real clock, so the server reads it too
    // for this part; nothing below depends on what time it is, only on the two
    // clocks agreeing.
    Date.now = WALL_CLOCK;
    const PROJECT = 'Owner proof course';
    db.prepare("INSERT INTO projects (name, color) VALUES (?, '#0369a1')").run(PROJECT);
    const ENTRY = fileURLToPath(new URL('../mcp/index.js', import.meta.url));
    const appUrl = `http://127.0.0.1:${port}`;
    const childEnv = (extra) => {
        const env = { ...process.env };
        for (const k of Object.keys(env)) if (k.startsWith('TERRAMENTOR_') || k === 'DATA_DIR' || k === 'DB_PATH' || k === 'VAULT_ROOT') delete env[k];
        return { ...env, ...extra };
    };
    /** One tools/call over stdio, the way a harness starts the server. */
    async function overStdio(env) {
        const child = spawn(process.execPath, [ENTRY], { env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let buf = '';
        const answers = new Map();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => {
            buf += d;
            for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                try { const m = JSON.parse(line); if (m.id != null) answers.get(m.id)?.(m); } catch { /* not a message */ }
            }
        });
        const rpc = (id, method, params) => new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ timeout: true }), 20_000);
            answers.set(id, (m) => { clearTimeout(timer); resolve(m); });
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
        await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'owner-proof-gates', version: '1' } });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        const r = await rpc(2, 'tools/call', { name: 'project_state', arguments: {} });
        child.kill();
        return { error: !!(r.error || r.result?.isError || r.timeout), text: (r.result?.content || []).map(c => c.text).join('\n') };
    }

    const own = await overStdio({ TERRAMENTOR_URL: appUrl, DATA_DIR: scratch });
    ok('on stdio it reads the key beside the library and is let in', !own.error && own.text.includes(PROJECT), own.text.slice(0, 200));
    const elsewhere = mkdtempSync(join(tmpdir(), 'owner-proof-gates-other-'));
    const none = await overStdio({ TERRAMENTOR_URL: appUrl, DATA_DIR: elsewhere });
    ok('with no key to read it is refused, and told what to set', none.error && !none.text.includes(PROJECT) && /found none/.test(none.text) && /DATA_DIR/.test(none.text), none.text.slice(0, 200));
    ok('…and it made no key where it looked', !existsSync(join(elsewhere, 'instance.key')));
    rmSync(elsewhere, { recursive: true, force: true });

    // The HTTP listener answers any process on this computer: it must not vouch for them.
    const h = spawn(process.execPath, [ENTRY, '--http', '--port', '0'], { env: childEnv({ TERRAMENTOR_URL: appUrl, DATA_DIR: scratch }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const mcpPort = await new Promise((resolve) => {
        let out = '';
        const timer = setTimeout(() => resolve(null), 20_000);
        const onData = (d) => { out += d; const m = /http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(out); if (m) { clearTimeout(timer); resolve(Number(m[1])); } };
        h.stdout.on('data', onData);
        h.stderr.on('data', onData);
    });
    const post = (body) => new Promise((resolve) => {
        const data = JSON.stringify(body);
        const req = request({ host: '127.0.0.1', port: mcpPort, path: '/mcp', method: 'POST', headers: {
            Host: `127.0.0.1:${mcpPort}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-11-25', 'Content-Length': Buffer.byteLength(data),
        } }, (res) => { let t = ''; res.setEncoding('utf8'); res.on('data', c => { t += c; }); res.on('end', () => resolve(t)); });
        req.on('error', (e) => resolve(`error ${e.message}`));
        req.end(data);
    });
    if (mcpPort) {
        await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'owner-proof-gates', version: '1' } } });
        const t = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'project_state', arguments: {} } });
        ok('the HTTP listener, though it could read the key, sends no proof: refused', !t.includes(PROJECT) && /cannot vouch/.test(t), t.slice(0, 200));
    } else ok('the HTTP listener started', false);
    h.kill();
    Date.now = () => clockAt;
}

server.close();
try { db.close(); } catch { /* closing a closed handle */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
