#!/usr/bin/env node
// tools/perf-budget-gates.mjs — the app stays as small and as quick as it is.
//
//   node tools/perf-budget-gates.mjs                  every budget (builds dist/ when a source is newer)
//   node tools/perf-budget-gates.mjs --dist <dir>     the byte budgets of another build only
//   node tools/perf-budget-gates.mjs --package <zip>…  release zips against their budgets only
//   node tools/perf-budget-gates.mjs --browser <p>    a Chromium-based browser (default: Edge or Chrome)
//   node tools/perf-budget-gates.mjs --only <part>    bytes | server | screen | self
//   node tools/perf-budget-gates.mjs --enforce-times  hold the times to their budgets off CI too
//
// Bytes are held to their budgets everywhere. Times are held in CI (`CI` set);
// on any other machine they are printed beside their budgets and an overrun is
// a note, not a failure, unless --enforce-times: they measure the machine and
// whatever else it is running as much as the app.
//
// The budgets are tools/perf-budgets.json: each one a margin above what was
// measured when it was set, and the measurement beside it. A budget is raised
// on purpose, in that file, with the reason in the commit; never by a run.
//
// What is measured:
//
//   * BYTES, from dist/: what the first page load fetches (the scripts and
//     stylesheets index.html names, modulepreloads included) raw and as brotli
//     at the quality tools/precompress.mjs uses, the largest JavaScript chunk,
//     all JavaScript, and the whole build. Exact numbers: a change that pulls a
//     library into the first load shows as bytes, on every machine alike.
//   * SERVER START: a new process to its "Server running at" line, on a new
//     scratch library (first start, the schema written) and again on the same
//     library (a restart). The median of five runs each, after one untimed run.
//   * FIRST SCREEN, in a headless browser with an empty cache: from navigation
//     to the welcome screen's heading on a new library, and to the home screen
//     once the welcome is done. Twice: a desktop window on loopback, and a
//     phone (390 x 844, CPU four times slower, 1.6 Mbit/s down, 150 ms round
//     trip, the "slow 4G" profile page-speed tools use). Median of five, after
//     one untimed visit.
//   A cold CI runner makes its first run, and sometimes its second, several
//   times slower than the rest; the untimed run takes the first, the median of
//   five absorbs two more.
//   * PACKAGE (--package only): each release zip, by the platform in its name.
//     The zips are built in the release workflow and in the Gates job's Linux
//     leg, after the build; this run has none to look at.
//
// Times are budgeted at about twice the slower of the two CI runners (Linux,
// Windows), so a slow runner does not fail a change that did nothing, the phone
// screens at 1.5 times, since most of their time is the emulated network, which
// does not vary; bytes at
// about 15% above, because they are the same on every machine; the release
// zips about 10%, since most of a zip is the Node runtime and the server's
// dependencies, and 15 MB more to download is already a change worth a look.
//
// The run ends by proving itself: the gate is started on a fixture build whose
// first load is over budget, and on a zip over budget, and must fail both,
// naming the budget; and on fixtures under budget, and must pass them.
//
// No model calls. The server runs on a loopback port over a scratch library
// whose paths are set in the child's environment, never the learner's own.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const BUDGETS = JSON.parse(readFileSync(join(ROOT, 'tools', 'perf-budgets.json'), 'utf8')).budgets;

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const after = (name) => { const i = args.indexOf(name); return i >= 0 ? args.slice(i + 1).filter((a) => !a.startsWith('--')) : []; };

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
// Every measurement, for the CI job's summary page and its log: `npm test`
// shows a passing suite as one line, and the numbers are the point. The log
// copy is RUNNER_TEMP/perf-budgets.md, printed by a step of its own (gates.yml).
const rows = [];
const done = () => {
    if (process.env.GITHUB_STEP_SUMMARY && rows.length) {
        const os = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[process.platform] ?? process.platform;
        const table = [
            `### Performance budgets (${os})`, '', '| measured | value | budget | used |', '|---|---:|---:|---:|',
            ...rows.map((r) => `| ${r.label} | ${r.value} | ${r.budget} | ${r.share}%${r.ok ? '' : ' (over)'} |`), '', '',
        ].join('\n');
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
        if (process.env.RUNNER_TEMP) appendFileSync(join(process.env.RUNNER_TEMP, 'perf-budgets.md'), table);
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
// Timed runs per measurement, each after one untimed run.
const RUNS = 5;
const show = (n, unit) => unit === 'ms' ? `${Math.round(n)} ms`
    : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} kB`;

// Bytes are the same on every machine and always held to their budget. Times
// depend on the machine and on what else it is doing: CI holds them (the
// runner is a known, otherwise idle machine); elsewhere they are reported, and
// held only when asked, so a contributor's busy laptop does not go red.
// GitHub Actions sets CI=true; anything else (unset, CI=false) is a local run.
const ON_CI = process.env.CI === 'true';
const ENFORCE_TIMES = ON_CI || args.includes('--enforce-times');

/** One measured number against its budget, printed whether it passes or not. */
function against(id, measured) {
    const b = BUDGETS[id];
    if (!b) { check(`a budget for "${id}"`, false, 'tools/perf-budgets.json has none'); return; }
    const share = Math.round((measured / b.budget) * 100);
    const exact = b.unit === 'bytes' ? ` [${measured} bytes]` : '';
    const label = `${b.label}: ${show(measured, b.unit)} of ${show(b.budget, b.unit)} (${share}%)${exact}`;
    const exactly = (n) => (b.unit === 'bytes' ? `${n.toLocaleString('en-US')} B` : `${Math.round(n).toLocaleString('en-US')} ms`);
    rows.push({ label: b.label, value: exactly(measured), budget: exactly(b.budget), share, ok: measured <= b.budget });
    if (b.unit === 'ms' && !ENFORCE_TIMES && measured > b.budget) {
        console.log(`  note  ${label} — over its budget; times are held in CI or with --enforce-times`);
        return;
    }
    check(label, measured <= b.budget, `over its budget by ${show(measured - b.budget, b.unit)}`);
}

// ---------------------------------------------------------------------------
// Bytes, from a build folder.
// ---------------------------------------------------------------------------

const brotli = (bytes) => brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
}).length;

function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}

/** What the first page load fetches, by the build's own index.html. */
export function measureDist(dist) {
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const refs = (re) => [...html.matchAll(re)].map((m) => m[1]).filter((u) => u.startsWith('/') && !u.startsWith('//'));
    const scripts = [...new Set([
        ...refs(/<script\b[^>]*\bsrc="([^"]+)"/g),
        ...refs(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g),
    ])];
    const styles = [...new Set(refs(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g))];
    const read = (u) => {
        const p = join(dist, u.split('?')[0]);
        if (!existsSync(p)) throw new Error(`index.html names ${u}, which is not in ${dist}`);
        return readFileSync(p);
    };
    const sum = (urls, f) => urls.reduce((n, u) => n + f(read(u)), 0);
    // The .br/.gz twins are copies of files already counted.
    const files = walk(dist).filter((f) => !/\.(br|gz)$/.test(f));
    const js = files.filter((f) => f.endsWith('.js'));
    const size = (f) => statSync(f).size;
    const largest = js.reduce((a, f) => (size(f) > a.bytes ? { file: f, bytes: size(f) } : a), { file: null, bytes: 0 });
    return {
        firstLoadJsRaw: sum(scripts, (b) => b.length),
        firstLoadJsBrotli: sum(scripts, brotli),
        firstLoadCssRaw: sum(styles, (b) => b.length),
        firstLoadCssBrotli: sum(styles, brotli),
        firstLoadFiles: scripts.length + styles.length,
        largestJsChunk: largest.bytes,
        largestJsChunkName: largest.file ? basename(largest.file) : null,
        allJsRaw: js.reduce((n, f) => n + size(f), 0),
        distRaw: files.reduce((n, f) => n + size(f), 0),
    };
}

function checkBytes(dist) {
    console.log(`\nBytes, from ${dist}`);
    const m = measureDist(dist);
    console.log(`  (first load: ${m.firstLoadFiles} files; largest chunk ${m.largestJsChunkName})`);
    for (const id of ['firstLoadJsBrotli', 'firstLoadJsRaw', 'firstLoadCssBrotli', 'firstLoadCssRaw', 'largestJsChunk', 'allJsRaw', 'distRaw']) against(id, m[id]);
    return m;
}

// ---------------------------------------------------------------------------
// Release zips, by the platform in the name: Terramentor-<version>-<os>-<arch>.zip
// ---------------------------------------------------------------------------

function checkPackages(zips) {
    console.log('\nRelease packages');
    if (!zips.length) check('a zip to check', false, 'pass one or more paths after --package');
    for (const zip of zips) {
        const m = basename(zip).match(/-(win32|linux|darwin)-(x64|arm64)\.zip$/);
        if (!m) { check(`${basename(zip)} names its platform`, false, 'expected …-<os>-<arch>.zip'); continue; }
        if (!existsSync(zip)) { check(`${zip} exists`, false); continue; }
        against(`package-${m[1]}-${m[2]}`, statSync(zip).size);
    }
}

// ---------------------------------------------------------------------------
// A scratch server: a child whose environment names a scratch library.
// ---------------------------------------------------------------------------

function freePort() {
    return new Promise((ok, bad) => {
        const s = createServer();
        s.once('error', bad);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
    });
}

async function startServer(dir) {
    const port = await freePort();
    const env = { ...process.env };
    // A contributor's own model in the environment would answer the scratch server.
    for (const key of Object.keys(env)) if (/^(AI_|OPENAI_|TERRAMENTOR_)/.test(key)) delete env[key];
    Object.assign(env, {
        DATA_DIR: dir, DB_PATH: join(dir, 'library.db'), VAULT_ROOT: join(dir, 'vault'),
        SECRETS_PATH: join(dir, 'library.secrets.json'), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production',
    });
    mkdirSync(env.VAULT_ROOT, { recursive: true });
    const t0 = performance.now();
    const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const exited = new Promise((r) => child.once('exit', r));
    const stop = () => { child.kill(); return Promise.race([exited, sleep(10_000)]); };
    // A server that never says it is ready is stopped here: the caller gets no
    // `stop` to call, and would delete the scratch folder under a live process.
    const ms = await new Promise((ok, bad) => {
        const timer = setTimeout(() => bad(new Error(`the scratch server did not start in 120 s:\n${log.slice(-2000)}`)), 120_000);
        child.stdout.on('data', (c) => {
            log += c;
            if (/Server running at/.test(log)) { clearTimeout(timer); ok(performance.now() - t0); }
        });
        child.stderr.on('data', (c) => { log += c; });
        child.once('exit', (code) => { clearTimeout(timer); bad(new Error(`the scratch server exited (${code}):\n${log.slice(-2000)}`)); });
    }).catch(async (err) => { await stop(); throw err; });
    const scheme = log.match(/Server running at (https?):/)[1];
    const base = `${scheme}://127.0.0.1:${port}`;
    return { ms, base, stop, log: () => log };
}

async function checkServerStart(scratchRoot) {
    console.log(`\nServer start (median of ${RUNS}, after one untimed start and restart)`);
    const first = [], again = [];
    {
        const dir = join(scratchRoot, 'start-warm');
        mkdirSync(dir, { recursive: true });
        await (await startServer(dir)).stop();
        await (await startServer(dir)).stop();
    }
    for (let i = 0; i < RUNS; i++) {
        const dir = join(scratchRoot, `start-${i}`);
        mkdirSync(dir, { recursive: true });
        const a = await startServer(dir); first.push(a.ms); await a.stop();
        const b = await startServer(dir); again.push(b.ms); await b.stop();
    }
    console.log(`  (runs: first ${first.map(Math.round).join(', ')} ms; restart ${again.map(Math.round).join(', ')} ms)`);
    against('serverFirstStart', median(first));
    against('serverRestart', median(again));
}

// ---------------------------------------------------------------------------
// The first screen, timed inside the page.
// ---------------------------------------------------------------------------

// Set on every new document: the moment, in the page's own clock (0 = the
// navigation), that the marker first stands in a frame. The marker is written
// into the script's own source: the page's policy refuses `eval`.
const stopwatch = (marker) => `(() => {
    const seen = () => { try { return !!(${marker}); } catch { return false; } };
    const tick = () => {
        if (!seen()) { requestAnimationFrame(tick); return; }
        window.__perfFirstScreen = performance.now();
        // What stood on the screen at that moment, for the log.
        window.__perfScreenText = (document.querySelector('main')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 70);
    };
    requestAnimationFrame(tick);
})();`;

const SCREENS = {
    welcome: `[...document.querySelectorAll('main h1')].some((h) => /Welcome to Terramentor/.test(h.textContent))`,
    // The home screen: the shell's navigation and the feed drawn, nothing in
    // the page still marked as loading (a lazy route's fallback is aria-busy).
    // The scratch library has no project, so a drawn feed is its empty state;
    // FeedView's "Building your feed…" block has neither that text nor a card.
    home: `!!document.querySelector('nav') && !!document.querySelector('main') && !document.querySelector('[aria-busy="true"]') && /No active projects yet/.test(document.querySelector('main').innerText)`,
};

const PROFILES = {
    desktop: { viewport: { width: 1280, height: 800, scale: 1 }, mobile: false, cpu: 1, network: null },
    phone: {
        viewport: { width: 390, height: 844, scale: 1 }, mobile: true, cpu: 4,
        network: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
    },
};

async function timeScreen(browser, base, marker) {
    const { send, evaluate } = browser;
    const origin = new URL(base).origin;
    // An empty cache every run: a first visit, as a new learner's phone makes it.
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(() => { });
    await send('Network.clearBrowserCache');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    // A stopwatch for this navigation only.
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: stopwatch(marker) });
    await send('Page.navigate', { url: `${base}/` });
    let ms;
    for (const t0 = Date.now(); Date.now() - t0 < 90_000;) {
        ms = await evaluate('window.__perfFirstScreen').catch(() => undefined);
        if (typeof ms === 'number') break;
        await sleep(200);
    }
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    if (typeof ms !== 'number') throw new Error(`the screen never showed (${marker.slice(0, 80)}…)`);
    return { ms, text: await evaluate('window.__perfScreenText').catch(() => '') };
}

/** One untimed visit, then RUNS empty-cache visits to one screen: the median, and the runs and what they showed in the log. */
async function timeRuns(browser, base, name, marker) {
    await timeScreen(browser, base, marker);
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await timeScreen(browser, base, marker));
    console.log(`  (${name}: ${runs.map((r) => Math.round(r.ms)).join(', ')} ms; the screen read "${runs[0].text}")`);
    return median(runs.map((r) => r.ms));
}

async function checkFirstScreen(scratchRoot, browserPath) {
    const { openBrowser } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-shots.mjs')).href);
    const dir = join(scratchRoot, 'screen');
    mkdirSync(dir, { recursive: true });
    const server = await startServer(dir);
    try {
        // A write follows: the server must be the one this run started, on its scratch library.
        const health = await fetch(`${server.base}/api/build`).then((r) => r.status, () => 0);
        if (health !== 200) throw new Error(`the scratch server does not answer /api/build (${health})`);
        for (const [name, profile] of Object.entries(PROFILES)) {
            console.log(`\nFirst screen, ${name} (median of ${RUNS} after one untimed visit, empty cache)`);
            const browser = await openBrowser(browserPath, profile.viewport);
            try {
                const { send } = browser;
                await send('Emulation.setDeviceMetricsOverride', { width: profile.viewport.width, height: profile.viewport.height, deviceScaleFactor: profile.viewport.scale, mobile: profile.mobile });
                await send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
                if (profile.network) await send('Network.emulateNetworkConditions', profile.network);
                // The welcome first, on the new library; then past it, the home screen.
                await setSetting(server.base, 'welcome_done', 'false');
                const welcome = await timeRuns(browser, server.base, 'welcome', SCREENS.welcome);
                await setSetting(server.base, 'welcome_done', 'true');
                const home = await timeRuns(browser, server.base, 'home', SCREENS.home);
                against(`firstScreenWelcome-${name}`, welcome);
                against(`firstScreenHome-${name}`, home);
            } finally {
                await browser.close();
            }
        }
    } finally {
        await server.stop();
    }
}

async function setSetting(base, key, val) {
    const r = await fetch(`${base}/api/settings/${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', origin: new URL(base).origin }, body: JSON.stringify({ value: val }),
    });
    if (!r.ok) throw new Error(`PUT /api/settings/${key}: ${r.status} ${await r.text()}`);
}

// ---------------------------------------------------------------------------
// dist/, built from the sources being checked.
// ---------------------------------------------------------------------------

function newest(path) {
    if (!existsSync(path)) return 0;
    const st = statSync(path);
    if (!st.isDirectory()) return st.mtimeMs;
    let most = 0;
    for (const name of readdirSync(path)) most = Math.max(most, newest(join(path, name)));
    return most;
}

function ensureDist() {
    const built = existsSync(join(ROOT, 'dist', 'index.html')) ? statSync(join(ROOT, 'dist', 'index.html')).mtimeMs : 0;
    const sources = Math.max(...['src', 'public', 'index.html', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js', 'package-lock.json'].map((p) => newest(join(ROOT, p))));
    if (sources <= built) return true;
    console.log(built ? 'dist/ is older than the sources: building it' : 'no dist/: building it');
    const run = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
    if (run.status !== 0) { check('vite build', false); return false; }
    return true;
}

// ---------------------------------------------------------------------------
// The gate tested on itself: over budget must fail, under budget must pass.
// ---------------------------------------------------------------------------

function runSelf(extra) {
    // Without the summary file: the fixtures' numbers are not this build's.
    const env = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    const r = spawnSync(process.execPath, [SELF, ...extra], { cwd: ROOT, encoding: 'utf8', env });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** A build folder whose first load is `entryBytes` of incompressible script. */
function fixtureDist(dir, entryBytes) {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head>'
        + '<script type="module" crossorigin src="/assets/index-fixture.js"></script>'
        + '<link rel="stylesheet" crossorigin href="/assets/index-fixture.css">'
        + '</head><body><div id="root"></div></body></html>');
    // Random bytes: brotli cannot shrink them, so raw and brotli sizes are both known.
    const bytes = Buffer.alloc(entryBytes);
    for (let i = 0; i < entryBytes; i += 65536) globalThis.crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, entryBytes)));
    writeFileSync(join(dir, 'assets', 'index-fixture.js'), bytes);
    writeFileSync(join(dir, 'assets', 'index-fixture.css'), 'body{margin:0}');
    return dir;
}

/** A file of `size` bytes that takes no disk to speak of: its length is set, nothing is written. */
function sparseFile(path, size) {
    const fd = openSync(path, 'w');
    try { ftruncateSync(fd, size); } finally { closeSync(fd); }
    return path;
}

function checkSelf(scratchRoot) {
    console.log('\nThe gate fails what is over budget, and passes what is not');
    const jsBudget = BUDGETS.firstLoadJsBrotli.budget;
    const over = runSelf(['--dist', fixtureDist(join(scratchRoot, 'dist-over'), jsBudget + 50 * 1024)]);
    check('a first load 50 kB over the brotli budget fails the gate', over.status === 1, `exit ${over.status}`);
    check('… and the failure names that budget',
        /FAIL {2}First load JavaScript, brotli: .* over its budget by/.test(over.out), over.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ') || over.out.slice(-400));
    const under = runSelf(['--dist', fixtureDist(join(scratchRoot, 'dist-under'), jsBudget - 50 * 1024)]);
    check('the same fixture 50 kB under it passes', under.status === 0, under.out.slice(-600));

    const zipBudget = BUDGETS['package-win32-x64'].budget;
    const big = sparseFile(join(scratchRoot, 'Terramentor-0.0.0-win32-x64.zip'), zipBudget + 1024 * 1024);
    const zipOver = runSelf(['--package', big]);
    check('a Windows zip 1 MB over its budget fails the gate', zipOver.status === 1 && /FAIL {2}Windows package/.test(zipOver.out), zipOver.out.slice(-400));
    const smallDir = join(scratchRoot, 'small');
    mkdirSync(smallDir, { recursive: true });
    const small = sparseFile(join(smallDir, 'Terramentor-0.0.0-win32-x64.zip'), zipBudget - 1024 * 1024);
    const zipUnder = runSelf(['--package', small]);
    check('one 1 MB under it passes', zipUnder.status === 0, zipUnder.out.slice(-400));
    const unnamed = runSelf(['--package', sparseFile(join(scratchRoot, 'something.zip'), 10)]);
    check('a zip that names no platform fails rather than passing unchecked', unnamed.status === 1, unnamed.out.slice(-400));
}

// ---------------------------------------------------------------------------

const { removeScratch, findBrowser } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-shots.mjs')).href);

if (args.includes('--package')) {
    checkPackages(after('--package'));
    done();
}
if (args.includes('--dist')) {
    try { checkBytes(resolve(value('--dist'))); } catch (err) { check('the build could be measured', false, err.message); }
    done();
}

// Edge started from some shells carries a compatibility layer and restarts
// itself without it, leaving the launcher to exit while an orphan runs on.
delete process.env.__COMPAT_LAYER;

const only = value('--only');
if (only && !['bytes', 'server', 'screen', 'self'].includes(only)) { check(`--only ${only}`, false, 'one of bytes, server, screen, self'); done(); }
const part = (name) => !only || only === name;

const scratch = mkdtempSync(join(tmpdir(), 'perf-budget-gates-'));
try {
    if ((part('bytes') || part('screen')) && !ensureDist()) throw new Error('no build to measure');
    if (part('bytes')) checkBytes(join(ROOT, 'dist'));
    if (part('server')) await checkServerStart(scratch);
    if (part('screen')) {
        let browserPath = null;
        try { browserPath = findBrowser(value('--browser')); } catch { /* none */ }
        if (browserPath) await checkFirstScreen(scratch, browserPath);
        else if (ON_CI) check('a browser to time the first screen in', false, 'no Edge or Chrome on this runner');
        else console.log('\nFirst screen: SKIPPED, no Edge or Chrome found (pass --browser <path>)');
    }
    if (part('self')) checkSelf(scratch);
} catch (err) {
    check('the run finished', false, err.stack || err.message);
} finally {
    removeScratch(scratch);
}
done();
