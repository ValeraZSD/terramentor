import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, statSync, readdirSync, unlinkSync, renameSync } from 'fs';
import { dataPaths } from './paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database file location: see server/paths.js for the whole precedence table
// (DB_PATH, then DATA_DIR, then the historical `server/terramentor.db`). The
// desktop launcher sets DATA_DIR to the per-user application-data folder; a
// checkout that sets nothing finds its library exactly where it always was.
const DB_FILE = dataPaths().dbPath;
const db = new Database(DB_FILE);

// Load the sqlite-vec loadable extension (vec0 virtual tables → KNN vector
// search for semantic Vault retrieval). This is the ONE piece of the whole
// semantic-search feature that depends on native platform binaries, so it is
// wrapped defensively: if the extension can't load (unsupported platform, a
// better-sqlite3 built without extension support, etc.) `vecAvailable` stays
// false and the app degrades to FTS5 keyword search everywhere — nothing else
// throws. Verified loading on Windows x64 + better-sqlite3 12.8.0.
export let vecAvailable = false;
try {
  sqliteVec.load(db);
  db.prepare('SELECT vec_version()').get();
  vecAvailable = true;
} catch (e) {
  console.warn('[VEC] sqlite-vec unavailable — semantic search disabled, FTS5 keyword search still works:', e.message);
}

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Enable foreign key enforcement. SQLite leaves this OFF by default per
// connection, which silently disables every `ON DELETE CASCADE` clause in the
// schema below. Without it, deleting a project leaves orphaned nodes/resources/
// chats behind, and deleting a parent node orphans its whole subtree (the rows
// stay in the DB but vanish from the UI, corrupting progress counts). Turning it
// on makes the declared cascades actually fire.
db.pragma('foreign_keys = ON');

// --- A SNAPSHOT BEFORE THE SCHEMA MOVES --------------------------------------
//
// Migrations here are forward-only by construction: `addColumnIfMissing` cannot
// drop a column, and two tables are REBUILT from an explicit column list to shed
// a CHECK constraint SQLite will not ALTER away. Nothing in that is reversible,
// and there is no downgrade path — so on a release that migrates, an older build
// pointed at the same file is a wrong build, not a rollback.
//
// That is fine while a version ships every few months and the only database is
// the author's. It is not fine during months of fast releases against other
// people's libraries, where a single bad migration is somebody's year of study.
//
// So: whenever the app version changes, copy the database first. Once per
// version transition, not once per start — otherwise a machine that restarts the
// server twenty times a day fills the disk with identical copies.
//
// `VACUUM INTO` rather than a file copy: it is SQLite's own snapshot, it folds in
// whatever is sitting in the WAL, and it is synchronous, which matters because
// this must finish before the first migration runs. A plain `copyFileSync` of a
// WAL-mode database copies the main file and leaves the recent writes behind in
// a `-wal` it does not take.
//
// Every failure here is swallowed. A backup is insurance; refusing to start the
// app because the insurance could not be written is a worse outcome than the one
// it insures against.

/** Version of the code about to touch this database. Read from package.json
 *  directly rather than imported from version.js, which would make the schema
 *  layer depend on the update checker — the arrow points the wrong way. */
function currentAppVersion() {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** Keep the three most recent snapshots. Enough to walk back through a bad
 *  release; bounded, because these are full copies of the whole library. */
const KEEP_BACKUPS = 3;

function pruneBackups() {
  try {
    const dir = dirname(DB_FILE);
    const base = DB_FILE.slice(dir.length + 1);
    const mine = readdirSync(dir)
      .filter((f) => f.startsWith(base + '.pre-') && f.endsWith('.bak'))
      .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { f } of mine.slice(KEEP_BACKUPS)) unlinkSync(join(dir, f));
  } catch { /* housekeeping, never fatal */ }
}

function backupBeforeMigrations() {
  const version = currentAppVersion();
  if (!version) return;
  let previous = null;
  try {
    // No settings table means a database this app has never opened — there is
    // nothing to migrate FROM, so there is nothing worth snapshotting.
    const hasSettings = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
    if (!hasSettings) return;
    previous = db.prepare("SELECT value FROM settings WHERE key='app_version'").get()?.value || null;
  } catch {
    return;
  }
  if (previous === version) return;             // same build: nothing has moved
  try {
    // `previous` is null the first time this feature exists on an old library —
    // still worth a snapshot, and 'unknown' says honestly which build it was.
    const target = `${DB_FILE}.pre-${(previous || 'unknown').replace(/[^\w.-]/g, '_')}.bak`;
    // A snapshot already named for this source version IS the original: the
    // version stamp is written only after every migration has run, so a start
    // that failed half-way arrives here again with the same `previous`, and
    // replacing the snapshot then would swap the untouched library for a
    // half-migrated one — at exactly the moment it is needed.
    if (existsSync(target)) {
      console.log(`[DB] Keeping the snapshot taken before the first attempt at this upgrade: ${target}`);
      return;
    }
    // Written under a temporary name and renamed only once complete, so a failed
    // or interrupted VACUUM never leaves a partial file under the real name.
    const partial = `${target}.partial`;
    if (existsSync(partial)) unlinkSync(partial);  // VACUUM INTO refuses to overwrite
    db.prepare('VACUUM INTO ?').run(partial);
    renameSync(partial, target);
    pruneBackups();
    console.log(`[DB] Snapshot before upgrading ${previous || 'an earlier build'} -> ${version}: ${target}`);
  } catch (e) {
    console.warn('[DB] Could not snapshot before migrating (continuing):', e.message);
  }
}

backupBeforeMigrations();

// `addons` -> `search_providers` (0.69). This has to run BEFORE the schema block
// below, not with the other migrations after it: `CREATE TABLE IF NOT EXISTS
// search_providers` would otherwise make an empty table first, and the rename
// would then be skipped for the rest of time with the learner's own providers
// and every enabled/disabled choice stranded in a table nothing reads.
try {
  const has = (name) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (has('addons') && !has('search_providers')) {
    db.exec('ALTER TABLE addons RENAME TO search_providers');
    console.log('[DB] Renamed addons -> search_providers');
  }
  // `installed_at` was named for a framing this never had; a provider is saved,
  // not installed. Guarded on the column rather than on the rename above, so a
  // library that took the rename before this line existed is still corrected.
  if (has('search_providers')) {
    const cols = db.prepare('PRAGMA table_info(search_providers)').all().map(c => c.name);
    if (cols.includes('installed_at') && !cols.includes('created_at')) {
      db.exec('ALTER TABLE search_providers RENAME COLUMN installed_at TO created_at');
    }
  }
} catch (e) {
  console.warn('[DB] search_providers rename skipped:', e.message);
}

try {
  db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        summary TEXT DEFAULT '',
        color TEXT DEFAULT '#3B82F6',
        icon TEXT DEFAULT 'folder',
        position INTEGER DEFAULT 0,
        ai_generating INTEGER DEFAULT 0,
        start_date TEXT DEFAULT NULL,
        deadline TEXT DEFAULT NULL,
        study_days TEXT DEFAULT '[1,2,3,4,5]',
        baseline_schedule TEXT DEFAULT NULL,
        content_language TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Search providers (server/searchProviders.js). Manifests only — no code
      -- is ever stored or executed from here. Named addons until 0.69; the
      -- rename migration runs above, before this CREATE could shadow it.
      CREATE TABLE IF NOT EXISTS search_providers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        manifest TEXT NOT NULL,
        enabled INTEGER DEFAULT 0,
        builtin INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        parent_id INTEGER,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        status TEXT DEFAULT 'not_started' CHECK(status IN ('not_started', 'in_progress', 'completed')),
        is_note INTEGER DEFAULT 0,
        position INTEGER DEFAULT 0,
        scheduled_start TEXT DEFAULT NULL,
        scheduled_end TEXT DEFAULT NULL,
        estimated_weight REAL DEFAULT NULL,
        completed_at TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT DEFAULT '',
        type TEXT DEFAULT 'link',
        completed INTEGER DEFAULT 0,
        position INTEGER DEFAULT 0,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER,
        project_id INTEGER,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER,
        project_id INTEGER,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        file_type TEXT DEFAULT 'text',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS document_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS quizzes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        questions TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS quiz_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id INTEGER NOT NULL,
        score INTEGER NOT NULL,
        total INTEGER NOT NULL,
        answers TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
      );

      -- Which saved questions have been ASKED, and where. One log behind the
      -- feed, the mastery check and the practice quiz, so a bank is worked
      -- through rather than re-drawn from its head (server/questionLog.js).
      -- Evidence is not here: that is mastery_evidence's; this only remembers.
      CREATE TABLE IF NOT EXISTS question_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id INTEGER NOT NULL,
        question_index INTEGER NOT NULL,
        node_id INTEGER,
        surface TEXT NOT NULL,
        correct INTEGER,
        asked_at TEXT NOT NULL,
        FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_question_log_quiz ON question_log(quiz_id, question_index);

      CREATE TABLE IF NOT EXISTS flashcards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL,
        front TEXT NOT NULL,
        back TEXT NOT NULL,
        difficulty INTEGER DEFAULT 0,
        last_reviewed DATETIME,
        next_review DATETIME,
        review_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      -- The registry for card media (Anki imports today; anything that attaches
      -- a picture or a clip to a card later). One row per FILE, keyed by the
      -- SHA-256 of its bytes — the same content-addressing the vault uses, so a
      -- deck that repeats the same audio clip on forty cards stores it once.
      --
      -- The row is what makes a blob "referenced": sweepOrphanMedia() deletes
      -- every file on disk with no row here, which is how a cancelled import
      -- and a deleted project both clean up without a reference count to keep
      -- in sync. project_id cascades for exactly that reason.
      --
      -- The description column is what the AI and a screen reader read instead of the
      -- picture. It starts as the deck author's own alt text when there was one
      -- and can be filled in later by a vision model; NULL means "nobody has
      -- described this yet", which is honest and is what the UI reports.
      CREATE TABLE IF NOT EXISTS media_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        hash TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER,
        description TEXT,
        described_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (project_id, hash),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS learning_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        node_id INTEGER,
        activity_type TEXT NOT NULL,
        duration_seconds INTEGER DEFAULT 0,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_resources_node ON resources(node_id);
      CREATE INDEX IF NOT EXISTS idx_chat_node ON chat_messages(node_id);
      CREATE INDEX IF NOT EXISTS idx_chat_project ON chat_messages(project_id);
      CREATE INDEX IF NOT EXISTS idx_documents_node ON documents(node_id);
      CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_quizzes_node ON quizzes(node_id);
      CREATE INDEX IF NOT EXISTS idx_flashcards_node ON flashcards(node_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON learning_sessions(project_id);
    `);
} catch (dbInitError) {
  console.error('[DATABASE] Table creation failed:', dbInitError.message);
  console.error('[DATABASE] The database file may be corrupted. Try deleting the .db file and restarting.');
  // Don't throw — let the server start anyway (routes will return 500 until DB is fixed)
}

// FTS table
let ftsAvailable = false;
try {
  db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
            content,
            content='document_chunks',
            content_rowid='id'
        );
    `);
  ftsAvailable = true;
} catch (e) {
  console.log('FTS table already exists or not supported');
}

// Keep the external-content FTS index in sync with document_chunks.
// An external-content FTS5 table ('content=document_chunks') stores no data
// of its own — it must be populated explicitly. Previously nothing ever wrote
// to the index, so every `documents_fts MATCH ?` query returned zero rows,
// silently breaking document search and RAG retrieval. These triggers maintain
// the index on every chunk insert/update/delete.
if (ftsAvailable) {
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS document_chunks_ai AFTER INSERT ON document_chunks BEGIN
        INSERT INTO documents_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS document_chunks_ad AFTER DELETE ON document_chunks BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS document_chunks_au AFTER UPDATE ON document_chunks BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO documents_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);

    // One-time repair: if chunks already exist but the index is empty (data
    // created before the triggers existed), rebuild the index from content.
    const chunkCount = db.prepare('SELECT COUNT(*) AS c FROM document_chunks').get().c;
    const indexedCount = db.prepare('SELECT COUNT(*) AS c FROM documents_fts').get().c;
    if (chunkCount > 0 && indexedCount === 0) {
      db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`);
      console.log(`[FTS] Rebuilt search index for ${chunkCount} existing document chunks`);
    }
  } catch (e) {
    console.error('[FTS] Failed to set up sync triggers:', e.message);
  }
}

// Safe column migrations
const addColumnIfMissing = (table, column, definition) => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    // Column already exists
  }
};

// A table rebuild (the two CHECK-constraint drops below) recreates the table from
// a hand-written column list and copies the rows across. A bare positional
// `INSERT ... SELECT` silently leaves behind any column `addColumnIfMissing`
// bolted on EARLIER in this file: `nodes.chat_draft` is added ~150 lines above
// the nodes rebuild, so a database old enough to still carry the CHECK got the
// column back on the next boot (the ALTER re-runs) with every value gone. And it
// is not only an upgrade path: the canonical CREATE TABLE above STILL writes the
// CHECK, so the rebuild fires on the first boot of a fresh install too, where
// chat_draft was dropped before anything could re-add it — the tutor's draft
// autosave (PUT /api/nodes/:id) threw "no such column" until the second start. So the
// hand list only has to be right about the table's OWN definition: whatever the
// old table carries beyond it is re-added to the new one with its declared type
// and default, and the rows are copied by NAME over the columns both now share.
const copyRowsIntoRebuilt = (fromTable, toTable) => {
  const info = (t) => db.pragma(`table_info(${t})`);
  const have = new Set(info(toTable).map((c) => c.name));
  for (const c of info(fromTable)) {
    if (have.has(c.name)) continue;
    // `dflt_value` is already SQL text (NULL, 0, a quoted string). NOT NULL is
    // only carried when a default exists, as an ALTER cannot add one without.
    const notNull = c.notnull && c.dflt_value !== null ? ' NOT NULL' : '';
    const dflt = c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : '';
    const add = (tail) => db.exec(`ALTER TABLE ${toTable} ADD COLUMN "${c.name}" ${c.type}${tail}`);
    try {
      add(`${notNull}${dflt}`);
    } catch {
      // SQLite refuses a non-constant default (CURRENT_TIMESTAMP, a parenthesised
      // expression) on ALTER — but only while the table has ROWS, and this one is
      // still empty, so today nothing reaches here. Fall back to a bare column
      // rather than let one unusual default abort the whole rebuild: the caller's
      // try/catch swallows the throw, so the CHECK would silently stay forever.
      // The values are copied below either way; only the DEFAULT clause is lost.
      add('');
    }
    have.add(c.name);
  }
  const shared = info(fromTable).map((c) => c.name).filter((n) => have.has(n));
  const list = shared.map((n) => `"${n}"`).join(', ');
  db.exec(`INSERT INTO ${toTable} (${list}) SELECT ${list} FROM ${fromTable}`);
  return shared;
};

addColumnIfMissing('nodes', 'is_note', 'INTEGER DEFAULT 0');
addColumnIfMissing('projects', 'summary', "TEXT DEFAULT ''");
addColumnIfMissing('projects', 'ai_generating', 'INTEGER DEFAULT 0');

addColumnIfMissing('projects', 'start_date', 'TEXT DEFAULT NULL');
addColumnIfMissing('projects', 'deadline', 'TEXT DEFAULT NULL');
addColumnIfMissing('projects', 'study_days', "TEXT DEFAULT '[1,2,3,4,5]'");
addColumnIfMissing('projects', 'baseline_schedule', 'TEXT DEFAULT NULL');
addColumnIfMissing('projects', 'status', "TEXT DEFAULT 'active'"); // active | completed | archived
// Declared study language (see server/language.js). '' = follow the material,
// which is what every project did before this column existed.
addColumnIfMissing('projects', 'content_language', "TEXT DEFAULT ''");

// The course's own edition, author-assigned and free-form ("1.2.0", "2026-08",
// "spring term"). This is NOT a schema or parser version: the export format
// carried a top-level `version: "2.0"` for a long time that nothing ever read,
// because there has only ever been one parser and a v1 branch never existed.
// What is actually worth versioning is the *content* — "is the physics course I
// was sent newer than the one I already have?" — which is a question only the
// author can answer and only `uuid` makes askable.
addColumnIfMissing('projects', 'version', "TEXT DEFAULT ''");


// What SHAPE of project this is: `curriculum` (the default — topics with
// material, a schedule, mastery checks) or `deck` (a card collection, almost always
// an Anki import).
//
// This is deliberately a presentation-and-defaults switch, NOT a second data
// model. A deck is still projects → nodes → flashcards, still fed by the same
// feed, still tracked by the same BKT and the same FSRS scheduler; the column
// exists because the QUESTIONS the two shapes answer are different, and
// answering a deck's questions with a curriculum's screens is what produced a
// dashboard reading "0% complete" over a denominator of 1 while 1,483 cards sat
// due underneath it. Nothing branches on `kind` except what a screen shows and
// which defaults an import picks.
addColumnIfMissing('projects', 'kind', "TEXT DEFAULT 'curriculum'"); // curriculum | deck

addColumnIfMissing('projects', 'insights', 'TEXT DEFAULT NULL');
addColumnIfMissing('projects', 'insights_generated_at', 'DATETIME DEFAULT NULL');

addColumnIfMissing('nodes', 'scheduled_start', 'TEXT DEFAULT NULL');
addColumnIfMissing('nodes', 'scheduled_end', 'TEXT DEFAULT NULL');
addColumnIfMissing('nodes', 'estimated_weight', 'REAL DEFAULT NULL');
addColumnIfMissing('nodes', 'completed_at', 'TEXT DEFAULT NULL');
addColumnIfMissing('nodes', 'chat_draft', "TEXT DEFAULT ''");

addColumnIfMissing('flashcards', 'ease_factor', 'REAL DEFAULT 2.5');
addColumnIfMissing('flashcards', 'last_interval', 'INTEGER DEFAULT 1');

// FSRS-6 card state (src/utils/srs.ts). Kept in its own columns rather than
// overloading the SM-2 ones, because the two scales are not the same number:
// `difficulty` is the app's 0-5 "higher = harder" display value the dashboard's
// weak-card metric is defined against, while `fsrs_difficulty` is FSRS's own
// 1-10 estimate that the scheduler reads back. Deriving the first from the
// second keeps one source of truth; writing FSRS's value into the old column
// would silently redefine "weak" for every existing card.
//
// NULL stability = this card has never been scheduled by FSRS. That is the flag
// the migration path keys on: a card with SM-2 history is seeded from its last
// interval rather than reset to new, so upgrading does not dump an entire
// collection back into today's queue.
// Supporting lines shown under the ANSWER, not part of it: a word's reading, an
// example sentence, that sentence's translation. Anki's card templates show
// these and the first importer dropped them, which turned a 14-field vocabulary
// note into a two-word stub ("早い → はやい", with "early" nowhere on the card).
// Its own column rather than glued onto `back`, because the answer is what the
// learner is being asked for and the rest is context around it.
addColumnIfMissing('flashcards', 'extra', 'TEXT DEFAULT NULL');

// Pictures and audio attached to a card, as JSON: `{front:[…], back:[…]}` where
// each entry is `{hash, kind, name, alt}`. NULL on the overwhelming majority of
// cards, which is why it is a column on the card rather than a join table:
// rendering a card must never cost a second query, and hash+kind is everything
// the renderer needs. The mutable, per-FILE facts (mime, size, description, who
// owns it) live in `media_files` — one row per file, not per use of it.
addColumnIfMissing('flashcards', 'media', 'TEXT DEFAULT NULL');

addColumnIfMissing('flashcards', 'stability', 'REAL DEFAULT NULL');
addColumnIfMissing('flashcards', 'fsrs_difficulty', 'REAL DEFAULT NULL');
addColumnIfMissing('flashcards', 'state', 'INTEGER DEFAULT 0');
addColumnIfMissing('flashcards', 'lapses', 'INTEGER DEFAULT 0');

// Per-review history — what happened to a card, not only what its schedule is
// now. Appended by the flashcard update endpoint when a request carries a
// rating, removed by the same endpoint on undo, and filled from Anki's own
// `revlog` at import. The FSRS optimiser (server/fsrsOptimizer.js) fits on it
// and the retention readout is measured from it; see server/reviewLog.js.
// `external_id` is Anki's revlog id, unique per source, so a deck imported
// twice cannot double its history.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      reviewed_at TEXT NOT NULL,
      rating INTEGER NOT NULL,
      state_before INTEGER,
      elapsed_days REAL,
      scheduled_days REAL,
      stability_before REAL,
      difficulty_before REAL,
      stability_after REAL,
      difficulty_after REAL,
      source TEXT NOT NULL DEFAULT 'app',
      external_id TEXT,
      FOREIGN KEY (card_id) REFERENCES flashcards(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_review_log_card ON review_log(card_id, reviewed_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_log_external
      ON review_log(source, external_id) WHERE external_id IS NOT NULL;
  `);
} catch (e) {
  console.warn('[Migration] review_log:', e.message);
}

// Persisted reasoning trace for assistant turns: a thinking-capable model's
// raw reasoning channel, saved alongside the answer so the collapsible
// "Reasoning" panel survives a reload.
addColumnIfMissing('chat_messages', 'reasoning', 'TEXT DEFAULT NULL');

// Vault: original-file metadata for documents. `content`/chunks already hold
// the extracted text; these describe the original binary kept in the
// content-addressed blob store (see server/vaultStorage.js). file_hash is the
// SHA-256 of the original and is NULL for text-only docs created via the API.
addColumnIfMissing('documents', 'original_filename', 'TEXT DEFAULT NULL');
addColumnIfMissing('documents', 'file_hash', 'TEXT DEFAULT NULL');
addColumnIfMissing('documents', 'file_size', 'INTEGER DEFAULT NULL');
addColumnIfMissing('documents', 'status', "TEXT DEFAULT 'ready'"); // ready | failed
addColumnIfMissing('documents', 'error', 'TEXT DEFAULT NULL');
addColumnIfMissing('documents', 'page_count', 'INTEGER DEFAULT NULL');

// Math/formula recovery for PDFs whose text layer drops equations (Word/LaTeX
// exports embed math in subsetted fonts with no ToUnicode CMap, so pdf.js emits
// empty strings for every formula glyph — "( )" where "x(t)=1-t²" should be).
// We detect that per-page (dropped-glyph-width ratio) at upload, then a
// background pass re-reads the affected pages from the rendered image: a vision
// model transcribes to Markdown+LaTeX (primary), tesseract OCR is the offline
// fallback, and the text layer is kept if both are unavailable. See
// server/pdfRecovery.js. NULL = not applicable (not a PDF, or clean text layer);
// 'pending'|'running' in flight; 'recovered'|'failed'|'skipped' terminal.
addColumnIfMissing('documents', 'recovery_status', 'TEXT DEFAULT NULL');
// JSON blob describing the recovery outcome for the vault UI/info: method used
// ('vision'|'ocr'|'mixed'), pages recovered, per-page method. Kept separate from
// `error` (extraction failure) which stays reserved for a failed upload.
addColumnIfMissing('documents', 'recovery_meta', 'TEXT DEFAULT NULL');

// Semantic-search indexing state for a document's chunks, tracked separately
// from extraction `status` (a doc can be extracted/ready yet not-yet-embedded).
// NULL/'pending' = queued or in flight, 'indexed' = vectors written,
// 'unavailable' = no embedding model reachable (feature degraded to FTS only),
// 'error' = embedding failed. Read by the Vault UI badge + the reindex sweep.
addColumnIfMissing('documents', 'embedding_status', 'TEXT DEFAULT NULL');

// Dedup lookups + cleanup ("is this blob still referenced?") go through the hash.
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(file_hash)`);
// The serving path is `GET /api/media/:hash`, and the orphan sweep is a lookup
// per file on disk — both are hash-keyed, and neither may be a table scan.
db.exec(`CREATE INDEX IF NOT EXISTS idx_media_files_hash ON media_files(hash)`);

// Index for "due flashcards" queries — the most frequent dashboard query
db.exec(`CREATE INDEX IF NOT EXISTS idx_flashcards_next_review ON flashcards(next_review)`);

// Index for finding flashcards by project (via nodes) — used by deck listing
db.exec(`CREATE INDEX IF NOT EXISTS idx_flashcards_node_review ON flashcards(node_id, next_review)`);

// Index for quiz attempt aggregation — used by weak-topics query  
db.exec(`CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz_score ON quiz_attempts(quiz_id)`);

// Composite index for pace/dashboard overdue queries
db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_project_status ON nodes(project_id, status, is_note)`);

// Relax the nodes.status CHECK constraint.
// The original schema pinned status to ('not_started','in_progress','completed').
// The product is a *sovereign* mastery engine: a learner must be able to mark a
// topic 'skipped' ("I moved on without proving it") — a first-class, honest state
// distinct from a verified 'completed'. SQLite cannot ALTER a CHECK constraint, so
// on databases created with the old constraint we rebuild the table without it
// (status stays a plain TEXT column, validated in the API layer instead). This is
// idempotent: it only fires while the stored table SQL still carries the CHECK.
try {
  const nodesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'").get();
  if (nodesSql && /CHECK\s*\(\s*status/i.test(nodesSql.sql)) {
    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE nodes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          parent_id INTEGER,
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          status TEXT DEFAULT 'not_started',
          is_note INTEGER DEFAULT 0,
          position INTEGER DEFAULT 0,
          scheduled_start TEXT DEFAULT NULL,
          scheduled_end TEXT DEFAULT NULL,
          estimated_weight REAL DEFAULT NULL,
          completed_at TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE CASCADE
        );
      `);
      copyRowsIntoRebuilt('nodes', 'nodes_new');
      db.exec(`
        DROP TABLE nodes;
        ALTER TABLE nodes_new RENAME TO nodes;
        CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);
        CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
        CREATE INDEX IF NOT EXISTS idx_nodes_project_status ON nodes(project_id, status, is_note);
      `);
    });
    rebuild();
    db.pragma('foreign_keys = ON');
    console.log('[Migration] Relaxed nodes.status CHECK constraint (enables "skipped" state)');
  }
} catch (e) {
  console.error('[Migration] Failed to relax nodes.status constraint (non-fatal):', e.message);
  try { db.pragma('foreign_keys = ON'); } catch (_) { }
}

// Default configuration for the mastery / gating engine. These make the
// "Prove" loop tunable instead of hardcoded, honoring the sovereignty principle:
//   mastery_gate_mode: 'off'      → never gate completion (pure tracker)
//                      'advisory' → offer to prove, but let the learner override (default)
//                      'enforced' → block a 'completed' mark until mastery is proven
//   mastery_threshold: BKT posterior needed to auto-pass the gate (0..1)
//   mastery_check_pass:   raw fraction of questions needed to pass a mastery check (0..1)
//   decay_days:        days without review before a mastered topic resurfaces
try {
  const gateDefaults = {
    mastery_gate_mode: 'advisory',
    mastery_threshold: '0.85',
    mastery_check_pass: '0.8',
    decay_days: '14',
  };
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(gateDefaults)) insertSetting.run(k, v);
} catch (e) {
  console.error('[Settings] Failed to seed gating defaults (non-fatal):', e.message);
}

// The prerequisite DAG is GONE (2026-09-04), and this drops it.
//
// It shipped in Phase 2 as a table, four endpoints and a clause in the mastery
// gate, and never got an interface — which is not the same as unused. Measured
// on the real library the day it was removed: 173 edges with
// `mastery_gate_mode` set to `enforced`, so 173 topics could not be marked
// complete until their predecessor was, and no screen would name the
// predecessor or cut the edge. Every one of them was written by the generator
// that used to chain siblings; in six months of use a person created zero.
//
// It was removed rather than finished, for a reason visible in the code it sat
// in: the prerequisite check returned BEFORE `checkMasteryEligibility` was ever
// called, so passing the mastery check could not clear a locked topic — structure
// outranked proof, inverting the one thing this engine claims to measure. What
// a learner knows is settled by evidence (the gate, the placement probe,
// mastery transfer), and curriculum ORDER is already carried by `nodes.position`.
//
// Dropping the table is what clears those rows, on every install rather than
// just the one that had them.
try {
  db.exec(`DROP TABLE IF EXISTS node_prerequisites;`);
} catch (e) {
  console.log('[Migration] Could not drop node_prerequisites:', e.message);
}

// PHASE 3: Mastery tracking tables
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_mastery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL UNIQUE,
      mastery_score REAL DEFAULT 0.0,
      total_attempts INTEGER DEFAULT 0,
      correct_attempts INTEGER DEFAULT 0,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mastery_node ON node_mastery(node_id);
    CREATE INDEX IF NOT EXISTS idx_mastery_score ON node_mastery(mastery_score);

    CREATE TABLE IF NOT EXISTS mastery_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      evidence_type TEXT NOT NULL,
      score REAL NOT NULL,
      total INTEGER NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_node ON mastery_evidence(node_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_type ON mastery_evidence(evidence_type);
  `);
} catch (e) {
  console.log('mastery tables already exist or error:', e.message);
}

// PHASE 4: node embedding bookkeeping.
//
// The vectors themselves live in `vec_nodes` (a sqlite-vec vec0 table created
// lazily by server/embeddings.js, keyed by node id). vec0 can't hold the
// bookkeeping we need alongside them and isn't reachable by a foreign key, so
// this sidecar table answers "is this topic's vector current?" without a single
// model call: `text_hash` covers the exact string that was embedded and the
// model that embedded it, so an edited Overview or a switched model both show
// up as drift on the next reconcile. See server/nodeEmbeddings.js.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_embeddings (
      node_id INTEGER PRIMARY KEY,
      text_hash TEXT NOT NULL,
      model TEXT,
      status TEXT DEFAULT 'indexed',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_node_embeddings_status ON node_embeddings(status);
  `);
} catch (e) {
  console.log('node_embeddings table already exists or error:', e.message);
}

// Mastery transfer: what a semantically-identical topic in ANOTHER project
// contributed to this one's starting estimate. Deliberately kept SEPARATE from
// mastery_score rather than folded into it — `transferred_prior` is the audit
// trail that says "this node's estimate did not start at zero, and here is
// exactly why", which is what lets the completion gate refuse to honour a
// borrowed estimate and what lets the UI name the topic it was borrowed from.
// NULL = never transferred (the ordinary case). See server/masteryTransfer.js.
addColumnIfMissing('node_mastery', 'transferred_prior', 'REAL DEFAULT NULL');
addColumnIfMissing('node_mastery', 'transfer_sources', 'TEXT DEFAULT NULL');
addColumnIfMissing('node_mastery', 'transfer_at', 'DATETIME DEFAULT NULL');

// Placement: what a short probe taken BEFORE studying contributed to this
// topic's starting estimate. Structurally the twin of the transfer columns
// above and separate for the same reason — the estimate did not start at zero,
// and the audit trail has to say exactly why so the completion gate can refuse
// to honour it and the UI can name the probe question it came from.
//
// Kept in its OWN columns rather than reusing `transferred_prior` because the
// two answer different questions ("you proved this in another course" vs "you
// answered a question about this correctly just now") and a card that says the
// wrong one is worse than a card that says nothing. Both are honoured
// identically by the gate — see the `borrowed` clause in mastery.js.
// NULL = never probed (the ordinary case). See server/placement.js.
addColumnIfMissing('node_mastery', 'placement_prior', 'REAL DEFAULT NULL');
addColumnIfMissing('node_mastery', 'placement_sources', 'TEXT DEFAULT NULL');
addColumnIfMissing('node_mastery', 'placement_at', 'DATETIME DEFAULT NULL');

// One placement probe per project. The question set is stored rather than held
// in memory because generating it costs a model call per question plus a
// verification pass: a learner who reloads the page mid-probe must find their
// probe where they left it, not pay for it twice. `state` moves
// generating -> ready -> done (or 'failed'), and `answers` accumulates
// {targetIndex, correct} as they go, so a half-finished probe still seeds what
// it measured.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS placement_probes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'generating',
      targets TEXT NOT NULL DEFAULT '[]',
      questions TEXT NOT NULL DEFAULT '[]',
      answers TEXT NOT NULL DEFAULT '[]',
      error TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME DEFAULT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_placement_project ON placement_probes(project_id);
  `);
} catch (e) {
  console.log('placement_probes table already exists or error:', e.message);
}

// Relax the mastery_evidence.evidence_type CHECK constraint.
// The original schema pinned it to ('quiz','flashcard','boss_fight') — the old
// spelling of the mastery check, which is what those databases really hold — but the
// engine has grown two more kinds of evidence since: 'drill' (D-023 practice
// rounds) and 'paper' (worked-on-paper exercises graded from a photo). Both were
// writing through updateMasteryFromAttempt and failing the CHECK — a drill round
// has been 500ing ever since it shipped, which is why no drill row exists in any
// database. Same treatment as nodes.status above: SQLite cannot ALTER a CHECK, so
// rebuild without it and validate in the API layer instead (VALID_EVIDENCE_TYPES).
// Idempotent: fires only while the stored table SQL still carries the CHECK.
try {
  const evidenceSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mastery_evidence'").get();
  if (evidenceSql && /CHECK\s*\(\s*evidence_type/i.test(evidenceSql.sql)) {
    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE mastery_evidence_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id INTEGER NOT NULL,
          evidence_type TEXT NOT NULL,
          score REAL NOT NULL,
          total INTEGER NOT NULL,
          metadata TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );
      `);
      copyRowsIntoRebuilt('mastery_evidence', 'mastery_evidence_new');
      db.exec(`
        DROP TABLE mastery_evidence;
        ALTER TABLE mastery_evidence_new RENAME TO mastery_evidence;
        CREATE INDEX IF NOT EXISTS idx_evidence_node ON mastery_evidence(node_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_type ON mastery_evidence(evidence_type);
      `);
    });
    rebuild();
    db.pragma('foreign_keys = ON');
    console.log('[Migration] Relaxed mastery_evidence.evidence_type CHECK (enables "drill" and "paper" evidence)');
  }
} catch (e) {
  console.error('[Migration] Failed to relax mastery_evidence.evidence_type constraint (non-fatal):', e.message);
}

// Compiled interactive-widget cache (```widget visual kind): the tutor emits a
// small functional spec; a background task compiles it into one self-contained
// HTML document. Verified builds are cached here by spec hash so reopening a
// chat renders the widget instantly with zero LLM calls. Not tied to a node —
// identical specs across chats legitimately share one build.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS widget_builds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_hash TEXT NOT NULL UNIQUE,
      spec TEXT NOT NULL,
      html TEXT NOT NULL,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch (e) {
  console.log('widget_builds table already exists or error:', e.message);
}

// Authored specs for the two HARD visual kinds (```animation and ```p5), the
// same split the widget already uses, generalised.
//
// The argument is the one D-022 made: writing a teaching reply and writing
// correct SMIL (or a frame-by-frame p5 coordinate system) are different jobs,
// and a model asked to do both at once does the second one badly — every gate
// and repair hint in this repo about invisible strokes, still "animations",
// off-canvas geometry and vectors scaled by a physical magnitude exists because
// of that. So the conversational model writes a short SCENE BRIEF in plain
// words, and a second call — carrying the full rendering rules for that one
// kind, which are far too long to sit in every chat turn's prompt — compiles it.
//
// Keyed by kind + brief hash, exactly like widget_builds and for exactly the
// same reason: the same brief in two conversations is one drawing, and a
// re-opened message must render without paying for a model call.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visual_builds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brief_hash TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      brief TEXT NOT NULL,
      spec TEXT NOT NULL,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch (e) {
  console.log('visual_builds table already exists or error:', e.message);
}

// Atlas region names. The map names a region after its medoid — free and
// deterministic — but a medoid can only ever be one member's title, so a region
// spanning a whole discipline gets named after one lesson in it ("Mandarin
// Chinese" over a region that is Languages). server/regionNaming.js earns a
// better name from the model and parks it here.
//
// Keyed by a hash of the region's MEMBER SET ALONE, never by region index:
// regions renumber whenever the library grows, so an index-keyed cache would
// silently move names between places. An unchanged region therefore keeps its
// name across every rebuild, which is what keeps the map deterministic in
// practice while the naming itself is a model call. No FK — a region is derived,
// not stored, and a name whose members are gone is simply never looked up again.
//
// The model is RECORDED here and is deliberately not part of the key. Borrowing
// it from the `node_embeddings` sidecar would be wrong here — there it is
// mandatory (two models' vector spaces are incomparable, so a vector from the
// wrong one is wrong), but a NAME is validated prose about a set of titles, and
// one written by another model is not invalid, merely written by another model.
// Measured on the real library when the chat model was switched: 91 of 115
// regions held a perfectly good name the map could no longer see, so every
// bubble fell back to its medoid. `model = 'user'` is a name the learner typed,
// which no sweep may overwrite.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS region_names (
      signature TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      model TEXT,
      member_count INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch (e) {
  console.log('region_names table already exists or error:', e.message);
}

// Why a region is still unnamed. A naming failure deliberately writes no name —
// keeping the medoid and retrying next time is the right answer for a model that
// was briefly unreachable. It is the wrong answer for a model that cannot do
// this job at all: with nothing recorded, every single atlas build re-queued the
// same sixty regions against the same model and stored nothing, forever (a
// reasoning-first model measured 5 names out of 60, and a build is one press of
// Redraw). This table is what makes a failure cost something. It records the
// model that failed, so switching models clears the way for a fresh attempt.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS region_name_failures (
      signature TEXT PRIMARY KEY,
      model TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      last_attempt_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch (e) {
  console.log('region_name_failures table already exists or error:', e.message);
}

// Learning-feed teaching cache. AI-generated lesson/question cards are
// pre-generated here (server/feedGen.js) so the home feed scrolls instantly;
// composition (server/feed.js) reads ready rows in seq order. One node's rows
// are bounded: 1 'plan' row (kind='plan', status='internal', the teaching
// outline — kept so a restart resumes the SAME outline) + up to 4 lessons and
// their questions. Degraded (AI-off) cards are composed live and never stored.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feed_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      meta TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      result TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      consumed_at DATETIME,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_feed_items_node ON feed_items(node_id, status, seq);
  `);
  // `consumed_at` used to be written as `datetime('now')` — the one column in
  // the app stamped in SQLite's shape by a JS writer rather than by a DEFAULT.
  // Nothing compared it against an ISO stamp, so no answer was wrong; but two
  // readers sort on the raw column (`recentMisses` in index.js,
  // `buildTodayActivity` in today.js), and a column holding both shapes sorts
  // every 'T' row after every ' ' row whatever the dates say. So the writer is
  // NOW_ISO now and the rows written before it are rewritten once, here, before
  // anything reads or sweeps them. `%f` renders `SS.sss`, which is what the
  // legacy second-grained values widen to and what toISOString() produces.
  // Idempotent: a row already carrying a 'T' is not matched. And a value
  // strftime cannot parse is LEFT ALONE rather than rewritten to NULL, which
  // is what it would return — a migration that loses the stamp it was fixing
  // is worse than the mixed shape it was fixing.
  {
    const fixed = db.prepare(
      `UPDATE feed_items SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at)
       WHERE consumed_at IS NOT NULL AND consumed_at NOT LIKE '%T%'
         AND strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS NOT NULL`
    ).run().changes;
    if (fixed > 0) console.log(`[Migration] Rewrote ${fixed} feed_items.consumed_at stamp(s) to ISO`);
  }

  // Growth control, idempotent: consumed cards older than 30 days, and the
  // whole teaching cache of closed nodes (checkpoint history lives in
  // mastery_evidence, not here).
  //
  // The cutoff is computed in JS and BOUND rather than written as
  // `datetime('now', '-30 days')`: the column is ISO now, and SQLite's own
  // rendering is the shape that does not compare against it.
  db.prepare(`DELETE FROM feed_items WHERE status = 'consumed' AND consumed_at < ?`)
    .run(new Date(Date.now() - 30 * 86400_000).toISOString());
  db.prepare(`DELETE FROM feed_items WHERE node_id IN (SELECT id FROM nodes WHERE status IN ('completed', 'skipped'))`).run();

  // One slot per (node, kind, seq) — enforced by the database rather than by
  // the generator checking first and inserting after.
  //
  // The generator is a single serial chain, so it cannot race ITSELF; but the
  // running server is not necessarily the only writer (tools/feed-regen.mjs
  // re-authors topics against the same file), and a check-then-insert across
  // two processes duplicates rows — observed as two paper exercises appearing
  // on one topic 13 seconds apart. Duplicates are also invisible in the UI:
  // the second card just shows up again later.
  //
  // Deduplicate before indexing, keeping the newest row of each slot — for a
  // regenerated topic that is the one written by the current pipeline.
  db.exec(`
    DELETE FROM feed_items WHERE id NOT IN (
      SELECT MAX(id) FROM feed_items GROUP BY node_id, kind, seq
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_items_slot ON feed_items(node_id, kind, seq);
  `);
} catch (e) {
  console.log('feed_items table already exists or error:', e.message);
}

// Paper practice (work-it-on-paper exercises graded from a photo).
// One row per submitted attempt. `image_hash` points into the same
// content-addressed blob store the vault uses (vaultStorage.js) — the PROCESSED
// image (perspective-corrected, contrast-boosted) is what gets kept, never the
// raw phone photo, which is 20x larger and of no further use once warped.
// `transcription` is stage A's reading of the sheet, `grade` stage B's verdict;
// both are kept so a disputed grade can be inspected against what the model
// actually saw — the single most useful thing to have when a grade looks wrong.
//
// Declared after feed_items so its FK target already exists. `ON DELETE SET NULL`
// (not CASCADE) is deliberate: the block above prunes the teaching cache of every
// closed node, and a learner's graded paper history must outlive that sweep — the
// attempt is evidence, the feed row was only the delivery vehicle.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      feed_item_id INTEGER,
      mode TEXT NOT NULL DEFAULT 'document',
      image_hash TEXT,
      transcription TEXT,
      grade TEXT,
      score REAL,
      total INTEGER,
      graded_by TEXT NOT NULL DEFAULT 'vision',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (feed_item_id) REFERENCES feed_items(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_node ON paper_attempts(node_id, created_at);
  `);
} catch (e) {
  console.log('paper_attempts table already exists or error:', e.message);
}

// What the app DID, kept locally so a person can look instead of reproduce.
//
// Three questions this answers and nothing else could: what was the app doing
// in the minutes before the thing you noticed, which model call was slow or
// refused, and how much work a background job actually did. The console had all
// of it and the console is not somewhere a person can look — it is behind a
// terminal they did not start.
//
// The one rule that shapes the columns: NO LEARNER CONTENT. No topic titles, no
// prompts, no model output, no note text, no file names. A row is a fact about
// the SOFTWARE — an area, a verb, a duration, an id, a short technical detail
// (a model id, an HTTP status, a count, an error string). That is what makes
// the exported file safe to hand to a developer or paste into a coding agent
// without reading it first, which is the whole point of keeping it; it is the
// same rule `src/utils/report.ts` follows for the diagnostics block.
//
// Deliberately NO foreign keys: the most interesting row in the table is often
// "project 12 deleted", and a cascade would erase exactly that. Ids here are
// historical, and the reader resolves the ones that still exist.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      area TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT,
      ms INTEGER,
      project_id INTEGER,
      node_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_activity_log_at ON activity_log(at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_log_level ON activity_log(level, at DESC);
  `);
} catch (e) {
  console.log('activity_log table already exists or error:', e.message);
}

// Global stable identity (UUID) alongside the integer PK.
//
// Integer PKs stay the internal join/FK key — device-local, and every existing
// query, URL, and lastInsertRowid path keeps working untouched. This `uuid` is
// the *portable* identity for the things that cross a device or marketplace
// boundary (projects/nodes/resources): on cross-device sync or a shared
// curriculum import, two databases' autoincrement ids would collide, but their
// uuids never do. We add it now, pre-launch, because it is cheap to seed into an
// empty-ish DB and painful to retrofit once real user data exists.
//
// SQLite has no native UUID function, so we mint RFC-4122 v4 ids from
// randomblob(). A per-table AFTER INSERT trigger fills any NULL uuid, so every
// insert path (REST API, AI-creation pipeline, Anki and curriculum importers)
// is covered without editing a single call site — and an importer *can* still
// supply its own uuid to preserve identity across machines. Existing rows are
// backfilled once here.
try {
  // Evaluated per-row (randomblob is non-deterministic), so each row is unique.
  const UUID_EXPR = `lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )`;

  let backfilled = 0;
  // `flashcards` joined on 2026-09-24: a card's schedule and its review history
  // hang on its row, so a later edition of a course can only update a card in
  // place if the file can say which card it means (COURSE-UPDATES.md).
  for (const table of ['projects', 'nodes', 'resources', 'flashcards']) {
    addColumnIfMissing(table, 'uuid', 'TEXT');
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_uuid_ai AFTER INSERT ON ${table}
      WHEN NEW.uuid IS NULL BEGIN
        UPDATE ${table} SET uuid = ${UUID_EXPR} WHERE id = NEW.id;
      END;
    `);
    // Backfill rows created before this migration.
    backfilled += db.prepare(`UPDATE ${table} SET uuid = ${UUID_EXPR} WHERE uuid IS NULL`).run().changes;
    // Enforce global uniqueness (post-backfill there are no NULLs left).
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_uuid ON ${table}(uuid)`);
  }
  // Silent when it did nothing, which is every start after the first: this block
  // is idempotent, so announcing it on a normal boot told the reader that
  // something happened to their database when nothing had.
  if (backfilled > 0) console.log(`[Migration] Gave ${backfilled} existing row(s) a portable uuid`);

  // A QUESTION's identity lives inside its bank's JSON (`quizzes.questions`),
  // where no column trigger can reach — so these two triggers rewrite the array
  // itself, giving every question the topic OWNS a `uuid` it lacks, on insert
  // and on every rewrite. A trigger rather than a helper at each writer for the
  // same reason as above: the feed, bulk generation, capture, the importer, the
  // answer check and the offline repair tool all write banks, and a writer that
  // forgot would silently produce questions nothing can find again.
  //
  // What it leaves alone: a question that has a uuid (never re-minted); a GHOST
  // (a copy of another topic's question inside a practice quiz — it keeps its
  // source's uuid if it has one and gets none of its own); and any row that is
  // not a JSON array of objects, which is written as-is rather than failing the
  // write. Order is kept (`ORDER BY key`). SQLite's recursive_triggers is off, so
  // the UPDATE below does not re-enter the UPDATE trigger.
  const missingQuestionUuid = (col) => `
    json_valid(${col}) AND json_type(${col}) = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_type(value) <> 'object')
    AND EXISTS (SELECT 1 FROM json_each(${col})
                WHERE IFNULL(json_extract(value, '$.uuid'), '') = ''
                  AND NOT IFNULL(json_extract(value, '$.isGhost'), 0))`;
  const stampedQuestions = (col) => `(
    SELECT json_group_array(
      CASE WHEN IFNULL(json_extract(value, '$.uuid'), '') = '' AND NOT IFNULL(json_extract(value, '$.isGhost'), 0)
           THEN json_set(value, '$.uuid', ${UUID_EXPR})
           ELSE json(value) END
      ORDER BY key)
    FROM json_each(${col}))`;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS quizzes_question_uuid_ai AFTER INSERT ON quizzes
    WHEN ${missingQuestionUuid('NEW.questions')} BEGIN
      UPDATE quizzes SET questions = ${stampedQuestions('NEW.questions')} WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS quizzes_question_uuid_au AFTER UPDATE OF questions ON quizzes
    WHEN ${missingQuestionUuid('NEW.questions')} BEGIN
      UPDATE quizzes SET questions = ${stampedQuestions('NEW.questions')} WHERE id = NEW.id;
    END;
  `);
  const stampedBanks = db.prepare(`UPDATE quizzes SET questions = ${stampedQuestions('questions')}
                                   WHERE ${missingQuestionUuid('questions')}`).run().changes;
  if (stampedBanks > 0) console.log(`[Migration] Gave the questions in ${stampedBanks} bank(s) a portable uuid`);

  // The ask-record names the question as well as its position, so a bank that
  // is rewritten (the answer check drops vetoed questions) keeps its memory.
  // Rows written before the column existed take the uuid of whatever question
  // sits at their position NOW — the best there is, and exactly what the
  // positional record already believed.
  addColumnIfMissing('question_log', 'question_uuid', 'TEXT');
  const namedLogs = db.prepare(`
    UPDATE question_log SET question_uuid = (
      SELECT CASE WHEN json_valid(q.questions)
                  THEN json_extract(q.questions, '$[' || question_log.question_index || '].uuid') END
      FROM quizzes q WHERE q.id = question_log.quiz_id)
    WHERE question_uuid IS NULL
      AND EXISTS (SELECT 1 FROM quizzes q WHERE q.id = question_log.quiz_id AND json_valid(q.questions)
                  AND json_extract(q.questions, '$[' || question_log.question_index || '].uuid') IS NOT NULL)
  `).run().changes;
  if (namedLogs > 0) console.log(`[Migration] Named the question behind ${namedLogs} ask-record row(s)`);
} catch (e) {
  console.error('[Migration] uuid identity migration failed (non-fatal):', e.message);
}

// One-time orphan cleanup. Databases created before foreign-key enforcement
// was enabled may contain rows whose parent was deleted without cascading
// (orphaned subtrees, resources, flashcards, etc.). With foreign_keys now ON
// these can no longer be created, so this is a safe, idempotent repair: on a
// healthy DB every statement removes 0 rows and nothing is logged.
try {
  let removed = 0;

  // Nodes whose parent vanished. Deleting an orphan cascades to its subtree
  // (FK is on now), but loop until stable to catch any multi-level leftovers.
  let pass;
  do {
    pass = db.prepare(
      `DELETE FROM nodes WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM nodes)`
    ).run().changes;
    removed += pass;
  } while (pass > 0);

  // Nodes whose owning project vanished.
  removed += db.prepare(`DELETE FROM nodes WHERE project_id NOT IN (SELECT id FROM projects)`).run().changes;

  // Child tables that lost their parent node/document/project.
  removed += db.prepare(`DELETE FROM resources WHERE node_id NOT IN (SELECT id FROM nodes)`).run().changes;
  removed += db.prepare(`DELETE FROM flashcards WHERE node_id NOT IN (SELECT id FROM nodes)`).run().changes;
  removed += db.prepare(`DELETE FROM quizzes WHERE node_id NOT IN (SELECT id FROM nodes)`).run().changes;
  removed += db.prepare(`DELETE FROM quiz_attempts WHERE quiz_id NOT IN (SELECT id FROM quizzes)`).run().changes;
  removed += db.prepare(`DELETE FROM documents WHERE node_id IS NOT NULL AND node_id NOT IN (SELECT id FROM nodes)`).run().changes;
  removed += db.prepare(`DELETE FROM document_chunks WHERE document_id NOT IN (SELECT id FROM documents)`).run().changes;
  // vec_chunks (sqlite-vec) is keyed by chunk id but is NOT a real FK, so the
  // cascade above can't reach it — sweep any vector whose chunk is gone.
  try { removed += db.prepare(`DELETE FROM vec_chunks WHERE rowid NOT IN (SELECT id FROM document_chunks)`).run().changes; } catch (_) { /* table not created yet / vec unavailable */ }
  // vec_nodes is the same story one level up: keyed by node id, no FK, so a
  // deleted topic leaves its vector behind to be matched against forever.
  try { removed += db.prepare(`DELETE FROM vec_nodes WHERE rowid NOT IN (SELECT id FROM nodes)`).run().changes; } catch (_) { }
  removed += db.prepare(`DELETE FROM chat_messages WHERE node_id IS NOT NULL AND node_id NOT IN (SELECT id FROM nodes)`).run().changes;
  removed += db.prepare(`DELETE FROM learning_sessions WHERE project_id NOT IN (SELECT id FROM projects)`).run().changes;

  // Optional tables (created in later migration blocks).
  try { removed += db.prepare(`DELETE FROM node_mastery WHERE node_id NOT IN (SELECT id FROM nodes)`).run().changes; } catch (_) { }
  try { removed += db.prepare(`DELETE FROM mastery_evidence WHERE node_id NOT IN (SELECT id FROM nodes)`).run().changes; } catch (_) { }
  try { removed += db.prepare(`DELETE FROM feed_items WHERE node_id NOT IN (SELECT id FROM nodes)`).run().changes; } catch (_) { }
  try { removed += db.prepare(`DELETE FROM paper_attempts WHERE node_id NOT IN (SELECT id FROM nodes)`).run().changes; } catch (_) { }

  if (removed > 0) {
    console.log(`[Cleanup] Removed ${removed} orphaned row(s) left over from before foreign-key enforcement`);
  }

  // Notes are reference material, never work items — strip any schedule dates that
  // earlier scheduling runs may have left on them so they stop leaking into the
  // calendar / pace / daily plan as phantom tasks. Idempotent.
  try {
    const fixed = db.prepare(
      `UPDATE nodes SET scheduled_start = NULL, scheduled_end = NULL
       WHERE is_note = 1 AND (scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL)`
    ).run().changes;
    if (fixed > 0) console.log(`[Cleanup] Cleared schedule dates from ${fixed} note(s)`);
  } catch (_) { }
} catch (e) {
  console.error('[Cleanup] Orphan cleanup failed (non-fatal):', e.message);
}

// Clear stale ai_generating flags on restart
try {
  db.exec(`UPDATE projects SET ai_generating = 0 WHERE ai_generating = 1`);
} catch (e) {
  console.error('Failed to clear stale ai_generating flags:', e.message);
}

// --- Provenance: which model wrote this row --------------------------------
//
// JSON `{"provider","model"}` written by `aiProvenance()` in ai.js, and NULL on
// anything a person or an import wrote — that NULL is the signal, not a gap, so
// nothing backfills it. The one non-NULL an import writes is a course FILE's own
// claim on a card, `{"model","via":"import"}`, so a shared course's mark survives
// being imported and exported again (a question keeps its claim inside its JSON). Tables that already carry a JSON metadata column
// (`feed_items.meta`, `documents.recovery_meta`) get the same two keys stamped
// in there instead of a second column, and `widget_builds.model` already did
// this on its own.
//
// **This block must stay LAST**, after every CREATE TABLE and every table
// rebuild. `addColumnIfMissing` swallows its error, so an ALTER against a table
// that does not exist yet fails silently — and a rebuild that recreates a table
// from an explicit column list drops any column added before it. Both happened:
// `paper_attempts` is created several hundred lines below where this block
// first sat, and the `nodes.status` CHECK rebuild ran after it. On an existing
// database neither showed, because the table was already there and the rebuild
// had run long ago; a FRESH install got neither column and would have 500'd on
// the first paper grade. Guard: `node tools/provenance-gates.mjs`.
addColumnIfMissing('flashcards', 'generated_by', 'TEXT DEFAULT NULL');
addColumnIfMissing('quizzes', 'generated_by', 'TEXT DEFAULT NULL');
addColumnIfMissing('chat_messages', 'generated_by', 'TEXT DEFAULT NULL');
addColumnIfMissing('paper_attempts', 'generated_by', 'TEXT DEFAULT NULL');
addColumnIfMissing('nodes', 'generated_by', 'TEXT DEFAULT NULL');
addColumnIfMissing('resources', 'generated_by', 'TEXT DEFAULT NULL');
// `media_files.described_by` already records the MECHANISM ('author' | 'vision')
// and the stats query aggregates on that string, so the model name goes in its
// own column rather than overloading one that something already reads.
addColumnIfMissing('media_files', 'generated_by', 'TEXT DEFAULT NULL');

// **What the deck's author printed on the QUESTION beside the word.** Anki's
// card template is the only thing that knows this — a vocabulary deck's is `{{Word}}` then
// `{{Sentence}}` — and the importer used to flatten every field but the prompt
// into `extra`, one answer-side block, leaving the client to infer which of
// those lines had been on the front by matching the word against the sentence.
// A guess standing in for a stated fact, and it broke where guesses break
// (する / します share no prefix). NULL means "nothing said" — a hand-made card,
// an AI-written card, or a template this could not read — and the client's
// `contextSentence` inference stays as the fallback for exactly those.
addColumnIfMissing('flashcards', 'extra_front', 'TEXT DEFAULT NULL');

// **Which rung of the (re)learning ladder a card is on** (FSRS `learning_steps`).
// Zero for everything that is not mid-ladder, which is why the default is 0 and
// not NULL: an existing collection is entirely in Review or New, so a backfill
// of 0 is the truth rather than a guess.
//
// It has to be persisted because FSRS's next step is a function of it — a card
// on step 1 of `1m, 10m` rated Good graduates to a day-scale interval, one on
// step 0 moves to the 10m rung. `toFsrsCard` used to hardcode 0, which was
// harmless while short-term steps were off and would otherwise restart the
// ladder on every page load. See src/utils/srs.ts.
addColumnIfMissing('flashcards', 'learning_steps', 'INTEGER DEFAULT 0');

// **What this node IS**: `topic` (something that can be taught, proven, embedded
// and drawn on the map) or `pagination` (a slice the importer cut out of a
// deck's card order, named "Stage 7", which is a place in a sequence and not a
// thing to know).
//
// This is the column that replaced `projects.kind` as the thing the engine
// branches on — see server/nodeRole.js for why one enum on the project could
// not answer the question. The default is `topic` because everything written
// here, by a person or a model, is one; only the importer writes the other
// value, and only for boundaries it invented itself.
addColumnIfMissing('nodes', 'role', `TEXT DEFAULT 'topic'`); // topic | pagination
// What an assistant turn DID before it answered - the lookups it chose to run
// (server/aiTools.js), as JSON. Stored for the same reason `reasoning` is: a
// record that lives only while the answer streams is one the learner cannot go
// back to, and this one is the app's disclosure of what left the machine.
addColumnIfMissing('chat_messages', 'actions', 'TEXT DEFAULT NULL');
// What an assistant turn's `[[set:…]]` markers replaced, as JSON ({key: value
// before}), read as the answer is stored — before the client applies it. The
// next turn is told, so "undo" is a marker the model can write
// (server/assistantSettings.js).
addColumnIfMissing('chat_messages', 'settings_before', 'TEXT DEFAULT NULL');

/**
 * `now` as a string that compares correctly against a stored ISO timestamp.
 *
 * **`datetime('now')` does not**, and every flashcard due-query used it. SQLite
 * renders that as `2026-09-03 11:19:30` while `Date.toISOString()` — what every
 * writer in this app stores — renders `2026-09-03T10:00:00.000Z`, and the
 * comparison is a plain string compare: `'T'` (0x54) sorts after `' '` (0x20),
 * so a card due EARLIER TODAY read as not due and only surfaced at the next UTC
 * midnight. That was invisible while every interval was a whole day (it looks
 * like day-graining, which is what the app claimed to be) and is fatal to a
 * 10-minute (re)learning step.
 *
 * `strftime` with the ISO shape is byte-identical to `toISOString()` and, unlike
 * wrapping the column in `datetime(...)`, leaves `idx_flashcards_next_review`
 * usable. Verified against the real column: all 738 stored values match
 * `____-__-__T%Z`, so there is no legacy format to accommodate.
 */
export const NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// `projects.hours_per_day` is GONE (2026-09-04). It was a slider from 0.5 to 8
// and a column, and it never reached a single date: the allocator multiplied a
// phase's capacity by it and then divided the cursor by it again, so it
// cancelled out of every calculation it appeared in. Its only surviving effect
// was a floor on a leaf's weight (`0.5 / hoursPerDay`), now the plain constant
// `MIN_LEAF_WEIGHT` in scheduling.js — measured across the real library, the
// hours-free engine reproduces all 3050 scheduled dates byte-for-byte, for
// projects set to 1, 1.5, 2 and 5 hours a day alike. The one thing it did do
// was let the schedule dialog print an "estimated ~62 hours of study" built on
// an invented 1.5 hours per topic, a constant nothing measured.
//
// Dropped rather than left dormant: a column nothing writes still reads as a
// setting to the next person who finds it. Old `baseline_schedule` snapshots
// keep their `hours_per_day` config key — they are historical records of a run
// that really did happen with that value, and nothing parses it.
try {
  const cols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name);
  if (cols.includes('hours_per_day')) db.exec(`ALTER TABLE projects DROP COLUMN hours_per_day;`);
} catch (e) {
  console.log('[Migration] Could not drop projects.hours_per_day:', e.message);
}

// "Boss Fight" is GONE (2026-09-21). The assessment it named is a MASTERY
// CHECK, and the rename reaches the STORED values, not just the screen.
//
// It has to. Nothing reads the old spelling any more, and the evidence clause
// is a literal set: `checkMasteryEligibility` counts
// `evidence_type IN ('quiz','mastery_check','paper')`, so a library left half
// renamed would keep the rows and stop counting them — every topic proved by a
// Boss Fight would quietly become unproven, with no error anywhere.
//
// Four places hold the string: the evidence type, the JSON metadata that
// records which path wrote a row, the learner's own pass mark and the measured
// per-call average (two settings keys), and the tutor's `[[boss-fight]]`
// marker inside stored chat messages — which is parsed at RENDER time, so an
// unmigrated one shows the scaffolding to the learner as literal text.
//
// Idempotent: every statement is keyed on the old value still being present.
// It runs after the CHECK-relaxing rebuild above, which is what would otherwise
// refuse the new value.
try {
  let moved = 0;
  const rename = db.transaction(() => {
    moved += db.prepare(`UPDATE mastery_evidence SET evidence_type = 'mastery_check' WHERE evidence_type = 'boss_fight'`).run().changes;
    moved += db.prepare(`UPDATE mastery_evidence SET metadata = replace(metadata, '"boss_fight"', '"mastery_check"') WHERE metadata LIKE '%boss_fight%'`).run().changes;
    moved += db.prepare(`UPDATE quiz_attempts SET answers = replace(answers, '"boss_fight"', '"mastery_check"') WHERE answers LIKE '%boss_fight%'`).run().changes;

    // The learner's setting wins over the default the seed block inserted under
    // the new key earlier this same boot, so this is REPLACE and not IGNORE.
    for (const [from, to] of [
      ['boss_fight_pass', 'mastery_check_pass'],
      ['bulk_avg_ms_boss_fight', 'bulk_avg_ms_mastery_check'],
    ]) {
      moved += db.prepare('INSERT OR REPLACE INTO settings (key, value) SELECT ?, value FROM settings WHERE key = ?').run(to, from).changes;
      db.prepare('DELETE FROM settings WHERE key = ?').run(from);
    }

    // Rewritten in JS, not by SQL `replace`: SQLite's is case-sensitive while
    // the marker parser is not, so a message carrying `[[Boss-Fight]]` would
    // survive a SQL pass and render as junk.
    const stale = db.prepare("SELECT id, content FROM chat_messages WHERE content LIKE '%boss-fight%'").all();
    const rewrite = db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?');
    for (const row of stale) {
      const next = row.content.replace(/\[\[\s*boss-fight\s*\]\]/gi, '[[mastery-check]]');
      if (next !== row.content) { rewrite.run(next, row.id); moved++; }
    }
  });
  rename();
  if (moved) console.log(`[Migration] Renamed ${moved} stored "boss_fight" records to "mastery_check"`);
} catch (e) {
  console.error('[Migration] Failed to rename boss_fight to mastery_check (non-fatal):', e.message);
}

// Answering with the web became ONE switch (server/webContext.js): the model
// decides mid-answer whether to look something up, so "ask me each question"
// and "whenever it helps" described the same wire and the composer's
// per-question switch asked the same question twice.
//
// Normalised here rather than read leniently at every call site, so the column
// holds one shape and `webSearchEnabled()` is a single comparison. FAILS
// CLOSED on the one value where the readings differ: `auto` was blanket
// permission and carries over, while `ask`/`true` required a fresh yes per
// turn that defaulted to NO — an upgrade must not hand out a permission that
// was never granted to a single question.
try {
  const changed = db.prepare(`UPDATE settings SET value = CASE WHEN value = 'auto' THEN 'on' ELSE 'off' END
                              WHERE key = 'ai_web_search' AND value NOT IN ('on', 'off')`).run().changes;
  if (changed) console.log('[Migration] Web answering is now one switch (ai_web_search: on | off)');
} catch (e) {
  console.error('[Migration] Failed to normalise ai_web_search (non-fatal):', e.message);
}

// The schema is now current for this build. Recorded LAST, after every CREATE
// TABLE, every `addColumnIfMissing` and every table rebuild above — a stamp
// written earlier would mark the database as migrated by a run that then threw
// halfway, and the next start would skip both the migration and its snapshot.
try {
  const v = currentAppVersion();
  if (v) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('app_version', v);
} catch { /* a stamp is bookkeeping; never fatal */ }

/** The file this process opened — for the desktop status panel and the logs. */
export const DB_PATH = DB_FILE;

/**
 * Close the database cleanly. Called by the desktop lifecycle on quit: a
 * TRUNCATE checkpoint folds the WAL back into the main file, so the library is
 * one file again when the process exits — a backup taken by copying the .db
 * afterwards is complete. Every failure is swallowed; a close that throws must
 * not keep a process alive that was asked to stop.
 */
export function closeDatabase() {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  try { db.close(); } catch { /* already closed */ }
}

export default db;
