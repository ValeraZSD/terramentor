// server/nodeRole.js — what a node IS, per node, instead of what its project was
// imported as.
//
// ## Why this replaced `projects.kind`
//
// `kind` was one enum answering four independent questions: does this have
// material to teach, is it scheduled, how is its card queue rationed, and is it
// a unit of meaning for the atlas. It was written in exactly one place (the
// Anki importer), settable nowhere else, and carried by neither the JSON export
// nor its importer — so a project's shape was decided by the door it came in
// through and could never change afterwards.
//
// What that cost, measured on a real library (2026-09-09): one import's 32
// named subdeck topics and another's 6 are a curriculum by any reading — the
// deck's author named them — and were permanently untaught, unprovable and
// absent from the atlas, while a third import's 30 "Stage N" slices, which
// genuinely are pagination, were treated identically.
//
// The importer already knows the difference and was throwing it away:
// `planStages` returns groups tagged `order` (it cut them out of card order) or
// `tag` (the deck's author named them), and a subdeck path is named by
// definition. So the answer to "is this a topic?" is written once, at the moment
// it is known, and everything else reads it.
//
// `kind` survives as PROVENANCE only — 'deck' means "arrived as an Anki import"
// — and is read here, for one purpose: the default answer to "may this
// project's topics be taught?". Nothing else in the app branches on it.

import db from './database.js';

export const ROLE_TOPIC = 'topic';
export const ROLE_PAGINATION = 'pagination';

/**
 * SQL predicate: is this node a topic — something that can be taught, proven,
 * embedded and drawn on the map? Expects the nodes table aliased as `n`.
 *
 * COALESCE, not `= 'topic'`, because a row written before the migration (or by
 * an INSERT that does not name the column) carries NULL, and a fragment that
 * silently drops every legacy node from every query is a worse failure than any
 * it prevents.
 */
export const TOPIC_NODE = `COALESCE(n.role, '${ROLE_TOPIC}') != '${ROLE_PAGINATION}'`;

/** The same rule over a row already in hand. */
export const isPagination = (row) => row?.role === ROLE_PAGINATION;

/**
 * The role for one group returned by `planStages`.
 *
 * `order` means this module invented the boundary out of the deck's card
 * sequence; anything else (a tag the author used, a subdeck they created) means
 * they named it themselves. Unknown shapes default to topic: being taught
 * something you did not need is recoverable, never being taught is not.
 */
export function roleForStage(stage) {
    return stage?.kind === 'order' ? ROLE_PAGINATION : ROLE_TOPIC;
}

// Exactly what `planStages` writes for an order-cut group (`Stage ${n}`) and
// nothing else. Deliberately strict: this rule runs over nodes a learner may
// have renamed, and "Stage lighting" or "stage 3" are not this generator's
// output. Anchored, so a title that merely starts that way is safe.
const CUT_STAGE_TITLE = /^Stage \d+$/;

/** The backfill rule for rows written before the column existed. */
export function roleForImportedTitle(title) {
    return CUT_STAGE_TITLE.test(String(title ?? '').trim()) ? ROLE_PAGINATION : ROLE_TOPIC;
}

/**
 * One-shot backfill: demote the stages the importer cut out of card order.
 *
 * Runs only over IMPORTED projects — a curriculum topic a learner happened to
 * call "Stage 1" is theirs and stays a topic — and only once, because a learner
 * may legitimately promote a stage afterwards and a migration that re-ran every
 * boot would quietly undo them.
 */
export function backfillNodeRoles({ force = false } = {}) {
    const done = db.prepare("SELECT value FROM settings WHERE key = 'node_roles_backfilled'").get();
    if (done && !force) return { updated: 0, skipped: true };

    const rows = db.prepare(`
        SELECT n.id, n.title
        FROM nodes n JOIN projects p ON p.id = n.project_id
        WHERE COALESCE(p.kind, 'curriculum') = 'deck'
          AND n.parent_id IS NOT NULL
          AND COALESCE(n.role, '${ROLE_TOPIC}') = '${ROLE_TOPIC}'
    `).all();

    const demote = db.prepare('UPDATE nodes SET role = ? WHERE id = ?');
    let updated = 0;
    const run = db.transaction(() => {
        for (const r of rows) {
            if (roleForImportedTitle(r.title) !== ROLE_PAGINATION) continue;
            demote.run(ROLE_PAGINATION, r.id);
            updated++;
        }
        db.prepare(`
            INSERT INTO settings (key, value) VALUES ('node_roles_backfilled', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(new Date().toISOString());
    });
    run();
    return { updated, skipped: false };
}

// ---- may this project's topics be taught? -----------------------------------

const teachKey = (projectId) => `teach_topics_${projectId}`;

/**
 * Whether the teaching machinery (lesson generation, checkpoints) may run on
 * this project's topics.
 *
 * Default off for an import, on for anything authored here. Not because an
 * imported topic is worth less, but because generation costs model calls the
 * learner did not ask for: somebody who imports a 5,000-card deck wants to
 * study cards tonight, and 32 background lesson plans is a surprise, not a
 * feature. The switch makes it their choice instead of the importer's.
 */
export function projectTeaches(projectId) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(teachKey(projectId));
    if (row?.value != null && row.value !== '') return !(row.value === '0' || row.value === 'false');
    const project = db.prepare('SELECT kind FROM projects WHERE id = ?').get(projectId);
    if (!project) return false;
    return (project.kind || 'curriculum') !== 'deck';
}

export function setProjectTeaches(projectId, on) {
    db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(teachKey(projectId), on ? '1' : '0');
    return !!on;
}

/** Both halves: a topic (not pagination) in a project that teaches. */
export function nodeIsTeachable(nodeId) {
    const row = db.prepare(
        'SELECT project_id, role, is_note FROM nodes WHERE id = ?'
    ).get(nodeId);
    if (!row || row.is_note) return false;
    if (isPagination(row)) return false;
    return projectTeaches(row.project_id);
}
