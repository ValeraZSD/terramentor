#!/usr/bin/env node
// tools/schema-backup-gates.mjs — the library is copied before ANY start that
// changes its schema, a copy that cannot be written stops the change, and a
// failed schema step stops the start.
//
// `server/database.js` used to copy the library only when the version string
// in package.json moved, and went on migrating when the copy failed. So a
// build of the same version with new schema (every nightly) changed the
// library with no copy, and a full disk did too. Each case is booted here for
// real, in its own process, on a scratch library:
//
//   1. same version, the library's schema behind the code   -> copy taken
//   2. same version and schema, other migration code        -> copy taken
//   3. a restart with nothing to change                     -> no copy
//   4. the copy cannot be written                           -> no change at all
//      (the library file byte for byte), the start refuses with the keyed
//      message naming the copy and the override
//   5. MIGRATE_WITHOUT_BACKUP=1                             -> migrates anyway
//   6. a column that cannot be added                        -> the start fails
//   7. a library in the oldest shape (no ledger, nodes.status
//      CHECK)                                               -> opens, keeps every
//      row, copied first, the steps that ran are recorded
//   8. both CHECKs still there, with the views over the
//      tables already made                                  -> opens, rebuilt
//   9. many builds of one version                           -> their copies never
//      push out a copy taken before a new version
// plus the pure parts (which copy a start takes, the refusal's words, the
// fingerprint, the room check).
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const root = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const scratchRoot = mkdtempSync(join(tmpdir(), 'schema-backup-gates-'));
let n = 0;

/** A scratch library folder and one start of the app's database module in it, in its own process, env set in process. */
function library() {
    const dir = join(scratchRoot, `lib${++n}`);
    mkdirSync(dir);
    const dbPath = join(dir, 'terramentor.db');
    const launcher = join(dir, 'boot.mjs');
    writeFileSync(launcher, [
        `process.env.DB_PATH = ${JSON.stringify(dbPath)};`,
        `process.env.DATA_DIR = ${JSON.stringify(dir)};`,
        `process.env.VAULT_ROOT = ${JSON.stringify(join(dir, 'vault'))};`,
        'if (process.argv[2] === "override") process.env.MIGRATE_WITHOUT_BACKUP = "1";',
        'else delete process.env.MIGRATE_WITHOUT_BACKUP;',
        // GATE_DB_MODULE names another copy of the module (the pre-fix one, for the control run).
        // The error a failed start throws is printed as its own line, read below:
        // the words the launcher shows are that error's, not the crash dump's.
        'try {',
        `  const m = await import(${JSON.stringify(pathToFileURL(join(root, 'server', process.env.GATE_DB_MODULE || 'database.js')).href)});`,
        '  m.closeDatabase();',
        '} catch (e) {',
        '  console.log("GATE_ERROR " + JSON.stringify({ message: String(e?.message), messageKey: e?.messageKey ?? null, code: e?.code ?? null }));',
        '  process.exit(1);',
        '}',
    ].join('\n'));
    const boot = (mode = '') => {
        const r = spawnSync(process.execPath, [launcher, mode], { cwd: root, encoding: 'utf8' });
        const line = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('GATE_ERROR '));
        return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, error: line ? JSON.parse(line.slice('GATE_ERROR '.length)) : null };
    };
    const open = (opts) => new Database(dbPath, opts);
    const baks = () => readdirSync(dir).filter(f => f.endsWith('.bak')).sort();
    const columns = (file, table) => {
        const db = new Database(file, { readonly: true });
        try { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); } finally { db.close(); }
    };
    const setting = (key) => {
        const db = open({ readonly: true });
        try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null; } finally { db.close(); }
    };
    /** Change the library with a handle of our own, folded back into the main file before the next start. */
    const edit = (fn) => {
        const db = open();
        try { fn(db); db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    };
    return { dir, dbPath, boot, open, baks, columns, setting, edit };
}

/**
 * A library this code made, started twice and closed: the state every later
 * start compares against. Twice, because a library's second start marks that
 * its credentials live in their own file (`secrets_moved_at`, secrets.js),
 * which happens before any snapshot on purpose and is not a schema change.
 */
function currentLibrary() {
    const lib = library();
    for (const which of ['first', 'second']) {
        const r = lib.boot();
        if (r.status !== 0) throw new Error(`the ${which} start of a fresh library failed: ${r.out.slice(0, 400)}`);
    }
    lib.edit((db) => {
        db.prepare("INSERT INTO projects (name) VALUES ('Gate course')").run();
    });
    return lib;
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const tail = (s) => s.split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 400);

// ---------------------------------------------------------------------------
console.log('\n--- 1. same version, schema behind the code ---');
{
    const lib = currentLibrary();
    // What a build of the same version without the newest column left behind.
    lib.edit((db) => db.exec('ALTER TABLE projects DROP COLUMN look_back_skipped_at'));
    check('the library still says this version', lib.setting('app_version') === VERSION, lib.setting('app_version'));
    const r = lib.boot();
    check('the start succeeds', r.status === 0, tail(r.out));
    const copies = lib.baks();
    check('a copy was taken although the version did not change', copies.length === 1, JSON.stringify(copies));
    check(`it is named for the version and the build it was taken from (pre-${VERSION}-build-…)`,
        copies.length === 1 && copies[0].startsWith(`terramentor.db.pre-${VERSION}-build-`), copies[0]);
    check('the copy holds the library as it was, without the column',
        copies.length === 1 && !lib.columns(join(lib.dir, copies[0]), 'projects').includes('look_back_skipped_at'));
    check('the library itself has the column again', lib.columns(lib.dbPath, 'projects').includes('look_back_skipped_at'));
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. same version and schema, other migration code ---');
{
    const lib = currentLibrary();
    // The library was last migrated by another build of this version.
    lib.edit((db) => db.prepare("UPDATE settings SET value = 'feedfacecafe0000' WHERE key = 'schema_code'").run());
    const r = lib.boot();
    check('the start succeeds', r.status === 0, tail(r.out));
    const copies = lib.baks();
    check('a copy was taken: the code that is about to run is not the code that last ran',
        copies.length === 1 && copies[0] === `terramentor.db.pre-${VERSION}-build-feedface.bak`, JSON.stringify(copies));
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. a restart with nothing to change ---');
{
    const lib = currentLibrary();
    const r = lib.boot();
    check('the start succeeds', r.status === 0, tail(r.out));
    check('no copy is taken', lib.baks().length === 0, JSON.stringify(lib.baks()));
    const again = lib.boot();
    check('nor on the next restart', again.status === 0 && lib.baks().length === 0, JSON.stringify(lib.baks()));
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. the copy cannot be written ---');
const OLD = '0.0.1-gate';
function blockedLibrary() {
    const lib = currentLibrary();
    lib.edit((db) => {
        db.prepare("UPDATE settings SET value = ? WHERE key = 'app_version'").run(OLD);
        // English whatever this machine's own language is ('auto' follows it).
        db.prepare("INSERT INTO settings (key, value) VALUES ('ui_language', 'en') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    });
    // Where the copy is written first: a folder with a file in it cannot be
    // removed or written over, as a read-only or full place cannot be written.
    const partial = `${lib.dbPath}.pre-${OLD}.bak.partial`;
    mkdirSync(partial);
    writeFileSync(join(partial, 'keep.txt'), 'x');
    return lib;
}
{
    const lib = blockedLibrary();
    const before = sha(lib.dbPath);
    const schemaOf = () => {
        const db = lib.open({ readonly: true });
        try { return db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all(); } finally { db.close(); }
    };
    const schemaBefore = JSON.stringify(schemaOf());
    const r = lib.boot();
    check('the start is refused', r.status !== 0, `exit ${r.status}: ${tail(r.out)}`);
    check('the library file is unchanged, byte for byte', sha(lib.dbPath) === before);
    const wal = `${lib.dbPath}-wal`;
    check('and nothing waits in its write-ahead log', !existsSync(wal) || readFileSync(wal).length === 0);
    check('its schema is the one it had', JSON.stringify(schemaOf()) === schemaBefore);
    check('it still says the version it was left at', lib.setting('app_version') === OLD, lib.setting('app_version'));
    // Read from the error the module threw, which is what the launcher shows.
    const msg = r.error?.message || '';
    check('the error carries the refusal\'s key',
        typeof r.error?.messageKey === 'string' && r.error.messageKey.startsWith('This version of Terramentor'), JSON.stringify(r.error));
    check('the refusal says the library was not changed',
        /^This version of Terramentor changes how your library is stored/.test(msg) && /so nothing was changed/.test(msg), msg);
    check('it names the copy it could not write', msg.includes(`terramentor.db.pre-${OLD}.bak`), msg);
    check('it names the way to go on without a copy', msg.includes('MIGRATE_WITHOUT_BACKUP=1'), msg);
    check('no copy and no partial file under the real name', lib.baks().length === 0, JSON.stringify(lib.baks()));
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. MIGRATE_WITHOUT_BACKUP=1 ---');
{
    const lib = blockedLibrary();
    const r = lib.boot('override');
    check('the start succeeds', r.status === 0, tail(r.out));
    check('the library is migrated (stamped with this version)', lib.setting('app_version') === VERSION, lib.setting('app_version'));
    check('the log says it went on without a copy', /without a copy/i.test(r.out) && r.out.includes('MIGRATE_WITHOUT_BACKUP'), tail(r.out));
}

// ---------------------------------------------------------------------------
console.log('\n--- 6. a column that cannot be added ---');
{
    const lib = currentLibrary();
    // answer_attempts without its `subject` column, as a view: ALTER TABLE
    // answers "Cannot add a column to a view", which is not "duplicate column".
    lib.edit((db) => {
        const cols = db.prepare('PRAGMA table_info(answer_attempts)').all().map(c => c.name).filter(c => c !== 'subject');
        db.exec(`DROP TABLE answer_attempts; CREATE VIEW answer_attempts AS SELECT ${cols.map(c => `NULL AS "${c}"`).join(', ')}`);
        db.prepare("UPDATE settings SET value = ? WHERE key = 'app_version'").run(OLD);
    });
    const r = lib.boot();
    check('the start fails instead of running without the column', r.status !== 0, `exit ${r.status}: ${tail(r.out)}`);
    check('it names the column and the cause',
        /answer_attempts\.subject/.test(r.error?.message) && /Cannot add a column to a view/.test(r.error?.message), JSON.stringify(r.error) || tail(r.out));
    check('the library is not stamped as migrated', lib.setting('app_version') === OLD, lib.setting('app_version'));
    check('the copy taken before it is there', lib.baks().includes(`terramentor.db.pre-${OLD}.bak`), JSON.stringify(lib.baks()));
}

// ---------------------------------------------------------------------------
console.log('\n--- 7. a library in the oldest shape ---');
{
    const lib = library();
    const oldProjects = [
        [1, 'Physics', 'Waves and light', 0],
        [2, 'Dutch', 'A2 to B1', 1],
    ];
    const oldNodes = [
        [1, 1, null, 'Waves', 'completed', 0],
        [2, 1, 1, 'Interference', 'in_progress', 0],
        [3, 1, 1, 'Diffraction', 'not_started', 1],
        [4, 2, null, 'Word order', 'completed', 0],
    ];
    {
        const db = lib.open();
        db.exec(`
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '',
                color TEXT DEFAULT '#3B82F6', icon TEXT DEFAULT 'folder', position INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, parent_id INTEGER,
                title TEXT NOT NULL, description TEXT DEFAULT '', notes TEXT DEFAULT '',
                status TEXT DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed')),
                position INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE CASCADE);
        `);
        db.prepare("INSERT INTO settings (key, value) VALUES ('app_version', '1.0.0')").run();
        const p = db.prepare('INSERT INTO projects (id, name, description, position) VALUES (?, ?, ?, ?)');
        for (const row of oldProjects) p.run(...row);
        const q = db.prepare('INSERT INTO nodes (id, project_id, parent_id, title, status, position) VALUES (?, ?, ?, ?, ?, ?)');
        for (const row of oldNodes) q.run(...row);
        db.close();
    }
    const r = lib.boot();
    check('it opens', r.status === 0, tail(r.out));
    check('it was copied first, under the version it was left at', lib.baks().includes('terramentor.db.pre-1.0.0.bak'), JSON.stringify(lib.baks()));
    const db = lib.open({ readonly: true });
    try {
        const projects = db.prepare('SELECT id, name, description, position FROM projects ORDER BY id').all().map(Object.values);
        const nodes = db.prepare('SELECT id, project_id, parent_id, title, status, position FROM nodes ORDER BY id').all().map(Object.values);
        check('every course is kept with its values', JSON.stringify(projects) === JSON.stringify(oldProjects), JSON.stringify(projects));
        check('every topic is kept with its values', JSON.stringify(nodes) === JSON.stringify(oldNodes), JSON.stringify(nodes));
        const nodesSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'nodes'").get().sql;
        check('the topic table was rebuilt without its status CHECK', !/CHECK\s*\(\s*status/i.test(nodesSql));
        const steps = db.prepare('SELECT name, app_version FROM schema_ledger').all();
        const names = new Set(steps.map(s => s.name));
        check('the ledger records the rebuild', names.has('rebuild nodes without the status CHECK'), JSON.stringify([...names].slice(0, 6)));
        check('the ledger records a column added to an old table', names.has('add column projects.deadline'));
        check('and which version ran each step', steps.length > 0 && steps.every(s => s.app_version === VERSION));
    } finally { db.close(); }
    const ledgerCount = () => {
        const h = lib.open({ readonly: true });
        try { return h.prepare('SELECT count(*) AS c FROM schema_ledger').get().c; } finally { h.close(); }
    };
    const stepsAfterFirst = ledgerCount();
    const again = lib.boot();
    check('a restart opens it', again.status === 0, tail(again.out));
    check('a restart runs no step', ledgerCount() === stepsAfterFirst, `${stepsAfterFirst} -> ${ledgerCount()}`);
    check('and takes no second copy', lib.baks().length === 1, JSON.stringify(lib.baks()));
}

// ---------------------------------------------------------------------------
console.log('\n--- 8. both CHECKs, with the views over the tables already made ---');
{
    const lib = currentLibrary();
    // A library whose rebuilds never ran while `live_nodes` and the other views
    // came in around the tables: each CHECK put back into the stored table text.
    lib.edit((db) => {
        db.unsafeMode(true);
        db.pragma('writable_schema = ON');
        db.prepare("UPDATE sqlite_master SET sql = replace(sql, 'status TEXT DEFAULT ''not_started''', "
            + "'status TEXT DEFAULT ''not_started'' CHECK (status IN (''not_started'', ''in_progress'', ''completed'', ''skipped''))') WHERE name = 'nodes'").run();
        db.prepare("UPDATE sqlite_master SET sql = replace(sql, 'evidence_type TEXT NOT NULL', "
            + "'evidence_type TEXT NOT NULL CHECK (evidence_type IN (''quiz'', ''flashcard'', ''check''))') WHERE name = 'mastery_evidence'").run();
        db.pragma('writable_schema = OFF');
        db.unsafeMode(false);
        db.prepare("UPDATE settings SET value = ? WHERE key = 'app_version'").run(OLD);
    });
    const sqlOf = (db, name) => db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name)?.sql || '';
    {
        const db = lib.open();
        try {
            check('the fixture: both tables carry their CHECK',
                /CHECK \(status/.test(sqlOf(db, 'nodes')) && /CHECK \(evidence_type/.test(sqlOf(db, 'mastery_evidence')));
            check('the fixture: a view over the topic table exists', !!sqlOf(db, 'live_nodes'));
            const project = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
            const node = db.prepare("INSERT INTO nodes (project_id, title, status) VALUES (?, 'Kept topic', 'completed')").run(project).lastInsertRowid;
            db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total) VALUES (?, 'quiz', 3, 4)").run(node);
            db.pragma('wal_checkpoint(TRUNCATE)');
        } finally { db.close(); }
    }
    const r = lib.boot();
    check('it opens', r.status === 0, JSON.stringify(r.error) || tail(r.out));
    const db = lib.open({ readonly: true });
    try {
        check('the topic table lost its CHECK', !/CHECK \(status/.test(sqlOf(db, 'nodes')));
        check('the evidence table lost its CHECK', !/CHECK \(evidence_type/.test(sqlOf(db, 'mastery_evidence')));
        check('the topic and its evidence are kept', db.prepare(
            "SELECT count(*) AS c FROM nodes n JOIN mastery_evidence e ON e.node_id = n.id WHERE n.title = 'Kept topic' AND e.score = 3").get().c === 1);
        check('the view reads the rebuilt table', db.prepare("SELECT count(*) AS c FROM live_nodes WHERE title = 'Kept topic'").get().c === 1);
        const names = new Set(db.prepare('SELECT name FROM schema_ledger').all().map(s => s.name));
        check('the ledger records both rebuilds',
            names.has('rebuild nodes without the status CHECK') && names.has('rebuild mastery_evidence without the evidence_type CHECK'));
    } finally { db.close(); }
}

// ---------------------------------------------------------------------------
console.log('\n--- 9. many builds of one version ---');
{
    const lib = currentLibrary();
    // Three copies taken before new versions, older than anything below.
    const upgrades = ['1.4.0', '1.5.0', '1.6.0'].map(v => `terramentor.db.pre-${v}.bak`);
    const dayAgo = Date.now() / 1000 - 86400;
    upgrades.forEach((f, i) => {
        writeFileSync(join(lib.dir, f), 'copy');
        utimesSync(join(lib.dir, f), dayAgo + i, dayAgo + i);
    });
    // Three builds of this version, each last migrated by other code.
    for (const code of ['aaaaaaaa00000000', 'bbbbbbbb00000000', 'cccccccc00000000']) {
        lib.edit((db) => db.prepare("UPDATE settings SET value = ? WHERE key = 'schema_code'").run(code));
        const r = lib.boot();
        check(`the start after build ${code.slice(0, 8)} succeeds`, r.status === 0, tail(r.out));
    }
    const left = lib.baks();
    check('every copy taken before a new version is kept', upgrades.every(f => left.includes(f)), JSON.stringify(left));
    check('of the copies taken between builds, only the newest is kept',
        JSON.stringify(left.filter(f => f.includes('-build-'))) === JSON.stringify([`terramentor.db.pre-${VERSION}-build-cccccccc.bak`]),
        JSON.stringify(left));
}

// ---------------------------------------------------------------------------
console.log('\n--- which copy a start takes, and what a refusal says ---');
{
    const guard = await import(pathToFileURL(join(root, 'server', 'schemaGuard.js')).href);
    const { snapshotLabel, snapshotRefusal, schemaFingerprint, roomForCopy } = guard;
    const same = { previousVersion: '1.6.0', version: '1.6.0', recordedFingerprint: 'f1', fingerprint: 'f1', recordedCode: 'c0ffee11aa', code: 'c0ffee11aa' };
    check('nothing recorded differs: no copy', snapshotLabel(same) === null);
    check('a version change: named for the version left', snapshotLabel({ ...same, version: '1.7.0' }) === '1.6.0');
    check('a library from before versions were stamped: "unknown"', snapshotLabel({ ...same, previousVersion: null }) === 'unknown');
    check('the schema moved: named for the version and the build left',
        snapshotLabel({ ...same, fingerprint: 'f2' }) === '1.6.0-build-c0ffee11');
    check('the code moved: the same', snapshotLabel({ ...same, code: 'beef' }) === '1.6.0-build-c0ffee11');
    check('nothing recorded yet: a copy, "unrecorded"',
        snapshotLabel({ ...same, recordedFingerprint: null, recordedCode: null }) === '1.6.0-build-unrecorded');
    check('the code cannot be read: a copy', snapshotLabel({ ...same, code: null }) !== null);

    const full = snapshotRefusal({ target: '/lib/terramentor.db.pre-1.6.0.bak', cause: 'ENOSPC', free: 12.3e6, needed: 845.6e6, lang: 'en' });
    check('a full disk names both sizes in MB',
        /needs about 846 MB/.test(full.message) && /has 12 MB free/.test(full.message), full.message);
    check('it carries its key and values for a translation', typeof full.messageKey === 'string' && full.params?.needed === 846);
    const other = snapshotRefusal({ target: '/lib/x.bak', cause: 'EPERM', lang: 'en' });
    check('another cause is named by its code', /\(EPERM\)/.test(other.message) && other.messageKey !== full.messageKey, other.message);
    const nl = snapshotRefusal({ target: '/lib/x.bak', cause: 'EPERM', lang: 'nl' });
    const nlTable = JSON.parse(readFileSync(join(root, 'src', 'locales', 'nl.json'), 'utf8'));
    check('said in the library\'s interface language', nl.message !== other.message && nl.message.startsWith(nlTable[other.messageKey].slice(0, 20)), nl.message);
    const unknown = snapshotRefusal({ target: '/lib/x.bak', cause: 'EPERM', lang: 'xx' });
    check('a language with no file falls back to English', unknown.message === other.message);

    // The fingerprint leaves out the tables sqlite-vec makes at run time, and nothing else.
    const mem = new Database(':memory:');
    try {
        mem.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
        const before = schemaFingerprint(mem);
        mem.exec('CREATE TABLE vec_chunks_rowids (id INTEGER PRIMARY KEY)');
        check('a table named like sqlite-vec\'s does not move the fingerprint', schemaFingerprint(mem) === before);
        mem.exec('ALTER TABLE notes ADD COLUMN body TEXT');
        check('a column added does', schemaFingerprint(mem) !== before);
    } finally { mem.close(); }

    const sized = join(scratchRoot, 'sized.db');
    writeFileSync(sized, Buffer.alloc(4096));
    const room = roomForCopy(sized);
    check('the room check reads the library\'s size and the free space',
        room?.needed === 4096 && Number.isFinite(room?.free) && room.free > 0, JSON.stringify(room));
}

try { rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
