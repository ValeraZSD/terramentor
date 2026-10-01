// /api/atlas and the topic-similarity routes built on the same vectors.
import { MIN_SIMILARITY, searchNodesSemantic, similarNodes } from '../nodeEmbeddings.js';
import { applyTransfer, computeTransfer, getTransferInfo } from '../masteryTransfer.js';
import { buildAtlas, invalidateAtlas } from '../atlas.js';
import { clearRegionName, regionNameStats, setRegionName, validateUserName } from '../regionNaming.js';
import { getGateConfig } from '../settingsStore.js';
import { routeTable } from './routeTable.js';

const app = routeTable('atlas');

// ATLAS — the library as one space (server/atlas.js)

// Never 500s on a missing topic space: an unmapped library is a legitimate
// state (no embedding model), and the client renders `available:false` with
// `reason` as an explanation rather than an error.
app.get('/api/atlas', async (req, res) => {
    try {
        const raw = Number(req.query.similarity);
        const atlas = await buildAtlas({
            regionSimilarity: Number.isFinite(raw) ? Math.max(0.5, Math.min(0.95, raw)) : undefined,
            includeArchived: req.query.archived === 'true',
            refresh: req.query.refresh === 'true',
        });
        // Attached per request rather than baked into the cached atlas: the
        // naming sweep runs behind the map, so this is the one part of the
        // answer that is stale the moment it is cached.
        res.json({ ...atlas, naming: regionNameStats(atlas.regions) });
    } catch (err) {
        console.error('[Atlas] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Name a region by hand.
//
// The map names regions after their most central topic, and a model rewrites
// that where it can — but both are guesses about someone else's library, and
// the learner is the one person who knows what a place on it is called. One
// edit settles what no amount of prompt tuning can, so it exists.
//
// Addressed by SIGNATURE, not by index: a region has no id of its own (it is
// derived, and renumbered on every rebuild), while its member set is exactly
// what identifies it across builds — the same key the name cache uses.
app.put('/api/atlas/regions/:signature/name', (req, res) => {
    try {
        const signature = String(req.params.signature || '');
        if (!/^[0-9a-f]{64}$/.test(signature)) return res.status(400).json({ error: 'Not a region signature.' });
        const verdict = validateUserName(req.body?.label);
        if (!verdict.ok) {
            return res.status(400).json({
                error: verdict.reason === 'empty' ? 'A region needs a name.'
                    : verdict.reason === 'too-long' ? 'That name is too long for the map.'
                        : 'A region name is plain text.',
            });
        }
        setRegionName(signature, verdict.label, Number(req.body?.size) || null);
        // The atlas is cached against the topic space, which a rename does not
        // touch — without this the learner's own name would not appear until
        // something else forced a rebuild.
        invalidateAtlas();
        res.json({ label: verdict.label, labelSource: 'user' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Hand a region back to the map: the medoid now, a fresh model name later.
app.delete('/api/atlas/regions/:signature/name', (req, res) => {
    try {
        const signature = String(req.params.signature || '');
        if (!/^[0-9a-f]{64}$/.test(signature)) return res.status(400).json({ error: 'Not a region signature.' });
        clearRegionName(signature);
        invalidateAtlas();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Topics that mean roughly the same thing as this one. An empty list is a
// legitimate answer (nothing similar, or no embedding model) — never an error,
// because every consumer treats neighbours as an enhancement.
app.get('/api/nodes/:id/similar', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
        const min = req.query.min !== undefined ? Number(req.query.min) : MIN_SIMILARITY;
        const results = await similarNodes(Number(req.params.id), {
            limit,
            minSimilarity: Number.isFinite(min) ? Math.max(0, Math.min(1, min)) : MIN_SIMILARITY,
            crossProjectOnly: req.query.crossProject === 'true',
            masteredOnly: req.query.mastered === 'true',
            threshold: getGateConfig().threshold,
        });
        res.json({ results });
    } catch (err) {
        console.error('[NodeEmbeddings/similar] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Has this topic already been proven elsewhere? Returns the stored head start
// when the sweep has already found one, and otherwise computes it live — the
// detail panel is opened on one node at a time, so a single KNN (and, for a
// node that isn't mapped yet, a single embedding call) is the right cost.
app.get('/api/nodes/:id/transfer', async (req, res) => {
    try {
        const nodeId = Number(req.params.id);
        const stored = getTransferInfo(nodeId);
        if (stored) return res.json({ transfer: stored });

        const gate = getGateConfig();
        // Persist it if the node is eligible, so the feed sees it without
        // waiting for the next sweep; fall back to a preview when it isn't.
        const applied = await applyTransfer(nodeId, { threshold: gate.threshold, decayDays: gate.decayDays });
        if (applied.applied) return res.json({ transfer: getTransferInfo(nodeId) });

        const preview = await computeTransfer(nodeId, { threshold: gate.threshold, decayDays: gate.decayDays });
        res.json({ transfer: preview.sources.length ? { ...preview, spent: true, at: null } : null });
    } catch (err) {
        console.error('[Transfer] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Free-text search over topics ("where have I studied convolution?").
app.get('/api/nodes/search-semantic', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
        const results = await searchNodesSemantic(String(req.query.q || ''), {
            limit,
            projectId: req.query.projectId ? Number(req.query.projectId) : null,
        });
        res.json({ results });
    } catch (err) {
        console.error('[NodeEmbeddings/search] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

export const routes = app.takeRoutes();
