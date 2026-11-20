// tools/topic-dates-gates.mjs — topic dates are derived when read, never stored.
//
// A course with a window has no topic dates of its own: `layTopicDates`
// (server/scheduling.js) lays them from the record, the window and the study
// week, and every reader selects them from the TEMP view `plan_nodes`
// (server/topicDates.js). Checks: closed topics sit on their completion day,
// open topics never fall before today (so a missed week makes nothing
// overdue), finishing today's topic does not pull tomorrow's forward, nothing
// writes a topic date, a project without a window keeps the dates its rows
// carry, a card course is left to `cardPlan`, the cache follows writes from
// this connection and from another one, and the readers (Today, daily plan,
// focus) see the derived dates.
//
// Deterministic, no model, no network: a scratch database, every date relative
// to a pinned day. Last line `N passed, M failed`.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// A server zone west of UTC, so a completion time read as local time instead
// of UTC lands on the wrong day here on every machine.
process.env.TZ = 'America/New_York';
const scratch = mkdtempSync(join(tmpdir(), 'topic-dates-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const db = (await import('../server/database.js')).default;
const { layTopicDates, persistSchedule, allocateSchedule, calculatePace, removeSchedule } = await import('../server/scheduling.js');
const { setProjectTeaches } = await import('../server/nodeRole.js');
const { refreshTopicDates, topicDatesOf } = await import('../server/topicDates.js');
const { buildTodayData } = await import('../server/today.js');
const { generateDailyPlan } = await import('../server/dailyPlan.js');

let passed = 0, failed = 0;
const check = (label, cond, extra = '') => {
    if (cond) passed++;
    else { failed++; console.log(`FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

const TZ = 'UTC';
const DAY0 = '2026-03-02'; // a Monday
const add = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const opts = (today) => ({ today, timeZone: TZ });
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

const mkProject = (name, start, deadline, days = EVERY_DAY) => Number(db.prepare(
    'INSERT INTO projects (name, start_date, deadline, study_days) VALUES (?, ?, ?, ?)',
).run(name, start, deadline, start ? JSON.stringify(days) : null).lastInsertRowid);
const insNode = db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, position, status, completed_at, is_note, scheduled_start, scheduled_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const mkNode = (pid, title, pos, { parent = null, status = 'not_started', done = null, note = 0, s = null, e = null } = {}) =>
    Number(insNode.run(pid, parent, title, pos, status, done, note, s, e).lastInsertRowid);
const stored = (id) => db.prepare('SELECT scheduled_start AS s, scheduled_end AS e FROM nodes WHERE id = ?').get(id);
const complete = (id, day) => db.prepare("UPDATE nodes SET status = 'completed', completed_at = ? WHERE id = ?").run(`${day}T10:00:00.000Z`, id);

// 1. A course under way: two topics closed in week one, eight open, a 30-day
//    window that started a week before "today", and stale stored dates that
//    a written plan would have left behind (all in the past).
const today = add(DAY0, 7);
const pid = mkProject('Under way', DAY0, add(DAY0, 30));
const phase = mkNode(pid, 'Phase', 0);
const topics = [];
for (let i = 0; i < 10; i++) {
    const closed = i < 2;
    topics.push(mkNode(pid, `T${i}`, i, {
        parent: phase, status: closed ? 'completed' : 'not_started',
        done: closed ? `${add(DAY0, 1 + i)}T09:30:00.000Z` : null, s: add(DAY0, i), e: add(DAY0, i),
    }));
}
const note = mkNode(pid, 'A note', 99, { parent: phase, note: 1 });

const d1 = topicDatesOf(pid, opts(today));
check('a closed topic sits on its completion day', d1.get(topics[0])?.start === add(DAY0, 1) && d1.get(topics[1])?.end === add(DAY0, 2),
    JSON.stringify([d1.get(topics[0]), d1.get(topics[1])]));
const openDates = topics.slice(2).map(id => d1.get(id));
check('every open topic is dated', openDates.every(Boolean));
check('no open topic starts before today', openDates.every(d => d.start >= today), JSON.stringify(openDates));
check('the open topics end on or before the deadline', openDates.every(d => d.end <= add(DAY0, 30)));
check('the first open topic starts today', openDates[0].start === today);
check('open topics keep course order', openDates.every((d, i) => i === 0 || d.start >= openDates[i - 1].start));
check('a parent spans its children', d1.get(phase)?.start === add(DAY0, 1) && d1.get(phase)?.end === openDates.at(-1).end,
    JSON.stringify(d1.get(phase)));
check('a note is never dated', !d1.has(note));
check('the stale stored dates are untouched and unread', stored(topics[5]).s === add(DAY0, 5) && d1.get(topics[5]).start !== add(DAY0, 5));

// 2. A missed week: nothing studied, the day moves on. Nothing is overdue.
const later = add(today, 7);
const d2 = topicDatesOf(pid, opts(later));
check('after a missed week no open topic is before the new today', topics.slice(2).every(id => d2.get(id).start >= later));
const overdueRows = (day) => {
    refreshTopicDates(opts(day));
    return db.prepare(`SELECT COUNT(*) AS c FROM plan_nodes WHERE project_id = ? AND is_note = 0
        AND COALESCE(status, 'not_started') NOT IN ('completed', 'skipped') AND scheduled_end < ?`).get(pid, day).c;
};
check('plan_nodes holds no overdue topic after a missed week', overdueRows(later) === 0);
check('the raw rows would have called it overdue', db.prepare(`SELECT COUNT(*) AS c FROM nodes WHERE project_id = ?
    AND status = 'not_started' AND scheduled_end < ?`).get(pid, later).c > 0);

// 3. Finishing today's topic does not pull the next one into today.
const before = topicDatesOf(pid, opts(today));
complete(topics[2], today);
const after = topicDatesOf(pid, opts(today));
check('a topic completed today is dated today', after.get(topics[2])?.start === today && after.get(topics[2])?.end === today);
check('the next topic keeps its dates after today\'s is done', JSON.stringify(after.get(topics[3])) === JSON.stringify(before.get(topics[3])),
    `${JSON.stringify(before.get(topics[3]))} -> ${JSON.stringify(after.get(topics[3]))}`);
check('the cache followed the write (trigger on nodes)', after.get(topics[2]).start === today && before.get(topics[2]).start !== undefined);

// 4. A new topic added to the course is dated on the next read.
const added = mkNode(pid, 'T-new', 50, { parent: phase });
check('a topic inserted after a read is dated on the next read', !!topicDatesOf(pid, opts(today)).get(added));

// 5. Nothing writes a topic date: a full schedule save leaves the rows alone.
const fresh = mkProject('Fresh', null, null);
const fa = mkNode(fresh, 'A', 0), fb = mkNode(fresh, 'B', 1);
const alloc = allocateSchedule(fresh, today, add(today, 9), EVERY_DAY);
persistSchedule(fresh, alloc.assignments, alloc.baselineSnapshot, { startDate: today, deadline: add(today, 9), studyDays: EVERY_DAY });
check('saving a window writes no topic date', stored(fa).s === null && stored(fb).e === null);
const fd = topicDatesOf(fresh, opts(today));
check('the saved window is laid on read', fd.get(fa)?.start === today && fd.get(fb)?.end === add(today, 9), JSON.stringify([...fd]));
check('the window row was written', db.prepare('SELECT deadline FROM projects WHERE id = ?').get(fresh).deadline === add(today, 9));

// 6. A window that starts in the future is laid from its own start.
const future = mkProject('Future', add(today, 10), add(today, 20));
const fu = mkNode(future, 'F', 0);
check('a future window starts its first topic on its start', topicDatesOf(future, opts(today)).get(fu)?.start === add(today, 10));

// 7. After the deadline open topics are undated (the verdict says "passed").
const past = mkProject('Past', add(today, -30), add(today, -1));
const pa = mkNode(past, 'P', 0, { s: add(today, -20), e: add(today, -20) });
const pastDates = topicDatesOf(past, opts(today));
check('after the deadline an open topic is undated, not overdue', !pastDates.has(pa) && overdueRowsOf(past) === 0);
function overdueRowsOf(id) {
    return db.prepare(`SELECT COUNT(*) AS c FROM plan_nodes WHERE project_id = ? AND scheduled_end < ?
        AND COALESCE(status, 'not_started') NOT IN ('completed', 'skipped')`).get(id, today).c;
}

// 8. A project with no window keeps whatever dates its rows carry.
const loose = mkProject('No window', null, null);
const lo = mkNode(loose, 'L', 0, { s: add(today, 2), e: add(today, 3) });
check('a project without a window is not derived', layTopicDates(loose, today, TZ) === null);
check('its stored dates still reach plan_nodes', JSON.stringify(topicDatesOf(loose, opts(today)).get(lo)) === JSON.stringify({ start: add(today, 2), end: add(today, 3) }));

// 9. A course measured in cards is left to cardPlan.
const deck = mkProject('Deck', today, add(today, 20));
const sec = mkNode(deck, 'Cards', 0);
// A stage cut from a deck's card order is not a topic: the course holds cards only.
db.prepare("UPDATE nodes SET role = 'pagination' WHERE id = ?").run(sec);
db.prepare("INSERT INTO flashcards (node_id, front, back) VALUES (?, 'q', 'a')").run(sec);
check('a card course derives no topic dates', layTopicDates(deck, today, TZ)?.size === 0 && !topicDatesOf(deck, opts(today)).has(sec));

// 10. A write from ANOTHER connection (another process on the same library)
//     reaches the cache through data_version.
const other = new Database(process.env.DB_PATH);
topicDatesOf(pid, opts(today));
other.prepare("UPDATE nodes SET status = 'completed', completed_at = ? WHERE id = ?").run(`${today}T11:00:00.000Z`, topics[3]);
other.close();
check('a write by another connection is seen on the next read', topicDatesOf(pid, opts(today)).get(topics[3])?.end === today);

// 11. A changed window moves every open topic on the next read.
db.prepare('UPDATE projects SET deadline = ? WHERE id = ?').run(add(DAY0, 60), pid);
const moved = topicDatesOf(pid, opts(today));
check('a later deadline spreads the open topics further', moved.get(topics.at(-1)).end > openDates.at(-1).end);

// 12. The readers see the derived dates.
// Topics finished today take today's share, so the day after a finished day
// is checked from the next morning: the first open topic starts that day.
const morning = add(today, 1);
const home = buildTodayData({ today: morning }).projects;
const homeOf = (id) => home.find(p => p.id === id);
const firstOpen = homeOf(pid)?.todayTasks.find(t => t.id === topics[4]);
const pastTasks = [...(homeOf(past)?.todayTasks ?? []), ...(homeOf(past)?.overdueTasks ?? [])];
check('Today lists the derived day\'s topic', firstOpen?.scheduled_start === morning && !!homeOf(past) && !pastTasks.some(t => t.id === pa),
    JSON.stringify(homeOf(pid)?.todayTasks.map(t => [t.id, t.scheduled_start])));
const plan = generateDailyPlan(pid, 14, later);
check('the daily plan lists no overdue topic after a missed week', plan.overdueTasks.length === 0, JSON.stringify(plan.overdueTasks));
check('the daily plan has today\'s topic', plan.todayTasks.length > 0);
const pace = calculatePace(pid, opts(later));
// The feed's focus list on a requested day: the pace it reads on the way must
// not re-lay the shared plan for the real today under its queries (the real
// today is months after this course's deadline, so nothing would be due).
const { getFocusNodes } = await import('../server/feed.js');
const focusInfo = getFocusNodes({ projectId: pid, now: Date.parse(`${later}T12:00:00Z`) })
    .projectInfos.find(i => i.project.id === pid);
check('the feed\'s focus on a requested day keeps that day\'s topics', focusInfo?.todays.length > 0,
    JSON.stringify(focusInfo?.todays));
check('the old pace readout counts nothing overdue from stale rows', pace.hasSchedule && pace.paceStatus !== 'critical', JSON.stringify(pace));

// 13. SQLite's own timestamp shape has no zone and is UTC: 22:30 on 9 March
//     is still 9 March in UTC (read as New York time it would be the 10th).
const sq = mkProject('SQLite time', add(DAY0, 0), add(DAY0, 30));
const sqTopic = mkNode(sq, 'S', 0, { status: 'completed', done: '2026-03-09 22:30:00' });
check('a completion time with no zone is read as UTC', layTopicDates(sq, add(DAY0, 10), 'UTC').get(sqTopic)?.start === '2026-03-09',
    JSON.stringify(layTopicDates(sq, add(DAY0, 10), 'UTC').get(sqTopic)));
check('...and placed in the learner\'s zone', layTopicDates(sq, add(DAY0, 10), 'Pacific/Auckland').get(sqTopic)?.start === '2026-03-10');

// 14. Turning teaching off makes a course with cards count in cards: the cache
//     follows the settings row (no write to nodes or projects).
const teach = mkProject('Teaching', today, add(today, 20));
const teachTopic = mkNode(teach, 'Teach me', 0);
db.prepare("INSERT INTO flashcards (node_id, front, back) VALUES (?, 'q', 'a')").run(teachTopic);
check('a teaching course with cards is dated', topicDatesOf(teach, opts(today)).has(teachTopic));
setProjectTeaches(teach, false);
check('turning teaching off is seen on the next read', !topicDatesOf(teach, opts(today)).has(teachTopic));

// 15. removeSchedule still clears the dates an old plan left on the rows.
const legacy = mkProject('Legacy rows', today, add(today, 20));
const legacyTopic = mkNode(legacy, 'Old', 0, { s: add(today, -9), e: add(today, -8) });
removeSchedule(legacy);
check('removing a window clears the dates an old plan stored', stored(legacyTopic).s === null && stored(legacyTopic).e === null);

// 16. A closed topic with no completion time (a skipped one, an imported
//     completed row) stays dated: on the end its row carries, else on the day
//     its row last changed. It never drops off the Timeline or out of its
//     parent's span.
const sk = mkProject('Skipped', DAY0, add(DAY0, 30));
const skPhase = mkNode(sk, 'Phase', 0);
const skKept = mkNode(sk, 'Skipped with a date', 0, { parent: skPhase, status: 'skipped', s: add(DAY0, -3), e: add(DAY0, -3) });
const skBare = mkNode(sk, 'Imported, no dates', 1, { parent: skPhase, status: 'completed' });
db.prepare('UPDATE nodes SET updated_at = ? WHERE id = ?').run(`${add(DAY0, 2)} 08:00:00`, skBare);
mkNode(sk, 'Open', 2, { parent: skPhase });
const skDates = topicDatesOf(sk, opts(today));
check('a skipped topic with no completion time keeps its row\'s end date', skDates.get(skKept)?.end === add(DAY0, -3), JSON.stringify(skDates.get(skKept)));
check('a closed topic with no dates at all sits on the day its row last changed', skDates.get(skBare)?.end === add(DAY0, 2), JSON.stringify(skDates.get(skBare)));
check('...and its parent spans it', skDates.get(skPhase)?.start === add(DAY0, -3));

// 17. One project whose layout throws: the others are still laid, its rows
//     read as stored, and no reader throws.
const brokenStored = mkNode(sk, 'Stored on the broken one', 3, { parent: skPhase, s: add(DAY0, 40), e: add(DAY0, 41) });
const broke = (id, ...rest) => { if (id === sk) throw new Error('gate: layout failed'); return layTopicDates(id, ...rest); };
const realError = console.error;
console.error = () => {};
let threw = null;
try { refreshTopicDates({ today: add(today, 1), timeZone: TZ, lay: broke }); } catch (err) { threw = err; } finally { console.error = realError; }
check('a project whose layout throws does not throw the read', threw === null, String(threw));
const otherRow = db.prepare('SELECT scheduled_start AS s FROM plan_nodes WHERE id = ?').get(topics[4]);
check('...every other project is still laid', otherRow?.s >= add(today, 1), JSON.stringify(otherRow));
const brokenRow = db.prepare('SELECT scheduled_start AS s FROM plan_nodes WHERE id = ?').get(brokenStored);
check('...and the broken one reads its stored dates', brokenRow?.s === add(DAY0, 40), JSON.stringify(brokenRow));

// 18. An answer moves the plan only through a head start: a mastery update on
//     a row with no seed marks nothing stale; one on a seeded row does.
let laid = 0;
const counting = (...a) => { laid++; return layTopicDates(...a); };
refreshTopicDates(opts(today));
db.prepare('INSERT INTO node_mastery (node_id, mastery_score, total_attempts) VALUES (?, 0, 0)').run(topics[6]);
db.prepare('INSERT INTO node_mastery (node_id, mastery_score, total_attempts, placement_prior) VALUES (?, 0.4, 0, 0.4)').run(topics[7]);
refreshTopicDates(opts(today));
laid = 0;
db.prepare('UPDATE node_mastery SET mastery_score = 0.7, total_attempts = 3 WHERE node_id = ?').run(topics[6]);
refreshTopicDates({ ...opts(today), lay: counting });
check('an answer on a topic with no head start re-lays nothing', laid === 0, `${laid} laid`);
db.prepare('UPDATE node_mastery SET mastery_score = 0.1, total_attempts = 3 WHERE node_id = ?').run(topics[7]);
refreshTopicDates({ ...opts(today), lay: counting });
check('...one on a seeded topic re-lays its project', laid === 1, `${laid} laid`);

// 19. A layout read inside a transaction that rolls back is not kept as
//     current: the write before it is seen on the next read.
refreshTopicDates(opts(today));
complete(topics[8], today);
try {
    db.transaction(() => { refreshTopicDates(opts(today)); throw new Error('rolled back'); })();
} catch { /* the caller's rollback */ }
check('a layout rolled back with its transaction is laid again',
    topicDatesOf(pid, opts(today)).get(topics[8])?.end === today, JSON.stringify(topicDatesOf(pid, opts(today)).get(topics[8])));

// 20. Saving a window clears the dates an older build stored on OPEN topics
//     (they would read as overdue once the window went); closed ones keep theirs.
const old = mkProject('Older build', null, null);
const oldOpen = mkNode(old, 'Open, old date', 0, { s: add(today, -9), e: add(today, -8) });
const oldDone = mkNode(old, 'Skipped, old date', 1, { status: 'skipped', s: add(today, -7), e: add(today, -7) });
const oldPlan = allocateSchedule(old, today, add(today, 20), EVERY_DAY);
persistSchedule(old, oldPlan.assignments, oldPlan.baselineSnapshot, { startDate: today, deadline: add(today, 20), studyDays: EVERY_DAY });
check('saving a window clears an open topic\'s stored dates', stored(oldOpen).s === null && stored(oldOpen).e === null, JSON.stringify(stored(oldOpen)));
check('...and keeps a closed topic\'s', stored(oldDone).e === add(today, -7));

// 21. Source: no server module writes a topic date any more (removeSchedule
//     clears legacy rows; the startup sweep clears notes).
const writers = [];
for (const dir of ['server', 'server/routes']) {
    for (const f of readdirSync(dir).filter(f => f.endsWith('.js'))) {
        const src = readFileSync(join(dir, f), 'utf8');
        if (/SET\s+scheduled_start\s*=\s*\?/.test(src)) writers.push(`${dir}/${f}`);
    }
}
check('no server module sets a topic date', writers.length === 0, writers.join(', '));

db.close();
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
