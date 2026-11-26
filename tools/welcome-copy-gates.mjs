// tools/welcome-copy-gates.mjs — the first screen a learner reads says what is true, and says it kindly.
//
// Run:  node tools/welcome-copy-gates.mjs                    (the working tree)
//       node tools/welcome-copy-gates.mjs --ref=origin/main  (that commit's components and store,
//                                                            to watch the cases fail on the
//                                                            pre-fix code; --head is --ref=HEAD)
//
// WHY. The first welcome step promised the app "brings back what you are starting to
// forget". The promise is that a learner keeps what they learn; words to a learner
// never say they will forget. And the store loaded the version and the update verdict
// together, so a failed update check dropped the version answer too.
//
// Held here:
//   1. The REAL WelcomeFlow, every step: no sentence frames memory as loss, and the
//      first step still says the app checks what you have really learned.
//   2. A failed update check beside a good version answer keeps the version.
// Red on the pre-fix code: 1 (step 1) and 2.
// No model, no network.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const REF = process.argv.includes('--head') ? 'HEAD'
    : (process.argv.find(a => a.startsWith('--ref=')) ?? '').slice('--ref='.length) || null;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 300)}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// What counts as framing memory as loss.
const LOSS = /\b(forget\w*|forgot\w*|forgotten|fad(?:e|es|ing)|slipping|decay\w*|los(?:e|es|ing) what)\b/i;

const COMPONENTS = /[\\/]src[\\/](components[\\/]welcome[\\/](WelcomeFlow|PrivacyNote)\.tsx|store\.ts)$/;
const refFiles = {
    name: 'ref-files',
    setup(build) {
        if (!REF) return;
        build.onLoad({ filter: COMPONENTS }, (args) => {
            const rel = args.path.slice(root.length + 1).replace(/\\/g, '/');
            return { contents: execFileSync('git', ['show', `${REF}:${rel}`], { cwd: root, encoding: 'utf8' }), loader: rel.endsWith('.tsx') ? 'tsx' : 'ts' };
        });
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import WelcomeFlow from './src/components/welcome/WelcomeFlow';
            import { MemoryRouter } from 'react-router-dom';
            import { createElement as h, act } from 'react'; import { createRoot } from 'react-dom/client';
            const mount = (el) => {
                const root = createRoot(el);
                act(() => root.render(h(MemoryRouter, null, h(WelcomeFlow))));
                return root;
            };
            window.__gate = { useStore, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [refFiles],
})).outputFiles[0].text;

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
const VERSION = { version: '0.0.0', commit: null, commitShort: null, builtAt: null, node: '24', platform: 'test', deployment: 'source', updateCommand: null, repoUrl: '' };
// What the page's requests get: an empty library with no model connected.
const reply = (url) => {
    const u = String(url);
    if (u.includes('/api/settings')) return {};
    if (u.includes('/api/ai/status')) return { provider: 'ollama', model: '', enabled: true, available: false, hasApiKey: false, baseUrl: '' };
    if (u.includes('/api/version')) return VERSION;
    return null;   // anything else stays pending, as a slow server would leave it
};

/** A fresh page with the bundle loaded; `answer(url, init)` gives each request's
 *  `{ status, body }`, or null to leave it pending. */
function page(answer = (url) => { const b = reply(url); return b === null ? null : { status: 200, body: b }; }) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    w.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
    w.scrollTo = () => { };
    w.fetch = (url, init) => {
        const a = answer(String(url), init);
        return a === null ? new Promise(() => { })
            : Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } }));
    };
    w.eval(bundle);
    return w;
}

/** The welcome step `step` (0-based) as text. */
async function render(step) {
    const w = page();
    w.sessionStorage.setItem('terramentor-welcome-step', String(step));
    const { useStore, mount, act } = w.__gate;
    useStore.setState({ appVersion: VERSION });
    const r = mount(w.document.getElementById('root'));
    await act(async () => { await settle(); });
    const text = w.document.body.textContent.replace(/\s+/g, ' ');
    act(() => r.unmount());
    w.close();
    return text;
}

const NAMES = ['Welcome', 'About you', 'Connect an AI model', 'set up'];
section('1. no welcome sentence frames memory as loss (every step)');
const screens = [];
for (const step of [0, 1, 2, 3]) {
    const text = await render(step);
    screens.push(text);
    const m = text.match(LOSS);
    check(`step ${step + 1} (${NAMES[step]}) rendered`, text.length > 200, text.slice(0, 120));
    check(`step ${step + 1} says nothing about forgetting or fading`, !m, m && text.slice(Math.max(0, m.index - 120), m.index + 40));
}
check('the first step still says the app checks what you have really learned', screens[0].includes('checks what you have really learned'));

section('2. a failed update check does not drop the version answer');
{
    const v = page((url) => {
        if (url.includes('/api/version')) return { status: 200, body: VERSION };
        if (url.includes('/api/updates')) return { status: 500, body: { error: 'boom' } };
        return null;
    });
    await v.__gate.act(async () => { await v.__gate.useStore.getState().loadVersion().catch(() => { }); await settle(); });
    check('the version answer is kept', v.__gate.useStore.getState().appVersion?.version === VERSION.version, JSON.stringify(v.__gate.useStore.getState().appVersion));
    v.close();
}

section('3. an update answer older than a toggle does not undo it');
{
    let releaseRead;
    const v = page();
    v.fetch = (url) => {
        const u = String(url);
        const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        if (u.includes('/api/version')) return Promise.resolve(json(VERSION));
        if (u.includes('/api/updates/auto')) return Promise.resolve(json({ enabled: false }));
        if (u.includes('/api/updates')) return new Promise((r) => { releaseRead = () => r(json({ enabled: true })); });
        return new Promise(() => { });
    };
    const { act, useStore } = v.__gate;
    let loading;
    await act(async () => { loading = useStore.getState().loadVersion(); await settle(); });
    await act(async () => { await useStore.getState().setAutoUpdateCheck(false); await settle(); });
    await act(async () => { releaseRead(); await loading; await settle(); });
    check('the switch keeps the value the toggle wrote', useStore.getState().updateStatus?.enabled === false, JSON.stringify(useStore.getState().updateStatus));
    v.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
