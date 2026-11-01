// tools/settings-nav-gates.mjs — Settings is a list on a phone and a rail on a PC,
// the section is the address, and back goes where a phone user expects.
//
// Run:  node tools/settings-nav-gates.mjs                    (the working tree)
//       node tools/settings-nav-gates.mjs --base origin/main (that ref's files, to
//                                                             watch the cases fail)
//
// WHY. Settings had five tabs as icon + label chips that wrapped onto two rows at
// 390px: "the design is garbage, really weird" (1 Nov 2026). Every phone settings
// app with millions of users (iOS Settings, Android Settings, WhatsApp, Telegram,
// Google's apps) does the same thing instead: a LIST of sections, each a row with
// what it holds, that opens the section as a page of its own; on a wide window the
// list sits beside the open section (Material's list-detail layout). So:
//   narrow (Settings' own width < TWO_PANE_REM) -> /settings is a list of six rows;
//       a row PUSHES /settings#<id>, the browser/phone back returns to the list,
//       and the header's arrow goes UP to the list even from a deep link.
//   wide -> a rail beside the section, General when none is named; choosing in the
//       rail REPLACES the address (a split view, no history per click).
//   old addresses (#data, #search) land on the section that holds them now.
// Plus the four smaller items from the same answer: Devices & security holds the
// phone and password, the AI section says whether an AI is connected, the
// OpenRouter sign-in says what it costs, and the widget row sits under "Ready
// before you get there" with a name that says what it does.
//
// The REAL Settings.tsx is bundled into jsdom under a real BrowserRouter; each
// section component is a stub that shows whether it is the visible one. Width is
// Settings' own clientWidth, stubbed per case.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const baseAt = process.argv.indexOf('--base');
const BASE = baseAt > 0 ? process.argv[baseAt + 1] : null;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

/** A file as it is in the working tree, or at BASE; '' when it does not exist there. */
const read = (rel) => {
    if (!BASE) { try { return readFileSync(join(root, rel), 'utf8'); } catch { return ''; } }
    try { return execFileSync('git', ['show', `${BASE}:${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return ''; }
};

// Every section component, old names included, becomes a stub: a <section> that is
// hidden unless it is the active one, so the gate sees which one is showing.
const stubs = {
    name: 'settings-stubs',
    setup(build) {
        build.onResolve({ filter: /^\.\/settings\/(\w+Settings|settingsSnapshot)$/ }, (args) =>
            ({ path: args.path.split('/').pop(), namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
            loader: 'tsx', resolveDir: root,
            contents: args.path === 'settingsSnapshot'
                ? 'export const useSettingsSnapshot = () => null;'
                : `export default function S({ active }) { return <section data-stub="${args.path}" hidden={!active}>${args.path}</section>; }`,
        }));
        if (!BASE) return;
        build.onLoad({ filter: /[\\/]src[\\/]components[\\/]Settings\.tsx$/ }, () => ({ contents: read('src/components/Settings.tsx'), loader: 'tsx' }));
    },
};

let bundle = null;
try {
    bundle = (await esbuild.build({
        stdin: {
            contents: `
                import Settings from './src/components/Settings';
                import { offerAppBack } from './src/utils/appBack';
                import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
                import { createElement as h, act } from 'react'; import { createRoot } from 'react-dom/client';
                function Spy() { window.__nav = useNavigate(); window.__loc = useLocation(); return null; }
                const App = () => h(BrowserRouter, null, h(Spy), h(Routes, null,
                    h(Route, { path: '/settings', element: h(Settings) }),
                    h(Route, { path: '*', element: h('div', { id: 'elsewhere' }) })));
                const mount = (el) => { const r = createRoot(el); act(() => r.render(h(App))); return r; };
                window.__gate = { mount, act, offerAppBack: typeof offerAppBack === 'function' ? offerAppBack : () => false };`,
            resolveDir: root, loader: 'tsx',
        },
        bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"development"' },
        loader: { '.css': 'empty', '.svg': 'dataurl' },
        plugins: [stubs],
    })).outputFiles[0].text;
} catch (e) {
    // At a base without src/utils/appBack.ts the harness cannot even be built:
    // that is the base failing, not the gate.
    check('the Settings screen and its back-arrow hook bundle', false, (e.errors || []).map(x => x.text).join('; ') || String(e.message || e));
}

const settle = async (w) => { for (let i = 0; i < 6; i++) await new Promise(r => w.setTimeout(r, 0)); };

/** Mount at `url` with Settings `width` px wide. `before` paths are visited first. */
async function show(width, url, before = []) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>',
        { url: `http://localhost${before[0] ?? url}`, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    w.fetch = () => new Promise(() => { });
    Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get() { return this.hasAttribute('data-settings-root') ? width : 0; },
    });
    w.console.warn = () => { }; w.console.error = () => { };
    w.eval(bundle);
    const { mount, act, offerAppBack } = w.__gate;
    const r = mount(w.document.getElementById('root'));
    await act(async () => { await settle(w); });
    // Arrive the way the app does: by navigation from somewhere else.
    for (const p of [...before.slice(1), ...(before.length ? [url] : [])]) {
        await act(async () => { w.__nav(p); await settle(w); });
    }
    const q = (s) => [...w.document.querySelectorAll(s)];
    const s = {
        w, act,
        hash: () => w.location.hash,
        path: () => w.location.pathname,
        depth: () => w.history.length,
        rows: () => q('[data-row][data-section]'),
        tabs: () => q('[data-tab][data-section]'),
        visible: () => q('[data-stub]').filter(e => !e.hidden).map(e => e.dataset.stub),
        title: () => w.document.querySelector('h1')?.textContent.trim(),
        press: async (el) => { await act(async () => { el.click(); await settle(w); }); },
        back: async () => { await act(async () => { w.history.back(); await settle(w); }); },
        appBack: async () => { let took; await act(async () => { took = offerAppBack(); await settle(w); }); return took; },
        close: () => { act(() => r.unmount()); w.close(); },
    };
    return s;
}

const PHONE = 390, PC = 1200;
const SIX = ['general', 'learning', 'ai', 'web', 'devices', 'library'];

if (bundle) {
    // -----------------------------------------------------------------------
    section('a phone opens Settings on a LIST of the six sections');
    {
        const s = await show(PHONE, '/settings');
        const rows = s.rows();
        check('six rows, in order', JSON.stringify(rows.map(r => r.dataset.section)) === JSON.stringify(SIX),
            JSON.stringify(rows.map(r => r.dataset.section)));
        check('no tab rail on a phone', s.tabs().length === 0, `${s.tabs().length} tabs`);
        check('no section is open under the list', s.visible().length === 0, JSON.stringify(s.visible()));
        const ai = rows.find(r => r.dataset.section === 'ai');
        check('a row says what the section holds, not only its name',
            !!ai && /Connect an AI/.test(ai.textContent), ai?.textContent);
        const dev = rows.find(r => r.dataset.section === 'devices');
        check('the phone and the password have a section of their own', !!dev && /password/i.test(dev.textContent), dev?.textContent);
        check('the page title is Settings', s.title() === 'Settings', s.title());

        section('…a row opens its section as a page, and back returns to the list');
        const depth = s.depth();
        if (ai) await s.press(ai);
        check('the address is /settings#ai', s.path() === '/settings' && s.hash() === '#ai', `${s.path()}${s.hash()}`);
        check('it is a NEW history entry (the phone\'s back has somewhere to go)', s.depth() === depth + 1, `${depth} -> ${s.depth()}`);
        check('only that section shows', JSON.stringify(s.visible()) === '["AISettings"]', JSON.stringify(s.visible()));
        check('the list is gone', s.rows().length === 0);
        check('the title is the section\'s name', s.title() === 'AI & Models', s.title());
        await s.back();
        check('the browser/phone back returns to the list', s.hash() === '' && s.rows().length === 6, `${s.hash()} rows=${s.rows().length}`);
        check('…with no section left open', s.visible().length === 0, JSON.stringify(s.visible()));

        section('…the header arrow on a section goes UP to the list');
        const web = s.rows().find(r => r.dataset.section === 'web');
        if (web) await s.press(web);
        const d2 = s.depth();
        const took = await s.appBack();
        check('the arrow is taken by Settings', took === true);
        check('it lands on the list', s.hash() === '' && s.rows().length === 6, `${s.hash()} rows=${s.rows().length}`);
        check('by going back, not by stacking another entry', s.depth() === d2, `${d2} -> ${s.depth()}`);
        const tookOnList = await s.appBack();
        check('on the list the arrow is the header\'s own (Settings does not hold it)', tookOnList === false);
        s.close();
    }

    section('a link from elsewhere straight into a section, on a phone');
    {
        const s = await show(PHONE, '/settings#devices', ['/projects']);
        check('the section opens', JSON.stringify(s.visible()) === '["DevicesSettings"]', JSON.stringify(s.visible()));
        const depth = s.depth();
        const took = await s.appBack();
        check('the arrow goes up to the list, not back out of Settings', took === true && s.path() === '/settings' && s.hash() === '' && s.rows().length === 6,
            `${s.path()}${s.hash()} rows=${s.rows().length}`);
        check('…replacing the deep link, so the history keeps no dead step', s.depth() === depth, `${depth} -> ${s.depth()}`);
        await s.back();
        check('then the phone\'s back leaves Settings for where the reader came from', s.path() === '/projects', s.path());
        s.close();
    }

    section('an address typed or bookmarked by hand');
    {
        const s = await show(PHONE, '/settings');
        await s.act(async () => {
            s.w.history.pushState(null, '', '/settings#library');
            s.w.dispatchEvent(new s.w.PopStateEvent('popstate', { state: null }));
            await settle(s.w);
        });
        check('#library opens Library & about', JSON.stringify(s.visible()) === '["LibrarySettings"]', JSON.stringify(s.visible()));
        s.close();
    }

    // -----------------------------------------------------------------------
    section('a PC shows a rail beside the section');
    {
        const s = await show(PC, '/settings');
        const tabs = s.tabs();
        check('six tabs, in order', JSON.stringify(tabs.map(t => t.dataset.section)) === JSON.stringify(SIX),
            JSON.stringify(tabs.map(t => t.dataset.section)));
        check('no phone list on a PC', s.rows().length === 0);
        check('General is open and marked current', JSON.stringify(s.visible()) === '["GeneralSettings"]'
            && tabs[0]?.getAttribute('aria-current') === 'page', JSON.stringify(s.visible()));
        const depth = s.depth();
        const web = tabs.find(t => t.dataset.section === 'web');
        if (web) await s.press(web);
        check('the rail opens Web & research at #web', s.hash() === '#web' && JSON.stringify(s.visible()) === '["WebSettings"]',
            `${s.hash()} ${JSON.stringify(s.visible())}`);
        check('…REPLACING the address (back leaves Settings, it does not replay the rail)', s.depth() === depth, `${depth} -> ${s.depth()}`);
        check('the title stays Settings', s.title() === 'Settings', s.title());
        const took = await s.appBack();
        check('the header arrow is not taken on a PC', took === false);
        s.close();
    }

    section('addresses from before the six sections');
    for (const [old, now, stub] of [['#data', '#library', 'LibrarySettings'], ['#search', '#web', 'WebSettings']]) {
        const s = await show(PC, `/settings${old}`);
        check(`${old} lands on ${now}`, s.hash() === now && JSON.stringify(s.visible()) === JSON.stringify([stub]),
            `${s.hash()} ${JSON.stringify(s.visible())}`);
        s.close();
    }
}

// ---------------------------------------------------------------------------
section('the layout branches on Settings\' own width, never the viewport');
{
    const src = read('src/components/Settings.tsx');
    check('no sm:/md:/lg:/xl: breakpoint in Settings.tsx', src !== '' && !/\b(sm|md|lg|xl):/.test(src), (src.match(/\b(sm|md|lg|xl):[\w-]+/) || [])[0]);
    check('it measures its own element (useElementWidth)', /useElementWidth\(/.test(src));
    const layout = read('src/components/Layout.tsx');
    check('the header back arrow offers the press to the page first (offerAppBack)', /offerAppBack\(\)/.test(layout));
}

section('every link into Settings names a section that exists');
{
    const ids = new Set([...SIX, 'data', 'search']);  // the two old names are rewritten
    const files = [];
    const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== 'locales') walk(p); } else if (/\.(tsx?|mjs)$/.test(f)) files.push(p); } };
    walk(join(root, 'src'));
    const bad = [];
    for (const f of files) {
        const text = read(relative(root, f).replace(/\\/g, '/'));
        for (const m of text.matchAll(/\/settings#([a-z-]+)/g)) if (!ids.has(m[1])) bad.push(`${relative(root, f)}: #${m[1]}`);
    }
    check('no /settings#<x> with an unknown x', bad.length === 0, bad.join(', '));
    check('the exposed-server banner sends the reader to Devices & security',
        /navigate\(['"]\/settings#devices['"]\)/.test(read('src/components/ExposedBanner.tsx')));
}

section('the phone and the password live in Devices & security');
{
    const dev = read('src/components/settings/DevicesSettings.tsx');
    check('Devices & security renders Other devices and the password', /<OtherDevices\b/.test(dev) && /<SecuritySettings\b/.test(dev));
    const lib = read('src/components/settings/LibrarySettings.tsx');
    check('Library & about holds the version (About), not the devices', /<AboutSection\b/.test(lib) && !/<OtherDevices\b/.test(lib));
    check('…with About above the collapsed records, where a reader looking for the version still reaches it',
        lib.indexOf('<AboutSection') > 0 && lib.indexOf('<AboutSection') < lib.indexOf('tr("Records & diagnostics")'));
}

section('the AI section says whether an AI is connected');
{
    const ai = read('src/components/settings/AISettings.tsx');
    const status = ai.slice(ai.indexOf('id="ai-connection-state"'));
    check('a status line beside Connections', ai.includes('id="ai-connection-state"') && /role="status"/.test(status.slice(0, 200)));
    check('it says "Not connected yet" when nothing is', /tr\("Not connected yet"\)/.test(ai));
    check('it names the provider when connected', /tr\("Connected: \{\{name\}\}", \{ name: connectionName \}\)/.test(ai));
    check('before the list is read it says nothing (no false "Not connected yet")', /SavedConnection \| null \| undefined/.test(ai));
}

section('the OpenRouter sign-in says what it costs');
{
    const dlg = read('src/components/settings/connections/AddConnectionDialog.tsx');
    check('one plain line on credit, per-model prices and free models', /OpenRouter has no subscription: you add credit on openrouter\.ai/.test(dlg) && /a few are free, with a daily limit/.test(dlg));
    check('…and how to cap spending', /set a credit limit on its key there/.test(dlg));
}

section('the widget row is a "ready before you get there" choice, named for what it does');
{
    const feed = read('src/components/settings/FeedSettingsPanel.tsx');
    const ready = feed.indexOf('tr("Ready before you get there")');
    const widget = feed.indexOf("boolRow('feed_widgets'");
    check('the row sits under "Ready before you get there"', ready > 0 && widget > ready, `heading@${ready} row@${widget}`);
    check('its name says it builds ahead', feed.includes(`tr("Build a topic's widget ahead of time")`));
    check('the old name is gone', !feed.includes('tr("Interactive widgets in lessons")'));
}

section('SearXNG and the search keys are behind "Advanced search"');
{
    const web = read('src/components/settings/WebAnswersSection.tsx');
    const adv = web.indexOf('title={tr("Advanced search")}');
    check('an Advanced search disclosure', adv > 0);
    check('the SearXNG field is inside it', adv > 0 && web.indexOf('searxngInputRef}', adv) > adv);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
