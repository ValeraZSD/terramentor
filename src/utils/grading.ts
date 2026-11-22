import { api } from '../api';
import { QuizQuestion } from '../types';
import { useStore } from '../store';
import {
    formatOf, parseSequence, parseNumber, defaultTolerance, normalizeTyped, acceptedAnswers, spellingSlipOf,
    readPieces, arrangementsOf, foldPiece, formTested,
} from '../components/answer/formats';
import { testsToGradeBy, runnableLanguage } from '../runner/languages';
import { runVerdict } from '../runner/verdict';
import { loadRunner } from '../runner/load';
import type { RunResult } from '../runner/protocol';

/** Result of grading one question — reported up exactly once. */
export interface GradedAnswer {
    correct: boolean;
    answer: string;
    /** `fallback` = the AI grader was unreachable and the server compared
     *  strings; a wrong verdict from it is not written as mastery evidence.
     *  `run` = the code was run against the question's tests on this device. */
    gradedBy: 'local' | 'ai' | 'fallback' | 'run';
    explanation: string;
    /** The checker declined to judge: not marked either way (assessments read it as wrong). */
    unsure?: boolean;
    /**
     * Wrong on FORM alone, on a task that tests form (`formTested`): the
     * meaning was right. A typed gap graded on this device is all form (the
     * sentence fixes the meaning), so any miss there counts. The stream
     * offers one more try on it; `hint` points
     * at the slip without giving the answer ('' when there is none to show).
     */
    formMiss?: boolean;
    hint?: string;
    /** The run behind a `run` verdict: one row per test, or why the code was stopped. */
    run?: RunResult;
}

/**
 * A code answer in a language the runner knows, on a question that carries
 * tests: run the reference and the answer on them, here, and let the rows
 * decide. Null when the run cannot speak for the answer (see `runVerdict`),
 * and the model judges it instead.
 */
async function gradeByRunning(question: QuizQuestion, answer: string): Promise<GradedAnswer | null> {
    if (!useStore.getState().codeRunner) return null;
    const language = runnableLanguage(question.language);
    const tests = testsToGradeBy(question.tests);
    if (!language || tests.length === 0) return null;
    let run: RunResult;
    try {
        const { checkCode } = await loadRunner();
        run = await checkCode(language, question.correct_answer, answer, tests);
    } catch {
        return null;
    }
    const correct = runVerdict(run);
    if (correct === null) return null;
    return { correct, answer, gradedBy: 'run', explanation: question.explanation, run };
}

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Verdict for a locally graded format; null when the format needs the checker.
 * Mirror of `gradeLocally` in `server/answerFormats.js` — the two must agree,
 * because the client grades the feed and the quiz while the server grades the
 * placement probe, and the same answer must earn the same verdict on both.
 */
export function gradeLocally(
    question: QuizQuestion,
    answer: string,
    { forgiveSpelling = useStore.getState().forgiveSpelling }: { forgiveSpelling?: boolean } = {},
): boolean | null {
    if (formatOf(question).grading !== 'local') return null;
    if (question.type === 'sequence') {
        const given = parseSequence(answer);
        const key = parseSequence(question.correct_answer);
        if (!given || !key || given.length !== key.length) return false;
        return given.every((item, i) => item.trim() === key[i].trim());
    }
    if (question.type === 'assemble') {
        // The whole arrangement, or nothing: every gap holds the key's piece,
        // or every gap holds one declared other arrangement's. An empty gap
        // (null) matches no piece.
        const given = readPieces(answer, { holes: true });
        if (!given) return false;
        return arrangementsOf(question).some(a => a.length === given.length
            && a.every((p, i) => typeof given[i] === 'string' && foldPiece(given[i]) === foldPiece(p)));
    }
    if (question.type === 'fill_in') {
        const given = normalizeTyped(answer);
        // An empty box is not an accidental match against an empty key: a key
        // with nothing gradeable in it never survives normalisation.
        if (!given) return false;
        if (acceptedAnswers(question).includes(given)) return true;
        return !!forgiveSpelling && spellingSlipOf(question, answer) !== null;
    }
    if (question.type === 'numeric') {
        const given = parseNumber(answer);
        const key = parseNumber(question.correct_answer);
        if (given === null || key === null) return false;
        const stated = Number(question.tolerance);
        const tol = Number.isFinite(stated) && stated >= 0 ? stated : defaultTolerance(question.correct_answer);
        // The same hair of slack the server allows: 0.1 + 0.2 is not 0.3, and a
        // difference of exactly the tolerance must still pass.
        return Math.abs(given - key) <= tol * (1 + 1e-9) + 1e-12;
    }
    return norm(answer) === norm(question.correct_answer);
}

/**
 * Grade one answer the way every question surface does: closed formats by
 * local match, open ones through the checker with an honest fallback when it
 * cannot be reached. The feed and the quiz carrying their own copies, with
 * slightly different fallbacks, leaves a format added to one silently
 * ungradeable in the other — so there is exactly one.
 */
export async function gradeAnswer(
    question: QuizQuestion,
    answer: string,
    { nodeId }: { nodeId?: number | null } = {},
): Promise<GradedAnswer> {
    const form = formTested(question);
    const local = gradeLocally(question, answer);
    if (local !== null) {
        // A typed gap that tests form is all form: a miss there is a form miss,
        // with no hint to give but the generic one.
        const formMiss = form && !local && question.type === 'fill_in' && !!normalizeTyped(answer);
        return { correct: local, answer, gradedBy: 'local', explanation: question.explanation, ...(formMiss ? { formMiss: true, hint: '' } : {}) };
    }
    if (question.type === 'code') {
        const ran = await gradeByRunning(question, answer);
        if (ran) return ran;
    }
    try {
        const res = await api.checkAnswer(question.question, question.correct_answer, answer, {
            format: question.type,
            language: question.language,
            // Only for a task that tests form: the server then marks the form,
            // in the language of the topic's course.
            ...(form ? { testsForm: true, ...(nodeId ? { nodeId } : {}) } : {}),
        });
        return {
            correct: !!res.correct,
            answer,
            gradedBy: res.graded === false ? 'fallback' : 'ai',
            explanation: res.explanation || question.explanation,
            ...(res.unsure ? { unsure: true } : {}),
            ...(form && res.formMiss && !res.correct ? { formMiss: true, hint: typeof res.hint === 'string' ? res.hint : '' } : {}),
        };
    } catch {
        // Grader unreachable — the same bare comparison the server would have
        // made, and reported as such so it is never written as evidence.
        // On a form task every letter counts, but capitals and punctuation
        // only when the task is about them, which a bare comparison cannot
        // tell: the server's fallback leaves both out the same way.
        const same = form ? normalizeTyped(answer) === normalizeTyped(question.correct_answer) : norm(answer) === norm(question.correct_answer);
        return { correct: same, answer, gradedBy: 'fallback', explanation: question.explanation };
    }
}
