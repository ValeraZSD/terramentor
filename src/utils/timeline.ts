/**
 * `<Timeline>` — chronologies as structured content, not as a picture.
 *
 * A timeline is a list with dates, not a diagram, so it renders as real DOM
 * (wrapping, selection, links, KaTeX) rather than an SVG, whose text shrinks
 * unreadably on a phone and whose labels cannot carry markdown.
 *
 * Tags, not a fenced spec, because each event BODY must stay markdown, and a fence
 * is opaque to the markdown parser.
 *
 *     <Timeline>
 *       <TimelineEvent time="Week 1" title="Foundations">
 *         * Read chapters 1–3.
 *         * Submit **Assignment 1**.
 *       </TimelineEvent>
 *     </Timeline>
 *
 * Markdown cannot parse that: a CommonMark HTML block runs until a blank line, so
 * it is one raw-HTML lump, and once a blank line appears the indented body becomes
 * a code block. So `expandTimelineTags` rewrites it — every tag alone on its line,
 * blank lines around, bodies dedented:
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
 * `rehype-raw` stitches the split tags back into one tree and `Markdown.tsx` maps
 * the two element names to components. A mechanical repair (like `sanitizeVega`)
 * rather than trusting a small model with blank lines.
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
 * timeline.
 */
export function expandTimelineTags(content: string): string {
    if (!content || !/<\/?timeline/i.test(content)) return content;

    // Fences and inline code stay verbatim (a lesson may SHOW the syntax); a fence
    // inside an event body is still dedented with it (see blockTags.ts).
    return withCodeProtected(content, expandSegment);
}

function expandSegment(segment: string): string {
    if (!/<\/?timeline/i.test(segment)) return segment;

    // A tag the model only MENTIONS ("write <Timeline> to start one") is escaped,
    // or the rewrite would tear the sentence into blocks (escapeTagMentions).
    const source = escapeTagMentions(segment, TIMELINE_TAG, canonicalTag, 'timeline-event');
    if (!/<\/?timeline/i.test(source)) return source;

    // Pass 1: put every tag on a line of its own, surrounded by blank lines.
    const withTags = source.replace(TIMELINE_TAG, (_m, slash: string, name: string, attrs: string) => {
        const tag = canonicalTag(name);
        // Attributes re-emitted verbatim; the component reads only `time`/`title`.
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
            // Only an event's body is dedented.
            if (/^<timeline-event/i.test(line.trim())) body = [];
            continue;
        }
        if (body) body.push(line);
        else out.push(line);
    }
    if (body) out.push(...dedent(body));

    return collapseBlankRuns(out.join('\n'));
}
