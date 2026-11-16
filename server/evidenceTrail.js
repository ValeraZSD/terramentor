// What the app thinks a learner knows about one topic, and the evidence that
// says so (GET /api/nodes/:nodeId/evidence). The estimate is the one the gate
// and the end card already read (checkMasteryEligibility); each proving row
// carries the step it gave that estimate by the gate's own replay
// (evidenceMoves), so the trail adds up to the number on the card.
//
// Reads only. GET /api/nodes/:nodeId/mastery creates the topic's mastery row
// on the way; this one does not, so opening a topic never writes.
import db from './database.js';
import { checkMasteryEligibility, evidenceMoves } from './mastery.js';
import { FADING_TOPIC, fadingCutoff } from './fading.js';
import { feedBankQuestion } from './questionTrust.js';

/** Newest first; a topic with more shows how many more there are. */
export const TRAIL_LIMIT = 100;

const parse = (text) => {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
};

const statements = new Map();
const stmt = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
};

/**
 * The stem of the bank question a single feed answer was about, or null.
 * Only by its uuid: a key's position names whatever question sits there NOW,
 * and a vetoed or reported question splices the bank (questionTrust.js), so a
 * row with no uuid could show, and flag, a different question.
 */
function feedQuestion(meta) {
    if (meta?.source !== 'feed' || !meta.key || typeof meta.uuid !== 'string' || !meta.uuid) return null;
    try {
        const q = feedBankQuestion(meta.key, meta.uuid);
        return q && typeof q.question === 'string' ? { stem: q.question, uuid: typeof q.uuid === 'string' ? q.uuid : null } : null;
    } catch {
        return null;
    }
}

/**
 * One word for the estimate, decided here so every reader says the same:
 *   none       no answer and no head start: nothing to go on
 *   borrowed   a head start (placement or another course) the learner's own
 *              answers have not yet replaced
 *   proven     past the bar by answers the app graded, or a passed sitting
 *   fading     proven, then left alone past `decay_days` (FADING_TOPIC); a
 *              topic never proven is not called fading, whatever its age
 *   practice   over the bar only because of cards and drills
 *   few        under FEW_ANSWERS graded answers of the learner's own: the
 *              model's first step is the same for a right and a wrong one,
 *              so a number here would say more than the answers do
 *   close      over halfway
 *   early      under halfway
 */
export const FEW_ANSWERS = 3;

function levelOf({ record, rows, eligibility, fading, deck }) {
    if (!record || (!(record.total_attempts > 0) && record.transferred_prior == null && record.placement_prior == null && !rows)) return 'none';
    if (eligibility.borrowed_estimate) return 'borrowed';
    if (eligibility.eligible) return fading ? 'fading' : 'proven';
    if (eligibility.practice_lifted) return 'practice';
    if (!(record.total_attempts > 0)) return 'none';
    // A deck has only card ratings, never answers of this kind.
    if (!deck && eligibility.own_answers < FEW_ANSWERS) return 'few';
    return eligibility.shown_score >= 0.5 ? 'close' : 'early';
}

/**
 * The topic's estimate and its newest evidence rows, or null when there is no
 * such topic. `gate` is getGateConfig()'s threshold, checkPass and decayDays.
 */
export function getEvidenceTrail(nodeId, { threshold = 0.85, checkPass = 0.8, decayDays = 14 } = {}, now = new Date()) {
    const node = stmt(`
        SELECT n.id, n.title, n.status, n.is_note, n.project_id, p.kind AS project_kind
        FROM nodes n JOIN projects p ON p.id = n.project_id
        WHERE n.id = ?
    `).get(nodeId);
    if (!node) return null;

    const record = stmt('SELECT * FROM node_mastery WHERE node_id = ?').get(node.id) ?? null;
    const count = stmt('SELECT COUNT(*) AS c FROM mastery_evidence WHERE node_id = ?').get(node.id).c;
    // checkMasteryEligibility reads the row through getNodeMastery, which makes
    // one when it is missing: asked only when there is a row.
    const eligibility = record ? checkMasteryEligibility(node.id, threshold, checkPass) : null;
    const fading = !!record && !!stmt(`
        SELECT 1 FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id
        WHERE nm.node_id = ? AND ${FADING_TOPIC}
    `).get(node.id, fadingCutoff(decayDays, now));

    const moves = evidenceMoves(node.id);
    const raw = stmt(`
        SELECT id, evidence_type, score, total, metadata,
               strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS at,
               EXISTS (SELECT 1 FROM sitting_reviews sr WHERE sr.evidence_id = mastery_evidence.id) AS reviewable
        FROM mastery_evidence
        WHERE node_id = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(node.id, TRAIL_LIMIT);

    const rows = raw.map((r) => {
        const meta = parse(r.metadata) ?? {};
        const move = moves.get(r.id) ?? null;
        const question = r.total === 1 ? feedQuestion(meta) : null;
        return {
            id: r.id,
            type: r.evidence_type,
            at: r.at,
            score: r.score,
            total: r.total,
            // The estimate before and after this row, by the gate's replay;
            // null for practice (not proof) and for a placement answer, which
            // set a head start instead.
            before: move ? move.before : null,
            after: move ? move.after : null,
            // A single feed answer names its question; the learner can flag it.
            question: question?.stem ?? null,
            ref: question?.uuid ? `q:${question.uuid}` : null,
            recall: meta.ghost === true,
            // A check or quiz whose questions and answers were kept: it opens.
            reviewable: r.reviewable === 1,
            // Questions a report took out of this row's score.
            voided: Array.isArray(meta.voided) ? meta.voided.length : 0,
        };
    });

    const level = levelOf({ record, rows: count > 0, eligibility, fading, deck: node.project_kind === 'deck' });
    return {
        nodeId: node.id,
        title: node.title,
        status: node.status,
        projectKind: node.project_kind === 'deck' ? 'deck' : 'curriculum',
        threshold,
        estimate: {
            level,
            // What every learner-facing reader prints (the end card, the refusal).
            score: eligibility && level !== 'none' ? eligibility.shown_score : null,
            // What the proving answers alone give (the trail's steps end
            // here); under `score` when cards or drills lifted the number.
            answersScore: eligibility && level !== 'none' ? eligibility.gate_score : null,
            seed: record?.placement_prior != null ? 'placement' : record?.transferred_prior != null ? 'transfer' : null,
            ownAnswers: eligibility?.own_answers ?? 0,
            practiceRight: eligibility?.practice_right ?? 0,
            practiceTotal: eligibility?.practice_total ?? 0,
            // Proven by a passed sitting while the estimate is under the bar
            // (a bar raised to 0.95 that a passed 4 of 5 check left at 0.88):
            // the line says which.
            byCheck: !!eligibility?.eligible && eligibility.shown_score < threshold,
            // The newest answer, not `last_updated`: a seed rewrite moves that too.
            lastEvidenceAt: rows[0]?.at ?? null,
        },
        count,
        rows,
    };
}
