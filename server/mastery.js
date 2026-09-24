import db from './database.js';
import { GUESS_BY_FORMAT } from './answerFormats.js';

// Bayesian Knowledge Tracing (BKT) Parameters
// Based on standard BKT model with simplified parameters
export const BKT_PARAMS = {
    // The prior for a topic's FIRST ASSESSMENT — and only that. `getNodeMastery`
    // inserts a new row at 0.0 and single feed answers update from the stored
    // score, so an unprobed topic still genuinely begins at 0.0, where one
    // correct multiple-choice answer moves the estimate to 0.1 (a 0.3 start
    // would read 65% after one lucky guess and trip the decay logic). But an
    // assessment of MIN_GATE_QUESTIONS or more on a topic never measured here
    // starts from this nominal prior: measured on 2026-09-02, the batch
    // likelihood from a 0.01 floor put a perfect 4/4 at 0.67 and 8/10 at a
    // borderline 0.85, while from 0.3 they land at 0.99 and 0.99 — the numbers
    // a learner who just scored 8/10 expects to see.
    p_L0: 0.3,      // BKT prior for a first assessment (see updateMasteryFromAttempt)
    p_T: 0.1,       // Transition probability (learning rate per attempt)
    p_G: 0.2,       // Guess probability (correct answer without knowing)
    p_S: 0.1,       // Slip probability (incorrect answer despite knowing)
    p_K_MIN: 0.01,  // Floor for knowledge probability
    p_K_MAX: 0.99,  // Ceiling for knowledge probability
};

/**
 * Guess probability by question format — the chance of answering correctly
 * while knowing nothing. This is not a fudge factor: it is the one BKT
 * parameter that IS determined by the item, and using a single global 0.2 for
 * every format meant a coin-flip true/false moved the mastery estimate exactly
 * as much as a multi-step calculation. Since feed answers feed BKT, and BKT
 * drives the retention readout, the decay timer and the advisory gate, an
 * over-credited true/false propagates through the whole Remember loop.
 *
 * Values are the formats' actual floors: 1/2 for true/false, 1/4 for
 * four-option multiple choice, and a small residual for an open answer, where
 * bluffing past an AI grader is possible but not cheap.
 */
/** Ranges a fitted rate may take — what server/bktOptimizer.js searches over. */
export const BKT_FIT_BOUNDS = { p_T: [0.02, 0.5], p_S: [0.02, 0.3] };

// The learner's own rates, when the optimiser has produced an accepted pair
// (`bkt_params` setting). Read through a short cache because every BKT update
// would otherwise cost a settings query; `reloadLearnerBktParams` drops it the
// moment the setting changes.
let learnerRates = { at: 0, rates: null };
const LEARNER_RATES_TTL_MS = 30_000;
export function getLearnerBktParams() {
    if (Date.now() - learnerRates.at < LEARNER_RATES_TTL_MS) return learnerRates.rates;
    let rates = null;
    try {
        const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get('bkt_params')?.value;
        const p = raw ? JSON.parse(raw) : null;
        const inRange = (v, [lo, hi]) => typeof v === 'number' && v >= lo && v <= hi;
        if (p && inRange(p.p_T, BKT_FIT_BOUNDS.p_T) && inRange(p.p_S, BKT_FIT_BOUNDS.p_S)) rates = { p_T: p.p_T, p_S: p.p_S };
    } catch { rates = null; }
    learnerRates = { at: Date.now(), rates };
    return rates;
}
export function reloadLearnerBktParams() { learnerRates = { at: 0, rates: null }; }
function activeRates({ p_T, p_S } = {}) {
    const fitted = getLearnerBktParams();
    return {
        p_T: typeof p_T === 'number' ? p_T : (fitted?.p_T ?? BKT_PARAMS.p_T),
        p_S: typeof p_S === 'number' ? p_S : (fitted?.p_S ?? BKT_PARAMS.p_S),
    };
}

/**
 * Guess floor per answer format. Owned by the format registry
 * (`answerFormats.js`) so a new format declares its floor where it declares
 * everything else; re-exported under the name the rest of the engine reads.
 */
export const GUESS_BY_QUESTION_TYPE = GUESS_BY_FORMAT;

/**
 * Calculate posterior probability of knowing after an observation.
 * Uses Bayes' theorem with the BKT model.
 *
 * @param {number} p_K_prior - Prior probability of knowing
 * @param {boolean} correct - Whether the answer was correct
 * @param {object} [opts] - `p_G` overrides the guess probability for this item
 * @returns {{ p_K_posterior, p_L_updated }}
 */
export function bktUpdate(p_K_prior, correct, { p_G: p_G_override, p_T: p_T_override, p_S: p_S_override } = {}) {
    const { p_S, p_T } = activeRates({ p_T: p_T_override, p_S: p_S_override });
    const p_G = typeof p_G_override === 'number' && p_G_override > 0 && p_G_override < 1
        ? p_G_override
        : BKT_PARAMS.p_G;

    // P(observe | know) = 1 - p_S if correct, p_S if incorrect
    // P(observe | not know) = p_G if correct, 1 - p_G if incorrect
    const p_obs_given_know = correct ? (1 - p_S) : p_S;
    const p_obs_given_not_know = correct ? p_G : (1 - p_G);

    // P(know and observe)
    const p_know_and_obs = p_K_prior * p_obs_given_know;
    // P(not know and observe)
    const p_not_know_and_obs = (1 - p_K_prior) * p_obs_given_not_know;

    // P(observe) = P(know and observe) + P(not know and observe)
    const p_obs = p_know_and_obs + p_not_know_and_obs;

    if (p_obs === 0) return { p_K_posterior: p_K_prior, p_L_updated: p_K_prior };

    // P(know | observe) = P(know and observe) / P(observe)
    const p_K_given_obs = p_know_and_obs / p_obs;

    // Apply transition: P(L) = P(K|obs) + (1 - P(K|obs)) * p_T
    const p_L_updated = p_K_given_obs + (1 - p_K_given_obs) * p_T;

    const p_K_posterior = Math.max(BKT_PARAMS.p_K_MIN, Math.min(BKT_PARAMS.p_K_MAX, p_L_updated));

    return { p_K_posterior, p_L_updated: p_K_posterior };
}

/**
 * Posterior after a BATCH of `total` questions with `score` correct, treated
 * as ONE observation under ONE latent state — a binomial likelihood under
 * "knows" (1−p_S per correct, p_S per wrong) and under "does not know" (p_G per
 * correct, 1−p_G per wrong) — followed by ONE learn transition.
 *
 * This is what makes an assessment order-independent. The per-question path
 * above applies a transition after EVERY answer, so the same 8/10 read 0.70
 * with the correct answers applied first and 0.99 with the wrong ones first,
 * and the caller could only ever pick one order. An assessment is one
 * sitting: knowledge does not plausibly change between question 3 and
 * question 4 of the same quiz, so the evidence is weighed together and the
 * learning it may have caused is credited once, at the end.
 *
 * The prior is floored at p_K_MIN: a literal 0 prior makes the "knows"
 * branch of the likelihood vanish and the result is the transition alone,
 * whatever the score. Log-space so 20 questions cannot underflow.
 */
export function bktBatchUpdate(p_K_prior, score, total, { p_G: p_G_override, p_T: p_T_override, p_S: p_S_override } = {}) {
    const { p_K_MIN, p_K_MAX } = BKT_PARAMS;
    const { p_S, p_T } = activeRates({ p_T: p_T_override, p_S: p_S_override });
    const p_G = typeof p_G_override === 'number' && p_G_override > 0 && p_G_override < 1
        ? p_G_override
        : BKT_PARAMS.p_G;
    const prior = Math.max(p_K_MIN, Math.min(p_K_MAX, Number(p_K_prior) || 0));
    const wrong = total - score;
    const logKnow = score * Math.log(1 - p_S) + wrong * Math.log(p_S);
    const logNot = score * Math.log(p_G) + wrong * Math.log(1 - p_G);
    const m = Math.max(logKnow, logNot);
    const a = prior * Math.exp(logKnow - m);
    const b = (1 - prior) * Math.exp(logNot - m);
    const posterior = a / (a + b);
    const learned = posterior + (1 - posterior) * p_T;
    return Math.max(p_K_MIN, Math.min(p_K_MAX, learned));
}

/**
 * Get or create mastery record for a node.
 * Returns the current mastery score (0.0 to 1.0).
 */
export function getNodeMastery(nodeId) {
    let record = db.prepare('SELECT * FROM node_mastery WHERE node_id = ?').get(nodeId);
    if (!record) {
        db.prepare('INSERT INTO node_mastery (node_id, mastery_score) VALUES (?, 0.0)').run(nodeId);
        record = db.prepare('SELECT * FROM node_mastery WHERE node_id = ?').get(nodeId);
    }
    return record;
}

// The kinds of evidence BKT accepts, validated here rather than as a CHECK
// constraint on mastery_evidence: SQLite cannot ALTER a constraint, so a stale
// one would 500 every new evidence kind instead of letting this list grow.
// Validated on this function because it is the single write path — feed.js,
// index.js and paper.js all funnel through it.
//
// Not all evidence is equal: checkMasteryEligibility's raw-score clause honours
// only 'quiz' | 'mastery_check' | 'paper'. 'drill' and 'flashcard' sharpen the
// retention estimate and refresh the decay timer but can never clear the
// completion gate on their own — practice tunes the estimate, proving needs an
// assessment. Paper counts because worked-by-hand solutions are the strongest
// proof this engine can collect.
// 'placement' is a probe answer taken BEFORE the topic was studied (see
// server/placement.js). It is real evidence — the learner genuinely answered —
// so it is recorded rather than hidden, but it is deliberately absent from
// clause (b) below for the same reason 'drill' is: a probe asks ONE question
// per topic, so it can never be an assessment of >= MIN_GATE_QUESTIONS, and a
// kind of evidence that cannot reach the bar must not be allowed to look as if
// it might.
export const VALID_EVIDENCE_TYPES = ['quiz', 'flashcard', 'mastery_check', 'drill', 'paper', 'placement'];

/** Upper bound on questions in ONE attempt — no assessment here is remotely this long. */
export const MAX_ATTEMPT_QUESTIONS = 500;

/**
 * Update mastery score for a node based on a quiz attempt.
 *
 * @param {number} nodeId - The node ID
 * @param {number} score - Correct answers
 * @param {number} total - Total questions
 * @param {string} evidenceType - one of VALID_EVIDENCE_TYPES
 * @param {object} metadata - Optional additional data
 * @returns {{ mastery_score, improved }}
 */
export function updateMasteryFromAttempt(nodeId, score, total, evidenceType = 'quiz', metadata = null) {
    if (!VALID_EVIDENCE_TYPES.includes(evidenceType)) {
        throw new Error(`Invalid evidence type "${evidenceType}" (expected one of: ${VALID_EVIDENCE_TYPES.join(', ')})`);
    }
    // Every endpoint funnels through here, so this is where the numbers are
    // checked once. A NaN binds as NULL and corrupts the counters for good; a
    // score above total credits questions that were never asked; and the
    // per-question loop below runs `total` times, so an absurd total is a
    // hung single-threaded server.
    if (!Number.isInteger(score) || !Number.isInteger(total) || score < 0 || total < 1
        || score > total || total > MAX_ATTEMPT_QUESTIONS) {
        throw new Error(`Invalid attempt: score=${score} total=${total} (need integers, 0 <= score <= total <= ${MAX_ATTEMPT_QUESTIONS})`);
    }
    const record = getNodeMastery(nodeId);

    // Record the evidence
    db.prepare(`
        INSERT INTO mastery_evidence (node_id, evidence_type, score, total, metadata)
        VALUES (?, ?, ?, ?, ?)
    `).run(nodeId, evidenceType, score, total, metadata ? JSON.stringify(metadata) : null);

    // When the caller knows the item's format (the feed serves one question at
    // a time, so it always does), the guess floor for that format is used
    // instead of the global default — a correct true/false is genuinely weaker
    // evidence than a correct calculation, and the estimate should say so.
    const p_G = GUESS_BY_QUESTION_TYPE[metadata?.questionType] ?? undefined;
    let currentP;
    if (total >= MIN_GATE_QUESTIONS) {
        // An ASSESSMENT: one sitting, one observation, one transition — see
        // bktBatchUpdate. A topic never measured here starts it from the
        // nominal prior rather than from 0.0; a topic with its own evidence
        // (good or bad) starts from that; a seeded prior (transfer, placement)
        // counts when it is above the nominal one and is lifted to it when
        // below, so borrowed evidence can help and never handicaps.
        const cold = (record.total_attempts || 0) === 0;
        const prior = cold
            ? Math.max(record.mastery_score || 0, BKT_PARAMS.p_L0)
            : record.mastery_score;
        currentP = bktBatchUpdate(prior, score, total, { p_G });
    } else {
        // Single feed answers (and anything shorter than a gate-eligible
        // assessment) keep the per-question path from the stored score, so an
        // unprobed topic still climbs from 0.0 one answer at a time.
        currentP = record.mastery_score;
        for (let i = 0; i < total; i++) {
            const correct = i < score;
            currentP = bktUpdate(currentP, correct, { p_G }).p_K_posterior;
        }
    }

    const newTotalAttempts = record.total_attempts + total;
    const newCorrectAttempts = record.correct_attempts + score;

    // Update mastery record
    db.prepare(`
        UPDATE node_mastery
        SET mastery_score = ?, total_attempts = ?, correct_attempts = ?,
            last_updated = CURRENT_TIMESTAMP
        WHERE node_id = ?
    `).run(currentP, newTotalAttempts, newCorrectAttempts, nodeId);

    return {
        mastery_score: currentP,
        improved: currentP > record.mastery_score,
        previous_score: record.mastery_score,
        total_attempts: newTotalAttempts,
        correct_attempts: newCorrectAttempts,
    };
}

/**
 * Minimum questions an assessment must have to count as "strong" raw-score evidence.
 * Guards against a 1-question quiz trivially clearing the gate.
 */
export const MIN_GATE_QUESTIONS = 4;

/**
 * Check if a node meets the mastery threshold for completion.
 *
 * A node is eligible when it has evidence AND either:
 *   (a) its BKT posterior is at/above `threshold`, OR
 *   (b) it has at least one real assessment (quiz/mastery_check/paper) of
 *       >= MIN_GATE_QUESTIONS questions answered at >= `checkPass` raw accuracy.
 *
 * Clause (b) exists because the BKT posterior is order-dependent and can land
 * well below the threshold even after a clearly-passing assessment (e.g. 8/10 →
 * ~0.67). Gating purely on BKT made "passing" a mastery check fail to complete the
 * node — so we also honor the transparent raw-score the learner actually saw.
 * Flashcard self-ratings are excluded from clause (b) to keep the gate honest.
 *
 * **Transferred priors suspend clause (a).** When a node's estimate was seeded
 * from a semantically identical topic in another project (see
 * server/masteryTransfer.js), part of the posterior was never earned here. The
 * seeded value is already capped below any threshold, but a high prior plus two
 * lucky true/falses could cross it — so on a transferred node the BKT clause
 * requires MIN_GATE_QUESTIONS answers of the node's OWN before it counts at
 * all. Clause (b) is untouched: a passing assessment here is genuine proof and
 * has never needed a prior's help. Transfer saves the learner the *teaching*,
 * never the proving.
 *
 * @param {number} nodeId
 * @param {number} threshold - Minimum BKT posterior (default 0.85)
 * @param {number} checkPass  - Minimum raw accuracy for assessment evidence (default 0.8)
 * @returns {{ eligible, mastery_score, evidence_count }}
 */
export function checkMasteryEligibility(nodeId, threshold = 0.85, checkPass = 0.8) {
    const record = getNodeMastery(nodeId);

    const evidenceCount = db.prepare(
        'SELECT COUNT(*) as count FROM mastery_evidence WHERE node_id = ?'
    ).get(nodeId);

    // Questions answered ON THIS NODE, regardless of kind — what distinguishes
    // a borrowed estimate from a measured one.
    const ownAnswers = db.prepare(
        'SELECT COALESCE(SUM(total), 0) AS n FROM mastery_evidence WHERE node_id = ?'
    ).get(nodeId).n;
    // A prior seeded by EITHER route is borrowed. The two sources answer
    // different questions and are stored separately so the UI can say the right
    // one, but the gate must not care which: both put part of the posterior
    // there without the learner proving it here, and a boundary that holds for
    // one route and not the other is a boundary a single new feature walks
    // straight through.
    const seeded = record.transferred_prior != null || record.placement_prior != null;
    const borrowed = seeded && ownAnswers < MIN_GATE_QUESTIONS;

    const strongEvidence = db.prepare(`
        SELECT 1 FROM mastery_evidence
        WHERE node_id = ?
          AND evidence_type IN ('quiz', 'mastery_check', 'paper')
          AND total >= ?
          AND (score * 1.0 / total) >= ?
        LIMIT 1
    `).get(nodeId, MIN_GATE_QUESTIONS, checkPass);

    const hasEvidence = evidenceCount.count > 0;
    const passedAssessment = !!strongEvidence;
    const bktClause = record.mastery_score >= threshold && !borrowed;

    return {
        eligible: hasEvidence && (bktClause || passedAssessment),
        mastery_score: record.mastery_score,
        evidence_count: evidenceCount.count,
        threshold,
        has_evidence: hasEvidence,
        passed_assessment: passedAssessment,
        // Surfaced so a caller can explain a gate that would otherwise look
        // broken: "85% mastery and still not eligible?" — because part of that
        // 85% was borrowed from another project.
        borrowed_estimate: borrowed,
        own_answers: ownAnswers,
    };
}

/**
 * Write a **seeded prior** — an estimate this node did not earn here.
 *
 * Two features produce one: mastery transfer (a proven twin in another
 * project) and placement (a probe answered before studying). They are stored
 * in their own columns because they explain themselves differently, but they
 * meet here so that the arithmetic on `mastery_score` has exactly one author.
 * Before this existed each wrote the score directly, which is fine while only
 * one of them can fire and silently wrong the moment both do: the second write
 * would clobber the first, so whichever swept last would decide the estimate.
 *
 * Seeds combine with **MAX, never a sum** — the same rule and the same reason
 * as `computeTransfer`'s own sources. Two routes to the belief that a topic is
 * already familiar are two descriptions of one belief, not twice the evidence,
 * and adding them would let two soft signals out-weigh one strong one.
 *
 * Refuses to touch a node that has real BKT measurement (`total_attempts > 0`):
 * once the learner has answered here, measurement owns the estimate and a
 * borrowed number may not overwrite it.
 *
 * @param {number} nodeId
 * @param {'transfer'|'placement'} kind
 * @param {number} prior   0 or less clears this kind's seed
 * @param {Array}  sources provenance, stored as JSON for the UI
 * @returns {{written: boolean, score: number}}
 */
const SEED_COLUMNS = {
    transfer: { prior: 'transferred_prior', sources: 'transfer_sources', at: 'transfer_at' },
    placement: { prior: 'placement_prior', sources: 'placement_sources', at: 'placement_at' },
};

export function applySeededPrior(nodeId, kind, prior, sources = []) {
    const col = SEED_COLUMNS[kind];
    if (!col) throw new Error(`Unknown seeded-prior kind "${kind}"`);

    const record = getNodeMastery(nodeId);
    if ((record.total_attempts || 0) > 0) {
        return { written: false, score: record.mastery_score, reason: 'measured' };
    }

    const value = prior > 0 ? prior : null;
    db.prepare(`
        UPDATE node_mastery
        SET ${col.prior} = ?, ${col.sources} = ?, ${col.at} = ${value == null ? 'NULL' : 'CURRENT_TIMESTAMP'}
        WHERE node_id = ?
    `).run(value, value == null ? null : JSON.stringify(sources), nodeId);

    // Recompute from BOTH columns rather than from the value just written, so
    // clearing one seed falls back to the other instead of to zero.
    const after = db.prepare(
        'SELECT transferred_prior, placement_prior FROM node_mastery WHERE node_id = ?'
    ).get(nodeId);
    const score = Math.max(after.transferred_prior ?? 0, after.placement_prior ?? 0);

    db.prepare(
        'UPDATE node_mastery SET mastery_score = ?, last_updated = CURRENT_TIMESTAMP WHERE node_id = ?'
    ).run(score, nodeId);

    return { written: true, score };
}

/**
 * Get mastery stats for all nodes in a project.
 *
 * @param {number} projectId
 * @returns Array of { node_id, mastery_score, total_attempts, correct_attempts, evidence_count }
 */
export function getProjectMasteryStats(projectId) {
    return db.prepare(`
        SELECT
            nm.node_id,
            nm.mastery_score,
            nm.total_attempts,
            nm.correct_attempts,
            nm.last_updated,
            (SELECT COUNT(*) FROM mastery_evidence me WHERE me.node_id = nm.node_id) as evidence_count,
            (SELECT COUNT(*) FROM mastery_evidence me WHERE me.node_id = nm.node_id AND me.evidence_type = 'quiz') as quiz_count,
            (SELECT COUNT(*) FROM mastery_evidence me WHERE me.node_id = nm.node_id AND me.evidence_type = 'mastery_check') as mastery_check_count
        FROM node_mastery nm
        JOIN nodes n ON n.id = nm.node_id
        WHERE n.project_id = ?
        ORDER BY nm.mastery_score DESC
    `).all(projectId);
}

/**
 * Estimate how much a proven topic's mastery has *faded* since it was last
 * reviewed. The stored `mastery_score` is frozen at the last review, so time
 * itself is the decay signal. Memory stays fresh for a grace window of
 * `decayDays`, then follows an exponential forgetting curve with a half-life of
 * `decayDays` — so a topic proven at a higher score survives longer before it
 * crosses any given bar. Every constant derives from the configurable
 * `decay_days` setting; nothing here is hardcoded.
 *
 * @param {number} masteryScore - stored BKT posterior at last review (0..1)
 * @param {string} lastUpdated  - SQLite 'YYYY-MM-DD HH:MM:SS' UTC timestamp
 * @param {number} decayDays    - grace window AND forgetting half-life, in days
 * @returns {number} faded mastery estimate (0..masteryScore)
 */
export function decayedMastery(masteryScore, lastUpdated, decayDays = 14) {
    if (!lastUpdated || decayDays <= 0) return masteryScore;
    // 'YYYY-MM-DD HH:MM:SS' (UTC) → parseable ISO instant.
    const last = new Date(lastUpdated.replace(' ', 'T') + 'Z').getTime();
    if (Number.isNaN(last)) return masteryScore;
    const days = (Date.now() - last) / 86_400_000;
    const effDays = Math.max(0, days - decayDays); // fresh through the grace window
    if (effDays === 0) return masteryScore;
    return masteryScore * Math.exp((-Math.LN2 * effDays) / decayDays);
}

/**
 * Get decaying nodes — topics whose mastery has faded and are worth refreshing.
 *
 * Two selection modes share this one definition:
 *
 *  • **Legacy time-cutoff** (no `threshold`): a proven-ish topic (> 0.5) not
 *    touched within `decayDays`. Used by the ghost-question / daily-plan paths,
 *    whose "cumulative exam" mechanic wants a broad net.
 *
 *  • **Decayed-estimate** (`threshold` given): topics the learner actually
 *    *proved* (score >= `threshold`) whose faded estimate (`decayedMastery`) has
 *    since dropped back below that same `threshold`. This is the "Keep It Fresh"
 *    card's signal — "you proved these once, but memory fades" made literal, with
 *    both the bar and the timescale coming from settings (`mastery_threshold`,
 *    `decay_days`). Topics cleared only by a raw mastery check while BKT stayed below
 *    threshold were never above the bar, so they aren't "faded below" it — the
 *    ghost-question path still re-tests those.
 *
 * The "Remember" loop is about *completed/mastered* topics fading, so completed
 * nodes are included (an earlier `status != 'completed'` filter made the feature
 * inert). We only exclude notes and topics the learner explicitly skipped.
 *
 * @param {number} projectId
 * @param {number} decayDays - Days without review to start decaying
 * @param {{ threshold?: number }} [opts] - pass `threshold` for decayed-estimate mode
 * @returns Array of nodes with decaying mastery (decayed mode also sets `decayed_score`)
 */
export function getDecayingNodes(projectId, decayDays = 14, { threshold = null } = {}) {
    if (threshold == null) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - decayDays);
        // last_updated is written by SQLite's CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS',
        // UTC). Compare in the same format — an ISO string ('...T...Z') sorts after
        // every same-day SQLite timestamp, silently widening the window by a day.
        const cutoffStr = cutoffDate.toISOString().slice(0, 19).replace('T', ' ');

        return db.prepare(`
            SELECT
                nm.node_id,
                nm.mastery_score,
                nm.last_updated,
                n.title,
                n.status
            FROM node_mastery nm
            JOIN nodes n ON n.id = nm.node_id
            WHERE n.project_id = ?
              AND nm.mastery_score > 0.5
              AND nm.last_updated < ?
              AND n.status != 'skipped'
              AND n.is_note = 0
            ORDER BY nm.last_updated ASC
            LIMIT 10
        `).all(projectId, cutoffStr);
    }

    // Decayed-estimate mode: pull everything the learner proved, then keep only
    // the ones whose faded estimate has slipped back under the same threshold.
    const proven = db.prepare(`
        SELECT
            nm.node_id,
            nm.mastery_score,
            nm.last_updated,
            n.title,
            n.status
        FROM node_mastery nm
        JOIN nodes n ON n.id = nm.node_id
        WHERE n.project_id = ?
          AND nm.mastery_score >= ?
          AND n.status != 'skipped'
          AND n.is_note = 0
    `).all(projectId, threshold);

    return proven
        .map(n => ({ ...n, decayed_score: decayedMastery(n.mastery_score, n.last_updated, decayDays) }))
        .filter(n => n.decayed_score < threshold)
        .sort((a, b) => a.decayed_score - b.decayed_score) // most faded first
        .slice(0, 10);
}

/**
 * Does this project have any *proven* topic (mastery at/above `threshold`)?
 * Distinguishes "everything you proved is still fresh" (celebrate) from
 * "nothing proven yet" (nothing to keep fresh) for the dashboard empty state.
 */
export function hasProvenTopics(projectId, threshold) {
    return !!db.prepare(`
        SELECT 1
        FROM node_mastery nm
        JOIN nodes n ON n.id = nm.node_id
        WHERE n.project_id = ?
          AND nm.mastery_score >= ?
          AND n.status != 'skipped'
          AND n.is_note = 0
        LIMIT 1
    `).get(projectId, threshold);
}

/**
 * Get the mastery data for a specific node including recent evidence.
 */
export function getNodeMasteryDetail(nodeId, { threshold = 0.85, checkPass = 0.8 } = {}) {
    const record = getNodeMastery(nodeId);
    const evidence = db.prepare(`
        SELECT * FROM mastery_evidence
        WHERE node_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 20
    `).all(nodeId);

    // Against the CONFIGURED gate, or the detail says "not eligible" while the
    // gate itself would pass (or the reverse) whenever the learner has moved
    // `mastery_threshold` off its default.
    const eligibility = checkMasteryEligibility(nodeId, threshold, checkPass);

    return {
        ...record,
        evidence,
        eligibility,
    };
}