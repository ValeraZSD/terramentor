import db from './database.js';

/**
 * The project's declared content language.
 *
 * Content generation was ALREADY multilingual before this file existed: every
 * authoring prompt told the model to "write in the same language as the topic
 * and its Overview". That works, but it is inference — the model decides, from
 * whatever the title happened to be written in, and nothing downstream knows
 * what it decided. Every quality gate that reads text (`feedQuality.js`, the
 * vision-refusal guard in `paper.js`) was written against English and silently
 * stops working when the model picks something else.
 *
 * So the language becomes DECLARED state on the project. Two things follow:
 * the authoring prompts get an unambiguous instruction instead of a hint, and
 * the gates get something to check AGAINST. An empty/absent value keeps the old
 * inference behaviour exactly, so existing projects are unchanged.
 */

// Scripts whose appearance in a lesson is leakage rather than content, unless
// the project's declared language uses them (or its own material does — see
// `nodeScriptReference` in feedQuality.js). Greek is deliberately absent: λ, θ,
// Δ are ordinary notation in every subject that has notation.
export const SCRIPTS = [
    { name: 'Han', re: /[一-鿿㐀-䶿]/ },
    { name: 'Kana', re: /[぀-ヿ]/ },
    { name: 'Hangul', re: /[가-힯]/ },
    { name: 'Cyrillic', re: /[Ѐ-ӿ]/ },
    { name: 'Arabic', re: /[؀-ۿ]/ },
    { name: 'Hebrew', re: /[֐-׿]/ },
    { name: 'Devanagari', re: /[ऀ-ॿ]/ },
];

/**
 * Wrap alternatives in Unicode-aware word boundaries.
 *
 * `\b` is defined against `\w`, which is ASCII — so `\bви\b` matches at every
 * position inside a Cyrillic word, and `\błatwo` can never match at all. Every
 * boundary here has to be a letter-property lookaround instead.
 */
const w = (src, flags = 'iu') => new RegExp(`(?<!\\p{L})(?:${src})(?!\\p{L})`, flags);

/**
 * A closing sentence that certifies the learner instead of teaching them.
 *
 * `closer` is anchored at the start of the final paragraph; `learnerRef`
 * requires that paragraph to actually be ABOUT the learner, which is what keeps
 * a legitimate final paragraph that merely opens with the same words. Both must
 * hit before anything is deleted — see `stripSelfCertifyingCloser`.
 *
 * `learnerRef` cannot be a pronoun list alone. Spanish, Italian, Portuguese,
 * Polish and Romanian are pro-drop: "Ahora puedes calcular…" is second person
 * with no pronoun anywhere in the sentence, so a pronoun-only test silently
 * never fires and the closer gate is dead for those languages. The verb forms
 * carry the person and have to be listed too.
 *
 * A language with no patterns here is not a bug and must not be treated as one:
 * the gate declines to strip rather than guessing, because deleting real
 * teaching to enforce a style rule is far worse than leaving one closer
 * standing. Adding a language to this table is a pure improvement, never a
 * prerequisite for using it.
 *
 * `certify` (optional) is the SAME defect written as a subordinate clause, which
 * the anchored `closer` cannot see: "Mastering this visual scan ensures you can
 * bridge a diagram to a numerical answer" is rule-5 self-certification that
 * simply does not begin with "You can". It is tested UNANCHORED, so it is
 * narrowed hard to compensate — `stripSelfCertifyingCloser` only consults it for
 * a final paragraph of at most CERTIFY_MAX_SENTENCES sentences, on the reasoning
 * that a genuine closing argument that runs three sentences is teaching, while a
 * certification is always a flourish. Absent = that language keeps the anchored
 * check alone, which is the pre-existing behaviour.
 */
const CLOSERS = {
    en: {
        closer: /^(?:\*\*)?(?:(?:you (?:can|are|will|should|now)|now you|by (?:understanding|the end)|having (?:read|learned|seen)|congratulations|in summary|to summari[sz]e)\b|with (?:this|that)[,\s])/i,
        learnerRef: /\b(?:you|your|you'll|you've|you're)\b/i,
        certify: /\b(?:ensure[sd]?|mean[s]?|allow[s]?|enable[s]?|equip[s]?|guarantee[s]?|prepare[s]?|leave[s]?|let[s]?|give[s]?)\s+(?:that\s+)?you\b|\byou (?:are|will be|should be)\s+(?:now\s+)?(?:able|equipped|ready|prepared|confident)\b|\b(?:master(?:ing|y)|practi[sc]ing|understanding this|knowing this)\b[^.]{0,80}\byou\b/i,
    },
    nl: {
        closer: /^(?:\*\*)?(?:nu (?:kun|kunt|ben|bent|weet|weet je)|je (?:kunt|kan|bent) nu|u (?:kunt|bent) nu|hiermee|met deze kennis|samengevat|kortom|gefeliciteerd)/i,
        learnerRef: w('je|jij|jouw|jullie|u|uw'),
        certify: /\b(?:zorgt ervoor dat|betekent dat|stelt|maakt het mogelijk dat)\s+(?:je|jij|u)\b|\b(?:je|jij|u)\s+(?:bent|ben)\s+nu\s+(?:in staat|klaar)\b|\bdoor\s+(?:dit|deze)[^.]{0,60}\b(?:kun je|kunt u|ben je|bent u)\b/i,
    },
    de: {
        // "Sie" (formal you) is capitalised; lowercase "sie" is she/they and is
        // far too common to treat as a second-person reference.
        closer: /^(?:\*\*)?(?:(?:jetzt|nun) (?:kannst|können|kennst|kennen|weißt|wissen|bist|sind)|damit (?:kannst|können|bist|sind)|du (?:kannst|hast) (?:jetzt|nun)|zusammenfassend|kurz gesagt|herzlichen glückwunsch|mit diesem wissen)/i,
        learnerRef: new RegExp(`(?<!\\p{L})(?:du|dich|dir|dein\\p{L}*|euch|euer)(?!\\p{L})|(?<!\\p{L})(?:Sie|Ihnen|Ihre\\p{L}*)(?!\\p{L})`, 'u'),
    },
    fr: {
        closer: /^(?:\*\*)?(?:(?:vous|tu) (?:pouvez|peux|êtes|es|savez|sais|avez|as) (?:maintenant|désormais)|(?:maintenant|désormais),? (?:vous|tu)|grâce à (?:cela|ceci|ce)|avec (?:cela|ceci)|en résumé|pour résumer|félicitations)/i,
        learnerRef: w('vous|votre|vos|tu|te|ton|ta|tes'),
    },
    es: {
        closer: /^(?:\*\*)?(?:(?:ahora|ya) (?:puedes|puede|pueden|sabes|sabe|eres|es|está[s]?)|con (?:esto|este conocimiento)|en resumen|para resumir|resumiendo|felicidades|enhorabuena)/i,
        learnerRef: w('tú|usted|ustedes|te|ti|tu|tus|vosotros|puedes|podrás|sabes|tienes|debes|estás|eres|conoces|verás|aprendiste'),
    },
    it: {
        closer: /^(?:\*\*)?(?:(?:ora|adesso) (?:puoi|può|sai|sa|sei|è|sei in grado)|con (?:questo|ciò)|in sintesi|riassumendo|per riassumere|complimenti)/i,
        learnerRef: w('tu|ti|tuo|tua|tuoi|tue|voi|puoi|potrai|sai|saprai|hai|devi|sei|conosci|vedrai|riuscirai'),
    },
    pt: {
        closer: /^(?:\*\*)?(?:(?:agora|já) (?:você|voce|podes|pode|pod[eu]m|sabes|sabe|é|és)|com (?:isso|este conhecimento)|em resumo|resumindo|parabéns)/i,
        learnerRef: w('você|voce|vocês|voces|tu|te|teu|tua|teus|tuas|podes|sabes|tens|deves|és|estás|consegues'),
    },
    pl: {
        closer: /^(?:\*\*)?(?:(?:teraz|już) (?:mo[żz]esz|potrafisz|wiesz|umiesz)|dzięki temu|podsumowując|w skrócie|gratulacje)/i,
        learnerRef: w('ty|ciebie|tobie|twój|twoja|twoje|twoim|twojej|mo[żz]esz|wiesz|potrafisz'),
    },
    ro: {
        closer: /^(?:\*\*)?(?:acum (?:po[țt]i|pute[țt]i|[șs]tii|[șs]ti[țt]i|e[șs]ti|sunte[țt]i)|cu (?:acestea|aceste cuno[șs]tin[țt]e)|în (?:concluzie|rezumat)|pe scurt|felicitări)/i,
        learnerRef: w('tu|tău|ta|tăi|tale|voi|vostru|voastră|po[țt]i|pute[țt]i|sunte[țt]i'),
    },
    uk: {
        closer: /^(?:\*\*)?(?:тепер (?:ви|ти)|(?:ви|ти) (?:можете|можеш|знаєте|знаєш)|завдяки цьому|підсумовуючи|отже,? (?:ви|ти)|вітаємо)/iu,
        learnerRef: w('ви|вам|вас|ваш\\p{L}*|ти|тобі|тво\\p{L}+|можете|знаєте'),
    },
    ru: {
        closer: /^(?:\*\*)?(?:теперь (?:вы|ты)|(?:вы|ты) (?:можете|можешь|знаете|знаешь)|благодаря этому|подводя итог|итак,? (?:вы|ты)|поздравляем)/iu,
        learnerRef: w('вы|вам|вас|ваш\\p{L}*|ты|тебе|тво\\p{L}+|можете|знаете'),
    },
};

/**
 * Selectable content languages.
 *
 * `scripts` lists the writing systems a lesson in this language is entitled to
 * use. `closerPatterns` presence is informational — the catalog is deliberately
 * wider than `CLOSERS`, because refusing to let someone study in Czech until
 * somebody writes a Czech regex would be the wrong trade.
 */
export const LANGUAGES = [
    { code: 'en', name: 'English', endonym: 'English', scripts: [] },
    { code: 'nl', name: 'Dutch', endonym: 'Nederlands', scripts: [] },
    { code: 'de', name: 'German', endonym: 'Deutsch', scripts: [] },
    { code: 'fr', name: 'French', endonym: 'Français', scripts: [] },
    { code: 'es', name: 'Spanish', endonym: 'Español', scripts: [] },
    { code: 'it', name: 'Italian', endonym: 'Italiano', scripts: [] },
    { code: 'pt', name: 'Portuguese', endonym: 'Português', scripts: [] },
    { code: 'pl', name: 'Polish', endonym: 'Polski', scripts: [] },
    { code: 'ro', name: 'Romanian', endonym: 'Română', scripts: [] },
    { code: 'uk', name: 'Ukrainian', endonym: 'Українська', scripts: ['Cyrillic'] },
    { code: 'ru', name: 'Russian', endonym: 'Русский', scripts: ['Cyrillic'] },
    { code: 'cs', name: 'Czech', endonym: 'Čeština', scripts: [] },
    { code: 'sv', name: 'Swedish', endonym: 'Svenska', scripts: [] },
    { code: 'da', name: 'Danish', endonym: 'Dansk', scripts: [] },
    { code: 'nb', name: 'Norwegian', endonym: 'Norsk', scripts: [] },
    { code: 'fi', name: 'Finnish', endonym: 'Suomi', scripts: [] },
    { code: 'hu', name: 'Hungarian', endonym: 'Magyar', scripts: [] },
    { code: 'el', name: 'Greek', endonym: 'Ελληνικά', scripts: [] },
    { code: 'tr', name: 'Turkish', endonym: 'Türkçe', scripts: [] },
    { code: 'bg', name: 'Bulgarian', endonym: 'Български', scripts: ['Cyrillic'] },
    { code: 'sr', name: 'Serbian', endonym: 'Српски', scripts: ['Cyrillic'] },
    { code: 'ja', name: 'Japanese', endonym: '日本語', scripts: ['Kana', 'Han'] },
    { code: 'zh', name: 'Chinese', endonym: '中文', scripts: ['Han'] },
    { code: 'ko', name: 'Korean', endonym: '한국어', scripts: ['Hangul'] },
    { code: 'ar', name: 'Arabic', endonym: 'العربية', scripts: ['Arabic'] },
    { code: 'he', name: 'Hebrew', endonym: 'עברית', scripts: ['Hebrew'] },
    { code: 'hi', name: 'Hindi', endonym: 'हिन्दी', scripts: ['Devanagari'] },
];

const BY_CODE = new Map(LANGUAGES.map(l => [l.code, l]));

export function isSupportedLanguage(code) {
    return typeof code === 'string' && (code === '' || BY_CODE.has(code));
}

export function getLanguage(code) {
    return BY_CODE.get(String(code || '').toLowerCase()) || null;
}

/**
 * Resolved language for a project, or null when it is unset ("follow the
 * material", the pre-existing behaviour).
 *
 * Cached because it is read on every lesson, question and gate call. The cache
 * is cleared explicitly when a project is updated — unlike the script-reference
 * cache next door, this value is user-editable at any moment and a stale one
 * would keep authoring in the old language for the rest of the process's life.
 */
const CACHE = new Map();

export function getProjectLanguage(projectId) {
    if (projectId == null) return null;
    if (CACHE.has(projectId)) return CACHE.get(projectId);
    let lang = null;
    try {
        const row = db.prepare('SELECT content_language FROM projects WHERE id = ?').get(projectId);
        lang = getLanguage(row?.content_language);
    } catch {
        lang = null;
    }
    CACHE.set(projectId, lang);
    return lang;
}

/**
 * The language the learner reads the INTERFACE in (`ui_language` setting).
 *
 * Deliberately separate from a project's `content_language`: someone can study
 * a Dutch physics course while reading the app in Ukrainian, and conflating the
 * two would either translate their material or leave the chrome in a language
 * they do not read. Empty/unset means English, which is what the untranslated
 * strings already are, so an install that never touches this is unaffected.
 */
export function getUiLanguage() {
    try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('ui_language');
        return getLanguage(row?.value) || null;
    } catch {
        return null;
    }
}

export function invalidateProjectLanguage(projectId) {
    if (projectId == null) CACHE.clear();
    else CACHE.delete(Number(projectId));
}

export function getNodeLanguage(nodeId) {
    try {
        const row = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
        return getProjectLanguage(row?.project_id);
    } catch {
        return null;
    }
}

/**
 * The instruction handed to an authoring prompt.
 *
 * When the project declares a language this is an order; when it does not, it
 * is the original "follow the material" hint, kept word-for-word so unset
 * projects generate exactly what they generated before.
 */
export function languageDirective(lang) {
    if (!lang) {
        return 'Write in the same language as the topic and its Overview, and stay in that language for every word — including inside visuals. A single word from another language is a defect.';
    }
    return `Write EVERY word in ${lang.name} (${lang.endonym}) — this project is studied in ${lang.name}, regardless of what language these instructions are written in. That includes headings, worked examples, labels inside visuals, and the explanation. Established technical terms and proper nouns keep their standard form in the field; everything else is ${lang.name}. Do not translate the topic title back into English, and never switch language part-way.`;
}

/** Same directive, phrased for a grader/checker rather than an author. */
export function languageDirectiveForResponse(lang) {
    if (!lang) return 'Reply in the same language as the material you were given.';
    return `Reply in ${lang.name} (${lang.endonym}).`;
}

/** Scripts this language legitimately writes in. */
export function nativeScripts(lang) {
    return new Set(lang?.scripts || []);
}

export function closerPatterns(lang) {
    return (lang && CLOSERS[lang.code]) || null;
}

/**
 * High-frequency English function words used to detect a lesson that drifted
 * back into English.
 *
 * This is the failure mode that no other gate can see: a model asked for Polish
 * reverting to its dominant training language mid-lesson produces text in the
 * SAME script, so the script check passes it untouched, and seven of the ten
 * most-spoken European languages are Latin-script.
 *
 * Every word here was checked for collisions against the other catalog
 * languages and the colliding ones are deliberately absent: "of"/"was" (Dutch),
 * "are" (Romanian: has), "but" (French: goal), "will"/"was" (German), "is"
 * (Dutch/German), "in"/"to"/"no" (shared by most).
 */
const ENGLISH_MARKERS = new Set([
    'the', 'and', 'that', 'with', 'this', 'which', 'from', 'when', 'for', 'you',
    'your', 'they', 'have', 'has', 'been', 'not', 'can', 'would', 'should',
    'there', 'these', 'than', 'then', 'into', 'more', 'also', 'about', 'because',
    'between', 'each', 'other', 'through', 'first', 'both', 'such', 'only',
    'very', 'most', 'while', 'where', 'after', 'before', 'same', 'them', 'what',
]);

const MIN_DRIFT_WORDS = 60;
const DRIFT_RATIO = 0.08;

/**
 * Strip everything that is legitimately English inside a non-English lesson —
 * code, identifiers, formulas, visual specs — so only prose is measured. A
 * lesson about `useState` in Dutch is not drifting.
 */
function proseOnly(text) {
    return String(text || '')
        .replace(/^```[\s\S]*?^```/gm, ' ')   // fenced blocks: code, drills, visual specs
        .replace(/`[^`\n]*`/g, ' ')           // inline code
        .replace(/\$\$[\s\S]*?\$\$/g, ' ')    // display math
        .replace(/\$[^$\n]*\$/g, ' ')         // inline math
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // link targets, keep the label
}

/**
 * Fraction of prose word tokens that are English function words. Returns 0 for
 * a sample too short to judge — a 30-word segment can be dominated by a quoted
 * English term by accident.
 */
export function englishDriftRatio(text) {
    const words = proseOnly(text).toLowerCase().match(/\p{L}+/gu) || [];
    if (words.length < MIN_DRIFT_WORDS) return 0;
    let hits = 0;
    for (const word of words) if (ENGLISH_MARKERS.has(word)) hits++;
    return hits / words.length;
}

/** True when a lesson declared to be in `lang` reads as English instead. */
export function driftedToEnglish(text, lang) {
    if (!lang || lang.code === 'en') return false;
    return englishDriftRatio(text) >= DRIFT_RATIO;
}
