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
//   - the Projects grid card sits unlit after its overlay lands and then
//     lights up as a second event (the overlay flies home already lit, and the
//     card, hidden until it lands, carries the same flash on);
//   - a whole card tinted as hard as a row, or a dark flash that reads as
//     the hover grey;
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

    // The Projects grid: the overlay is on screen from the drop, the card
    // shows when the overlay lands ~250 ms later. Both read one start.
    flash.request('project:3');
    const overlayDelay = flash.delayFor(flash.startOf('project:3'));
    advance(now + 250);
    const cardDelay = flash.delayFor(flash.startOf('project:3'));
    check('grid: the overlay flying home starts the flash at the drop', overlayDelay === 0);
    check('grid: the card it lands on carries it on 250 ms in, not from the start', cardDelay === -250, `delay ${cardDelay}`);
    // Picked up again while it still flashes: the class must come off for the
    // drag, or the next drop's request only shifts the running animation's
    // delay (same animation name, so CSS does not restart it).
    flash.request('node:8');
    let t = told;
    flash.end('node:8');
    check('picking an item up again ends its flash', flash.startOf('node:8') === undefined);
    check('and tells the items, so the class comes off during the drag', told === t + 1);
    t = told;
    flash.end('node:8');
    check('ending an item that is not flashing tells nobody', told === t);
    flash.request('node:8');
    const again = flash.startOf('node:8');
    check('the next drop starts a fresh flash', again === now);

    // A refused move goes back, so no flash may keep pointing where it went.
    flash.request('node:21');
    t = told;
    flash.clear();
    check('a refused move ends every flash', flash.startOf('node:21') === undefined && flash.startOf('node:8') === undefined);
    check('with one notice', told === t + 1);
    t = told;
    flash.clear();
    check('clearing nothing tells nobody', told === t);
    advance(now + DROP_FLASH_MS);
    check('an ended flash\'s timer does not touch a later one', (() => { flash.request('node:8'); const s = flash.startOf('node:8'); advance(now + 1); return flash.startOf('node:8') === s; })());

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

// The flash call, and the guard that must come before it. An `if (` guard must
// still be open at the call: no `}` between them, so the call is in its block.
const guarded = (body, guard, call) => {
    const at = body.indexOf(call);
    const g = body.lastIndexOf(guard, at);
    if (at < 0 || g < 0 || at - g > 400) return false;
    return !guard.startsWith('if (moveChangesPlace') || !body.slice(g + guard.length, at).includes('}');
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
check('Projects grid: it starts at the drop, while the overlay is still flying home',
    grid.includes('flashAfterDrop(`project:${draggedId}`);'));
for (const [name, file] of [['board', 'src/components/NodeTree.tsx'], ['Navigation list', 'src/components/Sidebar.tsx']]) {
    check(`${name}: no drop animation, so the item it flashes is on screen at once`,
        /<DragOverlay dropAnimation=\{null\}>/.test(src(file)));
}
// Picked up again: each drag start ends that item's running flash.
const starts = [
    ['board', bodyOf('src/components/NodeTree.tsx', 'const handleDragStart', '};'), 'endDropFlash(`node:${id}`)'],
    ['Navigation list', bodyOf('src/components/Sidebar.tsx', 'const handleDragStart', '};'), 'endDropFlash(`node:${id}`)'],
    ['Projects grid', bodyOf('src/components/ProjectsGrid.tsx', 'const handleDragStart', '};'), 'endDropFlash(`project:${event.active.id}`)'],
];
for (const [name, body, call] of starts) check(`${name}: a drag start ends the item's running flash`, body.includes(call), body.slice(0, 80));
// Refused: the write fails and the item goes back, so the flashes end.
const store = src('src/store.ts');
const failAt = store.indexOf('fail: (message, e) =>');
check('tree moves: a refused write ends the flashes before its toast',
    failAt > -1 && store.indexOf('clearDropFlashes()', failAt) > -1 && store.indexOf('clearDropFlashes()', failAt) < store.indexOf("addToast('error', message", failAt));
const gridCatch = grid.slice(grid.indexOf('} catch'));
check('Projects grid: a refused write ends the flashes', /^\} catch[^{]*\{\s*clearDropFlashes\(\);/.test(gridCatch), gridCatch.slice(0, 80));
check('each surface asks once per path, no more (two on the board, one elsewhere)',
    (board.match(/flashAfterDrop\(/g) ?? []).length === 2
    && (sidebar.match(/flashAfterDrop\(/g) ?? []).length === 1
    && (grid.match(/flashAfterDrop\(/g) ?? []).length === 1);

// ── The items draw it, and never animate their opacity ────────────────────────
console.log('\nthe items: each draws its flash, and no opacity transition can blink it');
const items = [
    ['category card', 'src/components/CategoryCard.tsx', 'useDropFlash(`node:${node.id}`, { wide: true })'],
    ['board row', 'src/components/TreeItemRow.tsx', 'useDropFlash(`node:${node.id}`)'],
    ['Navigation row', 'src/components/Sidebar.tsx', 'useDropFlash(`node:${node.id}`)'],
    // No overlay exception: the overlay is the card on screen until it lands.
    ['project card', 'src/components/ProjectCard.tsx', 'useDropFlash(`project:${project.id}`, { wide: true })'],
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
check('the item holds its layer: a containing block, or the layer covers some ancestor instead', /position:\s*relative/.test(host));
// The strength: a whole card is many rows' area, so it takes less than a row;
// dark mode needs more of the accent than light, or the flash reads as the
// hover grey (both seen on frame sheets at 0.3 / 0.32 of the accent text colour).
const alphaOf = (selector) => {
    const m = ruleOf(selector).match(/--drop-flash-color:\s*rgb\(var\(--accent-rgb\) \/ ([\d.]+)\)/);
    return m ? Number(m[1]) : NaN;
};
const [row, wide, darkRow, darkWide] = ['.drop-flash', '.drop-flash-wide', '.dark .drop-flash', '.dark .drop-flash-wide'].map(alphaOf);
check('every strength is the solid accent', [row, wide, darkRow, darkWide].every(a => a > 0 && a < 1), `${row}, ${wide}, ${darkRow}, ${darkWide}`);
check('a whole card takes a lighter tint than a row, in both themes', wide < row && darkWide < darkRow);
check('dark takes more of the accent than light, for rows and cards', darkRow > row && darkWide > wide);
check('each card-wide rule comes after its row rule, so it wins at equal specificity',
    css.indexOf('.drop-flash-wide {') > css.indexOf('.drop-flash {') && css.indexOf('.dark .drop-flash-wide {') > css.indexOf('.dark .drop-flash {'));
const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)].map(m => m[0]).join('\n');
check('reduced motion keeps it (nothing moves, and it is the only sign of where the item went)',
    reduced !== '' && !/drop-flash/.test(reduced));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
