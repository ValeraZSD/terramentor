// /api/today and the Today briefing and chat.
//
// Mounted in 2 blocks (see createApp in server/app.js), because the server
// registers other areas' routes between them and Express matches in registration
// order. A new route goes in the block it belongs with.
import db from '../database.js';
import { AI_PROMPTS, probeAiReachable, streamResponse } from '../ai.js';
import {
    ACTIVE_PROJECT_JOIN, buildTodayActivity, buildTodayBriefingContext, buildTodayData,
} from '../today.js';
import * as tasks from '../tasks.js';
import { getGateConfig } from '../settingsStore.js';
import { getSittingReview } from '../sittingReview.js';
import { runChatTurn, withActions } from '../chatTurn.js';
import { attachTaskStream } from './taskStream.js';
import { routeTable } from './routeTable.js';

const app = routeTable('today');

// CROSS-PROJECT DAILY BRIEFING + PLANNING CHAT (global Today hub)

// Parse and validate the briefing. Every action must reference a real node in
// an ACTIVE project — a small local model copies ids imperfectly, and an
// unvalidated button that opens nothing erodes trust (same rationale as
// finalizeInsights, but pairs span projects here).
function finalizeTodayBriefing(aiResponse) {
    let parsed;
    try {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { message: aiResponse, actions: [] };
    } catch (e) {
        parsed = { message: aiResponse, actions: [] };
    }

    if (parsed && Array.isArray(parsed.actions)) {
        const nodeProject = new Map(
            db.prepare(`
                SELECT n.id, n.project_id FROM nodes n
                ${ACTIVE_PROJECT_JOIN}
            `).all().map(r => [r.id, r.project_id])
        );
        const schedulableProjects = new Set(
            db.prepare(`
                SELECT id FROM projects
                WHERE COALESCE(status, 'active') = 'active'
                  AND start_date IS NOT NULL AND deadline IS NOT NULL
            `).all().map(p => p.id)
        );
        parsed.actions = parsed.actions
            .filter(a => a && typeof a === 'object' && a.type)
            .filter(a => {
                if (a.type === 'review_flashcards') {
                    delete a.nodeId; delete a.projectId;
                    return true;
                }
                if (a.type === 'recalibrate') {
                    const pid = Number(a.projectId);
                    if (!schedulableProjects.has(pid)) return false;
                    a.projectId = pid; delete a.nodeId;
                    return true;
                }
                if (a.type === 'open_node') {
                    const nid = Number(a.nodeId);
                    const realPid = nodeProject.get(nid);
                    if (realPid == null) return false;
                    // Trust the node id; correct a mis-copied projectId silently.
                    a.nodeId = nid; a.projectId = realPid;
                    return true;
                }
                return false;
            });
    } else if (parsed) {
        parsed.actions = [];
    }

    // No project row exists for a global artifact — cache in the settings kv.
    try {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
            'today_briefing',
            JSON.stringify({ insights: parsed, generatedAt: new Date().toISOString() })
        );
    } catch (err) {
        console.error('[TodayBriefing] Failed to cache:', err.message);
    }

    return parsed;
}

// Briefing generation as a background task: the result is cached in the
// settings kv (finalizeTodayBriefing), so a generation that outlives its
// subscriber still lands and the Today hub reads it from the cache on return.
async function runTodayBriefing({ emit, signal }) {
    let aiResponse = '';
    let thinkingChars = 0;
    // Bounded copy of the reasoning channel: a thinking model can burn its whole
    // budget reasoning and emit no answer, so we surface that text as raw output
    // instead of failing with an empty box (mirrors runQuizGeneration).
    let thinkingText = '';
    const THINKING_RAW_CAP = 8000;
    // "Warming up the model" heartbeat until the first token lands — a cold model
    // swap holds the upstream request open for up to a minute with zero bytes.
    let firstTokenSeen = false;
    let loadingTimer = null;
    const startedAt = Date.now();
    const stopLoadingHeartbeat = () => {
        if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    };
    try {
        // Fail fast if the model server is down; stay patient if it's merely loading.
        const reachable = await probeAiReachable();
        if (!reachable.ok) throw new Error(reachable.error);

        loadingTimer = setInterval(() => {
            if (!firstTokenSeen && !signal.aborted) {
                emit({ phase: 'loading_model', waitedMs: Date.now() - startedAt });
            }
        }, 2000);

        const contextPayload = buildTodayBriefingContext({ decayDays: getGateConfig().decayDays });
        const { system, user } = AI_PROMPTS.today_briefing(contextPayload);
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.5, think: true })) {
            if (part && (part.type === 'content' || part.type === 'thinking') && part.content) {
                if (!firstTokenSeen) { firstTokenSeen = true; stopLoadingHeartbeat(); emit({ phase: 'generating' }); }
            }
            if (part && part.type === 'content' && part.content) {
                aiResponse += part.content;
                emit({ progress: aiResponse.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                if (thinkingText.length < THINKING_RAW_CAP) thinkingText += part.content;
                emit({ thinking: thinkingChars });
            }
        }
        stopLoadingHeartbeat();
        // A reasoning model can finish having emitted only a thinking stream and no
        // answer. Don't cache an empty briefing — give an actionable error and
        // surface the reasoning as raw output.
        if (!aiResponse.trim()) {
            throw Object.assign(
                new Error('The AI model returned no briefing text — it may have spent its whole budget "thinking". Try again, or switch to a model that emits a final answer.'),
                { rawResponse: thinkingText || null }
            );
        }
        return { insights: finalizeTodayBriefing(aiResponse) };
    } catch (error) {
        stopLoadingHeartbeat();
        if (signal.aborted) return { cancelled: true };
        console.error('Today briefing error:', error);
        if (error.rawResponse === undefined) {
            error.rawResponse = aiResponse || thinkingText || null;
        }
        throw error;
    }
}

app.post('/api/ai/today-briefing/stream', (req, res) => {
    // Deduped globally: re-requesting a briefing while one is generating
    // reattaches instead of racing a second one against the cache.
    const { task } = tasks.createTask({
        kind: 'briefing',
        label: 'Daily briefing',
        labelKey: 'Daily briefing',
        origin: { surface: 'app', job: 'briefing' },
        dedupeKey: 'briefing',
        run: ({ emit, signal }) => runTodayBriefing({ emit, signal }),
    });
    attachTaskStream(req, res, task.id);
});

app.get('/api/today/briefing', (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'today_briefing'").get();
        if (!row?.value) return res.json({ insights: null, generatedAt: null });
        const cached = JSON.parse(row.value);
        res.json({ insights: cached.insights ?? null, generatedAt: cached.generatedAt ?? null });
    } catch (err) {
        res.json({ insights: null, generatedAt: null });
    }
});

// Budgets for the page context. It sits in front of the cross-project snapshot,
// so it has to stay a briefing, not a dump — but "teach the topic on screen" is
// impossible from a title, which is what it used to amount to.
const PAGE_OVERVIEW_CHARS = 600;
const PAGE_MATERIAL_CHARS = 1800;
const PAGE_LESSON_CHARS = 2500;
const PAGE_MISSES = 3;
const PAGE_MISS_CHARS = 220;

/**
 * The learner's own material under a topic: its `is_note` children, which is
 * where a curriculum's real depth lives (the feed teaches them as the lesson
 * body). Budgeted across however many there are, so one long reading can't eat
 * the whole allowance.
 */
function topicMaterial(nodeId) {
    const notes = db.prepare(`
        SELECT title, description FROM nodes
        WHERE parent_id = ? AND is_note = 1
        ORDER BY position ASC LIMIT 4
    `).all(nodeId).filter(n => String(n.description || '').trim());
    if (!notes.length) return '';
    const per = Math.max(300, Math.floor(PAGE_MATERIAL_CHARS / notes.length));
    return notes.map(n => `- ${n.title}: ${String(n.description).trim().slice(0, per)}`).join('\n');
}

/**
 * What the learner recently got WRONG on this topic — the single most useful
 * thing the assistant can know when asked "why don't I get this". Read from the
 * feed's own consumed questions (result = {correct, answer}), so it reflects
 * what actually happened, not what a model assumes happened.
 */
function recentMisses(nodeId) {
    let rows = [];
    try {
        rows = db.prepare(`
            SELECT content, result FROM feed_items
            WHERE node_id = ? AND kind = 'question' AND status = 'consumed' AND result IS NOT NULL
            ORDER BY consumed_at DESC LIMIT 12
        `).all(nodeId);
    } catch { return ''; }

    const out = [];
    for (const r of rows) {
        if (out.length >= PAGE_MISSES) break;
        let res = null;
        let q = null;
        try { res = JSON.parse(r.result); } catch { continue; }
        if (!res || res.correct !== false) continue;
        try { q = JSON.parse(r.content); } catch { continue; }
        const stem = String(q?.question || '').replace(/```[\s\S]*?```/g, '[diagram]').trim();
        if (!stem) continue;
        out.push(`- Asked: ${stem.slice(0, PAGE_MISS_CHARS)}`
            + (res.answer ? `\n  They answered: ${String(res.answer).slice(0, 120)}` : '')
            + (q?.answer ? `\n  Correct: ${String(q.answer).slice(0, 120)}` : ''));
    }
    return out.join('\n');
}

/**
 * Describe the screen the learner is on, for the global assistant.
 *
 * Takes ids, returns prose — and every name in that prose is read out of the
 * database here. The client is trusted to say *where* it is, never *what* is
 * there, so no amount of client (or injected) text can put a fabricated topic
 * into the model's context as fact. `feedItemId` obeys the same rule: it names
 * a row, and the row's own text is what gets quoted.
 *
 * Returns { text, projectId } — the id is the RAG scope, so a question asked
 * inside a project searches that project's vault first instead of everything.
 */
function buildPageContext(context) {
    const empty = { text: '', projectId: null };
    if (!context || typeof context !== 'object') return empty;
    const view = typeof context.view === 'string' ? context.view : '';
    const nodeId = Number(context.nodeId);
    const projectId = Number(context.projectId);
    const feedItemId = Number(context.feedItemId);
    const lines = [];
    let scopeProjectId = Number.isInteger(projectId) ? projectId : null;

    // On the feed there is no "selected node" — the card in front of the reader
    // is the context, and the client reports it by row id.
    let focusNodeId = Number.isInteger(nodeId) ? nodeId : null;
    let feedItem = null;
    if (!focusNodeId && Number.isInteger(feedItemId)) {
        feedItem = db.prepare('SELECT id, node_id, kind, content FROM feed_items WHERE id = ?').get(feedItemId);
        if (feedItem) focusNodeId = feedItem.node_id;
    }

    if (focusNodeId) {
        const node = db.prepare(`
            SELECT n.id, n.title, n.status, n.description, p.id AS pid, p.name AS pname
            FROM nodes n JOIN projects p ON p.id = n.project_id WHERE n.id = ?
        `).get(focusNodeId);
        if (node) {
            scopeProjectId = node.pid;
            lines.push(`Open topic: "${node.title}" (projectId ${node.pid}, nodeId ${node.id}) in project "${node.pname}" — status ${node.status}.`);
            if (node.description) lines.push(`Its overview: ${String(node.description).slice(0, PAGE_OVERVIEW_CHARS)}`);

            const material = topicMaterial(node.id);
            if (material) lines.push(`Material attached to this topic:\n${material}`);

            if (feedItem?.kind === 'lesson') {
                lines.push(`The card they are reading right now (quote and build on THIS, do not re-teach it from scratch):\n${String(feedItem.content).slice(0, PAGE_LESSON_CHARS)}`);
            } else if (feedItem?.kind === 'question') {
                let q = null;
                try { q = JSON.parse(feedItem.content); } catch { /* keep going without it */ }
                if (q?.question) lines.push(`The question on their screen: ${String(q.question).slice(0, 600)}`);
            }

            const misses = recentMisses(node.id);
            if (misses) lines.push(`Recently answered WRONG on this topic:\n${misses}`);
        }
    } else if (Number.isInteger(projectId)) {
        const project = db.prepare('SELECT id, name, summary FROM projects WHERE id = ?').get(projectId);
        if (project) {
            lines.push(`Open project: "${project.name}" (projectId ${project.id}).`);
            if (project.summary) lines.push(`Its summary: ${String(project.summary).slice(0, 400)}`);
        }
    }

    const SCREENS = {
        today: 'the learning feed (the home page)',
        projects: 'the projects grid',
        calendar: 'the global calendar',
        settings: 'the settings screen',
        workspace: 'a project workspace',
    };
    if (SCREENS[view]) lines.push(`Screen: ${SCREENS[view]}.`);
    return { text: lines.join('\n'), projectId: scopeProjectId };
}

// Global planning chat. History lives in chat_messages with node_id AND
// project_id NULL — the orphan cleanup in database.js must keep skipping
// NULL node_id rows, or this history would be swept on startup.
app.post('/api/ai/today-chat/stream', (req, res) => {
    const { message, context } = req.body;
    if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'Missing required field: message' });
    }
    // The client sends only WHERE it is (a view name and ids). The description
    // is built here from the database, so the prompt can never be fed prose the
    // client made up about a topic that doesn't exist.
    const page = buildPageContext(context);
    // Single global planning conversation — same one-turn-at-a-time rule as
    // the node tutor (the Today chat reattaches on mount).
    if (tasks.findActive({ kind: 'today_chat' })) {
        return res.status(409).json({ error: 'The planner is still answering. Wait for it to finish or stop it first.' });
    }
    const { task } = tasks.createTask({
        kind: 'today_chat',
        label: 'Planning chat',
        labelKey: 'Planning chat',
        origin: { surface: 'assistant' },
        meta: { message: String(message) },
        // The vault is searched for the assistant too: it is the only surface
        // reachable from every screen, and answering "what does my textbook say
        // about X" from a title alone is guessing. Scope follows the page — the
        // open project's documents first, the whole vault from a global screen.
        run: ({ emit, signal }) => runChatTurn({
            nodeId: null, projectId: null, message: String(message),
            useRag: true, ragProjectId: page.projectId,
            emit, signal, pageContext: page.text,
            timeZone: req.body.timeZone,
        }),
    });
    attachTaskStream(req, res, task.id);
});

app.get('/api/ai/today-chat', (req, res) => {
    const messages = db.prepare(`
        SELECT id, role, content, reasoning, actions, created_at
        FROM chat_messages
        WHERE node_id IS NULL AND project_id IS NULL
        ORDER BY created_at
    `).all();
    res.json(messages.map(withActions));
});

app.delete('/api/ai/today-chat', (req, res) => {
    db.prepare('DELETE FROM chat_messages WHERE node_id IS NULL AND project_id IS NULL').run();
    res.json({ success: true });
});

export const briefingRoutes = app.takeRoutes();

app.get('/api/today', (req, res) => {
    try {
        res.json(buildTodayData({ decayDays: getGateConfig().decayDays }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The ledger behind the feed header's chips: every card answered, question
// graded, lesson read and topic closed today, each with its own timestamp.
// `date` is optional and defaults to today (UTC, the app's study-day boundary).
app.get('/api/today/activity', (req, res) => {
    try {
        const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
            ? req.query.date
            : undefined;
        res.json(buildTodayActivity(date));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// One row of that ledger, opened: the questions a check or a quiz asked, the
// learner's answers, which were right (server/sittingReview.js).
app.get('/api/today/sittings/:evidenceId', (req, res) => {
    const evidenceId = Number(req.params.evidenceId);
    if (!Number.isInteger(evidenceId)) return res.status(400).json({ error: 'Invalid sitting id' });
    const review = getSittingReview(evidenceId);
    if (!review) return res.status(404).json({ error: 'No review was kept for this sitting' });
    res.json(review);
});

export const todayRoutes = app.takeRoutes();
