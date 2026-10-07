// tools/update-channel-gates.mjs — the update check's two channels: how
// versions compare (a nightly's run number is a NUMBER), which release each
// channel is offered, that a switch never downgrades and never shows one
// channel's answer as the other's, and that a switch reaches the network only
// when the daily check is on, at most once a minute.
//
// Run:  node tools/update-channel-gates.mjs
//
// Why these are asserted:
//
//  * A NIGHTLY VERSION THAT SORTS WRONG IS A STUCK INSTALL. The check offers
//    whatever compares newer, so `1.3.0-nightly.20261008.10` has to beat `.9`
//    and a nightly has to lose to the stable release of the same numbers.
//
//  * SECURITY.md PROMISES ONE REQUEST, AND ONLY WHEN ASKED. A channel switch
//    is a new way to cause one; these count them.
//
//  * THE MANIFEST URL IS WHAT THE UPDATER WILL DOWNLOAD AGAINST. One pointing
//    outside this repository's releases is dropped, never passed on.
//
// No network: GitHub is a stub, and the stored state lives in a scratch library.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'update-channel-gates-'));
// The check's stored state lives in the settings table: a scratch library,
// set before anything opens one.
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const { compareVersions } = await import('../server/version.js');
const newer = (a, b) => compareVersions(a, b) > 0;

// ---------------------------------------------------------------------------
// 1. Nightly versions sort the way the update check needs them to
// ---------------------------------------------------------------------------
console.log('\n--- nightly version ordering ---');

// Numeric prerelease fields compare as numbers (semver §11). A string compare
// puts run 10 before run 9, and a same-day second nightly would never be offered.
check('nightly .10 is newer than .9 on the same day',
    newer('1.3.0-nightly.20261008.10', '1.3.0-nightly.20261008.9'), true);
check('a later day beats any run number of the day before',
    newer('1.3.0-nightly.20261009.1', '1.3.0-nightly.20261008.12'), true);
check('the stable release beats every nightly of the same numbers',
    newer('1.3.0', '1.3.0-nightly.20261008.4'), true);
check('the next minor\'s nightly beats the stable release before it',
    newer('1.4.0-nightly.20261010.1', '1.3.0'), true);
check('a nightly does not beat the stable release it previews',
    newer('1.3.0-nightly.20261008.4', '1.3.0'), false);
check('a numeric field sorts below an alphanumeric one (semver)',
    newer('1.0.0-rc', '1.0.0-1'), true);
check('more fields win when the shared ones are equal',
    newer('1.0.0-nightly.20261008.1', '1.0.0-nightly.20261008'), true);
check('build metadata is ignored', compareVersions('1.2.0+abc', '1.2.0'), 0);

// ---------------------------------------------------------------------------
// 2. The update check's channel (server/version.js, server/updatePoll.js)
// ---------------------------------------------------------------------------
console.log('\n--- the update check on each channel ---');

const { fetchLatestRelease, updateStatus, newestRelease } = await import('../server/version.js');
const asset = (tag, name = 'manifest.json') => ({
    name, browser_download_url: `https://github.com/ValeraZSD/terramentor/releases/download/${tag}/${name}`,
});
const rel = (tag, extra = {}) => ({
    tag_name: tag, name: tag, html_url: `https://github.com/ValeraZSD/terramentor/releases/tag/${tag}`,
    published_at: '2026-10-08T00:00:00Z', draft: false, prerelease: tag.includes('-'), assets: [asset(tag)], ...extra,
});
const calls = [];
const respond = (status, body) => async (url) => {
    calls.push(url);
    return { status, ok: status >= 200 && status < 300, json: async () => body };
};

calls.length = 0;
let res = await fetchLatestRelease(respond(200, [
    rel('v1.3.0-nightly.20261009.1', { draft: true }),
    rel('v1.2.0'),
    rel('v1.3.0-nightly.20261008.10'),
    rel('v1.3.0-nightly.20261008.9'),
    rel('docs-snapshot'),
]), { channel: 'nightly' });
check('nightly asks for the newest releases, one request', calls, ['https://api.github.com/repos/ValeraZSD/terramentor/releases?per_page=30']);
check('nightly takes the highest version, past a draft and a non-version tag', res.latest?.version, '1.3.0-nightly.20261008.10');
check('…and records which channel answered', [res.latest?.channel, res.latest?.prerelease], ['nightly', true]);
check('…and where its manifest is', res.latest?.manifestUrl,
    'https://github.com/ValeraZSD/terramentor/releases/download/v1.3.0-nightly.20261008.10/manifest.json');
res = await fetchLatestRelease(respond(200, [rel('v1.4.0'), rel('v1.3.0-nightly.20261008.10')]), { channel: 'nightly' });
check('a stable release newer than every nightly is a nightly install\'s update too', res.latest?.version, '1.4.0');
res = await fetchLatestRelease(respond(200, [rel('v1.3.0-rc.1'), rel('v1.3.0-nightly.20261010.3'), rel('v1.2.0')]), { channel: 'nightly' });
check('a hand-tagged release candidate is never offered (it would strand installs above every 1.3.0 nightly)',
    res.latest?.version, '1.3.0-nightly.20261010.3');
res = await fetchLatestRelease(respond(200, []), { channel: 'nightly' });
check('no releases at all is an answer, not a failure', [res.ok, res.latest], [true, null]);
res = await fetchLatestRelease(respond(404, { message: 'Not Found' }), { channel: 'nightly' });
check('a 404 listing releases is a failure (the repository is gone)', res.ok, false);
res = await fetchLatestRelease(respond(200, { tag_name: 'v1.0.0' }), { channel: 'nightly' });
check('a list that is not a list is a failure', res.ok, false);

calls.length = 0;
res = await fetchLatestRelease(respond(200, rel('v1.2.0')));
check('stable is still /releases/latest by default', calls, ['https://api.github.com/repos/ValeraZSD/terramentor/releases/latest']);
check('stable answers carry the channel and the manifest', [res.latest?.channel, res.latest?.manifestUrl],
    ['stable', 'https://github.com/ValeraZSD/terramentor/releases/download/v1.2.0/manifest.json']);
res = await fetchLatestRelease(respond(200, rel('v1.2.0', { assets: [{ name: 'manifest.json', browser_download_url: 'https://evil.example/manifest.json' }] })));
check('a manifest anywhere but this repository\'s release downloads is dropped', res.latest?.manifestUrl, null);
res = await fetchLatestRelease(respond(200, rel('v1.2.0', { assets: [] })));
check('a release without a manifest (1.0.0 has none) says so with null', res.latest?.manifestUrl, null);
check('newestRelease of nothing is nothing', newestRelease(null), null);

const st = (current, version, channel) => updateStatus({ current, latest: { version }, checkedAt: 'x', enabled: true, channel });
check('switched to stable on a nightly: the older stable is NOT offered', st('1.3.0-nightly.20261008.2', '1.2.0', 'stable').available, false);
check('…and the status says the install is ahead of its channel', st('1.3.0-nightly.20261008.2', '1.2.0', 'stable').ahead, true);
check('…until a stable release passes it', st('1.3.0-nightly.20261008.2', '1.3.0', 'stable').available, true);
check('a nightly install is offered the next nightly', st('1.3.0-nightly.20261008.2', '1.3.0-nightly.20261009.1', 'nightly').available, true);
check('an unknown channel reads as stable', st('1.0.0', '1.0.0', 'beta').channel, 'stable');
check('same version: neither behind nor ahead', [st('1.2.0', '1.2.0').available, st('1.2.0', '1.2.0').ahead], [false, false]);

console.log('\n--- switching channels: what is stored, what is asked ---');
const { readUpdateState, runUpdateCheck, setUpdateChannel, stopUpdatePoll } = await import('../server/updatePoll.js');
const { setSettingValue } = await import('../server/settingsStore.js');
const realFetch = globalThis.fetch;
const fetchCalls = [];
globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    const nightlyList = String(url).includes('?per_page=');
    return { status: 200, ok: true, json: async () => (nightlyList ? [rel('v99.1.0-nightly.20261008.1'), rel('v99.0.0')] : rel('v99.0.0')) };
};
try {
    check('a new install is on stable with the check off', [readUpdateState().channel, readUpdateState().enabled], ['stable', false]);
    let state = await runUpdateCheck();
    check('Check now on stable finds the stable release', state.latest?.version, '99.0.0');

    fetchCalls.length = 0;
    state = await setUpdateChannel('nightly');
    check('switching with the daily check OFF makes no request', fetchCalls.length, 0);
    check('…and drops the stable answer instead of showing it as nightly\'s', [state.channel, state.latest, state.checkedAt], ['nightly', null, null]);
    state = await runUpdateCheck();
    check('Check now on nightly asks the list and finds the nightly', [fetchCalls.length, state.latest?.version], [1, '99.1.0-nightly.20261008.1']);

    setSettingValue('update_check', 'on');
    fetchCalls.length = 0;
    state = await setUpdateChannel('stable');
    check('switching with the daily check ON asks once, on the new channel',
        fetchCalls, ['https://api.github.com/repos/ValeraZSD/terramentor/releases/latest']);
    check('…and answers with the stable release', [state.channel, state.latest?.version], ['stable', '99.0.0']);
    fetchCalls.length = 0;
    state = await setUpdateChannel('stable', { checkNow: false });
    check('the route\'s rate limit holds: checkNow false asks nothing', fetchCalls.length, 0);

    // The generic settings writer can change the channel without clearing
    // anything; the stored answer must then read as not checked.
    await runUpdateCheck();
    setSettingValue('update_channel', 'nightly');
    state = readUpdateState();
    check('a channel changed behind the switch\'s back shows no answer from the other channel',
        [state.channel, state.latest, state.checkedAt], ['nightly', null, null]);
    setSettingValue('update_channel', 'weekly');
    check('a stored channel that is not one reads as stable', readUpdateState().channel, 'stable');

    // A slow nightly check is still in flight when the learner switches to
    // stable, and the switch's own stable check finishes first. The late
    // nightly answer must not overwrite it.
    setSettingValue('update_check', 'off');
    await setUpdateChannel('nightly', { checkNow: false });
    const before = globalThis.fetch;
    let overtaken = false;
    globalThis.fetch = async (url) => {
        if (!overtaken) {
            overtaken = true;
            await setUpdateChannel('stable', { checkNow: false });
            await runUpdateCheck();                       // the stable answer lands first
        }
        return before(url);
    };
    await runUpdateCheck();                               // the nightly one, finishing late
    globalThis.fetch = before;
    const raced = readUpdateState();
    check('a check overtaken by a channel switch writes nothing over the new channel\'s answer',
        [raced.channel, raced.latest?.version], ['stable', '99.0.0']);

    // SECURITY.md: "a single retry ten minutes later if a scheduled check
    // fails". Timers captured, GitHub failing every time.
    console.log('\n--- a failed scheduled check retries once, not for ever ---');
    const { startUpdatePoll } = await import('../server/updatePoll.js');
    const timers = [];
    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
    globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
    globalThis.clearTimeout = () => {};
    globalThis.setInterval = (fn, ms) => ({ fn, ms, unref() {} });
    globalThis.clearInterval = () => {};
    const failing = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = async () => { asked++; return { status: 503, ok: false, json: async () => ({}) }; };
    try {
        setSettingValue('update_check', 'on');
        await startUpdatePoll({ checkNow: true });
        const retries = timers.filter((t) => t.ms === 10 * 60 * 1000);
        check('the failed check schedules one retry', [asked, retries.length], [1, 1]);
        await retries[0]?.fn();
        await new Promise((resolve) => realSetTimeout(resolve, 20));
        check('the failed retry schedules nothing more', [asked, timers.filter((t) => t.ms === 10 * 60 * 1000).length], [2, 1]);

        // Turned off while a check is still on the wire: when it fails, it
        // must not arm a retry for the poll that was just stopped.
        timers.length = 0;
        let release;
        globalThis.fetch = async () => { asked++; await new Promise((r) => { release = r; }); return { status: 503, ok: false, json: async () => ({}) }; };
        const inFlight = startUpdatePoll({ checkNow: true });
        await new Promise((resolve) => realSetTimeout(resolve, 10));
        stopUpdatePoll();
        setSettingValue('update_check', 'off');
        release();
        await inFlight;
        check('a check that fails after the poll was stopped arms no retry', timers.filter((t) => t.ms === 10 * 60 * 1000).length, 0);
    } finally {
        globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
        globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval;
        globalThis.fetch = failing;
        setSettingValue('update_check', 'off');
    }

    // The route, through the real app: its validation and its one-a-minute
    // limit, which only a check that really happens may spend.
    console.log('\n--- PUT /api/updates/channel ---');
    const { createApp } = await import('../server/app.js');
    const server = createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const stubbed = globalThis.fetch;
    globalThis.fetch = (url, opts) => (String(url).startsWith(base) ? realFetch(url, opts) : stubbed(url, opts));
    const call = async (method, path, body) => {
        const resp = await realFetch(`${base}${path}`, {
            method, headers: { 'content-type': 'application/json', connection: 'close' }, body: body ? JSON.stringify(body) : undefined,
        });
        return { status: resp.status, json: await resp.json() };
    };
    try {
        let out = await call('PUT', '/api/updates/channel', { channel: 'beta' });
        check('a channel that is not one is a 400', out.status, 400);
        setSettingValue('update_check', 'off');
        fetchCalls.length = 0;
        out = await call('PUT', '/api/updates/channel', { channel: 'nightly' });
        check('with the daily check off, switching asks GitHub nothing', [out.status, out.json.channel, fetchCalls.length], [200, 'nightly', 0]);
        out = await call('POST', '/api/updates/check');
        check('…and does not spend the minute: Check now right after it asks', [fetchCalls.length, out.json.throttled ?? false], [1, false]);
        setSettingValue('update_check', 'on');
        fetchCalls.length = 0;
        out = await call('PUT', '/api/updates/channel', { channel: 'stable' });
        check('with the check on, a switch inside that minute switches but does not ask', [out.json.channel, out.json.throttled, fetchCalls.length], ['stable', true, 0]);
    } finally {
        // Every request above asked for `connection: close`, and whatever is
        // left is dropped here before the close is awaited: a socket still
        // closing when the process ends trips a libuv assertion on Windows,
        // after the suite has already passed (measured: 4 runs in 6).
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
} finally {
    stopUpdatePoll();
    globalThis.fetch = realFetch;
}

try { (await import('../server/database.js')).default.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold a handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): the process ends when its last handle has closed
// rather than in the middle of one closing.
process.exitCode = fail ? 1 : 0;
