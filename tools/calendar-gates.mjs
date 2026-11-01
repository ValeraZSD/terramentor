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
// the plan contains.
// The fix is one chip per task; the trap in the fix is that anchoring to
// `scheduled_start` alone HIDES a topic whose span began before the period on
// screen, which is exactly the topic being studied right now. So the property
// is narrower than "draw it once": every period shows the tasks that TOUCH it,
// once each, and the chip carries its own dates so the day it sits on is never
// mistaken for the day the topic starts.
//
// The pre-fix placement is re-run against the same fixture as the control: a
// gate that cannot fail on the shape it was written for is asserting nothing.

import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleTs } from './lib/bundleTs.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'calendar-gates-'));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const tree = await bundleTs('src/utils/tree.ts', scratch,
    { what: 'the calendar', platform: 'node', needs: ['buildCalendarScaffold', 'assignTasksToDays'] });
if (!tree) {
    rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
}
const { buildCalendarScaffold, assignTasksToDays } = tree;

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

// One fixed week, Mon 2026-09-21 … Sun 2026-09-27.
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
// The dot says WHOSE work a chip is, whatever its status; recolouring it by
// status would paint one course's topics in another course's colour. Status is
// the chip's BODY, styled in CalendarView `chipClass`.
console.log('\n--- the dot is the project, the body is the status ---');
{
    const rows = [
        task(30, 'done', MON, TUE, 'completed'),
        task(31, 'skipped', MON, TUE, 'skipped'),
        task(32, 'doing', MON, TUE, 'in_progress'),
        task(33, 'todo', MON, TUE, 'not_started'),
    ];
    const drawn = chips(assignTasksToDays(week(MON), rows));
    const colorOf = (id) => drawn.find(c => c.nodeId === id)?.color;
    for (const [id, status] of [[30, 'completed'], [31, 'skipped'], [32, 'in progress'], [33, 'not started']]) {
        check(`${status}: the dot keeps the project colour`, colorOf(id) === '#3B82F6', colorOf(id));
    }
    check('the chip no longer carries the dead isStart/isEnd flags',
        drawn.every(c => !('isStart' in c) && !('isEnd' in c)));
    const view = readFileSync(fileURLToPath(new URL('../src/components/calendar/CalendarView.tsx', import.meta.url)), 'utf8');
    const body = /function chipClass\([\s\S]*?\n {4}\}/.exec(view)?.[0] ?? '';
    check('chipClass gives done, skipped, late and under-way their own body',
        /'completed'[\s\S]*bg-emerald/.test(body) && /'skipped'[\s\S]*line-through/.test(body)
        && /isLate\(task\)[\s\S]*bg-red/.test(body) && /'in_progress'[\s\S]*bg-amber/.test(body), body.slice(0, 80));
    check('a late chip also says so in words, not only in red', /tr\("Overdue"\)/.test(view));
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

// ---- 7. on a big screen, the controls sit with what they move ----------------
// On a 2560px screen the period's name was at the far left and the arrows,
// Today and Month / Week / Day at the far right: every step meant crossing the
// screen to read where it had landed, and nothing answered a key. Now every
// control sits in one cluster at the left ending in the name, the keys step and
// switch the calendar, and a big screen's week chips name their course so the
// legend row can go.
console.log('\n--- the navigator sits with the name it changes; keys ---');
{
    const src = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
    const require = createRequire(import.meta.url);
    const { JSDOM } = require('jsdom');
    const nav = src('src/components/calendar/CalendarNav.tsx');

    // The toolbar as RENDERED, read in document order. The narrow toolbar (a
    // phone, a side panel) keeps the order the old wide one had, name first and
    // the controls after it, so it is this check's control: the same reading
    // must tell the two apart. A first redesign kept Month / Week / Day at the
    // far right edge; three strangers named the ~2300px between it and Today.
    // Written under node_modules, not the temp folder: the bundle leaves React
    // external, and `require('react')` resolves from the file's own folder.
    const cache = join(fileURLToPath(new URL('..', import.meta.url)), 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const navScratch = mkdtempSync(join(cache, 'calendar-gates-'));
    const navMod = await (async () => {
        const { build } = await import('esbuild');
        const outfile = join(navScratch, 'nav.cjs');
        await build({
            stdin: {
                contents: `
                    import * as React from 'react';
                    import { createRoot } from 'react-dom/client';
                    import { CalendarNav } from './src/components/calendar/CalendarNav';
                    export function mount(el, narrow) {
                        const r = createRoot(el);
                        const noop = () => {};
                        React.act(() => r.render(React.createElement(CalendarNav, {
                            narrow, viewMode: 'week', onMode: noop, onPrev: noop, onNext: noop, onToday: noop,
                            title: 'Oct 26 – Nov 1, 2026', subtitle: 'Week 44', loading: false,
                        })));
                        return () => React.act(() => r.unmount());
                    }`,
                resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx',
            },
            bundle: true, format: 'cjs', platform: 'node', outfile,
            jsx: 'automatic', packages: 'external', logLevel: 'silent',
        });
        return outfile;
    })();
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    const g = globalThis;
    const saved = { window: g.window, document: g.document };
    g.window = dom.window; g.document = dom.window.document;
    for (const k of ['HTMLElement', 'Element', 'Node', 'MutationObserver']) g[k] = dom.window[k];
    g.IS_REACT_ACT_ENVIRONMENT = true;
    dom.window.matchMedia = (q) => ({ matches: /pointer:\s*fine|hover:\s*hover/.test(q), media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
    const { mount } = require(navMod);
    const order = (narrow) => {
        const host = dom.window.document.createElement('div');
        dom.window.document.body.append(host);
        // No i18next instance here, so `t` returns the English key; its warning
        // about that is noise in the run.
        const warn = console.warn; console.warn = () => { };
        const unmount = mount(host, narrow);
        console.warn = warn;
        // Each landmark's position in document order; `controlsAfterName`
        // counts the buttons drawn after the name (a control there moves
        // whenever the name changes width).
        const all = [...host.querySelectorAll('*')];
        const pos = (pred) => all.findIndex(pred);
        const today = pos(e => e.tagName === 'BUTTON' && e.textContent.trim() === 'Today');
        const back = pos(e => e.tagName === 'BUTTON' && /^Previous period/.test(e.getAttribute('aria-label') ?? ''));
        const name = pos(e => e.tagName === 'H2');
        const modes = pos(e => e.getAttribute('role') === 'radiogroup');
        const controlsAfterName = all.filter((e, i) => i > name && e.tagName === 'BUTTON').length;
        const ml = [...host.querySelectorAll('[class~="ml-auto"]')].length;
        unmount(); host.remove();
        return { modes, today, back, name, controlsAfterName, pushedRight: ml };
    };
    const oneCluster = ({ modes, today, back, name, controlsAfterName, pushedRight }) =>
        modes >= 0 && modes < today && today < back && back < name && controlsAfterName === 0 && pushedRight === 0;
    const w = order(false), n = order(true);
    check('wide: Month / Week / Day, Today, the arrows, then the period\'s name, in one cluster',
        oneCluster(w), JSON.stringify(w));
    check('wide: no control after the name, so none moves when the name changes width',
        w.controlsAfterName === 0, JSON.stringify(w));
    check('control: the narrow toolbar (name first, controls after, as the old wide one) reads differently',
        n.name >= 0 && n.name < n.modes && n.modes < n.today && !oneCluster(n), JSON.stringify(n));
    g.window = saved.window; g.document = saved.document;
    rmSync(navScratch, { recursive: true, force: true });

    const view = src('src/components/calendar/CalendarView.tsx');
    const weekGridFn = /function renderWeekGrid\([\s\S]*?\n {4}\}/.exec(view)?.[0] ?? '';
    check('a wide week\'s chips get the roomy line (the days a topic runs; its course when wide enough)',
        /chip\(task, false, undefined, true\)/.test(weekGridFn), weekGridFn ? 'renderWeekGrid does not pass roomy' : 'no renderWeekGrid');
    check('the legend is left out where every chip names its course',
        /visibleProjects\.length > 0 && !chipsNameOwner/.test(view)
        && /const owner = roomy && chipsNameOwner \?/.test(view));
    // At 1280 a column is ~180px: the state and the dates filled the line and the
    // course was cut to "· …" while the legend was gone. The chips name it only
    // from 20rem a column, in rem so a larger interface scale counts.
    const ownerRule = /const chipsNameOwner = viewMode === 'day' \|\| \(weekGrid && width \/ 7 >= (\d+) \* rootFontSize\);/.exec(view);
    const remFloor = ownerRule ? Number(ownerRule[1]) : 0;
    const names = (cssWidth, rootPx = 16) => cssWidth / 7 >= remFloor * rootPx;
    check('a week column names the course only when it is wide enough for it',
        !!ownerRule && names(2560) && !names(1920) && !names(1280) && !names(2560, 24),
        ownerRule ? `${remFloor}rem: 2560 ${names(2560)}, 1920 ${names(1920)}, 1280 ${names(1280)}, 2560@150% ${names(2560, 24)}` : 'no chipsNameOwner width rule');
    check('a chip that runs several days says which days, beside its course',
        /\[lateWord, span, owner\]\.filter\(Boolean\)/.test(view) && /shortRangeLabel\(/.test(view));
    check('the view listens for its keys through calendarKey', /calendarKey\(e, rootEl\)/.test(view));
    check('each control names its key, only on a device with a keyboard',
        /hasKeyboard \? tr\("Today \(t\)"\)/.test(nav) && /hasKeyboard \? tr\("Previous period \(←\)"\)/.test(nav)
        && /hasKeyboard \? tr\("Month \(m\)"\)/.test(nav));

    const keys = await bundleTs('src/components/calendar/calendarKeys.ts', scratch,
        { what: 'the calendar keys', platform: 'node', needs: ['calendarKey'] });
    if (keys) {
        const { calendarKey } = keys;
        const { window } = new JSDOM('<!doctype html><html><body></body></html>');
        const doc = window.document;
        const el = (tag, attrs = {}) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
        const root = el('div');
        const chipBtn = el('button');
        const field = el('input', { type: 'text' });
        const modes = el('div', { role: 'radiogroup' }); const modeBtn = el('button', { role: 'radio' }); modes.append(modeBtn);
        root.append(chipBtn, field, modes);
        const tree = el('nav'); const treeRow = el('button'); tree.append(treeRow);
        doc.body.append(tree, root);
        const press = (key, target, extra = {}) => calendarKey({ key, target, defaultPrevented: false, ...extra }, root, doc);

        check('← and → with nothing focused step the period',
            press('ArrowLeft', doc.body) === 'prev' && press('ArrowRight', doc.body) === 'next');
        check('t, m, w, d: today and the three views (Caps Lock too)',
            press('t', doc.body) === 'today' && press('m', doc.body) === 'month'
            && press('W', doc.body) === 'week' && press('d', doc.body) === 'day');
        check('focus on a chip in the calendar: still the calendar\'s', press('ArrowRight', chipBtn) === 'next');
        check('NOT from the course tree beside it (its arrows are its own)',
            press('ArrowLeft', treeRow) === null && press('d', treeRow) === null);
        check('NOT while typing', press('t', field) === null && press('ArrowLeft', field) === null);
        check('an arrow on the view switch moves along the switch; a letter there still works',
            press('ArrowRight', modeBtn) === null && press('m', modeBtn) === 'month');
        check('NOT with a modifier held (Ctrl+← is the browser\'s, Shift+T is a capital)',
            press('ArrowLeft', doc.body, { ctrlKey: true }) === null && press('t', doc.body, { altKey: true }) === null);
        check('another key is left alone', press('x', doc.body) === null && press('ArrowUp', doc.body) === null
            && press('Enter', doc.body) === null);
        const dialog = el('div', { role: 'dialog', 'aria-modal': 'true' }); doc.body.append(dialog);
        check('NOT under a modal dialog', press('ArrowLeft', doc.body) === null && press('t', doc.body) === null);
        dialog.remove();
        const session = el('div', { 'data-owns-keyboard': '' }); doc.body.append(session);
        check('NOT over a review session', press('ArrowRight', doc.body) === null);
        session.remove();
        check('and the calendar\'s again once both are gone', press('ArrowRight', doc.body) === 'next');
    }
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
