// /api/ai/chat: the tutor and assistant conversations.
import db from '../database.js';
import { AI_PROMPTS, aiProvenance, buildNodeContext, generateResponse } from '../ai.js';
import { formatSourceContext, resolveCitations } from '../citations.js';
import { extractToolTail, hasDocumentTools, hasWebTool, paragraphBreak, storedActions } from '../aiTools.js';
import { projectDocumentCount } from '../libraryReads.js';
import { getUiLanguage } from '../language.js';
import * as tasks from '../tasks.js';
import { chatNowBlock, resolveTimeZone, stampHistory, stripSendStamp } from '../chatContext.js';
import {
    buildSourceContext, collectRunningWork, runChatTurn, runLateLookups, withActions,
} from '../chatTurn.js';
import { attachTaskStream, nodeTaskInfo } from './taskStream.js';
import { routeTable } from './routeTable.js';

const app = routeTable('chat');

app.post('/api/ai/chat', async (req, res) => {
    const { nodeId, message, useRag = true } = req.body;
    // The learner's zone comes from the page; it is untrusted (resolveTimeZone).
    const timeZone = resolveTimeZone(req.body.timeZone);
    let aiResponse = null;
    try {
        let context = '';
        if (nodeId) context = buildNodeContext(nodeId, { completedTopics: true, curriculumPosition: true });
        let ragContext = '';
        let ragSources = [];
        let toolCalls = [];
        let ragTools = [], ragItems = [], ragLooked = [];
        // Read before the turn is inserted (the prompt already carries the
        // message) and handed to the lookup pass, so a short follow-up is
        // judged in its exchange rather than on its own. Each message leads
        // with when it was sent (server/chatContext.js).
        const history = stampHistory(db.prepare(`
            SELECT role, content, created_at FROM chat_messages
            WHERE node_id = ?
            ORDER BY created_at DESC, id DESC LIMIT 10
        `).all(nodeId || -1).reverse(), timeZone);
        if (nodeId) {
            const node = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
            if (node) ({ text: ragContext, sources: ragSources, calls: toolCalls = [], tools: ragTools, items: ragItems, context: ragLooked } =
                await buildSourceContext(nodeId, node.project_id, message, {
                    useVault: useRag, history,
                    documentsOf: projectDocumentCount(node.project_id) ? node.project_id : null,
                }));
        }
        // The prompt says whether THIS turn can search, read off the tools it
        // was actually given: told the app does the searching for it, a model
        // holding search_web refuses to use it (server/ai.js appIdentity).
        const { system: baseSystem, user } = AI_PROMPTS.tutor(context, ragContext, message, getUiLanguage(), { web: hasWebTool(ragTools), documents: hasDocumentTools(ragTools) });
        // The volatile tail goes last, after everything a provider can cache.
        const system = `${baseSystem}\n\n${chatNowBlock({ nowMs: Date.now(), timeZone, work: collectRunningWork(), withHistoryStamps: history.length > 0 })}`;

        aiResponse = await generateResponse(user, system, history, { think: true, temperature: 0.35, operation: 'chat' });
        // The answer may end by asking for a lookup (server/aiTools.js): run
        // what it asked for against the same turn cap, then one pass to finish.
        if (ragTools.length && aiResponse.trim()) {
            const tail = extractToolTail(aiResponse, ragTools);
            if (tail.calls.length) {
                const continued = await runLateLookups({
                    tail, tools: ragTools, calls: toolCalls, items: ragItems, context: ragLooked,
                    message, system, history, emit: null, signal: null,
                    at: { reasoning: 0, content: tail.head.length },
                    answer: async (contUser, contHistory) => {
                        const text = await generateResponse(contUser, system, contHistory, { think: false, temperature: 0.35, operation: 'chat' });
                        // A continuation may not ask for further lookups; any
                        // tail it wrote anyway is dropped here, never stored.
                        const t = extractToolTail(text, ragTools);
                        return t.calls.length ? t.head : text;
                    },
                });
                // The continuation opens a new paragraph: it is a second
                // message, and glued on it read as one line with the first.
                aiResponse = tail.head + (continued ? paragraphBreak(tail.head, continued) : '');
                ragSources = formatSourceContext(ragItems).sources;
            }
        }
        const rawResponse = aiResponse;
        // Markers out, the documents they named in. Runs before the row is
        // written, so what is stored is what the learner reads.
        ({ text: aiResponse } = resolveCitations(aiResponse, ragSources));
        // A send-stamp the model echoed from the history is the app's metadata.
        aiResponse = stripSendStamp(aiResponse);
        toolCalls = storedActions(toolCalls, { raw: rawResponse, stored: aiResponse, reasoning: '' });

        if (nodeId) {
            const node = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
            db.prepare('INSERT INTO chat_messages (node_id, project_id, role, content) VALUES (?, ?, ?, ?)')
                .run(nodeId, node?.project_id, 'user', message);
            // Only the assistant row carries provenance — the user's turn was
            // written by a person, and stamping it would be a lie.
            db.prepare('INSERT INTO chat_messages (node_id, project_id, role, content, actions, generated_by) VALUES (?, ?, ?, ?, ?, ?)')
                .run(nodeId, node?.project_id, 'assistant', aiResponse,
                    toolCalls.length ? JSON.stringify(toolCalls) : null, aiProvenance());
        }
        res.json({ response: aiResponse });
    } catch (error) {
        console.error('AI chat error:', error);
        res.status(500).json({
            error: error.message,
            rawResponse: aiResponse
        });
    }
});

app.post('/api/ai/chat/stream', (req, res) => {
    const { nodeId, message, useRag = true } = req.body;
    if (!nodeId || !message || !String(message).trim()) {
        return res.status(400).json({ error: 'nodeId and message are required' });
    }
    const info = nodeTaskInfo(Number(nodeId));
    if (!info) return res.status(404).json({ error: 'Node not found' });

    // One tutor conversation per node: a second question while a turn is
    // still generating must reattach to it (the panel does that on mount),
    // not fork a parallel turn with stale history.
    if (tasks.findActive({ kind: 'chat', nodeId: Number(nodeId) })) {
        return res.status(409).json({ error: 'The tutor is still answering for this topic. Wait for it to finish or stop it first.' });
    }

    const tutorOrigin = { surface: 'tutor', nodeId: Number(nodeId), projectId: info.projectId };
    const { task } = tasks.createTask({
        kind: 'chat',
        label: info.title,
        origin: tutorOrigin,
        nodeId: Number(nodeId),
        projectId: info.projectId,
        projectName: info.projectName,
        projectColor: info.projectColor,
        meta: { message: String(message) },
        run: ({ emit, signal }) => runChatTurn({
            nodeId: Number(nodeId), projectId: info.projectId,
            message: String(message), useRag, emit, signal,
            timeZone: req.body.timeZone,
        }),
    });
    attachTaskStream(req, res, task.id);
});

app.get('/api/ai/chat/:nodeId', (req, res) => {
    const messages = db.prepare(`
        SELECT id, role, content, reasoning, actions, created_at
        FROM chat_messages
        WHERE node_id = ?
        ORDER BY created_at
    `).all(req.params.nodeId);
    res.json(messages.map(withActions));
});

app.delete('/api/ai/chat/:nodeId', (req, res) => {
    db.prepare('DELETE FROM chat_messages WHERE node_id = ?').run(req.params.nodeId);
    res.json({ success: true });
});

// Overwrite a stored message's content. Used when a visual block inside an
// assistant reply is repaired (deterministically or via the AI repair loop) so
// the fix is persisted — a reopened chat then renders the corrected spec instead
// of the broken original. Content-only; role/node are immutable here.
app.put('/api/ai/chat/message/:id', (req, res) => {
    const id = Number(req.params.id);
    const { content } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'content (non-empty string) required' });
    }
    const info = db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run(content, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Message not found' });
    res.json({ success: true });
});

// Persist chat messages produced outside the normal stream save. Used when the
// user Stops a generation: /chat/stream only writes to the DB after its loop
// finishes, so an aborted turn saves nothing — the client sends the user turn +
// the partial assistant reply here so the conversation keeps full context (and
// can be continued).
app.post('/api/ai/chat/:nodeId/messages', (req, res) => {
    const nodeId = Number(req.params.nodeId);
    const node = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const valid = incoming.filter(m =>
        m && (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.trim()
    );

    const insert = db.prepare('INSERT INTO chat_messages (node_id, project_id, role, content) VALUES (?, ?, ?, ?)');
    const saved = [];
    db.transaction(() => {
        for (const m of valid) {
            const info = insert.run(nodeId, node.project_id, m.role, m.content);
            saved.push({ id: Number(info.lastInsertRowid), role: m.role, content: m.content });
        }
    })();

    res.json({ success: true, messages: saved });
});

export const routes = app.takeRoutes();
