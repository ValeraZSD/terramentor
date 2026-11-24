// What a library prints, kept in that library's own folder.
//
// A library's lines carry the person's work: topic titles, a question and its
// answer, a course's name on import. The front desk used to copy them into its
// own log, which outlives the library, its backups and an erasure. They go to
// `server.log` in the library's folder instead, and leave with the folder.
//
// The cap: when the next line would take `server.log` past `maxBytes` it
// becomes `server.log.1` (replacing the older one) and a new file starts, so
// the front desk never writes more than twice the cap for a library.
//
// The front desk runs as root and the folder belongs to the library's own user,
// whose process may have left anything at these names while it ran. Nothing
// here follows a link (O_NOFOLLOW on the last name; the folder itself sits in a
// folder only root can change), opens a pipe (O_NONBLOCK, then a regular-file
// check on the open descriptor), or writes to a file with a second name or
// another owner (a hard link made to someone else's file). A file that fails a
// check is not written to for the rest of that run, and `onRefused` is called
// once: a lost line is better than root writing where a library pointed it.
// A file that could not be opened for another reason (too many open files, a
// folder gone) is tried again with the first output 30 s later; `onUnopened`
// names the error code the first time. A write that fails (a full disk) loses
// those lines and says nothing.
// (On Windows the two flags do not exist; libraries there run as the front
// desk's own user, so there is no boundary to keep.)
import fs from 'node:fs';
import path from 'node:path';

export const LIBRARY_LOG = 'server.log';
export const DEFAULT_LOG_BYTES = 1024 * 1024;
export const MIN_LOG_BYTES = 4 * 1024;

const { O_WRONLY, O_APPEND, O_CREAT } = fs.constants;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

const closeQuietly = (fd) => { try { fs.closeSync(fd); } catch { /* already gone */ } };

// What the library could have put at the name: a link (ELOOP), a pipe with no
// reader (ENXIO), a folder (EISDIR). Any other failure (a full disk or file
// table, a folder gone) is not its doing and is tried again later.
const PUT_THERE = new Set(['ELOOP', 'ENXIO', 'EISDIR']);
const RETRY_MS = 30_000;
// A line cut inside a character ends in U+FFFD once decoded; that half is dropped.
const CUT_CHARACTER = new RegExp(`${String.fromCharCode(0xfffd)}$`);

/**
 * Open `file` for appending if it is safe to. Returns `{ fd, size }`, or
 * `{ refused: true }` for something the library put there, or `{ code }` for
 * a failure worth another try.
 */
function openSafely(file, ownerUid) {
    let fd;
    try {
        fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
    } catch (e) {
        return PUT_THERE.has(e.code) ? { refused: true } : { code: String(e.code || 'error') };
    }
    try {
        const st = fs.fstatSync(fd);
        const ownerOk = process.platform === 'win32' || st.uid === 0 || st.uid === process.getuid?.() || (ownerUid != null && st.uid === ownerUid);
        if (st.isFile() && st.nlink === 1 && ownerOk) return { fd, size: st.size };
    } catch (e) {
        closeQuietly(fd);
        return { code: String(e.code || 'error') };
    }
    closeQuietly(fd);
    return { refused: true }; // a pipe, a device, a second name, someone else's file
}

const callQuietly = (fn, ...args) => { try { fn(...args); } catch { /* a report must not stop the writer */ } };

/**
 * A writer for one library's output. `stream(name)` gives the function to call
 * with each chunk a stream printed (`stdout`, `stderr`): each keeps its own
 * unfinished line, so a line cut at a pipe read is never glued to the other
 * stream's. Lines are stamped with the time they arrived, and a chunk's lines
 * go to disk in one write. `close()` writes the unfinished lines and closes the
 * file; nothing is written after it. Never throws: a full disk must not stop
 * the library.
 */
export function createLibraryLog(dir, {
    maxBytes = DEFAULT_LOG_BYTES, ownerUid = null, now = () => new Date(),
    onRefused = () => {}, onUnopened = () => {},
} = {}) {
    const cap = Math.max(MIN_LOG_BYTES, Math.floor(maxBytes));
    const file = path.join(dir, LIBRARY_LOG);
    let handle = null;
    let refused = false;
    let closed = false;
    let retryAt = 0;
    let toldUnopened = false;
    let lines = 0; // written this run
    let lost = false; // a line was dropped because the file was refused or could not be opened
    const partial = new Map(); // stream name -> { text, dropping }

    // Called only with lines to write: a null answer means they are lost.
    const ensure = () => {
        if (handle) return handle;
        if (refused || now().getTime() < retryAt) { lost = true; return null; }
        const r = openSafely(file, ownerUid);
        if ('fd' in r) { handle = r; return handle; }
        lost = true;
        if (r.refused) {
            refused = true;
            callQuietly(onRefused);
        } else {
            retryAt = now().getTime() + RETRY_MS; // lines until then are lost
            if (!toldUnopened) { toldUnopened = true; callQuietly(onUnopened, r.code); }
        }
        return null;
    };
    const rotate = () => {
        if (handle) { closeQuietly(handle.fd); handle = null; }
        // Renames move names, never what a link points at.
        try { fs.renameSync(file, `${file}.1`); } catch { try { fs.unlinkSync(file); } catch { /* nothing there */ } }
    };
    const flush = (text, count) => {
        if (!text || !ensure()) return;
        try {
            fs.writeSync(handle.fd, text);
            handle.size += Buffer.byteLength(text);
            lines += count;
        } catch { /* disk full: the lines are lost, the library runs on */ }
    };
    /** Stamp and write `lines` in as few writes as the cap allows. */
    const put = (batch) => {
        if (!batch.length || !ensure()) return;
        let pending = '';
        let pendingBytes = 0;
        let pendingLines = 0;
        for (const line of batch) {
            let text = `${now().toISOString()} ${line}\n`;
            let bytes = Buffer.byteLength(text);
            if (bytes > cap) { // one line longer than the cap keeps its start
                text = `${Buffer.from(text).subarray(0, cap - 4).toString('utf8').replace(CUT_CHARACTER, '')}…\n`;
                bytes = Buffer.byteLength(text);
            }
            if (handle && handle.size + pendingBytes + bytes > cap && handle.size + pendingBytes > 0) {
                flush(pending, pendingLines);
                pending = ''; pendingBytes = 0; pendingLines = 0;
                rotate();
                if (!ensure()) return;
            }
            pending += text;
            pendingBytes += bytes;
            pendingLines += 1;
        }
        flush(pending, pendingLines);
    };

    return {
        file,
        /** Lines written to the file this run: 0 means nothing of its output was kept. */
        get lines() { return lines; },
        /** Whether some of its output was dropped: the file was refused or could not be opened. */
        get lost() { return lost; },
        stream(name) {
            return (chunk) => {
                if (closed) return;
                const state = partial.get(name) ?? { text: '', dropping: false };
                const parts = (state.text + String(chunk)).split('\n');
                state.text = parts.pop();
                const batch = [];
                for (const l of parts) {
                    if (state.dropping) { state.dropping = false; continue; } // the rest of a line already cut
                    if (l.trim()) batch.push(l.replace(/\r$/, ''));
                }
                // A line that never ends is written up to the cap, and the rest of
                // it dropped up to its newline, rather than held in memory.
                if (Buffer.byteLength(state.text) > cap) {
                    if (!state.dropping) batch.push(state.text);
                    state.text = '';
                    state.dropping = true;
                }
                partial.set(name, state);
                put(batch);
            };
        },
        close() {
            if (closed) return;
            const rest = [...partial.values()].filter((s) => !s.dropping && s.text.trim()).map((s) => s.text);
            put(rest);
            closed = true;
            partial.clear();
            if (handle) { closeQuietly(handle.fd); handle = null; }
        },
    };
}
