// server/ankiImport.js — bring an Anki deck in, honestly.
//
// This is not a feature so much as a front door. Someone arriving with a deck
// they have been building for years has content the moment they land, instead
// of an empty library and a wait on a model. That is the whole argument for it.
//
// ## The contract: never silently lose a card
//
// The failure mode that matters is not a crash — it is importing 2,000 cards,
// producing 1,400, and saying nothing. Every note that does not become a
// flashcard is counted with a REASON, and the reasons are surfaced. A visible
// refusal is always better than a quiet drop, because a quiet drop is only
// discovered months later when the thing you meant to study never comes up.
//
// ## What .apkg actually is, and the five traps in it
//
// A zip holding a SQLite collection plus media. Five things bite:
//
//  1. **Two schemas.** Up to Anki 2.1.27 the collection is "schema 11": one
//     `col` row with `models` and `decks` as JSON blobs. From 2.1.28 it is
//     "schema 18": real `notetypes` / `fields` / `decks` tables, and `col.models`
//     is left empty. Both are in the wild; a reader that knows one silently sees
//     zero note types on the other.
//  2. **The legacy stub.** A modern export contains BOTH `collection.anki21b`
//     (the real data, zstd-compressed) and `collection.anki2` — the latter being
//     an empty placeholder that exists only so old Anki versions fail politely.
//     Opening the first file that matches a familiar name gets you a valid,
//     parseable, EMPTY collection and a cheerful "0 cards found". So the
//     candidates are tried newest-first, and a collection with zero notes is
//     never accepted while an unread newer candidate remains.
//  3. **The deck separator changed.** Schema 11 writes `Parent::Child`; schema
//     18 writes them joined by `\x1f`. Miss it and every nested deck imports as
//     one flat name with an invisible control character in it.
//  4. **`notetypes.config` is protobuf** — and so is `templates.config`, which
//     is why this file long claimed the card templates were unreadable. Half
//     wrong: `qfmt` and `afmt` are plain UTF-8 as length-delimited fields 1 and
//     2 inside that blob, and `ankiTemplates.js` walks it with no dependency.
//     Field names still come from the plain `fields` table, and "is this a cloze
//     note" is still decided by looking for `{{c1::` in the text —
//     format-independent, and true regardless of how the note type was
//     configured.
//
//  5. **The media index changed format too.** Legacy `media` is a JSON map
//     `{"0":"cat.jpg"}` over uncompressed zip entries; the current format makes
//     it a zstd-compressed protobuf and compresses every entry individually.
//     See `ankiMedia.js`, which owns that half.
//
// ## Scheduling comes across, and it costs nothing
//
// Anki's default scheduler is SM-2 and stores `ivl` (days) and `factor` (ease
// x1000) per card — which is exactly the pair `src/utils/srs.ts` already knows
// how to migrate into an FSRS seed. So a deck arrives with its review history
// intact and the learner does not restart three years of work. This fell out of
// the FSRS swap for free; before it, there was nothing to carry the state into.

import JSZip from 'jszip';
import { zstdDecompressSync } from './zstd.js';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import db from './database.js';
import { extractMedia } from './ankiMedia.js';
import { mapNoteFields } from './ankiFields.js';
import { readCardTemplates, templateSides } from './ankiTemplates.js';
import { planStages } from './deckStructure.js';
import { roleForStage, ROLE_TOPIC } from './nodeRole.js';
import { sanitizeUrl } from './urlSafety.js';
import { mediaStorage } from './vaultStorage.js';

// Collection candidates, newest first. Order is load-bearing — see trap 2.
const COLLECTION_CANDIDATES = [
    { name: 'collection.anki21b', zstd: true },
    { name: 'collection.anki21', zstd: false },
    { name: 'collection.anki2', zstd: false },
];

const FIELD_SEP = '\x1f';

/** Why a note did not become a flashcard. Counted, never swallowed. */
import { importAnkiRevlog } from './reviewLog.js';

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

// Numeric character references, both bases: the fields a deck's TEMPLATE points
// at carry the hex form, and a decimal-only parser leaves `&#x27;` standing in
// the text ("the poet&#x27;s feelings" on one real poem deck). The pair
// `fromCodePoint`/`&#x` also fixes astral characters, which `fromCharCode`
// silently truncates.
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
 * The label of a link, in the `[label](url)` convention.
 *
 * Brackets and newlines come out because they are the convention's own
 * delimiters, and an empty label falls back to the word "Link" rather than
 * emitting `[](url)`, which reads as nothing at all.
 */
function linkLabel(inner) {
    const text = decodeEntities(String(inner ?? '').replace(/<[^>]+>/g, ' '))
        .replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
    return text || 'Link';
}

/**
 * The target, or null when it cannot safely become one.
 *
 * `sanitizeUrl` is the same guard the course importer applies, and for the same
 * reason: this string ends up in an `href`, where a `javascript:` URL is script
 * execution in the app's own origin. The closing paren is percent-encoded
 * because it would otherwise end the convention's own `(…)`.
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
 * A template's `<a href>` is the one piece of static content that carries
 * information rather than presentation, and a deck builds it from the fields:
 * the phrasebook's answer ends in `<a href="https://en.wikipedia.org/w/index.php
 * ?search={{Language}} language">About language</a>`, so every French card
 * links to the article on French. `parseTemplate` deliberately ignores a field
 * reference inside a tag — printed as content, a `{{NoteID}}` in an href lands
 * under the answer as a bare number — but used as the URL it was written for,
 * the same reference is exactly right. Each field is URL-encoded from its plain
 * text; a link whose field is empty on this note is not a link and is skipped;
 * `linkTarget` applies the same guard every other href here passes through.
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
 * The deck says "Khan Academy Video" and "Khan Academy Article" over two links
 * to the same site, so the LABEL knows what the host cannot. Everything
 * unrecognised is an article, which is what `normalizeResourceType` already
 * falls back to — an unknown link is a thing to read until something says
 * otherwise.
 */
const VIDEO_HOST = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|bilibili\.com|dailymotion\.com)$/i;
function linkResourceType({ label, url }) {
    if (/\b(video|watch|lecture|playlist)\b/i.test(label)) return 'video';
    try { if (VIDEO_HOST.test(new URL(url).hostname)) return 'video'; } catch { /* label decides */ }
    if (/\b(exercise|practice|quiz|problem)s?\b/i.test(label)) return 'practice';
    return 'article';
}

// A deck cannot be allowed to turn one topic into a wall of bookmarks, and the
// per-node cap is what bounds that without needing to know anything about the
// deck. Both are far above what a real deck produces (a measured maths deck's
// busiest topic carries 31).
const MAX_LINKS_PER_NODE = 60;
const MAX_LINKS_TOTAL = 5000;

/** One attribute out of a tag, quoted or not, with entities decoded. */
function attr(tag, name) {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

/**
 * Anki fields are HTML. Turn one into the plain text a flashcard front/back is,
 * and collect the media it referenced.
 *
 * The references are the filenames Anki wrote — `<img src="cat.jpg">` and
 * `[sound:neko.mp3]`. They are resolved against the deck's media index later
 * (see ankiMedia.js); a name that does not resolve is counted, never guessed at.
 *
 * `alt` is kept when the deck's author wrote one. It is the only description of
 * a picture that came from a human, so it outranks anything a model would later
 * be asked to invent, and it is what a screen reader reads.
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

    // **A clip belongs to the line it was written on, and that is kept.** The
    // phrasebook writes `Adiós[sound:a.mp3]<br>Hasta luego[sound:b.mp3]…`:
    // one clip per translation, placed by the author. Stripping the tags and
    // pooling the clips under the card gave four identical buttons numbered
    // 1–4 with nothing saying which said what. Each `[sound:…]` is swapped for
    // a sentinel that rides through the rest of the stripping, and once the
    // text is final the line each sentinel landed on is recorded as `at` — the
    // plain line as it will appear on the card, so the renderer can put the
    // clip beside it. A clip on a line of its own has no anchor and stays in
    // the row under the card, as before.
    let soundIndex = 0;
    s = s.replace(/\[sound:([^\]]*)\]/gi, (_, f) => (decodeEntities(f).trim() ? `\u0002${soundIndex++}\u0002` : ' '));
    s = s.replace(IMG_RE, ' ');
    // **A link is content, and dropping the href left a card telling the learner
    // to watch a video it would not name.** One maths deck writes 406 of them
    // across 199 of its 263 notes — Khan Academy and 3Blue1Brown — and the whole
    // of one field is often nothing but links, so stripping the `<a>` and
    // keeping its text produced a supporting line reading "Khan Academy Video"
    // with no way to reach it. Kept as `[text](url)`, a third convention in the
    // same plain text that already carries `**word**` and `漢字[かな]`, parsed
    // and rendered by `src/utils/cardText.ts` — the columns stay plain, and the
    // string handed to search, the tutor and text-to-speech still reduces to the
    // label alone (`stripCardMarkup`).
    s = s.replace(A_RE, (whole, inner) => {
        const url = linkTarget(attr(whole, 'href'));
        // An unusable target keeps the words and loses the link, which is what
        // this did for every link before now: a label is still information.
        if (!url) return inner;
        return `[${linkLabel(inner)}](${url})`;
    });
    // One word marked out inside a sentence is most of the reason the sentence
    // is on the card at all: Anki's own templates bold the target word in the
    // example, and stripping that left the learner hunting for the word being
    // taught. Kept as `**…**` — a marker `src/utils/cardText.ts` renders and
    // CommonMark structurally cannot (its flanking rules refuse to open `**`
    // between two letters, and Japanese writes no spaces), which is why this is
    // a convention of ours over plain text rather than markdown.
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
    // Emphasis covering the whole field emphasises nothing, and a great many
    // decks bold their entire answer — so those markers come back off. What is
    // kept is emphasis that picks something OUT of a longer line.
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
        // A clip written on a line of its own under a one-line field belongs
        // to that line: the phrasebook's answer is `Adiós<br>[sound:…]`, and
        // Anki draws the button directly under the word. Only when the field
        // has ONE line, though — under several the author's placement is the
        // only evidence there is, and a guess would put a clip on the wrong one.
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
 * One cloze deletion becomes one flashcard: the target number is blanked on the
 * front and revealed on the back, and every OTHER deletion is shown as its
 * plain answer in both — which is what Anki does when it renders the card, and
 * what makes the sentence readable rather than a row of dashes.
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

// ---- reading the collection -------------------------------------------------

async function loadCollectionDb(zip, workDir) {
    let lastEmpty = null;
    for (const cand of COLLECTION_CANDIDATES) {
        const entry = zip.file(cand.name);
        if (!entry) continue;
        let bytes = Buffer.from(await entry.async('nodebuffer'));
        if (cand.zstd) {
            try { bytes = Buffer.from(zstdDecompressSync(bytes)); } catch (err) {
                throw new Error(`This deck's collection is compressed in a way we could not read (${err.message}).`);
            }
        }
        const path = join(workDir, `col-${cand.name}.sqlite`);
        writeFileSync(path, bytes);
        let handle;
        try {
            handle = new Database(path, { readonly: true, fileMustExist: true });
            const n = handle.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
            // Trap 2: a modern export ships an EMPTY collection.anki2 next to the
            // real one. An empty collection is only accepted once every newer
            // candidate has been tried and found missing.
            if (n === 0) { lastEmpty = { handle, path, cand }; continue; }
            return { handle, path, schemaFile: cand.name };
        } catch (err) {
            try { handle?.close(); } catch { }
            throw new Error(`This file's collection could not be opened (${err.message}).`);
        }
    }
    if (lastEmpty) return { handle: lastEmpty.handle, path: lastEmpty.path, schemaFile: lastEmpty.cand.name, empty: true };
    throw new Error('No Anki collection was found inside this file. Is it an .apkg exported from Anki?');
}

const hasTable = (handle, name) => !!handle.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
).get(name);

/** Deck id → display path, with both separators normalised to `::`. */
function readDecks(handle) {
    const out = new Map();
    if (hasTable(handle, 'decks') && handle.prepare("SELECT COUNT(*) n FROM pragma_table_info('decks') WHERE name='name'").get().n) {
        for (const row of handle.prepare('SELECT id, name FROM decks').all()) {
            // Trap 3: schema 18 joins deck levels with \x1f, not `::`.
            out.set(Number(row.id), String(row.name ?? '').split(FIELD_SEP).join('::'));
        }
        if (out.size) return out;
    }
    try {
        const raw = handle.prepare('SELECT decks FROM col LIMIT 1').get()?.decks;
        const parsed = JSON.parse(raw || '{}');
        for (const [id, d] of Object.entries(parsed)) out.set(Number(id), String(d?.name ?? '').split(FIELD_SEP).join('::'));
    } catch { /* no legacy blob — an empty map means "Imported deck" below */ }
    return out;
}

/** Note type id → { name, fields[] }. Never touches the protobuf config. */
function readNoteTypes(handle) {
    const out = new Map();
    if (hasTable(handle, 'notetypes') && hasTable(handle, 'fields')) {
        for (const nt of handle.prepare('SELECT id, name FROM notetypes').all()) {
            const fields = handle.prepare('SELECT name FROM fields WHERE ntid = ? ORDER BY ord').all(nt.id).map(f => f.name);
            out.set(Number(nt.id), { name: String(nt.name ?? 'Note'), fields });
        }
        if (out.size) return out;
    }
    try {
        const parsed = JSON.parse(handle.prepare('SELECT models FROM col LIMIT 1').get()?.models || '{}');
        for (const [id, m] of Object.entries(parsed)) {
            out.set(Number(id), {
                name: String(m?.name ?? 'Note'),
                fields: Array.isArray(m?.flds) ? m.flds.map(f => String(f?.name ?? '')) : [],
            });
        }
    } catch { /* both sources absent — fields fall back to positional below */ }
    return out;
}

// ---- mapping ----------------------------------------------------------------

/**
 * Pick the question and answer fields for a non-cloze note.
 *
 * Anki has no notion of "the front field" that survives export intact (the
 * templates that define it are protobuf in schema 18), so this is positional
 * with a nudge: the first non-empty field is the question and the next non-empty
 * one is the answer, which is what the overwhelming majority of note types do.
 * The learner gets a one-toggle override in the UI rather than a field-mapping
 * matrix, because the only error this makes is a reversed pair and that is
 * obvious the moment they see a sample card.
 */
function pickFrontBack(values, names = []) {
    // Field NAMES first (see ankiFields.js — "Word Meaning" is the answer to
    // "Word", and position never knew that), position as the fallback for a
    // deck whose names say nothing.
    const mapped = mapNoteFields(values, names);
    if (mapped) {
        return {
            front: { v: values[mapped.front], i: mapped.front },
            back: { v: values[mapped.back], i: mapped.back },
            extras: mapped.extras,
        };
    }

    // "Non-empty" counts media as content now that media is imported. That one
    // word is what makes a picture-first deck work: its question field holds an
    // `<img>` and nothing else, and while media was being dropped such a note
    // had no question at all and was correctly refused.
    const nonEmpty = values.map((v, i) => ({ v, i })).filter(x => hasContent(x.v));
    if (nonEmpty.length === 0) return null;
    if (nonEmpty.length === 1) return { front: nonEmpty[0], back: null, extras: [] };
    return { front: nonEmpty[0], back: nonEmpty[1], extras: [] };
}

const refsOf = (v) => [...(v?.images ?? []), ...(v?.sounds ?? [])];
const hasContent = (v) => !!(v?.text || refsOf(v).length);

/**
 * Parse an .apkg buffer into everything the import screen needs to show BEFORE
 * the learner commits to anything.
 */
export async function parseApkg(buffer, { importMedia = true, onProgress } = {}) {
    const workDir = mkdtempSync(join(tmpdir(), 'anki-import-'));
    let handle = null;
    try {
        let zip;
        try {
            zip = await JSZip.loadAsync(buffer);
        } catch (err) {
            throw new Error('That file is not a readable .apkg (it could not be unzipped).');
        }

        const loaded = await loadCollectionDb(zip, workDir);
        handle = loaded.handle;

        const decks = readDecks(handle);
        const noteTypes = readNoteTypes(handle);
        // What the deck's author said goes on each side, per card template. The
        // name-based mapping below stays as the fallback for a template this
        // cannot resolve — see ankiTemplates.js for why a template beats a
        // guess, and for why the templates' HTML is deliberately not rendered.
        const cardTemplates = readCardTemplates(handle);

        // Card rows carry the deck, the scheduling, and — the part that used to
        // be dropped — the deck's own ORDER.
        //
        // `due` means two different things depending on `type`: on a NEW card
        // (type 0) it is the card's position in the new-card queue, i.e. exactly
        // the sequence the deck's author intends it to be studied in; on a card
        // that has graduated it is a due date and says nothing about order.
        // Measured on a real 1.5k-card export, that position is a unique run
        // from 3 to 1504 across all 1,458 new cards — a complete, author-written
        // ordering that this importer was throwing away, which is why an
        // imported deck had no structure to give the rest of the engine.
        const cardRows = handle.prepare(`
            SELECT id, nid, did, ord, ivl, factor, reps, lapses, due, type
            FROM cards ORDER BY nid, ord
        `).all();
        const cardsByNote = new Map();
        for (const c of cardRows) {
            if (!cardsByNote.has(c.nid)) cardsByNote.set(c.nid, []);
            cardsByNote.get(c.nid).push(c);
        }

        const noteRows = handle.prepare('SELECT id, mid, flds, tags FROM notes').all();

        const out = [];
        const skipped = [];
        let withImages = 0, withSounds = 0;
        const deckCounts = new Map();
        const typeCounts = new Map();
        // Only files a note actually references are extracted. A deck usually
        // carries orphans — Anki prunes unused media only on an explicit "Check
        // Media" — and writing those to disk spends space on files nothing can
        // ever display.
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
            // The new-card queue position, when this card still has one. A card
            // that has been studied has spent its position (Anki reuses `due` as
            // a date once a card graduates), so it reports null and sorts by
            // note id instead — see `compareCards` in deckStructure.js.
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
                    // Anki's own card id, so the deck's review history (revlog)
                    // can be attached to the flashcard this card becomes.
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

            // Media in a field that became neither the question nor the answer
            // still belongs to the note, and on the overwhelmingly common deck
            // shape it is the whole reason the deck has media at all: a
            // vocabulary deck answers "Word" with "Word Reading" and keeps the picture, the
            // word audio and the sentence audio in three FURTHER fields, so a
            // rule that only looked at the two chosen fields would import 1,500
            // cards and 0 of the 4,354 files. Unused media goes to the ANSWER
            // side — it is supplementary by definition, and a picture on the
            // question side of a card the author did not build that way can give
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

                // The card templates a cloze note type defines are all one
                // template (Anki makes one card per deletion, not per template),
                // so ordinal 0 is the whole of what the author said.
                const clozeTmpl = (cardTemplates.get(Number(note.mid)) ?? [])[0];
                const clozeSides = templateSides(
                    clozeTmpl, model?.fields ?? [],
                    (i) => hasContent(values[i]),
                    (i) => values[i]?.text ?? '',
                );
                // Image occlusion writes its rectangles into the note as cloze
                // deletions (`{{c1::image-occlusion:rect:left=...}}`), so it
                // reaches this branch before anything else can refuse it — and
                // expanding one yields a question of `[...] [...]` answered by
                // a coordinate list. The template is the reliable signal; the
                // marker in the text is the belt for a note type this cannot
                // read.
                if (clozeSides?.unsupported || /image-occlusion:/i.test(source)) {
                    skipped.push({ note: note.id, reason: SKIP_REASONS.UNSUPPORTED });
                    continue;
                }
                // Everything the author printed under the answer — see
                // `templateSides`. Without it a cloze card is the sentence and
                // nothing else, which on a real maths deck meant every card
                // lost its worked formula, its diagram and its link out.
                // These fields stay OUT of `usedFields`: that set exists only to
                // keep the cloze sentence's own media off the answer, and a
                // supporting line's diagram is exactly the media the answer
                // wants. Marking them used dropped the picture from every
                // explanation that carried one.
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
                        // The cloze sentence's own media stays with the sentence,
                        // which is on both sides; it rides the front so a
                        // listening prompt is heard before the reveal.
                        media: { front: refsOf(f), back: [...refsOf(b), ...spareRefs] },
                    });
                }
                continue;
            }

            // ---- one card per CARD, not one card per note --------------------
            //
            // A note type may define several card templates, and "Basic (and
            // reversed card)" — one of the six that ship with every Anki
            // collection — defines two. This loop used to emit ord 0 and stop,
            // so a reversed deck imported at exactly half its size, silently,
            // and the scheduling history of every reverse card was discarded
            // with it.
            //
            // The ordinals come from the `cards` table rather than from the
            // template list, which is what makes conditional generation free:
            // "Basic (optional reversed card)" only produces its second card
            // when the note filled `Add Reverse`, and Anki has already applied
            // that rule — the existence of the row IS the evaluated condition,
            // so `{{#Add Reverse}}` never has to be interpreted here.
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

                // A scripted template (Image Occlusion draws its answer on a
                // canvas) has no text to extract, and inventing one would ship a
                // card whose answer is the word "Image".
                if (sides?.unsupported) {
                    skipped.push({ note: note.id, reason: SKIP_REASONS.UNSUPPORTED });
                    continue;
                }

                let front, back, extraIdx, frontExtraIdx = [];
                if (sides && !sides.cloze) {
                    ({ front, back } = sides);
                    extraIdx = sides.extras;
                    // What the AUTHOR put on the question beside the word. The
                    // name-based fallback below cannot know this — no field name
                    // records which side it is printed on — so it stays empty
                    // there and the client falls back to inferring one line.
                    frontExtraIdx = sides.frontExtras ?? [];
                } else if (emitted === 0) {
                    // No usable template: the name-based mapping, exactly as
                    // before this module existed. Only the first ordinal may
                    // fall back — running it again for ord 1 would emit a
                    // duplicate of ord 0 rather than the reverse card.
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
                    // A second card this cannot characterise is still counted.
                    // No card may disappear without a reason — that is the whole
                    // contract the skipped list exists to keep.
                    skipped.push({ note: note.id, reason: SKIP_REASONS.UNSUPPORTED });
                    continue;
                }

                // Media in a field that is not one of the two SIDES rides the
                // answer — and "side" means front or back only, never a
                // supporting line. Reading the templates made this load-bearing:
                // one answer template references `{{Word Audio}}`,
                // `{{Sentence Audio}}` and `{{Picture}}`, so those fields became
                // `extras`, and excluding extras from the spare sweep (which is
                // what the pre-template code did, safely, because the name-based
                // mapping only ever promoted TEXT roles) silently dropped all
                // 4,354 of the deck's media files. A supporting line carrying an
                // image keeps it now too, which the old rule also quietly lost.
                const spareRefs = values.flatMap((v, i) => (i === front || i === back ? [] : refsOf(v)));

                // The supporting lines — the reading, the example sentence and
                // its translation. Anki's own template shows these under the
                // answer; dropping them turned a vocabulary card into a two-word
                // stub. They are NOT part of the answer, so they live in their
                // own column rather than being glued onto `back`.
                // ...plus the links the template itself writes under the
                // answer, filled in with this note's fields — see
                // `templateLinkLines`. Last, where the author put them.
                const templateLinks = (sides && !sides.cloze)
                    ? templateLinkLines(tmpl?.afmt, model?.fields ?? [], (i) => values[i]?.text ?? '')
                    : [];
                const extra = [...extraIdx.map(i => values[i].text), ...templateLinks].filter(Boolean).join('\n');
                // The question's own supporting lines, in the order the template
                // prints them. Verbatim: whatever the author chose to show
                // before the answer is what the learner sees, readings and all.
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

        // ---- media ----------------------------------------------------------
        //
        // Extraction happens HERE, at inspect time, not at commit: the bytes go
        // straight from the zip into the content-addressed store and are never
        // held, which is the property that lets a 108 MB deck be previewed
        // without sitting in memory. What is staged afterwards is a list of
        // hashes. A cancelled or expired import therefore leaves blobs nothing
        // references, which is what `sweepOrphanMedia` is for — content
        // addressing makes that safe, since an identical file re-imported later
        // resolves to the same hash it already had.
        let mediaFiles = new Map(), mediaSkipped = [], mediaFormat = 'none', mediaBytes = 0;
        if (importMedia && wantedMedia.size) {
            ({ files: mediaFiles, skipped: mediaSkipped, format: mediaFormat, bytes: mediaBytes } =
                await extractMedia(zip, [...wantedMedia], { onProgress }));
        }

        // Resolve every reference to a stored blob, and drop the ones that did
        // not resolve rather than leaving a card pointing at nothing.
        let attached = 0, unresolved = 0;
        const seenHashes = new Map();
        for (const card of out) {
            for (const side of ['front', 'back']) {
                const refs = card.media?.[side] ?? [];
                const kept = [];
                // The unresolved references survive beside the resolved ones
                // (`mediaRefs`): a parse without media extraction still knows
                // which file sat on which line, which is what lets
                // `tools/anki-refresh-text.mjs` re-anchor the clips of a deck
                // imported before `at` existed without re-extracting 100 MB.
                card.mediaRefs = card.mediaRefs || {};
                card.mediaRefs[side] = refs.map(r => ({ file: r.file, kind: r.kind, at: r.at || '' }));
                for (const ref of refs) {
                    const found = mediaFiles.get(ref.file);
                    if (!found) { unresolved++; continue; }
                    kept.push({ hash: found.hash, kind: found.kind, name: found.filename, alt: ref.alt || '',
                        ...(ref.at ? { at: ref.at } : {}) });
                    attached++;
                    if (!seenHashes.has(found.hash)) seenHashes.set(found.hash, { ...found, alt: ref.alt || '' });
                    else if (ref.alt && !seenHashes.get(found.hash).alt) seenHashes.get(found.hash).alt = ref.alt;
                }
                card.media[side] = kept;
            }
        }

        // A side is allowed to be a picture with no words — that is what makes a
        // picture-first deck importable at all. It is NOT allowed to be empty:
        // if the file a media-only side depended on did not resolve (the deck
        // references it and the zip does not contain it), the card would ship
        // with a blank question, which is exactly the silent loss this importer
        // exists to prevent. So that card is dropped here, with a reason, and it
        // shows up in the same count as every other refusal.
        for (let i = out.length - 1; i >= 0; i--) {
            const c = out[i];
            const blank = (text, refs) => !text && refs.length === 0;
            if (blank(c.front, c.media.front) || blank(c.back, c.media.back)) {
                skipped.push({ note: null, reason: SKIP_REASONS.MEDIA_ONLY });
                const n = deckCounts.get(c.deck);
                if (n) deckCounts.set(c.deck, n - 1);
                out.splice(i, 1);
            }
        }
        for (const [name, n] of [...deckCounts]) if (n <= 0) deckCounts.delete(name);

        const withMediaCards = out.filter(c => c.media.front.length || c.media.back.length).length;
        // Counted here rather than at commit so the preview can promise it. The
        // unique count is the honest one: that deck's 406 anchors are
        // 88 distinct pages, because a Khan Academy unit is linked from every
        // card in it.
        const allLinks = new Set();
        let cardsWithLinks = 0;
        for (const c of out) {
            const links = linksOfCard(c);
            if (links.length) cardsWithLinks++;
            for (const l of links) allLinks.add(l.url);
        }
        const images = [...seenHashes.values()].filter(f => f.kind === 'image').length;
        const sounds = [...seenHashes.values()].filter(f => f.kind === 'audio').length;

        const warnings = [];
        if (!importMedia && (withImages || withSounds)) {
            warnings.push('Pictures and audio were left out of this import at your request.');
        } else if (mediaFormat === 'unreadable' && (withImages || withSounds)) {
            warnings.push('This deck’s media index could not be read, so the pictures and audio did not come across — the text did.');
        } else {
            if (unresolved) warnings.push(`${unresolved} ${unresolved === 1 ? 'picture or clip is' : 'pictures or clips are'} referenced by a card but missing from the file itself.`);
            if (mediaSkipped.length) {
                const why = mediaSkipped.reduce((a, m) => { a[m.reason] = (a[m.reason] ?? 0) + 1; return a; }, {});
                warnings.push(`${mediaSkipped.length} media ${mediaSkipped.length === 1 ? 'file was' : 'files were'} left out: ${Object.entries(why).map(([r, n]) => `${n} ${r}`).join(', ')}.`);
            }
        }
        if (loaded.empty) warnings.push('This collection appears to be empty.');

        // The deck's review HISTORY, which the importer used to discard. Anki
        // keeps one `revlog` row per answer; with it an imported card carries
        // its real past into the review log (server/reviewLog.js) instead of a
        // stamp, and the optimiser has something to fit on from day one.
        // `type = 4` is a manual reschedule with no answer given — skipped, as
        // Anki's own optimiser skips it. Read here rather than at commit
        // because the collection file is closed at the end of inspect.
        let revlog = [];
        if (hasTable(handle, 'revlog')) {
            try {
                revlog = handle.prepare(
                    'SELECT id, cid, ease, ivl, lastIvl, type FROM revlog WHERE type != 4 ORDER BY cid, id'
                ).all();
            } catch { revlog = []; }
        }
        const cardsWithHistory = new Set(revlog.map(r => r.cid)).size;

        return {
            cards: out,
            revlog,
            skipped,
            schemaFile: loaded.schemaFile,
            media: [...seenHashes.values()],
            stats: {
                notes: noteRows.length,
                cards: out.length,
                reviews: revlog.length,
                cardsWithHistory,
                skipped: skipped.length,
                withImages,
                withSounds,
                mediaFormat,
                mediaFiles: seenHashes.size,
                mediaImages: images,
                mediaSounds: sounds,
                mediaBytes,
                mediaAttached: attached,
                mediaUnresolved: unresolved,
                mediaSkipped: mediaSkipped.length,
                cardsWithMedia: withMediaCards,
                links: allLinks.size,
                cardsWithLinks,
                // How many stages each deck will become, computed by the SAME
                // function that will do the cutting at commit time (never a
                // second copy of the rule on the client). The import screen's
                // standing rule is to show a consequence before asking for a
                // decision, and "1,501 cards" vs "1,501 cards in 30 stages" are
                // different things to agree to.
                decks: [...deckCounts.entries()].map(([name, count]) => ({
                    name,
                    count,
                    stages: planStages(out.filter(c => (c.deck || 'Imported') === name), { deckName: name }).length,
                })).sort((a, b) => a.name.localeCompare(b.name)),
                noteTypes: [...typeCounts.entries()].map(([name, count]) => ({ name, count }))
                    .sort((a, b) => b.count - a.count),
                skipReasons: skipped.reduce((acc, s) => { acc[s.reason] = (acc[s.reason] ?? 0) + 1; return acc; }, {}),
            },
            warnings,
        };
    } finally {
        try { handle?.close(); } catch { }
        try { rmSync(workDir, { recursive: true, force: true }); } catch { }
    }
}

/**
 * A preview the import screen can render before anything is written: the deck
 * tree with counts, the warnings, and REAL sample cards.
 *
 * Samples are the single most valuable thing on that screen. The one mistake
 * positional field-picking can make is a reversed front/back, and no amount of
 * explaining beats showing three actual cards — the learner spots it instantly
 * and flips one toggle.
 */
export function buildPreview(parsed, { samples = 3 } = {}) {
    const pool = parsed.cards;
    const picks = [];
    if (pool.length) {
        // Spread across the deck rather than taking the first three, which in a
        // sorted collection are all the same shape.
        for (let i = 0; i < Math.min(samples, pool.length); i++) {
            picks.push(pool[Math.floor(((i + 0.5) * pool.length) / Math.min(samples, pool.length))]);
        }
    }
    return {
        stats: parsed.stats,
        warnings: parsed.warnings,
        samples: picks.map(c => ({
            front: c.front.slice(0, 400), back: c.back.slice(0, 400),
            extra: (c.extra || '').slice(0, 400),
            deck: c.deck, cloze: c.cloze, noteType: c.noteType,
            // The sample cards carry their real media. The blobs are already
            // stored by the time a preview exists, so these render from the
            // same URL the imported card will use — the learner sees the actual
            // picture and hears the actual clip before committing to anything,
            // which is the only way "your cards, plus what this app adds" is a
            // claim they can check rather than one they have to believe.
            media: c.media ?? { front: [], back: [] },
        })),
        suggestedName: suggestProjectName(parsed),
    };
}

/**
 * The project's Overview, written from what the file actually contained.
 *
 * "Imported from Anki — 1501 cards." was true and told the learner nothing they
 * could not see in the header. What is worth saying is what came ACROSS, since
 * the whole promise of this importer is that nothing was silently dropped: the
 * cards, the media, and whether the review history survived.
 */
export function describeDeck(parsed) {
    const s = parsed.stats;
    const bits = [`${s.cards.toLocaleString('en-US')} cards imported from Anki`];
    if (s.decks?.length > 1) bits.push(`across ${s.decks.length} decks`);
    const media = [];
    if (s.mediaImages) media.push(`${s.mediaImages.toLocaleString('en-US')} pictures`);
    if (s.mediaSounds) media.push(`${s.mediaSounds.toLocaleString('en-US')} audio clips`);
    if (media.length) bits.push(`with ${media.join(' and ')}`);
    let out = `${bits.join(' ')}.`;
    if (s.skipped) out += ` ${s.skipped} note${s.skipped === 1 ? '' : 's'} could not be turned into a card.`;
    return out;
}

/** The deck name the learner would have called this, if there is one. */
export function suggestProjectName(parsed) {
    const names = parsed.stats.decks.map(d => d.name).filter(n => n && n !== 'Imported');
    if (names.length === 0) return 'Imported deck';
    const tops = new Set(names.map(n => n.split('::')[0]));
    // A single top-level deck names the project; several means the file holds a
    // whole collection and no one deck speaks for it.
    return tops.size === 1 ? [...tops][0] : 'Imported collection';
}

// ---- staging ----------------------------------------------------------------
//
// Parse once, show the preview, commit later — the two-phase shape is what lets
// the screen show consequences before asking for decisions. Only the extracted
// TEXT is held, never the uploaded zip, so a 400 MB deck with media does not sit
// in memory while somebody reads a preview.

const STAGING_TTL_MS = 30 * 60 * 1000;
const staging = new Map();

export function stageImport(parsed) {
    const id = randomUUID();
    // Hash -> descriptor, so the preview's media can be SERVED. See
    // findStagedMedia below for why this index has to exist.
    const byHash = new Map();
    for (const m of parsed.media ?? []) byHash.set(m.hash, m);
    staging.set(id, { parsed, byHash, at: Date.now() });
    for (const [key, val] of staging) {
        if (Date.now() - val.at > STAGING_TTL_MS) staging.delete(key);
    }
    return id;
}

export function getStaged(id) {
    const row = staging.get(id);
    if (!row) return null;
    if (Date.now() - row.at > STAGING_TTL_MS) { staging.delete(id); return null; }
    return row.parsed;
}

/**
 * A staged import's media, by hash.
 *
 * `GET /api/media/:hash` resolves a hash through `media_files` — deliberately,
 * so a URL can never address bytes the database does not know about. But those
 * rows are written at COMMIT, while the blobs are written at INSPECT, and the
 * preview sits between the two: every sample card rendered "missing from the
 * media store" for its pictures, and would have failed on the first play of a
 * clip (`preload="none"` merely postponed the same 404). The preview is the one
 * screen whose entire job is to show what the import will produce, so serving it
 * placeholders is the specific failure that matters here.
 *
 * A staging record is the same warrant a row is: this server extracted these
 * bytes, in this session, and sniffed that mime off the bytes themselves. It
 * expires with the staging record, so the extra reach is bounded by the TTL.
 */
export function findStagedMedia(hash) {
    for (const [key, row] of staging) {
        if (Date.now() - row.at > STAGING_TTL_MS) { staging.delete(key); continue; }
        const hit = row.byHash?.get(hash);
        if (hit) return hit;
    }
    return null;
}

export function dropStaged(id) { staging.delete(id); }

// ---- committing -------------------------------------------------------------

/**
 * Write a staged import into a NEW project.
 *
 * Always a new project, never merged into an existing one, and that is the undo
 * story: deleting the project cascades to every node and flashcard the import
 * created, so "Undo import" is one delete rather than a reconciliation. An
 * importer without a clean undo makes trying it a risk, and then nobody tries it.
 */
export function commitImport(parsed, {
    projectName, swapFrontBack = false, keepSchedule = true, color = '#3B82F6',
    includeMedia = true,
} = {}) {
    const name = (projectName || suggestProjectName(parsed)).slice(0, 200);

    const insertProject = db.prepare(
        'INSERT INTO projects (name, description, color, icon, position, kind) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertNode = db.prepare(
        'INSERT INTO nodes (project_id, parent_id, title, description, position, role) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertCard = db.prepare(`
        INSERT INTO flashcards (node_id, front, back, extra, extra_front, difficulty, last_interval, ease_factor,
                                review_count, lapses, next_review, last_reviewed, media)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMedia = db.prepare(`
        INSERT OR IGNORE INTO media_files (project_id, hash, filename, mime, kind, size, description, described_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertResource = db.prepare(
        'INSERT INTO resources (node_id, title, url, type, position) VALUES (?, ?, ?, ?, ?)'
    );

    const run = db.transaction(() => {
        const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM projects').get().p;
        const projectId = insertProject.run(
            // A deck is not a folder, and the projects grid is a wall of icons —
            // the one glance that says "these two are courses and that one is a
            // card collection" costs nothing to get right at import.
            name, describeDeck(parsed), color, 'book', pos, 'deck',
        ).lastInsertRowid;

        // Deck path -> node id, creating each level once. `A::B::C` becomes three
        // nested topics, which is what makes an imported deck work with the rest
        // of the engine (feed, mastery, checkpoints) instead of being a flat pile.
        const nodeFor = new Map();
        const ensureNode = (path) => {
            if (nodeFor.has(path)) return nodeFor.get(path);
            const parts = path.split('::').filter(Boolean);
            let parent = null, sofar = '';
            for (const part of parts) {
                sofar = sofar ? `${sofar}::${part}` : part;
                if (nodeFor.has(sofar)) { parent = nodeFor.get(sofar); continue; }
                const siblings = db.prepare(
                    'SELECT COUNT(*) AS n FROM nodes WHERE project_id = ? AND parent_id IS ?'
                ).get(projectId, parent).n;
                // A deck path the author wrote (`Grammar::Unit 3::Verbs`) names real
                // topics, so every level of it is one.
                const id = insertNode.run(projectId, parent, part, '', siblings, ROLE_TOPIC).lastInsertRowid;
                nodeFor.set(sofar, id);
                parent = id;
            }
            nodeFor.set(path, parent);
            return parent;
        };

        // The registry rows come first: they are what makes a blob "referenced",
        // and therefore what keeps the orphan sweep from deleting the files
        // these cards are about to point at.
        // Declining media here rather than at upload time is deliberate: the
        // files were already extracted so the preview could SHOW them, and the
        // rule this screen follows is never to ask a question before its
        // consequence can be seen. Declining simply writes no rows, and the
        // orphan sweep gives the disk back.
        if (includeMedia) {
            for (const m of parsed.media ?? []) {
                // The deck author's own alt text IS the description, and it is
                // marked as theirs so a later vision sweep leaves it alone — a
                // human's words about their own picture beat a model's.
                insertMedia.run(projectId, m.hash, m.filename, m.mime, m.kind, m.size ?? null,
                    m.alt || null, m.alt ? 'author' : null);
            }
        }

        // ---- structure ------------------------------------------------------
        //
        // A deck node with a thousand cards under it is one node, and one node
        // is what the rest of this engine has nothing to say about: the feed
        // picks FOCUS nodes, mastery is per node, a checkpoint is a node
        // boundary, progress counts leaves. So each deck is cut into stages
        // first (see deckStructure.js — by tags when the deck has a real tag
        // scheme, otherwise by the deck's own new-card order), and the cards
        // hang off THOSE.
        //
        // Small decks are left whole and behave exactly as before.
        const byDeck = new Map();
        for (const card of parsed.cards) {
            const path = card.deck || 'Imported';
            if (!byDeck.has(path)) byDeck.set(path, []);
            byDeck.get(path).push(card);
        }
        // Card -> the node it belongs to, decided once, up front, so the write
        // loop below stays a straight insert.
        const nodeOfCard = new Map();
        let stageCount = 0;
        for (const [path, cards] of byDeck) {
            const deckNode = ensureNode(path);
            if (!deckNode) continue;
            const leafName = path.split('::').filter(Boolean).pop() || name;
            const stages = planStages(cards, { deckName: leafName });
            if (!stages.length) {
                for (const c of cards) nodeOfCard.set(c, deckNode);
                continue;
            }
            for (const stage of stages) {
                // The one place the engine learns whether a node is a thing to
                // know or a place in a sequence: a group cut out of card order
                // is pagination, a subdeck or a tag the author named is a topic
                // (server/nodeRole.js). Deciding it here is what lets the
                // one deck's 32 named subdecks be taught while another's 30
                // "Stage N" slices are not.
                const id = insertNode.run(
                    projectId, deckNode, stage.title.slice(0, 200), stage.description, stage.position,
                    roleForStage(stage),
                ).lastInsertRowid;
                stageCount++;
                for (const c of stage.cards) nodeOfCard.set(c, id);
            }
        }

        // ---- links ----------------------------------------------------------
        //
        // The deck's own `<a href>`s, collected onto the topic they were written
        // under. They stay ON the card as well — that is where the author put
        // them and where the learner meets them — but a card is seen once every
        // few days and a resource list is browsable, so the same link is worth
        // being in both places, exactly as an AI-written course's is.
        //
        // **The DECK node, never the stage.** Where a deck has real subdecks
        // those are named topics ("2.2 Gradients & Directional Derivatives")
        // and its links genuinely belong to them; a stage is an arbitrary slice
        // of card order, and "Stage 7 — further reading" means nothing. When
        // there are no stages the two are the same node anyway.
        const linksByNode = new Map();
        let linkTotal = 0;
        for (const card of parsed.cards) {
            if (!nodeOfCard.has(card)) continue;
            const nodeId = nodeFor.get(card.deck || 'Imported') ?? nodeOfCard.get(card);
            if (!nodeId) continue;
            let bucket = linksByNode.get(nodeId);
            if (!bucket) linksByNode.set(nodeId, bucket = new Map());
            for (const link of linksOfCard(card)) {
                if (bucket.has(link.url)) continue;
                if (bucket.size >= MAX_LINKS_PER_NODE || linkTotal >= MAX_LINKS_TOTAL) break;
                bucket.set(link.url, link);
                linkTotal++;
            }
        }
        let resourceCount = 0;
        for (const [nodeId, bucket] of linksByNode) {
            let position = 0;
            for (const link of bucket.values()) {
                insertResource.run(nodeId, link.label.slice(0, 200) || 'Link', link.url,
                    linkResourceType(link), position++);
                resourceCount++;
            }
        }

        let written = 0;
        // Anki card id -> the flashcard it became, for the review history below.
        const idOfAnkiCard = new Map();
        for (const card of parsed.cards) {
            const nodeId = nodeOfCard.get(card);
            if (!nodeId) continue;
            const front = swapFrontBack ? card.back : card.front;
            const back = swapFrontBack ? card.front : card.back;
            // Swapping the sides swaps their media with them — the picture
            // belongs to the side it was written on, not to a position.
            const fm = includeMedia ? (card.media?.front ?? []) : [];
            const bm = includeMedia ? (card.media?.back ?? []) : [];
            const media = (fm.length || bm.length)
                ? JSON.stringify(swapFrontBack ? { front: bm, back: fm } : { front: fm, back: bm })
                : null;

            // Anki's SM-2 state maps straight onto the columns src/utils/srs.ts
            // migrates from, so a review history survives the move. `stability`
            // is deliberately left NULL: that is the flag the FSRS seeding path
            // keys on, and letting it seed on first review reuses one code path
            // instead of duplicating the mapping here.
            const s = keepSchedule ? card.sched : null;
            const interval = s?.interval && s.interval > 0 ? s.interval : null;
            const nextReview = interval
                ? new Date(Date.now() + interval * 86_400_000).toISOString()
                : null;
            // **A swap moves the question-side lines off the question.** The
            // author put the example sentence in front of the WORD; asked in the
            // reverse direction the prompt is the meaning, and a sentence
            // containing the word being asked for is the answer key. They join
            // the supporting lines instead of being shown, and nothing is lost.
            const extraFront = swapFrontBack ? null : (card.extraFront || null);
            const extra = swapFrontBack && card.extraFront
                ? [card.extra, card.extraFront].filter(Boolean).join('\n')
                : (card.extra || null);
            const info = insertCard.run(
                nodeId, front, back, extra, extraFront,
                interval ?? 1,
                s?.ease ?? 2.5,
                s?.reps ?? 0,
                s?.lapses ?? 0,
                nextReview,
                s?.reps ? new Date().toISOString() : null,
                media,
            );
            written++;
            if (s?.ankiCardId) idOfAnkiCard.set(s.ankiCardId, Number(info.lastInsertRowid));
        }
        // The deck's own review history rides on the same switch as its
        // schedule: a learner who declined to keep Anki's scheduling has said
        // they want the deck fresh, and history that the schedule then
        // contradicts would only mislead the optimiser.
        let reviews = 0;
        if (keepSchedule && parsed.revlog?.length && idOfAnkiCard.size) {
            reviews = importAnkiRevlog(parsed.revlog, (cid) => idOfAnkiCard.get(cid)).imported;
        }
        return { projectId, written, stages: stageCount, resources: resourceCount, reviews };
    });

    const { projectId, written, stages, resources, reviews } = run();
    return {
        projectId,
        name,
        imported: written,
        stages,
        resources,
        reviews,
        skipped: parsed.stats.skipped,
        skipReasons: parsed.stats.skipReasons,
        decks: parsed.stats.decks.length,
        media: includeMedia ? (parsed.stats.mediaFiles ?? 0) : 0,
    };
}

/**
 * Delete media blobs no row in the database still points at.
 *
 * Two things create orphans, and only one of them is a mistake:
 *   * an import that was inspected and then cancelled or left to expire — the
 *     blobs were written during inspect, by design, and nothing claimed them;
 *   * a project deleted afterwards — `media_files.project_id` cascades, so the
 *     rows go and the bytes are left.
 *
 * The set difference is taken in the safe direction: what is ON DISK minus what
 * the DATABASE references. Doing it the other way round — deleting a file
 * because some list said to — is how a sweep removes something still in use.
 * The media store has its own root precisely so "referenced" has exactly one
 * meaning here (see vaultStorage.js).
 */
export function sweepOrphanMedia({ allowEmpty = false } = {}) {
    let removed = 0, bytes = 0;
    try {
        const referenced = new Set(
            db.prepare('SELECT DISTINCT hash FROM media_files').all().map(r => r.hash)
        );
        // A database that references NOTHING next to a store that holds files
        // is far more likely the WRONG database than an emptied library — a
        // scratch DB_PATH pointed at the default VAULT_ROOT, a restored backup
        // from before the first deck, a test run. On 2026-09-02 exactly that
        // combination swept 12,531 real files (249 MB) at STARTUP, unattended.
        // So an empty reference set does not authorise the unattended sweep.
        // A caller acting on an explicit user action in the running app —
        // deleting the last deck, declining an import — knows this is the real
        // database and passes `allowEmpty` to reclaim the disk as before.
        const onDisk = mediaStorage.listHashes();
        if (!allowEmpty && referenced.size === 0 && onDisk.length > 0) {
            console.warn(`[Anki] media sweep skipped: the database references no media but the store holds ${onDisk.length} file(s) — wrong database or VAULT_ROOT?`);
            return { removed: 0, bytes: 0, skipped: onDisk.length };
        }
        for (const hash of onDisk) {
            if (referenced.has(hash)) continue;
            try { bytes += statSync(mediaStorage.pathFor(hash)).size; } catch { }
            if (mediaStorage.remove(hash)) removed++;
        }
    } catch (err) {
        // A sweep is housekeeping. It must never take the server down with it.
        console.warn('[Anki] media sweep failed:', err.message);
    }
    return { removed, bytes };
}
