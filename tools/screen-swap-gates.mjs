// tools/screen-swap-gates.mjs — one click, one change of screen.
//
// Run:  node tools/screen-swap-gates.mjs
//
// Opening a course used to go: the Projects grid, then an EMPTY page, then the
// course arriving in pieces (the tree, the dashboard's sections, the pace
// pill), each one moving what was below it. Filmed frame by frame on a large
// library: six states in half a second, 300 ms of them blank. The same held
// for every move between screens. Two causes, both asserted here:
//
//   * a screen's code was downloaded on its first visit, behind a blank
//     fallback. `preloadRouteChunk` fetches it in advance, and a route whose
//     module is here draws on its FIRST render, with no fallback at all.
//
//   * a screen was drawn the moment the address changed, before anything it
//     shows had been read. `useShownLocation` keeps the old screen (and the
//     store's route) until `swapScreen` draws the new one inside the browser's
//     view transition, which holds the old picture until the new screen's
//     reads are back: the reads it started, not background health checks or
//     writes, and never longer than the cap. The same test keeps the app out
//     of sight at start-up until its first screen is whole.
//
// The pre-fix shape (a route drawn straight from the address, a route that
// was never preloaded) runs through the same assertions where it can, so the
// gate is shown to see the old bug.
//
// jsdom + the shipped TypeScript bundled with esbuild. No model, no server.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const cache = fileURLToPath(new URL('../node_modules/.cache', import.meta.url));
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'screen-swap-gates-'));
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* held */ } });
const out = join(scratch, 'harness.mjs');

await esbuild.build({
    entryPoints: [fileURLToPath(new URL('./screen-swap-harness/entry.tsx', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'false' },
    outfile: out, logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/a' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

await import(pathToFileURL(out).href);
const { React, createRoot, act, MemoryRouter, Shell, storeSaw, RouteChunk, preloadRouteChunk, swap, navigate } = globalThis.__harness;
const { swapScreen, trackRead, revealFirstScreen, HOLD_CAP_MS, FIRST_SCREEN_CAP_MS } = swap;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const h = React.createElement;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = dom.window.document;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

/** A stand-in for the browser's view transition: records each update
 *  callback, runs it only when the test says, and reports when it settled. */
let transitions = [];
function installTransitions() {
    transitions = [];
    doc.startViewTransition = (update) => {
        const t = { update, ran: false, settledAt: null, startedAt: null };
        t.run = async () => { t.ran = true; t.startedAt = performance.now(); await update(); t.settledAt = performance.now(); };
        transitions.push(t);
        const p = new Promise(() => {});
        return { ready: p, finished: p, updateCallbackDone: p };
    };
}
function removeTransitions() { delete doc.startViewTransition; }
/** How long the update callback took to settle, `run` included. */
async function holdFor(t, during = async () => {}) {
    const running = t.run();
    await during();
    await running;
    return t.settledAt - t.startedAt;
}

console.log('\n--- a browser without view transitions ---');
{
    removeTransitions();
    let drawn = 0;
    swapScreen(() => { drawn++; });
    check('the next screen is drawn at once, exactly once', drawn === 1, `drawn ${drawn}`);
}

console.log('\n--- the hold: what it waits for ---');
{
    installTransitions();
    let drawn = 0;
    swapScreen(() => { drawn++; });
    check('the old screen stays until the browser runs the swap', drawn === 0 && transitions.length === 1);

    // A read the new screen starts: held until it is back.
    const read = deferred();
    const t = transitions[0];
    const ms = await holdFor(t, async () => {
        trackRead(read.promise, 'GET', '/api/projects/3/dashboard');
        await sleep(200);
        check('the new screen is drawn inside the swap', drawn === 1, `drawn ${drawn}`);
        check('...and is not shown while its read is out', t.settledAt === null);
        read.resolve({});
    });
    check('it is shown soon after its read comes back', ms >= 200 && ms < 200 + 150, `${Math.round(ms)} ms`);
}
{
    installTransitions();
    swapScreen(() => {});
    const never = deferred();
    const ms = await holdFor(transitions[0], async () => { trackRead(never.promise, 'GET', '/api/atlas'); });
    never.resolve({});
    check(`a read that never ends holds no longer than the cap (${HOLD_CAP_MS} ms)`,
        ms >= HOLD_CAP_MS - 20 && ms < HOLD_CAP_MS + 150, `${Math.round(ms)} ms`);
}
for (const [label, method, url] of [
    ['a health check that may reach a provider', 'GET', '/api/ai/status'],
    ['a model list asked of a provider', 'GET', '/api/ai/connections/4/models'],
    ['the update check', 'GET', '/api/updates'],
    ['a write', 'POST', '/api/study-time'],
]) {
    installTransitions();
    swapScreen(() => {});
    const never = deferred();
    const ms = await holdFor(transitions[0], async () => { trackRead(never.promise, method, url); });
    never.resolve({});
    check(`${label} does not hold the screen`, ms < 150, `${Math.round(ms)} ms`);
}
{
    installTransitions();
    const main = doc.createElement('main');
    doc.body.appendChild(main);
    swapScreen(() => {});
    const ms = await holdFor(transitions[0], async () => {
        main.innerHTML = '<div aria-busy="true"></div><button aria-busy="true">Saving</button>';
        await sleep(250);
        main.querySelector('div').removeAttribute('aria-busy');
    });
    check('a part of the screen marked busy holds it; a busy button does not', ms >= 250 && ms < 400, `${Math.round(ms)} ms`);
    main.remove();
}
{
    installTransitions();
    swapScreen(() => {});
    const first = transitions[0];
    const never = deferred();
    const ms = await holdFor(first, async () => {
        trackRead(never.promise, 'GET', '/api/feed');
        await sleep(100);
        swapScreen(() => {});
    });
    check('a newer move ends the older hold at once', ms < 250, `${Math.round(ms)} ms`);
    never.resolve({});
    await transitions[1].run();
}

console.log('\n--- the routes follow the shown location ---');
{
    installTransitions();
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host);
    storeSaw.length = 0;
    await act(async () => { root.render(h(MemoryRouter, { initialEntries: ['/a'] }, h(Shell))); });
    check('the first screen is drawn without a swap', /screen A/.test(host.textContent) && transitions.length === 0);

    await act(async () => { navigate('/b'); });
    check('after a click the OLD screen is still the one drawn', /screen A/.test(host.textContent), host.textContent);
    check('...and the store has not been told to leave it', storeSaw.join() === '/a', storeSaw.join());
    await act(async () => { await transitions[0].run(); });
    check('the swap draws the new screen', /screen B/.test(host.textContent), host.textContent);
    check('...and moves the store with it', storeSaw.join() === '/a,/b', storeSaw.join());

    await act(async () => { navigate('/c'); });
    await act(async () => { navigate('/a'); });
    await act(async () => { await transitions[1].run(); });
    check('two quick moves end on the newer one', /screen A/.test(host.textContent), host.textContent);
    await act(async () => { await transitions[2].run(); });
    check('...and the later swap changes nothing', /screen A/.test(host.textContent) && storeSaw.at(-1) === '/a', storeSaw.join());

    const before = transitions.length;
    await act(async () => { navigate('/a?tab=2'); });
    check('a change of query on the same screen is not a swap', transitions.length === before && /screen A/.test(host.textContent));
    await act(async () => { root.unmount(); });
    host.remove();
}

console.log('\n--- a screen whose code was fetched in advance ---');
{
    const Screen = () => h('p', null, 'the course');
    const load = () => Promise.resolve({ default: Screen });
    // Every node the route ever put on the page, in order: a blank fallback
    // that was shown for even one commit is in this list.
    const mountRoute = async (name, load) => {
        const host = doc.createElement('div');
        doc.body.appendChild(host);
        const added = [];
        const watch = new dom.window.MutationObserver((records) => {
            for (const r of records) for (const n of r.addedNodes) added.push(n.nodeType === 1 && n.getAttribute('aria-busy') === 'true' ? 'blank' : 'content');
        });
        watch.observe(host, { childList: true, subtree: true });
        const root = createRoot(host);
        await act(async () => { root.render(h(RouteChunk, { name, load })); });
        await act(async () => { await sleep(10); });
        await new Promise((r) => setTimeout(r, 0));
        watch.disconnect();
        const seen = { added, text: host.textContent };
        await act(async () => { root.unmount(); });
        host.remove();
        return seen;
    };
    const cold = await mountRoute('never preloaded', load);
    check('the known-bad case: a route not fetched shows a blank page before the screen',
        cold.added[0] === 'blank' && cold.text === 'the course', JSON.stringify(cold));
    await preloadRouteChunk('preloaded', load);
    const warm = await mountRoute('preloaded', load);
    check('a preloaded route never shows the blank page', !warm.added.includes('blank') && warm.text === 'the course', JSON.stringify(warm));
}

console.log('\n--- opening the app ---');
{
    const html = doc.documentElement;
    const appRoot = doc.getElementById('root');
    appRoot.innerHTML = '';
    revealFirstScreen();
    check('the app is out of sight while it starts', html.getAttribute('data-first-screen') === 'pending');
    await sleep(200);
    check('...and stays so while nothing is drawn yet', html.getAttribute('data-first-screen') === 'pending');
    const read = deferred();
    trackRead(read.promise, 'GET', '/api/projects');
    appRoot.innerHTML = '<main><p>Your projects</p></main>';
    await sleep(150);
    check('...and while the first screen\'s read is out', html.getAttribute('data-first-screen') === 'pending');
    read.resolve({});
    await sleep(120);
    check('it is shown once the first screen is drawn and read', !html.hasAttribute('data-first-screen'));

    appRoot.innerHTML = '';
    const started = performance.now();
    revealFirstScreen();
    while (html.hasAttribute('data-first-screen') && performance.now() - started < FIRST_SCREEN_CAP_MS + 1000) await sleep(20);
    const ms = performance.now() - started;
    check(`a start that never draws is shown at the cap (${FIRST_SCREEN_CAP_MS} ms), never kept hidden`,
        !html.hasAttribute('data-first-screen') && ms >= FIRST_SCREEN_CAP_MS - 20 && ms < FIRST_SCREEN_CAP_MS + 200, `${Math.round(ms)} ms`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
