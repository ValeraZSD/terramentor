#!/usr/bin/env node
/**
 * The Windows installer, run the way a person runs it, on a machine that is
 * there to be thrown away: a GitHub Actions runner, or Windows Sandbox.
 *
 *   node tools/installer-check.mjs <Terramentor-<v>-win32-x64-setup.exe> [--app <the app folder it was built from>]
 *
 * It installs for the account it runs as (no administrator), so it refuses to
 * run anywhere else: on a person's own computer it would replace their copy of
 * the app and their file type. In order:
 *
 *   1. installed silently: the app folder in %LOCALAPPDATA%\Programs, its
 *      uninstaller in the folder the updater never moves, the Start menu
 *      entry, the Settings → Apps entry with the right version, the
 *      .studyvault file type (per-user keys only), and the installed copy
 *      passes its own self-check;
 *   2. installed again over itself: a file the new copy does not hold is
 *      gone, a portable `data` folder in the app folder is kept, a junction
 *      in it is removed without emptying the folder it points at;
 *   3. an OLDER setup (built here from the same files, saying 0.0.1) refuses
 *      and changes nothing;
 *   4. uninstalled silently: the app, the Start menu entry, the file type and
 *      the Settings entry are gone; the library folder, the portable `data`
 *      folder and whatever a junction in the app folder pointed at are not.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { SETUP_APP_ID, SETUP_DIR, UNINSTALL_KEY } from '../desktop/lib.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'Terramentor';
const PROG_ID = 'Terramentor.StudyVault';
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

if (process.platform !== 'win32') { console.error('installer-check: Windows only'); process.exit(2); }
const onRunner = process.env.GITHUB_ACTIONS === 'true';
const inSandbox = userInfo().username === 'WDAGUtilityAccount';
if (!onRunner && !inSandbox) {
    console.error('installer-check: refuses to run here. It installs and removes the app for the account it runs as,\n'
        + 'so it runs only on a CI runner (GITHUB_ACTIONS=true) or in Windows Sandbox.');
    process.exit(2);
}

const setup = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--app');
const named = setup && /^Terramentor-(.+)-win32-x64-setup\.exe$/.exec(basename(setup));
if (!named || !existsSync(setup)) { console.error(`installer-check: no setup at ${setup}`); process.exit(2); }
const version = named[1];
const appSource = resolve(flag('--app') || join(dirname(setup), `${APP}-${version}-win32-x64`));

const local = process.env.LOCALAPPDATA;
const roaming = process.env.APPDATA;
const appDir = join(local, 'Programs', APP);
const startMenu = join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP}.lnk`);
const library = join(local, APP);
/** The Settings → Apps entry, as the launcher names it (it refreshes the version there after an update). */
const uninstallKey = UNINSTALL_KEY;
const logs = mkdtempSync(join(tmpdir(), 'installer-check-'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const good = JSON.stringify(got) === JSON.stringify(want);
    good ? pass++ : fail++;
    console.log(`${good ? '  ok  ' : ' FAIL '} ${name}${good ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (name, cond, detail = '') => check(name + (detail && !cond ? ` — ${detail}` : ''), !!cond, true);

/** A registry value (`null` = the key's default), or null when the key or value is not there. */
function regValue(key, name) {
    const r = spawnSync('reg', ['query', key, ...(name == null ? ['/ve'] : ['/v', name])], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return null;
    const line = r.stdout.split(/\r?\n/).find((l) => /\sREG_\w+\s/.test(l));
    const m = line && /\sREG_\w+\s+(.*)$/.exec(line);
    return m ? m[1].trim() : '';
}
const keyExists = (key) => spawnSync('reg', ['query', key], { windowsHide: true }).status === 0;

/** Runs a setup or uninstaller silently; its exit code, its log's tail on failure. */
function runSilently(exe, label, extra = []) {
    const log = join(logs, `${label}.log`);
    // In English whatever the machine's language, so the log reads the same everywhere.
    const r = spawnSync(exe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LANG=en', `/LOG=${log}`, ...extra], { windowsHide: true, timeout: 300_000 });
    return { status: r.status, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}
const tail = (text) => text.split(/\r?\n/).slice(-25).join('\n');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Waits until `done()` holds, up to `ms`. The uninstaller hands itself to a copy in the temp folder and returns at once. */
function waitFor(done, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (done()) return true; sleep(500); }
    return done();
}

/** A junction in the app folder to a folder outside it holding one file; the
 *  setup and the uninstaller clear the app folder, and must remove the
 *  junction without emptying what it points at. Returns the outside file. */
function plantJunction(label) {
    const outside = join(logs, `outside-${label}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'outside the app folder');
    symlinkSync(outside, join(appDir, 'linked-folder'), 'junction');
    return join(outside, 'keep.txt');
}

function freePort() {
    return new Promise((res, rej) => {
        const s = createServer();
        s.once('error', rej);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

console.log(`installer-check: ${basename(setup)} (${version}) into ${appDir}`);
if (keyExists(uninstallKey) || existsSync(appDir)) {
    console.error('installer-check: a copy is already installed for this account; this check starts from none.');
    process.exit(2);
}

// ---------------------------------------------------------------------------
console.log('\n--- 1. installed ---');
{
    const r = runSilently(setup, 'install');
    check('the setup finishes', r.status, 0);
    if (r.status !== 0) console.log(tail(r.log));
    ok('the app is in the per-user programs folder', existsSync(join(appDir, `${APP}.exe`)) && existsSync(join(appDir, 'build.json')));
    check('…the version it was built as', JSON.parse(readFileSync(join(appDir, 'build.json'), 'utf8')).version, version);
    ok('the uninstaller is in the folder the updater never moves', existsSync(join(appDir, SETUP_DIR, 'unins000.exe')));
    ok('the Start menu entry is there', existsSync(startMenu));

    check('Settings → Apps lists it', regValue(uninstallKey, 'DisplayName'), APP);
    check('…at this version', regValue(uninstallKey, 'DisplayVersion'), version);
    check('…installed where it is', (regValue(uninstallKey, 'InstallLocation') || '').replace(/\\+$/, '').toLowerCase(), appDir.toLowerCase());
    ok('…removable without an administrator', !keyExists(uninstallKey.replace(/^HKCU\\/, 'HKLM\\'))
        && /unins000\.exe/i.test(regValue(uninstallKey, 'UninstallString') || ''));
    ok('…under the installer\'s own id', uninstallKey.startsWith('HKCU\\') && uninstallKey.endsWith(`{${SETUP_APP_ID}}_is1`));

    const classes = 'HKCU\\Software\\Classes';
    check('.studyvault names the file type', regValue(`${classes}\\.studyvault`, null), PROG_ID);
    ok('…and offers it under Open with', regValue(`${classes}\\.studyvault\\OpenWithProgids`, PROG_ID) !== null);
    check('the file type has a name people read', regValue(`${classes}\\${PROG_ID}`, null), 'Terramentor course');
    check('the file type opens the file in the app', regValue(`${classes}\\${PROG_ID}\\shell\\open\\command`, null),
        `"${join(appDir, `${APP}.exe`)}" --open "%1"`);
    check('…with the app\'s icon', regValue(`${classes}\\${PROG_ID}\\DefaultIcon`, null), join(appDir, `${APP}.ico`));
    ok('…and its icon file is there', existsSync(join(appDir, `${APP}.ico`)));
    ok('nothing was written for every account', !keyExists(`HKLM\\Software\\Classes\\${PROG_ID}`));

    // The installed copy starts and answers, on a scratch library and port.
    const scratch = join(logs, 'library');
    const port = await freePort();
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(TERRAMENTOR_|DB_PATH$|VAULT_ROOT$|DATA_DIR$|PORT$|HOST$)/.test(k)) delete env[k];
    const run = spawnSync(join(appDir, 'runtime', 'node.exe'), ['desktop/launcher.js', '--check', '--data-dir', scratch, '--port', String(port)],
        { cwd: appDir, encoding: 'utf8', timeout: 120_000, env, windowsHide: true });
    check('the installed copy passes its own self-check', run.status, 0);
    if (run.status !== 0) console.log(`${run.stdout || ''}${run.stderr || ''}`.slice(-3000));
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. installed again over itself ---');
{
    const stale = join(appDir, 'left-by-an-older-version.txt');
    writeFileSync(stale, 'x');
    mkdirSync(join(appDir, 'data'), { recursive: true });
    writeFileSync(join(appDir, 'data', 'keep.txt'), 'a portable library');
    const outside = plantJunction('reinstall');
    const r = runSilently(setup, 'reinstall');
    check('the same setup runs again', r.status, 0);
    if (r.status !== 0) console.log(tail(r.log));
    ok('a file the new copy does not hold is gone', !existsSync(stale));
    ok('a junction in the app folder is gone', !existsSync(join(appDir, 'linked-folder')));
    ok('…and what it pointed at is untouched', existsSync(outside));
    ok('a portable data folder in the app folder is kept', existsSync(join(appDir, 'data', 'keep.txt')));
    ok('the app is still whole', existsSync(join(appDir, `${APP}.exe`)) && existsSync(join(appDir, SETUP_DIR, 'unins000.exe')));
    check('Settings → Apps lists it once, at this version', regValue(uninstallKey, 'DisplayVersion'), version);
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. an older setup over it ---');
{
    const out = join(logs, 'older');
    const build = spawnSync(process.execPath, [join(repoRoot, 'tools', 'build-installer.mjs'),
        '--app', appSource, '--out', out, '--version', '0.0.1', '--compression', 'none'], { encoding: 'utf8', windowsHide: true });
    check('an older setup is built from the same files', build.status, 0);
    if (build.status !== 0) console.log(`${build.stdout || ''}${build.stderr || ''}`.slice(-3000));
    const older = join(out, `${APP}-0.0.1-win32-x64-setup.exe`);
    if (existsSync(older)) {
        const before = readdirSync(appDir).sort();
        const r = runSilently(older, 'older');
        ok('the older setup refuses', r.status !== 0, `exit ${r.status}`);
        ok('…saying why, in its log', /already installed|older version/i.test(r.log), tail(r.log));
        check('…and changed nothing: the installed version', JSON.parse(readFileSync(join(appDir, 'build.json'), 'utf8')).version, version);
        check('…the Settings entry', regValue(uninstallKey, 'DisplayVersion'), version);
        check('…the app folder', readdirSync(appDir).sort(), before);
    }
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. uninstalled ---');
{
    const hadLibrary = existsSync(library);
    mkdirSync(library, { recursive: true });
    const marker = join(library, 'installer-check-keep.txt');
    writeFileSync(marker, 'the library');
    const outside = plantJunction('uninstall');
    const r = runSilently(join(appDir, SETUP_DIR, 'unins000.exe'), 'uninstall');
    check('the uninstaller starts', r.status, 0);
    const gone = waitFor(() => !keyExists(uninstallKey) && !existsSync(join(appDir, SETUP_DIR)), 120_000);
    ok('…and finishes', gone, tail(r.log));
    check('Settings → Apps no longer lists it', keyExists(uninstallKey), false);
    ok('the Start menu entry is gone', !existsSync(startMenu));
    check('the file type is gone', keyExists(`HKCU\\Software\\Classes\\${PROG_ID}`), false);
    check('.studyvault no longer names it', regValue('HKCU\\Software\\Classes\\.studyvault', null), null);
    check('the app folder holds only the portable data folder', existsSync(appDir) ? readdirSync(appDir) : [], ['data']);
    ok('…which is untouched', existsSync(join(appDir, 'data', 'keep.txt')));
    ok('a junction that was in the app folder pointed at something still whole', existsSync(outside));
    ok('the library folder is untouched', existsSync(marker));

    // Leaves the account as it found it, for whatever runs next. A junction
    // the uninstaller failed to remove goes first, by itself.
    const link = join(appDir, 'linked-folder');
    try { if (lstatSync(link).isSymbolicLink()) rmdirSync(link); } catch { /* not there */ }
    rmSync(appDir, { recursive: true, force: true });
    if (hadLibrary) rmSync(marker, { force: true });
    else rmSync(library, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(logs, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
