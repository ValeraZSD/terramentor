import { useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { LessonWrite } from '../../types';
import { lessonFailureFacts, plainCause, retryMayHelp } from '../../utils/failureCause';
import { Button } from '../ui/Button';

/**
 * A topic's page while its first lesson is being written (`lessonPending`,
 * utils/feedPlacement.ts): the page holds nothing to read yet, so it says so
 * and nothing else. The Overview standing in for the lesson is not shown: a
 * "Got it, continue" with no lesson behind it asks the learner to read
 * something that is not there. The lesson replaces this when it lands.
 */
export function LessonBeingWritten({ title }: { title?: string }) {
    const { t } = useTranslation();
    return (
        <div role="status" className="flex-1 flex items-center justify-center px-6 py-12">
            <div className="text-center max-w-sm">
                <Loader2 className="w-10 h-10 text-accent-fg animate-spin mx-auto mb-4" aria-hidden="true" />
                <p className="text-slate-600 dark:text-slate-300 font-medium">{t("Writing the lesson")}</p>
                {title && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 break-words">{title}</p>}
            </div>
        </div>
    );
}

/**
 * The same page once the write failed: it says so, and why (in plain words
 * where the cause is recognisable, the model's own words otherwise), and
 * offers the two ways on: Try again, and Set up AI. Whichever the cause points
 * at is the primary (`retryMayHelp`, as on a course creation that stopped).
 * The Overview is not offered instead: it is a summary, not the lesson. The
 * writer also tries again by itself when its backoff ends, and the page then
 * goes back to "Writing the lesson".
 */
export function LessonWriteFailed({ write, title, onRetry }: { write: LessonWrite; title?: string; onRetry: () => Promise<void> }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const facts = lessonFailureFacts(write);
    const cause = write.reason ? plainCause(facts, { rawShown: false }) : null;
    const why = cause ? t(cause.messageKey, cause.params) : write.reason;
    const retryFirst = retryMayHelp(facts);
    const retry = async () => {
        setBusy(true);
        try { await onRetry(); } finally { setBusy(false); }
    };
    const tryAgain = (
        <Button variant={retryFirst ? 'primary' : 'neutral'} onClick={retry} busy={busy}>{t("Try again")}</Button>
    );
    const setUpAI = (
        <Button variant={retryFirst ? 'neutral' : 'primary'} onClick={() => navigate('/settings#ai')}>{t("Set up AI")}</Button>
    );
    return (
        <div className="flex-1 flex items-center justify-center px-6 py-12">
            <div className="text-center max-w-md">
                <AlertCircle className="w-10 h-10 text-slate-400 dark:text-slate-500 mx-auto mb-4" aria-hidden="true" />
                {/* Announced as it appears; the buttons are not part of the announcement. */}
                <div role="alert">
                    <p className="text-slate-700 dark:text-slate-200 font-medium">{t("This topic's lesson couldn't be written.")}</p>
                    {title && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 break-words">{title}</p>}
                    {why && <p className="mt-4 text-sm text-slate-600 dark:text-slate-300 break-words">{why}</p>}
                </div>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                    {retryFirst ? <>{setUpAI}{tryAgain}</> : <>{tryAgain}{setUpAI}</>}
                </div>
            </div>
        </div>
    );
}
