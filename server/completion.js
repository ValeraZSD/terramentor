// server/completion.js — the record of a finished project.
//
// Answers two questions only:
//
//   Is this project finished?  — the SAME rule as the progress ring
//                                (server/progress.js), evaluated EXACTLY: a
//                                5,168-card deck one card short is 0.9998, which
//                                rounds to 100% and is NOT finished.
//   What did finishing it take? — counts, dates and a per-day activity series,
//                                each from rows with their own timestamps.
//
// Nothing is estimated. There is no time-spent figure (`learning_sessions.
// duration_seconds` is never written), so the time axis is DAYS: first to last,
// days with activity, longest unbroken run.
//
// Counting rules shared with `buildTodayActivity` (server/today.js), so the summary
// and the home page's chips agree:
//
//   • **Only work done in this app**: `review_log.source = 'app'`, not an imported
//     Anki revlog.
//   • **Card evidence is not a question**: `flashcard` evidence rows are batched
//     ratings (server/cardEvidence.js) of reviews already counted.
//   • **Reviews are rows, cards seen are distinct card ids.**
//
// And its own: **only PERMANENT records.** Not `feed_items` (lessons read):
// `server/database.js` deletes the teaching cache of every closed node at startup,
// so a finished project's totals would shrink. The series is built from
// `review_log`, `mastery_evidence` and `nodes.completed_at`.

import db from './database.js';
import { WORK_LEAF } from './today.js';
import { projectProgress, topicFraction } from './progress.js';
import { daysBetween } from './scheduling.js';

/** Which projects have already had their summary shown and dismissed. */
const CELEBRATED_SETTING = 'celebrated_projects';

function getSetting(key) {
    try {
        return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    } catch {
        return null;
    }
}

function setSetting(key, value) {
    try {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, value);
    } catch { /* a locked database must not break a dismissal */ }
}

/** Ids whose summary has been seen. One settings row, not one per project. */
export function celebratedProjects() {
    try {
        const raw = JSON.parse(getSetting(CELEBRATED_SETTING) || '[]');
        return new Set(Array.isArray(raw) ? raw.map(Number).filter(Number.isInteger) : []);
    } catch {
        return new Set();
    }
}

function writeCelebrated(ids) {
    setSetting(CELEBRATED_SETTING, JSON.stringify([...ids]));
}

export function markCelebrated(projectId) {
    const ids = celebratedProjects();
    ids.add(Number(projectId));
    writeCelebrated(ids);
}

/**
 * Forget that a project's summary was shown.
 *
 * Called when a finished project stops being finished (a topic reopened or added),
 * so finishing it again shows the screen again.
 */
export function clearCelebrated(projectId) {
    const ids = celebratedProjects();
    if (!ids.delete(Number(projectId))) return;
    writeCelebrated(ids);
}

/* ── the activity series ─────────────────────────────────────────────────── */

/**
 * Bucket sizes in days, widest last; the first that fits the span into
 * `MAX_BUCKETS` wins (two weeks → daily bars, three years → quarters).
 *
 * Uniform day counts, not calendar weeks/months, which are ragged at both ends; the
 * axis is labelled with the real first and last dates.
 */
export const BUCKET_SIZES = [1, 2, 3, 7, 14, 30, 60, 90, 180, 365];

/** Above this the bars stop being readable in the ~330px a phone gives them. */
export const MAX_BUCKETS = 30;

/** Below this there is no shape to see, and a sentence says it better. */
export const MIN_BUCKETS = 3;

export function bucketSizeFor(spanDays) {
    for (const size of BUCKET_SIZES) {
        if (Math.ceil(spanDays / size) <= MAX_BUCKETS) return size;
    }
    return BUCKET_SIZES[BUCKET_SIZES.length - 1];
}

const DAY_MS = 86_400_000;
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (s) => Date.parse(`${s}T00:00:00Z`);

/**
 * Turn `[{ day, n }]` into a fixed number of equal buckets spanning first→last.
 *
 * Pure, so `tools/completion-gates.mjs` asserts bar count and totals for spans from
 * one day to ten years.
 */
export function bucketActivity(days) {
    const rows = (days || []).filter(d => d && d.day).sort((a, b) => (a.day < b.day ? -1 : 1));
    if (!rows.length) return null;
    const first = rows[0].day;
    const last = rows[rows.length - 1].day;
    const spanDays = daysBetween(first, last) + 1;
    const size = bucketSizeFor(spanDays);
    const count = Math.max(1, Math.ceil(spanDays / size));
    if (count < MIN_BUCKETS) return null;

    const buckets = Array.from({ length: count }, (_, i) => ({
        start: dayStr(dayMs(first) + i * size * DAY_MS),
        count: 0,
    }));
    for (const row of rows) {
        const index = Math.min(count - 1, Math.floor(daysBetween(first, row.day) / size));
        buckets[index].count += Number(row.n) || 0;
    }
    return { days: size, buckets };
}

/**
 * Days studied, the longest unbroken run of them, and the busiest one.
 *
 * "Unbroken" is calendar days: skipping non-study days would need `study_days`,
 * which is a plan, not a record.
 */
export function activitySpan(days) {
    const rows = (days || []).filter(d => d && d.day).sort((a, b) => (a.day < b.day ? -1 : 1));
    if (!rows.length) return null;
    let longestStreak = 0;
    let run = 0;
    let previous = null;
    let best = rows[0];
    for (const row of rows) {
        run = previous && daysBetween(previous, row.day) === 1 ? run + 1 : 1;
        if (run > longestStreak) longestStreak = run;
        previous = row.day;
        if ((Number(row.n) || 0) > (Number(best.n) || 0)) best = row;
    }
    const first = rows[0].day;
    const last = rows[rows.length - 1].day;
    return {
        firstDay: first,
        lastDay: last,
        calendarDays: daysBetween(first, last) + 1,
        studyDays: rows.length,
        longestStreak,
        bestDay: { date: best.day, count: Number(best.n) || 0 },
    };
}

/* ── the queries ─────────────────────────────────────────────────────────── */

// Work leaves with their card counts: the same set and columns `server/progress.js`
// rolls up, so "finished" and "100%" are one decision.
const WORK_LEAF_ROWS = `
    SELECT n.id AS id, n.status AS status,
           COUNT(f.id) AS cards,
           SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL THEN 1 ELSE 0 END) AS seen
    FROM nodes n
    LEFT JOIN flashcards f ON f.node_id = n.id
    WHERE n.project_id = ? AND ${WORK_LEAF}
    GROUP BY n.id
`;

const PROJECT_CARDS = `
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL THEN 1 ELSE 0 END) AS met
    FROM flashcards f JOIN nodes n ON n.id = f.node_id
    WHERE n.project_id = ?
`;

// Everything the learner DID, one row per UTC day. Three sources, unioned: they
// share only a timestamp, and a join would multiply them.
const ACTIVITY_DAYS = `
    SELECT day, SUM(n) AS n FROM (
        SELECT date(rl.reviewed_at) AS day, COUNT(*) AS n
        FROM review_log rl
        JOIN flashcards f ON f.id = rl.card_id
        JOIN nodes nd ON nd.id = f.node_id
        WHERE nd.project_id = ? AND rl.source = 'app'
        GROUP BY day
      UNION ALL
        SELECT date(me.created_at) AS day, COUNT(*) AS n
        FROM mastery_evidence me
        JOIN nodes nd ON nd.id = me.node_id
        WHERE nd.project_id = ? AND me.evidence_type != 'flashcard'
        GROUP BY day
      UNION ALL
        SELECT date(nd.completed_at) AS day, COUNT(*) AS n
        FROM nodes nd
        WHERE nd.project_id = ? AND nd.completed_at IS NOT NULL AND nd.is_note = 0
        GROUP BY day
    )
    WHERE day IS NOT NULL
    GROUP BY day ORDER BY day
`;

let stmts = null;
function statements() {
    if (stmts) return stmts;
    stmts = {
        project: db.prepare('SELECT id, name, icon, color, status, start_date, deadline, created_at FROM projects WHERE id = ?'),
        leaves: db.prepare(WORK_LEAF_ROWS),
        cards: db.prepare(PROJECT_CARDS),
        activity: db.prepare(ACTIVITY_DAYS),
        reviews: db.prepare(`
            SELECT COUNT(*) AS reviews, COUNT(DISTINCT rl.card_id) AS cardsSeen
            FROM review_log rl
            JOIN flashcards f ON f.id = rl.card_id
            JOIN nodes n ON n.id = f.node_id
            WHERE n.project_id = ? AND rl.source = 'app'
        `),
        answers: db.prepare(`
            SELECT COALESCE(SUM(me.total), 0) AS answers, COALESCE(SUM(me.score), 0) AS correct,
                   COUNT(*) AS sittings
            FROM mastery_evidence me
            JOIN nodes n ON n.id = me.node_id
            WHERE n.project_id = ? AND me.evidence_type != 'flashcard'
        `),
        quizzes: db.prepare(`
            SELECT COUNT(*) AS quizzes FROM quiz_attempts qa
            JOIN quizzes q ON q.id = qa.quiz_id
            JOIN nodes n ON n.id = q.node_id
            WHERE n.project_id = ?
        `),
        papers: db.prepare(`
            SELECT COUNT(*) AS papers FROM paper_attempts pa
            JOIN nodes n ON n.id = pa.node_id
            WHERE n.project_id = ?
        `),
        mastery: db.prepare(`
            SELECT COUNT(*) AS tracked,
                   SUM(CASE WHEN m.mastery_score >= ? THEN 1 ELSE 0 END) AS proven,
                   AVG(m.mastery_score) AS average
            FROM node_mastery m
            JOIN nodes n ON n.id = m.node_id
            WHERE n.project_id = ? AND ${WORK_LEAF}
        `),
    };
    return stmts;
}

/** A count that may legitimately be absent reads as 0, never as null. */
const n = (value) => Number(value) || 0;

/**
 * Is every unit of work in this project done?
 *
 * `server/progress.js`'s rule, per row: a topic is done when closed or every card
 * on it is met; a project with no topics, when every card is met. Never the
 * rolled-up fraction compared to 1, which rounds away the last card of a big deck.
 */
function isFinished(leaves, cards) {
    if (leaves.length) return leaves.every(row => topicFraction(row) >= 1);
    return cards.total > 0 && cards.met >= cards.total;
}

/**
 * Everything the finished-project screen draws, for one project.
 *
 * Always a payload, finished or not (null only for an unknown project); `complete`
 * alone decides whether anything is shown.
 */
export function projectCompletion(projectId) {
    const id = Number(projectId);
    const s = statements();
    const project = s.project.get(id);
    if (!project) return null;

    const leaves = s.leaves.all(id);
    const cardRow = s.cards.get(id) || {};
    const cards = { total: n(cardRow.total), met: n(cardRow.met) };

    const topics = {
        total: leaves.length,
        completed: leaves.filter(r => r.status === 'completed').length,
        skipped: leaves.filter(r => r.status === 'skipped').length,
    };

    const finished = isFinished(leaves, cards);
    // Skipping every topic reaches 100% but is no achievement: the screen never
    // opens itself for it (the menu entry still reaches the summary).
    const didSomething = topics.completed > 0 || cards.met > 0;
    const complete = finished && didSomething;

    const celebrated = celebratedProjects().has(id);
    // Reopened since: clear it here, on the read, rather than hook every edit.
    if (!complete && celebrated) clearCelebrated(id);

    const activityDays = s.activity.all(id, id, id);
    const span = activitySpan(activityDays);
    const reviews = s.reviews.get(id) || {};
    const answers = s.answers.get(id) || {};
    const threshold = parseFloat(getSetting('mastery_threshold') || '0.85') || 0.85;
    const mastery = s.mastery.get(threshold, id) || {};

    const answered = n(answers.answers);
    const correct = n(answers.correct);

    return {
        complete,
        celebrated: complete && celebrated,
        project: {
            id: project.id,
            name: project.name,
            icon: project.icon,
            color: project.color,
            status: project.status || 'active',
            deadline: project.deadline || null,
            startDate: project.start_date || null,
        },
        work: {
            fraction: projectProgress(id).fraction,
            topics,
            cards,
        },
        effort: {
            reviews: n(reviews.reviews),
            cardsSeen: n(reviews.cardsSeen),
            answers: answered,
            correct,
            // Null, not 0: "none answered" is not "all wrong".
            accuracy: answered > 0 ? correct / answered : null,
            sittings: n(answers.sittings),
            quizzes: n(s.quizzes.get(id)?.quizzes),
            papers: n(s.papers.get(id)?.papers),
        },
        mastery: {
            tracked: n(mastery.tracked),
            proven: n(mastery.proven),
            average: mastery.tracked ? Number(mastery.average) : null,
            threshold,
        },
        span,
        // Against the plan, positive = early, measured to the last day of activity,
        // not to today.
        schedule: project.deadline && span
            ? { deadline: project.deadline, daysEarly: daysBetween(span.lastDay, project.deadline) }
            : null,
        timeline: bucketActivity(activityDays),
    };
}
