import type { QuizQuestion } from '../../types';
import { k } from '../../i18n';

/**
 * The answer formats, as the CLIENT knows them — the mirror of
 * `server/answerFormats.js`.
 *
 * The server side says what a model must author and how a raw question is made
 * honest; this side says how a learner ANSWERS it. `AnswerInput` renders every
 * format through this table, so a question surface never switches on
 * `question.type` itself: the feed's inline check, the quiz, the placement
 * probe all ask the same way, and a new format reaches all of them by adding a
 * row here and an input component. `answer-format-gates.mjs` pins this key set
 * to the server's, because a format the server authors and the client cannot
 * render is a question nobody can answer.
 */
export type AnswerFormat = QuizQuestion['type'];

export interface FormatSpec {
    /**
     * A closed format is answered by choosing, and the choice IS the answer —
     * a feed card grades it on the spot. Open formats (prose, code) are typed
     * and then submitted.
     */
    commitsOnSelect: boolean;
    /** Locally by string match, or through the checker (a model call). */
    grading: 'local' | 'ai';
    /**
     * What the verdict margin calls the key under a wrong answer. English text
     * used as the i18n key, so the surface wraps it in `t()`.
     */
    keyLabel: string;
    /** One line under an open input saying how it will be judged. */
    hint?: string;
    /** The label in a "question type" picker. */
    label: string;
    /** The learner's answer reads as a BLOCK (code, an ordering) rather than one line of text. */
    blockAnswer?: boolean;
}

// `k()` marks a table string as an i18n key (the render site wraps it in `t()`),
// so the extractor and the gate can see it.
export const ANSWER_FORMATS: Record<AnswerFormat, FormatSpec> = {
    multiple_choice: {
        commitsOnSelect: true,
        grading: 'local',
        keyLabel: k("Correct answer:"),
        label: k("Multiple choice"),
    },
    true_false: {
        commitsOnSelect: true,
        grading: 'local',
        keyLabel: k("Correct answer:"),
        label: k("True / false"),
    },
    short_answer: {
        commitsOnSelect: false,
        grading: 'ai',
        keyLabel: k("Expected:"),
        hint: k("Evaluated for meaning, not exact wording"),
        label: k("Short answer"),
    },
    fill_in: {
        commitsOnSelect: false,
        grading: 'local',
        keyLabel: k("Correct answer:"),
        // The hint is the grader's contract stated before the learner types,
        // not after: they need to know that a missing capital will not cost
        // them the mark and a missing letter will.
        hint: k("Spelling counts; capitals and punctuation do not"),
        label: k("Type the answer"),
    },
    numeric: {
        commitsOnSelect: false,
        grading: 'local',
        keyLabel: k("Correct answer:"),
        // The hint is one string per FORMAT, not per question, so it cannot
        // mention the unit: half the questions have none. "Just" is doing the
        // work — it says the unit beside the box is not yours to type.
        hint: k("Just the number"),
        label: k("Numeric answer"),
    },
    code: {
        commitsOnSelect: false,
        grading: 'ai',
        keyLabel: k("One solution:"),
        hint: k("Judged on what it does, not on matching the reference"),
        label: k("Write code"),
        blockAnswer: true,
    },
    sequence: {
        commitsOnSelect: false,
        grading: 'local',
        keyLabel: k("Correct order:"),
        label: k("Put in order"),
        blockAnswer: true,
    },
};

export const FORMAT_IDS = Object.keys(ANSWER_FORMATS) as AnswerFormat[];

/** The spec for a question, falling back to multiple choice for a row written before a format existed. */
export const formatOf = (question: Pick<QuizQuestion, 'type'>): FormatSpec =>
    ANSWER_FORMATS[question.type] ?? ANSWER_FORMATS.multiple_choice;

/**
 * What an UNTOUCHED input already answers. An ordering is an answer from the
 * first render — the served order counts, and the server guarantees it is
 * never the key — so a learner who submits it as served is graded on that
 * order, not on "no answer". Every other format starts empty.
 */
export const defaultAnswer = (question: QuizQuestion): string =>
    question.type === 'sequence' ? JSON.stringify(question.items ?? []) : '';

/**
 * One typed answer, reduced to the thing that is actually being graded —
 * letters, digits and word boundaries, so spelling and only spelling.
 *
 * The mirror of `normalizeTyped` in `server/answerFormats.js`, which carries
 * the reasoning for every fold (case, all punctuation by DELETION so `don't`
 * and `dont` are one answer, whitespace runs, NFC; never diacritics).
 * `answer-format-gates.mjs` runs both against one table, because this side
 * grades the feed and the quiz while the server grades the placement probe.
 */
export function normalizeTyped(value: string | null | undefined): string {
    return String(value ?? '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Every spelling a `fill_in` question accepts, normalised: the key and `accept`. */
export function acceptedAnswers(question: Pick<QuizQuestion, 'correct_answer' | 'accept'>): string[] {
    const all = [question?.correct_answer, ...(Array.isArray(question?.accept) ? question.accept : [])];
    const out: string[] = [];
    for (const candidate of all) {
        const norm = normalizeTyped(candidate);
        if (norm && !out.includes(norm)) out.push(norm);
    }
    return out;
}

/** "3.0 × 10^8", "3.0 x 10**8" — how a physics answer is written outside a programming language. */
const SCIENTIFIC = /[×x*]\s*10\s*(?:\^|\*\*)?\s*([-+]?\d+)/i;

/**
 * Read a number the way a learner actually types one, or null.
 *
 * The mirror of `parseNumber` in `server/answerFormats.js` — that file carries
 * the reasoning for every rule here, and `answer-format-gates.mjs` runs both
 * against one table of written answers, because the client grades the feed and
 * the quiz while the server grades the placement probe, and `0,5` must mean the
 * same number on both.
 *
 * Deliberately no lookbehind: this ships to browsers, and Safari only grew it
 * in 16.4 — a regex the parser cannot compile takes the whole bundle down, not
 * just this question.
 */
export function parseNumber(value: string | number | null | undefined): number | null {
    let s = String(value ?? '').trim();
    if (!s) return null;
    s = s.replace(/^[=~≈≃]+\s*/, '').replace(/^[$€£¥]\s*/, '').trim();
    const sci = s.match(SCIENTIFIC);
    if (sci) s = `${s.slice(0, sci.index).trim()}e${sci[1]}`;
    let prev: string;
    do { prev = s; s = s.replace(/(\d)[\s'’_](\d)/g, '$1$2'); } while (s !== prev);

    const dots = s.split('.').length - 1;
    const commas = s.split(',').length - 1;
    if (dots && commas) {
        const dec = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
        s = s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
    } else if (commas > 1) s = s.replace(/,/g, '');
    else if (dots > 1) s = s.replace(/\./g, '');
    else if (commas === 1) s = s.replace(',', '.');

    const frac = s.match(/^([-+]?(?:\d+\.?\d*|\.\d+))\s*\/\s*((?:\d+\.?\d*|\.\d+))$/);
    if (frac) {
        const denominator = Number(frac[2]);
        if (!denominator) return null;
        const n = Number(frac[1]) / denominator;
        return Number.isFinite(n) ? n : null;
    }

    const m = s.match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
}

const SUPERSCRIPT: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '+': '⁺',
};

/**
 * A unit as it should be READ: `m/s^2` → `m/s²`, `cm^-1` → `cm⁻¹`.
 *
 * The authoring rule asks a model for ASCII (`"m/s^2"`), because a caret
 * survives JSON, prompts and every model's tokeniser while `²` does not — but
 * a physics answer box that says `m/s^2` looks like a bug to anyone who reads
 * one. Display only: nothing downstream sees this, the unit is never graded,
 * and a unit with no caret comes back unchanged.
 */
export function prettyUnit(unit: string | null | undefined): string {
    return String(unit ?? '').replace(/\^\(?([-+]?\d+)\)?/g,
        (_, digits: string) => [...digits].map(c => SUPERSCRIPT[c] ?? c).join(''));
}

/**
 * Half a unit in the last place the key was written to — the mirror of
 * `defaultTolerance` in `server/answerFormats.js`, used when a question carries
 * no tolerance of its own.
 */
export function defaultTolerance(written: string | number | null | undefined): number {
    const s = String(written ?? '').replace(/\s+/g, '');
    if (parseNumber(s) === null) return 0;
    const sci = s.match(/[eE]([-+]?\d+)$|[×x*]10(?:\^|\*\*)?([-+]?\d+)$/);
    const exponent = sci ? Number(sci[1] ?? sci[2]) : 0;
    const mantissa = sci ? s.slice(0, sci.index) : s;
    const decimals = mantissa.match(/[.,](\d+)/);
    return 0.5 * Math.pow(10, exponent - (decimals ? decimals[1].length : 0));
}

/** The items of an ordering answer, or null when the string is not one. */
export function parseSequence(value: string): string[] | null {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every(x => typeof x === 'string') ? parsed : null;
    } catch {
        return null;
    }
}
