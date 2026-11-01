/**
 * Is a failed render the SPEC's fault, or the app's?
 *
 * A render that throws goes to the model as "fix this spec" (VisualBlock's
 * repair loop), and that is a paid call made for every learner who opens the
 * page. It is only worth making when the spec is what is wrong. When the
 * renderer itself is broken — a bundler change once left every built graph
 * throwing "u is not a function" from inside our own code — the model is
 * handed a correct spec and an error it cannot act on, rewrites the spec
 * anyway, and the graph stays broken: a repair per page load, and nothing to
 * show for it.
 *
 * The error alone does not tell the two apart. Its CLASS does not: a model's
 * expression is compiled and run inside function-plot, so a bad spec throws a
 * TypeError from library code just as a broken bundle does, and a p5 sketch's
 * own runtime errors arrive as plain messages. Its TEXT does not either:
 * "x is not a function" is what both say. What does tell them apart is a spec
 * of the same kind that is KNOWN to draw: hand the renderer that, and if it
 * fails too the fault is in the renderer, whatever this block's spec says.
 * That costs one extra local render, only after a failure, and once per kind
 * per page load (the bundle cannot change underneath a loaded page, so
 * neither can the answer).
 *
 * The specs below are deliberately the plainest thing each kind draws: a
 * canary that could itself trip a validator would make a healthy renderer
 * look broken and switch repair off for real spec faults. For the same reason
 * only the five LIBRARY renderers have one — the kinds a bundler change can
 * break, as it did. `animation` and `p5` judge a drawing by running it (a
 * rasterised motion probe, a hidden iframe that executes the sketch), and
 * those can say no for reasons of the environment — the visual-block gate's
 * jsdom has no rasteriser, a background tab throttles frames — which would
 * read as a broken renderer. `widget` has none either: drawing one is a
 * server build, i.e. the paid call this exists to avoid. A kind without a
 * canary keeps today's behaviour: its failures are taken as the spec's.
 */
import type { VisualContext, VisualRenderer } from './registry';

const KNOWN_GOOD: Record<string, string> = {
    plot: 'x^2',
    vega: '{"mark":"bar","data":{"values":[{"x":"a","y":1},{"x":"b","y":3},{"x":"c","y":2}]},"encoding":{"x":{"field":"x","type":"nominal"},"y":{"field":"y","type":"quantitative"}}}',
    mermaid: 'flowchart LR\n  A[Start] --> B[End]',
    smiles: 'CCO',
    math: 'x^2 + 1',
};

/** Per kind: true = the renderer drew the known-good spec. */
const verdicts = new Map<string, Promise<boolean>>();

/**
 * True when the renderer for `kind` cannot draw a spec known to be good, i.e.
 * a failure of this block is the app's and no model call can fix it. False
 * when it can, and for a kind with no known-good spec (nothing to compare
 * against, so the spec keeps the benefit of the doubt it always had).
 */
export function rendererIsBroken(kind: string, render: VisualRenderer, ctx: VisualContext): Promise<boolean> {
    const spec = KNOWN_GOOD[kind];
    if (!spec) return Promise.resolve(false);
    let verdict = verdicts.get(kind);
    if (!verdict) {
        // Its own scratch element and none of the block's callbacks: this
        // render must never start a build, report a build key, or show.
        const probe = document.createElement('div');
        verdict = render(probe, spec, { isDark: ctx.isDark, palette: ctx.palette, width: ctx.width })
            .then(cleanup => { try { cleanup?.(); } catch { /* drawn is all we asked */ } return true; },
                () => false)
            .then(drew => !drew);
        verdicts.set(kind, verdict);
    }
    return verdict;
}

/** Tests only: forget every verdict, so a stubbed renderer is asked again. */
export function forgetRendererHealth(): void {
    verdicts.clear();
}
