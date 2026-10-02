import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PowerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * What the last window does after Quit.
 *
 * The window is not the process (docs/DESKTOP.md): the server stops itself,
 * and the Chromium `--app` window the launcher spawned carries on showing a
 * page whose server no longer exists — every request failing, nothing saying
 * why. Pressing Quit and being left looking at the app is the one outcome the
 * button cannot have.
 *
 * The window the LAUNCHER opened is closed by the launcher, on its way out
 * (desktop/launcher.js). This screen is for every other window the app can be
 * quit from — an installed PWA, a tab, a phone on the same server — and for
 * the case where that close does not land.
 *
 * It still asks: `window.close()` is granted to a window with no session
 * history of its own (measured against a real Edge — `history.length` 1
 * closes, 2 is refused, and every route change here is a pushState), so a
 * window opened straight onto the app goes quietly. The refusal is silent,
 * which is why this is a SCREEN and not a call: what the browser will not
 * close, the app tells the reader has stopped, rather than leaving a dead page
 * that still looks alive.
 *
 * It waits for the server to be GONE before saying so. The endpoint answers
 * before it shuts down (a closed socket would read as a failed request), so a
 * successful response means "stopping", not "stopped" — and a quit that did
 * not take is reported back rather than painted over with a farewell.
 */
export default function DesktopQuitScreen({ onStillRunning }: { onStillRunning: () => void }) {
    const { t } = useTranslation();
    const [stopped, setStopped] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        void (async () => {
            // ~4s: the endpoint stops 150ms after answering, and a machine
            // checkpointing a large WAL on a spinning disk takes longer than a
            // quick one. Long enough to be sure, short enough that a server
            // that is NOT stopping is handed back while the reader is still
            // looking at the button they pressed.
            for (let i = 0; i < 16; i++) {
                await sleep(250);
                if (cancelled) return;
                const alive = await fetch('/api/desktop/status', { cache: 'no-store' })
                    .then(r => r.ok).catch(() => false);
                if (alive) continue;
                setStopped(true);
                // No user gesture is needed for a window a script is allowed to
                // close, and there is none to have: this runs on a timer.
                try { window.close(); } catch { /* the screen below is the answer */ }
                return;
            }
            if (!cancelled) onStillRunning();
        })();
        return () => { cancelled = true; };
    }, [onStillRunning]);

    // Above the toasts (z-[60]) and the model picker's popover (z-[70]): this
    // is the last thing the page ever shows, and a "connection lost" toast
    // painted over it would be describing what the reader just asked for.
    return createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-6">
            <div className="max-w-sm text-center">
                <PowerOff className="w-10 h-10 mx-auto text-slate-400 dark:text-slate-500" aria-hidden="true" />
                <p className="mt-4 text-lg font-semibold text-slate-900 dark:text-white" role="status">
                    {stopped ? t("The app has stopped") : t("Stopping…")}
                </p>
                {stopped && (
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                        {t("You can close this window. Your data is saved.")}
                    </p>
                )}
            </div>
        </div>,
        document.body,
    );
}
