// The .studyvault bundle: one project or the whole library, out and in.
import db from '../database.js';
import { contentDisposition } from '../httpHeaders.js';
import { chunkText } from '../ai.js';
import { isSupportedLanguage } from '../language.js';
import { logActivity } from '../activityLog.js';
import { indexDocument } from '../embeddings.js';
import { scheduleNodeSync } from '../nodeEmbeddings.js';
import { MAX_MEDIA_BYTES, storeMediaBuffer } from '../ankiMedia.js';
import { projectTeaches, setProjectTeaches } from '../nodeRole.js';
import multer from 'multer';
import fs from 'node:fs';
import JSZip from 'jszip';
import vaultStorage, { mediaStorage } from '../vaultStorage.js';
import { assertZipSafe, extractText, MAX_FILE_BYTES, readZipEntry } from '../extract.js';
import { LIBRARY_MANIFEST, parseLibraryManifest } from '../libraryArchive.js';
import { queueRecovery } from '../pdfRecovery.js';
import { ImportError, normalizeImportProject, normalizeImportTree } from '../curriculumSchema.js';
import { rejectOversizedBody } from '../uploadGuard.js';
import {
    applyImportedCardDial, claimUuid, exportedFlashcards, exportedQuestions, IMPORT_QUESTION_DEPS,
    insertImportedTree, newPerDaySetting, projectMediaNames,
} from '../courseFiles.js';
import { wrap } from './request.js';
import { nextProjectPosition } from './projectRows.js';
import { routeTable } from './routeTable.js';

const app = routeTable('bundle');

// --- Vault-aware bundle export/import (.studyvault) -----------------------
// A bundle is a zip: manifest.json (project + node tree + documents metadata +
// extracted text) plus blobs/<sha256> originals. This is the portable, shareable
// artifact — the same shape a future marketplace "publish" would ship. The plain
// JSON export/import (routes/importExport.js) stays for the lightweight,
// files-free case.
const bundleUpload = multer({
    storage: multer.memoryStorage(),
    // A library archive is its bundles side by side, so the upload may be as big
    // as MAX_LIBRARY_UPLOAD_BYTES; a LONE bundle keeps its 200 MB (a bundle holds
    // many originals), enforced once the archive says which it is.
    limits: { fileSize: 1024 * 1024 * 1024 },
});

// A bundle legitimately packs many originals, so the per-file Office caps are
// too tight here — but it's still untrusted input that must be bounded.
const BUNDLE_ZIP_LIMITS = { maxEntries: 20000, maxTotalBytes: 1024 * 1024 * 1024 };

/** The course itself, as one JSON document. The largest real one measured here
 *  — 150 topics, 4,302 questions, 3,126 cards — is 4.07 MB, so this is fifteen
 *  times the biggest course anybody has actually shipped through this door. */
const MAX_BUNDLE_MANIFEST_BYTES = 64 * 1024 * 1024;
/** One vault original inside a bundle. Nothing can legitimately be bigger than
 *  `MAX_FILE_BYTES` — that is the cap every vault upload passed on its way in —
 *  and the ceiling is twice it so a bundle written by another build is not
 *  refused over a file this importer would have kept. */
const MAX_BUNDLE_BLOB_BYTES = 2 * MAX_FILE_BYTES;

/**
 * One project as a `.studyvault`, built but not yet generated. The ONE builder,
 * behind the single-project export route below.
 *
 * Same opt-in contract as the plain JSON export: the artifact's own comment
 * calls it "the shape a future marketplace publish would ship", so private
 * `notes` are as opt-in here as there — off unless asked, the curriculum always
 * ships. Resources default ON (a bundle always carried them).
 *
 * A project that is still being written by the AI exports the rows it has at
 * this instant: the reads below are synchronous, so the snapshot is consistent,
 * and what arrives later is simply not in it.
 *
 * @returns {{ zip: JSZip, project: object } | null}  null when there is no such project
 */
function buildBundleZip(projectId, { includeNotes = false, includeProgress = false, includeResources = true } = {}) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return null;

    const allNodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY position').all(projectId);
    const nodeById = new Map(allNodes.map(n => [n.id, n]));
    const media = projectMediaNames(projectId);
    const pathOf = (nodeId) => {
        const titles = [];
        let cur = nodeById.get(nodeId);
        while (cur) { titles.unshift(cur.title); cur = cur.parent_id ? nodeById.get(cur.parent_id) : null; }
        return titles;
    };

    const buildTree = (parentId) => allNodes.filter(n => n.parent_id === parentId).map(n => {
        const node = {
            title: n.title,
            uuid: n.uuid || undefined,
            description: n.description || undefined,
            notes: includeNotes && n.notes ? n.notes : undefined,
            status: includeProgress ? n.status : undefined,
            is_note: n.is_note ? true : undefined,
            role: n.role && n.role !== 'topic' ? n.role : undefined,
            questions: exportedQuestions(n.id),
            flashcards: exportedFlashcards(n.id, media.names),
        };
        const resources = includeResources
            ? db.prepare('SELECT uuid, title, url, type, completed FROM resources WHERE node_id = ? ORDER BY position').all(n.id)
            : [];
        if (resources.length) {
            node.resources = resources.map(r => {
                const out = { title: r.title };
                if (r.uuid) out.uuid = r.uuid;
                if (r.url) out.url = r.url;
                if (r.type && r.type !== 'link') out.type = r.type;
                if (includeProgress && r.completed) out.completed = true;
                return out;
            });
        }
        const children = buildTree(n.id);
        if (children.length) node.children = children;
        Object.keys(node).forEach(k => { if (node[k] === undefined) delete node[k]; });
        return node;
    });

    // A document whose upload failed has no text and no original: in a shared
    // course it would arrive as a broken row on someone else's machine.
    const docs = db.prepare(`SELECT * FROM documents
        WHERE (project_id = ? OR node_id IN (SELECT id FROM nodes WHERE project_id = ?))
          AND COALESCE(status, 'ready') != 'failed'`).all(projectId, projectId);

    try {
        const zip = new JSZip();
        const manifestDocs = [];
        for (const d of docs) {
            manifestDocs.push({
                title: d.title,
                file_type: d.file_type,
                original_filename: d.original_filename || undefined,
                file_hash: d.file_hash || undefined,
                file_size: d.file_size || undefined,
                page_count: d.page_count || undefined,
                status: d.status,
                content: d.content || '',
                // The topic's uuid is its identity; the title path stays for older
                // readers and is only a fallback, because two sibling topics may
                // share a title.
                node_uuid: d.node_id ? (nodeById.get(d.node_id)?.uuid || undefined) : undefined,
                node_path: d.node_id ? pathOf(d.node_id) : undefined,
            });
            if (d.file_hash && vaultStorage.exists(d.file_hash)) {
                // A read stream, not the bytes: a vault of originals is the same
                // shape of load the Anki export was killed by (687 MB peak), and
                // buffering them here holds every original AND JSZip's copy.
                zip.file(`blobs/${d.file_hash}`, fs.createReadStream(vaultStorage.pathFor(d.file_hash)));
            }
        }
        // The cards' clips and pictures ride under media/<name>, streamed like
        // the originals above: a listening course is tens of megabytes of
        // audio, and buffering it would hold every clip and JSZip's copy.
        for (const m of media.rows) {
            zip.file(`media/${media.names.get(m.hash)}`, fs.createReadStream(mediaStorage.pathFor(m.hash)));
        }
        const manifest = {
            exported_at: new Date().toISOString(),
            project: {
                name: project.name,
                uuid: project.uuid || undefined,
                version: project.version || undefined,
                description: project.description || undefined,
                color: project.color,
                icon: project.icon,
                content_language: project.content_language || undefined,
                learning_language: project.learning_language || undefined,
                new_per_day: newPerDaySetting(projectId),
                teaches: projectTeaches(projectId),
            },
            nodes: buildTree(null),
            documents: manifestDocs,
        };
        zip.file('manifest.json', JSON.stringify(manifest, null, 2));
        return { zip, project };
    } catch (err) {
        console.error('[Bundle export] Error:', err);
        throw new Error(`Failed to build bundle: ${err.message}`);
    }
}

/** What the two bundle doors read off the query: the same three switches, and
 *  only the literal `true` (or, for resources, the literal `false`) moves one. */
function bundleOptionsFrom(query) {
    return {
        includeNotes: query.includeNotes === 'true',
        includeProgress: query.includeProgress === 'true',
        includeResources: query.includeResources !== 'false',
    };
}

/** Pipe a generated archive to the response as a download, streamed and with no
 *  Content-Length: a chunked download with no total beats a server that dies
 *  holding three copies of the same originals. */
function sendArchive(res, stream, { filename } = {}) {
    // The same RFC 5987 pair as the Anki export: the old sanitiser collapsed
    // every non-ASCII run to one `_`, so a Russian course downloaded as
    // `_.studyvault` — never an error, just a file nobody can tell apart
    // from the next one. The real name rides in `filename*`.
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(filename, { inline: false }));
    stream.on('error', (err) => {
        // Headers are out, so there is no status left to send: log and cut
        // the connection, which tells the client the download is incomplete
        // rather than handing over a truncated file that looks whole.
        console.error('[Bundle export] stream', err);
        res.destroy(err);
    });
    res.on('close', () => {
        if (!res.writableEnded) stream.destroy();
    });
    return stream.pipe(res);
}

app.get('/api/export/:projectId/bundle', async (req, res) => {
    let built;
    try { built = buildBundleZip(req.params.projectId, bundleOptionsFrom(req.query)); }
    catch (err) { return res.status(500).json({ error: err.message }); }
    if (!built) return res.status(404).json({ error: 'Project not found' });
    return sendArchive(res, built.zip.generateNodeStream({ type: 'nodebuffer', compression: 'DEFLATE' }),
        { filename: `${built.project.name || 'project'}.studyvault` });
});

/** A bundle (or library) refused for what is in it. The message is the answer
 *  and the status is always 400, so it is thrown rather than written to `res`:
 *  the importer below is now called once per project of a library, where a
 *  refusal is one project's entry in a report and not the whole response. */
class BundleRefusal extends Error {}

/**
 * Import ONE already-opened bundle as a new project. The only bundle parser:
 * the single-file door and every entry of a library archive come through here,
 * so a course is vetted, bounded and restored by the same code either way.
 *
 * @param {JSZip} zip  opened and passed `assertZipSafe` by the caller
 * @param {{ spent?: { bytes: number }, limit?: number }} [budget]  inflated bytes
 *   charged so far and the ceiling they may reach. A library shares ONE `spent`
 *   across its projects, so the ceiling bounds the whole archive and not just
 *   each entry; alone, a bundle gets its own.
 */
async function importBundleZip(zip, { spent = { bytes: 0 }, limit = BUNDLE_ZIP_LIMITS.maxTotalBytes } = {}) {
    let manifest;
    try {
        // A .studyvault is untrusted input (the marketplace's whole point is
        // sharing them). `assertZipSafe` reads the archive's own declared sizes,
        // which its author wrote, so it is a pre-filter and not the bound: every
        // entry below is read through `readZipEntry`, which stops inflating at a
        // ceiling instead of measuring what arrived.
        const raw = await readZipEntry(zip, 'manifest.json', { cap: MAX_BUNDLE_MANIFEST_BYTES, what: 'This bundle' });
        if (!raw) throw new BundleRefusal('Invalid bundle: missing manifest.json');
        manifest = JSON.parse(raw.toString('utf8'));
    } catch (e) {
        if (e instanceof BundleRefusal) throw e;
        throw new BundleRefusal(`Invalid bundle: ${e.message}`);
    }

    // Valid JSON is not yet a manifest: `null`, a list, a number or a string
    // all parse, and `null` threw on the destructuring below.
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new BundleRefusal('Invalid bundle: manifest.json must hold an object');
    }
    for (const key of ['documents', 'nodes']) {
        if (manifest[key] != null && !Array.isArray(manifest[key])) {
            throw new BundleRefusal(`Invalid bundle: "${key}" in manifest.json must be a list`);
        }
    }

    const { documents } = manifest;

    // Exactly the same normalizer as POST /api/import. These two paths had
    // drifted into different opinions about the same file — the bundle clamped
    // an unknown status where the JSON path rejected it, and neither looked at a
    // resource URL — even though a bundle is the *more* likely thing to have
    // been handed to you by a stranger.
    let project, nodes, warnings, cardCount = 0, questionCount = 0;
    try {
        const header = normalizeImportProject(manifest.project, { isSupportedLanguage });
        const tree = normalizeImportTree(manifest.nodes || [], IMPORT_QUESTION_DEPS);
        project = header.project;
        nodes = tree.nodes;
        cardCount = tree.cardCount;
        questionCount = tree.questionCount;
        warnings = [...header.warnings, ...tree.warnings];
    } catch (err) {
        if (err instanceof ImportError) throw new BundleRefusal(`Invalid bundle: ${err.message}`);
        throw err;
    }

    const twin = project.uuid ? db.prepare('SELECT id, name, version FROM projects WHERE uuid = ?').get(project.uuid) : null;
    if (twin) {
        const editions = project.version && twin.version && project.version !== twin.version
            ? ` (you have ${twin.version}, this bundle is ${project.version})`
            : '';
        warnings.push(`You already have this course as "${twin.name}"${editions} — it was imported as a separate copy.`);
    }

    // Restore originals into the (deduped) blob store BEFORE the DB transaction.
    // We re-hash each blob and trust the bytes — the stored key is always the
    // true content hash, so a tampered manifest hash can't poison the store.
    const restoredHash = new Map();  // manifestHash -> actualHash
    const reExtracted = new Map();    // actualHash -> freshly re-extracted text
    // What this bundle has actually cost so far, in inflated bytes. The
    // declared-size check above promises the archive expands to no more than
    // `maxTotalBytes`; charging the same budget with bytes that really arrived
    // is what turns that promise into one the archive's author cannot write
    // their way out of. An honest bundle that passed the declared check passes
    // this by construction.
    const charge = (n) => {
        spent.bytes += n;
        if (spent.bytes > limit) {
            throw new Error(`this bundle expands to more than ${Math.round(limit / 1024 / 1024)} MB and is being refused as a compression bomb`);
        }
    };
    try {
        for (const d of (documents || [])) {
            if (!d.file_hash || restoredHash.has(d.file_hash)) continue;
            const buf = await readZipEntry(zip, `blobs/${d.file_hash}`, { cap: MAX_BUNDLE_BLOB_BYTES, what: 'This bundle' });
            if (!buf) continue; // text-only / original not included
            charge(buf.length);
            const { hash } = vaultStorage.put(buf);
            restoredHash.set(d.file_hash, hash);
            // Don't trust the publisher's extracted text — re-extract from the
            // actual bytes (also re-runs type + zip-bomb validation). On failure
            // we fall back to the manifest's content below.
            if (buf.length <= MAX_FILE_BYTES) {
                try {
                    const { text } = await extractText(buf, d.original_filename || d.title || '');
                    reExtracted.set(hash, text);
                } catch { /* keep manifest content as fallback */ }
            }
        }
    } catch (e) {
        throw new BundleRefusal(`Failed to restore vault files: ${e.message}`);
    }

    // The cards' media, the same way the Anki door takes it: only the files
    // the cards actually NAME are read, the type comes from the bytes and never
    // the extension, and the stored key is the true content hash. Blobs go to
    // disk before the transaction — a row is what makes one referenced, and
    // the rows are written inside it, so a failed import leaves orphans the
    // startup sweep gives back.
    const mediaByName = new Map();
    const mediaSkipped = [];
    try {
        const wanted = new Set();
        const collect = (list) => list.forEach(n => {
            for (const c of n.flashcards) for (const side of ['front', 'back']) for (const m of c.media?.[side] || []) wanted.add(m.name);
            collect(n.children);
        });
        collect(nodes);
        let mediaBytes = 0;
        let done = 0;
        for (const name of wanted) {
            // The same ceiling `storeMediaBuffer` applies, moved to where the
            // bytes are produced: the cap it enforces is now reached by a file
            // already known to fit.
            let buf;
            try {
                buf = await readZipEntry(zip, `media/${name}`, { cap: MAX_MEDIA_BYTES, what: 'This bundle' });
            } catch (err) {
                if (!err?.tooLarge) throw err;
                mediaSkipped.push({ name, reason: 'refused' });
                continue;
            }
            if (!buf) { mediaSkipped.push({ name, reason: 'missing' }); continue; }
            charge(buf.length);
            const stored = storeMediaBuffer(buf, { budgetUsed: mediaBytes });
            if (stored.reason) { mediaSkipped.push({ name, reason: stored.reason }); continue; }
            mediaBytes += stored.size;
            mediaByName.set(name, { ...stored, filename: name });
            if (++done % 25 === 0) await new Promise(r => setImmediate(r));
        }
    } catch (e) {
        throw new BundleRefusal(`Failed to restore card media: ${e.message}`);
    }
    if (mediaSkipped.length) {
        const missing = mediaSkipped.filter(m => m.reason === 'missing').length;
        const refused = mediaSkipped.length - missing;
        if (missing) warnings.push(`${missing} card media file(s) named by the course are not in the bundle — those cards were imported without them.`);
        if (refused) warnings.push(`${refused} card media file(s) were refused (not a supported image or audio type, or too large) — those cards were imported without them.`);
    }

    try {
        const pathKey = (titles) => (titles || []).join('\u0000');
        const newNodeIdByPath = new Map();
        // A title path is not an identity: two sibling topics may share a title.
        // So a document finds its topic by the uuid the bundle recorded, and a
        // path is used only when it names exactly one topic.
        const newNodeIdByFileUuid = new Map();
        const ambiguousPaths = new Set();
        let docsAtProjectLevel = 0;
        const importedDocIds = [];
        const importedPdfIds = [];

        const result = db.transaction(() => {
            const projectResult = db.prepare(`
                INSERT INTO projects (name, description, color, icon, position, content_language, learning_language, version, uuid)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(project.name, project.description, project.color, project.icon, nextProjectPosition(),
                project.content_language, project.learning_language, project.version, claimUuid('projects', project.uuid));
            const newProjectId = projectResult.lastInsertRowid;

            const insertMedia = db.prepare(`
                INSERT OR IGNORE INTO media_files (project_id, hash, filename, mime, kind, size, description, described_by)
                VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
            `);
            for (const m of mediaByName.values()) insertMedia.run(newProjectId, m.hash, m.filename, m.mime, m.kind, m.size);

            insertImportedTree(newProjectId, nodes, (node, newNodeId, path) => {
                const key = pathKey(path);
                if (newNodeIdByPath.has(key)) ambiguousPaths.add(key);
                newNodeIdByPath.set(key, newNodeId);
                if (typeof node?.uuid === 'string' && node.uuid) newNodeIdByFileUuid.set(node.uuid, newNodeId);
            }, { mediaByName });
            applyImportedCardDial(newProjectId, project, cardCount);
            if (typeof project.teaches === 'boolean') setProjectTeaches(newProjectId, project.teaches);

            const insertChunk = db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)');
            for (const d of (documents || [])) {
                // Re-link to its topic by uuid; else by a title path that names one
                // topic only; else keep it at project level and say so.
                let nodeId = null;
                if (typeof d.node_uuid === 'string' && newNodeIdByFileUuid.has(d.node_uuid)) {
                    nodeId = newNodeIdByFileUuid.get(d.node_uuid);
                } else if (Array.isArray(d.node_path) && d.node_path.length) {
                    const key = pathKey(d.node_path);
                    if (ambiguousPaths.has(key)) docsAtProjectLevel++;
                    else nodeId = newNodeIdByPath.get(key) || null;
                }
                const realHash = d.file_hash ? (restoredHash.get(d.file_hash) || null) : null;
                const content = (realHash && reExtracted.has(realHash))
                    ? reExtracted.get(realHash)
                    : (typeof d.content === 'string' ? d.content : '');
                const docRes = db.prepare(`INSERT INTO documents
                    (node_id, project_id, title, content, file_type, original_filename, file_hash, file_size, status, page_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(nodeId, nodeId ? null : newProjectId, (d.title || 'document').substring(0, 500), content, d.file_type || 'text', d.original_filename || null, realHash, d.file_size || null, d.status || 'ready', d.page_count || null);
                const docId = docRes.lastInsertRowid;
                if (content) { chunkText(content).forEach((c, i) => insertChunk.run(docId, i, c)); importedDocIds.push(docId); }
                if ((d.file_type || 'text') === 'pdf' && realHash) importedPdfIds.push(docId);
            }
            return newProjectId;
        })();
        if (docsAtProjectLevel) {
            warnings.push(`${docsAtProjectLevel} document(s) belonged to a topic whose title path is shared by another topic, so they were kept at project level rather than guessed onto one of them.`);
        }

        // Semantic-index the restored documents in the background (after commit).
        importedDocIds.forEach(id => indexDocument(id));
        // ...and the restored curriculum, so a shared course joins the atlas.
        scheduleNodeSync();
        // Re-read any math dropped by a restored PDF's text layer (no-op if clean
        // or if recovery is off) — the blob was restored above, so it's available.
        importedPdfIds.forEach(id => queueRecovery(id));

        const newProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(result);
        console.log(`Imported bundle "${newProject.name}" (id ${result}) with ${(documents || []).length} document(s)${cardCount ? `, ${cardCount} card(s), ${mediaByName.size} media file(s)` : ''}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
        logActivity({
            area: 'project',
            event: 'project.imported',
            projectId: result,
            level: warnings.length ? 'warn' : 'info',
            detail: `bundle · ${(documents || []).length} document(s) · ${cardCount} card(s) · ${mediaByName.size} media file(s) · ${warnings.length} warning(s)`,
        });
        return { ...newProject, questionCount, cardCount, mediaCount: mediaByName.size, warnings };
    } catch (err) {
        console.error('Bundle import error:', err);
        throw new BundleRefusal(`Database error: ${err.message}`);
    }
}

/** A single bundle's compressed size. The upload itself may be larger now (a
 *  library), so the cap a lone bundle always had is enforced here instead. */
const MAX_BUNDLE_UPLOAD_BYTES = 200 * 1024 * 1024;
/** A library archive's upload: its bundles, stored, side by side. */
const MAX_LIBRARY_UPLOAD_BYTES = 1024 * 1024 * 1024;
/** What every bundle in one library may inflate to, together. A single bundle
 *  keeps its own 1 GiB; this is the same guarantee for the archive as a whole. */
const LIBRARY_INFLATE_LIMIT = 4 * 1024 * 1024 * 1024;

/**
 * Import a library archive (`server/libraryArchive.js`): each project it lists
 * goes through `importBundleZip`, one at a time, and one that fails is reported
 * beside the ones that did not. Only what the manifest names is ever opened.
 */
async function importLibraryZip(zip) {
    let listed;
    try {
        const raw = await readZipEntry(zip, LIBRARY_MANIFEST, { cap: 4 * 1024 * 1024, what: 'This library' });
        listed = parseLibraryManifest(raw);
    } catch (e) {
        throw new BundleRefusal(`Invalid library: ${e.message}`);
    }
    if (!listed.length) throw new BundleRefusal('Invalid library: it lists no projects');

    const spent = { bytes: 0 };
    const imported = [];
    const failed = [];
    for (const entry of listed) {
        try {
            const inner = await readZipEntry(zip, entry.file, { cap: MAX_BUNDLE_UPLOAD_BYTES, what: 'This library' });
            if (!inner) throw new BundleRefusal('it is listed in the library but not in the archive');
            const innerZip = await JSZip.loadAsync(inner);
            assertZipSafe(innerZip, BUNDLE_ZIP_LIMITS);
            imported.push(await importBundleZip(innerZip, { spent, limit: LIBRARY_INFLATE_LIMIT }));
        } catch (e) {
            failed.push({ name: entry.name, error: e.message });
        }
    }
    if (!imported.length) {
        throw new BundleRefusal(`Nothing in this library could be imported: ${failed.map(f => `${f.name}: ${f.error}`).join('; ')}`);
    }

    // The same `warnings` field a lone bundle answers with, so a screen that only
    // knows about one project still says everything there is to say.
    const warnings = [];
    if (failed.length) {
        warnings.push(`${imported.length} of ${listed.length} projects were imported.`);
        for (const f of failed) warnings.push(`"${f.name}" was not imported: ${f.error}`);
    }
    for (const p of imported) for (const w of p.warnings || []) warnings.push(`"${p.name}": ${w}`);
    console.log(`Imported library: ${imported.length} of ${listed.length} project(s)${failed.length ? `, ${failed.length} failed` : ''}`);
    return {
        ...imported[0],
        library: true,
        imported: imported.map(p => ({ id: p.id, name: p.name, questionCount: p.questionCount, cardCount: p.cardCount, mediaCount: p.mediaCount, warnings: p.warnings })),
        failed,
        warnings,
    };
}

// Through `wrap`: a throw nothing below expected used to leave the upload
// unanswered until the client gave up, instead of reaching the JSON 500.
//
// ONE door for both shapes of `.studyvault`: a course (manifest.json) and a
// whole library (library.json + one course per project, as earlier builds
// exported it). A library is told
// apart by what the archive holds, never by its name, so every screen that
// takes a `.studyvault` takes both without knowing the difference.
app.post('/api/import/bundle', rejectOversizedBody(MAX_LIBRARY_UPLOAD_BYTES + 8 * 1024 * 1024), bundleUpload.single('bundle'), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No bundle uploaded' });
    try {
        let zip;
        try {
            zip = await JSZip.loadAsync(req.file.buffer);
            assertZipSafe(zip, BUNDLE_ZIP_LIMITS);
        } catch (e) {
            throw new BundleRefusal(`Invalid bundle: ${e.message}`);
        }
        if (!zip.file('manifest.json') && zip.file(LIBRARY_MANIFEST)) return res.json(await importLibraryZip(zip));
        if (req.file.size > MAX_BUNDLE_UPLOAD_BYTES) {
            throw new BundleRefusal(`Invalid bundle: a bundle may be at most ${MAX_BUNDLE_UPLOAD_BYTES / 1024 / 1024} MB`);
        }
        return res.json(await importBundleZip(zip));
    } catch (err) {
        if (err instanceof BundleRefusal) return res.status(400).json({ error: err.message });
        throw err;
    }
}));

export const routes = app.takeRoutes();
