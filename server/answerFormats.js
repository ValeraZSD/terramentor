/**
 * The answer formats — the WAYS a learner can answer a graded question.
 *
 * A question's `type` cannot be a closed set of three (multiple choice,
 * true/false, short answer) normalised by hand in two reducers
 * (`normalizeFeedQuestion`, `finalizeQuiz`), described by hand in three prompts,
 * rendered by hand in three surfaces and graded by hand in two — under that
 * shape a fourth format means touching ten places, and a mastery engine for
 * cooking, code, chemistry and law cannot measure every subject with "pick one
 * of four": writing the function IS the skill, ordering the steps IS the skill.
 *
 * So the formats are a registry, the same move the visuals made
 * (`src/components/visuals/registry.ts`): one entry per format carrying what the
 * MODEL must author (`authoring`), how a raw generation is made honest
 * (`normalize` — return null rather than guess a key), the guess floor BKT
 * discounts it by, and whether it grades locally or needs the checker. The two
 * reducers dispatch here; the prompts read the shapes from here; mastery reads
 * the floors from here. The client mirrors the registry in
 * `src/components/answer/formats.ts` — `answer-format-gates.mjs` pins the two
 * key sets together, because a format the server authors and the client cannot
 * render is a question nobody can answer.
 *
 * Adding a format = one entry here, one input component on the client, and the
 * gate tells you what you forgot.
 */
import { normalizeChoice, sanitizeExplanation } from './agentic.js';
import { sameOption } from './questionOptions.js';

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** Fisher–Yates, on a copy. */
function shuffled(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/** Whitespace-insensitive equality — what a fallback comparison of two code samples can honestly claim. */
export const sameCode = (a, b) => text(a).replace(/\s+/g, ' ') === text(b).replace(/\s+/g, ' ');

/**
 * Give code its newlines back. `escapeLatexBackslashes` doubles every `\n` and
 * `\t` in the model's JSON on purpose — in prose they collide with `\nabla` and
 * `\times` — so a solution the model wrote as valid JSON arrives as ONE line
 * with the two characters `\` `n` where each line break was. A field that is
 * code holds no LaTeX, so when it has no real newline at all and does carry
 * those sequences, they are the line breaks. (A genuine `\n` inside a string
 * literal of a multi-line program keeps its real newlines and is left alone.)
 */
export function decodeEscapedNewlines(s) {
    const v = String(s ?? '');
    if (v.includes('\n') || !/\\[nrt]/.test(v)) return v;
    return v.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

const closedMatch = (q, answer) => text(answer).toLowerCase() === text(q.correct_answer).toLowerCase();

/**
 * One typed answer, reduced to the thing that is actually being graded.
 *
 * `fill_in` compares strings with no model in the room, so the whole honesty of
 * the format is this function: everything it folds away is something a learner
 * must NOT lose a mark for, and everything it keeps is something they must get
 * right. It keeps letters, digits and word boundaries — spelling, and only
 * spelling — and folds:
 *
 *  * **Case.** `Het` and `het` are one answer. A gap at the start of a sentence
 *    is capitalised and the same word mid-sentence is not, and the learner
 *    reading a recording back has no way to know which the key was written as.
 *  * **Punctuation, all of it, by DELETION rather than by substitution.**
 *    A dictation cannot hear a comma, and `don't` and `dont` must be one
 *    answer — which they are only if the apostrophe vanishes rather than
 *    becoming a space. `e-mail` and `email` likewise. A question whose answer
 *    IS a punctuation mark has to be asked another way, which the rule says.
 *  * **Runs of whitespace**, including the ones a phone keyboard adds.
 *
 * It deliberately does NOT fold diacritics: in the languages this exists for,
 * `één` is not `een` and `zoals` is not `zoáls`. A key with a genuine spelling
 * variant lists it in `accept` instead, which is the author saying so rather
 * than the grader guessing.
 *
 * NFC first, because a combining acute and a precomposed `é` are the same
 * letter to a reader and two different strings to `===` — and which one arrives
 * depends on the learner's keyboard, not on their Dutch.
 */
export function normalizeTyped(value) {
    return String(value ?? '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Every spelling a `fill_in` question accepts, normalised — the key and the
 * author's declared variants. Exported because the client mirrors the grader
 * and `answer-format-gates.mjs` runs both against one table.
 */
export function acceptedAnswers(question) {
    const all = [question?.correct_answer, ...(Array.isArray(question?.accept) ? question.accept : [])];
    const out = [];
    for (const candidate of all) {
        const norm = normalizeTyped(candidate);
        if (norm && !out.includes(norm)) out.push(norm);
    }
    return out;
}

/** How many alternative spellings one question may declare. */
export const MAX_ACCEPTED_ANSWERS = 8;

/** "3.0 × 10^8", "3.0 x 10**8" — how a physics answer is written outside a programming language. */
const SCIENTIFIC = /[×x*]\s*10\s*(?:\^|\*\*)?\s*([-+]?\d+)/i;

/**
 * Read a number the way a learner actually types one, or null.
 *
 * This is the whole honesty of the numeric format, so it is deliberately
 * generous about NOTATION and strict about VALUE. Four things a learner does
 * that a bare `Number()` calls wrong:
 *
 *  * **A decimal comma.** He studies in Dutch and half the material is Dutch;
 *    `0,5` is not a typo there, and marking it wrong would be marking the
 *    locale wrong. `,` and `.` are both decimal points here.
 *  * **Grouped digits.** `1 000 000`, `1'000`, `1_000`. A space, apostrophe or
 *    underscore between two digits only ever groups them.
 *  * **Both separators, or one of them twice.** `1.234,56` and `1,234.56` are
 *    the same number in two conventions: the LAST separator is the decimal
 *    point and the rest group. `1,000,000` repeats one separator, so that one
 *    groups. A single separator is always the decimal point — `1,000` reads as
 *    one, which is why the input shows the unit and asks for a plain number.
 *  * **The unit, typed anyway.** The unit is displayed beside the box and is
 *    NEVER graded: `m/s^2` and `m/s²` are the same answer and no string match
 *    can say so. So a trailing remainder is ignored rather than rejected, and
 *    only the number in front of it is judged.
 *
 * A simple fraction is read as one (`3/4`), because a maths answer is often
 * written that way and refusing it would be grading the notation again.
 */
export function parseNumber(value) {
    let s = String(value ?? '').trim();
    if (!s) return null;
    // "≈ 9.8", "= 9.8", "$5" — approximation marks, a stray equals and a leading
    // currency symbol are packaging around the number, not part of it.
    s = s.replace(/^[=~≈≃]+\s*/, '').replace(/^[$€£¥]\s*/, '').trim();
    // Fold "× 10^8" into an exponent before the separator rules touch anything.
    const sci = s.match(SCIENTIFIC);
    if (sci) s = `${s.slice(0, sci.index).trim()}e${sci[1]}`;
    // Grouping characters, repeatedly: one pass only reaches every other gap in
    // "1 000 000". (No lookbehind — this logic is mirrored in TypeScript and
    // shipped to browsers that did not all have it.)
    let prev;
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

/**
 * How far off an answer may be when nobody said: half a unit in the last place
 * the key was WRITTEN to.
 *
 * This is the reading every science teacher already applies — "9.81" claims
 * three significant figures and therefore means 9.805…9.815 — so it needs no
 * explaining to a learner, and it takes its precision from the key's own
 * notation rather than from a number the model would otherwise have to invent.
 * `40` gets ±0.5, `0.00450` gets ±0.000005, `1.5e3` gets ±50.
 */
export function defaultTolerance(written) {
    const s = text(written).replace(/\s+/g, '');
    if (parseNumber(s) === null) return 0;
    const sci = s.match(/[eE]([-+]?\d+)$|[×x*]10(?:\^|\*\*)?([-+]?\d+)$/);
    const exponent = sci ? Number(sci[1] ?? sci[2]) : 0;
    const mantissa = sci ? s.slice(0, sci.index) : s;
    const decimals = mantissa.match(/[.,](\d+)/);
    return 0.5 * Math.pow(10, exponent - (decimals ? decimals[1].length : 0));
}

/**
 * A fence tag that is a VISUAL, not a language the learner could write. The
 * server's advertised visual kinds plus the aliases the markdown pipeline
 * accepts; kept as a literal set because the visual registry lives on the
 * client and this file must not reach into it.
 */
export const VISUAL_FENCES = new Set([
    'mermaid', 'vega-lite', 'vega', 'plot', 'smiles', 'math', 'latex-math', 'animation', 'p5', 'widget', 'drill', 'svg',
]);
/** Fence tags that mark prose or program OUTPUT rather than something to write. */
const NOT_A_LANGUAGE = new Set([
    'text', 'txt', 'plaintext', 'plain', 'md', 'markdown', 'output', 'console', 'diff', 'stdout', 'shell-session', 'none', 'mathematica',
]);

/** A language tag as a model or an importer writes it: short, lowercase-able, no spaces. */
const LANGUAGE_TAG = /^[a-z0-9+#.-]{1,24}$/;

/**
 * The first programming language a lesson segment shows code in, or null.
 *
 * This is how the feed decides a segment earns a code question: not from the
 * topic's title (a "Python for data analysis" course has segments about
 * statistics) but from what the segment itself demonstrates. A fenced block
 * tagged with a language is the author saying "this is what you write here".
 */
export function codeLanguageIn(markdown) {
    const re = /^ {0,3}(?:```|~~~)([A-Za-z0-9+#.-]{1,24})\b/gm;
    let m;
    while ((m = re.exec(String(markdown || '')))) {
        const tag = m[1].toLowerCase();
        if (VISUAL_FENCES.has(tag) || NOT_A_LANGUAGE.has(tag)) continue;
        return tag;
    }
    return null;
}

/** Numbered steps in a segment: three or more and it is teaching a procedure. */
export function countsProcedure(markdown) {
    const steps = String(markdown || '').match(/^\s{0,3}\d{1,2}[.)]\s+\S/gm);
    return !!steps && steps.length >= 3;
}

export const ANSWER_FORMATS = {
    multiple_choice: {
        guess: 0.25,
        grading: 'local',
        authoring: {
            shape: '{"question": "...", "type": "multiple_choice", "options": ["...", "...", "...", "..."], "correct_answer": "...", "explanation": "..."}',
            rule: 'Exactly 4 options; correct_answer must EXACTLY equal one option string. Distractors must be plausible mistakes, not jokes.',
        },
        normalize(raw) {
            const opts = Array.isArray(raw.options)
                ? raw.options.filter(o => typeof o === 'string' && o.trim())
                : [];
            if (opts.length < 2) return null; // degenerate MCQ — ungradeable
            let correct = raw.correct_answer;
            if (!opts.includes(correct)) {
                const target = normalizeChoice(correct);
                const match = opts.find(o => normalizeChoice(o) === target);
                if (!match) return null; // can't identify the key — drop, never guess A
                correct = match;
            }
            // Resolve "the first option" / "option B" against the text they point
            // at, and cut any self-arguing tail — BEFORE the shuffle, while the
            // model's own ordering still holds. Then shuffle before the learner
            // ever sees the options: local models put the key first far too
            // often, and every grader matches by string VALUE, so reordering
            // cannot desync the key.
            const explanation = sanitizeExplanation(text(raw.explanation), opts);
            return { options: shuffled(opts), correct_answer: correct, explanation };
        },
        grade: closedMatch,
    },

    true_false: {
        guess: 0.5,
        grading: 'local',
        authoring: {
            shape: '{"question": "...", "type": "true_false", "correct_answer": "True", "explanation": "..."}',
            rule: 'correct_answer must be exactly "True" or "False". Write "question" as a DECLARATIVE STATEMENT the learner judges — never as a question ending in "?", because the card offers True and False, and "Can X do Y?" reads as unanswerable against those two buttons. The statement must hinge on a real distinction the learner could get wrong for a REASON — a boundary case, a confusable pair, a condition that must hold. Never simply negate a sentence from the segment: that tests whether they remember its wording, and a coin already scores 50%.',
        },
        normalize(raw) {
            const normalized = raw.correct_answer?.toString().toLowerCase().trim();
            if (normalized !== 'true' && normalized !== 'false') return null; // no honest key
            return {
                correct_answer: normalized === 'true' ? 'True' : 'False',
                explanation: sanitizeExplanation(text(raw.explanation)),
            };
        },
        grade: closedMatch,
    },

    short_answer: {
        guess: 0.05,
        grading: 'ai',
        authoring: {
            shape: '{"question": "...", "type": "short_answer", "correct_answer": "...", "explanation": "..."}',
            rule: 'An open question answerable in 1-3 sentences; correct_answer is the model answer it will be graded against. It must be gradeable: state what a correct answer has to contain.',
        },
        normalize(raw) {
            const ca = text(raw.correct_answer);
            if (!ca) return null;
            return { correct_answer: ca, explanation: sanitizeExplanation(text(raw.explanation)) };
        },
        grade: () => null,
    },

    /**
     * The learner TYPES THE ANSWER, and it is checked HERE — no model.
     *
     * The format the language half of the library was missing, and the one a
     * whole imported course was being flattened into "pick one of four" for
     * want of. A Dutch course built from real material asked 189 questions that
     * literally say "вставьте пропущенное слово" and 346 that say "переведите",
     * and every one of them offered two to four tiles: the learner proved they
     * could RECOGNISE `om` among `in`, `op`, `om`, which is not the skill. A
     * gap has nothing to eliminate.
     *
     * `short_answer` could not do this job. It is `grading: 'ai'`, so a gap
     * worth one word would cost a model call — absurd for `om` versus `op`,
     * impossible with no endpoint configured, and barred from a saved quiz
     * because a Boss Fight must reach a verdict with no model in the room.
     * This one grades locally, so a typed answer on an assessment does not
     * have to be a calculation.
     *
     * What it grades is `normalizeTyped` equality against the key or any
     * `accept` variant: spelling, and only spelling. That is the boundary of
     * where it is honest — a question whose answer could be phrased several
     * ways is a `short_answer`, and the rule says so.
     */
    fill_in: {
        // Typed, so there is nothing to eliminate and nothing to recognise —
        // the same floor as the other typed formats. A one-letter gap in a
        // closed set (de/het) is still occasionally hit blind, which is why
        // this is not lower.
        guess: 0.05,
        grading: 'local',
        authoring: {
            shape: '{"question": "... ___ ...", "type": "fill_in", "correct_answer": "<the answer, written exactly>", "accept": ["<another answer that is equally correct>"], "explanation": "..."}',
            rule: 'A question answered by TYPING a short answer that has ONE definite written form — the missing word in a sentence, the form of a verb, the article, the term for a definition, the translation of a single word, the sentence that was dictated. Mark a gap in the sentence with "___". "correct_answer" is that answer ALONE, written exactly as it should be: no quotation marks, no "the answer is", no alternatives inside it. "accept" lists any OTHER answer that is equally correct — a synonym, a second admissible spelling, a word order that is also right — because a learner who was right and was marked wrong stops trusting the whole course; leave it out when there genuinely is only one. Capitals and punctuation are NOT graded and spelling IS. Never use this when the answer is something the learner could correctly phrase several ways, or when it is a number: those are "short_answer" and "numeric".',
        },
        normalize(raw) {
            const key = text(raw.correct_answer);
            // Nothing a learner could type would match a key that is entirely
            // punctuation — an unanswerable question measures nothing, so it is
            // dropped rather than served.
            if (!normalizeTyped(key)) return null;
            const out = {
                correct_answer: key,
                explanation: sanitizeExplanation(text(raw.explanation)),
            };
            if (Array.isArray(raw.accept)) {
                const seen = [normalizeTyped(key)];
                const accept = [];
                for (const variant of raw.accept) {
                    const written = text(variant);
                    const norm = normalizeTyped(written);
                    // A variant that grades the same as the key already counts;
                    // keeping it would only pad the key's margin ("also: Het").
                    if (!norm || seen.includes(norm)) continue;
                    seen.push(norm);
                    accept.push(written);
                    if (accept.length >= MAX_ACCEPTED_ANSWERS) break;
                }
                if (accept.length) out.accept = accept;
            }
            return out;
        },
        grade(q, answer) {
            const given = normalizeTyped(answer);
            if (!given) return false;
            return acceptedAnswers(q).includes(given);
        },
    },

    /**
     * The learner TYPES A NUMBER they worked out.
     *
     * The format the quantitative half of the library was missing. `feedGen`'s
     * `pickQuestionType` already said, in a comment, that "a segment carrying
     * real quantities earns a calculation, which is the question type that
     * actually discriminates" — and then returned `multiple_choice`, because a
     * calculation had nowhere to go. Four options under "solve 2^(x+1) = 16"
     * can be back-substituted one at a time until one fits, so the learner
     * proves they can CHECK four candidates, and BKT is told they can solve it.
     * Typing the answer removes that road: there is nothing to eliminate.
     *
     * It grades LOCALLY, which is the other half of the point. A Boss Fight
     * must reach a verdict with no model in the room, so the only formats a
     * saved quiz admits unasked are the local ones — until now, "pick one of
     * four", "true or false" and "put these in order". A calculation can now
     * carry an assessment.
     *
     * `unit` is DISPLAYED beside the input and never graded: `m/s^2`, `m/s²`
     * and `meters per second squared` are one answer that no string comparison
     * can unify, and a learner who knows the physics should not lose the mark
     * to a superscript. What is graded is the number, within `tolerance`.
     */
    numeric: {
        // Nothing to eliminate and nothing to recognise, so this sits with the
        // other typed formats rather than below them: a small whole-number
        // answer can still occasionally be hit blind, which "write a program"
        // cannot.
        guess: 0.05,
        grading: 'local',
        authoring: {
            shape: '{"question": "...", "type": "numeric", "correct_answer": "9.81", "unit": "m/s^2", "tolerance": 0.01, "explanation": "..."}',
            rule: 'A question answered with ONE number the learner WORKS OUT — never a number they can read straight off the segment, which tests only whether they scrolled back. Say exactly what to compute and in which unit. "correct_answer" is the number ALONE: no unit, no words, no thousands separators, written to the significant figures the answer really has. "unit" is the unit the number must be in ("m/s^2", "kg", "%", or "" when it is a pure count) — it is shown beside the input and is never graded, so never ask for the unit in words. "tolerance" is how far off the answer may be, as an absolute amount in that unit: set it from the rounding the working forces, so a two-step calculation from values given to three significant figures gets a wider one than an exact count, which gets 0.',
        },
        normalize(raw) {
            const written = text(raw.correct_answer);
            const key = parseNumber(written);
            if (key === null) return null; // not a number: no honest key
            const out = {
                correct_answer: written,
                explanation: sanitizeExplanation(text(raw.explanation)),
            };
            const unit = text(raw.unit).replace(/\s+/g, ' ').slice(0, 16);
            if (unit) out.unit = unit;
            // A tolerance that is missing, not a number, negative, or so wide it
            // would accept half the answer's own size (which accepts the wrong
            // order of magnitude) falls back to the key's own precision rather
            // than failing the question — an unanswerable card measures nothing,
            // and this one is still gradeable.
            const stated = Number(raw.tolerance);
            const honest = Number.isFinite(stated) && stated >= 0
                && (key === 0 || stated <= Math.abs(key) * 0.5);
            out.tolerance = honest ? stated : defaultTolerance(written);
            return out;
        },
        grade(q, answer) {
            const given = parseNumber(answer);
            if (given === null) return false;
            const key = parseNumber(q.correct_answer);
            if (key === null) return false;
            const stated = Number(q.tolerance);
            const tol = Number.isFinite(stated) && stated >= 0 ? stated : defaultTolerance(q.correct_answer);
            // A hair of slack for binary floating point: 0.1 + 0.2 is not 0.3,
            // and a difference of exactly the tolerance must still pass.
            return Math.abs(given - key) <= tol * (1 + 1e-9) + 1e-12;
        },
    },

    /**
     * The learner WRITES CODE. `language` names the editor mode and tells the
     * grader what it is reading; `starter` is optional scaffolding (a signature,
     * a stub) that must never be the solution; `correct_answer` is a reference
     * solution, shown after grading. Graded by the checker on BEHAVIOUR, never
     * by text — a different variable name is not a wrong answer — so it needs a
     * model, exactly like a short answer; the fallback is a whitespace-blind
     * comparison that is honest about being ungraded.
     */
    code: {
        guess: 0.02,
        grading: 'ai',
        authoring: {
            shape: '{"question": "...", "type": "code", "language": "python", "starter": "def f(x):\\n    ...", "correct_answer": "<a complete reference solution>", "explanation": "..."}',
            rule: 'A SMALL programming task the learner solves by writing code: name the function or program to write, its inputs, what it must return or print, and one example call with its result. It must be solvable in at most 15 lines. "language" is the language the material uses (lowercase, e.g. "python", "javascript", "sql"). "starter" is OPTIONAL scaffolding — a signature or a stub with the body left out — and must never contain the solution. "correct_answer" is a complete, correct reference solution in that language, and nothing else: no prose, no fences.',
        },
        normalize(raw) {
            const language = text(raw.language).toLowerCase();
            if (!LANGUAGE_TAG.test(language) || VISUAL_FENCES.has(language)) return null;
            let solution = decodeEscapedNewlines(text(raw.correct_answer));
            // A model that fences its solution despite the rule: unwrap rather
            // than drop — the fence is packaging, the code inside is the key.
            const fenced = solution.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
            if (fenced) solution = fenced[1].trim();
            if (solution.length < 3) return null;
            const out = { language, correct_answer: solution, explanation: sanitizeExplanation(text(raw.explanation)) };
            const starter = typeof raw.starter === 'string' ? decodeEscapedNewlines(raw.starter).replace(/\s+$/, '') : '';
            // Scaffolding that IS the answer gives the question away.
            if (starter.trim() && !sameCode(starter, solution)) out.starter = starter;
            return out;
        },
        grade: () => null,
    },

    /**
     * The learner PUTS ITEMS IN ORDER — the steps of a procedure, the events of
     * a period, the stages of a reaction, the lines of a proof, the words of a
     * sentence. The model authors `items` in the CORRECT order; the key is that
     * order (as JSON, in `correct_answer`) and what the learner sees is a
     * shuffle of it. Graded locally on exact order: partial credit for "nearly
     * right" would be a second scoring rule the rest of the engine does not
     * have.
     */
    sequence: {
        guess: 0.05,
        grading: 'local',
        authoring: {
            shape: '{"question": "...", "type": "sequence", "items": ["first", "second", "third", "fourth"], "explanation": "..."}',
            rule: 'An ORDERING task, never a choice: "question" says what to put in order and by what (the steps of a procedure, chronology, cause before effect, size, precedence); "items" lists 3-7 short STEPS, EVENTS or STAGES — things that happen one after another — IN THE CORRECT ORDER, and the app shuffles them. Items are never alternative outcomes, explanations or answer options, and the learner never picks one: they arrange all of them. Every item must be a distinct thing whose place can be reasoned out; never number the items or hint at the order inside them. A procedure the segment teaches MAY be asked, applied to a new situation (a different dish, input or case) and with the steps in your own words rather than the segment\'s sentences.',
        },
        normalize(raw) {
            const items = Array.isArray(raw.items)
                ? raw.items.filter(o => typeof o === 'string' && o.trim()).map(o => o.trim())
                : [];
            if (items.length < 3 || items.length > 8) return null;
            for (let i = 0; i < items.length; i++) {
                for (let j = i + 1; j < items.length; j++) {
                    if (sameOption(items[i], items[j])) return null; // two items that are one thing: no honest order
                }
            }
            // Strip a numbering the model added despite the rule ("1. Mix").
            const clean = items.map(s => s.replace(/^\s*(?:\d{1,2}|[a-hA-H])[.)]\s+/, ''));
            const key = JSON.stringify(clean);
            // The served order must differ from the key, or the question answers itself.
            let served = shuffled(clean);
            for (let tries = 0; tries < 8 && JSON.stringify(served) === key; tries++) served = shuffled(clean);
            if (JSON.stringify(served) === key) return null;
            return { items: served, correct_answer: key, explanation: sanitizeExplanation(text(raw.explanation)) };
        },
        grade(q, answer) {
            let given;
            try { given = JSON.parse(String(answer)); } catch { return false; }
            let key;
            try { key = JSON.parse(String(q.correct_answer)); } catch { return false; }
            if (!Array.isArray(given) || !Array.isArray(key) || given.length !== key.length) return false;
            return given.every((item, i) => text(item) === text(key[i]));
        },
    },
};

export const FORMAT_IDS = Object.keys(ANSWER_FORMATS);

/** Guess floor per format — what BKT discounts a correct answer by. */
export const GUESS_BY_FORMAT = Object.fromEntries(FORMAT_IDS.map(id => [id, ANSWER_FORMATS[id].guess]));

/**
 * The format-specific half of normalising a raw generated question: the fields
 * the format owns, made honest, or null when no honest key can be identified.
 * `allow(format, id)` lets a reducer refuse formats it cannot grade in its own
 * setting (a saved quiz and its Boss Fight must stay gradeable without a model
 * unless the learner asked for that format by name).
 */
export function normalizeQuestionFormat(raw, { allow } = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const format = ANSWER_FORMATS[raw.type];
    if (!format) return null;
    if (allow && !allow(format, raw.type)) return null;
    return format.normalize(raw);
}

/** Local verdict for a closed format; null when the format needs the checker. */
export function gradeLocally(question, answer) {
    const format = ANSWER_FORMATS[question?.type];
    if (!format || format.grading !== 'local') return null;
    return format.grade(question, answer);
}

/** The JSON shape and the authoring rule a prompt states for one format. */
export function formatAuthoring(type) {
    return ANSWER_FORMATS[type]?.authoring || ANSWER_FORMATS.multiple_choice.authoring;
}
