#!/usr/bin/env node
// tools/place-history-gates.mjs — one history entry per place: going to a page
// already behind this one steps back to it, so Back never replays a loop.
//
// Run:  node tools/place-history-gates.mjs              (this checkout)
//       node tools/place-history-gates.mjs --root DIR   (another copy of src/ and server/,
//                                                        e.g. `git archive origin/main src server`,
//                                                        where it must fail)
//
// WHY. Every move pushed a new entry. On a phone: Settings, a section, the
// gear, another section, the gear… and the phone's Back walked Settings,
// section, Settings, section before it ever left Settings. The Today tab
// pressed on Today, or Today again after Projects and Atlas, stacked the same
// way. `src/utils/placeHistory.ts` holds the rule; this replays the moves on
// the REAL router, store and Modal in jsdom (Back is `history.back()`, which
// answers a task later, as a browser does):
//   1. the reported loop: Settings, a section (pushed from the list, as the
//      phone's Settings does), the gear, another section, the gear, three
//      times over: ONE Back then leaves Settings for Today;
//   2. the gear inside a section opened from a link elsewhere (no list behind
//      it) takes the section's place: one Back still leaves Settings;
//   3. a tab pressed on its own page adds no entry;
//   4. Today, Projects, Atlas, then the Today tab: back on the first Today,
//      nothing left behind it;
//   5. a new place still gets a new entry: Today, Projects, Back is Today;
//   6. a dialog whose button went elsewhere left its Back entry under the new
//      page: going back to the page it was opened on lands on that page, with
//      no dialog open, and the next Back goes on from there;
//   7. a move that carries router state (New course from a link) is pushed
//      as asked;
//   8. source: no screen calls react-router's `useNavigate` itself; they take
//      `useAppNavigate`, the one that keeps the rule.
//
// No model, no network.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join, relative } from 'node:path';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : HERE;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra !== '' ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// The harness moves the way the app does: the header's tabs and gear through
// the store (`setView`), a Settings section from its list with router state,
// a link elsewhere through the router's navigate with no state. Only modules
// that exist before and after the fix, so --root on an older tree runs too.
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import Modal from './src/components/Modal';
            import { useRouterStoreSync } from './src/hooks/useRouterStoreSync';
            import { createElement as h, act, useState, StrictMode } from 'react';
            import { createRoot } from 'react-dom/client';
            import { BrowserRouter, useNavigate } from 'react-router-dom';
            let setSpec = null;
            function Harness() {
                useRouterStoreSync();
                const navigate = useNavigate();
                window.__raw = navigate;
                const [spec, set] = useState({ a: false, to: 'atlas' });
                setSpec = set;
                const close = () => set(s => ({ ...s, a: false }));
                return h('div', null,
                    h('p', { id: 'page' }, 'page'),
                    h(Modal, { isOpen: spec.a, onClose: close, title: 'Dialog A' },
                        h('p', null, 'Body of A'),
                        h('button', { type: 'button', id: 'go', onClick: () => { useStore.getState().setView(spec.to); close(); } }, 'Go elsewhere')));
            }
            const mount = (el) => { const r = createRoot(el); act(() => r.render(h(StrictMode, null, h(BrowserRouter, null, h(Harness))))); return r; };
            window.__gate = { useStore, mount, act, set: (patch) => act(() => setSpec(s => ({ ...s, ...patch }))) };`,
        resolveDir: ROOT, loader: 'tsx',
    },
    nodePaths: [join(HERE, 'node_modules')],
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
})).outputFiles[0].text;

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
w.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
w.IntersectionObserver = class { observe() { } unobserve() { } disconnect() { } };
w.IS_REACT_ACT_ENVIRONMENT = true;
w.MessageChannel = MessageChannel;
w.HTMLElement.prototype.scrollIntoView = function () { };
// jsdom lands a `history.go` on its next task, before any 0 ms timer queued
// after it; a phone's browser can take longer. Landing it 30 ms later, as a
// slow one does, is what lets a dialog's own clean-up run while the step is
// still under way (6b; on jsdom's timing that case passed without its fix).
const realGo = w.history.go.bind(w.history);
w.history.go = (delta) => { setTimeout(() => realGo(delta), 30); };
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
w.fetch = (url) => {
    const u = String(url);
    if (/\/api\/projects(\?|$)/.test(u)) return Promise.resolve(json([]));
    if (/\/api\/settings(\?|$)/.test(u)) return Promise.resolve(json({}));
    return new Promise(() => { });
};
w.eval(bundle);
const { useStore, mount, act, set } = w.__gate;
useStore.setState({ authChecked: true, authEnabled: false, projects: [] });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 15)); }); };
const at = () => w.location.pathname + w.location.hash;
const back = async () => { w.history.back(); await settle(); };
const tab = async (view) => { await act(async () => { useStore.getState().setView(view); }); await settle(); };
// The phone's Settings list opening a section: a push that carries state.
const section_ = async (s) => { await act(async () => { w.__raw(`/settings#${s}`, { state: { fromList: true } }); }); await settle(); };
// A link elsewhere in the app ("Set up AI"): the app's navigate (the one the
// store holds, which every screen's equals), no state.
const link = async (to, options) => { await act(async () => { useStore.getState()._navigate(to, options); }); await settle(); };
const dialogOpen = () => [...w.document.body.querySelectorAll('[role="dialog"]')].some(d => d.textContent.includes('Dialog A'));
// Backs until the address leaves `prefix`, at most `max`; the count taken.
const backsToLeave = async (prefix, max = 12) => {
    let n = 0;
    while (at().startsWith(prefix) && n < max) { await back(); n++; }
    return n;
};

await act(async () => { mount(w.document.getElementById('root')); });
await settle();

section('1. the reported loop: Settings, a section, the gear, another section, the gear…');
await tab('settings');
for (const s of ['general', 'accessibility', 'ai']) {
    await section_(s);
    check(`the ${s} section is open`, at() === `/settings#${s}`, at());
    await tab('settings');
    check(`the gear goes back to the Settings list`, at() === '/settings', at());
}
const n1 = await backsToLeave('/settings');
check('ONE Back then leaves Settings', n1 === 1, { backs: n1 });
check('and lands on Today, where it came from', at() === '/', at());

section('2. the gear inside a section opened from a link elsewhere');
await link('/settings#ai');
check('the link opened the AI section', at() === '/settings#ai', at());
await tab('settings');
check('the gear shows the Settings list', at() === '/settings', at());
const n2 = await backsToLeave('/settings');
check('one Back leaves Settings (the section did not stay under the list)', n2 === 1, { backs: n2 });
check('back on Today', at() === '/', at());

section('3. a tab pressed on its own page adds no entry');
await tab('projects');
const len3 = w.history.length;
await tab('projects');
await tab('projects');
check('Projects pressed twice more: no new entries', w.history.length === len3, { before: len3, after: w.history.length });
await back();
check('one Back is Today', at() === '/', at());

section('4. Today, Projects, Atlas, then the Projects tab');
await tab('projects');
await tab('atlas');
await tab('projects');
check('the Projects tab shows Projects', at() === '/projects', at());
await back();
check('Atlas is not left behind it: Back is Today', at() === '/', at());

section('5. a new place still gets a new entry');
await tab('projects');
check('Projects is open', at() === '/projects', at());
await back();
check('Back is Today', at() === '/', at());

section('6. a dialog that went elsewhere, then back to the page it was opened on');
await tab('projects');
await set({ a: true }); await settle();
check('the dialog is open on Projects', dialogOpen() && at() === '/projects', at());
const go = w.document.getElementById('go');
await act(async () => { go.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); });
await settle();
check('its button went to Atlas and closed it', at() === '/atlas' && !dialogOpen(), at());
await tab('projects');
check('the Projects tab lands on Projects', at() === '/projects', at());
check('with no dialog open', !dialogOpen());
await back();
check('the next Back goes on to Today', at() === '/', at());

section('6b. a dialog whose button goes to a page already behind');
// Today, Projects, Atlas, Settings; the dialog opens on Settings and its
// button goes to Projects while it closes, in the same tick.
await tab('projects');
await tab('atlas');
await tab('settings');
await set({ a: true, to: 'projects' }); await settle();
check('the dialog is open on Settings', dialogOpen() && at() === '/settings', at());
await act(async () => { w.document.getElementById('go').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); });
await settle();
check('it lands on Projects exactly (not one entry short)', at() === '/projects' && !dialogOpen(), at());
await back();
check('the next Back is Today', at() === '/', at());
await set({ to: 'atlas' }); await settle();

section('6c. an explicit replace rewrites the entry, it never jumps');
await tab('projects');
await tab('atlas');
await link('/projects', { replace: true });
check('the replace shows Projects', at() === '/projects', at());
await back();
check('Back is the Projects entry from before, as a replace leaves it', at() === '/projects', at());
await back();
check('then Today', at() === '/', at());

section('7. a move with router state is pushed as asked');
await tab('projects');
const len7 = w.history.length;
await link('/projects', { state: { create: true } });
check('New course from a link: one new entry on Projects', w.history.length === len7 + 1 && at() === '/projects', { before: len7, after: w.history.length });
check('the new entry carries the state the link asked for', w.history.state?.usr?.create === true, w.history.state);

section('8. no screen navigates around the rule');
const offenders = [];
const walk = (dir) => {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) continue;
        const rel = relative(ROOT, p).replace(/\\/g, '/');
        if (rel === 'src/hooks/useAppNavigate.ts') continue;
        const src = readFileSync(p, 'utf8');
        if (/\buseNavigate\b/.test(src)) offenders.push(rel);
    }
};
if (existsSync(join(ROOT, 'src'))) walk(join(ROOT, 'src'));
check('only hooks/useAppNavigate.ts calls useNavigate', offenders.length === 0, offenders.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
