// server/openedFiles.js — a course file the desktop app was asked to open: a
// `.studyvault` double-clicked in the file manager, dropped on the program, or
// named with `--open` (desktop/launcher.js).
//
// The launcher cannot hand the window a path. A path in the window's address
// would be a URL anything on the computer could open, and the page would then
// read whatever file that URL named. So the launcher REGISTERS the file with
// the server and the window gets a TOKEN for it:
//
//   1. The launcher posts the path with a proof made under the library's key
//      (server/instanceKey.js `openFileProof`). Only the account that owns the
//      library can read that key, and that account could read the file anyway,
//      so a registration grants nothing its sender did not already have. The
//      nonce in the proof is refused a second time.
//   2. The server checks the path names a regular `.studyvault` file no bigger
//      than the import door takes, and answers with a random 256-bit token.
//   3. The window opens at `/#open-file=<token>`. The page asks for the file by
//      token, once: the token is spent on that request, and one never asked
//      for lapses after `TOKEN_TTL_MS`.
//
// Nothing here imports anything. The page shows the course and the learner
// presses Add, which sends the bytes through the ordinary import door with
// every check it already makes.

import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

/** The only kind of file the launcher opens. */
export const OPENABLE = /\.studyvault$/i;
/** The import door's own ceiling (server/routes/bundle.js MAX_LIBRARY_UPLOAD_BYTES). */
export const MAX_OPENED_BYTES = 1024 * 1024 * 1024;
/** How long a token waits for its window. A window opens in seconds; ten
 *  minutes covers a slow first start behind a lock screen. */
export const TOKEN_TTL_MS = 10 * 60_000;
/** Files waiting at once. A person double-clicks a handful; more is a loop. */
export const MAX_WAITING = 16;

const TOKEN = /^[0-9a-f]{64}$/;

/**
 * Why `path` cannot be opened, or null when it can. `stat` is the file
 * system's word on it, injectable so the gate can ask about every case.
 */
export function openRefusal(path, { stat = statSync, absolute = isAbsolute } = {}) {
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) return 'not a path';
    if (!absolute(path)) return 'not an absolute path';
    // Windows' device and raw namespaces (`\\.\`, `\\?\`) name pipes, drives and
    // consoles, never a file a person double-clicked.
    if (/^[\\/][\\/][.?][\\/]/.test(path)) return 'not a file path';
    // The whole path, so one ending in a separator (a folder) is refused too.
    if (!OPENABLE.test(path)) return 'not a .studyvault file';
    let st;
    try { st = stat(path); } catch { return 'not there'; }
    if (!st.isFile()) return 'not a file';
    if (st.size === 0) return 'empty';
    if (st.size > MAX_OPENED_BYTES) return 'too large';
    return null;
}

/**
 * The files waiting for a window. `register` takes a path the launcher proved
 * it may ask for; `take` hands one out by token, once.
 */
export function createOpenedFiles({ now = Date.now, stat = statSync, absolute = isAbsolute, newToken = () => randomBytes(32).toString('hex') } = {}) {
    const waiting = new Map();
    /** Nonces already answered, remembered for the life of a token. A proof
     *  replayed later registers the same file again, readable only by the
     *  library's owner, so nothing is gained by it. */
    const nonces = new Map();

    function sweep() {
        const t = now();
        for (const [token, entry] of waiting) if (entry.expires <= t) waiting.delete(token);
        for (const [nonce, expires] of nonces) if (expires <= t) nonces.delete(nonce);
    }

    /** True the first time a nonce is offered, false every time after. */
    function freshNonce(nonce) {
        sweep();
        if (nonces.has(nonce)) return false;
        nonces.set(nonce, now() + TOKEN_TTL_MS);
        return true;
    }

    /** `{ token }`, or `{ refused }` saying why not. */
    function register(path) {
        sweep();
        const refused = openRefusal(path, { stat, absolute });
        if (refused) return { refused };
        if (waiting.size >= MAX_WAITING) return { refused: 'too many files waiting' };
        const token = newToken();
        waiting.set(token, { path, name: basename(path), expires: now() + TOKEN_TTL_MS });
        return { token };
    }

    /** The file a token stands for, spending the token; null for any other token. */
    function take(token) {
        sweep();
        if (typeof token !== 'string' || !TOKEN.test(token)) return null;
        const entry = waiting.get(token);
        if (!entry) return null;
        waiting.delete(token);
        return entry;
    }

    return { register, take, freshNonce, size: () => waiting.size };
}
