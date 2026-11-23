/**
 * How many words a text holds, in the language's own sense of a word.
 *
 * Splitting on whitespace counts a whole Japanese, Chinese or Thai sentence as
 * one word, because those scripts put no spaces between words. So a run of
 * text in one of them is counted by Intl.Segmenter, which knows each script's
 * word breaks (`isWordLike` leaves out its punctuation). Every other run is one
 * word, as before, so English, Dutch or Russian count exactly as they did
 * ("well-known" stays one word). A runtime without Intl.Segmenter counts every
 * run as one.
 */

// Intl.Segmenter is in every browser the app supports, but not in the TypeScript lib it targets.
type WordSegmenter = { segment(s: string): Iterable<{ segment: string; isWordLike?: boolean }> };
const Segmenter = (Intl as unknown as { Segmenter?: new (locale: undefined, o: { granularity: 'word' }) => WordSegmenter }).Segmenter;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'word' }) : null;

/** Scripts written without spaces between words. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export function countWords(text: string): number {
    const t = text.trim();
    if (!t) return 0;
    let n = 0;
    for (const run of t.split(/\s+/)) {
        if (!segmenter || !UNSPACED.test(run)) { n++; continue; }
        let words = 0;
        for (const s of segmenter.segment(run)) if (s.isWordLike) words++;
        n += Math.max(1, words);
    }
    return n;
}
