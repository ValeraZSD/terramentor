// The library is its owner's alone.
//
// On a computer with several accounts, a file made with the usual umask (022)
// can be read by every one of them: the database and its WAL, every original
// in the vault, the card media, the snapshots kept before an upgrade. Only the
// credentials file (server/secrets.js) was made owner-only. Every place that
// makes a directory or a file of the library comes through here, so each is
// created 0700 / 0600 by the code that makes it, whatever umask the process
// was started with (a tool or a gate that opens a library does not go through
// server/index.js, which also sets an owner-only umask).
//
// A folder that already exists is never changed: DB_PATH and VAULT_ROOT may
// name a folder the app does not own (a shared mount, a Docker volume), and
// silently closing someone's folder is worse than saying it is open. So it is
// said, once at start-up, with the command that closes it.
//
// Windows guards files with ACLs, not these bits: Node maps a mode there to
// the read-only attribute and nothing else, and the per-user data folder
// (%LOCALAPPDATA%) is already closed to other accounts. Everything here is a
// no-op on Windows apart from creating the directory.

import fs from 'node:fs';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const POSIX = process.platform !== 'win32';

/** Create a directory (and any missing parents) readable by its owner only. */
export function makePrivateDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Make an existing file owner-only. A file that is missing, or that this
 * account may not change, is left alone: tightening is never a reason for the
 * library not to open.
 */
export function makePrivateFile(file) {
    if (!POSIX) return;
    try {
        const { mode } = fs.statSync(file);
        if ((mode & 0o077) !== 0) fs.chmodSync(file, PRIVATE_FILE_MODE);
    } catch { /* missing, or not ours to change */ }
}

const warned = new Set();

/**
 * Say, once per folder, that a folder of the library can be read or entered
 * by other accounts on this computer, and how to close it.
 */
export function warnIfOpenToOthers(dir, what = 'The library folder') {
    if (!POSIX || warned.has(dir)) return;
    try {
        const { mode } = fs.statSync(dir);
        if ((mode & 0o077) === 0) return;
        warned.add(dir);
        console.warn(`[files] ${what} ${dir} can be read by other accounts on this computer (mode ${(mode & 0o777).toString(8)}). `
            + `To keep it to this account: chmod -R go-rwx "${dir}"`);
    } catch { /* a folder that is not there yet is made private when it is made */ }
}
