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

/** The languages of an Accept-Language header that the catalog knows, most
 *  preferred first, each once. The dialog hands it `navigator.languages`, which
 *  is what the browser sends. */
export function languagesFromAcceptHeader(header) {
    const parts = String(header || '').split(',')
        .map(p => {
            const [tag, ...params] = p.trim().split(';');
            const q = params.map(x => x.trim()).find(x => x.startsWith('q='));
            return { tag: tag.trim().toLowerCase(), q: q ? Number(q.slice(2)) || 0 : 1 };
        })
        .filter(p => p.tag && p.tag !== '*')
        .sort((a, b) => b.q - a.q);
    const out = [];
    for (const { tag } of parts) {
        const base = tag.split('-')[0];
        const lang = catalogLanguage(base === 'no' ? 'nb' : base);
        if (lang && !out.includes(lang)) out.push(lang);
    }
    return out;
}

/** The first language of an Accept-Language header that the catalog knows. */
export function languageFromAcceptHeader(header) {
    return languagesFromAcceptHeader(header)[0] || null;
}

/**
 * The name as the LEARNER typed it, or '' when it is one of their files' own
 * titles: the dialog fills the Name field from a file, and a Dutch book's title
 * says which language the book is in, not which one its reader writes.
 */
export function typedName(name, fileTitles = []) {
    const norm = (s) => String(s || '').trim().toLowerCase();
    const n = norm(name);
    return n && fileTitles.some(t => norm(t) === n) ? '' : String(name || '');
}

/** How much of the profile is read for its language: enough for a paragraph. */
const PROFILE_SAMPLE_CHARS = 4000;

/**
 * The content language a NEW AI project is created in, with where it came from.
 *
 *   explicit  the learner picked one in the form
 *   written   the language the description (else the name) is written in
 *   files     the language the learner's files are written in, when the
 *             course is built from files and the learner typed nothing telling
 *   interface the app's own language, which the learner reads for hours
 *   profile   the language the learner's profile is written in, when it is
 *             the only thing that names a language
 *   default   English
 *
 * The result is always a catalog language, so it can be stored and handed to
 * every prompt as-is. The files arrive as `sourceSample` (their text, on the
 * server) or as `filesLanguage` (a code the server already read off them, in
 * the dialog).
 *
 * `learning` is the code of the language the name or goal says the course
 * TEACHES (learningLanguage.js), or null. Such a course is not explained in
 * the language it teaches: "Learn Dutch" over a Dutch book would otherwise be
 * explained in the book's Dutch, and "I want to learn English…" typed in
 * English in the English being learned. So the written, profile and files'
 * signals skip it; the app's and the browser's may still be it, because the
 * learner reads the app in it.
 *
 * WHOSE LANGUAGE. A course on Automatic is explained in the learner's own
 * language, and four things say which that is, strongest first: what they
 * typed, the app language they CHOSE (`appLanguage`, null while it follows
 * the browser), their browser's (`browserLanguages`, its first one), and the
 * language their profile is written in (`profile`, Settings → About you) —
 * last, because a profile is often written in English by habit. Files say
 * what is being studied, not who studies it, so a Dutch
 * textbook read by a Russian speaker is explained in Russian — but a subject
 * can be taken IN the files' language (a Dutch physics class), so they stay a
 * candidate. When the signals and the files name more than one language,
 * `candidates` lists them strongest first, each with the signals that named
 * it, for the identity call to choose from (projectIdentity.js); `code` is
 * then the answer without a choice, which is the fixed order this function
 * always had (typed, files, interface, English), so an unanswered question
 * leaves a course exactly as it was. One language, or none: `candidates` is
 * empty and `code` is the answer.
 *
 * `uiLanguage` is the language the app is shown in (the chosen one, else the
 * browser's first). A caller that knows the two apart passes `appLanguage`
 * and `browserLanguages`; one that passes only `uiLanguage` gets it as the
 * app's language.
 *
 * @typedef {{ code: string, name: string, endonym: string, scripts: string[] }} CatalogLanguage
 * @typedef {'typed' | 'profile' | 'app' | 'browser' | 'files'} LanguageSignal
 * @param {{ explicit?: string, name?: string, description?: string, sourceSample?: string,
 *     filesLanguage?: string | null, uiLanguage?: CatalogLanguage | null, learning?: string | null,
 *     appLanguage?: CatalogLanguage | null, browserLanguages?: CatalogLanguage[], profile?: string }} [options]
 * @returns {{ code: string, lang: CatalogLanguage,
 *     source: 'explicit' | 'written' | 'files' | 'interface' | 'profile' | 'default',
 *     candidates: { code: string, lang: CatalogLanguage, signals: LanguageSignal[] }[],
 *     signals: { typed: string|null, profile: string|null, app: string|null, browser: string[], files: string|null } }}
 */
export function resolveCreationLanguage({
    explicit = '', name = '', description = '', sourceSample = '', filesLanguage = null, uiLanguage = null, learning = null,
    appLanguage = undefined, browserLanguages = [], profile = '',
} = {}) {
    const app = appLanguage === undefined ? uiLanguage : appLanguage;
    const browser = (browserLanguages || []).filter(Boolean);
    const shown = uiLanguage || app || browser[0] || null;
    const other = (code) => (code && code !== learning ? code : null);
    const typed = other(detectWrittenLanguage(description, shown)) || other(detectWrittenLanguage(name, shown));
    const files = sourceSample ? other(detectWrittenLanguage(sourceSample, shown)) : other(filesLanguage);
    const profileCode = other(detectWrittenLanguage(String(profile || '').slice(0, PROFILE_SAMPLE_CHARS), shown));
    const signals = { typed, profile: profileCode, app: app?.code || null, browser: browser.slice(0, 3).map(l => l.code), files };
    const answer = (code, source, candidates = []) => {
        const lang = catalogLanguage(code);
        return { code: lang.code, lang, source, candidates, signals };
    };

    if (explicit && BY_CODE.has(explicit)) return answer(explicit, 'explicit');

    const ranked = [];
    for (const [signal, code] of [['typed', typed], ['app', app?.code], ['browser', browser[0]?.code], ['profile', profileCode], ['files', files]]) {
        if (!code || !BY_CODE.has(code)) continue;
        const had = ranked.find(c => c.code === code);
        if (had) had.signals.push(signal);
        else ranked.push({ code, lang: catalogLanguage(code), signals: [signal] });
    }
    // The fixed order, with the profile last: it names the answer only when
    // nothing else names a language (the app's and the browser's are among the
    // candidates whenever `shown` is, so with one candidate this IS that one).
    const candidates = ranked.length > 1 ? ranked : [];
    if (typed) return answer(typed, 'written', candidates);
    if (files) return answer(files, 'files', candidates);
    if (shown) return answer(shown.code, 'interface', candidates);
    if (profileCode) return answer(profileCode, 'profile', candidates);
    return answer('en', 'default', candidates);
}
