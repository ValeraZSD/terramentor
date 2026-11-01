#!/usr/bin/env node
/**
 * The project Timeline (src/components/schedule/ProjectTimeline.tsx): what a
 * row says about itself, the Route it is drawn as, and the layout rules it
 * rests on.
 *
 * Since 1 Nov 2026 the Timeline is a ROUTE (an experiment): every topic is a
 * stop on one line from the start to the deadline flag, in course order. Two
 * marks sit on it, the learner ("You are here") and where the plan stands
 * today ("Plan for today"), and the line between them is red. The colour of
 * each stretch of line is arithmetic over the stops (`routeOf`), so it is
 * asserted here as numbers; the screen itself is rendered in jsdom.
 *
 * The gantt it replaced drew every row of a course that had fallen behind as
 * one red bar and collapsed to a 215px column as soon as a row was clicked,
 * because its layout followed the WINDOW while the detail panel took the room
 * beside it. The rules that outlived it (container width, one action for being
 * behind, nothing "Overdue" in a finished course) are kept below.
 *
 * No model, no network, no real browser.
 *
 *   node tools/timeline-gates.mjs
 *   node tools/timeline-gates.mjs --root <dir>   the same checks on another
 *        checkout's src/ (a `git show` copy of the old files must fail them)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : here;

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; return; }
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
    check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

let esbuild;
try {
    esbuild = await import('esbuild');
} catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    console.log('SKIPPED: timeline gates — esbuild unavailable');
    process.exit(0);
}

// The rows are built against "today", which `buildGanttData` reads for itself
// with LOCAL getters: pin it to local noon, or a run that crosses midnight
// builds the fixture on one date and judges it on the next — and a UTC noon
// is already 2 November in UTC+12 and later.
const RealDate = Date;
const PINNED = new RealDate(2026, 10, 1, 12).getTime();
globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [PINNED])); }
    static now() { return PINNED; }
};

const scratch = mkdtempSync(join(tmpdir(), 'timeline-gates-'));
// The interface language is not what is under test: month names in English.
const stub = join(scratch, 'i18n-stub.js');
writeFileSync(stub, "export const k = (s) => s;\nexport const currentLocale = () => 'en-GB';\nexport default {};\n");
const bundle = async (rel) => {
    const out = join(scratch, rel.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '.mjs'));
    await esbuild.build({
        entryPoints: [join(root, rel)],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
        nodePaths: [join(here, 'node_modules')],
        plugins: [{ name: 'stub-i18n', setup(b) { b.onResolve({ filter: /(^|\/)i18n$/ }, () => ({ path: stub })); } }],
    });
    return import(pathToFileURL(out).href);
};
const src = (rel) => readFileSync(join(root, rel), 'utf8');
/** Source with its comments removed, so a rule is matched in code only. */
const code = (rel) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

try {
    // ---- rows: what each one says about itself -----------------------------
    const tree = await bundle('src/utils/tree.ts');
    const today = tree.todayStr();
    eq('the clock is the pinned one (1 Nov 2026)', today, '2026-11-01');
    const day = (n) => tree.addDays(today, n);
    const n = (id, parent, extra = {}) => ({
        id, parent_id: parent, title: `n${id}`, is_note: 0, role: 'topic', status: 'not_started', position: id,
        scheduled_start: null, scheduled_end: null, cards: 0, seen: 0, ...extra,
    });
    const course = tree.buildTree([
        n(1, null, { scheduled_start: day(-30), scheduled_end: day(30) }),
        n(2, 1, { status: 'completed', scheduled_start: day(-30), scheduled_end: day(-20) }),
        n(3, 1, { scheduled_start: day(-19), scheduled_end: day(-1) }),
        n(4, 1, { status: 'in_progress', scheduled_start: day(-2), scheduled_end: day(5) }),
        n(5, 1, { scheduled_start: day(6), scheduled_end: day(30) }),
        n(6, 1, { status: 'skipped', scheduled_start: day(-30), scheduled_end: day(-25) }),
        n(7, 1),
        n(8, 1, { cards: 10, seen: 4, scheduled_start: day(-12), scheduled_end: day(-3) }),
    ]);
    const rows = tree.buildGanttData(course);
    const row = (id) => rows.find((r) => r.id === id) || {};
    eq('a completed topic says done', row(2).state, 'done');
    eq('an open topic whose window ended yesterday is late', row(3).state, 'late');
    eq('a topic whose window holds today is now', row(4).state, 'now');
    eq('a topic that starts after today is upcoming', row(5).state, 'upcoming');
    eq('a skipped topic says skipped, not late', row(6).state, 'skipped');
    eq('a topic with no dates is unscheduled', row(7).state, 'unscheduled');
    check('late and only late counts as behind (isOverdue)',
        rows.every((r) => r.isOverdue === (r.state === 'late' || r.state === 'ready')),
        rows.map((r) => `${r.id}:${r.state}/${r.isOverdue}`).join(' '));

    eq('a completed topic is wholly done', row(2).done, 1);
    eq('a late topic with 4 of 10 cards met is 40% done, not 0', row(8).done, 0.4);
    eq('an untouched topic is 0% done', row(3).done, 0);
    // Worked by hand from the progress rule (server/progress.js, `topicDone` /
    // `topicWeight`): a topic of only cards weighs its cards, any other one;
    // completed and skipped count as closed. Topics 2–7 weigh 1 each, topic 8
    // weighs 10: closed 2 + 4 cards met = 6 of 16 = 37.5%, shown as 38%.
    const parent = tree.findNode(course, 1);
    eq('a section\'s share is its progress, the number every other screen shows',
        row(1).done, parent.progress.percentage / 100);
    eq('…which is the hand-counted share (6 of 16 units, 38%)', row(1).done, 0.38);
    check('a row says what it is, never how it looks (no colour class in the data)',
        rows.every((r) => !('colorClass' in r)));

    const deckTree = tree.buildTree([
        n(20, null),
        n(21, 20, { role: 'pagination', cards: 50, seen: 50 }),
        n(22, 20, { role: 'pagination', cards: 50, seen: 16 }),
    ]);
    const plan = [
        { nodeId: 21, start: day(-40), end: day(-30), cards: 50, seen: 50 },
        { nodeId: 22, start: day(-29), end: day(-10), cards: 50, seen: 16 },
    ];
    const deckRows = tree.buildGanttData(deckTree, plan);
    const deckRow = (id) => deckRows.find((r) => r.id === id) || {};
    eq('a deck section with every card met is done', deckRow(21).state, 'done');
    eq('a deck section is as done as its cards met (16 of 50)', deckRow(22).done, 0.32);

    // ---- the fitted axis -------------------------------------------------------
    // `laneAxis.tsx` drew the gantt this Route replaced and draws nothing while
    // the Route is on trial; it comes back if the experiment is dropped, and
    // goes, with these checks, if it is kept.
    const ax = await bundle('src/utils/scheduleAxis.ts');
    const autumn = { from: '2026-08-01', to: '2026-12-31' };
    const years = typeof ax.buildYears === 'function' ? ax.buildYears(autumn, 4) : [];
    eq('a plan from August to December says its year once', years.map((y) => y.label).join(), '2026');
    eq('…at the start of the axis', years[0]?.x, 0);
    check('month labels are months, not a year standing in for January',
        ax.buildTicks({ from: '2026-08-01', to: '2027-03-31' }, 4).every((t) => !/^\d{4}$/.test(t.label)));
    check('ticks thinned to one a year carry no labels of their own (the year row says it)',
        ax.buildTicks({ from: '2026-01-01', to: '2030-12-31' }, 0.2).every((t) => t.label === ''));
    const decStart = { from: '2026-12-01', to: '2027-12-31' };
    eq('a year with too little room for its label gives way to the next January',
        typeof ax.buildYears === 'function' ? ax.buildYears(decStart, 0.5).map((y) => y.label).join() : '', '2027');
    eq('…and keeps both when there is room',
        typeof ax.buildYears === 'function' ? ax.buildYears(decStart, 4).map((y) => y.label).join() : '', '2026,2027');
    const sixYears = { from: '2026-01-01', to: '2031-12-31' };
    eq('a long plan on a narrow lane keeps every other year, from its first',
        typeof ax.buildYears === 'function' ? ax.buildYears(sixYears, 150 / ax.daysBetween(sixYears.from, sixYears.to)).map((y) => y.label).join() : '',
        '2026,2028,2030');
    const lw = typeof ax.markerLabelPx === 'function' ? ax.markerLabelPx : () => 0;
    eq('a label at 16px root is the width it was tuned to ("Today": 5 × 6.38 + 12)', Math.round(lw('Today', 16)), 44);
    check('…and 1.5 times as wide at 150% (24px root)', lw('Today', 16) > 0 && Math.abs(lw('Today', 24) - 1.5 * lw('Today', 16)) < 0.01, `${lw('Today', 24)} vs ${lw('Today', 16)}`);
    eq('a CJK label counts each glyph as 1em ("截止日期" at 16px: 4 × 11 + 12)', lw('截止日期', 16), 56);

    // ---- the screen: rules that are lines of source --------------------------
    const tl = code('src/components/schedule/ProjectTimeline.tsx');
    check('the layout follows the timeline\'s own width, not the window (no sm:/md:/lg: classes)',
        !/["'`\s](sm|md|lg|xl|2xl):[a-z]/.test(tl), (tl.match(/["'`\s](sm|md|lg|xl|2xl):[a-z][\w-]*/g) || []).join(' '));
    check('…measured with useElementWidth', /useElementWidth\(/.test(tl));
    check('no detail-level switch or zoom: the route opens where the learner is', !/SegmentedControl/.test(tl));
    check('no predicted finishing date anywhere on the screen', !/finishBy|projected|estimatedEnd|predict/i.test(tl));
    const shortRangeSrc = tl.match(/function shortRange[\s\S]*?\n\}/)?.[0] ?? '';
    check('one date formatter per locale, not one per stop per render',
        shortRangeSrc !== '' && !/new Intl\.DateTimeFormat/.test(shortRangeSrc) && /dayMonthFormats\.get\(/.test(tl));

    const ws = code('src/components/Workspace.tsx');
    check('no navigation sidebar beside the Timeline (it repeated every row)',
        /workspaceView !== 'timeline' && <Sidebar \/>/.test(ws));
    check('the header\'s pace pill stays off the Timeline (its summary says it in words)',
        /workspaceView !== 'timeline' && <PaceIndicator full=\{paceFull\} \/>/.test(ws)
        && [...ws.matchAll(/<PaceIndicator full=\{paceFull\}/g)].length === 1);
    const pace = code('src/components/PaceIndicator.tsx');
    check('a finished course shows no "days behind" pill',
        /status === 'completed'/.test(pace) && /\|\| finished\) return null/.test(pace));

    // ---- the route and the screen, rendered -----------------------------------
    // The REAL store and ProjectTimeline in jsdom (the pattern of
    // dashboard-load-gates.mjs). jsdom has no layout, so the few numbers the
    // screen reads are stubbed (see `page`).
    await renderChecks(tree);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

const total = pass + failures.length;
if (failures.length) {
    console.log(`\n  ${failures.length} of ${total} timeline assertions FAILED:\n`);
    for (const f of failures) console.log(`   ✗ ${f}`);
    process.exit(1);
}
console.log(`\n  ✓ ${pass} timeline assertions passed (no model, no network; rendered in jsdom).\n`);
// The rendered checks leave message ports and never-answered fetches behind.
process.exit(0);

async function renderChecks(tree) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { JSDOM } = require('jsdom');
    const built = await esbuild.build({
        stdin: {
            contents: `
                import { useStore } from './src/store';
                import ProjectTimeline, { routeOf, stackLabels } from './src/components/schedule/ProjectTimeline';
                import { createElement, act } from 'react'; import { createRoot } from 'react-dom/client';
                const mount = (el) => { const r = createRoot(el); act(() => r.render(createElement(ProjectTimeline))); return r; };
                window.__gate = { useStore, mount, act, routeOf, stackLabels };`,
            resolveDir: root, loader: 'tsx',
        },
        bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
        nodePaths: [join(here, 'node_modules')],
        define: { 'process.env.NODE_ENV': '"development"' },
        loader: { '.css': 'empty', '.svg': 'dataurl' },
    });
    const bundled = built.outputFiles[0].text;
    const today = tree.todayStr();
    const day = (n) => tree.addDays(today, n);
    // jsdom geometry: a 400px scroller; a list row is ROW tall; a stop of the
    // snake sits at its own inline `top` (it is absolutely positioned at it).
    const ROW = 40, STOP = 44, VIEW = 400, SCROLLBAR = 15;

    const page = ({ width }) => {
        const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
        const w = dom.window;
        // The window's own clock, pinned to the same instant as this file's.
        w.eval(`(() => { const R = Date; window.Date = class extends R { constructor(...a) { super(...(a.length ? a : [${PINNED}])); } static now() { return ${PINNED}; } }; })()`);
        w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
        w.IS_REACT_ACT_ENVIRONMENT = true;
        w.MessageChannel = MessageChannel;
        w.fetch = () => new Promise(() => { });
        // An observer that never reports: what a document not being painted
        // gets (useElementWidth's note), so the first measurement must do.
        w.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
        const P = w.HTMLElement.prototype;
        const isList = (el) => el.classList.contains('overflow-y-auto');
        const tops = new WeakMap();
        // The snake is one box of an inline height; the list, its rows.
        const contentHeight = (el) => {
            const snake = el.querySelector('div[style*="height"]');
            if (snake) return parseFloat(snake.style.height);
            return el.querySelectorAll('li').length * ROW;
        };
        // Where an element starts inside the scrolled content, unscrolled.
        const contentTop = (el) => {
            if (el.tagName === 'LI') return [...el.parentElement.children].indexOf(el) * ROW;
            if (el.style?.top) return parseFloat(el.style.top) - STOP / 2;
            return 0;
        };
        // Inside the scroller a box is a scrollbar narrower than the screen.
        Object.defineProperty(P, 'clientWidth', { configurable: true, get() { return this.closest('.overflow-y-auto') && !isList(this) ? width - SCROLLBAR : width; } });
        Object.defineProperty(P, 'clientHeight', { configurable: true, get() { return isList(this) ? VIEW : 0; } });
        Object.defineProperty(P, 'scrollHeight', { configurable: true, get() { return isList(this) ? contentHeight(this) : 0; } });
        Object.defineProperty(P, 'scrollTop', { configurable: true, get() { return tops.get(this) ?? 0; }, set(v) { tops.set(this, v); } });
        P.scrollTo = function ({ top }) { tops.set(this, top); };
        w.Element.prototype.getBoundingClientRect = function () {
            const list = this.closest('.overflow-y-auto');
            const inside = list && list !== this;
            const top = inside ? contentTop(this) - (tops.get(list) ?? 0) : 0;
            const height = isList(this) ? VIEW : this.tagName === 'LI' ? ROW : this.style?.top ? STOP : 0;
            return { top, bottom: top + height, height, left: 0, right: width, width, x: 0, y: top, toJSON() { } };
        };
        const gcs = w.getComputedStyle.bind(w);
        w.getComputedStyle = (el, p) => {
            const s = gcs(el, p);
            if (el.classList?.contains('overflow-y-auto')) Object.defineProperty(s, 'overflowY', { value: 'auto' });
            return s;
        };
        w.eval(bundled);
        const { useStore, mount, act, routeOf, stackLabels } = w.__gate;
        useStore.setState({ _navigate: null });
        const el = w.document.getElementById('root');
        let r = null;
        const settle = async () => {
            for (let i = 0; i < 10; i++) await new Promise((ok) => setImmediate(ok));
            await new Promise((ok) => w.requestAnimationFrame(ok));
            await new Promise((ok) => w.requestAnimationFrame(ok));
        };
        const list = () => el.querySelector('.overflow-y-auto');
        return {
            w, useStore, el, act, routeOf, stackLabels, list,
            set: async (state) => { await act(async () => { useStore.setState(state); await settle(); }); },
            mount: async () => { await act(async () => { r = mount(el); await settle(); }); },
            click: async (target) => { await act(async () => { target.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(); }); },
            focus: async (target) => { await act(async () => { target.focus(); await settle(); }); },
            summary: () => el.querySelector('[data-plan-summary]'),
            stops: () => [...el.querySelectorAll('[data-stop]')],
            listRows: () => [...el.querySelectorAll('li[data-node-id]')],
            shown: (id) => !!el.querySelector(`[data-node-id="${id}"]`),
            /** How far (px) a stop's middle sits from the middle of the scroller's view. */
            offCentre: (id) => {
                const n = el.querySelector(`[data-node-id="${id}"]`);
                if (!n) return Infinity;
                const b = n.getBoundingClientRect();
                return Math.round(Math.abs(b.top + b.height / 2 - VIEW / 2));
            },
            scrollTop: () => list()?.scrollTop ?? 0,
            close: () => { if (r) act(() => r.unmount()); w.close(); },
        };
    };
    const node = (id, parent, extra = {}) => ({
        id, project_id: 1, parent_id: parent, title: `n${id}`, is_note: 0, role: 'topic', status: 'not_started', position: id,
        scheduled_start: null, scheduled_end: null, cards: 0, seen: 0, ...extra,
    });
    const course = (id, extra = {}) => ({
        id, name: `Course ${id}`, color: '#0369a1', icon: 'book', status: 'active', teaches: true,
        topic_count: 6, card_count: 0, start_date: day(-30), deadline: day(30), ...extra,
    });

    // The course most of the checks below are about: a phase of six topics,
    // two closed, two behind (one late, one already known), one ending today.
    //   stop:   0 done   1 skipped   2 late   3 ready   4 now (ends today)   5 upcoming
    // You = 2 (the first not closed), the plan = 4 (the first whose window has
    // not ended), behind = 2 (late + ready).
    const behindNodes = [
        node(1, null, { scheduled_start: day(-30), scheduled_end: day(30) }),
        node(2, 1, { status: 'completed', scheduled_start: day(-30), scheduled_end: day(-25) }),
        node(3, 1, { status: 'skipped', scheduled_start: day(-24), scheduled_end: day(-20) }),
        node(4, 1, { scheduled_start: day(-19), scheduled_end: day(-10) }),
        node(5, 1, { provable: true, scheduled_start: day(-9), scheduled_end: day(-1) }),
        node(6, 1, { scheduled_start: day(-1), scheduled_end: day(0) }),
        node(7, 1, { scheduled_start: day(1), scheduled_end: day(30) }),
    ];
    const behindTree = tree.buildTree(behindNodes);

    // ---- 1. routeOf: the route in numbers, and the colour of every gap -------
    {
        const p = page({ width: 900 });
        const { routeOf } = p;
        const routeFor = (nodes) => routeOf(tree.buildGanttData(tree.buildTree(nodes)), today);
        /** Gap colours as letters, upper and lower half: d(one) b(ehind) a(head). */
        const gaps = (r) => Array.from({ length: r.n + 1 }, (_, i) => r.gap(i, 'upper')[0] + r.gap(i, 'lower')[0]).join(' ');

        const r = routeFor(behindNodes);
        eq('a phase is not a stop: six topics, six stops', r.n, 6);
        eq('a states fixture as built (done skipped late ready now upcoming)',
            r.stops.map((s) => s.state).join(' '), 'done skipped late ready now upcoming');
        eq('You is the first stop not done (a skipped topic is closed)', r.you, 2);
        eq('the plan stands at the first stop whose window has not ended (one ending today counts)', r.plan, 4);
        eq('behind counts the late AND the ready-to-prove stops', r.behind, 2);
        eq('closed counts done and skipped', r.closed, 2);
        // Green up to You, red from You to the plan's mark (the middle of gap
        // `plan`: red above it, grey below), grey after.
        eq('the line: green to You, red to the middle of the plan\'s gap, grey after',
            gaps(r), 'dd dd dd bb ba aa aa');

        const fresh = routeFor([
            node(1, null),
            node(2, 1, { scheduled_start: day(0), scheduled_end: day(5) }),
            node(3, 1, { scheduled_start: day(6), scheduled_end: day(10) }),
        ]);
        eq('day one, nothing done: You and the plan both at the first stop', `${fresh.you}/${fresh.plan}`, '0/0');
        eq('…and no stretch is green or red (nothing done, nothing behind)', gaps(fresh), 'aa aa aa');

        const lateStart = routeFor([
            node(1, null),
            node(2, 1, { scheduled_start: day(-10), scheduled_end: day(-5) }),
            node(3, 1, { scheduled_start: day(-4), scheduled_end: day(-1) }),
            node(4, 1, { scheduled_start: day(0), scheduled_end: day(5) }),
        ]);
        eq('nothing done, two stops late: red from the start to the plan\'s mark, never green',
            gaps(lateStart), 'bb bb ba aa');

        const ahead = routeFor([
            node(1, null),
            node(2, 1, { status: 'completed', scheduled_start: day(-5), scheduled_end: day(-1) }),
            node(3, 1, { status: 'completed', scheduled_start: day(0), scheduled_end: day(3) }),
            node(4, 1, { status: 'completed', scheduled_start: day(4), scheduled_end: day(8) }),
            node(5, 1, { scheduled_start: day(9), scheduled_end: day(12) }),
        ]);
        eq('ahead of the plan: You past the mark, nothing red', `${ahead.you}/${ahead.plan}/${ahead.behind}`, '3/1/0');
        eq('…green to You, grey after', gaps(ahead), 'dd dd dd dd aa');

        const all = routeFor([
            node(1, null),
            node(2, 1, { status: 'completed', scheduled_start: day(-9), scheduled_end: day(-5) }),
            node(3, 1, { status: 'completed', scheduled_start: day(-4), scheduled_end: day(-1) }),
        ]);
        eq('every stop done: You is past the last stop', all.you, all.n);
        eq('…and the whole line is green, to the flag', gaps(all), 'dd dd dd');

        const undated = routeFor([node(1, null), node(2, 1, { status: 'completed' }), node(3, 1)]);
        eq('no dates: there is no plan to stand anywhere', undated.plan, null);
        eq('…and nothing is red', gaps(undated), 'dd dd aa');

        // Stretches: one per top-level phase, a top-level topic alone; a
        // section inside a phase is not a stop and does not split its phase.
        const st = routeFor([
            node(10, null), node(11, 10), node(12, 11), node(13, 11), node(14, 10),
            node(20, null),
            node(30, null), node(31, 30),
        ]);
        eq('stops are the leaves, in course order', st.stops.map((s) => s.id).join(), '12,13,14,20,31');
        eq('one stretch per top-level phase; a top-level topic stands alone',
            st.stretches.map((s) => `${s.id}:${s.phase ? 'phase' : 'alone'}:${s.from}+${s.count}`).join(' '),
            '10:phase:0+3 20:alone:3+1 30:phase:4+1');

        const items = tree.buildGanttData(behindTree);
        eq('a FINISHED course draws nothing red: the plan is over',
            gaps(routeOf(items, today, { finished: true })), 'dd dd dd aa aa aa aa');
        const pastDeadline = routeFor([
            node(1, null),
            node(2, 1, { status: 'completed', scheduled_start: day(-30), scheduled_end: day(-20) }),
            node(3, 1, { scheduled_start: day(-19), scheduled_end: day(-5) }),
        ]);
        eq('past the deadline the plan stands at the flag', pastDeadline.plan, 2);
        eq('…and red runs all the way to it',
            gaps(routeOf(tree.buildGanttData(tree.buildTree([
                node(1, null),
                node(2, 1, { status: 'completed', scheduled_start: day(-30), scheduled_end: day(-20) }),
                node(3, 1, { scheduled_start: day(-19), scheduled_end: day(-5) }),
            ])), today, { over: true })), 'dd dd bb');
        const gapInDates = routeFor([
            node(1, null),
            node(2, 1, { scheduled_start: day(-20), scheduled_end: day(-10) }),
            node(3, 1),
            node(4, 1, { scheduled_start: day(-9), scheduled_end: day(-1) }),
            node(5, 1, { scheduled_start: day(0), scheduled_end: day(9) }),
        ]);
        eq('a stop with no dates says nothing about the plan: it is passed over', gapInDates.plan, 3);

        // The labels under the line take lanes where they would collide.
        const { stackLabels } = p;
        eq('labels far apart all sit just under the line',
            JSON.stringify(stackLabels([{ key: 'you', x: 100, w: 90, lines: 1 }, { key: 'plan', x: 400, w: 100, lines: 1 }], 8)), '{"you":0,"plan":0}');
        eq('You and the plan\'s label half a step apart: the plan\'s goes under You\'s',
            JSON.stringify(stackLabels([{ key: 'you', x: 100, w: 90, lines: 1 }, { key: 'plan', x: 136, w: 100, lines: 1 }], 8)), '{"you":0,"plan":1}');
        eq('…and a third goes under both, past the deadline\'s two lines',
            JSON.stringify(stackLabels([{ key: 'flag', x: 100, w: 70, lines: 2 }, { key: 'you', x: 110, w: 90, lines: 1 }, { key: 'start', x: 300, w: 80, lines: 1 }], 8)), '{"flag":0,"you":2,"start":0}');
        p.close();
    }

    // ---- 2. a cold load lays out for the measured width -----------------------
    // The tab mounts before the projects have arrived, so the first render is
    // the "No schedule set" state; the width must still be measured, or the
    // layout never follows it.
    for (const [width, want] of [[400, 'list'], [900, 'snake']]) {
        const p = page({ width });
        await p.set({ currentProjectId: 1, projects: [course(1, { start_date: null, deadline: null })], tree: behindTree, paceData: null, selectedNodeId: null });
        await p.mount();
        await p.set({ projects: [course(1)] });
        const got = p.stops().length === 6 && p.listRows().length === 0 ? 'snake'
            : p.stops().length === 0 && p.listRows().length === 6 ? 'list' : `${p.stops().length} stops, ${p.listRows().length} rows`;
        eq(`cold load at ${width}px: the ${want}, every stop on it`, got, want);
        p.close();
    }

    // ---- 3. the snake: its line, its marks, its summary ------------------------
    {
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1)], tree: behindTree, paceData: null, selectedNodeId: null });
        await p.mount();
        // The route's own svg is the scroller's first drawing; the flag is an icon.
        const paths = [...(p.list()?.querySelector('svg')?.querySelectorAll('path') ?? [])];
        const red = paths.filter((x) => /stroke-red/.test(x.getAttribute('class'))).length;
        const green = paths.filter((x) => /stroke-emerald/.test(x.getAttribute('class'))).length;
        eq('the snake draws two halves per gap (start → six stops → flag)', paths.length, 14);
        eq('…three red halves: You to the plan\'s mark, as routeOf says', red, 3);
        eq('…six green halves: the start to You', green, 6);
        const text = p.el.textContent;
        check('"You are here" and "Plan for today" are both on the line', /You are here/.test(text) && /Plan for today/.test(text), text.slice(0, 200));
        check('the deadline flag is named', /Deadline/.test(p.el.querySelector('.overflow-y-auto')?.textContent ?? ''));
        // Pace has not answered (paceData null): a course measured in topics
        // already knows from its own stops, and says it.
        const summary = p.summary()?.textContent ?? '';
        check('before the pace answers, the summary already says how far behind, from the stops',
            /2 topics behind the plan/.test(summary), summary);
        check('…with the one action that answers it, and Study for the stop You is at',
            /Recalibrate Schedule/.test(summary) && /Study/.test(summary) && /Next up: n4/.test(summary), summary);
        // Strangers read the blue "Recalibrate Schedule" as the thing to press
        // and were afraid of it: Study is the one primary, and the last.
        const buttons = [...(p.summary()?.querySelectorAll('button') ?? [])];
        const primary = buttons.filter((b) => /\bbg-accent\b/.test(b.className));
        check('Study is the summary\'s one primary button, and the last',
            primary.length === 1 && primary[0] === buttons[buttons.length - 1] && /Study/.test(primary[0].textContent),
            buttons.map((b) => `${b.textContent}${/\bbg-accent\b/.test(b.className) ? ' (primary)' : ''}`).join(' | '));
        const startLabel = p.el.querySelector('[data-line-label="start"]')?.textContent ?? '';
        check('the start says "Start", not only a date', /^Start · /.test(startLabel), startLabel);
        const late = p.stops().find((b) => b.dataset.state === 'late');
        if (late) await p.focus(late);
        const tip = p.el.querySelector('[role="tooltip"]')?.textContent ?? '';
        check('a stop reached by Tab names its topic, dates and state (no mouse needed)', /n4/.test(tip) && /Overdue/.test(tip), tip || 'no tooltip');
        // Below a first-row stop it covered "You are here": above, with room
        // for two lines (3.5rem) under the box's top edge.
        const tipEl = p.el.querySelector('[role="tooltip"]');
        const tipBottom = parseFloat(tipEl?.style.top ?? 'NaN');
        const stopY = parseFloat(late?.style.top ?? 'NaN');
        check('a first-row stop\'s tooltip sits above it, inside the box',
            /-translate-y-full/.test(tipEl?.className ?? '') && tipBottom < stopY && tipBottom - 3.5 * 16 >= 0,
            `tooltip bottom ${tipBottom}, stop ${stopY}`);
        if (late) {
            await p.act(async () => { late.blur(); });
            const box = p.list();
            // React reads enter and leave off `mouseout` from the element left.
            await p.act(async () => { box.dispatchEvent(new p.w.MouseEvent('mouseout', { bubbles: true, relatedTarget: late })); });
            const shownByMouse = !!p.el.querySelector('[role="tooltip"]');
            await p.act(async () => { late.dispatchEvent(new p.w.MouseEvent('mouseout', { bubbles: true, relatedTarget: box })); });
            check('the pointer on a stop shows its tooltip, and leaving it onto empty space takes it away',
                shownByMouse && !p.el.querySelector('[role="tooltip"]'), `shown ${shownByMouse}, after ${!!p.el.querySelector('[role="tooltip"]')}`);
        }
        const target = p.stops().find((b) => b.dataset.nodeId === '6');
        if (target) await p.click(target);
        eq('clicking a stop selects it', p.useStore.getState().selectedNodeId, 6);
        eq('…and says so to a screen reader (aria-current), not only by its ring',
            p.stops().find((b) => b.dataset.nodeId === '6')?.getAttribute('aria-current'), 'true');
        p.close();
    }
    {
        const p = page({ width: 900 });
        const onPlan = tree.buildTree([
            node(1, null),
            node(2, 1, { status: 'completed', scheduled_start: day(-30), scheduled_end: day(-1) }),
            node(3, 1, { scheduled_start: day(0), scheduled_end: day(30) }),
        ]);
        await p.set({ currentProjectId: 1, projects: [course(1)], tree: onPlan, paceData: null, selectedNodeId: null });
        await p.mount();
        const summary = p.summary()?.textContent ?? '';
        check('a course on plan says so, and offers Study but no Recalibrate',
            /On plan/.test(summary) && !/Recalibrate/.test(summary) && /Study/.test(summary), summary);
        p.close();
    }

    // ---- 3b. the snake's geometry: U-turns, crowded labels, its own width -----
    // Thirty stops at 900px: the snake's box is 885px inside the scrollbar, so
    // 11 slots a row (725px usable, 72px minimum step); gap 10 is the U-turn at
    // the right end of the first row.
    const longCourse = (doneUpTo, endedUpTo, { phases = false } = {}) => {
        const nodes = phases ? [] : [node(300, null)];
        for (let i = 1; i <= 30; i++) {
            const dates = i <= endedUpTo ? { scheduled_start: day(-40 + i), scheduled_end: day(-40 + i) } : { scheduled_start: day(i), scheduled_end: day(i) };
            const extra = { ...dates, status: i <= doneUpTo ? 'completed' : 'not_started' };
            if (phases) { nodes.push(node(300 + 2 * i, null)); nodes.push(node(301 + 2 * i, 300 + 2 * i, extra)); }
            else nodes.push(node(300 + i, 300, extra));
        }
        return tree.buildTree(nodes);
    };
    const W = 900 - SCROLLBAR;
    {
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1, { topic_count: 30 })], tree: longCourse(9, 10), paceData: null, selectedNodeId: null });
        await p.mount();
        eq('the snake is laid out in its own box, the scrollbar left out', Number(p.list()?.querySelector('svg')?.getAttribute('width')), W);
        const plan = p.el.querySelector('[data-line-label="plan"]');
        check('on a U-turn, "Plan for today" sits inside the bend, never off the edge',
            plan && /-translate-x-full/.test(plan.className) && parseFloat(plan.style.left) <= W, plan ? `${plan.className} @ ${plan.style.left}` : 'no plan label');
        const youStop = p.stops().find((b) => b.dataset.nodeId === '310');
        check('a stop names its state and You to a screen reader, not only by colour',
            /Overdue/.test(youStop?.getAttribute('aria-label') ?? '') && /You are here/.test(youStop?.getAttribute('aria-label') ?? ''), youStop?.getAttribute('aria-label'));
        p.close();
    }
    {
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1, { topic_count: 30 })], tree: longCourse(5, 5), paceData: null, selectedNodeId: null });
        await p.mount();
        const top = (k) => p.el.querySelector(`[data-line-label="${k}"]`)?.style.top;
        check('on plan, "You are here" and "Plan for today" half a step apart print on two lines, not on top of each other',
            top('you') && top('plan') && top('you') !== top('plan'), `you ${top('you')}, plan ${top('plan')}`);
        p.close();
    }
    {
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1, { topic_count: 30 })], tree: longCourse(5, 5, { phases: true }), paceData: null, selectedNodeId: null });
        await p.mount();
        const names = [...(p.list()?.querySelectorAll('div.absolute.text-sm.leading-tight') ?? [])];
        const out = names.filter((d) => {
            const w = parseFloat(d.style.width);
            return d.style.left ? parseFloat(d.style.left) + w > W + 0.5 : W - parseFloat(d.style.right) - w < -0.5;
        });
        check('a phase starting at the end of a row keeps its name inside the box', names.length === 30 && out.length === 0,
            `${names.length} names, ${out.length} past the edge: ${out.map((d) => d.textContent).join(', ')}`);
        p.close();
    }
    {
        // Phase A holds slots 1–9, phase B starts in slot 10, the last of the
        // first row, and runs on into the second; phase C follows. B's long
        // name had ~3rem at the edge and printed "Phase B — …".
        const nodes = [];
        const phase = (id, title, n, from) => {
            nodes.push(node(id, null, { title }));
            for (let i = 0; i < n; i++) nodes.push(node(id + 1 + i, id, { scheduled_start: day(from + i), scheduled_end: day(from + i) }));
        };
        phase(500, 'Phase A', 9, 1);
        phase(520, 'Phase B — Academic Reading, three passages', 4, 10);
        phase(540, 'Phase C', 10, 14);
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1, { topic_count: 23 })], tree: tree.buildTree(nodes), paceData: null, selectedNodeId: null });
        await p.mount();
        const names = [...(p.list()?.querySelectorAll('div.absolute.text-sm.leading-tight') ?? [])];
        const named = (t) => names.find((d) => d.textContent.startsWith(t));
        const a = named('Phase A'), b = named('Phase B'), c = named('Phase C');
        check('a phase starting in the last slot of a row is named on the next row, with room for its name',
            a && b && c && parseFloat(b.style.top) > parseFloat(a.style.top) && parseFloat(b.style.width) >= 10 * 16,
            b ? `A top ${a?.style.top}, B top ${b.style.top}, B width ${b.style.width}` : 'no name for B');
        // A row read right to left anchors its names on the right.
        const span = (d) => {
            const w = parseFloat(d.style.width);
            const l = d.style.left ? parseFloat(d.style.left) : W - parseFloat(d.style.right) - w;
            return [l, l + w];
        };
        const clash = names.some((d, i) => names.some((e, j) => j > i && d.style.top === e.style.top
            && Math.min(span(d)[1], span(e)[1]) - Math.max(span(d)[0], span(e)[0]) > 0.5));
        check('two names on one row never overlap', b && c && b.style.top === c.style.top && !clash,
            names.map((d) => `${d.textContent.slice(0, 7)} ${d.style.top} [${span(d).map(Math.round)}]`).join('; '));
        p.close();
    }

    // ---- 3c. the narrow list's line never goes red after grey ------------------
    // The plan's mark at a phase's first stop is drawn above the phase's row,
    // and one inside a shut phase stays on screen below its row.
    {
        const nodes = [];
        for (let b = 0; b < 3; b++) {
            const pid = 400 + b * 20;
            nodes.push(node(pid, null));
            for (let i = 1; i <= 10; i++) {
                // Phase 0 ended; phase 1 half ended (the plan stands at its 6th
                // stop); phase 2 ahead.
                const ended = b === 0 || (b === 1 && i <= 5);
                nodes.push(node(pid + i, pid, ended ? { scheduled_start: day(-30 + i), scheduled_end: day(-30 + i) } : { scheduled_start: day(b * 10 + i), scheduled_end: day(b * 10 + i) }));
            }
        }
        const lineOrder = (p) => [...p.el.querySelectorAll('li > div:first-child > span.w-1')]
            .map((s) => (/bg-emerald/.test(s.className) ? 'd' : /bg-red/.test(s.className) ? 'b' : 'a')).join('');
        const p = page({ width: 400 });
        await p.set({ currentProjectId: 1, projects: [course(1, { topic_count: 30 })], tree: tree.buildTree(nodes), paceData: null, selectedNodeId: null });
        await p.mount();
        check('the list\'s line: red from the start to the plan, grey after, never red again', /^b+a+$/.test(lineOrder(p)), lineOrder(p));
        // The second phase's row (phase 420).
        const h = [...p.el.querySelectorAll('button[aria-expanded]')][1];
        if (h && h.getAttribute('aria-expanded') === 'true') await p.click(h);
        check('a shut phase holding the plan still shows "Plan for today"', h?.getAttribute('aria-expanded') === 'false' && /Plan for today/.test(p.el.textContent));
        check('…and its line keeps the order (red into the mark, grey after)', /^b+a+$/.test(lineOrder(p)), lineOrder(p));
        p.close();
    }
    {
        // Ten done, then the plan at the second phase's first stop: the mark
        // goes ABOVE that phase's row.
        const nodes = [];
        for (let b = 0; b < 3; b++) {
            const pid = 500 + b * 20;
            nodes.push(node(pid, null));
            for (let i = 1; i <= 10; i++) nodes.push(node(pid + i, pid, b === 0
                ? { status: 'completed', scheduled_start: day(-30 + i), scheduled_end: day(-30 + i) }
                : { scheduled_start: day(b * 10 + i), scheduled_end: day(b * 10 + i) }));
        }
        const p = page({ width: 400 });
        await p.set({ currentProjectId: 1, projects: [course(1, { topic_count: 30 })], tree: tree.buildTree(nodes), paceData: null, selectedNodeId: null });
        await p.mount();
        const items = [...p.el.querySelectorAll('ul > li')].map((li) => (/Plan for today/.test(li.textContent) ? 'PLAN' : li.querySelector('[aria-expanded]') ? 'PHASE' : li.dataset.nodeId ? 'stop' : 'end'));
        const at = items.indexOf('PLAN');
        eq('the plan at a phase\'s first stop is drawn just above that phase\'s row', items.slice(at, at + 2).join(' '), 'PLAN PHASE');
        eq('…once', items.filter((x) => x === 'PLAN').length, 1);
        p.close();
    }

    // ---- 4. a finished course: the plan is over -------------------------------
    for (const allDone of [false, true]) {
        const p = page({ width: 900 });
        const nodes = behindNodes.map((x) => (allDone && x.parent_id ? { ...x, status: 'completed' } : x));
        await p.set({ currentProjectId: 1, projects: [course(1, { status: 'completed' })], tree: tree.buildTree(nodes), paceData: null, selectedNodeId: null });
        await p.mount();
        const states = p.stops().map((b) => b.dataset.state);
        const text = p.el.textContent;
        const headline = p.summary()?.querySelector('p');
        if (!allDone) {
            check('a finished course calls nothing in it late or "Now" (closed)',
                states.length === 6 && !states.some((s) => s === 'late' || s === 'now' || s === 'ready'), states.join(' '));
            check('…puts no You or plan mark on the line, and offers no Study',
                !/You are here|Plan for today/.test(text) && !/Study/.test(p.summary()?.textContent ?? ''), text.slice(0, 200));
            check('…and is not green while topics are still open', headline && !/emerald/.test(headline.className), headline?.className);
            const red = [...(p.list()?.querySelector('svg')?.querySelectorAll('path') ?? [])].filter((x) => /stroke-red/.test(x.getAttribute('class')));
            eq('…and draws no red on its line', red.length, 0);
            const narrow = page({ width: 400 });
            await narrow.set({ currentProjectId: 1, projects: [course(1, { status: 'completed' })], tree: tree.buildTree(nodes), paceData: null, selectedNodeId: null });
            await narrow.mount();
            const redMarks = [...narrow.el.querySelectorAll('li > div:first-child [class*="red"]')].length;
            eq('…nor in the narrow list (line or phase square)', redMarks, 0);
            narrow.close();
        } else {
            check('a finished course with every topic done says Finished in green',
                headline && /Finished/.test(headline.textContent) && /emerald/.test(headline.className), headline?.className);
        }
        p.close();
    }
    {
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1, { start_date: day(5), deadline: day(40) })], tree: behindTree, paceData: null, selectedNodeId: null });
        await p.mount();
        check('before the course starts there is no plan mark to stand on the line', !/Plan for today/.test(p.el.textContent));
        p.close();
    }

    // ---- 5. it opens at You, in both layouts -----------------------------------
    // A deck opens at its first section not done, which only the card plan
    // knows. Landing on the frame before the plan arrived put it at the top,
    // among ten finished sections.
    for (const width of [400, 900]) {
        // Fifty done: You is deep enough in either layout that it must scroll.
        const SECTIONS = 80, DONE = 50;
        const nodes = [node(100, null)];
        for (let i = 1; i <= SECTIONS; i++) nodes.push(node(100 + i, 100, { role: 'pagination', cards: 10, seen: i <= DONE ? 10 : 0 }));
        const cardPlan = Array.from({ length: SECTIONS }, (_, i) => ({
            nodeId: 101 + i, start: day(-30 + i), end: day(-30 + i), cards: 10, seen: i < DONE ? 10 : 0,
        }));
        const p = page({ width });
        await p.set({ currentProjectId: 1, projects: [course(1, { teaches: false, topic_count: 0, card_count: SECTIONS * 10 })], tree: tree.buildTree(nodes), paceData: null, selectedNodeId: null });
        await p.mount();
        const before = p.summary()?.textContent ?? '';
        check(`a deck before its plan arrives claims no card count (${width}px)`, before !== '' && !/cards left/.test(before), before);
        await p.set({ paceData: { hasSchedule: true, onTrack: true, expectedProgress: 50, actualProgress: 40, daysBehind: 0, paceStatus: 'on_track', message: '', basis: 'cards', cardPlan } });
        check(`a deck opens with its first section not done in the middle of the view, once its plan is here (${width}px)`,
            p.scrollTop() > 0 && p.offCentre(151) === 0, `scrollTop ${p.scrollTop()}, section 151 is ${p.offCentre(151)}px off the middle`);
        p.close();
    }

    // A course measured in topics is final at once: the snake must still wait
    // for its own measured width, or the landing finds no stop and never returns.
    {
        const nodes = [node(600, null)];
        for (let i = 1; i <= 80; i++) nodes.push(node(600 + i, 600, { status: i <= 50 ? 'completed' : 'not_started', scheduled_start: day(-40 + i), scheduled_end: day(-40 + i) }));
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1, { topic_count: 80 })], tree: tree.buildTree(nodes), paceData: null, selectedNodeId: null });
        await p.mount();
        check('a long course opens with You in the middle of the snake, on its first frame of stops',
            p.scrollTop() > 0 && p.offCentre(651) === 0, `scrollTop ${p.scrollTop()}, stop 651 is ${p.offCentre(651)}px off the middle`);
        p.close();
    }

    // ---- 6. a course change drops the last one's pace ---------------------------
    {
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1), course(2)], tree: behindTree, paceData: { hasSchedule: true, paceStatus: 'on_track', basis: 'cards', cardPlan: [] } });
        await p.act(async () => { p.useStore.getState().loadProjectData(2); });
        eq('a course change clears the previous course\'s pace', p.useStore.getState().paceData, null);
        p.close();
    }

    // ---- 7. the narrow list: phases fold, a selection opens its own -----------
    // Four phases of ten (over SMALL_PLAN_STOPS): only the phases holding You
    // and the plan's mark open. A selection made elsewhere opens its phase;
    // clicking a stop in another phase must not shut it again, or every row
    // below would move up under the pointer.
    {
        const nodes = [];
        for (let b = 0; b < 4; b++) {
            const pid = 200 + b * 20;
            nodes.push(node(pid, null));
            for (let i = 1; i <= 10; i++) nodes.push(node(pid + i, pid, { scheduled_start: day(-30 + 15 * b), scheduled_end: day(-16 + 15 * b) }));
        }
        const p = page({ width: 400 });
        await p.set({ currentProjectId: 1, projects: [course(1, { topic_count: 40 })], tree: tree.buildTree(nodes), paceData: null, selectedNodeId: null });
        await p.mount();
        check('a long plan opens the phases of You and the plan, the rest shut',
            p.shown(201) && p.shown(241) && !p.shown(221) && !p.shown(261), p.listRows().map((li) => li.dataset.nodeId).join(' '));
        const phases = [...p.el.querySelectorAll('button[aria-expanded]')].map((b) => b.getAttribute('aria-expanded')).join();
        eq('…and each phase says whether it is open', phases, 'true,false,true,false');
        await p.set({ selectedNodeId: 225 });
        check('a selection from elsewhere opens its phase', p.shown(225));
        const other = p.listRows().find((li) => li.dataset.nodeId === '245')?.querySelector('[data-row]');
        if (other) await p.click(other);
        eq('clicking a stop in another phase selects it', p.useStore.getState().selectedNodeId, 245);
        check('…and the phase opened for the last selection stays open (rows do not jump)', p.shown(225));
        const current = p.listRows().find((li) => li.dataset.nodeId === '245')?.querySelector('[data-row]');
        eq('the selected stop says so to a screen reader (aria-current), not only by colour', current?.getAttribute('aria-current'), 'true');
        p.close();
    }
}
