#!/usr/bin/env node
/**
 * tools/progress-scope-gates.mjs — one project's progress reads one project.
 *
 * Run:  node tools/progress-scope-gates.mjs
 *
 * `projectProgress(id)` is called once per project by the pace, the feed's
 * header and focus list, the schedule overview and the study dashboard. It
 * used to be `SELECT * FROM (<every work leaf, grouped>) WHERE projectId = ?`,
 * and SQLite does not push a filter into an aggregate subquery: each call
 * grouped every leaf in the library and kept one project's rows. On a library
 * of 5,000 topics and 22,000 cards that was 357 ms for 26 projects, against
 * 22 ms with the filter inside the grouping, and it ran on every feed, every
 * Projects grid and every schedule view.
 *
 * Two things pinned here:
 *   1. the answer did not change: every project's progress through the
 *      single-project path equals the whole-library pass the grid uses, for
 *      a course, a deck, a project of card-order slices only and an empty one;
 *   2. SQLite runs the single-project query through the project index, not a
 *      scan of every node (EXPLAIN QUERY PLAN).
 *
 * Deterministic: a scratch database, no model, no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'progress-scope-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const db = (await import('../server/database.js')).default;
const { ROLE_TOPIC, ROLE_PAGINATION } = await import('../server/nodeRole.js');
const { projectProgress, projectProgressById, projectProgressSource } = await import('../server/progress.js');

const mk = (name, kind, position) => db.prepare('INSERT INTO projects (name, kind, position) VALUES (?, ?, ?)').run(name, kind, position).lastInsertRowid;
const mkNode = (projectId, parentId, title, position, { role = ROLE_TOPIC, status = 'not_started', description = '' } = {}) => db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, role, status, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
).run(projectId, parentId, title, position, role, status, description).lastInsertRowid;
let seq = 0;
const mkCards = (nodeId, total, met) => {
    for (let i = 0; i < total; i++) {
        const reviewed = i < met;
        db.prepare('INSERT INTO flashcards (node_id, front, back, review_count, last_reviewed) VALUES (?, ?, ?, ?, ?)')
            .run(nodeId, `f${++seq}`, `b${seq}`, reviewed ? 1 : 0, reviewed ? new Date().toISOString() : null);
    }
};

// A course: sections, closed and open topics, one with taught material, cards on some.
const course = mk('Course', 'curriculum', 0);
const cRoot = mkNode(course, null, 'Course', 0);
const sec = mkNode(course, cRoot, 'Section', 0);
mkNode(course, sec, 'Closed topic', 0, { status: 'completed' });
mkNode(course, sec, 'Skipped topic', 1, { status: 'skipped' });
mkCards(mkNode(course, sec, 'Carded topic', 2, { status: 'in_progress' }), 12, 5);
mkNode(course, sec, 'Taught topic', 3, { description: 'x'.repeat(2000) });
// A deck with topics, and slices of card order beside them.
const deck = mk('Deck', 'deck', 1);
const dRoot = mkNode(deck, null, 'Deck', 0);
mkCards(mkNode(deck, dRoot, 'Core', 0), 40, 10);
mkCards(mkNode(deck, dRoot, 'Stage 1', 1, { role: ROLE_PAGINATION }), 30, 30);
// Card-order slices only: no topic row at all.
const slices = mk('Slices', 'deck', 2);
const sRoot = mkNode(slices, null, 'Slices', 0);
mkCards(mkNode(slices, sRoot, 'Stage 1', 0, { role: ROLE_PAGINATION }), 20, 7);
// Nothing in it.
const empty = mk('Empty', 'curriculum', 3);

const ids = [course, deck, slices, empty];
const all = projectProgressById(ids);
for (const [label, id] of [['a course', course], ['a deck', deck], ['card-order slices only', slices], ['an empty project', empty]]) {
    const one = projectProgress(id);
    const batch = all.get(id);
    check(`${label}: one project's progress equals the whole-library pass`,
        JSON.stringify(one) === JSON.stringify(batch), `one ${JSON.stringify(one)} vs all ${JSON.stringify(batch)}`);
}
// Another project's rows never leak in: the course's topics are its own four.
check('the course counts its own four topics, none of the deck\'s', projectProgress(course).totalTopics === 4,
    `got ${projectProgress(course).totalTopics}`);

const plan = db.prepare(`EXPLAIN QUERY PLAN ${projectProgressSource()}`).all(course).map((r) => r.detail);
check('the single-project query searches the project index', plan.some((d) => /SEARCH n USING (COVERING )?INDEX \S*project/i.test(d)), plan.join(' | '));
check('…and never scans every node', !plan.some((d) => /^SCAN n\b/.test(d)), plan.join(' | '));

db.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
