// /api/search: the library search and its suggestions.
import { quickSuggest, searchAll } from '../search.js';
import { routeTable } from './routeTable.js';

const app = routeTable('search');

app.get('/api/search', (req, res) => {
    const { q, projectId, limit } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
        return res.json({ projects: [], nodes: [], resources: [], documents: [] });
    }
    try {
        const results = searchAll(q, {
            projectId: projectId ? Number(projectId) : null,
            limit: limit ? Math.min(Number(limit), 50) : 10,
        });
        res.json(results);
    } catch (err) {
        console.error('[Search] Error:', err.message);
        res.status(500).json({ error: 'Search failed', detail: err.message });
    }
});

app.get('/api/search/suggest', (req, res) => {
    const { q, projectId, limit } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length < 1) {
        return res.json([]);
    }
    try {
        const results = quickSuggest(
            q,
            projectId ? Number(projectId) : null,
            limit ? Math.min(Number(limit), 20) : 8
        );
        res.json(results);
    } catch (err) {
        console.error('[Search/Suggest] Error:', err.message);
        res.status(500).json({ error: 'Suggest failed', detail: err.message });
    }
});

export const routes = app.takeRoutes();
