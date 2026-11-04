/**
 * How many answer tiles go to a row: pure arithmetic over measured pixels,
 * so a gate can pin it without a browser.
 *
 * One layout per question, chosen by its WIDEST option as it paints on one
 * line, never per tile:
 *
 * - All in one row (2–4 options) while every tile is ≥ 9rem and the widest
 *   option fills ≤ 70% of a tile: 120 / −120 / 24 / −24 on a laptop.
 * - Two to a row (an even count) while the widest option fits a half-width
 *   tile on one line: the same four numbers on a phone, most formulas.
 * - Otherwise one per row: prose, wide formulas, an odd count that will not
 *   fit one row (a last row holding one tile reads as a layout gone wrong).
 */

/** One row only while the widest option fills at most this much of its tile:
 *  a formula touching its border reads as cramped, and the parts that tell two
 *  options apart (an exponent, a sign) are the smallest glyphs on screen. */
export const ONE_ROW_FILL = 0.7;
/** One row only while each tile is at least this wide. A tap answers at once,
 *  with no confirm, so four ~80px tiles on a phone are a mis-tap waiting to
 *  happen; two rows of two are as quick and twice as wide. */
export const ONE_ROW_MIN_REM = 9;

/** `gap-2` between tiles: rem, so it grows with the text size. */
export const choiceGapPx = (rootPx: number) => 0.5 * rootPx;
/** What a tile spends besides its text: `px-4` both sides (rem), `border-2`
 *  both sides (px), and room for the verdict mark (`w-4` + `gap-2`, rem), so a
 *  tile that gains a tick when graded does not wrap and jump. */
export const choiceTileChromePx = (rootPx: number) => 2 * rootPx + 4 + 1.5 * rootPx;

export function choiceColumns(count: number, widestPx: number, groupPx: number, rootPx: number): number {
    const gap = choiceGapPx(rootPx);
    const tile = (cols: number) => (groupPx - (cols - 1) * gap) / cols;
    const inner = (cols: number) => tile(cols) - choiceTileChromePx(rootPx);
    if (count >= 2 && count <= 4
        && tile(count) >= ONE_ROW_MIN_REM * rootPx
        && widestPx <= ONE_ROW_FILL * inner(count)) return count;
    if (count >= 2 && count % 2 === 0 && widestPx <= inner(2)) return 2;
    return 1;
}
