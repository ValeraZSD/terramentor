import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X, Copy, Check, ChevronDown } from 'lucide-react';
import type { AITaskFailure } from '../types';
import { useTranslation } from 'react-i18next';
import { uiLocale } from '../utils/locale';

/**
 * Why a background generation failed.
 *
 * A one-line dock failure ("Generation failed") says something went wrong and
 * nothing else. That is bad for the learner, who cannot tell a dead model from
 * a bad prompt from a network blip, and useless for a bug report from someone
 * else's machine, which is the case that starts mattering the day this ships.
 *
 * So: two layers, and the order is the point. A plain sentence and the three or
 * four facts that usually explain it come first, because most failures are one
 * of a handful of ordinary things (nothing listening on the endpoint, the model
 * unloaded, a request that ran out of context). The full record is one click
 * further down, formatted to be copied into an issue verbatim.
 *
 * Nothing here is inferred. Every field is what the server actually recorded at
 * the moment of failure; a fact it did not have is simply absent rather than
 * guessed at, because a confident wrong diagnosis is worse than a gap.
 */

/** The likeliest cause, in words, for the handful of failures that are
 *  recognisable from the record alone. Returns null rather than speculating —
 *  an unrecognised failure gets the raw message and no invented explanation. */
function plainCause(f: AITaskFailure): string | null {
    const msg = (f.message || '').toLowerCase();
    if (f.looped) {
        return 'The model went round in circles in its reasoning — the same few lines over and over — and was stopped. Local models do this most on long lists of instructions; a shorter question, or a different model in Settings → AI & Models, usually avoids it.';
    }
    if (f.emptyReply) {
        // The message already carries the numbers (emptyReplyReason in
        // server/ai.js); this says what kind of failure they add up to, which
        // is the part that reads as an app fault when it is not one.
        return f.reasoningTokens || f.produced?.thinkingChars
            ? 'The endpoint answered, but the answer was empty: the model spent the reply thinking and never wrote any of it down. Reasoning-first models do this when their budget runs out mid-thought — ask for less thinking, or pick a model that answers directly.'
            : 'The endpoint answered with an empty reply. Nothing was generated, and nothing about the request explains why — if it repeats, the model or the endpoint is the thing to change.';
    }
    if (f.httpStatus === 401 || f.httpStatus === 403) {
        return 'The endpoint rejected the API key. Check the key in Settings → AI & Models.';
    }
    if (f.httpStatus === 402) {
        return 'The provider refused the request for billing reasons — the account is out of credit or the model is not on your plan.';
    }
    if (f.httpStatus === 404) {
        return `The endpoint does not know the model${f.model ? ` "${f.model}"` : ''}. It may have been renamed, unloaded, or never installed.`;
    }
    if (f.httpStatus === 429) {
        // The server already backs off and retries a 429 (see aiFetchWithRetry
        // in server/ai.js), so saying "retrying usually works" after several
        // attempts is advice that has already been taken and failed.
        return (f.attempts ?? 1) > 1
            ? `The provider rate-limited the request and was still refusing after ${f.attempts} attempts — the quota is spent rather than momentarily busy. Wait for the window to reset, or switch model in Settings → AI & Models.`
            : 'The provider rate-limited the request. Waiting and retrying usually works.';
    }
    if (f.httpStatus != null && f.httpStatus >= 500) {
        return 'The endpoint itself errored. With a local server this usually means the model failed to load — often not enough free VRAM.';
    }
    if (/econnrefused|failed to fetch|fetch failed|networkerror/i.test(msg)) {
        return 'Nothing answered at the endpoint. The model server is probably not running.';
    }
    if (/abort|timeout|timed out/i.test(msg)) {
        // A timeout reads as a dead endpoint, and the commonest one here is the
        // opposite: a model that talked the whole time without answering. The
        // record distinguishes them, so let it.
        if (f.produced?.thinkingChars > 0 && !f.produced?.contentChars) {
            return 'The request ran out of time, and everything the model sent before it did was reasoning — it never began the answer. Ask for less thinking in Settings → AI & Models, or pick a model that answers directly.';
        }
        return 'The request took too long and was given up on.';
    }
    if (/no model selected/i.test(msg)) {
        return 'No model is configured. Pick one in Settings → AI & Models.';
    }
    if (/json|parse|unexpected token/i.test(msg)) {
        return 'The model replied, but not in the shape this step needs. Smaller models do this more often; the raw reply is below.';
    }
    return null;
}

const ms = (n: number | null) => (n == null ? null : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
const when = (iso: string | null) => {
    if (!iso) return null;
    try { return new Date(iso).toLocaleString(uiLocale()); } catch { return iso; }
};

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
    if (value === null || value === undefined || value === '') return null;
    return (
        <div className="flex gap-3 py-1.5 text-sm">
            <dt className="w-32 shrink-0 text-slate-500 dark:text-slate-400">{label}</dt>
            <dd className="min-w-0 break-words font-mono text-xs text-slate-700 dark:text-slate-200">{value}</dd>
        </div>
    );
}

export default function TaskFailureModal({ failure, onClose }: {
    failure: AITaskFailure;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [showRaw, setShowRaw] = useState(false);
    const [copied, setCopied] = useState(false);
    const cause = plainCause(failure);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify(failure, null, 2));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // `navigator.clipboard` is undefined over plain http, which is how
            // this app is reached from a phone. Select-and-copy still works.
            setShowRaw(true);
        }
    };

    // Escape closes it, like every other dialog here — the backdrop is the only
    // other way out and on a phone most of it is behind the dialog.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // PORTALLED TO document.body, and it has to be.
    //
    // The chip that opens this lives inside the TaskDock, which is
    // `fixed bottom-3 left-1/2` with a `transform` on it (DOCK_CENTRE, which
    // centres the dock on the app column rather than the viewport). A transform
    // makes that element the containing block for every `position: fixed`
    // descendant, so rendered in place this dialog's `inset-0` resolved to the
    // dock's own pill instead of the screen: the backdrop dimmed nothing, `z-60`
    // was capped inside the dock's z-40 stacking context, and all the reader got
    // was the footer buttons at the bottom edge with the failure itself off
    // screen — the one thing the dialog exists to show.
    return createPortal(
        <div
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
            onClick={onClose}
            role="presentation"
        >
            <div
                className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl dark:bg-slate-800 sm:rounded-2xl"
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={t("Generation failure details")}
            >
                <div className="flex items-start gap-3 border-b border-slate-200 p-4 dark:border-slate-700">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <h2 className="font-semibold text-slate-900 dark:text-white">{t("This generation failed")}</h2>
                        <p className="truncate text-sm text-slate-500 dark:text-slate-400">{failure.label}</p>
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
                    {/* What happened, in words. */}
                    <p className="text-sm leading-relaxed text-slate-800 dark:text-slate-100">{failure.message}</p>
                    {cause && (
                        <p className="mt-2 rounded-lg bg-slate-100 p-3 text-sm leading-relaxed text-slate-600 dark:bg-slate-700/50 dark:text-slate-300">
                            {cause}
                        </p>
                    )}

                    {/* The few facts that usually explain it. */}
                    <dl className="mt-4 divide-y divide-slate-100 dark:divide-slate-700/60">
                        <Row label={t("When")} value={when(failure.at)} />
                        <Row label={t("Task")} value={failure.kind} />
                        <Row label={t("Step")} value={failure.phase || failure.lastMessage} />
                        <Row label={t("Model")} value={failure.model} />
                        <Row label={t("Provider")} value={failure.provider} />
                        <Row label={t("Endpoint")} value={failure.endpoint} />
                        <Row label={t("HTTP status")} value={failure.httpStatus} />
                        <Row label={t("Attempts")} value={failure.attempts} />
                        <Row label={t("Error code")} value={failure.code} />
                        <Row label={t("Ran for")} value={ms(failure.elapsedMs)} />
                        {/* How far it got: the difference between "the model never
                            answered" and "it answered for 40 seconds then broke". */}
                        <Row
                            label={t("Produced")}
                            value={failure.produced.contentChars || failure.produced.thinkingChars
                                ? `${failure.produced.contentChars} answer chars, ${failure.produced.thinkingChars} reasoning chars`
                                : 'nothing — it failed before the model replied'}
                        />
                    </dl>

                    {failure.causes.length > 0 && (
                        <div className="mt-4">
                            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                {t("Underlying causes")}
                            </h3>
                            <ul className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
                                {failure.causes.map((c, i) => (
                                    <li key={i} className="font-mono break-words">↳ {c}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* The technical record. Collapsed, because it is for a bug
                        report rather than for reading. */}
                    <button
                        onClick={() => setShowRaw(v => !v)}
                        aria-expanded={showRaw}
                        className="mt-4 flex w-full items-center justify-between rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-700/50 dark:text-slate-200 dark:hover:bg-slate-700"
                    >
                        <span>{t("Technical detail")}</span>
                        <ChevronDown className={`h-4 w-4 transition-transform ${showRaw ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>

                    {showRaw && (
                        <>
                            {(failure.responseBody || failure.rawResponse) && (
                                <div className="mt-3">
                                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        {t("What the endpoint actually returned")}
                                    </h3>
                                    <pre className="max-h-48 overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
                                        {failure.responseBody || failure.rawResponse}
                                    </pre>
                                </div>
                            )}
                            <div className="mt-3">
                                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                    {t("Full record")}
                                </h3>
                                <pre className="max-h-64 select-text overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
                                    {JSON.stringify(failure, null, 2)}
                                </pre>
                            </div>
                            {failure.stack && (
                                <div className="mt-3">
                                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        {t("Stack")}
                                    </h3>
                                    <pre className="max-h-48 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-300">
                                        {failure.stack}
                                    </pre>
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className="flex justify-end gap-2 border-t border-slate-200 p-3 dark:border-slate-700">
                    <button
                        onClick={copy}
                        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                    >
                        {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                        {copied ? t("Copied") : t("Copy report")}
                    </button>
                    <button
                        onClick={onClose}
                        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
                    >
                        {t("Close")}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
