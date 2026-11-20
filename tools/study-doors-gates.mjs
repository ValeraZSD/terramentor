#!/usr/bin/env node
// tools/study-doors-gates.mjs — a course is studied through one door.
//
// Run:  node tools/study-doors-gates.mjs
//
// WHY. Since topic dates follow the learner's pace, the course Dashboard's
// "Today's Plan" list drew only on days a course needed two or more topics, so
// the page changed shape from day to day. Its rows opened the topic panel,
// while "Start Studying" right above it teaches the same topics in the same
// order. The list is gone; "Next up" is the one way into today's work.
//
// And the Atlas's "Study next" rows said "study" but opened the topic panel
// too. They now start the lesson, with a play mark of their own, so they do not
// look like a region's topic rows, which still open the topic.
//
// Asserted on the REAL store and components, bundled into jsdom with
// navigation a spy and the network refused:
//  - a course whose daily plan holds topics besides Next up shows no
//    "Today's Plan", and Start Studying is still there;
//  - loading the Dashboard asks the server for no daily plan;
//  - pressing a "Study next" row lands on /project/:id/study/:nodeId, its
//    name starts with "Study" and its mark is not a region row's arrow;
//  - a region's topic row still opens the topic (/project/:id/tree/:nodeId).
//
// No model, no network.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import StudyDashboard from './src/components/StudyDashboard';
            import StudyNext from './src/components/atlas/StudyNext';
            import RegionList from './src/components/atlas/RegionList';
            import { createElement, act } from 'react'; import { createRoot } from 'react-dom/client';
            const mount = (el, type, props) => { const root = createRoot(el); act(() => root.render(createElement(type, props))); return root; };
            window.__gate = { useStore, mount, act, StudyDashboard, StudyNext, RegionList };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl' },
})).outputFiles[0].text;

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

function page() {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    const asked = [];
    // Every request is recorded. The Dashboard's own is answered, so the
    // store goes on to whatever it fetches after it; the rest are left
    // unanswered, and a request made at all is the thing measured.
    w.fetch = (url) => {
        asked.push(String(url));
        if (String(url).endsWith('/study-dashboard')) {
            return Promise.resolve({ ok: true, status: 200, headers: new w.Headers(), json: async () => dashboard });
        }
        return new Promise(() => { });
    };
    w.eval(bundle);
    return { w, asked, gate: w.__gate };
}

// ---------------------------------------------------------------------------
const project = { id: 1, name: 'Calculus', color: '#8B5CF6', icon: 'book', card_count: 0, teaches: true, topic_count: 6 };
const task = (id, title, extra = {}) => ({ id, title, status: 'not_started', scheduled_start: null, scheduled_end: null, parent_id: 2, ...extra });
const hero = task(3, 'Limits');
const dashboard = {
    todaySchedule: [hero, task(4, 'Continuity'), task(5, 'Derivatives')], overdueTopics: [], heroTask: hero, milestones: [],
    flashcardSummary: { totalCards: 0, dueCount: 0, newAvailable: 0, newPerDay: 0, introducedToday: 0, weakCount: 0, retention: null, decks: [] },
    quizSummary: { totalQuizzes: 0, averageScore: null, weakTopics: [], recentAttempts: [] },
    insights: null, pace: null,
    stats: { totalNodes: 6, completedNodes: 1, progressPercent: 17, daysUntilDeadline: 20 },
};
// What the server's daily plan said for such a day: the hero, two more topics
// due today, and one past its date that the learner already knows.
const dailyPlan = {
    date: '2026-06-15',
    overdueTasks: [task(6, 'Chain rule', { readyToProve: true })],
    todayTasks: [hero, task(4, 'Continuity'), task(5, 'Derivatives')],
    recommendations: [], ghostQuestions: [], stats: { overdueCount: 1, todayCount: 3 },
};

section('the course Dashboard has one way into today\'s work');
{
    const { w, asked, gate } = page();
    const { useStore, mount, act, StudyDashboard } = gate;
    const went = [];
    useStore.setState({
        currentProjectId: 1, projects: [project], dashboardData: dashboard, dashboardLoading: false,
        // Seeded on purpose although the store no longer reads it: a store
        // that still kept a daily plan would draw it, and this gate would go
        // red (it did on the code before the list was removed).
        dailyPlan,
        _navigate: (to) => { went.push(to); },
    });
    const r = mount(w.document.getElementById('root'), StudyDashboard, {});
    await act(async () => { await settle(); });
    const text = w.document.body.textContent;
    check('Next up names the topic', text.includes('Limits'), text.slice(0, 200));
    const start = [...w.document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Start Studying');
    check('Start Studying is on the page', !!start);
    if (start) await act(async () => { start.click(); });
    check('…and it opens the course\'s lesson stream', went.at(-1) === '/project/1/study', JSON.stringify(went));
    check('there is no "Today\'s Plan" list', !text.includes("Today's Plan"));
    check('the other topics due today are not listed as rows of their own',
        !text.includes('Continuity') && !text.includes('Derivatives'));
    check('nor is a "Ready to prove" group', !/Ready to prove \(\d+\)/.test(text));
    check('the Dashboard did load (its own request was answered)', asked.some(u => u.endsWith('/study-dashboard')), JSON.stringify(asked));
    check('…and loading it asks for no daily plan',
        !asked.some(u => u.includes('/daily-plan')), JSON.stringify(asked));
    act(() => r.unmount());
    w.close();
}

// ---------------------------------------------------------------------------
const topic = (id, title, projectId, projectName, extra = {}) => ({
    id, title, status: 'not_started', projectId, projectName, projectColor: '#0ea5e9', mastery: 0, attempts: 0, ...extra,
});
const region = {
    id: 7, label: 'Mechanics', labelTopicId: 21, labelSource: 'medoid', medoidLabel: 'Mechanics', signature: 's',
    size: 3, projects: [{ id: 9, name: 'Physics', color: '#0ea5e9', start: null, count: 3 }], crossProject: false,
    mastery: { proven: 1, learning: 0, untouched: 2, avg: 0.3 }, isLandmark: false,
    x: 0, y: 0, radius: 1, u: [0, 0, 1], cap: 1, topicRadius: 1,
    topics: [topic(21, 'Newton\'s laws', 9, 'Physics', { status: 'completed', mastery: 0.9 }), topic(22, 'Momentum', 9, 'Physics'),
        // Not started, with a head start carried over from another course
        // (Study next offers only topics not started).
        topic(23, 'Impulse', 9, 'Physics', { transferred: true })],
};
const next = [
    { topicId: 22, regionId: 7, nearId: 21, nearTitle: 'Newton\'s laws', similarity: 0.8 },
    { topicId: 23, regionId: 7, nearId: 21, nearTitle: 'Newton\'s laws', similarity: 0.7 },
];

function atlas(type, props) {
    const { w, gate } = page();
    const { useStore, mount, act } = gate;
    const went = [];
    useStore.setState({ _navigate: (to) => { went.push(to); } });
    const r = mount(w.document.getElementById('root'), gate[type], props);
    const rows = () => [...w.document.querySelectorAll('button[data-row]')];
    return { w, went, act, rows, close: () => { act(() => r.unmount()); w.close(); } };
}
// The name a screen reader gives the row: its aria-label, else its text
// without what is aria-hidden.
const accessibleName = (b) => {
    if (b.getAttribute('aria-label')) return b.getAttribute('aria-label');
    const text = (n) => n.nodeType === 3 ? n.textContent
        : n.nodeType === 1 && n.getAttribute('aria-hidden') === 'true' ? '' : [...n.childNodes].map(text).join(' ');
    return text(b).replace(/\s+/g, ' ').trim();
};
const icon = (b) => [...b.querySelectorAll('svg')].map(s => s.getAttribute('class') || '').find(c => /lucide-/.test(c)) || '';
const described = (w, b) => (b.getAttribute('aria-describedby') || '').split(' ').filter(Boolean)
    .map(i => w.document.getElementById(i)?.textContent ?? '(missing)').join(' | ');

section('a "Study next" row starts the lesson');
let nextIcon = '';
{
    const s = atlas('StudyNext', { next, regions: [region] });
    const row = s.rows().find(b => b.textContent.includes('Momentum'));
    check('the row is drawn', !!row);
    if (row) {
        check('its name starts with "Study"', /^Study\b/.test(accessibleName(row)), accessibleName(row));
        check('…and names the topic', accessibleName(row) === 'Study Momentum', accessibleName(row));
        // An aria-label would hide the line under the title from the name,
        // which axe reports as a label that does not match the visible text.
        check('the name comes from the row\'s own text, not an aria-label', !row.hasAttribute('aria-label'));
        // What the name no longer says is still read, as the description.
        const said = described(s.w, row);
        check('its status and why it was picked are its description', said.includes('Not started') && said.includes("Near Newton's laws"), said);
        nextIcon = icon(row);
        // Filled and in the accent at rest: the row's action, not a hover
        // hint like a region row's grey arrow.
        check('its mark is a filled play in the accent',
            /lucide-play\b/.test(nextIcon) && /\bfill-current\b/.test(nextIcon) && /\btext-accent-fg\b/.test(nextIcon), nextIcon);
        const headStart = s.rows().find(b => b.textContent.includes('Impulse'));
        // The title block is hidden from the name, so the head-start note in
        // it must reach the reader another way.
        check('a topic started with a head start says so in its description',
            !!headStart && described(s.w, headStart).includes('head start'), headStart ? described(s.w, headStart) : 'no row');
        await s.act(async () => { row.click(); });
    }
    check('pressing it lands on the topic\'s lesson', s.went.at(-1) === '/project/9/study/22', JSON.stringify(s.went));
    s.close();
}

section('a region\'s topic row still opens the topic');
{
    const s = atlas('RegionList', {
        regions: [region], selectedId: 7, onSelect: () => { }, dark: false, accent: '#7c3aed', colorMode: 'mastery',
        hues: new Map(), surface: 'globe', onRename: async () => { }, onResetName: async () => { },
    });
    const row = s.rows().find(b => b.textContent.includes('Momentum'));
    check('the row is drawn', !!row);
    if (row) {
        check('its name does not start with "Study"', !/^Study\b/.test(accessibleName(row)), accessibleName(row));
        const regionIcon = icon(row);
        check('its mark is not the "Study next" mark', !!regionIcon && !!nextIcon && regionIcon !== nextIcon, `${regionIcon} vs ${nextIcon}`);
        await s.act(async () => { row.click(); });
    }
    check('pressing it opens the topic', s.went.at(-1) === '/project/9/tree/22', JSON.stringify(s.went));
    s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
