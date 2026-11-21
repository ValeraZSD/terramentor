// server/softDelete.js — deleting a course, topic, card, question bank or link.
//
// A delete marks the row instead of removing it: `deleted_at` says when,
// `deleted_by` says why (database.js, the soft-delete migration). The row keeps
// its uuid, so another copy of the library can learn of the delete, and its
// history (reviews, answers, evidence) keeps its parent, so Restore brings the
// topic back with everything that was studied in it.
//
// Every read in the app goes through the `live_<table>` views, which skip
// deleted rows. This module is the one place that reads deleted rows and the
// one place that removes a row for good (Delete forever, Empty), and
// tools/soft-delete-gates.mjs holds both rules for every other module.
//
// A delete reaches down, never up: a course takes its topics, a topic its
// subtopics, and both the cards, question banks and links under them. Each row
// taken along is marked with the row that took it ('nodes:<uuid>'), so Restore
// brings back exactly those, and never a row the learner had deleted on its own
// before (that one keeps its own mark and its own place in Recently deleted).

import db, { NOW_ISO } from './database.js';
import { CONTENT_TABLES } from './syncTables.js';
import { PROJECT_SETTING_PREFIXES } from './settingsSchema.js';
import { clearProjectSetting } from './projectSettings.js';
import { documentChunkIds, freeDocumentAssets } from './documentAssets.js';
import { sweepOrphanMedia } from './ankiImport.js';

export { CONTENT_TABLES };

/** `deleted_by` of a row the app replaced or withdrew (never offered for Restore). */
export const BY_APP = 'app';

/** The column a learner knows each kind of row by. */
const TITLE = { projects: 'name', nodes: 'title', resources: 'title', flashcards: 'front', quizzes: 'title' };

const isContentTable = (t) => CONTENT_TABLES.includes(t);
const now = () => db.prepare(`SELECT ${NOW_ISO}`).pluck().get();
const rowOf = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
const markOf = (table, row) => `${table}:${row.uuid}`;

// The rows a deleted row takes with it, as [table, WHERE clause over `?` = the
// row's id]. The CTE `sub` is the node and every node under it.
const SUBTREE = `WITH RECURSIVE sub(id) AS (
        SELECT id FROM nodes WHERE id = ?
        UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)`;
const TAKES = {
    projects: [
        ['nodes', 'project_id = ?'],
        ['resources', 'node_id IN (SELECT id FROM nodes WHERE project_id = ?)'],
        ['flashcards', 'node_id IN (SELECT id FROM nodes WHERE project_id = ?)'],
        ['quizzes', 'node_id IN (SELECT id FROM nodes WHERE project_id = ?)'],
    ],
    nodes: [
        ['nodes', `id IN (${SUBTREE} SELECT id FROM sub) AND id <> ?`],
        ['resources', `node_id IN (${SUBTREE} SELECT id FROM sub)`],
        ['flashcards', `node_id IN (${SUBTREE} SELECT id FROM sub)`],
        ['quizzes', `node_id IN (${SUBTREE} SELECT id FROM sub)`],
    ],
    resources: [], flashcards: [], quizzes: [],
};
const argsFor = (where, id) => Array((where.match(/\?/g) || []).length).fill(id);

/**
 * Delete one row and what it takes with it. `by` is null for the learner's own
 * delete (listed in Recently deleted) or BY_APP. Returns the number of rows
 * marked, 0 when the row is missing or already deleted.
 */
export function softDelete(table, id, { by = null } = {}) {
    if (!isContentTable(table)) throw new Error(`No soft delete for ${table}`);
    return db.transaction(() => {
        const row = rowOf(table, id);
        if (!row || row.deleted_at) return 0;
        const at = now();
        let marked = db.prepare(`UPDATE ${table} SET deleted_at = ?, deleted_by = ? WHERE id = ?`).run(at, by, id).changes;
        const mark = markOf(table, row);
        for (const [t, where] of TAKES[table]) {
            marked += db.prepare(`UPDATE ${t} SET deleted_at = ?, deleted_by = ? WHERE deleted_at IS NULL AND ${where}`)
                .run(at, mark, ...argsFor(where, id)).changes;
        }
        return marked;
    })();
}

/** The parent a row needs live before it can come back, as [table, id], or null. */
function parentOf(table, row) {
    if (table === 'nodes') return row.parent_id != null ? ['nodes', row.parent_id] : ['projects', row.project_id];
    if (table === 'projects') return null;
    return ['nodes', row.node_id];
}
const isLive = ([t, id]) => !!db.prepare(`SELECT 1 FROM ${t} WHERE id = ? AND deleted_at IS NULL`).get(id);

/**
 * Bring back a deleted row and exactly the rows it took with it.
 * `{ restored }` on success; `{ error: 'not_deleted' | 'parent_deleted' }` when
 * there is nothing to restore here. `app: true` also restores a row the app
 * withdrew (a report's undo); the learner's Restore never sees those.
 */
export function restore(table, id, { app = false } = {}) {
    if (!isContentTable(table)) throw new Error(`No soft delete for ${table}`);
    return db.transaction(() => {
        const row = rowOf(table, id);
        if (!row || !row.deleted_at) return { error: 'not_deleted' };
        if (row.deleted_by != null && !(app && row.deleted_by === BY_APP)) return { error: 'not_deleted' };
        const parent = parentOf(table, row);
        if (parent && !isLive(parent)) return { error: 'parent_deleted' };
        let restored = db.prepare(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).run(id).changes;
        const mark = markOf(table, row);
        for (const t of CONTENT_TABLES) {
            restored += db.prepare(`UPDATE ${t} SET deleted_at = NULL, deleted_by = NULL WHERE deleted_by = ? AND deleted_at IS NOT NULL`).run(mark).changes;
        }
        return { restored, row };
    })();
}

/**
 * Bring back rows that were live in a snapshot, whatever deleted them since: a
 * course update's undo puts back exactly the rows it recorded before the update
 * (server/courseUpdate.js). Returns the number of rows brought back.
 */
export function revive(table, ids) {
    if (!isContentTable(table)) throw new Error(`No soft delete for ${table}`);
    const back = db.prepare(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL`);
    let n = 0;
    for (const id of ids) n += back.run(id).changes;
    return n;
}

/** Whether a deleted row went because the app removed it or a row the app removed took it along. */
function deletedByApp(row) {
    for (let guard = 0; row?.deleted_at && guard < 64; guard++) {
        if (row.deleted_by === BY_APP) return true;
        const mark = /^(\w+):(.+)$/.exec(row.deleted_by || '');
        if (!mark || !isContentTable(mark[1])) return false;
        row = db.prepare(`SELECT deleted_at, deleted_by FROM ${mark[1]} WHERE uuid = ?`).get(mark[2]);
    }
    return false;
}

/**
 * Give a uuid back when a course file brings a row back that the app removed
 * (an update dropped it, or an undo took back the update that added it): the
 * deleted row goes for good, so the row written next keeps the file's
 * identity. A row the learner deleted keeps its uuid and its place in Recently
 * deleted.
 */
export function releaseUuid(table, uuid) {
    if (!isContentTable(table)) throw new Error(`No soft delete for ${table}`);
    if (!uuid) return;
    const row = db.prepare(`SELECT id, deleted_at, deleted_by FROM ${table} WHERE uuid = ?`).get(uuid);
    if (row && deletedByApp(row)) purge(table, row.id);
}

/**
 * Remove a deleted row for good, with every row under it (the foreign keys'
 * cascade: its topics, cards, banks, links and all their history), and the
 * files no row names any more. Only a deleted row: a live one is refused.
 */
export function purge(table, id) {
    if (!isContentTable(table)) throw new Error(`No soft delete for ${table}`);
    const row = rowOf(table, id);
    if (!row || !row.deleted_at) return { error: 'not_deleted' };
    // The files outlive their rows unless freed: captured before the delete,
    // freed after it, as every other document delete does (documentAssets.js).
    let docs = [];
    if (table === 'projects') {
        docs = db.prepare('SELECT id, file_hash FROM documents WHERE project_id = ? OR node_id IN (SELECT id FROM nodes WHERE project_id = ?)').all(id, id);
    } else if (table === 'nodes') {
        docs = db.prepare(`${SUBTREE} SELECT id, file_hash FROM documents WHERE node_id IN (SELECT id FROM sub)`).all(id);
    }
    const chunkIds = documentChunkIds(docs);
    const hadMedia = table === 'projects' && !!db.prepare('SELECT 1 FROM media_files WHERE project_id = ? LIMIT 1').get(id);
    db.transaction(() => {
        // Per-project dials live in `settings`, keyed by the project's uuid,
        // where no foreign key reaches them.
        if (table === 'projects') for (const prefix of PROJECT_SETTING_PREFIXES) clearProjectSetting(prefix, id);
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    })();
    freeDocumentAssets(docs, chunkIds);
    if (hadMedia) sweepOrphanMedia({ allowEmpty: true });
    return { purged: true, docs: docs.length, media: hadMedia };
}

/**
 * What the learner deleted and can bring back, newest first: rows they deleted
 * themselves whose parent is still there (a topic deleted on its own inside a
 * deleted course comes back to the list once the course does).
 */
export function listDeleted() {
    const out = [];
    // How many rows each mark took, over all five tables: one grouped read each.
    const tookBy = new Map();
    for (const t of CONTENT_TABLES) {
        for (const { mark, n } of db.prepare(`SELECT deleted_by AS mark, COUNT(*) AS n FROM ${t} WHERE deleted_at IS NOT NULL AND deleted_by IS NOT NULL GROUP BY deleted_by`).all()) {
            tookBy.set(mark, (tookBy.get(mark) ?? 0) + n);
        }
    }
    for (const table of CONTENT_TABLES) {
        const rows = db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_by IS NULL`).all();
        for (const row of rows) {
            const parent = parentOf(table, row);
            if (parent && !isLive(parent)) continue;
            const projectId = table === 'projects' ? row.id
                : table === 'nodes' ? row.project_id
                    : db.prepare('SELECT project_id FROM nodes WHERE id = ?').pluck().get(row.node_id);
            const took = tookBy.get(markOf(table, row)) ?? 0;
            out.push({
                table, id: row.id, uuid: row.uuid,
                // What the screen calls it: a deck is a project too, a note a node.
                kind: table === 'projects' ? (row.kind === 'deck' ? 'deck' : 'course')
                    : table === 'nodes' ? (row.is_note ? 'note' : 'topic')
                        : { resources: 'link', flashcards: 'card', quizzes: 'quiz' }[table],
                title: String(row[TITLE[table]] ?? '').slice(0, 200),
                deletedAt: row.deleted_at,
                projectId: table === 'projects' ? null : projectId,
                projectName: table === 'projects' ? null : db.prepare('SELECT name FROM projects WHERE id = ?').pluck().get(projectId) ?? null,
                took,
            });
        }
    }
    return out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)) || b.id - a.id);
}

/** Remove every deleted row for good. Returns how many deleted rows the learner saw go. */
export function emptyDeleted() {
    let n = 0;
    // Parents first: purging a course takes its deleted topics with it.
    for (const table of CONTENT_TABLES) {
        const ids = db.prepare(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL AND (deleted_by IS NULL OR deleted_by = ?)`).pluck().all(BY_APP);
        for (const id of ids) if (purge(table, id).purged) n++;
    }
    return n;
}

// ---- schedule events ----------------------------------------------------------

const SCHEDULE_FIELDS = ['next_review', 'last_reviewed', 'stability', 'stability_fast', 'fsrs_difficulty', 'state',
    'lapses', 'learning_steps', 'review_count', 'ease_factor', 'last_interval'];

/**
 * Record a change to a card's schedule that is not a review: 'park' (a report
 * takes the card out of its queue), 'unpark', 'set' (schedule fields written
 * with no rating), 'undo' (a rating taken back; `reviewUuid` names it).
 * `schedule` is the fields as written; only schedule fields are kept.
 */
export function logScheduleEvent(cardId, kind, { schedule = null, reviewUuid = null } = {}) {
    const fields = schedule
        ? Object.fromEntries(SCHEDULE_FIELDS.filter(k => schedule[k] !== undefined).map(k => [k, schedule[k]]))
        : null;
    db.prepare(`INSERT INTO schedule_events (card_id, kind, schedule, review_uuid, created_at) VALUES (?, ?, ?, ?, ${NOW_ISO})`)
        .run(cardId, kind, fields ? JSON.stringify(fields) : null, reviewUuid);
}

/** Whether `body` writes any schedule field. */
export const writesSchedule = (body) => SCHEDULE_FIELDS.some(k => body?.[k] !== undefined);
