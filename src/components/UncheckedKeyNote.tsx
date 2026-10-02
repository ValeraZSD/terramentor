import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QuizQuestion } from '../types';

/**
 * Did a verifier get asked about this question and fail to confirm it? The
 * server stamps the stored question (`unverified`, server/questionTrust.js)
 * and writes no mastery evidence from its answer, so every surface that asks
 * it marks the question unchecked before the learner answers. The stamp is not on the shared
 * `QuizQuestion` type because only this module reads it on the client.
 */
export const isUnchecked = (q: QuizQuestion | null | undefined): boolean =>
    !!(q as (QuizQuestion & { unverified?: unknown }) | null | undefined)?.unverified;

/**
 * How a sitting names one question it asked, for the server to find it again
 * in the stored bank. By its `uuid` (every bank question gets one from the
 * database): the server splices a disputed question out of a bank in the
 * background, so the position this copy was drawn at can point at the next
 * question along by the time the answers arrive, putting a stamped question's
 * answer in a checked one's place. The stem goes only when there is no
 * uuid, so the server can refuse a position that now holds another question.
 */
export interface AskedEntry {
    quizId?: number;
    index: number;
    uuid?: string;
    stem?: string;
    ghost?: boolean;
    ghostNodeId?: number;
    correct: boolean;
}

export const askedEntry = (
    q: QuizQuestion & { index: number; quizId?: number; ghostNodeId?: number },
    correct: boolean,
): AskedEntry => {
    const uuid = (q as QuizQuestion & { uuid?: unknown }).uuid;
    return {
        ...(q.quizId != null ? { quizId: q.quizId } : {}),
        index: q.index,
        ...(typeof uuid === 'string' && uuid ? { uuid } : { stem: q.question }),
        ...(q.isGhost ? { ghost: true, ghostNodeId: q.ghostNodeId } : {}),
        correct,
    };
};

/**
 * The one wording for a stamped question, drawn under its stem by the feed's
 * question card and by a practice quiz. `className` places it; the text, the
 * icon and the colour are the same everywhere.
 */
export default function UncheckedKeyNote({ className = '' }: { className?: string }) {
    const { t } = useTranslation();
    return (
        <p className={`flex items-start gap-1.5 text-sm text-slate-500 dark:text-slate-400 ${className}`}>
            <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            {t("Answer key not checked yet. Practice only: this answer does not count toward mastery.")}
        </p>
    );
}
