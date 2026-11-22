// Reading the course out of a .studyvault: its manifest, vetted by the same
// normalizer as the JSON door, and the card media it names. Shared by the
// import door (routes/bundle.js) and the course-update door
// (routes/courseUpdates.js), so a bundle is read one way whatever it is for.
import { isSupportedLanguage } from './language.js';
import { MAX_MEDIA_BYTES, storeMediaBuffer } from './ankiMedia.js';
import { readZipEntry } from './extract.js';
import { ImportError, normalizeImportProject, normalizeImportTree } from './curriculumSchema.js';
import { IMPORT_QUESTION_DEPS } from './courseFiles.js';
import { KeyedError, publicMessage } from './clientError.js';

/** A bundle refused for what is in it. The message is the answer and the
 *  status is always 400. */
export class BundleRefusal extends KeyedError {}

// What a refusal says about the error under it. A bundle is somebody else's
// file, so its manifest failing to parse is the bundle's fault and said so;
// any other error keeps the words of a check this code wrote, and a file
// system or database error becomes publicMessage's fixed sentence.
export const underlying = (e) => (e instanceof SyntaxError ? 'its manifest is not valid JSON' : publicMessage(e));

// A bundle legitimately packs many originals, so the per-file Office caps are
// too tight here — but it's still untrusted input that must be bounded.
export const BUNDLE_ZIP_LIMITS = { maxEntries: 20000, maxTotalBytes: 1024 * 1024 * 1024 };

/** The course itself, as one JSON document. A course of 150 topics with
 *  thousands of questions and cards is a few MB, so this is more than ten times
 *  the size of a very large course. */
const MAX_BUNDLE_MANIFEST_BYTES = 64 * 1024 * 1024;

/**
 * The manifest of an opened bundle, parsed and normalized.
 * @returns {Promise<{ manifest: object, project: object, nodes: object[], warnings: string[], cardCount: number, questionCount: number }>}
 */
export async function readBundleCourse(zip) {
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
        throw new BundleRefusal(`Invalid bundle: ${underlying(e)}`);
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

    // Exactly the same normalizer as POST /api/import. These two paths had
    // drifted into different opinions about the same file — the bundle clamped
    // an unknown status where the JSON path rejected it, and neither looked at a
    // resource URL — even though a bundle is the *more* likely thing to have
    // been handed to you by a stranger.
    try {
        const header = normalizeImportProject(manifest.project, { isSupportedLanguage });
        const tree = normalizeImportTree(manifest.nodes || [], IMPORT_QUESTION_DEPS);
        return {
            manifest, project: header.project, nodes: tree.nodes, cardCount: tree.cardCount, questionCount: tree.questionCount,
            warnings: [...header.warnings, ...tree.warnings],
        };
    } catch (err) {
        if (err instanceof ImportError) throw new BundleRefusal(`Invalid bundle: ${err.message}`);
        throw err;
    }
}

/**
 * The cards' media, the same way the Anki door takes it: only the files the
 * cards actually NAME are read, the type comes from the bytes and never the
 * extension, and the stored key is the true content hash. Blobs go to disk
 * before the caller's transaction — a row is what makes one referenced, so a
 * failed write leaves orphans the startup sweep gives back.
 *
 * @param {(bytes: number) => void} charge  counts inflated bytes against the bundle's budget
 * @returns {Promise<Map<string, object>>}  file name -> stored media
 */
export async function restoreCardMedia(zip, nodes, charge, warnings) {
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
        throw new BundleRefusal(`Failed to restore card media: ${underlying(e)}`);
    }
    if (mediaSkipped.length) {
        const missing = mediaSkipped.filter(m => m.reason === 'missing').length;
        const refused = mediaSkipped.length - missing;
        if (missing) warnings.push(`${missing} card media file(s) named by the course are not in the bundle — those cards were imported without them.`);
        if (refused) warnings.push(`${refused} card media file(s) were refused (not a supported image or audio type, or too large) — those cards were imported without them.`);
    }
    return mediaByName;
}
