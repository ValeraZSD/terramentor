#!/usr/bin/env node
/**
 * Deterministic gates for the ONE card queue.
 *
 * "Due" has exactly one reading everywhere the app shows it, because a second
 * one contradicts it on the same day: a deck screen owes reviews plus a
 * rationed handful of new cards, while a count of every never-reviewed card
 * would put "1,483 cards due on day one" in front of a freshly imported deck.
 * Measured on the real library (2026-09-09): a project's Review button offered
 * 615 cards in one session, 615 of them never seen.
 *
 * So: "due" means work you OWE — a card with a next_review in the past. A card
 * that has never been seen is not owed, it is available, and how many of those
 * a day may introduce is the ration. Everything below pins that.
 *
 * No model, no network; throwaway database.
 *
 *   node tools/study-queue-gates.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'study-queue-gates-'));
process.env.DB_PATH = join(scratch, 'gates.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; return; }
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
    check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const db = (await import('../server/database.js')).default;
const { NOW_ISO } = await import('../server/database.js');
const {
    studyQueue, globalStudyQueue, deckCounts, setNewPerDay, getNewPerDay, reviewDue,
} = await import('../server/decks.js');

const iso = (daysFromNow) => new Date(Date.now() + daysFromNow * 86400000).toISOString();

const mkProject = (name, kind, position, status = 'active') => db.prepare(
    'INSERT INTO projects (name, kind, position, status) VALUES (?, ?, ?, ?)'
).run(name, kind, position, status).lastInsertRowid;
const mkNode = (projectId, title, position) => db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, ?, ?)'
).run(projectId, title, position).lastInsertRowid;
// `review_count`/`last_interval` decide the card's state; `next_review` decides
// whether it is owed. A card with neither is new.
const mkCard = (nodeId, { next = null, reps = 0, interval = 0 } = {}) => db.prepare(`
    INSERT INTO flashcards (node_id, front, back, next_review, last_reviewed, review_count, last_interval, stability)
    VALUES (?, 'f', 'b', ?, ?, ?, ?, ?)
`).run(nodeId, next, reps ? iso(-1) : null, reps, interval, reps ? 1.0 : null).lastInsertRowid;

// ---- the shared fragment ----------------------------------------------------

const course = mkProject('Course', 'curriculum', 0);
const courseNode = mkNode(course, 'Topic', 0);
for (let i = 0; i < 100; i++) mkCard(courseNode);                       // never seen
const owedIds = [mkCard(courseNode, { next: iso(-1), reps: 3, interval: 5 })];
mkCard(courseNode, { next: iso(+3), reps: 3, interval: 5 });            // not yet due

const owed = db.prepare(
    `SELECT COUNT(*) AS c FROM flashcards f WHERE f.node_id = ? AND ${reviewDue('f')}`
).get(courseNode).c;
eq('"due" counts only what is owed', owed, 1);
check('the fragment names its alias', reviewDue('x').includes('x.next_review'));

// ---- one project's queue ----------------------------------------------------

const q = studyQueue(course);
eq('the queue serves the owed review', q.reviews.length, 1);
eq('…and it is the right card', q.reviews[0].id, owedIds[0]);
check('the queue does NOT serve 100 unseen cards as due',
    q.fresh.length < 100, `${q.fresh.length} new`);
eq('new cards come in at the day’s allowance', q.fresh.length, getNewPerDay(course));
eq('a project authored here rations like the feed does', getNewPerDay(course), 10);

setNewPerDay(course, 3);
eq('the project’s own setting is honoured', studyQueue(course).fresh.length, 3);
setNewPerDay(course, 0);
eq('an allowance of zero introduces nothing', studyQueue(course).fresh.length, 0);
eq('…and still serves the reviews that are owed', studyQueue(course).reviews.length, 1);
setNewPerDay(course, 10);

// Study-ahead is the learner overruling the ration on purpose; it must never
// become the default queue's behaviour.
const ahead = studyQueue(course, { aheadDays: 7 });
eq('study-ahead pulls the future review forward', ahead.reviews.length, 2);
eq('the default queue is unchanged by it', studyQueue(course).reviews.length, 1);

// ---- the day's allowance is spent from the review log -----------------------

const logMet = (cardId) => db.prepare(`
    INSERT INTO review_log (card_id, reviewed_at, rating, state_before, elapsed_days, scheduled_days, source)
    VALUES (?, ${NOW_ISO}, 3, 0, 0, 1, 'app')
`).run(cardId);
const met = studyQueue(course).fresh.slice(0, 4);
for (const c of met) logMet(c.id);
eq('cards met today come off today’s allowance', studyQueue(course).fresh.length, 6);
eq('the counter agrees with the queue', deckCounts(course).introducedToday, 4);

// A stage the learner opened on purpose gets a full allowance, not the
// remainder — the same rule the deck ladder's Play button has always had.
eq('an explicitly opened topic gets a full allowance',
    studyQueue(course, { stageId: courseNode }).fresh.length, 10);

// ---- the cross-project queue ------------------------------------------------

const deck = mkProject('Imported deck', 'deck', 1);
const deckNode = mkNode(deck, 'Stage 1', 0);
for (let i = 0; i < 50; i++) mkCard(deckNode);
mkCard(deckNode, { next: iso(-2), reps: 4, interval: 30 });

const archived = mkProject('Archived', 'curriculum', 2, 'archived');
const archivedNode = mkNode(archived, 'Old', 0);
mkCard(archivedNode, { next: iso(-5), reps: 2, interval: 3 });
for (let i = 0; i < 10; i++) mkCard(archivedNode);

const g = globalStudyQueue();
eq('every owed review across active projects is served', g.reviews.length, 2);
check('an archived project contributes nothing',
    !g.reviews.some(c => c.project_id === archived) && !g.fresh.some(c => c.project_id === archived));
eq('each project brings its OWN allowance of new cards',
    g.fresh.filter(c => c.project_id === deck).length, getNewPerDay(deck));
eq('an import defaults to Anki’s twenty', getNewPerDay(deck), 20);
eq('…and the course brings what is left of its ten',
    g.fresh.filter(c => c.project_id === course).length, 6);
check('nothing unseen is served as a review',
    g.reviews.every(c => c.next_review != null));
eq('the whole global session is bounded',
    g.reviews.length + g.fresh.length, 2 + 20 + 6);

// A card with no review history and no next_review is new wherever it lives —
// the bug this file exists for was that only the deck door knew it.
const perProject = studyQueue(deck);
eq('the same project answers the same way through its own door',
    perProject.fresh.length, g.fresh.filter(c => c.project_id === deck).length);

// ---- report -----------------------------------------------------------------

try { (await import('../server/database.js')).closeDatabase(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }

if (failures.length) {
    console.error(`study-queue-gates: ${failures.length} FAILED, ${pass} passed`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
}
console.log(`study-queue-gates: ${pass} assertions passed`);
