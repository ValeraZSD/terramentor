// server/ankiCollection.js — read the rows an Anki import needs out of a
// collection file, in a process of its own.
//
// An .apkg's collection is a SQLite database somebody else wrote, and SQLite is
// not a passive format: a view is a stored query that runs when its name is
// read, a trigger is stored code, a generated column or a column default is an
// expression evaluated on read. `readonly` stops none of that. A view called
// `notes` that recurses forever, opened on the server's thread, froze the event
// loop for good; one that returns a few hundred megabytes per cell ended the
// process. A deck exported by Anki holds only tables and indexes, so:
//
//  1. **Plain tables only.** Before any row is read, the schema is checked:
//     anything but a table or an index (a view, a trigger, a virtual table) or
//     a generated column refuses the whole file (`assertPlainCollection`).
//  2. **No trust in the schema.** `trusted_schema` off, `query_only` on, cell
//     sizes checked, and better-sqlite3's defensive mode left on.
//  3. **A process of its own.** All of it runs in `ankiCollectionProcess.js`,
//     started by `readCollectionIsolated` with a heap ceiling and a time limit
//     (`server/isolatedProcess.js`), so what the first two miss (a default
//     expression is still evaluated) ends that process, never the server.
//
// This module must never import `database.js`: the child would open the
// learner's library. The rows become cards in the same process
// (`notesToCards`, ankiNotes.js); the server gets the cards.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { readCardTemplates } from './ankiTemplates.js';
import { FIELD_SEP, notesToCards } from './ankiNotes.js';
import { runIsolated } from './isolatedProcess.js';

// The only schema entries a deck exported by Anki holds, each as the statement
// that creates it. An index SQLite made itself (for a UNIQUE or a PRIMARY KEY)
// has no statement.
const PLAIN_ENTRY = {
    table: /^\s*create\s+table\b/i,
    index: /^\s*create\s+(?:unique\s+)?index\b/i,
};

/** What a refused schema entry is, in words, from the statement that made it. */
function describeEntry({ type, name, sql }) {
    const text = String(sql ?? '');
    if (/^\s*create\s+(?:temp(?:orary)?\s+)?view\b/i.test(text)) return `a database view ("${name}")`;
    if (/^\s*create\s+(?:temp(?:orary)?\s+)?trigger\b/i.test(text)) return `a database trigger ("${name}")`;
    if (/^\s*create\s+virtual\b/i.test(text)) return `a virtual table ("${name}")`;
    return `a schema entry of an unexpected kind ("${name}", ${JSON.stringify(String(type))})`;
}

/**
 * Refuse a collection holding anything but tables and indexes: the parts of a
 * SQLite schema that run code when read. Throws with the reason.
 *
 * A whitelist, checked twice: on the schema as stored (an entry's recorded
 * type is the file's say-so, and SQLite builds a view from a row recorded as
 * `View`), and on what SQLite actually built from it.
 */
export function assertPlainCollection(handle) {
    const refuse = (what) => {
        throw new Error(`it holds ${what}, which no deck exported from Anki has, so it was not read`);
    };
    for (const entry of handle.prepare('SELECT type, name, sql FROM sqlite_master').all()) {
        const shape = Object.hasOwn(PLAIN_ENTRY, entry.type) ? PLAIN_ENTRY[entry.type] : null;
        const plain = shape && (entry.sql == null ? entry.type === 'index' : shape.test(entry.sql));
        if (!plain) refuse(describeEntry(entry));
    }
    const built = handle.prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main'").all();
    // `hidden` 2 and 3 are generated columns: an expression run on every read.
    const generatedColumn = handle.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)');
    for (const { name, type } of built) {
        if (type !== 'table') refuse(type === 'view' ? `a database view ("${name}")` : `a ${type} table ("${name}")`);
        const generated = generatedColumn.get(name);
        if (generated) refuse(`a computed column ("${name}.${generated.name}")`);
    }
}

/** Open a collection file for reading, with nothing in it trusted. */
export function openCollection(path) {
    const handle = new Database(path, { readonly: true, fileMustExist: true });
    try {
        // Defensive mode is better-sqlite3's default; said here so it stays so.
        handle.unsafeMode(false);
        handle.pragma('trusted_schema = OFF');
        handle.pragma('query_only = ON');
        handle.pragma('cell_size_check = ON');
        assertPlainCollection(handle);
        return handle;
    } catch (err) {
        handle.close();
        throw err;
    }
}

const hasTable = (handle, name) => !!handle.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
).get(name);

/** Deck id → display path, with both separators normalised to `::`. */
function readDecks(handle) {
    const out = new Map();
    if (hasTable(handle, 'decks') && handle.prepare("SELECT COUNT(*) n FROM pragma_table_info('decks') WHERE name='name'").get().n) {
        for (const row of handle.prepare('SELECT id, name FROM decks').all()) {
            // Trap 3 (ankiImport.js): schema 18 joins deck levels with \x1f, not `::`.
            out.set(Number(row.id), String(row.name ?? '').split(FIELD_SEP).join('::'));
        }
        if (out.size) return out;
    }
    try {
        const raw = handle.prepare('SELECT decks FROM col LIMIT 1').get()?.decks;
        const parsed = JSON.parse(raw || '{}');
        for (const [id, d] of Object.entries(parsed)) out.set(Number(id), String(d?.name ?? '').split(FIELD_SEP).join('::'));
    } catch { /* no legacy blob — an empty map means "Imported deck" in ankiImport.js */ }
    return out;
}

/** Note type id → { name, fields[] }. Never touches the protobuf config. */
function readNoteTypes(handle) {
    const out = new Map();
    if (hasTable(handle, 'notetypes') && hasTable(handle, 'fields')) {
        const fieldsOf = handle.prepare('SELECT name FROM fields WHERE ntid = ? ORDER BY ord');
        for (const nt of handle.prepare('SELECT id, name FROM notetypes').all()) {
            const fields = fieldsOf.all(nt.id).map(f => f.name);
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
    } catch { /* both sources absent — fields fall back to positional in ankiImport.js */ }
    return out;
}

/**
 * Every row the importer uses, read in one pass. Runs in the child process;
 * called directly only by the child and by gates.
 */
export function readCollection(path) {
    const handle = openCollection(path);
    try {
        const noteCount = handle.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
        // An empty candidate is passed over for the next one (ankiImport.js,
        // trap 2), so nothing else of it is read: Anki's placeholder collection
        // need not hold every table.
        if (noteCount === 0) {
            return { noteCount, decks: new Map(), noteTypes: new Map(), cardTemplates: new Map(), cardRows: [], noteRows: [], revlog: [] };
        }
        const decks = readDecks(handle);
        const noteTypes = readNoteTypes(handle);
        // Each side as the author's card template defines it (ankiTemplates.js).
        const cardTemplates = readCardTemplates(handle);
        // Card rows carry the deck, the scheduling and the deck's ORDER: on a NEW
        // card (type 0) `due` is its position in the new-card queue, the author's
        // intended sequence; on a graduated card it is a due date.
        const cardRows = handle.prepare(`
            SELECT id, nid, did, ord, ivl, factor, reps, lapses, due, type
            FROM cards ORDER BY nid, ord
        `).all();
        const noteRows = handle.prepare('SELECT id, mid, flds, tags FROM notes').all();
        // The deck's review HISTORY (`revlog`, one row per answer) for
        // server/reviewLog.js and the optimiser. `type = 4` is a manual
        // reschedule, skipped as Anki's optimiser does.
        let revlog = [];
        if (hasTable(handle, 'revlog')) {
            try {
                revlog = handle.prepare(
                    'SELECT id, cid, ease, ivl, lastIvl, type FROM revlog WHERE type != 4 ORDER BY cid, id'
                ).all();
            } catch { revlog = []; }
        }
        return { noteCount, decks, noteTypes, cardTemplates, cardRows, noteRows, revlog };
    } finally {
        handle.close();
    }
}

/**
 * What the reader's process sends back: the notes already turned into cards
 * (`notesToCards`), so the server never parses the deck's text, plus the
 * review history and the note count.
 */
export function readDeckCards(path) {
    const rows = readCollection(path);
    return { noteCount: rows.noteCount, revlog: rows.revlog, ...notesToCards(rows) };
}

// The ceilings the child runs under. The collection itself is at most 512 MB
// (`MAX_COLLECTION_BYTES`), and its rows, as JavaScript strings, plus their copy
// on the way back, need room beyond that; a real deck of tens of thousands of
// notes reads in seconds and a few hundred megabytes. What needs more than
// this is not a deck.
export const COLLECTION_READ_HEAP_MB = 2048;
export const COLLECTION_READ_TIMEOUT_MS = 120_000;
// The cards and history sent back are decoded on the server's thread, so they
// are capped at the size of the largest collection accepted.
export const COLLECTION_REPLY_MB = 512;
const COLLECTION_PROCESS = fileURLToPath(new URL('./ankiCollectionProcess.js', import.meta.url));

/**
 * `readDeckCards(path)` in a child process with a heap ceiling and a time
 * limit. Rejects with the reader's own reason, or with a refusal when a limit
 * ran out (`tooLarge`).
 */
export function readCollectionIsolated(path, {
    heapMb = COLLECTION_READ_HEAP_MB, timeoutMs = COLLECTION_READ_TIMEOUT_MS, replyMb = COLLECTION_REPLY_MB,
} = {}) {
    return runIsolated(COLLECTION_PROCESS, { path }, {
        heapMb,
        timeoutMs,
        replyMb,
        messages: {
            timeout: `it took longer than ${Math.round(timeoutMs / 1000)} s to read, so it was refused`,
            outOfMemory: `reading it would need more than ${heapMb} MB of memory, so it was refused`,
            reply: `its cards would come to more than ${replyMb} MB, so it was refused`,
            stopped: (how) => `the reader stopped (${how})`,
        },
    });
}
