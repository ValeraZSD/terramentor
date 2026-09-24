import { useTranslation } from 'react-i18next';
import { useAutoGrow } from '../../hooks/useAutoGrow';
import { FOCUS_RING, cx } from '../ui/vocabulary';
import type { AnswerInputProps } from './AnswerInput';

/**
 * A short written answer. Grows with what is typed (a worked derivation is
 * routinely several lines, and a fixed three-row box made it a peephole over
 * the learner's own work), up to a ceiling past which it scrolls so it can
 * never push the Check button off the screen.
 */
export default function TextAnswerInput({ value, onChange, disabled, result }: AnswerInputProps) {
    const { t } = useTranslation();
    const shown = result ? result.answer : value;
    const ref = useAutoGrow(shown, 400);
    return (
        <textarea
            ref={ref}
            value={shown}
            onChange={e => onChange(e.target.value)}
            disabled={disabled || !!result}
            placeholder={t("Type your answer…")}
            rows={1}
            aria-label={t("Your answer")}
            // `min-h` rather than `rows`: the hook writes an explicit height, and
            // CSS min-height still wins over it, so the box opens three lines
            // tall and only ever grows.
            className={cx(
                'w-full px-4 py-3 min-h-[5.5rem] rounded-xl border border-slate-200 dark:border-slate-600',
                'bg-white dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200 resize-none',
                'disabled:opacity-70 disabled:cursor-default',
                FOCUS_RING,
            )}
        />
    );
}
