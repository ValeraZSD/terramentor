import { defaultSchema } from 'hast-util-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';

/**
 * The sanitize schema for the ONE markdown pipeline that parses raw HTML.
 *
 * `Markdown.tsx` runs `rehype-raw`, which turns any HTML written inside a
 * markdown string into real elements. That is required — `expandTimelineTags`
 * emits `<timeline-event>` tags and there is no other way to let a chronology
 * body stay markdown (see the Timeline convention in docs/ARCHITECTURE.md) — but it also
 * means every other tag in that string becomes a real element too, and the
 * strings are not ours:
 *
 *   - a node's Overview / Material / notes can arrive from an imported course,
 *     which this project's own threat model calls untrusted input ("the
 *     marketplace's whole point is sharing them"), and
 *   - every lesson, question and chat reply is written by a model that reads
 *     vault documents, captured web pages and imported material.
 *
 * Measured before this existed: `<iframe srcdoc="…">` survived the pipeline
 * with its payload intact, which is script execution in the app's own origin —
 * the exact thing `sanitizeUrl`/`safeHref` were written to prevent for the one
 * field that reaches an `href`, arriving through the much wider door beside it.
 * `<iframe src>`, `<meta http-equiv="refresh">`, `<form action>`, `<object>`,
 * `<style>` and `<script>` all reached the DOM too. React neutralises string
 * event handlers (`onerror=`) and react-markdown's `urlTransform` already kills
 * `javascript:` hrefs, so those two were never the hole — the elements were.
 *
 * Two things about the placement matter as much as the schema:
 *
 *   1. It runs AFTER `rehype-raw` (there is nothing to sanitize before the raw
 *      HTML is parsed) and BEFORE `rehype-katex` — KaTeX emits a large tree of
 *      spans with its own classes, and sanitizing after it would strip the
 *      rendered maths off every card in the app.
 *   2. Because it runs before KaTeX, `span`/`div` must keep the `math`,
 *      `math-inline` and `math-display` classes that remark-math writes — those
 *      class names ARE the handoff between the two plugins. Allowing arbitrary
 *      class names instead would hand an attacker the utility CSS to cover the
 *      viewport with a fake dialog, so the allowance is exactly those three.
 */
export const markdownSchema: SanitizeSchema = {
    ...defaultSchema,
    tagNames: [
        ...(defaultSchema.tagNames || []),
        // Chronologies. Lowercased + hyphenated because rehype-raw parses with
        // parse5; `Markdown.tsx` maps both names to the real components.
        'timeline',
        'timeline-event',
    ],
    attributes: {
        ...defaultSchema.attributes,
        // remark-math → rehype-katex handoff (see note 2 above).
        span: [...(defaultSchema.attributes?.span || []), ['className', 'math', 'math-inline', 'math-display']],
        div: [...(defaultSchema.attributes?.div || []), ['className', 'math', 'math-inline', 'math-display']],
        // `time` is the only attribute a timeline event needs that the default
        // schema's global list does not already carry (`title` is in it).
        'timeline-event': ['time', 'title'],
    },
};
