import { useRef, useState } from 'react';
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
 * Offered only in a course the store knows that does not teach a language
 * (`learning_language`): there the spelling is what is being learned, and a
 * course not loaded yet might be one. Not offered once the switch is on, or
 * for any answer that is not a near miss (`spellingSlipOf` is null). The
 * caller leaves it out where the setting does not apply (a mock exam).
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
    const plainCourse = useStore(s => {
        const p = projectId != null ? s.projects.find(x => x.id === projectId) : undefined;
        return !!p && !p.learning_language;
    });
    // Pressed here: the line then says what changed, while the store holds
    // the setting. A save that failed puts the store back, and the offer with it.
    const [pressed, setPressed] = useState(false);
    const focusLine = useRef(false);
    const confirmed = pressed && on;
    // The save failed and the offer is back: a later turn-on from elsewhere
    // must not pull focus to this line.
    if (pressed && !on) focusLine.current = false;
    if (!plainCourse || (on && !pressed) || !answer || spellingSlipOf(question, answer) === null) return null;
    const line = cx('text-sm text-slate-600 dark:text-slate-400', className);
    // One live region for both lines, like the report line beside it. The
    // pressed button leaves the page, so focus moves to the line that replaced it.
    if (confirmed) {
        return (
            <p aria-live="polite" className={cx(line, 'outline-none')} data-spelling-offer="on" tabIndex={-1}
                ref={el => { if (el && focusLine.current) { focusLine.current = false; el.focus(); } }}
            >
                {t("Small spelling slips now count as right. You can turn this off in Settings, under Learning.")}
            </p>
        );
    }
    return (
        <p aria-live="polite" className={line} data-spelling-offer>
            {t("Only a letter or two off.")}{' '}
            <button
                type="button"
                data-link="forgive-spelling"
                onClick={() => { focusLine.current = true; setPressed(true); void setOn(true); }}
                className={cx('-my-0.5 inline-block rounded py-0.5 font-medium text-accent-fg underline underline-offset-2 can-hover:hover:decoration-2 touch:-my-3 touch:py-3', FOCUS_RING)}
            >
                {t("Forgive small spelling slips from now on")}
            </button>
        </p>
    );
}
