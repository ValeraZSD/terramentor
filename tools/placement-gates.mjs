// tools/placement-gates.mjs — checks the placement boundary holds.
//
// Run:  node tools/placement-gates.mjs
//
// Why this exists: placement is the second feature in this engine that hands
// the learner an estimate they did not earn here (mastery transfer was the
// first), and like transfer its entire design is a boundary — it seeds the BKT
// prior and must never, by any path, close a completion gate. A regression is
// silent: topics quietly stop being taught, the mastery readout drifts away
// from what was actually measured, and nothing throws.
//
// The propagation is asserted too, because it is the part with an opinion. It
// claims that curriculum order carries information in one direction (a correct
// answer vouches BACKWARD, a wrong answer blocks FORWARD) and that a conflict
// resolves to no seed. Those are three sentences that are easy to write and
// easy to invert, and inverting them produces a plausible-looking map of a
// learner's knowledge that is wrong everywhere.
//
// Deterministic: throwaway DB, no model calls, no embedding server — the whole
// propagation is arithmetic over the leaf sequence, which is the point.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'placement-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const {
    leafSequence, probeCandidates, selectProbeTargets, computeSeeds, priorFromAnswer,
    createProbe, setProbeQuestions, recordProbeAnswer, finishProbe, discardProbe,
    probeAvailability, getProbe, withdrawPlacement, applyProbeSeeds,
    PLACEMENT_CEILING, PLACEMENT_MIN_PRIOR, DIRECT_PRIOR, PROPAGATION_DISCOUNT,
    MAX_PROBE_QUESTIONS, MIN_PROBE_CANDIDATES,
} = await import(B + 'placement.js');
const {
    checkMasteryEligibility, updateMasteryFromAttempt, getNodeMastery,
    applySeededPrior, MIN_GATE_QUESTIONS,
} = await import(B + 'mastery.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const THRESHOLD = 0.85, CHECK_PASS = 0.8;
const mkProject = (name) => db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid;
const mkNode = (pid, title, parent = null, position = 0, isNote = 0) =>
    db.prepare('INSERT INTO nodes (project_id, parent_id, title, position, is_note) VALUES (?,?,?,?,?)')
        .run(pid, parent, title, position, isNote).lastInsertRowid;

// A curriculum shaped like a real one: 3 phases, 4 leaves each, in order.
const proj = mkProject('Signals & Systems');
const phases = [];
const leaves = [];
for (let p = 0; p < 3; p++) {
    const ph = mkNode(proj, `Phase ${p + 1}`, null, p);
    phases.push(ph);
    for (let i = 0; i < 4; i++) leaves.push(mkNode(proj, `Topic ${p + 1}.${i + 1}`, ph, i));
}
// A note child hangs off one topic: it is material, so its parent is STILL a leaf.
mkNode(proj, 'Reading: convolution', leaves[0], 0, 1);

// ---- the sequence -----------------------------------------------------------
console.log('\n--- the curriculum as a sequence ---');
const seq = leafSequence(proj);
check('every topic is a leaf and nothing else', seq.length === 12, `got ${seq.length}`);
check('a topic whose only child is a note is still a leaf',
    seq.some(l => l.node_id === leaves[0]));
check('notes never appear in the sequence', !seq.some(l => l.title.startsWith('Reading:')));
check('the sequence is in curriculum order',
    seq.map(l => l.title).join(',') === leaves.map((_, i) => `Topic ${Math.floor(i / 4) + 1}.${(i % 4) + 1}`).join(','),
    seq.map(l => l.title).join(','));
check('seq indices are dense and ordered', seq.every((l, i) => l.seq === i));
check('each leaf carries its top-level phase',
    seq[0].phase_id === phases[0] && seq[11].phase_id === phases[2]);

// ---- selection --------------------------------------------------------------
console.log('\n--- selection ---');
const targets = selectProbeTargets(proj, { limit: 6 });
check('a probe asks the requested number of questions', targets.length === 6, `got ${targets.length}`);
check('targets are returned in curriculum order',
    targets.every((t, i) => i === 0 || t.seq > targets[i - 1].seq));
check('no topic is asked twice', new Set(targets.map(t => t.node_id)).size === targets.length);
check('every phase is sampled',
    new Set(targets.map(t => t.phase_id)).size === 3,
    JSON.stringify(targets.map(t => t.phase_title)));
check('selection is deterministic',
    JSON.stringify(selectProbeTargets(proj, { limit: 6 }).map(t => t.node_id))
    === JSON.stringify(targets.map(t => t.node_id)));
check('the probe never exceeds the candidate pool',
    selectProbeTargets(proj, { limit: 999 }).length <= 12);

// More phases than slots: the phases themselves get sampled, one each.
const wide = mkProject('Twenty Phases');
for (let p = 0; p < 20; p++) {
    const ph = mkNode(wide, `P${p}`, null, p);
    mkNode(wide, `t${p}`, ph, 0);
}
const wideTargets = selectProbeTargets(wide, { limit: 5 });
check('with more phases than questions, phases are sampled evenly',
    wideTargets.length === 5 && new Set(wideTargets.map(t => t.phase_id)).size === 5);
check('...and spread across the course, not clustered at the front',
    wideTargets[wideTargets.length - 1].seq >= 15, JSON.stringify(wideTargets.map(t => t.seq)));

// ---- what one answer is worth ----------------------------------------------
console.log('\n--- what one answer is worth ---');
check('a wrong answer is worth nothing', priorFromAnswer('multiple_choice', false) === 0);
check('a correct short answer is worth more than a correct multiple choice',
    priorFromAnswer('short_answer', true) > priorFromAnswer('multiple_choice', true));
// Refused by rule, not by arithmetic: the discount alone put this at 0.275
// against a 0.2 floor, so a coin flip bought a head start until MAX_GUESSABLE
// existed. Asserted as an exact zero so a future tuning pass cannot revive it.
check('a correct coin flip seeds nothing at all',
    priorFromAnswer('true_false', true) === 0,
    `${priorFromAnswer('true_false', true)}`);
check('an unknown format is refused outright, not merely discounted',
    priorFromAnswer('mystery', true) === 0);
check('the multiple-choice floor still survives the propagation discount',
    priorFromAnswer('multiple_choice', true) * PROPAGATION_DISCOUNT >= PLACEMENT_MIN_PRIOR,
    `${priorFromAnswer('multiple_choice', true) * PROPAGATION_DISCOUNT} vs ${PLACEMENT_MIN_PRIOR}`);
check('no answer of any format can reach the ceiling',
    ['multiple_choice', 'short_answer', 'true_false'].every(t => priorFromAnswer(t, true) <= PLACEMENT_CEILING));
check('the ceiling is strictly below the mastery threshold',
    PLACEMENT_CEILING < THRESHOLD, `${PLACEMENT_CEILING} vs ${THRESHOLD}`);
// The value itself, not just its ordering against a threshold this file chose:
// raised to 0.84 the ceiling still passes every relative assertion above while
// sitting close enough to 0.85 that two lucky answers push a topic through the
// gate. It is the same number and the same argument as TRANSFER_CEILING.
check('the ceiling is 0.6', PLACEMENT_CEILING === 0.6, String(PLACEMENT_CEILING));
// base 0.95 on a multiple-choice answer computes 0.95 × (1 − 0.25) = 0.7125
// before the clamp, so this exercises the clamp rather than agreeing with it.
check('and a prior that would compute above it is clamped to exactly 0.6',
    priorFromAnswer('multiple_choice', true, { base: 0.95 }) === 0.6,
    String(priorFromAnswer('multiple_choice', true, { base: 0.95 })));

// ---- propagation: the direction claim --------------------------------------
console.log('\n--- propagation ---');
const at = (i) => ({ node_id: seq[i].node_id, seq: i, questionType: 'multiple_choice' });
const seedsFor = (results, measured) => computeSeeds(seq, results, measured);

// Sections: phase 1 = seq 0..3, phase 2 = seq 4..7, phase 3 = seq 8..11.
// Every claim below is deliberately made INSIDE one of them; the section
// boundary gets its own block further down.

// One correct answer in the middle of section 2.
const mid = seedsFor([{ ...at(6), correct: true }]);
check('a correct answer seeds the topic it asked about', mid.has(seq[6].node_id));
check('...and vouches BACKWARD for earlier topics', mid.has(seq[5].node_id));
check('...but never forward for later ones', !mid.has(seq[7].node_id));
check('the topic asked about is seeded higher than one merely implied',
    mid.get(seq[6].node_id).prior > mid.get(seq[5].node_id).prior);
check('a direct seed is labelled as such', mid.get(seq[6].node_id).kind === 'direct');
check('an implied seed names the answer it came from',
    mid.get(seq[5].node_id).kind === 'implied' && mid.get(seq[5].node_id).via === seq[6].node_id);

// One wrong answer in the middle.
const midWrong = seedsFor([{ ...at(6), correct: false }]);
check('a wrong answer seeds nothing anywhere', midWrong.size === 0);

// Wrong early, correct late, both inside section 1 — the conflict case.
const conflict = seedsFor([{ ...at(0), correct: false }, { ...at(3), correct: true }]);
check('a wrong answer BLOCKS the topics after it', !conflict.has(seq[1].node_id));
check('...even though a later answer was correct', !conflict.has(seq[2].node_id));
check('the correct late answer still seeds its own topic', conflict.has(seq[3].node_id));

// Correct early, wrong late — the ordinary "edge of knowledge" shape, read
// inside section 1 and section 3 respectively.
const edge = seedsFor([{ ...at(2), correct: true }, { ...at(9), correct: false }]);
check('the known prefix is seeded', edge.has(seq[0].node_id) && edge.has(seq[2].node_id));
check('the unknown suffix is not', !edge.has(seq[3].node_id) && !edge.has(seq[11].node_id));

// Nothing vouches for topics after the last probe in their own section.
const tail = seedsFor([{ ...at(1), correct: true }]);
check('topics after the last probe are never seeded', !tail.has(seq[3].node_id));

// Re-derivation withdraws: adding a wrong answer must take back an implication.
const before = seedsFor([{ ...at(11), correct: true }]);
const after = seedsFor([{ ...at(11), correct: true }, { ...at(9), correct: false }]);
check('an implication stands while nothing contradicts it', before.has(seq[8].node_id));
check('a later wrong answer WITHDRAWS it', !after.has(seq[8].node_id));

// Measured topics are never seeded over.
const measured = new Set([seq[5].node_id]);
check('a topic with real evidence is never seeded by inference',
    !seedsFor([{ ...at(6), correct: true }], measured).has(seq[5].node_id));

// ---- propagation stops at the section boundary ------------------------------
// The prefix model is a claim about a difficulty gradient, and a top-level
// section is the largest unit this engine may assume one of. A project whose
// sections are unrelated subjects (an anthology) is the common case,
// not the edge: measured on the real library, 31-63% of propagated topics were
// being vouched for by an answer from a DIFFERENT section.
console.log('\n--- propagation stops at the section boundary ---');
const sectionOf = (id) => seq.find(l => l.node_id === id).phase_id;
const boundary = seedsFor([{ ...at(6), correct: true }]);
check('a correct answer never vouches for an earlier SECTION',
    !boundary.has(seq[0].node_id) && !boundary.has(seq[3].node_id),
    'seq 0 and 3 are in section 1; the answer was in section 2');
check('...and every seed it does make stays inside its own section',
    [...boundary.keys()].every(id => sectionOf(id) === seq[6].phase_id));
const crossBlock = seedsFor([{ ...at(1), correct: false }, { ...at(10), correct: true }]);
check('a wrong answer never blocks a LATER section',
    crossBlock.has(seq[8].node_id),
    'the wrong answer is in section 1 and says nothing about section 3');
check('a section holding no probe of its own is never seeded',
    seq.filter(l => l.phase_id === seq[4].phase_id).every(l => !crossBlock.has(l.node_id)),
    'section 2 was not asked about at all');
const everySection = seedsFor([
    { ...at(2), correct: true }, { ...at(6), correct: true }, { ...at(10), correct: true },
]);
check('one answer per section still reaches every section',
    new Set([...everySection.keys()].map(sectionOf)).size === 3);
check('...seeding only at or before each answer within its own section',
    !everySection.has(seq[3].node_id) && !everySection.has(seq[7].node_id) && !everySection.has(seq[11].node_id));

// ---- the gate ---------------------------------------------------------------
console.log('\n--- the gate ---');
const probed = seq[6].node_id;
applySeededPrior(probed, 'placement', priorFromAnswer('short_answer', true), [{ kind: 'direct' }]);
const seededScore = getNodeMastery(probed).mastery_score;
check('a seeded prior lands on the score', seededScore > 0, `${seededScore}`);
check('a seeded prior is capped below the threshold', seededScore < THRESHOLD);
let elig = checkMasteryEligibility(probed, THRESHOLD, CHECK_PASS);
check('a seeded topic is NOT eligible for completion', !elig.eligible);
check('...and says why', elig.borrowed_estimate === true);

// The nightmare: a high seeded prior plus a couple of lucky answers.
updateMasteryFromAttempt(probed, 1, 1, 'quiz', { questionType: 'true_false' });
updateMasteryFromAttempt(probed, 1, 1, 'quiz', { questionType: 'true_false' });
elig = checkMasteryEligibility(probed, THRESHOLD, CHECK_PASS);
check('a seeded prior plus two lucky true/falses still does not clear the gate',
    !elig.eligible, `score ${elig.mastery_score}, own ${elig.own_answers}`);
check('the BKT clause stays suspended until MIN_GATE_QUESTIONS own answers',
    elig.own_answers < MIN_GATE_QUESTIONS && elig.borrowed_estimate === true);

// ...but placement must not make the gate HARDER either.
const proveMe = seq[7].node_id;
applySeededPrior(proveMe, 'placement', 0.4, [{ kind: 'direct' }]);
updateMasteryFromAttempt(proveMe, 5, 5, 'mastery_check', { questionType: 'multiple_choice' });
check('a passing assessment still clears a seeded topic',
    checkMasteryEligibility(proveMe, THRESHOLD, CHECK_PASS).eligible);

// ---- seeds combine, they do not clobber ------------------------------------
console.log('\n--- two seeds, one score ---');
const both = seq[8].node_id;
applySeededPrior(both, 'transfer', 0.5, [{ kind: 'twin' }]);
applySeededPrior(both, 'placement', 0.3, [{ kind: 'implied' }]);
check('two seeds combine with MAX, never a sum',
    Math.abs(getNodeMastery(both).mastery_score - 0.5) < 1e-9,
    `${getNodeMastery(both).mastery_score}`);
applySeededPrior(both, 'placement', 0);
check('withdrawing one seed falls back to the other, not to zero',
    Math.abs(getNodeMastery(both).mastery_score - 0.5) < 1e-9,
    `${getNodeMastery(both).mastery_score}`);
applySeededPrior(both, 'transfer', 0);
check('withdrawing the last seed clears the score', getNodeMastery(both).mastery_score === 0);

const measuredNode = seq[9].node_id;
updateMasteryFromAttempt(measuredNode, 4, 4, 'quiz', { questionType: 'multiple_choice' });
const measuredScore = getNodeMastery(measuredNode).mastery_score;
applySeededPrior(measuredNode, 'placement', 0.6, [{ kind: 'direct' }]);
check('a measured topic is never re-seeded',
    getNodeMastery(measuredNode).mastery_score === measuredScore);

// ---- the probe lifecycle ----------------------------------------------------
console.log('\n--- the probe lifecycle ---');
const fresh = mkProject('Thermodynamics');
const freshLeaves = [];
for (let p = 0; p < 2; p++) {
    const ph = mkNode(fresh, `Part ${p + 1}`, null, p);
    for (let i = 0; i < 4; i++) freshLeaves.push(mkNode(fresh, `T${p}.${i}`, ph, i));
}
const avail = probeAvailability(fresh);
check('a fresh project offers a probe', avail.available === true, JSON.stringify(avail));
check('it says how many questions it would ask',
    avail.questions === Math.min(MAX_PROBE_QUESTIONS, 8), JSON.stringify(avail));

const tiny = mkProject('Two Topics');
const tinyPhase = mkNode(tiny, 'Only', null, 0);
mkNode(tiny, 'a', tinyPhase, 0);
mkNode(tiny, 'b', tinyPhase, 1);
const tinyAvail = probeAvailability(tiny);
check('a project too small to place says so as an ANSWER, not an error',
    tinyAvail.available === false && tinyAvail.reason === 'too-small', JSON.stringify(tinyAvail));

const probe = createProbe(fresh, { limit: 4 });
check('creating a probe stores its targets', probe.targets.length === 4);
check('a new probe starts in the generating state', probe.state === 'generating');
check('a project with a probe under way is not offered another',
    probeAvailability(fresh).available === false);

const qs = probe.targets.map((t, i) => ({
    node_id: t.node_id, seq: t.seq, type: 'multiple_choice',
    question: `Q${i}`, options: ['a', 'b'], correct_answer: 'a', explanation: 'because',
}));
setProbeQuestions(probe.id, qs);
check('questions land and the probe becomes ready', getProbe(fresh).state === 'ready');

recordProbeAnswer(probe.id, { questionIndex: 3, correct: true });
const seededCount = db.prepare(`
    SELECT COUNT(*) n FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id
    WHERE n.project_id = ? AND nm.placement_prior IS NOT NULL`).get(fresh).n;
check('one correct answer seeds its topic and everything before it',
    seededCount > 1, `${seededCount} seeded`);
check('the answer is recorded as evidence', db.prepare(
    "SELECT COUNT(*) n FROM mastery_evidence WHERE evidence_type = 'placement'").get().n === 1);
check('placement evidence does NOT run a BKT update on top of the seed',
    getNodeMastery(qs[3].node_id).total_attempts === 0);

// A wrong answer in ANOTHER section says nothing about this one, so it must
// take nothing back (`fresh` is 2 parts of 4 topics; questions 0-1 are part 1,
// 2-3 are part 2).
recordProbeAnswer(probe.id, { questionIndex: 1, correct: false });
const afterForeignWrong = db.prepare(`
    SELECT COUNT(*) n FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id
    WHERE n.project_id = ? AND nm.placement_prior IS NOT NULL`).get(fresh).n;
check('a wrong answer in another section withdraws nothing',
    afterForeignWrong === seededCount, `${seededCount} -> ${afterForeignWrong}`);

// A later wrong answer earlier in the SAME section must take back the implications.
recordProbeAnswer(probe.id, { questionIndex: 2, correct: false });
const afterWrong = db.prepare(`
    SELECT COUNT(*) n FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id
    WHERE n.project_id = ? AND nm.placement_prior IS NOT NULL`).get(fresh).n;
check('a wrong answer withdraws the head start it contradicts',
    afterWrong < seededCount, `${seededCount} -> ${afterWrong}`);

check('answering the same question again replaces rather than appends',
    (recordProbeAnswer(probe.id, { questionIndex: 1, correct: false }),
        getProbe(fresh).answers.filter(a => a.questionIndex === 1).length === 1));

const { summary } = finishProbe(probe.id);
check('finishing reports what it did', summary && summary.answered === 3, JSON.stringify(summary));
check('the summary never claims the topics are known',
    !/already know/i.test(summary.headline), summary.headline);
check('a finished probe is not offered again', probeAvailability(fresh).available === false);

// ---- the escape hatch -------------------------------------------------------
console.log('\n--- the escape hatch ---');
const discarded = discardProbe(fresh);
check('discarding clears every seed it made', discarded.cleared > 0);
check('...and every trace of the probe', getProbe(fresh) === null);
check('...and its evidence rows', db.prepare(
    "SELECT COUNT(*) n FROM mastery_evidence WHERE evidence_type = 'placement'").get().n === 0);
check('no score is left behind',
    db.prepare(`SELECT COUNT(*) n FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id
                WHERE n.project_id = ? AND nm.mastery_score > 0`).get(fresh).n === 0);
check('the project can be probed again afterwards', probeAvailability(fresh).available === true);

// A discard must never destroy real measurement.
const keeper = mkProject('Measured');
const kPhase = mkNode(keeper, 'P', null, 0);
const kLeaves = [0, 1, 2, 3, 4, 5].map(i => mkNode(keeper, `k${i}`, kPhase, i));
updateMasteryFromAttempt(kLeaves[0], 4, 4, 'quiz', { questionType: 'multiple_choice' });
const kScore = getNodeMastery(kLeaves[0]).mastery_score;
const kProbe = createProbe(keeper, { limit: 3 });
setProbeQuestions(kProbe.id, kProbe.targets.map(t => ({
    node_id: t.node_id, seq: t.seq, type: 'multiple_choice',
    question: 'q', options: ['a', 'b'], correct_answer: 'a', explanation: 'e',
})));
check('a measured topic is never chosen as a probe target',
    !kProbe.targets.some(t => t.node_id === kLeaves[0]));
recordProbeAnswer(kProbe.id, { questionIndex: kProbe.targets.length - 1, correct: true });
discardProbe(keeper);
check('discarding a probe leaves real measurement untouched',
    Math.abs(getNodeMastery(kLeaves[0]).mastery_score - kScore) < 1e-9);

// ---- degradation ------------------------------------------------------------
console.log('\n--- degradation ---');
const empty = mkProject('Nothing Yet');
check('a project with no topics offers no probe', probeAvailability(empty).available === false);
check('...and selecting targets on it returns nothing, never throws',
    selectProbeTargets(empty).length === 0);
check('seeding with no answers is a no-op', computeSeeds(seq, []).size === 0);
check('seeding with malformed answers is a no-op',
    computeSeeds(seq, [{ correct: true }, null]).size === 0);
check('withdrawing from a project that was never probed is a no-op',
    withdrawPlacement(empty) === 0);

// ---- the model stops answering ---------------------------------------------
//
// Not a content failure, and the code must not confuse the two. Driven by
// pointing the AI settings at a closed port: connection-refused is a transport
// error that resolves immediately, so this stays deterministic and fast.
console.log('');
console.log('--- the model stops answering ---');
const { generateProbeQuestions } = await import(B + 'placement.js');
const setAi = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
setAi.run('ai_provider', 'openai');
setAi.run('ai_openai_base_url', 'http://127.0.0.1:1/v1');
setAi.run('ai_openai_model', 'nothing');
setAi.run('ai_enabled', 'true');

const dead = mkProject('Unreachable Model');
const deadPhase = mkNode(dead, 'P', null, 0);
for (let i = 0; i < 8; i++) mkNode(dead, 'd' + i, deadPhase, i);
const deadProbe = createProbe(dead, { limit: 8 });
const emitted = [];
let threw = null;
try {
    await generateProbeQuestions(deadProbe, { emit: e => emitted.push(e) });
} catch (err) { threw = err; }

check('an unreachable model fails the probe rather than serving nothing quietly', !!threw);
check('...with a message that tells the learner they can just start studying',
    /without a placement/i.test(threw ? threw.message : ''), threw ? threw.message : 'no error');
check('the probe row is marked failed', getProbe(dead) && getProbe(dead).state === 'failed');
// The point of the early stop: it must NOT have walked all 8 targets, each on
// a 300s budget.
check('it stops early instead of grinding through every target',
    emitted.length <= 3, 'attempted ' + emitted.length + ' of 8');
check('nothing was seeded by a probe that never asked anything',
    db.prepare('SELECT COUNT(*) n FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id WHERE n.project_id = ? AND nm.placement_prior IS NOT NULL').get(dead).n === 0);
check('and no evidence was recorded either',
    db.prepare("SELECT COUNT(*) n FROM mastery_evidence WHERE evidence_type = 'placement'").get().n === 0);

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }
process.exit(fail ? 1 : 0);
