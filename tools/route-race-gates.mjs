// tools/route-race-gates.mjs — a slow answer must not land on the page after it.
//
// Run:  node tools/route-race-gates.mjs          (the working tree)
//       node tools/route-race-gates.mjs --head   (HEAD's store, to watch the
//                                                  cases fail on the pre-fix code)
//
// WHY. Three store paths write state after an `await`, and each one used to
// trust that the page it started on was still the page on screen:
//   - applyRoute awaited the project load and then applied ITS topic, its
//     resources and its study scope — so A/topic 11 then B/topic 22, answered
//     B first, left B's tree with topic 11 selected and A's resources beside
//     it (external audit, 2026-09-29). An id check cannot catch A → B → A:
//     the project is right and the continuation is still stale, so every
//     route bumps a generation and a continuation checks it;
//   - a search that failed only stopped the spinner, so a network failure read
//     as "No results", and the last query's results stayed under a new one;
//   - a settings setter changed the value on screen, swallowed a failed PUT,
//     and Settings said the change was saved.
// The REAL store is bundled into jsdom with every API call it makes stubbed by
// a deferred promise, so each case chooses the order the answers arrive in.
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

// --head swaps in HEAD's store and search box and nothing else, so the rest of
// the bundle is the same code either way.
const headStore = {
    name: 'head-store',
    setup(build) {
        if (!HEAD) return;
        build.onLoad({ filter: /[\\/]src[\\/](store\.ts|components[\\/]SearchBar\.tsx)$/ }, (args) => {
            const rel = args.path.slice(root.length + 1).replace(/\\/g, '/');
            return {
                contents: execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' }),
                loader: rel.endsWith('.tsx') ? 'tsx' : 'ts',
            };
        });
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store'; import { api } from './src/api';
            import SearchBar from './src/components/SearchBar';
            import { createElement, act } from 'react'; import { createRoot } from 'react-dom/client';
            import { MemoryRouter } from 'react-router-dom';
            const mountSearch = (el) => {
                const root = createRoot(el);
                act(() => root.render(createElement(MemoryRouter, null, createElement(SearchBar))));
                return root;
            };
            window.__gate = { useStore, api, mountSearch, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [headStore],
})).outputFiles[0].text;

/** A fresh store in a fresh document: module state (sequence numbers) resets too. */
const windows = [];
function freshStore() {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    dom.window.IS_REACT_ACT_ENVIRONMENT = true;
    dom.window.MessageChannel = MessageChannel; // React's act() queues through it; jsdom has none
    dom.window.eval(bundle);
    windows.push(dom.window);
    const { useStore, api, mountSearch, act } = dom.window.__gate;
    return { useStore, api, mountSearch, act, window: dom.window, get: () => useStore.getState() };
}

/** A stub whose answers the case releases one call at a time, in any order. */
function deferred() {
    const calls = [];
    const fn = (...args) => new Promise((res, rej) => calls.push({ args, res, rej }));
    return { fn, calls };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const node = (id, projectId) => ({ id, project_id: projectId, parent_id: null, title: `node ${id}`, status: 'not_started', is_note: 0, position: 0 });

/** A store with the project load deferred and everything around it inert. */
function routeStore() {
    const s = freshStore();
    const nodes = deferred();
    const feedCalls = [];
    s.api.getNodes = nodes.fn;
    s.api.getResources = async (id) => [{ id: 100 + id, node_id: id, title: `resource ${id}` }];
    s.useStore.setState({
        loadPaceData: async () => { }, loadDashboard: async () => { }, loadDueFlashcardCount: async () => { },
        loadFeed: async (scope) => { feedCalls.push(scope); s.useStore.setState({ feedScope: scope }); },
    });
    const route = (projectId, nodeId, workspaceView = 'tree') =>
        s.get().applyRoute({ view: 'workspace', projectId, workspaceView, nodeId });
    return { ...s, nodes, feedCalls, route };
}
const resourcesOf = (s) => s.get().resources.map(r => r.node_id).join(',');

// ---------------------------------------------------------------------------
section('a route answered late does not land on the route after it');
{
    const s = routeStore();
    const a = s.route(1, 11);
    const b = s.route(2, 22);
    s.nodes.calls[1].res([node(22, 2)]); await b;
    s.nodes.calls[0].res([node(11, 1)]); await a; await settle();
    const st = s.get();
    check('A/11 then B/22, answered B then A: B is the project', st.currentProjectId === 2 && st.nodes[0]?.id === 22,
        `project ${st.currentProjectId}, tree ${st.nodes.map(n => n.id)}`);
    check('…and B\'s topic is the selection', st.selectedNodeId === 22, `selected ${st.selectedNodeId}`);
    check('…and the resources beside it are B\'s topic\'s', resourcesOf(s) === '22', `resources of ${resourcesOf(s) || 'nothing'}`);
}
{
    const s = routeStore();
    const a1 = s.route(1, 11);
    const b = s.route(2, 22);
    const a2 = s.route(1, 33);
    // The second visit to A answers first, then B, then the FIRST visit to A.
    s.nodes.calls[2].res([node(33, 1), node(11, 1)]); await a2;
    s.nodes.calls[1].res([node(22, 2)]); await b;
    s.nodes.calls[0].res([node(11, 1)]); await a1; await settle();
    const st = s.get();
    check('A/11 → B/22 → A/33, answered last-first: A is the project', st.currentProjectId === 1, `project ${st.currentProjectId}`);
    check('…and topic 33 (the LAST route) is selected, not 11 or 22', st.selectedNodeId === 33, `selected ${st.selectedNodeId}`);
    check('…with topic 33\'s resources', resourcesOf(s) === '33', `resources of ${resourcesOf(s) || 'nothing'}`);
    check('…and the tree is the newest load\'s, not the first visit\'s older answer', st.nodes.length === 2,
        `tree ${st.nodes.map(n => n.id)}`);
}
{
    const s = routeStore();
    const a = s.route(1, 11, 'study');
    const b = s.route(2, 22);
    s.nodes.calls[1].res([node(22, 2)]); await b;
    s.nodes.calls[0].res([node(11, 1)]); await a; await settle();
    const st = s.get();
    check('a study route overlapped by another route never opens its scope',
        !s.feedCalls.some(sc => sc?.kind === 'node' && sc.id === 11), `loadFeed called with ${JSON.stringify(s.feedCalls)}`);
    check('…and leaves no study topic behind', st.studyNodeId === null, `studyNodeId ${st.studyNodeId}`);
    check('…and the newer route\'s selection stands', st.selectedNodeId === 22, `selected ${st.selectedNodeId}`);
}
{
    const s = routeStore();
    const a = s.route(1, 11, 'study');
    const b = s.route(2, null, 'study');
    s.nodes.calls[1].res([node(22, 2)]); await b;
    s.nodes.calls[0].res([node(11, 1)]); await a; await settle();
    const last = s.feedCalls.at(-1);
    check('study A/11 then study B (the course), answered B then A: the feed is B\'s course',
        last?.kind === 'project' && last.id === 2 && s.feedCalls.length === 1, `loadFeed calls ${JSON.stringify(s.feedCalls)}`);
}
{
    const s = routeStore();
    const a = s.route(1, 11);
    const g = s.get().applyRoute({ view: 'projects' });
    await g;
    s.nodes.calls[0].res([node(11, 1)]); await a; await settle();
    const st = s.get();
    check('a global view entered while a project loads: no topic is selected under it',
        st.view === 'projects' && st.selectedNodeId === null && st.resources.length === 0,
        `view ${st.view}, selected ${st.selectedNodeId}, resources ${st.resources.length}`);
    check('…and the abandoned load does not leave the app loading', st.loading === false);
}
{
    const s = routeStore();
    const a1 = s.route(1, 11);
    await s.get().applyRoute({ view: 'settings' });
    const a2 = s.route(1, 11);
    // Back from Settings to the same topic before the first load answered: the
    // first load is the OLDER answer and must not overwrite the newer tree.
    s.nodes.calls[1].res([node(11, 1), node(12, 1)]); await a2;
    s.nodes.calls[0].res([node(11, 1)]); await a1; await settle();
    const st = s.get();
    check('A/11 → Settings → A/11: the newer load\'s tree stands', st.nodes.length === 2, `tree ${st.nodes.map(n => n.id)}`);
    check('…and topic 11 is still selected with its resources', st.selectedNodeId === 11 && resourcesOf(s) === '11',
        `selected ${st.selectedNodeId}, resources of ${resourcesOf(s) || 'nothing'}`);
}
{
    // ANOTHER project's tree on screen when the first load starts: the second
    // route to B must not take that tree for B's, select its topic in it, and
    // then lose the selection to the first load painting over it.
    const s = routeStore();
    s.useStore.setState({ view: 'workspace', currentProjectId: 3, nodes: [node(30, 3)], tree: [] });
    const b1 = s.route(5, 10);
    await s.get().applyRoute({ view: 'settings' });
    const b2 = s.route(5, 10);
    if (s.nodes.calls[1]) { s.nodes.calls[1].res([node(10, 5)]); await b2; }
    s.nodes.calls[0].res([node(10, 5)]); await b1; await b2; await settle();
    const st = s.get();
    check('C open, B/10 → Settings → B/10 before B answered: B\'s topic is selected', st.selectedNodeId === 10,
        `selected ${st.selectedNodeId}`);
    check('…with its resources, in B\'s tree', resourcesOf(s) === '10' && st.nodes.every(n => n.project_id === 5),
        `resources of ${resourcesOf(s) || 'nothing'}, tree ${st.nodes.map(n => n.id)}`);
}

// ---------------------------------------------------------------------------
section('search: a failure is a state of its own, and an old answer is not a new one');
const results = (q) => ({ projects: [], nodes: [{ type: 'node', nodeId: 1, projectId: 1, title: q, matchField: 'title', snippet: '', matchRanges: [], score: 1 }], resources: [], documents: [] });
{
    const s = freshStore();
    s.api.search = async () => { throw new Error('Failed to fetch'); };
    await s.get().performSearch('ab');
    const st = s.get();
    check('a failed search records WHICH query failed', st.searchError === 'ab', `searchError ${JSON.stringify(st.searchError)}`);
    check('…stops the spinner and shows no results in its place', st.searchLoading === false && st.searchResults === null);
    s.api.search = async (q) => results(q);
    await s.get().performSearch('ab');
    check('a retry that works clears the failure and fills the results',
        s.get().searchError === null && s.get().searchResultsQuery === 'ab' && s.get().searchResults?.nodes[0]?.title === 'ab',
        `error ${JSON.stringify(s.get().searchError)}, results for ${JSON.stringify(s.get().searchResultsQuery)}`);
}
{
    const s = freshStore();
    s.api.search = async (q) => results(q);
    await s.get().performSearch('ab');
    s.api.search = async () => { throw new Error('Failed to fetch'); };
    await s.get().performSearch('abc');
    const st = s.get();
    check('"ab" answered, then "abc" failed: "ab"\'s results are not left standing for "abc"',
        st.searchResults === null && st.searchResultsQuery !== 'abc' && st.searchError === 'abc',
        `results for ${JSON.stringify(st.searchResultsQuery)}, error ${JSON.stringify(st.searchError)}`);
}
{
    const s = freshStore();
    const search = deferred();
    s.api.search = search.fn;
    const p1 = s.get().performSearch('ab');
    const p2 = s.get().performSearch('abc');
    search.calls[1].res(results('abc')); await p2;
    search.calls[0].res(results('ab')); await p1;
    const st = s.get();
    check('"ab" answering after "abc" is dropped: the results are "abc"\'s and say so',
        st.searchResults?.nodes[0]?.title === 'abc' && st.searchResultsQuery === 'abc',
        `results ${st.searchResults?.nodes[0]?.title} for ${JSON.stringify(st.searchResultsQuery)}`);
    const s2 = freshStore();
    const search2 = deferred();
    s2.api.search = search2.fn;
    const q1 = s2.get().performSearch('ab');
    const q2 = s2.get().performSearch('abc');
    search2.calls[1].res(results('abc')); await q2;
    search2.calls[0].rej(new Error('Failed to fetch')); await q1;
    check('…and an old query failing late does not mark the new one failed', s2.get().searchError === null,
        `searchError ${JSON.stringify(s2.get().searchError)}`);
}
{
    const s = freshStore();
    s.api.search = async () => { throw new Error('Failed to fetch'); };
    await s.get().performSearch('ab');
    s.get().clearSearch();
    check('clearing the box clears the failure', s.get().searchError === null);
}

// The search box itself, mounted: what the learner reads in each state.
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function openSearch(s) {
    const host = s.window.document.createElement('div');
    s.window.document.body.appendChild(host);
    const root = s.mountSearch(host);
    const doc = s.window.document;
    await s.act(async () => { doc.querySelector('button[aria-label="Search"]').click(); });
    const input = () => doc.querySelector('input[type="text"]');
    const type = async (text) => {
        await s.act(async () => {
            const setter = Object.getOwnPropertyDescriptor(s.window.HTMLInputElement.prototype, 'value').set;
            setter.call(input(), text);
            input().dispatchEvent(new s.window.Event('input', { bubbles: true }));
        });
    };
    // Past the box's 300 ms debounce, then let the answer land.
    const afterDebounce = async () => { await s.act(async () => { await wait(400); }); await s.act(async () => { await settle(); }); };
    const text = () => doc.body.textContent;
    const button = (label) => [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === label);
    return { root, input, type, afterDebounce, text, button };
}
{
    const s = freshStore();
    const asked = [];
    s.api.search = async (q) => { asked.push(q); throw new Error('Failed to fetch'); };
    const box = await openSearch(s);
    await box.type('ab'); await box.afterDebounce();
    check('the box: a failed search says so, not "No results"',
        box.text().includes("Couldn't search the library.") && !box.text().includes('No results'), box.text().slice(0, 160));
    const retry = box.button('Retry');
    check('…offers Retry, and the typed query is still in the box', !!retry && box.input().value === 'ab');
    s.api.search = async (q) => { asked.push(q); return results(q); };
    if (retry) { await s.act(async () => { retry.click(); }); await s.act(async () => { await settle(); }); }
    check('…Retry asks again for the same query and shows its answer',
        !!retry && asked.length === 2 && asked[1] === 'ab' && box.text().includes('Topics')
            && !box.text().includes("Couldn't search the library."),
        `asked ${JSON.stringify(asked)}`);
    s.act(() => box.root.unmount());
}
{
    const s = freshStore();
    s.api.search = async () => ({ ...results('first answer'), nodes: [{ ...results('x').nodes[0], title: 'first answer' }] });
    const box = await openSearch(s);
    await box.type('first'); await box.afterDebounce();
    const shownFirst = box.text().includes('first answer');
    s.api.search = () => new Promise(() => { });
    await box.type('second');
    check('the box: a new query does not show the last query\'s answer as its own',
        shownFirst && !box.text().includes('first answer'), `first shown ${shownFirst}; now ${box.text().slice(0, 160)}`);
    check('…and says it is searching rather than "No results"',
        box.text().includes('Searching…') && !box.text().includes('No results'));
    s.act(() => box.root.unmount());
}

// ---------------------------------------------------------------------------
section('a setting that did not save is put back, and says so');
const SAVE_FAILED = "Couldn't save that setting. It has been put back.";
const SETTERS = [
    // [setter, arguments, the state it changes]
    ['setTheme', (st) => [st.theme === 'dark' ? 'light' : 'dark'], 'theme'],
    ['setThemeTint', () => ['#fef3c7'], 'themeTint'],
    ['setAccentColor', () => ['#123456'], 'accentColor'],
    ['setAppIcon', (st) => [{ radius: st.appIcon.radius === 10 ? 20 : 10 }], 'appIcon'],
    ['setUiScale', (st) => [st.uiScale === 130 ? 120 : 130], 'uiScale'],
    ['setSidebarWidth', (st) => [st.sidebarWidth === 300 ? 320 : 300], 'sidebarWidth'],
    ['setDetailPanelWidth', (st) => [st.detailPanelWidth === 480 ? 460 : 480], 'detailPanelWidth'],
    ['setWeekStartDay', (st) => [st.weekStartDay === 1 ? 0 : 1], 'weekStartDay'],
    ['setNumberFormat', (st) => [st.numberFormat === '1.234,5' ? '1,234.5' : '1.234,5'], 'numberFormat'],
    ['setAtlasColorMode', (st) => [st.atlasColorMode === 'course' ? 'mastery' : 'course'], 'atlasColorMode'],
    ['setAtlasSurface', (st) => [st.atlasSurface === 'globe' ? 'map' : 'globe'], 'atlasSurface'],
    ['setAtlasSettings', (st) => [{ speed: st.atlasSettings.speed === 2 ? 1.5 : 2 }], 'atlasSettings'],
    ['setUiLanguage', (st) => [st.uiLanguage === 'en' ? 'auto' : 'en'], 'uiLanguage'],
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const saveFailedToasts = (s) => s.get().toasts.filter(t => t.type === 'error' && t.message === SAVE_FAILED);

for (const [name, args, field] of SETTERS) {
    const s = freshStore();
    const put = deferred();
    s.api.setSetting = put.fn;
    const before = s.get()[field];
    let threw = null;
    const done = s.get()[name](...args(s.get())).catch(e => { threw = e; });
    const shown = s.get()[field];
    for (const c of put.calls) c.rej(new Error('Failed to fetch'));
    await settle();
    // setAppIcon writes one row at a time, so a later row is asked for only
    // after the first answered.
    for (const c of put.calls) c.rej(new Error('Failed to fetch'));
    await done; await settle();
    check(`${name}: shown at once, put back when the save fails, with the shared message`,
        !same(shown, before) && same(s.get()[field], before) && saveFailedToasts(s).length === 1 && threw === null,
        `shown ${JSON.stringify(shown)}, now ${JSON.stringify(s.get()[field])}, was ${JSON.stringify(before)}, toasts ${JSON.stringify(s.get().toasts.map(t => t.message))}${threw ? `, threw ${threw.message}` : ''}`);
}
{
    const s = freshStore();
    s.useStore.setState({ atlasSettings: { ...s.get().atlasSettings, speed: 2 } });
    const before = s.get().atlasSettings;
    s.api.setSetting = async () => { throw new Error('Failed to fetch'); };
    await s.get().resetAtlasSettings();
    check('resetAtlasSettings: a failed reset puts the learner\'s settings back', same(s.get().atlasSettings, before) && saveFailedToasts(s).length === 1,
        `now ${JSON.stringify(s.get().atlasSettings)}`);
}
{
    const s = freshStore();
    s.api.setSetting = async () => ({ success: true });
    const target = s.get().uiScale === 130 ? 120 : 130;
    await s.get().setUiScale(target);
    check('a save that works keeps the value and says nothing', s.get().uiScale === target && s.get().toasts.length === 0);
}
{
    // A slider sends a write per step. An older step failing after a newer
    // one saved must not drag the control back to the older value.
    const s = freshStore();
    const put = deferred();
    s.api.setSetting = put.fn;
    const p1 = s.get().setUiScale(110);
    const p2 = s.get().setUiScale(120);
    put.calls[1].res({ success: true }); await p2;
    put.calls[0].rej(new Error('Failed to fetch')); await p1; await settle();
    check('an older write failing after a newer one saved changes nothing', s.get().uiScale === 120 && saveFailedToasts(s).length === 0,
        `uiScale ${s.get().uiScale}, toasts ${s.get().toasts.length}`);
}
{
    // Every step of a drag failing: the value goes back to where the drag
    // STARTED — the last value that was actually saved — not one step back.
    const s = freshStore();
    const start = s.get().uiScale;
    const put = deferred();
    s.api.setSetting = put.fn;
    const p1 = s.get().setUiScale(110);
    const p2 = s.get().setUiScale(120);
    put.calls[0].rej(new Error('Failed to fetch')); await p1;
    put.calls[1].rej(new Error('Failed to fetch')); await p2; await settle();
    check('a drag whose every write failed goes back to where it started, with one message',
        s.get().uiScale === start && saveFailedToasts(s).length === 1 && saveFailedToasts(s)[0].count === 1, `uiScale ${s.get().uiScale} (started ${start}), toasts ${saveFailedToasts(s).length}`);
}
{
    // The NEWEST write fails while an older one is still in flight, and the
    // older one then saves. The screen must end on what the server holds (the
    // older value), not on where the drag started.
    const s = freshStore();
    const put = deferred();
    s.api.setSetting = put.fn;
    const p1 = s.get().setUiScale(110);
    const p2 = s.get().setUiScale(120);
    put.calls[1].rej(new Error('Failed to fetch')); await p2;
    put.calls[0].res({ success: true }); await p1; await settle();
    check('newest fails, older still in flight then saves: the screen shows what was saved',
        s.get().uiScale === 110 && saveFailedToasts(s).length === 1, `uiScale ${s.get().uiScale}, toasts ${saveFailedToasts(s).length}`);
}

// ---------------------------------------------------------------------------
// The feed guarded its three loaders on the SCOPE alone, so A → B → A let the
// first A's late answer land on the second A's stream: it replaced the newer
// cards and cleared the done ticks (outside audit, 2026-09-30).
section('a feed answered late does not land on the stream after it');
const feedPage = (...keys) => ({ items: keys.map(key => ({ key, kind: 'notice' })), header: {}, exhausted: false });
const A = { kind: 'node', id: 1 }, Bs = { kind: 'node', id: 2 };
const feedKeys = (s) => s.get().feedCards.map(c => c.key).join(',');
{
    const s = freshStore();
    const feed = deferred();
    s.api.getFeed = feed.fn;
    const a1 = s.get().loadFeed(A), b = s.get().loadFeed(Bs), a2 = s.get().loadFeed(A);
    feed.calls[2].res(feedPage('new-A')); await a2;
    s.useStore.setState({ feedDone: { 'new-A': true } });
    feed.calls[1].res(feedPage('B')); await b;
    feed.calls[0].res(feedPage('stale-A')); await a1; await settle();
    check('A → B → A, answered newest first: the stream is the second A\'s', feedKeys(s) === 'new-A', feedKeys(s));
    check('…and its done ticks survive the older answers', s.get().feedDone['new-A'] === true, JSON.stringify(s.get().feedDone));
}
{
    const s = freshStore();
    const feed = deferred();
    s.api.getFeed = feed.fn;
    const a1 = s.get().loadFeed(A), b = s.get().loadFeed(Bs), a2 = s.get().loadFeed(A);
    feed.calls[0].rej(new Error('Failed to fetch')); await a1;
    feed.calls[1].rej(new Error('Failed to fetch')); await b; await settle();
    check('an older A failing while the newest A loads says nothing and keeps the spinner',
        s.get().feedLoading === true && s.get().toasts.length === 0,
        `loading ${s.get().feedLoading}, toasts ${JSON.stringify(s.get().toasts.map(t => t.message))}`);
    feed.calls[2].res(feedPage('new-A')); await a2;
    check('…and the newest A then lands', feedKeys(s) === 'new-A' && s.get().feedLoading === false, feedKeys(s));
}
{
    const s = freshStore();
    const feed = deferred();
    s.api.getFeed = feed.fn;
    const a1 = s.get().loadFeed(A);
    feed.calls[0].res(feedPage('a1')); await a1;
    const more = s.get().extendFeed();
    const b = s.get().loadFeed(Bs), a2 = s.get().loadFeed(A);
    feed.calls[3].res(feedPage('a2')); await a2;
    feed.calls[2].res(feedPage('B')); await b;
    feed.calls[1].res(feedPage('old-page')); await more; await settle();
    check('a page asked for by the first A is not appended to the second A', feedKeys(s) === 'a2', feedKeys(s));
}
{
    const s = freshStore();
    const feed = deferred();
    s.api.getFeed = feed.fn;
    const a1 = s.get().loadFeed(A);
    feed.calls[0].res(feedPage('a1')); await a1;
    const pull = s.get().pullFeedUpdates();
    const a2 = s.get().loadFeed(A);
    feed.calls[2].res(feedPage('a2')); await a2;
    feed.calls[1].res(feedPage('a1', 'old-pull')); await pull; await settle();
    check('a background pull for the first A is not appended to the reloaded A', feedKeys(s) === 'a2', feedKeys(s));
}
{
    const s = freshStore();
    const feed = deferred();
    s.api.getFeed = feed.fn;
    const a1 = s.get().loadFeed(A);
    feed.calls[0].res(feedPage('a1')); await a1;
    const more = s.get().extendFeed();
    feed.calls[1].res(feedPage('a1', 'a1-page-2')); await more;
    check('a page that is still current is appended, as before', feedKeys(s) === 'a1,a1-page-2' && s.get().feedLoading === false, feedKeys(s));
}

// ---------------------------------------------------------------------------
// addToast(type, message, details?) — the two update setters had the first two
// swapped, so the toast's TYPE was the failure text and its message "error".
section('an update-check failure says what failed, as an error');
{
    const s = freshStore();
    s.api.checkUpdates = async () => { throw new Error('Synthetic update check failure'); };
    await s.get().checkForUpdates(); await settle();
    const t = s.get().toasts.at(-1);
    check('checkForUpdates: an error toast carrying the failure', t?.type === 'error' && /Synthetic update check failure/.test(`${t?.message} ${t?.details || ''}`),
        JSON.stringify(t));
}
{
    const s = freshStore();
    s.useStore.setState({ updateStatus: { enabled: false } });
    s.api.setAutoUpdateCheck = async () => { throw new Error('Synthetic toggle failure'); };
    await s.get().setAutoUpdateCheck(true); await settle();
    const t = s.get().toasts.at(-1);
    check('setAutoUpdateCheck: an error toast carrying the failure, and the switch put back',
        t?.type === 'error' && /Synthetic toggle failure/.test(`${t?.message} ${t?.details || ''}`) && s.get().updateStatus?.enabled === false,
        `${JSON.stringify(t)} enabled ${s.get().updateStatus?.enabled}`);
}
{
    const s = freshStore();
    s.api.checkUpdates = async () => { throw 'a bare string'; };
    await s.get().checkForUpdates(); await settle();
    const t = s.get().toasts.at(-1);
    check('…a thrown non-Error still gives an error toast with words in it', t?.type === 'error' && !!t?.message && t.message !== 'error', JSON.stringify(t));
}

for (const w of windows) w.close();
console.log(`\n${fail ? 'FAIL' : 'PASS'}  route-race-gates: ${pass} passed, ${fail} failed${HEAD ? ' (HEAD store)' : ''}`);
process.exit(fail ? 1 : 0);
