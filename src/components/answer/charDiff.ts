/**
 * Where a failed test's result differs from the expected one, character by
 * character, so the review can mark it: "Hello Ada" against "Hello, Ada!" is a
 * missing comma and "!", which a learner otherwise finds letter by letter.
 *
 * A longest common subsequence over code points (an emoji is one character,
 * never half a surrogate pair). Nothing is marked when the two have little in
 * common ("3" against "6": marking all of both says nothing the row's colour
 * did not) or when they are too long to compare cheaply on every render.
 */

export interface DiffPart {
    text: string;
    /** On the expected side: missing from the result. On the result's: not expected. */
    mark: boolean;
}

/** Above this many cells the table is not worth building for a review line. */
const MAX_CELLS = 250_000;

export function diffChars(expected: string, actual: string): { expected: DiffPart[]; actual: DiffPart[] } | null {
    if (expected === actual) return null;
    const a = Array.from(expected);
    const b = Array.from(actual);
    if (!a.length || !b.length || a.length * b.length > MAX_CELLS) return null;

    // lcs[i][j]: the common length of a[i..] and b[j..], one flat row-major array.
    const w = b.length + 1;
    const lcs = new Uint16Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i * w + j] = a[i] === b[j]
                ? lcs[(i + 1) * w + j + 1] + 1
                : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
        }
    }
    // Against the SHORTER text: "6" inside "6.0" is all of it, so the ".0" is
    // worth marking; "3" and "6" share nothing.
    const common = lcs[0];
    if (!common || common * 2 < Math.min(a.length, b.length)) return null;

    const left: DiffPart[] = [];
    const right: DiffPart[] = [];
    const push = (parts: DiffPart[], ch: string, mark: boolean) => {
        const last = parts[parts.length - 1];
        if (last && last.mark === mark) last.text += ch;
        else parts.push({ text: ch, mark });
    };
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push(left, a[i++], false);
            push(right, b[j++], false);
        } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
            push(left, a[i++], true);
        } else {
            push(right, b[j++], true);
        }
    }
    while (i < a.length) push(left, a[i++], true);
    while (j < b.length) push(right, b[j++], true);
    return { expected: left, actual: right };
}
