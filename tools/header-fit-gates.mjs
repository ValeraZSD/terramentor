// tools/header-fit-gates.mjs — the top bar never cuts a tab.
//
// Run:  node tools/header-fit-gates.mjs
//
// WHY. The header is as wide as the page column, and the assistant docks
// beside it at a width the learner drags, so a 1280px window left a 760px
// header whose scrolling tab rail drew "Schedul" and hid Atlas. `fitHeader`
// (src/utils/headerFit.ts) now gives things up in order — the centring, the
// search's words, then tabs into a "More" menu — and this drives it with the
// widths measured in Edge (English, 100% text, mouse) across every header
// width from a phone to a wide screen, in both directions of the active tab.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'header-fit-gates-'));
const outfile = join(scratch, 'headerFit.mjs');
await esbuild.build({ entryPoints: [join(repoRoot, 'src/utils/headerFit.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
const { fitHeader } = await import(pathToFileURL(outfile).href);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

// Measured 2026-10-13, Edge, English, the three icons without their words:
// Today, Projects, Calendar, Schedule, Atlas. 320px is the narrowest phone.
const TABS = [57.6, 70.4, 76.2, 77.5, 51.2];
const base = { gap: 8, search: 159, searchIcon: 40, right: 124, tabs: TABS, tabGap: 4, more: 73.8 };
const at = (header, active = 0) => fitHeader({ ...base, inner: header - 32 }, active);
const railWidth = (f) => f.shown.reduce((s, i) => s + TABS[i], 0) + base.tabGap * Math.max(0, f.shown.length - 1)
    + (f.shown.length < TABS.length ? (f.shown.length ? base.tabGap : 0) + base.more : 0);
const roomFor = (header, f) => {
    const inner = header - 32, search = f.searchIcon ? base.searchIcon : base.search;
    return f.centred ? (inner - search - 2 * base.gap) / 2 : inner - search - base.right - 2 * base.gap;
};

console.log('\n--- the widths the review hit ---');
let f = at(760);
check('1280px window, assistant open (760px header): all five tabs, whole', f.shown.length === 5, JSON.stringify(f));
check('…by giving the rail the icons\' spare room, the search keeping its words', !f.centred && !f.searchIcon);
f = at(1280);
check('no assistant (1280px header): centred search, all five tabs', f.centred && !f.searchIcon && f.shown.length === 5, JSON.stringify(f));
f = at(1400);
check('1920px window, assistant open: centred, all five', f.centred && f.shown.length === 5);
f = at(410);
check('1024px window, assistant at its widest (410px): the search is its icon and the rest go in More', f.searchIcon && f.shown.length >= 1 && f.shown.length < 5, JSON.stringify(f));
f = at(410, 4);
check('…and on Atlas, Atlas stays in the rail', f.shown.includes(4), JSON.stringify(f));

console.log('\n--- every width, every tab ---');
let overflow = [], lostActive = [], order = [];
for (let w = 320; w <= 2200; w += 2) {
    for (let a = 0; a < TABS.length; a++) {
        const r = at(w, a);
        if (railWidth(r) > roomFor(w, r) + 0.5) overflow.push(`${w}/${a}`);
        if (r.shown.length && !r.shown.includes(a)) lostActive.push(`${w}/${a}`);
        if (r.shown.some((x, i) => i && x < r.shown[i - 1])) order.push(`${w}/${a}`);
    }
}
check('the rail (with More) never needs more room than it is given', !overflow.length, overflow.slice(0, 5).join(', '));
check('the tab you are on is never the one moved into More', !lostActive.length, lostActive.slice(0, 5).join(', '));
check('the rail keeps its order', !order.length, order.slice(0, 5).join(', '));
let prev = null, monotone = true;
for (let w = 320; w <= 2200; w += 2) { const n = at(w).shown.length; if (prev !== null && n < prev) monotone = false; prev = n; }
check('a wider header never shows fewer tabs', monotone);

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
