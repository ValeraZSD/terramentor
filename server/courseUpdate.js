// Updating an installed course from a newer file: the database half. What to
// change is decided by the pure planner (courseMerge.js); this reads the three
// snapshots it compares, writes what it decided in one transaction, records
// the new base, and keeps what the update changed so it can be taken back.
import { createHash } from 'node:crypto';
import db, { NOW_ISO } from './database.js';
import { ENTITY_FIELDS, KINDS, PROJECT_FIELDS, fieldHash } from './courseMerge.js';
import { importedQuestion, portableQuestion } from './questionTrust.js';
import { claimUuid } from './courseFiles.js';

const ORDERED = new Set(['node', 'resource']);
/** Statements prepared once: the readers and the writer run one per item. A
 *  statement whose text varies with a list's length is never put here. */
const statements = new Map();
const prep = (sql) => {
    let s = statements.get(sql);
    if (!s) { s = db.prepare(sql); statements.set(sql, s); }
    return s;
};
const SERVED_ORDER = ['options', 'items', 'tokens'];
const text = (s) => (s == null || s === '' ? null : String(s));
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** A question as the course wrote it: no identity, no provenance, no record of
 *  this library's verifier, so only an author's change makes it differ. */
export function questionContent(q) {
    const { uuid: _u, generated_by: _g, unchecked: _c, isGhost: _gh, ghostNodeId: _gn, ...content } = portableQuestion(q) || {};
    // The order a question is SERVED in is drawn at random every time a file is
    // read (answerFormats.js shuffles options, ordering items and assembly
    // tiles; the key is stored apart), so it is no part of what the author wrote.
    for (const f of SERVED_ORDER) {
        if (Array.isArray(content[f])) content[f] = [...content[f]].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
    }
    return content;
}

/** A card's media as names, the way a file names them. */
function mediaNames(media) {
    const parsed = typeof media === 'string' ? safeParse(media) : media;
    if (!parsed || typeof parsed !== 'object') return null;
    const out = {};
    for (const side of ['front', 'back']) {
        const refs = Array.isArray(parsed[side]) ? parsed[side] : [];
        if (refs.length) out[side] = refs.map(m => ({ name: m?.name || m?.hash || '', kind: m?.kind || null, alt: m?.alt || null }));
    }
    return Object.keys(out).length ? out : null;
}

/** Tables whose rows on a topic are the learner's: anything there means the
 *  topic is not the author's to delete. */
const STATE_TABLES = ['mastery_evidence', 'node_mastery', 'study_time', 'chat_conversations', 'chat_messages', 'paper_attempts',
    'mastery_claims', 'question_log', 'documents', 'node_sources', 'item_reports'];
let stateQueries = null;
const topicsWithState = (projectId) => {
    stateQueries ??= STATE_TABLES.filter(t => db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = 'node_id'`).get())
        .map(t => db.prepare(`SELECT DISTINCT node_id AS id FROM ${t} WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)`));
    const ids = new Set();
    for (const s of stateQueries) for (const r of s.all(projectId)) ids.add(r.id);
    // A practice set this library's model wrote is the learner's too.
    for (const r of prep('SELECT DISTINCT node_id AS id FROM quizzes WHERE generated_by IS NOT NULL AND node_id IN (SELECT id FROM nodes WHERE project_id = ?)').all(projectId)) ids.add(r.id);
    return ids;
};
/** Whether a topic holds anything of the learner's; `withState` is `topicsWithState`. */
const topicHasState = (n, withState) => (n.status && n.status !== 'not_started') || !!text(n.notes) || !!n.completed_at || withState.has(n.id);

/** The course as it stands in the library: every item with its author-owned
 *  fields, its row id, and whether anything of the learner's hangs on it. */
export function readInstalledCourse(projectId) {
    const project = prep('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return null;
    const nodes = prep('SELECT * FROM nodes WHERE project_id = ? ORDER BY position, id').all(projectId);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const withState = topicsWithState(projectId);
    const tracked = new Set(prep("SELECT uuid FROM course_base WHERE project_id = ? AND kind = 'question' AND field = 'content'").all(projectId).map(r => r.uuid));
    const entities = [];
    for (const n of nodes) {
        const parent = n.parent_id ? byId.get(n.parent_id) : null;
        entities.push({
            kind: 'node', uuid: n.uuid, id: n.id, parentUuid: parent?.uuid ?? null, position: n.position,
            fields: { title: n.title, description: text(n.description), is_note: n.is_note ? 1 : 0, role: n.role || 'topic' },
            hasState: topicHasState(n, withState),
            label: n.title, where: parent?.title ?? null,
        });
    }
    const nodeIds = nodes.map(n => n.id);
    if (nodeIds.length) {
        const inProject = 'SELECT id FROM nodes WHERE project_id = ?';
        const seen = new Set();
        for (const row of prep(`SELECT id, node_id, questions, generated_by FROM quizzes WHERE node_id IN (${inProject}) ORDER BY id`).all(projectId)) {
            const node = byId.get(row.node_id);
            const qs = safeParse(row.questions);
            if (!Array.isArray(qs)) continue;
            for (const q of qs) {
                if (!q || typeof q !== 'object' || q.isGhost || !q.uuid) continue;
                const uuid = `${node.uuid}/${q.uuid}`;
                // The course's own bank, or a question an earlier update put there.
                if ((row.generated_by && !tracked.has(uuid)) || seen.has(uuid)) continue;
                seen.add(uuid);
                entities.push({ kind: 'question', uuid, id: row.id, parentUuid: node.uuid, fields: { content: questionContent(q) },
                    hasState: false, label: String(q.question ?? '').slice(0, 160), where: node.title, rawUuid: q.uuid });
            }
        }
        const reviewed = new Set(prep(`SELECT DISTINCT card_id AS id FROM review_log WHERE card_id IN (SELECT f.id FROM flashcards f WHERE f.node_id IN (${inProject}))`).all(projectId).map(r => r.id));
        for (const c of prep(`SELECT * FROM flashcards WHERE node_id IN (${inProject}) ORDER BY id`).all(projectId)) {
            const node = byId.get(c.node_id);
            entities.push({
                kind: 'card', uuid: c.uuid, id: c.id, parentUuid: node.uuid,
                fields: { front: c.front, back: c.back, extra: text(c.extra), extra_front: text(c.extra_front), media: mediaNames(c.media) },
                hasState: (c.review_count || 0) > 0 || !!c.last_reviewed || reviewed.has(c.id),
                label: c.front, where: node.title,
            });
        }
        for (const r of prep(`SELECT * FROM resources WHERE node_id IN (${inProject}) ORDER BY position, id`).all(projectId)) {
            const node = byId.get(r.node_id);
            entities.push({
                kind: 'resource', uuid: r.uuid, id: r.id, parentUuid: node.uuid, position: r.position,
                fields: { title: r.title, url: text(r.url), type: r.type || 'link' },
                hasState: !!r.completed, label: r.title, where: node.title,
            });
        }
    }
    return {
        project: { id: project.id, uuid: project.uuid, fields: projectFields(project) },
        entities,
    };
}

const projectFields = (p) => ({
    name: p.name, description: text(p.description), content_language: text(p.content_language),
    learning_language: text(p.learning_language), version: text(p.version),
});

/**
 * The course as a normalized file writes it (`normalizeImportProject` +
 * `normalizeImportTree`), in the planner's shape. A file in the plain JSON
 * door carries no media bytes, so its cards' media is not compared at all.
 */
export function readFileCourse(project, nodes, { exportedAt = null, withMedia = false } = {}) {
    const entities = [];
    let n = 0;
    const walk = (list, parentRef, parentTitle) => list.forEach((node, position) => {
        const ref = node.uuid || `#node-${n++}`;
        entities.push({
            kind: 'node', uuid: node.uuid || null, ref, parentRef, position,
            fields: { title: node.title, description: text(node.description), is_note: node.is_note ? 1 : 0, role: node.role || 'topic' },
            source: node, label: node.title, where: parentTitle,
        });
        (node.questions || []).forEach((q, i) => entities.push({
            kind: 'question', uuid: q.uuid || null, ref: `${ref}#q${i}`, parentRef: ref,
            fields: { content: questionContent(q) }, source: q, label: String(q.question ?? '').slice(0, 160), where: node.title,
        }));
        (node.flashcards || []).forEach((c, i) => entities.push({
            kind: 'card', uuid: c.uuid || null, ref: c.uuid || `${ref}#c${i}`, parentRef: ref,
            fields: {
                front: c.front, back: c.back, extra: text(c.extra), extra_front: text(c.extra_front),
                media: withMedia ? mediaNames(c.media) : undefined,
            },
            source: c, label: c.front, where: node.title,
        }));
        (node.resources || []).forEach((r, i) => entities.push({
            kind: 'resource', uuid: r.uuid || null, ref: r.uuid || `${ref}#r${i}`, parentRef: ref, position: i,
            fields: { title: r.title, url: text(r.url), type: r.type || 'link' }, source: r, label: r.title, where: node.title,
        }));
        walk(node.children || [], ref, node.title);
    });
    walk(nodes, null, null);
    return {
        exportedAt: typeof exportedAt === 'string' && !Number.isNaN(Date.parse(exportedAt)) ? new Date(exportedAt).toISOString() : null,
        project: { fields: projectFields(project) },
        entities,
    };
}

/** What the course looked like when it was installed or last updated. */
export function readBase(projectId) {
    const up = prep('SELECT exported_at, version FROM course_upstream WHERE project_id = ?').get(projectId);
    const entities = new Map();
    const project = { fields: {} };
    for (const r of prep('SELECT kind, uuid, field, base_hash, edited FROM course_base WHERE project_id = ?').all(projectId)) {
        const value = { hash: r.base_hash, edited: !!r.edited };
        if (r.kind === 'project') { project.fields[r.field] = value; continue; }
        const k = `${r.kind}:${r.uuid}`;
        if (!entities.has(k)) entities.set(k, { fields: {} });
        entities.get(k).fields[r.field] = value;
    }
    return { exportedAt: up?.exported_at ?? null, version: up?.version ?? null, project, entities };
}

const putBaseStmt = () => prep(`INSERT INTO course_base (project_id, kind, uuid, field, base_hash, edited) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, kind, uuid, field) DO UPDATE SET base_hash = excluded.base_hash, edited = excluded.edited`);
const putUpstreamStmt = () => prep(`INSERT INTO course_upstream (project_id, exported_at, version, synced_at) VALUES (?, ?, ?, ${NOW_ISO})
    ON CONFLICT(project_id) DO UPDATE SET exported_at = excluded.exported_at, version = excluded.version, synced_at = excluded.synced_at`);

/**
 * Record the base of a course a file just installed: its rows hold exactly the
 * file's values, so the base is read back from them. Called inside the import
 * doors' own transaction.
 */
export function recordInstalledBase(projectId, { exportedAt = null } = {}) {
    const course = readInstalledCourse(projectId);
    if (!course) return;
    const put = putBaseStmt();
    for (const [f, v] of Object.entries(course.project.fields)) put.run(projectId, 'project', course.project.uuid, f, fieldHash(v), 0);
    for (const e of course.entities) {
        const fields = { ...e.fields, parent: e.parentUuid ?? null };
        for (const f of ENTITY_FIELDS[e.kind]) put.run(projectId, e.kind, e.uuid, f, fieldHash(fields[f] ?? null), 0);
        if (ORDERED.has(e.kind)) put.run(projectId, e.kind, e.uuid, 'position', fieldHash(e.position ?? null), 0);
    }
    const at = typeof exportedAt === 'string' && !Number.isNaN(Date.parse(exportedAt)) ? new Date(exportedAt).toISOString() : null;
    putUpstreamStmt().run(projectId, at, course.project.fields.version);
}

/**
 * A person edited these fields of an item through an edit route: an update
 * that also changes one of them is a conflict, not a fast-forward. A row no
 * file installed has no base row, and this changes nothing for it.
 */
export function markLearnerEdit(kind, uuid, fields) {
    if (!uuid) return;
    const flag = prep('UPDATE course_base SET edited = 1 WHERE kind = ? AND uuid = ? AND field = ?');
    for (const f of fields) if (f) flag.run(kind, uuid, f);
}

// ---- undo: what an update changed, kept so it can be put back ------------------------
// Only the rows an update writes: the course's topics, links, cards and question
// banks (their author-owned columns), the ask-records it cleared, its base. The
// learner's own columns (status, notes, the schedule) are never put back, so a
// review made after the update survives an undo.
const RESTORE = {
    nodes: ['title', 'description', 'is_note', 'role', 'parent_id', 'position'],
    resources: ['node_id', 'title', 'url', 'type', 'position'],
    flashcards: ['node_id', 'front', 'back', 'extra', 'extra_front', 'media'],
    quizzes: ['node_id', 'title', 'questions'],
};
const scopeSql = {
    nodes: 'SELECT * FROM nodes WHERE project_id = ?',
    resources: 'SELECT * FROM resources WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)',
    flashcards: 'SELECT * FROM flashcards WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)',
    quizzes: 'SELECT * FROM quizzes WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)',
};

function takeUndoSnapshot(projectId) {
    const rows = {};
    for (const [t, sql] of Object.entries(scopeSql)) rows[t] = prep(sql).all(projectId);
    return {
        project: prep('SELECT name, description, content_language, learning_language, version FROM projects WHERE id = ?').get(projectId),
        rows,
        questionLog: prep('SELECT * FROM question_log WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)').all(projectId),
        base: prep('SELECT kind, uuid, field, base_hash, edited FROM course_base WHERE project_id = ?').all(projectId),
        upstream: prep('SELECT exported_at, version, synced_at FROM course_upstream WHERE project_id = ?').get(projectId) || null,
    };
}

// What the course's author-owned rows look like now. Recorded right after an
// update: the undo puts back only what that update wrote, so it is refused once
// anything here moved since (a topic, card or link added, an edit, a rename).
function courseFingerprint(projectId) {
    const h = createHash('sha256');
    h.update(JSON.stringify(prep('SELECT name, description, content_language, learning_language, version FROM projects WHERE id = ?').get(projectId)));
    for (const t of Object.keys(scopeSql)) {
        for (const r of prep(`${scopeSql[t]} ORDER BY id`).all(projectId)) h.update(JSON.stringify([t, r.id, ...RESTORE[t].map(c => r[c] ?? null)]));
    }
    return h.digest('hex');
}

const UNDO_REFUSED = {
    changed: 'The course has changed since the update, so the update can no longer be undone.',
    progress: 'You have studied something the update added; undoing it would delete that progress.',
};

// Why this undo would take more than the update wrote, or null when it is safe.
function undoBlocker(projectId, snap) {
    if (!snap.after || courseFingerprint(projectId) !== snap.after) return 'changed';
    // The fingerprint holds only author-owned columns: what the learner did on a
    // row the update added (a note, a review, a ticked link, an attempt) is
    // looked for here, because the undo deletes that row.
    const added = (t) => {
        const had = new Set(snap.rows[t].map(r => r.id));
        return prep(scopeSql[t]).all(projectId).filter(r => !had.has(r.id));
    };
    const withState = topicsWithState(projectId);
    if (added('nodes').some(n => topicHasState(n, withState))) return 'progress';
    const reviewed = prep('SELECT 1 FROM review_log WHERE card_id = ? LIMIT 1');
    if (added('flashcards').some(c => c.review_count > 0 || reviewed.get(c.id))) return 'progress';
    if (added('resources').some(r => r.completed)) return 'progress';
    const attempted = prep('SELECT 1 FROM quiz_attempts WHERE quiz_id = ? LIMIT 1');
    if (added('quizzes').some(q => attempted.get(q.id))) return 'progress';
    return null;
}

const undoSnapshot = (projectId) => {
    const row = prep('SELECT undo, undo_at, version FROM course_upstream WHERE project_id = ? AND undo IS NOT NULL').get(projectId);
    const snap = row ? safeParse(row.undo) : null;
    return snap ? { snap, at: row.undo_at, version: row.version } : null;
};

export function undoAvailable(projectId) {
    const u = undoSnapshot(projectId);
    if (!u) return { available: false };
    const blocked = undoBlocker(projectId, u.snap);
    return blocked ? { available: false, reason: UNDO_REFUSED[blocked] } : { available: true, at: u.at, version: u.version };
}

/**
 * Put the course back as it was before its last update.
 * @returns {{ ok: true } | { ok: false, reason: string | null }}  reason null: no update to undo
 */
export function undoLastUpdate(projectId) {
    const u = undoSnapshot(projectId);
    if (!u) return { ok: false, reason: null };
    const { snap } = u;
    const blocked = undoBlocker(projectId, snap);
    if (blocked) return { ok: false, reason: UNDO_REFUSED[blocked] };
    db.transaction(() => {
        // A topic re-inserted before its parent is back: checked at commit.
        db.pragma('defer_foreign_keys = ON');
        // Rows that were there before go back under their old topic FIRST: one
        // the update moved under a topic it added would otherwise go with that
        // topic's cascade, progress and all.
        for (const [t, col] of [['nodes', 'parent_id'], ['resources', 'node_id'], ['flashcards', 'node_id'], ['quizzes', 'node_id']]) {
            const back = prep(`UPDATE ${t} SET ${col} = ? WHERE id = ? AND ${col} IS NOT ?`);
            for (const r of snap.rows[t]) back.run(r[col] ?? null, r.id, r[col] ?? null);
        }
        // Rows the update added go first (children before parents is what the
        // cascade handles); rows it changed or removed come back.
        for (const t of ['quizzes', 'flashcards', 'resources', 'nodes']) {
            const keep = new Set(snap.rows[t].map(r => r.id));
            for (const r of prep(scopeSql[t]).all(projectId)) if (!keep.has(r.id)) prep(`DELETE FROM ${t} WHERE id = ?`).run(r.id);
        }
        for (const t of ['nodes', 'resources', 'flashcards', 'quizzes']) {
            const cols = prep(`SELECT name FROM pragma_table_info('${t}')`).all().map(c => c.name);
            const exists = prep(`SELECT 1 FROM ${t} WHERE id = ?`);
            for (const r of snap.rows[t]) {
                if (exists.get(r.id)) {
                    prep(`UPDATE ${t} SET ${RESTORE[t].map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...RESTORE[t].map(c => r[c] ?? null), r.id);
                } else {
                    const present = cols.filter(c => c in r);
                    prep(`INSERT INTO ${t} (${present.join(', ')}) VALUES (${present.map(() => '?').join(', ')})`).run(...present.map(c => r[c]));
                }
            }
        }
        const logExists = prep('SELECT 1 FROM question_log WHERE id = ?');
        const logCols = prep("SELECT name FROM pragma_table_info('question_log')").all().map(c => c.name);
        for (const r of snap.questionLog) {
            if (logExists.get(r.id)) continue;
            const present = logCols.filter(c => c in r);
            prep(`INSERT INTO question_log (${present.join(', ')}) VALUES (${present.map(() => '?').join(', ')})`).run(...present.map(c => r[c]));
        }
        const p = snap.project;
        prep('UPDATE projects SET name = ?, description = ?, content_language = ?, learning_language = ?, version = ? WHERE id = ?')
            .run(p.name, p.description, p.content_language, p.learning_language, p.version, projectId);
        prep('DELETE FROM course_base WHERE project_id = ?').run(projectId);
        const put = putBaseStmt();
        for (const b of snap.base) put.run(projectId, b.kind, b.uuid, b.field, b.base_hash, b.edited);
        if (snap.upstream) {
            prep('UPDATE course_upstream SET exported_at = ?, version = ?, synced_at = ?, undo = NULL, undo_at = NULL WHERE project_id = ?')
                .run(snap.upstream.exported_at, snap.upstream.version, snap.upstream.synced_at, projectId);
        } else {
            prep('DELETE FROM course_upstream WHERE project_id = ?').run(projectId);
        }
    })();
    return { ok: true };
}

// ---- applying a plan --------------------------------------------------------------------

/**
 * Write a plan (courseMerge.js `planCourseUpdate`) into the library, in one
 * transaction, and record the new base. `mediaByName` resolves a card's media
 * names to stored blobs (a bundle's; a plain JSON file brings none, and a card
 * then keeps the media it has).
 *
 * @returns {{ touchedNodes: number[] }}  topics whose taught text changed
 */
export function applyCourseUpdate(projectId, plan, { mediaByName = null } = {}) {
    const touched = new Set();
    db.transaction(() => {
        const undo = takeUndoSnapshot(projectId);
        const nodeIdByUuid = new Map(prep('SELECT id, uuid FROM nodes WHERE project_id = ?').all(projectId).map(r => [r.uuid, r.id]));
        const insertedUuid = new Map();   // `new:<ref>` -> the uuid the row got
        const insertedResource = new Map();   // the same, for links
        const resolveNode = (ref) => {
            if (ref == null) return null;
            if (String(ref).startsWith('new:')) {
                const u = insertedUuid.get(ref);
                return u ? nodeIdByUuid.get(u) ?? null : null;
            }
            return nodeIdByUuid.get(ref) ?? null;
        };
        const uuidOfNode = (id) => prep('SELECT uuid FROM nodes WHERE id = ?').get(id)?.uuid;
        const put = putBaseStmt();
        const writeBase = (kind, uuid, fields) => {
            for (const [f, v] of Object.entries(fields)) put.run(projectId, kind, uuid, f, v.hash, v.edited ? 1 : 0);
        };
        const resolveMedia = (media) => {
            if (!media) return null;
            const out = {};
            for (const side of ['front', 'back']) {
                const kept = [];
                for (const m of media[side] || []) {
                    const found = mediaByName?.get(m.name);
                    if (found) kept.push({ hash: found.hash, kind: found.kind, name: m.name, alt: m.alt || '' });
                }
                if (kept.length) out[side] = kept;
            }
            return Object.keys(out).length ? JSON.stringify(out) : null;
        };
        const namesMedia = (media) => ['front', 'back'].some(side => (media?.[side] || []).length > 0);

        // The course header. `version` is the author's and nobody edits it.
        const pf = plan.project || {};
        const pcols = Object.keys(pf).filter(f => PROJECT_FIELDS.includes(f));
        if (pcols.length) prep(`UPDATE projects SET ${pcols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...pcols.map(c => pf[c]), projectId);
        const projectUuid = prep('SELECT uuid FROM projects WHERE id = ?').get(projectId).uuid;
        writeBase('project', projectUuid, plan.projectBase || {});

        const byKind = (op, kind) => plan.ops.filter(o => o.op === op && o.kind === kind);

        // Topics: new ones in file order (a parent before its children), then changes.
        for (const o of byKind('insert', 'node')) {
            const s = o.source || {};
            const id = prep(`INSERT INTO nodes (project_id, parent_id, title, description, is_note, position, uuid, role)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(projectId, resolveNode(o.parent), s.title, s.description ?? null, s.is_note ? 1 : 0,
                o.position, claimUuid('nodes', o.uuid), s.role || 'topic').lastInsertRowid;
            const uuid = uuidOfNode(id);
            nodeIdByUuid.set(uuid, id);
            insertedUuid.set(`new:${o.ref}`, uuid);
            writeBase('node', uuid, { ...o.baseFields, parent: { hash: fieldHash(o.parent && String(o.parent).startsWith('new:') ? insertedUuid.get(o.parent) ?? null : o.parent), edited: 0 } });
        }
        for (const o of byKind('update', 'node')) {
            const sets = [];
            const vals = [];
            for (const [f, v] of Object.entries(o.fields)) {
                if (f === 'parent') { sets.push('parent_id = ?'); vals.push(resolveNode(v)); continue; }
                sets.push(`${f} = ?`); vals.push(v);
                if (f === 'title' || f === 'description') touched.add(o.id);
            }
            prep(`UPDATE nodes SET ${sets.join(', ')}, updated_at = ${NOW_ISO} WHERE id = ?`).run(...vals, o.id);
        }

        // Question banks. A topic's course bank is its unmarked quiz row.
        const bankRow = (nodeId) => prep('SELECT id, questions FROM quizzes WHERE node_id = ? AND generated_by IS NULL ORDER BY id').get(nodeId);
        const readBank = (quizId) => safeParse(prep('SELECT questions FROM quizzes WHERE id = ?').get(quizId)?.questions) || [];
        const writeBank = (quizId, qs) => prep('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify(qs), quizId);
        const clearAsked = (quizId, rawUuid) => prep('DELETE FROM question_log WHERE quiz_id = ? AND question_uuid = ?').run(quizId, rawUuid);
        const addToBank = (nodeId, question) => {
            const row = bankRow(nodeId);
            if (row) {
                const qs = safeParse(row.questions) || [];
                if (question.uuid && qs.some(x => x?.uuid === question.uuid)) delete question.uuid;
                qs.push(question);
                writeBank(row.id, qs);
                return { quizId: row.id, index: qs.length - 1 };
            }
            const title = prep('SELECT title FROM nodes WHERE id = ?').get(nodeId)?.title || 'Questions';
            const quizId = prep('INSERT INTO quizzes (node_id, title, questions, generated_by) VALUES (?, ?, ?, NULL)')
                .run(nodeId, title, JSON.stringify([question])).lastInsertRowid;
            return { quizId, index: 0 };
        };
        const rawOf = (compositeUuid) => String(compositeUuid).split('/').pop();
        for (const o of byKind('delete', 'question')) {
            const raw = rawOf(o.uuid);
            writeBank(o.id, readBank(o.id).filter(q => q?.uuid !== raw));
            clearAsked(o.id, raw);
            touched.add(prep('SELECT node_id FROM quizzes WHERE id = ?').get(o.id)?.node_id);
        }
        for (const o of byKind('update', 'question')) {
            const raw = rawOf(o.uuid);
            const next = { ...importedQuestion(o.source), uuid: raw };
            const nodeId = prep('SELECT node_id FROM quizzes WHERE id = ?').get(o.id)?.node_id;
            clearAsked(o.id, raw);
            touched.add(nodeId);
            const qs = readBank(o.id);
            const target = 'parent' in o.fields ? resolveNode(o.fields.parent) : nodeId;
            if (target !== nodeId && target != null) {
                writeBank(o.id, qs.filter(q => q?.uuid !== raw));
                addToBank(target, next);
                touched.add(target);
            } else {
                writeBank(o.id, qs.map(q => (q?.uuid === raw ? next : q)));
            }
        }
        for (const o of byKind('insert', 'question')) {
            const nodeId = resolveNode(o.parent);
            if (nodeId == null) continue;
            const q = importedQuestion(o.source);
            const { quizId, index } = addToBank(nodeId, q);
            const stamped = readBank(quizId)[index];
            touched.add(nodeId);
            if (stamped?.uuid) writeBase('question', `${uuidOfNode(nodeId)}/${stamped.uuid}`, { ...o.baseFields, parent: { hash: fieldHash(uuidOfNode(nodeId)), edited: 0 } });
        }

        // Cards.
        const declaredBy = (model) => (model ? JSON.stringify({ model, via: 'import' }) : null);
        for (const o of byKind('update', 'card')) {
            const sets = [];
            const vals = [];
            for (const [f, v] of Object.entries(o.fields)) {
                if (f === 'parent') { const to = resolveNode(v); if (to != null) { sets.push('node_id = ?'); vals.push(to); } continue; }
                if (f === 'media') {
                    // Names the file's bytes did not bring cannot be stored; the card keeps what it has.
                    if (!mediaByName) continue;
                    const stored = resolveMedia(v);
                    if (stored == null && namesMedia(v)) continue;
                    sets.push('media = ?'); vals.push(stored); continue;
                }
                sets.push(`${f} = ?`); vals.push(v);
            }
            if (sets.length) prep(`UPDATE flashcards SET ${sets.join(', ')} WHERE id = ?`).run(...vals, o.id);
        }
        for (const o of byKind('insert', 'card')) {
            const nodeId = resolveNode(o.parent);
            if (nodeId == null) continue;
            const c = o.source || {};
            const id = prep(`INSERT INTO flashcards (node_id, front, back, extra, extra_front, media, generated_by, uuid)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(nodeId, c.front, c.back, c.extra ?? null, c.extra_front ?? null,
                resolveMedia(c.media), declaredBy(c.generated_by), claimUuid('flashcards', o.uuid)).lastInsertRowid;
            const uuid = prep('SELECT uuid FROM flashcards WHERE id = ?').get(id).uuid;
            writeBase('card', uuid, { ...o.baseFields, parent: { hash: fieldHash(uuidOfNode(nodeId)), edited: 0 } });
        }
        for (const o of byKind('delete', 'card')) prep('DELETE FROM flashcards WHERE id = ?').run(o.id);

        // Links.
        for (const o of byKind('update', 'resource')) {
            const sets = [];
            const vals = [];
            for (const [f, v] of Object.entries(o.fields)) {
                // A topic the plan could not place (no match, not inserted): the link stays where it is.
                if (f === 'parent') { const to = resolveNode(v); if (to != null) { sets.push('node_id = ?'); vals.push(to); } continue; }
                sets.push(`${f} = ?`); vals.push(v);
            }
            if (sets.length) prep(`UPDATE resources SET ${sets.join(', ')} WHERE id = ?`).run(...vals, o.id);
        }
        for (const o of byKind('insert', 'resource')) {
            const nodeId = resolveNode(o.parent);
            if (nodeId == null) continue;
            const r = o.source || {};
            const id = prep('INSERT INTO resources (node_id, title, url, type, completed, position, uuid) VALUES (?, ?, ?, ?, 0, ?, ?)')
                .run(nodeId, r.title, r.url ?? null, r.type || 'link', o.position, claimUuid('resources', o.uuid)).lastInsertRowid;
            const uuid = prep('SELECT uuid FROM resources WHERE id = ?').get(id).uuid;
            insertedResource.set(`new:${o.ref}`, uuid);
            writeBase('resource', uuid, { ...o.baseFields, parent: { hash: fieldHash(uuidOfNode(nodeId)), edited: 0 } });
        }
        for (const o of byKind('delete', 'resource')) prep('DELETE FROM resources WHERE id = ?').run(o.id);

        // Topics the file dropped and nothing of the learner's holds: gone.
        for (const o of byKind('delete', 'node')) prep('DELETE FROM nodes WHERE id = ?').run(o.id);

        // Sibling order, the file's for what it knows.
        for (const r of plan.reorder || []) {
            const table = r.kind === 'node' ? 'nodes' : 'resources';
            const idOf = r.kind === 'node'
                ? (u) => resolveNode(u)
                : (u) => prep('SELECT id FROM resources WHERE uuid = ?').get(String(u).startsWith('new:') ? insertedResource.get(u) ?? '' : u)?.id;
            const ids = r.children.map(idOf).filter(id => id != null);
            ids.forEach((id, i) => prep(`UPDATE ${table} SET position = ? WHERE id = ?`).run(i, id));
        }

        // The base: what the course now is upstream. Removed items leave it, so
        // what was kept becomes the learner's own.
        for (const o of plan.ops) {
            if (o.op === 'delete' || o.op === 'keepRemoved') prep('DELETE FROM course_base WHERE project_id = ? AND kind = ? AND uuid = ?').run(projectId, o.kind, o.uuid);
        }
        for (const b of plan.newBase) {
            // A parent this update inserted has its uuid only now.
            writeBase(b.kind, b.uuid, b.newParent
                ? { ...b.fields, parent: { ...b.fields.parent, hash: fieldHash(insertedUuid.get(b.newParent) ?? null) } }
                : b.fields);
        }
        putUpstreamStmt().run(projectId, plan.exportedAt, pf.version ?? prep('SELECT version FROM projects WHERE id = ?').get(projectId).version);
        undo.after = courseFingerprint(projectId);
        prep(`UPDATE course_upstream SET undo = ?, undo_at = ${NOW_ISO} WHERE project_id = ?`).run(JSON.stringify(undo), projectId);

        // Practice written from the old text is stale: unconsumed feed rows on a
        // topic whose Overview or questions changed are dropped and written again.
        const stale = [...touched].filter(id => id != null);
        if (stale.length) {
            db.prepare(`DELETE FROM feed_items WHERE consumed_at IS NULL AND node_id IN (${stale.map(() => '?').join(',')})`).run(...stale);
        }
    })();
    return { touchedNodes: [...touched].filter(id => id != null) };
}

export { KINDS };
