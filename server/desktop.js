// The desktop app's lifecycle — what makes a browser-served app behave like a
// program that was opened and can be closed.
//
// A desktop install is the ordinary server started by `desktop/launcher.js`,
// which opens an app window (a Chromium `--app` window when one is installed,
// the default browser otherwise) pointing at it. Nothing about the server is
// different; what it lacks on its own is an answer to "when am I done?". A
// native window's close button ends a program. A browser tab's close button
// ends a tab, and the process behind it lives on until the machine reboots,
// invisible, holding the port, with no way to stop it short of Task Manager.
//
// So the running page HEARTBEATS. Every open window pings this module every
// few seconds and sends a goodbye on `pagehide`; once at least one window has
// been seen and none has pinged for `IDLE_MS`, the process shuts itself down
// (cleanly: HTTP server closed, WAL checkpointed, database closed). The rule
// runs on wall-clock time, not on "the window I spawned exited", because the
// spawned Chromium process is not the window — with an already-running browser
// it hands off and exits at once — and because a phone reaching this server
// over Tailscale is a window too, and closing the desktop one should not cut
// the phone off mid-review. "Keep running in the background" turns the rule
// off for people who want the server up for other devices.
//
// The status endpoint doubles as the launcher's SINGLE-INSTANCE probe: before
// starting a server the launcher asks every candidate port whether a
// Terramentor on the same data directory is already there, and if so opens a
// window at it and exits. That is what makes a second double-click open a
// second window instead of a second server on a second port with an empty,
// bewildering library.
//
// None of this is mounted unless the launcher set TERRAMENTOR_DESKTOP=1: under
// Docker or `npm run dev` the endpoints answer `{desktop:false}` and the timer
// never starts, so nothing here can shut down a server somebody runs by hand.

import { Router } from 'express';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/* Where the launcher told us it was started from, which is what an autostart
 * entry has to name. Set by desktop/launcher.js before this process imports the
 * server; absent everywhere else, and "absent" is a complete answer — the app
 * then reports that it cannot start itself at login rather than guessing at a
 * command line and writing a login item that fails silently every morning.
 *
 * `desktop/lib.js` holds the plan for each platform. It is imported LAZILY, on
 * the first request that needs it, because the Docker image ships `server`,
 * `dist` and `public` and nothing else — a top-level import of a file that is
 * not in the image would take the container down at startup, and this module is
 * imported by index.js on every deployment. */
function launchTarget(env = process.env) {
    if (!env.TERRAMENTOR_LAUNCH_TARGET) return null;
    let args = [];
    try { args = JSON.parse(env.TERRAMENTOR_LAUNCH_ARGS || '[]'); } catch { args = []; }
    return {
        target: env.TERRAMENTOR_LAUNCH_TARGET,
        args: Array.isArray(args) ? args.filter(a => typeof a === 'string') : [],
        workingDir: env.TERRAMENTOR_LAUNCH_DIR || dirname(env.TERRAMENTOR_LAUNCH_TARGET),
        icon: env.TERRAMENTOR_LAUNCH_ICON || null,
    };
}

/** Whether the launcher started this process. Declared here rather than beside
 *  the lifecycle constants below because the autostart memo, three lines down,
 *  reads it while this module is still evaluating. */
export const isDesktop = () => process.env.TERRAMENTOR_DESKTOP === '1';

/**
 * Whether a tray icon is holding this process (desktop/wrappers/Launcher.cs,
 * packaged Windows only). It changes the lifetime rule: the icon IS the app's
 * presence, so closing the last window leaves it running rather than stopping
 * it. That is the whole point of the icon — the window goes, the app stays, a
 * phone on the tailnet keeps its server, and there is something on screen to
 * open it again or quit it.
 *
 * Without a tray icon the opposite is right: nothing would be left to click, so
 * the server stops unless the person asked for it to stay (`desktop_keep_running`).
 */
export const isTrayHosted = () => process.env.TERRAMENTOR_TRAY === '1';

const UNSUPPORTED = { supported: false, why: 'the launcher did not say how it was started' };
let autostart = UNSUPPORTED;
/** Loaded once, at import, and only under the launcher — so it has resolved
 *  long before a window exists to ask about it, and `status()` can stay
 *  synchronous (it is also the launcher's single-instance probe). */
export const autostartLoaded = isDesktop() && launchTarget()
    ? import('../desktop/lib.js')
        .then(({ autostartPlan }) => { autostart = autostartPlan(launchTarget()); return autostart; })
        .catch(() => autostart)
    : Promise.resolve(autostart);

/** Whether this install currently starts itself when the user signs in: the
 *  presence of the one file, read each time rather than remembered, because the
 *  person may have deleted it from the Startup folder by hand. */
const startsAtLogin = () => !!(autostart.supported && existsSync(autostart.path));

/** Write or remove that file. Windows needs PowerShell to make a .lnk (it is a
 *  COM object); removing one is an ordinary unlink on all three platforms. */
function setStartAtLogin(on) {
    if (!autostart.supported) return false;
    if (!on) {
        try { rmSync(autostart.path, { force: true }); } catch { return false; }
        return true;
    }
    try {
        if (autostart.contents) {
            mkdirSync(dirname(autostart.path), { recursive: true });
            writeFileSync(autostart.path, autostart.contents, 'utf8');
            // An XDG entry has to be executable-ish only in spirit; a plist and
            // a .desktop file are both read, not run.
            return true;
        }
        const file = join(tmpdir(), `terramentor-autostart-${process.pid}.ps1`);
        writeFileSync(file, autostart.script, 'utf8');
        const child = spawn('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
            { stdio: 'ignore', windowsHide: true });
        child.on('exit', () => { try { rmSync(file, { force: true }); } catch { /* temp */ } });
        child.on('error', () => { /* no PowerShell: reported by the next status read */ });
        return true;
    } catch {
        return false;
    }
}

/** How long every window may go silent before the process stops itself. The
 *  page pings on its own cadence (PING_MS in src/hooks/useDesktop.ts, 10s); a
 *  laptop lid, a busy tab or a GC pause may skip a couple, and a stop that
 *  fires during a reload would be a bug people meet daily. Generous on purpose:
 *  the cost of a late stop is a few seconds of an idle process, the cost of an
 *  early one is a lost session. */
export const IDLE_MS = 45_000;
/** After an explicit goodbye the check runs sooner — a reload sends a goodbye
 *  and a new ping within a second, a real close sends only the goodbye. */
export const BYE_GRACE_MS = 6_000;

/**
 * Decide whether an idle desktop server should stop. A pure function of the
 * clock and the ping history so the gate suite can walk it through every state:
 * never connected (a launcher that opened a window the user closed before the
 * page loaded must still stop, which is what `startedAt` is for), connected and
 * silent, connected and pinging, said goodbye, keep-running.
 */
export function shouldShutDown({ now, startedAt, lastPing, everConnected, lastBye, keepRunning }) {
    if (keepRunning) return false;
    if (!everConnected) {
        // No page ever loaded. Give the browser a real chance — a cold Chromium
        // start on a slow disk is ten seconds — and then conclude the window
        // never came.
        return now - startedAt > 4 * IDLE_MS;
    }
    if (lastBye && lastBye >= lastPing) return now - lastBye > BYE_GRACE_MS;
    return now - lastPing > IDLE_MS;
}

/**
 * The command that opens a folder in the platform's file manager. Returned,
 * not run, so it can be asserted; `openFolder` runs it.
 */
export function openFolderCommand(dir, platform = process.platform) {
    if (platform === 'win32') return { cmd: 'explorer.exe', args: [dir] };
    if (platform === 'darwin') return { cmd: 'open', args: [dir] };
    return { cmd: 'xdg-open', args: [dir] };
}

function openFolder(dir) {
    const { cmd, args } = openFolderCommand(dir);
    try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => { /* no file manager: the path is on screen anyway */ });
        child.unref();
        return true;
    } catch {
        return false;
    }
}

/**
 * Build the desktop lifecycle for one server process.
 *
 * `getSetting`/`setSetting` reach the settings table (keep-running is a
 * per-install preference and belongs with the others); `onShutdown` is what
 * actually stops the process — index.js supplies it, because closing the HTTP
 * server and the database is its business, not this module's.
 */
export function createDesktop({ dataDir, dbPath, version, port, getSetting, setSetting, onShutdown, now = Date.now }) {
    const state = {
        startedAt: now(),
        lastPing: 0,
        lastBye: 0,
        everConnected: false,
        clients: new Map(),   // clientId → last ping, for the status panel
        stopping: false,
    };
    const trayHosted = isTrayHosted();
    // A tray icon keeps the app running by construction; the stored preference
    // is what answers when there is no icon. ORed rather than overwritten, so
    // turning the icon off (an unpackaged run of the same library) hands the
    // decision straight back to the setting.
    const keepRunning = () => trayHosted || getSetting('desktop_keep_running', 'false') === 'true';
    // What a login item does when it fires: open a window, or come up quietly
    // behind the tray icon. Read by the LAUNCHER after the server is up, and
    // only honoured where there is a tray icon to come up behind — desktop/lib.js
    // `shouldOpenWindow` is the rule.
    const autostartWindow = () => {
        const v = getSetting('desktop_autostart_window', 'hidden');
        return v === 'show' || v === 'hidden' ? v : 'hidden';
    };
    // Read by the LAUNCHER, before it opens a window, which is the only moment
    // the flag can be given to Chromium — a window cannot be maximised after
    // the fact from inside the page. An unrecognised row reads as `window`.
    const windowMode = () => {
        const v = getSetting('desktop_window_mode', 'window');
        return ['window', 'maximized', 'fullscreen'].includes(v) ? v : 'window';
    };

    const status = () => ({
        desktop: true,
        app: 'terramentor',
        version,
        pid: process.pid,
        port: port(),
        dataDir,
        dbPath,
        keepRunning: keepRunning(),
        windowMode: windowMode(),
        // Two separate facts: whether the app stays up without a window, and
        // WHY. A panel that draws a switch for something the tray icon already
        // decides is offering a control that does nothing.
        trayHosted,
        autostartWindow: autostartWindow(),
        // `canStartAtLogin` is separate from `startAtLogin` because "no" and
        // "not possible here" are different answers and the panel draws them
        // differently — a control that does nothing is worse than no control.
        canStartAtLogin: autostart.supported === true,
        startAtLogin: startsAtLogin(),
        clients: state.clients.size,
        platform: process.platform,
    });

    function stop(reason) {
        if (state.stopping) return;
        state.stopping = true;
        console.log(`[desktop] Stopping: ${reason}`);
        clearInterval(timer);
        Promise.resolve().then(() => onShutdown(reason)).catch((e) => {
            console.error('[desktop] Shutdown failed, exiting anyway:', e?.message || e);
            process.exit(0);
        });
    }

    function tick() {
        const t = now();
        for (const [id, seen] of state.clients) if (t - seen > IDLE_MS) state.clients.delete(id);
        if (shouldShutDown({ now: t, ...state, keepRunning: keepRunning() })) {
            stop(state.everConnected ? 'every window has closed' : 'no window ever connected');
        }
    }
    const timer = setInterval(tick, 2_000);
    timer.unref();

    // --- routes -------------------------------------------------------------
    // Two routers, because two of these must answer while the app is locked:
    // the launcher's probe (no session, no cookie — it is not a browser) and the
    // heartbeat, which the locked screen sends too, or a lock screen left open
    // would count as "every window closed".
    const pub = Router();
    pub.get('/api/desktop/status', (req, res) => res.json(status()));
    pub.post('/api/desktop/ping', (req, res) => {
        const t = now();
        const id = typeof req.body?.clientId === 'string' ? req.body.clientId.slice(0, 64) : 'anon';
        if (req.body?.bye) {
            state.clients.delete(id);
            if (state.clients.size === 0) state.lastBye = t;
        } else {
            state.clients.set(id, t);
            state.lastPing = t;
            state.everConnected = true;
        }
        res.json({ ok: true });
    });

    const protectedRouter = Router();
    protectedRouter.post('/api/desktop/quit', (req, res) => {
        res.json({ ok: true });
        // Answer first, then stop: the client is waiting on this response and a
        // closed socket reads as a failed request.
        setTimeout(() => stop('quit requested'), 150);
    });
    protectedRouter.post('/api/desktop/keep-running', (req, res) => {
        const on = req.body?.enabled === true;
        setSetting('desktop_keep_running', on ? 'true' : 'false');
        res.json({ keepRunning: on });
    });
    protectedRouter.post('/api/desktop/start-at-login', (req, res) => {
        const on = req.body?.enabled === true;
        if (!autostart.supported) return res.status(400).json({ error: 'Not available on this install', why: autostart.why || null });
        setStartAtLogin(on);
        // The Windows shortcut is written by a spawned PowerShell, so the file
        // may not exist yet; report what was ASKED for and let the panel's next
        // status read report what is actually there. Claiming success from a
        // process that has not finished is how a toggle lies.
        res.json({ requested: on, startAtLogin: startsAtLogin() });
    });
    protectedRouter.post('/api/desktop/window-mode', (req, res) => {
        const mode = String(req.body?.mode || '');
        if (!['window', 'maximized', 'fullscreen'].includes(mode)) return res.status(400).json({ error: 'Unknown window mode' });
        setSetting('desktop_window_mode', mode);
        res.json({ windowMode: mode });
    });
    protectedRouter.post('/api/desktop/autostart-window', (req, res) => {
        const mode = String(req.body?.mode || '');
        if (!['show', 'hidden'].includes(mode)) return res.status(400).json({ error: 'Unknown autostart window mode' });
        setSetting('desktop_autostart_window', mode);
        res.json({ autostartWindow: mode });
    });
    protectedRouter.post('/api/desktop/open-data-dir', (req, res) => {
        // The one shell command this app runs on request, and it takes no input
        // from the request: the argument is the directory this process was
        // started against, nothing the caller chose.
        res.json({ ok: openFolder(dataDir), dataDir });
    });

    return { publicRouter: pub, protectedRouter, status, stop, state };
}

/** What a non-desktop server answers, so the client has one shape to read. */
export const NOT_DESKTOP = Object.freeze({ desktop: false });
