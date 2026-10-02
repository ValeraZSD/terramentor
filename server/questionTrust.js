// server/questionTrust.js — whether a question may count as PROOF.
//
// Every model-written question gets a second opinion before it is served: an
// independent pass answers it cold (`verifyQuestion`, feedQuality.js), and a
// disputed key vetoes it. When that pass gives NO verdict — the endpoint was
// down, or the model answered with nothing parseable — the question is still
// served, because re-authoring it would only produce another question the same
// verifier cannot judge, and a topic with no questions measures nothing.
//
// Served is not the same as trusted. Before this module, such a question was
// kept in a mastery-check bank, answered in the feed and seeded a placement
// prior exactly like a checked one, so "the model checks the questions" was
// true only while the checker was up. Now a question no verifier confirmed is
// PRACTICE, NEVER PROOF:
//
//   - it is stamped on the stored question itself (`unverified`, below), in
//     the quiz row's JSON or the feed row's content, so the state survives a
//     restart and travels with the question to every surface that draws it;
//   - its answer writes no mastery evidence (the feed treats it like the
//     grader's "unsure"; a practice sitting's evidence leaves it out of the
//     score and the total, `provenSitting`);
//   - the mastery check and the practice draw never hand it out, and the feed
//     does not ask it from a bank (questionLog.js);
//   - it is re-verified later by the feed's background chain (feedGen.js,
//     the last tier of a burst, for the focus window's topics and any topic
//     a draw had to hold one back from), one question per step, with a wait
//     between attempts that doubles up to a day — never on a request path,
//     so nothing the learner does waits on it;
//   - a later verdict decides it: confirmed, the stamp comes off and it counts
//     from then on (answers given while it was unconfirmed stay uncounted);
//     disputed, it is deleted, like any question the verifier vetoes.
//
// A model-written question is stamped from the moment it is STORED, not only
// once a verifier has failed on it: `finalizeQuiz` and capture write their
// questions PENDING (`markPending`: the same stamp, `tries: 0`, reason "not
// checked yet"), and `vetQuiz` takes the stamp off each one it confirms. So a
// bank is never proof while its vetting is still running (minutes on a local
// model), and a vetting that is cancelled half way leaves the unchecked half
// stamped, where the background chain finds it, instead of unstamped for good.
//
// A question that was never ASKED about — an imported course's own questions,
// written by a person and never sent to a verifier — carries no stamp and is
// unaffected. The stamp means "no verifier has confirmed this model-written
// question", nothing broader, so an absent stamp is never read as "unchecked".
// A course FILE carries the stamp portably as `unchecked: true`
// (`portableQuestion` / `importedQuestion`), so exporting and importing again
// cannot turn an unconfirmed question into proof.
//
// Only the database here: no model client, so feed.js and questionLog.js can
// import it without pulling ai.js in behind them.

import db from './database.js';

/** First wait after a failed verification; doubles with each failure. */
export const REVERIFY_BASE_WAIT_MS = 15 * 60 * 1000;
/**
 * No wait is longer than a day, and there is no last try: an outage that ends
 * is noticed the next day at the latest, and a question never becomes
 * practice-only for good because the verifier was down for a week. The cost
 * is bounded by demand — only topics in the focus window or just drawn from
 * are asked about — at one call per question per day at worst.
 */
export const REVERIFY_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

/** How long to wait before the next attempt, after `tries` attempts that gave no verdict. */
export function reverifyWait(tries) {
    const n = Math.max(1, Math.trunc(Number(tries) || 1));
    return Math.min(REVERIFY_MAX_WAIT_MS, REVERIFY_BASE_WAIT_MS * 2 ** (n - 1));
}

/** True when a verifier was asked about this question and has not confirmed it. */
export function isUnverified(question) {
    return !!(question && typeof question === 'object' && question.unverified);
}

/**
 * The question with the stamp on: `unverified: { reason, tries, at, next }`.
 * `next` is when the background chain may ask again; null only on a feed
 * question already answered and later disputed, which nothing asks again.
 */
export function markUnverified(question, reason, { tries = 1, now = Date.now() } = {}) {
    return {
        ...question,
        unverified: {
            reason: String(reason || 'the verifier gave no verdict').slice(0, 200),
            tries,
            at: iso(now),
            next: iso(now + reverifyWait(tries)),
        },
    };
}

/** The reason a question written moments ago carries until its first verdict. */
export const PENDING_REASON = 'not checked yet';

/**
 * The stamp a model-written question is STORED with, before any verifier has
 * been asked: `tries: 0` is what makes it pending rather than failed.
 * `delayMs` is how long the background chain leaves it alone — `vetQuiz`'s
 * own pass is normally running then, and a second verifier call on the same
 * question would only be spent twice; after an abort, that wait is how soon
 * the chain picks it up. 0 (capture, import) is due at once.
 */
export function markPending(question, { now = Date.now(), delayMs = 0, reason = PENDING_REASON } = {}) {
    return {
        ...question,
        unverified: { reason: String(reason).slice(0, 200), tries: 0, at: iso(now), next: iso(now + Math.max(0, delayMs)) },
    };
}

/** Stamped at write time and not yet put to any verifier. */
export function isPending(question) {
    return isUnverified(question) && question.unverified.tries === 0;
}

/**
 * A question as a course FILE carries it. The stamp's retry schedule and
 * `verifiedAt` are this library's record and do not travel, but WHETHER the
 * question was confirmed does: `unchecked: true`, or nothing. Without it an
 * export and an import would turn an unconfirmed question into proof, since an
 * absent stamp is read as "never needed checking".
 */
export function portableQuestion(question) {
    const { unverified: _stamp, verifiedAt: _checkedAt, unchecked: _claim, ...content } = question || {};
    return isUnverified(question) ? { ...content, unchecked: true } : content;
}

/**
 * The inverse, as the importer stores a question: `unchecked: true` becomes a
 * pending stamp with a fresh schedule, due at once, so this library's own
 * background chain puts it to its verifier. Anything else is stored as the
 * file wrote it, unstamped.
 */
export function importedQuestion(question, { now = Date.now() } = {}) {
    if (!question || typeof question !== 'object') return question;
    const { unchecked, ...content } = question;
    return unchecked === true ? markPending(content, { now, reason: 'imported as not checked yet' }) : content;
}

/** The question with the stamp off, and when the confirmation came. */
export function markConfirmed(question, { now = Date.now() } = {}) {
    const { unverified: _gone, ...rest } = question || {};
    return { ...rest, verifiedAt: iso(now) };
}

/** May the background chain ask about this question again now? */
export function dueForReverify(question, now = Date.now()) {
    if (!isUnverified(question)) return false;
    const next = question.unverified.next;
    if (!next) return false;
    const t = Date.parse(next);
    return Number.isFinite(t) ? t <= now : true;
}

const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * A feed row's question is proof unless it is stamped — in its content (from
 * now on) or in its meta, which is where the generator recorded an unanswered
 * verifier before the content carried it (`verified: false`, the pre-fix shape).
 */
export function feedRowIsProof(row) {
    if (!row) return true;
    const meta = safeParse(row.meta) || {};
    if (meta.verified === false) return false;
    return !isUnverified(safeParse(row.content));
}

/** The stored question at a quiz row's position, or null. */
export function storedQuestion(quizId, index) {
    const row = db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(quizId);
    const qs = row ? safeParse(row.questions) : null;
    return Array.isArray(qs) ? (qs[index] ?? null) : null;
}

/**
 * Where a feed card's question lives, from its key: a bank question
 * (`savedq-<quizId>-<index>`) or a recall question
 * (`recall-<nodeId>-<quizId>-<index>`). null for anything else.
 */
export function bankRefOfFeedKey(key) {
    const s = String(key || '');
    let m = /^savedq-(\d+)-(\d+)$/.exec(s);
    if (m) return { quizId: Number(m[1]), index: Number(m[2]) };
    m = /^recall-\d+-(\d+)-(\d+)$/.exec(s);
    if (m) return { quizId: Number(m[1]), index: Number(m[2]) };
    return null;
}

/**
 * May this feed answer be written as mastery evidence? False only for a
 * question that is stamped unverified, read from the SERVER's copy — the row
 * or the bank — never from anything the client sent.
 */
export function feedAnswerIsProof({ key = null, feedItemId = null } = {}) {
    if (feedItemId != null) {
        const row = db.prepare('SELECT content, meta FROM feed_items WHERE id = ?').get(feedItemId);
        if (row) return feedRowIsProof(row);
    }
    const ref = bankRefOfFeedKey(key);
    if (ref) return !isUnverified(storedQuestion(ref.quizId, ref.index));
    return true;
}

/**
 * Where an asked question is NOW in a freshly read bank, or -1.
 *
 * By its uuid whenever the entry names one: a position is not an identity,
 * because a later veto (`applyVerdict`, any time, in the background) splices
 * the bank, and a position read off the client's copy then points at the next
 * question along — a stamped question's answer landing on a checked one's
 * place. Only an entry with no uuid falls back to its position, and when it
 * carries the stem it asked (`stem`), only if that position still holds the
 * same text (the check `locate` makes for the re-verification queue). A uuid
 * that is no longer in the bank is -1: the question was vetoed and deleted.
 */
export function locateAsked(qs, entry) {
    if (!Array.isArray(qs)) return -1;
    const uuid = typeof entry?.uuid === 'string' && entry.uuid ? entry.uuid : null;
    if (uuid) return qs.findIndex(q => q && typeof q === 'object' && q.uuid === uuid);
    const index = Number(entry?.index);
    if (!Number.isInteger(index) || index < 0 || index >= qs.length) return -1;
    const q = qs[index];
    if (!q || typeof q !== 'object') return -1;
    if (typeof entry?.stem === 'string' && q.question !== entry.stem) return -1;
    return index;
}

/** Does a quiz row (or any row a node owns) hold an own question no verifier confirmed? */
export function bankHoldsUnverified({ quizId = null, nodeId = null } = {}) {
    const rows = quizId != null
        ? db.prepare('SELECT questions FROM quizzes WHERE id = ?').all(quizId)
        : nodeId != null ? db.prepare('SELECT questions FROM quizzes WHERE node_id = ?').all(nodeId) : [];
    return rows.some(r => {
        const qs = safeParse(r.questions);
        return Array.isArray(qs) && qs.some(q => q && typeof q === 'object' && !q.isGhost && isUnverified(q));
    });
}

/**
 * A sitting's score with everything that is not proof taken out.
 *
 * `asked` is what the sitting says it asked:
 * `[{ quizId?, index, uuid?, stem?, ghost?, ghostNodeId?, correct }]` (a
 * practice sitting's entries name no quiz — they are all from `quizId`; a
 * mastery check passes `nodeId`, and an entry naming another topic's row is
 * not its proof). Each entry is found in the stored bank by `locateAsked`.
 * The proven score and total are COUNTED from the entries: an own question
 * that is stamped unverified, gone (vetoed since it was drawn) or cannot be
 * identified leaves both, and one question named twice counts once. The
 * client's own score and total only cap the result, so a list that disagrees
 * with them can lower it and never raise it. `ghostResults` (a practice
 * sitting's review questions from other topics, aggregated per topic by the
 * client) lose a stamped or vanished question the same way.
 *
 * With no `asked` at all, nothing can be looked up: the client's numbers stand
 * for a bank with no stamped question in it (nothing there could be unproven),
 * and count for nothing in one that holds any.
 *
 * `total` may reach 0: the caller writes no evidence then.
 *
 * @returns {{score: number, total: number, removed: number, ghostResults: Array}}
 */
export function provenSitting({ quizId = null, nodeId = null, asked = null, score, total, ghostResults = null }) {
    const ghosts = Array.isArray(ghostResults) ? ghostResults.map(g => ({ ...g })) : ghostResults;
    if (!Array.isArray(asked) || asked.length === 0) {
        if (!bankHoldsUnverified({ quizId, nodeId })) return { score, total, removed: 0, ghostResults: ghosts };
        return { score: 0, total: 0, removed: total, ghostResults: ghosts };
    }
    const cache = new Map();
    const rowOf = (id) => {
        if (!cache.has(id)) {
            const row = db.prepare('SELECT node_id, questions FROM quizzes WHERE id = ?').get(id);
            const qs = row ? safeParse(row.questions) : null;
            cache.set(id, row ? { nodeId: row.node_id, qs: Array.isArray(qs) ? qs : [] } : null);
        }
        return cache.get(id);
    };
    const seen = new Set();
    let s = 0;
    let t = 0;
    let removed = 0;
    for (const a of asked) {
        const qid = Number(a?.quizId ?? quizId);
        const row = Number.isInteger(qid) ? rowOf(qid) : null;
        const own = row && (nodeId == null || Number(row.nodeId) === Number(nodeId));
        const at = own ? locateAsked(row.qs, a) : -1;
        const q = at >= 0 ? row.qs[at] : null;
        const correct = a?.correct ? 1 : 0;
        if (q ? q.isGhost : a?.ghost) {
            // A checked review question: its topic's aggregate stands as sent.
            if (q && !isUnverified(q)) continue;
            const gNode = Number(q?.ghostNodeId ?? a?.ghostNodeId);
            const g = Array.isArray(ghosts) ? ghosts.find(x => Number(x?.nodeId) === gNode) : null;
            if (g && g.total > 0) { g.total -= 1; g.score = Math.max(0, Math.min(g.total, g.score - correct)); }
            continue;
        }
        // An entry with neither uuid nor stem, in a bank that holds a stamped
        // question, cannot be told from its neighbour after a veto: not proof.
        const blind = q && !(typeof a?.uuid === 'string' && a.uuid) && typeof a?.stem !== 'string'
            && row.qs.some(x => x && !x.isGhost && isUnverified(x));
        if (!q || blind || isUnverified(q)) { removed++; continue; }
        const id = q.uuid ? `u:${q.uuid}` : `${qid}:${at}`;
        if (seen.has(id)) continue;
        seen.add(id);
        t++;
        s += correct;
    }
    const cappedTotal = Math.max(0, Math.min(t, Number(total) || 0));
    const cappedScore = Math.max(0, Math.min(s, Number(score) || 0, cappedTotal));
    return { score: cappedScore, total: cappedTotal, removed, ghostResults: ghosts };
}

// ---- the re-verification queue ---------------------------------------------

/**
 * Every question on this node that is waiting for a verdict and may be asked
 * about now: bank questions (never a ghost — it belongs to another topic's
 * bank and is checked there) and feed questions still on the shelf. A feed
 * row the learner already answered is left alone: its answer was never
 * counted, and nothing will ask it again.
 */
export function pendingVerifications(nodeId, { now = Date.now(), limit = 1 } = {}) {
    const out = [];
    for (const row of db.prepare(`
        SELECT id, questions FROM quizzes
        WHERE node_id = ? AND json_valid(questions) AND questions LIKE '%"unverified"%'
        ORDER BY id
    `).all(nodeId)) {
        const qs = safeParse(row.questions);
        if (!Array.isArray(qs)) continue;
        qs.forEach((q, index) => {
            if (out.length >= limit || q?.isGhost || !dueForReverify(q, now)) return;
            out.push({ where: 'bank', nodeId, quizId: row.id, index, uuid: q.uuid ?? null, question: q });
        });
        if (out.length >= limit) return out;
    }
    for (const row of db.prepare(`
        SELECT id, content FROM feed_items
        WHERE node_id = ? AND kind = 'question' AND status = 'ready' AND content LIKE '%"unverified"%'
        ORDER BY seq
    `).all(nodeId)) {
        if (out.length >= limit) break;
        const q = safeParse(row.content);
        if (dueForReverify(q, now)) out.push({ where: 'feed', nodeId, feedItemId: row.id, question: q });
    }
    return out;
}

/**
 * Find a pending bank question in a freshly read list: by uuid when it has
 * one (a position is not an identity — a veto elsewhere in the row moves it),
 * else at its old position if that is still the same question.
 */
function locate(qs, entry) {
    if (entry.uuid) return qs.findIndex(q => q && q.uuid === entry.uuid);
    const q = qs[entry.index];
    return q && q.question === entry.question?.question ? entry.index : -1;
}

/**
 * Write a later verdict back where the question lives.
 *
 * `verdict` is verifyQuestion's `{ ok, available, reason }`:
 *   - available && ok  → confirmed: the stamp comes off, it counts from now on;
 *   - available && !ok → disputed: deleted, like any vetoed question (a bank
 *     left with no questions of its own goes too, as vetQuiz does — unless
 *     someone has already sat it, whose attempts the row's delete would take
 *     with it; a feed row goes, and the generator writes that part's
 *     question again);
 *   - !available       → one more try spent, and the wait before the next grows.
 *
 * @returns {'confirmed'|'vetoed'|'retry'|'gone'}
 */
export function applyVerdict(entry, verdict, { now = Date.now() } = {}) {
    const outcome = !verdict?.available ? 'retry' : verdict.ok ? 'confirmed' : 'vetoed';
    return db.transaction(() => {
        if (entry.where === 'bank') {
            const row = db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(entry.quizId);
            const qs = row ? safeParse(row.questions) : null;
            if (!Array.isArray(qs)) return 'gone';
            const at = locate(qs, entry);
            if (at < 0 || !isUnverified(qs[at])) return 'gone';
            if (outcome === 'confirmed') qs[at] = markConfirmed(qs[at], { now });
            else if (outcome === 'vetoed') qs.splice(at, 1);
            else qs[at] = markUnverified(qs[at], verdict?.reason || qs[at].unverified.reason, { tries: (qs[at].unverified.tries ?? 1) + 1, now });
            const emptied = outcome === 'vetoed' && !qs.some(q => q && !q.isGhost);
            const sat = emptied && !!db.prepare('SELECT 1 FROM quiz_attempts WHERE quiz_id = ? LIMIT 1').get(entry.quizId);
            if (emptied && !sat) {
                db.prepare('DELETE FROM quizzes WHERE id = ?').run(entry.quizId);
            } else {
                db.prepare('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify(qs), entry.quizId);
            }
            return outcome;
        }
        if (entry.where === 'feed') {
            const row = db.prepare('SELECT content, meta, status FROM feed_items WHERE id = ?').get(entry.feedItemId);
            const q = row ? safeParse(row.content) : null;
            if (!q || !isUnverified(q)) return 'gone';
            const meta = safeParse(row.meta) || {};
            if (outcome === 'vetoed') {
                // Still on the shelf: take it off, and the part's question is
                // written again. Already answered: its answer never counted;
                // keep the row (the day's activity reads it) and stop asking.
                if (row.status === 'ready') {
                    db.prepare('DELETE FROM feed_items WHERE id = ?').run(entry.feedItemId);
                } else {
                    const stopped = { ...q, unverified: { ...q.unverified, next: null } };
                    db.prepare('UPDATE feed_items SET content = ?, meta = ? WHERE id = ?')
                        .run(JSON.stringify(stopped), JSON.stringify({ ...meta, vetoedLater: String(verdict?.reason || '').slice(0, 200) }), entry.feedItemId);
                }
                return 'vetoed';
            }
            if (outcome === 'confirmed') {
                const { unverified: _gone, ...restMeta } = meta;
                db.prepare('UPDATE feed_items SET content = ?, meta = ? WHERE id = ?').run(
                    JSON.stringify(markConfirmed(q, { now })),
                    JSON.stringify({ ...restMeta, verified: true, verifiedLater: iso(now) }),
                    entry.feedItemId,
                );
                return 'confirmed';
            }
            const again = markUnverified(q, verdict?.reason || q.unverified.reason, { tries: (q.unverified.tries ?? 1) + 1, now });
            db.prepare('UPDATE feed_items SET content = ? WHERE id = ?').run(JSON.stringify(again), entry.feedItemId);
            return 'retry';
        }
        return 'gone';
    })();
}

/**
 * Carry the pre-fix record onto the question itself. Before the stamp lived
 * in the content, the generator wrote `verified: false` (and the reason as
 * `unverified`) into a feed row's META only, so the card could not show it
 * and nothing could re-check it. Idempotent; one UPDATE, run at startup.
 */
export function adoptLegacyFeedFlags({ now = Date.now() } = {}) {
    const rows = db.prepare(`
        SELECT id, content, meta FROM feed_items
        WHERE kind = 'question' AND json_valid(meta) AND json_extract(meta, '$.verified') = 0
          AND json_valid(content) AND json_extract(content, '$.unverified') IS NULL
    `).all();
    const update = db.prepare('UPDATE feed_items SET content = ? WHERE id = ?');
    db.transaction(() => {
        for (const r of rows) {
            const meta = safeParse(r.meta) || {};
            const q = safeParse(r.content);
            if (!q || typeof q !== 'object') continue;
            update.run(JSON.stringify(markUnverified(q, meta.unverified || 'the verifier gave no verdict', { now })), r.id);
        }
    })();
    return rows.length;
}
