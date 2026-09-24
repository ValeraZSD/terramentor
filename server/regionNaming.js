// Naming the places on the map.
//
// Without a model, a region is named after its MEDOID (the most central member's
// title, numbering cleaned). That can only ever be one member's title, so it names a
// DISCIPLINE after one lesson inside it ("Mandarin Chinese" over Japanese, French and
// Cyrillic). `labelPenalty` cannot fix it: it scores a title's shape, the defect is
// its scope. So naming gets a model, under these rules:
//
//   - An ENRICHMENT, never a step in drawing: no model, no cached name or a junk
//     answer leaves the medoid label standing.
//   - CACHED BY MEMBER SET, not region index (regions renumber as the library grows),
//     so an unchanged region keeps its name across rebuilds.
//   - The model is NOT in that key. A name is validated prose, not a vector from an
//     incomparable space; keying on the model hid most good names whenever the chat
//     model changed. It is still RECORDED, as provenance and for failure counts.
//   - The naming model is its own setting (`atlas_naming_model`; empty = the chat
//     model), because a short noun phrase wants a fast instruct model.
//   - FAILURES ARE RECORDED (`region_name_failures`) per region and model, or a model
//     that cannot do the job is re-asked on every build forever.
//   - Runs on the ONE shared background chain (`enqueueVectorJob`): a local model is
//     usually single-slot, so a second chain adds interleaving, not throughput.
//   - Every name is MECHANICALLY VALIDATED (`validateName`, pure, asserted by
//     `tools/atlas-gates.mjs`).
//
// Limitation: a model confidently names an INCOHERENT region too. Cohesion cannot
// gate this — on the real library it spans 0.766–0.936 and ranked a junk-drawer region
// above a coherent one. Do not add a cohesion gate without re-measuring.

import crypto from 'crypto';
import db from './database.js';
import { generateResponse, getAISettings, AI_PROMPTS } from './ai.js';
import { enqueueVectorJob, isUnavailable } from './embeddings.js';
import { cleanRegionLabel } from './curriculumLabel.js';
import { languageDirective } from './language.js';
import * as tasks from './tasks.js';

/** Members whose titles are shown to the model, most central first. */
const TITLE_SAMPLE = 24;
/** A place name is a short noun phrase. Anything longer is a description. */
const MAX_WORDS = 6;
const MAX_CHARS = 42;
/** A hand-typed name gets more room than a generated one: it was deliberate. */
const USER_MAX_CHARS = 60;
/**
 * A one-topic region is best named by its own title. Two- and three-topic regions
 * are nameable, since that is where the medoid rule prints a chapter heading as a
 * place name.
 */
const MIN_NAMEABLE = 2;
/** Bound one sweep so a fresh library cannot occupy the chain indefinitely. */
const MAX_PER_SWEEP = 60;
/** Consecutive endpoint failures before a sweep gives up on the batch. */
const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Failures one model gets per region; then only a different model or the learner's
 * rename gets another go, since re-asking is paid on every build.
 */
const MAX_ATTEMPTS = 3;
/** The setting naming its own model. Empty = follow the chat model. */
const NAMING_MODEL_SETTING = 'atlas_naming_model';
/** Recorded in `model` for a name the learner typed. No sweep may overwrite it. */
export const USER_MODEL = 'user';

/**
 * Which model names regions: its own setting, else the chat model. A reasoning-first
 * model tends to spend the timeout deliberating on a four-word answer.
 */
export function namingModel() {
    let configured = '';
    try {
        configured = (db.prepare('SELECT value FROM settings WHERE key = ?').get(NAMING_MODEL_SETTING)?.value || '').trim();
    } catch (_) { }
    return configured || getAISettings().model;
}

/**
 * Names that fit any region and so name none. The medoid, narrower than the
 * region, is the smaller error.
 */
const GENERIC_NAMES = new Set([
    'general knowledge', 'general studies', 'general topics', 'general',
    'miscellaneous', 'various topics', 'various', 'assorted topics', 'other',
    'mixed topics', 'knowledge', 'topics', 'subjects', 'learning', 'education',
    'study', 'studies', 'academics', 'academic subjects', 'school subjects',
    'course content', 'curriculum', 'coursework', 'lessons', 'material',
]);

/**
 * Not a name at all: words for "nothing here". A model answering
 * `{"name": "undefined"}` clears every other rule, and the member-set cache would
 * keep it on the map permanently.
 */
const PLACEHOLDER_NAMES = new Set([
    'undefined', 'null', 'nil', 'none', 'nan', 'n/a', 'na', 'nothing', 'empty',
    'unknown', 'untitled', 'unnamed', 'no name', 'name', 'label', 'region',
    'string', 'todo', 'tbd', 'placeholder', 'error', 'value',
]);

// ---- cache ------------------------------------------------------------------

/**
 * A region's identity is its member set alone: not the region index (regions
 * renumber) and not the naming model (see the header; unlike `node_embeddings`,
 * a name from another model is still valid).
 *
 * The `\0` separator is written as the escape, never a literal control byte, which
 * makes grep treat this file as binary.
 */
export function regionSignature(memberIds) {
    const ids = [...memberIds].map(Number).sort((a, b) => a - b).join(',');
    return crypto.createHash('sha256').update(`region\0${ids}`).digest('hex');
}

/**
 * The older model-bearing hash, kept ONLY so rows stored under it can be adopted
 * (a hash is one-way).
 */
export function legacySignature(memberIds, model) {
    const ids = [...memberIds].map(Number).sort((a, b) => a - b).join(',');
    return crypto.createHash('sha256').update(`${model}\0${ids}`).digest('hex');
}

export function getCachedRegionName(signature) {
    try {
        return db.prepare('SELECT label FROM region_names WHERE signature = ?').get(signature)?.label || null;
    } catch (_) {
        return null;
    }
}

/** Which model wrote the cached name, or null. 'user' means the learner did. */
export function nameModelFor(signature) {
    try {
        return db.prepare('SELECT model FROM region_names WHERE signature = ?').get(signature)?.model || null;
    } catch (_) {
        return null;
    }
}

/** Every model that has ever named a region here — the adoption search space. */
function knownNamingModels() {
    try {
        return db.prepare(
            `SELECT DISTINCT model FROM region_names WHERE model IS NOT NULL AND model != ?`
        ).all(USER_MODEL).map(r => r.model).filter(Boolean);
    } catch (_) {
        return [];
    }
}

/**
 * Re-key one region's name from the legacy hash, once, on first read. The old row
 * stays (a few hundred bytes) so a downgrade keeps its names.
 */
function adoptLegacyName(ids, signature, models) {
    for (const model of models) {
        const row = db.prepare('SELECT label, member_count FROM region_names WHERE signature = ?')
            .get(legacySignature(ids, model));
        if (!row) continue;
        storeRegionName(signature, row.label, model, row.member_count ?? ids.length);
        return row.label;
    }
    return null;
}

function storeRegionName(signature, label, model, memberCount) {
    db.prepare(
        `INSERT INTO region_names (signature, label, model, member_count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(signature) DO UPDATE SET label = excluded.label, model = excluded.model`
    ).run(signature, label, model, memberCount);
}

/**
 * Names for a whole atlas in one lookup, keyed by region index.
 * Called on the request path, so it must be pure SQLite and never a model call.
 */
export function cachedNamesFor(regions) {
    const legacyModels = knownNamingModels();
    const out = new Map();
    for (let i = 0; i < regions.length; i++) {
        const ids = regions[i].members.map(m => m.id);
        const signature = regionSignature(ids);
        let label = getCachedRegionName(signature);
        if (!label && legacyModels.length) label = adoptLegacyName(ids, signature, legacyModels);
        if (label && !keepCachedName(signature, label)) label = null;
        if (label) out.set(i, label);
    }
    return resolveNameCollisions(out, regions.map(r => r.members.length));
}

/**
 * Re-judge a cached name against the CURRENT rules and evict it if it fails.
 *
 * A named region is never queued again, so without this a validator change would
 * never reach names already cached (the same trap as `feed_items`/`widget_builds`).
 * Evicting puts the region back in the queue; its failure record is cleared too, so
 * the model gets fresh attempts under the new rule.
 *
 * A name the LEARNER typed is never re-judged: `validateUserName` is looser.
 */
function keepCachedName(signature, label) {
    try {
        if (nameModelFor(signature) === USER_MODEL) return true;
        if (validateName(label).ok) return true;
        db.prepare('DELETE FROM region_names WHERE signature = ?').run(signature);
        clearFailure(signature);
        return false;
    } catch (_) {
        // Keep what we cannot re-check, rather than blank the map on a SQLite error.
        return true;
    }
}

// ---- failures ---------------------------------------------------------------

/**
 * Has this model already had its chances at this region? Per model: some models
 * cannot do the job, and a different one gets a clean slate.
 */
function exhausted(signature, model) {
    try {
        const row = db.prepare('SELECT model, attempts FROM region_name_failures WHERE signature = ?').get(signature);
        return !!row && row.model === model && row.attempts >= MAX_ATTEMPTS;
    } catch (_) {
        return false;
    }
}

function recordFailure(signature, model, reason) {
    try {
        db.prepare(
            `INSERT INTO region_name_failures (signature, model, attempts, reason)
             VALUES (?, ?, 1, ?)
             ON CONFLICT(signature) DO UPDATE SET
               attempts = CASE WHEN region_name_failures.model = excluded.model
                               THEN region_name_failures.attempts + 1 ELSE 1 END,
               model = excluded.model,
               reason = excluded.reason,
               last_attempt_at = CURRENT_TIMESTAMP`
        ).run(signature, model, String(reason || '').slice(0, 200));
    } catch (_) { /* a lost failure record costs one wasted call, never a name */ }
}

function clearFailure(signature) {
    try { db.prepare('DELETE FROM region_name_failures WHERE signature = ?').run(signature); } catch (_) { }
}

// ---- the learner's own name -------------------------------------------------

/**
 * A name the learner typed, stored under the same member-set key with
 * `model = 'user'` (a sweep only fills unnamed regions, so it is never overwritten).
 *
 * LOOSER than `validateName`, whose strictness is cheap because the medoid is the
 * fallback; here the fallback is nothing the learner asked for. Digits are allowed;
 * only empty, over-long and markup are refused.
 */
export function validateUserName(raw) {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return { ok: false, reason: 'empty' };
    if (s.length > USER_MAX_CHARS) return { ok: false, reason: 'too-long' };
    if (/[<>{}]/.test(s)) return { ok: false, reason: 'markup' };
    return { ok: true, label: s };
}

/** Name a region by hand. */
export function setRegionName(signature, label, memberCount = null) {
    storeRegionName(signature, label, USER_MODEL, memberCount);
    clearFailure(signature);
    return label;
}

/**
 * Hand one region back to the map: the row is deleted, so it shows the medoid now
 * and gets a fresh model name on the next sweep.
 */
export function clearRegionName(signature) {
    try { db.prepare('DELETE FROM region_names WHERE signature = ?').run(signature); } catch (_) { }
    clearFailure(signature);
}

/**
 * Two places on one map may not share a name. Each region is named alone (the key
 * is its own member set), so nothing else prevents a duplicate.
 *
 * Resolved at READ time, independent of sweep order: the LARGEST region keeps the
 * name, the others fall back to their medoid, ties by region index. Case-insensitive
 * EXACT matches only: a near-match rule would also merge genuinely different
 * neighbours ("Japanese Language" / "Japanese Language Learning").
 *
 * Pure, so `tools/atlas-gates.mjs` asserts it.
 */
export function resolveNameCollisions(names, sizes) {
    const claimants = new Map();
    for (const [index, label] of names) {
        const key = label.toLowerCase();
        const list = claimants.get(key) || [];
        list.push(index);
        claimants.set(key, list);
    }

    const out = new Map();
    for (const [, indices] of claimants) {
        if (indices.length === 1) {
            out.set(indices[0], names.get(indices[0]));
            continue;
        }
        let winner = indices[0];
        for (const i of indices) {
            const bigger = (sizes[i] || 0) > (sizes[winner] || 0);
            const tiedButEarlier = (sizes[i] || 0) === (sizes[winner] || 0) && i < winner;
            if (bigger || tiedButEarlier) winner = i;
        }
        out.set(winner, names.get(winner));
    }
    return out;
}

// ---- validation -------------------------------------------------------------

/**
 * Is this string usable as the name of a place on the map?
 *
 * Pure and strict: rejecting a good name costs only the medoid, while a bad one
 * stays on the map until the region's membership changes.
 *
 * @returns {{ok: true, label: string} | {ok: false, reason: string}}
 */
export function validateName(raw) {
    if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' };

    let s = raw.trim()
        // Strip a heading, bullet, quotes or a "Name: X" label.
        .replace(/^#+\s*/, '')
        .replace(/^[-*•]\s*/, '')
        .replace(/^(?:name|label|region|answer)\s*[:—-]\s*/i, '')
        .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
        .replace(/[.。]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();

    // The map's own numbering rule, for a model that echoes a numbered title.
    s = cleanRegionLabel(s);

    if (!s) return { ok: false, reason: 'empty' };
    if (s.length > MAX_CHARS) return { ok: false, reason: 'too-long' };
    // A digit in a place name is a leftover course position ("Stage 28",
    // "W21 Batch", "Module 9.5") far more often than it is meaningful.
    if (/\d/.test(s)) return { ok: false, reason: 'contains-digit' };
    if (s.split(' ').length > MAX_WORDS) return { ok: false, reason: 'too-many-words' };
    // A sentence, not a name.
    if (/[.!?;]/.test(s)) return { ok: false, reason: 'sentence' };
    // Markdown, JSON or fence residue that survived the strip above.
    if (/[{}[\]<>|]/.test(s)) return { ok: false, reason: 'markup' };
    // The model narrating instead of answering.
    if (/^(?:the (?:region|cluster|group|topics?)|these|this (?:region|cluster|group)|a (?:group|collection))\b/i.test(s)) {
        return { ok: false, reason: 'meta' };
    }
    // Placeholders and names that fit anywhere: the prompt asks for the broadest
    // HONEST shared subject, and a model occasionally reaches past it.
    if (PLACEHOLDER_NAMES.has(s.toLowerCase())) return { ok: false, reason: 'placeholder' };
    if (GENERIC_NAMES.has(s.toLowerCase())) return { ok: false, reason: 'generic' };

    return { ok: true, label: s };
}

// ---- naming -----------------------------------------------------------------

/**
 * The language a region should be named in.
 *
 * Members can span projects, so the DOMINANT project's language; unset = follow
 * the material.
 */
function regionLanguage(region) {
    const counts = new Map();
    for (const m of region.members) counts.set(m.project_id, (counts.get(m.project_id) || 0) + 1);
    let best = null, bestN = -1;
    for (const [pid, n] of counts) if (n > bestN) { best = pid; bestN = n; }
    if (best == null) return '';
    try {
        return db.prepare('SELECT content_language FROM projects WHERE id = ?').get(best)?.content_language || '';
    } catch (_) {
        return '';
    }
}

/**
 * Cosine to the region's centroid: both are unit vectors, so the dot product.
 * Restated rather than imported because `atlas.js` imports THIS module, and a cycle
 * would fail at link time where `node --check` cannot see it.
 */
function centrality(member, centroid) {
    if (!centroid || !member?.vec) return 0;
    let s = 0;
    for (let i = 0; i < member.vec.length; i++) s += member.vec[i] * centroid[i];
    return s;
}

/** The titles the model is shown: most central first, cleaned, deduped. */
function titlesFor(region) {
    const centroid = region.centroid;
    const seen = new Set();
    const out = [];
    for (const m of [...region.members].sort((a, b) => centrality(b, centroid) - centrality(a, centroid))) {
        const t = cleanRegionLabel(m.title || '').trim();
        const k = t.toLowerCase();
        if (!t || seen.has(k)) continue;
        seen.add(k);
        out.push(t);
        if (out.length >= TITLE_SAMPLE) break;
    }
    return out;
}

/**
 * Name one region: `{label, reason}`, with `label` null on any content failure
 * (keep the medoid). Only an unavailable endpoint throws.
 */
export async function nameRegion(region, { fallback, signal, model = null } = {}) {
    const titles = titlesFor(region);
    if (titles.length < MIN_NAMEABLE) return { label: null, reason: 'too-small' };

    const projects = [...new Set(region.members.map(m => m.project_name).filter(Boolean))];
    const { system, user } = AI_PROMPTS.region_name(titles, {
        projects,
        fallback,
        language: languageDirective(regionLanguage(region)),
    });

    let raw;
    try {
        raw = await generateResponse(user, system, [], {
            temperature: 0.2,
            operation: 'summary',
            signal,
            model: model || undefined,
        });
    } catch (err) {
        // Unavailable is not a verdict on the region: re-thrown for the sweep's
        // consecutive counter, and nothing is recorded against the region.
        if (isUnavailable(err)) throw err;
        return { label: null, reason: `call-failed: ${String(err?.message || err).slice(0, 120)}` };
    }

    const verdict = validateName(stripJsonName(raw));
    // The reason travels back for the failure count and the region card.
    return verdict.ok ? { label: verdict.label, reason: null } : { label: null, reason: verdict.reason };
}

/**
 * Accept the JSON object the prompt asks for, or a bare phrase (what a small local
 * model often gives).
 */
export function stripJsonName(raw) {
    const text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

    if (text.startsWith('{')) {
        try {
            const parsed = JSON.parse(text);
            const v = parsed?.name ?? parsed?.label ?? parsed?.region;
            if (typeof v === 'string') return v;
        } catch (_) { /* fall through to the fragment rules */ }
    }

    // A key-value pair anywhere: preamble, trailing text, or a missing closing brace.
    const keyed = text.match(/"(?:name|label|region)"\s*:\s*"([^"]{1,80})"/);
    if (keyed) return keyed[1];

    // A DECAPITATED object, seen from a hosted model:
    //     `": "Physics"}`                  (lost `{"name`)
    //     `name": "Driving Manoeuvres"}`   (lost `{"`)
    // Anchored on the closing brace so it cannot fire on quoted prose.
    if (text.endsWith('}')) {
        const tail = text.match(/:\s*"([^"]{1,80})"\s*,?\s*\}?\s*$/);
        if (tail) return tail[1];
    }

    // Prose: the answer, if any, is on the first line.
    return text.split('\n')[0];
}

// ---- the sweep --------------------------------------------------------------

/**
 * Name every region that has no cached name, on the shared background chain.
 *
 * Fire-and-forget: the atlas request has already answered with medoid labels, and
 * the names appear on the NEXT build, so no request waits on model calls.
 */
export function scheduleRegionNaming(regions, { onNamed = null } = {}) {
    const settings = getAISettings();
    if (!settings.enabled) return null;
    const model = namingModel();
    if (!model) return null;

    const pending = [];
    let exhaustedCount = 0;
    for (const r of regions) {
        if (!r?.members || r.members.length < MIN_NAMEABLE) continue;
        const signature = regionSignature(r.members.map(m => m.id));
        if (getCachedRegionName(signature)) continue;
        // This model has used its attempts here; a different model resets the count.
        if (exhausted(signature, model)) { exhaustedCount++; continue; }
        pending.push({ region: r, signature });
        if (pending.length >= MAX_PER_SWEEP) break;
    }
    if (pending.length === 0) {
        if (exhaustedCount) {
            console.log(`[Atlas] ${exhaustedCount} region(s) unnamed: "${model}" has failed them ${MAX_ATTEMPTS}x. Pick a different naming model in Settings, or name them by hand.`);
        }
        return null;
    }

    return enqueueVectorJob(() => runNamingSweep(pending, model, onNamed));
}

async function runNamingSweep(pending, model, onNamed) {
    const handle = tasks.registerExternal({
        kind: 'atlas',
        label: `Naming ${pending.length} region${pending.length === 1 ? '' : 's'}`,
        cancel: () => { },
    });
    let named = 0;
    let unreachable = 0;
    try {
        for (let i = 0; i < pending.length; i++) {
            const { region, signature } = pending[i];
            // The medoid is passed so the prompt can ask the model to beat it.
            const fallback = cleanRegionLabel(region.members[0]?.title || '');
            let result;
            try {
                result = await nameRegion(region, { fallback, model });
                unreachable = 0;
            } catch (err) {
                // Unavailable may be GONE or just busy/rate-limited, so the batch
                // ends only after consecutive failures (as `tools/quiz-audit.mjs`).
                // Nothing is recorded against the region: the endpoint failed.
                if (isUnavailable(err) && ++unreachable >= MAX_CONSECUTIVE_FAILURES) break;
                continue;
            }
            if (result.label) {
                storeRegionName(signature, result.label, model, region.members.length);
                clearFailure(signature);
                named++;
            } else {
                recordFailure(signature, model, result.reason);
            }
            const percent = Math.round(((i + 1) / pending.length) * 100);
            handle.update({ progress: percent, percent });
        }
        handle.finish();
    } catch (err) {
        handle.fail(err?.message);
    }
    // The atlas cache keys on the topic space, which naming does not touch, so
    // the caller must invalidate it or the new names never reach the map.
    if (named > 0 && typeof onNamed === 'function') {
        try { onNamed(named); } catch (_) { /* a redraw hint may never break a sweep */ }
    }
    return named;
}

export function regionNameStats() {
    try {
        const row = db.prepare("SELECT COUNT(*) c, MAX(created_at) m, SUM(model = 'user') u FROM region_names").get() || {};
        const failed = db.prepare('SELECT COUNT(*) c FROM region_name_failures WHERE attempts >= ?').get(MAX_ATTEMPTS)?.c || 0;
        return { cached: row.c || 0, newest: row.m || null, byUser: row.u || 0, givenUp: failed, model: namingModel() };
    } catch (_) {
        return { cached: 0, newest: null, byUser: 0, givenUp: 0, model: null };
    }
}
