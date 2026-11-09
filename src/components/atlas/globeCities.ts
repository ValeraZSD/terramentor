/**
 * Every country cut into CITIES of about the same size, one per topic.
 *
 * Zoomed out, the atlas is countries: one region, one territory
 * (`globeTerritories.ts`). Zoomed in, each country resolves into the topics it
 * holds, and a topic is a place with a border of its own rather than a dot on
 * open ground. The cities fill the whole country and are about one size: a
 * city is ONE topic, so a big one would say "this topic is bigger" and a sliver
 * would say "this one barely counts", and neither is true.
 *
 * Nearest-topic cells (the first try) broke that rule — a lone topic got a huge
 * city and a tight cluster a crowd of slivers. Here each country is unrolled
 * onto its own flat equal-area patch (Lambert azimuthal, centred on the
 * region), sampled on a triangular lattice, and split by a capacity-constrained
 * power diagram (Balzer et al. 2009): seeds start at the topics, every round
 * moves each seed to the middle of its cell and grows a cell that is short of
 * its share, until every city holds about the same number of samples. The
 * samples are measured through a smooth warp, so the cells come out as
 * irregular blobs rather than a honeycomb. The lattice runs past the coast and
 * the drawing clips the cities to the country's own outline, so a city's outer
 * edge IS the border.
 *
 * A country is cut by `buildCountryCities`; the map asks for the whole library
 * at once (`buildCities`, in a worker: `cityBuild.ts`), because that is about a
 * second of work (1.0 s for 2,490 topics in 129 countries on a desktop CPU)
 * that must never stop the page.
 */
import { Vec3, unit3, tangentBasis } from './globeProjection';
import { SphereLine, Territory, lineOf } from './globeTerritories';

export interface City { id: number; loops: SphereLine[] }

export interface CountryCities {
    /** One per topic, `id` being the topic's. */
    cities: City[];
    /** Every line between two cities of this country, stroked once. */
    borders: SphereLine[];
    /** Where each topic's dot goes: well inside its own city. */
    centres: Map<number, Vec3>;
    /** The angular radius of a circle as big as one city — what a city's
     *  name is sized against. */
    cityAngle: number;
    /** Largest city over smallest, counted inside the country (1 below two). */
    spread: number;
}

/** Lattice samples per city. Fewer and the borders go blocky; more is time. */
const SAMPLES_PER_CITY = 45;
/** Rounds of the share-out, plus more for a bigger country (see below). */
const ROUNDS = 24;
/** The last rounds only grow and shrink cells, no moving: they settle the sizes. */
const SETTLE = 8;
/** The lattice's outer ring: a label of its own, so every city's loop closes. */
const EDGE = -1;
/** How far the warp moves a sample, as a share of a city's radius. Above about
 *  0.25 the waves fold back on themselves and make snakes and enclaves. */
const WARP = 0.16;

function rng(seed: number) {
    let s = (Math.imul(seed + 1, 2654435761) >>> 0) || 1;
    return () => {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

/** A country's own flat patch: Lambert azimuthal equal-area around `c`, so an
 *  equal share of the patch is an equal share of the ground. */
export function equalAreaPatch(c: Vec3) {
    const [e1, e2] = tangentBasis(c);
    const to = (x: number, y: number, z: number): [number, number] => {
        const d = x * c[0] + y * c[1] + z * c[2];
        const wx = x - d * c[0], wy = y - d * c[1], wz = z - d * c[2];
        const s = Math.hypot(wx, wy, wz);
        if (s < 1e-12) return [0, 0];
        const rho = Math.sqrt(Math.max(0, 2 * (1 - d))) / s;
        return [rho * (wx * e1[0] + wy * e1[1] + wz * e1[2]), rho * (wx * e2[0] + wy * e2[1] + wz * e2[2])];
    };
    const from = (x: number, y: number): Vec3 => {
        const rho = Math.hypot(x, y);
        if (rho < 1e-12) return c;
        const th = 2 * Math.asin(Math.min(1, rho / 2));
        const ct = Math.cos(th), st = Math.sin(th) / rho;
        return unit3([
            ct * c[0] + st * (x * e1[0] + y * e2[0]),
            ct * c[1] + st * (x * e1[1] + y * e2[1]),
            ct * c[2] + st * (x * e1[2] + y * e2[2]),
        ]);
    };
    return { to, from };
}

/**
 * One country's cities.
 *
 * `centre` is the region's own direction (the patch is unrolled around it) and
 * `seed` makes the borders' wander the same on every visit. Null when the
 * country is too small or too strange to cut — the caller then draws it whole,
 * with its dots where they were.
 */
export function buildCountryCities(
    territory: Territory,
    centre: Vec3,
    topics: { id: number; u: Vec3 }[],
    seed: number,
): CountryCities | null {
    const N = topics.length;
    if (!territory.loops.length || !N) return null;
    const { to, from } = equalAreaPatch(centre);

    // The country's outline on the patch, and its area.
    const polys = territory.loops.map(l => {
        const n = l.pts.length / 3, a = new Float64Array(n * 2);
        for (let i = 0; i < n; i++) {
            const [x, y] = to(l.pts[i * 3], l.pts[i * 3 + 1], l.pts[i * 3 + 2]);
            a[i * 2] = x; a[i * 2 + 1] = y;
        }
        return a;
    });
    let signed = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const a of polys) {
        const n = a.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            signed += a[j * 2] * a[i * 2 + 1] - a[i * 2] * a[j * 2 + 1];
            minX = Math.min(minX, a[i * 2]); maxX = Math.max(maxX, a[i * 2]);
            minY = Math.min(minY, a[i * 2 + 1]); maxY = Math.max(maxY, a[i * 2 + 1]);
        }
    }
    // Lakes wind the other way, so the signed sum is land minus water.
    const area = Math.abs(signed) / 2;
    if (!(area > 0)) return null;
    const share = area / N, r0 = Math.sqrt(share / Math.PI);
    if (N === 1) {
        return {
            cities: [{ id: topics[0].id, loops: territory.loops }],
            borders: [],
            centres: new Map([[topics[0].id, topics[0].u]]),
            cityAngle: r0,
            spread: 1,
        };
    }

    // A triangular lattice over the outline, a little past it all round.
    const h = Math.sqrt((2 * share) / (Math.sqrt(3) * SAMPLES_PER_CITY));
    const dy = (h * Math.sqrt(3)) / 2, pad = 2 * h;
    const cols = Math.ceil((maxX - minX + 2 * pad) / h) + 2;
    const rows = Math.ceil((maxY - minY + 2 * pad) / dy) + 2;
    const V = rows * cols;
    const px = new Float64Array(V), py = new Float64Array(V);
    const qx = new Float64Array(V), qy = new Float64Array(V);
    const inside = new Uint8Array(V);

    // The warp: three slow waves a side, so borders wander like real ones.
    const rand = rng(seed);
    const waves = Array.from({ length: 6 }, () => {
        const ang = rand() * Math.PI * 2, k = (2 * Math.PI) / (r0 * (4 + 2 * rand()));
        return { kx: Math.cos(ang) * k, ky: Math.sin(ang) * k, ph: rand() * Math.PI * 2 };
    });
    // Three waves of slope amp·k ≤ 0.25 each: the warp never folds back on
    // itself, which is what made snaking cells and enclaves.
    const amp = WARP * r0;
    const warp = (x: number, y: number): [number, number] => {
        let wx = 0, wy = 0;
        for (let j = 0; j < 3; j++) wx += Math.sin(waves[j].kx * x + waves[j].ky * y + waves[j].ph);
        for (let j = 3; j < 6; j++) wy += Math.sin(waves[j].kx * x + waves[j].ky * y + waves[j].ph);
        return [x + amp * wx, y + amp * wy];
    };

    for (let r = 0; r < rows; r++) {
        const y = minY - pad + r * dy;
        // Even-odd along the row: where it crosses the outline, sorted.
        const xs: number[] = [];
        for (const a of polys) {
            const n = a.length / 2;
            for (let i = 0, j = n - 1; i < n; j = i++) {
                const y1 = a[j * 2 + 1], y2 = a[i * 2 + 1];
                if ((y1 <= y) !== (y2 <= y)) xs.push(a[j * 2] + ((y - y1) * (a[i * 2] - a[j * 2])) / (y2 - y1));
            }
        }
        xs.sort((m, n) => m - n);
        let k = 0;
        for (let c = 0; c < cols; c++) {
            const v = r * cols + c;
            const x = minX - pad + c * h + (r & 1 ? h / 2 : 0);
            px[v] = x; py[v] = y;
            [qx[v], qy[v]] = warp(x, y);
            while (k < xs.length && xs[k] < x) k++;
            inside[v] = k & 1;
        }
    }
    const samples: number[] = [];
    for (let v = 0; v < V; v++) if (inside[v]) samples.push(v);
    if (samples.length < N * 3) return null;

    // Seeds where the topics are; a power weight each.
    const sx = new Float64Array(N), sy = new Float64Array(N), w = new Float64Array(N);
    topics.forEach((t, i) => {
        const [x, y] = to(t.u[0], t.u[1], t.u[2]);
        [sx[i], sy[i]] = warp(x, y);
    });
    // A bucket grid over the seeds, so "nearest" looks at nine cells and not
    // at every seed in the country.
    const G = 3 * r0;
    let gx0 = 0, gy0 = 0, gc = 1, grid = new Map<number, number[]>();
    const bucket = () => {
        gx0 = Infinity; gy0 = Infinity; let gx1 = -Infinity;
        for (let i = 0; i < N; i++) { gx0 = Math.min(gx0, sx[i]); gy0 = Math.min(gy0, sy[i]); gx1 = Math.max(gx1, sx[i]); }
        gx0 -= G; gy0 -= G; gc = Math.ceil((gx1 - gx0 + 2 * G) / G) + 1;
        grid = new Map();
        for (let i = 0; i < N; i++) {
            const key = Math.floor((sy[i] - gy0) / G) * gc + Math.floor((sx[i] - gx0) / G);
            const b = grid.get(key);
            if (b) b.push(i); else grid.set(key, [i]);
        }
    };
    const nearest = (x: number, y: number): number => {
        const cx = Math.floor((x - gx0) / G), cy = Math.floor((y - gy0) / G);
        let best = -1, bd = Infinity;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
            if (cx + i < 0 || cx + i >= gc) continue;
            const b = grid.get((cy + j) * gc + cx + i);
            if (!b) continue;
            for (const s of b) {
                const d = (x - sx[s]) ** 2 + (y - sy[s]) ** 2 - w[s];
                if (d < bd) { bd = d; best = s; }
            }
        }
        if (best >= 0) return best;
        for (let s = 0; s < N; s++) {
            const d = (x - sx[s]) ** 2 + (y - sy[s]) ** 2 - w[s];
            if (d < bd) { bd = d; best = s; }
        }
        return best;
    };

    const target = samples.length / N;
    const cnt = new Int32Array(N), mx = new Float64Array(N), my = new Float64Array(N);
    // A share is passed on neighbour to neighbour, so a big country needs more
    // rounds before its far side hears about it.
    const rounds = ROUNDS + Math.ceil(3 * Math.sqrt(N));
    for (let round = 0; round < rounds; round++) {
        bucket();
        cnt.fill(0); mx.fill(0); my.fill(0);
        for (const v of samples) {
            const s = nearest(qx[v], qy[v]);
            cnt[s]++; mx[s] += qx[v]; my[s] += qy[v];
        }
        let big = 0;
        for (let i = 1; i < N; i++) if (cnt[i] > cnt[big]) big = i;
        for (let i = 0; i < N; i++) {
            if (cnt[i] === 0) {
                // A seed squeezed out: restart it beside the fullest city.
                sx[i] = sx[big] + (rand() - 0.5) * r0; sy[i] = sy[big] + (rand() - 0.5) * r0; w[i] = w[big];
                continue;
            }
            if (round < rounds - SETTLE) { sx[i] = mx[i] / cnt[i]; sy[i] = my[i] / cnt[i]; }
            // Raising a weight by Δw moves the cell's edge out by about Δw/4r0
            // all round, ~(π/2)·Δw of area: 2r0² per whole share, damped
            // because the neighbours move at the same time.
            w[i] += 1.2 * ((target - cnt[i]) / target) * r0 * r0;
        }
    }

    // Every lattice point labelled (the outer ring closes the loops).
    const label = new Int32Array(V);
    bucket();
    const inCity = new Int32Array(N), ax = new Float64Array(N), ay = new Float64Array(N);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const v = r * cols + c;
        if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) { label[v] = EDGE; continue; }
        const s = nearest(qx[v], qy[v]);
        label[v] = s;
        if (inside[v]) { inCity[s]++; ax[s] += px[v]; ay[s] += py[v]; }
    }
    let lo = Infinity, hi = 0;
    for (let i = 0; i < N; i++) if (inCity[i]) { lo = Math.min(lo, inCity[i]); hi = Math.max(hi, inCity[i]); }

    // Where the dot goes: the sample DEEPEST inside its own city — the most
    // lattice steps from any other city and from the coast — and of those the
    // one nearest the city's middle. The middle itself can fall outside a
    // crescent-shaped city, and a dot on a border or a shore belongs to two
    // places. Depth is a breadth-first walk in from every edge.
    const depth = new Int32Array(V).fill(-1);
    const neighbours = (v: number, f: (u: number) => void) => {
        const r = (v / cols) | 0, c = v - r * cols, odd = r & 1;
        if (c > 0) f(v - 1);
        if (c + 1 < cols) f(v + 1);
        for (const rr of [r - 1, r + 1]) {
            if (rr < 0 || rr >= rows) continue;
            const c0 = odd ? c : c - 1;
            if (c0 >= 0) f(rr * cols + c0);
            if (c0 + 1 < cols) f(rr * cols + c0 + 1);
        }
    };
    let queue: number[] = [];
    for (const v of samples) {
        let edge = false;
        neighbours(v, u => { if (!inside[u] || label[u] !== label[v]) edge = true; });
        if (edge) { depth[v] = 0; queue.push(v); }
    }
    while (queue.length) {
        const next: number[] = [];
        for (const v of queue) neighbours(v, u => {
            if (depth[u] < 0 && inside[u] && label[u] === label[v]) { depth[u] = depth[v] + 1; next.push(u); }
        });
        queue = next;
    }
    const pick = new Int32Array(N).fill(-1), pickDepth = new Int32Array(N).fill(-1), pickD = new Float64Array(N).fill(Infinity);
    for (const v of samples) {
        const s = label[v];
        if (s < 0 || !inCity[s]) continue;
        const mxs = ax[s] / inCity[s], mys = ay[s] / inCity[s];
        const d = (px[v] - mxs) ** 2 + (py[v] - mys) ** 2;
        if (depth[v] > pickDepth[s] || (depth[v] === pickDepth[s] && d < pickD[s])) {
            pick[s] = v; pickDepth[s] = depth[v]; pickD[s] = d;
        }
    }
    const centres = new Map<number, Vec3>();
    for (let i = 0; i < N; i++) {
        centres.set(topics[i].id, pick[i] >= 0 ? from(px[pick[i]], py[pick[i]]) : topics[i].u);
    }

    // Trace: the same crossing-and-junction walk as the territories.
    const pts = new Map<number, [number, number]>();
    const powerGap = (v: number, a: number, b: number) =>
        ((qx[v] - sx[b]) ** 2 + (qy[v] - sy[b]) ** 2 - w[b]) - ((qx[v] - sx[a]) ** 2 + (qy[v] - sy[a]) ** 2 - w[a]);
    const crossing = (p: number, q: number): number => {
        const key = p < q ? p * V + q : q * V + p;
        if (pts.has(key)) return key;
        const A = label[p], B = label[q];
        let t = 0.5;
        if (A !== EDGE && B !== EDGE) {
            const fp = powerGap(p, A, B), fq = powerGap(q, A, B);
            t = fp - fq !== 0 ? fp / (fp - fq) : 0.5;
            t = Math.max(0.02, Math.min(0.98, t));
        }
        pts.set(key, [px[p] + (px[q] - px[p]) * t, py[p] + (py[q] - py[p]) * t]);
        return key;
    };
    const segs: { from: number; to: number; left: number; right: number }[] = [];
    const tri = (a: number, b: number, c: number, id: number) => {
        const la = label[a], lb = label[b], lc = label[c];
        if (la === lb && lb === lc) return;
        if (la !== lb && lb !== lc && la !== lc) {
            const ab = crossing(a, b), bc = crossing(b, c), ca = crossing(c, a);
            const o = V * V + id;
            const P = pts.get(ab)!, Q = pts.get(bc)!, R = pts.get(ca)!;
            pts.set(o, [(P[0] + Q[0] + R[0]) / 3, (P[1] + Q[1] + R[1]) / 3]);
            segs.push({ from: ab, to: o, left: la, right: lb }, { from: o, to: ca, left: la, right: lc },
                { from: bc, to: o, left: lb, right: lc }, { from: o, to: ab, left: lb, right: la },
                { from: ca, to: o, left: lc, right: la }, { from: o, to: bc, left: lc, right: lb });
            return;
        }
        if (lb === lc) [a, b, c] = [b, c, a];
        else if (la === lc) [a, b, c] = [c, a, b];
        const bc = crossing(b, c), ca = crossing(c, a);
        segs.push({ from: bc, to: ca, left: label[a], right: label[c] }, { from: ca, to: bc, left: label[c], right: label[a] });
    };
    let id = 0;
    for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
        const v = r * cols + c, up = (r + 1) * cols + c;
        if (r & 1) { tri(v, up + 1, up, id++); tri(v, v + 1, up + 1, id++); }
        else { tri(v, v + 1, up, id++); tri(v + 1, up + 1, up, id++); }
    }
    const sphere = (keys: number[]) => keys.map(k => { const [x, y] = pts.get(k)!; return from(x, y); });

    const nextOf = new Map<number, Map<number, number>>();
    for (const s of segs) {
        if (s.left === EDGE) continue;
        let m = nextOf.get(s.left);
        if (!m) nextOf.set(s.left, m = new Map());
        m.set(s.from, s.to);
    }
    const cities: City[] = [];
    for (const [i, next] of nextOf) {
        const loops: SphereLine[] = [];
        const seen = new Set<number>();
        for (const start of next.keys()) {
            if (seen.has(start)) continue;
            const keys: number[] = [];
            let k: number | undefined = start;
            while (k !== undefined && !seen.has(k)) { seen.add(k); keys.push(k); k = next.get(k); }
            if (k === start && keys.length >= 3) loops.push(lineOf(sphere(keys), true));
        }
        if (loops.length) cities.push({ id: topics[i].id, loops });
    }
    // Each border between two cities once: walked from a free end where it has
    // one, and round where it closes on itself.
    const pairs = new Map<number, Map<number, number>>();
    for (const s of segs) {
        if (s.left === EDGE || s.right === EDGE || !(s.left < s.right)) continue;
        const key = s.left * N + s.right;
        let m = pairs.get(key);
        if (!m) pairs.set(key, m = new Map());
        m.set(s.from, s.to);
    }
    const borders: SphereLine[] = [];
    for (const next of pairs.values()) {
        const ends = new Set(next.values()), seen = new Set<number>();
        const walk = (start: number) => {
            const keys: number[] = [];
            let k: number | undefined = start;
            while (k !== undefined && !seen.has(k)) { seen.add(k); keys.push(k); k = next.get(k); }
            const closed = k === start;
            if (k !== undefined && !closed) keys.push(k);
            if (keys.length >= 2) borders.push(lineOf(sphere(keys), closed));
        };
        for (const start of next.keys()) if (!ends.has(start) && !seen.has(start)) walk(start);
        for (const start of next.keys()) if (!seen.has(start)) walk(start);
    }
    return { cities, borders, centres, cityAngle: r0, spread: lo > 0 && Number.isFinite(lo) ? hi / lo : 1 };
}

/** Every country at once: what the worker (`citiesWorker.ts`) runs for the map,
 *  and what a page with no worker runs after its first frame. */
export function buildCities(
    territories: Territory[],
    regions: { id: number; u: Vec3; topics: { id: number; u: Vec3 }[] }[],
): Map<number, CountryCities> {
    const land = new Map(territories.map(t => [t.id, t]));
    const out = new Map<number, CountryCities>();
    for (const r of regions) {
        const t = land.get(r.id);
        if (!t) continue;
        const built = buildCountryCities(t, r.u, r.topics, r.id);
        if (built) out.set(r.id, built);
    }
    return out;
}
