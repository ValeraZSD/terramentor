// tools/client-utils-gates.mjs — three small client utilities, each run for real.
//
// Run:  node tools/client-utils-gates.mjs
//
// Deterministic, no model, no network. Each section bundles the real source with
// esbuild and drives it in jsdom (or, for the language switch, with stand-ins for
// Vite's locale chunks), because every fault here is one of ORDER or of what
// happens after a gesture ends badly, which a read of the source cannot show.
//
//   1. The swipe carousel: a touch the browser cancels mid-drag never fires
//      `touchend`, so the three-panel track used to stay half-way across the
//      viewport. A cancelled drag must return, and must never page.
//   2. Copy without the async Clipboard API: the temporary field takes focus
//      and must give it back, and must leave the page even when `execCommand`
//      throws, or a keyboard user lands outside their dialog.
//   3. Switching the interface language: two picks can overlap, and the older
//      chunk arriving last must not win; a chunk that failed to load must not
//      leave `<html lang>`, `Intl` and the device cache naming a language the
//      words are not in.
//
// Every global a section sets is put back in its `finally`.

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { build } = await import('esbuild');

const repo = fileURLToPath(new URL('..', import.meta.url));
// Under node_modules so the bundles resolve `react` and `i18next` from the repo.
const cache = join(repo, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'client-utils-gates-'));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

const g = globalThis;
const GLOBALS = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
    'ResizeObserver', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', 'getComputedStyle'];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(g, k)]));
const setGlobals = (values) => {
    for (const [k, value] of Object.entries(values)) {
        Object.defineProperty(g, k, { value, configurable: true, writable: true });
    }
};
const restoreGlobals = () => {
    for (const [k, d] of Object.entries(saved)) {
        if (d) Object.defineProperty(g, k, d); else delete g[k];
    }
};
const bundle = async (name, options) => {
    const outfile = join(scratch, `${name}.mjs`);
    await build({
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
        packages: 'external', jsx: 'automatic', ...options,
    });
    return import(pathToFileURL(outfile).href);
};
const newDom = () => new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });

try {
    // -----------------------------------------------------------------------
    section('a touch the browser cancels mid-drag returns the track and never pages');
    {
        const { window } = newDom();
        const doc = window.document;
        // jsdom lays nothing out; the carousel reads its viewport's width.
        Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
        setGlobals({
            window, document: doc, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
            MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
            ResizeObserver: class { observe() {} disconnect() {} },
        });
        const carousel = await bundle('swipe', {
            stdin: {
                contents: `
                    import * as React from 'react';
                    import { createRoot } from 'react-dom/client';
                    import { useSwipeCarousel } from './src/hooks/useSwipeCarousel';
                    export function mount(el, calls) {
                        const root = createRoot(el);
                        function Probe() {
                            const c = useSwipeCarousel(() => calls.push('prev'), () => calls.push('next'));
                            return React.createElement('div', { ref: c.viewportRef },
                                React.createElement('div', { id: 'track', ...c.trackProps }));
                        }
                        React.act(() => root.render(React.createElement(Probe)));
                        return () => React.act(() => root.unmount());
                    }
                    export const act = (fn) => React.act(fn);`,
                resolveDir: repo, loader: 'tsx',
            },
        });

        const host = doc.createElement('div');
        doc.body.append(host);
        const calls = [];
        const unmount = carousel.mount(host, calls);
        const track = doc.getElementById('track');
        const fire = (type, x = 0, y = 0, extra = {}) => carousel.act(() => {
            const ev = new window.Event(type, { bubbles: true, cancelable: true });
            ev.touches = type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }];
            Object.assign(ev, extra);
            track.dispatchEvent(ev);
        });
        const at = () => track.style.transform;
        const settle = () => fire('transitionend', 0, 0, { propertyName: 'transform' });

        check('at rest the current panel is the one on screen', at() === 'translateX(-300px)', at());

        fire('touchstart', 100, 100);
        fire('touchmove', 120, 100);
        fire('touchmove', -100, 100);
        check('a sideways drag follows the finger', at() === 'translateX(-500px)', at());

        fire('touchcancel');
        check('a cancelled drag goes back to rest, animated',
            at() === 'translateX(-300px)' && /transform/.test(track.style.transition), `${at()} / ${track.style.transition}`);
        settle();
        check('...and a drag past the paging distance, once cancelled, pages nowhere', calls.length === 0, calls.join(','));

        fire('touchstart', 100, 100);
        fire('touchmove', 120, 100);
        fire('touchmove', 70, 100);
        check('the next drag starts from rest', at() === 'translateX(-330px)', at());
        fire('touchend');
        settle();
        check('a short drag that ends normally still snaps back without paging', at() === 'translateX(-300px)' && calls.length === 0, `${at()} / ${calls.join(',')}`);

        fire('touchstart', 100, 100);
        fire('touchmove', 0, 100);
        fire('touchend');
        settle();
        check('a long drag that ends normally still pages', calls.join(',') === 'next', calls.join(','));

        // A cancel while the track is already at its start offset has nothing to
        // animate, so no transition would end and the carousel would ignore every
        // later touch.
        fire('touchstart', 100, 100);
        fire('touchmove', 110, 100);
        fire('touchmove', 100, 100);
        fire('touchcancel');
        fire('touchstart', 100, 100);
        fire('touchmove', 120, 100);
        fire('touchmove', 70, 100);
        check('a cancel at the start offset does not freeze the carousel', at() === 'translateX(-330px)', at());
        unmount();
    }
    restoreGlobals();

    // -----------------------------------------------------------------------
    section('an element\'s measured width is one quantity, whichever event measured it');
    {
        const { window } = newDom();
        const doc = window.document;
        // jsdom lays nothing out: 332px including 16px padding on each side.
        Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 332 });
        let observed = null;
        setGlobals({
            window, document: doc, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
            MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
            getComputedStyle: window.getComputedStyle.bind(window),
            ResizeObserver: class { constructor(cb) { observed = cb; } observe() {} disconnect() {} },
        });
        const probe = await bundle('width', {
            stdin: {
                contents: `
                    import * as React from 'react';
                    import { createRoot } from 'react-dom/client';
                    import { useElementWidth } from './src/hooks/useElementWidth';
                    export function mount(el, seen) {
                        const root = createRoot(el);
                        function Probe() {
                            const ref = React.useRef(null);
                            const w = useElementWidth(ref);
                            seen.push(w);
                            return React.createElement('div', { ref, style: { padding: '0 16px' } });
                        }
                        React.act(() => root.render(React.createElement(Probe)));
                        return () => React.act(() => root.unmount());
                    }
                    export const act = (fn) => React.act(fn);`,
                resolveDir: repo, loader: 'tsx',
            },
        });
        const host = doc.createElement('div');
        doc.body.append(host);
        const seen = [];
        const unmount = probe.mount(host, seen);
        check('the first measure is the content width, as the observer reports it', seen.at(-1) === 300, String(seen.at(-1)));
        probe.act(() => observed([{ contentRect: { width: 300, height: 0 } }]));
        probe.act(() => window.dispatchEvent(new window.Event('resize')));
        check('a window resize after an observer callback does not add the padding back', seen.at(-1) === 300, seen.join(','));
        unmount();
    }
    restoreGlobals();

    // -----------------------------------------------------------------------
    section('copying without the Clipboard API gives focus back and leaves nothing behind');
    {
        const { window } = newDom();
        const doc = window.document;
        // Browsers focus a field that `select()` is called on; jsdom does not.
        window.HTMLTextAreaElement.prototype.select = function select() { this.focus(); };
        setGlobals({ window, document: doc, HTMLElement: window.HTMLElement });
        const { copyText } = await bundle('clipboard', { entryPoints: [join(repo, 'src/utils/clipboard.ts')] });

        const button = doc.createElement('button');
        button.id = 'copy';
        doc.body.append(button);
        const fields = () => doc.querySelectorAll('textarea').length;

        let heldFocus = false;
        doc.execCommand = () => { heldFocus = doc.activeElement?.tagName === 'TEXTAREA'; return true; };
        button.focus();
        const ok = await copyText('hello');
        check('the copy reports success', ok === true);
        check('the temporary field had the selection while it copied', heldFocus);
        check('focus is back on the button that was pressed', doc.activeElement === button, doc.activeElement?.tagName);
        check('the temporary field is gone', fields() === 0, `${fields()} left`);

        doc.execCommand = () => { throw new Error('refused'); };
        button.focus();
        const failed = await copyText('hello');
        check('a throwing copy reports failure', failed === false);
        check('...leaves no field in the page', fields() === 0, `${fields()} left`);
        check('...and still gives focus back', doc.activeElement === button, doc.activeElement?.tagName);

        doc.execCommand = () => false;
        button.blur();
        check('with nothing focused a refused copy reports failure and leaves the page clean',
            (await copyText('hello')) === false && fields() === 0 && doc.activeElement === doc.body);
    }
    restoreGlobals();

    // -----------------------------------------------------------------------
    section('switching the interface language: the newest pick wins, a failed chunk is not shown');
    {
        const { window } = newDom();
        const doc = window.document;
        const store = new Map();
        const storage = {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
        };
        setGlobals({ document: doc, localStorage: storage });

        // Vite's `import.meta.glob`, replaced at build time, is the one thing the
        // runtime takes from outside; here each locale is a chunk the test
        // releases, rejects or never asks for.
        const defer = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
        const chunks = {};
        g.__localeLoaders = () => new Proxy({}, {
            get: (_, key) => {
                const code = /locales\/([a-z]+)\.json$/.exec(String(key))?.[1];
                return code && chunks[code] ? () => chunks[code].promise.then(() => ({ default: { '{{n}} items': `${code} {{n}}` } })) : undefined;
            },
        });
        const i18n = await bundle('i18n', {
            entryPoints: [join(repo, 'src/i18n/index.ts')],
            define: { 'import.meta.glob': 'globalThis.__localeLoaders' },
        });
        await i18n.i18nReady;
        const state = () => `${i18n.currentLocale()} / lang ${doc.documentElement.lang} / cached ${storage.getItem(i18n.LANGUAGE_STORAGE_KEY)}`;

        // German is picked, then French; French arrives first, German last.
        chunks.de = defer();
        chunks.fr = defer();
        const first = i18n.setUiLanguage('de');
        const second = i18n.setUiLanguage('fr');
        chunks.fr.resolve();
        await second;
        chunks.de.resolve();
        await first;
        check('a later pick is not overwritten by an earlier chunk arriving after it',
            i18n.currentLocale() === 'fr' && doc.documentElement.lang === 'fr' && storage.getItem(i18n.LANGUAGE_STORAGE_KEY) === 'fr', state());

        // The same two picks arriving in order are the control.
        chunks.pt = defer();
        chunks.ru = defer();
        const third = i18n.setUiLanguage('pt');
        const fourth = i18n.setUiLanguage('ru');
        chunks.pt.resolve();
        await third;
        chunks.ru.resolve();
        await fourth;
        check('picks whose chunks arrive in order end on the last one', i18n.currentLocale() === 'ru' && doc.documentElement.lang === 'ru', state());

        // A chunk that fails to load leaves English words.
        chunks.ja = defer();
        const failing = i18n.setUiLanguage('ja');
        chunks.ja.reject(new Error('offline'));
        await failing;
        check('a chunk that failed to load leaves the interface, <html lang> and Intl on English',
            i18n.currentLocale() === 'en' && doc.documentElement.lang === 'en', state());
        check('...and is not saved as the device language', storage.getItem(i18n.LANGUAGE_STORAGE_KEY) !== 'ja', state());

        // The next try is not poisoned by the failure.
        chunks.ja = defer();
        const retry = i18n.setUiLanguage('ja');
        chunks.ja.resolve();
        await retry;
        check('picking the language again after the failure loads it',
            i18n.currentLocale() === 'ja' && doc.documentElement.lang === 'ja' && storage.getItem(i18n.LANGUAGE_STORAGE_KEY) === 'ja', state());

        await i18n.setUiLanguage('en');
        check('English needs no chunk', i18n.currentLocale() === 'en' && storage.getItem(i18n.LANGUAGE_STORAGE_KEY) === 'en', state());
        delete g.__localeLoaders;
    }
} finally {
    restoreGlobals();
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
