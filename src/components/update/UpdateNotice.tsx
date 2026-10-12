import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ExternalLink, Info, RefreshCw, X } from 'lucide-react';
import { Button, ButtonLink, IconButton } from '../ui/Button';
import { useStore } from '../../store';

/**
 * The strip between the header and the page, in normal flow so it can never
 * cover the tab rail or a review session's buttons. It carries at most one of
 * three things, each shown until answered:
 *
 *   * after an update: "Terramentor has been updated to 1.4.1" with what's new — or, when
 *     the new version did not start and the updater put the old one back, that
 *     it did and why;
 *   * once, the question whether to check for updates at all. Checking is off
 *     until someone says yes (SECURITY.md: an idle default install makes no
 *     connection), and the question waits until the library has a project, so
 *     it never stands on top of the first-run screens.
 */
export default function UpdateNotice() {
    const { t } = useTranslation();
    const status = useStore(s => s.updateStatus);
    const hasProjects = useStore(s => s.projects.length > 0);
    const setAuto = useStore(s => s.setAutoUpdateCheck);
    const dismissResult = useStore(s => s.dismissUpdateResult);
    const [details, setDetails] = useState(false);
    if (!status) return null;
    const result = status.install?.result;

    if (result) {
        const releaseUrl = result.to ? `${status.repoUrl}/releases/tag/v${result.to}` : `${status.repoUrl}/releases`;
        return (
            <Strip tone={result.ok ? 'good' : 'info'} onClose={dismissResult} closeLabel={t("Dismiss")}>
                {result.ok ? (
                    <>
                        <CheckCircle2 className="w-5 h-5 text-accent-fg shrink-0" aria-hidden="true" />
                        <p className="min-w-0 flex-1">{t("Terramentor has been updated to {{version}}.", { version: result.to })}</p>
                        <ButtonLink href={releaseUrl} target="_blank" rel="noopener noreferrer" size="sm" variant="quiet" trailing={<ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />}>{t("What's new")}</ButtonLink>
                    </>
                ) : (
                    <>
                        <Info className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />
                        <div className="min-w-0 flex-1 basis-56">
                            <p>{result.step === 'start'
                                ? t("The update to {{version}} did not start, so Terramentor went back to {{current}}. Nothing in your library was lost.", { version: result.failed || result.to, current: status.current })
                                : t("The update to {{version}} could not be installed. Nothing was changed.", { version: result.to })}</p>
                            {/* What the failed version said about itself when it said
                                anything, else the updater's reason; the log named once. */}
                            {details && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 break-words">{result.said || result.reason} {t("The full record is updater.log in the logs folder beside your library.")}</p>}
                        </div>
                        <Button size="sm" variant="quiet" onClick={() => setDetails(d => !d)} aria-expanded={details}>{details ? t("Hide details") : t("Details")}</Button>
                    </>
                )}
            </Strip>
        );
    }

    if (!status.asked && !status.enabled && hasProjects) {
        return (
            <Strip tone="info">
                <RefreshCw className="w-5 h-5 text-accent-fg shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1 basis-64">
                    <p className="font-medium">{t("Check for new versions once a day?")}</p>
                    <p className="text-slate-600 dark:text-slate-300">{t("Once a day Terramentor can look up whether a newer version is out, and tell you. Nothing about you or your library is sent, and nothing is installed without you. You can change this in Settings.")}</p>
                </div>
                <div className="flex gap-2 shrink-0 ml-auto">
                    <Button size="sm" variant="neutral" onClick={() => setAuto(false)}>{t("Not now")}</Button>
                    <Button size="sm" variant="primary" onClick={() => setAuto(true)}>{t("Check daily")}</Button>
                </div>
            </Strip>
        );
    }
    return null;
}

function Strip({ tone, children, onClose, closeLabel }: { tone: 'good' | 'info'; children: ReactNode; onClose?: () => void; closeLabel?: string }) {
    return (
        <div
            role="status"
            className={`shrink-0 border-b px-3 sm:px-4 py-2 ${tone === 'good' ? 'border-accent/30 bg-accent/10 dark:bg-accent/15' : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60'}`}
        >
            {/* The close button sits outside the wrapping row, so on a phone
                it stays at the top right instead of falling to a line of its own. */}
            <div className="flex items-start gap-2 text-sm text-slate-800 dark:text-slate-100">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:gap-3">{children}</div>
                {onClose && <IconButton size="sm" variant="quiet" label={closeLabel || ''} icon={<X className="w-4 h-4" aria-hidden="true" />} onClick={onClose} />}
            </div>
        </div>
    );
}
