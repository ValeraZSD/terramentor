// The app's mark, as a function of the three things the learner can choose.
//
// ONE copy of the geometry, because there are now three places that draw it and
// they must draw the same picture: `tools/brand.mjs` (the files a build ships),
// `server/appIcon.js` (the PNGs and the manifest an installed app fetches) and
// `src/utils/appIcon.ts` (the live preview in Settings and the favicon the tab
// shows). A mark drawn in three files is a mark that is three marks by the end
// of the year.
//
// It lives under `server/` rather than in `tools/` because the Docker image
// ships `server`, `dist` and `public` and nothing else — the runtime half has
// to be reachable from a container that has no `tools/` directory. The client
// imports it through `src/utils/appIcon.ts`; it has no dependencies and touches
// no DOM and no filesystem, so both sides can.
//
// The artwork is an open book inside a wireframe globe — terra + mentor, the
// thing the app does drawn as the thing it is about. It is vector, in its own
// coordinates, placed into a 64-unit viewBox, so every output is the same
// geometry at the weight its container can actually show.
//
// The pages are OPAQUE on purpose. With `fill:none` the grid shows straight
// through them, the book stops sitting in front of the globe, and the whole
// mark reads as a wireframe ball with ears. The occlusion is the drawing — which
// is why `paper` is the TILE's colour and never `none`. The one place hollow is
// right is `brand/terramentor-mono.svg`, a stencil with no tile behind it.

/** The tile the mark has sat on since the mark existed. */
export const DEFAULT_BACKGROUND = '#0b1220';
/** Ink on a dark tile — slate-200. */
export const INK_LIGHT = '#e2e8f0';
/** Ink on a light tile — the same near-black the default tile is. */
export const INK_DARK = '#0b1220';

/**
 * Which cut of the mark.
 *
 *   full     the globe's grid kept — the richest version, and the one the
 *            192/512 tiles can actually show
 *   simple   no grid, heavier line — and what the full cut has to become at
 *            16px anyway, where the grid is mud (see `gridFloor` below)
 *
 * TWO, not three. A hollow "outline" cut was built and cut on 2026-09-17: with
 * the pages unfilled the grid shows through them, the book stops sitting in
 * front of the globe, and the mark reads as a wireframe ball with ears. It
 * survives as `brand/terramentor-mono.svg`, which is a stencil for print and has
 * no tile behind it — the one place hollow is the right answer. Anything stored
 * that names it falls back to the default here.
 */
export const ICON_STYLES = ['full', 'simple'];
export const DEFAULT_STYLE = 'full';

/**
 * How round the tile is, as a percentage of its width. 0 is a square, 50 is a
 * circle, and the default reproduces the corner the shipped icon has always had
 * (rx 13 on a 57-unit tile = 22.8%).
 */
export const MIN_RADIUS = 0;
export const MAX_RADIUS = 50;
export const DEFAULT_RADIUS = 23;

/** Settings keys, named once so the three readers cannot disagree. */
export const ICON_SETTING_KEYS = {
    style: 'app_icon_style',
    background: 'app_icon_bg',
    radius: 'app_icon_radius',
};

// --------------------------------------------------------------- artwork ----
// The source drawing, in its own units. Its UNSTROKED bounds are x 5..368.02 and
// y 8.09..371.11 — exactly 363.02 square — which is what everything below scales
// from. Numbers are the export's own; nothing here is retyped by eye.
export const ART = {
    x0: 5, y0: 8.09, span: 363.02,
    globe: '<circle cx="186.51" cy="189.6" r="181.51"/>',
    grid: '<ellipse cx="186.51" cy="189.6" rx="90.76" ry="181.51"/>'
        + '<line x1="334.58" y1="86.59" x2="38.44" y2="86.59"/>'
        + '<line x1="335.38" y1="292.61" x2="38.72" y2="294.33"/>'
        + '<line x1="368.02" y1="189.6" x2="5" y2="189.6"/>',
    pages: '<polygon points="368.02 8.09 186.51 98.85 186.51 280.36 368.02 189.6 368.02 8.09"/>'
        + '<polygon points="5 8.09 186.51 98.85 186.51 280.36 5 189.6 5 8.09"/>',
    spine: '<line x1="186.51" y1="8.09" x2="186.51" y2="371.11"/>',
};

const f = (n) => (Math.round(n * 1000) / 1000).toString();

/**
 * The mark placed in the 64-unit box.
 *
 * `d` is the diameter it should occupy and `stroke` its weight, both in those
 * 64 units — so the caller reasons in the coordinates it can see, and the scale
 * back into the artwork's own units happens here. A `scale()` transform scales
 * the stroke with everything else, which is why the width is divided rather
 * than passed through.
 */
export function markArt({ d = 46, stroke = 2.2, paper = '#ffffff', ink = '#000000', grid = true } = {}) {
    const s = d / ART.span;
    const tx = 32 - (ART.x0 + ART.span / 2) * s;
    const ty = 32 - (ART.y0 + ART.span / 2) * s;
    const w = stroke / s;
    return `<g transform="translate(${f(tx)} ${f(ty)}) scale(${f(s)})"`
        + ` fill="${paper}" stroke="${ink}" stroke-width="${f(w)}"`
        + ` stroke-linejoin="round" stroke-linecap="round">`
        + ART.globe
        + (grid ? `<g fill="none">${ART.grid}</g>` : '')
        + ART.pages
        + ART.spine.replace('<line', '<line fill="none"')
        + '</g>';
}

export const svgDoc = (body, size = 64, title = 'Terramentor') =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}"`
    + ` role="img" aria-label="${title}">${body}</svg>`;

// ------------------------------------------------------------- the choice ----

/** `#abc` and `#AABBCC` are one colour; anything else is not a colour at all. */
export function normalizeHex(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return `#${m[1][0]}${m[1][0]}${m[1][1]}${m[1][1]}${m[1][2]}${m[1][2]}`;
    m = /^#([0-9a-f]{6})$/.exec(s);
    return m ? `#${m[1]}` : null;
}

export function clampRadius(value) {
    // `Number(null)` and `Number('')` are both 0, not NaN — so an ABSENT row read
    // straight through this returned a square tile, and a fresh install's
    // generated icon stopped matching the one it ships with. An unset setting is
    // the default, and only something that reads as a number is a number.
    if (value === null || value === undefined || value === '') return DEFAULT_RADIUS;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_RADIUS;
    return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, n));
}

/**
 * Whatever is in the settings table, turned into something drawable.
 *
 * Every field falls back rather than throwing, and the colour is the reason
 * this function is not optional: the value lands inside `fill="…"` in a
 * document the browser parses. A hex pattern is the whole validation — the
 * colour is never passed through as typed.
 */
export function normalizeAppIcon(raw) {
    const r = raw || {};
    return {
        style: ICON_STYLES.includes(r.style) ? r.style : DEFAULT_STYLE,
        background: normalizeHex(r.background) || DEFAULT_BACKGROUND,
        radius: clampRadius(r.radius),
    };
}

/** Read the three settings rows into one icon. `settings` is the kv dump. */
export function appIconFromSettings(settings) {
    const s = settings || {};
    return normalizeAppIcon({
        style: s[ICON_SETTING_KEYS.style],
        background: s[ICON_SETTING_KEYS.background],
        radius: s[ICON_SETTING_KEYS.radius],
    });
}

/** WCAG relative luminance of a `#rrggbb`. */
export function luminance(hex) {
    const h = normalizeHex(hex) || '#000000';
    const ch = [1, 3, 5].map((i) => {
        const v = parseInt(h.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrastRatio(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The ink for a chosen background.
 *
 * Not a setting: a fourth control over one picture, whose only correct answers
 * are the two this function picks between. The learner chooses a tile colour
 * and the drawing stays legible on it — the same bargain `adjustForContrast`
 * makes for the accent (a colour is not painted as chosen when painting it as
 * chosen produces something unreadable).
 *
 * Two near-extreme inks, so the worst case is a mid-grey tile, which no shipped
 * swatch is; `iconContrast` is what the UI warns on for a typed-in one.
 */
export function inkFor(background) {
    const bg = normalizeHex(background) || DEFAULT_BACKGROUND;
    return contrastRatio(bg, INK_LIGHT) >= contrastRatio(bg, INK_DARK) ? INK_LIGHT : INK_DARK;
}

/** How legible the mark is on that tile, so a caller can say so out loud. */
export function iconContrast(background) {
    return contrastRatio(normalizeHex(background) || DEFAULT_BACKGROUND, inkFor(background));
}

/**
 * A short stable name for one icon, so a URL can be cached forever and still
 * change the moment any of the three choices does.
 *
 * FNV-1a over the normalised triple — not a cryptographic hash and not trying
 * to be: it is a cache key whose only job is to differ when the picture differs.
 */
export function appIconHash(icon) {
    const { style, background, radius } = normalizeAppIcon(icon);
    const s = `${style}|${background}|${radius}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36).padStart(7, '0');
}

// --------------------------------------------------------------- variants ----
/**
 * What each output actually is.
 *
 *   favicon    full bleed, rounded, and the heavier line. A tab draws this at
 *              16–32px, where a transparent margin is a pixel off each side and
 *              ink blots (+31% at 16px against +23% at 64px, measured in
 *              `brand.mjs`). The chosen cut is kept from 20px up and dropped
 *              below it — see `gridFloor`.
 *   tile       the `any` icon: a margin, because Windows and macOS want one.
 *   maskable   full bleed and NEVER rounded — Android's mask does the corner,
 *              and iOS composites `apple-touch-icon` on an opaque background
 *              itself. Rounding here would be rounded twice, unevenly.
 */
export const ICON_VARIANTS = ['favicon', 'tile', 'maskable'];

const VARIANT_GEOMETRY = {
    favicon: { inset: 0, d: 44, stroke: 3.4, gridFloor: 20, rounded: true },
    tile: { inset: 3.5, d: 35, stroke: 2, gridFloor: 0, rounded: true },
    maskable: { inset: 0, d: 30, stroke: 1.8, gridFloor: 0, rounded: false },
};

/**
 * One icon, as an SVG document.
 *
 * `gridFloor` is the size BELOW which the grid is dropped whatever was chosen.
 * It used to be a flag on the variant — the favicon cut was always the simple
 * one — which made "Detailed / Simple" a control that changed nothing where
 * anybody looks: the tab. Photographed at every tab size on 2026-09-17
 * (`temp/tab-cut-compare.mjs`) the two cuts are plainly different pictures from
 * 20px up and the same grey mush at 16, so the floor is a SIZE, and only the
 * one raster we know is 16px (`favicon-16.png`) gives the choice up. The tab's
 * own SVG is written at 64 and rasterised by the browser at whatever the screen
 * asks for, so it follows the choice.
 */
export function appIconSvg(icon, variant = 'tile', size = 64) {
    const { style, background, radius } = normalizeAppIcon(icon);
    const geo = VARIANT_GEOMETRY[variant] || VARIANT_GEOMETRY.tile;
    const ink = inkFor(background);
    const width = 64 - 2 * geo.inset;
    const rx = geo.rounded ? (Math.min(MAX_RADIUS, radius) / 100) * width : 0;
    const grid = style === 'full' && size >= (geo.gridFloor || 0);
    // The cut that drops the grid carries the heavier line the grid's absence
    // asks for — thin lines with nothing between them read as a sketch.
    const stroke = geo.stroke * (grid ? 1 : 1.2);
    const art = markArt({ d: geo.d, stroke, grid, paper: background, ink });
    const tile = `<rect x="${f(geo.inset)}" y="${f(geo.inset)}" width="${f(width)}" height="${f(width)}"`
        + ` rx="${f(rx)}" fill="${background}"/>`;
    return svgDoc(tile + art, size);
}

/**
 * The mark with no tile at all, stroked in one colour — for print, a patch, or
 * anywhere the surface behind it is not ours to paint. Not a choice the icon
 * settings expose; `brand.mjs` ships it as a file.
 */
export function markOnlySvg({ ink = '#000000', paper = 'none', grid = false, stroke = 3.4, size = 64 } = {}) {
    return svgDoc(markArt({ stroke, grid, paper, ink }), size);
}
