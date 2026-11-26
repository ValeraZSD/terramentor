#!/usr/bin/env node
// The operator's side of a hosted copy (server/hosted.js), run inside the
// copy's container or against its volume. Never started by the server.
//
//   node server/hostedCli.js set-password [--generate]
//       Sets the first password before the copy is ever started, so it never
//       opens unlocked. The password is read from stdin, or with --generate
//       made here and printed once on stdout (four groups of four letters and
//       digits, typed easily on a phone).
//   node server/hostedCli.js backup <dir>
//       An online copy of the library into <dir> (which must not exist): the
//       database through SQLite's backup API, safe while the server runs; the
//       credentials file beside it; the stored files, hard-linked where the
//       file system allows (they are named by their hash and never rewritten).
//   node server/hostedCli.js restore <dir>
//       Puts a backup made by `backup` in place of the library. The copy must
//       be stopped: the database file is replaced, not written through.
//       Exit 1: nothing was replaced. Exit 3: it stopped partway.
//   node server/hostedCli.js restore-state
//       Exit 0 when no restore of this library is unfinished, 3 when one is
//       (its marker is there: a failed or killed restore). copy.sh starts a
//       copy after a failed restore only on 0.
//
// Where the library lives is server/paths.js, as for the server itself.
import { randomInt } from 'node:crypto';
import {
    constants as fsConstants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { restoreMarkerPath } from './hosted.js';
import { dataPaths } from './paths.js';
import { makePrivateDir, makePrivateFile } from './privateFiles.js';
// The credentials file is opened only by secrets.js; this tool asks it.
import { copyCredentialsTo, credentialsAreALink, replaceCredentialsFrom } from './secrets.js';

// stdout carries this tool's answer and nothing else (copy.sh reads the
// generated password from it); what the library says while it opens goes to
// stderr.
const print = (line) => process.stdout.write(`${line}\n`);
console.log = console.error;
console.info = console.error;

const DB_FILE = 'terramentor.db';
const CREDENTIALS_FILE = 'credentials.json';
const VAULT_DIR = 'vault';
// restore's exit code once the library has been partly replaced (copy.sh reads it).
const RESTORE_PARTIAL = 3;

function fail(message) {
    console.error(`hostedCli: ${message}`);
    process.exit(1);
}

/** 16 characters from 32 letters and digits that are not mistaken for each other (80 bits). */
function generatePassword() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const groups = [];
    for (let g = 0; g < 4; g++) {
        let s = '';
        for (let i = 0; i < 4; i++) s += alphabet[randomInt(alphabet.length)];
        groups.push(s);
    }
    return groups.join('-');
}

async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function setPasswordCommand(args) {
    const generate = args.includes('--generate');
    const password = generate ? generatePassword() : await readStdin();
    // Loaded here: auth.js opens the library, which `backup` must not do.
    const { MIN_PASSWORD_LENGTH, isAuthEnabled, setPassword } = await import('./auth.js');
    if (password.length < MIN_PASSWORD_LENGTH) fail(`a password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    if (isAuthEnabled()) fail('this library already has a password; change it in the app');
    await setPassword(password);
    print(generate ? password : 'password set');
}

/** Hard-link every file under `from` into `to`, copying where a link is refused. */
function linkTree(from, to) {
    makePrivateDir(to);
    for (const entry of readdirSync(from, { withFileTypes: true })) {
        const a = join(from, entry.name);
        const b = join(to, entry.name);
        if (entry.isDirectory()) linkTree(a, b);
        else if (entry.isFile()) {
            try {
                linkSync(a, b);
            } catch {
                // A file deleted since the listing (the copy kept running) is
                // simply not in the backup; anything else stops it.
                try { copyFileSync(a, b); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            }
        }
    }
}

/**
 * How many courses a library file holds. This tool opens the file raw, without
 * the migrations, so a library no newer build has opened yet (or a backup of
 * one) has no `live_projects` view; it has no deleted rows either.
 */
function countProjects(file) {
    const hasView = file.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'live_projects'").get();
    return hasView
        ? file.prepare('SELECT COUNT(*) AS n FROM live_projects projects').get().n
        : file.prepare('SELECT COUNT(*) AS n FROM projects /* with deleted */').get().n;
}

async function backupCommand([dir]) {
    if (!dir) fail('usage: backup <dir>');
    if (existsSync(dir)) fail(`${dir} already exists`);
    const { dbPath, vaultRoot } = dataPaths();
    if (!existsSync(dbPath)) fail(`no library at ${dbPath}`);
    // What the backup reads is the library's own: a link (to another library,
    // or out of the folder) is not followed into its archive.
    for (const p of [dbPath, vaultRoot]) {
        let st = null;
        try { st = lstatSync(p); } catch { /* not there */ }
        if (st?.isSymbolicLink()) fail(`${p} is a link, not part of this library; nothing was backed up`);
    }
    if (credentialsAreALink()) fail('the credentials file is a link, not part of this library; nothing was backed up');
    // Its database and credentials may not belong together: saving it as a
    // good backup would let a later restore clear the marker on it.
    if (existsSync(restoreMarkerPath(dbPath))) fail('a restore of this library is unfinished; restore a good backup first');
    makePrivateDir(dir);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        await db.backup(join(dir, DB_FILE));
    } finally {
        db.close();
    }
    makePrivateFile(join(dir, DB_FILE));
    const credentials = copyCredentialsTo(join(dir, CREDENTIALS_FILE));
    if (existsSync(vaultRoot)) linkTree(vaultRoot, join(dir, VAULT_DIR));
    // Read back what was written: a backup nobody opened is a hope.
    const check = new Database(join(dir, DB_FILE), { readonly: true, fileMustExist: true });
    let projects;
    try {
        const ok = check.pragma('quick_check', { simple: true });
        if (ok !== 'ok') fail(`the copy failed its check: ${ok}`);
        projects = countProjects(check);
    } finally {
        check.close();
    }
    const bytes = statSync(join(dir, DB_FILE)).size;
    print(`backup ok: ${projects} project(s), database ${bytes} bytes, credentials ${credentials ? 'included' : 'none'}`);
}

function restoreCommand([dir]) {
    if (!dir) fail('usage: restore <dir>');
    const from = join(dir, DB_FILE);
    if (!existsSync(from)) fail(`${from} is not there`);
    const check = new Database(from, { readonly: true, fileMustExist: true });
    try {
        const ok = check.pragma('quick_check', { simple: true });
        if (ok !== 'ok') fail(`the backup failed its check: ${ok}`);
    } finally {
        check.close();
    }
    const { dbPath, vaultRoot } = dataPaths();
    // Copied beside the library first, so a full disk fails here with the old
    // library still whole; only then is it swapped in.
    // Fresh files at fixed names: whatever is there already (a link, left in a
    // folder its library writes to) is removed, never written through.
    const incoming = `${dbPath}.restoring`;
    try {
        rmSync(incoming, { force: true });
        copyFileSync(from, incoming, fsConstants.COPYFILE_EXCL);
        makePrivateFile(incoming);
    } catch (e) {
        rmSync(incoming, { force: true });
        fail(`could not copy the backup in (${e.message}); the library is untouched`);
    }
    // The marker goes down before anything is replaced and comes off only
    // when every part is in place: a restore killed in between leaves it, and
    // a hosted copy will not start on it (server/hosted.js).
    const marker = restoreMarkerPath(dbPath);
    try {
        rmSync(marker, { force: true });
        writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: 'wx' });
        makePrivateFile(marker);
    } catch (e) {
        rmSync(incoming, { force: true });
        fail(`could not mark the restore as started (${e.message}); the library is untouched`);
    }
    // Every exit above (1) left the library as it was. From here it is being
    // replaced, and a failure says so with its own code: copy.sh then leaves
    // the copy stopped instead of starting it on half a library.
    let projects;
    try {
        // A WAL left by the replaced library would be replayed into the restored one.
        for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
        renameSync(incoming, dbPath);
        if (existsSync(join(dir, CREDENTIALS_FILE))) replaceCredentialsFrom(join(dir, CREDENTIALS_FILE));
        if (existsSync(join(dir, VAULT_DIR))) {
            const aside = `${vaultRoot}.replaced`;
            rmSync(aside, { recursive: true, force: true });
            if (existsSync(vaultRoot)) renameSync(vaultRoot, aside);
            mkdirSync(vaultRoot, { recursive: true });
            linkTree(join(dir, VAULT_DIR), vaultRoot);
            rmSync(aside, { recursive: true, force: true });
        }
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        projects = countProjects(db);
        db.close();
        rmSync(marker);
    } catch (e) {
        console.error(`hostedCli: the restore stopped partway (${e.message}); restore again from a backup`);
        process.exit(RESTORE_PARTIAL);
    }
    print(`restore ok: ${projects} project(s)`);
}

function restoreStateCommand() {
    if (existsSync(restoreMarkerPath(dataPaths().dbPath))) {
        print('restore unfinished');
        process.exit(RESTORE_PARTIAL);
    }
    print('no unfinished restore');
}

const [command, ...args] = process.argv.slice(2);
const commands = {
    'set-password': setPasswordCommand, backup: backupCommand, restore: restoreCommand, 'restore-state': restoreStateCommand,
};
if (!commands[command]) fail('commands: set-password [--generate] | backup <dir> | restore <dir> | restore-state');
await commands[command](args);
// The library's own timers (opened by set-password) must not keep a one-shot alive.
process.exit(0);
