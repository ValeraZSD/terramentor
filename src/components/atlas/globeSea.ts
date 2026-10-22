import { hexToRgb, hslToRgb, relLum, rgbToHsl } from '../../utils/color';

/**
 * Terra's sea and the lines drawn across its land — the two colours on the
 * planet that are not data, and the two that went wrong on a fresh library.
 *
 * Pure, so `globe-gates.mjs` can hold them to the arithmetic the picture needs.
 */

type Rgb = [number, number, number];

/** `#rrggbb` or `rgb(r, g, b)` — the two shapes the atlas's colours come in. */
export function parseColour(css: string): Rgb | null {
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(css.trim());
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return hexToRgb(css);
}

const toHex = (rgb: Rgb) => `#${rgb.map(n => n.toString(16).padStart(2, '0')).join('')}`;

/**
 * How far the sea must stand from the PALEST land — the colour of a region with
 * nothing proven, which on a new library is every region there is. 1.25:1 is a
 * step a reader sees across the whole ball without the sea turning into a
 * second subject.
 */
export const SEA_LAND_CONTRAST = 1.25;

/**
 * Where the sea sits: at the PAGE's end of the land's ladder, past its palest
 * rung. Land moves away from the page as it is proven (darker on a light page,
 * brighter on a dark one), so a sea beyond the palest rung is beyond every rung
 * and no amount of proof brings a country back to the colour of the water.
 *
 * A sea placed INSIDE the ladder — the tint at its own lightness, parted from
 * the palest land only where the two meet — comes out a mid, saturated tone
 * on a saturated page, louder than the land on it, and a started region can
 * land on the water's exact tone. A fixed place past the ladder's end makes
 * the parting true by construction, for any tint and any accent.
 *
 * Light: luminance 0.9, a pale wash a little off the page. Dark: 0.04, a deep
 * tone that keeps the planet a visible disc on the near-black canvas behind
 * it, even where its countries are sparse. Both clear `SEA_LAND_CONTRAST`
 * against the palest rung (`GLOBE_PALEST`), with room to spare.
 */
export const SEA_LUMINANCE = { light: 0.9, dark: 0.04 };

/**
 * The most of the tint's saturation the sea may carry. The sea is the ground
 * the countries stand on and must be the quietest thing on the planet; a
 * bubblegum or emerald sea outshone every course on it. The cap keeps the hue
 * the learner chose and turns its volume down.
 */
export const SEA_MAX_SATURATION = { light: 0.5, dark: 0.4 };

/**
 * Terra's sea: the TINT's hue (the colour the learner chose for their page,
 * never one named here), its saturation capped, at the sea's place on the
 * ladder. `untinted` is the theme's own slate, which the caller reads off the
 * page, and goes the same way. It takes no colour mode and no accent, so
 * switching App ↔ Course colour repaints the land and leaves the sea alone.
 */
export function terraSea(opts: { dark: boolean; tint: string | null | undefined; untinted: string }): string {
    const { dark, tint, untinted } = opts;
    const base = (tint ? hexToRgb(tint) : null) ?? parseColour(untinted) ?? [241, 245, 249];
    const [h, s0] = rgbToHsl(base[0], base[1], base[2]);
    const s = Math.min(s0, dark ? SEA_MAX_SATURATION.dark : SEA_MAX_SATURATION.light);
    const target = dark ? SEA_LUMINANCE.dark : SEA_LUMINANCE.light;
    // Luminance is monotone in HSL lightness for every hue, so bisect it.
    let lo = 0, hi = 1;
    for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (relLum(hslToRgb(h, s, mid)) < target) lo = mid; else hi = mid;
    }
    return toHex(hslToRgb(h, s, (lo + hi) / 2));
}

/** The most saturation bare ground keeps from the sea's hue: a whisper of it, so
 *  set-aside land reads as quiet rather than as a colour of its own. */
export const GROUND_MAX_SATURATION = 0.15;

/**
 * Bare ground: what a territory is painted before its colour, and so what a
 * region fades TOWARD when a search or a traced course sets it aside, or the
 * reader zooms in (the colour is laid over it at less than full strength).
 *
 * It sits at the palest rung's luminance (`palestLum`, `GLOBE_PALEST`), on the
 * LAND's side of the sea, in the sea's hue turned nearly grey. Because both the
 * land and the ground are on the land's side, every blend of the two is too,
 * and a faded country never reaches the water's tone. White ground on a light
 * page (or the page's own dark on a dark one) is past the sea instead: a
 * country faded to a quarter of its colour came out within 1.01:1 of the pale
 * sea and read as water.
 */
export function terraGround(sea: string, palestLum: number): string {
    const base = parseColour(sea) ?? [241, 245, 249];
    const [h, s0] = rgbToHsl(base[0], base[1], base[2]);
    const s = Math.min(s0, GROUND_MAX_SATURATION);
    let lo = 0, hi = 1;
    for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (relLum(hslToRgb(h, s, mid)) < palestLum) lo = mid; else hi = mid;
    }
    return toHex(hslToRgb(h, s, (lo + hi) / 2));
}

/**
 * The lines across the land: a BORDER between two territories and the COAST
 * where land meets sea.
 *
 * A border in the body's own lit tone (a pale parting between two coloured
 * countries, the way a political map does it) holds only while the countries
 * are coloured. On a library with nothing proven every territory is the
 * palest rung, which is nearly that same pale tone, and such borders vanish:
 * one white continent with names floating on it. So on a light page a border
 * is the INK, faint, which parts any rung from its neighbour; the coast is the
 * same ink, stronger, so a border never reads as a shore. On a dark page the
 * land is darker than the lines would be in ink and the page's own tone
 * already parts it, so there the lit tone stays.
 */
export function landLines(dark: boolean, ink: string, lit: string) {
    const rgba = (css: string, a: number) => {
        const c = parseColour(css) ?? [0, 0, 0];
        return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    };
    return {
        border: dark ? rgba(lit, 0.9) : rgba(ink, 0.24),
        coast: rgba(ink, dark ? 0.45 : 0.4),
    };
}
