// The assistant's conversations: one table of threads, each message tagged with
// the one it belongs to (`chat_messages.conversation_id`).
//
// The app has one assistant, and one thread for everything would grow a single
// history that mixes every subject, with nothing but a wipe to get out of it.
// So it keeps a list of conversations: New chat starts one, the list opens an
// old one, and delete is per conversation. Messages written before this table
// existed (the old global thread, node_id and project_id both NULL, and one
// tutor thread per node) are filed into conversations by the migration below.
//
// A conversation is NOT owned by a topic. It remembers the topic it began on
// (`node_id`, ON DELETE SET NULL) only to say so in the list; its messages carry
// no node, so deleting a topic never takes a conversation's messages with it
// (the old tutor rows cascaded with their node).
//
// Takes `db` as a parameter rather than importing database.js: database.js runs
// the migration below while it is still being evaluated.

/** How long a title is, at most. A list row shows one line of it. */
export const TITLE_MAX = 60;

/**
 * A conversation's title from the first thing the learner said in it: the first
 * non-empty line, whitespace collapsed, cut at a word near TITLE_MAX. No model
 * call: a title is bookkeeping, and the list must not wait on a model or spend
 * the learner's tokens to name a row.
 */
export function conversationTitle(text) {
    const line = String(text ?? '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    if (line.length <= TITLE_MAX) return line;
    const cut = line.slice(0, TITLE_MAX);
    const space = cut.lastIndexOf(' ');
    return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A stored timestamp as ISO. `created_at` is SQLite's `YYYY-MM-DD HH:MM:SS` (UTC). */
export function storedToIso(value, fallback) {
    const s = String(value ?? '');
    const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

/**
 * File every message that has no conversation into one. Idempotent: only rows
 * with `conversation_id IS NULL` are touched, so a second boot changes nothing.
 *
 * The old global thread becomes one conversation, titled by its first question;
 * each topic's tutor thread becomes one conversation titled by the topic and
 * remembering it. Their messages lose `node_id`/`project_id`, which only ever
 * said which thread they were in and now would only cascade them away.
 *
 * @returns {number} how many conversations were made
 */
export function migrateToConversations(db, nowIso = new Date().toISOString()) {
    const loose = db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id IS NULL').get().n;
    if (!loose) return 0;
    const groups = db.prepare(`
        SELECT node_id, MIN(created_at) AS first_at, MAX(created_at) AS last_at
        FROM chat_messages WHERE conversation_id IS NULL
        GROUP BY node_id
    `).all();
    const firstQuestion = db.prepare(`
        SELECT content FROM chat_messages
        WHERE conversation_id IS NULL AND node_id IS ? AND role = 'user'
        ORDER BY created_at, id LIMIT 1
    `);
    const nodeTitle = db.prepare('SELECT title FROM nodes WHERE id = ?');
    const insert = db.prepare('INSERT INTO chat_conversations (title, node_id, created_at, updated_at) VALUES (?, ?, ?, ?)');
    const file = db.prepare(`
        UPDATE chat_messages SET conversation_id = ?, node_id = NULL, project_id = NULL
        WHERE conversation_id IS NULL AND node_id IS ?
    `);
    let made = 0;
    db.transaction(() => {
        for (const g of groups) {
            const node = g.node_id != null ? nodeTitle.get(g.node_id) : null;
            const title = conversationTitle(node?.title || firstQuestion.get(g.node_id)?.content || '');
            const id = Number(insert.run(
                title, node ? g.node_id : null,
                storedToIso(g.first_at, nowIso), storedToIso(g.last_at, nowIso),
            ).lastInsertRowid);
            file.run(id, g.node_id);
            made++;
        }
    })();
    return made;
}
