/**
 * READY TO PROVE — what a past-due topic is called when the learner already
 * knows it.
 *
 * "Overdue" is a fact about the calendar, and on its own it tells a learner
 * to go and study something. That is the wrong instruction for a topic they
 * have already learned: node 11317 "Doppler" stood at mastery 0.98 after seven
 * answers of their own, past its dates, and every surface called it OVERDUE.
 * What is left there is not study, it is the proof. So such a topic says
 * "ready to prove", with the mastery check beside the words.
 *
 * Only the WORDS change. The topic stays open (nothing here closes it), and it
 * is still behind schedule wherever the app counts: pace (`calculatePace`),
 * the feed's urgency, the dashboard's "Next up", the overdue counts. A
 * reader that ranks or counts keeps its overdue query as it is; a reader that
 * TELLS the learner asks this module about each row it shows.
 *
 * The rule, mirrored by `isReadyToProve` in src/utils/tree.ts:
 *
 *   an open topic (not completed, not skipped)
 *   AND its end date is before today
 *   AND the mastery gate would pass it now — `checkMasteryEligibility`, the
 *       gate's own test, at the learner's configured threshold and pass mark.
 *
 * No second threshold: "ready" is exactly "pressing Complete would not be
 * stopped by the gate". So a seeded prior alone is never readiness (the gate
 * suspends the BKT clause on a borrowed estimate), and neither are card
 * ratings alone (they cannot clear the raw-score clause).
 *
 * And only of what the check can be TAKEN on: `masteryCheckTarget`, the rule
 * the draw refuses by, so a section past its dates (an older library can hold
 * answers on a heading) stays "overdue" — it has no check to offer.
 * Guard: tools/ready-to-prove-gates.mjs.
 */

import db from './database.js';
import { checkMasteryEligibility } from './mastery.js';
import { getGateConfig } from './settingsStore.js';
import { masteryCheckTarget } from './today.js';

const CLOSED = new Set(['completed', 'skipped']);

let evidenceStmt = null;
const hasEvidence = (nodeId) =>
    !!(evidenceStmt ??= db.prepare('SELECT 1 FROM mastery_evidence WHERE node_id = ? LIMIT 1')).get(nodeId);

/**
 * Would the mastery gate pass this topic now? `checkMasteryEligibility`'s
 * answer and nothing else. Its first condition is that the topic has evidence,
 * asked here first only because the gate's own reader writes an empty
 * `node_mastery` row for a node that has none, and a page that merely LISTS
 * topics must not write.
 */
export function canProve(nodeId, gate = getGateConfig()) {
    if (!hasEvidence(nodeId) || masteryCheckTarget(nodeId).refused) return false;
    return !!checkMasteryEligibility(nodeId, gate.threshold, gate.checkPass).eligible;
}

/**
 * The rule. `node` is a topic row: `id` (or `nodeId`), `status`,
 * `scheduled_end`. `today` is `YYYY-MM-DD` (UTC), the same day the reader's
 * own overdue test used.
 */
export function isReadyToProve(node, today, gate = getGateConfig()) {
    if (!node || CLOSED.has(node.status)) return false;
    if (!node.scheduled_end || !(node.scheduled_end < today)) return false;
    return canProve(node.id ?? node.nodeId, gate);
}
