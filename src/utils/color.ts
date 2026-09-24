/**
 * Colour helpers shared across the UI.
 *
 * The app themes itself around the current project's colour via the
 * `--accent-rgb` CSS variable (a space-separated "R G B" triplet so Tailwind's
 * `accent` colour can apply any opacity modifier). These helpers convert the
 * stored hex colours into the shapes the CSS variable / rgba() calls expect.
 */

/** Default accent used outside a project context: a readable deep blue-cyan (cyan-700). */
export const DEFAULT_ACCENT_RGB = '14 116 144';

/** Default accent *text* colour in dark mode: a bright cyan (cyan-400) that clears AA on dark surfaces. */
export const DEFAULT_ACCENT_FG_DARK_RGB = '34 211 238';

/** Parse a #RGB or #RRGGBB hex string into [r, g, b], or null if malformed. */
export function hexToRgb(hex: string): [number, number, number] | null {
    if (!hex) return null;
    let h = hex.trim().replace(/^#/, '');
    if (h.length === 3) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}

// --- WCAG contrast maths (sRGB) --------------------------------------------
export function relLum([r, g, b]: [number, number, number]): number {
    // 0.04045 is the WCAG 2.1 published threshold (0.03928 is the superseded
    // erratum value); visuals/palette.ts computes luminance with the same one.
    const f = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
    const l1 = relLum(a), l2 = relLum(b);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
}
/**
 * Nudge a colour's HSL lightness (hue + saturation preserved) until it clears
 * `target` contrast against `bg`. `dir` = -1 darkens (for white text / light
 * surfaces), +1 lightens (for dark surfaces). Bounded so it can't run to
 * black/white. This is what lets an arbitrary user-picked project colour stay
 * legible as a themed accent regardless of how light/dark they chose.
 */
function adjustForContrast(rgb: [number, number, number], bg: [number, number, number], target: number, dir: 1 | -1, satFloor = 0): [number, number, number] {
    return adjustForContrastAll(rgb, [{ bg, target }], dir, satFloor);
}

/**
 * The same walk, against SEVERAL backgrounds at once — it stops when the colour
 * clears every one of them.
 *
 * Accent text does not land on one surface. On a dark theme the same value
 * paints a link on the bare panel AND a label inside an `accent/25` badge, and
 * those two are not the same measurement: driving to the badge alone left a
 * dark accent short of AA on the panel it sits next to (measured across the
 * 16 tints × 16 accents the picker ships: 4 combinations under 4.5:1 with the
 * badge check alone). One walk with two constraints is not two walks — the
 * colour has to satisfy both at the same lightness, which is exactly what
 * taking the harsher of two independently-solved answers cannot promise.
 */
function adjustForContrastAll(
    rgb: [number, number, number],
    checks: { bg: [number, number, number]; target: number }[],
    dir: 1 | -1,
    satFloor = 0,
): [number, number, number] {
    const [h, s0, l0] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    // A SATURATION FLOOR MAY LIFT A HUE; IT MAY NOT INVENT ONE. `Math.max(s0,
    // satFloor)` did, and HSL's hue for a grey is 0 — so white, black and every
    // grey in between came back RED on a dark theme, an accent nobody chose and
    // the picker never shows. (Reported 2026-09-22 for the first and last
    // swatch of the palette.) Achromatic in, achromatic out: the floor fades in
    // with the chroma that is actually there, reaching its full value at
    // `SAT_FLOOR_FULL` so a merely muted colour is still lifted and there is no
    // step anywhere along the way.
    const s = s0 >= satFloor ? s0 : s0 + (satFloor - s0) * Math.min(1, s0 / SAT_FLOOR_FULL);
    // START inside the band, don't only stop at it. The loop below breaks the
    // moment `l` reaches a bound — so a colour that BEGINS there never moved at
    // all: white (l = 1) was clamped to 0.98 on the first step and returned
    // #fafafa, i.e. a white button with a white label, which is what the picker's
    // first swatch produced for every project that chose it. Black mirrored it
    // through `accentFgTriplet`. Clamping first costs nothing for the colours in
    // range (0.02–0.98 covers every swatch and anything typed that is not
    // already paper or ink) and lets the extremes walk to a readable grey.
    const short = (c: [number, number, number]) => checks.some(k => contrastRatio(c, k.bg) < k.target);
    let l = Math.min(0.98, Math.max(0.02, l0));
    let out = hslToRgb(h, s, l);
    for (let i = 0; i < 100 && short(out); i++) {
        l += dir * 0.01;
        if (l <= 0.02 || l >= 0.98) { l = Math.min(0.98, Math.max(0.02, l)); out = hslToRgb(h, s, l); break; }
        out = hslToRgb(h, s, l);
    }
    return out;
}
/** Where a saturation floor reaches full strength. Below it the floor is scaled
 *  by how much hue the colour has, so a grey keeps none. 0.15 in HSL is about
 *  where a colour stops reading as "a grey" and starts reading as "a dull
 *  blue". */
const SAT_FLOOR_FULL = 0.15;
const WHITE: [number, number, number] = [255, 255, 255];
const DARK_SURFACE: [number, number, number] = [30, 41, 59]; // stock slate-800 — the untinted dark panel

/** Alpha-composite `fg` over `bg` (both opaque) at the given alpha, returning the flattened colour. */
function blend(fg: [number, number, number], bg: [number, number, number], alpha: number): [number, number, number] {
    return [
        Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
        Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
        Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
    ];
}

/**
 * The **solid** accent (`--accent-rgb`): buttons/rings/tints that carry white
 * label text. The contract in docs/ARCHITECTURE.md is "stays dark enough for white text" — so a
 * light project colour is darkened (hue kept) until white clears AA (4.5:1).
 */
export function accentSolidTriplet(hex: string | null | undefined): string {
    const rgb = hex ? hexToRgb(hex) : null;
    if (!rgb) return DEFAULT_ACCENT_RGB;
    return adjustForContrast(rgb, WHITE, 4.5, -1).join(' ');
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    const d = max - min;
    if (d !== 0) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            default: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
        Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
        Math.round(hue2rgb(p, q, h) * 255),
        Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
}

/**
 * The accent colour used for *text* (links, labels, badges). On light surfaces the
 * accent reads fine as-is; on dark surfaces a mid/dark colour fails AA, so we lift
 * its lightness (in HSL, keeping the hue) to a vibrant, readable shade. Returns the
 * "R G B" triplet for `--accent-fg-rgb`.
 *
 * `surface` IS THE PAGE THE READER IS ON, and it is not optional in practice.
 * Solving this from the mode alone — stock slate-800 and stock white — is the
 * whole truth only for an app with one dark surface and one light one. A theme
 * here is a mode and a TINT (`themeRamp.ts`), so those two constants name a
 * page almost nobody is looking at: an accent that clears AA on slate-800 is
 * measured against nothing at all on a cream page or a true-black one, and a
 * chat answer's `Sources:` links then land anywhere between comfortable and
 * unreadable depending on the tint (five screenshots, 2026-09-22). Pass the
 * rung the text actually sits on — `themeColorFor(mode, tint)`, the card in
 * light mode and the panel in dark — and the ratio below is a measurement
 * rather than an assumption.
 */
export function accentFgTriplet(hex: string | null | undefined, isDark: boolean, surface?: string | null): string {
    const rgb = hex ? hexToRgb(hex) : null;
    if (!rgb) return isDark ? DEFAULT_ACCENT_FG_DARK_RGB : DEFAULT_ACCENT_RGB;
    const bg = (surface ? hexToRgb(surface) : null) || (isDark ? DARK_SURFACE : WHITE);
    // TWO SURFACES, ONE COLOUR, BOTH MODES. Accent text almost never sits on the
    // bare page: it is also the label inside an `accent/10`…`accent/25` badge or a
    // selected row, and that tint eats into contrast — worst where the accent's own
    // luminance overlaps the surface's. So the walk clears the heaviest tint in use
    // (accent/25) at a notch above AA, 4.9:1, AND the bare surface at AA.
    //
    // The light branch only ever measured the bare page, which is why a badge there
    // was the one place the accent could be genuinely hard to read: across the 16
    // tints × 16 accents the picker ships, 222 of 256 combinations put label text
    // under 4.5:1 inside an accent/25 badge, worst 3.19:1 (measured 2026-09-22).
    // Dark had the badge check from the start and had never had the bare one.
    //
    // The badge is painted with `--accent-rgb`, the SOLID — the colour darkened
    // until a white label clears AA on it (`accentSolidTriplet`) — not with the
    // colour as chosen. For a light project colour those differ a lot (amber moves
    // 19 lightness points), and solving against the raw blend left 66 of 512
    // light-mode project badges under AA, worst 4.14:1.
    const solid = adjustForContrast(rgb, WHITE, 4.5, -1);
    const checks = [{ bg: blend(solid, bg, 0.25), target: 4.9 }, { bg, target: 4.5 }];
    return isDark
        ? adjustForContrastAll(rgb, checks, 1, 0.5).join(' ')
        : adjustForContrastAll(rgb, checks, -1).join(' ');
}

/** Convert a hex colour to an rgba() string at the given alpha (0..1). */
/**
 * Read a colour the way a person writes one.
 *
 * The accent picker's swatches are a shortlist, not the whole space — someone
 * matching a brand, a course's own colour or a screenshot has a value in hand,
 * and it arrives in whichever notation the tool they copied it from uses. So
 * `#0e7490`, `0e7490`, `#e74`, `rgb(14 116 144)`, `rgb(14,116,144)`,
 * `hsl(192 82% 31%)` and `hsl(192,82%,31%)` are all the same request.
 *
 * Returns a normalised `#rrggbb`, or null when it is not a colour — null is the
 * whole contract, because the field it feeds must keep whatever the person is
 * still typing rather than snapping to a guess halfway through it.
 *
 * Deliberately NOT a full CSS colour parser: no named colours (the swatches
 * cover the ones anybody types), no alpha (the accent is composited by the app
 * at a dozen different opacities, so an alpha here would be applied twice).
 */
export function parseCssColor(input: string | null | undefined): string | null {
    if (!input) return null;
    const text = String(input).trim().toLowerCase();
    if (!text) return null;

    const toHex = ([r, g, b]: [number, number, number]) =>
        `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;

    // #rgb / #rrggbb, with the # optional — a hex pasted out of a design tool
    // usually keeps it and one typed by hand usually does not.
    const hex = hexToRgb(text.startsWith('#') ? text : `#${text}`);
    if (hex && /^#?[0-9a-f]{3}$|^#?[0-9a-f]{6}$/.test(text)) return toHex(hex);

    const nums = (body: string) => body.split(/[\s,/]+/).filter(Boolean);

    const rgbMatch = text.match(/^rgba?\(([^)]*)\)$/);
    if (rgbMatch) {
        const parts = nums(rgbMatch[1]).slice(0, 3).map((v) => (v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v)));
        if (parts.length === 3 && parts.every(Number.isFinite)) return toHex(parts as [number, number, number]);
        return null;
    }

    const hslMatch = text.match(/^hsla?\(([^)]*)\)$/);
    if (hslMatch) {
        const parts = nums(hslMatch[1]).slice(0, 3);
        if (parts.length !== 3) return null;
        const h = parseFloat(parts[0]);
        const sat = parseFloat(parts[1]) / 100;
        const light = parseFloat(parts[2]) / 100;
        if (![h, sat, light].every(Number.isFinite)) return null;
        // hslToRgb takes hue as a 0..1 TURN, not degrees — CSS writes degrees.
        return toHex(hslToRgb((((h % 360) + 360) % 360) / 360, Math.max(0, Math.min(1, sat)), Math.max(0, Math.min(1, light))));
    }

    return null;
}

export function hexToRgba(hex: string, alpha: number): string {
    const rgb = hexToRgb(hex);
    if (!rgb) return `rgba(0, 0, 0, ${alpha})`;
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}
