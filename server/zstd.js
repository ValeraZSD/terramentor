/**
 * zstd decompression, resolved at CALL time rather than at import time.
 *
 * A modern `.apkg` stores its collection — and every media entry — zstd
 * compressed, and Node grew `zstdDecompressSync` only in **22.15 / 24**. The
 * obvious spelling, `import { zstdDecompressSync } from 'node:zlib'`, is a
 * static named import from a builtin, so on an older Node it fails at module
 * LINK time. `server/ankiImport.js` is imported by `server/index.js`, which
 * means the whole server refuses to boot, with a module-resolution error that
 * says nothing about Anki, decks or Node versions.
 *
 * Importing the namespace can never fail, and reading a missing property just
 * yields `undefined` — so the failure moves to the one place it belongs: the
 * moment somebody actually opens a deck, with a message naming the cause and
 * the fix. Everything else in the app keeps working on an older runtime, which
 * is the same degradation contract every other optional capability here has.
 *
 * The supported floor is still declared in package.json `engines`; this is what
 * makes falling below it legible instead of fatal.
 */
import * as zlib from 'node:zlib';

/** Node releases that added zstd support. Quoted in the error, so a user does
 *  not have to go and look it up. */
export const ZSTD_MIN_NODE = '22.15';

/** True when this runtime can read a zstd-compressed Anki collection. */
export function zstdAvailable() {
    return typeof zlib.zstdDecompressSync === 'function';
}

/** How a size reads in a refusal a learner sees. */
function readableBytes(n) {
    return n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${n} bytes`;
}

/**
 * Decompress a zstd frame under a CEILING, or explain precisely why we cannot.
 *
 * The ceiling is not optional, and it is not a default. Everything this reads
 * comes out of a file somebody was handed — a deck from AnkiWeb, a course from
 * a stranger — and a zstd frame is a compression ratio the author chose: a few
 * hundred kilobytes of frame can name gigabytes of output, and an unbounded
 * `zstdDecompressSync` allocates every one of them before any code gets the
 * chance to look at a size. This process serves every SSE stream, review
 * session and generation run in the app, so one import doing that is not one
 * failed import.
 *
 * `maxOutputLength` is the bound Node's own zlib applies WHILE inflating, which
 * is the only place it can honestly be applied — a check afterwards is a check
 * run once the memory is already gone. Callers name their own ceiling because
 * only they know what the frame is (a collection database, one media file, a
 * media index), and a caller that names none is a programming error rather than
 * a silently unbounded path.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {{ maxOutputBytes: number, what?: string }} opts
 * @returns {Buffer}
 */
export function zstdDecompressSync(bytes, { maxOutputBytes, what = 'This file' } = {}) {
    if (!zstdAvailable()) {
        throw new Error(
            `This Anki file is zstd-compressed (the format Anki 2.1.28+ writes), and this ` +
                `Node runtime cannot read it: zstd support arrived in Node ${ZSTD_MIN_NODE}, ` +
                `and this is ${process.version}. Upgrade Node to ${ZSTD_MIN_NODE}+ (or 24+) ` +
                `and import the deck again. Everything else in the app works unchanged.`,
        );
    }
    if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
        throw new Error(
            'zstdDecompressSync needs a byte ceiling — pass { maxOutputBytes }. ' +
                'A frame from an imported file must never be inflated without one.',
        );
    }
    try {
        // Returned as zlib produced it. The `Buffer.from(...)` copy that used to
        // wrap this doubled the peak for exactly the case the ceiling is about:
        // a 400 MB collection cost 800 MB to read.
        return zlib.zstdDecompressSync(bytes, { maxOutputLength: maxOutputBytes });
    } catch (err) {
        if (err?.code !== 'ERR_BUFFER_TOO_LARGE') throw err;
        // The raw message is "Cannot create a Buffer larger than N bytes",
        // which tells the learner nothing about the file they chose.
        const refusal = new Error(
            `${what} expands to more than ${readableBytes(maxOutputBytes)} of data. ` +
                'It is being refused as a compression bomb rather than read into memory — ' +
                'a file this size compressed to this is not something any deck or course needs.',
        );
        refusal.tooLarge = true;
        throw refusal;
    }
}
