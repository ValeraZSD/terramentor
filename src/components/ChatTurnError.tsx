import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * A chat turn that failed, said where the learner is looking.
 *
 * Both chat surfaces used to report a failed send with a toast and nothing
 * else, and a toast is the wrong instrument for this in two separate ways.
 *
 * It is in the wrong PLACE: the assistant is a full-screen overlay on a phone,
 * so the notice landed behind the panel the learner was staring at and the send
 * simply appeared to do nothing (`z-[60]` on ToastContainer fixes the painting;
 * this fixes the reading — the answer to "what happened to my question" belongs
 * where the question was, not in the corner of a different layer).
 *
 * And it is the wrong SHAPE: a toast expires. The one thing a learner wants
 * after a failed send is to send it again, and a control that disappears after
 * four seconds cannot offer that. So the row stays until it is used or
 * dismissed, and it carries the retry.
 *
 * The learner's text is put back in the composer by the caller, so this only
 * has to say so — the message they typed is never the thing that is lost.
 */
export default function ChatTurnError({ message, onRetry, onDismiss, retryDisabled = false }: {
    /** Why it failed, as the server or the transport put it. */
    message: string;
    onRetry: () => void;
    onDismiss: () => void;
    /** True while another turn is in flight — retrying now would be refused anyway. */
    retryDisabled?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <div
            role="alert"
            className="flex items-start gap-2 px-3 py-2.5 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/25 text-sm"
        >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
            <div className="flex-1 min-w-0 space-y-1.5">
                <p className="font-medium text-slate-900 dark:text-white">{t("That didn’t send")}</p>
                <p className="text-sm text-slate-600 dark:text-slate-300 break-words">{message}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                    {t("Your message is back in the box below.")}
                </p>
                <button
                    type="button"
                    onClick={onRetry}
                    disabled={retryDisabled}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 border border-red-200 dark:border-red-800 text-slate-700 dark:text-slate-200 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50 transition"
                >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {t("Try again")}
                </button>
            </div>
            <button
                type="button"
                onClick={onDismiss}
                aria-label={t("Dismiss")}
                className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10"
            >
                <X className="w-4 h-4 text-slate-400" />
            </button>
        </div>
    );
}
