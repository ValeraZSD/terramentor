// tools/topic-questions-gates.mjs — a topic's questions and cards sit in ONE
// tab, and Study is the way to be tested on them.
//
// Run:  node tools/topic-questions-gates.mjs
//
// The topic panel had three tabs (Details, Quizzes, Flashcards) and three runs
// beside Study: "Take Quiz" (its own sitting, its own "Best: 90%", and its own
// mastery evidence, a second proof path beside the mastery check), "Review
// these cards", and the course dashboard's Tools > Quizzes. Now:
//
//   1. the panel has two tabs, Details and "Questions and cards";
//   2. the quiz runner and the course's quiz list are gone, with the client
//      call that posted a sitting, and the dashboard has no Quizzes tool;
//   3. the tab shows each question set by its size (a set titled after its
//      topic does not print the topic again) with View and Delete, and no
//      Take Quiz or best score;
//   4. "Practise all" runs EVERY card of the topic, due or not (Study serves
//      only the due ones); with no cards there is no button. In that run a
//      card that is not due yet and that you knew keeps its date (nothing is
//      written), a card you missed is recorded, and a due card is reviewed as
//      Study reviews it; a new or (re)learning card always moves on its
//      ladder, so a miss in the run still gets its relearning step;
//   5. each section says in one line where its items are used, and each
//      delete asks first;
//   6. questions written here carry no review questions from other topics
//      (`includeGhosts` false): those were for a sitting to credit, and in
//      this list they would read as the topic's own.
//
// Static reads for 1-2, the REAL StudyTools mounted in jsdom (api and store
// stubbed) for 3-6.

import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

// ---- 1-2. the panel and the doors that went -------------------------------
console.log('--- the panel has one tab for questions and cards ---');
const panel = read('src/components/DetailPanel.tsx');
const tabs = [...panel.matchAll(/data-tab="([a-z-]+)"/g)].map(m => m[1]);
check('the topic panel has exactly two tabs, Details and Questions and cards',
    tabs.join(',') === 'details,questions', tabs.join(','));
check('...the second is labelled "Questions and cards" with no count beside it',
    /data-tab="questions"[\s\S]{0,700}?\{t\("Questions and cards"\)\}\s*<\/button>/.test(panel));
check('...and it mounts the one list, with the topic title', /<StudyTools key=\{selectedNodeId\} nodeId=\{selectedNodeId!\} topicTitle=\{node\.title\} \/>/.test(panel));

console.log('--- the separate runs are gone ---');
check('the quiz runner (QuizView) is gone', !existsSync(join(root, 'src/components/QuizView.tsx')));
check('the course\'s quiz list (ProjectQuizzesList) is gone', !existsSync(join(root, 'src/components/ProjectQuizzesList.tsx')));
const api = read('src/api.ts');
check('no client call posts a quiz sitting', !/\/attempt`/.test(api) && !/submitQuizAttempt/.test(api));
const dash = read('src/components/StudyDashboard.tsx');
check('the course dashboard has no Quizzes tool', !/title=\{tr\("Quizzes"\)\}/.test(dash) && !/ProjectQuizzesList|QuizView/.test(dash));

// ---- 3-5. the tab itself, mounted ------------------------------------------
const { JSDOM } = require('jsdom');
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
globalThis.matchMedia = window.matchMedia;
globalThis.ResizeObserver = window.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
globalThis.IntersectionObserver = window.IntersectionObserver = class { observe() { } unobserve() { } disconnect() { } };
window.HTMLMediaElement.prototype.play = async () => { };
window.HTMLMediaElement.prototype.pause = () => { };

const cache = join(root, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(cache, `topic-questions-${process.pid}.cjs`);
await require('esbuild').build({
    stdin: {
        contents: `
            import * as React from 'react';
            import '../src/i18n';
            import { createRoot } from 'react-dom/client';
            import StudyTools from '../src/components/StudyTools';
            const act = React.act;
            globalThis.__act = act;
            globalThis.__mount = (props) => {
                const el = document.createElement('div');
                document.body.appendChild(el);
                const r = createRoot(el);
                act(() => { r.render(React.createElement(StudyTools, props)); });
                return { el, unmount: () => { act(() => r.unmount()); el.remove(); } };
            };
        `,
        resolveDir: here,
        loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic',
    outfile, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
    loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.svg': 'dataurl' },
    plugins: [{
        name: 'stubs',
        setup(build) {
            build.onResolve({ filter: /\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }));
            build.onResolve({ filter: /\/api$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
            build.onLoad({ filter: /^store-stub$/, namespace: 'stub' }, () => ({
                // The two theme helpers too: the question viewer's Markdown and code
                // fields import them, and a stub missing a named export fails the build.
                contents: `export const useStore = Object.assign((sel) => sel(globalThis.__store), { getState: () => globalThis.__store, setState: () => {}, subscribe: () => () => {} });
export const themeKeyOf = (theme, tint) => theme + ':' + tint;
export const isDarkTheme = (t) => t === 'dark';`,
                loader: 'js',
            }));
            build.onLoad({ filter: /^api-stub$/, namespace: 'stub' }, () => ({
                contents: `export const api = new Proxy({}, { get: (_, key) => globalThis.__api[key] || (async () => ({})) });
export const newAttemptId = () => Math.random().toString(16).slice(2).padEnd(16, '0');`,
                loader: 'js',
            }));
        },
    }],
});

const toasts = [];
const confirms = [];
globalThis.__confirm = false;
globalThis.__store = new Proxy({
    addToast: (...a) => toasts.push(a),
    showConfirm: async (o) => { confirms.push(o.title); return globalThis.__confirm; },
    a11y: { readAloud: false, speechRate: 100, readingLine: false, confirmAnswers: false, cardAudioAutoplay: true, largerUi: false },
}, { get: (o, k) => (k in o ? o[k] : undefined) });
const today = new Date();
const later = new Date(today.getTime() + 20 * 864e5).toISOString();
const card = (id, due) => ({
    id, node_id: 5, front: `Front ${id}`, back: `Back ${id}`, difficulty: 0,
    last_reviewed: due ? '2026-11-01T00:00:00.000Z' : null, next_review: due, review_count: due ? 2 : 0, ease_factor: 2.5, last_interval: 0,
    stability: due ? 5 : null, fsrs_difficulty: due ? 5 : null, state: due ? 2 : 0, lapses: 0, learning_steps: 0, created_at: '2026-11-01',
});
const mcq = (i) => ({ question: `Question ${i}?`, type: 'multiple_choice', options: ['a', 'b', 'c', 'd'], correct_answer: 'a', explanation: '' });
const set = (id, title, n) => ({ id, node_id: 5, title, questions: Array.from({ length: n }, (_, i) => mcq(i)), created_at: '2026-11-01', best_score: 90 });
let quizzes = [], cards = [];
const generated = [];
const deleted = [];
const written = [];
globalThis.__api = {
    getQuizzes: async () => quizzes,
    getFlashcards: async () => cards,
    streamGenerateQuiz: async (...args) => { generated.push(args); return { id: 99 }; },
    deleteQuiz: async (id) => { deleted.push(['quiz', id]); },
    deleteFlashcard: async (id) => { deleted.push(['card', id]); },
    updateFlashcard: async (id, update) => { written.push(id); return { id, ...update }; },
};
require(outfile);
const act = globalThis.__act;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const buttons = (el) => [...el.querySelectorAll('button')];
const button = (el, label) => buttons(el).find(b => (b.textContent || '').trim() === label);
const click = async (b) => { if (!b) return; await act(async () => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await flush(); };

console.log('--- the tab: sets by their size, no sitting ---');
{
    quizzes = [set(1, 'Quadratic Equations', 10), set(2, 'Quiz - 2026-11-01', 4)];
    // One card due long ago, one due in twenty days, one never seen: all three run.
    cards = [card(1, '2026-11-01T00:00:00.000Z'), card(2, later), card(3, null)];
    const m = globalThis.__mount({ nodeId: 5, topicTitle: 'Quadratic equations' });
    await flush(); await flush();
    const text = m.el.textContent || '';
    const heads = [...m.el.querySelectorAll('h3')].map(h => h.textContent.trim());
    check('two sections, Questions then Cards', heads.join('|') === 'Questions|Cards', heads.join('|'));
    check('no Take Quiz and no best score', !/Take Quiz/.test(text) && !/Best:/.test(text), text.slice(0, 200));
    const rows = [...m.el.querySelectorAll('[data-section="questions"] li')].map(li => li.textContent);
    check('a set titled after its topic shows its size, not the topic again',
        /10 questions/.test(rows[0] ?? '') && !/Quadratic/i.test(rows[0] ?? ''), rows[0]);
    check('...a set whose title adds something shows it', /4 questions/.test(rows[1] ?? '') && /2026-11-01/.test(rows[1] ?? ''), rows[1]);
    const setButtons = [...m.el.querySelectorAll('[data-section="questions"] li button')].map(b => b.getAttribute('aria-label'));
    check('each set offers View and Delete, nothing to sit', setButtons.join('|') === 'View questions|Delete these questions|View questions|Delete these questions', setButtons.join('|'));
    const viewText = [...m.el.querySelectorAll('[data-section="questions"] li button')].find(b => b.getAttribute('aria-label') === 'View questions')?.textContent.trim();
    check('...and View says so in a word, not only an eye beside the bin', viewText === 'View', String(viewText));
    const uses = [...m.el.querySelectorAll('section > div > p')].map(p => p.textContent.trim());
    check('each section says where its items are used',
        uses[0] === 'Study asks a few of these each day.'
        && uses[1] === 'Study shows each card on the day it is due. Practise all goes through every one now.', uses.join(' | '));

    console.log('--- deleting asks first ---');
    const bin = [...m.el.querySelectorAll('[data-section="questions"] li button')].find(b => b.getAttribute('aria-label') === 'Delete these questions');
    globalThis.__confirm = false;
    await click(bin);
    check('deleting a set asks "Delete these 10 questions?" and a No deletes nothing',
        confirms.at(-1) === 'Delete these 10 questions?' && deleted.length === 0, JSON.stringify({ confirms, deleted }));
    const cardBin = [...m.el.querySelectorAll('[data-section="cards"] li button')].find(b => b.getAttribute('aria-label') === 'Delete');
    await click(cardBin);
    check('deleting a card asks too, and a No deletes nothing', confirms.at(-1) === 'Delete this card?' && deleted.length === 0, JSON.stringify({ confirms, deleted }));
    globalThis.__confirm = true;
    await click(bin);
    check('...a Yes deletes the set', JSON.stringify(deleted) === '[["quiz",1]]', JSON.stringify(deleted));
    globalThis.__confirm = false;

    console.log('--- practise all the cards ---');
    const practise = button(m.el, 'Practise all');
    check('the Cards heading has a Practise all button', !!practise, buttons(m.el).map(b => b.textContent.trim()).join(' / '));
    await click(practise);
    await flush();
    const run = m.el.textContent || '';
    check('pressing it runs every card of the topic, due or not (1 of 3)', /Front 1/.test(run) && /(?<!\d)1 of 3(?!\d)/.test(run), run.slice(0, 200));

    // Card 1 is overdue, card 2 due in twenty days, card 3 never seen.
    const plate = () => m.el.querySelector('[role="button"][aria-pressed]');
    const rate = async (label) => {
        await click(plate());
        const shown = m.el.textContent || '';
        await click(buttons(m.el).find(b => (b.textContent || '').includes(label)));
        return shown;
    };
    const s1 = await rate('Good');
    check('a due card is reviewed as Study reviews it: Good writes its new schedule', JSON.stringify(written) === '[1]', JSON.stringify(written));
    check('...under the usual question', /How well did you know this\?/.test(s1), s1.slice(0, 160));
    const s2 = await rate('Knew it');
    check('a card not due yet that you knew keeps its date: Knew it writes nothing', JSON.stringify(written) === '[1]' && /Front 3/.test(m.el.textContent), JSON.stringify(written));
    check('...and the line above the ratings tells you it keeps its date', /Not due yet: if you knew it, it keeps its date\./.test(s2), s2.slice(0, 200));
    await rate('Good');
    check('a card never seen is a first review: Good writes it', JSON.stringify(written) === '[1,3]', JSON.stringify(written));
    m.unmount();
}
{
    // A card you miss is news whenever it happens, due or not.
    quizzes = []; written.length = 0;
    cards = [card(2, later)];
    const m = globalThis.__mount({ nodeId: 7, topicTitle: 'One card' });
    await flush(); await flush();
    await click(button(m.el, 'Practise all'));
    await click(m.el.querySelector('[role="button"][aria-pressed]'));
    await click(buttons(m.el).find(b => (b.textContent || '').includes('Again')));
    check('a card not due yet that you missed is recorded (Again writes)', JSON.stringify(written) === '[2]', JSON.stringify(written));
    // The miss put it on its relearning step, minutes away: it comes straight
    // back, and knowing it now is that step, written like any other.
    const back = m.el.textContent || '';
    await click(m.el.querySelector('[role="button"][aria-pressed]'));
    const shown = m.el.textContent || '';
    await click(buttons(m.el).find(b => (b.textContent || '').includes('Good')));
    check('...it comes back on its relearning step, and Good then writes too (no "keeps its date")',
        /Front 2/.test(back) && JSON.stringify(written) === '[2,2]' && !/Not due yet/.test(shown), JSON.stringify({ written, shown: shown.slice(0, 160) }));
    m.unmount();
}
{
    // A card already on its relearning ladder (missed in Study, back in ten
    // minutes) is not "not due yet": its step runs.
    written.length = 0;
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    cards = [{ ...card(4, soon), state: 3, lapses: 1, learning_steps: 0 }];
    const m = globalThis.__mount({ nodeId: 8, topicTitle: 'Relearning' });
    await flush(); await flush();
    await click(button(m.el, 'Practise all'));
    await click(m.el.querySelector('[role="button"][aria-pressed]'));
    await click(buttons(m.el).find(b => (b.textContent || '').includes('Good')));
    check('a relearning card due in minutes is rated as a step: Good writes', JSON.stringify(written) === '[4]', JSON.stringify(written));
    m.unmount();
}
{
    // A kept rating can be taken back, and the card then rated again.
    written.length = 0;
    cards = [card(2, later), card(5, later)];
    const m = globalThis.__mount({ nodeId: 9, topicTitle: 'Undo' });
    await flush(); await flush();
    await click(button(m.el, 'Practise all'));
    await click(m.el.querySelector('[role="button"][aria-pressed]'));
    const tiles = [...m.el.querySelectorAll('[data-rating]')].map(b => b.textContent.replace(/\s+/g, ' ').trim());
    check('a card not due yet offers two tiles, Again and Knew it (Hard, Good and Easy would all keep its date)',
        tiles.length === 2 && /^Again/.test(tiles[0]) && /^Knew it/.test(tiles[1]), JSON.stringify(tiles));
    // Key 3 (Good on a due card) is Knew it here, as are 2 and 4.
    await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: '3', bubbles: true })); });
    await flush();
    const after = m.el.textContent || '';
    await click(button(m.el, 'Undo'));
    const undone = m.el.textContent || '';
    // Undo comes back with the answer showing, as it was when rated.
    await click(buttons(m.el).find(b => (b.textContent || '').includes('Again')));
    check('key 3 keeps the date, Undo returns to that card, and Again on it writes once',
        /Front 5/.test(after) && /Front 2/.test(undone) && /(?<!\d)1 of 2(?!\d)/.test(undone) && JSON.stringify(written) === '[2]',
        JSON.stringify({ written, after: after.slice(0, 80), undone: undone.slice(0, 120) }));
    m.unmount();
}
{
    quizzes = []; cards = [];
    const m = globalThis.__mount({ nodeId: 6, topicTitle: 'Empty topic' });
    await flush(); await flush();
    const text = m.el.textContent || '';
    check('with no cards there is no practise button', !buttons(m.el).some(b => /Practise/.test(b.textContent)), text.slice(0, 200));
    check('...and both sections say they are empty', /No questions yet/.test(text) && /No flashcards yet/.test(text), text.slice(0, 200));

    console.log('--- writing more questions ---');
    await click(button(m.el, 'More questions'));
    const go = button(m.el, 'Generate 5 questions');
    check('More questions opens the options with a button that says what it makes', !!go, buttons(m.el).map(b => b.textContent.trim()).join(' / '));
    await click(go);
    check('questions are written without review questions from other topics (includeGhosts false)',
        generated.length === 1 && generated[0][0] === 6 && generated[0][3] === false, JSON.stringify(generated.map(a => a.slice(0, 4))));
    m.unmount();
}

try { rmSync(outfile, { force: true }); } catch { /* swept later */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
