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
import { normalizeChoice, sanitizeExplanation, LATEX_NR_COMMANDS } from './agentic.js';
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

/**
 * Caps for a code question's tests. Mirror: `codeTestsOf` in
 * src/runner/languages.ts (and `MAX_TESTS` in src/runner/protocol.ts).
 */
export const CODE_TEST_LIMITS = Object.freeze({ maxTests: 12, fieldMax: 2000, totalMax: 16000 });

/**
 * A code question's tests, made honest: each one an INPUT for the browser's
 * code runner (src/runner/), either a `call` (one expression, evaluated after
 * the code has run) or a `stdin` (the program's input; what it prints is
 * compared), never both, with an optional `expect`, what the author believed
 * the reference produces. Expected results are never taken from here: the
 * runner computes them by running the reference solution, and an `expect` that
 * disagrees makes the tests unusable rather than the reference wrong. Anything
 * else is dropped; at most `maxTests`, each field at most `fieldMax`
 * characters, all of them together at most `totalMax` (a test that does not
 * fit is skipped, a later smaller one still kept); a list mixing the two kinds
 * is no list at all. Fewer than three tests are kept as Run's input but grade
 * nothing (`testsToGradeBy`, src/runner/languages.ts). A standard input and
 * its printed output get their newlines back the way code does; a call is
 * left as written, since a `\n` inside it is the language's own escape.
 */
export function normalizeCodeTests(raw) {
    if (!Array.isArray(raw)) return [];
    const { maxTests, fieldMax, totalMax } = CODE_TEST_LIMITS;
    const out = [];
    let total = 0;
    for (const t of raw) {
        if (out.length >= maxTests) break;
        if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
        const call = typeof t.call === 'string' ? t.call.trim() : '';
        const stdin = typeof t.stdin === 'string' ? decodeEscapedNewlines(t.stdin) : null;
        if ((call && stdin !== null) || (!call && stdin === null)) continue;
        let expect;
        if (typeof t.expect === 'string') expect = stdin !== null ? decodeEscapedNewlines(t.expect) : t.expect.trim();
        else if (typeof t.expect === 'number' || typeof t.expect === 'boolean') expect = String(t.expect);
        const size = call.length + (stdin?.length ?? 0) + (expect?.length ?? 0);
        if (call.length > fieldMax || (stdin?.length ?? 0) > fieldMax || (expect?.length ?? 0) > fieldMax) continue;
        if (total + size > totalMax) continue;
        total += size;
        const test = call ? { call } : { stdin };
        if (expect !== undefined) test.expect = expect;
        out.push(test);
    }
    // One list tests one contract: a function's return values or a program's
    // printed output. A list of both cannot say which task the learner was set.
    if (out.some((t) => 'call' in t) && out.some((t) => 'stdin' in t)) return [];
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

/**
 * The same repair for an assembly's template, which is prose with maths in
 * it rather than code: a row break the model wrote as `\n` arrives as the two
 * characters `\` `n`, and the rows run into one line. Only OUTSIDE a `$…$`
 * span is it a break, because inside one it is `\nu` or `\neq`; outside one, a
 * TeX command the model left bare (`\rightarrow`, `\neq`) is still a command,
 * read from the same closed list the JSON reader uses. A template that already
 * holds a real newline, or none of these, is left alone.
 */
function decodeTemplateNewlines(s) {
    if (s.includes('\n') || !/\\[nr]/.test(s)) return s;
    const rowBreak = (m) => {
        if (m === '\\r\\n') return '\n';
        return LATEX_NR_COMMANDS.has(m.slice(1)) ? m : `\n${m.slice(2)}`;
    };
    return s.split(/(\$\$?[^$]*\$\$?)/).map((bit, i) => (i % 2 ? bit : bit.replace(/\\r\\n|\\[nr][a-zA-Z]*/g, rowBreak))).join('');
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
 * depends on the learner's keyboard, not on their spelling.
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
 *  * **A decimal comma.** In many locales `0,5` is not a typo, and marking it
 *    wrong would be marking the locale wrong. `,` and `.` are both decimal points here.
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

// One chemical formula, written any of the ways a lesson writes it: `CH₄`,
// `Ca(OH)2`, `2H2O`, with a state symbol after it. Each repetition starts with
// a capital or a bracket, so the pattern cannot backtrack exponentially.
const FORMULA = String.raw`(?:\d+\s*)?(?:\((?:[A-Z][a-z]?[\d₀-₉]*)+\)[\d₀-₉]*|[A-Z][a-z]?[\d₀-₉]*)+(?:\((?:s|l|g|aq)\))?`;
const REACTION_ARROW = String.raw`(?:→|⟶|⇌|<=>|->|\\(?:long)?rightarrow|\\rightleftharpoons)`;
const REACTION = new RegExp(String.raw`${FORMULA}(?:\s*\+\s*${FORMULA})*\s*${REACTION_ARROW}\s*${FORMULA}(?:\s*\+\s*${FORMULA})*`, 'g');
// A segment that is ABOUT word order, in the languages a course is most often
// taught from or in. Leading boundary only, so plurals and compounds count.
const WORD_ORDER = /(?:^|[^\p{L}])(?:word order|verb[- ]second|subordinate clause|woordvolgorde|inversie|bijzin|zinsbouw|wortstellung|satzbau|nebensatz|verbzweitstellung|ordre des mots|orden de (?:las )?palabras|порядок слов|порядок слів)/iu;
// The same lesson often says it without those words: the verb-second rule by
// its name (V2) or by its place ("in position 2", "an zweiter Stelle", "на
// втором месте"), or as inversion. Each of these also names something else (a
// gas law's V2, a chord's inversion, the second position of an array), so they
// count only in a segment that also talks about a verb, anywhere in it: a
// lesson names the rule in one sentence and the verb in the next. A number
// that runs on (`V2.0`, `position 2.5`, `x_V2`) is not the rule.
const VERB_POSITION = /(?:^|[^\p{L}\d_])(?:(?:position|slot|place|plaats|positie|plek)\s+(?:2|two)(?![\p{L}\d_]|[.,]\d)|(?:second|2nd|seconde|deuxième)\s+(?:position|place|slot)|(?:comes?|goes|stands?|sits?)\s+second(?!\p{L})|inversi[oó]n|tweede\s+(?:plaats|positie|plek)|(?:zweite[nrms]?|2\.)\s+(?:stelle|position)|segunda\s+posici[oó]n|segundo\s+lugar|(?:втор(?:ое|ом|ую|ой)|2-?м)\s+(?:мест|позици)|друг(?:е|ому|у|ій)\s+(?:місц|позиці)|инверси|інверсі)/iu;
const V2_RULE = /(?:^|[^\p{L}\d_])V2(?![\p{L}\d_]|[.,]\d)/u; // capital only: "api v2" is a version
const VERB = /(?:^|[^\p{L}])(?:(?:verb(?:s|en|e|es)?|werkwoord(?:en)?|persoonsvorm(?:en)?|verbos?)(?!\p{L})|глагол|дієслов)/iu;

/**
 * Does this lesson segment SHOW something the learner could assemble?
 *
 * Two things, read for precision rather than recall, because a false hit
 * spends a topic's one assembly on a segment with nothing to build:
 *
 *  * **A chemical reaction** — formulas on both sides of a reaction arrow,
 *    with a `+` AND a digit (a coefficient or a subscript) in it. That keeps
 *    the commonest look-alikes out, `P → Q` (logic), `A + B → C` (algebra) and
 *    `S1 → S2` (a state machine), but not all of them: `S1 + S2 → S3` still
 *    reads as a reaction. A false hit costs one try; the format is then
 *    recorded as tried (`triedType`) and not asked for again on that topic.
 *  * **A segment teaching word order** — where building the sentence from its
 *    words IS the check, and "pick the right sentence of four" only proves the
 *    learner can recognise one. Named as word order, or as where the verb
 *    goes: lessons on the verb-second rule mostly say "position 2", "V2" or
 *    "inversion" instead. A segment that uses one of those words for
 *    something else AND mentions a verb (a REST lesson's "API V2" beside an
 *    HTTP verb) is a false hit, at the same price of one try.
 */
export function showsAssembly(markdown) {
    const text = String(markdown || '');
    if (WORD_ORDER.test(text)) return true;
    if ((V2_RULE.test(text) || VERB_POSITION.test(text)) && VERB.test(text)) return true;
    for (const m of text.matchAll(REACTION)) {
        if (/\+/.test(m[0]) && /[\d₀-₉]/.test(m[0])) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// assemble: pieces into gaps

/** Three or more underscores in a row are a gap; one is a subscript (`H_2`). */
const GAP = /_{3,}/;
export const ASSEMBLE_LIMITS = Object.freeze({ minGaps: 2, maxGaps: 8, maxDistractors: 4, minBank: 3, maxPiece: 48, maxAccept: 4, maxTemplate: 800 });

/**
 * A template cut at its gaps: the fixed text BETWEEN the gaps, one more part
 * than there are gaps. `"a ___ b ___"` → `["a ", " b ", ""]`. Mirrored in
 * `formats.ts`, where the input draws one gap between each two parts.
 */
export function templateParts(template) {
    return String(template ?? '').split(GAP);
}

/** What two pieces are compared as: the same letters, however the keyboard composed them, with spacing folded. Case is kept — `CO` is not `Co`. */
const foldPiece = (s) => String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');

/**
 * A list of pieces from an authored array or a stored JSON string, or null.
 * `holes: true` lets an entry be null (an empty gap in a learner's answer);
 * otherwise every entry must be a string with something in it.
 */
export function readPieces(value, { holes = false } = {}) {
    let list = value;
    if (typeof value === 'string') {
        try { list = JSON.parse(value); } catch { return null; }
    }
    if (!Array.isArray(list)) return null;
    for (const p of list) {
        if (p === null && holes) continue;
        if (typeof p !== 'string' || !foldPiece(p)) return null;
    }
    return list;
}

/** A piece made tidy, or null when it cannot be one: empty, a gap marker inside, or prose rather than a piece. */
function cleanPiece(value) {
    if (typeof value !== 'string') return null;
    const p = value.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!p || GAP.test(p) || p.length > ASSEMBLE_LIMITS.maxPiece) return null;
    return p;
}

/**
 * Can these pieces be built from this bank? A reusable bank only has to hold
 * each piece once; any other bank, as often as the arrangement uses it.
 */
export function bankHolds(tokens, pieces, reuse = false) {
    if (!Array.isArray(tokens) || !Array.isArray(pieces)) return false;
    const left = new Map();
    for (const t of tokens) left.set(foldPiece(t), (left.get(foldPiece(t)) || 0) + 1);
    for (const p of pieces) {
        const n = left.get(foldPiece(p)) || 0;
        if (!n) return false;
        if (!reuse) left.set(foldPiece(p), n - 1);
    }
    return true;
}

/**
 * How many different ways a learner can fill the gaps from this bank: every
 * distinct row of `gaps` pieces. A palette (`reuse`) allows any piece in any
 * gap; otherwise each copy of a piece is used once, and two copies of the same
 * piece are one choice, not two (k! · [x^k] Π Σ_{j≤c} x^j / j!).
 */
export function fillsPossible(tokens, gaps, reuse = false) {
    const counts = new Map();
    for (const t of tokens) counts.set(foldPiece(t), (counts.get(foldPiece(t)) || 0) + 1);
    if (reuse) return counts.size ** gaps;
    let poly = [1];
    for (const c of counts.values()) {
        const next = new Array(gaps + 1).fill(0);
        for (let a = 0; a < poly.length; a++) {
            let inv = 1;
            for (let j = 0; j <= c && a + j <= gaps; j++) {
                if (j > 0) inv /= j;
                next[a + j] += poly[a] * inv;
            }
        }
        poly = next;
    }
    let fact = 1;
    for (let i = 2; i <= gaps; i++) fact *= i;
    return Math.round(poly[gaps] * fact);
}

/** A blind guess may not do better than at a multiple choice of four. */
const MAX_BLIND_HIT = 0.25;

/**
 * Does the bank, read left to right with the distractors taken out, spell the
 * key? Then tapping the pieces in order builds the answer. A key whose pieces
 * are all the same text has no order to give away.
 */
export function servedInKeyOrder(tokens, key, distractors = []) {
    const keyFold = key.map(foldPiece);
    if (new Set(keyFold).size < 2) return false;
    const spare = new Set((distractors || []).map(foldPiece));
    const shown = (tokens || []).map(foldPiece).filter(t => !spare.has(t));
    return JSON.stringify(shown) === JSON.stringify(keyFold);
}

/** Every arrangement a question accepts: the key, then each declared other one. */
function arrangementsOf(q) {
    return [q?.correct_answer, ...(Array.isArray(q?.accept) ? q.accept : [])]
        .map(a => readPieces(a))
        .filter(Boolean);
}

/**
 * Does a VERIFIER's fill agree with the key or a declared other arrangement?
 *
 * Each piece the verifier wrote is read as the bank piece it names: the one
 * with the same text, or else the ONE piece that is the same once
 * compatibility forms are folded (NFKC), so a model that copies `H₂O` as
 * `H2O` has copied it. When two pieces fold together (`Fe²⁺` and the
 * distractor `Fe2+`), only the exact text says which was meant, and a folded
 * copy names neither. Case still counts.
 */
export function assemblyAgrees(fill, q) {
    if (!Array.isArray(fill)) return false;
    const arrangements = arrangementsOf(q);
    const bank = Array.isArray(q?.tokens) ? q.tokens
        : [...arrangements.flat(), ...(Array.isArray(q?.distractors) ? q.distractors : [])];
    const loose = (s) => foldPiece(String(s ?? '').normalize('NFKC'));
    const named = (p) => {
        const exact = bank.find(t => foldPiece(t) === foldPiece(p));
        if (exact !== undefined) return foldPiece(exact);
        const near = [...new Set(bank.filter(t => loose(t) === loose(p)).map(foldPiece))];
        return near.length === 1 ? near[0] : null;
    };
    const read = fill.map(named);
    if (read.some(p => p === null)) return false;
    return arrangements.some(a => a.length === read.length && a.every((p, i) => foldPiece(p) === read[i]));
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
     * The format language material needs. Without it, "fill in the missing
     * word" and "translate" questions are flattened into "pick one of four":
     * the learner proves they can RECOGNISE `om` among `in`, `op`, `om`, which
     * is not the skill. A gap has nothing to eliminate.
     *
     * `short_answer` cannot do this job. It is `grading: 'ai'`, so a gap
     * worth one word would cost a model call — absurd for `om` versus `op`,
     * impossible with no endpoint configured, and barred from a saved quiz
     * because a mastery check must reach a verdict with no model in the room.
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
     * The format quantitative material needs. `feedGen`'s `pickQuestionType`
     * gives a segment carrying real quantities a calculation, the question type
     * that actually discriminates. Four options under "solve 2^(x+1) = 16" can
     * be back-substituted one at a time until one fits, so the learner proves
     * they can CHECK four candidates, and BKT is told they can solve it. Typing
     * the answer removes that road: there is nothing to eliminate.
     *
     * It grades LOCALLY, which is the other half of the point. A mastery check
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
            shape: '{"question": "...", "type": "code", "language": "python", "starter": "def f(x):\\n    ...", "correct_answer": "<a complete reference solution>", "tests": [{"call": "f(2)", "expect": "4"}, {"call": "f(0)", "expect": "0"}, {"call": "f(-3)", "expect": "-6"}], "explanation": "..."}',
            rule: 'A SMALL programming task the learner solves by writing code: name the function or program to write, its inputs, what it must return or print, and one example call with its result. It must be solvable in at most 15 lines. "language" is the language the material uses (lowercase, e.g. "python", "javascript", "sql"). "starter" is OPTIONAL scaffolding — a signature or a stub with the body left out — and must never contain the solution. "correct_answer" is a complete, correct reference solution in that language, and nothing else: no prose, no fences. "tests" lists 3-8 INPUTS the app runs both the reference solution and the learner\'s code on, all of one kind: for a function, {"call": "<one expression that calls it>", "expect": "<the value it returns, written as a literal of that language>"}; for a program that reads its input, {"stdin": "<the input lines>", "expect": "<exactly what it prints>"}. Include the task\'s own example and at least one edge case the task allows; never an input the task rules out, and never a test that depends on randomness, the clock or the order of a set.',
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
            const tests = normalizeCodeTests(raw.tests);
            if (tests.length) out.tests = tests;
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
        normalize(raw, { stored: fromFile = false } = {}) {
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
            const unnumber = (s) => s.replace(/^\s*(?:\d{1,2}|[a-hA-H])[.)]\s+/, '');
            let clean = items.map(unnumber);
            // A STORED ordering coming back through an import carries its key
            // beside the items as they were SERVED — shuffled. Taking the items
            // as the order then makes the shuffle the key, and the true order
            // grades wrong. So on that door a key that is a list is the order,
            // provided it holds exactly these items; one that holds anything
            // else has no honest order. A model writes its items IN order and
            // no key, so there a stray `correct_answer` (index numbers, the
            // steps re-cased) is ignored, as it always was.
            let stored = null;
            if (fromFile && Array.isArray(raw.correct_answer)) stored = raw.correct_answer;
            else if (fromFile && typeof raw.correct_answer === 'string') {
                try { stored = JSON.parse(raw.correct_answer); } catch { stored = null; }
            }
            if (Array.isArray(stored)) {
                const order = stored.map(s => (typeof s === 'string' ? unnumber(s.trim()) : ''));
                const sameItems = order.length === clean.length
                    && JSON.stringify([...order].sort()) === JSON.stringify([...clean].sort());
                if (!sameItems) return null;
                clean = order;
            }
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

    /**
     * The learner BUILDS the answer from pieces put into gaps: a sentence from
     * its words, an equation from its coefficients, labels onto the parts of a
     * figure. Word order is the case it was built for — verb second after a
     * fronted adverb, verb last in a subclause — where "pick the right sentence
     * of four" only proves the learner can recognise one.
     *
     * The shape an author writes is the shape that is stored, plus `tokens`
     * (the bank as served), so a course file round-trips by construction: the
     * importer runs a stored question back through here and the bank is drawn
     * again from the key and the distractors, never trusted from the file.
     *
     * Graded LOCALLY on the whole arrangement — every gap, or none — like an
     * ordering: partial credit would be a second scoring rule the engine does
     * not have, and a mastery check must reach a verdict with no model.
     */
    assemble: {
        // A blind guess at the smallest assembly allowed (two gaps, three
        // different pieces, nothing else accepted) is right one time in six;
        // anything larger, far less often. `normalize` refuses an assembly a
        // blind fill gets right more than one time in four. The floor is the
        // ordering's, the format it is closest to.
        guess: 0.05,
        grading: 'local',
        authoring: {
            shape: '{"question": "...", "type": "assemble", "template": "... ___ ... ___ ...", "correct_answer": ["<piece for gap 1>", "<piece for gap 2>"], "distractors": ["<a plausible piece that fits no gap>"], "reuse": false, "explanation": "..."}',
            rule: 'The learner BUILDS the answer by putting pieces into gaps: a sentence from its words (word order), a chemical equation from its coefficients, a term beside each description. "template" is the thing being built, with "___" for each gap (2-8 gaps); the text between gaps stays fixed, and a newline starts a new row. "correct_answer" lists, in gap order, the piece that fills each gap. "distractors" lists 1-3 plausible pieces that fit no gap: a wrong form of the same word, a wrong coefficient, a term from the same family. Every piece is short (a word or two, a number, a formula) and is not already written in the template or the question. Exactly one arrangement may be right: fix in the template, or say in the question, whatever would let a second one be right as well, or the question is refused. Set "reuse": true only when one piece may fill several gaps (coefficients, digits). Keep each $...$ formula inside one piece or one stretch of template, never across a gap. The question says what to build; it never copies the template or its ___, which the app draws under it. The app shuffles the pieces.',
        },
        normalize(raw, { stored: fromFile = false } = {}) {
            const template = typeof raw.template === 'string' ? decodeTemplateNewlines(raw.template).replace(/\r\n?/g, '\n').trim() : '';
            if (template.length > ASSEMBLE_LIMITS.maxTemplate) return null; // an essay with holes, not a thing to build
            const gaps = templateParts(template).length - 1;
            if (gaps < ASSEMBLE_LIMITS.minGaps || gaps > ASSEMBLE_LIMITS.maxGaps) return null;
            const authored = readPieces(raw.correct_answer);
            if (!authored || authored.length !== gaps) return null;
            const key = authored.map(cleanPiece);
            if (key.some(p => !p)) return null; // one bad piece: no honest key
            const reuse = raw.reuse === true;

            // A distractor that is also a key piece is a spare, not a
            // distractor; a second copy of one says nothing new. A bad one is
            // skipped — it is optional, and the question still stands.
            const seen = new Set(key.map(foldPiece));
            const distractors = [];
            for (const d of Array.isArray(raw.distractors) ? raw.distractors : []) {
                const p = cleanPiece(d);
                if (!p || seen.has(foldPiece(p))) continue;
                seen.add(foldPiece(p));
                distractors.push(p);
                if (distractors.length >= ASSEMBLE_LIMITS.maxDistractors) break;
            }

            let tokens;
            if (reuse) {
                // A palette: each piece once, numbers ascending. The order
                // depends on which pieces there are and never on the key's
                // order, so it says nothing the bank itself does not (a key
                // that happens to ascend, 1 2 3, ascends either way). A
                // shuffled row of coefficients would also read as a bug.
                const distinct = [...new Map([...key, ...distractors].map(p => [foldPiece(p), p])).values()];
                tokens = distinct.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
            } else {
                tokens = shuffled([...key, ...distractors]);
                for (let tries = 0; tries < 8 && servedInKeyOrder(tokens, key, distractors); tries++) tokens = shuffled(tokens);
                // Two key pieces leak in half of all draws, so the first draw
                // and eight re-draws still leave one in 512. Turning the row
                // by one always breaks the key's order (a key of identical
                // pieces has none to break).
                for (let turn = 1; turn < tokens.length && servedInKeyOrder(tokens, key, distractors); turn++) {
                    tokens = [...tokens.slice(1), tokens[0]];
                }
            }
            if (tokens.length < ASSEMBLE_LIMITS.minBank) return null; // fewer is a coin toss

            // Another arrangement that is equally right — buildable from this
            // bank, and not the key again. Only a file declares one (a person
            // wrote it): the verifier solves a model's assembly cold and
            // confirms ONE fill, so an order a model declared would be graded
            // right with nothing ever having read it. A model's question has
            // one right fill, and one that two fills answer is refused.
            const keyFold = JSON.stringify(key.map(foldPiece));
            const accept = [];
            for (const alt of fromFile && Array.isArray(raw.accept) ? raw.accept : []) {
                const pieces = readPieces(alt);
                if (!pieces || pieces.length !== gaps) continue;
                const clean = pieces.map(cleanPiece);
                if (clean.some(p => !p) || !bankHolds(tokens, clean, reuse)) continue;
                const fold = JSON.stringify(clean.map(foldPiece));
                if (fold === keyFold || accept.some(a => JSON.stringify(JSON.parse(a).map(foldPiece)) === fold)) continue;
                accept.push(JSON.stringify(clean));
                if (accept.length >= ASSEMBLE_LIMITS.maxAccept) break;
            }
            // Every right arrangement is one more way to be right by chance. A
            // bank so small, or so many arrangements accepted, that a blind
            // fill lands more often than at a multiple choice of four is not a
            // question this format can grade fairly at its guess floor.
            if ((1 + accept.length) / fillsPossible(tokens, gaps, reuse) > MAX_BLIND_HIT) return null;

            const out = { template, correct_answer: JSON.stringify(key), tokens };
            if (distractors.length) out.distractors = distractors;
            if (reuse) out.reuse = true;
            if (accept.length) out.accept = accept;
            out.explanation = sanitizeExplanation(text(raw.explanation));
            return out;
        },
        grade(q, answer) {
            const given = readPieces(answer, { holes: true });
            if (!given) return false;
            return arrangementsOf(q).some(a => a.length === given.length
                && a.every((p, i) => typeof given[i] === 'string' && foldPiece(given[i]) === foldPiece(p)));
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
 * setting (a saved quiz and its mastery check must stay gradeable without a model
 * unless the learner asked for that format by name). `stored: true` is the
 * import door, where a question comes back as this app SERVED it (an
 * ordering's items shuffled, its key beside them) rather than as a model
 * writes one.
 */
export function normalizeQuestionFormat(raw, { allow, stored = false } = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const format = ANSWER_FORMATS[raw.type];
    if (!format) return null;
    if (allow && !allow(format, raw.type)) return null;
    return format.normalize(raw, { stored });
}

/** Local verdict for a closed format; null when the format needs the checker. */
export function gradeLocally(question, answer) {
    const format = ANSWER_FORMATS[question?.type];
    if (!format || format.grading !== 'local') return null;
    return format.grade(question, answer);
}

/**
 * Can this STORED question be graded at all? The normalisers above keep a
 * broken key out of anything this app writes, but a stored row can still carry
 * one: an imported file, a row edited by hand, a row written by an earlier
 * version. Both graders mark an unparseable key WRONG, so without this a
 * learner who answers correctly is recorded as not knowing it. A question that
 * fails is never served, which also keeps it out of every score's total.
 * Mirror: `hasUsableKey` in `src/components/answer/formats.ts`.
 */
export function hasUsableKey(q) {
    if (!q || typeof q !== 'object') return false;
    const key = q.correct_answer;
    switch (q.type) {
        case 'multiple_choice': {
            const opts = Array.isArray(q.options) ? q.options.filter(o => text(o)) : [];
            const k = text(key).toLowerCase();
            return opts.length >= 2 && !!k && opts.some(o => text(o).toLowerCase() === k);
        }
        case 'true_false':
            return /^(true|false)$/i.test(text(String(key ?? '')));
        case 'sequence': {
            let k;
            try { k = JSON.parse(String(key)); } catch { return false; }
            return Array.isArray(k) && k.length >= 3 && k.length <= 8 && k.every(item => text(item))
                && Array.isArray(q.items) && q.items.length === k.length;
        }
        case 'assemble': {
            const k = readPieces(key);
            return !!k && k.length >= ASSEMBLE_LIMITS.minGaps && k.length <= ASSEMBLE_LIMITS.maxGaps
                && templateParts(q.template).length - 1 === k.length
                && bankHolds(q.tokens, k, q.reuse === true);
        }
        case 'numeric':
            return parseNumber(key) !== null;
        case 'fill_in':
            return acceptedAnswers(q).length > 0;
        case 'short_answer':
        case 'code':
            return !!text(key);
        default:
            return false;
    }
}

/** The JSON shape and the authoring rule a prompt states for one format. */
export function formatAuthoring(type) {
    return ANSWER_FORMATS[type]?.authoring || ANSWER_FORMATS.multiple_choice.authoring;
}
