// tools/retention-target-gates.mjs — a course's recall target, on the screens
// that use it.
//
// Run:  node tools/retention-target-gates.mjs
//
// Mounts the REAL review surfaces (the feed card, the full-screen session, a
// topic's cards) and the cards panel in jsdom, on the REAL store with `api`
// stubbed. What is asserted:
//
//   - every review surface follows its course's target as a subscription: a
//     surface drawn before the project list arrived (a cold start on the feed)
//     shows, and writes, the course's interval once the list lands. They read
//     the store once at render, and kept the standard 90% until something else
//     re-rendered them;
//   - the target button takes focus back once, straight after its editor
//     closes, and not again when the row is remounted later (a session ends and
//     the row moves between the owed and the done-for-today blocks);
//   - a forecast under one review a day is not shown as "about 0";
//   - a project list asked for before another one never lands over it, and the
//     older caller still reads a list at least as new as its own.

import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'DOMParser', 'File', 'Blob', 'XMLSerializer', 'localStorage']) {
    try { globalThis[k] = window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = window.matchMedia || (q => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } }));
globalThis.ResizeObserver = window.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
window.HTMLMediaElement.prototype.play = async () => { };
window.HTMLMediaElement.prototype.pause = () => { };

// Inside the project, as review-integrity-gates does: `node_modules/.cache` is ignored by git.
const cache = join(here, '..', 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(cache, `retention-target-${process.pid}.cjs`);

await require('esbuild').build({
    stdin: {
        contents: `
            import * as React from 'react';
            import '../src/i18n';
            import i18n from 'i18next';
            import { createRoot } from 'react-dom/client';
            import { act as domAct } from 'react';
            import { useStore } from '../src/store';
            import { computeNextInterval, computeSrsUpdate, formatInterval } from '../src/utils/srs';
            import FlashcardView from '../src/components/FlashcardView';
            import GlobalFlashcardReview from '../src/components/GlobalFlashcardReview';
            import FlashcardFeedCard from '../src/components/feed/FlashcardFeedCard';
            import CardsPanel from '../src/components/deck/CardsPanel';
            const act = React.act || domAct;
            globalThis.__act = act;
            globalThis.__store = useStore;
            globalThis.__hint = (card, retention) =>
                formatInterval(computeNextInterval(card, 'easy', new Date(), retention).intervalDays, i18n.t.bind(i18n));
            globalThis.__intervalAt = (card, at, retention) => computeSrsUpdate(card, 'easy', at, retention).last_interval;
            const make = {
                view: (p) => React.createElement(FlashcardView, { flashcards: p.cards, onClose: () => { }, onDelete: () => { } }),
                global: (p) => React.createElement(GlobalFlashcardReview, { fetchCards: async () => p.cards, title: 'Gate', onClose: () => { }, onComplete: () => { } }),
                feed: (p) => React.createElement(FlashcardFeedCard, { card: { key: 'k', kind: 'flashcard', card: p.cards[0], isNew: true }, done: false, onDone: () => { } }),
                panel: (p) => React.createElement(CardsPanel, { projectId: p.projectId, todayOnly: true, reloadKey: p.reloadKey }),
            };
            globalThis.__mount = (kind, props) => {
                const el = document.createElement('div');
                document.body.appendChild(el);
                const root = createRoot(el);
                act(() => { root.render(make[kind](props)); });
                return {
                    el,
                    rerender: (next) => act(() => { root.render(make[kind](next)); }),
                    unmount: () => { act(() => root.unmount()); el.remove(); },
                };
            };
        `,
        resolveDir: here,
        loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic',
    outfile, logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
    plugins: [{
        name: 'stubs',
        setup(build) {
            build.onResolve({ filter: /\/api$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
            build.onLoad({ filter: /^api-stub$/, namespace: 'stub' }, () => ({
                contents: `export const api = new Proxy({}, { get: (_, key) => globalThis.__api[key] || (async () => ({})) });
export const newAttemptId = () => Math.random().toString(16).slice(2).padEnd(16, '0');
export const goToSiteSignIn = () => {};`,
                loader: 'js',
            }));
        },
    }],
});

const calls = [];
globalThis.__api = {
    updateFlashcard: async (id, data) => { calls.push({ id, data }); return { id, ...data, review_count: 1 }; },
    getItemReports: async () => [],
};
require(outfile);
const act = globalThis.__act;
const store = globalThis.__store;

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const $$ = (root, sel) => [...root.querySelectorAll(sel)];
const click = async (el) => { if (!el) return; await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await flush(); };
const key = async (k) => { await act(async () => { window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true })); }); await flush(); };
const button = (root, label) => $$(root, 'button').find(b => (b.textContent || '').trim().startsWith(label));
/** The interval printed on the Easy button. */
const easyButton = (root) => $$(root, 'button').find(b => [...b.querySelectorAll('span')].some(s => (s.textContent || '').trim() === 'Easy'));
const easyHint = (root) => easyButton(root)?.querySelector('span.text-xs')?.textContent ?? null;

const COURSE = 7;
const newCard = (id) => ({
    id, node_id: 1, project_id: COURSE, project_name: 'Gate', project_color: '#0369a1',
    front: `Question ${id}`, back: `Answer ${id}`, difficulty: 0,
    last_reviewed: null, next_review: null, review_count: 0, ease_factor: 2.5, last_interval: 0,
    stability: null, fsrs_difficulty: null, state: 0, lapses: 0, learning_steps: 0, created_at: '2026-09-01',
});
const project = (retention) => ({ id: COURSE, name: 'Gate', description: '', color: '#0369a1', icon: 'Book', position: 0, desired_retention: retention });

// ---- every review surface follows the course's target --------------------------
console.log('\n--- the review surfaces: the target arrives after the card is on screen ---');
const want80 = globalThis.__hint(newCard(1), 0.8);
const want90 = globalThis.__hint(newCard(1), 0.9);
check('the fixture tells the targets apart (Easy on a new card)', want80 !== want90, `${want80} vs ${want90}`);
for (const [kind, flip] of [
    // The card face itself: a toggle named by the card's own words, no label.
    ['feed', (doc) => click(doc.querySelector('[role="button"][aria-pressed]'))],
    ['global', () => key(' ')],
    ['view', () => key(' ')],
]) {
    calls.length = 0;
    // Red on 2af46e9b: no project list yet, as on a cold start.
    act(() => store.setState({ projects: [], currentProjectId: COURSE }));
    const m = globalThis.__mount(kind, { cards: [newCard(1), newCard(2)] });
    await flush();
    await flip(window.document);
    const before = easyHint(window.document.body);
    act(() => store.setState({ projects: [project(0.8)] }));
    await flush();
    const after = easyHint(window.document.body);
    check(`${kind}: before the list, the standard 90%`, before === want90, `${before}`);
    check(`${kind}: the list lands and the Easy hint is the course's 80%`, after === want80, `${before} -> ${after}, wanted ${want80}`);
    await click(easyButton(window.document.body));
    const written = calls.find(c => c.data?.rating != null)?.data;
    const wanted = written ? globalThis.__intervalAt(newCard(1), new Date(written.last_reviewed), 0.8) : null;
    check(`${kind}: and the press writes the course's interval`, !!written && written.last_interval === wanted,
        `${written?.last_interval} vs ${wanted}`);
    m.unmount();
}

// ---- the cards panel: focus back once, and a small forecast --------------------
console.log('\n--- the cards panel ---');
{
    const deck = (owed) => ({
        project: { id: COURSE, name: 'Gate', color: '#0369a1', icon: 'Book', kind: 'deck', description: '' },
        totals: { new: 10, learning: 0, young: 5, mature: 0, cards: 15 },
        dueReviews: owed, newAvailable: 0, newRemaining: 0, newPerDay: 0, introducedToday: 0,
        reviewed: 5, lapsed: 0, seen: 5, forecast: { days: [owed, 0, 0, 0, 0, 0, 0], beyond: 0 },
        stages: [], matureDays: 21, currentStageId: null, desiredRetention: 0.9,
    });
    let owed = 3;
    globalThis.__api.getDeck = async () => deck(owed);
    globalThis.__api.getRetentionForecast = async () => ({
        current: 0.9, newPerDay: 0, days: 30,
        choices: [{ retention: 0.8, perDay: 0.4 }, { retention: 0.85, perDay: 0.6 }, { retention: 0.9, perDay: 1.2 }, { retention: 0.95, perDay: 3 }],
    });
    act(() => store.setState({ projects: [project(0.9)] }));
    const m = globalThis.__mount('panel', { projectId: COURSE, reloadKey: 1 });
    await flush();
    const target = () => button(m.el, 'Recall target');
    check('the panel shows the target button', !!target());
    await click(target());
    await flush();
    const rows = $$(m.el, 'label').map(l => (l.textContent || '').replace(/\s+/g, ' ').trim());
    const row = (pct) => rows.find(r => r.startsWith(pct)) ?? '';
    // Red on 2af46e9b: 0.4 a day read "about 0 reviews a day".
    check('a forecast under one a day keeps its decimal', row('80%').includes('about 0.4 reviews a day'), JSON.stringify(rows));
    check('one a day and up stays a whole number', row('95%').includes('about 3 reviews a day') && row('90%').includes('about 1 review a day'),
        JSON.stringify(rows));
    await click(button(m.el, 'Cancel'));
    check('closing the editor puts focus back on the target button', window.document.activeElement === target());
    // The learner moves on; a session ends with nothing left, and the row is
    // drawn again under "Done for today".
    button(m.el, 'Study 3 cards')?.focus();
    check('focus is on the Study button', window.document.activeElement === button(m.el, 'Study 3 cards'));
    owed = 0;
    m.rerender({ projectId: COURSE, reloadKey: 2 });
    await flush();
    await flush();
    check('the row moved to the done-for-today block', !button(m.el, 'Study 3 cards') && !!button(m.el, 'Study ahead anyway') && !!target());
    // Red on 2af46e9b: the remounted button took focus again.
    check('a later remount does not take focus back', window.document.activeElement !== target(),
        `focus on ${window.document.activeElement?.textContent}`);
    m.unmount();
}

// ---- the project list: an older answer never lands over a newer one -----------
console.log('\n--- loadProjects ---');
{
    const pending = [];
    globalThis.__api.getProjects = () => new Promise(resolve => pending.push(resolve));
    // Red on 2af46e9b: the poll's list, asked for before the save, landed last.
    const older = store.getState().loadProjects({ silent: true });
    const newer = store.getState().loadProjects({ silent: true });
    pending[1]([project(0.8)]);
    await newer;
    pending[0]([project(0.9)]);
    await older;
    check('a list asked for earlier does not land over a later one',
        store.getState().projects[0]?.desired_retention === 0.8, JSON.stringify(store.getState().projects[0]));

    pending.length = 0;
    let olderDone = false;
    const first = store.getState().loadProjects({ silent: true }).then(() => { olderDone = true; });
    const second = store.getState().loadProjects({ silent: true });
    pending[0]([project(0.85)]);
    await flush();
    check('the older caller waits for the newer list instead of returning on a list it did not draw', !olderDone);
    pending[1]([project(0.95)]);
    await second;
    await first;
    check('and reads the newer list when it does return', olderDone && store.getState().projects[0]?.desired_retention === 0.95);

    pending.length = 0;
    const alone = store.getState().loadProjects({ silent: true });
    pending[0]([project(0.8)]);
    await alone;
    check('a load on its own still draws its list', store.getState().projects[0]?.desired_retention === 0.8);
}

try { require('node:fs').rmSync(outfile, { force: true }); } catch { /* the cache is ignored */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
