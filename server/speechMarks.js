/**
 * Speech marks: what a card in a language course says aloud, line by line, as
 * the model that wrote the card decided.
 *
 * A card line in a language course often mixes two languages ("de pijn (боль)",
 * "Voorbeeld: Ik heb pijn.", "Engels: pain"), and a speaker beside a line reads
 * it with the LEARNED language's voice. Rules can guess which words those are
 * (`src/utils/pronunciation.ts` `spokenLine`), but only where scripts or labels
 * tell the languages apart: on "the house = het huis" in a course for English
 * speakers they cannot. The model that wrote the card knows. So a card it wrote
 * carries `say`, one mark per spoken line:
 *
 *   { at: "<the card line, as written>", text: "<the words to say>",
 *     lang?: "<language tag>", voices?: 1 | 2 }
 *
 * `at` is a whole line of the card (its front, its back, or one line of its
 * supporting text on either side), `text` the words of that line a voice reads,
 * `lang` the language they are in (the learned one; a region may narrow it, as
 * in `nl-BE`), and `voices` how many voices a recording of it should have.
 *
 * ## The marks are checked before anyone hears them, and fail closed
 *
 * A mark can only choose among words already printed on the card, so it adds
 * no new claim for the card checks (`checkItemKeys`) to read. What it can get
 * wrong is checked here, deterministically, and a mark that fails is dropped
 * while its card stays:
 *   - `at` must be a line of the card;
 *   - `text` must be one unbroken stretch of that line's words;
 *   - every letter of `text` must be in a script the learned language is
 *     written in (a Dutch voice never gets the Russian translation);
 *   - `lang`, when given, must be the learned language;
 *   - `voices` is 1 or 2; one mark per line.
 * A card none of whose marks survived carries none, and falls back to the rules
 * like a card nobody marked. An empty list is kept: the model said there is
 * nothing on this card to say.
 *
 * Plain JavaScript with no database, so the importer, the generator and the
 * client (`CardFace`) all read the same rules.
 */
import { LANGUAGES } from './languageCatalog.js';

export const MAX_SPEECH_MARKS = 12;
export const MAX_MARK_TEXT = 300;
export const MAX_VOICES = 2;

const base = (code) => String(code ?? '').trim().toLowerCase().split(/[-_]/)[0];

/** Unicode classes for each script the catalog names. */
export const SCRIPT_CLASS = Object.freeze({
    Latin: '\\p{Script=Latin}',
    Cyrillic: '\\p{Script=Cyrillic}',
    Greek: '\\p{Script=Greek}',
    // The long-vowel mark (ー, and its half-width form) is script Common, but it
    // is part of the word: コーヒー without it would be cut into コ and ヒ.
    Kana: '\\p{Script=Hiragana}\\p{Script=Katakana}\\u30FC\\uFF70',
    Han: '\\p{Script=Han}',
    Hangul: '\\p{Script=Hangul}',
    Arabic: '\\p{Script=Arabic}',
    Hebrew: '\\p{Script=Hebrew}',
    Devanagari: '\\p{Script=Devanagari}',
});

/** The scripts a catalog language is written in, or null for a language the
 *  catalog does not know. An empty catalog list means Latin letters, except
 *  for two the catalog leaves at that: Greek has its own script, and Serbian is
 *  written in both Cyrillic and Latin. */
export function scriptsOf(code) {
    const c = base(code);
    if (c === 'el') return ['Greek'];
    if (c === 'sr') return ['Cyrillic', 'Latin'];
    const lang = LANGUAGES.find(l => l.code === c);
    if (!lang) return null;
    return lang.scripts.length ? lang.scripts : ['Latin'];
}

/** How two card lines are compared: Unicode form, spacing and case do not count
 *  (a line written with Markdown's two trailing spaces is the same line). */
export function lineKey(line) {
    return String(line ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Every line a card shows, as the card face draws them: the front whole, the
 *  back whole (each is one block with one speaker, whatever line breaks it
 *  holds), and each supporting line on both sides on its own. */
export function cardLines(card) {
    const lines = [];
    for (const f of [card?.front, card?.back]) {
        if (typeof f === 'string' && f.trim()) lines.push(f.trim());
    }
    for (const f of [card?.extra_front, card?.extra]) {
        if (typeof f !== 'string') continue;
        for (const l of f.split('\n')) if (l.trim()) lines.push(l.trim());
    }
    return lines;
}

/** Line key -> the drawn line a mark's `at` names. A front or back written on
 *  several lines is one drawn line, so a mark naming one of its lines names
 *  the whole side. */
function drawnLines(card) {
    const lines = new Map(cardLines(card).map(l => [lineKey(l), l]));
    for (const f of [card?.front, card?.back]) {
        if (typeof f !== 'string' || !f.includes('\n')) continue;
        for (const part of f.split('\n')) {
            const k = lineKey(part);
            if (k && !lines.has(k)) lines.set(k, f.trim());
        }
    }
    return lines;
}

// A word: letters, marks and digits, held together by an apostrophe or hyphen
// inside it (l'eau, мʼясо, e-mail).
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’ʼ\-‐][\p{L}\p{M}\p{N}]+)*/gu;
// Scripts written without spaces between words: a word there may be part of a longer run.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** Whether `text` is one unbroken stretch of `line`: its words are whole words
 *  of the line, side by side (punctuation between them aside). Two pieces of a
 *  line glued together would be read as one sentence nobody wrote. */
export function wordsInLine(text, line) {
    const words = lineKey(text).match(WORD) ?? [];
    if (!words.length) return false;
    if (words.some(w => UNSPACED.test(w))) {
        // No spaces between words: the stretch is found in the line's letters.
        const letters = (s) => lineKey(s).replace(/[^\p{L}\p{M}\p{N}]/gu, '');
        return letters(line).includes(letters(text));
    }
    const lineWords = lineKey(line).match(WORD) ?? [];
    for (let i = 0; i + words.length <= lineWords.length; i++) {
        if (words.every((w, j) => lineWords[i + j] === w)) return true;
    }
    return false;
}

/** Whether every letter of `text` is in one of `scripts`. */
export function lettersInScripts(text, scripts) {
    const cls = scripts.map(s => SCRIPT_CLASS[s] ?? '').join('');
    if (!cls) return false;
    const outside = new RegExp(`(?![${cls}])\\p{L}`, 'u');
    return /\p{L}/u.test(text) && !outside.test(text);
}

const LANG_TAG = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;

/**
 * The marks of one card, checked against its own lines and the language the
 * course teaches.
 *
 * @param {unknown} raw   what the model or the file wrote as `say`
 * @param {{front: string, back: string, extra?: string|null, extra_front?: string|null}} card
 * @param {string} learning  the course's `learning_language`
 * @returns {{ marks: Array<{at: string, text: string, lang?: string, voices: number}> | null,
 *             dropped: Array<{ index: number, reason: string }> }}
 *   `marks` null = the card is not marked (nothing usable was written, or the
 *   course teaches no language), so the rules decide its speakers.
 */
export function normalizeSpeechMarks(raw, card, learning) {
    const dropped = [];
    if (!Array.isArray(raw)) return { marks: null, dropped };
    const learn = base(learning);
    const scripts = learn ? scriptsOf(learn) : null;
    if (!scripts) {
        if (raw.length) dropped.push({ index: 0, reason: 'the course teaches no language' });
        return { marks: null, dropped };
    }
    const lines = drawnLines(card);
    const marks = [];
    const used = new Set();
    const tooMany = `more than ${MAX_SPEECH_MARKS} marks on one card`;
    // Past a few times the cap nothing is read, and the rest is one refusal:
    // a list of thousands costs nothing to refuse.
    const read = raw.slice(0, MAX_SPEECH_MARKS * 4);
    read.forEach((m, index) => {
        const drop = (reason) => dropped.push({ index, reason });
        if (marks.length >= MAX_SPEECH_MARKS) return drop(tooMany);
        if (!m || typeof m !== 'object' || Array.isArray(m)) return drop('not an object');
        const line = typeof m.at === 'string' && m.at.length <= 4000 ? lines.get(lineKey(m.at)) : undefined;
        if (!line) return drop('"at" is not a line of the card');
        const key = lineKey(line);
        if (used.has(key)) return drop('a second mark on one line');
        const text = typeof m.text === 'string' ? m.text.replace(/\s+/g, ' ').trim() : '';
        if (!text || text.length > MAX_MARK_TEXT) return drop('no words to say, or too many');
        let lang;
        if (m.lang != null && m.lang !== '') {
            if (typeof m.lang !== 'string' || !LANG_TAG.test(m.lang.trim())) return drop('"lang" is not a language tag');
            if (base(m.lang) !== learn) return drop('"lang" is not the language the course teaches');
            const tag = m.lang.trim().replace('_', '-');
            if (tag.toLowerCase() !== learn) lang = tag;
        }
        if (!wordsInLine(text, line)) return drop('the words are not in the line');
        if (!lettersInScripts(text, scripts)) return drop('letters outside the learned language\'s script');
        const voices = m.voices == null ? 1 : m.voices;
        if (!Number.isInteger(voices) || voices < 1 || voices > MAX_VOICES) return drop(`"voices" is not a whole number from 1 to ${MAX_VOICES}`);
        used.add(key);
        marks.push({ at: line, text, ...(lang ? { lang } : {}), voices });
    });
    if (raw.length > read.length) dropped.push({ index: read.length, reason: tooMany });
    // Everything written was wrong: the rules know more about this card than the marks.
    if (raw.length && !marks.length) return { marks: null, dropped };
    return { marks, dropped };
}

/** The stored form (`flashcards.say`): JSON text, or null for an unmarked card. */
export const speechMarksColumn = (marks) => (Array.isArray(marks) ? JSON.stringify(marks) : null);

/**
 * A stored `say` column after the card's text changed (a learner's edit, a
 * course update): the marks still true of the card as it now reads. Unmarked
 * stays unmarked and "nothing to say" (`[]`) stays so; a card whose marks all
 * stopped being true goes back to the rules (null).
 */
export function marksStillTrue(rawColumn, card, learning) {
    if (rawColumn == null) return null;
    const stored = parseSpeechMarks(rawColumn);
    if (!stored) return null;
    return speechMarksColumn(normalizeSpeechMarks(stored, card, learning).marks);
}

/**
 * A stored `say` column read back, for a reader that trusts the writer to have
 * checked it (the card face, the export): the shape only. Null when unmarked
 * or unreadable.
 */
export function parseSpeechMarks(rawColumn) {
    let v = rawColumn;
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { return null; }
    }
    if (!Array.isArray(v)) return null;
    return v.filter(m => m && typeof m.at === 'string' && typeof m.text === 'string' && m.text.trim())
        .map(m => ({
            at: m.at, text: m.text,
            ...(typeof m.lang === 'string' && m.lang ? { lang: m.lang } : {}),
            voices: Number.isInteger(m.voices) && m.voices >= 1 && m.voices <= MAX_VOICES ? m.voices : 1,
        }));
}
