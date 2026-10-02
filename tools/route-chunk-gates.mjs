// tools/route-chunk-gates.mjs — the error screen on a route that never downloaded.
//
// Run:  node tools/route-chunk-gates.mjs
//
// Why this exists: a rebuild under an open page kills the chunks that page has
// not fetched yet — the filenames carry a content hash and `vite build` empties
// `dist/` — and the server answers the dead URL with `index.html`, so the
// dynamic import is rejected. That is a fair failure. The screen was not:
// pressing Try Again moved the error UP to the application boundary (header and
// navigation gone), pressing it there moved it back down, forever, and no press
// ever re-fetched anything.
//
// Two separate causes, both asserted here on the real components:
//
//   * the route's boundary sat BELOW the app's one `<Suspense>`, so a first
//     render that suspends threw the boundary away with the rest of the
//     discarded work and the error landed on the boundary above it. `RouteChunk`
//     carries its own Suspense under its own boundary, so every attempt must
//     stay in the ROUTE's boundary.
//
//   * the button offered a retry the browser cannot honour. A module script that
//     fails to load is recorded as a failure in the module map BY URL for the
//     life of the document, so re-importing never reaches the network again
//     (measured in Chrome on the real app: one request across three attempts,
//     with the chunk restored in between). So a chunk failure now offers a
//     RELOAD, and that is what is asserted — the reload screen, not a retry.
//
// The pre-fix shape is kept as `LegacyRoute` and run through the same
// assertions: an instrument that cannot see the old bug cannot be trusted about
// the new fix.
//
// jsdom + the shipped TypeScript bundled with esbuild. No model, no server.

import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const cache = fileURLToPath(new URL('../node_modules/.cache', import.meta.url));
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'route-chunk-gates-'));
const out = join(scratch, 'harness.mjs');

await esbuild.build({
    entryPoints: [fileURLToPath(new URL('./route-chunk-harness/entry.tsx', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'false' },
    outfile: out,
    logLevel: 'silent',
});

// --- a browser for it to live in ---------------------------------------------
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true, url: 'http://localhost/schedule',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 24 defines `navigator` as a getter-only global, so it is redefined
// rather than assigned; React DOM reads it while deciding how to hydrate.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.IS_REACT_ACT_ENVIRONMENT = true;

// Every fetch the page makes, recorded. `/api/build` is the freshness watcher
// asking the server what build is on disk — the second half of the fix — so it
// is a fact this gate reads, not noise to be swallowed.
const fetched = [];
globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return { ok: true, status: 200, json: async () => ({ buildId: 'same-as-boot' }) };
};
dom.window.fetch = globalThis.fetch;

await import(pathToFileURL(out).href);
const { React, createRoot, act, RouteChunk, ErrorBoundary, LegacyRoute, isChunkLoadError, said } =
    globalThis.__harness;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const h = React.createElement;
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

/** The message a stale chunk really produces, as Chrome writes it. */
const CHUNK_ERROR = () =>
    new Error('Failed to fetch dynamically imported module: http://localhost/assets/ScheduleBoard-DgVroGoV.js');

/**
 * Mount one route the way `App.tsx` nests them: the application boundary, then
 * the router's own Suspense, then the route. `RouteChunk` puts a SECOND Suspense
 * under its own boundary, which is the half of the fix this nesting exists to
 * test — the outer one must never be what catches.
 *
 * Each case gets its own route name: the chunk map is module-level by design
 * (that is the other half), so a shared name would carry one case's attempts
 * into the next.
 */
async function mountRoute(Route, { failures, name }) {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const calls = { n: 0 };
    const load = () => {
        calls.n += 1;
        if (calls.n <= failures) return Promise.reject(CHUNK_ERROR());
        return Promise.resolve({ default: () => h('p', null, 'the schedule board') });
    };
    const root = createRoot(host);
    await act(async () => {
        root.render(
            h(ErrorBoundary, { componentName: 'Application', fallback: said('Application') },
                h(React.Suspense, { fallback: h('div', null, 'loading') },
                    h(Route, { name, load, fallback: said(name) }))),
        );
    });
    await flush();
    return { host, calls, root };
}

const text = (host) => host.textContent || '';
const caughtBy = (host) =>
    /caught:Application/.test(text(host)) ? 'application'
        : /caught:/.test(text(host)) ? 'route'
            : /needs a reload/.test(text(host)) ? 'reload'
                : /the schedule board/.test(text(host)) ? 'rendered' : 'nothing';

const pressRetry = async (host) => {
    const button = Array.from(host.querySelectorAll('button'))
        .find(b => /Try Again/i.test(b.textContent || ''));
    if (!button) return false;
    await act(async () => {
        button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
    return true;
};

console.log('\n--- a chunk that never arrived ---');
{
    const { host, calls } = await mountRoute(RouteChunk, { failures: 2, name: 'Schedule Board' });
    check('it is the ROUTE that catches it, not the application', caughtBy(host) === 'reload', caughtBy(host));
    check('the loader ran once', calls.n === 1, `${calls.n}`);
    // The whole point: the browser will not re-fetch a URL whose module script
    // already failed, so a "Try Again" here would be a button that cannot work.
    check('the screen offers a RELOAD, not a retry',
        /Reload/.test(text(host)) && !/Try Again/.test(text(host)), JSON.stringify(text(host).slice(0, 100)));
    check('and it does not call it an unexpected error',
        !/went wrong|unexpected error/i.test(text(host)), JSON.stringify(text(host).slice(0, 100)));
    check('nothing re-imported behind the reader’s back', calls.n === 1, `${calls.n}`);
}

console.log('\n--- a route that loaded and then crashed ---');
{
    // Not a download failure, so the retry is honest here: remounting the
    // subtree is a thing that can actually fix a crash.
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    // A flag, not a render counter: React in development re-invokes a component
    // that threw, to recover a stack for the console, so "throw on the first
    // render only" is two different behaviours depending on the build.
    let broken = true;
    const Crashes = () => {
        if (broken) throw new Error('boom, in render');
        return h('p', null, 'the schedule board');
    };
    const root = createRoot(host);
    await act(async () => {
        root.render(
            h(ErrorBoundary, { componentName: 'Application', fallback: said('Application') },
                h(React.Suspense, { fallback: h('div', null, 'loading') },
                    h(RouteChunk, {
                        name: 'Crashing Route',
                        load: () => Promise.resolve({ default: Crashes }),
                        fallback: said('Crashing Route'),
                    }))),
        );
    });
    await flush();
    check('the crash is caught by the ROUTE', caughtBy(host) === 'route', caughtBy(host));
    check('a crash keeps the ordinary retry', /Try Again/.test(text(host)), JSON.stringify(text(host).slice(0, 100)));
    broken = false;
    await pressRetry(host);
    check('and the retry remounts it, so a transient crash recovers', caughtBy(host) === 'rendered', caughtBy(host));
}

console.log('\n--- the shape this replaced, through the same assertions ---');
{
    const { host, calls } = await mountRoute(LegacyRoute, { failures: 2, name: 'Legacy Board' });
    check('control: the first failure lands somewhere', caughtBy(host) === 'route', caughtBy(host));
    await pressRetry(host);
    // The alternation, reproduced: the boundary cleared its own state, the lazy
    // threw again in the render that boundary scheduled, and the error went up.
    // Which press this happens on is not stable across React builds — the
    // shipped production bundle escalated on the FIRST failure, with the header
    // and navigation gone (measured in the running app, chunk moved out of
    // `dist/`) — so the assertion is that it escalates at all, never on when.
    check('control: and then it escalates to the application boundary',
        caughtBy(host) === 'application', caughtBy(host));
    check('control: while its retry does NOT re-import — the rejection is memoised',
        calls.n === 1, `loader ran ${calls.n} times`);
}

console.log('\n--- a chunk failure asks whether the build moved ---');
{
    fetched.length = 0;
    const { host } = await mountRoute(RouteChunk, { failures: 1, name: 'Freshness Board' });
    check('the route failed as intended', caughtBy(host) === 'reload', caughtBy(host));
    check('the page asked the server for the installed build id',
        fetched.some(u => u.includes('/api/build')), fetched.join(', ') || 'no fetches');
}

console.log('\n--- an ordinary crash is not a download failure ---');
{
    fetched.length = 0;
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const load = () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'map')"));
    const root = createRoot(host);
    await act(async () => {
        root.render(h(React.Suspense, { fallback: h('div', null, 'loading') },
            h(RouteChunk, { name: 'Broken Board', load, fallback: said('Broken Board') })));
    });
    await flush();
    check('it shows the route’s error screen, not the reload one', caughtBy(host) === 'route', caughtBy(host));
    check('and nothing asks the server about the build',
        !fetched.some(u => u.includes('/api/build')), fetched.join(', '));
}

console.log('\n--- what counts as "the chunk did not arrive" ---');
{
    // One case per engine, written the way that engine writes it. A browser
    // whose wording is missing here fails quietly — the reader is offered a
    // retry that cannot work instead of a reload that can — so the list is the
    // assertion.
    const chunky = [
        'Failed to fetch dynamically imported module: http://x/assets/a-DgVroGoV.js',   // Chrome
        'error loading dynamically imported module: http://x/assets/a.js',              // Firefox
        'Importing a module script failed.',                                            // Safari
        'Failed to load module script: Expected a JavaScript module script but the server '
            + 'responded with a MIME type of "text/html".',                             // Chrome, SPA fallback
        'Loading chunk 42 failed.',                                                     // webpack-era wording
    ];
    for (const message of chunky) {
        check(`chunk failure: ${message.slice(0, 44)}…`, isChunkLoadError(new Error(message)));
    }
    const notChunky = [
        "Cannot read properties of undefined (reading 'map')",
        'NetworkError when attempting to fetch resource.',
        'Failed to fetch',
        'Minified React error #310',
    ];
    for (const message of notChunky) {
        check(`not a chunk failure: ${message.slice(0, 44)}`, !isChunkLoadError(new Error(message)));
    }
    check('a thrown non-Error is not a chunk failure', !isChunkLoadError('dynamically imported module'));
    check('null is not a chunk failure', !isChunkLoadError(null));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
