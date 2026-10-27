// server/ankiImport.js — bring an Anki deck in, honestly.
//
// Contract: never silently lose a card. Every note that does not become a
// flashcard is counted with a REASON, and the reasons are surfaced.
//
// An .apkg is a zip holding a SQLite collection plus media. The collection is
// SQLite somebody else wrote, so it is read, and its notes turned into cards
// (`ankiNotes.js`), in a process of its own with nothing in its schema trusted
// (`ankiCollection.js`). This module gets the cards. Five traps:
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
import db from './database.js';
import { readCollectionIsolated } from './ankiCollection.js';
import { extractMedia, MAX_MEDIA_TOTAL_BYTES } from './ankiMedia.js';
import { assertZipSafe, readZipEntry } from './extract.js';
import {
    SKIP_REASONS, linksOfCard, linkResourceType, MAX_LINKS_PER_NODE, MAX_LINKS_TOTAL,
} from './ankiNotes.js';
import { planStages } from './deckStructure.js';
import { roleForStage, ROLE_TOPIC } from './nodeRole.js';
import { mediaStorage } from './vaultStorage.js';

// The text helpers moved to ankiNotes.js with the mapping; their callers import
// them from here.
export {
    SKIP_REASONS, cardLinks, templateLinkLines, linksOfCard, stripAnkiHtml, clozeOrdinals, expandCloze,
} from './ankiNotes.js';

// Collection candidates, newest first. Order is load-bearing — see trap 2.
const COLLECTION_CANDIDATES = [
    { name: 'collection.anki21b', zstd: true },
    { name: 'collection.anki21', zstd: false },
    { name: 'collection.anki2', zstd: false },
];

/**
 * What one .apkg may DECLARE, before a byte is read (see `assertZipSafe`). The
 * entry ceiling clears a very large listening deck (a clip per card, thousands of
 * entries) and refuses a million-entry archive. The byte total is
 * the import's media budget, `MAX_MEDIA_TOTAL_BYTES`.
 */
const APKG_ZIP_LIMITS = { maxEntries: 200_000, maxTotalBytes: MAX_MEDIA_TOTAL_BYTES };

/**
 * The ceiling the collection database is read under, as a zip entry and as its
 * zstd frame: the same 512 MB the upload door accepts (`rejectOversizedBody` on
 * `/api/import/anki/inspect`), so it cannot expand past what the archive could be.
 */
export const MAX_COLLECTION_BYTES = 512 * 1024 * 1024;

import { importAnkiRevlog } from './reviewLog.js';

// ---- reading the collection -------------------------------------------------

async function loadCollectionDb(zip, workDir, limits) {
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
        bytes = null;
        let collection;
        try {
            // Read in a process of its own, never on this thread: the file is
            // SQLite somebody else wrote (`server/ankiCollection.js`).
            collection = await readCollectionIsolated(path, limits);
        } catch (err) {
            const refusal = new Error(`This file's collection could not be opened (${err.message}).`);
            if (err?.tooLarge) refusal.tooLarge = true;
            throw refusal;
        }
        // Trap 2: an empty collection is accepted only after every candidate.
        if (collection.noteCount === 0) { lastEmpty = { collection, cand }; continue; }
        return { collection, schemaFile: cand.name };
    }
    if (lastEmpty) return { collection: lastEmpty.collection, schemaFile: lastEmpty.cand.name, empty: true };
    throw new Error('No Anki collection was found inside this file. Is it an .apkg exported from Anki?');
}


/**
 * Parse an .apkg buffer into everything the import screen needs to show BEFORE
 * the learner commits to anything. The collection's rows are read in a child
 * process (`readCollectionIsolated`); `limits` ({ heapMb, timeoutMs }) narrows
 * its ceilings and is for gates only.
 */
export async function parseApkg(buffer, { importMedia = true, onProgress, limits } = {}) {
    const workDir = mkdtempSync(join(tmpdir(), 'anki-import-'));
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

        const loaded = await loadCollectionDb(zip, workDir, limits);
        // The notes arrive already turned into cards, in the reader's process
        // (`notesToCards`, ankiNotes.js): nothing of the deck's text is parsed on
        // this thread.
        const {
            cards: out, skipped, withImages, withSounds, deckCounts, typeCounts, wantedMedia, noteCount, revlog,
        } = loaded.collection;

        // ---- media ----------------------------------------------------------
        //
        // Extracted HERE, at inspect, straight into the content-addressed store,
        // so a large deck is previewed without being held in memory; only hashes
        // are staged. A cancelled import leaves unreferenced blobs for
        // `sweepOrphanMedia` (safe: a re-import resolves to the same hash).
        let mediaFiles = new Map(), mediaSkipped = [], mediaFormat = 'none', mediaBytes = 0;
        if (importMedia && wantedMedia.length) {
            ({ files: mediaFiles, skipped: mediaSkipped, format: mediaFormat, bytes: mediaBytes } =
                await extractMedia(zip, wantedMedia, { onProgress }));
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
            if (c.links.length) cardsWithLinks++;
            for (const l of c.links) allLinks.add(l.url);
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

        // The deck's review HISTORY (`revlog`), read with the rest of the
        // collection, for server/reviewLog.js and the optimiser.
        const cardsWithHistory = new Set(revlog.map(r => r.cid)).size;

        return {
            cards: out,
            revlog,
            skipped,
            schemaFile: loaded.schemaFile,
            media: [...seenHashes.values()],
            stats: {
                notes: noteCount,
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
            // Found at inspect, in the reader's process; only cards a caller
            // built by hand, without `links`, are parsed here.
            for (const link of card.links ?? linksOfCard(card)) {
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
