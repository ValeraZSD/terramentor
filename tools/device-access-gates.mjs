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
// this machine's real Tailscale (a missing guard would let "Turn it on" run
// `tailscale serve` for this test server's port). `serveStatus` is what
// `serve status --json` answers (null = unreadable); every `serve --bg` is
// recorded and served.
// `serveAnswer`, when set, is what `serve --bg` answers instead of serving:
// the CLI's own output in a failure (`{ failed, stdout, stderr, timedOut }`)
// or a success's stdout that served nothing.
const cli = { serveStatus: null, served: [], whois: {}, whoisRuns: 0, serveAnswer: undefined };
devices.setTailscaleRunnerForTest(async (args, _timeout, options) => {
    if (args[0] === 'serve' && args[1] === 'status') return cli.serveStatus ? JSON.stringify(cli.serveStatus) : null;
    if (args[0] === 'serve' && args[1] === '--bg') {
        cli.served.push(args);
        cli.serveOptions = options;
        if (cli.statusGoesAfterServe) cli.serveStatus = null;
        if (cli.serveAnswer !== undefined) return cli.serveAnswer;
        if (!cli.serveStatus) return null;
        const httpsPort = args[2].split('=')[1];
        cli.serveStatus.TCP[httpsPort] = { HTTPS: true };
        cli.serveStatus.Web[`desk.tail1234.ts.net:${httpsPort}`] = { Handlers: { '/': { Proxy: args[3] } } };
        return '';
    }
    if (args[0] === 'whois') {
        cli.whoisRuns++;
        await new Promise(r => setTimeout(r, 30)); // a real CLI takes a moment
        if (cli.whois[args[2]]?.failed) return cli.whois[args[2]]; // the CLI ran and failed: what it printed
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
                resolve({ status: res.statusCode, body: json, setCookie: res.headers['set-cookie'] || [], headers: res.headers });
            });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}
const cookieOf = (r, name) => (r.setCookie.find(c => c.startsWith(`${name}=`)) || '').split(';')[0];
const codeOf = (r) => (r.body?.url || '').split('#pair=')[1] || '';
/**
 * A code asked for from this machine (loopback, Host 127.0.0.1) while
 * `tailscale serve` passes this test port on to the tailnet, so there is an
 * address to put in it. Asking at the tailnet NAME over loopback is not this
 * machine: a request with a Host that is not a loopback name was addressed to
 * the app from elsewhere (auth.js isLocalRequest).
 */
const servedHere = () => ({ TCP: { 443: { HTTPS: true } }, Web: { [`${PC}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } });
async function pairHere(body) {
    const saved = cli.serveStatus;
    cli.serveStatus = servedHere();
    try { return await call('/api/devices/pair', { method: 'POST', body }); } finally { cli.serveStatus = saved; }
}
const freshCode = async (body) => codeOf(await pairHere(body));

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
    // A run that failed now carries what the CLI said: it must still read as
    // "no answer" (refused, and asked again), never be cached as somebody.
    cli.whois['100.88.1.4'] = { failed: true, stdout: '', stderr: 'failed to connect to local Tailscale service; is Tailscale running?\n' };
    const runsBefore = cli.whoisRuns;
    const failedOnce = await call('/api/projects', { serve: true, login: OWNER, from: '100.88.1.4' });
    const failedTwice = await call('/api/projects', { serve: true, login: OWNER, from: '100.88.1.4' });
    ok('a whois that failed is refused, and is not remembered: the next request asks again',
        failedOnce.status === 401 && failedTwice.status === 401 && cli.whoisRuns - runsBefore === 2, `${failedOnce.status} ${failedTwice.status} runs ${cli.whoisRuns - runsBefore}`);
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

// ── 2b. which page may write, behind `tailscale serve` ─────────────────────
// serve adds X-Forwarded-Proto to every request it relays, and the owner's
// account is let in by the login it adds, with no cookie. The origin guard
// used to accept ANY local-network Origin once X-Forwarded-Proto was there,
// so on a browser that sends no Sec-Fetch-Site (Safari before 16.4) a page
// on the LAN or another tailnet device, opened on the owner's phone, could
// write to the library through serve (cloud review #28). No Sec-Fetch-Site
// is sent here, so the Origin check is the one that decides.
console.log('\n--- behind tailscale serve, only the app\'s own page may write ---');
{
    devices.setTailscaleOwnerForTest(OWNER, PC);
    devices.setTailscalePeersForTest({ [TAILNET_PHONE]: OWNER });
    const projects = () => db.prepare('SELECT COUNT(*) c FROM projects').get().c;
    const write = (origin, extra = {}) => call('/api/projects', { method: 'POST', serve: true, login: OWNER, headers: { Origin: origin }, body: { name: 'Fixture: written through serve' }, ...extra });
    let n = projects();
    // The control: this passes on the pre-#125 guard too. The refusals below
    // are what fail there.
    const own = await write(`https://${PC}`);
    ok('the app\'s own page (its tailnet name, https) writes', own.status === 200 && projects() === n + 1, `${own.status} ${JSON.stringify(own.body)}`);
    for (const [label, origin] of [
        ['a page on another LAN device', 'http://192.168.1.5:8080'],
        ['a page on another tailnet device', 'https://other.tail1234.ts.net'],
        ['the app\'s own name over http', `http://${PC}`],
        ['the app\'s own name on another port', `https://${PC}:8443`],
    ]) {
        n = projects();
        const r = await write(origin);
        ok(`${label} is refused (${origin})`, r.status === 403 && projects() === n, `${r.status} ${JSON.stringify(r.body)}`);
    }
    // The cloud review's reproduction: on loopback, no serve, the header alone.
    const logout = await call('/api/auth/logout', { method: 'POST', headers: { Origin: 'http://192.168.1.5:8080', 'X-Forwarded-Proto': 'http' } });
    ok('X-Forwarded-Proto alone does not admit a LAN origin on loopback', logout.status === 403, `${logout.status} ${JSON.stringify(logout.body)}`);
    // A proxy that rewrites Host names the host it served in X-Forwarded-Host;
    // a page on exactly that host, under the forwarded scheme, is its own.
    // It is another device, so with no password set the password gate answers.
    const proxied = (origin) => call('/api/projects', { headers: { Origin: origin, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': '192.168.1.20:8443' } });
    const mine = await proxied('https://192.168.1.20:8443');
    ok('a Host-rewriting proxy\'s own page gets past the origin guard, to the password gate',
        mine.status === 401 && mine.body?.setupRequired === true, `${mine.status} ${JSON.stringify(mine.body)}`);
    const beside = await proxied('https://192.168.1.21:8443');
    ok('…and a page on any other host behind it is refused as cross-origin', beside.status === 403, `${beside.status} ${JSON.stringify(beside.body)}`);
    devices.setTailscaleOwnerForTest(null);
}

// ── 3. the QR code ───────────────────────────────────────────────────────────
console.log('\n--- a QR code connects ONE device, once, for ten minutes ---');
let phoneCookie = '';
{
    // Opened from this machine at its own address, and no Tailscale site
    // proxies to this test port: there is nowhere a phone could go.
    const none = await call('/api/devices/pair', { method: 'POST' });
    ok('with no address a phone could reach, there is no code', none.status === 200 && none.body?.url === null, JSON.stringify(none.body));

    const offer = await pairHere();
    const url = offer.body?.url || '';
    ok('the code opens the tailnet address that passes this app on', url.startsWith(`https://${PC}/#pair=`), url);
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
    // Updating is the computer's own control too: a device reads the update
    // panel but presses nothing on it.
    const pressed = [];
    for (const [method, path] of [['POST', '/api/updates/download'], ['POST', '/api/updates/restart'], ['POST', '/api/updates/cancel'],
        ['POST', '/api/updates/check'], ['PUT', '/api/updates/auto'], ['PUT', '/api/updates/channel']]) {
        pressed.push(`${path} ${(await call(path, { method, from: PHONE, cookie: phoneCookie, body: {} })).status}`);
    }
    ok('a connected device may not download, install or set up updates', pressed.every((p) => p.endsWith(' 403')), pressed.join(', '));
    const panel = await call('/api/updates', { from: PHONE, cookie: phoneCookie });
    ok('…but reads the update panel, which says it may not press', panel.status === 200 && panel.body?.controls === false, JSON.stringify(panel.body?.controls));
    ok('…while this computer may', (await call('/api/updates')).body?.controls === true);
    // The page replaces its whole status with whichever update answer came
    // last, so a press's answer says it too (a check, a dismissed note).
    const pressedHere = await call('/api/updates/result/dismiss', { method: 'POST' });
    ok('…and a press\'s answer says so as well', pressedHere.status === 200 && pressedHere.body?.controls === true, JSON.stringify(pressedHere.body?.controls));
    ok('…which this computer itself still presses', (await call('/api/updates/download', { method: 'POST' })).status !== 403);
    // Where the app sends prompts and documents is the computer's to decide
    // too (server/settingsSchema.js, the 'network' rows): a device changes the
    // theme and the feed, not the addresses or the provider.
    const moved = [];
    for (const [key, value] of [['ai_openai_base_url', 'https://elsewhere.example/v1'], ['ai_ollama_url', 'http://192.168.1.9:11434'],
        ['searxng_url', 'https://searx.elsewhere.example'], ['ai_provider', 'openai']]) {
        moved.push(`${key} ${(await call(`/api/settings/${key}`, { method: 'PUT', from: PHONE, cookie: phoneCookie, body: { value } })).status}`);
    }
    ok('a connected device may not move where the app sends requests', moved.every((m) => m.endsWith(' 403')), moved.join(', '));
    const landed = db.prepare(`SELECT key, value FROM settings WHERE (key IN ('ai_openai_base_url', 'searxng_url') AND value LIKE '%elsewhere%')
        OR (key = 'ai_ollama_url' AND value = 'http://192.168.1.9:11434') OR (key = 'ai_provider' AND value = 'openai')`).all();
    ok('…nor did anything it sent land', landed.length === 0, JSON.stringify(landed));
    ok('…while it still saves an ordinary preference', (await call('/api/settings/theme', { method: 'PUT', from: PHONE, cookie: phoneCookie, body: { value: 'dark' } })).status === 200);
    ok('…and this computer still moves the address', (await call('/api/settings/searxng_url', { method: 'PUT', body: { value: 'https://searx.example.org' } })).status === 200);
    for (const key of ['desktop_keep_running', 'desktop_window_mode', 'desktop_autostart_window']) {
        const r = await call(`/api/settings/${key}`, { method: 'PUT', from: PHONE, cookie: phoneCookie, body: { value: 'false' } });
        ok(`the desktop's ${key} is not reachable around /api/desktop through the settings writer`, r.status === 403, r.status);
    }
    // The same rows are written by the model connections, the key, the
    // OpenRouter sign-in and the embeddings provider: none of those doors is
    // open to the device either. The guard answers before the handler, so a
    // connection id that does not exist still shows which side refused.
    const rerouted = [];
    for (const [method, path, body] of [
        ['POST', '/api/ai/connections', { kind: 'ollama', baseUrl: 'http://192.168.1.9:11434', use: true, saveAnyway: true }],
        ['POST', '/api/ai/connections', { kind: 'ollama', baseUrl: 'http://192.168.1.9:11434', testOnly: true }],
        ['POST', '/api/ai/connections/1/use', {}], ['PATCH', '/api/ai/connections/1', { baseUrl: 'http://192.168.1.9:11434' }],
        ['DELETE', '/api/ai/connections/1', undefined], ['PUT', '/api/ai/key', { apiKey: 'sk-test', baseUrl: 'https://elsewhere.example/v1' }],
        ['DELETE', '/api/ai/key', undefined], ['POST', '/api/ai/openrouter/start', {}], ['POST', '/api/ai/openrouter/finish', { code: 'x' }],
        ['POST', '/api/embeddings/settings', { provider: 'openai' }],
        ['PUT', '/api/ai/jobs/conversation', { route: [{ connectionId: 1, model: 'elsewhere' }] }], ['DELETE', '/api/ai/jobs', undefined],
    ]) {
        rerouted.push(`${method} ${path} ${(await call(path, { method, from: PHONE, cookie: phoneCookie, body })).status}`);
    }
    ok('a connected device may not add, edit, choose or remove a model connection, give a job its models, bind a key, or pick the embeddings provider',
        rerouted.every((r) => r.endsWith(' 403')), rerouted.join(', '));
    ok('…nor did the embeddings provider move', (db.prepare(`SELECT value FROM settings WHERE key = 'embedding_provider'`).get()?.value ?? '') !== 'openai');
    // A connection this computer saved (a local server that is off: nothing
    // answers on port 9, so its test fails fast and leaves the machine).
    const saved = await call('/api/ai/connections', { method: 'POST', body: { kind: 'ollama', baseUrl: 'http://127.0.0.1:9', saveAnyway: true } });
    const reads = await call('/api/ai/connections', { from: PHONE, cookie: phoneCookie });
    // The computer gives one job a list, and the device reads it back.
    const assigned = await call('/api/ai/jobs/checks', { method: 'PUT', body: { route: [{ connectionId: saved.body?.id, model: 'device-read-model' }] } });
    const readsJobs = await call('/api/ai/jobs', { from: PHONE, cookie: phoneCookie });
    const checksRoute = readsJobs.body?.routes?.checks ?? [];
    ok('…while it still reads which model each job runs on',
        assigned.status === 200 && readsJobs.status === 200
            && checksRoute.some((e) => e.connectionId === saved.body?.id && e.model === 'device-read-model'),
        `assign ${assigned.status} ${JSON.stringify(assigned.body?.error ?? '')}, read ${readsJobs.status} ${JSON.stringify(checksRoute)}`);
    const testsOne = await call(`/api/ai/connections/${saved.body?.id}/test`, { method: 'POST', from: PHONE, cookie: phoneCookie });
    ok('…while it still reads the connections and tests a saved one',
        saved.status === 200 && reads.status === 200 && testsOne.status === 200, `saved ${saved.status} ${JSON.stringify(saved.body?.error ?? '')}, read ${reads.status}, test ${testsOne.status}`);
    ok('…and this computer still picks the embeddings provider', (await call('/api/embeddings/settings', { method: 'POST', body: { provider: 'auto' } })).status === 200);

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

// ── when Tailscale says no ──────────────────────────────────────────────────
// What the real CLI prints (tailscale/tailscale cmd/tailscale/cli): with Serve
// not yet turned on for the tailnet it prints a login.tailscale.com/f/serve
// link to STDOUT and then WAITS for it to be turned on (the app's timeout
// kills it), or, on some tailnets, exits 0 having served nothing. Each kind
// of no must reach the learner as its own line, and the log as its kind.
console.log('\n--- when Tailscale says no, the learner reads why, and the log says which kind ---');
{
    devices.setTailscaleOwnerForTest(OWNER, PC);
    const fresh = () => ({ TCP: {}, Web: {} });
    const LINK = 'https://login.tailscale.com/f/serve?node=nX7kQ2CNTRL';
    const ENABLE_OUT = `\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         ${LINK}\n\n`;
    const logged = () => db.prepare(`SELECT level, area, event, detail FROM activity_log WHERE area = 'devices' ORDER BY id DESC LIMIT 1`).get();
    const press = async (answer) => {
        cli.serveStatus = fresh();
        cli.serveAnswer = answer;
        try { return (await call('/api/devices/tailscale/serve', { method: 'POST' })).body; } finally { cli.serveAnswer = undefined; }
    };

    const waiting = await press({ failed: true, timedOut: true, stdout: ENABLE_OUT, stderr: '' });
    ok('Serve not turned on (the CLI printed its link and waited): the problem is "enable", with that link',
        waiting?.url === null && waiting?.problem?.kind === 'enable' && waiting.problem.link === LINK, JSON.stringify(waiting));
    const logRow = logged();
    ok('…and the log has the attempt and its kind, never the CLI\'s text or the link',
        logRow?.event === 'tailscale.serve_failed' && logRow.level === 'warn' && /\benable\b/.test(logRow.detail || '') && !/login\.tailscale|visit|node=/i.test(logRow.detail || ''), JSON.stringify(logRow));

    const exited = await press(ENABLE_OUT); // exit 0, nothing served
    ok('…and the press asks the run to stop at the link rather than wait out its timeout', cli.serveOptions?.stopOn === devices.ENABLE_LINK);
    ok('…the same when the CLI printed the link and exited without serving', exited?.problem?.kind === 'enable' && exited.problem.link === LINK, JSON.stringify(exited));

    const forged = await press({ failed: true, timedOut: true, stdout: 'To enable, visit:\n  https://evil.example.com/f/serve?x=1\n', stderr: '' });
    ok('a link to anywhere but login.tailscale.com is never offered as a button', !forged?.problem?.link && forged?.problem?.kind !== 'enable', JSON.stringify(forged));

    const denied = await press({ failed: true, stdout: '', stderr: "Access denied: serve config denied\n\nUse 'sudo tailscale serve --bg --https=443 http://127.0.0.1:3001'.\nTo not require root, use 'sudo tailscale set --operator=$USER' once.\n" });
    ok('permission refused: the problem is "denied", with the CLI\'s own first line and the command to run by hand',
        denied?.problem?.kind === 'denied' && denied.problem.reason === 'Access denied: serve config denied' && /^tailscale serve --bg /.test(denied.command || ''), JSON.stringify(denied));
    ok('…logged as "denied"', /\bdenied\b/.test(logged()?.detail || ''));

    const slow = await press({ failed: true, timedOut: true, stdout: '', stderr: '' });
    ok('no answer in time: the problem is "timeout"', slow?.problem?.kind === 'timeout', JSON.stringify(slow));

    const out = await press({ failed: true, stdout: '', stderr: 'error enabling https feature: no self node\n' });
    ok('this computer signed out of Tailscale: the problem is "signed-out"', out?.problem?.kind === 'signed-out', JSON.stringify(out));

    const stopped = await press({ failed: true, stdout: '', stderr: 'failed to connect to local Tailscale service; is Tailscale running?\n' });
    ok('Tailscale not running: the problem is "not-running"', stopped?.problem?.kind === 'not-running', JSON.stringify(stopped));

    const odd = await press({ failed: true, stdout: '', stderr: 'Another client is changing the serve config; please try again.\n\x1b[31m\n' });
    ok('anything else: the CLI\'s own first line, plain', odd?.problem?.kind === 'other' && odd.problem.reason === 'Another client is changing the serve config; please try again.', JSON.stringify(odd));
    const long = await press({ failed: true, stdout: '', stderr: 'x'.repeat(5000) });
    ok('…cut to one short line', (long?.problem?.reason || '').length <= 200, String(long?.problem?.reason?.length));

    // Exit 0 with its usual success text, then nothing of ours in the status.
    const SUCCESS_OUT = 'Available within your tailnet:\n\nhttps://desk.tail1234.ts.net/\n|-- proxy http://127.0.0.1:3001\n';
    const quiet = await press(SUCCESS_OUT);
    ok('an exit 0 that served nothing never quotes its success text as the reason',
        quiet?.problem?.kind === 'other' && !quiet.problem.reason, JSON.stringify(quiet));
    cli.statusGoesAfterServe = true;
    const unknown = await press(SUCCESS_OUT);
    cli.statusGoesAfterServe = false;
    ok('…and when the status cannot be read after it, that is "no answer", not a failure',
        unknown?.url === null && unknown.problem === null && unknown.command === null && /\bunreadable\b/.test(logged()?.detail || ''), JSON.stringify(unknown));

    cli.serveStatus = fresh();
    const good = await call('/api/devices/tailscale/serve', { method: 'POST' });
    ok('a share that took is logged too', !!good.body?.url && logged()?.event === 'tailscale.served', JSON.stringify(logged()));

    ok('the pure reader: a failure object with no text at all is "other" with no reason',
        JSON.stringify(devices.serveProblemOf({ failed: true, stdout: '', stderr: '' })) === JSON.stringify({ kind: 'other' }));

    // The real spawn path, driven by THIS node binary standing in for the CLI
    // (never Tailscale): what it printed survives a failure, and a run that
    // prints the enable link and then waits is ended at the link, not at the
    // timeout. Real time here, not the pinned clock: the run is a process.
    const node = process.execPath;
    const realNow = () => performance.now();
    const t0 = realNow();
    const waiter = await devices.runCli(node, ['-e', `process.stdout.write(${JSON.stringify(ENABLE_OUT)}); setTimeout(() => {}, 20000)`], 15000, { stopOn: devices.ENABLE_LINK });
    const tookMs = realNow() - t0;
    ok('a CLI that prints the enable link and waits is stopped at the link (not the 15 s timeout), its output kept',
        waiter?.failed === true && waiter.timedOut === false && waiter.stdout.includes(LINK) && tookMs < 10000, `${Math.round(tookMs)} ms ${JSON.stringify(waiter)}`);
    ok('…and read as "enable"', devices.serveProblemOf(waiter).kind === 'enable');
    // The link split across two writes, as a pipe may deliver it: never stopped mid-link.
    const cut = LINK.length - 8;
    const split = await devices.runCli(node, ['-e',
        `process.stdout.write(${JSON.stringify(`To enable, visit:\n\n         ${LINK.slice(0, cut)}`)}); setTimeout(() => process.stdout.write(${JSON.stringify(`${LINK.slice(cut)}\n\n`)}), 300); setTimeout(() => {}, 20000)`],
    15000, { stopOn: devices.ENABLE_LINK });
    ok('a link that arrives in two pieces is read whole before the run is stopped',
        split?.failed === true && devices.serveProblemOf(split).link === LINK, JSON.stringify(split));
    const refused = await devices.runCli(node, ['-e','process.stderr.write("Access denied: serve config denied\\n"); process.exit(1)'], 5000);
    ok('a CLI that exits non-zero keeps its stderr', refused?.failed === true && refused.stderr.startsWith('Access denied') && refused.timedOut === false, JSON.stringify(refused));
    const hung = await devices.runCli(node, ['-e', 'setTimeout(() => {}, 20000)'], 300);
    ok('a CLI that says nothing past the timeout is a timeout', hung?.failed === true && hung.timedOut === true, JSON.stringify(hung));
    ok('a CLI that is not there at all is null', await devices.runCli(join(scratch, 'no-such-tailscale'), [], 1000) === null);
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
    await auth.setPassword('correct horse');
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
    // The other half of ownerPresent: the password, typed on the phone, moves
    // the addresses; the phone's device key alone, with a password set, does not.
    const typed = await call('/api/settings/searxng_url', { method: 'PUT', from: PHONE, cookie: session, body: { value: 'https://searx.phone.example' } });
    ok('a password session on a phone moves an address', typed.status === 200, typed.status);
    const keyOnly = await call('/api/settings/searxng_url', { method: 'PUT', from: PHONE, cookie: phoneCookie, body: { value: 'https://searx.device.example' } });
    ok('…which a device key alone, with a password set, may not', keyOnly.status === 403, keyOnly.status);
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

// ── guessing the password ──────────────────────────────────────────────────────
// `trust proxy: loopback` takes X-Forwarded-For from anything on a loopback
// socket, so a program here, or anyone behind `ssh -L`/socat, can claim a new
// address per guess. Those share one budget; this machine's own requests do not.
console.log('\n--- guessing the password is throttled, whatever address a relay claims ---');
{
    clockAt += 31 * 60 * 1000; // every record the sections above left is spent
    await auth.setPassword('throttle pass');
    const statuses = [];
    for (let i = 1; i <= 40; i++) {
        statuses.push((await call('/api/auth/login', { method: 'POST', from: `10.9.8.${i}`, body: { password: `bad${i}` } })).status);
    }
    ok('a new made-up address per guess buys 32 guesses, then 429', statuses.slice(0, 32).every(s => s === 401) && statuses.slice(32).every(s => s === 429), statuses.join(' '));
    ok('…the right password included', (await call('/api/auth/login', { method: 'POST', from: '10.9.7.1', body: { password: 'throttle pass' } })).status === 429);
    ok('…while this machine, unrelayed, still signs in', (await call('/api/auth/login', { method: 'POST', body: { password: 'throttle pass' } })).status === 200);
    const held = auth.loginThrottleSize();
    clockAt += 31 * 60 * 1000;
    await call('/api/auth/login', { method: 'POST', from: '10.9.6.1', body: { password: 'bad' } });
    ok('spent records are dropped, so made-up addresses cannot grow the throttle', held >= 33 && auth.loginThrottleSize() === 2, `${held} → ${auth.loginThrottleSize()}`);

    // A relay that claims THIS machine's address, or names the shared record:
    // its guesses count against the relay, never against this machine's own.
    for (const claim of ['127.0.0.1', '::1', 'relayed']) {
        clockAt += 31 * 60 * 1000;
        for (let i = 0; i < 8; i++) await call('/api/auth/login', { method: 'POST', from: claim, body: { password: `bad${i}` } });
        const relayed = (await call('/api/auth/login', { method: 'POST', from: claim, body: { password: 'throttle pass' } })).status;
        const own = (await call('/api/auth/login', { method: 'POST', body: { password: 'throttle pass' } })).status;
        ok(`a relay claiming "${claim}" is throttled after 8, and this machine still signs in`, relayed === 429 && own === 200, `relayed ${relayed}, own ${own}`);
    }
    clockAt += 31 * 60 * 1000;
    for (let i = 0; i < 16; i++) await call('/api/auth/login', { method: 'POST', from: 'relayed', body: { password: `bad${i}` } });
    const other =(await call('/api/auth/login', { method: 'POST', from: '10.9.5.1', body: { password: 'throttle pass' } })).status;
    ok('…and naming the shared record spends it once a guess, not twice', other === 200, `another relayed client got ${other}`);

    const session = cookieOf(await call('/api/auth/login', { method: 'POST', body: { password: 'throttle pass' } }), 'sp_sid');
    const change = [];
    for (let i = 0; i < 9; i++) {
        change.push((await call('/api/auth/change', { method: 'POST', cookie: session, body: { currentPassword: `g${i}`, newPassword: 'newpassword123' } })).status);
    }
    ok('wrong current passwords on Change password are throttled like a login', change.slice(0, 8).every(s => s === 401) && change[8] === 429, change.join(' '));
    ok('…and Remove password shares the throttle', (await call('/api/auth/disable', { method: 'POST', cookie: session, body: { password: 'throttle pass' } })).status === 429);
    clockAt += 31 * 60 * 1000;
    ok('…which lets the right password through once it has passed',
        (await call('/api/auth/disable', { method: 'POST', cookie: session, body: { password: 'throttle pass' } })).body?.ok === true);
    clockAt = T0;
}

// ── the headers every answer carries ───────────────────────────────────────────
// Set by createApp's first middleware; read off real answers, a refusal included,
// because a text search for the line still passed with it commented out.
console.log('\n--- every answer carries the enforced CSP and nosniff ---');
for (const [what, r] of [
    ['an API answer', await call('/api/projects')],
    ['a refused one', await call('/api/projects', { host: 'evil.example' })],
]) {
    const csp = String(r.headers['content-security-policy'] || '');
    ok(`${what} (${r.status}) carries the enforced CSP`, ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"].every(d => csp.includes(d)), csp);
    ok(`${what} carries nosniff`, r.headers['x-content-type-options'] === 'nosniff');
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
