#!/usr/bin/env node
/**
 * tools/card-evidence-gates.mjs — what a flashcard rating tells the learner
 * model.
 *
 * Run:  node tools/card-evidence-gates.mjs
 *
 * Until now it told it nothing. Rating a card wrote FSRS state and a
 * `review_log` row, and that was the end of it: measured on the real library on
 * 2026-09-09, 12,697 cards had produced 146 mastery-evidence rows, all of them
 * from quizzes and none from a card. So the app carried two independent models
 * of the same knowledge — FSRS per card, BKT per topic — and a topic held
 * entirely in cards still decayed into ghost questions asking whether it was
 * remembered.
 *
 * The rule this suite pins:
 *
 *   * ratings accumulate and are flushed as ONE binomial observation per topic
 *     (`bktBatchUpdate`), never one BKT update per card;
 *   * nothing is written until a batch is worth writing (MIN_GATE_QUESTIONS),
 *     and a batch is capped so one long session cannot pin the posterior;
 *   * every review is counted exactly once, ever;
 *   * an imported Anki revlog is history from another app, not answers given
 *     here, and is never evidence;
 *   * a slice of card order has no mastery to speak of;
 *   * and card evidence, like a drill, can never CLEAR the completion gate on
 *     its own — proving still needs an assessment.
 *
 * Deterministic: a scratch database, no model, no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'card-evidence-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (label, actual, expected) =>
    check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const db = (await import('../server/database.js')).default;
const { ROLE_TOPIC, ROLE_PAGINATION } = await import('../server/nodeRole.js');
const { getNodeMastery, checkMasteryEligibility, MIN_GATE_QUESTIONS } =
    await import('../server/mastery.js');
const {
    recordCardEvidence, CARD_EVIDENCE_MAX_BATCH, cardAnswerIsCorrect,
} = await import('../server/cardEvidence.js');

// ---- fixture ----------------------------------------------------------------

const projectId = db.prepare(
    "INSERT INTO projects (name, kind, position) VALUES ('Cards', 'deck', 0)"
).run().lastInsertRowid;
const mkNode = (title, role) => db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, role) VALUES (?, NULL, ?, 0, ?)'
).run(projectId, title, role).lastInsertRowid;

const topic = mkNode('2.2 Gradients', ROLE_TOPIC);
const stage = mkNode('Stage 1', ROLE_PAGINATION);

let cardSeq = 0;
const mkCard = (nodeId) => db.prepare(
    'INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, ?)'
).run(nodeId, `front ${++cardSeq}`, `back ${cardSeq}`).lastInsertRowid;

let reviewSeq = 0;
/** One row exactly as PUT /api/ai/flashcards/:id would leave behind. */
const review = (cardId, rating, source = 'app') => {
    reviewSeq++;
    db.prepare(`
        INSERT INTO review_log (card_id, reviewed_at, rating, state_before, elapsed_days,
                                scheduled_days, source)
        VALUES (?, ?, ?, 2, 1, 1, ?)
    `).run(cardId, new Date(Date.now() + reviewSeq * 1000).toISOString(), rating, source);
    return db.prepare('SELECT last_insert_rowid() AS id').get().id;
};

const evidenceRows = (nodeId) => db.prepare(
    "SELECT * FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'flashcard' ORDER BY id"
).all(nodeId);

// ---- what counts as knowing it ----------------------------------------------
//
// "Again" is the one rating that means the answer did not come. Hard came with
// effort, which is still recall — grading Hard as a miss would report a learner
// who remembers everything slowly as knowing none of it.

eq('Again is a miss', cardAnswerIsCorrect(1), false);
eq('Hard is recall', cardAnswerIsCorrect(2), true);
eq('Good is recall', cardAnswerIsCorrect(3), true);
eq('Easy is recall', cardAnswerIsCorrect(4), true);

// ---- nothing is written until a batch is worth writing ----------------------

const cards = Array.from({ length: 40 }, () => mkCard(topic));

for (let i = 0; i < MIN_GATE_QUESTIONS - 1; i++) {
    review(cards[i], 3);
    recordCardEvidence(cards[i]);
}
eq('three ratings write no evidence yet', evidenceRows(topic).length, 0);
eq('…and leave the estimate alone', getNodeMastery(topic).mastery_score, 0);

review(cards[3], 1);
const flushed = recordCardEvidence(cards[3]);
const rows = evidenceRows(topic);
eq('the fourth rating flushes one row', rows.length, 1);
eq('…covering every rating in the batch', rows[0].total, MIN_GATE_QUESTIONS);
eq('…scored by what was recalled', rows[0].score, 3);
check('…and the flush says what it wrote', flushed?.total === MIN_GATE_QUESTIONS, JSON.stringify(flushed));

const afterFirst = getNodeMastery(topic).mastery_score;
check('the estimate moved off a cold start', afterFirst > 0, String(afterFirst));

// One binomial, not four updates: with the same answers in the other order the
// estimate must land in exactly the same place (the bug this rule exists for).
const twin = mkNode('Same answers, other order', ROLE_TOPIC);
const twinCards = Array.from({ length: 4 }, () => mkCard(twin));
[1, 3, 3, 3].forEach((r, i) => { review(twinCards[i], r); recordCardEvidence(twinCards[i]); });
eq('order cannot matter — one sitting is one observation',
    getNodeMastery(twin).mastery_score, afterFirst);

// ---- every review counts exactly once ---------------------------------------

review(cards[4], 3);
recordCardEvidence(cards[4]);
eq('a fifth rating does not re-flush the first four', evidenceRows(topic).length, 1);

for (let i = 5; i < 8; i++) { review(cards[i], 3); recordCardEvidence(cards[i]); }
const second = evidenceRows(topic);
eq('the next four flush as their own observation', second.length, 2);
eq('…and cover only the new ratings', second[1].total, MIN_GATE_QUESTIONS);
const covered = second.reduce((n, r) => n + r.total, 0);
eq('nothing was counted twice', covered, 8);

// ---- a long session cannot pin the posterior in one go ----------------------

const marathon = mkNode('A long sitting', ROLE_TOPIC);
const many = Array.from({ length: CARD_EVIDENCE_MAX_BATCH + 15 }, () => mkCard(marathon));
many.forEach(id => review(id, 3));
const big = recordCardEvidence(many.at(-1));
eq('one flush is capped', big.total, CARD_EVIDENCE_MAX_BATCH);
eq('…and the backlog drains on the next rating, oldest first',
    recordCardEvidence(many.at(-1)).total, 15);
eq('…until there is nothing left to flush', recordCardEvidence(many.at(-1)), null);

// ---- what is NOT evidence ---------------------------------------------------

const imported = mkNode('Imported history', ROLE_TOPIC);
const importedCards = Array.from({ length: 6 }, () => mkCard(imported));
importedCards.forEach(id => review(id, 3, 'anki'));
eq('an imported revlog is not an answer given here',
    recordCardEvidence(importedCards[0]), null);
eq('…and writes nothing', evidenceRows(imported).length, 0);

const stageCards = Array.from({ length: 6 }, () => mkCard(stage));
stageCards.forEach(id => review(id, 3));
eq('a slice of card order has no mastery to record',
    recordCardEvidence(stageCards[0]), null);
eq('…and writes nothing', evidenceRows(stage).length, 0);

// ---- the boundary: practice tunes, proving needs an assessment --------------

const practised = mkNode('Practised hard, never tested', ROLE_TOPIC);
const practisedCards = Array.from({ length: 12 }, () => mkCard(practised));
practisedCards.forEach(id => { review(id, 4); recordCardEvidence(id); });
const gate = checkMasteryEligibility(practised, 0.85, 0.8);
check('perfect cards do produce a high estimate', gate.mastery_score > 0.85,
    String(gate.mastery_score));
const strong = db.prepare(`
    SELECT 1 FROM mastery_evidence
    WHERE node_id = ? AND evidence_type IN ('quiz', 'boss_fight', 'paper') LIMIT 1
`).get(practised);
check('…but a card is never assessment evidence', !strong);

// A topic whose cards are going badly must not be dragged over the line by the
// evidence merely EXISTING — the pre-fix behaviour of the raw-score clause.
const struggling = mkNode('Going badly', ROLE_TOPIC);
const strugglingCards = Array.from({ length: 8 }, () => mkCard(struggling));
strugglingCards.forEach(id => { review(id, 1); recordCardEvidence(id); });
const badGate = checkMasteryEligibility(struggling, 0.85, 0.8);
check('a topic being forgotten is not eligible to be marked known',
    badGate.eligible === false, JSON.stringify(badGate));

// ---- and the decay clock is reset by real study -----------------------------
//
// The reason this matters beyond the estimate: `decayedMastery` reads
// `node_mastery.last_updated`, so before this a topic carried entirely in cards
// went on decaying into ghost questions however faithfully it was reviewed.
const beforeStamp = db.prepare('SELECT last_updated FROM node_mastery WHERE node_id = ?').get(topic);
db.prepare("UPDATE node_mastery SET last_updated = '2020-01-01 00:00:00' WHERE node_id = ?").run(topic);
for (let i = 8; i < 12; i++) { review(cards[i], 3); recordCardEvidence(cards[i]); }
const afterStamp = db.prepare('SELECT last_updated FROM node_mastery WHERE node_id = ?').get(topic);
check('studying the cards marks the topic as freshly seen',
    afterStamp.last_updated > '2020-01-02', `${beforeStamp?.last_updated} -> ${afterStamp.last_updated}`);

// ---- report -----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
process.exit(fail ? 1 : 0);
