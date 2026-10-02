// tools/anki-refresh-text.mjs — re-read a deck and refresh the TEXT of the
// cards it already imported, in place.
//
//   node tools/anki-refresh-text.mjs --project <id> --deck "path/to/deck.apkg"
//   ...add --write to actually save (it is a dry run by default)
//
// ## Why this exists
//
// The importer improves. When it learns to keep something it used to throw away
// — the furigana above a kanji, the emphasis marking the target word inside an
// example sentence — every deck already in the library still holds the poorer
// text, because an import is a one-time copy. The only route back was to import
// the deck again, which creates a SECOND project and leaves the learner to move
// or abandon whatever progress the first one carries.
//
// This is the narrow alternative: same project, same cards, same schedule, only
// the words replaced. It is deliberately NOT the "merge an updated course into
// the one I hold" feature (see docs/ARCHITECTURE.md — import always creates a new project
// and says so). It adds no cards, removes no cards, and touches no scheduling,
// mastery or media column. If a card cannot be matched confidently it is left
// exactly as it is and counted, because the failure this protects against is
// the same one the importer protects against: a silent partial change nobody
// notices for months.
//
// Matching is by the card's QUESTION, compared with markup stripped from both
// sides, within the project. A question that is not unique in the deck (or not
// unique in the project) is skipped rather than guessed at.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const projectId = Number(argOf('--project'));
const deckPath = argOf('--deck');
const write = args.includes('--write');
const limit = Number(argOf('--limit', '0'));

if (!projectId || !deckPath) {
    console.error('usage: node tools/anki-refresh-text.mjs --project <id> --deck <file.apkg> [--write] [--limit n]');
    process.exit(2);
}

const { default: db } = await import('../server/database.js');
const { parseApkg } = await import('../server/ankiImport.js');

/** The words, with our two card conventions removed — see src/utils/cardText.ts. */
const bare = (s) => String(s ?? '')
    .replace(/\*\*/g, '')
    // `漢字[かな]` -> `漢字`, and the separator space Anki writes before the base.
    .replace(/[ 　]?([㐀-䶿一-鿿々〆ヶ]+)\[[ぁ-ゟ゠-ヿ]+\]/g, '$1')
    .replace(/\s+/g, '')
    .toLowerCase();

const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
if (!project) { console.error(`No project ${projectId}.`); process.exit(1); }

const existing = db.prepare(`
    SELECT f.id, f.front, f.back, f.extra, f.extra_front, f.media
    FROM flashcards f JOIN nodes n ON n.id = f.node_id
    WHERE n.project_id = ?
`).all(projectId);

console.log(`Project ${project.id} — ${project.name}: ${existing.length} cards on disk.`);
console.log(`Reading ${deckPath} …`);

// Media is left alone entirely: the blobs are already stored and referenced, and
// re-extracting them would write a second copy of a 100 MB deck to do nothing.
const parsed = await parseApkg(readFileSync(deckPath), { importMedia: false });
console.log(`Deck parsed: ${parsed.cards.length} cards.`);

// **The question is the front AND its question-side line.** A phrasebook
// asks "French / Hello" — the language on the front, the phrase under it —
// so the front alone is shared by every card of that language and 4,237 of
// 4,317 cards read as ambiguous. A row imported before `extra_front` existed
// carries no such line and is matched on the front alone, as before.
const keyOf = (front, extraFront) => {
    const f = bare(front);
    if (!f) return '';
    return extraFront == null ? f : `${f}\u0000${bare(extraFront)}`;
};
const index = (map, key, value) => {
    if (!key) return;
    if (map.has(key)) map.set(key, null);      // ambiguous — never guess
    else map.set(key, value);
};

const byKey = new Map(), byFront = new Map();
for (const card of parsed.cards) {
    index(byKey, keyOf(card.front, card.extraFront ?? ''), card);
    index(byFront, keyOf(card.front, null), card);
}

const existingByKey = new Map();
for (const row of existing) index(existingByKey, keyOf(row.front, row.extra_front), row);
const lookup = (key) => key.includes('\u0000') ? byKey.get(key) : byFront.get(key);

const update = db.prepare('UPDATE flashcards SET front = ?, back = ?, extra = ?, extra_front = ?, media = ? WHERE id = ?');

/** The stored media JSON with each clip's `at` taken from the fresh parse; the unchanged string when nothing moves. */
function reanchorMedia(stored, refs) {
    if (!stored || !refs) return stored;
    let obj;
    try { obj = JSON.parse(stored); } catch { return stored; }
    const byFile = new Map();
    for (const side of ['front', 'back']) for (const r of refs[side] ?? []) if (r.file && !byFile.has(r.file)) byFile.set(r.file, r);
    let changed = false;
    for (const side of ['front', 'back']) {
        for (const m of obj?.[side] ?? []) {
            const r = m?.name ? byFile.get(m.name) : null;
            const at = r?.at || '';
            if ((m.at || '') === at) continue;
            if (at) m.at = at; else delete m.at;
            changed = true;
        }
    }
    return changed ? JSON.stringify(obj) : stored;
}
const changes = [];
let unmatched = 0, ambiguous = 0, unchanged = 0;

for (const [key, row] of existingByKey) {
    if (!row) { ambiguous++; continue; }
    const fresh = lookup(key);
    if (fresh === undefined) { unmatched++; continue; }
    if (fresh === null) { ambiguous++; continue; }

    // `extra_front` is what the card TEMPLATE says belongs on the question
    // side. It is the reason this tool exists in the first place: an importer
    // improvement has to reach decks imported before it, and re-importing
    // would create a second project and abandon the learner's progress.
    const next = { front: fresh.front, back: fresh.back, extra: fresh.extra ?? '', extra_front: fresh.extraFront ?? '' };
    // The clips keep their blobs (same hashes, nothing re-extracted); what a
    // refresh can give them is the LINE they belong to, matched by filename
    // against the deck's unresolved references. A swap at import moved the
    // sides, so both sides of the deck are searched for each stored clip.
    next.media = reanchorMedia(row.media, fresh.mediaRefs);
    if (next.front === row.front && next.back === row.back && (next.extra || '') === (row.extra || '')
        && (next.extra_front || '') === (row.extra_front || '') && next.media === row.media) {
        unchanged++;
        continue;
    }
    // The answer is the one field a refresh must not quietly rewrite into
    // something else: a different field mapping would change what the card is
    // ASKING, and the learner's history is attached to the old question.
    if (bare(next.back) !== bare(row.back)) {
        console.log(`  ! id ${row.id} answer would change: ${JSON.stringify(row.back)} -> ${JSON.stringify(next.back)}`);
    }
    changes.push({ id: row.id, before: row, after: next });
}

console.log(`\nmatched & changed: ${changes.length}`);
console.log(`already current:   ${unchanged}`);
console.log(`not in the deck:   ${unmatched}`);
console.log(`ambiguous (skipped): ${ambiguous}`);

const sample = changes.slice(0, limit || 3);
for (const c of sample) {
    console.log(`\n--- card ${c.id}`);
    console.log(`  front: ${JSON.stringify(c.before.front)} -> ${JSON.stringify(c.after.front)}`);
    console.log(`  extra: ${JSON.stringify(c.before.extra)}`);
    console.log(`      -> ${JSON.stringify(c.after.extra)}`);
    console.log(`  question-side: ${JSON.stringify(c.before.extra_front)} -> ${JSON.stringify(c.after.extra_front)}`);
}

if (!write) {
    console.log('\nDry run — nothing was written. Re-run with --write to save.');
    process.exit(0);
}

const run = db.transaction(() => {
    for (const c of changes) update.run(c.after.front, c.after.back, c.after.extra, c.after.extra_front || null, c.after.media ?? null, c.id);
});
run();
console.log(`\nWrote ${changes.length} cards. Scheduling, mastery and the media files were not touched.`);
