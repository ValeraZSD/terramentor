/**
 * Deterministic arithmetic checks on taught prose.
 *
 * Its own module with NO imports, for the same reason as questionOptions.js: the
 * generator's gate (feedQuality.js) and the read-only auditor
 * (tools/feed-audit.mjs) must apply the identical rule, and the auditor cannot
 * import feedQuality.js without dragging database.js — which opens the DB
 * read-write and runs migrations — into a tool whose whole promise is that it is
 * safe to run against a live database.
 *
 * The point of doing this mechanically at all, when a model audit also runs: the
 * project's standing preference is the mechanical layer over a model round-trip
 * wherever one is possible (parseLooseJson over a repair call, sanitizeSvgAnim
 * over a rerender). This catches one narrow but very common shape for free, on
 * every lesson, with no model, no latency and no chance of the checker itself
 * being wrong — and it keeps working when the model audit is unavailable, which
 * is the state the whole AI layer is required to degrade into.
 */

/**
 * Normalise LaTeX-ish maths into a form a small parser can read.
 * Only the transformations needed by `linearCombinationFaults` below.
 */
function normalizeMath(text) {
    return String(text || '')
        .replace(/\$+/g, ' ')
        .replace(/\\[dt]?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)')
        .replace(/\\(?:left|right|,|;|!|:|quad|qquad)/g, '')
        .replace(/\\cdot|\\times/g, '*')
        .replace(/\\lambda/g, 'λ')
        .replace(/\\(?:alpha|beta|gamma|delta|theta|phi|omega|mu|nu|rho|sigma|tau)\b/g, 'γ')
        // EVERY remaining macro becomes a BREAK, never whitespace. Deleting them
        // is what welds two separate equations into one false chain: "$L =
        // \lambda_1/4 \implies \lambda_1 = 4L$" is two correct statements, and
        // stripping \implies turns it into "L = … = 4L", which then reports that
        // L is not 4L. Same class of bug as the words "so" and "therefore",
        // arriving through LaTeX instead of prose.
        //
        // A following single ASCII letter is swallowed with it, because the
        // macro was almost certainly qualifying that letter (\Delta x, \vec v,
        // \bar x, \hat p) and reading the bare letter afterwards silently
        // changes which quantity is being talked about — "\Delta x = x - x_0"
        // would otherwise be evaluated as though \Delta x and x were one thing.
        // Losing a checkable equation is the cheap direction to be wrong in.
        .replace(/\\[a-zA-Z]+\s*[A-Za-z]?/g, ' § ')
        // \frac leaves "(L)/(3)"; a parenthesis around a lone token is noise.
        .replace(/\(\s*([A-Za-z0-9λγ_.]+)\s*\)/g, '$1')
        .replace(/[ \t]+/g, ' ');
}

/**
 * Is this whitespace-delimited token part of an equation rather than prose?
 *
 * The load-bearing clause is the ban on two consecutive ASCII letters. Without
 * it, an equation chain scanned by character class runs straight through the
 * words between two SEPARATE equations — "$L = \lambda_1/4$ so $\lambda_1 = 4L$"
 * reads as one chain "L = … = 4L" and reports a fault in a passage that is
 * entirely correct. Variables are single letters; anything longer is a word (or
 * a unit, which also has no place in the shape checked here).
 */
function isMathToken(token) {
    if (!/^[0-9A-Za-zλγ_{}().\/*+\-=]+$/.test(token)) return false;
    return !/[A-Za-z]{2}/.test(token);
}

/** Runs of consecutive math tokens that contain at least one "=". */
function equationRuns(normalized) {
    const runs = [];
    for (const line of normalized.split(/[\n,;:]+/)) {
        let current = [];
        const flush = () => {
            const text = current.join(' ').trim().replace(/[.]+$/, '');
            if (current.length && text.includes('=')) runs.push(text);
            current = [];
        };
        for (const token of line.split(/\s+/)) {
            if (!token) continue;
            if (isMathToken(token)) current.push(token);
            else flush();
        }
        flush();
    }
    return runs;
}

// One additive term in a single symbol: an optional numeric coefficient, the
// symbol, and an optional numeric denominator. "3λ/4", "λ/2", "2L", "L".
//
// A SUBSCRIPT IS PART OF THE SYMBOL'S IDENTITY, not decoration to be discarded:
// x and x_0 are two different quantities, so "x = x - x_0" is a definition of
// displacement and not the claim that x equals zero. Dropping the subscript made
// it the latter, and the checker duly reported a fault in correct teaching.
const TERM = /^\s*([+-]?)\s*(\d+(?:\.\d+)?)?\s*\*?\s*([A-Za-zλγ](?:_\{?\w+\}?)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/;

/**
 * Read "λ/4 + λ/2 + λ/2" as { symbol: 'λ', value: 1.25 }, or null when the
 * expression is anything more complicated than a sum of multiples of ONE symbol.
 *
 * Returning null on anything unfamiliar is the whole safety property: this only
 * ever reports a fault it has fully evaluated, so it cannot invent one.
 */
function sumOfOneSymbol(expression) {
    const parts = String(expression).split(/(?=[+-])/).filter(p => p.trim());
    if (!parts.length) return null;
    let symbol = null;
    let total = 0;
    for (const part of parts) {
        const m = TERM.exec(part);
        if (!m) return null;
        const [, sign, coefficient, sym, denominator] = m;
        if (symbol === null) symbol = sym;
        else if (symbol !== sym) return null;
        const d = denominator === undefined ? 1 : parseFloat(denominator);
        if (!d) return null;
        const c = coefficient === undefined ? 1 : parseFloat(coefficient);
        total += (sign === '-' ? -1 : 1) * (c / d);
    }
    return { symbol, value: total };
}

const TOLERANCE = 1e-9;

/**
 * Faults in equations of the form "aX + bX + … = cX", where every term is a
 * multiple of one symbol.
 *
 * This is the shape a lesson uses when it adds up the pieces of something — the
 * segments of a standing wave, the fractions of a whole, the terms of a series,
 * shares of a budget — and it is exactly where a model hand-sums and slips. A
 * live card taught "L = λ/4 + λ/2 + λ/2 = 3λ/4" (it is 5λ/4) and then drew the
 * wrong conclusion from its own wrong total; the sentence reads perfectly, the
 * arithmetic is one line, and nothing in the pipeline added it up.
 *
 * A chain with more than one "=" is checked segment by segment: only segments
 * that resolve to the SAME symbol are compared, so "L = λ/4 + λ/2" is skipped
 * (L and λ are different quantities and the equation is a definition, not a sum)
 * while the two λ segments of the chain above are compared and caught.
 *
 * Returns [{ statement, left, right, expected }]; empty means nothing checkable
 * was found, which is by far the common case and is not a pass or a fail.
 */
export function linearCombinationFaults(text) {
    const faults = [];
    for (const chain of equationRuns(normalizeMath(text))) {
        const segments = chain.split('=').map(s => s.trim().replace(/[.]+$/, '')).filter(Boolean);
        if (segments.length < 2) continue;
        const parsed = segments.map(sumOfOneSymbol);
        for (let i = 0; i < parsed.length; i++) {
            for (let j = i + 1; j < parsed.length; j++) {
                const a = parsed[i];
                const b = parsed[j];
                if (!a || !b || a.symbol !== b.symbol) continue;
                if (Math.abs(a.value - b.value) <= TOLERANCE * Math.max(1, Math.abs(a.value))) continue;
                faults.push({
                    statement: chain.slice(0, 120),
                    left: segments[i],
                    right: segments[j],
                    expected: `${segments[i]} = ${Number(a.value.toFixed(6))}${a.symbol}, but ${segments[j]} = ${Number(b.value.toFixed(6))}${b.symbol}`,
                });
            }
        }
    }
    return faults;
}
