import { useLayoutEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import MathText from '../MathText';
import { FOCUS_RING, cx } from '../ui/vocabulary';
import type { AnswerInputProps } from './AnswerInput';
import { useTranslation } from 'react-i18next';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';
import { choiceColumns } from './choiceLayout';

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
 *
 * Used only until the options have been MEASURED (the first frame, and jsdom).
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
 * side by side, and painting the verdict (key green with a tick, a wrong pick
 * red with a cross, the rest dimmed) is the same rule for both.
 *
 * Three paint states, in priority order: graded (the verdict), selected but
 * not yet graded (a quiz collecting answers — the accent), and idle.
 */
export default function ChoiceInput({ question, value, onChange, onCommit, disabled, result }: AnswerInputProps) {
    const { t } = useTranslation();
    const pair = question.type === 'true_false';
    const options = pair ? ['True', 'False'] : (question.options ?? []);

    // The group's width and the widest option's one-line width, both measured.
    // A hidden copy of the options, unwrapped, is what gets measured: the real
    // tiles' widths are the layout's OUTPUT, so measuring them would loop.
    const groupRef = useRef<HTMLDivElement>(null);
    const measureRef = useRef<HTMLDivElement>(null);
    const groupPx = useElementWidth(groupRef);
    const rootPx = useRootFontSize();
    const [widestPx, setWidestPx] = useState(0);
    const optionsKey = options.join('\u0000');
    useLayoutEffect(() => {
        if (pair) return;
        const measure = () => {
            const spans = measureRef.current?.querySelectorAll<HTMLElement>('[data-measure]') ?? [];
            let widest = 0;
            spans.forEach(s => { widest = Math.max(widest, s.getBoundingClientRect().width); });
            setWidestPx(Math.ceil(widest));
        };
        measure();
        // KaTeX's fonts can land after the first paint and change every width.
        let live = true;
        document.fonts?.ready.then(() => { if (live) measure(); });
        return () => { live = false; };
    }, [pair, optionsKey, rootPx]);

    /**
     * Measured: `choiceColumns`. Not yet measured (the first frame, jsdom):
     * short options two to a row through CSS (`minmax(max(14rem, 48%), 1fr)`,
     * two columns once each can be 14rem, never three), prose stacked.
     */
    const measured = !pair && groupPx > 0 && widestPx > 0;
    const columns = measured ? choiceColumns(options.length, widestPx, groupPx, rootPx) : 0;
    const cssTwoUp = !pair && !measured && options.length >= 2 && options.length % 2 === 0
        && options.every(o => visualLength(o) <= COMPACT_CHARS);
    const tiled = columns > 1 || cssTwoUp;

    const keyOf = (option: string) => !!result && norm(option) === norm(question.correct_answer);
    const missOf = (option: string) => !!result && !keyOf(option) && option === result.answer;

    const paint = (option: string) => {
        if (result) {
            if (keyOf(option)) return 'border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-900/20';
            if (missOf(option)) return 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20';
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
        <div className="relative">
            {!pair && (
                <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 -z-10 h-0 w-0 overflow-hidden whitespace-nowrap text-base">
                    {options.map((option, idx) => (
                        <span key={idx} data-measure className="inline-block"><MathText content={option} /></span>
                    ))}
                </div>
            )}
            <div
                ref={groupRef}
                className={cx(
                    pair && 'flex gap-3',
                    columns > 1 && 'grid gap-2',
                    cssTwoUp && 'grid gap-2 grid-cols-[repeat(auto-fit,minmax(max(14rem,48%),1fr))]',
                    !pair && !tiled && 'space-y-2',
                )}
                style={columns > 1 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
                data-columns={pair ? 2 : columns || (cssTwoUp ? 'css' : 1)}
                role="group"
            >
                {options.map((option, idx) => {
                    const isKey = keyOf(option);
                    const isMiss = missOf(option);
                    return (
                        <button data-answer-option
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
                                'flex items-center gap-2',
                                pair && 'flex-1 justify-center font-medium',
                                // Centred, and centred on the tile's full height: tiles in a
                                // row are the same height, and a one-line option beside a
                                // two-line one must not float at its top.
                                tiled && 'w-full justify-center text-center',
                                !pair && !tiled && 'w-full text-left',
                                'disabled:cursor-default',
                                FOCUS_RING,
                                paint(option),
                            )}
                        >
                            {/* The verdict is said in shape and words too, not only
                                colour: a tick on the key, a cross on a wrong pick. */}
                            {isKey && <Check className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />}
                            {isMiss && <X className="w-4 h-4 shrink-0 text-red-700 dark:text-red-400" aria-hidden="true" />}
                            {isKey && <span className="sr-only">{t("Correct answer:")}</span>}
                            {isMiss && <span className="sr-only">{t("Your answer:")}</span>}
                            {/* The label is translated, the OPTION is not: `option` is
                                the value that reaches onChange and is compared against
                                correct_answer, so translating it would grade a Russian
                                reader's "Верно" against the key "True". */}
                            <span className="min-w-0">
                                {pair
                                    ? (option === 'True' ? t("True") : t("False"))
                                    : <MathText content={option} />}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
