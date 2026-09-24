/**
 * One palette for every AI-authored visual, read from the app's own live CSS
 * variables — and the rule for making a colour somebody else chose survive a
 * theme it was never drawn against.
 *
 * WHY THIS EXISTS. Every visual kind here is authored by a model that cannot
 * see the screen, and each of them handled the theme differently or not at
 * all: mermaid and vega got a bare `dark ? … : …` boolean, function-plot got a
 * `.dark`-scoped CSS override, the widget baked its variables into an iframe at
 * mount, and ```animation and ```p5 got NOTHING — a model writes
 * `stroke="#1e293b"` (or `background(17, 24, 39)`) because it is imagining
 * white paper (or a dark canvas), and that guess is wrong for half the themes
 * this app ships. A near-black arrow on `slate-900` is not a subtle problem:
 * the line is simply not there.
 *
 * A boolean was never enough either. It was not when the app shipped four named
 * themes — a cream page and a true-black one were both drawn against stock
 * white/`slate-900` — and it is less so now that a theme is a mode plus any
 * TINT: every light theme is `isDark === false` and no two of them are the same
 * page colour.
 *
 * TWO RULES, and the split is the whole design:
 *
 *   - An ACHROMATIC colour is not a choice, it is "ink" or "paper". The author
 *     meant "the text colour" and wrote whichever one their imagined page
 *     wanted, so what carries over is its EMPHASIS — its contrast against that
 *     page — onto this theme's ink ladder. Measuring emphasis rather than
 *     lightness is what lets a scene drawn light-on-dark and one drawn
 *     dark-on-light both come out right.
 *
 *   - A CHROMATIC colour IS a choice and carries meaning (the red vector is not
 *     the blue one), so its hue and saturation are kept exactly and only its
 *     LIGHTNESS moves — just far enough to clear the non-text contrast floor
 *     against this theme's background. Recolouring it would destroy the one
 *     thing it was for.
 *
 * The palette is read from the CSS custom properties in index.css rather than
 * hardcoded, so the `warm` and `black` retints apply for free and a future
 * theme needs no change here.
 */

/** WCAG 1.4.11 non-text contrast: graphical objects need 3:1 against their background. */
const MIN_GRAPHIC_CONTRAST = 3;
/**
 * Below this CHROMA (max channel minus min, 0-1) a colour reads as grey.
 *
 * Chroma, not HSL saturation, and the difference is not academic: Tailwind's
 * `slate` ink is blue-tinted, so `#1e293b` has saturation 0.33 — comfortably
 * "chromatic" — while its chroma is 0.11. Judged by saturation, the single most
 * common ink colour a model writes was being treated as a meaningful hue and
 * merely brightened, instead of being remapped onto the theme's own ink.
 */
const ACHROMATIC_CHROMA = 0.16;
/**
 * The backdrop a model assumes when it does not draw one. SVG is paper by
 * default and models colour it that way; a sketch or scene that declares its
 * own background passes that instead (see `assumedBg`).
 */
export const DEFAULT_ASSUMED_BG = '#ffffff';

export interface VisualPalette {
    /** `mode:tint` — the cache key for a render, and the only thing in here a
     *  caller may compare to decide whether a redraw is needed. */
    theme: string;
    /** True for the dark-axis themes. Renderers with only a boolean switch use this. */
    dark: boolean;
    /** The surface a visual is drawn ON (`.visual-block-stage`), as `#rrggbb`. */
    bg: string;
    /** Primary ink. */
    fg: string;
    /** Secondary ink: axis labels, captions, de-emphasised strokes. */
    muted: string;
    /** Hairlines: borders, gridlines, tick marks. */
    border: string;
    /** The learner's accent (solid — pairs with white text). */
    accent: string;
    /** The accent as TEXT on this theme's background. */
    accentFg: string;
    /** A contrasting second accent for a two-series visual. */
    accent2: string;
    /** Categorical series colours, already adapted to `bg`. */
    series: string[];
}

interface Rgb { r: number; g: number; b: number }

/* ── colour maths ───────────────────────────────────────────────────────── */

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const hex2 = (n: number) => Math.round(clamp01(n) * 255).toString(16).padStart(2, '0');

export function rgbToHex({ r, g, b }: Rgb): string {
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/**
 * A handful of CSS colour keywords a model actually writes. Deliberately NOT
 * the full 148-name table: everything past these is already a considered
 * choice, and an unrecognised colour is left alone rather than guessed at.
 */
const NAMED: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
    blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
    gray: '#808080', grey: '#808080', silver: '#c0c0c0', lime: '#00ff00',
    cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff',
    navy: '#000080', teal: '#008080', olive: '#808000', maroon: '#800000',
    pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', darkgray: '#a9a9a9',
    darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
};

/** Parse `#rgb`, `#rrggbb`, `rgb()/rgba()`, a bare `r g b` triplet, or a known keyword. Null on anything else. */
export function parseColor(raw: string | null | undefined): Rgb | null {
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase();
    if (!s || s === 'none' || s === 'transparent' || s === 'currentcolor' || s === 'inherit') return null;
    if (s.startsWith('url(') || s.startsWith('var(')) return null;

    const named = NAMED[s];
    const text = named ?? s;

    if (text.startsWith('#')) {
        const h = text.slice(1);
        if (h.length === 3 || h.length === 4) {
            const n = parseInt(h.slice(0, 3), 16);
            if (Number.isNaN(n)) return null;
            return {
                r: (((n >> 8) & 15) * 17) / 255,
                g: (((n >> 4) & 15) * 17) / 255,
                b: ((n & 15) * 17) / 255,
            };
        }
        if (h.length === 6 || h.length === 8) {
            const n = parseInt(h.slice(0, 6), 16);
            if (Number.isNaN(n)) return null;
            return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
        }
        return null;
    }

    // rgb(1 2 3) / rgba(1,2,3,.5) / the bare "R G B" triplet our CSS vars hold.
    const nums = text.replace(/^rgba?\(/, '').replace(/\)$/, '').split(/[\s,/]+/).filter(Boolean).map(Number);
    if (nums.length >= 3 && nums.slice(0, 3).every(n => Number.isFinite(n))) {
        return { r: nums[0] / 255, g: nums[1] / 255, b: nums[2] / 255 };
    }
    return null;
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, s: 0, l };
    const s = d / (1 - Math.abs(2 * l - 1));
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s, l };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const t: [number, number, number] =
        h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
            : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return { r: clamp01(t[0] + m), g: clamp01(t[1] + m), b: clamp01(t[2] + m) };
}

/**
 * Keep a colour's identity, make it visible: hold hue and saturation and walk
 * the LIGHTNESS away from the background until it clears `min` contrast.
 *
 * Walking rather than solving because the relationship between HSL lightness
 * and WCAG luminance is not invertible in closed form for an arbitrary hue —
 * a saturated yellow and a saturated blue at the same L differ by a factor of
 * six in luminance. 40 steps of 0.02 covers the whole range at a resolution
 * finer than the eye, and if nothing in that range clears the bar (a mid-grey
 * background, where both directions are dim) we keep the best attempt rather
 * than returning something illegible OR unrecognisable.
 */
export function ensureContrast(color: Rgb, bg: Rgb, min = MIN_GRAPHIC_CONTRAST): Rgb {
    if (contrastRatio(color, bg) >= min) return color;
    const { h, s, l } = rgbToHsl(color);
    // Move away from the background: on a dark page brighten, on a light one darken.
    const dir = luminance(bg) < 0.5 ? 1 : -1;
    let best = color;
    let bestRatio = contrastRatio(color, bg);
    for (let i = 1; i <= 40; i++) {
        const next = hslToRgb(h, s, clamp01(l + dir * i * 0.02));
        const ratio = contrastRatio(next, bg);
        if (ratio > bestRatio) { best = next; bestRatio = ratio; }
        if (ratio >= min) return next;
    }
    return best;
}

/**
 * Adapt one colour a model chose to the theme it is actually being drawn in.
 *
 * `assumedBg` is the backdrop the author was drawing against, and it is what
 * makes the achromatic half work at all. An achromatic colour's meaning is its
 * EMPHASIS, and emphasis is not lightness — it is contrast against the page the
 * author had in mind. Judged by lightness alone, `stroke="white"` is "very
 * light, therefore faint", so the white outline the visuals guide's own example
 * draws around a dot on a dark scene would be demoted to a hairline and vanish;
 * judged against the dark backdrop that scene declares, it is 17:1 — the
 * strongest ink on the canvas — and lands on this theme's foreground, which on
 * a light theme means it correctly turns dark.
 *
 * A ```p5 sketch declares its backdrop by calling `background()`, and an SVG
 * declares one by painting a full-canvas rect; absent either, paper is assumed,
 * because that is what a model draws for by default.
 *
 * `role` decides one thing: a near-invisible FILL was the page itself and
 * becomes the canvas, while the same value as a STROKE was a faint hairline.
 */
export function adaptColor(
    raw: string | null | undefined,
    palette: VisualPalette,
    role: 'fill' | 'stroke' | 'text' = 'stroke',
    assumedBg: string = DEFAULT_ASSUMED_BG,
): string | null {
    const rgb = parseColor(raw);
    if (!rgb) return null;
    const bg = parseColor(palette.bg) ?? { r: 1, g: 1, b: 1 };
    const { r, g, b } = rgb;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);

    if (chroma < ACHROMATIC_CHROMA) {
        // Ink, not meaning: carry its emphasis over to this theme's ink ladder.
        const against = parseColor(assumedBg) ?? { r: 1, g: 1, b: 1 };
        const emphasis = contrastRatio(rgb, against);
        if (emphasis < 1.6) return role === 'fill' ? palette.bg : palette.border;
        if (emphasis >= 7) return palette.fg;
        if (emphasis >= 3) return palette.muted;
        return palette.border;
    }

    // A real colour: keep it, but make sure it is on the page.
    return rgbToHex(ensureContrast(rgb, bg, role === 'text' ? 4.5 : MIN_GRAPHIC_CONTRAST));
}

/* ── reading the app's own tokens ───────────────────────────────────────── */

/**
 * Categorical series colours. A fixed, validated set rather than tints of the
 * user's accent: an accent ramp cannot distinguish more than about three
 * classes, and it would change what a series MEANS when the learner changes
 * their accent. Each is run through `ensureContrast` against the live
 * background before it is handed out.
 */
const SERIES_SEED = ['#3b82f6', '#f97316', '#10b981', '#a855f7', '#ef4444', '#14b8a6'];

function cssVar(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

/** A `--c-slate-N` token (stored as a bare `R G B` triplet) as `#rrggbb`. */
function slate(step: number, fallback: string): string {
    const rgb = parseColor(cssVar(`--c-slate-${step}`, ''));
    return rgb ? rgbToHex(rgb) : fallback;
}

/**
 * The palette for the theme currently on the document.
 *
 * `themeKey` is passed in rather than sniffed so the caller (VisualBlock) can
 * make it a render dependency: reading it here would mean a theme change had no
 * value React could notice, which is precisely how visuals came to keep the
 * palette they were first drawn with.
 *
 * It is `mode:tint` (`themeKeyOf` in the store), not a theme name. Everything
 * below already reads the real surfaces off the document — the key only has to
 * CHANGE when they do, and since a theme became a colour the mode alone no
 * longer does: switching from a lavender page to a cream one is the same mode
 * and an entirely different palette.
 */
export function readVisualPalette(themeKey: string): VisualPalette {
    const dark = themeKey.split(':')[0] === 'dark';
    const white = parseColor(cssVar('--c-white', '')) ;
    const bg = dark ? slate(900, '#0f172a') : (white ? rgbToHex(white) : '#ffffff');
    const bgRgb = parseColor(bg) ?? { r: 1, g: 1, b: 1 };

    const accentRgb = parseColor(cssVar('--accent-rgb', '14 116 144')) ?? { r: 0.05, g: 0.45, b: 0.56 };
    const accentFgRgb = parseColor(cssVar('--accent-fg-rgb', '14 116 144')) ?? accentRgb;

    return {
        theme: themeKey,
        dark,
        bg,
        fg: dark ? slate(100, '#f1f5f9') : slate(800, '#1e293b'),
        muted: dark ? slate(400, '#94a3b8') : slate(500, '#64748b'),
        border: dark ? slate(700, '#334155') : slate(200, '#e2e8f0'),
        accent: rgbToHex(ensureContrast(accentRgb, bgRgb)),
        accentFg: rgbToHex(ensureContrast(accentFgRgb, bgRgb, 4.5)),
        accent2: dark ? '#fbbf24' : '#b45309',
        series: SERIES_SEED.map(c => rgbToHex(ensureContrast(parseColor(c)!, bgRgb))),
    };
}


const COLOR_ATTRS: Array<[string, 'fill' | 'stroke' | 'text']> = [
    ['fill', 'fill'],
    ['stroke', 'stroke'],
    ['stop-color', 'fill'],
    ['flood-color', 'fill'],
    ['lighting-color', 'fill'],
    ['color', 'text'],
];

/**
 * The backdrop an SVG drew for itself, if it drew one.
 *
 * A scene meant for a dark page paints it: a `<rect>` covering the viewBox.
 * Finding it matters twice over — every achromatic colour in the scene is
 * measured against it, and the rect itself has to be repainted in the theme's
 * own surface or the drawing arrives inside a slab of somebody else's colour.
 * Returns null when the scene assumes paper, which is the common case and the
 * right default.
 */
function declaredBackdrop(svg: SVGSVGElement): { color: string; el: Element } | null {
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || !vb.every(Number.isFinite)) return null;
    const [vx, vy, vw, vh] = vb;
    if (!(vw > 0 && vh > 0)) return null;

    for (const el of Array.from(svg.querySelectorAll('rect'))) {
        const x = parseFloat(el.getAttribute('x') || '0');
        const y = parseFloat(el.getAttribute('y') || '0');
        const w = parseFloat(el.getAttribute('width') || '0');
        const h = parseFloat(el.getAttribute('height') || '0');
        // 96%: a scene often insets its backdrop by a pixel or two.
        if (!(w >= vw * 0.96 && h >= vh * 0.96 && x <= vx + vw * 0.04 && y <= vy + vh * 0.04)) continue;
        const fill = parseColor(el.getAttribute('fill'));
        if (fill) return { color: rgbToHex(fill), el };
    }
    return null;
}

/**
 * Recolour an SVG a model wrote so it is legible on this theme.
 *
 * Applies `adaptColor` to every presentation attribute that can carry one, plus
 * the same properties inside an inline `style=`. Anything it cannot parse —
 * `none`, `url(#gradient)`, `currentColor`, a colour keyword outside the small
 * table — is left exactly as written: this may only ever make a drawing
 * visible, never change what it depicts.
 */
export function themeSvgColors(svg: SVGSVGElement, palette: VisualPalette): void {
    const backdrop = declaredBackdrop(svg);
    const assumed = backdrop?.color ?? DEFAULT_ASSUMED_BG;
    const nodes: Element[] = [svg, ...Array.from(svg.querySelectorAll('*'))];
    for (const el of nodes) {
        const tag = el.tagName.toLowerCase();
        const isText = tag === 'text' || tag === 'tspan';
        for (const [attr, baseRole] of COLOR_ATTRS) {
            const raw = el.getAttribute(attr);
            if (raw == null) continue;
            // The backdrop is not ink and is not measured against itself — it
            // simply becomes this theme's surface.
            if (backdrop && el === backdrop.el && attr === 'fill') {
                el.setAttribute('fill', palette.bg);
                continue;
            }
            const role = isText && attr === 'fill' ? 'text' : baseRole;
            const next = adaptColor(raw, palette, role, assumed);
            if (next) el.setAttribute(attr, next);
        }
        // A CSS keyframe animation carries its colours in a <style> block, not
        // in attributes — same rule, same rewrite, or the animated half of the
        // scene keeps the palette the attributes just lost.
        if (tag === 'style') {
            const css = el.textContent || '';
            const rewrittenCss = css.replace(
                /\b(fill|stroke|stop-color|color|background|background-color)\s*:\s*([^;}]+)/gi,
                (whole, prop: string, value: string) => {
                    const p = prop.toLowerCase();
                    const role: 'fill' | 'stroke' | 'text' =
                        p === 'stroke' ? 'stroke' : p === 'color' ? 'text' : 'fill';
                    const next = adaptColor(value, palette, role, assumed);
                    return next ? `${prop}:${next}` : whole;
                },
            );
            if (rewrittenCss !== css) el.textContent = rewrittenCss;
            continue;
        }

        const style = el.getAttribute('style');
        if (style) {
            const rewritten = style.replace(
                /(^|;)\s*(fill|stroke|stop-color|color|background|background-color)\s*:\s*([^;]+)/gi,
                (whole, lead: string, prop: string, value: string) => {
                    const p = prop.toLowerCase();
                    const role: 'fill' | 'stroke' | 'text' =
                        p === 'stroke' ? 'stroke' : p === 'color' ? 'text' : 'fill';
                    const next = adaptColor(value, palette, isText && p === 'fill' ? 'text' : role, assumed);
                    return next ? `${lead}${prop}:${next}` : whole;
                },
            );
            if (rewritten !== style) el.setAttribute('style', rewritten);
        }
    }
}

/* ── mixing and readable ink ────────────────────────────────────────────── */

/** Linear mix of two colours, `t` from 0 (all `a`) to 1 (all `b`). */
export function mixColors(a: string, b: string, t: number): string {
    const ca = parseColor(a) ?? { r: 1, g: 1, b: 1 };
    const cb = parseColor(b) ?? { r: 0, g: 0, b: 0 };
    const k = clamp01(t);
    return rgbToHex({
        r: ca.r + (cb.r - ca.r) * k,
        g: ca.g + (cb.g - ca.g) * k,
        b: ca.b + (cb.b - ca.b) * k,
    });
}

/**
 * Text that can be read ON a given fill.
 *
 * Every place this app hands a colour to a library that then prints a LABEL on
 * it, the label and the fill have to be decided together — a fill chosen alone
 * is the mindmap bug: mermaid filled the root node with one theme variable and
 * printed its text with another, so on the dark themes the centre of every
 * diagram was a coloured blob with unreadable text in it.
 *
 * Near-black and near-white are the only two candidates on purpose: an ink
 * derived from the fill's own hue looks considered and reads worse, and at
 * label sizes what matters is contrast, which one of these two always wins.
 */
export function readableOn(fill: string): string {
    const bg = parseColor(fill);
    if (!bg) return '#0f172a';
    const ink = { r: 0.043, g: 0.075, b: 0.145 };   // ≈ #0b1325
    const paper = { r: 1, g: 1, b: 1 };
    return contrastRatio(ink, bg) >= contrastRatio(paper, bg) ? '#0b1325' : '#ffffff';
}
