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
// The one reader that weighs right and wrong is a RECALL (`recallOrder`): it
// does not decide whether a topic is proven, only which question best asks
// whether a fading one stuck.
//
// Ghost (review) questions embedded in a saved practice quiz belong to OTHER
// topics and are never drawn here.

import db from './database.js';
import { NOW_ISO } from './database.js';
import { hasUsableKey, GUESS_BY_FORMAT } from './answerFormats.js';
import { isUnverified, locateAsked } from './questionTrust.js';

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

/**
 * A DRAW asks for proof, so it never hands out a question a verifier was asked
 * about and could not confirm (server/questionTrust.js): every surface that
 * draws — the mastery check, a practice sitting, the feed's bank questions —
 * writes evidence from the answers. Such a question is still in the bank and
 * still counted by `bankOf`; it is only held back from the draw until the
 * background chain confirms it, and a draw that had to skip one tells the
 * listeners (feedGen subscribes, and asks again soon — never here, on the
 * request path). `bankSize` is what a draw could ask; `unverified` is what it
 * held back.
 *
 * One draw is not asking for proof: a PRACTICE sitting from a saved quiz
 * (`practice: true`). A sitting of fifteen or fewer is the whole row, stamped
 * questions included, marked on screen and left out of the evidence
 * (`provenSitting`); a sampled sitting from a bigger row treats them the same
 * way. Held back instead, a row whose bank is all stamped would have an empty
 * sitting and nothing for the page to show. `unverified` then counts the
 * stamped questions the sitting MAY ask.
 */
const unverifiedListeners = new Set();

/** Be told, after a draw, that a node holds questions waiting for a verdict. Returns the unsubscribe. */
export function onUnverifiedHeldBack(fn) {
    unverifiedListeners.add(fn);
    return () => unverifiedListeners.delete(fn);
}

function proofDraw(nodeId, bank, size, { practice = false, ...opts } = {}) {
    const provable = bank.filter(b => !isUnverified(b.question));
    const held = bank.length - provable.length;
    if (held > 0 && nodeId != null) {
        for (const fn of unverifiedListeners) {
            try { fn(nodeId); } catch (err) { console.warn('[questionLog] unverified listener failed:', err?.message); }
        }
    }
    const pool = practice ? bank : provable;
    return { bankSize: pool.length, unverified: held, questions: orderForAsking(pool, opts).slice(0, Math.max(0, size)) };
}

/**
 * The lesson part a bank question waits for: after part i the feed asks only
 * questions whose part is ≤ i. The map is the plan's `bankParts.map`
 * (uuid → part, written by feedGen's `bank-map` step); a question it does not
 * name — no map yet, a failed map, a question added since — waits for the LAST
 * part, when the whole topic has been taught.
 */
export function bankPartLookup(planMeta, partCount) {
    const map = planMeta?.bankParts?.map;
    return (entry) => {
        const p = map && entry?.question?.uuid ? map[entry.question.uuid] : undefined;
        return Number.isInteger(p) && p >= 1 && p <= partCount ? p : partCount;
    };
}

/** Draw `size` questions from a node's whole bank. */
export function drawFromNode(nodeId, size, opts = {}) {
    return proofDraw(nodeId, bankOf(nodeId), size, opts);
}

/** Draw `size` questions from one quiz row (`practice: true` for a practice sitting). */
export function drawFromQuiz(quizId, size, opts = {}) {
    const { nodeId, bank } = bankOfQuiz(quizId);
    return { nodeId, ...proofDraw(nodeId, bank, size, opts) };
}

/**
 * A fading topic's questions in the order a RECALL asks them, by difficulty.
 *
 * A recall asks whether what was learned here stuck, so the question is chosen
 * from this log's record of every answer to it, on every surface:
 *   1. the questions the learner has got right before, hardest first (the
 *      larger share of its graded answers missed): still answering the hardest
 *      thing once known is the strongest sign the topic stuck;
 *   2. then the questions with no graded answer yet, the format a guess cannot
 *      pass first (`GUESS_BY_FORMAT`): a recall answer is written as evidence,
 *      and a lucky true/false says little;
 *   3. then the questions only ever missed: never got right, they say nothing
 *      about forgetting.
 * Within a tier and the same share of misses, the format a guess cannot pass
 * first in EVERY tier (a correct calculation known twice says more than a
 * correct true/false known twice), then the least recently asked, then
 * storage order, so the pick is the same on every read (no lottery). The question the topic's
 * previous recall asked goes last, so two reviews in a row never repeat one.
 *
 * Only what a draw could hand out: the topic's own questions with a usable key
 * (`bankOf`), and never one a verifier has not confirmed, since its answer
 * would record nothing. Returns `{ quizId, index, question }` entries.
 */
export function recallOrder(nodeId) {
    const bank = bankOf(nodeId).filter(b => !isUnverified(b.question));
    if (!bank.length) return [];
    const quizIds = [...new Set(bank.map(b => b.quizId))];
    const marks = quizIds.map(() => '?').join(',');
    // A copy of one of these questions answered inside another topic's
    // practice quiz is logged under THAT quiz, by the uuid the copy keeps:
    // the same question answered, so it counts here too.
    const uuids = [...new Set(bank.map(b => b.question.uuid).filter(u => typeof u === 'string' && u))];
    const byUuid = uuids.length ? ` OR question_uuid IN (${uuids.map(() => '?').join(',')})` : '';
    const record = new Map(db.prepare(`
        SELECT ${LOG_KEY} AS k, SUM(correct = 1) AS hits, SUM(correct = 0) AS misses, MAX(asked_at) AS last
        FROM question_log WHERE quiz_id IN (${marks})${byUuid}
        GROUP BY k
    `).all(...quizIds, ...uuids).map(r => [r.k, r]));
    const previous = db.prepare(`
        SELECT ${LOG_KEY} AS k FROM question_log
        WHERE quiz_id IN (${marks}) AND surface = 'recall'
        ORDER BY asked_at DESC, id DESC LIMIT 1
    `).get(...quizIds)?.k ?? null;

    const ranked = bank.map((b, position) => {
        const r = record.get(askKey(b));
        const hits = r?.hits || 0;
        const misses = r?.misses || 0;
        return {
            b, position,
            tier: hits > 0 ? 0 : misses > 0 ? 2 : 1,
            missShare: hits + misses > 0 ? misses / (hits + misses) : 0,
            guess: GUESS_BY_FORMAT[b.question.type] ?? GUESS_BY_FORMAT.multiple_choice,
            last: r?.last ?? '',
            previous: askKey(b) === previous,
        };
    });
    ranked.sort((x, y) =>
        (x.previous - y.previous)
        || (x.tier - y.tier)
        || (y.missShare - x.missShare)
        || (x.guess - y.guess)
        || (x.last < y.last ? -1 : x.last > y.last ? 1 : 0)
        || (x.position - y.position));
    return ranked.map(r => r.b);
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
 * Record that questions were asked. `entries` carry
 * `{quizId, index, uuid?, stem?, correct?}`; anything that does not name a
 * question a real quiz row still holds is ignored — a client cannot log a
 * question that does not exist. `surface` is where it was asked
 * (`feed` | `recall` | `mastery_check` | `quiz`), kept for the record; only the
 * recall pick reads it, to never ask a topic's previous recall question next.
 *
 * The question is found by its uuid when the entry sends one, and only
 * otherwise at its position (`locateAsked`): a veto in the background splices
 * the bank, and the position the client drew moves onto the next question.
 */
export function logAsked(entries, surface) {
    if (!Array.isArray(entries) || !entries.length) return 0;
    const rowStmt = db.prepare('SELECT node_id, questions FROM quizzes WHERE id = ?');
    const rows = new Map();
    const rowOf = (quizId) => {
        if (!rows.has(quizId)) {
            const row = rowStmt.get(quizId);
            rows.set(quizId, row ? { nodeId: row.node_id, qs: safeParse(row.questions) } : null);
        }
        return rows.get(quizId);
    };
    const insert = insertStmt();
    let n = 0;
    const tx = db.transaction(() => {
        for (const e of entries) {
            const quizId = Number(e?.quizId);
            if (!Number.isInteger(quizId)) continue;
            const row = rowOf(quizId);
            if (!row) continue;
            const at = locateAsked(row.qs, e);
            if (at < 0) continue;
            const correct = e.correct == null ? null : (e.correct ? 1 : 0);
            insert.run(quizId, at, row.qs[at]?.uuid ?? null, row.nodeId, String(surface || 'unknown').slice(0, 32), correct);
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
