#!/usr/bin/env node
/**
 * tools/ready-to-prove-gates.mjs — a late topic the learner already knows says
 * "ready to prove", not "Overdue", on every surface that says either.
 *
 * Run:  node tools/ready-to-prove-gates.mjs [--table]
 *
 * The rule (`isReadyToProve`, server/readyToProve.js, mirrored in
 * src/utils/tree.ts): an OPEN topic whose end date is before today AND that the
 * mastery gate would pass now — `checkMasteryEligibility` itself, never a copy
 * of its threshold. Only the WORDS change: the topic stays open, the overdue
 * counts and the urgency order stay what they were, and the check is offered
 * through the one `MasteryGateModal` path.
 *
 * The real library had "Doppler Effect for Sound and Light" at mastery 0.98
 * after seven answers, past its dates, and every surface called it OVERDUE.
 * Each surface reads it its own way, so each is asked here, on one scratch
 * library with one topic per case. `--table` prints what every surface says.
 *
 * Deterministic: a scratch database, an in-process server on loopback, no
 * model, no network beyond 127.0.0.1.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'ready-to-prove-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; return; }
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
    check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const db = (await import('../server/database.js')).default;

let appServer = null;
const bundleDir = mkdtempSync(join(tmpdir(), 'ready-to-prove-bundle-'));
process.on('exit', () => {
    try { appServer?.close(); } catch { /* already closed */ }
    try { db.close(); } catch { /* already closed */ }
    rmSync(scratch, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
});

// ---- the library: one topic per case ----------------------------------------

// Fixed dates, never the clock: every "past" date is before any day this gate
// runs on, and the one "not yet due" date is after it. Surfaces that read the
// clock themselves (the dashboard route, project_state) agree with the ANCHOR.
const ANCHOR = '2026-06-15';
const day = (offset) => new Date(Date.parse(`${ANCHOR}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const FUTURE = '2099-12-31';

const projectId = db.prepare(
    "INSERT INTO projects (name, position, start_date, deadline) VALUES ('Gate course', 0, ?, ?)",
).run(day(-30), FUTURE).lastInsertRowid;
const addNode = (parent, title, position, extra = {}) => db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, position, status, scheduled_start, scheduled_end)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(projectId, parent, title, position, extra.status || 'not_started',
    extra.start ?? day(-10), extra.end ?? day(-2)).lastInsertRowid;

// The section is past its dates and, on an older library, carries mastery and
// evidence on its OWN row: it still has no check, so it is never "ready".
const section = addNode(null, 'Past-due section', 0, { end: day(-1) });

// Ends are staggered so the most overdue is the ready one: it heads every
// overdue list, which is what makes "the ranking did not move" checkable.
const CASES = {
    ready: addNode(section, 'Known and late', 0, { end: day(-6) }),
    low: addNode(section, 'Late, low mastery', 1, { end: day(-5) }),
    seed: addNode(section, 'Late, seed only', 2, { end: day(-4) }),
    seedPlusOne: addNode(section, 'Late, seed plus one answer', 3, { end: day(-3) }),
    completed: addNode(section, 'Completed, known', 4, { status: 'completed', end: day(-7) }),
    notDue: addNode(section, 'Known, not yet due', 5, { end: FUTURE }),
    placementOnly: addNode(section, 'Late, placement answer only', 6, { end: day(-1) }),
};
const EXPECTED = { ready: 'ready', low: 'overdue', seed: 'overdue', seedPlusOne: 'overdue', completed: 'none', notDue: 'none', placementOnly: 'overdue' };
const OPEN_LATE = ['ready', 'low', 'seed', 'seedPlusOne', 'placementOnly'];

const mastery = db.prepare(`INSERT INTO node_mastery
    (node_id, mastery_score, total_attempts, correct_attempts, placement_prior) VALUES (?, ?, ?, ?, ?)`);
const evidence = db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total) VALUES (?, 'quiz', ?, 1)");
const answered = (id, score, n, right) => {
    mastery.run(id, score, n, right, null);
    for (let i = 0; i < n; i++) evidence.run(id, i < right ? 1 : 0);
};
// Seven answers, mastery 0.98 — node 11317 on the real library.
answered(CASES.ready, 0.98, 7, 7);
answered(CASES.completed, 0.98, 7, 7);
answered(CASES.notDue, 0.98, 7, 7);
answered(section, 0.98, 7, 7);
answered(CASES.low, 0.3, 3, 1);
// A placement seed is not a proof: no evidence at all…
mastery.run(CASES.seed, 0.6, 0, 0, 0.6);
// …and a seed topped up past the threshold by ONE answer is still borrowed.
mastery.run(CASES.seedPlusOne, 0.95, 1, 1, 0.6);
evidence.run(CASES.seedPlusOne, 1);
// A placement probe answer is written as evidence WITHOUT a mastery row
// (`recordPlacementEvidence`). The gate's reader would create that row, so a
// surface that asks it here writes on a GET.
db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total) VALUES (?, 'placement', 0, 1)")
    .run(CASES.placementOnly);

const said = new Map();
const record = (surface, key, value) => {
    if (!said.has(surface)) said.set(surface, {});
    said.get(surface)[key] = value;
};
const masteryRows = () => db.prepare('SELECT COUNT(*) AS c FROM node_mastery').get().c;
const rowsBefore = masteryRows();
const hasMasteryRow = (id) => !!db.prepare('SELECT 1 FROM node_mastery WHERE node_id = ?').get(id);

// ---- the server rule ----------------------------------------------------------

let rule = null;
try { rule = await import('../server/readyToProve.js'); } catch { /* HEAD has none */ }
check('server/readyToProve.js exports isReadyToProve', typeof rule?.isReadyToProve === 'function');
const nodeRow = db.prepare('SELECT id, status, scheduled_end FROM nodes WHERE id = ?');
for (const [key, id] of Object.entries(CASES)) {
    const ready = rule ? rule.isReadyToProve(nodeRow.get(id), ANCHOR) : false;
    record('Server rule', key, ready ? 'ready' : '—');
    eq(`server rule: ${key}`, ready, EXPECTED[key] === 'ready');
}
if (rule) {
    eq('server rule: a section is never ready', rule.isReadyToProve(nodeRow.get(section), ANCHOR), false);
    // The rule is the gate's own: raise the bar and the same topic is not ready.
    eq('server rule follows the gate threshold', rule.isReadyToProve(nodeRow.get(CASES.ready), ANCHOR,
        { threshold: 0.99, checkPass: 1.01 }), false);
    eq('server rule on "today" = its end date (not yet late)',
        rule.isReadyToProve(nodeRow.get(CASES.ready), day(-6)), false);
}

// ---- the client: the real payload through the real tree helpers -------------

const esbuild = createRequire(import.meta.url)('esbuild');
const stub = join(bundleDir, 'i18n-stub.js');
writeFileSync(stub, 'export const k = (s) => s;\nexport default {};\n');
const bundle = async (rel) => {
    const out = join(bundleDir, rel.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '.mjs'));
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL(`../${rel}`, import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
        plugins: [{ name: 'stub-i18n', setup(b) { b.onResolve({ filter: /(^|\/)i18n$/ }, () => ({ path: stub })); } }],
    });
    return import(pathToFileURL(out).href);
};

const { createApp } = await import('../server/app.js');
appServer = createServer(createApp());
const port = await new Promise(ok => appServer.listen(0, '127.0.0.1', () => ok(appServer.address().port)));
const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    eq(`GET ${path}`, res.status, 200);
    return res.ok ? res.json() : null;
};
let payload = [];
let dashboard = null;
try {
    payload = (await get(`/api/projects/${projectId}/nodes`)) || [];
    dashboard = await get(`/api/projects/${projectId}/study-dashboard`);
} finally {
    appServer.close();
}
const rowOf = (id) => payload.find(n => n.id === id) || {};

const tree = await bundle('src/utils/tree.ts');
const clientRule = typeof tree.isReadyToProve === 'function' ? tree.isReadyToProve : null;
check('src/utils/tree.ts exports isReadyToProve', !!clientRule);
// What HEAD drew: open and past its end is "overdue", nothing else.
const lateOf = (n, today) => n.status !== 'completed' && n.status !== 'skipped' && !!n.scheduled_end && n.scheduled_end < today;
const say = (n, today, provable) => (clientRule?.({ ...n, provable }, today) ? 'ready' : lateOf(n, today) ? 'overdue' : 'none');
for (const [key, id] of Object.entries(CASES)) {
    const row = rowOf(id);
    const shown = say(row, ANCHOR, row.provable);
    record('Topic panel + sidebar (nodes payload)', key, shown);
    eq(`nodes payload → client: ${key}`, shown, EXPECTED[key]);
}
// `=== false`, not falsy: a payload with no `provable` at all is the pre-fix one.
eq('nodes payload: a section is not provable', rowOf(section).provable, false);
eq('nodes payload: a closed topic is not provable', rowOf(CASES.completed).provable, false);
eq('nodes payload: the known late topic is provable', rowOf(CASES.ready).provable, true);
// The client mirror on the day the end date IS today: not late yet, not ready.
if (clientRule) {
    const r = rowOf(CASES.ready);
    eq('client rule on "today" = its end date (not yet late)', clientRule({ ...r }, r.scheduled_end), false);
    eq('client rule: a closed topic is never ready', clientRule({ ...r, status: 'skipped' }, ANCHOR), false);
}

// The project timeline: the bar still counts the topic as late, and says why.
const roots = tree.buildTree(payload);
const items = tree.buildGanttData(roots);
for (const [key, id] of Object.entries(CASES)) {
    const item = items.find(i => i.id === id) || {};
    const shown = item.readyToProve ? 'ready' : item.isOverdue ? 'overdue' : 'none';
    record('Project timeline', key, shown);
    eq(`timeline: ${key}`, shown, EXPECTED[key]);
    if (OPEN_LATE.includes(key)) eq(`timeline still counts ${key} as behind`, item.isOverdue, true);
    if (key === 'ready') {
        check('timeline: a ready bar is not red', !/red/.test(item.colorClass || ''), item.colorClass);
        // …nor the on-time in-progress amber: it is still behind.
        eq('timeline: a ready bar is the accent', item.colorClass, 'bg-accent');
    }
}
const sectionItem = items.find(i => i.id === section) || {};
eq('timeline: a section is never ready', !!sectionItem.readyToProve, false);

// ---- the calendar -------------------------------------------------------------

const { buildCalendarRange, buildTodayData, buildTodayBriefingContext } = await import('../server/today.js');
const range = buildCalendarRange(day(-40), day(40));
for (const [key, id] of Object.entries(CASES)) {
    if (key === 'notDue') continue; // outside the range by design
    const task = range.tasks.find(t => t.nodeId === id);
    const shown = task ? say({ status: task.status, scheduled_end: task.scheduled_end }, ANCHOR, task.provable) : '(absent)';
    record('Calendar', key, shown);
    eq(`calendar: ${key}`, shown, EXPECTED[key]);
}
// The project calendar builds its chips from the nodes payload; the chip must
// keep the flag through `assignTasksToDays`.
const [y, m] = day(-6).split('-').map(Number);
const days = tree.assignTasksToDays(tree.buildCalendarScaffold(y, m - 1, [1, 2, 3, 4, 5, 6, 7]),
    tree.leafCalendarTasks(roots));
const chip = days.flatMap(d => d.tasks).find(t => t.nodeId === CASES.ready);
check('calendar chip keeps provable through assignTasksToDays', !!chip?.provable, JSON.stringify(chip));

// ---- what the home page and the briefing read --------------------------------

const today = buildTodayData({ today: ANCHOR }).projects.find(p => p.id === projectId);
for (const key of OPEN_LATE) {
    const task = today?.overdueTasks.find(t => t.id === CASES[key]);
    const shown = !task ? '(absent)' : task.readyToProve ? 'ready' : 'overdue';
    record('Today (home, briefing)', key, shown);
    eq(`today: ${key}`, shown, EXPECTED[key]);
}
eq('today: the overdue COUNT still includes the ready topic', today?.counts.overdue, OPEN_LATE.length);
eq('today: the ready topic keeps its place in the overdue order', today?.overdueTasks[0]?.id, CASES.ready);

const briefing = buildTodayBriefingContext();
const briefed = (briefing.projects || []).find(p => p.projectId === projectId);
for (const key of OPEN_LATE.slice(0, 3)) {
    const task = briefed?.overdue.find(t => t.nodeId === CASES[key]);
    const shown = !task ? '(absent)' : task.readyToProve ? 'ready' : 'overdue';
    record('Daily briefing context', key, shown);
    eq(`briefing: ${key}`, shown, EXPECTED[key]);
}
eq('briefing: overdueCount unchanged', briefed?.overdueCount, OPEN_LATE.length);

// ---- the project dashboard ------------------------------------------------------

const { generateDailyPlan } = await import('../server/dailyPlan.js');
const plan = generateDailyPlan(projectId, 14, ANCHOR).overdueTasks;
for (const key of OPEN_LATE) {
    const task = plan.find(t => t.id === CASES[key]);
    const shown = !task ? '(absent)' : task.readyToProve ? 'ready' : 'overdue';
    record("Dashboard: Today's Plan", key, shown);
    eq(`daily plan: ${key}`, shown, EXPECTED[key]);
}
eq('daily plan: every late topic is still listed', plan.length, OPEN_LATE.length);

// The dashboard shows the three most overdue (`cappedOverdueTopics`).
for (const key of OPEN_LATE.slice(0, 3)) {
    const topic = dashboard?.overdueTopics?.find(t => t.id === CASES[key]);
    const shown = !topic ? '(absent)' : topic.readyToProve ? 'ready' : 'overdue';
    record('Dashboard: Next up', key, shown);
    eq(`study dashboard: ${key}`, shown, EXPECTED[key]);
}
eq('study dashboard: the hero is still the most overdue topic', dashboard?.heroTask?.id, CASES.ready);
eq('study dashboard: …and it says it is ready to prove', !!dashboard?.heroTask?.readyToProve, true);

// ---- the assistant --------------------------------------------------------------

const { projectStateText } = await import('../server/projectState.js');
const state = projectStateText(projectId) || '';
for (const key of [...OPEN_LATE, 'notDue']) {
    const line = state.split('\n').find(l => l.startsWith(`- ${CASES[key]} · `)) || '';
    const shown = !line ? '(absent)' : /READY TO PROVE/.test(line) ? 'ready' : /OVERDUE/.test(line) ? 'overdue' : 'none';
    record('Assistant: project_state', key, shown);
    eq(`project_state: ${key}`, shown, EXPECTED[key]);
}

// No read above may have written: eligibility creates a mastery row when it
// finds none, and a GET that writes is a GET that can fail on a locked library.
// The placement-only topic is the case that can: evidence, and no row.
eq('no surface wrote a node_mastery row', masteryRows(), rowsBefore);
eq('no surface wrote a mastery row for a placement-only topic', hasMasteryRow(CASES.placementOnly), false);

// ---- source: the components draw the shared rule and open the one check -----

{
    const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
    // Raw: ai.js holds prompt text with "/*" in it, which the comment strip eats.
    const ai = readFileSync(new URL('../server/ai.js', import.meta.url), 'utf8');
    const ruleUses = (ai.match(/\$\{READY_TO_PROVE_RULE\}/g) || []).length;
    check('ai.js: the briefing, the insights and the assistant prompts carry READY_TO_PROVE_RULE', ruleUses >= 3, `${ruleUses} uses`);
    check('insights context marks readyToProve', /isReadyToProve\(/.test(src('server/routes/insights.js')));

    const panel = src('src/components/DetailPanel.tsx');
    check('topic panel: isReadyToProve decides the chip', /isReadyToProve\(/.test(panel) && /t\("Ready to prove"\)/.test(panel));
    check('topic panel: offers the mastery check', /openMasteryCheck\(node\.id/.test(panel));
    check('topic panel: no "Overdue" chip over a ready topic', /showOverdue = isOverdue && !readyToProve/.test(panel));

    const side = src('src/components/Sidebar.tsx');
    check('sidebar: isReadyToProve decides the icon', /isReadyToProve\(/.test(side) && /showOverdue = isOverdue && !readyToProve/.test(side));

    const dash = src('src/components/StudyDashboard.tsx');
    check('dashboard: Next up says ready to prove', /tr\("Ready to prove — it was due \{\{when\}\}\."/.test(dash));
    check('dashboard: Next up and the plan row offer the check', (dash.match(/openMasteryCheck\(/g) || []).length >= 2);
    check('dashboard: the plan lists ready topics apart', /t\.readyToProve/.test(dash) && /tr\("Ready to prove \(\{\{length\}\}\)"/.test(dash));

    const cal = src('src/components/calendar/CalendarView.tsx');
    check('calendar: isReadyToProve decides the chip', /isReadyToProve\(/.test(cal) && /provable: t\.provable/.test(cal));
    check('calendar: the red body and ring are for late-and-not-known only',
        /const isLate = [\s\S]{0,200}&& !isReady\(task\)/.test(cal)
        && /if \(isLate\(task\)\) return `\$\{base\} bg-red-50/.test(cal) && /isLate\(t\) \? 'ring-2 ring-red-500'/.test(cal));
    // A month chip has no room for the words: its colour and a shield say it.
    check('calendar: a ready chip has its own accent body and a shield in a month cell',
        /if \(isReady\(task\)\) return `\$\{base\} bg-accent\/10/.test(cal) && /ready && <ShieldCheck/.test(cal));

    const tl = src('src/components/schedule/ProjectTimeline.tsx');
    check('timeline: a ready row is not red and says so', /row\.isOverdue && !row\.readyToProve/.test(tl) && /t\("Ready to prove"\)/.test(tl));

    const cp = src('src/components/feed/CheckpointCard.tsx');
    check('checkpoint: a ready topic is not "behind schedule"', /isReadyToProve\(/.test(cp) && /t\("Ready to prove ·"\)/.test(cp));

    // ONE way into the check: the hook calls the store's openMasteryGate, and
    // the assistant's button goes through it too.
    let hook = '';
    try { hook = src('src/hooks/useOpenMasteryCheck.ts'); } catch { /* HEAD has none */ }
    check('useOpenMasteryCheck opens MasteryGateModal through openMasteryGate', /openMasteryGate\(/.test(hook));
    check("the assistant's check button uses the same hook", /useOpenMasteryCheck\(/.test(src('src/components/AssistantProposals.tsx')));
}

// ---- the table ------------------------------------------------------------------

if (process.argv.includes('--table')) {
    const cols = Object.keys(CASES);
    const head = ['Surface', 'Known, late (0.98)', 'Late, low', 'Late, seed', 'Seed + 1 answer', 'Completed', 'Not yet due', 'Placement answer only'];
    console.log(`\n| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`);
    for (const [surface, row] of said) console.log(`| ${surface} | ${cols.map(c => row[c] ?? '—').join(' | ')} |`);
}

const total = pass + failures.length;
if (failures.length) {
    console.log(`\n  ${failures.length} of ${total} assertions FAILED ("ready to prove"):\n`);
    for (const f of failures) console.log(`   ✗ ${f}`);
    process.exit(1);
}
console.log(`\n  ✓ ${pass} assertions passed ("ready to prove"; no model, no network).\n`);
