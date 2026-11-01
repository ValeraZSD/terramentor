#!/usr/bin/env node
/**
 * The Dashboard tab's badge says how many reviews a course OWES, and says the
 * same number however the page was reached.
 *
 * The badge reads `dueFlashcardCount` from the store. Its writer had two
 * sources: the project list's `due_flashcard_count` (server/projectSummary.js,
 * reviews owed: `reviewDue` in server/decks.js) and, when the list was not
 * loaded yet, the LENGTH of the course's review session queue — owed reviews
 * PLUS the day's ration of new cards. A course URL opened straight from the
 * address bar, a bookmark or a reload took the second road, so the tab read 7
 * beside a plan saying "4 cards due", and which of the two stayed on screen
 * depended on which request answered last.
 *
 *   node tools/due-badge-gates.mjs            the working tree
 *   node tools/due-badge-gates.mjs --base REF the store at REF (must fail before the fix)
 *
 * Deterministic: the real store bundled with esbuild into jsdom, the api stubbed.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const baseAt = process.argv.indexOf('--base');
const BASE = baseAt > -1 ? process.argv[baseAt + 1] : null;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// --base swaps in that revision's store and nothing else.
const baseStore = {
    name: 'base-store',
    setup(build) {
        if (!BASE) return;
        build.onLoad({ filter: /[\\/]src[\\/]store\.ts$/ }, () => ({
            contents: execFileSync('git', ['show', `${BASE}:src/store.ts`], { cwd: root, encoding: 'utf8' }),
            loader: 'ts',
        }));
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `import { useStore } from './src/store'; import { api } from './src/api';
            window.__gate = { useStore, api };`,
        resolveDir: root, loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [baseStore],
})).outputFiles[0].text;

function freshStore() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    dom.window.eval(bundle);
    const { useStore, api } = dom.window.__gate;
    return { useStore, api, get: () => useStore.getState(), close: () => dom.window.close() };
}

/** A stub whose answers the case releases one at a time, in any order. */
function deferred() {
    const calls = [];
    const fn = (...args) => new Promise((res, rej) => calls.push({ args, res, rej }));
    return { fn, calls };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

// Course 1 owes 4 reviews; its session queue also carries 3 new cards.
const OWED = 4;
const queue = [
    ...Array.from({ length: OWED }, (_, i) => ({ id: i + 1, next_review: '2026-10-30T09:00:00.000Z', review_count: 3 })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: 10 + i, next_review: null, review_count: 0 })),
];
const project = (id, due) => ({ id, name: `course ${id}`, due_flashcard_count: due });

// ---------------------------------------------------------------------------
section('a course opened before the project list arrived');
{
    const s = freshStore();
    const due = deferred(), list = deferred();
    s.api.getDueFlashcards = due.fn;
    s.api.getProjects = list.fn;
    s.useStore.setState({ projects: [], currentProjectId: 1 });
    const p = s.get().loadDueFlashcardCount(1);
    await settle();
    for (const c of due.calls) c.res(queue);
    for (const c of list.calls) c.res([project(1, OWED), project(2, 9)]);
    await p; await settle();
    check('the badge counts the reviews owed (4), not the session queue with its new cards (7)',
        s.get().dueFlashcardCount === OWED, `badge ${s.get().dueFlashcardCount}`);
    s.close();
}

section('the same course, reached with the list loaded, reads the same number');
{
    const s = freshStore();
    let asked = 0;
    s.api.getDueFlashcards = async () => { asked++; return queue; };
    s.api.getProjects = async () => { asked++; return [project(1, OWED)]; };
    s.useStore.setState({ projects: [project(1, OWED)], currentProjectId: 1 });
    await s.get().loadDueFlashcardCount(1); await settle();
    check('list loaded: 4, read from the list', s.get().dueFlashcardCount === OWED, `badge ${s.get().dueFlashcardCount}`);
    check('…with no request', asked === 0, `${asked} request(s)`);
    s.close();
}

section('the list and the fallback answering in either order agree');
for (const order of ['fallback first', 'list first']) {
    const s = freshStore();
    const due = deferred(), list = deferred();
    s.api.getDueFlashcards = due.fn;
    s.api.getProjects = list.fn;
    s.useStore.setState({ projects: [], currentProjectId: 1 });
    // App start: the list is in flight; the course opens and asks for its count.
    const loading = s.get().loadProjects();
    const counting = s.get().loadDueFlashcardCount(1);
    await settle();
    const answerList = () => { for (const c of list.calls.splice(0)) c.res([project(1, OWED)]); };
    const answerQueue = () => { for (const c of due.calls.splice(0)) c.res(queue); };
    if (order === 'fallback first') { answerQueue(); await settle(); answerList(); }
    else { answerList(); await settle(); answerQueue(); }
    await Promise.all([loading, counting]); await settle();
    check(`${order}: the badge ends on 4`, s.get().dueFlashcardCount === OWED, `badge ${s.get().dueFlashcardCount}`);
    s.close();
}

section('an answer for a course the learner has left lands nowhere');
{
    const s = freshStore();
    const list = deferred();
    s.api.getDueFlashcards = async () => queue;
    s.api.getProjects = list.fn;
    s.useStore.setState({ projects: [], currentProjectId: 1, dueFlashcardCount: 0 });
    const p = s.get().loadDueFlashcardCount(1);
    await settle();
    s.useStore.setState({ currentProjectId: 2, dueFlashcardCount: 0 });
    for (const c of list.calls) c.res([project(1, OWED), project(2, 0)]);
    await p; await settle();
    check('course 1\'s count is not painted on course 2', s.get().dueFlashcardCount === 0, `badge ${s.get().dueFlashcardCount}`);
    s.close();
}

section('a course the list does not hold yet (just created) owes nothing');
{
    const s = freshStore();
    s.api.getDueFlashcards = async () => queue.slice(OWED); // only new cards
    s.api.getProjects = async () => [project(2, 5)];
    s.useStore.setState({ projects: [], currentProjectId: 1 });
    await s.get().loadDueFlashcardCount(1); await settle();
    check('no row for it: 0, not the 3 new cards', s.get().dueFlashcardCount === 0, `badge ${s.get().dueFlashcardCount}`);
    s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
