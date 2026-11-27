// What server/database.js needs to know before it changes a library's schema:
// whether this start will change it, what the copy taken first is called, and
// what to say when that copy cannot be made.
//
// The version string alone cannot answer the first question. A nightly build
// and a checkout carry the version of the last release, so a build that adds a
// column and a build that does not look the same. So a start compares two
// things recorded by the last start that finished migrating (the `settings`
// rows `schema_code` and `schema_fingerprint`) with what it has now:
//
//   - the code that runs the migrations: a hash of database.js and of every
//     module it imports from this folder, so a migration moved into a helper
//     is still counted;
//   - the schema in the file: a hash of `sqlite_master`, less what the app
//     makes while it runs (the sqlite-vec tables, made when embeddings are
//     first stored) and SQLite's own tables.
//
// The same code on the same schema cannot change it, so that start takes no
// copy. Anything else, or anything that cannot be read, takes one.

import { createHash } from 'node:crypto';
import { readFileSync, statSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { KeyedError, fillKey, k } from './clientError.js';

/** The environment variable that lets a start change the schema with no copy. */
export const MIGRATE_WITHOUT_BACKUP = 'MIGRATE_WITHOUT_BACKUP';

const SERVER_DIR = new URL('./', import.meta.url);

/**
 * The migration code this process will run, as 16 hex characters, or null when
 * a source file cannot be read (then the start takes a copy). Line endings are
 * folded so a Windows checkout and a release hash alike.
 */
export function migrationCodeId() {
    try {
        const read = (file) => readFileSync(new URL(file, SERVER_DIR), 'utf8').replace(/\r\n/g, '\n');
        const main = read('database.js');
        const imported = [...main.matchAll(/from '\.\/([\w./-]+\.js)'/g)].map((m) => m[1]);
        const hash = createHash('sha256');
        for (const file of ['database.js', ...[...new Set(imported)].sort()]) {
            hash.update(`${file}\0`).update(file === 'database.js' ? main : read(file)).update('\0');
        }
        return hash.digest('hex').slice(0, 16);
    } catch {
        return null;
    }
}

/** The library's schema as a hash: every table, index, view and trigger the migrations own. */
export function schemaFingerprint(db) {
    const rows = db.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite!_%' ESCAPE '!' AND name NOT LIKE 'vec!_%' ESCAPE '!'
        ORDER BY type, name`).all();
    const hash = createHash('sha256');
    for (const r of rows) hash.update(`${r.type}\0${r.name}\0${r.tbl_name}\0${r.sql ?? ''}\n`);
    return hash.digest('hex').slice(0, 16);
}

/**
 * The name of the copy this start takes before migrating (the part after
 * `.pre-`), or null when it cannot change the schema.
 *
 * A new version is named for the version left, as it always was. The same
 * version is named `<version>-build-<the first 8 characters of the code that
 * last migrated the library>`, so each build of one version gets its own copy,
 * and `-build-` keeps those apart when old copies are pruned (BUILD_COPY).
 * A start that fails half-way records nothing, so its retry gets the same name
 * and keeps the copy of the untouched library (database.js).
 */
export function snapshotLabel({ previousVersion, version, recordedFingerprint, fingerprint, recordedCode, code }) {
    if (version && previousVersion !== version) return previousVersion || 'unknown';
    if (code && recordedCode === code && recordedFingerprint === fingerprint) return null;
    return `${previousVersion || 'unknown'}-build-${recordedCode ? String(recordedCode).slice(0, 8) : 'unrecorded'}`;
}

/** A copy's file name, when it was taken between two builds of one version. */
export const BUILD_COPY = /\.pre-.+-build-[\w]+\.bak$/;

/**
 * The bytes free beside the library and the bytes a copy needs, or null when
 * the free space cannot be read. A copy (`VACUUM INTO`) is at most the main
 * file plus what waits in its write-ahead log.
 */
export function roomForCopy(dbFile) {
    let free;
    try {
        const s = statfsSync(dirname(dbFile));
        free = s.bavail * s.bsize;
    } catch {
        return null;
    }
    const size = (f) => { try { return statSync(f).size; } catch { return 0; } };
    return { free, needed: size(dbFile) + size(`${dbFile}-wal`) };
}

const DISK_FULL = k('This version of Terramentor changes how your library is stored, and first copies it to {{target}}. The copy needs about {{needed}} MB and the disk has {{free}} MB free, so nothing was changed. Free up space and start Terramentor again, or start it once with MIGRATE_WITHOUT_BACKUP=1 to change the library without a copy.');
const NOT_WRITTEN = k('This version of Terramentor changes how your library is stored, and first copies it to {{target}}. The copy could not be written ({{reason}}), so nothing was changed. Make that folder writable and start Terramentor again, or start it once with MIGRATE_WITHOUT_BACKUP=1 to change the library without a copy.');

const FULL_CODES = new Set(['ENOSPC', 'SQLITE_FULL', 'EDQUOT']);

/**
 * The error a start that may not migrate throws. It reaches the person as the
 * desktop app's start-up message (desktop/launcher.js) or the server's last
 * line, so its text is said in the library's interface language here; the key
 * and values travel with it like any refusal (clientError.js).
 */
export function snapshotRefusal({ target, cause, free, needed, lang }) {
    const mb = (bytes) => Math.round(bytes / 1e6);
    const full = FULL_CODES.has(cause) && Number.isFinite(free) && Number.isFinite(needed);
    const err = full
        ? new KeyedError(DISK_FULL, { target, needed: mb(needed), free: mb(free) })
        : new KeyedError(NOT_WRITTEN, { target, reason: cause || 'unknown' });
    err.code = 'SNAPSHOT_FAILED';
    err.message = translated(lang, err.messageKey, err.params);
    return err;
}

/** `key` in `lang` from the app's own translations, filled; English when there is none. */
function translated(lang, key, params) {
    let code = String(lang || '').trim();
    if (!code || code === 'auto') {
        try { code = Intl.DateTimeFormat().resolvedOptions().locale; } catch { code = 'en'; }
    }
    const base = code.split(/[-_]/)[0].toLowerCase();
    if (base !== 'en' && /^[a-z]{2,3}$/.test(base)) {
        try {
            const table = JSON.parse(readFileSync(new URL(`../src/locales/${base}.json`, SERVER_DIR), 'utf8'));
            if (typeof table[key] === 'string' && table[key]) return fillKey(table[key], params);
        } catch { /* no file for this language: English below */ }
    }
    return fillKey(key, params);
}
