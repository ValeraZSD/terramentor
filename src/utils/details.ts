/**
 * `<details>` — a step the learner should ATTEMPT before reading it.
 *
 * A worked answer printed under its question lets the learner mistake recognition
 * for knowing; a collapsible keeps the prompt visible and the step one click away.
 *
 * CONTENT, not a visual: no visual budget, never switched off in the kinds gallery,
 * real DOM so the body keeps markdown, KaTeX, links and selection. Native
 * `<details>`/`<summary>`: the browser owns the state and screen readers know it.
 *
 * 1. THE SHAPE. What a model writes is:
 *
 *        <details><summary>Why is it even?</summary>Because **2 divides it**.</details>
 *
 *    Per CommonMark an HTML block runs until a blank line, so that is one opaque
 *    raw-HTML lump (no emphasis, no KaTeX, no lists). Rewriting it as
 *
 *        <details>
 *
 *        <summary>
 *
 *        Why is it even?
 *
 *        </summary>
 *
 *        Because **2 divides it**.
 *
 *        </details>
 *
 *    makes every tag its own HTML block and every body a markdown block, which
 *    `rehype-raw` stitches back into one tree (a mechanical repair, like
 *    `expandTimelineTags`, rather than trusting a model with blank lines).
 *
 * 2. IT STARTS CLOSED. Attributes are dropped, `open` included: `<details open>`
 *    shows the answer beside the question, and a prompt cannot guarantee that.
 *
 * 3. WHILE STREAMING, an unclosed `<details>` would hide every arriving token, so
 *    the unmatched opener and its summary tags are removed until the closer lands.
 */

import { withCodeProtected, dedent, collapseBlankRuns, escapeTagMentions } from './blockTags';

/** An opening or closing `<details>` / `<summary>`, however the model cased it. */
const DETAILS_TAG = /<(\/?)(details|summary)((?:\s[^<>]*)?)\/?>/gi;

/** Any `<details>` tag, for the balance scan. */
const DETAILS_ONLY = /<(\/?)details(?:\s[^<>]*)?\/?>/gi;

/** A line that is nothing but one of our tags, after the rewrite. */
const TAG_LINE = /^<\/?(?:details|summary)>$/;

export interface ExpandOptions {
    /** True while the message is still arriving — see the note on hiding text. */
    streaming?: boolean;
}

/**
 * Rewrite `<details>` markup into blank-line-separated block form so its
 * summary and body are parsed as markdown. Returns the input untouched when it
 * holds no collapsible, and never touches a fenced block or an inline code
 * span — a lesson that SHOWS the syntax must keep it verbatim.
 */
export function expandDetailsTags(content: string, { streaming = false }: ExpandOptions = {}): string {
    if (!content || !/<\/?details/i.test(content)) return content;
    return withCodeProtected(content, text => expandSegment(text, streaming));
}

function expandSegment(segment: string, streaming: boolean): string {
    // Re-checked with code lifted out, so a code-sample-only mention stays byte-identical.
    if (!/<\/?details/i.test(segment)) return segment;

    const stripped = streaming ? stripUnclosed(segment) : segment;
    if (!/<\/?details/i.test(stripped)) return stripped;

    // A tag the model only MENTIONS is escaped (escapeTagMentions). After the
    // strip, so an opener awaiting its summary is hidden rather than flashing raw.
    const source = escapeTagMentions(stripped, DETAILS_TAG, name => name.toLowerCase(), 'summary');
    if (!/<\/?details/i.test(source)) return source;

    // Pass 1: every tag alone on its line, surrounded by blank lines, lowercased
    // and stripped of attributes (see "it starts closed" above).
    const withTags = source.replace(DETAILS_TAG, (_m, slash: string, name: string) =>
        `\n\n<${slash}${name.toLowerCase()}>\n\n`);

    // Pass 2: dedent each run between tags independently (summary, body and a
    // nested body may carry different indents).
    const out: string[] = [];
    let body: string[] = [];
    const flush = () => { if (body.length) { out.push(...dedent(body)); body = []; } };

    for (const line of withTags.split('\n')) {
        if (TAG_LINE.test(line.trim())) { flush(); out.push(line.trim()); }
        else body.push(line);
    }
    flush();

    return collapseBlankRuns(out.join('\n'));
}

/**
 * Remove the unclosed `<details>` opener and every `<details>`/`<summary>` tag after
 * it, keeping the text. Blocks closed earlier render normally.
 */
function stripUnclosed(segment: string): string {
    let depth = 0;
    let openedAt = -1;
    for (const m of segment.matchAll(DETAILS_ONLY)) {
        if (m[1]) {
            depth = Math.max(0, depth - 1);
            if (depth === 0) openedAt = -1;
        } else {
            if (depth === 0) openedAt = m.index!;
            depth += 1;
        }
    }
    if (depth === 0 || openedAt < 0) return segment;
    return segment.slice(0, openedAt) + segment.slice(openedAt).replace(DETAILS_TAG, '');
}
