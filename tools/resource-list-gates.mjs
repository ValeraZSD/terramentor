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
];
globalThis.__setState({
    resources: SEVEN,
    nodes: [], projects: [], accentColor: '#0e7490', theme: 'light',
    createResource: async () => { }, updateResource: async () => { }, deleteResource: async () => { }, reorderResources: async () => { },
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
click([...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add'));
const addKinds = labels('resource-type');
check('the add form offers each kind once', addKinds.length > 0 && new Set(addKinds).size === addKinds.length, JSON.stringify(addKinds));
check('…Practice and Link among them', addKinds.includes('Practice') && addKinds.includes('Link'), JSON.stringify(addKinds));
click([...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel'));
// Row 4 is the course_link row: its Edit is the fourth on screen.
const edits = [...host.querySelectorAll('button[aria-label="Edit"]')];
click(edits[3]);
const editKinds = labels('resource-type');
check('the edit form offers exactly the kinds the add form does', JSON.stringify(editKinds) === JSON.stringify(addKinds), `${JSON.stringify(editKinds)} vs ${JSON.stringify(addKinds)}`);
const pressed = chips('resource-type').filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim());
check('a legacy course_link row opens with Course selected', JSON.stringify(pressed) === '["Course"]', JSON.stringify(pressed));
click([...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel'));

section('a filter applies only while it can be seen');
click(chips('resource-filter').find(b => /^Course/.test(b.textContent.trim())));
check('Course shows both course rows', JSON.stringify(shownTitles()) === '["Open course","Older course link"]', JSON.stringify(shownTitles()));
click(chips('resource-filter').find(b => /^Video/.test(b.textContent.trim())));
check('Video shows its one row', JSON.stringify(shownTitles()) === '["Lecture video"]', JSON.stringify(shownTitles()));
// Two rows deleted: five left, so the pills go.
act(() => globalThis.__setState({ resources: SEVEN.filter(r => r.id !== 6 && r.id !== 7) }));
check('down to five rows the pills are gone', chips('resource-filter').length === 0, JSON.stringify(labels('resource-filter')));
check('…and every row is listed, not only the videos', shownTitles().length === 5, JSON.stringify(shownTitles()));
// Back to a long list with the video gone: the pick has no rows left.
act(() => globalThis.__setState({ resources: SEVEN.filter(r => r.id !== 2) }));
check('a long list whose picked kind has no rows left lists every row', shownTitles().length === 6, JSON.stringify(shownTitles()));
check('…and "All" is the pill that reads as pressed', chips('resource-filter').find(b => b.getAttribute('aria-pressed') === 'true')?.textContent.trim().startsWith('All'), JSON.stringify(chips('resource-filter').map(b => [b.textContent.trim(), b.getAttribute('aria-pressed')])));

act(() => listRoot.unmount());
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
console.log(`\nresource-list gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
