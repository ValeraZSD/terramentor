// tools/pace-gates.mjs — checks the learned-pace verdict (server/paceModel.js,
// server/pace.js) says what its rules say, and only that.
//
// Run:  node tools/pace-gates.mjs
//       PACE_GATES_NOW=2026-03-29T00:30:00.000Z node tools/pace-gates.mjs
//
// Deterministic, no model, no network. Two halves:
//   1. The pure model over hand-built learners: steady, bursty then silent,
//      brand new (weeks 0 to 4), paused. One case per band, per thin-data rule,
//      per offer row (self-set, fixed, assigned), and the card unit.
//   2. The readers over a scratch database: which completions count, the
//      learner's day boundary, the burst filter on reviews, and the two routes.
//
// The clock is a PARAMETER: every date below derives from NOW, never from
// Date.now(). PACE_GATES_NOW picks the DAY (a DST switch, a month end); the hour
// is always 12:00 UTC, the same date in UTC and in Amsterdam, so one `TODAY`
// serves both halves. The routes read Date.now(), which the route checks pin
// to NOW while the requests run.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';

const scratch = mkdtempSync(join(tmpdir(), 'pace-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const near = (a, b, eps = 1e-6) => typeof a === 'number' && Math.abs(a - b) <= eps;
const show = (v) => JSON.stringify(v);

const NOW = new Date(`${(process.env.PACE_GATES_NOW || '2026-06-10').slice(0, 10)}T12:00:00.000Z`);
const NOW_MS = NOW.getTime();
const DAY_MS = 86_400_000;
const TODAY = NOW.toISOString().slice(0, 10); // the pure half works in UTC days
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const dayStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const ago = (n, from = TODAY) => dayStr(dayNum(from) - n);
const ahead = (n, from = TODAY) => dayStr(dayNum(from) + n);

const model = await import('../server/paceModel.js');
const { learnerPace, judgeDate, BANDS, OFFERS } = model;

/** `perWeek[i]` completions in the block ending `7i + 1` days before today, newest first. */
function learnerFromWeeks(perWeek, { today = TODAY, sinceWeeks = perWeek.length, bulk = false } = {}) {
    const days = [];
    perWeek.forEach((n, i) => {
        for (let k = 0; k < n; k++) days.push(ago(7 * i + 1 + (bulk ? 0 : k % 7), today));
    });
    return { days, since: ago(7 * sinceWeeks, today), today };
}
const paceOf = (l) => learnerPace(l.days, { since: l.since, today: l.today });

// ===========================================================================
console.log('\n--- the weekly series: 7-day blocks ending yesterday ---');
{
    const steady = paceOf(learnerFromWeeks(Array(16).fill(5)));
    check('a steady learner: 16 complete weeks of data', steady.weeksOfData === 16, show(steady.weeksOfData));
    check('…every block holds its 5', steady.weeks.length === 16 && steady.weeks.every(w => w.count === 5), show(steady.weeks.map(w => w.count)));
    check('…recent pace is 5 a week', near(steady.recent, 5), show(steady.recent));
    check('…best four weeks is 5 a week', near(steady.best, 5), show(steady.best));
    check('…no quiet weeks', steady.quietWeeks === 0);
    check('block 0 runs from 7 days ago to yesterday',
        steady.weeks[0].start === ago(7) && steady.weeks[0].end === ago(1), show(steady.weeks[0]));

    const edges = learnerPace([TODAY, ago(1), ago(7), ago(8)], { since: ago(28), today: TODAY });
    check('a topic closed today is not in any block yet', edges.weeks.reduce((s, w) => s + w.count, 0) === 3, show(edges.weeks));
    check('yesterday and 7 days ago fall in block 0, 8 days ago in block 1',
        edges.weeks[0].count === 2 && edges.weeks[1].count === 1, show(edges.weeks.map(w => w.count)));

    const partial = learnerPace([ago(9)], { since: ago(10), today: TODAY });
    check('a block that starts before the record does is not a week of data', partial.weeksOfData === 1 && partial.weeks.length === 1, show(partial));

    const none = learnerPace([], { since: null, today: TODAY });
    check('no record at all: no weeks, no pace', none.weeksOfData === 0 && none.recent === null && none.best === null, show(none));

    // Facts from another party: a bad date must not stall or skew the record.
    const ancient = learnerPace([ago(3)], { since: '1970-01-01', today: TODAY });
    check('a record "since 1970" reaches back three years at most', ancient.weeksOfData === model.MAX_HISTORY_WEEKS, show(ancient.weeksOfData));
    const junk = learnerPace(['not a date', '', null, ago(2)], { since: 'soon', today: TODAY });
    check('a since that is not a date: no weeks (and no endless loop)', junk.weeksOfData === 0, show(junk));
    const junkDays = learnerPace(['2026-13-45x', ago(2)], { since: ago(14), today: TODAY });
    check('a completion that is not a date is left out', junkDays.weeks[0].count === 1, show(junkDays.weeks));
    let threwToday = false;
    try { learnerPace([], { since: null, today: 'today' }); } catch { threwToday = true; }
    check('a today that is not a date is refused', threwToday);
    let threwFeb30 = false;
    try { learnerPace([], { since: null, today: '2026-02-30' }); } catch { threwFeb30 = true; }
    check('…nor a day the calendar lacks (Feb 30 is not 2 March)', threwFeb30);
    const feb30 = judgeDate(none, { open: 5, deadline: '2027-02-30', today: TODAY });
    check('a deadline the calendar lacks is no date', feb30.band === 'no_date' && feb30.deadline === null, show(feb30.band));
}

console.log('\n--- recency weighting: a week counts half every 4 weeks back ---');
{
    const lateBurst = paceOf(learnerFromWeeks([12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const earlyBurst = paceOf(learnerFromWeeks([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12]));
    check('the same 12 topics weigh more last week than 11 weeks ago', lateBurst.recent > earlyBurst.recent * 5,
        `${lateBurst.recent} vs ${earlyBurst.recent}`);
    const w = (i) => Math.pow(0.5, i / 4);
    let sw = 0; for (let i = 0; i < 12; i++) sw += w(i);
    check('the weight is 0.5^(weeksAgo/4) over at most 12 weeks', near(lateBurst.recent, 12 / sw, 1e-9), `${lateBurst.recent} vs ${12 / sw}`);
    const old = paceOf(learnerFromWeeks([...Array(12).fill(0), 50]));
    check('a week older than 12 does not move the recent pace', old.recent === 0, show(old.recent));
    check('…but still counts for the best pace ever', old.best > 0, show(old.best));
}

console.log('\n--- bursty, then silent: the shape of a crunch before an exam ---');
// Oldest first: 6,0,0,16,0,1,8,2,13,17,6,5,2,2,0,1, then 11 empty weeks.
const crunch = [6, 0, 0, 16, 0, 1, 8, 2, 13, 17, 6, 5, 2, 2, 0, 1, ...Array(11).fill(0)].reverse();
const crunchLearner = learnerFromWeeks(crunch);
// The 16 land on one day: a real bulk day is a week's count like any other.
crunchLearner.days = [];
crunch.forEach((n, i) => { for (let k = 0; k < n; k++) crunchLearner.days.push(ago(7 * i + 1 + (n === 16 ? 0 : k % 7))); });
const crunchPace = paceOf(crunchLearner);
{
    check('11 quiet weeks', crunchPace.quietWeeks === 11, show(crunchPace.quietWeeks));
    check('best four weeks in a row is (13+17+6+5)/4 = 10.25', near(crunchPace.best, 10.25), show(crunchPace.best));
    const stretchStart = crunchPace.bestStretch?.start, stretchEnd = crunchPace.bestStretch?.end;
    check('…and names the stretch it came from',
        stretchStart === ago(7 * 18 + 7) && stretchEnd === ago(7 * 15 + 1), show(crunchPace.bestStretch));
    check('recent pace is near zero after 11 empty weeks', crunchPace.recent > 0 && crunchPace.recent < 0.2, show(crunchPace.recent));
    check('a bulk day of 16 counts as 16 in its week', crunchPace.weeks[23].count === 16, show(crunchPace.weeks[23]));

    const physics = judgeDate(crunchPace, { open: 60, deadline: ahead(17), today: TODAY, canCheckKnown: true, otherCourses: 3 });
    check('60 topics in 17 days needs 24.7 a week', near(physics.needed, 60 / (17 / 7), 0.005), show(physics.needed));
    check('…above the best month: out of reach', physics.band === 'out_of_reach', physics.band);
    check('…24 of the 60 fit at the best pace', physics.fits === 24, show(physics.fits));

    const mathB = judgeDate(crunchPace, { open: 35, deadline: ahead(31), today: TODAY });
    check('35 topics in 31 days (7.9 a week, 77% of best): tight', mathB.band === 'tight', `${mathB.band} ${mathB.needed}`);

    const longCourse = judgeDate(crunchPace, { open: 390, deadline: ahead(655), today: TODAY });
    check('390 topics in 655 days (4.2 a week, 41% of best): under pace', longCourse.band === 'under_pace', `${longCourse.band} ${longCourse.needed}`);
}

console.log('\n--- thin data: honest while the record is short ---');
{
    const day3 = learnerPace([ago(1), ago(2)], { since: ago(3), today: TODAY });
    const v0 = judgeDate(day3, { open: 500, deadline: ahead(7), today: TODAY, otherCourses: 2, canCheckKnown: true });
    check('under one week of data: learning your pace', v0.band === 'learning' && day3.weeksOfData === 0, `${v0.band} ${day3.weeksOfData}`);
    check('…silent even for an impossible date', v0.early === false, show(v0.early));
    check('…no offers', v0.offers.length === 0, show(v0.offers));
    check('…no finish range', v0.ranges.recent === null && v0.ranges.best === null);

    const week1 = learnerFromWeeks([3]);
    const p1 = paceOf(week1);
    const under2x = judgeDate(p1, { open: 5, deadline: ahead(7), today: TODAY });
    const at2x = judgeDate(p1, { open: 6, deadline: ahead(7), today: TODAY });
    check('one week of data: still learning', under2x.band === 'learning' && at2x.band === 'learning', `${under2x.band} ${at2x.band}`);
    check('…quiet when the date needs less than twice the pace so far (5 vs 3)', under2x.early === false);
    check('…speaks when it needs at least twice (6 vs 3)', at2x.early === true);
    const idle1 = judgeDate(paceOf(learnerFromWeeks([0])), { open: 1, deadline: ahead(28), today: TODAY });
    check('…a first week with nothing closed speaks for any open work', idle1.early === true && idle1.band === 'learning', show(idle1));
    check('…no offers while learning', at2x.offers.length === 0);

    const week2 = paceOf(learnerFromWeeks([3, 3]));
    const v2 = judgeDate(week2, { open: 6, deadline: ahead(14), today: TODAY });
    check('two weeks of data: a verdict', v2.band === 'on_pace' && v2.early === false, `${v2.band} ${v2.early}`);
    check('…no finish range before week 4', v2.ranges.recent === null && v2.ranges.best === null, show(v2.ranges));

    const week3 = judgeDate(paceOf(learnerFromWeeks([3, 3, 3])), { open: 30, deadline: ahead(70), today: TODAY });
    check('three weeks: still no range', week3.ranges.recent === null && week3.ranges.best === null);

    const week4 = judgeDate(paceOf(learnerFromWeeks([3, 4, 2, 5])), { open: 30, deadline: ahead(70), today: TODAY });
    const r = week4.ranges.recent;
    check('four weeks: a finish range from the recent weeks', r && r.from && r.to, show(week4.ranges));
    check('…a range, never one date: from comes before to', r && r.from < r.to, show(r));
    check('…both after today', r && r.from > TODAY, show(r));
    check('…naming the stretch it replays', r && r.stretch?.start === ago(28) && r.stretch?.end === ago(1), show(r?.stretch));
    check('…nowhere a single finish date', !JSON.stringify(week4).match(/"(finish|finishDate|eta|predicted)"/i));
    const again = judgeDate(paceOf(learnerFromWeeks([3, 4, 2, 5])), { open: 30, deadline: ahead(70), today: TODAY });
    check('…the same record gives the same range (seeded replay)', isDeepStrictEqual(week4, again));
}

console.log('\n--- the ranges after a quiet spell ---');
{
    const physics = judgeDate(crunchPace, { open: 60, deadline: ahead(17), today: TODAY });
    check('no recent range when the recent weeks cannot finish it in ten years', physics.ranges.recent === null, show(physics.ranges.recent));
    const b = physics.ranges.best;
    check('a range at the best pace, from the best four weeks', b && b.from < b.to && isDeepStrictEqual(b.stretch, crunchPace.bestStretch), show(b));
    check('…60 topics at 10.25 a week land 5 to 8 weeks out', b && dayNum(b.from) - dayNum(TODAY) >= 28 && dayNum(b.to) - dayNum(TODAY) <= 63, show(b));
}

console.log('\n--- paused: a steady learner who stopped ---');
const paused = paceOf(learnerFromWeeks([0, 0, 0, 0, 0, 0, ...Array(10).fill(6)]));
{
    check('6 quiet weeks', paused.quietWeeks === 6);
    check('best is still 6 a week', near(paused.best, 6));
    check('recent fell to about 1.6', paused.recent > 1.5 && paused.recent < 1.6, show(paused.recent));
}

console.log('\n--- the bands, at their edges ---');
{
    const steady = paceOf(learnerFromWeeks(Array(8).fill(5)));
    const at = (open, days, pace = steady, extra = {}) => judgeDate(pace, { open, deadline: ahead(days), today: TODAY, ...extra });
    check('recent exactly the pace needed (10 in 14 days at 5 a week): on pace', at(10, 14).band === 'on_pace', at(10, 14).band);
    check('one more topic than the best pace fits: out of reach', at(11, 14).band === 'out_of_reach', at(11, 14).band);
    // paused: recent 1.57, best 6. Needed = open / 5 over 35 days.
    check('needed exactly 60% of best (18 in 5 weeks, 3.6): under pace', at(18, 35, paused).band === 'under_pace', `${at(18, 35, paused).band} ${at(18, 35, paused).needed}`);
    check('just over 60% (19, 3.8): tight', at(19, 35, paused).band === 'tight', at(19, 35, paused).band);
    check('exactly the best pace (30, 6.0): tight', at(30, 35, paused).band === 'tight', at(30, 35, paused).band);
    check('just over the best (31, 6.2): out of reach', at(31, 35, paused).band === 'out_of_reach', at(31, 35, paused).band);
    check('under pace when recent is short of needed', at(7, 14, paused).band === 'under_pace', at(7, 14, paused).band);
    check('fits = floor(best x weeks left): 6 x 2 = 12', at(20, 14, paused).fits === 12, show(at(20, 14, paused).fits));
    check('fits never exceeds what is open', at(5, 14, paused).fits === 5, show(at(5, 14, paused).fits));
    const never = paceOf(learnerFromWeeks([0, 0, 0]));
    check('nothing ever closed, open work: out of reach, none fit', at(3, 30, never).band === 'out_of_reach' && at(3, 30, never).fits === 0, show(at(3, 30, never)));

    check('no date: no verdict', judgeDate(steady, { open: 4, deadline: null, today: TODAY }).band === 'no_date');
    check('nothing open: done', at(0, 14).band === 'done' && at(0, 14).offers.length === 0);
    check('the date is today: still a day to study, not passed', at(4, 0).band === 'on_pace' && at(4, 0).daysLeft === 0, show(at(4, 0)));
    check('the date has gone by: passed', at(4, -3).band === 'passed' && at(4, -3).daysLeft === -3, show(at(4, -3)));
    // A weekly rate over "one day left" would call the last topic of every
    // course out of reach: under a week, the date is judged as a week's work.
    check('the last topic, due tomorrow, at 5 a week: on pace', at(1, 1).band === 'on_pace' && at(1, 1).offers.length === 0, show(at(1, 1)));
    check('3 topics in 3 days at 5 a week: on pace', at(3, 3).band === 'on_pace', show(at(3, 3)));
    check('10 topics by tomorrow at a best of 5 a week: out of reach, 5 fit', at(10, 1).band === 'out_of_reach' && at(10, 1).fits === 5, show(at(10, 1)));
    check('every band is one of the published set', [at(10, 14), at(11, 14), at(18, 35, paused), at(19, 35, paused), at(0, 14), at(4, 0)]
        .every(v => BANDS.includes(v.band)));
    check('the verdict carries the three numbers a sentence needs', ['needed', 'recent', 'best', 'fits', 'open', 'daysLeft']
        .every(k => k in at(19, 35, paused)));
}

console.log('\n--- offers: who set the date decides ---');
{
    const kinds = (v) => v.offers.map(o => o.kind);
    const out = (extra) => judgeDate(crunchPace, { open: 60, deadline: ahead(17), today: TODAY, canCheckKnown: true, otherCourses: 2, ...extra });
    const tight = (extra) => judgeDate(crunchPace, { open: 35, deadline: ahead(31), today: TODAY, canCheckKnown: true, otherCourses: 2, ...extra });

    check('self-set, out of reach: fit, check, pause, move — the date-keeping ones first',
        isDeepStrictEqual(kinds(out()), ['fit_subset', 'check_known', 'pause_others', 'move_date']), show(kinds(out())));
    check('…"study the N that fit" carries N', out().offers[0].count === 24, show(out().offers[0]));
    check('self-set, ticked "cannot move": never move the date',
        isDeepStrictEqual(kinds(out({ fixed: true })), ['fit_subset', 'check_known', 'pause_others']), show(kinds(out({ fixed: true }))));
    check('assigned by a teacher: no move, no pause',
        isDeepStrictEqual(kinds(out({ assigned: true })), ['fit_subset', 'check_known']), show(kinds(out({ assigned: true }))));
    check('…even with other courses competing', !kinds(out({ assigned: true, otherCourses: 9 })).includes('pause_others'));
    check('…an assigned date is fixed and owned by the teacher', out({ assigned: true }).fixed === true && out({ assigned: true }).owner === 'teacher');
    check('…a self-set one is the learner\'s', out().owner === 'learner' && out().fixed === false);

    check('self-set, tight: plan a weekly amount first',
        isDeepStrictEqual(kinds(tight()), ['plan_weekly', 'check_known', 'pause_others', 'move_date']), show(kinds(tight())));
    check('…the weekly amount is the pace needed, rounded up', tight().offers[0].perWeek === Math.ceil(35 / (31 / 7)), show(tight().offers[0]));
    check('assigned, tight: plan and check only', isDeepStrictEqual(kinds(tight({ assigned: true })), ['plan_weekly', 'check_known']));
    check('no placement check to offer: not offered', !kinds(out({ canCheckKnown: false })).includes('check_known'));
    check('no other course with a date: nothing to pause', !kinds(out({ otherCourses: 0 })).includes('pause_others'));
    check('on pace: no offers', judgeDate(crunchPace, { open: 1, deadline: ahead(400), today: TODAY, canCheckKnown: true, otherCourses: 2 }).offers.length === 0);
    check('a passed self-set date: only "move the date"',
        isDeepStrictEqual(kinds(judgeDate(crunchPace, { open: 9, deadline: ago(2), today: TODAY, canCheckKnown: true, otherCourses: 2 })), ['move_date']));
    check('a passed exam date: nothing (the app never moves it)',
        judgeDate(crunchPace, { open: 9, deadline: ago(2), today: TODAY, fixed: true }).offers.length === 0
        && judgeDate(crunchPace, { open: 9, deadline: ago(2), today: TODAY, assigned: true }).offers.length === 0);
    check('every offer kind is one of the published set', [out(), tight(), out({ fixed: true })].flatMap(kinds).every(k => OFFERS.includes(k)));
    check('"move the date" is only ever last', [out(), tight()].every(v => kinds(v).indexOf('move_date') === v.offers.length - 1));
}

console.log('\n--- a course measured in cards ---');
{
    const cards = paceOf(learnerFromWeeks([40, 30, 50, 40, 40]));
    const deck = judgeDate(cards, { open: 400, deadline: ahead(28), today: TODAY, unit: 'cards', canCheckKnown: true, otherCourses: 1 });
    check('the unit is stated', deck.unit === 'cards');
    check('needed is cards a week (400 in 4 weeks = 100)', near(deck.needed, 100), show(deck.needed));
    check('…judged on the same bands', deck.band === 'out_of_reach', deck.band);
    check('…fits counts cards', deck.fits === Math.floor(deck.best * 4), `${deck.fits} ${deck.best}`);
    check('…no placement check for cards, even if asked', !deck.offers.some(o => o.kind === 'check_known'));
    check('a topic verdict says topics', judgeDate(cards, { open: 4, deadline: ahead(28), today: TODAY }).unit === 'topics');
}

console.log('\n--- pure: no clock, no randomness, no imports ---');
{
    const realNow = Date.now;
    let threw = null;
    Date.now = () => { throw new Error('the pace model read the clock'); };
    try {
        learnerPace(crunchLearner.days, { since: crunchLearner.since, today: TODAY });
        judgeDate(crunchPace, { open: 60, deadline: ahead(17), today: TODAY });
        judgeDate(paceOf(learnerFromWeeks([3, 4, 2, 5])), { open: 30, deadline: ahead(70), today: TODAY });
    } catch (e) { threw = e; } finally { Date.now = realNow; }
    check('the model never calls Date.now()', threw === null, threw?.message);

    const src = readFileSync(join(root, 'server/paceModel.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    check('paceModel.js imports nothing (a school can run it on pushed facts alone)', !/^\s*import\s/m.test(src) && !/\bimport\(/.test(src));
    check('…and has no Date.now(), bare new Date() or Math.random()',
        !/Date\.now\s*\(/.test(src) && !/new Date\(\s*\)/.test(src) && !/Math\.random/.test(src));

    // The same facts read on another day: shift the record and today together.
    const shift = 113;
    const shifted = learnerPace(crunchLearner.days.map(d => ahead(shift, d)), { since: ahead(shift, crunchLearner.since), today: ahead(shift) });
    const a = judgeDate(crunchPace, { open: 35, deadline: ahead(31), today: TODAY });
    const b = judgeDate(shifted, { open: 35, deadline: ahead(31 + shift), today: ahead(shift) });
    check('the verdict depends on the record, not on which day it is read',
        a.band === b.band && a.needed === b.needed && a.recent === b.recent && a.best === b.best && a.fits === b.fits, `${show(a)} vs ${show(b)}`);
}

// ===========================================================================
console.log('\n--- readers: the record in a library ---');
const db = (await import('../server/database.js')).default;
const { libraryPace, projectVerdict, learnerRecord } = await import('../server/pace.js');

const AMS = 'Europe/Amsterdam';
const iso = (ms) => new Date(ms).toISOString();
const mkProject = (name, { kind = 'curriculum', deadline = null, start = null, created = iso(NOW_MS - 200 * DAY_MS) } = {}) =>
    Number(db.prepare(`INSERT INTO projects (name, kind, deadline, start_date, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(name, kind, deadline, start, created.replace('T', ' ').slice(0, 19)).lastInsertRowid);
const mkNode = (projectId, title, parentId, extra = {}) => Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, is_note, role, status, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
).run(projectId, parentId, title, extra.isNote ? 1 : 0, extra.role ?? 'topic', extra.status ?? 'not_started', extra.completedAt ?? null).lastInsertRowid);

const course = mkProject('Course', { deadline: ahead(35), start: ago(30) });
const section = mkNode(course, 'Section', null);
// Counted: a completed topic leaf. One sits across the learner's midnight
// (23:30 UTC is the next day in Amsterdam, summer or winter).
mkNode(course, 'closed late evening UTC', section, { status: 'completed', completedAt: iso(dayNum(ago(8)) * DAY_MS + 23.5 * 3600_000) });
mkNode(course, 'closed yesterday', section, { status: 'completed', completedAt: iso(dayNum(ago(1)) * DAY_MS + 10 * 3600_000) });
// Not counted: a note, a section, a stage, a completion with no time, a skipped topic.
const doneSection = mkNode(course, 'closed section', null, { status: 'completed', completedAt: iso(dayNum(ago(2)) * DAY_MS + 36e5) });
mkNode(course, 'open child', doneSection);
mkNode(course, 'closed note', section, { isNote: true, status: 'completed', completedAt: iso(dayNum(ago(2)) * DAY_MS + 36e5) });
mkNode(course, 'closed stage', section, { role: 'pagination', status: 'completed', completedAt: iso(dayNum(ago(2)) * DAY_MS + 36e5) });
mkNode(course, 'closed without a time', section, { status: 'completed' });
db.prepare(`UPDATE nodes SET status = 'skipped' WHERE id = ?`).run(mkNode(course, 'skipped', section));
for (let i = 0; i < 9; i++) mkNode(course, `open ${i}`, section);

{
    const recUtc = learnerRecord({ timeZone: 'UTC' });
    const recAms = learnerRecord({ timeZone: AMS });
    check('only completed topic leaves with a time count: 2', recUtc.topicDays.length === 2, show(recUtc.topicDays));
    check('23:30 UTC is that day in UTC…', recUtc.topicDays.includes(ago(8)), show(recUtc.topicDays));
    check('…and the next day in Amsterdam (the learner\'s day)', recAms.topicDays.includes(ago(7)) && !recAms.topicDays.includes(ago(8)), show(recAms.topicDays));
    check('the topic record starts at the oldest course', recAms.topicsSince === ago(200), show(recAms.topicsSince));

    const libUtc = libraryPace({ now: NOW_MS, timeZone: 'UTC' });
    const libAms = libraryPace({ now: NOW_MS, timeZone: AMS });
    check('so the same completion falls in block 1 in UTC', libUtc.topics.weeks[0].count === 1 && libUtc.topics.weeks[1].count === 1, show(libUtc.topics.weeks.slice(0, 2)));
    check('…and in block 0 in Amsterdam', libAms.topics.weeks[0].count === 2, show(libAms.topics.weeks.slice(0, 2)));
    check('today is the learner\'s', libAms.today === TODAY);
}

console.log('\n--- readers: cards met, without machine bursts ---');
// Older than the topic course, and with no topic of its own: the deck's day
// must not become the topic record's start.
const deck = mkProject('Deck', { kind: 'deck', deadline: ahead(28), start: ago(10), created: iso(NOW_MS - 300 * DAY_MS) });
const deckRoot = mkNode(deck, 'stages', null);
const stage = mkNode(deck, 'Stage 1', deckRoot, { role: 'pagination' });
// The deck's cards were made five days ago; the topic course is 200 days old.
const card = (met) => Number(db.prepare(`INSERT INTO flashcards (node_id, front, back, review_count, last_reviewed, created_at) VALUES (?, 'q', 'a', ?, ?, ?)`)
    .run(stage, met ? 1 : 0, met ? iso(NOW_MS - DAY_MS) : null, iso(NOW_MS - 5 * DAY_MS).replace('T', ' ').slice(0, 19)).lastInsertRowid);
const review = (cardId, ms, { source = 'app', stateBefore = null } = {}) => db.prepare(
    `INSERT INTO review_log (card_id, reviewed_at, rating, source, state_before, external_id) VALUES (?, ?, 3, ?, ?, ?)`
).run(cardId, iso(ms), source, stateBefore, source === 'app' ? null : `x${cardId}`);
{
    const t0 = dayNum(ago(3)) * DAY_MS + 12 * 3600_000;
    const human1 = card(true), human2 = card(true);
    const burst = [card(true), card(true), card(true)];
    for (let i = 0; i < 6; i++) card(false);
    review(human1, t0);
    review(human1, t0 + 120_000);            // a second review is not a new card
    burst.forEach((c, i) => review(c, t0 + 600_000 + i * 400)); // 0.4 s apart: a script, not a person
    review(human2, t0 + 900_000);
    // Exactly 2.000 s apart is not a burst (julianday reads it as 1.99999 s).
    const paced = [card(true), card(true)];
    review(paced[0], t0 + 1_800_000);
    review(paced[1], t0 + 1_802_000);
    // A card whose review count is NULL has not been met.
    db.prepare(`INSERT INTO flashcards (node_id, front, back, review_count, last_reviewed, created_at) VALUES (?, 'q', 'a', NULL, ?, ?)`)
        .run(stage, iso(NOW_MS - DAY_MS), iso(NOW_MS - 5 * DAY_MS).replace('T', ' ').slice(0, 19));
    // A review row written before state_before was kept has NULL there: the
    // state is unknown, not past New, so the card still counts as met.
    const legacy = card(true);
    review(legacy, t0 + DAY_MS);
    // A card imported with a review count and no history: its first in-app
    // review found it already in review, so it was not met that day.
    const imported = card(true);
    review(imported, t0 - DAY_MS, { stateBefore: 2 });
    const rec = learnerRecord({ timeZone: 'UTC' });
    check('cards met: first reviews only, bursts under 2 s left out', rec.cardDays.length === 5, show(rec.cardDays));
    check('…a first review with no state_before (an older log row) counts', rec.cardDays.includes(ago(2)), show(rec.cardDays));
    check('…and an imported card\'s first in-app review (state_before past New) is not a card met',
        !rec.cardDays.includes(ago(4)), show(rec.cardDays));
    check('the card record starts at the oldest card, not the oldest course', rec.cardsSince === ago(5), show(rec.cardsSince));
    check('…so a five-day-old deck has no full week of card data yet',
        libraryPace({ now: NOW_MS, timeZone: 'UTC' }).cards.weeksOfData === 0, show(libraryPace({ now: NOW_MS, timeZone: 'UTC' }).cards.weeksOfData));

    // History brought in from Anki is the learner's record in cards (met in
    // Anki 300 days ago, state Learning) but says nothing about topics.
    const fromAnki = card(true);
    review(fromAnki, NOW_MS - 300 * DAY_MS, { source: 'anki', stateBefore: 1 });
    const withAnki = learnerRecord({ timeZone: 'UTC' });
    check('an Anki first review counts as a card met on its own day', withAnki.cardDays.includes(ago(300)), show(withAnki.cardDays));
    check('…moves the card record back to it', withAnki.cardsSince === ago(300), show(withAnki.cardsSince));
    check('…and leaves the topic record where it was, not at the older topic-less deck', withAnki.topicsSince === ago(200), show(withAnki.topicsSince));
    // A course imported with its completions: a topic closed before the
    // course row was made moves the topic record back to that day, and only
    // that unit's record.
    const imported2 = mkProject('Imported', { created: iso(NOW_MS - 100 * DAY_MS) });
    mkNode(imported2, 'closed long ago', null, { status: 'completed', completedAt: iso(NOW_MS - 250 * DAY_MS) });
    const withImport = learnerRecord({ timeZone: 'UTC' });
    check('a topic completed before any course row moves the topic record back to it', withImport.topicsSince === ago(250), show(withImport.topicsSince));
    check('…and the card record stays where it was', withImport.cardsSince === ago(300), show(withImport.cardsSince));
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(imported2);
    check('…and removing it puts the topic record back', learnerRecord({ timeZone: 'UTC' }).topicsSince === ago(200));

    const v = projectVerdict(deck, { now: NOW_MS, timeZone: 'UTC' });
    check('a deck is judged in cards', v.unit === 'cards', show(v.unit));
    check('…its open work is the cards not met yet (6, and the one with no count)', v.open === 7, show(v.open));
    check('…and never offers the placement check', !v.offers.some(o => o.kind === 'check_known'));
}

console.log('\n--- readers: a course verdict ---');
{
    const v = projectVerdict(course, { now: NOW_MS, timeZone: AMS });
    check('a course is judged in topics', v.unit === 'topics');
    check('its open work is the open topic leaves (9 + the section\'s child = 10)', v.open === 10, show(v.open));
    check('days left counted from the learner\'s today', v.daysLeft === 35, show(v.daysLeft));
    check('the deck with a date counts as a competing course', v.otherCourses === 1, show(v.otherCourses));
    const undated = mkProject('No date');
    mkNode(undated, 'a topic', null);
    check('a course with no date has no verdict', projectVerdict(undated, { now: NOW_MS, timeZone: AMS }) === null);
    const lib = libraryPace({ now: NOW_MS, timeZone: AMS });
    check('one library read serves many courses with the same answer',
        isDeepStrictEqual(projectVerdict(course, { now: NOW_MS, timeZone: AMS, library: lib }), v));

    const dueToday = mkProject('Due today', { deadline: TODAY, start: ago(20) });
    mkNode(dueToday, 'last topic', null);
    check('a course due today still competes (its deadline day is a study day)',
        projectVerdict(course, { now: NOW_MS, timeZone: AMS, library: lib }).otherCourses === 2);

    // A course that misses and can be placed: the placement offer is slotted
    // in where judging it with the check would have put it.
    const cram = mkProject('Cram', { deadline: ahead(7), start: ago(5) });
    for (let i = 0; i < 8; i++) mkNode(cram, `cram topic ${i + 1}`, null);
    const cv = projectVerdict(cram, { now: NOW_MS, timeZone: AMS, library: lib });
    const judgedWithCheck = judgeDate(lib.topics, { open: cv.open, deadline: ahead(7), today: lib.today, canCheckKnown: true, otherCourses: cv.otherCourses });
    check('a missing course that can be placed is offered the check', cv.offers.some(o => o.kind === 'check_known'), show(cv.band));
    check('…in the same place and with the same verdict as judging it with the check',
        isDeepStrictEqual({ ...cv, otherCourses: undefined }, { ...judgedWithCheck, otherCourses: undefined }), show(cv.offers));
}

console.log('\n--- routes: the verdict rides beside the old pace ---');
{
    const old = mkProject('Long gone', { deadline: '2001-03-01', start: '2001-01-01' });
    mkNode(old, 'still open', null);
    const { createApp } = await import('../server/app.js');
    const srv = createServer(createApp());
    const port = await new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
    const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'X-Time-Zone': AMS } })).json();
    // The handlers read Date.now(); pin it to the gate's instant while they
    // answer, so their days match the fixtures' at any hour and on any day.
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    try {
        const pace = await get(`/api/projects/${old}/pace`);
        check('/pace still answers the old fields', 'paceStatus' in pace && 'expectedProgress' in pace && 'daysBehind' in pace, Object.keys(pace).join(','));
        check('…plus the verdict: a date long gone has passed', pace.verdict?.band === 'passed', show(pace.verdict));
        const datedPace = await get(`/api/projects/${course}/pace`);
        check('…a dated course carries the learner\'s weeks beside it', datedPace.verdict?.unit === 'topics' && Array.isArray(datedPace.learnerPace?.weeks), show(Object.keys(datedPace)));
        check('…judged on the learner\'s today, not the machine\'s', datedPace.verdict?.daysLeft === 35, show(datedPace.verdict?.daysLeft));
        const ov = await get('/api/schedule/overview');
        const row = ov.projects.find(p => p.id === old);
        const plain = ov.projects.find(p => p.name === 'No date');
        check('the overview row carries the verdict too', row?.verdict?.band === 'passed', show(row?.verdict));
        check('…and its old pace object is untouched', row?.pace && 'paceStatus' in row.pace, show(row?.pace));
        check('…an undated row has none', plain && plain.verdict === null, show(plain?.verdict));
        check('the overview\'s today is the day its verdicts were judged on', ov.today === TODAY, show(ov.today));

        console.log('\n--- routes: the "cannot move" lock and the one write path ---');
        const send = async (method, p, body) => {
            const r = await fetch(`http://127.0.0.1:${port}${p}`, {
                method, headers: { 'Content-Type': 'application/json', 'X-Time-Zone': AMS }, body: JSON.stringify(body),
            });
            return { status: r.status, json: await r.json().catch(() => ({})) };
        };
        const exam = mkProject('Exam', { deadline: ahead(14), start: ago(30) });
        // Sixty open topics in two weeks miss at any pace the fixture holds, so
        // the unlocked verdict MUST offer the move: a band with no offers at
        // all ("learning", "on pace") would let the locked check below pass
        // without the lock doing anything.
        for (let i = 0; i < 60; i++) mkNode(exam, `exam topic ${i + 1}`, null);
        const examBefore = await get(`/api/projects/${exam}/pace`);
        check('an unlocked date of the learner\'s may be moved', examBefore.verdict?.fixed === false
            && examBefore.verdict.offers.some(o => o.kind === 'move_date'), show(examBefore.verdict));
        let r = await send('PUT', `/api/projects/${exam}`, { deadline_fixed: true });
        check('PUT locks the date', r.status === 200 && r.json.deadline_fixed === 1, show(r));
        const locked = await get(`/api/projects/${exam}/pace`);
        check('…and the verdict reads the lock: fixed, never "move the date"',
            locked.verdict?.fixed === true && !locked.verdict.offers.some(o => o.kind === 'move_date'), show(locked.verdict));
        r = await send('PUT', `/api/projects/${exam}`, { deadline: ahead(60) });
        check('a locked date is not moved by PUT', r.status === 400
            && db.prepare('SELECT deadline FROM projects WHERE id = ?').get(exam).deadline === ahead(14), show(r));
        r = await send('POST', `/api/projects/${exam}/schedule`, { startDate: ago(30), deadline: ahead(60), studyDays: [1, 2, 3, 4, 5] });
        check('…nor by a schedule write', r.status === 400
            && db.prepare('SELECT deadline FROM projects WHERE id = ?').get(exam).deadline === ahead(14), show(r));
        r = await send('DELETE', `/api/projects/${exam}/schedule`);
        const afterDelete = db.prepare('SELECT deadline, deadline_fixed AS f FROM projects WHERE id = ?').get(exam);
        check('…nor removed with the schedule', r.status === 400
            && afterDelete.deadline === ahead(14) && afterDelete.f === 1, show({ r, afterDelete }));
        r = await send('PUT', `/api/projects/${exam}`, { deadline_fixed: 'yes' });
        check('the lock takes a boolean only', r.status === 400, show(r));
        r = await send('POST', `/api/projects/${exam}/schedule`, { startDate: ago(30), deadline: ahead(21), studyDays: [1, 2, 3, 4, 5], deadlineFixed: false });
        check('unlocking and moving in one schedule write is allowed', r.status === 200
            && r.json.project?.deadline === ahead(21) && r.json.project?.deadline_fixed === 0, show(r.json.project));
        r = await send('POST', `/api/projects/${exam}/schedule`, { startDate: ago(30), deadline: ahead(21), studyDays: [1, 2, 3, 4, 5], deadlineFixed: true });
        check('…and a schedule write may set the lock', r.status === 200 && r.json.project?.deadline_fixed === 1, show(r.json.project));
        // The panel's path: untick, change the date, tick again, one Save.
        r = await send('POST', `/api/projects/${exam}/schedule`, { startDate: ago(30), deadline: ahead(28), studyDays: [1, 2, 3, 4, 5], deadlineFixed: true });
        check('a write that names the lock may move the date and keep it locked', r.status === 200
            && r.json.project?.deadline === ahead(28) && r.json.project?.deadline_fixed === 1, show(r.json.project));
        // No study day left before the date (today and tomorrow are off): the
        // mark alone is still saved, and leaves every topic date as it was.
        const isoDay = (d) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
        const offDays = [1, 2, 3, 4, 5, 6, 7].filter(d => d !== isoDay(TODAY) && d !== isoDay(ahead(1)));
        const tomorrow = mkProject('Exam tomorrow', { deadline: ahead(1), start: ago(30) });
        db.prepare('UPDATE projects SET study_days = ? WHERE id = ?').run(JSON.stringify(offDays), tomorrow);
        const tmTopic = mkNode(tomorrow, 'tomorrow topic', null);
        db.prepare('UPDATE nodes SET scheduled_start = ?, scheduled_end = ? WHERE id = ?').run(ago(3), ago(3), tmTopic);
        r = await send('POST', `/api/projects/${tomorrow}/schedule`, { startDate: ago(30), deadline: ahead(1), studyDays: offDays, deadlineFixed: true });
        const tmNode = db.prepare('SELECT scheduled_start AS s FROM nodes WHERE id = ?').get(tmTopic);
        check('a write that only sets the mark is saved even with no study day left', r.status === 200
            && r.json.project?.deadline_fixed === 1 && tmNode.s === ago(3), show({ status: r.status, error: r.json.error, tmNode }));
        r = await send('POST', `/api/projects/${tomorrow}/schedule`, { startDate: ago(30), deadline: ahead(1), studyDays: offDays.slice(1), deadlineFixed: true });
        check('…but a write that changes the plan is still refused there', r.status === 400, show(r));
        const bare = mkProject('No date yet');
        r = await send('PUT', `/api/projects/${bare}`, { deadline_fixed: true });
        check('a lock needs a date', r.status === 400
            && db.prepare('SELECT deadline_fixed AS f FROM projects WHERE id = ?').get(bare).f === 0, show(r));
        const junk = mkProject('Old junk date', { deadline: 'not-a-date' });
        r = await send('PUT', `/api/projects/${junk}`, { deadline_fixed: true });
        check('…a real one: a stored deadline that is not a date takes no lock', r.status === 400
            && db.prepare('SELECT deadline_fixed AS f FROM projects WHERE id = ?').get(junk).f === 0, show(r));
        const cleared = mkProject('Dated then cleared');
        db.prepare('UPDATE projects SET start_date = ?, deadline = ?, deadline_fixed = 1 WHERE id = ?').run(ago(5), ahead(10), cleared);
        r = await send('PUT', `/api/projects/${cleared}`, { start_date: null, deadline: null, deadline_fixed: false });
        const afterClear = db.prepare('SELECT deadline, deadline_fixed AS f FROM projects WHERE id = ?').get(cleared);
        check('clearing a date with its mark taken off clears both', r.status === 200
            && afterClear.deadline === null && afterClear.f === 0, show({ status: r.status, afterClear }));
        r = await send('PUT', `/api/projects/${cleared}`, { deadline_fixed: true });
        check('…and once its date is cleared, no lock can be set on nothing', r.status === 400, show(r));
        db.prepare('UPDATE projects SET start_date = ?, deadline = ?, deadline_fixed = 1 WHERE id = ?').run(ago(5), ahead(10), cleared);
        r = await send('PUT', `/api/projects/${cleared}`, { start_date: null, deadline: null });
        check('clearing a locked date by a write that names no lock is refused (it is a move)', r.status === 400, show(r));
        // A course already under way: the window began 30 days ago and its open
        // topics still carry dates in the past. Laying every topic out from the
        // window's start would date open work in the past again, the "overdue
        // on the day you planned it" fault.
        const underway = mkProject('Under way', { deadline: ahead(30), start: ago(30) });
        for (let i = 0; i < 6; i++) {
            const n = mkNode(underway, `under way topic ${i + 1}`, null);
            db.prepare('UPDATE nodes SET scheduled_start = ?, scheduled_end = ? WHERE id = ?').run(ago(20 - i), ago(20 - i), n);
        }
        r = await send('POST', `/api/projects/${underway}/schedule`, { startDate: ago(30), deadline: ahead(30), studyDays: [1, 2, 3, 4, 5] });
        const open = db.prepare(`SELECT scheduled_start AS s FROM nodes WHERE project_id = ? AND is_note = 0`).all(underway);
        check('a schedule write lays the open topics out from today, not from the window\'s start', r.status === 200
            && open.length === 6 && open.every(n => n.s && n.s >= TODAY), show({ status: r.status, s: open.map(n => n.s) }));
        const stored = db.prepare('SELECT start_date FROM projects WHERE id = ?').get(underway).start_date;
        check('…and keeps the window\'s own start', stored === ago(30), show(stored));
    } finally {
        Date.now = realNow;
        srv.closeAllConnections();
        await new Promise(ok => srv.close(ok));
    }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
// Ended, not killed: process.exit() while the app's handles are still closing
// aborts node on Windows with a libuv assertion (exit 127) after a green run.
try { db.close(); } catch { /* best effort */ }
process.exitCode = fail === 0 ? 0 : 1;
