// tools/capacity-gates.mjs — checks one capacity is shared across the whole
// library (shareCapacity in server/paceModel.js, server/capacity.js) and that
// the feed, the feed header's deadline chip, the schedule overview and the
// pause routes all read it.
//
// Run:  node tools/capacity-gates.mjs
//
// Deterministic, no model, no network. Two halves:
//   1. The pure share over hand-built verdicts: nearest date first, a tight or
//      out-of-reach course takes the week, capacity running out, paused,
//      undated and finished courses, the two units, a learner with no pace yet.
//   2. A scratch library: a learner who closes 3 topics a week, an exam in 17
//      days that needs 8 a week, a small course due in 10 days, a 0% course due
//      in 300 days and an undated one. The far courses must get no new work
//      (the old urgency score served them all), the chip names the exam by its
//      verdict, and pausing works as one press.
//
// The clock is a parameter: every date derives from NOW; the handlers and the
// chip read Date.now(), which is pinned to NOW while they run.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'capacity-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const show = (v) => JSON.stringify(v);

const NOW = new Date(`${(process.env.CAPACITY_GATES_NOW || '2026-06-10').slice(0, 10)}T12:00:00.000Z`);
const NOW_MS = NOW.getTime();
const DAY_MS = 86_400_000;
const TODAY = NOW.toISOString().slice(0, 10);
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const dayStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const ago = (n) => dayStr(dayNum(TODAY) - n);
const ahead = (n) => dayStr(dayNum(TODAY) + n);

// ===========================================================================
console.log('\n--- pure: one week shared nearest date first ---');
const model = await import('../server/paceModel.js');
const share = model.shareCapacity;
check('the pace model exports shareCapacity', typeof share === 'function', `got ${typeof share}`);
if (typeof share === 'function') {
    const c = (id, band, needed, days, extra = {}) => ({ id, unit: 'topics', band, needed, deadline: days == null ? null : ahead(days), ...extra });

    // Root cause 6: a 0% course due next year outranked an exam in 17 days.
    const r6 = share([c('far', 'on_pace', 0.7, 300), c('exam', 'out_of_reach', 8.2, 17)], { topics: 3 });
    check('the exam in 17 days is served before the course due in 300', show(r6.order) === show(['exam']), show(r6.order));
    check('…an out-of-reach course takes the whole week', r6.courses.get('exam').share === 3 && r6.units.topics.crowdedBy === 'exam', show(r6.courses.get('exam')));
    check('…and the far course waits with nothing', r6.courses.get('far').status === 'waiting' && r6.courses.get('far').share === 0, show(r6.courses.get('far')));

    const fits = share([c('b', 'under_pace', 1, 60), c('a', 'on_pace', 1.5, 20)], { topics: 3 });
    check('two that fit are both served, nearest first', show(fits.order) === show(['a', 'b']), show(fits.order));
    check('…each gets the pace its date needs', fits.courses.get('a').share === 1.5 && fits.courses.get('b').share === 1, show([...fits.courses]));
    check('…and the week is 2.5 of 3 claimed', fits.units.topics.claimed === 2.5, show(fits.units));

    const out = share([c('a', 'on_pace', 2, 10), c('b', 'under_pace', 1.5, 30), c('c', 'on_pace', 0.2, 90)], { topics: 3 });
    check('when the week runs out the next course is short and gets the rest',
        out.courses.get('b').status === 'short' && out.courses.get('b').share === 1, show(out.courses.get('b')));
    check('…and everything later waits', out.courses.get('c').status === 'waiting' && show(out.order) === show(['a', 'b']), show(out.order));

    const tight = share([c('t', 'tight', 2, 14), c('later', 'on_pace', 0.1, 200)], { topics: 3 });
    check('a tight course crowds out a later one even with room left', tight.courses.get('later').status === 'waiting', show(tight.courses.get('later')));

    const mixed = share([
        c('u', 'no_date', null, null), c('p', 'out_of_reach', 9, 5, { paused: true }),
        c('d', 'done', 0, 40), c('x', 'passed', 4, -3), c('n', 'on_pace', 1, 30),
    ], { topics: 3 });
    check('a paused course is left out, even out of reach', mixed.courses.get('p').status === 'paused' && !mixed.order.includes('p'), show(mixed.courses.get('p')));
    check('a finished course has nothing to serve', mixed.courses.get('d').status === 'done' && !mixed.order.includes('d'));
    check('undated and gone-by courses come after the dated ones, in the order given', show(mixed.order) === show(['n', 'u', 'x']), show(mixed.order));
    check('…with what is left of the week', mixed.courses.get('u').share === 2 && mixed.courses.get('x').status === 'passed', show([...mixed.courses]));

    const crowdedUndated = share([c('u', 'no_date', null, null), c('e', 'out_of_reach', 9, 5)], { topics: 3 });
    check('an undated course waits while a dated one cannot be met', crowdedUndated.courses.get('u').status === 'waiting', show(crowdedUndated.courses.get('u')));

    const units = share([c('e', 'out_of_reach', 9, 5), { id: 'deck', unit: 'cards', band: 'on_pace', needed: 20, deadline: ahead(50) }], { topics: 3, cards: 60 });
    check('cards and topics are shared apart: a crowded topic week leaves the deck served',
        units.courses.get('deck').status === 'served' && units.courses.get('deck').share === 20, show(units.courses.get('deck')));

    const early = share([c('far', 'learning', 0.3, 300), c('exam', 'learning', 9, 17)], {});
    check('with no pace yet nothing is rationed: both served, nearest first',
        show(early.order) === show(['exam', 'far']) && early.units.topics.capacity === null, show(early));

    const tie = share([c(12, 'on_pace', 0.5, 30), c(3, 'on_pace', 0.5, 30)], { topics: 3 });
    check('two courses due the same day are served in id order', show(tie.order) === show([3, 12]), show(tie.order));
    check('shareCapacity reads no clock', !/Date\.now|new Date\(\)/.test(share.toString()));
}

// ===========================================================================
console.log('\n--- library: the feed, the chip, the overview, pausing ---');
const db = (await import('../server/database.js')).default;
const iso = (ms) => new Date(ms).toISOString();
const sqlTime = (ms) => iso(ms).replace('T', ' ').slice(0, 19);
let position = 0;
const mkProject = (name, { deadline = null, start = null, status = 'active' } = {}) =>
    Number(db.prepare(`INSERT INTO projects (name, kind, deadline, start_date, status, position, created_at) VALUES (?, 'curriculum', ?, ?, ?, ?, ?)`)
        .run(name, deadline, start, status, position++, sqlTime(NOW_MS - 200 * DAY_MS)).lastInsertRowid);
const mkTopic = (projectId, title, { status = 'not_started', completedAt = null } = {}) => Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, is_note, role, status, completed_at) VALUES (?, NULL, ?, 0, 'topic', ?, ?)`
).run(projectId, title, status, completedAt).lastInsertRowid);
const topics = (projectId, n, label) => { for (let i = 0; i < n; i++) mkTopic(projectId, `${label} ${i + 1}`); };

// The learner: 3 topics closed a week for the last 8 weeks (a finished course).
const history = mkProject('History', { status: 'completed' });
for (let w = 0; w < 8; w++) for (let k = 0; k < 3; k++) {
    mkTopic(history, `closed ${w}-${k}`, { status: 'completed', completedAt: iso((dayNum(ago(7 * w + 2 + k)) * DAY_MS) + 12 * 3600_000) });
}
// First in the list, so the old order (by position, then urgency) met it first.
const far = mkProject('Due next year', { deadline: ahead(300), start: ago(10) });
topics(far, 30, 'far');
const undated = mkProject('No date');
topics(undated, 5, 'undated');
const exam = mkProject('Exam in 17 days', { deadline: ahead(17), start: ago(10) });
topics(exam, 20, 'exam');
const small = mkProject('Small, due in 10', { deadline: ahead(10), start: ago(10) });
topics(small, 1, 'small');

const { getFocusNodes, buildFeedHeader } = await import('../server/feed.js');
const focusProjects = (opts = {}) => getFocusNodes({ maxTotal: 12, maxPerProject: 4, now: NOW_MS, ...opts }).focus.map(f => f.projectId);

const realNow = Date.now;
Date.now = () => NOW_MS;
const { createApp } = await import('../server/app.js');
const srv = createServer(createApp());
const port = await new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method, headers: { 'Content-Type': 'application/json', 'X-Time-Zone': 'UTC' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* no body */ }
    return { status: r.status, json };
};
const overviewRow = async (id) => (await call('GET', '/api/schedule/overview')).json?.projects?.find(p => p.id === id);

try {
    const served = focusProjects();
    check('the feed serves the exam', served.includes(exam), show(served));
    check('…and the small course due in 10 days, first', served[0] === small, show(served));
    check('…and nothing from the course due in 300 days while the exam is out of reach', !served.includes(far), show(served));
    check('…nor from the undated course', !served.includes(undated), show(served));

    const header = buildFeedHeader();
    check('the deadline chip names the exam (out of reach), not the nearer course on pace',
        header.deadline?.projectId === exam, show(header.deadline));
    check('…by its verdict', header.deadline?.band === 'out_of_reach' && header.deadline?.paceStatus === 'critical', show(header.deadline));
    check('…and prints no "days behind"', header.deadline?.daysBehind === 0, show(header.deadline));

    const rowFar = await overviewRow(far);
    const rowExam = await overviewRow(exam);
    const rowSmall = await overviewRow(small);
    check('the overview says the far course is waiting', rowFar?.capacity?.status === 'waiting', show(rowFar?.capacity));
    check('…the exam is served second and takes the rest of the week',
        rowExam?.capacity?.status === 'served' && rowExam?.capacity?.rank === 1 && rowExam.capacity.share > 0, show(rowExam?.capacity));
    check('…the small course is served first', rowSmall?.capacity?.rank === 0, show(rowSmall?.capacity));
    check('…and the exam\'s verdict still offers to pause the others', (rowExam?.verdict?.offers || []).some(o => o.kind === 'pause_others'), show(rowExam?.verdict?.offers));

    const bad = await call('PUT', `/api/projects/${exam}`, { paused: 'yes' });
    check('pausing takes true or false only', bad.status === 400, show(bad));

    const press = await call('POST', `/api/projects/${exam}/pause-others`);
    check('"Pause the other courses" is one press', press.status === 200, show(press));
    check('…it pauses every other active course, not the exam, not a finished one',
        show([...(press.json?.paused || [])].sort((a, b) => a - b)) === show([far, undated, small].sort((a, b) => a - b)), show(press.json));
    const after = focusProjects();
    check('…after it the feed serves only the exam', after.length > 0 && after.every(id => id === exam), show(after));
    const rowExam2 = await overviewRow(exam);
    check('…the exam\'s verdict no longer counts paused courses as competing', rowExam2?.verdict?.otherCourses === 0, show(rowExam2?.verdict?.otherCourses));
    check('…so it no longer offers to pause them', !(rowExam2?.verdict?.offers || []).some(o => o.kind === 'pause_others'), show(rowExam2?.verdict?.offers));
    check('…a paused course says so in the overview', (await overviewRow(small))?.capacity?.status === 'paused');
    check('a paused course\'s own Study stream still serves it', focusProjects({ projectId: small }).includes(small));
    const noMissing = await call('POST', '/api/projects/999999/pause-others');
    check('pausing others from a course that does not exist is a 404', noMissing.status === 404, show(noMissing));

    const resume = await call('PUT', `/api/projects/${small}`, { paused: false });
    check('a course is resumed with paused: false', resume.status === 200 && resume.json?.paused === 0, show(resume.json?.paused));
    check('…and read back on the project', (await call('GET', `/api/projects/${small}`)).json?.paused === 0);
    check('…and the feed serves it again', focusProjects().includes(small), show(focusProjects()));
    const chip2 = buildFeedHeader().deadline;
    check('the chip leaves a paused course out', chip2?.projectId === exam || chip2?.projectId === small, show(chip2));
    db.prepare('UPDATE projects SET paused = 1 WHERE id = ?').run(exam);
    check('…a paused exam is not the chip', buildFeedHeader().deadline?.projectId === small, show(buildFeedHeader().deadline));
} catch (err) {
    check('the library half ran to the end', false, err?.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
    Date.now = realNow;
    srv.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
