// tools/scheduling-gates.mjs — checks the calendar allocator does what its docs say.
//
// Run:  node tools/scheduling-gates.mjs
//
// Deterministic, no model, no network: a scratch database (DB_PATH) holding a
// small project, driven through the REAL `allocateSchedule` /
// `recalibrateSchedule` / `persistSchedule`.
//
// This suite exists because the scheduler is the one subsystem that had none,
// and because on 2026-09-04 it lost its `hoursPerDay` parameter. That input was
// multiplied into a phase's capacity and then divided straight back out of the
// day index, so it cancelled out of every date it appeared in — measured across
// the real library, the hours-free engine reproduces all 3050 scheduled dates
// byte-for-byte, for projects set to 1, 1.5, 2 and 5 hours a day alike. What it
// really did was let the schedule dialog price the work in hours at an invented
// 1.5h per topic. The assertions below are the properties that WERE load-bearing
// and must survive: every leaf lands on a real study day inside the window,
// phases stay sequential, weight decides the share, and recalibration leaves
// finished work where it is.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'scheduling-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const db = (await import('../server/database.js')).default;
const {
    allocateSchedule, persistSchedule, recalibrateSchedule, getValidStudyDates, daysBetween,
} = await import('../server/scheduling.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

// ---- fixture: 3 phases, 4 leaves each, plus a note that must never be scheduled
const projectId = Number(db.prepare(`INSERT INTO projects (name) VALUES ('gate')`).run().lastInsertRowid);
const mkNode = (title, parentId, position, extra = {}) => Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, position, is_note, estimated_weight)
     VALUES (?, ?, ?, ?, ?, ?)`
).run(projectId, parentId, title, position, extra.isNote ? 1 : 0, extra.weight ?? null).lastInsertRowid);

const phases = [];
for (let p = 0; p < 3; p++) {
    const phase = mkNode(`Phase ${p + 1}`, null, p);
    const leaves = [];
    for (let i = 0; i < 4; i++) leaves.push(mkNode(`P${p + 1} topic ${i + 1}`, phase, i));
    phases.push({ id: phase, leaves });
}
// A note hanging off a leaf: material, not work. It must not be scheduled, and
// its parent must STILL be a leaf (the app's one definition of leafness).
const noteId = mkNode('Reading', phases[0].leaves[0], 9, { isNote: true });

// Dates are relative to TODAY, not fixed: `recalibrateSchedule` runs from today
// forward and refuses a deadline that has passed, so a hardcoded window turns
// this suite into a time bomb that passes until the date it names goes by.
const iso = (d) => d.toISOString().split('T')[0];
const addDays = (dateStr, n) => {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
};
const START = iso(new Date());
const DEADLINE = addDays(START, 90);
const WEEKDAYS = [1, 2, 3, 4, 5];

console.log('\n--- the signature no longer takes hours ---');
check('allocateSchedule(projectId, start, deadline, studyDays) — four parameters',
    allocateSchedule.length === 4, `arity ${allocateSchedule.length}`);
check('projects has no hours_per_day column',
    !db.prepare('PRAGMA table_info(projects)').all().some(c => c.name === 'hours_per_day'));

const r = allocateSchedule(projectId, START, DEADLINE, WEEKDAYS);
check('a well-formed project schedules', r.success === true, r.error || '');

const validDates = getValidStudyDates(START, DEADLINE, WEEKDAYS);
const leafIds = phases.flatMap(p => p.leaves);

console.log('\n--- every leaf lands on a real study day, inside the window ---');
check('every leaf is assigned', leafIds.every(id => r.assignments.has(id)));
check('no note is assigned', !r.assignments.has(noteId));
check('every start is a valid study date',
    leafIds.every(id => validDates.includes(r.assignments.get(id).scheduled_start)));
check('every end is a valid study date',
    leafIds.every(id => validDates.includes(r.assignments.get(id).scheduled_end)));
check('no range is inverted (end >= start)',
    leafIds.every(id => {
        const a = r.assignments.get(id);
        return a.scheduled_end >= a.scheduled_start;
    }));
check('nothing is scheduled before the start date or after the deadline',
    leafIds.every(id => {
        const a = r.assignments.get(id);
        return a.scheduled_start >= START && a.scheduled_end <= DEADLINE;
    }));

console.log('\n--- phases stay sequential, which is the whole point of phase-aware ---');
const phaseSpan = (p) => {
    const rows = p.leaves.map(id => r.assignments.get(id));
    return {
        start: rows.map(a => a.scheduled_start).sort()[0],
        end: rows.map(a => a.scheduled_end).sort().slice(-1)[0],
    };
};
const spans = phases.map(phaseSpan);
check('phase 2 starts on or after phase 1 ends', spans[1].start >= spans[0].end,
    `${spans[0].end} then ${spans[1].start}`);
check('phase 3 starts on or after phase 2 ends', spans[2].start >= spans[1].end,
    `${spans[1].end} then ${spans[2].start}`);
check('leaves within a phase are laid out in position order',
    phases.every(p => {
        const starts = p.leaves.map(id => r.assignments.get(id).scheduled_start);
        return starts.every((s, i) => i === 0 || s >= starts[i - 1]);
    }));
check('a parent phase spans its own children',
    phases.every((p, i) => {
        const parent = r.assignments.get(p.id);
        return parent && parent.scheduled_start <= spans[i].start && parent.scheduled_end >= spans[i].end;
    }));

console.log('\n--- weight decides the share of the calendar ---');
check('equal-weight leaves get equal-ish spans (within a day of each other)',
    (() => {
        const lens = phases[0].leaves.map(id => {
            const a = r.assignments.get(id);
            return daysBetween(a.scheduled_start, a.scheduled_end);
        });
        return Math.max(...lens) - Math.min(...lens) <= 1;
    })());

// Same tree, one leaf weighted 4x: it must claim strictly more calendar than a
// sibling, and its phase must still not spill into the next one.
db.prepare('UPDATE nodes SET estimated_weight = 4 WHERE id = ?').run(phases[0].leaves[0]);
const heavy = allocateSchedule(projectId, START, DEADLINE, WEEKDAYS);
const spanOf = (res, id) => {
    const a = res.assignments.get(id);
    return daysBetween(a.scheduled_start, a.scheduled_end);
};
check('a 4x leaf claims more days than its sibling',
    spanOf(heavy, phases[0].leaves[0]) > spanOf(heavy, phases[0].leaves[1]),
    `${spanOf(heavy, phases[0].leaves[0])}d vs ${spanOf(heavy, phases[0].leaves[1])}d`);
check('the heavier leaf did not push its phase past the next one',
    heavy.assignments.get(phases[1].leaves[0]).scheduled_start
    >= heavy.assignments.get(phases[0].leaves[3]).scheduled_end);
db.prepare('UPDATE nodes SET estimated_weight = NULL WHERE id = ?').run(phases[0].leaves[0]);

console.log('\n--- the depth discount and the floor, at their exact values ---');
// `computeLeafWeight` is module-private, but `allocateSchedule` publishes what
// it returned as each assignment's `weight`, so the two constants can be pinned
// through the real call rather than by reading the source. Both were free to
// drift before this block: a mutation run changed DEPTH_DISCOUNT_FACTOR to 0.90
// and MIN_LEAF_WEIGHT to 0.01 and the whole suite stayed green, because every
// other assertion here is about ordering and only compares weights with each
// other.
const wProject = Number(db.prepare(`INSERT INTO projects (name) VALUES ('weights')`).run().lastInsertRowid);
const mkW = (title, parentId, position = 0) => Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, position, is_note) VALUES (?, ?, ?, ?, 0)`
).run(wProject, parentId, title, position).lastInsertRowid);

// Depth counts ancestors: a root node is depth 0, its child depth 1. The
// discount exponent is depth - 1, so the shallowest leaf pays nothing.
const wRoot = mkW('Root', null, 0);
const chainLeaf = (depth, position) => {
    let parent = wRoot;
    for (let d = 2; d <= depth; d++) parent = mkW(`d${depth} level ${d}`, parent, 0);
    return mkW(`leaf at depth ${depth}`, parent, position);
};
const wLeaf = {};
[1, 2, 3, 4, 9, 10].forEach((depth, i) => { wLeaf[depth] = chainLeaf(depth, i); });

const wResult = allocateSchedule(wProject, START, DEADLINE, WEEKDAYS);
check('the weight fixture schedules', wResult.success === true, wResult.error || '');
const weightAt = (depth) => wResult.assignments.get(wLeaf[depth])?.weight;
const DISCOUNT = 0.85, FLOOR = 0.25;
for (const depth of [1, 2, 3, 4]) {
    const expected = Math.pow(DISCOUNT, depth - 1);
    check(`a leaf at depth ${depth} weighs ${DISCOUNT}^${depth - 1} = ${expected.toFixed(6)}`,
        Math.abs(weightAt(depth) - expected) < 1e-12, String(weightAt(depth)));
}
// 0.85^8 = 0.2725 is above the floor and 0.85^9 = 0.2316 is below it, so these
// two leaves sit either side of MIN_LEAF_WEIGHT and pin it to the digit.
check(`depth 9 is still on the curve (${Math.pow(DISCOUNT, 8).toFixed(6)}), just above the floor`,
    Math.abs(weightAt(9) - Math.pow(DISCOUNT, 8)) < 1e-12 && weightAt(9) > FLOOR, String(weightAt(9)));
check(`depth 10 would be ${Math.pow(DISCOUNT, 9).toFixed(6)} and is floored at ${FLOOR}`,
    weightAt(10) === FLOOR, String(weightAt(10)));
check('the floor is a floor, not a cap: no leaf is dragged down to it early',
    [1, 2, 3, 4, 9].every(d => weightAt(d) > FLOOR));

console.log('\n--- the baseline snapshot reports the plan in topics per study day ---');
const snap = r.baselineSnapshot;
check('config carries no hours_per_day', !('hours_per_day' in snap.config));
check('config carries the three real inputs',
    snap.config.start_date === START && snap.config.deadline === DEADLINE
    && JSON.stringify(snap.config.study_days) === JSON.stringify(WEEKDAYS));
check('leaf_count counts leaves, not notes', snap.leaf_count === leafIds.length,
    `${snap.leaf_count} vs ${leafIds.length}`);
check('topics_per_day = leaves / study days',
    Math.abs(snap.topics_per_day - leafIds.length / validDates.length) < 0.01,
    `${snap.topics_per_day}`);
check('valid_study_days matches the calendar', snap.valid_study_days === validDates.length);
check('stats agree with the snapshot',
    r.stats.leafCount === snap.leaf_count && r.stats.validDays === snap.valid_study_days);

console.log('\n--- a tight deadline warns rather than dropping work ---');
// Two study days against three phases, whatever weekday today is: every day
// counts as a study day, so the window itself is the constraint.
const tight = allocateSchedule(projectId, START, addDays(START, 1), [1, 2, 3, 4, 5, 6, 7]);
check('still succeeds', tight.success === true);
check('still assigns every leaf', leafIds.every(id => tight.assignments.has(id)));
check('says so in a warning', tight.warnings.some(w => /tight|intense/i.test(w)),
    JSON.stringify(tight.warnings));
const zero = allocateSchedule(projectId, START, DEADLINE, []);
check('no study days is an error, not an empty schedule', zero.success === false);

console.log('\n--- persist writes the dates and never schedules a note ---');
persistSchedule(projectId, r.assignments, r.baselineSnapshot, {
    startDate: START, deadline: DEADLINE, studyDays: WEEKDAYS,
});
const stored = db.prepare('SELECT id, scheduled_start, scheduled_end FROM nodes WHERE project_id = ?').all(projectId);
const byId = new Map(stored.map(n => [n.id, n]));
check('every leaf has stored dates', leafIds.every(id => byId.get(id).scheduled_start));
check('the note has none', !byId.get(noteId).scheduled_start && !byId.get(noteId).scheduled_end);
const savedProject = db.prepare('SELECT start_date, deadline, study_days, baseline_schedule FROM projects WHERE id = ?').get(projectId);
check('the project config is stored', savedProject.start_date === START && savedProject.deadline === DEADLINE);
check('the baseline snapshot round-trips as JSON',
    JSON.parse(savedProject.baseline_schedule).leaf_count === leafIds.length);

console.log('\n--- recalibration moves only what is still open ---');
// Close phase 1 entirely, keeping its dates as history.
for (const id of phases[0].leaves) {
    db.prepare(`UPDATE nodes SET status = 'completed', completed_at = ? WHERE id = ?`).run(START, id);
}
const before = new Map(stored.map(n => [n.id, `${n.scheduled_start}|${n.scheduled_end}`]));
const re = recalibrateSchedule(projectId);
check('recalibration succeeds', re.success === true, re.error || '');
check('closed leaves keep their historical dates',
    phases[0].leaves.every(id => {
        const a = re.assignments.get(id);
        return !a || `${a.scheduled_start}|${a.scheduled_end}` === before.get(id);
    }));
check('open leaves are all reassigned',
    phases[1].leaves.concat(phases[2].leaves).every(id => re.assignments.has(id)));
const reopened = phases[1].leaves.concat(phases[2].leaves);
check('nothing is rescheduled into the past',
    reopened.every(id => re.assignments.get(id).scheduled_start >= iso(new Date())));
check('nor past the deadline the project is still working to',
    reopened.every(id => re.assignments.get(id).scheduled_end <= DEADLINE));
// The property the line above used to assert twice with an `||` against two
// names for today, which could not distinguish a working allocator from one
// that ignored the phases: what recalibration must preserve is the ORDER.
const reSpan = (p) => {
    const rows = p.leaves.map(id => re.assignments.get(id));
    return {
        start: rows.map(a => a.scheduled_start).sort()[0],
        end: rows.map(a => a.scheduled_end).sort().slice(-1)[0],
    };
};
check('the open phases are still laid out sequentially',
    reSpan(phases[2]).start >= reSpan(phases[1]).end,
    `${reSpan(phases[1]).end} then ${reSpan(phases[2]).start}`);
check('stats count what is left, not the whole tree',
    re.stats.incompleteLeaves === 8 && re.stats.completedLeaves === 4,
    `${re.stats.incompleteLeaves} open / ${re.stats.completedLeaves} closed`);
check('recalibration stats carry no hours', !('totalCapacityHours' in re.stats));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
