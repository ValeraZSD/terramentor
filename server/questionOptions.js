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
    return String(option ?? '')
        .replace(/\$+/g, '')
        .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
        .replace(/\\(?:left|right|,|;|!|quad|qquad|ensuremath)/g, '')
        .replace(/[{}\s]/g, '')
        .toLowerCase();
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
    let s = canonicalOption(option);
    const eq = s.lastIndexOf('=');
    if (eq >= 0) s = s.slice(eq + 1);
    s = s.replace(/\\times10\^?\(?([+-]?\d+)\)?/, 'e$1').replace(/\\cdot/g, '*');
    const frac = /^\(?([+-]?\d*\.?\d+)\)?\/\(?([+-]?\d*\.?\d+)\)?$/.exec(s);
    if (frac) {
        const denominator = parseFloat(frac[2]);
        return denominator === 0 ? null : parseFloat(frac[1]) / denominator;
    }
    if (/^[+-]?\d*\.?\d+(?:e[+-]?\d+)?$/.test(s)) return parseFloat(s);
    return null;
}

/** True when two options are the same choice wearing different clothes. */
export function sameOption(a, b) {
    if (canonicalOption(a) === canonicalOption(b)) return true;
    const x = optionValue(a);
    const y = optionValue(b);
    if (x === null || y === null) return false;
    return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
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

    const keyIndex = opts.findIndex(o => sameOption(o, correctAnswer));
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
 * what is your frequency?" is answered equally by 515 and 525, and a live Boss
 * Fight offered both with 525 keyed. The cold-solve verifier catches that one
 * only when the model happens to pick the other branch; this catches it for
 * free, before any model call.
 *
 * Measured on the stored corpus first (750 multiple-choice questions,
 * 2026-09-02): "any symmetric pair" fired 29 times, "with a comparative cue"
 * 4 times, and only one of the four was the real thing — the others were a
 * sum-of-the-two-frequencies distractor straddling a stem number by accident
 * (440/442 → key 2, distractor 882). Requiring the pair to lie within 20% of
 * the stem number left exactly the real case. Precision over recall: this is
 * a weakness (retry, then serve with it recorded), never a veto.
 */
const COMPARATIVE_CUE = /\b(against|compared|relative to|reference|beat|beats|difference|apart|more than|less than|higher|lower|above|below|faster|slower|later|earlier)\b/i;

export function symmetricAboutStem(stem, options, correctAnswer) {
    const text = String(stem ?? '');
    if (!COMPARATIVE_CUE.test(text)) return null;
    const stated = [...stemNumbers(text)].filter(r => r > 0);
    if (!stated.length) return null;
    const opts = Array.isArray(options) ? options : [];
    const keyIndex = opts.findIndex(o => sameOption(o, correctAnswer));
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
    const others = opts.filter(o => !sameOption(o, correctAnswer)).map(o => String(o ?? '').trim().length);
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
