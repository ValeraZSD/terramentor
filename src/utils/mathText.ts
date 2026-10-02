/**
 * Mechanical repair layer for AI-authored math strings — quiz stems, options,
 * correct answers, explanations — run before KaTeX ever sees them.
 *
 * Same doctrine as the visual sanitizers (`sanitizeVega` / `sanitizeSvgAnim`):
 * prefer a deterministic fix over an LLM repair round-trip, because the model's
 * two failure modes here are utterly predictable and both are silent:
 *
 *  1. **Bare LaTeX with no delimiters.** The prompt asks for `$…$`; a local
 *     model regularly emits `\beta = 10 \cdot \log(I/I_0)` as a raw option
 *     string. `remark-math` never sees math, so the learner reads backslashes.
 *  2. **`^` / `_` inside `\text{}`.** `\text{W/m^2}` is illegal (scripts are a
 *     math-mode construct), so KaTeX throws and renders the SOURCE in red —
 *     which looks like the app is broken, not the equation.
 *
 * Both are fixed here without a model call. Anything that still fails renders
 * in the surrounding text colour rather than alarm-red (see `MathText`), so a
 * leftover edge case degrades to "unstyled formula", never to "error state".
 */

interface Segment {
    math: boolean;
    /** '' for prose, '$' or '$$' for a math span. */
    delim: string;
    text: string;
}

/**
 * Split a string into prose and `$…$` / `$$…$$` math spans, so each fix runs
 * only where it is meaningful. An unterminated `$` makes the rest prose (that
 * is what remark-math does too, so the two agree on what "math" means).
 */
function segment(input: string): Segment[] {
    const segs: Segment[] = [];
    let prose = '';
    let i = 0;

    const flushProse = () => {
        if (prose) segs.push({ math: false, delim: '', text: prose });
        prose = '';
    };

    while (i < input.length) {
        const ch = input[i];
        if (ch === '\\' && i + 1 < input.length) {
            // Escaped anything (including \$) stays prose, verbatim.
            prose += input.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (ch !== '$') {
            prose += ch;
            i += 1;
            continue;
        }
        const delim = input.startsWith('$$', i) ? '$$' : '$';
        const close = input.indexOf(delim, i + delim.length);
        if (close < 0) {
            // Unterminated — the rest is prose.
            prose += input.slice(i);
            break;
        }
        flushProse();
        segs.push({ math: true, delim, text: input.slice(i + delim.length, close) });
        i = close + delim.length;
    }
    flushProse();
    return segs;
}

function joinSegments(segs: Segment[]): string {
    return segs.map(s => (s.math ? `${s.delim}${s.text}${s.delim}` : s.text)).join('');
}

/** Index of the `}` matching the `{` at `openIdx`, or -1 if unbalanced. */
function matchBrace(s: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
        if (s[i] === '\\') { i += 1; continue; }
        if (s[i] === '{') depth += 1;
        else if (s[i] === '}') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

// --- 1. Alternate delimiters -------------------------------------------------

/**
 * `\(…\)` / `\[…\]` are what a model trained on LaTeX documents reaches for;
 * remark-math only knows `$`. Rewrite before anything else looks at the string.
 */
function normalizeDelimiters(s: string): string {
    return s
        .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `$$${body}$$`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body}$`);
}

// --- 2. Scripts inside text-mode groups --------------------------------------

const TEXT_CMD = /\\(text|textrm|textit|textbf|mathrm)\{/;

/**
 * Rewrite `\text{W/m^2}` → `\text{W/m}^{2}`: close the text group before each
 * script, brace the script's atom, reopen text for the remainder. Only ever
 * called on the body of a text group that actually contains `^` or `_`.
 */
function rewriteTextBody(cmd: string, body: string): string {
    let out = '';
    let buf = '';
    let i = 0;
    const flush = () => {
        if (buf) out += `\\${cmd}{${buf}}`;
        buf = '';
    };
    while (i < body.length) {
        const ch = body[i];
        if (ch !== '^' && ch !== '_') {
            buf += ch;
            i += 1;
            continue;
        }
        flush();
        i += 1;
        let atom: string;
        if (body[i] === '{') {
            const close = matchBrace(body, i);
            atom = close < 0 ? body.slice(i + 1) : body.slice(i + 1, close);
            i = close < 0 ? body.length : close + 1;
        } else {
            // A run of alphanumerics/sign is what the author meant, even though
            // bare LaTeX would only take one character.
            const m = /^[+-]?[A-Za-z0-9]+/.exec(body.slice(i));
            atom = m ? m[0] : (body[i] ?? '');
            i += atom.length || 1;
        }
        out += `${ch}{${atom}}`;
    }
    flush();
    return out;
}

function fixTextModeScripts(s: string): string {
    let out = '';
    let rest = s;
    while (rest) {
        const m = TEXT_CMD.exec(rest);
        if (!m || m.index === undefined) { out += rest; break; }
        out += rest.slice(0, m.index);
        const braceIdx = m.index + m[0].length - 1;
        const close = matchBrace(rest, braceIdx);
        if (close < 0) { out += rest.slice(m.index); break; }
        const body = rest.slice(braceIdx + 1, close);
        out += /[_^]/.test(body) ? rewriteTextBody(m[1], body) : `\\${m[1]}{${body}}`;
        rest = rest.slice(close + 1);
    }
    return out;
}

// --- 2b. Display-only environments ------------------------------------------

/**
 * `\begin{align}` is a KaTeX parse ERROR outside display mode, and remark-math
 * hands almost everything here to KaTeX inline.
 *
 * MathJax — which is what Anki renders with — takes `align` anywhere, so decks
 * write `\(\begin{align}…\end{align}\)` freely. Through this pipeline that
 * becomes `$…$`, KaTeX refuses it with "{align} can be used only in display
 * mode", and `throwOnError: false` prints the raw source: a card showing
 * `\begin{align}v_1 \frac{\partial f}{\partial x}+…\end{align}` where its
 * equation should be. Nor does `$$…$$` rescue it, because remark-math still
 * parses a `$$` span that shares its line with text as INLINE math.
 *
 * Every one of these has a variant KaTeX accepts in both modes and renders
 * identically, minus the equation numbering nothing here uses — so the fix is
 * to name the inline-safe environment rather than to fight the mode.
 */
const DISPLAY_ONLY_ENV: Record<string, string> = {
    align: 'aligned', alignat: 'alignedat', gather: 'gathered',
    multline: 'gathered', equation: '', eqnarray: 'aligned',
};
const ENV_TAG = /\\(begin|end)\{([a-z]+)\*?\}/g;

function inlineSafeEnvironments(s: string): string {
    if (!s.includes('\\begin{')) return s;
    return s.replace(ENV_TAG, (whole, kind: string, name: string) => {
        const safe = DISPLAY_ONLY_ENV[name];
        if (safe === undefined) return whole;
        // `equation` wraps a single expression and has no inline twin; the
        // wrapper itself is what makes it display-only, so it simply goes.
        return safe ? `\\${kind}{${safe}}` : '';
    });
}

// --- 3. Bare LaTeX in prose --------------------------------------------------

/**
 * A signal strong enough to say "this is an equation, not a sentence".
 * `^`/`_` count ONLY when followed by a brace or a digit, so ordinary prose
 * containing `snake_case` or `file_name` is never mistaken for math.
 */
const STRONG_MATH = /\\[a-zA-Z]{2,}|[_^]\{|[_^][0-9]/;

const OPERATOR_ONLY = /^[=+\-*/<>|~(),.;:[\]≤≥≈×÷·−]+$/;
const NUMBER = /^[+-]?\d+(?:[.,]\d+)?$/;
const SINGLE_LETTER = /^[A-Za-zα-ωΑ-Ω]$/;

/** Could this whitespace-delimited token belong to an equation? */
function isMathy(token: string): boolean {
    if (!token) return false;
    if (/[\\^_{}]/.test(token)) return true;
    if (OPERATOR_ONLY.test(token)) return true;
    if (NUMBER.test(token)) return true;
    if (SINGLE_LETTER.test(token)) return true;
    return false;
}

/**
 * Wrap runs of equation-looking tokens in `$…$`. Operates on ONE prose segment
 * (never inside existing math), so a string that mixes correctly-delimited math
 * with a bare formula gets only the bare part fixed.
 */
function wrapBareLatex(prose: string): string {
    if (!STRONG_MATH.test(prose)) return prose;

    // Split keeping whitespace, so the original spacing survives a rebuild.
    const parts = prose.split(/(\s+)/);
    const out: string[] = [];
    let run: string[] = [];

    const flushRun = () => {
        if (run.length === 0) return;
        const joined = run.join('');
        if (!STRONG_MATH.test(joined)) {
            out.push(joined);
            run = [];
            return;
        }
        // Sentence punctuation belongs outside the math span, not inside it.
        const m = /^([\s\S]*?)([.,;:!?]*)$/.exec(joined);
        const body = (m?.[1] ?? joined).trim();
        const tail = m?.[2] ?? '';
        out.push(body ? `$${body}$${tail}` : joined);
        run = [];
    };

    for (const part of parts) {
        if (/^\s+$/.test(part)) {
            // Whitespace continues a run only if it is not the last thing in it;
            // it is pushed provisionally and trimmed when the run is flushed.
            if (run.length > 0) run.push(part);
            else out.push(part);
            continue;
        }
        if (isMathy(part)) {
            run.push(part);
        } else {
            // The pending run ends here; any trailing whitespace it collected
            // must be emitted outside the math span.
            const trailing = run.length && /^\s+$/.test(run[run.length - 1]) ? run.pop()! : '';
            flushRun();
            if (trailing) out.push(trailing);
            out.push(part);
        }
    }
    const trailing = run.length && /^\s+$/.test(run[run.length - 1]) ? run.pop()! : '';
    flushRun();
    if (trailing) out.push(trailing);

    return out.join('');
}

// --- 4. Units orphaned by a line break ---------------------------------------

/**
 * Unit symbols a lesson actually writes after an inline formula. A closed list,
 * not a "short word" heuristic: binding the wrong token would glue real prose
 * into an unbreakable run, and there is no upside to guessing.
 */
const UNIT = new RegExp(
    '^(?:'
    + '[munpkMGTμµ]?(?:m|s|g|A|K|N|J|W|V|C|F|H|T|L|Pa|Hz|Wb|Sr|eV|mol|rad|sr|Ω|ohms?)'
    + '|°[CFK]?|%|km|cm|mm|nm|pm|kg|mg|ms|ns|µs|us|min|hr?|days?|yrs?'
    + '|k(?:m|g|J|W|V|N|Hz|Pa|B)|M(?:Hz|Pa|B|eV)|G(?:Hz|B)|k(?:eV)|dB'
    + '|bits?|bytes?|px|mol|rpm|kWh'
    + ')(?:²|³|\\^2|\\^3|/s|/m|²/s)?$',
);

/**
 * Bind a unit that follows an inline formula to it with a non-breaking space.
 *
 * Earned from a real lesson: "…$a = 0.20 \times 10^{-3}$ m $= 2.0 \times
 * 10^{-4}$ m" wrapped between the formula and its unit, so the next line opened
 * with "m = 2.0 × 10⁻⁴" — which reads as a *variable* m being assigned a value,
 * in a topic where m is a perfectly plausible symbol. Nothing was wrong with the
 * content; a line break changed what it said.
 *
 * A unit belongs to the number in front of it, so it is never allowed to start a
 * line on its own. Display math (`$$…$$`) is excluded — it is already on its own
 * line and has nothing to be separated from.
 */
export function bindUnitsToMath(input: string): string {
    if (!input || !input.includes('$')) return input;
    return input.replace(
        /(\$[^\n$]+?\$)[ \t]+([^\s,.;:)\]]+)/g,
        // U+00A0 written as an escape on purpose — a literal one here is
        // invisible in a diff and indistinguishable from the bug it fixes.
        (whole, math: string, next: string) => (UNIT.test(next) ? `${math}\u00A0${next}` : whole),
    );
}

// --- 4b. A quiz string that is NOTHING BUT a formula -------------------------

/**
 * A quiz string that is entirely one formula is a DISPLAY equation too — but it
 * cannot be promoted the way a markdown line is.
 *
 * Same defect as `promoteDisplayMath` below, on the surface that shows it
 * worst. `\frac` in text style sets its numerator and denominator at script
 * size (×0.7) and anything nested inside those at scriptscript (×0.5), and an
 * answer option is drawn in a `text-sm` button — so a Doppler option measured
 * 11.9px for the fraction body and 8.5px for `v_\text{train}`, against 16px
 * body prose and an app that treats 12px as the smallest deliberate size.
 * Four options a learner has to choose between, at half the size of the
 * question above them.
 *
 * The markdown fix does not transfer. `MathText` unwraps `<p>` so math flows
 * inside buttons and table cells, and the three-line `$$` form yields a
 * `.katex-display` block — `display:block`, centred, with 1em of vertical
 * margin — which inside an option tile is a centred formula in a left-aligned
 * list, and inside a result row is a line break. `\displaystyle` buys the same
 * type sizes with none of the block layout: measured, the same option goes to
 * 16.9px for the fraction body and 11.9px for the subscript.
 *
 * Narrow on purpose — the WHOLE string must be one math span, so a formula
 * inside a sentence ("the ratio $a/b$ is…") keeps text style, which is what
 * text style is for. Idempotent: a body already opening with `\displaystyle`
 * is returned untouched.
 */
export function promoteInlineDisplay(input: string): string {
    if (!input || !input.includes('$')) return input;
    // `[^$]+` so a string holding two separate spans (with prose between them,
    // or without) is left alone — that is a sentence, not a standalone formula.
    const m = /^\s*\$\$?([^$]+)\$\$?\s*$/.exec(input);
    if (!m) return input;
    const body = m[1].trim();
    if (!body || /^\\displaystyle\b/.test(body)) return input;
    return `$\\displaystyle ${body}$`;
}

// --- 5. A formula standing alone on a line -----------------------------------

/**
 * A formula alone on its own line is a DISPLAY equation — make it one.
 *
 * KaTeX renders `$…$` in TEXT style, where `\frac` shrinks its numerator and
 * denominator, and anything nested inside those shrinks again to script style.
 * So an equation the model wrote as inline math on a line of its own — which is
 * what they overwhelmingly do — arrives as a full-size `A(\omega) =` followed by
 * a fraction two sizes smaller, unreadable on a phone. Display style is the fix,
 * and the line genuinely IS a display equation: it stands alone, it is not part
 * of a sentence.
 *
 * The output SHAPE matters and is not the obvious one. `$$x$$` on a single line
 * is still parsed as inline math by remark-math — its flow rule wants the `$$`
 * to open at the end of a line — so "promoting" to a one-liner changes the size
 * not at all. Only the three-line form yields a display node, hence the split
 * delimiters and the surrounding blank lines below.
 *
 * Deliberately narrow: the line must be exactly one math span and must not be
 * indented, so a formula in a list item, a table cell, a quote or mid-sentence
 * is never lifted out of the context that gives it meaning.
 */
export function promoteDisplayMath(segment: string): string {
    if (!segment.includes('$')) return segment;
    const lines = segment.split('\n');
    const out: string[] = [];
    let changed = false;

    for (const line of lines) {
        // `[^$]+` in both forms: a line holding two separate spans is prose.
        const m = /^\$\$([^$]+)\$\$$/.exec(line) || /^\$([^$]+)\$$/.exec(line);
        if (!m || !m[1].trim()) {
            out.push(line);
            continue;
        }
        if (out.length && out[out.length - 1].trim()) out.push('');
        out.push('$$', m[1].trim(), '$$', '');
        changed = true;
    }

    return changed ? out.join('\n') : segment;
}

// --- 6. Punctuation orphaned by a line break ---------------------------------

/**
 * Keep the punctuation that follows an inline formula on the SAME line as it.
 *
 * The sibling of `bindUnitsToMath`, and the same class of bug: "…When $\omega =
 * \omega_n$, the denominator is smallest" wrapped between the formula and its
 * comma, so the next line opened with ", the denominator is smallest" — which
 * looks like the app dropped a word, not like a line break.
 *
 * The mechanism is worth stating because it is not obvious: KaTeX renders math
 * as a run of inline-BLOCK spans, and an atomic inline-level box is treated as
 * U+FFFC by the line-breaking algorithm, which permits a break on either side of
 * it — with no whitespace anywhere. So this is not the model's fault and no
 * prompt can fix it; it needs a character that forbids the break. U+2060 WORD
 * JOINER is exactly that and is zero-width, so nothing is added to what the
 * learner sees.
 *
 * Idempotent: after one pass the character following the span is the joiner,
 * which is not in the punctuation class, so a second pass matches nothing.
 */
export function bindMathPunctuation(input: string): string {
    if (!input || !input.includes('$')) return input;
    // U+2060 written as an escape for the same reason as the NBSP above — a
    // literal zero-width character in source is invisible in a diff.
    return input.replace(/(\$[^\n$]+?\$)(?=[,.;:!?)\]])/g, '$1\u2060');
}

// --- Markdown entry point ----------------------------------------------------

/**
 * Every typographic repair to math in a markdown DOCUMENT (the tutor's prose, a
 * feed lesson), applied outside fenced blocks only — a `plot` spec or a code
 * sample must reach its renderer byte-for-byte:
 *
 *  1. **A formula standing alone on a line** — see `promoteDisplayMath`.
 *  2. **Decimal/thousands commas.** KaTeX treats "," as punctuation and inserts
 *     a visible gap after it — fine for a list like $1, 2, 3$, ugly for $25,000$
 *     ("25, 000"). Wrapping it as "{,}" suppresses the spacing without changing
 *     the character. Only between two digits, which is the separator case.
 *  3. **Units orphaned by a line wrap** — see `bindUnitsToMath`.
 *  4. **Punctuation orphaned by a line wrap** — see `bindMathPunctuation`.
 *
 * Lives here rather than in `Markdown.tsx` so it stays dependency-free and the
 * guard tool can exercise it without pulling in React.
 */
export function fixMarkdownMathTypography(content: string): string {
    return content
        .split(/(```[\s\S]*?```)/)
        .map((segment, i) => {
            if (i % 2 === 1) return segment; // fenced code/visual block — leave as-is
            const commas = promoteDisplayMath(segment).replace(
                /\$\$[\s\S]+?\$\$|\$[^\n$]+?\$/g,
                mathSpan => mathSpan.replace(/(\d),(\d)/g, '$1{,}$2'),
            );
            return bindMathPunctuation(bindUnitsToMath(commas));
        })
        .join('');
}

// --- Quiz-string entry point -------------------------------------------------

/**
 * Make an AI-written math string safe for KaTeX. Idempotent and total: any
 * input is returned unchanged when it carries no math signal at all, so this is
 * cheap enough to run on every quiz string.
 */
export function sanitizeMathText(input: string): string {
    if (!input || (!input.includes('\\') && !input.includes('$'))) return input;

    const delimited = normalizeDelimiters(input);
    // Pass 1: delimit bare equations found in the prose spans.
    const wrapped = joinSegments(
        segment(delimited).map(s => (s.math ? s : { ...s, text: wrapBareLatex(s.text) })),
    );
    // Pass 2: fix text-mode scripts and display-only environments inside math
    // spans (including ones pass 1 just created).
    return joinSegments(
        segment(wrapped).map(s => (s.math
            ? { ...s, text: inlineSafeEnvironments(fixTextModeScripts(s.text)) }
            : s)),
    );
}
