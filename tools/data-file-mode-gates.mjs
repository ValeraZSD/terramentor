// tools/data-file-mode-gates.mjs — the library is readable by its owner only.
//
// Run:  node tools/data-file-mode-gates.mjs
//
// On a computer with more than one account, a file created with the usual
// umask (022) can be read by every account: the database, its WAL, the vault's
// originals, the card media, the snapshots taken before an upgrade. Only the
// credentials file was created owner-only. This opens a library in a child
// process (tools/fixtures/data-file-modes.mjs) and reads the permission bits.
//
//   1. A FRESH library: the data directory, the vault and both blob stores are
//      created 0700; the database, -wal, -shm and every stored blob 0600.
//   2. An EXISTING library left by an older version, in a folder others can
//      read: the database is tightened to 0600 on start, the snapshot taken
//      before the upgrade is 0600, and the start-up log says the folder is
//      open to other accounts and how to close it (the folder itself is not
//      changed: DB_PATH may name a folder the app does not own).
//   3. The server process starts with an owner-only umask (077), set before
//      the library is opened, and so does the desktop launcher.
//
// Windows guards files with ACLs, not these bits: Node maps a mode to the
// read-only attribute only, and the per-user data folder (%LOCALAPPDATA%) is
// already closed to other accounts. There, 1 and 2 only check that opening a
// library still works, and 3 still reads the source.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const posix = process.platform !== 'win32';
const child = fileURLToPath(new URL('./fixtures/data-file-modes.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'data-file-mode-gates-'));

/** Run the child against an environment; its one JSON line, or null. */
function open(env) {
    const clean = { ...process.env };
    for (const k of ['DB_PATH', 'VAULT_ROOT', 'DATA_DIR', 'SECRETS_PATH']) delete clean[k];
    const r = spawnSync(process.execPath, [child], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 60_000 });
    const line = String(r.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop();
    if (r.status !== 0 || !line) {
        console.log(String(r.stderr || '').slice(-800));
        return null;
    }
    return JSON.parse(line);
}

if (!posix) console.log('\n(Windows: permission bits are not how this platform guards files; checking that a library still opens)');

console.log('\n--- a fresh library is created owner-only ---');
{
    // Two levels that do not exist yet: the data directory is made by the app.
    const dataDir = join(scratch, 'fresh', 'Terramentor');
    const r = open({ DATA_DIR: dataDir });
    ok('a library opens in a data directory that did not exist', !!r);
    if (r && posix) {
        const m = r.modes;
        ok('the data directory is 0700', m.dataDir === '700', m.dataDir);
        ok('the database is 0600', m.db === '600', m.db);
        ok('…its WAL is 0600', m.wal === '600', m.wal);
        ok('…its shared-memory file is 0600', m.shm === '600', m.shm);
        ok('the vault is 0700', m.vault === '700', m.vault);
        ok('…its originals store is 0700', m.blobs === '700', m.blobs);
        ok('…its card-media store is 0700', m.media === '700', m.media);
        ok('a stored original is 0600', m.blobFile === '600', m.blobFile);
        ok('a stored card picture is 0600', m.mediaFile === '600', m.mediaFile);
        ok('nothing warns about a folder the app made itself', !r.warnings.some(w => /other accounts/i.test(w)), r.warnings.join(' | '));
    }
}

console.log('\n--- an existing library in a folder others can read ---');
{
    const dir = join(scratch, 'shared');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'terramentor.db');
    // An older version's library: a settings table naming the version it was
    // last opened by, so this start takes a snapshot before migrating.
    const old = new Database(dbPath);
    old.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('app_version', '0.0.1');");
    old.close();
    if (posix) { chmodSync(dir, 0o755); chmodSync(dbPath, 0o644); }
    const r = open({ DB_PATH: dbPath, VAULT_ROOT: join(dir, 'vault') });
    ok('the library opens', !!r);
    ok('a snapshot was taken before the upgrade', !!r && r.backups.length === 1, JSON.stringify(r?.backups));
    if (r && posix) {
        ok('the database left 0644 by an older version is now 0600', r.modes.db === '600', r.modes.db);
        ok('…and its WAL 0600', r.modes.wal === '600', r.modes.wal);
        ok('the snapshot before the upgrade is 0600', r.modes.backup === '600', r.modes.backup);
        ok('the folder itself is left as it was (DB_PATH may name a folder the app does not own)', r.modes.dataDir === '755', r.modes.dataDir);
        const said = r.warnings.find(w => /other accounts/i.test(w));
        ok('the start-up log says the folder is open to other accounts', !!said && said.includes(dir), r.warnings.join(' | '));
        ok('…and how to close it', !!said && /chmod -R go-rwx/.test(said), said);
    }
}

console.log('\n--- the server and the launcher start owner-only ---');
{
    const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
    const index = read('../server/index.js');
    const firstImport = (index.match(/^import\s[^;]*?['"]([^'"]+)['"];?\s*$/m) || [])[1];
    ok('server/index.js imports the umask module before anything else', firstImport === './ownerOnlyUmask.js', firstImport);
    const umaskModule = existsSync(new URL('../server/ownerOnlyUmask.js', import.meta.url)) ? read('../server/ownerOnlyUmask.js') : '';
    ok('…which sets the umask to 077', /process\.umask\(\s*0o077\s*\)/.test(umaskModule));
    const launcher = read('../desktop/launcher.js');
    const at = launcher.search(/process\.umask\(\s*0o077\s*\)/);
    const serverImport = launcher.search(/import\(pathToFileURL\(join\(appRoot, 'server', 'index\.js'\)\)/);
    ok('the desktop launcher sets it before it writes its log or starts the server', at > 0 && serverImport > 0 && at < serverImport
        && at < launcher.search(/appendFileSync\(|prepareLogFile\(/));
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
