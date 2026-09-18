// tools/node-embedding-gates.mjs — checks the topic-embedding layer end to end.
//
// Run:  node tools/node-embedding-gates.mjs
//
// Why this exists: server/nodeEmbeddings.js is the layer mastery transfer and
// the atlas view are both built on, and almost everything that can go wrong in
// it goes wrong SILENTLY. A stale vector still returns a confident neighbour. A
// vector left behind by a deleted topic still matches. A sweep that re-embeds
// the whole curriculum on every call still produces correct answers — it just
// pins the model forever. None of that raises an error, so it needs assertions.
//
// It runs against a throwaway DB and a stub HTTP server speaking Ollama's
// /api/embed, which maps text into a tiny hand-built 4-d topic space. So no
// model is called, the run is deterministic and fast, and the real code path —
// batching, unit-normalisation, the vec0 BigInt rowid, KNN, the L2→cosine
// conversion — is exercised rather than mocked.
//
// Run it after touching server/nodeEmbeddings.js or the vec-table lifecycle in
// server/embeddings.js.

import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'node-emb-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

// ---- stub embedding provider ------------------------------------------------
// A 4-d space: [wave, calculus, cooking, other]. Two curricula describing the
// same physics land in the same corner; a cooking course does not. Ordered —
// the first pattern that matches wins.
const SPACE = [
    [/fourier|integral|sinusoid/i, [0.2, 1, 0, 0]],
    [/standing wave|staande golv|golfpatroon|antinode/i, [1, 0.2, 0, 0]],
    [/knead|dough|bread/i, [0, 0, 1, 0]],
];
let dims = 4;                       // switched later to test a model-dimension change
let embedCalls = 0, embedTexts = 0;
const vecFor = (text) => {
    const base = SPACE.find(([re]) => re.test(text))?.[1] ?? [0.25, 0.25, 0.25, 0.25];
    return dims === 4 ? base.slice() : [...base, ...Array(dims - 4).fill(0)];
};
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const { input } = JSON.parse(body || '{}');
        const texts = Array.isArray(input) ? input : [input];
        embedCalls++; embedTexts += texts.length;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ embeddings: texts.map(vecFor) }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

// ---- boot -------------------------------------------------------------------
const B = new URL('../server/', import.meta.url).href;
const { default: db, vecAvailable } = await import(B + 'database.js');
const {
    syncNodeEmbeddings, similarNodes, searchNodesSemantic,
    nodeEmbeddingStats, pendingNodes, nodeEmbedText,
} = await import(B + 'nodeEmbeddings.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

if (!vecAvailable) {
    // Not a failure: the whole feature degrades to nothing without sqlite-vec,
    // and that is a supported build. But this file can't assert anything.
    console.log('SKIPPED: sqlite-vec is not available on this build — nothing to check.');
    await new Promise(r => stub.close(r));
    try { db.close(); } catch { }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { }
    process.exit(0);
}

const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                               ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
setSetting.run('ai_ollama_url', stubUrl);
setSetting.run('embedding_model', 'stub-embed');
setSetting.run('embedding_provider', 'ollama');

// database.js seeds a tutorial project, so counts are relative to it.
const seeded = db.prepare(`SELECT COUNT(*) c FROM nodes WHERE is_note = 0`).get().c;

const mkProject = (name) => db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid;
const mkNode = (pid, title, description = '', parent = null, isNote = 0) =>
    db.prepare('INSERT INTO nodes (project_id, parent_id, title, description, is_note) VALUES (?,?,?,?,?)')
        .run(pid, parent, title, description, isNote).lastInsertRowid;

const physics = mkProject('TU/e Physics Prep');
const dutch = mkProject('Natuurkunde VWO');
const cooking = mkProject('Sourdough');

const pWaves = mkNode(physics, 'Waves');
const nStanding = mkNode(physics, 'Standing Waves', 'Nodes, antinodes and the harmonic series in a pipe.', pWaves);
const nFourier = mkNode(physics, 'Fourier Series', 'Decomposing a signal into an integral of sinusoids.', pWaves);
const nNote = mkNode(physics, 'Reading: harmonic tables', 'standing wave reference material', nStanding, 1);
const nDutch = mkNode(dutch, 'Staande golven', 'Knopen en buiken in een golfpatroon.');
const nBread = mkNode(cooking, 'Kneading', 'Develop gluten by kneading the dough.');
const nDeep = mkNode(physics, 'Worked example: a closed pipe', 'A pipe closed at one end.', nStanding);

// ---- what gets embedded -----------------------------------------------------
// This string IS the topic's position in the space: the atlas, mastery transfer
// and semantic topic search are all downstream of it. On the real library a
// fifth of all topics carry no Overview at all, so what stands in for one when
// it is missing decides where a fifth of the map goes.
console.log('\n--- the embedded text ---');
const rowFor = (id) => db.prepare(`SELECT n.id, n.title, n.description, p.title AS parent_title
                                   FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id
                                   WHERE n.id = ?`).get(id);

const text = nodeEmbedText(rowFor(nStanding));
check('the parent title disambiguates a topic', text.startsWith('Waves › Standing Waves'), text);
// The project name is the one string guaranteed to differ between two curricula
// teaching the same thing — including it would separate exactly the pairs this
// layer exists to find.
check('the project name is NOT part of the embedded text', !/TU\/e Physics Prep/.test(text));

// Curriculum numbering is boilerplate shared by every topic in one course and by
// nothing outside it, so leaving it in pulls same-course topics together and
// pushes apart the cross-course twins this layer exists to find. Measured on the
// real library: cross-project regions 47 → 49 with it stripped.
const numbered = mkNode(physics, 'Module 9.5: Resonance in Pipes', 'Standing waves in an open pipe.', pWaves);
const numberedText = nodeEmbedText(rowFor(numbered));
check('curriculum numbering is stripped from the embedded text',
    numberedText.includes('Resonance in Pipes') && !numberedText.includes('Module 9.5'), numberedText);
check(`...from the PARENT title too, not just the topic own`,
    nodeEmbedText({ title: 'Beats', description: '', parent_title: '7.3 — Wave Interference' })
        === 'Wave Interference › Beats');

// A deeper chain was measured and is WORSE (cross-project regions 47 → 39): the
// grandparent is one more layer of one course's scaffolding, which is the thing
// this text exists not to encode.
check('the chain stops at the immediate parent',
    !nodeEmbedText(rowFor(nStanding)).includes('›  ›')
    && nodeEmbedText({ title: 'C', description: '', parent_title: 'B', grandparent_title: 'A' }) === 'B › C');

// ---- reconcile --------------------------------------------------------------
console.log('\n--- reconcile ---');
const topicCount = () => db.prepare('SELECT COUNT(*) c FROM nodes WHERE is_note = 0').get().c;
check('notes are excluded from the topic space', pendingNodes().length === topicCount(),
    `${pendingNodes().length} pending for ${topicCount()} topics`);
await syncNodeEmbeddings();
check('nothing is pending after a sweep', pendingNodes().length === 0);
check('the sweep batches (one request, not one per topic)', embedCalls === 1, `${embedCalls} calls`);
check('one vector per topic', db.prepare('SELECT COUNT(*) c FROM vec_nodes').get().c === topicCount());

const before = embedTexts;
await syncNodeEmbeddings();
// This is the assertion that keeps "sync often" honest: callers fire it from
// every node write, so a sweep with no drift must cost nothing.
check('a clean sweep costs ZERO model calls', embedTexts === before);

console.log('\n--- drift ---');
db.prepare('UPDATE nodes SET description = ? WHERE id = ?').run('A rewritten overview.', nFourier);
check('an edited Overview registers as drift', pendingNodes().length === 1);
// Renaming a parent drifts every topic that names it. Asserted as the actual
// set rather than a count, because a count that happens to match is not
// evidence that the right rows moved.
db.prepare('UPDATE nodes SET title = ? WHERE id = ?').run('Wave Phenomena', pWaves);
const drifted = new Set(pendingNodes().map(r => r.id));
check('renaming a parent drifts its children too', drifted.has(nStanding) && drifted.has(nFourier),
    `${[...drifted].join(',')}`);
// ...but NOT its grandchildren: the chain stops at the immediate parent, which
// is the depth that measured best.
check('and stops there — a grandchild does not name it', !drifted.has(nDeep),
    `${[...drifted].join(',')}`);
await syncNodeEmbeddings();
check('drift clears after a sweep', pendingNodes().length === 0);

// ---- neighbours -------------------------------------------------------------
console.log('\n--- neighbours ---');
const near = await similarNodes(nStanding, { limit: 5 });
check('a topic is never its own neighbour', !near.some(r => r.id === nStanding));
check('notes never surface as neighbours', !near.some(r => r.id === nNote));
check('the cross-language twin is the closest topic', near[0]?.id === nDutch, `got ${near[0]?.title}`);
check('an identical-meaning pair scores ~1.0', near[0]?.similarity > 0.99, `got ${near[0]?.similarity}`);
check('an unrelated subject falls below the similarity floor', !near.some(r => r.id === nBread));
check('neighbours carry their project (the atlas needs it)', near.every(r => r.project_name));
check('crossProjectOnly drops same-project hits',
    (await similarNodes(nStanding, { crossProjectOnly: true })).every(r => r.project_id !== physics));

// The query mastery transfer will actually issue.
db.prepare('INSERT INTO node_mastery (node_id, mastery_score) VALUES (?, 0.92)').run(nDutch);
const proven = await similarNodes(nStanding, { crossProjectOnly: true, masteredOnly: true, threshold: 0.85 });
check('masteredOnly keeps only proven twins', proven.length === 1 && proven[0].id === nDutch, `got ${proven.length}`);
check('a neighbour carries its mastery score', proven[0]?.mastery_score === 0.92);
db.prepare('UPDATE node_mastery SET mastery_score = 0.4 WHERE node_id = ?').run(nDutch);
check('an unproven twin is filtered out',
    (await similarNodes(nStanding, { masteredOnly: true, threshold: 0.85 })).length === 0);

console.log('\n--- free-text topic search ---');
const hits = await searchNodesSemantic('standing wave antinodes', { limit: 5 });
check('free text finds the right topics', [nStanding, nDutch].includes(hits[0]?.id),
    JSON.stringify(hits.map(h => h.title)));
check('projectId scopes the search',
    (await searchNodesSemantic('kneading dough', { projectId: cooking }))[0]?.id === nBread);

// ---- lifecycle --------------------------------------------------------------
console.log('\n--- lifecycle ---');
db.prepare('UPDATE nodes SET is_note = 1 WHERE id = ?').run(nBread);
await syncNodeEmbeddings();
check('a topic converted into a note loses its vector',
    !db.prepare('SELECT 1 FROM vec_nodes WHERE rowid = ?').get(nBread));

// The case a sidecar-driven sweep is structurally blind to: node_embeddings has
// a real FK, so deleting the node deletes the very row that would have told the
// sweep to drop the vector. vec_nodes must be swept against `nodes` directly.
db.prepare('DELETE FROM nodes WHERE id = ?').run(nDutch);
await syncNodeEmbeddings();
check('a DELETED topic loses its vector (FK cascade hides the bookkeeping row)',
    !db.prepare('SELECT 1 FROM vec_nodes WHERE rowid = ?').get(nDutch));
const stats = nodeEmbeddingStats();
check('stats agree with the store', stats.pending === 0 && stats.vectors === stats.indexed, JSON.stringify(stats));

// ---- model changes ----------------------------------------------------------
console.log('\n--- model changes ---');
setSetting.run('embedding_model', 'other-embed');
// Two models can share a dimension while their spaces have nothing to do with
// each other, so the model is part of a vector's identity, not just the dim.
check('switching model at the SAME dimension drifts every topic',
    pendingNodes().length === stats.indexed, `got ${pendingNodes().length}`);
await syncNodeEmbeddings();
check('re-embedded under the new model', pendingNodes().length === 0);

// A dimension change means every stored vector is meaningless — including the
// vault's. A rebuild that only remembered vec_chunks would leave the other
// table holding vectors from the previous model's space.
const docId = db.prepare(`INSERT INTO documents (project_id, title, content, status)
                          VALUES (?, 'doc', 'text', 'ready')`).run(physics).lastInsertRowid;
db.prepare(`INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, 0, 'chunk')`).run(docId);
const { indexDocument } = await import(B + 'embeddings.js');
indexDocument(docId);
await syncNodeEmbeddings();   // same chain — this awaits the document job too
check('the vault indexed alongside the topics', db.prepare('SELECT COUNT(*) c FROM vec_chunks').get().c === 1);

const liveTopics = db.prepare('SELECT COUNT(*) c FROM nodes WHERE is_note = 0').get().c;
dims = 8;
setSetting.run('embedding_model', 'bigger-embed');
await syncNodeEmbeddings();
check('a dimension change rebuilds vec_nodes at the new size',
    db.prepare('SELECT COUNT(*) c FROM vec_nodes').get().c === liveTopics,
    `got ${db.prepare('SELECT COUNT(*) c FROM vec_nodes').get().c} of ${liveTopics}`);
// vec_chunks is dropped, not emptied — it is recreated lazily at the new
// dimension by the next document index.
check('...and drops the vault vectors too, rather than leaving a stale space',
    !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_chunks'`).get());
check('...and resets the document that claimed to be indexed',
    db.prepare('SELECT embedding_status s FROM documents WHERE id = ?').get(docId).s === null);
check('a neighbour lookup still works in the new space',
    (await similarNodes(nStanding, { limit: 3 })).length > 0);

// ---- degraded ---------------------------------------------------------------
console.log('\n--- degraded (no embedding model) ---');
await new Promise(r => stub.close(r));
db.prepare('UPDATE nodes SET description = ? WHERE id = ?').run('changed while the model is down', nStanding);
const res = await syncNodeEmbeddings();
check('an unreachable model embeds nothing', res.embedded === 0);
check('and records the topic as unavailable',
    db.prepare('SELECT status s FROM node_embeddings WHERE node_id = ?').get(nStanding)?.s === 'unavailable');
// A failed topic must never be recorded with a real hash, or it would look
// current forever and never be retried.
check('a failed topic stays pending — retried, not silently marked done',
    pendingNodes().some(n => n.id === nStanding));
check('similarNodes still answers from the vectors it already has',
    Array.isArray(await similarNodes(nFourier)));

// Close before deleting: Windows refuses to unlink a file SQLite still has open.
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }

// ---- mean-centred similarity (pure) -----------------------------------------
console.log('\n--- centred cosine ---');
{
    const { centredCosine, MIN_CENTRE_TOPICS } = await import(new URL('../server/nodeEmbeddings.js', import.meta.url).href);
    const mean = [0.5, 0.5, 0];
    // Two vectors that share the mean direction and differ only off it.
    const a = [0.6, 0.4, 0.1], b = [0.4, 0.6, 0.1];
    const raw = (x, y) => { let d = 0, nx = 0, ny = 0; for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; } return d / Math.sqrt(nx * ny); };
    check('raw cosine is dominated by the shared direction', raw(a, b) > 0.9, raw(a, b).toFixed(3));
    check('centred cosine sees only the difference (these two point opposite ways off the mean)', centredCosine(a, b, mean) < 0, centredCosine(a, b, mean).toFixed(3));
    check('a vector with itself is 1 after centring', Math.abs(centredCosine(a, a, mean) - 1) < 1e-12);
    check('a vector AT the mean has no direction and scores 0, not NaN', centredCosine([0.5, 0.5, 0], a, mean) === 0);
    check('centring only switches on for a library large enough to have a baseline', Number.isInteger(MIN_CENTRE_TOPICS) && MIN_CENTRE_TOPICS >= 100);
}

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode rather than process.exit(): a hard exit races libuv's teardown of
// the stub server on Windows and can abort *after* the results have printed.
process.exitCode = fail ? 1 : 0;
