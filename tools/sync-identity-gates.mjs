// tools/sync-identity-gates.mjs — every row that may leave a library has a
// name both copies agree on.
//
// Run:  node tools/sync-identity-gates.mjs
//
// Two copies of one library (a desktop and a laptop, a backup restored on a
// new computer) can only be merged if a row means the same row in both. The
// integer id does not: it is handed out per file. This asserts:
//
//   * every table a library holds is classed in server/syncTables.js, and every
//     synced table carries a uuid column (with its trigger and UNIQUE index) or
//     a declared natural key that is text;
//   * a row inserted by any path gets a uuid;
//   * a library from before the uuid columns, opened by this build, keeps every
//     row of every table and gives every one of them a uuid; two copies of that
//     library give their old rows the SAME uuids, two identical reviews in one
//     millisecond get different ones, and a second boot changes none;
//   * study time is keyed by device, and the migration moves no total;
//   * per-project settings are keyed by the project's uuid, old id-keyed rows
//     are moved, and a row naming no project is dropped;
//   * every settings row is classed library or device;
//   * no INSERT OR REPLACE / REPLACE INTO in server/ writes a synced table
//     (REPLACE deletes the row it replaces, and with it the row's uuid).
//
// No model calls, no network. Scratch database and vault, set IN-PROCESS
// before anything is imported.

import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const B = new URL('../server/', import.meta.url).href;

// Open a library in its own process: the migrations run when database.js is
// first imported, so that is the only honest way to exercise them.
if (process.argv[2] === '--boot-only') {
    process.env.DB_PATH = process.argv[3];
    process.env.VAULT_ROOT = process.argv[4];
    const { default: bootDb } = await import(B + 'database.js');
    bootDb.close();
    process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), 'sync-identity-gates-'));
const DB_PATH = join(scratch, 'test.db');
const VAULT_ROOT = join(scratch, 'vault');
process.env.DB_PATH = DB_PATH;
process.env.VAULT_ROOT = VAULT_ROOT;

const { default: db } = await import(B + 'database.js');
const {
    SYNC_TABLES, UUID_TABLES, FIRST_UUID_TABLES, SYNCED_CLASSES, LOCAL_DEVICE, isSyncedTable, derivedUuid,
} = await import(B + 'syncTables.js');
const { SETTINGS, SETTING_FAMILIES, SETTING_SCOPES, PROJECT_SETTING_PREFIXES, settingScope } = await import(B + 'settingsSchema.js');
const { isSecretSettingKey } = await import(B + 'auth.js');
const { settingKeysInServer } = await import('./lib/settingKeysInSource.mjs');
const { projectTeaches, setProjectTeaches } = await import(B + 'nodeRole.js');
const { getNewPerDay, setNewPerDay } = await import(B + 'decks.js');

const Database = db.constructor;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Real tables of a library: no SQLite internals, no shadow tables of a virtual one. */
function tablesOf(conn) {
    const all = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    const virtual = all.filter(t => /CREATE VIRTUAL TABLE/i.test(t.sql || '')).map(t => t.name);
    return all.map(t => t.name).filter(n => !virtual.some(v => n.startsWith(`${v}_`))).sort();
}
const columnsOf = (conn, table) => conn.prepare(`PRAGMA table_info("${table}")`).all();

// ============================================================================
console.log('--- every table is classed, every synced table has an identity ---');
const fresh = tablesOf(db);
check('every table of a new library is in syncTables.js', fresh.filter(t => !SYNC_TABLES[t]), []);
check('every class is one this file knows',
    Object.entries(SYNC_TABLES).filter(([, t]) => !SYNCED_CLASSES.has(t.class)
        && !['derived', 'cache', 'index', 'device'].includes(t.class)).map(([n]) => n), []);
const synced = Object.keys(SYNC_TABLES).filter(isSyncedTable);
check('a synced table has a uuid or a natural key, not both, not neither',
    synced.filter(t => !!SYNC_TABLES[t].uuid === !!SYNC_TABLES[t].natural), []);
check('every synced uuid table has its uuid column',
    UUID_TABLES.filter(t => !columnsOf(db, t).some(c => c.name === 'uuid')), []);
check('...a UNIQUE index on it',
    UUID_TABLES.filter(t => !db.prepare(`SELECT 1 FROM pragma_index_list('${t}') il
        WHERE il."unique" = 1 AND EXISTS (SELECT 1 FROM pragma_index_info(il.name) ii WHERE ii.name = 'uuid')`).get()), []);
check('...and the trigger that names a new row',
    UUID_TABLES.filter(t => !db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(`${t}_uuid_ai`)), []);
check('a natural key is the text primary key',
    synced.filter(t => SYNC_TABLES[t].natural).filter(t => {
        const col = columnsOf(db, t).find(c => c.name === SYNC_TABLES[t].natural);
        return !col || col.pk !== 1 || !/TEXT/i.test(col.type);
    }), []);
check('a table with history but no parent order is impossible: parents come first',
    UUID_TABLES.flatMap((t, i) => (SYNC_TABLES[t].derive?.parents || [])
        .filter(([, p]) => !(UUID_TABLES.indexOf(p) < i)).map(([, p]) => `${t} <- ${p}`)), []);
check('a derived name never reads an integer id (no FK column or id among its inputs)',
    UUID_TABLES.flatMap(t => {
        const spec = SYNC_TABLES[t].derive;
        if (!spec) return [];
        const fks = db.prepare(`SELECT "from" FROM pragma_foreign_key_list('${t}')`).pluck().all();
        const inputs = [spec.at, ...spec.kind].filter(Boolean);
        return inputs.filter(c => c === 'id' || fks.includes(c) || spec.parents.some(([pc]) => pc === c)).map(c => `${t}.${c}`);
    }), []);
check('every table that gained its uuid with this list says how an old row is named',
    UUID_TABLES.filter(t => !FIRST_UUID_TABLES.includes(t) && !SYNC_TABLES[t].derive), []);

// ============================================================================
// One row in every synced table, through plain INSERTs that never name a uuid.
function seed(conn, tag) {
    const one = (sql, ...args) => Number(conn.prepare(sql).run(...args).lastInsertRowid);
    const p = one('INSERT INTO projects (name) VALUES (?)', `Fixture ${tag}`);
    const n = one('INSERT INTO nodes (project_id, title) VALUES (?, ?)', p, `Topic ${tag}`);
    const c = one("INSERT INTO flashcards (node_id, front, back) VALUES (?, 'de krant', 'газета')", n);
    one("INSERT INTO resources (node_id, title, url) VALUES (?, 'Link', 'https://example.org/')", n);
    // Two identical reviews in one millisecond: the collision the derived names must survive.
    for (let i = 0; i < 2; i++) one("INSERT INTO review_log (card_id, reviewed_at, rating, source) VALUES (?, '2026-11-01T10:00:00.000Z', 3, 'app')", c);
    one("INSERT INTO review_log (card_id, reviewed_at, rating, source) VALUES (?, '2026-11-02T10:00:00.000Z', 1, 'app')", c);
    const q = one("INSERT INTO quizzes (node_id, title, questions) VALUES (?, 'Q', '[]')", n);
    one("INSERT INTO quiz_attempts (quiz_id, score, total, answers, created_at) VALUES (?, 1, 2, '[]', '2026-11-01 10:00:00')", q);
    one("INSERT INTO question_log (quiz_id, question_index, node_id, surface, correct, asked_at) VALUES (?, 0, ?, 'feed', 1, '2026-11-01T10:00:00.000Z')", q, n);
    const e = one("INSERT INTO mastery_evidence (node_id, evidence_type, score, total, created_at) VALUES (?, 'quiz', 1, 2, '2026-11-01T10:00:00.000Z')", n);
    one("INSERT INTO sitting_reviews (evidence_id, items, created_at) VALUES (?, '[]', '2026-11-01T10:00:00.000Z')", e);
    one("INSERT INTO paper_attempts (node_id, mode, created_at) VALUES (?, 'check', '2026-11-01T10:00:00.000Z')", n);
    const conv = one("INSERT INTO chat_conversations (title, node_id, created_at, updated_at) VALUES ('T', ?, '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z')", n);
    const m = one("INSERT INTO chat_messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'hi', '2026-11-01T10:00:00.000Z')", conv);
    one("INSERT INTO chat_attachments (conversation_id, message_id, name, kind, file_type, file_hash, file_size, created_at) VALUES (?, ?, 'a.txt', 'text', 'txt', 'h1', 1, '2026-11-01T10:00:00.000Z')", conv, m);
    const d = one("INSERT INTO documents (node_id, project_id, title, content, file_hash, created_at) VALUES (?, ?, 'Doc', 'text', 'dh', '2026-11-01 10:00:00')", n, p);
    one('INSERT INTO node_sources (node_id, document_id, page_from, page_to) VALUES (?, ?, 1, 2)', n, d);
    one("INSERT INTO media_files (project_id, hash, filename, mime, kind, created_at) VALUES (?, ?, 'a.png', 'image/png', 'image', '2026-11-01 10:00:00')", p, `mh-${tag}`);
    one("INSERT INTO placement_probes (project_id, created_at) VALUES (?, '2026-11-01 10:00:00')", p);
    one("INSERT INTO assistant_edits (kind, target_id, source, before, after, applied_at) VALUES ('project', ?, 'chat', '{}', '{}', '2026-11-01T10:00:00.000Z')", p);
    one("INSERT INTO item_reports (kind, item_key, node_id, project_id, reason, item, created_at) VALUES ('question', 'q:x', ?, ?, 'wrong', '{}', '2026-11-01T10:00:00.000Z')", n, p);
    one("INSERT INTO mastery_claims (node_id, source, correct, created_at) VALUES (?, 'mcp', 1, '2026-11-01T10:00:00.000Z')", n);
    one("INSERT INTO answer_attempts (surface, attempt_id, outcome, created_at) VALUES ('feed', ?, 'right', '2026-11-01 10:00:00')", `att-${tag}`);
    one("INSERT INTO study_time (node_id, hour, activity, active_ms) VALUES (?, '2026-11-01T10', 'reading', 600000)", n);
    one("INSERT INTO study_time (node_id, hour, activity, active_ms) VALUES (?, '2026-11-01T11', 'cards', 120000)", n);
    const conn2 = one("INSERT INTO ai_connections (kind, created_at) VALUES ('openai', '2026-11-01T10:00:00.000Z')");
    one("INSERT INTO ai_job_routes (job, position, connection_id, model) VALUES (?, 0, ?, 'm')", `job-${tag}`, conn2);
    return { p, n, c };
}

console.log('--- a row inserted by any path gets a uuid ---');
const fx = seed(db, 'fresh');
check('every synced uuid table has a row to look at', UUID_TABLES.filter(t => !db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get()), []);
check('...and every row a v4 uuid',
    UUID_TABLES.filter(t => db.prepare(`SELECT uuid FROM ${t}`).pluck().all().some(u => !V4.test(u || ''))), []);
check('two rows never share one (UNIQUE refuses a copy)', (() => {
    const [a, b] = db.prepare('SELECT rowid AS r, uuid FROM review_log ORDER BY rowid LIMIT 2').all();
    try { db.prepare('UPDATE review_log SET uuid = ? WHERE rowid = ?').run(a.uuid, b.r); return 'allowed'; }
    catch (err) { return /UNIQUE/.test(err.message) ? 'refused' : err.message; }
})(), 'refused');
check('an importer may still bring its own uuid',
    db.prepare("INSERT INTO quizzes (node_id, title, questions, uuid) VALUES (?, 'own', '[]', '11111111-2222-4333-8444-555555555555') RETURNING uuid").pluck().get(fx.n),
    '11111111-2222-4333-8444-555555555555');

console.log('--- the derived name ---');
check('the same parts give the same uuid', derivedUuid(['review_log', 'a', 't', 3]), derivedUuid(['review_log', 'a', 't', 3]));
check('...a v5 uuid', V5.test(derivedUuid(['x'])), true);
check('...and different parts a different one', derivedUuid(['review_log', 'a', 't', 3]) !== derivedUuid(['review_log', 'a', 't', 4]), true);

// ============================================================================
console.log('--- per-project settings are keyed by the project uuid ---');
const pUuid = db.prepare('SELECT uuid FROM projects WHERE id = ?').pluck().get(fx.p);
setProjectTeaches(fx.p, false);
setNewPerDay(fx.p, 7);
check('the teach switch is stored under the uuid', db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(`teach_topics_${pUuid}`), '0');
check('...and read back', projectTeaches(fx.p), false);
check('the daily new cards are stored under the uuid', db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(`deck_new_per_day_${pUuid}`), '7');
check('...and read back', getNewPerDay(fx.p), 7);
check('no per-project row is keyed by an integer id',
    PROJECT_SETTING_PREFIXES.flatMap(pre => db.prepare('SELECT key FROM settings WHERE key GLOB ?').pluck().all(`${pre}[0-9]*`)
        .filter(k => /^\d+$/.test(k.slice(pre.length)))), []);
check('a project that does not exist gets no row', (setProjectTeaches(999999, true),
    db.prepare("SELECT COUNT(*) FROM settings WHERE key GLOB 'teach_topics_*'").pluck().get()), 1);

// ============================================================================
console.log('--- every settings row is library or device ---');
const scoped = [...SETTING_SCOPES.library, ...SETTING_SCOPES.device];
check('no name is in both lists', SETTING_SCOPES.library.filter(k => SETTING_SCOPES.device.includes(k)), []);
check('every row of the registry has a class', Object.keys(SETTINGS).filter(k => !scoped.includes(k)), []);
check('every family has a class', SETTING_FAMILIES.map(f => f.prefix).filter(p => !scoped.includes(p)), []);
check('the lists name nothing the registry does not',
    scoped.filter(k => !Object.hasOwn(SETTINGS, k) && !SETTING_FAMILIES.some(f => f.prefix === k)), []);
check('every row the server names is classed or a credential',
    [...settingKeysInServer(repoRoot).keys()].filter(k => {
        if (k.endsWith('*')) return !scoped.includes(k.slice(0, -1));
        return !settingScope(k) && !isSecretSettingKey(k);
    }), []);
check('a credential is in neither list', ['ai_openai_api_key', 'auth_password_hash'].map(settingScope), [null, null]);
check('the theme stays on its computer; the threshold follows the library',
    [settingScope('theme'), settingScope('mastery_threshold'), settingScope(`deck_new_per_day_${pUuid}`), settingScope('bulk_avg_ms_flashcards')],
    ['device', 'library', 'library', 'device']);
check('no row that names an address or a model travels',
    Object.entries(SETTINGS).filter(([k, s]) => (s.sensitivity === 'network' || /_url$|_model$/.test(k)) && settingScope(k) === 'library').map(([k]) => k), []);

// ============================================================================
console.log('--- study time is counted per device ---');
const stCols = columnsOf(db, 'study_time');
check('the key is topic, hour, activity and device',
    stCols.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name), ['node_id', 'hour', 'activity', 'device']);
check('a row written with no device is this one', db.prepare('SELECT DISTINCT device FROM study_time').pluck().all(), [LOCAL_DEVICE]);
db.prepare("INSERT INTO study_time (node_id, hour, activity, active_ms, device) VALUES (?, '2026-11-01T10', 'reading', 60000, 'laptop')").run(fx.n);
check('another device in the same hour adds its own row, and the total is the sum',
    db.prepare("SELECT COUNT(*) AS rows, SUM(active_ms) AS ms FROM study_time WHERE node_id = ? AND hour = '2026-11-01T10'").get(fx.n),
    { rows: 2, ms: 660000 });

// ============================================================================
console.log('--- no REPLACE writes a synced table ---');
const REPLACE_RE = /\b(?:INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO)\s+[`"']?(\w+)/gi;
function replaceSites(text) {
    const out = [];
    for (const m of text.matchAll(REPLACE_RE)) {
        const line = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index);
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        if (!SYNC_TABLES[m[1]] || isSyncedTable(m[1])) out.push(m[1]);
    }
    return out;
}
check('the scan sees one (red run on a planted line)', replaceSites("db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')"), ['settings']);
check('...and one written REPLACE INTO, across a line break', replaceSites('REPLACE\n    INTO sitting_reviews (a) VALUES (1)'), ['sitting_reviews']);
check('...and an unclassed table counts as synced', replaceSites('INSERT OR REPLACE INTO brand_new_table VALUES (1)'), ['brand_new_table']);
const walk = (dir) => readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});
check('server/ holds none', walk(join(repoRoot, 'server')).flatMap(f =>
    replaceSites(readFileSync(f, 'utf8')).map(t => `${relative(repoRoot, f).replace(/\\/g, '/')}: ${t}`)), []);

// ============================================================================
console.log('--- a library from before the uuid columns ---');
// The library above, put back into the shape the previous build left: the new
// columns, their triggers and indexes gone, study_time keyed without device,
// per-project rows keyed by the integer id, and one such row for a project
// that no longer exists.
const OLD = join(scratch, 'old.db');
db.prepare('DELETE FROM settings WHERE key GLOB ?').run('teach_topics_*');
setProjectTeaches(fx.p, false);
db.pragma('wal_checkpoint(TRUNCATE)');
copyFileSync(DB_PATH, OLD);
{
    const old = new Database(OLD);
    old.pragma('foreign_keys = OFF');
    for (const t of UUID_TABLES.filter(x => !FIRST_UUID_TABLES.includes(x))) {
        old.exec(`DROP TRIGGER IF EXISTS ${t}_uuid_ai; DROP INDEX IF EXISTS idx_${t}_uuid; ALTER TABLE ${t} DROP COLUMN uuid;`);
    }
    old.exec(`
        DELETE FROM study_time WHERE device <> '${LOCAL_DEVICE}';
        CREATE TABLE study_time_old (node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, hour TEXT NOT NULL,
            activity TEXT NOT NULL, active_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (node_id, hour, activity));
        INSERT INTO study_time_old SELECT node_id, hour, activity, active_ms FROM study_time;
        DROP TABLE study_time; ALTER TABLE study_time_old RENAME TO study_time;
    `);
    for (const pre of PROJECT_SETTING_PREFIXES) old.prepare('UPDATE settings SET key = ? WHERE key = ?').run(`${pre}${fx.p}`, `${pre}${pUuid}`);
    old.prepare("INSERT INTO settings (key, value) VALUES ('teach_topics_999999', '1')").run();
    old.close();
}
const counts = (file) => {
    const c = new Database(file, { readonly: true });
    const out = Object.fromEntries(tablesOf(c).filter(t => SYNC_TABLES[t] && !['index'].includes(SYNC_TABLES[t].class))
        .map(t => [t, c.prepare(`SELECT COUNT(*) FROM "${t}"`).pluck().get()]));
    c.close();
    return out;
};
const uuidsOf = (file) => {
    const c = new Database(file, { readonly: true });
    const out = Object.fromEntries(UUID_TABLES.map(t => [t, c.prepare(`SELECT rowid AS r, uuid FROM ${t} ORDER BY rowid`).all()]));
    c.close();
    return out;
};
const before = counts(OLD);
const oldCols = (() => { const c = new Database(OLD, { readonly: true }); const r = columnsOf(c, 'review_log').map(x => x.name); c.close(); return r; })();
check('the fixture really is old: review_log has no uuid', oldCols.includes('uuid'), false);
const stTotal = (file) => { const c = new Database(file, { readonly: true }); const r = c.prepare('SELECT SUM(active_ms) FROM study_time').pluck().get(); c.close(); return r; };
const totalBefore = stTotal(OLD);

const COPY = join(scratch, 'copy.db');
copyFileSync(OLD, COPY);
const boot = (file) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--boot-only', file, join(scratch, 'vault-boot')], { encoding: 'utf8' });
for (const f of [OLD, COPY]) {
    const r = boot(f);
    check(`opening ${f === OLD ? 'the old library' : 'its copy'} succeeds`, r.status, 0);
    if (r.status !== 0) console.log(r.stderr.slice(0, 2000));
}
const after = counts(OLD);
// `settings` is left out: every boot writes its own rows (the version stamp,
// defaults), and the per-project rows are checked one by one below.
check('every table keeps every row', Object.keys(before).filter(t => t !== 'settings' && before[t] !== after[t])
    .map(t => `${t} ${before[t]} -> ${after[t]}`), []);
const uA = uuidsOf(OLD), uB = uuidsOf(COPY);
check('every row of every uuid table has a uuid', UUID_TABLES.filter(t => uA[t].some(r => !r.uuid)), []);
check('...a v5 uuid named from its content, on the tables that just gained one',
    UUID_TABLES.filter(t => !FIRST_UUID_TABLES.includes(t)).filter(t => uA[t].some(r => !V5.test(r.uuid))), []);
check('two copies of one old library name every old row the same',
    UUID_TABLES.filter(t => JSON.stringify(uA[t]) !== JSON.stringify(uB[t])), []);
const twins = uA.review_log.slice(0, 2).map(r => r.uuid);
check('two identical reviews in one millisecond get two uuids', twins[0] !== twins[1] && twins.every(Boolean), true);
const cFresh = (() => { const c = new Database(OLD, { readonly: true }); const r = c.prepare('SELECT uuid FROM flashcards WHERE id = ?').pluck().get(fx.c); c.close(); return r; })();
check('...and the first one is named from the card and the time alone',
    twins[0], derivedUuid(['review_log', cFresh, '2026-11-01T10:00:00.000Z', 3, 'app', null]));
check('study time keeps its total', stTotal(OLD), totalBefore);
check('...every old row is this device\'s', (() => { const c = new Database(OLD, { readonly: true }); const r = c.prepare('SELECT DISTINCT device FROM study_time').pluck().all(); c.close(); return r; })(), [LOCAL_DEVICE]);
const settingsAfter = (() => { const c = new Database(OLD, { readonly: true }); const r = c.prepare("SELECT key, value FROM settings WHERE key GLOB 'teach_topics_*' OR key GLOB 'deck_new_per_day_*' ORDER BY key").all(); c.close(); return r; })();
check('per-project rows moved to the uuid key, the orphan dropped', settingsAfter,
    [{ key: `deck_new_per_day_${pUuid}`, value: '7' }, { key: `teach_topics_${pUuid}`, value: '0' }].sort((a, b) => a.key.localeCompare(b.key)));
const second = boot(OLD);
check('a second boot succeeds', second.status, 0);
check('...and renames nothing', UUID_TABLES.filter(t => JSON.stringify(uuidsOf(OLD)[t]) !== JSON.stringify(uA[t])), []);

db.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
