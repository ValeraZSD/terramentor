/**
 * In which language a NEW course is written, decided the same way on both
 * sides: the creation route runs it, and the New course dialog runs it too so
 * its "Automatic" option can say what Automatic will pick. No database, no
 * model (moved out of projectIdentity.js, which re-exports it).
 *
 * `content_language` arrives as '' whenever the learner leaves the form's
 * "Automatic" choice alone, and on a project that does not exist yet there is
 * no material to follow. Every creation prompt then had no language at all, so
 * a learner who reads the app in Russian and wrote the description in Russian
 * got an English Overview. `resolveCreationLanguage` turns the absence into a
 * definite answer, in a fixed order: explicit choice -> the language the
 * learner WROTE in -> the files' language -> the interface language ->
 * English. The caller persists the result, so every later pass (phases,
 * lessons, questions, cards) reads the same declaration.
 */
import { LANGUAGES } from './languageCatalog.js';

const BY_CODE = new Map(LANGUAGES.map(l => [l.code, l]));

/** The catalog entry for a code, or null — what `language.js` getLanguage returns, without its database. */
export function catalogLanguage(code) {
    return BY_CODE.get(String(code || '').toLowerCase()) || null;
}

/** Function words and diacritics that separate the Latin-script catalog
 *  languages well enough for a sentence. Short lists on purpose: the aim is to
 *  recognise "what language is this learner typing", not to classify a corpus,
 *  and an inconclusive answer simply defers to the interface language. */
const LATIN_WORDS = {
    en: 'the and to of for with is are want learn how from my about basics introduction this that your you can from into new course beginner',
    // "je" is French too, so a Dutch text full of "je" (you) is decided by
    // the words that are Dutch alone (a real worksheet read as French).
    nl: 'het een ik wil leren voor met niet naar mijn zijn deze dit ook graag nieuwe ben je jij hij zij wij van wat hoe maar dat bij uit geen waar omdat heeft hebben heb hebt zich elkaar wordt worden kunnen kunt zou moet nog op',
    de: 'der die das und ich will lernen wie nicht mit für ein eine mein zu ist sind auch über von den dem',
    fr: 'le la les des une et je veux apprendre pour avec pas mon ma est sont comment dans sur du au aux débutant',
    es: 'el los las una quiero aprender para con mi es son cómo como sobre del al que por',
    it: 'il gli una voglio imparare per con mio mia è sono come nel sulla della del che non',
    pt: 'os uma quero aprender para com meu minha é são como no na sobre do da que não você',
    pl: 'jest są chcę chce nauczyć uczyć się jak dla mój moja nie oraz podstawy',
    ro: 'și să cu pentru vreau învăț este sunt cum despre mea meu nu din',
    cs: 'chci se naučit jak pro je jsou není moje můj základy',
    sv: 'och att jag vill lära för med är inte ett hur om',
    da: 'og at jeg vil lære for med er ikke et hvordan om',
    tr: 've bir için ile ben istiyorum öğrenmek nasıl değil bu',
};
export const LATIN_SETS = Object.fromEntries(
    Object.entries(LATIN_WORDS).map(([code, words]) => [code, new Set(words.split(/\s+/))]),
);
/** Letters that all but name their language. Each occurrence is worth two words. */
const LATIN_LETTERS = {
    pl: /[ąęłńśźż]/g,
    ro: /[ășşțţ]/g,
    es: /[ñ¿¡]/g,
    de: /[ß]/g,
    fr: /[çœ]/g,
    pt: /[ãõ]/g,
    cs: /[ěřů]/g,
    tr: /[ğı]/g,
};

const count = (text, re) => (text.match(re) || []).length;

/**
 * The language a piece of text is written in, as a catalog code, or null when it
 * cannot be said with confidence ("Python", "Excel 2024", two words of anything).
 *
 * Non-Latin scripts decide on the script (Cyrillic splits Russian / Ukrainian /
 * Serbian on the letters only one of them has; an ambiguous Cyrillic text takes
 * the `hint` when that is itself a Cyrillic language, else Russian). Latin text
 * needs at least two function-word hits and a lead over the runner-up.
 */
export function detectWrittenLanguage(text, hint = null) {
    const s = String(text || '').toLowerCase();
    const letters = s.match(/\p{L}/gu) || [];
    if (letters.length < 4) return null;

    const n = {
        cyr: count(s, /[Ѐ-ӿ]/g),
        kana: count(s, /[぀-ヿ]/g),
        han: count(s, /[一-鿿㐀-䶿]/g),
        hangul: count(s, /[가-힯]/g),
        arabic: count(s, /[؀-ۿ]/g),
        hebrew: count(s, /[֐-׿]/g),
        deva: count(s, /[ऀ-ॿ]/g),
        greek: count(s, /[Ͱ-Ͽ]/g),
    };
    const total = letters.length;
    const dominant = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
    if (dominant[1] >= Math.max(2, total * 0.4)) {
        switch (dominant[0]) {
            case 'cyr': {
                if (/[іїєґ]/.test(s) && !/[ыэё]/.test(s)) return 'uk';
                if (/[ђћљњџ]/.test(s)) return 'sr';
                if (/[ыэё]/.test(s)) return 'ru';
                const h = hint?.code;
                return h === 'uk' || h === 'bg' || h === 'sr' ? h : 'ru';
            }
            case 'kana': return 'ja';
            case 'han': return n.kana > 0 || hint?.code === 'ja' ? 'ja' : 'zh';
            case 'hangul': return 'ko';
            case 'arabic': return 'ar';
            case 'hebrew': return 'he';
            case 'deva': return 'hi';
            case 'greek': return 'el';
        }
    }

    const words = s.match(/\p{L}+/gu) || [];
    const scores = [];
    for (const [code, set] of Object.entries(LATIN_SETS)) {
        let score = 0;
        for (const w of words) if (set.has(w)) score += 1;
        const re = LATIN_LETTERS[code];
        if (re) score += 2 * count(s, re);
        if (score > 0) scores.push([code, score]);
    }
    scores.sort((a, b) => b[1] - a[1]);
    if (!scores.length || scores[0][1] < 2) return null;
    if (scores[1] && scores[0][1] - scores[1][1] < 1) return null;
    return scores[0][0];
}

/** The first language of an Accept-Language header that the catalog knows. The
 *  dialog hands it `navigator.languages`, which is what the browser sends. */
export function languageFromAcceptHeader(header) {
    const parts = String(header || '').split(',')
        .map(p => {
            const [tag, ...params] = p.trim().split(';');
            const q = params.map(x => x.trim()).find(x => x.startsWith('q='));
            return { tag: tag.trim().toLowerCase(), q: q ? Number(q.slice(2)) || 0 : 1 };
        })
        .filter(p => p.tag && p.tag !== '*')
        .sort((a, b) => b.q - a.q);
    for (const { tag } of parts) {
        const base = tag.split('-')[0];
        const code = base === 'no' ? 'nb' : base;
        const lang = catalogLanguage(code);
        if (lang) return lang;
    }
    return null;
}

/**
 * The content language a NEW AI project is created in, with where it came from.
 *
 *   explicit  the learner picked one in the form
 *   written   the language the description (else the name) is written in
 *   files     the language the learner's files are written in, when the
 *             course is built from files and the learner typed nothing telling
 *   interface the app's own language, which the learner reads for hours
 *   default   English
 *
 * `uiLanguage` is a catalog entry or null. The result is always a catalog
 * language, so it can be stored and handed to every prompt as-is. The files
 * arrive as `sourceSample` (their text, on the server) or as `filesLanguage`
 * (a code the server already read off them, in the dialog).
 *
 * `learning` is the code of the language the name or goal says the course
 * TEACHES (learningLanguage.js), or null. Such a course is not explained in
 * the language it teaches: "Learn Dutch" over a Dutch book would otherwise be
 * explained in the book's Dutch, and "I want to learn English…" typed in
 * English in the English being learned. So the written and the files' steps
 * skip it; the interface language may still be it, because the learner reads
 * the app in it.
 *
 * @typedef {{ code: string, name: string, endonym: string, scripts: string[] }} CatalogLanguage
 * @param {{ explicit?: string, name?: string, description?: string, sourceSample?: string,
 *     filesLanguage?: string | null, uiLanguage?: CatalogLanguage | null, learning?: string | null }} [options]
 * @returns {{ code: string, lang: CatalogLanguage, source: 'explicit' | 'written' | 'files' | 'interface' | 'default' }}
 */
export function resolveCreationLanguage({ explicit = '', name = '', description = '', sourceSample = '', filesLanguage = null, uiLanguage = null, learning = null } = {}) {
    if (explicit && BY_CODE.has(explicit)) {
        const lang = catalogLanguage(explicit);
        if (lang) return { code: lang.code, lang, source: 'explicit' };
    }
    const other = (code) => (code && code !== learning ? code : null);
    const written = other(detectWrittenLanguage(description, uiLanguage)) || other(detectWrittenLanguage(name, uiLanguage));
    if (written) {
        const lang = catalogLanguage(written);
        if (lang) return { code: lang.code, lang, source: 'written' };
    }
    const fromFiles = sourceSample ? other(detectWrittenLanguage(sourceSample, uiLanguage)) : other(filesLanguage);
    if (fromFiles) {
        const lang = catalogLanguage(fromFiles);
        if (lang) return { code: lang.code, lang, source: 'files' };
    }
    if (uiLanguage) return { code: uiLanguage.code, lang: uiLanguage, source: 'interface' };
    const en = catalogLanguage('en');
    return { code: en.code, lang: en, source: 'default' };
}
