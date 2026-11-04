import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LessonWrite } from '../../types';
import { plainCause } from '../../utils/failureCause';

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
 * The slot of a topic's first lesson in its chapter, once the write failed
 * (`lessonSlot`): it says so, and why (in plain words where the cause is
 * recognisable, the model's own words otherwise), and the chapter ends as it
 * would without it.
 */
export default function LessonSlot({ write }: { write: LessonWrite }) {
    const { t } = useTranslation();
    if (write.state !== 'failed') return null;
    const cause = write.reason
        ? plainCause({ message: write.reason, httpStatus: write.httpStatus ?? null, model: write.model ?? null })
        : null;
    const why = cause ? t(cause.messageKey, cause.params) : write.reason;
    return (
        <div className="text-sm">
            <p className="text-slate-700 dark:text-slate-200">{t("This topic's lesson couldn't be written.")}</p>
            {why && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 break-words">{why}</p>
            )}
        </div>
    );
}
