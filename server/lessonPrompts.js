// Two prompts around a lesson that are NOT evidence.
//
// Pre-questions: a topic's first part opens with ONE of the topic's own
// questions, a single tap, asked before anything is taught — and only when the
// app already holds a head start on the topic (a placement or transfer seed,
// `server/headStart.js`). On material that is plainly new, a quiz before the
// text reads as a test the learner was set up to fail, and learners who meet
// prequestions drop out more; where some of it may be known, one quick guess
// primes the reading at little cost. Guessing first and reading after is what
// makes the reading stick (the pretesting effect), but an answer
// given before teaching says nothing about what was learned. So the answers go
// to `pre_questions` and nowhere else: no `mastery_evidence`, no
// `question_log`, no `answer_attempts`, and the feed row a pre-question came
// from stays unread, so the same question is still asked after the part that
// teaches it, where its answer counts. `tools/prequestion-gates.mjs` pins it.
//
// Explain-it-back: after a lesson part, the learner may put the part in their
// own words; the model marks that against the part's text and says why. It is
// not evidence either: it is written with the part a scroll away, the prompt
// has no vetted key (a question no verifier confirmed is practice, never
// proof), and only the learners who feel sure would answer an optional box.
// The record is `explain_backs`.
import db, { NOW_ISO } from './database.js';
import { ANSWER_FORMATS, hasUsableKey } from './answerFormats.js';
import { drawFromNode } from './questionLog.js';
import { headStartFor } from './headStart.js';
import { AI_PROMPTS, aiProvenance, generateResponse } from './ai.js';
import { readReplyObject } from './jsonRepair.js';
import { feedRowIsProof } from './questionTrust.js';
import { apiError } from './clientError.js';

export const PRE_QUESTIONS_MAX = 1;
// A tap, never typing: choice and true/false only.
const TAP_FORMATS = new Set(['multiple_choice', 'true_false']);
export const PRE_OUTCOMES = new Set(['answered', 'skipped']);
export const EXPLANATION_MAX = 2000;
// The part's text the marker reads, visuals left out: they are specs, not
// prose, and a long animation would push the explanation out of a small model.
// A code listing stays: on a programming course it IS what the part teaches.
const PART_TEXT_MAX = 6000;
const SPEC_FENCES = /^```(mermaid|vega-lite|vega|plot|animation|p5|widget|drill|smiles|svg)\b[\s\S]*?(^```|$(?![\s\S]))/gm;

/** One tap, graded here with no model: a pre-question must work with none set up. */
const gradedLocally = (q) => !!q && TAP_FORMATS.has(q.type) && ANSWER_FORMATS[q.type]?.grading === 'local' && hasUsableKey(q);

// Prepared once, on first use: preQuestionsFor runs inside composeFeed's topic loop.
const memo = (sql) => { let s = null; return () => (s ??= db.prepare(sql)); };
const askedStmt = memo('SELECT 1 FROM pre_questions WHERE node_id = ? LIMIT 1');
const feedRefStmt = memo("SELECT 1 FROM feed_items WHERE id = ? AND node_id = ? AND kind = 'question'");
const bankRefStmt = memo(`
    SELECT 1 FROM quizzes q JOIN json_each(q.questions) je
    WHERE q.node_id = ? AND json_extract(je.value, '$.uuid') = ? LIMIT 1
`);
const nodeStmt = memo('SELECT 1 FROM nodes WHERE id = ?');
const insertPreStmt = memo(`
    INSERT INTO pre_questions (node_id, outcome, asked, answered, correct, items, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO})
`);
const lessonRowStmt = memo(`
    SELECT fi.id, fi.node_id, fi.content, fi.meta, n.title
    FROM feed_items fi JOIN nodes n ON n.id = fi.node_id
    WHERE fi.id = ? AND fi.kind = 'lesson'
`);
const insertExplainStmt = memo(`
    INSERT INTO explain_backs (node_id, part_index, explanation, verdict, reason, generated_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO})
`);

/**
 * The pre-questions for a topic whose first part is about to be served, or
 * none. `readyRows` are the topic's unread feed rows; `exclude` the bank
 * entries the page already holds (`quizId:index`).
 *
 * The topic's own per-part questions first, in part order: each was written
 * from its part and passed the feed's gates, and it is asked again after that
 * part. A topic asked from its bank has none, so its bank tops the list up.
 * No head start, or one the learner's own answers have already spent: none.
 */
export function preQuestionsFor(nodeId, readyRows, { exclude = new Set() } = {}) {
    const head = headStartFor(nodeId);
    if (!head || head.spent) return null;
    if (askedStmt().get(nodeId)) return null;
    const picks = [];
    for (const row of readyRows) {
        if (picks.length >= PRE_QUESTIONS_MAX) break;
        // The same trust rule as the bank draw below: no unverified key.
        if (row.kind !== 'question' || !feedRowIsProof(row)) continue;
        let q = null;
        try { q = JSON.parse(row.content); } catch { continue; }
        if (gradedLocally(q)) picks.push({ feedItemId: row.id, question: q });
    }
    if (picks.length < PRE_QUESTIONS_MAX) {
        const drawn = drawFromNode(nodeId, 9, { exclude }).questions;
        for (const d of drawn) {
            if (picks.length >= PRE_QUESTIONS_MAX) break;
            if (gradedLocally(d.question)) picks.push({ feedItemId: null, question: d.question });
        }
    }
    return picks.length ? picks : null;
}

const REF = /^(fi:[1-9]\d{0,11}|q:[0-9a-f-]{8,64})$/i;

/** Does a ref name one of this topic's questions: its feed row, or a bank entry by uuid? */
function refBelongs(nodeId, ref) {
    const [kind, id] = [ref.slice(0, ref.indexOf(':')).toLowerCase(), ref.slice(ref.indexOf(':') + 1)];
    if (kind === 'fi') return !!feedRefStmt().get(Number(id), nodeId);
    return !!bankRefStmt().get(nodeId, id);
}

/**
 * The ref as it is stored. The row syncs, and a feed row's id is a cache id
 * that means nothing on another device, so a feed question is kept as `feed`;
 * a bank question keeps its uuid, which is the same everywhere.
 */
const storedRef = (ref) => (ref.toLowerCase().startsWith('fi:') ? 'feed' : ref);

/**
 * Record a topic's pre-question round, once. `items` are refs and whether
 * each answer matched its key (null: left blank); nothing else is kept, and
 * nothing here writes evidence. A second record for the topic is a no-op.
 */
export function recordPreQuestions(nodeId, { outcome, items }) {
    if (!PRE_OUTCOMES.has(outcome)) return apiError('outcome must be answered or skipped');
    const list = Array.isArray(items) ? items.slice(0, PRE_QUESTIONS_MAX) : [];
    const clean = [];
    for (const it of list) {
        if (!it || typeof it.ref !== 'string' || !REF.test(it.ref)) return apiError('each item needs a ref');
        // A skipped round answered nothing, whatever the body says.
        const correct = outcome === 'answered' && typeof it.correct === 'boolean' ? it.correct : null;
        clean.push({ ref: it.ref, correct });
    }
    if (!nodeStmt().get(nodeId)) return { missing: true };
    // Only this topic's own questions are kept: a ref to anything else is dropped.
    const kept = clean.filter(it => refBelongs(nodeId, it.ref));
    return db.transaction(() => {
        if (askedStmt().get(nodeId)) return { duplicate: true };
        insertPreStmt().run(
            nodeId, outcome, kept.length,
            kept.filter(i => i.correct !== null).length,
            kept.filter(i => i.correct === true).length,
            JSON.stringify(kept.map(i => ({ ref: storedRef(i.ref), correct: i.correct }))),
        );
        return { ok: true };
    })();
}

/**
 * The part's text for the marker: visuals out, code kept, capped. A long part
 * loses its MIDDLE, not its end: the conclusion is what an explanation most
 * often states.
 */
export function partProse(markdown) {
    const text = String(markdown || '')
        .replace(SPEC_FENCES, '[figure]')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (text.length <= PART_TEXT_MAX) return text;
    const tail = Math.floor(PART_TEXT_MAX / 3);
    return `${text.slice(0, PART_TEXT_MAX - tail)}\n\n[…]\n\n${text.slice(-tail)}`;
}

/** The marker's reply, or null when it holds no usable verdict. */
export function parseExplainVerdict(text) {
    let r;
    try { r = readReplyObject(text, undefined, (o) => 'verdict' in o); } catch { return null; }
    const verdict = typeof r?.verdict === 'string' ? r.verdict.trim().toLowerCase() : '';
    if (!['good', 'weak', 'unsure'].includes(verdict)) return null;
    const reason = typeof r.reason === 'string' ? r.reason.trim().slice(0, 600) : '';
    return { verdict, reason };
}

/**
 * Mark an explanation of one lesson part against that part's text, as the
 * server stores it (never text the client sends). Stores the record and
 * returns `{ verdict, reason }`; a reply with no verdict is `unsure`, said so,
 * and stored as such. Throws when the model cannot be reached: nothing stored.
 */
export async function markExplanation(feedItemId, explanation) {
    const row = lessonRowStmt().get(feedItemId);
    if (!row) return { missing: true };
    let meta = {};
    try { meta = JSON.parse(row.meta || '{}') || {}; } catch { /* no meta */ }
    const { system, user } = AI_PROMPTS.explain_back(row.title, meta.partTitle || '', partProse(row.content), explanation);
    // Low temperature, as every verdict call: "Check again" on the same text
    // must not flip between good and weak.
    const reply = await generateResponse(user, system, [], { job: 'checks', temperature: 0.1 });
    // No reason with no verdict: the screen says so in the learner's language.
    const parsed = parseExplainVerdict(reply) ?? { verdict: 'unsure', reason: '' };
    insertExplainStmt().run(row.node_id, Number.isInteger(meta.partIndex) ? meta.partIndex : 1, explanation, parsed.verdict, parsed.reason, aiProvenance({ job: 'checks' }));
    return parsed;
}
