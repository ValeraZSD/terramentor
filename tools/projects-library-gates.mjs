// tools/projects-library-gates.mjs — a big library on the Projects page.
//
// Run:  node tools/projects-library-gates.mjs                (the working tree)
//       node tools/projects-library-gates.mjs --base <rev>   (ProjectsGrid and ShortCourses as
//                                                           they are at <rev>, e.g. 4a70df5,
//                                                           the page before these views, to
//                                                           watch the cases fail)
//
// WHY. With 20 courses and 40 short ones, the page listed everything in one
// column: the active ones, then every finished and archived course below them,
// dimmed, so what was being studied sat among what was done, and a finished
// course was found by scrolling. The page now has three views of one library:
//   - Active: the short courses still being studied (as small cards, three to a
//     row), then the full courses; nothing finished or archived;
//   - Finished and Archived: both kinds, newest first, one press away, with
//     their counts always on the switch so a course that left Active is never
//     "gone"; the view is in the address (`?show=finished|archived`);
//   - no find field of its own: the top bar's search finds a course in any view.
//
// The REAL ProjectsGrid, ShortCourses and store are bundled into jsdom inside a
// MemoryRouter; `fetch` answers the library and the short-course list from a
// fixture and leaves every other request pending. Deterministic: no model, no
// network, no database, no clock (dates are fixed strings).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : null;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n--- ${s} ---`);

const baseFiles = {
    name: 'base-files',
    setup(build) {
        if (!BASE) return;
        build.onLoad({ filter: /[\\/]src[\\/]components[\\/](ProjectsGrid|shortCourses[\\/]ShortCourses)\.tsx$/ }, (args) => {
            const rel = args.path.slice(root.length + 1).replace(/\\/g, '/');
            return { contents: execFileSync('git', ['show', `${BASE}:${rel}`], { cwd: root, encoding: 'utf8' }), loader: 'tsx' };
        });
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import ProjectsGrid from './src/components/ProjectsGrid';
            import { createElement as h, act } from 'react';
            import { createRoot } from 'react-dom/client';
            import { MemoryRouter, useLocation } from 'react-router-dom';
            function Where() { const l = useLocation(); window.__where = l.pathname + l.search; return null; }
            const mount = (el, path) => {
                const r = createRoot(el);
                act(() => r.render(h(MemoryRouter, { initialEntries: [path] }, h(ProjectsGrid), h(Where))));
                return r;
            };
            window.__gate = { useStore, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl' },
    plugins: [baseFiles],
})).outputFiles[0].text;

// ---- the fixture -------------------------------------------------------------
// Full courses and short courses (`made_from`) in every status. Dates are fixed
// strings, so the order asserted below never depends on today.
const P = (id, name, extra = {}) => ({
    id, name, color: '#8B5CF6', icon: 'book', status: 'active', position: id,
    topic_count: 6, completed_topic_count: 2, progress: 0.3, card_count: 0,
    last_done_at: null, updated_at: '2026-10-01T10:00:00.000Z', ...extra,
});
const short = (from) => ({ made_from: JSON.stringify(from) });
const LIB = [
    // Full courses.
    P(1, 'Organic chemistry'),
    P(2, 'Linear algebra'),
    P(3, 'Dutch grammar'),
    P(4, 'World history', { status: 'completed', completed_topic_count: 6, last_done_at: '2026-09-01T09:00:00.000Z' }),
    P(5, 'Calculus one', { status: 'completed', completed_topic_count: 6, last_done_at: '2026-10-15T09:00:00.000Z' }),
    P(6, 'Old Spanish', { status: 'archived', updated_at: '2026-08-01T09:00:00.000Z' }),
    // Short courses.
    P(11, 'Bread baking', { ...short({ kind: 'page', host: 'example.org' }), topic_count: 3, completed_topic_count: 0 }),
    P(12, 'Puppy training', { ...short({ kind: 'video', host: 'youtube.com' }), topic_count: 3, completed_topic_count: 1, last_done_at: '2026-10-01T09:00:00.000Z' }),
    P(13, 'Tide pools', { ...short({ kind: 'pdf', file: 'tides.pdf' }), topic_count: 3, completed_topic_count: 1, last_done_at: '2026-10-20T09:00:00.000Z' }),
    P(14, 'Volcanoes', { ...short({ kind: 'page', host: 'example.org' }), topic_count: 0, completed_topic_count: 0 }),
    P(15, 'Sailing knots', { ...short({ kind: 'page', host: 'example.org' }), topic_count: 3, completed_topic_count: 3, last_done_at: '2026-10-25T09:00:00.000Z' }),
    P(16, 'Café roasting', { ...short({ kind: 'page', host: 'example.org' }), status: 'completed', topic_count: 3, completed_topic_count: 3, last_done_at: '2026-10-30T09:00:00.000Z' }),
    P(17, 'Chess openings', { ...short({ kind: 'video', host: 'youtube.com' }), status: 'archived', updated_at: '2026-10-02T09:00:00.000Z' }),
];
const STATE = { 11: 'ready', 12: 'studying', 13: 'studying', 14: 'building', 15: 'finished', 16: 'finished', 17: 'ready' };
const rowOf = (p) => ({
    id: p.id, name: p.name, icon: p.icon, color: p.color, kind: JSON.parse(p.made_from).kind,
    from: JSON.parse(p.made_from).host ?? JSON.parse(p.made_from).file ?? null, url: null, minutes: null,
    topics: p.topic_count, done: p.completed_topic_count, state: STATE[p.id], taskId: null,
});

const settle = async (act) => { await act(async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); }); };

/** Mount the page on `path` over `lib`; returns what a case reads and presses. */
async function page(path, lib = LIB) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
    w.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
    w.IntersectionObserver = class { observe() { } unobserve() { } disconnect() { } };
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    let current = lib;
    w.fetch = (url) => {
        const u = String(url);
        if (/\/api\/projects(\?|$)/.test(u)) return json(current);
        // As server/shortCourses.js answers it: archived short courses are not on the list.
        if (/\/api\/short-courses(\?|$)/.test(u)) return json({ courses: current.filter(p => p.made_from && p.status !== 'archived').map(rowOf) });
        return new Promise(() => { });
    };
    w.eval(bundle);
    const { useStore, mount, act } = w.__gate;
    useStore.setState({ projects: lib, _navigate: () => { } });
    const el = w.document.getElementById('root');
    let r;
    await act(async () => { r = mount(el, path); });
    await settle(act);
    const text = () => el.textContent ?? '';
    const radios = () => [...el.querySelectorAll('[role="radio"]')];
    const radio = (word) => radios().find(b => b.textContent.trim().startsWith(word));
    const find = () => el.querySelector('input[role="searchbox"], input[type="search"]');
    const fill = async (input, value) => {
        const set = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;
        await act(async () => { set.call(input, value); input.dispatchEvent(new w.Event('input', { bubbles: true })); });
        await settle(act);
    };
    return {
        text, radios, radio, find, fill, el, where: () => w.__where,
        /** The library changes under the page (a course deleted, moved, finished). */
        setLib: async (next) => { current = next; await act(async () => { useStore.setState({ projects: next }); }); await settle(act); },
        /** Names from `names` on screen, in the order they are drawn. */
        order: (names) => names.filter(n => text().includes(n)).sort((a, b) => text().indexOf(a) - text().indexOf(b)),
        count: (word) => Number((radio(word)?.textContent ?? '').replace(/\D+/g, '') || NaN),
        press: async (node) => { await act(async () => { node.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }); await settle(act); },
        type: (value) => fill(find(), value),
        close: () => { act(() => r.unmount()); w.close(); },
    };
}

const NAMES = LIB.map(p => p.name);
const ACTIVE_FULL = ['Organic chemistry', 'Linear algebra', 'Dutch grammar'];
const ACTIVE_SHORT = ['Volcanoes', 'Tide pools', 'Puppy training', 'Bread baking', 'Sailing knots'];
const FINISHED = ['Café roasting', 'Calculus one', 'World history'];
const ARCHIVED = ['Chess openings', 'Old Spanish'];
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- 1. Active holds what is being studied ------------------------------------
section('Active shows what is being studied, and nothing that ended');
{
    const pg = await page('/projects');
    const shown = pg.order(NAMES);
    check('every active course is on Active, short and full',
        [...ACTIVE_FULL, ...ACTIVE_SHORT].every(n => shown.includes(n)), shown.join(', '));
    check('no finished course is on Active', !FINISHED.some(n => shown.includes(n)), shown.join(', '));
    check('no archived course is on Active', !ARCHIVED.some(n => shown.includes(n)), shown.join(', '));
    const shorts = pg.order(ACTIVE_SHORT), fulls = pg.order(ACTIVE_FULL);
    check('the short courses come before the full courses',
        shorts.length && fulls.length && pg.text().indexOf(shorts.at(-1)) < pg.text().indexOf(fulls[0]),
        shown.join(' · '));
    check('short courses by stage: being written, under way (last studied first), not begun, done to the end',
        same(shorts, ACTIVE_SHORT), shorts.join(' · '));
    check('full courses keep the learner\'s own order', same(fulls, ACTIVE_FULL), fulls.join(' · '));
    check('the switch says how many are in each view',
        pg.count('Active') === 8 && pg.count('Finished') === 3 && pg.count('Archived') === 2,
        pg.radios().map(b => b.textContent.trim()).join(' | ') || 'no switch');
    check('Active is the chosen view at /projects',
        pg.radio('Active')?.getAttribute('aria-checked') === 'true');
    pg.close();
}

// ---- 2. Finished and Archived ---------------------------------------------------
section('Finished and Archived hold both kinds, newest first');
{
    const pg = await page('/projects?show=finished');
    const shown = pg.order(NAMES);
    check('?show=finished shows every finished course, short and full, and nothing else',
        same(shown.slice().sort(), FINISHED.slice().sort()), shown.join(', '));
    check('…newest finished first (when its last topic closed)', same(shown, FINISHED), shown.join(' · '));
    check('…and Finished is the chosen segment', pg.radio('Finished')?.getAttribute('aria-checked') === 'true');
    pg.close();
}
{
    const pg = await page('/projects?show=archived');
    const shown = pg.order(NAMES);
    check('?show=archived shows every archived course, short and full, and nothing else',
        same(shown.slice().sort(), ARCHIVED.slice().sort()), shown.join(', '));
    check('…most recently put away first', same(shown, ARCHIVED), shown.join(' · '));
    pg.close();
}

// ---- 3. the view is in the address ------------------------------------------------
section('the view round-trips through ?show=');
{
    const pg = await page('/projects');
    const fin = pg.radio('Finished');
    if (fin) await pg.press(fin);
    check('pressing Finished puts ?show=finished in the address', pg.where() === '/projects?show=finished', pg.where());
    check('…and the page shows the finished courses', same(pg.order(NAMES), FINISHED), pg.order(NAMES).join(' · '));
    const act = pg.radio('Active');
    if (act) await pg.press(act);
    check('pressing Active goes back to plain /projects', pg.where() === '/projects', pg.where());
    pg.close();
    const odd = await page('/projects?show=nonsense');
    check('an unknown ?show= is Active', odd.radio('Active')?.getAttribute('aria-checked') === 'true'
        && !FINISHED.some(n => odd.text().includes(n)));
    odd.close();
}

// ---- 4. one search, the top bar's ---------------------------------------------------
// A find field of the page's own sat under the top bar's search, which already
// finds a course in any view and opens it: two searches on one page, the
// second adding nothing. The page has none, however big the library.
section('the page has no search of its own: the top bar finds courses');
for (const where of ['/projects', '/projects?show=finished', '/projects?show=archived']) {
    const pg = await page(where);
    check(`${where}: no find field of the page's own, with 13 projects`, !pg.find() && !pg.el.querySelector('input[placeholder^="Find"]'));
    pg.close();
}
{
    const big = [...LIB, ...Array.from({ length: 40 }, (_, i) => P(100 + i, `Extra course ${i + 1}`))];
    const pg = await page('/projects', big);
    check('…nor with 53', !pg.find() && !pg.el.querySelector('input[placeholder^="Find"]'));
    pg.close();
}

// ---- 5. what a small library does not get --------------------------------------
section('a first library gets no switch');
{
    const onlyActive = LIB.filter(p => p.status === 'active');
    const c = await page('/projects', onlyActive);
    check('nothing finished or archived: no switch to explain', c.radios().length === 0,
        c.radios().map(r => r.textContent).join(' | '));
    check('…and every active course is still on the page',
        onlyActive.every(p => c.text().includes(p.name)));
    c.close();
}

// ---- 6. the library changes under the page ---------------------------------------
section('the page stays usable when the library changes under it');
{
    // The last finished course goes back to Active while Finished is open: the
    // switch goes with it, so the page must not stay on an empty Finished view.
    const one = [...LIB.filter(p => p.status === 'active'), P(4, 'World history', { status: 'completed', completed_topic_count: 6, last_done_at: '2026-09-01T09:00:00.000Z' })];
    const pg = await page('/projects?show=finished', one);
    check('one finished course: Finished shows it', pg.text().includes('World history'));
    await pg.setLib(one.map(p => (p.id === 4 ? { ...p, status: 'active' } : p)));
    check('…moved back to Active, the page shows Active, not an empty Finished with no way out',
        pg.radios().length === 0 && ACTIVE_FULL.every(n => pg.text().includes(n)) && !/Nothing finished yet/.test(pg.text()),
        pg.text().slice(0, 200));
    pg.close();
}
{
    // An imported course can carry any string as a date.
    const odd = LIB.map(p => (p.id === 5 ? { ...p, last_done_at: 'not a date' } : p));
    const pg = await page('/projects?show=finished', odd);
    check('a finished course with an unreadable date still draws (its topic count instead)',
        pg.text().includes('Calculus one') && pg.text().includes('6 / 6 topics'), pg.text().slice(0, 160));
    pg.close();
}

console.log(`\n${pass} passed, ${fail} failed${BASE ? ` (ProjectsGrid + ShortCourses at ${BASE})` : ''}`);
process.exit(fail ? 1 : 0);
