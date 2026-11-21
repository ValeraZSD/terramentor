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
 * Precision over recall. A short honest description ("A cat") passes; only a
 * text with NOTHING in it but picture-kind words and filler fails. The
 * language check refuses only where the detector is reliable (see
 * `wrongLanguage`), because a refused good description costs a learner a
 * retry, and a kept odd one can still be corrected in Settings.
 */
import { catalogLanguage, detectWrittenLanguage, LATIN_SETS } from './creationLanguage.js';

/**
 * Words that say what KIND of picture it is, or nothing at all. A description
 * made only of these (and of numbers-free filler) describes no content. Kept to
 * the languages a model is most often asked for; any other language simply
 * passes this check.
 */
const EMPTY_WORDS = new Set((
    // English
    'a an the this that these it its is are of with and or in on some something things thing object objects '
    + 'image images picture pictures photo photos photograph illustration drawing sketch figure graphic icon '
    + 'diagram chart graph plot table map bar line pie scatter flowchart flow shows showing shown depicts depicting '
    + 'contains containing displays displaying various several shape shapes box boxes arrow arrows label labels '
    + 'text lines colours colors coloured colored '
    // Dutch
    + 'een de het van met en of iets afbeelding plaatje foto tekening figuur diagram grafiek tabel kaart toont '
    + 'laat zien vormen pijlen tekst '
    // German
    + 'ein eine einer der die das von mit und oder etwas bild foto abbildung zeichnung diagramm grafik tabelle '
    + 'karte zeigt formen pfeile '
    // French
    + 'un une le la les des du de et ou quelque chose image photo dessin schéma diagramme graphique tableau carte montre '
    // Spanish
    + 'un una el la los las de y o algo imagen foto dibujo esquema diagrama gráfico tabla mapa muestra '
    // Russian / Ukrainian
    + 'изображение картинка фото фотография рисунок схема диаграмма график таблица карта что-то '
    + 'зображення малюнок графік'
).split(/\s+/).filter(Boolean));

/** Quoted text from the picture: content in any language, so it is neither generic nor counted for language. */
const QUOTED = /"[^"]*"|“[^”]*”|„[^“”]*[“”]|«[^»]*»|‘[^’]*’|「[^」]*」/g;

/** "This image shows ...": the prompt forbids it; when a model writes it anyway, it goes. */
const PREAMBLE = /^(?:(?:this|the)\s+(?:image|picture|photo(?:graph)?|illustration|drawing|figure)\s+(?:shows|depicts|contains|displays|is\s+of)\s*:?\s*|in\s+(?:this|the)\s+(?:image|picture|photo)\s*,?\s*)/i;

/** A model declining, or saying there is nothing to describe. Checked on the whole reply. */
const REFUSAL = [
    /^(?:unreadable|n\/a|none|null|undefined)\.?$/i,
    /\bI(?:'m| am)\s+(?:sorry|unable|not able)\b/i,
    /\bI\s+(?:can(?:'|’)?t|cannot|can not|do not|don(?:'|’)t)\s+(?:see|view|access|open|describe|process|analy[sz]e|help)\b/i,
    /\bas an (?:AI|language model)\b/i,
    /\bno (?:image|picture|photo) (?:was|is|has been) (?:provided|attached|included|shared)\b/i,
];

/**
 * Languages the detector tells apart by their own function words (the Latin
 * ones in `creationLanguage.js`). For these, ANY other detected language is a
 * refusal. For every other catalog language (Norwegian reads as Danish there,
 * Serbian in Latin letters as Czech) only English is: English is what a model
 * falls back to when it ignores the instruction.
 */
const WELL_DETECTED = new Set(Object.keys(LATIN_SETS));

/** The language asked for as a catalog code, or '' (pt-BR -> pt; unknown -> ''). */
export function descriptionLanguage(code) {
    const base = String(code ?? '').trim().toLowerCase().split(/[-_]/)[0];
    return catalogLanguage(base) ? base : '';
}

/** Is `text` written in some other language than `wanted`? Null when it cannot be said. */
export function wrongLanguage(text, wanted) {
    const code = descriptionLanguage(wanted);
    if (!code) return null;
    const found = detectWrittenLanguage(String(text).replace(QUOTED, ' '), catalogLanguage(code));
    if (!found || found === code) return null;
    if (WELL_DETECTED.has(code) || found === 'en') return found;
    return null;
}

/**
 * Check one cleaned description. Returns `{ ok: true, text }` with the text to
 * store (a forbidden preamble dropped), or `{ ok: false, code, reason }`.
 *
 * `code` is one of `empty`, `refusal`, `generic`, `language`; `reason` is the
 * sentence the sweep and the Describe route report.
 */
export function checkDescription(raw, { language = '' } = {}) {
    let text = String(raw ?? '').trim();
    if (!text) return refuse('empty', 'the model wrote no description');
    // A sign in the picture may say "I'm sorry": quoted text is the picture's, not the model's.
    if (REFUSAL.some(re => re.test(text.replace(QUOTED, ' ').trim()))) return refuse('refusal', 'the model said it could not describe this image');

    const stripped = text.replace(PREAMBLE, '');
    if (stripped !== text && stripped) text = stripped.charAt(0).toLocaleUpperCase() + stripped.slice(1);

    const quoted = text.match(QUOTED) || [];
    const quotedHasLetters = quoted.some(q => /[\p{L}\p{N}]/u.test(q));
    const words = text.replace(QUOTED, ' ').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
    const content = words.filter(w => !EMPTY_WORDS.has(w));
    if (!quotedHasLetters && content.length === 0) {
        return refuse('generic', `the description names the kind of picture but nothing in it ("${text}")`);
    }

    const found = wrongLanguage(text, language);
    if (found) {
        const wanted = catalogLanguage(descriptionLanguage(language))?.name ?? language;
        const got = catalogLanguage(found)?.name ?? found;
        return refuse('language', `the description is in ${got}, not ${wanted}`);
    }
    return { ok: true, text };
}

function refuse(code, reason) {
    return { ok: false, code, reason: `Description refused: ${reason}` };
}
