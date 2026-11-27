// server/pace.js — the learner's record read out of the library, for the pace
// verdict in server/paceModel.js.
//
// The model is pure; this file is where the facts come from and where the
// clock is read (once, as `now`, which every caller may pass).
//
// What counts as work closed:
//   topics — a WORK_LEAF set completed, at its `completed_at`. Notes, sections,
//            a deck's stages and a completion with no time do not count. A
//            skipped topic is closed (not open work) but was not studied, so it
//            is not pace either.
//   cards  — a card's FIRST review, unless that review sits within 2 seconds of
//            the review before or after it. Rows that close together are a
//            script or a test run, not a person: on one real library 474 of 667
//            review rows were under 2 s apart. An in-app first row that found
//            the card already past New (`state_before` > 0: a card imported
//            with a review count but no history) was met before this library
//            kept a log, so it is not a card met that day. A row with no
//            `state_before` at all (written before the column existed) is
//            unknown, not past New, so it counts; decks.js and feed.js ask the
//            stricter `= 0` because they pick out today's new cards.
//
// Each unit's record begins on its own day: topics at the oldest course with a
// topic (or an older completion), cards at the oldest card (or an older
// review). A learner with a deck since January and a course since last week
// has one week of topic data, not forty-five empty ones. The card record reads
// the cards that still exist: deleting a deck's oldest cards moves it forward.
//
// Days are the learner's (server/studyDay.js): a topic closed at 23:30 UTC on a
// Monday was closed on Tuesday in Amsterdam, and lands in Tuesday's week.

import db from './database.js';
import { WORK_LEAF, OPEN_WORK_LEAF } from './today.js';
import { projectCountsInCards } from './progress.js';
import { probeAvailability } from './placement.js';
import { dayBounds, learnerTimeZone, localDate, studyToday } from './studyDay.js';
import { OFFERS, judgeDate, learnerPace } from './paceModel.js';

const BURST_SECONDS = 2;
// julianday() carries about a tenth of a millisecond of float error: two rows
// written exactly 2.000 s apart read as 1.99999 s. A millisecond of slack keeps
// them apart without letting a real burst through.
const BURST_SLACK = 0.001;
const MISSES = new Set(['under_pace', 'tight', 'out_of_reach']);
const AS_ISO =(col) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`;

// Every card's first review, with its neighbours in the whole log; CARD_MET
// keeps the ones a person made (see the header).
const FIRST_REVIEWS = `
    WITH r AS (
        SELECT rl.card_id, rl.reviewed_at, rl.source, rl.state_before, julianday(rl.reviewed_at) AS jd,
               LAG(julianday(rl.reviewed_at)) OVER w AS prev_jd,
               LEAD(julianday(rl.reviewed_at)) OVER w AS next_jd,
               ROW_NUMBER() OVER (PARTITION BY rl.card_id ORDER BY julianday(rl.reviewed_at), rl.id) AS nth
        FROM review_log rl
        WINDOW w AS (ORDER BY julianday(rl.reviewed_at), rl.id)
    )`;
const CARD_MET = `r.nth = 1
    AND (r.source <> 'app' OR COALESCE(r.state_before, 0) = 0)
    AND (r.prev_jd IS NULL OR (r.jd - r.prev_jd) * 86400 >= ${BURST_SECONDS - BURST_SLACK})
    AND (r.next_jd IS NULL OR (r.next_jd - r.jd) * 86400 >= ${BURST_SECONDS - BURST_SLACK})`;

let stmts = null;
// Prepared on first use: today.js and this file sit in an import cycle with
// scheduling.js, and WORK_LEAF is not readable while that cycle is resolving.
function statements() {
    if (stmts) return stmts;
    stmts = {
        topicsClosed: db.prepare(`
            SELECT ${AS_ISO('n.completed_at')} AS at FROM live_nodes n
            WHERE n.status = 'completed' AND n.completed_at IS NOT NULL AND ${WORK_LEAF}
        `),
        cardsMet: db.prepare(`${FIRST_REVIEWS} SELECT ${AS_ISO('r.reviewed_at')} AS at FROM r WHERE ${CARD_MET}`),
        // One course's share of the same, between two instants: the plan
        // panel's "this week" line.
        topicsClosedIn: db.prepare(`
            SELECT COUNT(*) AS c FROM live_nodes n
            WHERE n.project_id = ? AND n.status = 'completed' AND n.completed_at IS NOT NULL AND ${WORK_LEAF}
              AND julianday(n.completed_at) >= julianday(?) AND julianday(n.completed_at) < julianday(?)
        `),
        cardsMetIn: db.prepare(`${FIRST_REVIEWS}
            SELECT COUNT(*) AS c FROM r
            JOIN live_flashcards f ON f.id = r.card_id JOIN live_nodes n ON n.id = f.node_id
            WHERE ${CARD_MET} AND n.project_id = ? AND r.jd >= julianday(?) AND r.jd < julianday(?)
        `),
        // Where each unit's record begins: single aggregates (one correlated
        // EXISTS per project for topics), so a screen that needs only topics
        // never pays for the review log's window query.
        firstTopicCourse: db.prepare(`
            SELECT MIN(${AS_ISO('p.created_at')}) AS at FROM live_projects p
            WHERE EXISTS (SELECT 1 FROM live_nodes n WHERE n.project_id = p.id AND ${WORK_LEAF})
        `),
        firstCard: db.prepare(`SELECT ${AS_ISO('MIN(julianday(created_at))')} AS at FROM live_flashcards flashcards`),
        firstClosed: db.prepare(`
            SELECT ${AS_ISO('MIN(julianday(n.completed_at))')} AS at FROM live_nodes n
            WHERE n.status = 'completed' AND n.completed_at IS NOT NULL AND ${WORK_LEAF}
        `),
        firstReview: db.prepare(`SELECT ${AS_ISO('MIN(julianday(reviewed_at))')} AS at FROM review_log`),
        project: db.prepare('SELECT id, deadline, deadline_fixed, status FROM live_projects projects WHERE id = ?'),
        openTopics: db.prepare(`SELECT COUNT(*) AS c FROM live_nodes n WHERE n.project_id = ? AND ${OPEN_WORK_LEAF}`),
        unmetCards: db.prepare(`
            SELECT COUNT(*) AS c FROM live_flashcards f JOIN live_nodes n ON n.id = f.node_id
            WHERE n.project_id = ? AND NOT (COALESCE(f.review_count, 0) > 0 AND f.last_reviewed IS NOT NULL)
        `),
        // Other courses still asking for time: active, not paused, dated today or later
        // (the deadline day is still a study day), with a topic or a card left.
        otherCourses: db.prepare(`
            SELECT COUNT(*) AS c FROM live_projects p
            WHERE p.id != ? AND COALESCE(p.status, 'active') = 'active' AND COALESCE(p.paused, 0) = 0
              AND p.deadline IS NOT NULL AND p.deadline >= ?
              AND (EXISTS (SELECT 1 FROM live_nodes n WHERE n.project_id = p.id AND ${OPEN_WORK_LEAF})
                   OR EXISTS (SELECT 1 FROM live_flashcards f JOIN live_nodes n ON n.id = f.node_id
                              WHERE n.project_id = p.id AND NOT (COALESCE(f.review_count, 0) > 0 AND f.last_reviewed IS NOT NULL)))
        `),
    };
    return stmts;
}

const toDays = (rows, timeZone) => rows
    .map(r => Date.parse(r.at))
    .filter(Number.isFinite)
    .map(ms => localDate(ms, timeZone));

/**
 * The day the learner's record in one unit begins. Topics: the oldest course
 * with a topic, or an older completion brought in with an imported course.
 * Cards: the oldest card, or an older review brought in with its history.
 */
export function recordSince(unit, { timeZone = learnerTimeZone() } = {}) {
    const s = statements();
    const sources = unit === 'cards'
        ? [s.firstCard.get()?.at, s.firstReview.get()?.at]
        : [s.firstTopicCourse.get()?.at, s.firstClosed.get()?.at];
    const days = sources
        .map(at => Date.parse(at))
        .filter(Number.isFinite)
        .map(ms => localDate(ms, timeZone));
    return days.length ? days.reduce((a, b) => (b < a ? b : a)) : null;
}

/** The learner's record as local days: when topics were closed, when cards were first met. */
export function learnerRecord({ timeZone = learnerTimeZone() } = {}) {
    const s = statements();
    return {
        topicsSince: recordSince('topics', { timeZone }),
        cardsSince: recordSince('cards', { timeZone }),
        topicDays: toDays(s.topicsClosed.all(), timeZone),
        cardDays: toDays(s.cardsMet.all(), timeZone),
    };
}

/**
 * The learner's weeks in both units, shared by every course a screen judges.
 * Each unit is read on first use and kept: a screen with no dated deck never
 * runs the review log's window query, and one with no date reads nothing.
 */
export function libraryPace({ now = Date.now(), timeZone = learnerTimeZone() } = {}) {
    const today = studyToday({ now, timeZone });
    const s = statements();
    let topics, cards;
    return {
        today,
        get topics() {
            return topics ??= learnerPace(toDays(s.topicsClosed.all(), timeZone), { since: recordSince('topics', { timeZone }), today });
        },
        get cards() {
            return cards ??= learnerPace(toDays(s.cardsMet.all(), timeZone), { since: recordSince('cards', { timeZone }), today });
        },
    };
}

/**
 * Who may change a course's date: the learner's "exam date, cannot move" mark
 * (`deadline_fixed`). A date a teacher set (`assigned`) has no column yet, so
 * every date in a library is the learner's own. The one place that reads both.
 */
function dateOwnership(project) {
    return { fixed: Boolean(project.deadline_fixed), assigned: false };
}

/**
 * The verdict on one course's date, or null when it has none.
 *
 * @param {number|string} projectId
 * @param {{ now?: number, timeZone?: string, library?: ReturnType<typeof libraryPace> }} [opts]
 *   `library` lets a screen judging many courses read the record once.
 *   `offers: false` skips the placement probe behind the "check what you
 *   know" offer, for a reader that uses only the band (the feed).
 */
export function projectVerdict(projectId, { now = Date.now(), timeZone = learnerTimeZone(), library = null, offers = true } = {}) {
    const s = statements();
    const project = s.project.get(projectId);
    if (!project?.deadline) return null;
    const lib = library || libraryPace({ now, timeZone });
    const cards = projectCountsInCards(project.id);
    const open = cards ? s.unmetCards.get(project.id).c : s.openTopics.get(project.id).c;
    const otherCourses = s.otherCourses.get(project.id, lib.today).c;
    const verdict = judgeDate(cards ? lib.cards : lib.topics, {
        open,
        deadline: project.deadline,
        today: lib.today,
        unit: cards ? 'cards' : 'topics',
        otherCourses,
        ...dateOwnership(project),
    });
    // The placement check is offered only when the date misses, so it is
    // asked only then (it walks the course's tree). It places topics; a deck
    // has none to place. The offer is slotted in by OFFERS' order rather than
    // judged again, which would re-run both finish-range simulations.
    if (offers && !cards && MISSES.has(verdict.band) && probeAvailability(project.id).available === true) {
        verdict.offers = [...verdict.offers, { kind: 'check_known' }]
            .sort((a, b) => OFFERS.indexOf(a.kind) - OFFERS.indexOf(b.kind));
    }
    return { ...verdict, otherCourses };
}

/** The Monday that starts the week holding `day` (`YYYY-MM-DD`): the study-day picker's week. */
export function weekStartOf(day) {
    const ms = Date.parse(`${day}T00:00:00Z`);
    const back = (new Date(ms).getUTCDay() + 6) % 7;
    return new Date(ms - back * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One course's work closed this week so far, Monday to today on the learner's
 * calendar, in the verdict's unit: the "this week" line under the plan's
 * strip. The course's own, not the library's: a week spent on another course
 * is no progress on this one.
 *
 * @returns {{ since: string, count: number }}
 */
export function weekSoFar(projectId, unit, { now = Date.now(), timeZone = learnerTimeZone() } = {}) {
    const s = statements();
    const today = studyToday({ now, timeZone });
    const since = weekStartOf(today);
    const from = dayBounds(since, timeZone).start;
    const to = dayBounds(today, timeZone).end;
    const row = unit === 'cards' ? s.cardsMetIn.get(projectId, from, to) : s.topicsClosedIn.get(projectId, from, to);
    return { since, count: row.c };
}
