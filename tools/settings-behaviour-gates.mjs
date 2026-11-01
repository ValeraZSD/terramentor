// tools/settings-behaviour-gates.mjs — what a setting does when it is pressed.
//
// Run:  node tools/settings-behaviour-gates.mjs
//       node tools/settings-behaviour-gates.mjs --base <ref>   (the mounted files as
//                                             they were at <ref>, to watch the cases
//                                             fail on the pre-fix code)
//
// WHY. Three faults an outside review of Settings found (2026-11-01), each one
// correct-looking source and a wrong screen:
//   - the Tailscale row: the switch read ON while the line under it said "Turn
//     it on"; pressing that button spun "Show code" as well, and its answer
//     (the command to run when Tailscale refused) appeared in the "Connect a
//     phone" row above, off-screen on a phone;
//   - a setting row whose control gives way to what it opened ("Show code" to
//     the code) kept its last "stacked" answer, so the opened panel sat 24px
//     under its name instead of 12;
//   - "Offer simulations and widgets to any model" lost the line that explains
//     it to a screen reader when its tick became a switch.
// The cases MOUNT the real SettingRow, Switch and OtherDevices in jsdom (store,
// api and translations are stubs; no server, no Tailscale CLI).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseAt = process.argv.indexOf('--base');
const BASE = baseAt > 0 ? process.argv[baseAt + 1] : null;
const read = (p) => BASE
    ? execFileSync('git', ['show', `${BASE}:${p}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// --- jsdom, with just enough layout for SettingRow to measure -------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
const { window } = dom;
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'getComputedStyle', 'MutationObserver']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? window : window[k], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
class RO { constructor(cb) { this.cb = cb; } observe() { } unobserve() { } disconnect() { } }
globalThis.ResizeObserver = window.ResizeObserver = RO;
// A 340px row (a phone's card) and a 300px control: the control cannot sit
// beside the name, so the row stacks. Every other box measures 0.
const ROW_W = 340, CONTROL_W = 300;
const isRow = (el) => /\bjustify-between\b/.test(el.className) && /\bgap-4\b/.test(el.className);
const isControl = (el) => /\bshrink-0\b|\bw-max\b/.test(el.className) && el.parentElement && (isRow(el.parentElement) || el.previousElementSibling && isRow(el.previousElementSibling));
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return isRow(this) ? ROW_W : 0; } });
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return isControl(this) ? CONTROL_W : 0; } });

// --- the real components, bundled ----------------------------------------
// Inside node_modules, so the bundle's external `require('react')` resolves.
mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true });
const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'settings-behaviour-'));
const out = join(scratch, 'bundle.cjs');
const baseDir = join(scratch, 'base');
const FILES = ['ui/SettingRow', 'ui/Switch', 'OtherDevices'];
if (BASE) {
    for (const f of FILES) {
        mkdirSync(dirname(join(baseDir, `${f}.tsx`)), { recursive: true });
        writeFileSync(join(baseDir, `${f}.tsx`), read(`src/components/${f}.tsx`));
    }
}
const from = (f) => BASE ? join(baseDir, `${f}.tsx`).replace(/\\/g, '/') : `./src/components/${f}`;

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => o ? k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o[n] ?? '')) : k });`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: {}, subs: new Set() };
        g.__setState = (patch) => { g.__st.state = { ...g.__st.state, ...patch }; g.__st.subs.forEach(f => f()); };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;`,
    'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => (globalThis.__api?.[name] ?? (() => new Promise(() => { })))(...args) });`,
    'QrCode': `import { createElement } from 'react'; export default function QrCode({ label }) { return createElement('div', { 'data-qr': '1', 'aria-label': label }); }`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\/QrCode$/ }, () => ({ path: 'QrCode', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
        // A copy from <ref> sits in the scratch dir, but its imports meant the
        // directory it came from.
        b.onResolve({ filter: /^\.\.?\// }, async (args) => {
            const imp = args.importer.replace(/\\/g, '/');
            const baseRoot = baseDir.replace(/\\/g, '/');
            if (!BASE || !imp.startsWith(baseRoot)) return undefined;
            const rel = dirname(imp.slice(baseRoot.length + 1));
            return b.resolve(args.path, { resolveDir: join(root, 'src', 'components', rel), kind: args.kind });
        });
    },
};
await esbuild.build({
    stdin: {
        contents: `
            export { SettingRow } from '${from('ui/SettingRow')}';
            export { default as Switch } from '${from('ui/Switch')}';
            export { default as OtherDevices } from '${from('OtherDevices')}';`,
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
const React = require('react');
const { createRoot } = require('react-dom/client');
const { SettingRow, Switch, OtherDevices } = require(out);
rmSync(scratch, { recursive: true, force: true });
const h = React.createElement;
const act = (fn) => React.act(fn);
const doc = window.document;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** Mount, run the case, unmount; a case that throws is one failure, not a crashed suite. */
async function mounted(label, render, body) {
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    const r = createRoot(el);
    try {
        await act(async () => r.render(render()));
        await body(el, (next) => act(async () => r.render(next())));
    } catch (e) {
        check(`${label}: mounted and ran`, false, String(e?.message ?? e).split('\n')[0]);
    } finally {
        await act(async () => r.unmount());
        el.remove();
    }
}

// ---------------------------------------------------------------------------
section('a row whose control gives way to what it opened forgets that it was stacked');
await mounted('SettingRow', () => h(SettingRow, { label: 'Connect a phone', control: h('button', null, 'Show code') }), async (el, rerender) => {
    const row = () => [...el.querySelectorAll('div')].find(isRow);
    check('control: a 300px control in a 340px row goes under the name', row()?.classList.contains('mb-3') && /\bw-max\b/.test(el.innerHTML),
        row()?.className);
    await rerender(() => h(SettingRow, { label: 'Connect a phone', more: h('div', { id: 'opened' }, 'the code') }));
    check('with the control gone, the row keeps no stacked margin over the opened panel (12px, not 24)',
        row() && !row().classList.contains('mb-3'), row()?.className);
    await rerender(() => h(SettingRow, { label: 'Connect a phone', control: h('button', null, 'Show code') }));
    check('…and stacks again when the control comes back', row()?.classList.contains('mb-3'), row()?.className);
});

// ---------------------------------------------------------------------------
section('a switch can point at the line that explains it');
await mounted('Switch', () => h(Switch, { checked: true, onChange() { }, label: 'Offer simulations and widgets to any model', describedBy: 'visual-any-model-why' }), async (el) => {
    const sw = el.querySelector('[role="switch"]');
    check('the switch carries aria-describedby', sw?.getAttribute('aria-describedby') === 'visual-any-model-why', sw?.outerHTML.slice(0, 160));
});
await mounted('Switch without a description', () => h(Switch, { checked: false, onChange() { }, label: 'x' }), async (el) => {
    check('…and none when it is given none', !el.querySelector('[role="switch"]').hasAttribute('aria-describedby'));
});
{
    // The panel is too heavy to mount (it draws every visual kind's sample).
    const panel = read('src/components/settings/VisualKindsPanel.tsx');
    check('"Offer simulations and widgets to any model" is described by its explanation',
        /<Switch\b(?:(?!\/>)[\s\S])*describedBy="visual-any-model-why"/.test(panel) && /id="visual-any-model-why"/.test(panel));
}

// ---------------------------------------------------------------------------
section('the Tailscale row: the switch lets your devices in, the button shares the app, and its answer lands in that row');
{
    let getDevicesCalls = 0;
    let answerServe = null;
    globalThis.__api = {
        getDevices: async () => { getDevicesCalls++; return { devices: [], tailscale: { login: 'you@example.com', on: true, served: false } }; },
        serveOnTailnet: () => new Promise((r) => { answerServe = r; }),
    };
    globalThis.__setState({ authEnabled: false, showConfirm: async () => false, addToast() { } });

    await mounted('OtherDevices', () => h(OtherDevices, { active: true }), async (el) => {
        await flush();
        const buttons = () => [...el.querySelectorAll('button')];
        const byText = (re) => buttons().find((b) => re.test(b.textContent));
        const sw = el.querySelector('[role="switch"]');
        // The row is the SettingRow box that holds the switch.
        const tsRow = () => el.querySelector('[role="switch"]')?.closest('.px-4.py-3');
        const phoneRow = () => [...el.querySelectorAll('.px-4.py-3')].find((r) => /Connect a phone/.test(r.textContent));

        check('control: the switch is on and the app is not shared yet', sw?.getAttribute('aria-checked') === 'true');
        check('nothing beside an ON switch asks to "Turn it on"', !/Turn it on/.test(el.textContent), tsRow()?.textContent.slice(0, 200));
        const named = byText(/Share it on Tailscale/);
        check('the row\'s button says what it does: Share it on Tailscale', !!named && tsRow()?.contains(named));
        // Under any name, the row's one button is the press the rest is about.
        const rowButton = () => named ? byText(/Share it on Tailscale/)
            : [...(tsRow()?.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('role') !== 'switch');
        const share = rowButton();
        if (!share) { check('the row has a button to press', false); return; }

        await act(async () => { share.click(); });
        check('while it works, the row\'s own button spins', share.getAttribute('aria-busy') === 'true');
        const showCode = byText(/Show code/);
        check('…and "Show code" in the row above does not', !!showCode && showCode.getAttribute('aria-busy') !== 'true', showCode?.outerHTML.slice(0, 120));

        await act(async () => { answerServe({ url: null, tailscale: true, failed: true, command: 'tailscale serve --bg --https=8443 http://127.0.0.1:3282' }); });
        await flush();
        check('a refusal shows the command to run IN the Tailscale row', /tailscale serve --bg/.test(tsRow()?.textContent ?? ''), tsRow()?.textContent.slice(0, 240));
        check('…and opens nothing in "Connect a phone"', !/tailscale serve --bg|Not now/.test(phoneRow()?.textContent ?? ''), phoneRow()?.textContent.slice(0, 240));

        const before = getDevicesCalls;
        const again = rowButton() ?? byText(/Turn it on|Share it on Tailscale/);
        if (!again) { check('after a refusal, the press can be tried again', false); return; }
        await act(async () => { again.click(); });
        await act(async () => { answerServe({ url: 'https://pc.tail1234.ts.net/#pair=abc123', expiresAt: new Date(Date.now() + 600000).toISOString() }); });
        await flush();
        const said = tsRow()?.textContent ?? '';
        check('success says where the devices open it, in the row', /Shared\./.test(said) && /https:\/\/pc\.tail1234\.ts\.net/.test(said), said.slice(0, 240));
        check('…the address without the one-time code', !/pair=/.test(el.textContent));
        check('…no code appears in "Connect a phone" for a press that did not ask for one', !el.querySelector('[data-qr]'));
        check('…and the status is read again', getDevicesCalls > before);
    });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
