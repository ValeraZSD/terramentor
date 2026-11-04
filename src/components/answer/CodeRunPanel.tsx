import { Fragment } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { RUNNER_LIMITS } from '../../../server/runnerFrame.js';
import { LANGUAGE_NAME, MEMORY_MB } from '../../runner/languages';
import { OUTPUT_MAX } from '../../runner/protocol';
import type { CodeTest, RunResult, RunnerLanguage } from '../../runner/protocol';
import { cx } from '../ui/vocabulary';
import { diffChars, type DiffPart } from './charDiff';

/**
 * What running a learner's code produced, under the editor (`CodeInput`).
 *
 * Two moments: after Run, the program's own output (and the value of the
 * question's first call, which is what Run feeds it); after Check, how many
 * tests passed, and when one failed a line per test, with the expected result
 * under each failed one. A run that was
 * stopped says why in a sentence, as a fact about the code, never as an
 * alarm: an endless loop is a normal mistake while learning.
 */

const SECTION = 'border-t border-slate-200 dark:border-slate-700 px-3 py-2';
const MONO = 'font-mono text-[0.85rem] leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words';
const MUTED = 'text-sm text-slate-600 dark:text-slate-400';
const LABEL = 'text-xs font-medium text-slate-500 dark:text-slate-400';

/** A typed input on one line: line breaks as ↵. */
const inputLine = (input: string) => input.replace(/\n+$/, '').replace(/\n/g, ' ↵ ');

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
    const call = run.value !== undefined && test?.call ? test.call : '';
    const printed = Boolean(output || run.error);
    const nothing = !stopped && !printed && !call;
    return (
        <section className={SECTION} aria-label={t("Output")} aria-live="polite">
            {(printed || !call) && <p className={LABEL}>{t("Output")}</p>}
            {typeof test?.stdin === 'string' && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t("Input")}: <span className="font-mono">{inputLine(test.stdin) || t("(empty)")}</span>
                </p>
            )}
            {printed && (
                <pre className={`mt-1 max-h-60 overflow-auto ${MONO}`}>
                    {output}
                    {run.error && (
                        <span className="text-red-700 dark:text-red-300">{output ? '\n' : ''}{run.error}</span>
                    )}
                </pre>
            )}
            {/* What the call returned, named, apart from what the code printed
                on the way, in the same "call → value" form as the test rows. */}
            {call && (
                <>
                    <p className={cx(LABEL, printed && 'mt-2')}>{t("Return value")}</p>
                    <p className={cx('mt-1', MONO)}>
                        {call} <span className="text-slate-400 dark:text-slate-500" aria-hidden="true">→</span> {run.value}
                    </p>
                </>
            )}
            {output.length >= OUTPUT_MAX && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("More than 64 KB of output")}</p>}
            {nothing && <p className={`mt-1 ${MUTED}`}>{t("Nothing was printed.")}</p>}
            {stopped && <p className={`mt-1 ${MUTED}`}>{stopped}</p>}
        </section>
    );
}

// A mark shows where the two sides differ by an underline as well as a fill,
// so the cue does not rest on colour alone: a pale fill on a tinted row is
// close to invisible to many eyes.
const MARK = {
    got: 'bg-red-100 decoration-red-500 dark:bg-red-500/40 dark:decoration-red-400',
    expected: 'bg-emerald-100 decoration-emerald-600 dark:bg-emerald-500/30 dark:decoration-emerald-400',
} as const;

/** One side of a row: the value, the printed text, or that there was none. */
function Shown({ text, over, kind, parts, tone }: {
    text: string;
    over?: boolean;
    kind: 'call' | 'stdin';
    /** The same text cut where it differs from the other side (`diffChars`). */
    parts?: DiffPart[];
    tone?: keyof typeof MARK;
}) {
    const { t } = useTranslation();
    if (over) return <span className="font-sans text-sm text-slate-500 dark:text-slate-400">{t("More than 64 KB of output")}</span>;
    if (!text && kind === 'stdin') return <span className="font-sans text-sm text-slate-500 dark:text-slate-400">{t("Nothing was printed.")}</span>;
    if (!parts || !tone) return <>{text}</>;
    // A marked line break has no ink of its own, so it gets a ↵ for the mark
    // to sit on: drawn only, never read aloud or copied.
    return (
        <>
            {parts.map((p, i) => p.mark
                ? (
                    <mark key={i} className={cx('rounded-sm text-inherit underline decoration-2 underline-offset-[0.2em]', MARK[tone])}>
                        {p.text.split('\n').map((line, k) => (
                            <Fragment key={k}>
                                {k > 0 && <><span aria-hidden="true" className="select-none">↵</span>{'\n'}</>}
                                {line}
                            </Fragment>
                        ))}
                    </mark>
                )
                : <span key={i}>{p.text}</span>)}
        </>
    );
}

/** A test's input as its row shows it: the call, the typed line, or "(empty)". */
function InputShown({ kind, input }: { kind: 'call' | 'stdin'; input: string }) {
    const { t } = useTranslation();
    if (kind === 'call') return <>{input}</>;
    const line = inputLine(input);
    // The eye has the column's heading; a screen reader hears the word.
    return (
        <>
            <span className="sr-only">{t("Input")} </span>
            {line || <span className="font-sans text-sm text-slate-500 dark:text-slate-400">{t("(empty)")}</span>}
        </>
    );
}

// One grid for the whole list and every row a subgrid of it, so a column is as
// wide as its widest cell in any row: the marks, the inputs (never more than
// half the list, past which an input wraps), the arrows, the results. A failed
// row's second line puts "Expected" under the input and the arrow, so the
// expected value starts exactly under the one that came back. The list is
// pulled out by the rows' own side padding, so a failed row's tint has room
// around its text and the marks stand on the same edge as the count above.
const LIST = 'mt-1 -mx-2 grid gap-x-3';
const LIST_COLUMNS = { gridTemplateColumns: 'auto fit-content(50%) auto minmax(0, 1fr)' };
const ROW = 'col-span-4 grid grid-cols-subgrid items-baseline rounded-md px-2 py-1';
const FAILED_ROW = 'bg-red-50 dark:bg-red-950/40';
const CELL = 'min-w-0 [overflow-wrap:anywhere]';
// One line of the monospaced text, so an icon centred in it sits on the first line.
const ICON_LINE = 'flex items-center self-start h-[calc(0.85rem*1.625)]';

/**
 * After Check: how many tests passed, and when one failed, one line per test
 * in the question's order: the input, an arrow, what the learner's code gave.
 * A failed test is tinted, and under its result says what was expected, with
 * the characters that differ marked on both sides.
 */
export function TestRows({ run, language }: { run: RunResult; language: RunnerLanguage }) {
    const { t } = useTranslation();
    const rows = run.tests ?? [];
    const stopped = stoppedLine(t, run, language);
    if (!rows.length) {
        return stopped ? <div className={SECTION}><p className={MUTED}>{stopped}</p></div> : null;
    }
    const passed = rows.filter((r) => r.pass).length;
    const count = t("Tests passed: {{passed}} of {{total}}", { passed, total: rows.length });
    // Every test passed: the count is the whole story, and four green rows
    // restating it were what made a right answer's card look busy.
    if (passed === rows.length) {
        return (
            <section className={SECTION} aria-label={t("Tests")}>
                <p className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200 tabular-nums">
                    <Check className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    {count}
                </p>
            </section>
        );
    }
    // A list is all calls or all typed input (`normalizeCodeTests` refuses a
    // mix). A call says what it is; typed lines need their columns named.
    const typed = rows[0].kind === 'stdin';
    return (
        <section className={SECTION} aria-label={t("Tests")}>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200 tabular-nums">{count}</p>
            <div className={LIST} style={LIST_COLUMNS}>
                {typed && (
                    <div aria-hidden="true" className={cx(ROW, 'pb-0 text-xs text-slate-500 dark:text-slate-400')}>
                        <span className="col-start-2">{t("Input")}</span>
                        <span className="col-start-4">{t("Output")}</span>
                    </div>
                )}
                {/* A hair between rows, so two failed rows read as two bands. */}
                <ul className={cx('col-span-4 grid grid-cols-subgrid gap-y-0.5', MONO)}>
                    {rows.map((row, i) => {
                        const diff = row.pass || row.over ? null : diffChars(row.expected, row.actual);
                        return (
                            // A passed row steps back so the failed ones are read first.
                            <li key={i} className={cx(ROW, 'gap-y-0.5', row.pass ? 'text-slate-600 dark:text-slate-400' : FAILED_ROW)}>
                                <span className={ICON_LINE}>
                                    {row.pass
                                        ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-label={t("Passed")} />
                                        : <X className="w-4 h-4 text-red-600 dark:text-red-400" aria-label={t("Failed")} />}
                                </span>
                                <span className={CELL}><InputShown kind={row.kind} input={row.input} /></span>
                                <span className="text-slate-400 dark:text-slate-500" aria-hidden="true">→</span>
                                <div className={cx(CELL, !row.pass && 'text-red-700 dark:text-red-300')}>
                                    {!row.pass && <span className="sr-only">{t("Got")} </span>}
                                    <Shown text={row.actual} over={row.over} kind={row.kind} parts={diff?.actual} tone="got" />
                                </div>
                                {!row.pass && (
                                    <>
                                        <span className="col-start-2 col-span-2 text-right font-sans text-xs text-slate-600 dark:text-slate-300">{t("Expected")}</span>
                                        <div className={CELL}>
                                            <Shown text={row.expected} kind={row.kind} parts={diff?.expected} tone="expected" />
                                        </div>
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </div>
        </section>
    );
}
