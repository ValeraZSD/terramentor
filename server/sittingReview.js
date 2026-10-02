// What one sitting of a mastery check or a quiz looked like to the learner, kept
// so its result can be opened afterwards: each question as it was asked, the
// learner's answer, whether it was right, and the explanation they were shown.
//
// The day's ledger said "8 of 9 correct" and nothing on the server could say
// WHICH one: a mastery check stored its questions and no answers, a quiz stored
// answers keyed by position in a sitting whose questions it did not record. So
// the screen that graded the sitting sends what it showed, and it is stored
// beside the evidence row (`sitting_reviews`), never inside its metadata.
//
// This is a RECORD for the learner to read back, not evidence: nothing here is
// counted, and the evidence row beside it was written from the server's own
// numbers. The client's copy is cut to the fields a question renders with and
// to fixed sizes, so a submission cannot grow the library without bound.
import db from './database.js';
import { sanitizeQuestionMedia } from './agentic.js';

export const MAX_REVIEW_ITEMS = 60;
const TEXT_CAP = 8000;
const SHORT_CAP = 200;
const LIST_CAP = 12;

const text = (v, cap = TEXT_CAP) => (typeof v === 'string' ? v.slice(0, cap) : undefined);
const list = (v, cap = TEXT_CAP) => (Array.isArray(v)
    ? v.filter(x => typeof x === 'string').slice(0, LIST_CAP).map(x => x.slice(0, cap))
    : undefined);

/** The fields a question is drawn with (QuestionStem, AnswerInput, AnswerKey), and nothing else. */
function reviewQuestion(q) {
    if (!q || typeof q !== 'object' || typeof q.question !== 'string' || !q.question.trim()) return null;
    const out = {
        question: text(q.question),
        type: text(q.type, SHORT_CAP) || 'multiple_choice',
        correct_answer: text(q.correct_answer) ?? '',
        explanation: text(q.explanation) ?? '',
    };
    const options = list(q.options, 2000);
    if (options?.length) out.options = options;
    const accept = list(q.accept, 2000);
    if (accept?.length) out.accept = accept;
    const items = list(q.items, 2000);
    if (items?.length) out.items = items;
    for (const k of ['unit', 'language']) { const v = text(q[k], SHORT_CAP); if (v) out[k] = v; }
    const starter = text(q.starter); if (starter) out.starter = starter;
    if (Number.isFinite(q.tolerance)) out.tolerance = q.tolerance;
    const media = sanitizeQuestionMedia(q.media);
    if (media) out.media = media;
    return out;
}

/**
 * The review as sent, cut to what is drawn. Returns null when nothing in it is
 * a question, so the caller writes no row rather than an empty one.
 */
export function normalizeSittingReview(raw) {
    if (!Array.isArray(raw)) return null;
    const items = [];
    for (const entry of raw.slice(0, MAX_REVIEW_ITEMS)) {
        const question = reviewQuestion(entry?.question);
        if (!question) continue;
        items.push({
            question,
            answer: text(entry.answer) ?? '',
            correct: entry.correct === true,
            ...(text(entry.explanation, TEXT_CAP) ? { explanation: text(entry.explanation, TEXT_CAP) } : {}),
        });
    }
    return items.length ? items : null;
}

/** Store a sitting's review beside its evidence row. A bad review is dropped, never thrown. */
export function saveSittingReview(evidenceId, raw) {
    if (!Number.isInteger(evidenceId)) return false;
    const items = normalizeSittingReview(raw);
    if (!items) return false;
    db.prepare('INSERT OR REPLACE INTO sitting_reviews (evidence_id, items) VALUES (?, ?)')
        .run(evidenceId, JSON.stringify(items));
    return true;
}

/** One sitting, with what the ledger row shows about it. Null when there is none. */
export function getSittingReview(evidenceId) {
    const row = db.prepare(`
        SELECT sr.items, me.score, me.total, me.evidence_type,
               strftime('%Y-%m-%dT%H:%M:%SZ', me.created_at) AS at,
               n.id AS node_id, n.title AS node_title, n.project_id
        FROM sitting_reviews sr
        JOIN mastery_evidence me ON me.id = sr.evidence_id
        JOIN nodes n ON n.id = me.node_id
        WHERE sr.evidence_id = ?
    `).get(evidenceId);
    if (!row) return null;
    let items = [];
    try { items = JSON.parse(row.items); } catch { /* a damaged row reads as empty */ }
    return {
        evidenceId,
        kind: row.evidence_type,
        at: row.at,
        score: Math.round(row.score),
        total: row.total,
        nodeId: row.node_id,
        nodeTitle: row.node_title,
        projectId: row.project_id,
        items: Array.isArray(items) ? items : [],
    };
}
