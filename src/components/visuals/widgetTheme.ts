import type { VisualPalette } from './palette';
import { SANDBOX_THEME_JS } from './sandboxTheme';

/**
 * The ```widget theme bridge — the half of `palette.ts` that has to live INSIDE
 * the sandbox.
 *
 * Other visual kinds re-render on a theme change; a widget must not (a re-render
 * loses slider positions and simulation state, and re-runs the verification
 * probe). It follows the theme by having new CSS variables posted into the live
 * iframe, so this module is all that keeps an old cached build legible.
 *
 * Builds often open with their own fallback definitions, which come LATER than the
 * host's block (top of <head>) and win at equal specificity, pinning the widget to
 * the theme the model imagined:
 *
 *     :root { --w-bg: #ffffff; --w-fg: #111827; … }
 *
 * TWO LAYERS, applied at RENDER time so they reach cached builds without a rebuild
 * (so `WIDGET_CONTRACT_VERSION` is deliberately NOT bumped for this):
 *
 *   1. The host's variables are written at `:root:root`, a specificity a build
 *      cannot reach, and the build's own declarations of those names are deleted
 *      (its other `--w-*` variables are its own and stay).
 *   2. Every colour the build states LITERALLY — CSS, inline `style=`, SVG
 *      `fill=`/`stroke=`, a canvas context — goes through the app's achromatic-ink /
 *      chromatic-meaning rule (`palette.ts`, via its twin `sandboxTheme.ts`).
 *
 * A colour the HOST supplied is never re-judged: judged against assumed paper, a
 * dark theme's own `#f1f5f9` ink would be demoted to its background, erasing every
 * label. Anything equal to a palette colour passes straight through.
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
 * `html body` for the two colour properties, so a build's `body { background: #fff }`
 * also loses on specificity. `font-family` stays at plain `body`: a build may
 * legitimately choose its own face.
 */
export const WIDGET_BASE_CSS =
    'html,body{margin:0;padding:0;}'
    + 'body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;}'
    + 'html body{background:var(--w-bg);color:var(--w-fg);}';

/**
 * The host's root font size, handed across the iframe boundary.
 *
 * `ui_scale` (80–160%) sets the app's root font size, but a widget is a separate
 * document whose root stays at 16px. `html{font-size}` reaches builds using rem,
 * `body{font-size}` builds setting nothing; px sizes are left alone, like
 * `font-family` above.
 */
export function widgetRootFontCss(rootPx: number): string {
    const px = Number.isFinite(rootPx) && rootPx > 0 ? Math.round(rootPx * 100) / 100 : 16;
    return `html{font-size:${px}px;}body{font-size:1rem;}`;
}

/**
 * The host's theme block.
 *
 * `:root,:root:root`: the second branch (0-2-0) beats a build's own `:root`
 * (0-1-0) regardless of source order.
 */
export function widgetThemeCss(p: VisualPalette): string {
    return `:root,:root:root{${widgetThemeVars(p)}}${WIDGET_BASE_CSS}`;
}

/**
 * The sandbox-side rule, as source text (like `SANDBOX_THEME_JS`): the widget runs
 * in an opaque-origin iframe under `default-src 'none'` and cannot import anything.
 *
 * Pure functions only, so `tools/visual-theme-gates.mjs` can evaluate this and
 * `palette.ts` over one table of inputs. The DOM wiring is in `widgetThemePrelude`.
 *
 * Depends on `SANDBOX_THEME_JS` being concatenated ahead of it (`__vtParse`,
 * `__vtToHex`, `__vtAdapt`, `__vtAlpha`, `__vtWithAlpha`, `__VT_NAMED`).
 */
export const WIDGET_THEME_JS = `
var __WT_ROLE = {'color':'text','caret-color':'text','-webkit-text-fill-color':'text','background':'fill','background-color':'fill','fill':'fill','stop-color':'fill'};
var __WT_HOST_VAR = /^--w-(?:bg|fg|muted|border|accent|accent-2|series-\\d+)$/;
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

/** A declaration's property name, lower-cased; '' when it is not a declaration. */
function __wtProp(decl) {
    var c = decl.indexOf(':');
    return c < 0 ? '' : decl.slice(0, c).trim().toLowerCase();
}

/**
 * A declaration in a form that survives the browser re-serialising it: colours
 * as hex plus alpha, no spaces. A script that sets one property makes the
 * browser rewrite the whole attribute (white comes back as rgb(255, 255, 255)).
 */
function __wtCanon(decl) {
    var c = decl.indexOf(':');
    if (c < 0) return decl.replace(/\\s+/g, '').toLowerCase();
    var value = decl.slice(c + 1).replace(__WT_COLOR_RE, function (lit) {
        var rgb = __vtParse(lit);
        return rgb ? __vtToHex(rgb) + '@' + __vtAlpha(lit) : lit;
    });
    return __wtProp(decl) + ':' + value.replace(/\\s+/g, '').toLowerCase();
}

/**
 * The text a re-theme derives from.
 *
 * The build's ORIGINAL, so remapping never compounds; except where a script has
 * changed the text since this pass last wrote it (a bar's height, an indicator's
 * position), because going back to the original would undo that state. A style
 * attribute is merged declaration by declaration: what the pass wrote and the
 * script left alone returns to its original, what the script wrote stays.
 */
function __wtSource(orig, written, cur, byDeclaration) {
    if (orig === undefined) return cur;
    if (written === undefined || cur === written) return orig;
    if (!byDeclaration) return cur;
    var was = {}, base = {}, w = String(written).split(';'), o = String(orig).split(';');
    for (var i = 0; i < w.length; i++) { var wk = __wtProp(w[i]); if (wk) was[wk] = __wtCanon(w[i]); }
    for (var j = 0; j < o.length; j++) { var ok = __wtProp(o[j]); if (ok) base[ok] = o[j]; }
    var parts = String(cur).split(';');
    for (var k = 0; k < parts.length; k++) {
        var pk = __wtProp(parts[k]);
        if (pk && base[pk] !== undefined && was[pk] === __wtCanon(parts[k])) parts[k] = base[pk];
    }
    return parts.join(';');
}

/** Rewrite every colour in one declaration list; drop the --w-* variables the host defines. */
function __wtDeclarations(text, pal) {
    var parts = String(text).split(';');
    for (var i = 0; i < parts.length; i++) {
        var decl = parts[i], c = decl.indexOf(':');
        if (c < 0) continue;
        var prop = decl.slice(0, c), name = prop.trim().toLowerCase();
        // Not a property name (a selector's pseudo-class, a URL) — leave it be.
        if (!/^(--[\\w-]+|-?[a-z][a-z-]*)$/.test(name)) continue;
        // Only the variables the host defines. A build's own --w-radius or
        // --w-gap is its own and is read back by its own var(); deleting it
        // would break the layout of a build that worked.
        if (__WT_HOST_VAR.test(name)) { parts[i] = ''; continue; }
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
 * WHERE this runs matters: it is injected at the top of `<head>`, before the
 * build's `<style>` elements exist, so the markup pass runs from the tail script
 * `buildWidgetDoc` splices in at the END. The canvas wrapper installs immediately;
 * it only has to beat the build's own `<script>`, which sits last.
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
                // __wtRaw is the fill colour the backdrop check below reads, so
                // only a fill writes it, and an assignment that is not a colour
                // clears it: after a gradient the old string no longer applies.
                // A gradient or pattern object is not a colour — pass it on.
                if (name === 'fillStyle') this.__wtRaw = typeof v === 'string' ? v : undefined;
                if (typeof v !== 'string') { d.set.call(this, v); return; }
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
                        // The opacity the author stated stays: a trail fade or a
                        // dim laid over the frame is translucent on purpose.
                        if (d && d.set) d.set.call(this, __vtWithAlpha(__wtPalette.bg, __vtAlpha(raw)));
                    }
                }
            }
            return fillRect.call(this, x, y, w, h);
        };
        // restore() brings back a fill this wrapper never saw assigned, so what
        // it last recorded no longer says what the context will paint with.
        var restore = C.prototype.restore;
        C.prototype.restore = function () {
            this.__wtRaw = undefined;
            return restore.apply(this, arguments);
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
    // than of the theme arrived at. The exception is text the widget's own
    // script has changed since (__wtOrigW is what this pass last wrote): that
    // is state, and re-deriving from the load-time text would put it back.
    function apply() {
        var styles = document.querySelectorAll('style');
        for (var i = 0; i < styles.length; i++) {
            if (styles[i].id === '__w-theme') continue;
            var sheetNow = styles[i].textContent;
            var src = __wtSource(styles[i].__wtOrig, styles[i].__wtOrigW, sheetNow, false);
            styles[i].__wtOrig = src;
            var css = __wtCssRemap(src, __wtPalette);
            if (css !== sheetNow) styles[i].textContent = css;
            styles[i].__wtOrigW = styles[i].textContent;
        }
        var inline = document.querySelectorAll('[style]');
        for (var j = 0; j < inline.length; j++) {
            var styleNow = inline[j].getAttribute('style') || '';
            var raw = __wtSource(inline[j].__wtOrig, inline[j].__wtOrigW, styleNow, true);
            inline[j].__wtOrig = raw;
            var next = __wtDeclarations(raw, __wtPalette);
            if (next !== styleNow) inline[j].setAttribute('style', next);
            inline[j].__wtOrigW = inline[j].getAttribute('style') || '';
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
                // Same rule as the style text above: a value the script set
                // since this pass wrote is the new original.
                el[key] = __wtSource(el[key], el[key + 'W'], cur, false);
                // Back to the original where nothing adapts it on this theme,
                // not only forward to an adapted colour.
                var to = __wtAdapt(el[key], __wtPalette, at === 'fill' ? 'fill' : 'stroke') || el[key];
                if (to !== cur) el.setAttribute(at, to);
                el[key + 'W'] = el.getAttribute(at);
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
 * Spliced in before </body>, so it runs AFTER the build's own <script> and sees the
 * DOM it built. Elements created later are not walked; the canvas wrapper covers
 * their drawing, and re-walking on every mutation would cost more than it buys.
 */
export const WIDGET_THEME_TAIL = 'if(window.__wtApply)window.__wtApply();';
