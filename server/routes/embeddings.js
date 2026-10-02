// /api/embeddings and /api/node-embeddings: vector status, settings and reindexing.
import {
    embeddingStats, getEmbeddingConfig, listEmbeddingModels, probeEmbedding, reindexAll, setEmbeddingSettings,
} from '../embeddings.js';
import { nodeEmbeddingStats, reindexAllNodes } from '../nodeEmbeddings.js';
import { invalidateAtlas } from '../atlas.js';
import { routeTable } from './routeTable.js';

const app = routeTable('embeddings');

// EMBEDDINGS / SEMANTIC SEARCH (Vault)

// Config + index stats + a live probe of whether an embedding model answers.
// Powers the Settings → "Semantic search" panel; the probe is cached server-side.
app.get('/api/embeddings/status', async (req, res) => {
    try {
        const config = getEmbeddingConfig();
        const stats = embeddingStats();
        const probe = req.query.probe === 'false' ? null : await probeEmbedding({ force: req.query.force === 'true' });
        res.json({ config, stats, probe });
    } catch (err) {
        console.error('[Embeddings/status] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// The embedding models the endpoint serving embeddings offers (see
// `listEmbeddingModels`) — the picker's list, never the chat list.
app.get('/api/embeddings/models', async (req, res) => {
    res.json(await listEmbeddingModels());
});

// Toggle the feature on/off, set the embedding model name, and pick which
// provider serves embeddings ('auto' = follow the chat provider).
app.post('/api/embeddings/settings', (req, res) => {
    const { enabled, model, provider } = req.body || {};
    const { reindexQueued } = setEmbeddingSettings({ enabled, model, provider });
    res.json({ config: getEmbeddingConfig(), ...(reindexQueued ? { reindexQueued } : {}) });
});

// Re-embed every ready document (after enabling the feature or switching model).
app.post('/api/embeddings/reindex', (req, res) => {
    if (!getEmbeddingConfig().vecAvailable)
        return res.status(400).json({ error: 'sqlite-vec extension is not loaded — semantic search is unavailable on this build.' });
    res.json(reindexAll());
});

// TOPIC EMBEDDINGS (the curriculum itself, not the vault)

// How much of the curriculum is mapped into the shared topic space. Same shape
// of answer as /api/embeddings/status, minus the probe — one embedding model
// serves both, so probing twice would just swap a llama-swap model for nothing.
app.get('/api/node-embeddings/status', (req, res) => {
    try {
        res.json({ config: getEmbeddingConfig(), stats: nodeEmbeddingStats() });
    } catch (err) {
        console.error('[NodeEmbeddings/status] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/node-embeddings/reindex', (req, res) => {
    if (!getEmbeddingConfig().vecAvailable)
        return res.status(400).json({ error: 'sqlite-vec extension is not loaded — semantic search is unavailable on this build.' });
    invalidateAtlas();   // every vector is about to be rewritten
    res.json(reindexAllNodes());
});

export const routes = app.takeRoutes();
