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
const FILES = ['ui/SettingRow', 'ui/Switch', 'OtherDevices', 'settings/FeedSettingsPanel', 'settings/LearningSettings'];
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
            export { default as OtherDevices } from '${from('OtherDevices')}';
            export { default as FeedSettingsPanel } from '${from('settings/FeedSettingsPanel')}';
            export { default as LearningSettings } from '${from('settings/LearningSettings')}';`,
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
const { SettingRow, Switch, OtherDevices, FeedSettingsPanel, LearningSettings } = require(out);
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
    let served = false; // what `tailscale serve` reports on this computer
    globalThis.__api = {
        getDevices: async () => { getDevicesCalls++; return { devices: [], tailscale: { login: 'you@example.com', on: true, served } }; },
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
        check('control: the two rows are found apart', !!tsRow() && !!phoneRow() && tsRow() !== phoneRow());
        check('nothing beside an ON switch asks to "Turn it on"', !/Turn it on/.test(el.textContent), tsRow()?.textContent.slice(0, 200));
        const named = byText(/Share it on Tailscale/);
        check('the row\'s button says what it does: Share it on Tailscale', !!named && tsRow()?.contains(named));
        // Under any name, the row's one button is the press the rest is about.
        // After a failed press the same button reads "Try again".
        const rowButton = () => named ? [...(tsRow()?.querySelectorAll('button') ?? [])].find((b) => /Share it on Tailscale|Try again/.test(b.textContent))
            : [...(tsRow()?.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('role') !== 'switch');
        const share = rowButton();
        if (!share) { check('the row has a button to press', false); return; }

        await act(async () => { share.click(); });
        check('while it works, the row\'s own button spins', share.getAttribute('aria-busy') === 'true');
        const showCode = byText(/Show code/);
        check('…and "Show code" in the row above does not', !!showCode && showCode.getAttribute('aria-busy') !== 'true', showCode?.outerHTML.slice(0, 120));
        // The server makes a pairing code for the shared address too, and keeps
        // one code at a time: a code drawn now would be retired by the answer.
        check('…nor can it be pressed until the share has answered', !!showCode?.disabled, showCode?.outerHTML.slice(0, 120));

        await act(async () => { answerServe({ url: null, tailscale: true, failed: true, command: null, problem: null }); });
        await flush();
        check('no answer from Tailscale is said in the Tailscale row', /didn't answer/.test(tsRow()?.textContent ?? ''), tsRow()?.textContent.slice(0, 240));
        check('…and "Show code" can be pressed again', showCode?.isConnected && !showCode.disabled);
        check('…and the row\'s button now says Try again', /Try again/.test(rowButton()?.textContent ?? '') && !byText(/Share it on Tailscale/), rowButton()?.textContent);

        const press = async () => {
            const b = rowButton();
            if (!b) return false;
            await act(async () => { b.click(); });
            return true;
        };
        // Serve not turned on for the account: Tailscale's own page, as a link button beside Try again.
        if (!await press()) { check('after no answer, the press can be tried again', false); return; }
        await act(async () => { answerServe({ url: null, tailscale: true, failed: true, command: 'tailscale serve --bg --https=443 http://127.0.0.1:3282', problem: { kind: 'enable', link: 'https://login.tailscale.com/f/serve?node=nX7' } }); });
        await flush();
        const enableLink = [...(tsRow()?.querySelectorAll('a') ?? [])].find((a) => /Turn on Serve/.test(a.textContent));
        check('Serve not turned on: a Turn on Serve link to Tailscale\'s own page, in the row',
            enableLink?.getAttribute('href') === 'https://login.tailscale.com/f/serve?node=nX7' && enableLink.getAttribute('target') === '_blank', tsRow()?.textContent.slice(0, 240));
        check('…saying to allow it there, then press Try again, with no command to run',
            /allow it on the page that opens, then press Try again/.test(tsRow()?.textContent ?? '') && !/tailscale serve --bg/.test(tsRow()?.textContent ?? ''), tsRow()?.textContent.slice(0, 240));
        if (!await press()) { check('after Serve was turned on, the press can be tried again', false); return; }
        await act(async () => { answerServe({ url: null, tailscale: true, failed: true, command: 'tailscale serve --bg --https=8443 http://127.0.0.1:3282', problem: { kind: 'denied', reason: 'Access denied: serve config denied' } }); });
        await flush();
        check('a refusal shows the command to run IN the Tailscale row', /tailscale serve --bg/.test(tsRow()?.textContent ?? ''), tsRow()?.textContent.slice(0, 240));
        check('…says to press Try again once it has run', /press Try again/.test(tsRow()?.textContent ?? ''), tsRow()?.textContent.slice(0, 240));
        check('…with what Tailscale itself said', /Tailscale said: Access denied: serve config denied/.test(tsRow()?.textContent ?? ''), tsRow()?.textContent.slice(0, 240));
        check('…and the enable link from the press before is gone', ![...(tsRow()?.querySelectorAll('a') ?? [])].some((a) => /Turn on Serve/.test(a.textContent)));
        check('…and opens nothing in "Connect a phone"', !/tailscale serve --bg|Not now/.test(phoneRow()?.textContent ?? '') && /Show code/.test(phoneRow()?.textContent ?? ''),
            phoneRow()?.textContent.slice(0, 240));

        const before = getDevicesCalls;
        if (!await press()) { check('after a refusal, the press can be tried again', false); return; }
        served = true;
        await act(async () => { answerServe({ url: 'https://pc.tail1234.ts.net/#pair=abc123', expiresAt: '2026-11-01T12:10:00.000Z' }); });
        await flush();
        const said = tsRow()?.textContent ?? '';
        check('success says where the devices open it, in the row', /Shared\./.test(said) && /https:\/\/pc\.tail1234\.ts\.net/.test(said), said.slice(0, 240));
        check('…the address without the one-time code', !/pair=/.test(el.textContent));
        check('…no code appears in "Connect a phone" for a press that did not ask for one', !el.querySelector('[data-qr]'));
        check('…and the status is read again', getDevicesCalls > before);
        const focused = doc.activeElement;
        check('…focus goes to the answer that replaced the button, not to the page', !!focused && focused !== doc.body && tsRow()?.contains(focused) && /Shared\./.test(focused.textContent),
            focused?.outerHTML?.slice(0, 120));

        // Sharing was turned off on this computer by hand; the next read says so.
        served = false;
        await act(async () => { window.dispatchEvent(new window.Event('terramentor:devices-changed')); });
        await flush();
        check('once the app is no longer shared, the row stops saying "Shared." and offers the press again',
            !/Shared\./.test(tsRow()?.textContent ?? '') && !!rowButton(), tsRow()?.textContent.slice(0, 240));
    });
}

// ---------------------------------------------------------------------------
section('the Tailscale row with its switch off (a new library) does not say the devices are let in');
{
    globalThis.__api = {
        getDevices: async () => ({ devices: [], tailscale: { login: 'you@example.com', on: false, served: true } }),
    };
    globalThis.__setState({ authEnabled: false, showConfirm: async () => false, addToast() { } });
    await mounted('OtherDevices, switch off', () => h(OtherDevices, { active: true }), async (el) => {
        await flush();
        const sw = el.querySelector('[role="switch"]');
        const row = sw?.closest('.px-4.py-3');
        check('control: the switch is there and off', sw?.getAttribute('aria-checked') === 'false');
        const text = row?.textContent ?? '';
        // The sentence that is true only while the switch is on.
        check('the row does not say "Your devices … open this app without a password"',
            !/Your devices signed in to Tailscale as you@example\.com open this app/.test(text), text.slice(0, 240));
        check('…it says the switch would let them in', /Turn (it )?on/.test(text) && /you@example\.com/.test(text), text.slice(0, 240));
    });
}

// ---------------------------------------------------------------------------
section('a switch whose save fails goes where the stored value is, whatever order the answers come in');
{
    // On its own (it has no imports), so `--base` can say it is not there yet.
    let switchSaver = null;
    try {
        const js = esbuild.transformSync(read('src/utils/switchSaver.ts'), { loader: 'ts', format: 'cjs' }).code;
        const m = { exports: {} };
        new Function('module', 'exports', js)(m, m.exports);
        switchSaver = m.exports.switchSaver;
    } catch { /* not in this tree */ }
    check('control: src/utils/switchSaver.ts is there', typeof switchSaver === 'function');
    if (switchSaver) {
        const deferred = () => { let ok, no; const p = new Promise((a, b) => { ok = a; no = b; }); return { p, ok, no }; };
        const settle = () => new Promise((r) => setTimeout(r, 0));
        // Starts OFF; presses ON (a), then OFF (b); answers as given; returns what the switch shows at the end.
        const run = async (answers) => {
            let shown = false;
            const save = switchSaver();
            const a = deferred(), b = deferred();
            const pa = save(true, (v) => { shown = v; }, () => a.p).catch(() => { });
            const pb = save(false, (v) => { shown = v; }, () => b.p).catch(() => { });
            for (const [which, ok] of answers) { (which === 'a' ? a : b)[ok ? 'ok' : 'no'](); await settle(); }
            await Promise.all([pa, pb]);
            return shown;
        };
        check('on, off, both refused: OFF, as stored (putting each press back left it ON)', await run([['a', false], ['b', false]]) === false);
        check('on refused, off taken: OFF', await run([['a', false], ['b', true]]) === false);
        check('on taken, off refused: ON', await run([['a', true], ['b', false]]) === true);
        check('off refused first, then on taken: ON', await run([['b', false], ['a', true]]) === true);
        let shown = false;
        const one = switchSaver();
        await one(true, (v) => { shown = v; }, async () => { throw new Error('offline'); }).catch(() => { });
        check('one press refused: back to OFF', shown === false);
        let rejected = false;
        await one(true, (v) => { shown = v; }, async () => { }).catch(() => { rejected = true; });
        check('one press taken: stays ON, and the caller hears no error', shown === true && !rejected);
    }
}

// ---------------------------------------------------------------------------
section('Settings → Visuals: no live switch before the saved list is read, a refused save puts the card back, saves go in order, less movement stops the widget demo');
{
    // The panel draws every kind's sample through the real renderers, so those
    // (and the sample animations) are stubbed; what is mounted is the panel's own
    // state: the cards, the switches, the saves.
    const panelScratch = mkdtempSync(join(root, 'node_modules', '.cache', 'visual-kinds-'));
    const panelOut = join(panelScratch, 'bundle.cjs');
    // --base: the panel as it was at <ref>, its imports still meaning the folder it came from.
    const panelEntry = BASE ? join(panelScratch, 'VisualKindsPanel.tsx') : join(root, 'src/components/settings/VisualKindsPanel.tsx');
    if (BASE) writeFileSync(panelEntry, read('src/components/settings/VisualKindsPanel.tsx'));
    const panelStubs = {
        ...stubs,
        'store': `import { useSyncExternalStore } from 'react';
            const g = globalThis;
            export const themeKeyOf = () => 'light';
            export const useStore = (sel) => sel({ theme: 'light', themeTint: '', accentColor: '#2563eb', addToast: (...a) => g.__toasts.push(a) });`,
        'registry': `export const getVisualKind = (k) => k; export const loadRenderer = () => new Promise(() => { });`,
        'palette': `export const readVisualPalette = () => ({ accent: '#2563eb', accentFg: '#1d4ed8', dark: false, bg: '#fff', fg: '#000', muted: '#888', border: '#ddd' });`,
        'drill': `import { createElement } from 'react'; export const DrillLauncher = () => createElement('button', { type: 'button' }, 'drill');`,
        'reveal': `export const reducedMotion = () => !!globalThis.__reduced; export const playSampleArrival = () => () => { };
            export const nudgeSketch = () => { }; export const muteSketch = () => { }; export const playClass = () => () => { };`,
        'still': `export const holdSampleStill = () => { }; export const stillAtNextTop = () => () => { };`,
    };
    const panelStubPlugin = {
        name: 'panel-stubs',
        setup(b) {
            const to = (re, name) => b.onResolve({ filter: re }, () => ({ path: name, namespace: 'stub' }));
            to(/^react-i18next$/, 'react-i18next');
            to(/^(\.\.\/)+store$/, 'store');
            to(/^(\.\.\/)+i18n$/, 'i18n');
            to(/^(\.\.\/)+api$/, 'api');
            to(/^\.\.\/visuals\/registry$/, 'registry');
            to(/^\.\.\/visuals\/palette$/, 'palette');
            to(/^\.\.\/drills\/DrillLauncher$/, 'drill');
            to(/^\.\/sampleReveal$/, 'reveal');
            to(/^\.\/sampleStill$/, 'still');
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: panelStubs[args.path], loader: 'js', resolveDir: root }));
            b.onResolve({ filter: /^\.\.?\// }, (args) => {
                if (!BASE || args.importer.replace(/\\/g, '/') !== panelEntry.replace(/\\/g, '/')) return undefined;
                return b.resolve(args.path, { resolveDir: join(root, 'src', 'components', 'settings'), kind: args.kind });
            });
        },
    };
    await esbuild.build({
        entryPoints: [panelEntry],
        bundle: true, format: 'cjs', platform: 'node', outfile: panelOut,
        jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
        packages: 'external',
        define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
        plugins: [panelStubPlugin],
        logLevel: 'silent',
    });
    const VisualKindsPanel = require(panelOut).default;
    rmSync(panelScratch, { recursive: true, force: true });

    const deferred = () => { let ok, no; const p = new Promise((a, b) => { ok = a; no = b; }); return { p, ok, no }; };
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const kindSwitch = (el, id) => el.querySelector(`#visual-kind-${id}`);
    const realRaf = globalThis.requestAnimationFrame;
    let rafCalls = 0;
    globalThis.requestAnimationFrame = (f) => { rafCalls++; return realRaf(f); };
    globalThis.__toasts = [];

    try {
        // The saved list cannot be read: nothing may be written over it.
        let sets = [];
        globalThis.__api = { getSettings: async () => { throw new Error('offline'); }, setSetting: async (...a) => { sets.push(a); } };
        await mounted('VisualKindsPanel (settings unreadable)', () => h(VisualKindsPanel, { active: true }), async (el) => {
            await settle();
            const switches = [...el.querySelectorAll('[role="switch"]')];
            check('control: the eight cards and the any-model switch are drawn', switches.length === 9, String(switches.length));
            check('while the saved list is unread no switch is live', switches.every((s) => s.disabled), switches.filter((s) => !s.disabled).map((s) => s.id).join(', '));
            check('…and the failed read says so, instead of greyed cards with no reason', __toasts.length === 1 && __toasts[0][0] === 'error', JSON.stringify(__toasts));
            await act(async () => { kindSwitch(el, 'p5')?.click(); });
            await settle();
            check('…and a press on a card writes nothing over the saved list', sets.length === 0, JSON.stringify(sets));
        });

        // A saved list is read; every save is refused.
        sets = [];
        const saved = () => ({ visual_kinds_off: 'p5,widget', visual_tier: 'full' });
        globalThis.__api = { getSettings: async () => saved(), setSetting: async (...a) => { sets.push(a); throw new Error('server down'); } };
        globalThis.__toasts = [];
        await mounted('VisualKindsPanel (saves refused)', () => h(VisualKindsPanel, { active: true }), async (el) => {
            await settle();
            check('control: the saved list is shown (Simulations and Widgets off, Diagrams on)',
                kindSwitch(el, 'p5')?.checked === false && kindSwitch(el, 'widget')?.checked === false && kindSwitch(el, 'mermaid')?.checked === true);
            check('control: once it is read the switches are live', !kindSwitch(el, 'mermaid')?.disabled);
            await act(async () => { kindSwitch(el, 'mermaid')?.click(); });
            await settle();
            check('control: the save was tried and refused', sets.length === 1 && __toasts.length === 1, `${sets.length} write(s), ${__toasts.length} toast(s)`);
            check('a refused save puts the card back on (what is stored)', kindSwitch(el, 'mermaid')?.checked === true);
            check('…and leaves the saved ones as they were', kindSwitch(el, 'p5')?.checked === false && kindSwitch(el, 'widget')?.checked === false);
        });

        // Two quick presses: the writes go one after the other, the last press last.
        sets = [];
        const first = deferred();
        globalThis.__api = {
            getSettings: async () => saved(),
            setSetting: (...a) => { sets.push(a); return sets.length === 1 ? first.p : Promise.resolve(); },
        };
        await mounted('VisualKindsPanel (two presses)', () => h(VisualKindsPanel, { active: true }), async (el) => {
            await settle();
            await act(async () => { kindSwitch(el, 'mermaid')?.click(); });
            await act(async () => { kindSwitch(el, 'plot')?.click(); });
            check('the second save waits for the first (one write in flight)', sets.length === 1, `${sets.length} write(s) started`);
            first.ok();
            await settle();
            check('…then goes out carrying both presses, so the last one stored is the latest',
                sets.length === 2 && sets[1][1] === 'p5,widget,mermaid,plot', JSON.stringify(sets.map((s) => s[1])));
        });

        // The any-model switch pressed while a kind's save is still out: the
        // kind's write, which migrates a retired tier, must not land after it.
        sets = [];
        const held = deferred();
        globalThis.__api = {
            getSettings: async () => ({ visual_kinds_off: '', visual_tier: 'auto' }),
            setSetting: (...a) => { sets.push(a); return sets.length === 1 ? held.p : Promise.resolve(); },
        };
        await mounted('VisualKindsPanel (any-model behind a kind)', () => h(VisualKindsPanel, { active: true }), async (el) => {
            await settle();
            await act(async () => { kindSwitch(el, 'mermaid')?.click(); });
            await act(async () => { el.querySelector('#visual-any-model')?.click(); });
            held.ok();
            await settle();
            await settle();
            const tiers = sets.filter((s) => s[0] === 'visual_tier').map((s) => s[1]);
            check('the learner\'s last press on the any-model switch is the last write to the tier (ON = full)',
                tiers.length > 0 && tiers[tiers.length - 1] === 'full', JSON.stringify(sets));
        });

        // Less movement: the widget sample's pointer loop does not run.
        sets = [];
        globalThis.__api = { getSettings: async () => ({}), setSetting: async () => { } };
        globalThis.__reduced = false;
        rafCalls = 0;
        await mounted('VisualKindsPanel (normal motion)', () => h(VisualKindsPanel, { active: true }), async () => {
            await settle();
            check('control: with normal motion the widget sample\'s loop runs', rafCalls > 0, `${rafCalls} frame request(s)`);
        });
        globalThis.__reduced = true;
        rafCalls = 0;
        await mounted('VisualKindsPanel (reduced motion)', () => h(VisualKindsPanel, { active: true }), async () => {
            await settle();
            check('a reader who asked for less movement gets no running widget demo', rafCalls === 0, `${rafCalls} frame request(s)`);
        });
    } finally {
        globalThis.requestAnimationFrame = realRaf;
        globalThis.__reduced = false;
        globalThis.__api = undefined;
    }
}

// ---------------------------------------------------------------------------
section('a stored 0 in the feed settings is shown as 0, not as the default');
{
    globalThis.__api = {
        getSettings: async () => ({ feed_recall_per_batch: '0', feed_due_per_day: '0', feed_new_per_project: '0', feed_focus_total: '8', feed_max_parts: '0', feed_focus_per_project: '99' }),
        setSetting: async () => { },
    };
    globalThis.__setState({ addToast() { } });
    await mounted('FeedSettingsPanel', () => h(FeedSettingsPanel, { active: true }), async (el) => {
        await flush();
        const field = (key) => el.querySelector(`#feed-${key}`)?.value;
        check('control: a stored 8 is shown as 8', field('feed_focus_total') === '8', field('feed_focus_total'));
        check('"Recall questions per batch" stored as 0 reads 0 (0 turns it off)', field('feed_recall_per_batch') === '0', field('feed_recall_per_batch'));
        check('"Due per day" stored as 0 reads 0', field('feed_due_per_day') === '0', field('feed_due_per_day'));
        check('"New per project" stored as 0 reads 0', field('feed_new_per_project') === '0', field('feed_new_per_project'));
        // The server clamps a stored number into the same bounds, so a 0 where the
        // lower bound is 1 is read as 1 there and is shown as 1 here.
        check('a part count stored as 0 (lower bound 1) reads 1, as the server reads it', field('feed_max_parts') === '1', field('feed_max_parts'));
        check('a number stored above its upper bound reads as the bound', field('feed_focus_per_project') === '10', field('feed_focus_per_project'));
    });
}

// ---------------------------------------------------------------------------
section('a mastery number that was clamped or left empty goes back into its field');
{
    const saved = [];
    let offline = false;
    globalThis.__api = { setSetting: async (k, v) => { if (offline) throw new Error('offline'); saved.push([k, v]); } };
    globalThis.__setState({ addToast() { } });
    const type = async (input, value) => {
        await act(async () => {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
            input.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
        await act(async () => { input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
        await flush();
    };
    await mounted('LearningSettings', () => h(LearningSettings, { active: true, snapshot: { ok: true, values: {} } }), async (el) => {
        await flush();
        const byLabel = (re) => [...el.querySelectorAll('label')].find((l) => re.test(l.textContent))?.querySelector('input');
        const threshold = byLabel(/Mastery estimate to pass/);
        const pass = byLabel(/Mastery check score to pass/);
        const decay = byLabel(/Days before a proven topic fades/);
        if (!threshold || !pass || !decay) { check('the four mastery fields are found', false); return; }
        const sentence = () => [...el.querySelectorAll('p')].find((p) => /counts as proven/.test(p.textContent))?.textContent ?? '';

        await type(threshold, '150');
        check('150% is saved as 100% and the field says 100', saved.some(([k, v]) => k === 'mastery_threshold' && v === '1') && threshold.value === '100', threshold.value);
        await type(decay, '999');
        check('999 days is saved as 365 and the field says 365', saved.some(([k, v]) => k === 'decay_days' && v === '365') && decay.value === '365', decay.value);
        check('…and so does the sentence above it', /fading after 365 days/.test(sentence()), sentence());
        saved.length = 0;
        await type(threshold, '');
        check('an empty percentage is saved as the default 85%, not 0', saved.some(([k, v]) => k === 'mastery_threshold' && v === '0.85'), JSON.stringify(saved));
        check('…and the field says 85', threshold.value === '85', threshold.value);
        await type(pass, '');
        check('an empty pass score is saved as the default 80%', saved.some(([k, v]) => k === 'mastery_check_pass' && v === '0.8') && pass.value === '80', `${JSON.stringify(saved)} ${pass.value}`);

        // The server reads a stored 0 as "unset" and runs 85% / 80% (settingsStore.js),
        // so the screen cannot offer a 0: it would say "proven at 0%" over a gate at 85%.
        check('both pass fields stop at 1', threshold.min === '1' && pass.min === '1', `${threshold.min} ${pass.min}`);
        saved.length = 0;
        await type(threshold, '0');
        check('0% to pass is saved as 1%, never as 0', saved.some(([k, v]) => k === 'mastery_threshold' && v === '0.01') && !saved.some(([, v]) => v === '0') && threshold.value === '1', `${JSON.stringify(saved)} ${threshold.value}`);
        check('…and the sentence says 1', /proven at 1% estimated/.test(sentence()), sentence());
        await type(pass, '0');
        check('a pass score of 0 is saved as 1%, never as 0', saved.some(([k, v]) => k === 'mastery_check_pass' && v === '0.01') && pass.value === '1', `${JSON.stringify(saved)} ${pass.value}`);

        // A save that failed leaves what was typed, not a clamped number that was never stored.
        offline = true;
        await type(threshold, '150');
        check('a failed save does not put a clamped number in the field', threshold.value === '150', threshold.value);
        offline = false;
    });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
