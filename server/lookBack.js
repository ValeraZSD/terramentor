// THE LOOK BACK: a short mixed check the study stream offers by itself.
//
// Every two weeks or so, or when a phase of the course has just closed, the
// stream opens with an offer: ten questions from everything the course has
// taught so far, answered on the course mock's own screen (server/mockExams.js,
// a draw flagged `look_back`). In the three weeks before a real exam the offer
// is the full mock instead, at most once a week. One tap ("Not now") clears it
// until the next one; nothing in the stream waits on it.
//
// Why these numbers (the design note behind them cites the studies):
//   - 14 days: the best gap between reviews grows with how long a thing is to
//     be kept, about one to two weeks for a course of months (Cepeda et al.
//     2008). A phase that closed sooner counts too, at least 3 days after the
//     last look back so two never stack.
//   - 4 topics and 10 questions: below that a "mixed" check is one topic's
//     check over again, and a short one.
//   - 21 and 7 days: our choice, not a study's. Cepeda et al. 2008 found the
//     best gap about a day for a test a week away and about 11 days for one
//     five weeks away, so for one about three weeks away it lies near a week,
//     and a weekly offer lands near it.
// A deck gets none: its card reviews are the mixed check already. A course
// that is archived or finished gets none either, as the stream serves only
// active courses.
//
// What it writes is the mock's: practice evidence per topic, never a
// completion, a reopening or a proof taken away. A topic answered wrong comes
// back in the recall round (fading.js SLIPPED_TOPIC).
//
// Every function that reads the clock takes `now`, so the gate
// (tools/look-back-gates.mjs) never reads the wall clock.

import db from './database.js';
import { WORK_LEAF } from './today.js';
import { daysUntil } from './scheduling.js';
import { studyToday } from './studyDay.js';
import { MockExamError, courseReadiness, discardSitting, drawCourseMock, finishSitting, getSitting, instantOf } from './mockExams.js';

export const LOOK_BACK_SIZE = 10;
export const LOOK_BACK_DAYS = 14;
export const LOOK_BACK_MIN_TOPICS = 4;
export const PHASE_GAP_DAYS = 3;
export const MOCK_WINDOW_DAYS = 21;
export const MOCK_AGAIN_DAYS = 7;

const DAY = 86_400_000;

const cache = new Map();
const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
};
const msOf = (now) => (now instanceof Date ? now.getTime() : Number(now));
/** The newest of the stamps that are not after `t`. */
const latest = (t, ...stamps) => stamps.map(instantOf).filter(v => v != null && v <= t).reduce((a, b) => Math.max(a, b), -Infinity);
const found = (v) => Number.isFinite(v);

function projectOf(projectId) {
    return stmt(`
        SELECT id, kind, COALESCE(status, 'active') AS status, deadline, deadline_fixed, exam_on_screen, look_back_skipped_at
        FROM projects WHERE id = ?
    `).get(projectId);
}

/** The look back still open on this course, if any. */
function openLookBack(projectId) {
    return stmt(`
        SELECT s.id, s.started_at FROM mock_sittings s JOIN exam_papers e ON e.id = s.paper_id
        WHERE e.project_id = ? AND e.look_back = 1 AND s.status <> 'done'
        ORDER BY s.id DESC LIMIT 1
    `).get(projectId) ?? null;
}

/**
 * An open look back no longer worth a Continue: put off with "Not now" since it
 * started, or as old as the gap between two look backs (its questions were
 * picked for a day long gone).
 */
function putOff(open, skipped, t) {
    const started = instantOf(open.started_at);
    return skipped >= started || t - started >= LOOK_BACK_DAYS * DAY;
}

/** How many of a sitting's questions have an answer. */
const answeredIn = (sittingId) => stmt('SELECT COUNT(*) AS n FROM mock_part_scores WHERE sitting_id = ? AND answer IS NOT NULL').get(sittingId).n;

/** When the course's last finished look back (1) or other mock (0) ended. */
function lastFinished(projectId, lookBack) {
    return stmt(`
        SELECT MAX(s.finished_at) AS t FROM mock_sittings s JOIN exam_papers e ON e.id = s.paper_id
        WHERE e.project_id = ? AND e.look_back = ? AND s.status = 'done'
    `).get(projectId, lookBack)?.t ?? null;
}

/** The course's first answer of its own (a placement probe is no study). */
function firstAnswer(projectId, t) {
    const e = stmt(`
        SELECT MIN(e.created_at) AS t FROM mastery_evidence e JOIN nodes n ON n.id = e.node_id
        WHERE n.project_id = ? AND e.evidence_type <> 'placement'
    `).get(projectId)?.t;
    const q = stmt(`
        SELECT MIN(q.asked_at) AS t FROM question_log q JOIN nodes n ON n.id = q.node_id
        WHERE n.project_id = ?
    `).get(projectId)?.t;
    const both = [instantOf(e), instantOf(q)].filter(v => v != null && v <= t);
    return both.length ? Math.min(...both) : -Infinity;
}

/**
 * When the most recent phase closed, as of `t`: a top-level part of the
 * course with two or more topics, every one of them completed or skipped by
 * then. -Infinity when none has.
 */
function lastPhaseClosed(projectId, t) {
    const nodes = stmt('SELECT id, parent_id FROM nodes WHERE project_id = ?').all(projectId);
    const parent = new Map(nodes.map(n => [n.id, n.parent_id]));
    const rootOf = (id) => { let at = id; while (parent.get(at) != null) at = parent.get(at); return at; };
    const leaves = stmt(`SELECT n.id, n.status, n.completed_at FROM nodes n WHERE n.project_id = ? AND ${WORK_LEAF}`).all(projectId);
    const phases = new Map();
    for (const leaf of leaves) {
        const root = rootOf(leaf.id);
        if (root === leaf.id) continue;
        if (!phases.has(root)) phases.set(root, []);
        phases.get(root).push(leaf);
    }
    // A skipped topic closes its place in the phase but carries no date
    // (routes/nodes.js stores completed_at NULL for it), so the phase closed
    // when its last COMPLETED topic did; a phase skipped whole taught nothing.
    let closed = -Infinity;
    for (const list of phases.values()) {
        if (list.length < 2) continue;
        if (list.some(l => l.status !== 'completed' && l.status !== 'skipped')) continue;
        const at = list.filter(l => l.status === 'completed').map(l => instantOf(l.completed_at));
        if (!at.length || at.some(v => v == null || v > t)) continue;
        closed = Math.max(closed, ...at);
    }
    return closed;
}

/** Enough to mix: questions the app marks by itself, from enough topics. */
function enough(projectId) {
    const r = courseReadiness(projectId);
    return r.topics >= LOOK_BACK_MIN_TOPICS && r.ready >= LOOK_BACK_SIZE ? r : null;
}

/**
 * What the stream should offer for this course right now, or null:
 *   { kind: 'resume', projectId, sittingId, answered, questions }  a look back left open
 *   { kind: 'mock', projectId, daysLeft, questions }               a real exam 1 to 21 days away
 *   { kind: 'look_back', projectId, questions }                    the look back
 * The cheap reads come first; what the course could draw is read last, only
 * when everything else says yes.
 */
export function lookBackOffer(projectId, { now = Date.now() } = {}) {
    const t = msOf(now);
    const p = projectOf(projectId);
    if (!p || p.kind === 'deck' || p.status !== 'active') return null;

    const skipped = latest(t, p.look_back_skipped_at);

    // A real exam: a date that cannot move, or the exam described.
    const realExam = p.deadline && (p.deadline_fixed === 1 || p.exam_on_screen != null);
    const daysLeft = realExam ? daysUntil(p.deadline, studyToday({ now: t })) : null;
    // The exam's own day: nothing is offered.
    if (daysLeft === 0) return null;
    const inWindow = daysLeft != null && daysLeft >= 1 && daysLeft <= MOCK_WINDOW_DAYS;

    // One left open waits with Continue, until it is put off (putOff); then
    // the next offer comes on the usual clock and Start draws a fresh one.
    // Inside the mock window the mock is the offer, even over an open one.
    const open = inWindow ? null : openLookBack(projectId);
    if (open && !putOff(open, skipped, t)) {
        const parts = stmt('SELECT COUNT(*) AS n FROM exam_paper_parts WHERE paper_id = (SELECT paper_id FROM mock_sittings WHERE id = ?)').get(open.id).n;
        return { kind: 'resume', projectId, sittingId: open.id, answered: answeredIn(open.id), questions: parts };
    }

    const lastMock = latest(t, lastFinished(projectId, 0));
    const lastLook = latest(t, lastFinished(projectId, 1));

    if (inWindow) {
        // Inside the window the mock is the offer, and the look back waits.
        if (t - Math.max(skipped, lastMock) < MOCK_AGAIN_DAYS * DAY) return null;
        const r = enough(projectId);
        return r ? { kind: 'mock', projectId, daysLeft, questions: r.ready } : null;
    }

    const last = Math.max(skipped, lastMock, lastLook);
    const since = found(last) ? last : firstAnswer(projectId, t);
    if (!found(since)) return null;
    let due = t - since >= LOOK_BACK_DAYS * DAY;
    if (!due && (!found(last) || t - last >= PHASE_GAP_DAYS * DAY)) {
        const closed = lastPhaseClosed(projectId, t);
        due = found(closed) && (!found(last) || closed > last);
    }
    if (!due) return null;
    return enough(projectId) ? { kind: 'look_back', projectId, questions: LOOK_BACK_SIZE } : null;
}

/** The offer for one course as the API gives it; an unknown course is a 404, not "nothing due". */
export function getLookBack(projectId, { now = Date.now() } = {}) {
    if (!projectOf(projectId)) throw new MockExamError(404, 'Course not found');
    return { offer: lookBackOffer(projectId, { now }) };
}

/**
 * Start the look back, or open the one already started. Asked for by hand, it
 * starts whether offered or not, on a course the stream could offer one on,
 * with enough to mix. A look back left open and then put off (putOff) is
 * closed and a fresh one drawn: its questions were picked for a day that has
 * passed. Closed means finished when something on it was answered, so those
 * answers count as practice, and dropped when nothing was.
 */
export function startLookBack(projectId, { now = Date.now() } = {}) {
    const t = msOf(now);
    const p = projectOf(projectId);
    if (!p) throw new MockExamError(404, 'Course not found');
    if (p.kind === 'deck' || p.status !== 'active') throw new MockExamError(409, 'This course has no look back');
    const open = openLookBack(projectId);
    if (open && !putOff(open, latest(t, p.look_back_skipped_at), t)) {
        return { sitting: getSitting(open.id, { now: t }), resumed: true };
    }
    if (!enough(projectId)) throw new MockExamError(409, 'Not enough studied yet to look back on');
    // One step: a draw that fails leaves the old one open, as it was. The old
    // one's answers are logged now, so a miss on it counts from today.
    return db.transaction(() => {
        if (open) {
            if (answeredIn(open.id) > 0) finishSitting(open.id, { now: t });
            else discardSitting(open.id);
        }
        return drawCourseMock(projectId, { size: LOOK_BACK_SIZE, minutes: null, now: t, lookBack: true });
    })();
}

/** "Not now": the offer goes until the next one is due. */
export function skipLookBack(projectId, { now = Date.now() } = {}) {
    const t = msOf(now);
    const r = stmt('UPDATE projects SET look_back_skipped_at = ? WHERE id = ?').run(new Date(t).toISOString(), projectId);
    if (!r.changes) throw new MockExamError(404, 'Course not found');
    return { ok: true };
}
