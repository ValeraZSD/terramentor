// server/masteryTransfer.js — you have studied this before, somewhere else.
//
// A learner running several projects meets the same topic more than once: the
// Fourier series in a signals course and in a maths course, standing waves in
// an English curriculum and a Dutch one. Until now the engine treated each
// occurrence as a stranger — mastery starts at zero, the feed teaches it from
// scratch, and the learner re-proves what they already proved last month.
//
// This module fixes that using the topic vectors from server/nodeEmbeddings.js.
// It is deliberately the SOFT version of the idea, and the boundary is the
// whole design:
//
//   • Transfer seeds the BKT **prior** — the estimate starts at a defensible
//     non-zero value, so a handful of correct answers is enough to reach the
//     mastery bar instead of a dozen. That is the saving, and it is real.
//
//   • Transfer NEVER closes a gate. Two independent guarantees, because one
//     would be a single edit away from being wrong:
//       1. `TRANSFER_CEILING` caps a seeded prior strictly below any sane
//          `mastery_threshold`, so a borrowed estimate cannot reach the bar
//          however similar and however well-proven the twin is; and
//       2. `checkMasteryEligibility` refuses the BKT clause entirely on a
//          transferred node until it has MIN_GATE_QUESTIONS answers of its
//          OWN — otherwise two lucky true/falses on top of a high prior would
//          clear a topic the learner never touched.
//     Proof still has to happen here. What transfers is the estimate, not the
//     evidence.
//
//   • Transfer is **cross-project only**. Two similar topics inside one course
//     are its author's deliberate structure — a prerequisite and the thing it
//     leads to, a parent and its child — and crediting one from the other would
//     undercut the curriculum rather than the learner's repeated work.
//
// It is also visible by construction: `transferred_prior` and
// `transfer_sources` are stored next to the score, so the UI can say which
// topic in which project the head start came from, and the learner can go take
// the mastery check and be done in one step instead of reading four lessons.
//
// Everything degrades: no embedding model, no vectors, no transfer, and every
// estimate starts at zero exactly as before.

import db from './database.js';
import { decayedMastery, applySeededPrior } from './mastery.js';
import { similarNodes, topicSpaceReady, hasNodeVector } from './nodeEmbeddings.js';

// "Roughly the same thing" is not good enough to hand out a head start —
// this bar is deliberately well above nodeEmbeddings' MIN_SIMILARITY (which
// exists to populate an atlas, where a loose neighbour is interesting rather
// than consequential).
export const TRANSFER_MIN_SIMILARITY = 0.82;
/**
 * The bar on the MEAN-CENTRED similarity, used instead of the raw one once the
 * library is large enough to have a baseline (nodeEmbeddings.js,
 * MIN_CENTRE_TOPICS). Chosen on the real library so the number of qualifying
 * cross-project pairs is unchanged (218 at raw 0.82 ↔ 218 at centred 0.651);
 * what changes is WHICH pairs — 35 coarse section-title pairs out, 35
 * specific twins in. Raw and centred scales are not comparable, which is why
 * this is its own constant.
 */
export const TRANSFER_MIN_CENTRED = 0.65;
// A seeded prior can never reach a mastery threshold. 0.6 sits below the 0.85
// default with room to spare, and below any threshold a user would plausibly
// configure downward.
export const TRANSFER_CEILING = 0.6;
// Below this there is no head start worth claiming, and a weak claim is worse
// than none: it puts a name on the card ("you covered this in X") that the
// learner then can't recognise.
export const TRANSFER_MIN_PRIOR = 0.25;
const MAX_SOURCES = 3;

/**
 * The head start `nodeId` has earned from its twins elsewhere.
 *
 * Contributions are combined with MAX, not a sum. Two curricula covering the
 * same material are the same knowledge described twice — not twice the
 * evidence — and summing would let three loose matches out-weigh one exact
 * one, which is precisely backwards.
 *
 * Each contribution is the twin's *decayed* mastery (a topic proven in March
 * and never revisited is not proof today) scaled by similarity, so a 0.85 twin
 * transfers less than a 0.99 twin.
 */
export async function computeTransfer(nodeId, { threshold = 0.85, decayDays = 14, allowEmbed = true } = {}) {
    // "No twins" and "cannot see the twins" are different answers, and only the
    // first one may withdraw a head start. Without this the embedding model
    // being down for an afternoon silently resets every seeded prior in the
    // library to zero — the vision-probe trap in a second costume: cache (and
    // act on) an answer, never on the absence of one.
    if (!topicSpaceReady() || !hasNodeVector(nodeId)) {
        return { prior: 0, sources: [], available: false };
    }

    const twins = await similarNodes(nodeId, {
        limit: 8,
        minSimilarity: TRANSFER_MIN_SIMILARITY,
        centred: true,
        minCentred: TRANSFER_MIN_CENTRED,
        crossProjectOnly: true,
        masteredOnly: true,
        threshold,
        allowEmbed,
    });

    const sources = twins
        .map(t => {
            const decayed = decayedMastery(t.mastery_score, t.mastery_updated, decayDays);
            return {
                node_id: t.id,
                title: t.title,
                project_id: t.project_id,
                project_name: t.project_name,
                project_color: t.project_color,
                similarity: Number(t.similarity.toFixed(4)),
                mastery: Number(t.mastery_score.toFixed(4)),
                decayed: Number(decayed.toFixed(4)),
                contribution: Number((decayed * t.similarity).toFixed(4)),
            };
        })
        .filter(s => s.contribution > 0)
        .sort((a, b) => b.contribution - a.contribution)
        .slice(0, MAX_SOURCES);

    const best = sources[0]?.contribution ?? 0;
    const prior = Math.min(TRANSFER_CEILING, best);
    return { prior: prior >= TRANSFER_MIN_PRIOR ? prior : 0, sources, available: true };
}

// A node is only eligible for a seeded prior while it has no evidence of its
// own. Once the learner has answered anything here, BKT owns the estimate and
// overwriting it with a borrowed number would destroy real measurement.
const eligibleStmt = db.prepare(`
    SELECT n.id, n.status, COALESCE(nm.total_attempts, 0) AS own_attempts
    FROM nodes n
    LEFT JOIN node_mastery nm ON nm.node_id = n.id
    WHERE n.id = ? AND n.is_note = 0
`);

function canSeed(nodeId) {
    const row = eligibleStmt.get(nodeId);
    if (!row) return false;
    if (row.status === 'completed' || row.status === 'skipped') return false;   // nothing left to save
    return row.own_attempts === 0;
}

// Writing goes through mastery.js's `applySeededPrior` rather than straight to
// the row: placement (server/placement.js) seeds the same `mastery_score` from
// its own columns, and two features writing one number independently means the
// later sweep silently decides the estimate. One author, MAX combine.

/**
 * Compute and persist the head start for one node. Idempotent, and safe to run
 * repeatedly: a twin whose mastery has since decayed below the bar *withdraws*
 * the head start (back to a cold 0.0) rather than leaving a stale one standing,
 * which is why this re-runs rather than only filling gaps.
 *
 * @returns {Promise<{applied: boolean, prior: number, sources: Array}>}
 */
export async function applyTransfer(nodeId, opts = {}) {
    if (!canSeed(nodeId)) return { applied: false, prior: 0, sources: [] };

    const { prior, sources, available } = await computeTransfer(nodeId, opts);

    // Nothing may be withdrawn on an answer we did not actually get.
    if (!available) return { applied: false, prior: 0, sources: [], available: false };

    if (prior <= 0) {
        // Only clears a row that is still purely seeded — `applySeededPrior`
        // refuses a node with real attempts, so no measurement is destroyed,
        // and a placement seed on the same node survives the withdrawal.
        const had = priorStmt.get(nodeId)?.transferred_prior;
        if (had != null) applySeededPrior(nodeId, 'transfer', 0);
        return { applied: false, prior: 0, sources: [] };
    }

    applySeededPrior(nodeId, 'transfer', prior, sources);
    return { applied: true, prior, sources };
}

// ---- the sweep --------------------------------------------------------------

// Candidates: open topics the learner has not answered anything on. That
// excludes completed and skipped nodes (nothing to save) and anything already
// measured (real evidence beats a borrowed estimate).
const CANDIDATES_SQL = `
    SELECT n.id
    FROM nodes n
    LEFT JOIN node_mastery nm ON nm.node_id = n.id
    JOIN projects p ON p.id = n.project_id
    WHERE n.is_note = 0
      AND n.status NOT IN ('completed', 'skipped')
      AND COALESCE(nm.total_attempts, 0) = 0
      AND COALESCE(p.status, 'active') != 'archived'
`;

let sweeping = false;

// Hoisted: the sweep asks this once per candidate, and `db.prepare` inside a
// loop re-parses the same SQL a few thousand times a run.
const priorStmt = db.prepare('SELECT transferred_prior FROM node_mastery WHERE node_id = ?');

// How long the sweep may hold the one thread before handing it back.
//
// `await` is not a yield here. Every candidate costs a sqlite-vec KNN, which is
// synchronous, so `await applyTransfer(...)` resolves into a MICROTASK — and the
// microtask queue is drained without ever returning to the event loop, so no
// timer runs and no socket is read. The loop below was therefore fully blocking
// despite being written in async style: measured on the real library, the server
// answered nothing for 32 s starting 46 s after every boot (one 30-byte probe
// took 31,979 ms, four failed outright), which is a blank app for whoever was
// looking at it.
//
// `setImmediate` IS a yield — it is a macrotask, so pending I/O is served before
// the loop resumes. Slicing by elapsed time rather than by a candidate count
// keeps the cost proportional: one hand-back per 20 ms of work, whatever a
// single KNN happens to cost, instead of a fixed N that is too many yields on a
// small library and too few on a large one.
const SLICE_MS = 20;

/**
 * Refresh every open topic's head start.
 *
 * Cheap by construction: the node's own vector is already stored, so each
 * candidate costs one sqlite-vec KNN and no model call at all (`allowEmbed:
 * false` makes that a guarantee rather than an expectation — an unmapped node
 * is skipped and picked up after the next embedding sweep).
 */
export async function sweepTransfers({ threshold = 0.85, decayDays = 14 } = {}) {
    if (sweeping) return { skipped: 'in-progress' };
    // Without the topic space every candidate would come back "no twins", and
    // a sweep is exactly where that would be mistaken for a verdict at scale.
    if (!topicSpaceReady()) return { skipped: 'unavailable' };
    sweeping = true;
    let seeded = 0, cleared = 0, scanned = 0;
    try {
        const ids = db.prepare(CANDIDATES_SQL).all().map(r => r.id);
        let sliceStart = Date.now();
        for (const id of ids) {
            scanned++;
            const before = priorStmt.get(id)?.transferred_prior ?? null;
            const { applied } = await applyTransfer(id, { threshold, decayDays, allowEmbed: false });
            if (applied) seeded++;
            else if (before != null) cleared++;
            // Hand the thread back so the app stays answerable while this runs.
            // It costs the sweep nothing that matters: it is a background
            // refresh of a head start, and nobody is waiting on the total.
            if (Date.now() - sliceStart >= SLICE_MS) {
                await new Promise(resolve => setImmediate(resolve));
                sliceStart = Date.now();
            }
        }
        return { scanned, seeded, cleared };
    } catch (err) {
        // Never fatal — a failed sweep costs a head start, not a session.
        console.error('[Transfer] sweep failed:', err.message);
        return { scanned, seeded, cleared, error: err.message };
    } finally {
        sweeping = false;
    }
}

// Debounced trigger. Fired where the answer is about to be needed (a feed
// load) and after the topic map changes, rather than on a timer.
const SWEEP_DEBOUNCE_MS = 10_000;
let sweepTimer = null;
let sweepOpts = {};

export function scheduleTransferSweep(opts = {}) {
    sweepOpts = { ...sweepOpts, ...opts };
    if (sweepTimer) return;              // already pending; one sweep covers everything
    sweepTimer = setTimeout(() => {
        sweepTimer = null;
        const o = sweepOpts;
        sweepOpts = {};
        sweepTransfers(o).catch(() => { });
    }, opts.delay ?? SWEEP_DEBOUNCE_MS);
    sweepTimer.unref?.();
}

// ---- reading ----------------------------------------------------------------

const infoStmt = db.prepare(`
    SELECT nm.transferred_prior, nm.transfer_sources, nm.transfer_at, nm.total_attempts
    FROM node_mastery nm WHERE nm.node_id = ?
`);

/**
 * The head start on one node, ready for display: `{prior, sources, spent}`, or
 * null when there is none.
 *
 * Stored sources are re-validated against the live tables on every read. The
 * JSON is a snapshot taken when the sweep ran, and a source topic can be
 * renamed, moved or deleted between sweeps — a card offering to open a topic
 * that no longer exists is worse than a card that says nothing.
 *
 * `spent` marks a node the learner has since answered: the head start is
 * history rather than an active offer, but it still explains why the estimate
 * started where it did, so it is reported instead of hidden.
 */
export function getTransferInfo(nodeId) {
    const row = infoStmt.get(nodeId);
    if (!row || row.transferred_prior == null) return null;

    let stored = [];
    try { stored = JSON.parse(row.transfer_sources || '[]'); } catch (_) { stored = []; }
    if (!Array.isArray(stored) || stored.length === 0) return null;

    const ids = stored.map(s => s.node_id).filter(Boolean);
    if (ids.length === 0) return null;
    const live = new Map(db.prepare(`
        SELECT n.id, n.title, n.project_id, p.name AS project_name, p.color AS project_color
        FROM nodes n JOIN projects p ON p.id = n.project_id
        WHERE n.id IN (${ids.map(() => '?').join(',')}) AND n.is_note = 0
    `).all(...ids).map(r => [r.id, r]));

    const sources = stored
        .filter(s => live.has(s.node_id))
        .map(s => ({ ...s, ...live.get(s.node_id), node_id: s.node_id }));
    if (sources.length === 0) return null;

    return {
        prior: row.transferred_prior,
        sources,
        at: row.transfer_at,
        spent: (row.total_attempts || 0) > 0,
    };
}

/** Batch form for the feed, which needs the head start for a screenful of nodes. */
export function getTransferInfoMap(nodeIds = []) {
    const out = {};
    for (const id of new Set(nodeIds)) {
        const info = getTransferInfo(id);
        if (info) out[id] = info;
    }
    return out;
}
