import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, RotateCcw } from 'lucide-react';
import { useStore, isDarkTheme } from '../../store';
import { usePhysicalKeyboard } from '../../utils/platform';
import { Button, IconButton } from '../ui/Button';
import { cx } from '../ui/vocabulary';
import { codeTestsOf, runnableLanguage } from '../../runner/languages';
import { loadRunner } from '../../runner/load';
import type { RunResult } from '../../runner/protocol';
import { RunOutput, RunPending, TestRows } from './CodeRunPanel';
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
 *
 * Python and JavaScript also RUN, on this device (src/runner/): Run shows what
 * the learner's code prints for the question's first input, and after Check
 * the rows say which tests matched the reference. Nothing here grades; the
 * verdict comes from `gradeAnswer`, and arrives as `result.run`.
 */
export default function CodeInput({ question, value, onChange, disabled, result, autoFocus }: AnswerInputProps) {
    const { t } = useTranslation();
    const dark = isDarkTheme(useStore(s => s.theme));
    const runnerOn = useStore(s => s.codeRunner);
    const keyboard = usePhysicalKeyboard();
    const language = (question.language || '').toLowerCase();
    const starter = question.starter || '';
    const locked = disabled || !!result;
    const shown = result ? result.answer : value;
    const runnable = runnerOn ? runnableLanguage(question.language) : null;
    const [running, setRunning] = useState<'starting' | 'running' | null>(null);
    const [ran, setRan] = useState<RunResult | null>(null);
    const warmed = useRef(false);

    // Writing Python starts the runtime in the background (a few seconds,
    // once), so the first Run or Check does not wait for it.
    const edit = (next: string) => {
        onChange(next);
        if (runnable === 'python' && !warmed.current && next !== starter) {
            warmed.current = true;
            void loadRunner().then((m) => m.warmRunner('python', 0)).catch(() => { /* Run starts its own */ });
        }
    };

    const run = async () => {
        if (!runnable || running || !value.trim()) return;
        setRunning('running');
        let outcome: RunResult;
        try {
            const { runCode } = await loadRunner();
            outcome = await runCode(runnable, value, codeTestsOf(question.tests), (p) => {
                if (p === 'starting') setRunning('starting');
                else if (p === 'learner') setRunning('running');
            });
        } catch (err) {
            outcome = { status: 'unavailable', phase: 'load', error: String((err as Error)?.message ?? err) };
        }
        setRan(outcome);
        setRunning(null);
    };
    const firstTest = codeTestsOf(question.tests)[0];

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
            onChange={e => edit(e.target.value)}
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
                {!locked && ((starter && value !== starter) || runnable) && (
                    <div className="flex items-center gap-1">
                        {starter && value !== starter && (
                            <IconButton
                                size="sm"
                                variant="quiet"
                                label={t("Start over from the given code")}
                                icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />}
                                onClick={() => onChange(starter)}
                            />
                        )}
                        {runnable && (
                            <Button
                                size="sm"
                                variant="neutral"
                                icon={<Play className="w-3.5 h-3.5" aria-hidden="true" />}
                                busy={!!running}
                                disabled={!value.trim()}
                                onClick={() => void run()}
                                className="font-sans"
                            >
                                {t("Run")}
                            </Button>
                        )}
                    </div>
                )}
            </div>
            <Suspense fallback={fallback}>
                <CodeEditor
                    value={shown}
                    onChange={edit}
                    language={language}
                    readOnly={locked}
                    dark={dark}
                    placeholder={t("Write your solution here…")}
                    autoFocus={autoFocus && !locked}
                />
            </Suspense>
            {/* After Check, the tests; before it, the last Run. */}
            {result?.run && runnableLanguage(question.language) ? (
                <TestRows run={result.run} language={runnableLanguage(question.language)!} />
            ) : !result && runnable && running ? (
                <RunPending starting={running === 'starting'} language={runnable} />
            ) : !result && runnable && ran ? (
                <RunOutput run={ran} test={firstTest} language={runnable} />
            ) : null}
            {keyboard && !locked && (
                <p className="px-3 py-1 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
                    {t("Tab indents; Esc then Tab leaves the editor.")}
                </p>
            )}
        </div>
    );
}
