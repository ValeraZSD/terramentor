#!/usr/bin/env node
/**
 * Package the app as a self-contained desktop folder for THIS platform.
 *
 *   node tools/build-desktop.mjs [--out release] [--skip-build] [--no-zip] [--no-check]
 *
 * Produces release/Terramentor-<version>-<platform>-<arch>/ and a zip of it.
 * On Windows and Linux that folder IS the app; on macOS it holds an app bundle
 * with the app inside it, so the bundle can be dragged into Applications alone:
 *
 *   Terramentor-<version>-darwin-arm64/
 *     README.txt
 *     Terramentor.app/Contents/
 *       Info.plist, MacOS/Terramentor (desktop/wrappers/app-bundle-main.sh),
 *       Resources/icon.icns
 *       Resources/app/      everything listed below
 *
 * The app folder:
 *
 *   runtime/node(.exe)     the Node binary this script is running on — the only
 *                          runtime the app needs, so nothing is installed
 *   dist/                  the built SPA
 *   server/                the API (no database, no vault, no certificates)
 *   mcp/                   the MCP server an agent in another app starts
 *                          (docs/MCP.md), with its two views
 *   src/                   only what server/ imports from it (the card
 *                          scheduler) and the translations the views read;
 *                          the list is tools/lib/runtimeSources.mjs
 *   desktop/               the launcher
 *   node_modules/          production dependencies the server and mcp/ import,
 *                          resolved from package-lock.json (the client's are
 *                          already in dist)
 *   build.json             version, commit, build time — the app's identity
 *   Terramentor.exe / .cmd   Windows: a windowless launcher (compiled here with
 *                          the C# compiler Windows ships), and a console one
 *   terramentor.sh + install-desktop-entry.sh   Linux
 *
 * Why the bundled Node rather than an installer that asks for one: the audience
 * this exists for is the person who will not open a terminal. Copying
 * `process.execPath` means the release job on each OS produces that OS's build
 * with no download step and no version to keep in sync — the runner's Node IS
 * the runtime, and setup-node pins it.
 *
 * Why prune rather than a hand-written list: `npm ci --omit=dev` then removing
 * the client-only packages from package.json and running `npm prune` leaves
 * exactly the server's transitive closure, at the versions the lockfile pins.
 * A shared dependency (jszip is used by both halves) survives; one only the
 * client needed (mermaid, 40 MB) goes. Measured: 635 MB of node_modules to
 * ~150 MB. The server's imports are SCANNED, not listed, so a new server
 * dependency cannot be forgotten.
 *
 * The staged copy is started with `desktop/launcher.js --check` against a
 * scratch data directory before it is zipped — a package that does not start
 * is not a package. Its MCP server is then started against that copy's own
 * server and asked for its tools, a view and a project list. On macOS the
 * bundle is also copied ALONE into another folder, made read-only (as macOS
 * runs a downloaded app it has translocated) and started through its own
 * executable, so a bundle that reaches outside itself, or writes into itself
 * while it starts, fails the build.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
    existsSync, mkdirSync, rmSync, cpSync, copyFileSync, readFileSync, writeFileSync,
    readdirSync, statSync, createReadStream, createWriteStream, chmodSync, realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { buildIco, buildIcns } from './lib/icons.mjs';
import { codeFiles, runtimeSources, RUNTIME_DATA } from './lib/runtimeSources.mjs';
import { MAC_APP_IN_BUNDLE } from '../server/appPlacement.js';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolsDir, '..');
const APP = 'Terramentor';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const outRoot = resolve(repoRoot, flag('--out') || 'release');
// Staged in the system temp directory, NOT under the repo: Node resolves a
// missing package by walking UP the directory tree, so a stage inside the repo
// would find the repo's own node_modules and the self-check would pass with an
// empty package. The finished folder is copied into `release/` afterwards.
const skipBuild = argv.includes('--skip-build');
const noZip = argv.includes('--no-zip');
const noCheck = argv.includes('--no-check');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const platform = process.platform;
const arch = process.arch;
const name = `${APP}-${pkg.version}-${platform}-${arch}`;
/** What the zip holds: the package's top folder. */
const stage = join(tmpdir(), 'terramentor-stage', name);
/** Where the app itself goes: the top folder, or the bundle's app folder on
 *  macOS (server/appPlacement.js, which the launcher and the updater read). */
const bundleDir = join(stage, `${APP}.app`);
const appDir = platform === 'darwin' ? join(bundleDir, ...MAC_APP_IN_BUNDLE.split('/')) : stage;
const log = (m) => process.stdout.write(`${m}\n`);

function run(cmd, args, opts = {}) {
    // One command string through the shell: on Windows `npm` is npm.cmd, which
    // Node will not spawn without a shell, and a shell given separate args only
    // concatenates them anyway (and says so). Nothing here takes user input.
    const r = spawnSync(`${cmd} ${args.join(' ')}`, { stdio: 'inherit', shell: true, ...opts });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}
const gitOut = (...args) => {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
};

// --- 1. the SPA ---------------------------------------------------------------
if (!skipBuild) {
    log('▸ vite build');
    run('npm', ['run', 'build'], { cwd: repoRoot });
}
if (!existsSync(join(repoRoot, 'dist', 'index.html'))) throw new Error('dist/index.html missing — build failed?');

// --- 2. stage ------------------------------------------------------------------
log(`▸ staging ${appDir}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

cpSync(join(repoRoot, 'dist'), join(appDir, 'dist'), { recursive: true });
// The server, minus anything that is state rather than code.
cpSync(join(repoRoot, 'server'), join(appDir, 'server'), {
    recursive: true,
    filter: (src) => {
        const rel = relative(join(repoRoot, 'server'), src);
        if (!rel) return true;
        if (/^terramentor\.db/.test(rel)) return false;         // the database and its WAL/SHM/backups
        if (rel === 'vault' || rel.startsWith(`vault${sep}`)) return false;
        if (rel.endsWith('.bak')) return false;
        // What a checkout run as a desktop app leaves in `server/` (the legacy
        // layout puts the data directory there): the library's credentials,
        // its instance key, the launcher's log and the window's browser
        // profile. Each belongs to the account that built the zip, and the
        // first two are secrets that every copy of the zip would carry.
        if (/\.secrets\.json/.test(rel)) return false;
        if (rel === 'instance.key') return false;
        if (/^(logs|browser-profile)([\\/]|$)/.test(rel)) return false;
        if (rel.startsWith('start-menu-shortcut.')) return false;
        return true;
    },
});
// README.txt is left out as well: it is the template of the zip's top-level
// README (written below with the version filled in), and a second, raw copy in
// desktop/ read "Terramentor __VERSION__" inside every 1.0.0 zip.
cpSync(join(repoRoot, 'desktop'), join(appDir, 'desktop'), {
    recursive: true,
    filter: (src) => {
        const rel = relative(join(repoRoot, 'desktop'), src);
        return !rel.startsWith('wrappers') && rel !== 'README.txt';
    },
});
// The MCP server, and the few files from src/ that server/ imports and the
// translations the MCP views read (tools/lib/runtimeSources.mjs says why).
cpSync(join(repoRoot, 'mcp'), join(appDir, 'mcp'), { recursive: true });
const sharedSources = runtimeSources(repoRoot);
for (const rel of [...sharedSources, ...RUNTIME_DATA]) {
    mkdirSync(dirname(join(appDir, rel)), { recursive: true });
    cpSync(join(repoRoot, rel), join(appDir, rel), { recursive: true });
}
log(`▸ shipped from src/: ${[...sharedSources, ...RUNTIME_DATA].join(', ')}`);
for (const f of ['package.json', 'package-lock.json', 'LICENSE']) copyFileSync(join(repoRoot, f), join(appDir, f));

// --- 3. production node_modules, server-side closure only ------------------------
log('▸ npm ci --omit=dev (production dependencies)');
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: appDir });

// Packages the server NEEDS but never imports, so the scanner cannot see them.
// Each is data a library is pointed at by path, and each would be pruned into a
// silent behaviour change rather than a crash — which is why they are named here
// with what breaks, not just listed.
const DATA_DEPS = {
    // The English OCR model. `server/pdfRecovery.js` resolves its directory into
    // tesseract.js's `langPath`; pruned, the packaged app's first OCR downloads
    // the model from cdn.jsdelivr.net instead — from the recovery mode whose own
    // label says "Fully offline", in the build most likely to be run offline.
    '@tesseract.js-data/eng': true,
};

// Everything that runs: the server, the MCP server, and the files from src/
// they import (whose own imports, ts-fsrs for one, are the server's too).
const serverDeps = scanDependencies([
    ...codeFiles(join(repoRoot, 'server')),
    ...codeFiles(join(repoRoot, 'mcp')),
    ...sharedSources.map((rel) => join(repoRoot, rel)),
]);
const declared = Object.keys(pkg.dependencies || {});
const missingData = Object.keys(DATA_DEPS).filter((d) => !declared.includes(d));
if (missingData.length) throw new Error(`package.json no longer declares: ${missingData.join(', ')}`);
const keep = declared.filter((d) => serverDeps.has(d) || DATA_DEPS[d]);
const undeclared = [...serverDeps].filter((d) => !declared.includes(d));
if (undeclared.length) throw new Error(`the server or mcp/ imports packages package.json does not declare: ${undeclared.join(', ')}`);
log(`▸ the server and mcp/ need ${keep.length} of ${declared.length} declared packages; pruning the rest`);
const stagedPkg = { ...pkg, dependencies: Object.fromEntries(keep.map((d) => [d, pkg.dependencies[d]])), devDependencies: {} };
delete stagedPkg.scripts;
writeFileSync(join(appDir, 'package.json'), JSON.stringify(stagedPkg, null, 2));
run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: appDir });
// The lockfile did its job; a copy would only invite `npm install` in the folder.
rmSync(join(appDir, 'package-lock.json'), { force: true });
// Restore the real package.json (the app reads its version and engines from it).
writeFileSync(join(appDir, 'package.json'), JSON.stringify({ ...pkg, devDependencies: {}, scripts: { start: 'node desktop/launcher.js' } }, null, 2));

// --- 4. the runtime -------------------------------------------------------------
const runtimeDir = join(appDir, 'runtime');
mkdirSync(runtimeDir, { recursive: true });
const nodeName = platform === 'win32' ? 'node.exe' : 'node';
copyFileSync(process.execPath, join(runtimeDir, nodeName));
if (platform !== 'win32') chmodSync(join(runtimeDir, nodeName), 0o755);
writeFileSync(join(runtimeDir, 'NOTICE.txt'),
    `This folder holds Node.js ${process.versions.node}, copied unmodified from the official distribution.\n` +
    `Node.js is MIT licensed: https://github.com/nodejs/node/blob/main/LICENSE\n`);

// --- 5. identity -------------------------------------------------------------------
const build = {
    app: APP,
    version: pkg.version,
    commit: process.env.GIT_SHA || gitOut('rev-parse', 'HEAD'),
    builtAt: new Date().toISOString(),
    platform,
    arch,
    node: process.versions.node,
};
writeFileSync(join(appDir, 'build.json'), JSON.stringify(build, null, 2));

// --- 6. icons and wrappers -------------------------------------------------------
const png512 = readFileSync(join(repoRoot, 'public', 'icons', 'icon-512.png'));
const wrappers = join(repoRoot, 'desktop', 'wrappers');
const readme = readFileSync(join(repoRoot, 'desktop', 'README.txt'), 'utf8');

if (platform === 'win32') {
    const ico = await buildIco(png512);
    writeFileSync(join(stage, `${APP}.ico`), ico);
    copyFileSync(join(wrappers, `${APP}.cmd`), join(stage, `${APP}.cmd`));
    compileWindowsLauncher(join(stage, `${APP}.exe`), join(stage, `${APP}.ico`));
} else if (platform === 'darwin') {
    // The rest of the bundle around the app staged above. Nothing of the app
    // sits beside the bundle: dragged into Applications on its own, or run by
    // macOS from a translocated copy, it has everything it needs.
    const icns = await buildIcns(png512);
    const contents = join(bundleDir, 'Contents');
    for (const d of ['MacOS', 'Resources']) mkdirSync(join(contents, d), { recursive: true });
    writeFileSync(join(contents, 'Info.plist'), readFileSync(join(wrappers, 'Info.plist'), 'utf8').replaceAll('__VERSION__', pkg.version));
    writeFileSync(join(contents, 'Resources', 'icon.icns'), icns);
    copyFileSync(join(wrappers, 'app-bundle-main.sh'), join(contents, 'MacOS', APP));
    chmodSync(join(contents, 'MacOS', APP), 0o755);
} else {
    copyFileSync(join(repoRoot, 'public', 'icons', 'icon-512.png'), join(stage, 'icon.png'));
    for (const f of ['terramentor.sh', 'install-desktop-entry.sh']) {
        copyFileSync(join(wrappers, f), join(stage, f));
        chmodSync(join(stage, f), 0o755);
    }
}
// The package's top level: beside the app on Windows and Linux (and in its
// file list), beside the bundle on macOS.
writeFileSync(join(stage, 'README.txt'), readme.replaceAll('__VERSION__', pkg.version));

// --- 7. does it start? ----------------------------------------------------------------
let port = 3901;
if (!noCheck) {
    // TWICE, and the second one is not redundant. The tray host starts the
    // launcher with TERRAMENTOR_TRAY=1, and code that only runs under that flag
    // is code no other check reaches — a reference error in it survives `node
    // --check`, survives the gates, and ships. A binding scoped to a `try`
    // block and read behind a guard that short-circuits on the flag is the
    // shape: the plain check never evaluates it, and the app starts and opens
    // no window.
    const runs = [
        ['plain', {}],
        ['under the tray host', { TERRAMENTOR_TRAY: '1' }],
    ];
    for (const [label, extraEnv] of runs) {
        log(`▸ starting the staged copy (--check, ${label})`);
        const scratch = join(tmpdir(), `terramentor-build-check-${process.pid}-${port}`);
        rmSync(scratch, { recursive: true, force: true });
        const r = spawnSync(join(runtimeDir, nodeName), ['desktop/launcher.js', '--check', '--data-dir', scratch, '--port', String(port)],
            { cwd: appDir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...extraEnv } });
        process.stdout.write(r.stdout || '');
        process.stderr.write(r.stderr || '');
        rmSync(scratch, { recursive: true, force: true });
        if (r.status !== 0) throw new Error(`the staged copy failed its self-check (${label})`);
        // An unhandled rejection does not fail the process: the launcher logs
        // it and carries on without opening anything.
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        if (/Unhandled Rejection|ReferenceError|TypeError/.test(out)) {
            throw new Error(`the staged copy logged an error during its self-check (${label})`);
        }
        // Exit 0 is not the same as having CHECKED anything. The tray run first
        // shut the server down before the verification ran — stdin is closed the
        // moment a spawnSync child starts — and reported a clean pass having
        // asserted nothing at all. The line only appears when version, desktop
        // status and package.json have all agreed.
        if (!out.includes('Check OK:')) {
            throw new Error(`the staged copy exited cleanly without running its checks (${label})`);
        }
        port++;
    }
    // The MCP server is a second program in the same folder, started by the
    // agent's app rather than by the launcher, so the launcher's check never
    // loads it: a package missing mcp/, its SDK (pruned when only server/ was
    // scanned) or the views' translations would start, pass, and ship.
    log('▸ starting the staged MCP server against the staged server');
    await checkMcp(port);
    port++;
}

// --- 8. the file list ----------------------------------------------------------------------
// Every file of the app with its SHA-256, so an installed copy can update
// itself by fetching only the files that changed (server/appUpdate.js): the
// release manifest carries this list's hash, and this list carries each file's.
// Written AFTER the self-check, which runs inside the app folder, and it does
// not list itself. Paths are relative to the app folder on every platform; a
// macOS bundle's Info.plist and executable are not the app's and an update
// never replaces them, which is why app-bundle-main.sh does nothing but find
// the app and start it.
{
    const files = [];
    const walk = (d) => {
        for (const f of readdirSync(d).sort()) {
            const p = join(d, f);
            const st = statSync(p);
            if (st.isDirectory()) { walk(p); continue; }
            const path = relative(appDir, p).split(sep).join('/');
            if (path === 'files.json') continue;
            files.push({
                path, size: st.size,
                sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
                ...(platform !== 'win32' && (st.mode & 0o111) !== 0 ? { exec: true } : {}),
            });
        }
    };
    walk(appDir);
    writeFileSync(join(appDir, 'files.json'), `${JSON.stringify({ schema: 1, version: pkg.version, platform: `${platform}-${arch}`, files })}\n`);
    log(`▸ file list: ${files.length} files`);
}

// --- 8b. the bundle by itself (macOS) ------------------------------------------------------
// What a person does with the download: take Terramentor.app out of the
// unpacked folder (into Applications), or open it where it is, in which case
// macOS runs it from a read-only copy at a random path. Both are this: the
// bundle ALONE in another folder, unwritable, started through its own
// executable from an unrelated working directory. A bundle that looks for its
// files beside itself, or writes into itself while starting, fails here.
if (!noCheck && platform === 'darwin') {
    log('▸ starting the bundle on its own, read-only, from another folder');
    const away = join(tmpdir(), `terramentor-bundle-check-${process.pid}`);
    const copy = join(away, 'elsewhere', `${APP}.app`);
    rmSync(away, { recursive: true, force: true });
    mkdirSync(dirname(copy), { recursive: true });
    const sh = (cmd, args) => {
        const r = spawnSync(cmd, args, { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.error?.message}`);
    };
    let r, inside;
    try {
        sh('cp', ['-R', bundleDir, copy]);
        // Node starts its main script by its real path, and macOS's temp
        // folder sits behind a symlink (/var → /private/var).
        inside = realpathSync(join(copy, ...MAC_APP_IN_BUNDLE.split('/')));
        sh('chmod', ['-R', 'a-w', copy]);
        r = spawnSync(join(copy, 'Contents', 'MacOS', APP), ['--check', '--data-dir', join(away, 'library'), '--port', String(port)],
            { cwd: away, encoding: 'utf8', timeout: 120_000, env: { ...process.env } });
    } finally {
        spawnSync('chmod', ['-R', 'u+w', away]);
        rmSync(away, { recursive: true, force: true });
    }
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    process.stdout.write(out);
    if (r.status !== 0 || !out.includes('Check OK:')) throw new Error(`the bundle did not start on its own (exit ${r.status ?? r.error?.message})`);
    if (!out.includes(`packaged copy at ${inside}`)) throw new Error(`the bundle started an app outside itself (expected ${inside})`);
    log(`▸ the bundle started on its own from ${inside}`);
}

// --- 9. zip -----------------------------------------------------------------------------
mkdirSync(outRoot, { recursive: true });
if (!noZip) {
    const zipPath = join(outRoot, `${name}.zip`);
    log(`▸ zipping → ${relative(repoRoot, zipPath)}`);
    await zipFolder(stage, zipPath, name);
    log(`  ${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
}
const finalDir = join(outRoot, name);
rmSync(finalDir, { recursive: true, force: true });
cpSync(stage, finalDir, { recursive: true });
rmSync(stage, { recursive: true, force: true });
log(`✓ ${relative(repoRoot, finalDir)}`);

// --- helpers ------------------------------------------------------------------------------

/** Every bare package specifier the given modules import. */
function scanDependencies(files) {
    const found = new Set();
    for (const p of files) {
        const src = readFileSync(p, 'utf8');
        // Real import shapes only — `from 'x';` closing a line, `import('x')`,
        // `require('x')` — and a specifier that is a legal package name, so
        // prose in a comment ("…from 'the page was blank'") cannot match.
        // `import type` (in the .ts files from src/) is erased before the
        // module runs, so the package it names is not needed.
        const re = /(?:^\s*(?:import(?!\s+type\b)|export)\b[^;]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gm;
        const PKG = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(\/.*)?$/;
        let m;
        while ((m = re.exec(src))) {
            const spec = m[1];
            if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || !PKG.test(spec)) continue;
            const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
            found.add(pkgName);
        }
    }
    // Node built-ins written without the prefix.
    for (const b of ['fs', 'path', 'url', 'crypto', 'os', 'http', 'https', 'child_process', 'stream', 'util', 'events', 'zlib', 'worker_threads', 'buffer', 'net', 'dns', 'string_decoder', 'readline', 'assert']) found.delete(b);
    return found;
}

/**
 * Start the staged server on a scratch library, then tools/mcp-smoke.mjs,
 * which starts the staged `mcp/index.js` against it the way an agent's app
 * does and asks for its tools, a view and a project list.
 */
async function checkMcp(port) {
    const node = join(runtimeDir, nodeName);
    const scratch = join(tmpdir(), `terramentor-build-mcp-${process.pid}-${port}`);
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const url = `http://127.0.0.1:${port}`;
    // The builder's own environment minus anything that would point either
    // program somewhere else (a developer's TERRAMENTOR_URL, their key, their
    // library), plus the scratch library, set here rather than by a shell.
    const env = (extra) => {
        const e = { ...process.env };
        for (const k of Object.keys(e)) if (/^(TERRAMENTOR_|DB_PATH$|VAULT_ROOT$|DATA_DIR$|PORT$|HOST$)/.test(k)) delete e[k];
        return { ...e, ...extra };
    };
    const children = [];
    const start = (args, extra) => {
        const c = spawn(node, args, { cwd: appDir, env: env(extra), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const exited = new Promise((r) => c.once('exit', r));
        children.push({ c, exited });
        return c;
    };
    try {
        const server = start(['server/index.js'], {
            PORT: String(port), HOST: '127.0.0.1', DATA_DIR: scratch,
            DB_PATH: join(scratch, 'terramentor.db'), VAULT_ROOT: join(scratch, 'vault'),
        });
        let serverLog = '';
        server.stdout.on('data', (d) => { serverLog += d; });
        server.stderr.on('data', (d) => { serverLog += d; });
        for (const deadline = Date.now() + 60_000; ;) {
            if (server.exitCode !== null) throw new Error(`the staged server exited (${server.exitCode}): ${serverLog.slice(-600)}`);
            const up = await fetch(`${url}/api/version`).then((r) => r.ok, () => false);
            if (up) break;
            if (Date.now() > deadline) throw new Error(`the staged server did not answer within 60 s: ${serverLog.slice(-600)}`);
            await new Promise((r) => setTimeout(r, 250));
        }

        // The probe is a script of this repository run by the staged Node; the
        // MCP server it starts resolves its packages from the stage alone.
        const probe = start([join(toolsDir, 'mcp-smoke.mjs'), appDir, url], {});
        let probeOut = '';
        probe.stdout.on('data', (d) => { probeOut += d; });
        probe.stderr.on('data', (d) => { probeOut += d; });
        const code = await Promise.race([children.at(-1).exited, new Promise((r) => setTimeout(() => r('timeout'), 120_000))]);
        process.stdout.write(probeOut);
        if (code !== 0) throw new Error(`the staged MCP server failed its check (${code === 'timeout' ? 'no answer in 120 s' : `exit ${code}`})`);
    } finally {
        for (const { c } of children) c.kill();
        // The scratch library stays open until the server has gone (Windows
        // will not delete an open file).
        await Promise.all(children.map(({ exited }) => Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])));
        rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}

/** Compile Launcher.cs with the .NET Framework compiler behind Add-Type. */
function compileWindowsLauncher(exePath, icoPath) {
    const cs = join(wrappers, 'Launcher.cs');
    const ps = [
        '$ErrorActionPreference = "Stop"',
        `$src = Get-Content -Raw -Encoding UTF8 '${cs.replace(/'/g, "''")}'`,
        '$cp = New-Object System.CodeDom.Compiler.CompilerParameters',
        '$cp.GenerateExecutable = $true',
        `$cp.OutputAssembly = '${exePath.replace(/'/g, "''")}'`,
        `$cp.CompilerOptions = '/target:winexe /win32icon:"${icoPath}" /optimize'`,
        '$cp.ReferencedAssemblies.Add("System.dll") | Out-Null',
        '$cp.ReferencedAssemblies.Add("System.Windows.Forms.dll") | Out-Null',
        // The tray icon is a NotifyIcon carrying a System.Drawing.Icon loaded
        // from Terramentor.ico; without this reference the launcher does not
        // compile and the package ships with the console .cmd alone.
        '$cp.ReferencedAssemblies.Add("System.Drawing.dll") | Out-Null',
        'Add-Type -TypeDefinition $src -CompilerParameters $cp',
        `if (-not (Test-Path '${exePath.replace(/'/g, "''")}')) { throw "no exe produced" }`,
    ].join('\n');
    const script = join(tmpdir(), `terramentor-launcher-${process.pid}.ps1`);
    writeFileSync(script, ps, 'utf8');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' });
    rmSync(script, { force: true });
    if (r.status !== 0 || !existsSync(exePath)) {
        // Not fatal: the .cmd still starts the app. Say so, loudly, so a CI log shows it.
        log(`! could not compile ${APP}.exe (Windows PowerShell's C# compiler unavailable?): ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
        log('  the package ships with Terramentor.cmd only');
    } else {
        log(`▸ compiled ${APP}.exe`);
    }
}

/** Zip a folder, streaming, keeping executable bits for macOS/Linux readers. */
async function zipFolder(folder, zipPath, rootName) {
    const zip = new JSZip();
    const walk = (d) => {
        for (const f of readdirSync(d)) {
            const p = join(d, f);
            const rel = `${rootName}/${relative(folder, p).split(sep).join('/')}`;
            const st = statSync(p);
            if (st.isDirectory()) { walk(p); continue; }
            const exec = platform !== 'win32' && (st.mode & 0o111) !== 0;
            // The full mode, regular-file type bits included, as Info-ZIP
            // writes it: a reader may ignore permissions that carry no type.
            zip.file(rel, createReadStream(p), { unixPermissions: exec ? 0o100755 : 0o100644, date: st.mtime });
        }
    };
    walk(folder);
    await new Promise((res, rej) => {
        zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, platform: platform === 'win32' ? 'DOS' : 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 } })
            .pipe(createWriteStream(zipPath))
            .on('finish', res)
            .on('error', rej);
    });
}

