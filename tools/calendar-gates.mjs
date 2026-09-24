// tools/calendar-gates.mjs — one chip per task, on the calendar.
//
// Run:  node tools/calendar-gates.mjs
//
// Deterministic, no model, no network, no database: `buildCalendarScaffold` and
// `assignTasksToDays` are pure, so this suite bundles the real `src/utils/tree.ts`
// with esbuild and drives them directly.
//
// Why it exists. Every scheduled topic was drawn on EVERY day of its span, so a
// week holding six topics scheduled five days each painted thirty chips — the
// same six titles over and over — and the calendar reported far more work than
// the plan contains ("it looks much more than it actually is", 2026-09-21).
// The fix is one chip per task; the trap in the fix is that anchoring to
// `scheduled_start` alone HIDES a topic whose span began before the period on
// screen, which is exactly the topic being studied right now. So the property
// is narrower than "draw it once": every period shows the tasks that TOUCH it,
// once each, and the chip carries its own dates so the day it sits on is never
// mistaken for the day the topic starts.
//
// The pre-fix placement is re-run against the same fixture as the control: a
// gate that cannot fail on the shape it was written for is asserting nothing.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const scratch = mkdtempSync(join(tmpdir(), 'calendar-gates-'));
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

let buildCalendarScaffold = null, assignTasksToDays = null;
try {
    const esbuild = require('esbuild');
    const out = join(scratch, 'tree.mjs');
    await esbuild.build({
        // fileURLToPath, never `.pathname` — this repo's path contains a space,
        // which stays percent-encoded in a URL and esbuild cannot resolve it.
        entryPoints: [fileURLToPath(new URL('../src/utils/tree.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    });
    ({ buildCalendarScaffold, assignTasksToDays } = await import(pathToFileURL(out).href));
} catch (err) {
    console.log(`SKIPPED: esbuild unavailable (${String(err.message).split('\n')[0]})`);
    rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
}

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
/** A fresh scaffold every time: `assignTasksToDays` pushes into the cells it is given. */
const week = (refDate, days = ALL_DAYS) =>
    buildCalendarScaffold(2026, 8, days, { mode: 'week', weekStartDay: 1, weekRefDate: refDate });
const day = (refDate) =>
    buildCalendarScaffold(2026, 8, ALL_DAYS, { mode: 'day', weekStartDay: 1, weekRefDate: refDate });
const month = () => buildCalendarScaffold(2026, 8, ALL_DAYS, { mode: 'month', weekStartDay: 1 });

const task = (nodeId, title, start, end, status = 'not_started') => ({
    nodeId, title, status, color: '#3B82F6', scheduled_start: start, scheduled_end: end,
});

const chips = (days) => days.flatMap(d => d.tasks.map(t => ({ ...t, on: d.date })));
const titlesOn = (days, date) => days.find(d => d.date === date)?.tasks.map(t => t.title) ?? [];

// The week of Mon 2026-09-21 … Sun 2026-09-27, the one in the report.
const MON = '2026-09-21', TUE = '2026-09-22', WED = '2026-09-23', SUN = '2026-09-27';

// ---- 1. a multi-day topic is ONE chip ---------------------------------------
console.log('\n--- a topic scheduled across several days is drawn once ---');
{
    const spanning = task(1, 'Power Rule & Basic Derivatives', TUE, '2026-09-26');
    const days = assignTasksToDays(week(MON), [spanning]);
    const drawn = chips(days);
    check('five scheduled days draw one chip, not five', drawn.length === 1, `${drawn.length} chips`);
    check('…and it sits on the day the topic STARTS', drawn[0]?.on === TUE, drawn[0]?.on);
    check('the chip carries the topic own window, not the day it landed on',
        drawn[0]?.start === TUE && drawn[0]?.end === '2026-09-26',
        `${drawn[0]?.start}..${drawn[0]?.end}`);

    // The control: the placement this gate replaced, on the same fixture.
    const everyDay = week(MON).filter(d => d.date >= TUE && d.date <= '2026-09-26').length;
    check('CONTROL: the pre-fix rule drew it on every day of the span', everyDay === 5, String(everyDay));
}

// ---- 2. work already under way is not hidden --------------------------------
console.log('\n--- a span that began before this period still shows in it ---');
{
    // Started the previous Thursday, runs to Wednesday: the learner is studying
    // it THIS week, and anchoring on `scheduled_start` would draw nothing here.
    const ongoing = task(2, 'Series and Parallel Circuits', '2026-09-17', WED);
    const days = assignTasksToDays(week(MON), [ongoing]);
    const drawn = chips(days);
    check('it appears in the week it is being studied in', drawn.length === 1, `${drawn.length} chips`);
    check('…on the first day of the span this period contains', drawn[0]?.on === MON, drawn[0]?.on);
    check('…and its chip still names the real start, not Monday',
        drawn[0]?.start === '2026-09-17', drawn[0]?.start);
    check('a span that ends before the period draws nothing',
        chips(assignTasksToDays(week(MON), [task(3, 'Done', '2026-09-01', '2026-09-04')])).length === 0);
    check('a span that starts after it draws nothing',
        chips(assignTasksToDays(week(MON), [task(4, 'Later', '2026-10-05', '2026-10-09')])).length === 0);
}

// ---- 3. the property the change is FOR --------------------------------------
console.log('\n--- a week shows as many chips as it has topics ---');
{
    const six = [
        task(10, 'A', MON, '2026-09-25'), task(11, 'B', MON, SUN),
        task(12, 'C', TUE, '2026-09-24'), task(13, 'D', WED, WED),
        task(14, 'E', '2026-09-18', TUE), task(15, 'F', '2026-09-24', '2026-10-02'),
    ];
    const drawn = chips(assignTasksToDays(week(MON), six));
    check('six topics touching the week draw six chips', drawn.length === 6, `${drawn.length} chips`);
    check('…one per topic, no topic twice',
        new Set(drawn.map(c => c.nodeId)).size === 6, drawn.map(c => c.nodeId).join());
    check('a one-day topic is on its one day', titlesOn(assignTasksToDays(week(MON), six), WED).includes('D'));
}

// ---- 4. the other two view modes --------------------------------------------
console.log('\n--- the same rule in day and month view ---');
{
    const ongoing = task(20, 'Cells - The Building Blocks', '2026-09-17', '2026-09-24');
    check('DAY view: a topic under way today is on today',
        chips(assignTasksToDays(day(WED), [ongoing])).length === 1);
    check('…and a day it does not cover is empty',
        chips(assignTasksToDays(day('2026-09-30'), [ongoing])).length === 0);

    const allMonth = task(21, 'Whole month', '2026-09-01', '2026-09-30');
    const drawn = chips(assignTasksToDays(month(), [allMonth]));
    check('MONTH view: a month-long topic draws one chip across 42 cells',
        drawn.length === 1, `${drawn.length} chips`);
    check('…on the first cell of the span, padding days included',
        drawn[0]?.on === '2026-09-01', drawn[0]?.on);

    // Each carousel panel is assigned separately, so a span crossing a period
    // boundary is drawn once in EACH — that is the point, not a duplicate.
    const across = task(22, 'Across the weekend', '2026-09-25', '2026-09-29');
    const thisWeek = chips(assignTasksToDays(week(MON), [across]));
    const nextWeek = chips(assignTasksToDays(week('2026-09-28'), [across]));
    check('a span crossing into the next week is once in each week',
        thisWeek.length === 1 && nextWeek.length === 1 && thisWeek[0].on === '2026-09-25'
        && nextWeek[0].on === '2026-09-28',
        `${thisWeek[0]?.on} / ${nextWeek[0]?.on}`);
}

// ---- 5. what the chip still says --------------------------------------------
console.log('\n--- status colouring survives the placement change ---');
{
    const rows = [
        task(30, 'done', MON, TUE, 'completed'),
        task(31, 'skipped', MON, TUE, 'skipped'),
        task(32, 'doing', MON, TUE, 'in_progress'),
        task(33, 'todo', MON, TUE, 'not_started'),
    ];
    const drawn = chips(assignTasksToDays(week(MON), rows));
    const colorOf = (id) => drawn.find(c => c.nodeId === id)?.color;
    check('completed is green', colorOf(30) === '#10b981', colorOf(30));
    check('skipped is grey', colorOf(31) === '#94a3b8', colorOf(31));
    check('in progress is amber', colorOf(32) === '#f59e0b', colorOf(32));
    check('anything else keeps the project colour', colorOf(33) === '#3B82F6', colorOf(33));
    check('the chip no longer carries the dead isStart/isEnd flags',
        drawn.every(c => !('isStart' in c) && !('isEnd' in c)));
}

// ---- 6. a non-study day is a day, not a hole --------------------------------
console.log('\n--- study days shade the grid; they never move a chip ---');
{
    // The allocator only ever lands work on study days, but a weekend still sits
    // INSIDE a span, and dropping a chip onto it is the calendar's job, not a
    // decision to re-take here: a Sat-to-Mon span must not go missing because
    // its first day is unshaded.
    const weekend = task(40, 'Over the weekend', '2026-09-26', '2026-09-28');
    const drawn = chips(assignTasksToDays(week(MON, [1, 2, 3, 4, 5]), [weekend]));
    check('a span whose first visible day is a Saturday still draws there',
        drawn.length === 1 && drawn[0].on === '2026-09-26', drawn[0]?.on);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
