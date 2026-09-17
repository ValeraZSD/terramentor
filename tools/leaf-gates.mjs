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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'leaf-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const db = (await import('../server/database.js')).default;
const { LEAF_NODE, OPEN_LEAF, structuralChildren } = await import('../server/today.js');
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
const tree = (id) => ({
    id,
    is_note: !!db.prepare('SELECT is_note FROM nodes WHERE id = ?').get(id).is_note,
    children: db.prepare('SELECT id FROM nodes WHERE parent_id = ? ORDER BY position, id').all(id).map(r => tree(r.id)),
});
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
let isLeafNode = null, structuralChildrenTs = null;
try {
    const esbuild = require('esbuild');
    const out = join(scratch, 'tree.mjs');
    await esbuild.build({
        // fileURLToPath, never `.pathname` — this repo's path contains a space,
        // which stays percent-encoded in a URL and esbuild cannot resolve it.
        entryPoints: [fileURLToPath(new URL('../src/utils/tree.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    });
    ({ isLeafNode, structuralChildren: structuralChildrenTs } = await import(pathToFileURL(out).href));
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

try { db.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
