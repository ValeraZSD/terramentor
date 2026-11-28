// tools/assistant-drawer-gates.mjs — the assistant drawer at the edges of a turn.
//
// Run:  node tools/assistant-drawer-gates.mjs                (the working tree)
//       node tools/assistant-drawer-gates.mjs --base <rev>   (AssistantDrawer.tsx as it is at
//                                                            <rev>, to watch the cases fail)
//
// The REAL drawer and store are bundled into jsdom; `fetch` answers only when the gate says
// so, and a stream is a ReadableStream the gate writes frames into. Cases:
//   1. a setting change in an answer this panel watched arrive is APPLIED once, with Undo —
//      also when the socket dropped and the answer was read back from history, and when the
//      panel followed a turn already running (a reload mid-turn). Re-read history only
//      states what an old turn did; a watched turn that only stated it left the app unchanged.
//   2. a conversation that fails to open does not stay the one a send goes to;
//   3. a resize drag ends on pointercancel as well as pointerup;
//   4. a file dropped during a turn is attached, as the "+" menu and a paste attach it.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : null;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const baseFiles = {
    name: 'base-files',
    setup(build) {
        if (!BASE) return;
        build.onLoad({ filter: /[\\/]src[\\/]components[\\/]AssistantDrawer\.tsx$/ }, () => ({
            contents: execFileSync('git', ['show', `${BASE}:src/components/AssistantDrawer.tsx`], { cwd: root, encoding: 'utf8' }),
            loader: 'tsx',
        }));
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import AssistantDrawer from './src/components/AssistantDrawer';
            import { MemoryRouter } from 'react-router-dom';
            import { createElement, act } from 'react'; import { createRoot } from 'react-dom/client';
            const mount = (el, props) => {
                const root = createRoot(el);
                act(() => root.render(createElement(MemoryRouter, null, createElement(AssistantDrawer, props))));
                return root;
            };
            window.__gate = { useStore, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl' },
    plugins: [baseFiles],
})).outputFiles[0].text;

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const encoder = new TextEncoder();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const conv = (id, title) => ({ id, title, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', message_count: 2 });
const msg = (id, role, content) => ({ id, role, content, created_at: '2026-11-20T10:00:00Z' });

function page({ tasks = [] } = {}) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>',
        { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
    w.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
    w.IntersectionObserver = class { observe() { } unobserve() { } disconnect() { } takeRecords() { return []; } };
    w.Element.prototype.scrollTo = function () { };
    w.Element.prototype.scrollIntoView = function () { };
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    Object.assign(w, { TextDecoder, TextEncoder, ReadableStream, Response });
    // An upload that never answers: the chip stays, uploading.
    w.XMLHttpRequest = class { constructor() { this.upload = {}; } open() { } send() { } abort() { } setRequestHeader() { } };
    const requests = [];
    w.fetch = (url, init = {}) => new Promise((ok) => { requests.push({ url: String(url), method: init.method || 'GET', body: init.body, ok, answered: false }); });
    w.eval(bundle);
    const { useStore, mount, act } = w.__gate;
    useStore.setState({ aiTasks: tasks, themeChoice: 'light', theme: 'light', _navigate: () => { } });
    const el = w.document.getElementById('root');
    const resizes = [];
    let r = null;
    const find = (pattern, { method, last = false } = {}) => {
        const open = requests.filter(q => !q.answered && pattern.test(q.url) && (!method || q.method === method));
        return last ? open.at(-1) : open[0];
    };
    const answer = async (pattern, response, opts) => {
        const q = find(pattern, opts);
        if (!q) return false;
        q.answered = true;
        await act(async () => { q.ok(typeof response === 'function' ? response() : response); await settle(); });
        return true;
    };
    /** A response whose body the gate writes into, frame by frame. */
    const stream = () => {
        let ctrl;
        const body = new ReadableStream({ start(c) { ctrl = c; } });
        return {
            response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
            frame: async (obj) => { await act(async () => { ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); await settle(); }); },
            close: async () => { await act(async () => { ctrl.close(); await settle(); }); },
        };
    };
    const type = async (text) => {
        const ta = w.document.querySelector('textarea');
        await act(async () => {
            Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
            ta.dispatchEvent(new w.Event('input', { bubbles: true }));
            await settle();
        });
        await act(async () => { ta.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle(); });
    };
    const fire = async (target, type, props = {}) => {
        await act(async () => {
            const e = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: props.clientX ?? 0 });
            for (const [k, v] of Object.entries(props)) if (k !== 'clientX') Object.defineProperty(e, k, { value: v });
            target.dispatchEvent(e);
            await settle();
        });
    };
    const button = (pattern) => [...w.document.querySelectorAll('button')].find(b => pattern.test(b.textContent || '') || pattern.test(b.getAttribute('aria-label') || ''));
    return {
        w, useStore, act, requests, answer, stream, type, fire, button, resizes,
        mount: async () => {
            await act(async () => {
                r = mount(el, { open: true, onClose: () => { }, docked: true, width: 420, onResize: (n) => resizes.push(n) });
                await settle();
            });
        },
        text: () => w.document.body.textContent,
        themeWrites: () => requests.filter(q => /\/settings\/theme$/.test(q.url) && q.method === 'PUT').length,
        close: () => { if (r) act(() => r.unmount()); w.close(); },
    };
}

const MARKED = 'Switching to dark now. [[set:theme:dark]]';

section('a setting change in an answer the panel watched arrive is applied once');
{
    // The socket drops after the turn was taken on; the turn finishes meanwhile and the
    // answer is read back from history.
    const p = page();
    await p.mount();
    await p.answer(/\/ai\/conversations$/, json([conv(7, 'Colours')]));
    await p.answer(/\/ai\/conversations\/7\/messages$/, json([]));
    await p.type('make it dark');
    const s = p.stream();
    await p.answer(/\/ai\/assistant\/stream$/, s.response);
    await s.frame({ taskId: 't1' });
    await s.frame({ conversationId: 7 });
    await s.frame({ chunk: 'Switching to dark' });
    p.useStore.setState({ aiTasks: [{ id: 't1', kind: 'today_chat', status: 'done', meta: { conversationId: 7 } }] });
    await s.close();
    await p.answer(/\/ai\/conversations\/7\/messages$/, json([msg(41, 'user', 'make it dark'), msg(42, 'assistant', MARKED)]));
    check('dropped socket, turn finished: the stored answer applies its change', p.useStore.getState().themeChoice === 'dark',
        `theme is ${p.useStore.getState().themeChoice}`);
    check('…and offers Undo', !!p.button(/^Undo/));
    check('…written once', p.themeWrites() === 1, `${p.themeWrites()} writes`);
    p.close();
}
/** Send `question`, let the turn be taken on, then drop the socket with the task `done`. */
async function droppedTurn(p, question, taskId) {
    await p.type(question);
    const s = p.stream();
    await p.answer(/\/ai\/assistant\/stream$/, s.response);
    await s.frame({ taskId });
    await s.frame({ conversationId: 7 });
    p.useStore.setState({ aiTasks: [{ id: taskId, kind: 'today_chat', status: 'done', meta: { conversationId: 7 } }] });
    await s.close();
}
{
    // The turn finished with nothing to say: the server stores no answer and drops the
    // question, so the last row is the PREVIOUS turn's answer, which changed the theme.
    const p = page();
    await p.mount();
    await p.answer(/\/ai\/conversations$/, json([conv(7, 'Colours')]));
    const before = [msg(31, 'user', 'make it dark'), msg(32, 'assistant', MARKED)];
    await p.answer(/\/ai\/conversations\/7\/messages$/, json(before));
    await droppedTurn(p, 'and the accent?', 't3');
    await p.answer(/\/ai\/conversations\/7\/messages$/, json(before));
    check('dropped socket, no answer stored: an older answer is not applied again',
        p.useStore.getState().themeChoice === 'light' && p.themeWrites() === 0, `theme ${p.useStore.getState().themeChoice}, ${p.themeWrites()} writes`);
    p.close();
}
{
    // Another reload (a change heard on the feed) starts after the turn's own and answers
    // first: whichever load shows the stored answer first marks it.
    const p = page();
    await p.mount();
    await p.answer(/\/ai\/conversations$/, json([conv(7, 'Colours')]));
    await p.answer(/\/ai\/conversations\/7\/messages$/, json([]));
    await droppedTurn(p, 'make it dark', 't4');
    await p.act(async () => { p.useStore.setState({ chatChange: { n: 1, at: { 7: 1 } } }); });
    const rows = [msg(41, 'user', 'make it dark'), msg(42, 'assistant', MARKED)];
    await p.answer(/\/ai\/conversations\/7\/messages$/, json(rows), { last: true });
    await p.answer(/\/ai\/conversations\/7\/messages$/, json(rows));
    check('dropped socket, a newer reload answers first: the change is still applied',
        p.useStore.getState().themeChoice === 'dark' && p.themeWrites() === 1, `theme ${p.useStore.getState().themeChoice}, ${p.themeWrites()} writes`);
    p.close();
}
{
    // A turn already running when the panel opens (a reload mid-turn): the panel follows it
    // to its end.
    const p = page({ tasks: [{ id: 't2', kind: 'today_chat', status: 'running', meta: { conversationId: 7, message: 'make it dark' } }] });
    await p.mount();
    await p.answer(/\/ai\/conversations$/, json([conv(7, 'Colours')]));
    for (let i = 0; i < 2; i++) await p.answer(/\/ai\/conversations\/7\/messages$/, json([msg(41, 'user', 'make it dark')]));
    const s = p.stream();
    await p.answer(/\/tasks\/t2\/stream$/, s.response);
    await s.frame({ chunk: MARKED });
    await s.frame({ done: true, content: MARKED, assistantMessageId: 43 });
    while (await p.answer(/\/ai\/conversations\/7\/messages$/, json([msg(41, 'user', 'make it dark'), msg(43, 'assistant', MARKED)]))) { /* every reload */ }
    check('followed turn: its change is applied', p.useStore.getState().themeChoice === 'dark', `theme is ${p.useStore.getState().themeChoice}`);
    check('…once, though the history reload swapped the row for the stored one', p.themeWrites() === 1, `${p.themeWrites()} writes`);
    check('…and offers Undo', !!p.button(/^Undo/));
    p.close();
}
{
    // History alone is never fresh: an old answer only states what it did.
    const p = page();
    await p.mount();
    await p.answer(/\/ai\/conversations$/, json([conv(7, 'Colours')]));
    await p.answer(/\/ai\/conversations\/7\/messages$/, json([msg(41, 'user', 'make it dark'), msg(42, 'assistant', MARKED)]));
    check('an answer re-read from history changes nothing', p.useStore.getState().themeChoice === 'light' && p.themeWrites() === 0);
    p.close();
}

section('a conversation that fails to open is not where the next message goes');
{
    const p = page();
    await p.mount();
    await p.answer(/\/ai\/conversations$/, json([conv(7, 'Colours'), conv(8, 'Broken one')]));
    await p.answer(/\/ai\/conversations\/7\/messages$/, json([msg(41, 'user', 'hello'), msg(42, 'assistant', 'Hi there, colours it is.')]));
    await p.fire(p.button(/^Conversations$/), 'click');
    await p.answer(/\/ai\/conversations$/, json([conv(7, 'Colours'), conv(8, 'Broken one')]));
    await p.fire(p.button(/Broken one/), 'click');
    await p.answer(/\/ai\/conversations\/8\/messages$/, json({ error: 'database is locked' }, 500));
    check('the conversation on screen before is shown again', p.text().includes('Hi there, colours it is.'));
    await p.type('and now?');
    const sent = p.requests.find(q => /\/ai\/assistant\/stream$/.test(q.url));
    const target = sent ? JSON.parse(sent.body).conversationId : undefined;
    check('the next message goes to the conversation on screen, not the one that failed', target === 7, `sent to ${target}`);
    p.close();
}
{
    // Two opens, both failing, the second picked while the first still loads: nothing real
    // was on screen, so the panel is a new chat, not the first failed one under an empty view.
    const p = page();
    await p.mount();
    const list = [conv(7, 'Colours'), conv(8, 'Broken one'), conv(9, 'Broken two')];
    await p.answer(/\/ai\/conversations$/, json(list));
    await p.answer(/\/ai\/conversations\/7\/messages$/, json([msg(41, 'user', 'hello'), msg(42, 'assistant', 'Hi there, colours it is.')]));
    await p.fire(p.button(/^Conversations$/), 'click');
    await p.answer(/\/ai\/conversations$/, json(list));
    await p.fire(p.button(/Broken one/), 'click');
    await p.fire(p.button(/^Conversations$/), 'click');
    await p.answer(/\/ai\/conversations$/, json(list));
    await p.fire(p.button(/Broken two/), 'click');
    await p.answer(/\/ai\/conversations\/8\/messages$/, json({ error: 'database is locked' }, 500));
    await p.answer(/\/ai\/conversations\/9\/messages$/, json({ error: 'database is locked' }, 500));
    await p.type('and now?');
    const sent = p.requests.find(q => /\/ai\/assistant\/stream$/.test(q.url));
    const target = sent ? JSON.parse(sent.body).conversationId : undefined;
    check('two failed opens in a row: the next message starts a new chat', target === null, `sent to ${target}`);
    p.close();
}

section('a resize drag ends on pointercancel');
{
    const p = page();
    await p.mount();
    const grip = p.w.document.querySelector('[role="separator"]');
    await p.fire(grip, 'pointerdown', { clientX: 500 });
    await p.fire(p.w, 'pointermove', { clientX: 480 });
    const during = p.resizes.length;
    await p.fire(p.w, 'pointercancel', { clientX: 480 });
    await p.fire(p.w, 'pointermove', { clientX: 300 });
    check('the drag resizes while it lasts', during === 1, `${during} resizes`);
    check('after a cancel, moving the pointer resizes nothing', p.resizes.length === during, `${p.resizes.length - during} more`);
    p.close();
}

section('a file dropped during a turn is attached');
{
    const p = page();
    await p.mount();
    await p.answer(/\/ai\/conversations$/, json([]));
    await p.type('a long question');
    // The stream is never answered: the turn is still running.
    const aside = p.w.document.querySelector('aside');
    const file = new p.w.File(['some notes'], 'lecture-notes.txt', { type: 'text/plain' });
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' };
    await p.fire(aside, 'dragenter', { dataTransfer });
    check('the panel says a drop attaches', p.text().includes('Drop to attach'));
    await p.fire(aside, 'drop', { dataTransfer });
    check('the dropped file is in the composer', p.text().includes('lecture-notes.txt'));
    p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
