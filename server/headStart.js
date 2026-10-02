// server/headStart.js — what a head start CHANGES.
//
// Two features hand a topic an estimate it did not earn here: placement (a probe
// answered before studying, server/placement.js) and transfer (a proven twin in
// another project, server/masteryTransfer.js). mastery.js holds the half of that
// contract about PROOF: a seed is capped below any threshold, suspends the BKT
// clause and can never close a gate. This module holds the other half, the
// teaching it saves, which until 2026-09-28 was promised on screen and read by
// nothing — the feed wrote, scheduled and served a seeded topic exactly like a
// cold one. Now three readers take it from here:
//
//   1. feedGen.js plans the topic as a REVIEW — at most `reviewParts` parts,
//      written as a brisk consolidation rather than a first teaching;
//   2. feedGen.js writes the topic's mastery check right after its first part,
//      because the chapter offers that check FIRST ("Prove it now"), and an
//      offer that opens onto a 24-second wait is not much of one;
//   3. scheduling.js gives it `scheduleShare` of the time a cold topic gets.
//
// A head start stands until the learner's own answers say otherwise: once they
// have answered here and the estimate sits below where the seed put it — a failed
// "Prove it now", a run of forgotten cards — it shortens nothing, and a topic not
// yet started is planned in full again (`planIsStale` in feedGen.js).
//
// Reads only. No module here writes a seed; `applySeededPrior` stays the one
// author of `mastery_score`. Imports only the database, so mastery.js,
// scheduling.js, feed.js and feedGen.js can all read it without a cycle.

import db from './database.js';

// A seed at or above this is a strong claim — a correct answer on the topic
// itself (placement: 0.41 multiple choice, 0.52 open), or a fresh proven twin
// (transfer: 0.6) — and the review is two parts. Below it the seed was inferred
// (placement's propagation: 0.29 / 0.37) or its source has faded, and the review
// keeps a third part. A learner who set `feed_max_parts` lower gets that instead
// (`reviewParts` takes the smaller).
export const STRONG_HEAD_START = 0.4;
export const REVIEW_PARTS_STRONG = 2;
export const REVIEW_PARTS = 3;

/**
 * The head start a `node_mastery` row carries, or null. Pure — the whole rule,
 * and what `tools/head-start-gates.mjs` asserts.
 *
 * `prior` is the larger of the two seeds (they combine by MAX in
 * `applySeededPrior`), `source` names the one that set it; a tie goes to
 * transfer, whose banner can point at the topic that was proven.
 */
export function headStartOf(row) {
    if (!row) return null;
    const transfer = Number(row.transferred_prior) || 0;
    const placement = Number(row.placement_prior) || 0;
    const prior = Math.max(transfer, placement);
    if (!(prior > 0)) return null;
    // Answers of its own that put the estimate under the seed mean the seed
    // was wrong about this learner. Answers that agree with it leave it be.
    if ((Number(row.total_attempts) || 0) > 0 && (Number(row.mastery_score) || 0) < prior) return null;
    return { prior, source: transfer >= placement ? 'transfer' : 'placement' };
}

// Statements are prepared on first use, never at import: scheduling.js imports
// this module, half the server imports scheduling.js, and a statement prepared
// at import time made merely LOADING the scheduler a database operation — which
// fails outright once a caller has closed its connection (tools/deck-gates.mjs
// imports progress.js after closing, and died here).
const statements = new Map();
const stmt = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
};

/** The head start on one topic, or null. Never creates a mastery row. */
export function headStartFor(nodeId) {
    return headStartOf(stmt(`
        SELECT transferred_prior, placement_prior, mastery_score, total_attempts
        FROM node_mastery WHERE node_id = ?
    `).get(nodeId));
}

/** Every head start in a project, by node id — the scheduler's batch read. */
export function headStartsForProject(projectId) {
    const rows = stmt(`
        SELECT nm.node_id, nm.transferred_prior, nm.placement_prior, nm.mastery_score, nm.total_attempts
        FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id
        WHERE n.project_id = ?
          AND (nm.transferred_prior IS NOT NULL OR nm.placement_prior IS NOT NULL)
    `).all(projectId);
    const out = new Map();
    for (const r of rows) {
        const hs = headStartOf(r);
        if (hs) out.set(r.node_id, hs);
    }
    return out;
}

/**
 * How many parts the review of a topic with this head start may have, never
 * more than the learner's own `feed_max_parts`. The outline model still sizes
 * the plan to the topic; this is the ceiling it sizes under.
 */
export function reviewParts(prior, maxParts) {
    const cap = prior >= STRONG_HEAD_START ? REVIEW_PARTS_STRONG : REVIEW_PARTS;
    return Math.max(1, Math.min(maxParts, cap));
}

/**
 * The share of a cold topic's study time a head start leaves it: what the
 * estimate says is still unknown. The scheduler applies its own floor.
 */
export function scheduleShare(headStart) {
    return headStart ? 1 - headStart.prior : 1;
}

/** Has the learner started this topic's teaching? Any card of it consumed. */
export function teachingStarted(nodeId) {
    return !!stmt(`SELECT 1 FROM feed_items WHERE node_id = ? AND status = 'consumed' LIMIT 1`).get(nodeId);
}

/** The topics among `nodeIds` whose lesson plan was written as a review. */
export function reviewPlanned(nodeIds = []) {
    const ids = [...new Set(nodeIds)].filter(Number.isInteger);
    if (!ids.length) return new Set();
    const rows = db.prepare(`
        SELECT node_id FROM feed_items
        WHERE kind = 'plan' AND node_id IN (${ids.map(() => '?').join(',')})
          AND json_extract(meta, '$.headStart.parts') IS NOT NULL
    `).all(...ids);
    return new Set(rows.map(r => r.node_id));
}

/**
 * The placement head start on one topic, ready for the feed's chapter banner:
 * `{prior, kind, via, spent}`, or null. The sibling of `getTransferInfo`.
 *
 * `kind` is `direct` when the probe asked about this topic and `implied` when an
 * answer later in its section vouched for it; `via` is that topic, re-read from
 * the live table (renamed, it says the new name; deleted, the banner simply does
 * not name it). `spent` marks a topic the learner has since answered here.
 */
export function getPlacementInfo(nodeId) {
    const row = stmt(`
        SELECT placement_prior, placement_sources, placement_at, total_attempts
        FROM node_mastery WHERE node_id = ?
    `).get(nodeId);
    if (!row || row.placement_prior == null) return null;
    let sources = [];
    try { sources = JSON.parse(row.placement_sources || '[]'); } catch { sources = []; }
    const first = Array.isArray(sources) ? sources[0] : null;
    const kind = first?.kind === 'implied' ? 'implied' : 'direct';
    let via = null;
    if (kind === 'implied' && Number.isInteger(first?.via_node_id)) {
        const live = stmt('SELECT id, title FROM nodes WHERE id = ? AND is_note = 0').get(first.via_node_id);
        if (live) via = { node_id: live.id, title: live.title };
    }
    return {
        prior: row.placement_prior,
        kind,
        via,
        at: row.placement_at,
        spent: (row.total_attempts || 0) > 0,
    };
}

/** Batch form for the feed, keyed by node id. */
export function getPlacementInfoMap(nodeIds = []) {
    const out = {};
    for (const id of new Set(nodeIds)) {
        const info = getPlacementInfo(id);
        if (info) out[id] = info;
    }
    return out;
}
