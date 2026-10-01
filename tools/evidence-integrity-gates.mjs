// tools/evidence-integrity-gates.mjs — one answer is one piece of evidence.
//
// Run:  node tools/evidence-integrity-gates.mjs
//
// WHY. An answer reaches the learner model through three submissions — a feed
// card (`POST /api/feed/consume`), a practice quiz sitting and a mastery
// check — and each one was a string of separate writes with nothing tying
// them together (outside audits, 2026-09-30):
//   - the feed marked its row consumed BEFORE writing the evidence, with no
//     transaction, so a failed evidence write left the question gone from the
//     stream and a retry answered `duplicate: true` with nothing recorded;
//   - a question drawn from a saved bank has no feed row to guard it, so the
//     same submission sent twice (a retry after a lost response, a double
//     press) counted twice; the quiz and the check have the same shape;
//   - the page marked a card done before the save and never took it back, so
//     an answer that was never stored looked stored, with no way to send it
//     again.
// The fix is one transaction per submission and a client-issued attempt id
// per PRESENTATION of an answer, remembered under a unique key: the same id
// again returns the first outcome, a new sitting is new evidence. Never keyed
// on the question — answering it again another day is real evidence.
//
// Two halves. The SERVER half boots the real server in-process on a scratch
// library (DB_PATH/VAULT_ROOT set here, before any import) and injects write
// failures with TEMP triggers. The CLIENT half bundles the real store and the
// real feed cards into jsdom with the api call made to fail on demand.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'evidence-integrity-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.PORT = String(3310 + (process.pid % 10));
process.env.HOST = '127.0.0.1';
delete process.env.AI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.AI_BASE_URL;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n--- ${s} ---`);

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_enabled', 'false')").run();

const pid = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: evidence')`).run().lastInsertRowid);
const topic = (title) => Number(db.prepare('INSERT INTO nodes (project_id, title) VALUES (?, ?)').run(pid, title).lastInsertRowid);
const mc = (i) => ({ question: `Q${i}?`, type: 'multiple_choice', options: ['de', 'het'], correct_answer: 'de', explanation: 'de' });
const quizFor = (nodeId, n) => Number(db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)')
    .run(nodeId, 'Bank', JSON.stringify(Array.from({ length: n }, (_, i) => mc(i)))).lastInsertRowid);
const feedRow = (nodeId) => Number(db.prepare("INSERT INTO feed_items (node_id, kind, seq, status, content, meta) VALUES (?, 'question', 1, 'ready', ?, '{}')")
    .run(nodeId, JSON.stringify(mc(0))).lastInsertRowid);

const evidence = (n) => db.prepare('SELECT COUNT(*) AS c FROM mastery_evidence WHERE node_id = ?').get(n).c;
const attempts = (n) => db.prepare('SELECT total_attempts AS t FROM node_mastery WHERE node_id = ?').get(n)?.t ?? 0;
const logged = (n) => db.prepare('SELECT COUNT(*) AS c FROM question_log WHERE node_id = ?').get(n).c;
const quizAttempts = (q) => db.prepare('SELECT COUNT(*) AS c FROM quiz_attempts WHERE quiz_id = ?').get(q).c;
const statusOf = (id) => db.prepare('SELECT status FROM feed_items WHERE id = ?').get(id).status;
const failOn = (name, when) => db.exec(`CREATE TEMP TRIGGER ${name} ${when} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
const unfail = (name) => db.exec(`DROP TRIGGER IF EXISTS ${name}`);

const { consumeFeedItem } = await import(B + 'feed.js');

// ============================================================================
section('a failed evidence write leaves the answer unrecorded AND unconsumed');
{
    const n = topic('Fault on evidence');
    const item = feedRow(n);
    const event = { key: `fi-${item}`, kind: 'question', feedItemId: item, nodeId: n, result: { correct: true } };
    failOn('fail_evidence', 'BEFORE INSERT ON mastery_evidence');
    let threw = '';
    try { consumeFeedItem(event); } catch (e) { threw = e.message; }
    unfail('fail_evidence');
    check('the injected failure reaches the caller', /injected write failure/.test(threw), threw || 'no error');
    check('…and the card is still ready to be answered', statusOf(item) === 'ready', statusOf(item));
    check('…with nothing recorded', evidence(n) === 0 && attempts(n) === 0, `evidence ${evidence(n)}, attempts ${attempts(n)}`);
    let retry = null;
    try { retry = consumeFeedItem(event); } catch (e) { retry = { error: e.message }; }
    check('a retry is not taken for a duplicate', retry && !retry.duplicate && !retry.error, JSON.stringify(retry));
    check('…and records the answer exactly once', evidence(n) === 1 && attempts(n) === 1, `evidence ${evidence(n)}, attempts ${attempts(n)}`);
    const again = consumeFeedItem(event);
    check('a third send of the same row is the duplicate', again?.duplicate === true && evidence(n) === 1, JSON.stringify(again));
}
{
    const n = topic('Fault on the counters');
    const item = feedRow(n);
    failOn('fail_counters', 'BEFORE UPDATE ON node_mastery');
    let threw = '';
    try { consumeFeedItem({ key: `fi-${item}`, kind: 'question', feedItemId: item, nodeId: n, result: { correct: false } }); }
    catch (e) { threw = e.message; }
    unfail('fail_counters');
    check('a failure AFTER the evidence row is written rolls the evidence back too', /injected/.test(threw) && evidence(n) === 0,
        `threw ${threw || 'nothing'}, evidence ${evidence(n)}`);
    check('…and the card is still ready', statusOf(item) === 'ready', statusOf(item));
}
{
    const { updateMasteryFromAttempt } = await import(B + 'mastery.js');
    const n = topic('Fault inside the learner model');
    failOn('fail_counters2', 'BEFORE UPDATE ON node_mastery');
    try { updateMasteryFromAttempt(n, 3, 5, 'quiz'); } catch { /* expected */ }
    unfail('fail_counters2');
    check('updateMasteryFromAttempt on its own: evidence and counters land together or not at all', evidence(n) === 0,
        `evidence ${evidence(n)} with the counters refused`);
}

// ============================================================================
const { serverReady } = await import(B + 'index.js');
const ready = await serverReady;
const { request } = await import(ready.proto === 'https' ? 'node:https' : 'node:http');
const post = (path, body) => new Promise((resolve, reject) => {
    const req = request({
        host: '127.0.0.1', port: ready.port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json' }, rejectUnauthorized: false, timeout: 10_000,
    }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => { let b = null; try { b = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: b }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', body: null }); });
    req.on('error', reject);
    req.end(JSON.stringify(body));
});
const get = (path) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ready.port, path, rejectUnauthorized: false }, (res) => {
        let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
        res.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve(`${res.statusCode} ${text.slice(0, 200)}`); } });
    });
    req.on('error', reject);
    req.end();
});
const listed = await get('/api/projects');
const names = Array.isArray(listed) ? listed.map(p => p.name) : [JSON.stringify(listed)];
if (JSON.stringify(names) !== '["Fixture: evidence"]') {
    console.log(`\nRefusing to write: the server on :${ready.port} is not serving the fixture (${JSON.stringify(names)}).`);
    process.exit(1);
}
check(`guard: the server on :${ready.port} is serving the scratch library`, true);

section('a saved bank question sent twice with one attempt id counts once');
{
    const n = topic('Saved bank');
    const quiz = quizFor(n, 4);
    const body = (attemptId) => ({ key: `savedq-${quiz}-0`, kind: 'question', nodeId: n, result: { correct: true }, ...(attemptId ? { attemptId } : {}) });
    const first = await post('/api/feed/consume', body('feed-a1'));
    const second = await post('/api/feed/consume', body('feed-a1'));
    check('both answers are OK to the client', first.status === 200 && second.status === 200, `${first.status} / ${second.status}`);
    check('…the replay says it is one', second.body?.duplicate === true && !first.body?.duplicate, JSON.stringify(second.body));
    check('…one piece of evidence, one attempt on the counters', evidence(n) === 1 && attempts(n) === 1,
        `evidence ${evidence(n)}, total_attempts ${attempts(n)}`);
    check('…and the bank question is logged as asked once', logged(n) === 1, `${logged(n)} log rows`);
    check('…and the replay still carries the header counters', typeof second.body?.stats === 'object' && second.body?.stats !== null);
    await post('/api/feed/consume', body('feed-a2'));
    check('a NEW presentation of the same question is new evidence', evidence(n) === 2 && attempts(n) === 2 && logged(n) === 2,
        `evidence ${evidence(n)}, attempts ${attempts(n)}, log ${logged(n)}`);
    const both = await Promise.all([post('/api/feed/consume', body('feed-a3')), post('/api/feed/consume', body('feed-a3'))]);
    check('two sends of one id at the same moment: one is the answer, the other the duplicate',
        both.filter(r => r.body?.duplicate).length === 1 && evidence(n) === 3 && logged(n) === 3,
        `${JSON.stringify(both.map(r => r.body?.duplicate ?? false))} evidence ${evidence(n)}, log ${logged(n)}`);
    await post('/api/feed/consume', body(null));
    await post('/api/feed/consume', body(null));
    check('without an attempt id nothing changes: two sends are two answers, as before', evidence(n) === 5 && logged(n) === 5,
        `evidence ${evidence(n)}, log ${logged(n)}`);
}

section('the attempt id is validated');
{
    const n = topic('Validation');
    const quiz = quizFor(n, 4);
    for (const [label, attemptId] of [['a number', 12], ['65 characters', 'a'.repeat(65)], ['a space', 'a b'], ['an empty string', ''], ['a slash', 'a/b']]) {
        const r = await post('/api/feed/consume', { key: `savedq-${quiz}-0`, kind: 'question', nodeId: n, result: { correct: true }, attemptId });
        check(`${label} is refused with a 400`, r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
    }
    check('…and none of them wrote anything', evidence(n) === 0 && logged(n) === 0, `evidence ${evidence(n)}, log ${logged(n)}`);
    const ok = await post('/api/feed/consume', { key: `savedq-${quiz}-0`, kind: 'question', nodeId: n, result: { correct: true }, attemptId: 'A-z_09'.padEnd(64, 'x') });
    check('64 characters of [A-Za-z0-9_-] are accepted', ok.status === 200 && evidence(n) === 1, `${ok.status} ${JSON.stringify(ok.body)}`);
}

section('the feed route: the bank log is inside the same transaction');
{
    const n = topic('Fault on the log');
    const quiz = quizFor(n, 4);
    failOn('fail_log', 'BEFORE INSERT ON question_log');
    const r = await post('/api/feed/consume', { key: `savedq-${quiz}-1`, kind: 'question', nodeId: n, result: { correct: true }, attemptId: 'log-fault-1' });
    unfail('fail_log');
    check('a failed log write fails the request', r.status === 500, String(r.status));
    check('…and takes the evidence with it', evidence(n) === 0 && attempts(n) === 0, `evidence ${evidence(n)}, attempts ${attempts(n)}`);
    const again = await post('/api/feed/consume', { key: `savedq-${quiz}-1`, kind: 'question', nodeId: n, result: { correct: true }, attemptId: 'log-fault-1' });
    check('…so the retry with the same id is recorded, once', again.status === 200 && !again.body?.duplicate && evidence(n) === 1 && logged(n) === 1,
        `${again.status} ${JSON.stringify(again.body)} evidence ${evidence(n)} log ${logged(n)}`);
}

section('a practice quiz sitting sent twice with one attempt id counts once');
{
    const n = topic('Quiz sitting');
    const quiz = quizFor(n, 5);
    const body = (attemptId) => ({
        answers: { 0: 'de', 1: 'het' }, score: 1, total: 2,
        asked: [{ index: 0, correct: true }, { index: 1, correct: false }], attemptId,
    });
    const first = await post(`/api/ai/quizzes/${quiz}/attempt`, body('quiz-s1'));
    const second = await post(`/api/ai/quizzes/${quiz}/attempt`, body('quiz-s1'));
    check('both are answered 200', first.status === 200 && second.status === 200, `${first.status} / ${second.status}`);
    check('…the replay returns the first outcome, marked a duplicate',
        second.body?.duplicate === true && second.body?.id === first.body?.id && second.body?.score === 1,
        `${JSON.stringify(first.body)} / ${JSON.stringify(second.body)}`);
    check('…one attempt row, one piece of evidence, two log rows (the sitting asked two)',
        quizAttempts(quiz) === 1 && evidence(n) === 1 && logged(n) === 2,
        `attempts ${quizAttempts(quiz)}, evidence ${evidence(n)}, log ${logged(n)}`);
    await post(`/api/ai/quizzes/${quiz}/attempt`, body('quiz-s2'));
    check('a new sitting is a new attempt', quizAttempts(quiz) === 2 && evidence(n) === 2, `attempts ${quizAttempts(quiz)}, evidence ${evidence(n)}`);
    const bad = await post(`/api/ai/quizzes/${quiz}/attempt`, body('bad id!'));
    check('an invalid id is a 400 here too, and writes nothing', bad.status === 400 && quizAttempts(quiz) === 2, `${bad.status}`);
    await post(`/api/ai/quizzes/${quiz}/attempt`, { answers: { 0: 'de' }, score: 1, total: 1 });
    await post(`/api/ai/quizzes/${quiz}/attempt`, { answers: { 0: 'de' }, score: 1, total: 1 });
    check('without an id, two sends are still two attempts', quizAttempts(quiz) === 4, `attempts ${quizAttempts(quiz)}`);
}

section('a mastery check sent twice with one attempt id counts once');
{
    const n = topic('Mastery check');
    const quiz = quizFor(n, 6);
    const asked = [0, 1, 2, 3].map(index => ({ quizId: quiz, index, correct: true }));
    const body = (attemptId) => ({ nodeId: n, score: 4, total: 4, questions: [], asked, attemptId });
    const first = await post(`/api/projects/${pid}/mastery/mastery-check`, body('check-1'));
    const second = await post(`/api/projects/${pid}/mastery/mastery-check`, body('check-1'));
    check('both are answered 200, the replay with the first result', first.status === 200 && second.status === 200
        && second.body?.duplicate === true && second.body?.passed === first.body?.passed && second.body?.mastery_score === first.body?.mastery_score,
        `${JSON.stringify(first.body)} / ${JSON.stringify(second.body)}`);
    check('…one piece of evidence, one attempt row, four log rows', evidence(n) === 1 && quizAttempts(quiz) === 1 && logged(n) === 4,
        `evidence ${evidence(n)}, attempts ${quizAttempts(quiz)}, log ${logged(n)}`);
    await post(`/api/projects/${pid}/mastery/mastery-check`, body('check-2'));
    check('a retake is new evidence', evidence(n) === 2 && quizAttempts(quiz) === 2, `evidence ${evidence(n)}`);
    const bad = await post(`/api/projects/${pid}/mastery/mastery-check`, body('x'.repeat(65)));
    check('an invalid id is a 400, and writes nothing', bad.status === 400 && evidence(n) === 2, `${bad.status}`);
}

section('an id is per surface: the same string on the quiz and the check are two things');
{
    const n = topic('Two surfaces');
    const quiz = quizFor(n, 4);
    await post(`/api/ai/quizzes/${quiz}/attempt`, { answers: { 0: 'de' }, score: 1, total: 1, attemptId: 'shared-id' });
    const r = await post(`/api/projects/${pid}/mastery/mastery-check`, { nodeId: n, score: 4, total: 4, questions: [], asked: [], attemptId: 'shared-id' });
    check('the check is recorded, not answered with the quiz\'s outcome', r.status === 200 && !r.body?.duplicate && evidence(n) === 2,
        `${JSON.stringify(r.body)} evidence ${evidence(n)}`);
}

section('paper practice: one mark per exercise, written as one unit');
{
    // The card's own status is the once-guard: one practice row is one exercise.
    const exercise = { mode: 'document', brief: 'Derive v = f·λ.', reference_solution: 'v = f·λ', rubric: [
        { id: 'a', criterion: 'Names the quantities', weight: 2 }, { id: 'b', criterion: 'States the relation', weight: 2 }] };
    const practiceRow = (nodeId) => Number(db.prepare("INSERT INTO feed_items (node_id, kind, seq, status, content, meta) VALUES (?, 'practice', 100, 'ready', ?, '{}')")
        .run(nodeId, JSON.stringify(exercise)).lastInsertRowid);
    const paperRows = (id) => db.prepare('SELECT COUNT(*) AS c FROM paper_attempts WHERE feed_item_id = ?').get(id).c;

    const n = topic('Paper twice');
    const fi = practiceRow(n);
    const first = await post(`/api/paper/${fi}/self-grade`, { metCount: 2 });
    const second = await post(`/api/paper/${fi}/self-grade`, { metCount: 1 });
    check('a second self-mark of the same card is answered with the first, flagged a duplicate',
        first.status === 200 && second.status === 200 && second.body?.duplicate === true && second.body?.score === first.body?.score,
        `${JSON.stringify(first.body)} / ${JSON.stringify(second.body)}`);
    check('…one attempt row and one piece of evidence', paperRows(fi) === 1 && evidence(n) === 1, `attempts ${paperRows(fi)}, evidence ${evidence(n)}`);
    const photo = await post(`/api/paper/${fi}/grade`, {});
    check('a photo sent for a card already marked is not graded again (no image needed to say so)',
        photo.status === 200 && photo.body?.duplicate === true && paperRows(fi) === 1, `${photo.status} ${JSON.stringify(photo.body)}`);

    const m = topic('Paper fails');
    const fj = practiceRow(m);
    failOn('paper_evidence_fails', 'BEFORE INSERT ON mastery_evidence');
    const failed = await post(`/api/paper/${fj}/self-grade`, { metCount: 2 });
    unfail('paper_evidence_fails');
    check('a failed evidence write leaves no attempt row and the card still ready',
        failed.status === 500 && paperRows(fj) === 0 && statusOf(fj) === 'ready', `${failed.status} attempts ${paperRows(fj)} status ${statusOf(fj)}`);
    const again = await post(`/api/paper/${fj}/self-grade`, { metCount: 2 });
    check('…and marking it again records it once', again.status === 200 && !again.body?.duplicate && paperRows(fj) === 1 && evidence(m) === 1,
        `${again.status} attempts ${paperRows(fj)} evidence ${evidence(m)}`);
}

// ============================================================================
// CLIENT: the real store and the real cards, with the save made to fail.
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'DOMParser', 'File', 'Blob', 'XMLSerializer', 'localStorage', 'sessionStorage']) {
    try { globalThis[k] = window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = window.matchMedia || (q => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } }));
globalThis.matchMedia = window.matchMedia;
globalThis.ResizeObserver = window.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
globalThis.IntersectionObserver = window.IntersectionObserver = class { observe() { } unobserve() { } disconnect() { } };

// `--head` builds the client half from HEAD's store, api and cards (the
// server half always runs the working tree), to watch its cases fail on the
// pre-fix code.
const HEAD = process.argv.includes('--head');
const repo = join(here, '..');
const headClient = {
    name: 'head-client',
    setup(build) {
        if (!HEAD) return;
        build.onLoad({ filter: /[\\/]src[\\/](store\.ts|api\.ts|components[\\/](QuizView|feed[\\/](LessonCard|QuestionCard))\.tsx)$/ }, (args) => {
            const rel = args.path.slice(repo.length + 1).replace(/\\/g, '/');
            return {
                contents: require('node:child_process').execFileSync('git', ['show', `HEAD:${rel}`], { cwd: repo, encoding: 'utf8' }),
                loader: rel.endsWith('.tsx') ? 'tsx' : 'ts',
            };
        });
    },
};
const cache = join(here, '..', 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(cache, `evidence-integrity-${process.pid}.cjs`);
await require('esbuild').build({
    stdin: {
        contents: `
            import * as React from 'react';
            import '../src/i18n';
            import { createRoot } from 'react-dom/client';
            import { useStore } from '../src/store';
            import { api } from '../src/api';
            import LessonCard from '../src/components/feed/LessonCard';
            import QuestionCard from '../src/components/feed/QuestionCard';
            import QuizView from '../src/components/QuizView';
            const act = React.act;
            globalThis.__mountQuiz = (quiz) => {
                const el = document.createElement('div');
                document.body.appendChild(el);
                const root = createRoot(el);
                act(() => { root.render(React.createElement(QuizView, { quiz, onClose: () => { } })); });
                return { el, unmount: () => { act(() => root.unmount()); el.remove(); } };
            };
            globalThis.__gate = { useStore, api, act };
            globalThis.__mount = (kind, card, onDone) => {
                const Host = () => {
                    const done = useStore(s => !!s.feedDone[card.key]);
                    const handle = (k) => { onDone(k); useStore.getState().markFeedCardDone(k); };
                    return kind === 'lesson'
                        ? React.createElement(LessonCard, { card, done, onDone: handle })
                        : React.createElement(QuestionCard, { card, done, onDone: handle, inChapter: true });
                };
                const el = document.createElement('div');
                document.body.appendChild(el);
                const root = createRoot(el);
                act(() => { root.render(React.createElement(Host)); });
                return { el, unmount: () => { act(() => root.unmount()); el.remove(); } };
            };
        `,
        resolveDir: here,
        loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic',
    outfile, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
    plugins: [headClient],
});
require(outfile);
const { useStore, api, act } = globalThis.__gate;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
const click = async (el) => { if (!el) return; await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await flush(); };
const button = (root, label) => [...root.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith(label));

/** What the next consume does; every call is kept. */
const sent = [];
let respond = null;
api.consumeFeedCard = (payload) => { sent.push(payload); return respond(payload); };
const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const savedOk = () => Promise.resolve({ ok: true, stats: { itemsDoneToday: 1 } });
const errorToasts = () => useStore.getState().toasts.filter(t => t.type === 'error');
const reset = () => { sent.length = 0; useStore.setState({ toasts: [], feedDone: {} }); };
useStore.setState({ updateFeedStats: () => { } });

section('the store: a save that failed is not done');
{
    reset();
    respond = offline;
    const out = await useStore.getState().consumeFeedCard('failed-save', { kind: 'lesson', feedItemId: 1, nodeId: 1, result: { read: true }, attemptId: 'client-1' });
    check('the card is not left done', !useStore.getState().feedDone['failed-save'], JSON.stringify(useStore.getState().feedDone));
    check('…the caller is told it failed', out === false, String(out));
    check('…and the error toast still says so', errorToasts().length === 1, JSON.stringify(useStore.getState().toasts));
    check('the attempt id reaches the api', sent[0]?.attemptId === 'client-1', JSON.stringify(sent[0]));
    respond = savedOk;
    const ok = await useStore.getState().consumeFeedCard('failed-save', { kind: 'lesson', feedItemId: 1, nodeId: 1, result: { read: true }, attemptId: 'client-1' });
    check('a saved card is done, and the caller is told so', useStore.getState().feedDone['failed-save'] === true && ok === true, String(ok));
}

const common = { nodeId: 7, projectId: 1, projectName: 'P', projectColor: '#6366f1', nodeTitle: 'Lidwoorden' };
section('a lesson whose save failed can be sent again, with the same attempt id');
{
    reset();
    respond = offline;
    const dones = [];
    const card = { ...common, key: 'fi-lesson', kind: 'lesson', feedItemId: 41, partIndex: 1, partCount: 1, partTitle: 'De en het', markdown: 'Body text.', degraded: false, source: 'generated' };
    const m = globalThis.__mount('lesson', card, (k) => dones.push(k));
    await click(button(m.el, 'Got it, continue'));
    await flush();
    check('after the failure the lesson offers its button again', !!button(m.el, 'Got it, continue'), m.el.textContent.slice(0, 120));
    check('…and the reader has not been scrolled past it', dones.length === 0, `${dones.length} advances`);
    respond = savedOk;
    await click(button(m.el, 'Got it, continue'));
    await flush();
    check('once the save lands the stream moves on', dones.length === 1, `${dones.length} advances`);
    check('a second press sends it again', sent.length === 2, `${sent.length} sends`);
    check('…with the SAME attempt id', !!sent[0]?.attemptId && sent[0].attemptId === sent[1]?.attemptId, `${sent[0]?.attemptId} / ${sent[1]?.attemptId}`);
    check('…and the lesson now reads as done', /Read/.test(m.el.textContent) && !button(m.el, 'Got it, continue'));
    m.unmount();
    const m2 = globalThis.__mount('lesson', { ...card, key: 'fi-lesson-2', feedItemId: 42 }, () => { });
    await click(button(m2.el, 'Got it, continue'));
    check('another lesson is another attempt id', !!sent[2]?.attemptId && sent[2].attemptId !== sent[0].attemptId, `${sent[2]?.attemptId}`);
    m2.unmount();
}

section('an answered question whose save failed keeps the answer and sends it again');
{
    reset();
    respond = offline;
    const dones = [];
    const card = { ...common, key: 'savedq-5-0', kind: 'question', feedItemId: null, source: 'saved',
        question: { question: 'Which article?', type: 'multiple_choice', options: ['de', 'het'], correct_answer: 'de', explanation: 'It is a de-word.' } };
    const m = globalThis.__mount('question', card, (k) => dones.push(k));
    const option = [...m.el.querySelectorAll('button')].find(b => (b.textContent || '').trim().endsWith('de'));
    await click(option);
    await flush();
    check('the answer was sent', sent.length === 1 && sent[0].result?.correct === true, JSON.stringify(sent));
    check('after the failure the result is still on screen', /It is a de-word\./.test(m.el.textContent), m.el.textContent.slice(0, 200));
    check('…the card is not done', !useStore.getState().feedDone[card.key]);
    check('…and the reader has not been moved on', dones.length === 0, `${dones.length} advances`);
    const cont = button(m.el, 'Continue');
    check('…and there is a control to go on with', !!cont);
    respond = savedOk;
    await click(cont);
    check('pressing it sends the SAME answer with the SAME attempt id', sent.length === 2 && sent[1].attemptId === sent[0].attemptId
        && sent[1].result?.answer === sent[0].result?.answer, JSON.stringify(sent));
    check('…and only then is the card done and the reader moved on', useStore.getState().feedDone[card.key] === true && dones.length === 1,
        `done ${useStore.getState().feedDone[card.key]}, advances ${dones.length}`);
    m.unmount();
}

section('a practice quiz: Submit again after a failed send is the same sitting, Retry is a new one');
{
    reset();
    const ids = [];
    let respondQuiz = offline;
    api.submitQuizAttempt = (...args) => { ids.push(args[6]); return respondQuiz(); };
    const q = (i) => ({ question: `Article ${i}?`, type: 'multiple_choice', options: ['de', 'het'], correct_answer: 'de', explanation: 'x' });
    const m = globalThis.__mountQuiz({ id: 9, node_id: 7, title: 'Bank', questions: [q(1), q(2)], created_at: '2026-09-30' });
    const pick = async () => click([...m.el.querySelectorAll('button')].find(b => (b.textContent || '').trim().endsWith('de')));
    const sitting = async () => { await pick(); await click(button(m.el, 'Next')); await pick(); await click(button(m.el, 'Submit Quiz')); };
    await sitting();
    check('the failed send is still on the last question with Submit available', !!button(m.el, 'Submit Quiz'), m.el.textContent.slice(0, 160));
    await click(button(m.el, 'Submit Quiz'));
    check('Submit pressed again sends the SAME attempt id', ids.length === 2 && !!ids[0] && ids[0] === ids[1], JSON.stringify(ids));
    // An answer changed after the failed send is not the sitting the server may
    // already hold: a replayed id would be answered with that sitting's score.
    await click([...m.el.querySelectorAll('button')].find(b => (b.textContent || '').trim().endsWith('het')));
    respondQuiz = () => Promise.resolve({ id: 1, score: 1, total: 2, passThreshold: 0.8 });
    await click(button(m.el, 'Submit Quiz'));
    check('…but a changed answer goes as a NEW attempt id', ids.length === 3 && !!ids[2] && ids[2] !== ids[0], JSON.stringify(ids));
    await click(button(m.el, 'Retry Quiz'));
    await sitting();
    check('a retried quiz is a new sitting with a NEW attempt id', ids.length === 4 && !!ids[3] && ids[3] !== ids[0] && ids[3] !== ids[2], JSON.stringify(ids));
    m.unmount();
}

try { rmSync(outfile, { force: true }); } catch { /* swept later */ }
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
