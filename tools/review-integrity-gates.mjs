// tools/review-integrity-gates.mjs — a rating the server did not take is not a
// rating, on the two review surfaces that write one per press.
//
// Run:  node tools/review-integrity-gates.mjs
//
// Mounts the REAL FlashcardView (a topic's cards) and GlobalFlashcardReview
// (the full-screen session) in jsdom, with `api` and `store` stubbed so each
// request can be made to fail, hang or conflict on demand. What is asserted:
//
//   - a failed save (an HTTP 500, a dropped connection) leaves the SAME card on
//     screen with the count unchanged and an error toast, and offers no undo
//     of a rating that never landed. FlashcardView used to log the failure and
//     advance anyway, so the session could end "all reviewed" with ratings
//     that were never stored;
//   - while a save is in flight, a second press (button or key) sends nothing;
//   - an undo names the review it takes back (`undo_of`, the stamp the rating
//     wrote), and when the server refuses it because the card was rated since
//     (another tab or device), the step is dropped with a toast rather than
//     pretending to have worked — and the step before it still undoes.

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

// Inside the project, as review-queue-gates does: `node_modules/.cache` is ignored by git.
const cache = join(here, '..', 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(cache, `review-integrity-${process.pid}.cjs`);

await require('esbuild').build({
    stdin: {
        contents: `
            import * as React from 'react';
            import '../src/i18n';
            import { createRoot } from 'react-dom/client';
            import { act as domAct } from 'react-dom/test-utils';
            import FlashcardView from '../src/components/FlashcardView';
            import GlobalFlashcardReview from '../src/components/GlobalFlashcardReview';
            const act = React.act || domAct;
            globalThis.__act = act;
            globalThis.__mount = (kind, cards) => {
                const el = document.createElement('div');
                document.body.appendChild(el);
                const root = createRoot(el);
                act(() => {
                    root.render(kind === 'view'
                        ? React.createElement(FlashcardView, { flashcards: cards, onClose: () => { }, onDelete: () => { } })
                        : React.createElement(GlobalFlashcardReview, { fetchCards: async () => cards, title: 'Gate', onClose: () => { }, onComplete: () => { } }));
                });
                return { el, unmount: () => { act(() => root.unmount()); el.remove(); } };
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
            build.onResolve({ filter: /\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }));
            build.onResolve({ filter: /\/api$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
            build.onLoad({ filter: /^store-stub$/, namespace: 'stub' }, () => ({
                contents: `export const useStore = Object.assign((sel) => sel(globalThis.__store), { getState: () => globalThis.__store });`,
                loader: 'js',
            }));
            build.onLoad({ filter: /^api-stub$/, namespace: 'stub' }, () => ({
                contents: `export const api = new Proxy({}, { get: (_, key) => globalThis.__api[key] || (async () => ({})) });`,
                loader: 'js',
            }));
        },
    }],
});

const toasts = [];
globalThis.__store = { addToast: (...a) => toasts.push(a) };
/** What the next updateFlashcard call does: a function (id, data) => Promise. */
let respond = null;
const calls = [];
globalThis.__api = {
    updateFlashcard: (id, data) => { calls.push({ id, data }); return respond(id, data); },
    deleteFlashcard: async () => ({}),
};
require(outfile);
const act = globalThis.__act;

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const $$ = (root, sel) => [...root.querySelectorAll(sel)];
const text = (root) => root.textContent || '';
// A control that is not on screen is a missed press, not a crash: the checks
// after it say what is wrong.
const click = async (el) => { if (!el) return; await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await flush(); };
const key = async (k) => { await act(async () => { window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true })); }); await flush(); };
const button = (root, label) => $$(root, 'button').find(b => (b.textContent || '').trim().startsWith(label));
const undoButton = (doc) => doc.querySelector('button[aria-label="Undo the last rating"]');
const ratingCalls = () => calls.filter(c => c.data.rating != null);
const undoCalls = () => calls.filter(c => c.data.undo_review);

const mkCards = () => [1, 2, 3].map(id => ({
    id, node_id: 1, front: `Question ${id}`, back: `Answer ${id}`, difficulty: 0,
    last_reviewed: null, next_review: null, review_count: 0, ease_factor: 2.5, last_interval: 0,
    stability: null, fsrs_difficulty: null, state: 0, lapses: 0, learning_steps: 0, created_at: '2026-09-01',
}));
const saved = (id, data) => Promise.resolve({ ...mkCards()[id - 1], ...data, review_count: 1 });
const http500 = () => Promise.reject(new Error('API error: 500'));
const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const staleUndo = () => Promise.reject(Object.assign(new Error('This card was reviewed again after that rating, so the rating can no longer be taken back.'),
    { data: { conflict: 'reviewed_since' } }));
const reset = () => { calls.length = 0; toasts.length = 0; };

// ---- FlashcardView ----------------------------------------------------------
console.log('\n--- FlashcardView: a failed save stays on the card ---');
{
    reset();
    const m = globalThis.__mount('view', mkCards());
    const doc = window.document;
    await key(' ');
    respond = http500;
    await click(button(doc.body, 'Good'));
    check('an HTTP 500 leaves the same card on screen', text(doc.body).includes('Question 1') && text(doc.body).includes('1 of 3'),
        text(doc.body).match(/\d of 3/)?.[0]);
    check('with an error toast', toasts.some(t => t[0] === 'error' && t[1] === 'Failed to update card'), JSON.stringify(toasts));
    check('and no undo for a rating that never landed', !undoButton(doc));
    // The server may have STORED a write whose answer was lost: resent with the
    // same stamp it is recognised as applied; recomputed it would be a second
    // review.
    const firstStamp = ratingCalls()[0]?.data.last_reviewed;
    respond = offline;
    await key('3');
    check('a dropped connection by KEY: same card, same count', text(doc.body).includes('Question 1') && text(doc.body).includes('1 of 3'));
    check('with a second toast', toasts.filter(t => t[0] === 'error').length === 2, `${toasts.length} toasts`);
    check('the same rating again resends the SAME write (its stamp), not a new review',
        !!firstStamp && ratingCalls()[1]?.data.last_reviewed === firstStamp, `${ratingCalls()[1]?.data.last_reviewed} vs ${firstStamp}`);
    reset();
    respond = saved;
    await click(button(doc.body, 'Good'));
    // Which card is on screen, not the "N of 3" count: Good on a NEW card puts
    // it on the learning ladder, and a card on the ladder is not yet counted.
    check('the retry is sent exactly once and moves on', ratingCalls().length === 1 && text(doc.body).includes('Question 2'),
        `${ratingCalls().length} calls`);
    check('…still carrying the first attempt\'s stamp', ratingCalls()[0]?.data.last_reviewed === firstStamp);
    check('and only now offers its undo', !!undoButton(doc));
    m.unmount();
}

console.log('\n--- FlashcardView: a save in flight locks the ratings ---');
{
    reset();
    const m = globalThis.__mount('view', mkCards());
    const doc = window.document;
    await key(' ');
    let release;
    respond = (id, data) => new Promise(r => { release = () => r({ ...mkCards()[id - 1], ...data, review_count: 1 }); });
    await click(button(doc.body, 'Good'));
    const easy = button(doc.body, 'Easy');
    if (easy) await click(easy);
    await key('2');
    check('a second press (button or key) sends nothing while the first is in flight', ratingCalls().length === 1, `${ratingCalls().length} requests`);
    await act(async () => { release(); });
    await flush();
    check('when it lands, the session moves on by ONE card', text(doc.body).includes('Question 2'));
    m.unmount();
}

console.log('\n--- FlashcardView: an undo the server refuses ---');
{
    reset();
    const m = globalThis.__mount('view', mkCards());
    const doc = window.document;
    respond = saved;
    await key(' ');
    await click(button(doc.body, 'Good'));
    await key(' ');
    await click(button(doc.body, 'Good'));
    const secondStamp = ratingCalls()[1]?.data.last_reviewed;
    respond = staleUndo;
    await click(undoButton(doc));
    check('the undo names the review it takes back', undoCalls()[0]?.data.undo_of === secondStamp && !!secondStamp,
        `${undoCalls()[0]?.data.undo_of} vs ${secondStamp}`);
    check('refused: the session stays where it was, with a toast',
        text(doc.body).includes('Question 3') && toasts.some(t => t[0] === 'error'), JSON.stringify(toasts));
    respond = saved;
    await click(undoButton(doc));
    check('the refused step is dropped: the next undo takes back the FIRST rating',
        undoCalls().length === 2 && undoCalls()[1].data.undo_of === ratingCalls()[0].data.last_reviewed
        && undoCalls()[1].id === 1 && text(doc.body).includes('Question 1'),
        `${undoCalls().length} undos, id ${undoCalls()[1]?.id}`);
    m.unmount();
}

// ---- GlobalFlashcardReview --------------------------------------------------
console.log('\n--- GlobalFlashcardReview: the same three rules ---');
{
    reset();
    const m = globalThis.__mount('global', mkCards());
    await flush();
    const doc = window.document;
    await key(' ');
    respond = http500;
    await key('3');
    check('a failed save stays on the card, with a toast', text(doc.body).includes('Question 1')
        && toasts.some(t => t[0] === 'error' && t[1] === 'Failed to update card'));
    const failedStamp = ratingCalls()[0]?.data.last_reviewed;
    let release;
    respond = (id, data) => new Promise(r => { release = () => r({ ...mkCards()[id - 1], ...data, review_count: 1 }); });
    reset();
    await key('3');
    check('the same rating again resends the failed write\'s stamp', !!failedStamp && ratingCalls()[0]?.data.last_reviewed === failedStamp);
    await key('4');
    check('a second key press sends nothing while the first is in flight', ratingCalls().length === 1, `${ratingCalls().length} requests`);
    await act(async () => { release(); });
    await flush();
    check('when it lands, the next card is shown', text(doc.body).includes('Question 2'));
    const stamp = ratingCalls()[0]?.data.last_reviewed;
    respond = staleUndo;
    await key('z');
    check('the undo names the review it takes back', undoCalls()[0]?.data.undo_of === stamp && !!stamp, `${undoCalls()[0]?.data.undo_of} vs ${stamp}`);
    check('refused: still on the next card, a toast, and no undo left to offer',
        text(doc.body).includes('Question 2') && toasts.some(t => t[0] === 'error') && !undoButton(doc),
        `undo button ${!!undoButton(doc)}, ${JSON.stringify(toasts)}`);
    m.unmount();
}

try { require('node:fs').rmSync(outfile, { force: true }); } catch { /* the cache is ignored */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
