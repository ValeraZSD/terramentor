// tools/router-sync-gates.mjs — when the URL is applied to the store.
//
// Run:  node tools/router-sync-gates.mjs
//
// `useRouterStoreSync` turns the address into the store's navigation state, and
// the store's `applyRoute` loads that route's data (a course's topics, say). It
// is mounted high in `App`, ABOVE the password gate, so on a password-protected
// server the first thing it does is ask for a course the browser is not allowed
// to read yet: the request is refused, and the store is left pointing at a
// course with no topics. After the login nothing re-applies the route, because
// the pathname has not changed, so the workspace opens empty and looks as if
// the course was lost.
//
// So what is asserted is the SEQUENCE: nothing is applied while the gate is
// closed (or not yet known), the URL is applied the moment it opens, and an
// ordinary navigation still applies as before.
//
// The real hook and the real react-router, mounted by React DOM into jsdom; the
// store is a stand-in with only the fields the hook reads, so the gate does not
// pull the whole app (and its model, i18n and API modules) into the bundle.
// No model, no network, no database.

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
const scratch = mkdtempSync(join(cache, 'router-sync-gates-'));
// Removed however the run ends, a thrown error included. It lives under the
// repo's own node_modules so the bundle resolves react from there.
process.on('exit', () => {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ }
});

const entry = join(scratch, 'entry.tsx');
writeFileSync(entry, `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act as domAct } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useRouterStoreSync } from ${JSON.stringify(join(repoRoot, 'src/hooks/useRouterStoreSync.ts').split('\\').join('/'))};
import { useStore, applied } from '../store';

let navigateTo: (to: string) => void = () => {};
function Probe() {
    useRouterStoreSync();
    const navigate = useNavigate();
    navigateTo = navigate;
    return null;
}
(globalThis as any).__harness = {
    React, createRoot, act: (React as any).act || domAct, MemoryRouter, Probe, useStore, applied,
    navigate: (to: string) => navigateTo(to),
};
`);

const fakeStore = {
    name: 'fake-store',
    setup(build) {
        build.onResolve({ filter: /^(\.\.\/store|fake-store)$/ }, (args) => ({ path: 'fake-store', namespace: 'fake-store' }));
        build.onLoad({ filter: /.*/, namespace: 'fake-store' }, () => ({
            resolveDir: repoRoot,
            loader: 'ts',
            contents: `
                import { create } from 'zustand';
                export const applied: any[] = [];
                export const useStore: any = create(() => ({
                    authChecked: false,
                    authEnabled: false,
                    authenticated: false,
                    setNavigate: () => {},
                    applyRoute: (route: any) => { applied.push(route); },
                }));
            `,
        }));
    },
};

const out = join(scratch, 'harness.mjs');
await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic',
    plugins: [fakeStore],
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'false' },
    outfile: out, logLevel: 'silent', absWorkingDir: repoRoot,
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.IS_REACT_ACT_ENVIRONMENT = true;

await import(pathToFileURL(out).href);
const { React, createRoot, act, MemoryRouter, Probe, useStore, applied, navigate } = globalThis.__harness;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const h = React.createElement;
const gate = (state) => act(async () => { useStore.setState(state); });
const mount = async (path) => {
    applied.length = 0;
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(h(MemoryRouter, { initialEntries: [path] }, h(Probe))); });
    return root;
};
const seen = () => JSON.stringify(applied);

console.log('\n--- a password-protected server ---');
{
    await gate({ authChecked: false, authEnabled: false, authenticated: false });
    const root = await mount('/project/3/tree');
    check('nothing is applied before the server has said whether there is a password', applied.length === 0, seen());

    await gate({ authChecked: true, authEnabled: true, authenticated: false });
    check('...nor while the lock screen is up', applied.length === 0, seen());

    await gate({ authenticated: true });
    check('the address is applied once the gate opens, though the path has not changed',
        applied.length === 1 && applied[0].view === 'workspace' && applied[0].projectId === 3 && applied[0].workspaceView === 'tree',
        seen());

    await act(async () => { navigate('/calendar'); });
    check('and a navigation after that applies as before', applied.length === 2 && applied[1].view === 'calendar', seen());

    await gate({ authenticated: false });
    check('locking the app again applies nothing', applied.length === 2, seen());
    await gate({ authenticated: true });
    check('...and the login re-applies the address the reader is on', applied.length === 3 && applied[2].view === 'calendar', seen());
    await act(async () => { root.unmount(); });
}

console.log('\n--- a server with no password ---');
{
    await gate({ authChecked: false, authEnabled: false, authenticated: false });
    const root = await mount('/project/7');
    check('nothing is applied until the check answers', applied.length === 0, seen());

    await gate({ authChecked: true, authEnabled: false, authenticated: false });
    check('with no password the address is applied as soon as that is known',
        applied.length === 1 && applied[0].view === 'workspace' && applied[0].projectId === 7, seen());
    await act(async () => { root.unmount(); });
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
