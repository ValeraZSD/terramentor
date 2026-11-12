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
//
// Where the library lives is server/paths.js, as for the server itself.
import { randomInt } from 'node:crypto';
import {
    copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { dataPaths } from './paths.js';
import { makePrivateDir, makePrivateFile } from './privateFiles.js';

// stdout carries this tool's answer and nothing else (copy.sh reads the
// generated password from it); what the library says while it opens goes to
// stderr.
const print = (line) => process.stdout.write(`${line}\n`);
console.log = console.error;
console.info = console.error;

const DB_FILE = 'terramentor.db';
const SECRETS_FILE = 'terramentor.secrets.json';
const VAULT_DIR = 'vault';

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
            try { linkSync(a, b); } catch { copyFileSync(a, b); }
        }
    }
}

async function backupCommand([dir]) {
    if (!dir) fail('usage: backup <dir>');
    if (existsSync(dir)) fail(`${dir} already exists`);
    const { dbPath, vaultRoot, secretsPath } = dataPaths();
    if (!existsSync(dbPath)) fail(`no library at ${dbPath}`);
    makePrivateDir(dir);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        await db.backup(join(dir, DB_FILE));
    } finally {
        db.close();
    }
    makePrivateFile(join(dir, DB_FILE));
    if (existsSync(secretsPath)) {
        copyFileSync(secretsPath, join(dir, SECRETS_FILE));
        makePrivateFile(join(dir, SECRETS_FILE));
    }
    if (existsSync(vaultRoot)) linkTree(vaultRoot, join(dir, VAULT_DIR));
    // Read back what was written: a backup nobody opened is a hope.
    const check = new Database(join(dir, DB_FILE), { readonly: true, fileMustExist: true });
    let projects;
    try {
        const ok = check.pragma('quick_check', { simple: true });
        if (ok !== 'ok') fail(`the copy failed its check: ${ok}`);
        projects = check.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
    } finally {
        check.close();
    }
    const bytes = statSync(join(dir, DB_FILE)).size;
    print(`backup ok: ${projects} project(s), database ${bytes} bytes, credentials ${existsSync(join(dir, SECRETS_FILE)) ? 'included' : 'none'}`);
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
    const { dbPath, vaultRoot, secretsPath } = dataPaths();
    // A WAL left by the replaced library would be replayed into the restored one.
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    copyFileSync(from, dbPath);
    makePrivateFile(dbPath);
    if (existsSync(join(dir, SECRETS_FILE))) {
        copyFileSync(join(dir, SECRETS_FILE), secretsPath);
        makePrivateFile(secretsPath);
    }
    if (existsSync(join(dir, VAULT_DIR))) {
        const aside = `${vaultRoot}.replaced`;
        rmSync(aside, { recursive: true, force: true });
        if (existsSync(vaultRoot)) renameSync(vaultRoot, aside);
        mkdirSync(vaultRoot, { recursive: true });
        linkTree(join(dir, VAULT_DIR), vaultRoot);
        rmSync(aside, { recursive: true, force: true });
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
    db.close();
    print(`restore ok: ${projects} project(s)`);
}

const [command, ...args] = process.argv.slice(2);
const commands = { 'set-password': setPasswordCommand, backup: backupCommand, restore: restoreCommand };
if (!commands[command]) fail('commands: set-password [--generate] | backup <dir> | restore <dir>');
await commands[command](args);
// The library's own timers (opened by set-password) must not keep a one-shot alive.
process.exit(0);
