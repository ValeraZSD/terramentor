// A topic's photos (server/topicPhotos.js): read them with their credit, and
// look for them again when a run found none or was stopped.
import db from '../database.js';
import { startPhotos, topicPhotos } from '../topicPhotos.js';
import { routeTable } from './routeTable.js';
import { keyed } from '../clientError.js';

const app = routeTable('photos');

const topicOf = (raw) => {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return db.prepare('SELECT id, project_id FROM live_nodes nodes WHERE id = ?').get(id) || null;
};

app.get('/api/nodes/:id/photos', (req, res) => {
    const node = topicOf(req.params.id);
    if (!node) return res.status(404).json(keyed('Topic not found'));
    res.json(topicPhotos(node.id));
});

// Only a topic that is learned by sight has examples to look for; a run
// already going for the course is joined, not doubled.
app.post('/api/nodes/:id/photos/find', (req, res) => {
    const node = topicOf(req.params.id);
    if (!node) return res.status(404).json(keyed('Topic not found'));
    const current = topicPhotos(node.id);
    if (current.state === null) return res.status(409).json(keyed('This topic has no photos to look for'));
    const out = startPhotos(node.project_id, { nodeIds: [node.id], origin: { surface: 'topic', detail: 'overview' } });
    if (!out.started && out.reason === 'ai_off') return res.status(409).json(keyed('AI features are disabled'));
    res.json({ started: out.started, ...topicPhotos(node.id) });
});

export const routes = app.takeRoutes();
