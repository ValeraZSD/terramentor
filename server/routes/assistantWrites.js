// /api/assistant/*: what the assistant prepares for the learner to press —
// cards, course and topic changes, saved links and files — with the checks
// run before any of it is offered.
import { addAssistantCard, undoAssistantCard } from '../assistantWrites.js';
import { applyAssistantEdit, currentValues, editBySource, EditError, saveAssistantAttachment, saveAssistantLink, undoAssistantEdit } from '../assistantEdits.js';
import { checkCards, checkLink, peekLink } from '../assistantChecks.js';
import { routeTable } from './routeTable.js';
import { clientError } from '../clientError.js';

const app = routeTable('assistantWrites');

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
        res.status(400).json({ error: clientError(e, 400) });
    }
});

// The checks behind the previews: a verdict per card and per link, run once
// per content and kept (server/assistantChecks.js). Bounded like the blocks
// themselves — a message proposes at most three cards and three links. A link
// is only PEEKED at here (a refused address, or what an earlier Save found):
// its page is opened by the Save press below, never by a preview being drawn.
app.post('/api/assistant/checks', async (req, res) => {
    const cards = Array.isArray(req.body?.cards) ? req.body.cards.slice(0, 3) : [];
    const links = Array.isArray(req.body?.links) ? req.body.links.slice(0, 3) : [];
    try {
        const usable = cards.filter(c => c && Number.isInteger(Number(c.nodeId)) && String(c.front ?? '').trim() && String(c.back ?? '').trim());
        if (usable.length !== cards.length) return res.status(400).json({ error: 'A card needs a topic, a front and a back.' });
        const cardVerdicts = await checkCards(usable.map(c => ({ nodeId: Number(c.nodeId), front: String(c.front), back: String(c.back) })));
        const linkVerdicts = [];
        for (const url of links) linkVerdicts.push(peekLink(String(url ?? '')));
        res.json({ cards: cardVerdicts, links: linkVerdicts });
    } catch (e) {
        res.status(500).json({ error: clientError(e) });
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
    return res.status(500).json({ error: clientError(e) });
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
    const { projectId = null, nodeId = null, title = '', description = '', conversationId = null, source = null } = req.body || {};
    try {
        res.json(saveAssistantAttachment({ attachmentId: req.params.id, projectId, nodeId, title, description, conversationId, source }));
    } catch (e) {
        sendEditError(res, e);
    }
});

app.delete('/api/assistant/cards/:id', (req, res) => {
    try {
        res.json(undoAssistantCard(req.params.id));
    } catch (e) {
        res.status(400).json({ error: clientError(e, 400) });
    }
});

export const routes = app.takeRoutes();
