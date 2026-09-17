#!/usr/bin/env node
/**
 * Deterministic gates for `nodes.role` — the column that replaced `projects.kind`
 * as the thing the engine branches on.
 *
 * The old flag answered four questions at once (has this material to teach? is
 * it scheduled? how is its queue rationed? is it a unit of meaning?) with one
 * enum decided by the door the project came in through, and it could never be
 * changed afterwards. `role` answers only the first, per node, and the importer
 * already knows the answer: a stage it CUT from card order is pagination, a
 * subdeck or tag the author NAMED is a topic.
 *
 * No model, no network; the DB half runs against a throwaway file.
 *
 *   node tools/role-gates.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'role-gates-'));
process.env.DB_PATH = join(scratch, 'gates.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; return; }
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
    check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const { planStages } = await import('../server/deckStructure.js');
const {
    TOPIC_NODE, ROLE_TOPIC, ROLE_PAGINATION,
    roleForStage, roleForImportedTitle, backfillNodeRoles,
    projectTeaches, setProjectTeaches, nodeIsTeachable,
} = await import('../server/nodeRole.js');

// ---- the pure rule ----------------------------------------------------------

eq('a stage cut from card ORDER is pagination', roleForStage({ kind: 'order' }), ROLE_PAGINATION);
eq('a group the author TAGGED is a topic', roleForStage({ kind: 'tag' }), ROLE_TOPIC);
eq('an unknown group shape defaults to topic', roleForStage({}), ROLE_TOPIC);
eq('no group at all is a topic', roleForStage(null), ROLE_TOPIC);

// The real generator, so the rule cannot drift from what the importer writes.
const cards = Array.from({ length: 300 }, (_, i) => ({ order: i + 3, noteId: 1000 + i }));
const ordered = planStages(cards, { deckName: 'D' });
check('an order-cut deck yields stages', ordered.length > 0);
check('every order-cut stage is pagination',
    ordered.every(s => roleForStage(s) === ROLE_PAGINATION));
check('every order-cut stage is titled "Stage N"',
    ordered.every(s => /^Stage \d+$/.test(s.title)), ordered[0]?.title);

const tagged = planStages(
    cards.map((c, i) => ({ ...c, tags: [i < 150 ? 'unit-01' : 'unit-02'] })),
    { deckName: 'D' });
check('a tagged deck yields tag groups', tagged.length === 2, `${tagged.length} groups`);
check('every tag group is a topic', tagged.every(s => roleForStage(s) === ROLE_TOPIC));

// ---- the backfill rule (rows written before the column existed) -------------

eq('"Stage 7" backfills as pagination', roleForImportedTitle('Stage 7'), ROLE_PAGINATION);
eq('"Stage 12" backfills as pagination', roleForImportedTitle('Stage 12'), ROLE_PAGINATION);
eq('a padded title still counts', roleForImportedTitle('  Stage 3  '), ROLE_PAGINATION);
eq('a named subdeck stays a topic', roleForImportedTitle('2.2 Gradients'), ROLE_TOPIC);
eq('a stage-ish topic name stays a topic', roleForImportedTitle('Stage lighting'), ROLE_TOPIC);
eq('a lowercase "stage 3" stays a topic', roleForImportedTitle('stage 3'), ROLE_TOPIC);
eq('an empty title stays a topic', roleForImportedTitle(''), ROLE_TOPIC);

// ---- the DB half ------------------------------------------------------------

const db = (await import('../server/database.js')).default;

const cols = db.pragma('table_info(nodes)').map(c => c.name);
check('nodes carries a role column', cols.includes('role'));
eq('the column defaults to topic',
    db.pragma('table_info(nodes)').find(c => c.name === 'role')?.dflt_value, `'topic'`);

const mkProject = (name, kind, position) => db.prepare(
    'INSERT INTO projects (name, kind, position) VALUES (?, ?, ?)'
).run(name, kind, position).lastInsertRowid;
const mkNode = (projectId, parentId, title, position, role) => db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, role) VALUES (?, ?, ?, ?, ?)'
).run(projectId, parentId, title, position, role).lastInsertRowid;

const deckId = mkProject('Gate deck', 'deck', 0);
const deckRoot = mkNode(deckId, null, 'Gate deck', 0, ROLE_TOPIC);
const stage1 = mkNode(deckId, deckRoot, 'Stage 1', 0, ROLE_PAGINATION);
const namedSub = mkNode(deckId, deckRoot, '2.2 Gradients', 1, ROLE_TOPIC);
const courseId = mkProject('Gate course', 'curriculum', 1);
const topicA = mkNode(courseId, null, 'Topic A', 0, ROLE_TOPIC);

// A row inserted without naming the column takes the default, which is what
// every existing node and every future AI-written node relies on.
const defaulted = db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, ?, ?)'
).run(courseId, 'Defaulted', 1).lastInsertRowid;
eq('a node written without a role is a topic',
    db.prepare('SELECT role FROM nodes WHERE id = ?').get(defaulted).role, ROLE_TOPIC);

// The SQL fragment every reader uses.
const topics = db.prepare(
    `SELECT n.id FROM nodes n WHERE n.project_id = ? AND ${TOPIC_NODE} ORDER BY n.id`
).all(deckId).map(r => r.id);
check('the SQL fragment keeps the deck root and the named subdeck',
    topics.includes(deckRoot) && topics.includes(namedSub), JSON.stringify(topics));
check('the SQL fragment drops the cut stage', !topics.includes(stage1));

// A legacy row with a NULL role (written before the migration) must read as a
// topic, never vanish from every query at once.
db.prepare('UPDATE nodes SET role = NULL WHERE id = ?').run(topicA);
check('a NULL role reads as a topic',
    db.prepare(`SELECT n.id FROM nodes n WHERE n.id = ? AND ${TOPIC_NODE}`).get(topicA) != null);
db.prepare('UPDATE nodes SET role = ? WHERE id = ?').run(ROLE_TOPIC, topicA);

// ---- backfill ---------------------------------------------------------------

db.prepare('UPDATE nodes SET role = ? WHERE project_id = ?').run(ROLE_TOPIC, deckId);
const { updated } = backfillNodeRoles({ force: true });
eq('the backfill demotes exactly the cut stages', updated, 1);
eq('the cut stage is pagination again',
    db.prepare('SELECT role FROM nodes WHERE id = ?').get(stage1).role, ROLE_PAGINATION);
eq('the named subdeck was left alone',
    db.prepare('SELECT role FROM nodes WHERE id = ?').get(namedSub).role, ROLE_TOPIC);
eq('the deck root was left alone',
    db.prepare('SELECT role FROM nodes WHERE id = ?').get(deckRoot).role, ROLE_TOPIC);
eq('a curriculum node named "Stage 1" is NOT demoted', (() => {
    const id = mkNode(courseId, null, 'Stage 1', 2, ROLE_TOPIC);
    backfillNodeRoles({ force: true });
    return db.prepare('SELECT role FROM nodes WHERE id = ?').get(id).role;
})(), ROLE_TOPIC);
eq('the backfill is idempotent', backfillNodeRoles({ force: true }).updated, 0);

// ---- may this project be taught? -------------------------------------------

eq('an authored project teaches by default', projectTeaches(courseId), true);
eq('an imported deck does not teach by default', projectTeaches(deckId), false);
setProjectTeaches(deckId, true);
eq('the switch turns an imported deck on', projectTeaches(deckId), true);
setProjectTeaches(courseId, false);
eq('the switch turns an authored project off', projectTeaches(courseId), false);
setProjectTeaches(deckId, false);
setProjectTeaches(courseId, true);

// ---- the two together: what may actually be taught --------------------------

eq('a topic in a teaching project is teachable', nodeIsTeachable(topicA), true);
eq('a cut stage is never teachable', nodeIsTeachable(stage1), false);
eq('a named subdeck in a non-teaching project is not taught yet', nodeIsTeachable(namedSub), false);
setProjectTeaches(deckId, true);
eq('…and is taught once the project is switched on', nodeIsTeachable(namedSub), true);
eq('…while its cut stage still is not', nodeIsTeachable(stage1), false);
setProjectTeaches(deckId, false);
eq('an unknown node is not teachable', nodeIsTeachable(999999), false);

// ---- one rationing function for both doors ----------------------------------

const { getNewPerDay, setNewPerDay, DEFAULT_NEW_PER_DAY, AUTHORED_NEW_PER_DAY } =
    await import('../server/decks.js');
const { FEED_DEFAULTS } = await import('../server/feed.js');

eq('the authored fallback mirrors the feed dial it stands in for',
    AUTHORED_NEW_PER_DAY, FEED_DEFAULTS.newCardsPerProjectPerDay);
eq('an import defaults to Anki’s rate', getNewPerDay(deckId), DEFAULT_NEW_PER_DAY);
eq('a project authored here defaults to the feed dial',
    getNewPerDay(courseId), FEED_DEFAULTS.newCardsPerProjectPerDay);
db.prepare(`
    INSERT INTO settings (key, value) VALUES ('feed_new_per_project', '4')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run();
eq('moving the feed dial moves the authored default', getNewPerDay(courseId), 4);
eq('…and leaves the import alone', getNewPerDay(deckId), DEFAULT_NEW_PER_DAY);
setNewPerDay(courseId, 7);
eq('a per-project setting wins for an authored project', getNewPerDay(courseId), 7);
setNewPerDay(deckId, 3);
eq('a per-project setting wins for an import', getNewPerDay(deckId), 3);
db.prepare("DELETE FROM settings WHERE key = 'feed_new_per_project'").run();
db.prepare("DELETE FROM settings WHERE key LIKE 'deck_new_per_day%'").run();

// ---- the feed still gives a card collection its turn ------------------------
//
// The standing slot used to be "this project is a deck". It is now "this
// project has cards and no schedule", which is the property that actually
// justifies it: a collection that is never scheduled can never be overdue, so
// without a reserved slot it is invisible on every day that has real work.

const feed = await import('../server/feed.js');
const today = new Date().toISOString().split('T')[0];
const past = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

db.prepare('UPDATE projects SET start_date = ?, deadline = ? WHERE id = ?')
    .run(past, today, courseId);
// Enough overdue leaves to fill every focus slot, which is exactly the state
// that hid the deck before the slot was reserved.
for (let i = 0; i < 12; i++) {
    const id = mkNode(courseId, null, `Overdue ${i}`, 10 + i, ROLE_TOPIC);
    db.prepare('UPDATE nodes SET scheduled_start = ?, scheduled_end = ? WHERE id = ?')
        .run(past, past, id);
}
db.prepare('INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, ?)')
    .run(stage1, 'front', 'back');

const { focus } = feed.getFocusNodes({ maxPerProject: 3, maxTotal: 6 });
check('the overdue course fills most of the feed',
    focus.filter(f => f.projectId === courseId).length >= 3);
check('a card collection with no schedule still gets a slot',
    focus.some(f => f.projectId === deckId), JSON.stringify(focus.map(f => f.projectId)));
check('the cut stage it contributes is marked untaught',
    focus.filter(f => f.nodeId === stage1).every(f => f.teachable === false));
check('a scheduled course node is teachable',
    focus.filter(f => f.projectId === courseId).every(f => f.teachable === true));

// An unscheduled project with NO cards is not a standing project — it has
// nothing to contribute on a busy day and taking a reserved slot for it would
// push real work out of the feed.
const emptyId = mkProject('Unscheduled and empty', 'curriculum', 2);
mkNode(emptyId, null, 'Nothing here', 0, ROLE_TOPIC);
const after = feed.getFocusNodes({ maxPerProject: 3, maxTotal: 6 }).focus;
check('an unscheduled project with no cards takes no reserved slot',
    !after.some(f => f.projectId === emptyId));

// ---- pagination is never a unit of WORK -------------------------------------
//
// A stage cut out of card order is a container for cards, not something a
// learner finishes. Counting one as unfinished work is what made a deck
// switched to teaching read "0 / 57 items" — 32 real topics plus 25 slices of
// card order that can never be completed, so its progress could never reach
// 100% and its dashboard said 0% forever.
//
// The rule is one predicate (WORK_LEAF) and one in-memory mirror (workLeaves),
// and every progress number in the app is counted with one of them.

const { WORK_LEAF, OPEN_LEAF, OPEN_WORK_LEAF, LEAF_NODE, workLeaves } =
    await import('../server/today.js');
const { loadProjectSummaries } = await import('../server/projectSummary.js');

const mixedId = mkProject('Imported, then taught', 'deck', 3);
const mixedRoot = mkNode(mixedId, null, 'Imported, then taught', 0, ROLE_TOPIC);
const realTopic = mkNode(mixedId, mixedRoot, '2.2 Gradients', 0, ROLE_TOPIC);
const otherTopic = mkNode(mixedId, mixedRoot, '2.3 Divergence', 1, ROLE_TOPIC);
const cutStage = mkNode(mixedId, mixedRoot, 'Stage 1', 2, ROLE_PAGINATION);

const leafIds = (sql) => db.prepare(
    `SELECT n.id FROM nodes n WHERE n.project_id = ? AND ${sql} ORDER BY n.id`
).all(mixedId).map(r => r.id);

check('the structural leaf rule still sees the cut stage',
    leafIds(LEAF_NODE).includes(cutStage));
check('the work rule does not', !leafIds(WORK_LEAF).includes(cutStage),
    JSON.stringify(leafIds(WORK_LEAF)));
check('the work rule keeps the real topics',
    [realTopic, otherTopic].every(id => leafIds(WORK_LEAF).includes(id)));
check('an open work leaf is a topic that is still open',
    leafIds(OPEN_WORK_LEAF).includes(realTopic) && !leafIds(OPEN_WORK_LEAF).includes(cutStage));
// The one place a stage MUST survive: the feed serves cards through the node
// they hang off, so dropping pagination from the feed's own pool would take a
// whole imported collection off the home page.
check('the feed\'s open-leaf pool still reaches a stage full of cards',
    leafIds(OPEN_LEAF).includes(cutStage));

const summaryFor = (id) => loadProjectSummaries().find(p => p.id === id);
let s = summaryFor(mixedId);
eq('node_count stays the STRUCTURAL leaf count (leaf-invariant.mjs pins it)',
    s.node_count, 3);
eq('topic_count counts only what can be worked on', s.topic_count, 2);
eq('nothing is closed yet', s.completed_topic_count, 0);

db.prepare("UPDATE nodes SET status = 'completed' WHERE id = ?").run(realTopic);
s = summaryFor(mixedId);
eq('closing a topic advances the topic count', s.completed_topic_count, 1);

// The case that started this: a learner ticks a stage off in the tree.
db.prepare("UPDATE nodes SET status = 'completed' WHERE id = ?").run(cutStage);
s = summaryFor(mixedId);
eq('a ticked pagination stage does not advance progress', s.completed_topic_count, 1);
eq('…though it is still a closed leaf structurally', s.completed_count, 2);
check('progress over topics can reach 100%', (() => {
    db.prepare("UPDATE nodes SET status = 'completed' WHERE id = ?").run(otherTopic);
    const r = summaryFor(mixedId);
    return r.completed_topic_count === r.topic_count;
})());
db.prepare("UPDATE nodes SET status = 'not_started' WHERE project_id = ?").run(mixedId);

// The in-memory mirror, for the callers that have already built a tree.
const rows = db.prepare('SELECT * FROM nodes WHERE project_id = ? AND is_note = 0').all(mixedId);
const work = workLeaves(rows).map(n => n.id).sort((a, b) => a - b);
eq('the in-memory mirror agrees with the SQL',
    JSON.stringify(work), JSON.stringify(leafIds(WORK_LEAF)));

// A topic whose only children are notes is still a unit of work — the oldest
// rule in this file and the easiest one to break while adding a second test.
const noted = mkNode(mixedId, mixedRoot, 'Topic with material', 3, ROLE_TOPIC);
db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, is_note, role) VALUES (?, ?, ?, ?, 1, ?)'
).run(mixedId, noted, 'Reading', 0, ROLE_TOPIC);
check('a topic whose only children are notes is still work',
    leafIds(WORK_LEAF).includes(noted));

// ---- and nothing schedules it, plans it, or offers it as a task -------------

const { generateDailyPlan } = await import('../server/dailyPlan.js');
const soon = new Date().toISOString().split('T')[0];
db.prepare('UPDATE nodes SET scheduled_start = ?, scheduled_end = ? WHERE id IN (?, ?)')
    .run(soon, soon, realTopic, cutStage);
const plan = generateDailyPlan(mixedId, 14);
check('today\'s plan offers the topic',
    plan.todayTasks.some(t => t.id === realTopic));
check('today\'s plan never offers a slice of card order',
    !plan.todayTasks.some(t => t.id === cutStage),
    JSON.stringify(plan.todayTasks.map(t => t.title)));
check('nor does it queue one as the next thing to start',
    !plan.nextUnlocked.some(t => t.id === cutStage));

const { allocateSchedule } = await import('../server/scheduling.js');
const week = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
const allocated = allocateSchedule(mixedId, soon, week, [0, 1, 2, 3, 4, 5, 6]);
check('the scheduler ran', allocated.success === true, allocated.error);
check('the scheduler allocates dates to topics',
    allocated.assignments?.has(realTopic), JSON.stringify([...(allocated.assignments?.keys() || [])]));
check('the scheduler gives a cut stage no dates of its own',
    !allocated.assignments?.has(cutStage));
eq('…and does not count it in the pace it reports',
    allocated.stats?.leafCount, 3);

// ---- report -----------------------------------------------------------------

try { (await import('../server/database.js')).closeDatabase(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }

if (failures.length) {
    console.error(`role-gates: ${failures.length} FAILED, ${pass} passed`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
}
console.log(`role-gates: ${pass} assertions passed`);
