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
 *
 * Settled 4 Nov 2026 with three outside reviewers (an exam student on a
 * phone, a first-time user, an assessment designer) over the same question in
 * all three layouts: one row on a laptop and two by two on a phone for short
 * answers, two to a row for formulas that fit.
 */

/** `gap-2` between tiles. */
export const CHOICE_GAP_PX = 8;
/** What a tile spends on itself: `px-4` both sides plus `border-2` both sides. */
export const CHOICE_TILE_CHROME_PX = 36;
/** One row only while the widest option fills at most this much of its tile:
 *  a formula touching its border reads as cramped, and the parts that tell two
 *  options apart (an exponent, a sign) are the smallest glyphs on screen. */
export const ONE_ROW_FILL = 0.7;
/** One row only while each tile is at least this wide. A tap answers at once,
 *  with no confirm, so four ~80px tiles on a phone are a mis-tap waiting to
 *  happen; two rows of two are as quick and twice as wide. */
export const ONE_ROW_MIN_REM = 9;

export function choiceColumns(count: number, widestPx: number, groupPx: number, rootPx: number): number {
    const tile = (cols: number) => (groupPx - (cols - 1) * CHOICE_GAP_PX) / cols;
    const inner = (cols: number) => tile(cols) - CHOICE_TILE_CHROME_PX;
    if (count >= 2 && count <= 4
        && tile(count) >= ONE_ROW_MIN_REM * rootPx
        && widestPx <= ONE_ROW_FILL * inner(count)) return count;
    if (count >= 2 && count % 2 === 0 && widestPx <= inner(2)) return 2;
    return 1;
}
