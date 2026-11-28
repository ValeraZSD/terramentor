// tools/update-channel-gates.mjs — the update check's two channels: how
// versions compare (a nightly's run number is a NUMBER), which release each
// channel is offered, that a switch never downgrades and never shows one
// channel's answer as the other's, and that a switch reaches the network only
// when the automatic check is on, at most once a minute; when the automatic
// check asks (every four hours, back-off after a failure, on waking from
// sleep); and that an unchanged answer is a 304.
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
// The first two fail on a string compare; the rest pass either way and are
// here so a later rewrite cannot quietly break the release/prerelease order.
check('nightly .10 is newer than .9 on the same day',
    newer('1.3.0-nightly.20261008.10', '1.3.0-nightly.20261008.9'), true);
check('nightly .10 is newer than .2 (a string compare says "2" > "1")',
    newer('1.3.0-nightly.20261008.10', '1.3.0-nightly.20261008.2'), true);
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
// The URL is judged as it will be fetched: after normalising, inside this
// release's own folder, and as one plain file name.
for (const url of [
    'https://github.com/ValeraZSD/terramentor/releases/download/v1.2.0/../../../../other/repo/releases/download/v1.2.0/manifest.json',
    'https://github.com/ValeraZSD/terramentor/releases/download/v1.2.0/%2e%2e/%2e%2e/x/manifest.json',
    'https://github.com/ValeraZSD/terramentor/releases/download/v1.2.0/..%2f..%2fx%2fmanifest.json',
    'https://github.com/ValeraZSD/terramentor/releases/download/v1.2.0/..\\..\\x\\manifest.json',
    'https://github.com/ValeraZSD/terramentor/releases/download/v1.3.0/manifest.json',
    'https://github.com/ValeraZSD/terramentor/releases/download/v1.2.0/manifest.json?x=1',
    'https://u@github.com/ValeraZSD/terramentor/releases/download/v1.2.0/manifest.json',
]) {
    res = await fetchLatestRelease(respond(200, rel('v1.2.0', { assets: [{ name: 'manifest.json', browser_download_url: url }] })));
    check(`a manifest URL that is not this release's own file is dropped: ${url.slice(57)}`, res.latest?.manifestUrl, null);
}
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
    check('switching with the automatic check OFF makes no request', fetchCalls.length, 0);
    check('…and drops the stable answer instead of showing it as nightly\'s', [state.channel, state.latest, state.checkedAt], ['nightly', null, null]);
    state = await runUpdateCheck();
    check('Check now on nightly asks the list and finds the nightly', [fetchCalls.length, state.latest?.version], [1, '99.1.0-nightly.20261008.1']);

    setSettingValue('update_check', 'on');
    fetchCalls.length = 0;
    state = await setUpdateChannel('stable');
    check('switching with the automatic check ON asks once, on the new channel',
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

    // Changed behind the switch's back again, and then the check FAILS: the
    // error belongs to this channel and must be shown (and retried), not read
    // as "not checked" because the stored answer was the other channel's.
    setSettingValue('update_channel', 'nightly');
    const answering = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 503, ok: false, json: async () => ({}) });
    state = await runUpdateCheck();
    globalThis.fetch = answering;
    check('a failure after such a change is shown as this channel\'s error',
        [state.channel, state.error, state.latest], ['nightly', 'GitHub responded 503', null]);

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

    // SECURITY.md, "The update check": once at startup, then every four hours
    // by the wall clock, retries at 10, 30 and 60 minutes after a failure, and
    // an ask on waking from sleep when the answer is over an hour old. The
    // decision is a pure function of the times it is handed: walked here
    // through a day without a clock.
    console.log('\n--- when the automatic check asks ---');
    const { checkIsDue, startUpdatePoll, updateScheduleForTest } = await import('../server/updatePoll.js');
    const MIN = 60 * 1000, HOUR = 60 * MIN;
    const T0 = Date.UTC(2026, 10, 16, 8, 0, 0);
    const due = (o) => checkIsDue({ lastAttemptAt: 0, lastSuccessAt: 0, failures: 0, lastTickAt: 0, ...o });
    check('never asked in this process: due (the startup check)', due({ now: T0 }), true);
    const ok = { lastAttemptAt: T0, lastSuccessAt: T0, failures: 0 };
    check('an answer 3 h 59 min old is not asked again', due({ ...ok, now: T0 + 4 * HOUR - MIN, lastTickAt: T0 + 4 * HOUR - 2 * MIN }), false);
    check('an answer 4 h old is asked again', due({ ...ok, now: T0 + 4 * HOUR, lastTickAt: T0 + 4 * HOUR - MIN }), true);
    const failed = (n) => ({ lastAttemptAt: T0, lastSuccessAt: 0, failures: n });
    check('after one failure: not at 9 min, at 10',
        [due({ ...failed(1), now: T0 + 9 * MIN, lastTickAt: T0 + 8 * MIN }), due({ ...failed(1), now: T0 + 10 * MIN, lastTickAt: T0 + 9 * MIN })], [false, true]);
    check('after two failures: not at 29 min, at 30',
        [due({ ...failed(2), now: T0 + 29 * MIN, lastTickAt: T0 + 28 * MIN }), due({ ...failed(2), now: T0 + 30 * MIN, lastTickAt: T0 + 29 * MIN })], [false, true]);
    check('after three failures: at 60 min',
        due({ ...failed(3), now: T0 + 60 * MIN, lastTickAt: T0 + 59 * MIN }), true);
    check('after four failures it waits the full four hours, not ten minutes',
        [due({ ...failed(4), now: T0 + 3 * HOUR, lastTickAt: T0 + 3 * HOUR - MIN }), due({ ...failed(4), now: T0 + 4 * HOUR, lastTickAt: T0 + 4 * HOUR - MIN })], [false, true]);
    // A laptop shut at 08:00 and opened at 10:30: the minute timer did not
    // run in between, so the last tick is 2.5 h behind.
    check('back from sleep with a 2.5 h old answer: asked at once',
        due({ ...ok, now: T0 + 150 * MIN, lastTickAt: T0 }), true);
    check('back from a 20-minute sleep with a 30-minute old answer: not asked',
        due({ ...ok, lastAttemptAt: T0 + 10 * MIN, lastSuccessAt: T0 + 10 * MIN, now: T0 + 40 * MIN, lastTickAt: T0 + 20 * MIN }), false);
    check('the clock set back behind the last ask: due, not silent until it catches up',
        due({ ...ok, now: T0 - HOUR, lastTickAt: T0 - HOUR - MIN }), true);
    // A laptop that sleeps and wakes every few minutes while offline: each wake
    // must not be an ask, or the back-off is spent in minutes.
    check('back from sleep while failing: not before the first back-off step, then asked',
        [due({ ...failed(1), now: T0 + 4 * MIN, lastTickAt: T0 }), due({ ...failed(1), now: T0 + 10 * MIN, lastTickAt: T0 + 5 * MIN })], [false, true]);
    check('a switch held back by the minute limit: due when that minute is up, not before',
        [due({ ...ok, askAt: T0 + MIN, now: T0 + 30_000, lastTickAt: T0 }), due({ ...ok, askAt: T0 + MIN, now: T0 + MIN, lastTickAt: T0 + 30_000 })], [false, true]);

    // The real timers, captured: what each look of the minute clock does.
    console.log('\n--- the automatic check, on its timers ---');
    const timers = [];
    const intervals = [];
    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
    globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
    globalThis.clearTimeout = () => {};
    globalThis.setInterval = (fn, ms) => { const t = { fn, ms, unref() {} }; intervals.push(t); return t; };
    globalThis.clearInterval = () => {};
    const settle = () => new Promise((resolve) => realSetTimeout(resolve, 20));
    const failing = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = async () => { asked++; return { status: 503, ok: false, json: async () => ({}) }; };
    // One pinned clock, moved by hand: whether a look is due must not depend on
    // how long the runner took between two lines.
    const unpinnedNow = Date.now;
    let clock = T0 + 100 * HOUR;
    Date.now = () => clock;
    try {
        setSettingValue('update_check', 'on');
        updateScheduleForTest.set({ lastAttemptAt: 0, lastSuccessAt: 0, failures: 0, lastTickAt: 0 });
        await startUpdatePoll();
        check('at startup nothing is asked before the 15-second look', [asked, timers.map((t) => t.ms), intervals.map((t) => t.ms)], [0, [15_000], [60_000]]);
        timers[0].fn();
        await settle();
        check('the startup look asks once', asked, 1);
        intervals[0].fn();
        await settle();
        check('a look a minute after a failure asks nothing (the retry is at 10 min)', asked, 1);
        // Ten minutes on: the last ask moved back instead of waiting.
        updateScheduleForTest.set({ lastAttemptAt: Date.now() - 10 * MIN, lastTickAt: Date.now() - MIN });
        intervals[0].fn();
        await settle();
        check('a look ten minutes after the failure retries', [asked, updateScheduleForTest.get().failures], [2, 2]);

        // The lid shut for 2.5 h: no look ran, and the answer is 2.5 h old. The
        // real tick must notice the gap and record its own look, or the wake
        // rule never fires outside the pure walk above.
        clock += 150 * MIN;
        updateScheduleForTest.set({ lastAttemptAt: clock - 150 * MIN, lastSuccessAt: clock - 150 * MIN, failures: 0, lastTickAt: clock - 150 * MIN });
        intervals[0].fn();
        await settle();
        check('back from sleep, the running poll asks at once and records its look', [asked, updateScheduleForTest.get().lastTickAt], [3, clock]);

        // Turned off: the minute clock of the stopped poll asks nothing even
        // when a check is long overdue.
        stopUpdatePoll();
        setSettingValue('update_check', 'off');
        updateScheduleForTest.set({ lastAttemptAt: Date.now() - 10 * HOUR, lastTickAt: Date.now() - MIN });
        intervals[0].fn();
        await settle();
        check('a stopped poll\'s clock asks nothing', asked, 3);
    } finally {
        Date.now = unpinnedNow;
        globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
        globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval;
        globalThis.fetch = failing;
        setSettingValue('update_check', 'off');
    }

    // A channel switch and the schedule: an answer overtaken by the switch does
    // not count, and a switch the one-a-minute limit held back leaves the next
    // look due, so the new channel is not blank for hours.
    console.log('\n--- a channel switch and the schedule ---');
    {
        const before = globalThis.fetch;
        const set0 = { lastAttemptAt: 111, lastSuccessAt: 0, failures: 1, lastTickAt: 0 };
        updateScheduleForTest.set(set0);
        setSettingValue('update_channel', 'stable');
        globalThis.fetch = async () => {
            setSettingValue('update_channel', 'nightly');   // switched while this one is on the wire
            return { status: 200, ok: true, headers: new Headers(), json: async () => ({ tag_name: 'v99.0.0' }) };
        };
        await runUpdateCheck();
        const after = updateScheduleForTest.get();
        check('a check overtaken by a channel switch leaves the schedule alone',
            [after.lastAttemptAt, after.failures], [set0.lastAttemptAt, set0.failures]);
        // Flipping the channel inside the minute: the held switch asks once the
        // minute is up, never at the next look, so flipping stays one request a minute.
        const unpinned = Date.now;
        const at = T0 + 200 * HOUR;
        Date.now = () => at;
        try {
            updateScheduleForTest.set({ lastAttemptAt: at, lastSuccessAt: at, failures: 0, lastTickAt: at, askAt: 0 });
            await setUpdateChannel('stable', { checkNow: false });
            const held = updateScheduleForTest.get();
            check('a switch held back by the minute limit asks when that minute is up, not at the next look',
                [checkIsDue({ ...held, now: at + 30_000 }), checkIsDue({ ...held, now: at + 60_000 })], [false, true]);
            globalThis.fetch = async () => ({ status: 200, ok: true, headers: new Headers(), json: async () => ({ tag_name: 'v99.0.0' }) });
            await runUpdateCheck();
            check('the ask it waited for clears the hold', updateScheduleForTest.get().askAt, 0);
        } finally {
            Date.now = unpinned;
            globalThis.fetch = before;
        }
    }

    // Asking every few hours stays light: an unchanged list comes back as an
    // empty 304, answered from the last full body.
    console.log('\n--- an unchanged answer costs a 304 ---');
    {
        const sent = [];
        const release = { tag_name: 'v77.0.0', name: '77', html_url: 'https://github.com/x/y/releases/tag/v77.0.0', assets: [], body: '' };
        const stub = async (url, opts) => {
            sent.push(opts?.headers?.['If-None-Match'] ?? null);
            const tag = opts?.headers?.['If-None-Match'];
            if (tag === '"abc"') return { status: 304, ok: false, headers: new Headers(), json: async () => { throw new Error('no body on a 304'); } };
            return { status: 200, ok: true, headers: new Headers({ etag: '"abc"' }), json: async () => release };
        };
        const first = await fetchLatestRelease(stub, { channel: 'stable', current: '1.0.0' });
        const second = await fetchLatestRelease(stub, { channel: 'stable', current: '1.0.0' });
        check('the second ask sends the ETag the first answer carried', sent, [null, '"abc"']);
        check('a 304 is the same answer as the full one', [first.ok, second.ok, second.latest?.version], [true, true, '77.0.0']);
        const bare304 = await fetchLatestRelease(async () => ({ status: 304, ok: false, headers: new Headers(), json: async () => ({}) }), { channel: 'nightly', current: '1.0.0' });
        check('a 304 with no answer kept is a failure, never an empty "up to date"', bare304.ok, false);
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
    // The route's minute is measured with Date.now(). One pinned instant for
    // the whole block: a slow runner must not decide whether "inside that
    // minute" holds.
    const realNow = Date.now;
    Date.now = () => Date.parse('2026-10-08T12:00:00Z');
    try {
        let out = await call('PUT', '/api/updates/channel', { channel: 'beta' });
        check('a channel that is not one is a 400', out.status, 400);
        setSettingValue('update_check', 'off');
        fetchCalls.length = 0;
        out = await call('PUT', '/api/updates/channel', { channel: 'nightly' });
        check('with the automatic check off, switching asks GitHub nothing', [out.status, out.json.channel, fetchCalls.length], [200, 'nightly', 0]);
        out = await call('POST', '/api/updates/check');
        check('…and does not spend the minute: Check now right after it asks', [fetchCalls.length, out.json.throttled ?? false], [1, false]);
        setSettingValue('update_check', 'on');
        fetchCalls.length = 0;
        out = await call('PUT', '/api/updates/channel', { channel: 'stable' });
        check('with the check on, a switch inside that minute switches but does not ask', [out.json.channel, out.json.throttled, fetchCalls.length], ['stable', true, 0]);

        // What decides whether a staged release may install is the channel the
        // copy follows now (server/appUpdate.js), read from the setting this
        // route writes, and a switch stops a download the new channel does not
        // take. Through the real route; the download is a job of its own on a
        // scratch folder, held at its manifest so nothing is fetched.
        const appUpdate = await import('../server/appUpdate.js');
        setSettingValue('update_check', 'off');
        await call('PUT', '/api/updates/channel', { channel: 'nightly' });
        const onNightly = appUpdate.followedChannel?.();
        await call('PUT', '/api/updates/channel', { channel: 'stable' });
        check('Restart\'s check (server/appUpdate.js) reads the channel the switch wrote', [onNightly, appUpdate.followedChannel?.()], ['nightly', 'stable']);
        await call('PUT', '/api/updates/channel', { channel: 'nightly' });
        // The fetch records its abort: a job cleared without aborting would
        // also read idle, with the held fetch still pending.
        let stopped = false;
        const held = (url, init) => new Promise((_, reject) => {
            if (init.signal.aborted) { stopped = true; return reject(init.signal.reason); }
            init.signal.addEventListener('abort', () => { stopped = true; reject(init.signal.reason); });
        });
        const NV = '99.9.0-nightly.20261101.1';
        const jobRoot = join(scratch, 'job-app');
        appUpdate.startDownload({
            latest: { version: NV, tag: `v${NV}`, channel: 'nightly', prerelease: true, manifestUrl: `https://github.com/ValeraZSD/terramentor/releases/download/v${NV}/manifest.json` },
            appRoot: jobRoot, fetchImpl: held, log: {},
        });
        const jobPhase = () => appUpdate.installState({ appRoot: jobRoot, current: '1.0.0', deployment: 'desktop' }).phase;
        const before = jobPhase();
        await call('PUT', '/api/updates/channel', { channel: 'stable' });
        for (let i = 0; i < 50 && jobPhase() === 'downloading'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        check('switching to Stable through the route stops a nightly download', [before, jobPhase(), stopped], ['downloading', 'idle', true]);
        appUpdate.cancelDownload();
        appUpdate.resetForTests();

        // Restart answered: the copy installs what was pressed, so a switch
        // waits until it has opened again, and the setting never names Stable
        // while a nightly installs. A staged nightly on a scratch "install".
        const readyRoot = join(scratch, 'ready-app');
        mkdirSync(join(readyRoot, '.update'), { recursive: true });
        writeFileSync(join(readyRoot, 'build.json'), '{}');
        writeFileSync(join(readyRoot, 'files.json'), '{}');
        writeFileSync(join(readyRoot, '.update', 'ready.json'), JSON.stringify({ version: '99.9.0-nightly.20261101.1', channel: 'nightly' }));
        await call('PUT', '/api/updates/channel', { channel: 'nightly' });
        appUpdate.setUpdateInstaller(() => {});
        const pressed = appUpdate.requestInstall({ appRoot: readyRoot, current: '1.0.0', deployment: 'desktop' });
        const during = await call('PUT', '/api/updates/channel', { channel: 'stable' });
        const kept = appUpdate.followedChannel?.();
        const same = await call('PUT', '/api/updates/channel', { channel: 'nightly' });
        check('a switch while Restart hands over is refused, and the channel stays', [pressed.ok, during.status, kept, same.status], [true, 409, 'nightly', 200]);
        appUpdate.resetForTests();
        const after = await call('PUT', '/api/updates/channel', { channel: 'stable' });
        check('…and goes through once that is over', [after.status, appUpdate.followedChannel?.()], [200, 'stable']);

        // This copy is a checkout, which cannot install: Download and Restart
        // say so before asking GitHub anything.
        fetchCalls.length = 0;
        out = await call('POST', '/api/updates/restart');
        const restartAsked = fetchCalls.length;
        const download = await call('POST', '/api/updates/download');
        check('a copy that cannot install refuses Restart and Download without asking GitHub',
            [out.status, download.status, restartAsked, fetchCalls.length], [409, 409, 0, 0]);
    } finally {
        Date.now = realNow;
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

// ---------------------------------------------------------------------------
// What changed: the release notes the app shows instead of a GitHub page
// ---------------------------------------------------------------------------
console.log('\n--- what changed, from the release bodies ---');
{
    const { releaseNote, notesSince } = await import('../server/version.js');
    // The real shapes (v1.3.0-nightly.20261026.1 and v1.2.0, cut short).
    const nightlyBody = 'Nightly build 1.3.0-nightly.20261026.1 of `c168aee` on `main`, published automatically. It passed the same checks as every pull request.\r\n\r\nChanges since v1.3.0-nightly.20261022.3:\r\n\r\n- Show a finished update in the header (#93) (c168aee)\r\n- Rows across cards, swap drops, Outline (#96) (00a918f)\r\n- Bump concurrently from 9.2.4 to 10.0.6 (#99) (5ec4d01)\r\n- Bump the minor-and-patch group with 9 updates (#97) (5de3926)\r\n\r\n---\r\n\r\n**Desktop app, nothing to install:** download the zip\r\n- not a change\r\n';
    const stableBody = '**The assistant edits your courses.** The assistant can now prepare a change to a course; each is a preview. New course asks for a name first, in version 1.2.0 of the dialog. **Database:** adds a record of the assistant\'s applied changes.\n\n---\n\n**Desktop app, nothing to install:** download the zip.';
    const n = releaseNote(rel('v1.3.0-nightly.20261026.1', { body: nightlyBody }));
    check('a nightly lists its changes without the PR number or the commit', n.items, ['Show a finished update in the header', 'Rows across cards, swap drops, Outline']);
    check('…counts the library bumps instead of listing them', n.libraries, 2);
    check('…and has no headline (its opening sentence is the release page\'s, not news)', n.title, null);
    const s = releaseNote(rel('v1.2.0', { body: stableBody }));
    check('a full release keeps its bold headline as the title', s.title, 'The assistant edits your courses');
    check('…and lists its paragraph sentence by sentence, never inside a version number',
        s.items, ['The assistant can now prepare a change to a course; each is a preview.', 'New course asks for a name first, in version 1.2.0 of the dialog.', 'Database: adds a record of the assistant\'s applied changes.']);
    check('nothing below the rule (the download instructions) is read', [...n.items, ...s.items].some((x) => /Desktop app|not a change/.test(x)), false);
    // From 1.6.0: the headline alone, the highlights, then the paragraph.
    const highlightsBody = '**Mock exams and evidence.**\n\n- A timed mock exam.\n- What the app thinks you know.\n\nEach topic shows its evidence. Today shows one course. **Database:** adds tables.\n\n---\n\n- not a change';
    const h = releaseNote(rel('v1.6.0', { body: highlightsBody }));
    check('a release with highlights lists them under its headline, and counts the paragraph\'s sentences as more',
        [h.title, h.items, h.more], ['Mock exams and evidence', ['A timed mock exam.', 'What the app thinks you know.'], 3]);
    check('…and still counts them when it is one of several releases the app reports',
        notesSince([rel('v1.6.0', { body: highlightsBody })], '1.5.0').releases[0]?.more, 3);

    const list = [rel('v1.3.0-nightly.20261022.3', { body: '- Older change (#1)' }), rel('v1.3.0-nightly.20261026.1', { body: nightlyBody }),
        rel('v1.3.0-nightly.20261022.2', { body: '- Already installed' }), rel('v1.3.0-rc.1', { body: '- A candidate' }), rel('v1.3.0-nightly.20261027.1', { draft: true, body: '- A draft' })];
    const since = notesSince(list, '1.3.0-nightly.20261022.2', { nightly: true });
    check('a nightly install gets every nightly it has not run, newest first, and no draft or candidate',
        since.releases.map((r) => r.version), ['1.3.0-nightly.20261026.1', '1.3.0-nightly.20261022.3']);
    // 1.3.0-nightly.20261022.3 listed every change since .19.2, so its lines
    // repeat .22.2's, .22.1's and .21.1's.
    const overlapping = [rel('v1.3.0-nightly.20261022.3', { body: '- New in three\n- Shared one\n- Shared two' }),
        rel('v1.3.0-nightly.20261022.2', { body: '- Shared one\n- Shared two' }), rel('v1.3.0-nightly.20261022.1', { body: '- Shared two\n- Only in one' })];
    const dedup = notesSince(overlapping, '1.3.0-nightly.20261021.1', { nightly: true });
    check('a line a newer nightly already lists is not listed again, and an emptied release is dropped',
        dedup.releases.map((r) => [r.version.slice(-4), ...r.items]), [['22.3', 'New in three', 'Shared one', 'Shared two'], ['22.1', 'Only in one']]);
    const many = Array.from({ length: 9 }, (_, i) => rel(`v2.0.0-nightly.20261101.${i + 1}`, { body: `- Change ${i + 1}` }));
    const capped = notesSince(many, '1.0.0', { nightly: true });
    check('at most six releases are kept, and the rest are counted', [capped.releases.length, capped.omitted, capped.releases[0].version], [6, 3, '2.0.0-nightly.20261101.9']);
    const long = releaseNote(rel('v3.0.0-nightly.20261101.1', { body: Array.from({ length: 11 }, (_, i) => `- Item ${i}`).join('\n') }));
    check('at most eight lines a release, and the rest are counted', [long.items.length, long.more], [8, 3]);

    // The check stores them with the answer, from the same request.
    globalThis.fetch = respond(200, list);
    const res = await fetchLatestRelease(undefined, { channel: 'nightly', current: '1.3.0-nightly.20261022.2' });
    check('the check\'s answer carries what changed since the running version', res.latest?.notes?.releases?.length, 2);
    globalThis.fetch = realFetch;
}

console.log('\n--- a press acts on the newest release, not the stored answer ---');
{
    const { freshUpdateState } = await import('../server/updatePoll.js');
    const { setSettingValue } = await import('../server/settingsStore.js');
    // 26 Oct 2026: the stored answer was from the morning, 1.3.0-nightly.20261022.3;
    // .20261026.1 came out at 13:34; the 21:02 press downloaded .22.3.
    const asked = [];
    globalThis.fetch = async (url) => { asked.push(String(url)); return { status: 200, ok: true, json: async () => [rel('v99.2.0-nightly.20261026.1'), rel('v99.2.0-nightly.20261022.3')] }; };
    try {
        setSettingValue('update_channel', 'nightly');
        setSettingValue('update_latest', JSON.stringify({ version: '99.2.0-nightly.20261022.3', tag: 'v99.2.0-nightly.20261022.3', channel: 'nightly' }));
        setSettingValue('update_answer_channel', 'nightly');
        const at = Date.parse('2026-10-26T21:02:00Z');
        setSettingValue('update_last_check', new Date(at - 8 * 3600_000).toISOString());
        let state = await freshUpdateState({ now: at });
        check('a stored answer hours old is asked again before a press acts on it', [asked.length, state.latest?.version], [1, '99.2.0-nightly.20261026.1']);
        asked.length = 0;
        setSettingValue('update_last_check', new Date(at).toISOString());
        state = await freshUpdateState({ now: at + 20_000 });
        check('…an answer under a minute old is not', asked.length, 0);
        let offlineAsks = 0;
        globalThis.fetch = async () => { offlineAsks++; throw new TypeError('fetch failed'); };
        setSettingValue('update_last_check', new Date(at - 8 * 3600_000).toISOString());
        state = await freshUpdateState({ now: at + 10 * 60_000 });
        check('offline, the press asked, failed, and still has the stored answer to act on',
            [offlineAsks, !!state.error, state.latest?.version], [1, true, '99.2.0-nightly.20261026.1']);
        // Offline the stored answer stays old, so only the time of the last
        // ask keeps a button pressed over and over from asking every time.
        state = await freshUpdateState({ now: at + 10 * 60_000 + 30_000 });
        check('…a second press inside the minute does not ask again', offlineAsks, 1);
        state = await freshUpdateState({ now: at + 12 * 60_000 });
        check('…a press after it does', offlineAsks, 2);

        // Two presses at once (Download in two tabs) share one request, and
        // both act on its answer rather than the second reading the old one.
        let release;
        let joint = 0;
        globalThis.fetch = async () => {
            joint++;
            await new Promise((r) => { release = r; });
            return { status: 200, ok: true, json: async () => [rel('v99.3.0-nightly.20261027.1')] };
        };
        const first = freshUpdateState({ now: at + 20 * 60_000 });
        const second = freshUpdateState({ now: at + 20 * 60_000 + 1 });
        for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
        release();
        const both = await Promise.all([first, second]);
        check('two presses at once make one request and both get its answer',
            [joint, both[0].latest?.version, both[1].latest?.version], [1, '99.3.0-nightly.20261027.1', '99.3.0-nightly.20261027.1']);

        // The clock set back: the stored answer is dated a day ahead. It is
        // not fresh (the press asks), and offline it stays dated ahead, which
        // must not turn every press into a request.
        let skewAsks = 0;
        globalThis.fetch = async () => { skewAsks++; throw new TypeError('fetch failed'); };
        const later = at + 40 * 60_000;
        setSettingValue('update_last_check', new Date(later + 24 * 3600_000).toISOString());
        await freshUpdateState({ now: later });
        await freshUpdateState({ now: later + 5_000 });
        await freshUpdateState({ now: later + 30_000 });
        check('an answer dated ahead is asked again, offline once a minute however often pressed', skewAsks, 1);

        // A stored answer this server never received itself (written by an
        // older version, or by any path but the check) is never what a press
        // downloads: even dated this minute the press asks GitHub, and
        // offline there is nothing to download.
        const { heardLatest } = await import('../server/updatePoll.js');
        const unheard = () => typeof heardLatest === 'function' && heardLatest() === null;
        const planted = JSON.stringify({ version: '99.9.0-nightly.20261027.1', tag: 'v99.9.0-nightly.20261027.1', channel: 'nightly', manifestUrl: `https://github.com/ValeraZSD/terramentor/releases/download/v99.9.0-nightly.20261027.1/manifest.json` });
        let plantedAsks = 0;
        globalThis.fetch = async () => { plantedAsks++; return { status: 200, ok: true, json: async () => [rel('v99.3.0-nightly.20261027.1')] }; };
        const t = at + 60 * 60_000;
        setSettingValue('update_latest', planted);
        setSettingValue('update_last_check', new Date(t).toISOString());
        check('a stored answer this server did not receive is no offer', unheard(), true);
        state = await freshUpdateState({ now: t + 1_000 });
        check('…a press asks GitHub although it is dated this minute, and acts on GitHub\'s answer',
            [plantedAsks, state.latest?.version, typeof heardLatest === 'function' ? heardLatest()?.version : 'missing'],
            [1, '99.3.0-nightly.20261027.1', '99.3.0-nightly.20261027.1']);
        globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
        setSettingValue('update_latest', planted);
        await freshUpdateState({ now: t + 5 * 60_000 });
        check('…and offline it stays no offer', unheard(), true);
    } finally {
        globalThis.fetch = realFetch;
    }
}

try { (await import('../server/database.js')).default.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold a handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): the process ends when its last handle has closed
// rather than in the middle of one closing.
process.exitCode = fail ? 1 : 0;
