// The front desk's own database, `site.db`: who has an account, their
// sessions, the invite links, the sign-in throttle and which library belongs to
// whom. It never holds learning content: that stays in each library's folder.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { sitePaths } from '../paths.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS libraries (
    id          TEXT PRIMARY KEY,
    uid         INTEGER UNIQUE,
    note_key    TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
    id                  INTEGER PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash       TEXT NOT NULL,
    library_id          TEXT NOT NULL UNIQUE REFERENCES libraries(id),
    created_at          TEXT NOT NULL,
    password_changed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
    id          INTEGER PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    email       TEXT NOT NULL COLLATE NOCASE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY,
    account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    device        TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
CREATE TABLE IF NOT EXISTS throttle (
    key           TEXT PRIMARY KEY,
    fails         INTEGER NOT NULL,
    last_fail_at  INTEGER NOT NULL
);
`;

/**
 * Open (and if new, create) a site's database. The folder is made for the
 * front desk alone: libraries pass through it to their own folders but may
 * not list it (0711), and the database itself is 0600.
 */
export function openSiteDb(siteDir) {
    const { root, db: file } = sitePaths(siteDir);
    fs.mkdirSync(root, { recursive: true, mode: 0o711 });
    // Set outright: the front desk runs under a 077 umask (ownerOnlyUmask.js),
    // which would leave the folder closed to the libraries inside it.
    if (process.platform !== 'win32') fs.chmodSync(root, 0o711);
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    if (process.platform !== 'win32') {
        for (const f of [file, `${file}-wal`, `${file}-shm`]) {
            try { fs.chmodSync(f, 0o600); } catch { /* not made yet */ }
        }
    }
    return db;
}

/** ISO now, the form every timestamp in site.db is stored in. */
export const nowIso = (now = Date.now()) => new Date(now).toISOString();
