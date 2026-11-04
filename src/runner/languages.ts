import type { CodeTest, RunnerLanguage } from './protocol';
import { MAX_TESTS } from './protocol';

/**
 * Which code questions the runner can grade. Everything else (C, Java, SQL
 * until it has a runtime here, a language named loosely) keeps the model
 * grader. The server stores a question's tests whatever its language; only
 * this list decides whether they are run.
 */
const ALIASES: Record<string, RunnerLanguage> = {
    python: 'python',
    python3: 'python',
    py: 'python',
    javascript: 'javascript',
    js: 'javascript',
};

export function runnableLanguage(language: unknown): RunnerLanguage | null {
    if (typeof language !== 'string') return null;
    return ALIASES[language.trim().toLowerCase()] ?? null;
}

/** How each language is named on screen (a proper name, never translated). */
export const LANGUAGE_NAME: Record<RunnerLanguage, string> = { python: 'Python', javascript: 'JavaScript' };

/** Memory ceilings, in MiB: Python's may grow to it, JavaScript's is fixed at it. */
export const MEMORY_MB: Record<RunnerLanguage, number> = { python: 256, javascript: 64 };

/** Per-field and whole-list caps, the same as the server's normaliser. */
export const TEST_FIELD_MAX = 2000;
export const TESTS_TOTAL_MAX = 16000;

/**
 * The tests a stored question carries, as the runner will use them: each one a
 * call or a standard input (never both), strings within the caps. The server
 * normalised them on the way in; this reads them again because a stored row
 * can come from anywhere, and an empty list means "no tests": the model grades.
 */
export function codeTestsOf(raw: unknown): CodeTest[] {
    if (!Array.isArray(raw)) return [];
    const out: CodeTest[] = [];
    let total = 0;
    for (const t of raw) {
        if (out.length >= MAX_TESTS) break;
        if (!t || typeof t !== 'object') continue;
        const o = t as Record<string, unknown>;
        const call = typeof o.call === 'string' ? o.call.trim() : '';
        const stdin = typeof o.stdin === 'string' ? o.stdin : null;
        if ((call && stdin !== null) || (!call && stdin === null)) continue;
        const expect = typeof o.expect === 'string' ? o.expect : undefined;
        const size = call.length + (stdin?.length ?? 0) + (expect?.length ?? 0);
        if (call.length > TEST_FIELD_MAX || (stdin?.length ?? 0) > TEST_FIELD_MAX || (expect?.length ?? 0) > TEST_FIELD_MAX) continue;
        if (total + size > TESTS_TOTAL_MAX) break;
        total += size;
        const test: CodeTest = call ? { call } : { stdin: stdin as string };
        if (expect !== undefined) test.expect = expect;
        out.push(test);
    }
    return out;
}
