// tools/dashboard-load-gates.mjs — opening a course shows its study hub once.
//
// Run:  node tools/dashboard-load-gates.mjs                (the working tree)
//       node tools/dashboard-load-gates.mjs --base <rev>   (the store and StudyDashboard as
//                                                          they are at <rev>, e.g. 1e779be, the
//                                                          last commit before this fix, to
//                                                          watch the cases fail)
//
// WHY. Opening a course drew "No Data Available" for one frame, then "Loading your study
// hub…", then the hub, then the spinner AGAIN, then the hub (filmed 1 Nov 2026). Causes:
//   - StudyDashboard's first render came before its effect asked for the dashboard, and
//     nothing said a load was coming, so it took the empty state for "no data";
//   - the dashboard loads on two paths at once (the component's effect, and loadProjectData
//     once the outline arrives), and the outline's path threw away the hub that had just
//     arrived (`dashboardData: null`) before loading it again, so the full-page spinner came
//     back over a page the learner was already reading;
//   - with two loads out, the first to FAIL cleared the loading mark while the other was
//     still on its way, and the OLDER answer could land last and be drawn over the newer.
// The rules: another course's hub goes when the course CHANGES; the outline arriving for
// the same course refreshes the hub in the background; the hub is "loading" while any
// request for it is out, and an answer older than the one on screen is not drawn; a mount
// shows the spinner until its own request has answered.
//
// The REAL store and StudyDashboard are bundled into jsdom (StudyDashboard alone, not the
// Workspace around it); `fetch` answers only when the gate says so, so the order of the
// answers is chosen. What the page shows is read at every React COMMIT (a Profiler's
// onRender runs inside the commit), so a state that was on screen for one commit is seen.
// A MutationObserver missed the one-frame "No Data Available": React reuses the same div,
// icon and <p> for the spinner and only swaps the text, and the observer's callback runs
// after the swap.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : null;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const baseFiles = {
    name: 'base-files',
    setup(build) {
        if (!BASE) return;
        build.onLoad({ filter: /[\\/]src[\\/](store\.ts|components[\\/]StudyDashboard\.tsx)$/ }, (args) => {
            const rel = args.path.slice(root.length + 1).replace(/\\/g, '/');
            return { contents: execFileSync('git', ['show', `${BASE}:${rel}`], { cwd: root, encoding: 'utf8' }), loader: rel.endsWith('x') ? 'tsx' : 'ts' };
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
    plugins: [baseFiles],
})).outputFiles[0].text;

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const projects = [1, 2].map(id => ({ id, name: `Course ${id}`, color: '#8B5CF6', icon: 'book', card_count: 0, teaches: true, topic_count: 4 }));
const hub = (id, edition = '') => ({
    todaySchedule: [], overdueTopics: [], milestones: [],
    heroTask: { id: 10 + id, title: `Hero of course ${id}${edition}`, status: 'not_started', scheduled_start: null, scheduled_end: null, parent_id: 2 },
    flashcardSummary: { totalCards: 0, dueCount: 0, newAvailable: 0, newPerDay: 0, introducedToday: 0, weakCount: 0, retention: null, decks: [] },
    quizSummary: { totalQuizzes: 0, averageScore: null, weakTopics: [], recentAttempts: [] },
    insights: null, pace: null,
    stats: { totalNodes: 4, completedNodes: 0, progressPercent: 0, daysUntilDeadline: null },
});
// A real outline: a category with two topics, so buildTree and the expansion pass run.
const outline = (id) => [
    { id: 100 * id + 1, project_id: id, parent_id: null, title: 'Basics', position: 0, is_note: 0, status: 'not_started' },
    { id: 100 * id + 2, project_id: id, parent_id: 100 * id + 1, title: 'Limits', position: 0, is_note: 0, status: 'not_started' },
    { id: 100 * id + 3, project_id: id, parent_id: 100 * id + 1, title: 'Derivatives', position: 1, is_note: 0, status: 'not_started' },
];

// What the page shows, in one word.
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
    w.fetch = (url) => new Promise((ok) => { pending.push({ url: String(url), ok }); });
    w.eval(bundle);
    const { useStore, mount, act } = w.__gate;
    const shown = [];
    const el = w.document.getElementById('root');
    const onCommit = () => {
        const k = kind(el.textContent ?? '');
        if (k && shown.at(-1) !== k) shown.push(k);
    };
    useStore.setState({ currentProjectId: null, projects, dashboardData: null, dashboardLoading: false, dailyPlan: null, _navigate: () => { } });
    // Answer the first (or, with last: true, the newest) pending request matching `pattern`.
    const answer = async (pattern, body, { status = 200, last = false } = {}) => {
        const hits = pending.map((p, i) => [p, i]).filter(([p]) => pattern.test(p.url));
        if (!hits.length) return false;
        const [p, i] = last ? hits.at(-1) : hits[0];
        pending.splice(i, 1);
        await act(async () => {
            p.ok(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
            await settle();
        });
        return true;
    };
    const waiting = (pattern) => pending.filter(p => pattern.test(p.url)).length;
    let r = null;
    return {
        useStore, act, shown, answer, waiting,
        open: async (id) => { await act(async () => { useStore.getState().loadProjectData(id); if (!r) r = mount(el, onCommit); await settle(); }); },
        mount: async () => { await act(async () => { r = mount(el, onCommit); await settle(); }); },
        text: () => w.document.body.textContent,
        close: () => { if (r) act(() => r.unmount()); w.close(); },
    };
}
const NODES = (id) => new RegExp(`/projects/${id}/nodes$`);
const HUB = (id) => new RegExp(`/projects/${id}/study-dashboard$`);
const answerAllHubs = async (s, id) => { while (await s.answer(HUB(id), hub(id))) { /* every copy asked for */ } };
// Quiet the store's own console.error for the failures a case causes on purpose.
const quiet = async (fn) => { const e = console.error; console.error = () => { }; try { return await fn(); } finally { console.error = e; } };

// ---------------------------------------------------------------------------
section('opening a course: the hub answers first, then the outline (the order filmed)');
{
    const s = page();
    await s.open(1);
    check('the hub was asked for before the outline answered', await s.answer(HUB(1), hub(1)));
    check('the outline was asked for', await s.answer(NODES(1), outline(1)));
    await answerAllHubs(s, 1);
    check('"No Data Available" never shows while the hub is on its way', !s.shown.includes('empty'), s.shown.join(' → '));
    check('the page goes spinner → hub, once', s.shown.join(' → ') === 'spinner → hub1', s.shown.join(' → '));
    s.close();
}

section('opening a course: the outline answers first, then the hub');
{
    const s = page();
    await s.open(1);
    check('the outline was asked for', await s.answer(NODES(1), outline(1)));
    check('…and the hub twice (the effect and the outline\'s refresh)', s.waiting(HUB(1)) === 2, String(s.waiting(HUB(1))));
    await answerAllHubs(s, 1);
    check('the page goes spinner → hub, once', s.shown.join(' → ') === 'spinner → hub1', s.shown.join(' → '));
    s.close();
}

section('moving to another course never shows the first course\'s hub under it');
{
    const s = page();
    await s.open(1);
    await s.answer(NODES(1), outline(1));
    await answerAllHubs(s, 1);
    const before = s.shown.length;
    await s.open(2);
    check('course 1\'s hub is gone the moment course 2 opens', !s.text().includes('Hero of course 1'), s.text().slice(0, 160));
    check('…and a load is shown instead of "No Data Available"', s.text().includes('Loading your study hub') && !s.text().includes('No Data Available'), s.text().slice(0, 160));
    check('course 2\'s hub was asked for', await s.answer(HUB(2), hub(2)));
    await s.answer(NODES(2), outline(2));
    await answerAllHubs(s, 2);
    check('course 2: spinner → hub, once', s.shown.slice(before).join(' → ') === 'spinner → hub2', s.shown.slice(before).join(' → '));
    s.close();
}
{
    // Course 1's hub is still on its way when the learner moves on.
    const s = page();
    await s.open(1);
    await s.open(2);
    check('course 1\'s late hub arrives after course 2 opened', await s.answer(HUB(1), hub(1)));
    check('…and is never drawn under course 2', !s.shown.includes('hub1') && s.text().includes('Loading your study hub'), `${s.shown.join(' → ')} | ${s.text().slice(0, 120)}`);
    await s.answer(NODES(2), outline(2));
    await answerAllHubs(s, 2);
    check('course 2 ends on its own hub', s.text().includes('Hero of course 2'));
    s.close();
}

section('the same course loaded again refreshes its hub in the background');
{
    const s = page();
    await s.open(1);
    await s.answer(NODES(1), outline(1));
    await answerAllHubs(s, 1);
    const before = s.shown.length;
    await s.open(1);
    check('the hub stays on screen while the outline reloads', s.text().includes('Hero of course 1'), s.text().slice(0, 160));
    check('the outline was asked for again', await s.answer(NODES(1), outline(1)));
    check('…and after it arrives, still no spinner', s.text().includes('Hero of course 1') && !s.text().includes('Loading your study hub'), s.text().slice(0, 160));
    check('the hub is asked for again (a refresh, not skipped)', s.waiting(HUB(1)) >= 1);
    await answerAllHubs(s, 1);
    check('nothing new was drawn over it', s.shown.length === before, s.shown.slice(before).join(' → '));
    s.close();
}

section('two requests out: one failing, or answering out of order, changes nothing on screen');
{
    // The effect's request fails; the outline's refresh is still on its way.
    const s = page();
    await s.open(1);
    await s.answer(NODES(1), outline(1));
    check('the first hub request fails', await quiet(() => s.answer(HUB(1), { error: 'boom' }, { status: 500 })));
    check('…and the page still says loading, not "No Data Available"', !s.shown.includes('empty'), s.shown.join(' → '));
    await answerAllHubs(s, 1);
    check('the second request draws the hub: spinner → hub', s.shown.join(' → ') === 'spinner → hub1', s.shown.join(' → '));
    s.close();
}
{
    // The newer request (the outline's refresh) answers first; the older one lands after.
    const s = page();
    await s.open(1);
    await s.answer(NODES(1), outline(1));
    check('the newer request answers first', await s.answer(HUB(1), hub(1, ' (new)'), { last: true }));
    check('the older one lands after it', await s.answer(HUB(1), hub(1, ' (old)')));
    check('the newer hub stays on screen', s.text().includes('Hero of course 1 (new)'), s.text().slice(0, 160));
    s.close();
}

section('a mount that finds no hub and no load under way waits for its own request');
{
    // As after a failed load: no hub, nothing loading. Switching back to the Dashboard tab
    // mounts StudyDashboard on that store.
    const s = page();
    s.useStore.setState({ currentProjectId: 1, dashboardData: null, dashboardLoading: false });
    await s.mount();
    check('its first commit is the spinner, not "No Data Available"', s.shown[0] === 'spinner', s.shown.join(' → '));
    await answerAllHubs(s, 1);
    check('…then the hub', s.shown.join(' → ') === 'spinner → hub1', s.shown.join(' → '));
    s.close();
}

section('a hub that cannot load still says so (passes on the pre-fix code too: it pins that the fix kept it)');
{
    const s = page();
    await s.open(1);
    await s.answer(NODES(1), outline(1));
    await quiet(async () => { while (await s.answer(HUB(1), { error: 'boom' }, { status: 500 })) { /* every copy fails */ } });
    check('with every request failed, the empty state is what is left', s.text().includes('No Data Available'), s.text().slice(0, 160));
    s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
