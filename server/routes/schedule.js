// /api/schedule and a project's schedule, recalibration, pace and weights.
//
// Mounted in 2 blocks (see createApp in server/app.js), because the server
// registers other areas' routes between them and Express matches in registration
// order. A new route goes in the block it belongs with.
import db from '../database.js';
import {
    allocateSchedule, calculatePace, lockedDeadlineError, persistSchedule, readStudyDays,
    recalibrateSchedule, removeSchedule, scheduleWindowError, countStudyDays,
} from '../scheduling.js';
import { projectCountsInCards } from '../progress.js';
import { OPEN_WORK_LEAF, WORK_LEAF } from '../today.js';
import { isNodeWeight } from '../curriculumSchema.js';
import { projectTeaches } from '../nodeRole.js';
import { requireProject } from './projectRows.js';
import { routeTable } from './routeTable.js';
import { apiError, errorBody, errorFields, keyed } from '../clientError.js';
import { studyToday } from '../studyDay.js';
import { refreshTopicDates } from '../topicDates.js';
import { libraryPace, projectVerdict } from '../pace.js';

let openTopic = null;
const openTopicStmt = () => (openTopic ??= db.prepare(`
    SELECT 1 FROM nodes n WHERE n.project_id = ? AND ${OPEN_WORK_LEAF} LIMIT 1
`));

const app = routeTable('schedule');

// SCHEDULING ROUTES

/**
 * Cross-project scheduling overview — one row per project for the schedule
 * board, where every project shares ONE horizontal time axis.
 *
 * The board's whole point is seeing which projects overlap and where the
 * crunch is, so it needs three things the projects list alone cannot answer:
 * how many open leaves a drag would reschedule (the confirm dialog quotes it,
 * and a number the learner can check is what makes an irreversible-feeling
 * action safe to accept), and the ACTUAL extent of the scheduled topics.
 *
 * That extent is the honest half. `projects.start_date` / `deadline` are the
 * declared window; the topics inside it carry their own dates and the two can
 * disagree — after a manual node edit, or a window moved without rescheduling.
 * A board that drew only the declared window would render that disagreement
 * invisible, which is exactly the lie the drag-then-confirm flow exists to
 * avoid. So both are returned and the client draws the drift.
 */
app.get('/api/schedule/overview', (req, res) => {
    try {
        const projects = db.prepare(`
            SELECT id, uuid, name, color, icon, position, status,
                   start_date, deadline, deadline_fixed, study_days
            FROM projects
            WHERE COALESCE(status, 'active') != 'archived'
            ORDER BY position ASC, id ASC
        `).all();

        // Leaf counts and true scheduled extent, per project, in two grouped
        // passes rather than a query per project.
        const openCounts = new Map(db.prepare(`
            SELECT n.project_id AS pid, COUNT(*) AS c
            FROM nodes n WHERE ${OPEN_WORK_LEAF} GROUP BY n.project_id
        `).all().map(r => [r.pid, r.c]));

        const leafCounts = new Map(db.prepare(`
            SELECT n.project_id AS pid, COUNT(*) AS c
            FROM nodes n WHERE ${WORK_LEAF} GROUP BY n.project_id
        `).all().map(r => [r.pid, r.c]));

        refreshTopicDates();
        const extents = new Map(db.prepare(`
            SELECT n.project_id AS pid,
                   MIN(n.scheduled_start) AS first_start,
                   MAX(n.scheduled_end)   AS last_end,
                   COUNT(n.scheduled_start) AS scheduled_count
            FROM plan_nodes n
            WHERE ${WORK_LEAF} AND n.scheduled_start IS NOT NULL
            GROUP BY n.project_id
        `).all().map(r => [r.pid, r]));

        // Cards, and how many have stopped being strangers — the same pair, by
        // the same rule, as `PROJECT_SUMMARY_SQL` (server/projectSummary.js).
        // A collection of cards has no topics to count, so a board that knows
        // only about topics says "0 / 1 topic done" about 300 cards, while the
        // Projects grid beside it says how many are met. Grouped in one pass
        // rather than joined row-wise: nodes × flashcards fans out.
        const cardCounts = new Map(db.prepare(`
            SELECT n.project_id AS pid,
                   COUNT(*) AS cards,
                   SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL
                            THEN 1 ELSE 0 END) AS seen
            FROM flashcards f
            JOIN nodes n ON n.id = f.node_id
            GROUP BY n.project_id
        `).all().map(r => [r.pid, r]));

        // The learner's record, read once for every dated row (server/pace.js).
        const library = projects.some(p => p.deadline) ? libraryPace() : null;

        const rows = projects.map(p => {
            const ext = extents.get(p.id) || {};
            // Pace — how far through the plan says you should be against how
            // far you are. `calculatePace` is the SAME function the project
            // card, the study dashboard and the phase bars read, so this board
            // cannot print a different number for the same project; its
            // `message` is deliberately dropped, because server-written text
            // stays English and the client builds the sentence from these
            // fields through i18n. Only asked of a project that HAS a window:
            // without one it returns `no_schedule` after a single lookup.
            let pace = null;
            if (p.start_date && p.deadline) {
                try {
                    const full = calculatePace(p.id);
                    pace = {
                        paceStatus: full.paceStatus,
                        expectedProgress: full.expectedProgress,
                        actualProgress: full.actualProgress,
                        drift: full.drift ?? 0,
                        totalDays: full.totalDays ?? 0,
                    };
                } catch { pace = null; }
            }
            const cc = cardCounts.get(p.id) || {};
            return {
                ...p,
                openLeaves: openCounts.get(p.id) || 0,
                totalLeaves: leafCounts.get(p.id) || 0,
                scheduledLeaves: ext.scheduled_count || 0,
                firstScheduledStart: ext.first_start || null,
                lastScheduledEnd: ext.last_end || null,
                cardCount: cc.cards || 0,
                seenCardCount: cc.seen || 0,
                // Whether its topics may be taught, which is half of "is this
                // measured in topics or in cards" — the other half is having no
                // topics at all. Two indexed lookups per project, the same call
                // the grid's row makes.
                teaches: projectTeaches(p.id),
                pace,
                // The date judged against the learner's own pace: needed,
                // recent and best, the band and the offers. Null without a date.
                verdict: p.deadline ? projectVerdict(p.id, { library }) : null,
            };
        });
        // The day the verdicts were judged on, even if midnight passed since.
        res.json({ projects: rows, today: library?.today ?? studyToday() });
    } catch (err) {
        console.error('[Schedule overview] Error:', err);
        res.status(500).json(errorBody(err));
    }
});

app.post('/api/projects/:id/schedule', (req, res) => {
    const { id } = req.params;
    // `hoursPerDay` is deliberately not read. It was a project column and a
    // slider, and it cancelled itself out of the allocator's arithmetic — an
    // older client may still send it, and it is ignored rather than rejected.
    const { startDate, deadline, studyDays, deadlineFixed } = req.body;

    if (!startDate || !deadline) return res.status(400).json(keyed('Start date and deadline are required.'));
    if (deadlineFixed !== undefined && typeof deadlineFixed !== 'boolean') {
        return res.status(400).json(apiError('deadlineFixed must be true or false.'));
    }
    const windowError = scheduleWindowError(startDate, deadline);
    if (windowError) return res.status(400).json(keyed(windowError));

    if (studyDays != null && (!Array.isArray(studyDays) || studyDays.length === 0)) {
        return res.status(400).json(keyed('At least one study day must be selected.'));
    }
    // Through the one reader, like PUT /api/projects/:id: deduped, 1–7 only.
    const days = readStudyDays(studyDays == null ? null : JSON.stringify(studyDays));

    if (!requireProject(req, res)) return;
    const lockError = lockedDeadlineError(id, deadline, deadlineFixed);
    if (lockError) return res.status(400).json(keyed(lockError));

    try {
        const reply = (extra) => {
            const updatedProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
            refreshTopicDates();
            const nodes = db.prepare(`
                SELECT id, project_id, parent_id, title, description, notes, status,
                       is_note, position, scheduled_start, scheduled_end, estimated_weight,
                       completed_at, created_at, updated_at
                FROM plan_nodes WHERE project_id = ?
            `).all(id);
            res.json({ success: true, project: updatedProject, nodes, ...extra });
        };

        // Only the mark changes (the same window and study days): it is written
        // alone. Laying the topics out again on the way had nothing to change,
        // and refused the mark outright when no study day was left before the
        // date (an exam tomorrow, a Saturday).
        const stored = db.prepare('SELECT start_date, deadline, study_days, deadline_fixed FROM projects WHERE id = ?').get(id);
        if (deadlineFixed !== undefined && stored
            && stored.start_date === startDate && stored.deadline === deadline
            && readStudyDays(stored.study_days).join() === days.join()
            && !!stored.deadline_fixed !== deadlineFixed) {
            db.prepare('UPDATE projects SET deadline_fixed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(deadlineFixed ? 1 : 0, id);
            return reply({ warnings: [], stats: null });
        }

        const result = allocateSchedule(id, startDate, deadline, days);
        if (!result.success) return res.status(400).json(errorFields(result));
        // A course under way with open topics and no study day left before
        // its date: the plan this write asks for cannot be laid.
        const today = studyToday();
        if (startDate < today && deadline >= today && !projectCountsInCards(id)
            && countStudyDays(today, deadline, days) === 0 && openTopicStmt().get(id)) {
            return res.status(400).json(keyed('No valid study days remaining between today and deadline.'));
        }

        // The ONE write path for a window: the window, the study week and the
        // lock. No topic date is written; every reader derives them from this
        // row and the record (server/topicDates.js), so a course under way has
        // its open topics from today and a missed week never reads as overdue.
        db.transaction(() => {
            persistSchedule(id, result.assignments, result.baselineSnapshot, {
                startDate, deadline, studyDays: days,
            });
            if (deadlineFixed !== undefined) {
                db.prepare('UPDATE projects SET deadline_fixed = ? WHERE id = ?').run(deadlineFixed ? 1 : 0, id);
            }
        })();

        reply({ warnings: result.warnings, stats: result.stats });
    } catch (err) {
        console.error('[Schedule] Error:', err);
        res.status(500).json(errorBody(err));
    }
});

app.post('/api/projects/:id/recalibrate', (req, res) => {
    const { id } = req.params;
    if (!requireProject(req, res)) return;

    try {
        const result = recalibrateSchedule(id);
        if (!result.success) {
            return res.status(400).json({ ...errorFields(result), suggestedDeadline: result.suggestedDeadline });
        }
        if (result.unchanged) return res.json({ success: true, message: 'All tasks completed!', unchanged: true });

        // Nothing to write: open topics already run from today on every read.
        refreshTopicDates();
        const nodes = db.prepare(`
            SELECT id, project_id, parent_id, title, description, notes, status,
                   is_note, position, scheduled_start, scheduled_end, estimated_weight,
                   completed_at, created_at, updated_at
            FROM plan_nodes WHERE project_id = ?
        `).all(id);

        res.json({ success: true, nodes, warnings: result.warnings, stats: result.stats });
    } catch (err) {
        console.error('[Recalibrate] Error:', err);
        res.status(500).json(errorBody(err));
    }
});

app.get('/api/projects/:id/pace', (req, res) => {
    const { id } = req.params;
    if (!requireProject(req, res)) return;
    try {
        const pace = calculatePace(id);
        // The date judged against the learner's own pace, and the weeks it was
        // judged from (in the verdict's unit), beside the plan-based numbers.
        const library = libraryPace();
        pace.verdict = projectVerdict(id, { library });
        pace.learnerPace = pace.verdict ? library[pace.verdict.unit] : null;
        res.json(pace);
    } catch (err) {
        console.error('[Pace] Error:', err);
        res.status(500).json(errorBody(err));
    }
});

export const scheduleRoutes = app.takeRoutes();

app.delete('/api/projects/:id/schedule', (req, res) => {
    const { id } = req.params;
    if (!requireProject(req, res)) return;

    try {
        // A date marked "cannot move" is not removed either: the mark comes
        // off first, as it must before any other change to the date.
        const lockError = lockedDeadlineError(id, null, undefined);
        if (lockError) return res.status(400).json(keyed(lockError));
        // Window, node dates and baseline go; the study week stays (see
        // `removeSchedule` in server/scheduling.js).
        const { nodesCleared } = removeSchedule(id);
        res.json({ success: true, nodesCleared });
    } catch (err) {
        console.error('[Delete Schedule] Error:', err);
        res.status(500).json(errorBody(err));
    }
});

app.put('/api/nodes/:id/weight', (req, res) => {
    const { id } = req.params;
    const { estimated_weight } = req.body;
    if (!isNodeWeight(estimated_weight)) {
        return res.status(400).json(keyed('Weight must be a non-negative number.'));
    }
    try {
        const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
        if (!node) return res.status(404).json(keyed('Node not found.'));
        db.prepare(`UPDATE nodes SET estimated_weight = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(estimated_weight, id);
        const updated = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
        res.json(updated);
    } catch (err) {
        res.status(500).json(errorBody(err));
    }
});

export const scheduleEditRoutes = app.takeRoutes();
