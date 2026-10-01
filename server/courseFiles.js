// What a course file carries out and brings back in, shared by the JSON doors and the .studyvault bundle.
import db from './database.js';
import { sanitizeQuestionMedia } from './agentic.js';
import { normalizeQuestionFormat } from './answerFormats.js';
import { questionDefects } from './feedQuality.js';
import { importedQuestion, portableQuestion } from './questionTrust.js';
import { setNewPerDay } from './decks.js';
import { mediaStorage } from './vaultStorage.js';

// IMPORT / EXPORT

/**
 * The model id out of a stored `generated_by` (`{"provider","model"}` from
 * `aiProvenance()`, or `{"model","via":"import"}` for a file's own claim), for a
 * course file. The model alone: the provider says how THIS machine reaches its
 * model, which a shared course has no business carrying.
 */
const provenanceModel = (stored) => {
    if (!stored) return null;
    try {
        const model = JSON.parse(stored)?.model;
        return typeof model === 'string' && model.trim() ? model.trim() : null;
    } catch { return null; }
};

/**
 * A topic's graded questions, in the shape the importer reads back.
 *
 * Always exported, like `description` and unlike `notes` — a question is
 * authored course content, not learner data, and a "course" file that loses
 * the practice on the way out is the same hole the import side had. What stays
 * behind is the learner's own record: `quiz_attempts` never travel.
 *
 * Several quizzes on one topic flatten into one array, because that is what
 * comes back: the importer writes a topic's questions as ONE quiz. A round
 * trip therefore merges two same-topic quizzes into one, which is a change to
 * the filing and not to a single question.
 *
 * A GHOST is left out: a practice quiz carries copies of OTHER topics'
 * questions for review, and exported here they became this topic's own. So is
 * a second copy of a question already written (same uuid) — one question, one
 * entry, or the file's own importer reports a duplicate on the way back in.
 *
 * Each question a model wrote says WHICH (`generated_by`, the model id alone):
 * the mark a file already carried and kept on import, else the model of the
 * quiz row this app's own call wrote. A question a person wrote carries none.
 */
const exportedQuestions = (nodeId) => {
    const rows = db.prepare('SELECT questions, generated_by FROM quizzes WHERE node_id = ? ORDER BY id').all(nodeId);
    const out = [];
    const written = new Set();
    for (const row of rows) {
        try {
            const parsed = JSON.parse(row.questions);
            if (!Array.isArray(parsed)) continue;
            const rowModel = provenanceModel(row.generated_by);
            for (const q of parsed) {
                if (!q || typeof q !== 'object' || q.isGhost) continue;
                if (q.uuid) {
                    if (written.has(q.uuid)) continue;
                    written.add(q.uuid);
                }
                // The verification RECORD is this library's, not the course's:
                // `unverified` carries this machine's retry schedule and
                // `verifiedAt` the moment its verifier answered. Whether the
                // question was confirmed travels, as `unchecked: true`
                // (server/questionTrust.js `portableQuestion`), and the
                // importer stamps it again; otherwise an export and an import
                // would turn an unconfirmed question into proof.
                const content = portableQuestion(q);
                const model = content.generated_by || rowModel;
                out.push(model ? { ...content, generated_by: model } : content);
            }
        } catch { /* a quiz whose JSON no longer parses is not exportable; the rest are */ }
    }
    return out.length ? out : undefined;
};

/**
 * The cards a topic carries, as the file format writes them: the row's own
 * text fields and its media BY NAME. Never the schedule — `next_review`,
 * `stability`, the ease — because that is the learner's progress, and a
 * course file ships the course. `mediaNames` is the export's hash → file-name
 * map (the bundle streams those files under `media/<name>`); the plain JSON
 * export hands none, so a card there names no files — the JSON door carries
 * no bytes and a name it could never resolve would only produce a warning on
 * the way back in.
 */
const exportedFlashcards = (nodeId, mediaNames = null) => {
    const rows = db.prepare('SELECT uuid, front, back, extra, extra_front, media, generated_by FROM flashcards WHERE node_id = ? ORDER BY id').all(nodeId);
    if (!rows.length) return undefined;
    return rows.map(r => {
        // The uuid is the card's identity across machines: what lets a later
        // edition of the course update this card instead of adding a twin.
        const card = { uuid: r.uuid || undefined, front: r.front, back: r.back };
        if (!card.uuid) delete card.uuid;
        // Which model wrote it, as the questions say it (see exportedQuestions).
        const model = provenanceModel(r.generated_by);
        if (model) card.generated_by = model;
        if (r.extra) card.extra = r.extra;
        if (r.extra_front) card.extra_front = r.extra_front;
        if (mediaNames && r.media) {
            let parsed = null;
            try { parsed = JSON.parse(r.media); } catch { parsed = null; }
            const media = {};
            for (const side of ['front', 'back']) {
                const refs = Array.isArray(parsed?.[side]) ? parsed[side] : [];
                const named = refs.filter(m => m?.hash && mediaNames.has(m.hash)).map(m => ({
                    name: mediaNames.get(m.hash),
                    kind: m.kind,
                    ...(m.alt ? { alt: m.alt } : {}),
                }));
                if (named.length) media[side] = named;
            }
            if (Object.keys(media).length) card.media = media;
        }
        return card;
    });
};

/**
 * One file name per media blob a project's cards reference. The stored name
 * is the author's (`media_files.filename`), which two different files may
 * share; a collision keeps the first and prefixes the rest with their hash,
 * so every entry in the bundle's `media/` folder is one file.
 */
const projectMediaNames = (projectId) => {
    const rows = db.prepare('SELECT hash, filename, mime, kind FROM media_files WHERE project_id = ? ORDER BY id').all(projectId);
    const names = new Map();
    const used = new Set();
    for (const r of rows) {
        if (!r.hash || !mediaStorage.exists(r.hash)) continue;
        const base = String(r.filename || r.hash).replace(/[\\/]/g, '_').replace(/\.\./g, '_').slice(0, 180) || r.hash;
        const name = used.has(base) ? `${r.hash.slice(0, 12)}-${base}` : base;
        used.add(name);
        names.set(r.hash, name);
    }
    return { names, rows: rows.filter(r => names.has(r.hash)) };
};

/**
 * A supplied uuid is honoured only if it is free.
 *
 * The point of exporting uuids is that identity survives the trip between
 * machines — but the column is UNIQUE, so importing the same course twice would
 * otherwise abort the second import inside the transaction. Free = keep it (the
 * rows really are the same rows, on a new machine); taken = pass NULL and let
 * database.js's AFTER INSERT trigger mint a fresh one, because a second copy on
 * the SAME machine is a genuinely different project row.
 */
const claimUuid = (table, uuid) => {
    if (!uuid) return null;
    const taken = db.prepare(`SELECT 1 FROM ${table} WHERE uuid = ?`).get(uuid);
    return taken ? null : uuid;
};

/**
 * What `normalizeImportTree` needs before it will accept a node's `questions`.
 *
 * `curriculumSchema.js` is a no-import module on purpose — `tools/import-gates.mjs`
 * applies its rules without opening a database — and all three of these reach
 * `database.js`, so they are handed in rather than imported there. One object,
 * both import doors: a course must not be vetted differently depending on
 * whether it arrived as bare JSON or inside a bundle.
 */
const IMPORT_QUESTION_DEPS = { normalizeQuestionFormat, questionDefects, sanitizeQuestionMedia };

/**
 * Insert a tree that `normalizeImportTree` has already cleaned. Shared by both
 * import paths so a course cannot be treated differently depending on whether it
 * arrived as bare JSON or inside a bundle.
 *
 * @param {(node: object, newNodeId: number, path: string[]) => void} [onNode]
 *   The bundle importer uses this to build its title-path → id map for
 *   re-linking documents.
 */
function insertImportedTree(newProjectId, nodes, onNode, { mediaByName = null } = {}) {
    const insertNode = db.prepare(`
        INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position, uuid, role)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertResource = db.prepare(`
        INSERT INTO resources (node_id, title, url, type, completed, position, uuid)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // `generated_by` stays NULL: no model this app called wrote these. That
    // column means "which of OUR calls produced this row", and backfilling it
    // with the importer's name would make a hand-authored course indexable as
    // AI-written for the rest of its life. What a FILE says about an item is
    // kept as the file's claim and nothing more: a question keeps its own
    // `generated_by` inside the JSON, and a card that one names stores
    // `{"model","via":"import"}` — so exporting again cannot wash the mark out,
    // and an unmarked card stays NULL.
    const insertQuiz = db.prepare(`
        INSERT INTO quizzes (node_id, title, questions, generated_by) VALUES (?, ?, ?, NULL)
    `);
    // Every card starts NEW: no schedule travels in a course file. `media`
    // is the stored shape (by hash) built from the file's names through the
    // map the bundle importer made when it stored the bytes; a name that
    // resolved to nothing is dropped and counted, never invented.
    const insertCard = db.prepare(`
        INSERT INTO flashcards (node_id, front, back, extra, extra_front, media, generated_by, uuid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const declaredBy = (model) => (model ? JSON.stringify({ model, via: 'import' }) : null);
    let cardCount = 0;
    let unresolvedMedia = 0;
    const resolveMedia = (media) => {
        if (!media) return null;
        const out = {};
        for (const side of ['front', 'back']) {
            const kept = [];
            for (const m of media[side] || []) {
                const found = mediaByName?.get(m.name);
                if (!found) { unresolvedMedia++; continue; }
                kept.push({ hash: found.hash, kind: found.kind, name: m.name, alt: m.alt || '' });
            }
            if (kept.length) out[side] = kept;
        }
        return Object.keys(out).length ? JSON.stringify(out) : null;
    };

    const walk = (node, parentId, position, parentPath) => {
        const path = [...parentPath, node.title];
        const result = insertNode.run(
            newProjectId, parentId, node.title, node.description, node.notes,
            node.status, node.is_note, position, claimUuid('nodes', node.uuid), node.role,
        );
        const newNodeId = result.lastInsertRowid;
        if (onNode) onNode(node, newNodeId, path);

        node.resources.forEach((resource, idx) => {
            insertResource.run(newNodeId, resource.title, resource.url, resource.type,
                resource.completed, idx, claimUuid('resources', resource.uuid));
        });
        // The topic's practice, as ONE saved quiz. One row rather than one per
        // question because that is what a quiz already is here — the set the
        // mastery check reuses and the Tests tab lists — and because the feed
        // reaches a saved quiz's questions one at a time anyway. An author who
        // wants two sets writes two topics, which is a decision about the
        // course, not about the file format. A question the file marks
        // `unchecked: true` is stored stamped pending (questionTrust.js
        // `importedQuestion`), so this library's own verifier checks it before
        // it can count; every other question is stored as the file wrote it.
        if (node.questions.length) {
            insertQuiz.run(newNodeId, node.title, JSON.stringify(node.questions.map(q => importedQuestion(q))));
        }
        for (const card of node.flashcards || []) {
            insertCard.run(newNodeId, card.front, card.back, card.extra, card.extra_front, resolveMedia(card.media),
                declaredBy(card.generated_by), claimUuid('flashcards', card.uuid));
            cardCount++;
        }
        node.children.forEach((child, idx) => walk(child, newNodeId, idx, path));
    };

    nodes.forEach((node, idx) => walk(node, null, idx, []));
    return { cardCount, unresolvedMedia };
}

/**
 * A project's new-cards-per-day dial, for the export; null when the learner
 * never set one, so a file carries the author's choice and never the default
 * of whatever machine exported it.
 */
function newPerDaySetting(projectId) {
    const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(`deck_new_per_day_${projectId}`)?.value;
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * What an imported course asked for its cards. A 3,000-card language course
 * wants Anki's twenty a day, not the feed's authored-card dial — and the
 * honest way to get it is the per-project setting the deck screen edits,
 * written once here, never a lie about `kind`.
 */
function applyImportedCardDial(projectId, project, cardCount) {
    if (!cardCount || !Number.isFinite(project.new_per_day)) return;
    setNewPerDay(projectId, project.new_per_day);
}

export { IMPORT_QUESTION_DEPS, applyImportedCardDial, claimUuid, exportedFlashcards, exportedQuestions, insertImportedTree, newPerDaySetting, projectMediaNames };
