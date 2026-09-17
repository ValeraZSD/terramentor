import { api } from '../api';
import { QuizQuestion } from '../types';
import { formatOf, parseSequence, parseNumber, defaultTolerance, normalizeTyped, acceptedAnswers } from '../components/answer/formats';

/** Result of grading one question — reported up exactly once. */
export interface GradedAnswer {
    correct: boolean;
    answer: string;
    /** `fallback` = the AI grader was unreachable and the server compared
     *  strings; a wrong verdict from it is not written as mastery evidence. */
    gradedBy: 'local' | 'ai' | 'fallback';
    explanation: string;
    /** The checker declined to judge: not marked either way (assessments read it as wrong). */
    unsure?: boolean;
}

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Verdict for a locally graded format; null when the format needs the checker.
 * Mirror of `gradeLocally` in `server/answerFormats.js` — the two must agree,
 * because the client grades the feed and the quiz while the server grades the
 * placement probe, and the same answer must earn the same verdict on both.
 */
export function gradeLocally(question: QuizQuestion, answer: string): boolean | null {
    if (formatOf(question).grading !== 'local') return null;
    if (question.type === 'sequence') {
        const given = parseSequence(answer);
        const key = parseSequence(question.correct_answer);
        if (!given || !key || given.length !== key.length) return false;
        return given.every((item, i) => item.trim() === key[i].trim());
    }
    if (question.type === 'fill_in') {
        const given = normalizeTyped(answer);
        // An empty box is not an accidental match against an empty key: a key
        // with nothing gradeable in it never survives normalisation.
        return !!given && acceptedAnswers(question).includes(given);
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
 * cannot be reached. The feed and the quiz used to carry their own copies of
 * this with slightly different fallbacks; a format added to one was silently
 * ungradeable in the other.
 */
export async function gradeAnswer(question: QuizQuestion, answer: string): Promise<GradedAnswer> {
    const local = gradeLocally(question, answer);
    if (local !== null) {
        return { correct: local, answer, gradedBy: 'local', explanation: question.explanation };
    }
    try {
        const res = await api.checkAnswer(question.question, question.correct_answer, answer, {
            format: question.type,
            language: question.language,
        });
        return {
            correct: !!res.correct,
            answer,
            gradedBy: res.graded === false ? 'fallback' : 'ai',
            explanation: res.explanation || question.explanation,
            ...(res.unsure ? { unsure: true } : {}),
        };
    } catch {
        // Grader unreachable — the same bare comparison the server would have
        // made, and reported as such so it is never written as evidence.
        return { correct: norm(answer) === norm(question.correct_answer), answer, gradedBy: 'fallback', explanation: question.explanation };
    }
}
