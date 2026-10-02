import { useTranslation } from 'react-i18next';
import { FIELD_BASE, cx } from '../ui/vocabulary';
import { prettyUnit } from './formats';
import type { AnswerInputProps } from './AnswerInput';

/**
 * One number, typed.
 *
 * Three decisions worth keeping:
 *
 *  * **The unit is furniture, not an answer.** It sits at the right edge of the
 *    field, greyed, outside the tab order and outside the value. A learner who
 *    can work out 9.81 m/s² should not lose the mark to a superscript, and no
 *    string comparison can agree that "m/s^2" and "m/s²" are the same unit. The
 *    server never grades it either (`answerFormats.js`).
 *  * **`inputMode="decimal"`, not `type="number"`.** A number input silently
 *    discards what it cannot parse, so a decimal comma — which is how half this
 *    library's material writes it — vanishes as the learner types, and the
 *    spinner arrows invite nudging an answer rather than computing one. This
 *    is a text field that summons a numeric keypad on a phone; the parser
 *    decides what the text means.
 *  * **One line, not the prose box.** A short answer grows because a
 *    derivation is several lines; a number is never more than one, and a
 *    five-line box asking for "9.81" tells the learner to write an essay.
 */
export default function NumericInput({ question, value, onChange, disabled, result }: AnswerInputProps) {
    const { t } = useTranslation();
    const shown = result ? result.answer : value;
    const unit = prettyUnit(question.unit).trim();
    return (
        <div className="relative max-w-xs">
            <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={shown}
                onChange={e => onChange(e.target.value)}
                // A graded answer is READ-ONLY, not DISABLED. `disabled` dims the
                // field to 45% (FIELD_BASE), and what it dims is the number the
                // learner typed — sitting right beside the key they are being
                // asked to compare it against. Read-only keeps it legible and
                // selectable, and still accepts nothing.
                disabled={disabled && !result}
                readOnly={!!result}
                placeholder={t("Your answer")}
                aria-label={unit ? t("Your answer, in {{unit}}", { unit }) : t("Your answer")}
                className={cx(
                    FIELD_BASE,
                    'w-full h-11 pl-3.5 text-base tabular-nums',
                    // Room for the unit, so a long answer scrolls under it
                    // rather than running through it.
                    unit ? 'pr-20' : 'pr-3.5',
                    // Settled: the field stops inviting a caret, but stays read.
                    result && 'bg-slate-50 dark:bg-slate-800 cursor-default',
                )}
            />
            {unit && (
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 max-w-[4.5rem] truncate text-sm text-slate-500 dark:text-slate-400"
                >
                    {unit}
                </span>
            )}
        </div>
    );
}
