// server/progress.js — how much of a project is done.
//
// ## Why a fraction, and not a count of ticks
//
// Progress was "closed leaves / leaves": a topic counted 1 once somebody marked
// it completed or skipped, and 0 until then. That is the right description of a
// written course, where finishing a topic is an act. It says nothing true about
// a topic whose content IS cards, because nobody is ever going to tick "Core"
// off by hand — measured on a real library, a 5,168-card vocabulary deck filed
// as six subdecks read 0 / 6 items and 0% with 471 of its cards met.
//
// So a topic is worth a fraction of itself:
//
//   closed (completed | skipped) → 1, whatever its cards say
//   otherwise, with cards        → cards met / cards
//   otherwise                    → 0
//
// "Met" is `review_count > 0`, the same measure the deck screen already prints
// as "met so far", so the two numbers on one screen cannot mean different
// things. It is deliberately a weak bar — met is not remembered — but the
// strong claim is `node_mastery`'s, and this number answers "how far through
// this am I", not "what do I know".
//
// ## A topic weighs what it holds
//
// A project is its topics' fractions weighted by CARDS — a topic with none
// weighs 1, which is what every topic of a written course weighs, so those are
// unaffected. Measured on a real library before choosing: the two rules agree
// to within four points on every course (38 vs 36, 18 vs 22, 7 vs 11) and part
// company only on a pure deck, where equal weighting called that 5,168-card
// deck 38% done because two of its six subdecks are small and finished, while
// 471 of its cards are met.
//
// 38% printed directly above a caption reading "471 / 5,168 cards met" is the
// app telling the reader two things at once, so: by cards, and the ring agrees
// with the caption under it and with a stage-only import's 8%.
//
// The known cost, accepted deliberately: attach one 500-card deck to a
// 96-topic course and that topic becomes most of the course's progress. If that
// ever happens, cap the weight here — it is one expression, and this comment is
// where to look.
//
// ## One function, four surfaces
//
// The project card, the study dashboard, the phase bars and `calculatePace` all
// read this. Three of those disagreeing by a point each is what
// memory/progress-metric-consistency is about: the app must never show two
// numbers for one project. `topicFraction` is the rule over a row already in
// hand, for the callers that have built a tree.

import db from './database.js';
import { WORK_LEAF } from './today.js';

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

// Work leaves with their card counts, per project. LEFT JOIN + GROUP BY rather
// than a correlated subquery per node: this runs for every project on the grid.
//
// Prepared on FIRST USE, not at import. `scheduling.js` reads this module and
// this module reads `today.js`, which reads `scheduling.js` — a real cycle, and
// under one import order `WORK_LEAF` is still in its temporal dead zone when
// this file's body runs. Deferring the statements makes the order irrelevant;
// they are still compiled exactly once.
let stmts = null;
function statements() {
    if (stmts) return stmts;
    const rows = `
        SELECT n.project_id AS projectId, n.id AS nodeId, n.status AS status,
               COUNT(f.id) AS cards,
               SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL THEN 1 ELSE 0 END) AS seen
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
 * What one topic contributes to its project's total: its cards, or 1 for a
 * topic that has none — the same weight every topic of a written course
 * carries, so a course with no cards is exactly the count it always was.
 */
export function topicWeight(row) {
    return Math.max(1, Number(row?.cards) || 0);
}

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
 * A collection with no topics at all — an import that is nothing but slices of
 * card order — still has a real answer to "how far through this am I", and it
 * is the one its own screen prints: cards met.
 *
 * Without this, `roll` divides by zero topics and a 1,501-card deck reads 0%
 * forever, which is the bug this whole module exists to remove, one shape
 * further along.
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
 * Every project's progress in one pass, keyed by id — what the grid needs.
 * A query per project is what turns a 23-project grid into 23 round trips.
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
    // A project with no work leaves never appears in that pass at all, so it
    // has to be asked for by name — the caller knows which projects exist.
    for (const id of projectIds || []) {
        if (!out.has(id)) out.set(id, cardsOnlyProgress(id));
    }
    return out;
}
