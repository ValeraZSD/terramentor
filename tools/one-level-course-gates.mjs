#!/usr/bin/env node
/**
 * tools/one-level-course-gates.mjs — a course with no phases is not drawn as
 * one with phases.
 *
 * Run:  node tools/one-level-course-gates.mjs
 *
 * A short course is one level of topics (server/shortCourses.js). The study
 * dashboard built its Phase progress from the course's top rows, so each topic
 * became a "phase" reading "0 of 1 topic finished", and the sidebar gave each
 * the course badge and tint a phase wears. Four topics looked like four empty
 * phases.
 *
 * Two places decide it and must agree: `oneLevel` in
 * server/routes/studyDashboard.js (no Phase progress rows) and
 * `isOneLevelCourse` in src/utils/tree.ts (the sidebar). Each course below is
 * named one level or not by its SHAPE as written here, never by either rule.
 *
 * Deterministic: a scratch database, no model, no network.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleTs } from './lib/bundleTs.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'one-level-course-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const treeTs = await bundleTs('src/utils/tree.ts', scratch, {
    what: 'one-level course rule', platform: 'node', needs: ['buildTree', 'isOneLevelCourse'],
});
if (!treeTs) process.exit(0);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (label, actual, expected) =>
    check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const src = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const db = (await import('../server/database.js')).default;
const { routes } = await import('../server/routes/studyDashboard.js');
const dashboardGet = routes.calls.find(c => c.method === 'get' && c.args[0] === '/api/projects/:projectId/study-dashboard');
const dashboard = (id) => {
    let body = null;
    const res = { status() { return this; }, json(b) { body = b; return this; } };
    dashboardGet.args.at(-1)({ params: { projectId: String(id) }, headers: {}, get: () => undefined }, res);
    return body;
};

const addProject = (name, { madeFrom = null, generating = 0, finished = null } = {}) => Number(db.prepare(
    'INSERT INTO projects (name, kind, position, made_from, ai_generating, creation_finished) VALUES (?, ?, 0, ?, ?, ?)',
).run(name, 'curriculum', madeFrom, generating, finished).lastInsertRowid);
const addNode = (projectId, parentId, title, position, isNote = 0) => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, is_note) VALUES (?, ?, ?, ?, ?)',
).run(projectId, parentId, title, position, isNote).lastInsertRowid);

const SHORT_FROM = JSON.stringify({ kind: 'topic' });

/** Both sides' answer for one course: server rows, and the client rule over the same rows. */
function read(id) {
    const project = db.prepare('SELECT id, ai_generating, creation_finished, made_from FROM projects WHERE id = ?').get(id);
    // The rows a client is sent: live ones, as the server reads.
    const rows = db.prepare('SELECT * FROM live_nodes WHERE project_id = ? ORDER BY position').all(id);
    return {
        rows: dashboard(id)?.milestones?.length ?? null,
        oneLevel: treeTs.isOneLevelCourse(treeTs.buildTree(rows), project),
    };
}

// ---- a short course: four topics on one level --------------------------------

const short = addProject('Standing Waves', { madeFrom: SHORT_FROM });
const shortTopics = ['Superposition', 'Harmonics on a string', 'Air columns', 'Exam problems']
    .map((t, i) => addNode(short, null, t, i));
// Material under a topic does not make it a phase: a note is not a topic.
addNode(short, shortTopics[0], 'Reading', 0, 1);
let r = read(short);
eq('a short course shows no Phase progress', r.rows, 0);
eq('…and the sidebar draws its top rows as topics', r.oneLevel, true);

// ---- a course made by hand with every topic at the top ------------------------

const flat = addProject('Three topics');
['A', 'B', 'C'].forEach((t, i) => addNode(flat, null, t, i));
r = read(flat);
eq('a hand-made course with only top-level topics shows no Phase progress', r.rows, 0);
eq('…and its rows are topics in the sidebar', r.oneLevel, true);

// ---- a short course still being written ----------------------------------------

const writing = addProject('Being written short', { madeFrom: SHORT_FROM, generating: 1 });
['X', 'Y', 'Z'].forEach((t, i) => addNode(writing, null, t, i));
r = read(writing);
eq('a short course being written is one level too', r.rows, 0);
eq('…on both sides', r.oneLevel, true);

// ---- a course in phases ----------------------------------------------------------

const phased = addProject('Waves and light');
const p1 = addNode(phased, null, 'Phase 1', 0);
addNode(phased, null, 'Phase 2', 1);
const section = addNode(phased, p1, 'Section', 0);
addNode(phased, section, 'Topic', 0);
r = read(phased);
eq('a course in phases lists each phase', r.rows, 2);
eq('…and the sidebar draws them as phases', r.oneLevel, false);

// ---- a course being written in phases: its phases start out empty ---------------

const building = addProject('Being written in phases', { generating: 1 });
['Phase 1', 'Phase 2', 'Phase 3'].forEach((t, i) => addNode(building, null, t, i));
r = read(building);
eq('empty phases of a course being written still show as phases', r.rows, 3);
eq('…on both sides', r.oneLevel, false);

// ---- a run in phases that stopped before its sections ----------------------------
// A cancel, a failure or a restart (which clears `ai_generating`) leaves empty
// phases that "Continue creating" offers to finish: still phases.

const stopped = addProject('Stopped in phases', { finished: 0 });
['Phase 1', 'Phase 2'].forEach((t, i) => addNode(stopped, null, t, i));
r = read(stopped);
eq('empty phases of a stopped creation still show as phases', r.rows, 2);
eq('…on both sides', r.oneLevel, false);

// ---- a note at the top, and a deleted row under a topic ------------------------------

const noted = addProject('Topics and a note');
const notedTopic = addNode(noted, null, 'Topic', 0);
addNode(noted, null, 'Course notes', 1, 1);
const gone = addNode(noted, notedTopic, 'Deleted subtopic', 0);
db.prepare("UPDATE nodes SET deleted_at = '2026-11-24T00:00:00.000Z' WHERE id = ?").run(gone);
r = read(noted);
eq('a note at the top and a deleted row do not make a phase', r.rows, 0);
eq('…on both sides', r.oneLevel, true);

// ---- a short course that grows a phase ----------------------------------------------

addNode(short, shortTopics[1], 'Fixed ends', 0);
r = read(short);
eq('a short course whose topic gains a topic under it shows its phases', r.rows, 4);
eq('…and the sidebar draws them as phases again', r.oneLevel, false);

// ---- an empty course -----------------------------------------------------------------

const empty = addProject('Nothing yet');
r = read(empty);
eq('an empty course has no Phase progress rows', r.rows, 0);
eq('…and is not called one level', r.oneLevel, false);

// ---- the sidebar uses the rule -----------------------------------------------------

const sidebar = src('src/components/Sidebar.tsx');
check('the sidebar asks the rule for the course it shows',
    /isOneLevelCourse\(tree, project\)/.test(sidebar));
check('…and a top row of a one-level course is not drawn as a phase',
    /const isRoot = shownDepth === 0 && !oneLevel;/.test(sidebar));

// ---- report -------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
process.exit(fail ? 1 : 0);
