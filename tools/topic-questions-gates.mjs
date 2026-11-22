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
check('Practise all leaves out reported cards by the date the server parks them on (isReportedCard mirrors PARKED_UNTIL)',
    /export const PARKED_UNTIL = '9999-/.test(read('server/itemReports.js')) && /startsWith\('9999-'\)/.test(read('src/utils/srs.ts')));
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
// One instant for the fixtures and for the mounted scheduler: a card's "not due
// yet", its relearning step and the date on its tile all read this clock.
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0); // Tue 10 Nov 2026, 12:00 UTC
// `clock` moves only where a check says so (a card falling due mid-run).
let clock = NOW;
const RealDate = Date;
globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
};
const later = new Date(NOW + 20 * 864e5).toISOString(); // 30 Nov 2026
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
const sent = []; // [id, update] for every rating written
const reads = { questions: 0, cards: 0 };
let finishCards = null;
// A failing list, and card reads held open to land later and in any order.
let questionsFail = false;
let holdCards = false;
const heldCards = [];
globalThis.__api = {
    getQuizzes: async () => { reads.questions++; if (questionsFail) throw new Error('offline'); return quizzes; },
    getFlashcards: async () => {
        reads.cards++;
        const answer = cards.slice();
        return holdCards ? new Promise(r => heldCards.push(() => r(answer))) : answer;
    },
    streamGenerateQuiz: async (...args) => { generated.push(args); return { id: 99 }; },
    streamGenerateFlashcards: () => new Promise(r => { finishCards = r; }),
    deleteQuiz: async (id) => { deleted.push(['quiz', id]); },
    deleteFlashcard: async (id) => { deleted.push(['card', id]); cards = cards.filter(c => c.id !== id); },
    updateFlashcard: async (id, update) => { written.push(id); sent.push([id, update]); return { id, ...update }; },
};
require(outfile);
const act = globalThis.__act;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const buttons = (el) => [...el.querySelectorAll('button')];
const button = (el, label) => buttons(el).find(b => (b.textContent || '').trim() === label);
const click = async (b) => { if (!b) return; await act(async () => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await flush(); };

console.log('--- the tab: sets by their size, no sitting ---');
{
    // Set 1 was written before this tab: it also carries two copies of other
    // topics' questions for review, which are not this topic's.
    const old = set(1, 'Quadratic Equations', 10);
    old.questions.push({ ...mcq(90), isGhost: true, ghostNodeId: 77 }, { ...mcq(91), isGhost: true, ghostNodeId: 78 });
    quizzes = [old, set(2, 'Quiz - 2026-11-01', 4)];
    // One card due long ago, one due in twenty days, one never seen: all three run.
    // Card 6 is reported: parked by the server until the report is settled.
    cards = [card(1, '2026-11-01T00:00:00.000Z'), card(2, later), card(6, '9999-12-31T00:00:00.000Z'), card(3, null)];
    const m = globalThis.__mount({ nodeId: 5, topicTitle: 'Quadratic equations' });
    await flush(); await flush();
    const text = m.el.textContent || '';
    const heads = [...m.el.querySelectorAll('h3')].map(h => h.textContent.trim());
    check('two sections, Questions then Cards', heads.join('|') === 'Questions|Cards', heads.join('|'));
    check('no Take Quiz and no best score', !/Take Quiz/.test(text) && !/Best:/.test(text), text.slice(0, 200));
    const rows = [...m.el.querySelectorAll('[data-section="questions"] li')].map(li => li.textContent);
    check('a set titled after its topic shows its own size (not the review copies), not the topic again',
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
    check('pressing it runs every card of the topic, due or not, and not a reported one (1 of 3)', /Front 1/.test(run) && /(?<!\d)1 of 3(?!\d)/.test(run), run.slice(0, 200));

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
    // What is written, not only which card: the rating Good (3) and a date
    // moved past now (it was due 1 Nov).
    const [, good] = sent[0] ?? [];
    check('...the write carries the rating Good and a next review after now',
        good?.rating === 3 && Date.parse(good?.next_review ?? '') > NOW, JSON.stringify(good ?? null));
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
    const soon = new Date(NOW + 5 * 60_000).toISOString();
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
    // A card due in a minute is "not due yet" when it is flipped; by the press
    // it is due, and a due card's Knew it is a Good like any other.
    written.length = 0; sent.length = 0;
    cards = [card(7, new Date(NOW + 60_000).toISOString())];
    const m = globalThis.__mount({ nodeId: 10, topicTitle: 'Falls due' });
    await flush(); await flush();
    await click(button(m.el, 'Practise all'));
    await click(m.el.querySelector('[role="button"][aria-pressed]'));
    const knew = buttons(m.el).find(b => (b.textContent || '').includes('Knew it'));
    clock = NOW + 2 * 60_000;
    await click(knew);
    clock = NOW;
    const [, update] = sent[0] ?? [];
    check('a card that falls due between the flip and the press is written by Knew it (a Good)',
        !!knew && JSON.stringify(written) === '[7]' && update?.rating === 3, JSON.stringify({ knew: !!knew, written, rating: update?.rating }));
    m.unmount();
}

console.log('--- the two lists are read on their own ---');
{
    quizzes = [set(1, 'Lists', 4)];
    cards = [card(2, later)];
    questionsFail = true;
    const logError = console.error;
    console.error = () => {}; // the failed read is logged; expected here
    const m = globalThis.__mount({ nodeId: 11, topicTitle: 'Lists' });
    await flush(); await flush();
    console.error = logError;
    const failed = m.el.querySelector('[data-section="questions"] [role="alert"]');
    check('questions that cannot be read say so with Try again, and the cards still show',
        /Could not load these questions/.test(failed?.textContent ?? '') && !!button(failed, 'Try again')
        && /Front 2/.test(m.el.querySelector('[data-section="cards"]')?.textContent ?? '')
        && !/No questions yet/.test(m.el.textContent), m.el.textContent.slice(0, 240));
    questionsFail = false;
    if (failed) await click(button(failed, 'Try again'));
    const rows = [...m.el.querySelectorAll('[data-section="questions"] li')].map(li => li.textContent);
    check('...Try again reads them', rows.length === 1 && /4 questions/.test(rows[0]) && !m.el.querySelector('[role="alert"]'), JSON.stringify(rows));
    m.unmount();
}
{
    const shown = (m) => [...m.el.querySelectorAll('[data-section="cards"] li')].map(li => (li.textContent.match(/Front \d+/) || [''])[0]).join(',');
    const closeRun = async (m) => { await click(button(m.el, 'Practise all')); await click(button(m.el, 'Exit') ?? button(m.el, 'Back')); };
    quizzes = []; deleted.length = 0;
    cards = [card(2, later), card(5, later)];
    const m = globalThis.__mount({ nodeId: 12, topicTitle: 'Stale reads' });
    await flush(); await flush();
    // Leaving a run re-reads the cards; card 5 is deleted while that read is out.
    holdCards = true;
    await closeRun(m);
    globalThis.__confirm = true;
    const li5 = [...m.el.querySelectorAll('[data-section="cards"] li')].find(li => /Front 5/.test(li.textContent));
    await click([...(li5?.querySelectorAll('button') ?? [])].find(b => b.getAttribute('aria-label') === 'Delete'));
    globalThis.__confirm = false;
    holdCards = false;
    await act(async () => { heldCards.shift()?.(); });
    await flush(); await flush();
    check('a read that was out while a card was deleted does not bring the card back',
        JSON.stringify(deleted) === '[["card",5]]' && shown(m) === 'Front 2', JSON.stringify({ deleted, shown: shown(m) }));
    // Two reads out at once: the newer one (card 8 added between them) lands
    // first, the older one after it, and the older one must not win.
    holdCards = true;
    await closeRun(m);
    cards = [...cards, card(8, later)];
    await closeRun(m);
    holdCards = false;
    await act(async () => { heldCards.pop()?.(); });
    await flush();
    await act(async () => { heldCards.pop()?.(); });
    await flush(); await flush();
    check('an older read landing after a newer one does not replace the newer list',
        heldCards.length === 0 && shown(m) === 'Front 2,Front 8', shown(m));
    m.unmount();
}

console.log('--- two sets that read the same ---');
{
    // Two sets of 5 titled after the topic read the same; a set of 3 does not.
    quizzes = [
        { ...set(1, 'Twins', 5), created_at: '2026-11-01 09:30:00' },
        { ...set(2, 'Twins', 5), created_at: '2026-11-02 14:05:00' },
        { ...set(3, 'Twins', 3), created_at: '2026-11-03 10:00:00' },
    ];
    cards = []; confirms.length = 0;
    const m = globalThis.__mount({ nodeId: 13, topicTitle: 'Twins' });
    await flush(); await flush();
    const rows = [...m.el.querySelectorAll('[data-section="questions"] li')];
    const made = rows.map(li => (li.textContent.match(/Made (.+?)(View|$)/) || [, ''])[1].trim());
    check('two sets that read the same each say when they were made; a set unlike the others does not',
        !!made[0] && !!made[1] && made[0] !== made[1] && !made[2], JSON.stringify(made));
    const view = rows[1]?.querySelector('button[aria-label="View questions"]');
    const described = (view?.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    check('...their View buttons are described by the row, the date included', /5 questions/.test(described) && described.includes(made[1]), described);
    globalThis.__confirm = false;
    await click(rows[1]?.querySelector('button[aria-label="Delete these questions"]'));
    check('...and deleting one names its date', confirms.at(-1) === `Delete the 5 questions made ${made[1]}?`, String(confirms.at(-1)));
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
    // In words, not "<10m" beside "20d": Again re-asks in this run, Knew it names the date it had.
    check('...Again says the card comes back in this run, Knew it names the date it keeps (30 Nov)',
        /Back in this run/.test(tiles[0]) && ['Still due 30 Nov', 'Still due Nov 30'].some(s => tiles[1].includes(s)) && !/<\d|\dmo\b|\dd\b/.test(tiles.join(' ')), JSON.stringify(tiles));
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
    const before = { ...reads };
    await click(go);
    check('questions are written without review questions from other topics (includeGhosts false)',
        generated.length === 1 && generated[0][0] === 6 && generated[0][3] === false, JSON.stringify(generated.map(a => a.slice(0, 4))));
    // A card list read here could land after a card was deleted meanwhile and bring it back.
    check('...and the refresh after it reads the questions only, not the cards',
        reads.questions === before.questions + 1 && reads.cards === before.cards, JSON.stringify({ before, after: reads }));

    console.log('--- one writer at a time ---');
    await click(button(m.el, 'More questions'));
    await click(button(m.el, 'More cards'));
    const go2 = button(m.el, 'Generate 5 questions');
    // Pressing it would detach the card stream: this tab would lose its progress and refresh.
    check('while cards are being written, Generate questions cannot be pressed', !!finishCards && !!go2 && go2.disabled,
        `${!!finishCards} ${go2 && go2.disabled}`);
    const mid = { ...reads };
    await act(async () => { finishCards?.(); });
    await flush();
    check('...and the refresh after the cards reads the cards only',
        reads.cards === mid.cards + 1 && reads.questions === mid.questions, JSON.stringify({ mid, after: reads }));
    m.unmount();
}

try { rmSync(outfile, { force: true }); } catch { /* swept later */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
