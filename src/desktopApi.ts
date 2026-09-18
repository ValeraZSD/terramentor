// The desktop lifecycle from the page's side (server/desktop.js is the other).
//
// Kept out of api.ts on purpose: these calls are the app talking about ITSELF
// as a process, not about the library, and two of them must work while the
// auth gate is up (the status probe and the heartbeat are public routes).

export interface DesktopStatus {
    desktop: boolean;
    app?: string;
    version?: string;
    pid?: number;
    port?: number;
    dataDir?: string;
    dbPath?: string;
    keepRunning?: boolean;
    /** How the launcher opens the window next time: 'window' | 'maximized' | 'fullscreen'. */
    windowMode?: DesktopWindowMode;
    /** Whether this install CAN start itself at login — false for a copy the
     *  launcher did not start, where the control is not drawn at all. */
    canStartAtLogin?: boolean;
    startAtLogin?: boolean;
    /** Whether a tray icon is holding the app (packaged Windows). It decides the
     *  lifetime — with one, closing the window leaves the app running and the
     *  icon is how you get it back or quit it — so the panel draws a different
     *  thing rather than a switch the icon has already answered. */
    trayHosted?: boolean;
    /** What a sign-in launch does: 'show' a window, or come up 'hidden' behind
     *  the tray icon. Only honoured where there IS a tray icon. */
    autostartWindow?: DesktopAutostartWindow;
    clients?: number;
    platform?: string;
}

export type DesktopWindowMode = 'window' | 'maximized' | 'fullscreen';
export type DesktopAutostartWindow = 'show' | 'hidden';

const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json() as Promise<T>;
};

export const desktopApi = {
    status: () => json<DesktopStatus>('/api/desktop/status'),
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
};
