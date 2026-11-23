#!/usr/bin/env node
// tools/dialog-back-gates.mjs — Back closes the dialog, not the page behind it;
// the New course window asks before it drops what was typed.
//
// Run:  node tools/dialog-back-gates.mjs              (this checkout)
//       node tools/dialog-back-gates.mjs --root DIR   (another copy of src/ and server/,
//                                                      e.g. `git archive origin/main src server`,
//                                                      where it must fail)
//
// WHY. A dialog closed on its ✕, Escape and a tap outside, but no dialog had a
// history entry, so a phone's Back button (and the browser's, a mouse's back
// key, an iPhone's edge swipe) went back a PAGE: the dialog stayed open over
// the page before, or vanished with whatever was typed in it. And New course
// let go of a typed name, a goal and added files or links on any close,
// without asking, against "a changed edit asks before Escape/Cancel".
//
// Asserted on the REAL Modal, ConfirmDialog, New course window, router and
// store, in jsdom with a real BrowserRouter over jsdom's history (Back is
// `history.back()`, which fires popstate a task later, as a browser does):
//   1. Back closes an open dialog and the page stays where it is; the next Back
//      then leaves the page as usual (no entry left behind);
//   2. a dialog closed by its ✕ leaves no entry: one Back leaves the page;
//   3. over a dialog, a ConfirmDialog is closed first (answering no), then the
//      dialog, each by one Back, the page never moving;
//   4. a dialog of steps goes one step back per Back, then closes;
//   5. a dialog that cannot be closed (an update being installed) stays, and
//      so does the page;
//   6. a dialog whose button goes to another page: one Back from that page
//      returns to the page the dialog was opened on;
//   7. a ConfirmDialog alone: Back answers no;
//   8. New course: an untouched form closes without asking; Back on the form
//      steps back to the first choice; with typed text, Back, ✕, Escape and a
//      tap outside each ask "Discard your changes?"; Keep editing keeps the
//      text; Discard closes and lets the added material go; Create with AI
//      never asks.
//
//   1 also: opening a dialog adds ONE entry, under StrictMode's double effects;
//   6b. a dialog that stays open while the page under it changes: Back closes
//      it on the new page, the next Back returns to the old one;
//   7b. a list (Select) open inside a dialog: Back closes the list, not the
//      dialog; a list closed by a choice leaves no entry;
//   and a chatbot's reply pasted into New course counts as typed work, and
//   survives a step back and in again.
//
// Run with --root on a tree without this, some checks still hold, on
// purpose: preconditions ("the form is showing") and the closes that already
// worked (✕, an untouched window, Create with AI), kept so a fix cannot break
// them. Every check of a Back or of an ask fails there.
//
// No model, no network.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';

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

const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import Modal from './src/components/Modal';
            import ConfirmDialog from './src/components/ConfirmDialog';
            import NewProjectModal from './src/components/NewProjectModal';
            import { useRouterStoreSync } from './src/hooks/useRouterStoreSync';
            import { Select } from './src/components/ui/Select';
            import { createElement as h, act, useState, StrictMode } from 'react';
            import { createRoot } from 'react-dom/client';
            import { BrowserRouter, useNavigate } from 'react-router-dom';
            // What the harness shows, set from outside; every close is logged.
            const log = [];
            let setSpec = null;
            function Harness() {
                useRouterStoreSync();
                const navigate = useNavigate();
                window.__navigate = navigate;
                const [spec, set] = useState({ a: false, steps: 0, closable: true, nc: false, draft: null });
                setSpec = set;
                const close = () => { log.push('close'); set(s => ({ ...s, a: false })); };
                return h('div', null,
                    h('p', { id: 'page' }, 'page'),
                    h(Modal, {
                        isOpen: spec.a, onClose: close, title: 'Dialog A', closable: spec.closable,
                        onBack: spec.steps > 0 ? () => { log.push('step'); set(s => ({ ...s, steps: s.steps - 1 })); } : undefined,
                    },
                        h('p', null, 'Body of A'),
                        h(Select, { value: 'one', onChange: v => log.push('chose ' + v), 'aria-label': 'Pick one' },
                            h('option', { value: 'one' }, 'One'), h('option', { value: 'two' }, 'Two')),
                        h('button', { type: 'button', id: 'go', onClick: () => { navigate('/atlas'); close(); } }, 'Go elsewhere'),
                        h('button', { type: 'button', id: 'stay', onClick: () => navigate('/atlas') }, 'Go elsewhere, staying open')),
                    h(NewProjectModal, { isOpen: spec.nc, draft: spec.draft, onClose: () => { log.push('nc-close'); set(s => ({ ...s, nc: false })); } }),
                    h(ConfirmDialog));
            }
            // StrictMode, as the app mounts: its development double-run of
            // every effect must not leave a second entry per dialog.
            const mount = (el) => { const r = createRoot(el); act(() => r.render(h(StrictMode, null, h(BrowserRouter, null, h(Harness))))); return r; };
            window.__gate = { useStore, mount, act, log, set: (patch) => act(() => setSpec(s => ({ ...s, ...patch }))) };`,
        resolveDir: ROOT, loader: 'tsx',
    },
    // A copy outside this checkout still takes its packages from here.
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
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const discarded = [];   // staged ids let go
const created = [];     // creation bodies
w.fetch = (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (/\/api\/projects(\?|$)/.test(u)) return Promise.resolve(json([]));
    if (/\/api\/settings(\?|$)/.test(u)) return Promise.resolve(json({}));
    const del = u.match(/\/api\/(?:short-courses\/read|documents\/staged)\/([^/?]+)/);
    if (del && method === 'DELETE') { discarded.push(decodeURIComponent(del[1])); return Promise.resolve(json({ ok: true, removed: true })); }
    if (/\/api\/ai\/create-project(\?|$)/.test(u)) { created.push(JSON.parse(String(init.body || '{}'))); return new Promise(() => { }); }
    return new Promise(() => { });
};
w.eval(bundle);
const { useStore, mount, act, log, set } = w.__gate;
useStore.setState({ authChecked: true, authEnabled: false, projects: [] });

// Real time, not only microtasks: jsdom answers `history.back()` a task later,
// and the dialogs' history work runs on a timer after each change.
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 15)); }); };
const path = () => w.location.pathname;
const back = async () => { w.history.back(); await settle(); };
const body = () => w.document.body;
const dialogs = () => [...body().querySelectorAll('[role="dialog"]')];
const titled = (t) => dialogs().find(d => d.textContent.includes(t));
const buttons = () => [...body().querySelectorAll('button')];
const buttonNamed = (name, inside = body()) => [...inside.querySelectorAll('button')].find(b => b.textContent.trim() === name || b.getAttribute('aria-label') === name);
const click = async (node) => { await act(async () => { node.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }); await settle(); };
const press = async (name, inside) => {
    const b = buttonNamed(name, inside);
    if (!b) throw new Error(`no "${name}" button: ${body().textContent.slice(0, 300)}`);
    await click(b);
};
const escape = async () => {
    await act(async () => { w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await settle();
};
// A tap on the dim backdrop behind the topmost dialog: down and up in one
// place, then the click, as `useTapGuard` reads it.
const tapOutside = async () => {
    const shade = [...body().querySelectorAll('div[aria-hidden="true"]')].filter(d => /bg-black/.test(d.className)).pop();
    if (!shade) throw new Error('no backdrop');
    const at = { bubbles: true, cancelable: true, clientX: 5, clientY: 5, pointerId: 1, button: 0 };
    const P = w.PointerEvent ?? w.MouseEvent;
    await act(async () => {
        shade.dispatchEvent(new P('pointerdown', at));
        shade.dispatchEvent(new P('pointerup', at));
        shade.dispatchEvent(new w.MouseEvent('click', at));
    });
    await settle();
};
const fill = async (node, value) => {
    const proto = node.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value); node.dispatchEvent(new w.Event('input', { bubbles: true })); });
    await settle();
};
const nameField = () => [...body().querySelectorAll('input')].find(i => /Machine Learning/.test(i.placeholder || ''));
const asking = () => titled('Discard your changes?');
const goTo = async (p) => { await act(async () => { w.__navigate(p); }); await settle(); };
const logged = () => log.splice(0).join(',');
// A confirm the app asks; `answer` holds its reply once given.
let answer = 'pending';
const ask = async () => {
    answer = 'pending';
    await act(async () => {
        useStore.getState().showConfirm({ title: 'Remove it?', message: 'It goes for good.', confirmLabel: 'Remove', cancelLabel: 'Keep', variant: 'warning' }).then(v => { answer = v; });
    });
    await settle();
};

const el = w.document.getElementById('root');
await act(async () => { mount(el); });
await settle();
// A page to come from: Today, then Projects.
await goTo('/projects');

section('1. Back closes the dialog; the page stays');
const entriesBefore = w.history.length;
await set({ a: true }); await settle();
check('the dialog is open on /projects', !!titled('Dialog A') && path() === '/projects', path());
check('it added exactly one history entry (StrictMode runs its effects twice)', w.history.length === entriesBefore + 1, { before: entriesBefore, after: w.history.length });
await back();
check('Back closes it', !titled('Dialog A') && logged() === 'close');
check('and the page stays on /projects', path() === '/projects', path());
await back();
check('the next Back leaves the page as usual (no entry left behind)', path() === '/', path());
await goTo('/projects');

section('2. closed by its ✕, it leaves no entry');
await set({ a: true }); await settle();
await press('Close dialog', titled('Dialog A'));
check('✕ closes it, on the same page', !titled('Dialog A') && path() === '/projects' && logged() === 'close', path());
await back();
check('one Back then leaves the page', path() === '/', path());
await goTo('/projects');

section('3. a ConfirmDialog over a dialog');
await set({ a: true }); await settle();
await ask();
check('both are open', !!titled('Remove it?') && !!titled('Dialog A'));
await back();
check('Back closes the confirm only, answering no', !titled('Remove it?') && !!titled('Dialog A') && answer === false, { answer, a: !!titled('Dialog A') });
check('the page did not move', path() === '/projects', path());
await back();
check('the next Back closes the dialog', !titled('Dialog A') && logged() === 'close');
check('and the page still did not move', path() === '/projects', path());

section('4. a dialog of steps');
await set({ a: true, steps: 2 }); await settle();
await back();
check('Back goes one step back, the dialog stays', !!titled('Dialog A') && logged() === 'step');
await back();
check('Back again: one more step', !!titled('Dialog A') && logged() === 'step');
await back();
check('on the first step Back closes it', !titled('Dialog A') && logged() === 'close');
check('three Backs, and the page never moved', path() === '/projects', path());

section('5. a dialog that cannot be closed');
await set({ a: true, closable: false }); await settle();
await back();
check('Back leaves it open', !!titled('Dialog A') && logged() === '');
check('and leaves the page alone', path() === '/projects', path());
await back();
check('a second Back too', !!titled('Dialog A') && path() === '/projects', path());
await set({ a: false, closable: true }); await settle();
await back();
check('closed by the app, one Back leaves the page', path() === '/', path());
await goTo('/projects');

section('5b. a Back that jumps two entries stops at a dialog that refuses');
// New course opens first, then a dialog that cannot be closed on top of it.
// A long-press on Back (or history.go(-2)) pops both marks at once.
await set({ nc: true }); await settle();
await set({ a: true, closable: false }); await settle();
check('both are open', !!titled('New course') && !!titled('Dialog A'));
await act(async () => { w.history.go(-2); }); await settle();
check('the dialog on top refuses, and the one under it is not closed past it',
    !!titled('Dialog A') && !!titled('New course') && logged() === '', { a: !!titled('Dialog A'), nc: !!titled('New course'), log: log.slice() });
check('the page did not move', path() === '/projects', path());
await set({ a: false, closable: true, nc: false }); await settle();
logged();
await back();
check('closed by the app, one Back leaves the page', path() === '/', path());
await goTo('/projects');

section('6. a dialog that goes to another page');
await set({ a: true }); await settle();
await click(body().querySelector('#go'));
check('its button went to /atlas and closed it', path() === '/atlas' && !titled('Dialog A') && logged() === 'close', path());
await back();
check('one Back returns to the page it was opened on', path() === '/projects', path());
await back();
check('and the next to the page before', path() === '/', path());
await goTo('/projects');

section('6b. a dialog that stays open over a new page');
await set({ a: true }); await settle();
await click(body().querySelector('#stay'));
check('the page changed under the open dialog', path() === '/atlas' && !!titled('Dialog A'), path());
await back();
check('Back closes the dialog on the new page', !titled('Dialog A') && logged() === 'close' && path() === '/atlas', path());
await back();
check('the next Back returns to the page before', path() === '/projects', path());
await set({ a: false }); await settle();
if (path() !== '/projects') await goTo('/projects');
log.splice(0);

section('7. a ConfirmDialog alone');
await ask();
await back();
check('Back answers no and closes it', answer === false && !titled('Remove it?'), answer);
check('on the same page', path() === '/projects', path());

// Each block starts from a closed dialog on /projects, so on a tree without
// this every check fails on its own instead of the first one stopping the walk.
const block = async (fn) => {
    // A confirm an earlier Back failed to close (on a tree without this) is
    // not this block's.
    if (titled('Remove it?')) { await act(async () => { useStore.getState().hideConfirm(false); }); await settle(); }
    try { await fn(); } catch (e) { check('the block ran to its end', false, e.message.slice(0, 160)); }
    if (asking()) { await press('Keep editing').catch(() => { }); }
    await set({ a: false, nc: false, draft: null }); await settle();
    if (path() !== '/projects') await goTo('/projects');
    log.splice(0);
};

section('7b. a list open inside a dialog');
const listOpen = () => !!body().querySelector('[role="listbox"]');
await block(async () => {
    await set({ a: true }); await settle();
    await click(buttonNamed('Pick one'));
    check('the list is open over the dialog', listOpen() && !!titled('Dialog A'));
    await back();
    check('Back closes the list only, as Escape does', !listOpen() && !!titled('Dialog A') && logged() === '', { list: listOpen(), a: !!titled('Dialog A') });
    check('the page did not move', path() === '/projects', path());
    await back();
    check('the next Back closes the dialog', !titled('Dialog A') && logged() === 'close');
});
await block(async () => {
    await set({ a: true }); await settle();
    await click(buttonNamed('Pick one'));
    await click([...body().querySelectorAll('[role="option"]')].find(o => o.textContent.includes('Two')));
    check('a list closed by a choice leaves no entry', !listOpen() && logged() === 'chose two');
    await back();
    check('so one Back then closes the dialog', !titled('Dialog A') && logged() === 'close' && path() === '/projects', path());
});

section('8. New course asks before it drops what was typed');
const create = () => click(buttons().find(b => b.textContent.includes('Create a course')));
const openTyped = async () => {
    await set({ nc: true, draft: null }); await settle();
    await create();
    await fill(nameField(), 'Knots');
};

await block(async () => {
    await set({ nc: true, draft: null }); await settle();
    check('it opens on the first choice', buttons().some(b => b.textContent.includes('Create a course')));
    await press('Close dialog', titled('New course'));
    check('untouched, ✕ closes it without asking', !titled('New course') && !asking() && logged() === 'nc-close');
});
await block(async () => {
    await set({ nc: true, draft: null }); await settle();
    await back();
    check('untouched, Back closes it without asking, on the same page', !titled('New course') && !asking() && logged() === 'nc-close' && path() === '/projects', path());
});
await block(async () => {
    await set({ nc: true, draft: null }); await settle();
    await create();
    check('the form is showing', !!nameField());
    await back();
    check('Back on the form steps back to the first choice', !!titled('New course') && !nameField() && buttons().some(b => b.textContent.includes('Create a course')) && logged() === '');
});
await block(async () => {
    await openTyped();
    await back();
    check('with a typed name, Back steps back first, keeping the window', !!titled('New course') && !asking() && !nameField());
    await back();
    check('then Back on the first choice asks', !!asking() && !!titled('New course'), body().textContent.slice(0, 200));
    check('asking moved no page', path() === '/projects', path());
    await press('Keep editing');
    check('Keep editing keeps the window', !asking() && !!titled('New course') && logged() === '');
    await create();
    check('and the typed name', nameField()?.value === 'Knots', nameField()?.value);
});
for (const [how, act_] of [['✕', () => press('Close dialog', titled('New course'))], ['Escape', escape], ['a tap outside', tapOutside]]) {
    await block(async () => {
        await openTyped();
        await act_();
        check(`with a typed name, ${how} asks`, !!asking() && !!titled('New course'));
        await press('Keep editing');
        check(`and Keep editing after ${how} keeps the name`, !asking() && nameField()?.value === 'Knots', nameField()?.value);
    });
}
await block(async () => {
    await openTyped();
    await press('Close dialog', titled('New course'));
    check('asking, before the Back', !!asking());
    await back();
    check('Back on the confirm answers Keep editing: the window and its text stay', !asking() && !!titled('New course') && nameField()?.value === 'Knots' && logged() === '');
});
await block(async () => {
    await openTyped();
    await press('Close dialog', titled('New course'));
    await press('Discard');
    check('Discard closes the window', !titled('New course') && !asking() && logged() === 'nc-close');
    check('on the same page, with no entry left behind', path() === '/projects', path());
    await back();
    check('one Back then leaves the page', path() === '/', path());
});
await block(async () => {
    const staged = { ok: true, id: 'staged-1', title: 'Rope work', suggestedTitle: 'Rope work', titleFrom: 'metadata', file_type: 'text', file_size: 4000, page_count: null, char_count: 4000, noText: false, language: 'en', original_filename: 'rope.txt', structure: { method: 'none', topCount: 0, sections: [] }, source: null };
    await set({ nc: true, draft: { name: '', description: '', color: '', icon: '', language: '', documents: [staged] } }); await settle();
    check('a form handed back with a file', !!titled('New course') && body().textContent.includes('Rope work'));
    await escape();
    check('Escape asks: the file is the learner\'s material', !!asking());
    await press('Discard');
    check('Discard lets the file go', !titled('New course') && logged() === 'nc-close' && discarded.includes('staged-1'), discarded);
});
await block(async () => {
    await set({ nc: true, draft: null }); await settle();
    await click(buttons().find(b => b.textContent.includes('Import a course')));
    await click(buttons().find(b => b.textContent.includes('Or make a course with an external chatbot')));
    const reply = body().querySelector('textarea[aria-label="The model\'s reply"]');
    check('the chatbot path shows its reply box', !!reply);
    await fill(reply, '{ "project": { "name": "Knots" }, "nodes": [] }');
    await press('Close dialog', titled('New course'));
    check('with a chat reply pasted back, ✕ asks', !!asking() && !!titled('New course'));
});
await block(async () => {
    await set({ nc: true, draft: null }); await settle();
    await create();
    const link = body().querySelector('#course-material-link');
    check('the form has its link box', !!link);
    await fill(link, 'https://example.org/knots');
    await press('Close dialog', titled('New course'));
    check('with a link typed but not yet added, ✕ asks', !!asking() && !!titled('New course'));
});
await block(async () => {
    await set({ nc: true, draft: null }); await settle();
    await create();
    await fill(body().querySelector('#course-material-link'), 'https://example.org/knots');
    await back();
    check('Back from the form with a typed link steps to the first choice', !!titled('New course') && !asking() && buttons().some(b => b.textContent.includes('Create a course')));
    await create();
    check('and the typed link is still in its box on the way in again', body().querySelector('#course-material-link')?.value === 'https://example.org/knots');
    await back(); await back();
    check('Back at the first choice asks, the link being typed work', !!asking() && !!titled('New course'));
});
await block(async () => {
    await set({ nc: true, draft: null }); await settle();
    await click(buttons().find(b => b.textContent.includes('Import a course')));
    await click(buttons().find(b => b.textContent.includes('Or make a course with an external chatbot')));
    await fill(body().querySelector('textarea[aria-label="The model\'s reply"]'), '{ "nodes": [] }');
    await back();
    check('Back from the chatbot path steps back to the import view', !!titled('New course') && !body().querySelector('textarea[aria-label="The model\'s reply"]') && !asking());
    await click(buttons().find(b => b.textContent.includes('Or make a course with an external chatbot')));
    check('and the pasted reply is still there on the way in again', body().querySelector('textarea[aria-label="The model\'s reply"]')?.value === '{ "nodes": [] }');
    await back(); await back();
    check('two more Backs reach the first choice, keeping the window', !!titled('New course') && !asking() && buttons().some(b => b.textContent.includes('Create a course')));
    await back();
    check('and Back there asks, the reply being typed work', !!asking() && !!titled('New course'));
});
await block(async () => {
    await openTyped();
    await press('Create with AI');
    const createdLog = logged();
    check('Create with AI closes without asking', !asking() && createdLog === 'nc-close', { asking: !!asking(), log: createdLog });
    check('and the creation went out', created.some(c => c.name === 'Knots'), created.map(c => c.name));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
