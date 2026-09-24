import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bug, X, Copy, Check, ExternalLink, Lightbulb, MessageSquareWarning } from 'lucide-react';
import { useStore } from '../store';
import { diagnosticsBlock, issueUrl, type ReportKind } from '../utils/report';
import { copyText } from '../utils/clipboard';
import { useTranslation } from 'react-i18next';
import Radio from './ui/Radio';
import { k } from '../i18n';

/**
 * "Report a problem" — the in-app front end to the issue tracker.
 *
 * The problem this solves is not that filing an issue is hard; it is that the
 * half of an issue that makes it actionable (which build, which commit, which
 * model, Docker or not) is invisible to the person filing it. The app knows all
 * of that. So it fills that half in, and the person writes the half they are the
 * only expert in.
 *
 * SHOW, DON'T SEND. The dialog prints the exact text that will travel, before
 * anything opens. Then the button opens GitHub's own compose form with the
 * fields pre-filled — this app makes no request, and GitHub receives the text
 * when the person presses Submit on GitHub's page. Anyone who does not want to
 * open a browser at all can press Copy and paste it wherever they like.
 *
 * Three kinds rather than one, because the third is specific to this project:
 * a learner who cannot read a stack trace is perfectly placed to notice that a
 * generated lesson taught something false, and CONTRIBUTING.md already calls
 * that one of the most valuable reports there is. A single "Bug" form would bury
 * it under fields about reproduction steps that do not apply.
 */

const KINDS: { id: ReportKind; label: string; hint: string; Icon: typeof Bug }[] = [
    { id: 'bug', label: k("Something is broken"), hint: k("A button does nothing, a page is wrong, an error appears."), Icon: Bug },
    { id: 'content', label: k("The AI got something wrong"), hint: k("A lesson, question, visual or grade that is factually wrong."), Icon: MessageSquareWarning },
    { id: 'idea', label: k("An idea or request"), hint: k("Something missing, or something that could work better."), Icon: Lightbulb },
];

export default function ReportProblemDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const version = useStore(s => s.appVersion);
    const aiProvider = useStore(s => s.aiProvider);
    const aiModel = useStore(s => s.aiModel);
    const [kind, setKind] = useState<ReportKind>('bug');
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const ctx = { version, aiProvider, aiModel };
    const block = diagnosticsBlock(ctx);
    const repo = version?.repoUrl || 'https://github.com/ValeraZSD/terramentor';

    const copy = async () => {
        // `navigator.clipboard` is undefined over plain http, which is how a
        // phone reaches this without a tunnel; `copyText` falls back to the
        // execCommand path there. When even that fails the block is on screen
        // and selectable, so say nothing rather than flash a tick.
        if (!await copyText(block)) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
            onClick={onClose}
            role="presentation"
        >
            <div
                className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl dark:bg-slate-800 sm:rounded-2xl"
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={t("Report a problem")}
            >
                <div className="flex items-start gap-3 border-b border-slate-200 p-4 dark:border-slate-700">
                    <Bug className="mt-0.5 h-5 w-5 shrink-0 text-accent-fg" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <h2 className="font-semibold text-slate-900 dark:text-white">{t("Report a problem")}</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {t("Nothing is sent from here — this opens a form you fill in and submit yourself.")}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label={t("Close")}
                        className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <fieldset>
                        <legend className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                            {t("What are you reporting?")}
                        </legend>
                        <div className="space-y-2">
                            {KINDS.map(({ id, label, hint, Icon }) => (
                                <label
                                    key={id}
                                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                                        kind === id
                                            ? 'border-accent bg-accent/10'
                                            : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-700/50'
                                    }`}
                                >
                                    <Radio
                                        name="report-kind"
                                        value={id}
                                        checked={kind === id}
                                        onChange={() => setKind(id)}
                                        className="mt-0.5"
                                    />
                                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-medium text-slate-900 dark:text-white">{t(label)}</span>
                                        <span className="block text-sm text-slate-500 dark:text-slate-400">{t(hint)}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>

                    <div className="mt-4">
                        <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200">
                            {t("These details go with it")}
                        </h3>
                        <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">
                            {t("Facts about the software and this machine. No project names, topics, notes or anything you have studied.")}
                        </p>
                        {/* WRAPS, rather than scrolling sideways. The browser
                            user-agent string is one long line and `overflow-auto`
                            put a horizontal scrollbar under a block the reader is
                            being asked to CHECK before submitting — half of it off
                            screen. These are key: value facts, not code: a line
                            break changes nothing, so wrapping is the better
                            reading. (The update COMMAND next door keeps its
                            horizontal scroll for the opposite reason — a wrapped
                            command is one somebody copies wrong.) */}
                        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-100 p-3 font-mono text-xs leading-relaxed text-slate-700 dark:bg-slate-900 dark:text-slate-300">
{block || t("Version information is not available.")}
                        </pre>
                    </div>
                </div>

                <div className="flex items-center gap-2 border-t border-slate-200 p-4 dark:border-slate-700">
                    <button
                        onClick={copy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                    >
                        {copied ? <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-4 w-4" />}
                        {copied ? t("Copied") : t("Copy details")}
                    </button>
                    <a
                        href={issueUrl(repo, kind, ctx)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={onClose}
                        className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:brightness-95"
                    >
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        {t("Continue on GitHub")}
                    </a>
                </div>
            </div>
        </div>,
        document.body,
    );
}
