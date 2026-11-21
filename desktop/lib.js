// The launcher's decisions, as functions of their inputs.
//
// Everything in here is pure or injectable — which browser to open, where the
// data goes, whether a server on some port is ours, how the log file is kept
// bounded — so `tools/desktop-gates.mjs` can assert each decision on every
// platform from one machine. `launcher.js` is the thin script that runs them.

import { existsSync, statSync, renameSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, linkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname, posix, win32 } from 'node:path';
import { delimiter } from 'node:path';
import { libraryId, resolveDataPaths, userDataDir } from '../server/paths.js';
import { loadInstanceKey, newNonce, provesInstance } from '../server/instanceKey.js';
import { macBundleOf } from '../server/appPlacement.js';

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
 *                             Not on macOS: there the app folder is inside the
 *                             app bundle, and a library inside a bundle goes
 *                             wherever the bundle goes, read-only when macOS
 *                             translocates it, and is replaced with it.
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
    const portable = macBundleOf(appRoot) ? null : join(appRoot, 'data');
    if (portable && exists(portable)) return { dir: portable, why: 'portable' };
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
        // The application bundles, not the programs inside them: on macOS the
        // window is started through LaunchServices (`browserCommand`), which
        // takes an application. In the shared Applications folder or the
        // person's own, where a browser installed without an administrator goes.
        const roots = ['/Applications', ...(env.HOME ? [posix.join(env.HOME, 'Applications')] : [])];
        const out = [];
        for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Vivaldi']) {
            for (const root of roots) out.push(posix.join(root, `${app}.app`));
        }
        return out;
    }
    // Linux and the BSDs: names on PATH first. Brave's own packages install
    // `brave-browser`; Arch's AUR package installs `brave`.
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser', 'brave', 'vivaldi'];
    // Then the same browsers installed from Flathub. A Flatpak browser has no
    // program under any of the names above, only its app id in Flatpak's
    // exports folder: the per-user one (often not on PATH) and the system one.
    // A relative XDG_DATA_HOME is invalid by the XDG spec and Flatpak ignores it.
    const xdg = String(env.XDG_DATA_HOME || '');
    const dataHome = xdg.startsWith('/') ? xdg : (env.HOME ? posix.join(env.HOME, '.local', 'share') : '');
    const exportDirs = [...(dataHome ? [posix.join(dataHome, 'flatpak', 'exports', 'bin')] : []), '/var/lib/flatpak/exports/bin'];
    const flatpaks = [];
    for (const id of FLATPAK_BROWSERS) for (const dir of exportDirs) flatpaks.push(posix.join(dir, id));
    return [...names, ...flatpaks];
}

/** Flathub app ids of Chromium-family browsers, in the order they are preferred. */
export const FLATPAK_BROWSERS = [
    'com.google.Chrome', 'org.chromium.Chromium', 'io.github.ungoogled_software.ungoogled_chromium',
    'com.microsoft.Edge', 'com.brave.Browser', 'com.vivaldi.Vivaldi',
];

/** The Flatpak app id when `browser` is a Flatpak export, otherwise null. */
export function flatpakAppId(browser) {
    const m = /\/flatpak\/exports\/bin\/([^/]+)$/.exec(String(browser).replace(/\\/g, '/'));
    return m && FLATPAK_BROWSERS.includes(m[1]) ? m[1] : null;
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
        // A bundle counts only with its program inside: a half-removed browser
        // leaves the folder, and `open -a` on it fails where the next would not.
        const found = platform === 'darwin'
            ? (exists(posix.join(candidate, 'Contents', 'MacOS', posix.basename(candidate, '.app'))) ? candidate : null)
            : platform === 'win32'
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

/**
 * The command that opens the app window in `browser`, one of the candidates
 * above, and whether its exit code says if the window came (`byExit`).
 *
 * On macOS through LaunchServices: `open -n -a <browser>.app --args …`. A
 * browser started as a child of this process is not an application macOS
 * launched: macOS holds the process that started it responsible for it, so
 * whatever the browser does to its own bundle (updating itself) is asked of
 * the person as this process modifying apps. `-n` starts a new instance even
 * while the person's own browser is running; without it macOS brings that one
 * forward and drops every argument, which is an ordinary browser window in
 * place of the app's. With `-n` and the app's own profile, a second window
 * goes to the instance already holding that profile, as on other systems.
 * `open` exits non-zero when it could not launch the application, so the
 * launcher waits for its exit before saying the window opened.
 *
 * A Flatpak browser through `flatpak run`, granted the profile folder for this
 * run only: its sandbox sees almost nothing of the home folder (Flathub's Brave
 * gets Downloads, the desktop and two folders under ~/.local/share), so the
 * profile inside the app's data folder would not exist for it. The folder must
 * exist before the run; the launcher makes it.
 */
export function browserCommand(browser, url, profileDir, windowMode = DEFAULT_WINDOW_MODE, platform = process.platform) {
    const args = browserArgs(url, profileDir, windowMode);
    if (platform === 'darwin') return { cmd: 'open', args: ['-n', '-a', browser, '--args', ...args], byExit: true };
    const flatpak = platform === 'win32' ? null : flatpakAppId(browser);
    // Flatpak reads `--filesystem=PATH[:MODE]`, so a `:` or `\` in the library
    // path is escaped the way Flatpak writes them itself (unparse_filesystem_flags).
    const granted = String(profileDir).replace(/[\\:]/g, '\\$&');
    if (flatpak) return { cmd: 'flatpak', args: ['run', `--filesystem=${granted}`, flatpak, ...args], byExit: false };
    return { cmd: browser, args, byExit: false };
}

/** The command that opens a URL in whatever the default browser is. */
export function defaultBrowserCommand(url, platform = process.platform) {
    if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/c', 'start', '', url] };
    // `open` exits once LaunchServices has the browser running, non-zero when it
    // could not: its exit is the answer, not its start.
    if (platform === 'darwin') return { cmd: 'open', args: [url], byExit: true };
    return { cmd: 'xdg-open', args: [url] };
}

/**
 * Say how a detached start went, once the OS has answered. `spawn` returns
 * before it has tried: a program that is not there arrives afterwards as an
 * 'error' event, so a success logged on the line after the call is printed
 * even when nothing opened. Exactly one of the two callbacks runs; an error
 * after the start is ignored rather than left unhandled.
 *
 * `byExit`: the child is a go-between whose exit code is the answer (macOS
 * `open`, which exits 1 when the application cannot be launched), so success
 * is an exit with 0 rather than the start of the go-between. A go-between
 * ended by SIGTERM gave no answer: it was stopped, which is what quitting the
 * app does to a window still starting (pkill, on a command line that holds the
 * app's profile), so that goes to `stopped` when given, never to `failed`,
 * whose caller would open another browser on a server that is going away. Any
 * other end, a SIGKILL included, is a failure.
 */
export function whenStarted(child, { started, failed, stopped = failed }, { byExit = false } = {}) {
    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    if (byExit) {
        child.once('exit', (code, signal) => (code === 0
            ? settle(started)
            : code === null && signal === 'SIGTERM'
                ? settle(stopped, Object.assign(new Error(`it was stopped (${signal})`), { code, signal }))
                : settle(failed, Object.assign(new Error(`it exited with ${code ?? signal}`), { code }))));
    } else {
        child.once('spawn', () => settle(started));
    }
    child.on('error', (e) => settle(failed, e));
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
 * at the path the pointer names. So a missing pointer target gets no key,
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

// --- one start at a time ------------------------------------------------------
// `findRunningInstance` only finds a server that is already listening. A first
// launch of the day can take half a minute before it listens (a cold disk, a
// paging machine), and a second launch in that time (a tray "Open" click, a
// second double-click) found nothing and started a server of its own; three
// servers on one library were seen this way. So the launch that starts the
// server says so in a lock file in the data folder, and a later launch that
// finds the lock waits for that start instead of making another.
//
// The lock is `{ pid, at, state, token }`. `starting` while the server comes
// up, `up` once the launch has decided about its window (`window` says whether
// it opened one). Only a `starting` lock whose process is alive and younger
// than START_LOCK_MAX_MS holds anyone back: a dead holder, a hung one, or an
// `up` one (a running server, which `findRunningInstance` answers for) is
// taken over. The lock is a courtesy, never a requirement: a folder it cannot
// be written to means the launch goes ahead unguarded, as before.

export const START_LOCK = 'start.lock';
export const START_LOCK_MAX_MS = 180_000;
/** An unreadable lock younger than this is one being written right now. */
const START_LOCK_WRITE_MS = 10_000;

/** Whether a process with this id exists (EPERM: it does, under another account). */
export function pidAlive(pid, kill = process.kill) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const lockFs = { writeFileSync, readFileSync, unlinkSync, renameSync, statSync, linkSync };

function readRaw(file, fs) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function parseLock(raw) {
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
}

/** The lock's contents, or null when there is none or it cannot be parsed. */
export function readStartLock(file, fs = lockFs) {
    const raw = readRaw(file, fs);
    return raw === null ? null : parseLock(raw);
}

/** Whether `lock` is a start still in progress, which a later launch waits for.
 *  A start stamped in the future (the clock went back) holds nobody. */
export function startLockLive(lock, { now = Date.now(), alive = pidAlive } = {}) {
    if (!lock || lock.state !== 'starting') return false;
    const age = now - Date.parse(lock.at);
    return Number.isFinite(age) && age > -START_LOCK_WRITE_MS && age < START_LOCK_MAX_MS && alive(lock.pid);
}

/**
 * Try to become the launch that starts the server.
 * `{ claimed: true, token }`: go ahead, and pass the token to the two calls
 * below. `{ claimed: false, lock }`: another start is in progress. `{ claimed:
 * false, busy: true }`: a lock is being written this instant; ask again
 * shortly. `{ claimed: false }` alone: no lock can be kept here (no folder, no
 * permission), so the caller starts unguarded. Never creates the folder.
 */
export function claimStartLock(file, { pid = process.pid, now = Date.now, alive = pidAlive, fs = lockFs } = {}) {
    const token = randomUUID();
    const body = JSON.stringify({ pid, at: new Date(now()).toISOString(), state: 'starting', token });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(file, body, { flag: 'wx' });
        } catch (e) {
            if (e.code !== 'EEXIST') return { claimed: false };
            const raw = readRaw(file, fs);
            if (raw === null) continue; // gone between the two calls
            const lock = parseLock(raw);
            if (!lock) {
                // Created by `wx` and not yet written, or garbage. Only a young
                // one can be the former.
                let age = Infinity;
                try { age = now() - fs.statSync(file).mtimeMs; } catch { /* gone: claim again */ }
                if (age < START_LOCK_WRITE_MS) return { claimed: false, busy: true };
            } else if (startLockLive(lock, { now: now(), alive })) {
                return { claimed: false, lock };
            }
            // Stale. Moved aside under a name of our own rather than deleted,
            // then compared with what was judged stale: when two launches take
            // over one stale lock, the slower one would otherwise delete the
            // fresh lock the faster one had just written, and both would start.
            const aside = `${file}.${token}.stale`;
            try { fs.renameSync(file, aside); } catch (e2) {
                if (e2.code === 'ENOENT') continue;
                return { claimed: false };
            }
            if (readRaw(aside, fs) !== raw) {
                // Someone's fresh lock: put it back, unless a newer one stands.
                try { fs.linkSync(aside, file); } catch (e3) {
                    if (e3.code !== 'EEXIST') { try { fs.renameSync(aside, file); } catch { /* lost; that start goes on */ } }
                }
                try { fs.unlinkSync(aside); } catch { /* already moved back */ }
                return { claimed: false, busy: true };
            }
            try { fs.unlinkSync(aside); } catch { /* best effort */ }
            continue;
        }
        const mine = readStartLock(file, fs);
        if (mine?.token === token) return { claimed: true, token };
        return mine ? { claimed: false, lock: mine } : { claimed: false, busy: true };
    }
    return { claimed: false, busy: true };
}

/** Rewrite our lock as `up` once the window is decided. Someone else's lock is left alone. */
export function markStartLockUp(file, token, { window = false, fs = lockFs } = {}) {
    const lock = readStartLock(file, fs);
    if (!token || lock?.token !== token) return false;
    const next = JSON.stringify({ ...lock, state: 'up', window: window === true });
    // Through a rename, so a launch polling the lock never reads half of it.
    const tmp = `${file}.${token}.tmp`;
    try {
        fs.writeFileSync(tmp, next);
        fs.renameSync(tmp, file);
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* never written */ }
        try { fs.writeFileSync(file, next); } catch { return false; }
    }
    return true;
}

/** Remove our lock (on exit). Someone else's is left alone. */
export function releaseStartLock(file, token, fs = lockFs) {
    if (!token || readStartLock(file, fs)?.token !== token) return false;
    try { fs.unlinkSync(file); return true; } catch { return false; }
}

/**
 * The launcher's first decision: a server is running (`{ running, openedByHolder }`),
 * or this launch starts one (`{ token }`, or `{}` when no lock can be kept), or
 * another start holds the library and never settled (`{ stuck: true }`): the
 * launch then stops rather than start a second server beside it.
 * `find` is `findRunningInstance` bound to this library. A launch that waited
 * for another start reports whether THAT start opened a window, so a second
 * click during a slow start makes one window, not two; a launch that did not
 * wait never reads the old lock's `window`, which describes a start long gone.
 */
export async function settleStart({
    lockFile, find,
    claim = (f) => claimStartLock(f),
    read = (f) => readStartLock(f),
    live = (lock) => startLockLive(lock),
    serving = (lock) => lock?.state === 'up' && pidAlive(lock.pid),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onWait = () => {},
    pollMs = 500,
    maxRounds = 5,
    // An `up` lock whose process lives is a server that missed one probe (busy
    // with its start, or paged out): asked again this many times before a
    // second server is started beside it on the same library.
    upRetries = 10,
    // The holder marks its lock `up` once its window is decided, a second or
    // two after it listens. Past this many polls the server itself is asked as
    // well, so a holder that stalls after listening does not hold launches off
    // for the whole START_LOCK_MAX_MS.
    probeAfterPolls = 40,
    // A lock being written this instant: asked again for at most this many
    // polls. A young empty lock turns stale after START_LOCK_WRITE_MS, so this
    // only runs out when new lock files keep appearing.
    busyPolls = Math.ceil((2 * START_LOCK_WRITE_MS) / pollMs),
    // When the probe finds a holder's server before its lock says `up`, the
    // holder's window decision is still coming: waited for this many polls.
    decisionPolls = 20,
}) {
    let waitedFor = null;
    let retriedUp = false;
    let busy = 0;
    for (let waits = 0; ;) {
        let running = await find();
        if (!running && !retriedUp && serving(read(lockFile))) {
            retriedUp = true;
            for (let i = 0; i < upRetries && !running; i++) {
                await sleep(pollMs);
                running = await find();
            }
        }
        if (running) return { running, openedByHolder: waitedFor?.state === 'up' && waitedFor.window === true };
        const c = claim(lockFile);
        if (c.claimed) return { token: c.token };
        // Only a folder that cannot hold a lock starts unguarded. A lock that is
        // busy or held does not: that start may be about to serve this library.
        if (!c.lock && !c.busy) return {};
        if (c.busy) {
            if (++busy > busyPolls) return { stuck: true };
            await sleep(pollMs);
            continue;
        }
        if (waits++ >= maxRounds) return { stuck: true };
        onWait(c.lock);
        let lock = c.lock;
        let polls = 0;
        while (live(lock)) {
            await sleep(pollMs);
            if (++polls >= probeAfterPolls && polls % 4 === 0) {
                const found = await find();
                if (found) {
                    // Its server listens; its window decision may still be on
                    // the way. Wait for it a little longer; a holder that never
                    // makes it leaves the window to this launch.
                    let after = read(lockFile);
                    for (let i = 0; i < decisionPolls && after?.token === lock.token && after.state === 'starting'; i++) {
                        await sleep(pollMs);
                        after = read(lockFile);
                    }
                    const decided = after?.token === lock.token && after.state === 'up';
                    return { running: found, openedByHolder: decided && after.window === true };
                }
            }
            lock = read(lockFile);
        }
        waitedFor = lock;
    }
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

/**
 * The log file the launcher opens for the library `chooseDataDir` picked, or
 * null when it must not make one. A pointer at a folder that is gone is the
 * case: `prepareLogFile` makes `<folder>/logs` with `mkdir -p`, which makes the
 * library folder itself, and the launcher prepares its log before it stops on
 * the missing library. Launch one would stop, launch two would find a folder,
 * call it present and open a NEW EMPTY library there, the same "reads as lost
 * work" case `launcherInstanceKey` keeps out. The stop's own message still
 * reaches the console, which is all a missing library needs.
 */
export function launcherLogFile(chosen, appRoot, deps) {
    if (chosen?.missing) return null;
    return prepareLogFile(chosen?.dir || join(appRoot, 'server'), deps);
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
export function shortcutScript({ shellFolder, target, workingDir, icon, args = '', name = APP_NAME, report = false }) {
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
        // `report`: print what this shortcut object now holds (Windows may have
        // changed characters on the way in), base64 so no console code page can
        // touch it. From this object, never by reading the file back: another
        // library may write the same file in between (savedShortcutRecord).
        report ? '$saved = [ordered]@{ arguments = [string]$s.Arguments; workingDir = [string]$s.WorkingDirectory } | ConvertTo-Json -Compress' : null,
        report ? '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($saved)))' : null,
    ].filter(Boolean).join('\n');
}

/** The record a reporting shortcutScript printed, or null. */
export function savedShortcutRecord(stdout) {
    try {
        const fields = JSON.parse(Buffer.from(String(stdout).trim(), 'base64').toString('utf8'));
        return typeof fields?.arguments === 'string' && typeof fields?.workingDir === 'string' ? shortcutRecord(fields) : null;
    } catch {
        return null;
    }
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
 * The environment that tells the server what a login item may name: `launch`
 * (launchCommand above), except from a macOS copy macOS runs translocated
 * (server/appPlacement.js). That path is gone once the app quits, so a login
 * item naming it would fail at the next sign-in; with nothing set, the server
 * says starting at sign-in is not available here.
 */
export function launchTargetEnv(launch, placement) {
    if (placement?.problem === 'translocated') return {};
    return { TERRAMENTOR_LAUNCH_TARGET: launch.target, TERRAMENTOR_LAUNCH_ARGS: JSON.stringify(launch.args) };
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
        // Quoting each argument: a packaged copy can sit under
        // "C:\Program Files" and an unquoted path stops at the space.
        const line = args.map(windowsArg).join(' ');
        // win32.dirname, not this machine's: on Linux `dirname('C:\\A\\x.exe')`
        // is '.', and every copy's plan would name the same folder.
        const dir = workingDir || win32.dirname(target);
        return {
            supported: true,
            kind: 'shortcut',
            path: at(appData, STARTUP_FOLDER, `${name}.lnk`),
            script: shortcutScript({ shellFolder: STARTUP_FOLDER, target, workingDir: dir, icon, name, args: line, report: true }),
            record: shortcutRecord({ arguments: line, workingDir: dir }),
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

// ---------------------------------------------------------------------------
// Reading a login item back. There is one login item per user and any number
// of libraries, so before a server rewrites the item it has to know whose it
// is — from what the item itself says, never from a substring or a file time.

/** What a Windows shortcut is compared by: the two fields this app sets that
 *  change when it moves (the working folder is the app's own) or when the
 *  library does (the arguments name it). Key order is fixed, so equal fields
 *  are an equal string. */
export const shortcutRecord = ({ arguments: args = '', workingDir = '' }) =>
    JSON.stringify({ arguments: args, workingDir });

/**
 * The text fields of a .lnk file (MS-SHLLINK): the header, then the item-id
 * list and the link info, both skipped by their sizes, then up to five
 * counted strings in a fixed order, each present when its flag is set. UTF-16
 * when the IsUnicode flag is; otherwise the bytes are read as Latin-1, which
 * is wrong for other code pages but still equal to itself. Null for anything
 * that is not a well-formed shortcut.
 */
export function readShortcut(buf) {
    try {
        if (!buf || buf.length < 0x4C || buf.readUInt32LE(0) !== 0x4C) return null;
        const flags = buf.readUInt32LE(20);
        let at = 0x4C;
        if (flags & 0x01) at += 2 + buf.readUInt16LE(at);
        if (flags & 0x02) at += buf.readUInt32LE(at);
        const unicode = (flags & 0x80) !== 0;
        const out = {};
        for (const [bit, key] of [[0x04, 'name'], [0x08, 'relativePath'], [0x10, 'workingDir'], [0x20, 'arguments'], [0x40, 'icon']]) {
            if (!(flags & bit)) continue;
            const n = buf.readUInt16LE(at);
            const bytes = unicode ? n * 2 : n;
            if (at + 2 + bytes > buf.length) return null;
            out[key] = buf.toString(unicode ? 'utf16le' : 'latin1', at + 2, at + 2 + bytes);
            at += 2 + bytes;
        }
        return out;
    } catch {
        return null;
    }
}

/** A Windows command line split the way the C runtime splits it: whitespace
 *  between arguments, double quotes group, and backslashes count only before
 *  a quote (2n then a quote: n backslashes and a quote that groups; 2n+1: n
 *  backslashes and a literal quote). The inverse of windowsArg. */
export function windowsArgs(line) {
    const s = String(line), out = [];
    let i = 0;
    for (;;) {
        while (i < s.length && /\s/.test(s[i])) i++;
        if (i >= s.length) return out;
        let arg = '', quoted = false;
        while (i < s.length && (quoted || !/\s/.test(s[i]))) {
            if (s[i] === '\\') {
                let n = 0;
                while (s[i] === '\\') { n++; i++; }
                if (s[i] === '"') {
                    arg += '\\'.repeat(n >> 1);
                    if (n & 1) { arg += '"'; i++; }
                } else arg += '\\'.repeat(n);
            } else if (s[i] === '"') {
                if (quoted && s[i + 1] === '"') { arg += '"'; i += 2; } else { quoted = !quoted; i++; }
            } else arg += s[i++];
        }
        out.push(arg);
    }
}

const XML_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const xmlText = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (m, e) => (
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e.toLowerCase()]));

/** The Exec line of a .desktop file split back into its arguments: field codes
 *  (`%%` is a literal `%`), then the string escapes, then the quoting rules —
 *  desktopExecArg's three layers undone in reverse. */
function desktopExecArgs(exec) {
    const s = exec.replace(/%%/g, '%')
        .replace(/\\([\\snrt])/g, (m, c) => ({ s: ' ', n: '\n', r: '\r', t: '\t', '\\': '\\' }[c]));
    const out = [];
    let i = 0;
    for (;;) {
        while (i < s.length && /\s/.test(s[i])) i++;
        if (i >= s.length) return out;
        let arg = '';
        if (s[i] === '"') {
            for (i++; i < s.length && s[i] !== '"'; i++) {
                if (s[i] === '\\' && i + 1 < s.length) i++;
                arg += s[i];
            }
            i++;
        } else {
            while (i < s.length && !/\s/.test(s[i])) arg += s[i++];
        }
        out.push(arg);
    }
}

/**
 * The command a login item runs, as a list: the program then its arguments
 * for a plist or a .desktop entry, the arguments alone for a shortcut (its
 * target is a separate field). Null when the text is not one this app could
 * have written.
 */
export function loginItemArgs(kind, text) {
    if (typeof text !== 'string') return null;
    if (kind === 'plist') {
        const array = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
        return array ? [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlText(m[1])) : null;
    }
    if (kind === 'desktop-entry') {
        const exec = text.match(/^Exec=(.*)$/m);
        return exec ? desktopExecArgs(exec[1]) : null;
    }
    if (kind === 'shortcut') {
        try { return windowsArgs(JSON.parse(text).arguments); } catch { return null; }
    }
    return null;
}

/** The library a command opens: the value after its first `--data-dir`, as the
 *  launcher reads it, or null when it names none (the default library). */
export function dataDirOf(args) {
    const i = args.indexOf('--data-dir');
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** Two library folders are one when they resolve to the same path — compared
 *  whole, never by prefix — ignoring case on Windows, whose file system does. */
export function sameLibrary(a, b, platform = process.platform) {
    if (a == null || b == null) return a == null && b == null;
    const p = platform === 'win32' ? win32 : posix;
    const norm = (d) => {
        const r = p.resolve(d);
        const t = r.length > p.parse(r).root.length ? r.replace(/[\\/]+$/, '') : r;
        return platform === 'win32' ? t.toLowerCase() : t;
    };
    return norm(a) === norm(b);
}

/** The app folder a login item starts: the folder above `desktop/launcher.js`
 *  when the command runs that script (a checkout, or the bundled Node of a
 *  macOS or Linux copy), else a shortcut's working folder, which is the app's
 *  own folder in every shortcut this app writes. Null when the item says
 *  neither. */
export function loginItemRoot(kind, current, platform = process.platform) {
    const args = loginItemArgs(kind, current);
    if (!args) return null;
    const p = platform === 'win32' ? win32 : posix;
    const script = args.find((a) => /[\\/]desktop[\\/]launcher\.js$/i.test(a));
    if (script) return p.dirname(p.dirname(script));
    if (kind !== 'shortcut') return null;
    try { return JSON.parse(current).workingDir || null; } catch { return null; }
}

/**
 * The library a start with no `--data-dir` opens from the app folder `root`:
 * chooseDataDir's answer for THAT copy, so a copy with a `data` folder of its
 * own opens that one, and a checkout the historical layout under its
 * `server/`. A folder that is gone resolves as an installed copy with no data
 * folder, the only kind an update replaces; its item starts nothing, so
 * adopting it takes no library's item away.
 */
export function unpinnedLibraryOf(root, { platform = process.platform, env = process.env, home, exists = existsSync, readFile = readFileSync } = {}) {
    if (!root) return null;
    const packaged = !exists(root) || exists(join(root, 'build.json'));
    return chooseDataDir({ appRoot: root, packaged, platform, env, home, exists, readFile }).dir ?? join(root, 'server');
}

/**
 * Whether a server rewrites the login item at start. A login item names the
 * copy of the app that wrote it, and an update is a new folder with the old
 * one deleted — left alone, nothing starts at sign-in after an update while
 * Settings says it will. But the item is the user's one item, so a server
 * rewrites only the item its own library owns:
 *
 * - `current` is the item as it is now, `wanted` what this copy would write,
 *   `marker` what this library last wrote (all compared as records: the file
 *   for a plist or .desktop entry, shortcutRecord for a .lnk).
 * - With a marker, the item is this library's only while it is still exactly
 *   what the library wrote. Another library writing the item since, or a
 *   person editing it, makes it someone else's, and it is left alone.
 *   A shortcut's marker keeps two records, because Windows does not always
 *   store what it is given (WScript.Shell sends some fields through the ANSI
 *   code page, so `é` on a Cyrillic system comes back as `e`): `holds`, read
 *   back from the file, says whose it is; `wrote`, what this copy asked for,
 *   says whether this copy would write anything different.
 * - With no marker (an item from before markers, or a marker from before
 *   shortcut records, which held the script), the item is this library's when
 *   its own `--data-dir` is this library — the whole path, not a prefix — or
 *   when neither names one. An item that names none (written before the flag
 *   was pinned) opens whatever its OWN copy resolves with no flag:
 *   `unpinnedOf(loginItemRoot(...))`, unpinnedLibraryOf in production. It is
 *   this library's when that is. An item whose copy cannot be told is left.
 * - A removed item is never put back, and an item that cannot be read is
 *   nobody's to judge.
 */
export function loginItemRefresh({ kind, exists, current, wanted, marker = null, dataDir = null, unpinnedOf = null, platform = process.platform }) {
    if (!exists || current == null || wanted == null || current === wanted) return 'none';
    if (kind === 'shortcut' && marker != null) {
        // Markers written before shortcut records hold the PowerShell script:
        // anything that is not both records counts as no marker.
        let m = null;
        try { m = JSON.parse(marker); } catch { /* the script */ }
        if (typeof m?.wrote === 'string' && typeof m?.holds === 'string') {
            return current === m.holds && m.wrote !== wanted ? 'rewrite' : 'none';
        }
        marker = null;
    }
    if (marker != null) return current === marker ? 'rewrite' : 'none';
    const args = loginItemArgs(kind, current);
    if (!args) return 'none';
    const named = dataDirOf(args);
    if (named == null && dataDir == null) return 'rewrite';
    const root = named == null ? loginItemRoot(kind, current, platform) : null;
    const opens = named ?? (root != null && unpinnedOf ? unpinnedOf(root) : null);
    return opens != null && sameLibrary(opens, dataDir, platform) ? 'rewrite' : 'none';
}

/** The marker a shortcut write leaves: what was asked for, and what the file
 *  Windows wrote turned out to hold. */
export const shortcutMarker = (wrote, holds) => JSON.stringify({ wrote, holds });

export { userDataDir, dirname };
