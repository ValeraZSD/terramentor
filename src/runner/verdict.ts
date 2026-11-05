import type { RunResult } from './protocol';

/**
 * What a run says about the learner's answer: right, wrong, or nothing.
 *
 * Right only when every test ran and matched the reference. Wrong when a test
 * did not match, or when the learner's OWN code was stopped (it ran past the
 * time limit, past the memory ceiling, or flooded the runner). Nothing, and
 * the model judges the answer as before, whenever the run cannot speak for the
 * answer: the runtime did not start, the reference could not be trusted, or
 * something failed outside the learner's code.
 */
export function runVerdict(run: RunResult): boolean | null {
    if (run.keyProblem) return null;
    if (run.status === 'done') {
        if (!run.tests || run.tests.length === 0) return null;
        return run.tests.every((t) => t.pass);
    }
    if (run.phase === 'learner' && (run.status === 'timeout' || run.status === 'memory' || run.status === 'flood')) return false;
    return null;
}
