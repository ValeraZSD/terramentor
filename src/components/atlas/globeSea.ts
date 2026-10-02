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
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * How far the sea must stand from the PALEST land — the colour of a region with
 * nothing proven, which on a new library is every region there is.
 *
 * The sea is the learner's page tint and the land is the learner's accent, and
 * a learner who picks a green page will often pick a green accent too. On the
 * family PC (2026-10-01: Green tint, a green accent, App colour, nothing
 * proven) the sea came out at HSL lightness 0.87 and the land at 0.90 in the
 * same hue — 1.04:1, a planet of one colour where only the coastline said
 * which side was water. 1.25:1 is a step a reader sees across the whole ball
 * without the sea turning into a second subject.
 */
export const SEA_LAND_CONTRAST = 1.25;

/**
 * The sea's lit tone.
 *
 * The TINT's hue and saturation are kept whole — it is the colour the learner
 * chose for their page, never one named here — and only its lightness moves:
 * first into a band for the mode (one tint serves both, and a cream chosen for
 * a light page would be a glaring sea on a dark one), then, if the land's
 * palest rung sits in the same place, AWAY from it until the two part by
 * `SEA_LAND_CONTRAST`. It moves the way it already leans, and only crosses to
 * the other side when that way runs out of room (a pale sea beside a pale land
 * cannot get paler than white).
 *
 * `untinted` is the sea with no tint at all — the theme's own slate, which the
 * caller reads off the page — and goes through the same parting.
 */
export function seaTone(opts: {
    dark: boolean;
    tint: string | null | undefined;
    untinted: string;
    palestLand: string;
}): string {
    const { dark, tint, untinted, palestLand } = opts;
    const tintRgb = tint ? hexToRgb(tint) : null;
    const base = tintRgb ?? parseColour(untinted) ?? [241, 245, 249];
    const [h, s, l0] = rgbToHsl(base[0], base[1], base[2]);
    const l = tintRgb
        ? Math.min(dark ? 0.55 : 0.88, Math.max(dark ? 0.3 : 0.62, l0))
        : l0;
    const land = parseColour(palestLand);
    if (!land) return toHex(hslToRgb(h, s, l));
    const landLum = relLum(land);
    const at = (li: number) => relLum(hslToRgb(h, s, li));
    const parts = (li: number) => ratio(at(li), landLum) >= SEA_LAND_CONTRAST;
    if (parts(l)) return toHex(hslToRgb(h, s, l));

    // Walk lightness in small steps toward one end, stopping at the first value
    // that parts; null when the end is reached first.
    const walk = (dir: 1 | -1) => {
        const end = dir > 0 ? 0.97 : 0.18;
        for (let li = l; dir > 0 ? li <= end : li >= end; li += dir * 0.005) {
            if (parts(li)) return li;
        }
        return null;
    };
    const lean: 1 | -1 = at(l) >= landLum ? 1 : -1;
    const found = walk(lean) ?? walk(lean === 1 ? -1 : 1) ?? l;
    return toHex(hslToRgb(h, s, found));
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
