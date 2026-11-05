// server/cardWrite.js — one write to a flashcard: a rating, its undo, or an
// edit. Shared by PUT /api/ai/flashcards/:id (every review surface in the app)
// and the card review an agent host draws in its own window
// (server/agentSittings.js), so a card rated in Claude's window is logged,
// guarded against a double write and turned into evidence exactly like one
// rated in the app.
import db from './database.js';
import { hasAppReview, logReview, normalizeRating, undoLastReview, undoReview } from './reviewLog.js';
import { recordCardEvidence } from './cardEvidence.js';
import { cardEdited, parkedByReport } from './itemReports.js';

/**
 * Apply `body` (the fields PUT /api/ai/flashcards/:id takes) to card `id`.
 * Returns `{ status, json }`: the HTTP status and the answer the route sends.
 */
export function writeCard(id, body = {}) {
    const { front, back, extra, extra_front, difficulty, last_reviewed, next_review, ease_factor, last_interval,
        stability, stability_fast, fsrs_difficulty, state, lapses, learning_steps, review_count, rating, undo_review, undo_of } = body;
    // The row as it was, for the review log: a review is "this rating, from
    // this state, after this many days" and only the pre-update row knows it.
    const before = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(id);
    if (!before) return { status: 404, json: { error: 'Flashcard not found' } };
    // The memory state is read back by the scheduler, which refuses anything but
    // a finite number: text stored here would break the card's next review. The
    // counts (lapses, review_count, learning_steps) are coerced below instead.
    for (const [name, v] of [['stability', stability], ['stability_fast', stability_fast], ['fsrs_difficulty', fsrs_difficulty],
        ['last_interval', last_interval], ['ease_factor', ease_factor]]) {
        if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
            return { status: 400, json: { error: `${name} must be a non-negative number or null.` } };
        }
    }
    // The two traces are one memory state: a fast trace written beside a slow
    // one from another review would describe neither. The scheduler and the
    // undo snapshot always send both.
    if (stability_fast !== undefined && stability === undefined) {
        return { status: 400, json: { error: 'stability_fast is written only together with stability.' } };
    }
    // A rating arriving TWICE — a request retried after its answer was lost, a
    // double press that raced — carries the same `last_reviewed` stamp, and
    // every rating stamps a fresh one. The stamp already being logged for this
    // card means this review was applied: answering with the card as it
    // stands, rather than bumping review_count and writing a second review_log
    // row the FSRS optimiser would fit on as a review that never happened.
    // The LOG is asked, not only the card: after a newer review B, a late retry
    // of A no longer matches the card's stamp, and applying it would put the
    // card back on A's schedule.
    if (normalizeRating(rating) && last_reviewed != null && review_count === undefined
        && ((before.last_reviewed != null && String(before.last_reviewed) === String(last_reviewed))
            || hasAppReview(before.id, last_reviewed))) {
        return { status: 200, json: before };
    }
    // An undo names the review it takes back by the stamp that rating wrote.
    // If the card no longer holds that stamp, something rated it since (another
    // tab, another device) and restoring this snapshot would erase that newer
    // review — so nothing is written. The one exception is this same undo
    // arriving twice: the card already holds the snapshot's stamp and the
    // review is gone from the log, so the answer is the card as it stands.
    // An undo WITHOUT `undo_of` (a client that does not send it) restores the
    // snapshot below and takes back the newest app review.
    if (undo_review === true && undo_of != null && String(before.last_reviewed ?? '') !== String(undo_of)) {
        if (String(before.last_reviewed ?? '') === String(last_reviewed ?? '') && !hasAppReview(before.id, undo_of)) {
            return { status: 200, json: before };
        }
        return { status: 409, json: {
            error: 'This card was reviewed again after that rating, so the rating can no longer be taken back.',
            conflict: 'reviewed_since',
        } };
    }
    // A card the learner reported is parked until the report is undone or the
    // card edited. A schedule written meanwhile (a rating or a rating's undo
    // from a page that missed the report) would put it back in the due queues
    // under a standing report, so nothing is written. A review write with no
    // schedule (a rating and its stamp, a bare undo) is refused too: its row
    // in the log would outlive the report and count after its Undo.
    const writesReview = next_review !== undefined || last_reviewed !== undefined || !!normalizeRating(rating) || undo_review === true;
    if (writesReview && parkedByReport(before)) {
        return { status: 409, json: { error: 'This card is reported. Undo the report or edit the card first.', conflict: 'reported' } };
    }
    const updates = [];
    const values = [];
    if (front !== undefined) { updates.push('front = ?'); values.push(front); }
    if (back !== undefined) { updates.push('back = ?'); values.push(back); }
    // The supporting lines under the answer (reading, example sentence, its
    // translation). Editable for the same reason front/back are: the card is
    // the learner's, and an imported one is somebody else's guess about it.
    if (extra !== undefined) { updates.push('extra = ?'); values.push(extra); }
    if (extra_front !== undefined) { updates.push('extra_front = ?'); values.push(extra_front); }
    if (difficulty !== undefined) { updates.push('difficulty = ?'); values.push(difficulty); }
    if (last_reviewed !== undefined) { updates.push('last_reviewed = ?'); values.push(last_reviewed); }
    if (next_review !== undefined) { updates.push('next_review = ?'); values.push(next_review); }
    if (ease_factor !== undefined) { updates.push('ease_factor = ?'); values.push(ease_factor); }
    if (last_interval !== undefined) { updates.push('last_interval = ?'); values.push(last_interval); }
    // FSRS-7 card state. Whitelisted like every other field — the client sends
    // what src/utils/srs.ts computed, and anything not listed here is ignored.
    if (stability !== undefined) { updates.push('stability = ?'); values.push(stability); }
    // The fast trace travels WITH the slow one. A write of `stability` alone
    // (a client from before FSRS-7, a tab not yet reloaded) clears it, so the
    // card reads as "last scheduled by FSRS-6" and is seeded from the new
    // stability, rather than pairing that stability with a stale fast trace.
    if (stability_fast !== undefined) { updates.push('stability_fast = ?'); values.push(stability_fast); }
    else if (stability !== undefined) updates.push('stability_fast = NULL');
    if (fsrs_difficulty !== undefined) { updates.push('fsrs_difficulty = ?'); values.push(fsrs_difficulty); }
    if (state !== undefined) { updates.push('state = ?'); values.push(state); }
    if (lapses !== undefined) { updates.push('lapses = ?'); values.push(Math.max(0, Math.round(Number(lapses) || 0))); }
    // The (re)learning ladder rung. In the whitelist for the same reason
    // `state` is: it is scheduler state the client computed, and leaving it out
    // would silently restart the ladder on the card's next rating.
    if (learning_steps !== undefined) {
        updates.push('learning_steps = ?');
        values.push(Math.max(0, Math.round(Number(learning_steps) || 0)));
    }
    if (updates.length > 0) {
        // Only an actual SRS review (which stamps last_reviewed) counts as a
        // review — editing a card's text must not inflate its review history.
        //
        // An EXPLICIT review_count wins over the implicit bump, and that is what
        // makes a review undoable: taking a rating back restores the card's
        // whole prior state, `last_reviewed` included, and re-stamping it must
        // not leave the tally one higher than before the review it just erased.
        // Both in one UPDATE is not an option — the same column twice.
        if (review_count !== undefined) {
            updates.push('review_count = ?');
            values.push(Math.max(0, Math.round(Number(review_count) || 0)));
        } else if (last_reviewed !== undefined) {
            updates.push('review_count = review_count + 1');
        }
        values.push(id);
    }
    // History. A review carries a `rating` and stamps `last_reviewed`; an undo
    // carries `undo_review` (src/utils/srs.ts puts it on every snapshot) and
    // takes its review back out of the log, because a rating that was undone
    // must not be fitted on as if it happened. A plain edit carries neither
    // and touches nothing here.
    //
    // The card row and its history are ONE write: with the log insert failing
    // on its own, the card had already moved to the new schedule with no review
    // behind it, and the retry was then answered as a duplicate — the missing
    // history never came back.
    const reviewRating = normalizeRating(rating);
    const isReview = !!reviewRating && last_reviewed !== undefined;
    db.transaction(() => {
        if (updates.length > 0) {
            db.prepare(`UPDATE flashcards SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        }
        if (isReview) {
            const at = last_reviewed ? new Date(last_reviewed) : new Date();
            logReview({
                before, rating: reviewRating,
                after: { stability, fsrs_difficulty },
                now: Number.isNaN(at.getTime()) ? new Date() : at,
            });
        } else if (undo_review === true) {
            if (undo_of != null) undoReview(before.id, undo_of);
            else undoLastReview(before.id);
        }
    })();
    if (isReview) {
        // …and tell the LEARNER MODEL, which for the app's whole life this
        // wrote nothing to: a batch of ratings is one observation about the
        // topic the cards hang off (server/cardEvidence.js). Never fatal — a
        // rating that was taken is a rating that stands, whatever the estimate
        // does with it.
        try {
            recordCardEvidence(before.id);
        } catch (err) {
            console.error('[cards] mastery evidence failed:', err.message);
        }
    }
    // The learner fixed a card they had reported as wrong: the report is
    // settled and the card goes back into its queue (server/itemReports.js).
    // An empty field and a NULL one are the same text: the editor sends '' for
    // an extra the card never had, and a Save that changed nothing is no edit.
    const asText = (v) => (v == null || v === '' ? null : v);
    const textEdited = ['front', 'back', 'extra', 'extra_front'].some(k => body[k] !== undefined && asText(body[k]) !== asText(before[k]));
    if (!isReview && undo_review !== true && textEdited) {
        try { cardEdited(before.id); } catch (err) { console.error('[cards] report settle failed:', err.message); }
    }
    return { status: 200, json: db.prepare('SELECT * FROM flashcards WHERE id = ?').get(id) };
}
