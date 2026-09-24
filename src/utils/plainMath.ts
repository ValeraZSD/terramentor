/**
 * Flatten LaTeX and light markdown into plain Unicode text.
 *
 * For the surfaces that cannot run KaTeX at all: a <canvas> (the exported
 * PNG/GIF card), an aria-label, a <title> attribute, a file name. Everywhere a
 * DOM exists the text goes through `MathText`/`Markdown` instead — this is the
 * fallback for the one place a formula would otherwise be printed as its own
 * source (`$v_f = \frac{m_1 v_1}{m_1+m_2}$` drawn letter by letter under a
 * picture, which is what the export card did).
 *
 * Deliberately lossy and deliberately simple: `\frac{a}{b}` becomes `a/b`
 * (parenthesised when either side is more than one token), sub- and
 * superscripts use the Unicode forms where one exists and `_`/`^` otherwise,
 * Greek letters and the common operators become their glyphs, and everything
 * this does not recognise loses its backslash and keeps its name. The goal is
 * a caption a reader can follow, not a typeset formula.
 */

const GREEK: Record<string, string> = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
    rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
    Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const SYMBOLS: Record<string, string> = {
    times: '×', cdot: '·', pm: '±', mp: '∓', div: '÷', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
    approx: '≈', sim: '∼', simeq: '≃', equiv: '≡', propto: '∝', infty: '∞', to: '→', rightarrow: '→',
    Rightarrow: '⇒', leftarrow: '←', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦',
    partial: '∂', nabla: '∇', sum: 'Σ', prod: 'Π', int: '∫', oint: '∮', sqrt: '√', degree: '°', circ: '∘',
    angle: '∠', perp: '⊥', parallel: '∥', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩',
    forall: '∀', exists: '∃', neg: '¬', lnot: '¬', land: '∧', lor: '∨', ldots: '…', cdots: '⋯', dots: '…',
    prime: '′', hbar: 'ℏ', ell: 'ℓ', Re: 'Re', Im: 'Im', star: '★', bullet: '•', langle: '⟨', rangle: '⟩',
    lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', vec: '', hat: '', bar: '', tilde: '', dot: '', ddot: '',
    mathbf: '', mathit: '', mathrm: '', mathcal: '', mathbb: '', boldsymbol: '', text: '', textbf: '',
    textit: '', operatorname: '', displaystyle: '', textstyle: '', left: '', right: '', big: '', Big: '',
    bigl: '', bigr: '', Bigl: '', Bigr: '', quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', ' ': ' ',
    '!': '', '\\': ' ', '{': '{', '}': '}', '%': '%', '&': '&', '#': '#', '$': '$', '_': '_',
    sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc', arcsin: 'arcsin', arccos: 'arccos',
    arctan: 'arctan', sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', ln: 'ln', log: 'log', exp: 'exp', lim: 'lim',
    max: 'max', min: 'min', det: 'det', deg: 'deg', dim: 'dim', gcd: 'gcd', mod: 'mod', bmod: 'mod', pmod: 'mod',
};

const SUP: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
    '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
};
const SUB: Record<string, string> = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
    '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
    a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ',
    t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

/** The `{…}` group starting at `i` (which must be a `{`); returns its body and the index after `}`. */
function readGroup(s: string, i: number): { body: string; end: number } | null {
    if (s[i] !== '{') return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '{') depth++;
        else if (s[j] === '}') {
            depth--;
            if (depth === 0) return { body: s.slice(i + 1, j), end: j + 1 };
        }
    }
    return { body: s.slice(i + 1), end: s.length };
}

/** One argument after a command: a `{…}` group, or the single next token. */
function readArg(s: string, i: number): { body: string; end: number } {
    const g = readGroup(s, i);
    if (g) return g;
    if (s[i] === '\\') {
        const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
        return { body: m ? m[0] : '\\', end: i + (m ? m[0].length : 1) };
    }
    return { body: s[i] ?? '', end: i + 1 };
}

function needsParens(s: string): boolean {
    return /[\s+\-−±×·/]/.test(s.trim()) && !/^\(.*\)$/.test(s.trim());
}

function script(body: string, table: Record<string, string>, mark: string): string {
    const flat = flattenMath(body);
    const chars = Array.from(flat);
    if (chars.length && chars.every(c => table[c])) return chars.map(c => table[c]).join('');
    return chars.length > 1 ? `${mark}(${flat})` : `${mark}${flat}`;
}

/** Flatten the INSIDE of a math span (no delimiters) to plain text. */
export function flattenMath(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
            const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
            const name = m ? m[1] : '';
            i += m ? m[0].length : 1;
            if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
                const a = readArg(src, i);
                const b = readArg(src, a.end);
                i = b.end;
                const num = flattenMath(a.body).trim();
                const den = flattenMath(b.body).trim();
                out += `${needsParens(num) ? `(${num})` : num}/${needsParens(den) ? `(${den})` : den}`;
                continue;
            }
            if (name === 'sqrt') {
                // Optional index: \sqrt[3]{x}
                let idx = '';
                if (src[i] === '[') {
                    const close = src.indexOf(']', i);
                    if (close > i) { idx = flattenMath(src.slice(i + 1, close)); i = close + 1; }
                }
                const a = readArg(src, i);
                i = a.end;
                const body = flattenMath(a.body).trim();
                out += `${idx ? script(idx, SUP, '^') : ''}√(${body})`;
                continue;
            }
            if (name === 'text' || name === 'mathrm' || name === 'textbf' || name === 'textit' || name === 'operatorname'
                || name === 'mathbf' || name === 'mathit' || name === 'mathcal' || name === 'mathbb' || name === 'boldsymbol'
                || name === 'vec' || name === 'hat' || name === 'bar' || name === 'tilde' || name === 'dot' || name === 'ddot') {
                const a = readArg(src, i);
                i = a.end;
                // \text{} holds words and keeps them verbatim; a decoration keeps its argument.
                out += name === 'text' || name === 'textbf' || name === 'textit' ? a.body : flattenMath(a.body);
                if (name === 'vec') out += '⃗';
                continue;
            }
            if (name in GREEK) { out += GREEK[name]; continue; }
            if (name in SYMBOLS) { out += SYMBOLS[name]; continue; }
            out += name; // unknown command: keep its name, drop the backslash
            continue;
        }
        if (c === '^' || c === '_') {
            const a = readArg(src, i + 1);
            i = a.end;
            out += script(a.body, c === '^' ? SUP : SUB, c);
            continue;
        }
        if (c === '{' || c === '}') { i++; continue; }
        if (c === '~') { out += ' '; i++; continue; }
        out += c;
        i++;
    }
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * Plain text for a canvas or an attribute: math spans flattened, markdown
 * emphasis and code marks removed, whitespace collapsed.
 */
export function toPlainText(input: string): string {
    let s = String(input ?? '');
    // Display and inline math, in both delimiter styles. `$$` first so a
    // display span is not read as two empty inline spans around a body.
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => ` ${flattenMath(m)} `);
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => ` ${flattenMath(m)} `);
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => flattenMath(m));
    s = s.replace(/\$([^$\n]+?)\$/g, (_, m) => flattenMath(m));
    // Light markdown.
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1$2');
    s = s.replace(/`([^`]+)`/g, '$1');
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
}
