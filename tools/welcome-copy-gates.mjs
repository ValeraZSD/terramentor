// tools/welcome-copy-gates.mjs — the first screen a learner reads says what is true, and says it kindly.
//
// Run:  node tools/welcome-copy-gates.mjs          (the working tree)
//       node tools/welcome-copy-gates.mjs --head   (HEAD's components and server, to watch
//                                                    the cases fail on the pre-fix code)
//
// WHY. Two sentences on the welcome steps were wrong for the people the app is now
// shown to:
//   - The first step promised the app "brings back what you are starting to forget".
//     The product's promise is that a learner keeps what they learn; words to a
//     learner never say they will forget.
//   - The About-you step said the profile is "Saved on this computer". On a hosted
//     copy (server/hosted.js, TERRAMENTOR_HOSTED=1) it is saved on a server, so the
//     one privacy sentence a new learner reads was false. Settings → Learning, where
//     that sentence sends them to change the profile, said the same.
// The client learns it is hosted from `hosted` on GET /api/version, the server's own
// isHosted(), read on every call.
//
// Held here:
//   1. /api/version says hosted: true on a hosted copy and false on any other, on a
//      scratch library through the REAL app.
//   2. The REAL WelcomeFlow, every step, desktop and hosted: no sentence frames
//      memory as loss.
//   3. Hosted: steps 1, 2 and 4 never say "this computer" (or machine), and the
//      About-you note says the profile is kept on a server. The model step (3) is
//      left to the hosted model-setup work, which removes it on a hosted copy.
//   4. Desktop (the control, green on the old code too): the About-you note still
//      says the profile is saved on this computer.
//   5. Settings → Learning: hosted says the server, desktop says this computer.
// No model, no network beyond loopback.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const HEAD = process.argv.includes('--head');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 300)}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// What counts as framing memory as loss, and as naming the learner's own machine.
const LOSS = /\b(forget\w*|forgot\w*|forgotten|fad(?:e|es|ing)|slipping|decay\w*|los(?:e|es|ing) what)\b/i;
const THIS_MACHINE = /\b(this|your) (computer|machine|PC|laptop)\b/i;

const scratchDirs = [];
const scratch = (name) => { const d = mkdtempSync(join(tmpdir(), `${name}-`)); scratchDirs.push(d); return d; };

// ---------------------------------------------------------------------------
section('1. /api/version says whether this copy is hosted');
{
    // HEAD's server: a copy of server/ from HEAD in a scratch folder, beside the
    // working tree's node_modules (it resolves packages from the repo root).
    let serverDir = join(root, 'server');
    if (HEAD) {
        const dir = mkdtempSync(join(root, 'temp', 'welcome-copy-head-'));
        scratchDirs.push(dir);
        // server/ imports a few modules from src/ (the scheduler's shared maths).
        const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'server', 'src'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
        for (const f of files) {
            const out = join(dir, f);
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, execFileSync('git', ['show', `HEAD:${f}`], { cwd: root, maxBuffer: 64 << 20 }));
        }
        writeFileSync(join(dir, 'package.json'), execFileSync('git', ['show', 'HEAD:package.json'], { cwd: root }));
        serverDir = join(dir, 'server');
    }
    // Scratch library, set in-process; nothing inherited may point elsewhere.
    const lib = scratch('welcome-copy-gates');
    for (const k of ['DATA_DIR', 'SECRETS_PATH', 'TERRAMENTOR_HOSTED', 'TERRAMENTOR_SITE_LIBRARY', 'HOST']) delete process.env[k];
    process.env.DB_PATH = join(lib, 'test.db');
    process.env.VAULT_ROOT = join(lib, 'vault');
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_BASE_URL = 'http://127.0.0.1:9/v1';
    const B = pathToFileURL(serverDir + '/').href;
    const { default: db } = await import(B + 'database.js');
    const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase();
    if (!norm(db.name).startsWith(norm(lib) + '/')) { console.error(`refusing: ${db.name} is not the scratch library`); process.exit(2); }
    const { createApp } = await import(B + 'app.js');
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const { port } = server.address();
    const version = async () => (await fetch(`http://127.0.0.1:${port}/api/version`)).json();
    try {
        process.env.TERRAMENTOR_HOSTED = '1';
        const on = await version();
        check('a hosted copy answers hosted: true', on.hosted === true, JSON.stringify(on));
        process.env.TERRAMENTOR_HOSTED = '0';
        const off = await version();
        check('any other copy answers hosted: false', off.hosted === false, JSON.stringify(off));
        check('…and the rest of the version answer is unchanged', typeof off.version === 'string' && 'commit' in off && 'deployment' in off);
    } finally {
        delete process.env.TERRAMENTOR_HOSTED;
        await new Promise(r => server.close(r));
        try { db.close(); } catch { /* already closed */ }
    }
}

// ---------------------------------------------------------------------------
const COMPONENTS = /[\\/]src[\\/]components[\\/](welcome[\\/](WelcomeFlow|PrivacyNote)|settings[\\/]LearningSettings)\.tsx$/;
const headFiles = {
    name: 'head-files',
    setup(build) {
        if (!HEAD) return;
        build.onLoad({ filter: COMPONENTS }, (args) => {
            const rel = args.path.slice(root.length + 1).replace(/\\/g, '/');
            return { contents: execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' }), loader: 'tsx' };
        });
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import WelcomeFlow from './src/components/welcome/WelcomeFlow';
            import LearningSettings from './src/components/settings/LearningSettings';
            import { MemoryRouter } from 'react-router-dom';
            import { createElement as h, act } from 'react'; import { createRoot } from 'react-dom/client';
            const mount = (el, which) => {
                const root = createRoot(el);
                const page = which === 'learning'
                    ? h(LearningSettings, { active: true, snapshot: { ok: true, values: {} } })
                    : h(WelcomeFlow);
                act(() => root.render(h(MemoryRouter, null, page)));
                return root;
            };
            window.__gate = { useStore, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [headFiles],
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

/** One screen as text: the welcome step `step` (0-based), or Settings → Learning. */
async function render({ hosted, step = 0, which = 'welcome' }) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    w.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
    w.scrollTo = () => { };
    w.fetch = (url) => {
        const body = reply(url);
        return body === null ? new Promise(() => { })
            : Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    w.sessionStorage.setItem('terramentor-welcome-step', String(step));
    w.eval(bundle);
    const { useStore, mount, act } = w.__gate;
    useStore.setState({ appVersion: { ...VERSION, hosted } });
    const r = mount(w.document.getElementById('root'), which);
    await act(async () => { await settle(); });
    const flat = (el) => el.textContent.replace(/\s+/g, ' ');
    // Settings → Learning holds other panels too; the profile's own paragraph is
    // the smallest element that starts with its first words.
    const text = which === 'learning'
        ? [...w.document.querySelectorAll('p, div, span')].map(flat)
            .filter(s => s.trim().startsWith('Your background and experience')).sort((a, b) => a.length - b.length)[0] ?? ''
        : flat(w.document.body);
    act(() => r.unmount());
    w.close();
    return text;
}

const STEPS = [0, 1, 2, 3];
const NAMES = ['Welcome', 'About you', 'Connect an AI model', 'set up'];
const screens = {};
for (const hosted of [false, true]) {
    for (const step of STEPS) screens[`${hosted ? 'hosted' : 'desktop'}:${step}`] = await render({ hosted, step });
    screens[`${hosted ? 'hosted' : 'desktop'}:learning`] = await render({ hosted, which: 'learning' });
}

section('2. no welcome sentence frames memory as loss (every step, desktop and hosted)');
for (const hosted of [false, true]) {
    for (const step of STEPS) {
        const text = screens[`${hosted ? 'hosted' : 'desktop'}:${step}`];
        const m = text.match(LOSS);
        check(`${hosted ? 'hosted' : 'desktop'} step ${step + 1} (${NAMES[step]}) rendered`, text.length > 200, text.slice(0, 120));
        check(`${hosted ? 'hosted' : 'desktop'} step ${step + 1} says nothing about forgetting or fading`, !m,
            m && text.slice(Math.max(0, m.index - 120), m.index + 40));
    }
}
check('the first step still says the app checks what you have really learned', screens['desktop:0'].includes('checks what you have really learned'));

section('3. hosted: the welcome never says "this computer", and says where the profile is kept');
for (const step of [0, 1, 3]) {
    const text = screens[`hosted:${step}`];
    const m = text.match(THIS_MACHINE);
    check(`hosted step ${step + 1} (${NAMES[step]}) never names the learner's own machine`, !m,
        m && text.slice(Math.max(0, m.index - 80), m.index + 80));
}
check('hosted About-you says the profile is saved on the server that runs the app',
    /Saved online, on the server that runs this app\./.test(screens['hosted:1']), screens['hosted:1'].slice(0, 600));

section('4. desktop (control): the About-you note still says this computer');
check('desktop About-you says "Saved on this computer"', screens['desktop:1'].includes('Saved on this computer'));
check('desktop About-you does not mention a server', !/server that runs this app/.test(screens['desktop:1']));

section('5. Settings → Learning: the profile paragraph says the same as Welcome');
check('the profile paragraph was found', screens['desktop:learning'].length > 40 && screens['hosted:learning'].length > 40);
check('hosted Learning profile never names the learner\'s own machine', !THIS_MACHINE.test(screens['hosted:learning']), screens['hosted:learning']);
check('hosted Learning profile says it is saved on the server that runs the app', /saved online, on the server that runs this app/i.test(screens['hosted:learning']));
check('desktop Learning profile still says "Stored on this computer"', screens['desktop:learning'].includes('Stored on this computer'));

for (const d of scratchDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); }
    catch (e) { console.log(`  (scratch ${d} left behind: ${e.code})`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
