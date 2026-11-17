import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { onUpdateReady } from '../sw-register';
import { watchFreshness } from '../utils/freshness';
import { installNewBuild, shouldInstallNow } from '../utils/installUpdate';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from './ui/Button';

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
 * When one arrives, the page installs the new build itself whenever that
 * costs nothing, and falls back to the banner when it does not — so a
 * half-finished mastery check is never thrown away, and a rebuild is never left
 * waiting for someone who knows Ctrl+Shift+R exists. Both ways through go by
 * one road, `utils/installUpdate.ts`: hand over to the waiting worker BEFORE
 * reloading, because a reload does not activate one, and a reload without the
 * handover comes back stale and reloads again, and again.
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
            className="fixed left-0 top-0 z-[60] flex justify-center safe-px-3 pointer-events-none"
            // Top centre, just under the header (3.5rem, as in Layout). It is
            // shown exactly when a reload is held back (a review session, an
            // assistant answer, text typed and unsaved), and the bottom centre
            // is where those screens keep the rating buttons, the composer and
            // the task dock. The right edge stops at a docked assistant
            // (`--assistant-w`), so the card is centred on the app column.
            style={{ right: 'var(--assistant-w, 0px)', paddingTop: 'calc(3.5rem + var(--safe-top) + 0.5rem)' }}
        >
            <div className="pointer-events-auto flex items-center gap-3 max-w-md w-full sm:w-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg px-4 py-3">
                <RefreshCw className="w-5 h-5 text-accent-fg shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900 dark:text-white">{t("Update available")}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{t("Reload to get the latest version.")}</p>
                </div>
                <Button variant="primary" onClick={() => void installNewBuild()} className="shrink-0">
                    {t("Reload")}
                </Button>
                <IconButton onClick={() => setDismissed(true)} label={t("Dismiss")} tooltip={false} icon={<X className="w-4 h-4" />} />
            </div>
        </div>
    );
}
