// server/ankiTemplates.js — what the deck's AUTHOR said goes on each side.
//
// ## The standing claim this module corrects
//
// `ankiFields.js` opens by saying the card templates "are protobuf inside
// `notetypes.config`, which nothing here reads", and picks the question and the
// answer by matching field NAMES instead. The first half of that was measured
// and is wrong: the templates live in their own `templates` table in schema 18,
// and while the row's `config` IS protobuf, `qfmt` and `afmt` are plain UTF-8
// inside it as fields 1 and 2 — recoverable with the same hand-rolled wire
// walker `ankiMedia.js` already uses for the media index, and with no
// dependency. In schema 11 they were never encoded at all: `models[].tmpls` is
// JSON with `qfmt`/`afmt` as strings.
//
// That matters because a template is not a guess. "Word Meaning is probably the
// answer to Word" is an inference about a string; `afmt` containing
// `{{Word Meaning}}` is the deck author stating it. Name-matching stays as the
// fallback — a template can be unreadable, or reference only fields this note
// left empty — but where a template resolves, it wins.
//
// ## What is NOT done here, deliberately
//
// A template is HTML with CSS and sometimes `<script>`, and the obvious reading
// of "support every deck" is to render it in a webview the way Anki does. This
// app does not, and the refusal is structural rather than lazy:
//
//   - Card text is plain text on purpose. It is parsed for furigana and for the
//     target-word emphasis (`src/utils/cardText.ts`), fed to the tutor as
//     context, read aloud from `media_files.description`, searched, and passed
//     through the shared sanitizer that exists specifically to keep other
//     people's tags out of the app's DOM. An imported deck is untrusted input;
//     `{{Image Occlusion}}`'s template alone ships a `<script>` block.
//   - Every downstream feature keys on the extracted text: the feed, BKT,
//     mastery, FSRS, the deck stage ladder. A card that is an opaque HTML blob
//     is a card the engine cannot teach, only display.
//
// So the templates are read for their STRUCTURE — which fields land on which
// side, in which order — and the presentation is this app's own. That is the
// part that makes an imported deck correct; the styling is the part that makes
// it look like Anki, and those are different goals.

import { fieldRole, ROLES } from './ankiFields.js';

// ---- protobuf ---------------------------------------------------------------
//
// Only enough of the wire format to walk a message and pull two length-
// delimited strings. Unknown fields are skipped by wire type, exactly as in
// `ankiMedia.js`, so a future Anki release adding fields cannot break this.

function readVarint(buf, pos) {
    let result = 0, shift = 0;
    for (;;) {
        if (pos >= buf.length) return null;
        const b = buf[pos++];
        result += (b & 0x7f) * 2 ** shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        // A tag or length beyond this is corrupt, not merely large.
        if (shift > 42) return null;
    }
    return { value: result, pos };
}

/**
 * `templates.config` → `{ qfmt, afmt }`.
 *
 * Field 1 is the question format and field 2 the answer format. Anything that
 * fails to decode yields `{}` — an absent template falls back to name matching,
 * which is strictly the behaviour that shipped before this module existed.
 */
export function decodeTemplateConfig(blob) {
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob || []);
    const out = {};
    let pos = 0;
    while (pos < buf.length) {
        const tag = readVarint(buf, pos);
        if (!tag) break;
        pos = tag.pos;
        const field = Math.floor(tag.value / 8);
        const wire = tag.value % 8;
        if (wire === 2) {
            const len = readVarint(buf, pos);
            if (!len) break;
            pos = len.pos;
            if (pos + len.value > buf.length) break;
            const bytes = buf.subarray(pos, pos + len.value);
            pos += len.value;
            if (field === 1) out.qfmt = bytes.toString('utf8');
            else if (field === 2) out.afmt = bytes.toString('utf8');
        } else if (wire === 0) {
            const v = readVarint(buf, pos);
            if (!v) break;
            pos = v.pos;
        } else if (wire === 5) pos += 4;
        else if (wire === 1) pos += 8;
        else break; // groups (3/4) are not emitted by Anki; stop rather than guess.
    }
    return out;
}

/**
 * Note type id → the card templates it defines, in ordinal order.
 *
 * Both schemas, same shape out. Schema 18's `templates` table is authoritative
 * when present; the legacy `col.models` JSON is the fallback, and a collection
 * with neither returns an empty map so every caller degrades to name matching.
 */
export function readCardTemplates(handle) {
    const out = new Map();
    const push = (ntid, tmpl) => {
        const list = out.get(ntid) ?? [];
        list.push(tmpl);
        out.set(ntid, list);
    };

    const hasTable = (name) => !!handle
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(name);

    if (hasTable('templates')) {
        try {
            for (const row of handle.prepare('SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord').all()) {
                const { qfmt = '', afmt = '' } = decodeTemplateConfig(row.config);
                push(Number(row.ntid), { ord: Number(row.ord), name: String(row.name ?? ''), qfmt, afmt });
            }
        } catch { /* fall through to the legacy blob */ }
        if (out.size) return out;
    }

    try {
        const parsed = JSON.parse(handle.prepare('SELECT models FROM col LIMIT 1').get()?.models || '{}');
        for (const [id, m] of Object.entries(parsed)) {
            const tmpls = Array.isArray(m?.tmpls) ? m.tmpls : [];
            tmpls.forEach((t, i) => push(Number(id), {
                ord: Number.isFinite(Number(t?.ord)) ? Number(t.ord) : i,
                name: String(t?.name ?? ''),
                qfmt: String(t?.qfmt ?? ''),
                afmt: String(t?.afmt ?? ''),
            }));
        }
    } catch { /* neither source — an empty map is a supported build */ }
    return out;
}

// ---- the template language --------------------------------------------------

/**
 * Special replacements that name no field on the note.
 *
 * `FrontSide` is the load-bearing one. On virtually every stock answer template
 * it is the first thing on the back, and expanding it would print the question
 * twice — this app already keeps the question above the answer (`CardFace`), so
 * the repeat is not merely redundant but visibly wrong.
 */
const SPECIAL = new Set([
    'frontside', 'tags', 'deck', 'subdeck', 'card', 'type', 'cardflag',
    'flag', 'cardid', 'noteid',
]);

/**
 * Filters, in `{{filter:Field}}` form. Several stack: `{{text:furigana:Foo}}`.
 *
 * Two change what the reference MEANS rather than how it looks:
 *   - `type:` is the box the learner types their answer into. It appears on the
 *     QUESTION template of "Basic (type in the answer)", naming the answer
 *     field — so treating it as question content would print the answer on the
 *     question. It is always an answer, wherever it is written.
 *   - `cloze:` marks a cloze template. The deletions are expanded from the note
 *     text by `expandCloze` in the importer, which needs no template at all, so
 *     this is only a signal that this path should not run.
 */
const ANSWER_FILTERS = new Set(['type']);
const CLOZE_FILTERS = new Set(['cloze', 'cloze-only']);
// A hint is content the learner clicks to reveal. It belongs on the card, but
// never as the answer — it is a nudge toward one.
const HINT_FILTERS = new Set(['hint']);
// `tts` speaks a field that is, on every stock template, already printed
// elsewhere on the card. Reading it as another text reference duplicates a line.
const SPOKEN_FILTERS = new Set(['tts', 'tts-voices']);

/**
 * Pull the field references out of one template side.
 *
 * HTML comments come off FIRST and that is not tidiness. One vocabulary deck's
 * answer template carries its pitch-accent block commented out:
 *
 *     <!-- This part enables pitch accent.
 *     {{#Pitch Accent}}...{{Pitch Accent}}...{{/Pitch Accent}} -->
 *
 * A parser that reads references before stripping comments puts the deck's
 * inline-styled pitch markup — which flattens to a bare "アマリ" — onto 1,500
 * cards, as content the author had deliberately switched off.
 *
 * `{{#Field}}` / `{{^Field}}` / `{{/Field}}` are section markers, not content:
 * `{{#Add Reverse}}{{Back}}{{/Add Reverse}}` puts `Back` on the card and
 * `Add Reverse` nowhere. The conditions are not evaluated here at all, because
 * they do not need to be — Anki has already decided which cards exist, and the
 * `cards` table lists them. The existence of the row IS the evaluated condition.
 */
export function parseTemplate(fmt) {
    const raw = String(fmt ?? '').replace(/<!--[\s\S]*?-->/g, ' ');

    // **Image occlusion is the one template whose ANSWER is drawn by a script.**
    // Its deletions are rectangles painted on a canvas, so there is no text to
    // extract and inventing one ships a card answered by the word "Image". It is
    // named directly because no script heuristic can stand in for the field
    // structure: a script cannot change which field lands on which side, which
    // is the only thing this module reads, and decks attach them for ordinary
    // presentation.
    // Measured on two real decks: under a veto on `<script>` alone, one MathJax
    // loader costs a maths deck 63 notes, and a three-line autoplay snippet
    // costs a phrasebook its 4,317 -- every card it had -- reported as
    // "unsupported note type".
    // Anki writes it hyphenated in the markup it generates (`id=
    // "image-occlusion-container"`, `image-occlusion-canvas`) and camel-cased in
    // the call that draws it (`anki.imageOcclusion.setup()`); a template carries
    // both, and a hand-edited one may carry only the second.
    const imageOcclusion = /image[-_]?occlusion/i.test(raw);

    // **A reference inside a TAG is not printed on the card.** Anki templates
    // put fields in `href` and `src` attributes -- `<a href="...?q={{NoteID}}">`,
    // `<a href=".../review/{{Deck ID}}">` -- and reading those as content puts a
    // bookkeeping id under the answer as if the author had written it there.
    // What the learner sees is the text BETWEEN the tags, so that is what is
    // scanned; a standalone `{{Image}}` is untouched because it is not in one.
    const src = raw.replace(/<[^<>]*>/g, ' ');

    const refs = [];
    let cloze = false;

    for (const m of src.matchAll(/\{\{([^{}]*)\}\}/g)) {
        const body = m[1].trim();
        if (!body) continue;
        if (body.startsWith('#') || body.startsWith('^') || body.startsWith('/')) continue;
        if (body.startsWith('!')) continue; // comment replacement

        const parts = body.split(':');
        const name = parts.pop().trim();
        const filters = parts.map(p => p.trim().toLowerCase().split(/\s+/)[0]).filter(Boolean);

        if (!name) continue;
        if (filters.some(f => CLOZE_FILTERS.has(f))) { cloze = true; continue; }
        if (SPECIAL.has(name.toLowerCase())) continue;
        if (filters.some(f => SPOKEN_FILTERS.has(f))) continue;

        refs.push({
            name,
            answer: filters.some(f => ANSWER_FILTERS.has(f)),
            hint: filters.some(f => HINT_FILTERS.has(f)),
        });
    }
    return { refs, cloze, imageOcclusion };
}

/**
 * How good a field is as THE answer, lower being better.
 *
 * A meaning is what the learner is being asked to produce; a reading, an
 * example or a note is context confirming it, and belongs in `extra` where
 * `CardExtra` renders it under the answer. Everything unrecognised sits in the
 * middle rather than at either end — an unknown name is not evidence against a
 * field, so on a deck this cannot read every candidate ranks equal and the
 * author's own ordering decides.
 */
const ANSWER_RANK = {
    [ROLES.MEANING]: 0,
    [ROLES.SENTENCE_MEANING]: 1,
    [ROLES.TERM]: 2,
    [ROLES.UNKNOWN]: 2,
    [ROLES.NOTES]: 3,
    [ROLES.SENTENCE]: 4,
    [ROLES.READING]: 5,
    [ROLES.SENTENCE_READING]: 5,
    [ROLES.PICTURE]: 6,
    [ROLES.AUDIO]: 7,
    [ROLES.IGNORE]: 8,
};

function answerRank(name) {
    const r = ANSWER_RANK[fieldRole(name)];
    return r === undefined ? 2 : r;
}

/**
 * Two fields carry the same content when they are equal once ruby annotations,
 * emphasis markers and whitespace come off — which is exactly the comparison
 * `splitWordReading` makes with `stripCardMarkup`, kept in step deliberately.
 */
export function variantKey(text) {
    return String(text ?? '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\*\*/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();
}

/** How much reading information a variant carries. More is better. */
const rubyCount = (text) => (String(text ?? '').match(/\[/g) || []).length;

/** The word's own reading sorts first; everything else keeps template order. */
const readingFirst = (name) => (fieldRole(name) === ROLES.READING ? 0 : 1);

/** First index of `name` in `fieldNames`, case- and space-insensitively. */
function indexOfField(fieldNames, name) {
    const want = String(name).trim().toLowerCase();
    for (let i = 0; i < fieldNames.length; i++) {
        if (String(fieldNames[i] ?? '').trim().toLowerCase() === want) return i;
    }
    return -1;
}

/**
 * One card template → which field indices land on the question, the answer, and
 * the supporting lines, in the order the author wrote them.
 *
 * `hasContent(i)` is supplied by the caller because "non-empty" counts media
 * here as it does everywhere else in the importer: a picture-first card's
 * question field holds an `<img>` and no text, and refusing it would drop the
 * whole deck.
 *
 * Returns `null` — meaning "use the name-based mapping" — whenever the template
 * cannot answer: one naming no field this note filled, or one that produced a
 * question but no answer. Falling back is always safe; it is exactly the
 * behaviour that shipped before. A cloze template answers `{ cloze: true }` with
 * its supporting lines, and an image-occlusion one `{ unsupported: true }`.
 */
export function templateSides(tmpl, fieldNames, hasContent, textOf = null) {
    if (!tmpl) return null;
    const q = parseTemplate(tmpl.qfmt);
    const a = parseTemplate(tmpl.afmt);

    // Image Occlusion draws its answer on a canvas from a script. There is no
    // text to extract and no honest way to fake one, so say so rather than
    // importing a card whose answer is the word "Image".
    if (q.imageOcclusion || a.imageOcclusion) return { unsupported: true };

    const resolve = (refs) => {
        const seen = new Set();
        const out = [];
        for (const r of refs) {
            const i = indexOfField(fieldNames, r.name);
            if (i < 0 || seen.has(i) || !hasContent(i)) continue;
            seen.add(i);
            out.push({ i, hint: r.hint, answer: r.answer });
        }
        return out;
    };

    const qRefs = resolve(q.refs);
    const aRefs = resolve(a.refs);

    // **A cloze note still has supporting lines, and dropping them emptied the
    // card.** The two sides come from the deletions in the note's own text, so
    // this path needs no template to build them -- but everything the author put
    // UNDER the answer (the worked formula, the diagram, the link out) is named
    // only by the template, and the importer had nothing to read it from. On a
    // real 263-note maths deck that was every card: all 263 carry a "Back
    // Extra" block, and all 460 cards imported as a bare cloze sentence with the
    // explanation thrown away. Only the ANSWER template is read, because a cloze
    // question template routinely hides fields in `display:none` divs for its
    // own scripting and those are machinery, not content.
    if (q.cloze || a.cloze) return { cloze: true, extras: aRefs.map(r => r.i) };

    // `{{type:Back}}` on the question side names the answer, not the prompt.
    const question = qRefs.filter(r => !r.answer && !r.hint);
    const typed = qRefs.filter(r => r.answer);
    const qHints = qRefs.filter(r => r.hint && !r.answer);

    if (!question.length) return null;
    const frontIdx = question[0].i;

    const onFront = new Set(question.map(r => r.i));
    // Candidates for the answer: everything on the back that is not already the
    // question. Stock templates open the back with `{{FrontSide}}` — dropped
    // above — and a rich deck's answer template often repeats the prompt field
    // as a heading before the meaning, which would otherwise make the answer
    // identical to the question.
    const answerPool = [...typed, ...aRefs.filter(r => !r.hint && !onFront.has(r.i))];
    if (!answerPool.length) return null;

    // **The template does not say which field is the answer, and taking the
    // first one is wrong on exactly the decks this exists to fix.** Anki has no
    // such concept — the whole back of the card is the answer, and the author
    // ordered it for reading, not for grading. One answer template
    // opens with `{{furigana:Word Furigana}}` and reaches `{{Word Meaning}}`
    // two lines later, so "first on the back" makes 早い answered by 早[はや]い
    // and puts **early** on none of its 1,501 cards — the identical failure that
    // positional field-picking produced, arriving by a new route.
    //
    // So the two sources of knowledge are used for the two things each actually
    // knows. The TEMPLATE is authoritative about membership and side, which no
    // amount of name-matching could recover (it is what carries the example
    // sentence across, and what makes a reversed card a reversed card). The
    // field ROLES are authoritative about which of those is the thing being
    // asked for, which no template records. Ties fall back to template order, so
    // a deck whose names say nothing behaves exactly as the author wrote it.
    const bestAnswer = answerPool.reduce((best, r) => (
        answerRank(fieldNames[r.i]) < answerRank(fieldNames[best.i]) ? r : best
    ), answerPool[0]);
    const backIdx = bestAnswer.i;

    // Everything else the author put on the card.
    const used = new Set([frontIdx, backIdx]);
    let extras = [];
    for (const r of [...question.slice(1), ...qHints, ...answerPool, ...aRefs.filter(r => r.hint)]) {
        if (used.has(r.i)) continue;
        used.add(r.i);
        extras.push(r.i);
    }

    // **A template legitimately prints the same content twice, and `extra` is
    // one block rather than two sides.** Anki shows the plain `Sentence` on the
    // front and `Sentence Furigana` — the identical sentence with readings — on
    // the back, which is right for a card with two faces and wrong for a single
    // list of supporting lines: that deck's would have carried
    // `今は**時間**がありません。` immediately followed by
    // `今[いま]は**時[じ] 間[かん]**がありません。`, the same sentence twice.
    // So variants collapse to the RICHEST one (most ruby annotations), which is
    // also the one the app can render both ways — `contextSentence` strips the
    // readings back off for the question side.
    if (typeof textOf === 'function') {
        // A supporting line that merely repeats the question or the answer adds
        // nothing and costs a line. The common case is a word already written in
        // kana (する, なる), whose `Word Reading` IS the word — the deck fills
        // the field because the field exists, not because there is a reading to
        // give. `splitWordReading` already refuses to lift such a reading onto
        // the word, so keeping it would strand a duplicate above the example.
        //
        // **The test is "adds no reading", not "is the same string".** A word's
        // per-kanji furigana (`時[じ] 間[かん]`) normalises to the word itself by
        // construction — that is what makes it a reading OF the word — so a
        // plain equality test drops the single most useful supporting line there
        // is, the one `splitWordReading` lifts onto the word. A duplicate is
        // only dead weight when it carries no more annotation than the side it
        // repeats.
        const sides = [frontIdx, backIdx].map(i => ({ key: variantKey(textOf(i)), ruby: rubyCount(textOf(i)) }));
        extras = extras.filter(i => {
            const k = variantKey(textOf(i));
            if (!k) return true;
            return !sides.some(s => s.key === k && rubyCount(textOf(i)) <= s.ruby);
        });

        const byContent = new Map();
        for (const i of extras) {
            const key = variantKey(textOf(i));
            if (!key) { byContent.set(`#${i}`, i); continue; }
            const held = byContent.get(key);
            if (held === undefined || rubyCount(textOf(i)) > rubyCount(textOf(held))) byContent.set(key, i);
        }
        const keep = new Set(byContent.values());
        extras = extras.filter(i => keep.has(i));
    }

    // **The word's own reading must be the FIRST supporting line.**
    // `splitWordReading` (src/utils/cardText.ts) inspects only the first line of
    // `extra` when deciding whether to lift a reading onto the word as furigana,
    // so leaving these in template order — where that deck puts the sentence first
    // — silently switches that off and puts a loose kana line back above the
    // example. Our `extra` is not Anki's back face and does not owe it a reading
    // order; it owes the renderer its contract. Everything else keeps the
    // author's ordering, which is what a deck this cannot classify falls back to.
    extras.sort((a, b) => readingFirst(fieldNames[a]) - readingFirst(fieldNames[b]));

    // **What else the author put on the QUESTION, kept as a fact rather than
    // re-derived later.** One question template is `{{Word}}` followed by
    // `{{Sentence}}`: the example sentence is on the FRONT, which is why Anki
    // shows it there and why the learner is reading the word in use before
    // recalling the gloss. Flattening everything but `front` into `extras` —
    // one answer-side block — and recovering the question side by matching the
    // word against the sentence is a guess standing in for something the file
    // states outright, and it fails exactly where a guess fails: する
    // conjugates to します, shares no prefix with its own dictionary form, and
    // the sentence is lost. These indices stay in `extras` as well, because a
    // template
    // legitimately prints the same content on both faces (that deck's back carries
    // `Sentence Furigana`) and the variant collapse above already decides what
    // the answer keeps.
    const frontExtras = question.slice(1).map(r => r.i).filter(i => i !== backIdx);

    return { front: frontIdx, back: backIdx, extras, frontExtras };
}
