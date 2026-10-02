// tools/mastery-transfer-gates.mjs — checks the soft-transfer boundary holds.
//
// Run:  node tools/mastery-transfer-gates.mjs
//
// Why this exists: mastery transfer is the one feature in this engine that
// hands the learner credit they did not earn *here*, and the entire design is a
// boundary — it seeds the BKT prior and must never, by any path, close a
// completion gate. A regression on that side is silent and corrosive: topics
// start marking themselves done, the mastery readout stops meaning anything,
// and nothing throws. So the guarantees are asserted rather than trusted:
//
//   1. a seeded prior is capped strictly below the mastery threshold;
//   2. a transferred node's BKT clause is suspended until it has enough
//      answers of its OWN (a high prior plus two lucky true/falses must not
//      clear it);
//   3. a passing assessment on the node still clears it — transfer must not
//      make the gate HARDER either;
//   4. transfer is cross-project only, and withdraws itself when the source
//      decays or the learner starts answering here.
//
// Same setup as tools/node-embedding-gates.mjs: throwaway DB, stub /api/embed
// server, no model calls, deterministic.

import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'transfer-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const SPACE = [
    [/standing wave|staande golv|golfpatroon|antinode/i, [1, 0, 0, 0]],
    [/fourier|sinusoid/i, [0, 1, 0, 0]],
    [/knead|dough/i, [0, 0, 1, 0]],
];
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const { input } = JSON.parse(body || '{}');
        const texts = Array.isArray(input) ? input : [input];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
            embeddings: texts.map(t => SPACE.find(([re]) => re.test(t))?.[1] ?? [0.25, 0.25, 0.25, 0.25]),
        }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));

const B = new URL('../server/', import.meta.url).href;
const { default: db, vecAvailable } = await import(B + 'database.js');
const { syncNodeEmbeddings } = await import(B + 'nodeEmbeddings.js');
const {
    computeTransfer, applyTransfer, sweepTransfers, getTransferInfo,
    TRANSFER_CEILING, TRANSFER_MIN_SIMILARITY,
} = await import(B + 'masteryTransfer.js');
const { checkMasteryEligibility, updateMasteryFromAttempt, getNodeMastery } = await import(B + 'mastery.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

if (!vecAvailable) {
    console.log('SKIPPED: sqlite-vec is not available on this build — transfer degrades to nothing, nothing to check.');
    await new Promise(r => stub.close(r));
    try { db.close(); } catch { }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { }
    process.exit(0);
}

const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                               ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
setSetting.run('ai_ollama_url', `http://127.0.0.1:${stub.address().port}`);
setSetting.run('embedding_model', 'stub-embed');
setSetting.run('embedding_provider', 'ollama');

const THRESHOLD = 0.85, CHECK_PASS = 0.8;
const mkProject = (name) => db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid;
const mkNode = (pid, title, description = '', parent = null) =>
    db.prepare('INSERT INTO nodes (project_id, parent_id, title, description) VALUES (?,?,?,?)')
        .run(pid, parent, title, description).lastInsertRowid;
// Straight into node_mastery: this stands in for "proved months ago", which is
// the state transfer reads. `last_updated` is set explicitly so decay is
// testable rather than dependent on when the suite runs.
const proveNode = (id, score, ago = 0) => {
    db.prepare(`INSERT INTO node_mastery (node_id, mastery_score, total_attempts, correct_attempts, last_updated)
                VALUES (?, ?, 10, 9, datetime('now', ?))
                ON CONFLICT(node_id) DO UPDATE SET mastery_score = excluded.mastery_score,
                    total_attempts = 10, last_updated = excluded.last_updated`)
        .run(id, score, `-${ago} days`);
    db.prepare(`UPDATE nodes SET status = 'completed' WHERE id = ?`).run(id);
};

const english = mkProject('TU/e Physics Prep');
const dutch = mkProject('Natuurkunde VWO');
const cooking = mkProject('Sourdough');

const nNew = mkNode(english, 'Standing Waves', 'Nodes, antinodes and the harmonic series in a pipe.');
const nFourier = mkNode(english, 'Fourier Series', 'Decomposing a signal into sinusoids.');
const nTwin = mkNode(dutch, 'Staande golven', 'Knopen en buiken in een golfpatroon.');
const nSibling = mkNode(english, 'Standing Waves Revisited', 'More on antinodes in a pipe.');
const nBread = mkNode(cooking, 'Kneading', 'Develop gluten by kneading the dough.');

await syncNodeEmbeddings();
proveNode(nTwin, 0.95);

// ---- the head start ---------------------------------------------------------
console.log('\n--- the head start ---');
const t = await computeTransfer(nNew, { threshold: THRESHOLD, decayDays: 14 });
check('a proven twin in another project produces a head start', t.prior > 0, JSON.stringify(t));
check('it names the source topic', t.sources[0]?.node_id === nTwin, JSON.stringify(t.sources));
check('the source carries its project for display', !!t.sources[0]?.project_name);
// Guarantee 1: capped below any threshold a user could configure downward.
check('the prior is capped strictly below the mastery threshold',
    t.prior <= TRANSFER_CEILING && TRANSFER_CEILING < THRESHOLD, `prior ${t.prior}, ceiling ${TRANSFER_CEILING}`);
// The value itself. Every assertion around it compares the prior with the
// ceiling, so a ceiling raised to 0.84 kept the suite green while a 0.95-similar
// twin seeded 0.84 — close enough to 0.85 that two lucky true/falses open the
// gate. The twin above is a near-exact match, so its raw prior is well over 0.6
// and the number below is the clamp doing the work, not the similarity.
check('the ceiling is 0.6', TRANSFER_CEILING === 0.6, String(TRANSFER_CEILING));
check('a near-identical twin is clamped to it, not carried through',
    t.prior === TRANSFER_CEILING, `prior ${t.prior}`);
check('an unrelated subject transfers nothing',
    (await computeTransfer(nBread, { threshold: THRESHOLD })).prior === 0);
check('a topic with no proven twin transfers nothing',
    (await computeTransfer(nFourier, { threshold: THRESHOLD })).prior === 0);

// Two curricula describing the same material are the same knowledge twice, not
// twice the evidence — so a second twin must not stack.
const nTwin2 = mkNode(cooking, 'Staande golven (herhaling)', 'Knopen en buiken in een golfpatroon.');
await syncNodeEmbeddings();
proveNode(nTwin2, 0.95);
const stacked = await computeTransfer(nNew, { threshold: THRESHOLD });
check('a second twin does NOT stack the prior', Math.abs(stacked.prior - t.prior) < 1e-9,
    `${t.prior} -> ${stacked.prior}`);
check('but it is listed as a source', stacked.sources.length === 2);
db.prepare('DELETE FROM nodes WHERE id = ?').run(nTwin2);
await syncNodeEmbeddings();

console.log('\n--- scope ---');
// Same-project similarity is the author's deliberate structure (a prerequisite,
// a parent, a revision topic), not the learner's repeated work.
proveNode(nSibling, 0.95);
const sameProject = await computeTransfer(nNew, { threshold: THRESHOLD });
check('a proven twin in the SAME project transfers nothing',
    !sameProject.sources.some(s => s.project_id === english), JSON.stringify(sameProject.sources));
check('the similarity bar is well above the atlas floor', TRANSFER_MIN_SIMILARITY >= 0.8);

// ---- applying ---------------------------------------------------------------
console.log('\n--- applying ---');
const applied = await applyTransfer(nNew, { threshold: THRESHOLD, decayDays: 14 });
check('the prior is applied', applied.applied);
check('and lands in the mastery score', Math.abs(getNodeMastery(nNew).mastery_score - applied.prior) < 1e-9);
check('recorded as transferred, not earned', getNodeMastery(nNew).transferred_prior === applied.prior);
const info = getTransferInfo(nNew);
check('readable for display', info?.sources?.[0]?.title === 'Staande golven', JSON.stringify(info));
check('and marked unspent while untouched', info?.spent === false);

// ---- GUARANTEE: the gate ----------------------------------------------------
console.log('\n--- the gate (the whole point) ---');
let el = checkMasteryEligibility(nNew, THRESHOLD, CHECK_PASS);
check('a head start alone leaves the node ineligible', !el.eligible, JSON.stringify(el));

// Guarantee 2: the prior must not be topped up over the bar by a couple of
// cheap answers. Force the posterior above the threshold directly — this is the
// state a lucky run of true/falses would produce.
db.prepare('UPDATE node_mastery SET mastery_score = 0.97 WHERE node_id = ?').run(nNew);
updateMasteryFromAttempt(nNew, 1, 1, 'quiz', { questionType: 'true_false', source: 'feed' });
db.prepare('UPDATE node_mastery SET mastery_score = 0.97 WHERE node_id = ?').run(nNew);
el = checkMasteryEligibility(nNew, THRESHOLD, CHECK_PASS);
check('a borrowed 97% with one answer of its own does NOT clear the gate', !el.eligible, JSON.stringify(el));
check('and the reason is reported, not silent', el.borrowed_estimate === true);
check('own answers are counted', el.own_answers === 1, `got ${el.own_answers}`);

// Guarantee 3: transfer must not make the gate harder either. A genuine
// assessment here is proof and has never needed a prior's help.
updateMasteryFromAttempt(nNew, 5, 6, 'mastery_check', { source: 'test' });
el = checkMasteryEligibility(nNew, THRESHOLD, CHECK_PASS);
check('a PASSING assessment still clears a transferred node', el.eligible, JSON.stringify(el));
check('...via the raw-assessment clause', el.passed_assessment === true);

// Once there are enough own answers, the BKT clause comes back.
const nBkt = mkNode(english, 'Standing Waves II', 'Nodes, antinodes and the harmonic series in a pipe.');
await syncNodeEmbeddings();
await applyTransfer(nBkt, { threshold: THRESHOLD, decayDays: 14 });
updateMasteryFromAttempt(nBkt, 2, 4, 'quiz', { questionType: 'multiple_choice' });
db.prepare('UPDATE node_mastery SET mastery_score = 0.9 WHERE node_id = ?').run(nBkt);
el = checkMasteryEligibility(nBkt, THRESHOLD, CHECK_PASS);
check('the BKT clause returns once the node has enough answers of its own',
    el.eligible && !el.borrowed_estimate, JSON.stringify(el));

// A node that never received a transfer must behave exactly as before.
const nPlain = mkNode(cooking, 'Shaping', 'Shape the loaf before the final proof.');
updateMasteryFromAttempt(nPlain, 1, 1, 'quiz', { questionType: 'short_answer' });
db.prepare('UPDATE node_mastery SET mastery_score = 0.9 WHERE node_id = ?').run(nPlain);
el = checkMasteryEligibility(nPlain, THRESHOLD, CHECK_PASS);
check('an untransferred node is unaffected (one answer + high BKT still clears)',
    el.eligible && el.borrowed_estimate === false, JSON.stringify(el));

// ---- withdrawal -------------------------------------------------------------
console.log('\n--- withdrawal ---');
const nFade = mkNode(english, 'Standing Waves III', 'Antinodes in a pipe, again.');
await syncNodeEmbeddings();
await applyTransfer(nFade, { threshold: THRESHOLD, decayDays: 14 });
check('seeded from the fresh twin', getNodeMastery(nFade).transferred_prior > 0);
// The twin was proven long ago and never revisited: decayedMastery drops it
// below the bar, so the head start it was lending is no longer real.
db.prepare(`UPDATE node_mastery SET last_updated = datetime('now', '-400 days') WHERE node_id = ?`).run(nTwin);
await applyTransfer(nFade, { threshold: THRESHOLD, decayDays: 14 });
check('a decayed twin WITHDRAWS the head start', getNodeMastery(nFade).transferred_prior === null,
    JSON.stringify(getNodeMastery(nFade)));
check('and the score returns to cold', getNodeMastery(nFade).mastery_score === 0);
db.prepare(`UPDATE node_mastery SET last_updated = CURRENT_TIMESTAMP WHERE node_id = ?`).run(nTwin);

// Real measurement always wins over a borrowed estimate.
const nMeasured = mkNode(english, 'Standing Waves IV', 'Antinodes in a pipe, once more.');
await syncNodeEmbeddings();
updateMasteryFromAttempt(nMeasured, 0, 4, 'quiz', { questionType: 'multiple_choice' });
const scored = getNodeMastery(nMeasured).mastery_score;
const skipped = await applyTransfer(nMeasured, { threshold: THRESHOLD, decayDays: 14 });
check('a node with its own evidence is never re-seeded', !skipped.applied);
check('and its measured score is untouched', getNodeMastery(nMeasured).mastery_score === scored);

// ---- the sweep --------------------------------------------------------------
console.log('\n--- the sweep ---');
// nNew has both a head start and answers of its own — the sweep must leave it
// entirely alone. The provenance stays on purpose (it still explains where the
// estimate came from, and the card reports it as spent); what must not happen
// is the sweep touching a measured score.
const measuredBefore = db.prepare('SELECT mastery_score, transfer_at FROM node_mastery WHERE node_id = ?').get(nNew);
const res = await sweepTransfers({ threshold: THRESHOLD, decayDays: 14 });
check('the sweep reports what it did', typeof res.scanned === 'number' && res.scanned > 0, JSON.stringify(res));
check('it skips completed topics',
    !db.prepare(`SELECT 1 FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id
                 WHERE n.status = 'completed' AND nm.transfer_at IS NOT NULL`).get());
const measuredAfter = db.prepare('SELECT mastery_score, transfer_at FROM node_mastery WHERE node_id = ?').get(nNew);
check('it does not re-seed a topic that now has its own evidence',
    measuredAfter.mastery_score === measuredBefore.mastery_score
    && measuredAfter.transfer_at === measuredBefore.transfer_at, JSON.stringify({ measuredBefore, measuredAfter }));
check('the head start is reported as SPENT once answered here', getTransferInfo(nNew)?.spent === true);

// A source that vanishes must not leave a card pointing at a dead topic.
const nOrphan = mkNode(english, 'Standing Waves V', 'Antinodes in a pipe, finally.');
await syncNodeEmbeddings();
await applyTransfer(nOrphan, { threshold: THRESHOLD, decayDays: 14 });
check('seeded before the source is deleted', !!getTransferInfo(nOrphan));
db.prepare('DELETE FROM nodes WHERE id = ?').run(nTwin);
check('a deleted source is dropped from the displayed head start', getTransferInfo(nOrphan) === null);

// ---- unavailable != withdrawn -----------------------------------------------
console.log('\n--- the topic space goes away ---');
// Caught by probing the running server rather than by any assertion: with no
// embedding model reachable, every candidate came back "no twins" and the
// sweep read that as a verdict, silently withdrawing every head start in the
// library and resetting the seeded scores to zero. "Cannot see" is not "not
// there" — the same trap as caching a failed capability probe as a 'no'.
const nKeep = mkNode(english, 'Standing Waves VI', 'Antinodes in a pipe, one more time.');
await syncNodeEmbeddings();
const nTwinB = mkNode(dutch, 'Staande golven II', 'Knopen en buiken in een golfpatroon.');
await syncNodeEmbeddings();
proveNode(nTwinB, 0.95);
await applyTransfer(nKeep, { threshold: THRESHOLD, decayDays: 14 });
const seededPrior = getNodeMastery(nKeep).transferred_prior;
check('seeded while the topic space is up', seededPrior > 0);

// Drop the vectors — exactly what an embedding model going away looks like to
// every reader of the topic space.
db.exec('DROP TABLE IF EXISTS vec_nodes');
const blind = await computeTransfer(nKeep, { threshold: THRESHOLD, decayDays: 14 });
check('a blind lookup reports itself as unavailable', blind.available === false, JSON.stringify(blind));
await applyTransfer(nKeep, { threshold: THRESHOLD, decayDays: 14 });
check('an unavailable topic space does NOT withdraw the head start',
    getNodeMastery(nKeep).transferred_prior === seededPrior,
    `${seededPrior} -> ${getNodeMastery(nKeep).transferred_prior}`);
check('...nor reset the seeded score', getNodeMastery(nKeep).mastery_score === seededPrior);
check('the sweep declines to run at all', (await sweepTransfers({ threshold: THRESHOLD })).skipped === 'unavailable');
check('the head start is still displayable', !!getTransferInfo(nKeep));

await new Promise(r => stub.close(r));
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode rather than process.exit(): a hard exit here races libuv's own
// teardown of the stub server on Windows and aborts with an assertion *after*
// the results have printed, turning a passing run into a failing one.
process.exitCode = fail ? 1 : 0;
