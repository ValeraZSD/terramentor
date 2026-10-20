import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from './ui/Button';

/**
 * A chat turn that failed, said where the learner is looking.
 *
 * A toast alone is the wrong instrument for a failed send, in two separate ways.
 *
 * It is in the wrong PLACE: the assistant is a full-screen overlay on a phone,
 * so a toast can land behind the panel the learner is staring at and the send
 * simply appears to do nothing (`z-[60]` on ToastContainer fixes the painting;
 * this fixes the reading — the answer to "what happened to my question" belongs
 * where the question was, not in the corner of a different layer).
 *
 * And it is the wrong SHAPE: a toast expires. The one thing a learner wants
 * after a failed send is to send it again, and a control that disappears after
 * four seconds cannot offer that. So the row stays until it is used or
 * dismissed, and it carries the retry.
 *
 * The learner's text is never the thing that is lost, but WHERE it went is the
 * caller's to say: a direct send that failed puts it back in the composer, a
 * turn that failed as a background task is spliced back into the transcript as
 * its own bubble (the server had already dropped the row). The third line
 * points at whichever of the two happened.
 */
export default function ChatTurnError({ message, onRetry, onDismiss, retryDisabled = false, keptIn = 'composer' }: {
    /** Why it failed, as the server or the transport put it. */
    message: string;
    onRetry: () => void;
    onDismiss: () => void;
    /** True while another turn is in flight — retrying now would be refused anyway. */
    retryDisabled?: boolean;
    /** Where the learner's text went: back into the composer, or kept as its own bubble above. */
    keptIn?: 'composer' | 'chat';
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
                    {keptIn === 'chat'
                        ? t("Your question is kept above.")
                        : t("Your message is back in the box below.")}
                </p>
                <Button size="sm" onClick={onRetry} disabled={retryDisabled} icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}>
                    {t("Try again")}
                </Button>
            </div>
            <IconButton size="sm" onClick={onDismiss} label={t("Dismiss")} tooltip={false} icon={<X className="w-4 h-4" />} className="-m-1.5" />
        </div>
    );
}
