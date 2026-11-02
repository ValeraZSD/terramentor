/**
 * How the server opens and draws a PDF someone else made.
 *
 * Every PDF the server reads came from outside: an upload, a dropped file, a
 * shared course bundle. pdf.js is written for that, and these settings take
 * away the two parts of it the server has no use for and the one size it never
 * checks:
 *
 *   - `isEvalSupported: false`. pdf.js compiles some font programs into
 *     JavaScript functions for speed when it is allowed to evaluate code.
 *     The text layer and a page render come out the same without it; only the
 *     speed of drawing certain fonts changes, and the server draws a page only
 *     to recover its math.
 *   - `disableFontFace: true`. Already pdf.js's default under Node; written
 *     here so a future default cannot quietly hand embedded fonts to a font
 *     loader the server never needed.
 *   - a render size bound (`boundedScale`). A page states its own size, and at
 *     the recovery's 3x scale a page declared a few metres wide asks the canvas
 *     for gigabytes. The scale is lowered until the bitmap fits.
 *
 * Every `getDocument(…)` and `new PDFParse(…)` in the server spreads
 * PDF_LOAD_OPTIONS; tools/outbound-hygiene-gates.mjs reads the sources to hold
 * them to it.
 */
export const PDF_LOAD_OPTIONS = Object.freeze({ isEvalSupported: false, disableFontFace: true });

/** The largest bitmap one page is drawn into: 40 megapixels (an A4 page at
 *  the recovery's 3x is about 4.5), and no side longer than 8192 pixels. */
export const RENDER_MAX_PIXELS = 40_000_000;
export const RENDER_MAX_SIDE = 8192;

/**
 * The scale to draw a page at: `scale`, lowered as far as needed for the page
 * (`width` x `height` at scale 1, in PDF points) to fit both bounds. A page
 * that states no usable size gets scale 1 and is left to pdf.js.
 */
export function boundedScale(width, height, scale) {
    if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return 1;
    const byArea = Math.sqrt(RENDER_MAX_PIXELS / (width * height));
    const bySide = RENDER_MAX_SIDE / Math.max(width, height);
    return Math.min(scale, byArea, bySide);
}
