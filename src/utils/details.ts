/**
 * `<details>` — a step the learner should ATTEMPT before reading it.
 *
 * The app's loop is Discover → Plan → Study → Prove → Remember. Prose that
 * states the worked answer directly under the question skips Prove: the learner
 * reads the solution, recognises it, and mistakes recognition for knowing it.
 * A collapsible is the smallest possible fix — the prompt stays visible, the
 * step is one click away, and the click is the learner's own decision.
 *
 * It is CONTENT, not a visual: it costs no visual budget, is never switched off
 * in the kinds gallery, and renders as real DOM, so its body keeps markdown,
 * KaTeX, links and selection. Native `<details>`/`<summary>` on purpose —
 * the browser owns the open/close state and screen readers already understand
 * the element, so there is no state to manage and no ARIA to get wrong.
 *
 * Two things this module is responsible for.
 *
 * 1. THE SHAPE. What a model writes is:
 *
 *        <details><summary>Why is it even?</summary>Because **2 divides it**.</details>
 *
 *    Per CommonMark an HTML block runs until a blank line, so all of that
 *    arrives as one opaque raw-HTML lump: the stars stay stars, `$…$` never
 *    reaches KaTeX, a bullet list stays literal asterisks. Rewriting it as
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
 *    makes every tag its own HTML block and every body an ordinary markdown
 *    block, which `rehype-raw` then stitches back into one tree. This is a
 *    repair layer in the same spirit as `expandTimelineTags` and
 *    `unwrapWrappedVisualFences`: fix the shape mechanically rather than hoping
 *    a small local model emits blank lines in the right places.
 *
 * 2. IT STARTS CLOSED. Attributes are dropped, `open` included. A model that
 *    writes `<details open>` has shown the answer beside the question, which is
 *    the one thing the tag exists to prevent — and it is a mistake a model
 *    makes silently, so the guarantee belongs here rather than in the prompt.
 *
 * Mid-stream there is a third duty: an unclosed `<details>` would put every
 * token that follows it inside a collapsed box, so text the learner is watching
 * arrive would vanish as it lands. While `streaming`, the unmatched opener and
 * its summary tags are removed and the prose stays visible; the block snaps
 * into place when the closing tag arrives, exactly as a visual does.
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
    // Re-checked with code lifted out: a lesson whose only `<details>` was a
    // code sample has none left here, and must come back byte-identical.
    if (!/<\/?details/i.test(segment)) return segment;

    const stripped = streaming ? stripUnclosed(segment) : segment;
    if (!/<\/?details/i.test(stripped)) return stripped;

    // A tag the model was TALKING ABOUT rather than writing with is escaped
    // here and never reaches the rewrite (see escapeTagMentions). Mid-stream
    // this runs AFTER the strip above, so an opener whose summary has not
    // arrived yet is hidden for a token rather than flashing as raw markup.
    const source = escapeTagMentions(stripped, DETAILS_TAG, name => name.toLowerCase(), 'summary');
    if (!/<\/?details/i.test(source)) return source;

    // Pass 1: every tag alone on its line, surrounded by blank lines, lowercased
    // and stripped of attributes (see "it starts closed" above).
    const withTags = source.replace(DETAILS_TAG, (_m, slash: string, name: string) =>
        `\n\n<${slash}${name.toLowerCase()}>\n\n`);

    // Pass 2: dedent each run of body lines between tags, independently — the
    // summary's run and the body's run can carry different indents, and a nested
    // collapsible's body must keep its own indent relative to its parent.
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
 * Remove the `<details>` opener that is still waiting for its closing tag, plus
 * every `<details>`/`<summary>` tag after it. Text is kept — only the markup
 * that would hide it goes. A block that already closed earlier in the message
 * is untouched, so a finished collapsible renders while the next one streams.
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
