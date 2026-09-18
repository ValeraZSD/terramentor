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

/**
 * Decompress a zstd frame, or explain precisely why we cannot.
 * @param {Buffer|Uint8Array} bytes
 * @returns {Buffer}
 */
export function zstdDecompressSync(bytes) {
    if (!zstdAvailable()) {
        throw new Error(
            `This Anki file is zstd-compressed (the format Anki 2.1.28+ writes), and this ` +
                `Node runtime cannot read it: zstd support arrived in Node ${ZSTD_MIN_NODE}, ` +
                `and this is ${process.version}. Upgrade Node to ${ZSTD_MIN_NODE}+ (or 24+) ` +
                `and import the deck again. Everything else in the app works unchanged.`,
        );
    }
    return Buffer.from(zlib.zstdDecompressSync(bytes));
}
