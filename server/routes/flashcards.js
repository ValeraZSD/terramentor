// Flashcards: generation, editing, and the due lists.
//
// Mounted in 4 blocks (see createApp in server/app.js), because the server
// registers other areas' routes between them and Express matches in registration
// order. A new route goes in the block it belongs with.
import db from '../database.js';
import { generateResponse, streamResponse } from '../ai.js';
import { buildFlashcardPrompt, finalizeFlashcards } from '../studyMaterial.js';
import * as tasks from '../tasks.js';
import { globalStudyQueue, studyQueue } from '../decks.js';
import { writeCard } from '../cardWrite.js';
import { attachTaskStream, nodeTaskInfo, requestOrigin } from './taskStream.js';
import { requireProject } from './projectRows.js';
import { routeTable } from './routeTable.js';
import { clientError, publicMessage } from '../clientError.js';

const app = routeTable('flashcards');

// Top-level category for each card's node, memoised per ancestor so a session
// of thousands of cards does not re-walk (and re-prepare) the same chain per
// card. Same result as the old per-card loop: the root ancestor's title + id.
const nodeParentStmt = db.prepare('SELECT id, title, parent_id FROM nodes WHERE id = ?');
function withTopCategory(cards) {
    const memo = new Map();
    const topOf = (id) => {
        if (id == null) return { categoryTitle: null, categoryId: null };
        if (memo.has(id)) return memo.get(id);
        let cur = nodeParentStmt.get(id);
        let depth = 0;
        let out = { categoryTitle: null, categoryId: null };
        while (cur && depth < 10) {
            if (cur.parent_id === null) { out = { categoryTitle: cur.title, categoryId: cur.id }; break; }
            cur = nodeParentStmt.get(cur.parent_id);
            depth++;
        }
        memo.set(id, out);
        return out;
    };
    return cards.map(card => ({ ...card, ...topOf(card.parent_id) }));
}

// AI FLASHCARDS

// The model's raw output becomes saved flashcard rows in finalizeFlashcards
// (server/studyMaterial.js), shared by the blocking and streaming endpoints.
app.post('/api/ai/flashcards', async (req, res) => {
    const { nodeId, count = 10 } = req.body;
    let aiResponse = null;
    try {
        const { system, user } = buildFlashcardPrompt(nodeId, count);
        aiResponse = await generateResponse(user, system, [], { job: 'questions' });
        res.json(await finalizeFlashcards(nodeId, aiResponse));
    } catch (error) {
        console.error('Flashcard generation error:', error);
        res.status(500).json({
            error: publicMessage(error),
            rawResponse: aiResponse
        });
    }
});

// Streaming variant: same result as /api/ai/flashcards, but runs as a
// background task (survives the client going away; visible/cancellable in
// the global task dock) and emits the model's reasoning + running output
// length so the client can show live "Thinking… / Generating…" counts.
async function runFlashcardGeneration({ nodeId, count, emit, signal }) {
    let aiResponse = '';
    let thinkingChars = 0;
    try {
        const { system, user } = buildFlashcardPrompt(nodeId, count);
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.5, think: true, job: 'questions' })) {
            if (part && part.type === 'content' && part.content) {
                aiResponse += part.content;
                emit({ progress: aiResponse.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                emit({ thinking: thinkingChars });
            }
        }
        return await finalizeFlashcards(nodeId, aiResponse, { signal });
    } catch (error) {
        if (signal.aborted) return { cancelled: true };
        console.error('Flashcard generation error:', error);
        if (error.rawResponse === undefined) error.rawResponse = aiResponse || null;
        throw error;
    }
}

app.post('/api/ai/flashcards/stream', (req, res) => {
    const { nodeId, count = 10 } = req.body;
    if (!nodeId) return res.status(400).json({ error: 'Missing required field: nodeId' });
    const info = nodeTaskInfo(Number(nodeId));
    if (!info) return res.status(404).json({ error: 'Node not found' });

    const cardsOrigin = requestOrigin(req, { surface: 'topic', detail: 'flashcards', nodeId: Number(nodeId), projectId: info.projectId });
    const { task } = tasks.createTask({
        kind: 'flashcards',
        label: info.title,
        origin: cardsOrigin,
        nodeId: Number(nodeId),
        projectId: info.projectId,
        projectName: info.projectName,
        projectColor: info.projectColor,
        dedupeKey: `flashcards:${nodeId}`,
        run: ({ emit, signal }) => runFlashcardGeneration({ nodeId: Number(nodeId), count, emit, signal }),
    });
    attachTaskStream(req, res, task.id);
});

export const generationRoutes = app.takeRoutes();

app.get('/api/ai/flashcards/:nodeId', (req, res) => {
    const flashcards = db.prepare('SELECT * FROM flashcards WHERE node_id = ? ORDER BY created_at').all(req.params.nodeId);
    res.json(flashcards);
});

app.put('/api/ai/flashcards/:id', (req, res) => {
    // The write is server/cardWrite.js, shared with the card review an agent
    // host draws in its own window.
    const { status, json } = writeCard(req.params.id, req.body || {});
    res.status(status).json(json);
});

app.delete('/api/ai/flashcards/:id', (req, res) => {
    db.prepare('DELETE FROM flashcards WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

export const cardRoutes = app.takeRoutes();

// PROJECT-LEVEL FLASHCARD ENDPOINTS

app.get('/api/projects/:projectId/flashcards', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;

    try {
        const flashcards = db.prepare(`
            SELECT f.*,
                n.title as node_title,
                n.parent_id
            FROM flashcards f
            JOIN nodes n ON n.id = f.node_id
            WHERE n.project_id = ?
            ORDER BY n.position, f.created_at
        `).all(projectId);

        const enriched = flashcards.map(card => {
            let categoryTitle = null;
            let categoryId = null;
            let currentId = card.parent_id;
            let depth = 0;
            while (currentId && depth < 10) {
                const parent = db.prepare('SELECT id, title, parent_id FROM nodes WHERE id = ?').get(currentId);
                if (!parent) break;
                if (parent.parent_id === null) {
                    categoryTitle = parent.title;
                    categoryId = parent.id;
                    break;
                }
                currentId = parent.parent_id;
                depth++;
            }
            return { ...card, categoryTitle, categoryId };
        });

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: clientError(err) });
    }
});

app.get('/api/projects/:projectId/flashcards/due', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;

    try {
        // The session this serves is the same session the project's own screen
        // opens, so it comes from the same queue: reviews that are OWED, then
        // the day's remaining allowance of new cards. Counting `next_review IS
        // NULL` as due would hand a fresh curriculum project 615 cards — every
        // card it has, never seen — the moment its Review button is pressed.
        // See server/decks.js.
        const { reviews, fresh } = studyQueue(projectId);
        const enriched = withTopCategory([...reviews, ...fresh]);

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: clientError(err) });
    }
});

export const projectCardRoutes = app.takeRoutes();

// Due flashcards across every active project — feeds the global review session.
// Same shape as the per-project /flashcards/due, enriched with project identity
// so a mixed-project queue can badge each card.
app.get('/api/flashcards/due', (req, res) => {
    try {
        // Every project introduces its new cards through the same rationed
        // queue (server/decks.js). Counting never-seen cards as "due" here would
        // hand the cross-project session every unseen card in one payload, and
        // the same card would be rationed on one screen and dumped in a pile on
        // another.
        const { reviews, fresh } = globalStudyQueue();
        const enriched = withTopCategory([...reviews, ...fresh]);

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: clientError(err) });
    }
});

export const dueRoutes = app.takeRoutes();
