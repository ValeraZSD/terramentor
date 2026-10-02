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

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'scheduling-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const db = (await import('../server/database.js')).default;
const {
    allocateSchedule, persistSchedule, recalibrateSchedule, getValidStudyDates, daysBetween,
    readStudyDays, DEFAULT_STUDY_DAYS,
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

// ---- the study week, read out of a column anything can write ---------------
// `projects.study_days` is free TEXT and `PUT /api/projects/:id` stores a
// client-supplied string verbatim, so every reader has to survive whatever is in
// it. Two of them had drifted: `today.js` guarded the parse, `scheduling.js`
// called JSON.parse bare and read `.length` off the answer — so one bad value
// made recalibrating that project throw for ever after. One reader now, and the
// rule is that it always returns a usable week: refusing to schedule is a worse
// answer than scheduling Monday to Friday.
const sameDays = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('a normal week is read back as itself', sameDays(readStudyDays('[1,3,5]'), [1, 3, 5]));
check('an absent column is the default', sameDays(readStudyDays(null), DEFAULT_STUDY_DAYS));
check('an empty string is the default', sameDays(readStudyDays(''), DEFAULT_STUDY_DAYS));
check('text that is not JSON is the default, not a throw', sameDays(readStudyDays('saturday'), DEFAULT_STUDY_DAYS));
check('valid JSON that is not a list is the default', sameDays(readStudyDays('{"mon":true}'), DEFAULT_STUDY_DAYS));
check('an empty list is the default — a week with no days schedules nothing', sameDays(readStudyDays('[]'), DEFAULT_STUDY_DAYS));
check('days outside 1–7 are dropped', sameDays(readStudyDays('[0,1,8,2]'), [1, 2]));
check('a list of only impossible days is the default', sameDays(readStudyDays('[0,9,99]'), DEFAULT_STUDY_DAYS));
check('duplicates collapse and the week is ordered', sameDays(readStudyDays('[5,1,5,3,1]'), [1, 3, 5]));
check('numbers written as strings still count', sameDays(readStudyDays('["1","2"]'), [1, 2]));
check('the default is handed out as a copy, never the shared array', readStudyDays(null) !== DEFAULT_STUDY_DAYS);
// The whole point: whatever it answers, the allocator can use it.
check('every answer is usable by getValidStudyDates', ['[1,3,5]', null, 'saturday', '[]', '[0,9]']
    .every(v => getValidStudyDates('2026-01-01', '2026-01-31', readStudyDays(v)).length > 0));

// And a source scan, because the fix is only worth anything while it is the ONE
// reader: a second `JSON.parse` on this column is how the two drifted apart in
// the first place. Both pre-fix shapes are here as the control — the bare parse
// scheduling.js had, and the try/catch today.js had — so this cannot pass by
// matching nothing.
const readsStudyDays = /JSON\.parse\([^)]*study_days/;
for (const rel of ['server/scheduling.js', 'server/today.js', 'server/completion.js', 'server/projectSummary.js']) {
    let src = '';
    try { src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'); } catch { continue; }
    check(`${rel} reads the study week through readStudyDays, not its own parse`, !readsStudyDays.test(src));
}
check('the control matches the shape that was there', readsStudyDays.test("JSON.parse(project.study_days || '[1,2,3,4,5]')"));

// ---- a window the loops can walk -------------------------------------------
// Every date list here is built a day at a time from dates a request supplied.
// A deadline in 99999 was 36 million iterations with the server blocked, so a
// window is refused at the door and the loop refuses one that got in before.
console.log('\n--- a window is bounded ---');
const { isScheduleDate, scheduleWindowError, countStudyDays, MAX_SCHEDULE_DAYS } = await import('../server/scheduling.js');
check('a real date is a date', isScheduleDate('2026-09-24') && isScheduleDate('2028-02-29'));
check('an impossible day is not', !isScheduleDate('2026-02-30') && !isScheduleDate('2027-02-29') && !isScheduleDate('2026-13-01'));
check('a five-digit year is not', !isScheduleDate('99999-01-01') && !isScheduleDate('+99999-01-01'));
check('a year outside 1900–2199 is not', !isScheduleDate('9999-12-31') && !isScheduleDate('2200-01-01') && !isScheduleDate('1899-12-31'));
check('only the YYYY-MM-DD shape is', !isScheduleDate('2026-9-24') && !isScheduleDate('2026-09-24T00:00') && !isScheduleDate(20260924) && !isScheduleDate(null));
check('a sane window has no error', scheduleWindowError('2026-01-01', '2026-06-30') === null);
check('an out-of-order window is refused', /before/.test(scheduleWindowError('2026-06-30', '2026-01-01') || ''));
check('a window past 20 years is refused', /20 years/.test(scheduleWindowError('2026-01-01', '2047-01-02') || ''));
check('...and 20 years exactly is not', scheduleWindowError('2026-01-01', '2046-01-01') === null);
let threw = false;
const t0 = Date.now();
try { getValidStudyDates('2026-01-01', '99999-01-01', WEEKDAYS); } catch (e) { threw = e instanceof RangeError; }
check('the loop refuses a stored far-future deadline instead of walking it', threw && Date.now() - t0 < 50, `${Date.now() - t0} ms`);
check('the pre-fix span would have been ~36M iterations (the control)', daysBetween('2026-01-01', '99999-01-01') > 35_000_000);
check('allocateSchedule answers a bad window with an error, not a throw',
    allocateSchedule(projectId, '2026-01-01', '99999-01-01', WEEKDAYS).success === false);
// The count the home page shows: arithmetic, and equal to walking the days.
let countsAgree = true;
for (const [a, b] of [['2026-01-01', '2026-01-01'], ['2026-01-01', '2026-01-07'], ['2026-03-02', '2026-11-19'], ['2024-02-26', '2024-03-04'], ['2026-01-05', '2027-12-31']]) {
    for (const days of [WEEKDAYS, [6, 7], [3], [1, 2, 3, 4, 5, 6, 7]]) {
        if (countStudyDays(a, b, days) !== getValidStudyDates(a, b, days).length) countsAgree = false;
    }
}
check('countStudyDays equals the walked list on every window tried', countsAgree);
const t1 = Date.now();
countStudyDays('2026-01-01', '2199-12-31', WEEKDAYS);
check('countStudyDays costs the same for 170 years as for one', Date.now() - t1 < 20, `${Date.now() - t1} ms`);
check('the cap is twenty years', MAX_SCHEDULE_DAYS >= 365 * 20 && MAX_SCHEDULE_DAYS < 365 * 21);

// ---- a schedule can be taken away, and set again ---------------------------
// The /schedule card had no way to remove a schedule at all, and the one that
// existed (the workspace dialog's route) also reset the study WEEK to Mon–Fri:
// setting the same two dates again then built a different plan. `removeSchedule`
// takes the window, every date the engine wrote and the baseline, and keeps the
// week — so the same dates give back the same plan, date for date.
console.log('\n--- a schedule can be removed, and set again ---');
const { removeSchedule, calculatePace, cardPlan } = await import('../server/scheduling.js');
const { projectProgress } = await import('../server/progress.js');
const rmId = Number(db.prepare(`INSERT INTO projects (name, study_days) VALUES ('removable', '[1,3,5]')`).run().lastInsertRowid);
const mkIn = (pid, title, parentId, position, extra = {}) => Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, position, is_note, role, status) VALUES (?, ?, ?, ?, 0, ?, ?)`
).run(pid, parentId, title, position, extra.role ?? 'topic', extra.status ?? 'not_started').lastInsertRowid);
for (let p = 0; p < 2; p++) {
    const ph = mkIn(rmId, `Part ${p + 1}`, null, p);
    for (let i = 0; i < 3; i++) mkIn(rmId, `Part ${p + 1} topic ${i + 1}`, ph, i);
}
const datedOf = (pid) => db.prepare(`SELECT id, scheduled_start, scheduled_end FROM nodes
    WHERE project_id = ? AND (scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL) ORDER BY id`).all(pid);
const planKey = (pid) => datedOf(pid).map(r => `${r.id}:${r.scheduled_start}:${r.scheduled_end}`).join('|');
const MWF = readStudyDays(db.prepare('SELECT study_days FROM projects WHERE id = ?').get(rmId).study_days);
const first = allocateSchedule(rmId, START, DEADLINE, MWF);
persistSchedule(rmId, first.assignments, first.baselineSnapshot, { startDate: START, deadline: DEADLINE, studyDays: MWF });
const planBefore = planKey(rmId);
const datedBefore = datedOf(rmId).length;
const removed = removeSchedule(rmId);
const rmRow = db.prepare('SELECT start_date, deadline, baseline_schedule, study_days FROM projects WHERE id = ?').get(rmId);
check('the window is gone', rmRow.start_date === null && rmRow.deadline === null);
check('the baseline recalibration measures against is gone', rmRow.baseline_schedule === null);
check('no node keeps a date — topics AND the parts derived above them', datedOf(rmId).length === 0, `${datedOf(rmId).length} left`);
check('it says how many nodes it cleared', removed.nodesCleared === datedBefore && datedBefore === 8,
    `${removed.nodesCleared} of ${datedBefore}`);
check('the study WEEK is kept', rmRow.study_days === '[1,3,5]', rmRow.study_days);
check('the pace has nothing to report afterwards', calculatePace(rmId).paceStatus === 'no_schedule');
const again = allocateSchedule(rmId, START, DEADLINE, readStudyDays(rmRow.study_days));
persistSchedule(rmId, again.assignments, again.baselineSnapshot, { startDate: START, deadline: DEADLINE, studyDays: readStudyDays(rmRow.study_days) });
check('setting the same two dates again gives back the same plan, date for date', planKey(rmId) === planBefore);
// The control: the statement the route ran before. It resets the week, and the
// same two dates then lay the plan out on Mon–Fri — a different plan.
db.prepare(`UPDATE projects SET start_date = NULL, deadline = NULL, study_days = '[1,2,3,4,5]', baseline_schedule = NULL WHERE id = ?`).run(rmId);
const lostWeek = readStudyDays(db.prepare('SELECT study_days FROM projects WHERE id = ?').get(rmId).study_days);
const control = allocateSchedule(rmId, START, DEADLINE, lostWeek);
persistSchedule(rmId, control.assignments, control.baselineSnapshot, { startDate: START, deadline: DEADLINE, studyDays: lostWeek });
check('control: the old statement lost the week, and the same dates then built a different plan', planKey(rmId) !== planBefore);
const indexSrc = (await import('./lib/serverSource.mjs')).httpLayer();
check('DELETE /api/projects/:id/schedule goes through removeSchedule',
    /app\.delete\('\/api\/projects\/:id\/schedule'[\s\S]{0,400}?removeSchedule\(id\)/.test(indexSrc));
const OLD_RESET = /study_days = '\[1,2,3,4,5\]', baseline_schedule = NULL/;
check('…and no route resets the study week when it removes a schedule', !OLD_RESET.test(indexSrc));
check('the control matches the statement that was there', OLD_RESET.test("UPDATE projects SET start_date = NULL, deadline = NULL, study_days = '[1,2,3,4,5]', baseline_schedule = NULL, updated_at"));

// ---- a project measured in cards is scheduled as a window -----------------
// Kaishi 1.5k's shape: a root and thirty stages cut out of card order, no topic.
// `allocateSchedule` answered "Add topics first", `calculatePace` answered
// `no_tasks` with 0% — so the /schedule card drew an empty bar and "Not started"
// beside 116 cards met, and the workspace chip read "0d". Its plan is a line:
// cards met at an even rate over the window's study days.
console.log('\n--- a project measured in cards is scheduled as a window ---');
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const TODAY = iso(new Date());
const WIN_START = addDays(TODAY, -10), WIN_END = addDays(TODAY, 29); // 40 days, today is the 11th
const deckId = Number(db.prepare(`INSERT INTO projects (name, kind) VALUES ('stages', 'deck')`).run().lastInsertRowid);
const deckRoot = mkIn(deckId, 'stages', null, 0);
const addCards = (nodeId, total, met) => {
    for (let i = 0; i < total; i++) {
        db.prepare(`INSERT INTO flashcards (node_id, front, back, review_count, last_reviewed) VALUES (?, 'q', 'a', ?, ?)`)
            .run(nodeId, i < met ? 1 : 0, i < met ? new Date().toISOString() : null);
    }
};
const stageIds = [10, 4, 0, 0].map((met, i) => {
    const id = mkIn(deckId, `Stage ${i + 1}`, deckRoot, i, { role: 'pagination' });
    addCards(id, 10, met);
    return id;
});
const cardAlloc = allocateSchedule(deckId, WIN_START, WIN_END, EVERY_DAY);
check('it schedules — it used to answer "Add topics first"', cardAlloc.success === true, cardAlloc.error || '');
check('…and dates no node: a stage is never scheduled', cardAlloc.success && cardAlloc.assignments.size === 0);
// Written the way the board writes a window with no topic to move (a PUT of the
// two dates), so what follows measures PACE whatever the allocator said.
if (cardAlloc.success) {
    persistSchedule(deckId, cardAlloc.assignments, cardAlloc.baselineSnapshot, { startDate: WIN_START, deadline: WIN_END, studyDays: EVERY_DAY });
}
db.prepare('UPDATE projects SET start_date = ?, deadline = ?, study_days = ? WHERE id = ?')
    .run(WIN_START, WIN_END, JSON.stringify(EVERY_DAY), deckId);
const deckPace = calculatePace(deckId);
check('its pace is counted in cards, not "no tasks"', deckPace.basis === 'cards' && deckPace.paceStatus !== 'no_tasks',
    `${deckPace.basis} / ${deckPace.paceStatus}`);
check('actual is cards met, the grid ring\'s own number (14 of 40)',
    deckPace.actualProgress === 35 && deckPace.actualProgress === Math.round(projectProgress(deckId).fraction * 100),
    String(deckPace.actualProgress));
check('expected is the share of the window\'s study days gone BEFORE today (10 of 40)',
    deckPace.expectedProgress === Math.round((countStudyDays(WIN_START, addDays(TODAY, -1), EVERY_DAY) / countStudyDays(WIN_START, WIN_END, EVERY_DAY)) * 100)
    && deckPace.expectedProgress === 25, String(deckPace.expectedProgress));
check('35% done against 25% expected is ahead', deckPace.paceStatus === 'ahead', deckPace.paceStatus);
{
    // …and a deck window made today expects nothing yet.
    db.prepare('UPDATE projects SET start_date = ?, deadline = ? WHERE id = ?').run(TODAY, addDays(TODAY, 4), deckId);
    const firstDay = calculatePace(deckId);
    check('a deck window made today is not behind on its first day', firstDay.expectedProgress === 0 && firstDay.paceStatus !== 'critical' && firstDay.paceStatus !== 'falling_behind',
        `${firstDay.expectedProgress} ${firstDay.paceStatus} ${firstDay.message}`);
    db.prepare('UPDATE projects SET start_date = ?, deadline = ? WHERE id = ?').run(WIN_START, WIN_END, deckId);
}
check('recalibrating refuses: there are no topics to move', recalibrateSchedule(deckId).success === false);
const sections = cardPlan(deckId);
check('its sections are placed on the plan, in deck order',
    Array.isArray(sections) && sections.map(s => s.nodeId).join() === stageIds.join());
check('each holds a quarter of the cards and gets a quarter of the days',
    sections?.every((s, i) => s.start === addDays(WIN_START, 10 * i) && s.end === addDays(WIN_START, 10 * i + 9)),
    JSON.stringify(sections?.map(s => [s.start, s.end])));
check('the section today falls in is the one the notch is in (Stage 2)',
    sections?.[1].start <= TODAY && TODAY <= sections?.[1].end);
check('it carries each section\'s cards met', sections?.map(s => s.seen).join() === '10,4,0,0');
check('a course has no card plan', cardPlan(projectId) === null);

// The Frequency Dictionary's shape: sections its author NAMED (topics), nothing
// teaching them. Still measured in cards, so still a window and nothing else —
// and a date one of them carried from before is cleared.
const namedId = Number(db.prepare(`INSERT INTO projects (name, kind) VALUES ('named', 'deck')`).run().lastInsertRowid);
const namedRoot = mkIn(namedId, 'named', null, 0);
const secA = mkIn(namedId, 'Core', namedRoot, 0);
const secB = mkIn(namedId, 'Spoken', namedRoot, 1);
addCards(secA, 30, 6);
addCards(secB, 10, 10);
db.prepare('UPDATE nodes SET scheduled_start = ?, scheduled_end = ? WHERE id = ?').run(WIN_START, WIN_START, secB);
const namedAlloc = allocateSchedule(namedId, WIN_START, WIN_END, EVERY_DAY);
if (namedAlloc.success) {
    persistSchedule(namedId, namedAlloc.assignments, namedAlloc.baselineSnapshot, { startDate: WIN_START, deadline: WIN_END, studyDays: EVERY_DAY });
}
check('named sections of a deck nobody teaches are not dated either', namedAlloc.success && namedAlloc.assignments.size === 0);
check('…and the date one of them carried is cleared', datedOf(namedId).length === 0);
const namedPace = calculatePace(namedId);
check('its pace reads cards met across the sections (16 of 40)', namedPace.basis === 'cards' && namedPace.actualProgress === 40,
    `${namedPace.basis} ${namedPace.actualProgress}`);

// A course is untouched: expected is still leaves whose plan ended before today.
const coursePace = calculatePace(projectId);
const courseLeaves = db.prepare(`SELECT scheduled_end FROM nodes n WHERE project_id = ? AND is_note = 0
    AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id AND c.is_note = 0)`).all(projectId);
const endedByToday = courseLeaves.filter(l => l.scheduled_end && l.scheduled_end < TODAY).length;
check('a course keeps its topic basis, the same count as before',
    coursePace.basis === 'topics' && coursePace.expectedProgress === Math.round((endedByToday / courseLeaves.length) * 100),
    `${coursePace.basis} ${coursePace.expectedProgress}`);
removeSchedule(deckId);
check('a deck whose window is removed has no plan and no pace', cardPlan(deckId) === null
    && calculatePace(deckId).paceStatus === 'no_schedule');

// A plan made today is on track today. Counting the topics due TODAY as
// expected told every new short plan "1 day behind — consider recalibrating"
// (critical, in red) before there had been a chance to study.
const freshId = Number(db.prepare("INSERT INTO projects (name) VALUES ('Made today')").run().lastInsertRowid);
const freshRoot = mkIn(freshId, 'Week one', null, 0);
for (let i = 0; i < 6; i++) mkIn(freshId, `Day ${i + 1}`, freshRoot, i);
const freshAlloc = allocateSchedule(freshId, TODAY, addDays(TODAY, 2), EVERY_DAY);
persistSchedule(freshId, freshAlloc.assignments, freshAlloc.baselineSnapshot, { startDate: TODAY, deadline: addDays(TODAY, 2), studyDays: EVERY_DAY });
const dueToday = db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE project_id = ? AND scheduled_end = ?').get(freshId, TODAY).n;
const freshPace = calculatePace(freshId);
check(`control: the new plan has work due today (${dueToday} rows)`, dueToday > 0);
check('a plan made today is on track on its first day, with nothing expected yet',
    freshPace.paceStatus === 'on_track' && freshPace.expectedProgress === 0, `${freshPace.paceStatus} ${freshPace.expectedProgress} ${freshPace.message}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
