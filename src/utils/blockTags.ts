/**
 * Shared primitives for the "content tag" repair layers.
 *
 * Two features let the model write real tags into prose rather than a fenced
 * spec, because their bodies must stay markdown: `<Timeline>` (a chronology,
 * see timeline.ts) and `<details>` (a collapsible, see details.ts). Both hit
 * exactly the same two CommonMark facts and so need exactly the same helpers —
 * kept here so a fix to either one is a fix to both.
 *
 *   - An HTML block runs until a blank line, so a tag written the natural,
 *     compact way swallows its own body as raw HTML. The repair is to put every
 *     tag on its own line with blank lines around it; `rehype-raw` stitches the
 *     split tags back into a tree (that is what it is for).
 *   - Four leading spaces is an indented code block, so the natural way to
 *     write a nested tag — indenting its body — turns that body into code.
 *
 * And one trap that is easy to miss until a lesson is ABOUT the tag: a repair
 * layer must never rewrite a code SAMPLE. "The `<details>` element" is a
 * sentence this app will really have to render, and so is a fenced block
 * showing the markup.
 *
 * `withCodeProtected` handles both halves of that, and the second half is the
 * subtle one. Splitting the text at code regions and skipping them — the
 * obvious implementation, and the one this file had first — protects a fence
 * from the tag rewrite but also protects it from the DEDENT, and a fence
 * indented inside a tag body is exactly what a model writes:
 *
 *     <details>
 *         <summary>Show the diagram</summary>
 *         ```mermaid
 *         flowchart TD
 *         ```
 *     </details>
 *
 * Left at four spaces that fence is an indented code block, so the diagram
 * renders as its own dead source — measured in the app, not theorised. So a
 * fence is lifted out as a one-line placeholder that still CARRIES its indent:
 * the dedent moves the placeholder like any other line, and the fence is put
 * back at whatever indent the line ended up with.
 */

/**
 * Sentinel for a lifted region. Built rather than written, because a literal
 * control byte in a source file is unreadable in a diff and does not survive
 * every tool that touches the file.
 */
const NUL = String.fromCharCode(0);

/** Opening line of a fenced block, capturing its indent and marker. */
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})/;
const FENCE_TOKEN = new RegExp(`${NUL}F(\\d+)${NUL}`, 'g');
const FENCE_TOKEN_LINE = new RegExp(`^([ \\t]*)${NUL}F(\\d+)${NUL}[ \\t]*$`, 'gm');
const SPAN_TOKEN = new RegExp(`${NUL}I(\\d+)${NUL}`, 'g');
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * Run `fn` over `content` with every fenced block and inline code span lifted
 * out, then put them back. `fn` sees a placeholder in place of each, so it can
 * rewrite and re-indent freely without ever touching a code sample.
 */
export function withCodeProtected(content: string, fn: (text: string) => string): string {
    const fences: string[][] = [];
    const spans: string[] = [];

    // 1. Fenced blocks, scanned line-wise so an unclosed fence (mid-stream, or
    //    a model that forgot the closer) is protected to the end of the text.
    const lines = content.split('\n');
    const lifted: string[] = [];
    for (let i = 0; i < lines.length;) {
        const open = lines[i].match(FENCE_OPEN);
        if (!open) { lifted.push(lines[i]); i += 1; continue; }
        const [, indent, marker] = open;
        const closer = new RegExp(`^[ \\t]*${marker[0]}{3,}\\s*$`);
        const block = [lines[i]];
        i += 1;
        while (i < lines.length) {
            block.push(lines[i]);
            const done = closer.test(lines[i]);
            i += 1;
            if (done) break;
        }
        // Stored WITHOUT the opening line's indent, so it can be re-laid at
        // whatever indent the placeholder ends up on.
        fences.push(indent
            ? block.map(l => (l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^[ \t]+/, '')))
            : block);
        lifted.push(`${indent}${NUL}F${fences.length - 1}${NUL}`);
    }

    // 2. Inline spans never cross a line, so they need no indent bookkeeping.
    let text = lifted.join('\n').replace(INLINE_CODE, (m) => {
        spans.push(m);
        return `${NUL}I${spans.length - 1}${NUL}`;
    });

    text = fn(text);

    // 3. Put both back. Fences first by line (so the indent left on the line is
    //    applied to the whole block), then any that somehow moved off their line.
    text = text.replace(FENCE_TOKEN_LINE, (_m, indent: string, n: string) =>
        fences[Number(n)].map(l => (l ? indent + l : l)).join('\n'));
    text = text.replace(FENCE_TOKEN, (_m, n: string) => fences[Number(n)].join('\n'));
    return text.replace(SPAN_TOKEN, (_m, n: string) => spans[Number(n)]);
}

/**
 * Remove the smallest common indent from a block of lines. Blank lines are
 * ignored when measuring (they carry no indent) but kept in the output, since a
 * blank line is what separates two paragraphs inside one body.
 */
export function dedent(lines: string[]): string[] {
    const indents = lines.filter(l => l.trim()).map(l => l.match(/^[ \t]*/)![0].length);
    const cut = indents.length ? Math.min(...indents) : 0;
    return cut ? lines.map(l => (l.trim() ? l.slice(cut) : l)) : lines;
}

/**
 * Collapse the runs of blank lines a tag rewrite creates. Harmless in markdown,
 * but they inflate the string and make the output unreadable in a diff.
 */
export function collapseBlankRuns(text: string): string {
    return text.replace(/\n{3,}/g, '\n\n');
}

/** One occurrence of a content tag, as the mention scan sees it. */
interface TagHit {
    index: number;
    raw: string;
    close: boolean;
    key: string;
}

/**
 * Indices of the hits that never pair up — an opener with no closer after it,
 * a closer with no opener before it. Nesting-aware, and per tag name, so an
 * unclosed `<summary>` does not make the `<details>` around it look unbalanced.
 */
function unpairedHits(hits: TagHit[]): Set<number> {
    const stacks = new Map<string, number[]>();
    const unpaired = new Set<number>();
    hits.forEach((hit, i) => {
        let stack = stacks.get(hit.key);
        if (!stack) stacks.set(hit.key, (stack = []));
        if (hit.close) { if (stack.length) stack.pop(); else unpaired.add(i); }
        else stack.push(i);
    });
    for (const stack of stacks.values()) for (const i of stack) unpaired.add(i);
    return unpaired;
}

/**
 * Escape the tags that are a MENTION of the tag rather than markup written with
 * it, so they read as the words they are.
 *
 * The expanders below rewrite a content tag into block form, which is right
 * when the model MEANT a collapsible or a chronology and wrong when it was
 * talking ABOUT one. The assistant does the second thing constantly — asked
 * what it can draw, it answers with a list, and one bullet of that list was:
 *
 *     - **<details>** — a step the learner should TRY before reading it.
 *
 * Expanded, the tag becomes its own block: the bullet is torn in half (a list
 * item containing nothing but `**`), the rest of the sentence is lifted out of
 * the list, and everything after it disappears into a summary-less collapsible
 * labelled in whatever language the BROWSER is set to. Measured in the app —
 * the whole answer past that bullet was unreadable.
 *
 * Balance is what tells the two apart. Markup closes: a mention is a lone
 * opener, or a stray closer, and gets its angle brackets escaped so remark
 * renders the tag name as text (inside the `**` it was written in, which is
 * exactly what the reader was meant to see).
 *
 * The one exception is an opener whose CHILD tag follows it immediately — the
 * `<summary>` of a collapsible, the first `<TimelineEvent>` of a chronology.
 * That is a model that forgot the closing tag, not one talking about the
 * syntax, and escaping it would print raw markup at the learner AND spoil the
 * step the collapsible exists to hide.
 *
 * @param pattern global regex matching the family's tags; group 1 is the `/` of
 *                a closing tag, group 2 the tag name
 * @param keyOf   the tag name normalised to its canonical element name
 * @param childKey the canonical name of the tag a real opener is followed by
 */
export function escapeTagMentions(
    text: string,
    pattern: RegExp,
    keyOf: (name: string) => string,
    childKey: string,
): string {
    const hits: TagHit[] = [...text.matchAll(pattern)].map(m => ({
        index: m.index!,
        raw: m[0],
        close: m[1] === '/',
        key: keyOf(m[2]),
    }));
    if (!hits.length) return text;

    const unpaired = unpairedHits(hits);
    const mentions = new Set<number>();
    hits.forEach((hit, i) => {
        if (!unpaired.has(i)) return;
        const next = hits[i + 1];
        if (!hit.close && next && !next.close && next.key === childKey) return;
        mentions.add(i);
    });
    if (!mentions.size) return text;

    let out = '';
    let at = 0;
    hits.forEach((hit, i) => {
        if (!mentions.has(i)) return;
        out += text.slice(at, hit.index) + hit.raw.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        at = hit.index + hit.raw.length;
    });
    return out + text.slice(at);
}
