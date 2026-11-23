// server/liveMedia.js — which card and question pictures and clips are in use.
//
// A `media_files` row names a file that a course's cards or question banks
// show (`flashcards.media`, `quizzes.questions[].media`, each entry carrying the
// file's `hash`). When those cards and banks are deleted (on their own, or with
// their topic or course) the row stays, so Restore has the file to show again.
// Until then the file is not live content: it is not listed, described by a
// model, served or exported. A row is in use while a live card or a live bank
// of its own course names its hash.

import db from './database.js';

/**
 * A CTE, `media_in_use(project_id, hash)`: every file a live card or a live
 * question bank names, with its course. Put it after `WITH` and ask
 * `(project_id, hash) IN (SELECT project_id, hash FROM media_in_use)`.
 * A value that is not JSON names nothing.
 */
export const MEDIA_IN_USE = `media_in_use(project_id, hash) AS (
    SELECT n.project_id, json_extract(m.value, '$.hash')
    FROM live_flashcards f JOIN live_nodes n ON n.id = f.node_id,
         json_each(CASE WHEN json_valid(f.media) THEN f.media END, '$.front') m
    WHERE f.media IS NOT NULL AND m.type = 'object'
    UNION
    SELECT n.project_id, json_extract(m.value, '$.hash')
    FROM live_flashcards f JOIN live_nodes n ON n.id = f.node_id,
         json_each(CASE WHEN json_valid(f.media) THEN f.media END, '$.back') m
    WHERE f.media IS NOT NULL AND m.type = 'object'
    UNION
    SELECT n.project_id, json_extract(m.value, '$.hash')
    FROM live_quizzes q JOIN live_nodes n ON n.id = q.node_id,
         json_each(CASE WHEN json_valid(q.questions) THEN q.questions END) qq,
         json_each(CASE WHEN qq.type = 'object' THEN qq.value END, '$.media') m
    WHERE q.questions LIKE '%"media"%' AND m.type = 'object'
)`;

// One file: a hash is 64 hex characters, so finding it in a row's text is
// finding the row that names it. Cards first, whose media text is short; the
// question banks' larger text is read only for a file no live card names.
let inUseStmt = null;
/**
 * The `media_files` row of a file in use: the one of `projectId` when that
 * course uses it, else the first, as the description list and sweep pick.
 * Null when no live card or question bank of a course holding it names it.
 */
export function inUseMediaRow(hash, projectId = null) {
    inUseStmt ??= db.prepare(`
        SELECT mf.hash, mf.kind, mf.mime, mf.filename, mf.description, mf.described_by FROM media_files mf
        WHERE mf.hash = ? AND (
            EXISTS (SELECT 1 FROM live_nodes n JOIN live_flashcards f ON f.node_id = n.id
                    WHERE n.project_id = mf.project_id AND f.media IS NOT NULL AND instr(f.media, mf.hash) > 0)
            OR EXISTS (SELECT 1 FROM live_nodes n JOIN live_quizzes q ON q.node_id = n.id
                    WHERE n.project_id = mf.project_id AND instr(q.questions, mf.hash) > 0))
        ORDER BY mf.project_id IS ? DESC, mf.id
        LIMIT 1
    `);
    return inUseStmt.get(String(hash ?? ''), projectId ?? -1) ?? null;
}

/** Whether a live card or question bank of a course holding this file names it. */
export const mediaInUse = (hash) => !!inUseMediaRow(hash);
