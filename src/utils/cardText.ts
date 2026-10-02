/**
 * Card text carries what plain text cannot: a reading printed ABOVE its word, one
 * word marked out inside a sentence, and a link.
 *
 * An imported deck is untrusted input, so card columns stay PLAIN TEXT and these
 * conventions become structure at render time — nothing injected, and the stored
 * text stays readable in the editor and in AI prompts.
 *
 *  1. **`漢字[かな]` — Anki's furigana notation**, as the deck wrote it
 *     (`server/ankiImport.js` prefers the field carrying it).
 *  2. **`**word**` — the target word emphasised in its example sentence.** Parsed
 *     here, not by markdown: CommonMark will not open strong emphasis between two
 *     letters, and Japanese has no spaces (`スポーツは**あまり**好き`).
 *
 * A reading's base is the trailing run of IDEOGRAPHS before the bracket, not Anki's
 * "non-space run" (which would put `じかん` over all of `今はあまり時間`); a separator
 * space the deck wrote is consumed. Digits are bases too (`1[いち]`), since a numeral
 * has a reading.
 *
 * Deliberately narrow, since this runs over every card: a bracket whose contents are
 * not kana, or that follows no base character, is left as it was
 * (`answer 3 [see p. 12]`).
 */

export type CardSegment =
    | { kind: 'text'; text: string; strong: boolean }
    | { kind: 'ruby'; base: string; reading: string; strong: boolean }
    | { kind: 'link'; label: string; url: string; strong: boolean };

/** Kanji (plus 々 〆 ヶ, which behave as part of a base). */
const IDEOGRAPH = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3005\\u3006\\u30F6';
/** What a reading may sit on: a kanji, and the digits of `1[いち]`. */
const BASE_CHAR = `${IDEOGRAPH}0-9\\uFF10-\\uFF19`;
const TRAILING_BASE = new RegExp(`[${BASE_CHAR}]+$`);

/** Hiragana, katakana (incl. the small kana, the長音符 and half-width forms). */
const KANA_ONLY = /^[ぁ-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]+$/;
const HAS_IDEOGRAPH = new RegExp(`[${IDEOGRAPH}]`);

const BRACKET = /\[([^\[\]\n]{1,12})\]/g;
const STRONG = /\*\*([^*\n][\s\S]*?)\*\*/g;
/**
 * `[label](url)` — written by `stripAnkiHtml` where the deck had an `<a href>`.
 * http(s)-only in the pattern, so prose brackets are not links and no dangerous
 * scheme reaches the renderer; `safeHref` still runs at render time.
 */
const LINK = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;

/** Cheap test: is there anything here the plain path would render wrongly? */
export function hasRichCardText(input: string): boolean {
    const s = String(input ?? '');
    if (!s) return false;
    return parseCardText(s).some(seg => seg.kind !== 'text' || seg.strong);
}

/** One emphasis-free run split into ruby annotations and the text around them. */
function splitRuby(run: string, strong: boolean): CardSegment[] {
    const out: CardSegment[] = [];
    let cursor = 0;
    let m: RegExpExecArray | null;
    BRACKET.lastIndex = 0;

    const pushText = (text: string) => {
        if (!text) return;
        const last = out[out.length - 1];
        if (last && last.kind === 'text') last.text += text;
        else out.push({ kind: 'text', text, strong });
    };

    while ((m = BRACKET.exec(run))) {
        const reading = m[1];
        if (!KANA_ONLY.test(reading)) continue;

        const before = run.slice(cursor, m.index);
        const baseMatch = TRAILING_BASE.exec(before);
        // No base before it: a plain bracket ("set [phrasal verb]").
        if (!baseMatch) continue;

        const base = baseMatch[0];
        // Anki's separator space before a base is markup, not text.
        pushText(before.slice(0, before.length - base.length).replace(/[ 　]$/, ''));
        out.push({ kind: 'ruby', base, reading, strong });
        cursor = m.index + m[0].length;
    }
    pushText(run.slice(cursor));
    return out;
}

/**
 * One emphasis-free run split into links and the text around them.
 *
 * Links nest BETWEEN emphasis and ruby (a bolded line may contain a link). A label
 * is plain text: no deck prints a reading over a hyperlink.
 */
function splitLinks(run: string, strong: boolean): CardSegment[] {
    if (!run.includes('](')) return splitRuby(run, strong);
    const out: CardSegment[] = [];
    let cursor = 0;
    let m: RegExpExecArray | null;
    LINK.lastIndex = 0;

    while ((m = LINK.exec(run))) {
        out.push(...splitRuby(run.slice(cursor, m.index), strong));
        out.push({ kind: 'link', label: m[1].trim() || m[2], url: m[2], strong });
        cursor = m.index + m[0].length;
    }
    out.push(...splitRuby(run.slice(cursor), strong));
    return out;
}

/**
 * Split card text into renderable segments. Always returns at least one
 * segment for non-empty input, and for ordinary text returns exactly one — so
 * the caller can fall straight through to the plain renderer.
 */
export function parseCardText(input: string): CardSegment[] {
    const s = typeof input === 'string' ? input : String(input ?? '');
    if (!s) return [];

    const out: CardSegment[] = [];
    let cursor = 0;
    let m: RegExpExecArray | null;
    STRONG.lastIndex = 0;

    while ((m = STRONG.exec(s))) {
        out.push(...splitLinks(s.slice(cursor, m.index), false));
        out.push(...splitLinks(m[1], true));
        cursor = m.index + m[0].length;
    }
    out.push(...splitLinks(s.slice(cursor), false));
    return out.filter(seg => seg.kind !== 'text' || seg.text !== '');
}

/**
 * A segment with its annotation removed: a ruby's base, a link's label (never the
 * URL — the consumers are search, the tutor's context and text-to-speech).
 */
function segmentText(seg: CardSegment): string {
    return seg.kind === 'ruby' ? seg.base : seg.kind === 'link' ? seg.label : seg.text;
}

/**
 * The same text with every annotation removed — what a plain-text consumer
 * (search, a length check, a model prompt that has no use for ruby) should see.
 */
export function stripCardMarkup(input: string): string {
    return parseCardText(input).map(segmentText).join('');
}

/**
 * ## Every reading is printed at ONE size — see `.card-ruby rt`
 *
 * Not fitted per pair: a reading's size sets its box height too, so a line with
 * several fitted readings draws them at several sizes on several baselines (half the
 * furigana lines in the real library). 0.5em is the value because two full-width
 * kana at half size are exactly one kanji wide (the browser default and Anki's); the
 * pairs that overhang at 0.5em are only those whose reading is longer than one kanji
 * can cover. The size lives in CSS beside the column padding and the gap above the
 * base.
 */

/**
 * A deck writes a word's own reading as the first supporting line (a bare `せんせい`
 * above the example sentence); like Anki, it is lifted onto the word as furigana.
 *
 * Narrow, since this runs over every card: the word must contain a kanji, and the
 * line must be its per-kanji form or a short kana reading different from the word.
 * Anything else stays where the deck put it.
 */
export function splitWordReading(
    front: string,
    extra?: string | null,
): { reading: string | null; rubyWord: string | null; rest: string } {
    const rest = typeof extra === 'string' ? extra : '';
    const word = typeof front === 'string' ? front : '';
    const nl = rest.indexOf('\n');
    const first = (nl === -1 ? rest : rest.slice(0, nl)).trim();
    const without = nl === -1 ? '' : rest.slice(nl + 1);
    const none = { reading: null, rubyWord: null, rest };
    if (!first || first.length > 40) return none;
    if (!HAS_IDEOGRAPH.test(word)) return none;

    // The deck's PER-KANJI form of this word (`時[じ] 間[かん]`) is preferred: each
    // reading sits over its own character, where a whole-word reading overhangs.
    // Guard: stripped of readings it must BE the word (whitespace ignored, since
    // Anki puts a separator space between groups).
    const bare = (t: string) => stripCardMarkup(t).replace(/\s+/g, '');
    const carriesRuby = parseCardText(first).some(seg => seg.kind === 'ruby');
    if (carriesRuby && bare(first) === bare(word)) {
        return { reading: null, rubyWord: first, rest: without };
    }

    // Otherwise a flat kana reading, lifted onto the word as one annotation.
    if (first.length > 16) return none;
    if (!KANA_ONLY.test(first)) return none;
    if (stripCardMarkup(word).trim() === first) return none;
    return { reading: first, rubyWord: null, rest: without };
}

/**
 * The example sentence, for the QUESTION side (as Anki shows it: without its
 * reading or translation). `教える` asked over `あなたの名前を教えてください。` gives
 * nothing away; the TRANSLATION would, and it stays on the answer side.
 *
 *  1. The line must be the deck's marked example (it carries `**`).
 *  2. **The question word must be in it, as itself or inflected.** This keeps a
 *     production card (front "truth", back 本当) safe: the Japanese sentence does
 *     not contain the English word, so nothing is offered.
 *
 * Not a substring test alone: a card teaches the dictionary form (面白い) while the
 * sentence conjugates it (`**面白くなかった**`). The stem test compares the word with
 * the span the deck MARKED, so it cannot match elsewhere in the line.
 */
/** Kana, one or more — an inflected tail (okurigana), never a stem. */
const KANA_TAIL = /^[ぁ-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]+$/;


/** The text the deck emphasised inside a line, annotations removed. */
function markedText(line: string): string {
    return parseCardText(line).filter(seg => seg.strong).map(segmentText).join('');
}

/**
 * Is `marked` the word in use — the same word, inflected?
 *
 * Conjugation rewrites the TAIL, never the head, so the test is a shared stem with
 * kana left over on both sides: 面白い / 面白くなかった, 教える / 教えて, 見る / 見ます.
 * It only has to tell a Japanese front from an English one (which shares no prefix),
 * since the marked span and the word come off the same card.
 *
 * A kana-only stem must be nearly the whole word (いる / います yes, あまり / ありました
 * no): one shared kana is weak evidence. Suppletive stems (する / します) are missed.
 */
function isInflectionOf(marked: string, word: string): boolean {
    if (!marked || !word) return false;
    if (marked.includes(word) || word.includes(marked)) return true;
    let p = 0;
    while (p < marked.length && p < word.length && marked[p] === word[p]) p++;
    if (p < 1) return false;
    const stem = word.slice(0, p);
    if (!HAS_IDEOGRAPH.test(stem) && p < word.length - 1) return false;
    return KANA_TAIL.test(word.slice(p)) && KANA_TAIL.test(marked.slice(p));
}

export function contextSentence(front: string, extra?: string | null): string | null {
    const word = stripCardMarkup(typeof front === 'string' ? front : '').trim();
    if (!word) return null;
    const lines = (typeof extra === 'string' ? extra : '').split('\n');
    for (const line of lines) {
        if (!line.includes('**')) continue;
        const plain = stripCardMarkup(line);
        if (plain.includes(word)) return line;
        if (isInflectionOf(markedText(line).trim(), word)) return line;
    }
    return null;
}
