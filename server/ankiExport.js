/**
 * Anki export — the exit door.
 *
 * `ankiImport.js` is the front door: someone arriving with a deck they have
 * built for years has content on day one. This is the other half of the same
 * promise, and it is a trust feature before it is a convenience one. An app
 * that can only absorb collections is a roach motel for the learner's work; a
 * local-first app that says "your data is yours" and then owns the only reader
 * of it has not actually said anything. The cards can leave, in the format the
 * rest of the world already reads.
 *
 * WHAT IS EXPORTED, and what deliberately is not. A `.apkg` carries notes,
 * cards, their scheduling state and their media. It does NOT carry BKT mastery,
 * placement priors, feed history, quizzes or the curriculum's prose — Anki has
 * nowhere to put any of that, and inventing a sidecar nobody reads would be
 * decoration. The curriculum leaves through `.studyvault` / the JSON exporter,
 * which is the artifact built for it. What this guarantees is that every
 * flashcard, its media, and the interval it has earned survive the trip.
 *
 * WHY SCHEMA 11 AND NOT 18. The importer has to read both because exports in
 * the wild are both ([[anki-import]] trap 1). An exporter chooses, and the
 * choice is the older one: schema 11 (`collection.anki2`, one `col` row with
 * JSON blobs) is read by every Anki version ever shipped, including AnkiDroid
 * and AnkiMobile builds years old, while schema 18 is read only by 2.1.28+.
 * A newer container buys nothing here — we are writing a handful of tables, not
 * using any 18-only feature — and costs compatibility with exactly the
 * long-time users most likely to want an export. Deliberately uncompressed zip
 * entries and a legacy JSON `media` index for the same reason.
 *
 * NO NEW DEPENDENCIES. JSZip and better-sqlite3 are already here for the import
 * path; an .apkg is a zip holding a SQLite file, so the export needs neither a
 * zstd writer nor a protobuf encoder.
 */

import JSZip from 'jszip';
import Database from 'better-sqlite3';
import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// --------------------------------------------------------------------------
// Anki constants. Named rather than inlined because several of them are magic
// numbers whose meaning is not recoverable from the value.
// --------------------------------------------------------------------------

/** Schema version written into `col.ver`. See the header for why 11. */
export const SCHEMA_VERSION = 11;

/** Anki's deck-path separator in schema 11. (Schema 18 uses \x1f — trap 3.) */
export const DECK_SEP = '::';

/** Anki's field separator inside `notes.flds`. */
export const FIELD_SEP = '\x1f';

/** `cards.type` / `cards.queue`: 0 new, 1 learning, 2 review, 3 relearning. */
export const CARD_NEW = 0;
export const CARD_REVIEW = 2;

/**
 * Anki stores ease as an integer per-mille (2500 = 2.5). Our `ease_factor` is
 * the float, and Anki clamps at 1300 — a card that drifted below that in our
 * store would otherwise import as a card Anki itself considers impossible.
 */
export const EASE_SCALE = 1000;
export const MIN_EASE = 1300;
export const DEFAULT_EASE = 2500;

/** Anki refuses intervals beyond this many days (its own `maxIvl` default). */
export const MAX_INTERVAL_DAYS = 36500;

const DAY_MS = 86400000;

// --------------------------------------------------------------------------
// Pure text helpers — no DB, no zip, so `tools/anki-export-gates.mjs` can drive
// every one of them directly.
// --------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Our card columns are PLAIN TEXT on purpose ([[anki-card-presentation]]): an
 * imported deck is untrusted input and the shared sanitizer exists to keep
 * other people's tags out of the DOM. Anki's fields, by contrast, are HTML.
 * So the conversion happens HERE, at the boundary, and it is deliberately
 * minimal: escape what would otherwise become markup, turn the two conventions
 * this app does parse into their Anki equivalents, and leave everything else
 * exactly as the learner wrote it.
 *
 * `**bold**` becomes `<b>` because that is what it MEANT — it is the target
 * word inside an example sentence, and Anki's own templates bold it. Furigana
 * brackets are left untouched: `好[す]き` is already Anki's own ruby syntax, so
 * "converting" it would be translating a thing into itself.
 */
export function textToAnkiHtml(text) {
    let s = String(text ?? '');
    s = s.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);
    // Emphasis. Non-greedy, no nesting, and it must not span a line break —
    // a stray asterisk two paragraphs down should not bold everything between.
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/\r\n|\r|\n/g, '<br>');
    return s;
}

/**
 * The reference direction: what Anki would give us back. Used by the gates to
 * assert a round trip, and it is intentionally NOT the importer's
 * `stripAnkiHtml` — that one is lossy by design (it throws emphasis away),
 * which is the right call when reading somebody else's deck and the wrong one
 * when checking our own writer.
 */
export function ankiHtmlToText(html) {
    let s = String(html ?? '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/?b>/gi, '**');
    s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return s;
}

/**
 * Anki's note checksum: the first 8 hex digits of the SHA-1 of the sort field,
 * as an integer. It backs duplicate detection in the browser, and a wrong value
 * is invisible until someone runs "Find Duplicates" and gets nonsense — which
 * is precisely the kind of defect an export must not introduce silently.
 */
export function fieldChecksum(text) {
    const stripped = String(text ?? '').replace(/<[^>]+>/g, '');
    return parseInt(createHash('sha1').update(stripped, 'utf8').digest('hex').slice(0, 8), 16);
}

/**
 * A deck name Anki can hold. `::` is structural, so a topic whose own title
 * contains it would silently fork into extra subdecks; the same is true of the
 * schema-18 separator, which is why a control byte is stripped rather than
 * escaped. Empty segments are dropped because Anki renders `A::::B` as a deck
 * with a nameless parent.
 */
export function sanitizeDeckSegment(title) {
    return String(title ?? '')
        .replace(/\x1f/g, ' ')
        .replace(/::+/g, ' - ')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Join ancestry into a deck path, dropping segments that sanitize to nothing
 * and COLLAPSING a segment that merely repeats its parent.
 *
 * The repeat is not hypothetical: an imported deck becomes a project named
 * after the deck, holding a root node also named after the deck, so the real
 * library exported as `Core Vocabulary::Core Vocabulary::Core` — a deck
 * nested inside a deck of the same name, which in
 * Anki's sidebar reads as a bug in the exporter, because it is one. Found by
 * running the export over the actual library rather than over a fixture.
 * Compared after sanitizing and case-insensitively, since the two copies of the
 * name come from different tables and need not match byte for byte.
 */
export function deckPath(segments) {
    const clean = [];
    for (const raw of segments || []) {
        const seg = sanitizeDeckSegment(raw);
        if (!seg) continue;
        if (clean.length && clean[clean.length - 1].toLowerCase() === seg.toLowerCase()) continue;
        clean.push(seg);
    }
    return clean.length ? clean.join(DECK_SEP) : 'Terramentor';
}

/**
 * Media references become Anki's own inline syntax. Pictures are `<img src>`
 * and sounds are `[sound:...]`, and the ORDER matters for the same reason
 * `CardMedia` plays clips above pictures: the audio belongs to the words it
 * follows. Filenames are the stored name, not the content hash — a learner
 * opening the media folder in Anki should see the names their deck used.
 */
export function mediaTags(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const sounds = list.filter((m) => m?.kind === 'audio' && m?.name);
    const images = list.filter((m) => m?.kind !== 'audio' && m?.name);
    return [
        ...sounds.map((m) => `[sound:${m.name}]`),
        ...images.map((m) => `<img src="${String(m.name).replace(/"/g, '&quot;')}">`),
    ].join('');
}

/** The card's media JSON column, parsed defensively (it is user/import data). */
export function parseCardMedia(raw) {
    if (!raw) return { front: [], back: [] };
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
            front: Array.isArray(v?.front) ? v.front : [],
            back: Array.isArray(v?.back) ? v.back : [],
        };
    } catch {
        return { front: [], back: [] };
    }
}

/**
 * Our three text columns become Anki's three fields. `extra` is its own field
 * rather than glued onto the back for the same reason it is its own column: the
 * answer is what the learner is asked to produce and the rest is context.
 *
 * THE THIRD FIELD IS CALLED "Notes", NOT "Extra", and that is not cosmetic.
 * Deck tools read field NAMES to decide what a field holds — ours does
 * (`fieldRole` in `ankiFields.js`, the fix for a vocabulary deck showing the reading where
 * the meaning belonged), and so does every other importer worth using. "Extra"
 * matches no role anywhere, so a field named that is carried as an unlabelled
 * string and, on a re-import, silently dropped. Found by the round-trip gate:
 * our own exporter wrote a deck our own importer could not fully read.
 */
export const FIELD_NAMES = ['Front', 'Back', 'Notes'];

export function noteFieldsForCard(card) {
    const media = parseCardMedia(card?.media);
    return {
        Front: textToAnkiHtml(card?.front) + mediaTags(media.front),
        Back: textToAnkiHtml(card?.back) + mediaTags(media.back),
        Notes: textToAnkiHtml(card?.extra),
    };
}

/**
 * Scheduling state, ours to Anki's.
 *
 * This is where an export is either honest or a lie, and the failure is silent
 * both ways: send a mature card over as new and the learner re-earns three
 * years of intervals; send a new card over as mature and they never see it.
 *
 * We hold FSRS state (stability/difficulty) AND the SM-2 columns Anki speaks,
 * because the FSRS migration deliberately kept them ([[fsrs-scheduler-swap]]).
 * Anki's own scheduler is what will run these cards after the export, so the
 * SM-2 pair is the honest thing to send: `ivl` is the interval the card earned
 * and `factor` its ease. FSRS parameters are NOT translated — Anki fits its own
 * from the review log, and a foreign stability number written into its DB would
 * be a value it never produced and cannot interpret.
 *
 * `due` for a review card is measured in DAYS SINCE THE COLLECTION WAS CREATED,
 * not a timestamp — the single most common way a hand-written .apkg lands every
 * card in "due today" or fifty years out.
 */
export function schedulingForCard(card, { crtSec, nowMs = Date.now(), newPos = 1 } = {}) {
    const reviewed = card?.last_reviewed && card?.next_review;
    const ivlRaw = Number(card?.last_interval);
    const ivl = Number.isFinite(ivlRaw) && ivlRaw > 0 ? Math.min(Math.round(ivlRaw), MAX_INTERVAL_DAYS) : 0;

    if (!reviewed || !ivl) {
        // Never studied here, so it is new there. `due` is the position in the
        // new-card queue — the same author-ordering the importer reads back.
        return {
            type: CARD_NEW, queue: CARD_NEW, due: newPos, ivl: 0,
            factor: 0, reps: Math.max(0, Number(card?.review_count) || 0),
            lapses: Math.max(0, Number(card?.lapses) || 0), left: 0,
        };
    }

    const dueMs = Date.parse(card.next_review);
    const crtMs = crtSec * 1000;
    // Anki counts whole days from the collection's creation day.
    const dueDay = Number.isFinite(dueMs)
        ? Math.round((dueMs - crtMs) / DAY_MS)
        : Math.round((nowMs - crtMs) / DAY_MS);

    const easeRaw = Number(card?.ease_factor);
    const factor = Number.isFinite(easeRaw) && easeRaw > 0
        ? Math.max(MIN_EASE, Math.round(easeRaw * EASE_SCALE))
        : DEFAULT_EASE;

    return {
        type: CARD_REVIEW, queue: CARD_REVIEW,
        // A card that was due before the collection existed is due now, not
        // negative — Anki treats a negative `due` on a review card as garbage.
        due: Math.max(0, dueDay),
        ivl, factor,
        reps: Math.max(1, Number(card?.review_count) || 1),
        lapses: Math.max(0, Number(card?.lapses) || 0),
        left: 0,
    };
}

// --------------------------------------------------------------------------
// The collection blobs. Anki reads these as JSON out of the single `col` row.
// --------------------------------------------------------------------------

const CARD_CSS = `.card {
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 22px;
  text-align: center;
  color: #1e293b;
  background-color: #ffffff;
}
.extra { font-size: 16px; color: #475569; margin-top: 0.75em; }
.nightMode .card { color: #e2e8f0; background-color: #0f172a; }
.nightMode .extra { color: #94a3b8; }`;

/**
 * One note type with three fields. Deliberately one, not one per source deck:
 * a learner re-importing this into the Anki collection it came from should get
 * their cards back under a predictable name, and N note types differing only in
 * cosmetics is the mess that makes people give up on merging decks.
 *
 * `req` tells Anki which fields must be non-empty for the card to generate. It
 * is `[[0, 'any', [0]]]` — card 1 exists when field 0 (Front) has content. Get
 * this wrong and Anki silently generates zero cards from perfectly good notes.
 */
export function buildModel(id, name = 'Terramentor') {
    return {
        id, name, type: 0, mod: Math.floor(id / 1000), usn: -1, sortf: 0, did: 1,
        tmpls: [{
            name: 'Card 1', ord: 0,
            qfmt: '{{Front}}',
            afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}\n\n{{#Notes}}<div class="extra">{{Notes}}</div>{{/Notes}}',
            did: null, bqfmt: '', bafmt: '',
        }],
        flds: FIELD_NAMES.map((n, ord) => ({
            name: n, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [],
        })),
        css: CARD_CSS,
        latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
        latexPost: '\\end{document}',
        req: [[0, 'any', [0]]],
        vers: [], tags: [],
    };
}

export function buildDeck(id, name) {
    return {
        id, name, mod: Math.floor(Date.now() / 1000), usn: -1,
        lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
        collapsed: false, browserCollapsed: true, desc: '', dyn: 0,
        conf: 1, extendNew: 10, extendRev: 50,
    };
}

export function buildDeckConfig() {
    return {
        1: {
            id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true,
            timer: 0, replayq: true, dyn: false,
            new: { bury: false, delays: [1.0, 10.0], initialFactor: DEFAULT_EASE, ints: [1, 4, 0], order: 1, perDay: 20 },
            rev: { bury: false, ease4: 1.3, ivlFct: 1.0, maxIvl: MAX_INTERVAL_DAYS, perDay: 200, hardFactor: 1.2 },
            lapse: { delays: [10.0], leechAction: 1, leechFails: 8, minInt: 1, mult: 0.0 },
        },
    };
}

export function buildColConf(modelId) {
    return {
        nextPos: 1, estTimes: true, activeDecks: [1], sortType: 'noteFld',
        timeLim: 0, sortBackwards: false, addToCur: true, curDeck: 1,
        newBury: true, newSpread: 0, dueCounter: 0,
        curModel: String(modelId), collapseTime: 1200, schedVer: 2,
    };
}

const SCHEMA_SQL = `
CREATE TABLE col (
  id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL,
  scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL,
  usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL,
  models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL
);
CREATE TABLE notes (
  id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL,
  mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL,
  flds text NOT NULL, sfld integer NOT NULL, csum integer NOT NULL,
  flags integer NOT NULL, data text NOT NULL
);
CREATE TABLE cards (
  id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL,
  ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL,
  type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL,
  ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL,
  lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL,
  odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL
);
CREATE TABLE revlog (
  id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL,
  ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL,
  factor integer NOT NULL, time integer NOT NULL, type integer NOT NULL
);
CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`;

/**
 * Build the collection SQLite file in a temp directory and return its bytes.
 *
 * Written to disk rather than to an in-memory database because better-sqlite3
 * has no serialize-to-buffer, and the .apkg needs the file's actual bytes.
 */
export function buildCollectionBuffer({ decks, notes, crtSec, modelId }) {
    const dir = mkdtempSync(join(tmpdir(), 'mnem-apkg-'));
    const file = join(dir, 'collection.anki2');
    try {
        const out = new Database(file);
        out.pragma('journal_mode = delete'); // no -wal beside the file we are about to read
        out.exec(SCHEMA_SQL);

        const nowSec = Math.floor(Date.now() / 1000);
        const deckJson = {};
        for (const d of decks) deckJson[String(d.id)] = buildDeck(d.id, d.name);
        // Anki requires deck 1 ("Default") to exist even when nothing is in it.
        if (!deckJson['1']) deckJson['1'] = buildDeck(1, 'Default');

        const models = {};
        models[String(modelId)] = buildModel(modelId);

        out.prepare(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
                     VALUES (1, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, '{}')`)
            .run(crtSec, nowSec * 1000, nowSec * 1000, SCHEMA_VERSION,
                JSON.stringify(buildColConf(modelId)), JSON.stringify(models),
                JSON.stringify(deckJson), JSON.stringify(buildDeckConfig()));

        const insNote = out.prepare(`INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
                                     VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')`);
        const insCard = out.prepare(`INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
                                     VALUES (?, ?, ?, 0, ?, -1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '')`);

        const write = out.transaction((rows) => {
            for (const n of rows) {
                const flds = FIELD_NAMES.map((k) => n.fields[k]).join(FIELD_SEP);
                insNote.run(n.id, n.guid, modelId, nowSec, n.tags || '', flds,
                    n.fields.Front, fieldChecksum(n.fields.Front));
                const s = n.sched;
                insCard.run(n.cardId, n.id, n.did, nowSec, s.type, s.queue, s.due,
                    s.ivl, s.factor, s.reps, s.lapses, s.left);
            }
        });
        write(notes);
        out.close();
        return readFileSync(file);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Assemble the .apkg zip.
 *
 * `media` maps the numeric entry name Anki looks for to the real filename, and
 * the bytes go in under the NUMBER. Getting this backwards produces an archive
 * that imports cleanly and shows a broken-image icon on every card — the exact
 * shape of failure the import side documents as trap 5, arriving from the other
 * direction.
 */
export function buildApkgZip({ collection, mediaFiles = [] }) {
    const zip = new JSZip();
    zip.file('collection.anki2', collection);
    const index = {};
    mediaFiles.forEach((m, i) => {
        index[String(i)] = m.name;
        // `path` means "read this lazily"; `data` is bytes we already hold. The
        // media half of a real deck is two orders of magnitude bigger than the
        // collection (one measured: 116 MB of audio and pictures against 4 MB of
        // rows), so holding all of it as Buffers is the whole memory problem.
        zip.file(String(i), m.path ? createReadStream(m.path) : m.data);
    });
    zip.file('media', JSON.stringify(index));
    return zip;
}

/**
 * Turn a list of our cards into the note/card rows an .apkg holds.
 *
 * Ids are milliseconds-since-epoch and MUST be unique — Anki uses the note id
 * as its creation time and the card id as a primary key, so a collision drops a
 * card silently. A counter guarantees uniqueness without depending on the clock
 * ticking between two rows of the same loop.
 *
 * `guid` is a fresh uuid per note rather than anything derived from our row id.
 * Anki dedupes on guid across imports: a stable guid means re-importing an
 * updated export UPDATES the learner's existing note, and an accidental
 * collision with an unrelated note in their collection would overwrite it.
 * Since our ids are per-database integers with no global meaning, deriving a
 * guid from one would be manufacturing exactly that collision.
 */
export function buildNoteRows(cards, { deckIdFor, crtSec, baseId = Date.now() }) {
    const rows = [];
    let seq = 0;
    let newPos = 1;
    for (const card of cards) {
        const fields = noteFieldsForCard(card);
        if (!fields.Front.trim()) continue; // `req` would generate no card anyway
        const sched = schedulingForCard(card, { crtSec, newPos });
        if (sched.type === CARD_NEW) newPos += 1;
        const id = baseId + seq * 2;
        rows.push({
            id,
            cardId: id + 1,
            guid: randomUUID(),
            did: deckIdFor(card),
            tags: '',
            fields,
            sched,
        });
        seq += 1;
    }
    return rows;
}

/**
 * Anki's collection-creation timestamp: local midnight (its own rollover is
 * 4am, but midnight is what every `due` here is measured against and the two
 * only differ for a card due on the day of export).
 */
export function collectionCreationSec(now = new Date()) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor(d.getTime() / 1000);
}

// --------------------------------------------------------------------------
// The DB-facing half. Everything above is pure so the gate suite can drive it
// with literals; everything below reads the learner's actual library.
// --------------------------------------------------------------------------

/**
 * Build the deck path for every node in a project, once.
 *
 * A card lives on a node, and the node's ancestry is the deck path — so an
 * imported deck that became `Project > Stage 3` exports back as
 * `Project::Stage 3`, and a curriculum exports with its real structure instead
 * of a flat pile. Notes (`is_note = 1`) are skipped as path segments: they are
 * material attached to a topic, not a level of it, which is the same definition
 * `LEAF_NODE` and `structuralChildren` use.
 */
export function buildDeckPaths(rows, projectName) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const cache = new Map();
    const pathFor = (id) => {
        if (cache.has(id)) return cache.get(id);
        const node = byId.get(id);
        if (!node) return [projectName];
        const parent = node.parent_id != null ? pathFor(node.parent_id) : [projectName];
        // A note contributes no level of its own.
        const segs = node.is_note ? parent : [...parent, node.title];
        cache.set(id, segs);
        return segs;
    };
    const out = new Map();
    for (const r of rows) out.set(r.id, deckPath(pathFor(r.id)));
    return out;
}

/**
 * Build one project's .apkg as a JSZip ready to be generated.
 *
 * Media bytes are read from the content-addressed store and given their stored
 * FILENAME in the archive. Two cards referencing the same clip therefore ship
 * one copy — the store deduped it and the export must not undo that — and a
 * blob that has gone missing is REPORTED rather than silently omitted, because
 * a card arriving in Anki with a dead `<img src>` looks like Anki's fault.
 *
 * It returns the ZIP rather than the finished bytes because a real deck's
 * archive is bigger than a long-running server has spare heap for: a measured
 * one is 1,501 cards and 4,354 media files, and materialising that as one 108 MB
 * Buffer — on top of the 116 MB of media Buffers feeding it — took the process
 * from 120 MB to 687 MB and killed it outright on a server that had been up for
 * hours. The caller decides: the endpoint streams it out, `exportProjectApkg`
 * below buffers it for the gate suite, where the fixtures are tiny.
 */
export async function buildProjectApkg(deps, projectId) {
    const { db, mediaStorage } = deps;
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error(`No such project: ${projectId}`);

    const nodes = db.prepare('SELECT id, parent_id, title, is_note FROM nodes WHERE project_id = ?').all(projectId);
    const paths = buildDeckPaths(nodes, project.name);

    const cards = db.prepare(`
        SELECT f.*, f.node_id AS node_id
        FROM flashcards f JOIN nodes n ON n.id = f.node_id
        WHERE n.project_id = ?
        ORDER BY f.node_id, f.id
    `).all(projectId);

    // Deck ids: Anki wants an integer per deck, and every ANCESTOR of a deck
    // path must exist as its own deck or the tree renders with gaps.
    const deckIds = new Map();
    let nextDeckId = Date.now();
    const ensureDeck = (name) => {
        if (deckIds.has(name)) return deckIds.get(name);
        const parts = name.split(DECK_SEP);
        for (let i = 1; i < parts.length; i += 1) ensureDeck(parts.slice(0, i).join(DECK_SEP));
        const id = nextDeckId;
        nextDeckId += 1;
        deckIds.set(name, id);
        return id;
    };
    for (const card of cards) ensureDeck(paths.get(card.node_id) || project.name);

    const crtSec = collectionCreationSec();
    const rows = buildNoteRows(cards, {
        crtSec,
        deckIdFor: (c) => deckIds.get(paths.get(c.node_id) || project.name) || 1,
    });

    // Media, deduped by stored filename.
    const seen = new Map();
    const missing = [];
    for (const card of cards) {
        const m = parseCardMedia(card.media);
        for (const entry of [...m.front, ...m.back]) {
            if (!entry?.name || !entry?.hash || seen.has(entry.name)) continue;
            // Record the PATH, not the bytes. `pathFor` throws on a blob the
            // registry knows about but the disk no longer holds, which is the
            // one case `missingMedia` exists to report — so the existence check
            // still happens here, up front, and the stats stay honest.
            try {
                seen.set(entry.name, { name: entry.name, path: mediaStorage.pathFor(entry.hash) });
            } catch {
                missing.push(entry.name);
            }
        }
    }

    const collection = buildCollectionBuffer({
        decks: [...deckIds.entries()].map(([name, id]) => ({ id, name })),
        notes: rows,
        crtSec,
        modelId: Date.now(),
    });
    const zip = buildApkgZip({ collection, mediaFiles: [...seen.values()] });

    return {
        zip,
        stats: {
            project: project.name,
            notes: rows.length,
            skipped: cards.length - rows.length,
            decks: deckIds.size,
            mediaFiles: seen.size,
            missingMedia: missing,
        },
    };
}

/**
 * The buffered form. Kept for callers that genuinely want the bytes in hand —
 * the gate suite, which round-trips a fixture back through `parseApkg`.
 */
export async function exportProjectApkg(deps, projectId) {
    const { zip, stats } = await buildProjectApkg(deps, projectId);
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { buffer, stats };
}
