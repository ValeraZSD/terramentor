import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LessonWrite } from '../../types';
import { plainCause } from '../../utils/failureCause';

/**
 * The slot of a topic's first lesson on its own page, while the writer is on
 * it (`lessonSlot`, utils/feedPlacement.ts). It holds the page still: no End
 * of chapter and no junction come while it says "writing", and the lesson
 * takes its place when it lands. A failed write says so, and why (in plain
 * words where the cause is recognisable, the model's own words otherwise),
 * and the chapter ends as it would without it.
 */
export default function LessonSlot({ write }: { write: LessonWrite }) {
    const { t } = useTranslation();
    if (write.state === 'failed') {
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
    return (
        <p role="status" className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <Loader2 className="w-4 h-4 animate-spin shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
            {t("Writing this topic's lesson. It will appear here.")}
        </p>
    );
}
