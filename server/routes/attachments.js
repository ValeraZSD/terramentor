// /api/ai/attachments: files attached to the assistant chat
// (server/chatAttachments.js) — upload, status, remove, and the original.
import fs from 'node:fs';
import multer from 'multer';
import vaultStorage from '../vaultStorage.js';
import { contentDisposition } from '../httpHeaders.js';
import { rejectOversizedBody } from '../uploadGuard.js';
import {
    ATTACH_BODY_CAP, ATTACH_MAX_BYTES, ATTACH_MAX_FILES, attachmentSummary, chatModelSees, discardAttachment, getAttachment,
    stageAttachment,
} from '../chatAttachments.js';
import { wrap } from './request.js';
import { routeTable } from './routeTable.js';

const app = routeTable('attachments');

// Buffered in memory (typed and hashed at once, then stored), capped per file
// and per request; the whole body is capped on Content-Length first.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: ATTACH_MAX_BYTES, files: ATTACH_MAX_FILES },
});

const handleUpload = (req, res, next) =>
    rejectOversizedBody(ATTACH_BODY_CAP)(req, res, () =>
        upload.array('files')(req, res, (err) => {
            if (!err) return next();
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: `A file is larger than ${Math.round(ATTACH_MAX_BYTES / 1024 / 1024)} MB.`, reason: 'too_large' });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ error: `Attach at most ${ATTACH_MAX_FILES} files at a time.`, reason: 'too_many' });
            }
            return res.status(400).json({ error: err.message || 'Upload failed' });
        }));

app.post('/api/ai/attachments', handleUpload, wrap(async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
    const attachments = [];
    for (const f of files) {
        // One file that breaks (a full disk, a failed write) is that file's
        // refusal: the files before it are stored, and the client must get
        // their ids or they sit unseen until the day's sweep.
        try {
            attachments.push(await stageAttachment(f.buffer, f.originalname));
        } catch (e) {
            console.error('[attachments] could not store a file:', e.message);
            attachments.push({ ok: false, name: String(f.originalname || 'file').slice(0, 200), reason: 'unreadable', error: 'The app could not store this file.' });
        }
    }
    // Said at once, beside a picture: a model known not to see would get its
    // name and nothing else, and the composer warns before anything is sent.
    const modelSees = attachments.some(a => a.ok && a.kind === 'image') ? await chatModelSees() : null;
    res.json({ attachments, modelSees });
}));

app.get('/api/ai/attachments/:id', (req, res) => {
    const row = getAttachment(req.params.id);
    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    res.json(attachmentSummary(row));
});

app.delete('/api/ai/attachments/:id', (req, res) => {
    const removed = discardAttachment(req.params.id);
    if (removed === null) return res.status(404).json({ error: 'Attachment not found' });
    if (removed === false) return res.status(409).json({ error: 'This file was sent with a message; it goes when its conversation is deleted.' });
    res.json({ removed: true });
});

// The original, by what its bytes are. A picture (typed by its magic number at
// upload) is shown inline; everything else, an SVG included, is a download of
// what it is, under a sandbox, so nothing from a chat can run on this origin.
app.get('/api/ai/attachments/:id/file', (req, res) => {
    const row = getAttachment(req.params.id);
    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    let filePath;
    try {
        filePath = vaultStorage.pathFor(row.file_hash);
    } catch {
        return res.status(404).json({ error: 'The file is missing from storage' });
    }
    const picture = row.kind === 'image' && row.mime;
    const DOC_TYPES = {
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    res.setHeader('Content-Type', picture ? row.mime : (DOC_TYPES[row.file_type] || 'text/plain; charset=utf-8'));
    res.setHeader('Content-Disposition', contentDisposition(row.name, { inline: !!picture }));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(filePath).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
});

export const routes = app.takeRoutes();
