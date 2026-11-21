import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QuizQuestion } from '../../types';
import { useStore } from '../../store';
import { cx, FOCUS_RING } from '../ui/vocabulary';
import { spellingSlipOf } from './formats';

/**
 * Under a typed answer marked wrong that `forgive_spelling` would have marked
 * right: the switch, offered where the learner meets the problem instead of
 * three screens away in Settings. Turning it on counts from the next answer;
 * this one stays as it was graded.
 *
 * Not offered in a course that teaches a language (`learning_language`): there
 * the spelling is what is being learned. Not offered once the switch is on, or
 * for any answer that is not a near miss (`spellingSlipOf` is null).
 */
export default function SpellingOffer({ question, answer, projectId, className = '' }: {
    question: QuizQuestion;
    answer: string;
    projectId?: number | null;
    className?: string;
}) {
    const { t } = useTranslation();
    const on = useStore(s => s.forgiveSpelling);
    const setOn = useStore(s => s.setForgiveSpelling);
    const teachesLanguage = useStore(s => !!(projectId != null && s.projects.find(p => p.id === projectId)?.learning_language));
    // Stays shown after the press, to say what changed.
    const [turnedOn, setTurnedOn] = useState(false);
    if (teachesLanguage || (on && !turnedOn) || !answer || spellingSlipOf(question, answer) === null) return null;
    const line = cx('text-sm text-slate-600 dark:text-slate-400', className);
    // One live region for both lines, like the report line beside it.
    if (turnedOn) {
        return <p aria-live="polite" className={line} data-spelling-offer="on">{t("Small spelling slips now count as right. You can turn this off in Settings, under Learning.")}</p>;
    }
    return (
        <p aria-live="polite" className={line} data-spelling-offer>
            {t("Only a letter or two off.")}{' '}
            <button
                type="button"
                data-link="forgive-spelling"
                onClick={() => { setTurnedOn(true); void setOn(true); }}
                className={cx('-my-0.5 inline-block rounded py-0.5 font-medium text-accent-fg underline underline-offset-2 can-hover:hover:decoration-2 touch:-my-3 touch:py-3', FOCUS_RING)}
            >
                {t("Forgive small spelling slips from now on")}
            </button>
        </p>
    );
}
