// server/ankiNotes.js — an Anki collection's notes become flashcards.
//
// Everything here reads text somebody else wrote, with regular expressions,
// so it runs where the collection is read: in the reader's own process
// (`ankiCollectionProcess.js`), under its memory ceiling and time limit, never
// on the server's thread. A field built to make a pattern backtrack costs
// that process its time, not the server. `ankiImport.js` re-exports the
// helpers, and staging carries each card's links, so the commit never parses
// a deck's text again.
//
// This module must never import `database.js` (the child would open the
// learner's library).

import { mapNoteFields } from './ankiFields.js';
import { templateSides } from './ankiTemplates.js';
import { sanitizeUrl } from './urlSafety.js';

/** Anki's field separator; schema 18 also joins deck levels with it. */
export const FIELD_SEP = '\x1f';

/** Why a note did not become a flashcard. Counted, never swallowed. */
export const SKIP_REASONS = {
    EMPTY: 'empty after formatting was removed',
    MEDIA_ONLY: 'only an image or audio clip, no text',
    NO_BACK: 'no answer side',
    UNSUPPORTED: 'unsupported note type',
};

// ---- text ------------------------------------------------------------------

const ENTITIES = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

// Numeric character references in both bases (template fields carry `&#x27;`).
// `fromCodePoint`, because `fromCharCode` truncates astral characters.
const NUMERIC_ENTITY = /&#(x[0-9a-f]+|\d+);/gi;
function decodeNumericEntity(_, digits) {
    const code = digits[0].toLowerCase() === 'x'
        ? parseInt(digits.slice(1), 16)
        : Number(digits);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return _;
    try { return String.fromCodePoint(code); } catch { return _; }
}

function decodeEntities(str) {
    let out = String(str);
    for (const [ent, ch] of Object.entries(ENTITIES)) out = out.split(ent).join(ch);
    return out.replace(NUMERIC_ENTITY, decodeNumericEntity);
}

const IMG_RE = /<img\b[^>]*>/gi;
const A_RE = /<a\b[^>]*>([\s\S]*?)<\/\s*a\s*>/gi;

/**
 * The label of a link, in the `[label](url)` convention: brackets and newlines
 * removed (they are its delimiters), empty → "Link".
 */
function linkLabel(inner) {
    const text = decodeEntities(String(inner ?? '').replace(/<[^>]+>/g, ' '))
        .replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
    return text || 'Link';
}

/**
 * The target, or null when it cannot safely become one. `sanitizeUrl` (as in the
 * course importer), because this lands in an `href`; `)` is percent-encoded so it
 * cannot end the convention's `(…)`.
 */
function linkTarget(href) {
    const checked = sanitizeUrl(href);
    if (!checked.ok || !checked.url) return null;
    return checked.url.replace(/\s/g, '%20').replace(/\)/g, '%29');
}

/** Every `[label](url)` in a card's text, in order. */
export function cardLinks(text) {
    return [...String(text ?? '').matchAll(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g)]
        .map(m => ({ label: m[1].trim(), url: m[2] }));
}

/**
 * The links the card TEMPLATE writes, with the note's own fields filled in.
 *
 * A template's `<a href>` carries information, built from the fields (e.g.
 * `...?search={{Language}} language`). `parseTemplate` ignores field references
 * inside tags as CONTENT; here they fill the URL they were written for. Each field
 * is URL-encoded from its plain text, a link with an empty field is skipped, and
 * `linkTarget` guards the result.
 */
export function templateLinkLines(afmt, fieldNames, textOf) {
    const out = [];
    const raw = String(afmt ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
    for (const m of raw.matchAll(A_RE)) {
        const href = attr(m[0], 'href');
        if (!href || /\{\{\s*FrontSide\s*\}\}/i.test(href)) continue;
        let missing = false;
        const filled = href.replace(/\{\{([^{}]*)\}\}/g, (_, body) => {
            const name = body.split(':').pop().trim();
            const i = fieldNames.findIndex(f => String(f).trim().toLowerCase() === name.toLowerCase());
            const text = i >= 0 ? String(textOf(i) ?? '') : '';
            const plain = text.replace(/\*\*/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
            if (!plain) { missing = true; return ''; }
            return encodeURIComponent(plain);
        });
        if (missing) continue;
        const url = linkTarget(filled.replace(/ /g, '%20'));
        if (!url) continue;
        const label = linkLabel(m[1].replace(/\{\{[^{}]*\}\}/g, ' '));
        out.push(`[${label}](${url})`);
    }
    return out;
}

/** The four columns that hold a card's words. */
const CARD_TEXT = ['front', 'back', 'extra', 'extraFront'];

/** One card's links, deduplicated by URL, first label wins. */
export function linksOfCard(card) {
    const byUrl = new Map();
    for (const field of CARD_TEXT) {
        for (const link of cardLinks(card?.[field])) {
            if (!byUrl.has(link.url)) byUrl.set(link.url, link);
        }
    }
    return [...byUrl.values()];
}

/**
 * Which kind of resource a link is, from the words the author wrapped it in.
 *
 * The LABEL knows what the host cannot ("Khan Academy Video" vs "…Article").
 * Unrecognised is an article, as in `normalizeResourceType`.
 */
const VIDEO_HOST = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|bilibili\.com|dailymotion\.com)$/i;
export function linkResourceType({ label, url }) {
    if (/\b(video|watch|lecture|playlist)\b/i.test(label)) return 'video';
    try { if (VIDEO_HOST.test(new URL(url).hostname)) return 'video'; } catch { /* label decides */ }
    if (/\b(exercise|practice|quiz|problem)s?\b/i.test(label)) return 'practice';
    return 'article';
}

// Bounds on links turned into resources; far above what a deck's busiest topic
// carries.
export const MAX_LINKS_PER_NODE = 60;
export const MAX_LINKS_TOTAL = 5000;

/** One attribute out of a tag, quoted or not, with entities decoded. */
function attr(tag, name) {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

/**
 * Anki fields are HTML. Turn one into the plain text a flashcard front/back is,
 * and collect the media it referenced.
 *
 * References are the filenames Anki wrote (`<img src="cat.jpg">`, `[sound:neko.mp3]`),
 * resolved later against the media index (ankiMedia.js); an unresolved name is
 * counted, never guessed. The author's `alt` is kept: a human description outranks a
 * generated one, and screen readers read it.
 */
export function stripAnkiHtml(html) {
    if (typeof html !== 'string') return { text: '', images: [], sounds: [] };
    let s = html;

    const images = (s.match(IMG_RE) || []).map(tag => ({
        kind: 'image', file: attr(tag, 'src'), alt: attr(tag, 'alt') || '',
    })).filter(r => r.file);
    const sounds = [...s.matchAll(/\[sound:([^\]]*)\]/gi)]
        .map(m => ({ kind: 'audio', file: decodeEntities(m[1]).trim(), alt: '' }))
        .filter(r => r.file);

    // **A clip belongs to the line it was written on** (`Adiós[sound:a.mp3]<br>…`).
    // Each `[sound:…]` becomes a sentinel that survives stripping; the final plain
    // line it lands on is recorded as `at`, so the renderer can put the clip beside
    // it. A clip alone on its line has no anchor (but see the one-line rule below).
    let soundIndex = 0;
    s = s.replace(/\[sound:([^\]]*)\]/gi, (_, f) => (decodeEntities(f).trim() ? `\u0002${soundIndex++}\u0002` : ' '));
    s = s.replace(IMG_RE, ' ');
    // **A link is content** (a field is often nothing but links). Kept as
    // `[text](url)`, rendered by `src/utils/cardText.ts`; `stripCardMarkup` reduces
    // it to the label for search, the tutor and text-to-speech.
    s = s.replace(A_RE, (whole, inner) => {
        const url = linkTarget(attr(whole, 'href'));
        // An unusable target keeps the words: a label is still information.
        if (!url) return inner;
        return `[${linkLabel(inner)}](${url})`;
    });
    // The bolded target word in an example sentence, kept as `**…**` for
    // `src/utils/cardText.ts` (not markdown: see that file).
    s = s.replace(/<\s*(b|strong)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi,
        (_, _tag, inner) => (inner.trim() ? `**${inner.trim()}**` : ' '));
    // Anki wraps cloze answers in these when rendering; they are not content.
    s = s.replace(/<\/?(?:anki-mathjax|span|div|font)\b[^>]*>/gi, m => (/^<\/?div/i.test(m) ? '\n' : ''));
    s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    s = s.replace(/<\/\s*(?:p|li|tr|h[1-6])\s*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');

    for (const [ent, ch] of Object.entries(ENTITIES)) s = s.split(ent).join(ch);
    s = s.replace(NUMERIC_ENTITY, decodeNumericEntity);

    // Collapse the whitespace HTML leaves behind, but keep paragraph breaks.
    s = s.replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // Emphasis over the whole field (many decks bold the entire answer) marks nothing.
    const whole = /^\*\*([\s\S]+)\*\*$/.exec(s);
    if (whole && !whole[1].includes('**')) s = whole[1].trim();

    if (sounds.length) {
        const lines = [];
        for (const line of s.split('\n')) {
            const marks = [...line.matchAll(/\u0002(\d+)\u0002/g)];
            const clean = line.replace(/\u0002\d+\u0002/g, '').replace(/[ \t]+/g, ' ').trim();
            for (const m of marks) {
                const ref = sounds[Number(m[1])];
                if (ref && clean) ref.at = clean;
            }
            // A line that was nothing but a clip is not a line of text.
            if (!clean && marks.length) continue;
            lines.push(clean);
        }
        // In a ONE-line field (`Adiós<br>[sound:…]`) an unanchored clip belongs
        // to that line; with several lines a guess could pick the wrong one.
        const textLines = lines.filter(Boolean);
        if (textLines.length === 1) {
            for (const ref of sounds) if (!ref.at) ref.at = textLines[0];
        }
        s = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    return { text: s, images, sounds };
}

const CLOZE_RE = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/gs;

/** Which cloze numbers appear in a note's text, ascending. */
export function clozeOrdinals(text) {
    const found = new Set();
    for (const m of String(text ?? '').matchAll(CLOZE_RE)) found.add(Number(m[1]));
    return [...found].sort((a, b) => a - b);
}

/**
 * One cloze deletion becomes one flashcard: the target is blanked on the front and
 * revealed on the back; every OTHER deletion shows its answer on both, as in Anki.
 */
export function expandCloze(text, ordinal) {
    const render = (reveal) => String(text ?? '').replace(CLOZE_RE, (_, n, answer, hint) => {
        if (Number(n) !== ordinal) return answer;
        if (reveal) return answer;
        return hint ? `[${hint}]` : '[...]';
    });
    const answers = [];
    for (const m of String(text ?? '').matchAll(CLOZE_RE)) {
        if (Number(m[1]) === ordinal) answers.push(m[2]);
    }
    return { front: render(false), back: answers.join(', ') || render(true) };
}

// ---- mapping ----------------------------------------------------------------

/**
 * Pick the question and answer fields for a non-cloze note when no template
 * resolves: by field NAMES (ankiFields.js), else by position — first non-empty
 * field is the question, the next the answer. The UI offers a one-toggle swap,
 * since a reversed pair is the only error this makes and it shows on a sample card.
 */
function pickFrontBack(values, names = []) {
    const mapped = mapNoteFields(values, names);
    if (mapped) {
        return {
            front: { v: values[mapped.front], i: mapped.front },
            back: { v: values[mapped.back], i: mapped.back },
            extras: mapped.extras,
        };
    }

    // Media counts as content, so a picture-only question field is a question.
    const nonEmpty = values.map((v, i) => ({ v, i })).filter(x => hasContent(x.v));
    if (nonEmpty.length === 0) return null;
    if (nonEmpty.length === 1) return { front: nonEmpty[0], back: null, extras: [] };
    return { front: nonEmpty[0], back: nonEmpty[1], extras: [] };
}

const refsOf = (v) => [...(v?.images ?? []), ...(v?.sounds ?? [])];
const hasContent = (v) => !!(v?.text || refsOf(v).length);

/**
 * Every note of a collection (`readCollection`) as the flashcards it becomes,
 * with each refusal counted under its reason and the media filenames the
 * cards reference. Runs in the reader's process.
 */
export function notesToCards({ decks, noteTypes, cardTemplates, cardRows, noteRows }) {
    const cardsByNote = new Map();
    for (const c of cardRows) {
        if (!cardsByNote.has(c.nid)) cardsByNote.set(c.nid, []);
        cardsByNote.get(c.nid).push(c);
    }

    const out = [];
    const skipped = [];
    let withImages = 0, withSounds = 0;
    const deckCounts = new Map();
    const typeCounts = new Map();
    // Only referenced files are extracted: decks carry orphans (Anki prunes
    // only on "Check Media").
    const wantedMedia = new Set();

    for (const note of noteRows) {
        const model = noteTypes.get(Number(note.mid));
        const typeName = model?.name ?? 'Note';
        typeCounts.set(typeName, (typeCounts.get(typeName) ?? 0) + 1);

        const rawValues = String(note.flds ?? '').split(FIELD_SEP);
        const values = rawValues.map(stripAnkiHtml);
        const notecards = cardsByNote.get(note.id) ?? [];
        const tags = String(note.tags ?? '').trim().split(/\s+/).filter(Boolean);

        const media = {
            i: values.reduce((n, v) => n + v.images.length, 0),
            s: values.reduce((n, v) => n + v.sounds.length, 0),
        };
        if (media.i) withImages++;
        if (media.s) withSounds++;
        for (const v of values) for (const r of refsOf(v)) wantedMedia.add(r.file);

        const deckOf = (ord) => {
            const c = notecards.find(x => x.ord === ord) ?? notecards[0];
            return decks.get(Number(c?.did)) ?? 'Imported';
        };
        // The new-card queue position, or null once studied (then `due` is a
        // date); null sorts by note id (`compareCards` in deckStructure.js).
        const orderOf = (ord) => {
            const c = notecards.find(x => x.ord === ord) ?? notecards[0];
            if (!c || Number(c.type) !== 0) return null;
            const due = Number(c.due);
            return Number.isFinite(due) ? due : null;
        };
        const schedOf = (ord) => {
            const c = notecards.find(x => x.ord === ord)
                ?? [...notecards].sort((a, b) => (b.reps ?? 0) - (a.reps ?? 0))[0];
            if (!c) return null;
            return {
                // Anki's card id, to attach the deck's revlog later.
                ankiCardId: Number(c.id),
                interval: Math.max(0, Number(c.ivl) || 0),
                // Anki stores ease x1000; 0 means "never reviewed".
                ease: c.factor ? Number(c.factor) / 1000 : null,
                reps: Math.max(0, Number(c.reps) || 0),
                lapses: Math.max(0, Number(c.lapses) || 0),
            };
        };

        const joined = rawValues.join(' ');
        const ordinals = clozeOrdinals(joined);

        // Media in fields that are neither question nor answer still belongs
        // to the note (vocabulary decks keep picture and audio in FURTHER
        // fields). It goes on the ANSWER side: on the question it could give
        // the answer away.
        const usedFields = new Set();
        const spare = () => values
            .filter((_, i) => !usedFields.has(i))
            .flatMap(refsOf);

        if (ordinals.length > 0) {
            // Cloze: the deletions live in whichever field holds them.
            const sourceIdx = rawValues.findIndex(v => clozeOrdinals(v).length);
            const source = sourceIdx >= 0 ? rawValues[sourceIdx] : joined;
            if (sourceIdx >= 0) usedFields.add(sourceIdx);

            // A cloze note type has one template (one card per deletion).
            const clozeTmpl = (cardTemplates.get(Number(note.mid)) ?? [])[0];
            const clozeSides = templateSides(
                clozeTmpl, model?.fields ?? [],
                (i) => hasContent(values[i]),
                (i) => values[i]?.text ?? '',
            );
            // Image occlusion stores rectangles as cloze deletions
            // (`{{c1::image-occlusion:rect:left=...}}`); expanded, the answer is
            // a coordinate list. The template is the signal, the text marker
            // the fallback.
            if (clozeSides?.unsupported || /image-occlusion:/i.test(source)) {
                skipped.push({ note: note.id, reason: SKIP_REASONS.UNSUPPORTED });
                continue;
            }
            // Everything the author printed under the answer (`templateSides`).
            // Kept OUT of `usedFields`, which only keeps the cloze sentence's
            // own media off the answer; a supporting line's media belongs there.
            const clozeExtra = (clozeSides?.extras ?? [])
                .filter(i => i !== sourceIdx)
                .map(i => values[i].text)
                .filter(Boolean).join('\n');

            const spareRefs = spare();
            for (const ord of ordinals) {
                const { front, back } = expandCloze(source, ord);
                const f = stripAnkiHtml(front), b = stripAnkiHtml(back);
                if (!f.text) { skipped.push({ note: note.id, reason: media.i ? SKIP_REASONS.MEDIA_ONLY : SKIP_REASONS.EMPTY }); continue; }
                if (!b.text) { skipped.push({ note: note.id, reason: SKIP_REASONS.NO_BACK }); continue; }
                const deck = deckOf(ord - 1);
                deckCounts.set(deck, (deckCounts.get(deck) ?? 0) + 1);
                out.push({
                    front: f.text, back: b.text, extra: clozeExtra, deck, tags, cloze: true,
                    noteType: typeName, images: media.i, sched: schedOf(ord - 1),
                    order: orderOf(ord - 1), noteId: Number(note.id),
                    // The sentence's own media rides the front, so a listening
                    // prompt is heard before the reveal.
                    media: { front: refsOf(f), back: [...refsOf(b), ...spareRefs] },
                });
            }
            continue;
        }

        // ---- one card per CARD, not one card per note --------------------
        //
        // A note type may define several templates ("Basic (and reversed
        // card)" defines two). Ordinals come from the `cards` table, not the
        // template list: a row's existence IS Anki's evaluated condition, so
        // `{{#Add Reverse}}` never has to be interpreted here.
        const cardOrds = [...new Set(notecards.map(c => Number(c.ord)))]
            .filter(Number.isFinite).sort((a, b) => a - b);
        const templates = cardTemplates.get(Number(note.mid)) ?? [];
        let emitted = 0;

        for (const ord of (cardOrds.length ? cardOrds : [0])) {
            const tmpl = templates.find(t => t.ord === ord);
            const sides = templateSides(
                tmpl,
                model?.fields ?? [],
                (i) => hasContent(values[i]),
                (i) => values[i]?.text ?? '',
            );

            // A scripted template (Image Occlusion's canvas) has no text to extract.
            if (sides?.unsupported) {
                skipped.push({ note: note.id, reason: SKIP_REASONS.UNSUPPORTED });
                continue;
            }

            let front, back, extraIdx, frontExtraIdx = [];
            if (sides && !sides.cloze) {
                ({ front, back } = sides);
                extraIdx = sides.extras;
                // What the author put on the question beside the word. Only a
                // template knows; the fallback leaves it empty for the client.
                frontExtraIdx = sides.frontExtras ?? [];
            } else if (emitted === 0) {
                // No usable template: the name-based mapping, for the first
                // ordinal only (for ord 1 it would duplicate ord 0).
                const pair = pickFrontBack(values, model?.fields ?? []);
                if (!pair) {
                    skipped.push({ note: note.id, reason: media.i || media.s ? SKIP_REASONS.MEDIA_ONLY : SKIP_REASONS.EMPTY });
                    continue;
                }
                if (!pair.back) {
                    skipped.push({ note: note.id, reason: media.i ? SKIP_REASONS.MEDIA_ONLY : SKIP_REASONS.NO_BACK });
                    continue;
                }
                front = pair.front.i;
                back = pair.back.i;
                extraIdx = pair.extras ?? [];
            } else {
                // A card this cannot characterise is still counted, with a reason.
                skipped.push({ note: note.id, reason: SKIP_REASONS.UNSUPPORTED });
                continue;
            }

            // Media in any field but front and back rides the answer —
            // supporting lines (`extras`) included, since templates promote
            // media fields like `{{Picture}}` to extras; excluding them drops
            // every media file.
            const spareRefs = values.flatMap((v, i) => (i === front || i === back ? [] : refsOf(v)));

            // The supporting lines (reading, example sentence, translation),
            // in their own column since they are not the answer, then the
            // template's own links (`templateLinkLines`), last as the author
            // placed them.
            const templateLinks = (sides && !sides.cloze)
                ? templateLinkLines(tmpl?.afmt, model?.fields ?? [], (i) => values[i]?.text ?? '')
                : [];
            const extra = [...extraIdx.map(i => values[i].text), ...templateLinks].filter(Boolean).join('\n');
            // The question's supporting lines, verbatim and in template order.
            const extraFront = frontExtraIdx.map(i => values[i].text).filter(Boolean).join('\n');
            const deck = deckOf(ord);
            deckCounts.set(deck, (deckCounts.get(deck) ?? 0) + 1);
            out.push({
                front: values[front].text, back: values[back].text, extra, extraFront, deck, tags, cloze: false,
                noteType: typeName, images: media.i, sched: schedOf(ord),
                order: orderOf(ord), noteId: Number(note.id),
                fieldNames: model?.fields ?? [],
                media: { front: refsOf(values[front]), back: [...refsOf(values[back]), ...spareRefs] },
            });
            emitted++;
        }
    }

    // The links each card carries, found here so the commit never runs these
    // patterns over the deck's text on the server's thread.
    for (const card of out) card.links = linksOfCard(card);
    return { cards: out, skipped, withImages, withSounds, deckCounts, typeCounts, wantedMedia: [...wantedMedia] };
}
