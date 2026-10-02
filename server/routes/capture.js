// /api/capture and /api/assistant/cards: quick capture to the Inbox and cards the assistant proposes.
import db from '../database.js';
import { getAISettings } from '../ai.js';
import { createCapture, enrichCapture, findCapturedText } from '../capture.js';
import * as tasks from '../tasks.js';
import { scheduleNodeSync } from '../nodeEmbeddings.js';
import { addAssistantCard, undoAssistantCard } from '../assistantWrites.js';
import { nodeTaskInfo } from './taskStream.js';
import { routeTable } from './routeTable.js';

const app = routeTable('capture');

// AD-HOC CAPTURE ("I read something and want to keep it")
//
// Two steps on purpose: the node is written synchronously and returned, then
// enrichment runs as a background task. Pressing Save can therefore never lose
// the thing the learner wanted to keep, whatever the AI does afterwards.
app.post('/api/capture', (req, res) => {
    const { text, url, title, hasFiles, once } = req.body || {};
    // `once`: the assistant's prepared note, whose Save is offered again on
    // every re-read of the conversation (capture.js findCapturedText).
    if (once && !url && !hasFiles) {
        const found = findCapturedText(text);
        if (found) return res.json({ ...found, taskId: null, existed: true, node: db.prepare('SELECT * FROM nodes WHERE id = ?').get(found.nodeId) });
    }
    let created;
    try {
        created = createCapture({ text, url, title });
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
    // Map the capture now — enrichment rewrites the title and Overview later,
    // and re-maps it itself when it does.
    scheduleNodeSync();

    // A file/photo capture has nothing to enrich yet — the client uploads the
    // files next and then calls /api/capture/:nodeId/enrich. Starting the
    // background task here would race that upload and see an empty node.
    let taskId = null;
    if (!hasFiles && getAISettings().model) {
        const captureInfo = nodeTaskInfo(created.nodeId);
        // `once` is the assistant's prepared note, saved from under its answer;
        // anything else came through the capture box.
        const captureOrigin = once
            ? { surface: 'assistant', detail: 'assistant_capture', nodeId: created.nodeId, projectId: created.projectId }
            : { surface: 'inbox', detail: 'capture_box', nodeId: created.nodeId, projectId: created.projectId };
        const { task } = tasks.createTask({
            kind: 'capture',
            label: 'Capture',
            labelKey: 'Capture',
            origin: captureOrigin,
            // Name and colour too, not just the id: the dock draws the project
            // COLOUR, and a chip that has none takes the accent of whatever
            // screen the reader is on rather than of the work.
            projectId: created.projectId,
            projectName: captureInfo?.projectName || null,
            projectColor: captureInfo?.projectColor || null,
            nodeId: created.nodeId,
            run: ({ emit, signal }) => enrichCapture({ nodeId: created.nodeId, url, emit, signal }),
        });
        taskId = task.id;
    }

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(created.nodeId);
    res.json({ ...created, taskId, node });
});

// A card the assistant proposed, added because the learner pressed Add under
// its preview (server/assistantWrites.js). Undo removes it only while it has
// never been reviewed; a studied card is kept and the answer says so.
app.post('/api/assistant/cards', (req, res) => {
    const { nodeId, front, back, extra } = req.body || {};
    try {
        res.json(addAssistantCard({ nodeId, front, back, extra }));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/assistant/cards/:id', (req, res) => {
    try {
        res.json(undoAssistantCard(req.params.id));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Second half of a file/photo capture — see the `hasFiles` note above.
app.post('/api/capture/:nodeId/enrich', (req, res) => {
    const nodeId = Number(req.params.nodeId);
    const node = db.prepare('SELECT id, project_id FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return res.status(404).json({ error: 'Capture not found' });
    if (!getAISettings().model) return res.json({ taskId: null });

    const { url = '' } = req.body || {};
    const info = nodeTaskInfo(nodeId);
    // Only the capture box attaches files, so this is always its second half.
    const enrichOrigin = { surface: 'inbox', detail: 'capture_box', nodeId, projectId: node.project_id };
    const { task } = tasks.createTask({
        kind: 'capture',
        label: 'Capture',
        labelKey: 'Capture',
        origin: enrichOrigin,
        projectId: node.project_id,
        projectName: info?.projectName || null,
        projectColor: info?.projectColor || null,
        nodeId,
        run: ({ emit, signal }) => enrichCapture({ nodeId, url, emit, signal }),
    });
    res.json({ taskId: task.id });
});

export const routes = app.takeRoutes();
