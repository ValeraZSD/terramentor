// /api/media and /api/media-descriptions: card media and their descriptions.
import db from '../database.js';
import { contentDisposition } from '../httpHeaders.js';
import { decidePaperVision } from '../paper.js';
import { findStagedMedia } from '../ankiImport.js';
import fs from 'node:fs';
import { mediaStorage } from '../vaultStorage.js';
import {
    cancelDescribeSweep, describeMedia, describeProgress, describeStats, startDescribeSweep,
} from '../mediaDescribe.js';
import { wrap } from './request.js';
import { routeTable } from './routeTable.js';

const app = routeTable('media');

// --- card media -----------------------------------------------------------
//
// Everything a card can show, served from the local blob store by the SHA-256
// of its own bytes. Three properties fall out of that and all three matter:
//
//   * the URL cannot address anything the database does not already know about
//     — the hash is looked up in `media_files` first, so a path can never be
//     crafted (the store validates the hex shape too, but a serving endpoint
//     should not be the only thing standing between a URL and the disk);
//   * the content type comes from the row, which was decided by SNIFFING the
//     bytes at import (`sniffMediaType`), never from the filename — an `.mp3`
//     that is really HTML must not be served as anything a browser will run;
//   * the bytes at a hash never change, so the response is immutable and the
//     browser stops asking. A deck with 4,000 clips is unusable otherwise.
//
// `Content-Disposition: inline` with a `nosniff` header keeps the browser from
// second-guessing the type on a file that came out of an untrusted zip.
const MEDIA_HASH_RE = /^[a-f0-9]{64}$/;

app.get('/api/media/:hash', (req, res) => {
    const hash = String(req.params.hash || '').replace(/\.[a-z0-9]+$/i, '');
    if (!MEDIA_HASH_RE.test(hash)) return res.status(400).json({ error: 'Bad media id' });

    // The registry first, then any live staging record — an import that has been
    // inspected but not committed has its bytes on disk and no row yet, and the
    // preview screen is exactly the moment those bytes need serving.
    const row = db.prepare('SELECT mime, kind, filename FROM media_files WHERE hash = ? LIMIT 1').get(hash)
        || findStagedMedia(hash);
    if (!row) return res.status(404).json({ error: 'No such media' });

    let filePath;
    try {
        filePath = mediaStorage.pathFor(hash);
    } catch {
        // The row survived and the bytes did not — the one state the orphan
        // sweep cannot produce, and worth saying plainly rather than 500ing.
        return res.status(404).json({ error: 'That file is missing from the media store.' });
    }
    res.setHeader('Content-Type', row.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', contentDisposition(row.filename || hash));
    fs.createReadStream(filePath)
        .on('error', () => { if (!res.headersSent) res.status(500).end(); })
        .pipe(res);
});

/** What is known ABOUT a file — the description the tutor and a screen reader read. */
app.get('/api/media/:hash/info', (req, res) => {
    const hash = String(req.params.hash || '');
    if (!MEDIA_HASH_RE.test(hash)) return res.status(400).json({ error: 'Bad media id' });
    const row = db.prepare(
        'SELECT hash, filename, mime, kind, size, description, described_by, project_id FROM media_files WHERE hash = ? LIMIT 1'
    ).get(hash);
    if (!row) return res.status(404).json({ error: 'No such media' });
    res.json(row);
});

// --- describing pictures --------------------------------------------------
//
// A card whose question is a photograph reads to the tutor as an empty card, and
// to a screen reader as a filename. One description fixes both, so it is stored
// on the file rather than generated per prompt. See server/mediaDescribe.js.

app.get('/api/media-descriptions/status', (req, res) => {
    const projectId = req.query.projectId ? Number(req.query.projectId) : null;
    res.json({ ...describeStats(projectId), ...describeProgress() });
});

app.post('/api/media/:hash/describe', wrap(async (req, res) => {
    const hash = String(req.params.hash || '');
    if (!MEDIA_HASH_RE.test(hash)) return res.status(400).json({ error: 'Bad media id' });
    const { use, model } = await decidePaperVision();
    if (use !== 'yes') {
        return res.status(503).json({ error: 'No verified vision model is available — set one in Settings → AI & Models.' });
    }
    const result = await describeMedia(hash, { force: !!req.body?.force, model });
    if (!result.ok) return res.status(422).json({ error: result.reason });
    res.json(result);
}));

app.post('/api/media-descriptions/run', wrap(async (req, res) => {
    const projectId = req.body?.projectId ? Number(req.body.projectId) : null;
    res.json(await startDescribeSweep(projectId));
}));

app.post('/api/media-descriptions/cancel', (req, res) => {
    cancelDescribeSweep();
    res.json({ ok: true });
});

export const routes = app.takeRoutes();
