// server/stagedDocuments.js — files dropped into the New project dialog,
// read BEFORE the project exists.
//
// A course built from a book has to have the book in hand before the first
// model call, and the project row does not exist until well into an AI
// creation. So a dropped file is read at once — type checked, text extracted,
// its original stored, its source map built (sourceMap.js) — and held HERE,
// in a table of its own, until a creation claims it into a project.
//
// Its own table, not a `documents` row with no owner: every reader of the
// vault (the assistant's listing and search, retrieval, the embedding chain)
// would have had to learn to skip it, and the one that forgot would show a file
// from a dialog the learner closed. A staged file is invisible by construction.
// It lives a day (`STAGED_TTL_MS`); a run that failed before it made a project
// leaves its files staged, so "Back" reopens the form with them still there.

import { randomUUID } from 'node:crypto';
import db from './database.js';
import { chunkText } from './ai.js';
import { indexDocument } from './embeddings.js';
import { extractText } from './extract.js';
import { queueRecovery } from './pdfRecovery.js';
import { buildSourceMap, withoutPageMarks } from './sourceMap.js';
import { detectWrittenLanguage } from './creationLanguage.js';
import vaultStorage from './vaultStorage.js';
import { freeVaultBlobs } from './vaultBlobs.js';
import { keyed, publicMessage } from './clientError.js';

export const STAGED_TTL_MS = 24 * 60 * 60 * 1000;

const NO_TEXT = /no extractable text/i;

/**
 * Write one extracted document into the vault: the row, its chunks, then the
 * background indexing and (for a PDF) math recovery. The one way a document row
 * is written from an upload — the vault's own upload door and a claim from
 * staging both come through here.
 */
export function persistDocument({ nodeId = null, projectId = null, title, text, kind, filename, hash, size, pageCount = null }) {
    const persist = db.transaction(() => {
        const r = db.prepare(`INSERT INTO documents
            (node_id, project_id, title, content, file_type, original_filename, file_hash, file_size, status, page_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`)
            .run(nodeId, projectId, title, text, kind, filename, hash, size, pageCount);
        const docId = r.lastInsertRowid;
        const chunks = chunkText(text);
        const insertChunk = db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)');
        chunks.forEach((c, i) => insertChunk.run(docId, i, c));
        return { docId, chunkCount: chunks.length };
    });
    const out = persist();
    afterPersist(out.docId, kind);
    return out;
}

// Runs after the document is written, so it never throws: a failed queue
// (the recovery check reads the database) would otherwise turn a saved
// upload or a written course into a failed one, and a course creation would
// fall back to phases for files this course already holds.
function afterPersist(docId, kind) {
    try {
        indexDocument(docId); // background semantic indexing (serialized; no-op if embeddings off)
        // PDFs may have dropped their math at the text layer — see pdfRecovery.js.
        if (kind === 'pdf') queueRecovery(docId);
    } catch (err) {
        console.log(`[documents] Could not queue indexing for document ${docId}: ${String(err?.message || err).slice(0, 120)}`);
    }
}

/** Forget staged files older than a day, and any original nothing else holds. */
export function sweepStaged(now = Date.now()) {
    const cutoff = new Date(now - STAGED_TTL_MS).toISOString();
    const old = db.prepare('SELECT id, file_hash FROM staged_documents WHERE created_at < ?').all(cutoff);
    if (!old.length) return 0;
    db.prepare('DELETE FROM staged_documents WHERE created_at < ?').run(cutoff);
    freeVaultBlobs(old.map(r => r.file_hash));
    return old.length;
}


/**
 * Characters of real text: a scanned PDF's text is nothing but pdf-parse's page
 * marks, which count as text everywhere else.
 */
export const textChars = (text) => withoutPageMarks(text).replace(/\s+/g, '').length;

/** The language one file's text is written in: its middle sample, read with
 *  the interface language as the hint for text only that can settle
 *  (Cyrillic shared by Russian and Ukrainian, Han without kana). */
export function stagedLanguage(content, hint = null) {
    return detectWrittenLanguage(languageSample(content), hint);
}

/**
 * The language the learner's files are written in, as a creation decides it:
 * the file with the most text (`textChars`), read by `stagedLanguage`. The New
 * course dialog names its "Automatic" from each file's `language` and the same
 * largest `char_count`, so the label and the stored course cannot disagree.
 */
export function filesLanguage(rows, hint = null) {
    let best = null;
    let most = 0;
    for (const row of rows || []) {
        const n = textChars(row.content);
        if (n > most) { best = row; most = n; }
    }
    return best ? stagedLanguage(best.content, hint) : null;
}

/** What the dialog is told about one staged file. Never the text. `hint` is
 *  the interface language the creation will read the files with. */
export function stagedSummary(row, { hint = null } = {}) {
    const map = parseMap(row.source_map);
    const top = map.sections.filter(s => s.depth === Math.min(...map.sections.map(x => x.depth))).map(s => s.title);
    const chars = textChars(row.content);
    return {
        ok: true,
        id: row.id,
        title: row.title,
        file_type: row.file_type,
        file_size: row.file_size,
        page_count: row.page_count,
        char_count: chars,
        // A scan: it still goes into the project (PDF recovery can read it with
        // OCR or a vision model later), but there is nothing in it yet for the
        // outline to follow, and the dialog says so.
        noText: chars === 0,
        suggestedTitle: map.title || row.title,
        titleFrom: map.titleFrom,
        structure: { method: map.method, sections: map.sections.length, top: top.slice(0, 12), topCount: top.length },
        // The language the file is written in, read the way a creation reads
        // the files (`resolveCreationLanguage`'s `files` step, a middle sample),
        // so the dialog's "Automatic" can say what it will pick before the
        // learner commits: a bare "Automatic" over a foreign-language book
        // leaves the learner unsure which language the lessons will be in. Null
        // when it cannot be said with confidence.
        language: chars ? stagedLanguage(row.content, hint) : null,
        // A link read in the New course window (shortCourses.js): what it is
        // and where it lives, so the window lists it as a link, not a file,
        // and still does after "Back" from a run. Null for a file.
        source: linkSource(row.origin),
    };
}

function linkSource(json) {
    let o = null;
    try { o = JSON.parse(json || 'null'); } catch { return null; }
    // Read from a link (a page, a video, a PDF behind a link), or a transcript
    // pasted for a video; a file picked from the disk has neither.
    if (!o || (typeof o.url !== 'string' && !o.pasted)) return null;
    return {
        kind: ['page', 'video', 'pdf'].includes(o.kind) ? o.kind : 'file',
        url: typeof o.url === 'string' ? o.url : null,
        host: typeof o.host === 'string' ? o.host : null,
        minutes: Number.isFinite(o.minutes) ? o.minutes : null,
        pasted: !!o.pasted,
    };
}

/** The middle of a text, where a book is itself rather than its front matter. */
function languageSample(text, max = 3000) {
    const plain = withoutPageMarks(text || '');
    const mid = Math.max(0, Math.floor(plain.length / 2) - max / 2);
    return plain.slice(mid, mid + max);
}

function parseMap(json) {
    try {
        const m = JSON.parse(json || '{}');
        return { title: m.title || '', titleFrom: m.titleFrom || 'filename', method: m.method || 'none', pages: m.pages ?? null, sections: Array.isArray(m.sections) ? m.sections : [] };
    } catch {
        return { title: '', titleFrom: 'filename', method: 'none', pages: null, sections: [] };
    }
}

/**
 * Read one dropped file and hold it. A file that cannot be read comes back as
 * a failure the dialog shows (`reason: 'no_text'` for a scan with no text
 * layer) and nothing is kept.
 */
export async function stageFile(buffer, originalname, now = Date.now(), { hint = null } = {}) {
    sweepStaged(now);
    const title = String(originalname || 'file').slice(0, 500);
    let extracted;
    try {
        extracted = await extractText(buffer, originalname);
    } catch (err) {
        // The dialog shows `error`, so it is the learner's version of the
        // message (a parser bug's own text reads the code back); the no-text
        // test stays on the original words.
        const raw = String(err?.message || 'Extraction failed');
        const message = String(err?.message ? publicMessage(err) : raw).slice(0, 500);
        return { ok: false, title, error: message, reason: NO_TEXT.test(raw) ? 'no_text' : 'unreadable' };
    }
    const { text, kind, meta } = extracted;
    // A photo is accepted by the vault (kept as its original, shown as a
    // picture), but there is nothing in it a course outline can be built from.
    if (!text) return { ok: false, title, ...keyed('No text to build a course from: a picture has no words to read.'), reason: 'no_text' };
    const map = buildSourceMap({ text, kind, meta, filename: originalname });
    const { hash, size } = vaultStorage.put(buffer);
    const id = randomUUID();
    db.prepare(`INSERT INTO staged_documents
        (id, title, original_filename, file_type, content, file_hash, file_size, page_count, source_map, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, title, originalname, kind, text, hash, size, meta?.pageCount ?? null, JSON.stringify(map), new Date(now).toISOString());
    return stagedSummary(db.prepare('SELECT * FROM staged_documents WHERE id = ?').get(id), { hint });
}

/** Staged files by id, in the order asked, with their maps; unknown ids are skipped. */
export function loadStaged(ids = []) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(ids) ? ids : []) {
        const id = String(raw || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const row = db.prepare('SELECT * FROM staged_documents WHERE id = ?').get(id);
        if (row) out.push({ ...row, map: parseMap(row.source_map) });
    }
    return out;
}

/**
 * Move staged files into a project's vault. Returns `Map<stagedId, documentId>`
 * for the ones that were still staged (a second claim of the same id finds
 * nothing and claims nothing). Called inside an outer transaction, pass
 * `jobs` (an array): the indexing and PDF recovery calls go into it, to be run
 * once that transaction commits, so a rollback leaves no job queued for a
 * document that no longer exists.
 *
 * `all`: every id must still be staged, else it throws `StagedClaimedError`
 * and claims none. A course creation loads its staged rows before its model
 * calls and claims them after; another creation holding the same ids may have
 * claimed them meanwhile, and a course written without them would have topics
 * that point at no source.
 */
export function claimStaged(ids, projectId, jobs = null, { all = false } = {}) {
    const claimed = new Map();
    const take = db.transaction(() => {
        const rows = loadStaged(ids);
        if (all && rows.length !== new Set(ids.map(String)).size) throw new StagedClaimedError();
        for (const row of rows) {
            const gone = db.prepare('DELETE FROM staged_documents WHERE id = ?').run(row.id);
            if (!gone.changes) continue;
            const r = db.prepare(`INSERT INTO documents
                (node_id, project_id, title, content, file_type, original_filename, file_hash, file_size, status, page_count)
                VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`)
                .run(projectId, row.title, row.content, row.file_type, row.original_filename, row.file_hash, row.file_size, row.page_count);
            const docId = r.lastInsertRowid;
            const insertChunk = db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)');
            chunkText(row.content).forEach((c, i) => insertChunk.run(docId, i, c));
            claimed.set(row.id, { docId: Number(docId), kind: row.file_type });
        }
    });
    take();
    for (const { docId, kind } of claimed.values()) {
        if (jobs) jobs.push(() => afterPersist(docId, kind));
        else afterPersist(docId, kind);
    }
    return new Map([...claimed].map(([k, v]) => [k, v.docId]));
}

/** A creation's staged files were claimed by another creation while it ran. */
export class StagedClaimedError extends Error {
    constructor() {
        super('Some of this course\'s files are no longer available: another course took them while it was being made.');
        this.name = 'StagedClaimedError';
        this.expose = true;
    }
}

/** Drop one staged file (the dialog's ✕, or the dialog closed). */
export function discardStaged(id) {
    const row = db.prepare('SELECT file_hash FROM staged_documents WHERE id = ?').get(String(id || ''));
    if (!row) return false;
    db.prepare('DELETE FROM staged_documents WHERE id = ?').run(String(id));
    freeVaultBlobs([row.file_hash]);
    return true;
}
