// tools/short-transcript-gates.mjs — a pasted transcript's read, cancelled.
//
// Run:  node tools/short-transcript-gates.mjs               (the working tree)
//       node tools/short-transcript-gates.mjs --base <rev>  (ShortCourses.tsx as it is at <rev>,
//                                                          e.g. b08d0c6, before the transcript read
//                                                          had a controller, to watch it fail)
//
// WHY. A video the app cannot read asks for its transcript. Pressing Create
// sends the pasted text to be read; pressing Cancel while that read is out
// empties the box. The read had no controller, so its answer still arrived
// and drew over whatever the box held by then: a second link, a second paste,
// a different video's result. The read now owns the box's controller like
// every other read, so Cancel or a newer read drops it.
//
// The REAL ProjectsGrid and ShortCourses are bundled into jsdom; `fetch`
// answers the reads from a script the case controls, and the first transcript
// read is held open until the case lets it answer, after the second has
// started. Deterministic: no model, no network, no database, no clock.
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

const baseFiles = {
    name: 'base-files',
    setup(build) {
        if (!BASE) return;
        build.onLoad({ filter: /[\\/]src[\\/]components[\\/]shortCourses[\\/]ShortCourses\.tsx$/ }, () => ({
            contents: execFileSync('git', ['show', `${BASE}:src/components/shortCourses/ShortCourses.tsx`], { cwd: root, encoding: 'utf8' }),
            loader: 'tsx',
        }));
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import ProjectsGrid from './src/components/ProjectsGrid';
            import { createElement as h, act } from 'react';
            import { createRoot } from 'react-dom/client';
            import { MemoryRouter } from 'react-router-dom';
            const mount = (el) => {
                const r = createRoot(el);
                act(() => r.render(h(MemoryRouter, { initialEntries: ['/projects'] }, h(ProjectsGrid))));
                return r;
            };
            window.__gate = { useStore, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl' },
    plugins: [baseFiles],
})).outputFiles[0].text;

const LIB = [{
    id: 1, name: 'Organic chemistry', color: '#8B5CF6', icon: 'book', status: 'active', position: 1,
    topic_count: 6, completed_topic_count: 2, progress: 0.3, card_count: 0,
    last_done_at: null, updated_at: '2026-10-01T10:00:00.000Z',
}];
const LINK_A = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
const LINK_B = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';
// The link read: the video's captions could not be read, paste the transcript.
const cannotRead = (url) => ({ ok: false, reason: 'token_wall', fix: 'transcript', title: url === LINK_A ? 'First video' : 'Second video', url, host: 'youtube.com' });
// A transcript read's answer: too little for a course, with a count no paste in this file has.
const tooSmall = (words, stagedId) => ({
    ok: true, stagedId, kind: 'video', title: 'x', url: null, host: 'youtube.com', file: null, words, pages: null,
    minutes: null, captions: null, short: false, size: 'too-small', topics: 0, ai: true, minWords: 250,
});

const settle = async (act) => { await act(async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); }); };

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
w.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
w.IntersectionObserver = class { observe() { } unobserve() { } disconnect() { } };
w.IS_REACT_ACT_ENVIRONMENT = true;
w.MessageChannel = MessageChannel;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const held = [];      // transcript reads, in the order they were sent: { body, answer(result) }
const discarded = []; // staged ids the page let go
w.fetch = (url, init = {}) => {
    const u = String(url);
    if (/\/api\/projects(\?|$)/.test(u)) return Promise.resolve(json(LIB));
    if (/\/api\/short-courses(\?|$)/.test(u)) return Promise.resolve(json({ courses: [] }));
    const del = u.match(/\/api\/short-courses\/read\/([^/?]+)/);
    if (del && init.method === 'DELETE') { discarded.push(decodeURIComponent(del[1])); return Promise.resolve(json({ ok: true })); }
    if (/\/api\/short-courses\/read(\?|$)/.test(u)) {
        const body = JSON.parse(String(init.body || '{}'));
        if (!body.transcript) return Promise.resolve(json(cannotRead(body.url)));
        // Held until the case answers it, the way a slow server answers. As a
        // real fetch does, a read sent with a signal fails once that signal is
        // aborted; a read sent without one runs on and answers late.
        return new Promise((done, failed) => {
            held.push({ body, answer: (r) => done(json(r)) });
            const signal = init.signal;
            if (signal) {
                const stop = () => failed(new w.DOMException('The operation was aborted.', 'AbortError'));
                if (signal.aborted) stop(); else signal.addEventListener('abort', stop);
            }
        });
    }
    return new Promise(() => { });
};
w.eval(bundle);
const { useStore, mount, act } = w.__gate;
useStore.setState({ projects: LIB, _navigate: () => { } });
const el = w.document.getElementById('root');
let r;
await act(async () => { r = mount(el); });
await settle(act);

const box = () => el.querySelector('[data-short="source"]');
const button = (name) => [...(box()?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === name || b.getAttribute('aria-label') === name);
const press = async (name) => {
    const b = button(name);
    if (!b) throw new Error(`no "${name}" button in the box: ${box()?.textContent}`);
    await act(async () => { b.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); });
    await settle(act);
};
const fill = async (node, value) => {
    const proto = node.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value); node.dispatchEvent(new w.Event('input', { bubbles: true })); });
    await settle(act);
};
const pasteFor = async (link, text) => {
    await fill(box().querySelector('input[type="text"]'), link);
    await press('Read');
    await press('Paste the transcript');
    await fill(box().querySelector('textarea'), text);
    await press('Create short course');
};

let crashed = null;
try {
    await pasteFor(LINK_A, 'First paste.');
    check('the first transcript read is out', held.length === 1 && held[0].body.transcript === 'First paste.', JSON.stringify(held.map(h => h.body)));
    await press('Cancel');
    check('Cancel empties the box', !box()?.querySelector('textarea') && !!box()?.querySelector('input[type="text"]'), box()?.textContent);
    await pasteFor(LINK_B, 'Second paste.');
    check('a second transcript read is out', held.length === 2 && held[1].body.transcript === 'Second paste.');

    // The first read answers now, after Cancel and after the second read began.
    await act(async () => { held[0].answer(tooSmall(111, 'staged-first')); });
    await settle(act);
    const ta = box()?.querySelector('textarea');
    check('the late answer of the cancelled read changes nothing: the second paste is still in its box',
        !!ta && ta.value === 'Second paste.' && !box().textContent.includes('111'), box()?.textContent);

    // The second read answers: it is the one the box shows.
    await act(async () => { held[1].answer(tooSmall(222, 'staged-second')); });
    await settle(act);
    check('the second read\'s answer is the one drawn', box()?.textContent.includes('222') && box().querySelector('textarea')?.value === 'Second paste.', box()?.textContent);
    check('the second read, too small, is let go', discarded.includes('staged-second'), JSON.stringify(discarded));
} catch (e) {
    crashed = e;
    check('the case ran to its end', false, e.message);
}
act(() => r.unmount());
w.close();

console.log(`\n${pass} passed, ${fail} failed${BASE ? ` (ShortCourses.tsx at ${BASE})` : ''}`);
process.exit(fail || crashed ? 1 : 0);
