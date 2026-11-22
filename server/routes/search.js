// /api/search: the library search and its suggestions.
import { quickSuggest, searchAll } from '../search.js';
import { routeTable } from './routeTable.js';
import { apiError, clientError, keyed } from '../clientError.js';

const app = routeTable('search');

// A malformed `limit` falls back to the route's default: `Number('abc')` is NaN
// (SQL rejects `LIMIT NULL`) and a negative one is an unbounded `LIMIT` in SQLite.
// Only plain decimal digits count: `1e0`, `0x10`, `+3` and ` 5` are not ids or limits.
const wholeNumber = (raw) => {
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
};
const boundedLimit = (raw, fallback, cap) => {
    const n = wholeNumber(raw);
    return n === null ? fallback : Math.min(n, cap);
};
// An absent or empty `projectId` means the whole library; anything else must be
// a project id. NaN is falsy downstream, so a typo would silently widen the
// search from one project to every project.
const scopeOf = (raw) => {
    if (raw === undefined || raw === '') return { projectId: null };
    const n = wholeNumber(raw);
    return n === null ? { bad: true } : { projectId: n };
};

app.get('/api/search', (req, res) => {
    const { q, projectId, limit } = req.query;
    const scope = scopeOf(projectId);
    if (scope.bad) return res.status(400).json(apiError('projectId must be a project id'));
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
        return res.json({ projects: [], nodes: [], resources: [], documents: [] });
    }
    try {
        const results = searchAll(q, {
            projectId: scope.projectId,
            limit: boundedLimit(limit, 10, 50),
        });
        res.json(results);
    } catch (err) {
        console.error('[Search] Error:', err.message);
        res.status(500).json({ ...keyed('Search failed'), detail: clientError(err) });
    }
});

app.get('/api/search/suggest', (req, res) => {
    const { q, projectId, limit } = req.query;
    const scope = scopeOf(projectId);
    if (scope.bad) return res.status(400).json(apiError('projectId must be a project id'));
    if (!q || typeof q !== 'string' || q.trim().length < 1) {
        return res.json([]);
    }
    try {
        const results = quickSuggest(q, scope.projectId, boundedLimit(limit, 8, 20));
        res.json(results);
    } catch (err) {
        console.error('[Search/Suggest] Error:', err.message);
        res.status(500).json({ ...keyed('Suggest failed'), detail: clientError(err) });
    }
});

export const routes = app.takeRoutes();
