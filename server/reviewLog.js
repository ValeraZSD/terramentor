// server/reviewLog.js — the per-review history the scheduler never kept.
//
// Every review surface writes a card's NEW state (stability, difficulty,
// next_review) over its old one, so the card row alone says what a card's
// schedule IS and never what happened to it: no rating, no elapsed time, no
// "before". Two things need the history and neither can be built without it:
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
// if it happened. An undo names its review by the `last_reviewed` stamp the
// rating wrote (`undo_of`), so it can never take back a newer one. Anki imports bring their own history (`revlog`), tagged
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

/**
 * The `reviewed_at` a rating stamped `last_reviewed` is logged under — the
 * review's identity. PUT /api/ai/flashcards/:id logs `new Date(last_reviewed)`,
 * so the same stamp always maps to the same row; null for no usable stamp.
 */
function reviewedAtOf(stamp) {
    if (stamp == null || stamp === '') return null;
    const at = new Date(stamp);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Has this exact rating (by its `last_reviewed` stamp) already been logged? */
export function hasAppReview(cardId, stamp) {
    const at = reviewedAtOf(stamp);
    if (!at) return false;
    return !!db.prepare(`SELECT 1 FROM review_log WHERE card_id = ? AND source = 'app' AND reviewed_at = ?`).get(cardId, at);
}

/** Take back the in-app review a rating stamped `stamp`. Returns rows removed (0 or 1). */
export function undoReview(cardId, stamp) {
    const at = reviewedAtOf(stamp);
    if (!at) return 0;
    return db.prepare(`
        DELETE FROM review_log WHERE id = (
            SELECT id FROM review_log WHERE card_id = ? AND source = 'app' AND reviewed_at = ?
            ORDER BY id DESC LIMIT 1
        )
    `).run(cardId, at).changes;
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
 * Per-card review sequences for the optimiser, in time order: EVERY review,
 * `elapsed` in fractional days since the one before it, and `firstOfDay` on the
 * first review of each UTC day.
 *
 * FSRS-7 models same-day memory (its fast trace), so the ten-minute step after
 * an Again is evidence and the fit carries the card's state through it; FSRS-6
 * could not, and these sequences used to drop every same-day row. What is
 * SCORED is still the first review of each day (server/fsrsOptimizer.js): a
 * card rated three times in one sitting is one observation of forgetting, the
 * ladder steps are fixed rather than chosen by the model
 * (`allowModelOverride: false` in src/utils/srs.ts), and this is the day-level
 * comparison the published benchmark reports for FSRS-7, so a loss computed
 * here is comparable in kind (not in scale — one learner, not ten thousand).
 *
 * @param rows `{ card_id, reviewed_at, rating }`, any order
 */
export function sequencesFromRows(rows) {
    const byCard = new Map();
    for (const r of rows) {
        const t = Date.parse(r.reviewed_at);
        if (!Number.isFinite(t)) continue;
        if (!byCard.has(r.card_id)) byCard.set(r.card_id, []);
        byCard.get(r.card_id).push({ t, rating: r.rating });
    }
    const out = [];
    for (const [cardId, list] of byCard) {
        list.sort((a, b) => a.t - b.t);
        const reviews = [];
        for (const { t, rating } of list) {
            const prev = reviews[reviews.length - 1];
            const day = utcDay(t);
            reviews.push({ t, day, rating, elapsed: prev ? (t - prev.t) / DAY_MS : 0, firstOfDay: !prev || prev.day !== day });
        }
        out.push({ cardId, reviews });
    }
    return out;
}

export function loadReviewSequences() {
    return sequencesFromRows(db.prepare(`
        SELECT card_id, reviewed_at, rating FROM review_log
        ORDER BY card_id, reviewed_at, id
    `).all());
}
