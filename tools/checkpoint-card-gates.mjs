#!/usr/bin/env node
// checkpoint-card-gates.mjs — the chapter card says what the check proved.
//
// The "End of chapter" card is composed when the topic's last part is written,
// and its numbers are the topic's as it was then. It asked the server again
// after each answer saved in the topic, but never after the mastery check: the
// check is a modal, and passing it marks the card done, which also switched the
// refresh off. So a topic ended on
//
//     Estimated mastery 0%   ·   Topic completed
//
// right after a 4/4 check that had written 0.99 to the database. Mounted in
// jsdom from the real component, with the api answered by a stub:
//
//   1. a card nobody has answered on yet does not ask (no request per card);
//   2. a card marked done asks the server for its numbers again, shows them,
//      and still says "Topic completed".
//
//   node tools/checkpoint-card-gates.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'SVGSVGElement']) if (window[k]) globalThis[k] = window[k];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const consoleError = console.error;
console.error = (...a) => { if (!/not wrapped in act/.test(String(a[0]))) consoleError(...a); };

const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(cacheDir, 'checkpoint-card-gates-'));
const out = join(scratch, 'bundle.cjs');

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });
        export const initReactI18next = { type: '3rdParty', init() { } };`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: { feedSavedByNode: {}, masteryGate: { isOpen: false, nodeId: null }, addToast() { }, openMasteryGate() { }, skipNode: async () => true }, subs: new Set() };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;`,
    'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => (globalThis.__api?.[name] ?? (() => new Promise(() => { })))(...args) });`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
    },
};

let CheckpointCard = null;
try {
    await esbuild.build({
        stdin: { contents: `export { default as CheckpointCard } from './src/components/feed/CheckpointCard';`, resolveDir: root, loader: 'tsx' },
        bundle: true, format: 'cjs', platform: 'node', outfile: out,
        jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' }, packages: 'external',
        define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
        plugins: [stubPlugin], logLevel: 'silent',
    });
    ({ CheckpointCard } = require(out));
} catch (e) {
    console.log(`  (could not bundle the card: ${String(e.message).split('\n').slice(0, 3).join(' | ')})`);
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const h = React.createElement;
const act = (fn) => React.act(fn);
const settle = (ms = 30) => act(() => new Promise(r => setTimeout(r, ms)));

/** The card as the feed composed it before the check: one lesson question right, no evidence yet. */
const composed = {
    kind: 'checkpoint', key: 'checkpoint-63', nodeId: 63, nodeTitle: 'The function e to the minus one over x squared', projectId: 1,
    feedCorrect: 1, feedTotal: 1, masteryScore: 0, eligible: false, borrowedEstimate: false, borrowedFrom: null,
    gateMode: 'enforced', scheduledEnd: null, isOverdue: false, deadline: null,
};
/** What GET /api/feed/nodes/63/checkpoint answers after the 4/4 check (the take's database: 0.99). */
const afterCheck = { feedCorrect: 1, feedTotal: 1, masteryScore: 0.99, eligible: true, borrowedEstimate: false, borrowedFrom: null };
const masteryShown = (host) => host.textContent.match(/Estimated mastery\s*(\d+)%/)?.[1];

if (CheckpointCard) {
    const asked = [];
    globalThis.__api = { getCheckpointFacts: (id) => { asked.push(id); return Promise.resolve(afterCheck); } };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);

    await act(() => r.render(h(CheckpointCard, { card: composed, done: false, onDone() { } })));
    await settle();
    // A baseline, true before the fix as well: the card does not ask while
    // nothing has changed, so the request after `done` below is the fix's.
    ok('before the check: the composed number, and no request yet', masteryShown(host) === '0' && asked.length === 0,
        `shown ${masteryShown(host)}%, ${asked.length} request(s)`);

    // The check passed: MasteryGateModal's callback marks the card done.
    await act(() => r.render(h(CheckpointCard, { card: composed, done: true, onDone() { } })));
    await settle();
    ok('done: the card asked the server for its numbers again', asked.includes(63), `${asked.length} request(s)`);
    ok('…and shows the estimate the check left (99%), not the composed 0%', masteryShown(host) === '99', `shown ${masteryShown(host)}%: ${host.textContent.slice(0, 160)}`);
    // Context, true before the fix too: the screen the bug showed.
    ok('…beside "Topic completed"', host.textContent.includes('Topic completed'));

    await act(() => r.unmount());
    host.remove();
    globalThis.__api = undefined;
} else ok('the card bundles and mounts', false);

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
process.exit(fail ? 1 : 0);
