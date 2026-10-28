#!/usr/bin/env node
// The desktop entry point: start the server, open a window on it, keep the
// library where the platform keeps per-user data, and get out of the way.
//
//   node desktop/launcher.js                  from a checkout (`npm run desktop`)
//   Terramentor.exe / Terramentor.app / terramentor.sh   a packaged copy (tools/build-desktop.mjs)
//
// What it does, in order:
//   1. Decide where the data lives (desktop/lib.js `chooseDataDir`) and set
//      DATA_DIR IN THIS PROCESS before the server is imported — the server
//      reads it at import time, and a shell prefix can silently fail and leave a
//      scratch server on the learner's real library (see docs/ARCHITECTURE.md).
//   2. Ask whether a Terramentor on the same data directory is already running
//      on any of the ports it could be on. If so, open a window at it and stop:
//      a second double-click means "show me the app", not "start another".
//   3. Import the server, wait for it to listen (it moves to the next port on
//      its own when the first is taken), and open a Chromium app window at the
//      real port — or the default browser when there is no Chromium.
//   4. Leave. The server stops itself when every window has been closed
//      (server/desktop.js), so there is nothing here to wait for.
//
// Flags:  --data-dir <dir>   --port <n>   --no-window   --check (start, verify, quit)
//         --autostart  this run came from the login item, so whether a window
//                      opens is the stored preference rather than a given.

import { existsSync, appendFileSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
    APP_NAME, DEFAULT_PORT, PORT_ATTEMPTS, chooseDataDir, findBrowser, browserArgs,
    defaultBrowserCommand, findRunningInstance, isOurInstance, portRange, prepareLogFile, startMenuShortcutScript,
    startMenuShortcutAction, START_MENU_FOLDER,
    DEFAULT_WINDOW_MODE, launchCommand, shouldOpenWindow, DEFAULT_AUTOSTART_WINDOW, LIBRARY_POINTER,
    LAST_LIBRARY, libraryFallbackNotice, userDataDir, relaunchCommand, launcherInstanceKey,
} from './lib.js';
import { libraryId, resolveDataPaths } from '../server/paths.js';
import { INSTANCE_KEY_FILE, newNonce, provesInstance } from '../server/instanceKey.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const packaged = existsSync(join(appRoot, 'build.json'));
/** Where an update is staged and swapped (desktop/updater.js). */
const updateDir = join(appRoot, '.update');

/** Whether the updater that wrote `.update/updater.pid` is still at work: its
 *  process answers (EPERM means it exists under another account, which still
 *  counts), and the file is younger than any update takes, so a pid the system
 *  has since given to something else does not keep a dead swap "in progress". */
function updaterRunning(now = Date.now()) {
    let pid = 0, started = 0;
    try { [pid, started] = readFileSync(join(updateDir, 'updater.pid'), 'utf8').trim().split(/\s+/).map(Number); } catch { return false; }
    if (!pid || !(now - started < 15 * 60_000)) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// --- flags --------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);
const wantWindow = !has('--no-window') && !has('--check');
const checkOnly = has('--check');
const autostart = has('--autostart');
/* Set by the Windows tray host (desktop/wrappers/Launcher.cs), which is the
 * only thing that can hold this app without a window on screen. */
const trayHosted = process.env.TERRAMENTOR_TRAY === '1';

// --- data directory -----------------------------------------------------------
const chosen = chooseDataDir({
    argDataDir: flag('--data-dir'),
    envDataDir: process.env.DATA_DIR,
    appRoot,
    packaged,
    platform: process.platform,
    env: process.env,
});
if (chosen.dir) process.env.DATA_DIR = chosen.dir;
process.env.TERRAMENTOR_DESKTOP = '1';

/* The library's instance key (server/instanceKey.js): what a server on one of
 * our ports has to prove it holds before this launcher opens a window on it,
 * and what the updater checks a new version against. Read from the folder the
 * server will resolve as its data directory — resolveDataPaths with the
 * environment just set, the same function the server calls — so the two can
 * never look in different places. The server reads the same file when it
 * starts; whichever of them comes first makes it. Read through
 * launcherInstanceKey (desktop/lib.js), which makes nothing when a pointer
 * names a folder that is gone: this runs before the missing-library stop
 * below, and creating that folder here would let the NEXT launch open an empty
 * library in it. */
const keyDir = resolveDataPaths({ env: process.env }).dataDir;
const instanceKey = launcherInstanceKey(chosen);

// --- how this copy is started, for the server to offer back ---------------------
// "Start when I sign in" writes a login item, and a login item is a COMMAND
// LINE. Only this file knows the one that works for this copy: a packaged
// Windows install has a windowless .exe, everything else is the bundled Node
// running this script. Guessing it in the server would produce a login item
// that fails silently every morning, so the server is told instead — and when
// it is not told, it reports that it cannot do this rather than pretending.
//
// The library is named EXPLICITLY in that command line whenever this run has
// one. A login item inherits none of how this run was started: not a `.env`
// file a package script passed to node, not an exported DATA_DIR, not the
// working directory a terminal was in. Without the flag the copy that opens at
// sign-in resolves the data directory afresh, falls through to the historical
// layout under `server/`, and greets its owner with an EMPTY library beside
// their real one — which reads as lost work, not as a misconfigured path, and
// fills that directory with a browser profile too. `launchCommand` is in lib.js
// with the other decisions, so the gate can read what a login item would say on
// every platform from this one.
const launch = launchCommand({
    platform: process.platform,
    packaged,
    appRoot,
    execPath: process.execPath,
    scriptPath: fileURLToPath(import.meta.url),
    dataDir: chosen.dir,
});
process.env.TERRAMENTOR_LAUNCH_TARGET = launch.target;
process.env.TERRAMENTOR_LAUNCH_ARGS = JSON.stringify(launch.args);
process.env.TERRAMENTOR_LAUNCH_DIR = appRoot;
{
    const ico = join(appRoot, `${APP_NAME}.ico`);
    if (existsSync(ico)) process.env.TERRAMENTOR_LAUNCH_ICON = ico;
}
process.env.PORT_FALLBACK = '1';
if (flag('--port')) process.env.PORT = flag('--port');
const startPort = Number(process.env.PORT) || DEFAULT_PORT;

// --- logging ------------------------------------------------------------------
// The console and a file, always both: a packaged launch has no console at all,
// and a checkout's terminal is the natural place to watch. Set up before the
// server is imported so its startup lines land in the file too.
const logDir = chosen.dir || join(appRoot, 'server');
let logFile = null;
try { logFile = prepareLogFile(logDir); } catch { /* unwritable: console only */ }
const stamp = () => new Date().toISOString();
for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        original(...args);
        if (!logFile) return;
        const line = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        try { appendFileSync(logFile, `${stamp()} [${level}] ${line}\n`); } catch { /* disk full: keep running */ }
    };
}

console.log(`${APP_NAME} desktop launcher — ${packaged ? 'packaged copy' : 'checkout'} at ${appRoot}`);
console.log(`Data directory: ${chosen.dir || '(historical layout under server/)'} [${chosen.why}]`);
/* Say which pointer file was looked for and not found. A packaged copy landing
 * on the default folder is either a first run or somebody's library quietly not
 * being picked up, and those two look identical in a log — the second is only
 * ever noticed as "the app opened empty". Naming the path turns a recurrence
 * into one readable line instead of a reconstruction from timestamps. */
if (chosen.why === 'user') console.log(`No library pointer at ${join(chosen.dir, LIBRARY_POINTER)} — using this folder.`);

/* The launcher's memory of where the library was. Written on every packaged
 * launch whose resolution came from the pointer machinery, into the per-user
 * folder — the one fixed place that does not move with the answer, which is
 * the whole point: it has to survive the pointer disappearing under it.
 *
 * The note never decides anything; the pointer file is the authority and a
 * missing one falls back exactly as before. It only makes the fallback LOUD:
 * read last launch's answer, then record this one, then warn when they differ
 * — a first run has no note, and someone who deleted their pointer on purpose
 * is quiet again after one launch, so the warning cannot become a nag.
 * `--data-dir`/`DATA_DIR` and the portable `data/` folder are explicit choices
 * and stay out of this entirely. */
if (packaged && (chosen.why === 'user' || chosen.why === 'pointer')) {
    const perUser = chosen.why === 'user'
        ? chosen.dir
        : userDataDir({ platform: process.platform, env: process.env });
    const lastFile = join(perUser, LAST_LIBRARY);
    let lastLibrary = null;
    try { lastLibrary = readFileSync(lastFile, 'utf8'); } catch { /* first run, or unreadable */ }
    const notice = libraryFallbackNotice({ why: chosen.why, dir: chosen.dir, lastLibrary });
    try { writeFileSync(lastFile, `${chosen.dir}\n`); } catch { /* cosmetic; the warning just cannot fire next time */ }
    if (notice) {
        // Twice as loud as the pointer line above, because this one names the
        // recovery: the path the real library was last served from, and the
        // one file to write to get back to it.
        console.log(notice.lastDirExists
            ? `Your library was last at ${notice.lastDir} — no pointer names it any more, so this run opened an empty one. `
                + `To restore it, write that path as one line into ${notice.pointerPath} and start the app again (or press Restore in the app).`
            : `Your library was last at ${notice.lastDir}, which is not reachable right now — this run opened an empty one instead. `
                + 'If it is on a drive that is not plugged in, plug it in and start the app again.');
        // The server is what can join this with "and the library here is
        // empty" — the one fact that separates a lost pointer from a person
        // who simply has not created anything yet — and put it on screen.
        process.env.TERRAMENTOR_LIBRARY_FALLBACK = JSON.stringify({
            lastDir: notice.lastDir,
            pointerPath: notice.pointerPath,
        });
    }
}

/* A fatal the person needs to SEE. This process may have no console and no
 * window — started by a login item, or by the tray host, which reads this
 * stream. Printing it and exiting would be an app that does nothing and says
 * nothing; the tray host turns this line into a message box. Everything else
 * still reads it in logs/app.log. */
function fatal(message, code = 2) {
    // A version on trial after an update (its swap journal is still there and
    // the updater is waiting for it) does not put up the tray's message box:
    // the box keeps the tray process alive, so the updater would wait out its
    // whole limit before putting the old version back. It leaves the reason
    // for the updater instead, which ends the trial at once and shows the
    // person the reason from the version that works.
    if (packaged && existsSync(join(updateDir, 'swap.json')) && updaterRunning()) {
        console.error(message);
        try { writeFileSync(join(updateDir, 'start-failed.txt'), String(message)); } catch { /* the exit still ends the trial */ }
        process.exit(code);
    }
    // Twice, on purpose, and to two places. The readable one is what a person
    // reading logs/app.log or a console wants. The marked one goes to STDOUT,
    // which is the pipe the tray host reads, as a SINGLE line — that pipe is
    // line-based, so a real newline would hand the tray the first sentence and
    // silently drop the rest, and the rest is the part that says what to do.
    console.error(message);
    console.log(`TERRAMENTOR_FATAL ${String(message).replace(/\r?\n/g, '\\n')}`);
    process.exit(code);
}

// --- the library has to be where it says it is ------------------------------------
// Only a pointer file can fail this way, and only by naming somewhere that is
// not there: an unplugged drive, a folder moved, a typo. Falling back to the
// default would open an EMPTY library beside the real one, which is the exact
// failure this whole area keeps producing and which reads as lost work.
if (chosen.missing) {
    fatal(
        `Your library is set to "${chosen.dir}", and that folder is not there.\n\n`
        + 'If it is on a drive that is not plugged in, plug it in and start the app again.\n\n'
        + `To go back to the default location instead, delete this file:\n${chosen.pointer}`,
        4,
    );
}

// --- the built app must exist ---------------------------------------------------
if (!existsSync(join(appRoot, 'dist', 'index.html'))) {
    fatal('No built app found (dist/index.html is missing). Run `npm run build` first, or use a packaged copy.');
}

// --- open a window ------------------------------------------------------------
/* The app's own browser profile: every window of this library opens on it,
 * whichever launch opened it. */
const profileDir = join(chosen.dir || join(appRoot, 'server'), 'browser-profile');
/* What quitting closes. Armed by the launcher that RUNS the server (main,
 * below), never by a transient open. */
let appProfile = null;

function openWindow(url, windowMode = DEFAULT_WINDOW_MODE) {
    const browser = findBrowser();
    if (browser) {
        // No windowsHide here. It puts SW_HIDE in the child's STARTUPINFO, and
        // Chromium honours that for its FIRST window whenever it boots a fresh
        // browser process — the app window exists, IsWindowVisible is False, and
        // "open" looks like nothing happened (measured: the identical spawn with
        // the flag showed a hidden 'Terramentor' window; Start-Process without
        // it showed the same window in 6.4 s). A GUI window is this call's
        // product; the flag belongs on console spawns only.
        const child = spawn(browser, browserArgs(url, profileDir, windowMode), { detached: true, stdio: 'ignore' });
        child.on('error', (e) => {
            console.warn(`Could not start ${browser}: ${e.message}; opening the default browser instead`);
            openDefault(url);
        });
        // No kill is armed here. A transient open — "already running, show me
        // a window" — exits at once, and an armed kill would close the window
        // it just opened, and every other window of the app with it, the
        // profile being one shared directory.
        child.unref();
        console.log(`Opened app window with ${browser}`);
        return;
    }
    openDefault(url);
}

/* Quit ends the process; this ends the app's windows — the one this run
 * opened and any a later launch opened on it ("already running").
 *
 * Neither half can close the other on its own. The page asks to close itself
 * (src/components/DesktopQuitScreen.tsx) and Chromium refuses the moment the
 * window has any session history — measured on a real `--app` Edge window:
 * `history.length` 1 closes, 2 is refused, and every route change in this app
 * is a pushState, so the window Quit is pressed in is always the refused kind.
 * That leaves the process that SERVES the window to close it, here, where it
 * is leaving anyway.
 *
 * By PROFILE, not by the pid we spawned: Edge re-launches itself, so within
 * seconds the process this launcher started is gone and the browser holding
 * the window is one it never saw (measured — `taskkill` on the spawned pid
 * took two processes and left the window standing). The profile directory is
 * inside the app's own data directory and is in the browser's command line, so
 * it identifies every process of this window and nothing else on the machine.
 * It is also what keeps this away from the default-browser fallback, which is
 * the person's own browser with their own tabs in it.
 *
 * Forcibly, because polite does not work: `taskkill /T` reports a signal sent
 * and the window stays (17 processes before, 18 after); `/T /F` on the browser
 * process takes the tree with it. The profile is the app's own and the next
 * launch opens it on a URL from the command line, so there is no session to
 * restore and nothing to lose. */
process.on('exit', () => {
    if (!appProfile) return;
    try {
        let r;
        if (process.platform === 'win32') {
            // The profile path reaches PowerShell through the ENVIRONMENT, never
            // the command text. It is a folder name the person chose, and a
            // single-quoted PowerShell string also ends at the curly quotes
            // U+2018–U+201B, so quoting it into the script let a library under
            // a name like O’Brien end the string and run the rest as code.
            const holders = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe' or Name='brave.exe' or Name='vivaldi.exe'"`
                + ' | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:TERRAMENTOR_APP_PROFILE) }';
            r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                // A browser's helpers exit with its main process, so a stop that
                // finds its process gone is a close; one still running is a failure.
                `$failed = $false; ${holders} | ForEach-Object { $id = $_.ProcessId; try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $failed = $true } } }; if ($failed) { exit 1 }`,
            ], { stdio: 'ignore', windowsHide: true, timeout: 8000, env: { ...process.env, TERRAMENTOR_APP_PROFILE: appProfile } });
        } else {
            // pkill reads a pattern, and a library path may hold ( + [ and the like.
            // Its exit 1 is "nothing matched": no window was open.
            r = spawnSync('pkill', ['-f', appProfile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { stdio: 'ignore', timeout: 8000 });
            if (r.status === 1) r = null;
        }
        // A close that did not happen leaves a window on a stopped server, and
        // after an update a second window beside the new one: say so in the log.
        if (r && (r.error || r.status !== 0)) console.warn(`Could not close the app's windows: ${r.error?.message || `exit ${r.status}`}`);
    } catch { /* leaving anyway; the page's own screen says the app has stopped */ }
});

function openDefault(url) {
    const { cmd, args } = defaultBrowserCommand(url);
    try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => console.warn(`Could not open a browser. Open this address yourself: ${url}`));
        child.unref();
        console.log(`Opened default browser at ${url}`);
    } catch {
        console.warn(`Could not open a browser. Open this address yourself: ${url}`);
    }
}

// --- Start Menu shortcut (Windows, packaged) ---------------------------------------
// Done on the first run rather than by an installer, because there is no
// installer: the app is a folder. The marker records which copy the shortcut
// opens, so an update (a new folder) moves it — see startMenuShortcutAction. A
// person who deleted the shortcut is not given it again.
function ensureStartMenuShortcut() {
    if (process.platform !== 'win32' || !packaged || !chosen.dir) return;
    const marker = join(chosen.dir, 'start-menu-shortcut.created');
    const exe = join(appRoot, `${APP_NAME}.exe`);
    const cmd = join(appRoot, `${APP_NAME}.cmd`);
    const target = existsSync(exe) ? exe : existsSync(cmd) ? cmd : null;
    if (!target) return;
    let written = null;
    try { written = readFileSync(marker, 'utf8'); } catch { /* none yet */ }
    const lnk = process.env.APPDATA ? join(process.env.APPDATA, START_MENU_FOLDER, `${APP_NAME}.lnk`) : null;
    const action = startMenuShortcutAction({ marker: written, target, shortcutExists: lnk ? existsSync(lnk) : false });
    if (action === 'none') return;
    const icon = join(appRoot, `${APP_NAME}.ico`);
    const script = startMenuShortcutScript({ target, workingDir: appRoot, icon: existsSync(icon) ? icon : null });
    const scriptFile = join(chosen.dir, 'start-menu-shortcut.ps1');
    try {
        writeFileSync(scriptFile, script, 'utf8');
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
            { stdio: 'ignore', windowsHide: true });
        child.on('exit', (code) => {
            if (code === 0) {
                try { writeFileSync(marker, target); } catch { /* fine */ }
                console.log(action === 'update' ? 'Pointed the Start Menu shortcut at this copy' : 'Added a Start Menu shortcut');
            }
        });
        child.on('error', () => { /* no PowerShell: no shortcut, no problem */ });
    } catch { /* cosmetic */ }
}

// --- installing an update -------------------------------------------------------------
// The server downloads and stages the next version (server/appUpdate.js); it
// never installs it. "Restart to update" hands over to this function, which
// starts desktop/updater.js as a separate, detached process and lets this one
// exit. The updater runs from a COPY under `.update/runner/` — the runtime, the
// updater and the two modules it imports — because the folders it moves are
// the ones this process runs from, and Windows refuses to rename a folder while
// a program inside it is open.
function startUpdater() {
    const runner = join(updateDir, 'runner');
    rmSync(runner, { recursive: true, force: true });
    for (const d of ['desktop', 'server', 'runtime']) mkdirSync(join(runner, d), { recursive: true });
    const node = join(runner, 'runtime', basename(process.execPath));
    copyFileSync(process.execPath, node);
    copyFileSync(join(here, 'updater.js'), join(runner, 'desktop', 'updater.js'));
    copyFileSync(join(here, 'updateCore.js'), join(runner, 'desktop', 'updateCore.js'));
    copyFileSync(join(appRoot, 'server', 'version.js'), join(runner, 'server', 'version.js'));
    // How the updater tells the new version from anything else on its ports.
    copyFileSync(join(appRoot, 'server', 'instanceKey.js'), join(runner, 'server', 'instanceKey.js'));
    writeFileSync(join(runner, 'package.json'), '{"type":"module"}\n');
    // The new version starts the way this one was started — the login-item
    // command line, plus the flags a person or a test gave this run.
    const kept = [];
    if (flag('--port')) kept.push('--port', flag('--port'));
    if (has('--no-window')) kept.push('--no-window');
    const plan = {
        appRoot,
        waitPids: [process.pid, trayHosted ? process.ppid : null].filter(Boolean),
        // Never a batch file: Node will not spawn one without a shell
        // (lib.js relaunchCommand), so a .cmd login item becomes the bundled
        // Node on this script, which is all the .cmd does.
        relaunch: relaunchCommand(
            { target: launch.target, args: [...launch.args, ...kept] },
            { execPath: process.execPath, scriptPath: fileURLToPath(import.meta.url) },
        ),
        ports: portRange(startPort, PORT_ATTEMPTS),
        libraryId: chosen.dir ? libraryId(chosen.dir) : null,
        // The PATH of the key, never the key: the plan sits in the app's own
        // folder, which on a portable copy may be readable by anyone, while
        // the key file is the account's alone.
        instanceKeyFile: join(keyDir, INSTANCE_KEY_FILE),
        logFile: logFile ? join(dirname(logFile), 'updater.log') : null,
        timeoutMs: 120_000,
    };
    const planFile = join(runner, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan, null, 2));
    const child = spawn(node, [join(runner, 'desktop', 'updater.js'), planFile], {
        cwd: runner, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    console.log(`Started the updater (pid ${child.pid}); this copy is closing so it can be replaced`);
}

/* A swap cut short — power lost, or the updater killed, between its first and
 * last rename — leaves a journal and no updater. Undo it before anything else
 * reads the app's files, so this start is the old version, whole. */
async function finishInterruptedSwap() {
    const journalFile = join(updateDir, 'swap.json');
    if (!existsSync(journalFile)) return;
    if (updaterRunning()) return;
    try {
        const core = await import('./updateCore.js');
        await core.undoSwap({ journal: JSON.parse(readFileSync(journalFile, 'utf8')), journalFile });
        console.warn('An update was interrupted while it replaced the app; the previous version was put back.');
    } catch (e) {
        console.error(`An update was interrupted and could not be undone: ${e.message}`);
    }
}

// --- main --------------------------------------------------------------------------
(async () => {
    if (packaged) await finishInterruptedSwap();
    // 1. Someone already running on this library?
    if (!checkOnly) {
        if (!instanceKey) console.warn(`Could not read or create ${join(keyDir, INSTANCE_KEY_FILE)}; not looking for a running copy`);
        const running = await findRunningInstance({ ports: portRange(startPort, PORT_ATTEMPTS), dataDir: chosen.dir, key: instanceKey });
        if (running) {
            // Its own status carries both preferences; this process never reads
            // the database (the running one owns it), and its `trayHosted` is
            // the one that counts — the icon on screen belongs to THAT process.
            const show = shouldOpenWindow({
                wantWindow,
                autostart,
                autostartWindow: running.status?.autostartWindow || DEFAULT_AUTOSTART_WINDOW,
                trayHosted: running.status?.trayHosted === true,
            });
            console.log(`${APP_NAME} is already running on port ${running.port}${show ? ' — opening a window there' : ''}`);
            if (show) openWindow(running.url, running.status?.windowMode);
            process.exit(0);
        }
    }

    // 2. Start the server in THIS process. The import has side effects on
    //    purpose: the env above is what it reads.
    // `server` is read again below, by the tray shutdown channel, so it is
    // declared out here rather than inside the try — a `const` in there is
    // scoped to it, and the reference below would throw at RUN time, in the one
    // configuration that reaches it.
    let ready, server;
    try {
        server = await import(pathToFileURL(join(appRoot, 'server', 'index.js')).href);
        ready = await server.serverReady;
    } catch (e) {
        fatal(`The server failed to start.\n\n${e?.message || e}\n\nThe full log is in logs/app.log beside your library.`, 1);
    }
    console.log(`Serving at ${ready.url}`);

    // Only a packaged copy replaces itself; a checkout updates through git.
    if (packaged && !checkOnly && typeof server.setUpdateInstaller === 'function') {
        server.setUpdateInstaller(() => {
            try {
                startUpdater();
            } catch (e) {
                // Nothing was moved and the app keeps running; the panel shows this.
                console.error(`Could not start the updater: ${e.message}`);
                try {
                    writeFileSync(join(updateDir, 'result.json'), JSON.stringify({
                        ok: false, step: 'updater', at: new Date().toISOString(),
                        reason: `The updater could not be started (${e.code || e.message}). Nothing was changed.`,
                    }));
                } catch { /* the log line above stands */ }
                return;
            }
            server.shutdownProcess('update');
        });
    }

    // --- the tray icon's shutdown channel ---------------------------------
    // Under the Windows tray host this process is a child whose standard input
    // is a pipe the icon holds open. Closing it is how "Quit" asks for a clean
    // stop — Windows has no SIGTERM to send a child, and the HTTP quit endpoint
    // sits behind the password gate on purpose (that gate is what stops someone
    // on the tailnet stopping the app, and a menu item must not need an
    // exception to it). It works the other way too: if the icon's process dies,
    // the pipe closes and the server goes with it, so a killed tray icon cannot
    // leave an orphan holding the port.
    if (trayHosted) {
        // Read the export FIRST, and unconditionally. The build's second
        // self-check runs this file with TERRAMENTOR_TRAY=1 precisely so that
        // this line is evaluated, because a reference error here survives
        // `node --check` and every gate; folding the `checkOnly` test into the
        // same condition would short-circuit past it and hide the one bug the
        // check exists for.
        const stopServer = server.shutdownProcess;
        // …but do not ARM it during --check: that runs under spawnSync, whose
        // standard input is closed the instant the child starts, which would
        // shut the server down before the check had verified anything and
        // report a pass it never earned.
        if (typeof stopServer === 'function' && !checkOnly) {
            let stopping = false;
            const stop = () => {
                if (stopping) return;
                stopping = true;
                stopServer('the tray icon asked');
            };
            // `end` on a clean close, `close` when the handle goes, `error` on a
            // broken pipe — all three mean the same thing, and only the first to
            // arrive does anything.
            process.stdin.on('end', stop);
            process.stdin.on('close', stop);
            process.stdin.on('error', stop);
            process.stdin.resume();
        }
    }

    if (checkOnly) {
        // Prove the whole thing works end to end, then leave: the build script
        // and CI run this against a packaged copy in a scratch data directory.
        try {
            const res = await fetch(`${ready.url}/api/version`);
            const v = await res.json();
            const nonce = newNonce();
            const status = await (await fetch(`${ready.url}/api/desktop/status?nonce=${nonce}`)).json();
            if (!v.version || status.app !== 'terramentor') throw new Error('unexpected answers');
            // The probe answers with an id rather than the path (server/desktop.js),
            // so ASK it the question the launcher actually asks — is this the
            // library we started — instead of printing a path back at ourselves.
            if (!isOurInstance(status, chosen.dir)) throw new Error('the server is not on the library we started');
            // …and the challenge every later launch will send, so a build whose
            // server cannot answer it fails here rather than quietly opening a
            // second server on every double-click.
            if (!provesInstance(status, { key: instanceKey, nonce, port: Number(new URL(ready.url).port) })) {
                throw new Error('the server did not answer the instance challenge');
            }
            console.log(`Check OK: version ${v.version}, ${v.deployment} install, data at ${chosen.dir || 'the checkout layout'}`);
            const info = readFileSync(join(appRoot, 'package.json'), 'utf8');
            if (JSON.parse(info).version !== v.version) throw new Error('version mismatch');
            await fetch(`${ready.url}/api/desktop/quit`, { method: 'POST' });
        } catch (e) {
            console.error('Check FAILED:', e.message);
            process.exit(1);
        }
        return;
    }

    // 3. Open the window and hand over to the lifecycle. How it opens is a
    //    stored preference, and it can only be applied HERE: a browser window
    //    cannot maximise itself after the fact from inside the page.
    // Armed by every run that serves the app, whether or not it opens a window
    // itself: a run started at sign-in without one (or with --no-window) serves
    // the windows later launches open ("already running"), and when it left
    // for an update those stayed — the old window reloaded onto the new version
    // and the new version opened its own, so there were two.
    appProfile = profileDir;
    if (wantWindow) {
        let mode = DEFAULT_WINDOW_MODE;
        let autostartWindow = DEFAULT_AUTOSTART_WINDOW;
        try {
            const status = await (await fetch(`${ready.url}/api/desktop/status`)).json();
            if (status?.windowMode) mode = status.windowMode;
            if (status?.autostartWindow) autostartWindow = status.autostartWindow;
        } catch { /* a preference, not a requirement */ }
        if (shouldOpenWindow({ wantWindow, autostart, autostartWindow, trayHosted })) {
            openWindow(ready.url, mode);
        } else {
            // The tray host watches this stream for exactly this line and says,
            // once and quietly, where the app went. An app that starts invisibly
            // and says nothing cannot be told apart from one that failed.
            console.log('TERRAMENTOR_TRAY_HINT background');
        }
    }
    ensureStartMenuShortcut();
})();
