import MathText from '../MathText';
import { FOCUS_RING, cx } from '../ui/vocabulary';
import type { AnswerInputProps } from './AnswerInput';
import { useTranslation } from 'react-i18next';

const norm = (s: string) => s.toLowerCase().trim();

/** Past this, an option is prose and gets a row of its own. */
const COMPACT_CHARS = 32;

/**
 * Roughly how much an option will PAINT, which is not how long it is: four
 * fractions that fill four full-width rows are `$f_s\frac{v - v_{\text{run}}}
 * {v + v_{\text{train}}}$` in source, and half of that source is markup.
 *
 * So strip the delimiters, keep the word inside a `\text{…}`, and count every
 * other command as the one symbol it draws. A fraction is still counted as
 * numerator PLUS denominator although it paints them stacked — the error is
 * deliberately toward "this is prose", where the full-width row is right.
 */
const visualLength = (option: string) => option
    .replace(/\$+/g, '')
    .replace(/\\(?:text|textrm|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:displaystyle|limits|left|right|quad|qquad|[,;:!])/g, '')
    .replace(/\\[a-zA-Z]+/g, 'x')
    .replace(/[{}^_\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .length;

/**
 * Pick one: the multiple-choice tiles and the True / False pair. One component
 * because they are one interaction — the pair is a two-option choice laid out
 * side by side, and painting the verdict (key green, a wrong pick red, the rest
 * dimmed) is the same rule for both.
 *
 * Three paint states, in priority order: graded (the verdict), selected but
 * not yet graded (a quiz collecting answers — the accent), and idle.
 */
export default function ChoiceInput({ question, value, onChange, onCommit, disabled, result }: AnswerInputProps) {
    const { t } = useTranslation();
    const pair = question.type === 'true_false';
    const options = pair ? ['True', 'False'] : (question.options ?? []);

    /**
     * Short options go TWO to a row and centre themselves; prose keeps a
     * full-width row and reads from the left. Four formulas each given a
     * 580px row are four nearly-empty stripes, and the eye has to travel the
     * whole width to compare two things three characters apart.
     *
     * An odd count stays stacked: a last row holding one tile of a pair reads
     * as a layout that went wrong, and no real question has five options.
     *
     * The columns are CSS, not a breakpoint — this renders in the feed, in a
     * ~390px workspace panel and in a modal. `minmax(max(14rem, 48%), 1fr)`
     * says "two columns once each can be 14rem wide, and never three", because
     * three columns would need 144% of the width.
     */
    const twoUp = !pair && options.length >= 2 && options.length % 2 === 0
        && options.every(o => visualLength(o) <= COMPACT_CHARS);

    const paint = (option: string) => {
        if (result) {
            if (norm(option) === norm(question.correct_answer)) return 'border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-900/20';
            if (option === result.answer) return 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20';
            return 'border-slate-200 dark:border-slate-700 opacity-60';
        }
        if (value === option) return 'border-accent bg-accent/10';
        return 'border-slate-200 dark:border-slate-600 can-hover:hover:border-accent/60 can-hover:hover:bg-accent/5';
    };

    const choose = (option: string) => {
        if (disabled || result) return;
        onChange(option);
        onCommit?.(option);
    };

    return (
        <div
            className={cx(
                pair && 'flex gap-3',
                twoUp && 'grid gap-2 grid-cols-[repeat(auto-fit,minmax(max(14rem,48%),1fr))]',
                !pair && !twoUp && 'space-y-2',
            )}
            role="group"
        >
            {options.map((option, idx) => (
                <button
                    key={pair ? option : idx}
                    type="button"
                    onClick={() => choose(option)}
                    disabled={disabled || !!result}
                    aria-pressed={!result && value === option}
                    className={cx(
                        // The option is the thing being read and compared, so it
                        // is set at reading size, like the stem above it — at
                        // `text-sm` a KaTeX subscript inside one landed on the
                        // 12px floor (see tools/typography-gates.mjs).
                        'px-4 py-3 min-h-11 rounded-xl border-2 transition text-base text-slate-700 dark:text-slate-200',
                        pair && 'flex-1 font-medium',
                        // Centred, and centred on the tile's full height: two
                        // tiles in a row are the same height, and a one-line
                        // option beside a two-line one must not float at its top.
                        twoUp && 'w-full flex items-center justify-center text-center',
                        !pair && !twoUp && 'w-full text-left',
                        'disabled:cursor-default',
                        FOCUS_RING,
                        paint(option),
                    )}
                >
                    {/* The label is translated, the OPTION is not: `option` is
                        the value that reaches onChange and is compared against
                        correct_answer, so translating it would grade a Russian
                        reader's "Верно" against the key "True". */}
                    {pair
                        ? (option === 'True' ? t("True") : t("False"))
                        : <MathText content={option} />}
                </button>
            ))}
        </div>
    );
}
