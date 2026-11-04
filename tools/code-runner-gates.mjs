#!/usr/bin/env node
// tools/code-runner-gates.mjs — a learner's code runs behind walls the
// browser enforces, and is stopped when it runs too long, takes too much
// memory or floods its way out.
//
// Run:  node tools/code-runner-gates.mjs [--browser <path>] [--weaken connect|same-origin|kill|memory]
//
// WHY. Code answers are run on the learner's own device (src/runner/), and the
// code can come from the learner, an imported course or a model, so none of
// it is trusted. Each wall is a browser rule, so each is
// tested in a real browser, against the shipped shell and worker:
//
//   1. the policies, exactly (static): the runner shell's CSP has no address
//      of any kind and runs only its own bootstrap (by hash) and blobs; the
//      visuals' shell did not gain eval or wasm; the frame is sandboxed to
//      `allow-scripts` alone; the service worker and the dev proxy leave the
//      shell to the server;
//   2. the pieces (Node): the wasm memory ceiling is really lowered in
//      Pyodide's own module, the tests a question carries are capped and
//      shaped the same on both sides, and the page reads a forged result as
//      nothing more than a verdict;
//   3. the walls (browser, a probe worker with every network API still in
//      place): fetch, XHR, WebSocket, EventSource and a remote import reach
//      neither this app's address nor another port; the worker's origin is
//      opaque, so storage is refused and a BroadcastChannel never reaches the
//      page;
//   4. the runner end to end (browser, real Pyodide and QuickJS-ng): verdicts
//      are right, a broken reference or a disputed `expect` grades nothing,
//      Python's every network route is dead, an endless loop is stopped
//      within a second of the limit while the page keeps answering, 600 MB
//      becomes a MemoryError, output stops at 64 KB, a message flood ends the
//      run, and a forged phase does not buy more time.
//
// `--weaken` serves a deliberately weakened sandbox and must turn this red:
//   connect      the shell allows every address
//   same-origin  the frame keeps the app's origin
//   kill         the shell never stops its worker (the page's backstop still does, later)
//   memory       Python's memory ceiling is left at 4 GB
//
// The browser half needs Edge or Chrome. Without one it is SKIPPED locally and
// fails in CI.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const express = require('express');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');
const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const weaken = argOf('--weaken');
if (weaken && !['connect', 'same-origin', 'kill', 'memory'].includes(weaken)) {
    console.error(`unknown --weaken ${weaken}`);
    process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'code-runner-gates-'));
let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const frameModule = await import(pathToFileURL(join(repoRoot, 'server/runnerFrame.js')).href);
const sandboxModule = await import(pathToFileURL(join(repoRoot, 'server/sandboxFrame.js')).href);
const { RUNNER_FRAME_CSP, RUNNER_FRAME_SCRIPT, RUNNER_FRAME_SCRIPT_HASH, RUNNER_FRAME_PATH, RUNNER_LIMITS } = frameModule;
const { normalizeCodeTests, normalizeQuestionFormat, CODE_TEST_LIMITS } = await import(pathToFileURL(join(repoRoot, 'server/answerFormats.js')).href);

const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...values] = d.split(/\s+/);
    return [name, values];
}));
const sha256 = (s) => `sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}`;

// ---------------------------------------------------------------------------
section('1. the policies, exactly');
{
    const d = directives(RUNNER_FRAME_CSP);
    check('the shell is /runner.html', RUNNER_FRAME_PATH === '/runner.html');
    check('no address of any kind: default-src and connect-src are \'none\'',
        d['default-src']?.join(' ') === "'none'" && d['connect-src']?.join(' ') === "'none'", RUNNER_FRAME_CSP);
    check('script: its own bootstrap by hash, eval and wasm for the runtimes, blobs, and nothing else',
        JSON.stringify(d['script-src']) === JSON.stringify([`'${RUNNER_FRAME_SCRIPT_HASH}'`, "'unsafe-eval'", "'wasm-unsafe-eval'", 'blob:']),
        String(d['script-src']));
    // frame-ancestors names who may frame the shell, not what it may reach.
    const reach = RUNNER_FRAME_CSP.split(';').filter((x) => !/^\s*frame-ancestors\b/.test(x)).join(';');
    check('no \'self\', no scheme, no wildcard, no inline in anything the shell may load or reach',
        !/'self'|https?:|wss?:|\*|'unsafe-inline'|data:|filesystem:/.test(reach), reach);
    check('workers only from blobs', d['worker-src']?.join(' ') === 'blob:');
    check('framed only by this app, no <base>, no form', d['frame-ancestors']?.join(' ') === "'self'"
        && d['base-uri']?.join(' ') === "'none'" && d['form-action']?.join(' ') === "'none'");
    check('the policy sandboxes the shell itself to allow-scripts alone', d.sandbox?.join(' ') === 'allow-scripts');
    const actual = sha256(RUNNER_FRAME_SCRIPT);
    check('the hash in the policy is the bootstrap\'s own', RUNNER_FRAME_SCRIPT_HASH === actual,
        `set RUNNER_FRAME_SCRIPT_HASH = '${actual}' in server/runnerFrame.js`);
    check('the shell carries exactly one script, the bootstrap', (frameModule.RUNNER_FRAME_HTML.match(/<script\b/g) || []).length === 1
        && frameModule.RUNNER_FRAME_HTML.includes(`<script>${RUNNER_FRAME_SCRIPT}</script>`));
    const sd = directives(sandboxModule.SANDBOX_FRAME_CSP);
    check('the visuals\' shell did not gain eval or wasm', !/unsafe-eval|wasm-unsafe-eval|blob:/.test(String(sd['script-src'])), String(sd['script-src']));

    const host = read('src/runner/frameHost.ts');
    check('the frame is sandboxed to exactly allow-scripts', /export const RUNNER_SANDBOX = 'allow-scripts';/.test(host)
        && /setAttribute\('sandbox', RUNNER_SANDBOX\)/.test(host));
    check('…grants no feature (allow is empty) and sends no referrer', /setAttribute\('allow', ''\)/.test(host) && /referrerpolicy', 'no-referrer'/.test(host));
    check('…and answers only its own frame', /e\.source !== frame\.contentWindow/.test(host));
    check('the bootstrap takes its boot from its parent only, once', /if \(taken \|\| e\.source !== host\) return;/.test(RUNNER_FRAME_SCRIPT)
        && /window\.removeEventListener\('message', take\)/.test(RUNNER_FRAME_SCRIPT));
    check('…and starts the worker as a blob, never by address', /new Worker\(url\);/.test(RUNNER_FRAME_SCRIPT)
        && /URL\.createObjectURL\(new Blob\(\[boot\.worker\]/.test(RUNNER_FRAME_SCRIPT));

    const sw = read('src/sw-template.js');
    const m = sw.match(/function isBypassed\(url\) \{[\s\S]*?\r?\n\}\r?\n/);
    let bypassed = null;
    if (m) { try { bypassed = vm.runInNewContext(`${m[0]}; isBypassed`, { URL }); } catch { /* checked below */ } }
    check('the service worker leaves /runner.html to the network', !!bypassed && bypassed(new URL('http://127.0.0.1:3001/runner.html')) === true);
    check('the dev server forwards /runner.html to the API', /['"]\/runner\.html['"]\s*:\s*\{\s*target:\s*apiTarget/.test(read('vite.config.ts')));
    check('the app serves it before the password gate', /app\.get\(RUNNER_FRAME_PATH, sendRunnerFrame\)/.test(read('server/app.js'))
        && /'GET \/runner\.html'/.test(read('tools/route-table-gates.mjs')));
}

// ---------------------------------------------------------------------------
section('2. the pieces');
async function bundleForNode(entry, name) {
    const outfile = join(scratch, `${name}.mjs`);
    await esbuild.build({ stdin: { contents: entry, resolveDir: repoRoot, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
    return import(pathToFileURL(outfile).href);
}
const pieces = await bundleForNode(
    "export * from './src/runner/wasmMemory.ts'; export * from './src/runner/languages.ts'; export * from './src/runner/protocol.ts';",
    'pieces',
);
const pyodideDir = join(repoRoot, 'node_modules', 'pyodide');
const qjsWasmPath = require.resolve('@jitl/quickjs-ng-wasmfile-release-sync/wasm');
{
    const wasm = new Uint8Array(readFileSync(join(pyodideDir, 'pyodide.asm.wasm')));
    const before = pieces.readMemoryLimits(wasm);
    check('Pyodide defines its own memory, with a 4 GB ceiling', before.maximumPages === 65536, JSON.stringify(before));
    const lowered = pieces.lowerMemoryMaximum(wasm, 4096);
    const after = pieces.readMemoryLimits(lowered);
    check('…lowered to 256 MB, starting size untouched', after.maximumPages === 4096 && after.initialPages === before.initialPages, JSON.stringify(after));
    let changed = 0;
    for (let i = 0; i < wasm.length; i++) if (wasm[i] !== lowered[i]) changed++;
    check('…in the same bytes: same length, at most 3 bytes differ', lowered.length === wasm.length && changed > 0 && changed <= 3, `${changed} bytes`);
    check('…on a copy: the original bytes are untouched', pieces.readMemoryLimits(wasm).maximumPages === 65536);
    let compiled = false;
    try { compiled = WebAssembly.validate(lowered); } catch { /* reported */ }
    check('…and the result is still a valid module', compiled);
    const throws = (fn) => { try { fn(); return false; } catch { return true; } };
    check('a module that imports its memory is refused, not passed through uncapped',
        throws(() => pieces.lowerMemoryMaximum(new Uint8Array(readFileSync(qjsWasmPath)), 1024)));
    check('raising the ceiling, or going below the start, is refused',
        throws(() => pieces.lowerMemoryMaximum(wasm, 70000)) && throws(() => pieces.lowerMemoryMaximum(wasm, 1)));
    // (module (memory 1)) — no maximum at all.
    const noMax = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 3, 1, 0, 1]);
    check('a memory with no maximum is refused', throws(() => pieces.lowerMemoryMaximum(noMax, 16)));
}
{
    const many = Array.from({ length: 20 }, (_, i) => ({ call: `f(${i})` }));
    check('at most 12 tests are kept', normalizeCodeTests(many).length === CODE_TEST_LIMITS.maxTests && pieces.codeTestsOf(many).length === pieces.MAX_TESTS);
    const mixed = [
        { call: 'f(1)', stdin: '1' }, { expect: '3' }, { call: 42 }, null, 'f(2)', [],
        { call: 'f(3)', expect: '9' }, { stdin: '4\\n5' }, { call: 'x'.repeat(2001) }, { call: 'f(4)', expect: 16 },
    ];
    const server = normalizeCodeTests(mixed);
    check('a test is a call or a standard input, never both, never neither; junk is dropped',
        JSON.stringify(server) === JSON.stringify([{ call: 'f(3)', expect: '9' }, { stdin: '4\n5' }, { call: 'f(4)', expect: '16' }]), JSON.stringify(server));
    check('the client reads what the server stored the same way', JSON.stringify(pieces.codeTestsOf(server)) === JSON.stringify(server));
    const big = Array.from({ length: 12 }, () => ({ stdin: 'y'.repeat(1990) }));
    const kept = normalizeCodeTests(big);
    check('all tests together stay under 16,000 characters', kept.length === 8, `${kept.length} kept`);
    const q = normalizeQuestionFormat({ type: 'code', language: 'python', correct_answer: 'def f(x):\n    return x * 2', tests: [{ call: 'f(2)', expect: '4' }] });
    check('a code question keeps its tests through the format registry', JSON.stringify(q?.tests) === '[{"call":"f(2)","expect":"4"}]', JSON.stringify(q));
    const imported = normalizeQuestionFormat({ type: 'code', language: 'python', correct_answer: 'def f(x):\n    return x * 2', tests: [{ call: 'f(2)' }] }, { stored: true });
    check('…and through the import door', JSON.stringify(imported?.tests) === '[{"call":"f(2)"}]');
    check('python, py, javascript and js are runnable; sql, c and a missing name are not',
        pieces.runnableLanguage('Python') === 'python' && pieces.runnableLanguage('py') === 'python' && pieces.runnableLanguage('js') === 'javascript'
        && pieces.runnableLanguage('javascript') === 'javascript' && pieces.runnableLanguage('sql') === null && pieces.runnableLanguage('c') === null
        && pieces.runnableLanguage(undefined) === null);
}
{
    const forged = pieces.readRunResult({ status: 'done', tests: [{ input: 'a', expected: 'b', actual: 'c', pass: 'yes', extra: 1 }], html: '<img>', output: 'x'.repeat(100000), keyProblem: 'nope' }, 'learner');
    check('a result is read field by field: unknown fields dropped, "pass" must be true itself',
        !('html' in forged) && forged.tests?.[0]?.pass === false && !('extra' in forged.tests[0]) && !('keyProblem' in forged));
    check('…its output capped at 64 KB', forged.output.length <= 65536 + 1);
    check('…an unknown status is a crash, an unknown phase is "load"',
        pieces.readRunResult({ status: 'passed' }, 'nowhere').status === 'crash' && pieces.readRunResult(null, 'nowhere').phase === 'load');
    const rows = pieces.readRunResult({ status: 'done', tests: Array.from({ length: 50 }, () => ({ pass: true })) }, 'learner').tests;
    check('…and at most 12 rows', rows.length === 12);
}

// ---------------------------------------------------------------------------
// The browser half.
// ---------------------------------------------------------------------------

function findBrowser() {
    const explicit = argOf('--browser') || process.env.BROWSER_PATH;
    if (explicit) return explicit;
    const candidates = process.platform === 'win32'
        ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Google/Chrome/Application/chrome.exe']
        : process.platform === 'darwin'
            ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
            : ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    return candidates.find((p) => existsSync(p)) || null;
}

function listen(server) {
    return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
}

async function openBrowser(exe) {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    const profile = mkdtempSync(join(tmpdir(), 'code-runner-browser-'));
    const argv = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
        `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'];
    // A Linux CI runner refuses Chromium's own process sandbox; the web
    // platform's (CSP, the iframe sandbox, origins) is unaffected by the flag.
    if (process.platform === 'linux' && process.env.CI) argv.unshift('--no-sandbox');
    const proc = spawn(exe, argv, { stdio: 'ignore' });
    const exited = new Promise((r) => proc.once('exit', r));
    let wsUrl;
    for (let i = 0; i < 120 && !wsUrl; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
        } catch { /* not listening yet */ }
        if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) { proc.kill(); throw new Error(`${exe} did not open a DevTools port`); }
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('the DevTools socket did not open')); });
    let next = 0;
    const pending = new Map();
    const consoleLines = [];
    // `--verbose` follows the frame and its workers too (CDP auto-attach), and
    // prints what each logs and every policy refusal, as it happens.
    const verbose = args.includes('--verbose');
    const note = (where, text) => { consoleLines.push(`${where}: ${text}`); if (verbose) console.log(`        [${where}] ${text}`); };
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        const where = m.sessionId ? `child ${m.sessionId.slice(0, 6)}` : 'page';
        if (m.method === 'Runtime.consoleAPICalled') note(where, m.params.args.map((a) => a.value ?? a.description).join(' '));
        if (m.method === 'Runtime.exceptionThrown') note(where, m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
        if (m.method === 'Log.entryAdded') note(where, `${m.params.entry.level} ${m.params.entry.text}`);
        if (m.method === 'Target.attachedToTarget') {
            const sessionId = m.params.sessionId;
            note('target', `${m.params.targetInfo.type} ${m.params.targetInfo.url.slice(0, 80)}`);
            for (const method of ['Runtime.enable', 'Log.enable', 'Runtime.runIfWaitingForDebugger']) {
                ws.send(JSON.stringify({ id: ++next, sessionId, method, params: {} }));
            }
            ws.send(JSON.stringify({ id: ++next, sessionId, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
        }
        if (m.id === undefined) return;
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.bad(new Error(m.error.message)); else p.ok(m.result);
    };
    const send = (method, params = {}) => new Promise((ok, bad) => {
        const id = ++next;
        pending.set(id, { ok, bad });
        ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    if (verbose) {
        await send('Log.enable');
        await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    }
    const close = async () => {
        try { ws.close(); } catch { /* closed */ }
        proc.kill();
        await Promise.race([exited, sleep(10_000)]);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold it */ }
    };
    return { send, evaluate, close, consoleLines };
}

// The page's own policy, read from the app rather than copied, so a change
// there is tested here.
function pagePolicy() {
    const src = read('server/app.js');
    const m = src.match(/const CSP_ENFORCED = (\[[\s\S]*?\])\.join\('; '\);/);
    if (!m) throw new Error('CSP_ENFORCED not found in server/app.js');
    return vm.runInNewContext(m[1]).join('; ');
}

// The worker the probe runs: no runtime, every network API still on its
// global object, so what stops it is the policy and the origin alone.
const PROBE_WORKER = String.raw`
const post = self.postMessage.bind(self);
self.onmessage = async (e) => {
    if (e.data && e.data.boot) { post({ phase: 'ready' }); return; }
    if (!e.data || !e.data.job) return;
    post({ phase: 'learner' });
    const C = JSON.parse(e.data.job.learner);
    const report = { origin: String(self.origin) };
    const attempt = async (name, fn) => {
        try { const v = await Promise.race([fn(), new Promise((_, bad) => setTimeout(() => bad(new Error('timeout')), 2500))]); report[name] = 'reached ' + String(v).slice(0, 60); }
        catch (err) { report[name] = 'blocked'; }
    };
    await attempt('fetch to this app', () => fetch(C.same + '?probe-fetch-same').then((r) => r.status));
    await attempt('fetch to another port', () => fetch(C.cross + '?probe-fetch-cross', { mode: 'no-cors' }).then((r) => r.type));
    await attempt('XHR', () => new Promise((ok, bad) => { const x = new XMLHttpRequest(); x.open('GET', C.cross + '?probe-xhr'); x.onload = () => ok(x.status); x.onerror = () => bad(new Error('xhr')); x.send(); }));
    await attempt('WebSocket', () => new Promise((ok, bad) => { const w = new WebSocket(C.ws + '?probe-ws'); w.onopen = () => ok('open'); w.onerror = () => bad(new Error('ws')); }));
    await attempt('EventSource', () => new Promise((ok, bad) => { const s = new EventSource(C.cross + '?probe-es'); s.onopen = () => ok('open'); s.onerror = () => { s.close(); bad(new Error('es')); }; }));
    await attempt('remote import', () => import(C.cross + '?probe-import'));
    await attempt('a nested blob worker fetching', () => new Promise((ok, bad) => {
        const w = new Worker(URL.createObjectURL(new Blob(['fetch(' + JSON.stringify(C.cross + '?probe-nested') + ', { mode: "no-cors" }).then(() => postMessage("reached"), () => postMessage("blocked"))'], { type: 'text/javascript' })));
        w.onmessage = (m) => (m.data === 'reached' ? ok('reached') : bad(new Error('blocked')));
        w.onerror = () => bad(new Error('nested'));
    }));
    await attempt('IndexedDB', () => new Promise((ok, bad) => { const r = indexedDB.open('runner-probe'); r.onsuccess = () => ok('open'); r.onerror = () => bad(new Error('idb')); }));
    await attempt('Cache Storage', () => caches.open('runner-probe').then(() => 'open'));
    try { const ch = new BroadcastChannel('runner-gate'); ch.postMessage('from the runner'); report.broadcast = 'sent'; } catch (err) { report.broadcast = 'blocked'; }
    post({ result: { status: 'done', output: JSON.stringify(report) } });
};
`;

// The page side: the real frame host (src/runner/frameHost.ts), driven by a
// small harness that assembles boot payloads from this server's files.
const HOST_ENTRY = `
import { openRunnerFrame } from './src/runner/frameHost';
const files = new Map();
const bytes = (name) => {
    if (!files.has(name)) files.set(name, fetch('/files/' + name).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)));
    return files.get(name);
};
const text = (name) => fetch('/files/' + name).then((r) => r.text());
let workerSource = null;
const heard = [];
new BroadcastChannel('runner-gate').onmessage = (m) => heard.push(String(m.data));
window.__heard = heard;
window.__gate = {
    async run({ language, memoryMb, job, probe, brokenWasm }) {
        workerSource ??= await text('worker.js');
        let payload;
        if (probe) payload = { language: 'javascript', memoryMb: 1, files: {} };
        else if (language === 'python') {
            const [loader, asm, lock, wasm, stdlib] = await Promise.all([text('pyodide.mjs'), text('pyodide.asm.mjs'), text('pyodide-lock.json'), bytes('pyodide.asm.wasm'), bytes('python_stdlib.zip')]);
            payload = { language, memoryMb, files: { 'pyodide.mjs': loader, 'pyodide.asm.mjs': asm, 'pyodide-lock.json': lock, 'pyodide.asm.wasm': brokenWasm ? new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) : wasm, 'python_stdlib.zip': stdlib } };
        } else payload = { language, memoryMb, files: { 'quickjs.wasm': await bytes('quickjs.wasm') } };
        let last = performance.now();
        let maxGap = 0;
        const tick = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 50);
        const t0 = performance.now();
        const frame = openRunnerFrame({ worker: probe ? ${JSON.stringify(PROBE_WORKER)} : workerSource, payload });
        const failed = await frame.ready;
        const bootMs = performance.now() - t0;
        let result = failed;
        let learnerAt = null;
        if (!failed) {
            last = performance.now();
            maxGap = 0;
            result = await frame.run(job, (p) => { if (p === 'learner') learnerAt = performance.now(); });
        }
        const end = performance.now();
        clearInterval(tick);
        return { result, bootMs, learnerMs: learnerAt === null ? null : end - learnerAt, maxGap, frames: document.querySelectorAll('iframe[data-runner-frame]').length };
    },
};
`;

async function browserHalf(exe) {
    // The other origin: a second port that records every request and socket.
    const hits = [];
    const cross = createServer((req, res) => { hits.push(`cross ${req.url}`); res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); res.end('reached'); });
    cross.on('upgrade', (req, socket) => { hits.push(`cross upgrade ${req.url}`); socket.destroy(); });
    const crossPort = await listen(cross);

    const worker = (await import(pathToFileURL(join(repoRoot, 'tools/lib/runnerWorker.mjs')).href));
    const built = await worker.buildRunnerWorker();
    const host = await esbuild.build({ stdin: { contents: HOST_ENTRY, resolveDir: repoRoot, loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });

    // The shell, as the app serves it, or weakened.
    let script = RUNNER_FRAME_SCRIPT;
    if (weaken === 'kill') script = script.replace(/RUN_MS = \d+/, 'RUN_MS = 600000');
    let csp = RUNNER_FRAME_CSP.replace(`'${RUNNER_FRAME_SCRIPT_HASH}'`, `'${sha256(script)}'`);
    if (weaken === 'connect') csp = csp.replace("default-src 'none'", 'default-src *').replace("connect-src 'none'", 'connect-src * ws: wss:').replace('blob:;', 'blob: *;');
    if (weaken === 'same-origin') csp = csp.replace('sandbox allow-scripts', 'sandbox allow-scripts allow-same-origin');
    const shell = frameModule.RUNNER_FRAME_HTML.replace(RUNNER_FRAME_SCRIPT, () => script);

    const fileMap = {
        'pyodide.mjs': join(pyodideDir, 'pyodide.mjs'),
        'pyodide.asm.mjs': join(pyodideDir, 'pyodide.asm.mjs'),
        'pyodide-lock.json': join(pyodideDir, 'pyodide-lock.json'),
        'pyodide.asm.wasm': join(pyodideDir, 'pyodide.asm.wasm'),
        'python_stdlib.zip': join(pyodideDir, 'python_stdlib.zip'),
        'quickjs.wasm': qjsWasmPath,
    };
    const app = express();
    const policy = pagePolicy();
    app.use((req, res, next) => { res.setHeader('Content-Security-Policy', policy); next(); });
    app.get('/', (req, res) => res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><title>runner gate</title></head><body><script type="module" src="/host.js"></script></body></html>'));
    app.get('/host.js', (req, res) => {
        let code = host.outputFiles[0].text;
        if (weaken === 'same-origin') code = `const set = Element.prototype.setAttribute; Element.prototype.setAttribute = function (n, v) { return set.call(this, n, n === 'sandbox' ? v + ' allow-same-origin' : v); };\n${code}`;
        res.type('js').send(code);
    });
    app.get(RUNNER_FRAME_PATH, (req, res) => {
        res.setHeader('Content-Security-Policy', csp);
        res.setHeader('Cache-Control', 'no-cache');
        res.type('html').send(shell);
    });
    app.get('/files/worker.js', (req, res) => res.type('text/plain').send(built.code));
    app.get('/files/:name', (req, res) => {
        const p = fileMap[req.params.name];
        if (!p) return res.sendStatus(404);
        res.sendFile(p);
    });
    app.get('/api/canary', (req, res) => { hits.push(`same ${req.url}`); res.send('reached'); });
    const server = createServer(app);
    server.on('upgrade', (req, socket) => { hits.push(`same upgrade ${req.url}`); socket.destroy(); });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const canary = { same: `${base}/api/canary`, cross: `http://127.0.0.1:${crossPort}/canary`, ws: `ws://127.0.0.1:${crossPort}/ws` };

    const browser = await openBrowser(exe);
    try {
        await browser.send('Page.navigate', { url: `${base}/` });
        for (let i = 0; i < 100; i++) {
            if (await browser.evaluate('!!window.__gate').catch(() => false)) break;
            await sleep(100);
        }
        const run = (opts) => browser.evaluate(`window.__gate.run(${JSON.stringify(opts)})`);
        const py = (job, extra = {}) => run({ language: 'python', memoryMb: weaken === 'memory' ? 4096 : 256, job, ...extra });
        const js = (job) => run({ language: 'javascript', memoryMb: 64, job });
        const ADD = 'def add(a, b):\n    return a + b';
        const addTests = [{ call: 'add(2, 3)', expect: '5' }, { call: 'add(-1, 1)' }, { call: 'add(0.1, 0.2)' }];
        const PY_ATTACKS = String.raw`
import js, json
CROSS = ${JSON.stringify(canary.cross)}
SAME = ${JSON.stringify(canary.same)}
out = {}
def attempt(name, fn):
    try:
        fn()
        out[name] = 'reached'
    except BaseException as e:
        out[name] = 'blocked'
attempt('js.fetch', lambda: js.fetch(CROSS + '?py-js-fetch'))
from pyodide.code import run_js
attempt('run_js fetch', lambda: run_js("fetch(" + json.dumps(SAME + '?py-run-js') + ")"))
attempt('run_js XHR', lambda: run_js("var x = new XMLHttpRequest(); x.open('GET', " + json.dumps(CROSS + '?py-xhr') + ", false); x.send(); x.status"))
attempt('run_js WebSocket', lambda: run_js("new WebSocket(" + json.dumps(${JSON.stringify(canary.ws)} + '?py-ws') + ")"))
attempt('run_js nested worker', lambda: run_js("new Worker(URL.createObjectURL(new Blob(['fetch(\"" + CROSS + "?py-nested\")'])))"))
import urllib.request
attempt('urllib', lambda: urllib.request.urlopen(CROSS + '?py-urllib', timeout=2))
import socket
attempt('socket', lambda: socket.create_connection(('127.0.0.1', ${crossPort}), timeout=2))
from pyodide.http import open_url
attempt('open_url', lambda: open_url(CROSS + '?py-open-url'))
print(json.dumps(out))
`;

        section('3. the walls (a probe with every network API in place)');
        const [probe, pyBatch, jsBatch] = await Promise.all([
            run({ probe: true, job: { mode: 'run', learner: JSON.stringify(canary), tests: [] } }),
            Promise.all([
                py({ mode: 'check', reference: ADD, learner: 'def add(x, y):\n    total = x + y\n    return total', tests: addTests }),
                py({ mode: 'check', reference: ADD, learner: 'def add(a, b):\n    return a - b', tests: addTests }),
                py({ mode: 'check', reference: 'def add(a, b) return a + b', learner: ADD, tests: addTests }),
                py({ mode: 'check', reference: ADD, learner: ADD, tests: [{ call: 'add(2, 3)', expect: '6' }] }),
                py({ mode: 'check', reference: 'n = int(input("Enter n: "))\nprint(n * 2)', learner: 'print(int(input()) * 2)', tests: [{ stdin: '21\n' }, { stdin: '0\n', expect: '0' }] }),
                py({ mode: 'run', learner: PY_ATTACKS, tests: [] }),
                py({ mode: 'run', learner: 'x = bytearray(600 * 1024 * 1024)\nprint(len(x))', tests: [] }),
                py({ mode: 'run', learner: "print('x' * 200000)", tests: [] }),
                py({ mode: 'check', reference: ADD, learner: ADD, tests: addTests }, { brokenWasm: true }),
                py({ mode: 'check', reference: 'print(input())', learner: "print('x' * 200000)", tests: [{ stdin: 'hello\n' }] }),
                py({ mode: 'run', learner: ADD, tests: [{ call: 'add(2, 3)' }] }),
            ]),
            Promise.all([
                js({ mode: 'check', reference: 'function add(a, b) { return a + b; }', learner: 'const add = (x, y) => x + y;', tests: [{ call: 'add(2, 3)', expect: '5' }, { call: 'add("a", "b")', expect: '"ab"' }, { call: 'add(0.1, 0.2)' }] }),
                js({ mode: 'check', reference: 'function add(a, b) { return a + b; }', learner: 'function add(a, b) { return a * b; }', tests: [{ call: 'add(2, 3)' }, { call: 'add(2, 2)' }] }),
                js({ mode: 'check', reference: 'function m() { return new Map([[1, 2]]); }', learner: 'function m() { return new Map([[1, 3]]); }', tests: [{ call: 'm()' }] }),
                js({ mode: 'check', reference: 'const n = Number(prompt()); console.log(n * 2);', learner: 'console.log(Number(prompt()) * 2)', tests: [{ stdin: '21\n' }] }),
                js({ mode: 'run', learner: 'const a = []; while (true) a.push(new ArrayBuffer(8 * 1024 * 1024));', tests: [] }),
                js({ mode: 'run', learner: 'console.log([typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof postMessage, typeof importScripts, typeof Worker].join(" "))', tests: [] }),
                js({ mode: 'check', reference: 'function add(a, b) { return a + b; }', learner: 'function add(a, b) { return a + b; }', tests: [{ call: 'add(2, 3)', expect: '6' }] }),
            ]),
        ]);
        await sleep(1500); // anything in flight lands before the canaries are read

        let report = {};
        try { report = JSON.parse(probe.result.output); } catch { /* reported below */ }
        check('the probe ran in the frame', probe.result.status === 'done', JSON.stringify(probe.result).slice(0, 200));
        for (const name of ['fetch to this app', 'fetch to another port', 'XHR', 'WebSocket', 'EventSource', 'remote import', 'a nested blob worker fetching']) {
            check(`${name}: refused`, report[name] === 'blocked', String(report[name]));
        }
        check('the worker\'s origin is opaque', report.origin === 'null', String(report.origin));
        check('IndexedDB and Cache Storage are refused', report.IndexedDB === 'blocked' && report['Cache Storage'] === 'blocked', `${report.IndexedDB} / ${report['Cache Storage']}`);
        const heard = await browser.evaluate('window.__heard.slice()');
        check('a BroadcastChannel message never reaches the page', heard.length === 0, JSON.stringify(heard));

        section('4. the runner end to end');
        const [pPass, pFail, pBroken, pExpect, pStdin, pAttack, pMemory, pOutput, pNoBoot, pOver, pRunCall] = pyBatch;
        const allPass = (r) => r.result.status === 'done' && !r.result.keyProblem && r.result.tests?.length > 0 && r.result.tests.every((t) => t.pass);
        check('Python: a correct answer in other words passes every test', allPass(pPass) && pPass.result.tests.length === 3, JSON.stringify(pPass.result).slice(0, 300));
        check('Python: a wrong answer fails, showing what it got', pFail.result.status === 'done' && pFail.result.tests?.[0]?.pass === false
            && pFail.result.tests[0].expected === '5' && pFail.result.tests[0].actual === '-1', JSON.stringify(pFail.result).slice(0, 300));
        check('Python: a reference that does not run grades nothing', pBroken.result.keyProblem === 'reference-error' && !pBroken.result.tests, JSON.stringify(pBroken.result));
        check('Python: an expect the reference disputes grades nothing', pExpect.result.keyProblem === 'expect-mismatch', JSON.stringify(pExpect.result));
        check('Python: input() tests compare the printed output, prompts aside', allPass(pStdin)
            && pStdin.result.tests[0].kind === 'stdin' && pStdin.result.tests[0].input === '21\n' && pStdin.result.tests[0].expected === '42',
        JSON.stringify(pStdin.result).slice(0, 300));
        check('Python: a test that prints past 64 KB fails, marked as cut off', pOver.result.tests?.[0]?.pass === false && pOver.result.tests[0].over === true
            && pOver.result.tests[0].actual === '', JSON.stringify(pOver.result).slice(0, 300));
        check('Python: Run shows the value of the question\'s first call', pRunCall.result.status === 'done' && pRunCall.result.value === '5' && !pRunCall.result.tests,
            JSON.stringify(pRunCall.result).slice(0, 200));
        let attacks = {};
        try { attacks = JSON.parse(String(pAttack.result.output).trim().split('\n').pop()); } catch { /* reported below */ }
        const routes = ['js.fetch', 'run_js fetch', 'run_js XHR', 'run_js WebSocket', 'run_js nested worker', 'urllib', 'socket', 'open_url'];
        check('Python: every network route raises', routes.every((r) => attacks[r] === 'blocked'), JSON.stringify(attacks) || String(pAttack.result.error));
        check('Python: 600 MB is a MemoryError, and the run still ends normally', pMemory.result.status === 'done' && /MemoryError/.test(String(pMemory.result.error)),
            JSON.stringify(pMemory.result).slice(0, 200));
        check('Python: output stops at 64 KB', pOutput.result.status === 'done' && String(pOutput.result.output).length <= 65536 + 1 && String(pOutput.result.output).length >= 65000,
            `${String(pOutput.result.output ?? '').length} characters`);
        check('a runtime that cannot start says so, and grades nothing', pNoBoot.result.status === 'unavailable' && pNoBoot.result.phase === 'load', JSON.stringify(pNoBoot.result));
        console.log(`        (Python cold start ${Math.round(pPass.bootMs)} ms in this browser)`);
        const [jPass, jFail, jMap, jStdin, jMemory, jGlobals, jExpect] = jsBatch;
        check('JavaScript: a correct answer in other words passes every test', allPass(jPass), JSON.stringify(jPass.result).slice(0, 300));
        check('JavaScript: a wrong answer fails', jFail.result.status === 'done' && jFail.result.tests?.some((t) => !t.pass), JSON.stringify(jFail.result).slice(0, 300));
        check('JavaScript: two Maps that differ inside are different', jMap.result.tests?.[0]?.pass === false, JSON.stringify(jMap.result).slice(0, 300));
        check('JavaScript: prompt() tests compare the printed output', allPass(jStdin) && jStdin.result.tests[0].kind === 'stdin'
            && jStdin.result.tests[0].expected === '42', JSON.stringify(jStdin.result).slice(0, 300));
        check('JavaScript: a memory blow-up stops at the fixed ceiling', jMemory.result.status === 'done' && /out of memory|RangeError|InternalError/i.test(String(jMemory.result.error)),
            JSON.stringify(jMemory.result).slice(0, 200));
        check('JavaScript: the code sees no network, messaging or worker API at all', String(jGlobals.result.output).trim() === 'undefined undefined undefined undefined undefined undefined', String(jGlobals.result.output));
        check('JavaScript: an expect the reference disputes grades nothing', jExpect.result.keyProblem === 'expect-mismatch', JSON.stringify(jExpect.result));

        // Run apart from the rest, so their timing is their own.
        const [pFlood, pForge, jLoop] = await Promise.all([
            py({ mode: 'run', learner: 'from pyodide.code import run_js\nrun_js("for (let i = 0; i < 100; i++) postMessage({ i })")\nwhile True:\n    pass', tests: [] }),
            py({ mode: 'run', learner: 'from pyodide.code import run_js\nrun_js("postMessage({ phase: \'reference\' }); postMessage({ phase: \'learner\' })")\nwhile True:\n    pass', tests: [] }),
            js({ mode: 'check', reference: 'function f() { return 1; }', learner: 'function f() { while (true) {} }', tests: [{ call: 'f()' }] }),
        ]);
        const pLoop = await py({ mode: 'check', reference: 'def f():\n    return 1', learner: 'def f():\n    while True:\n        pass', tests: [{ call: 'f()' }] });
        const limit = RUNNER_LIMITS.runMs + 1500;
        check(`Python: an endless loop is stopped within ${limit} ms of starting`, pLoop.result.status === 'timeout' && pLoop.result.phase === 'learner' && pLoop.learnerMs !== null && pLoop.learnerMs < limit,
            `${pLoop.result.status} in ${pLoop.result.phase} after ${Math.round(pLoop.learnerMs ?? -1)} ms`);
        check('…while the page keeps answering (no gap over 500 ms)', pLoop.maxGap < 500, `${Math.round(pLoop.maxGap)} ms`);
        check(`JavaScript: an endless loop is stopped within ${limit} ms`, jLoop.result.status === 'timeout' && jLoop.result.phase === 'learner' && jLoop.learnerMs < limit,
            `${jLoop.result.status} after ${Math.round(jLoop.learnerMs ?? -1)} ms`);
        check('a message flood ends the run as a flood', pFlood.result.status === 'flood', JSON.stringify(pFlood.result));
        check('a forged phase buys no time', pForge.result.status === 'timeout' && pForge.learnerMs < limit, `${pForge.result.status} after ${Math.round(pForge.learnerMs ?? -1)} ms`);
        const left = await browser.evaluate('document.querySelectorAll("iframe[data-runner-frame]").length');
        check('every frame is gone once its job has ended', left === 0, `${left} left`);

        await sleep(500);
        check('no request or socket reached this app or the other port', hits.length === 0, hits.join(', '));
    } finally {
        await browser.close();
        server.close();
        cross.close();
    }
}

const exe = findBrowser();
if (!exe) {
    if (process.env.CI) { fail++; console.log('\n  FAIL  no Edge or Chrome to run the browser half in'); }
    else console.log('\nSKIPPED: the browser half (no Edge or Chrome found; pass --browser <path>)');
} else {
    try {
        await browserHalf(exe);
    } catch (err) {
        fail++;
        console.log(`\n  FAIL  the browser half stopped: ${err?.stack || err}`);
    }
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
if (weaken) console.log(`\n(weakened: ${weaken})`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
