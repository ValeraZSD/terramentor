import { useEffect } from 'react';
import { useStore } from '../store';

/** How often an open, visible page re-reads the stored update answer. */
const REFRESH_MS = 2 * 60 * 1000;
/** The server's startup check asks 15 s after it starts and may wait 8 s for
 *  GitHub; a page opened with the server (the desktop app) reads again after it. */
const AFTER_START_MS = 30 * 1000;

/**
 * Keep the page's update status in step with what the server's automatic check
 * found. The page read it once at load, so an update found a few seconds later
 * (the startup check) or hours later (the scheduled one) stayed invisible until
 * Settings was opened and Check now pressed.
 *
 * These are reads of the server's stored answer (`GET /api/updates`), never a
 * request to GitHub: the server alone decides when to ask, so the number of
 * outbound requests does not depend on how many pages are open. Only while
 * the automatic check is on (off, nothing changes the answer but a press, which
 * returns it), and only while the page is visible.
 */
export function useUpdateStatusRefresh(active: boolean) {
    const enabled = useStore(s => !!s.updateStatus?.enabled);
    useEffect(() => {
        if (!active || !enabled) return;
        const refresh = () => {
            if (document.visibilityState === 'visible') void useStore.getState().refreshUpdates();
        };
        const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
        const first = window.setTimeout(refresh, AFTER_START_MS);
        const every = window.setInterval(refresh, REFRESH_MS);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.clearTimeout(first);
            window.clearInterval(every);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [active, enabled]);
}
