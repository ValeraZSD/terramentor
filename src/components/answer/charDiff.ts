/**
 * Where a failed test's result differs from the expected one, character by
 * character, so the review can mark it: "Hello Ada" against "Hello, Ada!" is a
 * missing comma and "!", which a learner otherwise finds letter by letter.
 *
 * A longest common subsequence over what a reader counts as characters
 * (grapheme clusters: an emoji, a flag or a letter with its accent is never
 * cut in two), run on the part between a shared start and a shared end, so two
 * long outputs that differ in one place cost almost nothing. Nothing is marked
 * when the two have too little in common ("3" against "6", or "ok" against a
 * long error message: marking all of it says nothing the row's colour did not)
 * or when the part that differs is too long to compare cheaply on a render.
 */

export interface DiffPart {
    text: string;
    /** On the expected side: missing from the result. On the result's: not expected. */
    mark: boolean;
}

/** Above this many cells the table is not worth building for a review line. */
const MAX_CELLS = 250_000;

// Typed here because the project's TypeScript library (ES2020) predates
// Intl.Segmenter; a runtime without it falls back to code points.
interface GraphemeSegmenter { segment(s: string): Iterable<{ segment: string }> }
type SegmenterClass = new (locale: undefined, options: { granularity: 'grapheme' }) => GraphemeSegmenter;

let segmenter: GraphemeSegmenter | null | undefined;
function characters(s: string): string[] {
    if (segmenter === undefined) {
        const Segmenter = (Intl as unknown as { Segmenter?: SegmenterClass }).Segmenter;
        segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
    }
    return segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s);
}

export function diffChars(expected: string, actual: string): { expected: DiffPart[]; actual: DiffPart[] } | null {
    if (expected === actual) return null;
    const a = characters(expected);
    const b = characters(actual);
    if (!a.length || !b.length) return null;

    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const n = a.length - head - tail;
    const m = b.length - head - tail;
    if (n * m > MAX_CELLS) return null;

    // lcs[i][j]: the common length of the middles from i and j on, one flat
    // row-major array. A common length is at most the shorter middle, and
    // under MAX_CELLS that is at most 500: far inside 16 bits.
    const w = m + 1;
    const lcs = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i * w + j] = a[head + i] === b[head + j]
                ? lcs[(i + 1) * w + j + 1] + 1
                : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
        }
    }
    // At least half the two texts' average length in common: "6" and "6.0"
    // pass (one of an average of two), "ok" inside a 300-character error does not.
    const common = head + tail + lcs[0];
    if (common * 4 < a.length + b.length) return null;

    const left: DiffPart[] = [];
    const right: DiffPart[] = [];
    const push = (parts: DiffPart[], ch: string, mark: boolean) => {
        const last = parts[parts.length - 1];
        if (last && last.mark === mark) last.text += ch;
        else parts.push({ text: ch, mark });
    };
    for (let k = 0; k < head; k++) {
        push(left, a[k], false);
        push(right, b[k], false);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[head + i] === b[head + j]) {
            push(left, a[head + i++], false);
            push(right, b[head + j++], false);
        } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
            push(left, a[head + i++], true);
        } else {
            push(right, b[head + j++], true);
        }
    }
    while (i < n) push(left, a[head + i++], true);
    while (j < m) push(right, b[head + j++], true);
    for (let k = tail; k > 0; k--) {
        push(left, a[a.length - k], false);
        push(right, b[b.length - k], false);
    }
    return { expected: left, actual: right };
}
