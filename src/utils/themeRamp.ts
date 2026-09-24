/**
 * THE APP'S SURFACES, GENERATED FROM TWO ANSWERS.
 *
 * A theme is a MODE and a COLOUR — the two questions a person choosing one
 * actually has — and this module is the arithmetic between that pair and the
 * twelve CSS variables every surface in the app is painted from (`--c-white`,
 * `--c-slate-50` … `--c-slate-900`; see the surface-ladder note in
 * `index.css`).
 *
 * A named theme is a block of hand-written `--c-slate-*` overrides: a fine way
 * to ship four appearances and a poor way to ship a choice, because it answers
 * both questions for the reader in a handful of combinations.
 *
 *   mode   light | dark — the `.dark` class, i.e. which END of the ramp is the
 *          page and which is the ink. One ramp serves both, exactly as before.
 *   tint   a colour. Its HUE is the app's hue, its SATURATION is how much of it
 *          you get, and its LIGHTNESS is how deep the page goes.
 *
 * THE RAMP IS NOT INVENTED. `BASE` below is Tailwind's `slate` verbatim — the
 * ladder every screen in this app was designed and contrast-audited against —
 * and a tint is a DEVIATION from it, never a replacement. `NEUTRAL` is that same
 * ladder with the hue taken out at matched LUMINANCE, so an untinted app is grey
 * rather than blue-grey and every contrast ratio stays where it has always been.
 * Which of the two a ramp starts from is the only thing `strength` decides at
 * the top; `theme-ramp-gates.mjs` re-solves both claims rather than trusting
 * either table.
 *
 * WHY THE TINT'S LIGHTNESS IS THE DEPTH, and not a third slider: it is the one
 * reading of "pick a dark colour" that produces what the reader expects at both
 * ends of the range. Pick black in dark mode and the page IS black — the old
 * OLED theme, reached by choosing black rather than by knowing it had a name.
 * Pick a cream in light mode and the page is cream — the old Warm theme, by the
 * same gesture. The achromatic pair is not an exception to any of this: `Paper`
 * asks for the lightest page its mode allows and `Ink` for the deepest, in BOTH
 * modes, by the same arithmetic the hues go through with the hue simply absent.
 * The pull is CLAMPED (`MAX_DEPTH`), so a light theme stays light however dark
 * the tint is: the answer to "what colour" may not quietly overturn the answer
 * to "light or dark".
 *
 * The two shipped flavours are the calibration, not an illustration: the shape
 * tables below were measured off `warm` and `black` as they shipped, so feeding
 * this the cream reproduces Warm and feeding it black reproduces Black. That is
 * the only check that can tell a generator that works from one that merely runs,
 * and it is the second thing the gate asserts.
 */

// The `.ts` extension is deliberate (`allowImportingTsExtensions` is on): this
// module is imported by `theme-ramp-gates.mjs` through plain Node, which
// resolves nothing an extension does not name. The alternative is a second copy
// of the HSL arithmetic in the gate, free to drift from the one that ships.
import { hslToRgb, rgbToHsl, hexToRgb } from './color.ts';

export type ThemeMode = 'light' | 'dark';

/** The twelve variables, in ramp order. `white` is a rung like any other here —
 *  in dark mode it is the brightest ink, in light mode it is the card. */
export const RUNGS = ['white', '50', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;
export type Rung = typeof RUNGS[number];

/**
 * THE REFERENCE LADDER: Tailwind `slate`, verbatim, plus white.
 *
 * Not what an untinted app is drawn in — see `NEUTRAL` — but what everything in
 * this repo was designed and contrast-audited against, and therefore the shape
 * both paths below are derived from. A tinted ramp takes its LIGHTNESS from
 * here; an untinted one takes its LUMINANCE.
 */
const BASE: Record<Rung, string> = {
    white: '#ffffff', 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1',
    400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a',
};

/**
 * NO TINT MEANS NO HUE.
 *
 * `slate` is a BLUE-grey — hue 213–222, and 47% saturated at its dark end — so
 * an app drawn in it reads blue however white the swatch above it is. The
 * sixteenth chip says "no colour"; this is what no colour looks like.
 *
 * **Matched on LUMINANCE, not on HSL lightness**, which is the whole reason
 * these are literals rather than `saturation = 0` applied to `BASE`. Contrast is
 * luminance, and dropping saturation at a fixed lightness moves it: the same
 * ladder desaturated in place costs 0.7 of a ratio on body text and drops muted
 * text from 4.76:1 to 4.42:1, a hair over the AA floor. Solved per rung instead,
 * every pair the app reads text on lands within 0.13 of where it has always been
 * — 13.35→13.23 for body on the page, 4.76→4.74 for muted on a card, measured
 * in `theme-ramp-gates.mjs`, which re-solves them rather than trusting this
 * table.
 *
 * They come out within a rounding of Tailwind's own `neutral` scale, which is
 * reassuring and is not where they came from.
 */
const NEUTRAL: Record<Rung, string> = {
    white: '#ffffff', 50: '#fafafa', 100: '#f4f4f4', 200: '#e7e7e7', 300: '#d4d4d4',
    400: '#a2a2a2', 500: '#737373', 600: '#545454', 700: '#404040', 800: '#292929', 900: '#171717',
};

/** The CSS variable each rung is written to. */
export const varName = (rung: Rung) => (rung === 'white' ? '--c-white' : `--c-slate-${rung}`);

/**
 * HOW MUCH HUE EACH RUNG TAKES, as a fraction of the tint's own saturation.
 *
 * Measured off the shipped `warm` theme, which is the only hand-made tinted
 * ramp this project has: its white is 52.4% saturated and its rungs run
 * 52.4 · 42.1 · 38.2 · 34.8 · 27.0 · 16.0 · 17.1 · 19.5 · 20.4 · 23.1 · 24.5,
 * i.e. a U with its floor at 400 and its peak on the surface end. Divided
 * through by the peak, that is this table — so a cream tint reproduces Warm.
 *
 * The dark table is its mirror, because in dark mode the surface end is 900 and
 * the light rungs are TEXT: text takes a cast, a page takes a colour.
 */
const SATURATION_SHAPE: Record<ThemeMode, number[]> = {
    light: [1.00, 0.80, 0.73, 0.66, 0.52, 0.31, 0.33, 0.37, 0.39, 0.44, 0.47],
    dark: [0.30, 0.32, 0.34, 0.36, 0.38, 0.31, 0.40, 0.55, 0.70, 0.85, 1.00],
};

/**
 * HOW FAR EACH RUNG MOVES when the tint is a deep one, as a fraction of the
 * depth in lightness points.
 *
 * Light: measured off `warm` against stock — 4.1 · 5.5 · 6.9 · 8.9 · 10.8 ·
 * 10.4 · 6.7 · 4.3 · 4.5 · 2.2 · 0.8 points, normalised on the deepest. The
 * light end COMPRESSES toward the middle rather than sliding down as a block,
 * and the ink end barely moves at all — which is the difference between a cream
 * PAGE and a sepia photograph.
 *
 * Dark: measured off `black` — 0 · 14.3 · 13.0 · 11.8 · 11.2 at 500…900, i.e.
 * near-constant below 600 and nothing above it. The step at 500/600 is the
 * shipped theme's own; softening it here would be inventing a ramp rather than
 * generalising one.
 */
const DEPTH_SHAPE: Record<ThemeMode, number[]> = {
    light: [0.38, 0.51, 0.64, 0.82, 1.00, 0.96, 0.62, 0.40, 0.42, 0.20, 0.07],
    dark: [0, 0, 0, 0, 0, 0, 0.15, 1.00, 0.91, 0.83, 0.78],
};

/**
 * The ceiling on the depth, in lightness points, and the reason a light theme
 * cannot be talked into being a dark one. `warm` needs 10.8 and `black` 14.3,
 * so both are inside the range and only a tint deeper than either is clamped.
 */
const MAX_DEPTH = { light: 14, dark: 14.3 } as const;

/** Where the depth starts counting from: a tint at least this light asks for no
 *  depth at all in light mode, and black asks for all of it in dark mode. */
const DEPTH_FROM = { light: 0.98, dark: 0.143 } as const;

/** Past this the tint is a colour rather than a shade, and the surfaces stop
 *  taking more of it — a fully saturated page is a highlighter, not a theme.
 *  0.55 is a shade above `warm`'s 0.524, so the cream is inside the range. */
const MAX_SATURATION = 0.55;

/** Under this a tint has no hue worth applying (white, black, any grey), so the
 *  ramp stays the base one and only the depth moves. */
const MIN_SATURATION = 0.02;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const toHex = (rgb: [number, number, number]) =>
    `#${rgb.map((n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('')}`;

/** A tint read as the three things the ramp actually uses. */
export function readTint(tint: string | null | undefined, mode: ThemeMode) {
    const rgb = tint ? hexToRgb(tint) : null;
    if (!rgb) return { hue: 0, strength: 0, depth: 0 };
    const [hue, saturation, lightness] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const strength = saturation < MIN_SATURATION ? 0 : Math.min(saturation, MAX_SATURATION);
    const depth = mode === 'light'
        ? clamp((DEPTH_FROM.light - lightness) * 100, 0, MAX_DEPTH.light)
        : clamp((DEPTH_FROM.dark - lightness) * 100, 0, MAX_DEPTH.dark);
    return { hue, strength, depth };
}

/**
 * The twelve surface colours for one (mode, tint), as `#rrggbb`.
 *
 * Returns BASE untouched when the tint asks for neither hue nor depth, rather
 * than returning a value that merely rounds to it.
 */
export function themeRamp(mode: ThemeMode, tint: string | null | undefined): Record<Rung, string> {
    const { hue, strength, depth } = readTint(tint, mode);
    // A tint with no hue in it is still a tint: `Ink` and `Paper` are the two
    // ends of the DEPTH, exactly as the fourteen hues are the two ends of
    // nothing else. White asks for the lightest page its mode allows and black
    // for the deepest, in both modes — one mechanism, the hue simply absent.
    const ladder = strength === 0 ? NEUTRAL : BASE;
    // ONLY a tint that asks for NEITHER hue NOR depth leaves the ladder alone.
    // Testing the depth alone was a dark mode with no colour in it: `depth` is
    // measured DOWNWARD from `DEPTH_FROM`, and in dark mode that datum is a
    // lightness of 0.143, so every pastel in the shortlist — all fourteen are
    // HSL 87% — clamps to zero and returned here before the hue was ever
    // applied. Fourteen different swatches all painted stock Tailwind slate,
    // which is the one appearance the untinted app was deliberately moved away
    // from. A pastel having nothing to say about how DEEP a dark page goes is
    // correct; it still has everything to say about its HUE.
    if (depth === 0 && strength === 0) return { ...ladder };
    const satShape = SATURATION_SHAPE[mode];
    const depthShape = DEPTH_SHAPE[mode];
    const out = {} as Record<Rung, string>;
    RUNGS.forEach((rung, i) => {
        const [baseH, baseS, baseL] = rgbToHsl(...(hexToRgb(ladder[rung]) as [number, number, number]));
        const s = strength === 0 ? baseS : strength * satShape[i];
        const h = strength === 0 ? baseH : hue;
        const l = clamp(baseL - (depth * depthShape[i]) / 100, 0, 1);
        out[rung] = toHex(hslToRgb(h, s, l));
    });
    return out;
}

/**
 * The colour a tint's CHIP is painted in the palette, for the mode it is being
 * chosen in. Paint only: the value chosen is always the stored tint.
 *
 * The sixteen tints are stored as pastels, which is the LIGHT register — so in
 * light mode a hued chip is the value itself. In dark mode it is that tint's
 * `700`, the rung the app paints panels and borders at (the PAGE rung puts the
 * sixteen dark pages 5 RGB units apart; measured, and the reason the chip is
 * not the page). The two hue-less tints, Ink and Paper, have no pastel: their
 * stored value IS the depth end, so painted raw the light palette offered a
 * true black among fourteen pastels for a page that comes out light grey. They
 * take the light panel rung (`100`) the same way every dark chip takes the dark
 * one — Paper stays white to the eye, Ink becomes the grey it makes.
 */
export function tintSwatch(mode: ThemeMode, tint: string): string {
    if (mode === 'dark') return themeRamp('dark', tint)['700'];
    return readTint(tint, 'light').strength === 0 ? themeRamp('light', tint)['100'] : tint;
}

/** The same thing as the CSS variables it is written to — one object the store
 *  can spread onto a style, cache in `localStorage` and hand to the boot script,
 *  so nothing has to reimplement the arithmetic before the first paint. */
export function themeVars(mode: ThemeMode, tint: string | null | undefined): Record<string, string> {
    const ramp = themeRamp(mode, tint);
    const vars: Record<string, string> = {};
    for (const rung of RUNGS) {
        const [r, g, b] = hexToRgb(ramp[rung]) as [number, number, number];
        vars[varName(rung)] = `${r} ${g} ${b}`;
    }
    return vars;
}

/**
 * The colour the phone paints its status bar and URL bar with.
 *
 * The SURFACE directly under it, not the canvas and not the accent: the header
 * band is what the strip sits against. In light mode that is the card colour, in
 * dark mode the panel colour — which is `--c-slate-800`, the same rung that
 * paints every card there.
 */
export const themeColorFor = (mode: ThemeMode, tint: string | null | undefined) =>
    themeRamp(mode, tint)[mode === 'dark' ? '800' : 'white'];
