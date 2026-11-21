// tools/resource-list-gates.mjs — a topic's resource list offers each kind once,
// in both forms, and never filters by something the learner cannot see.
//
// Run:  node tools/resource-list-gates.mjs
//
// WHY. Stored rows can carry `course_link`, a legacy name for `course`. The
// list drew it as a second "Course": a second chip in the add form, a second
// "Course (n)" filter pill. The edit form showed only the first seven kinds
// (so a Practice or Link row could not be edited back to its kind), and a
// course_link row opened with no kind selected. And the kind pills appear only
// on a list of six or more, while the filter they set stayed set: picking
// "Video", then deleting rows down to five, left a list filtered to its videos
// with nothing on screen to say so or to clear it.
//
// Every case MOUNTS the real ResourceList in jsdom (store, api and i18n are
// stubs) and reads what it draws. Deterministic, no model, no network.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'Event']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = (q) => ({ matches: /pointer: fine|hover: hover/.test(q), media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
window.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
globalThis.ResizeObserver = window.ResizeObserver;

const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'resource-list-gates-'));
const out = join(scratch, 'bundle.cjs');

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => { let s = k; for (const [a, b] of Object.entries(o ?? {})) s = s.replace('{{' + a + '}}', b); return s; }, i18n: { language: 'en' } });`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: {}, subs: new Set() };
        g.__setState = (patch) => { g.__st.state = { ...g.__st.state, ...patch }; g.__st.subs.forEach(f => f()); };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;
        export const isDarkTheme = () => false;`,
    'api': `export const api = new Proxy({}, { get: () => async () => ({}) });`,
};
await esbuild.build({
    stdin: {
        contents: `export { default as ResourceList } from './src/components/ResourceList';`,
        resolveDir: root,
        loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out,
    jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
    packages: 'external',
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
            b.onResolve({ filter: /(^|\/)(?:\.\.\/)+(store|i18n|api)$/ }, (a) => ({ path: a.path.split('/').pop(), namespace: 'stub' }));
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js', resolveDir: root }));
        },
    }],
    logLevel: 'silent',
});

const React = require('react');
const { createRoot } = require('react-dom/client');
const { ResourceList } = require(out);
const act = (fn) => React.act(fn);
const doc = window.document;
const host = doc.getElementById('root');

const row = (id, type, title) => ({ id, node_id: 1, type, title, url: '', completed: 0, position: id });
const SEVEN = [
    row(1, 'article', 'Intro article'),
    row(2, 'video', 'Lecture video'),
    row(3, 'course', 'Open course'),
    row(4, 'course_link', 'Older course link'),
    row(5, 'practice', 'Practice set'),
    row(6, 'link', 'Reference page'),
    row(7, 'book', 'Textbook'),
    // A type no form offers (an older version's): drawn, counted and filtered as a link.
    row(8, 'podcast', 'Weekly podcast'),
];
const updates = [];
globalThis.__setState({
    resources: SEVEN,
    nodes: [], projects: [], accentColor: '#0e7490', theme: 'light',
    createResource: async () => { }, updateResource: async (id, patch) => { updates.push({ id, ...patch }); }, deleteResource: async () => { }, reorderResources: async () => { },
    loadResources: async () => { }, addToast: () => { },
});
const listRoot = createRoot(host);
act(() => listRoot.render(React.createElement(ResourceList, { nodeId: 1 })));

const chips = (kind) => [...host.querySelectorAll(`[data-chip="${kind}"]`)];
const labels = (kind) => chips(kind).map(b => b.textContent.trim());
const click = (el) => { if (el) act(() => { el.click(); }); };
const shownTitles = () => SEVEN.map(r => r.title).filter(t => [...host.querySelectorAll('a, span')].some(e => e.textContent.trim() === t));

section('one "Course", in the filter and in both forms');
const pills = labels('resource-filter');
check('the filter shows one Course pill, counting both kinds of course row', pills.filter(l => /^Course/.test(l)).length === 1 && pills.includes('Course (2)'), JSON.stringify(pills));
check('an unknown type is counted under Link, not as a second Link pill', pills.filter(l => /^Link/.test(l)).length === 1 && pills.includes('Link (2)'), JSON.stringify(pills));
click([...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add'));
const addKinds = labels('resource-type');
check('the add form offers each kind once', addKinds.length > 0 && new Set(addKinds).size === addKinds.length, JSON.stringify(addKinds));
check('…Practice and Link among them', addKinds.includes('Practice') && addKinds.includes('Link'), JSON.stringify(addKinds));
click([...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel'));
// The Edit button in the card that carries this title.
const editOf = (title) => {
    const titleEl = [...host.querySelectorAll('a, span')].find(e => e.textContent.trim() === title);
    let card = titleEl;
    while (card && !card.querySelector('button[aria-label="Edit"]')) card = card.parentElement;
    return card?.querySelector('button[aria-label="Edit"]') ?? null;
};
const pressedKinds = () => chips('resource-type').filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim());
click(editOf('Older course link'));
const editKinds = labels('resource-type');
check('the edit form offers exactly the kinds the add form does', JSON.stringify(editKinds) === JSON.stringify(addKinds), `${JSON.stringify(editKinds)} vs ${JSON.stringify(addKinds)}`);
check('a legacy course_link row opens with Course selected', JSON.stringify(pressedKinds()) === '["Course"]', JSON.stringify(pressedKinds()));
const titleField = host.querySelector('input[aria-label="Title"]');
if (titleField) act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(titleField, 'Older course, renamed');
    titleField.dispatchEvent(new window.Event('input', { bubbles: true }));
});
await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save')?.click(); });
check('renaming it keeps its stored type (no silent rewrite)', updates.length === 1 && updates[0].type === 'course_link' && updates[0].title === 'Older course, renamed', JSON.stringify(updates));
click(editOf('Weekly podcast'));
check('a row of an unknown type opens with Link selected', JSON.stringify(pressedKinds()) === '["Link"]', JSON.stringify(pressedKinds()));
click([...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel'));

section('a filter applies only while it can be seen');
click(chips('resource-filter').find(b => /^Course/.test(b.textContent.trim())));
check('Course shows both course rows', JSON.stringify(shownTitles()) === '["Open course","Older course link"]', JSON.stringify(shownTitles()));
click(chips('resource-filter').find(b => /^Video/.test(b.textContent.trim())));
check('Video shows its one row', JSON.stringify(shownTitles()) === '["Lecture video"]', JSON.stringify(shownTitles()));
click(chips('resource-filter').find(b => /^Link/.test(b.textContent.trim())));
check('Link shows the link and the unknown-type row', JSON.stringify(shownTitles()) === '["Reference page","Weekly podcast"]', JSON.stringify(shownTitles()));
click(chips('resource-filter').find(b => /^Video/.test(b.textContent.trim())));
// Three rows deleted: five left, so the pills go.
const allPressed = () => chips('resource-filter').find(b => b.getAttribute('aria-pressed') === 'true')?.textContent.trim().startsWith('All');
act(() => globalThis.__setState({ resources: SEVEN.filter(r => ![6, 7, 8].includes(r.id)) }));
check('down to five rows the pills are gone', chips('resource-filter').length === 0, JSON.stringify(labels('resource-filter')));
check('…and every row is listed, not only the videos', shownTitles().length === 5, JSON.stringify(shownTitles()));
// Rows added back past the threshold: the old pick does not come back by itself.
act(() => globalThis.__setState({ resources: SEVEN }));
check('a list that grows long again lists every row, the old pick dropped', shownTitles().length === 8 && allPressed(), JSON.stringify(shownTitles()));
// A pick whose kind loses its last row, on a list still long enough for pills.
click(chips('resource-filter').find(b => /^Book/.test(b.textContent.trim())));
act(() => globalThis.__setState({ resources: SEVEN.filter(r => r.id !== 7) }));
check('a long list whose picked kind has no rows left lists every row', shownTitles().length === 7, JSON.stringify(shownTitles()));
check('…and "All" is the pill that reads as pressed', allPressed(), JSON.stringify(chips('resource-filter').map(b => [b.textContent.trim(), b.getAttribute('aria-pressed')])));

act(() => listRoot.unmount());
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
console.log(`\nresource-list gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
