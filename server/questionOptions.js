/**
 * Answer-option identity: when are two multiple-choice options the same choice?
 *
 * Its own module, with NO imports, for one reason: both the generator's gate
 * (`feedQuality.js`) and the read-only auditor (`tools/feed-audit.mjs`) must use
 * the identical definition, and the auditor cannot pull in `feedQuality.js`
 * without dragging `database.js` — which opens the DB read-write and runs
 * migrations — into a tool whose whole promise is that it is safe to run against
 * a live database. Same pattern as the leaf definition: one rule, two mirrors
 * that are required to agree.
 */

/**
 * Reduce an option to what it actually SAYS, so two spellings of one value can
 * be recognised as the same distractor.
 *
 * Earned from a live question: "Solve $3^{2x-1} = 27$" shipped with options
 * $x = 4$, $x = 2$, $x = 1.5$ and $x = \frac{3}{2}$ — the last two are the same
 * number. A learner who has done the algebra correctly still reads four choices
 * and hunts for the distinction between them, because a well-formed question
 * promises there is one. String comparison cannot see it; the strings differ.
 */
export function canonicalOption(option) {
    return reduceOption(option).toLowerCase();
}

// The same reduction with the case left alone. Case carries meaning in the
// options a science question offers: $\Delta x$ and $\delta x$, 5 MW and 5 mW,
// CO and Co are different choices, so `sameOption` must not fold them together.
// `canonicalOption` still folds, for the one place that asks whether the key is
// written like an option and a stray capital there should not fail the question.
// `\left`/`\right` are dropped only as whole commands: `\rightarrow` and
// `\leftarrow` are arrows, not `arrow`.
function reduceOption(option) {
    return String(option ?? '')
        .replace(/\$+/g, '')
        .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
        .replace(/\\(?:left|right|quad|qquad|ensuremath)(?![A-Za-z])|\\[,;!]/g, '')
        .replace(/[{}\s]/g, '');
}

// Running text, not a symbol, a unit or a formula: two words of three letters
// or more, none of them mixed-case (`MPa`, `MeV`, `NASA`), and no `$` or `\`
// (`$\Delta \theta$` is two long words and still a formula).
function isSentence(option) {
    const s = String(option ?? '');
    if (/[$\\]/.test(s) || !/\p{L}{3,}\s+\p{L}{3,}/u.test(s)) return false;
    return (s.match(/\p{L}+/gu) ?? []).every(word => !/\p{L}\p{Lu}/u.test(word));
}

// An assignment's `=`: not the tail of `<=`, `>=`, `!=` and not half of `==`.
// Those are comparisons, and the text before them is part of what is compared.
const ASSIGNMENT = /(?<![<>!=])=(?!=)/g;

/** The label and the numeric value an option states, `{ label: '', value: null }` when it states none. */
function readOption(option) {
    const whole = reduceOption(option);
    let label = '';
    let s = whole;
    const assignments = [...whole.matchAll(ASSIGNMENT)];
    if (assignments.length) {
        const at = assignments[assignments.length - 1].index;
        label = whole.slice(0, at);
        s = whole.slice(at + 1);
    }
    s = s.toLowerCase().replace(/\\times10\^\(?([+-]?\d+)\)?/, 'e$1').replace(/\\cdot/g, '*');
    const frac = /^\(?([+-]?\d*\.?\d+)\)?\/\(?([+-]?\d*\.?\d+)\)?$/.exec(s);
    if (frac) {
        const denominator = parseFloat(frac[2]);
        return { label, value: denominator === 0 ? null : parseFloat(frac[1]) / denominator };
    }
    if (/^[+-]?\d*\.?\d+(?:e[+-]?\d+)?$/.test(s)) return { label, value: parseFloat(s) };
    return { label, value: null };
}

/**
 * The numeric value an option states, or null when it does not state one.
 *
 * Strict on purpose: only a bare number, a simple fraction, or "label = <that>".
 * A looser reader would call "85 m" and "85 seconds" equal, and a false positive
 * here silently throws away a good question — the expensive direction to be
 * wrong in.
 */
export function optionValue(option) {
    return readOption(option).value;
}

/**
 * True when two answers are the same choice wearing different clothes, with
 * case folded. For comparing a free-hand answer with a stored one (a verifier's
 * order, a drill's echo, an assistant's check of a card), where "boil" and
 * "Boil" are one answer.
 *
 * Two values are the same only under the same label: `x = 2` and `y = 2` are
 * different answers to "which variable is it?", and `i <= 5` is not `i == 5`.
 * A value with no label is the same as the labelled one (`2` and `x = 2`), since
 * nothing contradicts it.
 */
export function sameOption(a, b) {
    return sameChoice(a, b, true);
}

/**
 * The same comparison for telling a question's own options apart. Case is kept
 * for symbols, units and formulas, and folded for a sentence, whose capital
 * letter is typography: "Melt the butter" and "melt the butter" are one step,
 * "5 MW" and "5 mW" are two powers.
 */
export function sameOptionCased(a, b) {
    return sameChoice(a, b, false);
}

function sameChoice(a, b, fold) {
    let ra = reduceOption(a);
    let rb = reduceOption(b);
    if (fold) { ra = ra.toLowerCase(); rb = rb.toLowerCase(); }
    if (ra === rb) return true;
    if (!fold && isSentence(a) && isSentence(b) && ra.toLowerCase() === rb.toLowerCase()) return true;
    const x = readOption(a);
    const y = readOption(b);
    if (x.value === null || y.value === null) return false;
    const lx = fold ? x.label.toLowerCase() : x.label;
    const ly = fold ? y.label.toLowerCase() : y.label;
    if (lx && ly && lx !== ly) return false;
    return Math.abs(x.value - y.value) <= 1e-9 * Math.max(1, Math.abs(x.value), Math.abs(y.value));
}

/**
 * Where the key sits among the options: the one written exactly like it, else
 * the one that differs only by case (a stray capital in the key must not turn
 * the key-shape checks off), else -1.
 */
function keyIndexOf(options, key) {
    const exact = options.findIndex(o => sameOptionCased(o, key));
    return exact !== -1 ? exact : options.findIndex(o => sameOption(o, key));
}

// Small numbers written as words. A stem says "fits exactly five
// quarter-wavelengths" and the key is "$5f_1$" — the echo is only visible if
// the words count as numbers. Stops at twelve: beyond that, prose uses digits.
const NUMBER_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    half: 0.5, quarter: 0.25, third: 1 / 3, double: 2, triple: 3, quadruple: 4,
};

/**
 * Every number the question stem states, as values — digits and small number
 * words alike.
 *
 * Deliberately generous where `optionValue` is strict, because the two are used
 * for opposite purposes: `optionValue` decides whether to THROW A QUESTION AWAY
 * for having duplicate options, so a false positive is expensive; this decides
 * whether a key merely echoes the stem, where missing a number means missing the
 * defect and the cost of a false positive is one regenerated question.
 */
export function stemNumbers(stem) {
    const text = String(stem ?? '').toLowerCase();
    const out = new Set();
    for (const m of text.matchAll(/[+-]?\d+(?:[.,]\d+)?/g)) {
        const v = parseFloat(m[0].replace(',', '.'));
        if (Number.isFinite(v)) out.add(v);
    }
    for (const [word, value] of Object.entries(NUMBER_WORDS)) {
        if (new RegExp(`\\b${word}\\b`).test(text)) out.add(value);
    }
    return out;
}

/** Every number an option mentions, whatever surrounds it: "$5f_1$" -> {5, 1}. */
function numbersIn(option) {
    const out = new Set();
    for (const m of String(option ?? '').matchAll(/\d+(?:\.\d+)?/g)) {
        const v = parseFloat(m[0]);
        if (Number.isFinite(v)) out.add(v);
    }
    return out;
}

/**
 * The numbers that tell one option APART from the others.
 *
 * Deliberately not `optionValue`, which is strict because it decides whether to
 * throw a question away for having duplicate options — it reads "$5f_1$" as no
 * value at all, which is right there and useless here. What matters for the echo
 * check is the number a guesser's eye lands on, so this takes every number in
 * each option and then subtracts the ones EVERY option shares: given $5f_1$,
 * $4f_1$, $3f_1$, $6f_1$ the shared subscript 1 falls away and what is left is
 * exactly the 5, 4, 3, 6 the learner is choosing between.
 */
function distinguishingNumbers(options) {
    const per = options.map(numbersIn);
    const shared = per.length
        ? [...per[0]].filter(v => per.every(s => s.has(v)))
        : [];
    return per.map(s => new Set([...s].filter(v => !shared.includes(v))));
}

/**
 * Does the correct option simply repeat a number the stem already gave, while
 * no distractor does?
 *
 * The classic non-question: "…fits exactly FIVE quarter-wavelengths… what is the
 * frequency?" with options $5f_1$, $4f_1$, $3f_1$, $6f_1$. A learner who
 * understands nothing picks the number they just read, and scores. It is a
 * defect of the DISTRACTORS as much as the key — a well-set item makes the
 * echoed number a trap, not the answer.
 *
 * Requires at least three options that actually differ by a number (a two-option
 * coin flip is the true/false rules' business), and requires that NO distractor
 * echoes the stem: when several options appear in the stem, the number is a
 * shared premise of the question rather than a giveaway.
 */
export function keyEchoesStem(stem, options, correctAnswer) {
    const stated = stemNumbers(stem);
    if (stated.size === 0) return false;
    const opts = Array.isArray(options) ? options : [];
    if (opts.length < 3) return false;

    const marks = distinguishingNumbers(opts);
    if (marks.filter(s => s.size > 0).length < 3) return false;

    const echoes = (set) => [...set].some(v => [...stated].some(
        n => Math.abs(n - v) <= 1e-9 * Math.max(1, Math.abs(n), Math.abs(v)),
    ));

    const keyIndex = keyIndexOf(opts, correctAnswer);
    if (keyIndex === -1) return false;
    if (!echoes(marks[keyIndex])) return false;

    // A distractor that also appears in the stem makes the number a premise.
    for (let i = 0; i < opts.length; i++) {
        if (i === keyIndex) continue;
        if (echoes(marks[i])) return false;
    }
    return true;
}

/**
 * Do the key and a distractor sit SYMMETRICALLY about a number the stem states,
 * close to it, in a stem that compares against that number?
 *
 * The shape of an under-determined stem: "5 beats against a 520 Hz reference —
 * what is your frequency?" is answered equally by 515 and 525, and a mastery
 * check can offer both with 525 keyed. The cold-solve verifier catches that one
 * only when the model happens to pick the other branch; this catches it for
 * free, before any model call.
 *
 * "Any symmetric pair" fires far too often: a sum-of-the-two-frequencies
 * distractor can straddle a stem number by accident (440/442 → key 2,
 * distractor 882). Requiring a comparative cue and the pair to lie within 20%
 * of the stem number leaves the real case. Precision over recall: this is
 * a weakness (retry, then serve with it recorded), never a veto.
 */
const COMPARATIVE_CUE = /\b(against|compared|relative to|reference|beat|beats|difference|apart|more than|less than|higher|lower|above|below|faster|slower|later|earlier)\b/i;

export function symmetricAboutStem(stem, options, correctAnswer) {
    const text = String(stem ?? '');
    if (!COMPARATIVE_CUE.test(text)) return null;
    const stated = [...stemNumbers(text)].filter(r => r > 0);
    if (!stated.length) return null;
    const opts = Array.isArray(options) ? options : [];
    const keyIndex = keyIndexOf(opts, correctAnswer);
    if (keyIndex === -1) return null;
    const keyNums = [...numbersIn(opts[keyIndex])];
    for (let i = 0; i < opts.length; i++) {
        if (i === keyIndex) continue;
        for (const d of numbersIn(opts[i])) for (const k of keyNums) for (const r of stated) {
            if (k === d || k === r || d === r) continue;
            const symmetric = Math.abs((k + d) / 2 - r) <= 1e-9 * Math.max(1, r);
            const close = Math.abs(k - d) <= 0.2 * r;
            if (symmetric && close) return { reference: r, key: k, distractor: d };
        }
    }
    return null;
}

/**
 * Is the correct option conspicuously longer than every distractor?
 *
 * The oldest tell in test writing: the key accumulates the qualifying clauses
 * that make it defensible ("…, provided the boundary condition holds") while the
 * distractors stay blunt, so it can be picked on shape alone. Thresholds are
 * loose — 1.6× the longest distractor AND 25 characters clear of it — so a
 * genuinely wordy answer set is not reported.
 */
export function keyIsLengthOutlier(options, correctAnswer) {
    const opts = Array.isArray(options) ? options : [];
    if (opts.length < 3) return false;
    const key = String(correctAnswer ?? '').trim();
    if (key.length < 24) return false;
    // Only the key's own option is left out: a distractor that differs from it
    // by case is a different choice, and its length counts.
    const keyIndex = keyIndexOf(opts, correctAnswer);
    const others = opts.filter((_, i) => i !== keyIndex).map(o => String(o ?? '').trim().length);
    if (others.length < 2) return false;
    const longest = Math.max(...others);
    return key.length >= longest * 1.6 && key.length - longest >= 25;
}

// The one option family that is broken by construction: the app SHUFFLES the
// options before display, so after the shuffle there is no "above" to refer to.
//
// Deliberately narrow. "Cannot be determined" and "Not enough information" look
// like the same kind of non-answer and are not — in statistics, logic, or
// reading a graph they are frequently the correct answer, and flagging them
// would throw away good questions to enforce a style opinion. A gate here fails
// toward keeping the question.
const SHAPE_ONLY_OPTION = /^\W*(?:all|none|any|both)\s+of\s+(?:the\s+)?(?:above|these|them|the\s+others)\b/i;

export function isShapeOnlyOption(option) {
    return SHAPE_ONLY_OPTION.test(String(option ?? '').trim());
}
