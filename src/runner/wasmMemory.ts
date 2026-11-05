/**
 * Lower the memory ceiling of a WebAssembly module that DEFINES its memory.
 *
 * Pyodide's module declares its own linear memory with a maximum of 4 GB, so a
 * learner's `bytearray(600 * 1024 * 1024)` would simply succeed and take the
 * device's memory with it. A module's memory can never grow past the maximum
 * it declares; the engine refuses, and Python turns that refusal into an
 * ordinary `MemoryError` with the interpreter still alive (measured 4 Nov 2026:
 * 600 MB at a 256 MB ceiling raised MemoryError, `2+2` still answered 4).
 *
 * The maximum is a LEB128 number inside the memory section. LEB128 may be
 * padded with continuation bytes, so the new number is written in exactly the
 * bytes the old one took and every offset after it stays where it was: the
 * module is otherwise byte for byte the published file. A copy is returned;
 * the bytes passed in are not touched.
 *
 * Throws, rather than returning the file unchanged, when there is no ceiling
 * to lower: a module that imports its memory, a 64-bit memory, a memory with
 * no maximum, or a ceiling below the module's own starting size. A runner
 * that silently kept the 4 GB ceiling would look capped and not be.
 */
export const WASM_PAGE_BYTES = 65536;

function readLeb(bytes: Uint8Array, at: number): { value: number; length: number } {
    let value = 0;
    let shift = 0;
    let length = 0;
    for (;;) {
        if (at + length >= bytes.length || length > 9) throw new Error('wasm: truncated LEB128');
        const b = bytes[at + length];
        value += (b & 0x7f) * 2 ** shift;
        shift += 7;
        length += 1;
        if ((b & 0x80) === 0) break;
    }
    return { value, length };
}

export interface MemoryLimits { initialPages: number; maximumPages: number | null }

function findMemory(bytes: Uint8Array): { initialPages: number; maxAt: number; maxLength: number; maximumPages: number | null } {
    if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        throw new Error('wasm: not a WebAssembly module');
    }
    let at = 8;
    while (at < bytes.length) {
        const id = bytes[at];
        const size = readLeb(bytes, at + 1);
        const body = at + 1 + size.length;
        if (id === 5) {
            const count = readLeb(bytes, body);
            if (count.value < 1) break;
            let p = body + count.length;
            const flags = bytes[p];
            p += 1;
            if (flags & 0x04) throw new Error('wasm: a 64-bit memory is not supported');
            const initial = readLeb(bytes, p);
            p += initial.length;
            if (!(flags & 0x01)) return { initialPages: initial.value, maxAt: -1, maxLength: 0, maximumPages: null };
            const max = readLeb(bytes, p);
            return { initialPages: initial.value, maxAt: p, maxLength: max.length, maximumPages: max.value };
        }
        at = body + size.value;
    }
    throw new Error('wasm: the module defines no memory of its own');
}

/** The memory a module defines: its starting size and its ceiling, in 64 KiB pages. */
export function readMemoryLimits(bytes: Uint8Array): MemoryLimits {
    const { initialPages, maximumPages } = findMemory(bytes);
    return { initialPages, maximumPages };
}

/** A copy of `bytes` whose memory may grow to `maxPages` pages and no further. */
export function lowerMemoryMaximum(bytes: Uint8Array, maxPages: number): Uint8Array {
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('wasm: the ceiling must be a whole number of pages');
    const found = findMemory(bytes);
    if (found.maximumPages === null) throw new Error('wasm: the memory has no maximum to lower');
    if (maxPages < found.initialPages) throw new Error(`wasm: ${maxPages} pages is below the module's starting ${found.initialPages}`);
    if (maxPages > found.maximumPages) throw new Error('wasm: that would raise the ceiling, not lower it');
    if (maxPages >= 2 ** (7 * found.maxLength)) throw new Error('wasm: the new ceiling does not fit where the old one was');
    const out = bytes.slice();
    let v = maxPages;
    for (let k = 0; k < found.maxLength; k++) {
        let b = v & 0x7f;
        v = Math.floor(v / 128);
        if (k < found.maxLength - 1) b |= 0x80;
        out[found.maxAt + k] = b;
    }
    return out;
}
