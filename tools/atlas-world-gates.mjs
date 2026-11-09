// tools/atlas-world-gates.mjs — the atlas as one world: a flat map and a globe
// drawn by one renderer, countries that open into cities, and what to study next.
//
// Run:  node tools/atlas-world-gates.mjs [--root <checkout>]
//
// Why this exists: each of these draws a picture rather than throwing when it
// is wrong. A flat projection that squeezes the top of the sheet still draws a
// map — with every country near a pole smeared into a strip. Cities that are
// not equal still fill their country — with one topic owning half of it. A
// pick that inverts the projection badly still selects something — the
// neighbour. A planet held with land on its poles still turns. So the geometry
// is asserted directly on the real modules (bundled with esbuild, no DOM, no
// model, no network) and on the server's own layout.
//
// `--root` points every read at another checkout, so the same file can be run
// against the code from before this change and fail there.

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const here = fileURLToPath(new URL('..', import.meta.url));
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : here;
const at = (rel) => join(ROOT, rel);
const read = (rel) => (existsSync(at(rel)) ? readFileSync(at(rel), 'utf8') : null);

let failed = 0, passed = 0;
const check = (label, cond, extra = '') => {
    if (cond) { passed++; console.log(`  ok    ${label}`); }
    else { failed++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const cache = join(here, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const out = mkdtempSync(join(cache, 'atlas-world-gates-'));
/** Bundle one of the app's TS modules and import it; null (and a FAIL) when it
 *  is missing or does not build, so the rest of the suite still reports. */
async function load(rel, needs = []) {
    const file = at(rel);
    if (!existsSync(file)) { check(`${rel} exists`, false, 'not in this checkout'); return null; }
    const outfile = join(out, rel.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '.mjs'));
    try {
        await esbuild.build({ entryPoints: [file], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
    } catch (err) {
        check(`${rel} builds`, false, String(err.message).split('\n')[0]);
        return null;
    }
    const mod = await import(pathToFileURL(outfile).href);
    const missing = needs.filter(n => !(n in mod));
    check(`${rel} exports ${needs.join(', ') || 'what the suite calls'}`, missing.length === 0, `missing ${missing.join(', ')}`);
    return missing.length ? null : mod;
}
async function serverModule(rel, needs = []) {
    if (!existsSync(at(rel))) { check(`${rel} exists`, false, 'not in this checkout'); return null; }
    const mod = await import(pathToFileURL(at(rel)).href);
    const missing = needs.filter(n => !(n in mod));
    check(`${rel} exports ${needs.join(', ')}`, missing.length === 0, `missing ${missing.join(', ')}`);
    return missing.length ? null : mod;
}

function rng(seed) {
    let s = (Math.imul(seed + 1, 2654435761) >>> 0) || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

const P = await load('src/components/atlas/globeProjection.ts',
    ['flatXY', 'flatLonLat', 'viewOfLonLat', 'rotate', 'unrotate', 'FLAT_HALF_W', 'FLAT_HALF_H', 'FLAT_DX_DLON']);

// ---- the flat map keeps its shape --------------------------------------------
console.log('\n--- the flat map');
if (P) {
    // Shape: h/k, the north-south scale over the east-west scale, on the
    // central meridian. 1 is a true shape, below 1 squashed flat. Equal Earth,
    // the first try, was 0.59 at 60° — a country there drawn at little more
    // than half its height, which is what "squished at the top and bottom"
    // was — and 1.35 at the middle.
    const d = 1e-6;
    const hk = (lon, lat) => {
        const [x0, y0] = P.flatXY(lon, lat);
        const [xa, ya] = P.flatXY(lon, lat + d);
        const [xb, yb] = P.flatXY(lon + d, lat);
        const h = Math.hypot(xa - x0, ya - y0) / d;
        const k = Math.hypot(xb - x0, yb - y0) / (d * Math.cos(lat));
        return h / k;
    };
    const s60 = Math.min(hk(0, Math.PI / 3), hk(0, -Math.PI / 3));
    check('a country at 60° keeps its shape on the flat map (h/k ≥ 0.8)', s60 >= 0.8, `h/k ${s60.toFixed(3)}`);
    check('…and one in the middle is not stretched tall (h/k ≤ 1.25)', hk(0, 0) <= 1.25, `h/k ${hk(0, 0).toFixed(3)}`);
    const [xe] = P.flatXY(Math.PI, 0), [, yn] = P.flatXY(0, Math.PI / 2);
    check('the sheet is as wide and as tall as its constants say',
        Math.abs(xe - P.FLAT_HALF_W) < 1e-9 && Math.abs(yn - P.FLAT_HALF_H) < 1e-9, `${xe}, ${yn}`);
    const [xs] = P.flatXY(1e-4, 0);
    check('the drag gain is the sheet\'s own east-west scale at the centre',
        Math.abs(xs / 1e-4 - P.FLAT_DX_DLON) < 1e-6, `${(xs / 1e-4).toFixed(6)} vs ${P.FLAT_DX_DLON}`);

    // Picking inverts the projection: every point of the sheet comes back to
    // the place that drew it.
    let worst = 0, missed = 0, n = 0;
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 20; j++) {
        const lon = -Math.PI + 0.005 + (i / 40) * (2 * Math.PI - 0.01);
        const lat = -Math.PI / 2 + 0.005 + (j / 20) * (Math.PI - 0.01);
        const [x, y] = P.flatXY(lon, lat);
        const back = P.flatLonLat(x, y);
        n++;
        if (!back) { missed++; continue; }
        // Compared as places, so a pole's undefined longitude is not an error.
        worst = Math.max(worst, angle(P.viewOfLonLat(lon, lat), P.viewOfLonLat(back[0], back[1])));
    }
    check('every point of the flat map picks the place drawn there (within 1e-6 rad)',
        missed === 0 && worst < 1e-6, `${missed} of ${n} not found, worst ${worst.toExponential(2)}`);
    const off = [[P.FLAT_HALF_W * 1.05, 0], [0, P.FLAT_HALF_H * 1.05], [P.FLAT_HALF_W * 0.95, P.FLAT_HALF_H * 0.95], [-P.FLAT_HALF_W * 0.97, -P.FLAT_HALF_H * 0.9]];
    check('a pick off the sheet picks nothing', off.every(([x, y]) => P.flatLonLat(x, y) === null),
        JSON.stringify(off.map(([x, y]) => P.flatLonLat(x, y))));

    // The whole pick: world → camera → sheet → back, at a camera turned and tipped.
    let worstPick = 0;
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
        const z = 2 * r() - 1, a = 2 * Math.PI * r(), s = Math.sqrt(1 - z * z);
        const v = [s * Math.cos(a), s * Math.sin(a), z];
        const yaw = 2 * Math.PI * r() - Math.PI, pitch = (r() - 0.5) * 2;
        const [x, y] = P.rotate(v, yaw, pitch, true);
        const ll = P.flatLonLat(x, y);
        if (!ll) { worstPick = Infinity; break; }
        worstPick = Math.max(worstPick, angle(v, P.unrotate(P.viewOfLonLat(ll[0], ll[1]), yaw, pitch)));
    }
    check('a click on the flat map finds the place under it, at any camera', worstPick < 1e-6,
        `worst ${Number.isFinite(worstPick) ? worstPick.toExponential(2) : 'off the sheet'}`);

    // One renderer, two projections, and nothing global between them: the
    // video stage mounts a second map beside the one on screen.
    const v = [0.3, 0.5, Math.sqrt(1 - 0.34)];
    const flat = P.rotate(v, 0.4, 0.2, true);
    const globe = P.rotate(v, 0.4, 0.2);
    const again = P.rotate(v, 0.4, 0.2);
    check('the flat projection is a parameter, not a switch the other map can see',
        flat[2] === 1 && Math.abs(Math.hypot(...globe) - 1) < 1e-9 && globe.every((c, i) => c === again[i])
        && !('projection' in P), `flat ${flat.map(c => c.toFixed(3))}, globe ${globe.map(c => c.toFixed(3))}`);
}

// ---- the planet is held with its poles on sea ---------------------------------
console.log('\n--- poles on sea, land toward the reader');
const G = await serverModule('server/globe.js', ['globeLayout', 'poleLoad', 'fibonacciSphere']);
const T = await load('src/components/atlas/globeTerritories.ts', ['buildTerrain', 'OCEAN', 'lineOf']);
const H = await load('src/components/atlas/homeView.ts', ['landView', 'flatHomeYaw']);
const libraries = [];
if (G) {
    const lib = (n, seed, dim = 6) => {
        const r = rng(seed);
        const centres = Array.from({ length: 4 }, () => Array.from({ length: dim }, () => r() * 2 - 1));
        return Array.from({ length: n }, (_, i) => ({
            centroid: centres[i % 4].map(x => x + (r() - 0.5) * 0.8),
            members: Array.from({ length: 2 + ((i * 7) % 23) }, () => ({})),
        }));
    };
    for (const [name, regions] of [['a 9-region library', lib(9, 1)], ['a 40-region library', lib(40, 2)], ['a 120-region library', lib(120, 3)]]) {
        const lay = await G.globeLayout(regions);
        libraries.push({ name, regions, lay });
        const poles = [[0, 0, 1], [0, 0, -1]];
        const onPole = lay.dirs.filter((d, i) => poles.some(p => angle(d, p) <= lay.caps[i])).length;
        check(`${name}: no region's ground covers a pole`, onPole === 0, `${onPole} do`);
        const least = Math.min(...G.fibonacciSphere(500).map(p => G.poleLoad(lay.dirs, lay.caps, p)));
        const load = G.poleLoad(lay.dirs, lay.caps, [0, 0, 1]);
        check(`${name}: the pole is where the land is thinnest`, load <= least * 1.1 + 1e-9,
            `load ${load.toFixed(5)}, least elsewhere ${least.toFixed(5)}`);
        const m = [0, 0, 0];
        lay.dirs.forEach((d, i) => { const w = 1 - Math.cos(lay.caps[i]); m[0] += d[0] * w; m[1] += d[1] * w; });
        check(`${name}: the land's weight faces the opening view's direction`, Math.abs(m[0]) < 1e-6 * (1 + Math.abs(m[1])) && m[1] > 0,
            `mean (${m[0].toFixed(4)}, ${m[1].toFixed(4)})`);
        if (T) {
            const terrain = T.buildTerrain(lay.dirs.map((u, i) => ({ id: i, u, cap: lay.caps[i] })));
            const sea = poles.filter(p => terrain.ownerAt(p) === T.OCEAN).length;
            check(`${name}: both poles are sea on the drawn planet`, sea === 2, `${sea} of 2`);
            // The globe's first picture is land: the middle of the opening
            // view (40° round its centre) holds more land than the planet
            // does on average. Round 3's Terra opened on open sea.
            const home = H && P ? lay.dirs.map((u, i) => ({ u, cap: lay.caps[i] })) : null;
            if (home) {
                const view = H.landView(home);
                const centre = P.unrotate([0, 0, 1], view.yaw, view.pitch);
                let near = 0, landNear = 0;
                for (const q of G.fibonacciSphere(6000)) {
                    if (angle(q, centre) > 40 * Math.PI / 180) continue;
                    near++;
                    if (terrain.ownerAt(q) !== T.OCEAN) landNear++;
                }
                check(`${name}: the globe opens on land, not sea`, landNear / near >= terrain.landShare,
                    `${(100 * landNear / near).toFixed(1)}% land in view, ${(100 * terrain.landShare).toFixed(1)}% on the planet`);
                // The flat map's seam (its left and right edges) cuts as little
                // land as any meridian does: a country there is drawn in halves.
                const seamLand = (yaw) => {
                    let land = 0;
                    for (let j = 1; j < 180; j++) {
                        const lat = -Math.PI / 2 + (j * Math.PI) / 180;
                        const lon = yaw + Math.PI;
                        if (terrain.ownerAt([Math.cos(lat) * Math.sin(lon), Math.cos(lat) * Math.cos(lon), Math.sin(lat)]) !== T.OCEAN) land++;
                    }
                    return land / 179;
                };
                const seam = seamLand(H.flatHomeYaw(home));
                let typical = 0;
                for (let k = 0; k < 36; k++) typical += seamLand((k * Math.PI) / 18) / 36;
                check(`${name}: the flat map's seam runs through sea`, seam <= typical * 0.6,
                    `${(100 * seam).toFixed(1)}% of the seam on land, ${(100 * typical).toFixed(1)}% for a meridian on average`);
            }
        }
    }
}

// ---- countries open into cities of one size ------------------------------------
console.log('\n--- cities');
const C = await load('src/components/atlas/globeCities.ts', ['buildCountryCities', 'buildCities', 'equalAreaPatch']);
if (C && T && P && libraries.length) {
    const { regions, lay } = libraries[1];
    const seeds = lay.dirs.map((u, i) => ({ id: i, u, cap: lay.caps[i] }));
    const terrain = T.buildTerrain(seeds);
    const land = new Map(terrain.territories.map(t => [t.id, t]));
    // Topics spread over each cap's disc the way the map places them: a
    // sunflower, so a region holds every spacing from crowded to sparse.
    const golden = Math.PI * (3 - Math.sqrt(5));
    const countries = seeds.map((s, i) => {
        const n = regions[i].members.length;
        const [e1, e2] = P.tangentBasis(s.u);
        const topics = Array.from({ length: n }, (_, k) => {
            const rr = Math.sqrt((k + 0.5) / n) * 0.9, a = k * golden;
            return { id: i * 1000 + k, u: P.capPoint(s.u, e1, e2, rr * Math.cos(a), rr * Math.sin(a), s.cap) };
        });
        return { id: i, u: s.u, cap: s.cap, topics };
    });
    // A point inside a set of loops, counted even-odd on the country's own
    // flat patch — the rule the canvas fills and clips by.
    const inLoops = (patch, loops, q) => {
        const [x, y] = patch.to(q[0], q[1], q[2]);
        let inside = false;
        for (const l of loops) {
            const pts = l.pts, n = pts.length / 3;
            let [xj, yj] = patch.to(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1], pts[(n - 1) * 3 + 2]);
            for (let i = 0; i < n; i++) {
                const [xi, yi] = patch.to(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
                if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
                xj = xi; yj = yi;
            }
        }
        return inside;
    };
    let worstSpread = 0, worstName = '', gaps = 0, overlaps = 0, inside = 0;
    let countWrong = 0, centreAstray = 0, centreOff = 0, built = 0, ms = 0, pastCap = 0;
    const r = rng(11);
    for (const c of countries) {
        const territory = land.get(c.id);
        if (!territory) continue;
        const t0 = performance.now();
        const cut = C.buildCountryCities(territory, c.u, c.topics, c.id);
        ms += performance.now() - t0;
        if (!cut) { countWrong++; continue; }
        built++;
        if (cut.cities.length !== c.topics.length) countWrong++;
        const patch = C.equalAreaPatch(c.u);
        const byId = new Map(cut.cities.map(x => [x.id, x]));
        for (const t of c.topics) {
            const ctr = cut.centres.get(t.id);
            const city = byId.get(t.id);
            if (!ctr || !city || !inLoops(patch, city.loops, ctr)) centreAstray++;
            if (!ctr || terrain.ownerAt(ctr) !== c.id) centreOff++;
            if (ctr && angle(ctr, c.u) > c.cap) pastCap++;
        }
        if (c.topics.length < 2) continue;
        // Monte Carlo over the country: uniform points in a cap that holds it.
        let reach = 0;
        for (const l of territory.loops) for (let i = 0; i < l.pts.length; i += 3) reach = Math.max(reach, angle(c.u, [l.pts[i], l.pts[i + 1], l.pts[i + 2]]));
        const [e1, e2] = P.tangentBasis(c.u);
        const counts = new Map(c.topics.map(t => [t.id, 0]));
        for (let s = 0; s < 12000; s++) {
            const z = 1 - r() * (1 - Math.cos(reach)), a = 2 * Math.PI * r(), sn = Math.sqrt(1 - z * z);
            const q = [0, 1, 2].map(k => c.u[k] * z + (e1[k] * Math.cos(a) + e2[k] * Math.sin(a)) * sn);
            if (!inLoops(patch, territory.loops, q)) continue;
            inside++;
            let hits = 0, owner = -1;
            for (const city of cut.cities) if (inLoops(patch, city.loops, q)) { hits++; owner = city.id; }
            if (hits === 0) gaps++;
            else if (hits > 1) overlaps++;
            else counts.set(owner, counts.get(owner) + 1);
        }
        const vals = [...counts.values()];
        const spread = Math.max(...vals) / Math.max(1, Math.min(...vals));
        if (spread > worstSpread) { worstSpread = spread; worstName = `${c.topics.length} topics`; }
    }
    check('every country is cut, one city per topic', countWrong === 0 && built === countries.length,
        `${countWrong} wrong, ${built} of ${countries.length} built`);
    check('cities are one size: largest over smallest ≤ 1.7 in every country', worstSpread <= 1.7,
        `worst ${worstSpread.toFixed(2)} (${worstName})`);
    check('the cities fill their country: under 1% of it in no city', gaps / inside < 0.01,
        `${(100 * gaps / inside).toFixed(2)}% of ${inside} samples`);
    check('no ground is in two cities: under 1%', overlaps / inside < 0.01, `${(100 * overlaps / inside).toFixed(2)}%`);
    check('every topic\'s dot stands inside its own city', centreAstray === 0, `${centreAstray} do not`);
    check('every topic\'s dot stands on its own country', centreOff === 0, `${centreOff} do not`);
    console.log(`        (${built} countries cut in ${ms.toFixed(0)} ms)`);
    // A city fills its country out to the coast, so the cities carry dots past
    // the cap (455 of 2,490 on one real library). The pick must look as far as
    // the dots: a pre-filter at the cap left those topics unpickable.
    check('cities carry dots past their cap (why the pick must not stop there)', pastCap > 0, `${pastCap} past the cap`);
    const mapSrc = read('src/components/atlas/GlobeMap.tsx') || '';
    check('the pick looks as far as the region\'s furthest dot, not its cap',
        /spread = Math\.max\(spread, angleBetween\(t\.u, p\.u\)\)/.test(mapSrc)
        && /angleBetween\(world, p\.u\) > p\.spread \+ slack/.test(mapSrc)
        && !/angleBetween\(world, p\.u\) > p\.cap \+ p\.dotAngle/.test(mapSrc));
    // The same country is cut the same way on every visit: the borders are
    // a function of the country, never of the frame or the order of visits.
    const c = countries.find(x => x.topics.length >= 8);
    const a1 = C.buildCountryCities(land.get(c.id), c.u, c.topics, c.id);
    const a2 = C.buildCountryCities(land.get(c.id), c.u, c.topics, c.id);
    const same = a1.borders.length === a2.borders.length
        && a1.borders.every((b, i) => b.pts.length === a2.borders[i].pts.length && b.pts.every((x, k) => x === a2.borders[i].pts[k]));
    check('a country is cut the same way every time', same);
}

// ---- the cities' build always settles -----------------------------------------
// A stub Worker the suite answers by hand: the build's every ending, in order.
console.log('\n--- building the cities');
const CB = await load('src/components/atlas/cityBuild.ts', ['citiesFor', 'citiesReady']);
if (CB) {
    const hadWorker = globalThis.Worker;
    const workers = [];
    class StubWorker {
        constructor() { workers.push(this); this.onmessage = null; this.onerror = null; }
        postMessage(data) { this.sent = data; }
        terminate() { this.ended = true; }
        reply(data) { this.onmessage?.({ data: { key: this.sent.key, ...data } }); }
        fail() { this.onerror?.({ type: 'error' }); }
    }
    const settle = (p, ms = 500) => Promise.race([
        p.then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e?.message ?? e) })),
        new Promise(r => setTimeout(() => r({ ok: null }), ms)),
    ]);
    globalThis.Worker = StubWorker;
    // A build that failed in the worker would fail the same way on the page,
    // after freezing it for seconds: that failure is the answer.
    const failedJob = CB.citiesFor([], [], 'gate-error');
    workers.at(-1).reply({ type: 'error', message: 'stub' });
    const failed = await settle(failedJob);
    check('a build that failed in the worker fails, not run again on the page', failed.ok === false, JSON.stringify(failed));
    const made = workers.length;
    const again = CB.citiesFor([], [], 'gate-error');
    check('…and the next map of that atlas asks again', workers.length === made + 1);
    workers.at(-1).reply({ type: 'done', cities: new Map() });
    await settle(again);
    const noStart = CB.citiesFor([], [], 'gate-nostart');
    workers.at(-1).fail();
    const started = await settle(noStart);
    check('a worker that cannot start hands the build to the page', started.ok === true && started.v instanceof Map, JSON.stringify(started));
    // Two atlases in quick succession (a region renamed mid-build): the older,
    // slower build lands last and must not take the newer one's place.
    const slow = CB.citiesFor([], [], 'gate-old'); const wOld = workers.at(-1);
    const fresh = CB.citiesFor([], [], 'gate-new'); const wNew = workers.at(-1);
    wNew.reply({ type: 'done', cities: new Map([[1, 'new']]) });
    await settle(fresh);
    wOld.reply({ type: 'done', cities: new Map([[1, 'old']]) });
    await settle(slow);
    check('a slower build for a replaced atlas does not displace the current one', CB.citiesReady('gate-new')?.get(1) === 'new');
    // No worker at all, and the build throws inside its timer: still settles.
    globalThis.Worker = undefined;
    let uncaught = null;
    const keep = (err) => { uncaught = err; };
    process.on('uncaughtException', keep);
    const thrown = await settle(CB.citiesFor(null, [], 'gate-throw'));
    process.off('uncaughtException', keep);
    check('a build that throws on the page rejects rather than hanging', thrown.ok === false,
        uncaught ? `uncaught: ${uncaught.message}` : JSON.stringify(thrown));
    globalThis.Worker = hadWorker;
}

// ---- names and lines ----------------------------------------------------------
console.log('\n--- names and lines');
const L = await load('src/components/atlas/mapLabels.ts', ['labelOrder']);
if (L) {
    const claims = [
        { name: 'big', selected: false, focus: false, undimmed: false, size: 90 },
        { name: 'searched', selected: false, focus: false, undimmed: true, size: 5 },
        { name: 'hovered', selected: false, focus: true, undimmed: false, size: 3 },
        { name: 'picked', selected: true, focus: false, undimmed: false, size: 1 },
        { name: 'searched big', selected: false, focus: false, undimmed: true, size: 40 },
    ];
    const order = [...claims].sort(L.labelOrder).map(c => c.name).join(' > ');
    check('names claim their ground: picked > hovered > left standing by a search > size',
        order === 'picked > hovered > searched big > searched > big', order);
}
// Loaded on its own so it also runs (and fails) on a checkout without
// `labelOrder`: two names one above the other must not touch, or they read as
// one name. Text is measured by a stub (7px a character), one line at 12px.
const LB = await load('src/components/atlas/mapLabels.ts', ['createLabeller']);
if (LB) {
    const stub = () => ({
        drawn: [], font: '', globalAlpha: 1, textAlign: '', lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '',
        measureText: (t) => ({ width: t.length * 7 }),
        strokeText() { }, fillText(t) { this.drawn.push(t); },
    });
    const style = { size: 12, weight: 600, alpha: 1 };
    const lh = 12 * 1.16;
    const below = (dy) => {
        const ctx = stub();
        const lab = LB.createLabeller(ctx, { width: 400, height: 300, ink: '#000', halo: '#fff' });
        lab.wrapLabel('Matrix Methods', 200, 150, style, 300);
        return lab.wrapLabel('Logic and Proofs', 200, 150 + lh + dy, style, 300);
    };
    check('a name 1px under another is dropped: stacked edge to edge they read as one name', !below(1));
    check('…and one a clear gap under it is kept', below(8));
}
const J = await load('src/components/atlas/journeyStyle.ts', ['JOURNEY_MAX_WIDTH', 'JOURNEY_HALO_WIDTH']);
if (J) {
    check('the route is a thin line over the cities (≤ 2.4 px at its widest, halo ≤ 2.4)',
        J.JOURNEY_MAX_WIDTH <= 2.4 && J.JOURNEY_HALO_WIDTH <= 2.4, `${J.JOURNEY_MAX_WIDTH} + halo ${J.JOURNEY_HALO_WIDTH}`);
}
const LL = await load('src/components/atlas/cityLines.ts', ['cityLines']);
if (LL) {
    const far = LL.cityLines(0), close = LL.cityLines(1), mid = LL.cityLines(0.5);
    check('zoomed out, the sea keeps its waterlines and the border its grey', far.ripple === 1 && far.surface === 0);
    check('with the cities in, no waterline crosses a strait', close.ripple === 0, `ripple ${close.ripple}`);
    check('…and the country border is the surface colour, wider than any city border',
        close.surface === 1 && close.borderWidth > close.cityBorderWidth, `${close.borderWidth} vs ${close.cityBorderWidth}`);
    check('…getting there smoothly', mid.ripple > 0 && mid.ripple < 1 && mid.surface > 0 && mid.surface < 1);
}

// ---- what to study next -------------------------------------------------------
console.log('\n--- study this next');
const S = await serverModule('server/studyNext.js', ['studyNext']);
if (S) {
    const m = (id, project_id, status, vec, extra = {}) => ({ id, project_id, status, vec, title: `Topic ${id}`, is_leaf: 1, completed_iso: null, ...extra });
    const done = (id, p, vec, when, title) => m(id, p, 'completed', vec, { completed_iso: when, ...(title ? { title } : {}) });
    const regions = [
        { members: [
            done(1, 10, [1, 0, 0], '2026-10-01T10:00:00Z', 'Module 9.5: Limits'),
            m(2, 10, 'not_started', [0.9, 0.1, 0]),
            m(3, 10, 'not_started', [0, 1, 0]),
            m(4, 10, 'not_started', [1, 0, 0], { is_leaf: 0 }),          // a heading
            m(5, 10, 'in_progress', [1, 0, 0]),                        // already begun
            m(14, 10, 'not_started', [1, 0, 0], { attempts: 3 }),        // answered, status not moved
            m(15, 10, 'not_started', [1, 0, 0], { sub: { seen: 2 } }),  // cards met
            m(16, 10, 'not_started', [NaN, 0, 0]),                     // a broken vector
            m(17, 10, 'not_started', null),                            // no vector at all
        ] },
        { members: [
            done(6, 20, [0, 0, 1], '2026-08-01T10:00:00Z'),            // a paused course
            m(7, 20, 'not_started', [0, 0, 1]),
        ] },
        { members: [
            done(8, 10, [0, 1, 0], '2026-10-02T10:00:00Z'),
            m(9, 10, 'not_started', [0, 0.6, 0.8]),
        ] },
        { members: [m(10, 10, 'not_started', [1, 0, 0])] },             // nothing finished here
        { members: [
            done(11, 30, [1, 0, 0], '2026-09-20T10:00:00Z'),
            m(12, 30, 'not_started', [0.8, 0.6, 0]),
            m(13, 30, 'not_started', [0.7, 0.71, 0]),
        ] },
    ];
    let got = [];
    try { got = S.studyNext(regions); } catch (err) { check('a broken or missing vector does not stop the build', false, err.message); }
    check('the not-started topic nearest a finished one, one per region, best first',
        JSON.stringify(got.map(g => g.topicId)) === '[2,12,9]', JSON.stringify(got));
    check('…saying which finished topic it is near, by its clean name',
        got[0]?.nearId === 1 && got[0]?.nearTitle === 'Limits', JSON.stringify(got[0]));
    check('…and which region it is in', got.map(g => g.regionId).join() === '0,4,2', got.map(g => g.regionId).join());
    check('a paused course, a heading, or begun work is never suggested',
        !got.some(g => [4, 5, 7].includes(g.topicId)));
    // Region 0 alone: with topics 2 and 3 started too, what is left there is
    // the answered topic, the one with cards met and the two without a vector.
    const rest = [{ members: regions[0].members.map(x => [2, 3].includes(x.id) ? { ...x, status: 'in_progress' } : x) }];
    let restGot = null;
    try { restGot = S.studyNext(rest); } catch (err) { restGot = err.message; }
    check('…nor a topic answered or with cards met while its status still says not started, nor one with no usable vector',
        Array.isArray(restGot) && restGot.length === 0, JSON.stringify(restGot));
    check('at most the limit', S.studyNext(regions, { limit: 1 }).length === 1);
    check('a library with nothing finished suggests nothing', S.studyNext([{ members: [m(1, 1, 'not_started', [1])] }]).length === 0);
    const src = read('server/studyNext.js') || '';
    check('it reads no clock: "now" is the library\'s own latest finish', !/Date\.now|new Date\(\s*\)/.test(src));
    const atlasSrc = read('server/atlas.js') || '';
    check('the atlas build sends it', /studyNext\(/.test(atlasSrc) && /\bnext\b[^;]*builtAt/.test(atlasSrc));
    // …and the page shows it: at the top of the region list, out of the way of
    // a search, each row the same row a region's topic list draws and opening
    // the topic it names.
    const pageSrc = read('src/components/AtlasView.tsx') || '';
    const hintSrc = read('src/components/atlas/StudyNext.tsx') || '';
    check('the region list opens with it, except while searching',
        /\{!query\.trim\(\) && <StudyNext next=\{data\.next\} regions=\{data\.regions\} \/>\}\s*<RegionList/.test(pageSrc));
    // The reason leads the line: after a long course name it was cut off.
    check('…each row a topic row that opens its topic and says first what it is near',
        /<TopicRow[\s\S]{0,400}?tr\("Near \{\{topic\}\} · \{\{course\}\}"[\s\S]{0,200}?openProjectNode\(topic\.projectId, topic\.id\)/.test(hintSrc)
        && /<TopicRow\b/.test(read('src/components/atlas/RegionList.tsx') || ''));
}

// ---- one renderer ----------------------------------------------------------------
console.log('\n--- one renderer');
check('the bubble map is gone (src/components/atlas/AtlasMap.tsx)', !existsSync(at('src/components/atlas/AtlasMap.tsx')));
const view = read('src/components/AtlasView.tsx') || '';
check('the Map surface is the globe renderer, unrolled', /<GlobeMap\b[^>]*\bflat=\{/.test(view.replace(/\s+/g, ' ')) && !/AtlasMap\b/.test(view));
const globeSrc = read('src/components/atlas/GlobeMap.tsx') || '';
// The one deliberate module-level `let` is `driftSpent` (the first planet of a
// session drifts, no later one); a zoom range or a fade is per map.
const moduleLets = [...globeSrc.matchAll(/^(?:let|var)\s+(\w+)/gm)].map(x => x[1]).filter(n => n !== 'driftSpent');
check('no state is shared between two mounted maps (no module-level let but driftSpent)',
    globeSrc.length > 0 && moduleLets.length === 0, moduleLets.join(', '));
const leftovers = ['src/components/AtlasView.tsx', 'src/components/atlas/GlobeMap.tsx', 'src/components/atlas/globeCities.ts',
    'src/components/atlas/globeProjection.ts', 'server/atlas.js']
    .filter(f => /MOCKUP|atlas_mock|__globe\b|WORLD_MOCK/.test(read(f) || ''));
check('no prototype switch or dev hook is left in', leftovers.length === 0, leftovers.join(', '));
const stage = read('src/components/atlas/AtlasRenderStage.tsx') || '';
check('the video stage draws with the same renderer', /GlobeMap/.test(stage) && !/AtlasMap\b/.test(stage));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
