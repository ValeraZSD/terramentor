// tools/drag-order-gates.mjs — where a drag-and-drop puts things.
//
// Run:  node tools/drag-order-gates.mjs
//
// Deterministic, no model, no network, no database: `src/utils/dragOrder.ts` is
// pure, so this suite bundles it with esbuild and drives it directly.
//
// Why it exists. The Projects grid inserted a dropped card BEFORE the card it
// was dropped on, counted in the list without the dragged card. Going left that
// is the target's slot; going right it is the slot the card just left, so a
// card could be swapped with its left neighbour and never with its right one
// (A B C: B onto C gave A B C). The pre-fix rule is re-run below as the control.
// And a moved tree row waited for the server and a full refetch before it was
// drawn in its new place, so it snapped back and then jumped: the store now
// applies the server's own move rule first (`nodesAfterMove`).
//
// The Outline board (`NodeTree` + `CategoryCard`) is checked here too: a
// category dropped on another takes its slot both ways and never nests (the
// pre-fix board nested on the middle 40% of a card, re-run as the control), and
// a row can be carried from one category card into another (`treeDnd.ts`'s
// board half), landing where it was dropped, while every drop inside one card
// lands exactly where the per-card engine put it.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const scratch = mkdtempSync(join(tmpdir(), 'drag-order-gates-'));
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const src = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
// A machine without esbuild skips the gate; anything else, a source that does
// not BUILD included, fails it.
let esbuild;
try {
    esbuild = require('esbuild');
} catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    console.log(`SKIPPED: esbuild unavailable (${String(err.message).split('\n')[0]})`);
    process.exit(0);
}
let mod, treeOut;
{
    const out = join(scratch, 'dragOrder.mjs');
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL('../src/utils/dragOrder.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    });
    mod = await import(pathToFileURL(out).href);
    treeOut = join(scratch, 'treeDnd.mjs');
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL('../src/utils/treeDnd.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: treeOut, logLevel: 'silent',
    });
}
const { projectOrderAfterDrop, nodesAfterMove, nodesAfterReorder } = mod;

const P = (id, status = 'active') => ({ id, status, name: `p${id}` });
const ids = (list) => list?.map(p => p.id).join(' ') ?? 'null';
const grid = [P(1), P(2), P(3), P(4, 'completed'), P(5, 'completed'), P(6, 'archived')];

// The rule before the fix, verbatim in effect: insert before the target in the
// section without the dragged card.
function preFix(projects, draggedId, overId) {
    const dragged = projects.find(p => p.id === draggedId);
    const st = (p) => p.status ?? 'active';
    const target = typeof overId === 'string' ? overId.slice(7) : st(projects.find(p => p.id === overId));
    const section = (s) => projects.filter(p => p.id !== draggedId && st(p) === s);
    const list = section(target);
    const at = typeof overId === 'string' ? list.length : Math.max(0, list.findIndex(p => p.id === overId));
    list.splice(at, 0, { ...dragged, status: target });
    return ['active', 'completed', 'archived'].flatMap(s => (s === target ? list : section(s)));
}

console.log('\nprojects: a card takes the slot it is dropped on, either way');
check('the middle card onto its RIGHT neighbour moves right (A C B)', ids(projectOrderAfterDrop(grid, 2, 3)) === '1 3 2 4 5 6', ids(projectOrderAfterDrop(grid, 2, 3)));
check('the right card onto its LEFT neighbour moves left (A C B)', ids(projectOrderAfterDrop(grid, 3, 2)) === '1 3 2 4 5 6');
check('the first card onto the last goes last (B C A)', ids(projectOrderAfterDrop(grid, 1, 3)) === '2 3 1 4 5 6');
check('the last card onto the first goes first (C A B)', ids(projectOrderAfterDrop(grid, 3, 1)) === '3 1 2 4 5 6');
check('rightward inside another section too', ids(projectOrderAfterDrop(grid, 4, 5)) === '1 2 3 5 4 6');
check('a card dropped on itself moves nothing', projectOrderAfterDrop(grid, 2, 2) === null);
check('a drop that changes nothing is null, not a save', projectOrderAfterDrop([P(1)], 1, 'status:active') === null);
check('control: the pre-fix rule leaves the rightward drop where it was', ids(preFix(grid, 2, 3)) === '1 2 3 4 5 6');

console.log('\nprojects: across sections');
const toDone = projectOrderAfterDrop(grid, 2, 5);
check('onto a card of another section: before that card, with its status', ids(toDone) === '1 3 4 2 5 6' && toDone.find(p => p.id === 2).status === 'completed', ids(toDone));
const toEmpty = projectOrderAfterDrop([P(1), P(2), P(3, 'completed')], 1, 'status:archived');
check('onto an empty section\'s zone: last there, with its status', ids(toEmpty) === '2 3 1' && toEmpty[2].status === 'archived', ids(toEmpty));
check('the zone of its own section moves nothing', projectOrderAfterDrop(grid, 1, 'status:active') === null);
check('an unknown zone moves nothing', projectOrderAfterDrop(grid, 1, 'status:deleted') === null);
check('the input list is not mutated', ids(grid) === '1 2 3 4 5 6' && grid[1].status === 'active');

console.log('\ntree rows: the server\'s move rule, applied before the request');
const N = (id, parent_id, position, project_id = 7) => ({ id, parent_id, position, project_id, title: `n${id}` });
const nodes = [N(1, null, 0), N(2, null, 1), N(10, 1, 0), N(11, 1, 1), N(12, 1, 2), N(20, 2, 0), N(99, null, 0, 8)];
const kids = (list, parent) => list.filter(n => n.parent_id === parent && n.project_id === 7).sort((a, b) => a.position - b.position).map(n => n.id).join(' ');
const down = nodesAfterMove(nodes, 10, 1, 2);
check('a row moved down its own list lands at the index it was dropped on', kids(down, 1) === '11 12 10', kids(down, 1));
const across = nodesAfterMove(nodes, 11, 2, 0);
check('a row moved into another parent takes that parent and the slot', kids(across, 2) === '11 20' && kids(across, 1) === '10 12', `${kids(across, 2)} / ${kids(across, 1)}`);
const pos = (list, id) => list.find(n => n.id === id).position;
check('the new siblings are numbered 0..n', pos(across, 11) === 0 && pos(across, 20) === 1);
check('the OLD siblings keep their numbers, as on the server (10 at 0, 12 at 2)', pos(across, 10) === 0 && pos(across, 12) === 2, `${pos(across, 10)} ${pos(across, 12)}`);
check('a position past the end lands last, as splice puts it', kids(nodesAfterMove(nodes, 10, 2, 99), 2) === '20 10');
check('another project\'s rows are never renumbered', nodesAfterMove(nodes, 10, null, 0).find(n => n.id === 99).position === 0);
check('an unknown id changes nothing', nodesAfterMove(nodes, 404, 1, 0) === nodes);
const reordered = nodesAfterReorder(nodes, [2, 1], null);
check('a reorder numbers the listed ids in order', kids(reordered, null) === '2 1');

console.log('\ntree rows: the writer (guess now, server one request at a time, one refetch)');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(r => setTimeout(r, 0));
// A stand-in store: `shown` is every list put on screen, in order.
function rig(start = 'start') {
    const log = { shown: [], fails: [], fetches: 0, requests: [] };
    let screen = start;
    const fetches = [];
    const write = mod.createNodeWriter({
        getNodes: () => screen,
        show: (n) => { screen = n; log.shown.push(n); },
        fetch: () => { log.fetches++; const d = deferred(); fetches.push(d); return d.promise; },
        fail: (message) => log.fails.push(message),
    });
    const request = (name) => { const d = deferred(); return { d, run: () => { log.requests.push(name); return d.promise; } }; };
    return { log, write, request, fetches, screen: () => screen };
}
{
    const r = rig();
    const a = r.request('a');
    const done = r.write('guess', a.run, 'failed');
    check('the guess is on screen before the server answers', r.screen() === 'guess');
    a.d.resolve(); await tick();
    check('once it is saved, one refetch is asked', r.log.fetches === 1);
    r.fetches[0].resolve('rows'); await done;
    check('and the server\'s rows replace the guess', r.screen() === 'rows' && r.log.fails.length === 0);
}
{
    const r = rig();
    const a = r.request('a');
    const done = r.write('guess', a.run, 'Failed to move item');
    a.d.reject(new Error('500')); await tick();
    check('a refused write is said at once', r.log.fails.join() === 'Failed to move item');
    r.fetches[0].reject(new Error('offline')); await done;
    check('refused and unreachable: the screen goes back to what it showed before', r.screen() === 'start', String(r.screen()));
}
{
    const r = rig();
    const a = r.request('a');
    const done = r.write('guess', a.run, 'failed');
    a.d.reject(new Error('409')); await tick();
    r.fetches[0].resolve('rows'); await done;
    check('refused but reachable: the server\'s rows are drawn', r.screen() === 'rows' && r.log.fails.length === 1);
}
{
    const r = rig();
    const a = r.request('a'), b = r.request('b');
    const first = r.write('guess-a', a.run, 'failed');
    const second = r.write('guess-b', b.run, 'failed');
    await tick();
    check('two quick drops: the second request waits for the first', r.log.requests.join() === 'a');
    a.d.resolve(); await tick();
    check('the first drop answering asks no refetch while the second is pending', r.log.fetches === 0 && r.screen() === 'guess-b', `${r.log.fetches} ${r.screen()}`);
    check('then the second request goes', r.log.requests.join() === 'a,b');
    b.d.resolve(); await tick();
    r.fetches[0].resolve('rows'); await Promise.all([first, second]);
    check('and ONE refetch follows the burst', r.log.fetches === 1 && r.screen() === 'rows');
}
{
    const r = rig();
    const a = r.request('a'), b = r.request('b');
    const first = r.write('guess-a', a.run, 'failed');
    a.d.resolve(); await tick();
    check('a refetch is under way', r.log.fetches === 1);
    const second = r.write('guess-b', b.run, 'failed');
    r.fetches[0].resolve('stale'); await first;
    check('a refetch answering after a newer drop began is not drawn', r.screen() === 'guess-b', String(r.screen()));
    b.d.resolve(); await tick();
    r.fetches[1].resolve('fresh'); await second;
    check('the newer drop\'s own refetch is', r.screen() === 'fresh');
}

console.log('\nthe Outline board: a category dropped on another takes its slot, never nests');
const { categoryOrderAfterDrop, categoryDropSide } = mod;
const cats = [1, 2, 3, 4];
check('onto its RIGHT neighbour: the two swap', categoryOrderAfterDrop(cats, 2, 3)?.join(' ') === '1 3 2 4');
check('onto its LEFT neighbour: the two swap', categoryOrderAfterDrop(cats, 3, 2)?.join(' ') === '1 3 2 4');
check('the first onto the last goes last', categoryOrderAfterDrop(cats, 1, 4)?.join(' ') === '2 3 4 1');
check('the last onto the first goes first', categoryOrderAfterDrop(cats, 4, 1)?.join(' ') === '4 1 2 3');
check('onto itself or an unknown card: nothing moves', categoryOrderAfterDrop(cats, 2, 2) === null && categoryOrderAfterDrop(cats, 2, 9) === null);
check('the bar is drawn on the side it lands: after going right, before going left', categoryDropSide(cats, 2, 3) === 'after' && categoryDropSide(cats, 3, 2) === 'before');
// A MODEL of the board's old rule, written here because it lived inside the
// component: the pointer's place across the target decided before (left 30%)
// / after (right 30%) / INSIDE (the middle), and inside nested it.
const preFixBoard = (ids, a, o, relX) => {
    if (relX >= 0.3 && relX <= 0.7) return { nest: o };
    const list = ids.filter(id => id !== a);
    list.splice(list.indexOf(o) + (relX > 0.7 ? 1 : 0), 0, a);
    return { order: list };
};
check('control: the pre-fix board NESTED a category dropped on the middle of another', preFixBoard(cats, 2, 3, 0.5).nest === 3);
const board = src('src/components/NodeTree.tsx');
check('the board has no nest zone left (no "inside" mode, no "Drop to nest")', !/'inside'/.test(board) && !/Drop to nest/.test(board) && !/Drop to nest/.test(src('src/components/CategoryCard.tsx')));
check('the board places a category drop through categoryOrderAfterDrop', /categoryOrderAfterDrop\(ids, activeId, target\.id as number\)/.test(board));

console.log('\nthe Outline board: a row carried from one category card into another');
const tree = await import(pathToFileURL(treeOut).href);
const T = (id, children = []) => ({ id, title: `n${id}`, children });
const cards = [T(1, [T(10, [T(100)]), T(11), T(12)]), T(2, [T(20), T(21), T(22)]), T(3)];
const ex = {};
const show = (lists) => [...lists].map(([c, items]) => `${c}:${items.map(i => `${i.id}@${i.depth}`).join(',')}`).join(' | ');
const at = (lists, card) => lists.get(card).map(i => i.id).join(' ');
const still = tree.boardRows(cards, ex, null, null);
const all = [...still.values()].flat();
check('each card lists its own rows, depth counted from the card', show(still) === '1:10@0,100@1,11@0,12@0 | 2:20@0,21@0,22@0 | 3:', show(still));
const host = tree.hostOver(tree.boardRows(cards, ex, 11, null), 11, 1, 2, 21, false);
check('carried over row 21 of card 2 (upper half): drawn before it, at its depth', host?.cardId === 2 && host.index === 1 && host.depth === 0, JSON.stringify(host));
check('lower half: after it', tree.hostOver(tree.boardRows(cards, ex, 11, null), 11, 1, 2, 21, true)?.index === 2);
check('back over its own card it is hosted nowhere', tree.hostOver(tree.boardRows(cards, ex, 11, null), 11, 1, 1, 12, false) === null);
const hosted = tree.boardRows(cards, ex, 11, host);
check('while hosted, card 1 no longer draws it and card 2 does, in the slot', at(hosted, 1) === '10 100 12' && at(hosted, 2) === '20 11 21 22', show(hosted));
const into = tree.boardRowDrop(hosted, all, 11, 11, 300, 1);
check('dropped there: card 2 is its parent, position 1 (between 20 and 21)', into?.parentId === 2 && into.position === 1, JSON.stringify(into));
check('further down, onto 22: last in card 2', JSON.stringify(tree.boardRowDrop(hosted, all, 11, 22, 300, 1)) === '{"parentId":2,"position":3}');
const counted = tree.getProjection(hosted.get(2), 11, 11, 300, 2);
check('control: counting the sideways trip to card 2 as depth nests it under row 20', counted.parentId === 20, JSON.stringify(counted));
const oldFrame = tree.getProjection(tree.removeDescendants(tree.flattenVisible(cards[0].children, ex, 1, 0, [1]), 11), 11, 21, 0, 1);
check('control: in the old one-context-per-card frame row 21 is no target, and the row stays in card 1', oldFrame.parentId === 1 && oldFrame.depth === 0);
const noRows = tree.boardRows(cards, ex, 11, null);
check('a card with no rows is not a row list to host in (it is a target as a card)', noRows.get(3).length === 0 && tree.hostOver(noRows, 11, 1, 3, 30, false) === null);

console.log('\nthe Outline board: a release that comes before the carried row was drawn');
// The pointer reaches card 2 and the button is let go in the same instant, so
// the host for row 21 is worked out at the release, never drawn.
const upper = tree.hostOver(noRows, 11, 1, 2, 21, false);
const lower = tree.hostOver(noRows, 11, 1, 2, 21, true);
const over21 = { kind: 'row', id: 21 };
const settled = (final) => JSON.stringify(tree.settleRowDrop(cards, ex, 11, null, final, over21, 300));
check('upper half of 21: it lands BEFORE 21 (position 1), the side the line was on', settled(upper) === '{"parentId":2,"position":1}', settled(upper));
check('lower half of 21: it lands AFTER 21 (position 2)', settled(lower) === '{"parentId":2,"position":2}', settled(lower));
const measuredAgain = tree.boardRowDrop(tree.boardRows(cards, ex, 11, upper), all, 11, 21, 300, 1);
check('control: measuring the fresh slot against 21 again carries it past 21', JSON.stringify(measuredAgain) === '{"parentId":2,"position":2}', JSON.stringify(measuredAgain));
check('the card it came from is read off the tree: 300px sideways in card 2 is not depth (card level, not under 20)', settled(upper).startsWith('{"parentId":2,'));
const deep = JSON.stringify(tree.settleRowDrop(cards, ex, 100, null, tree.hostOver(tree.boardRows(cards, ex, 100, null), 100, 1, 2, 21, false), over21, 300));
check('a row two levels down (100, under 10) is found in its card too, and lands before 21', deep === '{"parentId":2,"position":1}', deep);
const hostAsSource =tree.boardRowDrop(tree.boardRows(cards, ex, 11, upper), all, 11, 11, 300, 2);
check('control: taking the HOSTING card for the source (what a remounted row\'s data says) nests it under 20', hostAsSource?.parentId === 20, JSON.stringify(hostAsSource));

console.log('\nthe Outline board: a release after the carried row was drawn');
check('a drawn host: measured against the row under the pointer, the sortable rule its displacement draws', JSON.stringify(tree.settleRowDrop(cards, ex, 11, upper, upper, { kind: 'row', id: 22 }, 300)) === '{"parentId":2,"position":3}');
check('drawn in card 2, released back over its own card: the in-card drop, sideways offset counted', JSON.stringify(tree.settleRowDrop(cards, ex, 11, upper, null, { kind: 'row', id: 12 }, 20)) === JSON.stringify(tree.boardRowDrop(noRows, all, 11, 12, 20, 1)));
const three = [cards[0], cards[1], T(3, [T(30), T(31)])];
const allThree = [...tree.boardRows(three, ex, null, null).values()].flat();
const inTwo = tree.hostOver(tree.boardRows(three, ex, 11, null), 11, 1, 2, 21, false);
const inThree = tree.hostOver(tree.boardRows(three, ex, 11, inTwo), 11, 1, 3, 31, false);
const third = JSON.stringify(tree.settleRowDrop(three, ex, 11, inTwo, inThree, { kind: 'row', id: 31 }, 600));
check('drawn in card 2, released over the upper half of 31 in card 3: before 31', third === '{"parentId":3,"position":1}', third);
const thirdAgain = JSON.stringify(tree.boardRowDrop(tree.boardRows(three, ex, 11, inThree), allThree, 11, 31, 600, 1));
check('control: measured against 31 again, it lands after 31', thirdAgain === '{"parentId":3,"position":2}', thirdAgain);

console.log('\nthe Outline board: cards that show no rows, rows folded shut');
check('over a card showing no rows (empty, or folded shut): last among its items', JSON.stringify(tree.settleRowDrop(cards, ex, 11, null, null, { kind: 'card', id: 3 }, 0)) === '{"parentId":3,"position":0}'
    && JSON.stringify(tree.settleRowDrop(cards, ex, 11, null, null, { kind: 'card', id: 2 }, 0)) === '{"parentId":2,"position":3}');
const below10 = (state) => JSON.stringify(tree.settleRowDrop(cards, state, 21, null, tree.hostOver(tree.boardRows(cards, state, 21, null), 21, 2, 1, 10, true), { kind: 'row', id: 10 }, 0));
check('carried from card 2 below row 10 of card 1, 10 folded shut: its sibling after it', below10({ 10: false }) === '{"parentId":1,"position":1}', below10({ 10: false }));
check('the same with 10 open: between 10 and its child 100, so inside 10, first', below10(ex) === '{"parentId":10,"position":0}', below10(ex));
check('the board settles a row drop through settleRowDrop with the drawn and the final host', /settleRowDrop\(tree, expanded, activeId, drawn, finalHost,/.test(board));
check('the board reads the source card off the tree, never off the dragged row\'s data', /sourceCardId = kind === 'row' \? cardOfNode\(tree, activeId\)/.test(board) && !/event\.active\.data\.current\?\.cardId/.test(board));

console.log('\nthe Outline board: what a drag inside one card did before, it still does');
const perCard = (active, over, offset) => {
    // CategoryCard before this change: its own list, its own projection.
    const full = tree.flattenVisible(cards[0].children, ex, 1, 0, [1]);
    const items = tree.removeDescendants(full, active);
    const p = tree.getProjection(items, active, over, offset, 1);
    if (tree.isDescendantTarget(full, active, p.parentId)) return null;
    return { parentId: p.parentId, position: tree.getDropPosition(items, active, over, p) };
};
let same = 0, differ = [];
for (const active of [10, 11, 12]) {
    const lists = tree.boardRows(cards, ex, active, null);
    for (const over of lists.get(1).map(i => i.id)) {
        for (let offset = -60; offset <= 60; offset += 10) {
            const a = JSON.stringify(tree.boardRowDrop(lists, all, active, over, offset, 1));
            const b = JSON.stringify(perCard(active, over, offset));
            if (a === b) same++; else differ.push(`${active}->${over}@${offset}: ${a} vs ${b}`);
        }
    }
}
check(`every in-card drop lands where the per-card engine put it (${same} cases)`, differ.length === 0, differ.slice(0, 3).join('; '));
let intoOwn = [];
for (const over of tree.boardRows(cards, ex, 10, null).get(1).map(i => i.id)) {
    for (let offset = -100; offset <= 300; offset += 20) {
        const d = tree.boardRowDrop(tree.boardRows(cards, ex, 10, null), all, 10, over, offset, 1);
        if (d && (d.parentId === 10 || d.parentId === 100)) intoOwn.push(`${over}@${offset}`);
    }
}
check('a row is never dropped into its own subtree (10 never lands under 10 or 100)', intoOwn.length === 0, intoOwn.join(' '));

console.log('\nwiring');
const gridSrc = src('src/components/ProjectsGrid.tsx');
check('the Projects grid places a drop through projectOrderAfterDrop', /projectOrderAfterDrop\(projects, draggedId, over\.id\)/.test(gridSrc));
const store = src('src/store.ts');
const moveBody = store.slice(store.indexOf('moveNode: async'), store.indexOf('refreshNodes: async'));
check('moveNode writes through the writer with nodesAfterMove', /writeNodes\(\)\(\s*nodesAfterMove\(/.test(moveBody));
check('reorderNodes writes through the writer with nodesAfterReorder', /writeNodes\(\)\(\s*nodesAfterReorder\(/.test(moveBody));
check('the store builds ONE writer from createNodeWriter', /nodeWriter \?\?= createNodeWriter\(/.test(store));
check('a category card has no drag context of its own (that is what kept a row inside its card)', !/<DndContext/.test(src('src/components/CategoryCard.tsx')));
check('the board has exactly one', (board.match(/<DndContext/g) ?? []).length === 1);
for (const file of ['NodeTree', 'Sidebar']) {
    const body = src(`src/components/${file}.tsx`);
    const at = body.indexOf('await moveNode(');
    const opened = body.lastIndexOf('setExpanded(', at);
    check(`${file} opens the drop target before the write`, at > -1 && opened > -1 && at - opened < 200, `${at - opened} chars apart`);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
