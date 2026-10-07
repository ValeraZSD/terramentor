// tools/worktree-setup.mjs — make a new git worktree ready to work in.
//
//   node tools/worktree-setup.mjs [--no-install] [--refresh]
//   npm run setup:worktree
//
// Several pieces of work at once means several checkouts at once: one git
// worktree per branch, each with its own dev servers. Three things stop a fresh
// worktree from being that, and this fixes all three, once, when it is made
// (T3 Code runs it from `t3.json` for a thread started in a new worktree):
//
//   1. PORTS. Every checkout's `npm run dev` wanted 5173 and 3001. The worktree
//      gets its own pair, derived from its path (`tools/dev-ports.mjs`), checked
//      free, and written into its `.env`, which the server and Vite both read.
//   2. THE LIBRARY. A worktree's `.env` points DATA_DIR at a scratch folder
//      inside it (`temp/dev-library`), so a dev server started there can never
//      open the library a real person studies in.
//   3. THE FILES GIT DOES NOT CARRY. Untracked files a contributor keeps beside
//      the code (local notes, editor settings) are named, one per line, in the
//      MAIN checkout's `.worktreeinclude` (gitignore-style paths; a trailing `/`
//      is a folder). Each is copied in if it is ignored there and missing here.
//      The file is the main checkout's own and is never required: without it
//      nothing is copied.
//
// Then `npm ci`, at idle CPU priority, timed. A `.env` someone wrote by hand is
// never touched; one this script wrote says so on its first line, keeps its
// ports on a re-run (a running dev server holds them), and is rewritten only
// with --refresh. It refuses to run in the main checkout, whose `.env` is the
// one that names the real library.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { constants as osConstants, setPriority } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { portsForOffset, worktreePortOffset } from './dev-ports.mjs';

export const MANAGED_MARKER = '# Written by tools/worktree-setup.mjs';
const PORT_TRIES = 50;

/** Is `root` a LINKED worktree (its `.git` is a file pointing at the main
 *  repository) rather than the main checkout (a `.git` folder)? */
export function isLinkedWorktree(root) {
    try { return statSync(join(root, '.git')).isFile(); } catch { return false; }
}

function git(cwd, args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** The main checkout a worktree belongs to: the folder holding the shared
 *  `.git`. Null when git cannot say. */
export function mainCheckoutOf(root) {
    const r = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!r.ok || !r.out) return null;
    const common = resolve(r.out);
    return common.toLowerCase().endsWith('.git') ? dirname(common) : null;
}

/** `.worktreeinclude` → relative paths. Blank lines and `#` comments skipped;
 *  an absolute path or one climbing out with `..` is refused, because a copy
 *  must start and end inside the two checkouts. */
export function parseWorktreeInclude(text) {
    const paths = [];
    const refused = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const rel = line.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
        if (!rel || isAbsolute(line) || /^[a-z]:/i.test(rel) || rel.split('/').includes('..')) {
            refused.push(line);
            continue;
        }
        paths.push(rel);
    }
    return { paths, refused };
}

/** Does this `.env` carry the marker this script writes on its first line? */
export function isManagedEnv(text) {
    return String(text || '').replace(/^﻿/, '').startsWith(MANAGED_MARKER);
}

/** The `.env` a worktree gets. Forward slashes: Node takes them on Windows, and
 *  the value needs no quoting or escaping in any shell or parser. */
export function envFileFor({ api, web, dataDir }) {
    return [
        `${MANAGED_MARKER} for this worktree. Re-run it with --refresh to pick new ports.`,
        '# Its own ports, so several worktrees run `npm run dev` side by side, and a',
        '# scratch library, so a dev server started here never opens a real one.',
        `PORT=${api}`,
        `VITE_PORT=${web}`,
        `DATA_DIR=${String(dataDir).replace(/\\/g, '/')}`,
        '',
    ].join('\n');
}

/** Can something listen on this port right now? Both loopbacks, because the
 *  server binds 127.0.0.1 and Vite binds whatever `localhost` resolves to. */
export async function portIsFree(port) {
    const tryOne = (host) => new Promise((done) => {
        const s = createServer();
        s.once('error', (err) => done(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT'));
        s.once('listening', () => s.close(() => done(true)));
        s.listen({ port, host, exclusive: true });
    });
    return (await tryOne('127.0.0.1')) && (await tryOne('::1'));
}

/** The worktree's pair: its path's offset, or the next one whose two ports are
 *  both free. */
export async function pickPorts(root, { isFree = portIsFree, platform = process.platform } = {}) {
    const offset = worktreePortOffset(root, { platform });
    for (let i = 0; i < PORT_TRIES; i++) {
        const ports = portsForOffset(offset + i);
        if (await isFree(ports.api) && await isFree(ports.web)) return { ...ports, moved: i };
    }
    throw new Error(`no free port pair in ${PORT_TRIES} tries from offset ${offset}`);
}

/** Copy what `.worktreeinclude` names from the main checkout. Only paths that
 *  are IGNORED there are copied — a tracked file already arrived with the
 *  checkout, and copying it would overwrite the branch's own version. */
export function copyIncluded({ root, mainRoot, refresh = false }) {
    const listFile = join(mainRoot, '.worktreeinclude');
    const report = { copied: [], skipped: [], refused: [] };
    if (!existsSync(listFile)) return report;
    const { paths, refused } = parseWorktreeInclude(readFileSync(listFile, 'utf8'));
    report.refused.push(...refused);
    for (const rel of paths) {
        const from = join(mainRoot, rel);
        const to = join(root, rel);
        if (!existsSync(from)) { report.skipped.push(`${rel} (not in the main checkout)`); continue; }
        if (!git(mainRoot, ['check-ignore', '-q', rel]).ok) { report.skipped.push(`${rel} (tracked, not ignored)`); continue; }
        if (existsSync(to) && !refresh) { report.skipped.push(`${rel} (already here)`); continue; }
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true, force: true });
        report.copied.push(rel);
    }
    return report;
}

/** Write the worktree's `.env`, or say why not. */
export async function writeEnv({ root, refresh = false, isFree, platform }) {
    const file = join(root, '.env');
    const dataDir = join(root, 'temp', 'dev-library');
    if (existsSync(file)) {
        const text = readFileSync(file, 'utf8');
        if (!isManagedEnv(text)) return { written: false, reason: 'hand-written .env kept as it is', ...portsIn(text) };
        if (!refresh) return { written: false, reason: 'kept (re-run with --refresh for new ports)', ...portsIn(text) };
    }
    const ports = await pickPorts(root, { isFree, platform });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, envFileFor({ ...ports, dataDir }));
    return { written: true, api: ports.api, web: ports.web, moved: ports.moved, dataDir };
}

function portsIn(text) {
    const env = parseEnv(String(text).replace(/^﻿/, ''));
    return { api: Number(env.PORT) || null, web: Number(env.VITE_PORT) || null, dataDir: env.DATA_DIR || null };
}

/** `npm ci` at idle priority, timed. Never over a node_modules that is a link:
 *  npm ci empties node_modules first, and through a junction that is ANOTHER
 *  checkout's packages. */
export function install(root) {
    const nm = join(root, 'node_modules');
    if (existsSync(nm) && lstatSync(nm).isSymbolicLink()) {
        return { ran: false, reason: 'node_modules is a link to another checkout; not touched' };
    }
    try { setPriority(osConstants.priority.PRIORITY_LOW); } catch { /* not permitted: run at normal priority */ }
    const started = Date.now();
    // One command string: npm is a .cmd on Windows, which only a shell starts,
    // and a shell given an argument list just concatenates it (DEP0190).
    const r = spawnSync('npm ci --prefer-offline --no-audit --no-fund', { cwd: root, stdio: 'inherit', shell: true });
    return { ran: true, ok: r.status === 0, seconds: Math.round((Date.now() - started) / 1000) };
}

export async function setupWorktree({ root, refresh = false, installDeps = true, isFree, platform } = {}) {
    if (!isLinkedWorktree(root)) {
        throw new Error(`${root} is not a linked git worktree. This sets up a NEW worktree; the main checkout keeps its own .env.`);
    }
    const mainRoot = mainCheckoutOf(root);
    if (!mainRoot || resolve(mainRoot) === resolve(root)) throw new Error('cannot find the main checkout this worktree belongs to');
    const copies = copyIncluded({ root, mainRoot, refresh });
    const env = await writeEnv({ root, refresh, isFree, platform });
    const deps = installDeps ? install(root) : { ran: false, reason: '--no-install' };
    return { root, mainRoot, copies, env, deps };
}

function minutes(s) {
    return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

// Run as a script, not imported by the gate. Both sides as REAL paths, compared
// case-blind: Node gives a module the URL of its real path, so started through a
// junction or symlink (T3 Code's worktree folder is one) argv[1] named a
// different path, the two never matched, and the script exited 0 having done
// nothing (7 Oct 2026, two worktrees launched with no install). And on Windows
// the drive letter's case depends on who started the process.
const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
const self = real(fileURLToPath(import.meta.url)).toLowerCase();
if (process.argv[1] && real(resolve(process.argv[1])).toLowerCase() === self) {
    const args = new Set(process.argv.slice(2));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    try {
        const r = await setupWorktree({ root, refresh: args.has('--refresh'), installDeps: !args.has('--no-install') });
        const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
        console.log(`\nworktree  ${root}  (branch ${branch})`);
        console.log(`copied    ${r.copies.copied.join(', ') || 'nothing'}${r.copies.skipped.length ? `; skipped ${r.copies.skipped.join(', ')}` : ''}`);
        if (r.copies.refused.length) console.log(`refused   ${r.copies.refused.join(', ')} (outside the checkout)`);
        console.log(`ports     api ${r.env.api} · page ${r.env.web}${r.env.written ? (r.env.moved ? ` (moved ${r.env.moved} up: taken)` : '') : ` — ${r.env.reason}`}`);
        console.log(`library   ${r.env.dataDir ?? 'as the .env says'}`);
        console.log(`install   ${r.deps.ran ? `npm ci ${r.deps.ok ? 'done' : 'FAILED'} in ${minutes(r.deps.seconds)}` : r.deps.reason}`);
        console.log(`\nnpm run dev, then http://localhost:${r.env.web}`);
        if (r.deps.ran && !r.deps.ok) process.exit(1);
    } catch (err) {
        console.error(`worktree-setup: ${err.message}`);
        process.exit(1);
    }
}
