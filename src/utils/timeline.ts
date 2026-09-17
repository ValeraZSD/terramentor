/**
 * `<Timeline>` — chronologies as structured content, not as a picture.
 *
 * A sequence of dated events is one of the most common shapes in study material
 * (a syllabus week by week, a thesis plan, a reign, a reaction pathway, an exam
 * day) and until now the only way to draw one was a ```mermaid timeline. That
 * renders an SVG, which means: no markdown in an event body (no bold, no list,
 * no `$…$` formula), plain-ASCII labels only, and text that shrinks with the
 * canvas until it is unreadable on a phone. A timeline is not a diagram — it is
 * a list with dates, closer to a table than to a chart — so it renders as real
 * DOM instead, and gets wrapping, selection, links and KaTeX for free.
 *
 * The authoring syntax is tags rather than a fenced spec, precisely because the
 * event BODY must stay markdown. A fenced block is opaque to the markdown
 * parser: whatever the renderer received it would have to re-implement lists,
 * emphasis and math itself. Tags let each body remain an ordinary part of the
 * document.
 *
 *     <Timeline>
 *       <TimelineEvent time="Week 1" title="Foundations">
 *         * Read chapters 1–3.
 *         * Submit **Assignment 1**.
 *       </TimelineEvent>
 *     </Timeline>
 *
 * That is what the model writes, and it is NOT what markdown can parse. Per
 * CommonMark an HTML block runs until a blank line, so the whole timeline above
 * arrives as one opaque raw-HTML lump: the bullets stay literal asterisks and
 * `**Assignment 1**` keeps its stars. Worse, the 4-space body indent turns into
 * an indented code block the moment a blank line does appear.
 *
 * So `expandTimelineTags` rewrites it into the one form that does work — every
 * tag alone on its own line, blank lines around it, bodies dedented:
 *
 *     <timeline>
 *
 *     <timeline-event time="Week 1" title="Foundations">
 *
 *     * Read chapters 1–3.
 *     * Submit **Assignment 1**.
 *
 *     </timeline-event>
 *
 *     </timeline>
 *
 * Each tag is then its own HTML block, the body between them is parsed as
 * ordinary markdown, and `rehype-raw` stitches the split tags back into a proper
 * tree (that is exactly what it exists for). `Markdown.tsx` maps the two element
 * names to React components.
 *
 * This is a *repair* layer in the same spirit as `sanitizeVega` /
 * `unwrapWrappedVisualFences`: fix the shape mechanically rather than hoping a
 * 9B model emits blank lines in the right places.
 */

import { withCodeProtected, dedent, collapseBlankRuns, escapeTagMentions } from './blockTags';

/** Matches an opening/closing Timeline or TimelineEvent tag, however the model cased it. */
const TIMELINE_TAG =
    /<(\/?)(Timeline|TimelineEvent|timeline|timeline-event|timelineevent)((?:\s[^<>]*)?)\/?>/g;

/** Canonical (lowercase, hyphenated) element name for a matched tag. */
function canonicalTag(raw: string): 'timeline' | 'timeline-event' {
    return raw.toLowerCase().replace(/[^a-z]/g, '') === 'timeline' ? 'timeline' : 'timeline-event';
}

/**
 * Rewrite `<Timeline>` markup into blank-line-separated block form so the event
 * bodies are parsed as markdown. Returns the input untouched when it holds no
 * timeline, and leaves fenced blocks strictly alone — a lesson that *shows* the
 * syntax in a code sample must keep it verbatim.
 */
export function expandTimelineTags(content: string): string {
    if (!content || !/<\/?timeline/i.test(content)) return content;

    // Fenced blocks AND inline code spans are left verbatim — a lesson that
    // shows the syntax must keep it — while a fence INSIDE an event body still
    // gets dedented with the rest of that body (see blockTags.ts).
    return withCodeProtected(content, expandSegment);
}

function expandSegment(segment: string): string {
    if (!/<\/?timeline/i.test(segment)) return segment;

    // A tag the model was TALKING ABOUT rather than writing with — "write
    // <Timeline> to start one" — is escaped and never reaches the rewrite,
    // which would otherwise tear the sentence around it into blocks. See
    // escapeTagMentions.
    const source = escapeTagMentions(segment, TIMELINE_TAG, canonicalTag, 'timeline-event');
    if (!/<\/?timeline/i.test(source)) return source;

    // Pass 1: put every tag on a line of its own, surrounded by blank lines.
    const withTags = source.replace(TIMELINE_TAG, (_m, slash: string, name: string, attrs: string) => {
        const tag = canonicalTag(name);
        // Attributes are re-emitted verbatim; the only ones we read are `time`
        // and `title`, and anything else is dropped by the component, not here.
        return `\n\n<${slash}${tag}${slash ? '' : attrs.replace(/\s+/g, ' ').trimEnd()}>\n\n`;
    });

    // Pass 2: dedent the body of each event, so an indented `* bullet` stays a
    // bullet instead of becoming an indented code block.
    const lines = withTags.split('\n');
    const out: string[] = [];
    let body: string[] | null = null;

    for (const line of lines) {
        const isTag = /^<\/?timeline(?:-event)?(?:\s[^<>]*)?>$/i.test(line.trim());
        if (isTag) {
            if (body) { out.push(...dedent(body)); body = null; }
            out.push(line.trim());
            // Only an event's body needs dedenting; text between events is
            // whitespace and gets flushed the same way.
            if (/^<timeline-event/i.test(line.trim())) body = [];
            continue;
        }
        if (body) body.push(line);
        else out.push(line);
    }
    if (body) out.push(...dedent(body));

    return collapseBlankRuns(out.join('\n'));
}
