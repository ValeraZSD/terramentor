/**
 * How the lines across the land change as a country opens into its cities.
 *
 * Zoomed out, a country is one colour with a grey border, and the sea round it
 * carries faint waterlines rippling out from the shore. Zoomed in, the same
 * country is a set of cities with borders of their own, and two things that
 * read well from far away go wrong up close: the waterlines cross every narrow
 * strait as grey scribbles between two coasts, and a grey country border looks
 * like one more city border. So as the cities come in (`cityA`, 0 → 1) the
 * waterlines fade out, and the country border turns the surface colour and
 * grows wider than any city border — the outline of the whole, round the
 * outlines of its parts.
 */

/** A city border's width, px. The country border ends wider than this. */
export const CITY_BORDER_WIDTH = 1.1;
/** How strongly a city border is drawn once the cities are in. */
export const CITY_BORDER_ALPHA = 0.9;

export interface CityLines {
    /** The waterlines' strength, 1 → 0. */
    ripple: number;
    /** How much of the country border is the surface colour rather than the
     *  border grey: stroke both, the grey at `1 - surface`. */
    surface: number;
    /** The country border's width, px. */
    borderWidth: number;
    /** The city borders' width and strength. */
    cityBorderWidth: number;
    cityBorderAlpha: number;
}

export function cityLines(cityA: number): CityLines {
    const a = Math.max(0, Math.min(1, cityA));
    return {
        ripple: 1 - a,
        surface: a,
        borderWidth: 1 + 1.4 * a,
        cityBorderWidth: CITY_BORDER_WIDTH,
        cityBorderAlpha: CITY_BORDER_ALPHA * a,
    };
}
