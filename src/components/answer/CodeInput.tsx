import { lazy, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { useStore, isDarkTheme } from '../../store';
import { usePhysicalKeyboard } from '../../utils/platform';
import { IconButton } from '../ui/Button';
import { cx } from '../ui/vocabulary';
import type { AnswerInputProps } from './AnswerInput';

const CodeEditor = lazy(() => import('./CodeEditor'));

/**
 * The learner writes code. A real editor — line numbers, bracket matching,
 * indentation that follows the language, live highlighting in the language
 * the question names — inside the same field chrome as a read-side code block,
 * so a solution looks like the examples it was taught from.
 *
 * Until the editor chunk arrives (a few hundred milliseconds the first time,
 * then cached), a plain monospaced textarea holds the same controlled value:
 * typing never waits for the bundle, and the text carries over when the
 * editor mounts. The starter code, when the question has one, is the initial
 * value; "Start over" puts it back.
 */
export default function CodeInput({ question, value, onChange, disabled, result, autoFocus }: AnswerInputProps) {
    const { t } = useTranslation();
    const dark = isDarkTheme(useStore(s => s.theme));
    const keyboard = usePhysicalKeyboard();
    const language = (question.language || '').toLowerCase();
    const starter = question.starter || '';
    const locked = disabled || !!result;
    const shown = result ? result.answer : value;

    // The starter is the draft's INITIAL value, seeded once on mount — so a
    // learner who deletes it is not fighting a prop that keeps writing it back.
    // An effect, not a render-time call: the draft lives in the parent, and
    // setting a parent's state while rendering its child is the one thing
    // React forbids outright.
    useEffect(() => {
        if (!result && !value && starter) onChange(starter);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fallback = (
        <textarea
            value={shown}
            onChange={e => onChange(e.target.value)}
            disabled={locked}
            spellCheck={false}
            aria-label={t("Your code")}
            placeholder={t("Write your solution here…")}
            className="w-full min-h-[8.5rem] px-3 py-3 bg-transparent font-mono text-[0.85rem] leading-relaxed text-slate-800 dark:text-slate-200 resize-y outline-none"
        />
    );

    return (
        <div className={cx(
            'rounded-xl border overflow-hidden bg-slate-50 dark:bg-slate-900 transition-colors',
            result
                ? (result.correct ? 'border-emerald-400 dark:border-emerald-600' : 'border-red-400 dark:border-red-600')
                : 'border-slate-200 dark:border-slate-600 focus-within:ring-2 focus-within:ring-accent/60',
        )}>
            <div className="flex items-center justify-between gap-2 px-3 py-1 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-600 dark:text-slate-400">
                <span className="lowercase">{language || t("code")}</span>
                {!locked && starter && value !== starter && (
                    <IconButton
                        size="sm"
                        variant="quiet"
                        label={t("Start over from the given code")}
                        icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />}
                        onClick={() => onChange(starter)}
                    />
                )}
            </div>
            <Suspense fallback={fallback}>
                <CodeEditor
                    value={shown}
                    onChange={onChange}
                    language={language}
                    readOnly={locked}
                    dark={dark}
                    placeholder={t("Write your solution here…")}
                    autoFocus={autoFocus && !locked}
                />
            </Suspense>
            {keyboard && !locked && (
                <p className="px-3 py-1 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
                    {t("Tab indents; Esc then Tab leaves the editor.")}
                </p>
            )}
        </div>
    );
}
