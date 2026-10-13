/* Credentials, kept BESIDE the library file and never in it.
 *
 * WHY. The library's SQLite file is the part that travels: the snapshot the
 * app takes before each upgrade (`VACUUM INTO`, the last three kept), a
 * backup, a copy handed to someone or synced. A credential stored in it goes
 * wherever it goes — the provider keys, the password hash and session secret,
 * the search engines' keys, and a ChatGPT sign-in's refresh token, which can
 * be used only once, so a restored copy would carry one OpenAI has spent.
 *
 * So a credential is split in two. The library keeps the half that is not
 * secret — which address a key was saved for, that a sign-in exists — and
 * this file keeps the secret half. A key is sent only when both halves agree,
 * so a library moved or restored without this file says "needs its key
 * again" per connection, and sends nothing it cannot vouch for.
 *
 * WHY A FILE AND NOT THE OS KEYCHAIN. A keychain needs a native module per
 * platform (keytar, the usual one, is archived), and there is no Secret
 * Service in a container or on a headless Linux box, which are supported
 * installs here, so a file fallback would be needed anyway: two code paths,
 * as in Codex CLI's `auto` credential store. A keychain is also per OS user,
 * not per library, so it would sit outside what `paths.js` decides for a
 * process. And it protects against nothing this file does not: a program
 * running as the same user can read both. The threat here is the library FILE
 * travelling (a snapshot, a copy, a synced database); a whole data folder
 * copied or backed up takes this file with it, and SECURITY.md says so. The
 * interface is get / set / delete, so a keychain can stand behind it later
 * without a caller changing.
 *
 * THE FILE. `paths.js` names it (`<library>.secrets.json` beside the
 * database, or SECRETS_PATH). JSON, written whole: to a temporary file in the
 * same folder, flushed to disk, then renamed over the old one (and the folder
 * flushed where the system allows it), so a crash leaves the old file or the
 * new one and never half of either. Created owner-read-write only (0600) where
 * the platform has modes; on Windows it takes the access list of the folder it
 * is in. Read through a cache checked against the file's size and time; every
 * WRITE re-reads the file first, so one process does not write back over a
 * credential another just saved.
 *
 * FAILING. A file that exists and cannot be READ (locked, no permission) is an
 * error, retried briefly and never cached: answering "no password" for it
 * would open the gate. A file that reads but is not a credentials file is
 * treated as empty and set aside, never written over, on the next save.
 *
 * This is the only module that opens the file. `tools/secrets-gates.mjs`
 * holds that, and that no credential is written into the library again.
 */
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataPaths } from './paths.js';

const FORMAT = 'terramentor-secrets';
const VERSION = 1;
const ABOUT = 'Credentials for the Terramentor library beside this file: provider keys, sign-ins, the password. '
    + 'Not part of the library, so it is not in its snapshots or exports. Keep it private; '
    + 'without it the library asks for its keys again.';

/** The provider key in use, and the origin it was saved for (ai.js names the
 *  pair; the library keeps its own copy of the origin, see `activeKey` there). */
export const ACTIVE_KEY = 'ai_openai_api_key';
export const ACTIVE_KEY_ORIGIN = 'ai_openai_api_key_origin';

/** The settings rows that were credentials, and now live here under the same
 *  names. auth.js refuses each of them through the generic settings routes. */
export const MOVED_SETTING_KEYS = [
    ACTIVE_KEY,
    'auth_password_hash', 'auth_session_secret', 'auth_api_key',
    'search_tavily_key', 'search_brave_key', 'search_jina_key',
];

/** Where this process keeps them. */
export function secretsFile() {
    return dataPaths().secretsPath;
}

let cache = null;   // { path, mtimeMs, size, secrets, unreadable }
let warned = '';
// Credentials a move that failed on this start left in the library: read from
// there for this run, so a password stays a password and a key still works,
// and refused as targets of a change until a start moves them (see below).
let heldInLibrary = null;

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE']);

/** The file as it is on disk: null when absent, `unreadable` when it is not
 *  a credentials file. THROWS when it exists and cannot be read. */
function readDisk(path) {
    const st = statSyncOrAbsent(path);
    if (!st) return null;
    let text;
    for (let attempt = 0; ; attempt++) {
        try { text = readFileSync(path, 'utf8'); break; } catch (e) {
            if (attempt >= 5 || !TRANSIENT.has(e.code)) {
                throw Object.assign(new Error(`The credentials file ${path} could not be read (${e.code || e.message})`), { code: e.code, status: 503 });
            }
            wait(20);
        }
    }
    const secrets = {};
    try {
        // A byte-order mark is what Notepad and PowerShell 5.1 add on save.
        const doc = JSON.parse(text.replace(/^\uFEFF/, ''));
        if (doc?.format !== FORMAT || !doc.secrets || typeof doc.secrets !== 'object') throw new Error('not a credentials file');
        for (const [name, value] of Object.entries(doc.secrets)) {
            if (typeof value === 'string' && value) secrets[name] = value;
        }
        return { st, secrets, unreadable: false };
    } catch (e) {
        if (warned !== path) {
            warned = path;
            console.error(`[Secrets] ${path} is not a credentials file (${e.message}). Saved keys read as missing until it is fixed; the next key saved sets it aside as .unreadable-<time>.`);
        }
        return { st, secrets: {}, unreadable: true };
    }
}

/** A path under a FILE (ENOTDIR) cannot exist, so it is absent, not unreadable. */
function statSyncOrAbsent(path) {
    try { return statSync(path, { throwIfNoEntry: false }); } catch (e) {
        if (e.code === 'ENOTDIR') return undefined;
        throw e;
    }
}

function load({ fresh = false } = {}) {
    const path = secretsFile();
    if (!fresh && cache && cache.path === path) {
        const st = statSyncOrAbsent(path);
        if (st ? cache.mtimeMs === st.mtimeMs && cache.size === st.size : cache.size === -1) return cache;
    }
    const read = readDisk(path);
    cache = read
        ? { path, mtimeMs: read.st.mtimeMs, size: read.st.size, secrets: read.secrets, unreadable: read.unreadable }
        : { path, mtimeMs: 0, size: -1, secrets: {}, unreadable: false };
    return cache;
}

/** One credential, or '' when none is saved. */
export function getSecret(name) {
    if (heldInLibrary) {
        // The move failed this start: the library's copies stand. A name the
        // library does not hold lives only in the file, so a file that cannot
        // be read still fails closed for it (a password moved on an earlier
        // start must not read as unset).
        try { return load().secrets[name] || heldInLibrary[name] || ''; } catch (e) {
            if (name in heldInLibrary) return heldInLibrary[name];
            throw e;
        }
    }
    return load().secrets[name] || '';
}

/** Every name the file holds (the migration matches a restored sign-in). */
function savedNames() {
    return Object.keys(load().secrets);
}

const NAME = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9_-]+)*$/;
const REF = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Change several credentials in ONE write: a key and the origin it is bound
 * to land together or not at all. `''` or null deletes. Returns whether the
 * file changed; nothing is written when nothing would.
 */
export function setSecrets(changes) {
    if (heldInLibrary) {
        // Changing one now would leave the library's older copy to be moved
        // over it on the next start, or a deleted one to come back. Refused
        // until a start has moved them, which every start tries again.
        throw Object.assign(new Error('Saved keys cannot be changed right now: they could not be moved out of the library file on this start. Restart the app; see its log for why.'), { status: 503 });
    }
    return writeChanges(changes);
}

function writeChanges(changes) {
    const current = load({ fresh: true });
    const next = { ...current.secrets };
    let changed = false;
    for (const [name, value] of Object.entries(changes)) {
        if (!NAME.test(name)) throw new Error(`Not a credential name: ${name}`);
        const v = value == null ? '' : String(value);
        if (v) {
            if (next[name] !== v) { next[name] = v; changed = true; }
        } else if (name in next) {
            delete next[name];
            changed = true;
        }
    }
    if (!changed) return false;
    write(current, next);
    return true;
}

export function setSecret(name, value) {
    return setSecrets({ [name]: value });
}

export function deleteSecrets(...names) {
    return setSecrets(Object.fromEntries(names.map(n => [n, ''])));
}

/** A connection's place in the file. `ref` is random and kept on its row
 *  (`ai_connections.secret_ref`), never the row id: a restored library whose
 *  row 3 is another connection must not find this one's key. */
export function connectionSecret(ref, field) {
    if (!ref) throw new Error('A connection needs a secret_ref before it can keep a credential');
    return `connection:${ref}:${field}`;
}

export function newSecretRef() {
    return randomBytes(12).toString('hex');
}

const tmpPattern = (path) => new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`);

/** Where a write lands: the file itself, or the target of a link to it. */
function writtenPath(path) {
    try { if (lstatSync(path).isSymbolicLink()) return realpathSync(path); } catch { /* absent: written here */ }
    return path;
}

function write(current, secrets) {
    // A credentials file that is a link is written where the link points;
    // replacing the link itself would leave its target holding the old keys.
    const path = writtenPath(current.path);
    mkdirSync(dirname(path), { recursive: true });
    if (current.unreadable) {
        // Never written over: whatever it held may still be recoverable by
        // hand. If it cannot be set aside, nothing is written.
        renameSync(path, `${path}.unreadable-${Date.now()}`);
    }
    const sorted = Object.fromEntries(Object.keys(secrets).sort().map(k => [k, secrets[k]]));
    const body = `${JSON.stringify({ format: FORMAT, version: VERSION, about: ABOUT, secrets: sorted }, null, 2)}\n`;
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    let st;
    try {
        writeSync(fd, body);
        fsyncSync(fd);
        // The cache takes the stamp of what WE wrote (a rename keeps it), so
        // another process's write right after ours is still seen as a change.
        st = fstatSync(fd);
    } finally {
        closeSync(fd);
    }
    try {
        renameOver(tmp, path);
    } catch (e) {
        try { unlinkSync(tmp); } catch { /* best effort */ }
        throw e;
    }
    if (process.platform !== 'win32') {
        try { chmodSync(path, 0o600); } catch { /* the file was created 0600 already */ }
        // The rename is durable only once the folder's entry is.
        try { const dfd = openSync(dirname(path), 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* not every filesystem allows it */ }
    }
    cache = { path: current.path, mtimeMs: st.mtimeMs, size: st.size, secrets, unreadable: false };
}

/** Windows refuses a rename over a file another process (an indexer, an
 *  antivirus scan) holds open for a moment: wait briefly and try again.
 *  Elsewhere a refused rename does not pass by waiting: a file mounted on
 *  its own (a container secret) cannot be replaced at all, and says so. */
function renameOver(from, to) {
    for (let attempt = 0; ; attempt++) {
        try { renameSync(from, to); return; } catch (e) {
            if (process.platform === 'win32' && attempt < 40 && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { wait(50); continue; }
            if (process.platform !== 'win32' && ['EBUSY', 'EXDEV', 'EROFS'].includes(e.code)) {
                throw Object.assign(new Error(`The credentials file ${to} cannot be replaced (${e.code}): SECRETS_PATH must name a file in a writable folder, not a file mounted on its own`), { code: e.code, status: 503 });
            }
            throw e;
        }
    }
}

/** A temporary file a crash left behind holds every credential: removed once
 *  it is old enough that no writer can still be finishing it. */
function sweepTemporaryFiles() {
    const paths = new Set([secretsFile(), writtenPath(secretsFile())]);
    for (const path of paths) {
        const dir = dirname(path);
        const mine = tmpPattern(path);
        let names = [];
        try { names = readdirSync(dir); } catch { continue; }
        for (const name of names) {
            if (!mine.test(name)) continue;
            try {
                if (Date.now() - statSync(join(dir, name)).mtimeMs > 10 * 60 * 1000) unlinkSync(join(dir, name));
            } catch { /* gone, or not ours to remove */ }
        }
    }
}

// ── moving them out of a library that still holds them ────────────────────

export const COMPACT_PENDING = 'secrets_compact_pending';
/** Set once this build has opened the library; see WHICH COPY WINS. */
export const MOVED_MARK = 'secrets_moved_at';

/**
 * Move every credential the library file still holds into this file: the
 * settings rows above, and each saved connection's key and sign-in. Runs on
 * every start (database.js), BEFORE the pre-upgrade snapshot, so the snapshot
 * of this upgrade carries none. Once moved there is nothing left to find, so
 * a second start changes nothing.
 *
 * The order is what makes it lossless: give each connection its `secret_ref`,
 * write this file, read every value back from DISK, and only then clear the
 * library's copy. A failure before the clear leaves the library as it was:
 * this run reads the credentials from there (a password stays a password)
 * and refuses to change any, and the next start tries again. That start's
 * snapshot, taken right after, then still holds them, as the library does.
 *
 * WHICH COPY WINS. A library this build has opened carries `secrets_moved_at`
 * (a settings row, not secret). A credential found in such a library was
 * written by an older build AFTER this one (a downgrade and back): it is the
 * newer copy, and it wins. A library without the mark is a first move, or a
 * restored copy of a library from before this build: there this file's copy
 * of a library-wide row (the key in use, the password, the session secret, the
 * bearer key, the search keys) wins when it has one, because a backup must
 * not bring back an old password or a revoked key over the current one; the
 * library's copy is cleared and named in the log. And a restored ChatGPT
 * connection takes this file's entry for the same account when no other row
 * holds it, because a refresh token rotates: the restored one is spent.
 *
 * Clearing a row does not clear the bytes: SQLite leaves deleted content in
 * free pages and in the WAL. So the deletes run with `secure_delete`, and the
 * file is then compacted (VACUUM) and its WAL truncated, once. A compaction
 * that fails (a full disk, the WAL held open) is retried on the next start.
 */
export function moveSecretsOutOfLibrary(db) {
    heldInLibrary = null;
    const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

    // 1. What the library holds, read from the library alone: if the
    //    credentials file cannot be used below, this run still has these.
    const fromSettings = {};
    const settingsKeys = [];
    let marked = false;
    if (hasTable('settings')) {
        const read = db.prepare('SELECT value FROM settings WHERE key = ?');
        marked = !!read.get(MOVED_MARK);
        for (const key of MOVED_SETTING_KEYS) {
            const row = read.get(key);
            if (!row) continue;
            settingsKeys.push(key);
            if (row.value) fromSettings[key] = String(row.value);
        }
        if (fromSettings[ACTIVE_KEY]) fromSettings[ACTIVE_KEY_ORIGIN] = String(read.get(ACTIVE_KEY_ORIGIN)?.value || '');
    }
    // A library from before saved connections existed has no such table.
    const hasConnections = hasTable('ai_connections');
    let holding = [];
    if (hasConnections) {
        const cols = db.prepare('PRAGMA table_info(ai_connections)').all().map(c => c.name);
        if (!cols.includes('secret_ref')) db.exec("ALTER TABLE ai_connections ADD COLUMN secret_ref TEXT NOT NULL DEFAULT ''");
        holding = db.prepare(`SELECT id, kind, api_key, key_origin, credentials, secret_ref FROM ai_connections
            WHERE COALESCE(api_key, '') <> '' OR COALESCE(credentials, '') <> ''`).all();
    }
    const mark = () => db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(MOVED_MARK, new Date().toISOString());
    if (!settingsKeys.length && !holding.length) {
        sweepTemporaryFiles();
        if (hasTable('settings')) {
            if (!marked) mark();
            if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(COMPACT_PENDING)) compact(db);
        }
        return { moved: 0, kept: [], adopted: 0 };
    }

    const setRef = hasConnections ? db.prepare('UPDATE ai_connections SET secret_ref = ? WHERE id = ?') : null;
    const plan = {};
    const kept = [];
    const adoptedRows = [];
    let originFromFile = '';
    const own = (r, ref, into) => {
        if (r.api_key) {
            into[connectionSecret(ref, 'api_key')] = r.api_key;
            into[connectionSecret(ref, 'key_origin')] = r.key_origin || '';
        }
        if (r.credentials) into[connectionSecret(ref, 'credentials')] = r.credentials;
    };
    // The move did not finish: every row that holds a credential gets a ref,
    // so this run finds its own copy in the library, and every change is
    // refused until a start finishes. An adopted sign-in takes the ref of the
    // file's entry it matched: the file was readable to match it, its tokens
    // are the current ones, and with that ref the next start keeps them
    // instead of moving the restored, spent copy over them.
    const holdAll = () => {
        const held = { ...fromSettings };
        try {
            for (const r of holding) {
                if (r.adopted) {
                    r.ref = r.match;
                    if (r.ref !== r.secret_ref) setRef.run(r.ref, r.id);
                    continue;
                }
                if (!r.ref) {
                    r.ref = REF.test(r.secret_ref || '') ? r.secret_ref : newSecretRef();
                    if (r.ref !== r.secret_ref) setRef.run(r.ref, r.id);
                }
                own(r, r.ref, held);
            }
        } catch { /* the library itself is failing; what was gathered still stands */ }
        heldInLibrary = held;
        cache = null;
    };

    // 2. Everything that touches the credentials file: which copy wins, a
    //    `secret_ref` for each row, the write, and every value read back.
    try {
        sweepTemporaryFiles();
        for (const key of MOVED_SETTING_KEYS) {
            if (!fromSettings[key]) continue;
            const saved = getSecret(key);
            if (saved && saved !== fromSettings[key] && !marked) {
                kept.push(key);
                // The key in use and its origin are one pair: the file's pair
                // stands, and the library is pointed at the file's origin.
                if (key === ACTIVE_KEY) originFromFile = getSecret(ACTIVE_KEY_ORIGIN);
                continue;
            }
            plan[key] = fromSettings[key];
            if (key === ACTIVE_KEY) plan[ACTIVE_KEY_ORIGIN] = fromSettings[ACTIVE_KEY_ORIGIN];
        }
        const taken = new Set(hasConnections ? db.prepare("SELECT secret_ref FROM ai_connections WHERE secret_ref <> ''").all().map(r => r.secret_ref) : []);
        for (const r of holding) {
            if (!REF.test(r.secret_ref || '') && !marked && r.kind === 'chatgpt' && r.credentials) {
                const match = sameAccountEntry(r.credentials, taken);
                // Its ref is written with the clear below: written now, a
                // failed move would leave the spent copy on a row that looks
                // newer than this file.
                if (match) { taken.add(match); adoptedRows.push({ id: r.id, ref: match }); r.adopted = true; r.match = match; continue; }
            }
            // Written BEFORE the file, so a failed move can still find the
            // row's credentials in the library for this run.
            const hadRef = REF.test(r.secret_ref || '');
            r.ref = hadRef ? r.secret_ref : newSecretRef();
            if (r.ref !== r.secret_ref) { setRef.run(r.ref, r.id); taken.add(r.ref); }
            const mine = {};
            own(r, r.ref, mine);
            // A row with its ref already in an UNMARKED library is a copy of
            // this one from a start whose move did not finish: this file's
            // entry for it, if any, is the newer one.
            if (hadRef && !marked && Object.keys(mine).some(name => getSecret(name))) { kept.push(`connection ${r.id}`); continue; }
            Object.assign(plan, mine);
        }
        writeChanges(plan);
        cache = null;   // read back from the disk, not from what was just handed over
        for (const [name, value] of Object.entries(plan)) {
            if (getSecret(name) !== value) throw new Error(`${name} did not read back from ${secretsFile()}`);
        }
    } catch (e) {
        holdAll();
        throw e;
    }

    // From here the file holds them; if the library cannot be cleared, this
    // run still refuses changes, or the next start would find the library's
    // copies and bring back a key deleted in between.
    const prior = db.pragma('secure_delete', { simple: true });
    db.pragma('secure_delete = ON');
    try {
        db.transaction(() => {
            const del = db.prepare('DELETE FROM settings WHERE key = ?');
            for (const key of settingsKeys) del.run(key);
            if (originFromFile) {
                db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(ACTIVE_KEY_ORIGIN, originFromFile);
            }
            if (hasConnections) {
                const clear = db.prepare("UPDATE ai_connections SET api_key = '', credentials = NULL WHERE id = ?");
                for (const r of holding) clear.run(r.id);
                for (const { id, ref } of adoptedRows) setRef.run(ref, id);
            }
            if (hasTable('settings')) mark();
        })();
    } catch (e) {
        holdAll();
        throw e;
    } finally {
        db.pragma(`secure_delete = ${Number(prior) === 2 ? 'FAST' : Number(prior) ? 1 : 0}`);
    }
    compact(db);
    return { moved: Object.values(plan).filter(Boolean).length, kept, adopted: adoptedRows.length };
}

/** Whether this start's move failed, so the library still holds credentials. */
export function credentialsHeldInLibrary() {
    return !!heldInLibrary;
}

/** For a change that writes the library AND this file: refused up front while
 *  the library still holds credentials, so nothing is half-made. */
export function assertCredentialsWritable() {
    if (heldInLibrary) setSecrets({});
}

/**
 * Take every credential out of a COPY of the library: the snapshot of a start
 * whose move did not finish, which is kept for three upgrades and must not
 * keep them that long. The library itself still has them, and the next start
 * that can write moves them.
 */
export function scrubLibraryCopy(copy) {
    const has = (name) => !!copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    copy.pragma('secure_delete = ON');
    copy.transaction(() => {
        if (has('settings')) {
            const del = copy.prepare('DELETE FROM settings WHERE key = ?');
            for (const key of MOVED_SETTING_KEYS) del.run(key);
        }
        if (has('ai_connections')) copy.exec("UPDATE ai_connections SET api_key = '', credentials = NULL");
    })();
    copy.exec('VACUUM');
}

/** The ref of a saved ChatGPT sign-in for the same account and issued client,
 *  if no row of this library already holds it. */
function sameAccountEntry(rawCredentials, taken) {
    let wanted;
    try { wanted = JSON.parse(rawCredentials); } catch { return ''; }
    if (!wanted?.subject || !wanted?.client_id) return '';
    for (const name of savedNames()) {
        const m = /^connection:([A-Za-z0-9_-]+):credentials$/.exec(name);
        if (!m || taken.has(m[1])) continue;
        try {
            const saved = JSON.parse(getSecret(name));
            if (saved?.subject === wanted.subject && saved?.client_id === wanted.client_id) return m[1];
        } catch { /* not a sign-in */ }
    }
    return '';
}

function compact(db) {
    try {
        db.exec('VACUUM');
        // A checkpoint another connection blocks says so in its result
        // rather than throwing, and then the WAL keeps the old pages.
        const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)');
        if (checkpoint?.busy) throw new Error('the WAL is held open by another connection');
        db.prepare('DELETE FROM settings WHERE key = ?').run(COMPACT_PENDING);
    } catch (e) {
        console.warn(`[Secrets] Could not compact the library file (${e.message}). The credentials are gone from its rows, but old copies may remain in unused pages until a later start compacts it.`);
        try { db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(COMPACT_PENDING); } catch { /* retried only if recorded */ }
    }
}
