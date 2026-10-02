// The desktop lifecycle from the page's side (server/desktop.js is the other).
//
// Kept out of api.ts on purpose: these calls are the app talking about ITSELF
// as a process, not about the library, and two of them must work while the
// auth gate is up (the status probe and the heartbeat are public routes).
//
// Which is why there are TWO reads. `/api/desktop/status` is public and says
// almost nothing — it exists for the launcher's single-instance probe and for
// the quit screen, both of which run without a session. Everything that names
// this machine is `/api/desktop/info`, behind the gate. `details()` is the one
// the app uses: the public answer, with the full one merged over it when the
// app is unlocked.

export interface DesktopStatus {
    desktop: boolean;
    // --- the public probe -----------------------------------------------
    app?: string;
    /** A hash of the data directory, not the directory: the probe is public
     *  and must not name the account. `isOurInstance` in desktop/lib.js is the
     *  only thing that compares it. */
    libraryId?: string;
    /** How the launcher opens the window next time: 'window' | 'maximized' | 'fullscreen'. */
    windowMode?: DesktopWindowMode;
    /** What a sign-in launch does: 'show' a window, or come up 'hidden' behind
     *  the tray icon. Only honoured where there IS a tray icon. */
    autostartWindow?: DesktopAutostartWindow;
    /** Whether a tray icon is holding the app (packaged Windows). It decides the
     *  lifetime — with one, closing the window leaves the app running and the
     *  icon is how you get it back or quit it — so the panel draws a different
     *  thing rather than a switch the icon has already answered. */
    trayHosted?: boolean;
    // --- behind the auth gate (`/api/desktop/info`) ----------------------
    version?: string;
    pid?: number;
    port?: number;
    dataDir?: string;
    dbPath?: string;
    keepRunning?: boolean;
    /** Whether this install CAN start itself at login — false for a copy the
     *  launcher did not start, where the control is not drawn at all. */
    canStartAtLogin?: boolean;
    startAtLogin?: boolean;
    clients?: number;
    platform?: string;
    /** Set only when this launch fell back to the default library folder with
     *  no pointer to honour AND the library here is empty — the shape of a
     *  pointer file lost since the last launch. Carries where the library was
     *  last served from and the file to write to get back to it. */
    libraryFallback?: LibraryFallback | null;
    /** Whether the gated half arrived. False on a locked app, which answers the
     *  probe and refuses the rest — so a panel that needs `dataDir` knows the
     *  difference between "not a desktop install" and "not asked yet". */
    detailed?: boolean;
}

export interface LibraryFallback {
    /** Where the library was last resolved from, per the launcher's own note. */
    lastDir: string;
    /** The pointer file a restore would write. */
    pointerPath: string;
    /** Re-checked at answer time: an unplugged drive can return between launch and now. */
    lastDirExists?: boolean;
}

export type DesktopWindowMode = 'window' | 'maximized' | 'fullscreen';
export type DesktopAutostartWindow = 'show' | 'hidden';

const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json() as Promise<T>;
};

export const desktopApi = {
    /** The public probe. Enough to know this is a desktop process and to start
     *  the heartbeat; it names nothing about the machine. */
    status: () => json<DesktopStatus>('/api/desktop/status'),
    /** Everything about this install. Behind the auth gate, and absent
     *  altogether on a server the desktop launcher did not start. */
    info: () => json<DesktopStatus>('/api/desktop/info'),
    /** Both, as one answer. The gated half is best-effort: a locked app answers
     *  the probe and refuses the rest, and that is a normal state, not a
     *  failure — `detailed` says which one came back. */
    details: async (): Promise<DesktopStatus> => {
        const probe = await json<DesktopStatus>('/api/desktop/status');
        if (!probe.desktop) return probe;
        try { return { ...probe, ...await json<DesktopStatus>('/api/desktop/info'), detailed: true }; }
        catch { return { ...probe, detailed: false }; }
    },
    ping: (clientId: string) =>
        json<{ ok: boolean }>('/api/desktop/ping', { method: 'POST', body: JSON.stringify({ clientId }) }),
    /** The goodbye. `sendBeacon` because a page being torn down cannot await a
     *  fetch; the body is JSON with the right content type so Express parses it. */
    bye: (clientId: string) => {
        try {
            const blob = new Blob([JSON.stringify({ clientId, bye: true })], { type: 'application/json' });
            if (!navigator.sendBeacon?.('/api/desktop/ping', blob)) {
                void fetch('/api/desktop/ping', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, bye: true }) });
            }
        } catch { /* leaving anyway */ }
    },
    quit: () => json<{ ok: boolean }>('/api/desktop/quit', { method: 'POST', body: '{}' }),
    keepRunning: (enabled: boolean) =>
        json<{ keepRunning: boolean }>('/api/desktop/keep-running', { method: 'POST', body: JSON.stringify({ enabled }) }),
    /** Ask for a login item. The answer reports what was REQUESTED and what is
     *  on disk right now — on Windows the shortcut is written by a spawned
     *  PowerShell, so the file may land a moment later. */
    startAtLogin: (enabled: boolean) =>
        json<{ requested: boolean; startAtLogin: boolean }>('/api/desktop/start-at-login', { method: 'POST', body: JSON.stringify({ enabled }) }),
    windowMode: (mode: DesktopWindowMode) =>
        json<{ windowMode: DesktopWindowMode }>('/api/desktop/window-mode', { method: 'POST', body: JSON.stringify({ mode }) }),
    autostartWindow: (mode: DesktopAutostartWindow) =>
        json<{ autostartWindow: DesktopAutostartWindow }>('/api/desktop/autostart-window', { method: 'POST', body: JSON.stringify({ mode }) }),
    openDataDir: () => json<{ ok: boolean; dataDir: string }>('/api/desktop/open-data-dir', { method: 'POST', body: '{}' }),
    /** Write the pointer back to the library the launcher recorded. Takes no
     *  input from the request — the path was fixed at launch. Takes effect on
     *  the next start, so the caller follows it with a quit. */
    restoreLibrary: () =>
        json<{ ok: boolean; lastDir: string; pointerPath: string }>('/api/desktop/restore-library', { method: 'POST', body: '{}' }),
};
