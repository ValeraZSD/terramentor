// server/ankiImport.js — bring an Anki deck in, honestly.
//
// Contract: never silently lose a card. Every note that does not become a
// flashcard is counted with a REASON, and the reasons are surfaced.
//
// An .apkg is a zip holding a SQLite collection plus media. Five traps:
//
//  1. **Two schemas.** Schema 11 (to Anki 2.1.27): one `col` row with `models` and
//     `decks` as JSON. Schema 18 (2.1.28+): real `notetypes` / `fields` / `decks`
//     tables, `col.models` empty. A reader of one sees zero note types in the other.
//  2. **The legacy stub.** A modern export holds BOTH `collection.anki21b` (the real
//     data, zstd) and `collection.anki2`, an empty placeholder for old Anki. So
//     candidates are tried newest-first, and an empty collection is never accepted
//     while a newer candidate is unread.
//  3. **The deck separator.** Schema 11 writes `Parent::Child`, schema 18 `\x1f`.
//  4. **`notetypes.config` and `templates.config` are protobuf**, but `qfmt`/`afmt`
//     are plain UTF-8 fields 1 and 2 inside it (`ankiTemplates.js` walks it). Field
//     names come from the `fields` table; cloze is detected by `{{c1::` in the text.
//  5. **The media index format.** Legacy is a JSON map `{"0":"cat.jpg"}` over plain
//     entries; current is zstd protobuf with every entry compressed (`ankiMedia.js`).
//
// Scheduling comes across: Anki's SM-2 `ivl` (days) and `factor` (ease ×1000) are
// the pair `src/utils/srs.ts` migrates into an FSRS seed.

import JSZip from 'jszip';
import { zstdDecompressSync } from './zstd.js';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import db from './database.js';
import { extractMedia, MAX_MEDIA_TOTAL_BYTES } from './ankiMedia.js';
import { assertZipSafe, readZipEntry } from './extract.js';
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

/**
 * What one .apkg may DECLARE, before a byte is read (see `assertZipSafe`). The
 * entry ceiling clears a very large listening deck (a clip per card; a real 108 MB
 * export had 4,358 entries) and refuses a million-entry archive. The byte total is
 * the import's media budget, `MAX_MEDIA_TOTAL_BYTES`.
 */
const APKG_ZIP_LIMITS = { maxEntries: 200_000, maxTotalBytes: MAX_MEDIA_TOTAL_BYTES };

/**
 * The ceiling the collection database is read under, as a zip entry and as its
 * zstd frame: the same 512 MB the upload door accepts (`rejectOversizedBody` on
 * `/api/import/anki/inspect`), so it cannot expand past what the archive could be.
 */
export const MAX_COLLECTION_BYTES = 512 * 1024 * 1024;

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
function linkResourceType({ label, url }) {
    if (/\b(video|watch|lecture|playlist)\b/i.test(label)) return 'video';
    try { if (VIDEO_HOST.test(new URL(url).hostname)) return 'video'; } catch { /* label decides */ }
    if (/\b(exercise|practice|quiz|problem)s?\b/i.test(label)) return 'practice';
    return 'article';
}

// Bounds on links turned into resources; far above a real deck (a maths deck's
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

// ---- reading the collection -------------------------------------------------

async function loadCollectionDb(zip, workDir) {
    let lastEmpty = null;
    for (const cand of COLLECTION_CANDIDATES) {
        let bytes = await readZipEntry(zip, cand.name, { cap: MAX_COLLECTION_BYTES, what: 'This deck' });
        if (!bytes) continue;
        if (cand.zstd) {
            try {
                bytes = zstdDecompressSync(bytes, {
                    maxOutputBytes: MAX_COLLECTION_BYTES,
                    what: "This deck's collection",
                });
            } catch (err) {
                // A size refusal already explains itself; only a read failure is wrapped.
                if (err?.tooLarge) throw err;
                throw new Error(`This deck's collection is compressed in a way we could not read (${err.message}).`);
            }
        }
        const path = join(workDir, `col-${cand.name}.sqlite`);
        writeFileSync(path, bytes);
        let handle;
        try {
            handle = new Database(path, { readonly: true, fileMustExist: true });
            const n = handle.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
            // Trap 2: an empty collection is accepted only after every candidate.
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
        // An .apkg usually comes from the internet. The archive's declared numbers
        // are checked here (free); what each entry inflates to is bounded where it
        // is inflated, in `readZipEntry` and `zstdDecompressSync`.
        assertZipSafe(zip, APKG_ZIP_LIMITS);

        const loaded = await loadCollectionDb(zip, workDir);
        handle = loaded.handle;

        const decks = readDecks(handle);
        const noteTypes = readNoteTypes(handle);
        // Each side as the author's card template defines it; the name-based
        // mapping is the fallback (see ankiTemplates.js).
        const cardTemplates = readCardTemplates(handle);

        // Card rows carry the deck, the scheduling and the deck's ORDER: on a NEW
        // card (type 0) `due` is its position in the new-card queue, the author's
        // intended sequence; on a graduated card it is a due date.
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

        // ---- media ----------------------------------------------------------
        //
        // Extracted HERE, at inspect, straight into the content-addressed store,
        // so a large deck is previewed without being held in memory; only hashes
        // are staged. A cancelled import leaves unreferenced blobs for
        // `sweepOrphanMedia` (safe: a re-import resolves to the same hash).
        let mediaFiles = new Map(), mediaSkipped = [], mediaFormat = 'none', mediaBytes = 0;
        if (importMedia && wantedMedia.size) {
            ({ files: mediaFiles, skipped: mediaSkipped, format: mediaFormat, bytes: mediaBytes } =
                await extractMedia(zip, [...wantedMedia], { onProgress }));
        }

        // Resolve every reference to a stored blob; drop (and count) the rest.
        let attached = 0, unresolved = 0;
        const seenHashes = new Map();
        for (const card of out) {
            for (const side of ['front', 'back']) {
                const refs = card.media?.[side] ?? [];
                const kept = [];
                // Raw references survive in `mediaRefs`, so a parse without media
                // extraction still knows which file sat on which line
                // (`tools/anki-refresh-text.mjs` re-anchors clips from it).
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

        // A side may be a picture with no words, never EMPTY: a media-only side
        // whose file did not resolve would ship blank, so the card is dropped here
        // and counted like every other refusal.
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
        // Counted here so the preview can promise it; UNIQUE URLs, since one page
        // is often linked from every card in a unit.
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

        // The deck's review HISTORY (`revlog`, one row per answer) for
        // server/reviewLog.js and the optimiser. `type = 4` is a manual
        // reschedule, skipped as Anki's optimiser does. Read now: the collection
        // file is closed at the end of inspect.
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
                // Stages per deck, from the SAME function commit cuts with, so the
                // preview shows the consequence before the decision.
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
 * Samples are how a reversed front/back is caught: the learner sees it and flips
 * one toggle.
 */
export function buildPreview(parsed, { samples = 3 } = {}) {
    const pool = parsed.cards;
    const picks = [];
    if (pool.length) {
        // Spread across the deck: the first few are usually the same shape.
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
            // Real media: the blobs are already stored, so samples render from
            // the same URL the imported card will use.
            media: c.media ?? { front: [], back: [] },
        })),
        suggestedName: suggestProjectName(parsed),
    };
}

/**
 * The project's Overview: what came ACROSS (cards, decks, media) and what could
 * not be turned into a card.
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
    // One top-level deck names the project; several are a whole collection.
    return tops.size === 1 ? [...tops][0] : 'Imported collection';
}

// ---- staging ----------------------------------------------------------------
//
// Parse once, preview, commit later. Only the extracted TEXT is held, never the
// uploaded zip.

const STAGING_TTL_MS = 30 * 60 * 1000;
const staging = new Map();

export function stageImport(parsed) {
    const id = randomUUID();
    // Hash -> descriptor, so the preview's media can be served (findStagedMedia).
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
 * `GET /api/media/:hash` resolves through `media_files`, so a URL never addresses
 * bytes the database does not know. Those rows are written at COMMIT but the blobs
 * at INSPECT, so the preview needs this. A staging record is the same warrant (this
 * server extracted the bytes and sniffed their mime), bounded by the TTL.
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
 * Never merged into an existing project: deleting the project cascades to every
 * node and card the import created, so undo is one delete.
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
            name, describeDeck(parsed), color, 'book', pos, 'deck',
        ).lastInsertRowid;

        // Deck path -> node id, each level created once: `A::B::C` is three nested
        // topics the engine (feed, mastery) can work with.
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
                // Every level of an author's deck path is a real topic.
                const id = insertNode.run(projectId, parent, part, '', siblings, ROLE_TOPIC).lastInsertRowid;
                nodeFor.set(sofar, id);
                parent = id;
            }
            nodeFor.set(path, parent);
            return parent;
        };

        // Registry rows first: they make a blob "referenced", keeping the orphan
        // sweep off files these cards will point at. Media is declined here, not at
        // upload, because the preview had to show it first; declining writes no
        // rows and the sweep reclaims the disk.
        if (includeMedia) {
            for (const m of parsed.media ?? []) {
                // The author's alt text is the description, marked 'author' so a
                // vision sweep leaves it alone.
                insertMedia.run(projectId, m.hash, m.filename, m.mime, m.kind, m.size ?? null,
                    m.alt || null, m.alt ? 'author' : null);
            }
        }

        // ---- structure ------------------------------------------------------
        //
        // The engine works per node (feed focus, mastery, progress), so a large
        // deck is cut into stages first (deckStructure.js: by a real tag scheme,
        // else by new-card order) and the cards hang off those. Small decks stay whole.
        const byDeck = new Map();
        for (const card of parsed.cards) {
            const path = card.deck || 'Imported';
            if (!byDeck.has(path)) byDeck.set(path, []);
            byDeck.get(path).push(card);
        }
        // Card -> its node, decided up front so the write loop is a straight insert.
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
                // Where a node's role is decided (server/nodeRole.js): a slice of
                // card order is pagination, a named subdeck or tag is a topic.
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
        // The deck's `<a href>`s also become resources on their topic (they stay on
        // the card too): a resource list is browsable, a card is seen every few days.
        // On the DECK node, never a stage, which is an arbitrary slice of card order.
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
            // Media belongs to its side, so a swap moves it too.
            const fm = includeMedia ? (card.media?.front ?? []) : [];
            const bm = includeMedia ? (card.media?.back ?? []) : [];
            const media = (fm.length || bm.length)
                ? JSON.stringify(swapFrontBack ? { front: bm, back: fm } : { front: fm, back: bm })
                : null;

            // Anki's SM-2 state goes into the columns src/utils/srs.ts migrates
            // from. `stability` stays NULL: that flag makes FSRS seed on first
            // review, reusing that one mapping.
            const s = keepSchedule ? card.sched : null;
            const interval = s?.interval && s.interval > 0 ? s.interval : null;
            const nextReview = interval
                ? new Date(Date.now() + interval * 86_400_000).toISOString()
                : null;
            // **A swap moves the question-side lines off the question**: reversed,
            // a sentence containing the word is the answer key. They join the
            // supporting lines instead.
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
        // History follows the schedule switch: history contradicting a fresh
        // schedule would mislead the optimiser.
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
 * Orphans come from an import inspected then cancelled or expired (blobs are
 * written at inspect), and from a deleted project (`media_files` rows cascade, the
 * bytes stay).
 *
 * The difference is taken in the safe direction: ON DISK minus what the DATABASE
 * references, never deleting because some list said to. The media store has its own
 * root so "referenced" has one meaning (vaultStorage.js).
 */
export function sweepOrphanMedia({ allowEmpty = false } = {}) {
    let removed = 0, bytes = 0;
    try {
        const referenced = new Set(
            db.prepare('SELECT DISTINCT hash FROM media_files').all().map(r => r.hash)
        );
        // A database referencing NOTHING beside a populated store is more likely
        // the WRONG database (a scratch DB_PATH over the default VAULT_ROOT, an
        // old backup) than an emptied library; unattended, that has deleted a real
        // store. So it does not authorise the sweep. A caller acting on an explicit
        // user action (deleting the last deck, declining an import) passes
        // `allowEmpty`.
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
