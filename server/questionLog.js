// server/questionLog.js — which of a topic's saved questions have been asked,
// and which to ask next.
//
// Three surfaces read a topic's bank — the feed, the mastery check and the
// practice quiz — and without one memory between them each reads it its own
// way: the head of the newest row forever, a shuffle of the whole bank with no
// record of the last draw, or the entire row in one sitting (112 questions on
// a real imported topic). All three draw through one rule here and write to
// one log, so a bank of sixty is a resource the learner works through, never
// a lottery and never a marathon.
//
// The rule: NEVER-ASKED first, then LEAST-RECENTLY asked, random within a
// tier. A question answered wrong is not moved up — the estimate that decides
// whether a topic is proven is BKT's, and a bank that re-asked misses would be
// a second scheduler quietly disagreeing with it.
//
// Ghost (review) questions embedded in a saved practice quiz belong to OTHER
// topics and are never drawn here.

import db from './database.js';
import { NOW_ISO } from './database.js';
import { hasUsableKey } from './answerFormats.js';

/** How many questions one practice sitting or one mastery check draws by default. */
export const DEFAULT_CHECK_SIZE = 10;
export const MIN_CHECK_SIZE = 4;
export const MAX_CHECK_SIZE = 30;
export const PRACTICE_SESSION_SIZE = 15;

/**
 * The size a mastery check draws, from the setting — bounded, because a check
 * of two questions cannot be a binomial observation worth writing and a check
 * of sixty is the sitting this module exists to end.
 */
export function masteryCheckSize(readSetting) {
    const n = Number.parseInt(readSetting('mastery_check_size', String(DEFAULT_CHECK_SIZE)), 10);
    if (!Number.isFinite(n)) return DEFAULT_CHECK_SIZE;
    return Math.max(MIN_CHECK_SIZE, Math.min(MAX_CHECK_SIZE, n));
}

const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * A question this module may hand out: the topic's own (never a ghost), and
 * gradeable. A stored key the grader cannot read is skipped rather than served,
 * so it is never marked wrong against a correct answer and never counted in a
 * score's total. `index` stays the storage position, so the ask-record is
 * unaffected by what was skipped.
 */
const servable = (q) => !!q && typeof q === 'object' && !q.isGhost && hasUsableKey(q);

/**
 * Every non-ghost question a node owns, tagged with where it lives. Order is
 * the storage order; the draw reorders.
 */
export function bankOf(nodeId) {
    const rows = db.prepare('SELECT id, questions FROM quizzes WHERE node_id = ? ORDER BY id').all(nodeId);
    const out = [];
    for (const row of rows) {
        const qs = safeParse(row.questions);
        if (!Array.isArray(qs)) continue;
        qs.forEach((q, index) => {
            if (servable(q)) out.push({ quizId: row.id, index, question: q });
        });
    }
    return out;
}

/** One quiz row's own questions, same tagging. */
export function bankOfQuiz(quizId) {
    const row = db.prepare('SELECT id, node_id, questions FROM quizzes WHERE id = ?').get(quizId);
    if (!row) return { nodeId: null, bank: [] };
    const qs = safeParse(row.questions);
    const bank = [];
    if (Array.isArray(qs)) qs.forEach((q, index) => {
        if (servable(q)) bank.push({ quizId: row.id, index, question: q });
    });
    return { nodeId: row.node_id, bank };
}

/**
 * Who a bank entry IS, for the ask-record: its uuid (stamped by database.js on
 * every question a topic owns), falling back to its position only for a row
 * that has none. A position is not an identity — the answer check deletes
 * vetoed questions from a bank, which moved "asked" onto the next question
 * along — so the log is read and written by uuid.
 */
const askKey = (b) => b.question?.uuid || `${b.quizId}:${b.index}`;
const LOG_KEY = `COALESCE(question_uuid, quiz_id || ':' || question_index)`;

function lastAskedMap(quizIds) {
    if (!quizIds.length) return new Map();
    const rows = db.prepare(`
        SELECT ${LOG_KEY} AS k, MAX(asked_at) AS last
        FROM question_log WHERE quiz_id IN (${quizIds.map(() => '?').join(',')})
        GROUP BY k
    `).all(...quizIds);
    return new Map(rows.map(r => [r.k, r.last]));
}

function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

/**
 * Order a bank for asking: never asked (shuffled) first, then by when they
 * were last asked, oldest first (shuffled within one timestamp). `exclude`
 * drops entries by `quizId:index` — the keys a feed client already holds.
 */
export function orderForAsking(bank, { exclude = null } = {}) {
    const last = lastAskedMap([...new Set(bank.map(b => b.quizId))]);
    // `exclude` stays positional: it holds the feed keys a client is showing
    // right now, and a bank is not rewritten under an open page.
    const kept = bank.filter(b => !exclude || !exclude.has(`${b.quizId}:${b.index}`));
    const fresh = shuffle(kept.filter(b => !last.has(askKey(b))));
    const seen = shuffle(kept.filter(b => last.has(askKey(b))))
        .sort((a, b) => String(last.get(askKey(a))).localeCompare(String(last.get(askKey(b)))));
    return [...fresh, ...seen];
}

/** Draw `size` questions from a node's whole bank. */
export function drawFromNode(nodeId, size, opts = {}) {
    const bank = bankOf(nodeId);
    return { bankSize: bank.length, questions: orderForAsking(bank, opts).slice(0, Math.max(0, size)) };
}

/** Draw `size` questions from one quiz row. */
export function drawFromQuiz(quizId, size, opts = {}) {
    const { nodeId, bank } = bankOfQuiz(quizId);
    return { nodeId, bankSize: bank.length, questions: orderForAsking(bank, opts).slice(0, Math.max(0, size)) };
}

/** How much of a node's bank has ever been asked. */
export function askedCount(nodeId) {
    return db.prepare(`
        SELECT COUNT(DISTINCT COALESCE(l.question_uuid, l.quiz_id || ':' || l.question_index)) AS n
        FROM question_log l JOIN quizzes q ON q.id = l.quiz_id WHERE q.node_id = ?
    `).get(nodeId).n;
}

const insertStmt = () => db.prepare(`
    INSERT INTO question_log (quiz_id, question_index, question_uuid, node_id, surface, correct, asked_at)
    VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO})
`);

/**
 * Record that questions were asked. `entries` carry `{quizId, index, correct?}`;
 * anything that does not name a real quiz row is ignored — a client cannot
 * log a question that does not exist. `surface` is where it was asked
 * (`feed` | `mastery_check` | `quiz`), kept for the record, not read by the draw.
 */
export function logAsked(entries, surface) {
    if (!Array.isArray(entries) || !entries.length) return 0;
    // The question's uuid is read at its position NOW, as the entry is logged —
    // the one moment the position is known to point at the question asked.
    const nodeOf = db.prepare(`
        SELECT node_id, CASE WHEN json_valid(questions)
                             THEN json_extract(questions, '$[' || CAST(? AS INTEGER) || '].uuid') END AS uuid
        FROM quizzes WHERE id = ?
    `);
    const insert = insertStmt();
    let n = 0;
    const tx = db.transaction(() => {
        for (const e of entries) {
            const quizId = Number(e?.quizId);
            const index = Number(e?.index);
            if (!Number.isInteger(quizId) || !Number.isInteger(index) || index < 0) continue;
            const row = nodeOf.get(index, quizId);
            if (!row) continue;
            const correct = e.correct == null ? null : (e.correct ? 1 : 0);
            insert.run(quizId, index, row.uuid ?? null, row.node_id, String(surface || 'unknown').slice(0, 32), correct);
            n++;
        }
    });
    tx();
    return n;
}

/** Parse a feed card key of the shape `savedq-<quizId>-<index>`. */
export function parseSavedKey(key) {
    const m = /^savedq-(\d+)-(\d+)$/.exec(String(key || ''));
    return m ? { quizId: Number(m[1]), index: Number(m[2]) } : null;
}
