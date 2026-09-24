// server/progress.js — how much of a project is done.
//
// Not a count of ticked topics: nobody ticks off a topic whose content IS cards.
// A topic is worth a fraction of itself:
//
//   closed (completed | skipped) → 1, whatever its cards say
//   otherwise, with cards        → cards met / cards
//   otherwise                    → 0
//
// "Met" (reviewed at least once) is the deck screen's own "met so far". A weak bar
// on purpose: this answers "how far through am I"; `node_mastery` answers "what do
// I know".
//
// A project is its topics' fractions weighted by CARDS (a topic with none weighs 1,
// so a written course is a plain count), so a deck's ring agrees with its "cards
// met" caption. Exception: a TAUGHT topic (`TAUGHT_SQL`: overview of reading
// length, a note child, or a question bank) weighs one unit however many cards it
// carries, so sixty listening clips do not outweigh a course's grammar.
//
// One function behind the project card, study dashboard, phase bars and
// `calculatePace`, so one project never shows two numbers. `topicFraction` is the
// rule over a row already in hand.

import db from './database.js';
import { WORK_LEAF } from './today.js';
import { MATERIAL_MIN_CHARS } from './curriculumSchema.js';

/**
 * The share of one topic that is done. Takes a row carrying `status` and the
 * topic's card counts (`cards`, `seen`); missing counts read as none.
 */
export function topicFraction(row) {
    if (row?.status === 'completed' || row?.status === 'skipped') return 1;
    const cards = Number(row?.cards) || 0;
    if (cards <= 0) return 0;
    return Math.min(1, (Number(row?.seen) || 0) / cards);
}

// Work leaves with their card counts, per project; LEFT JOIN + GROUP BY, since this
// runs for every project on the grid.
//
// Prepared on FIRST USE: scheduling.js → progress.js → today.js → scheduling.js is
// a cycle, and under one import order `WORK_LEAF` is still in its temporal dead
// zone when this body runs.
let stmts = null;
function statements() {
    if (stmts) return stmts;
    const rows = `
        SELECT n.project_id AS projectId, n.id AS nodeId, n.status AS status,
               COUNT(f.id) AS cards,
               SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL THEN 1 ELSE 0 END) AS seen,
               ${TAUGHT_SQL} AS taught
        FROM nodes n
        LEFT JOIN flashcards f ON f.node_id = n.id
        WHERE ${WORK_LEAF}
        GROUP BY n.id
    `;
    stmts = {
        all: db.prepare(rows),
        one: db.prepare(`SELECT * FROM (${rows}) WHERE projectId = ?`),
    };
    return stmts;
}

/**
 * One topic's weight in its project's total: 1 if taught, else its cards (min 1).
 */
export function topicWeight(row) {
    if (Number(row?.taught)) return 1;
    return Math.max(1, Number(row?.cards) || 0);
}

/**
 * SQL for "this node has something to teach": `leafHasMaterial`'s test (an overview
 * of `MATERIAL_MIN_CHARS`, or a note child) plus a question bank. `n` is the nodes
 * alias.
 */
export const TAUGHT_SQL = `(
    LENGTH(COALESCE(n.description, '')) >= ${MATERIAL_MIN_CHARS}
    OR EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id AND c.is_note = 1)
    OR EXISTS (SELECT 1 FROM quizzes q WHERE q.node_id = n.id)
)`;

/** Roll a set of topic rows up into one project's progress. */
function roll(rows) {
    let total = 0, closed = 0, done = 0, weight = 0;
    for (const r of rows) {
        total += 1;
        if (r.status === 'completed' || r.status === 'skipped') closed += 1;
        const w = topicWeight(r);
        weight += w;
        done += topicFraction(r) * w;
    }
    return {
        fraction: weight > 0 ? done / weight : 0,
        closedTopics: closed,
        totalTopics: total,
    };
}

/**
 * A project with no work leaves (only slices of card order): progress is cards met,
 * or `roll` over zero topics would read 0% for ever.
 */
function cardsOnlyProgress(projectId) {
    const row = cardStatement().get(projectId);
    const cards = Number(row?.cards) || 0;
    const fraction = cards > 0 ? Math.min(1, (Number(row?.seen) || 0) / cards) : 0;
    return { fraction, closedTopics: 0, totalTopics: 0 };
}

let cardStmt = null;
function cardStatement() {
    if (!cardStmt) {
        cardStmt = db.prepare(`
            SELECT COUNT(*) AS cards,
                   SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL THEN 1 ELSE 0 END) AS seen
            FROM flashcards f JOIN nodes n ON n.id = f.node_id
            WHERE n.project_id = ?
        `);
    }
    return cardStmt;
}

/** One project's progress. */
export function projectProgress(projectId) {
    const rows = statements().one.all(projectId);
    return rows.length ? roll(rows) : cardsOnlyProgress(projectId);
}

/**
 * Every project's progress in one pass, keyed by id, for the grid.
 */
export function projectProgressById(projectIds = null) {
    const byProject = new Map();
    for (const row of statements().all.all()) {
        const list = byProject.get(row.projectId) || [];
        list.push(row);
        byProject.set(row.projectId, list);
    }
    const out = new Map();
    for (const [id, rows] of byProject) out.set(id, roll(rows));
    // A project with no work leaves is absent from that pass; the caller names it.
    for (const id of projectIds || []) {
        if (!out.has(id)) out.set(id, cardsOnlyProgress(id));
    }
    return out;
}
