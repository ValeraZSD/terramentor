/**
 * Deterministic Mermaid pre-sanitizer.
 *
 * Local models (our 9B Ollama) reliably fail Mermaid's label grammar: they emit
 * unquoted parentheses / Greek / superscripts inside labels (`A((π(2r)²))`),
 * literal `<br/>` (rendered as text under securityLevel:'strict'), and cosmetic
 * `style ... fill:#f9f` lines with invalid props. None of that survives
 * `mermaid.parse`. Rather than rely on the model honouring "don't do X" negative
 * prompt rules, we mechanically fix the common breakers before parsing. This is
 * model-independent and runs on every render (including AI-repaired specs), so
 * it's the front line; the LLM repair loop is the fallback for what this misses.
 *
 * Scope is intentionally conservative: label-quoting is applied only to
 * flowchart/graph diagrams (where the paren problem occurs). Other diagram
 * types (class/sequence/…) legitimately use `(` in their body, so we only strip
 * `<br/>` and cosmetic style lines there.
 */

// A label is "safe" unquoted only if it contains none of these. Parentheses,
// math/Greek/superscript symbols, %, #, & etc. all force a quote.
const SAFE_LABEL = /^[A-Za-z0-9 _\-.,/:'+]*$/;

function quoteInner(inner: string): string {
    const trimmed = inner.trim();
    if (!trimmed) return inner;
    if (/^".*"$/.test(trimmed)) return inner; // already quoted
    if (/^`[\s\S]*`$/.test(trimmed)) return inner; // markdown string
    if (SAFE_LABEL.test(trimmed)) return inner; // no breaking chars
    return `"${trimmed.replace(/"/g, "'")}"`;
}

/** Opening delimiter → primary bracket char used for depth counting + closer. */
function openerAt(line: string, i: number): { open: string; close: string; primary: string } | null {
    const two = line.slice(i, i + 2);
    if (two === '((') return { open: '((', close: '))', primary: '(' };
    if (line[i] === '[' && line[i + 1] !== '[' && line[i + 1] !== '(') return { open: '[', close: ']', primary: '[' };
    if (line[i] === '(' && line[i + 1] !== '(') return { open: '(', close: ')', primary: '(' };
    if (line[i] === '{' && line[i + 1] !== '{') return { open: '{', close: '}', primary: '{' };
    return null;
}

/**
 * Quote node labels on a single flowchart line. A node label is an opener
 * (`[`, `(`, `((`, `{`) immediately preceded by an id char — that's what
 * distinguishes `A[label]` from an incidental paren. The matching close is
 * found by depth-counting the primary bracket char, so nested parens inside a
 * label (`π(2r)²`) are handled.
 */
function quoteNodeLabels(line: string): string {
    let out = '';
    let i = 0;
    while (i < line.length) {
        const opener = openerAt(line, i);
        const prev = out.length ? out[out.length - 1] : '';
        const attached = /[A-Za-z0-9_)\]}]/.test(prev); // opener glued to a node id / prior shape

        if (opener && attached) {
            const openLen = opener.open.length;
            let depth = openLen; // count of primary char in the opener
            let j = i + openLen;
            for (; j < line.length && depth > 0; j++) {
                if (line[j] === opener.primary) depth++;
                else if (line[j] === opener.close[0]) depth--;
            }
            if (depth === 0) {
                const inner = line.slice(i + openLen, j - opener.close.length);
                out += opener.open + quoteInner(inner) + opener.close;
                i = j;
                continue;
            }
        }
        out += line[i];
        i++;
    }
    return out;
}

/** Quote `-->|label|` edge labels containing breaking chars. */
function quoteEdgeLabels(line: string): string {
    return line.replace(/\|([^|]+)\|/g, (_m, inner) => `|${quoteInner(inner)}|`);
}

export function sanitizeMermaid(src: string): string {
    const lines = src.split(/\r?\n/);
    const firstKeyword = (lines.find((l) => l.trim()) || '').trim();
    const isFlowchart = /^(flowchart|graph)\b/.test(firstKeyword);

    return lines
        // Drop cosmetic directives small models mangle (invalid props, bad syntax).
        .filter((l) => !/^\s*(style|linkStyle)\s+\S/.test(l))
        .map((line) => {
            // <br/> renders as literal text under securityLevel:'strict' — flatten it.
            let s = line.replace(/<br\s*\/?>/gi, ' ');
            if (isFlowchart && !/^\s*(flowchart|graph|subgraph|end|direction)\b/.test(s)) {
                s = quoteEdgeLabels(quoteNodeLabels(s));
            }
            return s;
        })
        .join('\n');
}
