// server/ankiFields.js — which field is the question, which is the answer, and
// what else on the note is worth keeping.
//
// ## Why position was not enough
//
// The importer's first rule was "the first non-empty field is the question and
// the next one is the answer", chosen because Anki's card TEMPLATES — the things
// that actually define a card's front and back — were believed unreadable,
// being protobuf. They are not: see `ankiTemplates.js`, which recovers `qfmt`
// and `afmt` and now decides which fields land on which SIDE. What survives here
// is the half a template genuinely cannot answer — **which of the back's fields
// is the answer**, since Anki has no such concept (the whole back is the answer,
// ordered for reading rather than for grading). Position was the honest fallback
// and it is right for a two-field Basic note, which is most decks.
//
// It is wrong for every rich note type, and measurably so. A widely used
// Japanese starter deck has **fourteen** fields:
//
//   Word · Word Reading · Word Meaning · Word Furigana · Word Audio ·
//   Sentence · Sentence Meaning · Sentence Furigana · Sentence Audio ·
//   Notes · Pitch Accent · Pitch Accent Notes · Frequency · Picture
//
// Position picks fields 0 and 1, so `早い` was answered by `はやい` and the
// learner never saw **early** at all — a reading drill, not a vocabulary card.
// Worse, for a word already written in kana the two fields are IDENTICAL, so
// `あまり` imported as a card whose answer is the question.
//
// ## What this reads instead, and why it is not the same guess again
//
// The field NAMES are plain text in both schemas (schema 18's `fields` table,
// schema 11's `models` JSON) and they are descriptive, because a human wrote
// them for other humans to fill in. "Word Meaning" says what it holds. Matching
// on those names is a guess, but it is a guess about a string an author wrote
// deliberately, rather than about an ordering they never thought about.
//
// Three things keep it safe:
//   1. **Unknown names fall back to position**, so nothing that worked before
//      changes for a deck this cannot read.
//   2. **Unrecognised fields are never printed on the card.** That deck's `Pitch
//      Accent` is presentational HTML and its `Frequency` is the number 388;
//      dumping every leftover field onto the answer would put "388" on 1,500
//      cards. Only known-useful roles are promoted.
//   3. **The preview still decides.** Three real cards with a live Swap toggle
//      was already the safety net for a bad front/back guess; it catches a bad
//      role guess the same way, and for the same reason it is worth guessing at
//      all — the learner sees the consequence before committing.

/** What a field holds. UNKNOWN is a real answer, not a failure. */
export const ROLES = {
    TERM: 'term',
    READING: 'reading',
    MEANING: 'meaning',
    SENTENCE: 'sentence',
    SENTENCE_MEANING: 'sentence_meaning',
    SENTENCE_READING: 'sentence_reading',
    NOTES: 'notes',
    AUDIO: 'audio',
    PICTURE: 'picture',
    IGNORE: 'ignore',
    UNKNOWN: 'unknown',
};

// Order is load-bearing: the first pattern that matches wins, and several field
// names legitimately match more than one ("Sentence Meaning" is both).
const MEANINGISH = /(meaning|definition|translation|english|deutsch|espa|gloss|answer|back)/i;
const READINGISH = /(reading|furigana|kana|hiragana|katakana|romaji|pinyin|jyutping|pronunciation|transcription|phonetic)/i;
const SENTENCEISH = /(sentence|example|context|usage|phrase|quote)/i;

/**
 * The role of one field, from its name.
 *
 * Matching is on the whole name, case-insensitively. Everything here is a
 * substring test rather than an exact one because real decks write "Word
 * Meaning", "Meaning (EN)", "Back Extra" and "target word".
 */
export function fieldRole(name) {
    const n = String(name ?? '').trim();
    if (!n) return ROLES.UNKNOWN;

    // Media first: these are never card text, whatever else the name says.
    if (/(audio|sound|voice|tts|recording)/i.test(n)) return ROLES.AUDIO;
    if (/(picture|image|photo|diagram|screenshot|illustration)/i.test(n)) return ROLES.PICTURE;

    // Metadata a learner must never be shown. A Pitch Accent field is inline
    // styled HTML that strips to a bare "アマリ", which is worse than nothing;
    // Frequency is a rank; the rest are bookkeeping.
    if (/(pitch|accent|frequency|freq\b|rank|priority|\border\b|index|\bid\b|guid|uid|tags?|source|url|link|deck|created|modified|level|jlpt|hsk)/i.test(n)) {
        return ROLES.IGNORE;
    }

    // A sentence field, and then which PART of the sentence it holds. Checked
    // before the plain meaning/reading tests, or "Sentence Meaning" would be
    // read as the word's own meaning and answer the card with a translation of
    // an example the learner has not been shown.
    if (SENTENCEISH.test(n)) {
        if (MEANINGISH.test(n)) return ROLES.SENTENCE_MEANING;
        if (READINGISH.test(n)) return ROLES.SENTENCE_READING;
        return ROLES.SENTENCE;
    }

    if (MEANINGISH.test(n)) return ROLES.MEANING;
    if (READINGISH.test(n)) return ROLES.READING;
    if (/(note|comment|mnemonic|hint|explanation|remark)/i.test(n)) return ROLES.NOTES;
    if (/(word|expression|term|front|question|vocab|kanji|hanzi|character|prompt|target|headword|lemma)/i.test(n)) {
        return ROLES.TERM;
    }
    return ROLES.UNKNOWN;
}

/**
 * Does this text carry Anki's furigana notation — a kana reading in brackets
 * directly after a kanji?
 *
 * Mirrors the (stricter, segment-producing) rule in `src/utils/cardText.ts`,
 * which is what renders it. Kept loose here on purpose: this decides only which
 * FIELD to take, and a field the renderer then treats as ordinary text is a
 * sentence shown without its readings, not a broken card.
 */
export function hasFurigana(text) {
    return /[㐀-䶿一-鿿々〆ヶ]\[[ぁ-ゟ゠-ヿ]{1,12}\]/.test(String(text ?? ''));
}

/** Same text, ignoring case and the whitespace HTML leaves behind. */
const sameText = (a, b) =>
    String(a ?? '').replace(/\s+/g, '').toLowerCase() ===
    String(b ?? '').replace(/\s+/g, '').toLowerCase();

/**
 * Choose the question, the answer, and the supporting lines for one note.
 *
 * `values` are the parsed fields (`{ text, images, sounds }` from
 * `stripAnkiHtml`), `names` the field names in the same order. Returns indices
 * so the caller keeps ownership of the media those fields carried.
 *
 * Returns null when nothing on the note can be a question.
 */
export function mapNoteFields(values, names = []) {
    const roles = values.map((_, i) => fieldRole(names[i]));
    const hasText = (i) => !!values[i]?.text;
    const hasMedia = (i) => !!(values[i]?.images?.length || values[i]?.sounds?.length);
    const usable = (i) => hasText(i) || hasMedia(i);

    const firstWith = (role, pred = hasText) =>
        values.findIndex((_, i) => roles[i] === role && pred(i));
    /** Every field with this role, in field order — a deck can legitimately
     *  ship two (a flat reading and a furigana one) and the choice between them
     *  is about their content, not their position. */
    const allWith = (role, pred = hasText) =>
        values.map((_, i) => i).filter(i => roles[i] === role && pred(i));

    // --- the question
    let front = firstWith(ROLES.TERM, usable);
    if (front < 0) front = values.findIndex((_, i) => roles[i] === ROLES.UNKNOWN && usable(i));
    // Nothing named usefully: the original positional rule, unchanged.
    if (front < 0) front = values.findIndex((_, i) => usable(i));
    if (front < 0) return null;

    // --- the answer
    //
    // A meaning is what a vocabulary card is asking for. A reading is only the
    // answer when there is no meaning on the note — and never when it is the
    // same string as the question, which is what made every kana-only word
    // import as a card answering itself.
    let back = firstWith(ROLES.MEANING);
    if (back < 0) {
        const reading = firstWith(ROLES.READING);
        if (reading >= 0 && !sameText(values[reading].text, values[front].text)) back = reading;
    }
    if (back < 0) {
        back = values.findIndex((_, i) =>
            i !== front && usable(i) && roles[i] !== ROLES.IGNORE &&
            roles[i] !== ROLES.AUDIO && roles[i] !== ROLES.PICTURE &&
            !sameText(values[i].text, values[front].text));
    }
    if (back < 0) return null;

    // --- the supporting lines
    //
    // Everything Anki's own template shows under the answer, in reading order,
    // and nothing else. A field whose role this file does not recognise is left
    // off the card rather than printed on it.
    const extras = [];
    const take = (i) => {
        if (i < 0 || i === front || i === back) return;
        if (!hasText(i)) return;
        if (extras.includes(i)) return;
        extras.push(i);
    };

    // The reading, but only when it adds something: not when it IS the answer,
    // and not when it merely repeats the question.
    //
    // A deck often ships TWO of these — one measured has "Word Reading" (`じかん`) and
    // "Word Furigana" (`時[じ] 間[かん]`) — and both match the same role, so the
    // one that happened to come first won, which was the flat kana. That is the
    // identical mistake the sentence below already corrects, and it shows up as
    // a rendering complaint: a whole-word reading becomes ONE ruby annotation
    // spanning every kanji, and four kana over two kanji is wider than the word
    // it annotates, so it overhangs on both sides and reads as misaligned. The
    // per-kanji form sits each reading exactly over its own character, which is
    // what the same card's sentence already did and why the two looked like
    // different features. Tested on CONTENT, never on the name.
    const readings = allWith(ROLES.READING);
    const rubyWord = readings.find(i => hasFurigana(values[i].text));
    const reading = rubyWord != null ? rubyWord : (readings[0] ?? -1);
    if (reading >= 0 && !sameText(values[reading].text, values[front].text)) take(reading);

    // The furigana sentence in preference to the plain one, now that the ruby
    // is rendered above the kanji instead of arriving as literal brackets
    // (`src/utils/cardText.ts`). For a beginner deck the readings ARE the
    // sentence's value — such decks ship the field for exactly that reason — so
    // taking the plain one threw away the half a learner cannot reconstruct.
    // The test is on the CONTENT, never on the field's name: a "Sentence
    // Furigana" field that happens to hold no brackets is just the sentence
    // again, and then the plainly-named field is the safer one to trust.
    const sentence = firstWith(ROLES.SENTENCE);
    const ruby = firstWith(ROLES.SENTENCE_READING);
    take(ruby >= 0 && hasFurigana(values[ruby].text) ? ruby
        : sentence >= 0 ? sentence
            : ruby);
    take(firstWith(ROLES.SENTENCE_MEANING));
    take(firstWith(ROLES.NOTES));

    return { front, back, extras, roles };
}
