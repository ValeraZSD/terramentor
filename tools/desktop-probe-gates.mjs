// tools/desktop-probe-gates.mjs — the page's first desktop probe.
//
// Run:  node tools/desktop-probe-gates.mjs
//
// `useDesktop` asks the server once per page whether it is a desktop process,
// and only a desktop answer starts the heartbeat. The answer is kept for the
// life of the page, so a probe that fails once (the server still starting, a
// dropped request) must be asked again: settling on "not a desktop process"
// means no ping ever, and the desktop server then stops itself under an open
// window. After every try has failed the page does settle on it.
//
// The real hook, mounted by React DOM into jsdom; `desktopApi` is a stand-in
// whose first answers fail. Timers run at once. No network, no database.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cache = join(repoRoot, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'desktop-probe-gates-'));

const hook = join(repoRoot, 'src/hooks/useDesktop.ts').split('\\').join('/');
const entry = join(scratch, 'entry.tsx');
writeFileSync(entry, `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { useDesktop } from ${JSON.stringify(hook)};
function Probe() {
    const { status } = useDesktop();
    (globalThis as any).__status = status;
    return null;
}
(globalThis as any).__harness = { React, createRoot, Probe };
`);

// The stand-in API: `details()` fails the first `failures` times, then answers
// a desktop process. Every call and ping is counted on globalThis.__api.
const fakeApi = {
    name: 'fake-desktop-api',
    setup(build) {
        build.onResolve({ filter: /desktopApi$/ }, () => ({ path: 'fake-desktop-api', namespace: 'fake-desktop-api' }));
        build.onLoad({ filter: /.*/, namespace: 'fake-desktop-api' }, () => ({
            resolveDir: repoRoot,
            loader: 'ts',
            contents: `
                const api: any = (globalThis as any).__api;
                export const desktopApi = {
                    details: () => { api.calls++; return api.calls <= api.failures ? Promise.reject(new Error('Failed to fetch')) : Promise.resolve({ desktop: true, detailed: true }); },
                    ping: () => { api.pings++; return Promise.resolve(); },
                    bye: () => {},
                };
            `,
        }));
    },
};

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Retries wait seconds; here they run at once. The heartbeat's interval never fires.
const realSetTimeout = globalThis.setTimeout;
const waits = [];
globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); return realSetTimeout(fn, 0, ...args); };
globalThis.setInterval = () => 0;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const settle = () => new Promise((r) => realSetTimeout(r, 50));

/** Mount the hook in a fresh bundle (its once-per-page state starts clean). */
async function run(failures) {
    globalThis.__api = { calls: 0, pings: 0, failures };
    globalThis.__status = undefined;
    waits.length = 0;
    const out = join(scratch, `harness-${failures}.mjs`);
    await esbuild.build({
        entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic',
        plugins: [fakeApi], define: { 'process.env.NODE_ENV': '"development"' },
        outfile: out, logLevel: 'silent', absWorkingDir: repoRoot,
    });
    await import(pathToFileURL(out).href);
    const { React, createRoot, Probe } = globalThis.__harness;
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    await React.act(async () => { root.render(React.createElement(Probe)); });
    for (let i = 0; i < 20; i++) await React.act(settle);
    const result = { ...globalThis.__api, status: globalThis.__status, waits: [...waits] };
    await React.act(async () => root.unmount());
    return result;
}

try {
    console.log('\n-- a probe that fails twice, then answers');
    const late = await run(2);
    check('it is asked again after a failure', late.calls === 3, JSON.stringify(late));
    check('the page then knows it is a desktop process', late.status?.desktop === true, JSON.stringify(late.status));
    check('and the heartbeat starts', late.pings >= 1, JSON.stringify(late));

    console.log('\n-- a probe that never answers');
    const never = await run(100);
    check('it is asked six times in all', never.calls === 6, JSON.stringify(never));
    // The waits are what keeps a server that is still starting from being asked
    // six times in one second: each one is longer than the last, 2 s to 10 s.
    check('…waiting 2, 4, 6, 8 and 10 s between the tries',
        JSON.stringify(never.waits) === JSON.stringify([2000, 4000, 6000, 8000, 10000]), JSON.stringify(never.waits));
    check('then the page settles on "not a desktop process"', never.status?.desktop === false, JSON.stringify(never.status));
    check('and sends no ping', never.pings === 0, JSON.stringify(never));
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
