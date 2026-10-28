// The launcher's decisions, as functions of their inputs.
//
// Everything in here is pure or injectable — which browser to open, where the
// data goes, whether a server on some port is ours, how the log file is kept
// bounded — so `tools/desktop-gates.mjs` can assert each decision on every
// platform from one machine. `launcher.js` is the thin script that runs them.

import { existsSync, statSync, renameSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, posix, win32 } from 'node:path';
import { delimiter } from 'node:path';
import { libraryId, resolveDataPaths, userDataDir } from '../server/paths.js';
import { loadInstanceKey, newNonce, provesInstance } from '../server/instanceKey.js';

export const APP_NAME = 'Terramentor';
export const DEFAULT_PORT = 3001;
export const PORT_ATTEMPTS = 10;

/** The size a plain `window` opens at. */
export const WINDOW_SIZE = '1280,860';

/** How the window opens. A preference, because the answer depends on what the
 *  machine is: on a laptop the app is one window among many, on a machine
 *  kept for studying it is the screen. Chromium takes all
 *  three as launch flags; there is no fourth that means anything here.
 *  `window` sends `--window-size=WINDOW_SIZE`; the other two send their state
 *  flag and no size (see `browserArgs`).
 *
 *  Maximised by default: a 1280x860 window is most of a laptop's screen
 *  anyway, and on a desktop monitor it opened as a box in the corner that
 *  every new learner had to maximise by hand. */
export const WINDOW_MODES = ['window', 'maximized', 'fullscreen'];
export const DEFAULT_WINDOW_MODE = 'maximized';

// --- where the data goes ----------------------------------------------------

/**
 * Which directory this install keeps its library in.
 *
 *   --data-dir X / DATA_DIR   the person said so
 *   <appRoot>/data exists     a PORTABLE install: the app was unpacked onto a
 *                             USB stick or a folder somebody wants self-contained,
 *                             and making a `data` folder beside it is the whole
 *                             gesture. Never created by us — only honoured.
 *   a pointer file            packaged, and the per-user folder holds a
 *                             `library-location.txt` naming somewhere else —
 *                             a library on the big disk rather than the full one
 *   packaged                  the platform's per-user app-data folder
 *   a checkout                null: leave the server on its historical
 *                             `server/terramentor.db`, so `npm run desktop` on the
 *                             repo opens the same library `npm run dev` does.
 */
export function chooseDataDir({ argDataDir, envDataDir, appRoot, packaged, platform, env, home, exists = existsSync, readFile = readFileSync }) {
    if (argDataDir) return { dir: resolve(argDataDir), why: 'argument' };
    if (envDataDir) return { dir: resolve(envDataDir), why: 'environment' };
    const portable = join(appRoot, 'data');
    if (exists(portable)) return { dir: portable, why: 'portable' };
    if (packaged) {
        const perUser = userDataDir({ platform, env, home });
        const note = join(perUser, LIBRARY_POINTER);
        if (exists(note)) {
            let target = null;
            try { target = readLibraryPointer(readFile(note, 'utf8')); } catch { /* unreadable: the default */ }
            if (target) {
                const dir = resolve(target);
                // `missing` rather than a silent fall back to the default. A
                // pointer is somebody SAYING where their library is; if it is
                // not there — an unplugged drive, a typo — opening a different
                // one instead is the failure this whole area keeps producing,
                // and it reads as lost work rather than as a path problem.
                return { dir, why: 'pointer', pointer: note, missing: !exists(dir) };
            }
        }
        return { dir: perUser, why: 'user' };
    }
    return { dir: null, why: 'checkout' };
}

/**
 * A packaged install keeps its library in the folder the platform reserves for
 * per-user data. That folder is on the system drive, and a system drive is the
 * one most likely to be full — a library with a few imported decks in it runs to
 * gigabytes, and "put it on the big disk" is an ordinary thing to want.
 *
 * So: one line of text in the default folder, naming where the library really
 * is. Deliberately a plain file rather than a registry key or a database of its
 * own — it can be read, edited and deleted by hand, and deleting it puts
 * everything back to the default.
 *
 * Blank lines and `#` comments are skipped so the file can explain itself.
 */
export const LIBRARY_POINTER = 'library-location.txt';

export function readLibraryPointer(text) {
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        return t;
    }
    return null;
}

/** What that file looks like when the app writes one. */
export function libraryPointerFile(dir) {
    return [
        `# ${APP_NAME} keeps its library here.`,
        '# Delete this file to go back to the default folder beside it.',
        '# One absolute path, on its own line.',
        '',
        dir,
        '',
    ].join('\n');
}

/**
 * The launcher's own memory of where the library WAS, one line, written into
 * the per-user folder on every packaged launch. The pointer file is the
 * authority and this never overrides it — but the pointer can disappear (when
 * it does, every launch falls back to the default folder and serves an empty
 * library, read as an onboarding screen rather than as lost work). This note is what turns a
 * recurrence from silence into a sentence: the next launch reads it, sees the
 * library it is about to open is not the one it opened last time, and says so.
 */
export const LAST_LIBRARY = 'last-library.txt';

/**
 * Whether this launch should warn that the library it is about to open is
 * probably not the one the person means to be in.
 *
 * The trigger is narrow on purpose — the app may not nag a genuine first run.
 * It fires only when a packaged copy resolved to the DEFAULT per-user folder
 * (no pointer was honoured) AND the launcher's own note says the previous
 * launch resolved somewhere else. That is exactly the shape of a lost pointer,
 * and it cannot fire on a first run (no note yet) or on someone who deleted
 * their pointer on purpose (the documented undo — after one launch the note
 * says the default folder too, and the warning never fires again).
 *
 * A pointer that names a missing folder is handled upstream, by stopping with
 * a fatal: a pointer is somebody SAYING where their library is, and falling
 * back is the failure. This warning is for when there is no pointer at all and
 * the fallback has already happened — the case a fatal cannot see.
 */
export function libraryFallbackNotice({ why, dir, lastLibrary, exists = existsSync, platform = process.platform } = {}) {
    if (why !== 'user' || !lastLibrary) return null;
    // Paths compare the way the file system compares them (see isOurInstance),
    // and resolve the way the TARGET file system parses them: a POSIX resolve
    // reads `C:\u\Terramentor\` as a relative name (cwd + a folder with a
    // backslash in it), so two spellings of the same Windows folder would
    // never meet on a Linux host — this comparison runs cross-platform in the
    // gates, where the host's resolve() is POSIX.
    const pathPlatform = platform === 'win32' ? win32 : posix;
    const norm = (p) => {
        const r = pathPlatform.resolve(String(p || ''));
        return platform === 'win32' ? r.toLowerCase() : r;
    };
    const lastDir = pathPlatform.resolve(String(lastLibrary).trim());
    if (norm(lastDir) === norm(dir)) return null;
    return {
        lastDir,
        // Read again at answer time too (the server re-checks); this decides
        // which sentence the log prints, the moment the decision is made.
        lastDirExists: !!exists(lastDir),
        // A `user` resolution means the pointer was not followed, so the file
        // this launch wanted is the one in the default folder itself.
        pointerPath: join(dir, LIBRARY_POINTER),
    };
}

// --- which browser opens the window ------------------------------------------

/**
 * Candidate Chromium-family executables, most likely first. A Chromium `--app`
 * window is what makes this a desktop app rather than a tab: no address bar,
 * its own taskbar entry, its own icon, remembered size. Edge is first on
 * Windows because it is on every Windows 10/11 machine; Chrome first
 * elsewhere. Firefox has no equivalent mode and is deliberately not listed —
 * the fallback (the default browser, as a tab) covers it.
 */
export function browserCandidates(platform, env = {}) {
    if (platform === 'win32') {
        const pf = env['ProgramFiles'] || 'C:\\Program Files';
        const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const local = env.LOCALAPPDATA || '';
        const roots = [pf, pf86, local].filter(Boolean);
        const rel = [
            ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
            ['Google', 'Chrome', 'Application', 'chrome.exe'],
            ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
            ['Chromium', 'Application', 'chrome.exe'],
            ['Vivaldi', 'Application', 'vivaldi.exe'],
        ];
        const out = [];
        for (const parts of rel) for (const root of roots) out.push(join(root, ...parts));
        return out;
    }
    if (platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
        ];
    }
    // Linux and the BSDs: names on PATH.
    return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser', 'vivaldi'];
}

/** Resolve a bare command name against PATH; absolute paths pass through. */
export function whichOnPath(name, env = process.env, exists = existsSync) {
    if (name.includes('/') || name.includes('\\')) return exists(name) ? name : null;
    for (const dir of String(env.PATH || '').split(delimiter)) {
        if (!dir) continue;
        const full = join(dir, name);
        if (exists(full)) return full;
    }
    return null;
}

/** The first installed Chromium-family browser, or null. */
export function findBrowser({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
    for (const candidate of browserCandidates(platform, env)) {
        const found = platform === 'win32' || platform === 'darwin'
            ? (exists(candidate) ? candidate : null)
            : whichOnPath(candidate, env, exists);
        if (found) return found;
    }
    return null;
}

/**
 * Arguments for an app window. `--user-data-dir` is the load-bearing one: a
 * dedicated profile makes this a separate browser instance, so the window is
 * not a tab of the person's daily browser, it opens even when that browser is
 * closed, and it cannot be hijacked by "open all my tabs from last time".
 * `--no-first-run`/`--no-default-browser-check` silence what a fresh profile
 * would otherwise ask on the first launch.
 */
export function browserArgs(url, profileDir, windowMode = DEFAULT_WINDOW_MODE) {
    const args = [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=TranslateUI',
    ];
    // EXCLUSIVE, not additive. Chromium does not ignore `--window-size` when
    // `--start-maximized` is also given: measured in Edge with both flags and
    // the stored mode set to `maximized`, the window opened 1280x860 at 10,10
    // on a 2560x1440 screen, `IsZoomed` false. The size wins, so only one of
    // the three is ever sent.
    if (windowMode === 'maximized') args.push('--start-maximized');
    else if (windowMode === 'fullscreen') args.push('--start-fullscreen');
    else args.push(`--window-size=${WINDOW_SIZE}`);
    return args;
}

/** The command that opens a URL in whatever the default browser is. */
export function defaultBrowserCommand(url, platform = process.platform) {
    if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/c', 'start', '', url] };
    if (platform === 'darwin') return { cmd: 'open', args: [url] };
    return { cmd: 'xdg-open', args: [url] };
}

// --- is that server ours? -----------------------------------------------------

/**
 * Whether a status answer describes a Terramentor serving the same library.
 * Same app on a DIFFERENT directory is not ours: two portable copies on one
 * machine are two libraries and each gets its own server.
 *
 * The answer carries a HASH of its data directory rather than the directory
 * (server/paths.js `libraryId`, and server/desktop.js for why): the probe is
 * public, and a public answer must not name the account. The hash normalises
 * the path as a direct comparison would, case-insensitively on Windows
 * where the file system is.
 *
 * This is the CLAIM half only: what the answer says about itself. Anything on
 * the machine can say it, so the launcher never acts on this alone —
 * `findRunningInstance` also requires the answer to prove it holds the
 * library's key (server/instanceKey.js). An older build that answered with its
 * path and no id was recognised here once; it cannot prove anything, so it is
 * no longer recognised at all, and a launcher meeting one starts its own
 * server on the next free port.
 */
export function isOurInstance(status, dataDir, platform = process.platform) {
    if (!status || status.app !== 'terramentor' || !status.desktop) return false;
    if (!dataDir) return true; // a checkout on the historical layout: one library per checkout
    return typeof status.libraryId === 'string' && status.libraryId === libraryId(dataDir, platform);
}

/**
 * Ask each candidate port whether our server is already there. `fetchImpl` is
 * injected so the gate can drive it; each probe has a short timeout because a
 * port held by something that never answers must not stall the launch.
 *
 * `key` is this library's instance key. Each probe sends a fresh nonce and
 * accepts only an answer carrying the HMAC of that nonce and that port under
 * the key — a server some other account started on one of these ports can
 * repeat everything else in the answer, but not that. No key (the data folder
 * could not be written) means nothing is trusted and the caller starts its own
 * server; a second server is a nuisance, a window on someone else's is not.
 */
/**
 * The launcher's instance key for the library `chooseDataDir` picked, or null.
 *
 * Reading the key makes it when there is none, and making it makes its folder
 * (server/instanceKey.js): a first run on a new default folder needs exactly
 * that, or the launcher holds no key and cannot check the server it starts.
 * A POINTER at a folder that is not there is the one place it must not
 * happen. The launcher reads the key before it stops on a missing library, so
 * the first launch would create the folder and then stop, and the second
 * would find the folder, call the library present, and open a new empty one
 * where the moved library used to be. So a missing pointer target gets no key,
 * nothing is created, and the stop that follows says what is wrong on every
 * launch until the drive is back or the pointer is deleted.
 *
 * The folder is the one the server will use: `chosen.dir` (the launcher hands
 * it over as DATA_DIR), or, on a checkout where nothing was chosen, whatever
 * resolveDataPaths makes of the environment, the same function the server
 * calls.
 */
export function launcherInstanceKey(chosen, { env = process.env, load = loadInstanceKey } = {}) {
    if (!chosen || chosen.missing) return null;
    return load(chosen.dir ? resolve(chosen.dir) : resolveDataPaths({ env }).dataDir);
}

export async function findRunningInstance({ ports, dataDir, key, fetchImpl = globalThis.fetch, platform = process.platform, timeoutMs = 1500, nonce = newNonce }) {
    if (!key) return null;
    // Both schemes: a checkout with mkcert certificates in `.certs` serves
    // https, a packaged copy serves http, and the probe cannot know which.
    for (const port of ports) {
        for (const proto of ['http', 'https']) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            const challenge = nonce();
            try {
                const res = await fetchImpl(`${proto}://127.0.0.1:${port}/api/desktop/status?nonce=${challenge}`, { signal: ctrl.signal });
                if (!res.ok) continue;
                const body = await res.json();
                if (isOurInstance(body, dataDir, platform) && provesInstance(body, { key, nonce: challenge, port })) {
                    return { port, url: `${proto}://127.0.0.1:${port}`, status: body };
                }
            } catch {
                // nothing there, or something else there
            } finally {
                clearTimeout(timer);
            }
        }
    }
    return null;
}

export function portRange(start = DEFAULT_PORT, count = PORT_ATTEMPTS) {
    return Array.from({ length: count }, (_, i) => start + i);
}

// --- the log file -------------------------------------------------------------

export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Where the launcher writes what the console would have shown. A hidden
 * process has no console, and "it did nothing" is the report a stranger sends;
 * the log is what turns that into a bug report. Rotated once when it passes
 * the cap — `app.log` and `app.log.1`, never more, because a log that grows
 * forever on a machine that runs the app for a year is its own bug.
 */
export function prepareLogFile(dir, { stat = statSync, rename = renameSync, mkdir = mkdirSync, exists = existsSync } = {}) {
    const logDir = join(dir, 'logs');
    mkdir(logDir, { recursive: true });
    const file = join(logDir, 'app.log');
    try {
        if (exists(file) && stat(file).size > LOG_MAX_BYTES) rename(file, `${file}.1`);
    } catch { /* rotation is a courtesy */ }
    return file;
}

const DESCRIPTION = 'Local-first mastery engine for self-directed learners';

/**
 * A value handed to PowerShell as DATA, never as source text: the base64 of
 * its UTF-8 bytes, decoded when the script runs.
 *
 * The values are paths, and a path is whatever the person's folders are
 * called. Quoting one into a PowerShell string literal means knowing every
 * character PowerShell treats as a quote, and that list is longer than it
 * looks: a single-quoted string also ends at U+2018, U+2019, U+201A and
 * U+201B, the curly quotes a keyboard autocorrects into a name like O’Brien.
 * Doubling only `'` left those to end the string early. Base64 has no quote
 * of any kind in its alphabet, so there is nothing to get wrong, and the
 * script is still one self-contained file — which matters, because the text
 * of the script is what `refreshLoginItem` (server/desktop.js) compares to
 * notice that a login item names an old copy of the app.
 */
const psValue = (s) => `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(String(s), 'utf8').toString('base64')}')))`;

/** The PowerShell that writes one Windows shortcut. `shellFolder` is the
 *  `$env:APPDATA`-relative folder it goes in — Start Menu or Startup — because
 *  a .lnk is a COM object and only PowerShell can make one here. Deleting one
 *  needs no script, so there is no counterpart. */
export function shortcutScript({ shellFolder, target, workingDir, icon, args = '', name = APP_NAME }) {
    return [
        '$ErrorActionPreference = "Stop"',
        `$dir = Join-Path $env:APPDATA ${psValue(shellFolder)}`,
        'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
        `$lnk = Join-Path $dir ${psValue(name + '.lnk')}`,
        '$shell = New-Object -ComObject WScript.Shell',
        '$s = $shell.CreateShortcut($lnk)',
        `$s.TargetPath = ${psValue(target)}`,
        args ? `$s.Arguments = ${psValue(args)}` : null,
        `$s.WorkingDirectory = ${psValue(workingDir)}`,
        icon ? `$s.IconLocation = ${psValue(icon)}` : null,
        // Minimized. Every target `launchCommand` prefers is windowless already
        // — the compiled launcher, or wscript.exe running the shim — so this
        // changes nothing for them. It is for the two fallbacks that DO open a
        // console: `Terramentor.cmd` when the C# compiler was unavailable at
        // build time, and bare `node.exe` when the shim is missing. That console
        // is not a log viewer; it IS the server, so closing it to tidy the
        // desktop stops the app. Minimised is as close as a .lnk gets to keeping
        // it out of the way.
        '$s.WindowStyle = 7',
        `$s.Description = ${psValue(DESCRIPTION)}`,
        '$s.Save()',
    ].filter(Boolean).join('\n');
}

export const START_MENU_FOLDER = 'Microsoft\\Windows\\Start Menu\\Programs';
export const STARTUP_FOLDER = 'Microsoft\\Windows\\Start Menu\\Programs\\Startup';

/** The PowerShell that puts a Start Menu shortcut next to every other app. */
export function startMenuShortcutScript({ target, workingDir, icon, name = APP_NAME }) {
    return shortcutScript({ shellFolder: START_MENU_FOLDER, target, workingDir, icon, name });
}

/**
 * What to do about the Start Menu shortcut on this start: 'create', 'update'
 * or 'none'.
 *
 * `marker` is the file the launcher writes in the library once the shortcut
 * exists (null when there is none), holding the TARGET it was written for.
 * An update arrives as a new folder, so a marker that only said "done once"
 * would leave the shortcut opening the OLD copy for good. A marker naming
 * another target means the app has moved: the shortcut is pointed at this
 * copy if it is still there, and left alone if the person deleted it (they
 * are not told again). A marker holding a timestamp (the older format) reads
 * as another target: one rewrite, same place.
 */
export function startMenuShortcutAction({ marker, target, shortcutExists }) {
    if (marker == null) return 'create';
    if (marker.trim() === target) return 'none';
    return shortcutExists ? 'update' : 'none';
}

/**
 * The command line that starts THIS copy again — what a login item has to name.
 *
 * A packaged Windows install has a windowless `.exe` to run; everything else is
 * the Node that is running now, pointed back at the launcher script.
 *
 * Either way the library is named explicitly whenever this run has one, because
 * a login item inherits nothing about how this run was started: not a `.env`
 * file that a package script handed to node, not an exported DATA_DIR, not the
 * directory a terminal happened to be in. A command line without the flag
 * resolves the data directory afresh at sign-in, falls through to the historical
 * layout under `server/`, and opens an EMPTY library beside the real one — which
 * reads as lost work rather than as a path that was never passed on, and which
 * also drops a Chromium profile into the source tree.
 */
export function launchCommand({
    platform = process.platform, packaged = false, appRoot, execPath, scriptPath,
    dataDir = null, exists = existsSync, env = process.env, name = APP_NAME,
} = {}) {
    const pin = dataDir ? ['--data-dir', dataDir] : [];
    if (platform === 'win32' && packaged && appRoot) {
        // The compiled launcher: no console, and a tray icon that owns the
        // running app. `.cmd` is the fallback the build leaves when the C#
        // compiler was unavailable, and it DOES open a console.
        const exe = win32.join(appRoot, `${name}.exe`);
        if (exists(exe)) return { target: exe, args: pin, console: false };
        const cmd = win32.join(appRoot, `${name}.cmd`);
        if (exists(cmd)) return { target: cmd, args: pin, console: true };
    }
    if (platform === 'win32' && appRoot) {
        // A checkout. `node.exe` is a console program, so a login item naming it
        // opens a console window at every sign-in — one that cannot be closed,
        // because it is the server. wscript.exe is a GUI-subsystem host and the
        // shim beside this file starts the same command with no window at all.
        const shim = win32.join(appRoot, 'desktop', 'wrappers', 'launch-hidden.vbs');
        const wscript = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
        if (exists(shim) && exists(wscript)) {
            return { target: wscript, args: [shim, execPath, scriptPath, ...pin], console: false };
        }
    }
    return { target: execPath, args: [scriptPath, ...pin], console: platform === 'win32' };
}

/**
 * What the updater starts after it has swapped a new version in: the login
 * item's command line, except where that names a batch file.
 *
 * A login item may name `Terramentor.cmd` (the fallback a build leaves when
 * the C# compiler was unavailable): Windows' shell runs a .cmd from a shortcut
 * without complaint. Node does not. Since the April 2024 security releases,
 * `spawn` refuses a .cmd or .bat without `shell: true` and throws EINVAL, and
 * this app never spawns through a shell — so an update on such a copy swapped
 * the files in and then could not start them. The batch file only runs the
 * bundled Node on the launcher script, so the updater does that itself, with
 * the same arguments.
 */
export function relaunchCommand({ target, args = [] }, { execPath, scriptPath }) {
    if (/\.(cmd|bat)$/i.test(String(target || ''))) return { target: execPath, args: [scriptPath, ...args] };
    return { target, args };
}

/* ── opening at sign-in ─────────────────────────────────────────────────────
 *
 * What a login item should DO when it runs. Two different questions get
 * confused here: whether the app starts with the computer (the login item
 * exists) and whether it puts a window on screen when it does. Someone who
 * turns on "start when I sign in" usually wants the app READY — for their
 * phone over the tailnet, or to open instantly — not a window across whatever
 * they actually signed in to do.
 *
 * So the login item carries `--autostart`, which says only "this run came from
 * sign-in", and the stored preference decides what that means.
 *
 * The rule's one hard edge: a window can only be withheld when there is
 * somewhere to withhold it TO. On a packaged Windows copy that is the tray
 * icon. Everywhere else — a checkout, macOS, Linux — starting with no window
 * would leave a running server with no way back to it short of typing the
 * address, so the preference is ignored and the window opens. A setting that
 * makes the app vanish is worse than a setting that is not honoured.
 */
export const AUTOSTART_WINDOW_MODES = ['show', 'hidden'];
export const DEFAULT_AUTOSTART_WINDOW = 'hidden';

export function shouldOpenWindow({ wantWindow, autostart = false, autostartWindow = DEFAULT_AUTOSTART_WINDOW, trayHosted = false } = {}) {
    if (!wantWindow) return false;
    if (!autostart) return true;
    if (!trayHosted) return true;
    return autostartWindow !== 'hidden';
}

/* ── starting when the computer does ────────────────────────────────────────
 *
 * Every desktop platform has exactly one place a user-level autostart entry
 * goes, and all three are a FILE this app can write and delete without asking
 * for any privilege: a shortcut in the Startup folder, a LaunchAgent plist, an
 * XDG `.desktop` entry. None of them is a registry write, a service, or a
 * scheduled task — all three of which need elevation somewhere and none of
 * which a person can find again to undo by hand.
 *
 * `plan` describes the file rather than writing it, so the gate can read what
 * would land on every platform from this one, and so the three callers (turn it
 * on, turn it off, report whether it is on) all read the same path.
 *
 * A tray icon is a SEPARATE question, and the answer differs by platform. It
 * needs a process that owns a native window, which neither half of this app is:
 * the window belongs to Chromium and the server is a headless node process. On
 * Windows the packaged copy has one anyway, because the launcher there is a
 * compiled program of our own (desktop/wrappers/Launcher.cs) that holds the
 * server as a child and shows the icon itself. On macOS, Linux, and a Windows
 * checkout there is no such program, so "start at login" means a window —
 * `shouldOpenWindow` is where that is decided, and why.
 */
/**
 * One argument of a Windows command line, quoted the way the program at the
 * other end splits it (CommandLineToArgvW, and the C runtime Node and .NET
 * use): inside quotes a backslash is an ordinary character UNLESS a run of
 * them ends at a quote, where 2n backslashes mean n and the quote is syntax,
 * and 2n+1 mean n and a literal quote. So a path ending in a backslash — a
 * drive root, `E:\` — quoted naively as `"E:\"` swallows its own closing quote
 * and the rest of the line with it. Bare when there is nothing to protect, so
 * the common case reads as it always did.
 */
export function windowsArg(arg) {
    const s = String(arg);
    if (s && !/[\s"]/.test(s)) return s;
    let out = '"';
    let slashes = 0;
    for (const c of s) {
        if (c === '\\') { slashes++; continue; }
        out += c === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${c}`;
        slashes = 0;
    }
    return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/**
 * A string value in a .desktop file, by the Desktop Entry Specification's
 * escape rules for strings: a backslash is written `\\`. (A line break would
 * be `\n`, but autostartPlan refuses those outright rather than trust every
 * reader to agree.)
 */
const desktopString = (s) => String(s).replace(/\\/g, '\\\\');

/**
 * One argument of an Exec line, by the same specification. An argument holding
 * a reserved character (a space, a quote, `$`, a backtick, a backslash and the
 * rest of the list) is put in double quotes, and inside them `"`, `` ` ``,
 * `$` and `\` each take a backslash. The value as a whole is then a string, so
 * every backslash is doubled again — a literal backslash in a quoted argument
 * is four in the file, as the spec spells out. `%` starts a field code (`%f`,
 * `%u`) anywhere in the line, so a literal one is `%%`.
 */
function desktopExecArg(arg) {
    const s = String(arg);
    const quoted = /[\s"'\\><~|&;$*?#()`]/.test(s) || s === ''
        ? `"${s.replace(/["`$\\]/g, '\\$&')}"`
        : s;
    return desktopString(quoted).replace(/%/g, '%%');
}

export function autostartPlan({ platform = process.platform, target, args = [], workingDir, icon, env = process.env, home, name = APP_NAME } = {}) {
    if (!target) return { supported: false, why: 'no launch target' };
    // Every login item this app writes says so, on every platform, because the
    // run it starts has a choice to make that no other run has: whether to put a
    // window on screen. The flag is added HERE rather than by the three callers
    // so it cannot be added to two of them and forgotten in the third.
    args = [...args, '--autostart'];
    const id = name.toLowerCase();
    const homeDir = home || env.HOME || env.USERPROFILE || '';
    // The TARGET platform's separator, not this one's: `path.join` follows the
    // machine it runs on, so a Windows box asked about the macOS plan answers
    // with backslashes and the gate that checks all three from one machine
    // cannot see a real path at all.
    const at = platform === 'win32' ? win32.join : posix.join;
    if (platform === 'win32') {
        const appData = env.APPDATA;
        if (!appData) return { supported: false, why: 'no APPDATA' };
        return {
            supported: true,
            kind: 'shortcut',
            path: at(appData, STARTUP_FOLDER, `${name}.lnk`),
            // Quoting each argument: a packaged copy can sit under
            // "C:\Program Files" and an unquoted path stops at the space.
            script: shortcutScript({
                shellFolder: STARTUP_FOLDER, target, workingDir: workingDir || dirname(target), icon, name,
                args: args.map(windowsArg).join(' '),
            }),
        };
    }
    if (platform === 'darwin') {
        if (!homeDir) return { supported: false, why: 'no home directory' };
        const program = [target, ...args]
            .map(a => `        <string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`)
            .join('\n');
        return {
            supported: true,
            kind: 'plist',
            path: at(homeDir, 'Library', 'LaunchAgents', `com.${id}.app.plist`),
            contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.${id}.app</string>
    <key>ProgramArguments</key>
    <array>
${program}
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`,
        };
    }
    if (!homeDir) return { supported: false, why: 'no home directory' };
    // A .desktop file is lines of `key=value`, so a line break inside a path
    // would end the Exec line and start a key of the path's choosing. There is
    // no escape for it that every desktop reads the same way; such a path is
    // refused instead, and "start when I sign in" says it is not available.
    if ([target, ...args, icon || ''].some(v => /[\r\n\0]/.test(String(v)))) {
        return { supported: false, why: 'a path with a line break cannot go in a login item' };
    }
    const exec = [target, ...args].map(desktopExecArg).join(' ');
    return {
        supported: true,
        kind: 'desktop-entry',
        path: at(env.XDG_CONFIG_HOME || at(homeDir, '.config'), 'autostart', `${id}.desktop`),
        contents: `[Desktop Entry]
Type=Application
Name=${name}
Comment=${DESCRIPTION}
Exec=${exec}
${icon ? `Icon=${desktopString(icon)}\n` : ''}Terminal=false
X-GNOME-Autostart-enabled=true
`,
    };
}

export { userDataDir, dirname };
