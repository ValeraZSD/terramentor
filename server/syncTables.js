// What every table in a library IS, for anything that will move rows between
// two copies of one library, and how a row is named so both copies agree.
//
// Integer primary keys stay the key inside one library: every join, foreign
// key and URL uses them. A row that may leave the library needs a name that
// means the same row everywhere: a `uuid` column, or a natural key that holds
// no integer id (`settings.key`, `search_providers.id`). This file declares, for
// every table, which kind of data it holds and which of the two it uses;
// tools/sync-identity-gates.mjs fails on a table it does not list, on a synced
// table without its uuid column, and on a row without a uuid.
//
// No database import: database.js reads this while it opens the library, and
// the gates read it without opening one.

import { createHash } from 'node:crypto';

/**
 * The kinds of data, and whether a later sync carries them.
 *   content   rows the learner (or the app for them) writes and edits
 *   history   a record of something that happened: answers, reviews, messages
 *   counter   per-device amounts whose total is the sum of every device's row
 *   settings  the preferences table; which rows travel is settingScope()'s answer
 *   config    which model or search service a job uses (never the credentials)
 *   derived   numbers recomputed from history on every device
 *   cache     work that can be done again (some of it costs model money)
 *   index     rebuilt from content on every device
 *   device    this computer's own state: sessions, logs, failures, drafts
 */
export const SYNCED_CLASSES = new Set(['content', 'history', 'counter', 'settings', 'config']);

// `derive`: how a row that existed before it had a uuid is named, so that two
// copies of one library name the same row the same way (see derivedUuid).
//   parents  [column, table] pairs: the parent row's uuid is an input, never its id
//   at       the column holding when the row was written (immutable)
//   kind     further columns that never change after insert
// Order matters: a table comes after every table its parents name, because a
// parent's uuid must exist before a child's can be derived from it.
const D = (parents, at, kind = []) => ({ parents, at, kind });

/** @type {Array<[string, { class: string, uuid?: boolean, natural?: string, derive?: ReturnType<typeof D>, legacy?: boolean }]>} */
const TABLE_LIST = [
    // ---- content -----------------------------------------------------------------
    // The first four were given uuids before this list existed (database.js);
    // their rows already carry the same uuid in every copy made since.
    ['projects', { class: 'content', uuid: true }],
    ['nodes', { class: 'content', uuid: true }],
    ['resources', { class: 'content', uuid: true }],
    ['flashcards', { class: 'content', uuid: true }],
    ['quizzes', { class: 'content', uuid: true, derive: D([['node_id', 'nodes']], 'created_at') }],
    ['documents', { class: 'content', uuid: true, derive: D([['node_id', 'nodes'], ['project_id', 'projects']], 'created_at', ['file_hash']) }],
    ['chat_conversations', { class: 'content', uuid: true, derive: D([['node_id', 'nodes']], 'created_at') }],
    ['media_files', { class: 'content', uuid: true, derive: D([['project_id', 'projects']], 'created_at', ['hash']) }],
    ['node_sources', { class: 'content', uuid: true, derive: D([['node_id', 'nodes'], ['document_id', 'documents']], null, ['page_from', 'page_to', 'char_from', 'char_to']) }],
    // A probe's questions and answers are rewritten while it runs (placement.js).
    ['placement_probes', { class: 'content', uuid: true, derive: D([['project_id', 'projects']], 'created_at') }],

    // ---- history ---------------------------------------------------------------------
    ['review_log', { class: 'history', uuid: true, derive: D([['card_id', 'flashcards']], 'reviewed_at', ['rating', 'source', 'external_id']) }],
    ['mastery_evidence', { class: 'history', uuid: true, derive: D([['node_id', 'nodes']], 'created_at', ['evidence_type']) }],
    ['quiz_attempts', { class: 'history', uuid: true, derive: D([['quiz_id', 'quizzes']], 'created_at') }],
    ['paper_attempts', { class: 'history', uuid: true, derive: D([['node_id', 'nodes']], 'created_at', ['mode']) }],
    ['question_log', { class: 'history', uuid: true, derive: D([['quiz_id', 'quizzes'], ['node_id', 'nodes']], 'asked_at', ['question_uuid', 'surface']) }],
    ['sitting_reviews', { class: 'history', uuid: true, derive: D([['evidence_id', 'mastery_evidence']], 'created_at') }],
    ['chat_messages', { class: 'history', uuid: true, derive: D([['conversation_id', 'chat_conversations'], ['node_id', 'nodes']], 'created_at', ['role']) }],
    ['chat_attachments', { class: 'history', uuid: true, derive: D([['message_id', 'chat_messages'], ['conversation_id', 'chat_conversations']], 'created_at', ['file_hash', 'name']) }],
    // `target_id` is an integer whose table depends on `kind`; the time, kind and
    // source name the edit, and the collision rule separates true twins.
    ['assistant_edits', { class: 'history', uuid: true, derive: D([], 'applied_at', ['kind', 'source']) }],
    ['item_reports', { class: 'history', uuid: true, derive: D([['node_id', 'nodes'], ['project_id', 'projects']], 'created_at', ['kind', 'reason']) }],
    ['mastery_claims', { class: 'history', uuid: true, derive: D([['node_id', 'nodes']], 'created_at', ['source']) }],
    ['answer_attempts', { class: 'history', uuid: true, derive: D([], 'created_at', ['surface', 'attempt_id']) }],

    // ---- counters ----------------------------------------------------------------------
    // Keyed by (topic, hour, activity, device): each device adds to its own row.
    ['study_time', { class: 'counter', uuid: true, derive: D([['node_id', 'nodes']], null, ['hour', 'activity', 'device']) }],

    // ---- settings and configuration -------------------------------------------------------
    // A setting is named by its key; two devices that set one key set the same
    // row, which a uuid per row would hide. Keys that named a project by its
    // integer id are re-keyed by its uuid (settingsSchema.js PROJECT_SETTING_PREFIXES).
    ['settings', { class: 'settings', natural: 'key' }],
    ['ai_connections', { class: 'config', uuid: true, derive: D([], 'created_at', ['kind']) }],
    ['ai_job_routes', { class: 'config', uuid: true, derive: D([], null, ['job', 'position']) }],
    // Named by the provider's own id ('wikipedia', or the id in an added manifest).
    ['search_providers', { class: 'config', natural: 'id' }],

    // ---- derived, caches, indexes ---------------------------------------------------------
    ['node_mastery', { class: 'derived' }],
    ['feed_items', { class: 'cache' }],
    ['visual_builds', { class: 'cache' }],
    ['widget_builds', { class: 'cache' }],
    ['region_names', { class: 'cache' }],
    ['assistant_checks', { class: 'cache' }],
    ['document_chunks', { class: 'index' }],
    ['node_embeddings', { class: 'index' }],
    ['documents_fts', { class: 'index' }],
    ['vec_chunks', { class: 'index' }],
    ['vec_nodes', { class: 'index' }],

    // ---- this computer only ---------------------------------------------------------------
    ['activity_log', { class: 'device' }],
    ['auth_devices', { class: 'device' }],
    ['auth_sessions', { class: 'device' }],
    ['staged_documents', { class: 'device' }],
    ['study_time_flushes', { class: 'device' }],
    ['visual_build_failures', { class: 'device' }],
    ['region_name_failures', { class: 'device' }],
    ['ai_job_fallbacks', { class: 'device' }],
    // Left behind in libraries made by older builds; nothing creates them now.
    ['generation_state', { class: 'device', legacy: true }],
    ['resource_cache', { class: 'device', legacy: true }],
];

export const SYNC_TABLES = Object.freeze(Object.fromEntries(TABLE_LIST));

/** Tables whose rows carry a `uuid` column, parents before children. */
export const UUID_TABLES = TABLE_LIST.filter(([, t]) => t.uuid).map(([name]) => name);

/** The four tables that had a uuid before the rest; their rows were never derived. */
export const FIRST_UUID_TABLES = ['projects', 'nodes', 'resources', 'flashcards'];

/** Whether rows of `table` may leave this library. Unknown tables never do. */
export const isSyncedTable = (table) => SYNCED_CLASSES.has(SYNC_TABLES[table]?.class);

/** What `study_time.device` holds for time measured here before devices had ids. */
export const LOCAL_DEVICE = 'local';

/**
 * A random RFC 4122 v4 uuid in plain SQL, evaluated per row. Plain SQL so the
 * trigger that uses it works for any build that opens the library, older ones
 * included, with no function the app must register first.
 */
export const UUID_SQL = `lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )`;

// Fixed for good: changing it renames every derived row in every library.
const NAMESPACE = Buffer.from('6f1c2a3e9b7d4e0a8c5f2d1b3a4e5f60', 'hex');

/**
 * RFC 4122 v5 (name-based, SHA-1) uuid of `parts`, a list of strings, numbers
 * and nulls. The same parts give the same uuid on every machine.
 */
export function derivedUuid(parts) {
    const name = JSON.stringify(parts.map(p => (p === undefined ? null : p)));
    const h = createHash('sha1').update(NAMESPACE).update(name, 'utf8').digest();
    h[6] = (h[6] & 0x0f) | 0x50;
    h[8] = (h[8] & 0x3f) | 0x80;
    const x = h.subarray(0, 16).toString('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * Give every row of `table` that has no uuid a derived one.
 *
 * Inputs: the table's name, each parent's uuid, the row's time and its `kind`
 * columns — never an integer id, which two unrelated libraries share. Two rows
 * with identical inputs (the same card reviewed twice in one millisecond with
 * the same rating) are told apart by their order of insertion: the first takes
 * the plain name, the n-th adds `#n`. Two copies of one library inserted those
 * rows in the same order, so they still agree. A name already taken in the
 * table moves on to the next ordinal, so the UNIQUE index can never refuse it.
 *
 * Only rows that existed before their table had a uuid column are named this
 * way. A row inserted later is one event on one machine and gets a random uuid
 * from the table's trigger.
 *
 * @returns {number} rows named
 */
export function deriveMissingUuids(db, table) {
    const spec = SYNC_TABLES[table]?.derive;
    if (!spec) return 0;
    const parentCols = spec.parents.map(([col, parent], i) =>
        `(SELECT p.uuid FROM ${parent} p WHERE p.id = t.${col}) AS p${i}`);
    const cols = [
        't.rowid AS rid',
        ...parentCols,
        spec.at ? `t.${spec.at} AS at` : 'NULL AS at',
        ...spec.kind.map((k, i) => `t.${k} AS k${i}`),
    ];
    const rows = db.prepare(`SELECT ${cols.join(', ')} FROM ${table} t WHERE t.uuid IS NULL ORDER BY t.rowid`).all();
    if (!rows.length) return 0;
    const taken = db.prepare(`SELECT 1 FROM ${table} WHERE uuid = ?`).pluck();
    const set = db.prepare(`UPDATE ${table} SET uuid = ? WHERE rowid = ?`);
    const seen = new Map();
    for (const r of rows) {
        const parts = [table, ...spec.parents.map((_, i) => r[`p${i}`]), r.at, ...spec.kind.map((_, i) => r[`k${i}`])];
        const base = JSON.stringify(parts);
        let n = seen.get(base) ?? 0;
        let uuid = derivedUuid(n ? [...parts, `#${n}`] : parts);
        while (taken.get(uuid)) { n++; uuid = derivedUuid([...parts, `#${n}`]); }
        seen.set(base, n + 1);
        set.run(uuid, r.rid);
    }
    return rows.length;
}
