// /api/today and the Today briefing. (The assistant's chat is in routes/chat.js.)
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
