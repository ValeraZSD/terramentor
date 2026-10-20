// tools/visual-sync-gates.mjs — a visual built, failed or repaired on ONE device
// reaches every other device showing it, with no reload.
//
// Run:  node tools/visual-sync-gates.mjs
//
// The fault: ask the assistant on the phone for a visual. The answer streams to
// the PC as well (it follows the turn's task), the reply settles, and the PC's
// block makes its one cache lookup — before the phone has even sent its build
// request. The lookup misses, the PC draws "not built yet", and nothing ever
// asks again: the finished drawing reached the PC only on a page reload. The
// same silence followed a build that FAILED on the phone (the PC kept offering a
// fresh build of something already known to fail) and a repair the phone wrote
// back into the message (the PC kept the broken spec).
//
// What is asserted:
//   - the server names each build's key (widget:<hash> / visual:<hash>) on the
//     build endpoints' answers and on the task list, and on nothing else;
//   - a block left undrawn, or showing a build it JOINED that failed, re-checks
//     when the task list shows a build of its key start, finish or fail — once
//     per change, with a lookup that never starts a build of its own;
//   - an edited chat message is announced on the task feed, and the assistant
//     reloads the conversation it shows when it is told.
//
// The client half mounts the REAL VisualBlock in jsdom (api/store/i18n stubbed,
// the store a live one the test can push task lists into). Deterministic: no
// model, no network, a scratch database for the server half.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
// Every stored and listed instant is this one: no assertion may read the clock.
const AT = '2026-01-01T00:00:00.000Z';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

// ---- server: which build is which ---------------------------------------------

const dbScratch = mkdtempSync(join(tmpdir(), 'visual-sync-gates-'));
process.env.DB_PATH = join(dbScratch, 'gate.db');
process.env.VAULT_ROOT = join(dbScratch, 'vault');

console.log('\n--- the task list names a build by its key, and nothing else by anything ---');
{
    const tasks = await import(new URL('../server/tasks.js', import.meta.url).href);
    const hold = () => new Promise(() => { });
    tasks.createTask({ kind: 'widget', label: 'w', dedupeKey: 'widget:abc', run: hold });
    tasks.createTask({ kind: 'visual', label: 'v', dedupeKey: 'visual:def', run: hold });
    tasks.createTask({ kind: 'visual', label: 'r', dedupeKey: 'visual-repair:123', run: hold });
    tasks.createTask({ kind: 'today_chat', label: 'c', dedupeKey: 'chat:secret', run: hold });
    const list = tasks.listTasks();
    const key = (label) => list.find(t => t.label === label)?.buildKey;
    // The two null checks ask for the field ITSELF: before this change a summary
    // had no buildKey at all, and `== null` would have passed on it.
    const has = (label) => 'buildKey' in (list.find(t => t.label === label) || {});
    check('a widget build carries its key', key('w') === 'widget:abc', JSON.stringify(key('w')));
    check('an authored drawing carries its key', key('v') === 'visual:def', JSON.stringify(key('v')));
    check('a repair is not a build of the spec: no key', has('r') && key('r') === null, JSON.stringify(key('r')));
    check('any other task\'s dedupe key stays on the server', has('c') && key('c') === null, JSON.stringify(key('c')));
    for (const t of list) tasks.cancelTask(t.id);
}

console.log('\n--- the build endpoints say which build they answered for ---');
{
    const visuals = read('server/routes/visuals.js');
    const front = visuals.slice(visuals.indexOf('function answerBuildRequest'), visuals.indexOf('function trackedBuild'));
    check('every answer of the shared front carries the key as a header, before anything is written',
        /res\.setHeader\('X-Build-Key', dedupeKey\)/.test(front)
        && front.indexOf("setHeader('X-Build-Key'") < front.indexOf('if (force) return false'), front.slice(0, 400));
    const api = read('src/api.ts');
    const fn = (name) => api.slice(api.indexOf(`${name}: async (`), api.indexOf('\n    },', api.indexOf(`${name}: async (`)));
    for (const name of ['compileWidget', 'authorVisual']) {
        check(`${name} hands the key to its listener first`, /response\.headers\.get\('X-Build-Key'\)/.test(fn(name)) && /onEvent\?\.\(\{ buildKey \}\)/.test(fn(name)));
    }
}

console.log('\n--- an edited chat message is announced on the feed every device follows ---');
{
    const events = await import(new URL('../server/chatEvents.js', import.meta.url).href);
    const seen = [];
    const off = events.onChatChanged(e => seen.push(e));
    events.notifyChatChanged(42);
    off();
    events.notifyChatChanged(43);
    check('a listener hears the conversation that changed', JSON.stringify(seen) === JSON.stringify([{ conversationId: 42, from: null }]), JSON.stringify(seen));

    // The REAL routes on the scratch library: a PUT, heard on /api/tasks/stream.
    const { default: db } = await import('../server/database.js');
    if (!/visual-sync-gates-/.test(process.env.DB_PATH)) throw new Error('refusing to write to a library that is not the scratch one');
    const now = AT;
    const conv = Number(db.prepare('INSERT INTO chat_conversations (title, created_at, updated_at) VALUES (?, ?, ?)').run('c', now, now).lastInsertRowid);
    const msg = Number(db.prepare("INSERT INTO chat_messages (role, content, conversation_id, created_at) VALUES ('assistant', 'old', ?, ?)").run(conv, now).lastInsertRowid);
    const { createServer } = await import('node:http');
    const { createApp } = await import('../server/app.js');
    const server = createServer(createApp());
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const feedAbort = new AbortController();
    const heard = [];
    const feedRes = await fetch(`${base}/api/tasks/stream`, { signal: feedAbort.signal });
    const reading = (async () => {
        const reader = feedRes.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const l of lines) {
                    if (!l.startsWith('data: ')) continue;
                    try { const j = JSON.parse(l.slice(6)); if (j.chatChanged) heard.push(j.chatChanged); } catch { /* keepalive */ }
                }
            }
        } catch { /* aborted */ }
    })();
    const put = (id, body) => fetch(`${base}/api/ai/chat/message/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const quiet = () => new Promise(r => setTimeout(r, 150));
    await quiet();
    const r1 = await put(msg, { content: 'repaired', from: 'abcdef0123456789' });
    await quiet();
    check('a saved edit is written and announced on the task feed, naming the window that wrote it',
        r1.status === 200 && db.prepare('SELECT content FROM chat_messages WHERE id = ?').get(msg)?.content === 'repaired'
        && JSON.stringify(heard) === JSON.stringify([{ conversationId: conv, from: 'abcdef0123456789' }]), `${r1.status} ${JSON.stringify(heard)}`);
    heard.length = 0;
    await put(msg, { content: 'again', from: 'not an id<script>' });
    await quiet();
    check('a "from" that is not a window id is not passed on', JSON.stringify(heard) === JSON.stringify([{ conversationId: conv, from: null }]), JSON.stringify(heard));
    heard.length = 0;
    const r404 = await put(msg + 999, { content: 'x' });
    const r400 = await put(msg, { content: '  ' });
    await quiet();
    check('an unknown message is a 404 and an empty one a 400, and neither is announced', r404.status === 404 && r400.status === 400 && heard.length === 0, `${r404.status} ${r400.status} ${JSON.stringify(heard)}`);
    feedAbort.abort();
    await reading;
    await new Promise(r => server.close(r));
    const feed = read('server/routes/tasks.js');
    const stream = feed.slice(feed.indexOf("app.get('/api/tasks/stream'"), feed.indexOf('\n});', feed.indexOf("app.get('/api/tasks/stream'")));
    check('the task feed lets go of its listener when the socket closes', /unsubChat\(\)/.test(stream), stream);

    const apiSrc = read('src/api.ts');
    check('the client reads it off the feed', /json\.chatChanged/.test(apiSrc));
    check('the client names itself when it writes a message back', /body: JSON\.stringify\(\{ content, from: WINDOW_ID \}\)/.test(apiSrc));
    check('the window that wrote it skips its own echo', /change\.from !== WINDOW_ID\) onChat\?\./.test(apiSrc));
    const drawer = read('src/components/AssistantDrawer.tsx');
    check('the assistant reloads the conversation it shows when told it changed',
        /useStore\(s => s\.chatChange\)/.test(drawer) && /chatChange\.at\[shown\] \?\? 0\) <= since/.test(drawer));
    // A turn's own reload and a reload for a change heard on the feed can
    // overlap and answer out of order: the older answer is not applied.
    check('an older load of the conversation never replaces a newer one',
        /const seq = \+\+loadSeqRef\.current;/.test(drawer) && /if \(seq < shownLoadRef\.current\) return messagesRef\.current;\s+shownLoadRef\.current = seq;\s+const traces/.test(drawer));
    // A failed turn asks the answer whether its question is still there; an
    // older snapshot can say no while the screen says yes, and it is put twice.
    check('an older load answers with the rows on screen, not its own snapshot',
        !/seq < shownLoadRef\.current\) return rows;/.test(drawer) && /messagesRef\.current = rows;\s+setMessages\(rows\);/.test(drawer));
    // A load in flight when Send is pressed read the conversation before the
    // question: applied, it takes the question off the screen, and the
    // answer's own path only appends. Outdated, then read again after.
    check('a send outdates the loads in flight and reads the conversation again after',
        /const outdated = loadsInFlightRef\.current > 0;\s+shownLoadRef\.current = \+\+loadSeqRef\.current;\s+setMessages\(prev => \[\.\.\.prev, \{\s+id: userId/.test(drawer)
        && /if \(outdated && !dropped\) loadHistory\(\)/.test(drawer)
        && /loadsInFlightRef\.current\+\+;\s+try \{\s+rows = await api\.getConversationMessages\(id\);[\s\S]{0,300}?finally \{\s+loadsInFlightRef\.current--;/.test(drawer));
    // A reload for a change that failed must not mark the change read.
    check('a failed reload for a change leaves it unread',
        /chatChange\.at\[shown\] \?\? 0\) <= since\) return;\s+loadHistory\(\)\.catch\(\(\) => \{\s+handledChatChangeRef\.current = Math\.min\(handledChatChangeRef\.current, since\);/.test(drawer));
    // Several changes heard while the panel waited, the LAST about another
    // conversation: the earlier one about the shown conversation still counts.
    const storeSrc = read('src/store.ts');
    check('a change to the shown conversation survives a later change to another',
        /at: \{ \.\.\.s\.chatChange\?\.at, \[conversationId\]: n \}/.test(storeSrc));
}

// ---- client: the real VisualBlock against a live task list --------------------

const cache = join(root, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'visual-sync-gates-'));
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
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;
globalThis.NodeFilter = window.NodeFilter;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
globalThis.ResizeObserver = window.ResizeObserver;
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });

// Every call the stubbed api receives, and what the next lookup answers. A
// lookup answer is an object (returned), an Error (thrown) or 'join' (the
// server attached it to a running build: progress, then whatever
// `__author.joined` resolves with).
globalThis.__author = { calls: [], lookup: { spec: '', cached: false }, build: { spec: '', cached: false }, key: 'visual:k1' };
globalThis.__widget = { calls: [], lookup: { html: '', cached: false }, key: 'widget:w1' };

const stubs = {
    store: `import * as React from 'react';
            let state = { theme: 'light', themeTint: '#ffffff', accentColor: '#0e7490', aiTasks: [] };
            const subs = new Set();
            export const useStore = (sel) => React.useSyncExternalStore(
                (cb) => { subs.add(cb); return () => subs.delete(cb); },
                () => sel(state));
            useStore.getState = () => state;
            useStore.setState = (patch) => { state = { ...state, ...patch }; for (const f of subs) f(); };
            globalThis.__store = useStore;
            export const isDarkTheme = () => false;
            export const themeKeyOf = (theme, tint) => theme + ':' + tint;`,
    api: `export const api = {
            authorVisual: async (kind, brief, opts = {}, onEvent, signal) => {
                globalThis.__author.calls.push({ kind, brief, opts: { ...opts } });
                onEvent?.({ buildKey: globalThis.__author.key });
                const a = opts.cacheOnly ? globalThis.__author.lookup : globalThis.__author.build;
                if (a instanceof Error) throw a;
                if (a === 'join') {
                    onEvent?.({ status: 'running' });
                    return new Promise((res, rej) => {
                        globalThis.__author.finishJoin = res;
                        globalThis.__author.failJoin = rej;
                        signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
                    });
                }
                return a;
            },
            compileWidget: async (spec, opts = {}, onEvent, signal) => {
                globalThis.__widget.calls.push({ spec, opts: { ...opts } });
                onEvent?.({ buildKey: globalThis.__widget.key });
                if (opts.cacheOnly) return globalThis.__widget.lookup;
                return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
            },
            reportVisualBuildFailure: async () => ({ recorded: true }),
            repairVisual: async () => new Promise(() => {}),
            reportVisual: async () => ({ id: null }),
            cancelTask: async () => ({}),
          };`,
    i18n: `const t = (k, o = {}) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o[n] ?? ''));
           export const k = (s) => s;
           export const setUiLanguage = async () => {};
           export const i18nReady = Promise.resolve();
           export const currentLocale = () => 'en-GB';
           export default { t };`,
    renderAnimation: `import { resolveVisualSpec } from './src/components/visuals/resolveBrief';
           export default async (el, code, ctx) => {
               const spec = await resolveVisualSpec('animation', code, ctx);
               if (spec.trim() !== code.trim()) ctx.onResolved?.(spec);
               el.innerHTML = spec;
           };`,
    'react-i18next': `const t =(k, o = {}) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o[n] ?? ''));
           export const useTranslation = () => ({ t });`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /(^|\/)(?:\.\.\/)+(api|store|i18n)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'stub' }));
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        // jsdom cannot lay out an SVG, so the animation renderer's PAINT step is
        // replaced; the brief still goes through the real resolveVisualSpec.
        b.onResolve({ filter: /^\.\/renderAnimation$/ }, () => ({ path: 'renderAnimation', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
    },
};

await esbuild.build({
    stdin: {
        contents: `
            import * as React from 'react';
            import { createRoot } from 'react-dom/client';
            import VisualBlock from './src/components/visuals/VisualBlock';
            const act = React.act;
            globalThis.__act = (fn) => act(fn);
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
const settle = async (ms = 500) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const text = () => host.textContent.replace(/\s+/g, ' ').trim();
const button = (re) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent || ''));
const tasksNow = (list) => act(() => { globalThis.__store.setState({ aiTasks: list }); });
const task = (id, buildKey, status, kind = 'visual') => ({ id, kind, buildKey, status, createdAt: AT, progress: {}, meta: null });
const opts = (calls) => JSON.stringify(calls.map(c => c.opts));
const built = (calls) => calls.filter(c => !c.opts.cacheOnly);
const drawn = () => !!host.querySelector('svg[viewBox="0 0 10 10"]');

const brief = 'Shows: how a query vector scores every key.\nDraw: a Query token and a row of Key tokens.\nMoves: the Query projects onto each Key.\nNotice: the longest projection wins.';
const svg = '<svg viewBox="0 0 10 10"><circle r="1"><animate attributeName="r" values="1;2;1" dur="2s" repeatCount="indefinite"/></circle></svg>';
// The PC: a reply it followed but did not ask for. No consent to build.
const pc = { kind: 'animation', language: 'animation', code: brief, surface: 'assistant', live: false, autoRepair: false, autoBuild: false };

console.log('\n--- the PC looked too early: the phone\'s build starts, then finishes ---');
{
    globalThis.__author = { ...globalThis.__author, calls: [], lookup: { spec: '', cached: false }, key: 'visual:k1' };
    await tasksNow([]);
    const m = globalThis.__mount(host, pc);
    await settle();
    check('the first lookup missed: an offer, one call', /Described in words, not drawn yet/.test(text()) && globalThis.__author.calls.length === 1, text());

    // The phone's build request lands: the task list shows it queued.
    globalThis.__author.lookup = 'join';
    await tasksNow([task('t1', 'visual:k1', 'queued')]);
    await settle();
    check('the build starting elsewhere makes the block look again', globalThis.__author.calls.length === 2, opts(globalThis.__author.calls));
    check('…with a lookup, which joins and never starts a build', globalThis.__author.calls[1]?.opts.cacheOnly === true && built(globalThis.__author.calls).length === 0, opts(globalThis.__author.calls));
    check('…and the offer gives way to the build\'s progress', !button(/Draw it/) && /Drawing/.test(text()), text());

    // Snapshots keep coming while it runs (progress, other tasks); the
    // block is already following it.
    await tasksNow([task('t1', 'visual:k1', 'running')]);
    await settle();
    check('a block following the build is not sent to look again', globalThis.__author.calls.length === 2, opts(globalThis.__author.calls));

    await act(async () => { globalThis.__author.finishJoin({ spec: svg, cached: false }); });
    await settle();
    check('the finished drawing is shown, with no reload', drawn() && !/not drawn yet/.test(text()) && !button(/Draw it/) && !/Couldn't render/.test(text()), text());
    m.unmount();
}

console.log('\n--- the build finished before the PC heard it had started ---');
{
    globalThis.__author = { ...globalThis.__author, calls: [], lookup: { spec: '', cached: false }, key: 'visual:k2' };
    await tasksNow([]);
    const m = globalThis.__mount(host, pc);
    await settle();
    globalThis.__author.lookup = { spec: svg, cached: true };
    await tasksNow([task('t2', 'visual:k2', 'done')]);
    await settle();
    check('a finished build of this key: one more lookup, answered from the cache', globalThis.__author.calls.length === 2 && globalThis.__author.calls[1].opts.cacheOnly === true, opts(globalThis.__author.calls));
    check('…and the drawing replaces the offer', drawn() && !button(/Draw it/) && !/not drawn yet/.test(text()), text());
    m.unmount();
}

console.log('\n--- the build failed on the phone ---');
{
    globalThis.__author = { ...globalThis.__author, calls: [], lookup: { spec: '', cached: false }, key: 'visual:k3' };
    await tasksNow([]);
    const m = globalThis.__mount(host, pc);
    await settle();
    globalThis.__author.lookup = { spec: '', cached: false, lastError: 'the drawing has no <svg> root' };
    await tasksNow([task('t3', 'visual:k3', 'error')]);
    await settle();
    check('the offer now says how it failed', /Its last build failed: the drawing has no <svg> root/.test(text()), text());
    check('…offers Try again, and built nothing itself', !!button(/Try again/) && built(globalThis.__author.calls).length === 0, opts(globalThis.__author.calls));

    // The same list again, and lists about OTHER builds: nothing to look at.
    // A regression guard only: the pre-fix block never sent a second lookup
    // for anything, so this passes on it too.
    const before = globalThis.__author.calls.length;
    await tasksNow([task('t3', 'visual:k3', 'error')]);
    await tasksNow([task('t3', 'visual:k3', 'error'), task('x', 'visual:other', 'running'), task('y', 'widget:other', 'done', 'widget')]);
    await settle();
    check('an unchanged task, or someone else\'s build, sends no lookup', globalThis.__author.calls.length === before, `${globalThis.__author.calls.length - before} extra`);

    // Retried on the phone (Try again there), and it worked.
    globalThis.__author.lookup = { spec: svg, cached: true };
    await tasksNow([task('t3', 'visual:k3', 'error'), task('t4', 'visual:k3', 'done')]);
    await settle();
    check('a retry that succeeded elsewhere replaces the failure here', drawn() && !/last build failed/.test(text()) && !button(/Try again/), text());
    m.unmount();
}

console.log('\n--- the PC joined the build and saw it fail; the phone tries again ---');
{
    globalThis.__author = { ...globalThis.__author, calls: [], lookup: 'join', key: 'visual:k5' };
    await tasksNow([task('t5', 'visual:k5', 'running')]);
    const m = globalThis.__mount(host, pc);
    await settle();
    await act(async () => { globalThis.__author.failJoin(new Error('the model returned no drawing')); });
    await settle();
    check('the joined failure shows as the error card', /Couldn't render/.test(text()), text());
    globalThis.__author.lookup = { spec: svg, cached: true };
    await tasksNow([task('t5', 'visual:k5', 'error'), task('t6', 'visual:k5', 'done')]);
    await settle();
    check('the build that succeeded elsewhere replaces the error card', drawn() && !/Couldn't render/.test(text()), text());
    check('…with lookups only', built(globalThis.__author.calls).length === 0, opts(globalThis.__author.calls));
    m.unmount();
}

console.log('\n--- the device that asked: a watched change never spends a model call ---');
{
    // A fresh answer (autoBuild on) whose unasked build the server declined.
    globalThis.__author = { ...globalThis.__author, calls: [], lookup: { spec: '', cached: false }, build: { spec: '', cached: false, declined: 'failed', lastError: 'no svg' }, key: 'visual:k7' };
    await tasksNow([]);
    const m = globalThis.__mount(host, { ...pc, autoRepair: true, autoBuild: true });
    await settle();
    const builds = built(globalThis.__author.calls).length;
    check('declined: the offer, after one unasked request', builds === 1 && /last build failed/.test(text()), `${builds} builds; ${text()}`);
    await tasksNow([task('t7', 'visual:k7', 'error')]);
    await settle();
    check('a task changing re-checks with a lookup, not a second build', built(globalThis.__author.calls).length === builds && globalThis.__author.calls.at(-1)?.opts.cacheOnly === true, opts(globalThis.__author.calls));
    // The theme turns while that lookup's renderer is still loading: the
    // render is cancelled and a new one starts, and it must still only look.
    const beforeTheme = globalThis.__author.calls.length;
    act(() => { globalThis.__store.setState({ aiTasks: [task('t7', 'visual:k7', 'error'), task('t7b', 'visual:k7', 'running')] }); });
    act(() => { globalThis.__store.setState({ theme: 'dark' }); });
    await settle();
    const afterTheme = globalThis.__author.calls.slice(beforeTheme);
    check('a lookup cancelled by a theme change is replaced by a lookup, not a build',
        built(globalThis.__author.calls).length === builds && afterTheme.length >= 1 && afterTheme.every(c => c.opts.cacheOnly === true),
        opts(globalThis.__author.calls));
    await act(() => { globalThis.__store.setState({ theme: 'light' }); });
    // The look a task change starts loses its connection, and the page comes
    // back online: the render it resumes must still only look.
    const beforeDrop = built(globalThis.__author.calls).length;
    globalThis.__author.lookup = new TypeError('Failed to fetch');
    await tasksNow([task('t7', 'visual:k7', 'error'), task('t7b', 'visual:k7', 'error')]);
    await settle();
    check('a lookup that lost its connection says so, and built nothing',
        /connection dropped/.test(text()) && built(globalThis.__author.calls).length === beforeDrop && globalThis.__author.calls.at(-1)?.opts.cacheOnly === true,
        `${opts(globalThis.__author.calls)}; ${text()}`);
    // The resumed lookup MISSES: this block's own consent (autoBuild) is still
    // on, so only the lookup-only flag stands between the miss and a build.
    const beforeResume = globalThis.__author.calls.length;
    globalThis.__author.lookup = { spec: '', cached: false };
    globalThis.__author.build = { spec: svg, cached: false };
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event('online')); });
    await settle();
    const resumed = globalThis.__author.calls.slice(beforeResume);
    check('the page coming back resumes it as a lookup, never a build',
        resumed.length >= 1 && resumed.every(c => c.opts.cacheOnly === true) && !drawn(),
        `${opts(resumed)}; ${text()}`);
    m.unmount();
}

console.log('\n--- a widget, on the same terms ---');
{
    globalThis.__widget = { ...globalThis.__widget, calls: [], lookup: { html: '', cached: false }, key: 'widget:w1' };
    await tasksNow([]);
    const spec = 'Title: Wavefront crowding\nObjective: Show that crowded fronts ahead of a moving source are the Doppler shift.\nInputs: source speed u (0–300 m/s).\nBehavior: fronts are emitted every period and expand at v; the spacing ahead is (v − u)/f.';
    const m = globalThis.__mount(host, { ...pc, kind: 'widget', language: 'widget', code: spec });
    await settle();
    check('not built yet: one lookup', globalThis.__widget.calls.length === 1 && !!button(/Build widget/), text());
    globalThis.__widget.lookup = { html: '', cached: false, lastError: 'the build is not an HTML document' };
    await tasksNow([task('w', 'widget:w1', 'error', 'widget')]);
    await settle();
    check('a widget build failing elsewhere is looked up again', globalThis.__widget.calls.length === 2 && globalThis.__widget.calls[1].opts.cacheOnly === true, opts(globalThis.__widget.calls));
    check('…and the offer names the failure', /Its last build failed: the build is not an HTML document/.test(text()), text());
    m.unmount();
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will */ }
try { rmSync(dbScratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
console.log(`\nvisual-sync gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
