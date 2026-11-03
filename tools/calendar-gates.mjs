// tools/calendar-gates.mjs — one chip per task, on the calendar.
//
// Run:  node tools/calendar-gates.mjs
//
// Deterministic, no model, no network: `buildCalendarScaffold` and
// `assignTasksToDays` are pure, so this suite bundles the real `src/utils/tree.ts`
// with esbuild and drives them directly. Section 9 alone opens a database, a
// scratch one (`DB_PATH` and `VAULT_ROOT` set in-process).
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
//
// Section 7 is the big-screen navigator: the toolbar's order, what each control
// says about its key, the keys themselves (any layout, once per press, only
// when the calendar or nothing has focus), focus on arrival, and the widths
// that switch the layout. It mounts the real components with React in jsdom.
//
// Section 8 is late work: a topic past its last day leaves its days and is
// counted once on today, opening the Day view's list; the course filter.
// It mounts the real `CalendarView` with the store and the API stubbed.
// Section 9 is the server sending that late work whatever the range.

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
//
// Everything below runs the REAL code: the toolbar, the key hook and the focus
// hook are mounted with React in jsdom, the pure rules are called. One esbuild
// bundle, written under node_modules (React stays external, and
// `require('react')` resolves from the file's own folder); every global it
// sets is put back in the `finally`.
console.log('\n--- the navigator sits with the name it changes; keys ---');
{
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const src = (p) => readFileSync(join(repo, p), 'utf8');
    const require = createRequire(import.meta.url);
    const { JSDOM } = require('jsdom');
    const { build } = await import('esbuild');

    const cache = join(repo, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const navScratch = mkdtempSync(join(cache, 'calendar-gates-'));
    const outfile = join(navScratch, 'calendar.cjs');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    const g = globalThis;
    const GLOBALS = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
        'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'];
    const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(g, k)]));
    // A keyboard is a fine pointer (`usePhysicalKeyboard`); flip this for a touchscreen.
    let finePointer = true;
    window.matchMedia = (q) => ({
        matches: finePointer && /pointer:\s*fine/.test(q), media: q,
        addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { },
    });
    try {
    // The app's `src/i18n` boots itself on import (stored language, locale
    // files); the date helpers need only the current language, so `locale.ts`
    // gets this one function, reading the i18next instance initialised below.
    const i18nStub = {
        name: 'i18n-stub',
        setup(b) {
            b.onResolve({ filter: /^\.\.\/i18n$/ }, (a) => /[\\/]utils[\\/]locale\.ts$/.test(a.importer)
                ? { path: 'i18n-stub', namespace: 'i18n-stub' } : undefined);
            b.onLoad({ filter: /.*/, namespace: 'i18n-stub' }, () => ({
                contents: "import i18next from 'i18next'; export const currentLocale = () => i18next.language || 'en';",
                resolveDir: repo, loader: 'js',
            }));
        },
    };
    await build({
        plugins: [i18nStub],
        stdin: {
            contents: `
                import * as React from 'react';
                import { createRoot } from 'react-dom/client';
                import i18n from 'i18next';
                import { initReactI18next } from 'react-i18next';
                import { CalendarNav } from './src/components/calendar/CalendarNav';
                export { keepDatePartsTogether } from './src/components/calendar/CalendarNav';
                export * from './src/components/calendar/calendarKeys';
                export * from './src/components/calendar/calendarLayout';
                import { useCalendarKeys, useCalendarFocusOnOpen } from './src/components/calendar/calendarKeys';
                export function initI18n(en) {
                    return i18n.use(initReactI18next).init({
                        lng: 'en', resources: { en: { translation: en } },
                        keySeparator: false, nsSeparator: false,
                        interpolation: { escapeValue: false },
                        react: { useSuspense: false }, initAsync: false,
                    });
                }
                const h = React.createElement;
                export function mountNav(el, props) {
                    const r = createRoot(el);
                    const noop = () => {};
                    React.act(() => r.render(h(CalendarNav, {
                        viewMode: 'week', onMode: noop, onPointerPick: noop, onPrev: noop, onNext: noop,
                        onToday: noop, title: 'Oct 26 – Nov 1, 2026', subtitle: 'Week 44', loading: false,
                        ...props,
                    })));
                    return () => React.act(() => r.unmount());
                }
                export { dateRangeLabel } from './src/utils/locale';
                export const setLanguage = (lng) => i18n.changeLanguage(lng);
                // \`root\` per render: the view renders first with no element
                // (its ref has not landed) and with it a render later.
                export function mountKeys(el, handlersFor) {
                    const r = createRoot(el);
                    function Probe({ n, root }) { useCalendarKeys(root, handlersFor(n)); return null; }
                    return {
                        render: (n, root = el) => React.act(() => r.render(h(Probe, { n, root }))),
                        unmount: () => React.act(() => r.unmount()),
                    };
                }
                export function mountFocus(el) {
                    const r = createRoot(el);
                    function Probe({ n }) {
                        const [node, setNode] = React.useState(null);
                        useCalendarFocusOnOpen(node);
                        return h('div', { ref: setNode, tabIndex: -1, id: 'cal', 'data-n': n }, h('button', { id: 'inside' }, 'chip'));
                    }
                    const render = (n) => React.act(() => r.render(h(Probe, { n })));
                    render(0);
                    return { render, unmount: () => React.act(() => r.unmount()) };
                }
                export const act = (fn) => React.act(fn);`,
            resolveDir: repo, loader: 'tsx',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile,
        jsx: 'automatic', packages: 'external', logLevel: 'silent',
    });

        Object.assign(g, {
            window, document: doc, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
            MutationObserver: window.MutationObserver, KeyboardEvent: window.KeyboardEvent,
            MouseEvent: window.MouseEvent, getComputedStyle: window.getComputedStyle.bind(window),
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        const cal = require(outfile);
        await cal.initI18n(JSON.parse(src('src/locales/en.json')));

        const host = () => { const el = doc.createElement('div'); doc.body.append(el); return el; };

        // -- the toolbar as RENDERED --------------------------------------------
        // Read in document order. The narrow toolbar (a phone, a side panel)
        // keeps the order the old wide one had, name first and the controls
        // after it, so it is this check's control: the same reading must tell
        // the two apart. A first redesign kept Month / Week / Day at the far
        // right edge; three strangers named the screen's width between it and
        // Today.
        const order = (narrow) => {
            const el = host();
            const unmount = cal.mountNav(el, { narrow });
            const all = [...el.querySelectorAll('*')];
            const pos = (pred) => all.findIndex(pred);
            const name = pos(e => e.tagName === 'H2');
            const read = {
                modes: pos(e => e.getAttribute('role') === 'radiogroup'),
                today: pos(e => e.tagName === 'BUTTON' && e.textContent.trim() === 'Today'),
                back: pos(e => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Previous period'),
                name,
                // A button after the name moves whenever the name changes width.
                controlsAfterName: all.filter((e, i) => i > name && e.tagName === 'BUTTON').length,
                pushed: el.querySelectorAll('[class~="ml-auto"],[class~="mr-auto"]').length,
            };
            // The phone's two rows, each edge to edge. One wrapping row of all
            // five left a strip of nothing at the right in English, and in
            // Russian at 390px ("Месяц Неделя День", "Сегодня") wrapped to a
            // third line. So: a two-column grid, four cells in reading order
            // (name, Today; switch, arrows). The first column takes the rest
            // of the width and the switch fills it (track w-full, segments
            // flex-1). Today and the arrows share the second column: Today
            // fills it and the two arrows split it, so Today's edges line up
            // with the arrows' outer edges whichever is wider.
            const bar = el.firstElementChild;
            const cells = bar ? [...bar.children] : [];
            const has = (e, c) => !!e?.classList.contains(c);
            const radios = [...el.querySelectorAll('[role="radio"]')];
            const group = all[read.modes];
            const back = all[read.back];
            const fwd = all.find(e => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Next period');
            read.switchFills = has(group, 'w-full') || radios.some(r => has(r, 'flex-1'));
            // The year beside the name rides on the name's TEXT baseline. With
            // the calendar icon inside the heading, the icon was the heading's
            // first flex item; an SVG has no text baseline, so the heading's
            // baseline was the icon's bottom edge and the year sat below the date.
            const h2 = all[name];
            read.sharedBaseline = !!h2 && !h2.querySelector('svg') && has(h2.parentElement, 'items-baseline');
            // Beside a Today as wide as the arrows, a Russian week's name and
            // "44-я неделя" do not fit one line: the label wraps under the name
            // rather than both being truncated.
            read.labelWraps = has(h2?.parentElement, 'flex-wrap');
            read.twoFullRows = has(bar, 'grid') && has(bar, 'grid-cols-[minmax(0,1fr)_auto]') && cells.length === 4
                && cells[0].contains(h2) && cells[1] === all[read.today]
                && cells[2].contains(group) && cells[3].contains(back)
                && has(group, 'w-full') && radios.length === 3 && radios.every(r => has(r, 'flex-1'));
            read.todayMatchesArrows = cells[1] === all[read.today] && has(cells[1], 'w-full')
                && cells[3] === back?.parentElement && has(cells[3], 'w-full') && cells[3].contains(fwd)
                && has(back, 'flex-1') && has(fwd, 'flex-1');
            unmount(); el.remove();
            return read;
        };
        const oneCluster = (o) => o.modes >= 0 && o.modes < o.today && o.today < o.back && o.back < o.name
            && o.controlsAfterName === 0 && o.pushed === 0;
        const w = order(false), n = order(true);
        check('wide: Month / Week / Day, Today, the arrows, then the period\'s name, in one cluster',
            oneCluster(w), JSON.stringify(w));
        check('wide: nothing pushed to the far edge, no control after the name',
            w.pushed === 0 && w.controlsAfterName === 0, JSON.stringify(w));
        check('control: the narrow toolbar keeps the name first, so the cluster reading tells them apart',
            n.name >= 0 && n.name < n.today && n.name < n.modes && !oneCluster(n), JSON.stringify(n));
        check('narrow: two rows edge to edge, name + Today, then the stretched view switch + the arrows',
            n.twoFullRows, JSON.stringify(n));
        check('narrow: Today spans exactly the two arrows (one grid column, Today fills it, the arrows split it)',
            n.todayMatchesArrows && !w.todayMatchesArrows, JSON.stringify({ wide: w.todayMatchesArrows, narrow: n.todayMatchesArrows }));
        check('narrow: the small label wraps under the name when both do not fit, never cutting the name',
            n.labelWraps, JSON.stringify({ narrow: n.labelWraps }));
        {
            // Under 20rem (a phone at 130–160% interface scale) two rows broke the
            // switch into chips and split "Sunday, Nov / 1": three full-width rows
            // instead, in reading order, Today filling the column the arrows sit
            // beside. And the date itself wraps (balanced), never cut to "…".
            const el = host();
            const unmount = cal.mountNav(el, { narrow: true, compact: true });
            const cells = [...(el.firstElementChild?.children ?? [])];
            const has = (e, c) => !!e?.classList.contains(c);
            const h2 = el.querySelector('h2');
            const today = [...el.querySelectorAll('button')].find(b => b.textContent.trim() === 'Today');
            const back = el.querySelector('button[aria-label="Previous period"]');
            const seen = {
                cells: cells.length,
                nameRow: has(cells[0], 'col-span-2') && !!cells[0]?.contains(h2),
                switchRow: has(cells[1], 'col-span-2') && !!cells[1]?.querySelector('[role="radiogroup"]'),
                todayThenArrows: cells[2] === today && has(today, 'w-full') && !!cells[3]?.contains(back),
                dateWraps: !has(h2, 'truncate') && has(h2, 'text-balance') && has(h2, 'break-words'),
            };
            unmount(); el.remove();
            check('compact: three full-width rows in reading order: name, switch, Today + arrows',
                seen.cells === 4 && seen.nameRow && seen.switchRow && seen.todayThenArrows, JSON.stringify(seen));
            check('narrow: the date wraps (balanced) rather than being cut off', seen.dateWraps, JSON.stringify(seen));
        }
        {
            // A wrap falls between whole dates: on a 320px phone the Russian week
            // broke as "26 окт. – 1" over "нояб. 2026 г.".
            const NB = ' ';
            const ru = cal.keepDatePartsTogether('26 окт. – 1 нояб. 2026 г.');
            const en = cal.keepDatePartsTogether('Oct 26 – Nov 1, 2026');
            const de = cal.keepDatePartsTogether('26. Okt. – 1. Nov. 2026');
            check('a date wraps between whole dates: "1 нояб.", "2026 г.", "Nov 1" stay together; the dash still breaks',
                ru === `26${NB}окт. – 1${NB}нояб.${NB}2026${NB}г.` && en === `Oct${NB}26 – Nov${NB}1, 2026`
                && de === `26.${NB}Okt. – 1.${NB}Nov.${NB}2026`,
                JSON.stringify({ ru, en, de }));
            const el = host();
            const unmount = cal.mountNav(el, { narrow: true, title: '26 окт. – 1 нояб. 2026 г.' });
            const shown = el.querySelector('h2')?.textContent;
            // The bar sits on the page's grey, the same step as the switch's
            // track: in the light theme the track vanished. An inset hairline,
            // light only; an inset SHADOW, not a ring, which is focus's channel.
            const track = el.querySelector('[role="radiogroup"]');
            const edge = !!track?.className.includes('shadow-[inset_0_0_0_1px') && track.classList.contains('dark:shadow-none')
                && !/(^|\s)ring-/.test(track.className);
            unmount(); el.remove();
            check('the narrow bar shows the glued date', shown === ru, JSON.stringify(shown));
            check('the view switch\'s track has an edge in the light theme (inset shadow, never a ring)', edge,
                track?.className);
        }
        check('the year sits on the name\'s text baseline, wide and narrow (no icon inside the heading)',
            w.sharedBaseline && n.sharedBaseline, JSON.stringify({ wide: w.sharedBaseline, narrow: n.sharedBaseline }));
        check('wide: the view switch keeps its own width (fills only on a phone)',
            !w.switchFills && n.switchFills, JSON.stringify({ wide: w.switchFills, narrow: n.switchFills }));

        // -- what each control says about its key -------------------------------
        const controls = (fine) => {
            finePointer = fine;
            const el = host();
            const unmount = cal.mountNav(el, { narrow: false });
            const month = [...el.querySelectorAll('[role="radio"]')].find(b => b.textContent.trim() === 'Month');
            const today = [...el.querySelectorAll('button')].find(b => b.textContent.trim() === 'Today');
            const back = [...el.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Previous'));
            const next = [...el.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Next'));
            const read = {
                monthTitle: month?.getAttribute('title'), todayTitle: today?.getAttribute('title'),
                backTitle: back?.getAttribute('title'), backName: back?.getAttribute('aria-label'),
                keys: [month, today, back, next].map(b => b?.getAttribute('aria-keyshortcuts')),
            };
            unmount(); el.remove();
            finePointer = true;
            return read;
        };
        const kb = controls(true), touch = controls(false);
        check('with a keyboard each tooltip names its key: "Month (M)", "Today (T)", "Previous period (←)"',
            kb.monthTitle === 'Month (M)' && kb.todayTitle === 'Today (T)' && kb.backTitle === 'Previous period (←)',
            JSON.stringify(kb));
        check('on a touchscreen no key is offered; the arrows keep their plain name as the tooltip',
            touch.monthTitle == null && touch.todayTitle == null && touch.backTitle === 'Previous period',
            JSON.stringify(touch));
        check('the accessible name is "Previous period", never the arrow read aloud',
            kb.backName === 'Previous period' && touch.backName === 'Previous period', kb.backName);
        check('aria-keyshortcuts on Month, Today, ← and →',
            JSON.stringify(kb.keys) === JSON.stringify(['M', 'T', 'ArrowLeft', 'ArrowRight']), JSON.stringify(kb.keys));
        check('…and none on a touchscreen, where a reader would announce a key nobody can press',
            touch.keys.every(k => k == null), JSON.stringify(touch.keys));

        // -- a pointer pick hands focus back -------------------------------------
        // A radio clicked with a mouse keeps focus, and on a radiogroup ← / →
        // walk the radios: the next → meant for "Next period" switched the view.
        {
            let picks = 0;
            const el = host();
            const unmount = cal.mountNav(el, { narrow: false, onPointerPick: () => { picks++; } });
            const day = [...el.querySelectorAll('[role="radio"]')].find(b => b.textContent.trim() === 'Day');
            const click = (detail) => cal.act(() => {
                day.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail }));
            });
            click(1);
            const afterMouse = picks;
            click(0);
            check('a mouse click on Month / Week / Day hands focus back to the calendar; a keyboard pick does not',
                afterMouse === 1 && picks === 1, `mouse ${afterMouse}, then keyboard ${picks - afterMouse}`);
            unmount(); el.remove();
        }

        // -- the key hook -------------------------------------------------------
        {
            const el = host();
            const calls = [];
            let adds = 0;
            const addEventListener = window.addEventListener;
            window.addEventListener = function (type, ...rest) { if (type === 'keydown') adds++; return addEventListener.call(this, type, ...rest); };
            const hook = cal.mountKeys(el, (n) => ({
                prev: () => calls.push(`${n}:prev`), next: () => calls.push(`${n}:next`),
                today: () => calls.push(`${n}:today`), view: (m) => calls.push(`${n}:${m}`),
            }));
            hook.render(1); hook.render(2); hook.render(3);
            window.addEventListener = addEventListener;
            const press = (init) => {
                const e = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
                doc.body.dispatchEvent(e);
                return e;
            };
            check('the key listener is attached once across three renders', adds === 1, `${adds} listener(s) added`);
            const right = press({ key: 'ArrowRight', code: 'ArrowRight' });
            check('a press calls the LATEST render\'s handler', calls.at(-1) === '3:next', calls.join());
            check('…and claims the key (preventDefault)', right.defaultPrevented);
            const before = calls.length;
            press({ key: 'ArrowRight', code: 'ArrowRight', repeat: true });
            check('a held key acts once: an auto-repeat is ignored', calls.length === before, calls.slice(before).join());
            press({ key: 'ь', code: 'KeyM' });
            check('on a Russian layout the key printed M ("ь") picks the month', calls.at(-1) === '3:month', calls.at(-1));
            hook.unmount();
            const after = calls.length;
            press({ key: 'ArrowLeft', code: 'ArrowLeft' });
            check('unmounted, the calendar hears nothing', calls.length === after, calls.slice(after).join());
            el.remove();
        }
        {
            // The view's root is null on its first render and lands a render
            // later; a hook that kept the first root would refuse every press
            // made from inside the calendar (a focused chip).
            const el = host();
            // Its own element: React empties the container it mounts into.
            const calRoot = host();
            const chip = doc.createElement('button'); calRoot.append(chip);
            const calls = [];
            const hook = cal.mountKeys(el, (n) => ({
                prev: () => calls.push(`${n}:prev`), next: () => calls.push(`${n}:next`),
                today: () => calls.push(`${n}:today`), view: (m) => calls.push(`${n}:${m}`),
            }));
            hook.render(1, null); hook.render(2, calRoot);
            chip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
            check('a root that arrives a render late still counts: a press on a chip inside it steps',
                calls.join() === '2:next', calls.join() || 'nothing');
            hook.unmount(); el.remove(); calRoot.remove();
        }

        // -- which press is the calendar's ----------------------------------------
        {
            const el = (tag, attrs = {}) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
            const root = el('div');
            const chipBtn = el('button');
            const field = el('input', { type: 'text' });
            const select = el('select');
            const combo = el('button', { role: 'combobox' });
            const modes = el('div', { role: 'radiogroup' }); const modeBtn = el('button', { role: 'radio' }); modes.append(modeBtn);
            root.append(chipBtn, field, select, combo, modes);
            const tree = el('nav'); const treeRow = el('button'); tree.append(treeRow);
            doc.body.append(tree, root);
            const press = (key, target, extra = {}) =>
                cal.calendarKey({ key, code: '', target, defaultPrevented: false, ...extra }, root, doc);

            check('← and → with nothing focused step the period',
                press('ArrowLeft', doc.body) === 'prev' && press('ArrowRight', doc.body) === 'next');
            check('t, m, w, d: today and the three views (Caps Lock too)',
                press('t', doc.body) === 'today' && press('m', doc.body) === 'month'
                && press('W', doc.body) === 'week' && press('d', doc.body) === 'day');
            check('Dvorak: the letter the layout types wins over the key\'s position',
                press('w', doc.body, { code: 'Comma' }) === 'week' && press(',', doc.body, { code: 'KeyW' }) === null);
            check('focus on a chip in the calendar: still the calendar\'s', press('ArrowRight', chipBtn) === 'next');
            check('NOT from the course tree beside it (its arrows are its own)',
                press('ArrowLeft', treeRow) === null && press('d', treeRow) === null);
            // Editable text is `isTextEntry`'s, held in keyboard-gates (jsdom has no isContentEditable).
            check('NOT while typing, in a select or a combobox',
                press('t', field) === null && press('ArrowLeft', field) === null && press('m', select) === null
                && press('m', combo) === null);
            check('NOT while an input method is composing', press('t', doc.body, { isComposing: true }) === null);
            check('NOT on an auto-repeat', press('ArrowRight', doc.body, { repeat: true }) === null);
            check('an arrow on the view switch moves along the switch; a letter there still works',
                press('ArrowRight', modeBtn) === null && press('m', modeBtn) === 'month');
            check('NOT with a modifier held (Ctrl+← is the browser\'s)',
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

            // -- may the calendar take focus as it opens? --------------------------
            const link = el('a', { href: '#calendar' }); doc.body.append(link);
            const may = (focus) => { if (focus) focus.focus(); else doc.activeElement?.blur?.(); return cal.calendarMayTakeFocus(root, doc); };
            check('it takes focus from nothing, or from the link that opened it',
                may(null) && may(link));
            check('…never from text being typed, a select, a combobox, or focus already inside it',
                !may(field) && !may(select) && !may(combo) && !may(chipBtn));
            doc.body.append(dialog);
            check('…never from under a modal dialog', !may(link));
            dialog.remove();
            doc.body.append(session);
            check('…nor from under a review session', !may(link));
            session.remove();
            tree.remove(); root.remove(); link.remove();
        }

        // -- the focus hook, mounted --------------------------------------------
        {
            const outside = doc.createElement('a'); outside.href = '#calendar'; doc.body.append(outside);
            outside.focus();
            const el = host();
            let probe = cal.mountFocus(el);
            check('opened from a link, the calendar takes focus, so its keys work before a click',
                doc.activeElement?.id === 'cal', doc.activeElement?.tagName);
            // Once only: the view re-renders on every resize tick, and focus the
            // learner has since moved elsewhere must stay where they put it.
            outside.focus();
            probe.render(1); probe.render(2);
            check('…once: re-renders after that leave focus where the learner moved it',
                doc.activeElement === outside, doc.activeElement?.id || doc.activeElement?.tagName);
            probe.unmount();
            const input = doc.createElement('input'); doc.body.append(input); input.focus();
            probe = cal.mountFocus(el);
            check('…but leaves a text field that has focus alone', doc.activeElement === input, doc.activeElement?.tagName);
            probe.unmount(); el.remove(); input.remove(); outside.remove();
        }

        // -- which layout, from the calendar's own width ------------------------
        // -- a chip's days: the year is in the title above ---------------------
        // Pinned dates, so nothing here reads the clock.
        {
            const d = (s) => new Date(`${s}T00:00:00Z`);
            const short = cal.dateRangeLabel(d('2026-10-30'), d('2026-11-02'), { year: false });
            const full = cal.dateRangeLabel(d('2026-10-30'), d('2026-11-02'));
            const again = cal.dateRangeLabel(d('2026-10-30'), d('2026-11-02'), { year: false });
            check('a chip\'s span leaves the year out ("Oct 30 – Nov 2"); the full label keeps it',
                /Oct 30/.test(short) && /Nov 2/.test(short) && !/2026/.test(short) && /2026/.test(full) && again === short,
                `${short} | ${full}`);
            await cal.setLanguage('ru');
            const ru = cal.dateRangeLabel(d('2026-10-30'), d('2026-11-02'), { year: false });
            await cal.setLanguage('en');
            check('…in the interface language, each language and shape its own formatter',
                /окт/.test(ru) && !/2026/.test(ru) && cal.dateRangeLabel(d('2026-10-30'), d('2026-11-02'), { year: false }) === short, ru);
        }

        check('narrow below 640px, a grid from 640', cal.isNarrowCalendar(639) && !cal.isNarrowCalendar(640));
        // A 390px phone at 160% is 15.2rem; a 320px phone at 100% is 20rem and
        // keeps the two rows. In rem, so the interface scale moves the line.
        check('compact below 20rem: 319/320 at 16px, 399/400 at 20px',
            cal.isCompactCalendar(319, 16) && !cal.isCompactCalendar(320, 16)
            && cal.isCompactCalendar(399, 20) && !cal.isCompactCalendar(400, 20));
        check('a week is columns from 1000px; below, a row per day; month and day never columns',
            !cal.isWeekGrid('week', 999) && cal.isWeekGrid('week', 1000)
            && !cal.isWeekGrid('month', 2560) && !cal.isWeekGrid('day', 2560));
        // At 1280 a column is ~180px: the state and the dates filled the line and
        // the course was cut to "· …" while the legend was gone. From 20rem a
        // column, in rem so a larger interface scale needs a wider calendar.
        const names = cal.chipsNameCourse;
        check('a week column names its course from 20rem: 2240px at 100%, not 2239',
            names('week', 2240, 16) && !names('week', 2239, 16) && !names('week', 1280, 16));
        check('…at 125% it needs 2800px', !names('week', 2240, 20) && names('week', 2800, 20));
        check('the day list always names it; the month never does',
            names('day', 400, 16) && !names('month', 2560, 16));
    } finally {
        for (const [k, d] of Object.entries(saved)) {
            if (d) Object.defineProperty(g, k, d); else delete g[k];
        }
        window.close();
        rmSync(navScratch, { recursive: true, force: true });
    }

    // -- the wiring: the view uses the rules above -------------------------------
    const view = src('src/components/calendar/CalendarView.tsx');
    const wired = [
        ['the keys', /useCalendarKeys\(rootEl, \{ prev, next, today: goToday, view: switchViewMode \}\)/],
        ['focus on open', /useCalendarFocusOnOpen\(rootEl\)/],
        ['the week grid', /isWeekGrid\(viewMode, width\)/],
        ['course names on chips', /chipsNameCourse\(viewMode, width, rootFontSize\)/],
        ['the narrow toolbar', /isNarrowCalendar\(width\)/],
        ['the compact toolbar, in rem', /compact=\{isCompactCalendar\(width, rootFontSize\)\}/],
        ['a root that can hold focus', /ref=\{setRootEl\} tabIndex=\{-1\}/],
        ['a pointer pick focusing the root', /onPointerPick=\{\(\) => rootEl\?\.focus\(/],
        ['a chip\'s days without the year', /dateRangeLabel\(parseDate\(task\.start\), parseDate\(task\.end\), \{ year: false \}\)/],
    ];
    for (const [what, re] of wired) check(`CalendarView wires ${what}`, re.test(view));
    const weekGridFn = /function renderWeekGrid\([\s\S]*?\n {4}\}/.exec(view)?.[0] ?? '';
    check('a wide week\'s chips get the roomy line (the days a topic runs; its course when wide enough)',
        /chip\(task, false, undefined, true\)/.test(weekGridFn), weekGridFn ? 'renderWeekGrid does not pass roomy' : 'no renderWeekGrid');
    // The course key is a filter shown in every view now (section 8 mounts it);
    // the chip still names its course only where it is wide enough.
    check('a chip names its course where the column is wide enough',
        /const owner = roomy && chipsNameOwner \?/.test(view));
    check('a chip that runs several days says which days, and its course on a line of its own',
        /\{span && <span[^>]*>\{span\}<\/span>\}/.test(view) && /\{owner && <span[^>]*break-words[^>]*>\{owner\}<\/span>\}/.test(view));
    const settings = src('src/components/settings/GeneralSettings.tsx');
    check('Settings → Keyboard shortcuts lists the calendar\'s keys',
        ['prev', 'next', 'today', 'month', 'week', 'day'].every(k => settings.includes(`CALENDAR_KEYCAPS.${k}`)));
}

// ---- 8. late work is owed TODAY, once, in every view --------------------------
// Drawn on its planned days, late work was a wall of red on whichever past days
// a period showed (eleven "Overdue" chips on one Monday) and invisible
// everywhere else: a topic that ended before the period touched no day on
// screen, so a course 37 days behind showed one late chip, and the Day view of
// today showed none. Now it leaves its days and sits once on today, as a group
// that opens the Day view's list (under the day's own plan); the Today button
// carries the count only while today is off screen; the
// course key is a filter in every view; a long course name is never cut.
//
// The real `CalendarView` is mounted in jsdom, with the store and the API
// replaced by stand-ins holding a fixture and the clock pinned to Wednesday
// 4 November 2026 (12:00 UTC), so nothing here reads the real date.
const T_TODAY = '2026-11-04';
console.log('\n--- late work: one group on today, a Day list, a course filter ---');
{
    const late = tree.splitLateTasks;
    const T = T_TODAY;
    const rows = [
        task(101, 'SN1 and SN2', '2026-10-12', '2026-10-16'),
        task(102, 'E1 and E2', '2026-10-19', '2026-10-23', 'in_progress'),
        task(103, 'Alkenes', '2026-10-30', '2026-11-03'),
        { ...task(105, 'Matrices', '2026-10-26', '2026-11-02'), provable: true },
        task(106, 'Por and para', '2026-11-02', '2026-11-03', 'completed'),
        task(107, 'Aromaticity', '2026-11-03', '2026-11-06', 'in_progress'),
        task(110, 'Skipped', '2026-10-01', '2026-10-02', 'skipped'),
    ];
    const split = late ? late(rows, T) : null;
    check('splitLateTasks exists (src/utils/tree.ts)', typeof late === 'function');
    check('open and past its last day: overdue, oldest first, wherever its dates fall',
        JSON.stringify(split?.overdue.map(t => t.nodeId)) === '[101,102,103]', JSON.stringify(split?.overdue.map(t => t.nodeId)));
    check('late but known (ready to prove) is its own list, never "overdue"',
        JSON.stringify(split?.ready.map(t => t.nodeId)) === '[105]', JSON.stringify(split?.ready.map(t => t.nodeId)));
    check('done, skipped, and work whose span reaches today stay on their days',
        JSON.stringify(split?.onDays.map(t => t.nodeId).sort()) === '[106,107,110]', JSON.stringify(split?.onDays.map(t => t.nodeId)));
}
{
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const require = createRequire(import.meta.url);
    const { JSDOM } = require('jsdom');
    const { build } = await import('esbuild');
    const cache = join(repo, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const viewScratch = mkdtempSync(join(cache, 'calendar-view-gates-'));
    const outfile = join(viewScratch, 'view.cjs');

    // The fixture: three courses, Wednesday 4 November 2026, the week Nov 2–8.
    const LONG = 'Organic Chemistry: Reaction Mechanisms and Synthesis Planning for the Final Exam';
    const PROJECTS = [
        { id: 1, name: LONG, color: '#DC2626', scheduled: true },
        { id: 2, name: 'Linear Algebra', color: '#2563EB', scheduled: true },
        { id: 3, name: 'Spanish B1', color: '#16A34A', scheduled: true },
        // Dated, with nothing in any period the gate pages through: the row
        // must still list it, or it would come and go as the learner pages.
        { id: 4, name: 'Music Theory', color: '#EA580C', scheduled: true },
        // Undated: in the row only while a fetched period holds its work.
        { id: 5, name: 'Chess Openings', color: '#7C3AED', scheduled: false },
    ];
    const row = (nodeId, projectId, title, s, e, status = 'not_started', provable = false) =>
        ({ nodeId, projectId, title, status, scheduled_start: s, scheduled_end: e, provable });
    const TASKS = [
        row(101, 1, 'SN1 and SN2', '2026-10-12', '2026-10-16'),
        row(102, 1, 'E1 and E2', '2026-10-19', '2026-10-23', 'in_progress'),
        row(103, 1, 'Alkenes', '2026-10-30', '2026-11-03'),
        row(104, 2, 'Determinants', '2026-11-02', '2026-11-03'),
        row(105, 2, 'Matrices', '2026-10-26', '2026-11-02', 'not_started', true),
        row(106, 3, 'Por and para', '2026-11-02', '2026-11-03', 'completed'),
        row(107, 1, 'Aromaticity', '2026-11-03', '2026-11-06', 'in_progress'),
        row(108, 2, 'Eigenvalues', '2026-11-05', '2026-11-09'),
        row(109, 3, 'Subjunctive', '2026-11-04', '2026-11-04'),
        row(110, 5, 'Italian Game', '2026-11-02', '2026-11-08', 'in_progress'),
    ];
    const LATE = [101, 102, 103, 104, 105];
    // LOCAL noon: `todayStr()` reads local getters, and UTC noon is already
    // the 5th in UTC+12 to +14.
    const NOW = new Date(2026, 10, 4, 12).getTime();

    // The store and the API, replaced. The view reads both through these two
    // module paths and nothing else here.
    const stubs = {
        name: 'calendar-view-stubs',
        setup(b) {
            b.onResolve({ filter: /^\.\.\/i18n$/ }, (a) => /[\\/]utils[\\/]locale\.ts$/.test(a.importer)
                ? { path: 'i18n', namespace: 'stub' } : undefined);
            b.onResolve({ filter: /^\.\.\/\.\.\/(store|api)$/ }, (a) => /[\\/]calendar[\\/]CalendarView\.tsx$/.test(a.importer)
                ? { path: a.path.slice(6), namespace: 'stub' } : undefined);
            // The gate's own handle on the SAME stand-in store the view reads.
            b.onResolve({ filter: /^stub:store$/ }, () => ({ path: 'store', namespace: 'stub' }));
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
                resolveDir: repo, loader: 'js',
                contents: a.path === 'i18n'
                    ? "import i18next from 'i18next'; export const currentLocale = () => i18next.language || 'en';"
                    : a.path === 'store'
                        ? `import { create } from 'zustand';
                           export const useStore = create(() => ({
                               addToast: () => {}, weekStartDay: 1, projects: [], tree: [],
                               selectedNodeId: null, selectNode: () => {}, paceData: null,
                           }));`
                        : 'export const api = { getCalendarRange: (from, to) => Promise.resolve(globalThis.__calendarRange(from, to)) };',
            }));
        },
    };
    await build({
        plugins: [stubs],
        stdin: {
            contents: `
                import * as React from 'react';
                import { createRoot } from 'react-dom/client';
                import { MemoryRouter } from 'react-router-dom';
                import i18n from 'i18next';
                import { initReactI18next } from 'react-i18next';
                import CalendarView from './src/components/calendar/CalendarView';
                export { useStore } from 'stub:store';
                export function initI18n(en) {
                    return i18n.use(initReactI18next).init({
                        lng: 'en', resources: { en: { translation: en } },
                        keySeparator: false, nsSeparator: false,
                        interpolation: { escapeValue: false },
                        react: { useSuspense: false }, initAsync: false,
                    }).then(() => {
                        // Section 7 left the shared instance in another language.
                        i18n.addResourceBundle('en', 'translation', en, true, true);
                        return i18n.changeLanguage('en');
                    });
                }
                export function mount(el, scope) {
                    const r = createRoot(el);
                    React.act(() => r.render(React.createElement(MemoryRouter, null,
                        React.createElement(CalendarView, { scope }))));
                    return () => React.act(() => r.unmount());
                }
                export const act = (fn) => React.act(fn);`,
            resolveDir: repo, loader: 'tsx',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile,
        jsx: 'automatic', packages: 'external', logLevel: 'silent',
    });

    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    const g = globalThis;
    const GLOBALS = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'KeyboardEvent',
        'MouseEvent', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver', 'requestAnimationFrame',
        'cancelAnimationFrame', 'navigator', 'Date', '__calendarRange'];
    const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(g, k)]));
    window.matchMedia = (q) => ({
        matches: /pointer:\s*fine/.test(q), media: q,
        addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { },
    });
    // The calendar lays itself out by its OWN width (a ResizeObserver).
    let width = 1280;
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return width; } });
    const observers = new Set();
    class RO {
        constructor(cb) { this.cb = cb; }
        observe() { observers.add(this); }
        unobserve() { }
        disconnect() { observers.delete(this); }
    }
    const RealDate = Date;
    class PinnedDate extends RealDate {
        constructor(...a) { super(...(a.length ? a : [NOW])); }
        static now() { return NOW; }
    }
    try {
        Object.assign(g, {
            window, document: doc, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
            MutationObserver: window.MutationObserver, KeyboardEvent: window.KeyboardEvent,
            MouseEvent: window.MouseEvent, getComputedStyle: window.getComputedStyle.bind(window),
            IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: RO,
            requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: (t) => clearTimeout(t),
            Date: PinnedDate,
        });
        window.ResizeObserver = RO;
        // The new server contract: everything touching the range, and every
        // open topic past its end wherever its dates fall.
        g.__calendarRange = (from, to) => ({
            projects: PROJECTS,
            tasks: TASKS.filter(t => (t.scheduled_start <= to && t.scheduled_end >= from)
                || (t.scheduled_end < '2026-11-04' && t.status !== 'completed' && t.status !== 'skipped')),
        });
        const view = require(outfile);
        await view.initI18n(JSON.parse(readFileSync(join(repo, 'src/locales/en.json'), 'utf8')));
        const settle = async () => { for (let i = 0; i < 4; i++) await view.act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
        const resize = async (w) => { width = w; await view.act(async () => { for (const o of observers) o.cb([]); }); await settle(); };

        const host = doc.createElement('div'); doc.body.append(host);
        const unmount = view.mount(host, { kind: 'global' });
        await settle();
        await resize(1280);

        const curr = () => host.querySelector('[data-panel="curr"]') ?? host;
        const ids = (root) => [...root.querySelectorAll('[data-node-id]')].map(e => Number(e.getAttribute('data-node-id')));
        const radio = (name) => [...host.querySelectorAll('[role="radio"]')].find(r => r.textContent.trim() === name);
        // A miss is a FAIL of its own: a silent no-op would let a later check
        // test the same view twice and pass.
        const click = async (el, what = 'a control') => {
            if (!el) { check(`there is ${what} to press`, false); return; }
            await view.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
            await settle();
        };
        const todayCell = () => curr().querySelector('[data-date="2026-11-04"]');
        const group = (kind, root = todayCell()) => root?.querySelector(`[data-late-group="${kind}"]`);
        const legendNames = () => [...host.querySelectorAll('[role="group"][data-course-filter] button')].map(b => b.textContent.trim());
        const badge = () => host.querySelector('[data-overdue-count]')?.getAttribute('data-overdue-count') ?? null;

        // -- the week ----------------------------------------------------------
        await click(radio('Week'));
        const weekIds = ids(curr());
        check('week: no late topic is drawn on a day (no red wall on Monday)',
            LATE.every(id => !weekIds.includes(id)), `drawn: ${weekIds.filter(id => LATE.includes(id))}`);
        check('week: today holds ONE group for the overdue work, counting even a topic that ended weeks ago',
            /^4 overdue/.test(group('overdue')?.textContent.trim() ?? ''), group('overdue')?.textContent ?? 'no group on today');
        check('week: late but known is a group of its own on today, not red',
            /^1 ready to prove/i.test(group('ready')?.textContent.trim() ?? '') && !/red/.test(group('ready')?.innerHTML ?? 'red'),
            group('ready')?.textContent ?? 'no ready group');
        const onDay = (id) => curr().querySelector(`[data-node-id="${id}"]`)?.closest('[data-date]')?.getAttribute('data-date');
        check('week: work that is not late keeps its day (done Monday, under way from Tuesday, Thursday, today)',
            onDay(106) === '2026-11-02' && onDay(107) === '2026-11-03' && onDay(108) === '2026-11-05' && onDay(109) === T_TODAY,
            JSON.stringify([106, 107, 108, 109].map(onDay)));
        // Three strangers read "Today 24" beside "24 overdue" as two counts, one
        // of them "24 things today": the number is said once, where it is.
        check('the Today button carries no count while today is on screen (the group there says it)',
            badge() === null, String(badge()));
        await click(host.querySelector('button[aria-label="Next period"]'));
        check('…and carries the overdue count once today is off screen, the one way back to it',
            badge() === '4', String(badge()));
        await click(host.querySelector('button[aria-label="Previous period"]'));

        // -- the group opens the Day view's list -------------------------------
        await click(group('overdue'), 'an overdue group on today (week)');
        const dayOn = radio('Day')?.getAttribute('aria-checked') === 'true';
        const list = (kind) => [...(host.querySelector(`[data-panel="curr"] [data-late-list="${kind}"]`)?.querySelectorAll('[data-node-id]') ?? [])]
            .map(e => Number(e.getAttribute('data-node-id')));
        check('pressing the group opens the Day view of today', dayOn && /Wednesday/.test(host.querySelector('h2')?.textContent ?? ''),
            `${dayOn} ${host.querySelector('h2')?.textContent}`);
        check('Day view of today lists every overdue topic, oldest first',
            JSON.stringify(list('overdue')) === '[101,102,103,104]', JSON.stringify(list('overdue')));
        check('…and the ready ones in their own list', JSON.stringify(list('ready')) === '[105]', JSON.stringify(list('ready')));
        check('…and still the day\'s own work', ids(curr()).includes(109), JSON.stringify(ids(curr())));
        // Twenty-four red cards above the day's plan pushed "Planned for today"
        // below the fold at 1280 and off a phone screen: the plan comes first,
        // and the group the learner pressed is brought to them instead.
        const planned = curr().querySelector('[data-day-planned]');
        const firstLate = curr().querySelector('[data-late-list]');
        check('Day view of today puts the day\'s own plan first, the late lists under it',
            !!planned && !!firstLate && !!(planned.compareDocumentPosition(firstLate) & window.Node.DOCUMENT_POSITION_FOLLOWING),
            `${planned ? 'plan' : 'no [data-day-planned]'} / ${firstLate ? 'late' : 'no late list'}`);
        check('pressing a group focuses ITS list\'s heading',
            !!doc.activeElement?.matches('[data-late-list="overdue"] > h3'),
            doc.activeElement?.outerHTML.slice(0, 80) ?? 'nothing focused');
        const dayBox = curr().querySelector('[data-day-list]');
        check('Day view uses its width: an auto-fill grid, not one centred column',
            !!dayBox && /auto-fill/.test(dayBox.className) && !curr().querySelector('.max-w-2xl'), dayBox?.className ?? 'no [data-day-list]');
        const named = [101, 102, 103, 107].map(id => curr().querySelector(`[data-node-id="${id}"]`)?.textContent.includes(LONG) ?? false);
        check('Day view names the course on EVERY chip of it, the long name whole',
            named.every(Boolean), JSON.stringify(named));
        await click(host.querySelector('button[aria-label="Next period"]'));
        check('the Day view of another day has no late list (it is owed today, not tomorrow)',
            !host.querySelector('[data-panel="curr"] [data-late-list]'));

        // -- the month ----------------------------------------------------------
        await click(radio('Month'));
        const monthIds = ids(curr());
        check('month: no late topic in any cell', LATE.every(id => !monthIds.includes(id)),
            `drawn: ${monthIds.filter(id => LATE.includes(id))}`);
        check('month: today\'s cell holds the overdue group', /^4 overdue/.test(group('overdue')?.textContent.trim() ?? ''),
            group('overdue')?.textContent ?? 'none');
        // The cell itself opens its day as a WEEK on a desktop: the group's
        // press must not reach it.
        await click(group('overdue'), 'an overdue group on today (month)');
        check('month: pressing the group in today\'s cell opens the Day list, not the cell\'s week',
            radio('Day')?.getAttribute('aria-checked') === 'true' && !!host.querySelector('[data-panel="curr"] [data-late-list="overdue"]'),
            `day: ${radio('Day')?.getAttribute('aria-checked')}`);
        await click(radio('Month'));
        await click(group('ready'), 'a ready group on today (month)');
        check('pressing the OTHER group focuses its own list\'s heading, not the overdue one',
            !!doc.activeElement?.matches('[data-late-list="ready"] > h3'),
            doc.activeElement?.outerHTML.slice(0, 80) ?? 'nothing focused');
        await click(radio('Month'));

        // -- the course filter, the same in every view ---------------------------
        const names = {};
        for (const [mode, w] of [['Month', 1280], ['Week', 1280], ['Week', 2560], ['Day', 1280]]) {
            await resize(w); await click(radio(mode));
            names[`${mode}@${w}`] = legendNames().join(' | ');
        }
        const want = ['All courses', LONG, 'Linear Algebra', 'Spanish B1', 'Music Theory', 'Chess Openings'].join(' | ');
        check('the course filter is there in every view and width, listing the same courses',
            Object.values(names).every(n => n === want), JSON.stringify(names));
        await resize(1280); await click(radio('Week'));
        const pill = (name) => [...host.querySelectorAll('[data-course-filter] button')].find(b => b.textContent.trim() === name);
        check('each course is a toggle; "All courses" is pressed while nothing is picked',
            pill('All courses')?.getAttribute('aria-pressed') === 'true' && pill('Linear Algebra')?.getAttribute('aria-pressed') === 'false');
        await click(pill('Linear Algebra'));
        const only2 = ids(curr());
        check('picking a course shows only its work', only2.includes(108) && !only2.includes(107) && !only2.includes(109),
            JSON.stringify(only2));
        check('…and the count follows it', /^1 overdue/.test(group('overdue')?.textContent.trim() ?? ''),
            `${group('overdue')?.textContent}`);
        // A tint read as "not picked" to two strangers: the picked pill is FILLED.
        check('a picked course is filled, and "All courses" is not',
            /(^|\s)bg-accent(\s|$)/.test(pill('Linear Algebra')?.className ?? '')
            && !/(^|\s)bg-accent(\s|$)/.test(pill('All courses')?.className ?? 'bg-accent'),
            `${pill('Linear Algebra')?.className}`);
        await click(pill('Linear Algebra'));
        check('picking it again shows every course',
            ids(curr()).includes(107) && /^4 overdue/.test(group('overdue')?.textContent.trim() ?? ''), `${group('overdue')?.textContent}`);
        check('a course\'s filter pill carries its whole name (title too, for a phone it no longer fits)',
            pill(LONG)?.getAttribute('title') === LONG);
        // A picked course that leaves the library (archived while picked)
        // must not keep filtering everything to nothing with no pill pressed.
        await click(pill('Linear Algebra'), 'a "Linear Algebra" filter pill');
        const fullRange = g.__calendarRange;
        g.__calendarRange = (from, to) => {
            const r = fullRange(from, to);
            return { projects: r.projects.filter(p => p.id !== 2), tasks: r.tasks.filter(t => t.projectId !== 2) };
        };
        await click(host.querySelector('button[aria-label="Next period"]'));
        await click(host.querySelector('button[aria-label="Previous period"]'));
        check('a picked course that is gone stops filtering: every other course shows, "All courses" pressed',
            /^3 overdue/.test(group('overdue')?.textContent.trim() ?? '') && pill('All courses')?.getAttribute('aria-pressed') === 'true',
            `${group('overdue')?.textContent} / ${pill('All courses')?.getAttribute('aria-pressed')}`);
        g.__calendarRange = fullRange;
        await click(host.querySelector('button[aria-label="Next period"]'));
        await click(host.querySelector('button[aria-label="Previous period"]'));
        check('…and it stays forgotten when the course is back',
            pill('Linear Algebra')?.getAttribute('aria-pressed') === 'false' && pill('All courses')?.getAttribute('aria-pressed') === 'true',
            `${pill('Linear Algebra')?.getAttribute('aria-pressed')} / ${pill('All courses')?.getAttribute('aria-pressed')}`);
        // An undated course leaves the row in a period with none of its work;
        // paging there and back is not the learner un-picking it.
        await click(pill('Chess Openings'), 'a "Chess Openings" filter pill');
        await click(host.querySelector('button[aria-label="Next period"]'));
        await click(host.querySelector('button[aria-label="Next period"]'));
        check('a picked undated course off the row for a period stops filtering there',
            !pill('Chess Openings') && pill('All courses')?.getAttribute('aria-pressed') === 'true',
            `${pill('Chess Openings') ? 'still listed' : 'gone'} / ${pill('All courses')?.getAttribute('aria-pressed')}`);
        await click(host.querySelector('button[aria-label="Previous period"]'));
        await click(host.querySelector('button[aria-label="Previous period"]'));
        check('…and is still picked when paging brings it back',
            pill('Chess Openings')?.getAttribute('aria-pressed') === 'true' && JSON.stringify(ids(curr()).filter((v, i, a) => a.indexOf(v) === i)) === '[110]',
            `${pill('Chess Openings')?.getAttribute('aria-pressed')} ${JSON.stringify(ids(curr()))}`);
        await click(pill('Chess Openings'));

        // -- a long course name on a wide week's chip ------------------------------
        await resize(2560);
        const chip107 = curr().querySelector('[data-node-id="107"]');
        const owner = [...(chip107?.querySelectorAll('span') ?? [])].find(s => s.textContent.trim() === LONG);
        check('a 2560px week chip names its course whole: its own line, wrapped, never truncated',
            !!owner && !/truncate/.test(owner.className), owner ? owner.className : 'no span holding the whole name');

        // -- a phone ------------------------------------------------------------------
        await resize(390); await click(radio('Week'));
        // Six long names wrapped into five rows took ~300 of a phone's 844px.
        const filterRow = host.querySelector('[data-course-filter]');
        check('phone: the course filter uses the one-row classes (no wrap, scrolls sideways), its pills capped',
            /\bflex-nowrap\b/.test(filterRow?.className ?? '') && /\boverflow-x-auto\b/.test(filterRow?.className ?? '')
            && /\bmax-w-/.test(pill(LONG)?.className ?? ''), filterRow?.className ?? 'no filter');
        check('phone week: today\'s row holds the overdue group', /^4 overdue/.test(group('overdue')?.textContent.trim() ?? ''),
            group('overdue')?.textContent ?? 'none');
        await click(radio('Month'));
        const dot = todayCell()?.querySelector('[data-late-count]');
        check('phone month: today\'s cell carries the count, and says what it counts to a screen reader',
            dot?.querySelector('[aria-hidden="true"]')?.textContent.trim() === '4'
            && dot?.querySelector('.sr-only')?.textContent.trim() === '4 overdue', dot?.innerHTML ?? 'none');
        unmount(); host.remove();

        // -- one course's own calendar ------------------------------------------------
        const node = (id, title, s, e, status = 'not_started') => ({
            id, project_id: 9, parent_id: null, title, status, is_note: 0, children: [], scheduled_start: s, scheduled_end: e,
        });
        view.useStore.setState({
            projects: [{ id: 9, name: 'Gate course', color: '#2563EB', start_date: '2026-09-01', deadline: '2026-12-18', study_days: '[1,2,3,4,5]' }],
            tree: [node(201, 'Long gone', '2026-09-07', '2026-09-11'), node(202, 'Yesterday', '2026-11-02', '2026-11-03'),
                node(203, 'This week', '2026-11-04', '2026-11-06')],
        });
        const host2 = doc.createElement('div'); doc.body.append(host2);
        const unmount2 = view.mount(host2, { kind: 'project', projectId: 9 });
        await settle(); width = 1280; await view.act(async () => { for (const o of observers) o.cb([]); }); await settle();
        const r2 = [...host2.querySelectorAll('[role="radio"]')].find(r => r.textContent.trim() === 'Week');
        await view.act(async () => { r2?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })); }); await settle();
        const g2 = host2.querySelector('[data-panel="curr"] [data-date="2026-11-04"] [data-late-group="overdue"]');
        check('a course\'s own calendar: the same group on today, counting a topic two months late',
            /^2 overdue/.test(g2?.textContent.trim() ?? ''), g2?.textContent ?? 'none');
        check('…and no course filter (one course)', !host2.querySelector('[data-course-filter]'));
        // Selecting a late topic (the outline beside this calendar) shows TODAY,
        // where it is drawn, with its group ringed: not its planned week in
        // September, which no longer holds it.
        const next2 = host2.querySelector('button[aria-label="Next period"]');
        for (let i = 0; i < 2; i++) { await view.act(async () => { next2?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })); }); await settle(); }
        await view.act(async () => { view.useStore.setState({ selectedNodeId: 201 }); }); await settle();
        const g2sel = host2.querySelector('[data-panel="curr"] [data-date="2026-11-04"] [data-late-group="overdue"] > span');
        check('selecting a late topic brings back today, its group ringed',
            /\bring-accent\b/.test(g2sel?.className ?? ''), g2sel ? g2sel.className : 'today not on screen');
        await view.act(async () => { view.useStore.setState({ selectedNodeId: null }); }); await settle();
        unmount2(); host2.remove();

        // -- an empty library ---------------------------------------------------------
        g.__calendarRange = () => ({ projects: [], tasks: [] });
        view.useStore.setState({ projects: [], tree: [] });
        const host3 = doc.createElement('div'); doc.body.append(host3);
        const unmount3 = view.mount(host3, { kind: 'global' });
        await settle();
        check('an empty library: no filter, no group, no count, and the week still draws',
            !host3.querySelector('[data-course-filter],[data-late-group],[data-overdue-count]')
            && !!host3.querySelector('[role="radiogroup"]'));
        unmount3(); host3.remove();
    } finally {
        for (const [k, d] of Object.entries(saved)) {
            if (d) Object.defineProperty(g, k, d); else delete g[k];
        }
        delete window.HTMLElement.prototype.clientWidth;
        window.close();
        rmSync(viewScratch, { recursive: true, force: true });
    }
}

// ---- 9. the library calendar is SENT the late work -----------------------------
// The view can only show what it is given: fetched by range alone, a topic that
// ended before the three periods on screen never arrived.
console.log('\n--- the library calendar fetches late work, whatever its dates ---');
{
    const dbScratch = mkdtempSync(join(tmpdir(), 'calendar-gates-db-'));
    // In-process, before the server's modules load: never a shell prefix.
    process.env.DB_PATH = join(dbScratch, 'gate.db');
    process.env.VAULT_ROOT = join(dbScratch, 'vault');
    const db = (await import('../server/database.js')).default;
    try {
        const { buildCalendarRange } = await import('../server/today.js');
        const pid = db.prepare("INSERT INTO projects (name, position, start_date, deadline) VALUES ('Gate course', 0, '2026-09-01', '2026-12-18')").run().lastInsertRowid;
        db.prepare("INSERT INTO projects (name, position) VALUES ('No dates', 1)").run();
        const leaf = (title, s, e, status = 'not_started') => Number(db.prepare(
            'INSERT INTO nodes (project_id, parent_id, title, position, status, scheduled_start, scheduled_end) VALUES (?, NULL, ?, 0, ?, ?, ?)',
        ).run(pid, title, status, s, e).lastInsertRowid);
        const gone = leaf('Late, two months', '2026-09-07', '2026-09-11');
        const done = leaf('Done, two months ago', '2026-09-14', '2026-09-18', 'completed');
        const skipped = leaf('Skipped', '2026-09-21', '2026-09-25', 'skipped');
        const inRange = leaf('This week', '2026-11-04', '2026-11-06');
        const future = leaf('Next month', '2026-12-07', '2026-12-11');
        const got = buildCalendarRange('2026-10-26', '2026-11-15', { today: T_TODAY });
        const sent = got.tasks.map(t => t.nodeId);
        check('an open topic that ended two months before the range is sent', sent.includes(gone), JSON.stringify(sent));
        check('…a done or skipped one is not, nor work outside the range that is not late',
            !sent.includes(done) && !sent.includes(skipped) && !sent.includes(future), JSON.stringify(sent));
        check('…and the range itself still is', sent.includes(inRange), JSON.stringify(sent));
        check('each course says whether it has dates (the filter lists those)',
            JSON.stringify(got.projects.map(p => p.scheduled)) === '[true,false]', JSON.stringify(got.projects));
    } finally {
        db.close();
        rmSync(dbScratch, { recursive: true, force: true });
    }
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
