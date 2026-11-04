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
    const call = run.value !== undefined && test?.call ? test.call : '';
    const nothing = !stopped && !output && !call && !run.error;
    return (
        <section className={SECTION} aria-label={t("Output")} aria-live="polite">
            <p className={LABEL}>{t("Output")}</p>
            {typeof test?.stdin === 'string' && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t("Input")}: <span className="font-mono">{test.stdin.replace(/\n+$/, '').replace(/\n/g, ' ⏎ ') || t("(empty)")}</span>
                </p>
            )}
            {(output || run.error) && (
                <pre className={`mt-1 max-h-60 overflow-auto ${MONO}`}>
                    {output}
                    {run.error && (
                        <span className="text-red-700 dark:text-red-300">{output ? '\n' : ''}{run.error}</span>
                    )}
                </pre>
            )}
            {/* What the call returned, apart from what the code printed on the
                way, in the same "call → value" form as the rows after Check. */}
            {call && (
                <p className={cx(output || run.error ? 'mt-2' : 'mt-1', MONO)}>
                    {call} <span className="text-slate-400 dark:text-slate-500">→</span> {run.value}
                </p>
            )}
            {output.length >= OUTPUT_MAX && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("More than 64 KB of output")}</p>}
            {nothing && <p className={`mt-1 ${MUTED}`}>{t("Nothing was printed.")}</p>}
            {stopped && <p className={`mt-1 ${MUTED}`}>{stopped}</p>}
        </section>
    );
}

/** One side of a row: the value, the printed text, or that there was none. */
function Shown({ text, over, kind, parts, tone }: {
    text: string;
    over?: boolean;
    kind: 'call' | 'stdin';
    /** The same text cut where it differs from the other side (`diffChars`). */
    parts?: DiffPart[];
    tone?: 'got' | 'expected';
}) {
    const { t } = useTranslation();
    if (over) return <span className="font-sans text-sm text-slate-500 dark:text-slate-400">{t("More than 64 KB of output")}</span>;
    if (!text && kind === 'stdin') return <span className="font-sans text-sm text-slate-500 dark:text-slate-400">{t("Nothing was printed.")}</span>;
    if (!parts) return <>{text}</>;
    // A marked space or line break has no ink of its own: the mark's fill is
    // what shows it, and a break gets a ↵ so the fill has something to sit on.
    return (
        <>
            {parts.map((p, i) => p.mark
                ? <mark key={i} className={cx('rounded-sm text-inherit', tone === 'got' ? 'bg-red-200 dark:bg-red-500/35' : 'bg-emerald-100 dark:bg-emerald-500/25')}>{p.text.replace(/\n/g, '↵\n')}</mark>
                : <span key={i}>{p.text}</span>)}
        </>
    );
}

/** A typed input on one line: line breaks as ⏎. */
const inputLine = (input: string) => input.replace(/\n+$/, '').replace(/\n/g, ' ⏎ ');

/** A test's input as its row shows it: the call, the typed line, or "(empty)". */
function InputShown({ kind, input }: { kind: 'call' | 'stdin'; input: string }) {
    const { t } = useTranslation();
    if (kind === 'call') return <>{input}</>;
    const line = inputLine(input);
    return line ? <>{line}</> : <span className="font-sans text-sm text-slate-500 dark:text-slate-400">{t("(empty)")}</span>;
}

// Each row is a grid of the same four columns: the mark, the input, an arrow,
// the result. The input column is as wide as the longest input, counted in
// `ch` of the monospaced face the rows are set in (so exact), and never more
// than 45% of the row, past which an input wraps; so every arrow and every
// result stands in one column. The list is pulled out by the rows' own side
// padding, so a failed row's tint has room around its text and the marks
// stand on the same edge as the count above them.
const ROW = 'grid items-start gap-x-3 rounded-md px-2 py-1';
const FAILED_ROW = 'bg-red-50 dark:bg-red-950/40';
const columns = (inputChars: number) => ({ gridTemplateColumns: `1rem min(${Math.max(inputChars, 1)}ch, 45%) auto minmax(0, 1fr)` });
// One line of the monospaced text, so an icon centred in it sits on the first line.
const ICON_LINE = 'flex items-center h-[calc(0.85rem*1.625)]';

/**
 * After Check: one line per test, in the question's order. The input, an
 * arrow, and what the learner's code gave, with every result in one column;
 * a failed test is tinted and puts the expected result beside the one that
 * came back, on the same line when both fit.
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
    // A list is all calls or all typed input (a mixed one is never run). A call
    // says what it is; a typed line needs its two columns named.
    const typed = rows[0].kind === 'stdin';
    const chars = (s: string) => Array.from(s).length;
    const grid = columns(Math.max(
        ...rows.map((r) => (r.kind === 'call' ? chars(r.input) : chars(inputLine(r.input)) || chars(t("(empty)")))),
        typed ? chars(t("Input")) : 0,
    ));
    return (
        <section className={SECTION} aria-label={t("Tests")}>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200 tabular-nums">{count}</p>
            {typed && (
                // Set in the rows' face so its `ch` columns are theirs.
                <div aria-hidden="true" className={cx(ROW, '-mx-2 mt-1 pb-0 font-mono text-[0.85rem]')} style={grid}>
                    <span />
                    <span className="font-sans text-xs text-slate-500 dark:text-slate-400">{t("Input")}</span>
                    <span className="invisible">→</span>
                    <span className="font-sans text-xs text-slate-500 dark:text-slate-400">{t("Output")}</span>
                </div>
            )}
            {/* A hair between rows, so two failed rows read as two bands. */}
            <ul className={cx('-mx-2 space-y-0.5', typed ? '' : 'mt-1', MONO)}>
                {rows.map((row, i) => {
                    // Printed lines read as blocks; "Expected" then goes on its own line.
                    const block = /\n./.test(row.actual) || /\n./.test(row.expected);
                    const diff = row.pass || row.over ? null : diffChars(row.expected, row.actual);
                    return (
                        // A passed row steps back so the failed ones are read first.
                        <li key={i} className={cx(ROW, row.pass ? 'text-slate-600 dark:text-slate-400' : FAILED_ROW)} style={grid}>
                            <span className={ICON_LINE}>
                                {row.pass
                                    ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-label={t("Passed")} />
                                    : <X className="w-4 h-4 text-red-600 dark:text-red-400" aria-label={t("Failed")} />}
                            </span>
                            <span className="min-w-0 [overflow-wrap:anywhere]"><InputShown kind={row.kind} input={row.input} /></span>
                            <span className="text-slate-400 dark:text-slate-500" aria-hidden="true">→</span>
                            <div className="min-w-0 [overflow-wrap:anywhere]">
                                {row.pass ? (
                                    <Shown text={row.actual} kind={row.kind} />
                                ) : (
                                    <div className="flex flex-wrap items-baseline gap-x-4">
                                        <span className="text-red-700 dark:text-red-300">
                                            <span className="sr-only">{t("Got")} </span>
                                            <Shown text={row.actual} over={row.over} kind={row.kind} parts={diff?.actual} tone="got" />
                                        </span>
                                        {/* On one line the value hangs beside its label, so a
                                            value that wraps stays in its own column. */}
                                        <span className={block ? 'basis-full mt-1' : 'flex min-w-0 items-baseline gap-x-1.5'}>
                                            <span className={cx('font-sans text-xs text-slate-600 dark:text-slate-300', block ? 'block' : 'shrink-0')}>{t("Expected")}</span>
                                            <span className="min-w-0"><Shown text={row.expected} kind={row.kind} parts={diff?.expected} tone="expected" /></span>
                                        </span>
                                    </div>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
