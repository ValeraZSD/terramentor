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
    // `([…])` is the stadium shape, not a round node holding a bracketed label.
    if (line[i] === '(' && line[i + 1] !== '(' && line[i + 1] !== '[') return { open: '(', close: ')', primary: '(' };
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

/**
 * Config keys a diagram's own `%%{init}%%` directive or front matter may not
 * set. Mermaid deletes every key on its `secure` list from diagram-supplied
 * config; the app themes each diagram itself, and each key added here reaches
 * the page's stylesheet (`themeCSS` verbatim, fonts and theme variables inside
 * CSS declarations) or loosens the label sanitiser below. A directive that sets
 * anything else (a curve, a direction) still works.
 */
export const MERMAID_SECURE_KEYS = [
    'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
    'theme', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'fontSize', 'darkMode', 'dompurifyConfig',
];

/**
 * What label HTML may contain once Mermaid has sanitised it: formatting, and no
 * attribute but a class. Mermaid lays a diagram out INSIDE the live page to
 * measure it, so a label's <img> or <input type=image> (both kept by its
 * default DOMPurify pass) was requested before anything after the render could
 * remove it, and a picture of `/api/feed?nodeId=N` starts writing a lesson.
 * Handing Mermaid this allow-list runs the check in Mermaid's own sanitiser, on
 * the label as Mermaid parsed it, rather than on the diagram's source text,
 * where every rewrite either missed a spelling or damaged a legitimate `i < n`.
 */
export const MERMAID_DOMPURIFY = {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'u', 's', 'del', 'sub', 'sup', 'small', 'mark', 'code', 'br', 'span', 'p', 'div', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['class'],
    ALLOW_DATA_ATTR: false,
};

/**
 * Style lines that carry a stylesheet address. `classDef` styles are applied to
 * the node as its inline style, so `background:url(…)` there is a request; a
 * `\` escape can spell `url(` without the letters. Only those lines go.
 */
export function stripMermaidFetches(src: string): string {
    return src
        .split(/\r?\n/)
        .filter((l) => !(/^\s*(classDef|style|linkStyle)\b/.test(l) && /url|image-set|@import|\\/i.test(l)))
        .join('\n');
}

/**
 * Does the diagram ask for a picture? An image-shape node (`@{ img: … }`) is
 * fetched by Mermaid itself (`new Image()`) while it lays the diagram out, before
 * anything could remove it, so such a diagram is refused with a reason the repair
 * can act on. A shape block with a backslash is refused too, since a quoted YAML
 * key can spell `img` in escapes.
 */
export function mermaidAsksForPicture(src: string): boolean {
    if (/["']?\bimg["']?\s*:/i.test(src)) return true;
    const at = src.indexOf('@{');
    return at >= 0 && src.slice(at).includes('\\');
}

/** A stylesheet address that is not a fragment of the drawing itself. */
const CSS_FETCH = /url\s*\(\s*(?!['"]?#)|image-set\s*\(|@import/gi;

/**
 * The finished SVG with every element and address that could fetch removed,
 * parsed in an inert template so nothing in it loads while it is inspected. This
 * is the second line, for anything the render put back: fetching elements go, an
 * address on anything but a link goes unless it is a fragment (Mermaid reuses its
 * own shapes by `#id`), a link keeps an http(s) address (it loads only on a
 * press), and stylesheet addresses are neutralised in `<style>` and `style=`.
 */
export function inertMermaidSvg(svg: string): DocumentFragment {
    const tpl = document.createElement('template');
    tpl.innerHTML = svg;
    const root = tpl.content;
    root.querySelectorAll('img, image, input, picture, source, video, audio, track, iframe, object, embed, feImage, link, use').forEach((n) => {
        if (n.localName === 'use') {
            const ref = n.getAttribute('href') ?? n.getAttribute('xlink:href') ?? '';
            if (ref.trim().startsWith('#')) return;
        }
        n.remove();
    });
    root.querySelectorAll('*').forEach((n) => {
        for (const attr of ['src', 'srcset', 'href', 'xlink:href', 'background', 'poster', 'data']) {
            const v = n.getAttribute(attr);
            if (v == null) continue;
            const value = v.trim();
            if (value.startsWith('#')) continue;
            if (n.localName === 'a' && (attr === 'href' || attr === 'xlink:href') && /^https?:\/\//i.test(value)) continue;
            n.removeAttribute(attr);
        }
        const style = n.getAttribute('style');
        if (style && CSS_FETCH.test(style)) n.setAttribute('style', style.replace(CSS_FETCH, 'blocked('));
        CSS_FETCH.lastIndex = 0;
    });
    root.querySelectorAll('style').forEach((s) => {
        s.textContent = (s.textContent || '').replace(CSS_FETCH, 'blocked(');
    });
    return root;
}

/** A tag the label allow-list keeps, at the start of the text. */
const KEPT_TAG = new RegExp(`^</?(${MERMAID_DOMPURIFY.ALLOWED_TAGS.join('|')})\\b[^<>]*>`, 'i');

/**
 * A `<` glued to a letter opens a tag to an HTML parser, so `x<y means …` was
 * shown as "x": the rest parsed as an unclosed `<y …>` and the sanitiser dropped
 * it. Inside a quoted label, a `<` that opens no tag the allow-list keeps is
 * written as Mermaid's `#lt;`, which Mermaid turns into text before sanitising.
 * `x < y` is not a tag start and is left alone; `<b>` stays formatting.
 */
function lessThanAsText(line: string): string {
    return line.replace(/"([^"]*)"/g, (_m, label: string) =>
        `"${label.replace(/<(?=[A-Za-z!/?])/g, (lt, at: number) => (KEPT_TAG.test(label.slice(at)) ? lt : '#lt;'))}"`);
}

export function sanitizeMermaid(src: string): string {
    const lines = stripMermaidFetches(src).split(/\r?\n/);
    const firstKeyword = (lines.find((l) => l.trim()) || '').trim();
    const isFlowchart = /^(flowchart|graph)\b/.test(firstKeyword);

    return lines
        // Drop cosmetic directives small models mangle (invalid props, bad syntax).
        .filter((l) => !/^\s*(style|linkStyle)\s+\S/.test(l))
        .map((line) => {
            // <br/> renders as literal text under securityLevel:'strict' — flatten it.
            let s = line.replace(/<br\s*\/?>/gi, ' ');
            if (isFlowchart && !/^\s*(flowchart|graph|subgraph|end|direction)\b/.test(s)) {
                s = lessThanAsText(quoteEdgeLabels(quoteNodeLabels(s)));
            }
            return s;
        })
        .join('\n');
}
