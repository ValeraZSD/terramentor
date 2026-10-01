#!/usr/bin/env node
// A finished check or quiz can be OPENED from the day's ledger (2026-10-01).
//
// Before this the ledger said "8 of 9 correct" and nothing on the server could
// say which one: a mastery check stored its questions and no answers, a quiz
// stored answers keyed by a position whose question it did not record. The
// grading screen now sends what it showed (`review`), the server keeps it beside
// the evidence row (`sitting_reviews`, server/sittingReview.js), and the ledger
// row opens to it.
//
// Held here, against the REAL server on a loopback port and a scratch library
// set in-process (a shell prefix has silently failed to apply before):
//   - the review is cut to the fields a question is drawn with, at fixed sizes,
//     and a review with no question in it writes no row;
//   - a mastery check and a quiz sitting each store theirs, on THEIR evidence row;
//   - the ledger marks exactly those rows (`evidenceId`) and nothing else, never
//     lists batched card evidence, and sends facts, not English sentences;
//   - the sitting opens over HTTP, an unknown one is a 404, and it goes with
//     its evidence row;
//   - a failed review never costs the check.
// No model, no internet.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'sitting-review-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.PORT = String(await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
}));
process.env.HOST = '127.0.0.1';

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const { normalizeSittingReview, MAX_REVIEW_ITEMS } = await import(B + 'sittingReview.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

if (!process.env.DB_PATH.startsWith(scratch)) throw new Error('refusing: not the scratch library');

const pid = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: sittings')`).run().lastInsertRowid);
const topic = Number(db.prepare(`INSERT INTO nodes (project_id, title) VALUES (?, 'Open syllables')`).run(pid).lastInsertRowid);
const mcq = (n) => ({
    type: 'multiple_choice', question: `maan → ? (${n})`, options: ['manen', 'mannen'], correct_answer: 'manen', explanation: 'Open syllable, one vowel letter.',
});
const quizId = Number(db.prepare(`INSERT INTO quizzes (node_id, title, questions) VALUES (?, 'Bank', ?)`)
    .run(topic, JSON.stringify([1, 2, 3, 4, 5].map(mcq))).lastInsertRowid);

console.log('\n--- the review is cut to what a question is drawn with ---');
{
    const items = normalizeSittingReview([
        { question: { ...mcq(1), html: '<script>x</script>', __secret: 1, tolerance: 0.5, media: [{ hash: 'nope', kind: 'image' }] }, answer: 'manen', correct: true, extra: 'drop me' },
        { question: { question: '   ' }, answer: 'x', correct: true },
        'not an item',
        { question: mcq(2), answer: 'mannen', correct: 'yes' },
    ]);
    check('only the entries that carry a question survive', items?.length === 2, JSON.stringify(items));
    check('unknown fields are dropped, known ones kept', items && !('html' in items[0].question) && !('__secret' in items[0].question)
        && !('extra' in items[0]) && items[0].question.tolerance === 0.5 && items[0].question.options.length === 2);
    check('a forged media hash is dropped', items && !('media' in items[0].question));
    check('"correct" is true only when it is the boolean true', items && items[0].correct === true && items[1].correct === false);
    check('nothing that is a question → null, so no row is written', normalizeSittingReview([{ question: {} }]) === null
        && normalizeSittingReview('x') === null && normalizeSittingReview([]) === null);
    const big = normalizeSittingReview(Array.from({ length: 200 }, (_, i) => ({ question: { ...mcq(i), question: 'q'.repeat(20000) }, answer: 'a'.repeat(20000), correct: true })));
    check(`at most ${MAX_REVIEW_ITEMS} items, each string capped`, big.length === MAX_REVIEW_ITEMS
        && big[0].question.question.length === 8000 && big[0].answer.length === 8000);
}

const { serverReady } = await import(B + 'index.js');
const ready = await serverReady;
const { request } = await import(ready.proto === 'https' ? 'node:https' : 'node:http');
const api = (path, init = {}) => new Promise((resolve, reject) => {
    const req = request({
        host: '127.0.0.1', port: ready.port, path, method: init.method || 'GET',
        headers: { 'Content-Type': 'application/json' }, rejectUnauthorized: false, timeout: 10_000,
    }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => { let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    if (init.body) req.write(JSON.stringify(init.body));
    req.end();
});

const review = [1, 2, 3, 4, 5].map(n => ({ question: mcq(n), answer: n === 3 ? 'mannen' : 'manen', correct: n !== 3 }));

console.log('\n--- a mastery check keeps its sitting ---');
let checkEvidence;
{
    const r = await api(`/api/projects/${pid}/mastery/mastery-check`, {
        method: 'POST', body: { nodeId: topic, score: 4, total: 5, questions: [1, 2, 3, 4, 5].map(mcq), attemptId: 'gate-check-1', review },
    });
    check('the check is recorded', r.status === 200 && r.body?.evidence_id > 0, `${r.status} ${JSON.stringify(r.body)}`);
    checkEvidence = r.body?.evidence_id;
    const row = db.prepare('SELECT items FROM sitting_reviews WHERE evidence_id = ?').get(checkEvidence);
    check('its review sits on its own evidence row', !!row && JSON.parse(row.items).length === 5);
}

console.log('\n--- a quiz sitting keeps its sitting ---');
let quizEvidence;
{
    const r = await api(`/api/ai/quizzes/${quizId}/attempt`, {
        method: 'POST', body: { answers: { 0: 'manen' }, score: 5, total: 5, attemptId: 'gate-quiz-1', review: review.map(i => ({ ...i, correct: true })) },
    });
    check('the sitting is recorded', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    quizEvidence = db.prepare(`SELECT id FROM mastery_evidence WHERE evidence_type = 'quiz' ORDER BY id DESC LIMIT 1`).get()?.id;
    check('its review sits on the quiz evidence row', !!db.prepare('SELECT 1 FROM sitting_reviews WHERE evidence_id = ?').get(quizEvidence));
}

console.log('\n--- a review that is junk costs nothing ---');
{
    const before = db.prepare('SELECT COUNT(*) n FROM sitting_reviews').get().n;
    const r = await api(`/api/projects/${pid}/mastery/mastery-check`, {
        method: 'POST', body: { nodeId: topic, score: 5, total: 5, attemptId: 'gate-check-2', review: 'not a list' },
    });
    check('the check still counts', r.status === 200 && r.body?.evidence_id > 0, `${r.status}`);
    check('...and no review row is written for it', db.prepare('SELECT COUNT(*) n FROM sitting_reviews').get().n === before);
}

console.log('\n--- the ledger opens exactly the kept sittings ---');
{
    db.prepare(`INSERT INTO mastery_evidence (node_id, evidence_type, score, total, metadata) VALUES (?, 'quiz', 1, 1, '{"source":"feed"}')`).run(topic);
    db.prepare(`INSERT INTO mastery_evidence (node_id, evidence_type, score, total, metadata) VALUES (?, 'flashcard', 9, 10, '{}')`).run(topic);
    const r = await api('/api/today/activity');
    const qs = (r.body?.events || []).filter(e => e.kind === 'question');
    const opens = qs.filter(e => e.evidenceId != null).map(e => e.evidenceId).sort((a, b) => a - b);
    check('the two kept sittings open, nothing else does', JSON.stringify(opens) === JSON.stringify([checkEvidence, quizEvidence].sort((a, b) => a - b)), JSON.stringify(opens));
    check('batched card evidence is not listed as a question', !qs.some(e => e.score === 9 && e.total === 10));
    check('rows carry facts and no English sentence (the pre-fix "detail")', qs.length > 0 && qs.every(e => !('detail' in e) && Number.isInteger(e.total)));
}

console.log('\n--- the sitting opens, and goes with its evidence ---');
{
    const r = await api(`/api/today/sittings/${checkEvidence}`);
    check('it opens with every question, answer and verdict', r.status === 200 && r.body?.items?.length === 5
        && r.body.items[2].correct === false && r.body.items[2].answer === 'mannen' && r.body.kind === 'mastery_check'
        && r.body.nodeTitle === 'Open syllables' && r.body.projectId === pid, JSON.stringify(r.body).slice(0, 200));
    check('an unknown sitting is a 404', (await api('/api/today/sittings/999999')).status === 404);
    check('a non-number is a 400', (await api('/api/today/sittings/abc')).status === 400);
    db.prepare('DELETE FROM mastery_evidence WHERE id = ?').run(checkEvidence);
    check('deleting the evidence deletes its review', !db.prepare('SELECT 1 FROM sitting_reviews WHERE evidence_id = ?').get(checkEvidence));
}

console.log('\n--- the screens send it ---');
{
    const src = (f) => readFileSync(new URL(`../src/components/${f}`, import.meta.url), 'utf8');
    check('the mastery check sends its review', /submitMasteryCheck\([^)]*review\)/.test(src('MasteryGateModal.tsx')));
    check('the quiz sends its review', /submitQuizAttempt\([^)]*review\)/.test(src('QuizView.tsx')));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
