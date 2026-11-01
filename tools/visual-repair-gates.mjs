// tools/visual-repair-gates.mjs — a model repair is spent only on a fault in
// the spec, and counts only when what it returns actually draws.
//
// Run:  node tools/visual-repair-gates.mjs
//
// Why this exists: in every built app since Vite 8 the graph renderer itself
// threw ("Couldn't render this graph: u is not a function"; fixed in #151).
// VisualBlock sent that error to the model as "fix this spec", so one lesson
// graph cost a paid repair on every page load, for every learner. The model
// changed `pow(x,2)` to `(x^2)`, the repair task said "done", the changed spec
// was written back into the lesson, and the graph showed the same error.
//
// This mounts the REAL VisualBlock in jsdom with the api, store and i18n
// stubbed, and the plot and molecule renderers replaced by stubs the test
// drives, and asserts:
//   - a renderer that cannot draw a KNOWN-GOOD spec of its own kind is the
//     app's fault: no repair is started, none is offered, the card says so;
//   - a renderer whose module never loaded is the same;
//   - a fault in the spec itself (the renderer draws the known-good one) is
//     still repaired, once;
//   - a repair whose answer does not draw either is not written back, the
//     original stays, the card says the fix failed, and the server is told so
//     (the task chip then reads failed, not done);
//   - a repair whose answer draws is written back and shown, and the server
//     is told nothing;
// and on the server half, that `tasks.resultUnusable` turns a finished visual
// repair into a failed one and refuses anything else.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const cache = join(root, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'visual-repair-gates-'));
const out = join(scratch, 'bundle.cjs');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.SVGSVGElement = window.SVGSVGElement;
globalThis.SVGElement = window.SVGElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
globalThis.ResizeObserver = window.ResizeObserver;
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });

// The plot stub: `draws(code)` decides whether a spec draws (true) or what it
// throws. Every spec it was handed is recorded.
globalThis.__plot = { seen: [], draws: () => true };
// The api stub: every repair asked for, its answer, and every "that answer did
// not draw" report.
globalThis.__repair = { calls: [], answer: '', unusable: [] };

const stubs = {
    store: `export const useStore = (sel) => sel({ theme: 'light', themeTint: '#ffffff', accentColor: '#0e7490', aiTasks: [] });
            export const isDarkTheme = () => false;
            export const themeKeyOf = (theme, tint) => theme + ':' + tint;`,
    api: `export const api = {
            repairVisual: async (kind, code, error, signal, onProgress, revise, onTask) => {
                globalThis.__repair.calls.push({ kind, code, error });
                onTask?.('task-' + globalThis.__repair.calls.length);
                return { code: globalThis.__repair.answer, redrawn: false };
            },
            reportRepairUnusable: async (taskId) => { globalThis.__repair.unusable.push(taskId); return { success: true }; },
            reportVisual: async () => ({ id: null }),
            cancelTask: async () => ({}),
          };`,
    i18n: `const t = (k, o = {}) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o[n] ?? ''));
           export const k = (s) => s;
           export const setUiLanguage = async () => {};
           export const i18nReady = Promise.resolve();
           export const currentLocale = () => 'en-GB';
           export default { t };`,
    'react-i18next': `const t = (k, o = {}) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o[n] ?? ''));
           export const useTranslation = () => ({ t });`,
    renderPlot: `export default async (el, code) => {
            globalThis.__plot.seen.push(code);
            const r = globalThis.__plot.draws(code);
            if (r !== true) throw r;
            const svg = document.createElement('svg');
            svg.setAttribute('data-drawn', code);
            el.appendChild(svg);
          };`,
    // A chunk that never arrived: importing it rejects, as a lazy import does
    // when the file is missing from the server.
    renderSmiles: `throw new TypeError('Failed to fetch dynamically imported module: renderSmiles-abc123.js');`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /(^|\/)(?:\.\.\/)+(api|store|i18n)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'stub' }));
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\/(renderPlot|renderSmiles)$/ }, args => ({ path: args.path.slice(2), namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    },
};

await esbuild.build({
    stdin: {
        contents: `
            import * as React from 'react';
            import { createRoot } from 'react-dom/client';
            import VisualBlock from './src/components/visuals/VisualBlock';
            import { forgetRendererHealth } from './src/components/visuals/rendererHealth';
            const act = React.act;
            globalThis.__act = (fn) => act(fn);
            globalThis.__forget = () => forgetRendererHealth();
            globalThis.__mount = (el, props) => {
                const root = createRoot(el);
                const render = (p) => act(() => { root.render(React.createElement(VisualBlock, p)); });
                render(props);
                return { render, unmount: () => act(() => root.unmount()) };
            };`,
        resolveDir: root,
        loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out,
    jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
    packages: 'external',
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
    plugins: [stubPlugin],
    logLevel: 'silent',
});
require(out);

const act = globalThis.__act;
const host = window.document.getElementById('root');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const settle = async (ms = 700) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const text = () => host.textContent.replace(/\s+/g, ' ').trim();
const button = (re) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent || ''));
const drawn = () => host.querySelector('svg[data-drawn]')?.getAttribute('data-drawn') ?? null;

const BAD = '{"data":[{"fn":"pow(x,2)"}]}';
const FIXED = '{"data":[{"fn":"x^2"}]}';
const STILL_BAD = '{"data":[{"fn":"(x^2"}]}';
const lesson = { kind: 'plot', language: 'plot', live: false, autoRepair: true, surface: 'lesson', nodeId: 5 };

const reset = () => {
    globalThis.__forget();
    globalThis.__plot.seen = [];
    globalThis.__repair.calls = [];
    globalThis.__repair.unusable = [];
    globalThis.__repair.answer = '';
};

console.log('\n--- the renderer itself is broken (every spec throws) ---');
{
    reset();
    globalThis.__plot.draws = () => new TypeError('u is not a function');
    const written = [];
    const m = globalThis.__mount(host, { ...lesson, code: BAD, onRepaired: (a, b) => written.push([a, b]) });
    await settle();
    check('no model repair is started for it', globalThis.__repair.calls.length === 0, JSON.stringify(globalThis.__repair.calls));
    check('the known-good spec was tried before deciding', globalThis.__plot.seen.length >= 2 && globalThis.__plot.seen.some(s => s !== BAD), JSON.stringify(globalThis.__plot.seen));
    check('the card says the fault is the app\'s, not the graph\'s', /fault in the app/i.test(text()), text());
    check('…with the renderer\'s own words kept for a bug report', /u is not a function/.test(text()), text());
    check('Fix with AI is not offered (a model cannot fix our code)', !button(/Fix with AI/), text());
    check('nothing was written back', written.length === 0);
    m.unmount();
}

console.log('\n--- the renderer\'s module never loaded ---');
{
    reset();
    const m = globalThis.__mount(host, { kind: 'smiles', language: 'smiles', code: 'CCO', live: false, autoRepair: true, surface: 'lesson' });
    await settle();
    check('no model repair is started for a chunk that did not arrive', globalThis.__repair.calls.length === 0, JSON.stringify(globalThis.__repair.calls));
    check('the card says the fault is the app\'s', /fault in the app/i.test(text()), text());
    check('Fix with AI is not offered', !button(/Fix with AI/), text());
    m.unmount();
}

console.log('\n--- a fault in the spec, and a repair that does not draw either ---');
{
    reset();
    globalThis.__plot.draws = (code) => (code === BAD || code === STILL_BAD) ? new Error('Unexpected token in "pow(x,2)"') : true;
    globalThis.__repair.answer = STILL_BAD;
    const written = [];
    const m = globalThis.__mount(host, { ...lesson, code: BAD, onRepaired: (a, b) => written.push([a, b]) });
    await settle(900);
    check('the spec fault is sent for repair, once', globalThis.__repair.calls.length === 1 && globalThis.__repair.calls[0].code === BAD, JSON.stringify(globalThis.__repair.calls));
    check('the answer that does not draw is NOT written back', written.length === 0, JSON.stringify(written));
    check('the server is told the answer did not draw (the chip then reads failed)', globalThis.__repair.unusable.length === 1 && globalThis.__repair.unusable[0] === 'task-1', JSON.stringify(globalThis.__repair.unusable));
    check('the card is the error card again', /Couldn't render this graph/.test(text()), text());
    check('…and says the AI\'s fix did not draw either', /fix did not draw either/i.test(text()), text());
    check('no second repair was started by itself', globalThis.__repair.calls.length === 1, JSON.stringify(globalThis.__repair.calls));
    check('Fix with AI is still on offer to try again by hand', !!button(/Fix with AI/));
    const src = button(/Source/);
    if (src) await act(async () => { src.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    check('Source still shows the original spec', !!src && host.textContent.includes('pow(x,2)') && !host.textContent.includes('(x^2"'), text());
    m.unmount();
}

console.log('\n--- a fault in the spec, and the model hands the same spec back ---');
{
    reset();
    globalThis.__plot.draws = (code) => code === BAD ? new Error('Unexpected token in "pow(x,2)"') : true;
    globalThis.__repair.answer = BAD;
    const m = globalThis.__mount(host, { ...lesson, code: BAD });
    await settle(900);
    check('the server is told (the same spec back is no fix either)', globalThis.__repair.unusable.length === 1, JSON.stringify(globalThis.__repair.unusable));
    check('…and the card says the fix did not draw', /fix did not draw either/i.test(text()), text());
    m.unmount();
}

console.log('\n--- a fault in the spec, and a repair that draws ---');
{
    reset();
    globalThis.__plot.draws = (code) => code === BAD ? new Error('Unexpected token in "pow(x,2)"') : true;
    globalThis.__repair.answer = FIXED;
    const written = [];
    const m = globalThis.__mount(host, { ...lesson, code: BAD, onRepaired: (a, b) => written.push([a, b]) });
    await settle(900);
    check('the spec fault is sent for repair, once', globalThis.__repair.calls.length === 1, JSON.stringify(globalThis.__repair.calls));
    check('the fix is written back against the original', written.length === 1 && written[0][0] === BAD && written[0][1] === FIXED, JSON.stringify(written));
    check('the fix is what is drawn', drawn() === FIXED, String(drawn()));
    check('no error card', !/Couldn't render/.test(text()), text());
    check('the server is told nothing (the task really is done)', globalThis.__repair.unusable.length === 0, JSON.stringify(globalThis.__repair.unusable));
    m.unmount();
}

// ---- the server half: a finished repair can be marked unusable ----------------
console.log('\n--- tasks.resultUnusable ---');
{
    const mod = await import(pathToFileURL(join(root, 'server', 'tasks.js')).href);
    const tasks = { ...mod };
    const finished = (dedupeKey, kind = 'visual') => new Promise((res) => {
        const { task } = tasks.createTask({ kind, label: 'Repairing plot', labelKey: 'Repairing a visual', dedupeKey, run: async () => ({ code: 'x' }) });
        const tick = () => (tasks.listTasks().find(t => t.id === task.id)?.status === 'done' ? res(task.id) : setTimeout(tick, 5));
        tick();
    });
    check('tasks.js exports resultUnusable', typeof tasks.resultUnusable === 'function');
    if (typeof tasks.resultUnusable !== 'function') tasks.resultUnusable = () => ({ ok: null });
    const id = await finished('visual-repair:abc');
    const r = tasks.resultUnusable(id);
    const row = tasks.listTasks().find(t => t.id === id);
    check('a finished visual repair becomes a failed one', r.ok && row?.status === 'error', JSON.stringify({ r, status: row?.status }));
    check('…with a message that says why', /did not draw/i.test(row?.error || ''), row?.error);
    check('…and only once', tasks.resultUnusable(id).ok === false);

    const other = await finished('widget:abc');
    check('a task that is not a visual repair is refused', tasks.resultUnusable(other).ok === false && tasks.listTasks().find(t => t.id === other)?.status === 'done');

    const { task: running } = tasks.createTask({ kind: 'visual', label: 'Repairing plot', dedupeKey: 'visual-repair:run', run: () => new Promise(() => { }) });
    check('a repair still running is refused', tasks.resultUnusable(running.id).ok === false);
    tasks.cancelTask(running.id);
    check('an unknown id is refused', tasks.resultUnusable('nope').ok === false);
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will */ }
console.log(`\nvisual-repair gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
