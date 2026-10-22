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

let mod;
try {
    const esbuild = require('esbuild');
    const out = join(scratch, 'dragOrder.mjs');
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL('../src/utils/dragOrder.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    });
    mod = await import(pathToFileURL(out).href);
} catch (err) {
    console.log(`SKIPPED: esbuild unavailable (${String(err.message).split('\n')[0]})`);
    rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
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

console.log('\nwiring');
const gridSrc = src('src/components/ProjectsGrid.tsx');
check('the Projects grid places a drop through projectOrderAfterDrop', /projectOrderAfterDrop\(projects, draggedId, over\.id\)/.test(gridSrc));
const store = src('src/store.ts');
const moveBody = store.slice(store.indexOf('moveNode: async'), store.indexOf('refreshNodes: async'));
check('moveNode writes through the writer with nodesAfterMove', /writeNodes\(\)\(\s*nodesAfterMove\(/.test(moveBody));
check('reorderNodes writes through the writer with nodesAfterReorder', /writeNodes\(\)\(\s*nodesAfterReorder\(/.test(moveBody));
check('the store builds ONE writer from createNodeWriter', /nodeWriter \?\?= createNodeWriter\(/.test(store));
for (const file of ['NodeTree', 'CategoryCard', 'Sidebar']) {
    const body = src(`src/components/${file}.tsx`);
    const at = body.indexOf('await moveNode(');
    const opened = body.lastIndexOf('setExpanded(', at);
    check(`${file} opens the drop target before the write`, at > -1 && opened > -1 && at - opened < 200, `${at - opened} chars apart`);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
