// tools/globe-gates.mjs — Terra: the atlas drawn on a sphere.
//
// Run:  node tools/globe-gates.mjs
//
// Why this exists: every way a globe can be wrong draws a picture rather than
// throwing. A cap whose ellipse has its axes the wrong way round is a smooth
// shape pointing the wrong direction. A tangent basis taken from the camera
// instead of from the point slides every topic inside its own region as the
// planet turns — which reads as a rendering glitch and is a geometry fault. A
// projection that keeps two components and normalises the third away puts the
// whole library on one great circle, and that looks deliberate.
//
// So the two halves are asserted directly: the SERVER's spherical layout (pure
// arithmetic on centroids — `server/globe.js`) and the CLIENT's projection
// (pure arithmetic on directions — `src/components/atlas/globeProjection.ts`,
// bundled with esbuild, no DOM needed).
//
// And the one claim the view is FOR is measured, not asserted by eye: on
// centroids with genuine three-dimensional structure, the sphere must preserve
// neighbourhoods better than the plane does. If it does not, the extra
// dimension is decoration.

import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

// `atlas.js` reaches the database on import (the flat layout is compared here),
// so both roots go to scratch first — never the learner's real library.
const scratch = mkdtempSync(join(tmpdir(), 'globe-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const cache = fileURLToPath(new URL('../node_modules/.cache', import.meta.url));
mkdirSync(cache, { recursive: true });
const bundle = join(mkdtempSync(join(cache, 'globe-gates-')), 'projection.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/atlas/globeProjection.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent',
});

const flightBundle = join(mkdtempSync(join(cache, 'globe-gates-')), 'flight.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/atlas/globeFlight.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: flightBundle, logLevel: 'silent',
});

const P = await import(`file:///${bundle.replace(/\\/g, '/')}`);
const F = await import(`file:///${flightBundle.replace(/\\/g, '/')}`);
const { globeLayout, capRadius, fibonacciSphere, angleBetween, neighbourhoodScore } =
    await import(new URL('../server/globe.js', import.meta.url).href);
const { layoutRegions } = await import(new URL('../server/atlas.js', import.meta.url).href);

let failed = 0, passed = 0;
const check = (label, cond, extra = '') => {
    if (cond) { passed++; console.log(`  ok    ${label}`); }
    else { failed++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const len = (v) => Math.hypot(v[0], v[1], v[2]);

// A deterministic spread of directions to test against — every quadrant, both
// poles, and the two places a tangent basis can degenerate.
const DIRS = [
    [0, 0, 1], [0, 0, -1], [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0],
    ...fibonacciSphere(37),
];

// ---- turning the planet -----------------------------------------------------
console.log('\n--- the camera');

check('a rotation keeps every direction on the sphere',
    DIRS.every(d => near(len(P.rotate(d, 0.7, -0.4)), 1, 1e-9)));

check('un-rotating undoes it exactly',
    DIRS.every(d => {
        const back = P.unrotate(P.rotate(d, 1.9, 0.6), 1.9, 0.6);
        return d.every((v, i) => near(v, back[i], 1e-9));
    }));

// At rest the world's north is straight up the screen. This is the whole reason
// the camera is two angles rather than a trackball: a planet whose north
// wanders is one a reader cannot navigate back across.
{
    const north = P.rotate([0, 0, 1], 0, 0);
    const p = P.project(north, 200, 200, 100);
    check('at rest, north is at the top of the screen', near(p.x, 200) && near(p.y, 100), JSON.stringify(p));
    check('…and yaw alone never moves it', (() => {
        const q = P.project(P.rotate([0, 0, 1], 2.4, 0), 200, 200, 100);
        return near(q.x, 200) && near(q.y, 100);
    })());
}

check('“face this region” actually faces it',
    DIRS.every(d => {
        const { yaw, pitch } = P.faceOn(d);
        const v = P.rotate(d, yaw, pitch);
        return near(v[2], 1, 1e-9);
    }));

check('the near side is the positive half and nothing else', (() => {
    const yaw = 0.9, pitch = 0.3;
    return DIRS.every(d => {
        const v = P.rotate(d, yaw, pitch);
        const faced = P.rotate(d, ...Object.values(P.faceOn(d)));
        // A point is drawn iff it is on the near side; `z` is that test, and it
        // must agree with the angle from the view axis.
        return (v[2] > 0) === (angleBetween(v, [0, 0, 1]) < Math.PI / 2) && near(faced[2], 1, 1e-9);
    });
})());

// ---- placing a topic on its cap ---------------------------------------------
console.log('\n--- topics on a cap');

check('a tangent basis is orthonormal at every direction, poles included',
    DIRS.every(d => {
        const [e1, e2] = P.tangentBasis(d);
        return near(len(e1), 1, 1e-9) && near(len(e2), 1, 1e-9)
            && near(P.dot3(e1, e2), 0, 1e-9)
            && near(P.dot3(e1, d), 0, 1e-9) && near(P.dot3(e2, d), 0, 1e-9);
    }));

// The basis is a property of WHERE the region is. If it ever depended on
// anything that moves, topics would slide inside their region as the planet
// turned — the fault this check exists to make impossible.
check('…and depends on the region alone, not on the camera',
    DIRS.every(d => {
        const a = P.tangentBasis(d), b = P.tangentBasis(d);
        return a[0].every((v, i) => v === b[0][i]) && a[1].every((v, i) => v === b[1][i]);
    }));

{
    const cap = 0.3;
    const offsets = [[0, 0], [1, 0], [0, 1], [-0.7, 0.7], [0.3, -0.2], [0.99, 0.01]];
    let inside = true, unit = true;
    for (const d of DIRS) {
        const [e1, e2] = P.tangentBasis(d);
        for (const [ox, oy] of offsets) {
            const p = P.capPoint(d, e1, e2, ox, oy, cap);
            if (!near(len(p), 1, 1e-9)) unit = false;
            if (angleBetween(d, p) > cap * P.CAP_FILL + 1e-9) inside = false;
        }
    }
    check('a placed topic is still on the sphere', unit);
    check('and never outside its own region', inside);
    check('the centre of a bubble is the centre of its cap', (() => {
        const [e1, e2] = P.tangentBasis([0.3, 0.5, 0.8]);
        const u = P.unit3([0.3, 0.5, 0.8]);
        const p = P.capPoint(u, e1, e2, 0, 0, cap);
        return p.every((v, i) => near(v, u[i], 1e-9));
    })());
    check('a topic further out in the bubble is further out on the cap', (() => {
        const u = P.unit3([0.2, -0.9, 0.3]);
        const [e1, e2] = P.tangentBasis(u);
        const a = angleBetween(u, P.capPoint(u, e1, e2, 0.25, 0, cap));
        const b = angleBetween(u, P.capPoint(u, e1, e2, 0.75, 0, cap));
        return b > a && near(b / a, 3, 1e-6);
    })());
    check('two topics keep their bearing from each other', (() => {
        // The arrangement INSIDE a region is the flat map's, and it has to
        // survive the trip onto the sphere: a pair side by side must stay side
        // by side, not rotate as the region moves.
        const u = P.unit3([0.6, 0.2, -0.5]);
        const [e1, e2] = P.tangentBasis(u);
        const a = P.capPoint(u, e1, e2, 0.5, 0, cap);
        const b = P.capPoint(u, e1, e2, 0, 0.5, cap);
        // Equal offsets, so equal distances from the centre and from each other
        // in the same ratio the flat disc has (√2, to a curvature correction).
        const r = angleBetween(a, b) / angleBetween(u, a);
        return r > 1.38 && r < 1.42;
    })());
}

check('the flat offsets are read straight out of the payload', (() => {
    const region = { x: 0.2, y: -0.4, radius: 0.1 };
    const o = P.topicOffset(region, { x: 0.25, y: -0.35 });
    const none = P.topicOffset({ x: 0, y: 0, radius: 0 }, { x: 5, y: 5 });
    return near(o[0], 0.5) && near(o[1], 0.5) && none[0] === 0 && none[1] === 0;
})());

// ---- the drawn cap ----------------------------------------------------------
console.log('\n--- a cap, projected');

// The point of the ellipse: a circle on a sphere is NOT a circle on screen. If
// these axes are ever equal away from the centre of the disc, caps near the
// limb bulge off the planet — the tell that a "3D" view is a flat picture.
{
    const R = 160, cx = 200, cy = 180, cap = 0.25;
    let onEllipse = true, worst = 0;
    for (const d of DIRS) {
        const v = P.rotate(d, 0.4, 0.2);
        if (v[2] <= 0.2) continue;                       // limb cases below
        const e = P.capEllipse(v, cap, cx, cy, R);
        const [e1, e2] = P.tangentBasis(v);
        for (let k = 0; k < 16; k++) {
            const a = (k / 16) * Math.PI * 2;
            // A point on the cap's rim, in view space, projected the ordinary way.
            const rim = P.capPoint(v, e1, e2, Math.cos(a), Math.sin(a), cap / P.CAP_FILL);
            const p = P.project(rim, cx, cy, R);
            // …and the same point in the ellipse's own frame: it must satisfy
            // (x/rx)² + (y/ry)² = 1.
            const dx = p.x - e.x, dy = p.y - e.y;
            const co = Math.cos(e.rotation), si = Math.sin(e.rotation);
            const u = (dx * co + dy * si) / e.rx, w = (-dx * si + dy * co) / e.ry;
            worst = Math.max(worst, Math.abs(Math.hypot(u, w) - 1));
            if (Math.abs(Math.hypot(u, w) - 1) > 1e-6) onEllipse = false;
        }
    }
    check('every point of a cap\'s rim lands on the drawn ellipse', onEllipse, `worst ${worst.toExponential(2)}`);

    check('a cap facing the reader is drawn round', (() => {
        const e = P.capEllipse([0, 0, 1], cap, cx, cy, R);
        return near(e.rx, e.ry, 1e-9) && near(e.x, cx) && near(e.y, cy);
    })());
    check('a cap at the limb is drawn as a sliver, not a circle', (() => {
        const e = P.capEllipse(P.unit3([0.02, 0, 1]).map((v, i) => [0.9998, 0, 0.02][i]), cap, cx, cy, R);
        return e.rx < e.ry * 0.05 && e.ry > R * 0.2;
    })());
    check('and a cap round the back reports itself as such',
        P.capEllipse([0, 0.3, -0.95], cap, cx, cy, R).facing < 0);
}

// ---- the spherical layout ---------------------------------------------------
console.log('\n--- the layout');

/**
 * A synthetic library with real three-dimensional structure: clusters at the
 * corners of a cube, embedded in a much higher-dimensional space the way real
 * topic vectors are. Two dimensions genuinely cannot hold this — the eight
 * corners have no planar arrangement that keeps every neighbour adjacent — so
 * it is the fixture that can tell a third component from a decoration.
 */
function cubeRegions(perCorner = 4, dim = 48) {
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push([(i & 1) ? 1 : -1, (i & 2) ? 1 : -1, (i & 4) ? 1 : -1]);
    const regions = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (const c of corners) {
        for (let k = 0; k < perCorner; k++) {
            const v = new Float64Array(dim);
            for (let d = 0; d < 3; d++) v[d] = c[d] + rnd() * 0.25;
            for (let d = 3; d < dim; d++) v[d] = rnd() * 0.05;
            let n = 0; for (let d = 0; d < dim; d++) n += v[d] * v[d];
            n = Math.sqrt(n); for (let d = 0; d < dim; d++) v[d] /= n;
            regions.push({ centroid: v, members: Array.from({ length: 3 + k }, () => ({})) });
        }
    }
    return regions;
}

const regions = cubeRegions();
const globe = await globeLayout(regions);

check('every region gets a direction on the unit sphere',
    globe.dirs.length === regions.length && globe.dirs.every(d => near(len(d), 1, 1e-9)));
check('…and a finite angular radius inside its bounds',
    globe.caps.every(c => Number.isFinite(c) && c > 0 && c < Math.PI / 2));
check('no coordinate is NaN', globe.dirs.every(d => d.every(Number.isFinite)));

// The map's determinism claim, which the globe has to carry too: the same
// library draws the same planet every visit, or the reader cannot recognise it.
{
    const again = await globeLayout(cubeRegions());
    check('the same library draws the same planet',
        JSON.stringify(again) === JSON.stringify(globe));
}

check('the caps do not collapse onto one point', (() => {
    let min = Math.PI;
    for (let i = 0; i < globe.dirs.length; i++)
        for (let j = i + 1; j < globe.dirs.length; j++)
            min = Math.min(min, angleBetween(globe.dirs[i], globe.dirs[j]));
    return min > 0.02;
})());

// ---- and no two of them lie on top of each other ----------------------------
//
// The layout arranges CENTRES by meaning, and the spacing it pulls them to is
// derived from how many regions there are — it knows nothing about how big any
// of them is. So without a separation pass the two biggest regions in a library
// (which are usually also similar ones, so they are pulled together) are drawn
// four times as wide as the gap they were given: measured on the real library,
// 44 overlapping pairs of 6,786, the worst needing 1.9× the separation it had.
// What that draws is a hard rim through the middle of a disc, which says "one
// object in front of another" about two things that are neither.

/** The worst `(cap_i + cap_j) / angle_ij` in a layout. Over 1 is an overlap. */
function overlap({ dirs, caps }) {
    let worst = 0, pairs = 0;
    for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
            const have = angleBetween(dirs[i], dirs[j]);
            const ratio = have > 1e-9 ? (caps[i] + caps[j]) / have : Infinity;
            if (ratio > 1) pairs++;
            worst = Math.max(worst, ratio);
        }
    }
    return { worst, pairs };
}

for (const [label, rs] of [
    ['the cube', regions],
    ['a crowded library (96 regions in 8 clusters)', cubeRegions(12)],
    ['one region ten times the rest', [
        { centroid: cubeRegions(1, 16)[0].centroid, members: Array.from({ length: 400 }, () => ({})) },
        ...cubeRegions(2, 16),
    ]],
]) {
    const out = label === 'the cube' ? globe : await globeLayout(rs);
    const { worst, pairs } = overlap(out);
    check(`${label}: no two caps overlap`, worst <= 1,
        `${pairs} overlapping pair(s), worst ${worst.toFixed(3)}`);
    check(`${label}: …and every centre is still on the sphere`,
        out.dirs.every(d => near(len(d), 1, 1e-9)));
}

// The last resort, asserted on its own arithmetic: shrinking is done in AREA, so
// two regions whose drawn areas were 4:1 before are still 4:1 after. Scaling the
// RADIUS instead — the obvious way — would quietly change every comparison the
// map is read by.
{
    const { caps } = await globeLayout(cubeRegions(12));
    const area = (c) => 1 - Math.cos(c);
    const sizes = cubeRegions(12).map(r => r.members.length);
    const ratio = area(caps[sizes.indexOf(Math.max(...sizes))]) / area(caps[sizes.indexOf(Math.min(...sizes))]);
    check('a cap that has to be shrunk keeps its share of the area',
        near(ratio, Math.max(...sizes) / Math.min(...sizes), 1e-6));
}

check('the regions use the whole sphere, not one band', (() => {
    // A projection that keeps two components and normalises would leave every
    // direction within a few degrees of a great circle. Measured as the spread
    // along the layout's own weakest axis: the smallest standard deviation of
    // any coordinate has to be a real fraction of the largest.
    const sd = [0, 1, 2].map(a => {
        const vals = globe.dirs.map(d => d[a]);
        const m = vals.reduce((x, y) => x + y, 0) / vals.length;
        return Math.sqrt(vals.reduce((x, y) => x + (y - m) ** 2, 0) / vals.length);
    });
    return Math.min(...sd) > Math.max(...sd) * 0.35;
})());

check('cap area tracks topic count, not topic width', (() => {
    // Two regions, one four times the other: on a sphere the AREA must be four
    // times, which is 1 − cos ρ, never the radius.
    const small = capRadius(10, 1000), big = capRadius(40, 1000);
    return near((1 - Math.cos(big)) / (1 - Math.cos(small)), 4, 1e-6);
})());

check('a region with every topic in it is capped, not allowed to swallow the planet',
    capRadius(500, 500) < 0.45);

// ---- the claim the view is for ----------------------------------------------
console.log('\n--- does the third dimension earn its place?');

/** Share of each item's `k` true nearest neighbours that are also among its `k`
 *  nearest in the DRAWN layout. One scorer, two distance functions, so the two
 *  numbers below are comparable by construction. */
function preserved(items, k, distance) {
    const n = items.length;
    const truth = items.map((_, i) => items
        .map((_, j) => ({ j, sim: dotN(items[i].centroid, items[j].centroid) }))
        .filter(e => e.j !== i)
        .sort((a, b) => b.sim - a.sim || a.j - b.j)
        .slice(0, k));
    let hit = 0, seen = 0;
    for (let i = 0; i < n; i++) {
        const drawn = new Set(items
            .map((_, j) => ({ j, d: j === i ? Infinity : distance(i, j) }))
            .sort((a, b) => a.d - b.d || a.j - b.j)
            .slice(0, k)
            .map(e => e.j));
        for (const { j } of truth[i]) { seen++; if (drawn.has(j)) hit++; }
    }
    return hit / seen;
}
function dotN(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

const flat = layoutRegions(regions);
const K = 4;
const planeScore = preserved(regions, K, (i, j) => Math.hypot(flat[i].x - flat[j].x, flat[i].y - flat[j].y));
const globeScore = preserved(regions, K, (i, j) => angleBetween(globe.dirs[i], globe.dirs[j]));
console.log(`        plane ${planeScore.toFixed(3)}   sphere ${globeScore.toFixed(3)}   (k=${K}, ${regions.length} regions)`);
check('the sphere keeps neighbourhoods the plane cannot', globeScore > planeScore,
    `plane ${planeScore.toFixed(3)} vs sphere ${globeScore.toFixed(3)}`);
check('…and the exported score agrees with this measurement',
    near(neighbourhoodScore(globe.dirs, regions, K), globeScore, 1e-9));

// ---- the route a replay flies -----------------------------------------------
console.log('\n--- the flight, on a sphere');

// The journey is the one thing on this surface that MOVES, and every way its
// arithmetic can be wrong is a picture: a curve that leaves the sphere is drawn
// hovering over it, a curve traversed by its own parameter is an arrow that
// crawls out of a topic and then bolts, and a handle that outruns its chord is
// a loop through a place nobody went.

/** A route with the shapes a real course makes: a tight cluster, a long hop out
 *  of it, a corner, and the coincident pair a zoomed-out map hands it
 *  constantly (every topic in a bubble collapses onto that bubble's centre). */
const ROUTE = [
    P.unit3([0, 0.2, 1]), P.unit3([0.02, 0.21, 1]), P.unit3([0.7, 0.3, 0.6]),
    P.unit3([0.72, 0.33, 0.6]), P.unit3([-0.5, 0.8, 0.1]), P.unit3([-0.5, 0.8, 0.1]),
    P.unit3([0.3, -0.9, -0.2]),
];
const route = F.spherePath(ROUTE);

/**
 * How far apart two directions are, as a DISTANCE rather than an angle.
 *
 * `acos` is the wrong instrument for "is this the same point": near zero its
 * slope is infinite, so a dot product one bit off unity — which is what
 * comparing a vector with itself gives — comes back as 1.5e-8 radians and an
 * exactness check written in angles fails against its own arithmetic. The
 * chord between them has no such amplification.
 */
const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

check('a single place is a place, not a route', F.spherePath([ROUTE[0]]).length === 0);
check('an empty journey draws nothing', F.spherePath([]).length === 0);
check('one leg per gap', route.length === ROUTE.length - 1);

check('every control point is ON the sphere', route.every(l =>
    [l.p0, l.c1, l.c2, l.p3].every(v => near(len(v), 1, 1e-9))));

check('and so is every point of every curve', route.every(l => {
    for (let i = 0; i <= 32; i++) if (!near(len(F.sphereLegAt(l, i / 32)), 1, 1e-9)) return false;
    return true;
}));

check('the curve passes exactly through every topic', route.every((l, i) =>
    apart(F.sphereLegAt(l, 0), ROUTE[i]) < 1e-12
    && apart(F.sphereLegAt(l, 1), ROUTE[i + 1]) < 1e-12));

// A handle longer than its own chord loops, and a loop in a journey is an arrow
// flying backwards through a knot it invented. The sphere reaches for one
// constantly: zoomed out, a leg between two topics in one bubble is nearly zero
// long while its neighbours are a quarter of the planet away.
check('no leg wanders further than its own chord allows', route.every(l => {
    const chord = angleBetween(l.p0, l.p3);
    // A hop of no length is measured in the noise either way, so the floor is
    // what "no length" means rather than a ratio against nothing.
    return F.sphereLegSpan(l) < Math.max(chord * 1.6, 1e-6);
}));

check('a hop between two coincident places is a point, not a knot', (() => {
    const l = F.spherePath([ROUTE[4], ROUTE[5]])[0];
    return F.sphereLegSpan(l) < 1e-6 && apart(F.sphereLegAt(l, 0.5), ROUTE[4]) < 1e-9;
})());

// Two topics with nothing pulling the curve off the line between them must be
// joined by the great circle itself — the sphere's straight line. Anything else
// is a bend the data did not ask for.
check('a leg with no corner in it is the great circle', (() => {
    const a = P.unit3([1, 0, 0]), b = P.unit3([0.6, 0.8, 0]), c = P.unit3([0, 1, 0]);
    const l = F.spherePath([a, b, c])[0];
    let worst = 0;
    for (let i = 0; i <= 16; i++) {
        // Everything on the great circle through a and b is perpendicular to
        // their common normal.
        const pt = F.sphereLegAt(l, i / 16);
        worst = Math.max(worst, Math.abs(P.dot3(pt, P.unit3(P.cross3(a, b)))));
    }
    return worst < 1e-6;
})());

// ---- flown by DISTANCE, not by the curve's own parameter --------------------
// The plane's lesson, in radians: a cubic is not traversed evenly by its `t`,
// so at a fixed `t` per millisecond the middle of a leg runs several times
// faster than its ends. What that looks like is an arrow that sits still for
// the first part of its beat and then bolts, and it is not a timing fault — it
// is distance and time not being the same axis.
{
    const evenness = (leg, param) => {
        const N = 48;
        const steps = [];
        for (let i = 0; i < N; i++) {
            steps.push(angleBetween(F.sphereLegAt(leg, param(i / N)), F.sphereLegAt(leg, param((i + 1) / N))));
        }
        const sorted = steps.slice().sort((a, b) => a - b);
        return sorted[N - 1] / (sorted[0] || 1e-12);
    };
    const shapes = route.filter(l => angleBetween(l.p0, l.p3) > 1e-6);
    const rawWorst = Math.max(...shapes.map(l => evenness(l, t => t)));
    const flownWorst = Math.max(...shapes.map(l => evenness(l, u => F.sphereLegParam(l, u))));
    check('the curve itself is nothing like even — which is why this exists',
        rawWorst > 2, `worst ${rawWorst.toFixed(1)}x by parameter`);
    check('flown by distance, every millisecond buys the same degree',
        flownWorst < 1.35, `worst ${flownWorst.toFixed(2)}x by length`);
    check('…and it still starts at the start and ends at the end', (() => {
        const l = shapes[1];
        return apart(F.sphereLegAt(l, F.sphereLegParam(l, 0)), l.p0) < 1e-12
            && apart(F.sphereLegAt(l, F.sphereLegParam(l, 1)), l.p3) < 1e-12;
    })());
    check('a leg with no length at all is not a division by zero', (() => {
        const l = F.spherePath([ROUTE[4], ROUTE[5]])[0];
        const u = F.sphereLegParam(l, 0.4);
        return Number.isFinite(u) && u >= 0 && u <= 1;
    })());
}

// The drawn tail has to sit under the arrow's nose, and on a sphere the obvious
// way to get that does not work: de Casteljau's subdivision is exact on a plane
// (the first `t` of a cubic IS a cubic, which is what the flat map strokes) and
// is NOT on a sphere, where it hands back a different curve through the same
// two ends — measured at up to 2.0e-3 radians on this map's own shapes. So the
// renderer walks the whole leg up to the arrow's own parameter instead, and the
// two cannot disagree because there is only one curve.
{
    const globeSrc = readFileSync(new URL('../src/components/atlas/GlobeMap.tsx', import.meta.url), 'utf8');
    check('the tail is the curve the arrow is on, not a second one fitted to it',
        /const strokeLeg = \(leg: SphereLeg, upTo = 1\)/.test(globeSrc)
        && /sphereLegAt\(leg, \(i \/ LEG_SAMPLES\) \* upTo\)/.test(globeSrc)
        && !/sphereLegUpTo/.test(globeSrc));
    check('…and both of them are placed by DISTANCE along it',
        /const upTo = i === lastLeg && inAir \? sphereLegParam\(whole, frac\) : 1/.test(globeSrc)
        && /const t = leg \? sphereLegParam\(leg, frac\) : 0/.test(globeSrc));
}

// ---- how a topic is DRAWN, and where the camera looks -----------------------
//
// At its own place, at every zoom. Both surfaces used to slide a traced topic
// from its region's centre out to itself along the zoom's own ramp, so a course
// read as region-to-region hops from far away — and the route was then a
// function of the camera: a different shape at every distance, legs inside one
// region growing out of a point, and the line you were looking at not the line
// you got back. There is no ramp left to test, so what is pinned is its
// absence: no `journeyPlace`, a step's direction taken straight off the topic,
// and nothing in the trace's arithmetic reading the zoom.
{
    const globeSrc = readFileSync(new URL('../src/components/atlas/GlobeMap.tsx', import.meta.url), 'utf8');
    const flightSrc = readFileSync(new URL('../src/components/atlas/globeFlight.ts', import.meta.url), 'utf8');
    check('a traced topic is drawn where it is, not somewhere between it and its region',
        F.journeyPlace === undefined
        && !/journeyPlace/.test(flightSrc)
        && !/journeyPlace/.test(globeSrc)
        && /const dirOf = \(id: number\): Vec3 \| null => traceAt\.get\(id\)\?\.u \?\? null;/.test(globeSrc));
    // The other half of the same bargain: the route's own topics are marked at
    // every distance, or the line ends at places with nothing on them.
    check('…and the route’s own dots are drawn however far out the reader is',
        /if \(detail > 0\.01 \|\| traceAt\) \{/.test(globeSrc)
        && /const solid = traceAt && onCourse \? Math\.max\(detail, TRACE_DOT_MIN\) : detail;/.test(globeSrc));
}

check('slerp crosses at a constant angular speed', (() => {
    const a = P.unit3([1, 0, 0]), b = P.unit3([0, 1, 1]);
    const total = angleBetween(a, b);
    for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        if (!near(angleBetween(a, F.slerp(a, b, t)), total * t, 1e-9)) return false;
    }
    return true;
})());

check('the middle of a set of places is among them', (() => {
    const cluster = [[0, 0.1, 1], [0.1, 0, 1], [0.05, 0.05, 1]].map(v => ({ u: P.unit3(v), w: 1 }));
    const mid = F.meanDirection(cluster);
    return mid && cluster.every(p => angleBetween(mid, p.u) < 0.2);
})());
check('…and a set with no middle says so rather than inventing one',
    F.meanDirection([{ u: [0, 0, 1], w: 1 }, { u: [0, 0, -1], w: 1 }]) === null);
check('a weighted middle leans toward the weight', (() => {
    const a = P.unit3([1, 0, 0]), b = P.unit3([0, 1, 0]);
    const mid = F.meanDirection([{ u: a, w: 3 }, { u: b, w: 1 }]);
    return mid && angleBetween(mid, a) < angleBetween(mid, b);
})());

// ---- degenerate libraries ---------------------------------------------------
console.log('\n--- libraries with nothing to project');

for (const [label, rs] of [
    ['one region', [{ centroid: new Float64Array(8).fill(0.35), members: [{}] }]],
    ['three regions', cubeRegions(1, 8).slice(0, 3)],
    ['every centroid identical', Array.from({ length: 9 }, () => ({
        centroid: Float64Array.from({ length: 8 }, () => 0.35355339), members: [{}, {}],
    }))],
    ['no vectors at all', Array.from({ length: 5 }, () => ({ centroid: [], members: [{}] }))],
]) {
    const out = await globeLayout(rs);
    check(`${label}: still lands on the sphere`,
        out.dirs.length === rs.length && out.dirs.every(d => near(len(d), 1, 1e-9)),
        JSON.stringify(out.dirs[0]));
}
const emptyOut = await globeLayout([]);
check('an empty library is an empty layout, not a throw',
    emptyOut.dirs.length === 0 && emptyOut.caps.length === 0);

// Regions whose centroids are IDENTICAL. The separation pass invents a direction
// between two coincident centres, so it should never reach the last-resort
// shrink — and the last resort is the one path that could hand `scaleCaps` a
// scale of zero and draw an invisible planet. Assert what the reader gets: caps
// that exist, and no overlap.
for (const n of [2, 3, 6, 12]) {
    const same = Array.from({ length: n }, () => ({
        centroid: [0.4, 0.3, 0.2, 0.1],
        members: Array.from({ length: 20 }, (_, i) => i),
    }));
    const { dirs, caps } = await globeLayout(same);
    const smallest = Math.min(...caps);
    let worst = 0;
    for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
            worst = Math.max(worst, (caps[i] + caps[j]) / Math.max(1e-9, angleBetween(dirs[i], dirs[j])));
        }
    }
    check(`${n} identical centroids still get caps`, smallest > 0.01, `smallest ${smallest.toFixed(4)} rad`);
    check(`${n} identical centroids do not overlap`, worst <= 1.0001, `worst ${worst.toFixed(3)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
