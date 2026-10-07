/**
 * Which language a new course TEACHES, when the learner's own words say so.
 *
 * A course has one language its lessons are written in (`content_language`).
 * A course that teaches a language has a second one, the language being
 * learned, and it is never a field the learner fills (2026-10-06): Dutch files
 * under a course explained in Russian mean Dutch learned by a Russian speaker,
 * and a goal like "I want to learn Dutch to be able to hold a conversation"
 * says it outright. This module is that second half: a fixed rule over the
 * name and the goal. The first half (files in another language, confirmed by
 * the identity call) is in projectIdentity.js and routes/createProject.js.
 *
 * No database and no model, so the New course dialog imports it too and its
 * "Automatic" option says the same thing the server will do.
 *
 * PRECISION OVER RECALL. A language is NAMED as being learned only when the
 * words around it say so: a learning verb ("learn Dutch", "Deutsch lernen",
 * "выучить нидерландский"), a level or an exam ("Nederlands A2", "Japanese
 * N3", "ЕГЭ по английскому"), a word for the language or its parts ("Dutch
 * grammar", "английский язык"), "for beginners", or the name being the
 * language alone. Everything else that names a language ("Dutch history",
 * "Learn French cooking") is only MENTIONED, and a mention is a question for
 * the model, never an answer: a wrong "this teaches Dutch" would keep Dutch
 * words untranslated in a history course, so a miss is the cheaper error.
 */
import { LANGUAGES } from './languageCatalog.js';

const CODES = LANGUAGES.map(l => l.code);

// Names a language goes by, as [name, the language that name is written in].
// `Intl.DisplayNames` gives every catalog language's name in every catalog
// language ("нидерландский", "Niederländisch", "オランダ語"); these are the
// other names people type.
const SYNONYMS = {
    nl: [['flemish', 'en'], ['vlaams', 'nl'], ['hollands', 'nl'], ['holländisch', 'de'], ['hollandais', 'fr'], ['holandés', 'es'],
        ['holenderski', 'pl'], ['голландский', 'ru'], ['голландська', 'uk']],
    zh: [['mandarin', 'en'], ['putonghua', 'en'], ['普通话', 'zh'], ['汉语', 'zh'], ['漢語', 'zh'], ['华语', 'zh'], ['中国語', 'ja']],
    nb: [['norsk', 'nb'], ['норвежский', 'ru'], ['норвезька', 'uk']],
    sr: [['srpski', 'sr']],
    ja: [['nihongo', 'en']],
};

// How a name bends in a sentence, by the language it is written in. Slavic,
// Romanian, Hungarian, Finnish, Turkish and Greek decline it ("по-английски",
// "нидерландскому", "po niderlandzku"), so it is matched by its stem; Germanic
// and Romance add an agreement ending at most ("Nederlandse", "française");
// an English name is exact.
const DECLINES = new Set(['ru', 'uk', 'pl', 'cs', 'bg', 'sr', 'ro', 'hu', 'fi', 'tr', 'el']);
const AGREES = new Set(['nl', 'de', 'fr', 'es', 'it', 'pt', 'sv', 'da', 'nb']);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const EXACT = new Map();   // name -> code, null when two languages share it
const STEMS = new Map();   // stem -> { code, max } (letters allowed after it)
const CJK_NAMES = [];      // [name, code], longest first: matched inside a run of text

function addName(raw, code, locale) {
    const lower = String(raw || '').toLowerCase().normalize('NFC');
    if (!lower) return;
    if (CJK.test(lower)) {
        const name = lower.replace(/[\s()（）]/g, '');
        if (name.length >= 2) CJK_NAMES.push([name, code]);
        put(EXACT, name, code);
        return;
    }
    // "Norwegian Bokmål", "Noors - Bokmål": the first word is the name.
    const word = lower.match(/[\p{L}\p{M}]+/u)?.[0];
    if (!word || word.length < 4) return;
    put(EXACT, word, code);
    if (DECLINES.has(locale) && word.length >= 7) put(STEMS, word.slice(0, -2), { code, max: 4 });
    else if (AGREES.has(locale)) put(STEMS, word, { code, max: 2 });
}
function put(map, key, value) {
    const code = typeof value === 'string' ? value : value.code;
    if (!map.has(key)) { map.set(key, value); return; }
    const had = map.get(key);
    const hadCode = had && typeof had === 'object' ? had.code : had;
    if (hadCode !== code) map.set(key, null);
}

for (const lang of LANGUAGES) {
    addName(lang.name, lang.code, 'en');
    addName(lang.endonym, lang.code, lang.code);
    for (const locale of CODES) {
        let name = null;
        try { name = new Intl.DisplayNames([locale], { type: 'language' }).of(lang.code === 'nb' ? 'no' : lang.code); } catch { /* an engine without the data */ }
        if (name && name !== lang.code && name !== (lang.code === 'nb' ? 'no' : lang.code)) addName(name, lang.code, locale);
    }
    for (const [name, locale] of SYNONYMS[lang.code] || []) addName(name, lang.code, locale);
}
CJK_NAMES.sort((a, b) => b[1].length - a[1].length || b[0].length - a[0].length);

const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

/** Verbs of learning a language. "Speak" is not one: "I speak Russian" is who
 *  the learner is, so it only counts behind a verb that is ("learn to speak"). */
const VERBS = set(`
    learn learning learnt learned study studying studied practise practice practising practicing improve improving
    master mastering relearn refresh brush revise revising
    leer leren leert oefen oefenen verbeteren studeren beheersen
    lerne lernen lernt üben verbessern studieren auffrischen
    apprendre apprends apprend étudier pratiquer améliorer perfectionner réviser
    aprender aprendo estudiar practicar mejorar perfeccionar repasar
    imparare studiare praticare migliorare ripassare
    estudar praticar melhorar aperfeiçoar
    uczyć nauczyć uczę poprawić ćwiczyć opanować
    învăța învăț studia exersa
    учить учу выучить выучу изучать изучаю изучить изучение изучения освоить подтянуть научиться учиться практиковать улучшить
    вчити вчу вивчити вивчати вивчаю вивчення опанувати навчитися покращити
    učit naučit studovat lära plugga lære öğrenmek öğrenmeyi tanulni megtanulni oppia opiskella μάθω μαθαίνω
`);
/** Words allowed between a verb and the language, at most two ("learn to speak
 *  Dutch", "apprendre le néerlandais", "научиться говорить на нидерландском"). */
const FILLERS = set(`
    to the a an some basic more better my our conversational spoken business everyday little bit up on speak speaking talk read write understand
    te het de wat beter mijn spreken praten lezen
    zu die das etwas mehr besser mein sprechen
    le la les l du mon ma parler lire
    el los mi hablar leer más mejor
    il lo mio parlare leggere
    o meu minha falar ler
    się po mówić czytać
    să vorbi limba
    на по свой мой говорить разговаривать читать разговорный
    мою свою говорити
    se mluvit
`);
/** A word for the language itself or a part of it: right after the name
 *  ("Dutch grammar", "английский язык") it says the language is the subject. */
const CUE_NOUNS = set(`
    language languages grammar vocabulary vocab conversation conversations pronunciation lesson lessons course class classes tutor
    words phrases verbs idioms slang alphabet kanji hiragana katakana speaking listening writing reading exam test
    taal grammatica woordenschat woorden uitspraak conversatie les lessen cursus examen spreekvaardigheid luisteren schrijven
    sprache grammatik wortschatz vokabeln aussprache konversation kurs unterricht prüfung
    langue grammaire vocabulaire prononciation cours
    idioma lengua gramática vocabulario conversación pronunciación curso clases
    lingua vocabolario conversazione pronuncia corso esame
    língua vocabulário conversação pronúncia exame
    język języka gramatyka słownictwo konwersacje wymowa egzamin
    limbă gramatica gramatică vocabular curs
    язык языка языку языком языке грамматика грамматики лексика слова произношение курс курсы уроки урок экзамен разговорник
    мова мови мову граматика вимова курси іспит
    jazyk språk sprog dil dili nyelv kieli γλώσσα
`);
/** The same words where they come BEFORE the name ("langue française",
 *  "курс английского", "cours d'anglais"). English is not among them:
 *  "Physics course English" is not a language course. */
const CUE_BEFORE = set(`
    langue cours idioma lengua curso lingua corso língua język języka kurs limba limbă
    курс курсы уроки урок грамматика лексика мова курси уроки граматика jazyk
`);
const LINKS = set('de d di do da du of по з z');
/** A dictionary of a language is about the language, whichever side it is on
 *  ("A Frequency Dictionary of Dutch", "Dutch dictionary", "словарь английского"). */
const DICTIONARY = set('dictionary woordenboek wörterbuch dictionnaire diccionario dizionario dicionário słownik словарь словник slovník');
/**
 * An exam that belongs to ONE language names it: "IELTS Academic" is English.
 * Not the school-leaving exams that cover every subject (ЕГЭ, ЗНО,
 * staatsexamen), and not Goethe, who is also a poet.
 */
const EXAM_LANGUAGE = {
    ielts: 'en', toefl: 'en', toeic: 'en', fce: 'en', cae: 'en', cpe: 'en',
    jlpt: 'ja', hsk: 'zh', topik: 'ko',
    delf: 'fr', dalf: 'fr', tcf: 'fr', tef: 'fr',
    dele: 'es', siele: 'es',
    testdaf: 'de',
    nt2: 'nl', inburgering: 'nl', inburgeringsexamen: 'nl',
    celi: 'it', cils: 'it', plida: 'it',
    torfl: 'ru', трки: 'ru', ткри: 'ru',
};
const LEVEL = /^(?:[abc][12]|n[1-5]|hsk[1-9]?|topik|jlpt|ielts|toefl|toeic|delf|dalf|dele|siele|goethe|testdaf|telc|nt2|inburgering|inburgeringsexamen|staatsexamen|celi|cils|plida|tcf|tef|fce|cae|cpe|егэ|огэ|зно|нмт|торфл|трки)$/;
const CJK_LEVEL = /(?:^|[^a-z0-9])(?:n[1-5]|hsk ?[1-9]|jlpt|topik|[abc][12])(?![a-z0-9])/;
const CJK_CUE = /学|勉強|習|会話|会话|入門|入门|初級|初级|中級|中级|上級|高级|文法|语法|単語|单词|口语|能力試験|検定|课程|練習|练习|공부|배우|회화|문법|단어|시험/u;
/** "Dutch for beginners", "Нидерландский для русскоговорящих". */
const FOR_WORDS = set('for voor für pour para per dla для pentru för');
const CONJ = set('and or en of und oder et ou y o e i и или та і й a și sau och eller og');
/** What may follow "learn Dutch" for it to still be about Dutch: the clause
 *  ends, or it goes on with a purpose, a time, a manner — not with a noun
 *  ("learn French cooking"). */
const FOLLOW = set(`
    to for and or so in at with by before because as while within until quickly fast fluently properly well better online now again myself too also from this next every daily
    om voor en of met binnen snel goed vloeiend zodat want op
    um für und oder mit bis schnell gut besser fließend weil
    pour et ou en avec avant rapidement couramment bien mieux afin
    para y en con antes rápido rápidamente mejor
    per e con bene meglio
    em com bem melhor
    aby żeby w z do dobrze
    pentru și în cu bine
    чтобы для и или за до к в с на по быстро хорошо свободно самостоятельно уровня уровень
    щоб і та швидко добре
`);

/** Words with a flag: does a clause break (punctuation) come before this one? */
function tokenize(text) {
    const s = String(text || '').toLowerCase().normalize('NFC');
    const out = [];
    let end = 0;
    for (const m of s.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
        const gap = s.slice(end, m.index);
        out.push({ t: m[0], brk: out.length === 0 || /[.,;:!?()[\]{}"«»“”\n—–|]/.test(gap) });
        end = m.index + m[0].length;
    }
    return out;
}

/** The catalog language a word names, or null. */
function languageOf(word) {
    if (EXACT.has(word)) return EXACT.get(word);
    for (let cut = 1; cut <= 4 && word.length - cut >= 4; cut++) {
        const stem = STEMS.get(word.slice(0, word.length - cut));
        if (stem && cut <= stem.max) return stem.code;
    }
    return null;
}

const isNumber = (w) => /^\p{N}+$/u.test(w);

/** The rule over ONE field: the languages it names as being learned, and every language it names. */
function readField(text) {
    const toks = tokenize(text);
    const codes = toks.map(x => languageOf(x.t));
    const strong = new Set();
    const named = [];
    const at = (k) => (k >= 0 && k < toks.length ? toks[k].t : null);
    const joined = (k) => k > 0 && k < toks.length && !toks[k].brk; // no break between k-1 and k

    for (const { t } of toks) {
        // "nt2" whole, "hsk4" without its level.
        const exam = EXAM_LANGUAGE[t] ?? EXAM_LANGUAGE[t.replace(/\d+$/, '')];
        if (!exam) continue;
        strong.add(exam);
        if (!named.includes(exam)) named.push(exam);
    }

    codes.forEach((code, i) => {
        if (!code) return;
        if (!named.includes(code)) named.push(code);

        // A level or an exam beside it: "Nederlands A2", "IELTS English", "ЕГЭ по английскому".
        if ((joined(i + 1) && LEVEL.test(at(i + 1)))
            || (joined(i + 1) && joined(i + 2) && CUE_NOUNS.has(at(i + 1)) && LEVEL.test(at(i + 2)))
            || (joined(i) && LEVEL.test(at(i - 1)))
            || (joined(i) && joined(i - 1) && LINKS.has(at(i - 1)) && LEVEL.test(at(i - 2)))) strong.add(code);

        // A word for the language or a part of it: "Dutch grammar", "langue française", "cours d'anglais".
        if ((joined(i + 1) && (CUE_NOUNS.has(at(i + 1)) || DICTIONARY.has(at(i + 1))))
            || (joined(i) && (CUE_BEFORE.has(at(i - 1)) || DICTIONARY.has(at(i - 1))))
            || (joined(i) && joined(i - 1) && LINKS.has(at(i - 1)) && DICTIONARY.has(at(i - 2)))
            || (joined(i) && joined(i - 1) && LINKS.has(at(i - 1)) && CUE_BEFORE.has(at(i - 2)))) strong.add(code);

        // The verb after it: "Nederlands leren", "Deutsch zu lernen".
        if ((joined(i + 1) && VERBS.has(at(i + 1)))
            || (joined(i + 1) && joined(i + 2) && ['te', 'zu', 'to'].includes(at(i + 1)) && VERBS.has(at(i + 2)))) strong.add(code);

        // The verb before it, then nothing that makes it another subject.
        let k = i - 1, fillers = 0, verb = false;
        while (k >= 0 && joined(k + 1)) {
            const w = at(k);
            if (VERBS.has(w)) { verb = true; break; }
            if (FILLERS.has(w) && fillers < 2) { fillers++; k--; continue; }
            // "learn Dutch and German": German's verb is Dutch's.
            if (CONJ.has(w) && k > 0 && codes[k - 1] && joined(k)) { k -= 2; continue; }
            break;
        }
        if (verb) {
            let n = i + 1;
            while (joined(n) && CONJ.has(at(n)) && codes[n + 1] && joined(n + 1)) n += 2;
            const next = at(n);
            if (next === null || toks[n].brk || FOLLOW.has(next) || CUE_NOUNS.has(next) || LEVEL.test(next)
                || VERBS.has(next) || FOR_WORDS.has(next) || isNumber(next)) strong.add(code);
        }

        // The field opens with it and says who it is for: "Dutch for beginners".
        const opens = toks.slice(0, i).every(x => FILLERS.has(x.t));
        if (opens && joined(i + 1) && FOR_WORDS.has(at(i + 1))) strong.add(code);
    });

    // The field is the language and nothing else: "Dutch", "Japanese N3", "Английский язык".
    const rest = toks.filter(x => !LEVEL.test(x.t) && !CUE_NOUNS.has(x.t) && !FILLERS.has(x.t) && !isNumber(x.t));
    if (rest.length === 1 && codes[toks.indexOf(rest[0])]) strong.add(codes[toks.indexOf(rest[0])]);

    // Chinese, Japanese and Korean write no spaces between words, so a name is
    // found inside a run ("オランダ語の勉強"), with a learning word or a level
    // anywhere in the same field.
    const flat = String(text || '').toLowerCase().normalize('NFC');
    for (const [name, code] of CJK_NAMES) {
        if (!flat.includes(name)) continue;
        if (!named.includes(code)) named.push(code);
        const bare = flat.replace(/\s+/g, '').replace(new RegExp(CJK_LEVEL.source, 'g'), '');
        if (CJK_CUE.test(flat) || CJK_LEVEL.test(flat) || bare === name) strong.add(code);
    }
    return { strong, named };
}

/**
 * The language a new course's name and goal say is being LEARNED, and every
 * other catalog language they name.
 *
 *   named      a catalog code, or null. Null when no language is named as
 *              being learned, and when two are ("Learn Dutch and German"):
 *              the rule does not choose between them.
 *   mentioned  the other languages named, in the order they appear — the
 *              candidates the identity call may confirm. Never holds `named`.
 *
 * @param {{ name?: string, description?: string }} [fields]
 * @returns {{ named: string|null, mentioned: string[] }}
 */
export function findLearningLanguage({ name = '', description = '' } = {}) {
    const strong = new Set();
    const all = [];
    for (const field of [name, description]) {
        const r = readField(field);
        r.strong.forEach(c => strong.add(c));
        r.named.forEach(c => { if (!all.includes(c)) all.push(c); });
    }
    const named = strong.size === 1 ? [...strong][0] : null;
    return { named, mentioned: all.filter(c => c !== named) };
}
