/**
 * The English half of the language proxies (not a case family: the families
 * import it). The app's own drift check only catches drift TOWARDS English, so
 * an English course needs its own check that the prose is English and not, say,
 * a Dutch translation. A function-word proxy: English text is full of "the",
 * "of", "to"; Dutch text has "de", "het", "een" instead. Words both languages
 * share ("in", "is") are in neither set.
 */
const wordsOf = (s) => String(s).toLowerCase().match(/\p{L}+/gu) || [];
const EN = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'are', 'that', 'it', 'for', 'with', 'as', 'on', 'this', 'by', 'be', 'which', 'what', 'how', 'from', 'its', 'can', 'or', 'when', 'why', 'you', 'your', 'has', 'have', 'into',
    // Question imperatives: a terse card front ("Name the ...", "Identify ...") may hold no other function word.
    // Tuned to card fronts: some (list, state, name) are words in other languages too; the Dutch set still decides.
    'name', 'identify', 'describe', 'explain', 'define', 'give', 'state', 'list', 'compare', 'calculate', 'find', 'who', 'where']);
const NL = new Set(['de', 'het', 'een', 'van', 'en', 'zijn', 'voor', 'met', 'dat', 'die', 'niet', 'wordt', 'worden', 'door', 'ook', 'naar', 'bij', 'als', 'wat', 'hoe', 'welke', 'deze', 'dit', 'aan', 'uit', 'je']);

/** null when `text` reads as English, else the reason it does not. */
export function englishFault(text) {
    const ws = wordsOf(text);
    if (!ws.length) return 'no prose to judge';
    const letters = String(text).match(/\p{L}/gu) || [];
    const cyr = letters.filter(ch => /\p{Script=Cyrillic}/u.test(ch)).length / letters.length;
    if (cyr > 0.05) return 'Cyrillic in an English course';
    const en = ws.filter(w => EN.has(w)).length / ws.length;
    const nl = ws.filter(w => NL.has(w)).length / ws.length;
    if (nl > 0.05) return `reads as Dutch (Dutch function-word share ${nl.toFixed(2)})`;
    if (en < 0.06) return `does not read as English (function-word share ${en.toFixed(2)})`;
    return null;
}
