// tools/device-access-gates.mjs — how another device gets into the app without
// the password (server/devices.js), proved on the REAL app.
//
// Run:  node tools/device-access-gates.mjs
//
// createApp() on a loopback port against a scratch library (DB_PATH, VAULT_ROOT
// and DATA_DIR set in-process). A request "from another device" is what
// `tailscale serve` or any loopback proxy delivers: a loopback socket carrying
// X-Forwarded-For, which `trust proxy: loopback` turns into req.ip.
//
//   1. With no password, a device the app does not know is refused and offered
//      setup — the behaviour before this change, which must survive it.
//   2. The computer's own Tailscale account is let in, and only when the
//      request looks like `tailscale serve` and nothing else: THIS computer's
//      tailnet name as Host, one relayed tailnet address, no other proxy's
//      headers. Another account, another machine's name, a tunnel's headers,
//      two hops, a carrier-NAT address with a public Host, the switch off and a
//      computer with no Tailscale are all refused.
//   3. A QR code is spent ONCE, within its ten minutes; wrong codes are
//      throttled; the device it connects is let in until it is removed, or
//      until it has gone unused for 180 days. The library holds a hash of the
//      device's key, never the key.
//   4. With a password set: Tailscale lets nobody in (its header is one any
//      program on this computer could send), a code costs the password, a
//      connected device cannot reach the API key, and a changed password ends
//      every connected device but the one that changed it.
//   5. The pure parts: which `tailscale serve` site is ours (never a Funnel
//      one), which port to take, an unreadable serve status refuses, a tagged
//      computer has no owner, device names.

import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'device-access-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';
delete process.env.AUTH_ALLOW_OPEN_REMOTE;

const B = new URL('../server/', import.meta.url).href;
const { default: db, DB_PATH } = await import(B + 'database.js');
const { createApp } = await import(B + 'app.js');
const auth = await import(B + 'auth.js');
const devices = await import(B + 'devices.js');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

if (!DB_PATH.startsWith(scratch)) { console.error(`refusing: the library is ${DB_PATH}, not the scratch one`); process.exit(2); }

// The instant is pinned: a gate never reads the wall clock. Code and keys
// expire against `Date.now`, so the checks below move this clock, not wait.
const T0 = Date.parse('2026-10-13T12:00:00Z');
let clockAt = T0;
Date.now = () => clockAt;

// A stand-in for the Tailscale CLI, for the whole run: a gate must never reach
// this machine's real Tailscale (with a guard mutated away, "Turn it on" once
// ran `tailscale serve` for this test server's port). `serveStatus` is what
// `serve status --json` answers (null = unreadable); every `serve --bg` is
// recorded and served.
const cli = { serveStatus: null, served: [], whois: {}, whoisRuns: 0 };
devices.setTailscaleRunnerForTest(async (args) => {
    if (args[0] === 'serve' && args[1] === 'status') return cli.serveStatus ? JSON.stringify(cli.serveStatus) : null;
    if (args[0] === 'serve' && args[1] === '--bg') {
        cli.served.push(args);
        if (!cli.serveStatus) return null;
        const httpsPort = args[2].split('=')[1];
        cli.serveStatus.TCP[httpsPort] = { HTTPS: true };
        cli.serveStatus.Web[`desk.tail1234.ts.net:${httpsPort}`] = { Handlers: { '/': { Proxy: args[3] } } };
        return '';
    }
    if (args[0] === 'whois') {
        cli.whoisRuns++;
        await new Promise(r => setTimeout(r, 30)); // a real CLI takes a moment
        return cli.whois[args[2]] ? JSON.stringify(cli.whois[args[2]]) : null;
    }
    return null; // status: injected through setTailscaleOwnerForTest
});

const server = createApp().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const port = server.address().port;

const OWNER = 'owner@example.com';
const PC = 'desk.tail1234.ts.net';             // this computer's tailnet name (setTailscaleOwnerForTest's default)
const PHONE = '192.168.1.50';
const TAILNET_PHONE = '100.101.2.3';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S936B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

/**
 * One request. `from` is the address a loopback proxy says it relayed (none =
 * this machine); `serve: true` makes it look exactly like `tailscale serve`
 * relaying a tailnet device signed in as `login` to this computer's name.
 */
function call(path, { method = 'GET', from, login, cookie, host, body, ua, headers: extra = {}, serve = false } = {}) {
    const headers = { 'Content-Type': 'application/json', Host: host || (serve ? PC : `127.0.0.1:${port}`) };
    if (serve) { headers['X-Forwarded-For'] = from || TAILNET_PHONE; headers['X-Forwarded-Proto'] = 'https'; headers['X-Forwarded-Host'] = host || PC; }
    else if (from) headers['X-Forwarded-For'] = from;
    if (login) headers['Tailscale-User-Login'] = login;
    if (cookie) headers.Cookie = cookie;
    if (ua) headers['User-Agent'] = ua;
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
const codeOf = (r) => (r.body?.url || '').split('#pair=')[1] || '';
/** A fresh code, asked for from this machine at a tailnet name (so there is an address to put in it). */
const freshCode = async (body) => codeOf(await call('/api/devices/pair', { method: 'POST', host: PC, body }));

// ── 1. the old refusal stands ───────────────────────────────────────────────
console.log('\n--- no password: an unknown device is refused ---');
{
    devices.setTailscaleOwnerForTest(null);
    ok('this machine is let in', (await call('/api/projects')).status === 200);
    const r = await call('/api/projects', { from: PHONE });
    ok('another device is refused with setupRequired', r.status === 401 && r.body?.setupRequired === true, JSON.stringify(r.body));
    const s = await call('/api/auth/status', { from: PHONE });
    ok('its status says setup is required', s.body?.setupRequired === true && s.body?.authenticated === false);
    ok('…and says nothing about Tailscale when the computer has none', s.body?.tailscale === undefined, s.body?.tailscale);
}

// ── 2. the computer's own Tailscale account ─────────────────────────────────
console.log('\n--- Tailscale: the computer\'s own account, through serve, and nothing else ---');
{
    devices.setTailscaleOwnerForTest(OWNER, PC);
    // Who Tailscale itself says owns each tailnet address (`tailscale whois`).
    devices.setTailscalePeersForTest({ [TAILNET_PHONE]: OWNER, '100.70.1.2': OWNER, '100.80.0.9': 'stranger@example.com' });
    const mine = await call('/api/projects', { serve: true, login: OWNER });
    ok('the owner\'s account through serve is let in', mine.status === 200, mine.status);
    ok('…whatever the case of the login', (await call('/api/projects', { serve: true, login: 'Owner@Example.com' })).status === 200);
    ok('…and its status says it is in', (await call('/api/auth/status', { serve: true, login: OWNER })).body?.authenticated === true);

    const other = await call('/api/projects', { serve: true, login: 'stranger@example.com' });
    ok('another Tailscale account is refused', other.status === 401);
    const ost = await call('/api/auth/status', { serve: true, login: 'stranger@example.com' });
    ok('…and told it is the wrong account, without the owner\'s login', ost.body?.tailscale === 'other-account' && !JSON.stringify(ost.body).includes(OWNER), JSON.stringify(ost.body));
    ok('a device not on Tailscale is told Tailscale would work', (await call('/api/auth/status', { from: PHONE })).body?.tailscale === 'available');

    // Everything that is not exactly `tailscale serve` relaying to THIS computer.
    ok('another machine\'s tailnet name as Host is refused', (await call('/api/projects', { serve: true, login: OWNER, host: 'other.tail1234.ts.net' })).status === 401);
    ok('a public Host (a tunnel forwarding headers) is refused, even from a carrier-NAT address',
        (await call('/api/projects', { login: OWNER, from: '100.70.1.2', host: 'study.example.com' })).status === 403);
    ok('two relayed hops are refused', (await call('/api/projects', { serve: true, login: OWNER, from: `${TAILNET_PHONE}, 100.70.1.2` })).status === 401);
    ok('a request carrying a tunnel\'s own header (cf-connecting-ip) is refused',
        (await call('/api/projects', { serve: true, login: OWNER, headers: { 'CF-Connecting-IP': '203.0.113.5' } })).status === 401);
    ok('the owner\'s login from a NON-tailnet address is refused', (await call('/api/projects', { serve: true, login: OWNER, from: PHONE })).status === 401);
    // A proxy that keeps a loopback Host but passes the client's X-Forwarded-Host
    // along (nginx's default): the forwarded name is a client's word.
    ok('a tailnet name only in X-Forwarded-Host, with a loopback Host, is refused',
        (await call('/api/projects', { login: OWNER, from: TAILNET_PHONE, host: `127.0.0.1:${port}`, headers: { 'X-Forwarded-Host': PC } })).status === 401);
    ok('an X-Forwarded-Host that disagrees with the Host is refused',
        (await call('/api/projects', { serve: true, login: OWNER, headers: { 'X-Forwarded-Host': 'other.tail1234.ts.net' } })).status === 401);
    ok('a relayed address Tailscale says belongs to someone else is refused, whatever the header says',
        (await call('/api/projects', { serve: true, login: OWNER, from: '100.80.0.9' })).status === 401);
    ok('a relayed address that is no peer at all (carrier NAT) is refused', (await call('/api/projects', { serve: true, login: OWNER, from: '100.99.9.9' })).status === 401);
    ok('…and the owner refused like that is not told "a different account"',
        (await call('/api/auth/status', { serve: true, login: OWNER, from: '100.80.0.9' })).body?.tailscale === undefined);

    // Through the real whois path (the stand-in CLI), not the injected map.
    devices.setTailscalePeersForTest(null);
    cli.whois = { '100.88.1.1': { UserProfile: { LoginName: OWNER } }, '100.88.1.2': { Node: { Tags: ['tag:server'] }, UserProfile: { LoginName: OWNER } } };
    cli.whoisRuns = 0;
    const burst = await Promise.all(Array.from({ length: 12 }, () => call('/api/projects', { serve: true, login: OWNER, from: '100.88.1.1' })));
    ok('a page load of 12 requests is let in through whois…', burst.every(r => r.status === 200), burst.map(r => r.status).join(','));
    ok('…on ONE whois run, not twelve', cli.whoisRuns === 1, cli.whoisRuns);
    ok('a tagged device whois gives the owner\'s profile is refused', (await call('/api/projects', { serve: true, login: OWNER, from: '100.88.1.2' })).status === 401);
    devices.setTailscalePeersForTest({ [TAILNET_PHONE]: OWNER, '100.70.1.2': OWNER, '100.80.0.9': 'stranger@example.com' });

    // The switch.
    ok('the switch is refused through the generic settings route',
        (await call('/api/settings/auth_tailscale_trust', { method: 'PUT', body: { value: 'on' } })).status >= 400);
    const dump = await call('/api/settings');
    ok('…and is not in the settings dump', dump.status === 200 && !JSON.stringify(dump.body).includes('auth_tailscale_trust'));
    ok('its own route rejects a non-boolean', (await call('/api/devices/tailscale', { method: 'PUT', body: { on: 'off' } })).status === 400);
    ok('turning it off…', (await call('/api/devices/tailscale', { method: 'PUT', body: { on: false } })).body?.on === false);
    ok('…refuses the owner\'s account', (await call('/api/projects', { serve: true, login: OWNER })).status === 401);
    ok('…and the lock screen stops offering Tailscale', (await call('/api/auth/status', { from: PHONE })).body?.tailscale === undefined);
    await call('/api/devices/tailscale', { method: 'PUT', body: { on: true } });
    ok('turned back on, it lets the owner in again', (await call('/api/projects', { serve: true, login: OWNER })).status === 200);

    devices.setTailscaleOwnerForTest(null);
    ok('a computer with no Tailscale lets no Tailscale login in', (await call('/api/projects', { serve: true, login: OWNER })).status === 401);
    const list = await call('/api/devices');
    ok('the devices list reports no Tailscale login then', list.status === 200 && list.body?.tailscale?.login === null, JSON.stringify(list.body?.tailscale));
}

// ── 3. the QR code ───────────────────────────────────────────────────────────
console.log('\n--- a QR code connects ONE device, once, for ten minutes ---');
let phoneCookie = '';
{
    // Opened from this machine at its own address, and no Tailscale site
    // proxies to this test port: there is nowhere a phone could go.
    const none = await call('/api/devices/pair', { method: 'POST' });
    ok('with no address a phone could reach, there is no code', none.status === 200 && none.body?.url === null, JSON.stringify(none.body));

    const offer = await call('/api/devices/pair', { method: 'POST', host: PC });
    const url = offer.body?.url || '';
    ok('the code opens the address this page was opened at', url.startsWith(`http://${PC}/#pair=`), url);
    const code = codeOf(offer);
    ok('the code is in the fragment and long enough not to guess (≥ 32 chars)', code.length >= 32, code.length);

    ok('a wrong code is refused', (await call('/api/auth/pair', { method: 'POST', from: PHONE, body: { code: 'x'.repeat(code.length) } })).status === 403);
    const claimed = await call('/api/auth/pair', { method: 'POST', from: PHONE, body: { code }, ua: ANDROID });
    phoneCookie = cookieOf(claimed, 'sp_dev');
    ok('the right code connects the device and gives it a cookie', claimed.status === 200 && phoneCookie.length > 40, claimed.status);
    ok('the cookie is HttpOnly and lasts 400 days', /HttpOnly/.test(claimed.setCookie.join()) && /Max-Age=34560000/.test(claimed.setCookie.join()));
    ok('the same code a second time is refused', (await call('/api/auth/pair', { method: 'POST', from: '192.168.1.51', body: { code } })).status === 403);

    ok('the connected device is let in', (await call('/api/projects', { from: PHONE, cookie: phoneCookie })).status === 200);
    ok('…from any address (it is the key, not the network)', (await call('/api/projects', { from: '203.0.113.9', cookie: phoneCookie })).status === 200);
    const st = await call('/api/auth/status', { from: PHONE, cookie: phoneCookie });
    ok('…and its status says it is in', st.body?.authenticated === true && !st.body?.setupRequired, JSON.stringify(st.body));

    const quit = await call('/api/desktop/quit', { method: 'POST', from: PHONE, cookie: phoneCookie });
    ok('a connected device may not press the computer\'s own controls (quit, open folder…)', quit.status === 403, quit.status);
    ok('…which this computer itself still reaches', (await call('/api/desktop/quit', { method: 'POST' })).status !== 403);

    const rows = db.prepare('SELECT * FROM auth_devices').all();
    const key = decodeURIComponent(phoneCookie.split('=')[1]);
    ok('one device is recorded, named from its browser', rows.length === 1 && rows[0].name === 'Chrome on Android', JSON.stringify(rows.map(r => r.name)));
    ok('the library holds the key\'s SHA-256, never the key',
        rows[0].token_hash === crypto.createHash('sha256').update(key).digest('hex') && !JSON.stringify(rows).includes(key));
    ok('the list marks the device asking as the current one', (await call('/api/devices', { from: PHONE, cookie: phoneCookie })).body?.devices?.[0]?.current === true);

    // Ten minutes.
    const lateCode = await freshCode();
    clockAt = T0 + 10 * 60 * 1000 + 1000;
    const expired = await call('/api/auth/pair', { method: 'POST', from: '192.168.1.52', body: { code: lateCode } });
    clockAt = T0;
    ok('a code past its ten minutes is refused', expired.status === 403);
    ok('…and stays spent afterwards', (await call('/api/auth/pair', { method: 'POST', from: '192.168.1.52', body: { code: lateCode } })).status === 403);

    const first = await freshCode();
    await freshCode();
    ok('showing a new code retires the one before it', (await call('/api/auth/pair', { method: 'POST', from: '192.168.1.53', body: { code: first } })).status === 403);

    // Guessing is throttled like a password.
    let last = null;
    for (let i = 0; i < 9; i++) last = await call('/api/auth/pair', { method: 'POST', from: '192.168.1.99', body: { code: 'y'.repeat(32) } });
    ok('the ninth wrong code from one address is a 429', last.status === 429, last.status);

    // 180 days unused.
    const idle = await call('/api/auth/pair', { method: 'POST', from: '192.168.1.60', body: { code: await freshCode() } });
    const idleCookie = cookieOf(idle, 'sp_dev');
    const idleId = db.prepare('SELECT id FROM auth_devices ORDER BY id DESC LIMIT 1').get().id;
    db.prepare('UPDATE auth_devices SET last_seen_at = ? WHERE id = ?').run(new Date(T0 - 181 * 86400000).toISOString(), idleId);
    ok('a device unused for 180 days is refused', (await call('/api/projects', { from: '192.168.1.60', cookie: idleCookie })).status === 401);
    ok('…and forgotten', !db.prepare('SELECT 1 FROM auth_devices WHERE id = ?').get(idleId));
}

// ── "Turn it on" ─────────────────────────────────────────────────────────────
console.log('\n--- "Turn it on" passes the app on to the tailnet, and never takes another site\'s port ---');
{
    devices.setTailscaleOwnerForTest(OWNER, PC);
    cli.serveStatus = null;
    const unread = await call('/api/devices/tailscale/serve', { method: 'POST' });
    ok('with the serve status unreadable it runs nothing and names no command',
        cli.served.length === 0 && unread.body?.url === null && unread.body?.failed === true && unread.body?.command === null, JSON.stringify(unread.body));

    cli.serveStatus = { TCP: { 443: { HTTPS: true } }, Web: { 'desk.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3001' } } } } };
    const pair = await call('/api/devices/pair', { method: 'POST' });
    ok('Show code says Tailscale runs but does not pass this app on yet', pair.body?.url === null && pair.body?.tailscale === true, JSON.stringify(pair.body));
    ok('…and the devices list says it is not served', (await call('/api/devices')).body?.tailscale?.served === false);
    const on = await call('/api/devices/tailscale/serve', { method: 'POST' });
    ok('Turn it on serves THIS port on the first free HTTPS port, never 443 that another copy holds',
        JSON.stringify(cli.served.at(-1)) === JSON.stringify(['serve', '--bg', '--https=8443', `http://127.0.0.1:${port}`]), JSON.stringify(cli.served));
    ok('…and answers with a code at that address', (on.body?.url || '').startsWith('https://desk.tail1234.ts.net:8443/#pair='), on.body?.url);
    ok('…after which the list says it is served', (await call('/api/devices')).body?.tailscale?.served === true);
    const again = await call('/api/devices/tailscale/serve', { method: 'POST' });
    ok('pressed again it changes nothing', cli.served.length === 1 && (again.body?.url || '').startsWith('https://desk.tail1234.ts.net:8443/'));
    cli.serveStatus = null;
    devices.setTailscaleOwnerForTest(null);
}

// ── 4. with a password ─────────────────────────────────────────────────────────
console.log('\n--- with a password set ---');
{
    // A second connected device, so a password change has something to end.
    const other = await call('/api/auth/pair', { method: 'POST', from: '192.168.1.70', body: { code: await freshCode() } });
    const otherCookie = cookieOf(other, 'sp_dev');

    const third = await call('/api/auth/pair', { method: 'POST', from: '192.168.1.71', body: { code: await freshCode() } });
    const thirdCookie = cookieOf(third, 'sp_dev');
    ok('the FIRST password set on the computer…',
        (await call('/api/auth/setup', { method: 'POST', body: { password: 'first pass' } })).status === 200);
    ok('…ends every connected device (no password was what let them in)',
        (await call('/api/projects', { from: '192.168.1.71', cookie: thirdCookie })).status === 401
        && (await call('/api/projects', { from: '192.168.1.70', cookie: otherCookie })).status === 401
        && (await call('/api/projects', { from: PHONE, cookie: phoneCookie })).status === 401);
    const login1 = cookieOf(await call('/api/auth/login', { method: 'POST', body: { password: 'first pass' } }), 'sp_sid');
    const pairWith = async (pw) => codeOf(await call('/api/devices/pair', { method: 'POST', host: PC, cookie: login1, body: { password: pw } }));
    phoneCookie = cookieOf(await call('/api/auth/pair', { method: 'POST', from: PHONE, body: { code: await pairWith('first pass') } }), 'sp_dev');
    const otherCookie2 = cookieOf(await call('/api/auth/pair', { method: 'POST', from: '192.168.1.70', body: { code: await pairWith('first pass') } }), 'sp_dev');
    ok('devices connected after it (the code given with the password) are let in',
        (await call('/api/projects', { from: PHONE, cookie: phoneCookie })).status === 200
        && (await call('/api/projects', { from: '192.168.1.70', cookie: otherCookie2 })).status === 200);
    auth.setPassword('correct horse');
    devices.setTailscaleOwnerForTest(OWNER, PC);
    ok('an unknown device now meets the password', (await call('/api/projects', { from: PHONE })).status === 401);
    ok('Tailscale alone lets nobody in (its header is one a local program could send)',
        (await call('/api/projects', { serve: true, login: OWNER })).status === 401);
    ok('…and the lock screen does not offer it', (await call('/api/auth/status', { serve: true, login: 'stranger@example.com' })).body?.tailscale === undefined);
    ok('the connected device is still let in', (await call('/api/projects', { from: PHONE, cookie: phoneCookie })).status === 200);
    const key = await call('/api/auth/apikey', { from: PHONE, cookie: phoneCookie });
    ok('…but cannot read the API key, and is not locked out for asking (403, no authRequired)', key.status === 403 && !key.body?.authRequired, JSON.stringify(key.body));

    const login = await call('/api/auth/login', { method: 'POST', body: { password: 'correct horse' } });
    const session = cookieOf(login, 'sp_sid');
    ok('a password session reads the API key', (await call('/api/auth/apikey', { cookie: session })).status === 200);
    ok('a code without the password is refused', (await call('/api/devices/pair', { method: 'POST', host: PC, cookie: session })).status === 403);
    ok('…with a wrong one too', (await call('/api/devices/pair', { method: 'POST', host: PC, cookie: session, body: { password: 'wrong' } })).status === 403);
    ok('…and given with it', codeOf(await call('/api/devices/pair', { method: 'POST', host: PC, cookie: session, body: { password: 'correct horse' } })).length >= 32);
    const servedBefore = cli.served.length;
    cli.serveStatus = { TCP: {}, Web: {} };
    ok('"Turn it on" asks for it as well, and runs nothing without it',
        (await call('/api/devices/tailscale/serve', { method: 'POST', cookie: session })).status === 403 && cli.served.length === servedBefore);
    cli.serveStatus = null;

    const changed = await call('/api/auth/change', { method: 'POST', from: PHONE, cookie: phoneCookie, body: { currentPassword: 'correct horse', newPassword: 'battery staple' } });
    ok('the connected phone changes the password', changed.status === 200, JSON.stringify(changed.body));
    ok('…every OTHER connected device is ended', (await call('/api/projects', { from: '192.168.1.70', cookie: otherCookie2 })).status === 401);
    ok('…the one that changed it is not', (await call('/api/projects', { from: PHONE, cookie: phoneCookie })).status === 200);
    devices.setTailscaleOwnerForTest(null);
    auth.clearAuth();
}

// ── removing a device ──────────────────────────────────────────────────────────
console.log('\n--- removing a device ends it ---');
{
    const id = db.prepare('SELECT id FROM auth_devices').get().id;
    ok('remove answers ok', (await call(`/api/devices/${id}`, { method: 'DELETE' })).body?.ok === true);
    const after = await call('/api/projects', { from: PHONE, cookie: phoneCookie });
    ok('the removed device is refused on its next request', after.status === 401 && after.body?.setupRequired === true, after.status);
    ok('removing it again is a 404', (await call(`/api/devices/${id}`, { method: 'DELETE' })).status === 404);
}

// ── 5. the pure parts ──────────────────────────────────────────────────────────
console.log('\n--- the pure parts ---');
{
    const serve = { TCP: { 10000: {}, 443: {}, 8443: {} }, Web: {
        'pc.tail.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8780' } } },
        'pc.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3001' } } },
        'pc.tail.ts.net:8443': { Handlers: { '/': { Proxy: 'https+insecure://localhost:3002' } } },
    } };
    ok('the serve site proxying to our port is ours, port 443 left out', devices.servedAddress(serve, 3001) === 'https://pc.tail.ts.net');
    ok('another port keeps its number, https+insecure included', devices.servedAddress(serve, 3002) === 'https://pc.tail.ts.net:8443');
    ok('no site for our port is null', devices.servedAddress(serve, 4000) === null && devices.servedAddress(null, 3001) === null);
    ok('a site on Funnel (the public internet) is never handed to a phone',
        devices.servedAddress({ ...serve, AllowFunnel: { 'pc.tail.ts.net:443': true } }, 3001) === null);

    // `tailscale serve --https=443` REPLACES what is there (the installed copy, on this machine).
    ok('443 is used when nothing holds it', devices.chooseServePort({}) === 443);
    ok('…and skipped when a site holds it, and so is every port in use', devices.chooseServePort(serve) === 8444
        && devices.chooseServePort({ TCP: { 443: {}, 8443: {}, 8444: {} } }) === 8445);
    ok('an unreadable serve status REFUSES rather than reading as "nothing served"', devices.planServe(null, 3140, false).refuse === true);
    ok('an already-served port is used as it is', devices.planServe(serve, 3001, false).url === 'https://pc.tail.ts.net');
    ok('the command serves on the tailnet only (never Funnel), plain http to loopback',
        JSON.stringify(devices.planServe(serve, 3140, false).args) === JSON.stringify(['serve', '--bg', '--https=8444', 'http://127.0.0.1:3140']));
    ok('…and https+insecure when the app does its own TLS', devices.serveArgs(443, 3001, true).at(-1) === 'https+insecure://localhost:3001');

    const status = (extra = {}) => ({ BackendState: 'Running', Self: { UserID: 7, DNSName: 'PC.tail.ts.net.', ...extra }, User: { 7: { LoginName: 'me@x.org' } } });
    ok('this computer is its own user\'s login and its own tailnet name', JSON.stringify(devices.ownerFromStatus(status())) === JSON.stringify({ login: 'me@x.org', host: 'pc.tail.ts.net' }));
    ok('a TAGGED computer has no owner', devices.ownerFromStatus(status({ Tags: ['tag:server'] })) === null);
    ok('a stopped Tailscale has no owner', devices.ownerFromStatus({ ...status(), BackendState: 'Stopped' }) === null);
    ok('no status has no owner', devices.ownerFromStatus(null) === null);

    const fake = (remote, xff, host = PC) => ({ headers: { 'tailscale-user-login': OWNER, 'x-forwarded-for': xff, host }, socket: { remoteAddress: remote }, ip: xff.split(',').pop().trim() });
    ok('serve\'s claim over loopback from one tailnet address is read, with the address', devices.tailscaleLoginOf(fake('127.0.0.1', '100.64.0.1'))?.ip === '100.64.0.1');
    ok('…not from a socket that is not loopback (someone reached the port directly)', devices.tailscaleLoginOf(fake('192.168.1.9', '100.64.0.1')) === null);
    ok('…not when the relayed address is not a tailnet one', devices.tailscaleLoginOf(fake('127.0.0.1', '192.168.1.9')) === null);
    ok('…not for a Host that is not a .ts.net name', devices.tailscaleLoginOf(fake('127.0.0.1', '100.64.0.1', 'study.example.com')) === null);
    ok('whois: the login of an untagged peer', devices.loginFromWhois({ UserProfile: { LoginName: ' me@x.org ' } }) === 'me@x.org');
    ok('whois: a TAGGED peer, no profile, no answer are nobody',
        devices.loginFromWhois({ Node: { Tags: ['tag:ci'] }, UserProfile: { LoginName: 'me@x.org' } }) === null
        && devices.loginFromWhois({ Node: {} }) === null && devices.loginFromWhois(null) === null);
    ok('…not for a .local Host either', devices.tailscaleLoginOf(fake('127.0.0.1', '100.64.0.1', 'pc.local')) === null);
    ok('the tailnet range has both edges', devices.isTailnetAddress('100.127.255.254') && !devices.isTailnetAddress('100.128.0.1') && !devices.isTailnetAddress('100.63.255.255') && devices.isTailnetAddress('fd7a:115c:a1e0::1'));

    ok('device names', devices.deviceName(ANDROID) === 'Chrome on Android'
        && devices.deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1') === 'Safari on iPhone'
        && devices.deviceName('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36') === 'Samsung Internet on Android'
        && devices.deviceName('') === 'Device');
}

server.close();
try { db.close(); } catch { /* closing a closed handle */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
