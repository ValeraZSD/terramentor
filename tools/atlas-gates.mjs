// tools/atlas-gates.mjs — checks the atlas builds a map that is true, stable
// and never broken.
//
// Run:  node tools/atlas-gates.mjs
//
// Why this exists: the atlas is arithmetic on vectors, and every way it can go
// wrong produces a picture rather than an exception. A layout that silently
// collapses to NaN draws an empty canvas. A clustering that depends on row
// order redraws the library differently on every visit, which destroys the one
// thing a map is for — recognising where you are. A PCA with no variance left
// to project divides by zero and takes the page with it. So the properties are
// asserted: determinism, finite coordinates in range, the degenerate libraries
// (one topic, identical topics, one project), and the fact that an unmapped
// library is an ANSWER rather than an error.
//
// Scratch DB + stub /api/embed server, no model calls, deterministic. The stub
// places topics in a hand-built 4-d space so "which topics belong together"
// has a known right answer — this checks the mechanics, not how good real
// embeddings are at grouping real curricula.

import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'atlas-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

// [waves, calculus, cooking, other] — three well-separated subject areas.
const SPACE = [
    [/standing wave|staande golv|golfpatroon|antinode|harmonic/i, [1, 0.05, 0, 0]],
    [/fourier|sinusoid|integral|derivative/i, [0.05, 1, 0, 0]],
    [/knead|dough|bread|proof|crumb/i, [0, 0, 1, 0.05]],
];
let collapse = false;     // "every topic means the same thing"
let orthogonal = false;   // "no two topics are alike" — the unclusterable library
let arc = false;          // a CHAIN of topics: each near the next, ends unrelated
// The shape that builds a landfill. Adjacent topics are all but identical, so
// leader clustering chains them into one enormous region even though the two
// ends of the chain have nothing to do with each other — which is exactly what
// a real library does when a 200-topic course meets a threshold it can clear.
const arcVec = (t) => {
    const i = Number(t.match(/arc (\d+)/)?.[1] ?? 0);
    const a = (i / 120) * (Math.PI / 2);
    return [Math.cos(a), Math.sin(a), 0, 0];
};
const ORTHO_DIM = 160;
const orthoVec = (t) => {
    // One-hot by topic number: every vector is orthogonal to every other, so
    // nothing can ever join anything. This is the shape a poorly-separated
    // embedding model produces in the limit.
    const i = Number(t.match(/ortho (\d+)/)?.[1] ?? 0) % ORTHO_DIM;
    const v = new Array(ORTHO_DIM).fill(0);
    v[i] = 1;
    return v;
};
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const { input } = JSON.parse(body || '{}');
        const texts = Array.isArray(input) ? input : [input];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
            embeddings: texts.map(t => arc
                ? arcVec(t)
                : orthogonal
                ? orthoVec(t)
                : collapse
                    ? [1, 0, 0, 0]
                    : (SPACE.find(([re]) => re.test(t))?.[1] ?? [0.1, 0.1, 0.1, 1])),
        }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));

const B = new URL('../server/', import.meta.url).href;
const { default: db, vecAvailable } = await import(B + 'database.js');
const { syncNodeEmbeddings } = await import(B + 'nodeEmbeddings.js');
const { buildAtlas, invalidateAtlas, cleanRegionLabel, layoutMembers } = await import(B + 'atlas.js');
const { validateName, validateUserName, stripJsonName, regionSignature, legacySignature, resolveNameCollisions } = await import(B + 'regionNaming.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const finish = async (code) => {
    await new Promise(r => stub.close(r));
    try { db.close(); } catch { }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { }
    process.exitCode = code;
};

if (!vecAvailable) {
    console.log('SKIPPED: sqlite-vec is not available on this build — the atlas degrades to unavailable, nothing to check.');
    await finish(0);
    process.exit(0);
}

const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                               ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
setSetting.run('ai_ollama_url', `http://127.0.0.1:${stub.address().port}`);
setSetting.run('embedding_model', 'stub-embed');
setSetting.run('embedding_provider', 'ollama');

// ---- an unmapped library is an ANSWER ---------------------------------------
console.log('--- before anything is mapped ---');
const empty = await buildAtlas();
check('an unmapped library does not throw', !!empty);
check('it reports itself unavailable', empty.available === false);
check('with a reason the UI can show', typeof empty.reason === 'string' && empty.reason.length > 10, empty.reason);
check('and empty collections, not undefined', Array.isArray(empty.regions) && Array.isArray(empty.bridges));

// ---- fixture ----------------------------------------------------------------
const mkProject = (name, status = 'active') =>
    db.prepare('INSERT INTO projects (name, status, color) VALUES (?,?,?)').run(name, status, '#7C3AED').lastInsertRowid;
const mkNode = (pid, title, description = '', isNote = 0, status = 'not_started') =>
    db.prepare('INSERT INTO nodes (project_id, title, description, is_note, status) VALUES (?,?,?,?,?)')
        .run(pid, title, description, isNote, status).lastInsertRowid;

const physics = mkProject('TU/e Physics Prep');
const dutch = mkProject('Natuurkunde VWO');
const baking = mkProject('Sourdough');
const oldProj = mkProject('Last Year', 'archived');

// waves, in two languages/projects
const nStanding = mkNode(physics, 'Standing Waves', 'Nodes and antinodes in a pipe.');
mkNode(physics, 'Harmonic Series', 'The harmonic series of a standing wave.');
const nDutch = mkNode(dutch, 'Staande golven', 'Knopen en buiken in een golfpatroon.');
mkNode(dutch, 'Boventonen', 'De harmonische reeks van een golfpatroon.');
// calculus, one project
mkNode(physics, 'Fourier Series', 'Decomposing a signal into sinusoids.');
mkNode(physics, 'The Fourier Integral', 'An integral over sinusoids.');
// baking, one project
mkNode(baking, 'Kneading', 'Develop gluten by kneading the dough.');
mkNode(baking, 'Shaping the loaf', 'Shape the dough before the final proof.');
// excluded material
mkNode(physics, 'Reading: harmonic tables', 'standing wave reference material', 1);
mkNode(oldProj, 'Old Standing Waves', 'Nodes and antinodes in a pipe.');

await syncNodeEmbeddings();

// ---- the map ----------------------------------------------------------------
console.log('\n--- the map ---');
const atlas = await buildAtlas({ refresh: true });
check('the atlas builds', atlas.available === true, atlas.reason || '');
const named = (re) => atlas.regions.filter(r => r.topics.some(t => re.test(t.title)));
check('waves become exactly one region', named(/Standing Waves|Staande golven|Harmonic|Boventonen/).length === 1,
    JSON.stringify(atlas.regions.map(r => `${r.label}(${r.size})`)));
check('calculus becomes exactly one region', named(/Fourier/).length === 1);
check('baking becomes exactly one region', named(/Kneading|Shaping/).length === 1);
check('the three subject areas do not bleed into each other',
    named(/Standing Waves/)[0].id !== named(/Fourier/)[0].id
    && named(/Fourier/)[0].id !== named(/Kneading/)[0].id);
check('notes are not on the map',
    !atlas.regions.some(r => r.topics.some(t => /Reading:/.test(t.title))));
check('archived projects are excluded by default',
    !atlas.regions.some(r => r.topics.some(t => t.title === 'Old Standing Waves')));
check('...and included on request',
    (await buildAtlas({ includeArchived: true, refresh: true }))
        .regions.some(r => r.topics.some(t => t.title === 'Old Standing Waves')));

const waves = atlas.regions.find(r => r.topics.some(t => t.id === nStanding));
check('the wave region gathers both curricula', waves.topics.some(t => t.id === nDutch));
check('and is flagged as cross-project', waves.crossProject === true);
check('it names itself after a member topic',
    waves.topics.some(t => t.title === waves.label), waves.label);
check('the baking region is single-project',
    atlas.regions.find(r => r.topics.some(t => /Kneading/.test(t.title))).crossProject === false);
check('topics are ordered by how representative they are',
    waves.topics.every((t, i, a) => i === 0 || a[i - 1].centrality >= t.centrality));

console.log('\n--- the numbers add up ---');
const s = atlas.stats;
check('every mapped topic lands in exactly one region',
    atlas.regions.reduce((a, r) => a + r.size, 0) === s.mapped, `${s.mapped} mapped`);
check('mastery buckets partition the topics',
    s.proven + s.learning + s.untouched === s.mapped);
// The three fixture projects; the archived one is excluded. (It was four while
// database.js seeded a tutorial project into every empty library.)
check('the project count covers every unarchived project with mapped topics',
    s.projects === 3, `got ${s.projects}`);
check('`topics` counts the library, `mapped` counts what has a vector',
    s.topics >= s.mapped && s.mapped > 0, JSON.stringify(s));

// ---- layout -----------------------------------------------------------------
console.log('\n--- layout ---');
const coords = atlas.regions.flatMap(r => [r.x, r.y, r.radius]);
check('every coordinate is a finite number', coords.every(Number.isFinite), JSON.stringify(coords));
check('regions stay inside the canvas', atlas.regions.every(r => Math.abs(r.x) <= 1 && Math.abs(r.y) <= 1));
check('radii are positive', atlas.regions.every(r => r.radius > 0));
// Area, not width, must track size — so radius scales with the square root.
const bySize = [...atlas.regions].sort((a, b) => a.size - b.size);
check('a bigger region is drawn bigger',
    bySize.every((r, i, a) => i === 0 || a[i - 1].size > r.size || a[i - 1].radius <= r.radius + 1e-9));
check('distinct regions do not sit on top of each other',
    atlas.regions.every((r, i) => atlas.regions.every((o, j) =>
        i === j || Math.hypot(r.x - o.x, r.y - o.y) > 1e-3)));

// ---- determinism ------------------------------------------------------------
console.log('\n--- determinism (a map must be recognisable next visit) ---');
invalidateAtlas();
const again = await buildAtlas({ refresh: true });
const shape = (a) => JSON.stringify(a.regions.map(r => [r.label, r.size, r.x.toFixed(6), r.y.toFixed(6)]));
check('two independent builds draw the identical map', shape(atlas) === shape(again),
    `${shape(atlas)}\n      vs ${shape(again)}`);
check('bridges come out in the same order',
    JSON.stringify(atlas.bridges.map(b => [b.a.id, b.b.id])) ===
    JSON.stringify(again.bridges.map(b => [b.a.id, b.b.id])));

console.log('\n--- caching ---');
const t1 = (await buildAtlas()).builtAt;
const t2 = (await buildAtlas()).builtAt;
check('an unchanged library is served from cache', t1 === t2);
mkNode(baking, 'Scoring', 'Score the dough before baking.');
await syncNodeEmbeddings();
check('adding a topic invalidates the cache', (await buildAtlas()).builtAt !== t1);
check('...and the topic appears', (await buildAtlas()).stats.mapped === s.mapped + 1);

// ---- bridges ----------------------------------------------------------------
console.log('\n--- bridges ---');
const bridged = atlas.bridges;
check('the cross-language pair is found',
    bridged.some(b => [b.a.id, b.b.id].includes(nStanding) && [b.a.id, b.b.id].includes(nDutch)),
    JSON.stringify(bridged.map(b => `${b.a.title}~${b.b.title}`)));
check('a bridge never joins two topics in the SAME project',
    bridged.every(b => b.a.projectId !== b.b.projectId));
check('bridges carry a similarity', bridged.every(b => b.similarity > 0 && b.similarity <= 1));
db.prepare(`UPDATE nodes SET status = 'completed' WHERE id = ?`).run(nDutch);
db.prepare(`INSERT INTO node_mastery (node_id, mastery_score, total_attempts) VALUES (?, 0.95, 8)`).run(nDutch);
const withProven = await buildAtlas({ refresh: true });
const pair = withProven.bridges.find(b => [b.a.id, b.b.id].includes(nDutch));
check('a proven side is put FIRST (it reads "you know this → this is waiting")',
    pair.a.id === nDutch, JSON.stringify(pair && { a: pair.a.title, b: pair.b.title }));
check('and the pair is flagged actionable', pair.proven === true);
check('actionable bridges sort above the rest',
    withProven.bridges.every((b, i, a) => i === 0 || !(b.proven && !a[i - 1].proven)));

// ---- degenerate libraries ---------------------------------------------------
console.log('\n--- degenerate libraries (where a layout normally divides by zero) ---');
db.prepare('DELETE FROM nodes').run();
db.prepare('DELETE FROM node_embeddings').run();
db.prepare('DELETE FROM vec_nodes').run();
const solo = mkProject('Solo');
mkNode(solo, 'Standing Waves', 'Nodes and antinodes in a pipe.');
await syncNodeEmbeddings();
const one = await buildAtlas({ refresh: true });
check('a one-topic library still maps', one.available === true && one.regions.length === 1);
check('the lone region is finite and centred',
    Number.isFinite(one.regions[0].x) && Number.isFinite(one.regions[0].y)
    && one.regions[0].x === 0 && one.regions[0].y === 0);
check('a lone topic is not a landmark', one.regions[0].isLandmark === false);
check('no bridges are invented', one.bridges.length === 0);

// Every vector identical: the covariance has no variance to project, which is
// where a naive PCA emits NaN and the map renders blank.
collapse = true;
db.prepare('DELETE FROM node_embeddings').run();
for (let i = 0; i < 6; i++) mkNode(solo, `Topic ${i}`, 'identical meaning');
await syncNodeEmbeddings();
const flat = await buildAtlas({ refresh: true });
check('a library where everything means the same thing still maps', flat.available === true);
check('...to a single region', flat.regions.length === 1, `got ${flat.regions.length}`);
check('...with finite coordinates (no NaN from a zero-variance PCA)',
    flat.regions.every(r => Number.isFinite(r.x) && Number.isFinite(r.y)));
collapse = false;

// The library that refuses to cluster. A hardcoded region threshold that does
// not suit the user's embedding model produces one region per topic, and
// because leader clustering costs topics × regions that is QUADRATIC: measured
// at 19.5 seconds of blocked CPU on a 3312-topic library before the threshold
// was derived from the data and the region count capped. The structural
// property is what's asserted here — a bound on regions IS the bound on cost.
console.log('\n--- the library that refuses to cluster ---');
orthogonal = true;
db.prepare('DELETE FROM nodes').run();
db.prepare('DELETE FROM node_embeddings').run();
const wide = mkProject('Wide');
for (let i = 0; i < 300; i++) mkNode(wide, `ortho ${i}`, `unrelated subject ${i}`);
await syncNodeEmbeddings();
const t0 = Date.now();
const hard = await buildAtlas({ refresh: true });
const elapsed = Date.now() - t0;
check('300 mutually-orthogonal topics still produce a map', hard.available === true, hard.reason || '');
check('the region count is CAPPED, not one per topic',
    hard.regions.length <= hard.stats.regionCap, `${hard.regions.length} regions`);
check('and the map says it was capped', hard.stats.capped === true);
check('every topic is still placed somewhere',
    hard.regions.reduce((a, r) => a + r.size, 0) === hard.stats.mapped);
check('the threshold was derived from the data and reported',
    typeof hard.stats.regionSimilarity === 'number' && hard.stats.regionSimilarity >= 0.5,
    String(hard.stats.regionSimilarity));
// Generous: this is a smoke alarm for a return to quadratic behaviour, not a
// benchmark. The pre-fix version took ~19s for 10x this many topics.
check('it finishes promptly rather than degrading to quadratic', elapsed < 8000, `${elapsed}ms`);
check('coordinates survive a library with no structure at all',
    hard.regions.every(r => Number.isFinite(r.x) && Number.isFinite(r.y)));
orthogonal = false;

// ---- the landfill -----------------------------------------------------------
// The failure this section exists for, in one number: on a real 1885-topic
// library ONE region held 583 topics from 8 projects — Linux exploitation,
// Y-Combinator history, C# data binding and Japanese kana — because assignment
// puts every topic in its nearest region with no floor on how near that is.
// The map drew it as one huge bubble with a label from whatever fell in first,
// which is a wrong answer to "what do I know?" drawn convincingly.
console.log('\n--- the landfill (a region that is really several) ---');
orthogonal = false;
arc = true;
db.prepare('DELETE FROM nodes').run();
db.prepare('DELETE FROM node_embeddings').run();
const chain = mkProject('Chain');
for (let i = 0; i < 120; i++) mkNode(chain, `arc ${i}`, `chained subject ${i}`);
await syncNodeEmbeddings();
const split = await buildAtlas({ refresh: true });
invalidateAtlas();
const again2 = await buildAtlas({ refresh: true });
check('a chained library still maps', split.available === true, split.reason || '');
check('no region is allowed to become a landfill',
    split.regions.every(r => r.size <= split.stats.regionSizeCap),
    `largest ${split.stats.largestRegion} vs cap ${split.stats.regionSizeCap}`);
check('it is split into several regions, not one',
    split.regions.length >= 4, `${split.regions.length} regions`);
check('the two ends of the chain do NOT share a region', (() => {
    const home = (title) => split.regions.find(r => r.topics.some(t => t.title === title))?.id;
    return home('arc 0') !== home('arc 119');
})());
check('splitting still places every topic exactly once',
    split.regions.reduce((a, r) => a + r.size, 0) === split.stats.mapped);
check('a split map is still deterministic', (() => {
    const shape2 = (a) => JSON.stringify(a.regions.map(r => [r.label, r.size, r.x.toFixed(6)]));
    return shape2(split) === shape2(again2);
})(), 'two builds disagree');

// ---- topics have a place inside their region --------------------------------
console.log('\n--- topics are placed, not just counted ---');
check('every topic carries finite coordinates',
    split.regions.every(r => r.topics.every(t => Number.isFinite(t.x) && Number.isFinite(t.y))));
check('every topic is packed INSIDE its own bubble',
    split.regions.every(r => r.topics.every(t =>
        Math.hypot(t.x - r.x, t.y - r.y) <= r.radius + 1e-6)),
    'a dot drawn outside its circle is a lie about where it belongs');
check('a topic dot is smaller than the region holding it',
    split.regions.every(r => r.topicRadius > 0 && r.topicRadius < r.radius));
check('bubbles fit the canvas rather than being clamped to its walls',
    split.regions.every(r => Math.abs(r.x) + r.radius <= 1.001 && Math.abs(r.y) + r.radius <= 1.001),
    'clamping is not a fit — it stacks overflow onto the edge');
// The pile-up. Members were projected around `region.centroid`, which is the
// mean RENORMALISED back onto the unit sphere and therefore sits outside the
// cloud it came from — so every row carried the same offset, PCA found that
// offset as its first component, and a bubble drew all of its dots heaped
// against one wall with empty space opposite. Nothing threw; the picture was
// just wrong. Both properties are asserted because either alone passes for the
// wrong reason: a centred needle is balanced but empty, and a lopsided clump
// can still reach far from the middle.
const sizeable = split.regions.filter(r => r.size >= 8);
const offCentre = (r) => {
    const mx = r.topics.reduce((a, t) => a + t.x, 0) / r.topics.length;
    const my = r.topics.reduce((a, t) => a + t.y, 0) / r.topics.length;
    return Math.hypot(mx - r.x, my - r.y) / r.radius;
};
const usedArea = (r) => {
    // Share of the bubble's width and height the dots actually occupy.
    const xs = r.topics.map(t => t.x), ys = r.topics.map(t => t.y);
    return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
        / (2 * r.radius);
};
check('a region is enough to check the packing with', sizeable.length >= 2, `${sizeable.length} regions of 8+`);

// Straight at `layoutMembers`, on a cloud spread widely enough for the
// renormalised centroid to sit well outside it — the shape a real region has
// and a chained fixture does not. Before the fix this drew every dot on one
// side of the bubble: the mean landed ~0.5 of the radius from the middle.
const fan = (() => {
    const members = [];
    for (let i = 0; i < 40; i++) {
        const a = (i / 39) * 1.4;                    // ~80° of arc
        const b = ((i * 7) % 40) / 39 * 0.5;         // a little thickness across it
        const v = [Math.cos(a), Math.sin(a) * Math.cos(b), Math.sin(a) * Math.sin(b), 0];
        members.push({ vec: Float32Array.from(v) });
    }
    const sum = [0, 0, 0, 0];
    for (const m of members) for (let d = 0; d < 4; d++) sum[d] += m.vec[d] / members.length;
    const norm = Math.hypot(...sum);
    return { members, centroid: Float32Array.from(sum.map(x => x / norm)) };
})();
const placed = layoutMembers(fan, { x: 0, y: 0 }, 1);
const mid = {
    x: placed.reduce((a, p) => a + p.x, 0) / placed.length,
    y: placed.reduce((a, p) => a + p.y, 0) / placed.length,
};
check('a spread-out region is projected around its own middle', Math.hypot(mid.x, mid.y) < 0.12,
    `mean sits ${Math.hypot(mid.x, mid.y).toFixed(2)} of the radius off centre — the renormalised-centroid pile-up`);
check('and it reaches both ways along both axes',
    Math.min(...placed.map(p => p.x)) < -0.3 && Math.max(...placed.map(p => p.x)) > 0.3
    && Math.min(...placed.map(p => p.y)) < -0.3 && Math.max(...placed.map(p => p.y)) > 0.3);
check('every placed member is still inside the bubble',
    placed.every(p => Math.hypot(p.x, p.y) <= 1 + 1e-9));
check('topics sit AROUND the middle of their bubble, not heaped on one wall',
    sizeable.every(r => offCentre(r) < 0.3),
    `worst ${Math.max(...sizeable.map(offCentre)).toFixed(2)} of the radius off centre`);
check('and they spread over the bubble instead of a stripe across it',
    sizeable.every(r => usedArea(r) > 0.45),
    `tightest ${Math.min(...sizeable.map(usedArea)).toFixed(2)} of the diameter on its narrow axis`);
check('the arrangement actually USES the canvas', (() => {
    // The counterpart of the check above: fitting must scale a small map UP,
    // or a sparse library draws itself as a dot in the middle of empty space.
    const xs = split.regions.map(r => r.x);
    return Math.max(...xs) - Math.min(...xs) > 1.2;
})());

// ---- the course's own shape, carried onto the map ---------------------------
// The map dissolves courses on purpose, which is exactly why the paths layer
// has to carry the curriculum's structure back explicitly. Every way it can go
// wrong is a picture rather than an exception: an edge to a node with no
// coordinates is a line to nowhere, an edge across a project boundary draws a
// course that does not exist, and a journey sorted by the wrong key walks a
// plausible route through the wrong topics in the wrong order.
console.log('\n--- lineage and the journey ---');
collapse = false; orthogonal = false; arc = false;
db.prepare('DELETE FROM nodes').run();
db.prepare('DELETE FROM node_embeddings').run();
db.prepare('DELETE FROM vec_nodes').run();

const mkChild = (pid, parent, title, description, opts = {}) =>
    db.prepare(`INSERT INTO nodes (project_id, parent_id, title, description, is_note, status, role, completed_at)
                VALUES (?,?,?,?,?,?,?,?)`)
        .run(pid, parent, title, description, opts.isNote ? 1 : 0,
            opts.status || 'not_started', opts.role || 'topic', opts.completedAt || null)
        .lastInsertRowid;

const course = mkProject('Waves Course');
const sibling = mkProject('Baking Course');

// A root, and under it the three ways an ancestor can be absent from the map.
const cRoot = mkChild(course, null, 'Standing Waves', 'Nodes and antinodes in a pipe.');
const cNote = mkChild(course, cRoot, 'Reading: harmonic tables', 'standing wave reference', { isNote: true });
const cUnderNote = mkChild(course, cNote, 'Antinodes in a pipe', 'Nodes and antinodes in a pipe.');
const cStage = mkChild(course, cRoot, 'Stage 1', 'a cut out of card order', { role: 'pagination' });
const cUnderStage = mkChild(course, cStage, 'Harmonic series of a pipe', 'The harmonic series of a standing wave.');
const cMid = mkChild(course, cRoot, 'Wave patterns', 'Nodes and antinodes in a golfpatroon.',
    { status: 'completed', completedAt: '2026-03-02T09:00:00.000Z' });
const cDeep = mkChild(course, cMid, 'Beats and antinodes', 'Beats between two standing wave frequencies.',
    { status: 'completed', completedAt: '2026-03-01T09:00:00.000Z' });
// Closed, but with nothing that says WHEN: this one may never be given a place
// in the sequence, and must be counted instead.
const cUndated = mkChild(course, cRoot, 'Resonance in a pipe', 'Antinode resonance of a standing wave.',
    { status: 'completed' });
// Another project entirely, whose topics must never be linked to this one.
const bRoot = mkChild(sibling, null, 'Sourdough', 'Kneading the dough to develop gluten.');
mkChild(sibling, bRoot, 'Shaping the loaf', 'Shape the dough before the final proof.',
    { status: 'completed', completedAt: '2026-03-03T09:00:00.000Z' });

await syncNodeEmbeddings();
const tree = await buildAtlas({ refresh: true });
const allTopics = tree.regions.flatMap(r => r.topics);
const topicById = new Map(allTopics.map(t => [t.id, t]));
const mappedIds = new Set(topicById.keys());

check('the tree library maps', tree.available === true, tree.reason || '');
check('every topic carries a lineage', allTopics.every(t =>
    'parentId' in t && typeof t.depth === 'number' && 'completedAt' in t));
check('a root has no parent on the map', topicById.get(cRoot)?.parentId === null);
check('and a root sits at depth 0', topicById.get(cRoot)?.depth === 0);
// The three kinds of gap, all resolving the same way: walk up, do not orphan.
check('a topic under a NOTE links to the nearest mapped ancestor',
    topicById.get(cUnderNote)?.parentId === cRoot,
    `got ${topicById.get(cUnderNote)?.parentId}`);
check('a topic under a PAGINATION slice links past it too',
    topicById.get(cUnderStage)?.parentId === cRoot,
    `got ${topicById.get(cUnderStage)?.parentId}`);
check('skipping an unmapped ancestor does not inflate the depth',
    topicById.get(cUnderNote)?.depth === 1, `got ${topicById.get(cUnderNote)?.depth}`);
check('a genuinely deeper topic IS deeper',
    topicById.get(cDeep)?.parentId === cMid && topicById.get(cDeep)?.depth === 2,
    `parent ${topicById.get(cDeep)?.parentId}, depth ${topicById.get(cDeep)?.depth}`);
// A line to a node with no coordinates cannot be drawn, and a line between two
// courses would be a course that does not exist.
check('no parent link points off the map',
    allTopics.every(t => t.parentId === null || mappedIds.has(t.parentId)));
check('no parent link crosses a project',
    allTopics.every(t => t.parentId === null
        || topicById.get(t.parentId).projectId === t.projectId));
check('a finish is an ISO instant, not whatever the column happened to hold',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(topicById.get(cMid)?.completedAt || ''),
    String(topicById.get(cMid)?.completedAt));
check('a finish with no timestamp stays null rather than being invented',
    topicById.get(cUndated)?.completedAt === null);
check('an unfinished topic has no finish', topicById.get(cRoot)?.completedAt === null);
check('the map reports how many finishes it can place in time', tree.stats.dated === 3,
    `dated ${tree.stats.dated}`);
check('...and how many it cannot', tree.stats.undated === 1, `undated ${tree.stats.undated}`);
invalidateAtlas();
const treeAgain = await buildAtlas({ refresh: true });
const lineageShape = (a) => JSON.stringify(
    a.regions.flatMap(r => r.topics.map(t => [t.id, t.parentId, t.depth, t.completedAt]))
        .sort((x, y) => x[0] - y[0]));
check('lineage is deterministic', lineageShape(treeAgain) === lineageShape(tree));

// `parent_id` is a self-referential FK and nothing in the schema forbids a
// loop. A loop here is an infinite one inside a request handler, so the walk is
// capped — this is the check that the cap is real rather than intended.
db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(cDeep, cMid);
invalidateAtlas();
const looped = await Promise.race([
    buildAtlas({ refresh: true }),
    new Promise(r => setTimeout(() => r(null), 5000)),
]);
check('a parent cycle does not hang the build', looped !== null);
check('...and every depth it produces is still finite',
    !!looped && looped.regions.every(r => r.topics.every(t => Number.isFinite(t.depth) && t.depth <= 64)));
db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(cRoot, cMid);
invalidateAtlas();

// The client half: which courses can be traced, and what one trace contains.
// Bundled and driven directly, because everything in it is arithmetic that
// produces a PICTURE when it is wrong — the canvas cannot report a journey in
// the wrong order, it can only draw one.
let coursePaths = null;
try {
    const { build } = await import('esbuild');
    const outfile = join(scratch, 'coursePaths.mjs');
    await build({
        entryPoints: [fileURLToPath(new URL('../src/components/atlas/coursePaths.ts', import.meta.url))],
        bundle: true, format: 'esm', outfile, logLevel: 'silent',
    });
    coursePaths = await import(pathToFileURL(outfile).href);
} catch (err) {
    console.log(`SKIPPED: course paths — esbuild unavailable (${err.message.split('\n')[0]})`);
}

if (coursePaths) {
    const fresh = await buildAtlas({ refresh: true });
    const courses = coursePaths.listCourses(fresh.regions);
    const traced = coursePaths.traceCourse(fresh.regions, course);

    check('both courses are offered', courses.length === 2, JSON.stringify(courses.map(c => c.name)));
    // Six, not the eight nodes the course holds: the note and the pagination
    // slice are not topics and are not on the map, so they are not offered as
    // something to trace through either.
    check('a course counts its MAPPED topics', courses.find(c => c.id === course)?.topics === 6,
        String(courses.find(c => c.id === course)?.topics));
    check('a course counts only the finishes it can place',
        courses.find(c => c.id === course)?.finished === 2,
        String(courses.find(c => c.id === course)?.finished));
    check('...and reports the one it cannot', courses.find(c => c.id === course)?.undated === 1);
    check('a project with nothing on the map cannot be traced',
        coursePaths.traceCourse(fresh.regions, 99999) === null);

    check('a trace holds only its own course',
        !!traced && [...traced.points.values()].every(p => p.topic.projectId === course));
    check('every point knows the bubble it collapses into',
        !!traced && [...traced.points.values()].every(p =>
            fresh.regions.some(r => r.id === p.regionId && r.topics.some(t => t.id === p.id))));
    check('the journey runs oldest first', (() => {
        if (!traced) return false;
        const at = traced.journey.map(id => traced.points.get(id).topic.completedAt);
        return at.length === 2 && at[0] < at[1];
    })(), JSON.stringify(traced?.journey.map(id => traced.points.get(id).topic.completedAt)));
    check('the journey starts where the learner did, not where the tree does',
        !!traced && traced.journey[0] === cDeep, `started at ${traced?.journey[0]}`);
    check('an undated finish is counted, never placed',
        !!traced && traced.undated === 1 && !traced.journey.includes(cUndated));
    check('an unfinished topic is not on the path',
        !!traced && !traced.journey.includes(cRoot));
    check('the trace is deterministic', (() => {
        const twice = coursePaths.traceCourse(fresh.regions, course);
        return JSON.stringify(twice.journey) === JSON.stringify(traced.journey);
    })());

    // ---- the journey in TIME -------------------------------------------------
    // The map draws the journey in space and the replay counts it in events;
    // the panel's bar is the only place it is drawn in DATES, and every way that
    // can be wrong is a picture drawn confidently in the wrong proportions. A
    // span measured from the first finish instead of from the course's own start
    // crops the run-up out of the record; a fraction list that drops an entry
    // moves every step after it along the bar.
    const { journeyTimeline } = coursePaths;
    // Two dates, and the course began on the EARLIER of them: on the real
    // library the scheduled start is a plan made a fortnight after the first
    // topic was closed, and reading it as the beginning would crop that
    // fortnight off the learner's own record.
    db.prepare('UPDATE projects SET start_date = ?, created_at = ? WHERE id = ?')
        .run('2026-02-01', '2026-01-15 08:00:00', course);
    const begun = coursePaths.traceCourse((await buildAtlas({ refresh: true })).regions, course);
    const line = journeyTimeline(begun);
    const ms = iso => Date.parse(iso);

    check('a course began on the earlier of its two dates, not on the plan',
        begun?.startedAt === '2026-01-15T08:00:00Z', String(begun?.startedAt));
    check('the bar begins at the COURSE, not at its first finish',
        !!line && line.startMs === ms('2026-01-15T08:00:00Z') && line.hasRunUp === true);
    check('the first finish is a place ON the bar',
        !!line && line.firstMs === ms('2026-03-01T09:00:00.000Z') && line.at[0] > 0 && line.at[0] < 1);
    check('the last finish is its right-hand end',
        !!line && line.lastMs === ms('2026-03-02T09:00:00.000Z') && line.at[line.at.length - 1] === 1);
    check('one fraction per step, in step order',
        !!line && line.at.length === begun.journey.length && line.at.every(f => f >= 0 && f <= 1)
        && line.at.every((f, i) => i === 0 || f >= line.at[i - 1]));

    // A start date later than the first finish is not a start: a project whose
    // dates were edited after the fact would otherwise draw its whole journey
    // off the left-hand end of its own bar.
    db.prepare('UPDATE projects SET start_date = ?, created_at = ? WHERE id = ?')
        .run('2026-06-01', '2026-06-02 10:00:00', course);
    const late = journeyTimeline(
        coursePaths.traceCourse((await buildAtlas({ refresh: true })).regions, course));
    check('a start after the first finish is no start',
        !!late && late.hasRunUp === false && late.startMs === late.firstMs && late.at[0] === 0);

    // Synthetic from here: the shapes a real library has and this fixture
    // cannot — a course finished in one afternoon, and one with more finishes
    // than the bar has pixels.
    const fakeJourney = (isos, startedAt = null) => ({
        journey: isos.map((_, i) => i + 1),
        points: new Map(isos.map((completedAt, i) => [i + 1, { topic: { completedAt } }])),
        startedAt,
    });
    check('nothing finished is no timeline at all', journeyTimeline(fakeJourney([])) === null);
    check('a journey of one instant is all of the bar, not a division by zero', (() => {
        const one = journeyTimeline(fakeJourney(['2026-03-01T09:00:00Z']));
        return !!one && one.at.length === 1 && one.at[0] === 1 && one.marks.length === 1;
    })());
    check('a date the panel cannot read does not shift the steps after it', (() => {
        const broken = journeyTimeline(fakeJourney(
            ['2026-03-01T00:00:00Z', 'whenever', '2026-03-03T00:00:00Z']));
        return !!broken && broken.at.length === 3 && broken.at[1] === broken.at[0];
    })());
    check('a thousand finishes do not become a thousand marks', (() => {
        const isos = [];
        for (let i = 0; i < 1000; i++) isos.push(new Date(Date.UTC(2026, 0, 1) + i * 36e5).toISOString());
        const dense = journeyTimeline(fakeJourney(isos, '2026-01-01T00:00:00Z'));
        return !!dense && dense.at.length === 1000
            && dense.marks.length <= 1 / dense.grid + 1
            && dense.marks.every((f, i) => i === 0 || f > dense.marks[i - 1]);
    })());
    // Put the fixture back the way the rest of the file found it.
    db.prepare('UPDATE projects SET start_date = NULL WHERE id = ?').run(course);

    // ---- the flight the arrow actually takes ---------------------------------
    // The replay is a thing MOVING between the topics, so the route it moves
    // along is curved: an arrow on a polyline turns a corner in one frame,
    // which reads as the teleporting it was meant to replace. Every failure
    // here is a picture — a curve that misses the topic it is supposed to pass
    // through, a heading that swings backwards, a NaN that erases the path — so
    // the arithmetic is driven directly rather than looked at.
    const { flightPath, legAt, legUpTo } = coursePaths;
    const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
    const route = [
        { x: 0, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 12 }, { x: 22, y: 14 }, { x: 30, y: 2 },
    ];
    const legs = flightPath(route);

    check('a route has one leg per gap', legs.length === route.length - 1, String(legs.length));
    check('a single place is a place, not a route', flightPath([{ x: 1, y: 1 }]).length === 0);
    check('an empty journey draws nothing', flightPath([]).length === 0);
    // The bend is in the route BETWEEN topics; the topics themselves are data
    // and a curve that smooths them is drawing a course nobody took.
    check('the curve passes exactly through every topic', legs.every((leg, i) => {
        const a = legAt(leg, 0), b = legAt(leg, 1);
        return near(a.x, route[i].x) && near(a.y, route[i].y)
            && near(b.x, route[i + 1].x) && near(b.y, route[i + 1].y);
    }));
    check('...and it is a curve, not the straight line it joins', legs.some((leg, i) => {
        const mid = legAt(leg, 0.5);
        return Math.hypot(mid.x - (route[i].x + route[i + 1].x) / 2,
            mid.y - (route[i].y + route[i + 1].y) / 2) > 0.2;
    }));
    // A handle longer than the hop is what makes a cubic loop: the arrow flies
    // out past the topic, turns round and comes back to it.
    check('no leg can loop: every handle is inside its own chord', legs.every(leg => {
        const chord = Math.hypot(leg.x3 - leg.x0, leg.y3 - leg.y0);
        return Math.hypot(leg.x1 - leg.x0, leg.y1 - leg.y0) <= chord * 0.5 + 1e-9
            && Math.hypot(leg.x2 - leg.x3, leg.y2 - leg.y3) <= chord * 0.5 + 1e-9;
    }));
    check('the heading turns continuously through a corner', (() => {
        // The end of one leg and the start of the next must agree, or the arrow
        // pivots on the spot — the exact thing the curve is for.
        for (let i = 1; i < legs.length; i++) {
            const inAngle = legAt(legs[i - 1], 1).angle;
            const out = legAt(legs[i], 0).angle;
            let d = Math.abs(inAngle - out) % (2 * Math.PI);
            if (d > Math.PI) d = 2 * Math.PI - d;
            if (d > 0.35) return false;
        }
        return true;
    })());
    check('the heading runs forwards along the route', legs.every((leg, i) => {
        const h = legAt(leg, 0.5);
        const dx = route[i + 1].x - route[i].x, dy = route[i + 1].y - route[i].y;
        return Math.cos(h.angle) * dx + Math.sin(h.angle) * dy > 0;
    }));
    // Zoomed out, every topic in one bubble is drawn at that bubble's centre —
    // so coincident points are the ORDINARY case here, not an edge one.
    check('collapsed points produce a route, never a NaN', (() => {
        const flat = flightPath([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 9, y: 1 }]);
        return flat.length === 3 && flat.every(l =>
            [l.x0, l.y0, l.x1, l.y1, l.x2, l.y2, l.x3, l.y3].every(Number.isFinite))
            && Number.isFinite(legAt(flat[0], 0.5).angle);
    })());
    check('the part flown ends where the arrow is', (() => {
        for (const t of [0.01, 0.25, 0.5, 0.9]) {
            const part = legUpTo(legs[1], t);
            const head = legAt(legs[1], t);
            if (!near(part.x3, head.x, 1e-9) || !near(part.y3, head.y, 1e-9)) return false;
            if (!near(part.x0, legs[1].x0) || !near(part.y0, legs[1].y0)) return false;
        }
        return true;
    })());
    check('...and the whole of it is the leg itself', (() => {
        const whole = legUpTo(legs[2], 1);
        return ['x0', 'y0', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3'].every(k => near(whole[k], legs[2][k], 1e-9));
    })());
    check('the flown part stays ON the leg, never cutting the corner', (() => {
        // Half of a curve is not the same shape as a line to its midpoint, and
        // stroking the second would make the path snap straight behind the
        // arrow as it flew.
        const part = legUpTo(legs[1], 0.6);
        for (const t of [0.2, 0.5, 0.8]) {
            const on = legAt(part, t);
            const same = legAt(legs[1], t * 0.6);
            if (!near(on.x, same.x, 1e-9) || !near(on.y, same.y, 1e-9)) return false;
        }
        return true;
    })());
    check('a real journey curves without NaN', (() => {
        const places = traced.journey.map(id => {
            const p = traced.points.get(id);
            return { x: p.x, y: p.y };
        });
        const real = flightPath(places);
        return real.length === places.length - 1
            && real.every(l => [l.x0, l.y0, l.x1, l.y1, l.x2, l.y2, l.x3, l.y3].every(Number.isFinite));
    })());

    // ---- what a step COSTS in time ------------------------------------------
    // A fixed beat made the arrow's speed the thing that varied: a hop inside
    // one bubble and a hop across the library both took 420ms, so the far one
    // was a blur and the near one a crawl. The beat is bought by the distance
    // now, and these are the properties that has to keep.
    const { stepDurationMs, STEP_MIN_MS, STEP_MAX_MS } = coursePaths;
    const fakeTrace = (...places) => ({
        journey: places.map((_, i) => i + 1),
        points: new Map(places.map((p, i) => [i + 1, { x: p[0], y: p[1] }])),
    });
    const near0 = fakeTrace([0, 0], [0.01, 0]);
    const far = fakeTrace([0, 0], [1.2, 0]);
    check('a longer hop takes longer', stepDurationMs(far, 2) > stepDurationMs(near0, 2),
        `${Math.round(stepDurationMs(near0, 2))}ms vs ${Math.round(stepDurationMs(far, 2))}ms`);
    check('the first step is an appearance, not a flight',
        stepDurationMs(far, 1) === STEP_MIN_MS);
    check('every step is inside the clamps', [
        fakeTrace([0, 0], [0, 0]), near0, fakeTrace([0, 0], [0.3, 0.3]), far,
        fakeTrace([0, 0], [40, 40]),
    ].every(t => {
        const ms = stepDurationMs(t, 2);
        return ms >= STEP_MIN_MS && ms <= STEP_MAX_MS;
    }));
    // Proportional timing is constant speed, which is honest and unwatchable:
    // this map's hops span two orders of magnitude, so a linear ramp would put
    // the long ones into the tens of seconds each.
    check('the ramp is sublinear: ten times the distance is not ten times the wait', (() => {
        const short = stepDurationMs(fakeTrace([0, 0], [0.02, 0]), 2) - STEP_MIN_MS;
        const long = stepDurationMs(fakeTrace([0, 0], [0.2, 0]), 2) - STEP_MIN_MS;
        return long > short * 2 && long < short * 5;
    })());
    check('a step the map cannot place is a number, not a NaN', (() => {
        const ms = stepDurationMs({ journey: [7, 8], points: new Map() }, 2);
        return Number.isFinite(ms) && ms === STEP_MIN_MS;
    })());
    // ---- the leg is flown by DISTANCE, not by the curve's parameter --------
    // A cubic is not traversed evenly by its own `t`: on the shapes a real
    // journey makes, the middle of a leg goes up to seven times faster than its
    // ends. What that looks like is an arrow that sits still for the first part
    // of its beat and then bolts — "it starts moving already halfway" — and it
    // is not a timing fault at all, it is distance and time not being the same
    // axis. `legParam` maps one onto the other.
    const { legParam } = coursePaths;
    const evenness = (leg, param) => {
        const N = 48;
        const steps = [];
        for (let i = 0; i < N; i++) {
            const a = legAt(leg, param(i / N)), b = legAt(leg, param((i + 1) / N));
            steps.push(Math.hypot(b.x - a.x, b.y - a.y));
        }
        const sorted = steps.slice().sort((a, b) => a - b);
        return sorted[N - 1] / (sorted[0] || 1e-9);
    };
    // The shapes a real course produces: a tight cluster, a long hop out of it,
    // a corner, and the coincident pair a zoomed-out map hands it constantly.
    const shapes = flightPath([
        { x: 0, y: 0 }, { x: 0.02, y: 0.01 }, { x: 0.4, y: 0.2 }, { x: 0.42, y: 0.22 },
        { x: -0.3, y: 0.5 }, { x: -0.3, y: 0.5 }, { x: 0.1, y: -0.4 },
    ]).filter(l => Math.hypot(l.x3 - l.x0, l.y3 - l.y0) > 1e-6);
    const rawWorst = Math.max(...shapes.map(l => evenness(l, t => t)));
    const flownWorst = Math.max(...shapes.map(l => evenness(l, u => legParam(l, u))));
    check('the curve itself is nothing like even — which is why this exists',
        rawWorst > 2, `worst ${rawWorst.toFixed(1)}x by parameter`);
    check('flown by distance, every millisecond buys the same millimetre',
        flownWorst < 1.35, `worst ${flownWorst.toFixed(2)}x by length`);
    check('...and it still starts at the start and ends at the end', (() => {
        const l = shapes[1];
        const a = legAt(l, legParam(l, 0)), b = legAt(l, legParam(l, 1));
        return Math.hypot(a.x - l.x0, a.y - l.y0) < 1e-9
            && Math.hypot(b.x - l.x3, b.y - l.y3) < 1e-9;
    })());
    check('a leg with no length at all is not a division by zero', (() => {
        const flat = { x0: 3, y0: 3, x1: 3, y1: 3, x2: 3, y2: 3, x3: 3, y3: 3 };
        const u = legParam(flat, 0.4);
        return Number.isFinite(u) && u >= 0 && u <= 1;
    })());

    // ---- the two clocks have to be in PHASE, not merely the same shape -----
    // The page waits a beat and then advances the step; the canvas crosses the
    // leg INTO that step in `beat × FLIGHT_SHARE`. Both read `stepDurationMs`,
    // which is necessary and was not sufficient: the page was waiting the beat
    // of the NEXT leg while the canvas flew the current one, so a short hop
    // followed by a long one parked the arrow for the difference (up to a
    // second, on a real library) and a long hop followed by short ones started the
    // next beat before the arrow had landed, the lag compounding until it
    // tripped `FLIGHT_CUT` and the map cut. Both were visible on screen.
    //
    // Simulated over the fixture's own journey: the arrow must be at rest when
    // each beat ends, and it must never be more than one leg behind.
    const { FLIGHT_SHARE } = coursePaths;
    check('the arrow lands inside every beat, and never runs late', (() => {
        let at = 1, worstIdle = 0, worstLag = 0;
        for (let step = 2; step <= traced.journey.length; step++) {
            const beat = stepDurationMs(traced, step);     // what the page waits at `step`
            // The canvas is handed the leg when the step advances and crosses
            // it at the beat of THAT leg.
            const flightMs = stepDurationMs(traced, step) * FLIGHT_SHARE;
            worstLag = Math.max(worstLag, flightMs - beat);
            worstIdle = Math.max(worstIdle, beat - flightMs);
            at = step;
        }
        return at === traced.journey.length && worstLag <= 0
            && worstIdle <= Math.max(...traced.journey.map((_, i) => stepDurationMs(traced, i + 1))) * (1 - FLIGHT_SHARE) + 1e-9;
    })());
    check('a landing is a pause, not a wait: it is a fixed share of its own beat',
        FLIGHT_SHARE > 0.5 && FLIGHT_SHARE < 1);

    // The page's step clock and the canvas's flight must schedule on ONE
    // function, or the arrow lands early or never — the same rule the old
    // exported constant existed for.
    const view = readFileSync(new URL('../src/components/AtlasView.tsx', import.meta.url), 'utf8');
    const map = readFileSync(new URL('../src/components/atlas/AtlasMap.tsx', import.meta.url), 'utf8');
    const globe = readFileSync(new URL('../src/components/atlas/GlobeMap.tsx', import.meta.url), 'utf8');
    // Where the arrow IS between two topics is arithmetic, and it lives in
    // `coursePaths.ts` because the atlas has TWO surfaces to fly it on. The
    // scans below read it there. A second copy of any of this in a renderer is
    // a second clock, and the first thing that would drift is a course
    // replaying at a different speed depending which way you were looking at
    // the library.
    const paths = readFileSync(new URL('../src/components/atlas/coursePaths.ts', import.meta.url), 'utf8');
    check('both surfaces fly the same integrator',
        /advanceFlight\(flightRef\.current, /.test(map) && /advanceFlight\(flightRef\.current, /.test(globe));
    check('...and neither of them integrates one of its own',
        !/flight\.at = Math\.min\(want/.test(map) && !/flight\.at = Math\.min\(want/.test(globe));
    check('both clocks read the same beat', /stepDurationMs\(/.test(view) && /stepDurationMs\(/.test(paths));
    check('...and neither keeps a beat of its own',
        !/REPLAY_STEP_MS/.test(view) && !/REPLAY_STEP_MS/.test(map));
    // …and the page waits the beat of the leg being flown, not of the one
    // after it. One character, and the arrow either lands on time or parks and
    // then cuts.
    check('the page waits the CURRENT leg\'s beat',
        /stepDurationMs\(trace, Math\.max\(1, step\)\)/.test(view)
        && !/stepDurationMs\(trace, step \+ 1\)/.test(view));
    check('a late arrow hurries instead of teleporting',
        /const behind = Math\.max\(1, want - flight\.at\)/.test(paths)
        && /behind \/ \(legMs \* FLIGHT_SHARE\)/.test(paths));
    // The frame a step ARRIVES on brings no travel with it. Without this the
    // landing's idle — up to 28% of a beat with no frames drawn at all — was
    // charged to the first frame of the next leg, which then began a third of
    // the way along it.
    // The arithmetic above proves `legParam` evens a leg out; this is the other
    // half — that the map actually flies through it. Both the arrow and the
    // path it leaves behind read it, and they have to read the same thing or
    // the arrow drifts off its own line.
    check('the arrow and its line are both advanced by DISTANCE along the leg',
        /legAt\(leg, legParam\(leg, frac\)\)/.test(map)
        && /legUpTo\(whole, legParam\(whole, frac\)\)/.test(map));
    check('a new leg starts at its own start',
        /const elapsed = want === flight\.target \? frameMs : 0/.test(paths));
    // One clock for the camera and the arrow, read in milliseconds. A share per
    // FRAME is a different speed on every machine.
    check('everything that moves reads the same frame clock',
        /const frameMs = clockRef\.current/.test(map)
        && /const dt = Math\.min\(frameMs, MAX_STEP_MS\) \/ 1000/.test(map));
    // The camera has WEIGHT: it carries a velocity and is pulled toward its
    // target by a critically damped spring, integrated EXACTLY over the elapsed
    // time. An exponential ease is first-order — its speed is proportional to
    // the distance left — so the frame the target turns, the picture turns,
    // with no radius at all. Integrated by steps of Euler instead, a spring
    // gains energy on a long frame, which is a camera that overshoots more the
    // slower the machine is.
    //
    // ONE arm, shared by both surfaces (`cameraSpring.ts`): a replay is meant
    // to mean the same thing on the sheet and on the planet, and how much
    // weight the camera has is part of what it means. The planet had an ease
    // and it showed — the first frame of its pull-out moved 1479px/s against
    // 6px/s the frame before it.
    const arm = readFileSync(new URL('../src/components/atlas/cameraSpring.ts', import.meta.url), 'utf8');
    check('the camera is on a spring rather than a lerp',
        /export function spring\(x: number, v: number, to: number, omega: number, dt: number\)/.test(arm)
        && /const decay = Math\.exp\(-omega \* dt\)/.test(arm)
        && /velRef\.current = \{ x: sx\.v, y: sy\.v, lk: sk\.v \}/.test(map));
    check('…and both surfaces hang on that one arm',
        /from '\.\/cameraSpring'/.test(map) && /from '\.\/cameraSpring'/.test(globe)
        && /spring\(cam\.yaw, vel\.yaw, target\.yaw, omega, dt\)/.test(globe)
        && !/1 - Math\.exp\(-EASE_OMEGA \* dt\)/.test(globe));
    // …and it stops dead wherever the READER moves the map: a drag that ends
    // must not fling it, and a fly-to must not start with the momentum of
    // whatever happened before it.
    check('a hand on the map takes the momentum out of it',
        (map.match(/velRef\.current = \{ x: 0, y: 0, lk: 0 \}/g) || []).length >= 4);
    // What counts as a cut is WHO moved the target, not how far it is from the
    // arrow: a distance rule cannot tell a reader pressing Restart from a
    // browser that skipped half a second of frames, and it read the second as
    // the first — which is how a stutter became the map cutting from one topic
    // to the next.
    check('a cut is a jump someone asked for, not a stutter',
        /STEP_LOOKAHEAD/.test(paths) && /flight\.target/.test(paths) && !/FLIGHT_CUT/.test(paths));
    // One subject per beat: the replay prints the name of the place it is
    // arriving at, and the map's ordinary topic names stand down while it runs.
    check('a running replay silences every other topic name',
        /journeyAt != null \? 0 : 1/.test(map));
    check('...and lights the place it is arriving at, cross-fading from the one it left',
        /journeyLit/.test(map) && /1 - frac/.test(map));
    // The map draws the route somebody walked, not the syllabus they walked it
    // through. The faint parent-child web under the path was context that read
    // as clutter — a hundred hairlines off every edge of a real course, most of
    // them between topics nobody has opened — and the path is what the replay
    // builds a leg at a time and leaves behind.
    check('the map draws the walked route and not the course tree',
        !/BRANCH_ALPHA|BRANCH_TRUNK_ALPHA|TRUNK_DEPTH/.test(map) && !/traced\.links/.test(map));
    // Carrying on carries on NOW. Arming the clock and waiting a beat for it
    // left the arrow parked on the topic it had already landed on for up to
    // 1.2s after the press, which reads as the button not having worked.
    check('carrying on takes the next step at once, not after a beat',
        /s >= trace\.journey\.length \? 1 : s \+ 1/.test(view));
}

// ---- colouring by course ----------------------------------------------------
// The map's default encoding is mastery, and this is the second one: hue says
// which course, lightness still says how proven. Both of its failure modes are
// pictures. Taking `projects.color` as authored draws a third of a real library
// in one blue and calls it six courses (measured: 17 active projects, 11
// distinct colours, six sharing one hex). Mixing two courses' hues on a LINE
// invents a third course's colour. So: hues are pushed apart, and a shared
// region is mixed on the CIRCLE, which desaturates toward grey instead.
console.log('\n--- colour by course ---');
let colors = null;
try {
    const { build } = await import('esbuild');
    const outfile = join(scratch, 'atlasColors.mjs');
    await build({
        entryPoints: [fileURLToPath(new URL('../src/components/atlas/atlasColors.ts', import.meta.url))],
        bundle: true, format: 'esm', outfile, logLevel: 'silent',
    });
    colors = await import(pathToFileURL(outfile).href);
} catch (err) {
    console.log(`SKIPPED: course colours — esbuild unavailable (${err.message.split('\n')[0]})`);
}

if (colors) {
    const { courseHues, courseFill, mixCourseHue, regionColor, courseSwatches } = colors;
    const gap = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };
    // The real library's shape: one hex shared six ways, plus neighbouring blues.
    const collided = [
        { id: 1, color: '#3B82F6' }, { id: 2, color: '#3B82F6' }, { id: 3, color: '#3B82F6' },
        { id: 4, color: '#2563EB' }, { id: 5, color: '#1E3A8A' }, { id: 6, color: '#EF4444' },
    ];
    const hues = courseHues(collided);
    check('every course gets a hue', hues.size === collided.length);
    check('courses that share a colour do NOT share a hue', (() => {
        const hs = [...hues.values()].map(h => h.h);
        for (let i = 0; i < hs.length; i++) {
            for (let j = i + 1; j < hs.length; j++) if (gap(hs[i], hs[j]) < 1e-6) return false;
        }
        return true;
    })(), JSON.stringify([...hues.values()].map(h => h.h.toFixed(3))));
    check('and every neighbouring pair is far enough apart to read as two', (() => {
        const hs = [...hues.values()].map(h => h.h).sort((a, b) => a - b);
        // The gap that fits: 1/14 when there is room, else an even share.
        const want = Math.min(1 / 14, 1 / hs.length) - 1e-9;
        for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] < want) return false;
        return true;
    })(), JSON.stringify([...hues.values()].map(h => Number(h.h.toFixed(3)))));
    check('the same library always gets the same hues', (() => {
        const again = courseHues([...collided].reverse());
        return [...hues.keys()].every(k => Math.abs(hues.get(k).h - again.get(k).h) < 1e-12);
    })(), 'input order changed the colours');
    check('a course with no colour at all still gets one',
        (() => { const h = courseHues([{ id: 9, color: null }]); return h.size === 1 && Number.isFinite(h.get(9).h); })());
    check('a grey course colour still yields something you can see',
        courseHues([{ id: 9, color: '#808080' }]).get(9).s >= 0.5);

    // Mixing, which is the half that can invent a course that does not exist.
    const two = new Map([[1, { h: 0, s: 0.8 }], [2, { h: 0.5, s: 0.8 }]]);
    check('a region held by ONE course keeps that course\'s hue', (() => {
        const m = mixCourseHue([{ id: 1, count: 12 }], two);
        return gap(m.h, 0) < 1e-9 && Math.abs(m.s - 0.8) < 1e-9;
    })());
    check('a region split evenly between opposite courses goes grey, not a third colour',
        mixCourseHue([{ id: 1, count: 10 }, { id: 2, count: 10 }], two).s <= 0.06,
        String(mixCourseHue([{ id: 1, count: 10 }, { id: 2, count: 10 }], two).s));
    check('a region that is mostly one course still reads as that course', (() => {
        const m = mixCourseHue([{ id: 1, count: 18 }, { id: 2, count: 2 }], two);
        return gap(m.h, 0) < 0.02 && m.s > 0.4;
    })());
    check('weight is topics, not courses: the bigger contributor wins', (() => {
        const near = new Map([[1, { h: 0.1, s: 0.8 }], [2, { h: 0.2, s: 0.8 }]]);
        const m = mixCourseHue([{ id: 1, count: 30 }, { id: 2, count: 5 }], near);
        return gap(m.h, 0.1) < gap(m.h, 0.2);
    })());
    check('a region with no known course is an answer, not a crash',
        mixCourseHue([{ id: 404, count: 3 }], two) === undefined);

    // Lightness still carries mastery in course mode — that is what makes it a
    // second dimension rather than a different map.
    const lightness = (css) => {
        const [r, g, b] = css.match(/\d+/g).map(Number).map(v => v / 255);
        return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
    };
    const hue = { h: 0.55, s: 0.7 };
    check('proven is the dark end on a light theme, the bright end on a dark one',
        lightness(courseFill(hue, 4, false)) < lightness(courseFill(hue, 0, false))
        && lightness(courseFill(hue, 4, true)) > lightness(courseFill(hue, 0, true)));
    check('and the ladder is monotone in both', [false, true].every(dark => {
        const ls = [0, 1, 2, 3, 4].map(i => lightness(courseFill(hue, i, dark)));
        return dark ? ls.every((l, i) => i === 0 || l > ls[i - 1])
            : ls.every((l, i) => i === 0 || l < ls[i - 1]);
    }));

    // The rung has to mean the same thing in every course's colour, which the
    // two checks above cannot see: they walk ONE hue, and the failure was
    // BETWEEN hues. HSL lightness is not brightness — at a fixed L a saturated
    // yellow-green is ten times the luminance of a saturated indigo — so a
    // ladder pinned to L painted this library's untouched bubbles anywhere
    // between luminance 0.029 and 0.326, brighter than four courses' fully
    // proven ones (measured 2026-09-15, 18 real courses). Paler = less proven
    // is a claim about the whole map, so it is asserted across the wheel.
    const lum = (css) => {
        const [r, g, b] = css.match(/\d+/g).map(Number);
        const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const wheel = [0, 0.08, 0.17, 0.25, 0.33, 0.42, 0.5, 0.58, 0.67, 0.75, 0.83, 0.92]
        .map(h => ({ h, s: 0.8 }));
    for (const dark of [false, true]) {
        const rung = (i) => wheel.map(h => lum(courseFill(h, i, dark)));
        check(`every course reads the same rung at the same brightness (${dark ? 'dark' : 'light'})`,
            [0, 1, 2, 3, 4].every(i => {
                const ys = rung(i);
                return Math.max(...ys) - Math.min(...ys) < 0.02;
            }), JSON.stringify([0, 4].map(i => rung(i).map(y => +y.toFixed(3)))));
        check(`...so no course's untouched outshines another's proven (${dark ? 'dark' : 'light'})`,
            dark
                ? Math.max(...rung(0)) < Math.min(...rung(4))
                : Math.min(...rung(0)) > Math.max(...rung(4)));
        // And the bottom rung is still a colour, not a hole in the map: a
        // bubble that is 59% of this library's drawn area has to be visible
        // against the surface it sits on (WCAG 1.5:1 for a large shape).
        // Every surface the map is actually drawn on, not just the default
        // one: warm paper is a full stop lighter than the light theme's, and
        // the black theme a stop darker than slate.
        const surfaces = dark
            ? ['rgb(15, 23, 42)', 'rgb(0, 0, 0)']
            : ['rgb(248, 250, 252)', 'rgb(244, 238, 228)'];
        check(`untouched is dark but never invisible (${dark ? 'dark' : 'light'})`,
            surfaces.every(bg => rung(0).every(y => {
                const s = lum(bg);
                const [hi, lo] = y > s ? [y, s] : [s, y];
                return (hi + 0.05) / (lo + 0.05) >= 1.5;
            })));

        // ---- the other half of the ladder: how much COLOUR a rung shows.
        // Luminance alone made the ramp true and still let the untouched end
        // shout: on the real canvas 59% of the drawn area came out in fully
        // saturated reds, greens and violets (measured 2026-09-15:
        // rgb(153,13,13), rgb(132,47,5), rgb(4,88,4), every one of them a
        // region with nothing proven, every one above saturation 0.84). The
        // part nobody has touched cannot be the most vivid thing on the map.
        const chroma = (css) => {
            const [r, g, b] = css.match(/\d+/g).map(Number).map(v => v / 255);
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
            return mx === mn ? 0 : (mx - mn) / (l > 0.5 ? 2 - mx - mn : mx + mn);
        };
        const rungChroma = (i) => wheel.map(h => chroma(courseFill(h, i, dark)));
        check(`colour strength climbs with proof, in every hue (${dark ? 'dark' : 'light'})`,
            wheel.every(h => {
                const cs = [0, 1, 2, 3, 4].map(i => chroma(courseFill(h, i, dark)));
                return cs.every((c, i) => i === 0 || c > cs[i - 1]);
            }), JSON.stringify([0, 4].map(i => rungChroma(i).map(c => +c.toFixed(2)))));
        check(`...far enough that untouched reads as grey beside it (${dark ? 'dark' : 'light'})`,
            Math.max(...rungChroma(0)) < 0.5 * Math.min(...rungChroma(4)),
            JSON.stringify([Math.max(...rungChroma(0)).toFixed(2), Math.min(...rungChroma(4)).toFixed(2)]));
        check(`no course's untouched is more vivid than any course's proven (${dark ? 'dark' : 'light'})`,
            Math.max(...rungChroma(0)) < Math.min(...rungChroma(4)));
        // The rungs are not evenly spaced, and the reason is what the buckets
        // hold: step 1 is "up to a quarter proven", which on the real library
        // is 38.9% of the drawn area and is earned in eight of its regions by
        // fewer than one topic in twenty. Evenly spaced, two-fifths of the map
        // claimed a quarter of the ramp for one answered question.
        const gapTo = (i) => { const a = rung(i - 1)[0], b = rung(i)[0]; return Math.abs(Math.log((b + 0.05) / (a + 0.05))); };
        check(`the first step off the floor is the smallest one (${dark ? 'dark' : 'light'})`,
            gapTo(1) < gapTo(4) && gapTo(1) < gapTo(3),
            JSON.stringify([1, 2, 3, 4].map(i => +gapTo(i).toFixed(3))));
        // Small, but a step in BOTH dimensions — a light theme has a third of
        // the brightness range a dark one does, so there it is mostly carried
        // by colour.
        check(`...but it is still a step, not a repeat of the floor (${dark ? 'dark' : 'light'})`,
            gapTo(1) > 0.08 && rungChroma(1)[0] > rungChroma(0)[0] * 1.5,
            JSON.stringify([+gapTo(1).toFixed(3), +rungChroma(0)[0].toFixed(2), +rungChroma(1)[0].toFixed(2)]));
    }

    // ---- the app-colour ramp keeps its own lightness steps -----------------
    // It walks one hue, where lightness is already an order a reader follows,
    // and the pale end of the light ramp is the palest thing the app draws on
    // purpose — so it is NOT held to the bottom-rung rule. On a DARK theme it
    // is: lightness is not brightness, and a dark accent put the untouched end
    // wherever its hue happened to land. The pre-floor formula is reproduced
    // below and run through the same rule, because a check the old code would
    // also have passed proves nothing about the fix.
    const lum2 = (css) => {
        const [r, g, b] = css.match(/\d+/g).map(Number);
        const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const visible = (css, bg) => {
        const [hi, lo] = lum2(css) > lum2(bg) ? [lum2(css), lum2(bg)] : [lum2(bg), lum2(css)];
        return (hi + 0.05) / (lo + 0.05) >= 1.5;
    };
    // Every accent the app ships, plus the deep violet that was the default.
    const accents = ['#7C3AED', '#0369A1', '#0E7490', '#B91C1C', '#15803D', '#A16207', '#334155'];
    check('on a dark map an untouched region is visible whatever the accent is',
        accents.every(a => ['rgb(15, 23, 42)', 'rgb(0, 0, 0)'].every(bg => visible(colors.ramp(a, true)[0], bg))),
        JSON.stringify(accents.map(a => [a, +lum2(colors.ramp(a, true)[0]).toFixed(3)])));
    // The pre-floor ramp, verbatim. It is both the mutation this floor is
    // checked against and the thing the floor must LEAVE ALONE: the two were
    // compared side by side and this one kept, so the floor is only allowed to
    // lift a step that was under the line, and only on a dark theme.
    const oldRamp = (hex, dark) => {
        const n = parseInt(hex.slice(1), 16);
        const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
        const d = mx - mn;
        const s = d === 0 ? 0 : d / (l > 0.5 ? 2 - mx - mn : mx + mn);
        let h = 0;
        if (d !== 0) {
            h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
            h /= 6; if (h < 0) h += 1;
        }
        const sat = Math.max(s, 0.5);
        const ls = dark ? [0.18, 0.32, 0.46, 0.62, 0.78]
            : [0.9, 0.78, 0.64, 0.5, Math.min(Math.max(l, 0.4), 0.45)];
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1; if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        return ls.map(li => {
            const q = li < 0.5 ? li * (1 + sat) : li + sat - li * sat, p = 2 * li - q;
            const v = [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)]
                .map(x => Math.round(x * 255));
            return `rgb(${v.join(', ')})`;
        });
    };
    check('without the floor a dark accent really does draw an invisible untouched end',
        !visible(oldRamp('#7C3AED', true)[0], 'rgb(15, 23, 42)'),
        `unfloored step 0 = ${oldRamp('#7C3AED', true)[0]}, lum ${lum2(oldRamp('#7C3AED', true)[0]).toFixed(3)}`);
    check('the floor lifts a step that was under it, and nothing else',
        accents.every(a => colors.ramp(a, true).every((css, i) => {
            const was = oldRamp(a, true)[i];
            return lum2(was) >= 0.04 - 1e-9
                ? css === was
                : Math.abs(lum2(css) - 0.04) < 0.005;
        })),
        JSON.stringify(accents.map(a => [a, colors.ramp(a, true)[0], oldRamp(a, true)[0]])));
    check('and a light ramp is left exactly as it was',
        accents.every(a => colors.ramp(a, false).join('|') === oldRamp(a, false).join('|')),
        JSON.stringify(accents.map(a => [colors.ramp(a, false)[0], oldRamp(a, false)[0]])));

    // The map and its list must paint the same region the same colour.
    const region = { mastery: { proven: 3 }, size: 6, projects: [{ id: 1, count: 6 }] };
    check('mastery mode is unchanged — the accent ramp, as before',
        regionColor(region, 'mastery', two, '#0E7490', true) === colors.ramp('#0E7490', true)[2]);
    check('course mode paints something else',
        regionColor(region, 'course', two, '#0E7490', true)
        !== regionColor(region, 'mastery', two, '#0E7490', true));
    check('an unknown mode falls back to mastery rather than to nothing',
        regionColor(region, 'nonsense', two, '#0E7490', true)
        === regionColor(region, 'mastery', two, '#0E7490', true));
    check('the legend names every course it colours', (() => {
        const sw = courseSwatches([{ id: 1, name: 'A', color: '#3B82F6' }], two, true);
        return sw.length === 1 && sw[0].name === 'A' && /^rgb\(/.test(sw[0].color);
    })());
    // The map paints each course through the whole ladder — hue says which
    // course, lightness still says how proven — so the key has to show the
    // ladder. It showed one flat chip, which is half the encoding.
    check('...and shows the same ladder the map paints it through', (() => {
        const sw = courseSwatches([{ id: 1, name: 'A', color: '#3B82F6' }], two, true)[0];
        if (!sw.steps || sw.steps.length !== 5) return false;
        // Every step is the colour the map would use at that step, in order,
        // and the last one is the colour that names the course.
        const same = sw.steps.every((c, i) => c === courseFill(two.get(1), i, true));
        return same && new Set(sw.steps).size === 5 && sw.steps[4] === sw.color;
    })(), JSON.stringify(courseSwatches([{ id: 1, name: 'A', color: '#3B82F6' }], two, true)[0]));

    // The switch has to name the thing it CHANGES. Both modes draw the same
    // five proof steps, so naming one of them "Proven" told the reader the
    // other one was not — and the other one is the one with no course in it.
    const atlasView = readFileSync(new URL('../src/components/AtlasView.tsx', import.meta.url), 'utf8');
    const modeOptions = atlasView.match(/\{ value: '(mastery|course)', label: tr\("([^"]+)"\) \}/g) || [];
    check('the colour switch offers both modes', modeOptions.length === 2, JSON.stringify(modeOptions));
    check('...and neither option is named after the proof both of them show',
        !/\{ value: '(mastery|course)', label: tr\("(Proven|Mastery|Progress)"\) \}/.test(atlasView),
        JSON.stringify(modeOptions));
}

// ---- region names -----------------------------------------------------------
// A curriculum title carries its position in ONE course, which is the thing the
// atlas has deliberately dissolved. Stripping it is not renaming: the words
// that survive are the author's own.
console.log('\n--- region names read as names ---');
const labels = [
    ['Module 9.5: Advanced Extensions', 'Advanced Extensions'],
    ['Phase 2: Theory — Traffic Rules', 'Theory — Traffic Rules'],
    ['7.3 — Nihongo no Mori', 'Nihongo no Mori'],
    ['4.2.1: W21, S21, and W22', 'W21, S21, and W22'],
    ['Domain C1: Differential Calculus', 'Differential Calculus'],
    ['D3 — Magnetic Fields', 'Magnetic Fields'],
    ['1. Introduction to Logic', 'Introduction to Logic'],
    // The trap: with "." in the separator class, "10.2 Highway Driving" matched
    // as 10 + "." and came out as "2 Highway Driving".
    ['10.2 Highway Driving', 'Highway Driving'],
    ['13.2 2toDrive Coach Period', '2toDrive Coach Period'],
    // Left alone: a number that is part of the name, and a plain title.
    ['12 Angry Men', '12 Angry Men'],
    ['Chapter 4', 'Chapter 4'],
    ['3D Modelling', '3D Modelling'],
    ['Physics', 'Physics'],
];
for (const [input, want] of labels) {
    check(`"${input}" → "${want}"`, cleanRegionLabel(input) === want, cleanRegionLabel(input));
}
check('a title that is nothing BUT numbering keeps its original text',
    cleanRegionLabel('4.2.1:') === '4.2.1:', cleanRegionLabel('4.2.1:'));
check('every region names itself after a member it can point at',
    split.regions.every(r => r.topics.some(t => t.id === r.labelTopicId)));
check('and the name is that member’s own words',
    split.regions.every(r => {
        const src = r.topics.find(t => t.id === r.labelTopicId);
        return src && cleanRegionLabel(src.title) === r.label;
    }));
arc = false;

// ---- where a name is written ------------------------------------------------
// The other half of "the map must be readable": a name written across three
// other bubbles, cut in half by the viewport, or dropped because its one
// allowed spot was taken is a rendering decision with nothing to catch it. The
// real module is bundled and driven with a stub 2D context whose text metrics
// are exact by construction, so the placement rules are checked as arithmetic.
console.log('\n--- names land somewhere readable ---');
const CHAR = 7;              // stub: every glyph is 7px wide at any size
const stubCtx = () => {
    const drawn = [];
    return {
        drawn,
        font: '',
        globalAlpha: 1, textAlign: '', lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '',
        measureText: (t) => ({ width: t.length * CHAR }),
        strokeText: () => { },
        fillText(t, x, y) { drawn.push({ t, x, y, font: this.font }); },
    };
};
let createLabeller = null;
try {
    const { build } = await import('esbuild');
    const outfile = join(scratch, 'mapLabels.mjs');
    await build({
        entryPoints: [fileURLToPath(new URL('../src/components/atlas/mapLabels.ts', import.meta.url))],
        bundle: true, format: 'esm', outfile, logLevel: 'silent',
    });
    ({ createLabeller } = await import(pathToFileURL(outfile).href));
} catch (err) {
    console.log(`SKIPPED: label placement — esbuild unavailable (${err.message.split('\n')[0]})`);
}

if (createLabeller) {
    const style = { size: 12, weight: 600, alpha: 1 };
    const surface = { width: 400, height: 300, ink: '#fff', halo: '#000' };

    // A name belongs to its circle, so it is written across the middle of it.
    let ctx = stubCtx();
    let lab = createLabeller(ctx, surface);
    check('a name is written across the middle of its bubble',
        lab.placeRegion('Physics', 200, 150, 60, style)
        && ctx.drawn[0].x === 200 && Math.abs(ctx.drawn[0].y - 150) < 10, JSON.stringify(ctx.drawn[0]));

    // Too long for the circle is not a reason to move it out to the side. It
    // wraps, it overflows, it stays centred — being written beside a bubble is
    // how names ended up on their neighbours.
    ctx = stubCtx();
    lab = createLabeller(ctx, surface);
    lab.placeRegion('Common Linux Privilege Escalation and Rollback', 200, 150, 26, style);
    check('a name too long for its bubble still stays centred on it',
        ctx.drawn.length > 1 && ctx.drawn.every(d => d.x === 200),
        JSON.stringify(ctx.drawn.map(d => d.t)));
    check('and it is allowed to overflow the circle rather than be dropped',
        Math.max(...ctx.drawn.map(d => d.t.length * CHAR)) > 2 * 26,
        JSON.stringify(ctx.drawn.map(d => d.t)));

    // Most of a real map is small bubbles. If only the ones wide enough to
    // hold their own name get one, most of the map is nameless.
    ctx = stubCtx();
    lab = createLabeller(ctx, surface);
    check('a small bubble is named too',
        lab.placeRegion('Geometry', 200, 150, 12, { ...style, size: 9 })
        && ctx.drawn.every(d => d.x === 200), JSON.stringify(ctx.drawn));

    // A name is never cut in half by the edge of the map.
    ctx = stubCtx();
    lab = createLabeller(ctx, surface);
    lab.placeRegion('Magnetic Fields and Induction', 20, 150, 18, style,
        { allowInside: false, above: false });
    check('a name against the edge is slid into view, not clipped', (() => {
        const d = ctx.drawn[0];
        if (!d) return false;
        const half = (d.t.length * CHAR) / 2;
        return d.x - half >= 0 && d.x + half <= surface.width;
    })(), JSON.stringify(ctx.drawn[0]));

    // Two names that want the same ground: the first keeps it and the second
    // is dropped rather than printed on top of it. Painting order is the
    // priority, and the caller paints the biggest region first.
    ctx = stubCtx();
    lab = createLabeller(ctx, surface);
    const kept = lab.placeRegion('Alpha', 200, 150, 20, style);
    const second = lab.placeRegion('Beta', 202, 152, 20, style);
    check('two names never overlap each other', kept && !second && ctx.drawn.length === 1,
        JSON.stringify(ctx.drawn));

    // An invisible label is not a label. Region names fade to nothing as the
    // reader zooms in, and every one of them used to push its box into the
    // collision list on the way out — so a fully faded name went on blanking
    // the topic names underneath it. On the real library at k=2.9 that was 39
    // invisible boxes holding topic names down to 91 of 960.
    ctx = stubCtx();
    lab = createLabeller(ctx, surface);
    const ghost = lab.placeRegion('Faded Region', 200, 150, 40, { ...style, alpha: 0 });
    const after = lab.placeRegion('Real Region', 200, 150, 40, style);
    check('a fully faded name is not drawn', !ghost && !ctx.drawn.some(d => d.t.includes('Faded')));
    check('and reserves no ground for the next one', after && ctx.drawn.length === 1,
        JSON.stringify(ctx.drawn.map(d => d.t)));
    ctx = stubCtx();
    lab = createLabeller(ctx, surface);
    check('the same holds for a topic name',
        !lab.wrapLabel('Faded Topic', 200, 150, { ...style, alpha: 0 }, 120)
        && lab.wrapLabel('Real Topic', 200, 150, style, 120) && ctx.drawn.length === 1,
        JSON.stringify(ctx.drawn.map(d => d.t)));

    // A collision is not a reason to say nothing. The module's own rule — a cut
    // name still says which region this is, a missing one says nothing — used
    // to stop applying the moment something was in the way: 52 of 123 regions
    // went unnamed at the default view, one of them the second-largest bubble
    // on the map. A blocked name now climbs down a ladder of smaller, narrower
    // attempts before it gives up.
    ctx = stubCtx();
    lab = createLabeller(ctx, surface);
    lab.label('BLOCKER', 200, 150, style, 90);
    const squeezed = lab.placeRegion('Organic Chemistry Basics', 200, 150, 60, style);
    check('a blocked name retries instead of vanishing', squeezed && ctx.drawn.length > 1,
        JSON.stringify(ctx.drawn.map(d => d.t)));
    check('and stays inside the bubble it names',
        ctx.drawn.slice(1).every(d => Math.abs(d.y - 150) <= 60 && d.x === 200),
        JSON.stringify(ctx.drawn.slice(1)));

    // The ladder has a floor. A name shrunk past legibility is not a rescue.
    ctx = stubCtx();
    lab = createLabeller(ctx, surface);
    lab.label('BLOCKER', 200, 150, style, 90);
    lab.placeRegion('Earth Science', 200, 150, 30, { ...style, size: 16 });
    check('it never shrinks a name below the readable floor',
        ctx.drawn.slice(1).every(d => parseFloat(d.font.match(/(\d+(?:\.\d+)?)px/)?.[1] || '0') >= 9),
        JSON.stringify(ctx.drawn.slice(1).map(d => d.font)));

    // Measured, not counted: a wide surface must not truncate a name that fits.
    ctx = stubCtx();
    lab = createLabeller(ctx, { ...surface, width: 1600 });
    lab.label('Magnetic Fields and Electromagnetic Induction', 800, 150, style, 700);
    check('a long name is kept whole when there is room for it',
        ctx.drawn[0]?.t === 'Magnetic Fields and Electromagnetic Induction', ctx.drawn[0]?.t);
    ctx = stubCtx();
    lab = createLabeller(ctx, surface);
    lab.label('Magnetic Fields and Electromagnetic Induction', 200, 150, style, 100);
    check('and cut to the width available when there is not',
        ctx.drawn[0]?.t.endsWith('…') && ctx.drawn[0].t.length * CHAR <= 100, ctx.drawn[0]?.t);
}


// ---- region naming ---------------------------------------------------------
//
// The map names a region after its medoid, which can only ever be one member's
// title — so a region that is a whole discipline gets named after one lesson in
// it ("Mandarin Chinese" over a region holding Japanese, French and Cyrillic).
// server/regionNaming.js earns a better name from a model. Everything asserted
// here is the part that runs WITHOUT one: what may be written onto the map, and
// what happens when two regions want the same name. The model call itself is
// not tested here and cannot be — it is the one step that is allowed to fail.
{
    // A name a model actually produced, in each shape a model actually
    // produces it. Anything this accepts is painted onto the map.
    check('accepts a plain noun phrase', validateName('Languages').label === 'Languages', validateName('Languages').label);
    check('accepts an ampersand pair', validateName('Social Sciences & Humanities').ok, true);
    check('strips a markdown heading', validateName('## Physics').label === 'Physics', validateName('## Physics').label);
    check('strips a quoted answer', validateName('"Web Security"').label === 'Web Security', validateName('"Web Security"').label);
    check('strips a "Name:" label', validateName('Name: Pharmacology').label === 'Pharmacology', validateName('Name: Pharmacology').label);
    check('strips a trailing full stop', validateName('Languages.').label === 'Languages', validateName('Languages.').label);

    // Every rejection below falls back to the medoid, which is the name the map
    // already had — so the asymmetry is deliberate: a rejected good name costs
    // nothing, an accepted bad name is printed until the region changes.
    check('rejects empty', validateName('').ok === false);
    check('rejects a non-string', validateName(null).ok === false);
    // A digit in a place name is a course position far more often than meaning.
    check('rejects a course position', validateName('Stage 28').reason === 'contains-digit', validateName('Stage 28').reason);
    check('rejects curriculum numbering', validateName('Module 9.5 Extensions').reason === 'contains-digit', validateName('Module 9.5 Extensions').reason);
    check('rejects a sentence', validateName('Languages. They span four scripts').ok === false);
    check('rejects narration', validateName('This region covers language').reason === 'meta', validateName('This region covers language').reason);
    check('rejects leftover JSON', validateName('{"name": "Languages"}').reason === 'markup', validateName('{"name": "Languages"}').reason);
    // Measured on the real library: one region in sixty comes back as a name
    // that would fit any region, which is worse than the narrow medoid.
    check('rejects a name that fits anywhere', validateName('General Knowledge').reason === 'generic', validateName('General Knowledge').reason);
    check('rejects it case-insensitively', validateName('miscellaneous').reason === 'generic', validateName('miscellaneous').reason);

    // A generic name is too WIDE; a placeholder is not a name at all, and it
    // clears every other rule — one word, no digits, no punctuation, no
    // narration. Measured on the real library: `minimax/minimax-m3:free`
    // answered `{"name": "undefined"}` for EIGHT regions, and because the cache
    // is keyed on the member set nothing would ever have asked again.
    check('rejects a JS placeholder', validateName('undefined').reason === 'placeholder', validateName('undefined').reason);
    check('rejects it whatever the case', validateName('Undefined').reason === 'placeholder', validateName('Undefined').reason);
    check('rejects it wrapped in the asked-for JSON',
        validateName(stripJsonName('{"name": "undefined"}')).reason === 'placeholder',
        validateName(stripJsonName('{"name": "undefined"}')).reason);
    check('rejects null', validateName('null').reason === 'placeholder', validateName('null').reason);
    check('rejects n/a', validateName('N/A').reason === 'placeholder', validateName('N/A').reason);
    check('rejects an echoed key', validateName('region').reason === 'placeholder', validateName('region').reason);
    // The rule must not reach a real subject that merely starts with one of
    // those words — the set is matched WHOLE, never as a prefix.
    check('keeps a real name containing one', validateName('Unknown Soldier Memorials').ok, true);
    check('keeps Null Hypothesis', validateName('Null Hypothesis').ok, true);

    // The answer arrives as JSON, as a fenced block, as a bare phrase, or as
    // prose with the answer on line one — a small local model does all four.
    check('reads the asked-for JSON', stripJsonName('{"name": "Languages"}') === 'Languages');
    check('reads JSON in a fence', stripJsonName('```json\n{"name":"Physics"}\n```') === 'Physics');
    check('reads a truncated object', stripJsonName('{"name": "Human Anatomy", "reas') === 'Human Anatomy');
    check('reads a bare phrase', stripJsonName('Languages') === 'Languages');
    check('takes line one of prose', stripJsonName('Languages\n\nThese all concern...') === 'Languages');

    // A DECAPITATED object. Ollama splits a reasoning model's scratchpad from
    // its answer, and on a hosted reasoning model that boundary landed INSIDE
    // the JSON: `{"name` went to the thinking side and only the value stayed in
    // content. Observed twice in six calls on the real endpoint, losing a
    // different amount each time, and it took one sweep from 59 names to 5.
    check('reads a value that lost its key', stripJsonName('": "Physics"}') === 'Physics',
        stripJsonName('": "Physics"}'));
    check('reads a value that lost only the brace',
        stripJsonName('name": "Driving Manoeuvres"}') === 'Driving Manoeuvres',
        stripJsonName('name": "Driving Manoeuvres"}'));
    check('reads a value after a leading preamble',
        stripJsonName('Here you go: {"name": "Linux Security"}') === 'Linux Security',
        stripJsonName('Here you go: {"name": "Linux Security"}'));
    // Anchored on the closing brace, so ordinary prose carrying a quoted phrase
    // is NOT mistaken for a decapitated object.
    check('a quoted phrase in prose is not mistaken for JSON',
        stripJsonName('The topics are about "languages" broadly') === 'The topics are about "languages" broadly');

    // A region's identity is its MEMBER SET and nothing else — this is what
    // lets an unchanged region keep its name while the library around it is
    // rebuilt and every region index shifts.
    check('signature ignores member order', regionSignature([3, 1, 2]) === regionSignature([1, 2, 3]));
    check('signature ignores id type', regionSignature(['1', '2']) === regionSignature([1, 2]));
    check('a changed member changes it', regionSignature([1, 2]) !== regionSignature([1, 3]));
    // The separator must keep the ids from running into the prefix, or two
    // different regions hash the same and one silently wears the other's name.
    check('no separator collision', regionSignature([1]) !== regionSignature([1, 2]));

    // The MODEL is deliberately NOT in the key. It was, and the day the chat
    // model was switched for unrelated reasons, 91 of the real library's 115
    // regions lost a good name and every bubble fell back to its medoid. A name
    // is validated prose about a list of titles, not a vector in a model's own
    // space, so one written by another model is not wrong — only written by
    // another model, which is what the `model` column records.
    check('the naming model is not part of the key',
        regionSignature([1, 2]) === regionSignature([1, 2]));
    // The old key is still computable, because a hash is one-way and every name
    // in an existing library is stored under it: without this, fixing the key
    // would throw away exactly the names the fix exists to recover.
    check('the legacy key still distinguishes models',
        legacySignature([1, 2], 'a') !== legacySignature([1, 2], 'b'));
    check('the legacy key is not the new one',
        legacySignature([1, 2], 'a') !== regionSignature([1, 2]));
    check('legacy separator collision is still avoided',
        legacySignature([1], '2,3') !== legacySignature([1, 2], '3'));

    // A name the LEARNER typed is held to a different standard. `validateName`
    // is strict because the alternative to a model's answer is the medoid we
    // already had; the alternative to a person's answer is nothing they asked
    // for. So digits are theirs to use, and only what would break the map is
    // refused.
    check('a hand-typed name may contain digits', validateUserName('Physics 2').label === 'Physics 2',
        JSON.stringify(validateUserName('Physics 2')));
    check('and may be a phrase the model rules would reject',
        validateUserName('Stuff I keep forgetting').ok, true);
    check('whitespace is collapsed', validateUserName('  Deep   Work \n').label === 'Deep Work',
        JSON.stringify(validateUserName('  Deep   Work \n')));
    check('an empty name is refused', validateUserName('   ').reason === 'empty');
    check('markup is refused', validateUserName('<b>Physics</b>').reason === 'markup');
    check('a paragraph is refused', validateUserName('x'.repeat(61)).reason === 'too-long');

    // Two places on one map may not share a name. Regions are named
    // independently (they must be — the cache key is the member set alone), so
    // collisions happen; the real library produced "Practical Driving Skills"
    // twice. Largest wins, ties by index, and the loser falls back to medoid.
    let names = new Map([[0, 'Driving'], [1, 'Driving'], [2, 'Physics']]);
    let resolved = resolveNameCollisions(names, [45, 35, 20]);
    check('the larger region keeps a contested name', resolved.get(0) === 'Driving', resolved.get(0));
    check('the smaller one falls back to its medoid', resolved.has(1) === false);
    check('an uncontested name is untouched', resolved.get(2) === 'Physics', resolved.get(2));

    // Order-independence is the whole reason this runs at read time rather than
    // during the sweep: the same library must resolve the same way every build.
    resolved = resolveNameCollisions(new Map([[1, 'Driving'], [0, 'Driving']]), [45, 35]);
    check('resolution ignores insertion order', resolved.get(0) === 'Driving', resolved.get(0));
    check('and still drops the loser', resolved.has(1) === false);

    // A tie on size is broken by index so it cannot depend on Map iteration.
    resolved = resolveNameCollisions(new Map([[2, 'Tie'], [1, 'Tie']]), [0, 9, 9]);
    check('a size tie is broken by the lower index', resolved.get(1) === 'Tie', resolved.get(1));

    // Case is not a distinction between two places.
    resolved = resolveNameCollisions(new Map([[0, 'Physics'], [1, 'physics']]), [10, 20]);
    check('a collision is case-insensitive', resolved.size === 1, String(resolved.size));
    check('and the larger still wins it', resolved.get(1) === 'physics', resolved.get(1));

    check('no names in, no names out', resolveNameCollisions(new Map(), []).size === 0);
}


// ── the floating card stays inside the map ───────────────────────────────────
// The card is the entire answer to tapping a dot, and a card outside the map's
// box is clipped away by its `overflow-hidden` — which is what happened on a
// phone, where the map is a 58vh slice and a card drawn upward from a dot in
// the top fifth has nowhere to go. Measured at 390x844 before the fix: a 127px
// card at y=82 in a box starting at y=201, so 118px of it gone and the Open
// button with it.
let placeCard = null, CARD_EDGE = 6;
try {
    const { build } = await import('esbuild');
    const outfile = join(scratch, 'cardPlacement.mjs');
    await build({
        entryPoints: [fileURLToPath(new URL('../src/components/atlas/cardPlacement.ts', import.meta.url))],
        bundle: true, format: 'esm', outfile, logLevel: 'silent',
    });
    ({ placeCard, CARD_EDGE } = await import(pathToFileURL(outfile).href));
} catch (err) {
    console.log(`SKIPPED: card placement — esbuild unavailable (${err.message.split('\n')[0]})`);
}

if (placeCard) {
    // The phone map: 366px wide inside its padding, 490px tall (58vh of 844).
    const map = { w: 366, h: 490 };
    const card = { w: 240, h: 127 };
    const fits = (p, c = card) =>
        p.top >= 0 && p.top + c.h <= map.h
        && p.left - c.w / 2 >= 0 && p.left + c.w / 2 <= map.w;

    // The case that broke: a dot 20px down the map, a card taller than that.
    const top = placeCard({ x: 180, y: 20, r: 11 }, card, map);
    check('a card with no room above flips below the dot', top.top >= 20 + 11, `top ${top.top}`);
    check('and is fully inside the map', fits(top), JSON.stringify(top));

    // The common case must not move: a dot in the middle still opens upward.
    const mid = placeCard({ x: 180, y: 300, r: 11 }, card, map);
    check('a card with room above still opens above', mid.top + card.h <= 300 - 11 + 1, `top ${mid.top}`);
    check('and is fully inside the map', fits(mid), JSON.stringify(mid));

    // A dot at the very bottom has no room below either — above must win there.
    const low = placeCard({ x: 180, y: 480, r: 11 }, card, map);
    check('a dot at the bottom edge opens upward', low.top + card.h < 480, `top ${low.top}`);
    check('and is fully inside the map', fits(low), JSON.stringify(low));

    // Every dot on the map, at both the smallest and the largest card the
    // content produces. A single sampled position proves nothing about the rule.
    let escaped = null;
    for (const c of [{ w: 120, h: 64 }, { w: 240, h: 160 }]) {
        for (let y = 0; y <= map.h && !escaped; y += 5) {
            for (let x = 0; x <= map.w && !escaped; x += 5) {
                const p = placeCard({ x, y, r: 11 }, c, map);
                if (!fits(p, c)) escaped = { x, y, c, p };
            }
        }
    }
    check('no dot anywhere on the map puts its card outside it', !escaped, JSON.stringify(escaped));

    // A card taller than the map fits on neither side, and the flip cannot save
    // it: only the clamp can. This is reachable — the map is a 58vh slice on a
    // phone and shrinks again in the ~390px workspace panel, while the card's
    // text grows with `ui_scale`. Untested, the clamp survived being deleted.
    const tall = placeCard({ x: 180, y: 40, r: 11 }, { w: 200, h: 600 }, map);
    check('a card taller than the map starts at the top edge, not above it',
        tall.top === CARD_EDGE, `top ${tall.top}`);
    const tallLow = placeCard({ x: 180, y: 460, r: 11 }, { w: 200, h: 600 }, map);
    check('and the same from a dot at the bottom', tallLow.top === CARD_EDGE, `top ${tallLow.top}`);

    // Horizontal: the old clamp assumed a 160px card. A 240px one centred over
    // a dot near the edge hung 60px off it.
    const edge = placeCard({ x: 8, y: 300, r: 11 }, card, map);
    check('a card near the left edge is pushed in, not clipped',
        edge.left - card.w / 2 >= 0, `left ${edge.left}`);
    check('and one near the right edge too',
        placeCard({ x: 360, y: 300, r: 11 }, card, map).left + card.w / 2 <= map.w);

    // A card wider than the map cannot be made to fit; centring it is the least
    // wrong answer, and inverting the clamp (lo > hi) would be the worst one.
    const huge = placeCard({ x: 40, y: 300, r: 11 }, { w: 500, h: 100 }, map);
    check('a card wider than the map is centred, not inverted', huge.left === map.w / 2, `left ${huge.left}`);

    // Before the first measurement there is nothing to place against, and the
    // one unpainted frame keeps the old behaviour rather than guessing.
    check('an unmeasured card is flagged as such',
        placeCard({ x: 180, y: 300, r: 11 }, { w: 0, h: 0 }, map).unmeasured === true);
    check('a measured one is not', mid.unmeasured === false);
    check('the edge margin is a real gap', CARD_EDGE > 0);
}


await finish(fail ? 1 : 0);
console.log(`\n${pass} passed, ${fail} failed`);
