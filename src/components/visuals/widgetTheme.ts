import type { VisualPalette } from './palette';
import { SANDBOX_THEME_JS } from './sandboxTheme';

/**
 * The ```widget theme bridge — the half of `palette.ts` that has to live INSIDE
 * the sandbox.
 *
 * Every other visual kind is re-rendered when the theme changes (`VisualBlock`
 * makes the theme a dependency), so its colours are chosen fresh each time. A
 * widget is the one kind that must not be: it is interactive, so a re-render
 * throws away the learner's slider positions and the state of a running
 * simulation, and pays a second verification probe for the privilege. It
 * follows the theme by having new CSS variables posted into the live iframe
 * instead — which means this module is the ONLY thing standing between a build
 * cached months ago and a white card on a black theme.
 *
 * WHAT WENT WRONG, and it was not a model whim. The compiler prompt tells the
 * builder that the host injects `--w-bg`, `--w-fg`, … and that it must style
 * with those and never with hardcoded page colours. A model that cannot see the
 * host does the reasonable, defensive thing and opens its stylesheet with its
 * own fallback definitions:
 *
 *     :root { --w-bg: #ffffff; --w-fg: #111827; … }
 *
 * The host's block is injected at the top of <head>, so the build's copy is
 * LATER in source order and wins at equal specificity. The widget is then
 * pinned to the theme it imagined, permanently — and the live re-theme, which
 * rewrites the host's block, is rewriting the loser. Measured on the real
 * library: 3 of 5 cached builds do exactly this.
 *
 * TWO LAYERS, both mechanical, both applied at RENDER time so they reach builds
 * already in the cache without a rebuild (which is why `WIDGET_CONTRACT_VERSION`
 * is deliberately NOT bumped for this — a bump would cost every learner a
 * recompile of every widget to fix something the runtime can fix for free):
 *
 *   1. The host's variables are written at a specificity a build cannot reach
 *      (`:root:root`), and the build's own `--w-*` declarations are deleted
 *      from its stylesheet outright. The host owns those names.
 *
 *   2. Every colour the build states LITERALLY — in its CSS, in an inline
 *      `style=`, on an SVG `fill=`/`stroke=`, or handed to a canvas context —
 *      goes through the same achromatic-ink / chromatic-meaning rule the rest
 *      of the app uses (`palette.ts`, via its checked twin `sandboxTheme.ts`).
 *      So a build that ignored the contract entirely still comes out legible.
 *
 * The one rule that makes layer 2 safe is that a colour the HOST supplied is
 * never re-judged. A compliant widget reads `var(--w-fg)` and hands the
 * resolved value to the canvas; on a dark theme that is `#f1f5f9`, which is
 * achromatic and, measured against the paper backdrop a model is assumed to
 * have drawn for, reads as "barely there" — so the ordinary rule would demote
 * this theme's own ink to this theme's background and erase every label on the
 * card. Anything already equal to a palette colour is passed straight through.
 */

/** The palette shape the sandbox is handed — plain data, JSON-serialisable. */
export interface WidgetPalette {
    bg: string;
    fg: string;
    muted: string;
    border: string;
    accent: string;
    accent2: string;
    series: string[];
}

export function widgetPalette(p: Pick<VisualPalette, 'bg' | 'fg' | 'muted' | 'border' | 'accent' | 'accent2' | 'series'>): WidgetPalette {
    return {
        bg: p.bg, fg: p.fg, muted: p.muted, border: p.border,
        accent: p.accent, accent2: p.accent2, series: p.series ?? [],
    };
}

/** The contract variables, as one declaration list. */
export function widgetThemeVars(p: VisualPalette): string {
    return `--w-bg:${p.bg};--w-fg:${p.fg};--w-muted:${p.muted};--w-border:${p.border};`
        + `--w-accent:${p.accent};--w-accent-2:${p.accent2};`
        + p.series.map((c, i) => `--w-series-${i + 1}:${c};`).join('');
}

/**
 * Everything in the injected stylesheet that is NOT a colour.
 *
 * `html body` rather than `body` for the two colour properties, so a build's
 * own `body { background: #fff }` loses on specificity as well as on the
 * remap — belt and braces, because those two are the difference between a card
 * that is readable and one that is a white rectangle. `font-family` stays at
 * plain `body`: a build choosing a monospace face is making a legitimate
 * typographic decision and this is not the place to overrule it.
 */
export const WIDGET_BASE_CSS =
    'html,body{margin:0;padding:0;}'
    + 'body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;}'
    + 'html body{background:var(--w-bg);color:var(--w-fg);}';

/**
 * The host's root font size, handed across the iframe boundary.
 *
 * `ui_scale` (Settings → Interface size, 80–160%) works by setting
 * `documentElement.style.fontSize` — so every rem in the app scales, and a
 * widget scales not at all: it is a separate document whose root stays at the
 * browser's 16px default. A learner who set the interface to 140% got a card
 * whose prose, buttons and labels all grew and whose interactive widget kept
 * its original type, which reads as the widget being broken rather than as a
 * setting not reaching it.
 *
 * Written as `html{font-size}` so a build using rem follows the setting, and as
 * `body{font-size}` so one using nothing at all does too. A build that sets its
 * own sizes in px is untouched, deliberately: choosing px is a typographic
 * decision and this is not the place to overrule it — the same line the
 * `font-family` rule above draws.
 */
export function widgetRootFontCss(rootPx: number): string {
    const px = Number.isFinite(rootPx) && rootPx > 0 ? Math.round(rootPx * 100) / 100 : 16;
    return `html{font-size:${px}px;}body{font-size:1rem;}`;
}

/**
 * The host's theme block.
 *
 * `:root,:root:root` is the whole point: the second branch has specificity
 * 0-2-0, so it beats the `:root` (0-1-0) a build declares for itself no matter
 * which of the two the browser reads first. Position stops mattering, which
 * also means a re-theme cannot be undone by where the build happened to put its
 * `<style>`.
 */
export function widgetThemeCss(p: VisualPalette): string {
    return `:root,:root:root{${widgetThemeVars(p)}}${WIDGET_BASE_CSS}`;
}

/**
 * The sandbox-side rule, as source text, for the same reason `SANDBOX_THEME_JS`
 * is: the widget runs in an opaque-origin iframe under `default-src 'none'` and
 * cannot import a module, fetch one, or reach this document.
 *
 * Pure functions only — no DOM, no globals — so `tools/visual-theme-gates.mjs`
 * can evaluate this and `palette.ts` over one table of inputs and let the
 * comparison be the contract. The DOM wiring lives in `widgetThemePrelude`.
 *
 * Depends on `SANDBOX_THEME_JS` being concatenated ahead of it (`__vtParse`,
 * `__vtToHex`, `__vtAdapt`, `__VT_NAMED`).
 */
export const WIDGET_THEME_JS = `
var __WT_ROLE = {'color':'text','caret-color':'text','-webkit-text-fill-color':'text','background':'fill','background-color':'fill','fill':'fill','stop-color':'fill'};
var __WT_COLOR_RE = /#[0-9a-f]{8}(?![0-9a-f])|#[0-9a-f]{6}(?![0-9a-f])|#[0-9a-f]{4}(?![0-9a-f])|#[0-9a-f]{3}(?![0-9a-f])|rgba?\\([^)]*\\)|\\b(?:black|white|red|green|blue|yellow|orange|purple|gray|grey|silver|lime|cyan|aqua|magenta|fuchsia|navy|teal|olive|maroon|pink|brown|gold|darkgray|darkgrey|lightgray|lightgrey)\\b/gi;

/** The set of colours the host itself handed the widget, as normalised hex. */
function __wtHostSet(pal) {
    if (pal.__wtSet) return pal.__wtSet;
    var set = {}, list = [pal.bg, pal.fg, pal.muted, pal.border, pal.accent, pal.accent2].concat(pal.series || []);
    for (var i = 0; i < list.length; i++) {
        var c = __vtParse(list[i]);
        if (c) set[__vtToHex(c)] = 1;
    }
    pal.__wtSet = set;
    return set;
}

/**
 * Adapt ONE literal colour, or null to leave it exactly as it is.
 *
 * Null on a colour the host supplied (already this theme's own — re-judging it
 * is how this theme's ink becomes this theme's background) and null on anything
 * that is not a colour at all. The backdrop is paper, because a literal colour
 * in a build that was told to use the variables is by definition a colour the
 * model chose while imagining a page, and a model imagines white paper.
 */
function __wtAdapt(raw, pal, role) {
    var rgb = __vtParse(raw);
    if (!rgb) return null;
    if (__wtHostSet(pal)[__vtToHex(rgb)]) return null;
    var next = __vtAdapt(raw, pal, role || 'stroke', __wtAssumedBg);
    return next && next !== raw ? next : null;
}

/** A full-canvas fill is the widget's backdrop, the way background() is a sketch's. */
var __wtAssumedBg = '#ffffff';

/** Rewrite every colour in one declaration list; drop any --w-* the build declares. */
function __wtDeclarations(text, pal) {
    var parts = String(text).split(';');
    for (var i = 0; i < parts.length; i++) {
        var decl = parts[i], c = decl.indexOf(':');
        if (c < 0) continue;
        var prop = decl.slice(0, c), name = prop.trim().toLowerCase();
        // Not a property name (a selector's pseudo-class, a URL) — leave it be.
        if (!/^(--[\\w-]+|-?[a-z][a-z-]*)$/.test(name)) continue;
        if (name.indexOf('--w-') === 0) { parts[i] = ''; continue; }
        var role = __WT_ROLE[name] || 'stroke';
        var value = decl.slice(c + 1);
        var next = value.replace(__WT_COLOR_RE, function (lit) {
            return __wtAdapt(lit, pal, role) || lit;
        });
        if (next !== value) parts[i] = prop + ':' + next;
    }
    return parts.join(';');
}

/**
 * Re-colour a whole stylesheet.
 *
 * Brace-depth scan rather than a regex over the lot: a '#' in a selector is an
 * id, not a colour, and only text inside a block can be a declaration. Nested
 * at-rules pass through harmlessly because a selector never looks like a
 * property name.
 */
function __wtCssRemap(css, pal) {
    var text = String(css == null ? '' : css), out = '', buf = '', depth = 0;
    for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        if (ch === '{') { out += buf + ch; buf = ''; depth++; }
        else if (ch === '}') {
            out += (depth > 0 ? __wtDeclarations(buf, pal) : buf) + ch;
            buf = '';
            if (depth > 0) depth--;
        } else buf += ch;
    }
    return out + (depth > 0 ? __wtDeclarations(buf, pal) : buf);
}
`;

/**
 * The full injected script: the rule, this theme's palette as data, and the DOM
 * wiring that applies it.
 *
 * WHERE this runs matters as much as what it does — the p5 lesson (wrapping
 * `window` before p5 had populated it compiled, shipped and did nothing). The
 * remap needs the build's own `<style>` elements to exist, and the harness is
 * injected at the top of `<head>` where they do not yet, so the wiring is
 * emitted separately and spliced in at the END of the document by
 * `buildWidgetDoc`. The canvas wrapper is installed immediately either way,
 * since it only has to beat the build's own `<script>`, which sits last.
 */
export function widgetThemePrelude(p: VisualPalette): string {
    return `${SANDBOX_THEME_JS}${WIDGET_THEME_JS}
var __wtPalette = ${JSON.stringify(widgetPalette(p))};
(function () {
    // Every one of these is an ENHANCEMENT: the widget already ran and probed
    // clean without it. So nothing in here may be allowed to throw — an
    // exception reaches the harness's window.onerror, which reports the build
    // as broken and sends a perfectly good widget round the repair loop.
    function safely(fn) { try { fn(); } catch (e) { } }

    // ── canvas ──────────────────────────────────────────────────────────────
    // A widget's chart is drawn, not styled, so its colours never touch CSS:
    // they are strings assigned to ctx.fillStyle / ctx.strokeStyle, computed
    // per frame. Wrapping the prototype accessor is the only place they can all
    // be caught, and it is what makes a re-theme reach the plot rather than
    // just the card around it.
    var C = window.CanvasRenderingContext2D;
    function wrap(proto, name, role) {
        if (!proto) return;
        var d = Object.getOwnPropertyDescriptor(proto, name);
        if (!d || !d.set || !d.get) return;
        Object.defineProperty(proto, name, {
            configurable: true,
            enumerable: d.enumerable,
            get: function () { return d.get.call(this); },
            set: function (v) {
                // A gradient or pattern object is not a colour — pass it on.
                if (typeof v !== 'string') { d.set.call(this, v); return; }
                this.__wtRaw = v;
                var next = __wtAdapt(v, __wtPalette, role);
                d.set.call(this, next || v);
            },
        });
    }
    if (C) safely(function () {
        wrap(C.prototype, 'fillStyle', 'fill');
        wrap(C.prototype, 'strokeStyle', 'stroke');
        wrap(C.prototype, 'shadowColor', 'stroke');
        // The backdrop, declared the way a p5 sketch declares one. A fill that
        // covers the whole canvas is the page the rest of the frame is drawn
        // against, not a shape on it: an achromatic one becomes this theme's
        // surface (rather than being read as "very dark ink, keep it dark"),
        // and whatever the author asked for is remembered, so a scene drawn
        // light-on-dark keeps its emphasis instead of being demoted to a
        // hairline the way a pale stroke on paper would be.
        var fillRect = C.prototype.fillRect;
        C.prototype.fillRect = function (x, y, w, h) {
            var cv = this.canvas;
            if (cv && x <= 1 && y <= 1 && w >= cv.width * 0.95 && h >= cv.height * 0.95) {
                var raw = this.__wtRaw;
                var rgb = raw ? __vtParse(raw) : null;
                if (rgb && !__wtHostSet(__wtPalette)[__vtToHex(rgb)]) {
                    __wtAssumedBg = raw;
                    var chroma = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
                    // A CHROMATIC canvas (a sky, a board) was a deliberate part
                    // of the picture and is kept; a grey one was "the page".
                    if (chroma < 0.16) {
                        var d = Object.getOwnPropertyDescriptor(C.prototype, 'fillStyle');
                        if (d && d.set) d.set.call(this, __wtPalette.bg);
                    }
                }
            }
            return fillRect.call(this, x, y, w, h);
        };
    });
    if (window.CanvasGradient) safely(function () {
        var stop = window.CanvasGradient.prototype.addColorStop;
        window.CanvasGradient.prototype.addColorStop = function (offset, color) {
            var next = typeof color === 'string' ? __wtAdapt(color, __wtPalette, 'fill') : null;
            return stop.call(this, offset, next || color);
        };
    });

    // ── markup ──────────────────────────────────────────────────────────────
    // Re-derived from the build's ORIGINAL text every time, never from the last
    // remap: remapping an already-remapped stylesheet compounds, so after two
    // theme changes the colours would be a function of the route taken rather
    // than of the theme arrived at.
    function original(el, read) {
        if (el.__wtOrig === undefined) el.__wtOrig = read(el);
        return el.__wtOrig;
    }
    function apply() {
        var styles = document.querySelectorAll('style');
        for (var i = 0; i < styles.length; i++) {
            if (styles[i].id === '__w-theme') continue;
            var src = original(styles[i], function (e) { return e.textContent; });
            var css = __wtCssRemap(src, __wtPalette);
            if (css !== styles[i].textContent) styles[i].textContent = css;
        }
        var inline = document.querySelectorAll('[style]');
        for (var j = 0; j < inline.length; j++) {
            var raw = original(inline[j], function (e) { return e.getAttribute('style') || ''; });
            var next = __wtDeclarations(raw, __wtPalette);
            if (next !== inline[j].getAttribute('style')) inline[j].setAttribute('style', next);
        }
        // Inline SVG states its colours as presentation attributes, which are
        // neither CSS nor canvas and would otherwise be the one drawing surface
        // this misses entirely.
        var painted = document.querySelectorAll('[fill],[stroke],[stop-color]');
        for (var k = 0; k < painted.length; k++) {
            var el = painted[k];
            var attrs = ['fill', 'stroke', 'stop-color'];
            for (var a = 0; a < attrs.length; a++) {
                var at = attrs[a], cur = el.getAttribute(at);
                if (cur === null) continue;
                var key = '__wtAttr_' + at;
                if (el[key] === undefined) el[key] = cur;
                var to = __wtAdapt(el[key], __wtPalette, at === 'fill' ? 'fill' : 'stroke');
                if (to && to !== cur) el.setAttribute(at, to);
            }
        }
    }

    // A widget that draws on input only — most charts — holds whatever was on
    // the canvas when the theme changed, so the new palette would reach the card
    // and not the plot inside it. The compiler contract requires a resize
    // handler that redraws, so that is the redraw hook we already have.
    window.__wtRetheme = function (palette) {
        if (palette) { __wtPalette = palette; }
        safely(apply);
        safely(function () { window.dispatchEvent(new Event('resize')); });
    };
    window.__wtApply = function () { safely(apply); };
})();`;
}

/**
 * The tail script: run the markup pass once the build's own styles exist.
 *
 * Spliced in before </body>, so it runs AFTER the build's own <script> (the
 * compiler contract puts that last) and therefore sees the DOM that script
 * built. Elements created LATER — on a slider change, say — are not walked; the
 * canvas wrapper covers the drawing they do, and re-walking the document on
 * every mutation would cost more than it buys.
 */
export const WIDGET_THEME_TAIL = 'if(window.__wtApply)window.__wtApply();';
