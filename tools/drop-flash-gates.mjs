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
// went. Each surface now asks for one ring in the accent around the moved
// item's rounded edge, swelling in and ebbing away. What can go wrong, each
// checked below:
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
//   - the ring fills or covers the item, is clipped at its edge, changes
//     width, vanishes on the dark panel for a slate project, or on a
//     Navigation course row tinted in its own colour;
//   - a refused move keeps flashing where it never went, or ends the flash
//     of another item that did land;
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
const { moveChangesPlace, createNodeWriter } = await bundle('src/utils/dragOrder.ts', 'dragOrder.mjs');
const { accentVars, accentTextSurface } = await bundle('src/utils/accentVars.ts', 'accentVars.mjs');
const { themeRamp } = await bundle('src/utils/themeRamp.ts', 'themeRamp.mjs');

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
    // shows when the overlay lands ~250 ms later. Both read one start, so the
    // arithmetic is the whole hand-off.
    flash.request('project:3');
    const overlayDelay = flash.delayFor(flash.startOf('project:3'));
    advance(now + 250);
    const cardDelay = flash.delayFor(flash.startOf('project:3'));
    check('grid, arithmetic: an element mounted at the drop (the overlay) runs the flash from 0', overlayDelay === 0);
    check('grid, arithmetic: one mounted 250 ms later (the card) resumes it at -250 ms', cardDelay === -250, `delay ${cardDelay}`);
    // Picked up again while it still flashes: the class must come off for the
    // drag, or the next drop's request only shifts the running animation's
    // delay (same animation name, so CSS does not restart it).
    flash.request('node:8');
    const first = flash.startOf('node:8');
    let t = told;
    flash.end('node:8');
    check('picking an item up again ends its flash', flash.startOf('node:8') === undefined);
    check('and tells the items, so the class comes off during the drag', told === t + 1);
    t = told;
    flash.end('node:8');
    check('ending an item that is not flashing tells nobody', told === t);
    advance(4000);
    flash.request('node:8');
    const again = flash.startOf('node:8');
    check('the next drop starts a fresh flash, stamped with its own time', again === 4000 && again !== first, `${again} vs ${first}`);
    // The first request's timer is still queued: it must not end the second.
    advance(first + DROP_FLASH_MS);
    check('the ended flash\'s timer does not end the one that replaced it', flash.startOf('node:8') === again);
    advance(again + DROP_FLASH_MS);
    check('which ends on its own timer', flash.startOf('node:8') === undefined);

    // A refusal names the flash it ends: the start its drop was given. It can
    // arrive after a slow queue, when the same item has been dropped again.
    advance(5000);
    const refusedAt = flash.request('node:4');
    check('a request returns the start it stamped', refusedAt === 5000 && flash.startOf('node:4') === refusedAt);
    t = told;
    flash.endIf('node:4', refusedAt);
    check('a refusal of the drop still flashing ends it', flash.startOf('node:4') === undefined);
    check('and tells the items', told === t + 1);
    const stale = flash.request('node:4');
    advance(now + 200);
    flash.end('node:4');
    const newer = flash.request('node:4');
    t = told;
    flash.endIf('node:4', stale);
    check('a late refusal of an earlier drop leaves the newer drop\'s flash alone', flash.startOf('node:4') === newer && newer !== stale);
    check('and tells nobody', told === t);
    flash.endIf('node:4', undefined);
    check('a refusal of a drop that never flashed ends nothing', flash.startOf('node:4') === newer);

    // A coarse clock (a browser that rounds `performance.now()`) can give two
    // drops of one item the same instant. Each must still get a start of its
    // own, or a refusal of the first ends the second.
    advance(6000);
    const coarseA = flash.request('node:12');
    flash.end('node:12');
    const coarseB = flash.request('node:12');
    check('a drop in the same clock tick as an ended one gets a start of its own, a millisecond on', coarseA === 6000 && coarseB === 6001, `${coarseA}, ${coarseB}`);
    flash.endIf('node:12', coarseA);
    check('so a refusal of the ended drop leaves the new flash', flash.startOf('node:12') === coarseB);
    advance(6900);

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

// ── A refused move ends that move's flash, and only that one ─────────────────
console.log('\na refused tree move: its own refusal runs, before the toast; a saved one runs none');
{
    const said = [];
    const write = createNodeWriter({
        getNodes: () => [], show: () => {}, fetch: async () => [],
        fail: (message) => said.push(`toast:${message}`),
    });
    const refused = write([], async () => { throw new Error('409'); }, 'Failed to move item', () => said.push('end:node:5'));
    const saved = write([], async () => {}, 'Failed to move item', () => said.push('end:node:6'));
    await Promise.all([refused, saved]);
    check('the refused move\'s refusal runs, then its toast', said.join(' ') === 'end:node:5 toast:Failed to move item', said.join(' '));
    check('the move saved after it in the same burst keeps its flash', !said.includes('end:node:6'));
    const plain = createNodeWriter({ getNodes: () => [], show: () => {}, fetch: async () => [], fail: () => said.push('toast') });
    await plain([], async () => { throw new Error('500'); }, 'x');
    check('a write with no refusal still says it failed', said.at(-1) === 'toast');
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
check('Projects grid: and comes before the write', grid.indexOf('flashAfterDrop(') > -1 && grid.indexOf('flashAfterDrop(') < grid.indexOf('await api.'));
// Refused: the write fails and THAT item goes back, so its flash ends. Only
// its own: another item dropped a moment earlier did land, and keeps its flash.
const store = src('src/store.ts');
const between = (text, start, end) => { const a = text.indexOf(start); return a > -1 ? text.slice(a, text.indexOf(end, a + start.length)) : ''; };
const moveNodeBody = between(store, 'moveNode: async', '\n    },');
const reorderBody = between(store, 'reorderNodes: async', '\n    },');
// The start is read before the first await: the drop asked for it a moment
// earlier, and by the time a slow write is refused the item may have been
// dropped again.
const readsStartFirst = (body, key) => {
    const at = body.indexOf(`dropFlashStart(\`${key}\`)`);
    return at > -1 && at < body.indexOf('await ');
};
check('tree moves: moveNode reads its drop\'s flash before the write', readsStartFirst(moveNodeBody, 'node:${id}'), moveNodeBody.slice(0, 160));
check('tree moves: and its refusal ends that flash only', /endDropFlashIf\(`node:\$\{id\}`, flash\)/.test(moveNodeBody), moveNodeBody.slice(0, 160));
check('tree moves: reorderNodes reads the dragged item\'s flash before the write', readsStartFirst(reorderBody, 'node:${movedId}'), reorderBody.slice(0, 160));
check('tree moves: and its refusal ends that flash only, not every reordered item\'s',
    /endDropFlashIf\(`node:\$\{movedId\}`, flash\)/.test(reorderBody) && !/nodeIds\.(forEach|map)/.test(reorderBody.slice(reorderBody.indexOf('await '))), reorderBody.slice(0, 160));
check('board, category card: the reorder names the card that was dragged', cardPath.includes('await reorderNodes(next, null, activeId);'));
check('tree moves: no refusal ends every flash', !/clearDropFlashes|dropFlash\.clear|endDropFlash\(/.test(store));
const gridCatch = grid.slice(grid.indexOf('} catch'));
check('Projects grid: the drop keeps the start its flash was given', grid.includes('const flash = flashAfterDrop(`project:${draggedId}`);'));
check('Projects grid: a refused write ends that flash only, first',
    /^\} catch[^{]*\{\s*(\/\/[^\n]*\n\s*)*endDropFlashIf\(`project:\$\{draggedId\}`, flash\);/.test(gridCatch), gridCatch.slice(0, 120));
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
    // No overlay exception: the overlay is the card on screen until it lands.
    ['project card', 'src/components/ProjectCard.tsx', 'useDropFlash(`project:${project.id}`)'],
];
for (const [name, file, call] of items) {
    const text = src(file);
    check(`${name}: reads its flash by what it shows`, text.includes(call));
    // The template literal that carries the class: the element whose edge
    // the ring traces.
    const at = text.indexOf("${flash?.className ?? ''}");
    const open = text.lastIndexOf('className={`', at);
    const close = text.indexOf('`}', at);
    const classes = at > -1 && open > -1 ? text.slice(open, close) : '';
    check(`${name}: puts the class on an element`, classes !== '');
    check(`${name}: that element animates no opacity (a bare \`transition\`, \`transition-opacity\` or \`transition-all\`)`,
        classes !== '' && !/\btransition(?![-\w])|transition-opacity|transition-all/.test(classes), classes.slice(0, 120));
    check(`${name}: and carries the flash's start in its style`, /\.\.\.flash\?\.style/.test(text));
    // The ring follows the element's corners (`border-radius: inherit`), so
    // the element must have some.
    // A bare class, not one behind a variant (`hover:rounded-lg`).
    check(`${name}: that element has rounded corners for the ring to trace`,
        classes.split(/[\s`'"{}$]+/).some(c => /^rounded-(md|lg|xl|2xl|3xl|\[[^\]]+\])$/.test(c)), classes.slice(0, 120));
}

// ── The stylesheet ────────────────────────────────────────────────────────────
console.log('\nthe stylesheet: a ring inside the edge that swells in and ebbs away, kept under reduced motion');
const css = src('src/index.css');
const ruleOf = (selector) => {
    const at = css.indexOf(`${selector} {`);
    return at > -1 ? css.slice(at, css.indexOf('}', at) + 1) : '';
};
const keyframesAt = css.indexOf('@keyframes drop-flash');
const keyframes = keyframesAt > -1 ? css.slice(keyframesAt, css.indexOf('\n}', keyframesAt) + 2) : '';
const props = [...keyframes.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]);
check('the keyframes exist', keyframes !== '');
check('they animate the ring (box-shadow) and nothing else (no fill, no opacity, no transform)',
    props.length > 0 && props.every(p => p === 'box-shadow'), props.join(', '));
// Each frame: the same 2px ring drawn INSIDE the edge, only its alpha moving.
// An outer ring would be clipped by a scrolling list and overlap neighbours;
// a ring that changed width would look like the item twitching.
const frames = [...keyframes.matchAll(/(\d+)%\s*\{\s*box-shadow:\s*([^;]+);/g)].map(m => ({ at: Number(m[1]), shadow: m[2].trim() }));
const ringAlpha = (s) => { const m = s.match(/^inset 0 0 0 2px color-mix\(in srgb, var\(--drop-flash-color\) ([\d.]+)%, transparent\)$/); return m ? Number(m[1]) / 100 : NaN; };
check('every frame is the same 2px ring inside the edge, in the flash colour', frames.length >= 3 && frames.every(f => !Number.isNaN(ringAlpha(f.shadow))), frames.map(f => f.shadow).join(' | '));
const peakFrame = frames.reduce((a, f) => (ringAlpha(f.shadow) > ringAlpha(a.shadow) ? f : a), frames[0] ?? { at: NaN, shadow: '' });
const PEAK_ALPHA = ringAlpha(peakFrame.shadow);
check('it swells in from nothing and ebbs away to nothing', frames[0]?.at === 0 && ringAlpha(frames[0].shadow) === 0 && frames.at(-1)?.at === 100 && ringAlpha(frames.at(-1).shadow) === 0);
check(`it peaks early, while the eye is still on the drop (at ${peakFrame.at}% of the run, ${Math.round(peakFrame.at * DROP_FLASH_MS / 100)} ms)`, peakFrame.at > 0 && peakFrame.at * DROP_FLASH_MS / 100 <= 300);
check(`and the peak is nearly solid (${PEAK_ALPHA})`, PEAK_ALPHA >= 0.8 && PEAK_ALPHA <= 1);
const after = ruleOf('.drop-flash::after');
check('the layer exists (a pseudo-element without `content` is never drawn)', /content:\s*''\s*;/.test(after), after);
check('it is a layer exactly over the item that takes no pointer (no offset in or out, nothing sinks it under the item)',
    /pointer-events:\s*none/.test(after) && /position:\s*absolute/.test(after) && /inset:\s*0\s*;/.test(after) && !/z-index/.test(after));
check('it follows the item\'s corners', /border-radius:\s*inherit/.test(after));
check('the layer covers nothing: no fill, no blend', !/background|mix-blend-mode/.test(after));
check(`it runs once, DROP_FLASH_MS (${DROP_FLASH_MS} ms), easing in and out, from the delay the item computed, holding its first colour while it waits`,
    new RegExp(`animation:\\s*drop-flash ${DROP_FLASH_MS}ms ease-in-out var\\(--drop-flash-delay, 0ms\\) backwards;`).test(after), after);
// The host gets a containing block for its layer and the colour, nothing else:
// no opacity, transform or transition (a blink or a move), no margin, padding,
// border or size (a jump), no overflow (CategoryCard's drop bars sit outside
// its edge).
const declsOf = (rule) => rule.replace(/\/\*[\s\S]*?\*\//g, '').slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'))
    .split(';').map(d => d.trim()).filter(Boolean).map(d => d.slice(0, d.indexOf(':')).trim());
const host = ruleOf('\n.drop-flash');
const hostDecls = declsOf(host);
check('the item itself gets a containing block and the ring colour from it, nothing else',
    host !== '' && hostDecls.join(',') === 'position,--drop-flash-color' && /position:\s*relative/.test(host), hostDecls.join(', '));
check('the dark rule sets the ring colour and nothing else', declsOf(ruleOf('.dark .drop-flash')).join(',') === '--drop-flash-color');
// The colour. Light mode draws the solid accent (darkened until white text
// clears AA) a step darker again: a Navigation course row is tinted in its own
// colour, 30% when selected, and the plain accent stood off it at 2.7:1. Dark
// mode cannot use the solid accent: it is kept dark for white labels, and a
// slate project colour vanished on the dark panel (1.37:1 measured in an
// earlier fill). It draws the accent TEXT colour, derived against that
// surface. The ring at its peak is laid over the card and over each row tint,
// for every palette colour on every theme tint, and must clear WCAG's 3:1 for
// a non-text mark.
const ringOf = (selector) => {
    const v = (ruleOf(selector).match(/--drop-flash-color:\s*([^;]+);/) ?? [])[1]?.trim() ?? '';
    const mixed = v.match(/^color-mix\(in srgb, rgb\(var\((--[a-z-]+)\)\) ([\d.]+)%, black\)$/);
    if (mixed) return { varName: mixed[1], share: Number(mixed[2]) / 100, text: v };
    const plain = v.match(/^rgb\(var\((--[a-z-]+)\)\)$/);
    return plain ? { varName: plain[1], share: 1, text: v } : { varName: undefined, share: NaN, text: v };
};
const lightRing = ringOf('\n.drop-flash');
const darkRing = ringOf('.dark .drop-flash');
check('light: the ring is the solid accent, a step darker', lightRing.varName === '--accent-rgb' && lightRing.share < 1 && lightRing.share >= 0.7, lightRing.text);
check('dark: the ring is the accent text colour', darkRing.varName === '--accent-fg-rgb' && darkRing.share === 1, darkRing.text);
const PROJECT_COLORS = [...src('src/components/ui/ColorField.tsx').match(/export const PROJECT_COLORS = \[([\s\S]*?)\];/)[1].matchAll(/'(#[0-9a-fA-F]{6})'/g)].map(m => m[1]);
const THEME_TINTS = [...src('src/components/ui/ColorField.tsx').match(/export const THEME_TINTS = \[([\s\S]*?)\];/)[1].matchAll(/'(#[0-9a-fA-F]{6})'/g)].map(m => m[1]);
const tri = (s) => s.split(' ').map(Number);
const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (base, top, alpha) => base.map((b, i) => b * (1 - alpha) + top[i] * alpha);
// What a ringed item can be drawn on: the card surface, and the rows that tint
// it in their own colour: a selected row (`bg-accent/20`), and a Navigation
// course row (`Sidebar.tsx`, the project colour at 0.15, 0.3 when selected).
const ROW_FILLS = [
    ['the card', () => null],
    ['a selected row', (color, vars) => [tri(vars['--accent-rgb']), 0.2]],
    ['a course row', (color) => [hex(color), 0.15]],
    ['a selected course row', (color) => [hex(color), 0.3]],
];
// A finished or archived project's card sits in a section dimmed as a whole
// (`ProjectsGrid.tsx`), so card and ring both reach the eye mixed with the
// page under the section. Hover lifts the dimming, but the pointer leaves, and
// a touch drop never hovers.
const gridPage = src('src/components/ProjectsGrid.tsx');
const dimmed = gridPage.match(/\bopacity-(\d+) hover:opacity-100\b/);
const page = gridPage.match(/"h-full overflow-auto p-8 bg-slate-(\d+) dark:bg-slate-(\d+)\b/);
const pageRung = (mode) => page?.[mode === 'dark' ? 2 : 1];
check('the dimmed Projects grid sections and their page are where the contrast model reads them',
    !!dimmed && ['light', 'dark'].every((mode) => themeRamp(mode, null)[pageRung(mode)] !== undefined), page?.[0] ?? 'no page class');
const DIM = dimmed ? Number(dimmed[1]) / 100 : 1;
// The ring at its peak alpha, composited over each of those (plain alpha
// compositing), against it. `color-mix(in srgb, c share%, black)` scales the
// encoded channels by `share`.
const ringOff = (mode, { varName, share }, alpha) => {
    let worst = { min: Infinity, at: '' };
    const note = (r, at) => { if (r < worst.min) worst = { min: r, at }; };
    for (const tint of [null, ...THEME_TINTS]) {
        const surface = hex(accentTextSurface(mode, tint));
        const canvasHex = themeRamp(mode, tint)[pageRung(mode)];
        const canvas = canvasHex ? hex(canvasHex) : surface;
        for (const color of PROJECT_COLORS) {
            const vars = accentVars(color, mode, tint);
            const c = tri(vars[varName]).map(v => v * share);
            for (const [where, fill] of ROW_FILLS) {
                const f = fill(color, vars);
                const under = f ? over(surface, f[0], f[1]) : surface;
                note(ratio(over(under, c, alpha), under), `${color} on ${where}, tint ${tint ?? 'none'}`);
            }
            note(ratio(over(canvas, over(surface, c, alpha), DIM), over(canvas, surface, DIM)),
                `${color} on a dimmed project card, tint ${tint ?? 'none'}`);
        }
    }
    return worst;
};
check(`the matrix covers the palette and the tints (${PROJECT_COLORS.length} colours × ${THEME_TINTS.length + 1} tints)`, PROJECT_COLORS.length >= 15 && THEME_TINTS.length >= 15);
const RING_FLOOR = 3;
for (const [mode, ring] of [['light', lightRing], ['dark', darkRing]]) {
    const w = ringOff(mode, ring, PEAK_ALPHA);
    check(`${mode}: the ring at its peak stands off the card and every row tint for every palette colour (worst ${w.min.toFixed(2)}:1, ${w.at}; floor ${RING_FLOOR})`, w.min >= RING_FLOOR);
}
// The controls: the plain solid accent as the light ring, which a selected
// course row's own tint swallows, and the solid accent as the dark ring, which
// a slate project colour loses on the dark panel.
const lightPlain = ringOff('light', { varName: '--accent-rgb', share: 1 }, PEAK_ALPHA);
check(`control: the plain solid accent as the light ring fails the floor (worst ${lightPlain.min.toFixed(2)}:1, ${lightPlain.at})`, lightPlain.min < RING_FLOOR);
const darkSolid = ringOff('dark', { varName: '--accent-rgb', share: 1 }, PEAK_ALPHA);
check(`control: the solid accent as the dark ring fails the floor (worst ${darkSolid.min.toFixed(2)}:1, ${darkSolid.at})`, darkSolid.min < RING_FLOOR);
const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)].map(m => m[0]).join('\n');
// A rule stops the flash when it sets an animation and its selector can reach
// the layer: one naming the flash, or a bare `::after` / `*::after` subject.
// A plain `*` or `.x > *` selects elements, never a pseudo-element.
const stopsTheLayer = (block) => [...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , decls]) => /(^|[;\s])animation(-name)?\s*:/.test(decls))
    .some(([, selectors]) => selectors.split(',').some((sel) => {
        if (/drop-flash/.test(sel)) return true;
        const subject = sel.trim().split(/\s*[>+~]\s*|\s+/).pop();
        return /::?after$/.test(subject) && ['', '*'].includes(subject.replace(/::?after$/, ''));
    }));
check('reduced motion keeps it (nothing moves, and it is the only sign of where the item went)',
    reduced !== '' && !reduced.split(/(?=@media)/).some((m) => stopsTheLayer(m.replace(/^@media[^{]*\{/, ''))));
check('control: a blanket reduced-motion rule over every ::after would stop it', stopsTheLayer('*, ::after { animation: none !important; }'));
check('control: one naming the flash would stop it', stopsTheLayer('.drop-flash::after { animation: none; }'));
check('control: an element rule (`.x > *`) cannot reach a pseudo-element', !stopsTheLayer('.visual-block-stage.vk-dissolve > * { animation: none; }'));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
