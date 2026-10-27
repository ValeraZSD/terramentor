// The "Start when I sign in" control's state, shared by the two places that
// draw it: Settings → General → This computer, and the welcome's last step.

import { useEffect, useState } from 'react';
import { desktopApi } from '../desktopApi';
import { useDesktop } from './useDesktop';

export function useStartAtLogin() {
    const { status, refresh } = useDesktop();
    // What the control was last asked for. The Windows shortcut is written by
    // a spawned PowerShell, so the status read that follows the request can
    // still show the old answer — and a control that flicks back for half a
    // second reads as a failure. Cleared once the status agrees.
    const [asked, setAsked] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (asked !== null && status?.startAtLogin === asked) setAsked(null);
    }, [status?.startAtLogin, asked]);

    /** Ask for the login item (or its removal). False when the request failed. */
    const set = async (next: boolean): Promise<boolean> => {
        setBusy(true);
        setAsked(next);
        try { await desktopApi.startAtLogin(next); await refresh(); return true; }
        catch { setAsked(null); return false; }
        finally { setBusy(false); }
    };

    return {
        /** Only a launcher-started install knows the command line a login item
         *  needs; anywhere else the control is not drawn at all. */
        available: !!status?.desktop && !!status.canStartAtLogin,
        on: asked ?? !!status?.startAtLogin,
        busy,
        set,
        /** Behind a tray icon a sign-in start comes up in the background. */
        trayHosted: !!status?.trayHosted,
    };
}
