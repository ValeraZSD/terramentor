#!/usr/bin/env node
/**
 * tools/evidence-trail-gates.mjs — what the app thinks you know, per topic,
 * and the evidence behind it (GET /api/nodes/:nodeId/evidence).
 *
 *   node tools/evidence-trail-gates.mjs [--root DIR]
 *
 * The topic panel shows one word for the estimate and every answer that moved
 * it. What is pinned here:
 *   - the word: none, borrowed, proven, fading, practice, close, early — each
 *     state built on its own topic, the skipped topic and the deck included;
 *   - the trail adds up: each row's step starts where the row before it ended,
 *     and the newest row ends at the stored estimate (no claim on the topic),
 *     so the screen never shows a path to a number the topic does not hold;
 *   - a single feed answer names its question and the ref the "this is wrong"
 *     flag takes; a sitting with kept answers opens; a reported question is
 *     counted out;
 *   - reading writes nothing (no mastery row is made for a topic never answered).
 *
 * --root runs the same cases against another checkout's server; on the code
 * before this suite the route is missing and every case fails.
 *
 * Deterministic: a scratch library, no model, no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:http';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = resolve(argOf('--root') || repo);

// Set in-process, before any server module is imported.
const scratch = mkdtempSync(join(tmpdir(), 'evidence-trail-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const S = pathToFileURL(join(ROOT, 'server') + '/').href;
const { default: db } = await import(S + 'database.js');
if (!process.env.DB_PATH.startsWith(scratch)) throw new Error('refusing: not the scratch library');
const { updateMasteryFromAttempt, applySeededPrior, getNodeMastery } = await import(S + 'mastery.js');
const { recordCardEvidence } = await import(S + 'cardEvidence.js');
const { createApp } = await import(S + 'app.js');

const course = Number(db.prepare("INSERT INTO projects (name) VALUES ('Optics')").run().lastInsertRowid);
const deck = Number(db.prepare("INSERT INTO projects (name, kind) VALUES ('Kana', 'deck')").run().lastInsertRowid);
const addNode = (pid, title) => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, ?, 0)',
).run(pid, title).lastInsertRowid);

let reviewSeq = 0;
const rate = (cardId, rating) => {
    reviewSeq++;
    db.prepare(`
        INSERT INTO review_log (card_id, reviewed_at, rating, state_before, elapsed_days, scheduled_days, source)
        VALUES (?, ?, ?, 0, 0, 1, 'app')
    `).run(cardId, new Date(Date.UTC(2026, 0, 1) + reviewSeq * 1000).toISOString(), rating);
    return recordCardEvidence(cardId);
};
const sitting = (id, score, total, type = 'quiz', meta = null) => updateMasteryFromAttempt(id, score, total, type, meta);
const masteryRows = () => db.prepare('SELECT COUNT(*) AS c FROM node_mastery').get().c;

const server = createApp().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const { port } = server.address();
const get = (path) => new Promise((ok, no) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => { text += c; });
        res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } ok({ status: res.statusCode, body: json }); });
    });
    req.on('error', no);
    req.end();
});
// A reply that is not a trail (the route missing on old code) reads as an
// empty one, so every case fails by itself rather than the run crashing.
const trail = async (id) => {
    const body = (await get(`/api/nodes/${id}/evidence`)).body;
    return body && Array.isArray(body.rows) ? body : { estimate: {}, rows: [] };
};
const close = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;

try {
    console.log('\n--- 1. a topic never answered ---');
    const fresh = addNode(course, 'Refraction');
    const before = masteryRows();
    let t = await trail(fresh);
    check('no answers: the word is "none", no score, no rows', t?.estimate?.level === 'none' && t.estimate.score === null && t.rows.length === 0 && t.count === 0, JSON.stringify(t));
    check('…and reading it made no mastery row', masteryRows() === before, `${before} → ${masteryRows()}`);
    check('unknown topic: 404', (await get('/api/nodes/999999/evidence')).status === 404);
    check('a malformed id: 400', (await get('/api/nodes/abc/evidence')).status === 400);

    console.log('\n--- 2. one feed answer about a bank question ---');
    const one = addNode(course, 'Snell\'s law');
    const quizId = Number(db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(one, 'Bank', JSON.stringify([
        { question: 'What does n stand for in Snell\'s law?', type: 'multiple_choice', options: ['Index', 'Angle'], correct_answer: 'Index' },
    ])).lastInsertRowid);
    const stored = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(quizId).questions)[0];
    sitting(one, 1, 1, 'quiz', { source: 'feed', key: `savedq-${quizId}-0`, uuid: stored.uuid, questionType: 'multiple_choice' });
    t = await trail(one);
    const row = t?.rows?.[0] ?? {};
    check('one row, right, with its question', t?.rows?.length === 1 && row.score === 1 && row.total === 1 && row.question === stored.question, JSON.stringify(row));
    check('…it names the question for the flag (q:<uuid>) when the bank stamped one', typeof stored.uuid === 'string' ? row.ref === `q:${stored.uuid}` : row.ref === null, JSON.stringify({ uuid: stored.uuid, ref: row?.ref }));
    check('…its step starts at 0 and rises', row.before === 0 && row.after > 0, JSON.stringify(row));
    check('…and ends at the stored estimate', close(row.after, getNodeMastery(one).mastery_score), `${row.after} vs ${getNodeMastery(one).mastery_score}`);
    check('one answer is not proof: the word is "early" or "close", never "proven"', ['early', 'close'].includes(t.estimate.level), t.estimate.level);
    // A row with no uuid names its question by position, which a spliced bank
    // moves: it shows no question and offers no flag rather than a wrong one.
    sitting(one, 0, 1, 'quiz', { source: 'feed', key: `savedq-${quizId}-0`, questionType: 'multiple_choice' });
    t = await trail(one);
    check('a feed answer with no uuid: no question, no flag', t.rows[0]?.question === null && t.rows[0]?.ref === null, JSON.stringify(t.rows[0]));

    console.log('\n--- 3. many rows add up ---');
    const many = addNode(course, 'Lenses');
    sitting(many, 0, 1); sitting(many, 1, 1); sitting(many, 3, 5); sitting(many, 1, 1); sitting(many, 4, 5);
    t = await trail(many);
    const asc = [...t.rows].reverse();
    check('five rows, newest first', t.rows.length === 5 && t.count === 5 && t.rows[0]?.id > t.rows[4]?.id);
    check('each step starts where the one before it ended', asc.every((r, i) => i === 0 || close(r.before, asc[i - 1].after)), JSON.stringify(asc.map(r => [r.before, r.after])));
    check('the newest step ends at the stored estimate', close(t.rows[0]?.after, getNodeMastery(many).mastery_score), `${t.rows[0]?.after} vs ${getNodeMastery(many).mastery_score}`);
    check('the shown score is the gate\'s shown_score, a number in 0..1', typeof t.estimate.score === 'number' && t.estimate.score >= 0 && t.estimate.score <= 1);

    console.log('\n--- 4. proven, then fading ---');
    const proven = addNode(course, 'Mirrors');
    sitting(proven, 5, 5, 'mastery_check'); sitting(proven, 5, 5);
    t = await trail(proven);
    check('two full sittings: "proven"', t.estimate.level === 'proven', JSON.stringify(t.estimate));
    db.prepare("UPDATE node_mastery SET last_updated = datetime('now', '-40 days') WHERE node_id = ?").run(proven);
    db.prepare("UPDATE mastery_evidence SET created_at = datetime('now', '-40 days') WHERE node_id = ?").run(proven);
    t = await trail(proven);
    check('left alone 40 days (decay 14): "fading"', t.estimate.level === 'fading', JSON.stringify(t.estimate));
    check('…with the date it was last answered', typeof t.estimate.lastEvidenceAt === 'string' && Date.now() - Date.parse(t.estimate.lastEvidenceAt) > 30 * 86_400_000, t.estimate.lastEvidenceAt);
    db.prepare("UPDATE nodes SET status = 'skipped' WHERE id = ?").run(proven);
    t = await trail(proven);
    check('a skipped topic is never "fading" (FADING_TOPIC), and says it is skipped', t.estimate.level !== 'fading' && t.status === 'skipped', JSON.stringify({ level: t.estimate.level, status: t.status }));

    // FADING_TOPIC asks only for answers, an estimate over 0.5 and age: a
    // topic never proven must not be called "Proven, fading".
    const halfway = addNode(course, 'Polarisation');
    sitting(halfway, 1, 1); sitting(halfway, 1, 1);
    db.prepare("UPDATE node_mastery SET last_updated = datetime('now', '-40 days') WHERE node_id = ?").run(halfway);
    t = await trail(halfway);
    check('never proven, left alone 40 days: not "fading" (it is "close" or "early")', ['close', 'early'].includes(t.estimate.level), JSON.stringify(t.estimate));

    // Clause (b): a passed check proves the topic while the estimate stays
    // under a bar the learner raised to 95%. The word is "proven" and the
    // read says how.
    const byCheck = addNode(course, 'Diffraction');
    for (let i = 0; i < 6; i++) sitting(byCheck, 0, 1);
    sitting(byCheck, 4, 5, 'mastery_check');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mastery_threshold', '0.95')").run();
    t = await trail(byCheck);
    db.prepare("DELETE FROM settings WHERE key = 'mastery_threshold'").run();
    check('six wrong, then 4 of 5 on a check: "proven", by the check, with its number under the bar', t.estimate.level === 'proven' && t.estimate.byCheck === true && t.estimate.score < t.threshold && t.threshold === 0.95, JSON.stringify(t));
    check('…and a topic proven by its estimate is not marked byCheck', (await trail(many)).estimate.byCheck !== true || (await trail(many)).estimate.score < 0.85);

    console.log('\n--- 5. a head start, and practice ---');
    const seeded = addNode(course, 'Prisms');
    applySeededPrior(seeded, 'placement', 0.52, []);
    t = await trail(seeded);
    check('a placement seed and no answer: "borrowed", from placement', t.estimate.level === 'borrowed' && t.estimate.seed === 'placement', JSON.stringify(t.estimate));

    const deckTopic = addNode(deck, 'Hiragana');
    const cards = Array.from({ length: 4 }, (_, i) => Number(db.prepare('INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, ?)').run(deckTopic, `f${i}`, `b${i}`).lastInsertRowid));
    cards.forEach(c => rate(c, 4));
    t = await trail(deckTopic);
    check('a deck topic says it is a deck', t.projectKind === 'deck');
    check('four Easy ratings: one card row of 4, "practice" (cards never prove)', t.rows.length === 1 && t.rows[0]?.type === 'flashcard' && t.rows[0]?.total === 4 && t.estimate.level === 'practice', JSON.stringify(t));
    check('…and the count of ratings is there for the words', t.estimate.practiceTotal === 4 && t.estimate.practiceRight === 4, JSON.stringify(t.estimate));

    console.log('\n--- 6. a sitting that opens, a reported question ---');
    const kept = addNode(course, 'Dispersion');
    const res = sitting(kept, 4, 5, 'quiz', { voided: [{ u: 'x' }] });
    const evId = Number(db.prepare('SELECT MAX(id) AS id FROM mastery_evidence WHERE node_id = ?').get(kept).id);
    db.prepare('INSERT INTO sitting_reviews (evidence_id, items) VALUES (?, ?)').run(evId, '[]');
    t = await trail(kept);
    check('a sitting with kept answers is reviewable', t.rows[0]?.reviewable === true, JSON.stringify(t.rows[0]));
    check('…and one reported question counted out of it', t.rows[0]?.voided === 1, JSON.stringify(t.rows[0]));
    check('a row without kept answers is not', (await trail(many)).rows.every(r => r.reviewable === false));
    void res;
} finally {
    server.close();
    db.close();
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows holds the WAL a moment */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
