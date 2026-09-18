// server/reviewLog.js — the per-review history the scheduler never kept.
//
// Every review surface writes a card's NEW state (stability, difficulty,
// next_review) over its old one, so until now the database could say what a
// card's schedule IS and never what happened to it: no rating, no elapsed
// time, no "before". Two things need the history and neither can be built
// without it:
//
//   * fitting FSRS parameters to THIS learner (server/fsrsOptimizer.js) — the
//     published defaults are a population average, and the benchmark that
//     ships them reports per-user optimisation beating them in 84% of
//     collections, but only once a few hundred reviews exist to fit on;
//   * measuring retention — "share of studied cards never forgotten", the only
//     number the deck screen could report, is not retention; the share of
//     REVIEWS answered correctly at their predicted recall probability is.
//
// One row per review, appended by PUT /api/ai/flashcards/:id when the request
// carries a `rating`, and removed again by the same endpoint when the request
// carries `undo_review` — undo is a restore of the card row (src/utils/srs.ts,
// `srsSnapshot`), and a review that was taken back must not stay in the log as
// if it happened. Anki imports bring their own history (`revlog`), tagged
// `source='anki'` and keyed by Anki's id so a re-import cannot duplicate it.
//
// Schema note: `stability_before`/`difficulty_before` are NULL for a card
// reviewed before it had an FSRS state (migrated SM-2 card, Anki row) — the
// optimiser recomputes state from the sequence anyway, so these columns are
// evidence for a human reading the row, not inputs to the fit.

import db from './database.js';

export const RATING_BY_NAME = { again: 1, hard: 2, good: 3, easy: 4 };
const DAY_MS = 86_400_000;

/** 1-4, or null when the value is not a rating this log accepts. */
export function normalizeRating(raw) {
    if (typeof raw === 'string' && RATING_BY_NAME[raw.toLowerCase()]) return RATING_BY_NAME[raw.toLowerCase()];
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

const insertStmt = db.prepare(`
    INSERT INTO review_log (card_id, reviewed_at, rating, state_before, elapsed_days, scheduled_days,
                            stability_before, difficulty_before, stability_after, difficulty_after,
                            source, external_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * Record one review performed in this app.
 * @param before  the flashcard row as it was BEFORE the update
 * @param after   the fields the update wrote (stability, fsrs_difficulty, …)
 * @param rating  1-4
 */
export function logReview({ before, after, rating, now = new Date() }) {
    const prevAt = before?.last_reviewed ? Date.parse(before.last_reviewed) : NaN;
    const elapsed = Number.isFinite(prevAt) ? Math.max(0, (now.getTime() - prevAt) / DAY_MS) : 0;
    // A migrated SM-2 card has no FSRS state yet; if it was reviewed it is in
    // review, otherwise it is new. Mirrors the migration in src/utils/srs.ts.
    const stateBefore = before?.stability != null
        ? (before.state ?? 2)
        : ((before?.review_count ?? 0) > 0 || before?.last_reviewed ? 2 : 0);
    const info = insertStmt.run(
        before.id, now.toISOString(), rating, stateBefore,
        Number(elapsed.toFixed(6)),
        before?.last_interval ?? null,
        before?.stability ?? null, before?.fsrs_difficulty ?? null,
        after?.stability ?? null, after?.fsrs_difficulty ?? null,
        'app', null,
    );
    return Number(info.lastInsertRowid);
}

/** Take back the newest in-app review of a card. Returns rows removed (0 or 1). */
export function undoLastReview(cardId) {
    return db.prepare(`
        DELETE FROM review_log WHERE id = (
            SELECT id FROM review_log WHERE card_id = ? AND source = 'app'
            ORDER BY reviewed_at DESC, id DESC LIMIT 1
        )
    `).run(cardId).changes;
}

/**
 * Anki's `revlog` → this log. `rows` are raw revlog rows (id, cid, ease, ivl,
 * lastIvl, type) and `cardIdOf` maps an Anki card id to the flashcard id it
 * became. Anki's `type`: 0 learn, 1 review, 2 relearn, 3 filtered/cram, 4
 * manual reschedule (no answer given — skipped, like Anki's own optimiser
 * does). Intervals are days when positive and NEGATIVE SECONDS for learning
 * steps. Idempotent: the (source, external_id) unique index refuses a repeat.
 */
export function importAnkiRevlog(rows, cardIdOf) {
    let imported = 0, skipped = 0;
    const byCard = new Map();
    for (const r of rows) {
        if (!byCard.has(r.cid)) byCard.set(r.cid, []);
        byCard.get(r.cid).push(r);
    }
    const run = db.transaction(() => {
        for (const [cid, list] of byCard) {
            const cardId = cardIdOf(cid);
            if (!cardId) { skipped += list.length; continue; }
            list.sort((a, b) => a.id - b.id);
            let prevAt = null;
            for (const r of list) {
                const rating = normalizeRating(r.ease);
                const type = Number(r.type);
                if (!rating || type === 4) { skipped++; continue; }
                const at = Number(r.id);
                const elapsed = prevAt == null ? 0 : Math.max(0, (at - prevAt) / DAY_MS);
                const last = Number(r.lastIvl) || 0;
                const scheduled = last > 0 ? last : (last < 0 ? -last / 86_400 : 0);
                const stateBefore = type === 0 ? 1 : type === 2 ? 3 : 2;
                try {
                    insertStmt.run(cardId, new Date(at).toISOString(), rating, stateBefore,
                        Number(elapsed.toFixed(6)), Number(scheduled.toFixed(6)),
                        null, null, null, null, 'anki', String(r.id));
                    imported++;
                } catch (err) {
                    if (/UNIQUE/i.test(err.message)) { skipped++; continue; }
                    throw err;
                }
                prevAt = at;
            }
        }
    });
    run();
    return { imported, skipped };
}

export function reviewLogStats() {
    const row = db.prepare(`
        SELECT COUNT(*) AS rows_, COUNT(DISTINCT card_id) AS cards,
               SUM(source = 'app') AS app, SUM(source = 'anki') AS anki,
               MIN(reviewed_at) AS first, MAX(reviewed_at) AS last
        FROM review_log
    `).get();
    return { rows: row.rows_ || 0, cards: row.cards || 0, app: row.app || 0, anki: row.anki || 0, first: row.first, last: row.last };
}

const utcDay = (ms) => Math.floor(ms / DAY_MS);

/**
 * Per-card review sequences for the optimiser, in time order.
 *
 * Day-grained on purpose, and MORE so since (re)learning steps were turned on
 * (`enable_short_term: true` in src/utils/srs.ts, 2026-09-03). A card rated
 * Again now comes back ten minutes later in the same sitting, so one card can
 * produce three or four log rows in an afternoon — and those are one learning
 * session, not several observations of forgetting. Fitting a forgetting curve
 * on them would be fitting it to the learner's short-term memory. So the first
 * rating of each UTC day is kept, subsequent same-day rows are dropped, and
 * `elapsed` is whole days since the kept review before it. The log keeps every
 * row (it is history, and `undoLastReview` needs the newest); the sequences are
 * what get thinned. This is also how the published benchmark evaluates the
 * day-grained variant, so a loss computed here is comparable in kind (not in
 * scale — one learner, not ten thousand).
 */
export function loadReviewSequences() {
    const rows = db.prepare(`
        SELECT card_id, reviewed_at, rating FROM review_log
        ORDER BY card_id, reviewed_at, id
    `).all();
    const out = [];
    let cur = null;
    for (const r of rows) {
        const t = Date.parse(r.reviewed_at);
        if (!Number.isFinite(t)) continue;
        if (!cur || cur.cardId !== r.card_id) {
            cur = { cardId: r.card_id, reviews: [] };
            out.push(cur);
        }
        const day = utcDay(t);
        const prev = cur.reviews[cur.reviews.length - 1];
        if (prev && prev.day === day) continue;          // same-day repeat: one session
        cur.reviews.push({ t, day, rating: r.rating, elapsed: prev ? day - prev.day : 0 });
    }
    return out;
}
