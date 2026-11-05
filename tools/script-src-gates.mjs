#!/usr/bin/env node
/**
 * script-src gates — the page runs only its own files, and every visual still
 * draws under that.
 *
 *   node tools/script-src-gates.mjs
 *
 * The page's enforced policy says `script-src 'self'`: no inline script, no
 * `eval`, no `new Function`. Four things in the app needed one of those, and
 * each is pinned here by what it does:
 *
 *   1. The policy as SERVED, by a real app on a scratch library.
 *   2. Graph formulas. function-plot's two samplers hand every formula to
 *      math-codegen, which compiles it with `new Function`. The build points
 *      `math-codegen` at src/components/visuals/mathCodegen.cjs, which walks
 *      the same parse tree instead. The two are run side by side over the same
 *      formulas and namespaces; ours in a child process where code generation
 *      is switched off, and the real one is shown to fail there, so the switch
 *      is known to bite.
 *   3. Sketch and widget frames. A srcdoc frame inherits the page's policy, so
 *      under 'self' alone its inline scripts could not run. The frames load
 *      /sandbox.html, a shell served with its OWN policy, and are handed their
 *      document by message. The shell's policy, its message protocol, the
 *      client half and both renderers' use of it are pinned here; p5 rides
 *      inline in the sketch document, and a sketch's syntax error is reported
 *      from inside the frame.
 *   4. Chart data written as CSV/TSV text. d3-dsv turns each header row into a
 *      `new Function`; renderVega registers readers that build the rows
 *      without one, checked against d3's own output.
 *
 * Plus the two places a path is spelt twice: the service worker leaves the
 * shell alone, and the dev server forwards it to the API.
 *
 * No model, no network beyond 127.0.0.1; the library is scratch, under
 * node_modules/.cache.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { get } from 'node:http';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OURS = join(root, 'src/components/visuals/mathCodegen.cjs');
const REAL = join(root, 'node_modules/math-codegen/index.js');
// The two samplers and vega's readers are not this app's dependencies; they are
// what function-plot and vega load. So they are found from there, the way the
// bundler finds them: if function-plot ever stops using a sampler, this fails
// to load it rather than testing a copy nothing uses.
const fromPlot = createRequire(join(root, 'node_modules/function-plot/package.json'));
const fromVega = createRequire(join(root, 'node_modules/vega/package.json'));
const samplers = () => [fromPlot('built-in-math-eval'), fromPlot('interval-arithmetic-eval')];

// --- the formulas both evaluators are run over ------------------------------

// What courses actually draw (every `fn` in the plot fences of a real library,
// 27 Oct 2026, and the Settings sample), then the rest of the grammar.
const FORMULAS = [
    'sin(x)', 'x^2-4', '2*x+1', 'x^2', 'sqrt(x)', '1/x', 'x^3', '(2*x^2 - 8)/(x^2 - 4*x - 5)', '0.5*x^2', 'x',
    '(x-1)*(x-2)*(x-4)', '0', '10', '200000000*x + 10000000*(x-0.001)^2*50000000',
    '200000000*0.001 + 10000000*(x-0.001)^2*50000000 - 30000000*(x-0.0015)',
    '0.002*pow(x,0.5)', '1540/x', '50 + 8*x', 'pow(2,x)', '10*exp(-x*log(2)/5730)',
    // implicit multiplication, unary, precedence
    '2x', '3x^2 + 2x - 1', 'x(x+1)', '2(x+1)(x-1)', '-x^2', '-(x)', '+x', '- -x', '-x^-2', '2^3^2', 'x^-1',
    // functions and constants of both namespaces
    'cos(x)^2 + sin(x)^2', 'tan(x)', 'log(x)', 'exp(x)', 'atan(x)', 'asin(x)', 'acos(x)', 'sinh(x)', 'cosh(x)',
    'tanh(x)', 'abs(x) - 1', 'floor(x)', 'ceil(x)', 'min(x, 1)', 'max(x, 0)', 'sqrt(abs(x))', 'nthRoot(x, 3)',
    'PI*x', 'E^x', 'x % 3', 'x!', '3!',
    // comparison, logic, conditional, bitwise
    'x > 0 ? x : -x', 'x >= 1 && x <= 2', 'x < 0 || x > 1', 'x == 1', 'x != 1', 'x === 1', 'x !== 1',
    'x xor 1', 'x | 1', 'x & 1', 'x ^| 1', '~x', 'x << 1', 'x >> 1', 'x >>> 1',
    // statements and assignment
    'a = 2; a*x', 'y = x^2; y + 1', 'b = c = 3; b + c', 'x = 4',
    // number literals as the lexer reads them
    '1e3*x', '.5*x', '1.5e-3 / x', '1. + x', '1.e2', '010 + x', '08 + x', '00 + x', '078',
    // arrays: their elements are plain JavaScript in math-codegen
    '[1, 2]', '[x, 2*x]', '[1 + 2, 5 ^ 1]', '[x > 0 ? 1 : 2]', '[1 ** 2]', '[x = 3]', '[[1, 2], [3]]',
    '[1 || 0, 0 && 1]', '[-1, +2, ~3]', '[sin(1), x]',
    // failures, each of which must fail the same way
    '', ';', '1 +', 'foo(x)', 'x(1)', 'sin', 'unknownVar', '"text"', 'sin(x', 'x ** 2', ')',
    '010.5 + x', '[a xor b]', '[- -1]', '[(-1) ** 2]', '[1 ^| 2]', '[3!]',
];
// Formulas whose generated source does not parse: `new Function` throws a
// SyntaxError whose wording is V8's, so only the kind of error is compared.
const SOURCE_SYNTAX = new Set(['010.5 + x', '[a xor b]', '[- -1]', '[(-1) ** 2]', '[1 ^| 2]']);
const BUILTIN_SCOPES = [-3, -1, -0.5, 0, 0.5, 1, 2, 10, 1e-9].map((x) => ({ x }));
const INTERVAL_SCOPES = [-2, 0.5, { lo: -1, hi: 1 }, { lo: 0.5, hi: 2 }, { lo: -3, hi: -2 }].map((x) => ({ x }));

function show(v) {
    if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (typeof v === 'boolean' || v === null || v === undefined) return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'function') return `fn:${v.name || '?'}`;
    if (Array.isArray(v)) return `[${v.map(show).join(',')}]`;
    if (typeof v === 'object' && 'lo' in v && 'hi' in v) return `I(${show(v.lo)},${show(v.hi)})`;
    return `obj:${Object.keys(v).join(',')}`;
}
const scopeCopy = (s) => ({ x: typeof s.x === 'object' ? { ...s.x } : s.x });

/** Every formula through both samplers, as plain strings. */
function runCorpus(builtin, interval) {
    const out = {};
    // interval-arithmetic warns on every fractional power; the value says it.
    const warn = console.warn;
    console.warn = () => { };
    try {
        for (const [name, sampler, scopes] of [['builtIn', builtin, BUILTIN_SCOPES], ['interval', interval, INTERVAL_SCOPES]]) {
            for (const f of FORMULAS) {
                let compiled;
                try { compiled = sampler(f); } catch (e) { out[`${name} ${f}`] = { compile: `${e.name}: ${e.message}` }; continue; }
                out[`${name} ${f}`] = {
                    code: compiled.code,
                    values: scopes.map((s) => { try { return show(compiled.eval(scopeCopy(s))); } catch (e) { return `throws ${e.name}: ${e.message}`; } }),
                };
            }
        }
    } finally { console.warn = warn; }
    return out;
}

// --- chart data -------------------------------------------------------------

const DSV_CASES = [
    ['csv', 'a,b\n1,2\n3,4'], ['csv', 'a,b\n1\n,'], ['csv', '"x, y",z\n"a ""quoted"" word",2'], ['csv', 'a,a\n1,2'],
    ['csv', ''], ['csv', 'a,b'], ['csv', 'a,b\r\n1,2\r\n'], ['csv', 'a,b\n1,2\n'], ['csv', '__proto__,b\n1,2'],
    ['csv', 'constructor,toString\n1,2'], ['csv', 'n\n1\n\n2'], ['tsv', 'a\tb\n1\t2'], ['tsv', 'a b\tc\n"q\tq"\t3'],
    ['dsv', 'a|b\n1|2', { delimiter: '|' }], ['csv', '1,2\n3,4', { header: ['x', 'y'] }], ['tsv', '5\t6', { header: ['p q', 'r"s'] }],
    // No usable delimiter: vega's reader throws, so the chart fails and says so.
    ['dsv', 'a,b\n1,2', {}], ['dsv', 'a1b\n213', { delimiter: 1 }],
];
const showRows = (rows) => JSON.stringify({ rows: Array.from(rows, (r) => Object.entries(r)), columns: rows.columns, proto: Array.from(rows, (r) => Object.getPrototypeOf(r) === Object.prototype) });

// --- bundling the client's TypeScript ---------------------------------------

const cache = join(root, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });

async function bundle(entry, { stubs = {}, external = true } = {}) {
    const esbuild = require('esbuild');
    const dir = mkdtempSync(join(cache, 'script-src-gates-'));
    const outfile = join(dir, 'bundle.cjs');
    await esbuild.build({
        entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile, logLevel: 'silent',
        packages: external ? 'external' : undefined,
        plugins: [{
            name: 'stubs',
            setup(b) {
                const names = Object.keys(stubs);
                if (!names.length) return;
                const filter = new RegExp(`(^|/)(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
                b.onResolve({ filter }, (a) => ({ path: names.find((n) => a.path === n || a.path.endsWith(`/${n}`)), namespace: 'stub' }));
                b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
            },
        }],
    });
    try { return require(outfile); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ============================================================================
// The child: code generation from strings is OFF in this process.
// ============================================================================
if (process.argv.includes('--child')) {
    const Module = require('node:module');
    const resolveFilename = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        return request === 'math-codegen' ? OURS : resolveFilename.call(this, request, ...rest);
    };
    const result = {};
    try {
        result.formulas = runCorpus(...samplers());
    } catch (e) { result.formulasError = String(e && e.stack || e); }
    // The switch bites: the real compiler cannot run here.
    try {
        const Real = require(REAL);
        new Real().parse('x').compile({ factory: (v) => v });
        result.realRan = true;
    } catch (e) { result.realRan = false; result.realError = `${e.name}: ${e.message}`; }
    try {
        const { evalFreeDsv } = await bundle(join(root, 'src/components/visuals/vegaDsv.ts'), { external: false });
        result.dsv = DSV_CASES.map(([type, text, extra]) => {
            try { return showRows(evalFreeDsv[type](text, { ...(extra || {}) })); } catch (e) { return `throws ${e.name}: ${e.message}`; }
        });
    } catch (e) { result.dsvError = String(e && e.message || e); }
    try {
        const d3 = await import(pathToFileURL(join(root, 'node_modules/d3-dsv/src/index.js')).href);
        d3.csvParse('a,b\n1,2');
        result.d3Ran = true;
    } catch (e) { result.d3Ran = false; result.d3Error = `${e.name}: ${e.message}`; }
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
}

// ============================================================================
// The gates.
// ============================================================================
let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) pass++; else fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra ? `  — ${extra}` : ''}`);
};
const read = (rel) => { try { return readFileSync(join(root, rel), 'utf8'); } catch { return ''; } };

/** A policy string → { directive: [sources] }. */
function policy(text) {
    const out = {};
    for (const part of String(text || '').split(';')) {
        const [name, ...sources] = part.trim().split(/\s+/);
        if (name) out[name.toLowerCase()] = sources;
    }
    return out;
}

// --- 1 + 3a. what the app serves ---------------------------------------------
let frameModule = null;
try { frameModule = await import(pathToFileURL(join(root, 'server/sandboxFrame.js')).href); } catch { /* checked below */ }
check('server/sandboxFrame.js names the shell, its policy and its document',
    !!frameModule && frameModule.SANDBOX_FRAME_PATH === '/sandbox.html'
    && typeof frameModule.SANDBOX_FRAME_CSP === 'string' && typeof frameModule.SANDBOX_FRAME_HTML === 'string');
{
    const scratch = mkdtempSync(join(cache, 'script-src-app-'));
    process.env.DB_PATH = join(scratch, 'gate.db');
    process.env.VAULT_ROOT = join(scratch, 'vault');
    const { createApp } = await import(pathToFileURL(join(root, 'server/app.js')).href);
    const srv = createApp().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const fetchIt = (path) => new Promise((ok, no) => get({ host: '127.0.0.1', port: srv.address().port, path, agent: false }, (r) => {
        let body = ''; r.setEncoding('utf8'); r.on('data', (c) => { body += c; }); r.on('end', () => ok({ status: r.statusCode, headers: r.headers, body }));
    }).on('error', no));
    const page = await fetchIt('/api/build');
    const shell = await fetchIt('/sandbox.html');
    await new Promise((r) => srv.close(r));
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the library is still open; node_modules/.cache is scratch */ }

    const enforced = policy(page.headers['content-security-policy']);
    check("the page's ENFORCED policy is script-src 'self' and nothing else",
        JSON.stringify(enforced['script-src']) === JSON.stringify(["'self'"]),
        `enforced script-src: ${enforced['script-src'] ? enforced['script-src'].join(' ') : '(none)'}`);
    check('…and keeps the directives already enforced',
        ['object-src', 'base-uri', 'form-action', 'frame-ancestors', 'frame-src', 'connect-src', 'worker-src'].every((d) => enforced[d]));

    const framePolicy = policy(shell.headers['content-security-policy']);
    const expected = frameModule ? policy(frameModule.SANDBOX_FRAME_CSP) : {};
    check('/sandbox.html is served, as HTML', shell.status === 200 && /^text\/html/.test(String(shell.headers['content-type'])),
        `${shell.status} ${shell.headers['content-type']}`);
    check("…under the frame's own policy, not the page's", JSON.stringify(framePolicy) === JSON.stringify(expected) && !!expected['default-src'],
        String(shell.headers['content-security-policy']));
    check('…with no report-only policy beside it', !shell.headers['content-security-policy-report-only']);
    check('…and it is the shell document', !!frameModule && shell.body === frameModule.SANDBOX_FRAME_HTML);
    check('…revalidated, never pinned by a cache', /no-cache|no-store/.test(String(shell.headers['cache-control'])), String(shell.headers['cache-control']));
    check('…and not sniffed as anything else', shell.headers['x-content-type-options'] === 'nosniff');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check("the frame policy: nothing loads by default", same(expected['default-src'], ["'none'"]));
    check("…scripts only inline (no 'self', no host, no blob:, no eval)", same(expected['script-src'], ["'unsafe-inline'"]),
        String(expected['script-src']));
    check('…a sandbox that grants scripts and nothing else', same(expected.sandbox, ['allow-scripts']));
    check('…framed by this app only', same(expected['frame-ancestors'], ["'self'"]));
    check('…no <base>, no form', same(expected['base-uri'], ["'none'"]) && same(expected['form-action'], ["'none'"]));
    check('…and no directive reaches a host',
        Object.entries(expected).every(([d, s]) => d === 'frame-ancestors' || s.every((x) => ["'none'", "'unsafe-inline'", 'data:', 'blob:', 'allow-scripts'].includes(x))),
        JSON.stringify(expected));
}

// --- 3b. the shell's message protocol ---------------------------------------
{
    const html = frameModule ? frameModule.SANDBOX_FRAME_HTML : '';
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    check('the shell has exactly one script, inline', scripts.length === 1 && !/\bsrc\s*=/.test(scripts[0][1]));
    const js = scripts.length ? scripts[0][2] : '';
    const run = (framed) => {
        const calls = [];
        const listeners = new Set();
        const onLoad = new Set();
        const parent = { postMessage: (data, target) => calls.push(['post', data, target]) };
        const window = {
            addEventListener: (t, fn) => { if (t === 'message') listeners.add(fn); if (t === 'load') onLoad.add(fn); calls.push(['add', t]); },
            removeEventListener: (t, fn) => { if (t === 'message') listeners.delete(fn); if (t === 'load') onLoad.delete(fn); calls.push(['remove', t]); },
        };
        window.window = window;
        window.self = window;
        window.parent = framed ? parent : window;
        window.top = window.parent;
        window.document = { readyState: 'loading', open: () => calls.push(['open']), write: (s) => calls.push(['write', s]), close: () => calls.push(['close']) };
        try { vm.runInNewContext(js, window); } catch (e) { calls.push(['threw', String(e)]); }
        const send = (source, data) => { for (const fn of [...listeners]) fn({ source, data }); };
        const load = () => { window.document.readyState = 'complete'; for (const fn of [...onLoad]) fn({ type: 'load' }); };
        return { calls, send, load, parent, other: {}, listeners };
    };
    const top = run(false);
    check('opened on its own (not in a frame), the shell does nothing', top.calls.length === 0, JSON.stringify(top.calls));
    const f = run(true);
    const said = () => f.calls.some((c) => c[0] === 'post' && c[1] && c[1].__sandboxReady === 1 && c[2] === '*');
    // A document written while the shell is still being parsed aborts the
    // shell's own load, and the written one then never gets a load event: p5,
    // which starts on load, never starts (seen in Edge on a busy machine).
    check('in a frame, it says nothing while it is still loading', !said(), JSON.stringify(f.calls));
    f.send(f.parent, { __sandboxDoc: '<p>early</p>' });
    check('…and writes nothing sent to it then', !f.calls.some((c) => c[0] === 'write'));
    f.load();
    check('…then tells its parent it is ready, once loaded', said(), JSON.stringify(f.calls));
    f.send(f.other, { __sandboxDoc: '<p>from elsewhere</p>' });
    f.send(f.parent, { __sandboxDoc: 5 });
    f.send(f.parent, { somethingElse: '<p>x</p>' });
    check('…ignores a document from anyone but its parent, and anything not a document', !f.calls.some((c) => c[0] === 'write'));
    f.send(f.parent, { __sandboxDoc: '<p>one</p>' });
    const writes = () => f.calls.filter((c) => c[0] === 'write');
    const order = f.calls.filter((c) => ['open', 'write', 'close'].includes(c[0])).map((c) => c[0]).join(',');
    check("…writes its parent's document over itself: open, write, close", order === 'open,write,close' && writes()[0][1] === '<p>one</p>', order);
    check('…having stopped listening first', f.listeners.size === 0);
    f.send(f.parent, { __sandboxDoc: '<p>two</p>' });
    check('…so a second document is never written into the first', writes().length === 1);
}

// --- 3c. the client half: src/components/visuals/sandboxFrame.ts -----------
{
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:3001/project/1' });
    const saved = { window: globalThis.window, document: globalThis.document };
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    let showInSandbox = null;
    try { ({ showInSandbox } = await bundle(join(root, 'src/components/visuals/sandboxFrame.ts'))); } catch { /* checked below */ }
    check('src/components/visuals/sandboxFrame.ts exports showInSandbox', typeof showInSandbox === 'function');
    if (typeof showInSandbox === 'function') {
        const frame = dom.window.document.createElement('iframe');
        dom.window.document.body.appendChild(frame);
        const posted = [];
        const dispose = showInSandbox(frame, '<p>doc</p>');
        // jsdom gives the frame a new window once its src is set (a browser
        // keeps one WindowProxy); the helper reads contentWindow when a message
        // arrives, so the one to listen on is the one there now.
        frame.contentWindow.postMessage = (data, target) => posted.push([data, target]);
        check('…loads the shell into the frame, sandboxed to scripts only',
            new URL(frame.src).pathname === '/sandbox.html' && frame.getAttribute('sandbox') === 'allow-scripts', `${frame.src} ${frame.getAttribute('sandbox')}`);
        // A clock and timers the gate moves by hand: no assertion here waits
        // on, or reads, the real time.
        const real = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
        let now = 0;
        const timers = new Map();
        let nextTimer = 1;
        Date.now = () => now;
        globalThis.setTimeout = (fn, ms) => { timers.set(nextTimer, { fn, at: now + ms }); return nextTimer++; };
        globalThis.clearTimeout = (id) => timers.delete(id);
        const advance = (ms) => {
            now += ms;
            for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
        };
        try {
            const ready = (source) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { __sandboxReady: 1 }, source }));
            ready(dom.window);
            check('…answers no one but its own frame', posted.length === 0);
            ready(frame.contentWindow);
            check('…hands the shell its document, at once', posted.length === 1 && posted[0][0].__sandboxDoc === '<p>doc</p>' && posted[0][1] === '*', JSON.stringify(posted));
            for (let i = 0; i < 50; i++) ready(frame.contentWindow);
            check('…a frame asking again straight away waits for the gap, however often it asks', posted.length === 1 && timers.size === 1, `${posted.length} answers, ${timers.size} timers`);
            advance(999);
            check('…nothing before the gap ends', posted.length === 1);
            advance(1);
            check('…and the last request of the burst is answered when it does, never dropped', posted.length === 2 && posted[1][0].__sandboxDoc === '<p>doc</p>');
            advance(5000);
            check('…then nothing more until the frame asks again', posted.length === 2);
            ready(frame.contentWindow);
            check('…and a frame asking after a quiet gap is answered at once (a frame moved in the page reloads)', posted.length === 3);
            ready(frame.contentWindow);
            dispose();
            advance(5000);
            ready(frame.contentWindow);
            check('…and nothing is sent once disposed, a pending answer included', posted.length === 3 && timers.size === 0, `${posted.length} answers, ${timers.size} timers`);
        } finally {
            Date.now = real.now;
            globalThis.setTimeout = real.setTimeout;
            globalThis.clearTimeout = real.clearTimeout;
        }
    }
    globalThis.window = saved.window;
    globalThis.document = saved.document;
}

// --- 3d. the renderers, and nothing else, frame through it ------------------
const p5Src = read('src/components/visuals/renderP5.ts');
const widgetSrc = read('src/components/visuals/renderWidget.ts');
for (const [name, src] of [['renderP5.ts', p5Src], ['renderWidget.ts', widgetSrc]]) {
    check(`${name}: the probe frame and the visible frame both go through showInSandbox`,
        (src.match(/\bshowInSandbox\(/g) || []).length >= 2 && /import \{ showInSandbox \} from '\.\/sandboxFrame';/.test(src));
}
// A theme posted before the widget runs reaches the empty shell and is lost, and
// `ctx.palette` is the theme of the moment the render began, a whole build ago.
// Measured in dev Edge: switching to dark while the widget was being verified
// left 12 of 12 widgets white; switching only the tint left them untouched.
check('renderWidget.ts: the visible widget is built in the theme read when it mounts, not ctx.palette',
    /buildWidgetDoc\(html, token, \{ probe: false, palette: currentPalette\(\) \}\)/.test(widgetSrc)
    && !/probe:\s*false,\s*palette:\s*ctx\.palette/.test(widgetSrc));
check('…with the key the store subscription compares, tint included',
    /const widgetThemeKey = [^\n]*themeKeyOf\(s\.theme, s\.themeTint\)[^\n]*s\.accentColor/.test(widgetSrc)
    && /const builtKey = widgetThemeKey\(useStore\.getState\(\)\);/.test(widgetSrc)
    && /const key = widgetThemeKey\(state\);/.test(widgetSrc));
check('…and its first size report re-themes it if the theme changed while it was handed over',
    /type === 'size' && !running\) \{\s*running = true;\s*if \(lastKey !== builtKey\) sendTheme\(\);/.test(widgetSrc));
check("renderP5.ts carries p5 inline, as text (`?raw`), not as an address", /import p5Source from 'p5\/lib\/p5\.min\.js\?raw';/.test(p5Src) && !/\?url'/.test(p5Src));
{
    const p5 = read('node_modules/p5/lib/p5.min.js');
    check('p5.min.js can sit inside a <script> element unchanged (no </script, <!--, <script)',
        p5.length > 100000 && !/<\/script|<!--|<script/i.test(p5));
}

// --- 3e. the sketch document -------------------------------------------------
{
    const { JSDOM } = require('jsdom');
    const host = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:3001/' });
    const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
    globalThis.window = host.window;
    globalThis.document = host.window.document;
    globalThis.location = host.window.location;
    const P5_STUB = 'window.__p5stub = 1;';
    let buildSketchDoc = null;
    try {
        ({ buildSketchDoc } = await bundle(join(root, 'src/components/visuals/renderP5.ts'), {
            stubs: {
                'p5/lib/p5.min.js?raw': `export default ${JSON.stringify(P5_STUB)};`,
                'p5/lib/p5.min.js?url': 'export default "/assets/p5.min.js";',
                api: 'export const api = {};',
                store: 'export const useStore = () => undefined;',
                i18n: 'export default { t: (k) => k, language: "en" }; export const currentLocale = () => "en-GB";',
            },
        }));
    } catch (e) { console.log(`      (renderP5.ts did not bundle: ${String(e && e.message || e).split('\n')[0]})`); }
    check('renderP5.ts exports buildSketchDoc', typeof buildSketchDoc === 'function');
    if (typeof buildSketchDoc === 'function') {
        const doc = buildSketchDoc('function setup(){createCanvas(10,10)} function draw(){background(0)}', 'tok', true, '');
        const d = new JSDOM(doc).window.document;
        const meta = d.head && d.head.querySelector('meta[http-equiv="Content-Security-Policy"]');
        const metaPolicy = policy(meta && meta.getAttribute('content'));
        check("the sketch's own policy allows inline script only", JSON.stringify(metaPolicy['script-src']) === JSON.stringify(["'unsafe-inline'"]),
            String(meta && meta.getAttribute('content')));
        check('…and the sketch document loads no script from an address', !/<script[^>]*\bsrc\s*=/i.test(doc));
        check('…because p5 is in it', doc.includes(P5_STUB));

        // A sketch that does not parse is reported FROM the frame, worded as the
        // page-side check worded it ("JavaScript <message>"), for the repair loop.
        const reported = async (sketch) => {
            const seen = [];
            const frameDom = new JSDOM(buildSketchDoc(sketch, 'tok', true, ''), {
                runScripts: 'dangerously', url: 'http://127.0.0.1:3001/sandbox.html',
                virtualConsole: new (require('jsdom').VirtualConsole)(),
                beforeParse(w) { w.addEventListener('message', (e) => { if (e.data && e.data.__p5 === 'tok') seen.push(e.data); }); },
            });
            await new Promise((r) => setTimeout(r, 200));
            frameDom.window.close();
            const first = seen.find((m) => m.type === 'error');
            return first ? first.message : `(no error reported: ${JSON.stringify(seen)})`;
        };
        const parseError = (code) => { try { new vm.Script(code); return null; } catch (e) { return e.message; } };
        const first = await reported('function setup() { createCanvas(10, 10)\nfunction draw() { background(0) }');
        check('a sketch with a syntax error is reported from its frame as "JavaScript …"', /^JavaScript \S/.test(first), first);
        // The error is the sketch's alone: it is parsed as its own script, so
        // nothing written after it in the document changes what the parser says.
        // (Ending inside a call, it reads as "end of input"; run on into more
        // code, it would be an unexpected token there.)
        const open = 'function setup() { createCanvas(10, 10); }\nfunction draw() { background(';
        const alone = await reported(open);
        check('…and the message is the parse error of the sketch alone', alone === `JavaScript ${parseError(open)}`, `${alone} vs JavaScript ${parseError(open)}`);
        // Chrome reports a parse error met during document.write as "Failed to
        // execute 'write' on 'Document': <message>"; the frame says only the message.
        const viaWrite = await reported(`window.onerror('x', '', 1, 1, { name: 'SyntaxError', message: "Failed to execute 'write' on 'Document': Unexpected end of input" });`);
        check("…without Chrome's note that it was met while the document was written", viaWrite === 'JavaScript Unexpected end of input', viaWrite);
    }
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.location = saved.location;
}

// --- 2 + 4. no code generation in the client ---------------------------------
{
    const esbuild = require('esbuild');
    const files = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(extname(e.name)) && !e.name.endsWith('.d.ts')) files.push(p);
        }
    };
    walk(join(root, 'src'));
    // The code runner's worker runs inside its own frame under its own policy
    // (server/runnerFrame.js, held by tools/code-runner-gates.mjs), never in the
    // page: it reaches the page only as text, bundled into `virtual:runner-worker`.
    // These two files are that worker alone (the Python harness is Python source
    // that `eval`s a test's call), so they are left out here, PROVIDED nothing in
    // the page imports them as code.
    const WORKER_ONLY = ['src/runner/worker.ts', 'src/runner/pythonHarness.ts'].map((p) => join(root, p));
    // Every way one module pulls another in as code: `import x from`, a bare
    // `import '…'` run for its side effects, `import('…')`, and a re-export.
    // A type-only import or export carries no code and is allowed.
    const WORKER_SPEC = String.raw`['"][./]*(?:runner\/)?(?:worker|pythonHarness)(?:\.[cm]?[jt]s)?['"]`;
    const PULLS_WORKER = [
        new RegExp(String.raw`\bimport\s+(?!type\b)[^;'"]*?\bfrom\s+${WORKER_SPEC}`),
        new RegExp(String.raw`\bimport\s+${WORKER_SPEC}`),
        new RegExp(String.raw`\bimport\(\s*${WORKER_SPEC}\s*\)`),
        new RegExp(String.raw`\bexport\s+(?!type\b)[^;'"]*?\bfrom\s+${WORKER_SPEC}`),
    ];
    const pullsWorker = (text) => PULLS_WORKER.some((re) => re.test(text));
    const shapes = ["import { x } from './runner/worker';", "import './runner/worker';", "import('../runner/worker')", "export * from './worker';", "export { y } from './pythonHarness';", "import { x } from './runner/worker.js';", "import './pythonHarness.mjs';"];
    const typeOnly = ["import type { X } from './runner/worker';", "export type { X } from './worker';"];
    check('the worker import check sees every way of pulling the worker in as code, and lets types through',
        shapes.every(pullsWorker) && !typeOnly.some(pullsWorker), shapes.filter((s) => !pullsWorker(s)).concat(typeOnly.filter(pullsWorker)).join(' | '));
    const importsWorker = files.filter((f) => !WORKER_ONLY.includes(f)).filter((f) => pullsWorker(readFileSync(f, 'utf8')))
        .map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));
    check('the code runner\'s worker reaches the page only as text, never imported as code', importsWorker.length === 0, importsWorker.join(', '));
    files.splice(0, files.length, ...files.filter((f) => !WORKER_ONLY.includes(f)));
    // The server modules the client imports run in the page too.
    for (const f of files.slice()) {
        for (const m of readFileSync(f, 'utf8').matchAll(/from '((?:\.\.\/)+server\/[\w./-]+\.js)'/g)) {
            const p = resolve(dirname(f), m[1]);
            if (!files.includes(p) && existsSync(p)) files.push(p);
        }
    }
    const SINKS = [
        [/\bnew\s+Function\s*\(/, 'new Function('],
        [/(?<![\w$.])Function\s*\(/, 'Function('],
        [/(?<![\w$.])eval\s*\(/, 'eval('],
        [/\b(?:globalThis|window|self|global)\s*(?:\.\s*(?:eval|Function)|\[\s*['"`](?:eval|Function)['"`]\s*\])\s*\(/, 'eval or Function called on the global object'],
        [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'a string timer'],
        [/\.srcdoc\s*=|\bsrcdoc\s*:|\bsrcDoc\s*=|setAttribute\(\s*['"]srcdoc['"]/, 'a srcdoc frame'],
    ];
    const found = [];
    for (const f of files) {
        const ext = extname(f);
        let code;
        try {
            code = esbuild.transformSync(readFileSync(f, 'utf8'), { loader: ext === '.tsx' ? 'tsx' : ext === '.ts' ? 'ts' : 'js', legalComments: 'none' }).code;
        } catch { continue; }
        for (const [re, what] of SINKS) {
            const m = code.match(re);
            if (m) found.push(`${f.slice(root.length + 1).replace(/\\/g, '/')}: ${what}`);
        }
    }
    check('nothing in the client compiles a string into code, or frames a srcdoc', found.length === 0, found.join('; '));
}

// --- 2. graph formulas -------------------------------------------------------
{
    const vite = read('vite.config.ts');
    check('the build resolves math-codegen to the evaluator', /find:\s*\/\^math-codegen\$\/,\s*replacement:[^\n]*mathCodegen\.cjs/.test(vite));
    // The alias catches only the bare name, so every package that pulls the
    // compiler in must ask for it by that name: today the two samplers.
    const lock = JSON.parse(read('package-lock.json') || '{}');
    const users = Object.entries(lock.packages || {})
        .filter(([, p]) => p && ((p.dependencies && p.dependencies['math-codegen']) || (p.optionalDependencies && p.optionalDependencies['math-codegen'])))
        .map(([k]) => k.replace(/^.*node_modules\//, '')).sort();
    check('…and the only packages that use math-codegen are the two samplers', JSON.stringify(users) === JSON.stringify(['built-in-math-eval', 'interval-arithmetic-eval']), users.join(', '));
    check('…both asking for it by its bare name',
        ['built-in-math-eval', 'interval-arithmetic-eval'].every((p) => /require\('math-codegen'\)/.test(read(`node_modules/${p}/lib/eval.js`))));
    const pkg = JSON.parse(read('package.json') || '{}');
    check('the evaluator\'s parser is a declared dependency', !!(pkg.dependencies && pkg.dependencies['mr-parser']));

    const child = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', fileURLToPath(import.meta.url), '--child'],
        { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let ours = null;
    try { ours = JSON.parse(child.stdout); } catch { /* reported below */ }
    check('the child ran', !!ours, (child.stderr || child.stdout || '').slice(0, 300));
    if (ours) {
        check('…with code generation switched off (the real compiler fails there)', ours.realRan === false && /^EvalError/.test(ours.realError || ''), ours.realError);
        check('every formula evaluates there, without code generation', !!ours.formulas, ours.formulasError && ours.formulasError.split('\n')[0]);
    }
    if (ours && ours.formulas) {
        const theirs = runCorpus(...samplers());
        const differ = [];
        let compared = 0;
        for (const key of Object.keys(theirs)) {
            const a = theirs[key], b = ours.formulas[key];
            const formula = key.slice(key.indexOf(' ') + 1);
            compared += 1;
            if (!b) { differ.push(`${key}: missing`); continue; }
            if (a.compile || b.compile) {
                const kind = (s) => String(s || '').split(':')[0];
                const same = SOURCE_SYNTAX.has(formula) ? kind(a.compile) === 'SyntaxError' && kind(b.compile) === 'SyntaxError' : a.compile === b.compile;
                if (!same) differ.push(`${key}: compile ${a.compile || 'ok'} vs ${b.compile || 'ok'}`);
                continue;
            }
            if (a.code !== b.code) differ.push(`${key}: code ${a.code} vs ${b.code}`);
            a.values.forEach((v, i) => { if (v !== b.values[i]) differ.push(`${key} @${i}: ${v} vs ${b.values[i]}`); });
        }
        check(`the evaluator agrees with math-codegen on ${compared} formula × namespace pairs (value, error and source)`,
            differ.length === 0 && compared === FORMULAS.length * 2, differ.slice(0, 6).join(' | '));
        const real = theirs['builtIn sin(x)'];
        check('…which is not vacuous: a curve has values, a bad formula an error',
            real && real.values && real.values[4] === show(Math.sin(0.5)) && !!theirs['builtIn foo(x)'].values[0].startsWith('throws SyntaxError'));
    }
    // The one place it differs on purpose: a quoted string inside an array.
    let Ours = null;
    try { Ours = require(OURS); } catch { /* checked above */ }
    if (Ours) {
        const v = new Ours().parse('["ab", 1]').compile({ factory: (x) => x }).eval({});
        check('a quoted string inside an array is that string', JSON.stringify(v) === '["ab",1]', JSON.stringify(v));
    }

    // --- 4. chart data ---------------------------------------------------------
    const vegaSrc = read('src/components/visuals/renderVega.ts');
    check('renderVega registers the eval-free CSV/TSV readers on the vega it embeds with',
        /registerEvalFreeDsv\(embedModule\.vega\)/.test(vegaSrc) && /import \{ registerEvalFreeDsv \} from '\.\/vegaDsv';/.test(vegaSrc));
    check('d3-dsv, which they read rows with, is a declared dependency', !!(pkg.dependencies && pkg.dependencies['d3-dsv']));
    if (ours) {
        check('…and d3\'s own parser cannot run without code generation (why they exist)', ours.d3Ran === false, ours.d3Error);
        check('the readers run without it', Array.isArray(ours.dsv), ours.dsvError);
    }
    if (ours && Array.isArray(ours.dsv)) {
        const { formats } = fromVega('vega-loader');
        const differ = [];
        DSV_CASES.forEach(([type, text, extra], i) => {
            let want;
            try { want = showRows(formats(type)(text, { ...(extra || {}) })); } catch (e) { want = `throws ${e.name}: ${e.message}`; }
            // A throw matches a throw: the wording is d3's internals vs ours.
            const bothThrow = want.startsWith('throws ') && ours.dsv[i].startsWith('throws ');
            if (want !== ours.dsv[i] && !bothThrow) differ.push(`${type} ${JSON.stringify(text)}: ${want} vs ${ours.dsv[i]}`);
        });
        check(`the readers give vega exactly what its own readers give, on ${DSV_CASES.length} inputs`, differ.length === 0, differ.slice(0, 3).join(' | '));
    }
}

// --- the path, where it is spelt twice -----------------------------------------
{
    const sw = read('src/sw-template.js');
    const m = sw.match(/function isBypassed\(url\) \{[\s\S]*?\r?\n\}\r?\n/);
    let bypassed = null;
    if (m) {
        try { bypassed = vm.runInNewContext(`${m[0]}; isBypassed`, { URL }); } catch { /* checked below */ }
    }
    const at = (p) => (bypassed ? bypassed(new URL(`http://127.0.0.1:3001${p}`)) : null);
    // Otherwise the worker would answer the frame's navigation from its cache,
    // and store the shell as the app's own start page.
    check('the service worker leaves /sandbox.html to the network', at('/sandbox.html') === true, String(at('/sandbox.html')));
    check('…and still caches the app itself', at('/') === false && at('/assets/index-abc.js') === false);
    const vite = read('vite.config.ts');
    check('the dev server forwards /sandbox.html to the API', /['"]\/sandbox\.html['"]\s*:\s*\{\s*target:\s*apiTarget/.test(vite)
        || /\[SANDBOX_FRAME_PATH\]\s*:\s*\{\s*target:\s*apiTarget/.test(vite));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
