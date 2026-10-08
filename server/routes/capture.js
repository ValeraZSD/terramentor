// /api/capture and /api/assistant/*: quick capture to the Inbox, and what the
// assistant prepares for the learner to press — cards, course and topic
// changes, saved links — with the checks run before any of it is offered.
import db from '../database.js';
import { getAISettings } from '../ai.js';
import { createCapture, enrichCapture, findCapturedText } from '../capture.js';
import * as tasks from '../tasks.js';
import { scheduleNodeSync } from '../nodeEmbeddings.js';
import { addAssistantCard, undoAssistantCard } from '../assistantWrites.js';
import { applyAssistantEdit, currentValues, editBySource, EditError, saveAssistantAttachment, saveAssistantLink, undoAssistantEdit } from '../assistantEdits.js';
import { checkCards, checkLink } from '../assistantChecks.js';
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
//
// The card is CHECKED first (server/assistantChecks.js) — the preview asked
// already, so this is normally a stored verdict — and a back a second model
// disputes is not added, whatever the button said.
app.post('/api/assistant/cards', async (req, res) => {
    const { nodeId, front, back, extra } = req.body || {};
    try {
        if (front && back) {
            const [check] = await checkCards([{ nodeId, front: String(front), back: String(back) }]);
            if (check?.verdict === 'disputed') return res.status(409).json({ error: `Not added: ${check.reason}.`, check });
        }
        res.json(addAssistantCard({ nodeId, front, back, extra }));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// The checks behind the previews: a verdict per card and per link, run once
// per content and kept (server/assistantChecks.js). Bounded like the blocks
// themselves — a message proposes at most three cards and three links.
app.post('/api/assistant/checks', async (req, res) => {
    const cards = Array.isArray(req.body?.cards) ? req.body.cards.slice(0, 3) : [];
    const links = Array.isArray(req.body?.links) ? req.body.links.slice(0, 3) : [];
    try {
        const usable = cards.filter(c => c && Number.isInteger(Number(c.nodeId)) && String(c.front ?? '').trim() && String(c.back ?? '').trim());
        if (usable.length !== cards.length) return res.status(400).json({ error: 'A card needs a topic, a front and a back.' });
        const cardVerdicts = await checkCards(usable.map(c => ({ nodeId: Number(c.nodeId), front: String(c.front), back: String(c.back) })));
        const linkVerdicts = [];
        for (const url of links) linkVerdicts.push(await checkLink(String(url ?? '')));
        res.json({ cards: cardVerdicts, links: linkVerdicts });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// A change the assistant prepared, applied on the learner's press, and its
// Undo (server/assistantEdits.js — every value judged there, compare-and-set
// both ways). `current` is what a preview shows as BEFORE; Apply must name
// the values it was shown (`expect`), so a field changed since is not
// overwritten unseen.
const sendEditError = (res, e) => {
    if (e instanceof EditError) {
        const { status, message, ...extra } = e;
        return res.status(status).json({ error: message, ...extra });
    }
    return res.status(500).json({ error: e.message });
};

app.get('/api/assistant/targets/:kind/:id', (req, res) => {
    try {
        res.json(currentValues(req.params.kind, req.params.id));
    } catch (e) {
        sendEditError(res, e);
    }
});

app.get('/api/assistant/edits', (req, res) => {
    res.json({ edit: editBySource(String(req.query.source || '')) });
});

app.post('/api/assistant/edits', (req, res) => {
    const { kind, targetId, projectId, changes, expect, source } = req.body || {};
    try {
        res.json(applyAssistantEdit({ kind, targetId, projectId, changes, expect, source }));
    } catch (e) {
        sendEditError(res, e);
    }
});

app.post('/api/assistant/edits/:id/undo', (req, res) => {
    try {
        res.json(undoAssistantEdit(req.params.id));
    } catch (e) {
        sendEditError(res, e);
    }
});

// A page saved on a topic. Checked first: a page that does not exist is not
// saved, and a page that was opened is saved under its OWN title.
app.post('/api/assistant/links', async (req, res) => {
    const { projectId, nodeId, url, title, source } = req.body || {};
    try {
        const check = await checkLink(String(url ?? ''));
        if (check.verdict === 'disputed') return res.status(409).json({ error: `Not saved: ${check.reason}.`, check });
        res.json({ ...saveAssistantLink({ projectId, nodeId, url, title: check.detail?.title || title, source }), check });
    } catch (e) {
        sendEditError(res, e);
    }
});

// A file from the chat saved into the library, with the description the
// assistant wrote for it (server/assistantEdits.js `saveAssistantAttachment`).
// Undo goes through /api/assistant/edits/:id/undo like every other change.
app.post('/api/assistant/attachments/:id/save', (req, res) => {
    const { projectId = null, nodeId = null, inbox = false, title = '', description = '', conversationId = null, source = null } = req.body || {};
    try {
        res.json(saveAssistantAttachment({ attachmentId: req.params.id, projectId, nodeId, inbox: inbox === true, title, description, conversationId, source }));
    } catch (e) {
        sendEditError(res, e);
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
