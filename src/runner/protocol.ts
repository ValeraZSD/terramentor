/**
 * What crosses between the page, the runner frame and its worker, and how the
 * page reads what comes back.
 *
 * Everything the worker sends is written by code that ran next to the
 * learner's code, so the page treats it as untrusted input: `readRunResult`
 * keeps only the fields it knows, of the types it expects, and caps every
 * string, so a forged or oversized answer can at worst be a wrong verdict on
 * the learner's own answer, never a large or strange object inside the app.
 */

/** One test a question carries: an INPUT only. The expected result is what the reference solution does. */
export interface CodeTest {
    /** An expression to evaluate after the code has run, e.g. `add(2, 3)`. */
    call?: string;
    /** The program's standard input; its printed output is what is compared. */
    stdin?: string;
    /** Optional: what the author expected. A reference that disagrees makes the tests unusable. */
    expect?: string;
}

export type RunnerLanguage = 'python' | 'javascript';

/** How a run ended. `done` means the job finished; the rest say why it was stopped. */
export type RunStatus = 'done' | 'timeout' | 'memory' | 'crash' | 'flood' | 'unavailable';

/** Where it was when it ended: still starting, idle, given the job, running the reference, running the learner's code. */
export type RunPhase = 'load' | 'idle' | 'job' | 'reference' | 'learner';

export interface TestOutcome {
    /** A call evaluated after the code ran, or a whole run with a standard input. */
    kind: 'call' | 'stdin';
    /** The call, or the standard input (cut short). */
    input: string;
    /** What the reference produced: a value, an exception, or the printed text. */
    expected: string;
    /** What the learner's code produced, the same way. */
    actual: string;
    pass: boolean;
    /** The learner's code printed more than `OUTPUT_MAX` characters and was cut off there. */
    over?: boolean;
}

/** Why the tests could not be used to grade. The model grader takes over. */
export type KeyProblem = 'reference-error' | 'expect-mismatch' | 'reference-stopped';

export interface RunResult {
    status: RunStatus;
    phase: RunPhase;
    /** Run mode: what the learner's code printed (capped). */
    output?: string;
    /** Run mode: the error it stopped with, if any. */
    error?: string;
    /** Run mode: the value of the question's first call, if it has one. */
    value?: string;
    /** Check mode: one row per test, in the question's order. */
    tests?: TestOutcome[];
    /** Check mode: set when the reference could not be trusted, so nothing was graded. */
    keyProblem?: KeyProblem;
}

/** Every string a result carries is cut to this many characters. */
export const RESULT_TEXT_MAX = 2000;
/** The learner's printed output is cut to this many characters, here and in the worker. */
export const OUTPUT_MAX = 65536;
/** At most this many test rows are read; a question carries at most this many tests. */
export const MAX_TESTS = 12;

const STATUSES: ReadonlySet<string> = new Set(['done', 'timeout', 'memory', 'crash', 'flood', 'unavailable']);
const PHASES: ReadonlySet<string> = new Set(['load', 'idle', 'job', 'reference', 'learner']);
const KEY_PROBLEMS: ReadonlySet<string> = new Set(['reference-error', 'expect-mismatch', 'reference-stopped']);

function cap(value: unknown, max = RESULT_TEXT_MAX): string | undefined {
    if (typeof value !== 'string') return undefined;
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The page's reading of whatever the frame sent back: a known status and phase
 * or a crash, at most `MAX_TESTS` rows of capped strings, nothing else.
 */
export function readRunResult(raw: unknown, phaseHint: unknown): RunResult {
    const phase = (typeof phaseHint === 'string' && PHASES.has(phaseHint) ? phaseHint : 'load') as RunPhase;
    if (!raw || typeof raw !== 'object') return { status: 'crash', phase };
    const r = raw as Record<string, unknown>;
    const status = (typeof r.status === 'string' && STATUSES.has(r.status) ? r.status : 'crash') as RunStatus;
    const out: RunResult = { status, phase };
    const output = cap(r.output, OUTPUT_MAX);
    if (output !== undefined) out.output = output;
    const error = cap(r.error);
    if (error !== undefined) out.error = error;
    const value = cap(r.value);
    if (value !== undefined) out.value = value;
    if (typeof r.keyProblem === 'string' && KEY_PROBLEMS.has(r.keyProblem)) out.keyProblem = r.keyProblem as KeyProblem;
    if (Array.isArray(r.tests)) {
        out.tests = r.tests.slice(0, MAX_TESTS).map((t) => {
            const row = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
            const outcome: TestOutcome = {
                kind: row.kind === 'stdin' ? 'stdin' : 'call',
                input: cap(row.input) ?? '',
                expected: cap(row.expected) ?? '',
                actual: cap(row.actual) ?? '',
                pass: row.pass === true,
            };
            if (row.over === true) outcome.over = true;
            return outcome;
        });
    }
    return out;
}
