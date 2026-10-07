// /api/documents: the vault (upload, text, original, recovery, delete, search).
import db from '../database.js';
import { contentDisposition } from '../httpHeaders.js';
import { chunkText, searchDocuments } from '../ai.js';
import { indexDocument } from '../embeddings.js';
import multer from 'multer';
import fs from 'node:fs';
import vaultStorage from '../vaultStorage.js';
import { extractText, MAX_FILE_BYTES } from '../extract.js';
import { queueRecovery } from '../pdfRecovery.js';
import { rejectOversizedBody } from '../uploadGuard.js';
import { documentChunkIds, freeDocumentAssets } from '../documentAssets.js';
import { claimStaged, discardStaged, persistDocument, stageFile } from '../stagedDocuments.js';
import { getUiLanguage } from '../language.js';
import { languageFromAcceptHeader } from '../creationLanguage.js';
import { wrap } from './request.js';
import { routeTable } from './routeTable.js';

const app = routeTable('documents');

// Uploads are buffered in memory (we hash + extract them immediately, then
// hand the bytes to the content-addressed blob store) and hard-capped per file.
const vaultUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 100 },
});


// MIME type for inline viewing of an original by its logical kind/extension.
const MIME_BY_KIND = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    text: 'text/plain; charset=utf-8',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
};
const IMAGE_KINDS = ['jpg', 'png', 'webp'];

// DOCUMENTS

app.post('/api/documents', (req, res) => {
    const { nodeId, projectId, title, content, fileType = 'text' } = req.body;
    const result = db.prepare('INSERT INTO documents (node_id, project_id, title, content, file_type) VALUES (?, ?, ?, ?, ?)')
        .run(nodeId || null, projectId || null, title, content, fileType);
    const docId = result.lastInsertRowid;
    const chunks = chunkText(content);
    const insertChunk = db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)');
    const transaction = db.transaction(() => {
        chunks.forEach((chunk, index) => {
            insertChunk.run(docId, index, chunk);
        });
    });
    transaction();
    indexDocument(docId); // background semantic indexing (no-op if embeddings off)
    res.json({ id: docId, chunks: chunks.length });
});

// Upload one or more original files into a project/node vault. Each file is
// type-validated (magic bytes), text-extracted, its original stored in the
// content-addressed blob store, and indexed for RAG. A file that fails to parse
// is recorded with status='failed' + error so the user sees why — it never
// aborts the batch or crashes the server.
const handleVaultUpload = (req, res, next) =>
    // 256 MB aggregate: 100 × 25 MB is the per-file shape, but a batch that
    // size buffered in memory at once is not a shape anything wants.
    rejectOversizedBody(256 * 1024 * 1024)(req, res, () =>
        vaultUpload.array('files')(req, res, (err) => {
            if (err) {
                const msg = err.code === 'LIMIT_FILE_SIZE'
                    ? `File exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit`
                    : err.code === 'LIMIT_FILE_COUNT'
                        ? 'Too many files in one upload (max 100) — please upload in smaller batches'
                        : err.message || 'Upload failed';
                return res.status(400).json({ error: msg });
            }
            next();
        }));

app.post('/api/documents/upload', handleVaultUpload, wrap(async (req, res) => {
    const projectId = req.body.projectId ? Number(req.body.projectId) : null;
    const nodeId = req.body.nodeId ? Number(req.body.nodeId) : null;
    if (!projectId && !nodeId) return res.status(400).json({ error: 'projectId or nodeId is required' });
    // Checked before any file is read: a missing owner fails the documents
    // row's foreign key, and the per-file catch below then tried to record the
    // failure with the SAME foreign key — the second throw left the async
    // handler and the request was never answered.
    if (projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
        return res.status(404).json({ error: 'Project not found' });
    }
    if (nodeId && !db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(nodeId)) {
        return res.status(404).json({ error: 'Topic not found' });
    }

    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const results = [];
    for (const file of files) {
        const title = (file.originalname || 'file').slice(0, 500);
        try {
            // Extraction also validates the type (throws on disallowed/mismatched).
            const { text, kind, meta } = await extractText(file.buffer, file.originalname);
            const { hash, size } = vaultStorage.put(file.buffer);
            // The row, its chunks, the background index and (for a PDF) math
            // recovery — shared with a claim from the New project dialog.
            const { docId, chunkCount } = persistDocument({
                nodeId, projectId, title, text, kind, filename: file.originalname, hash, size, pageCount: meta.pageCount ?? null,
            });
            results.push({ ok: true, id: docId, title, file_type: kind, file_hash: hash, file_size: size, page_count: meta.pageCount ?? null, status: 'ready', chunks: chunkCount });
        } catch (err) {
            const r = db.prepare(`INSERT INTO documents
                (node_id, project_id, title, content, file_type, original_filename, status, error)
                VALUES (?, ?, ?, '', 'unknown', ?, 'failed', ?)`)
                .run(nodeId, projectId, title, file.originalname, String(err.message || 'Extraction failed').slice(0, 500));
            results.push({ ok: false, id: r.lastInsertRowid, title, status: 'failed', error: err.message || 'Extraction failed' });
        }
    }
    res.json({ documents: results });
}));

// Files dropped into the New project dialog, read before the project exists
// (server/stagedDocuments.js): an AI creation builds its outline from them, so
// they have to be extracted and mapped before its first model call. Each comes
// back with what the dialog shows — pages, characters, the contents found — or
// with why it cannot be used.
app.post('/api/documents/staged', handleVaultUpload, wrap(async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const documents = [];
    // Each file's language is read with the interface language as its hint,
    // exactly as the creation reads the files (stagedDocuments.js filesLanguage).
    const hint = getUiLanguage() || languageFromAcceptHeader(req.headers['accept-language']);
    for (const file of files) documents.push(await stageFile(file.buffer, file.originalname, Date.now(), { hint }));
    res.json({ documents });
}));

// "Create empty" with staged files: they go to the new project as they are.
app.post('/api/documents/staged/claim', (req, res) => {
    const projectId = Number(req.body?.projectId);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 100) : [];
    if (!projectId || !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
        return res.status(404).json({ error: 'Project not found' });
    }
    const claimed = claimStaged(ids, projectId);
    res.json({ documents: [...claimed].map(([stagedId, id]) => ({ stagedId, id })) });
});

app.delete('/api/documents/staged/:id', (req, res) => {
    res.json({ removed: discardStaged(req.params.id) });
});

app.get('/api/documents', (req, res) => {
    const { nodeId, projectId } = req.query;
    // char_count exposes how much text was extracted per file (shown in the vault
    // list, e.g. "12,340 chars"). LENGTH() counts characters on a TEXT column.
    let sql = `SELECT id, node_id, project_id, title, file_type, original_filename,
                      file_hash, file_size, status, error, page_count, embedding_status,
                      recovery_status, recovery_meta, created_at,
                      LENGTH(content) as char_count
               FROM documents`;
    const params = [];
    // Passing both scopes returns node-or-project docs (matches RAG retrieval, so
    // the tutor's "Use docs (N)" count includes the project vault); a single scope
    // filters to just that level.
    if (nodeId && projectId) { sql += ' WHERE (node_id = ? OR project_id = ?)'; params.push(nodeId, projectId); }
    else if (nodeId) { sql += ' WHERE node_id = ?'; params.push(nodeId); }
    else if (projectId) { sql += ' WHERE project_id = ?'; params.push(projectId); }
    sql += ' ORDER BY created_at DESC';
    const documents = db.prepare(sql).all(...params);
    res.json(documents);
});

// Return the full extracted text of one document, for the "view extracted text"
// preview in the vault. Capped so a huge file can't blow up the response.
app.get('/api/documents/:id/text', (req, res) => {
    const doc = db.prepare('SELECT title, content, status, error FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json({
        title: doc.title,
        status: doc.status,
        error: doc.error,
        char_count: doc.content ? doc.content.length : 0,
        content: doc.content || '',
    });
});

// Re-run math recovery for one PDF. Used after the user connects a vision model
// (recovery doesn't self-heal — a doc that fell back to OCR, or ran with no
// vision model, won't retry on its own). `force` bypasses the settings gate and
// the "already recovered" guard so this always re-reads the original.
app.post('/api/documents/:id/recover', (req, res) => {
    const doc = db.prepare('SELECT id, file_type, file_hash, status FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.file_type !== 'pdf') return res.status(400).json({ error: 'Math recovery only applies to PDFs' });
    if (!doc.file_hash) return res.status(400).json({ error: 'No original stored for this document' });
    // Same eligibility the vault UI applies: a doc whose extraction failed has no
    // text layer to improve on — re-upload is the fix, not recovery.
    if (doc.status === 'failed') return res.status(400).json({ error: 'Document extraction failed — re-upload it instead' });
    db.prepare('UPDATE documents SET recovery_status = ? WHERE id = ?').run('pending', doc.id);
    queueRecovery(doc.id, { force: true });
    res.json({ ok: true, recovery_status: 'pending' });
});

// Stream the stored original for "open original". Served inline so PDFs/images
// open in the browser; falls back to download for office formats.
app.get('/api/documents/:id/original', (req, res) => {
    const doc = db.prepare('SELECT title, file_type, file_hash, original_filename FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!doc.file_hash) return res.status(404).json({ error: 'No original stored for this document (text-only)' });
    let filePath;
    try {
        filePath = vaultStorage.pathFor(doc.file_hash);
    } catch {
        return res.status(404).json({ error: 'Original file is missing from the vault' });
    }
    // The same header trap as /api/media: a vault original stored under a
    // non-Latin-1 filename would have thrown here too.
    const inline = doc.file_type === 'pdf' || doc.file_type === 'text' || IMAGE_KINDS.includes(doc.file_type);
    res.setHeader('Content-Type', MIME_BY_KIND[doc.file_type] || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(doc.original_filename || doc.title, { inline }));
    fs.createReadStream(filePath).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
});

app.delete('/api/documents/:id', (req, res) => {
    const doc = db.prepare('SELECT id, file_hash FROM documents WHERE id = ?').get(req.params.id);
    const docs = doc ? [doc] : [];
    const chunkIds = documentChunkIds(docs);

    db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);

    freeDocumentAssets(docs, chunkIds);
    res.json({ success: true });
});

app.post('/api/documents/search', wrap(async (req, res) => {
    const { query, nodeId, projectId, limit = 5 } = req.body;
    const results = await searchDocuments(query, nodeId, projectId, limit);
    res.json(results);
}));

export const routes = app.takeRoutes();
