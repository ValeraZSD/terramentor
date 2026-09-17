import type { VisualRenderer } from './registry';
import { sanitizeMermaid } from './sanitizeMermaid';
import { mermaidThemeVariables } from './mermaidTheme';

let renderSeq = 0;

/**
 * The size a diagram's labels are drawn at, and the smallest size they are
 * allowed to REACH the reader at. Both in CSS px, because that is the unit the
 * question is asked in: "is this readable?" is never a question about scale.
 *
 * `DIAGRAM_FONT_PX` pins what was previously Mermaid's own default (measured at
 * 16px) — the app named the font family and left the size to the library, so a
 * Mermaid upgrade could have moved every diagram's type without a line changing
 * here. `MIN_LABEL_PX` is the app's smallest deliberate text size (12px: badges
 * and counters — see the control vocabulary), and nothing a learner has to READ
 * should go under it.
 */
export const DIAGRAM_FONT_PX = 16;
export const MIN_LABEL_PX = 12;

/**
 * Smallest fraction of its natural size a diagram may be shrunk to in order to
 * fit the container — DERIVED from the two sizes above rather than chosen, so
 * the floor cannot drift away from what it exists to protect.
 *
 * It was 0.65, picked directly. Measured through the real renderer, the
 * seven-node flowchart the Doppler lesson draws is 859 units wide and rendered
 * at ×0.66 in a 568px card: 10.6px labels on a DESKTOP, already at the floor,
 * against 16px body prose. 0.65 was a scale that let 16px text land at 10.4px —
 * it was never a legibility floor, it just looked like one.
 *
 * Past the floor we stop scaling and let `.visual-block-stage` (already
 * `overflow-x-auto`) scroll sideways instead: a diagram you pan beats a diagram
 * you can't read.
 */
export const MIN_LEGIBLE_SCALE = MIN_LABEL_PX / DIAGRAM_FONT_PX;

/**
 * Mermaid measures label text by laying the SVG out in a temporary div it
 * appends to <body>, then we drop the result into a `.prose` container. With
 * `fontFamily: 'inherit'` those two places resolve to whatever each inherits —
 * so the width mermaid sized the boxes for is not necessarily the width the
 * text finally paints at, and labels overflow their boxes. Naming the stack
 * explicitly makes measure-time and paint-time the same font. Matches the
 * Tailwind default sans stack the rest of the UI uses.
 */
const DIAGRAM_FONT =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Diagrams (flowchart, sequence, state, ER, mindmap, timeline, gantt, …) via Mermaid. */
const renderMermaid: VisualRenderer = async (el, code, ctx) => {
    const mermaid = (await import('mermaid')).default;

    // Mermaid has THREE colour ramps, not one, and each is read by different
    // diagram kinds — see mermaidTheme.ts, which owns the whole mapping and the
    // one rule that keeps it honest (a fill is never chosen without its label).
    //
    // `base` is the only base theme that takes these variables as given. The
    // light themes used to pass `neutral`, which is Mermaid's GREYSCALE ramp:
    // a mindmap of six branches drew six identical grey boxes, on a page whose
    // whole point was to tell them apart.
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: DIAGRAM_FONT,
        // Pinned, not inherited: MIN_LEGIBLE_SCALE is derived from this number,
        // so leaving it to Mermaid's default would let a library upgrade move
        // the floor without moving the constant that documents it.
        fontSize: DIAGRAM_FONT_PX,
        themeVariables: mermaidThemeVariables(ctx.palette),
    });

    // Deterministically fix the label-grammar breakers small models emit
    // (unquoted parens/Greek/superscripts, <br/>, cosmetic style lines) before
    // parsing — model-independent, so the LLM repair loop only handles the rest.
    const safe = sanitizeMermaid(code);

    // Validate first: parse() throws with a line-precise message on bad syntax,
    // while render() can leave error artifacts in the DOM.
    await mermaid.parse(safe);

    // Mermaid needs the SVG in the live DOM to measure text, so it appends a
    // temporary <div id="d{id}"> to <body>. It usually removes it, but on an
    // interrupted/overlapping render (streaming) the node leaks — accumulating
    // full-size diagrams in <body> that grow the page and thrash the scrollbar.
    // Use a known id prefix (so index.css can pull the temp node out of layout
    // flow) and delete it ourselves in finally to be certain it's gone.
    const id = `visual-mermaid-${++renderSeq}`;
    let svg: string;
    try {
        ({ svg } = await mermaid.render(id, safe));
    } finally {
        document.getElementById(`d${id}`)?.remove();
    }
    el.innerHTML = svg;

    const svgEl = el.querySelector('svg');
    if (svgEl) {
        svgEl.style.height = 'auto';
        svgEl.style.display = 'block';
        svgEl.style.margin = '0 auto';

        // Size against the diagram's natural width instead of a blanket
        // `max-width: 100%`, which shrank a wide diagram by however much the
        // container demanded — unbounded, so on a phone the labels vanished.
        //
        // Target width, for natural N, floor F = N·MIN_LEGIBLE_SCALE and
        // container C:  W = min(N, max(C, F))
        //   N ≤ C          → N   (fits; never upscale past natural size)
        //   N > C ≥ F      → C   (shrink to fit — still legible)
        //   N > C, C < F   → F   (hold at the floor; the stage scrolls)
        //
        // Written as CSS rather than solved here in JS on a measured width,
        // because `100%` is then resolved by the browser at LAYOUT time: it
        // stays right when the phone rotates, when the panel is resized, and —
        // the case that actually bites — when the diagram renders inside a
        // hidden tab, where VisualBlock can only measure 0 and falls back to a
        // guessed 600px. A number computed now would be wrong by the time the
        // learner looks at it; this expression can't be.
        const natural = svgEl.viewBox?.baseVal?.width || 0;
        if (natural > 0) {
            const floor = Math.round(natural * MIN_LEGIBLE_SCALE);
            // `none` is required to beat `.visual-block-stage svg { max-width:
            // 100% }` in index.css, which would otherwise re-shrink it.
            svgEl.style.maxWidth = 'none';
            svgEl.style.width = `min(${natural}px, max(100%, ${floor}px))`;
        } else {
            // No viewBox to reason about — keep the old fit-to-width behaviour.
            svgEl.style.maxWidth = '100%';
        }
    }
};

export default renderMermaid;
