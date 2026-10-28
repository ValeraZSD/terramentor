// tools/session-gates.mjs — what a sign-in is worth, how it ends, and who
// counts as "this computer" (server/auth.js, server/authSessions.js), proved
// on the REAL app.
//
// Run:  node tools/session-gates.mjs
//
// createApp() on a loopback port against a scratch library (DB_PATH, VAULT_ROOT
// and DATA_DIR set in-process, before the first import). The wall clock is
// pinned: sessions expire against `Date.now`, so the checks move it.
//
//   1. Sessions are records the server can end. Signing out ends the session
//      on the server, not only the cookie; "Sign out everywhere" ends every
//      other session and every connected device without changing the
//      password; a session lasts 14 days from its last use and is renewed as
//      it is used; the library holds a hash of each session, never the token;
//      a session token is a cookie only, never a Bearer.
//   2. The password check. New passwords are at least 10 characters, and an
//      older shorter one still signs in; scrypt runs off the main thread, at
//      most two at once with a bounded queue behind them; the throttle's
//      record of addresses is capped; IPv6 addresses are counted by /64.
//   3. "This computer". With no password the app answers its own machine; a
//      request on a loopback socket that names a proxy (Forwarded, Via,
//      X-Forwarded-*) or a Host that is not a loopback name came from
//      somewhere else, and is treated so. The status says when the app is
//      set up to be reachable from elsewhere with no password.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'session-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';
// A name the operator fronts the app with. originGuard reads it at import.
process.env.ALLOWED_HOSTS = 'study.example.com';
delete process.env.ALLOWED_ORIGINS;
delete process.env.AUTH_ALLOW_OPEN_REMOTE;

const B = new URL('../server/', import.meta.url).href;
const { default: db, DB_PATH } = await import(B + 'database.js');
const { createApp } = await import(B + 'app.js');
const auth = await import(B + 'auth.js');
const devices = await import(B + 'devices.js');
const guard = await import(B + 'originGuard.js');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

if (!DB_PATH.startsWith(scratch)) { console.error(`refusing: the library is ${DB_PATH}, not the scratch one`); process.exit(2); }

const T0 = Date.parse('2026-10-28T12:00:00Z');
let clockAt = T0;
Date.now = () => clockAt;
const DAY = 24 * 60 * 60 * 1000;

devices.setTailscaleRunnerForTest(async () => null); // never the real Tailscale CLI
devices.setTailscaleOwnerForTest(null);

const server = createApp().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const port = server.address().port;
const PHONE = '192.168.1.50';
const PC = 'desk.tail1234.ts.net';

/** One request; `from` is the address a loopback proxy says it relayed (none = this machine). */
function call(path, { method = 'GET', from, cookie, host, body, headers: extra = {} } = {}) {
    const headers = { 'Content-Type': 'application/json', Host: host || `127.0.0.1:${port}` };
    if (from) headers['X-Forwarded-For'] = from;
    if (cookie) headers.Cookie = cookie;
    Object.assign(headers, extra);
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', c => { text += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, body: json, setCookie: res.headers['set-cookie'] || [] });
            });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}
const cookieOf = (r, name) => (r.setCookie.find(c => c.startsWith(`${name}=`)) || '').split(';')[0];
const maxAgeOf = (r, name) => Number(((r.setCookie.find(c => c.startsWith(`${name}=`)) || '').match(/Max-Age=(\d+)/) || [])[1]);
const login = async (password = PW) => cookieOf(await call('/api/auth/login', { method: 'POST', body: { password } }), 'sp_sid');
const opens = async (cookie, extra = {}) => (await call('/api/projects', { cookie, ...extra })).status;
/** setPassword may answer synchronously (before) or with a promise (after). */
const setPassword = async (pw) => { await auth.setPassword(pw); };

const PW = 'a long passphrase';

// ── 1. sessions ─────────────────────────────────────────────────────────────
console.log('\n--- a session is a record the server can end ---');
{
    const setup = await call('/api/auth/setup', { method: 'POST', body: { password: PW } });
    ok('the first password is set from this computer', setup.status === 200, JSON.stringify(setup.body));
    ok('a session cookie lasts 14 days, not 30', maxAgeOf(setup, 'sp_sid') === 14 * 24 * 60 * 60, String(maxAgeOf(setup, 'sp_sid')));

    const a = await login();
    ok('a signed-in browser opens the app', await opens(a) === 200);
    const token = decodeURIComponent(a.split('=')[1] || '');
    let rows = null;
    try { rows = db.prepare('SELECT * FROM auth_sessions').all(); } catch (e) { rows = `threw: ${e.message}`; }
    const parts = token.split('.');
    ok('the library keeps a record per session…', Array.isArray(rows) && rows.length >= 2, JSON.stringify(rows).slice(0, 120));
    ok('…and never the token or any part of it', Array.isArray(rows) && parts.length >= 2
        && parts.filter(p => p.length >= 16).every(p => !JSON.stringify(rows).includes(p)), parts.join(' | '));

    const bearer = await call('/api/projects', { headers: { Authorization: `Bearer ${token}` } });
    ok('the session token sent as a Bearer is refused (it is a cookie only)', bearer.status === 401, String(bearer.status));

    const out = await call('/api/auth/logout', { method: 'POST', cookie: a });
    ok('signing out answers ok', out.body?.ok === true);
    ok('…and the same cookie, kept and sent again, is refused', await opens(a) === 401, String(await opens(a)));
}

console.log('\n--- sign out everywhere ---');
{
    const a = await login();
    const b = await login();
    const code = ((await call('/api/devices/pair', { method: 'POST', cookie: a, host: PC, body: { password: PW } })).body?.url || '').split('#pair=')[1] || '';
    const phone = cookieOf(await call('/api/auth/pair', { method: 'POST', from: PHONE, body: { code } }), 'sp_dev');
    ok('two browsers and a connected phone are in', await opens(a) === 200 && await opens(b) === 200
        && await opens(phone, { from: PHONE }) === 200);

    const wrong = await call('/api/auth/sign-out-everywhere', { method: 'POST', cookie: a, body: { password: 'not the password' } });
    ok('a wrong password ends nothing', wrong.status === 401 && await opens(b) === 200, `${wrong.status}`);
    const nobody = await call('/api/auth/sign-out-everywhere', { method: 'POST', body: { password: PW } });
    ok('…and nor does a caller that is not signed in', nobody.status === 401 && await opens(b) === 200, `${nobody.status}`);

    const all = await call('/api/auth/sign-out-everywhere', { method: 'POST', cookie: a, body: { password: PW } });
    ok('with the password it answers ok', all.status === 200 && all.body?.ok === true, `${all.status} ${JSON.stringify(all.body)}`);
    ok('…the other browser is signed out', await opens(b) === 401);
    ok('…the connected phone is ended', await opens(phone, { from: PHONE }) === 401);
    const a2 = cookieOf(all, 'sp_sid');
    ok('…the browser that asked keeps a fresh session', !!a2 && a2 !== a && await opens(a2) === 200);
    ok('…and its old cookie is not that session', await opens(a) === 401);
    ok('the password itself is unchanged', !!(await login()));
}

console.log('\n--- a session lasts 14 days from its last use ---');
{
    const c = await login();
    clockAt += 10 * DAY;
    const used = await call('/api/projects', { cookie: c });
    ok('used after 10 days it still opens', used.status === 200);
    ok('…and the cookie is renewed for another 14 days', maxAgeOf(used, 'sp_sid') === 14 * 24 * 60 * 60, used.setCookie.join(' / ') || 'no Set-Cookie');
    const renewed = cookieOf(used, 'sp_sid') || c;
    clockAt += 10 * DAY;
    ok('20 days after signing in, used in between, it still opens', await opens(renewed) === 200);
    clockAt += 15 * DAY;
    ok('15 days unused, it is over', await opens(renewed) === 401);
    clockAt = T0;

    // Used every week, it would renew for ever; a copied cookie with it. A
    // sign-in therefore also ends 90 days after it was made.
    let weekly = await login();
    let opened = true;
    for (let week = 1; week <= 12; week++) {
        clockAt += 7 * DAY;
        const r = await call('/api/projects', { cookie: weekly });
        opened = opened && r.status === 200;
        weekly = cookieOf(r, 'sp_sid') || weekly;
    }
    ok('used every week, it still opens after 84 days', opened);
    clockAt += 7 * DAY;
    const late = await opens(weekly);
    ok('…and not 91 days after signing in, used or not', late === 401, String(late));
    clockAt = T0;
}

// ── 2. the password check ────────────────────────────────────────────────────
console.log('\n--- the password check ---');
{
    const a = await login();
    const short = await call('/api/auth/change', { method: 'POST', cookie: a, body: { currentPassword: PW, newPassword: 'ninechars' } });
    ok('a new password of 9 characters is refused', short.status === 400, `${short.status} ${JSON.stringify(short.body)}`);
    const ten = await call('/api/auth/change', { method: 'POST', cookie: a, body: { currentPassword: PW, newPassword: 'tencharsok' } });
    ok('…10 is enough', ten.status === 200, `${ten.status} ${JSON.stringify(ten.body)}`);

    auth.clearAuth();
    const setupShort = await call('/api/auth/setup', { method: 'POST', body: { password: 'ninechars' } });
    ok('a first password of 9 characters is refused too', setupShort.status === 400, String(setupShort.status));

    await setPassword('six666');
    ok('a shorter password set by an older version still signs in', !!(await login('six666')));

    const answer = auth.checkPassword('six666');
    ok('checking a password answers with a promise (scrypt off the main thread)', typeof answer?.then === 'function', typeof answer);
    await answer;
    const src = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
    ok('server/auth.js calls no scryptSync', !/scryptSync\s*\(/.test(src));

    // Thirty checks at once: two run, sixteen wait, the rest are told to come back.
    const load = auth.passwordCheckLoad?.();
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => auth.checkPassword(`guess ${i}`)));
    const busy = results.filter(r => r.status === 'rejected' && r.reason?.code === 'AUTH_BUSY').length;
    const after = auth.passwordCheckLoad?.();
    ok('at most two password checks run at once', !!load && after?.peak === 2, JSON.stringify(after));
    ok('…sixteen wait behind them and the rest are refused as busy', busy === 12, `${busy} refused`);
    ok('…and none is left running', after?.running === 0 && after?.waiting === 0, JSON.stringify(after));
    await setPassword(PW);
}

console.log('\n--- the throttle ---');
{
    const fake = (ip) => ({ ip, socket: { remoteAddress: ip }, headers: {} });
    clockAt += 31 * 60 * 1000;
    for (let i = 0; i < 20000; i++) auth.recordLoginFailure(fake(`198.18.${i >> 8}.${i & 255}`));
    const held = auth.loginThrottleSize();
    ok('twenty thousand addresses in one window cannot grow the record past its cap', held <= 10001, String(held));

    clockAt += 31 * 60 * 1000;
    for (let i = 1; i <= 8; i++) auth.recordLoginFailure(fake(`2001:db8:1:2::${i}`));
    ok('eight wrong guesses from one IPv6 /64 lock the whole /64', auth.loginBlocked(fake('2001:db8:1:2:ffff::9')) > 0);
    ok('…not the /64 beside it', auth.loginBlocked(fake('2001:db8:1:3::1')) === 0);
    for (let i = 1; i <= 8; i++) auth.recordLoginFailure(fake('::ffff:203.0.113.5'));
    ok('an IPv4 address written as IPv6 is still its own address', auth.loginBlocked(fake('::ffff:203.0.113.5')) > 0
        && auth.loginBlocked(fake('::ffff:203.0.113.6')) === 0);
    clockAt = T0 + 2 * DAY;
}

// ── 3. "this computer" ───────────────────────────────────────────────────────
console.log('\n--- with no password, a relayed request is not this computer ---');
{
    auth.clearAuth();
    clockAt += 31 * 60 * 1000;
    ok('this computer, asking directly, is in', await opens(undefined) === 200);
    ok('…at localhost too', await opens(undefined, { host: `localhost:${port}` }) === 200);
    const fwd = await call('/api/projects', { headers: { Forwarded: 'for=203.0.113.9;proto=https' } });
    ok('a request naming a proxy in Forwarded is refused and offered setup', fwd.status === 401 && fwd.body?.setupRequired === true, String(fwd.status));
    ok('…in Via too', (await call('/api/projects', { headers: { Via: '1.1 tunnel' } })).status === 401);
    ok('…in X-Forwarded-Host too', (await call('/api/projects', { headers: { 'X-Forwarded-Host': 'study.example.com' } })).status === 401);
    const named = await call('/api/projects', { host: 'study.example.com' });
    ok('a loopback request for a public name the app is fronted with is refused', named.status === 401, String(named.status));
    // A Debian or Ubuntu machine maps its own name to 127.0.1.1, so
    // http://<its name>:3001 opened on it arrives from loopback with that Host.
    const me = 'study-box';
    guard.setMachineNameForTest?.(me);
    const own = await call('/api/projects', { host: `${me}:${port}` });
    ok('this computer by its own name is in', own.status === 200, `${me}: ${own.status}`);
    ok('…in any case', await opens(undefined, { host: `STUDY-BOX:${port}` }) === 200);
    const dotted = [await opens(undefined, { host: `${me}.local:${port}` }), await opens(undefined, { host: `${me}.example.com:${port}` })];
    ok('…but not a name built on it (.local, a domain)', dotted.every(s => s === 401 || s === 403), dotted.join(', '));
    const proxied = await opens(undefined, { host: `${me}:${port}`, headers: { 'X-Forwarded-For': '203.0.113.9' } });
    ok('…and not through a proxy', proxied === 401 || proxied === 403, String(proxied));
    guard.setMachineNameForTest?.('study-box.example.com');
    const fqdn = await opens(undefined, { host: `study-box.example.com:${port}` });
    ok('a machine whose own name has a dot is not taken at its word', fqdn === 401 || fqdn === 403, String(fqdn));
    guard.setMachineNameForTest?.(hostname());
    const setup = await call('/api/auth/setup', { method: 'POST', headers: { Via: '1.1 tunnel' }, body: { password: PW } });
    ok('…and cannot set the first password without the code from the log', setup.status === 403 && !auth.isAuthEnabled(), String(setup.status));
}

console.log('\n--- the status says when the app is open beyond this computer ---');
{
    auth.clearAuth();
    const saved = { HOST: process.env.HOST, ALLOWED_HOSTS: process.env.ALLOWED_HOSTS };
    delete process.env.ALLOWED_HOSTS;
    process.env.HOST = '127.0.0.1';
    ok('loopback only, no password: not open beyond it', !(await call('/api/auth/status')).body?.exposed);
    process.env.HOST = '0.0.0.0';
    ok('HOST=0.0.0.0 with no password: it says so', (await call('/api/auth/status')).body?.exposed === true);
    process.env.HOST = '127.0.0.1';
    process.env.ALLOWED_HOSTS = 'study.example.com';
    ok('a public name in ALLOWED_HOSTS: it says so', (await call('/api/auth/status')).body?.exposed === true);
    delete process.env.ALLOWED_HOSTS;
    process.env.AUTH_ALLOW_OPEN_REMOTE = '1';
    ok('AUTH_ALLOW_OPEN_REMOTE=1: it says so', (await call('/api/auth/status')).body?.exposed === true);
    delete process.env.AUTH_ALLOW_OPEN_REMOTE;
    process.env.HOST = '0.0.0.0';
    await setPassword(PW);
    ok('with a password set it says nothing', !(await call('/api/auth/status', { cookie: await login() })).body?.exposed);
    process.env.HOST = saved.HOST;
    process.env.ALLOWED_HOSTS = saved.ALLOWED_HOSTS;
}

server.close();
try { db.close(); } catch { /* closing a closed handle */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
