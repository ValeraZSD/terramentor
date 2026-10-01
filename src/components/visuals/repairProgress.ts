/**
 * The percentage under "Rebuilding animation…", and the character counter beside it.
 *
 * Rebuilding a brief-backed drawing is TWO model calls — the words, then the
 * drawing — and scaling the bar against the BRIEF's length for both breaks on
 * the second: a drawing is several times longer than the brief that asks for
 * it, so the slower call crosses the whole remaining range in its first few
 * hundred characters and then sits on the 99% clamp for the rest of its run.
 * Worse, a reasoning model spends its opening stretch THINKING, which produces
 * no answer characters at all — so the bar freezes at 99 while the only thing
 * that can move it has not started writing yet.
 *
 * Three rules fix that, and each is a separate failure:
 *   - Each PHASE owns a band. The words get a small one, the drawing the rest,
 *     so the long call is not squeezed into the last few percent.
 *   - Inside a band the fraction is soft-kneed against an estimate the SERVER
 *     supplies (the previous drawing's length is a real yardstick for the next
 *     one). Under the estimate it is linear and quick; past it, it approaches
 *     the top of the band without arriving — an estimate that turns out short
 *     makes the bar slow down instead of stop.
 *   - Reasoning gets the first slice of its band, because "it is still working"
 *     is exactly what the reader cannot otherwise tell. The character counter
 *     says which of the two is being counted, so a bar that is crawling is
 *     visibly crawling rather than possibly dead.
 */

import { num } from '../../utils/numberFormat';

export interface RepairProgress {
    /** Which model call is running: one pass, or the words then the drawing. */
    phase?: 'spec' | 'brief' | 'draw';
    /** Characters of ANSWER written so far in this phase. */
    chars?: number;
    /** Characters of REASONING produced so far in this phase. */
    thinking?: number;
    /** The server's expectation of this phase's answer length. */
    est?: number;
}

/** Percentage band each phase owns. A brief is short; the drawing is the wait. */
const BANDS: Record<string, [number, number]> = {
    spec: [0, 100],
    brief: [0, 22],
    draw: [22, 100],
};

/** Fallback yardstick when the server could not name one (no cached drawing). */
const FALLBACK_EST: Record<string, number> = { spec: 2000, brief: 900, draw: 4500 };

/** Share of a band reserved for the reasoning stretch that precedes the answer. */
const THINK_SHARE = 0.18;
/** Reasoning characters that fill half of that slice — a scale, not a limit. */
const THINK_HALF = 1500;
/** Share of the writing span spent at exactly the estimate; the rest is the tail. */
const KNEE = 0.82;

/**
 * 0 → `100`, monotone, never reaching the top of the band. Rounded, and capped
 * at 99: the last percent belongs to the render that follows, not to the model.
 */
export function repairPercent(p: RepairProgress): number {
    const phase = p.phase && BANDS[p.phase] ? p.phase : 'spec';
    const [lo, hi] = BANDS[phase];
    const span = hi - lo;
    const chars = Math.max(0, p.chars || 0);
    const thinking = Math.max(0, p.thinking || 0);
    const est = Math.max(1, p.est && p.est > 0 ? p.est : FALLBACK_EST[phase]);

    const thinkSpan = span * THINK_SHARE;
    const writeSpan = span - thinkSpan;
    // The slice is CLAIMED IN FULL the moment an answer character exists: a
    // model that emitted no reasoning at all must still be able to fill its band.
    const thinkPart = chars > 0 ? thinkSpan : thinkSpan * (1 - 1 / (1 + thinking / THINK_HALF));

    const r = chars / est;
    const writePart = writeSpan * (r < 1 ? KNEE * r : 1 - (1 - KNEE) / (1 + (r - 1) * 3));

    return Math.max(0, Math.min(99, Math.round(lo + thinkPart + writePart)));
}

/**
 * "2,140 chars" / "thinking 1,234 chars" — the anti-stall half. The percentage
 * can legitimately hold still for a few seconds near the knee; a number that
 * keeps climbing is what says the connection is alive.
 */
export function progressCounter(p: RepairProgress): string {
    const chars = Math.max(0, p.chars || 0);
    const thinking = Math.max(0, p.thinking || 0);
    if (chars > 0) return `${num(chars)} chars`;
    if (thinking > 0) return `thinking ${num(thinking)} chars`;
    return '';
}
