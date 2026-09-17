// server/cardEvidence.js — what a flashcard rating tells the learner model.
//
// ## Why this exists
//
// The app kept two independent models of the same knowledge and let them run
// past each other: FSRS per card (stability, difficulty, when to ask again) and
// BKT per topic (`node_mastery`, what the learner is believed to know). Rating
// a card wrote the first and nothing at all to the second. Measured on the real
// library on 2026-09-09: 12,697 cards, 261 in-app reviews, 146 mastery-evidence
// rows — every one of them from a quiz, not one from a card.
//
// Two things followed from that. A topic held entirely in cards read as
// unknown, however faithfully it was reviewed; and because `decayedMastery`
// works off `node_mastery.last_updated`, it went on decaying into ghost
// questions asking whether it was still remembered, while the learner was
// answering exactly that question every morning.
//
// ## The shape of the answer
//
// Ratings ACCUMULATE and are flushed as one binomial observation per topic,
// which is the same rule an assessment follows (`bktBatchUpdate`): a sitting is
// one observation of one latent state, so the order of the answers inside it
// cannot change where the estimate lands. One BKT update per card would put a
// transition between every two cards and make a session's arithmetic depend on
// which card came first.
//
// `review_log` is the source of truth rather than a counter of our own: it is
// already written for every rating, it is already the thing undo removes, and
// keyed against the last flushed row id it makes double-counting structurally
// impossible — including across restarts, imports and a database copied
// between machines.
//
// ## What is deliberately not counted
//
//   * An imported Anki revlog (`source = 'anki'`). It is the learner's history
//     but it happened in another app, possibly years ago; treating it as
//     answers given here would slam the posterior on the first rating after an
//     import, which is a claim about knowledge nobody made today.
//   * A slice of card order (`nodes.role = 'pagination'`). "Stage 7" is not
//     something to know, so there is nothing for an estimate to be about.
//   * A rating that was taken back BEFORE its batch was flushed — undo deletes
//     the `review_log` row, so it simply never arrives. One already inside a
//     written observation stands: the observation is a batch of four or more
//     and cannot be unpicked, and card evidence can never clear the completion
//     gate on its own, so the cost is a slightly stale estimate that the next
//     batch corrects.
//
// And what it can never do: `checkMasteryEligibility` honours `quiz`,
// `boss_fight` and `paper` for the raw-score clause. A card tunes the estimate;
// proving a topic still takes an assessment (the rule drills already follow).

import db from './database.js';
import { updateMasteryFromAttempt, MIN_GATE_QUESTIONS } from './mastery.js';
import { isPagination } from './nodeRole.js';

/**
 * The most ratings one flush may treat as a single observation.
 *
 * A binomial over 200 answers pins the posterior at a floor or a ceiling in one
 * step — technically what the arithmetic says, and far more confidence than a
 * long evening of review deserves. Twenty is about a sitting; a backlog longer
 * than that drains a batch at a time on the ratings that follow, which also
 * spreads the first sweep of an existing library over its next few sessions.
 */
export const CARD_EVIDENCE_MAX_BATCH = 20;

/**
 * Did the answer come? "Again" is the one rating that says it did not.
 *
 * Hard means recalled with effort — grading it as a miss would describe a
 * learner who remembers everything slowly as knowing none of it, and FSRS
 * already prices the effort by scheduling the card sooner.
 */
export function cardAnswerIsCorrect(rating) {
    return Number(rating) >= 2;
}

const cardNodeStmt = db.prepare(`
    SELECT f.node_id AS nodeId, n.role AS role
    FROM flashcards f JOIN nodes n ON n.id = f.node_id
    WHERE f.id = ?
`);

// The last review already accounted for, per topic. Written into the evidence
// row's metadata rather than a column of its own: `mastery_evidence` is a log
// of observations, and "which reviews this one covered" is a property of the
// observation, not new state to keep in step with it.
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
 * Called on the rating path (PUT /api/ai/flashcards/:id), so every review
 * surface gets it without knowing it exists. Returns the observation written,
 * or null when there was nothing to write — which is the normal case, three
 * times out of four.
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
    // The mastery fields the other evidence routes return, plus what this
    // observation actually was. Nothing on the rating path reads it — the
    // effect shows up where mastery is drawn — but a caller that flushes and
    // cannot say what it flushed is untestable.
    return { ...result, nodeId: card.nodeId, score, total: pending.length };
}
