import db, { NOW_ISO } from './database.js';
import { getDecayingNodes } from './mastery.js';
import { WORK_LEAF } from './today.js';
import { reviewDue } from './decks.js';

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
 * @returns {object} Daily plan data
 */
export function generateDailyPlan(projectId, decayDays = 14) {
    const today = new Date().toISOString().split('T')[0];

    // 1. Get overdue tasks (scheduled end < today, not completed)
    const overdueTasks = db.prepare(`
        SELECT n.id, n.title, n.scheduled_start, n.scheduled_end, n.status
        FROM nodes n
        WHERE n.project_id = ?
          AND ${WORK_LEAF}
          AND n.status NOT IN ('completed', 'skipped')
          AND n.scheduled_end < ?
        ORDER BY n.scheduled_end ASC
    `).all(projectId, today);

    // 2. Get today's scheduled tasks
    const todayTasks = db.prepare(`
        SELECT n.id, n.title, n.scheduled_start, n.scheduled_end, n.status
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
 * Get ghost questions for a specific node.
 * These are questions from decaying nodes that should be mixed in
 * to force interleaved practice.
 *
 * @param {number} projectId
 * @param {number} maxGhostQuestions - Maximum ghost questions to inject
 * @param {number} decayDays - Configured decay window (settings `decay_days`)
 * @returns Array of { nodeId, title, quizId, questions }
 */
export function getGhostQuestions(projectId, maxGhostQuestions = 2, decayDays = 14) {
    const decayingNodes = getDecayingNodes(projectId, decayDays);

    if (decayingNodes.length === 0) return [];

    const ghostQuestions = [];
    const limit = Math.min(maxGhostQuestions, decayingNodes.length);

    for (let i = 0; i < limit; i++) {
        const node = decayingNodes[i];
        // Get a random quiz for this decaying node
        const quiz = db.prepare(`
            SELECT q.* FROM quizzes q
            WHERE q.node_id = ?
            ORDER BY RANDOM()
            LIMIT 1
        `).get(node.node_id);

        if (quiz) {
            // `quizzes.questions` is free TEXT and its rows outlive the code
            // that wrote them, so a NULL or a legacy shape is a row to skip, not
            // a reason to fail the request. Unguarded, `JSON.parse(null)` is
            // `null` and the `.map` below throws: this endpoint answers 500, and
            // its two other callers (`feed.js`, `studyMaterial.js`) swallow the
            // error — so ONE bad row silently stopped every recall card in the
            // library, with a console line as the only trace. `bankOf` in
            // questionLog.js reads the same column and already does this.
            let questions;
            try { questions = JSON.parse(quiz.questions); } catch { continue; }
            if (!Array.isArray(questions)) continue;
            // Exclude questions this quiz itself absorbed as ghosts from another
            // node — re-injecting them here would credit *this* node's mastery
            // with evidence that's actually about the ghost's original topic.
            const ownQuestions = questions
                .map((q, quizIndex) => (q && !q.isGhost ? { ...q, quizIndex } : null))
                .filter(Boolean);
            if (ownQuestions.length === 0) continue;
            // Pick 1-2 random questions from the quiz (Fisher–Yates — the
            // sort(random) idiom skews selection toward the original order)
            for (let i = ownQuestions.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [ownQuestions[i], ownQuestions[j]] = [ownQuestions[j], ownQuestions[i]];
            }
            const selected = ownQuestions.slice(0, 2);

            ghostQuestions.push({
                nodeId: node.node_id,
                title: node.title,
                quizId: quiz.id,
                questions: selected,
                isGhost: true,
                reason: 'Spaced repetition review',
            });
        }
    }

    return ghostQuestions;
}