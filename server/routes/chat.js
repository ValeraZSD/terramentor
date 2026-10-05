// /api/ai/assistant and /api/ai/conversations: the app's one chat.
//
// The assistant takes the open topic's whole context from the page it is asked
// on (server/pageContext.js), so no topic needs a chat of its own, and keeps a
// list of conversations (server/chatConversations.js).
import db from '../database.js';
import * as tasks from '../tasks.js';
import { runChatTurn, withActions } from '../chatTurn.js';
import { buildPageContext } from '../pageContext.js';
import { conversationTitle } from '../chatConversations.js';
import { attachTaskStream } from './taskStream.js';
import { routeTable } from './routeTable.js';

const app = routeTable('chat');

/** A new conversation, titled by its first question, remembering the topic it began on. */
function createConversation(message, nodeId) {
    const now = new Date().toISOString();
    return Number(db.prepare('INSERT INTO chat_conversations (title, node_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(conversationTitle(message), nodeId ?? null, now, now).lastInsertRowid);
}

/** A conversation whose only turn produced nothing did not happen either. */
function dropIfEmpty(conversationId) {
    db.prepare(`
        DELETE FROM chat_conversations
        WHERE id = ? AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE conversation_id = ?)
    `).run(conversationId, conversationId);
}

/** Is a turn running (or queued) in this conversation? */
function turnRunningIn(conversationId) {
    const t = tasks.findActive({ kind: 'today_chat' });
    return !!t && t.meta?.conversationId === conversationId;
}

app.post('/api/ai/assistant/stream', (req, res) => {
    const { message, context } = req.body || {};
    if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'Missing required field: message' });
    }
    // One turn at a time across every conversation: they share one model, and
    // a second question while one is still generating must reattach to it,
    // not fork a parallel turn against stale history.
    if (tasks.findActive({ kind: 'today_chat' })) {
        return res.status(409).json({ error: 'The assistant is still answering. Wait for it to finish or stop it first.' });
    }
    // The client sends only WHERE it is (a view name and ids). The description
    // is built from the database, so the prompt can never be fed prose the
    // client made up about a topic that does not exist.
    const page = buildPageContext(context);
    // An unknown id (deleted on another device, or a first turn that failed and
    // took its conversation with it) starts a new conversation rather than
    // failing the question.
    const asked = Number(req.body.conversationId);
    const known = Number.isInteger(asked) && db.prepare('SELECT 1 FROM chat_conversations WHERE id = ?').get(asked);
    const conversationId = known ? asked : createConversation(message, page.nodeId);
    const { task } = tasks.createTask({
        kind: 'today_chat',
        // The chip's kind already says "Assistant"; the label says which
        // question, the way a quiz's chip names its topic.
        label: conversationTitle(message),
        origin: { surface: 'assistant' },
        meta: { message: String(message), conversationId },
        run: async ({ emit, signal }) => {
            try {
                return await runChatTurn({
                    conversationId, message: String(message), page,
                    emit, signal, timeZone: req.body.timeZone,
                });
            } finally {
                if (!known) dropIfEmpty(conversationId);
            }
        },
    });
    attachTaskStream(req, res, task.id);
});

// Newest first. `nodeTitle` is read through the node, so a renamed topic is
// named as it is now, and a deleted one is simply absent.
app.get('/api/ai/conversations', (req, res) => {
    const rows = db.prepare(`
        SELECT c.id, c.title, c.node_id AS nodeId, n.title AS nodeTitle, n.project_id AS projectId,
               c.created_at AS createdAt, c.updated_at AS updatedAt,
               (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS messageCount
        FROM chat_conversations c
        LEFT JOIN nodes n ON n.id = c.node_id
        ORDER BY c.updated_at DESC, c.id DESC
    `).all();
    res.json(rows);
});

app.get('/api/ai/conversations/:id/messages', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM chat_conversations WHERE id = ?').get(id)) {
        return res.status(404).json({ error: 'Conversation not found' });
    }
    const messages = db.prepare(`
        SELECT id, role, content, reasoning, actions, created_at
        FROM chat_messages
        WHERE conversation_id = ?
        ORDER BY created_at, id
    `).all(id);
    res.json(messages.map(withActions));
});

app.delete('/api/ai/conversations/:id', (req, res) => {
    const id = Number(req.params.id);
    if (turnRunningIn(id)) {
        return res.status(409).json({ error: 'The assistant is still answering in this conversation. Stop it first.' });
    }
    const removed = db.transaction(() => {
        db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(id);
        return db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id).changes;
    })();
    if (!removed) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ success: true });
});

// Overwrite a stored message's content. Used when a visual block inside an
// assistant reply is repaired (deterministically or via the AI repair loop) so
// the fix is persisted — a reopened chat then renders the corrected spec instead
// of the broken original. Content-only; role and conversation are immutable here.
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

export const routes = app.takeRoutes();
