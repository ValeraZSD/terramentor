#!/usr/bin/env node
/**
 * Two people on one browser at one site address: nothing of person 1 is served
 * to person 2 after person 1 signs out.
 *
 * One headless Chromium-family browser, one profile, against a running front
 * desk (server/site/index.js). Person 1 makes an account from an invite link,
 * opens the app, writes a course with a marker in its name and leaves traces
 * in the page's own storage, then signs out. What the browser still holds for
 * the address is listed (local and session storage, IndexedDB, Cache Storage,
 * service workers), the back button is pressed, and person 2 makes an account
 * from a second invite link in the same profile and opens the app. Every
 * answer person 2's pages receive is read and searched for the marker.
 *
 *   node tools/site-browser-proof.mjs --url http://localhost:3101 --invite1 <link> --invite2 <link> [--shots DIR]
 *
 * With --shots it also saves the sign-in, invite and devices pages and the
 * app's account panel, light and dark, desktop and phone width.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const BASE = arg('--url');
const INVITE1 = arg('--invite1');
const INVITE2 = arg('--invite2');
const SHOTS = arg('--shots');
if (!BASE || !INVITE1 || !INVITE2) { console.error('usage: --url URL --invite1 LINK --invite2 LINK [--shots DIR]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
    if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
    const c = process.platform === 'win32'
        ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
        : ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    const found = c.find((p) => existsSync(p));
    if (!found) throw new Error('no Chromium-family browser found; set BROWSER_PATH');
    return found;
}
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'site-browser-proof-'));
const env = { ...process.env };
delete env.__COMPAT_LAYER;
const browser = spawn(findBrowser(), ['--headless=new', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio', '--lang=en-US', '--window-size=1280,800', '--edge-skip-compat-layer-relaunch', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
    ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])], { stdio: 'ignore', env });

let wsUrl;
for (let i = 0; i < 120 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ }
    if (!wsUrl) await sleep(250);
}
if (!wsUrl) { browser.kill(); throw new Error('the browser opened no DevTools port'); }
const ws = new WebSocket(wsUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('DevTools socket did not open')); });
let nextId = 0;
const pending = new Map();
const listeners = new Set();
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.bad(new Error(m.error.message)); else p.ok(m.result); return; }
    for (const l of listeners) l(m);
};
const send = (method, params = {}) => new Promise((ok, bad) => { const id = ++nextId; pending.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
};
const loaded = () => new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired') { listeners.delete(l); r(); } }; listeners.add(l); });
// A load always: a same-document hop (only the hash differs) fires no load event, so reload.
const go = async (url) => {
    const done = loaded();
    const r = await send('Page.navigate', { url });
    if (!r.loaderId) await send('Page.reload', {});
    await done;
};
const quiet = async (ms = 1500) => {
    // Until no request has started or ended for `ms`.
    let last = Date.now();
    const l = (m) => { if (m.method?.startsWith('Network.')) last = Date.now(); };
    listeners.add(l);
    while (Date.now() - last < ms) await sleep(200);
    listeners.delete(l);
};
await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Runtime.enable');
// English pages whatever the machine's language, so the screenshots read the same everywhere.
await send('Emulation.setLocaleOverride', { locale: 'en-US' });
const UA = await evaluate('navigator.userAgent');
await send('Network.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'en-US' });

// Every answer the page receives, with its body, while `recording` is on.
let recording = null;
listeners.add((m) => {
    if (!recording) return;
    if (m.method === 'Network.responseReceived') recording.meta.set(m.params.requestId, { url: m.params.response.url, status: m.params.response.status, fromSW: m.params.response.fromServiceWorker, fromCache: m.params.response.fromDiskCache });
    if (m.method === 'Network.loadingFinished' && recording.meta.has(m.params.requestId)) {
        const rec = recording;
        rec.jobs.push(send('Network.getResponseBody', { requestId: m.params.requestId })
            .then((b) => ({ ...rec.meta.get(m.params.requestId), body: b.base64Encoded ? Buffer.from(b.body, 'base64').toString('latin1') : b.body }))
            .catch(() => ({ ...rec.meta.get(m.params.requestId), body: '' })));
    }
});

const shot = async (name, { dark = false, width = 1280, height = 800 } = {}) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: width < 600 ? 2 : 1, mobile: width < 600 });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await send('Page.reload', {});
    await sleep(1200);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
};
const shotsBothThemes = async (name) => {
    await shot(`${name}-light`);
    await shot(`${name}-dark`, { dark: true });
    await shot(`${name}-phone-dark`, { dark: true, width: 390, height: 844 });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
};

const fillAndSubmit = (fields) => evaluate(`(() => {
    const f = ${JSON.stringify(fields)};
    for (const [name, value] of Object.entries(f)) document.querySelector('[name="' + name + '"]').value = value;
    document.querySelector('form').submit();
})()`);
const MARKER = `PersonOneCourse${Math.random().toString(36).slice(2, 10)}`;
const PASS1 = 'person one has a long pass phrase';
const PASS2 = 'person two has another long pass phrase';
let failed = 0;

try {
    // --- person 1 ----------------------------------------------------------------
    await go(INVITE1);
    if (SHOTS) {
        await shotsBothThemes('site-invite');
    }
    let nav = loaded(); await fillAndSubmit({ password: PASS1, again: PASS1 }); await nav;
    await quiet();
    const where1 = await evaluate('location.pathname');
    await evaluate(`fetch('/api/settings/welcome_done', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'true' }) }).then(r => r.status)`);
    const made = await evaluate(`fetch('/api/projects',{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '${MARKER}' }) }).then(r => r.status)`);
    await go(`${BASE}/`); await quiet(2500);
    await evaluate(`(async () => {
        localStorage.setItem('person-one-note', '${MARKER}');
        sessionStorage.setItem('person-one-note', '${MARKER}');
        await new Promise((ok) => { const r = indexedDB.open('person-one'); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { r.result.close(); ok(); }; });
        const c = await caches.open('person-one'); await c.put('/person-one', new Response('${MARKER}'));
    })()`);
    const before = await evaluate(`(async () => ({
        own: (await (await fetch('/api/projects')).text()).includes('${MARKER}'),
        local: localStorage.length, caches: (await caches.keys()).length,
        sw: (await navigator.serviceWorker.getRegistrations()).length,
    }))()`);
    if (SHOTS) {
        // The app follows its own theme setting, so each theme is set and the page reloaded in it.
        mkdirSync(SHOTS, { recursive: true });
        for (const [theme, width, height] of [['light', 1280, 800], ['dark', 1280, 800], ['dark', 390, 844]]) {
            await evaluate(`fetch('/api/settings/theme', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: '${theme}' }) })`);
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: width < 600 ? 2 : 1, mobile: width < 600 });
            await go(`${BASE}/settings#devices`); await quiet(2000);
            const { data } = await send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(join(SHOTS, `site-app-account-${width < 600 ? 'phone-' : ''}${theme}.png`), Buffer.from(data, 'base64'));
        }
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    }

    // Sign out with the app's own button.
    await go(`${BASE}/settings#devices`); await quiet(2000);
    nav = loaded();
    const clicked = await evaluate(`(() => { const b = document.querySelector('form[action="/site/sign-out"] button[type="submit"]'); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) throw new Error(`the app shows no Sign out button at ${await evaluate('location.href')}; buttons: ${await evaluate(`[...document.querySelectorAll('button')].map(b => b.textContent.trim()).join(' | ')`)}`);
    await nav; await quiet();
    const after = await evaluate(`(async () => ({
        path: location.pathname + location.search,
        local: localStorage.length, session: sessionStorage.length,
        idb: (await indexedDB.databases()).length,
        caches: (await caches.keys()).length,
        apiInCache: (await Promise.all((await caches.keys()).map(async k => (await (await caches.open(k)).keys()).filter(r => new URL(r.url).pathname.startsWith('/api')).length))).reduce((a, b) => a + b, 0),
        sw: (await navigator.serviceWorker.getRegistrations()).length,
    }))()`);
    // The back button, twice: what does it show?
    nav = loaded(); await send('Page.navigateToHistoryEntry', { entryId: (await send('Page.getNavigationHistory')).entries.at(-2).id }); await nav; await quiet(2000);
    const back = await evaluate(`({ path: location.pathname, marker: document.documentElement.outerHTML.includes('${MARKER}') })`);

    if (SHOTS) {
        await go(`${BASE}/site/sign-in?signed-out`);
        await shotsBothThemes('site-sign-in');
        await go(`${BASE}/site/sign-in`);
        nav = loaded(); await fillAndSubmit({ email: 'nobody@example.org', password: 'not the right password at all' }); await nav;
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(SHOTS, 'site-sign-in-wrong-light.png'), Buffer.from(data, 'base64'));
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
        await sleep(300);
        const d2 = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(SHOTS, 'site-sign-in-wrong-dark.png'), Buffer.from(d2.data, 'base64'));
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    }

    // --- person 2, same browser profile ---------------------------------------------
    recording = { meta: new Map(), jobs: [] };
    await go(INVITE2);
    nav = loaded(); await fillAndSubmit({ password: PASS2, again: PASS2 }); await nav;
    await quiet(3000);
    await go(`${BASE}/`); await quiet(3000);
    const p2projects = await evaluate(`fetch('/api/projects').then(r => r.text())`);
    const p2storage = await evaluate(`JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })`);
    const answers = await Promise.all(recording.jobs);
    recording = null;
    const leaked = answers.filter((a) => a.body.includes(MARKER));
    const fromSW = answers.filter((a) => a.fromSW && new URL(a.url).pathname.startsWith('/api')).length;

    if (SHOTS) {
        // A second device for person 2, so the list has more than one row.
        await evaluate(`fetch('/site/sign-out-everywhere', { method: 'POST' }).catch(() => {})`).catch(() => {});
        await go(`${BASE}/site/sign-in`);
        nav = loaded(); await fillAndSubmit({ email: 'person2@example.org', password: PASS2 }); await nav; await quiet();
        await send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36', acceptLanguage: 'en-US' });
        await evaluate(`fetch('/site/sign-in', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=person2%40example.org&password=${encodeURIComponent(PASS2)}', redirect: 'manual', credentials: 'omit' })`);
        await send('Network.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'en-US' });
        await go(`${BASE}/site/sessions`);
        await shotsBothThemes('site-sessions');
    }

    const line = `d: nothing of person 1 served to person 2: ${leaked.length} of ${answers.length} answers to person 2 held person 1's course `
        + `(${fromSW} API answers came from the service worker; person 2's project list ${p2projects.includes(MARKER) ? 'HAS' : 'lacks'} it; storage ${p2storage.includes(MARKER) ? 'HAS' : 'lacks'} it). `
        + `Person 1 before sign-out: own project list ${before.own ? 'holds' : 'LACKS'} the course, ${before.local} local keys, ${before.caches} caches, ${before.sw} service worker. `
        + `After sign-out (${after.path}): ${after.local} local and ${after.session} session keys, ${after.idb} IndexedDB, ${after.caches} caches (${after.apiInCache} API entries), ${after.sw} service workers; `
        + `back button showed ${back.path} with ${back.marker ? 'the course' : 'no trace of the course'}.`;
    console.log(`proof ${line}`);
    const good = where1 === '/' && made >= 200 && made < 300 && before.own && leaked.length === 0 && !p2projects.includes(MARKER) && !p2storage.includes(MARKER)
        && after.local === 0 && after.session === 0 && after.idb === 0 && after.apiInCache === 0 && after.caches === 0 && !back.marker && answers.length > 5;
    if (!good) { failed++; console.log(`  ^ FAILED (landed ${where1}, create ${made}, ${answers.length} answers)`); for (const a of leaked) console.log(`  leaked: ${a.url}`); }
} catch (e) {
    console.error(e);
    failed++;
} finally {
    ws.close();
    browser.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* the browser may hold a file a moment longer */ }
}
process.exit(failed ? 1 : 0);
