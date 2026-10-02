import { useEffect, useState } from 'react';
import { FolderSearch, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { desktopApi, LibraryFallback } from '../../desktopApi';
import { Button } from '../ui/Button';
import DesktopQuitScreen from '../DesktopQuitScreen';

const DISMISS_KEY = 'library_notice_dismissed';

/**
 * The empty library that is not a first run.
 *
 * The launcher fell back to the default folder with no pointer to honour — the
 * shape of a `library-location.txt` lost since the last launch, which happened
 * on 2026-09-18 and was read as an onboarding screen for a whole day. The
 * server only reports it when BOTH halves agree: this launch fell back (the
 * launcher's own note says the last one resolved elsewhere) and the library
 * here is empty (0 projects — the fact that separates a lost pointer from
 * someone who simply has not created anything yet). Neither half alone may
 * speak, so a person who deleted their pointer on purpose is never nagged.
 *
 * The fix is one file with one path in it, which the Restore button writes;
 * it takes effect on the next start, so the button is followed by a quit —
 * the same quit, screen included, that Settings uses.
 */
export default function LibraryNoticeCard() {
    const { t } = useTranslation();
    const [notice, setNotice] = useState<LibraryFallback | null | undefined>(undefined);
    const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);
    const [restoring, setRestoring] = useState(false);
    const [restored, setRestored] = useState(false);
    const [quitting, setQuitting] = useState(false);

    useEffect(() => {
        // `details()`, not the public probe: the record names two paths, so it
        // is served from behind the auth gate (server/desktop.js). This card is
        // in the feed, which is past it.
        desktopApi.details()
            .then(s => setNotice(s.libraryFallback ?? null))
            .catch(() => setNotice(null));
        api.getSettings()
            .then(s => setDismissed(typeof s[DISMISS_KEY] === 'string' ? s[DISMISS_KEY] : null))
            .catch(() => setDismissed(null));
    }, []);

    if (notice === undefined || dismissed === undefined || !notice) return null;
    // Dismissal is keyed on the path it dismissed: the same warning again is
    // the reader's choice, but a warning about a DIFFERENT library is new
    // information. A successful restore clears the key, so a pointer lost
    // twice still warns the second time.
    if (dismissed === notice.lastDir) return null;

    const dismiss = async () => {
        setDismissed(notice.lastDir);
        try { await api.setSetting(DISMISS_KEY, notice.lastDir); } catch { /* cosmetic only */ }
    };

    const restore = async () => {
        setRestoring(true);
        try {
            await desktopApi.restoreLibrary();
            setRestored(true);
            try { await api.setSetting(DISMISS_KEY, ''); } catch { /* cosmetic only */ }
        } catch { /* the manual instruction below is the answer; leave it visible */ }
        setRestoring(false);
    };

    return (
        <section
            aria-label={t("Your library may be somewhere else")}
            className="rounded-2xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 overflow-hidden"
        >
            <div className="flex items-start gap-3 px-4 sm:px-5 pt-4 pb-1">
                <span className="p-1.5 rounded-lg bg-amber-100 dark:bg-amber-500/15 shrink-0">
                    <FolderSearch className="w-4 h-4 text-amber-700 dark:text-amber-300" aria-hidden="true" />
                </span>
                <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                        {t("Your library may be somewhere else")}
                    </h2>
                    <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">
                        {t("This library is empty, and the note that named your library's location is gone. Terramentor last used a library at:")}
                    </p>
                    <code className="block text-xs font-mono text-amber-800 dark:text-amber-200 bg-amber-100/70 dark:bg-amber-500/10 rounded-lg px-2 py-1.5 mt-2 break-all">
                        {notice.lastDir}
                    </code>
                    {!notice.lastDirExists && (
                        <p className="text-sm text-amber-700 dark:text-amber-400 mt-2">
                            {t("That folder is not reachable right now. If it is on a drive that is not plugged in, plug it in and start the app again.")}
                        </p>
                    )}
                    {restored ? (
                        <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">
                            {t("The note has been written. Quit Terramentor and start it again to reopen your library.")}
                        </p>
                    ) : (
                        <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">
                            {t("If the button does not work, write the path above as one line into this file and start the app again:")}
                        </p>
                    )}
                    {!restored && (
                        <code className="block text-xs font-mono text-slate-500 dark:text-slate-400 px-2 py-1 mt-1 break-all">
                            {notice.pointerPath}
                        </code>
                    )}
                </div>
                <button
                    onClick={dismiss}
                    aria-label={t("Dismiss")}
                    title={t("Dismiss")}
                    className="p-2 -m-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-amber-100 dark:hover:bg-amber-500/15 transition shrink-0"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="px-4 sm:px-5 pb-4 flex flex-wrap items-center gap-2">
                {!restored && notice.lastDirExists && (
                    <Button onClick={restore} busy={restoring} size="sm">
                        {t("Restore that library")}
                    </Button>
                )}
                {restored && (
                    <Button onClick={() => { setQuitting(true); try { void desktopApi.quit(); } catch { /* it is going away */ } }} size="sm">
                        {t("Quit now")}
                    </Button>
                )}
            </div>
            {quitting && <DesktopQuitScreen onStillRunning={() => { /* the reader can start the app again by hand */ }} />}
        </section>
    );
}
