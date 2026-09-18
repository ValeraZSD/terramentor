import db, { NOW_ISO } from './database.js';
import { calculatePace, daysUntil, getValidStudyDates } from './scheduling.js';
import { reviewDue } from './decks.js';
import { TOPIC_NODE, isPagination } from './nodeRole.js';

/**
 * Cross-project "Today" aggregation.
 *
 * One consolidated snapshot for the global Today hub: what's scheduled today,
 * what's overdue, due flashcards, decaying mastery, per-project pace, and what
 * the learner already did today — across all *active* projects.
 *
 * Deliberately purpose-built SQL (single pass per concern) instead of looping
 * generateDailyPlan() per project: that runs 7 queries each, including work the
 * hub never renders (DAG unlock checks, mastery stats, recommendations).
 */

// Payload caps: the hub shows a triage view, not an exhaustive list. True
// counts always travel alongside so the UI can say "and 12 more".
const TASKS_PER_PROJECT = 8;
const DECAYING_LIMIT = 15;
const COMPLETED_NODES_LIMIT = 10;

// Leaf predicate shared by every task query: a real (non-note) node with no
// non-note *children*. Notes are content attached to a topic, not units of
// work — the feed teaches a node's note children as that node's own material
// (see notesStmt in feed.js) — so a topic whose only children are notes is
// still a leaf. Structure comes from non-note children alone.
//
// Exported so no consumer can drift from this definition: the project
// summary counts (index.js), the mastery gate, dailyPlan.js, feed.js and the
// frontend's tree.ts all mean the same thing by "leaf".
export const LEAF_NODE = `
    n.is_note = 0
    AND (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = n.id AND c.is_note = 0) = 0
`;

// A leaf that is a UNIT OF WORK: structurally a leaf, and a topic rather than a
// slice of an imported deck's card order (server/nodeRole.js).
//
// The two are not the same question and conflating them cost a real number: a
// deck switched to teaching read "0 / 57 items" because 25 of those 57 leaves
// were "Stage N" containers the importer cut out of card order. Nobody ever
// finishes one, so that project's progress could never pass 56% and its
// dashboard said 0% complete with 521 cards studied.
//
// LEAF_NODE keeps the structural meaning — the tree's own leaf query and
// tools/leaf-invariant.mjs are about shape, and a stage IS a leaf. Everything
// that counts, plans, schedules or serves WORK uses this instead.
export const WORK_LEAF = `${LEAF_NODE} AND ${TOPIC_NODE}`;

// The same rule over an in-memory tree, for the callers that have already built
// one and cannot run SQL against it. Mirrors `structuralChildren`/`isLeafNode`
// in src/utils/tree.ts. Kept here so the SQL and the JS sit side by side: the
// project dashboard's segment collector tested `children.length` instead and
// so drew no segment for a topic whose only children are notes — the fifth
// site of this convention to get it wrong.
export const structuralChildren = (node) => (node?.children || []).filter(c => !c.is_note);

/**
 * WORK_LEAF over a flat list of rows already in hand — the mirror for callers
 * that have built a tree and cannot run SQL against it (the study dashboard's
 * progress, the scheduler's leaf walk).
 *
 * Takes non-note rows; a note child still makes its parent structural here, so
 * pass the same set the SQL would see (`is_note = 0`).
 */
export function workLeaves(nodes) {
    const parents = new Set((nodes || []).map(n => n.parent_id).filter(id => id != null));
    return (nodes || []).filter(n => !n.is_note && !parents.has(n.id) && !isPagination(n));
}

// A leaf that still needs work — the task-serving half of the definition.
//
// Structural on purpose: the FEED serves cards through the node they hang off,
// so an imported deck reaches the home page as its stages (marked untaught,
// see getFocusNodes). Dropping them here would take a 5,000-card collection
// out of the feed entirely.
export const OPEN_LEAF = `
    ${LEAF_NODE}
    AND n.status NOT IN ('completed', 'skipped')
`;

// …and the same thing for the callers that mean WORK: what is scheduled, what
// is overdue, what to plan, what is left to do. A slice of card order is none
// of those.
export const OPEN_WORK_LEAF = `
    ${WORK_LEAF}
    AND n.status NOT IN ('completed', 'skipped')
`;

export const ACTIVE_PROJECT_JOIN = `JOIN projects p ON p.id = n.project_id AND COALESCE(p.status, 'active') = 'active'`;

/**
 * Time left on a project's deadline, counted two ways.
 *
 * `daysLeft` is plain calendar days on the app's ONE definition (`daysUntil`:
 * 0 means the deadline is today, negative means it has passed) — the same
 * number the feed header and the checkpoint card already show, so no two
 * screens can disagree about how long is left. `studyDaysLeft` counts only the
 * days the learner actually studies on and DOES include today, so on a
 * study-every-day project it reads one higher than `daysLeft` — the two answer
 * different questions ("how long until the date" vs "how many sessions do I
 * have"), and the second is the one that decides whether the work fits.
 *
 * All arithmetic is UTC-midnight (parseDate), per the app-wide date rule.
 * Returns null for a project with no deadline, which is a normal state (the
 * Inbox is deliberately never scheduled), never an error.
 */
export function deadlineInfo(project, today) {
    if (!project?.deadline) return null;
    const daysLeft = daysUntil(project.deadline, today);
    let studyDaysLeft = null;
    if (daysLeft >= 0) {
        let studyDays = [1, 2, 3, 4, 5];
        try {
            const parsed = JSON.parse(project.study_days || '[1,2,3,4,5]');
            if (Array.isArray(parsed) && parsed.length) studyDays = parsed;
        } catch { /* keep the weekday default */ }
        studyDaysLeft = getValidStudyDates(today, project.deadline, studyDays).length;
    } else {
        studyDaysLeft = 0;
    }
    return {
        deadline: project.deadline,
        daysLeft,
        studyDaysLeft,
        passed: daysLeft < 0,
    };
}

export function buildTodayData({ decayDays = 14 } = {}) {
    const today = new Date().toISOString().split('T')[0];

    const activeProjects = db.prepare(`
        SELECT id, name, color, icon, start_date, deadline, study_days
        FROM projects
        WHERE COALESCE(status, 'active') = 'active'
        ORDER BY position ASC, created_at ASC
    `).all();

    const overdueRows = db.prepare(`
        SELECT n.id, n.project_id, n.title, n.scheduled_start, n.scheduled_end, n.status
        FROM nodes n
        ${ACTIVE_PROJECT_JOIN}
        WHERE ${OPEN_WORK_LEAF}
          AND n.scheduled_end < ?
        ORDER BY n.scheduled_end ASC
    `).all(today);

    const todayRows = db.prepare(`
        SELECT n.id, n.project_id, n.title, n.scheduled_start, n.scheduled_end, n.status
        FROM nodes n
        ${ACTIVE_PROJECT_JOIN}
        WHERE ${OPEN_WORK_LEAF}
          AND n.scheduled_start <= ?
          AND n.scheduled_end >= ?
        ORDER BY n.position ASC
    `).all(today, today);

    const dueFlashcardCounts = db.prepare(`
        SELECT n.project_id, COUNT(*) AS count
        FROM flashcards f
        JOIN nodes n ON n.id = f.node_id
        ${ACTIVE_PROJECT_JOIN}
        WHERE ${reviewDue('f')}
        GROUP BY n.project_id
    `).all();

    // last_updated is written by SQLite's CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS',
    // UTC). Compare in the same format — an ISO string sorts after every same-day
    // SQLite timestamp, silently widening the window by a day (see mastery.js).
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - decayDays);
    const cutoffStr = cutoffDate.toISOString().slice(0, 19).replace('T', ' ');

    const decayingRows = db.prepare(`
        SELECT nm.node_id, n.project_id, nm.mastery_score, nm.last_updated, n.title
        FROM node_mastery nm
        JOIN nodes n ON n.id = nm.node_id
        ${ACTIVE_PROJECT_JOIN}
        WHERE nm.mastery_score > 0.5
          AND nm.last_updated < ?
          AND n.status != 'skipped'
          AND n.is_note = 0
        ORDER BY nm.last_updated ASC
    `).all(cutoffStr);

    // "What I did today" — completed_at is an ISO string, quiz_attempts.created_at
    // and learning_sessions.created_at are SQLite CURRENT_TIMESTAMP; date() parses
    // both to a UTC calendar date, matching the app's UTC date convention.
    const completedNodes = db.prepare(`
        SELECT n.id, n.project_id, n.title, n.status
        FROM nodes n
        ${ACTIVE_PROJECT_JOIN}
        WHERE ${WORK_LEAF}
          AND n.status IN ('completed', 'skipped')
          AND date(n.completed_at) = ?
        ORDER BY n.completed_at DESC
        LIMIT ${COMPLETED_NODES_LIMIT}
    `).all(today);

    const quizAttemptsToday = db.prepare(`
        SELECT COUNT(*) AS count
        FROM quiz_attempts qa
        JOIN quizzes q ON q.id = qa.quiz_id
        JOIN nodes n ON n.id = q.node_id
        ${ACTIVE_PROJECT_JOIN}
        WHERE date(qa.created_at) = ?
    `).get(today);

    const flashcardsReviewedToday = db.prepare(`
        SELECT COUNT(*) AS count
        FROM flashcards f
        JOIN nodes n ON n.id = f.node_id
        ${ACTIVE_PROJECT_JOIN}
        WHERE date(f.last_reviewed) = ? AND f.stability IS NOT NULL
    `).get(today);

    const studyToday = db.prepare(`
        SELECT COALESCE(SUM(duration_seconds), 0) AS seconds
        FROM learning_sessions
        WHERE date(created_at) = ?
    `).get(today);

    // Assemble per-project sections.
    const flashcardsByProject = new Map(dueFlashcardCounts.map(r => [r.project_id, r.count]));
    const groupByProject = (rows) => {
        const map = new Map();
        for (const row of rows) {
            if (!map.has(row.project_id)) map.set(row.project_id, []);
            map.get(row.project_id).push(row);
        }
        return map;
    };
    const overdueByProject = groupByProject(overdueRows);
    const todayByProject = groupByProject(todayRows);
    const decayingByProject = groupByProject(decayingRows.map(r => ({ ...r, project_id: r.project_id })));

    const toTask = ({ id, title, scheduled_start, scheduled_end, status }) =>
        ({ id, title, scheduled_start, scheduled_end, status });

    const projects = activeProjects.map(p => {
        const overdue = overdueByProject.get(p.id) || [];
        const todays = todayByProject.get(p.id) || [];
        // Pace only exists for scheduled projects; guard like buildInsightContext.
        let pace = null;
        if (p.start_date && p.deadline) {
            try { pace = calculatePace(p.id); } catch { pace = null; }
        }
        return {
            id: p.id,
            name: p.name,
            color: p.color,
            icon: p.icon,
            pace,
            deadline: deadlineInfo(p, today),
            overdueTasks: overdue.slice(0, TASKS_PER_PROJECT).map(toTask),
            todayTasks: todays.slice(0, TASKS_PER_PROJECT).map(toTask),
            counts: {
                overdue: overdue.length,
                today: todays.length,
                dueFlashcards: flashcardsByProject.get(p.id) || 0,
                decaying: (decayingByProject.get(p.id) || []).length,
            },
        };
    });

    return {
        date: today,
        projects,
        decayingTopics: decayingRows.slice(0, DECAYING_LIMIT).map(r => ({
            nodeId: r.node_id,
            projectId: r.project_id,
            title: r.title,
            masteryScore: r.mastery_score,
            lastUpdated: r.last_updated,
        })),
        completedToday: {
            nodes: completedNodes.map(n => ({ id: n.id, projectId: n.project_id, title: n.title, status: n.status })),
            quizAttempts: quizAttemptsToday?.count || 0,
            flashcardsReviewed: flashcardsReviewedToday?.count || 0,
            studySeconds: studyToday?.seconds || 0,
        },
        totals: {
            overdue: overdueRows.length,
            today: todayRows.length,
            dueFlashcards: [...flashcardsByProject.values()].reduce((a, b) => a + b, 0),
            decaying: decayingRows.length,
            activeProjects: activeProjects.length,
        },
    };
}

// Caps for the AI briefing context: a 9–14B local model follows a short,
// concrete brief far better than a long one, so counts stand in for lists
// beyond the first few items.
const BRIEFING_MAX_PROJECTS = 6;
const BRIEFING_TASKS_PER_LIST = 3;
const BRIEFING_COMPLETED_TITLES = 5;
const USER_PROFILE_MAX_CHARS = 3000; // mirrors ai.js / Settings → About You
// How near a deadline has to be before it changes triage order on its own.
const DEADLINE_PRESSURE_DAYS = 14;

/**
 * Condensed cross-project snapshot for the AI daily briefing and the global
 * planning chat. Reuses buildTodayData, then compresses hard: the most urgent
 * projects first, top-3 task titles per list, counts for everything else.
 */
export function buildTodayBriefingContext({ decayDays = 14 } = {}) {
    const data = buildTodayData({ decayDays });

    // A near deadline is urgent on its own: a project with nothing due today but
    // an exam on Friday outranks one that is mildly behind with three months to
    // run. The term is deliberately steep and short-range (nothing beyond a
    // fortnight moves the order) so it sharpens triage without drowning the
    // overdue signal, which stays the dominant one.
    const deadlinePressure = (p) => {
        const d = p.deadline;
        if (!d || d.passed) return 0;
        return d.daysLeft <= DEADLINE_PRESSURE_DAYS
            ? (DEADLINE_PRESSURE_DAYS - d.daysLeft + 1) * 2
            : 0;
    };

    const urgency = (p) =>
        p.counts.overdue * 10
        + (p.pace ? Math.max(0, p.pace.daysBehind || 0) : 0)
        + p.counts.today * 2
        + p.counts.dueFlashcards
        + deadlinePressure(p);

    const projects = data.projects
        // A looming deadline earns a slot even with an empty queue today — that
        // is exactly the project the learner needs told about.
        .filter(p => p.counts.overdue || p.counts.today || p.counts.dueFlashcards || p.counts.decaying
            || deadlinePressure(p) > 0)
        .sort((a, b) => urgency(b) - urgency(a))
        .slice(0, BRIEFING_MAX_PROJECTS)
        .map(p => ({
            projectId: p.id,
            name: p.name,
            paceStatus: p.pace?.paceStatus || 'no_schedule',
            daysBehind: p.pace?.daysBehind || 0,
            ...(p.deadline ? {
                deadline: p.deadline.deadline,
                daysLeft: p.deadline.daysLeft,
                studyDaysLeft: p.deadline.studyDaysLeft,
                ...(p.deadline.passed ? { deadlinePassed: true } : {}),
            } : {}),
            overdueCount: p.counts.overdue,
            overdue: p.overdueTasks.slice(0, BRIEFING_TASKS_PER_LIST).map(t => ({ nodeId: t.id, title: t.title })),
            todayCount: p.counts.today,
            today: p.todayTasks.slice(0, BRIEFING_TASKS_PER_LIST).map(t => ({ nodeId: t.id, title: t.title })),
            dueFlashcards: p.counts.dueFlashcards,
            decayingCount: p.counts.decaying,
        }));

    let learnerProfile = null;
    try {
        const profile = db.prepare("SELECT value FROM settings WHERE key = 'user_profile'").get();
        const text = profile?.value?.trim();
        if (text) learnerProfile = text.slice(0, USER_PROFILE_MAX_CHARS);
    } catch { }

    return {
        date: data.date,
        totals: data.totals,
        projects,
        completedToday: data.completedToday.nodes.slice(0, BRIEFING_COMPLETED_TITLES).map(n => n.title),
        quizAttemptsToday: data.completedToday.quizAttempts,
        flashcardsReviewedToday: data.completedToday.flashcardsReviewed,
        learnerProfile,
    };
}

/**
 * Scheduled leaves of all active projects overlapping [from, to] — the global
 * calendar feed. Dates are the app-standard UTC YYYY-MM-DD strings.
 */
/**
 * "What did I actually do today?" — the ledger behind the feed header's chips.
 *
 * Every row here is a real record with its own timestamp: a flashcard answer
 * (`review_log`), a graded answer (`mastery_evidence`), a lesson the reader
 * consumed (`feed_items`) or a topic closed (`nodes.completed_at`). Nothing is
 * derived from a counter, so the list can always be reconciled against the
 * numbers above it.
 *
 * Two counting rules, both inherited rather than invented:
 *   - **Cards and answers are different numbers.** The (re)learning ladder can
 *     ask one card three times in an afternoon, so `cards` is DISTINCT card ids
 *     and `answers` is rows — the same distinction the review-session summary
 *     draws, and the reason "you reviewed 92 flashcards" out of a deck of 88 is
 *     a sentence that cannot be true.
 *   - **Accuracy is the feed's**, over `metadata.source = "feed"` evidence and
 *     nothing else, because that is exactly what the header chip counts. Other
 *     evidence (a Boss Fight, a paper attempt, a placement probe) still appears
 *     as an event, tagged with what it was — it just doesn't move that number.
 *
 * Scoped to ACTIVE projects, like every other number on the home page.
 */
const ACTIVITY_EVENT_CAP = 250;

// SQLite renders CURRENT_TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' while JS writers
// store 'YYYY-MM-DDTHH:MM:SS.sssZ'. strftime normalises both to one ISO shape,
// so the client can `new Date()` every row without sniffing the format.
const AS_ISO = (col) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`;

const RATING_LABEL = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

export function buildTodayActivity(date) {
    const today = date || new Date().toISOString().split('T')[0];

    const cardRows = db.prepare(`
        SELECT ${AS_ISO('rl.reviewed_at')} AS at, rl.rating, rl.card_id,
               f.front, n.id AS node_id, n.title AS node_title,
               p.id AS project_id, p.name AS project_name, p.color AS project_color
        FROM review_log rl
        JOIN flashcards f ON f.id = rl.card_id
        JOIN nodes n ON n.id = f.node_id
        JOIN projects p ON p.id = n.project_id AND COALESCE(p.status, 'active') = 'active'
        WHERE rl.source = 'app' AND date(rl.reviewed_at) = ?
        ORDER BY rl.reviewed_at DESC
    `).all(today);

    const evidenceRows = db.prepare(`
        SELECT ${AS_ISO('me.created_at')} AS at, me.score, me.total, me.evidence_type, me.metadata,
               n.id AS node_id, n.title AS node_title,
               p.id AS project_id, p.name AS project_name, p.color AS project_color
        FROM mastery_evidence me
        JOIN nodes n ON n.id = me.node_id
        JOIN projects p ON p.id = n.project_id AND COALESCE(p.status, 'active') = 'active'
        WHERE date(me.created_at) = ?
        ORDER BY me.created_at DESC
    `).all(today);

    const lessonRows = db.prepare(`
        SELECT ${AS_ISO('fi.consumed_at')} AS at, fi.seq,
               n.id AS node_id, n.title AS node_title,
               p.id AS project_id, p.name AS project_name, p.color AS project_color
        FROM feed_items fi
        JOIN nodes n ON n.id = fi.node_id
        JOIN projects p ON p.id = n.project_id AND COALESCE(p.status, 'active') = 'active'
        WHERE fi.kind = 'lesson' AND fi.status = 'consumed' AND date(fi.consumed_at) = ?
        ORDER BY fi.consumed_at DESC
    `).all(today);

    const topicRows = db.prepare(`
        SELECT ${AS_ISO('n.completed_at')} AS at, n.status,
               n.id AS node_id, n.title AS node_title,
               p.id AS project_id, p.name AS project_name, p.color AS project_color
        FROM nodes n
        JOIN projects p ON p.id = n.project_id AND COALESCE(p.status, 'active') = 'active'
        WHERE n.is_note = 0 AND n.status IN ('completed', 'skipped')
          AND date(n.completed_at) = ?
        ORDER BY n.completed_at DESC
    `).all(today);

    const base = (r) => ({
        at: r.at,
        projectId: r.project_id,
        projectName: r.project_name,
        projectColor: r.project_color,
        nodeId: r.node_id,
        nodeTitle: r.node_title,
    });

    const events = [];

    for (const r of cardRows) {
        events.push({
            ...base(r),
            kind: 'card',
            title: (r.front || '').slice(0, 160),
            detail: RATING_LABEL[r.rating] || `Rating ${r.rating}`,
            // "Again" is the only rating that means the answer was not recalled;
            // Hard/Good/Easy are all successful recalls at different costs. That
            // is FSRS's own reading, and it is why a session with many Hards is
            // not a bad session.
            correct: r.rating > 1,
        });
    }

    let feedAnswered = 0, feedCorrect = 0;
    for (const r of evidenceRows) {
        let meta = null;
        try { meta = r.metadata ? JSON.parse(r.metadata) : null; } catch { /* a bad blob is not an error here */ }
        const fromFeed = meta?.source === 'feed';
        if (fromFeed) { feedAnswered += r.total; feedCorrect += r.score; }
        events.push({
            ...base(r),
            kind: 'question',
            source: fromFeed ? 'feed' : (r.evidence_type || 'quiz'),
            title: r.node_title,
            detail: r.total === 1
                ? (r.score >= 1 ? 'Correct' : 'Wrong')
                : `${Math.round(r.score)} of ${r.total} correct`,
            correct: r.total > 0 ? r.score / r.total >= 0.5 : null,
        });
    }

    for (const r of lessonRows) {
        events.push({
            ...base(r),
            kind: 'lesson',
            title: r.node_title,
            // seq is `lesson i*2 - 1` (see feedGen.js), so the part number reads
            // back out of it. A lesson with no parts still says "Lesson".
            detail: r.seq > 0 ? `Part ${Math.ceil(r.seq / 2)}` : 'Lesson',
            correct: null,
        });
    }

    for (const r of topicRows) {
        events.push({
            ...base(r),
            kind: 'topic',
            title: r.node_title,
            detail: r.status === 'skipped' ? 'Skipped' : 'Completed',
            correct: null,
        });
    }

    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    const cards = new Set(cardRows.map(r => r.card_id)).size;
    const byProject = new Map();
    for (const e of events) {
        const cur = byProject.get(e.projectId) || {
            projectId: e.projectId, name: e.projectName, color: e.projectColor, events: 0,
        };
        cur.events += 1;
        byProject.set(e.projectId, cur);
    }

    return {
        date: today,
        summary: {
            cards,
            cardAnswers: cardRows.length,
            againAnswers: cardRows.filter(r => r.rating === 1).length,
            lessonsRead: lessonRows.length,
            topicsClosed: topicRows.length,
            questionsAnswered: feedAnswered,
            questionsCorrect: feedCorrect,
            accuracy: feedAnswered > 0 ? feedCorrect / feedAnswered : null,
            otherAssessments: evidenceRows.length - events.filter(e => e.kind === 'question' && e.source === 'feed').length,
        },
        projects: Array.from(byProject.values()).sort((a, b) => b.events - a.events),
        events: events.slice(0, ACTIVITY_EVENT_CAP),
        truncated: Math.max(0, events.length - ACTIVITY_EVENT_CAP),
    };
}

export function buildCalendarRange(from, to) {
    const tasks = db.prepare(`
        SELECT n.id AS nodeId, n.project_id AS projectId, n.title, n.status,
               n.scheduled_start, n.scheduled_end
        FROM nodes n
        ${ACTIVE_PROJECT_JOIN}
        WHERE ${WORK_LEAF}
          AND n.scheduled_start IS NOT NULL
          AND n.scheduled_end IS NOT NULL
          AND n.scheduled_start <= ?
          AND n.scheduled_end >= ?
        ORDER BY n.scheduled_start ASC, n.position ASC
    `).all(to, from);

    const projects = db.prepare(`
        SELECT id, name, color
        FROM projects
        WHERE COALESCE(status, 'active') = 'active'
        ORDER BY position ASC, created_at ASC
    `).all();

    return { projects, tasks };
}
