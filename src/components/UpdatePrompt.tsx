import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { onUpdateReady } from '../sw-register';
import { watchFreshness } from '../utils/freshness';
import { installNewBuild, shouldInstallNow } from '../utils/installUpdate';
import { useTranslation } from 'react-i18next';

/**
 * Keeps the running page on the build that is actually installed.
 *
 * Two things can tell us the page is out of date, and they answer different
 * questions. The service worker knows a new worker is WAITING (`onUpdateReady`)
 * — which only happens on a machine where the worker registered at all. The
 * freshness watcher asks the server what build is on disk
 * (`utils/freshness.ts`) — which works everywhere, including the desktop
 * window, plain http on the LAN, and a browser with service workers off. Either
 * one arriving means the same thing here.
 *
 * What happens then is the part that changed. It used to be this banner and
 * nothing else, so a rebuild sat unnoticed until someone knew that Ctrl+Shift+R
 * existed. Now the page installs the new build itself when that costs nothing,
 * and falls back to the banner when it does not — so a half-finished Boss Fight
 * is still never thrown away. Both ways through go by one road,
 * `utils/installUpdate.ts`, which is where the order that matters is written
 * down: the automatic path used to reload WITHOUT handing over to the waiting
 * worker, and a reload does not activate one, so the page came back stale and
 * reloaded again, and again.
 */
export default function UpdatePrompt() {
    const { t } = useTranslation();
    const [ready, setReady] = useState(false);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        const stale = () => {
            if (shouldInstallNow()) void installNewBuild();
            else setReady(true);
        };
        const unsubscribe = onUpdateReady(stale);
        watchFreshness(stale);
        return unsubscribe;
    }, []);

    if (!ready || dismissed) return null;

    return (
        <div
            role="status"
            className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pointer-events-none"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
        >
            <div className="pointer-events-auto flex items-center gap-3 max-w-md w-full sm:w-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg px-4 py-3">
                <RefreshCw className="w-5 h-5 text-accent-fg shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900 dark:text-white">{t("Update available")}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{t("Reload to get the latest version.")}</p>
                </div>
                <button
                    onClick={() => void installNewBuild()}
                    className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:brightness-95 transition"
                >
                    {t("Reload")}
                </button>
                <button
                    onClick={() => setDismissed(true)}
                    aria-label={t("Dismiss")}
                    className="shrink-0 p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
