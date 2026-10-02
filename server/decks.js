// server/decks.js — what a card collection needs to be asked, and answered.
//
// ## Why a deck gets its own screen at all
//
// Every dashboard in this app answers a curriculum's questions: how far through
// the syllabus am I, what is scheduled today, which topics have I proven. Point
// those at an imported deck and every one of them returns something true and
// useless — a real 1,501-card import rendered "0% complete" over a
// denominator of 1, a "Your Journey" bar reading 0/1, "No tasks scheduled for
// today", and "No Quizzes Yet", while 1,483 cards sat due in a tile at the
// bottom of the page. Nothing there was wrong. It was all answering questions
// nobody with a deck is asking.
//
// A deck's questions are Anki's, because that is where the deck came from and
// what its owner already thinks in: how many are new, how many have I actually
// learned, how many come back today, what is coming this week, and how much is
// still ahead of me.
//
// ## The number that was a lie by omission
//
// "1,483 cards due" was the headline, and 1,465 of those had never been seen —
// `flashcards/due` treats `next_review IS NULL` as due, which is right for a
// handful of AI-written cards on a topic and catastrophic for a 1,500-card
// import: it is not a queue, it is the whole deck, and a learner opening it is
// told they are 1,483 cards behind on the day they arrive. Anki's answer is a
// DAILY NEW LIMIT, and it is the single mechanic that makes a big deck
// studiable, so it is here too: reviews are what is actually due, new cards
// arrive at a rate, and the two are counted separately because they are
// different work.
//
// Everything in this module is SQL over rows that already exist. No model, no
// background job, no new table.

import db, { NOW_ISO } from './database.js';
import { cardState, MATURE_DAYS } from './deckStructure.js';

/** Anki's own default, and the right one: 20 new cards a day is ~10 minutes. */
export const DEFAULT_NEW_PER_DAY = 20;

const settingKey = (projectId) => `deck_new_per_day_${projectId}`;

const readSetting = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value ?? null;
};

/**
 * The daily new-card allowance for a project authored HERE, when nobody has set
 * one. Mirrors `FEED_DEFAULTS.newCardsPerProjectPerDay` in server/feed.js, which
 * cannot be imported (feed.js imports this module); `tools/role-gates.mjs`
 * asserts the two are equal, so the mirror cannot drift silently.
 */
export const AUTHORED_NEW_PER_DAY = 10;

/**
 * How many new cards this project may introduce per day.
 *
 * Per project first, then a global default the learner can move once, then a
 * default that depends on where the cards came from: Anki's 20 for an imported
 * collection (its owner arrived with an opinion about this number and a deck is
 * the case the limit was invented for), the feed's own dial for a project whose
 * cards were written here a handful at a time.
 *
 * ONE function, because the home feed and the project's own screen must not
 * ration the same cards differently — which they did while the feed asked this
 * only for imports and used its own setting for everything else.
 *
 * Stored in the existing kv `settings` table under a per-project key, the same
 * shape `bulk_avg_ms_*` already uses.
 */
export function getNewPerDay(projectId) {
    const raw = readSetting(settingKey(projectId)) ?? readSetting('deck_new_per_day');
    const n = Number.parseInt(raw ?? '', 10);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, 9999);
    return defaultNewPerDay(projectId);
}

function defaultNewPerDay(projectId) {
    // `projects.kind` survives as PROVENANCE only (see server/nodeRole.js):
    // 'deck' means "arrived as an Anki import", which is exactly the question
    // being asked here.
    const imported = db.prepare(
        "SELECT COALESCE(kind, 'curriculum') AS kind FROM projects WHERE id = ?"
    ).get(projectId)?.kind === 'deck';
    if (imported) return DEFAULT_NEW_PER_DAY;
    const raw = readSetting('feed_new_per_project');
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : AUTHORED_NEW_PER_DAY;
}

export function setNewPerDay(projectId, value) {
    const n = Math.max(0, Math.min(9999, Number.parseInt(value, 10) || 0));
    db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(settingKey(projectId), String(n));
    return n;
}

/**
 * SQL: is this card's review OWED — scheduled for a moment that has passed?
 *
 * The one definition of "due" in the app, and it deliberately excludes a card
 * that has never been seen. `(next_review <= now OR next_review IS NULL)` was
 * written into six different counters and two endpoints, and it is the same
 * mistake every time: an unseen card is not work you are behind on, it is work
 * available to start, and how much of it a day may start is the ration below.
 * Left in place it tells a learner with a fresh 615-card project that they are
 * 615 cards behind on the day they wrote them.
 *
 * Takes the alias so a caller with `flashcards f` and one with a bare table
 * cannot drift apart on which column they meant.
 */
export const reviewDue = (alias = 'f') =>
    `${alias}.next_review IS NOT NULL AND ${alias}.next_review <= ${NOW_ISO}`;

const CARD_COLUMNS = `
    f.id, f.node_id, f.review_count, f.last_reviewed, f.last_interval, f.next_review, f.lapses
`;

/**
 * Every card in the project with just enough to classify it.
 *
 * One query and one pass rather than five COUNT(*)s with five slightly
 * different WHERE clauses — five clauses is five chances for the dashboard's
 * own numbers to stop adding up to its total, which is the specific way a
 * statistics screen loses trust.
 */
function loadCards(projectId) {
    // Ordered by id, which for an imported deck IS the deck's own order — the
    // importer writes cards in the order Anki's new-card queue holds them, and
    // that ordering is the author's difficulty gradient (see deckStructure.js).
    // Nothing above cared until the stage map: a row of ticks is only readable
    // as "the front of this stage is green" if the ticks are in deck order.
    return db.prepare(`
        SELECT ${CARD_COLUMNS}
        FROM flashcards f
        JOIN nodes n ON n.id = f.node_id
        WHERE n.project_id = ?
        ORDER BY f.id
    `).all(projectId);
}

const isDueNow = (card, nowIso) => !!card.next_review && card.next_review <= nowIso;

/**
 * The daily counters Anki draws at the top of a deck.
 *
 * `introducedToday` is read from the review log, which is what makes the limit
 * honest across sessions rather than resetting every time the screen is opened.
 */
export function deckCounts(projectId, { now = new Date() } = {}) {
    const nowIso = now.toISOString();
    const cards = loadCards(projectId);
    const totals = { cards: cards.length, new: 0, learning: 0, young: 0, mature: 0 };
    let dueReviews = 0;
    let reviewed = 0, lapsed = 0;

    for (const c of cards) {
        const state = cardState(c);
        totals[state]++;
        if (state !== 'new' && isDueNow(c, nowIso)) dueReviews++;
        if (c.review_count > 0) {
            reviewed++;
            if ((Number(c.lapses) || 0) > 0) lapsed++;
        }
    }

    // How many cards stopped being new today — the number the daily allowance
    // is spent against, so it has to count CARDS MET, never answers given.
    //
    // It cannot be derived from the card row (`review_count = 1`, reviewed
    // today, `stability IS NOT NULL`): every clause there is a workaround for
    // not having a review log, and the (re)learning ladder breaks it in the
    // worst possible direction. A new card rated Good walks 1m → 10m before it
    // graduates, so it finishes the day on `review_count = 2` and drops OUT of
    // the count: the more thoroughly a card is learned, the less it counts,
    // and a learner who finished every ladder is handed a fresh twenty the
    // moment they close the session. Measured on a real deck: 22 cards
    // genuinely met, 20 counted, the missing two being exactly the two
    // answered more than once.
    //
    // There IS a review log now (server/reviewLog.js), and it is the only place
    // that knows what state a card was in when it was answered. `state_before =
    // 0` is FSRS's New, so one row per card per day is "met today", however
    // many answers followed it — hence COUNT(DISTINCT).
    //
    // `source = 'app'` is what separates a real answer from the import stamp.
    // The importer stamps `last_reviewed` as the moment of import for every card
    // that arrived with Anki history (that stamp is what `next_review = now +
    // interval` is measured from — a grace period, rather than dumping three
    // years of cards into today's queue), and it brings Anki's own revlog in
    // under `source = 'anki'`. A card first met months ago elsewhere is not
    // introduced here today, whatever date its imported history carries.
    const introducedToday = db.prepare(`
        SELECT COUNT(DISTINCT r.card_id) AS n
        FROM review_log r
        JOIN flashcards f ON f.id = r.card_id
        JOIN nodes n ON n.id = f.node_id
        WHERE n.project_id = ?
          AND r.source = 'app'
          AND r.state_before = 0
          AND date(r.reviewed_at) = date(?)
    `).get(projectId, nowIso).n;

    const perDay = getNewPerDay(projectId);
    const newRemaining = Math.max(0, perDay - introducedToday);

    return {
        totals,
        dueReviews,
        newAvailable: Math.min(totals.new, newRemaining),
        newRemaining,
        newPerDay: perDay,
        introducedToday,
        // Deliberately NOT called "retention". True retention is the share of
        // REVIEWS answered correctly, which needs a review log, and this app has
        // none — so the honest quantity is how many studied cards have ever been
        // forgotten, reported next to how many have been studied at all. The
        // project dashboard's existing "100% retention" over 26 touched cards of
        // 1,501 is what happens when a ratio is shown without its denominator.
        reviewed,
        lapsed,
        // Everything that has ever been introduced. This is the honest
        // "progress" for a deck: not topics completed, but cards that have
        // stopped being strangers.
        seen: totals.cards - totals.new,
    };
}

/**
 * What is coming, day by day.
 *
 * Anki's forecast is the one chart that changes behaviour: it is how a learner
 * finds out that saying "Easy" to everything today builds a wall three weeks
 * out. Bucketed by the UTC DATE via SQLite's `date()` — the same day boundary
 * the rest of the app counts by — and clamped at day 0 so an overdue backlog
 * lands on "today" instead of falling off the left edge and quietly
 * disappearing from the total.
 *
 * `now` is injectable for the same reason it is on `deckCounts`, `deckStages`
 * and `studyQueue`: a fixture that cannot say which day it is standing on can
 * only assert what the clock happens to make true, and `date('now')` read the
 * machine's clock even when every card in the fixture was placed relative to a
 * pinned instant. Nothing in the app passes it.
 */
export function deckForecast(projectId, { days = 14, now = new Date() } = {}) {
    const rows = db.prepare(`
        SELECT CAST(julianday(date(f.next_review)) - julianday(date(?)) AS INTEGER) AS offset,
               COUNT(*) AS n
        FROM flashcards f
        JOIN nodes n ON n.id = f.node_id
        WHERE n.project_id = ? AND f.next_review IS NOT NULL AND f.review_count > 0
        GROUP BY offset
    `).all(now.toISOString(), projectId);   // the SELECT's `?` binds first

    const buckets = new Array(days).fill(0);
    let beyond = 0;
    for (const r of rows) {
        const o = Number(r.offset);
        if (!Number.isFinite(o)) continue;
        if (o < 0) buckets[0] += r.n;
        else if (o < days) buckets[o] += r.n;
        else beyond += r.n;
    }
    return { days: buckets, beyond };
}

/** How many cards a stage may hold and still ship a per-card map. Above this a
 *  row of ticks stops being readable as individual cards, and the payload stops
 *  being free: one real frequency deck cuts into six stages of up to 2,004
 *  cards, which would be 5,168 characters of texture nothing can read. */
const MAP_MAX = 240;

const STATE_CHAR = { new: 'n', learning: 'l', young: 'y', mature: 'm' };

/**
 * The stages, with the only per-stage numbers worth drawing.
 *
 * A stage is an ordinary node — the feed, mastery and the checkpoint machinery
 * all treat it as a topic — so this adds nothing to the data model. It answers
 * "where am I in the deck", which the tree of empty category cards could not.
 *
 * A stage's parent title travels with it because a multi-deck import nests
 * (`Grammar::Unit 3::Verbs`), and a list of thirty rows all called "Stage 4" with no
 * indication of which deck they belong to is not a list.
 */
export function deckStages(projectId, { now = new Date() } = {}) {
    const nowIso = now.toISOString();
    const nodes = db.prepare(`
        SELECT n.id, n.title, n.description, n.position, n.status, n.parent_id,
               p.title AS parent_title
        FROM nodes n
        LEFT JOIN nodes p ON p.id = n.parent_id
        WHERE n.project_id = ? AND n.is_note = 0
        ORDER BY COALESCE(p.position, n.position), n.position, n.id
    `).all(projectId);

    const cardsByNode = new Map();
    for (const c of loadCards(projectId)) {
        if (!cardsByNode.has(c.node_id)) cardsByNode.set(c.node_id, []);
        cardsByNode.get(c.node_id).push(c);
    }

    const out = [];
    for (const n of nodes) {
        const cards = cardsByNode.get(n.id) ?? [];
        // A node with no cards of its own is a container (the deck a set of
        // stages hangs under). It is not a row on this list — its stages are.
        if (!cards.length) continue;
        let seen = 0, mature = 0, due = 0;
        const states = { new: 0, learning: 0, young: 0, mature: 0 };
        let map = '';
        for (const c of cards) {
            const state = cardState(c);
            states[state]++;
            if (state !== 'new') seen++;
            if (state === 'mature') mature++;
            if (state !== 'new' && isDueNow(c, nowIso)) due++;
            if (cards.length <= MAP_MAX) map += STATE_CHAR[state];
        }
        out.push({
            nodeId: n.id,
            title: n.title,
            description: n.description || '',
            parentTitle: n.parent_id ? n.parent_title : null,
            status: n.status,
            cards: cards.length,
            seen, mature, due,
            newCards: cards.length - seen,
            // The four states of THIS stage. `seen`/`mature` above are two
            // derived roll-ups of the same thing and stay because other callers
            // read them; the breakdown is what lets a stage be drawn rather than
            // summarised — 50 cards met with none of them holding is a very
            // different stage from one where forty are, and one bar with one
            // fill cannot say which you are looking at.
            states,
            // One character per card, in deck order, so a small stage can be
            // drawn as one tick per card the way a phase's leaves are. Omitted
            // above MAP_MAX because past a few hundred ticks the row is a
            // texture rather than a set of cards, and the stacked bar says the
            // same thing in four numbers — an absent map is the client's signal
            // to draw that instead, never an error.
            ...(map ? { map } : {}),
        });
    }
    return out;
}

/**
 * Everything the deck dashboard draws, in one round trip.
 */
export function buildDeckData(projectId, { forecastDays = 14, now = new Date() } = {}) {
    const project = db.prepare(
        'SELECT id, name, color, icon, kind, description FROM projects WHERE id = ?'
    ).get(projectId);
    if (!project) return null;
    // One instant for all three, so the counts, the ladder and the chart on one
    // screen can never be drawn from two different days.
    const counts = deckCounts(projectId, { now });
    const stages = deckStages(projectId, { now });
    return {
        project,
        ...counts,
        forecast: deckForecast(projectId, { days: forecastDays, now }),
        stages,
        matureDays: MATURE_DAYS,
        // The stage the learner is actually working on: the first that still has
        // cards they have never seen, else the first with anything due. "Where
        // do I carry on from" is the one question a thirty-row ladder must not
        // make somebody scroll to answer.
        currentStageId: (stages.find(s => s.newCards > 0) ?? stages.find(s => s.due > 0) ?? null)?.nodeId ?? null,
    };
}

/**
 * The cards a study session should serve, in the order Anki would serve them.
 *
 * Reviews first (they are the work that is actually owed, and they decay),
 * then new cards up to the day's remaining allowance, taken in the project's own
 * order via the node they were filed under. Interleaving the two is Anki's
 * default and could be done here later; serving 1,483 cards because none of them
 * has a `next_review` yet cannot.
 *
 * This is the ONLY producer of a card session, for every project and every door
 * — the project's own screen, the cross-project session, and the home feed's
 * card pool. It was `deckQueue` and served imports alone, which is how the same
 * card came to be rationed on one screen and dumped in a pile on another.
 */
export function studyQueue(projectId, { now = new Date(), newLimit = null, stageId = null, aheadDays = 0 } = {}) {
    const nowIso = now.toISOString();
    const counts = deckCounts(projectId, { now });

    // "Study ahead" is the learner overruling the day's rationing, and it has to
    // overrule BOTH halves of it or it does nothing at all — which is what it
    // did: the button asked for the ordinary queue, whose new-card allowance is
    // whatever is left of today's, and once that is spent the session opened
    // empty. A deck with every card in rotation and nothing due until Thursday
    // had no way to be studied at all.
    //
    // So an ahead session (a) takes a full fresh allowance of new cards rather
    // than the remainder, exactly like pressing Play on a stage, and (b) pulls
    // reviews forward by `aheadDays`. Pulling a review forward is not free —
    // answering a card early is answering it while it is still well remembered,
    // so FSRS earns a smaller interval than it would have — but that is the
    // learner's call to make, and refusing to open the deck at all is not a
    // kinder answer. Nothing here changes the DEFAULT queue.
    const horizonIso = aheadDays > 0
        ? new Date(now.getTime() + aheadDays * 86400000).toISOString()
        : nowIso;

    // Narrowing to one stage happens HERE, before the allowance is applied —
    // not by filtering the finished queue afterwards. That was a live bug: the
    // day's twenty new cards are taken in deck order, so they all come from the
    // stage the learner is currently on, and filtering that result by "stage 12"
    // left exactly nothing. Pressing Play on a stage opened an empty session.
    //
    // And a stage's Play button is an EXPLICIT choice about that stage, so it
    // gets a full allowance of that stage's new cards rather than whatever is
    // left of today's — the same reasoning as "Study ahead anyway". The rationed
    // queue is the deck's main Study button; this one is the learner steering.
    const allowance = newLimit != null
        ? Math.max(0, newLimit)
        : (stageId != null || aheadDays > 0)
            ? counts.newPerDay
            : counts.newRemaining;

    // Project identity travels with the card because the cross-project session
    // badges each one with where it came from, and it is the same query.
    const rows = db.prepare(`
        SELECT f.*, n.title AS node_title, n.parent_id, n.position AS node_position,
               parent.position AS parent_position,
               n.project_id, p.name AS project_name, p.color AS project_color
        FROM flashcards f
        JOIN nodes n ON n.id = f.node_id
        JOIN projects p ON p.id = n.project_id
        LEFT JOIN nodes parent ON parent.id = n.parent_id
        WHERE n.project_id = ? AND (? IS NULL OR f.node_id = ?)
    `).all(projectId, stageId, stageId);

    const reviews = [];
    const fresh = [];
    for (const r of rows) {
        if (cardState(r) === 'new') fresh.push(r);
        else if (isDueNow(r, horizonIso)) reviews.push(r);
    }
    reviews.sort((a, b) => String(a.next_review).localeCompare(String(b.next_review)));
    fresh.sort((a, b) =>
        (a.parent_position ?? 0) - (b.parent_position ?? 0) ||
        (a.node_position ?? 0) - (b.node_position ?? 0) ||
        a.id - b.id);

    return { reviews, fresh: fresh.slice(0, allowance), counts };
}

/**
 * The same queue across every active project — what the cross-project session
 * serves.
 *
 * Reviews are pooled and ordered by how long they have been owed (a card three
 * days late is more urgent than one due this morning, wherever it lives). New
 * cards are NOT pooled: each project brings its own allowance, because the
 * allowance is the learner's answer to "how much new material a day from THIS
 * collection", and a shared budget would let a 5,000-card import spend the whole
 * of it before a course introduced its first card.
 *
 * The endpoint this replaced counted every never-seen card of every curriculum
 * project as due, which is the "1,483 cards due" bug at library scale: measured
 * on a real library (2026-09-09) one curriculum project alone would have opened
 * a session of 615 cards, 615 of them never seen.
 */
export function globalStudyQueue({ now = new Date(), aheadDays = 0 } = {}) {
    const projects = db.prepare(`
        SELECT p.id
        FROM projects p
        WHERE COALESCE(p.status, 'active') = 'active'
          AND EXISTS (
              SELECT 1 FROM flashcards f JOIN nodes n ON n.id = f.node_id
              WHERE n.project_id = p.id
          )
        ORDER BY p.position ASC, p.created_at ASC
    `).all();

    const reviews = [];
    const fresh = [];
    for (const p of projects) {
        const q = studyQueue(p.id, { now, aheadDays });
        reviews.push(...q.reviews);
        fresh.push(...q.fresh);
    }
    reviews.sort((a, b) => String(a.next_review).localeCompare(String(b.next_review)));
    return { reviews, fresh };
}
