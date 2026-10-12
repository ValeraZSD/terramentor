import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, ExternalLink, Loader2, RotateCw } from 'lucide-react';
import Modal from '../Modal';
import { Button, ButtonLink } from '../ui/Button';
import { useStore } from '../../store';
import { api } from '../../api';
import { copyText } from '../../utils/clipboard';
import { canReloadNow, reloadOntoNewBuild } from '../../utils/freshness';
import { megabytes, updateView } from './updateView';

/**
 * The one place an update is explained and acted on. Opened from the header
 * button (UpdateControl) and from Settings → About; what it says is decided by
 * `updateView`, so the two entrances cannot disagree.
 *
 * Restarting is the only step that ends the session, so it is the only one
 * that asks first, and it names what stops (a running AI task) rather than
 * warning in general.
 */
export default function UpdateDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const status = useStore(s => s.updateStatus);
    const downloadUpdate = useStore(s => s.downloadUpdate);
    const cancelDownload = useStore(s => s.cancelUpdateDownload);
    const runningTasks = useStore(s => s.aiTasks.filter(task => task.status === 'running').length);
    const [restarting, setRestarting] = useState<string | null>(null);
    const [restartError, setRestartError] = useState<string | null>(null);
    const [details, setDetails] = useState(false);
    const view = updateView(status);

    if (restarting) return <RestartingDialog version={restarting} />;
    if (!status || view.kind === 'none') return null;

    const releaseUrl = status.latest?.url || `${status.repoUrl}/releases`;
    const whatsNew = (
        <ButtonLink href={releaseUrl} target="_blank" rel="noopener noreferrer" variant="quiet" size="sm" trailing={<ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />}>
            {t("What's new")}
        </ButtonLink>
    );

    const restart = async () => {
        if (view.kind !== 'ready') return;
        setRestartError(null);
        try {
            await api.restartToUpdate();
            setRestarting(view.version);
        } catch (e) {
            setRestartError(e instanceof Error ? e.message : String(e));
        }
    };

    let title = '';
    let body: ReactNode = null;
    let left: ReactNode = null;
    let buttons: ReactNode = null;

    if (view.kind === 'ready') {
        title = t("Restart to update?");
        body = (
            <>
                <p>{t("Terramentor {{version}} is downloaded and checked. Restarting installs it: the app closes and opens again in a few seconds. Your library and your progress stay as they are.", { version: view.version })}</p>
                {runningTasks > 0 && (
                    <p className="text-amber-700 dark:text-amber-300">{t("{{count}} AI task is running and will stop. You can start it again afterwards.", { count: runningTasks })}</p>
                )}
                {/* The same test the app uses before reloading itself: text typed
                    and not saved, an answer streaming, a review session open. */}
                {!canReloadNow() && (
                    <p className="text-amber-700 dark:text-amber-300">{t("Something on this page is not finished: text you typed and have not saved, an answer still arriving, or a review session. Finish it first, or it is lost.")}</p>
                )}
                {restartError && <p role="alert" className="text-red-700 dark:text-red-300">{restartError}</p>}
            </>
        );
        left = whatsNew;
        buttons = (
            <>
                <Button variant="neutral" onClick={onClose}>{t("Later")}</Button>
                <Button variant="primary" icon={<RotateCw className="w-4 h-4" aria-hidden="true" />} onClick={restart}>{t("Restart now")}</Button>
            </>
        );
    } else if (view.kind === 'downloading') {
        const install = status.install!;
        // The same word as the header button: "Preparing" while it checks what
        // is already here, "Downloading" once bytes come in.
        title = view.checking || install.total <= 0
            ? t("Preparing Terramentor {{version}}", { version: view.version })
            : t("Downloading Terramentor {{version}}", { version: view.version });
        body = (
            <>
                <div
                    role="progressbar"
                    aria-label={t("Download progress")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={view.percent ?? undefined}
                    className="h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden"
                >
                    <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${view.percent ?? 2}%` }} />
                </div>
                <p className="text-slate-600 dark:text-slate-300">
                    {install.total <= 0 || view.checking
                        ? t("Checking what you already have, so that only the changes are downloaded.")
                        : install.mode === 'full'
                            ? t("{{received}} of {{total}} MB. This time the whole package is downloaded.", { received: megabytes(install.received), total: megabytes(install.total) })
                            : t("{{received}} of {{total}} MB", { received: megabytes(install.received), total: megabytes(install.total) })}
                </p>
                <p>{t("You can keep studying. Stopping keeps what has arrived, and nothing restarts without asking you.")}</p>
            </>
        );
        buttons = (
            <>
                <Button variant="neutral" onClick={() => { cancelDownload(); onClose(); }}>{t("Stop download")}</Button>
                <Button variant="neutral" onClick={onClose}>{t("Close")}</Button>
            </>
        );
    } else if (view.kind === 'failed') {
        title = view.error.kind === 'hash' ? t("The update arrived damaged") : t("The update did not download");
        body = (
            <>
                <p>{failureSentence(view.error.kind, t)}</p>
                {details && <p className="text-slate-500 dark:text-slate-400 text-xs break-words">{view.error.message}</p>}
            </>
        );
        left = (
            <Button variant="quiet" size="sm" onClick={() => setDetails(d => !d)} aria-expanded={details}>
                {details ? t("Hide details") : t("Details")}
            </Button>
        );
        buttons = view.error.kind === 'manual'
            ? <><Button variant="neutral" onClick={onClose}>{t("Close")}</Button><ButtonLink href={releaseUrl} target="_blank" rel="noopener noreferrer" variant="primary" icon={<Download className="w-4 h-4" aria-hidden="true" />}>{t("Open the download page")}</ButtonLink></>
            : <><Button variant="neutral" onClick={onClose}>{t("Close")}</Button><Button variant="primary" icon={<RotateCw className="w-4 h-4" aria-hidden="true" />} onClick={downloadUpdate}>{t("Try again")}</Button></>;
    } else if (view.canInstall) {
        title = t("Terramentor {{version}} is available", { version: view.version });
        body = (
            <>
                <p>{t("You have {{current}}. Download it now and restart when it suits you.", { current: status.current })}</p>
                {status.latest?.packageSize ? (
                    <p className="text-slate-600 dark:text-slate-300">{t("Download: at most {{size}} MB, usually a few MB, because only what changed is fetched.", { size: megabytes(status.latest.packageSize) })}</p>
                ) : null}
            </>
        );
        left = whatsNew;
        buttons = (
            <>
                <Button variant="neutral" onClick={onClose}>{t("Later")}</Button>
                <Button variant="primary" icon={<Download className="w-4 h-4" aria-hidden="true" />} onClick={downloadUpdate}>{t("Download update")}</Button>
            </>
        );
    } else {
        title = t("Terramentor {{version}} is available", { version: view.version });
        body = <HowToUpdate />;
        left = whatsNew;
        buttons = <Button variant="neutral" onClick={onClose}>{t("Close")}</Button>;
    }

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={title} maxWidth="max-w-lg">
            <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">{body}</div>
            {/* The buttons are one group pushed right, so on a phone they wrap
                together under "What's new" instead of one by one. */}
            <div className="mt-5 flex flex-wrap items-center gap-2">
                {left}
                <div className="ml-auto flex flex-wrap justify-end gap-2">{buttons}</div>
            </div>
        </Modal>
    );
}

/** The plain-words reason a download failed; the raw message sits under it. */
function failureSentence(kind: string, t: (k: string) => string): string {
    switch (kind) {
        case 'network': return t("Terramentor could not reach GitHub. Check the internet connection and try again.");
        case 'hash': return t("The download did not match the release, so it was thrown away. Nothing was installed.");
        case 'origin': return t("The release information did not look right, so nothing was downloaded.");
        case 'space': return t("There is not enough free space on this disk for the update.");
        case 'disk': return t("Terramentor could not write into its own folder.");
        case 'manual': return t("This version cannot be installed with one click. Download it from the release page instead.");
        default: return t("Something went wrong while downloading.");
    }
}

/**
 * Docker, a git checkout, or a desktop copy that cannot replace itself: say
 * what to do instead. A container cannot update itself without the Docker
 * socket, which would hand the app control of every container on the machine,
 * so it gets the one command and a copy button.
 */
function HowToUpdate() {
    const { t } = useTranslation();
    const status = useStore(s => s.updateStatus)!;
    const [copied, setCopied] = useState(false);
    const reason = status.install?.reason;
    const command = status.updateCommand;
    if (command) {
        return (
            <>
                <p>{status.deployment === 'docker'
                    ? t("This copy runs in Docker. Run this on the computer that runs it:")
                    : t("This copy runs from a git checkout. Run this in its folder, then start it again:")}</p>
                <div className="flex items-center gap-2">
                    <code className="flex-1 min-w-0 overflow-x-auto rounded-lg bg-slate-900 text-slate-100 px-3 py-2 font-mono text-xs whitespace-pre">{command}</code>
                    <Button
                        variant="neutral"
                        size="sm"
                        icon={copied ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
                        onClick={async () => { if (await copyText(command)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}
                    >
                        {copied ? t("Copied") : t("Copy")}
                    </Button>
                </div>
            </>
        );
    }
    return (
        <>
            <p>{reason === 'read-only'
                ? t("Terramentor is in a folder it is not allowed to change, so it cannot update itself there. Move the Terramentor folder somewhere of your own, such as Documents, and it will update with one click from then on.")
                : t("This copy cannot replace itself. Download the new version and unpack it over this one; your library stays where it is.")}</p>
            <ButtonLink href={status.latest?.url || `${status.repoUrl}/releases`} target="_blank" rel="noopener noreferrer" variant="neutral" size="sm" icon={<Download className="w-4 h-4" aria-hidden="true" />}>
                {t("Open the download page")}
            </ButtonLink>
        </>
    );
}

/**
 * After "Restart now": the server is going away, and in the desktop window the
 * launcher closes this window and a new one opens on the new version. In a
 * browser tab (a phone on the tailnet) nothing closes it, so it waits for the
 * server to come back and reloads onto whatever answers — the new version, or
 * the old one if the update was put back, which then says so itself.
 */
function RestartingDialog({ version }: { version: string }) {
    const { t } = useTranslation();
    const [slow, setSlow] = useState(false);
    const from = useStore(s => s.appVersion?.version);
    const started = useRef(Date.now());
    useEffect(() => {
        let stop = false;
        const tick = async () => {
            if (stop) return;
            try {
                const v = await api.getVersion();
                // Back up: the new version, or the old one put back after a
                // failed start (its own note explains). Either way, reload.
                if (v.version !== from || Date.now() - started.current > 20_000) { await reloadOntoNewBuild(); return; }
            } catch { /* still restarting */ }
            if (Date.now() - started.current > 180_000) setSlow(true);
            setTimeout(tick, 1500);
        };
        const first = setTimeout(tick, 3000);
        return () => { stop = true; clearTimeout(first); };
    }, [from]);
    return (
        <Modal isOpen onClose={() => {}} closable={false} title={t("Installing Terramentor {{version}}", { version })} maxWidth="max-w-md">
            <div className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-200" role="status">
                <Loader2 className="w-5 h-5 animate-spin shrink-0 text-accent-fg" aria-hidden="true" />
                <p>{slow
                    ? t("This is taking longer than usual. If Terramentor does not reopen, start it again from the Start menu or its folder.")
                    : t("Terramentor will close and open again by itself in a few seconds.")}</p>
            </div>
        </Modal>
    );
}
