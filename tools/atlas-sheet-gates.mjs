// The phone's atlas sheet under a finger (src/components/atlas/sheetGesture.ts):
// which finger drives it, what a tap is, where a release settles, and what a
// cancelled drag leaves behind.
//
//   node tools/atlas-sheet-gates.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleTs } from './lib/bundleTs.mjs';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

const scratch = mkdtempSync(join(tmpdir(), 'atlas-sheet-'));
const mod = await bundleTs('src/components/atlas/sheetGesture.ts', scratch, {
    what: 'atlas sheet gesture',
    needs: ['beginSheetDrag', 'moveSheetDrag', 'releaseSheetDrag', 'cancelSheetDrag'],
});
if (!mod) { rmSync(scratch, { recursive: true, force: true }); process.exit(0); }
const { beginSheetDrag, moveSheetDrag, releaseSheetDrag, cancelSheetDrag,
    SHEET_TAP_PX, SHEET_FLING, SHEET_REST_MS, SHEET_OPEN, SHEET_FOLDED_MAX } = mod;

// A phone page box 700px tall; the folded sheet 120px; open it is 62% = 434px.
const BOX = 700, FOLDED = 120, OPEN = BOX * SHEET_OPEN;
const folded = () => beginSheetDrag({ pointerId: 1, y: 600, t: 0, sheetPx: FOLDED, boxPx: BOX, foldedPx: FOLDED, open: false });
const opened = () => beginSheetDrag({ pointerId: 1, y: 300, t: 0, sheetPx: OPEN, boxPx: BOX, foldedPx: FOLDED, open: true });

console.log('\n--- the snap points ---');
{
    const d = folded();
    check('folded: the low snap is the folded height', d.min === FOLDED, String(d.min));
    check('folded: the high snap is the open share of the box', d.max === OPEN, String(d.max));
    const o = opened();
    check('open: the low snap is the height last measured folded', o.min === FOLDED, String(o.min));
    const tall = beginSheetDrag({ pointerId: 1, y: 300, t: 0, sheetPx: 500, boxPx: BOX, foldedPx: 500, open: false });
    check('a folded sheet taller than its cap snaps down to the cap', tall.min === BOX * SHEET_FOLDED_MAX, String(tall.min));
}

console.log('\n--- a tap is a tap ---');
{
    const d = folded();
    check('a move inside the slop draws nothing', moveSheetDrag(d, 1, 600 - (SHEET_TAP_PX - 1), 10) === null);
    check('...and letting go there is a tap (the click toggles)', releaseSheetDrag(d, 1, 600 - (SHEET_TAP_PX - 1), 20).kind === 'tap');
}

console.log('\n--- one finger drives it ---');
{
    const d = folded();
    check('a second finger’s move is ignored', moveSheetDrag(d, 2, 300, 10) === null && !d.moved);
    check('a second finger lifting is not this drag’s release', releaseSheetDrag(d, 2, 300, 20).kind === 'other');
    check('the first finger still drives it', moveSheetDrag(d, 1, 580, 30) != null);
}

console.log('\n--- the drag takes hold without a jump ---');
{
    const d = folded();
    const first = moveSheetDrag(d, 1, 600 - SHEET_TAP_PX, 16);
    check('leaving the slop draws the sheet at the height it had, not 6px taller', first === FOLDED, String(first));
    const next = moveSheetDrag(d, 1, 600 - SHEET_TAP_PX - 40, 32);
    check('...and from there it follows the finger', next === FOLDED + 40, String(next));
    const far = moveSheetDrag(d, 1, -500, 48);
    check('it never goes past the open snap', far === OPEN, String(far));
}

console.log('\n--- where a release settles ---');
{
    // Slow drag up past halfway: the nearer snap is open.
    let d = folded();
    moveSheetDrag(d, 1, 594, 0);
    moveSheetDrag(d, 1, 594 - 200, 1000);
    let r = releaseSheetDrag(d, 1, 594 - 200, 1010);
    check('a slow drag past halfway opens', r.kind === 'settle' && r.open && r.px === OPEN, JSON.stringify(r));
    // Slow drag up short of halfway: back to folded.
    d = folded();
    moveSheetDrag(d, 1, 594, 0);
    moveSheetDrag(d, 1, 594 - 60, 1000);
    r = releaseSheetDrag(d, 1, 594 - 60, 1010);
    check('a slow drag short of halfway folds back', r.kind === 'settle' && !r.open && r.px === FOLDED, JSON.stringify(r));
    // A fast flick up, short of halfway: goes the way it was flung.
    d = folded();
    moveSheetDrag(d, 1, 594, 0);
    moveSheetDrag(d, 1, 574, 10);
    moveSheetDrag(d, 1, 554, 20);
    r = releaseSheetDrag(d, 1, 554, 25);
    check(`a flick faster than ${SHEET_FLING}px/ms opens however little it moved`, r.kind === 'settle' && r.open, JSON.stringify(r));
    // The same flick, but the finger rested before letting go.
    d = folded();
    moveSheetDrag(d, 1, 594, 0);
    moveSheetDrag(d, 1, 574, 10);
    moveSheetDrag(d, 1, 554, 20);
    r = releaseSheetDrag(d, 1, 554, 20 + SHEET_REST_MS + 1);
    check('a finger that rested before letting go flung nothing', r.kind === 'settle' && !r.open, JSON.stringify(r));
    // A flick down from open.
    d = opened();
    moveSheetDrag(d, 1, 306, 0);
    moveSheetDrag(d, 1, 326, 10);
    moveSheetDrag(d, 1, 346, 20);
    r = releaseSheetDrag(d, 1, 346, 25);
    check('a flick down from open folds', r.kind === 'settle' && !r.open && r.px === FOLDED, JSON.stringify(r));
}

console.log('\n--- a cancelled drag ---');
{
    let d = folded();
    moveSheetDrag(d, 1, 594, 0);
    moveSheetDrag(d, 1, 400, 100);
    let c = cancelSheetDrag(d);
    check('a cancel mid-drag goes back to where it started (folded)', !c.open && c.px === FOLDED, JSON.stringify(c));
    d = opened();
    moveSheetDrag(d, 1, 306, 0);
    moveSheetDrag(d, 1, 500, 100);
    c = cancelSheetDrag(d);
    check('...and from open, back to open', c.open && c.px === OPEN, JSON.stringify(c));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
