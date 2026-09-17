// server/atlas.js — the library as ONE space instead of N trees.
//
// Every other cross-project view in this app is organised by time (the feed,
// the calendar, the schedule board) or by container (the projects grid). None
// of them can answer the question a self-directed learner running six courses
// actually has: *what do I know?* — and its corollary, *where am I studying the
// same thing twice?*
//
// The topic vectors from server/nodeEmbeddings.js make that answerable, and
// this module turns them into something a person can look at:
//
//   • **Regions** — topics grouped by meaning rather than by which course they
//     came from, so "waves" is one place on the map even when three curricula
//     teach it. Each region is named after its most central topic, which is a
//     deterministic choice: no model is called to label the map, so the same
//     library always draws the same atlas.
//   • **A layout** — regions placed by PCA of their centroids, so distance on
//     screen approximates distance in meaning. Two components out of hundreds
//     is a lossy projection and the UI says so; what survives it is the coarse
//     structure, which is all a map needs to be useful.
//   • **Bridges** — cross-project pairs that mean the same thing. This is the
//     actionable half: a bridge from a proven topic is a head start waiting
//     (see server/masteryTransfer.js), and a bridge between two unproven ones
//     is duplicated work ahead.
//
// Everything is derived from vectors that already exist, so building the atlas
// costs **zero model calls**. It is CPU work over a few thousand short arrays,
// which is why it yields to the event loop while it runs (a 3000-topic library
// would otherwise stall every SSE stream on the box for a second or two) and
// why the result is cached against a signature of the topic space.
//
// Degrades like every vector feature here: no sqlite-vec, no embedding model,
// or nothing indexed yet, and the atlas reports `available: false` with a
// reason the UI can show — never an error, never a half-drawn map.

import db, { vecAvailable } from './database.js';
import { embeddingReady, vecTableExists, getEmbeddingConfig } from './embeddings.js';
import { TRANSFER_MIN_SIMILARITY } from './masteryTransfer.js';
import { cleanRegionLabel } from './curriculumLabel.js';
import { TOPIC_NODE } from './nodeRole.js';
import { cachedNamesFor, scheduleRegionNaming, regionSignature, nameModelFor, USER_MODEL } from './regionNaming.js';
import {
    dot, normalizeInto, powerIteration, deflate, nearestNeighbours,
    INK_SHARE, LAYOUT_NEIGHBOURS, LAYOUT_ANCHOR as ANCHOR, LAYOUT_BUDGET,
    LAYOUT_MIN_ITERATIONS, LAYOUT_MAX_ITERATIONS,
} from './vectors.js';
import { globeLayout } from './globe.js';

export { cleanRegionLabel };

// The similarity at which two topics belong to the same region is NOT a
// constant, because it is a property of the embedding model, and the user picks
// that. A threshold tuned to nomic-embed-text produces one region per topic on
// a model whose vectors sit closer together — which is not just an ugly map, it
// is quadratic: leader clustering costs O(topics × regions), so a threshold
// that refuses to group anything makes regions ≈ topics and the build goes from
// under a second to twenty. Measured, not theorised (see the perf probe in the
// commit that introduced this).
//
// So the threshold is DERIVED from the library's own distribution of
// nearest-neighbour similarities: whatever the model, half the topics have a
// neighbour at least this close. Clamped, because a pathological library should
// still produce something sane, and overridable per request.
// Which percentile of that distribution to sit at — and it must be a LOW one.
// The intuition pulls the other way: the median looks like the natural choice,
// and it is exactly wrong. A topic joins a region only if its nearest neighbour
// clears the threshold, so putting the threshold at the median guarantees that
// HALF the library has no neighbour close enough and becomes a region of one.
// Observed directly: on a fixture with six clean subjects, the median produced
// thirteen regions of which eight were singletons, with thermodynamics split
// four ways. At the 20th percentile roughly four topics in five have somewhere
// to go, which is what makes the map a map instead of a scatter of labels.
const NN_PERCENTILE = 0.2;
const MIN_REGION_SIMILARITY = 0.55;
const MAX_REGION_SIMILARITY = 0.92;
// Regions whose centroids end up this close, relative to the region threshold,
// are the same region reached from two directions.
const MERGE_MARGIN = 0.06;
// The sample used to choose the threshold and seed the regions. Pairwise work
// on the sample is quadratic, so this is the one number that bounds it.
const SAMPLE_SIZE = 600;
// Two ceilings, because they bound different things.
//
// `MAX_SEED_REGIONS` is the cost bound: every topic is compared against every
// seed twice, so this is the factor that keeps the global pass linear-ish and
// is what stops a library that refuses to cluster from going quadratic.
//
// `MAX_REGIONS` is the legibility bound on the finished map. It can be higher
// than the seed cap because subdivision is LOCAL — a region's members are only
// ever re-compared against that region's own parts — so the extra regions cost
// a fraction of what raising the seed cap would.
const MAX_SEED_REGIONS = 120;
const MAX_REGIONS = 240;

// ---- the dumping ground, and why regions get split --------------------------
//
// The assignment pass puts every topic in its NEAREST region, with no floor on
// how near that has to be — which is correct (a topic must be somewhere) and is
// also how one region becomes a landfill. Measured on a real 1885-topic
// library: one region held **583 topics from 8 projects** — Linux exploitation,
// Y-Combinator history, C# data binding and Japanese kana in the same place —
// because every topic that matched nothing landed in whichever centroid was
// marginally closest. Its own members told the story: the region threshold was
// 0.73 and a quarter of its members sat below 0.71 from the centroid. The map
// drew it as one huge bubble labelled "Module 9.5: Advanced Extensions and
// Specializations", which is worse than useless — it is a wrong answer to
// "what do I know?" drawn convincingly.
//
// So a region that is too big OR too loose is **subdivided**, recursively,
// using a threshold derived from its OWN members (necessarily higher than the
// library-wide one, since these topics already cleared that bar). Subdivision
// is local — members × sub-regions — so it costs a fraction of a global
// re-cluster, and it bottoms out naturally: material that genuinely belongs
// together refuses to split and is left alone.
const REGION_SIZE_SHARE = 0.035;   // no region may hold more than this share…
const MIN_SPLIT_SIZE = 24;         // …but never split below this many topics
// A region is also split when its own members disown it: the Nth percentile of
// member-to-centroid similarity falling below the threshold that was supposed
// to define the region means the tail was assigned by proximity, not by fit.
const COHESION_PERCENTILE = 0.2;
const COHESION_MARGIN = 0.015;
const SPLIT_ROUNDS = 6;
const SPLIT_MAX_PARTS = 24;
// `INK_SHARE` — how much of the canvas the bubbles cover — is in `vectors.js`
// with the rest of the layout's tuned numbers, shared with the globe.
const MIN_RADIUS = 0.012;
const MAX_RADIUS = 0.2;
// A region below this size is real but not a landmark: it is drawn and listed,
// just not labelled on the map, the way a map labels cities and not hamlets.
const LANDMARK_MIN_SIZE = 3;
const MAX_BRIDGES = 40;
const MERGE_ROUNDS = 6;
// Bridge-hunting is pairwise inside a region. A region of 3000 topics would be
// 4.5M comparisons of 768-float vectors — so on an oversized region only the
// most central members are compared. Bridges are a top-N list of the strongest
// matches anyway; the pairs this can miss are the peripheral ones, which would
// not have made the list.
const BRIDGE_SCAN_CAP = 300;
const YIELD_EVERY = 400;       // topics processed between event-loop yields

const nextTick = () => new Promise(resolve => setImmediate(resolve));

// ---- loading ----------------------------------------------------------------

/**
 * Every mapped topic with the metadata the atlas paints onto it. Ordered by id
 * so the whole build is deterministic: region assignment is a single pass and
 * would otherwise depend on SQLite's row order.
 */
async function loadTopics({ includeArchived = false } = {}) {
    const rows = db.prepare(`
        SELECT n.id, n.title, n.status, n.project_id, n.parent_id,
               -- Normalised here rather than read raw, for the reason
               -- server/today.js normalises the same column: a 'T' sorts after
               -- a space, so a library holding both spellings would order the
               -- journey by storage format instead of by when things happened.
               -- strftime answers NULL on anything it cannot parse, which is
               -- the same answer as "never finished" and is handled as such.
               strftime('%Y-%m-%dT%H:%M:%SZ', n.completed_at) AS completed_iso,
               p.name AS project_name, p.color AS project_color,
               -- When the COURSE began, which is not when its first topic was
               -- closed: the gap between the two is the run-up, and the paths
               -- panel draws it as the lead-in to the journey.
               --
               -- The EARLIER of the two dates a project has, not the scheduled
               -- one: on the real library that start date is a plan made after
               -- the work had already started (one course is scheduled from
               -- 7 July and its first topic was closed on 24 June), and a
               -- timeline that began at the plan would crop a fortnight of the
               -- learner's own record off its left-hand end. A deck has no
               -- start date at all and still began somewhere.
               --
               -- Normalised through strftime for the same reason completed_at
               -- is: YYYY-MM-DD and YYYY-MM-DD HH:MM:SS are both in these
               -- columns, and only one of them is a date every browser's Date
               -- will parse. String MIN is safe across the two spellings —
               -- a bare date sorts before the same day with a time on it,
               -- which is midnight sorting before the morning.
               strftime('%Y-%m-%dT%H:%M:%SZ', MIN(
                   COALESCE(p.start_date, p.created_at),
                   COALESCE(p.created_at, p.start_date))) AS project_start,
               COALESCE(nm.mastery_score, 0) AS mastery,
               COALESCE(nm.total_attempts, 0) AS attempts,
               nm.transferred_prior
        FROM vec_nodes v
        JOIN nodes n ON n.id = v.rowid
        JOIN projects p ON p.id = n.project_id
        LEFT JOIN node_mastery nm ON nm.node_id = n.id
        WHERE n.is_note = 0
          ${includeArchived ? '' : `AND COALESCE(p.status, 'active') != 'archived'`}
          -- A slice cut out of a deck's card order is PAGINATION, not a topic:
          -- "Stage 1".."Stage 30" is thirty near-identical strings, which embed
          -- to thirty near-identical vectors and form an artificially tight
          -- region named after one of them. Measured on the real library: a
          -- 33-topic bubble labelled "Stage 28" at cohesion 0.936, outside the
          -- 0.766-0.83 band every real region sits in, and it had swallowed 3
          -- genuine topics from another project on the way.
          --
          -- The test used to be "is this project a deck", which also excluded
          -- the subdecks the deck's AUTHOR named — 32 real topics in the
          -- one imported deck, 6 in another, measured 2026-09-09 — from a map
          -- of what the learner knows. It is per node now (server/nodeRole.js).
          AND ${TOPIC_NODE}
        ORDER BY n.id
    `).all();

    // vec0 hands the vector back as a float32 blob, one row at a time: reading
    // the column through the JOIN above is not dependable across sqlite-vec
    // builds, and a per-row lookup on a rowid PK is cheap enough.
    //
    // The blob MUST be copied out rather than viewed in place. better-sqlite3
    // returns a Buffer over Node's shared pool, whose byteOffset is arbitrary,
    // and a Float32Array view demands a 4-byte-aligned offset — so viewing it
    // directly throws a RangeError on whichever rows happen to land unaligned,
    // which is a bug that appears and disappears with unrelated allocations.
    const vecStmt = db.prepare('SELECT embedding FROM vec_nodes WHERE rowid = ?');
    const out = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const raw = vecStmt.get(r.id)?.embedding;
        if (!Buffer.isBuffer(raw) || raw.byteLength < 4 || raw.byteLength % 4 !== 0) continue;
        const copy = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        out.push({ ...r, vec: new Float32Array(copy) });
        // Thousands of point lookups plus a copy each is the single longest
        // uninterrupted stretch in the whole build — measured at ~200ms, which
        // is 200ms of frozen SSE for everyone else on the box.
        if (i % YIELD_EVERY === YIELD_EVERY - 1) await nextTick();
    }
    return out;
}

// ---- lineage: the course's own shape, carried onto the map ------------------
//
// The atlas dissolves courses on purpose — a topic sits where its MEANING puts
// it, not where its curriculum filed it — and that is exactly what makes the
// question "so how do I actually get through this course?" unanswerable on the
// map as drawn. The regions say what the library is about; nothing says how one
// course threads through them, and nothing says where the learner has already
// been.
//
// Both are the same missing datum: the parent link, and when the topic was
// finished. They ride along on each topic rather than arriving as a separate
// graph, because every coordinate the lines need is already on the topic — the
// client draws between points it already holds.
//
// The parent recorded here is the nearest MAPPED ancestor, not `parent_id`.
// A chapter heading can be absent from the map for three ordinary reasons (it
// is a note, it is a deck's pagination slice, its vector has not been written
// yet), and an edge to a node with no coordinates is an edge that cannot be
// drawn. Walking up to the nearest ancestor that IS on the map keeps the course
// connected through the gap instead of shattering it into orphans.
const MAX_ANCESTOR_HOPS = 64;

/**
 * `{ parentId, depth }` per mapped topic, keyed by topic id.
 *
 * `depth` counts MAPPED ancestors, so it is the depth of the drawn tree rather
 * than of the stored one — the number the renderer needs when it wants a trunk
 * to read heavier than a twig.
 *
 * @param {{id:number, parent_id:number|null}[]} topics the mapped set
 */
export function resolveLineage(topics) {
    const mapped = new Set(topics.map(t => t.id));
    // The whole tree, not just the mapped part: an unmapped ancestor still has
    // to be walked THROUGH to find the mapped one above it. One query over a
    // two-column table, which is cheaper than a recursive CTE per topic.
    const parentOf = new Map();
    for (const r of db.prepare('SELECT id, parent_id FROM nodes').all()) {
        parentOf.set(r.id, r.parent_id ?? null);
    }

    const lineage = new Map();
    for (const t of topics) {
        let parentId = null;
        let depth = 0;
        let cur = t.parent_id ?? null;
        // The hop cap is a cycle guard, not a depth limit. `parent_id` is a
        // self-referential FK with nothing in the schema forbidding a loop, and
        // a loop here is an infinite one in a request handler.
        for (let hops = 0; cur != null && hops < MAX_ANCESTOR_HOPS; hops++) {
            if (mapped.has(cur)) {
                if (parentId == null) parentId = cur;
                depth++;
            }
            cur = parentOf.get(cur) ?? null;
        }
        lineage.set(t.id, { parentId, depth });
    }
    return lineage;
}

// ---- regions ----------------------------------------------------------------

/**
 * A stratified sample of the library. Strided rather than random so it is
 * deterministic, and strided over an id-ordered list so every project is
 * represented — taking the first N would seed the map entirely from whichever
 * course happens to be oldest.
 */
function sample(topics, size) {
    if (topics.length <= size) return topics;
    const stride = topics.length / size;
    const out = [];
    for (let i = 0; i < size; i++) out.push(topics[Math.floor(i * stride)]);
    return out;
}

/**
 * Pick the similarity at which topics count as "the same area", from the
 * library itself: the Nth percentile of every sampled topic's similarity to its
 * nearest neighbour. Whatever the embedding model's absolute scale, roughly
 * half of topics have a neighbour at least this close — so the map has real
 * regions on a model whose vectors bunch at 0.9 and on one that spreads them
 * over 0.2, without either being hardcoded.
 */
async function deriveThreshold(sampled, percentile = NN_PERCENTILE) {
    if (sampled.length < 4) return MIN_REGION_SIMILARITY;
    const nn = [];
    for (let i = 0; i < sampled.length; i++) {
        let best = -Infinity;
        for (let j = 0; j < sampled.length; j++) {
            if (i === j) continue;
            const s = dot(sampled[i].vec, sampled[j].vec);
            if (s > best) best = s;
        }
        nn.push(best);
        if (i % 64 === 63) await nextTick();
    }
    nn.sort((a, b) => a - b);
    const t = nn[Math.min(nn.length - 1, Math.floor(nn.length * percentile))];
    return Math.max(MIN_REGION_SIMILARITY, Math.min(MAX_REGION_SIMILARITY, t));
}

function newRegion(t, dim) {
    const sum = new Float64Array(dim);
    for (let d = 0; d < dim; d++) sum[d] = t.vec[d];
    return { sum, centroid: Float32Array.from(t.vec), members: [t] };
}

function recentre(region, dim) {
    const c = new Float32Array(dim);
    for (let d = 0; d < dim; d++) c[d] = region.sum[d] / region.members.length;
    if (normalizeInto(c)) region.centroid = c;
}

function addMember(region, t, dim) {
    region.members.push(t);
    for (let d = 0; d < dim; d++) region.sum[d] += t.vec[d];
    recentre(region, dim);
}

/**
 * Leader clustering: walk the items once, joining each to the first region it
 * is close enough to and opening a new one when it isn't.
 *
 * Chosen over k-means because the number of subject areas in a library is not
 * known in advance and should not be: asking for k regions invents exactly k of
 * them, including on a library that genuinely has three. Order-sensitive by
 * nature — the callers repair that with a merge pass and a Lloyd iteration —
 * but deterministic, because the item order is.
 *
 * Past `maxParts` the budget is spent and an item joins its nearest region
 * however far away that is. That branch is the one that builds landfills, which
 * is why `subdivide` exists.
 */
function leaderCluster(items, threshold, dim, maxParts) {
    const parts = [];
    for (const t of items) {
        let best = -1, bestSim = -Infinity;
        for (let r = 0; r < parts.length; r++) {
            const sim = dot(t.vec, parts[r].centroid);
            if (sim > bestSim) { bestSim = sim; best = r; }
        }
        if (best >= 0 && bestSim >= threshold) addMember(parts[best], t, dim);
        else if (parts.length < maxParts) parts.push(newRegion(t, dim));
        else if (best >= 0) addMember(parts[best], t, dim);
    }
    return parts;
}

/**
 * One Lloyd pass: re-place every item against the current centroids, then
 * re-centre on what actually arrived. This is where a seed that started on an
 * outlier gets pulled onto the material it attracted.
 */
async function assign(regions, items, dim, yieldEvery = 0) {
    const next = regions.map(r => ({
        sum: new Float64Array(dim),
        centroid: r.centroid,
        members: [],
    }));
    for (let i = 0; i < items.length; i++) {
        const t = items[i];
        let best = 0, bestSim = -Infinity;
        for (let r = 0; r < next.length; r++) {
            const sim = dot(t.vec, next[r].centroid);
            if (sim > bestSim) { bestSim = sim; best = r; }
        }
        const region = next[best];
        region.members.push(t);
        for (let d = 0; d < dim; d++) region.sum[d] += t.vec[d];
        if (yieldEvery && i % yieldEvery === yieldEvery - 1) await nextTick();
    }
    // A region that attracted nothing is not a place on the map.
    const kept = next.filter(r => r.members.length > 0);
    for (const r of kept) recentre(r, dim);
    return kept;
}

/** Member-to-centroid similarity at a percentile — how well a region holds. */
function cohesion(region, percentile) {
    const sims = region.members.map(m => dot(m.vec, region.centroid)).sort((a, b) => a - b);
    return sims[Math.min(sims.length - 1, Math.floor(sims.length * percentile))];
}

/**
 * k seeds spread as widely as possible across a region — Gonzalez's
 * farthest-first traversal, made deterministic by starting from the region's
 * LEAST central member and breaking every tie toward the lowest index.
 *
 * This is the part that had to be got right. The obvious way to split a region
 * is to re-run the same leader clustering with a higher threshold, and it does
 * not work: leader clustering makes the first item a magnet, so a 583-topic
 * landfill came back as a 467-topic landfill plus a shower of singletons — the
 * blob survived, only now the map claimed 160 regions instead of 97. Seeding
 * from the extremes and letting Lloyd pull the boundaries into place divides
 * the blob instead of shaving it.
 */
function farthestFirst(region, k) {
    const members = region.members;
    let first = 0, worst = Infinity;
    for (let i = 0; i < members.length; i++) {
        const s = dot(members[i].vec, region.centroid);
        if (s < worst) { worst = s; first = i; }
    }
    const chosen = [first];
    const taken = new Set(chosen);
    // For every member: how close it is to the NEAREST seed chosen so far.
    const near = members.map(m => dot(m.vec, members[first].vec));
    while (chosen.length < k) {
        let pick = -1, pickSim = Infinity;
        for (let i = 0; i < members.length; i++) {
            if (taken.has(i)) continue;
            if (near[i] < pickSim) { pickSim = near[i]; pick = i; }
        }
        if (pick < 0) break;
        chosen.push(pick);
        taken.add(pick);
        for (let i = 0; i < members.length; i++) {
            const s = dot(members[i].vec, members[pick].vec);
            if (s > near[i]) near[i] = s;
        }
    }
    return chosen.map(i => members[i]);
}

/**
 * Cut one region into several, or return null if it genuinely won't divide.
 *
 * How many parts is not a guess: it is however many the size cap demands, so a
 * region twice the cap becomes two and a region nine times the cap becomes
 * nine. Three Lloyd passes then move the boundaries off the extremes they were
 * seeded from. A region that comes back whole — every member preferring one
 * seed — is coherent material and is left exactly as it was.
 */
async function subdivide(region, dim, cap, maxParts) {
    if (maxParts < 2 || region.members.length < 2) return null;
    const k = Math.min(maxParts, region.members.length, Math.max(2, Math.ceil(region.members.length / cap)));
    let parts = farthestFirst(region, k).map(m => newRegion(m, dim));
    for (let iter = 0; iter < 3; iter++) {
        parts = await assign(parts, region.members, dim);
        if (parts.length < 2) return null;
    }
    await nextTick();
    return parts;
}

/**
 * Break up the landfills. Largest first, so the budget goes where the map is
 * least readable, and bounded by the same region cap as everything else — a
 * library that refuses to cluster must not be able to spend its way past it.
 */
async function splitOversized(regions, dim, threshold, mapped, budget) {
    const cap = Math.max(MIN_SPLIT_SIZE, Math.ceil(mapped * REGION_SIZE_SHARE));
    const tooBig = (r) => r.members.length > cap;
    // "Too loose" is a second, independent reason: a region can sit under the
    // size cap and still be a bag of unrelated things.
    const tooLoose = (r) =>
        r.members.length >= MIN_SPLIT_SIZE
        && cohesion(r, COHESION_PERCENTILE) < threshold - COHESION_MARGIN;

    let out = regions;
    for (let round = 0; round < SPLIT_ROUNDS; round++) {
        if (out.length >= budget) break;
        const order = out
            .map((_, i) => i)
            .filter(i => tooBig(out[i]) || tooLoose(out[i]))
            .sort((a, b) => out[b].members.length - out[a].members.length || a - b);
        if (order.length === 0) break;

        const replacement = new Map();
        let room = budget - out.length;
        for (const i of order) {
            if (room <= 0) break;
            const parts = await subdivide(out[i], dim, cap, Math.min(SPLIT_MAX_PARTS, room + 1));
            if (!parts) continue;
            replacement.set(i, parts);
            room -= parts.length - 1;
        }
        if (replacement.size === 0) break;
        out = out.flatMap((r, i) => replacement.get(i) || [r]);
        await nextTick();
    }
    return out;
}

/**
 * Seed regions, then assign every topic to the nearest one.
 *
 * The seeding pass is leader clustering — chosen over k-means because the
 * number of subject areas in a library is not known in advance and should not
 * be: asking for k regions invents exactly k of them, including on a library
 * that genuinely has three. It runs on the SAMPLE, not the library, which is
 * what bounds it; the assignment pass that follows is linear in topics × seeds
 * and is where the whole library gets placed.
 *
 * Leader clustering is order-sensitive. The merge pass repairs the obvious
 * damage (two seeds describing the same material), and one Lloyd iteration
 * after assignment repairs the rest — a seed that started on an outlier ends up
 * re-centred on the members it actually attracted.
 */
async function buildRegions(topics, threshold) {
    const dim = topics[0]?.vec.length || 0;
    if (dim === 0) return [];

    // --- seeds, from the sample ---
    let seeds = leaderCluster(sample(topics, SAMPLE_SIZE), threshold, dim, MAX_SEED_REGIONS);
    await nextTick();

    // --- merge seeds that describe the same material ---
    // Bounded by MAX_SEED_REGIONS, so this is cheap however big the library is.
    const mergeAt = Math.min(MAX_REGION_SIMILARITY, threshold + MERGE_MARGIN);
    for (let round = 0; round < MERGE_ROUNDS && seeds.length > 1; round++) {
        const absorbed = new Set();
        for (let a = 0; a < seeds.length; a++) {
            if (absorbed.has(a)) continue;
            for (let b = a + 1; b < seeds.length; b++) {
                if (absorbed.has(b)) continue;
                if (dot(seeds[a].centroid, seeds[b].centroid) < mergeAt) continue;
                const A = seeds[a], B = seeds[b];
                A.members.push(...B.members);
                for (let d = 0; d < dim; d++) A.sum[d] += B.sum[d];
                recentre(A, dim);
                absorbed.add(b);
            }
        }
        if (absorbed.size === 0) break;
        seeds = seeds.filter((_, i) => !absorbed.has(i));
        await nextTick();
    }
    if (seeds.length === 0) return { regions: [], seedCapped: false };

    // A library that refuses to cluster spends the seed budget exactly. That is
    // not a failure — every topic is still placed — but the map is then coarser
    // than the material, and it has to say so rather than imply it found 120
    // real subject areas.
    //
    // Measured AFTER the merge pass, not before. Spending the budget and then
    // merging most of it back means the budget was never the binding
    // constraint: this library filled all 120 seeds and merged down to 97, and
    // reporting that as "capped" put a warning about coarse grouping under a
    // map that was nowhere near either ceiling.
    const seedCapped = seeds.length >= MAX_SEED_REGIONS;

    // --- assign the whole library, twice ---
    // Two passes: the first places every topic against seeds drawn from a
    // sample, the second re-places them against centroids computed from the
    // real membership. One Lloyd iteration is where most of the quality is; a
    // full run to convergence costs another second per iteration and moves very
    // little, and a map does not need a local optimum.
    let assigned = seeds;
    for (let iter = 0; iter < 2; iter++) {
        assigned = await assign(assigned, topics, dim, YIELD_EVERY);
        await nextTick();
    }

    // --- break up whatever became a landfill ---
    // This is the pass that makes the difference between a map and a bubble
    // labelled with the first thing that fell into it.
    const regions = await splitOversized(assigned, dim, threshold, topics.length, MAX_REGIONS);
    return { regions, seedCapped };
}

// ---- layout (PCA to 2D) -----------------------------------------------------
//
// The arithmetic — the deterministic power iteration, the deflation, the
// neighbour lists — is `server/vectors.js`, shared with the globe layout so the
// two views are two projections of one method rather than two methods.

/**
 * Place regions in 2D, in two stages: PCA for a starting arrangement, then
 * stress majorisation (SMACOF) against the real distances between regions.
 *
 * PCA alone is the wrong tool for the one claim this map makes. It keeps the
 * two directions of greatest variation and folds away everything else, and in a
 * 768-dimensional embedding space those two directions carry a few percent of
 * the variance — so "close on screen" was only loosely related to "close in
 * meaning", which is the entire contract of the picture. The projection is
 * global and linear: it optimises spread, not neighbourhoods.
 *
 * MDS optimises the thing the map actually promises — it moves regions until
 * the distances BETWEEN them on screen match the distances between their
 * centroids as closely as two dimensions allow. It is still lossy, and the UI
 * still draws no axes, but what survives is now the neighbourhood structure
 * rather than the two widest axes.
 *
 * Affordable because it runs on REGIONS, not topics: a hundred-odd points, so
 * the pairwise matrix is small and bounded by `MAX_REGIONS` either way.
 * Deterministic — PCA seeds it, and PCA is deterministic here (see
 * `powerIteration`'s fixed seed vector), so the same library draws the same map
 * every visit, which is the difference between a map and a picture.
 *
 * Falls back to a ring when there is no variance to project (one region, or
 * every centroid identical), which is a legitimate library, not an error.
 *
 * Exported for `tools/globe-gates.mjs`, which has to compare it against the
 * SPHERE: the globe's whole claim is that a third component carries structure
 * two cannot, and the only way to check a claim about two layouts is to measure
 * both of them on the same centroids.
 */
export function layoutRegions(regions) {
    const k = regions.length;
    const dim = regions[0]?.centroid.length || 0;
    const ring = () => regions.map((_, i) => {
        const a = (2 * Math.PI * i) / Math.max(1, k);
        return k === 1 ? { x: 0, y: 0 } : { x: Math.cos(a) * 0.75, y: Math.sin(a) * 0.75 };
    });
    if (k <= 2 || dim === 0) return ring();

    const mean = new Float64Array(dim);
    for (const r of regions) for (let d = 0; d < dim; d++) mean[d] += r.centroid[d] / k;
    const rows = regions.map(r => {
        const row = new Float64Array(dim);
        for (let d = 0; d < dim; d++) row[d] = r.centroid[d] - mean[d];
        return row;
    });

    const v1 = powerIteration(rows, dim);
    if (!v1) return ring();
    // Deflate along v1 so the second component is genuinely orthogonal to it.
    deflate(rows, v1, dim);
    const v2 = powerIteration(rows, dim);

    const raw = regions.map((r, i) => {
        let x = 0, y = 0;
        for (let d = 0; d < dim; d++) {
            const c = r.centroid[d] - mean[d];
            x += c * v1[d];
            if (v2) y += c * v2[d];
        }
        return { x, y, i };
    });

    // Scale each axis into [-1, 1] independently. Preserving the aspect ratio
    // would waste most of the canvas whenever the second component is weak —
    // which it usually is — and the map carries no units to distort.
    const span = (get) => {
        const vals = raw.map(get);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        return hi - lo < 1e-9 ? null : { lo, hi };
    };
    const sx = span(p => p.x), sy = span(p => p.y);
    if (!sx) return ring();

    const seeded = raw.map(p => ({
        x: ((p.x - sx.lo) / (sx.hi - sx.lo)) * 1.8 - 0.9,
        y: sy ? ((p.y - sy.lo) / (sy.hi - sy.lo)) * 1.8 - 0.9 : 0,
    }));
    return refineLayout(seeded, regions);
}

/**
 * Refine the PCA seed so that regions which are ACTUALLY each other's nearest
 * neighbours end up next to each other on the map.
 *
 * Global MDS was tried here first and measured WORSE than the PCA seed it was
 * supposed to improve (neighbourhood preservation 0.19 against 0.26 on the real
 * library). The reason is a property of the space rather than a bug: in 768
 * dimensions the cosine distances between a hundred region centroids sit in a
 * narrow band, so "match every pairwise distance" asks the layout to place a
 * hundred points nearly equidistant — which in two dimensions is a ring, and a
 * ring destroys exactly the local structure the map is read for. Optimising the
 * average error over all pairs spends the whole budget on the far pairs,
 * because there are quadratically many of them and nobody reads them.
 *
 * So only the NEAR pairs are optimised: each region is pulled toward its few
 * true nearest neighbours, everything else is merely pushed apart enough to
 * stay legible. That is the claim the map actually makes — "next to" means
 * "alike" — and the far distances are left to mean nothing in particular, which
 * is honest, since two dimensions cannot carry them anyway.
 *
 * Deterministic: PCA seeds it, the neighbour lists come from a stable sort, and
 * the step schedule is fixed. Same library, same map, every visit.
 */
// The neighbour count is three, measured rather than chosen, and the iteration
// budget is traded against the region count because the pass is O(n² ·
// iterations) on the request path — both live in `vectors.js` with the
// measurement behind them, shared with the sphere, which refines the same way.

function refineLayout(points, regions) {
    const n = points.length;
    if (n < 4) return points;
    const near = nearestNeighbours(regions, Math.min(LAYOUT_NEIGHBOURS, n - 1));
    // Neighbours should sit about this far apart, non-neighbours no closer.
    // Derived from the point count so a big library does not pack tighter than
    // a small one: n circles of this radius cover a fixed share of the frame.
    const spacing = Math.max(0.06, 1.6 / Math.sqrt(n));
    const pts = points.map(p => ({ x: p.x, y: p.y }));

    const iterations = Math.max(
        LAYOUT_MIN_ITERATIONS,
        Math.min(LAYOUT_MAX_ITERATIONS, Math.round(LAYOUT_BUDGET / (n * n))),
    );
    for (let it = 0; it < iterations; it++) {
        // Cool down, so early passes rearrange and late ones settle.
        const step = 0.6 * (1 - it / iterations) + 0.05;
        const force = pts.map(() => ({ x: 0, y: 0 }));

        for (let i = 0; i < n; i++) {
            // Attraction: toward each true neighbour, to `spacing`.
            for (const { j, sim } of near[i]) {
                const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
                const d = Math.hypot(dx, dy) || 1e-9;
                // Closer in meaning → shorter target, so the ordering among a
                // region's own neighbours survives too, not just the set.
                const target = spacing * (1.4 - Math.max(0, Math.min(1, sim)));
                const pull = ((d - target) / d) * 0.5;
                force[i].x += dx * pull;
                force[i].y += dy * pull;
            }
            // A weak tether to where PCA put this region. PCA is bad at local
            // neighbourhoods and good at the global frame — without the tether
            // the local forces pull the library into two dense clumps with an
            // empty band between them, which is a worse map even though its
            // neighbourhoods score well. Each method does the half it is good
            // at.
            force[i].x += (points[i].x - pts[i].x) * ANCHOR;
            force[i].y += (points[i].y - pts[i].y) * ANCHOR;

            // Repulsion: only from whatever is too close, which is what keeps
            // the arrangement from collapsing into its own centre.
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
                const d = Math.hypot(dx, dy);
                if (d > spacing * 1.6) continue;
                const push = ((spacing * 1.6 - d) / (d || 1e-9)) * 0.35;
                force[i].x += dx * push;
                force[i].y += dy * push;
            }
        }
        for (let i = 0; i < n; i++) {
            pts[i].x += force[i].x * step;
            pts[i].y += force[i].y * step;
        }
    }

    const span = (get) => {
        const vals = pts.map(get);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        return hi - lo < 1e-9 ? null : { lo, hi };
    };
    const sx = span(p => p.x), sy = span(p => p.y);
    if (!sx) return points;
    return pts.map(p => ({
        x: ((p.x - sx.lo) / (sx.hi - sx.lo)) * 1.8 - 0.9,
        y: sy ? ((p.y - sy.lo) / (sy.hi - sy.lo)) * 1.8 - 0.9 : 0,
    }));
}

// Iterations for the WITHIN-region projection. Fewer than the region layout's
// because it runs once per region over the whole library rather than once over
// a few dozen centroids, and because the answer only has to be good enough to
// place a dot inside a circle.
const LOCAL_PCA_ITERATIONS = 20;

const clampUnit = (v) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

/**
 * Place a region's own topics inside its bubble.
 *
 * The map used to stop at regions, which made zooming pointless: the whole
 * library was 97 circles and 1885 topics you could only reach through a list.
 * Topics get the same treatment regions do, one level down — PCA of the member
 * vectors *around their own centroid*, so within a region the axes describe
 * what varies inside THAT material rather than what separates it from the rest
 * of the library. Two topics adjacent inside a bubble are genuinely alike.
 *
 * Falls back to a phyllotaxis spiral when there is nothing to project (one
 * member, or members with no variance between them) — an even packing that
 * claims nothing, which is the correct claim to make about a region whose
 * members are indistinguishable.
 *
 * Two things here are load-bearing and were both wrong, which is what drew a
 * bubble with all of its dots heaped against one wall and empty space opposite:
 *
 *  1. **The projection must be centred on the members' own MEAN, not on
 *     `region.centroid`.** The centroid is the mean *renormalised back onto the
 *     unit sphere* (`recentre`), and since the mean of several distinct unit
 *     vectors is always shorter than one, renormalising pushes it outward past
 *     the cloud it came from. Subtracting it therefore leaves every row carrying
 *     the same nonzero offset — and PCA on uncentred rows finds that offset as
 *     its first component, so the whole region projected to one side of its own
 *     origin. Nothing errored; the map just quietly lied about where things sit.
 *
 *  2. **Each axis is scaled independently, then the square is mapped onto the
 *     disc.** A single radial scale by the furthest member preserves the aspect
 *     ratio of the projection, and that ratio is not a fact about the material:
 *     the second component is nearly always the weaker one, so an honest-looking
 *     radial fit draws a thin needle across the middle of a circle and calls the
 *     rest of it empty. Same reasoning as `layoutRegions`, one level down — this
 *     map carries no axes and no units, only "closer means more alike".
 *
 * Exported for `tools/atlas-gates.mjs`: both faults above are invisible in a
 * built map unless a region's members are genuinely spread, which no synthetic
 * clustering fixture reliably produces — so the placement is checked directly,
 * on a cloud built to have the shape that exposes them.
 */
export function layoutMembers(region, point, radius) {
    const members = region.members;
    const n = members.length;
    const dim = region.centroid.length;
    const fit = radius * 0.8;

    const spiral = () => members.map((_, i) => {
        // Vogel's model: the constant-area packing sunflowers use.
        const t = n === 1 ? 0 : Math.sqrt((i + 0.5) / n);
        const a = i * 2.39996323;
        return { x: point.x + Math.cos(a) * t * fit, y: point.y + Math.sin(a) * t * fit };
    });

    if (n < 4 || dim === 0) return spiral();

    const mean = new Float64Array(dim);
    for (const m of members) for (let d = 0; d < dim; d++) mean[d] += m.vec[d] / n;

    const rows = members.map(m => {
        const row = new Float64Array(dim);
        for (let d = 0; d < dim; d++) row[d] = m.vec[d] - mean[d];
        return row;
    });
    const v1 = powerIteration(rows, dim, LOCAL_PCA_ITERATIONS);
    if (!v1) return spiral();
    deflate(rows, v1, dim);
    const v2 = powerIteration(rows, dim, LOCAL_PCA_ITERATIONS);

    const raw = members.map(m => {
        let x = 0, y = 0;
        for (let d = 0; d < dim; d++) {
            const c = m.vec[d] - mean[d];
            x += c * v1[d];
            if (v2) y += c * v2[d];
        }
        return { x, y };
    });

    // A high quantile rather than the maximum: one member three times further
    // out than anything else would otherwise squeeze the rest of the region into
    // a knot in the middle, which is the same failure the radial fit had.
    const axisScale = (get) => {
        const mag = raw.map(p => Math.abs(get(p))).sort((a, b) => a - b);
        const q = mag[Math.min(mag.length - 1, Math.floor(mag.length * 0.95))];
        return Number.isFinite(q) && q > 1e-9 ? 1 / q : 0;
    };
    const sx = axisScale(p => p.x), sy = axisScale(p => p.y);
    if (!sx && !sy) return spiral();

    // Elliptical grid mapping: takes the unit square onto the unit disc without
    // folding it, so the members fill the bubble instead of a stripe across it
    // and their order along either axis survives.
    return raw.map(p => {
        const u = clampUnit(p.x * sx), v = clampUnit(p.y * sy);
        return {
            x: point.x + u * Math.sqrt(1 - (v * v) / 2) * fit,
            y: point.y + v * Math.sqrt(1 - (u * u) / 2) * fit,
        };
    });
}

/**
 * Nudge overlapping dots apart and keep them inside their bubble. Same job as
 * `relax` does for regions, with a circular fence instead of a square one: a
 * dot shoved outside its own region would be a lie about which region it is in.
 */
function packInside(points, point, radius, dotRadius, passes = 24) {
    const pts = points.map(p => ({ ...p }));
    const fence = Math.max(0, radius - dotRadius * 0.9);
    // Separation is derived from the room available, not just from the dots:
    // "don't overlap" is the floor, and a region that only ever meets its floor
    // packs into a honeycomb knot with a ring of unused bubble around it. The
    // spacing an even packing of n dots would use is the target, capped so a
    // handful of topics in a big bubble still read as a group rather than being
    // flung against the wall.
    const want = Math.max(
        dotRadius * 2.1,
        Math.min(1.6 * fence / Math.sqrt(Math.max(1, pts.length)), dotRadius * 6, fence),
    );
    for (let pass = 0; pass < passes; pass++) {
        let moved = false;
        for (let i = 0; i < pts.length; i++) {
            for (let j = i + 1; j < pts.length; j++) {
                const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
                let d = Math.hypot(dx, dy);
                if (d >= want) continue;
                let ux, uy;
                if (d < 1e-9) { const a = (i * 2.399963) + j; ux = Math.cos(a); uy = Math.sin(a); d = 1e-9; }
                else { ux = dx / d; uy = dy / d; }
                const push = (want - d) / 2;
                pts[i].x -= ux * push; pts[i].y -= uy * push;
                pts[j].x += ux * push; pts[j].y += uy * push;
                moved = true;
            }
        }
        for (const p of pts) {
            const dx = p.x - point.x, dy = p.y - point.y;
            const d = Math.hypot(dx, dy);
            if (d > fence && d > 1e-9) {
                p.x = point.x + (dx / d) * fence;
                p.y = point.y + (dy / d) * fence;
            }
        }
        if (!moved) break;
    }
    return pts;
}

/**
 * Push overlapping bubbles apart so labels stay readable. Cosmetic and
 * deliberately gentle — a few passes of pairwise relaxation, no re-layout — so
 * it can only nudge the PCA result, never rearrange it into a different story.
 */
function relax(points, radii, passes = 60) {
    const pts = points.map(p => ({ ...p }));
    for (let pass = 0; pass < passes; pass++) {
        let moved = false;
        for (let i = 0; i < pts.length; i++) {
            for (let j = i + 1; j < pts.length; j++) {
                const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
                const want = radii[i] + radii[j];
                let d = Math.hypot(dx, dy);
                if (d >= want) continue;
                // Exactly-coincident points have no direction to separate along;
                // give them a deterministic one derived from their indices.
                let ux, uy;
                if (d < 1e-6) { const a = (i * 2.399963) + j; ux = Math.cos(a); uy = Math.sin(a); d = 1e-6; }
                else { ux = dx / d; uy = dy / d; }
                const push = (want - d) / 2;
                pts[i].x -= ux * push; pts[i].y -= uy * push;
                pts[j].x += ux * push; pts[j].y += uy * push;
                moved = true;
            }
        }
        if (!moved) break;
    }
    return pts;
}

/**
 * Scale and centre the whole arrangement so it exactly fills the frame.
 *
 * The map used to CLAMP coordinates into [-1, 1] instead, and clamping is not a
 * fit: every bubble the relaxation pushed past the edge landed *on* the edge,
 * so a crowded library drew a stack of circles pinned to the left wall at
 * x = -1.00 — the "strange positions" a reader sees. Scaling preserves every
 * relative distance, which is the only thing this map claims, and scaling UP
 * when the arrangement is small stops a sparse library from drawing itself as a
 * dot in the middle of an empty page.
 *
 * Radii scale with the positions. A bubble's size is a comparison against the
 * other bubbles, never an absolute quantity, so the comparison survives intact.
 */
function fitToFrame(points, radii, margin = 0.98) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    points.forEach((p, i) => {
        x0 = Math.min(x0, p.x - radii[i]); x1 = Math.max(x1, p.x + radii[i]);
        y0 = Math.min(y0, p.y - radii[i]); y1 = Math.max(y1, p.y + radii[i]);
    });
    const w = x1 - x0, h = y1 - y0;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return { points, radii };
    const s = Math.min(w > 1e-9 ? (2 * margin) / w : 1, h > 1e-9 ? (2 * margin) / h : 1);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return {
        points: points.map(p => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
        radii: radii.map(r => r * s),
    };
}

// ---- summarising a region ---------------------------------------------------

// A region is named after its medoid — the member closest to the centroid, and
// so the most representative thing in it. A medoid is used rather than an
// AI-written label because it costs nothing, never invents a subject that isn't
// there, and draws identically every visit.
//
// The name has its curriculum numbering stripped (`cleanRegionLabel`, now in
// `server/curriculumLabel.js` because the embedding layer needs the same rule,
// re-exported here because the gates and tools import it from the atlas).

// How well a title works as the name of a PLACE, independent of how central its
// topic is. Every penalty here is a way a title fails to be a name: a leftover
// figure ("W21, S21, and W22"), a whole instruction where a noun phrase belongs
// ("Practice all vehicle check questions with your instructor's car"), or a
// fragment too short to mean anything.
function labelPenalty(cleaned) {
    let p = 0;
    if (/\d/.test(cleaned)) p += 0.02;
    if (cleaned.length > 46) p += 0.03;
    if (cleaned.length > 68) p += 0.04;
    if (cleaned.length < 6) p += 0.05;
    return p;
}

/**
 * Name the region. The medoid rule still decides — this only chooses among the
 * members that are effectively tied for most-central, preferring the one whose
 * title reads as a name. The penalties are smaller than the centrality spread
 * across a region and larger than the spread across its top few members, which
 * is exactly the intent: never overrule a clearly more representative topic,
 * always break a tie toward something a person can read.
 */
function pickLabel(region) {
    const scored = region.members
        .map(m => ({ m, centrality: dot(m.vec, region.centroid) }))
        .sort((a, b) => b.centrality - a.centrality)
        .slice(0, 15)
        .map(({ m, centrality }) => {
            const cleaned = cleanRegionLabel(m.title);
            return { m, cleaned, score: centrality - labelPenalty(cleaned) };
        });
    // Ties resolve by id via the stable sort above, so the same library always
    // names the same place the same thing.
    let best = scored[0];
    for (const s of scored) if (s.score > best.score) best = s;
    return { label: best.cleaned, topicId: best.m.id };
}

function summarise(region, id, threshold, positions, lineage, namedLabel = null, nameSource = null) {
    const { label: medoidLabel, topicId } = pickLabel(region);
    // A cached model-written name wins when there is one, and the medoid is
    // what stands the rest of the time — including on every failure path, so
    // the map draws identically to a build where no model was ever reachable.
    // `labelSource` is provenance, not decoration: a reader who disagrees with
    // a name needs to know whether the map read it off a topic or wrote it.
    const label = namedLabel || medoidLabel;
    const byProject = new Map();
    let proven = 0, learning = 0, untouched = 0, masterySum = 0;

    const topics = region.members.map((m, i) => {
        const p = byProject.get(m.project_id)
            || {
                id: m.project_id, name: m.project_name, color: m.project_color,
                start: m.project_start || null, count: 0,
            };
        p.count++;
        byProject.set(m.project_id, p);

        if (m.status === 'completed') proven++;
        else if (m.attempts > 0 || m.status === 'in_progress') learning++;
        else untouched++;
        masterySum += m.mastery;

        return {
            id: m.id,
            // Numbering comes off EVERY name on the map, not just the region's.
            // "Module 9.5:", "3.3.3:", "12.3" state a position in one course,
            // and a course's running order is exactly what the atlas dissolves
            // — so a dot labelled "Module 9.5: Optional Advanced Extensi…"
            // spends its width on the one part that means nothing here and cuts
            // off the part that means everything. Cleaning it server-side keeps
            // the map, the region list and the topic card saying the same
            // thing; `cleanRegionLabel` is idempotent, so a region named after
            // this topic still matches it.
            title: cleanRegionLabel(m.title),
            status: m.status,
            projectId: m.project_id,
            projectName: m.project_name,
            projectColor: m.project_color,
            mastery: m.mastery,
            attempts: m.attempts,
            transferred: m.transferred_prior != null,
            // The course's own shape, so the map can draw it: the nearest
            // ancestor that is also on the map, and how deep that makes this
            // topic in the drawn tree. Null parent = a root, or the only one of
            // its line that is mapped.
            parentId: lineage.get(m.id)?.parentId ?? null,
            depth: lineage.get(m.id)?.depth ?? 0,
            // When this topic was closed, or null. The journey is ordered by
            // this and by nothing else — a topic marked complete with no usable
            // timestamp has no place in a sequence, and inventing one would be
            // a claim about the learner's past that nothing supports.
            completedAt: m.completed_iso || null,
            // How representative this topic is of its region — the ordering
            // that makes an expanded region readable rather than alphabetical.
            centrality: Number(dot(m.vec, region.centroid).toFixed(4)),
            // Where it sits inside its bubble, in the map's own coordinates.
            x: Number(positions[i].x.toFixed(5)),
            y: Number(positions[i].y.toFixed(5)),
        };
    }).sort((a, b) => b.centrality - a.centrality);

    return {
        id,
        label,
        /** Which member the name came from — the map's provenance, in one id. */
        labelTopicId: topicId,
        /**
         * Where this name came from: 'medoid' = read off the most central
         * topic, 'model' = written for this region, 'user' = typed by the
         * learner. Shown in the region card, because a reader who disagrees
         * with a name needs to know who to argue with — and the answer decides
         * whether the fix is a different naming model or their own keyboard.
         */
        labelSource: namedLabel ? (nameSource === 'user' ? 'user' : 'model') : 'medoid',
        /**
         * The region's stable identity — a hash of its member set. Sent to the
         * client so a rename can address a place on the map that has no id of
         * its own (the index renumbers on every rebuild).
         */
        signature: regionSignature(region.members.map(m => m.id)),
        /** What the medoid rule would have said, so a model name is auditable. */
        medoidLabel,
        size: region.members.length,
        projects: [...byProject.values()].sort((a, b) => b.count - a.count),
        // A region drawing from more than one project is where the library
        // actually overlaps — the thing worth spotting on the map.
        crossProject: byProject.size > 1,
        mastery: {
            proven, learning, untouched,
            avg: region.members.length ? masterySum / region.members.length : 0,
        },
        isLandmark: region.members.length >= LANDMARK_MIN_SIZE,
        threshold,
        topics,
    };
}

// ---- bridges ----------------------------------------------------------------

/**
 * Cross-project pairs that mean the same thing.
 *
 * Found within a region rather than by scanning the whole library: two topics
 * similar enough to bridge are, by definition, similar enough to have landed in
 * one region, so this costs the region's size squared instead of the library's.
 * On a 3000-topic library that is the difference between a few thousand
 * comparisons and nine million.
 */
async function findBridges(regions, minSimilarity) {
    const bridges = [];
    for (const region of regions) {
        const m = region.members.length <= BRIDGE_SCAN_CAP
            ? region.members
            : [...region.members]
                .sort((a, b) => dot(b.vec, region.centroid) - dot(a.vec, region.centroid))
                .slice(0, BRIDGE_SCAN_CAP);
        for (let i = 0; i < m.length; i++) {
            for (let j = i + 1; j < m.length; j++) {
                if (m[i].project_id === m[j].project_id) continue;
                const sim = dot(m[i].vec, m[j].vec);
                if (sim < minSimilarity) continue;
                // Order the pair by what the learner can DO with it: a proven
                // side first makes the row read "you know this → this is the
                // one waiting for you".
                const [a, b] = m[i].mastery >= m[j].mastery ? [m[i], m[j]] : [m[j], m[i]];
                bridges.push({
                    similarity: Number(sim.toFixed(4)),
                    proven: a.status === 'completed' || a.mastery >= 0.85,
                    a: { id: a.id, title: a.title, projectId: a.project_id, projectName: a.project_name, projectColor: a.project_color, status: a.status, mastery: a.mastery },
                    b: { id: b.id, title: b.title, projectId: b.project_id, projectName: b.project_name, projectColor: b.project_color, status: b.status, mastery: b.mastery },
                });
            }
        }
        await nextTick();
    }
    // Actionable first (a proven side is a head start waiting), then closest.
    return bridges
        .sort((x, y) => (Number(y.proven) - Number(x.proven)) || (y.similarity - x.similarity))
        .slice(0, MAX_BRIDGES);
}

// ---- build + cache ----------------------------------------------------------

// The atlas is a pure function of the topic space, so it only has to be rebuilt
// when that changes. The signature covers every way it can: topics added or
// removed, any topic re-embedded, and a switch of embedding model (which
// changes what the vectors MEAN without necessarily changing their count).
function signature() {
    let vectors = 0;
    try { vectors = db.prepare('SELECT COUNT(*) c FROM vec_nodes').get()?.c || 0; } catch (_) { }
    const sidecar = db.prepare(
        `SELECT COUNT(*) c, MAX(updated_at) m FROM node_embeddings`
    ).get() || {};
    const nodes = db.prepare(`SELECT COUNT(*) c FROM nodes WHERE is_note = 0`).get()?.c || 0;
    return `${vectors}:${sidecar.c || 0}:${sidecar.m || ''}:${nodes}:${getEmbeddingConfig().model}`;
}

let cache = { key: null, value: null };

function unavailable(reason) {
    return {
        available: false, reason,
        stats: { topics: 0, mapped: 0, projects: 0, regions: 0, proven: 0, learning: 0, untouched: 0 },
        regions: [], bridges: [],
    };
}

/**
 * One build at a time per set of options.
 *
 * `cache` is only assigned once a build FINISHES, so two callers arriving while
 * one is running each ran the whole thing — the startup warm-up against the
 * first page load, or a Refresh pressed twice. The second caller wants exactly
 * the answer the first is already computing, and the build is a second or two of
 * synchronous arithmetic, so running it twice is the one cost worth avoiding
 * here. Keyed on the options because that is what makes two builds different.
 *
 * @param {object} [opts]
 * @param {number} [opts.regionSimilarity] override the derived region threshold
 * @param {boolean} [opts.includeArchived]
 * @param {boolean} [opts.refresh] rebuild even if the cache is warm
 */
const inflight = new Map();

export function buildAtlas(opts = {}) {
    const key = `${opts.regionSimilarity ?? null}|${!!opts.includeArchived}|${!!opts.refresh}`;
    const running = inflight.get(key);
    if (running) return running;
    const promise = buildAtlasNow(opts).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
}

async function buildAtlasNow({
    regionSimilarity = null,
    includeArchived = false,
    refresh = false,
} = {}) {
    if (!vecAvailable) return unavailable('sqlite-vec is not loaded on this build, so topics are not mapped.');
    if (!embeddingReady()) return unavailable('Semantic search is switched off, so topics are not mapped.');
    if (!vecTableExists('vec_nodes')) return unavailable('No topics have been mapped yet — this needs an embedding model.');

    const key = `${signature()}|${regionSimilarity}|${includeArchived}`;
    if (!refresh && cache.key === key && cache.value) return cache.value;

    const topics = await loadTopics({ includeArchived });
    const totalTopics = db.prepare(
        `SELECT COUNT(*) c FROM nodes n JOIN projects p ON p.id = n.project_id
         WHERE n.is_note = 0 ${includeArchived ? '' : `AND COALESCE(p.status, 'active') != 'archived'`}`
    ).get()?.c || 0;

    if (topics.length === 0) {
        return unavailable('No topics have been mapped yet — this needs an embedding model.');
    }

    const threshold = regionSimilarity ?? await deriveThreshold(sample(topics, SAMPLE_SIZE));
    const { regions, seedCapped } = await buildRegions(topics, threshold);
    if (regions.length === 0) return unavailable('The mapped topics could not be read as vectors.');
    const points = layoutRegions(regions);

    // Radius scales with the SQUARE ROOT of the topic count, so a region's
    // drawn area — not its width — is what tracks its size. Area is what the
    // eye compares, and scaling the radius directly would make a 40-topic
    // region look ten times bigger than a 4-topic one instead of three.
    //
    // The constant is chosen from the LIBRARY, not fixed: the bubbles together
    // should cover about a third of the canvas, whether there are eight of them
    // or two hundred. A fixed scale sized against the biggest region put 115
    // bubbles of radius ~0.2 into a canvas 2 units wide — several times more
    // ink than there was room for, which the relaxation then resolved by
    // shoving half the map into the walls.
    const inked = regions.reduce((a, r) => a + r.members.length, 0) || 1;
    const unit = Math.sqrt((INK_SHARE * 4) / (Math.PI * inked));
    const radii = regions.map(r => Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, unit * Math.sqrt(r.members.length))));
    const fitted = fitToFrame(relax(points, radii), radii);
    const placed = fitted.points;
    const sized = fitted.radii;

    // The same regions on a sphere — three components out of the embedding
    // space instead of two, so the globe view is a projection of the material
    // rather than the flat map wrapped round a ball (`server/globe.js`).
    //
    // Computed here, unconditionally, because it is a hundred-odd points and
    // one extra PCA pass over the region centroids: cheaper than the layout
    // above it, and paying for it on every build means switching view costs no
    // request at all. The TOPICS are not sent twice — the client reads their
    // offsets out of the flat coordinates already in this payload and places
    // them on the cap's tangent plane, which is also what keeps the arrangement
    // inside a bubble identical in both views.
    const globe = await globeLayout(regions);

    // Topics inside their bubbles. The dot has to be big enough to aim at with
    // a thumb once the map is zoomed in and small enough that a fifty-topic
    // region isn't solid colour — so it is derived from the packing, not fixed.
    // Names already earned for these exact member sets. Pure SQLite — this is
    // the request path, and nothing here may wait on a model.
    const names = cachedNamesFor(regions);
    // One pass over the whole mapped set, before the per-region loop: a
    // topic's nearest mapped ancestor is usually in a DIFFERENT region (that is
    // the point — the course crosses the map), so this cannot be answered
    // region by region.
    const lineage = resolveLineage(topics);

    const summaries = [];
    for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        const dotRadius = Math.max(0.003, Math.min(0.02, sized[i] / Math.sqrt(r.members.length) * 0.55));
        const seeded = layoutMembers(r, placed[i], sized[i]);
        const packedTopics = packInside(seeded, placed[i], sized[i], dotRadius);
        const named = names.get(i) || null;
        summaries.push({
            ...summarise(r, i, threshold, packedTopics, lineage, named,
                named && nameModelFor(regionSignature(r.members.map(m => m.id))) === USER_MODEL ? 'user' : 'model'),
            x: Number(placed[i].x.toFixed(5)),
            y: Number(placed[i].y.toFixed(5)),
            radius: Number(sized[i].toFixed(5)),
            topicRadius: Number(dotRadius.toFixed(5)),
            u: globe.dirs[i].map(v => Number(v.toFixed(5))),
            cap: Number(globe.caps[i].toFixed(5)),
        });
        if (i % 8 === 7) await nextTick();
    }
    summaries.sort((a, b) => b.size - a.size);

    const bridges = await findBridges(regions, TRANSFER_MIN_SIMILARITY);

    const stats = {
        topics: totalTopics,
        mapped: topics.length,
        projects: new Set(topics.map(t => t.project_id)).size,
        regions: summaries.length,
        crossProjectRegions: summaries.filter(s => s.crossProject).length,
        proven: summaries.reduce((a, s) => a + s.mastery.proven, 0),
        learning: summaries.reduce((a, s) => a + s.mastery.learning, 0),
        untouched: summaries.reduce((a, s) => a + s.mastery.untouched, 0),
        // The journey's raw material: how many finishes can be placed in time,
        // and how many cannot. The second number is reported rather than
        // swallowed — a learner whose path is shorter than their proven count
        // is owed the reason, and the reason is a missing timestamp on rows
        // closed before the column was filled.
        dated: topics.filter(t => !!t.completed_iso).length,
        undated: topics.filter(t => !t.completed_iso && t.status === 'completed').length,
        // Reported so a map that looks too coarse is explainable rather than
        // mysterious — and so the query param has something to tune against.
        regionSimilarity: Number(threshold.toFixed(4)),
        regionCap: MAX_REGIONS,
        // True when EITHER ceiling bound the result — the seed cap is what
        // binds on a library with no structure, the region cap on one with too
        // much of it, and the reader needs the same warning in both cases.
        capped: summaries.length >= MAX_REGIONS || seedCapped,
        // The size a region has to exceed before it is subdivided — reported so
        // a map with one dominant bubble is explainable rather than mysterious.
        regionSizeCap: Math.max(MIN_SPLIT_SIZE, Math.ceil(topics.length * REGION_SIZE_SHARE)),
        largestRegion: summaries[0]?.size || 0,
    };

    const value = { available: true, reason: null, stats, regions: summaries, bridges, builtAt: new Date().toISOString() };
    cache = { key, value };

    // Earn names for whatever is still unnamed, in the background, on the ONE
    // shared vector chain. Fire-and-forget by design: this request has already
    // answered with medoid labels, and the names appear on the next build —
    // the same "run ahead of the reader" arrangement feedGen uses for widgets,
    // and for the same reason, since the alternative is a request that waits on
    // a hundred model calls. It is also why nothing here is awaited: a naming
    // sweep must never be able to fail an atlas request.
    //
    // The sweep is handed a way to drop the atlas cache, because the names it
    // writes are invisible without it: this cache is keyed on a signature of
    // the TOPIC SPACE, which naming does not touch, so a finished sweep left
    // the map drawing medoids until the library itself changed. A callback
    // rather than an import, because `regionNaming.js` importing this module
    // back would be a cycle — and a link-time failure `node --check` cannot see.
    scheduleRegionNaming(regions, { onNamed: () => invalidateAtlas() });

    return value;
}

/** Drop the cached atlas (used by the reindex endpoints). */
export function invalidateAtlas() {
    cache = { key: null, value: null };
}
