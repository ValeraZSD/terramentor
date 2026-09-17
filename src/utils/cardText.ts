/**
 * Card text carries two things plain text cannot: a reading printed ABOVE the
 * word it belongs to, and one word marked out inside a sentence.
 *
 * ## Why this is parsed here rather than stored as HTML
 *
 * An imported deck is untrusted input, and the shared markdown sanitizer exists
 * to keep other people's tags out of this app's DOM (`markdownSanitize.ts`). So
 * the card columns stay PLAIN TEXT and this module turns two conventions in
 * that text into structure at render time. Nothing is injected, nothing is
 * eval'd, and what is stored stays readable in the card editor and in the
 * string the AI is handed.
 *
 * The two conventions:
 *
 *  1. **`漢字[かな]` — Anki's own furigana notation.** It is what the deck
 *     already wrote (`server/ankiImport.js` prefers the field carrying it), so
 *     nothing is invented: `今[いま]はあまり 時[じ] 間[かん]が…`. Without it a
 *     beginner's sentence card is unreadable — that is the whole point of the
 *     field — and with it rendered as literal brackets it is worse than
 *     unreadable, which is why the importer used to drop the field entirely.
 *
 *  2. **`**word**` — one word emphasised inside a longer line.** Anki's own
 *     templates bold the target word in the example sentence, and finding the
 *     word being taught inside a sentence is the reason the sentence is there.
 *
 * ### Why not markdown for the emphasis
 *
 * `MathText` already runs react-markdown, so `**x**` would seem to be free.
 * It is not: CommonMark's flanking rules refuse to open strong emphasis when
 * the `**` sits between two letters, and Japanese has no spaces — so
 * `スポーツは**あまり**好き` renders as literal asterisks in every markdown
 * engine. The exact case this exists for is the one markdown cannot do, so the
 * marker is parsed here instead.
 *
 * ### What a reading may be printed over
 *
 * Anki's own rule is "the non-space run before the bracket", which is why its
 * generator has to insert separator spaces — and which turns
 * `今はあまり時間[じかん]` into a reading printed over seven characters. This
 * takes the trailing run of IDEOGRAPHS instead: a reading annotates kanji, so
 * the base of `…あまり時間[じかん]` is 時間. It needs no separator spaces, and it
 * consumes one when the deck wrote it.
 *
 * **A digit is a base too, and leaving it out was a live bug.** A deck writes a
 * number exactly as it writes a kanji — `1[いち] 時[じ] 間[かん]` — because a
 * numeral has a reading and a beginner cannot supply it. With the base
 * restricted to kanji that one bracket matched nothing, so the group in the
 * line that most needed its reading was the one printed as a literal `1[いち]`
 * in the middle of an otherwise correctly annotated sentence. The reading must
 * still be kana, which is what keeps an English deck's `answer 3 [see p. 12]`
 * out of it.
 *
 * Both rules are deliberately narrow, because this runs over EVERY card in the
 * app, most of which are not Japanese: a bracket whose contents are not kana,
 * or which follows something that is not a kanji, is left exactly as it was.
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
 * `[label](url)` — the third convention, written by `stripAnkiHtml` where the
 * deck had an `<a href>`.
 *
 * Deliberately http(s)-only in the pattern itself, so a bracket that happens to
 * be followed by a parenthesis in ordinary prose is not a link, and so nothing
 * that reaches the renderer can carry a scheme worth guarding against. It is
 * still passed through `safeHref` at render time, on the same reasoning as
 * every other row already in the database.
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
        // Nothing annotatable immediately before the bracket: this is not a
        // reading, it is a bracket. An English deck's "set [phrasal verb]"
        // must survive.
        if (!baseMatch) continue;

        const base = baseMatch[0];
        // The separator space Anki's generator writes before a base is markup,
        // not a space the reader should see.
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
 * Links sit BETWEEN emphasis and ruby, which is the order the three conventions
 * nest in: a deck bolds a whole line containing a link, and a link's label can
 * be Japanese. A label is rendered as plain text rather than recursively — a
 * reading printed over a hyperlink is not a thing any deck writes, and the extra
 * layer would be code with no case.
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
 * What one segment reads as with its annotation removed: a ruby's base word, a
 * link's label, the text itself. The URL is deliberately NOT part of it — the
 * consumers here are search, the tutor's context and text-to-speech, and none
 * of them is helped by a Khan Academy path being read out.
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
 * ## Every reading on the card is printed at ONE size — see `.card-ruby rt`
 *
 * The size used to be FITTED per pair: `min(0.6, max(0.45, baseWidth /
 * readingWidth))`, so one kana over one kanji got 0.6em and three kana got
 * 0.45em. Each pair on its own then looked right, and the line they shared did
 * not. A reading's font-size decides its box height as well as its width, so a
 * sentence carrying several readings drew them at several sizes AND at several
 * heights: measured on the real card 11667
 * (`私[わたし]は日本[にほん] 語[ご]を 勉[べん] 強[きょう]しています。`) the five
 * annotations came out at 8.1px, 10.8px, 10.8px, 9px and 8.1px, their tops
 * staggered over 3px — a row of kana in three sizes on three baselines above
 * one line of text. That is not a subtlety of one card: **1,398 of the 2,768
 * furigana lines in the real library (50.5%) mix more than one size**, and it
 * is what reads as "the kana above the kanji is off".
 *
 * So the size is a constant, and 0.5em is the one value that earns it: two
 * full-width kana at half size are exactly one full-width kanji, which is why
 * both the browser default and Anki sit there and why a two-kana reading lands
 * exactly on its character. It is also cheap in the only way that could have
 * argued against it — measured over all 7,483 pairs in the library, the 791
 * that overhang their base at a flat 0.5em are **the same 791** that already
 * overhang under the fitted rule (they ask for more than 0.45em anyway), so
 * uniformity buys the raggedness fix without widening a single column that was
 * not already wide.
 *
 * The size therefore lives in CSS next to the two rules it works with (the
 * column padding that separates adjacent readings, and the gap above the base)
 * rather than as an inline style computed per ruby.
 */

/**
 * A deck writes a word's own reading as the first supporting line — a bare
 * `せんせい` sitting above the example sentence, disconnected from the 先生 at
 * the top of the card. Anki prints it where it belongs: as furigana ON the
 * word. Printed as its own line it is not merely uglier, it is a second thing
 * to read and match up by eye, and on a card that also carries a sentence with
 * its OWN readings the loose kana line reads as part of the sentence block.
 *
 * So the reading is lifted out of the supporting lines and handed to the word.
 * Deliberately narrow, because this runs over every card in the app: the first
 * line must be kana only, short, and different from the word itself, and the
 * word must contain a kanji for a reading to be about. Anything else is left
 * exactly where the deck put it.
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

    // The deck's PER-KANJI form of this very word (`時[じ] 間[かん]`), which is
    // strictly better than a flat whole-word reading: each reading sits over the
    // character it belongs to instead of one annotation stretched across the
    // whole word. Four kana over two kanji is WIDER than the word underneath, so
    // a whole-word reading overhangs on both sides and reads as misaligned —
    // which is exactly how it looked beside the same card's sentence, where the
    // deck's own per-kanji furigana was already being rendered correctly.
    //
    // The guard is that it must annotate THIS word and nothing else: stripped of
    // its readings it has to be the word itself. Whitespace is ignored on both
    // sides because Anki inserts a separator space between adjacent groups.
    const bare = (t: string) => stripCardMarkup(t).replace(/\s+/g, '');
    const carriesRuby = parseCardText(first).some(seg => seg.kind === 'ruby');
    if (carriesRuby && bare(first) === bare(word)) {
        return { reading: null, rubyWord: first, rest: without };
    }

    // Otherwise the older, narrower rule: a flat kana reading lifted onto the
    // word as one annotation. Still much better than a loose kana line floating
    // above the example sentence with nothing tying it to the word.
    if (first.length > 16) return none;
    if (!KANA_ONLY.test(first)) return none;
    if (stripCardMarkup(word).trim() === first) return none;
    return { reading: first, rubyWord: null, rest: without };
}

/**
 * The example sentence, for the QUESTION side.
 *
 * The rule used to be "supporting lines are answer-side only, because an
 * example sentence contains the word and therefore hands over the answer". Put
 * next to Anki's own card that turns out to be half right, and the half it gets
 * wrong is the useful half. Anki shows the sentence on the FRONT — without its
 * reading and without its translation — so `教える` is asked with
 * `あなたの名前を教えてください。` under it. The Japanese sentence cannot hand
 * over "teach, tell"; what would is the TRANSLATION, and that stays on the
 * answer with the reading. Meanwhile the learner gets the word in use, which is
 * most of why the sentence is on the card at all: you are learning to read the
 * sentence, not only to recall a gloss.
 *
 * Two conditions, and the second is the guard that keeps this honest:
 *
 *  1. The line must be the deck's marked example — the one carrying `**`, which
 *     is how a deck marks the target word inside its sentence.
 *  2. **The question word must be in it — as itself, or inflected.** That is
 *     what makes this safe in the reverse direction: on a production card
 *     (front "truth", back 本当) the Japanese sentence does not contain the
 *     English word, so no context sentence is offered and the answer is not
 *     given away. A rule based on line position or on script would get that
 *     case wrong.
 *
 * ### Why a literal substring test was not enough
 *
 * A sentence uses a word; a card teaches its dictionary form. Japanese
 * conjugates, so 面白い is asked while the deck's own example reads
 * `この本は全然**面白くなかった**。` — the word is right there, marked by the
 * deck itself, and a substring test says no. That silently withheld the
 * sentence from every verb and adjective card in the deck, which is most of
 * them, leaving exactly the cards whose meaning depends most on context with no
 * context. The stem test below compares the word against the span the deck
 * MARKED rather than against the whole sentence — a tighter guard than the
 * literal one, since the word can no longer match some unrelated place in the
 * line.
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
 * Japanese conjugation rewrites the TAIL and never the head, so a shared stem
 * with kana left over on both sides is the whole test: 面白い / 面白くなかった,
 * 教える / 教えて, 見る / 見ます.
 *
 * **The kana leftovers are the guard, not the length of the stem.** What this
 * has to tell apart is a Japanese front from an ENGLISH one (the reverse-
 * direction card, where showing the sentence would hand over the answer), and
 * an English word shares no prefix with a Japanese sentence at all. It does not
 * have to tell two Japanese words apart, because the marked span and the word
 * come off the same card: the deck marked ITS OWN word in ITS OWN example.
 *
 * A stem of one kana is still refused unless it is nearly the whole word
 * (いる / います yes, あまり / ありました no) — one shared kana is weak evidence
 * where one shared kanji is strong. する / します shares nothing and is missed;
 * a suppletive stem is not something a prefix rule can reach.
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
