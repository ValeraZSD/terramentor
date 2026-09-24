/**
 * THE SURFACE RAMP, READ BACK OFF THE DOCUMENT.
 *
 * Most of this app paints with Tailwind classes, so a tint reaches it for free:
 * `bg-slate-800` resolves through `--c-slate-800` and changes when the variable
 * does. The two atlas CANVASES cannot — a canvas is painted with strings, so
 * their palettes were written out theme by theme:
 *
 *     const surface = theme === 'warm' ? '#f4eee4'
 *         : theme === 'black' ? '#000000'
 *             : dark ? '#0f172a' : '#f8fafc';
 *
 * Four hexes, one per shipped theme — which is exactly the shape that cannot
 * survive a theme being a COLOUR rather than a name. So the canvases now ask
 * the document what the ramp currently is, and the branch disappears: every one
 * of those four values was a rung of its own theme's ramp, and saying which
 * rung says all four at once.
 *
 * Read once per theme change and memoised by the caller, never per frame:
 * `getComputedStyle` forces style resolution, and doing that inside a draw call
 * turns a pan into thrash.
 */

import { hexToRgb, rgbToHsl, hslToRgb } from './color';

/** The untinted ramp, for a caller with no document (the jsdom harness renders
 *  no stylesheet, and a null palette there would fail as a layout bug). The
 *  same greys `NEUTRAL` in `themeRamp.ts` holds and `index.css` declares —
 *  three copies of one ladder, each for a reader that cannot reach the others,
 *  and `theme-ramp-gates.mjs` pins them together. */
const FALLBACK: Record<string, string> = {
    '--c-white': '255 255 255', '--c-slate-50': '250 250 250', '--c-slate-100': '244 244 244',
    '--c-slate-200': '231 231 231', '--c-slate-300': '212 212 212', '--c-slate-400': '162 162 162',
    '--c-slate-500': '115 115 115', '--c-slate-600': '84 84 84', '--c-slate-700': '64 64 64',
    '--c-slate-800': '41 41 41', '--c-slate-900': '23 23 23',
};

const triplet = (name: string): [number, number, number] => {
    let raw = '';
    if (typeof getComputedStyle === 'function' && typeof document !== 'undefined') {
        raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }
    const parts = (raw || FALLBACK[name] || FALLBACK['--c-slate-500']).split(/[\s,]+/).map(Number);
    return parts.length === 3 && parts.every(Number.isFinite)
        ? [parts[0], parts[1], parts[2]]
        : [100, 116, 139];
};

const hex = (rgb: [number, number, number]) =>
    `#${rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;

/** One rung as `#rrggbb`. `rung('900')`, `rung('white')`. */
export const rung = (name: string) =>
    hex(triplet(name === 'white' ? '--c-white' : `--c-slate-${name}`));

/** One rung as `rgba(…)` — the ink a canvas draws hairlines and grids in. */
export const rungAlpha = (name: string, alpha: number) => {
    const [r, g, b] = triplet(name === 'white' ? '--c-white' : `--c-slate-${name}`);
    return `rgba(${r},${g},${b},${alpha})`;
};

/** Halfway between two rungs, for the tones that sit between them. */
export const rungMix = (a: string, b: string, t = 0.5) => {
    const x = triplet(a === 'white' ? '--c-white' : `--c-slate-${a}`);
    const y = triplet(b === 'white' ? '--c-white' : `--c-slate-${b}`);
    return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as [number, number, number]);
};

/** A rung taken down by a fraction of its own lightness — the globe's shaded
 *  limb, which has to be the same colour as the lit side and simply less of it. */
export const darken = (color: string, by: number) => {
    const rgb = hexToRgb(color);
    if (!rgb) return color;
    const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    return hex(hslToRgb(h, s, Math.max(0, l * (1 - by))));
};

/** Below this lightness the page has no room left to shade DOWNWARD, so the
 *  planet's body has to be lifted off it instead of sunk into it. It is what
 *  the old `black` theme hardcoded (`lit: '#181818'` on a `#000000` page) and
 *  the only branch in here that is about the picture rather than the ramp. */
const NO_ROOM_BELOW = 0.06;

/**
 * Everything the two atlas canvases paint that is not the accent or the
 * mastery ramp. One place, because the flat map and the globe must agree: they
 * are two projections of one library and a reader switches between them.
 */
export function atlasSurfaces(dark: boolean) {
    const surface = dark ? rung('900') : rung('50');
    const surfaceL = rgbToHsl(...(hexToRgb(surface) as [number, number, number]))[2];
    // The planet's body: the side facing the light and the side falling away
    // from it. On a light theme the lit side sits between the page and the card
    // so the palest rung of the mastery ramp still reads on it; on a dark one it
    // IS the page and the sphere is read from its darkening limb — unless the
    // page is so dark there is nothing below it, and then the body lifts.
    const lit = dark
        ? (surfaceL >= NO_ROOM_BELOW ? surface : rungMix('900', '700', 0.5))
        : rungMix('50', '100', 0.5);
    return {
        /** The canvas behind everything. */
        surface,
        /** The halo a label or a line is stroked with, so it survives on top of
         *  a dot: the colour of whatever is behind it. */
        ring: dark ? rung('900') : rung('white'),
        /** Text. */
        ink: dark ? rung('200') : rung('900'),
        /** The faint graticule and the bubble hairlines. */
        grid: dark ? rungAlpha('400', 0.13) : rungAlpha('500', 0.14),
        /** The globe's own, a shade stronger — it is drawn on the body rather
         *  than on the page. */
        globeGrid: dark ? rungAlpha('400', 0.18) : rungAlpha('500', 0.20),
        rim: dark ? rungAlpha('400', 0.30) : rungAlpha('500', 0.28),
        lit,
        shade: darken(lit, dark ? 0.4 : 0.18),
    };
}
