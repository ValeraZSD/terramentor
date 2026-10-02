/**
 * Terra's land: the regions as TERRITORIES with borders and a coastline, rather
 * than discs floating on an empty ball.
 *
 * A disc per region says "here is a pile of topics" and nothing about what lies
 * between two piles. A territory says what a map says: this ground belongs to
 * that subject, it runs up to the neighbour's border, and where no subject is
 * near there is sea. Related subjects that sit close on the sphere grow into one
 * continent with borders across it; a subject with nothing near it is an island.
 * That is the claim the layout already makes (`server/globe.js` puts similar
 * regions next to each other), drawn the way a reader already knows how to read.
 *
 * How the ground is shared out, in one sentence: every point on the sphere goes
 * to whichever region is nearest in units of that region's own size, unless even
 * the nearest is too far away, in which case it is ocean. Written as a SCORE per
 * region, lowest wins, and the ocean is just one more contender with a score of
 * its own — so a coastline and a border are the same kind of line, found the
 * same way.
 *
 *   score_i(v) = (angle(v, u_i) − cap_i) / (REACH_SHARE · cap_i + REACH_MIN)
 *                + BORDER_WOBBLE · noise_i(v) · (how far outside its own cap v is)
 *   ocean(v)   = 1 + COAST_WOBBLE · noise(v)
 *
 * Inside a region's own cap its score is negative and carries no wobble, and
 * every other region's score there is positive (`globe.js` ships caps that do
 * not overlap, with a gap) — so **every topic stands on its own territory**,
 * whatever the noise does. That is the one invariant this file must never lose,
 * and `tools/globe-gates.mjs` holds it.
 *
 * The noise is what makes it read as land rather than as a diagram: a border
 * that is an exact arc of a weighted Voronoi diagram looks computed, and a
 * coastline that is a perfect offset of a circle looks like a disc with a
 * border drawn round it. It is DETERMINISTIC — hashed from the region's id —
 * so the same library draws the same coastline every visit, which is the
 * difference between a map and a screensaver.
 *
 * The lines are traced on a fine icosphere (`MESH_LEVEL`): each vertex is given
 * its owner, and wherever an edge joins two owners the border crosses it at the
 * point where their two scores are equal (linear on the edge). A triangle with
 * three owners meets at a junction in its middle. Every crossing is keyed by the
 * EDGE it lies on and every junction by its triangle, so the two neighbours of a
 * border build it from the very same points — no seam, no sliver, no gap.
 *
 * Pure arithmetic, no DOM: built once per atlas and asserted directly.
 */

import { Vec3, dot3, unit3, angleBetween } from './globeProjection';

/** How far a territory runs past its own cap: a share of the cap… */
export const REACH_SHARE = 0.26;
/** …plus a fixed margin, in radians, so the smallest region is still an
 *  island a reader can see rather than a speck. */
export const REACH_MIN = 0.03;
/** How much the coastline wanders, in units of the reach. */
export const COAST_WOBBLE = 0.5;
/** How much a border between two territories wanders, in the same units. */
export const BORDER_WOBBLE = 0.7;
/**
 * How far a territory's reach varies with BEARING — its own shape, before any
 * noise. Without it every island is a disc with a ragged edge, which is the
 * "blob" this whole file exists to replace: a two-lobed stretch (`LOBE_2`)
 * makes it long in one direction and short across, a three-lobed one
 * (`LOBE_3`) gives it headlands. Exponents, so the reach is scaled between
 * `e^-(L2+L3)` and `e^(L2+L3)` and never reaches zero.
 */
export const LOBE_2 = 0.5;
export const LOBE_3 = 0.3;
/**
 * The mesh the lines are traced on: an icosahedron subdivided this many times.
 * Level 6 is 40,962 vertices about a degree apart, fine enough that the
 * smallest island (`MIN_CAP` + the reach, ~4° across) is a shape and not a
 * hexagon; each level more is four times the vertices and the build time.
 */
export const MESH_LEVEL = 6;
/** Noise frequencies, in cycles per radian-ish: a coast wanders at a finer
 *  grain than a territory is wide, a border a little finer still. */
const COAST_FREQ = 9;
const BORDER_FREQ = 12;

export interface TerritorySeed {
    id: number;
    /** Unit direction of the region's centre. */
    u: Vec3;
    /** Angular radius of the region's cap. */
    cap: number;
}

/** A closed or open line on the sphere, with a bounding cap for culling. */
export interface SphereLine {
    /** x, y, z of each point, flat. */
    pts: Float64Array;
    closed: boolean;
    /** Unit direction at the middle of the line's points… */
    centre: Vec3;
    /** …and the angle from it to the furthest point. */
    reach: number;
}

export interface Territory {
    id: number;
    /** The territory's outline: one loop per piece of land and per lake in it,
     *  each wound counter-clockwise seen from outside the planet. */
    loops: SphereLine[];
}

export interface Border {
    /** The two sides, `a < b`; a coast has the ocean (`OCEAN`) as `a`. */
    a: number;
    b: number;
    line: SphereLine;
}

export const OCEAN = -1;

export interface Terrain {
    territories: Territory[];
    /** Every line between two territories, stroked once. */
    borders: Border[];
    /** Every line between land and sea. */
    coasts: Border[];
    /**
     * The coastline echoed out into the sea, `WATERLINES` times — the old
     * cartographer's device, and the one cue that says "water" whatever
     * colour the water is. Land here is painted in the accent, which a reader
     * may have chosen blue, on a page tinted whatever they liked: blue land on
     * a sand-coloured sea reads as lakes in a desert. Lines rippling out from
     * a shore do not depend on either colour. `ring` counts outward from 1.
     */
    waterlines: { b: number; ring: number; line: SphereLine }[];
    /** Who owns this direction: a region id, or `OCEAN`. Asked of the score
     *  directly, so inside a swept speck (`SPECK`) it can name the owner the
     *  speck had — a few pixels of disagreement a pointer never finds. */
    ownerAt: (v: Vec3) => number;
    /** The share of the planet that is land (by mesh vertex, which the
     *  icosphere spaces nearly evenly). */
    landShare: number;
}

// ---- noise ------------------------------------------------------------------

/** An integer lattice point hashed to [0, 1). */
function hash3(x: number, y: number, z: number, seed: number): number {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ Math.imul(seed, 1103515245);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/** Smooth value noise in 3-D, in [0, 1]. */
function valueNoise(x: number, y: number, z: number, seed: number): number {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
    const c = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz, seed);
    const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * fx;
    const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * fx;
    const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * fx;
    const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * fx;
    const y0 = x00 + (x10 - x00) * fy;
    const y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
}

/**
 * Three octaves of it, stretched back to roughly [-1, 1]. Evaluated on the
 * sphere's own surface (a direction scaled by the frequency), so it has no seam
 * and no pole the way a latitude-longitude texture would.
 */
export function fbm(v: Vec3, freq: number, seed: number): number {
    let sum = 0, amp = 0.5, f = freq, norm = 0;
    for (let o = 0; o < 3; o++) {
        sum += amp * valueNoise(v[0] * f + 17.1, v[1] * f + 3.7, v[2] * f + 9.3, seed + o * 7919);
        norm += amp;
        amp *= 0.5;
        f *= 2.1;
    }
    // Averaged octaves of value noise bunch round 0.5; this puts the bulk of it
    // across the whole range, and the clamp catches the rare tail.
    return Math.max(-1, Math.min(1, (sum / norm - 0.5) * 3.2));
}

const smooth = (v: number, a: number, b: number) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

// ---- the score ----------------------------------------------------------------

/** How far past its rim a region may still win ground — the reach — in radians. */
export const reachOf = (cap: number) => REACH_SHARE * cap + REACH_MIN;

/** A seed with what its score needs worked out once: a tangent basis to read a
 *  bearing in, and the phases of its lobes, hashed from its id. */
export interface PreparedSeed extends TerritorySeed {
    e1: Vec3;
    e2: Vec3;
    phase2: number;
    phase3: number;
    reach: number;
}

export function prepareSeed(seed: TerritorySeed): PreparedSeed {
    const u = unit3(seed.u);
    const up: Vec3 = Math.abs(u[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
    const e1 = unit3([up[1] * u[2] - up[2] * u[1], up[2] * u[0] - up[0] * u[2], up[0] * u[1] - up[1] * u[0]]);
    const e2 = unit3([u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]]);
    return {
        ...seed, u, e1, e2,
        phase2: hash3(seed.id, 11, 0, 5) * Math.PI * 2,
        phase3: hash3(seed.id, 23, 0, 9) * Math.PI * 2,
        reach: reachOf(seed.cap),
    };
}

/**
 * A region's claim on a direction: negative inside its cap, 1 at the edge of its
 * reach, lowest claim wins.
 *
 * Past the cap, the reach depends on the BEARING (the lobes) and the claim
 * picks up a wobble. Neither can touch the inside: the lobes only rescale a
 * distance that is ≤ 0 there, and the wobble starts at the rim and is never
 * negative — which is the whole of the proof that a topic stands on its own
 * ground: nothing can lower a neighbour's score inside this cap, and nothing
 * raises this one's.
 */
export function territoryScore(seed: PreparedSeed, v: Vec3): number {
    const a = angleBetween(v, seed.u);
    if (a <= seed.cap) return (a - seed.cap) / seed.reach;
    const bearing = Math.atan2(dot3(v, seed.e2), dot3(v, seed.e1));
    const lobes = Math.exp(LOBE_2 * Math.cos(2 * bearing - seed.phase2)
        + LOBE_3 * Math.cos(3 * bearing - seed.phase3));
    const out = (a - seed.cap) / (seed.reach * lobes);
    return out + BORDER_WOBBLE * smooth(out, 0, 0.5) * (fbm(v, BORDER_FREQ, seed.id * 31 + 7) * 0.5 + 0.5);
}

/** The sea's claim: a constant with a coastline's worth of noise on it. */
export const oceanScore = (v: Vec3) => 1 + COAST_WOBBLE * fbm(v, COAST_FREQ, 1);

/** Past this angle a region's score is certainly above the sea's highest:
 *  the longest lobe, times the sea's highest score. */
const cutoff = (s: PreparedSeed) =>
    s.cap + s.reach * Math.exp(LOBE_2 + LOBE_3) * (1 + COAST_WOBBLE) + 1e-6;

// ---- the mesh -----------------------------------------------------------------

interface Mesh { verts: Vec3[]; tris: Uint32Array }

const meshCache = new Map<number, Mesh>();

/** A geodesic sphere: an icosahedron, each face split in four `level` times.
 *  Faces wound counter-clockwise seen from outside. */
export function icosphere(level: number): Mesh {
    const hit = meshCache.get(level);
    if (hit) return hit;
    const t = (1 + Math.sqrt(5)) / 2;
    const verts: Vec3[] = ([
        [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
        [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
        [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ] as Vec3[]).map(unit3);
    let faces: number[] = [
        0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
        1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
        3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
        4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
    ];
    for (let l = 0; l < level; l++) {
        const mid = new Map<number, number>();
        const midpoint = (a: number, b: number) => {
            const key = a < b ? a * 1e7 + b : b * 1e7 + a;
            let m = mid.get(key);
            if (m === undefined) {
                const p = verts[a], q = verts[b];
                m = verts.push(unit3([p[0] + q[0], p[1] + q[1], p[2] + q[2]])) - 1;
                mid.set(key, m);
            }
            return m;
        };
        const next: number[] = [];
        for (let i = 0; i < faces.length; i += 3) {
            const a = faces[i], b = faces[i + 1], c = faces[i + 2];
            const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
            next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
        }
        faces = next;
    }
    // Make every face counter-clockwise seen from outside, whatever the table
    // above got wrong: the loops' winding — and so which side of a border is
    // whose — is read off it.
    for (let i = 0; i < faces.length; i += 3) {
        const a = verts[faces[i]], b = verts[faces[i + 1]], c = verts[faces[i + 2]];
        const n: Vec3 = [
            (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
            (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        ];
        if (dot3(n, a) < 0) { const s = faces[i + 1]; faces[i + 1] = faces[i + 2]; faces[i + 2] = s; }
    }
    const mesh = { verts, tris: Uint32Array.from(faces) };
    meshCache.set(level, mesh);
    return mesh;
}

interface Adjacency { start: Uint32Array; list: Uint32Array }
const adjacencyCache = new Map<number, Adjacency>();

/** Each mesh vertex's neighbours, packed: `list[start[i] .. start[i+1])`. */
function neighboursOf(level: number): Adjacency {
    const hit = adjacencyCache.get(level);
    if (hit) return hit;
    const { verts, tris } = icosphere(level);
    const sets: Set<number>[] = verts.map(() => new Set<number>());
    for (let i = 0; i < tris.length; i += 3) {
        const a = tris[i], b = tris[i + 1], c = tris[i + 2];
        sets[a].add(b); sets[a].add(c);
        sets[b].add(a); sets[b].add(c);
        sets[c].add(a); sets[c].add(b);
    }
    const start = new Uint32Array(verts.length + 1);
    for (let i = 0; i < verts.length; i++) start[i + 1] = start[i] + sets[i].size;
    const list = new Uint32Array(start[verts.length]);
    sets.forEach((s, i) => { let k = start[i]; for (const j of s) list[k++] = j; });
    const adj = { start, list };
    adjacencyCache.set(level, adj);
    return adj;
}

function nearestVertex(verts: Vec3[], u: Vec3): number {
    let best = 0, bestDot = -Infinity;
    for (let i = 0; i < verts.length; i++) {
        const d = dot3(verts[i], u);
        if (d > bestDot) { bestDot = d; best = i; }
    }
    return best;
}

/**
 * The noise leaves specks: a crumb of one territory stranded across a border,
 * a pond two vertices wide in the middle of a continent, a rock off a coast.
 * Drawn, each is a sliver with a hard outline that means nothing — the eye
 * reads it as a place and there is no place there.
 *
 * So every connected piece of ground (or water) smaller than `SPECK` vertices
 * goes to whoever surrounds it — except the piece a region's own centre
 * stands on, which is the region itself however small it is. Done on the
 * labels, before any line is traced, so the fills and the borders and the
 * coasts are all traced from the same cleaned map and cannot disagree.
 */
export const SPECK = 14;
function sweepSpecks(owner: Int32Array, adj: Adjacency, homes: number[]) {
    const NV = owner.length;
    const piece = new Int32Array(NV).fill(-1);
    const keep = new Set(homes);
    const stack: number[] = [];
    let id = 0;
    for (let seed = 0; seed < NV; seed++) {
        if (piece[seed] !== -1) continue;
        const label = owner[seed];
        const members: number[] = [];
        stack.push(seed);
        piece[seed] = id;
        let home = false;
        while (stack.length) {
            const v = stack.pop()!;
            members.push(v);
            if (keep.has(v)) home = true;
            for (let k = adj.start[v]; k < adj.start[v + 1]; k++) {
                const n = adj.list[k];
                if (piece[n] === -1 && owner[n] === label) { piece[n] = id; stack.push(n); }
            }
        }
        id++;
        if (home || members.length >= SPECK) continue;
        // Whoever holds most of the shore around it takes it.
        const votes = new Map<number, number>();
        for (const v of members) {
            for (let k = adj.start[v]; k < adj.start[v + 1]; k++) {
                const o = owner[adj.list[k]];
                if (o !== label) votes.set(o, (votes.get(o) ?? 0) + 1);
            }
        }
        let winner = label, most = 0;
        for (const [o, n] of votes) if (n > most || (n === most && o < winner)) { most = n; winner = o; }
        for (const v of members) owner[v] = winner;
    }
}

// ---- lines ----------------------------------------------------------------------

function lineOf(points: Vec3[], closed: boolean): SphereLine {
    const pts = new Float64Array(points.length * 3);
    let sx = 0, sy = 0, sz = 0;
    points.forEach((p, i) => {
        pts[i * 3] = p[0]; pts[i * 3 + 1] = p[1]; pts[i * 3 + 2] = p[2];
        sx += p[0]; sy += p[1]; sz += p[2];
    });
    const centre = unit3([sx, sy, sz]);
    let reach = 0;
    for (const p of points) reach = Math.max(reach, angleBetween(centre, p));
    return { pts, closed, centre, reach };
}

/**
 * Build the land.
 *
 * @param seeds every region: its id, centre and cap.
 * @param level the mesh's subdivision level — lower only in a test that wants
 *   it fast; the view uses `MESH_LEVEL`.
 */
export function buildTerrain(seeds: TerritorySeed[], level = MESH_LEVEL): Terrain {
    const valid = seeds.filter(s => Number.isFinite(s.cap) && s.cap > 0).map(prepareSeed);
    const cutCos = valid.map(s => Math.cos(Math.min(Math.PI, cutoff(s))));
    const byId = new Map(valid.map(s => [s.id, s]));

    const scoreOf = (label: number, v: Vec3) =>
        label === OCEAN ? oceanScore(v) : territoryScore(byId.get(label)!, v);

    const ownerAt = (v: Vec3): number => {
        let best = OCEAN, bestScore = Infinity;
        for (let i = 0; i < valid.length; i++) {
            if (dot3(v, valid[i].u) < cutCos[i]) continue;
            const s = territoryScore(valid[i], v);
            if (s < bestScore) { bestScore = s; best = valid[i].id; }
        }
        if (best === OCEAN) return OCEAN;
        return bestScore < oceanScore(v) ? best : OCEAN;
    };

    const { verts, tris } = icosphere(level);
    const NV = verts.length;
    const owner = new Int32Array(NV);
    for (let i = 0; i < NV; i++) owner[i] = ownerAt(verts[i]);
    sweepSpecks(owner, neighboursOf(level), valid.map(s => nearestVertex(verts, s.u)));
    let land = 0;
    for (let i = 0; i < NV; i++) if (owner[i] !== OCEAN) land++;

    // Every point a border passes through, by key: a crossing on an edge is
    // keyed by the edge, a junction by its triangle — so both sides of a line
    // are built from the same points.
    const points = new Map<number, Vec3>();
    const edgeKey = (p: number, q: number) => (p < q ? p * NV + q : q * NV + p);
    const crossing = (p: number, q: number): number => {
        const key = edgeKey(p, q);
        if (points.has(key)) return key;
        const A = owner[p], B = owner[q];
        const vp = verts[p], vq = verts[q];
        // Where the two claims are equal, linearly along the edge.
        const fp = scoreOf(A, vp) - scoreOf(B, vp);
        const fq = scoreOf(A, vq) - scoreOf(B, vq);
        let t = fp - fq !== 0 ? fp / (fp - fq) : 0.5;
        t = Math.max(0.02, Math.min(0.98, t));
        points.set(key, unit3([
            vp[0] + (vq[0] - vp[0]) * t, vp[1] + (vq[1] - vp[1]) * t, vp[2] + (vq[2] - vp[2]) * t,
        ]));
        return key;
    };
    const junction = (tri: number, k1: number, k2: number, k3: number): number => {
        const key = NV * NV + tri;
        const a = points.get(k1)!, b = points.get(k2)!, c = points.get(k3)!;
        points.set(key, unit3([a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]]));
        return key;
    };

    // Directed segments, `from → to` with `left` on the left seen from outside.
    const segs: { from: number; to: number; left: number; right: number }[] = [];
    const nT = tris.length / 3;
    for (let t = 0; t < nT; t++) {
        let a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
        const la0 = owner[a], lb0 = owner[b], lc0 = owner[c];
        if (la0 === lb0 && lb0 === lc0) continue;
        if (la0 !== lb0 && lb0 !== lc0 && la0 !== lc0) {
            const ab = crossing(a, b), bc = crossing(b, c), ca = crossing(c, a);
            const o = junction(t, ab, bc, ca);
            const A = la0, B = lb0, C = lc0;
            segs.push({ from: ab, to: o, left: A, right: B });
            segs.push({ from: o, to: ca, left: A, right: C });
            segs.push({ from: bc, to: o, left: B, right: C });
            segs.push({ from: o, to: ab, left: B, right: A });
            segs.push({ from: ca, to: o, left: C, right: A });
            segs.push({ from: o, to: bc, left: C, right: B });
            continue;
        }
        // Two owners: rotate so that `c` is the odd one out, keeping the winding.
        if (lb0 === lc0) { [a, b, c] = [b, c, a]; }          // a was odd
        else if (la0 === lc0) { [a, b, c] = [c, a, b]; }     // b was odd
        const A = owner[a], B = owner[c];
        const bc = crossing(b, c), ca = crossing(c, a);
        segs.push({ from: bc, to: ca, left: A, right: B });
        segs.push({ from: ca, to: bc, left: B, right: A });
    }

    const pointsOf = (keys: number[]) => keys.map(k => points.get(k)!);

    // Territories: chain each owner's own segments into loops.
    const nextByOwner = new Map<number, Map<number, number>>();
    for (const s of segs) {
        if (s.left === OCEAN) continue;
        let m = nextByOwner.get(s.left);
        if (!m) nextByOwner.set(s.left, m = new Map());
        m.set(s.from, s.to);
    }
    const territories: Territory[] = [];
    for (const seed of valid) {
        const next = nextByOwner.get(seed.id);
        const loops: SphereLine[] = [];
        if (next) {
            const seen = new Set<number>();
            for (const start of next.keys()) {
                if (seen.has(start)) continue;
                const keys: number[] = [];
                let k: number | undefined = start;
                while (k !== undefined && !seen.has(k)) {
                    seen.add(k);
                    keys.push(k);
                    k = next.get(k);
                }
                // A loop that did not come back to its start is a fault in the
                // tracing, not a shape; drawn, it would fill a wedge of planet.
                if (k === start && keys.length >= 3) loops.push(lineOf(pointsOf(keys), true));
            }
        }
        territories.push({ id: seed.id, loops });
    }

    // Borders and coasts: each line once, from its lower-numbered side, chained
    // per pair of owners. Chains end at junctions or close on themselves.
    const groups = new Map<string, Map<number, number>>();
    const pairOf = new Map<string, [number, number]>();
    for (const s of segs) {
        if (!(s.left < s.right)) continue;
        const id = `${s.left}|${s.right}`;
        let m = groups.get(id);
        if (!m) { groups.set(id, m = new Map()); pairOf.set(id, [s.left, s.right]); }
        m.set(s.from, s.to);
    }
    const borders: Border[] = [];
    const coasts: Border[] = [];
    for (const [id, next] of groups) {
        const [a, b] = pairOf.get(id)!;
        const ends = new Set(next.values());
        const seen = new Set<number>();
        const walk = (start: number) => {
            const keys: number[] = [];
            let k: number | undefined = start;
            while (k !== undefined && !seen.has(k)) {
                seen.add(k);
                keys.push(k);
                k = next.get(k);
            }
            const closed = k === start;
            if (k !== undefined && !closed) keys.push(k);
            if (keys.length < 2) return;
            const line = lineOf(pointsOf(keys), closed);
            (a === OCEAN ? coasts : borders).push({ a, b, line });
        };
        // Open chains first, from the ends nothing leads into…
        for (const start of next.keys()) if (!ends.has(start) && !seen.has(start)) walk(start);
        // …then whatever is left is loops.
        for (const start of next.keys()) if (!seen.has(start)) walk(start);
    }

    const waterlines: Terrain['waterlines'] = [];
    for (const c of coasts) {
        for (let ring = 1; ring <= WATERLINES; ring++) {
            const line = offsetSeaward(c.line, WATERLINE_STEP * ring);
            if (line) waterlines.push({ b: c.b, ring, line });
        }
    }

    return { territories, borders, coasts, waterlines, ownerAt, landShare: NV ? land / NV : 0 };
}

/** How many waterlines, and how far apart, in radians. */
export const WATERLINES = 2;
export const WATERLINE_STEP = 0.013;

/**
 * A coast moved `d` radians out to sea. A coast is traced with the sea on its
 * LEFT (seen from outside), so seaward at a point is `p × tangent`. The result
 * is smoothed twice, because an offset of a jagged line is jaggier than the
 * line: at every inside corner the two sides' offsets cross.
 */
function offsetSeaward(line: SphereLine, d: number): SphereLine | null {
    const src = line.pts;
    const n = src.length / 3;
    if (n < 3) return null;
    const at = (i: number): Vec3 => [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]];
    let pts: Vec3[] = [];
    for (let i = 0; i < n; i++) {
        const p = at(i);
        const prev = line.closed ? at((i - 1 + n) % n) : at(Math.max(0, i - 1));
        const next = line.closed ? at((i + 1) % n) : at(Math.min(n - 1, i + 1));
        const t: Vec3 = [next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]];
        const left = unit3([p[1] * t[2] - p[2] * t[1], p[2] * t[0] - p[0] * t[2], p[0] * t[1] - p[1] * t[0]]);
        pts.push(unit3([p[0] + left[0] * d, p[1] + left[1] * d, p[2] + left[2] * d]));
    }
    for (let pass = 0; pass < 2; pass++) {
        pts = pts.map((p, i) => {
            if (!line.closed && (i === 0 || i === n - 1)) return p;
            const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
            return unit3([a[0] + 2 * p[0] + b[0], a[1] + 2 * p[1] + b[1], a[2] + 2 * p[2] + b[2]]);
        });
    }
    return lineOf(pts, line.closed);
}
