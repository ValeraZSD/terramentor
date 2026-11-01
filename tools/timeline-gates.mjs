#!/usr/bin/env node
/**
 * The project Timeline (src/components/schedule/ProjectTimeline.tsx): what a
 * row says about itself, the axis it is drawn on, and the layout rules the
 * redesign of 1 Nov 2026 rests on.
 *
 * The screen it replaced drew every row of a course that had fallen behind as
 * one red bar — a topic three-quarters done and one never opened looked the
 * same — gave a plan from August to December no year anywhere on its axis,
 * left the deadline undrawn, and collapsed to a 215px column without bars as
 * soon as a row was clicked, because its two-column layout followed the WINDOW
 * while the detail panel took the room beside it. Each of those is a number or
 * a line of source, so each is asserted here.
 *
 * No model, no network, no real browser: the screen itself is rendered in jsdom.
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

    // A late bar is not all late: the share done is drawn, so 76% done and
    // never opened stop looking alike.
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

    // ---- the axis ------------------------------------------------------------
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
    // Six years on a ~150px phone lane: each label 25px from the next. Popping
    // the previous label on every collision kept only "2031".
    const sixYears = { from: '2026-01-01', to: '2031-12-31' };
    eq('a long plan on a narrow lane keeps every other year, from its first',
        typeof ax.buildYears === 'function' ? ax.buildYears(sixYears, 150 / ax.daysBetween(sixYears.from, sixYears.to)).map((y) => y.label).join() : '',
        '2026,2028,2030');

    // The two line labels are sized at the current root font size (ui_scale)
    // and a CJK glyph is ~1em: a 16px guess overprinted them at 150% and in ja/zh.
    const lw = typeof ax.markerLabelPx === 'function' ? ax.markerLabelPx : () => 0;
    eq('a label at 16px root is the width it was tuned to ("Today": 5 × 6.38 + 12)', Math.round(lw('Today', 16)), 44);
    check('…and 1.5 times as wide at 150% (24px root)', lw('Today', 16) > 0 && Math.abs(lw('Today', 24) - 1.5 * lw('Today', 16)) < 0.01, `${lw('Today', 24)} vs ${lw('Today', 16)}`);
    eq('a CJK label counts each glyph as 1em ("截止日期" at 16px: 4 × 11 + 12)', lw('截止日期', 16), 56);

    // Labels for the two lines: never on top of each other, never out of the lane.
    const place = typeof ax.placeMarkerLabels === 'function' ? ax.placeMarkerLabels : () => ({ today: null, deadline: null });
    const inLane = (x, w, laneW) => x !== null && x >= 0 && x + w <= laneW + 0.01;
    {
        const p = place(600, { pct: 60, w: 50 }, { pct: 64, w: 70 });
        check('close lines: both labels shown', p.today !== null && p.deadline !== null, JSON.stringify(p));
        check('close lines: today\'s label left of the deadline\'s, apart', p.today !== null && p.deadline !== null && p.today + 50 <= p.deadline, JSON.stringify(p));
        check('close lines: both inside the lane', inLane(p.today, 50, 600) && inLane(p.deadline, 70, 600), JSON.stringify(p));
    }
    {
        const p = place(600, { pct: 20, w: 50 }, { pct: 90, w: 70 });
        eq('far apart: today\'s label centred on its line', p.today, 0.2 * 600 - 25);
        eq('far apart: the deadline\'s centred on its line', p.deadline, 0.9 * 600 - 35);
    }
    {
        const p = place(600, { pct: 98, w: 50 }, { pct: 100, w: 70 });
        check('at the right edge both labels stay in the lane', inLane(p.today, 50, 600) && inLane(p.deadline, 70, 600), JSON.stringify(p));
    }
    {
        const p = place(100, { pct: 50, w: 60 }, { pct: 52, w: 70 });
        check('no room for both: today keeps its label, the deadline keeps only its line',
            p.today !== null && p.deadline === null, JSON.stringify(p));
    }

    // ---- the screen: rules that are lines of source --------------------------
    const tl = code('src/components/schedule/ProjectTimeline.tsx');
    check('the layout follows the timeline\'s own width, not the window (no sm:/md:/lg: classes)',
        !/["'`\s](sm|md|lg|xl|2xl):[a-z]/.test(tl), (tl.match(/["'`\s](sm|md|lg|xl|2xl):[a-z][\w-]*/g) || []).join(' '));
    check('…measured with useElementWidth', /useElementWidth\(/.test(tl));
    check('no detail-level switch: the plan opens where the learner is', !/SegmentedControl/.test(tl));
    check('a bar fills with the share done', /row\.done \* 100/.test(tl) && /data-done-fill/.test(tl));
    check('being behind comes with the action that fixes it', /recalibrateSchedule\(/.test(tl) && /t\("Recalibrate Schedule"\)/.test(tl));
    check('a finished course calls nothing in it "Overdue"', /finished && row\.state !== 'done'/.test(tl) && /closed: null/.test(tl));
    check('…and is green only when its work is all done',
        /if \(workLeft === 0\) tone = 'text-emerald/.test(tl) && !/headline = t\("Finished"\);\s*tone = /.test(tl));
    const pctRule = (tl.match(/const showPct = ([\s\S]*?);/) || [])[1] || '';
    check('no "0%" beside Ready to prove or on a finished course\'s untouched rows',
        pctRule !== '' && !/state === 'ready'|state === 'closed'/.test(pctRule), pctRule || 'no showPct');
    check('it opens at the first topic not done, inside its own list',
        /landedFor/.test(tl) && /scrollIntoViewWithin\(row, \{\s*boundary: list/.test(tl));
    check('…except a finished course, which has no next topic and opens at its top',
        /if \(selectedNodeId != null \|\| project\.status === 'completed'\) return;/.test(tl));
    // At 150% display scaling Chromium painted a scrolled row 1–2px past the
    // list's top edge: a sliver of text above the axis (measured: 95 pixels at
    // 1.5x, none at 1x, 1.25x or 2x). Both halves of the fix are needed.
    check('the axis header sticks past the list\'s edge, and the summary covers the list',
        /sticky -top-px/.test(tl) && /relative z-20[^`]*bg-white dark:bg-slate-800/.test(tl));
    check('a row reached by Tab scrolls to below the sticky header (scroll padding in rem)',
        /ref=\{scrollRef\} className="[^"]*\bscroll-pt-\d+\b/.test(tl));
    const shortRangeSrc = tl.match(/function shortRange[\s\S]*?\n\}/)?.[0] ?? '';
    check('one date formatter per locale, not one per row per render',
        shortRangeSrc !== '' && !/new Intl\.DateTimeFormat/.test(shortRangeSrc) && /dayMonthFormats\.get\(/.test(tl));

    const lane = code('src/components/schedule/laneAxis.tsx');
    const todayLine = (lane.match(/data-today-line[\s\S]{0,120}?className="([^"]*)"/) || [])[1] || '';
    check('the today line is not red (red is "late")', todayLine !== '' && !/red/.test(todayLine), todayLine || 'no today line');
    const todayPill = (lane.match(/data-today-label[\s\S]{0,120}?className="([^"]*)"/) || [])[1] || '';
    check('…nor the course\'s accent, which can be the green of "done"',
        todayLine !== '' && todayPill !== '' && !/accent|emerald|green/.test(todayLine + todayPill), `${todayLine} | ${todayPill}`);
    check('the deadline is drawn, and both lines are named in the header',
        /data-deadline-line/.test(lane) && /t\("Today"\)/.test(lane) && /t\("Deadline"\)/.test(lane));

    const ws = code('src/components/Workspace.tsx');
    check('no navigation sidebar beside the Timeline (it repeated every row)',
        /workspaceView !== 'timeline' && <Sidebar \/>/.test(ws));
    check('the header\'s pace pill stays off the Timeline (its summary says it in words)',
        /workspaceView !== 'timeline' && <PaceIndicator full=\{paceFull\} \/>/.test(ws)
        && [...ws.matchAll(/<PaceIndicator full=\{paceFull\}/g)].length === 1);
    const pace = code('src/components/PaceIndicator.tsx');
    check('a finished course shows no "days behind" pill',
        /status === 'completed'/.test(pace) && /\|\| finished\) return null/.test(pace));

    // ---- the screen itself, rendered ----------------------------------------
    // The REAL store and ProjectTimeline in jsdom (the pattern of
    // dashboard-load-gates.mjs). jsdom has no layout, so the few numbers the
    // screen reads are stubbed: the element's width, and a list of 40px rows
    // under a 60px header in a 400px scroller.
    await renderChecks();
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

async function renderChecks() {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { JSDOM } = require('jsdom');
    const built = await esbuild.build({
        stdin: {
            contents: `
                import { useStore } from './src/store';
                import ProjectTimeline from './src/components/schedule/ProjectTimeline';
                import { createElement, act } from 'react'; import { createRoot } from 'react-dom/client';
                const mount = (el) => { const r = createRoot(el); act(() => r.render(createElement(ProjectTimeline))); return r; };
                window.__gate = { useStore, mount, act };`,
            resolveDir: root, loader: 'tsx',
        },
        bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
        nodePaths: [join(here, 'node_modules')],
        define: { 'process.env.NODE_ENV': '"development"' },
        loader: { '.css': 'empty', '.svg': 'dataurl' },
    });
    const bundled = built.outputFiles[0].text;
    const tree = await bundle('src/utils/tree.ts');
    const day = (n) => tree.addDays(tree.todayStr(), n);
    const ROW = 40, HEAD = 60, VIEW = 400;

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
        const rowIndex = (el) => [...el.parentElement.children].indexOf(el);
        const tops = new WeakMap();
        Object.defineProperty(P, 'clientWidth', { configurable: true, get() { return width; } });
        Object.defineProperty(P, 'clientHeight', { configurable: true, get() { return isList(this) ? VIEW : 0; } });
        Object.defineProperty(P, 'scrollHeight', { configurable: true, get() { return isList(this) ? HEAD + this.querySelectorAll('li').length * ROW : 0; } });
        Object.defineProperty(P, 'offsetHeight', { configurable: true, get() { return this.tagName === 'LI' ? ROW : this.hasAttribute('data-axis-header') ? HEAD : 0; } });
        Object.defineProperty(P, 'scrollTop', { configurable: true, get() { return tops.get(this) ?? 0; }, set(v) { tops.set(this, v); } });
        P.scrollTo = function ({ top }) { tops.set(this, top); };
        w.Element.prototype.getBoundingClientRect = function () {
            const list = this.closest('.overflow-y-auto');
            const top = this.tagName === 'LI' && list ? HEAD + rowIndex(this) * ROW - (tops.get(list) ?? 0) : 0;
            const height = this.tagName === 'LI' ? ROW : isList(this) ? VIEW : 0;
            return { top, bottom: top + height, height, left: 0, right: width, width, x: 0, y: top, toJSON() { } };
        };
        const gcs = w.getComputedStyle.bind(w);
        w.getComputedStyle = (el, p) => {
            const s = gcs(el, p);
            if (el.classList?.contains('overflow-y-auto')) Object.defineProperty(s, 'overflowY', { value: 'auto' });
            return s;
        };
        w.eval(bundled);
        const { useStore, mount, act } = w.__gate;
        useStore.setState({ _navigate: null });
        const el = w.document.getElementById('root');
        let r = null;
        const settle = async () => {
            for (let i = 0; i < 10; i++) await new Promise((ok) => setImmediate(ok));
            await new Promise((ok) => w.requestAnimationFrame(ok));
        };
        return {
            w, useStore, el, act,
            set: async (state) => { await act(async () => { useStore.setState(state); await settle(); }); },
            mount: async () => { await act(async () => { r = mount(el); await settle(); }); },
            click: async (target) => { await act(async () => { target.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(); }); },
            list: () => el.querySelector('.overflow-y-auto'),
            rows: () => [...el.querySelectorAll('li[data-node-id]')],
            close: () => { if (r) act(() => r.unmount()); w.close(); },
        };
    };
    const node = (id, parent, extra = {}) => ({
        id, project_id: 1, parent_id: parent, title: `n${id}`, is_note: 0, role: 'topic', status: 'not_started', position: id,
        scheduled_start: null, scheduled_end: null, cards: 0, seen: 0, ...extra,
    });
    const course = (id, extra = {}) => ({
        id, name: `Course ${id}`, color: '#0369a1', icon: 'book', status: 'active', teaches: true,
        topic_count: 3, card_count: 0, start_date: day(-30), deadline: day(30), ...extra,
    });
    const small = tree.buildTree([
        node(1, null, { scheduled_start: day(-30), scheduled_end: day(30) }),
        node(2, 1, { status: 'completed', scheduled_start: day(-30), scheduled_end: day(-10) }),
        node(3, 1, { scheduled_start: day(-9), scheduled_end: day(10) }),
        node(4, 1, { scheduled_start: day(11), scheduled_end: day(30) }),
    ]);

    // 1. A cold load: the tab mounts before the projects have arrived, so the
    //    first render is the "No schedule set" state. The width must still be
    //    measured, or the narrow layout never applies.
    {
        const p = page({ width: 400 });
        await p.set({ currentProjectId: 1, projects: [course(1, { start_date: null, deadline: null })], tree: small, paceData: null });
        await p.mount();
        await p.set({ projects: [course(1)] });
        const rows = p.rows();
        check('cold load: rows are laid out for the measured 400px (lane under the title, no two columns)',
            rows.length > 0 && rows.every((li) => !li.classList.contains('grid')),
            `${rows.length} rows; ${rows.map((li) => li.className.split(' ')[0]).join(' ')}`);
        p.close();
    }

    // 2. Before the pace answers, the summary claims nothing about it.
    {
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1)], tree: small, paceData: null });
        await p.mount();
        const summary = p.el.querySelector('[data-plan-summary]')?.textContent ?? '';
        check('pace not here yet: the summary does not say "On track"', summary !== '' && !/On track/.test(summary), summary);
        await p.set({ paceData: { hasSchedule: true, onTrack: false, expectedProgress: 60, actualProgress: 20, daysBehind: 12, paceStatus: 'critical', message: '', basis: 'topics' } });
        const after = p.el.querySelector('[data-plan-summary]')?.textContent ?? '';
        check('…and once it has, a course far behind says so and offers Recalibrate', /behind/i.test(after) && /Recalibrate Schedule/.test(after), after);
        p.close();
    }

    // 3. A deck opens at its first section not done, which only the card plan
    //    knows. Landing on the frame before the plan arrived put it at the top,
    //    among ten finished sections.
    {
        const SECTIONS = 25, DONE = 10;
        const nodes = [node(100, null)];
        for (let i = 1; i <= SECTIONS; i++) nodes.push(node(100 + i, 100, { role: 'pagination', cards: 10, seen: i <= DONE ? 10 : 0 }));
        const cardPlan = Array.from({ length: SECTIONS }, (_, i) => ({
            nodeId: 101 + i, start: day(-30 + 2 * i), end: day(-29 + 2 * i), cards: 10, seen: i < DONE ? 10 : 0,
        }));
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1, { teaches: false, topic_count: 0, card_count: SECTIONS * 10 })], tree: tree.buildTree(nodes), paceData: null });
        await p.mount();
        await p.set({ paceData: { hasSchedule: true, onTrack: true, expectedProgress: 50, actualProgress: 40, daysBehind: 0, paceStatus: 'on_track', message: '', basis: 'cards', cardPlan } });
        // Section 11 is row 11 (the deck's own row is 0): it lands under the
        // header with one row above it.
        eq('a deck opens at its first section not done, once its plan is here', p.list()?.scrollTop, HEAD + 11 * ROW - (HEAD + ROW));
        p.close();
    }

    // 4. Opening another course drops the last one's pace with its tree: left
    //    in place, its card plan laid out the new course's rows.
    {
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1), course(2)], tree: small, paceData: { hasSchedule: true, paceStatus: 'on_track', basis: 'cards', cardPlan: [] } });
        await p.act(async () => { p.useStore.getState().loadProjectData(2); });
        eq('a course change clears the previous course\'s pace', p.useStore.getState().paceData, null);
        p.close();
    }

    // 5. A long plan (over 30 rows) opens only some branches. A selection made
    //    elsewhere opens its branch; clicking a row in another branch must not
    //    shut it again under the pointer.
    {
        const nodes = [];
        for (let b = 0; b < 4; b++) {
            const pid = 200 + b * 20;
            nodes.push(node(pid, null, { scheduled_start: day(-30 + 15 * b), scheduled_end: day(-16 + 15 * b) }));
            for (let i = 1; i <= 10; i++) nodes.push(node(pid + i, pid, { scheduled_start: day(-30 + 15 * b), scheduled_end: day(-16 + 15 * b) }));
        }
        const p = page({ width: 900 });
        await p.set({ currentProjectId: 1, projects: [course(1, { topic_count: 40 })], tree: tree.buildTree(nodes), paceData: null });
        await p.mount();
        const shown = (id) => p.rows().some((li) => li.dataset.nodeId === String(id));
        check('a long plan opens with its later branches shut', !shown(261), p.rows().map((li) => li.dataset.nodeId).join(' '));
        await p.set({ selectedNodeId: 265 });
        check('a selection from elsewhere opens its branch', shown(265));
        const other = p.rows().find((li) => li.dataset.nodeId === '203')?.querySelector('[role="button"]');
        if (other) await p.click(other);
        eq('clicking a row in another branch selects it', p.useStore.getState().selectedNodeId, 203);
        check('…and the branch opened for the last selection stays open (rows do not jump)', shown(265));
        const current = p.rows().find((li) => li.dataset.nodeId === '203')?.querySelector('[role="button"]');
        eq('the selected row says so to a screen reader (aria-current), not only by colour', current?.getAttribute('aria-current'), 'true');
        p.close();
    }
}
