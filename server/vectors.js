// server/vectors.js — the arithmetic both atlas layouts are built on.
//
// Split out of `atlas.js` when the globe arrived, because the sphere needs the
// same four things the plane does — a dot product, a normaliser, a
// deterministic power iteration and a nearest-neighbour list — and the
// alternative was either a second copy of each (which drifts) or `globe.js`
// importing `atlas.js` back (which is a cycle, and one `node --check` cannot
// see). Nothing here knows about regions, topics or screens: it takes arrays of
// numbers and returns arrays of numbers, which is also what makes it checkable
// from a gate without a database.

// Both sides are unit vectors (nodeEmbeddings normalises on write), so the dot
// product IS the cosine. Nothing here re-normalises; if that ever changes, this
// is the assumption that breaks.
/**
 * The layout's tuned constants, shared by both surfaces.
 *
 * The plane and the sphere run the same refinement — the same neighbour count,
 * the same tether back to the projection, the same iteration budget — and each
 * had its own copy asserting in a comment that it matched the other's. A
 * measurement that was taken once belongs in one place: re-tuning `NEIGHBOURS`
 * means re-running the neighbourhood-score measurement (it is not monotone: k=8
 * collapses the flat map into two clumps and scores 0.10 against k=3's 0.31), and
 * the budget exists because the pass is O(n² · iterations) on the request path,
 * in the process that also serves every SSE stream.
 */
export const LAYOUT_NEIGHBOURS = 3;
export const LAYOUT_ANCHOR = 0.12;
export const LAYOUT_BUDGET = 3e6;
export const LAYOUT_MIN_ITERATIONS = 40;
export const LAYOUT_MAX_ITERATIONS = 220;
/**
 * How much of the drawing the regions together cover — a share of the canvas on
 * the sheet, of the whole sphere on the globe. Enough that it reads as a map
 * rather than a scatter plot, little enough that the relaxation has somewhere to
 * put things. A reader sees half a sphere at a time, so a third of the sphere is
 * a third of what is in front of them, which is how the flat number transfers.
 */
export const INK_SHARE = 0.32;

export function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

export function normalizeInto(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    const n = Math.sqrt(s);
    if (!n || !Number.isFinite(n)) return false;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return true;
}

// Deterministic pseudo-random start vector. A basis vector (e.g. [1,0,0…]) can
// sit exactly in the null space of the covariance and stall power iteration, so
// the start is spread across every dimension — but it must be the SAME spread
// on every build, or the map would rotate between page loads.
export function seededVector(dim) {
    const v = new Float64Array(dim);
    let s = 42;
    for (let i = 0; i < dim; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        v[i] = (s / 0x7fffffff) - 0.5;
    }
    return v;
}

export function powerIteration(rows, dim, iterations = 64) {
    let v = seededVector(dim);
    let norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    for (let i = 0; i < dim; i++) v[i] /= norm;

    for (let it = 0; it < iterations; it++) {
        // w = Mᵀ(Mv) — the covariance applied without ever materialising it.
        const proj = rows.map(row => {
            let s = 0;
            for (let d = 0; d < dim; d++) s += row[d] * v[d];
            return s;
        });
        const w = new Float64Array(dim);
        for (let r = 0; r < rows.length; r++) {
            const p = proj[r], row = rows[r];
            for (let d = 0; d < dim; d++) w[d] += p * row[d];
        }
        norm = Math.sqrt(w.reduce((a, x) => a + x * x, 0));
        if (!norm || !Number.isFinite(norm)) return null;   // no variance left
        for (let d = 0; d < dim; d++) w[d] /= norm;
        v = w;
    }
    return v;
}

/**
 * Deflate `rows` along `v` so the next component found is genuinely orthogonal
 * to it. Mutates in place, which is what both callers want.
 */
export function deflate(rows, v, dim) {
    for (const row of rows) {
        let p = 0;
        for (let d = 0; d < dim; d++) p += row[d] * v[d];
        for (let d = 0; d < dim; d++) row[d] -= p * v[d];
    }
}

/**
 * Each item's `k` nearest others by cosine, most similar first.
 *
 * Stable: ties break on index, so a layout built on this cannot depend on sort
 * implementation details — which is half of what makes the atlas draw the same
 * picture every visit.
 */
export function nearestNeighbours(items, k, key = 'centroid') {
    const n = items.length;
    const lists = [];
    for (let i = 0; i < n; i++) {
        const scored = [];
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            scored.push({ j, sim: dot(items[i][key], items[j][key]) });
        }
        scored.sort((a, b) => b.sim - a.sim || a.j - b.j);
        lists.push(scored.slice(0, k));
    }
    return lists;
}
