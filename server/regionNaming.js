// Naming the places on the map.
//
// The atlas names a region after its MEDOID — the most central member's own
// title, cleaned of curriculum numbering. That rule is free, deterministic and
// needs no model, which is what makes the map a map rather than a picture, and
// for a region that genuinely is one topic it is exactly right.
//
// It has one structural ceiling: the name can only ever be one member's title.
// Measured on the real 1822-topic library, that is wrong in a specific and
// systematic direction — it names a DISCIPLINE after one lesson inside it:
//
//     "Mandarin Chinese"        (53) = Japanese, French, Cyrillic, sociolinguistics → Languages
//     "Sociology"               (55) = psychology, geography, economics, journalism → Social sciences
//     "Thermodynamics and Heat" (41) = forces, energy, Kirchhoff, capacitors        → Physics
//     "Pharmacology"            (40) = anatomy, nursing, PET scans, drug categories → Health & medicine
//
// No member of the languages region is titled "Languages", so no tuning of
// `pickLabel` or `labelPenalty` can reach it — and `labelPenalty` is blind to
// this by construction, because it scores a title's SHAPE (digits, length)
// while the defect is its SCOPE. "Mandarin Chinese" is a well-formed name. It
// is just the name of one language, printed across a continent.
//
// So naming gets a model, and everything else about the map stays without one:
//
//   - This is an ENRICHMENT, never a step in drawing. No model reachable, no
//     name cached, model returns junk → the medoid label stands and the map is
//     byte-identical to before this module existed. Same degradation contract
//     as every other AI feature here.
//   - Names are CACHED BY MEMBER SET, not by region index. Regions renumber
//     whenever the library grows, so an index-keyed cache would silently move
//     names between places. A region whose membership has not changed keeps its
//     name across every rebuild, which is how determinism survives in practice.
//   - The MODEL IS NOT PART OF THAT KEY. It was, borrowed from the
//     `node_embeddings` sidecar where it is mandatory — two models' vector
//     spaces are incomparable, so a vector from the wrong one is simply wrong.
//     A name is not a vector. It is validated prose about a list of titles, and
//     one written by a different model is not invalid, only written by a
//     different model. The cost of the stricter rule was measured the day the
//     learner switched chat model for unrelated reasons: 91 of 115 regions on
//     the real library held a good name ("Physics", "Life Sciences",
//     "Mathematics") that the map could no longer see, so every bubble on it
//     fell back to the medoid the whole module exists to replace. The model is
//     still RECORDED, as provenance and so a failure can be blamed on it.
//   - The naming model is CHOOSABLE (`atlas_naming_model`), because it is not
//     the same job as chat. A four-word noun phrase wants a fast instruct
//     model; measured head to head on the same 123 regions, qwen3.5:9b named
//     59 of 60 attempted and a reasoning-first hosted model named 5 — it spent
//     the timeout deliberating and answered "Eurasia" where the 9B answered
//     "Languages". Empty = follow the chat model, which is the old behaviour.
//   - A FAILURE IS RECORDED (`region_name_failures`). Writing no name on a
//     failure is right for a model that was briefly unreachable and wrong for
//     one that cannot do this at all: with nothing recorded, every atlas build
//     re-queued the same regions against the same model and stored nothing,
//     forever, one press of Redraw at a time. Attempts are counted per region
//     and per model, so switching models clears the way for a fresh try.
//   - It runs on the ONE shared background chain (`enqueueVectorJob`), not a
//     new one — same reasoning as `nodeEmbeddings.js`: a local model is usually
//     single-slot, so a second chain would not add throughput, it would
//     interleave a naming sweep into the middle of a big PDF upload.
//   - Every returned name is MECHANICALLY VALIDATED before it is stored. A
//     local model asked for a short noun phrase will sometimes answer with a
//     sentence, a number, or a markdown heading; `validateName` is what keeps
//     that off the map, and it is pure so `tools/atlas-gates.mjs` can assert it.
//
// The honest limitation, measured rather than assumed: a generated name will
// also confidently name an INCOHERENT region. Cohesion cannot be used to gate
// this — across the real library's 44 sizeable regions it spans only
// 0.766–0.936 (median 0.815) and sorts the wrong way, with a genuine junk
// drawer (25 driving topics + 7 physics + 2 VC history) scoring 0.804, ABOVE
// the perfectly coherent "Sociology" at 0.786. There is no threshold to find.
// A bad name currently exposes a bad region and a plausible one will hide it;
// the region's project mix, which the UI already shows, is the remaining
// signal. Do not add a cohesion gate here without re-measuring first.

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
 * A region of ONE topic is that topic, and its own title is the best name it
 * can have — there is nothing for a model to generalise over. Everything above
 * that is nameable, including the two- and three-topic regions a deep, narrow
 * curriculum fragments into: those are exactly where the medoid rule prints a
 * chapter heading ("PaloAltoDelivery.com", "Graham's Legacy") as a place name.
 * The old floor of 4 left 23 of the real library's 115 regions in that state.
 */
const MIN_NAMEABLE = 2;
/** Bound one sweep so a fresh library cannot occupy the chain indefinitely. */
const MAX_PER_SWEEP = 60;
/** Consecutive endpoint failures before a sweep gives up on the batch. */
const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * How many times one model may fail to name one region before the map stops
 * asking. Three, and then only a different model (or the learner's own rename)
 * gets another go — a region that fails three times is failing for a reason the
 * fourth call will not fix, and the cost of asking anyway is paid on every
 * single build.
 */
const MAX_ATTEMPTS = 3;
/** The setting naming its own model. Empty = follow the chat model. */
const NAMING_MODEL_SETTING = 'atlas_naming_model';
/** Recorded in `model` for a name the learner typed. No sweep may overwrite it. */
export const USER_MODEL = 'user';

/**
 * Which model names regions.
 *
 * Its own setting, because naming is not the same job as chat. A four-word noun
 * phrase wants a fast instruct model; measured head to head on the same 123
 * regions, qwen3.5:9b named 59 of the 60 it attempted and a reasoning-first
 * hosted model named 5 — it spent the timeout deliberating and answered
 * "Eurasia" for a region of Ukrainian, Japanese, French and Cyrillic where the
 * 9B answered "Languages" in one shot. Empty = follow the chat model, which is
 * the behaviour this had before the setting existed.
 */
export function namingModel() {
    let configured = '';
    try {
        configured = (db.prepare('SELECT value FROM settings WHERE key = ?').get(NAMING_MODEL_SETTING)?.value || '').trim();
    } catch (_) { }
    return configured || getAISettings().model;
}

/**
 * Names that describe any region and therefore describe none. Rejected so the
 * medoid stands instead — it is narrower than the region, which is a smaller
 * error than a name that is wider than the whole library.
 */
const GENERIC_NAMES = new Set([
    'general knowledge', 'general studies', 'general topics', 'general',
    'miscellaneous', 'various topics', 'various', 'assorted topics', 'other',
    'mixed topics', 'knowledge', 'topics', 'subjects', 'learning', 'education',
    'study', 'studies', 'academics', 'academic subjects', 'school subjects',
    'course content', 'curriculum', 'coursework', 'lessons', 'material',
]);

/**
 * Not a bad name — not a name at all.
 *
 * A generic name (above) is a real English phrase that is merely too wide; this
 * is a language's word for "there is nothing here", and a map is the last place
 * it belongs. Measured on the real library: `minimax/minimax-m3:free` answered
 * `{"name": "undefined"}` — well-formed JSON, one word, no digits, no
 * punctuation, so it cleared every other rule — for EIGHT regions, and because
 * the cache is keyed on the member set and nothing else, each of those was
 * "undefined" on the map permanently. Nothing would ever have asked again.
 *
 * The asymmetry that governs the whole validator applies here at its sharpest:
 * rejecting one of these costs the medoid, which is a real topic's real title.
 */
const PLACEHOLDER_NAMES = new Set([
    'undefined', 'null', 'nil', 'none', 'nan', 'n/a', 'na', 'nothing', 'empty',
    'unknown', 'untitled', 'unnamed', 'no name', 'name', 'label', 'region',
    'string', 'todo', 'tbd', 'placeholder', 'error', 'value',
]);

// ---- cache ------------------------------------------------------------------

/**
 * A region's identity is its member set, and nothing else — not the region
 * index (regions renumber as the library grows) and not the model that wrote
 * the name.
 *
 * The model USED to be in this key, borrowed from the `node_embeddings`
 * sidecar, where it is mandatory: two models' vector spaces are incomparable,
 * so a vector from the wrong one is simply wrong. A name is not a vector. It is
 * validated prose about a list of titles, and one written by a different model
 * is not invalid, only written by a different model. The cost of the stricter
 * rule was measured the day the learner switched chat model for reasons that
 * had nothing to do with the atlas: 91 of the real library's 115 regions held a
 * good name — "Physics", "Life Sciences", "Mathematics", "Japanese Learning" —
 * that the map could no longer see, so every bubble fell back to the medoid
 * this module exists to replace.
 *
 * The `\0` separator is written as the escape, never as a literal control byte
 * — a literal one makes grep treat this file as binary and silently drop its
 * matches from every repo-wide search.
 */
export function regionSignature(memberIds) {
    const ids = [...memberIds].map(Number).sort((a, b) => a - b).join(',');
    return crypto.createHash('sha256').update(`region\0${ids}`).digest('hex');
}

/**
 * The key names used to be hashed with, kept ONLY so rows written under it can
 * be adopted. Every name in an existing library is stored that way and a hash
 * is one-way, so without this, fixing the key would throw away exactly the
 * names the fix exists to recover.
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
 * Re-key one region's name from the old model-bearing hash, if it has one.
 * A one-time rewrite per region, on first read. The old row is left where it
 * is: it costs a few hundred bytes, and deleting it would make a downgrade lose
 * every name a second time.
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
 * Re-judge a cached name against TODAY'S rules, and evict it if it no longer
 * passes.
 *
 * The cache key is the member set alone, which is what lets an unchanged region
 * keep its name while the library moves around it — and is also why a name
 * written before a rule existed is permanent: the region has a name, so the
 * sweep never queues it, so nothing ever asks again. The same trap `feed_items`
 * and `widget_builds` have, and the same answer: a gate change has to reach the
 * rows already in the cache or it only governs libraries that do not exist yet.
 *
 * Evicting rather than merely ignoring is the point — the row going away is
 * what puts the region back in the naming queue on the next sweep. The failure
 * record is cleared with it, so the model that wrote the bad name gets its
 * three attempts back rather than inheriting a count from a different rule.
 *
 * A name the LEARNER typed is never re-judged: `validateUserName` is
 * deliberately looser (digits are theirs to use), so running it through the
 * model validator would delete their own words, and the alternative to a
 * person's name is nothing they asked for.
 */
function keepCachedName(signature, label) {
    try {
        if (nameModelFor(signature) === USER_MODEL) return true;
        if (validateName(label).ok) return true;
        db.prepare('DELETE FROM region_names WHERE signature = ?').run(signature);
        clearFailure(signature);
        return false;
    } catch (_) {
        // A name we cannot re-check is a name we keep: the map going on saying
        // what it said yesterday beats it going blank because SQLite hiccuped.
        return true;
    }
}

// ---- failures ---------------------------------------------------------------

/**
 * Has this model already had its chances at this region?
 *
 * Per MODEL, not per region, because the whole reason to record a failure is
 * that some models cannot do this job at all — a different one deserves a clean
 * slate rather than inheriting the previous one's verdict.
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
 * A name the learner typed.
 *
 * This is a map of THEIR library, and one edit settles an argument that no
 * amount of prompt tuning can. It is stored in the same cache under the same
 * member-set key, marked `model = 'user'` so it is visibly not the model's
 * work — a sweep would skip it regardless, since a sweep only ever fills
 * regions that have no name at all.
 *
 * Validation is deliberately LOOSER than `validateName`. That one is strict
 * because the alternative to a model's answer is the medoid we already had; the
 * alternative to a person's answer is nothing they asked for. Digits are theirs
 * to use, and only the shapes that would break the map — nothing at all, a
 * paragraph, markup — are refused.
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
 * Hand one region back to the map. The row goes entirely rather than reverting
 * to whatever a model last said: "automatic" means the medoid now and a fresh
 * model name on the next sweep, which is what a reset is asked for.
 */
export function clearRegionName(signature) {
    try { db.prepare('DELETE FROM region_names WHERE signature = ?').run(signature); } catch (_) { }
    clearFailure(signature);
}

/**
 * Two places on one map may not share a name.
 *
 * Each region is named on its own — it has to be, because the cache key is the
 * region's own member set and nothing else, which is what lets an unchanged
 * region keep its name while the library around it changes. The cost is that
 * nothing stops two regions being handed the same name, and the real library
 * produced exactly that: "Practical Driving Skills" on both a 45-topic and a
 * 35-topic region. A reader cannot tell those apart, and worse, cannot tell
 * that they are different places at all.
 *
 * Resolved at READ time rather than at naming time, which keeps it free of
 * sweep order: the LARGEST region keeps the contested name and the others fall
 * back to their medoid, ties broken by region index. Both inputs come from a
 * deterministic build, so the same library resolves the same way every time.
 *
 * Deliberately EXACT matches only. "Engineering" beside "Engineering
 * Disciplines" is two neighbouring regions honestly describing themselves, and
 * a near-match rule strict enough to catch it would also collapse
 * "Japanese Language" into "Japanese Language Learning" — which are, in this
 * library, genuinely different regions.
 *
 * Pure, so `tools/atlas-gates.mjs` can assert it without a DB or a model.
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
 * Pure, and deliberately strict: rejecting a good name costs the medoid, which
 * is the name we already had, while accepting a bad one writes it onto the map
 * until the region's membership changes. The asymmetry is the whole argument.
 *
 * @returns {{ok: true, label: string} | {ok: false, reason: string}}
 */
export function validateName(raw) {
    if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' };

    let s = raw.trim()
        // Models hand back a heading, a bullet, a quoted string or a
        // "Name: X" label roughly as often as they hand back the bare phrase.
        .replace(/^#+\s*/, '')
        .replace(/^[-*•]\s*/, '')
        .replace(/^(?:name|label|region|answer)\s*[:—-]\s*/i, '')
        .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
        .replace(/[.。]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();

    // The same numbering rule the rest of the map uses, so a model that echoes
    // a curriculum-numbered title still lands clean.
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
    // A name that would fit anywhere names nothing. Rule 7 of the prompt asks
    // for the broadest HONEST shared subject and a model reaches past it about
    // one region in sixty — measured: a 20-topic region of organic chemistry,
    // materials and lab technique came back as "General Knowledge", which is
    // strictly worse than the medoid it replaced ("Organic Chemistry Basics"),
    // because the medoid at least names something that is in there.
    if (PLACEHOLDER_NAMES.has(s.toLowerCase())) return { ok: false, reason: 'placeholder' };
    if (GENERIC_NAMES.has(s.toLowerCase())) return { ok: false, reason: 'generic' };

    return { ok: true, label: s };
}

// ---- naming -----------------------------------------------------------------

/**
 * The language a region should be named in.
 *
 * A region's members can span projects, so there is no single declared
 * language — the DOMINANT project's is the only defensible choice, and an
 * unset one means "follow the material", which is the pre-existing behaviour.
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
 * Cosine to the region's own centroid. Both sides are unit vectors (topic
 * vectors are normalised on write), so the dot product IS the cosine — the same
 * assumption the atlas makes, restated here rather than imported, because
 * `atlas.js` imports THIS module and a cycle between them would be a link-time
 * failure that `node --check` cannot see.
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
 * Name one region. Returns the validated label, or null for every failure —
 * an unreachable model, a refusal and a malformed answer are all "keep the
 * medoid", which is why nothing here throws.
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
        // Unavailable is not a verdict, and the two must not be confused. An
        // endpoint that was busy or briefly gone says nothing about whether this
        // region can be named, so it is re-thrown for the sweep's consecutive
        // counter and NOTHING is recorded against the region — the same trap as
        // an empty-hash embedding batch, or the transfer sweep that withdrew
        // every head start when it could not see the topic space.
        if (isUnavailable(err)) throw err;
        return { label: null, reason: `call-failed: ${String(err?.message || err).slice(0, 120)}` };
    }

    const verdict = validateName(stripJsonName(raw));
    // The rejection REASON travels back so a region that keeps failing can be
    // stopped, and so the learner reading the region card is told which of the
    // two things happened: the model was never asked, or it answered badly.
    return verdict.ok ? { label: verdict.label, reason: null } : { label: null, reason: verdict.reason };
}

/**
 * Accept both shapes a model answers this in: a bare phrase, or the JSON object
 * the prompt asks for. Asking for JSON and then only accepting JSON would throw
 * away a correct one-line answer, which is what a small local model gives.
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

    // A whole key-value pair anywhere in the text. Catches a trailing
    // explanation, a leading preamble, and an object missing its closing brace.
    const keyed = text.match(/"(?:name|label|region)"\s*:\s*"([^"]{1,80})"/);
    if (keyed) return keyed[1];

    // A DECAPITATED object — the value survived but the opening did not.
    // Observed from a hosted model on the real endpoint, twice in six calls and
    // with a different amount missing each time:
    //     `": "Physics"}`                  (lost `{"name`)
    //     `name": "Driving Manoeuvres"}`   (lost `{"`)
    // The name in each was correct and the old code threw all three away,
    // which is what took a sweep from 59 names to 5. Anchored on the closing
    // brace so this cannot fire on ordinary prose that happens to be quoted.
    if (text.endsWith('}')) {
        const tail = text.match(/:\s*"([^"]{1,80})"\s*,?\s*\}?\s*$/);
        if (tail) return tail[1];
    }

    // A model that ignored the format and wrote a line of prose: take the first
    // line, which is where the answer is when there is one.
    return text.split('\n')[0];
}

// ---- the sweep --------------------------------------------------------------

/**
 * Name every region that has no cached name, on the shared background chain.
 *
 * Fire-and-forget: the caller is the atlas request, which has already answered
 * with medoid labels. The names land in the cache and appear on the NEXT build,
 * which is the same "runs ahead of the reader" arrangement `feedGen` uses for
 * widgets, and for the same reason — the alternative is a request that waits on
 * 120 model calls.
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
        // This model has already had its three goes at this region. Asking a
        // fourth time is what turned every atlas build into sixty model calls
        // that stored nothing; a different model resets the count.
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
            // The medoid title is passed in so the model can be told what the
            // map says today and asked to beat it — a name that merely restates
            // the most central member is the outcome we already have.
            const fallback = cleanRegionLabel(region.members[0]?.title || '');
            let result;
            try {
                result = await nameRegion(region, { fallback, model });
                unreachable = 0;
            } catch (err) {
                // "Unavailable" covers two different things and they need
                // different answers: an endpoint that is GONE, where continuing
                // burns the batch against nothing, and one that is momentarily
                // busy or rate-limited, which a hosted free tier does routinely
                // and a single-slot local server does whenever something else
                // holds it. Breaking on the first of those cost a real sweep 118
                // of 123 regions. So the batch ends only once the endpoint has
                // failed CONSECUTIVELY — the same rule `tools/quiz-audit.mjs`
                // uses before it will call a batch unreachable. Nothing is
                // recorded against the region either way: the endpoint failed,
                // the region did not.
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
    // The names are in the cache; the MAP is not. The atlas is cached against a
    // signature of the topic space, which a naming sweep does not touch — so
    // without this the names sat in SQLite and the map went on drawing medoids
    // until the library itself changed or the learner pressed Redraw. "It
    // appears on the next build" is only true if something forces a build.
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
