// tools/search-result-gates.mjs — a search result does one predictable thing.
//
// Run:  node tools/search-result-gates.mjs          (the working tree)
//       node tools/search-result-gates.mjs --head   (HEAD's SearchBar, to watch
//                                                    the cases fail on the pre-fix code)
//
// WHY. A RESOURCE result navigated the app AND opened the resource's URL in a new
// tab, both from one click or one Enter (UX-22, outside UI/UX review 2026-09-30):
// an external tab was an unexpected second effect, and a learner who only wanted to
// see where the link lived in their course was taken off the app. Now the row's
// main action (click, Enter) is in-app only, and the link has its own labelled
// button in the row that opens it with `noopener,noreferrer` and does nothing else.
//
// The REAL store and SearchBar are bundled into jsdom; the search API answers from a
// fixture, `window.open` is a spy and the router's location is read back.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const HEAD = process.argv.includes('--head');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const headFiles = {
    name: 'head-files',
    setup(build) {
        if (!HEAD) return;
        build.onLoad({ filter: /[\\/]src[\\/]components[\\/]SearchBar\.tsx$/ }, (args) => {
            const rel = args.path.slice(root.length + 1).replace(/\\/g, '/');
            return { contents: execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' }), loader: 'tsx' };
        });
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store'; import { api } from './src/api';
            import SearchBar from './src/components/SearchBar';
            import { createElement, act } from 'react'; import { createRoot } from 'react-dom/client';
            import { MemoryRouter, useLocation } from 'react-router-dom';
            const Where = () => createElement('output', { id: 'where' }, useLocation().pathname);
            const mount = (el) => {
                const root = createRoot(el);
                act(() => root.render(createElement(MemoryRouter, { initialEntries: ['/start'] },
                    createElement(SearchBar), createElement(Where))));
                return root;
            };
            window.__gate = { useStore, api, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [headFiles],
})).outputFiles[0].text;

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

const resource = (over = {}) => ({
    type: 'resource', projectId: 1, nodeId: 5, nodeTitle: 'Limits', title: 'Khan Academy: limits',
    url: 'https://example.org/limits', resourceType: 'link', matchField: 'title', snippet: '', matchRanges: [], score: 1, ...over,
});
const node = { type: 'node', projectId: 1, nodeId: 6, title: 'Limits at infinity', matchField: 'title', snippet: '', matchRanges: [], score: 0.5 };

async function open(results) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    w.Element.prototype.scrollIntoView = () => { };
    const opened = [];
    w.open = (...args) => { opened.push(args); return null; };
    w.eval(bundle);
    const { api, mount, act } = w.__gate;
    api.search = async () => results;
    const doc = w.document;
    mount(doc.getElementById('root'));
    await act(async () => { doc.querySelector('button[aria-label="Search"]').click(); });
    const input = doc.querySelector('input[type="text"]');
    await act(async () => {
        Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input, 'lim');
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
    });
    await act(async () => { await wait(400); });
    await act(async () => { await settle(); });
    const rows = () => [...doc.querySelectorAll('[data-selected]')];
    const rowOf = (title) => rows().find(r => r.textContent.includes(title));
    return {
        w, doc, act, opened, input, rows, rowOf,
        where: () => doc.getElementById('where').textContent,
        searchOpen: () => !!doc.querySelector('input[type="text"]'),
        mainButton: (row) => row.querySelector('button:not([aria-label*="new tab" i])'),
        externalButton: (row) => row?.querySelector('button[aria-label*="new tab" i]'),
        enter: () => act(async () => { input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }),
        down: () => act(async () => { input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); }),
        close: () => w.close(),
    };
}
const answer = (resources, nodes = []) => ({ projects: [], nodes, resources, documents: [] });

// ---------------------------------------------------------------------------
section('a resource result: the main action is in-app only');
{
    const s = await open(answer([resource()]));
    const row = s.rowOf('Khan Academy');
    check('the result is listed', !!row);
    await s.act(async () => { s.mainButton(row).click(); });
    check('clicking the row opens the topic in the app', s.where() === '/project/1/tree/5', s.where());
    check('…and opens no external tab', s.opened.length === 0, JSON.stringify(s.opened));
    s.close();
}
{
    const s = await open(answer([resource()]));
    await s.enter();
    check('Enter on the selected resource opens the topic in the app', s.where() === '/project/1/tree/5', s.where());
    check('…and opens no external tab', s.opened.length === 0, JSON.stringify(s.opened));
    s.close();
}

section('the link has its own labelled button');
{
    const s = await open(answer([resource()]));
    const row = s.rowOf('Khan Academy');
    const ext = s.externalButton(row);
    check('the row carries a button named for opening the link in a new tab', !!ext, row?.innerHTML.slice(0, 200));
    check('its name says which link', !!ext && ext.getAttribute('aria-label').includes('Khan Academy: limits'), ext?.getAttribute('aria-label'));
    check('it is a sibling of the main button, never nested inside it', !!ext && !ext.closest('button:not([aria-label*="new tab" i])'));
    if (ext) await s.act(async () => { ext.click(); });
    check('pressing it opens the URL once, in a new tab, without opener or referrer',
        s.opened.length === 1 && s.opened[0][0] === 'https://example.org/limits' && s.opened[0][1] === '_blank'
        && /noopener/.test(s.opened[0][2]) && /noreferrer/.test(s.opened[0][2]), JSON.stringify(s.opened));
    check('…and does nothing else: the app stays where it was', s.where() === '/start', s.where());
    check('…with the search still open for the next result', s.searchOpen());
    s.close();
}
{
    const s = await open(answer([resource({ url: '' })], [node]));
    check('a resource with no URL has no external button', !s.externalButton(s.rowOf('Khan Academy')));
    check('a topic result has none either', !s.externalButton(s.rowOf('Limits at infinity')));
    s.close();
}

section('keyboard selection stays in sync with the row you are on');
{
    const s = await open(answer([resource()], [node]));
    const selected = () => s.rows().find(r => r.getAttribute('data-selected') === 'true');
    const first = s.rows()[0];
    check('the first row starts selected', selected() === first);
    const ext = s.externalButton(s.rowOf('Khan Academy'));
    if (ext) await s.act(async () => { ext.focus(); });
    check('focusing a row\'s link button selects that row', !!ext && selected() === s.rowOf('Khan Academy'));
    await s.down();
    await s.enter();
    check('Enter after ArrowDown still opens the row the highlight is on', s.where().startsWith('/project/1/tree/'), s.where());
    check('…and never an external tab', s.opened.length === 0, JSON.stringify(s.opened));
    s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
