// server/cardEvidence.js — what a flashcard rating tells the learner model.
//
// FSRS models each card and BKT each topic (`node_mastery`); this links them, so a
// topic held in cards is not read as unknown (nor left decaying into ghost
// questions via `decayedMastery`) while it is being reviewed.
//
// Ratings ACCUMULATE and are flushed as one binomial observation per topic, the
// rule an assessment follows (`bktBatchUpdate`): per-card BKT updates would put a
// transition between every two cards and make the result depend on card order.
//
// `review_log` is the source, keyed on the last flushed row id: it is written for
// every rating, undo removes from it, and double counting is impossible across
// restarts, imports and copied databases.
//
// Not counted:
//
//   * An imported Anki revlog (`source = 'anki'`): not answers given here, and it
//     would slam the posterior on the first rating after an import.
//   * A pagination node (`nodes.role = 'pagination'`): nothing to know.
//   * A rating undone before its flush (its `review_log` row is gone). One inside
//     a written observation stands; the next batch corrects the estimate.
//
// Cards cannot prove a topic: `checkMasteryEligibility`'s raw-score clause honours
// only `quiz`, `mastery_check` and `paper`.

import db from './database.js';
import { updateMasteryFromAttempt, MIN_GATE_QUESTIONS } from './mastery.js';
import { isPagination } from './nodeRole.js';

/**
 * The most ratings one flush may treat as a single observation.
 *
 * A binomial over hundreds of answers pins the posterior in one step. Twenty is
 * about a sitting; a longer backlog drains a batch at a time on later ratings.
 */
export const CARD_EVIDENCE_MAX_BATCH = 20;

/**
 * Did the answer come? "Again" is the one rating that says it did not.
 *
 * Hard is recalled with effort, which FSRS already prices by scheduling sooner.
 */
export function cardAnswerIsCorrect(rating) {
    return Number(rating) >= 2;
}

const cardNodeStmt = db.prepare(`
    SELECT f.node_id AS nodeId, n.role AS role
    FROM flashcards f JOIN nodes n ON n.id = f.node_id
    WHERE f.id = ?
`);

// The last review accounted for, per topic, read from the evidence row's metadata:
// which reviews an observation covered is a property of that observation.
const lastCoveredStmt = db.prepare(`
    SELECT metadata FROM mastery_evidence
    WHERE node_id = ? AND evidence_type = 'flashcard'
    ORDER BY id DESC LIMIT 1
`);

const pendingStmt = db.prepare(`
    SELECT rl.id AS id, rl.rating AS rating
    FROM review_log rl JOIN flashcards f ON f.id = rl.card_id
    WHERE f.node_id = ? AND rl.source = 'app' AND rl.id > ?
    ORDER BY rl.id ASC
    LIMIT ?
`);

/** The id of the newest review already folded into this topic's estimate. */
function lastCoveredReview(nodeId) {
    const row = lastCoveredStmt.get(nodeId);
    if (!row?.metadata) return 0;
    try {
        const through = JSON.parse(row.metadata)?.through;
        return Number.isInteger(through) ? through : 0;
    } catch {
        return 0;
    }
}

/**
 * Fold this card's topic's unaccounted-for ratings into the learner model, if
 * there are enough of them to be worth an observation.
 *
 * Called on the rating path (PUT /api/ai/flashcards/:id), so every review surface
 * gets it. Returns the observation written, or null (the usual case).
 */
export function recordCardEvidence(cardId) {
    const card = cardNodeStmt.get(cardId);
    if (!card?.nodeId || isPagination(card)) return null;

    const pending = pendingStmt.all(card.nodeId, lastCoveredReview(card.nodeId), CARD_EVIDENCE_MAX_BATCH);
    if (pending.length < MIN_GATE_QUESTIONS) return null;

    const score = pending.filter(r => cardAnswerIsCorrect(r.rating)).length;
    const result = updateMasteryFromAttempt(card.nodeId, score, pending.length, 'flashcard', {
        source: 'review',
        from: pending[0].id,
        through: pending.at(-1).id,
    });
    // The usual mastery fields plus the observation itself; unread on the rating
    // path, returned so a flush is testable.
    return { ...result, nodeId: card.nodeId, score, total: pending.length };
}
