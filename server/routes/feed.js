// /api/feed: the card stream, answers, and edits to a stored card.
//
// Mounted in 2 blocks (see createApp in server/app.js), because the server
// registers other areas' routes between them and Express matches in registration
// order. A new route goes in the block it belongs with.
import db from '../database.js';
import { ATTEMPT_ID_ERROR, readAttemptId } from '../mastery.js';
import { buildFeedHeader, composeFeed, consumeFeedItem, replaceSpecInContent } from '../feed.js';
import * as feedGen from '../feedGen.js';
import { scheduleTransferSweep } from '../masteryTransfer.js';
import { getGateConfig } from '../settingsStore.js';
import { routeTable } from './routeTable.js';

const app = routeTable('feed');

// LEARNING FEED — the home page's card stream (server/feed.js composes,
// server/feedGen.js pre-generates AI teaching content in the background).

const FEED_LIMIT_MAX = 30;
// 'practice' is consumed server-side by the paper grading endpoints, not by the
// client calling /consume — but it stays listed so a client that does call it
// (e.g. a learner dismissing an exercise) is not rejected.
const FEED_CARD_KINDS = new Set(['lesson', 'question', 'recall', 'practice']);

app.get('/api/feed', (req, res) => {
    try {
        const limit = Math.min(FEED_LIMIT_MAX, Math.max(1, parseInt(req.query.limit, 10) || 15));
        const excludeKeys = new Set(
            String(req.query.exclude || '').split(',').map(s => s.trim()).filter(Boolean)
        );
        const gate = getGateConfig();
        // ?nodeId= scopes the stream to one topic (or a section's leaves) and
        // ?projectId= to one course; with neither it is the whole library.
        // One composer answers all three — see composeFeed's scope note.
        const nodeId = parseInt(req.query.nodeId, 10);
        const scopedNode = Number.isInteger(nodeId) && nodeId > 0 ? nodeId : null;
        const pid = parseInt(req.query.projectId, 10);
        const scopedProject = !scopedNode && Number.isInteger(pid) && pid > 0 ? pid : null;
        const { items, exhausted, transfers, placements } = composeFeed({
            limit, excludeKeys, gate, nodeId: scopedNode, projectId: scopedProject,
        });
        const header = buildFeedHeader();
        res.json({
            date: header.date, header, items, exhausted, transfers, placements,
            nodeId: scopedNode, projectId: scopedProject,
        });
        // Top up the teaching buffer in the background (never blocks the
        // response). A topic opened on purpose is written FIRST; a course
        // asks for whatever its own stream is teaching next.
        if (scopedNode) feedGen.requestNode(scopedNode);
        else if (scopedProject) {
            for (const id of items.map(i => i.nodeId).filter(Boolean).slice(0, 3)) feedGen.requestNode(id);
            feedGen.ensureBuffer();
        }
        else feedGen.ensureBuffer();
        // Refresh head starts. Fired here rather than on a timer because this is
        // the surface that displays them, and because proving a topic elsewhere
        // (which is what changes them) always ends with the learner back on the
        // feed. Debounced and model-free, so it costs nothing on a rapid scroll.
        scheduleTransferSweep({ threshold: gate.threshold, decayDays: gate.decayDays });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/feed/consume', (req, res) => {
    try {
        const { key, kind, feedItemId, nodeId, result } = req.body || {};
        if (!FEED_CARD_KINDS.has(kind)) {
            return res.status(400).json({ error: `kind must be one of: ${[...FEED_CARD_KINDS].join(', ')}` });
        }
        if ((kind === 'question' || kind === 'recall') && !Number.isInteger(nodeId)) {
            return res.status(400).json({ error: 'nodeId is required for question/recall cards' });
        }
        const attemptId = readAttemptId(req.body?.attemptId);
        if (attemptId === undefined) return res.status(400).json({ error: ATTEMPT_ID_ERROR });
        // The row's transition, the evidence and a bank question's log row are
        // one transaction inside consumeFeedItem; a replayed attemptId writes nothing.
        const outcome = consumeFeedItem({
            key: typeof key === 'string' ? key : null,
            kind,
            feedItemId: Number.isInteger(feedItemId) ? feedItemId : null,
            nodeId: Number.isInteger(nodeId) ? nodeId : null,
            result: result && typeof result === 'object' ? result : null,
            attemptId,
        });
        // Fresh counters so the client header ticks without a full refetch.
        res.json({ ok: true, ...(outcome?.duplicate ? { duplicate: true } : {}), stats: buildFeedHeader().stats });
        feedGen.ensureBuffer();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export const feedRoutes = app.takeRoutes();

// Overwrite a cached lesson's markdown. Used when a visual block inside a feed
// lesson is repaired, so the fix is persisted exactly like the chat equivalent
// (PUT /api/ai/chat/message/:id). Without this the lesson row keeps the broken
// spec and EVERY page load re-runs the AI repair from scratch — an LLM call per
// reload, and a spinner where the diagram should be.
// Persist a repaired visual spec into the cached card it was read in, for EVERY
// kind of feed card — the lesson, and the question and practice cards whose
// stems and briefs carry visuals too. The
// client sends the two specs, never the whole card: the row is the source of
// truth, and for a JSON payload the client does not have its stored form.
app.put('/api/feed/items/:id', (req, res) => {
    try {
        const id = Number(req.params.id);
        const { original, repaired } = req.body || {};
        if (typeof original !== 'string' || !original.trim() || typeof repaired !== 'string' || !repaired.trim()) {
            return res.status(400).json({ error: 'original and repaired (non-empty strings) required' });
        }
        const row = db.prepare('SELECT content FROM feed_items WHERE id = ?').get(id);
        if (!row) return res.status(404).json({ error: 'Feed item not found' });
        const content = replaceSpecInContent(row.content, original, repaired);
        // Not an error: the card may have been regenerated since it was read.
        // The on-screen render is already fixed either way.
        if (content == null) return res.json({ success: true, replaced: false });
        db.prepare('UPDATE feed_items SET content = ? WHERE id = ?').run(content, id);
        res.json({ success: true, replaced: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export const feedItemRoutes = app.takeRoutes();
