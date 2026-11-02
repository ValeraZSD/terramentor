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

// jsdom lays nothing out, so the two widths the toolbar folds on are set here:
// the block's own (`clientWidth` of `.visual-block`) and the toolbar row's
// natural width (the bounding box of its hidden measure). 0 is "not measured".
// A resize is announced with window's `resize`, which the block listens to.
globalThis.__widths = { block: 0, row: 0 };
const clientWidth = Object.getOwnPropertyDescriptor(window.Element.prototype, 'clientWidth');
Object.defineProperty(window.Element.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.classList?.contains('visual-block') ? globalThis.__widths.block : clientWidth.get.call(this); },
});
const boundingRect = window.Element.prototype.getBoundingClientRect;
window.Element.prototype.getBoundingClientRect = function () {
    if (!this.hasAttribute?.('data-toolbar-measure')) return boundingRect.call(this);
    const w = globalThis.__widths.row;
    return { x: 0, y: 0, left: 0, top: 0, width: w, right: w, height: 32, bottom: 32, toJSON() { return this; } };
};

// What the stubbed api records and answers with.
globalThis.__author = { calls: [], answer: null };
// The widget compiler: `lookup` answers a cacheOnly request, `build` any other
// ('pending' streams progress and never finishes, which is the state the
// screenshot caught; an object is returned as the server's answer).
globalThis.__widget = { calls: [], lookup: { html: '', cached: false }, build: 'pending' };

const stubs = {
    store: `export const useStore = (sel) => sel({ theme: 'light', themeTint: '#ffffff', accentColor: '#0e7490' });
            export const isDarkTheme = () => false;
            export const themeKeyOf = (theme, tint) => theme + ':' + tint;`,
    api: `export const api = {
            authorVisual: async (kind, brief, opts = {}) => {
                globalThis.__author.calls.push({ kind, brief, opts: { ...opts } });
                const a = globalThis.__author.answer;
                if (a instanceof Error) throw a;
                if (opts.cacheOnly) return { spec: '', cached: false };
                return { spec: a || '', cached: false };
            },
            compileWidget: async (spec, opts = {}, onEvent, signal) => {
                globalThis.__widget.calls.push({ spec, opts: { ...opts } });
                if (opts.cacheOnly) return globalThis.__widget.lookup;
                const b = globalThis.__widget.build;
                if (b !== 'pending') return b;
                onEvent?.({ status: 'running' });
                onEvent?.({ thinking: 294 });
                return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
            },
            reportVisualBuildFailure: async () => ({ recorded: true }),
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
    // A graph that always draws: Save is offered only once something rendered.
    renderPlot: `export default async (el, code) => {
            const svg = document.createElement('svg');
            svg.setAttribute('data-drawn', code);
            el.appendChild(svg);
          };`,
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
        b.onResolve({ filter: /^\.\/renderPlot$/ }, () => ({ path: 'renderPlot', namespace: 'stub' }));
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
// Only what is on screen: the toolbar's hidden measure holds copies of its
// buttons, inert, which nobody can see or press.
const button = (re) => [...host.querySelectorAll('button')].find(b => !b.closest('[inert]') && re.test(b.textContent || ''));
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
    // "Code", not "Source": the answer's own Sources line sits under the block.
    check('the toolbar still offers Code and Fix this', !!button(/^Code$/) && !!button(/Fix this/));
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
    globalThis.__author.answer = new Error('No model selected — choose or install one in Settings → AI & Models');
    const m = globalThis.__mount(host, { ...base, live: false, autoRepair: false, autoBuild: true });
    await settle(600);
    check('the model being unreachable is reported as an error', /Couldn't render/.test(text()) && /No model selected/.test(text()), text());
    check('with Fix with AI on offer', !!button(/Fix with AI/));
    m.unmount();
}

// ---- a widget, on the same terms as a brief ------------------------------------
//
// The screenshot this answers: a finished assistant answer whose animation had
// drawn itself, and whose widget said "This interactive widget hasn't been built
// yet. [Build widget]" — the widget renderer ran mid-stream, found no consent
// yet, mounted a button card, and the shell took that for a finished render, so
// the reply settling never reached it. And once pressed, the button stayed on
// screen, disabled, above "Designing the widget… 294 chars of reasoning".
const spec = 'Title: Wavefront crowding\nObjective: Show that crowded fronts ahead of a moving source are the Doppler shift.\nInputs: source speed u (0–300 m/s).\nBehavior: fronts are emitted every period and expand at v; the spacing ahead is (v − u)/f.';
const widgetBase = { kind: 'widget', language: 'widget', code: spec, surface: 'assistant', messageId: 7 };

console.log('\n--- a widget while the reply is still streaming ---');
{
    globalThis.__widget.calls = [];
    globalThis.__widget.lookup = { html: '', cached: false };
    globalThis.__widget.build = 'pending';
    const m = globalThis.__mount(host, { ...widgetBase, live: true, autoRepair: false, autoBuild: false });
    await settle(600);
    check('says it is built once the reply finishes', /built once the reply finishes/.test(text()), text());
    check('shows what it will teach (its Objective)', /crowded fronts ahead of a moving source/.test(text()), text());
    check('looks nothing up and builds nothing while the words are still changing', globalThis.__widget.calls.length === 0, JSON.stringify(globalThis.__widget.calls.map(c => c.opts)));
    check('offers no Build button mid-stream', !button(/Build widget/));

    // The reply settles; the host's consent arrives with it (a fresh answer).
    m.render({ ...widgetBase, live: false, autoRepair: true, autoBuild: true });
    await settle(600);
    const calls = globalThis.__widget.calls;
    check('settling looks the cache up, then builds by itself',
        calls.length === 2 && calls[0].opts.cacheOnly === true && calls[1].opts.cacheOnly !== true, JSON.stringify(calls.map(c => c.opts)));
    check('…as an UNASKED build, which the server may decline', calls[1]?.opts.auto === true);
    check('…recorded against where it is read (the assistant, this message)',
        JSON.stringify(calls[1]?.opts.origin) === JSON.stringify({ surface: 'assistant', messageId: 7 }), JSON.stringify(calls[1]?.opts.origin));
    check('while it builds, the progress is shown', /Designing the widget/.test(text()), text());
    check('…and no Build button sits above its own progress', !button(/Build widget/));
    m.unmount();
}

console.log('\n--- a widget from history: an offer, and a press is never declined ---');
{
    globalThis.__widget.calls = [];
    const m = globalThis.__mount(host, { ...widgetBase, live: false, autoRepair: false, autoBuild: false });
    await settle(600);
    check('exactly one cache lookup, nothing built', globalThis.__widget.calls.length === 1 && globalThis.__widget.calls[0].opts.cacheOnly === true, JSON.stringify(globalThis.__widget.calls.map(c => c.opts)));
    check('says it has not been built yet', /hasn’t been built yet/.test(text()), text());
    const build = button(/Build widget/);
    check('offers Build widget', !!build);
    await click(build);
    await settle(600);
    const pressed = globalThis.__widget.calls.slice(1).find(c => !c.opts.cacheOnly);
    check('pressing it builds, and NOT as an unasked build', !!pressed && pressed.opts.auto === false, JSON.stringify(globalThis.__widget.calls.map(c => c.opts)));
    check('…and the offer gives way to the build\'s progress', !button(/Build widget/) && /Designing the widget/.test(text()), text());
    m.unmount();
}

console.log('\n--- an unasked build the server declines ---');
{
    globalThis.__widget.calls = [];
    globalThis.__widget.build = { html: '', cached: false, declined: 'failed', lastError: 'the build is not an HTML document' };
    const m = globalThis.__mount(host, { ...widgetBase, live: false, autoRepair: true, autoBuild: true });
    await settle(600);
    check('a build this model already failed is not run again', globalThis.__widget.calls.filter(c => !c.opts.cacheOnly).length === 1);
    check('…the offer says how it failed last time', /Its last build failed: the build is not an HTML document/.test(text()), text());
    check('…and offers to try again, not an error card', !!button(/Try again/) && !/Couldn't render/.test(text()), text());
    m.unmount();

    globalThis.__widget.calls = [];
    globalThis.__widget.build = { html: '', cached: false, declined: 'off' };
    const m2 = globalThis.__mount(host, { ...widgetBase, live: false, autoRepair: true, autoBuild: true });
    await settle(600);
    check('a kind switched off in Settings says so, and still offers the button', /switched off in Settings/.test(text()) && !!button(/Build widget/), text());
    m2.unmount();
    globalThis.__widget.build = 'pending';
}

console.log('\n--- the toolbar folds Save, Code and Copy under "More" when its row does not fit ---');
{
    const SPEC = '{"data":[{"fn":"x^2"}]}';
    const plot = { kind: 'plot', language: 'plot', code: SPEC, live: false, surface: 'assistant' };
    const more = () => [...host.querySelectorAll('button[aria-label="More"]')].find(b => !b.closest('[inert]'));
    const items = () => [...window.document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    const names = () => items().map(b => b.textContent.trim());
    const all = (labels) => labels.every(l => !!button(new RegExp(`^${l}$`)));

    // A PC: the block is wider than the whole row.
    globalThis.__widths = { block: 640, row: 420 };
    let m = globalThis.__mount(host, plot);
    await settle(600);
    check('the graph is drawn (Save is offered only once something rendered)', !!host.querySelector('svg[data-drawn]'), text());
    check('where the row fits: Fix this, Save, Code and Copy in the row, no "More"', all(['Fix this', 'Save', 'Code', 'Copy']) && !more(), text());
    m.unmount();

    // A phone: the same row is wider than the block.
    globalThis.__widths = { block: 330, row: 420 };
    m = globalThis.__mount(host, plot);
    await settle(600);
    check('where it does not fit: Fix this stays in the row, beside a "More" button', !!button(/^Fix this$/) && !!more(), text());
    check('…and Save, Code and Copy leave the row', !button(/^Save$/) && !button(/^Code$/) && !button(/^Copy$/), text());
    check('the menu is shut until "More" is pressed', items().length === 0, JSON.stringify(names()));
    // Pressed only if there: on a row that never folds this reports, not crashes.
    const press = async (el) => { if (el) await click(el); };
    await press(more());
    check('"More" lists Save, Code and Copy, in the row\'s order', JSON.stringify(names()) === '["Save","Code","Copy"]', JSON.stringify(names()));
    check('the code is not on screen yet', !host.textContent.includes(SPEC), text());
    const code = items().find(b => b.textContent.trim() === 'Code');
    await press(code);
    check('Code from the menu shows the code and shuts the menu', !!code && host.textContent.includes(SPEC) && items().length === 0, text());
    const focused = () => window.document.activeElement?.getAttribute('aria-label') || window.document.activeElement?.tagName;
    check('…and focus goes back to "More", not to the page', !!more() && window.document.activeElement === more(), focused());
    await press(more());
    check('…and the menu then offers Hide code', JSON.stringify(names()) === '["Save","Hide code","Copy"]', JSON.stringify(names()));

    // The phone turned sideways with the menu open: now the row fits.
    const resize = async (block) => {
        globalThis.__widths = { block, row: 420 };
        await act(async () => { window.dispatchEvent(new window.Event('resize')); });
        await settle(100);
    };
    await resize(640);
    check('a block that grows past the row unfolds it, and the open menu goes', all(['Fix this', 'Save', 'Hide code', 'Copy']) && !more() && items().length === 0, `${text()} | menu ${JSON.stringify(names())}`);
    await resize(330);
    check('…and turned back it folds again with the menu shut, not sprung open', !!more() && items().length === 0, `menu ${JSON.stringify(names())}, focus ${focused()}`);

    const measure = host.querySelector('[data-toolbar-measure]');
    check('the hidden measure is inert and carries both labels of Code and of Copy (the wider is measured)',
        !!measure?.closest('[inert]') && ['Hide code', 'Copied!'].every(s => measure.textContent.includes(s)), measure?.textContent);
    m.unmount();

    // Not measured yet (0): the row as it always was, never a guess.
    globalThis.__widths = { block: 0, row: 0 };
    m = globalThis.__mount(host, plot);
    await settle(400);
    check('before anything is measured the row is unfolded', all(['Fix this', 'Save', 'Code', 'Copy']) && !more(), text());
    m.unmount();
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will */ }
console.log(`\nvisual-block gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
