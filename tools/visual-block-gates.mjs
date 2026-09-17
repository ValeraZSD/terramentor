// tools/visual-block-gates.mjs — what the visual shell shows for a scene brief
// that has not been drawn.
//
// Run:  node tools/visual-block-gates.mjs
//
// Why this exists: a ```animation brief with no cached drawing threw a plain
// Error out of resolveVisualSpec, and VisualBlock drew it as the amber
// "Couldn't render this animation: … Use Fix with AI" card — over the NORMAL
// state of every brief while its reply is still streaming, and of every brief
// re-read from history. The learner read it as a failure, because it was
// styled as one. The state is `undrawn` now, with its own calm card, and this
// mounts the REAL component in jsdom (api/store/i18n stubbed) and asserts:
//   - live (the reply still streaming): "drawn once the reply finishes", NO
//     cache lookup (the words change with every token), no error card;
//   - settled with autoBuild off (history, feed): ONE cacheOnly lookup, a
//     "Draw it" button, still no error card;
//   - "Draw it" pressed: the authoring call is made WITHOUT cacheOnly — the
//     consent the whole state exists to collect;
//   - a real failure (the model unreachable) is still the error card.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const cache = join(root, 'node_modules', '.cache');
const scratch = mkdtempSync(join(cache, 'visual-block-gates-'));
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

// What the stubbed api records and answers with.
globalThis.__author = { calls: [], answer: null };

const stubs = {
    store: `export const useStore = (sel) => sel({ theme: 'light', accentColor: '#0e7490' });
            export const isDarkTheme = () => false;`,
    api: `export const api = {
            authorVisual: async (kind, brief, opts = {}) => {
                globalThis.__author.calls.push({ kind, brief, opts: { ...opts } });
                const a = globalThis.__author.answer;
                if (a instanceof Error) throw a;
                if (opts.cacheOnly) return { spec: '', cached: false };
                return { spec: a || '', cached: false };
            },
            repairVisual: async () => ({ code: '' }),
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
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        // Any relative depth, not just `../../`: what is being stubbed is the
        // api client, the store and the i18n runtime, and which file happens to
        // import one — and from how many directories down — is incidental. The
        // pinned depth silently stopped stubbing i18n the day a util two levels
        // up imported it, and the build failed rather than the test.
        b.onResolve({ filter: /(^|\/)(?:\.\.\/)+(api|store|i18n)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'stub' }));
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
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
    // Heavy renderer libraries (mermaid, vega, p5 …) are reached only through
    // a dynamic import the shell never takes here; leaving every package
    // external keeps the bundle to the app's own modules.
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
const settle = async (ms = 500) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const text = () => host.textContent.replace(/\s+/g, ' ').trim();
const button = (re) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent || ''));
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); };

const brief = 'Shows: how a query vector scores every key.\nDraw: a Query token and a row of Key tokens.\nMoves: the Query projects onto each Key.\nNotice: the longest projection wins.';
const base = { kind: 'animation', language: 'animation', code: brief, surface: 'assistant' };

console.log('\n--- a brief while the reply is still streaming ---');
{
    globalThis.__author.calls = [];
    const m = globalThis.__mount(host, { ...base, live: true, autoRepair: true, autoBuild: true });
    await settle(600);
    check('says the scene is described and drawn once the reply finishes', /drawn once the reply finishes/.test(text()), text());
    check('shows what the picture will be about', /how a query vector scores every key/.test(text()), text());
    check('is not an error card', !/Couldn't render|Fix with AI/.test(text()), text());
    check('looks nothing up while the words are still changing', globalThis.__author.calls.length === 0, `${globalThis.__author.calls.length} calls`);
    check('offers no Draw button yet', !button(/Draw it/));

    // The reply settles: the same block, live off. A fresh message (autoBuild
    // on) draws on its own — the stub answers a cache miss, then a spec.
    globalThis.__author.answer = '<svg viewBox="0 0 10 10"><circle r="1"><animate attributeName="r" values="1;2;1" dur="2s" repeatCount="indefinite"/></circle></svg>';
    m.render({ ...base, live: false, autoRepair: true, autoBuild: true });
    await settle(600);
    const calls = globalThis.__author.calls;
    check('settling looks the cache up once, then draws without asking', calls.length >= 2 && calls[0].opts.cacheOnly === true && calls[1].opts.cacheOnly !== true, JSON.stringify(calls.map(c => c.opts)));
    m.unmount();
}

console.log('\n--- a brief from history: an offer, not an error ---');
{
    globalThis.__author.calls = [];
    globalThis.__author.answer = '';
    const m = globalThis.__mount(host, { ...base, live: false, autoRepair: false, autoBuild: false });
    await settle(600);
    check('exactly one cache lookup, nothing built', globalThis.__author.calls.length === 1 && globalThis.__author.calls[0].opts.cacheOnly === true, JSON.stringify(globalThis.__author.calls.map(c => c.opts)));
    check('says it is described in words and not drawn yet', /Described in words, not drawn yet/.test(text()), text());
    check('is not an error card', !/Couldn't render|Fix with AI/.test(text()), text());
    const draw = button(/Draw it/);
    check('offers Draw it', !!draw);
    check('the toolbar still offers Source and Fix this', !!button(/Source/) && !!button(/Fix this/));
    globalThis.__author.answer = '<svg viewBox="0 0 10 10"><circle r="1"/></svg>';
    await click(draw);
    await settle(600);
    const after = globalThis.__author.calls.slice(1);
    check('pressing it is the consent: an authoring call WITHOUT cacheOnly', after.some(c => !c.opts.cacheOnly), JSON.stringify(after.map(c => c.opts)));
    m.unmount();
}

console.log('\n--- a real failure keeps the error card ---');
{
    globalThis.__author.calls = [];
    globalThis.__author.answer = new Error('No model selected — choose or install one in Settings → AI Connection');
    const m = globalThis.__mount(host, { ...base, live: false, autoRepair: false, autoBuild: true });
    await settle(600);
    check('the model being unreachable is reported as an error', /Couldn't render/.test(text()) && /No model selected/.test(text()), text());
    check('with Fix with AI on offer', !!button(/Fix with AI/));
    m.unmount();
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will */ }
console.log(`\nvisual-block gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
