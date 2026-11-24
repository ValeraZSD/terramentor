// What a library prints, kept in that library's own folder.
//
// A library's lines carry the person's work: topic titles, a question and its
// answer, a course's name on import. The front desk used to copy them into its
// own log, which outlives the library, its backups and an erasure. They go to
// `server.log` in the library's folder instead, and leave with the folder.
//
// The cap: when the next line would take `server.log` past `maxBytes` it
// becomes `server.log.1` (replacing the older one) and a new file starts, so a
// library never holds more than twice the cap of log.
//
// The front desk runs as root and the folder belongs to the library's own user,
// whose process may have left anything at these names while it ran. Nothing
// here follows a link (O_NOFOLLOW on the last name; the folder itself sits in a
// folder only root can change), opens a pipe (O_NONBLOCK, then a regular-file
// check), or writes to a file with a second name or another owner (a hard link
// made to someone else's file). A file that fails a check is not written to: a
// lost line is better than root writing where a library pointed it.
import fs from 'node:fs';
import path from 'node:path';

export const LIBRARY_LOG = 'server.log';
export const DEFAULT_LOG_BYTES = 1024 * 1024;

const { O_WRONLY, O_APPEND, O_CREAT } = fs.constants;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/** Open `file` for appending if it is safe to; returns `{ fd, size }` or null. */
function openSafely(file, ownerUid) {
    let fd;
    try {
        fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
    } catch {
        return null; // a link (ELOOP), a pipe with no reader (ENXIO), a folder
    }
    try {
        const st = fs.fstatSync(fd);
        const ownerOk = process.platform === 'win32' || st.uid === 0 || st.uid === process.getuid?.() || (ownerUid != null && st.uid === ownerUid);
        if (st.isFile() && st.nlink === 1 && ownerOk) return { fd, size: st.size };
    } catch { /* checked below */ }
    fs.closeSync(fd);
    return null;
}

/**
 * A writer for one library's output. `write(chunk)` takes what its process
 * printed, as it comes; `close()` flushes a last unfinished line. Lines are
 * stamped with the time they arrived. Never throws: the log is a courtesy, a
 * full disk must not stop the library.
 */
export function createLibraryLog(dir, { maxBytes = DEFAULT_LOG_BYTES, ownerUid = null, now = () => new Date() } = {}) {
    const file = path.join(dir, LIBRARY_LOG);
    let handle = null;
    let partial = '';

    const ensure = () => { handle ??= openSafely(file, ownerUid); return handle; };
    const rotate = () => {
        if (handle) { try { fs.closeSync(handle.fd); } catch { /* gone */ } handle = null; }
        // Renames move names, never what a link points at.
        try { fs.renameSync(file, `${file}.1`); } catch { try { fs.unlinkSync(file); } catch { /* nothing there */ } }
    };
    const put = (line) => {
        let text = `${now().toISOString()} ${line}\n`;
        let bytes = Buffer.byteLength(text);
        if (bytes > maxBytes) { // one line longer than the cap keeps its start
            text = `${Buffer.from(text).subarray(0, Math.max(0, maxBytes - 4)).toString('utf8').replace(/�$/, '')}…\n`;
            bytes = Buffer.byteLength(text);
        }
        if (!ensure()) return;
        if (handle.size + bytes > maxBytes && handle.size > 0) {
            rotate();
            if (!ensure()) return;
        }
        try {
            fs.writeSync(handle.fd, text);
            handle.size += bytes;
        } catch { /* disk full: the line is lost, the library runs on */ }
    };

    return {
        file,
        write(chunk) {
            const text = partial + String(chunk);
            const parts = text.split('\n');
            partial = parts.pop();
            // An unending line is written in pieces, not held in memory.
            if (partial.length > maxBytes) { put(partial); partial = ''; }
            for (const l of parts) if (l.trim()) put(l.replace(/\r$/, ''));
        },
        close() {
            if (partial.trim()) put(partial);
            partial = '';
            if (handle) { try { fs.closeSync(handle.fd); } catch { /* gone */ } handle = null; }
        },
    };
}
