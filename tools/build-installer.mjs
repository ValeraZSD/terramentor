#!/usr/bin/env node
/**
 * Build the Windows installer around a packaged app folder.
 *
 *   node tools/build-installer.mjs [--app release/Terramentor-<v>-win32-x64] [--out release]
 *                                  [--version <v>] [--compression <inno value>]
 *
 * The app folder is what tools/build-desktop.mjs leaves in release/ (the same
 * files the zip holds); the installer is desktop/installer/Terramentor.iss,
 * compiled with Inno Setup 6 (ISCC.exe: the ISCC environment variable, or the
 * usual install folders, or PATH). Writes
 * release/Terramentor-<version>-win32-x64-setup.exe.
 *
 * `--version` builds an installer that SAYS another version around the same
 * files, and `--compression none` builds it in seconds: the installer check
 * (tools/installer-check.mjs) uses both to prove an older setup refuses to run
 * over a newer copy.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'Terramentor';
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const log = (m) => process.stdout.write(`${m}\n`);

/** `Terramentor-<version>-win32-x64-setup.exe`, the name the release carries. */
export function installerName(version, arch = 'x64') {
    return `${APP}-${version}-win32-${arch}-setup`;
}

/** The four numbers Windows' file version holds: `1.7.0-nightly.20261127.2` → `1.7.0.0`. */
export function numericVersion(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
    if (!m) throw new Error(`"${version}" is not a version`);
    return `${m[1]}.${m[2]}.${m[3]}.0`;
}

/** Where ISCC.exe is, or null. */
export function findIscc({ env = process.env, exists = existsSync } = {}) {
    const candidates = [
        env.ISCC,
        env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
        env.ProgramFiles && join(env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
        ...(env.PATH || env.Path || '').split(delimiter).filter(Boolean).map((d) => join(d, 'ISCC.exe')),
    ].filter(Boolean);
    return candidates.find((p) => exists(p)) || null;
}

/**
 * The wizard's pictures, drawn from the app's own icon: the tall one on the
 * welcome and finished pages, the small one on the page in between, each at
 * the sizes Inno Setup picks from by the screen's scaling (its WizardImageFile
 * and WizardSmallImageFile help). Transparent around the icon, so the wizard's
 * own light or dark background shows through.
 */
async function drawArt(dir) {
    const icon = await loadImage(readFileSync(join(repoRoot, 'public', 'icons', 'icon-512.png')));
    const write = (name, w, h, side) => {
        const c = createCanvas(w, h);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(icon, Math.round((w - side) / 2), Math.round((h - side) / 2), side, side);
        writeFileSync(join(dir, name), c.toBuffer('image/png'));
    };
    // 100, 125, 150 and 200 % scaling.
    for (const [pct, w, h] of [[100, 202, 386], [125, 269, 515], [150, 336, 643], [200, 430, 824]]) {
        write(`wizard-${pct}.png`, w, h, Math.round(w * 0.5));
    }
    for (const [pct, s] of [[100, 58], [125, 77], [150, 97], [200, 124]]) write(`small-${pct}.png`, s, s, s);
}

async function main() {
    if (process.platform !== 'win32') throw new Error('The installer is built on Windows (Inno Setup runs there).');
    const outDir = resolve(repoRoot, flag('--out') || 'release');
    let appDir = flag('--app') && resolve(flag('--app'));
    if (!appDir) {
        const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
        appDir = join(outDir, `${APP}-${pkg.version}-win32-x64`);
    }
    if (!existsSync(join(appDir, 'build.json')) || !existsSync(join(appDir, `${APP}.exe`))) {
        throw new Error(`${appDir} is not a packaged Windows app (run tools/build-desktop.mjs first)`);
    }
    const built = JSON.parse(readFileSync(join(appDir, 'build.json'), 'utf8'));
    const version = flag('--version') || built.version;
    const iscc = findIscc();
    if (!iscc) throw new Error('Inno Setup 6 (ISCC.exe) was not found: install it, or set ISCC to its path.');

    const art = mkdtempSync(join(tmpdir(), 'terramentor-installer-art-'));
    try {
        await drawArt(art);
        mkdirSync(outDir, { recursive: true });
        const base = installerName(version);
        const defines = {
            AppVersion: version,
            NumericVersion: numericVersion(version),
            SourceDir: appDir,
            ArtDir: art,
            OutputDir: outDir,
            OutputBase: base,
            ...(flag('--compression') ? { Compression: flag('--compression') } : {}),
        };
        log(`▸ ${relative(repoRoot, iscc) || iscc} → ${base}.exe`);
        const started = Date.now();
        const r = spawnSync(iscc, ['/Q', ...Object.entries(defines).map(([k, v]) => `/D${k}=${v}`),
            join(repoRoot, 'desktop', 'installer', `${APP}.iss`)], { stdio: 'inherit', windowsHide: true });
        if (r.status !== 0) throw new Error(`ISCC failed (${r.status ?? r.error?.message})`);
        const exe = join(outDir, `${base}.exe`);
        if (!existsSync(exe)) throw new Error(`ISCC reported success but ${exe} is not there`);
        log(`✓ ${relative(repoRoot, exe)}  ${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB in ${Math.round((Date.now() - started) / 1000)} s`);
    } finally {
        rmSync(art, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((e) => { console.error(`build-installer: ${e.message}`); process.exit(1); });
}
