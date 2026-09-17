// tools/fsrs-gates.mjs — checks the review log and the FSRS optimiser.
//
// Run:  node tools/fsrs-gates.mjs
//
// Deterministic (seeded PRNG), no model, no network. Two halves:
//
//   1. the LOG — written on a review, taken back on undo, imported from an
//      Anki revlog once and only once, and collapsed to one review per day for
//      the fit, because a card rated three times in one sitting is one
//      observation of forgetting, not three;
//   2. the FIT — on a synthetic learner whose memory follows a KNOWN parameter
//      vector that is not the default, the optimiser must (a) refuse to fit on
//      too little data, (b) beat the defaults on reviews it never saw, and
//      (c) return a vector inside ts-fsrs's own bounds. The synthetic learner
//      is scheduled by the DEFAULT parameters (as a real learner would be, not
//      yet knowing their own) while recall is drawn from the TRUE ones — the
//      exact mismatch the optimiser exists to close.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'fsrs-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
// VAULT_ROOT travels with DB_PATH, always. Nothing imported here sweeps media,
// but a run pointed at a scratch database and the DEFAULT blob store is one
// import away from deleting a real library's files — it has happened once.
process.env.VAULT_ROOT = join(scratch, 'vault');

const db = (await import('../server/database.js')).default;
const { NOW_ISO } = await import('../server/database.js');
const {
    logReview, undoLastReview, importAnkiRevlog, reviewLogStats, loadReviewSequences, normalizeRating,
} = await import('../server/reviewLog.js');
const {
    fit, evaluate, holdoutCutoff, clipW, isValidW, DEFAULT_W, MIN_FIT_REVIEWS,
} = await import('../server/fsrsOptimizer.js');
const { FSRSAlgorithm, generatorParameters, fsrs, createEmptyCard, Rating } = await import('ts-fsrs');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

// ---- fixtures ---------------------------------------------------------------
const projectId = Number(db.prepare(`INSERT INTO projects (name) VALUES ('gate')`).run().lastInsertRowid);
const nodeId = Number(db.prepare(`INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, 'n', 0)`).run(projectId).lastInsertRowid);
const mkCard = () => Number(db.prepare(`INSERT INTO flashcards (node_id, front, back) VALUES (?, 'q', 'a')`).run(nodeId).lastInsertRowid);
const cardRow = (id) => db.prepare('SELECT * FROM flashcards WHERE id = ?').get(id);

// ---- 1. the log --------------------------------------------------------------
console.log('\n--- review log: write, undo ---');
const c1 = mkCard();
const t0 = new Date('2026-05-01T09:00:00Z');
const id1 = logReview({ before: cardRow(c1), after: { stability: 3.1, fsrs_difficulty: 5.2 }, rating: 3, now: t0 });
check('a review writes one row', db.prepare('SELECT COUNT(*) c FROM review_log').get().c === 1 && id1 > 0);
const row1 = db.prepare('SELECT * FROM review_log WHERE id = ?').get(id1);
check('a never-reviewed card logs state_before = new and elapsed 0', row1.state_before === 0 && row1.elapsed_days === 0 && row1.stability_before === null);
check('the after-state is recorded', row1.stability_after === 3.1 && row1.difficulty_after === 5.2 && row1.rating === 3 && row1.source === 'app');
// Pretend the card row was updated by that review, then review it again 4 days later.
db.prepare(`UPDATE flashcards SET last_reviewed = ?, stability = 3.1, fsrs_difficulty = 5.2, state = 2, last_interval = 3, review_count = 1 WHERE id = ?`).run(t0.toISOString(), c1);
const t1 = new Date('2026-05-05T09:00:00Z');
logReview({ before: cardRow(c1), after: { stability: 9.7, fsrs_difficulty: 5.0 }, rating: 4, now: t1 });
const row2 = db.prepare('SELECT * FROM review_log WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(c1);
check('the second review records elapsed 4 days, scheduled 3, state review, stability_before 3.1',
    row2.elapsed_days === 4 && row2.scheduled_days === 3 && row2.state_before === 2 && row2.stability_before === 3.1,
    JSON.stringify(row2));
check('undo removes exactly the newest in-app review', undoLastReview(c1) === 1
    && db.prepare('SELECT COUNT(*) c FROM review_log WHERE card_id = ?').get(c1).c === 1
    && db.prepare('SELECT rating FROM review_log WHERE card_id = ?').get(c1).rating === 3);
check('undo with nothing to undo is a no-op', (undoLastReview(mkCard()) === 0));
check('ratings normalise from names and numbers, and refuse junk',
    normalizeRating('good') === 3 && normalizeRating(4) === 4 && normalizeRating('Again') === 1
    && normalizeRating(0) === null && normalizeRating('meh') === null && normalizeRating(2.5) === null);

console.log('\n--- review log: Anki revlog import ---');
const c2 = mkCard(), c3 = mkCard();
const DAY = 86_400_000;
const base = Date.parse('2026-01-17T10:00:00Z');
const revlog = [
    { id: base, cid: 1001, ease: 2, ivl: -330, lastIvl: 0, type: 0 },                 // learning step, 5.5 min later
    { id: base + 330_000, cid: 1001, ease: 3, ivl: -600, lastIvl: -330, type: 0 },    // same day
    { id: base + 3 * DAY, cid: 1001, ease: 3, ivl: 7, lastIvl: 3, type: 1 },          // review
    { id: base + 4 * DAY, cid: 1001, ease: 3, ivl: 7, lastIvl: 7, type: 4 },          // manual reschedule: skipped
    { id: base + 1 * DAY, cid: 1002, ease: 1, ivl: -60, lastIvl: 2, type: 2 },        // relearn
    { id: base + 2 * DAY, cid: 9999, ease: 3, ivl: 1, lastIvl: 0, type: 1 },          // unknown card: skipped
];
const map = new Map([[1001, c2], [1002, c3]]);
const imp = importAnkiRevlog(revlog, (cid) => map.get(cid));
check('imports the answered rows of known cards, skips the manual entry and the unknown card',
    imp.imported === 4 && imp.skipped === 2, JSON.stringify(imp));
const ank = db.prepare(`SELECT * FROM review_log WHERE card_id = ? ORDER BY reviewed_at, id`).all(c2);
check('learning-step intervals in negative seconds become fractional days', Math.abs(ank[1].scheduled_days - 330 / 86400) < 1e-5
    && ank[1].elapsed_days > 0 && ank[1].elapsed_days < 0.01);
check('type 0/1/2 map to learning/review/relearning', ank[0].state_before === 1 && ank[2].state_before === 2
    && db.prepare('SELECT state_before FROM review_log WHERE card_id = ?').get(c3).state_before === 3);
check('rows are tagged anki and keyed by the revlog id', ank.every(r => r.source === 'anki') && ank[0].external_id === String(base));
const again = importAnkiRevlog(revlog, (cid) => map.get(cid));
check('re-importing the same revlog adds nothing', again.imported === 0
    && db.prepare(`SELECT COUNT(*) c FROM review_log WHERE source = 'anki'`).get().c === 4, JSON.stringify(again));
check('undo never touches imported history', undoLastReview(c2) === 0);
const st = reviewLogStats();
check('stats count both sources', st.rows === 5 && st.app === 1 && st.anki === 4 && st.cards === 3, JSON.stringify(st));

console.log('\n--- review log: sequences for the fit ---');
const seqs = loadReviewSequences();
const s2 = seqs.find(s => s.cardId === c2);
check('same-day repeats collapse to one review per day', s2.reviews.length === 2, JSON.stringify(s2));
check('elapsed is whole days between the kept reviews', s2.reviews[0].elapsed === 0 && s2.reviews[1].elapsed === 3);
check('the first rating of the day is the one kept', s2.reviews[0].rating === 2);

// ---- 1b. what "due" means ----------------------------------------------------
//
// Every flashcard due query used to read `next_review <= datetime('now')`, and
// that comparison was wrong in a way nothing could see. SQLite renders
// `datetime('now')` as `2026-09-03 11:19:30`; every writer in this app stores
// `Date.toISOString()`, i.e. `2026-09-03T10:00:00.000Z`. The comparison is a
// plain string compare and `'T'` (0x54) sorts after `' '` (0x20), so a card due
// EARLIER TODAY read as NOT due and only surfaced at the next UTC midnight.
//
// While every interval was a whole day that looked exactly like the day-graining
// the app claimed to have. It is fatal to a ten-minute (re)learning step: the
// card would be rescheduled, correctly, into a window the query cannot see.
console.log('\n--- what counts as due ---');
{
    const now = Date.now();
    const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
    const dueCard = mkCard();
    const laterCard = mkCard();
    db.prepare('UPDATE flashcards SET next_review = ? WHERE id = ?').run(iso(-10 * 60000), dueCard);
    db.prepare('UPDATE flashcards SET next_review = ? WHERE id = ?').run(iso(10 * 60000), laterCard);

    const dueWith = (nowExpr) => db.prepare(
        `SELECT id FROM flashcards WHERE next_review IS NOT NULL AND next_review <= ${nowExpr}`
    ).all().map(r => r.id);

    const correct = dueWith(NOW_ISO);
    check('a card due ten minutes ago IS due', correct.includes(dueCard), JSON.stringify(correct));
    check('a card due in ten minutes is NOT', !correct.includes(laterCard));

    // The bug, asserted directly, so nobody reintroduces `datetime('now')`
    // thinking it is equivalent — on FIXED strings, because read against the
    // live clock this check was itself wrong for ten minutes a day. Between
    // 00:00 and 00:10 UTC a card due ten minutes ago is stamped YESTERDAY, the
    // date halves settle the comparison before the separator can, and the broken
    // query gets the right answer by accident. The suite failed at 00:10 UTC on
    // a tree where nothing about scheduling had been touched, and passed again
    // five minutes later — which is the shape of every assertion that reads the
    // clock rather than being handed one.
    const sqlNow = db.prepare("SELECT datetime('now') AS v").get().v;
    check("datetime('now') renders a space where an ISO stamp has a T",
        !sqlNow.includes('T'), sqlNow);
    check("...so the old comparison misses a card due earlier the same day",
        !('2026-09-03T10:00:00.000Z' <= '2026-09-03 11:19:30'));

    check('NOW_ISO renders the same shape as Date.toISOString()',
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
            db.prepare(`SELECT ${NOW_ISO} AS v`).get().v));

    // The column the ladder needs, and its backfill. An existing collection is
    // entirely New or Review, so 0 is the truth for every pre-existing row
    // rather than a guess.
    const cols = db.prepare('PRAGMA table_info(flashcards)').all().map(c => c.name);
    check('flashcards carry the (re)learning ladder rung', cols.includes('learning_steps'));
    check('an existing card backfills to rung 0, not NULL',
        db.prepare('SELECT learning_steps FROM flashcards WHERE id = ?').get(dueCard).learning_steps === 0);
}

// ---- 2. the fit --------------------------------------------------------------
console.log('\n--- optimiser: synthetic learner ---');
// Deterministic PRNG (mulberry32) so the gate is repeatable.
let seed = 0x9e3779b9;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// The true learner: forgets faster and finds material harder than the default.
const W_TRUE = [...DEFAULT_W];
W_TRUE[0] *= 0.6; W_TRUE[1] *= 0.6; W_TRUE[2] *= 0.6; W_TRUE[3] *= 0.6;   // initial stabilities lower
W_TRUE[4] += 1.0;                                                         // initial difficulty higher
W_TRUE[8] *= 0.7;                                                         // recall gains smaller
W_TRUE[20] = 0.25;                                                        // steeper decay
const truth = new FSRSAlgorithm(generatorParameters({ w: W_TRUE, enable_fuzz: false, enable_short_term: false }));
const schedulerDefault = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }));

function simulate(cards, reviewsPerCard) {
    const out = [];
    let t = Date.parse('2025-01-01T00:00:00Z');
    for (let c = 0; c < cards; c++) {
        const startDay = Math.floor(rnd() * 200);
        let when = new Date(t + startDay * DAY);
        let card = createEmptyCard(when);
        let mem = null;
        const reviews = [];
        for (let i = 0; i < reviewsPerCard; i++) {
            const day = Math.round((when.getTime() - t) / DAY);
            const elapsed = reviews.length ? day - reviews[reviews.length - 1].day : 0;
            let rating;
            if (!mem) rating = rnd() < 0.15 ? 1 : rnd() < 0.8 ? 3 : 4;
            else {
                const r = truth.forgetting_curve(elapsed, mem.stability);
                rating = rnd() < r ? (rnd() < 0.15 ? 2 : rnd() < 0.85 ? 3 : 4) : 1;
            }
            reviews.push({ t: when.getTime(), day, elapsed, rating });
            mem = mem ? truth.next_state(mem, elapsed, rating) : truth.next_state(null, 0, rating);
            // Scheduled by the DEFAULT parameters, like a learner who has not optimised yet.
            card = schedulerDefault.next(card, when, rating).card;
            when = new Date(when.getTime() + Math.max(1, card.scheduled_days) * DAY);
        }
        out.push({ cardId: c + 1, reviews });
    }
    return out;
}

const small = simulate(20, 4);
const tooFew = fit(small, { steps: 5 });
check(`refuses to fit below ${MIN_FIT_REVIEWS} predicted reviews, and says so`,
    tooFew.accepted === false && /at least/.test(tooFew.reason) && tooFew.stats.trainReviews < MIN_FIT_REVIEWS, tooFew.reason);
check('...and hands back the defaults untouched', tooFew.w.every((v, i) => v === DEFAULT_W[i]));

const data = simulate(300, 9);
const predicted = data.reduce((a, s) => a + s.reviews.length - 1, 0);
console.log(`        synthetic log: ${data.length} cards, ${predicted} predicted reviews`);
const truthLoss = evaluate(W_TRUE, data).loss;
const defaultLoss = evaluate(DEFAULT_W, data).loss;
check('the true parameters explain the synthetic reviews better than the defaults (the fixture is honest)',
    truthLoss < defaultLoss, `truth ${truthLoss.toFixed(4)} vs default ${defaultLoss.toFixed(4)}`);
const cutoff = holdoutCutoff(data);
check('the hold-out cutoff splits predicted reviews ~80/20 by date', (() => {
    const a = evaluate(DEFAULT_W, data, { to: cutoff }).n, b = evaluate(DEFAULT_W, data, { from: cutoff }).n;
    return b / (a + b) > 0.12 && b / (a + b) < 0.28;
})());

const t0f = Date.now();
const result = fit(data, { steps: 80, patience: 15 });
const ms = Date.now() - t0f;
console.log(`        fit: ${result.stats.steps} steps in ${ms} ms; train ${result.stats.trainDefault.toFixed(4)} → ${result.stats.trainFitted.toFixed(4)}, val ${result.stats.valDefault.toFixed(4)} → ${result.stats.valFitted.toFixed(4)}`);
check('the fit is accepted: it beats the defaults on held-out reviews', result.accepted === true, result.reason || '');
check('...and on the reviews it fitted', result.stats.trainFitted < result.stats.trainDefault);
check('the fitted vector is valid and inside ts-fsrs bounds', isValidW(result.w) && result.w.every((v, i) => v === clipW(result.w)[i]));
check('the fit moved the parameters the learner differs on in the right direction (decay steeper than default)',
    result.w[20] > DEFAULT_W[20], `${result.w[20]} vs ${DEFAULT_W[20]}`);
check('fitted loss over all data lies between the defaults and the truth (no overfitting past the generating model)',
    (() => { const l = evaluate(result.w, data).loss; return l < defaultLoss && l >= truthLoss - 0.02; })());
check('the whole fit finishes in a reasonable time for a gate', ms < 120_000, `${ms} ms`);

// ---- retention calibration ---------------------------------------------------
console.log('\n--- retention report ---');
{
    const { retentionReport } = await import('../server/fsrsOptimizer.js');
    const rep = retentionReport(W_TRUE, data);
    check('counts every predicted review once', rep.reviews === predicted && rep.bins.reduce((a, b) => a + b.n, 0) === predicted, `${rep.reviews} vs ${predicted}`);
    check('observed retention is a share in [0,1] and equals recalled/reviews', rep.observed >= 0 && rep.observed <= 1 && Math.abs(rep.observed - rep.recalled / rep.reviews) < 1e-12);
    const big = rep.bins.filter(b => b.n >= 100);
    check('under the TRUE parameters the well-populated bins are calibrated (|predicted − observed| < 0.1)',
        big.length >= 2 && big.every(b => Math.abs(b.predicted - b.observed) < 0.1),
        big.map(b => `${b.predicted.toFixed(2)}/${b.observed.toFixed(2)}(${b.n})`).join(' '));
    const repDefault = retentionReport(DEFAULT_W, data);
    check('under the DEFAULT parameters this learner is over-promised (expected > observed) — the readout says so',
        repDefault.expected > repDefault.observed, `${repDefault.expected.toFixed(3)} vs ${repDefault.observed.toFixed(3)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }
process.exit(fail ? 1 : 0);
