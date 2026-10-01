#!/usr/bin/env node
/**
 * The "~x left" of an AI project creation, and the line runs wait in.
 *
 * `server/creationEta.js` turns a run's shape (phases → sections → topics, as
 * each becomes known) and its timed calls into the time left; this suite pins
 * that arithmetic on a fake clock, so no model and no server are involved:
 *
 *   - it NEVER predicts before the shape is known: no phases, or phases with no
 *     section count, or sections with no topic count, is "estimating" (null);
 *   - the time left is Σ calls-left-per-kind × that kind's average, with THIS
 *     run's measurement beating the seed from earlier runs;
 *   - the call in flight is counted down, never below the floor of what comes
 *     after it;
 *   - a phase the batch covers costs one batched call, a wide phase one call
 *     per section, and a section the batch missed its own call;
 *   - with link hunting off, no link calls are priced;
 *   - time spent waiting in line is not time spent working;
 *   - an unknown pipeline phase keeps the stage (a new early step must not
 *     throw the stepper back to the start).
 *
 * And `server/creationSlots.js`: one slot means the second run waits at #1,
 * the third at #2, a release moves both up, a cancelled waiter leaves the line.
 *
 *   node tools/generation-eta-gates.mjs
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const B = pathToFileURL(resolve(ROOT, 'server')).href + '/';
const { stageOf, remainingOps, etaForOps, createCreationTracker, CREATION_OPS, callAnnouncedBy } = await import(B + 'creationEta.js');
const { createSlotGate } = await import(B + 'creationSlots.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---- stages ------------------------------------------------------------------
console.log('\n--- which stage a pipeline phase belongs to ---');
check('thinking → think', stageOf('thinking') === 'think');
check('init and summary → prepare', stageOf('init') === 'prepare' && stageOf('summary') === 'prepare');
check('the phase list → outline', stageOf('generating_categories') === 'outline' && stageOf('categories_generated') === 'outline');
check('every loop phase → build', ['generating_elements', 'elements_generated', 'generating_sub_elements', 'sub_elements_batched', 'sub_elements_generated', 'finding_resources', 'resources_saved'].every(p => stageOf(p) === 'build'));
check('complete → done', stageOf('complete') === 'done');
check('queued → queued', stageOf('queued') === 'queued');
check('an unknown phase keeps the stage it is in', stageOf('deciding_identity', 'prepare') === 'prepare' && stageOf('whatever', 'think') === 'think');
check('error keeps the stage it failed in', stageOf('error', 'build') === 'build');

console.log('\n--- the call a frame announces is in flight on that frame ---');
check('"finding links" announces a link hunt', callAnnouncedBy({ phase: 'finding_resources' }) === 'links');
check('a per-section topics frame announces a topics call', callAnnouncedBy({ phase: 'generating_sub_elements', currentElement: 'X' }) === 'topics');
check('a phase-wide topics frame announces the batch', callAnnouncedBy({ phase: 'generating_sub_elements' }) === 'topics_batch');
check('the summary\'s RESULT frame announces nothing', callAnnouncedBy({ phase: 'summary', summary: 'text' }) === null && callAnnouncedBy({ phase: 'summary' }) === 'summary');
check('a result frame announces nothing', ['elements_generated', 'resources_saved', 'categories_generated', 'complete'].every(p => callAnnouncedBy({ phase: p }) === null));

// ---- remaining calls ---------------------------------------------------------
console.log('\n--- the calls still to make ---');
const phase = (sections, batchTried = false) => ({ sections, batchTried });
const sec = (topics, done = 0) => ({ topics, done });

let r = remainingOps({ phases: null }, { curate: true });
check('no phase list yet → not estimable', r.complete === false && r.topicsLeft === null);

r = remainingOps({ phases: [phase(null), phase(null)] }, { curate: true });
check('phases known, no sections anywhere → not estimable', r.complete === false);
check('...but each unplanned phase still owes its sections call', r.ops.sections === 2);

r = remainingOps({ phases: [phase([sec(null), sec(null), sec(null)]), phase(null)] }, { curate: true });
check('sections known, no topics anywhere → not estimable', r.complete === false);
r = remainingOps({ phases: [phase([sec(null), sec(null), sec(null)])] }, { curate: true });
check('...a batchable phase owes ONE batched call, not three', r.ops.topics_batch === 1 && r.ops.topics === 0,
    JSON.stringify(r.ops));

r = remainingOps({ phases: [phase([sec(4, 4), sec(4, 1), sec(4)], true), phase(null), phase(null)] }, { curate: true });
check('one phase fully planned → estimable', r.complete === true);
// Phase 0: 0 + 3 + 4 left = 7. Phases 1–2: 3 sections × 4 topics each = 24.
check(`topics left counts the written ones out (${r.topicsLeft})`, r.topicsLeft === 7 + 24);
check('each unplanned phase owes a sections call and a batch', r.ops.sections === 2 && r.ops.topics_batch === 2 && r.ops.topics === 0);
check('links = one per topic left', r.ops.links === r.topicsLeft);
check('topics known = the planned ones only', r.topicsKnown === 12);

r = remainingOps({ phases: [phase([sec(4, 4), sec(4, 1), sec(4)], true), phase(null)] }, { curate: false });
check('link hunting off → no link calls priced', r.ops.links === 0);

const wide = Array.from({ length: 12 }, () => sec(null));
r = remainingOps({ phases: [phase([sec(3)], true), phase(wide)] }, { curate: true });
check('a phase of 12 sections is not batched: 12 per-section calls', r.ops.topics === 12 && r.ops.topics_batch === 0,
    JSON.stringify(r.ops));

r = remainingOps({ phases: [phase([sec(3, 3), sec(null), sec(5)], true)] }, { curate: true });
check('a section the batch missed owes its own call', r.ops.topics === 1 && r.ops.topics_batch === 0);

r = remainingOps({ phases: [phase([sec(2)])] }, { curate: true });
check('a one-section phase is never batched (the route skips it)', r.ops.topics_batch === 0);

// ---- time for calls ----------------------------------------------------------
console.log('\n--- time for the calls left ---');
const zero = Object.fromEntries(CREATION_OPS.map(k => [k, 0]));
check('a kind with calls left and no average → null, never zero', etaForOps({ ...zero, links: 3 }, { links: null }) === null);
check('a kind with no calls left needs no average', etaForOps({ ...zero, links: 3 }, { links: 1000, topics: null }) === 3000);
check('Σ count × average', etaForOps({ ...zero, sections: 2, topics_batch: 2, links: 10 }, { sections: 5000, topics_batch: 8000, links: 3000 }) === 2 * 5000 + 2 * 8000 + 10 * 3000);

// ---- one run on a fake clock -------------------------------------------------
console.log('\n--- one run on a fake clock ---');
let t = 1_000_000;
const tr = createCreationTracker({ seeds: { links: 9000 }, curate: true });
tr.phase('thinking', t);
check('a run that has only started says nothing about time', tr.snapshot(t).etaMs === null);
tr.begin('thinking', t); t += 2000; tr.end('thinking', t);
tr.phase('summary', t); tr.begin('summary', t); t += 1000; tr.end('summary', t);
tr.phase('generating_categories', t); tr.begin('phases', t); t += 4000; tr.end('phases', t);
tr.phasesPlanned(3);
tr.phase('categories_generated', t);
check('phases known, nothing inside them → still estimating', tr.snapshot(t).etaMs === null);
check('...and the stage is outline', tr.snapshot(t).stage === 'outline');
check('...with 3 phases', tr.snapshot(t).phases === 3);
tr.phaseStarted(0);
tr.phase('generating_elements', t); tr.begin('sections', t); t += 3000; tr.end('sections', t);
tr.sectionsPlanned(0, 3);
tr.begin('topics_batch', t); t += 6000; tr.end('topics_batch', t);
tr.batchTried(0);
[0, 1, 2].forEach(j => tr.topicsPlanned(0, j, 4));
let s = tr.snapshot(t);
// Left: phase 0 → 12 links; phases 1–2 → 1 sections + 1 batch + 12 links each.
// links: 36 × 9000 (seed); sections 2 × 3000; batch 2 × 6000.
const expected = 36 * 9000 + 2 * 3000 + 2 * 6000;
check(`shape known → an estimate (${s.etaMs} ms, expected ${expected})`, s.etaMs === expected);
check('...made partly of a seed, so not "measured"', s.etaMeasured === false);
check('...the stage is build', s.stage === 'build');
check('...36 topics, all still to write', s.topicsTotal === 36 && s.topicsDone === 0);
check('...not exact while two phases are unplanned', s.topicsExact === false);

tr.phase('finding_resources', t); tr.begin('links', t); t += 3000; tr.end('links', t); tr.topicDone(0, 0);
s = tr.snapshot(t);
const expected2 = 35 * 3000 + 2 * 3000 + 2 * 6000;
check(`this run's own link time replaces the seed (${s.etaMs}, expected ${expected2})`, s.etaMs === expected2);
check('...and every average is now this run\'s own', s.etaMeasured === true);
check('...one topic written', s.topicsDone === 1);

tr.begin('links', t);
const inflight = tr.snapshot(t + 1000);
check(`a call in flight is counted down (${inflight.etaMs}, expected ${expected2 - 1000})`, inflight.etaMs === expected2 - 1000);
check(`...never below the floor of what comes after it (${inflight.etaFloorMs}, expected ${expected2 - 3000})`, inflight.etaFloorMs === expected2 - 3000);
const overrun = tr.snapshot(t + 20000);
check('an overrunning call leaves the estimate AT the floor, not under it', overrun.etaMs === overrun.etaFloorMs);
check('progress is a fraction of time, between 0 and 1', inflight.fraction > 0 && inflight.fraction < 1);
t += 3000; tr.end('links', t); tr.topicDone(0, 1);
tr.phase('complete', t);
check('done → no time left', tr.snapshot(t).etaMs === null && tr.snapshot(t).stage === 'done');
check('stage clocks: think took 2 s', (() => { const st = tr.snapshot(t).stageTimes.think; return st.end - st.start === 2000; })());

// ---- the line ----------------------------------------------------------------
console.log('\n--- waiting in line is not working ---');
let q = 5_000_000;
const tq = createCreationTracker({ curate: false });
tq.phase('queued', q);
q += 60_000;
tq.phase('thinking', q);
q += 5000;
check(`a minute in line is not a minute of work (${tq.snapshot(q).activeMs} ms active)`, tq.snapshot(q).activeMs === 5000);

console.log('\n--- the slot gate ---');
let limit = 1;
const gate = createSlotGate(() => limit);
const positions = { b: [], c: [] };
const a = await gate.acquire(null);
check('a free slot is granted at once', typeof a === 'function' && gate.running() === 1);
const bP = gate.acquire(null, p => positions.b.push(p));
const cAbort = new AbortController();
const cP = gate.acquire(cAbort.signal, p => positions.c.push(p));
check('the second waits at #1, the third at #2', positions.b.at(-1) === 1 && positions.c.at(-1) === 2, JSON.stringify(positions));
a();
const b = await bP;
check('a release lets the next one in', typeof b === 'function' && gate.running() === 1);
check('...and moves the rest up the line', positions.c.at(-1) === 1, JSON.stringify(positions.c));
cAbort.abort();
let rejected = null;
try { await cP; } catch (e) { rejected = e; }
check('a cancelled waiter leaves the line with an AbortError', rejected?.name === 'AbortError' && gate.waiting() === 0);
a();
check('a second release of the same slot does nothing', gate.running() === 1);
b();
limit = 3;
const r1 = await gate.acquire(null), r2 = await gate.acquire(null), r3 = await gate.acquire(null);
check('three slots on a hosted provider: three at once', gate.running() === 3 && gate.waiting() === 0);
r1(); r2(); r3();

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
