#!/usr/bin/env node
/**
 * tools/topic-status-gates.mjs — one status for a topic, on every surface.
 *
 * Run:  node tools/topic-status-gates.mjs [--table]
 *
 * A topic is `completed` only when somebody says so, but "Not started" is a
 * claim about the past, and it is false over the learner's own work. The rule
 * (`getEffectiveStatus`, src/utils/tree.ts, and `LEAF_STATUS`, server/today.js):
 *
 *   stored not_started + cards met         → in_progress  (the deck precedent)
 *   stored not_started + its own answers   → in_progress
 *   stored not_started + a seeded prior    → not_started  (placement/transfer
 *                                                         is not work done)
 *   anything else                          → what is stored
 *
 * and a section reads in_progress once anything under it is under way.
 *
 * The real library had a topic at mastery 0.98 after seven answers that the
 * tree, the calendar and the assistant all called "not_started" and overdue.
 * Each of those reads the status its own way, so each is asked here, on one
 * scratch library with one topic per case. `--table` prints what every surface
 * says, which is the before/after table in the PR.
 *
 * Deterministic: a scratch database, an in-process server on loopback for the
 * real nodes payload, no model, no network beyond 127.0.0.1.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'topic-status-gates-'));
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
const bundleDir = mkdtempSync(join(tmpdir(), 'topic-status-bundle-'));
// Whatever throws below, the server stops and the scratch folders go.
process.on('exit', () => {
    try { appServer?.close(); } catch { /* already closed */ }
    try { db.close(); } catch { /* already closed */ }
    rmSync(scratch, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
});

// ---- the library: one topic per case ----------------------------------------

// A fixed date, not the clock: every scheduled date below is in the past of
// any day this gate runs on, which is all "overdue" needs.
const ANCHOR = '2026-06-15';
const day = (offset) => new Date(Date.parse(`${ANCHOR}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

const projectId = db.prepare(
    "INSERT INTO projects (name, position, start_date, deadline) VALUES ('Gate course', 0, ?, ?)",
).run(day(-30), day(30)).lastInsertRowid;
const addNode = (parent, title, position, extra = {}) => db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, position, status, scheduled_start, scheduled_end)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(projectId, parent, title, position, extra.status || 'not_started',
    extra.start ?? day(-10), extra.end ?? day(-2)).lastInsertRowid;

// Four sections, so the rollup is asked too: one with nothing under way, one
// whose only topic has answers and nothing closed, one with cards met, and one
// holding the edges of the rule.
const quiet = addNode(null, 'Quiet section', 0);
const answeredSection = addNode(null, 'Answered section', 1);
const mixed = addNode(null, 'Mixed section', 2);
const edges = addNode(null, 'Edge section', 3);

const CASES = {
    none: addNode(quiet, 'No evidence', 0),
    seed: addNode(quiet, 'Seed only', 1),
    answers: addNode(answeredSection, 'Own answers', 0),
    cards: addNode(mixed, 'Cards met', 0),
    completed: addNode(mixed, 'Completed', 1, { status: 'completed' }),
    // The edges: a count with no review date is not a card met; a skipped or
    // already-in-progress topic keeps what is stored; every card met is still
    // not a proof, so it is never promoted to completed.
    countNoDate: addNode(quiet, 'Count without a review date', 2),
    skippedAnswers: addNode(edges, 'Skipped with answers', 0, { status: 'skipped' }),
    storedInProgress: addNode(edges, 'Stored in progress', 1, { status: 'in_progress' }),
    allCards: addNode(edges, 'Every card met', 2),
};
const SECTIONS = { quiet, answeredSection, mixed, edges };

// Own answers: seven of them, mastery 0.98 — node 11317 on the real library.
const mastery = db.prepare('INSERT INTO node_mastery (node_id, mastery_score, total_attempts, correct_attempts) VALUES (?, 0.98, 7, 7)');
mastery.run(CASES.answers);
mastery.run(CASES.skippedAnswers);
// A placement seed: a prior, and no answer of the learner's own.
db.prepare('INSERT INTO node_mastery (node_id, mastery_score, total_attempts, correct_attempts, placement_prior) VALUES (?, 0.6, 0, 0, 0.6)')
    .run(CASES.seed);
// One card met, one not.
const card = db.prepare('INSERT INTO flashcards (node_id, front, back, review_count, last_reviewed) VALUES (?, ?, ?, ?, ?)');
const reviewedAt = `${day(-5)}T10:00:00.000Z`;
card.run(CASES.cards, 'q1', 'a1', 1, reviewedAt);
card.run(CASES.cards, 'q2', 'a2', 0, null);
card.run(CASES.countNoDate, 'q3', 'a3', 2, null);
card.run(CASES.allCards, 'q4', 'a4', 3, reviewedAt);
card.run(CASES.allCards, 'q5', 'a5', 1, reviewedAt);

const EXPECTED = {
    none: 'not_started', seed: 'not_started', answers: 'in_progress', cards: 'in_progress', completed: 'completed',
    countNoDate: 'not_started', skippedAnswers: 'skipped', storedInProgress: 'in_progress', allCards: 'in_progress',
};
const CLOSED = new Set(['completed', 'skipped']);
const EXPECTED_SECTIONS = { quiet: 'not_started', answeredSection: 'in_progress', mixed: 'in_progress', edges: 'in_progress' };

/** surface → case → what it says, for the table. */
const said = new Map();
const record = (surface, key, value) => {
    if (!said.has(surface)) said.set(surface, {});
    said.get(surface)[key] = value;
};

// ---- the client: the real payload through the real buildTree ------------------

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
let payload = [];
try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/nodes`);
    eq('the nodes payload is served', res.status, 200);
    if (res.ok) payload = await res.json();
} finally {
    appServer.close();
}
const rowOf = (id) => {
    const row = payload.find(n => n.id === id);
    check(`the payload holds node ${id}`, !!row);
    return row || {};
};

const tree = await bundle('src/utils/tree.ts');
const roots = tree.buildTree(payload);
for (const [key, id] of Object.entries(CASES)) {
    const node = tree.findNode(roots, id);
    record('Topic tree (client)', key, node?.effectiveStatus);
    eq(`tree: ${key}`, node?.effectiveStatus, EXPECTED[key]);
}
for (const [key, id] of Object.entries(SECTIONS)) {
    const node = tree.findNode(roots, id);
    record('Topic tree (client)', key, node?.effectiveStatus);
    eq(`tree: section ${key}`, node?.effectiveStatus, EXPECTED_SECTIONS[key]);
}
const answersRow = rowOf(CASES.answers);
check('the payload carries the answers a topic has', Number(answersRow.attempts) === 7, `got ${JSON.stringify(answersRow.attempts)}`);
const seedRow = rowOf(CASES.seed);
check('…and a seed is not an answer', 'attempts' in seedRow && Number(seedRow.attempts) === 0, `got ${JSON.stringify(seedRow.attempts)}`);

// What the topic's own Status buttons show pressed. `leafStatus` on the payload
// row is what the panel computes; the tree above went through the rollup, so the
// two agree only if the leaf rule is the one the rollup starts from.
if (typeof tree.leafStatus === 'function') {
    for (const [key, id] of Object.entries(CASES)) {
        const shown = tree.leafStatus(rowOf(id));
        record('Topic panel Status buttons', key, shown);
        eq(`panel: ${key}`, shown, EXPECTED[key]);
    }
} else {
    check('tree.ts exports leafStatus, the one leaf rule the panel reads', false);
    for (const [key, id] of Object.entries(CASES)) record('Topic panel Status buttons', key, rowOf(id).status);
}

// The components that draw a status do it in code of their own, so each is held
// to calling the shared rule — and to not keeping the old inline one beside it.
{
    const { readFileSync } = await import('node:fs');
    const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const row = src('src/components/TreeItemRow.tsx');
    check('the Categories row draws leafStatus, not the stored status', /switch \(leafStatus\(node\)\)/.test(row) && !/switch \(node\.status\)/.test(row));
    check('…and cycles on from what it shows', /nextStatus\[leafStatus\(node\)\]/.test(row) && !/nextStatus\[node\.status\]/.test(row));
    check('the navigation row draws the effective status', /switch \(effectiveNodeStatus\)/.test(src('src/components/Sidebar.tsx')));
    const panel = src('src/components/DetailPanel.tsx');
    check('the panel presses the button leafStatus names', /shownStatus = leafStatus\(/.test(panel) && /aria-pressed=\{shownStatus === value\}/.test(panel));
    check('…and "Not started" cannot be pressed over the learner\'s own work',
        /disabled=\{value === 'not_started' && hasOwnWork\}/.test(panel) && /hasOwnWork = \(node\?\.seen \?\? 0\) > 0 \|\| \(node\?\.attempts \?\? 0\) > 0/.test(panel));
    for (const file of ['RegionList', 'AtlasMap', 'GlobeMap']) {
        const text = src(`src/components/atlas/${file}.tsx`);
        check(`${file} colours a topic by topicDotStatus`, /topicDotStatus\(/.test(text) && !/topic\.attempts > 0 \|\| topic\.status === 'in_progress'/.test(text));
    }
}

// ---- the atlas: the region list's dot and the topic card ---------------------

// The atlas payload carries its own `attempts` (server/atlas.js, read off
// node_mastery), so the topic is built from the database, not the tree payload.
const atlas = await bundle('src/components/atlas/topicStatus.ts');
const masteryOf = db.prepare('SELECT mastery_score, total_attempts FROM node_mastery WHERE node_id = ?');
for (const [key, id] of Object.entries(CASES)) {
    const row = rowOf(id);
    const m = masteryOf.get(id);
    const topic = {
        status: row.status, attempts: Number(m?.total_attempts) || 0, mastery: Number(m?.mastery_score) || 0,
        ...(row.cards > 0 ? { cards: row.cards, seen: row.seen } : {}),
    };
    if (typeof atlas.topicDotStatus === 'function') {
        const dot = atlas.topicDotStatus(topic);
        record('Atlas region list dot', key, dot);
        eq(`atlas dot: ${key}`, dot, EXPECTED[key]);
    } else {
        // HEAD's inline rule in RegionList.tsx, so the table shows what it drew.
        record('Atlas region list dot', key, topic.status === 'not_started' && (topic.seen ?? 0) > 0 ? 'in_progress' : topic.status);
    }
    const lines = atlas.topicStatusLines(topic, String).map(l => l.key);
    record('Atlas topic card', key, lines.join(' / '));
    check(`atlas card: ${key} never "Not started" over evidence`,
        EXPECTED[key] === 'not_started' || !lines.includes('Not started'), lines.join(' / '));
}
check('topicStatus.ts exports topicDotStatus, which the list and both maps draw', typeof atlas.topicDotStatus === 'function');

// ---- the server: the calendar, and what the assistant reads -------------------

const { buildCalendarRange } = await import('../server/today.js');
const range = buildCalendarRange(day(-40), day(40));
for (const [key, id] of Object.entries(CASES)) {
    const task = range.tasks.find(t => t.nodeId === id);
    record('Calendar (all projects)', key, task?.status);
    eq(`calendar: ${key}`, task?.status, EXPECTED[key]);
}

const { projectStateText } = await import('../server/projectState.js');
const state = projectStateText(projectId) || '';
for (const [key, id] of Object.entries(CASES)) {
    if (CLOSED.has(EXPECTED[key])) continue; // closed topics are listed elsewhere, without a status
    const line = state.split('\n').find(l => l.startsWith(`- ${id} · `)) || '';
    const status = line.split(' · ')[2];
    record('Assistant: project_state', key, line ? `${status}${line.includes('OVERDUE') ? ' OVERDUE' : ''}` : '(not listed)');
    eq(`project_state: ${key}`, status, EXPECTED[key]);
}
record('Assistant: project_state', 'completed', '(closed list)');

const { readTopic } = await import('../server/libraryReads.js');
for (const [key, id] of Object.entries(CASES)) {
    const header = readTopic(String(id)).context?.split('\n')[0] || '';
    const status = header.match(/— status (\w+)/)?.[1];
    record('Assistant: read_topic', key, status);
    eq(`read_topic: ${key}`, status, EXPECTED[key]);
}
const sectionRead = readTopic(String(quiet)).context || '';
for (const key of ['none', 'seed']) {
    const line = sectionRead.split('\n').find(l => l.startsWith(`- ${CASES[key]} · `)) || '';
    eq(`read_topic on a section lists ${key} as`, line.split(' · ')[2], EXPECTED[key]);
}
const answeredRead = readTopic(String(answeredSection)).context || '';
eq('read_topic on a section lists its answered topic as',
    (answeredRead.split('\n').find(l => l.startsWith(`- ${CASES.answers} · `)) || '').split(' · ')[2], 'in_progress');

const { buildNodeContext } = await import('../server/ai.js');
for (const [key, id] of Object.entries(CASES)) {
    const ctx = buildNodeContext(id, { curriculumPosition: true, profile: false });
    const status = ctx.match(/Status of this topic: (\w+)/)?.[1];
    record('Assistant: open-topic context', key, status);
    eq(`topic context: ${key}`, status, EXPECTED[key]);
}

// The assistant's page context opens with a header line of its own above
// buildNodeContext's, and the two must not disagree inside one prompt.
const { buildPageContext } = await import('../server/pageContext.js');
for (const [key, id] of Object.entries(CASES)) {
    const text = buildPageContext({ nodeId: id }).text || '';
    const status = text.match(/^Open topic: .* — status (\w+)\.$/m)?.[1];
    record('Assistant: open-topic header', key, status);
    eq(`open-topic header: ${key}`, status, EXPECTED[key]);
}

// find_in_library prints each topic hit with the status search hands it, and
// the search box's quick suggestions carry the same field.
const { searchAll, quickSuggest } = await import('../server/search.js');
const titleOf = db.prepare('SELECT title FROM nodes WHERE id = ?');
for (const [key, id] of Object.entries(CASES)) {
    const title = titleOf.get(id).title;
    const hit = searchAll(title, { limit: 20 }).nodes.find(n => n.nodeId === id);
    record('Assistant: find_in_library', key, hit?.status);
    eq(`search: ${key}`, hit?.status, EXPECTED[key]);
    const quick = quickSuggest(title, projectId, 20).find(n => n.nodeId === id);
    eq(`quick suggest: ${key}`, quick?.status, EXPECTED[key]);
}

// Today's overdue lists: the cross-project one behind the home page and the
// briefing, and the project dashboard's plan.
const caseOf = new Map(Object.entries(CASES).map(([key, id]) => [id, key]));
const { buildTodayData } = await import('../server/today.js');
const todayTasks = buildTodayData().projects.find(p => p.id === projectId)?.overdueTasks || [];
check('Today lists overdue topics of the gate course', todayTasks.length > 0);
for (const t of todayTasks) eq(`Today overdue: ${caseOf.get(t.id)}`, t.status, EXPECTED[caseOf.get(t.id)]);
const { generateDailyPlan } = await import('../server/dailyPlan.js');
const planTasks = generateDailyPlan(projectId).overdueTasks;
for (const [key, id] of Object.entries(CASES)) {
    if (CLOSED.has(EXPECTED[key])) continue;
    const task = planTasks.find(t => t.id === id);
    record('Project dashboard plan', key, task?.status);
    eq(`daily plan overdue: ${key}`, task?.status, EXPECTED[key]);
}

// ---- the table ---------------------------------------------------------------

if (process.argv.includes('--table')) {
    const cols = ['none', 'seed', 'answers', 'cards', 'completed'];
    const head = ['Surface', 'No evidence', 'Seed only', 'Own answers (7, 0.98)', 'Cards met', 'Completed'];
    console.log(`\n| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`);
    for (const [surface, row] of said) console.log(`| ${surface} | ${cols.map(c => row[c] ?? '—').join(' | ')} |`);
    const t = said.get('Topic tree (client)');
    console.log(`\nSections (tree): quiet ${t.quiet}, answered-only ${t.answeredSection}, mixed ${t.mixed}, edges ${t.edges}`);
    const extra = ['countNoDate', 'skippedAnswers', 'storedInProgress', 'allCards'];
    console.log(`\n| Surface | ${extra.join(' | ')} |\n|---|${extra.map(() => '---').join('|')}|`);
    for (const [surface, row] of said) console.log(`| ${surface} | ${extra.map(c => row[c] ?? '—').join(' | ')} |`);
}

const total = pass + failures.length;
if (failures.length) {
    console.log(`\n  ${failures.length} of ${total} status assertions FAILED:\n`);
    for (const f of failures) console.log(`   ✗ ${f}`);
    process.exit(1);
}
console.log(`\n  ✓ ${pass} status assertions passed (no model, no network).\n`);
