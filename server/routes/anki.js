// /api/import/anki and /api/export/:projectId/anki: the Anki doors.
import db from '../database.js';
import { contentDisposition, headerJson } from '../httpHeaders.js';
import { logActivity } from '../activityLog.js';
import { scheduleNodeSync } from '../nodeEmbeddings.js';
import {
    buildPreview, commitImport, dropStaged, getStaged, parseApkg, stageImport, sweepOrphanMedia,
} from '../ankiImport.js';
import multer from 'multer';
import { mediaStorage } from '../vaultStorage.js';
import { buildProjectApkg } from '../ankiExport.js';
import { rejectOversizedBody } from '../uploadGuard.js';
import { routeTable } from './routeTable.js';

const app = routeTable('anki');

// --- Anki import (.apkg) --------------------------------------------------
//
// Two phases on purpose. `inspect` parses and reports; `commit` writes. Nothing
// touches the library until the learner has SEEN what the import will produce —
// which is the only way the one mistake this can make (a reversed front/back)
// gets caught before it becomes two thousand backwards cards.
//
// The upload is held only long enough to parse. What is staged afterwards is the
// extracted TEXT, never the zip, so a 300 MB deck full of audio does not sit in
// memory while somebody reads a preview.
const ankiUpload = multer({
    storage: multer.memoryStorage(),
    // Big enough for a real collection with media; media is not imported, but it
    // is inside the file we have to unzip to reach the collection.
    limits: { fileSize: 500 * 1024 * 1024 },
});

app.post('/api/import/anki/inspect', rejectOversizedBody(512 * 1024 * 1024), ankiUpload.single('deck'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    try {
        const parsed = await parseApkg(req.file.buffer, {
            importMedia: req.body?.importMedia !== 'false',
        });
        if (parsed.stats.cards === 0) {
            // An honest dead end rather than an empty project: say what was found
            // and why none of it could become a card.
            return res.status(400).json({
                error: parsed.stats.notes === 0
                    ? 'This deck is empty — it contains no notes.'
                    : `None of the ${parsed.stats.notes} notes in this deck could become a flashcard.`,
                stats: parsed.stats,
                warnings: parsed.warnings,
            });
        }
        const stagingId = stageImport(parsed);
        res.json({ stagingId, ...buildPreview(parsed) });
    } catch (err) {
        console.error('[Anki] inspect failed:', err);
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/import/anki/commit', (req, res) => {
    const { stagingId, projectName, swapFrontBack, keepSchedule, color, includeMedia } = req.body || {};
    const parsed = getStaged(stagingId);
    if (!parsed) {
        return res.status(410).json({ error: 'That import expired — upload the deck again.' });
    }
    try {
        const result = commitImport(parsed, {
            projectName,
            swapFrontBack: !!swapFrontBack,
            keepSchedule: keepSchedule !== false,
            includeMedia: includeMedia !== false,
            color,
        });
        dropStaged(stagingId);
        // Declining media leaves the extracted blobs unreferenced; reclaim now
        // rather than at the next restart.
        if (includeMedia === false) sweepOrphanMedia({ allowEmpty: true });
        scheduleNodeSync();   // map the imported deck into the topic space
        logActivity({
            area: 'deck',
            event: 'deck.imported',
            projectId: result?.projectId ?? result?.id ?? undefined,
            detail: `${result?.cards ?? '?'} card(s), ${result?.dropped ?? 0} dropped`,
        });
        res.json(result);
    } catch (err) {
        console.error('[Anki] commit failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Cancelling is explicit so a staged parse is released rather than waiting out
// its TTL.
app.delete('/api/import/anki/:stagingId', (req, res) => {
    dropStaged(req.params.stagingId);
    // Media is written to the blob store during inspect (so the preview costs no
    // memory), which means a cancelled import leaves exactly the bytes it
    // extracted and nothing pointing at them. Cancelling is the moment to
    // reclaim those — waiting for a restart would let a few abandoned attempts
    // at a 100 MB deck sit on disk indefinitely.
    const { removed, bytes } = sweepOrphanMedia({ allowEmpty: true });
    res.json({ success: true, mediaRemoved: removed, bytesFreed: bytes });
});

// --- Anki export (.apkg) - the exit door ----------------------------------
//
// The counterpart to the .apkg importer. A local-first app that says "your data
// is yours" and can only absorb collections has not said anything; this is the
// claim made checkable. Cards, their media and the intervals they have earned
// leave in the format the rest of the world reads. Mastery, placement and the
// curriculum's prose do NOT - Anki has nowhere to put them, and they leave
// through the JSON / .studyvault exporters that were built for them.
app.get('/api/export/:projectId/anki', async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Invalid project id' });
    try {
        const { zip, stats } = await buildProjectApkg({ db, mediaStorage }, projectId);
        if (!stats.notes) {
            // An empty .apkg is a valid archive and a useless download; say why
            // rather than handing over a file that imports as nothing.
            return res.status(404).json({ error: 'This project has no flashcards to export.' });
        }
        // Both headers go through `httpHeaders.js`: a header value is Latin-1,
        // so the project's own name 500s in either of them without encoding —
        // the disposition had been fixed for a Japanese deck and the stats had
        // not, which is what made a Russian course fail to export at all.
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition',
            contentDisposition(`${stats.project || 'deck'}.apkg`, { inline: false }));
        res.setHeader('X-Export-Stats', headerJson(stats));

        // Streamed, not buffered. A real deck's archive is ~108 MB and building
        // it in memory took this process to 687 MB and killed it. There is no
        // Content-Length as a result — the response is chunked, which every
        // client here already handles, and a download with no total is a far
        // better outcome than a server that dies mid-export.
        const stream = zip.generateNodeStream({ type: 'nodebuffer', compression: 'DEFLATE' });
        stream.on('error', (err) => {
            // Headers are already out, so there is no status left to send: log
            // it and cut the connection, which is what tells the client the
            // download is incomplete rather than handing over a truncated file
            // that looks whole.
            console.error('[ANKI EXPORT] stream', err);
            res.destroy(err);
        });
        res.on('close', () => { if (!res.writableEnded) stream.destroy(); });
        return stream.pipe(res);
    } catch (err) {
        console.error('[ANKI EXPORT]', err);
        return res.status(String(err?.message || '').startsWith('No such project') ? 404 : 500)
            .json({ error: err?.message || 'Export failed' });
    }
});

export const routes = app.takeRoutes();
