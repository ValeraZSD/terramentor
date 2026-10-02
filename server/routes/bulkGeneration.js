// /api/ai/bulk: study material for many topics in one run.
import { bulkCandidates, bulkStatus, cancelBulk, MAX_BULK_NODES, startBulk } from '../bulkGen.js';
import { routeTable } from './routeTable.js';

const app = routeTable('bulkGeneration');

// BULK STUDY MATERIAL
//
// One request covers many topics. Deliberately NOT an SSE stream: the job
// outlives any page (it is on bulkGen's own chain, mirrored into the TaskDock),
// so the client polls a plain status endpoint and can close the dialog, walk
// away, or reload without touching the run.

app.get('/api/projects/:id/bulk-candidates', (req, res) => {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Bad project id' });
    try {
        res.json({
            candidates: bulkCandidates(projectId),
            max: MAX_BULK_NODES,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/ai/bulk', (req, res) => {
    const { projectId, nodeIds, kinds, questionCount, cardCount, skipExisting = true } = req.body || {};
    if (!Number.isInteger(Number(projectId))) {
        return res.status(400).json({ error: 'Missing required field: projectId' });
    }
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
        return res.status(400).json({ error: 'Pick at least one topic.' });
    }
    try {
        res.json(startBulk({
            projectId: Number(projectId),
            nodeIds,
            kinds: Array.isArray(kinds) ? kinds : [],
            questionCount, cardCount, skipExisting,
        }));
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.get('/api/ai/bulk', (req, res) => res.json(bulkStatus()));

app.delete('/api/ai/bulk', (req, res) => res.json({ cancelled: cancelBulk() }));

export const routes = app.takeRoutes();
