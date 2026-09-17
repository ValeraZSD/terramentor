#!/usr/bin/env node
/**
 * Anki EXPORT gates.
 *
 *   node tools/anki-export-gates.mjs
 *
 * No model, no network, no touching the learner's database — a scratch DB is
 * built in a temp directory and thrown away.
 *
 * The centrepiece is a ROUND TRIP: build a real .apkg with the exporter, then
 * read it back with `parseApkg` — the same importer that reads decks from
 * strangers. That is a stronger assertion than any hand-written expectation
 * about Anki's schema, because it fails for the two reasons a hand-written
 * .apkg actually fails in the wild: a structurally valid archive that Anki
 * parses into zero cards, and one that parses into cards whose scheduling has
 * quietly been reset.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import Database from 'better-sqlite3';

import {
    textToAnkiHtml, ankiHtmlToText, fieldChecksum, sanitizeDeckSegment, deckPath,
    mediaTags, parseCardMedia, noteFieldsForCard, schedulingForCard,
    buildModel, buildDeck, buildColConf, buildDeckConfig,
    buildNoteRows, buildDeckPaths, collectionCreationSec,
    exportProjectApkg, buildProjectApkg, DECK_SEP,
    CARD_NEW, CARD_REVIEW, MIN_EASE, DEFAULT_EASE, MAX_INTERVAL_DAYS,
} from '../server/ankiExport.js';

// `ankiImport.js` imports `database.js`, which OPENS A DATABASE at module load.
// Static-importing it here would open the learner's real library just to run a
// test. Point DB_PATH at a throwaway first, then import dynamically — ESM hoists
// static imports above every statement, so this is the only ordering that works.
const SCRATCH = mkdtempSync(join(tmpdir(), 'mnem-export-gate-db-'));
process.env.DB_PATH = join(SCRATCH, 'gate.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(SCRATCH, 'vault');
const { parseApkg } = await import('../server/ankiImport.js');

let passed = 0;
const failures = [];
function ok(cond, label) {
    if (cond) { passed += 1; } else { failures.push(label); }
}
function eq(actual, expected, label) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a === b) { passed += 1; } else { failures.push(`${label}\n      expected ${b}\n      got      ${a}`); }
}

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// ---------------------------------------------------------------------------
// 1. Text conversion — the plain-text/HTML boundary
// ---------------------------------------------------------------------------
eq(textToAnkiHtml('hello'), 'hello', 'plain text passes through');
eq(textToAnkiHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d', 'markup characters are escaped');
eq(textToAnkiHtml('one\ntwo'), 'one<br>two', 'newline becomes <br>');
eq(textToAnkiHtml('one\r\ntwo'), 'one<br>two', 'CRLF becomes ONE <br>, not two');
eq(textToAnkiHtml('スポーツは**あまり**好き'), 'スポーツは<b>あまり</b>好き',
    'emphasis inside CJK converts (the case CommonMark structurally cannot do)');
eq(textToAnkiHtml('好[す]き'), '好[す]き', 'furigana brackets are left alone — already Anki syntax');
eq(textToAnkiHtml('a * b * c'), 'a * b * c', 'single asterisks are not emphasis');
eq(textToAnkiHtml('**a\nb**'), '**a<br>b**', 'emphasis does not span a line break');
eq(textToAnkiHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;',
    'an imported deck\'s stray tag cannot become live markup in the export');
eq(textToAnkiHtml(null), '', 'null is empty, not "null"');
eq(textToAnkiHtml(undefined), '', 'undefined is empty');

eq(ankiHtmlToText(textToAnkiHtml('a < b')), 'a < b', 'escape round-trips');
eq(ankiHtmlToText(textToAnkiHtml('x**y**z')), 'x**y**z', 'emphasis round-trips');
eq(ankiHtmlToText(textToAnkiHtml('one\ntwo')), 'one\ntwo', 'newline round-trips');

// ---------------------------------------------------------------------------
// 2. Checksum
// ---------------------------------------------------------------------------
ok(Number.isInteger(fieldChecksum('hello')), 'checksum is an integer');
ok(fieldChecksum('hello') === fieldChecksum('hello'), 'checksum is deterministic');
ok(fieldChecksum('hello') !== fieldChecksum('hallo'), 'checksum distinguishes fields');
eq(fieldChecksum('<b>hi</b>'), fieldChecksum('hi'), 'checksum strips HTML before hashing');
ok(fieldChecksum('') >= 0, 'empty field still yields a checksum');
// Known-good vector: sha1("hello") = aaf4c61d..., first 8 hex = 0xaaf4c61d
eq(fieldChecksum('hello'), 0xaaf4c61d, 'checksum matches Anki\'s sha1-prefix definition');

// ---------------------------------------------------------------------------
// 3. Deck naming
// ---------------------------------------------------------------------------
eq(sanitizeDeckSegment('Physics'), 'Physics', 'plain title survives');
eq(sanitizeDeckSegment('A::B'), 'A - B', '`::` cannot be smuggled into a title');
eq(sanitizeDeckSegment('A\x1fB'), 'A B', 'the schema-18 separator is stripped too');
eq(sanitizeDeckSegment('  spaced   out  '), 'spaced out', 'whitespace is collapsed');
eq(sanitizeDeckSegment('line\nbreak'), 'line break', 'newlines cannot break a deck name');
eq(sanitizeDeckSegment('   '), '', 'whitespace-only sanitizes to nothing');
eq(deckPath(['Course', 'Stage 1']), `Course${DECK_SEP}Stage 1`, 'ancestry joins with ::');
eq(deckPath(['Course', '', 'Stage 1']), `Course${DECK_SEP}Stage 1`, 'empty segments are dropped');
eq(deckPath([]), 'Terramentor', 'a pathless card still lands in a named deck');
eq(deckPath(['A::B', 'C']), `A - B${DECK_SEP}C`, 'a sanitized segment does not fork the tree');
eq(deckPath(['Core 2k', 'Core 2k', 'Stage 1']), `Core 2k${DECK_SEP}Stage 1`,
    'a root node repeating the project name does not nest a deck inside a deck of the same name');
eq(deckPath(['Core 2k', 'core 2k ', 'Stage 1']), `Core 2k${DECK_SEP}Stage 1`,
    'the repeat is matched after sanitizing and case-insensitively');
eq(deckPath(['A', 'B', 'A']), `A${DECK_SEP}B${DECK_SEP}A`,
    'only an ADJACENT repeat collapses - a legitimately recurring name deeper down survives');

// ---------------------------------------------------------------------------
// 4. Media tags
// ---------------------------------------------------------------------------
eq(mediaTags([{ kind: 'image', name: 'cat.jpg' }]), '<img src="cat.jpg">', 'image tag');
eq(mediaTags([{ kind: 'audio', name: 'a.mp3' }]), '[sound:a.mp3]', 'sound tag');
eq(mediaTags([{ kind: 'image', name: 'c.jpg' }, { kind: 'audio', name: 'a.mp3' }]),
    '[sound:a.mp3]<img src="c.jpg">', 'audio is emitted before the picture, as on the card');
eq(mediaTags([]), '', 'no media, no tags');
eq(mediaTags(null), '', 'null media is safe');
eq(mediaTags([{ kind: 'image' }]), '', 'a nameless entry emits nothing');
ok(!mediaTags([{ kind: 'image', name: 'a".jpg' }]).includes('a".jpg'),
    'a quote in a filename cannot break out of the src attribute');

eq(parseCardMedia('{"front":[{"name":"a"}],"back":[]}').front.length, 1, 'media JSON parses');
eq(parseCardMedia('not json').front, [], 'malformed media JSON degrades to empty');
eq(parseCardMedia(null).back, [], 'null media degrades to empty');
eq(parseCardMedia('{"front":"oops"}').front, [], 'a non-array side degrades to empty');

// ---------------------------------------------------------------------------
// 5. Scheduling translation — the half that is silently wrong or silently right
// ---------------------------------------------------------------------------
const crtSec = collectionCreationSec(new Date('2026-09-01T12:00:00'));
const crtMs = crtSec * 1000;

{
    const s = schedulingForCard({ front: 'a', back: 'b' }, { crtSec, newPos: 7 });
    eq(s.type, CARD_NEW, 'never-reviewed card exports as new');
    eq(s.queue, CARD_NEW, 'new card sits in the new queue');
    eq(s.due, 7, 'a new card\'s due IS its queue position');
    eq(s.ivl, 0, 'a new card has no interval');
}
{
    // Reviewed, 21-day interval, next due 10 days after the collection epoch.
    const s = schedulingForCard({
        last_reviewed: iso(crtMs - 11 * DAY), next_review: iso(crtMs + 10 * DAY),
        last_interval: 21, ease_factor: 2.5, review_count: 6, lapses: 1,
    }, { crtSec });
    eq(s.type, CARD_REVIEW, 'a reviewed card exports as review');
    eq(s.due, 10, 'due is DAYS since collection creation, not a timestamp');
    eq(s.ivl, 21, 'the earned interval survives');
    eq(s.factor, 2500, 'ease is scaled to Anki per-mille');
    eq(s.reps, 6, 'review count survives');
    eq(s.lapses, 1, 'lapses survive');
}
{
    const s = schedulingForCard({
        last_reviewed: iso(crtMs - 40 * DAY), next_review: iso(crtMs - 30 * DAY),
        last_interval: 5, ease_factor: 2.5,
    }, { crtSec });
    eq(s.due, 0, 'an overdue card clamps to due-now, never a negative day');
}
{
    const s = schedulingForCard({
        last_reviewed: iso(crtMs), next_review: iso(crtMs + DAY),
        last_interval: 3, ease_factor: 1.1,
    }, { crtSec });
    eq(s.factor, MIN_EASE, 'ease below Anki\'s floor is clamped, not shipped');
}
{
    const s = schedulingForCard({
        last_reviewed: iso(crtMs), next_review: iso(crtMs + DAY),
        last_interval: 3, ease_factor: null,
    }, { crtSec });
    eq(s.factor, DEFAULT_EASE, 'a missing ease falls back to Anki\'s default');
}
{
    const s = schedulingForCard({
        last_reviewed: iso(crtMs), next_review: iso(crtMs + DAY),
        last_interval: 999999, ease_factor: 2.5,
    }, { crtSec });
    eq(s.ivl, MAX_INTERVAL_DAYS, 'an absurd interval is clamped to Anki\'s max');
}
{
    // The dangerous case: a row with review metadata but no interval. Sending
    // it as a review card with ivl 0 makes Anki treat it as due forever.
    const s = schedulingForCard({
        last_reviewed: iso(crtMs), next_review: iso(crtMs + DAY),
        last_interval: 0, ease_factor: 2.5,
    }, { crtSec });
    eq(s.type, CARD_NEW, 'a "reviewed" card with no interval exports as new, not as ivl-0 review');
}

// ---------------------------------------------------------------------------
// 6. Note fields
// ---------------------------------------------------------------------------
{
    const f = noteFieldsForCard({ front: '早い', back: 'early', extra: 'はやい' });
    eq(f.Front, '早い', 'front maps to Front');
    eq(f.Back, 'early', 'back maps to Back');
    eq(f.Notes, 'はやい', 'the supporting lines get their OWN field, not glued to the answer');
}
{
    const f = noteFieldsForCard({
        front: 'w', back: 'x',
        media: JSON.stringify({ front: [{ kind: 'image', name: 'p.jpg' }], back: [{ kind: 'audio', name: 's.mp3' }] }),
    });
    ok(f.Front.includes('<img src="p.jpg">'), 'front media lands on the front');
    ok(f.Back.includes('[sound:s.mp3]'), 'back media lands on the back');
    ok(!f.Front.includes('s.mp3'), 'back media does not leak onto the question side');
}

// ---------------------------------------------------------------------------
// 7. Collection blobs
// ---------------------------------------------------------------------------
{
    const m = buildModel(1600000000000);
    eq(m.flds.map((f) => f.name), ['Front', 'Back', 'Notes'],
        'three fields, in order — the third named for its ROLE so an importer can read it');
    eq(m.flds.map((f) => f.ord), [0, 1, 2], 'field ordinals are 0-based and dense');
    eq(m.tmpls.length, 1, 'one card template');
    eq(m.req, [[0, 'any', [0]]], '`req` generates card 1 from a non-empty Front');
    ok(m.tmpls[0].qfmt.includes('{{Front}}'), 'question side renders Front');
    ok(m.tmpls[0].afmt.includes('{{Back}}'), 'answer side renders Back');
    ok(m.tmpls[0].afmt.includes('{{FrontSide}}'),
        'the question stays on the answer — the same rule CardFace follows');
    ok(m.tmpls[0].afmt.includes('{{#Notes}}'), 'the third field is conditional, so a card without it has no empty block');
    eq(m.sortf, 0, 'the sort field is Front');
    eq(m.type, 0, 'standard note type, not cloze');
}
{
    const d = buildDeck(5, 'A::B');
    eq(d.dyn, 0, 'a normal deck, not a filtered one');
    eq(d.conf, 1, 'deck points at the default config');
    const c = buildColConf(42);
    eq(c.curModel, '42', 'curModel is the model id as a STRING, as Anki writes it');
    eq(c.schedVer, 2, 'scheduler v2');
    ok(buildDeckConfig()[1].rev.maxIvl === MAX_INTERVAL_DAYS, 'deck config carries a sane max interval');
}

// ---------------------------------------------------------------------------
// 8. Deck paths from a node tree
// ---------------------------------------------------------------------------
{
    const nodes = [
        { id: 1, parent_id: null, title: 'Part One', is_note: 0 },
        { id: 2, parent_id: 1, title: 'Chapter A', is_note: 0 },
        { id: 3, parent_id: 2, title: 'Reading', is_note: 1 },
        { id: 4, parent_id: null, title: 'Loose', is_note: 0 },
    ];
    const paths = buildDeckPaths(nodes, 'My Course');
    eq(paths.get(1), 'My Course::Part One', 'a top-level topic nests under the project');
    eq(paths.get(2), 'My Course::Part One::Chapter A', 'ancestry becomes the deck path');
    eq(paths.get(3), 'My Course::Part One::Chapter A',
        'a NOTE adds no level — it is material on a topic, not a level of it');
    eq(paths.get(4), 'My Course::Loose', 'siblings do not inherit each other');
}

// ---------------------------------------------------------------------------
// 9. Note rows
// ---------------------------------------------------------------------------
{
    const rows = buildNoteRows(
        [{ front: 'a', back: 'b', node_id: 1 }, { front: '', back: 'x', node_id: 1 }, { front: 'c', back: 'd', node_id: 1 }],
        { crtSec, deckIdFor: () => 9, baseId: 1000 },
    );
    eq(rows.length, 2, 'a card with an empty front is dropped — `req` would generate nothing anyway');
    const ids = new Set(rows.flatMap((r) => [r.id, r.cardId]));
    eq(ids.size, 4, 'every note id and card id is unique');
    ok(rows[0].guid !== rows[1].guid, 'each note gets its own guid');
    eq(rows.map((r) => r.sched.due), [1, 2], 'new-card positions are sequential, preserving order');
    eq(rows[0].did, 9, 'the deck id comes from the caller');
}

// ---------------------------------------------------------------------------
// 10. THE ROUND TRIP — export, then read it back with the real importer
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'mnem-export-gate-'));
try {
    const dbFile = join(work, 'scratch.db');
    const scratch = new Database(dbFile);
    scratch.exec(`
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE nodes (id INTEGER PRIMARY KEY, project_id INTEGER, parent_id INTEGER, title TEXT, is_note INTEGER DEFAULT 0);
        CREATE TABLE flashcards (
            id INTEGER PRIMARY KEY, node_id INTEGER, front TEXT, back TEXT, extra TEXT,
            media TEXT, ease_factor REAL, last_interval INTEGER, last_reviewed TEXT,
            next_review TEXT, review_count INTEGER, lapses INTEGER
        );
        INSERT INTO projects (id, name) VALUES (1, 'Round Trip');
        INSERT INTO nodes (id, project_id, parent_id, title, is_note) VALUES
            (10, 1, NULL, 'Stage 1', 0),
            (11, 1, 10,   'Notes',   1);
    `);
    const now = Date.now();
    scratch.prepare(`INSERT INTO flashcards
        (id, node_id, front, back, extra, media, ease_factor, last_interval, last_reviewed, next_review, review_count, lapses)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        1, 10, '早い', 'early, fast', 'はやい', null, 2.5, 21,
        iso(now - 11 * DAY), iso(now + 10 * DAY), 6, 1);
    scratch.prepare(`INSERT INTO flashcards
        (id, node_id, front, back, extra, media, ease_factor, last_interval, last_reviewed, next_review, review_count, lapses)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        2, 10, 'brand new', 'never studied', '', null, 2.5, 0, null, null, 0, 0);
    scratch.prepare(`INSERT INTO flashcards
        (id, node_id, front, back, extra, media, ease_factor, last_interval, last_reviewed, next_review, review_count, lapses)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        3, 10, 'a < b & "c"', 'スポーツは**あまり**好き', '', null, 2.5, 0, null, null, 0, 0);

    const fakeStorage = { pathFor: () => { throw new Error('no media in this fixture'); } };
    const { buffer, stats } = await exportProjectApkg({ db: scratch, mediaStorage: fakeStorage }, 1);

    eq(stats.notes, 3, 'all three cards exported');
    eq(stats.skipped, 0, 'nothing was silently dropped');
    ok(stats.decks >= 1, 'at least one deck was written');
    ok(Buffer.isBuffer(buffer) && buffer.length > 0, 'the export produced bytes');

    // The archive itself
    const zip = await JSZip.loadAsync(buffer);
    ok(!!zip.file('collection.anki2'), 'the archive holds collection.anki2');
    ok(!!zip.file('media'), 'the archive holds a media index (even when empty)');
    eq(JSON.parse(await zip.file('media').async('string')), {}, 'an empty media index is {}, not absent');

    // The endpoint does NOT use the buffered path above — it streams the zip
    // out, because materialising a real deck's archive in memory took the
    // server from 120 MB to 687 MB and killed it. So the streamed archive has
    // to be asserted too: a gate that only covers the path production never
    // takes is a gate over nothing.
    const streamed = await new Promise((resolve, reject) => {
        const chunks = [];
        buildProjectApkg({ db: scratch, mediaStorage: fakeStorage }, 1)
            .then(({ zip: z }) => z.generateNodeStream({ type: 'nodebuffer', compression: 'DEFLATE' })
                .on('data', (c) => chunks.push(c))
                .on('error', reject)
                .on('end', () => resolve(Buffer.concat(chunks))))
            .catch(reject);
    });
    ok(streamed.length > 0, 'the streamed export produced bytes');
    const streamedZip = await JSZip.loadAsync(streamed);
    ok(!!streamedZip.file('collection.anki2'), 'the streamed archive holds collection.anki2');
    const streamedParsed = await parseApkg(streamed, { importMedia: false });
    eq(streamedParsed.cards.length, 3, 'the streamed archive re-imports every card');

    // Read it back with the REAL importer.
    const parsed = await parseApkg(buffer, { importMedia: false });
    eq(parsed.cards.length, 3, 'the importer reads back exactly what was written');

    const byFront = new Map(parsed.cards.map((c) => [c.front, c]));
    ok(byFront.has('早い'), 'the Japanese card survives the round trip');
    const jp = byFront.get('早い');
    eq(jp.back, 'early, fast', 'the answer survives');
    ok(String(jp.extra || '').includes('はやい'), 'the supporting line survives as extra');
    eq(jp.sched?.interval, 21, 'the earned interval survives the round trip');
    ok(Math.abs((jp.sched?.ease ?? 0) - 2.5) < 0.01, 'ease survives the round trip');
    eq(jp.sched?.reps, 6, 'the review count survives the round trip');
    eq(jp.sched?.lapses, 1, 'lapses survive the round trip');

    const fresh = byFront.get('brand new');
    ok(fresh, 'the never-studied card survives');
    ok(!fresh.sched?.interval, 'a new card comes back with no interval, not a fabricated one');
    ok(!fresh.sched?.ease, 'and with no ease - Anki 0 means never reviewed');

    // The escaping card: `stripAnkiHtml` is lossy about emphasis by design, so
    // assert the characters that MUST survive rather than byte equality.
    const esc = [...byFront.keys()].find((k) => k.includes('<'));
    ok(esc === 'a < b & "c"', 'escaped markup characters come back as themselves, not as entities');

    // Deck structure
    ok(parsed.cards.some((c) => String(c.deck || '').includes('Stage 1')),
        'the node tree came through as a deck path');
    ok(parsed.cards.every((c) => String(c.deck || '').startsWith('Round Trip')),
        'every card sits under the project name, so an import lands as one tree');

    scratch.close();

    // 11. Empty project — an export with nothing in it must still be a valid archive
    const empty = new Database(join(work, 'empty.db'));
    empty.exec(`
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE nodes (id INTEGER PRIMARY KEY, project_id INTEGER, parent_id INTEGER, title TEXT, is_note INTEGER DEFAULT 0);
        CREATE TABLE flashcards (id INTEGER PRIMARY KEY, node_id INTEGER, front TEXT, back TEXT, extra TEXT, media TEXT, ease_factor REAL, last_interval INTEGER, last_reviewed TEXT, next_review TEXT, review_count INTEGER, lapses INTEGER);
        INSERT INTO projects (id, name) VALUES (2, 'Nothing Here');
    `);
    const emptyOut = await exportProjectApkg({ db: empty, mediaStorage: fakeStorage }, 2);
    eq(emptyOut.stats.notes, 0, 'an empty project exports zero notes');
    const emptyZip = await JSZip.loadAsync(emptyOut.buffer);
    ok(!!emptyZip.file('collection.anki2'), 'an empty export is still a valid archive');
    const emptyParsed = await parseApkg(emptyOut.buffer, { importMedia: false });
    eq(emptyParsed.cards.length, 0, 'and the importer reads it as zero cards rather than failing');

    // 12. A missing project is an error, not an empty file
    let threw = false;
    try { await exportProjectApkg({ db: empty, mediaStorage: fakeStorage }, 9999); } catch { threw = true; }
    ok(threw, 'exporting a project that does not exist throws rather than shipping an empty deck');
    empty.close();
} finally {
    // Windows holds a lock until every handle is closed; a failed cleanup must
    // not mask a real result, so it is best-effort.
    try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp dir */ }
    try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp dir */ }
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log('');
    for (const f of failures) console.log('  FAIL  ' + f);
    process.exit(1);
}
