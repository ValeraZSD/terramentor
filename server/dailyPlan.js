import db, { NOW_ISO } from './database.js';
import { getDecayingNodes } from './mastery.js';
import { recallOrder } from './questionLog.js';
import { WORK_LEAF, LEAF_STATUS } from './today.js';
import { reviewDue } from './decks.js';
import { isReadyToProve } from './readyToProve.js';
import { getGateConfig } from './settingsStore.js';
import { studyToday } from './studyDay.js';

/**
 * Generate a daily study plan for a project.
 * Returns:
 *  - Overdue tasks
 *  - Today's scheduled tasks
 *  - Decaying nodes needing review (Ghost Questions)
 *  - The next few open leaves, in curriculum order
 *  - Recommended quiz/flashcard sessions
 *
 * @param {number} projectId
 * @param {number} decayDays - Configured decay window (settings `decay_days`)
 * @param {string} [today] - `YYYY-MM-DD` the plan is for; the learner's today by default (server/studyDay.js)
 * @returns {object} Daily plan data
 */
export function generateDailyPlan(projectId, decayDays = 14, today = studyToday()) {

    // 1. Get overdue tasks (scheduled end < today, not completed)
    const gate = getGateConfig();
    const overdueTasks = db.prepare(`
        SELECT n.id, n.title, n.scheduled_start, n.scheduled_end, ${LEAF_STATUS} AS status
        FROM nodes n
        WHERE n.project_id = ?
          AND ${WORK_LEAF}
          AND n.status NOT IN ('completed', 'skipped')
          AND n.scheduled_end < ?
        ORDER BY n.scheduled_end ASC
    `).all(projectId, today)
        // Still overdue and counted as such; the dashboard tells the learner
        // which of them they already know (server/readyToProve.js).
        .map(t => ({ ...t, readyToProve: isReadyToProve(t, today, gate) }));

    // 2. Get today's scheduled tasks
    const todayTasks = db.prepare(`
        SELECT n.id, n.title, n.scheduled_start, n.scheduled_end, ${LEAF_STATUS} AS status
        FROM nodes n
        WHERE n.project_id = ?
          AND ${WORK_LEAF}
          AND n.status NOT IN ('completed', 'skipped')
          AND n.scheduled_start <= ?
          AND n.scheduled_end >= ?
        ORDER BY n.position ASC
    `).all(projectId, today, today);

    // 3. Get decaying nodes (Ghost Questions source)
    const decayingNodes = getDecayingNodes(projectId, decayDays);

    // 4. The next few open leaves in curriculum order — `position` is the whole
    // ordering; knowledge is settled by evidence, not by edges between nodes.
    const nextUnlocked = db.prepare(`
        SELECT n.id, n.title, n.parent_id
        FROM nodes n
        WHERE n.project_id = ?
          AND ${WORK_LEAF}
          AND n.status = 'not_started'
        ORDER BY n.position ASC
        LIMIT 5
    `).all(projectId);

    // 5. Get mastery stats for the project
    const masteryStats = db.prepare(`
        SELECT
            nm.node_id,
            nm.mastery_score,
            n.title
        FROM node_mastery nm
        JOIN nodes n ON n.id = nm.node_id
        WHERE n.project_id = ?
        ORDER BY nm.mastery_score ASC
        LIMIT 5
    `).all(projectId);

    // 6. Get due flashcards count
    const dueFlashcards = db.prepare(`
        SELECT COUNT(*) as count
        FROM flashcards f
        JOIN nodes n ON n.id = f.node_id
        WHERE n.project_id = ?
          AND ${reviewDue('f')}
    `).get(projectId);

    // 7. Untested nodes: no evidence of any kind yet. Read off mastery_evidence
    // rather than quiz_attempts — an imported topic arrives with a quiz row and
    // no attempt, and its feed answers are evidence that never touch that table.
    const untestedNodes = db.prepare(`
        SELECT n.id, n.title
        FROM nodes n
        WHERE n.project_id = ?
          AND ${WORK_LEAF}
          AND n.status NOT IN ('completed', 'skipped')
          AND NOT EXISTS (SELECT 1 FROM mastery_evidence me WHERE me.node_id = n.id)
        LIMIT 5
    `).all(projectId);

    // Build the recommendations
    const recommendations = [];

    if (overdueTasks.length > 0) {
        recommendations.push({
            type: 'urgent',
            message: `${overdueTasks.length} task${overdueTasks.length > 1 ? 's are' : ' is'} overdue`,
            tasks: overdueTasks,
        });
    }

    if (decayingNodes.length > 0) {
        recommendations.push({
            type: 'review',
            message: `${decayingNodes.length} topic${decayingNodes.length > 1 ? 's need' : ' needs'} review (Ghost Questions)`,
            tasks: decayingNodes.map(n => ({
                nodeId: n.node_id,
                title: n.title,
                masteryScore: n.mastery_score,
                lastUpdated: n.last_updated,
            })),
        });
    }

    if (todayTasks.length > 0) {
        recommendations.push({
            type: 'today',
            message: `${todayTasks.length} task${todayTasks.length > 1 ? 's' : ''} scheduled for today`,
            tasks: todayTasks,
        });
    }

    if (nextUnlocked.length > 0) {
        recommendations.push({
            type: 'next',
            message: 'Next unlocked topics ready to start',
            tasks: nextUnlocked,
        });
    }

    return {
        date: today,
        overdueTasks,
        todayTasks,
        decayingNodes,
        nextUnlocked,
        masteryStats,
        dueFlashcards: dueFlashcards?.count || 0,
        untestedNodes,
        recommendations,
        summary: {
            overdueCount: overdueTasks.length,
            todayCount: todayTasks.length,
            decayingCount: decayingNodes.length,
            dueFlashcardCount: dueFlashcards?.count || 0,
            untestedCount: untestedNodes.length,
        },
    };
}

/**
 * Recall ("ghost") questions from a project's fading topics, oldest-faded
 * first: up to `maxTopics` topics that have a question to ask, up to
 * `perTopic` questions each, in the order `recallOrder` (questionLog.js) puts
 * them, which is by difficulty and the same on every read.
 *
 * Through `bankOf`, so every quiz row of the topic counts, a ghost copy a
 * practice quiz absorbed from another topic never does (its answer would
 * credit this topic with evidence about that one), and a NULL or legacy
 * `questions` row is skipped rather than failing the whole read: one bad row
 * once stopped every recall card in the library.
 *
 * @param {number} projectId
 * @param {number} maxTopics - How many fading topics to take
 * @param {number} decayDays - Configured decay window (settings `decay_days`)
 * @param {Date} [now] - The instant the window ends at (gates pin it)
 * @param {{perTopic?: number}} [opts]
 * @returns Array of { nodeId, title, lastUpdated, quizId, questions, picks }:
 *   `picks` is `{ quizId, index, question }` per question, where it lives;
 *   `questions` the same questions as `{ ...question, quizIndex }`, the shape a
 *   practice quiz embeds; `quizId` the first pick's row (the picks may come
 *   from different rows: a question's own row is in `picks`).
 */
export function getGhostQuestions(projectId, maxTopics = 2, decayDays = 14, now = new Date(), { perTopic = 2 } = {}) {
    const out = [];
    // Every fading topic, oldest first, not the first ten: when the oldest
    // ones have nothing a draw may hand out, a younger one still gets asked.
    for (const node of getDecayingNodes(projectId, decayDays, now, { limit: null })) {
        if (out.length >= maxTopics) break;
        const picks = recallOrder(node.node_id).slice(0, Math.max(1, perTopic));
        if (!picks.length) continue;
        out.push({
            nodeId: node.node_id,
            title: node.title,
            lastUpdated: node.last_updated,
            quizId: picks[0].quizId,
            questions: picks.map(p => ({ ...p.question, quizIndex: p.index })),
            picks,
            isGhost: true,
            reason: 'Spaced repetition review',
        });
    }
    return out;
}