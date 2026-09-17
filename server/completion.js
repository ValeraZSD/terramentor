// server/completion.js — the record of a finished project.
//
// A course ends exactly once, and until now the app said nothing about it: the
// ring reached 100%, the card went on looking like every other card, and the
// only way to close the thing was an item in an overflow menu called "Mark
// completed". Everything the learner did to get there was already in the
// database and none of it was ever shown back to them.
//
// So this module answers two questions, and deliberately no others:
//
//   Is this project finished?  — the SAME rule the progress ring uses
//                                (server/progress.js), evaluated exactly rather
//                                than by comparing its float to 1. A 5,168-card
//                                deck with 5,167 cards met is 0.9998, which
//                                rounds to 100% on the card and is NOT finished.
//   What did finishing it take? — counts, dates and a per-day activity series,
//                                every one of them a row with its own timestamp.
//
// ## Nothing here is estimated
//
// There is no "hours studied" and there never will be from this table set:
// `learning_sessions` has a `duration_seconds` column and nothing in the app
// has ever written a row to it. A number the app cannot measure has no place on
// a screen whose whole purpose is to tell someone what they really did, so the
// time axis here is DAYS — days from first to last, days with any activity at
// all, and the longest unbroken run of them.
//
// Three counting rules, all inherited from `buildTodayActivity` (server/today.js)
// rather than invented here, so the summary and the home page's chips cannot
// disagree:
//
//   • **Only work done in this app counts.** `review_log` carries an imported
//     Anki revlog too (`source` != 'app'), and a deck brought in with six years
//     of history would otherwise open its summary claiming 40,000 reviews and a
//     start date from before the app existed.
//   • **Card evidence is not a question.** `mastery_evidence` rows of type
//     `flashcard` are batched card RATINGS (server/cardEvidence.js), derived
//     from `review_log` rows that are already counted as reviews. Counting them
//     again would inflate both the answer count and the activity series.
//   • **Cards and answers are different numbers.** Reviews are rows (the
//     relearning ladder asks one card three times in an afternoon); cards seen
//     is distinct card ids.
//
// And one rule of its own, which cost a redesign to notice: **only records that
// are kept forever may appear here.** `buildTodayActivity` also counts lessons
// read (`feed_items` with a `consumed_at`), and a lesson read is exactly the
// kind of thing this screen wants to celebrate — but `server/database.js`
// deletes the whole teaching cache of every CLOSED node at startup, and in a
// finished project every node is closed. Counting them would have given a
// summary whose bars and totals quietly shrank the next time the app was
// restarted, which is the one thing a keepsake may not do. So the series is
// built from `review_log`, `mastery_evidence` and `nodes.completed_at`, all
// three of which are permanent.

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
 * Called automatically when a project that WAS finished is no longer finished —
 * a topic reopened, a chapter added, a deck extended. Finishing it a second time
 * is a real event and deserves the screen again; without this, adding one topic
 * to a finished course would silently cost the learner the ending forever.
 */
export function clearCelebrated(projectId) {
    const ids = celebratedProjects();
    if (!ids.delete(Number(projectId))) return;
    writeCelebrated(ids);
}

/* ── the activity series ─────────────────────────────────────────────────── */

/**
 * Bucket sizes in days, widest-last. The first that fits the whole span into
 * `MAX_BUCKETS` wins, so a two-week project draws fourteen daily bars and a
 * three-year one draws quarters — one code path, and the bar count never
 * depends on how long somebody studied.
 *
 * Uniform day-sized buckets rather than calendar weeks or months on purpose:
 * a calendar bucket is ragged at both ends (a project that started on a Friday
 * opens with a two-day "week"), and the axis here is labelled with the real
 * first and last dates, so the buckets never have to name themselves.
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
 * Pure, and the reason it is pure: this decides what the one chart on the
 * screen looks like, and `tools/completion-gates.mjs` asserts the bar count and
 * the totals for every span from one day to ten years without a browser.
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
 * "Unbroken" is calendar days, not study days: a learner who works Monday to
 * Friday has a five-day streak and knows it, and a definition that skipped
 * weekends would have to know which days they meant to study — which is the
 * `study_days` setting, a plan, not a record of what happened.
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

// Work leaves with their card counts — the SAME set and the same two columns
// `server/progress.js` rolls up, so "finished" here and "100%" on the card are
// one decision evaluated twice rather than two rules that agree by luck.
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

// Every dated thing the learner DID, one row per calendar day (UTC, like every
// other date in the app). Four sources, unioned rather than joined: they have
// nothing in common but a timestamp, and a join would multiply them.
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
 * Exactly `server/progress.js`'s rule, one row at a time: a topic is done when
 * it is closed OR every card on it has been met, and a project with no topics
 * at all is done when every card in it has been met. Comparing the rolled-up
 * FRACTION to 1 would be the same test in almost every case and wrong in the
 * one that matters — the last card of a five-thousand-card deck.
 */
function isFinished(leaves, cards) {
    if (leaves.length) return leaves.every(row => topicFraction(row) >= 1);
    return cards.total > 0 && cards.met >= cards.total;
}

/**
 * Everything the finished-project screen draws, for one project.
 *
 * Always returns a payload, finished or not: the caller asks "is this done, and
 * if so what happened", and a 404-shaped answer for "not yet" would make the
 * client guess. `complete` is the only field that decides whether anything is
 * shown.
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
    // A project where nothing was ever actually done is not an achievement.
    // Skipping every topic in a course reaches 100% by the progress rule — it is
    // a legitimate way to close a project and it is not a thing to congratulate
    // anyone for, so the screen never opens itself for it. (The menu entry still
    // reaches the summary; it just will not interrupt.)
    const didSomething = topics.completed > 0 || cards.met > 0;
    const complete = finished && didSomething;

    const celebrated = celebratedProjects().has(id);
    // Self-healing: a project that was finished and no longer is has earned its
    // ending back. Doing it on the read keeps the rule in one place instead of
    // hooking every edit that could reopen a topic.
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
            // Null, not 0: "no questions were answered" and "every question was
            // wrong" are different facts and the screen shows neither as 0%.
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
        // Against the plan, if there was one. Positive is early. Deliberately
        // measured to the last day of real activity rather than to today: a
        // summary opened in December must not say a course finished in August
        // was four months late.
        schedule: project.deadline && span
            ? { deadline: project.deadline, daysEarly: daysBetween(span.lastDay, project.deadline) }
            : null,
        timeline: bucketActivity(activityDays),
    };
}
