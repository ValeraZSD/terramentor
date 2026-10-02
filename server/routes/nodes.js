// /api/nodes and /api/resources: the curriculum tree and a topic's saved links.
//
// Mounted in 2 blocks (see createApp in server/app.js), because the server
// registers other areas' routes between them and Express matches in registration
// order. A new route goes in the block it belongs with.
import db from '../database.js';
import { aiProvenance } from '../ai.js';
import { checkMasteryEligibility } from '../mastery.js';
import { COMPLETED_AT_ON_COMPLETE, LEAF_NODE, nodeLabels } from '../today.js';
import { getProjectLanguage } from '../language.js';
import { scheduleNodeSync } from '../nodeEmbeddings.js';
import { sanitizeResourceType, VALID_NODE_STATUSES } from '../curriculumSchema.js';
import { sanitizeUrl } from '../urlSafety.js';
import { TAUGHT_SQL } from '../progress.js';
import { getGateConfig } from '../settingsStore.js';
import { documentChunkIds, freeDocumentAssets } from '../documentAssets.js';
import { findResourcesForSubElement } from '../resourceSearch.js';
import { routeTable } from './routeTable.js';

const app = routeTable('nodes');

// NODES

// Query params are an API contract: an unrecognised one means the caller
// believes it asked for something we never did. Answering 200 with unfiltered
// rows reads as a successful filter and silently corrupts whatever the caller
// computes next, so reject instead of ignoring.
const NODES_QUERY_PARAMS = ['status', 'leavesOnly'];

app.get('/api/projects/:projectId/nodes', (req, res) => {
    const unknown = Object.keys(req.query).filter(k => !NODES_QUERY_PARAMS.includes(k));
    if (unknown.length > 0) {
        return res.status(400).json({
            error: `Unknown query parameter(s): ${unknown.join(', ')}`,
            supported: NODES_QUERY_PARAMS,
        });
    }

    const { status, leavesOnly } = req.query;
    if (status !== undefined && !VALID_NODE_STATUSES.includes(status)) {
        return res.status(400).json({
            error: `Invalid status "${status}"`,
            valid: VALID_NODE_STATUSES,
        });
    }

    const filters = ['n.project_id = ?'];
    const values = [req.params.projectId];
    if (status !== undefined) {
        filters.push('n.status = ?');
        values.push(status);
    }
    // Opt-in leaf scope: the unit of work the progress counts are based on.
    // Lets a caller reproduce node_count/completed_count without rebuilding
    // the tree client-side to find out which rows are section headers.
    if (leavesOnly === 'true') filters.push(LEAF_NODE);

    // The card counts ride along so the tree's own rollup can use the same
    // progress rule the server does (`topicFraction`, server/progress.js) —
    // without them the workspace bars would still be counting ticks while the
    // project card counts cards, which is exactly the two-numbers-for-one-thing
    // this app keeps having to fix. Aggregated once, not per row: a correlated
    // subquery here runs a thousand times on the big projects.
    const nodes = db.prepare(`
        SELECT n.id, n.uuid, n.project_id, n.parent_id, n.title, n.description, n.notes, n.status,
               n.is_note, n.role, n.position, n.scheduled_start, n.scheduled_end, n.estimated_weight,
               n.completed_at, n.created_at, n.updated_at,
               COALESCE(fc.cards, 0) AS cards, COALESCE(fc.seen, 0) AS seen,
               ${TAUGHT_SQL} AS taught
        FROM nodes n
        LEFT JOIN (
            SELECT f.node_id,
                   COUNT(*) AS cards,
                   SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL THEN 1 ELSE 0 END) AS seen
            FROM flashcards f GROUP BY f.node_id
        ) fc ON fc.node_id = n.id
        WHERE ${filters.join(' AND ')} ORDER BY n.position
    `).all(...values);
    res.json(nodes);
});

// Hoisted: a reorder carries a whole sibling list, so preparing inside the loop
// re-compiles the same statement once per node on every drag.
const nodeProjectStmt = db.prepare('SELECT id, project_id FROM nodes WHERE id = ?');
const nodeRepositionStmt = db.prepare('UPDATE nodes SET position = ?, parent_id = ? WHERE id = ?');

app.put('/api/nodes/reorder', (req, res) => {
    const { nodeIds, parentId } = req.body;
    if (!Array.isArray(nodeIds)) return res.status(400).json({ error: 'nodeIds must be an array' });

    // This path re-parents too, so it owes the same guard as /move and /:id:
    // a cycle in parent_id makes buildTree drop the loop from every view and
    // never terminates the recursive CTE in DELETE /api/nodes/:id. It had none.
    const rows = nodeIds.map(id => nodeProjectStmt.get(id));
    for (let i = 0; i < nodeIds.length; i++) {
        if (!rows[i]) return res.status(400).json({ error: 'Node not found' });
        if (rows[i].project_id !== rows[0].project_id) {
            return res.status(400).json({ error: 'A node cannot be moved into another project' });
        }
        const bad = reparentError(nodeIds[i], parentId ?? null);
        if (bad) return res.status(400).json({ error: bad });
    }
    // reparentError only checks the parent against the node it is given, so a
    // null parentId (a move to the root) still needs the batch pinned to one
    // project — otherwise a mixed batch silently adopts rows from elsewhere.
    if (parentId != null) {
        const parent = nodeProjectStmt.get(parentId);
        if (!parent) return res.status(400).json({ error: 'Parent node not found' });
        if (rows.length && parent.project_id !== rows[0].project_id) {
            return res.status(400).json({ error: 'A node cannot be moved into another project' });
        }
    }

    const transaction = db.transaction(() => {
        nodeIds.forEach((id, index) => {
            nodeRepositionStmt.run(index, parentId, id);
        });
    });
    transaction();
    if (nodeIds.length > 0) {
        const node = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeIds[0]);
        if (node) {
            const nodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY position').all(node.project_id);
            return res.json({ success: true, nodes });
        }
    }
    res.json({ success: true });
});

// Where a NEW node may hang: an existing project, and either the root or a
// node that already exists in that same project. The foreign key alone checks
// neither the project nor that the parent is a different row — a parent from
// another project was accepted (deleting it then cascaded into this one), and
// so was the id the insert itself was about to take, a node that is its own
// parent. Every route that creates a node under a caller-named parent asks
// this; the other writers derive their parent from rows they just read.
// Returns `{ status, error }` or null.
function newNodePlacementError(projectId, parentId) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return { status: 404, error: 'Project not found' };
    if (parentId == null) return null;
    const parent = db.prepare('SELECT id, project_id FROM nodes WHERE id = ?').get(parentId);
    if (!parent) return { status: 400, error: 'Parent node not found' };
    if (parent.project_id !== project.id) return { status: 400, error: 'The parent node belongs to another project' };
    return null;
}

app.post('/api/nodes', (req, res) => {
    const { project_id, parent_id, title, description, notes, status, is_note } = req.body;
    if (status !== undefined && !VALID_NODE_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status "${status}".` });
    }
    const bad = newNodePlacementError(project_id, parent_id || null);
    if (bad) return res.status(bad.status).json({ error: bad.error });
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM nodes WHERE project_id = ? AND parent_id IS ?')
        .get(project_id, parent_id || null);
    const result = db.prepare(`
        INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project_id, parent_id || null, title, description || '', notes || '', status || 'not_started', is_note || 0, maxPos.pos);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(result.lastInsertRowid);
    scheduleNodeSync();
    res.json(node);
});

app.put('/api/nodes/:id', (req, res) => {
    const { title, description, notes, status, position, parent_id, is_note, estimated_weight, chat_draft } = req.body;
    const setClauses = [];
    const values = [];

    if (title !== undefined) { setClauses.push('title = ?'); values.push(title); }
    if (description !== undefined) { setClauses.push('description = ?'); values.push(description); }
    if (notes !== undefined) { setClauses.push('notes = ?'); values.push(notes); }
    if (status !== undefined) {
        if (!VALID_NODE_STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status "${status}".` });
        }

        const nodeId = Number(req.params.id);
        // `override` lets the learner consciously mark a topic done without
        // proving mastery (the "mark done anyway" path). 'skipped' never gates.
        const override = req.body.override === true;
        const gate = getGateConfig();

        // Mastery gate for completing a LEAF. Skipped/off/override bypass it.
        // In 'advisory' mode we still return the gate response (so the UI can
        // offer a mastery check) but flag it advisory — the learner can override.
        if (status === 'completed' && !override && gate.mode !== 'off') {
            const childCount = db.prepare(
                'SELECT COUNT(*) as c FROM nodes WHERE parent_id = ? AND is_note = 0'
            ).get(nodeId);

            if (childCount.c === 0) {
                const eligibility = checkMasteryEligibility(nodeId, gate.threshold, gate.checkPass);
                if (!eligibility.eligible) {
                    return res.status(400).json({
                        error: eligibility.has_evidence
                            ? `Not proven yet — best mastery ${(eligibility.mastery_score * 100).toFixed(0)}% (need ${(eligibility.threshold * 100).toFixed(0)}%, or pass a mastery check).`
                            : `Not proven yet. Take a quiz or mastery check to verify mastery${gate.mode === 'advisory' ? ', or mark it done anyway.' : '.'}`,
                        mastery_gate: true,
                        advisory: gate.mode === 'advisory',
                        mastery_score: eligibility.mastery_score,
                        threshold: eligibility.threshold,
                        evidence_count: eligibility.evidence_count,
                    });
                }
            }
        }

        setClauses.push('status = ?');
        values.push(status);
        // Only a verified 'completed' stamps completed_at, and an already
        // completed node keeps its date (COMPLETED_AT_ON_COMPLETE); skipped is
        // explicitly null.
        setClauses.push(status === 'completed' ? `completed_at = ${COMPLETED_AT_ON_COMPLETE}` : 'completed_at = ?');
        values.push(status === 'completed' ? new Date().toISOString() : null);
    }
    if (position !== undefined) { setClauses.push('position = ?'); values.push(position); }
    if (parent_id !== undefined) {
        const bad = reparentError(Number(req.params.id), parent_id);
        if (bad) return res.status(400).json({ error: bad });
        setClauses.push('parent_id = ?'); values.push(parent_id);
    }
    if (is_note !== undefined) { setClauses.push('is_note = ?'); values.push(is_note); }
    if (estimated_weight !== undefined) { setClauses.push('estimated_weight = ?'); values.push(estimated_weight); }
    if (chat_draft !== undefined) { setClauses.push('chat_draft = ?'); values.push(chat_draft); }

    if (setClauses.length === 0) {
        const existing = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
        return res.json(existing);
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);

    db.prepare(`UPDATE nodes SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
    // Only the fields that make up a topic's embedded text are worth a sweep —
    // `parent_id` counts because the parent's title is part of it. A status
    // change is deliberately excluded: the feed writes those constantly and
    // none of them can move a topic in the semantic space.
    if (title !== undefined || description !== undefined || is_note !== undefined || parent_id !== undefined) {
        scheduleNodeSync();
    }
    res.json(node);
});

app.delete('/api/nodes/:id', (req, res) => {
    // nodes.parent_id cascades recursively, so this can take an entire subtree
    // with it — collect every descendant's documents (vec_chunks/vault blobs
    // aren't covered by FK cascade) before deleting.
    const docs = db.prepare(`
        WITH RECURSIVE descendants(id) AS (
            SELECT id FROM nodes WHERE id = ?
            UNION ALL
            SELECT n.id FROM nodes n JOIN descendants d ON n.parent_id = d.id
        )
        SELECT doc.id, doc.file_hash FROM documents doc WHERE doc.node_id IN (SELECT id FROM descendants)
    `).all(req.params.id);
    const chunkIds = documentChunkIds(docs);

    db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);

    freeDocumentAssets(docs, chunkIds);
    scheduleNodeSync();   // vec_nodes has no FK — the sweep drops the orphans
    res.json({ success: true });
});

// A node may be re-parented only within its own project, and never under
// itself or one of its descendants. The client (`isDescendantTarget` in the
// sidebar) already refuses such drops, but the API is the boundary that has to:
// a cycle in `parent_id` makes `buildTree` silently drop the loop from every
// view, and the `UNION ALL` recursive CTE in DELETE /api/nodes/:id never
// terminates — a hung server from one bad request. Returns an error string or
// null. A visited set guards the walk against a cycle that already exists.
function reparentError(nodeId, parentId) {
    if (parentId == null) return null;
    const child = db.prepare('SELECT id, project_id FROM nodes WHERE id = ?').get(nodeId);
    const parent = db.prepare('SELECT id, project_id, parent_id FROM nodes WHERE id = ?').get(parentId);
    if (!child) return 'Node not found';
    if (!parent) return 'Parent node not found';
    if (parent.project_id !== child.project_id) return 'A node cannot be moved into another project';
    if (parent.id === child.id) return 'A node cannot be its own parent';
    const seen = new Set([parent.id]);
    let cur = parent;
    while (cur && cur.parent_id != null) {
        if (cur.parent_id === child.id) return 'A node cannot be moved under one of its own descendants';
        if (seen.has(cur.parent_id)) break;
        seen.add(cur.parent_id);
        cur = db.prepare('SELECT id, parent_id FROM nodes WHERE id = ?').get(cur.parent_id);
    }
    return null;
}

app.put('/api/nodes/:id/move', (req, res) => {
    const { parent_id, position } = req.body;
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const bad = reparentError(node.id, parent_id);
    if (bad) return res.status(400).json({ error: bad });
    const siblings = db.prepare(`
        SELECT * FROM nodes
        WHERE project_id = ? AND parent_id IS ? AND id != ?
        ORDER BY position
    `).all(node.project_id, parent_id, req.params.id);
    const transaction = db.transaction(() => {
        db.prepare('UPDATE nodes SET parent_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(parent_id, req.params.id);
        siblings.splice(position, 0, { id: node.id });
        siblings.forEach((s, idx) => {
            db.prepare('UPDATE nodes SET position = ? WHERE id = ?').run(idx, s.id);
        });
    });
    transaction();
    const nodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY position').all(node.project_id);
    res.json(nodes);
});

// RESOURCES

app.get('/api/nodes/:nodeId/resources', (req, res) => {
    const resources = db.prepare('SELECT * FROM resources WHERE node_id = ? ORDER BY position').all(req.params.nodeId);
    res.json(resources);
});

// Registered BEFORE the parameterized routes below: Express matches in
// registration order, so '/api/resources/reorder' after '/api/resources/:id'
// would be captured by the :id route (id="reorder") and always fail.
app.put('/api/resources/reorder', (req, res) => {
    const { resourceIds } = req.body;
    const transaction = db.transaction(() => {
        resourceIds.forEach((id, index) => {
            db.prepare('UPDATE resources SET position = ? WHERE id = ?').run(index, id);
        });
    });
    transaction();
    res.json({ success: true });
});

app.post('/api/resources', (req, res) => {
    const { node_id, title, url, type } = req.body;
    // A resource URL is rendered as an href, so the scheme is checked at every
    // write path, not just on import (see server/urlSafety.js).
    const checked = sanitizeUrl(url);
    if (!checked.ok) return res.status(400).json({ error: `Invalid URL: ${checked.reason}` });
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM resources WHERE node_id = ?').get(node_id);
    const result = db.prepare('INSERT INTO resources (node_id, title, url, type, position) VALUES (?, ?, ?, ?, ?)')
        .run(node_id, title, checked.url, sanitizeResourceType(type), maxPos.pos);
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(result.lastInsertRowid);
    res.json(resource);
});

app.put('/api/resources/:id', (req, res) => {
    const { title, url, type, completed } = req.body;
    // COALESCE means undefined leaves the stored URL alone; only a supplied one
    // is checked (and normalized — "example.com/x" becomes an https URL).
    let nextUrl = url;
    if (url !== undefined && url !== null) {
        const checked = sanitizeUrl(url);
        if (!checked.ok) return res.status(400).json({ error: `Invalid URL: ${checked.reason}` });
        nextUrl = checked.url;
    }
    // Same vocabulary gate the POST applies — the PUT wrote `type` straight
    // through. Only when one is supplied: sanitizeResourceType(undefined) is
    // 'article', which under COALESCE would rewrite the stored type on a
    // title-only edit.
    const nextType = type === undefined || type === null ? type : sanitizeResourceType(type);
    db.prepare('UPDATE resources SET title = COALESCE(?, title), url = COALESCE(?, url), type = COALESCE(?, type), completed = COALESCE(?, completed) WHERE id = ?')
        .run(title, nextUrl, nextType, completed, req.params.id);
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id);
    res.json(resource);
});

app.delete('/api/resources/:id', (req, res) => {
    db.prepare('DELETE FROM resources WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

export const nodeRoutes = app.takeRoutes();

// Resolve node ids → real titles, for the global planner's `[[open:…]]`
// markers. The model proposes an id; this decides whether it exists and what it
// is actually called, so the app never renders a topic name the model invented.
//
// It also says what the id IS (`nodeLabels`, today.js), because the
// assistant's prepared writes depend on it.
app.post('/api/nodes/labels', (req, res) => {
    res.json(nodeLabels(req.body?.ids));
});

// Curate resources for ONE topic, on demand.
//
// The counterpart to `creation_find_resources`: with per-leaf curation off at
// creation time (the pipeline's most expensive phase), this is how a topic gets
// its links — when the learner actually opens it, not for all 700 leaves up
// front. Also useful with curation ON, to top up a topic whose search came back
// thin. Appends; never removes what is already there.
app.post('/api/ai/nodes/:id/find-resources', async (req, res) => {
    const nodeId = Number(req.params.id);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const project = db.prepare('SELECT name, summary FROM projects WHERE id = ?').get(node.project_id);

    // Walk up for the phase/topic titles the curator uses to disambiguate a
    // generic leaf title ("Basics" means nothing without its ancestors).
    const ancestors = [];
    let cursor = node.parent_id;
    for (let depth = 0; cursor && depth < 10; depth++) {
        const parent = db.prepare('SELECT id, parent_id, title FROM nodes WHERE id = ?').get(cursor);
        if (!parent) break;
        ancestors.unshift(parent.title);
        cursor = parent.parent_id;
    }

    try {
        const found = await findResourcesForSubElement(
            project?.name || '', ancestors[0] || '', ancestors[ancestors.length - 1] || '',
            node.title, node.description || '', undefined, project?.summary || '',
            getProjectLanguage(node.project_id)
        );
        const existing = new Set(
            db.prepare('SELECT url FROM resources WHERE node_id = ?').all(nodeId).map(r => r.url)
        );
        const fresh = found.filter(r => r.url && !existing.has(r.url));

        let maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM resources WHERE node_id = ?').get(nodeId).pos;
        const insert = db.prepare('INSERT INTO resources (node_id, title, url, type, completed, position, generated_by) VALUES (?, ?, ?, ?, 0, ?, ?)');
        const provenance = aiProvenance();
        db.transaction(() => {
            for (const r of fresh) insert.run(nodeId, r.title, r.url, r.type, maxPos++, provenance);
        })();

        res.json({
            added: fresh.length,
            resources: db.prepare('SELECT * FROM resources WHERE node_id = ? ORDER BY position').all(nodeId),
        });
    } catch (error) {
        console.error('[Resources] On-demand curation failed:', error);
        res.status(500).json({ error: error.message });
    }
});

export const labelRoutes = app.takeRoutes();
