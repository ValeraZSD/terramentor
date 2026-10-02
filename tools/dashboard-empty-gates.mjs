// tools/dashboard-empty-gates.mjs — the study dashboard's "Next up" card says what is true.
//
// Run:  node tools/dashboard-empty-gates.mjs          (the working tree)
//       node tools/dashboard-empty-gates.mjs --head   (HEAD's StudyDashboard, to watch
//                                                      the cases fail on the pre-fix code)
//
// WHY. A course with NO topics opened its dashboard on a green tick and "All caught
// up! Nothing is scheduled or overdue right now." (UX-11, outside UI/UX review
// 2026-09-30) — the wording of a finished course on the page of one that has not
// begun, with no way on. And a course with topics and NO schedule showed its first
// unfinished topic under "Scheduled for today.", which nothing had scheduled. The
// dashboard already holds the facts (`stats.totalNodes`, `heroTask`, `todaySchedule`),
// so each state is told apart from those and gets one useful action:
//   no topics            -> say so, and the button goes to the Tree, where categories are added
//   topics, no schedule  -> say nothing is scheduled; Start Studying (the course's own stream)
//   scheduled today      -> "Scheduled for today."   (unchanged)
//   overdue              -> "Overdue — it was due …" (unchanged)
//   everything closed    -> "All caught up!"         (unchanged)
// A project measured in cards renders DeckDashboard, never this component
// (Workspace.tsx `cardsOnly`), so it keeps whatever it shows.
//
// The REAL store and StudyDashboard are bundled into jsdom with the dashboard payload
// set directly and navigation a spy.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const HEAD = process.argv.includes('--head');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const headFiles = {
    name: 'head-files',
    setup(build) {
        if (!HEAD) return;
        build.onLoad({ filter: /[\\/]src[\\/]components[\\/]StudyDashboard\.tsx$/ }, (args) => {
            const rel = args.path.slice(root.length + 1).replace(/\\/g, '/');
            return { contents: execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' }), loader: 'tsx' };
        });
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import StudyDashboard from './src/components/StudyDashboard';
            import { createElement, act } from 'react'; import { createRoot } from 'react-dom/client';
            const mount = (el) => { const root = createRoot(el); act(() => root.render(createElement(StudyDashboard))); return root; };
            window.__gate = { useStore, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl' },
    plugins: [headFiles],
})).outputFiles[0].text;

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const project = { id: 1, name: 'Calculus', color: '#8B5CF6', icon: 'book', card_count: 0, teaches: true, topic_count: 0 };
const base = {
    todaySchedule: [], overdueTopics: [], heroTask: null, milestones: [],
    flashcardSummary: { totalCards: 0, dueCount: 0, newAvailable: 0, newPerDay: 0, introducedToday: 0, weakCount: 0, retention: null, decks: [] },
    quizSummary: { totalQuizzes: 0, averageScore: null, weakTopics: [], recentAttempts: [] },
    insights: null, pace: null,
    stats: { totalNodes: 0, completedNodes: 0, progressPercent: 0, daysUntilDeadline: null },
};
const today = new Date().toISOString().slice(0, 10);
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function show(dashboard, extra = {}) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    w.fetch = () => new Promise(() => { });
    w.eval(bundle);
    const { useStore, mount, act } = w.__gate;
    const went = [];
    useStore.setState({
        currentProjectId: 1, projects: [{ ...project, ...extra }], dashboardData: { ...base, ...dashboard }, dashboardLoading: false,
        dailyPlan: null,
        loadDashboard: async () => ({ success: true }),
        _navigate: (to) => { went.push(to); },
    });
    const root = mount(w.document.getElementById('root'));
    await act(async () => { await settle(); });
    const text = () => w.document.body.textContent;
    const button = (label) => [...w.document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
    return { text, button, went, act, close: () => { act(() => root.unmount()); w.close(); } };
}

// ---------------------------------------------------------------------------
section('a course with no topics is not "all caught up"');
{
    const s = await show({});
    check('it does not say "All caught up!"', !s.text().includes('All caught up'), s.text().slice(0, 200));
    check('it does not say nothing is scheduled or overdue', !s.text().includes('Nothing is scheduled or overdue'));
    check('it says there are no topics yet', s.text().includes('No topics yet.'));
    const go = s.button('Open the Tree');
    check('it offers one action that goes where categories are added', !!go);
    if (go) await s.act(async () => { go.click(); });
    check('…and pressing it opens this course\'s Tree tab', s.went.at(-1) === '/project/1/tree', JSON.stringify(s.went));
    check('it does not offer Start Studying (nothing to study)', !s.button('Start Studying'));
    s.close();
}

section('topics but nothing scheduled: say so, and Start Studying works');
{
    const hero = { id: 3, title: 'Limits', status: 'not_started', scheduled_start: null, scheduled_end: null, parent_id: 2 };
    const s = await show({ heroTask: hero, stats: { ...base.stats, totalNodes: 4 } }, { topic_count: 4 });
    check('the topic is named', s.text().includes('Limits'));
    check('it does not claim the topic is scheduled for today', !s.text().includes('Scheduled for today.'), s.text().slice(0, 300));
    check('it says nothing is scheduled yet', s.text().includes('Nothing is scheduled yet.'));
    const go = s.button('Start Studying');
    check('Start Studying is the action', !!go);
    if (go) await s.act(async () => { go.click(); });
    check('…and it opens the course\'s stream, no schedule needed', s.went.at(-1) === '/project/1/study', JSON.stringify(s.went));
    s.close();
}
{
    const hero = { id: 3, title: 'Limits', status: 'not_started', scheduled_start: day(5), scheduled_end: day(7), parent_id: 2 };
    const s = await show({ heroTask: hero, stats: { ...base.stats, totalNodes: 4 } }, { topic_count: 4 });
    check('scheduled for LATER: not "for today", and it says nothing is due today',
        !s.text().includes('Scheduled for today.') && s.text().includes('Nothing is due today.'), s.text().slice(0, 300));
    s.close();
}

section('the states that were already right stay as they were');
{
    const hero = { id: 3, title: 'Limits', status: 'not_started', scheduled_start: today, scheduled_end: today, parent_id: 2 };
    const s = await show({ heroTask: hero, todaySchedule: [hero], stats: { ...base.stats, totalNodes: 4 } }, { topic_count: 4 });
    check('scheduled for today still says so', s.text().includes('Scheduled for today.'));
    s.close();
}
{
    const hero = { id: 3, title: 'Limits', status: 'not_started', scheduled_start: day(-5), scheduled_end: day(-2), parent_id: 2 };
    const s = await show({ heroTask: hero, overdueTopics: [hero], stats: { ...base.stats, totalNodes: 4 } }, { topic_count: 4 });
    check('overdue still says it was due', s.text().includes('Overdue — it was due'));
    s.close();
}
{
    const s = await show({ stats: { ...base.stats, totalNodes: 4, completedNodes: 4, progressPercent: 100 } }, { topic_count: 4 });
    check('every topic closed: "All caught up!" is still the message', s.text().includes('All caught up!'));
    check('…and the no-topics message is not shown', !s.text().includes('No topics yet.'));
    s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
