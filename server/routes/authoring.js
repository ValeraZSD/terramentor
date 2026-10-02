// /api/authoring: the two-pass external authoring briefs and the material merge.
import db from '../database.js';
import { WORK_LEAF } from '../today.js';
import { scheduleNodeSync } from '../nodeEmbeddings.js';
import {
    ImportError, leafHasMaterial, matchMaterialToLeaves, MATERIAL_MIN_CHARS,
    normalizeMaterialPayload,
} from '../curriculumSchema.js';
import { buildMaterialBrief, buildOutlineBrief } from '../authoringBrief.js';
import { routeTable } from './routeTable.js';

const app = routeTable('authoring');

// --- Authoring with an external model ------------------------------------
//
// Two prompts and one merge. The reasoning for the split is in
// `authoringBrief.js`; what matters here is that pass two lands on a project
// that already exists, which `POST /api/import` deliberately never does.
//
// Nothing on these routes calls a model. The learner runs the prompt in
// whatever chat they already pay for (or don't) and brings the reply back — so
// the privacy cost is paid in that chat, and the app stays local.

/** The outline prompt, with the learner's brief filled in. */
app.post('/api/authoring/outline-brief', (req, res) => {
    res.json({ prompt: buildOutlineBrief(req.body || {}) });
});

/**
 * A project's phases, with the leaf count and how much of each is already
 * written. This is what makes "deepen phase 3 next month" answerable without
 * the learner keeping track themselves.
 */
app.get('/api/projects/:projectId/authoring/phases', (req, res) => {
    const projectId = Number(req.params.projectId);
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const phases = db.prepare(`
        SELECT id, title FROM nodes
        WHERE project_id = ? AND parent_id IS NULL AND is_note = 0
        ORDER BY position, id
    `).all(projectId);

    // A phase's leaves are the leaves of its whole subtree, so the recursion
    // has to run per phase rather than one level down.
    const subtree = db.prepare(`
        WITH RECURSIVE sub(id) AS (
            SELECT ? UNION ALL
            SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
        )
        SELECT n.id, n.title,
               EXISTS(SELECT 1 FROM nodes m WHERE m.parent_id = n.id AND m.is_note = 1) AS hasNotes,
               length(COALESCE(n.description, '')) AS descriptionLength
        FROM nodes n WHERE n.id IN (SELECT id FROM sub) AND ${WORK_LEAF}
        ORDER BY n.position, n.id
    `);

    res.json({
        project,
        phases: phases.map(phase => {
            const leaves = subtree.all(phase.id);
            return {
                id: phase.id,
                title: phase.title,
                leaves: leaves.length,
                withMaterial: leaves.filter(l => leafHasMaterial(l)).length,
            };
        }),
    });
});

/** The material prompt for one phase, carrying that phase's exact leaf titles. */
app.get('/api/projects/:projectId/authoring/material-brief', (req, res) => {
    const projectId = Number(req.params.projectId);
    const project = db.prepare('SELECT id, name, description, content_language FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const phaseId = Number(req.query.phaseId);
    const phase = phaseId
        ? db.prepare('SELECT id, title FROM nodes WHERE id = ? AND project_id = ?').get(phaseId, projectId)
        : null;
    if (phaseId && !phase) return res.status(404).json({ error: 'Phase not found in this project' });

    // "Unwritten" = no attached reading AND an Overview still the length of a
    // signpost (MATERIAL_MIN_CHARS): pass two writes into the Overview.
    const rows = phase
        ? db.prepare(`
            WITH RECURSIVE sub(id) AS (
                SELECT ? UNION ALL
                SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
            )
            SELECT n.id, n.title FROM nodes n
            WHERE n.id IN (SELECT id FROM sub) AND ${WORK_LEAF}
              AND NOT EXISTS(SELECT 1 FROM nodes m WHERE m.parent_id = n.id AND m.is_note = 1)
              AND length(COALESCE(n.description, '')) < ${MATERIAL_MIN_CHARS}
            ORDER BY n.position, n.id
        `).all(phase.id)
        : db.prepare(`
            SELECT n.id, n.title FROM nodes n
            WHERE n.project_id = ? AND ${WORK_LEAF}
              AND NOT EXISTS(SELECT 1 FROM nodes m WHERE m.parent_id = n.id AND m.is_note = 1)
              AND length(COALESCE(n.description, '')) < ${MATERIAL_MIN_CHARS}
            ORDER BY n.position, n.id
        `).all(projectId);

    res.json({
        prompt: buildMaterialBrief({
            project,
            phaseTitle: phase ? phase.title : '',
            leaves: rows.map(r => r.title),
        }),
        phase: phase || null,
        leaves: rows.length,
    });
});

/**
 * Merge one pass-two reply into the project.
 *
 * Writes each matched leaf's reading into its Overview (`overview`) and, for
 * the rare separable extra, adds `is_note` children (`material`). Nothing
 * else changes — no renames, no reordering, no scheduling, no status. A topic
 * that already has material (an attached reading, or an Overview past
 * MATERIAL_MIN_CHARS) is REPORTED and skipped unless `replace` is set: this
 * endpoint is meant to be run several times against the same project, so the
 * safe outcome for a repeated file is that it does nothing twice.
 */
app.post('/api/projects/:projectId/authoring/material', (req, res) => {
    const projectId = Number(req.params.projectId);
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let payload;
    try {
        payload = normalizeMaterialPayload(req.body);
    } catch (err) {
        if (err instanceof ImportError) return res.status(400).json({ error: err.message });
        throw err;
    }

    const courseLeaves = db.prepare(`
        SELECT n.id, n.title,
               EXISTS(SELECT 1 FROM nodes m WHERE m.parent_id = n.id AND m.is_note = 1) AS hasNotes,
               length(COALESCE(n.description, '')) AS descriptionLength
        FROM nodes n WHERE n.project_id = ? AND ${WORK_LEAF}
        ORDER BY n.position, n.id
    `).all(projectId).map(r => ({ id: r.id, title: r.title, hasMaterial: leafHasMaterial(r) }));

    const replace = req.body?.replace === true;
    const { matches, unmatched } = matchMaterialToLeaves(payload.leaves, courseLeaves, { replace });

    if (!matches.length) {
        return res.status(400).json({
            error: 'None of the topics in this file matched a topic in this project.',
            unmatched,
            warnings: payload.warnings,
        });
    }

    const insertNode = db.prepare(`
        INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
        VALUES (?, ?, ?, ?, '', 'not_started', 1, ?)
    `);
    const dropMaterial = db.prepare('DELETE FROM nodes WHERE parent_id = ? AND is_note = 1');
    const writeOverview = db.prepare('UPDATE nodes SET description = ? WHERE id = ?');
    const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM nodes WHERE parent_id = ?');

    let added = 0;
    const transaction = db.transaction(() => {
        for (const match of matches) {
            if (replace && match.replacing) dropMaterial.run(match.nodeId);
            if (match.overview) {
                writeOverview.run(match.overview, match.nodeId);
                added++;
            }
            let position = nextPosition.get(match.nodeId).pos;
            for (const item of match.material) {
                insertNode.run(projectId, match.nodeId, item.title, item.description, position++);
                added++;
            }
        }
    });
    transaction();

    // A note is material, not structure, so no leaf became a non-leaf and no
    // count moved — but the topic space keys on description text, and these
    // nodes are new rows.
    scheduleNodeSync();

    res.json({
        added,
        topics: matches.map(m => ({ title: m.title, overview: !!m.overview, readings: m.material.length, replaced: m.replacing })),
        unmatched,
        warnings: payload.warnings,
    });
});

export const routes = app.takeRoutes();
