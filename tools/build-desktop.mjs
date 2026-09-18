#!/usr/bin/env node
/**
 * Package the app as a self-contained desktop folder for THIS platform.
 *
 *   node tools/build-desktop.mjs [--out release] [--skip-build] [--no-zip] [--no-check]
 *
 * Produces release/Terramentor-<version>-<platform>-<arch>/ and a zip of it:
 *
 *   runtime/node(.exe)     the Node binary this script is running on — the only
 *                          runtime the app needs, so nothing is installed
 *   dist/                  the built SPA
 *   server/                the API (no database, no vault, no certificates)
 *   desktop/               the launcher
 *   node_modules/          production dependencies the SERVER imports, resolved
 *                          from package-lock.json (the client's are already in dist)
 *   build.json             version, commit, build time — the app's identity
 *   Terramentor.exe / .cmd   Windows: a windowless launcher (compiled here with
 *                          the C# compiler Windows ships), and a console one
 *   Terramentor.app / .command  macOS: a thin app bundle beside the folder
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
 * is not a package.
 */
import { spawnSync } from 'node:child_process';
import {
    existsSync, mkdirSync, rmSync, cpSync, copyFileSync, readFileSync, writeFileSync,
    readdirSync, statSync, createReadStream, createWriteStream, chmodSync,
} from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { buildIco, buildIcns } from './lib/icons.mjs';

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
const stage = join(tmpdir(), 'terramentor-stage', name);
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
log(`▸ staging ${stage}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(repoRoot, 'dist'), join(stage, 'dist'), { recursive: true });
// The server, minus anything that is state rather than code.
cpSync(join(repoRoot, 'server'), join(stage, 'server'), {
    recursive: true,
    filter: (src) => {
        const rel = relative(join(repoRoot, 'server'), src);
        if (!rel) return true;
        if (/^terramentor\.db/.test(rel)) return false;         // the database and its WAL/SHM/backups
        if (rel === 'vault' || rel.startsWith(`vault${sep}`)) return false;
        if (rel.endsWith('.bak')) return false;
        return true;
    },
});
cpSync(join(repoRoot, 'desktop'), join(stage, 'desktop'), {
    recursive: true,
    filter: (src) => !relative(join(repoRoot, 'desktop'), src).startsWith('wrappers'),
});
for (const f of ['package.json', 'package-lock.json', 'LICENSE']) copyFileSync(join(repoRoot, f), join(stage, f));

// --- 3. production node_modules, server-side closure only ------------------------
log('▸ npm ci --omit=dev (production dependencies)');
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: stage });

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

const serverDeps = scanServerDependencies(join(repoRoot, 'server'));
const declared = Object.keys(pkg.dependencies || {});
const missingData = Object.keys(DATA_DEPS).filter((d) => !declared.includes(d));
if (missingData.length) throw new Error(`package.json no longer declares: ${missingData.join(', ')}`);
const keep = declared.filter((d) => serverDeps.has(d) || DATA_DEPS[d]);
const undeclared = [...serverDeps].filter((d) => !declared.includes(d));
if (undeclared.length) throw new Error(`server imports packages package.json does not declare: ${undeclared.join(', ')}`);
log(`▸ server needs ${keep.length} of ${declared.length} declared packages; pruning the rest`);
const stagedPkg = { ...pkg, dependencies: Object.fromEntries(keep.map((d) => [d, pkg.dependencies[d]])), devDependencies: {} };
delete stagedPkg.scripts;
writeFileSync(join(stage, 'package.json'), JSON.stringify(stagedPkg, null, 2));
run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: stage });
// The lockfile did its job; a copy would only invite `npm install` in the folder.
rmSync(join(stage, 'package-lock.json'), { force: true });
// Restore the real package.json (the app reads its version and engines from it).
writeFileSync(join(stage, 'package.json'), JSON.stringify({ ...pkg, devDependencies: {}, scripts: { start: 'node desktop/launcher.js' } }, null, 2));

// --- 4. the runtime -------------------------------------------------------------
const runtimeDir = join(stage, 'runtime');
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
writeFileSync(join(stage, 'build.json'), JSON.stringify(build, null, 2));

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
    const icns = await buildIcns(png512);
    const bundle = join(stage, `${APP}.app`, 'Contents');
    mkdirSync(join(bundle, 'MacOS'), { recursive: true });
    mkdirSync(join(bundle, 'Resources'), { recursive: true });
    writeFileSync(join(bundle, 'Info.plist'), readFileSync(join(wrappers, 'Info.plist'), 'utf8').replaceAll('__VERSION__', pkg.version));
    writeFileSync(join(bundle, 'Resources', 'icon.icns'), icns);
    copyFileSync(join(wrappers, 'app-bundle-main.sh'), join(bundle, 'MacOS', APP));
    chmodSync(join(bundle, 'MacOS', APP), 0o755);
    copyFileSync(join(wrappers, `${APP}.command`), join(stage, `${APP}.command`));
    chmodSync(join(stage, `${APP}.command`), 0o755);
} else {
    copyFileSync(join(repoRoot, 'public', 'icons', 'icon-512.png'), join(stage, 'icon.png'));
    for (const f of ['terramentor.sh', 'install-desktop-entry.sh']) {
        copyFileSync(join(wrappers, f), join(stage, f));
        chmodSync(join(stage, f), 0o755);
    }
}
writeFileSync(join(stage, 'README.txt'), readme.replaceAll('__VERSION__', pkg.version));

// --- 7. does it start? ----------------------------------------------------------------
if (!noCheck) {
    // TWICE, and the second one is not redundant. The tray host starts the
    // launcher with TERRAMENTOR_TRAY=1, and code that only runs under that flag
    // is code no other check reaches — a reference error in it survives `node
    // --check`, survives the gates, and ships. One did: the tray's shutdown
    // channel read a binding scoped to a `try` block, and because the guard
    // short-circuits on the flag, the plain check never evaluated it. The app
    // then started and opened no window.
    const runs = [
        ['plain', {}],
        ['under the tray host', { TERRAMENTOR_TRAY: '1' }],
    ];
    let port = 3901;
    for (const [label, extraEnv] of runs) {
        log(`▸ starting the staged copy (--check, ${label})`);
        const scratch = join(tmpdir(), `terramentor-build-check-${process.pid}-${port}`);
        rmSync(scratch, { recursive: true, force: true });
        const r = spawnSync(join(runtimeDir, nodeName), ['desktop/launcher.js', '--check', '--data-dir', scratch, '--port', String(port)],
            { cwd: stage, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...extraEnv } });
        process.stdout.write(r.stdout || '');
        process.stderr.write(r.stderr || '');
        rmSync(scratch, { recursive: true, force: true });
        if (r.status !== 0) throw new Error(`the staged copy failed its self-check (${label})`);
        // An unhandled rejection does not fail the process, and this one is how
        // the tray bug got through: the launcher logged it and carried on
        // without opening anything.
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
}

// --- 8. zip -----------------------------------------------------------------------------
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

/** Every bare package specifier imported anywhere under server/. */
function scanServerDependencies(dir) {
    const found = new Set();
    const walk = (d) => {
        for (const f of readdirSync(d)) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) { walk(p); continue; }
            if (!/\.(js|mjs|cjs)$/.test(f)) continue;
            const src = readFileSync(p, 'utf8');
            // Real import shapes only — `from 'x';` closing a line, `import('x')`,
            // `require('x')` — and a specifier that is a legal package name, so
            // prose in a comment ("…from 'the page was blank'") cannot match.
            const re = /(?:^\s*(?:import|export)\b[^;]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gm;
            const PKG = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(\/.*)?$/;
            let m;
            while ((m = re.exec(src))) {
                const spec = m[1];
                if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || !PKG.test(spec)) continue;
                const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
                found.add(pkgName);
            }
        }
    };
    walk(dir);
    // Node built-ins written without the prefix.
    for (const b of ['fs', 'path', 'url', 'crypto', 'os', 'http', 'https', 'child_process', 'stream', 'util', 'events', 'zlib', 'worker_threads', 'buffer', 'net', 'dns', 'string_decoder', 'readline', 'assert']) found.delete(b);
    return found;
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
            zip.file(rel, createReadStream(p), { unixPermissions: exec ? 0o755 : 0o644, date: st.mtime });
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

