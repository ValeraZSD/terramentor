// server/nodeEmbeddings.js — semantic identity for TOPICS.
//
// server/embeddings.js embeds document chunks so the tutor can retrieve
// *material* by meaning. This module embeds the curriculum itself: one vector
// per topic node, so the engine can ask a question it has never been able to
// ask before — "which other topics, in any project, mean roughly the same
// thing as this one?"
//
// That single question is what the next two layers are built on: mastery
// transfer (proving a topic should inform its twin in another project, instead
// of the learner re-proving the same thing under a different curriculum's
// name) and the atlas view (the whole library drawn as one space rather than N
// unrelated trees). Both are consumers; this module only supplies neighbours
// and stays useful on its own via semantic topic search.
//
// Three decisions worth knowing before changing anything here:
//
//  1. **What gets embedded is title + immediate parent + Overview, with the
//     curriculum numbering stripped off, and deliberately NOT the project
//     name.** A bare "Introduction" or "Part 2" carries no meaning, so the
//     parent title is prepended to disambiguate it; "Module 9.5:" carries
//     course-specific meaning, which is worse than none, so it comes off.
//     The project name is left out on purpose: it is the one string guaranteed
//     to differ between two curricula that teach the same thing, and including
//     it would push exactly the pairs this exists to find apart. Notes are
//     excluded — they are material attached to a topic, not topics (see the
//     leaf/notes convention in docs/ARCHITECTURE.md).
//
//  2. **Vectors are unit-normalised on write and on query.** vec0's default
//     metric is L2, and for unit vectors L2 distance converts to cosine
//     similarity exactly (cos = 1 - d²/2). Normalising rather than declaring
//     `distance_metric=cosine` keeps this independent of the sqlite-vec build,
//     and gives callers a bounded 0..1 number they can threshold instead of a
//     raw distance whose scale depends on the embedding model.
//
//  3. **Freshness is reconciled, not hooked.** Nodes are written from a dozen
//     places (AI creation, import, capture, manual edit, bundle import), and a
//     per-call-site hook would be wrong within a week. Instead `node_embeddings`
//     stores a hash of the exact text that was embedded and the model that
//     embedded it, and `syncNodeEmbeddings` re-embeds only the drift. It costs
//     one cheap query when nothing changed, so callers can fire it liberally.
//
// Like every vector feature in this app it degrades to nothing rather than
// failing: no sqlite-vec, no embedding model, or the feature switched off, and
// `similarNodes` returns [] — consumers must treat neighbours as an
// enhancement, never a dependency.

import { createHash } from 'node:crypto';
import db, { vecAvailable } from './database.js';
import {
    embedBatch,
    toBlob,
    ensureVecTable,
    vecTableExists,
    isUnavailable,
    embeddingReady,
    enqueueVectorJob,
    getEmbeddingConfig,
} from './embeddings.js';
import * as tasks from './tasks.js';
import { cleanRegionLabel } from './curriculumLabel.js';
import { TOPIC_NODE } from './nodeRole.js';

const NODE_BATCH = 32;      // topics per embedding request
const OVERVIEW_CHARS = 1200; // an Overview is a blurb; more is noise in one vector
const DEFAULT_TOPK = 8;
// Below this cosine similarity two topics are not "the same thing" by any
// reading — consumers may raise the bar, none should lower it.
export const MIN_SIMILARITY = 0.5;

// ---- the anisotropy baseline -----------------------------------------------
//
// Every pair of topic vectors sits near the same floor (measured on the real
// library: cross-project mean cosine 0.452, within-project 0.478 — a
// separation of d' 0.35), because the embedding model puts all its outputs
// in one narrow cone. Subtracting the library's MEAN vector before comparing
// removes the shared direction: on the same library the separation becomes
// d' 0.88, and at an equal number of candidate pairs the pairs it drops are
// coarse section titles ("Mathematics Fundamentals" ~ "Logic, Proofs, …")
// while the pairs it adds are the specific twins transfer exists for
// ("u-Substitution" ~ "Substitution Method (u-Substitution)"). Only applied
// once the library holds enough topics for a mean to BE a baseline; below
// that a "mean" of a handful of vectors is just those vectors.
export const MIN_CENTRE_TOPICS = 200;
// Raw-cosine floor for the candidate fetch when re-scoring centred: wide
// enough that a twin the raw score ranks at 0.7 is still in the pool.
const CENTRE_RAW_FLOOR = 0.6;
const MEAN_TTL_MS = 10 * 60 * 1000;
let meanCache = null; // { vec: Float64Array, count, at }

/** A vec0 blob copied into an aligned Float32Array (see atlas.js on alignment). */
function blobToArray(blob) {
    if (!blob) return null;
    if (Array.isArray(blob)) return Float32Array.from(blob);
    const copy = new Uint8Array(blob.length);
    copy.set(blob);
    return new Float32Array(copy.buffer);
}

/** The library mean over every stored topic vector (cached; dropped on every sync). */
export function topicMean() {
    if (meanCache && Date.now() - meanCache.at < MEAN_TTL_MS) return meanCache;
    let count = 0, vec = null;
    try {
        if (vecTableExists('vec_nodes')) {
            for (const row of db.prepare('SELECT embedding FROM vec_nodes').iterate()) {
                const v = blobToArray(row.embedding);
                if (!v) continue;
                if (!vec) vec = new Float64Array(v.length);
                if (v.length !== vec.length) continue;
                for (let j = 0; j < v.length; j++) vec[j] += v[j];
                count++;
            }
        }
    } catch (_) { vec = null; count = 0; }
    if (vec && count) for (let j = 0; j < vec.length; j++) vec[j] /= count;
    meanCache = { vec, count, at: Date.now() };
    return meanCache;
}

/** Cosine of (a − mean) and (b − mean). Pure; exported for the gate suite. */
export function centredCosine(a, b, mean) {
    let dot = 0, na = 0, nb = 0;
    for (let j = 0; j < mean.length; j++) {
        const x = a[j] - mean[j], y = b[j] - mean[j];
        dot += x * y; na += x * x; nb += y * y;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom > 0 ? Math.max(-1, Math.min(1, dot / denom)) : 0;
}

// ---- the embedded text ------------------------------------------------------

/**
 * The text that BECOMES a topic's position in the space: everything the atlas
 * draws and every twin mastery transfer finds is downstream of this string.
 *
 * Title + immediate parent + Overview, with the curriculum numbering stripped
 * off both titles, and still no project name.
 *
 * The numbering is the change worth explaining. "Module 9.5:", "3.3.3:", "7.2 —"
 * are boilerplate shared by every topic in one course and by nothing outside it,
 * so they are not neutral filler in a vector — they are a signal pointing the
 * wrong way, pulling same-course topics together and pushing apart the
 * cross-course twins this layer exists to find. Measured on a real 1885-topic
 * library, against the map that comes out the other end: with the rest of the
 * text held constant, stripping it moved cross-project regions 47 → 49 and left
 * cohesion unchanged (0.857 → 0.852). Small, in the right direction, and free.
 *
 * Two things that were tried here and REMOVED, because measuring them is what
 * this project does instead of guessing:
 *
 *  • **A deeper ancestor chain** (grandparent › parent › title) is *worse*, and
 *    clearly so: cross-project regions fell 47 → 39 and the share of topics
 *    living in one fell 0.565 → 0.476. The reasoning was that more context
 *    places a topic better; what it actually adds is one more layer of the
 *    course's own scaffolding, which is the thing this text is trying not to
 *    encode. One level is the useful depth.
 *  • **Falling back to a topic's Material or its children's titles** when the
 *    Overview is missing. It sounded obviously right — 919 topics here (22%)
 *    have no Overview at all — and it is inapplicable: **every one of those 919
 *    has neither Material nor children.** A stub Overview and an empty topic are
 *    the same topic. It measured as noise (crossTopicShare 0.565 → 0.573,
 *    cross-project regions 47 → 43) for the cost of a whole-library re-embed and
 *    two correlated subqueries on every node write, so it went.
 */
export function nodeEmbedText({ title, description, parent_title }) {
    const clean = (t) => cleanRegionLabel(String(t || '').trim());
    const parent = clean(parent_title);
    const head = parent ? `${parent} › ${clean(title)}` : clean(title);
    const overview = String(description || '').trim().slice(0, OVERVIEW_CHARS);
    return overview ? `${head}
${overview}` : head;
}

// The model is part of the identity of a vector: two models can share a
// dimension (so the vec table survives the swap) while their spaces have
// nothing to do with each other.
function hashOf(text, model) {
    return createHash('sha256').update(`${model}\0${text}`).digest('hex');
}

// ---- vector maths -----------------------------------------------------------

function normalize(vec) {
    let sum = 0;
    for (const v of vec) sum += v * v;
    const norm = Math.sqrt(sum);
    if (!norm || !Number.isFinite(norm)) return null;
    return vec.map(v => v / norm);
}

// vec0 stores L2; both sides are unit vectors, so this is exact, not an
// approximation. Clamped because float32 round-tripping can put an identical
// pair a hair outside [0, 1].
function distanceToSimilarity(distance) {
    const sim = 1 - (distance * distance) / 2;
    return Math.max(0, Math.min(1, sim));
}

// ---- reconcile --------------------------------------------------------------

// Notes are content, not topics — and neither is a slice the Anki importer cut
// out of a deck's card order. "Stage 7" embeds to a vector that means nothing
// and sits next to "Stage 8"; the atlas draws no note, so each one is a model
// call paid for a vector thrown away at paint time — 91 of them on the real
// library (2026-09-09). The WHERE clause below keeps them out.
const CANDIDATES_SQL = `
    SELECT n.id, n.title, n.description, n.project_id,
           p.title AS parent_title,
           ne.text_hash AS stored_hash
    FROM nodes n
    LEFT JOIN nodes p ON p.id = n.parent_id
    LEFT JOIN node_embeddings ne ON ne.node_id = n.id
    WHERE n.is_note = 0 AND ${TOPIC_NODE}
`;

/** The rows a vector may belong to, as a subquery for the stale sweep. */
const EMBEDDABLE_IDS = `SELECT n.id FROM nodes n WHERE n.is_note = 0 AND ${TOPIC_NODE}`;

// Topics whose stored vector is missing or stale. No model calls — this is the
// query that makes "sync often" cheap.
export function pendingNodes({ force = false } = {}) {
    const model = getEmbeddingConfig().model;
    return db.prepare(CANDIDATES_SQL).all()
        .map(row => ({ ...row, hash: hashOf(nodeEmbedText(row), model) }))
        .filter(row => force || row.stored_hash !== row.hash);
}

// Vectors for things that are no longer topics: a deleted node, or a topic
// *converted into a note*.
//
// The two have to be swept independently, and that is the whole subtlety here.
// `node_embeddings` has a real FK, so deleting a node takes its bookkeeping row
// with it — which means a sweep driven by the sidecar is structurally blind to
// exactly the case it most needs to catch: the row that would have told us to
// drop the vector is the row the cascade just deleted. So `vec_nodes` (no FK,
// nothing cascades to it) is swept against `nodes` directly.
function dropStaleRows() {
    let removed = 0;
    if (vecTableExists('vec_nodes')) {
        try {
            removed += db.prepare(
                `DELETE FROM vec_nodes WHERE rowid NOT IN (${EMBEDDABLE_IDS})`
            ).run().changes;
        } catch (_) { /* vec unavailable */ }
    }
    // Note-conversion leaves the bookkeeping row behind (the node still exists),
    // and it would otherwise claim a vector that is no longer there.
    db.prepare(
        `DELETE FROM node_embeddings WHERE node_id NOT IN (${EMBEDDABLE_IDS})`
    ).run();
    return removed;
}

const upsertRow = () => db.prepare(`
    INSERT INTO node_embeddings (node_id, text_hash, model, status, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(node_id) DO UPDATE SET
        text_hash = excluded.text_hash,
        model = excluded.model,
        status = excluded.status,
        updated_at = CURRENT_TIMESTAMP
`);

// A failed batch still records a row so the Settings panel can report the
// state — but with an EMPTY hash, which no real text can produce, so the topic
// is picked up again by the next reconcile rather than being treated as done.
function markFailed(nodes, status, model) {
    const stmt = upsertRow();
    db.transaction(() => { for (const n of nodes) stmt.run(n.id, '', model, status); })();
}

async function runSync({ force = false } = {}) {
    if (!vecAvailable || !embeddingReady()) return { skipped: 'unavailable', embedded: 0, removed: 0 };

    const removed = dropStaleRows();
    const pending = pendingNodes({ force });
    if (pending.length === 0) return { embedded: 0, removed, pending: 0 };

    const model = getEmbeddingConfig().model;
    const handle = tasks.registerExternal({
        kind: 'embed',
        label: `Mapping ${pending.length} topic${pending.length === 1 ? '' : 's'}`,
        cancel: () => { },
    });

    let embedded = 0;
    try {
        for (let i = 0; i < pending.length; i += NODE_BATCH) {
            const batch = pending.slice(i, i + NODE_BATCH);
            const vectors = await embedBatch(batch.map(n => nodeEmbedText(n)));
            const dim = vectors[0]?.length;
            if (!dim) throw new Error('embedding model returned empty vectors');
            if (!ensureVecTable(dim, 'vec_nodes')) throw new Error('vector storage unavailable');

            const del = db.prepare('DELETE FROM vec_nodes WHERE rowid = ?');
            const ins = db.prepare('INSERT INTO vec_nodes (rowid, embedding) VALUES (?, ?)');
            const row = upsertRow();
            db.transaction(() => {
                batch.forEach((n, j) => {
                    const unit = normalize(vectors[j]);
                    if (!unit) { row.run(n.id, '', model, 'error'); return; }
                    del.run(n.id);              // idempotent re-index
                    // vec0 rejects a plain JS number as a rowid PK — BigInt only.
                    ins.run(BigInt(n.id), toBlob(unit));
                    row.run(n.id, n.hash, model, 'indexed');
                });
            })();
            embedded += batch.length;
            const percent = Math.round((embedded / pending.length) * 100);
            handle.update({ progress: percent, percent });
        }
        handle.finish();
        return { embedded, removed, pending: pending.length };
    } catch (err) {
        const status = isUnavailable(err) ? 'unavailable' : 'error';
        markFailed(pending.slice(embedded), status, model);
        if (status === 'unavailable') {
            console.warn(`[VEC] topic mapping paused — no embedding model: ${err.message}`);
            handle.finish();
        } else {
            console.error(`[VEC] topic mapping failed: ${err.message}`);
            handle.fail(err.message);
        }
        return { embedded, removed, error: err.message, status };
    }
}

// ---- scheduling -------------------------------------------------------------

// Debounced so a burst of writes — AI creation inserting a whole curriculum,
// an import, a drag-reorder — collapses into one sweep once the burst settles.
const SYNC_DEBOUNCE_MS = 5000;
// A pure debounce starves under a steady write stream — an editing session that
// saves every few seconds would push the sweep back forever and the map would
// never catch up. Once something has been waiting this long, it goes.
const SYNC_MAX_WAIT_MS = 60_000;
let syncTimer = null;
let syncRequestedAt = 0;

export function scheduleNodeSync({ delay = SYNC_DEBOUNCE_MS, force = false } = {}) {
    meanCache = null;   // the baseline moves with the library
    if (!vecAvailable) return;
    const now = Date.now();
    if (!syncTimer) syncRequestedAt = now;
    else if (now - syncRequestedAt >= SYNC_MAX_WAIT_MS) return;  // already overdue; let it fire
    else clearTimeout(syncTimer);

    const wait = Math.min(delay, Math.max(0, syncRequestedAt + SYNC_MAX_WAIT_MS - now));
    syncTimer = setTimeout(() => {
        syncTimer = null;
        enqueueVectorJob(() => runSync({ force }));
    }, wait);
    syncTimer.unref?.();   // never hold the process open for a background sweep
}

// Force a full re-embed (Settings → re-index, or after switching model).
export function reindexAllNodes() {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM (${EMBEDDABLE_IDS})`).get()?.c || 0;
    db.prepare('DELETE FROM node_embeddings').run();
    enqueueVectorJob(() => runSync({ force: true }));
    return { queued: total };
}

// Awaitable variant — used by tools and tests that need the sweep to finish.
export function syncNodeEmbeddings(opts = {}) {
    return enqueueVectorJob(() => runSync(opts));
}

// ---- neighbours -------------------------------------------------------------

/** Is the topic space usable at all right now? */
export function topicSpaceReady() {
    return embeddingReady() && vecTableExists('vec_nodes');
}

/**
 * Is this specific topic mapped? The distinction matters to any caller that
 * would otherwise read an empty neighbour list as "nothing similar exists"
 * when it actually means "I cannot see". A node WITH a vector gives a local,
 * reliable KNN — an empty result there is a real answer.
 */
export function hasNodeVector(nodeId) {
    if (!vecTableExists('vec_nodes')) return false;
    try { return !!db.prepare('SELECT 1 FROM vec_nodes WHERE rowid = ?').get(nodeId); } catch (_) { return false; }
}

function readVector(nodeId) {
    if (!vecTableExists('vec_nodes')) return null;
    let raw;
    try {
        raw = db.prepare('SELECT embedding FROM vec_nodes WHERE rowid = ?').get(nodeId)?.embedding;
    } catch (_) { return null; }
    if (!raw) return null;
    // sqlite-vec returns the raw float32 blob; tolerate a JSON-text build too.
    if (Buffer.isBuffer(raw)) return raw;
    if (typeof raw === 'string') {
        try { const arr = JSON.parse(raw); return Array.isArray(arr) ? toBlob(arr) : null; } catch (_) { return null; }
    }
    return null;
}

// Shared tail of both lookups: KNN, then hydrate with everything a consumer
// (transfer, atlas, the assistant) needs to decide what to do about a hit.
function knn(queryBlob, { limit, minSimilarity, excludeNodeId, projectId, excludeProjectId, masteredOnly, threshold }) {
    // vec0 has no metadata filtering here (kept portable, same as vec_chunks),
    // so over-fetch and filter in SQL. Curricula are thousands of rows, not
    // millions — this is cheap.
    const overfetch = Math.min(Math.max(limit * 8, 40), 400);
    let hits;
    try {
        hits = db.prepare(
            `SELECT rowid AS node_id, distance FROM vec_nodes
             WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
        ).all(queryBlob, overfetch);
    } catch (err) {
        console.error('[VEC] topic KNN failed:', err.message);
        return [];
    }
    if (hits.length === 0) return [];

    const distById = new Map(hits.map(h => [h.node_id, h.distance]));
    const ids = hits.map(h => h.node_id).filter(id => id !== excludeNodeId);
    if (ids.length === 0) return [];

    const filters = [];
    const params = [];
    if (projectId) { filters.push('n.project_id = ?'); params.push(projectId); }
    if (excludeProjectId) { filters.push('n.project_id != ?'); params.push(excludeProjectId); }
    if (masteredOnly) { filters.push('nm.mastery_score >= ?'); params.push(threshold); }

    const rows = db.prepare(`
        SELECT n.id, n.title, n.description, n.status, n.project_id, n.is_note,
               p.name AS project_name, p.color AS project_color, p.status AS project_status,
               nm.mastery_score, nm.last_updated AS mastery_updated
        FROM nodes n
        JOIN projects p ON p.id = n.project_id
        LEFT JOIN node_mastery nm ON nm.node_id = n.id
        WHERE n.id IN (${ids.map(() => '?').join(',')})
          AND n.is_note = 0
          ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
    `).all(...ids, ...params);

    return rows
        .map(r => ({ ...r, similarity: distanceToSimilarity(distById.get(r.id) ?? Infinity) }))
        .filter(r => r.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

/**
 * Topics that mean roughly the same thing as `nodeId`.
 *
 * @param {number} nodeId
 * @param {object} [opts]
 * @param {number} [opts.limit]            max neighbours (default 8)
 * @param {number} [opts.minSimilarity]    cosine floor (default MIN_SIMILARITY)
 * @param {boolean} [opts.crossProjectOnly] drop neighbours in the node's own project
 * @param {boolean} [opts.masteredOnly]    keep only neighbours already proven
 * @param {number} [opts.threshold]        mastery bar for `masteredOnly`
 * @param {boolean} [opts.allowEmbed]      may embed the node live if unindexed
 * @returns {Promise<Array>} neighbours, most similar first; [] when unavailable
 */
export async function similarNodes(nodeId, {
    limit = DEFAULT_TOPK,
    minSimilarity = MIN_SIMILARITY,
    crossProjectOnly = false,
    masteredOnly = false,
    threshold = 0.85,
    allowEmbed = true,
    // Re-score the raw KNN candidates against the library mean (see
    // MIN_CENTRE_TOPICS) and gate on `minCentred`; `similarity` then IS the
    // centred value and the raw one rides along as `similarity_raw`. Ignored,
    // with the raw `minSimilarity` gate, while the library is too small.
    centred = false,
    minCentred = 0,
} = {}) {
    if (!embeddingReady() || !vecTableExists('vec_nodes')) return [];

    let queryBlob = readVector(nodeId);
    // A bulk caller (the transfer sweep) walks thousands of nodes and must never
    // turn a missing vector into a model call per node — it asks for what is
    // already mapped and lets the background sweep catch up.
    if (!queryBlob && !allowEmbed) return [];
    if (!queryBlob) {
        // Never indexed (or unreadable) — embed it live rather than returning
        // nothing, and let the background sweep store it properly later.
        const node = db.prepare(`
            SELECT n.id, n.title, n.description, p.title AS parent_title
            FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id
            WHERE n.id = ? AND n.is_note = 0
        `).get(nodeId);
        if (!node) return [];
        try {
            const [vec] = await embedBatch([nodeEmbedText(node)]);
            const unit = normalize(vec || []);
            if (!unit) return [];
            queryBlob = toBlob(unit);
        } catch (err) {
            if (!isUnavailable(err)) console.error('[VEC] topic query embedding failed:', err.message);
            return [];
        }
        scheduleNodeSync();
    }

    const own = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId)?.project_id;
    const mean = centred ? topicMean() : null;
    const useCentre = !!(mean && mean.vec && mean.count >= MIN_CENTRE_TOPICS);
    const rows = knn(queryBlob, {
        limit: useCentre ? Math.max(limit * 4, 24) : limit,
        minSimilarity: useCentre ? Math.min(minSimilarity, CENTRE_RAW_FLOOR) : minSimilarity,
        excludeNodeId: Number(nodeId),
        excludeProjectId: crossProjectOnly ? own : null,
        projectId: null,
        masteredOnly,
        threshold,
    });
    if (!useCentre) return rows;
    const q = blobToArray(queryBlob);
    return rows
        .map(r => {
            const v = blobToArray(readVector(r.id));
            const c = v && q ? centredCosine(q, v, mean.vec) : -1;
            return { ...r, similarity_raw: r.similarity, similarity: c };
        })
        .filter(r => r.similarity >= minCentred)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

/**
 * Free-text → topics. The counterpart of `semanticSearch` for the curriculum
 * rather than the vault ("where have I studied convolution?").
 */
export async function searchNodesSemantic(query, {
    limit = DEFAULT_TOPK,
    minSimilarity = MIN_SIMILARITY,
    projectId = null,
} = {}) {
    if (!embeddingReady() || !vecTableExists('vec_nodes') || !query?.trim()) return [];
    let unit;
    try {
        const [vec] = await embedBatch([query.trim()]);
        unit = normalize(vec || []);
    } catch (err) {
        if (!isUnavailable(err)) console.error('[VEC] topic search embedding failed:', err.message);
        return [];
    }
    if (!unit) return [];
    return knn(toBlob(unit), {
        limit,
        minSimilarity,
        excludeNodeId: null,
        projectId,
        excludeProjectId: null,
        masteredOnly: false,
        threshold: 0,
    });
}

// ---- status -----------------------------------------------------------------

export function nodeEmbeddingStats() {
    const topics = db.prepare(`SELECT COUNT(*) AS c FROM (${EMBEDDABLE_IDS})`).get()?.c || 0;
    const byStatus = db.prepare(
        `SELECT status AS s, COUNT(*) AS c FROM node_embeddings GROUP BY status`
    ).all();
    const counts = Object.fromEntries(byStatus.map(r => [r.s, r.c]));
    let vectors = 0;
    try { vectors = db.prepare('SELECT COUNT(*) AS c FROM vec_nodes').get()?.c || 0; } catch (_) { }
    // `pending` is derived, not stored — and derived the same way the sweep
    // itself decides, so the panel can't report "all indexed" while a batch of
    // edited Overviews is still stale.
    return {
        topics,
        indexed: counts.indexed || 0,
        unavailable: counts.unavailable || 0,
        error: counts.error || 0,
        pending: pendingNodes().length,
        vectors,
    };
}
