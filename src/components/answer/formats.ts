import type { QuizQuestion } from '../../types';
import { k } from '../../i18n';
import { isRtl } from '../../utils/direction';

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
    /** The same line when `forgive_spelling` is on, for a format it changes. */
    forgivingHint?: string;
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
        forgivingHint: k("A small spelling slip is forgiven; capitals and punctuation do not count"),
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
    assemble: {
        commitsOnSelect: false,
        grading: 'local',
        keyLabel: k("Correct answer:"),
        // Device-neutral ("press", the app's word) and true in every state:
        // it stays on screen when every gap is full and nothing is marked.
        hint: k("Press a piece to place it; press a placed piece to take it out"),
        label: k("Build from pieces"),
        blockAnswer: true,
    },
};

export const FORMAT_IDS = Object.keys(ANSWER_FORMATS) as AnswerFormat[];

/** The spec for a question, falling back to multiple choice for a row written before a format existed. */
export const formatOf = (question: Pick<QuizQuestion, 'type'>): FormatSpec =>
    ANSWER_FORMATS[question.type] ?? ANSWER_FORMATS.multiple_choice;

/**
 * The line under an open input, as the grader will actually judge it. A key,
 * not text: the caller renders it through `t()`.
 */
export const answerHint = (question: Pick<QuizQuestion, 'type'>, forgiveSpelling: boolean): string | undefined => {
    const { hint, forgivingHint } = formatOf(question);
    return (forgiveSpelling && forgivingHint) || hint;
};

/**
 * What an UNTOUCHED input already answers. An ordering is an answer from the
 * first render — the served order counts, and the server guarantees it is
 * never the key — so a learner who submits it as served is graded on that
 * order, not on "no answer". Every other format starts empty.
 */
export const defaultAnswer = (question: QuizQuestion): string =>
    question.type === 'sequence' ? JSON.stringify(question.items ?? []) : '';

/**
 * Is this answer whole enough to check? Anything entered, and for an assembly
 * every gap filled: a half-built sentence is not an attempt at the sentence,
 * and a stray tap on Check would grade it wrong.
 */
export function answerIsComplete(question: Pick<QuizQuestion, 'type' | 'template'>, answer: string): boolean {
    if (!answer.trim()) return false;
    if (question.type !== 'assemble') return true;
    const fill = readPieces(answer, { holes: true });
    return !!fill && fill.length === templateParts(question.template).length - 1 && fill.every(p => p !== null);
}

/**
 * An answer as a person reads it, for text that leaves the answer surface
 * ("Teach me this" sends both answers to a model). An assembly is drawn into
 * its template, an empty gap as `___`; an ordering is its steps in order.
 * Anything else, or anything unreadable, is the answer as stored.
 */
export function answerAsText(question: Pick<QuizQuestion, 'type' | 'template'>, answer: string | null | undefined): string {
    const stored = String(answer ?? '');
    if (question.type === 'assemble') {
        const parts = templateParts(question.template);
        const fill = readPieces(stored, { holes: true });
        if (!fill || fill.length !== parts.length - 1) return stored;
        return parts.map((part, i) => part + (i < fill.length ? (fill[i] ?? '___') : '')).join('').trim();
    }
    if (question.type === 'sequence') {
        const steps = parseSequence(stored);
        // The arrow points the way the line is read.
        return steps ? steps.join(isRtl() ? ' ← ' : ' → ') : stored;
    }
    return stored;
}

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

/**
 * How many letters a word may be off by and still count as a slip, by the
 * length of the word it should have been. Mirror of `slipBudget` in
 * `server/answerFormats.js`, which carries the reasoning.
 */
export function slipBudget(length: number): number {
    if (length < 5) return 0;
    return length < 9 ? 1 : 2;
}

/** Insert, delete, change or swap two neighbours: one edit each. */
function editDistance(a: string, b: string): number {
    // Only an accent may change in place, and a drop or an add may not follow
    // straight on from another (a drop beside an add is a changed letter:
    // hypothesis/hypotheses). See the server side.
    const s = [...a];
    const t = [...b];
    const grid = (): number[][] => Array.from({ length: s.length + 1 }, () => Array(t.length + 1).fill(Infinity));
    const kept = grid();
    const indel = grid();
    kept[0][0] = 0;
    for (let i = 0; i <= s.length; i++) {
        for (let j = 0; j <= t.length; j++) {
            if (i > 0 && j > 0) {
                const cost = s[i - 1] === t[j - 1] ? 0 : baseLetter(s[i - 1]) === baseLetter(t[j - 1]) ? 1 : Infinity;
                kept[i][j] = Math.min(kept[i][j], Math.min(kept[i - 1][j - 1], indel[i - 1][j - 1]) + cost);
                if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
                    kept[i][j] = Math.min(kept[i][j], Math.min(kept[i - 2][j - 2], indel[i - 2][j - 2]) + 1);
                }
            }
            if (i > 0) indel[i][j] = Math.min(indel[i][j], kept[i - 1][j] + 1);
            if (j > 0) indel[i][j] = Math.min(indel[i][j], kept[i][j - 1] + 1);
        }
    }
    return Math.min(kept[s.length][t.length], indel[s.length][t.length]);
}

const baseLetter = (ch: string) => ch.normalize('NFD').replace(/\p{M}+/gu, '');
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function isSlipOf(word: string, key: string): boolean {
    if (word === key) return true;
    if (/\p{N}/u.test(word) || /\p{N}/u.test(key)) return false;
    // A script written without spaces: one "word" is a phrase (see the server side).
    if (UNSPACED_SCRIPT.test(key)) return false;
    const budget = slipBudget([...key].length);
    if (budget === 0) return false;
    const w = [...word];
    const k = [...key];
    if (baseLetter(w[0] || '') !== baseLetter(k[0] || '')) return false;
    if (baseLetter(w[w.length - 1] || '') !== baseLetter(k[k.length - 1] || '')) return false;
    return editDistance(word, key) <= budget;
}

/**
 * The accepted spelling a typed `fill_in` answer slipped from, or null (also
 * null for an exact match). Only consulted when the learner switched on
 * `forgive_spelling`. Mirror of `spellingSlipOf` in `server/answerFormats.js`;
 * `tolerant-grading-gates.mjs` runs both against one table.
 */
export function spellingSlipOf(question: Pick<QuizQuestion, 'type' | 'correct_answer' | 'accept'>, answer: string): string | null {
    if (question?.type !== 'fill_in') return null;
    const given = normalizeTyped(answer);
    if (!given) return null;
    const written = [question.correct_answer, ...(Array.isArray(question.accept) ? question.accept : [])];
    if (written.some(w => normalizeTyped(w) === given)) return null;
    const words = given.split(' ');
    for (const w of written) {
        const key = normalizeTyped(w);
        if (!key) continue;
        const keyWords = key.split(' ');
        if (keyWords.length === words.length && keyWords.every((k, i) => isSlipOf(words[i], k))) {
            return String(w).trim();
        }
    }
    return null;
}

/**
 * The headline over an answer marked right (a key for `t()`). Right only
 * because a slip was forgiven, it says so: a bare "Correct" over a misspelling
 * teaches the misspelling.
 */
export function correctVerdict(question: Pick<QuizQuestion, 'type' | 'correct_answer' | 'accept'>, answer: string): string {
    return spellingSlipOf(question, answer) !== null ? k("Correct, with a spelling slip") : k("Correct");
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

/**
 * A template cut at its gaps: the fixed text between them, one more part than
 * there are gaps. Mirror of `templateParts` in `server/answerFormats.js`
 * (three or more underscores are a gap; one is a subscript, `H_2`).
 */
export function templateParts(template: string | null | undefined): string[] {
    return String(template ?? '').split(/_{3,}/);
}

/** What two pieces are compared as: NFC, trimmed, spacing folded, case KEPT (`CO` is not `Co`). */
export const foldPiece = (s: unknown): string => String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');

/**
 * A list of pieces from a stored JSON string, or null. `holes` lets an entry
 * be null — an empty gap in a learner's answer; otherwise every entry is a
 * string with something in it. Mirror of `readPieces` on the server.
 */
export function readPieces(value: unknown, { holes = false } = {}): (string | null)[] | null {
    let list: unknown = value;
    if (typeof value === 'string') {
        try { list = JSON.parse(value); } catch { return null; }
    }
    if (!Array.isArray(list)) return null;
    for (const p of list) {
        if (p === null && holes) continue;
        if (typeof p !== 'string' || !foldPiece(p)) return null;
    }
    return list as (string | null)[];
}

/** Can these pieces be built from this bank? Mirror of `bankHolds` on the server. */
export function bankHolds(tokens: unknown, pieces: unknown, reuse = false): boolean {
    if (!Array.isArray(tokens) || !Array.isArray(pieces)) return false;
    const left = new Map<string, number>();
    for (const t of tokens) left.set(foldPiece(t), (left.get(foldPiece(t)) || 0) + 1);
    for (const p of pieces) {
        const n = left.get(foldPiece(p)) || 0;
        if (!n) return false;
        if (!reuse) left.set(foldPiece(p), n - 1);
    }
    return true;
}

/** The key, then every declared other arrangement — each a full list, one piece per gap. */
export function arrangementsOf(q: Pick<QuizQuestion, 'correct_answer' | 'accept'>): string[][] {
    return [q?.correct_answer, ...(Array.isArray(q?.accept) ? q.accept : [])]
        .map(a => readPieces(a))
        .filter((a): a is string[] => !!a);
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

/**
 * Can this stored question be graded at all? A question that fails is left out
 * of the sitting, so it is never marked wrong against a correct answer and
 * never counted in the score. Mirror of `hasUsableKey` in
 * `server/answerFormats.js`, which carries the reasoning; `answer-format-gates.mjs`
 * runs both against one table.
 */
export function hasUsableKey(q: Partial<QuizQuestion> | null | undefined): boolean {
    if (!q || typeof q !== 'object') return false;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const key = q.correct_answer;
    switch (q.type) {
        case 'multiple_choice': {
            const opts = Array.isArray(q.options) ? q.options.filter(o => str(o)) : [];
            const k = str(key).toLowerCase();
            return opts.length >= 2 && !!k && opts.some(o => str(o).toLowerCase() === k);
        }
        case 'true_false':
            return /^(true|false)$/i.test(String(key ?? '').trim());
        case 'sequence': {
            let k: unknown;
            try { k = JSON.parse(String(key)); } catch { return false; }
            return Array.isArray(k) && k.length >= 3 && k.length <= 8 && k.every(item => str(item))
                && Array.isArray(q.items) && q.items.length === k.length;
        }
        case 'assemble': {
            const k = readPieces(key);
            return !!k && k.length >= 2 && k.length <= 8
                && templateParts(q.template).length - 1 === k.length
                && bankHolds(q.tokens, k, q.reuse === true);
        }
        case 'numeric':
            return parseNumber(key as string) !== null;
        case 'fill_in':
            return acceptedAnswers(q as QuizQuestion).length > 0;
        case 'short_answer':
        case 'code':
            return !!str(key);
        default:
            return false;
    }
}

/** Enter in a one-line answer field submits it, unless an input method is mid-composition. */
export function submitOnEnter(onSubmit: (() => void) | undefined) {
    if (!onSubmit) return undefined;
    return (e: import('react').KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit(); }
    };
}
