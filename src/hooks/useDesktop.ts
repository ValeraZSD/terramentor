// The page's half of the desktop heartbeat, and the facts the settings panel
// shows about this install.
//
// Mounted once, in App: asks the server whether it is a desktop process, and
// if so pings it every PING_MS and says goodbye on `pagehide`. It asks with
// `details()`, which is the public probe plus the gated half — this runs above
// the lock screen, so on a locked app only the probe comes back and the rest
// is re-asked by whatever mounts the hook after the unlock. The server
// stops itself once every window has gone quiet (server/desktop.js has the
// rule and the reasons). A non-desktop server answers `{desktop:false}` and
// this hook does nothing further — so under Docker, `npm run dev` or a phone
// over Tailscale there is no timer and nothing to switch off.

import { useEffect, useState } from 'react';
import { desktopApi, type DesktopStatus } from '../desktopApi';

/** Must stay under server/desktop.js IDLE_MS (90s) with room for a missed tick,
 *  and a long-hidden window's timers fire only about once a minute. */
const PING_MS = 10_000;

const clientId = (() => {
    try {
        const key = 'terramentor-desktop-client';
        let id = sessionStorage.getItem(key);
        if (!id) { id = Math.random().toString(36).slice(2, 12); sessionStorage.setItem(key, id); }
        return id;
    } catch {
        return Math.random().toString(36).slice(2, 12);
    }
})();

let shared: DesktopStatus | null = null;
const listeners = new Set<(s: DesktopStatus) => void>();
let started = false;

function publish(s: DesktopStatus) {
    shared = s;
    for (const l of listeners) l(s);
}

/** A probe that fails (the server still starting, a dropped request) is asked
 *  again before the page settles on "not a desktop process": that answer is for
 *  the life of the page, and a desktop server that never hears a ping stops
 *  itself a few minutes later under an open window. 2 + 4 + 6 + 8 + 10 s. */
const PROBE_TRIES = 6;
const PROBE_RETRY_MS = 2_000;

/** Start the heartbeat once per page, whatever mounts first. */
function start() {
    if (started) return;
    started = true;
    probe(1);
}

function probe(attempt: number) {
    desktopApi.details().then((s) => {
        publish(s);
        if (!s.desktop) return;
        const tick = () => { desktopApi.ping(clientId).catch(() => { /* the server is going away, or busy */ }); };
        tick();
        let timer = setInterval(tick, PING_MS);
        // `pagehide` fires on close, navigation away AND reload; the server treats
        // a goodbye followed by a ping within its grace as a reload, so saying it
        // on every hide is right. `beforeunload` is not used: it is unreliable on
        // mobile and shows nothing here anyway.
        window.addEventListener('pagehide', () => { clearInterval(timer); desktopApi.bye(clientId); });
        // Back from a sign-in page can bring this page out of the back/forward
        // cache instead of loading it, so this module does not run again and the
        // stopped heartbeat would stay stopped under an open window.
        window.addEventListener('pageshow', (e) => {
            if (!e.persisted) return;
            clearInterval(timer);
            tick();
            timer = setInterval(tick, PING_MS);
        });
        // A tab that was hidden for a long time may have had its timers throttled
        // past the idle limit; ping the moment it is visible again.
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
    }).catch(() => {
        if (attempt < PROBE_TRIES) setTimeout(() => probe(attempt + 1), PROBE_RETRY_MS * attempt);
        else publish({ desktop: false });
    });
}

/** The desktop facts, `null` until known. Re-fetch with `refresh()`. */
export function useDesktop(): { status: DesktopStatus | null; refresh: () => Promise<void> } {
    const [status, setStatus] = useState<DesktopStatus | null>(shared);
    const refresh = async () => { try { publish(await desktopApi.details()); } catch { /* keep what we had */ } };
    useEffect(() => {
        listeners.add(setStatus);
        start();
        if (shared) setStatus(shared);
        // The heartbeat starts in App, ABOVE the lock screen, so on a password-
        // protected install the first read got the public probe and a 401 for
        // the rest. Anything mounting this later — the settings panel, the
        // lost-library card — is by definition past the gate, so ask again for
        // the half that was refused. Once: `detailed` is true afterwards.
        if (shared?.desktop && shared.detailed === false) void refresh();
        return () => { listeners.delete(setStatus); };
    }, []);
    return { status, refresh };
}
