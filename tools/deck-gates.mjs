#!/usr/bin/env node
/**
 * Deterministic gates for the deck path: how a card collection is cut into
 * stages, and how its daily counters are computed.
 *
 * No model, no network, and the DB half runs against a throwaway file — so this
 * is runnable on any machine at any time, which is the only kind of guard worth
 * having for arithmetic that decides what a learner is shown.
 *
 *   node tools/deck-gates.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'deck-gates-'));
process.env.DB_PATH = join(scratch, 'gates.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const {
    planStages, chooseStageSize, compareCards, tagStructure, prettyTag, cardState,
    MIN_SPLIT, TARGET_STAGES, MATURE_DAYS,
} = await import('../server/deckStructure.js');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; return; }
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
    check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const deck = (n, extra = () => ({})) =>
    Array.from({ length: n }, (_, i) => ({ order: i + 3, noteId: 1000 + i, ...extra(i) }));

// ---- stage size -------------------------------------------------------------

eq('a deck under the split floor gets no stages', chooseStageSize(MIN_SPLIT - 1), null);
check('the floor itself splits', chooseStageSize(MIN_SPLIT) !== null);
eq('a small deck uses the smallest round size', chooseStageSize(100), 25);
eq('a real 1,501-card deck lands on 50', chooseStageSize(1501), 50);
check('a huge deck never returns null', chooseStageSize(200000) !== null);
for (const n of [60, 100, 300, 1000, 1501, 5000]) {
    const size = chooseStageSize(n);
    check(`stage count for ${n} is inside the target band`,
        Math.ceil(n / size) <= TARGET_STAGES.max, `${Math.ceil(n / size)} stages of ${size}`);
}

// ---- planStages: the invariants that matter ---------------------------------

for (const n of [59, 60, 100, 999, 1500, 1501, 1520, 4321]) {
    const stages = planStages(deck(n), { deckName: 'D' });
    if (n < MIN_SPLIT) {
        eq(`${n} cards stay whole`, stages.length, 0);
        continue;
    }
    const total = stages.reduce((a, s) => a + s.cards.length, 0);
    eq(`every card lands in exactly one stage (${n})`, total, n);
    const ids = new Set(stages.flatMap(s => s.cards.map(c => c.noteId)));
    eq(`no card is duplicated across stages (${n})`, ids.size, n);
    check(`stage positions are 0..k-1 (${n})`,
        stages.every((s, i) => s.position === i));
    check(`no stage is empty (${n})`, stages.every(s => s.cards.length > 0));
    // The runt rule: a trailing stage smaller than 40% of the stage size is
    // folded back, because "Stage 31" holding one card reads as a bug.
    const size = chooseStageSize(n);
    const last = stages[stages.length - 1].cards.length;
    check(`no runt trailing stage (${n})`, stages.length === 1 || last >= size * 0.4,
        `last stage holds ${last} of a ${size}-card stage`);
}

{
    const stages = planStages(deck(1501), { deckName: 'Core 2k' });
    eq('1,501 cards cut into 30 stages', stages.length, 30);
    eq('the first stage is named for its position', stages[0].title, 'Stage 1');
    check('a stage says what is in it', stages[0].description.includes('Cards 1–50'));
    check('the deck name travels into the description',
        stages[0].description.includes('Core 2k'));
    eq('the runt is folded into the last stage', stages[29].cards.length, 51);
    // Order is the whole claim: stage 1 must hold the cards the deck puts first.
    eq('stage 1 starts at the deck s first card', stages[0].cards[0].noteId, 1000);
    eq('stage 2 continues where stage 1 stopped', stages[1].cards[0].noteId, 1050);
}

// ---- ordering ---------------------------------------------------------------

{
    const a = { order: 5, noteId: 900 };
    const b = { order: 9, noteId: 100 };
    check('queue position beats note id', compareCards(a, b) < 0);
    const studied = { order: null, noteId: 500 };
    check('a studied card (no queue position) sorts before an unstudied one',
        compareCards(studied, a) < 0);
    const s1 = { order: null, noteId: 10 };
    const s2 = { order: null, noteId: 20 };
    check('two studied cards fall back to creation order', compareCards(s1, s2) < 0);
    eq('comparison is stable for identical cards', compareCards(a, { ...a }), 0);
}

{
    // A deck handed to us in a shuffled array must still come out in ITS order.
    const cards = deck(200);
    const shuffled = [...cards].sort(() => Math.random() - 0.5);
    const stages = planStages(shuffled, { deckName: 'D' });
    const flat = stages.flatMap(s => s.cards.map(c => c.order));
    check('shuffled input is restored to deck order',
        flat.every((v, i) => i === 0 || v > flat[i - 1]));
}

// ---- tags -------------------------------------------------------------------

eq('no tags means no tag structure', tagStructure(deck(100, () => ({ tags: [] }))), null);
eq('a single tag on everything is a label, not a structure',
    tagStructure(deck(100, () => ({ tags: ['vocab'] }))), null);
eq('one tag per card is not a structure either',
    tagStructure(deck(100, i => ({ tags: [`w${i}`] }))), null);
check('a real scheme is found',
    (tagStructure(deck(120, i => ({ tags: [`Level::L${5 - (i % 3)}`] }))) || []).length === 3);
eq('Anki s own markers are ignored',
    tagStructure(deck(100, () => ({ tags: ['marked', 'leech'] }))), null);
{
    // Half-tagged is below the coverage floor: falling back to order is better
    // than a tree where half the deck lives in "Untagged".
    const half = deck(100, i => ({ tags: i < 50 ? ['unit-1'] : [] }));
    eq('a half-tagged deck falls back to order', tagStructure(half), null);
}
{
    const stages = planStages(deck(300, i => ({ tags: [`unit_${(i % 4) + 1}`] })), { deckName: 'D' });
    eq('a tagged deck becomes one stage per tag', stages.length, 4);
    eq('tags are titled for reading', stages[0].title, 'Unit 1');
    eq('every card still lands somewhere',
        stages.reduce((a, s) => a + s.cards.length, 0), 300);
}
{
    // Mostly tagged: the leftovers are still taught, and they say what they are.
    const mostly = deck(200, i => ({ tags: i < 180 ? [`unit-${(i % 3) + 1}`] : [] }));
    const stages = planStages(mostly, { deckName: 'D' });
    check('the untagged remainder gets its own stage',
        stages.some(s => s.title === 'Untagged'));
    eq('and nothing is lost', stages.reduce((a, s) => a + s.cards.length, 0), 200);
}
eq('a nested tag is titled by its leaf', prettyTag('Level::L5'), 'L5');
eq('separators become spaces', prettyTag('unit_07'), 'Unit 07');

// ---- card states ------------------------------------------------------------

eq('an unreviewed card is new', cardState({ review_count: 0 }), 'new');
eq('review_count without a timestamp is still new',
    cardState({ review_count: 3, last_reviewed: null }), 'new');
eq('a sub-day interval is learning',
    cardState({ review_count: 1, last_reviewed: 'x', last_interval: 0 }), 'learning');
eq('a one-day interval is young',
    cardState({ review_count: 2, last_reviewed: 'x', last_interval: 1 }), 'young');
eq('the day before the mature threshold is young',
    cardState({ review_count: 9, last_reviewed: 'x', last_interval: MATURE_DAYS - 1 }), 'young');
eq('the threshold itself is mature',
    cardState({ review_count: 9, last_reviewed: 'x', last_interval: MATURE_DAYS }), 'mature');
eq('Anki s mature threshold is 21 days', MATURE_DAYS, 21);

// ---- the counters, against a real database ----------------------------------

const db = (await import('../server/database.js')).default;
const deckApi = await import('../server/decks.js');

const projectId = db.prepare(
    "INSERT INTO projects (name, kind, position) VALUES ('Gate deck', 'deck', 0)"
).run().lastInsertRowid;
const stageA = db.prepare(
    "INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, 'Stage 1', 0)"
).run(projectId).lastInsertRowid;
const stageB = db.prepare(
    "INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, 'Stage 2', 1)"
).run(projectId).lastInsertRowid;

/**
 * The instant this whole fixture stands on.
 *
 * Every stamp below — due dates, birthdays, the review log — is measured from
 * here, and every call into `server/decks.js` is handed the same instant
 * (`decks` below binds it), so the suite asserts the arithmetic and never the
 * hour it happened to run at.
 *
 * `iso(0.01)` — "due later today", fourteen minutes past `Date.now()` — was the
 * counter-example. Inside the last quarter hour before UTC midnight those
 * fourteen minutes land on TOMORROW: the forecast's first bucket loses the
 * card and `overdue reviews are folded into today` fails with "expected 3, got
 * 2". Nothing under test changed, only the clock. Seen 2026-09-14 at 23:56 UTC,
 * green again four minutes later. A suite that passes 143 of the day's 144
 * ten-minute windows reads as flaky, and the next person deletes the assertion
 * instead of the clock dependency.
 *
 * Mid-day by default. `DECK_GATES_NOW` takes any ISO instant, so the edges of
 * the day are exercised deliberately rather than waited for:
 *
 *   DECK_GATES_NOW=2026-09-15T23:59:59.000Z node tools/deck-gates.mjs
 */
const NOW = new Date(process.env.DECK_GATES_NOW || '2026-06-11T12:00:00.000Z');
if (Number.isNaN(NOW.getTime())) {
    console.error(`\n  DECK_GATES_NOW is not an instant: ${JSON.stringify(process.env.DECK_GATES_NOW)}\n`);
    process.exit(2);
}

/** A whole number of days from the pinned instant. UTC has no DST, so an integer
 *  offset is exactly that many UTC days away whatever hour NOW is. */
const iso = (offsetDays) => new Date(NOW.getTime() + offsetDays * 86400000).toISOString();

/** `created_at` is filled by `CURRENT_TIMESTAMP` in the real schema, which
 *  SQLite renders as UTC 'YYYY-MM-DD HH:MM:SS'. The fixture writes birthdays in
 *  that shape, not ISO, or it would be storing a format the app never does. */
const born = (daysAgo) => iso(-daysAgo).replace('T', ' ').slice(0, 19);

// `bornDaysAgo` is how many days ago the card row was created. `stability` is
// what a review performed in THIS app writes (FSRS) and what the importer leaves
// NULL: a card that arrived today carrying Anki review history was not
// introduced today, it was introduced months ago in Anki — see the note on
// `introducedToday`.
const addCard = (nodeId, { reps = 0, interval = null, reviewed = null, due = null, lapses = 0, bornDaysAgo = 30, stability = null }) =>
    db.prepare(`
        INSERT INTO flashcards (node_id, front, back, difficulty, review_count, last_interval,
                                last_reviewed, next_review, lapses, created_at, stability)
        VALUES (?, 'q', 'a', 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(nodeId, reps, interval, reviewed, due, lapses, born(bornDaysAgo), stability).lastInsertRowid;

/**
 * "Due later today": the midpoint between the pinned instant and the last
 * millisecond of its UTC day.
 *
 * Strictly after NOW, so the card is not yet owed; strictly inside the pinned
 * day, so the forecast's first bucket keeps it — both at EVERY hour, which a
 * fixed offset of fourteen minutes is not. The one instant it cannot be said
 * from is the day's final millisecond, where "later today" does not exist.
 */
const END_OF_PINNED_DAY = Date.UTC(
    NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), 23, 59, 59, 999);
const LATER_TODAY = Math.ceil((NOW.getTime() + END_OF_PINNED_DAY) / 2);
if (LATER_TODAY <= NOW.getTime()) {
    console.error(`\n  DECK_GATES_NOW leaves no room for "later today": ${NOW.toISOString()}\n`);
    process.exit(2);
}
const laterToday = () => new Date(LATER_TODAY).toISOString();

/**
 * The deck API with the pinned instant already bound.
 *
 * Every entry point here takes `now`, so binding it once means no call site
 * below can forget it and a new one cannot quietly reintroduce the machine's
 * clock. Pass `now` explicitly to overrule it.
 */
const decks = {
    ...deckApi,
    deckCounts: (id, o = {}) => deckApi.deckCounts(id, { now: NOW, ...o }),
    deckStages: (id, o = {}) => deckApi.deckStages(id, { now: NOW, ...o }),
    studyQueue: (id, o = {}) => deckApi.studyQueue(id, { now: NOW, ...o }),
    deckForecast: (id, o = {}) => deckApi.deckForecast(id, { now: NOW, ...o }),
    buildDeckData: (id, o = {}) => deckApi.buildDeckData(id, { now: NOW, ...o }),
};

// An assertion rather than a comment, because the regression it prevents is
// invisible in 143 of the day's 144 ten-minute windows: a `Date.now()` slipped
// back into this fixture passes every run except the ones nobody is watching.
// A relative instant is still fine — it is derived from NOW.
{
    const src = readFileSync(new URL(import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')    // the notes above name `Date.now()` on purpose
        .replace(/\/\/.*$/gm, '');
    const clocks = [/\bDate\.now\s*\(\s*\)/, /new Date\s*\(\s*\)/, /\bdate(?:time)?\s*\(\s*'now'/];
    const found = clocks.filter((re) => re.test(src));
    check('the fixture reads no clock but the pinned one', found.length === 0,
        found.map(String).join(' '));
}

/**
 * One review, as the endpoint actually records it: a row in `review_log`.
 *
 * The log row is not bookkeeping this fixture can skip. `introducedToday` is
 * derived from it, because it is the only place that knows what STATE a card
 * was in when it was answered — and "was it new when I first met it today" is
 * the whole question. `stateBefore` is FSRS's own: 0 new, 1 learning, 2 review,
 * 3 relearning.
 */
const addReview = (cardId, { stateBefore = 0, at = iso(0), rating = 3 } = {}) =>
    db.prepare(`
        INSERT INTO review_log (card_id, reviewed_at, rating, state_before, source)
        VALUES (?, ?, ?, ?, 'app')
    `).run(cardId, at, rating, stateBefore);

for (let i = 0; i < 10; i++) addCard(stageA, {});                                   // 10 new
addReview(addCard(stageA, { reps: 1, interval: 0, reviewed: iso(0), due: laterToday(), stability: 0.4 })); // learning, reviewed here
addCard(stageA, { reps: 3, interval: 5, reviewed: iso(-5), due: iso(-1) });         // young, due
addCard(stageB, { reps: 9, interval: 40, reviewed: iso(-40), due: iso(3), lapses: 2 }); // mature, later
addCard(stageB, { reps: 9, interval: 30, reviewed: iso(-30), due: iso(-2) });       // mature, due
for (let i = 0; i < 5; i++) addCard(stageB, {});                                    // 5 new

{
    const c = decks.deckCounts(projectId);
    eq('every card is counted once', c.totals.cards, 19);
    eq('new cards are counted', c.totals.new, 15);
    eq('learning cards are counted', c.totals.learning, 1);
    // The 5-day card is young; the two 30+ day cards are mature.
    eq('young cards are counted', c.totals.young, 1);
    eq('mature cards are counted', c.totals.mature, 2);
    eq('the four states add up to the total',
        c.totals.new + c.totals.learning + c.totals.young + c.totals.mature, c.totals.cards);
    // The whole point: 15 never-seen cards are NOT "due".
    eq('never-seen cards are not counted as due', c.dueReviews, 2);
    eq('cards met is the complement of new', c.seen, 4);
    eq('studied cards are counted', c.reviewed, 4);
    eq('lapsed cards are counted', c.lapsed, 1);
    eq('the default daily allowance is Anki s 20', c.newPerDay, decks.DEFAULT_NEW_PER_DAY);
    eq('new cards offered today are capped by the allowance', c.newAvailable, 15);
}

{
    decks.setNewPerDay(projectId, 5);
    const c = decks.deckCounts(projectId);
    eq('the per-project allowance is honoured', c.newPerDay, 5);
    // One card was first reviewed today, so it has already spent an allowance
    // slot — the limit is per DAY, not per session, which is the property that
    // makes it mean anything.
    eq('and it caps what is offered, minus what today already used', c.newAvailable, 4);
    check('one card was recorded as introduced today', decks.deckCounts(projectId).introducedToday === 1);
    decks.setNewPerDay(projectId, 0);
    eq('an allowance of zero offers no new cards', decks.deckCounts(projectId).newAvailable, 0);
    decks.setNewPerDay(projectId, -3);
    eq('a negative allowance is clamped to zero', decks.deckCounts(projectId).newPerDay, 0);
    decks.setNewPerDay(projectId, 20);
}

{
    const q = decks.studyQueue(projectId);
    eq('the queue serves the reviews that are owed', q.reviews.length, 2);
    eq('and new cards up to the allowance', q.fresh.length, 15);
    check('reviews come out oldest-due first',
        String(q.reviews[0].next_review) <= String(q.reviews[1].next_review));
    check('new cards come out in stage order',
        q.fresh[0].node_id === stageA && q.fresh[q.fresh.length - 1].node_id === stageB);
    const limited = decks.studyQueue(projectId, { newLimit: 3 });
    eq('an explicit limit overrides the allowance', limited.fresh.length, 3);
    eq('and never affects the reviews owed', limited.reviews.length, 2);

    // The live bug: the day's new cards are taken in deck order, so they all
    // come from the stage the learner is on — filtering that finished queue by
    // any LATER stage left nothing, and pressing Play on a stage opened an
    // empty session. Narrowing has to happen before the allowance is applied.
    const later = decks.studyQueue(projectId, { stageId: stageB });
    check('a later stage s own session is not empty', later.fresh.length > 0,
        `got ${later.fresh.length} new cards for stage B`);
    check('and holds only that stage s cards',
        [...later.fresh, ...later.reviews].every(c => c.node_id === stageB));
    eq('a stage session still serves that stage s due reviews', later.reviews.length, 1);
    const first = decks.studyQueue(projectId, { stageId: stageA });
    check('the current stage s own session works too', first.fresh.length > 0);
    check('and is likewise scoped',
        [...first.fresh, ...first.reviews].every(c => c.node_id === stageA));

    // "Study ahead" was a button that did nothing. It asked for the ORDINARY
    // queue, whose new-card allowance is whatever is left of today's — so once
    // the day was spent the session opened empty, which is exactly the state a
    // learner presses it in. It has to overrule both halves of the rationing.
    const spent = decks.studyQueue(projectId, { newLimit: 0 });
    eq('with the day s allowance spent, the normal queue offers no new cards',
        spent.fresh.length, 0);

    const ahead = decks.studyQueue(projectId, { aheadDays: 14 });
    check('an ahead session refills the new-card allowance', ahead.fresh.length > 0,
        `got ${ahead.fresh.length} new cards`);
    check('and pulls not-yet-due reviews forward',
        ahead.reviews.length > q.reviews.length,
        `ahead ${ahead.reviews.length} vs normal ${q.reviews.length}`);
    check('every card it pulls forward is genuinely in the deck',
        [...ahead.fresh, ...ahead.reviews].every(c => c.node_id === stageA || c.node_id === stageB));

    // The horizon has to MEAN something: a shorter reach pulls fewer cards.
    const near = decks.studyQueue(projectId, { aheadDays: 1 });
    check('a shorter horizon reaches fewer reviews than a longer one',
        near.reviews.length <= ahead.reviews.length,
        `1d ${near.reviews.length} vs 14d ${ahead.reviews.length}`);

    // And none of it may change the default. This is the guard that matters:
    // studying ahead is a deliberate session, never a new baseline.
    const again = decks.studyQueue(projectId);
    eq('the default queue is untouched by any of this (reviews)', again.reviews.length, q.reviews.length);
    eq('the default queue is untouched by any of this (new)', again.fresh.length, q.fresh.length);
}

{
    const f = decks.deckForecast(projectId, { days: 14 });
    eq('the forecast has one bucket per day', f.days.length, 14);
    // Two cards are overdue and one is due later today; the overdue pair lands
    // on today rather than falling off the left edge and vanishing.
    eq('overdue reviews are folded into today', f.days[0], 3);
    eq('a card due in three days lands there', f.days[3], 1);
    eq('nothing is invented beyond the window', f.beyond, 0);
    const total = f.days.reduce((a, b) => a + b, 0) + f.beyond;
    eq('every scheduled card appears exactly once', total, 4);
}

{
    const stages = decks.deckStages(projectId);
    eq('both stages are listed', stages.length, 2);
    eq('stage 1 counts its cards', stages[0].cards, 12);
    eq('stage 1 counts what has been met', stages[0].seen, 2);
    eq('stage 1 counts what is due', stages[0].due, 1);
    eq('stage 2 counts its new cards', stages[1].newCards, 5);
    const data = decks.buildDeckData(projectId);
    eq('the current stage is the first with new cards', data.currentStageId, stageA);
    eq('the deck payload carries the stages', data.stages.length, 2);

    // The per-stage breakdown and the per-card map are what the stage bar and
    // its ticks are drawn from, so they have to agree with the roll-ups beside
    // them — a figure that disagrees with the number printed under it is worse
    // than no figure.
    eq('a stage breaks its cards into the four states',
        stages[0].states.new + stages[0].states.learning + stages[0].states.young + stages[0].states.mature,
        stages[0].cards);
    eq('the breakdown agrees with the new count', stages[0].states.new, stages[0].newCards);
    eq('and with the mature count', stages[0].states.mature, stages[0].mature);
    eq('the state totals are the sum of the stages',
        stages.reduce((a, s) => a + s.states.mature, 0), data.totals.mature);
    eq('a small stage ships one map character per card', stages[0].map.length, stages[0].cards);
    check('every map character is a known state',
        stages.every(s => !s.map || [...s.map].every(ch => 'nlym'.includes(ch))));
    eq('the map agrees with the breakdown',
        [...stages[0].map].filter(ch => ch === 'n').length, stages[0].states.new);
}

{
    // Above the map cap a stage ships counts only. An absent map is the
    // client's signal to draw the stacked bar; it must never be an empty string,
    // which would draw an empty row of ticks over a stage full of cards.
    const bigId = db.prepare(
        "INSERT INTO projects (name, kind, position) VALUES ('Big', 'deck', 2)"
    ).run().lastInsertRowid;
    const bigStage = db.prepare(
        "INSERT INTO nodes (project_id, title, position) VALUES (?, 'Core', 0)"
    ).run(bigId).lastInsertRowid;
    for (let i = 0; i < 300; i++) {
        db.prepare('INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, ?)')
            .run(bigStage, `q${i}`, `a${i}`);
    }
    const [big] = decks.deckStages(bigId);
    eq('an oversized stage still counts its cards', big.cards, 300);
    check('and still breaks them into states', big.states.new === 300);
    check('but ships no per-card map', big.map === undefined);
}

{
    // A container node (a deck holding stages, owning no cards itself) is not a
    // row on the ladder — its stages are.
    const parent = db.prepare(
        "INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, 'Sub deck', 2)"
    ).run(projectId).lastInsertRowid;
    const child = db.prepare(
        "INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, ?, 'Stage 1', 0)"
    ).run(projectId, parent).lastInsertRowid;
    addCard(child, {});
    const stages = decks.deckStages(projectId);
    check('a card-less container is not listed as a stage',
        !stages.some(s => s.nodeId === parent));
    const nested = stages.find(s => s.nodeId === child);
    check('a nested stage is listed', !!nested);
    eq('and it says which deck it belongs to', nested?.parentTitle, 'Sub deck');
}

{
    // An empty deck must produce a page, not a crash or a NaN.
    const emptyId = db.prepare(
        "INSERT INTO projects (name, kind, position) VALUES ('Empty', 'deck', 1)"
    ).run().lastInsertRowid;
    const data = decks.buildDeckData(emptyId);
    eq('an empty deck has no cards', data.totals.cards, 0);
    eq('nothing is due in it', data.dueReviews, 0);
    eq('it offers no new cards', data.newAvailable, 0);
    eq('it has no stages', data.stages.length, 0);
    eq('and no current stage', data.currentStageId, null);
    eq('a deck that does not exist answers null', decks.buildDeckData(999999), null);
}

{
    // The import-day regression, found by importing a real deck rather
    // than by any assertion: cards that arrive carrying Anki history are stamped
    // as reviewed at the moment of import, and were counting against the day's
    // new-card allowance despite having been first studied months ago elsewhere.
    const impId = db.prepare(
        "INSERT INTO projects (name, kind, position) VALUES ('Fresh import', 'deck', 2)"
    ).run().lastInsertRowid;
    const impStage = db.prepare(
        "INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, 'Stage 1', 0)"
    ).run(impId).lastInsertRowid;
    for (let i = 0; i < 30; i++) addCard(impStage, { bornDaysAgo: 0 });
    // Seven arrived with exactly one Anki review, stamped as of the import.
    for (let i = 0; i < 7; i++) {
        addCard(impStage, { reps: 1, interval: 9, reviewed: iso(0), due: iso(9), bornDaysAgo: 0 });
    }
    const c = decks.deckCounts(impId);
    eq('an import does not spend the day it lands on', c.introducedToday, 0);
    eq('so the full allowance is offered on day one', c.newAvailable, decks.DEFAULT_NEW_PER_DAY);
    eq('and the imported history still counts as met', c.seen, 7);
    // The same sitting: two of the new cards are studied in this app. They were
    // born today too, so a clause keyed on `created_at` could not see them and
    // the deck went on offering the full twenty after every session.
    const studied = db.prepare(
        'SELECT id FROM flashcards WHERE node_id = ? AND review_count = 0 LIMIT 2'
    ).all(impStage);
    for (const { id } of studied) {
        db.prepare(`UPDATE flashcards SET review_count = 1, last_reviewed = ?, next_review = ?,
                    stability = 1.3, state = 2 WHERE id = ?`).run(iso(0), iso(2), id);
    }
    for (const { id } of studied) addReview(id, { stateBefore: 0 });
    const c2 = decks.deckCounts(impId);
    eq('cards studied here on import day are counted as introduced', c2.introducedToday, 2);
    eq('and the day s allowance shrinks by them', c2.newAvailable, decks.DEFAULT_NEW_PER_DAY - 2);

    // ---- a card met more than once today is still ONE card met -------------
    // The (re)learning ladder made a new card the normal case for being
    // answered several times in one sitting: rated Good it walks 1m -> 10m
    // before it graduates, so it ends the day on review_count = 2. The old
    // `review_count = 1` rule therefore stopped seeing exactly the cards that
    // were learned most thoroughly, handed their allowance slots back, and
    // offered them again the moment the session closed.
    const ladder = db.prepare(
        'SELECT id FROM flashcards WHERE node_id = ? AND review_count = 0 LIMIT 1'
    ).get(impStage).id;
    db.prepare(`UPDATE flashcards SET review_count = 2, last_reviewed = ?, next_review = ?,
                stability = 2.3, state = 2 WHERE id = ?`).run(iso(0), iso(3), ladder);
    addReview(ladder, { stateBefore: 0, rating: 1 });   // Again, from new
    addReview(ladder, { stateBefore: 3 });              // ten minutes later, graduating
    const c3 = decks.deckCounts(impId);
    eq('a card answered twice today counts once, not zero', c3.introducedToday, 3);
    eq('and it spends exactly one allowance slot', c3.newAvailable, decks.DEFAULT_NEW_PER_DAY - 3);

    // A card that was already in review before today is not "met today" however
    // many times it comes round — that is the review budget, not the new one.
    const old = db.prepare(
        'SELECT id FROM flashcards WHERE node_id = ? AND review_count = 1 LIMIT 1'
    ).get(impStage).id;
    addReview(old, { stateBefore: 2 });
    eq('a review of an already-known card spends no new-card slot',
        decks.deckCounts(impId).introducedToday, 3);

    // Anki's own revlog rides in the same table under source='anki'. A card
    // first studied months ago elsewhere was not introduced here, whatever
    // date its imported history carries.
    db.prepare(`INSERT INTO review_log (card_id, reviewed_at, rating, state_before, source, external_id)
                VALUES (?, ?, 3, 0, 'anki', 'x1')`).run(old, iso(0));
    eq('an imported Anki review never counts as introduced here',
        decks.deckCounts(impId).introducedToday, 3);
}

try { db.close(); } catch { }
rmSync(scratch, { recursive: true, force: true });

// ---- the figure's arithmetic -------------------------------------------------
// `tickPlan` and `blockFloor` decide whether a stage row is legible, and the
// failure they prevent only appears at a width no desktop has — so they are
// plain functions in `deckFigure.ts` and asserted here rather than eyeballed.
{
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createRequire } = await import('node:module');
    const { pathToFileURL, fileURLToPath } = await import('node:url');
    const require = createRequire(import.meta.url);
    const esbuild = require('esbuild');

    const scratch = mkdtempSync(join(tmpdir(), 'deck-figure-'));
    const out = join(scratch, 'figure.mjs');
    await esbuild.build({
        // fileURLToPath, never `.pathname` — this repo's path contains a space.
        entryPoints: [fileURLToPath(new URL('../src/components/deck/deckFigure.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    });
    const fig = await import(pathToFileURL(out).href);
    rmSync(scratch, { recursive: true, force: true });

    const { tickPlan, blockFloor, stripGap, MIN_TICK, MAX_MIN_BLOCK } = fig;

    // Measured widths from the running app: a stage row is 716px on a 1100px
    // desktop and 234px on a 390px phone.
    const DESK = 716, PHONE = 234;

    check('a 50-card stage draws ticks on a desktop', !!tickPlan(DESK, 50));
    check('and still draws ticks on a phone', !!tickPlan(PHONE, 50));
    eq('a roomy row gets the wider gap', tickPlan(DESK, 50).gap, 2);
    check('a tight row gives up the gap before it gives up the ticks',
        tickPlan(PHONE, 43).gap === 1, `got gap ${tickPlan(PHONE, 43)?.gap}`);

    // The complaint that produced this: a real deck's Spoken/Web rows.
    check('an 86-card stage draws ticks on a desktop', !!tickPlan(DESK, 86));
    check('but falls back to the bar on a phone', tickPlan(PHONE, 86) === null);
    check('a 103-card stage does the same', !!tickPlan(DESK, 103) && tickPlan(PHONE, 103) === null);

    check('no plan ever draws a tick under the legibility floor',
        [234, 300, 480, 716, 1000].every(w =>
            [1, 4, 7, 9, 13, 31, 43, 50, 86, 103, 240].every(n => {
                const p = tickPlan(w, n);
                return p === null || p.tick >= MIN_TICK;
            })));
    check('and no plan ever overflows its row',
        [234, 300, 716].every(w =>
            [4, 43, 86, 240].every(n => {
                const p = tickPlan(w, n);
                return p === null || p.tick * n + p.gap * (n - 1) <= w + 0.01;
            })));
    check('an unmeasured row falls back to the bar rather than guessing',
        tickPlan(0, 50) === null);
    eq('so does a stage with no cards', tickPlan(DESK, 0), null);

    // The strip: a stage worth 2 of 521 cards must still show its green.
    const STRIP_DESK = 716, STRIP_PHONE = 300;
    eq('a roomy strip floors a block at the full minimum',
        blockFloor(STRIP_DESK, 27, 2), MAX_MIN_BLOCK);
    check('a 2px segment inside a floored block is visible',
        Math.min(3, blockFloor(STRIP_DESK, 27, 2)) >= 3);
    check('a floored strip never overflows the space it was measured in',
        [200, 300, 480, 716].every(w =>
            [2, 6, 27, 30, 60, 120, 240].every(n => {
                const gap = stripGap(w, n);
                return blockFloor(w, n, gap) * n + gap * (n - 1) <= w;
            })));
    eq('a roomy strip keeps the full gap', stripGap(716, 27), 2);
    check('a crowded one spends the gap before the blocks', stripGap(300, 120) === 1);
    check('and gives it up entirely when the gaps alone would not fit',
        stripGap(200, 240) === 0);
    check('a deck cut too fine to draw gets hairlines, not an overflow',
        blockFloor(STRIP_PHONE, 120, 1) < MAX_MIN_BLOCK);
    eq('an unmeasured strip keeps the old default', blockFloor(0, 27, 2), 4);
}


const total = pass + failures.length;
if (failures.length) {
    console.log(`\n  ${failures.length} of ${total} deck assertions FAILED:\n`);
    for (const f of failures) console.log(`   ✗ ${f}`);
    process.exit(1);
}
console.log(`\n  ✓ ${pass} deck assertions passed (no model, no network).\n`);
