/**
 * Where two versions of a course text differ, word by word, so the update
 * preview can mark only the words that changed: "When a noun takes de" against
 * "When a noun takes de, with five rules" marks the added clause, not the line.
 *
 * Tokens are the language's own words (Intl.Segmenter, so Japanese and Thai
 * split into words and an emoji stays one glyph), each punctuation mark and
 * each run of spaces on its own, so joining a side's parts gives its text back
 * exactly and "het." against "het," marks the comma, not the word. A longest
 * common subsequence over the part between a shared start and end; when the
 * middles are too long to compare cheaply the whole middle is marked, which is
 * still right, only coarser. A space is marked only between two marked words.
 */

export interface WordPart {
    text: string;
    /** On the old side: removed by the update. On the new side: added by it. */
    mark: boolean;
}

const MAX_CELLS = 120_000;

// Intl.Segmenter is in every browser the app supports, but not in the TypeScript lib it targets.
type WordSegmenter = { segment(s: string): Iterable<{ segment: string }> };
const Segmenter = (Intl as unknown as { Segmenter?: new (locale: undefined, o: { granularity: 'word' }) => WordSegmenter }).Segmenter;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'word' }) : null;

const tokens = (s: string): string[] => (segmenter
    ? Array.from(segmenter.segment(s), x => x.segment)
    : s.match(/[\p{L}\p{N}\p{M}_'’]+|\s+|[^\s\p{L}\p{N}\p{M}_'’]/gu) ?? []);

const isSpace = (t: string) => /^\s+$/.test(t);

/** A marked space with an unmarked side is not part of a change: unmark it. */
function settleSpaces(parts: WordPart[]): WordPart[] {
    return parts.map((p, i) => (p.mark && isSpace(p.text) && !(parts[i - 1]?.mark && parts[i + 1]?.mark)
        ? { ...p, mark: false }
        : p));
}

/** Neighbouring parts with the same mark become one, so a run is one highlight. */
function merge(parts: WordPart[]): WordPart[] {
    const out: WordPart[] = [];
    for (const p of parts) {
        const last = out[out.length - 1];
        if (last && last.mark === p.mark) last.text += p.text;
        else out.push({ ...p });
    }
    return out;
}

export function diffWords(before: string, after: string): { before: WordPart[]; after: WordPart[] } {
    const a = tokens(before);
    const b = tokens(after);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const am = a.slice(head, a.length - tail);
    const bm = b.slice(head, b.length - tail);
    const start = a.slice(0, head).map(text => ({ text, mark: false }));
    const end = a.slice(a.length - tail).map(text => ({ text, mark: false }));

    let midA: WordPart[];
    let midB: WordPart[];
    const n = am.length;
    const m = bm.length;
    if (n * m > MAX_CELLS || !n || !m) {
        midA = am.map(text => ({ text, mark: true }));
        midB = bm.map(text => ({ text, mark: true }));
    } else {
        const w = m + 1;
        const lcs = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
            }
        }
        midA = [];
        midB = [];
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (am[i] === bm[j]) { midA.push({ text: am[i], mark: false }); midB.push({ text: bm[j], mark: false }); i++; j++; }
            else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) midA.push({ text: am[i++], mark: true });
            else midB.push({ text: bm[j++], mark: true });
        }
        while (i < n) midA.push({ text: am[i++], mark: true });
        while (j < m) midB.push({ text: bm[j++], mark: true });
    }
    return {
        before: merge(settleSpaces([...start, ...midA, ...end])),
        after: merge(settleSpaces([...start.map(p => ({ ...p })), ...midB, ...end.map(p => ({ ...p }))])),
    };
}
