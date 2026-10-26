// tools/drop-flash-gates.mjs — a dropped item flashes where it landed.
//
// Run:  node tools/drop-flash-gates.mjs
//
// Deterministic, no model, no network, no database, no browser. The flash's
// clock (`src/utils/dropFlash.ts`) and the "did this move change anything"
// rule (`moveChangesPlace` in `src/utils/dragOrder.ts`) are bundled with
// esbuild and driven directly; the four drag surfaces and the stylesheet are
// read as source.
//
// Why it exists. A drop updates the list at once, so the item is simply
// somewhere else on the next frame and the learner has to hunt for where it
// went. Each surface now asks for one flash of the
// moved item's background in the accent (Atlassian's rule: 700 ms,
// cubic-bezier(0.25, 0.1, 0.25, 1)). What can go wrong, each checked below:
//   - a drop back where it started flashes as if it went somewhere (the
//     control is the naive "stored position differs" test, which a list with
//     gaps in its positions fools);
//   - a row carried into another card remounts and replays, or loses, the flash
//     (the start is kept outside React and a late mount resumes it);
//   - the flash animates OPACITY on a sortable item, and the drop blinks
//     (dnd-kit hides a dropped card while its overlay lands);
//   - the Projects grid flashes under its own drop animation, while the card
//     is still hidden;
//   - reduced motion silently removes the only sign of where the item went.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const scratch = mkdtempSync(join(tmpdir(), 'drop-flash-gates-'));
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const src = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
let esbuild;
try {
    esbuild = require('esbuild');
} catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    console.log(`SKIPPED: esbuild unavailable (${String(err.message).split('\n')[0]})`);
    process.exit(0);
}
const bundle = async (rel, name) => {
    const out = join(scratch, name);
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL(`../${rel}`, import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    });
    return import(pathToFileURL(out).href);
};
const { createDropFlash, DROP_FLASH_MS } = await bundle('src/utils/dropFlash.ts', 'dropFlash.mjs');
const { moveChangesPlace } = await bundle('src/utils/dragOrder.ts', 'dragOrder.mjs');

// ── The flash's clock ─────────────────────────────────────────────────────────
console.log('\nthe flash: one start per drop, kept across a remount');
{
    let now = 1000;
    const timers = [];
    const flash = createDropFlash({ now: () => now, schedule: (run, ms) => timers.push({ at: now + ms, run }) });
    const advance = (to) => {
        now = to;
        for (const t of timers.filter(t => t.at <= to).sort((a, b) => a.at - b.at)) {
            timers.splice(timers.indexOf(t), 1);
            t.run();
        }
    };
    let told = 0;
    const off = flash.subscribe(() => told++);

    flash.request('node:5');
    check('a drop starts the moved item\'s flash now', flash.startOf('node:5') === 1000);
    check('and tells the items, so one already on screen picks it up', told === 1, `told ${told}`);
    check('another item is not flashing', flash.startOf('node:6') === undefined);
    check('a mount at the start runs it from the beginning', flash.delayFor(1000) === 0);
    advance(1300);
    check('a mount 300 ms in (a row carried into another card) resumes it 300 ms in', flash.delayFor(flash.startOf('node:5')) === -300);
    check('a re-render reads the same start, so nothing replays', flash.startOf('node:5') === 1000);
    advance(1000 + DROP_FLASH_MS);
    check('it ends after DROP_FLASH_MS', flash.startOf('node:5') === undefined);
    check('and tells the items, so the class comes off', told === 2, `told ${told}`);

    flash.request('node:7');
    advance(now + 400);
    flash.request('node:7');
    const second = flash.startOf('node:7');
    advance(now + DROP_FLASH_MS - 400 + 1);
    check('a second drop of the same item is not cut short by the first one\'s timer', flash.startOf('node:7') === second);
    advance(second + DROP_FLASH_MS);
    check('it ends on its own timer', flash.startOf('node:7') === undefined);

    flash.request('project:3', 250);
    check('a flash asked to wait for a drop animation starts after it', flash.startOf('project:3') === now + 250);
    check('a mount during the wait holds it back by the rest of the wait', flash.delayFor(flash.startOf('project:3')) === 250);
    advance(now + 250 + DROP_FLASH_MS - 1);
    check('the wait does not eat into the flash', flash.startOf('project:3') !== undefined);
    advance(now + 1);
    check('it ends DROP_FLASH_MS after it started', flash.startOf('project:3') === undefined);
    const before = told;
    off();
    flash.request('node:9');
    check('an unsubscribed item is not told', told === before, `told ${told}, was ${before}`);
}

// ── Did the drop move anything ────────────────────────────────────────────────
console.log('\ntree rows: only a drop that changed the order flashes');
{
    const N = (id, parent_id, position, project_id = 7) => ({ id, parent_id, position, project_id, title: `n${id}` });
    // Positions with gaps, as rows get them after deletions: 0, 2, 5.
    const rows = [N(1, null, 0), N(2, null, 1), N(10, 1, 0), N(11, 1, 2), N(12, 1, 5), N(20, 2, 0), N(30, 1, 1, 8)];
    check('the first row dropped back in its slot changes nothing', !moveChangesPlace(rows, 10, 1, 0));
    check('the middle row dropped back in its slot changes nothing', !moveChangesPlace(rows, 11, 1, 1));
    check('the last row dropped back in its slot changes nothing', !moveChangesPlace(rows, 12, 1, 2));
    check('the last row asked for a slot past the end (the server splices it last) changes nothing', !moveChangesPlace(rows, 12, 1, 9));
    check('a row moved down its list changes the order', moveChangesPlace(rows, 10, 1, 2));
    check('a row moved up its list changes the order', moveChangesPlace(rows, 12, 1, 0));
    check('a row moved into another parent changes its place', moveChangesPlace(rows, 11, 2, 0));
    check('a row moved to the top level changes its place', moveChangesPlace(rows, 20, null, 2));
    check('a top-level row dropped back in its slot changes nothing', !moveChangesPlace(rows, 2, null, 1));
    check('a row of another project with the same parent id does not count as a sibling', !moveChangesPlace(rows, 30, 1, 0));
    check('an unknown row changes nothing', !moveChangesPlace(rows, 404, 1, 0));
    // The control: comparing the stored position with the requested one. With
    // gaps in the positions the middle row (stored 2) dropped back asks for
    // index 1, so the naive test would flash a drop that went nowhere.
    const naive = (list, id, parentId, position) => {
        const n = list.find(r => r.id === id);
        return n.parent_id !== parentId || n.position !== position;
    };
    check('control: the naive stored-position test flashes the middle row dropped back in place', naive(rows, 11, 1, 1) === true);
}

// ── Every surface asks for it on its drop path, and only on a real move ──────
console.log('\nthe four drag surfaces: a flash on every drop that moved something, none on one that did not');
const bodyOf = (file, start, end) => {
    const text = src(file);
    const a = text.indexOf(start);
    const b = text.indexOf(end, a + start.length);
    return a > -1 && b > -1 ? text.slice(a, b) : '';
};
const board = bodyOf('src/components/NodeTree.tsx', 'const handleDragEnd', 'const handleDragCancel');
const sidebar = bodyOf('src/components/Sidebar.tsx', 'const handleDragEnd', 'const handleDragCancel');
const grid = bodyOf('src/components/ProjectsGrid.tsx', 'const handleDragEnd', '// Group projects');
check('the three drop handlers were found', board && sidebar && grid);

// The flash call, and the guard that must come before it.
const guarded = (body, guard, call) => {
    const at = body.indexOf(call);
    const g = body.lastIndexOf(guard, at);
    return at > -1 && g > -1 && at - g < 400;
};
const cardPath = board.slice(board.indexOf("if (kind === 'card')"), board.indexOf('settleRowDrop('));
check('board, category card: the flash follows the "nothing moved" return',
    guarded(cardPath, 'if (!next) return;', 'flashAfterDrop(`node:${activeId}`)'));
check('board, category card: and comes before the write', cardPath.indexOf('flashAfterDrop(') < cardPath.indexOf('await reorderNodes('));
const rowPath = board.slice(board.indexOf('settleRowDrop('));
check('board, row: the flash is inside a moveChangesPlace test',
    guarded(rowPath, 'if (moveChangesPlace(useStore.getState().nodes, activeId, placed.parentId, placed.position))', 'flashAfterDrop(`node:${activeId}`)'));
check('board, row: and comes before the write', rowPath.indexOf('flashAfterDrop(') > -1 && rowPath.indexOf('flashAfterDrop(') < rowPath.indexOf('await moveNode('));
check('Navigation list: the flash is inside a moveChangesPlace test',
    guarded(sidebar, 'if (moveChangesPlace(useStore.getState().nodes, currentActiveId, newParentId, position))', 'flashAfterDrop(`node:${currentActiveId}`)'));
check('Navigation list: and comes before the write', sidebar.indexOf('flashAfterDrop(') > -1 && sidebar.indexOf('flashAfterDrop(') < sidebar.indexOf('await moveNode('));
check('Projects grid: the flash follows the "nothing moved" return',
    guarded(grid, 'if (!newOrder) return;', 'flashAfterDrop(`project:${draggedId}`'));
check('Projects grid: it starts after the drop animation the overlay plays',
    grid.includes('flashAfterDrop(`project:${draggedId}`, defaultDropAnimation.duration)'));
check('Projects grid: that overlay plays the default animation, so the wait matches it',
    !/<DragOverlay[^>]*dropAnimation=/.test(src('src/components/ProjectsGrid.tsx')));
for (const [name, file] of [['board', 'src/components/NodeTree.tsx'], ['Navigation list', 'src/components/Sidebar.tsx']]) {
    const text = src(file);
    check(`${name}: no drop animation, so its flash starts at once`,
        /<DragOverlay dropAnimation=\{null\}>/.test(text) && !/flashAfterDrop\([^)]*,/.test(text));
}
check('each surface asks once per path, no more (two on the board, one elsewhere)',
    (board.match(/flashAfterDrop\(/g) ?? []).length === 2
    && (sidebar.match(/flashAfterDrop\(/g) ?? []).length === 1
    && (grid.match(/flashAfterDrop\(/g) ?? []).length === 1);

// ── The items draw it, and never animate their opacity ────────────────────────
console.log('\nthe items: each draws its flash, and no opacity transition can blink it');
const items = [
    ['category card', 'src/components/CategoryCard.tsx', 'useDropFlash(`node:${node.id}`)'],
    ['board row', 'src/components/TreeItemRow.tsx', 'useDropFlash(`node:${node.id}`)'],
    ['Navigation row', 'src/components/Sidebar.tsx', 'useDropFlash(`node:${node.id}`)'],
    ['project card', 'src/components/ProjectCard.tsx', 'useDropFlash(`project:${project.id}`, !isDragOverlay)'],
];
for (const [name, file, call] of items) {
    const text = src(file);
    check(`${name}: reads its flash by what it shows`, text.includes(call));
    // The template literal that carries the class: the element whose
    // background the flash covers.
    const at = text.indexOf("${flash?.className ?? ''}");
    const open = text.lastIndexOf('className={`', at);
    const close = text.indexOf('`}', at);
    const classes = at > -1 && open > -1 ? text.slice(open, close) : '';
    check(`${name}: puts the class on an element`, classes !== '');
    check(`${name}: that element animates no opacity (a bare \`transition\`, \`transition-opacity\` or \`transition-all\`)`,
        classes !== '' && !/\btransition(?![-\w])|transition-opacity|transition-all/.test(classes), classes.slice(0, 120));
    check(`${name}: and carries the flash's start in its style`, /\.\.\.flash\?\.style/.test(text));
}
check('the project card overlay is not the item, so it never flashes', src('src/components/ProjectCard.tsx').includes('!isDragOverlay)'));

// ── The stylesheet ────────────────────────────────────────────────────────────
console.log('\nthe stylesheet: a background fade, 700 ms on Atlassian\'s curve, kept under reduced motion');
const css = src('src/index.css');
const ruleOf = (selector) => {
    const at = css.indexOf(`${selector} {`);
    return at > -1 ? css.slice(at, css.indexOf('}', at) + 1) : '';
};
const keyframesAt = css.indexOf('@keyframes drop-flash');
const keyframes = keyframesAt > -1 ? css.slice(keyframesAt, css.indexOf('\n}', keyframesAt) + 2) : '';
const props = [...keyframes.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]);
check('the keyframes exist', keyframes !== '');
check('they animate background-color and nothing else (no opacity, no transform)',
    props.length > 0 && props.every(p => p === 'background-color'), props.join(', '));
const after = ruleOf('.drop-flash::after');
check('the flash is a layer over the item that takes no pointer', /pointer-events:\s*none/.test(after) && /position:\s*absolute/.test(after) && /inset:\s*0/.test(after));
check('it follows the item\'s corners', /border-radius:\s*inherit/.test(after));
check(`it runs DROP_FLASH_MS (${DROP_FLASH_MS} ms) on cubic-bezier(0.25, 0.1, 0.25, 1)`,
    new RegExp(`animation:\\s*drop-flash ${DROP_FLASH_MS}ms cubic-bezier\\(0\\.25, 0\\.1, 0\\.25, 1\\)`).test(after), after);
check('it starts at the delay the item computed, holding its first colour while it waits',
    /var\(--drop-flash-delay, 0ms\) backwards/.test(after));
const host = ruleOf('.drop-flash');
check('the item itself gets no opacity, transform or transition from it', host !== '' && !/opacity|transform|transition/.test(host));
check('the colour is the accent, lighter in dark mode', /--accent-rgb/.test(host) && /--accent-fg-rgb/.test(ruleOf('.dark .drop-flash')));
const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)].map(m => m[0]).join('\n');
check('reduced motion keeps it (nothing moves, and it is the only sign of where the item went)',
    reduced !== '' && !/drop-flash/.test(reduced));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
