// A topic's photos (server/topicPhotos.js): read them with their credit, and
// look for them again when a run found none or was stopped.
import db from '../database.js';
import { startPhotos, topicPhotos } from '../topicPhotos.js';
import { answerPhoto, drawRound, practiceState } from '../photoPractice.js';
import { ATTEMPT_ID_ERROR, AttemptReusedError, readAttemptId } from '../mastery.js';
import { routeTable } from './routeTable.js';
import { apiError, errorBody, keyed } from '../clientError.js';

const app = routeTable('photos');

let topicStmt = null;
const topicOf = (raw) => {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    topicStmt ??= db.prepare('SELECT id, project_id FROM live_nodes nodes WHERE id = ?');
    return topicStmt.get(id) || null;
};

app.get('/api/nodes/:id/photos', (req, res) => {
    const node = topicOf(req.params.id);
    if (!node) return res.status(404).json(keyed('Topic not found'));
    res.json(topicPhotos(node.id));
});

// Only a topic that is learned by sight has examples to look for; while a
// run goes on for the course, the topic is searched by a run right after it.
app.post('/api/nodes/:id/photos/find', (req, res) => {
    const node = topicOf(req.params.id);
    if (!node) return res.status(404).json(keyed('Topic not found'));
    const current = topicPhotos(node.id);
    if (current.state === null) return res.status(409).json(keyed('This topic has no photos to look for'));
    const out = startPhotos(node.project_id, { nodeIds: [node.id], origin: { surface: 'topic', detail: 'overview', projectId: node.project_id, nodeId: node.id } });
    if (!out.started && out.reason === 'ai_off') return res.status(409).json(keyed('AI features are disabled'));
    res.json({ started: out.started, ...topicPhotos(node.id) });
});

// Telling the course's topics apart by their photos (server/photoPractice.js).
let projectStmt = null;
const courseOf = (raw) => {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    projectStmt ??= db.prepare('SELECT id FROM live_projects projects WHERE id = ?');
    return projectStmt.get(id)?.id ?? null;
};
const refuse = (res, err) => {
    const status = Number(err?.status) || 500;
    res.status(status).json(errorBody(err, status));
};

app.get('/api/projects/:id/photo-practice', (req, res) => {
    const id = courseOf(req.params.id);
    if (!id) return res.status(404).json(keyed('Project not found'));
    res.json(practiceState(id));
});

app.get('/api/projects/:id/photo-practice/round', (req, res) => {
    const id = courseOf(req.params.id);
    if (!id) return res.status(404).json(keyed('Project not found'));
    const size = req.query.size == null ? undefined : Number(req.query.size);
    try {
        res.json(drawRound(id, { size }));
    } catch (err) {
        refuse(res, err);
    }
});

app.post('/api/projects/:id/photo-practice/answer', (req, res) => {
    const id = courseOf(req.params.id);
    if (!id) return res.status(404).json(keyed('Project not found'));
    // Required: the one screen that asks sends one per photo shown, and a
    // pick sent without one would be written again on every retry.
    const attemptId = readAttemptId(req.body?.attemptId);
    if (!attemptId) return res.status(400).json(apiError(ATTEMPT_ID_ERROR));
    // The option's key, as the round sent it: the words a photo is named by
    // (at most 300 characters, server/photoCards.js answerKey). A longer one
    // was never offered, so it is refused, never cut into a different key.
    const raw = req.body?.picked;
    const picked = typeof raw === 'string' && raw.length <= 300 ? raw : null;
    try {
        res.json(answerPhoto(id, { photo: req.body?.photo, picked, attemptId }));
    } catch (err) {
        if (err instanceof AttemptReusedError) return res.status(err.status).json(errorBody(err, err.status));
        refuse(res, err);
    }
});

export const routes = app.takeRoutes();
