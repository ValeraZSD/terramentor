// tools/dashboard-load-gates.mjs — opening a course shows its study hub once.
//
// Run:  node tools/dashboard-load-gates.mjs          (the working tree)
//       node tools/dashboard-load-gates.mjs --head   (HEAD's store and StudyDashboard, to
//                                                     watch the cases fail on the pre-fix code)
//
// WHY. Opening a course drew "No Data Available" for one frame, then "Loading your study
// hub…", then the hub, then the spinner AGAIN, then the hub (filmed 1 Nov 2026). Two causes:
//   - StudyDashboard's first render came before its effect asked for the dashboard, and
//     nothing said a load was coming, so it took the empty state for "no data";
//   - the dashboard loads on two paths at once (the component's effect, and loadProjectData
//     once the outline arrives), and the outline's path threw away the hub that had just
//     arrived (`dashboardData: null`) before loading it again, so the full-page spinner came
//     back over a page the learner was already reading.
// The rule: another course's hub goes, and a load is marked as coming, when the course
// CHANGES; the outline arriving for the same course refreshes the hub in the background.
//
// The REAL store and StudyDashboard are bundled into jsdom; `fetch` answers only when the
// gate says so, so the order of the two answers is chosen. What the page shows is read at
// every React COMMIT (a Profiler's onRender runs inside the commit), so a state that was on
// screen for one commit is seen. A MutationObserver missed the one-frame "No Data
// Available": React reuses the same div, icon and <p> for the spinner and only swaps the
// text, and the observer's callback runs after the swap.
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
        build.onLoad({ filter: /[\\/]src[\\/](store\.ts|components[\\/]StudyDashboard\.tsx)$/ }, (args) => {
            const rel = args.path.slice(root.length + 1).replace(/\\/g, '/');
            return { contents: execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' }), loader: rel.endsWith('x') ? 'tsx' : 'ts' };
        });
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import StudyDashboard from './src/components/StudyDashboard';
            import { createElement, act, Profiler } from 'react'; import { createRoot } from 'react-dom/client';
            const mount = (el, onCommit) => { const root = createRoot(el); act(() => root.render(createElement(Profiler, { id: 'hub', onRender: onCommit }, createElement(StudyDashboard)))); return root; };
            window.__gate = { useStore, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl' },
    plugins: [headFiles],
})).outputFiles[0].text;

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
const projects = [1, 2].map(id => ({ id, name: `Course ${id}`, color: '#8B5CF6', icon: 'book', card_count: 0, teaches: true, topic_count: 4 }));
const hub = (id) => ({
    todaySchedule: [], overdueTopics: [], milestones: [],
    heroTask: { id: 10 + id, title: `Hero of course ${id}`, status: 'not_started', scheduled_start: null, scheduled_end: null, parent_id: 2 },
    flashcardSummary: { totalCards: 0, dueCount: 0, newAvailable: 0, newPerDay: 0, introducedToday: 0, weakCount: 0, retention: null, decks: [] },
    quizSummary: { totalQuizzes: 0, averageScore: null, weakTopics: [], recentAttempts: [] },
    insights: null, pace: null,
    stats: { totalNodes: 4, completedNodes: 0, progressPercent: 0, daysUntilDeadline: null },
});

// What one piece of added text says the page is showing.
const kind = (text) =>
    text.includes('No Data Available') ? 'empty'
        : text.includes('Loading your study hub') ? 'spinner'
            : /Hero of course (\d)/.test(text) ? `hub${text.match(/Hero of course (\d)/)[1]}` : null;

function page() {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    // Every request waits until the gate answers it; the ones a case never answers
    // (pace, daily plan, placement…) just stay pending.
    const pending = [];
    const asked = [];
    w.fetch = (url) => new Promise((ok) => { asked.push(String(url)); pending.push({ url: String(url), ok }); });
    w.eval(bundle);
    const { useStore, mount, act } = w.__gate;
    const shown = [];
    const el = w.document.getElementById('root');
    const onCommit = () => {
        const k = kind(el.textContent ?? '');
        if (k && shown.at(-1) !== k) shown.push(k);
    };
    useStore.setState({ currentProjectId: null, projects, dashboardData: null, dashboardLoading: false, dailyPlan: null, _navigate: () => { } });
    const answer = async (pattern, body, status = 200) => {
        const i = pending.findIndex(p => pattern.test(p.url));
        if (i < 0) return false;
        const [p] = pending.splice(i, 1);
        await act(async () => {
            p.ok(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
            await settle();
        });
        return true;
    };
    const waiting = (pattern) => pending.filter(p => pattern.test(p.url)).length;
    let r = null;
    return {
        useStore, act, shown, asked, answer, waiting,
        open: async (id) => { await act(async () => { useStore.getState().loadProjectData(id); if (!r) r = mount(el, onCommit); await settle(); }); },
        text: () => w.document.body.textContent,
        close: () => { if (r) act(() => r.unmount()); w.close(); },
    };
}
const NODES = (id) => new RegExp(`/projects/${id}/nodes$`);
const HUB = (id) => new RegExp(`/projects/${id}/study-dashboard$`);
const answerAllHubs = async (s, id) => { while (await s.answer(HUB(id), hub(id))) { /* every copy asked for */ } };

// ---------------------------------------------------------------------------
section('opening a course: the hub answers first, then the outline (the order filmed)');
{
    const s = page();
    await s.open(1);
    await s.answer(HUB(1), hub(1));
    await s.answer(NODES(1), []);
    await answerAllHubs(s, 1);
    check('"No Data Available" never shows while the hub is on its way', !s.shown.includes('empty'), s.shown.join(' → '));
    check('the page goes spinner → hub, once', s.shown.join(' → ') === 'spinner → hub1', s.shown.join(' → '));
    check('it ends on the hub', s.text().includes('Hero of course 1'));
    s.close();
}

section('opening a course: the outline answers first, then the hub');
{
    const s = page();
    await s.open(1);
    await s.answer(NODES(1), []);
    await answerAllHubs(s, 1);
    check('the page goes spinner → hub, once', s.shown.join(' → ') === 'spinner → hub1', s.shown.join(' → '));
    s.close();
}

section('moving to another course never shows the first course\'s hub under it');
{
    const s = page();
    await s.open(1);
    await s.answer(NODES(1), []);
    await answerAllHubs(s, 1);
    const before = s.shown.length;
    await s.open(2);
    check('course 1\'s hub is gone the moment course 2 opens', !s.text().includes('Hero of course 1'), s.text().slice(0, 160));
    check('…and a load is shown instead of "No Data Available"', s.text().includes('Loading your study hub') && !s.text().includes('No Data Available'), s.text().slice(0, 160));
    await s.answer(HUB(2), hub(2));
    await s.answer(NODES(2), []);
    await answerAllHubs(s, 2);
    check('course 2: spinner → hub, once', s.shown.slice(before).join(' → ') === 'spinner → hub2', s.shown.slice(before).join(' → '));
    s.close();
}

section('the same course loaded again refreshes its hub in the background');
{
    const s = page();
    await s.open(1);
    await s.answer(NODES(1), []);
    await answerAllHubs(s, 1);
    const before = s.shown.length;
    await s.open(1);
    check('the hub stays on screen while the outline reloads', s.text().includes('Hero of course 1'), s.text().slice(0, 160));
    await s.answer(NODES(1), []);
    check('…and after it arrives, still no spinner', s.text().includes('Hero of course 1') && !s.text().includes('Loading your study hub'), s.text().slice(0, 160));
    check('the hub is asked for again (a refresh, not skipped)', s.waiting(HUB(1)) >= 1);
    await answerAllHubs(s, 1);
    check('nothing new was drawn over it', s.shown.length === before, s.shown.slice(before).join(' → '));
    s.close();
}

section('a hub that fails to load still says so');
{
    const s = page();
    await s.open(1);
    await s.answer(NODES(1), []);
    // Every copy of the hub request fails.
    for (;;) {
        const i = s.waiting(HUB(1));
        if (!i) break;
        await s.answer(HUB(1), { error: "boom" }, 500);
    }
    check('with no hub to show, the empty state is what is left', s.text().includes('No Data Available'), s.text().slice(0, 160));
    s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
