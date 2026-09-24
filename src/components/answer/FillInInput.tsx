import { useTranslation } from 'react-i18next';
import { FIELD_BASE, cx } from '../ui/vocabulary';
import type { AnswerInputProps } from './AnswerInput';

/**
 * The answer, typed, when it has one definite written form: the missing word,
 * the verb form, the article, the sentence that was dictated.
 *
 * Deliberately NOT the prose box `short_answer` uses. That one grows to 400px
 * because a derivation is several lines; this one is a single line, because the
 * shape of the field is the clearest statement of what is wanted. A five-row
 * textarea under "Wij komen ___ 9.45 uur" invites a paragraph and gets a
 * paragraph, and then the exact-match grader — which is the whole point of this
 * format — marks it wrong.
 *
 * Three decisions it shares with `NumericInput`, for the same reasons:
 * a graded answer is READ-ONLY rather than disabled (the learner is comparing
 * their own words with the key right beside them, and `disabled` dims theirs to
 * 45%); the field is `h-11`, the touch height every control here uses; and it
 * is one line.
 *
 * And one of its own: every autocorrect the platform offers is OFF. A phone
 * keyboard capitalising the first letter is harmless — capitals are not graded
 * — but autocorrect rewriting a Dutch word the learner spelled correctly into
 * an English one is a wrong verdict the learner cannot see coming, on the one
 * format where spelling IS the answer.
 */
export default function FillInInput({ value, onChange, disabled, result, autoFocus }: AnswerInputProps) {
    const { t } = useTranslation();
    const shown = result ? result.answer : value;
    return (
        <input
            type="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the surface asks
            // for this only when the learner has just opened a question to type in.
            autoFocus={autoFocus}
            value={shown}
            onChange={e => onChange(e.target.value)}
            disabled={disabled && !result}
            readOnly={!!result}
            placeholder={t("Type your answer…")}
            aria-label={t("Your answer")}
            className={cx(
                FIELD_BASE,
                'w-full h-11 px-3.5 text-base',
                result && 'bg-slate-50 dark:bg-slate-800 cursor-default',
            )}
        />
    );
}
