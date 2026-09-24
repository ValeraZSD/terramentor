// tools/leaf-gates.mjs — the one definition of "leaf", asserted on all three
// copies of it at once.
//
// Run:  node tools/leaf-gates.mjs
//
// "Leaf = a non-note node with no NON-NOTE children" is the rule the whole app
// counts, schedules, teaches and gates against, and it is written out three
// times because three places need it in three shapes:
//
//   1. `LEAF_NODE`        — a SQL fragment (server/today.js), for the queries;
//   2. `structuralChildren` — the same rule over an in-memory node (also
//                           today.js), for server code that already built a tree;
//   3. `isLeafNode`       — the frontend's copy (src/utils/tree.ts).
//
// Until this file existed, `npm test` executed NONE of them: the scheduler has
// its own fourth copy inside `getLeafNodesSequential`, and that is the only one
// any suite reached. So the two mirrors could disagree in the direction that
// hurts — the SQL counting a note as structure hides work the feed keeps
// serving, and the frontend counting it hides the topic in the tree while the
// server still schedules it. That exact mistake has been made five times in this
// codebase (see the comment in today.js), which is why the rule is asserted
// rather than reviewed.
//
// Deterministic: a scratch database, a fixture of four shapes, no model and no
// network. The frontend copy is bundled from the real .ts with esbuild, so this
// tests the shipped function rather than a transcription of it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'leaf-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const db = (await import('../server/database.js')).default;
const { LEAF_NODE, OPEN_LEAF, WORK_LEAF, workLeaves, structuralChildren } = await import('../server/today.js');
// The server's in-memory half of the rule is the exported primitive plus the
// note test; composed here rather than imported so this suite depends only on
// `structuralChildren`, which is what the server's own callers use.
const isStructuralLeaf = (node) => !node?.is_note && structuralChildren(node).length === 0;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

// ---- the fixture: every shape the rule has to decide -------------------------
//
//   A  topic + one NOTE child           → a leaf (a note is material, not work)
//   B  topic + one TOPIC child          → not a leaf
//   C  topic + a note AND a topic child → not a leaf (the mixed case, which is
//                                         where the "children.length" bug lives)
//   D  topic, no children               → a leaf
//
// B's and C's topic children are leaves themselves, and are named so the
// expected set can be written out in full rather than filtered down to the four
// interesting nodes.
const projectId = Number(db.prepare(`INSERT INTO projects (name) VALUES ('leaf gate')`).run().lastInsertRowid);
const mkNode = (title, parentId, isNote = 0, position = 0) => Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, position, is_note) VALUES (?, ?, ?, ?, ?)`
).run(projectId, parentId, title, position, isNote).lastInsertRowid);

const A = mkNode('A — topic whose only child is a note', null, 0, 0);
const aNote = mkNode('A/reading', A, 1);
const B = mkNode('B — topic with a sub-topic', null, 0, 1);
const bKid = mkNode('B/sub-topic', B, 0);
const C = mkNode('C — topic with a note AND a sub-topic', null, 0, 2);
const cNote = mkNode('C/reading', C, 1);
const cKid = mkNode('C/sub-topic', C, 0, 1);
const D = mkNode('D — topic with no children at all', null, 0, 3);

const name = new Map([[A, 'A'], [B, 'B'], [C, 'C'], [D, 'D'], [bKid, 'B/sub'], [cKid, 'C/sub'],
[aNote, 'A/note'], [cNote, 'C/note']]);
const show = (ids) => [...ids].map(id => name.get(id) ?? id).sort().join(', ');

// ---- 1. the SQL fragment ----------------------------------------------------
console.log('\n--- LEAF_NODE, the SQL every task query is built on ---');
const sqlLeaves = new Set(db.prepare(
    `SELECT n.id FROM nodes n WHERE n.project_id = ? AND ${LEAF_NODE}`
).all(projectId).map(r => r.id));

check('a topic whose only child is a note IS a leaf', sqlLeaves.has(A));
check('a topic with a sub-topic is NOT', !sqlLeaves.has(B));
check('a topic with a note AND a sub-topic is NOT', !sqlLeaves.has(C));
check('a topic with no children at all IS', sqlLeaves.has(D));
check('a note is never a leaf, whatever hangs off it', !sqlLeaves.has(aNote) && !sqlLeaves.has(cNote));
check('the leaf set is exactly A, D and the two sub-topics — nothing else',
    show(sqlLeaves) === 'A, B/sub, C/sub, D', show(sqlLeaves));

// The fragment that serves work is the same rule plus a status filter, so a
// drift in LEAF_NODE reaches the daily plan through OPEN_LEAF too.
db.prepare(`UPDATE nodes SET status = 'completed' WHERE id = ?`).run(D);
const openLeaves = new Set(db.prepare(
    `SELECT n.id FROM nodes n WHERE n.project_id = ? AND ${OPEN_LEAF}`
).all(projectId).map(r => r.id));
check('OPEN_LEAF is LEAF_NODE minus what is closed',
    show(openLeaves) === 'A, B/sub, C/sub', show(openLeaves));
db.prepare(`UPDATE nodes SET status = 'not_started' WHERE id = ?`).run(D);

// ---- the same tree, in memory ----------------------------------------------
const tree = (id) => {
    const row = db.prepare('SELECT is_note, role FROM nodes WHERE id = ?').get(id);
    return {
        id,
        is_note: !!row.is_note,
        // The client is handed `role` on every node payload; carry it here or the
        // work-leaf half of the rule has nothing to read.
        role: row.role ?? undefined,
        children: db.prepare('SELECT id FROM nodes WHERE parent_id = ? ORDER BY position, id').all(id).map(r => tree(r.id)),
    };
};
const roots = [A, B, C, D].map(tree);
const walk = (nodes, fn, out = new Set()) => {
    for (const n of nodes) { if (fn(n)) out.add(n.id); walk(n.children, fn, out); }
    return out;
};

// ---- 2. the server's in-memory copy ----------------------------------------
console.log('\n--- structuralChildren, the same rule for code that already has a tree ---');
check('it agrees with the SQL, node for node',
    show(walk(roots, isStructuralLeaf)) === show(sqlLeaves),
    `${show(walk(roots, isStructuralLeaf))} vs ${show(sqlLeaves)}`);
check('structuralChildren drops notes and keeps topics',
    structuralChildren(roots[0]).length === 0
    && structuralChildren(roots[2]).length === 1
    && structuralChildren(roots[2])[0].id === cKid,
    `A:${structuralChildren(roots[0]).length} C:${structuralChildren(roots[2]).length}`);
check('…and it is not just counting children', roots[2].children.length === 2);
check('a missing node, or one with no children array, is not a crash',
    structuralChildren(undefined).length === 0 && structuralChildren({ id: 0 }).length === 0);

// ---- 3. the frontend's copy -------------------------------------------------
console.log('\n--- isLeafNode, the copy the tree, the sidebar and the detail panel read ---');
const require = createRequire(import.meta.url);
let isLeafNode = null, structuralChildrenTs = null, getLeafNodesTs = null, getWorkLeavesTs = null;
try {
    const esbuild = require('esbuild');
    const out = join(scratch, 'tree.mjs');
    await esbuild.build({
        // fileURLToPath, never `.pathname` — this repo's path contains a space,
        // which stays percent-encoded in a URL and esbuild cannot resolve it.
        entryPoints: [fileURLToPath(new URL('../src/utils/tree.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    });
    ({
        isLeafNode,
        structuralChildren: structuralChildrenTs,
        getLeafNodes: getLeafNodesTs,
        getWorkLeaves: getWorkLeavesTs,
    } = await import(pathToFileURL(out).href));
} catch (err) {
    console.log(`SKIPPED: the frontend copy — esbuild unavailable (${err.message.split('\n')[0]})`);
}

if (isLeafNode) {
    const tsLeaves = walk(roots, isLeafNode);
    check('a topic whose only child is a note IS a leaf here too', tsLeaves.has(A));
    check('a topic with a sub-topic is NOT', !tsLeaves.has(B));
    check('a topic with a note AND a sub-topic is NOT', !tsLeaves.has(C));
    check('a topic with no children at all IS', tsLeaves.has(D));
    // The assertion the whole file exists for: two implementations, one answer.
    check('the frontend and the SQL name the same set of leaves',
        show(tsLeaves) === show(sqlLeaves), `${show(tsLeaves)} vs ${show(sqlLeaves)}`);
    check('structuralChildren excludes notes on this side as well',
        structuralChildrenTs(roots[0]).length === 0
        && structuralChildrenTs(roots[2]).map(c => c.id).join() === String(cKid),
        `A:${structuralChildrenTs(roots[0]).length} C:${structuralChildrenTs(roots[2]).map(c => c.id).join()}`);
    check('…and it returns the children rather than a filtered-out empty list',
        structuralChildrenTs(roots[1]).length === 1 && structuralChildrenTs(roots[1])[0].id === bKid);
}

// ---- 4. the OTHER half of the rule: which leaves are WORK -------------------
//
// A leaf is structure; a leaf the scheduler will DATE is work. `server/
// scheduling.js` dates a leaf only when `isWork(node)` — not pagination — so
// anything that tells the learner how much there is to schedule must count that
// set and not the structural one. The schedule dialog counted the structural
// set, so on an imported deck it promised a deadline for stages the server then
// never dated: every recommended deadline was too long and the pace it showed
// was for a plan nobody would be given.
//
// Its own fixture, a second project, so the sets asserted above stay exact.
console.log('\n--- WORK leaves, the set the scheduler actually dates ---');
const deckId = Number(db.prepare(
    `INSERT INTO projects (name, kind) VALUES ('leaf gate deck', 'deck')`
).run().lastInsertRowid);
const mkDeckNode = (title, parentId, role, position) => Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, position, is_note, role) VALUES (?, ?, ?, ?, 0, ?)`
).run(deckId, parentId, title, position, role).lastInsertRowid);

//   Imported deck ─ Stage 1  (pagination) → a structural leaf, never work
//                 ─ Grammar  (topic)      → both
//                 ─ Stage 2  (pagination)
//                 ─ Idioms   (topic)
const deckRoot = mkDeckNode('Imported deck', null, 'topic', 0);
const stage1 = mkDeckNode('Stage 1', deckRoot, 'pagination', 0);
const topic1 = mkDeckNode('Grammar', deckRoot, 'topic', 1);
const stage2 = mkDeckNode('Stage 2', deckRoot, 'pagination', 2);
const topic2 = mkDeckNode('Idioms', deckRoot, 'topic', 3);

const deckName = new Map([[stage1, 'Stage 1'], [topic1, 'Grammar'], [stage2, 'Stage 2'], [topic2, 'Idioms'],
[deckRoot, 'Imported deck']]);
const showDeck = (ids) => [...ids].map(id => deckName.get(id) ?? id).sort().join(', ');

const deckSql = (fragment) => new Set(db.prepare(
    `SELECT n.id FROM nodes n WHERE n.project_id = ? AND ${fragment}`
).all(deckId).map(r => r.id));
const sqlStructural = deckSql(LEAF_NODE);
const sqlWork = deckSql(WORK_LEAF);

check('LEAF_NODE counts a stage — it IS a leaf, structurally',
    showDeck(sqlStructural) === 'Grammar, Idioms, Stage 1, Stage 2', showDeck(sqlStructural));
check('WORK_LEAF does not — a slice of card order is nothing anyone finishes',
    showDeck(sqlWork) === 'Grammar, Idioms', showDeck(sqlWork));

const deckRows = db.prepare('SELECT id, parent_id, is_note, role FROM nodes WHERE project_id = ?').all(deckId);
check('workLeaves, the server\'s in-memory copy, names the same set',
    showDeck(workLeaves(deckRows).map(n => n.id)) === showDeck(sqlWork),
    `${showDeck(workLeaves(deckRows).map(n => n.id))} vs ${showDeck(sqlWork)}`);

if (getLeafNodesTs || getWorkLeavesTs) {
    const deckRoots = [tree(deckRoot)];
    const structuralTs = getLeafNodesTs ? getLeafNodesTs(deckRoots).map(n => n.id) : [];
    // The assertion the schedule dialog's "N topics to schedule" rests on. Before
    // this existed the dialog called getLeafNodes, counted the two stages, and
    // derived its presets, its deadlines and its pace from a number the server
    // disagreed with.
    const workTs = typeof getWorkLeavesTs === 'function' ? getWorkLeavesTs(deckRoots).map(n => n.id) : null;

    check('getLeafNodes stays STRUCTURAL — other callers read the tree\'s shape',
        showDeck(structuralTs) === showDeck(sqlStructural),
        `${showDeck(structuralTs)} vs ${showDeck(sqlStructural)}`);
    check('the frontend has a WORK-leaf collector at all',
        workTs !== null, 'src/utils/tree.ts exports no getWorkLeaves');
    check('…and it names the set the scheduler will date, stages excluded',
        workTs !== null && showDeck(workTs) === showDeck(sqlWork),
        workTs === null ? 'not exported' : `${showDeck(workTs)} vs ${showDeck(sqlWork)}`);
    check('…which is a strictly smaller set than the structural one here',
        workTs !== null && workTs.length === 2 && structuralTs.length === 4,
        `work:${workTs?.length} structural:${structuralTs.length}`);
}

// The count is a SOURCE fact as much as a function one: a correct collector that
// nothing calls is what `isWorkLeaf` was for three weeks. The dialog derives its
// header, its three preset deadlines and its pace box from one `leafCount`, so
// that one line is what this reads.
const modalSrc = readFileSync(fileURLToPath(new URL('../src/components/ScheduleModal.tsx', import.meta.url)), 'utf8');
const leafCountLine = modalSrc.split('\n').find(l => /const\s+leafCount\s*=/.test(l)) ?? '';
check('ScheduleModal counts WORK leaves', /getWorkLeaves\s*\(/.test(leafCountLine), leafCountLine.trim() || 'no leafCount found');
check('…and does not fall back to the structural collector anywhere',
    !/\bgetLeafNodes\s*\(/.test(modalSrc), 'ScheduleModal.tsx still calls getLeafNodes()');

try { db.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
