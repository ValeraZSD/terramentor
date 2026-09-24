#!/usr/bin/env node
// tools/migration-backup-gates.mjs — the snapshot taken before a migration
// survives a RETRY of that migration.
//
// `server/database.js` copies the library to `<db>.pre-<old version>.bak`
// before migrating, and writes the new version stamp only after every
// migration has run. So a start that fails half-way comes back with the same
// old version, and the snapshot it finds is the untouched original. It used to
// delete that file and snapshot the half-migrated library under the same name
// (the first outside audit reproduced it, 2026-09-24). Proved here by booting
// the real module twice, in two processes, against a scratch library.
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const root = fileURLToPath(new URL('..', import.meta.url));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const scratch = mkdtempSync(join(tmpdir(), 'migration-backup-gates-'));
const dbPath = join(scratch, 'terramentor.db');
const OLD = '0.0.1-gate';
const target = `${dbPath}.pre-${OLD}.bak`;

// A library from an older build: a settings table carrying its version, and a
// marker row the migrations never touch.
{
    const db = new Database(dbPath);
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE gate_marker (v TEXT);");
    db.prepare("INSERT INTO settings (key, value) VALUES ('app_version', ?)").run(OLD);
    db.prepare("INSERT INTO gate_marker (v) VALUES ('original')").run();
    db.close();
}

// One start of the app's database module, in its own process, env set in process.
const launcher = join(scratch, 'boot.mjs');
writeFileSync(launcher, [
    `process.env.DB_PATH = ${JSON.stringify(dbPath)};`,
    `process.env.DATA_DIR = ${JSON.stringify(scratch)};`,
    `process.env.VAULT_ROOT = ${JSON.stringify(join(scratch, 'vault'))};`,
    // GATE_DB_MODULE names another copy of the module (the pre-fix one, for the control run).
    `const { default: db } = await import(${JSON.stringify(pathToFileURL(join(root, 'server', process.env.GATE_DB_MODULE || 'database.js')).href)});`,
    'db.close();',
].join('\n'));
const boot = () => spawnSync(process.execPath, [launcher], { cwd: root, encoding: 'utf8' });
const markerIn = (file) => {
    const db = new Database(file, { readonly: true });
    try { return db.prepare('SELECT v FROM gate_marker').get()?.v; } finally { db.close(); }
};

const first = boot();
check('the first start of a new build succeeds', first.status === 0, (first.stderr || '').slice(0, 300));
check('it snapshots the library under the OLD version', existsSync(target));
check('the snapshot holds the untouched library', existsSync(target) && markerIn(target) === 'original');

// A start that failed half-way: data already changed, version stamp still old.
{
    const db = new Database(dbPath);
    db.prepare("UPDATE gate_marker SET v = 'half-migrated'").run();
    db.prepare("UPDATE settings SET value = ? WHERE key = 'app_version'").run(OLD);
    db.close();
}
const second = boot();
check('the retry succeeds', second.status === 0, (second.stderr || '').slice(0, 300));
check('the retry KEEPS the original snapshot rather than replacing it with the half-migrated library',
    existsSync(target) && markerIn(target) === 'original', existsSync(target) ? markerIn(target) : 'snapshot gone');
check('the retry says it kept it', /Keeping the snapshot/.test(second.stdout || ''), (second.stdout || '').slice(0, 200));
check('no partial file is left behind', !readdirSync(scratch).some(f => f.endsWith('.partial')));

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
