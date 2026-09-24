import type { VisualPalette } from './palette';
export type { VisualPalette };

// Code-as-image visual system.
//
// The AI tutor (or the user) writes a fenced code block in a known "visual
// language" (```mermaid, ```vega-lite, ```plot, ```smiles, ```math) and the
// shared Markdown renderer dispatches it to a deterministic renderer instead
// of syntax-highlighting it. The LLM never produces pixels — it produces a
// small text spec that a library turns into an inline SVG. That keeps visuals
// editable, diffable, offline and theme-aware.
//
// Adding a renderer = one module exporting a `VisualRenderer` (default export)
// plus one entry in RENDERERS and ALIASES below. Renderer libraries are
// dynamically imported so Vite code-splits them out of the main bundle.

export interface VisualContext {
    /** Whether the app is in dark mode at render time. */
    isDark: boolean;
    /**
     * The theme's own colours, read live from the app's CSS variables.
     *
     * `isDark` is kept because two renderers (mermaid, vega) take a boolean
     * theme switch and nothing finer, but it is not enough on its own: a theme
     * is a mode and a TINT, so every light theme reduces to the same boolean
     * while none of them is the same page colour. Everything that picks its own
     * colours — and everything that has to rescue colours a model picked —
     * uses this.
     */
    palette: VisualPalette;
    /** Pixel width available to the visual (container width, best-effort). */
    width: number;
    /**
     * Pixel height the visual must fit, when the host has one to give.
     *
     * Normally absent: a visual is drawn into a column that grows to hold it,
     * and a renderer choosing its own height from its width is right. A
     * thumbnail is the exception — the settings gallery draws every kind into
     * the same 144px stage — and a renderer that ignores the height is not
     * shrunk by the stage, it is CLIPPED by it: a function graph at its own
     * 4:3 came out as its top half, no x axis and the bottom of the curve cut
     * off, which reads as a rendering bug rather than a box too small.
     */
    maxHeight?: number;
    /**
     * Live status line for slow renderers (the widget compiler can sit queued
     * behind a chat generation for minutes). Shown in the shell's pending
     * footer; cheap renderers just never call it.
     */
    onProgress?: (message: string) => void;
    /** Aborted when the block unmounts or its source changes mid-render. */
    signal?: AbortSignal;
    /**
     * Whether a renderer may kick off an expensive LLM build without the user
     * asking (true only for a message freshly generated this session — mirrors
     * the shell's autoRepair consent). When false, renderers that would need a
     * build render a "Build" button instead.
     */
    autoBuild?: boolean;
    /**
     * The spec the renderer actually DREW, when it is not the block's own
     * source: the SVG a specialist pass drew from a scene brief, the sketch it
     * wrote, the HTML a widget was compiled into. The shell shows it under the
     * brief in the Source panel — a reader asking "show me the code" for a
     * brief-backed animation was being shown three sentences of prose.
     */
    onResolved?: (spec: string) => void;
}

/**
 * Renders `code` into `el` (a detached scratch element; the shell swaps it in
 * only on success, so a mid-stream parse failure never wipes the last good
 * render). Must throw on invalid input — the shell shows the error + source.
 * May return a cleanup function (e.g. vega view finalizer).
 */
export type VisualRenderer = (
    el: HTMLElement,
    code: string,
    ctx: VisualContext
) => Promise<void | (() => void)>;

const RENDERERS: Record<string, () => Promise<VisualRenderer>> = {
    mermaid: () => import('./renderMermaid').then(m => m.default),
    vega: () => import('./renderVega').then(m => m.default),
    plot: () => import('./renderPlot').then(m => m.default),
    smiles: () => import('./renderSmiles').then(m => m.default),
    math: () => import('./renderMath').then(m => m.default),
    // Code-as-animation (D-020): time-varying visuals as code, never video.
    animation: () => import('./renderAnimation').then(m => m.default),
    p5: () => import('./renderP5').then(m => m.default),
    // Interactive widgets (D-022): the fence holds a functional SPEC; a queued
    // server-side LLM pass compiles it to sandboxed HTML (see renderWidget).
    widget: () => import('./renderWidget').then(m => m.default),
};

/** Fence language → canonical renderer kind. */
const ALIASES: Record<string, string> = {
    mermaid: 'mermaid',
    vega: 'vega',
    'vega-lite': 'vega',
    vegalite: 'vega',
    chart: 'vega',
    plot: 'plot',
    graph: 'plot',
    'function-plot': 'plot',
    smiles: 'smiles',
    molecule: 'smiles',
    math: 'math',
    latex: 'math',
    katex: 'math',
    tex: 'math',
    animation: 'animation',
    animate: 'animation',
    anim: 'animation',
    smil: 'animation',
    'svg-anim': 'animation',
    'svg-animation': 'animation',
    p5: 'p5',
    p5js: 'p5',
    'p5-js': 'p5',
    sketch: 'p5',
    simulation: 'p5',
    widget: 'widget',
    interactive: 'widget',
    applet: 'widget',
};

/**
 * Kinds that follow a theme change themselves, without being re-rendered.
 *
 * Every other visual bakes the palette into the SVG or canvas it produces, so
 * the only way to re-theme one is to draw it again — cheap, and it loses
 * nothing, because there is nothing in it to lose. A widget is different in
 * exactly that respect: it is the one visual the learner is DOING something
 * with, so redrawing it would discard their slider positions and whatever the
 * simulation was part-way through, and pay a second verification probe to do
 * it. `renderWidget` subscribes to the theme itself and pushes new CSS
 * variables into the live iframe instead; VisualBlock keeps the palette out of
 * its dependency list for these so nothing tears the frame down underneath it.
 */
export const SELF_THEMING_KINDS: ReadonlySet<string> = new Set(['widget']);

export const VISUAL_KIND_LABELS: Record<string, string> = {
    mermaid: 'Diagram',
    vega: 'Chart',
    plot: 'Graph',
    smiles: 'Molecule',
    math: 'Math',
    animation: 'Animation',
    p5: 'Simulation',
    widget: 'Interactive',
};

/** Returns the canonical visual kind for a fence language, or null if the block is ordinary code. */
export function getVisualKind(language: string | undefined | null): string | null {
    if (!language) return null;
    return ALIASES[language.toLowerCase()] ?? null;
}

/** Numeric constants a model may write bare into a spec (`"stop": 2*PI`). */
const SPEC_CONSTANTS: Record<string, number> = {
    'Math.PI': Math.PI, PI: Math.PI, pi: Math.PI, 'π': Math.PI, TAU: 2 * Math.PI,
};
const NUM = String.raw`\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const TERM = String.raw`(?:${NUM}|Math\.PI|PI|pi|π|TAU)`;
// An arithmetic expression sitting where a JSON *value* belongs (after ':', '['
// or ','), e.g. `4*PI` or `2 * 3.5`. Requires at least one operator, so plain
// numbers (including 1e-5 and -5) are never touched.
const VALUE_EXPR = new RegExp(
    String.raw`(?<=[:\[,]\s*)-?\(?\s*${TERM}(?:\s*[-+*/^]\s*-?\(?\s*${TERM}\s*\)?)+`,
    'g',
);

/**
 * Evaluate a small arithmetic expression (numbers, PI/TAU, + - * / ^, parens,
 * unary minus). Returns null on anything it doesn't fully understand — the
 * caller then leaves the source text alone rather than guessing.
 */
function evalArithmetic(src: string): number | null {
    const tokens = src.match(new RegExp(String.raw`${TERM}|[-+*/^()]`, 'g'));
    if (!tokens || tokens.join('').replace(/\s/g, '').length !== src.replace(/\s/g, '').length) return null;

    let i = 0;
    const peek = () => tokens[i];
    // expr := term (('+'|'-') term)* ; term := power (('*'|'/') power)*
    // power := unary ('^' power)? ; unary := '-'? primary  (right-assoc power)
    const expr = (): number | null => {
        let left = term();
        if (left === null) return null;
        while (peek() === '+' || peek() === '-') {
            const op = tokens[i++];
            const right = term();
            if (right === null) return null;
            left = op === '+' ? left + right : left - right;
        }
        return left;
    };
    const term = (): number | null => {
        let left = power();
        if (left === null) return null;
        while (peek() === '*' || peek() === '/') {
            const op = tokens[i++];
            const right = power();
            if (right === null) return null;
            left = op === '*' ? left * right : left / right;
        }
        return left;
    };
    const power = (): number | null => {
        const base = unary();
        if (base === null) return null;
        if (peek() !== '^') return base;
        i++;
        const exp = power();
        return exp === null ? null : base ** exp;
    };
    const unary = (): number | null => {
        if (peek() === '-') { i++; const v = unary(); return v === null ? null : -v; }
        const tok = tokens[i++];
        if (tok === undefined) return null;
        if (tok === '(') {
            const v = expr();
            if (v === null || tokens[i++] !== ')') return null;
            return v;
        }
        if (tok in SPEC_CONSTANTS) return SPEC_CONSTANTS[tok];
        const n = Number(tok);
        return Number.isFinite(n) ? n : null;
    };

    const value = expr();
    return i === tokens.length && value !== null && Number.isFinite(value) ? value : null;
}

/**
 * Fold bare arithmetic in JSON *values* down to numbers: `"domain":[0, 4*PI]`
 * → `"domain":[0, 12.566…]`. JSON has no expressions and neither JSON5 nor
 * JSON.parse will take one, so a spec like that dies at parse and burns an LLM
 * repair round-trip on arithmetic we can just do ourselves. VISUALS_GUIDE
 * forbids it; local models do it anyway — so fix it mechanically, per the D-018
 * rule that the deterministic sanitizer is the front line.
 *
 * Only text OUTSIDE string literals is touched, so expression strings that are
 * *meant* to stay symbolic ("calculate":"datum.x*PI/180", "fn":"sin(x)") are
 * left exactly as written.
 */
export function foldSpecArithmetic(text: string): string {
    let out = '';
    let inString = false;
    let quote = '';
    let segment = '';

    const flush = () => {
        out += segment.replace(VALUE_EXPR, (match) => {
            const value = evalArithmetic(match);
            return value === null ? match : String(value);
        });
        segment = '';
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (ch === '\\') { out += text[++i] ?? ''; continue; }
            if (ch === quote) inString = false;
            continue;
        }
        if (ch === '"' || ch === "'") {
            flush();
            inString = true;
            quote = ch;
            out += ch;
            continue;
        }
        segment += ch;
    }
    flush();
    return out;
}

/**
 * Parse JSON, falling back to JSON5 on failure. Local LLMs routinely emit
 * "almost JSON" — unquoted keys, trailing commas, single quotes, // comments,
 * bare arithmetic (`4*PI`) — which strict JSON.parse rejects. Arithmetic is
 * folded to numbers first, then JSON5 tolerates the rest, so a slightly sloppy
 * Vega/plot spec still renders instead of throwing. (Deeply broken specs still
 * throw and fall through to the error card / AI repair.)
 */
export async function parseLooseJson(text: string): Promise<unknown> {
    try {
        return JSON.parse(text);
    } catch {
        const folded = foldSpecArithmetic(text);
        try {
            return JSON.parse(folded);
        } catch {
            const JSON5 = (await import('json5')).default;
            return JSON5.parse(folded);
        }
    }
}

const loaded: Record<string, Promise<VisualRenderer>> = {};

export function loadRenderer(kind: string): Promise<VisualRenderer> {
    const factory = RENDERERS[kind];
    if (!factory) return Promise.reject(new Error(`Unknown visual kind: ${kind}`));
    return (loaded[kind] ??= factory());
}
