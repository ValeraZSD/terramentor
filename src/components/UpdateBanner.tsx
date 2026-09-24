import { useState } from 'react';
import { ArrowUpCircle, X, ExternalLink, Terminal, Copy, Check } from 'lucide-react';
import { useStore } from '../store';
import { copyText } from '../utils/clipboard';
import { useTranslation } from 'react-i18next';

/**
 * "Version 0.9.1 is out" — the release banner.
 *
 * NOT the same thing as `UpdatePrompt`, and the difference matters. That one is
 * the service worker saying the page you have open is behind the build already
 * on this machine's disk; it can only ever offer a reload. This one says a newer
 * version of the SOFTWARE exists somewhere else, which no reload can fetch.
 *
 * Three deliberate choices:
 *
 *  - IN FLOW, not fixed. It sits above `main` and pushes the page down, so it
 *    can never cover the header, the tab rail, or the four rating buttons of a
 *    review session. A fixed strip would have to pick a z-index and would be
 *    wrong next to at least one of the app's three existing overlays.
 *
 *  - "How to update", NOT "Update now". The app cannot update itself: Docker,
 *    a git checkout and an unpacked copy need three different commands, and an
 *    endpoint that ran `git pull && npm install` on request would be remote code
 *    execution in an app whose pitch is a verifiable security posture. So the
 *    button reveals the exact command for how THIS instance was installed, with
 *    a copy button. Same click, and the label does not lie.
 *
 *  - The X means "next time". It is not persisted anywhere: dismissal lives for
 *    this page load, so starting the app again shows it again. A permanently
 *    dismissible update notice is one a person dismisses once and never sees,
 *    and a persisted one needs a store, a key and a cleanup rule to say the same
 *    thing React state already says.
 */
export default function UpdateBanner() {
    const { t } = useTranslation();
    const status = useStore(s => s.updateStatus);
    const dismissedVersion = useStore(s => s.updateDismissed);
    const dismiss = useStore(s => s.dismissUpdate);
    const [showHow, setShowHow] = useState(false);
    const [copied, setCopied] = useState(false);

    const latest = status?.latest;
    if (!status?.available || !latest) return null;
    if (dismissedVersion === latest.version) return null;

    const command = status.updateCommand;

    const copy = async () => {
        if (!command) return;
        // `navigator.clipboard` is undefined over plain http, which is exactly
        // how this app is reached from a phone without a tunnel; `copyText`
        // falls back to execCommand there. If nothing took, the command is on
        // screen and selectable — better than a tick that lied.
        if (!await copyText(command)) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div
            role="status"
            className="shrink-0 border-b border-accent/30 bg-accent/10 dark:bg-accent/15 px-3 sm:px-4 py-2"
        >
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                <ArrowUpCircle className="w-5 h-5 text-accent-fg shrink-0" aria-hidden="true" />

                <p className="text-sm text-slate-800 dark:text-slate-100 min-w-0">
                    <span className="font-medium">{t("Version {{version}} is available.", { version: latest.version })}</span>{' '}
                    <span className="text-slate-600 dark:text-slate-300">{t("You are on {{current}}.", { current: status.current })}</span>
                </p>

                <div className="flex items-center gap-1.5 ml-auto shrink-0">
                    <a
                        href={latest.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg text-accent-fg hover:bg-accent/15 transition"
                    >
                        <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                        {t("What's new")}
                    </a>
                    <button
                        onClick={() => setShowHow(v => !v)}
                        aria-expanded={showHow}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:brightness-95 transition"
                    >
                        <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                        {t("How to update")}
                    </button>
                    <button
                        onClick={dismiss}
                        aria-label={t("Remind me next time")}
                        title={t("Remind me next time")}
                        className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-accent/15 transition"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {showHow && (
                <div className="mt-2 text-sm text-slate-600 dark:text-slate-300 space-y-1.5">
                    {command ? (
                        <>
                            <p>{t("Run this where the app is installed, then restart it:")}</p>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 min-w-0 overflow-x-auto rounded-lg bg-slate-900 text-slate-100 px-3 py-2 font-mono text-xs whitespace-pre">
                                    {command}
                                </code>
                                <button
                                    onClick={copy}
                                    aria-label={t("Copy the update command")}
                                    className="shrink-0 p-2 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-white dark:hover:bg-slate-700 transition"
                                >
                                    {copied
                                        ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                                        : <Copy className="w-4 h-4" />}
                                </button>
                            </div>
                        </>
                    ) : (
                        <p>
                            {t("Download {{version}} from the release page and replace the application files. Your database is separate and is not touched.", { version: latest.version })}
                        </p>
                    )}
                    <p className="text-slate-500 dark:text-slate-400">
                        {t("Your data stays where it is. Read the release notes first if it mentions a database change.")}
                    </p>
                </div>
            )}
        </div>
    );
}
