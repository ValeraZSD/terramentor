// /api/ai/insights: the per-project study insights.
import db from '../database.js';
import { AI_PROMPTS, generateResponse, streamResponse } from '../ai.js';
import { calculatePace } from '../scheduling.js';
import { OPEN_WORK_LEAF, WORK_LEAF } from '../today.js';
import * as tasks from '../tasks.js';
import { reviewDue } from '../decks.js';
import { attachTaskStream } from './taskStream.js';
import { routeTable } from './routeTable.js';

const app = routeTable('insights');

// AI INSIGHTS

function buildInsightContext(projectId) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return {};

    const nodes = db.prepare(`
        SELECT id, parent_id, title, status, is_note, scheduled_start, scheduled_end, completed_at
        FROM nodes WHERE project_id = ? AND is_note = 0 ORDER BY position
    `).all(projectId);

    const nodeMap = new Map(nodes.map(n => [n.id, { ...n, children: [] }]));
    const tree = [];
    for (const node of nodes) {
        if (node.parent_id && nodeMap.has(node.parent_id)) {
            nodeMap.get(node.parent_id).children.push(nodeMap.get(node.id));
        } else {
            tree.push(nodeMap.get(node.id));
        }
    }

    const today = new Date().toISOString().split('T')[0];
    // App-wide convention: 'skipped' counts as closed (advances progress, never
    // overdue) — the insight context must agree with the rest of the app.
    const isClosed = (status) => status === 'completed' || status === 'skipped';
    const processNode = (node) => {
        const isOverdue = !isClosed(node.status) && node.scheduled_end && node.scheduled_end < today;
        let childrenData = [], completedCount = 0, totalCount = 0;

        if (node.children.length > 0) {
            childrenData = node.children.map(processNode);
            completedCount = childrenData.reduce((sum, c) => sum + c.completedCount, 0);
            totalCount = childrenData.reduce((sum, c) => sum + c.totalCount, 0);
        } else {
            totalCount = 1;
            completedCount = isClosed(node.status) ? 1 : 0;
        }

        return {
            title: node.title, status: node.status,
            progress: totalCount > 0 ? `${Math.round((completedCount / totalCount) * 100)}%` : '0%',
            isOverdue, scheduled_end: node.scheduled_end, completedCount, totalCount,
            children: childrenData.length > 0 ? childrenData : undefined
        };
    };

    const condensedTree = tree.map(processNode);

    // Only query LEAF nodes (child_count = 0) for temporal lists.
    // Parent nodes are never manually marked 'completed' in the DB, so they
    // incorrectly show up as pending/overdue even when all their children are done.
    const todayTasks = db.prepare(`
        SELECT n.id, n.title
        FROM nodes n
        WHERE n.project_id = ? AND ${OPEN_WORK_LEAF}
        AND n.scheduled_start <= ? AND n.scheduled_end >= ?
    `).all(projectId, today, today).map(n => ({ title: n.title, nodeId: n.id }));

    const overdueTasks = db.prepare(`
        SELECT n.id, n.title
        FROM nodes n
        WHERE n.project_id = ? AND ${OPEN_WORK_LEAF}
        AND n.scheduled_end < ?
    `).all(projectId, today).map(n => ({ title: n.title, nodeId: n.id }));

    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const threeDaysAgoStr = threeDaysAgo.toISOString().split('T')[0];

    const recentlyCompleted = db.prepare(`
        SELECT n.id, n.title
        FROM nodes n
        WHERE n.project_id = ? AND ${WORK_LEAF}
        AND n.status = 'completed'
        AND n.completed_at >= ?
    `).all(projectId, threeDaysAgoStr).map(n => n.title);

    let weakQuizAreas = [];
    try {
        // Added n.id as node_id so the AI can reference it
        weakQuizAreas = db.prepare(`
            SELECT n.title as weak_area, n.id as node_id, ROUND(AVG(qa.score * 100.0 / qa.total)) as avg_score
            FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id JOIN nodes n ON n.id = q.node_id
            WHERE n.project_id = ? GROUP BY q.node_id HAVING avg_score < 75 ORDER BY avg_score ASC LIMIT 3
        `).all(projectId);
    } catch (e) { }

    let fcStats = { total: 0, due: 0 };
    try {
        fcStats = db.prepare(`
            SELECT COUNT(*) as total, SUM(CASE WHEN ${reviewDue('f')} THEN 1 ELSE 0 END) as due
            FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ?
        `).get(projectId) || { total: 0, due: 0 };
    } catch (e) { }

    let pace = { message: 'No schedule', daysBehind: 0, expectedProgress: 0, actualProgress: 0, paceStatus: 'no_schedule' };
    if (project.start_date && project.deadline) {
        try { pace = calculatePace(projectId); } catch (e) { }
    }

    return {
        projectName: project.name, deadline: project.deadline,
        paceStatus: pace.paceStatus, daysBehind: pace.daysBehind,
        expectedProgress: pace.expectedProgress, actualProgress: pace.actualProgress,
        weakQuizAreas, flashcardsDue: fcStats.due || 0,
        todayTasks, overdueTasks, recentlyCompleted,
        projectTree: condensedTree
    };
}

// Parse the model's raw output into a saved insights payload. Shared by the
// blocking and streaming insights endpoints (mirrors finalizeQuiz in
// server/studyMaterial.js).
function finalizeInsights(projectId, contextPayload, aiResponse) {
    let parsedInsights;
    try {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        parsedInsights = jsonMatch ? JSON.parse(jsonMatch[0]) : { message: aiResponse, actions: [] };
    } catch (e) {
        parsedInsights = { message: aiResponse, actions: [] };
    }

    // A local model sometimes emits `message` as a nested object/array/number
    // instead of a string. Persisting that non-string crashes the client (the
    // Markdown renderer calls `.split` on it). Coerce to a string at the source.
    if (parsedInsights && typeof parsedInsights === 'object' && typeof parsedInsights.message !== 'string') {
        parsedInsights.message = parsedInsights.message == null
            ? ''
            : typeof parsedInsights.message === 'object'
                ? JSON.stringify(parsedInsights.message)
                : String(parsedInsights.message);
    }

    // Drop actions whose nodeId the model invented or copied wrong — otherwise
    // the UI renders a "Start Task" / "Review" button that opens nothing. Every
    // node-scoped action must reference a real node in THIS project; only
    // 'recalibrate' legitimately carries no nodeId.
    if (parsedInsights && Array.isArray(parsedInsights.actions)) {
        const validIds = new Set(
            db.prepare('SELECT id FROM nodes WHERE project_id = ?').all(projectId).map(n => n.id)
        );
        parsedInsights.actions = parsedInsights.actions
            .filter(a => a && typeof a === 'object' && a.type)
            .filter(a => {
                if (a.type === 'recalibrate') return true;
                const id = Number(a.nodeId);
                if (!validIds.has(id)) return false;
                a.nodeId = id; // normalize to a clean integer for the client
                return true;
            });
    }

    saveInsightsToDb(projectId, JSON.stringify(parsedInsights));
    return {
        stats: {
            completed: contextPayload.projectTree ? contextPayload.projectTree.reduce((a, c) => a + c.completedCount, 0) : 0,
            inProgress: 0,
            total: contextPayload.projectTree ? contextPayload.projectTree.reduce((a, c) => a + c.totalCount, 0) : 0
        },
        insights: parsedInsights
    };
}

app.post('/api/ai/insights', async (req, res) => {
    const { projectId } = req.body;
    let aiResponse = null;
    try {
        const contextPayload = buildInsightContext(projectId);
        const { system, user } = AI_PROMPTS.insights(contextPayload);
        aiResponse = await generateResponse(user, system, [], { operation: 'insights' });
        res.json(finalizeInsights(projectId, contextPayload, aiResponse));
    } catch (error) {
        console.error('Insights error:', error);
        res.status(500).json({
            error: error.message,
            rawResponse: aiResponse
        });
    }
});

// Streaming variant: same result as /api/ai/insights, but runs as a
// background task — the result is cached server-side (projects.insights), so
// a generation whose subscriber navigated away still lands and the dashboard
// picks it up from the cache on return.
async function runInsightsGeneration({ projectId, emit, signal }) {
    let aiResponse = '';
    let thinkingChars = 0;
    try {
        const contextPayload = buildInsightContext(projectId);
        const { system, user } = AI_PROMPTS.insights(contextPayload);
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.5, think: true })) {
            if (part && part.type === 'content' && part.content) {
                aiResponse += part.content;
                emit({ progress: aiResponse.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                emit({ thinking: thinkingChars });
            }
        }
        return finalizeInsights(projectId, contextPayload, aiResponse);
    } catch (error) {
        if (signal.aborted) return { cancelled: true };
        console.error('Insights error:', error);
        if (error.rawResponse === undefined) error.rawResponse = aiResponse || null;
        throw error;
    }
}

app.post('/api/ai/insights/stream', (req, res) => {
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'Missing required field: projectId' });
    const project = db.prepare('SELECT id, name, color FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const insightsOrigin = { surface: 'project', detail: 'insights', projectId: Number(projectId) };
    const { task } = tasks.createTask({
        kind: 'insights',
        label: project.name,
        origin: insightsOrigin,
        projectId: Number(projectId),
        projectName: project.name,
        projectColor: project.color,
        dedupeKey: `insights:${projectId}`,
        run: ({ emit, signal }) => runInsightsGeneration({ projectId: Number(projectId), emit, signal }),
    });
    attachTaskStream(req, res, task.id);
});

app.get('/api/projects/:id/insights', (req, res) => {
    const project = db.prepare(
        'SELECT insights, insights_generated_at FROM projects WHERE id = ?'
    ).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let parsedInsights = null;
    if (project.insights) {
        if (typeof project.insights === 'string') {
            try {
                parsedInsights = JSON.parse(project.insights);
            } catch (e) {
                parsedInsights = project.insights;
            }
        } else {
            parsedInsights = project.insights;
        }
    }

    res.json({
        insights: parsedInsights,
        generatedAt: project.insights_generated_at,
    });
});

export const routes = app.takeRoutes();

function saveInsightsToDb(projectId, insightsText) {
    try {
        // Use JavaScript ISO string so the timestamp includes the 'Z' UTC suffix,
        // making it unambiguous for client-side parsing regardless of timezone.
        const isoNow = new Date().toISOString();
        db.prepare(`
            UPDATE projects
            SET insights = ?, insights_generated_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(insightsText, isoNow, projectId);
    } catch (err) {
        console.error('[Insights] Failed to save:', err.message);
    }
}
