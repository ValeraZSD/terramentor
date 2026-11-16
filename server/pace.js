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
//            review rows were under 2 s apart.
//
// Days are the learner's (server/studyDay.js): a topic closed at 23:30 UTC on a
// Monday was closed on Tuesday in Amsterdam, and lands in Tuesday's week.

import db from './database.js';
import { WORK_LEAF, OPEN_WORK_LEAF } from './today.js';
import { projectCountsInCards } from './progress.js';
import { probeAvailability } from './placement.js';
import { learnerTimeZone, localDate, studyToday } from './studyDay.js';
import { judgeDate, learnerPace } from './paceModel.js';

const BURST_SECONDS = 2;
const AS_ISO = (col) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`;

let stmts = null;
// Prepared on first use: today.js and this file sit in an import cycle with
// scheduling.js, and WORK_LEAF is not readable while that cycle is resolving.
function statements() {
    if (stmts) return stmts;
    stmts = {
        topicsClosed: db.prepare(`
            SELECT ${AS_ISO('n.completed_at')} AS at FROM nodes n
            WHERE n.status = 'completed' AND n.completed_at IS NOT NULL AND ${WORK_LEAF}
        `),
        cardsMet: db.prepare(`
            WITH r AS (
                SELECT rl.reviewed_at, julianday(rl.reviewed_at) AS jd,
                       LAG(julianday(rl.reviewed_at)) OVER w AS prev_jd,
                       LEAD(julianday(rl.reviewed_at)) OVER w AS next_jd,
                       ROW_NUMBER() OVER (PARTITION BY rl.card_id ORDER BY julianday(rl.reviewed_at), rl.id) AS nth
                FROM review_log rl
                WINDOW w AS (ORDER BY julianday(rl.reviewed_at), rl.id)
            )
            SELECT ${AS_ISO('reviewed_at')} AS at FROM r
            WHERE nth = 1
              AND (prev_jd IS NULL OR (jd - prev_jd) * 86400 >= ${BURST_SECONDS})
              AND (next_jd IS NULL OR (next_jd - jd) * 86400 >= ${BURST_SECONDS})
        `),
        firstCourse: db.prepare(`SELECT MIN(${AS_ISO('created_at')}) AS at FROM projects`),
        project: db.prepare('SELECT id, deadline, status FROM projects WHERE id = ?'),
        openTopics: db.prepare(`SELECT COUNT(*) AS c FROM nodes n WHERE n.project_id = ? AND ${OPEN_WORK_LEAF}`),
        unmetCards: db.prepare(`
            SELECT COUNT(*) AS c FROM flashcards f JOIN nodes n ON n.id = f.node_id
            WHERE n.project_id = ? AND NOT (f.review_count > 0 AND f.last_reviewed IS NOT NULL)
        `),
        // Other courses still asking for time: active, dated after today, with
        // a topic or a card left.
        otherCourses: db.prepare(`
            SELECT COUNT(*) AS c FROM projects p
            WHERE p.id != ? AND COALESCE(p.status, 'active') = 'active'
              AND p.deadline IS NOT NULL AND p.deadline > ?
              AND (EXISTS (SELECT 1 FROM nodes n WHERE n.project_id = p.id AND ${OPEN_WORK_LEAF})
                   OR EXISTS (SELECT 1 FROM flashcards f JOIN nodes n ON n.id = f.node_id
                              WHERE n.project_id = p.id AND NOT (f.review_count > 0 AND f.last_reviewed IS NOT NULL)))
        `),
    };
    return stmts;
}

const toDays = (rows, timeZone) => rows
    .map(r => Date.parse(r.at))
    .filter(Number.isFinite)
    .map(ms => localDate(ms, timeZone));

/**
 * The learner's record as local days: when topics were closed, when cards were
 * first met, and the day the record begins (the oldest course, or an older
 * completion brought in with an imported course).
 */
export function learnerRecord({ timeZone = learnerTimeZone() } = {}) {
    const s = statements();
    const topicDays = toDays(s.topicsClosed.all(), timeZone);
    const cardDays = toDays(s.cardsMet.all(), timeZone);
    const firstCourse = s.firstCourse.get()?.at;
    const starts = [...topicDays, ...cardDays];
    if (firstCourse && Number.isFinite(Date.parse(firstCourse))) starts.push(localDate(Date.parse(firstCourse), timeZone));
    const since = starts.length ? starts.reduce((a, b) => (b < a ? b : a)) : null;
    return { since, topicDays, cardDays };
}

/**
 * The learner's weeks in both units, read once and shared by every course a
 * screen judges.
 */
export function libraryPace({ now = Date.now(), timeZone = learnerTimeZone() } = {}) {
    const today = studyToday({ now, timeZone });
    const rec = learnerRecord({ timeZone });
    return {
        today,
        topics: learnerPace(rec.topicDays, { since: rec.since, today }),
        cards: learnerPace(rec.cardDays, { since: rec.since, today }),
    };
}

/**
 * Who may change a course's date. Every date is the learner's own and none is
 * locked until a course can carry a teacher's date or an "exam, cannot move"
 * mark; this is the one place that will read them.
 */
function dateOwnership() {
    return { fixed: false, assigned: false };
}

/**
 * The verdict on one course's date, or null when it has none.
 *
 * @param {number|string} projectId
 * @param {{ now?: number, timeZone?: string, library?: ReturnType<typeof libraryPace> }} [opts]
 *   `library` lets a screen judging many courses read the record once.
 */
export function projectVerdict(projectId, { now = Date.now(), timeZone = learnerTimeZone(), library = null } = {}) {
    const s = statements();
    const project = s.project.get(projectId);
    if (!project?.deadline) return null;
    const lib = library || libraryPace({ now, timeZone });
    const cards = projectCountsInCards(project.id);
    const open = cards ? s.unmetCards.get(project.id).c : s.openTopics.get(project.id).c;
    const otherCourses = s.otherCourses.get(project.id, lib.today).c;
    // The placement check places topics; a deck has none to place.
    const canCheckKnown = !cards && open > 0 && probeAvailability(project.id).available === true;
    const verdict = judgeDate(cards ? lib.cards : lib.topics, {
        open,
        deadline: project.deadline,
        today: lib.today,
        unit: cards ? 'cards' : 'topics',
        canCheckKnown,
        otherCourses,
        ...dateOwnership(),
    });
    return { ...verdict, otherCourses };
}
