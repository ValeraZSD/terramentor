// tools/head-start-gates.mjs — a head start changes what the feed TEACHES.
//
// Run:  node tools/head-start-gates.mjs
//
// Two features hand a topic an estimate it did not earn here — placement and
// transfer — and both promised on screen that it would save the learner some
// teaching. Until 2026-09-28 nothing read it: the feed planned, wrote,
// scheduled and served a seeded topic exactly like a cold one, and the only
// visible effects were the atlas colour and a recall question about a topic
// never taught. server/headStart.js is the rule; this file asserts every place
// that reads it, and every place that must NOT change:
//
//   * the rule itself — the larger seed speaks, and the learner's own answers
//     can contradict it (a failed "Prove it now" gets the full teaching);
//   * the review ceiling is tied to placement's own arithmetic, so retuning a
//     prior cannot silently move a topic between tiers;
//   * the scheduler gives a seeded topic (1 − prior) of a cold topic's time, the
//     learner's own weight still wins, and withdrawing the seed restores it;
//   * finishing a placement re-lays the dates inside the SAME window, only while
//     nothing is closed, and Discard puts back the exact dates it moved;
//   * the feed generator plans a review, writes its mastery check straight after
//     part 1, re-plans an UNSTARTED topic whose head start came, went or was
//     contradicted, and never touches a sequence the learner has begun — and an
//     unseeded plan written before any of this never churns;
//   * the feed response carries the placement head start and says "review" only
//     of a plan written as one; the checkpoint names the right source;
//   * a seed alone never produces a recall question.
//
// Deterministic: scratch DB, no model calls.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'head-start-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const {
    headStartOf, headStartFor, reviewParts, scheduleShare, getPlacementInfo,
    STRONG_HEAD_START, REVIEW_PARTS, REVIEW_PARTS_STRONG,
} = await import(B + 'headStart.js');
const { applySeededPrior, updateMasteryFromAttempt, getDecayingNodes } = await import(B + 'mastery.js');
const {
    priorFromAnswer, PROPAGATION_DISCOUNT, createProbe, setProbeQuestions, recordProbeAnswer,
    finishProbe, discardProbe, relaySchedule, summariseProbe,
} = await import(B + 'placement.js');
const { TRANSFER_CEILING } = await import(B + 'masteryTransfer.js');
const { allocateSchedule, persistSchedule } = await import(B + 'scheduling.js');
const { nextMissing, planIsStale, writePlan, pendingMaterial } = await import(B + 'feedGen.js');
const { composeFeed } = await import(B + 'feed.js');
const { AI_PROMPTS } = await import(B + 'ai.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const setSetting = (k, v) => db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).run(k, v);
const mkProject = (name) => Number(db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid);
const mkNode = (pid, title, parent = null, position = 0, description = null) => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, description) VALUES (?,?,?,?,?)',
).run(pid, parent, title, position, description).lastInsertRowid);
const seed = (nodeId, prior, sources = [{ kind: 'direct', via_node_id: nodeId }]) =>
    applySeededPrior(nodeId, 'placement', prior, sources);
const wrongAnswer = (nodeId) => updateMasteryFromAttempt(nodeId, 0, 1, 'quiz', { questionType: 'multiple_choice', source: 'feed' });
const rightAnswer = (nodeId) => updateMasteryFromAttempt(nodeId, 1, 1, 'quiz', { questionType: 'multiple_choice', source: 'feed' });
const GATE = { mode: 'advisory', threshold: 0.85, checkPass: 0.8, decayDays: 14 };
const START = '2026-10-05', DEADLINE = '2026-12-18', WEEKDAYS = [1, 2, 3, 4, 5];

// ---- 1. the rule -------------------------------------------------------------
console.log('\n--- the rule ---');
check('no row, no head start', headStartOf(null) === null);
check('a row with no seed, no head start', headStartOf({ transferred_prior: null, placement_prior: null, mastery_score: 0.9, total_attempts: 5 }) === null);
const p = headStartOf({ placement_prior: 0.41, mastery_score: 0.41, total_attempts: 0 });
check('a placement seed is a head start from placement', p?.prior === 0.41 && p?.source === 'placement', JSON.stringify(p));
const both = headStartOf({ transferred_prior: 0.6, placement_prior: 0.41, mastery_score: 0.6, total_attempts: 0 });
check('the larger seed speaks (they combine by MAX)', both?.prior === 0.6 && both?.source === 'transfer', JSON.stringify(both));
const tie = headStartOf({ transferred_prior: 0.5, placement_prior: 0.5, mastery_score: 0.5, total_attempts: 0 });
check('a tie goes to transfer, which can name what was proven', tie?.source === 'transfer');
check('answers here that AGREE leave it standing',
    headStartOf({ placement_prior: 0.41, mastery_score: 0.7, total_attempts: 3 })?.prior === 0.41);
check('answers here that put the estimate UNDER the seed withdraw it',
    headStartOf({ placement_prior: 0.41, mastery_score: 0.12, total_attempts: 10 }) === null);

// ---- 2. the ceiling, tied to the arithmetic that produces the seeds ---------------
console.log('\n--- how short a review is ---');
const directMC = priorFromAnswer('multiple_choice', true);
const directOpen = priorFromAnswer('short_answer', true);
const impliedMC = directMC * PROPAGATION_DISCOUNT;
const impliedOpen = directOpen * PROPAGATION_DISCOUNT;
check(`a correct placement answer ON the topic is a strong head start (MC ${directMC.toFixed(3)}, open ${directOpen.toFixed(3)} ≥ ${STRONG_HEAD_START})`,
    directMC >= STRONG_HEAD_START && directOpen >= STRONG_HEAD_START);
check(`an INFERRED one is not (MC ${impliedMC.toFixed(3)}, open ${impliedOpen.toFixed(3)} < ${STRONG_HEAD_START})`,
    impliedMC < STRONG_HEAD_START && impliedOpen < STRONG_HEAD_START);
check(`a fresh proven twin is strong (transfer ceiling ${TRANSFER_CEILING})`, TRANSFER_CEILING >= STRONG_HEAD_START);
check('strong → two parts, inferred → three', reviewParts(directMC, 5) === REVIEW_PARTS_STRONG && reviewParts(impliedMC, 5) === REVIEW_PARTS
    && REVIEW_PARTS_STRONG === 2 && REVIEW_PARTS === 3);
check('never more than the learner\'s own feed_max_parts', reviewParts(impliedMC, 2) === 2 && reviewParts(directMC, 1) === 1);
check('a review is always shorter than the default ceiling', REVIEW_PARTS < 5);
check('schedule share is what the estimate leaves unknown', Math.abs(scheduleShare({ prior: 0.41 }) - 0.59) < 1e-9 && scheduleShare(null) === 1);

// ---- 3. the scheduler ---------------------------------------------------------------
console.log('\n--- the schedule gives a head start less time ---');
const sp = mkProject('Schedule');
const sec = mkNode(sp, 'Section', null, 0);
const [sA, sB, sC, sD, sE] = ['A', 'B', 'C', 'D', 'E'].map((t, i) => mkNode(sp, t, sec, i));
const weightOf = (r, id) => r.assignments.get(id)?.weight;
const cold = allocateSchedule(sp, START, DEADLINE, WEEKDAYS);
check('control: five cold topics weigh the same', new Set([sA, sB, sC, sD, sE].map(id => weightOf(cold, id))).size === 1);
seed(sB, 0.41);
seed(sC, 0.41); wrongAnswer(sC);             // contradicted
seed(sD, 0.41); rightAnswer(sD);             // agreed with
seed(sE, 0.41);
db.prepare('UPDATE nodes SET estimated_weight = 2 WHERE id = ?').run(sE);
const warm = allocateSchedule(sp, START, DEADLINE, WEEKDAYS);
const ratio = weightOf(warm, sB) / weightOf(warm, sA);
check(`a head start of 0.41 gets 59% of a cold topic's weight (got ${(ratio * 100).toFixed(1)}%)`, Math.abs(ratio - 0.59) < 1e-9);
check('...and fewer days', warm.assignments.get(sB).allocatedDays < warm.assignments.get(sA).allocatedDays,
    `${warm.assignments.get(sB).allocatedDays} vs ${warm.assignments.get(sA).allocatedDays}`);
check('a head start the learner\'s answers contradicted gets the full weight', weightOf(warm, sC) === weightOf(warm, sA));
check('one their answers agree with stays light', weightOf(warm, sD) < weightOf(warm, sA));
check('the learner\'s own weight still wins', weightOf(warm, sE) === 2);
seed(sB, 0);
const withdrawn = allocateSchedule(sp, START, DEADLINE, WEEKDAYS);
check('withdrawing the seed restores the cold weight', weightOf(withdrawn, sB) === weightOf(withdrawn, sA));

// ---- 4. finishing and discarding a placement --------------------------------------------
console.log('\n--- a placement re-lays the schedule inside its window ---');
const pp = mkProject('Placed');
const ppSec = mkNode(pp, 'Mechanics', null, 0);
const ppLeaves = Array.from({ length: 8 }, (_, i) => mkNode(pp, `Topic ${i + 1}`, ppSec, i));
const first = allocateSchedule(pp, START, DEADLINE, WEEKDAYS);
persistSchedule(pp, first.assignments, first.baselineSnapshot, { startDate: START, deadline: DEADLINE, studyDays: WEEKDAYS });
const datesOf = (pid) => JSON.stringify(db.prepare(
    'SELECT id, scheduled_start, scheduled_end FROM nodes WHERE project_id = ? ORDER BY id',
).all(pid));
const before = datesOf(pp);
const probe = createProbe(pp, { limit: 3 });
setProbeQuestions(probe.id, probe.targets.map(t => ({
    node_id: t.node_id, seq: t.seq, type: 'multiple_choice', question: 'q', options: ['a', 'b'], correct_answer: 'a',
})));
probe.targets.forEach((_, i) => recordProbeAnswer(probe.id, { questionIndex: i, correct: true }));
const done = finishProbe(probe.id);
check('finishing reports that the dates moved', done.summary.rescheduled === true, JSON.stringify(done.summary));
check('the summary is counts only — the sentence is the client\'s, in the reader\'s language',
    !('headline' in done.summary) && done.summary.topicsSeeded > 0);
check('...and they did move', datesOf(pp) !== before);
const win = db.prepare('SELECT start_date, deadline FROM projects WHERE id = ?').get(pp);
check('inside the SAME window', win.start_date === START && win.deadline === DEADLINE, JSON.stringify(win));
const seededIds = db.prepare(`SELECT nm.node_id FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id
    WHERE n.project_id = ? AND nm.placement_prior IS NOT NULL`).all(pp).map(r => r.node_id);
const span = (id) => { const r = db.prepare('SELECT scheduled_start s, scheduled_end e FROM nodes WHERE id = ?').get(id); return (Date.parse(r.e) - Date.parse(r.s)) / 864e5; };
const coldIds = ppLeaves.filter(id => !seededIds.includes(id));
check('a seeded topic now spans no more days than a cold one',
    Math.max(...seededIds.map(span)) <= Math.min(...coldIds.map(span)),
    `seeded ${seededIds.map(span)} cold ${coldIds.map(span)}`);
const discarded = discardProbe(pp);
check('discarding reports the dates moved back', discarded.rescheduled === true);
check('...to EXACTLY the dates it had before the placement', datesOf(pp) === before);

const np = mkProject('Nothing known');
const npSec = mkNode(np, 'Optics', null, 0);
for (let i = 0; i < 8; i++) mkNode(np, `Lens ${i + 1}`, npSec, i);
const npFirst = allocateSchedule(np, START, DEADLINE, WEEKDAYS);
persistSchedule(np, npFirst.assignments, npFirst.baselineSnapshot, { startDate: START, deadline: DEADLINE, studyDays: WEEKDAYS });
const npBefore = datesOf(np);
const npProbe = createProbe(np, { limit: 3 });
setProbeQuestions(npProbe.id, npProbe.targets.map(t => ({
    node_id: t.node_id, seq: t.seq, type: 'multiple_choice', question: 'q', options: ['a', 'b'], correct_answer: 'a',
})));
npProbe.targets.forEach((_, i) => recordProbeAnswer(npProbe.id, { questionIndex: i, correct: false }));
const npDone = finishProbe(npProbe.id);
check('a probe that seeded nothing does not claim the schedule changed', npDone.summary.rescheduled === false && npDone.summary.topicsSeeded === 0);
check('...and no date moved', datesOf(np) === npBefore);

console.log('\n--- ...but never once a topic is closed ---');
db.prepare("UPDATE nodes SET status = 'completed' WHERE id = ?").run(ppLeaves[0]);
seed(ppLeaves[5], 0.41);
const closedBefore = datesOf(pp);
check('a project with a closed topic is not re-laid', relaySchedule(pp) === false);
check('...and no date moved', datesOf(pp) === closedBefore);
check('an unscheduled project is not re-laid', relaySchedule(mkProject('No dates')) === false);

console.log('\n--- Discard takes the head start off a topic answered since, too ---');
const ap = mkProject('Answered, then discarded');
const apSec = mkNode(ap, 'Waves', null, 0);
for (let i = 0; i < 6; i++) mkNode(ap, `Wave ${i + 1}`, apSec, i);
const apProbe = createProbe(ap, { limit: 3 });
setProbeQuestions(apProbe.id, apProbe.targets.map(t => ({
    node_id: t.node_id, seq: t.seq, type: 'multiple_choice', question: 'q', options: ['a', 'b'], correct_answer: 'a',
})));
apProbe.targets.forEach((_, i) => recordProbeAnswer(apProbe.id, { questionIndex: i, correct: true }));
finishProbe(apProbe.id);
const answeredId = apProbe.targets[0].node_id;
rightAnswer(answeredId); rightAnswer(answeredId); // agree with the seed, so the head start stands
check('control: an answered topic whose answers agree keeps its head start', headStartFor(answeredId) !== null);
const onTopOfSeed = db.prepare('SELECT mastery_score FROM node_mastery WHERE node_id = ?').get(answeredId).mastery_score;
// The same two answers on a topic that never had a seed: what the answers alone earn.
const coldTwin = mkNode(ap, 'Never seeded', apSec, 99);
applySeededPrior(coldTwin, 'placement', 0);
rightAnswer(coldTwin); rightAnswer(coldTwin);
const coldScore = db.prepare('SELECT mastery_score FROM node_mastery WHERE node_id = ?').get(coldTwin).mastery_score;
check(`control: on top of the seed the same answers score far higher (${onTopOfSeed.toFixed(3)} vs ${coldScore.toFixed(3)})`, onTopOfSeed > coldScore + 0.2);
discardProbe(ap);
check('after Discard it has no head start', headStartFor(answeredId) === null);
check('...no placement banner', getPlacementInfo(answeredId) == null);
const cols = db.prepare('SELECT placement_prior, placement_sources, placement_at, mastery_score FROM node_mastery WHERE node_id = ?').get(answeredId);
check('...no seed columns left', cols.placement_prior === null && cols.placement_sources === null && cols.placement_at === null, JSON.stringify(cols));
check('...and its score is what its own answers earn, as if it had never been seeded',
    Math.abs(cols.mastery_score - coldScore) < 1e-12, `${cols.mastery_score} vs ${coldScore}`);
const { checkMasteryEligibility } = await import(B + 'mastery.js');
check('...so Discard never makes it easier to close than a topic with no head start',
    checkMasteryEligibility(answeredId, 0.85, 0.8).eligible === checkMasteryEligibility(coldTwin, 0.85, 0.8).eligible);
check('...and no topic of the project still counts as placed', summariseProbe({ projectId: ap, answers: [], questions: [] }).topicsSeeded === 0);

console.log('\n--- a re-lay keeps where the plan on screen starts ---');
const rp = mkProject('Recalibrated');
const rpSec = mkNode(rp, 'Optics', null, 0);
const rpLeaves = Array.from({ length: 6 }, (_, i) => mkNode(rp, `Mirror ${i + 1}`, rpSec, i));
const rpFirst = allocateSchedule(rp, START, DEADLINE, WEEKDAYS);
persistSchedule(rp, rpFirst.assignments, rpFirst.baselineSnapshot, { startDate: START, deadline: DEADLINE, studyDays: WEEKDAYS });
// What a Recalibrate leaves behind: the open topics laid from the day it was
// pressed, with the project's start_date untouched.
const PRESSED = '2026-11-02';
for (const [id, a] of allocateSchedule(rp, PRESSED, DEADLINE, WEEKDAYS).assignments) {
    db.prepare('UPDATE nodes SET scheduled_start = ?, scheduled_end = ? WHERE id = ?').run(a.scheduled_start, a.scheduled_end, id);
}
seed(rpLeaves[2], 0.41);
check('a head start after a recalibration re-lays the dates', relaySchedule(rp) === true);
const firstDate = db.prepare('SELECT MIN(scheduled_start) AS d FROM nodes WHERE project_id = ? AND is_note = 0').get(rp).d;
check(`...from the recalibrated start, never back into the window's first weeks (first date ${firstDate})`, firstDate >= PRESSED);
check('...inside the same window', db.prepare('SELECT start_date FROM projects WHERE id = ?').get(rp).start_date === START);

// ---- 5. the feed generator --------------------------------------------------------------
console.log('\n--- the generator plans a review ---');
setSetting('ai_enabled', 'true');
const gp = mkProject('Generator');
const gn = mkNode(gp, 'Standing waves', null, 0, 'Nodes, antinodes and harmonics on a string.');
const PARTS = (n) => Array.from({ length: n }, (_, i) => ({ title: `Part ${i + 1}`, focus: '' }));
const addRow = (nodeId, kind, seq, status = 'ready') => db.prepare(
    `INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, ?, ?, 'x', '{}', ?)`,
).run(nodeId, kind, seq, status).lastInsertRowid;
const kinds = (nodeId) => db.prepare(`SELECT kind, seq, status FROM feed_items WHERE node_id = ? ORDER BY kind, seq`).all(nodeId)
    .map(r => `${r.kind}:${r.seq}:${r.status}`).join(' ');
const planRow = (nodeId) => db.prepare(`SELECT * FROM feed_items WHERE node_id = ? AND kind = 'plan'`).get(nodeId);
const reviewMeta = (parts) => ({ headStart: { parts, prior: 0.413, source: 'placement' } });
const step = (nodeId) => { const m = nextMissing(nodeId); return m ? `${m.type}${m.replace ? ':replace' : ''}${m.kind ? `:${m.kind}` : ''}${m.i ? `:${m.i}` : ''}` : null; };

check('no plan → write one', step(gn) === 'plan');
writePlan(gn, PARTS(4), {});
check('control: a plan written for an UNSEEDED topic is never stale (no churn on the existing library)', step(gn) === 'lesson:1');
addRow(gn, 'lesson', 1); addRow(gn, 'question', 2); addRow(gn, 'practice', 100);
const quiz = Number(db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(gn, 'bank', '[]').lastInsertRowid);
seed(gn, 0.41);
check('a head start arriving on an unstarted topic makes its full plan stale', step(gn) === 'plan:replace');
const consumed = addRow(gn, 'lesson', 3, 'consumed');
check('...but not once the learner has consumed any of it', planIsStale(gn, planRow(gn)) === false && step(gn) !== 'plan:replace');
db.prepare('DELETE FROM feed_items WHERE id = ?').run(consumed);
check('writePlan(replace) swaps the plan and the lessons and questions written from it',
    writePlan(gn, PARTS(2), reviewMeta(2), { replace: true }) === true && kinds(gn) === 'plan:0:internal practice:100:ready', kinds(gn));
check('...and leaves the paper exercise and the question bank alone',
    !!db.prepare('SELECT 1 FROM quizzes WHERE id = ?').get(quiz) && kinds(gn).includes('practice:100'));
check('the review plan matches the head start: not stale', planIsStale(gn, planRow(gn)) === false);
check('its first step is part 1', step(gn) === 'lesson:1');
addRow(gn, 'lesson', 1);
check('then its MASTERY CHECK — the chapter offers it first', step(gn) === 'material:mastery_check');
check('...and the end-of-stream look-ahead does not also claim it mid-teaching', pendingMaterial(gn) === null);
setSetting('feed_prepare_check', 'false');
check('the look-ahead switch turns that off too (part 1 then gets its question)', step(gn) === 'question:1');
setSetting('feed_prepare_check', 'true');
const pr = planRow(gn);
db.prepare('UPDATE feed_items SET meta = ? WHERE id = ?').run(JSON.stringify({ ...reviewMeta(2), skippedCheck: true }), pr.id);
check('a check the model could not write is not retried here', step(gn) === 'question:1');
db.prepare('UPDATE feed_items SET meta = ? WHERE id = ?').run(JSON.stringify(reviewMeta(2)), pr.id);
const mcq = (i) => ({ question: `Q${i}`, type: 'multiple_choice', options: ['a', 'b'], correct_answer: 'a', explanation: 'a' });
db.prepare('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify([1, 2, 3, 4].map(mcq)), quiz);
// A bank covers the whole topic, so before it is asked after part 1 its
// questions are placed by part (feed.js, 2026-10-01) — a review included.
check('once the bank exists, its questions are placed by part before part 1 is asked', step(gn) === 'bank-map');
const uuids = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(quiz).questions).map(q => q.uuid);
const withMap = (map) => db.prepare('UPDATE feed_items SET meta = ? WHERE id = ?').run(JSON.stringify({ ...reviewMeta(2), bankParts: map }), pr.id);
withMap({ map: Object.fromEntries(uuids.map((u, k) => [u, k === 0 ? 1 : 2])) });
check('a bank question about part 1 → the review is practised from it, no question authored, straight to part 2', step(gn) === 'lesson:2');
withMap({ map: Object.fromEntries(uuids.map(u => [u, 2])) });
check('none about part 1 → part 1 gets its own question', step(gn) === 'question:1');
withMap({ failed: true });
check('a map that failed → part 1 gets its own question, and the map is not retried', step(gn) === 'question:1');
addRow(gn, 'question', 2);
check('...then straight to part 2', step(gn) === 'lesson:2');

console.log('\n--- ...and re-plans when the head start changes before it is started ---');
seed(gn, 0);
check('withdrawn (Discard) → the review is stale', step(gn) === 'plan:replace');
seed(gn, impliedMC);
check('weaker (inferred, a three-part review) → stale', step(gn) === 'plan:replace');
seed(gn, 0.41);
check('back to the strength it was planned for → not stale', planIsStale(gn, planRow(gn)) === false);
const gn2 = mkNode(gp, 'Beats', null, 1);
seed(gn2, 0.41);
writePlan(gn2, PARTS(2), reviewMeta(2));
wrongAnswer(gn2);
check('contradicted by the learner (a failed "Prove it now") → planned in full again', step(gn2) === 'plan:replace');
addRow(gn2, 'lesson', 1, 'consumed');
check('writePlan(replace) refuses once the topic was started meanwhile', writePlan(gn2, PARTS(4), {}, { replace: true }) === false
    && JSON.parse(planRow(gn2).meta).headStart?.parts === 2);

// ---- 6. what the feed says ------------------------------------------------------------
console.log('\n--- the feed says so, and says the right thing ---');
setSetting('ai_enabled', 'false');
const fp = mkProject('Feed');
const fSec = mkNode(fp, 'Waves', null, 0);
const via = mkNode(fp, 'Old title', fSec, 5);
const implied = mkNode(fp, 'Wave speed', fSec, 1, 'v = f λ.');
const direct = mkNode(fp, 'Frequency', fSec, 2, 'Cycles per second.');
const twin = mkNode(fp, 'Superposition', fSec, 3, 'Waves add.');
seed(implied, impliedMC, [{ kind: 'implied', via_node_id: via, via_title: 'Old title' }]);
seed(direct, directMC);
applySeededPrior(twin, 'transfer', 0.6, [{ node_id: via }]);
db.prepare('UPDATE nodes SET title = ? WHERE id = ?').run('Live title', via);
const feedOf = (nodeId, exclude = []) => composeFeed({ limit: 20, excludeKeys: new Set(exclude), gate: GATE, nodeId });
const fi = feedOf(implied);
check('an inferred head start rides on the feed response', fi.placements?.[implied]?.kind === 'implied', JSON.stringify(fi.placements));
check('...naming the topic that vouched for it by its LIVE title', fi.placements?.[implied]?.via?.title === 'Live title');
check('...and not claiming a review before any plan exists', fi.placements?.[implied]?.review === false);
const fd = feedOf(direct);
check('a direct one names no other topic', fd.placements?.[direct]?.kind === 'direct' && fd.placements[direct].via === null);
writePlan(implied, PARTS(3), reviewMeta(3));
check('"short review" is said only of a plan written as one', feedOf(implied).placements?.[implied]?.review === true);
const cp = feedOf(implied, [`read-${implied}`]).items.find(c => c.kind === 'checkpoint');
check('the checkpoint names a placement as the source of the borrowed part', cp?.borrowedEstimate === true && cp?.borrowedFrom === 'placement', JSON.stringify(cp));
const cpT = feedOf(twin, [`read-${twin}`]).items.find(c => c.kind === 'checkpoint');
check('...and a proven twin as a twin', cpT?.borrowedFrom === 'transfer', JSON.stringify(cpT));
rightAnswer(direct);
check('answered here, the head start is SPENT — history, not an offer', getPlacementInfo(direct)?.spent === true);

// The notice over a feed served without generated lessons: "being prepared" is
// a promise, and with AI on but no model chosen nothing can keep it.
const noticeOf = () => feedOf(twin).items.find(c => c.key === 'notice-ai');
const offNotice = noticeOf();
setSetting('ai_enabled', 'true'); setSetting('ai_model', '');
const noModelNotice = noticeOf();
setSetting('ai_model', 'some-model');
const modelNotice = noticeOf();
setSetting('ai_enabled', 'false'); setSetting('ai_model', '');
check('AI off: the feed says it is off', /AI is off/.test(offNotice?.message || ''), JSON.stringify(offNotice));
check('AI on with no model chosen: no "being prepared" promise', !/being prepared/.test(noModelNotice?.message || ''), JSON.stringify(noModelNotice));
check('...and a topic\'s own feed, which draws no setup card, says what to do', noModelNotice?.message === 'Choose a model in Settings → AI & Models.', JSON.stringify(noModelNotice));
check('AI on with a model chosen: the lessons are said to be on their way', /being prepared/.test(modelNotice?.message || ''), JSON.stringify(modelNotice));

// ---- 7. a seed is not a memory ----------------------------------------------------------
console.log('\n--- a seed alone never produces a recall question ---');
const dp = mkProject('Decay');
const seededOnly = mkNode(dp, 'Never taught', null, 0);
const learned = mkNode(dp, 'Taught and proven', null, 1);
seed(seededOnly, 0.52);
applySeededPrior(learned, 'placement', 0); // create the row
updateMasteryFromAttempt(learned, 10, 10, 'mastery_check', null);
db.prepare(`UPDATE node_mastery SET last_updated = datetime('now', '-40 days') WHERE node_id IN (?, ?)`).run(seededOnly, learned);
const decaying = getDecayingNodes(dp, 14).map(r => r.node_id);
check('a topic learned here and left 40 days decays', decaying.includes(learned));
check('a topic only SEEDED (0.52, never answered) does not', !decaying.includes(seededOnly), JSON.stringify(decaying));
const preFix = db.prepare(`SELECT nm.node_id FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id
    WHERE n.project_id = ? AND nm.mastery_score > 0.5 AND nm.last_updated < datetime('now', '-14 days')`).all(dp).map(r => r.node_id);
check('control: the pre-fix query DID return it', preFix.includes(seededOnly));
const todaySrc = readFileSync(new URL('today.js', B), 'utf8');
check('today.js\'s own decaying list carries the same clause',
    /mastery_score > 0\.5\s+AND nm\.total_attempts > 0/.test(todaySrc));

// ---- 8. the prompts are told -----------------------------------------------------------
console.log('\n--- the writers are told ---');
const outline = AI_PROMPTS.feed_outline('T', 'ctx', { reviewParts: 2 }).system;
check('the planner hears it is a review, and its ceiling', outline.includes('THIS TOPIC IS A REVIEW') && outline.includes('at most 2 parts'));
check('...and a cold topic hears nothing of it', !AI_PROMPTS.feed_outline('T', 'ctx', {}).system.includes('REVIEW'));
const lesson = AI_PROMPTS.feed_lesson('T', PARTS(2), 1, 'ctx', [], { review: true }).system;
check('the lesson writer hears it, and is told never to say how it was judged',
    lesson.includes('PART OF A REVIEW') && lesson.includes('never mention how that was judged'));
check('...and a cold lesson hears nothing of it', !AI_PROMPTS.feed_lesson('T', PARTS(2), 1, 'ctx', []).system.includes('PART OF A REVIEW'));

// ---- 9. end to end through the generator, against a stub model ------------------------
// Sections 5 and 8 assert the decision and the prompt text separately; this is
// the wiring between them — that generateOne ASKS for a review, ENFORCES its
// ceiling on a planner that ignores it, and tells the lesson writer. The stub
// answers any outline with five parts (a planner that ignores the ceiling), any
// lesson with plain prose, and refuses everything else. Loopback only, through
// the app's own AI_BASE_URL override (getAISettings), never the settings row.
console.log('\n--- end to end: the generator asks for a review and enforces it ---');
const { createServer } = await import('node:http');
const seen = [];
const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const msgs = (() => { try { return JSON.parse(body).messages || []; } catch { return []; } })();
        const system = msgs.find(m => m.role === 'system')?.content || '';
        seen.push(system);
        let content = null;
        if (system.includes('curriculum designer')) {
            content = JSON.stringify({ parts: PARTS(5).map((pt, i) => ({ ...pt, focus: `Idea ${i + 1} of the topic.` })) });
        } else if (system.includes('writing ONE segment')) {
            content = 'A wave on a string reflects at a fixed end and comes back inverted, which is why a string held at both ends can only ring at certain frequencies. The pattern that survives has still points where the two travelling waves always cancel.';
        }
        if (content == null) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"stub: not part of this gate"}}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 50 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';
setSetting('ai_enabled', 'true');
const { generateForNode } = await import(B + 'feedGen.js');
/** Run the generator for one topic up to and including part 1, then stop it. */
const runToPartOne = async (nodeId) => {
    const ac = new AbortController();
    seen.length = 0;
    try {
        await generateForNode(nodeId, {
            signal: ac.signal,
            onStep: (label) => { if (label !== 'outline' && label !== 'lesson 1') ac.abort(); },
        });
    } catch { /* the abort, by design */ }
    return JSON.parse(planRow(nodeId)?.content || '{"parts":[]}').parts.length;
};
const ep = mkProject('End to end');
const warmNode = mkNode(ep, 'Standing waves', null, 0, 'Nodes, antinodes and harmonics on a string.');
const coldNode = mkNode(ep, 'Resonance', null, 1, 'Driving a system at its natural frequency.');
seed(warmNode, directMC);
const warmParts = await runToPartOne(warmNode);
const warmOutline = seen.find(s => s.includes('curriculum designer')) || '';
const warmLesson = seen.find(s => s.includes('writing ONE segment')) || '';
check('a seeded topic\'s planner is asked for a review of at most 2 parts', warmOutline.includes('THIS TOPIC IS A REVIEW') && warmOutline.includes('at most 2 parts'),
    `saw ${seen.length} request(s)`);
check(`...and a planner that returns 5 anyway is cut to 2 (stored ${warmParts})`, warmParts === 2);
check('...and the plan records what it was sized for', JSON.parse(planRow(warmNode).meta).headStart?.parts === 2);
check('its lesson writer is told it is writing a review', warmLesson.includes('PART OF A REVIEW'));
const coldParts = await runToPartOne(coldNode);
const coldOutline = seen.find(s => s.includes('curriculum designer')) || '';
check('a cold topic\'s planner hears nothing of it', coldOutline !== '' && !coldOutline.includes('REVIEW'));
check(`...and keeps the full ceiling (stored ${coldParts} of the stub's 5)`, coldParts === 5);
check('...and its lesson writer hears nothing of it', !(seen.find(s => s.includes('writing ONE segment')) || '').includes('PART OF A REVIEW'));
await new Promise(r => stub.close(r));

console.log(`\n${pass} passed, ${fail} failed`);
db.close();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL */ }
// exitCode, not exit(): exit() while fetch's keep-alive socket to the stub is
// still closing trips a libuv assertion on Windows (UV_HANDLE_CLOSING).
process.exitCode = fail ? 1 : 0;
