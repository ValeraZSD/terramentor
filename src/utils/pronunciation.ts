import { languageNamedBy } from '../../server/learningLanguage.js';
import { SCRIPT_CLASS, scriptsOf } from '../../server/speechMarks.js';
import { stripCardMarkup } from './cardText';

/**
 * Which lines of a card in a language course can be said aloud, and the words
 * to say.
 *
 * A course that teaches a language mixes two on one card: "het huiswerk" with
 * "домашнее задание", an example sentence under a translation, a label in the
 * learner's language before a sentence in the learned one. A speaker beside a
 * line says it in the LEARNED language's voice, so it must sit only where that
 * voice is right: a Dutch voice reading Russian, or English, teaches the
 * wrong sound with full confidence.
 *
 * PRECISION OVER RECALL, as in `server/learningLanguage.js`: a line is voiced
 * only when the course's two languages tell it apart for certain.
 *   - Two scripts (Russian and Dutch, English and Japanese): the runs of text
 *     in the learned language's script are its words. "de pijn (боль)" says
 *     "de pijn"; a line with none says nothing.
 *   - One language (a Dutch course written in Dutch): every line is it, except
 *     a line whose label names another language ("Engels: mission").
 *   - Two languages in one script (English and Dutch): only a line whose label
 *     names the learned language ("Nederlands: het huis"); the letters alone
 *     cannot say which is which on a two-word card.
 * In every case a label naming another language silences its line, and a label
 * naming the learned one leaves only what follows it.
 */

export interface CourseLanguages {
    /** The language the course teaches (`learning_language`). */
    learning: string;
    /** The language it is written in (`content_language`), '' when not declared. */
    content: string;
}

const base = (code: string) => code.trim().toLowerCase().split(/[-_]/)[0];

const classOf = (scripts: string[]) => scripts.map(s => (SCRIPT_CLASS as Record<string, string>)[s] ?? '').join('');

// "Voorbeeld: …", "Engels (automatisch vertaald): …", "Пример: …": a short
// label before a colon. No sentence punctuation in it, at most four words.
const LABEL = /^([^:：.!?;]{1,40})[:：]\s*(\S[\s\S]*)$/u;

/** The language a line's label names, when it has a label and the label names one. */
function labelLanguage(label: string): string | null {
    const words = label.match(/[\p{L}\p{M}]+/gu) ?? [];
    if (!words.length || words.length > 4) return null;
    for (const w of words) {
        const code = languageNamedBy(w);
        if (code) return code;
    }
    return null;
}

/** The plain words of a card line: markup, readings and pictographs removed. */
function plain(line: string): string {
    return stripCardMarkup(line)
        .replace(/\p{Extended_Pictographic}️?/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Signs of no script of their own that sit INSIDE a word or sentence: the
// Ukrainian apostrophe (мʼясо), the Arabic joining stroke, the zero-width
// joiner and non-joiner of Indic and Persian words, the Devanagari stops, the
// Greek middle dot, and the two hyphens. Built from code points, as two of
// them are invisible.
const JOINERS = String.fromCharCode(0x02BC, 0x0640, 0x200C, 0x200D, 0x0964, 0x0965, 0x00B7, 0x0387, 0x2010, 0x2011);
// Sentence ends that close a run: the Devanagari stops and the Greek question mark too.
const ENDS = '.!?…)。！？؟' + String.fromCharCode(0x0964, 0x0965, 0x037E);

/** The runs of `text` written in `scripts`, joined: what a learned-language voice can read of it. */
function runsIn(text: string, scripts: string[]): string {
    const cls = classOf(scripts);
    if (!cls) return '';
    const letter = `[${cls}]`;
    // Between two letters of the script: its marks, digits, spaces and any
    // punctuation, the full-width and Arabic kinds too (私、学生です。 is one
    // run). A letter of another script ends the run. A number may open it
    // ("2.000 euro per maand").
    const inner = `[${cls}\\p{M}\\p{N}\\s'’\\-.,:;!?¿¡…()\\[\\]"“”„«»/%€$£、，：；「」『』・〜（）،؛${JOINERS}]`;
    // A word's last letter keeps the marks after it (Arabic كِتَابٌ ends in one).
    // A number may close the run where the text ends ("Ik heb 2"); one followed
    // by more text is left to whatever comes after it.
    const tail = `(?:\\s*\\p{N}[\\p{N}.,%€$£]*(?=[${ENDS}]?\\s*$))?`;
    const run = new RegExp(`(?:\\p{N}[\\p{N}\\s.,%€$£]*)?${letter}(?:${inner}*${letter})?\\p{M}*${tail}[${ENDS}]?`, 'gu');
    // A lone letter of an alphabet is a stray ("B1", "a)"); a lone Han, Kana
    // or Hangul sign is a word (水, 猫, 물).
    const least = scripts.some(s => s === 'Han' || s === 'Kana' || s === 'Hangul') ? 1 : 2;
    const found = (text.match(run) ?? []).map(s => s.trim()).filter(s => (s.match(new RegExp(letter, 'gu')) ?? []).length >= least);
    return found.join(', ');
}

/**
 * What the learned language's voice should say for one card line, or null
 * when the line is not (or not certainly) in that language.
 */
export function spokenLine(line: string, langs: CourseLanguages): string | null {
    const learning = base(langs.learning || '');
    if (!learning) return null;
    const learnScripts = scriptsOf(learning);
    if (!learnScripts) return null;

    let text = plain(line);
    if (!text) return null;

    const label = LABEL.exec(text);
    const named = label ? labelLanguage(label[1]) : null;
    if (named && named !== learning) return null;
    if (label && named === learning) text = label[2].trim();

    const content = base(langs.content || '');
    if (content !== learning) {
        const contentScripts = content ? scriptsOf(content) : null;
        if (!contentScripts) return null;
        // One script for both: only a label naming the learned language tells them apart.
        if (named !== learning && contentScripts.some(s => learnScripts.includes(s))) return null;
        // A gloss beside the word ("het huiswerk (homework)", "het huiswerk =
        // the homework") is in the learned script too, often English: an aside
        // in brackets, and whatever follows " = ", is not said.
        text = text.replace(/\s*[(（][^()（）]*[)）]/gu, ' ').split(/\s+=\s+/)[0].trim();
    }
    // In a course written in the language it teaches the runs are the whole
    // line, unless something in another script is on it; that is left out too.
    const said = runsIn(text, learnScripts);
    return said || null;
}
