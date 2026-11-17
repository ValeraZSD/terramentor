import { useTranslation } from 'react-i18next';
import type { QuizQuestion } from '../../types';
import { spellingSlipOf } from './formats';

/**
 * Under a typed answer marked right because a spelling slip was forgiven
 * (the `forgive_spelling` setting): the spelling it should have had. Marked
 * right without this line, the learner would keep the slip and learn it.
 * Renders nothing for an exact answer or any other format.
 */
export default function SpellingNote({ question, answer, className = '' }: { question: QuizQuestion; answer: string; className?: string }) {
    const { t } = useTranslation();
    const spelled = spellingSlipOf(question, answer);
    if (!spelled) return null;
    return (
        <p className={`text-sm text-slate-600 dark:text-slate-300 ${className}`} data-spelling-note>
            {t("Accepted with a spelling slip. It is spelled:")}{' '}
            <span className="font-semibold text-slate-800 dark:text-slate-100">{spelled}</span>
        </p>
    );
}
