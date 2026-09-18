#!/usr/bin/env node
/**
 * tools/topic-progress-gates.mjs — how much of a topic is done when its content
 * is cards.
 *
 * Run:  node tools/topic-progress-gates.mjs
 *
 * A count of ticks describes a written course and says nothing true about a
 * topic whose content IS cards: a 5,168-card deck topic reads 0 / 6 items and
 * 0% with 471 of its cards met (measured). Nobody is ever going to tick "Core"
 * off by hand; the work is the cards.
 *
 * So a topic is worth a FRACTION:
 *
 *   closed (completed or skipped) → 1, whatever its cards say
 *   otherwise, if it has cards    → cards met / cards
 *   otherwise                     → 0
 *
 * and a project is the mean of its topics — every topic weighted the same,
 * so 2,004 cards on one topic cannot outvote the ninety-five other topics of a
 * course that also happens to hold a deck.
 *
 * The rule that matters more than the formula: this is ONE function, and the
 * project card, the study dashboard, the phase bars and PACE all read it.
 * Three of those disagreeing by a point each is what
 * memory/progress-metric-consistency was written about.
 *
 * Deterministic: a scratch database, no model, no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'topic-progress-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (label, actual, expected) =>
    check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const near = (label, actual, expected, tol = 1e-6) =>
    check(label, Math.abs(actual - expected) <= tol, `expected ~${expected}, got ${actual}`);

const db = (await import('../server/database.js')).default;
const { ROLE_TOPIC, ROLE_PAGINATION } = await import('../server/nodeRole.js');
const { topicFraction, projectProgress, projectProgressById } =
    await import('../server/progress.js');
const { loadProjectSummaries } = await import('../server/projectSummary.js');

// ---- the rule, on one row in hand -------------------------------------------

eq('a closed topic is done', topicFraction({ status: 'completed', cards: 0, seen: 0 }), 1);
eq('a skipped topic is closed too', topicFraction({ status: 'skipped', cards: 0, seen: 0 }), 1);
eq('…even when its cards are untouched',
    topicFraction({ status: 'completed', cards: 100, seen: 0 }), 1);
eq('an open topic with no cards is nothing yet',
    topicFraction({ status: 'not_started', cards: 0, seen: 0 }), 0);
eq('an open topic is the share of its cards met',
    topicFraction({ status: 'in_progress', cards: 4, seen: 1 }), 0.25);
eq('…and a fully met topic reads done', topicFraction({ status: 'in_progress', cards: 8, seen: 8 }), 1);
eq('a missing count is not a divide by zero',
    topicFraction({ status: 'not_started', cards: null, seen: null }), 0);

// ---- the fixture: a deck-shaped project, like the Dutch dictionary ----------

const mk = (name, kind, position) => db.prepare(
    'INSERT INTO projects (name, kind, position) VALUES (?, ?, ?)'
).run(name, kind, position).lastInsertRowid;
const mkNode = (projectId, parentId, title, position, role = ROLE_TOPIC) => db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, role) VALUES (?, ?, ?, ?, ?)'
).run(projectId, parentId, title, position, role).lastInsertRowid;
let seq = 0;
/** `met` cards of `total` on this node — "met" is review_count > 0, as the deck screen counts it. */
const mkCards = (nodeId, total, met) => {
    for (let i = 0; i < total; i++) {
        const reviewed = i < met;
        db.prepare(`
            INSERT INTO flashcards (node_id, front, back, review_count, last_reviewed)
            VALUES (?, ?, ?, ?, ?)
        `).run(nodeId, `f${++seq}`, `b${seq}`, reviewed ? 1 : 0, reviewed ? new Date().toISOString() : null);
    }
};

const deckId = mk('Card collection', 'deck', 0);
const deckRoot = mkNode(deckId, null, 'Card collection', 0);
const core = mkNode(deckId, deckRoot, 'Core', 0);
const spoken = mkNode(deckId, deckRoot, 'Spoken', 1);
mkCards(core, 100, 50);   // half met
mkCards(spoken, 10, 10);  // all met

let p = projectProgress(deckId);
eq('both topics count', p.totalTopics, 2);
// A topic weighs what it holds, so this is 60 cards met of 110 — the number
// the caption under the ring prints — and NOT the mean of the two topics'
// percentages, which would call a deck 75% done for finishing its smallest
// tenth. Measured on the real library, that was the difference between 9% and
// 38% on a 5,168-card import.
near('the project is its cards, not the mean of its topics', p.fraction, 60 / 110);
eq('…and nothing is closed', p.closedTopics, 0);
check('a small finished topic does not carry the project',
    Math.abs(p.fraction - (0.5 + 1) / 2) > 0.1,
    `by cards ${p.fraction.toFixed(3)} vs equal weight ${((0.5 + 1) / 2).toFixed(3)}`);

// ---- pagination is not a topic, here either ---------------------------------

const stage = mkNode(deckId, deckRoot, 'Stage 1', 2, ROLE_PAGINATION);
mkCards(stage, 40, 0);
p = projectProgress(deckId);
eq('a slice of card order is not a third of the project', p.totalTopics, 2);
// 40 untouched cards on a pagination node, and the number does not move: they
// are rationed by the queue and belong to no topic.
near('…and its untouched cards do not drag the number down', p.fraction, 60 / 110);

// ---- an import that is nothing BUT slices of card order ---------------------
//
// No topics at all, so there is no mean to take — and the answer is still not
// zero. It is what that project's own screen prints: cards met.

const stagesOnlyId = mk('Stages all the way down', 'deck', 2);
const stagesRoot = mkNode(stagesOnlyId, null, 'Stages all the way down', 0);
mkCards(mkNode(stagesOnlyId, stagesRoot, 'Stage 1', 0, ROLE_PAGINATION), 100, 25);
mkCards(mkNode(stagesOnlyId, stagesRoot, 'Stage 2', 1, ROLE_PAGINATION), 100, 5);
p = projectProgress(stagesOnlyId);
eq('it has no topics', p.totalTopics, 0);
near('…and reads as the cards it has met, not as zero', p.fraction, 30 / 200);
near('the batched read finds it too, though no topic row names it',
    projectProgressById([stagesOnlyId]).get(stagesOnlyId).fraction, 30 / 200);

// ---- a written course, where nothing has cards ------------------------------

const courseId = mk('Written course', 'curriculum', 1);
const phase = mkNode(courseId, null, 'Phase 1', 0);
const topics = [0, 1, 2, 3].map(i => mkNode(courseId, phase, `Topic ${i}`, i));
db.prepare("UPDATE nodes SET status = 'completed' WHERE id = ?").run(topics[0]);
db.prepare("UPDATE nodes SET status = 'skipped' WHERE id = ?").run(topics[1]);
p = projectProgress(courseId);
near('a course with no cards is exactly what it always was: closed / total', p.fraction, 0.5);
eq('and the count is still a count', p.closedTopics, 2);

// A topic in that course picks up a deck of its own: partial credit, and the
// count of CLOSED topics does not move — the two numbers answer different
// questions and the card prints both.
mkCards(topics[2], 10, 5);
p = projectProgress(courseId);
// Weights 1, 1, 10, 1: the two closed topics are worth one apiece, the topic
// carrying ten cards is worth ten and half of them are met.
near('cards on one topic move the percentage', p.fraction, (1 + 1 + 5 + 0) / 13);
eq('…without pretending a topic was completed', p.closedTopics, 2);

// ---- every surface reads the same number ------------------------------------

const summary = loadProjectSummaries();
const deckRow = summary.find(r => r.id === deckId);
const courseRow = summary.find(r => r.id === courseId);
near('the project row carries the same fraction as the helper',
    deckRow.progress_fraction, projectProgress(deckId).fraction);
near('…for a course too', courseRow.progress_fraction, projectProgress(courseId).fraction);
eq('the row still carries the honest count of closed topics',
    courseRow.completed_topic_count, 2);

// One query for the whole grid, not one per project: the same numbers, or the
// grid and the project page disagree the moment a library gets big.
const byId = projectProgressById();
near('the batched read agrees with the single one',
    byId.get(deckId).fraction, projectProgress(deckId).fraction);
near('…and for the course', byId.get(courseId).fraction, projectProgress(courseId).fraction);

// ---- pace reads it too ------------------------------------------------------

const { calculatePace } = await import('../server/scheduling.js');
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
db.prepare('UPDATE projects SET start_date = ?, deadline = ? WHERE id = ?')
    .run(day(-10), day(10), courseId);
db.prepare('UPDATE nodes SET scheduled_start = ?, scheduled_end = ? WHERE project_id = ?')
    .run(day(-10), day(-1), courseId);
const pace = calculatePace(courseId);
eq('pace reports the same actual progress as the card',
    pace.actualProgress, Math.round(projectProgress(courseId).fraction * 100));

// ---- report -----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
process.exit(fail ? 1 : 0);
