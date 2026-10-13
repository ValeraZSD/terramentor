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
 * running as the same user can read both. The threat here is the library file
 * travelling, and a separate file answers that completely. The interface is
 * get / set / delete, so a keychain can stand behind it later without a
 * caller changing.
 *
 * THE FILE. `paths.js` names it (`<library>.secrets.json` beside the
 * database, or SECRETS_PATH). JSON, written whole: to a temporary file in the
 * same folder, flushed to disk, then renamed over the old one, so a crash
 * leaves the old file or the new one and never half of either. Created
 * owner-read-write only (0600) where the platform has modes; on Windows it
 * takes the folder's access list, and the per-user app-data folder is the
 * user's own. Read through a cache checked against the file's size and time
 * on every read, so another process's write (a batch tool refreshing a
 * ChatGPT token) is seen.
 *
 * This is the only module that opens the file. `tools/secrets-gates.mjs`
 * holds that, and that no credential is written into the library again.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
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

function load() {
    const path = secretsFile();
    let st;
    try { st = statSync(path, { throwIfNoEntry: false }); } catch { st = { mtimeMs: -1, size: -1 }; }
    if (!st) {
        cache = { path, mtimeMs: 0, size: -1, secrets: {}, unreadable: false };
        return cache;
    }
    if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size && st.size >= 0) return cache;
    const secrets = {};
    let unreadable = false;
    try {
        const doc = JSON.parse(readFileSync(path, 'utf8'));
        if (doc?.format !== FORMAT || !doc.secrets || typeof doc.secrets !== 'object') throw new Error('not a credentials file');
        for (const [name, value] of Object.entries(doc.secrets)) {
            if (typeof value === 'string' && value) secrets[name] = value;
        }
    } catch (e) {
        // Read as empty, said once: every connection then asks for its key,
        // which is true. The file itself is kept aside on the next write.
        unreadable = true;
        if (warned !== path) {
            warned = path;
            console.error(`[Secrets] ${path} could not be read (${e.message}). Saved keys are unavailable until it is fixed; the next key saved keeps it aside as .unreadable-<time>.`);
        }
    }
    cache = { path, mtimeMs: st.mtimeMs, size: st.size, secrets, unreadable };
    return cache;
}

/** One credential, or '' when none is saved. */
export function getSecret(name) {
    return load().secrets[name] || '';
}

const NAME = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9_-]+)*$/;

/**
 * Change several credentials in ONE write: a key and the origin it is bound
 * to land together or not at all. `''` or null deletes. Returns whether the
 * file changed; nothing is written when nothing would.
 */
export function setSecrets(changes) {
    const current = load();
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

function write(current, secrets) {
    const path = current.path;
    mkdirSync(dirname(path), { recursive: true });
    if (current.unreadable) {
        // Never written over: whatever it held may still be recoverable by hand.
        try { renameSync(path, `${path}.unreadable-${Date.now()}`); } catch { /* gone already */ }
    }
    const sorted = Object.fromEntries(Object.keys(secrets).sort().map(k => [k, secrets[k]]));
    const body = `${JSON.stringify({ format: FORMAT, version: VERSION, about: ABOUT, secrets: sorted }, null, 2)}\n`;
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
        writeSync(fd, body);
        fsyncSync(fd);
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
    }
    const st = statSync(path);
    cache = { path, mtimeMs: st.mtimeMs, size: st.size, secrets, unreadable: false };
}

/** Windows refuses a rename over a file another process (an indexer, an
 *  antivirus scan) holds open for a moment: wait briefly and try again. */
function renameOver(from, to) {
    for (let attempt = 0; ; attempt++) {
        try { renameSync(from, to); return; } catch (e) {
            if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    }
}

// ── moving them out of a library that still holds them ────────────────────

const COMPACT_PENDING = 'secrets_compact_pending';

/**
 * Move every credential the library file still holds into this file: the
 * settings rows above, and each saved connection's key and sign-in. Runs on
 * every start (database.js), BEFORE the pre-upgrade snapshot, so the snapshot
 * of this upgrade carries none. Once moved there is nothing left to find, so
 * a second start changes nothing.
 *
 * The order is what makes it lossless: write this file, read every value back
 * from DISK, and only then clear the library's copy. Any failure before the
 * clear leaves the library as it was, to be moved on the next start.
 *
 * A credential found in the library replaces this file's copy. It can only be
 * there because a build older than this one wrote it, or because an older
 * library was restored on purpose; either way it is what the library in use
 * last had. A restored connection with no `secret_ref` gets a fresh one, so
 * it never inherits another connection's entry here.
 *
 * Clearing a row does not clear the bytes: SQLite leaves deleted content in
 * free pages and in the WAL. So the deletes run with `secure_delete`, and the
 * file is then compacted (VACUUM) and its WAL truncated, once. A compaction
 * that fails (a full disk) is retried on the next start.
 */
export function moveSecretsOutOfLibrary(db) {
    const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const plan = {};
    const settingsKeys = [];
    const rows = [];

    if (hasTable('settings')) {
        const read = db.prepare('SELECT value FROM settings WHERE key = ?');
        for (const key of MOVED_SETTING_KEYS) {
            const row = read.get(key);
            if (!row) continue;
            settingsKeys.push(key);
            if (row.value) plan[key] = String(row.value);
        }
        // The key travels with the origin it was bound to; the library keeps
        // its own copy of the origin, and a key is sent only when they agree.
        if (plan[ACTIVE_KEY]) plan[ACTIVE_KEY_ORIGIN] = read.get(ACTIVE_KEY_ORIGIN)?.value || '';
    }

    if (hasTable('ai_connections')) {
        const cols = db.prepare('PRAGMA table_info(ai_connections)').all().map(c => c.name);
        if (!cols.includes('secret_ref')) db.exec("ALTER TABLE ai_connections ADD COLUMN secret_ref TEXT NOT NULL DEFAULT ''");
        const held = db.prepare(`SELECT id, api_key, key_origin, credentials, secret_ref FROM ai_connections
            WHERE COALESCE(api_key, '') <> '' OR COALESCE(credentials, '') <> ''`).all();
        for (const r of held) {
            const ref = r.secret_ref || newSecretRef();
            if (r.api_key) {
                plan[connectionSecret(ref, 'api_key')] = r.api_key;
                plan[connectionSecret(ref, 'key_origin')] = r.key_origin || '';
            }
            if (r.credentials) plan[connectionSecret(ref, 'credentials')] = r.credentials;
            rows.push({ id: r.id, ref });
        }
    }

    if (!settingsKeys.length && !rows.length) {
        if (hasTable('settings') && db.prepare('SELECT 1 FROM settings WHERE key = ?').get(COMPACT_PENDING)) compact(db);
        return { moved: 0, replaced: [] };
    }

    const replaced = Object.keys(plan).filter(k => plan[k] && getSecret(k) && getSecret(k) !== plan[k]);
    setSecrets(plan);
    cache = null;   // read back from the disk, not from what was just handed over
    for (const [name, value] of Object.entries(plan)) {
        if (getSecret(name) !== value) throw new Error(`${name} did not read back from ${secretsFile()}`);
    }

    const prior = db.pragma('secure_delete', { simple: true });
    db.pragma('secure_delete = ON');
    try {
        db.transaction(() => {
            const del = db.prepare('DELETE FROM settings WHERE key = ?');
            for (const key of settingsKeys) del.run(key);
            const clear = db.prepare("UPDATE ai_connections SET api_key = '', credentials = NULL, secret_ref = ? WHERE id = ?");
            for (const { id, ref } of rows) clear.run(ref, id);
        })();
    } finally {
        db.pragma(`secure_delete = ${Number(prior) || 0}`);
    }
    compact(db);
    return { moved: Object.values(plan).filter(Boolean).length, replaced };
}

function compact(db) {
    try {
        db.prepare('DELETE FROM settings WHERE key = ?').run(COMPACT_PENDING);
        db.exec('VACUUM');
        db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
        console.warn(`[Secrets] Could not compact the library file (${e.message}). The credentials are gone from its rows, but old copies may remain in unused pages until the next start compacts it.`);
        try { db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(COMPACT_PENDING); } catch { /* retried only if recorded */ }
    }
}
