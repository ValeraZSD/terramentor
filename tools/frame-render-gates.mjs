// tools/frame-render-gates.mjs — a creation run's stream frame renders the dialog once.
//
// Run:  node tools/frame-render-gates.mjs              (the working tree)
//       node tools/frame-render-gates.mjs --rev v1.2.0 (the two components as they were
//                                                       at a ref, to watch the cases
//                                                       fail on the pre-fix code)
//
// WHY. "Create with AI" died about 30 seconds in, at Phase 1's topics, with "An error
// occurred" and React's minified error #185 (maximum update depth). Every stream frame
// is a store update, which React 19 commits on the sync lane and whose passive effects
// it flushes inside that commit. Two effects in the open dialog set state on EVERY
// frame even when nothing had changed:
//   LiveStructureTree  the auto-collapse effect built and returned a new Set each time
//   ScrollShade        measure() called setEdges with an updater that returned `prev`,
//                      which still schedules a render before it bails out
// Each left a render pending behind the frame's commit, the next frame committed on
// top of it, and React counts those as nested updates. A burst of fifty frames (the
// topics phase streams that many) threw #185 inside the store's setState, and the
// creation run caught it as its own failure. React 18, before #58, did not count them
// the same way, so the 8 Oct hero take finished.
//
// The REAL components are bundled into jsdom under an external store that commits the
// way Zustand does (useSyncExternalStore, so the sync lane), and frames are fed the
// way the SSE reader feeds them: one per microtask turn, without yielding to tasks.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const at = process.argv.indexOf('--rev');
const REV = at > 0 ? process.argv[at + 1] : null;
if (at > 0 && !REV) throw new Error('--rev needs a ref, e.g. --rev v1.2.0');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const revFiles = {
    name: 'rev-files',
    setup(build) {
        if (!REV) return;
        build.onLoad({ filter: /[\\/]src[\\/]components[\\/](creation[\\/]CreationRunParts|ui[\\/]ScrollShade)\.tsx$/ }, (args) => {
            const rel = args.path.slice(root.length + 1).replace(/\\/g, '/');
            return { contents: execFileSync('git', ['show', `${REV}:${rel}`], { cwd: root, encoding: 'utf8' }), loader: 'tsx' };
        });
    },
};

// The dialog's two live pieces, nested as CreationRunView nests them, each under a
// Profiler so a render is counted where it happened.
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { createElement as h, Profiler, useSyncExternalStore, act } from 'react';
            import { createRoot } from 'react-dom/client';
            import ScrollShade from './src/components/ui/ScrollShade';
            import { LiveStructureTree } from './src/components/creation/CreationRunParts';
            let state = { tree: [] }; const subs = new Set();
            const store = {
                get: () => state,
                set: (next) => { state = next; for (const f of subs) f(); },
                sub: (f) => { subs.add(f); return () => subs.delete(f); },
            };
            const renders = { tree: 0, shade: 0 };
            const count = (id) => { renders[id]++; };
            function Host() {
                const { tree } = useSyncExternalStore(store.sub, store.get);
                return h(Profiler, { id: 'shade', onRender: count },
                    h(ScrollShade, null, h(Profiler, { id: 'tree', onRender: count },
                        h(LiveStructureTree, { tree, activeNodeKey: null }))));
            }
            const mount = (el) => { const r = createRoot(el); act(() => r.render(h(Host))); return r; };
            window.__gate = { store, renders, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl' },
    plugins: [revFiles],
})).outputFiles[0].text;

// A run in Phase 1: the first category finished, the second being written. Every
// frame is a NEW array with the same content, as `patch` produces.
const node = (key, status, children = []) => ({ key, title: key, description: '', depth: 0, status, resourceCount: 0, children });
const frame = (i) => [
    node('cat-0', 'created', [node('cat-0-el-0', 'created')]),
    node('cat-1', 'generating', [node('cat-1-el-0', 'created'), node(`cat-1-el-${i + 1}`, 'generating')]),
];

function open({ act: actMode }) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
    w.HTMLElement.prototype.scrollTo = function () { };
    w.IS_REACT_ACT_ENVIRONMENT = actMode;
    w.MessageChannel = MessageChannel;
    const errors = [];
    w.console.error = (...a) => errors.push(a.map(String).join(' '));
    w.console.warn = (...a) => errors.push(a.map(String).join(' '));
    w.eval(bundle);
    const g = w.__gate;
    g.store.set({ tree: frame(0) });
    const r = g.mount(w.document.getElementById('root'));
    return { ...g, errors, root: w.document.getElementById('root'), close: () => { g.act(() => r.unmount()); w.close(); } };
}

section('1. One frame, one render of each piece');
{
    const s = open({ act: true });
    await s.act(async () => { });
    const before = { ...s.renders };
    const N = 10;
    for (let i = 1; i <= N; i++) await s.act(async () => { s.store.set({ tree: frame(i) }); });
    const tree = s.renders.tree - before.tree, shade = s.renders.shade - before.shade;
    check(`the structure tree renders once per frame (${N} frames)`, tree === N, `${tree} renders`);
    check(`the scroll shade renders once per frame (${N} frames)`, shade === N, `${shade} renders`);
    s.close();
}

section('2. A burst of frames, fed as the stream reader feeds them, does not throw #185');
{
    const s = open({ act: false });
    await new Promise(r => setTimeout(r, 20));
    let thrown = null;
    const N = 120;
    try {
        for (let i = 1; i <= N; i++) {
            s.store.set({ tree: frame(i) });
            for (let k = 0; k < 4; k++) await Promise.resolve();
        }
        await new Promise(r => setTimeout(r, 50));
    } catch (e) { thrown = e; }
    const loop = s.errors.find(e => /Maximum update depth/.test(e));
    check(`${N} frames without "Maximum update depth"`, !thrown && !loop, String(thrown?.message || loop || '').slice(0, 160));
    try { s.close(); } catch { }
}

section('3. A finished phase folds once; opened again, it stays open');
{
    const s = open({ act: true });
    await s.act(async () => { });
    const doc = s.root.ownerDocument;
    const shown = () => doc.body.textContent.includes('cat-0-el-0');
    const folded = !shown();
    const toggle = doc.querySelector('button[title="Expand"]');
    await s.act(async () => { toggle?.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true })); });
    for (let i = 1; i <= 5; i++) await s.act(async () => { s.store.set({ tree: frame(i) }); });
    check('the finished phase folded by itself', folded);
    check('…and the learner\'s re-opening survives the next frames', !!toggle && shown());
    s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
