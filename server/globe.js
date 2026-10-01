// server/globe.js — the same library, laid out on a sphere instead of a sheet.
//
// The flat atlas keeps two principal directions out of several hundred and
// throws the rest away, and it pays for that twice: once in what it cannot
// show, and once at the EDGE. A sheet has corners, and whatever the layout
// pushes into them reads as peripheral — not because the material is, but
// because the shape of the paper says so. A sphere has no edge and no corner:
// every region sits in the middle of its own view, and "what is next to this?"
// has the same answer from every side.
//
// So this is not the flat map wrapped around a ball. The regions are projected
// from the embedding space onto the sphere directly — three components rather
// than two, then refined against the REAL distances between centroids the same
// way `refineLayout` refines the plane — and the third component is a direction
// the flat map genuinely does not have. What a reader gets for it is the one
// thing the plane cannot offer: a region can have neighbours all the way round
// it, so a subject that borders four others is drawn bordering four others
// instead of being flattened into a line of three.
//
// Within a region nothing changes, and that is deliberate: a cap is locally
// flat, the local projection is already two-dimensional (`layoutMembers`), and
// the client places those same offsets on the cap's tangent plane. So the
// arrangement inside a bubble is identical in both views — only the arrangement
// BETWEEN bubbles gains a dimension — and the sphere costs three numbers per
// region on the wire rather than three per topic.
//
// Deterministic end to end: PCA seeds it (with `powerIteration`'s fixed seed
// vector), the neighbour lists are stably sorted, the step schedule is fixed.
// The same library draws the same planet every visit, which is the difference
// between a map and a picture.

import {
    deflate, powerIteration, nearestNeighbours,
    INK_SHARE, LAYOUT_NEIGHBOURS as NEIGHBOURS, LAYOUT_ANCHOR as ANCHOR,
    LAYOUT_BUDGET as BUDGET, LAYOUT_MIN_ITERATIONS as MIN_ITERATIONS,
    LAYOUT_MAX_ITERATIONS as MAX_ITERATIONS,
} from './vectors.js';

// `INK_SHARE` (how much of the sphere the caps cover between them), the
// neighbour count, the tether back to the projection and the iteration budget
// are all in `vectors.js`, shared with the plane: the refinement is one method,
// and a share of the whole sphere is a share of what the reader sees, since they
// see half of it at a time.
/** A cap smaller than this is a dot; smaller still and it is nothing at all. */
const MIN_CAP = 0.022;
/**
 * …and the biggest a region may be, in radians. 0.42 is about 24°, so the
 * largest cap spans roughly two fifths of the visible disc — the same fraction
 * `MAX_RADIUS` gives the biggest bubble on the flat map. A dominant region
 * beyond this is capped rather than allowed to swallow the hemisphere; the
 * region list says how big it really is.
 */
const MAX_CAP = 0.42;


const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Let the event loop run: this file's long stretches of arithmetic are split by it. */
const breathe = () => new Promise((resolve) => setImmediate(resolve));
/** Passes between breaths. Small enough to keep a block short, big enough that
 *  the awaits themselves are not the cost. */
const YIELD_EVERY = 4;

// ---- three-vector helpers ---------------------------------------------------
// Plain arrays rather than a class: these cross a JSON boundary, and every one
// of them is three numbers.

const norm3 = (v) => Math.hypot(v[0], v[1], v[2]);

function unit3(v) {
    const n = norm3(v);
    return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The angle between two unit vectors, guarded against a dot product that
 *  rounding has pushed a hair past ±1 (which makes `acos` return NaN). */
export const angleBetween = (a, b) => Math.acos(clamp(dot3(a, b), -1, 1));

/**
 * The unit tangent at `a` pointing along the great circle toward `b`, or null
 * when the two are the same point or exactly antipodal — in both of which there
 * is no such direction, and the caller must not invent one.
 */
function tangentToward(a, b) {
    const d = dot3(a, b);
    return unit3([b[0] - a[0] * d, b[1] - a[1] * d, b[2] - a[2] * d]);
}

/**
 * Walk `angle` radians from `p` along the great circle in the direction `t`.
 *
 * The exponential map, exactly rather than as `p + t·angle` renormalised: a
 * separation pass moves points by up to a cap's width at a time, and at that
 * size the linear step lands measurably short — which is a relaxation that
 * never quite converges and cannot be told apart from one that has.
 */
function moveAlong(p, t, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return unit3([p[0] * c + t[0] * s, p[1] * c + t[1] * s, p[2] * c + t[2] * s]) || p;
}

/**
 * Points spread evenly over the sphere, in a fixed order.
 *
 * The fallback whenever there is nothing to project — one region, or centroids
 * with no variance between them — and the same claim the flat map's ring makes:
 * an even packing says nothing about what is near what, which is the correct
 * thing to say about a library that has no structure to show.
 */
export function fibonacciSphere(n) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    return Array.from({ length: n }, (_, i) => {
        const z = n === 1 ? 1 : 1 - (2 * i + 1) / n;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const a = i * golden;
        return [Math.cos(a) * r, Math.sin(a) * r, z];
    });
}

/**
 * How wide a region's cap is, in radians.
 *
 * Derived from AREA, not from width: a cap of angular radius ρ covers
 * 2π(1 − cos ρ) of the sphere, and a region's share of the inked area is its
 * share of the topics. So `1 − cos ρ = 2 · INK_SHARE · count / total`, which is
 * the sphere's version of the flat map's `radius ∝ √count` — in both cases what
 * tracks the topic count is the area, because area is what the eye compares.
 */
export function capRadius(count, total) {
    const cos = 1 - 2 * INK_SHARE * (count / Math.max(1, total));
    return clamp(Math.acos(clamp(cos, -1, 1)), MIN_CAP, MAX_CAP);
}

/**
 * Project the region centroids onto the sphere: three principal components,
 * each scaled to its own span, then read as a direction.
 *
 * Scaling the axes independently before normalising is the same decision the
 * flat map makes and matters more here. The third component is nearly always
 * the weakest, and an honest-looking uniform scale would leave every region
 * within a few degrees of one great circle — a planet with all of its land in a
 * belt, which is the sphere's version of the thin needle across an empty
 * circle. The atlas carries no axes and no units; what it claims is "near means
 * alike", and that claim is served by using the whole surface.
 */
function seedDirections(regions) {
    const n = regions.length;
    const dim = regions[0]?.centroid?.length || 0;
    if (n < 4 || dim === 0) return fibonacciSphere(n);

    const mean = new Float64Array(dim);
    for (const r of regions) for (let d = 0; d < dim; d++) mean[d] += r.centroid[d] / n;
    const rows = regions.map(r => {
        const row = new Float64Array(dim);
        for (let d = 0; d < dim; d++) row[d] = r.centroid[d] - mean[d];
        return row;
    });

    const axes = [];
    for (let a = 0; a < 3; a++) {
        const v = powerIteration(rows, dim);
        if (!v) break;
        axes.push(v);
        deflate(rows, v, dim);
    }
    if (axes.length === 0) return fibonacciSphere(n);

    const raw = regions.map(r => axes.map(v => {
        let s = 0;
        for (let d = 0; d < dim; d++) s += (r.centroid[d] - mean[d]) * v[d];
        return s;
    }));

    // Each axis into [-1, 1] on its own. An axis with no spread contributes
    // nothing rather than a division by zero — a library whose structure is
    // genuinely two-dimensional then lands on a great circle, which is the
    // truth about it.
    const scaled = raw.map(() => [0, 0, 0]);
    for (let a = 0; a < 3; a++) {
        const vals = raw.map(p => p[a] ?? 0);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        if (!(hi - lo > 1e-9)) continue;
        for (let i = 0; i < n; i++) scaled[i][a] = ((vals[i] - lo) / (hi - lo)) * 2 - 1;
    }

    // A point that lands on the origin of the cube has no direction to read. It
    // is rare and it is not an error, so it takes the even packing's answer for
    // its index — deterministic, and as good a guess as exists.
    const spare = fibonacciSphere(n);
    return scaled.map((p, i) => unit3(p) || spare[i]);
}

/**
 * Refine the projection so that regions which are ACTUALLY each other's nearest
 * neighbours end up next to each other on the globe.
 *
 * The forces are `refineLayout`'s, moved onto the surface: distance is the
 * great-circle angle, every force is a tangent vector at the point it acts on,
 * and the point is re-normalised after the step so it never leaves the sphere.
 * The reasoning carries over unchanged — only NEAR pairs are optimised, because
 * in a few hundred dimensions the far distances sit in a narrow band and
 * spending the budget on them draws a ring — and so does the tether: the
 * projection is bad at local neighbourhoods and good at the global frame, and
 * without the anchor the local forces pull the library into two dense clumps
 * with an empty ocean between them.
 */
async function refineOnSphere(seed, regions) {
    const n = seed.length;
    if (n < 4) return seed;
    const near = nearestNeighbours(regions, Math.min(NEIGHBOURS, n - 1));
    // What "next to" should measure, in radians: each region owns 4π/n of the
    // sphere, so its own cap has `1 − cos ρ = 2/n` and neighbours sit about two
    // of those apart. Derived from the count for the same reason the plane
    // derives its spacing — a big library must not pack tighter than a small
    // one.
    const spacing = Math.max(0.1, 2 * Math.acos(clamp(1 - 2 / n, -1, 1)));
    const pts = seed.map(p => [...p]);
    const iterations = clamp(Math.round(BUDGET / (n * n)), MIN_ITERATIONS, MAX_ITERATIONS);

    for (let it = 0; it < iterations; it++) {
        // Cool down, so early passes rearrange and late ones settle.
        const step = 0.6 * (1 - it / iterations) + 0.05;
        const force = pts.map(() => [0, 0, 0]);

        for (let i = 0; i < n; i++) {
            const add = (t, k) => {
                if (!t) return;
                force[i][0] += t[0] * k; force[i][1] += t[1] * k; force[i][2] += t[2] * k;
            };

            // Attraction: toward each true neighbour, to `spacing`. Closer in
            // meaning → shorter target, so the ORDER among a region's own
            // neighbours survives too, not merely the set.
            for (const { j, sim } of near[i]) {
                const d = angleBetween(pts[i], pts[j]);
                const target = spacing * (1.4 - clamp(sim, 0, 1));
                add(tangentToward(pts[i], pts[j]), (d - target) * 0.5);
            }

            // The tether back to where the projection put this region.
            add(tangentToward(pts[i], seed[i]), angleBetween(pts[i], seed[i]) * ANCHOR);

            // Repulsion: only from whatever is too close, which is what keeps
            // the arrangement from collapsing onto one pole.
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                const d = angleBetween(pts[i], pts[j]);
                if (d > spacing * 1.6) continue;
                add(tangentToward(pts[j], pts[i]), (spacing * 1.6 - d) * 0.35);
            }
        }

        for (let i = 0; i < n; i++) {
            const moved = unit3([
                pts[i][0] + force[i][0] * step,
                pts[i][1] + force[i][1] * step,
                pts[i][2] + force[i][2] * step,
            ]);
            if (moved) pts[i] = moved;
        }
        // Breathe. This loop is O(n² · iterations) and it runs in the process that
        // serves every SSE stream, so it is broken up the way `atlas.js` breaks up
        // its own passes. Measured on synthetic regions at 768 dimensions: the
        // longest single block the whole layout holds went from 200 ms to 138 ms
        // at 240 regions and from 188 ms to 92 ms at 120, for a few ms of total
        // wall clock. What is left in one piece is the PCA seed
        // (`powerIteration` over n × 768 rows, three axes) — shared with the flat
        // map, which has always paid it, and the next thing to break up if it
        // ever matters.
        if (it % YIELD_EVERY === YIELD_EVERY - 1) await breathe();
    }
    return pts;
}

// ---- and then the caps must not lie on top of one another -------------------
//
// The refinement above arranges CENTRES, and it arranges them by meaning: two
// regions that are each other's nearest neighbours are pulled to `spacing`,
// which is derived from how many regions there are and knows nothing about how
// big either of them is. So the two largest regions in a library, which are
// usually also similar ones, are pulled to the same distance apart as two tiny
// ones and then drawn four times as wide — and what the reader gets is a
// handful of overlapping discs with a hard rim through the middle of each,
// which says "these are two objects, one in front of the other" about two
// things that are neither.
//
// Measured on the real library before this existed: 44 overlapping pairs of
// 6,786, the worst needing 1.9× the separation it had. The flat map has had the
// answer since it was written (`relax` in `atlas.js`, pairwise, gentle, run
// after the layout rather than inside it), and this is the same pass with
// angles for distances — with one difference the sphere forces. A plane can
// always make room: `fitToFrame` scales the whole arrangement afterwards, so
// pushing things apart costs nothing. A sphere has a fixed area, so if the caps
// genuinely do not fit, no amount of pushing will seat them, and the only
// honest move left is to draw them all smaller.

/** A hair of clear sphere between two caps, so a rim reads as a rim. */
const CAP_GAP = 1.02;

/** Some tangent direction at `p`, picked by an angle — for the one case that
 *  has no direction of its own: two centres in exactly the same place. */
function spareTangent(p, angle) {
    const up = Math.abs(p[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
    const e1 = unit3([
        up[1] * p[2] - up[2] * p[1], up[2] * p[0] - up[0] * p[2], up[0] * p[1] - up[1] * p[0],
    ]) || [1, 0, 0];
    const e2 = unit3([
        p[1] * e1[2] - p[2] * e1[1], p[2] * e1[0] - p[0] * e1[2], p[0] * e1[1] - p[1] * e1[0],
    ]) || [0, 1, 0];
    const c = Math.cos(angle), s = Math.sin(angle);
    return unit3([e1[0] * c + e2[0] * s, e1[1] * c + e2[1] * s, e1[2] * c + e2[2] * s]) || e1;
}

/**
 * The worst overlap in a layout: the largest `(cap_i + cap_j) / angle_ij`.
 * At or below 1 nothing overlaps, which is the invariant this file ships.
 */
function worstOverlap(dirs, caps) {
    let worst = 0;
    for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
            const need = (caps[i] + caps[j]) * CAP_GAP;
            const have = angleBetween(dirs[i], dirs[j]);
            if (have > 1e-9) worst = Math.max(worst, need / have);
            else if (need > 0) worst = Infinity;
        }
    }
    return worst;
}

/**
 * Push overlapping caps apart along great circles.
 *
 * Deliberately gentle, like the plane's: a few dozen passes of pairwise
 * relaxation moving each of a colliding pair half the deficit, so it can only
 * nudge the arrangement the refinement produced — never rearrange it into a
 * different story about what is near what. `globe-gates.mjs` measures that
 * claim rather than trusting it: the neighbourhood score is taken after this
 * pass, so a separation that scrambled the layout would show up as the sphere
 * losing to the plane.
 */
async function separate(dirs, caps, passes) {
    const pts = dirs.map(p => [...p]);
    for (let pass = 0; pass < passes; pass++) {
        let moved = false;
        for (let i = 0; i < pts.length; i++) {
            for (let j = i + 1; j < pts.length; j++) {
                const want = (caps[i] + caps[j]) * CAP_GAP;
                const have = angleBetween(pts[i], pts[j]);
                if (have >= want) continue;
                const push = (want - have) / 2;
                const toJ = tangentToward(pts[i], pts[j]);
                const toI = tangentToward(pts[j], pts[i]);
                if (toJ && toI) {
                    pts[i] = moveAlong(pts[i], toJ, -push);
                    pts[j] = moveAlong(pts[j], toI, -push);
                } else {
                    // Two centres in exactly the same place have no direction
                    // between them to separate along. One is invented from
                    // their indices — deterministically, exactly as the plane
                    // does it, so the same library still draws the same planet.
                    const t = spareTangent(pts[i], i * 2.399963 + j);
                    pts[i] = moveAlong(pts[i], t, push);
                    pts[j] = moveAlong(pts[j], t, -push);
                }
                moved = true;
            }
        }
        if (!moved) break;
        // The other long stretch, for the same reason as the refinement above.
        if (pass % YIELD_EVERY === YIELD_EVERY - 1) await breathe();
    }
    return pts;
}

/**
 * The same caps covering `s` times the area.
 *
 * Scaling the AREA rather than the angle, because area is what a cap means
 * here — `capRadius` sizes it from the region's share of the topics precisely
 * so the eye can compare two regions by how much sphere they cover. Scaling the
 * radius instead would quietly change every one of those comparisons.
 *
 * It also gives the guarantee the last resort needs: for any ρ in (0, π/2),
 * shrinking the area by `s` shrinks the radius by at most √s — so asking for
 * `1/worst²` brings every cap to at most `ρ/worst`, which is exactly enough to
 * seat a layout with `worst` overlap without moving anything again.
 */
const scaleCaps = (caps, s) => caps.map(c => Math.acos(clamp(1 - s * (1 - Math.cos(c)), -1, 1)));

/**
 * Where every region sits on the globe, and how wide it is.
 *
 * @param {{centroid: number[], members: unknown[]}[]} regions
 * @returns {{ dirs: number[][], caps: number[] }} one unit 3-vector and one
 *   angular radius per region, in the order they were given. No two caps
 *   overlap.
 */
export async function globeLayout(regions) {
    const n = regions.length;
    if (n === 0) return { dirs: [], caps: [] };
    const total = regions.reduce((a, r) => a + r.members.length, 0) || 1;
    let dirs = await refineOnSphere(seedDirections(regions), regions);
    let caps = regions.map(r => capRadius(r.members.length, total));
    if (n < 2) return { dirs, caps };

    // Seat them, and if they will not seat, draw the whole library smaller and
    // try again — a sphere has a fixed area, and a library whose caps ask for
    // more of it than there is has no arrangement at all. Three rounds, because
    // each one shrinks by exactly the amount that was missing, so a round that
    // does not finish it is a layout the relaxation is still untangling rather
    // than one that does not fit.
    const passes = clamp(Math.round(BUDGET / (n * n)), MIN_ITERATIONS, MAX_ITERATIONS);
    for (let round = 0; round < 3; round++) {
        dirs = await separate(dirs, caps, passes);
        const worst = worstOverlap(dirs, caps);
        if (worst <= 1) return { dirs, caps };
        caps = scaleCaps(caps, 1 / (worst * worst));
        // One round of seating is the longest piece of arithmetic on the request
        // path here: measured at the region cap (240) the three of them together
        // hold the loop for 205 ms, 128 ms at 120 regions. This process serves
        // every SSE stream on the machine, and the loops around this one in
        // `atlas.js` yield every eight regions for the same reason, so the rounds
        // are separated by a turn of the loop rather than run back to back.
        await breathe();
    }
    // A safety net, and it is expected to be one: each round shrinks by exactly
    // the amount that was missing, so the third round's caps already seat. Kept
    // because the invariant this file ships — no two caps overlap — should not
    // depend on that argument being right, and the shrink is the one step that
    // needs no cooperation from the arrangement. `globe-gates.mjs` drives the
    // pathological cases (identical centroids) through it: caps that exist, and
    // no overlap.
    const worst = worstOverlap(dirs, caps);
    if (Number.isFinite(worst) && worst > 1) caps = scaleCaps(caps, 1 / (worst * worst));
    return { dirs, caps };
}

/**
 * How well a spherical layout preserves neighbourhoods: the share of each
 * region's `k` true nearest neighbours that are also among its `k` nearest ON
 * THE GLOBE.
 *
 * The one number that says whether the picture is honest, and it is here rather
 * than in a test file because it is the measurement a tuning change has to be
 * re-run against — the constants above are tuned, not reasoned, exactly like
 * `LAYOUT_NEIGHBOURS` on the plane.
 */
export function neighbourhoodScore(dirs, regions, k = 5) {
    const n = regions.length;
    if (n <= k + 1) return 1;
    const truth = nearestNeighbours(regions, k);
    let hit = 0, seen = 0;
    for (let i = 0; i < n; i++) {
        const drawn = new Set(
            dirs.map((d, j) => ({ j, a: j === i ? Infinity : angleBetween(dirs[i], d) }))
                .sort((a, b) => a.a - b.a || a.j - b.j)
                .slice(0, k)
                .map(e => e.j));
        for (const { j } of truth[i]) { seen++; if (drawn.has(j)) hit++; }
    }
    return seen ? hit / seen : 1;
}
