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

/**
 * Whether an entry of a kept record is this question as it was asked. A
 * record older than rows naming their items holds no uuid, so the question
 * is known by its stem AND its key: two questions can share a stem ("Which
 * is larger?", a bank written again), never a stem and a key. Where either
 * side has no key (a sequence) the items to order stand in for it.
 */
export function askedAs(entry, question) {
    const q = entry?.question;
    if (!q || typeof question?.question !== 'string' || q.question !== question.question) return false;
    const kept = typeof q.correct_answer === 'string' ? q.correct_answer : '';
    const key = question.correct_answer == null ? '' : String(question.correct_answer);
    if (kept && key) return kept === key;
    const sorted = (xs) => (Array.isArray(xs) ? [...xs].map(String).sort().join('\u0000') : null);
    return sorted(q.items) === sorted(question.items);
}

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
    // An assembly's key is its pieces read into the template's gaps
    // (`AssembledKey`), so the record keeps both.
    const template = text(q.template, 2000);
    if (template) out.template = template;
    const tokens = list(q.tokens, SHORT_CAP);
    if (tokens?.length) out.tokens = tokens;
    // The uuid names the bank question, so a report on it can leave it out of
    // this record (`getSittingReview`).
    for (const k of ['unit', 'language', 'uuid']) { const v = text(q[k], SHORT_CAP); if (v) out[k] = v; }
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
    // An upsert, not REPLACE: a second review of one sitting overwrites the
    // first in place and the row keeps its uuid.
    db.prepare(`INSERT INTO sitting_reviews (evidence_id, items) VALUES (?, ?)
                ON CONFLICT(evidence_id) DO UPDATE SET items = excluded.items, created_at = excluded.created_at`)
        .run(evidenceId, JSON.stringify(items));
    return true;
}

/** One sitting, with what the ledger row shows about it. Null when there is none. */
export function getSittingReview(evidenceId) {
    const row = db.prepare(`
        SELECT sr.items, me.score, me.total, me.evidence_type, me.metadata,
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
    // A question the learner reported is out of the row's score
    // (server/itemReports.js moves it to `metadata.voided`): out of what the
    // record lists too, so "4 of 4" opens on four. Its Undo brings it back.
    let meta = {};
    try { meta = JSON.parse(row.metadata || '{}') || {}; } catch { /* none */ }
    const drop = (list, match) => list.filter(it => {
        const at = match.indexOf(it);
        if (at < 0) return true;
        match.splice(at, 1);
        return false;
    });
    if (Array.isArray(items)) {
        const voided = (Array.isArray(meta.voided) ? meta.voided : []).map(v => v?.u).filter(u => typeof u === 'string');
        if (voided.length) items = drop(items, items.filter(it => voided.includes(it?.question?.uuid)).slice(0, voided.length));
        // A sitting recorded before evidence named its items holds no uuids:
        // the reports standing on its topic name the question by its stem and
        // key (`askedAs`).
        const extra = items.length - row.total;
        if (!Array.isArray(meta.items) && extra > 0) {
            const views = db.prepare(`
                SELECT json_extract(item, '$.view') AS view FROM item_reports
                WHERE node_id = ? AND kind = 'question' AND undone_at IS NULL
            `).all(row.node_id).map(r => { try { return JSON.parse(r.view); } catch { return null; } }).filter(Boolean);
            items = drop(items, items.filter(it => views.some(v => askedAs(it, v))).slice(0, extra));
        }
    }
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
