import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { RUNNER_LIMITS } from '../../../server/runnerFrame.js';
import { LANGUAGE_NAME, MEMORY_MB } from '../../runner/languages';
import { OUTPUT_MAX } from '../../runner/protocol';
import type { CodeTest, RunResult, RunnerLanguage } from '../../runner/protocol';

/**
 * What running a learner's code produced, under the editor (`CodeInput`).
 *
 * Two moments: after Run, the program's own output (and the value of the
 * question's first call, which is what Run feeds it); after Check, one row
 * per test, the reference's result beside the learner's. A run that was
 * stopped says why in a sentence, as a fact about the code, never as an
 * alarm: an endless loop is a normal mistake while learning.
 */

const SECTION = 'border-t border-slate-200 dark:border-slate-700 px-3 py-2';
const MONO = 'font-mono text-[0.85rem] leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words';
const MUTED = 'text-sm text-slate-600 dark:text-slate-400';
const LABEL = 'text-xs font-medium text-slate-500 dark:text-slate-400';

const OUT_OF_MEMORY = /^(MemoryError\b|\w*Error: out of memory)/;

/** Why a run ended without an answer to show, or null when it simply finished. */
export function stoppedLine(t: TFunction, run: RunResult, language: RunnerLanguage): string | null {
    const name = LANGUAGE_NAME[language];
    const starting = run.phase === 'load' || run.phase === 'idle';
    const memory = () => t("Stopped: your code used more than {{mb}} MB of memory.", { mb: MEMORY_MB[language] });
    // The ceiling usually surfaces inside the language, as its own error
    // (Python's MemoryError, QuickJS's "out of memory"), and the run still
    // ends normally: the bare error name alone tells a learner nothing.
    if (run.status === 'done') return OUT_OF_MEMORY.test(run.error ?? '') ? memory() : null;
    if (run.status === 'unavailable' || starting) return t("{{language}} could not start here, so your code was not run.", { language: name });
    if (run.status === 'timeout') return t("Stopped after {{seconds}} seconds. Is there a loop that never ends?", { seconds: RUNNER_LIMITS.runMs / 1000 });
    if (run.status === 'memory') return memory();
    if (run.status === 'flood') return t("Stopped: your code sent too many messages.");
    return t("The runner stopped unexpectedly. Try again.");
}

/** While a run is under way: the runtime starting (Python takes a few seconds the first time), then the code. */
export function RunPending({ starting, language }: { starting: boolean; language: RunnerLanguage }) {
    const { t } = useTranslation();
    return (
        <div className={SECTION} role="status" aria-live="polite">
            <p className={MUTED}>{starting ? t("Starting {{language}}…", { language: LANGUAGE_NAME[language] }) : t("Running…")}</p>
        </div>
    );
}

/** After Run: what the program printed, the first call's value, the error it stopped with. */
export function RunOutput({ run, test, language }: { run: RunResult; test?: CodeTest; language: RunnerLanguage }) {
    const { t } = useTranslation();
    const stopped = stoppedLine(t, run, language);
    const output = run.output ?? '';
    const valueLine = run.value !== undefined && test?.call ? `${test.call} → ${run.value}` : '';
    const nothing = !stopped && !output && !valueLine && !run.error;
    return (
        <section className={SECTION} aria-label={t("Output")} aria-live="polite">
            <p className={LABEL}>{t("Output")}</p>
            {typeof test?.stdin === 'string' && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t("Input")}: <span className="font-mono">{test.stdin.replace(/\n+$/, '').replace(/\n/g, ' ⏎ ') || t("(empty)")}</span>
                </p>
            )}
            {(output || valueLine || run.error) && (
                <pre className={`mt-1 max-h-60 overflow-auto ${MONO}`}>
                    {output}
                    {valueLine && <>{output && !output.endsWith('\n') ? '\n' : ''}{valueLine}</>}
                    {run.error && (
                        <span className="text-red-700 dark:text-red-300">{output || valueLine ? '\n' : ''}{run.error}</span>
                    )}
                </pre>
            )}
            {output.length >= OUTPUT_MAX && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("More than 64 KB of output")}</p>}
            {nothing && <p className={`mt-1 ${MUTED}`}>{t("Nothing was printed.")}</p>}
            {stopped && <p className={`mt-1 ${MUTED}`}>{stopped}</p>}
        </section>
    );
}

/** One side of a row: the value, the printed text, or that there was none. */
function Shown({ text, over, kind }: { text: string; over?: boolean; kind: 'call' | 'stdin' }) {
    const { t } = useTranslation();
    if (over) return <span className="font-sans text-sm text-slate-500 dark:text-slate-400">{t("More than 64 KB of output")}</span>;
    if (!text && kind === 'stdin') return <span className="font-sans text-sm text-slate-500 dark:text-slate-400">{t("Nothing was printed.")}</span>;
    return <>{text}</>;
}

/** After Check: one row per test, in the question's order. */
export function TestRows({ run, language }: { run: RunResult; language: RunnerLanguage }) {
    const { t } = useTranslation();
    const rows = run.tests ?? [];
    const stopped = stoppedLine(t, run, language);
    if (!rows.length) {
        return stopped ? <div className={SECTION}><p className={MUTED}>{stopped}</p></div> : null;
    }
    const passed = rows.filter((r) => r.pass).length;
    return (
        <section className={SECTION} aria-label={t("Tests")}>
            <p className={LABEL}>{t("Tests passed: {{passed}} of {{total}}", { passed, total: rows.length })}</p>
            <ul className="mt-1.5 space-y-2">
                {rows.map((row, i) => (
                    <li key={i} className="flex items-start gap-2">
                        {row.pass
                            ? <Check className="mt-1 w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label={t("Passed")} />
                            : <X className="mt-1 w-4 h-4 shrink-0 text-red-600 dark:text-red-400" aria-label={t("Failed")} />}
                        <div className={`min-w-0 flex-1 ${MONO}`}>
                            {row.kind === 'call'
                                ? <span>{row.input}</span>
                                : <span><span className="font-sans text-xs text-slate-500 dark:text-slate-400">{t("Input")}: </span>{row.input.replace(/\n+$/, '').replace(/\n/g, ' ⏎ ') || t("(empty)")}</span>}
                            {row.pass ? (
                                <span className="text-slate-600 dark:text-slate-400"> → <Shown text={row.actual} kind={row.kind} /></span>
                            ) : (
                                <dl className="mt-0.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
                                    <dt className="font-sans text-xs leading-6 text-slate-500 dark:text-slate-400">{t("Expected")}</dt>
                                    <dd><Shown text={row.expected} kind={row.kind} /></dd>
                                    <dt className="font-sans text-xs leading-6 text-slate-500 dark:text-slate-400">{t("Got")}</dt>
                                    <dd><Shown text={row.actual} over={row.over} kind={row.kind} /></dd>
                                </dl>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    );
}
