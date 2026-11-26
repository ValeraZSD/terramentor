// The operator's tool for a site: `node server/site/cli.js <command>`, with
// SITE_DIR set as for the front desk.
//
//   invite <email> [--url https://name]   print a one-time link that makes an account
//   accounts                               list accounts (email, library, created)
//   sign-out <email>                       end every session of an account
//   unlock <email>                         forget its wrong guesses (after 100 the password is off)
//   remove <email>                         delete the account and its library: its rows, sessions,
//                                          invites and folder. A running library is stopped by the
//                                          front desk within half a minute (its next sweep)
//   backup <dir> [--library <id>]          a copy of the site into <dir>, which must not exist:
//                                          site.db through SQLite's backup API, and each library
//                                          under libraries/<id>/ as `hostedCli.js backup` makes it.
//                                          With --library, that one library and no site.db
//   restore <dir> [--erased <file>]        with the front desk STOPPED, put a backup made by
//                                          `backup` in place of the site. A library whose
//                                          SHA-256 of "site:<id>" is a line of <file> (the
//                                          erasure ledger hosted/copy.sh keeps) is left out:
//                                          its account, rows and folder are deleted from the
//                                          restored site.db before that file is put in place
//
// hosted/copy.sh runs backup, remove and restore (docs/HOSTING.md, "Backups").
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openSiteDb } from './siteDb.js';
import { createAccounts, normalEmail } from './accounts.js';
import { sitePaths } from '../paths.js';
import { makePrivateDir, makePrivateFile } from '../privateFiles.js';

const [command, ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (msg) => { console.error(msg); process.exit(1); };

if (!process.env.SITE_DIR) fail('SITE_DIR is not set.');
const siteDir = path.resolve(process.env.SITE_DIR);
const layout = sitePaths(siteDir);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The erasure ledger's key for a site library (hosted/copy.sh hashes the same string). */
const erasureKey = (libraryId) => crypto.createHash('sha256').update(`site:${libraryId}`).digest('hex');

/** `hostedCli.js` against one library's folder, which is what a library's DATA_DIR is. */
function hostedCliOn(libraryDir, cliArgs) {
    const env = { ...process.env, DATA_DIR: libraryDir };
    for (const k of ['DB_PATH', 'VAULT_ROOT', 'SECRETS_PATH']) delete env[k];
    const r = spawnSync(process.execPath, [path.join(appRoot, 'server', 'hostedCli.js'), ...cliArgs], { env, encoding: 'utf8' });
    return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/** Give a restored library's folder back to the library's own user. */
function ownTree(dir, uid) {
    if (process.platform === 'win32' || uid == null) return;
    fs.lchownSync(dir, uid, uid);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) ownTree(p, uid);
        else fs.lchownSync(p, uid, uid);
    }
}

/** Delete an account and its library from a site database (live or about to be restored). */
function forgetLibrary(db, libraryId) {
    const account = db.prepare('SELECT id, email FROM accounts WHERE library_id = ?').get(libraryId);
    db.transaction(() => {
        if (account) {
            db.prepare('DELETE FROM sessions WHERE account_id = ?').run(account.id);
            db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
            db.prepare('DELETE FROM invites WHERE email = ?').run(account.email);
            db.prepare('DELETE FROM throttle WHERE key = ?').run(`acct:${account.email}`);
        }
        db.prepare('DELETE FROM libraries WHERE id = ?').run(libraryId);
    })();
    return account?.email ?? null;
}

async function backupCommand() {
    const dir = args.find((a) => !a.startsWith('--') && a !== flag('--library'));
    const only = flag('--library');
    if (!dir) fail('usage: backup <dir> [--library <id>]');
    if (fs.existsSync(dir)) fail(`${dir} already exists`);
    const db = openSiteDb(siteDir);
    const ids = db.prepare('SELECT id FROM libraries ORDER BY id').all().map((r) => r.id);
    if (only && !ids.includes(only)) fail(`no library ${only}`);
    makePrivateDir(dir);
    if (!only) {
        await db.backup(path.join(dir, 'site.db'));
        makePrivateFile(path.join(dir, 'site.db'));
    }
    db.close();
    makePrivateDir(path.join(dir, 'libraries'));
    let done = 0;
    for (const id of only ? [only] : ids) {
        const to = path.join(dir, 'libraries', id);
        // A library whose first start never made its database is an empty
        // folder in the backup, and an empty library after a restore.
        if (!fs.existsSync(path.join(layout.library(id), 'terramentor.db'))) { makePrivateDir(to); continue; }
        const r = hostedCliOn(layout.library(id), ['backup', to]);
        if (!r.ok) fail(`the backup of library ${id} failed: ${r.out}`);
        done += 1;
    }
    console.log(`site backup ok: ${only ? `library ${only}` : `site.db and ${ids.length} librar${ids.length === 1 ? 'y' : 'ies'}`} (${done} with a database)`);
}

function restoreCommand() {
    const dir = args.find((a) => !a.startsWith('--') && a !== flag('--erased'));
    if (!dir) fail('usage: restore <dir> [--erased <file>]');
    const from = path.join(dir, 'site.db');
    if (!fs.existsSync(from)) fail(`${from} is not there`);
    const erasedFile = flag('--erased');
    const erased = new Set(erasedFile
        ? fs.readFileSync(erasedFile, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((h) => /^[0-9a-f]{64}$/.test(h))
        : []);
    const isErased = (id) => erased.has(erasureKey(id));

    // The backup's site.db is copied beside the live one and the erasures are
    // applied to that copy; only then does it take the live one's place, so
    // no site.db that still holds an erased person is ever where the front
    // desk opens it.
    fs.mkdirSync(layout.root, { recursive: true });
    const incoming = `${layout.db}.restoring`;
    fs.rmSync(incoming, { force: true });
    fs.copyFileSync(from, incoming);
    makePrivateFile(incoming);
    const db = new Database(incoming);
    let kept = [];
    const left = [];
    try {
        const okCheck = db.pragma('quick_check', { simple: true });
        if (okCheck !== 'ok') throw new Error(`the backup's site.db failed its check: ${okCheck}`);
        const rows = db.prepare('SELECT id, uid FROM libraries ORDER BY id').all();
        for (const row of rows) {
            if (isErased(row.id)) { forgetLibrary(db, row.id); left.push(row.id); continue; }
            if (!fs.existsSync(path.join(dir, 'libraries', row.id))) throw new Error(`library ${row.id} is in the backup's site.db but not in the backup`);
            kept.push(row);
        }
        db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
        db.close();
        fs.rmSync(incoming, { force: true });
        fail(`${e.message}; the site is untouched`);
    }
    db.close();
    for (const suffix of ['-wal', '-shm']) fs.rmSync(layout.db + suffix, { force: true });
    fs.renameSync(incoming, layout.db);
    makePrivateFile(layout.db);

    // Erased libraries' folders go whether or not the backup named them.
    fs.mkdirSync(layout.libraries, { recursive: true, mode: 0o711 });
    if (process.platform !== 'win32') fs.chmodSync(layout.libraries, 0o711);
    for (const id of fs.readdirSync(layout.libraries)) {
        if (isErased(id)) { fs.rmSync(layout.library(id), { recursive: true, force: true }); if (!left.includes(id)) left.push(id); }
    }
    const keptIds = new Set(kept.map((r) => r.id));
    for (const row of kept) {
        const target = layout.library(row.id);
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        const src = path.join(dir, 'libraries', row.id);
        if (fs.existsSync(path.join(src, 'terramentor.db'))) {
            const r = hostedCliOn(target, ['restore', src]);
            if (!r.ok) fail(`library ${row.id} could not be restored (${r.out}); restore the site again`);
        }
        if (process.platform !== 'win32') fs.chmodSync(target, 0o700);
        ownTree(target, row.uid);
    }
    for (const id of fs.readdirSync(layout.libraries)) {
        if (!keptIds.has(id)) console.log(`library ${id}: not in this backup; its folder is left as it is`);
    }
    console.log(`erasures reapplied: ${left.length} librar${left.length === 1 ? 'y' : 'ies'} left out`);
    console.log(`site restore ok: ${kept.length} librar${kept.length === 1 ? 'y' : 'ies'}`);
}

if (command === 'backup') {
    await backupCommand();
} else if (command === 'restore') {
    restoreCommand();
} else {
    const db = openSiteDb(siteDir);
    // Accounts are made by the front desk when an invite is used, so the library
    // maker is never called here.
    const accounts = createAccounts(db, { createLibrary: () => { throw new Error('not here'); } });

    if (command === 'invite') {
        const email = args.find((a) => !a.startsWith('--') && a !== flag('--url'));
        if (!email) fail('usage: invite <email> [--url https://name]');
        const base = String(flag('--url') || 'http://localhost:3001').replace(/\/+$/, '');
        try {
            const { token, email: e } = accounts.createInvite(email);
            console.log(`Invite for ${e}, good for 7 days and once:`);
            console.log(`${base}/site/invite/${token}`);
        } catch (e) { fail(e.message); }
    } else if (command === 'accounts') {
        for (const a of accounts.listAccounts()) console.log(`${a.email}\t${a.library_id}\t${a.created_at}`);
    } else if (command === 'sign-out') {
        const email = normalEmail(args[0]);
        const row = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
        if (!row) fail(`no account ${email}`);
        console.log(`Ended ${accounts.endAllSessions(row.id)} session(s) of ${email}.`);
    } else if (command === 'unlock') {
        if (!accounts.unlock(args[0] || '')) fail(`no account ${normalEmail(args[0] || '')}`);
        console.log(`Wrong guesses forgotten for ${normalEmail(args[0])}; the password works again.`);
    } else if (command === 'remove') {
        const email = normalEmail(args[0]);
        const row = db.prepare('SELECT library_id FROM accounts WHERE email = ?').get(email);
        if (!row) fail(`no account ${email}`);
        // The rows first: from here no session or wake reaches the library.
        forgetLibrary(db, row.library_id);
        // Windows (development only) refuses to delete a running library's open
        // files; the front desk's sweep stops it within half a minute.
        for (let waited = 0; ; waited++) {
            try { fs.rmSync(layout.library(row.library_id), { recursive: true, force: true }); break; } catch (e) {
                if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(e.code) || waited >= 60) fail(`account ${email} removed, but its folder could not be deleted (${e.code}): ${layout.library(row.library_id)}`);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
            }
        }
        console.log(`removed ${email}: library ${row.library_id}`);
    } else {
        fail('commands: invite <email> [--url https://name] | accounts | sign-out <email> | unlock <email> | remove <email> | backup <dir> [--library <id>] | restore <dir> [--erased <file>]');
    }
}
