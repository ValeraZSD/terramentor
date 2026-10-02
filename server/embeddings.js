// server/embeddings.js — the shared vector plumbing, plus the Vault's own layer.
//
// Turns document chunks into embeddings and stores them in a sqlite-vec `vec0`
// virtual table so the tutor's RAG retrieval can find chunks by *meaning*, not
// just keyword overlap. This module owns:
//   - the embedding provider call (Ollama /api/embed or any OpenAI-compatible
//     /v1/embeddings endpoint — it follows the app's configured AI provider),
//   - the vec table lifecycle (created lazily once we know the model's
//     dimension; rebuilt if the model — and therefore the dimension — changes),
//   - the single background chain every embedding job runs on, and
//   - background indexing of a document's chunks + the KNN query used by
//     hybrid search in server/ai.js.
//
// The provider call, the table lifecycle and the chain are shared with
// server/nodeEmbeddings.js (topics rather than chunks) — deliberately, because
// all three are properties of *the embedding model*, not of what is being
// embedded. In particular there is ONE chain: a local model is usually
// single-slot, so a second chain would not add throughput, it would just
// interleave a curriculum sweep into the middle of a big PDF upload.
//
// EVERYTHING here degrades gracefully: if sqlite-vec didn't load, or no
// embedding model is reachable, indexing marks docs 'unavailable' and
// `semanticSearch` returns [] — the caller (searchDocuments) then falls back to
// pure FTS5 keyword search. Semantic search is an enhancement, never a
// dependency.

import db, { vecAvailable } from './database.js';
import { getAISettings, normalizeOpenAIBaseUrl, openAIBody } from './ai.js';
import * as tasks from './tasks.js';

// The model used when the learner has not chosen one. These are the only two
// model names in the app, and both are FUNCTIONAL defaults, not recommendations
// (memory `no-hardcoded-models`): without one the feature does nothing at all.
//
// Ollama and any other endpoint: `nomic-embed-text`, the most-pulled embedding
// model on Ollama and a 274 MB download — a compatibility default.
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
// OpenRouter: it serves no Ollama name, so the Ollama default left a family
// member's atlas undrawn with nothing saying why (2026-10-01). Picked on
// 2026-10-02 from the router's live catalogue of 33 embedding models: the
// highest MMTEB (Multilingual) mean of any entry with a published score (70.58;
// Gemini Embedding 2 69.9 at twenty times the price), in the cheapest paid
// tier ($0.01 per million tokens — embedding a 4,600-topic library measured
// under one cent), 32k context, and every one of its serving providers
// accepts zero-data-retention routing. The free entries were ruled out on
// that last point: they keep requests for training. Re-check the catalogue
// before changing it, and know that a change re-embeds every library that
// never chose a model.
export const HOSTED_EMBEDDING_DEFAULT = 'qwen/qwen3-embedding-8b';
const EMBED_BATCH = 32;          // chunks per embedding request
const DEFAULT_TOPK = 5;

// ---- settings helpers -------------------------------------------------------

// Guarded like the copies in capture.js / paper.js / settingsStore.js — this module is
// the one that must never throw (it runs on a background chain, and semantic
// search is an enhancement, never a dependency), yet it was the one copy of
// this helper with no try/catch. Every call site below already treats null as
// "unset", so a busy or locked DB degrades to defaults instead of killing the
// indexing chain.
function getSetting(key) {
    try {
        return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    } catch {
        return null;
    }
}
function setSetting(key, value) {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

const EMBEDDING_PROVIDERS = ['auto', 'ollama', 'openai'];

/** OpenRouter, recognised by the host of the endpoint embeddings go to. */
function isOpenRouter(baseUrl) {
    try {
        const host = new URL(normalizeOpenAIBaseUrl(baseUrl)).hostname.toLowerCase();
        return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
    } catch { return false; }
}

/** The model for a learner who has not chosen one, by where embeddings run. */
function defaultEmbeddingModel(provider) {
    try {
        const ai = getAISettings();
        const resolved = provider === 'auto' ? ai.provider : provider;
        if (resolved === 'openai' && isOpenRouter(ai.baseUrl)) return HOSTED_EMBEDDING_DEFAULT;
    } catch { /* settings unreadable: the compatibility default, as before */ }
    return DEFAULT_EMBEDDING_MODEL;
}

export function getEmbeddingConfig() {
    const enabledRaw = getSetting('embedding_enabled');
    const providerRaw = getSetting('embedding_provider');
    // Embeddings can run on a different provider than chat (e.g. chat on an
    // OpenAI-compatible endpoint, embeddings on Ollama). 'auto' follows the
    // chat provider — the original behaviour and the default.
    const provider = EMBEDDING_PROVIDERS.includes(providerRaw) ? providerRaw : 'auto';
    // A stored model is the learner's choice and always wins. The default is
    // never written back, so an unchosen library follows the default.
    const chosen = getSetting('embedding_model');
    return {
        // Feature is opt-out: on by default, but useless (and silently inert)
        // until an embedding model is actually reachable.
        enabled: enabledRaw === null ? true : enabledRaw === 'true',
        model: chosen || defaultEmbeddingModel(provider),
        modelIsDefault: !chosen,
        provider,
        dim: getSetting('embedding_dim') ? Number(getSetting('embedding_dim')) : null,
        vecAvailable,
    };
}

// vecAvailable + enabled. Callers still handle an empty result (no model).
export function embeddingReady() {
    return vecAvailable && getEmbeddingConfig().enabled;
}

// ---- provider call ----------------------------------------------------------

// Embed a batch of strings → array of number[]. Throws on any failure (missing
// model, unreachable endpoint, shape mismatch) so callers can distinguish
// "no embeddings available" from "zero results".
export async function embedBatch(texts) {
    const ai = getAISettings();
    const cfg = getEmbeddingConfig();
    const model = cfg.model;
    // Both endpoint URLs are stored settings regardless of which chat provider
    // is active, so a forced embedding provider always has a target to hit.
    const provider = cfg.provider === 'auto' ? ai.provider : cfg.provider;

    if (provider === 'openai') {
        const base = normalizeOpenAIBaseUrl(ai.baseUrl);
        const res = await fetch(`${base}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(ai.apiKey ? { Authorization: `Bearer ${ai.apiKey}` } : {}),
            },
            // Chunks of the learner's own documents are the payload here, so
            // this path needs the endpoint's privacy fields every bit as much
            // as a chat turn does. The Ollama branch below is a local engine
            // and takes none of them.
            body: openAIBody({ model, input: texts }),
            signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`embeddings ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }
        const json = await res.json();
        const data = Array.isArray(json?.data) ? json.data : [];
        if (data.length !== texts.length) throw new Error(`embeddings returned ${data.length} vectors for ${texts.length} inputs`);
        // The spec orders `data` by its `index` field, not by position — most
        // servers happen to return them in input order, but a vector filed
        // under the wrong chunk is a silent retrieval bug, so sort explicitly.
        const ordered = data.every(d => Number.isInteger(d?.index))
            ? [...data].sort((a, b) => a.index - b.index)
            : data;
        return ordered.map(d => d.embedding);
    }

    // Ollama (default provider). /api/embed accepts a batch and returns
    // { embeddings: number[][] }.
    const res = await fetch(`${ai.ollamaUrl.replace(/\/+$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`ollama embed ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const json = await res.json();
    const embeddings = json?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new Error(`ollama embed returned an unexpected shape`);
    }
    return embeddings;
}

export function toBlob(vec) {
    return Buffer.from(new Float32Array(vec).buffer);
}

// ---- vec table lifecycle ----------------------------------------------------

// Every vec0 table in the app, with the bookkeeping that has to be reset when
// its vectors are thrown away. `embedding_dim` is a single global setting
// because all of them are written by the same model — so a model swap
// invalidates ALL of them, and a rebuild that only remembered `vec_chunks`
// would leave the others holding vectors from the previous model's space,
// silently comparable to nothing.
const VEC_TABLES = {
    vec_chunks: () => db.prepare(`UPDATE documents SET embedding_status = NULL WHERE embedding_status IS NOT NULL`).run(),
    vec_nodes: () => db.prepare(`DELETE FROM node_embeddings`).run(),
};

export function vecTableExists(table = 'vec_chunks') {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

// Ensure `table` exists with the given embedding dimension. If the stored
// dimension differs (the user switched embedding models), every stored vector
// is meaningless — drop them all, reset the index state that claimed they were
// current, and recreate. Returns false if vectors can't be stored at all.
//
// The dimension is only half of "which space are these in": two models can both
// write 768 numbers and mean nothing alike by them, and a same-size swap left
// every stored vector compared against queries from the new model — search
// that returns confidently wrong passages. So the MODEL is recorded beside the
// dimension (`embedding_space`) and a change in either is the same event. A
// library from before the record adopts the current model without a rebuild:
// what wrote its vectors is not knowable after the fact.
export function ensureVecTable(dim, table = 'vec_chunks') {
    if (!vecAvailable) return false;
    const storedDim = getSetting('embedding_dim') ? Number(getSetting('embedding_dim')) : null;
    const space = embeddingSpace();
    const storedSpace = getSetting('embedding_space');
    const spaceChanged = storedSpace !== null && storedSpace !== space;
    if (storedDim === dim && !spaceChanged && vecTableExists(table)) {
        if (storedSpace === null) setSetting('embedding_space', space);
        return true;
    }

    if ((storedDim !== null && storedDim !== dim) || spaceChanged) {
        for (const [name, resetState] of Object.entries(VEC_TABLES)) {
            if (!vecTableExists(name)) continue;
            db.exec(`DROP TABLE IF EXISTS ${name}`);
            try { resetState(); } catch (_) { /* sidecar table not created yet */ }
        }
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[${dim}])`);
    setSetting('embedding_dim', dim);
    setSetting('embedding_space', space);
    return true;
}

/**
 * Which model's space a vector written NOW would be in: the provider that will
 * serve the embedding (with `auto` resolved to the chat provider) and the model.
 */
export function embeddingSpace() {
    const cfg = getEmbeddingConfig();
    const provider = cfg.provider === 'auto' ? getAISettings().provider : cfg.provider;
    return `${provider}:${cfg.model}`;
}

/** The stored vectors were written by another model than the one a query would use. */
export function storedSpaceIsStale() {
    const stored = getSetting('embedding_space');
    return stored !== null && stored !== embeddingSpace();
}

// ---- indexing (background, serialized) --------------------------------------

// A single-file mistake — routing embed jobs through the shared tutor queue,
// which runs one task at a time — would freeze chat behind a big upload, so
// indexing has its own serial chain. It's mirrored into the TaskDock
// (registerExternal) purely for visibility, running ALONGSIDE the chat queue,
// not through it.
let indexChain = Promise.resolve();

// The one chain, shared with server/nodeEmbeddings.js. Fire-and-forget: a job
// that throws is swallowed so it can never poison the tail of the chain.
export function enqueueVectorJob(job) {
    indexChain = indexChain.then(job).catch(() => { });
    return indexChain;
}

function markDoc(documentId, status) {
    db.prepare('UPDATE documents SET embedding_status = ? WHERE id = ?').run(status, documentId);
}

// Failures that mean "no model available" (so the whole feature is just
// degraded, not broken) vs. a genuine error worth surfacing.
export function isUnavailable(err) {
    const m = String(err?.message || '').toLowerCase();
    // The NAME first, because the message cannot be trusted for a cancellation:
    // an undici abort says "This operation was aborted", but ai.js throws its own
    // `Error('Request was cancelled')` for a signal that was already aborted, and
    // 'Cancelled' from the vision path — neither matches any string below. An
    // abort says nothing about the request, so `regionNaming` was recording
    // "call-failed: Request was cancelled" against a region and spending one of
    // its three attempts on it. AbortSignal.timeout() reports TimeoutError.
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
    return m.includes('no router') || m.includes('not found') || m.includes('404')
        || m.includes('econnrefused') || m.includes('fetch failed')
        || m.includes('timeout') || m.includes('timed out')
        || m.includes('aborted') || m.includes('cancelled') || m.includes('canceled')
        // The model server ANSWERED, and what it said was that it died. Ollama
        // and llama-swap both report a crashed or non-starting `llama-server`
        // this way ("llama-server process has terminated: exit status
        // 0xc0000409", "llama-server startup failed after projector CPU offload
        // retry"), and neither string matches anything above — so a crashed
        // backend read as a per-item failure and every batch caller burned its
        // whole run against a dead endpoint one item at a time instead of
        // stopping and retrying later. Observed on this box: 60 regions
        // attempted, 60 identical crash messages, 0 named, no signal that the
        // endpoint was the problem.
        || m.includes('process has terminated') || m.includes('startup failed')
        || m.includes('exit status')
        // Momentarily out of capacity is still "not now": a single-slot local
        // server refuses while another consumer holds it, and a hosted free
        // tier rate-limits. Callers already distinguish a transient refusal
        // from a dead endpoint by counting CONSECUTIVE failures.
        || m.includes('econnreset') || m.includes('socket hang up')
        || m.includes('429') || m.includes('502') || m.includes('503');
}

async function runIndex(documentId) {
    if (!vecAvailable) { markDoc(documentId, 'unavailable'); return; }
    if (!getEmbeddingConfig().enabled) { markDoc(documentId, 'pending'); return; }

    const chunks = db.prepare('SELECT id, content FROM document_chunks WHERE document_id = ? ORDER BY chunk_index').all(documentId);
    if (chunks.length === 0) { markDoc(documentId, 'indexed'); return; }

    markDoc(documentId, 'pending');
    const doc = db.prepare('SELECT title, project_id, node_id FROM documents WHERE id = ?').get(documentId);
    const label = (doc?.title || 'document').slice(0, 40);
    // Nobody pressed anything: a document was added and the app indexes it.
    // The ids say where it was added, so the record can go back there.
    const indexOrigin = { surface: 'app', job: 'index_document', projectId: doc?.project_id, nodeId: doc?.node_id };
    const handle = tasks.registerExternal({
        kind: 'embed', label: `Indexing "${label}"`, cancel: () => { },
        labelKey: 'Indexing “{{title}}”', labelParams: { title: label },
        origin: indexOrigin,
    });

    try {
        let done = 0;
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
            const batch = chunks.slice(i, i + EMBED_BATCH);
            const vectors = await embedBatch(batch.map(c => c.content));
            const dim = vectors[0]?.length;
            if (!dim) throw new Error('embedding model returned empty vectors');
            if (!ensureVecTable(dim)) throw new Error('vector storage unavailable');

            const del = db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
            const ins = db.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)');
            db.transaction(() => {
                batch.forEach((c, j) => {
                    del.run(c.id);                    // idempotent re-index
                    // vec0 rejects a plain JS number as a rowid PK — it must be
                    // a BigInt (chunk ids come back from SELECT as numbers).
                    ins.run(BigInt(c.id), toBlob(vectors[j]));
                });
            })();
            done += batch.length;
            handle.update({ progress: Math.round((done / chunks.length) * 100), percent: Math.round((done / chunks.length) * 100) });
        }
        markDoc(documentId, 'indexed');
        handle.finish();
    } catch (err) {
        const status = isUnavailable(err) ? 'unavailable' : 'error';
        markDoc(documentId, status);
        if (status === 'unavailable') { console.warn(`[VEC] indexing doc ${documentId} skipped — no embedding model: ${err.message}`); handle.finish(); }
        else { console.error(`[VEC] indexing doc ${documentId} failed: ${err.message}`); handle.fail(err.message); }
    }
}

// Fire-and-forget: enqueue a document for background embedding. Safe to call
// even when vec/embeddings are off (it just records the 'unavailable' state).
export function indexDocument(documentId) {
    if (!documentId) return;
    enqueueVectorJob(() => runIndex(documentId));
}

// Delete the vectors for a set of chunk ids (used when a document is removed —
// vec_chunks is not a real FK so the cascade can't reach it).
export function removeChunkVectors(chunkIds) {
    if (!vecAvailable || !vecTableExists() || !chunkIds?.length) return;
    const del = db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
    db.transaction(() => { chunkIds.forEach(id => del.run(id)); })();
}

// ---- query ------------------------------------------------------------------

// KNN over the vault, scoped to a node and/or project. Returns chunk rows with
// a `distance` (smaller = closer). Empty array whenever semantic search can't
// run — the caller falls back to keyword search.
//
// `projectWide` widens a project scope to every document the course holds:
// the ones filed on the project itself AND the ones filed on any of its topics
// (an upload to a topic, or an imported course's documents, carries a node_id
// and a NULL project_id). The chat scopes stay as they were; the lesson writer
// (server/lessonSources.js) asks for the whole course.
export async function semanticSearch(query, { nodeId = null, projectId = null, projectWide = false } = {}, limit = DEFAULT_TOPK) {
    if (!embeddingReady() || !vecTableExists() || !query?.trim()) return [];
    // A query from one model measured against another model's vectors ranks
    // noise; keyword search is the honest answer until the re-index lands.
    if (storedSpaceIsStale()) return [];
    let qvec;
    try {
        [qvec] = await embedBatch([query]);
    } catch (err) {
        if (!isUnavailable(err)) console.error('[VEC] query embedding failed:', err.message);
        return [];
    }
    if (!qvec?.length) return [];

    // Over-fetch, then filter by scope in SQL (vec0 metadata filtering is
    // avoided for portability — vault sizes are small, so this is cheap).
    const overfetch = Math.min(Math.max(limit * 8, 40), 200);
    let hits;
    try {
        hits = db.prepare(
            `SELECT rowid AS chunk_id, distance FROM vec_chunks
             WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
        ).all(toBlob(qvec), overfetch);
    } catch (err) {
        console.error('[VEC] KNN query failed:', err.message);
        return [];
    }
    if (hits.length === 0) return [];

    const distById = new Map(hits.map(h => [h.chunk_id, h.distance]));
    const placeholders = hits.map(() => '?').join(',');

    let scope = '';
    const scopeParams = [];
    if (projectWide && projectId) {
        scope = ' AND (d.project_id = ? OR d.node_id IN (SELECT id FROM nodes WHERE project_id = ?))';
        scopeParams.push(projectId, projectId);
    }
    else if (nodeId && projectId) { scope = ' AND (d.node_id = ? OR d.project_id = ?)'; scopeParams.push(nodeId, projectId); }
    else if (nodeId) { scope = ' AND d.node_id = ?'; scopeParams.push(nodeId); }
    else if (projectId) { scope = ' AND d.project_id = ?'; scopeParams.push(projectId); }

    const rows = db.prepare(
        `SELECT dc.id AS chunk_id, dc.content, dc.chunk_index, d.title AS doc_title
         FROM document_chunks dc JOIN documents d ON d.id = dc.document_id
         WHERE dc.id IN (${placeholders})${scope}`
    ).all(...hits.map(h => h.chunk_id), ...scopeParams);

    return rows
        .map(r => ({ ...r, distance: distById.get(r.chunk_id) ?? Infinity }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);
}

// ---- settings / status / maintenance API ------------------------------------

// Probe whether an embedding model actually answers (used by the settings UI).
// Cached briefly so the Settings panel doesn't spam the model.
let probeCache = { at: 0, result: null };
export async function probeEmbedding({ force = false } = {}) {
    const now = Date.now();
    if (!force && probeCache.result && now - probeCache.at < 15000) return probeCache.result;
    if (!vecAvailable) {
        return (probeCache = { at: now, result: { ok: false, reason: 'sqlite-vec extension not loaded', dim: null } }).result;
    }
    try {
        const [v] = await embedBatch(['semantic search probe']);
        const dim = v?.length || null;
        return (probeCache = { at: now, result: { ok: !!dim, dim, model: getEmbeddingConfig().model } }).result;
    } catch (err) {
        return (probeCache = { at: now, result: { ok: false, reason: err.message, model: getEmbeddingConfig().model, dim: null } }).result;
    }
}

/**
 * The embedding models a catalogue lists, read off either shape an
 * OpenAI-compatible endpoint publishes: a dedicated embeddings list (every
 * entry is one), or the general model list where an entry SAYS it outputs
 * embeddings (`architecture.output_modalities`). An entry that says nothing is
 * left out — a chat model offered as an embedding model is the failure this
 * list exists to prevent. Pure, for the gate.
 */
export function embeddingModelIds(json, { dedicated = false } = {}) {
    const list = Array.isArray(json?.data) ? json.data : [];
    const seen = new Set();
    const out = [];
    for (const m of list) {
        const id = typeof m?.id === 'string' ? m.id.trim() : '';
        if (!id || seen.has(id)) continue;
        const outputs = m?.architecture?.output_modalities;
        if (!dedicated && !(Array.isArray(outputs) && outputs.includes('embeddings'))) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * What the embedding picker should offer: the models the endpoint that serves
 * EMBEDDINGS says can embed.
 *
 * The picker used to show the chat provider's list, which on a hosted router is
 * hundreds of chat models and not one embedding model — so the field kept the
 * built-in default, an Ollama name no router serves, and the atlas stayed
 * undrawn with nothing on screen saying why (the family PC, 2026-10-01: it took
 * an outside agent to research and type one in). It asks THE CONFIGURED
 * ENDPOINT and nowhere else, so it adds no host to SECURITY.md's inventory.
 * `available: false` is an answer — an endpoint that publishes neither shape
 * (a local engine, OpenAI itself) leaves the picker on the general list.
 */
export async function listEmbeddingModels() {
    const ai = getAISettings();
    const cfg = getEmbeddingConfig();
    const provider = cfg.provider === 'auto' ? ai.provider : cfg.provider;
    if (provider !== 'openai') return { provider, available: false, models: [] };
    const base = normalizeOpenAIBaseUrl(ai.baseUrl);
    const headers = ai.apiKey ? { Authorization: `Bearer ${ai.apiKey}` } : {};
    const read = async (path) => {
        try {
            const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10000) });
            return res.ok ? await res.json() : null;
        } catch { return null; }
    };
    let models = embeddingModelIds(await read('/embeddings/models'), { dedicated: true });
    if (!models.length) models = embeddingModelIds(await read('/models?output_modalities=embeddings'));
    return { provider, available: models.length > 0, models };
}

export function embeddingStats() {
    const byStatus = db.prepare(
        `SELECT COALESCE(embedding_status, 'pending') AS s, COUNT(*) AS c
         FROM documents WHERE status = 'ready' GROUP BY s`
    ).all();
    const counts = Object.fromEntries(byStatus.map(r => [r.s, r.c]));
    let vectors = 0;
    try { vectors = db.prepare('SELECT COUNT(*) AS c FROM vec_chunks').get()?.c || 0; } catch (_) { }
    return {
        indexed: counts.indexed || 0,
        pending: (counts.pending || 0),
        unavailable: counts.unavailable || 0,
        error: counts.error || 0,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        vectors,
    };
}

export function setEmbeddingSettings({ enabled, model, provider }) {
    if (typeof enabled === 'boolean') setSetting('embedding_enabled', enabled ? 'true' : 'false');
    if (typeof model === 'string' && model.trim()) setSetting('embedding_model', model.trim());
    if (typeof provider === 'string' && EMBEDDING_PROVIDERS.includes(provider)) setSetting('embedding_provider', provider);
    probeCache = { at: 0, result: null };
    // A new model makes every stored document vector unusable (see
    // ensureVecTable), so the documents are queued again now rather than left
    // for the learner to find "Re-index all".
    if (storedSpaceIsStale() && getEmbeddingConfig().enabled) {
        const indexed = db.prepare(`SELECT COUNT(*) AS c FROM documents WHERE status = 'ready' AND embedding_status = 'indexed'`).get().c;
        if (indexed > 0) return { reindexQueued: reindexAll().queued };
    }
    return {};
}

// Re-embed every ready document (e.g. after enabling the feature or pulling a
// model). Clears prior index state so the badges reflect the fresh run.
export function reindexAll() {
    const docs = db.prepare(`SELECT id FROM documents WHERE status = 'ready'`).all();
    db.prepare(`UPDATE documents SET embedding_status = NULL WHERE status = 'ready'`).run();
    docs.forEach(d => indexDocument(d.id));
    return { queued: docs.length };
}
