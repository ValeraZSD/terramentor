// server/ankiMedia.js — the pictures and the sound.
//
// A vocabulary deck without its images is a vocabulary deck with the answer
// removed; a listening deck without its audio is not a deck at all. The first
// version of the importer counted media and told the learner honestly that it
// was being dropped, which was the right thing to ship while the plumbing did
// not exist. This is the plumbing.
//
// ## Trap 5: the media index changed format too, and it changed twice
//
// The four traps in `ankiImport.js` are all about the collection. The media
// side has its own, and it is the same shape — a familiar filename holding an
// unfamiliar format:
//
//   * **Legacy (.apkg v1/v2)** — the zip entry `media` is JSON: `{"0":"cat.jpg",
//     "1":"neko.mp3"}`, mapping a numbered zip entry to its real filename. The
//     numbered entries are stored uncompressed.
//   * **Current (.apkg v3, the one that ships `collection.anki21b`)** — `media`
//     is a **zstd-compressed protobuf**, and every numbered entry is **zstd
//     -compressed individually**. Read it as JSON and you get a parse error;
//     read entry `0` as a JPEG and you get 4 KB of noise starting `28 b5 2f fd`.
//
// Verified against a real 108 MB export: 4358 zip entries, `media`
// 223 KB compressed / 301 KB of protobuf, entry `0` a zstd frame wrapping an
// MP3 (`ID3`). Both formats are current in the wild — a deck exported from an
// older Anki, or re-exported by someone who never upgraded, is legacy.
//
// The protobuf is `MediaEntries { repeated MediaEntry entries = 1 }` with
// `MediaEntry { string name = 1; uint32 size = 2; bytes sha1 = 3; }`, and the
// Nth entry describes the zip file named `N`. It is decoded here by hand rather
// than by adding a protobuf dependency: three fields with fixed wire types is
// less code than the schema file would be, and it cannot drift, because the
// only thing this reads is `name` — `size` and `sha1` describe bytes we already
// have and can hash ourselves.
//
// ## What is trusted, and what is not
//
// An .apkg is a zip from the internet, so everything here is bounded:
//   * the declared filename is used ONLY for its extension and for display; it
//     never reaches the filesystem, because blobs are stored under the SHA-256
//     of their own bytes (`mediaStorage`),
//   * the type is decided by SNIFFING the magic bytes, never by the extension —
//     an `.mp3` that is really an HTML file must not be served as audio,
//   * anything that is not a recognised image or audio format is dropped and
//     counted, and
//   * per-file and per-deck caps bound what one import can write to disk.

import { zstdDecompressSync } from './zstd.js';
import { readZipEntry } from './extract.js';
import { mediaStorage } from './vaultStorage.js';

/** One file bigger than this is skipped — no still image or audio clip on a
 *  flashcard is 40 MB, so this can only be something that is not what it says.
 *  It is also the ceiling every media entry is INFLATED under: the cap used to
 *  be read off an already-decompressed buffer, which is a cap applied after the
 *  memory it was protecting had been spent. */
export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
/** Total written by one import. A deck is content, not a backup target. */
export const MAX_MEDIA_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
/** The media INDEX — the list of filenames, not the files. Measured on a real
 *  108 MB export: 4,358 entries in 301 KB of protobuf, about 70 bytes an entry.
 *  32 MB is room for half a million files and still a bound. */
export const MAX_MEDIA_INDEX_BYTES = 32 * 1024 * 1024;

export const MEDIA_SKIP_REASONS = {
    UNSUPPORTED: 'not an image or audio file',
    TOO_LARGE: 'larger than the per-file limit',
    UNREADABLE: 'could not be decompressed',
    BUDGET: 'the deck exceeded the total media limit',
};

// ---- type sniffing ----------------------------------------------------------
//
// Magic bytes, in the order a real file would present them. The extension is
// deliberately not consulted: it is attacker-controlled text, and it is also
// routinely wrong in decks that have been converted between formats.

const startsWith = (buf, bytes, offset = 0) =>
    bytes.every((b, i) => buf[offset + i] === b);

const ascii = (buf, offset, text) =>
    [...text].every((ch, i) => buf[offset + i] === ch.charCodeAt(0));

/**
 * What this actually is, from its first bytes. Returns null for anything not
 * recognised, which is what gets it dropped rather than served.
 */
export function sniffMediaType(buf) {
    if (!buf || buf.length < 12) return null;

    // --- images
    if (startsWith(buf, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
    if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png', ext: 'png' };
    if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return { kind: 'image', mime: 'image/gif', ext: 'gif' };
    if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return { kind: 'image', mime: 'image/webp', ext: 'webp' };
    if (startsWith(buf, [0x42, 0x4d])) return { kind: 'image', mime: 'image/bmp', ext: 'bmp' };
    // AVIF / HEIC share the ISO-BMFF `ftyp` box; the brand distinguishes them.
    if (ascii(buf, 4, 'ftyp')) {
        const brand = buf.slice(8, 12).toString('latin1');
        if (brand === 'avif' || brand === 'avis') return { kind: 'image', mime: 'image/avif', ext: 'avif' };
        if (brand.startsWith('hei') || brand.startsWith('mif')) return { kind: 'image', mime: 'image/heic', ext: 'heic' };
        // ...and the same box is how MP4/M4A audio starts. `M4A `, `mp42`, `isom`.
        if (brand === 'M4A ' || brand === 'M4B ' || brand.startsWith('mp4') || brand === 'isom') {
            return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' };
        }
    }
    // SVG is text, and it is NOT accepted: an SVG is a script host, and these
    // files are served from the app's own origin. A deck that needs a diagram
    // can ship a PNG. (Detected only so it is reported honestly.)
    if (ascii(buf, 0, '<svg') || (ascii(buf, 0, '<?xml') && buf.slice(0, 200).includes('<svg'))) return null;

    // --- audio
    if (ascii(buf, 0, 'ID3')) return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
    // A bare MPEG frame sync — an MP3 with no ID3 tag at all.
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
    if (ascii(buf, 0, 'OggS')) return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' };
    if (ascii(buf, 0, 'fLaC')) return { kind: 'audio', mime: 'audio/flac', ext: 'flac' };
    if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WAVE')) return { kind: 'audio', mime: 'audio/wav', ext: 'wav' };

    return null;
}

// ---- the media index --------------------------------------------------------

/** Read a protobuf varint at `pos`. Returns [value, nextPos]. */
function varint(buf, pos) {
    let result = 0, shift = 0;
    while (pos < buf.length) {
        const byte = buf[pos++];
        result += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return [result, pos];
        shift += 7;
        if (shift > 56) break;              // absurd — treat as corrupt
    }
    throw new Error('truncated varint');
}

/** Skip one field whose tag has already been read. */
function skipField(buf, pos, wire) {
    if (wire === 0) return varint(buf, pos)[1];
    if (wire === 1) return pos + 8;
    if (wire === 5) return pos + 4;
    if (wire === 2) { const [len, p] = varint(buf, pos); return p + len; }
    throw new Error(`unsupported wire type ${wire}`);
}

/**
 * The `name` field of every `MediaEntry`, in order — index N is the zip entry
 * named "N". Only field 1 (name) is read; the rest is skipped by wire type, so
 * a future Anki adding a field cannot break this.
 */
export function decodeMediaEntries(buf) {
    const names = [];
    let pos = 0;
    while (pos < buf.length) {
        const [tag, afterTag] = varint(buf, pos);
        const field = tag >> 3, wire = tag & 7;
        if (field !== 1 || wire !== 2) { pos = skipField(buf, afterTag, wire); continue; }
        const [len, afterLen] = varint(buf, afterTag);
        const entry = buf.slice(afterLen, afterLen + len);
        pos = afterLen + len;

        // Inside one MediaEntry: field 1 is the name.
        let p = 0, name = '';
        while (p < entry.length) {
            const [t, at] = varint(entry, p);
            const f = t >> 3, w = t & 7;
            if (f === 1 && w === 2) {
                const [l, al] = varint(entry, at);
                name = entry.slice(al, al + l).toString('utf8');
                p = al + l;
            } else {
                p = skipField(entry, at, w);
            }
        }
        names.push(name);
    }
    return names;
}

/**
 * Filename → zip entry name, for either format.
 *
 * The two are told apart by trying, not by version-sniffing the `meta` entry:
 * the zstd magic is unambiguous and a legacy `media` is plain JSON, so "does it
 * decompress" and "does it parse as JSON" between them cover every file either
 * Anki has ever written, including a legacy deck re-zipped by a third-party tool.
 */
export async function readMediaIndex(zip) {
    const raw = await readZipEntry(zip, 'media', { cap: MAX_MEDIA_INDEX_BYTES, what: 'This deck' });
    if (!raw) return { map: new Map(), format: 'none' };

    // zstd frame magic: 28 b5 2f fd.
    const isZstd = raw.length > 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd;
    if (isZstd) {
        const names = decodeMediaEntries(zstdDecompressSync(raw, {
            maxOutputBytes: MAX_MEDIA_INDEX_BYTES,
            what: "This deck's media index",
        }));
        const map = new Map();
        names.forEach((name, i) => { if (name) map.set(name, String(i)); });
        return { map, format: 'v3', entriesCompressed: true };
    }

    try {
        const parsed = JSON.parse(raw.toString('utf8'));
        const map = new Map();
        for (const [index, name] of Object.entries(parsed || {})) {
            if (typeof name === 'string' && name) map.set(name, String(index));
        }
        return { map, format: 'legacy', entriesCompressed: false };
    } catch {
        // A `media` entry we cannot read is not fatal: the cards still import,
        // they just arrive without their pictures, and the caller says so.
        return { map: new Map(), format: 'unreadable' };
    }
}

// ---- extraction -------------------------------------------------------------

/**
 * Pull every referenced media file out of the zip and into the content-addressed
 * store, returning what each filename became.
 *
 * `wanted` is the set of filenames the notes actually reference. A deck often
 * carries media no note uses any more (Anki only prunes on an explicit "check
 * media"), and extracting those would spend disk on files nothing can ever show.
 *
 * Bytes go to disk one at a time and are not retained: the whole point of the
 * two-phase import is that a 400 MB deck does not sit in memory while somebody
 * reads a preview, and holding the media in the staging record would undo that.
 */
/**
 * Store one media buffer the way an Anki import does: the per-file cap, the
 * total budget, the type read off the BYTES (never the name), then the
 * content-addressed put. Returns `{hash, size, kind, mime}` or `{reason}`.
 * Exported so the course-bundle importer stores a card's clip through exactly
 * this trio rather than a second opinion about what a media file is.
 */
export function storeMediaBuffer(buf, { budgetUsed = 0 } = {}) {
    if (buf.length > MAX_MEDIA_BYTES) return { reason: MEDIA_SKIP_REASONS.TOO_LARGE };
    if (budgetUsed + buf.length > MAX_MEDIA_TOTAL_BYTES) return { reason: MEDIA_SKIP_REASONS.BUDGET };
    const type = sniffMediaType(buf);
    if (!type) return { reason: MEDIA_SKIP_REASONS.UNSUPPORTED };
    const { hash, size } = mediaStorage.put(buf);
    return { hash, size, kind: type.kind, mime: type.mime };
}

export async function extractMedia(zip, wanted, { onProgress } = {}) {
    const { map, format } = await readMediaIndex(zip);
    const files = new Map();                       // filename -> descriptor
    const skipped = [];                            // { name, reason }
    let bytes = 0, done = 0;

    const compressed = format === 'v3';

    for (const name of wanted) {
        const zipName = map.get(name);
        if (zipName === undefined) { skipped.push({ name, reason: MEDIA_SKIP_REASONS.UNSUPPORTED }); continue; }
        const entry = zip.file(zipName);
        if (!entry) { skipped.push({ name, reason: MEDIA_SKIP_REASONS.UNREADABLE }); continue; }

        // Both layers are read under MAX_MEDIA_BYTES — the zip entry, then the
        // zstd frame inside it on a v3 deck — so the per-file cap below is
        // reached with the file already known to fit, instead of being asked
        // about a buffer that is already whatever the archive said it was.
        let buf;
        try {
            buf = await readZipEntry(zip, zipName, { cap: MAX_MEDIA_BYTES, what: 'This deck' });
            if (compressed) buf = zstdDecompressSync(buf, { maxOutputBytes: MAX_MEDIA_BYTES, what: `"${name}"` });
        } catch (err) {
            skipped.push({ name, reason: err?.tooLarge ? MEDIA_SKIP_REASONS.TOO_LARGE : MEDIA_SKIP_REASONS.UNREADABLE });
            continue;
        }

        const stored = storeMediaBuffer(buf, { budgetUsed: bytes });
        if (stored.reason) { skipped.push({ name, reason: stored.reason }); continue; }
        bytes += stored.size;
        files.set(name, { ...stored, filename: name });

        // Yield to the event loop periodically: this process is single-threaded
        // and a 4000-file deck would otherwise freeze every SSE stream in the
        // app for the length of the extraction (the same rule atlas.js follows).
        if (++done % 25 === 0) {
            onProgress?.(done, wanted.length);
            await new Promise(r => setImmediate(r));
        }
    }
    onProgress?.(done, wanted.length);

    return { files, skipped, format, bytes };
}
