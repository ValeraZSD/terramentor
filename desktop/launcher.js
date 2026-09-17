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
//      reads it at import time, and a shell prefix is how a scratch server once
//      ended up on the real library (see the rule in docs/ARCHITECTURE.md).
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

import { existsSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
    APP_NAME, DEFAULT_PORT, PORT_ATTEMPTS, chooseDataDir, findBrowser, browserArgs,
    defaultBrowserCommand, findRunningInstance, portRange, prepareLogFile, startMenuShortcutScript,
    DEFAULT_WINDOW_MODE, launchCommand, shouldOpenWindow, DEFAULT_AUTOSTART_WINDOW, LIBRARY_POINTER,
} from './lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const packaged = existsSync(join(appRoot, 'build.json'));

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
// fills that directory with a browser profile too. Measured on 2026-09-17: a
// login item written without it opened a 1-project library while the 24-project
// one sat untouched two folders away. `launchCommand` is in lib.js with the
// other decisions, so the gate can read what a login item would say on every
// platform from this one.
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

/* A fatal the person needs to SEE. This process may have no console and no
 * window — started by a login item, or by the tray host, which reads this
 * stream. Printing it and exiting would be an app that does nothing and says
 * nothing; the tray host turns this line into a message box. Everything else
 * still reads it in logs/app.log. */
function fatal(message, code = 2) {
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
/* The browser profile this launcher opened its window on, and the only thing
 * quitting is allowed to close. Set when a window is actually spawned. */
let appProfile = null;

function openWindow(url, windowMode = DEFAULT_WINDOW_MODE) {
    const browser = findBrowser();
    if (browser) {
        const profile = join(chosen.dir || join(appRoot, 'server'), 'browser-profile');
        const child = spawn(browser, browserArgs(url, profile, windowMode), { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', (e) => {
            console.warn(`Could not start ${browser}: ${e.message}; opening the default browser instead`);
            openDefault(url);
        });
        appProfile = profile;
        child.unref();
        console.log(`Opened app window with ${browser}`);
        return;
    }
    openDefault(url);
}

/* Quit ends the process; this ends the window it opened.
 *
 * Neither half can close the other on its own. The page asks to close itself
 * (src/components/DesktopQuitScreen.tsx) and Chromium refuses the moment the
 * window has any session history — measured on a real `--app` Edge window:
 * `history.length` 1 closes, 2 is refused, and every route change in this app
 * is a pushState, so the window Quit is pressed in is always the refused kind.
 * That leaves the side that OPENED the window to close it, here, where the
 * process is leaving anyway.
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
        if (process.platform === 'win32') {
            const holders = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe' or Name='brave.exe' or Name='vivaldi.exe'"`
                + ` | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${appProfile.replace(/'/g, "''")}') }`;
            spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                `${holders} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
            ], { stdio: 'ignore', windowsHide: true, timeout: 8000 });
        } else {
            spawnSync('pkill', ['-f', appProfile], { stdio: 'ignore', timeout: 8000 });
        }
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

// --- Start Menu shortcut (Windows, packaged, once) --------------------------------
// Done on the first run rather than by an installer, because there is no
// installer: the app is a folder. The marker means "we did this once" — a person
// who deleted the shortcut is not told again.
function ensureStartMenuShortcut() {
    if (process.platform !== 'win32' || !packaged || !chosen.dir) return;
    const marker = join(chosen.dir, 'start-menu-shortcut.created');
    if (existsSync(marker)) return;
    const exe = join(appRoot, `${APP_NAME}.exe`);
    const cmd = join(appRoot, `${APP_NAME}.cmd`);
    const target = existsSync(exe) ? exe : existsSync(cmd) ? cmd : null;
    if (!target) return;
    const icon = join(appRoot, `${APP_NAME}.ico`);
    const script = startMenuShortcutScript({ target, workingDir: appRoot, icon: existsSync(icon) ? icon : null });
    const scriptFile = join(chosen.dir, 'start-menu-shortcut.ps1');
    try {
        writeFileSync(scriptFile, script, 'utf8');
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
            { stdio: 'ignore', windowsHide: true });
        child.on('exit', (code) => {
            if (code === 0) {
                try { writeFileSync(marker, stamp()); } catch { /* fine */ }
                console.log('Added a Start Menu shortcut');
            }
        });
        child.on('error', () => { /* no PowerShell: no shortcut, no problem */ });
    } catch { /* cosmetic */ }
}

// --- main --------------------------------------------------------------------------
(async () => {
    // 1. Someone already running on this library?
    if (!checkOnly) {
        const running = await findRunningInstance({ ports: portRange(startPort, PORT_ATTEMPTS), dataDir: chosen.dir });
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
            const status = await (await fetch(`${ready.url}/api/desktop/status`)).json();
            if (!v.version || status.app !== 'terramentor') throw new Error('unexpected answers');
            console.log(`Check OK: version ${v.version}, ${v.deployment} install, data at ${status.dataDir}`);
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
