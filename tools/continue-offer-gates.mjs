#!/usr/bin/env node
/**
 * tools/continue-offer-gates.mjs — the course page's "Continue creating" card
 * keeps asking until it has a real answer, and shows what a run wrote.
 *
 *   node tools/continue-offer-gates.mjs
 *
 * The card (src/components/creation/ContinueCreationOffer.tsx) asks
 * GET /api/ai/continue-creation/:id whether the open course can be carried on.
 * Two answers are not final: a request that failed (the server restarting,
 * a dropped connection) and `running: true` (a run this page did not start,
 * or one winding down after Stop). Neither may leave the card hidden for good,
 * and a run the server saw end must reload the outline and the page, as one
 * this page watched does. What the server answers is creation-continue-gates.mjs.
 *
 * Mounts the real card in jsdom; only `../api`, the store and i18n are stubbed.
 * Real timers: the card waits 3 s between asks.
 */
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'SVGSVGElement']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k) => k, i18n: { language: 'en' } });`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s;`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: {}, subs: new Set() };
        g.__setState = (patch) => { g.__st.state = { ...g.__st.state, ...patch }; g.__st.subs.forEach(f => f()); };
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
        b.onResolve({ filter: /^(\.\.\/)+i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: repo }));
    },
};
const cacheDir = join(repo, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const out = join(mkdtempSync(join(cacheDir, 'continue-offer-gates-')), 'bundle.cjs');
await esbuild.build({
    stdin: {
        contents: `export { default as ContinueCreationCard } from './src/components/creation/ContinueCreationOffer.tsx';`,
        resolveDir: repo, loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out,
    jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
    packages: 'external',
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
    plugins: [stubPlugin], logLevel: 'silent',
});
const React = require('react');
const { createRoot } = require('react-dom/client');
const { ContinueCreationCard } = require(out);
const h = React.createElement;
const act = (fn) => React.act(fn);
const wait = (ms) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
// The card's own 3 s timers run for real; the checks wait for the state they
// expect (up to 10 s), never a fixed time, so a loaded machine cannot fail them.
const until = async (cond, ms = 10000) => {
    for (let t = 0; t < ms && !cond(); t += 100) await wait(100);
    return cond();
};

const PID = 7;
const loads = [];
globalThis.__setState({
    currentProjectId: PID,
    projects: [{ id: PID, name: 'Waves and Light', color: '#3b82f6' }],
    loadProjectData: async (id) => { loads.push(`outline ${id}`); },
    loadDashboard: async (id) => { loads.push(`dashboard ${id}`); },
});

/** Mount the card; `answers` are what the server says, one per ask, in order
 *  (an Error = a failed request; the last one repeats). */
async function mount(answers) {
    let asks = 0;
    globalThis.__api = {
        getContinueCreation: async () => {
            const a = answers[Math.min(asks++, answers.length - 1)];
            if (a instanceof Error) throw a;
            return a;
        },
    };
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(h(ContinueCreationCard, { projectId: PID })));
    await wait(50);
    return {
        shown: () => host.textContent.includes('Continue creating'),
        asks: () => asks,
        done: () => { act(() => root.unmount()); host.remove(); },
    };
}

console.log('--- the card asks again until it has an answer ---');
{
    const m = await mount([{ canContinue: true, running: false }]);
    check('a course that can go on shows the card', m.shown());
    m.done();
}
{
    const m = await mount([new Error('connection reset'), { canContinue: true, running: false }]);
    check('while the first request has failed, no card yet', !m.shown());
    await until(() => m.shown());
    check('a failed request is asked again, and the card comes', m.shown() && m.asks() === 2, `asks ${m.asks()}, shown ${m.shown()}`);
    m.done();
}
{
    const m = await mount([{ canContinue: false, running: false }]);
    await wait(4000);   // past the card's 3 s timer: a second ask would have happened by now
    check('a settled "no" is not asked again', !m.shown() && m.asks() === 1, `asks ${m.asks()}`);
    m.done();
}

console.log('--- a run this page did not start ---');
{
    loads.length = 0;
    const m = await mount([{ canContinue: false, running: true }, { canContinue: false, running: false }]);
    check('while the server reports a run, no card and nothing reloaded', !m.shown() && loads.length === 0, JSON.stringify(loads));
    await until(() => loads.length >= 2);
    await wait(200);   // a second reload, if one were coming, lands here
    check('when it ends, the outline and the course page reload, once each',
        m.asks() === 2 && loads.filter(l => l === `outline ${PID}`).length === 1 && loads.filter(l => l === `dashboard ${PID}`).length === 1,
        `asks ${m.asks()}, ${JSON.stringify(loads)}`);
    m.done();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
