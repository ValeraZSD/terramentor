/**
 * THE TWO ACCENT VARIABLES, DERIVED IN ONE PLACE.
 *
 * `--accent-rgb` is the solid accent — buttons, rails, rings, anything that
 * carries white label text — and `--accent-fg-rgb` is the accent as TEXT, on
 * the page the reader is actually on. Seven surfaces set this pair by hand
 * (the app root, the workspace, a project card, a feed card, a chapter rail, a
 * task chip, the completion poster), and each wrote the same two lines from
 * the same two helpers.
 *
 * They are one function now because the second of the two stopped being a
 * function of the accent and the mode. A theme is a mode and a TINT
 * (`themeRamp.ts`), so what accent text has to clear is a page that can be
 * cream, slate or true black — and every one of those seven call sites was
 * measuring against stock white or stock slate-800. The surface has to be
 * resolved from the theme, and seven copies of that resolution is seven places
 * for it to be forgotten.
 *
 * Pure, and takes the theme rather than reading the store, so a renderer or a
 * gate can ask the same question without a React tree. `useAccentVars` in
 * `src/hooks/` is the component's way in.
 */
import type { CSSProperties } from 'react';
// `.ts` on both, like `themeRamp.ts` beside it: plain Node then resolves them,
// so `theme-ramp-gates.mjs` can drive its 512-combination matrix through THIS
// module instead of a copy of its arithmetic. The copy that grew there instead
// is what let a mutation of `accentTextSurface`'s body survive the whole suite.
import { accentSolidTriplet, accentFgTriplet } from './color.ts';
import { themeColorFor, type ThemeMode } from './themeRamp.ts';

/**
 * The surface accent TEXT sits on, for one theme: the card in light mode, the
 * panel in dark. Both are the LIGHTEST surface of their mode, which is the
 * worst case for the direction each mode drives the colour in — so a value
 * that clears the ratio here clears it on every other rung too.
 */
export const accentTextSurface = (mode: ThemeMode, tint: string | null | undefined) =>
    themeColorFor(mode, tint);

/** Both variables as an inline style. `color` null/absent falls back to the
 *  defaults in `index.css` by returning undefined, so a caller can spread the
 *  result unconditionally. */
export function accentVars(
    color: string | null | undefined,
    mode: ThemeMode,
    tint: string | null | undefined,
): CSSProperties | undefined {
    if (!color) return undefined;
    return {
        '--accent-rgb': accentSolidTriplet(color),
        '--accent-fg-rgb': accentFgTriplet(color, mode === 'dark', accentTextSurface(mode, tint)),
    } as CSSProperties;
}
