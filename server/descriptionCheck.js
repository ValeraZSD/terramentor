/**
 * The gate a model's picture description passes before it is stored.
 *
 * A stored description is read aloud as the picture's alt text and handed to
 * the tutor as what the picture shows (`mediaDescribe.js`). A model can answer
 * the request with something that is worse than no description:
 *
 *   * a refusal ("I'm sorry, I can't see images"): a text-only model behind an
 *     endpoint that says it reads pictures;
 *   * a description that names the kind of picture and nothing in it ("A bar
 *     chart.", "An image of something."): the listener learns only that there
 *     is a picture, which the screen reader already said;
 *   * the wrong language: a Dutch card read out with an English description in
 *     the Dutch voice its `lang` picks.
 *
 * Each of these is refused with its reason and nothing is written, so the
 * picture stays pending and keeps its filename as alt until a better answer
 * comes. No database and no model: `checkDescription` is a pure function of
 * the text and the language asked for.
 *
 * Precision over recall. A short honest description ("A cat", "A die", "Une
 * montre") passes; only a text with NOTHING in it but picture-kind words of one
 * language fails. The language check refuses the one mistake a model makes when
 * it ignores the instruction, English instead of the course's language, and a
 * text in the wrong SCRIPT; it does not try to tell Dutch from German. A good
 * description refused costs a retry and leaves the picture undescribed; an odd
 * one kept can still be corrected in Settings.
 */
import { catalogLanguage } from './creationLanguage.js';
import { k } from './clientError.js';

/**
 * Per language, the words that say what KIND of picture it is, or nothing at
 * all. A description made only of one language's words here describes no
 * content. Per language, because a word empty in one is content in another
 * ("die" is an article in German and a dice in English). Nouns that are also
 * real subjects (a table, a map, a box, a card) are left out.
 */
const EMPTY_WORDS = Object.fromEntries(Object.entries({
    en: 'a an the this that it its is are of with and or some something thing things object objects image images '
        + 'picture pictures photo photos photograph illustration drawing sketch figure graphic icon diagram chart graph '
        + 'plot shows showing shown depicts depicting contains containing displays displaying various several shapes arrows '
        + 'labels text colourful colorful kind type',
    nl: 'een de het dit dat van met en of iets afbeelding plaatje foto tekening figuur diagram grafiek toont laat zien '
        + 'vormen pijlen tekst soort',
    de: 'ein eine einer einem einen der die das dies von mit und oder etwas bild foto abbildung zeichnung diagramm grafik '
        + 'zeigt formen pfeile text art',
    fr: 'un une le la les des du de et ou ceci quelque chose image photo dessin schéma diagramme graphique illustration',
    es: 'un una el la los las de y o algo imagen foto dibujo esquema diagrama gráfico ilustración muestra',
    ru: 'это изображение картинка фото фотография рисунок схема диаграмма график что-то',
    uk: 'це зображення картинка фото фотографія малюнок схема діаграма графік щось',
}).map(([code, words]) => [code, new Set(words.split(/\s+/).filter(Boolean))]));

/** "A bar chart" is a chart of nothing: the kind words before chart/graph go with it. */
const CHART_KIND = /\b(?:bar|line|pie|scatter|flow|area|column|staaf|lijn|cirkel|balken|linien|kreis)[\s-]?(chart|graph|diagram|plot|grafiek|diagramm)s?\b/giu;

/**
 * Quoted text from the picture: content in any language, so it is neither
 * generic nor counted for language. A single curly quote only where it stands
 * apart from letters: "kat’s" and "’t" are apostrophes, not quotes.
 */
const QUOTED = /"[^"]*"|“[^”]*”|„[^“”]*[“”]|«[^»]*»|(?<![\p{L}\p{N}])‘[^’]*’(?![\p{L}\p{N}])|「[^」]*」/gu;

/**
 * A whole reply wrapped in one pair of quotes, a full stop after it allowed:
 * the wrapping goes before any check, or a quoted refusal passes as text
 * from the picture.
 */
const WRAPPED = /^(?:"([^"]*)"|“([^”]*)”|«([^»]*)»|'([^']*)')[.!]?$/u;

/** A label a model puts before its answer ("Description: ..."): never content. */
const LABEL = /^(?:description|alt(?:[\s-]?text)?|caption|beschrijving|beschreibung|descripción|descrizione|descrição|opis|beskrivelse|beskrivning|açıklama|описание|опис|説明|描述|설명|الوصف)\s*[:：]\s*/iu;

/** "This image shows ...": the prompt forbids it; when a model writes it anyway, it goes. */
const PREAMBLE = /^(?:this|the)\s+(?:image|picture|photo(?:graph)?|illustration|drawing|figure)\s+(?:shows|depicts|contains|displays|is\s+of)\s*:?\s*/i;

/** A model declining, or saying there is nothing to describe, in the languages models fall back to. */
const REFUSAL = [
    /^(?:unreadable|n\/a|none|null|undefined)\.?$/i,
    /\bI(?:['’]m| am)\s+(?:sorry|unable|not able)\b/i,
    /\bI\s+(?:can(?:'|’)?t|cannot|can not|do not|don(?:'|’)t)\s+(?:see|view|access|open|describe|process|analy[sz]e)\b/i,
    /\bas an (?:AI|language model)\b/i,
    /\bno (?:image|picture|photo) (?:was|is|has been) (?:provided|attached|included|shared)\b/i,
    /^sorry\s*[,.!]/i,
    /^there(?:'s|’s| is) no (?:image|picture|photo)(?: (?:attached|provided|included|shared|here|to describe))?\s*[.!]?$/i,
    // An apology only where a reply starts: inside a caption the same words are
    // content, and in a language course they are vocabulary ("对不起" on a card).
    // The apology must also be a clause of its own ("Lo siento, ..."), not a caption's first word.
    /^(?:het spijt me|es tut mir leid|lo siento|je suis désolée?|mi dispiace|desculpe|przepraszam|извините|к сожалению|вибачте|на жаль|抱歉|对不起)\s*[,.!，。！]|^申し訳(?:ありません|ございません)/iu,
    /(?<!\p{L})(?:ik kan (?:de |deze )?(?:afbeelding|foto) niet|ik zie geen (?:afbeelding|foto|plaatje)|ich kann (?:das |dieses )?bild nicht|ich kann keine bilder|ich sehe kein(?:e|en)? bild|no puedo ver|je ne peux pas (?:voir|décrire)|non posso vedere|nie mogę zobaczyć|не могу (?:увидеть|просмотреть|открыть)|не можу (?:побачити|переглянути))(?!\p{L})/iu,
    /(?:画像|图片|圖片)(?:を)?(?:見る|表示する|確認する)?(?:ことができません|を?見られません)|无法(?:查看|看到)|無法(?:查看|看到)/u,
];

/**
 * English words no other catalog language writes, so two of them say a text is
 * English. Not "is", "of", "in", "at", "for", "die": Dutch, Danish and German
 * write those too (a Dutch "De hond is groot of klein" holds two of them); nor
 * "and", "over", "under" (Danish, Swedish, Norwegian), "from" (Swedish),
 * "big" (Dutch), "large" (French), "has", "are" (Spanish, Romanian).
 */
const ENGLISH_ONLY = new Set(('the with this that there their which while behind between '
    + 'showing shows into onto beside white black green yellow brown small '
    + 'sitting standing holding looking walking playing wearing woman children kitchen street').split(' '));

/** The script a language is written in, for the languages that have their own. Serbian is left out: it is written in Latin letters too. */
const SCRIPT_OF = {
    ru: /[Ѐ-ӿ]/gu, uk: /[Ѐ-ӿ]/gu, bg: /[Ѐ-ӿ]/gu,
    el: /[Ͱ-Ͽ]/gu,
    ja: /[぀-ヿ一-鿿㐀-䶿]/gu, zh: /[一-鿿㐀-䶿]/gu, ko: /[가-힯ᄀ-ᇿ]/gu,
    ar: /[؀-ۿ]/gu, he: /[֐-׿]/gu, hi: /[ऀ-ॿ]/gu,
};
const LATIN = /[A-Za-zÀ-ɏ]/gu;
const count = (s, re) => (s.match(re) || []).length;

/** The language asked for as a catalog code, or '' (pt-BR -> pt; unknown -> ''). */
export function descriptionLanguage(code) {
    const base = String(code ?? '').trim().toLowerCase().split(/[-_]/)[0];
    return catalogLanguage(base) ? base : '';
}

/**
 * Why `text` is not in `wanted`, as a language name or a script, or null when
 * it is, or when that cannot be said with confidence.
 *
 *   * a language with its own script: refused when the text holds at least 8
 *     Latin letters and fewer than 3 of its own script;
 *   * any other language but English: refused when two or more of its words,
 *     and at least 15% of them, are words only English writes (`ENGLISH_ONLY`);
 *   * English: refused when the text is written mostly in another script.
 */
export function wrongLanguage(text, wanted) {
    const code = descriptionLanguage(wanted);
    if (!code) return null;
    const plain = String(text).replace(QUOTED, ' ');
    const s = plain.toLowerCase();
    const letters = count(s, /\p{L}/gu);
    if (letters < 8) return null;
    const latin = count(s, LATIN);
    if (SCRIPT_OF[code]) {
        // Code, a formula or a name in Latin letters may follow a short native
        // description ("代码截图: for i in range(10)"): only a text with next
        // to nothing in its own script is in the wrong one.
        const own = count(s, SCRIPT_OF[code]);
        // A Chinese, Japanese or Korean word is often two characters
        // ("Photoshop界面"): there one character of the script is enough.
        const floor = ['zh', 'ja', 'ko'].includes(code) ? 1 : 3;
        return own < floor && latin >= 8 ? 'Latin letters' : null;
    }
    if (code === 'en') return latin < letters * 0.5 ? 'another script' : null;
    // A capitalised word inside a sentence is a name or a title ("Hoes van The
    // White Album"), not the description's own language: it is not counted.
    const words = [...plain.matchAll(/\p{L}+/gu)];
    const english = words.filter(m => ENGLISH_ONLY.has(m[0].toLowerCase())
        && (!/^\p{Lu}/u.test(m[0]) || /(?:^|[.!?])$/u.test(plain.slice(0, m.index).trimEnd()))).length;
    return english >= 2 && english >= words.length * 0.15 ? 'English' : null;
}

/** Does every word belong to one language's list of empty words? */
function onlyEmptyWords(words) {
    if (!words.length) return true;
    return Object.values(EMPTY_WORDS).some(set => words.every(w => set.has(w)));
}

/**
 * Check one cleaned description. Returns `{ ok: true, text }` with the text to
 * store (a wrapping pair of quotes and a forbidden preamble dropped), or
 * `{ ok: false, code, reason }`.
 *
 * `code` is one of `empty`, `refusal`, `generic`, `language`; `reason` is the
 * English sentence the sweep reports, `messageKey` what the Describe route
 * sends for the app to translate.
 */
export function checkDescription(raw, { language = '' } = {}) {
    let text = String(raw ?? '').trim().replace(LABEL, '');
    const wrapped = WRAPPED.exec(text);
    if (wrapped) text = (wrapped.slice(1).find(g => g !== undefined) ?? '').trim();
    if (!text) return refuse('empty', k('Description refused: the model wrote no description'));
    // A sign in the picture may say "I'm sorry": quoted text is the picture's, not the model's.
    const unquoted = text.replace(QUOTED, ' ').trim();
    if (REFUSAL.some(re => re.test(unquoted))) return refuse('refusal', k('Description refused: the model said it could not describe this image'));

    const stripped = text.replace(PREAMBLE, '');
    if (stripped !== text && stripped) text = stripped.charAt(0).toLocaleUpperCase() + stripped.slice(1);

    const quotedHasLetters = (text.match(QUOTED) || []).some(q => /[\p{L}\p{N}]/u.test(q));
    const words = text.replace(QUOTED, ' ').toLowerCase().replace(CHART_KIND, '$1')
        .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
    if (!quotedHasLetters && onlyEmptyWords(words)) {
        return refuse('generic', k('Description refused: the description names the kind of picture but nothing in it'));
    }

    const found = wrongLanguage(text, language);
    if (found) {
        const wanted = catalogLanguage(descriptionLanguage(language))?.name ?? language;
        return refuse('language', k('Description refused: the description is not in the course language'), `${found}, not ${wanted}`);
    }
    return { ok: true, text };
}

/**
 * `messageKey` is the sentence the Describe route sends for the app to translate;
 * `reason` adds the English detail (which languages) for the sweep and the log.
 */
function refuse(code, messageKey, detail) {
    return { ok: false, code, reason: detail ? `${messageKey} (${detail})` : messageKey, messageKey };
}
