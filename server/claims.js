// A CLAIM: an outside agent says the learner answered a question on a topic,
// right or wrong, in the agent's own window (mcp/, the record_claim tool). The
// app did not see the question, the answer or the grading, so a claim is kept
// apart from evidence (`mastery_claims`, never `mastery_evidence`) and is held
// to one rule: it can never make a topic look better known than the app's own
// evidence says.
//
//   - A RIGHT claim changes nothing but its own row. Raising the estimate on a
//     claim would let an agent walk a topic to the gate's door, and one lucky
//     real answer would then clear it — the reason seeded priors are capped
//     and suspended until the topic has answers of its own.
//   - A WRONG claim may lower the estimate: one BKT step on a wrong answer at
//     the format's guess rate, taken only when it lowers (the step's learning
//     transition can lift a very low prior, and that half is not taken). It
//     never goes under a head start's seed (placement, transfer) while that
//     seed stands: a seed is withdrawn only by answers the app itself received.
//   - ONCE per piece of the app's own evidence. After a wrong claim has
//     lowered a topic, further wrong claims leave it alone until the app
//     records an answer of its own there (`evidence_mark`, the newest
//     `mastery_evidence` id the claim saw). An agent reads course text it did
//     not write, so a prompt in a lesson must not be able to grind a topic's
//     estimate to the floor with a loop of calls.
//   - Nothing else moves: not `total_attempts` (a claim is not progress, the
//     topic does not turn "in progress"), not `last_updated` (the decay timer
//     is the app's own evidence), not the fitted rates, not the gate's
//     evidence count. A topic with no mastery row gets none.
//
// A rebuild of the estimate from the app's own evidence (`replayOwnEvidence`
// in mastery.js, e.g. `forgetSeed` when placement is cleared) does not replay
// claims: they are the weaker record, so a lowering is undone by it, and the
// claim row's `mastery_after` then describes the past.
//
// Written once per `attemptId` (`recordOnce`, surface 'claim'), like every
// answer the app records, so a harness that retries a call writes one row.

import db, { NOW_ISO } from './database.js';
import { bktUpdate, GUESS_BY_QUESTION_TYPE, readAttemptId, recordOnce, ATTEMPT_ID_ERROR } from './mastery.js';
import { WORK_LEAF } from './today.js';

/** The doors a claim can arrive by. One so far; the column is free text so a second needs no migration. */
export const CLAIM_SOURCES = ['mcp'];

const CLIENT_CHARS = 80;

/** A claim the server refuses: `status` is the HTTP status the route answers with. */
export class ClaimError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const statements = new Map();
const stmt = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
};

/**
 * Validate a claim and write it. Throws ClaimError (400/404) before writing
 * anything. Returns `{ claimId, nodeId, title, correct, masteryBefore,
 * masteryAfter, lowered, duplicate }`; `masteryBefore`/`After` are null when
 * the topic has no estimate yet.
 */
export function recordClaim({ nodeId, correct, questionType = null, attemptId = null, client = null, source = 'mcp' } = {}) {
    if (!Number.isInteger(nodeId) || nodeId < 1) throw new ClaimError(400, 'nodeId must be a topic\'s id (a whole number)');
    if (typeof correct !== 'boolean') throw new ClaimError(400, 'correct must be true or false');
    if (questionType != null && !Object.hasOwn(GUESS_BY_QUESTION_TYPE, questionType)) {
        throw new ClaimError(400, `questionType must be one of: ${Object.keys(GUESS_BY_QUESTION_TYPE).join(', ')}`);
    }
    const attempt = readAttemptId(attemptId);
    if (attempt === undefined) throw new ClaimError(400, ATTEMPT_ID_ERROR);
    if (!CLAIM_SOURCES.includes(source)) throw new ClaimError(400, `source must be one of: ${CLAIM_SOURCES.join(', ')}`);
    const who = typeof client === 'string' && client.trim() ? client.trim().slice(0, CLIENT_CHARS) : null;

    const node = stmt(`SELECT n.id, n.title, n.is_note, (${WORK_LEAF}) AS work FROM nodes n WHERE n.id = ?`).get(nodeId);
    if (!node) throw new ClaimError(404, `No topic with nodeId ${nodeId}`);
    if (node.is_note) throw new ClaimError(400, `nodeId ${nodeId} is a piece of Material, not a topic: claim on the topic it belongs to`);
    if (!node.work) throw new ClaimError(400, `nodeId ${nodeId} is a section, not a topic: claim on one of the topics under it`);

    const { duplicate, outcome } = recordOnce('claim', attempt, () => {
        const row = stmt('SELECT mastery_score, transferred_prior, placement_prior FROM node_mastery WHERE node_id = ?').get(nodeId);
        const mark = stmt('SELECT COALESCE(MAX(id), 0) AS m FROM mastery_evidence WHERE node_id = ?').get(nodeId).m;
        const before = row ? Number(row.mastery_score) || 0 : null;
        let after = before;
        // What the claim did to the estimate, for the agent's reply.
        let effect = correct ? 'right' : row ? 'unchanged' : 'no_estimate';
        if (!correct && row) {
            const spent = stmt(`
                SELECT 1 FROM mastery_claims
                WHERE node_id = ? AND evidence_mark = ? AND mastery_after < mastery_before LIMIT 1
            `).get(nodeId, mark);
            if (spent) {
                effect = 'already_lowered';
            } else {
                const stepped = bktUpdate(before, false, { p_G: questionType ? GUESS_BY_QUESTION_TYPE[questionType] : undefined }).p_K_posterior;
                const seed = Math.max(Number(row.transferred_prior) || 0, Number(row.placement_prior) || 0);
                // The seed is a floor only while it stands: once the learner's own
                // answers have put the estimate under it, it is already withdrawn.
                const floor = seed > 0 && before >= seed ? seed : 0;
                after = Math.max(floor, Math.min(before, stepped));
                if (after < before) {
                    stmt('UPDATE node_mastery SET mastery_score = ? WHERE node_id = ?').run(after, nodeId);
                    effect = 'lowered';
                } else if (floor > 0 && floor >= Math.min(before, stepped)) {
                    effect = 'at_seed';
                }
            }
        }
        const info = stmt(`
            INSERT INTO mastery_claims (node_id, source, correct, question_type, client, mastery_before, mastery_after, evidence_mark, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO})
        `).run(nodeId, source, correct ? 1 : 0, questionType, who, before, after, mark);
        return {
            claimId: Number(info.lastInsertRowid),
            nodeId,
            title: node.title,
            correct,
            masteryBefore: before,
            masteryAfter: after,
            lowered: effect === 'lowered',
            effect,
        };
    });
    // A retry sends the same id for the same answer. The same id for another
    // answer is a harness reusing its ids: refusing it beats replying with the
    // first answer's outcome as if it were this one's.
    if (duplicate && (outcome.nodeId !== nodeId || outcome.correct !== correct)) {
        throw new ClaimError(409, `attempt_id "${attempt}" was already used for another answer (a ${outcome.correct ? 'right' : 'wrong'} one on nodeId ${outcome.nodeId}). Send a new attempt_id for each answer.`);
    }
    return { ...outcome, duplicate };
}

/** What agents have claimed on one topic: counts and the time of the last. */
export function claimSummary(nodeId) {
    const r = stmt(`
        SELECT COUNT(*) AS total, COALESCE(SUM(correct), 0) AS correct, MAX(created_at) AS lastAt
        FROM mastery_claims WHERE node_id = ?
    `).get(nodeId);
    return { total: r.total, correct: r.correct, wrong: r.total - r.correct, lastAt: r.lastAt || null };
}
