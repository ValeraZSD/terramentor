// tools/srs-gates.mjs — checks the flashcard scheduler behaves like a scheduler.
//
// Run:  node tools/srs-gates.mjs
//
// Why this exists: scheduling is the one subsystem whose bugs are invisible for
// months. A wrong interval does not throw, does not look wrong on screen, and
// does not show up in any count — it just quietly reviews things at the wrong
// time until retention drops, by which point the cause is a hundred sessions
// back. The algorithm itself is `ts-fsrs`'s (we do not own it and do not test
// it); what is asserted here is the part we DO own:
//
//   1. the wiring — that ratings map to the intervals they should, in order;
//   2. the migrations, which are one-way doors: SM-2 → FSRS and FSRS-6 → FSRS-7.
//      If either resets cards instead of seeding them, an entire collection
//      lands back in today's queue and the learner's history is gone. The
//      FSRS-7 seed is checked against ts-fsrs's own curve, not against itself;
//   3. the (re)learning ladder — that "Again" schedules MINUTES and keeps the
//      card in the session, and that a rung is persisted so the ladder is not
//      restarted on reload;
//   4. the derived 0-5 `difficulty`, which the dashboard's weak-card metric is
//      defined against;
//   5. a fitted vector: only a 34-weight FSRS-7 one inside the model's bounds
//      is used, and an FSRS-6 one falls back to the defaults.
//
// Deterministic by construction: fuzz is off in the scheduler config, so the
// same card and rating always produce the same interval. Bundles the real
// TypeScript module with esbuild (same trick as the atlas label gates) so this
// tests the shipped code rather than a copy of it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'srs-gates-'));
const out = join(scratch, 'srs.mjs');
const entry = new URL('../src/utils/srs.ts', import.meta.url);

await esbuild.build({
    // fileURLToPath, never `.pathname` — this repo's path contains a space,
    // which stays percent-encoded in a URL and esbuild cannot resolve it.
    entryPoints: [fileURLToPath(entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
});

const srs = await import(pathToFileURL(out).href);
const {
    computeSrsUpdate, computeNextInterval, formatInterval, appDifficultyFromFsrs,
    REQUEST_RETENTION, DEFAULT_EASE, SRS_STATE_FIELDS, srsSnapshot,
    requeueAt, isInLearning, CARD_STATE, LEARNING_STEPS, RELEARNING_STEPS,
    retentionVerdict, MIN_VERDICT_REVIEWS, VERDICT_BAND,
    configureSrs, memoryStateOf, FSRS_WEIGHT_COUNT,
} = srs;

// The yardstick for the seed: ts-fsrs's own FSRS-7 curve at the default weights.
const m7 = await import('ts-fsrs/models/fsrs-7');
const curve7 = new m7.FSRS7Algorithm([...m7.FSRS7_DEFAULT_WEIGHTS], m7.FSRS7_MODEL_BOUNDS);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
// A gate must not crash on the code it is testing: a throw is a FAIL, not an exit.
const tryOr = (fn, fallback) => { try { return fn(); } catch (e) { return fallback ?? e; } };

const NOW = new Date('2026-06-01T09:00:00Z');
const DAY = 86_400_000;
const RATINGS = ['again', 'hard', 'good', 'easy'];
const NEW_CARD = {};
const days = (c, r, now = NOW) => computeNextInterval(c, r, now).intervalDays;

// ---- a brand-new card -------------------------------------------------------
console.log('\n--- a new card ---');
const fresh = Object.fromEntries(RATINGS.map(r => [r, days(NEW_CARD, r)]));
const mins = (c, r, now = NOW) => days(c, r, now) * 1440;
console.log(`        intervals: ${RATINGS.map(r => `${r}=${formatInterval(fresh[r])}`).join('  ')}`);
// A new card walks the learning ladder before it earns a day-scale interval:
// 1m / 6m / 10m, then Easy graduates it straight out.
check('Again on a new card is a minute, not a day',
    Math.round(mins(NEW_CARD, 'again')) === 1, `${mins(NEW_CARD, 'again')}m`);
check('Good on a new card is the second learning rung',
    Math.round(mins(NEW_CARD, 'good')) === 10, `${mins(NEW_CARD, 'good')}m`);
check('Easy graduates a new card straight to a whole number of days',
    fresh.easy >= 1 && Number.isInteger(fresh.easy), `${fresh.easy}d`);
check('the three ladder ratings leave the card in Learning',
    ['again', 'hard', 'good'].every(r => computeNextInterval(NEW_CARD, r, NOW).state === CARD_STATE.learning));
check('Easy leaves it in Review',
    computeNextInterval(NEW_CARD, 'easy', NOW).state === CARD_STATE.review);
check('intervals increase with the rating',
    fresh.again <= fresh.hard && fresh.hard <= fresh.good && fresh.good <= fresh.easy,
    JSON.stringify(fresh));
check('easy is strictly better than again', fresh.easy > fresh.again);
check('nothing is NaN or infinite',
    RATINGS.every(r => Number.isFinite(fresh[r])));
check('a new card gets both FSRS-7 traces on its first review',
    RATINGS.every(r => { const u = computeSrsUpdate(NEW_CARD, r, NOW); return u.stability > 0 && u.stability_fast > 0; }),
    JSON.stringify(computeSrsUpdate(NEW_CARD, 'good', NOW)));

// ---- a card already under FSRS-7 --------------------------------------------
console.log('\n--- a card already under FSRS-7 ---');
const mature = {
    stability: 30, stability_fast: 3, fsrs_difficulty: 5, state: 2, lapses: 0,
    last_interval: 30, review_count: 6,
    last_reviewed: '2026-05-02T09:00:00Z', next_review: '2026-06-01T09:00:00Z',
};
const m = Object.fromEntries(RATINGS.map(r => [r, days(mature, r)]));
console.log(`        intervals: ${RATINGS.map(r => `${r}=${formatInterval(m[r])}`).join('  ')}`);
check('its state is READ from the columns, not seeded',
    tryOr(() => { const s = memoryStateOf(mature); return s.seeded === false && s.memory.stability === 30 && s.memory.stabilityFast === 3 && s.memory.difficulty === 5; }, false));
check('a good review extends a mature card well beyond its last interval',
    m.good > mature.last_interval, `${m.good}d vs ${mature.last_interval}d`);
check('a lapse collapses the interval', m.again < mature.last_interval, `${m.again}d`);
check('ordering holds on a mature card too',
    m.again <= m.hard && m.hard <= m.good && m.good <= m.easy, JSON.stringify(m));

const upd = computeSrsUpdate(mature, 'good', NOW);
check('a review advances stability', upd.stability > mature.stability, `${upd.stability}`);
check('a review writes the fast trace', Number.isFinite(upd.stability_fast) && upd.stability_fast > 0, `${upd.stability_fast}`);
// FSRS-7 schedules in fractional days; the app keeps a day-scale review on a
// whole number of days, so the card comes due at the time of day it was
// reviewed and `last_interval` stays the integer its readers expect.
check('a day-scale review lands a whole number of days after now, to the millisecond',
    Date.parse(upd.next_review) - NOW.getTime() === upd.last_interval * DAY && Number.isInteger(upd.last_interval),
    `${upd.next_review}, ${upd.last_interval}d`);
check('the hint under the button shows the date the rating writes',
    upd.next_review === computeNextInterval(mature, 'good', NOW).dueAt.toISOString());
check('last_reviewed is stamped at the review time', upd.last_reviewed === NOW.toISOString());
check('a successful review records no lapse', upd.lapses === mature.lapses);
check('a failed review records one', computeSrsUpdate(mature, 'again', NOW).lapses === mature.lapses + 1);
check('the card stays in a reviewing state', upd.state >= 1 && upd.state <= 3, String(upd.state));

// A harder card must not be scheduled further out than an easier one.
const easyCard = { ...mature, fsrs_difficulty: 2 };
const hardCard = { ...mature, fsrs_difficulty: 9 };
check('a harder card is scheduled sooner than an easier one at equal stability',
    days(hardCard, 'good') < days(easyCard, 'good'),
    `hard ${days(hardCard, 'good')}d vs easy ${days(easyCard, 'good')}d`);

// Stability is what drives the interval — double it, the interval must grow.
check('more stability means a longer interval',
    days({ ...mature, stability: 60 }, 'good') > days({ ...mature, stability: 30 }, 'good'));

// ---- the FSRS-6 → FSRS-7 seed (the second one-way door) ---------------------
//
// A card last scheduled by FSRS-6 has `stability` and no `stability_fast`.
// FSRS-6 stability IS the day recall falls to 90%, so the seed is right when
// FSRS-7's own curve puts the 90% day on exactly that day: the card's next
// review is where it was, and nothing about its schedule moved.
console.log('\n--- a card scheduled by FSRS-6 ---');
const REAL = {
    stability: 4.46945539, fsrs_difficulty: 6.74045952, state: 2, lapses: 0,
    last_interval: 4, review_count: 2,
    last_reviewed: '2026-08-26T22:53:36.286Z', next_review: '2026-08-30T22:53:36.286Z',
};
const REAL_NOW = new Date('2026-09-03T10:53:36.286Z');
const seeded = tryOr(() => memoryStateOf(REAL), null);
check('a card with FSRS-6 stability and no fast trace is SEEDED', seeded?.seeded === true, JSON.stringify(seeded));
const ninety = (memory) => tryOr(() => curve7.next_interval(memory, 0.9), NaN);
check('its 90% day under ts-fsrs FSRS-7 is its FSRS-6 stability',
    seeded && Math.abs(ninety(seeded.memory) / REAL.stability - 1) < 1e-6,
    seeded ? `${ninety(seeded.memory)} vs ${REAL.stability}` : 'no seed');
check('its difficulty is carried over unchanged', seeded?.memory?.difficulty === REAL.fsrs_difficulty);
{
    let worst = 0, where = '';
    for (const S of [10 / 1440, 0.5, 1, 4, 30, 365, 3650]) for (const D of [1, 5, 10]) {
        const s = tryOr(() => memoryStateOf({ stability: S, fsrs_difficulty: D, state: 2, review_count: 3 }), null);
        const err = s ? Math.abs(ninety(s.memory) / S - 1) : Infinity;
        if (!(err <= worst)) { worst = err; where = `S ${S}, D ${D}`; }
    }
    check('the seed keeps the 90% day from ten minutes to ten years, at every difficulty',
        worst < 1e-6, `worst ${worst} at ${where}`);
}
// The card measured in the live library: FSRS-6 scheduled it Hard 12 / Good 16 /
// Easy 27 days on this date. FSRS-7 shapes the curve differently, so Hard and
// Easy move; Good, the rating most reviews get, lands on the same day.
const realDays = Object.fromEntries(RATINGS.map(r => [r, days(REAL, r, REAL_NOW)]));
check('the measured card schedules 8 / 16 / 24 days (FSRS-6: 12 / 16 / 27)',
    realDays.hard === 8 && realDays.good === 16 && realDays.easy === 24, JSON.stringify(realDays));
check('its first FSRS-7 review writes a real fast trace, so the next read is not a seed',
    tryOr(() => {
        const u = computeSrsUpdate(REAL, 'good', REAL_NOW);
        return memoryStateOf({ ...REAL, ...u }).seeded === false;
    }, false));

// ---- the SM-2 migration (the first one-way door) ----------------------------
console.log('\n--- migrating a collection built under SM-2 ---');
const sm2 = {
    stability: null, fsrs_difficulty: null, state: null, lapses: null,
    ease_factor: 2.5, last_interval: 45, difficulty: 1, review_count: 9,
    last_reviewed: '2026-04-17T09:00:00Z', next_review: '2026-06-01T09:00:00Z',
};
const migrated = computeSrsUpdate(sm2, 'good', NOW);
check('an SM-2 card is NOT reset to a new card',
    migrated.last_interval > 10, `${migrated.last_interval}d — a reset would be minutes`);
check('its earned interval becomes its 90% day',
    tryOr(() => Math.abs(ninety(memoryStateOf(sm2).memory) / sm2.last_interval - 1) < 1e-6, false));
check('the migrated card lands in a reviewing state', migrated.state >= 1);
check('a low ease migrates to a high FSRS difficulty',
    computeSrsUpdate({ ...sm2, ease_factor: 1.3 }, 'good', NOW).fsrs_difficulty >
    computeSrsUpdate({ ...sm2, ease_factor: 2.5 }, 'good', NOW).fsrs_difficulty);
check('a never-reviewed card with no history IS treated as new',
    days({ stability: null, review_count: 0, last_reviewed: null }, 'good') === fresh.good);
check('migration does not depend on a legacy ease being present',
    Number.isFinite(computeSrsUpdate({ ...sm2, ease_factor: undefined }, 'good', NOW).stability));

// An Anki import that keeps the schedule writes the SM-2 columns and leaves
// `state` at its column default, 0 (server/ankiImport.js). Read as New, Good on
// a card Anki had out at 122 days put it on a 10-minute learning step.
console.log('\n--- an Anki card imported with its schedule ---');
const imported = {
    stability: null, state: 0, lapses: 1, ease_factor: 2.5, last_interval: 122, review_count: 7,
    last_reviewed: '2026-05-20T09:00:00Z', next_review: '2026-09-19T09:00:00Z',
};
const impGood = computeSrsUpdate(imported, 'good', NOW);
check('Good keeps it on a day-scale interval, not a learning step',
    impGood.state === CARD_STATE.review && impGood.last_interval > 100, `state ${impGood.state}, ${impGood.last_interval}d`);
check('Again is a lapse into Relearning, not a first step into Learning',
    tryOr(() => { const u = computeSrsUpdate(imported, 'again', NOW); return u.state === CARD_STATE.relearning && u.lapses === imported.lapses + 1; }, false),
    JSON.stringify(tryOr(() => computeSrsUpdate(imported, 'again', NOW), {})));

// ---- the (re)learning ladder ------------------------------------------------
console.log('\n--- the (re)learning ladder ---');

check('the ladders are the ones the labels describe',
    LEARNING_STEPS.join(',') === '1m,10m' && RELEARNING_STEPS.join(',') === '10m',
    `${LEARNING_STEPS} / ${RELEARNING_STEPS}`);

const lapse = computeSrsUpdate(mature, 'again', NOW);
const lapseMin = (new Date(lapse.next_review) - NOW) / 60000;
check('Again on a mature card schedules MINUTES, not a day',
    Math.round(lapseMin) === 10, `${lapseMin}m`);
check('...and puts it in Relearning', lapse.state === CARD_STATE.relearning, String(lapse.state));
check('a relearning card reports itself as in learning', isInLearning(lapse.state));
check('a sub-day step records last_interval 0, the "learning" reading', lapse.last_interval === 0, String(lapse.last_interval));
check('requeueAt hands the session the moment the card is due again',
    requeueAt(lapse) === Date.parse(lapse.next_review));
check('a day-scale review is NOT requeued into the session', requeueAt(upd) === null);

// The ladder rung has to survive the round trip through the database, or the
// card restarts the ladder on every rating and can never graduate.
const onLadder = { ...mature, ...lapse, review_count: 7 };
check('the rung is persisted on the update', typeof lapse.learning_steps === 'number');
const climbed = computeSrsUpdate(onLadder, 'good', new Date(NOW.getTime() + 10 * 60000));
check('Good from the relearning rung graduates to a day-scale interval',
    climbed.state === CARD_STATE.review && climbed.last_interval >= 1,
    `state ${climbed.state}, ${climbed.last_interval}d`);
check('Again from the relearning rung stays on the ladder',
    isInLearning(computeSrsUpdate(onLadder, 'again', NOW).state));

// A rung read back as 0 is a different card to FSRS. This is the assertion that
// would have caught `toFsrsCard` hardcoding it.
const newAgain = computeSrsUpdate({}, 'again', NOW);
const rung0 = computeSrsUpdate({ ...newAgain, review_count: 1, learning_steps: 0 }, 'good', NOW);
const rung1 = computeSrsUpdate({ ...newAgain, review_count: 1, learning_steps: 1 }, 'good', NOW);
check('the stored rung changes what Good does',
    rung0.state !== rung1.state || rung0.last_interval !== rung1.last_interval,
    `rung0 -> state ${rung0.state}/${rung0.last_interval}d, rung1 -> state ${rung1.state}/${rung1.last_interval}d`);
// The model may NOT stretch a step: ts-fsrs's FSRS-7 default lets it, which
// would make "<10m" under the button a promise the card does not keep.
check('a ladder step is the configured step, whatever the model would prefer',
    Math.round((Date.parse(rung0.next_review) - NOW.getTime()) / 60000) === 10,
    rung0.next_review);

// The one thing no rating may ever do is schedule a card in the past.
const fragile = { stability: 0.05, fsrs_difficulty: 10, state: 3, lapses: 8, last_interval: 1, review_count: 20, last_reviewed: '2026-05-31T09:00:00Z' };
check('no rating ever schedules a card in the past',
    RATINGS.every(r => days(fragile, r) > 0 && days(NEW_CARD, r) > 0 && days(mature, r) > 0));
check('every interval is finite', RATINGS.every(r => Number.isFinite(days(fragile, r))));

// ---- the derived display difficulty ----------------------------------------
console.log('\n--- the 0-5 difficulty the dashboard reads ---');
check('FSRS 1 maps to the easiest end', appDifficultyFromFsrs(1) === 0);
check('FSRS 10 maps to the hardest end', appDifficultyFromFsrs(10) === 5);
check('the mapping is monotone',
    [1, 3, 5, 7, 10].every((d, i, a) => i === 0 || appDifficultyFromFsrs(d) >= appDifficultyFromFsrs(a[i - 1])));
check('it always lands inside the app scale',
    Array.from({ length: 100 }, (_, i) => 1 + i * 0.09)
        .every(d => { const v = appDifficultyFromFsrs(d); return Number.isInteger(v) && v >= 0 && v <= 5; }));
check('an out-of-range value is clamped, not propagated',
    appDifficultyFromFsrs(-5) === 0 && appDifficultyFromFsrs(99) === 5);
check('a repeatedly-failed card reads as weak to the dashboard',
    computeSrsUpdate({ ...mature, fsrs_difficulty: 9 }, 'again', NOW).difficulty >= 3);

// ---- config sanity ----------------------------------------------------------
console.log('\n--- configuration ---');
check('the retention target is a probability', REQUEST_RETENTION > 0.5 && REQUEST_RETENTION < 1);
// Fuzz off, asserted as the VALUES rather than by comparing a call with itself
// (which held for any implementation, fuzzed or not — ts-fsrs seeds its fuzz
// from the card, so even a fuzzed scheduler is self-consistent). These are
// ts-fsrs's own FSRS-7 intervals for `mature` at the default weights (61.86 /
// 135.68 / 228.97 days), rounded to whole days; with fuzz on, at least one of
// the three would move.
check('fuzz is off: a mature card schedules its exact unfuzzed intervals',
    m.hard === 62 && m.good === 136 && m.easy === 229, JSON.stringify(m));
check('the legacy SM-2 ease default is still exported for migration', DEFAULT_EASE === 2.5);

// ---- a fitted parameter vector ----------------------------------------------
//
// `configureSrs` takes the `fsrs_params` setting on every settings load. A vector
// fitted for FSRS-6 has 21 weights and means nothing to FSRS-7 (ts-fsrs: "FSRS-7
// requires its own weights"); it must fall back to the defaults, never be padded.
console.log('\n--- a fitted parameter vector ---');
{
    const W = [...m7.FSRS7_DEFAULT_WEIGHTS];
    const goodOf = () => tryOr(() => days(mature, 'good'), NaN);
    check('an FSRS-7 vector has 34 weights', FSRS_WEIGHT_COUNT === 34 && W.length === 34);
    tryOr(() => configureSrs({ w: W.map((v, i) => (i === 7 ? v * 1.2 : v)) }));
    const tuned = goodOf();
    check('a valid 34-weight vector changes the schedule', tuned !== m.good && Number.isFinite(tuned), `${tuned}d vs ${m.good}d`);
    tryOr(() => configureSrs({ w: new Array(21).fill(0.5) }));
    check('a 21-weight FSRS-6 vector falls back to the defaults', goodOf() === m.good, `${goodOf()}d`);
    tryOr(() => configureSrs({ w: W.map((v, i) => (i === 3 ? NaN : v)) }));
    check('a vector with a NaN falls back to the defaults', goodOf() === m.good, `${goodOf()}d`);
    tryOr(() => configureSrs({ w: W.map(() => -5) }));
    check('a vector outside the model bounds falls back, and no review throws',
        goodOf() === m.good && RATINGS.every(r => Number.isFinite(tryOr(() => days(mature, r), NaN))), `${goodOf()}d`);
    tryOr(() => configureSrs({ w: null }));
    check('null puts the defaults back', goodOf() === m.good);
}

// ---- interval labels --------------------------------------------------------
console.log('\n--- labels ---');
check('days', formatInterval(3) === '3d');
check('days stay days up to a month', formatInterval(14) === '14d' && formatInterval(29) === '29d');
check('months', formatInterval(60) === '2mo');
check('years', formatInterval(400) === '1.1y');
// The bug this replaced: Hard 12d and Good 16d both printed "2w", so the two
// buttons a learner is choosing between showed the same number. Any two
// intervals a rating pair can produce inside a month must stay distinguishable.
check('a label distinguishes intervals a day apart under a month',
    formatInterval(12) !== formatInterval(16) && formatInterval(12) === '12d' && formatInterval(16) === '16d');
check('coarse units keep a decimal when they need one',
    formatInterval(45) === '1.5mo' && formatInterval(30) === '1mo');
// The ladder made the bottom of the scale reachable: a 1m / 6m / 10m step
// printed "1d" under every rating while the queue handed the card straight
// back, which is the label contradicting the behaviour on screen.
// Anki's notation, for Anki's reason: a ladder step is the LONGEST the card can
// wait, not the wait itself, because the learn-ahead limit serves it as soon as
// nothing else is left. The bare number reads as a computed interval, which is
// what made "Again is always 10 minutes" look like a bug rather than a step.
check('a ladder step reads as AT MOST n minutes',
    formatInterval(1 / 1440) === '<1m' && formatInterval(10 / 1440) === '<10m'
    && formatInterval(6 / 1440) === '<6m');
check('the real ladder intervals all print that way',
    ['again', 'hard', 'good'].every(r => /^<\d+m$/.test(formatInterval(days(NEW_CARD, r)))),
    ['again', 'hard', 'good'].map(r => formatInterval(days(NEW_CARD, r))).join(' '));
check('hours exist between minutes and days, and hedge the same way',
    formatInterval(1 / 24) === '<1h' && formatInterval(0.5) === '<12h');
// A day-scale interval is a real date the scheduler picked and nothing serves
// it early, so it keeps the bare number.
check('a whole day is still a day, not 24h, and carries no "<"', formatInterval(1) === '1d');
check('nothing day-scale or longer is hedged',
    [3, 14, 29, 45, 400].every(d => !formatInterval(d).startsWith('<')),
    [3, 14, 29, 45, 400].map(d => formatInterval(d)).join(' '));
// The units are `t` keys: given a translator they come out of it, and every
// interpolated number is a string, so a locale's separator is its own business.
const fakeT = (key, { n }) => key.replace('{{n}}', `[${n}]`);
check('with a translator, every unit goes through it',
    [1 / 1440, 1 / 24, 17, 45, 400].map(d => formatInterval(d, fakeT)).join(' ') === '<[1]m <[1]h [17]d [1.5]mo [1.1]y',
    [1 / 1440, 1 / 24, 17, 45, 400].map(d => formatInterval(d, fakeT)).join(' '));

// ---- undo: the snapshot must cover everything a review writes ---------------
//
// A rating reaches the server the moment it is pressed, so taking one back is a
// RESTORE. If `computeSrsUpdate` learns to write a field that `srsSnapshot`
// does not carry, undo silently only half-works — the card comes back with a
// schedule that is part old and part new, and nothing anywhere would say so.
// These are the assertions that keep the two lists in step.
console.log('\n--- undo snapshot ---');
{
    const card = {
        difficulty: 2, last_reviewed: '2026-08-28T00:00:00.000Z', next_review: '2026-08-30T00:00:00.000Z',
        review_count: 1, ease_factor: 2.5, last_interval: 2,
        stability: 1.2931, stability_fast: 0.8412, fsrs_difficulty: 5.112, state: 2, lapses: 0,
        learning_steps: 0,
    };
    const written = Object.keys(computeSrsUpdate(card, 'good', new Date('2026-08-31T00:00:00Z')));
    // `rating` is the review's own datum (logged server-side, never a card
    // column), so it is the one written key the snapshot is not expected to hold.
    const missing = written.filter(k => k !== 'rating' && !SRS_STATE_FIELDS.includes(k));
    check('every field a review writes is in the undo snapshot', missing.length === 0, missing.join(','));
    check('review_count is snapshotted too (the endpoint bumps it on last_reviewed)',
        SRS_STATE_FIELDS.includes('review_count'));
    // Undo of a card's FIRST FSRS-7 review must put the fast trace back to NULL,
    // or the card comes back half FSRS-7: its FSRS-6 stability with a fast trace
    // from a review that was taken back.
    check('the fast trace is snapshotted', SRS_STATE_FIELDS.includes('stability_fast'));

    const snap = srsSnapshot(card);
    check('the snapshot round-trips a reviewed card exactly',
        SRS_STATE_FIELDS.every(k => snap[k] === card[k]));

    // A brand-new card holds NULLs. The update endpoint writes any field that is
    // not `undefined`, so an OMITTED key would leave the post-review value in
    // place — explicit nulls are what put a new card back to genuinely new.
    const fresh = srsSnapshot({ difficulty: 0, review_count: 0, ease_factor: 2.5, last_interval: 0, lapses: 0, state: 0 });
    check('a never-reviewed card snapshots explicit nulls, never undefined',
        SRS_STATE_FIELDS.every(k => fresh[k] !== undefined)
        && fresh.last_reviewed === null && fresh.stability === null && fresh.stability_fast === null
        && fresh.next_review === null);

    // The undo names the review it takes back by the stamp that rating wrote,
    // so the endpoint can refuse it once the card has been rated since.
    const update = computeSrsUpdate(card, 'good', new Date('2026-08-31T00:00:00Z'));
    const named = srsSnapshot(card, update.last_reviewed);
    check('the snapshot names the review it undoes', named.undo_review === true && named.undo_of === '2026-08-31T00:00:00.000Z', String(named.undo_of));
    check('and names none when not told (the old request shape)', !('undo_of' in snap));
}

// --- the retention verdict --------------------------------------------------
//
// The settings panel answers "is that good?" in words rather than leaving three
// percentages side by side. The words are chosen by one function, so what is
// asserted is that every branch is reachable, that the two ends cannot swap,
// and that a thin sample earns no verdict at all — a panel confidently telling
// someone their review gaps are too long on a dozen reviews is worse than one
// saying nothing.
console.log('\n--- retention verdict ---');
{
    const T = REQUEST_RETENTION;
    check('a thin sample gets no verdict, however extreme it looks',
        retentionVerdict(1, MIN_VERDICT_REVIEWS - 1) === 'thin'
        && retentionVerdict(0, MIN_VERDICT_REVIEWS - 1) === 'thin');
    check('no observed value at all is thin, not on-track',
        retentionVerdict(null, 500) === 'thin' && retentionVerdict(undefined, 500) === 'thin'
        && retentionVerdict(NaN, 500) === 'thin');
    check('recalling well above the target reads as ahead', retentionVerdict(0.99, 83) === 'ahead');
    check('recalling well below the target reads as behind', retentionVerdict(0.75, 83) === 'behind');
    check('hitting the target exactly reads as on-track', retentionVerdict(T, 83) === 'on-track');
    check('the band is symmetric and inclusive at its edges',
        retentionVerdict(T + VERDICT_BAND, 83) === 'ahead'
        && retentionVerdict(T - VERDICT_BAND, 83) === 'behind'
        && retentionVerdict(T + VERDICT_BAND / 2, 83) === 'on-track'
        && retentionVerdict(T - VERDICT_BAND / 2, 83) === 'on-track');
    check('the sample floor is the only thing between a real value and a verdict',
        retentionVerdict(0.99, MIN_VERDICT_REVIEWS) === 'ahead'
        && retentionVerdict(0.99, MIN_VERDICT_REVIEWS - 1) === 'thin');
    // The direction is the whole point: "ahead" must mean remembering MORE.
    check('ahead is the high side, behind the low side',
        retentionVerdict(T + 0.2, 100) === 'ahead' && retentionVerdict(T - 0.2, 100) === 'behind');
}

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { }
process.exit(fail ? 1 : 0);
