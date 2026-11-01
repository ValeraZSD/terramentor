// tools/header-fit-gates.mjs — the top bar never cuts a tab.
//
// Run:  node tools/header-fit-gates.mjs
//       node tools/header-fit-gates.mjs --head   (the bar's tabs from HEAD's Layout.tsx)
//
// WHY. The header is as wide as the page column, and the assistant docks
// beside it at a width the learner drags, so a 1280px window left a 760px
// header whose scrolling tab rail drew "Schedul" and hid Atlas. `fitHeader`
// (src/utils/headerFit.ts) now gives things up in order — the centring, the
// search's words, then tabs into a "More" menu — and this drives it with the
// widths measured in Edge (English, 100% text, mouse) across every header
// width from a phone to a wide screen, in both directions of the active tab.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

// Measured in Edge, English, the three icons without their words, one width
// per tab of the bar. 320px is the narrowest phone. Keyed, and checked against
// the tabs Layout.tsx actually draws: when Schedule left the bar this list
// still held five, and every case below kept passing for a bar that no longer
// existed.
const WIDTH = { today: 57.6, projects: 70.4, calendar: 76.2, atlas: 51.2 };
const layout = process.argv.includes('--head')
    ? execFileSync('git', ['show', 'HEAD:src/components/Layout.tsx'], { cwd: repoRoot, encoding: 'utf8' })
    : readFileSync(join(repoRoot, 'src/components/Layout.tsx'), 'utf8');
const barKeys = [...(/const globalTabs = \[([\s\S]*?)\];/.exec(layout)?.[1] ?? '').matchAll(/key: '(\w+)'/g)].map(m => m[1]);
const TABS = barKeys.map(k => WIDTH[k]);
const ATLAS = barKeys.indexOf('atlas');
const ALL = TABS.length, all = `all ${ALL} tabs`;
const base = { gap: 8, search: 159, searchIcon: 40, right: 124, tabs: TABS, tabGap: 4, more: 73.8 };
// The switcher's chevron and the gap before it: `gap-1` + `w-4`.
const CARET = 20;
const at = (header, active = 0, room = {}) => fitHeader({ ...base, inner: header - 32, ...room }, active);
const railWidth = (f, active = 0) => f.switcher
    ? TABS[active] + CARET
    : f.shown.reduce((s, i) => s + TABS[i], 0) + base.tabGap * Math.max(0, f.shown.length - 1)
        + (f.shown.length < TABS.length ? (f.shown.length ? base.tabGap : 0) + base.more : 0);
// The tab you are on is on screen: in the rail, or naming the menu button.
const showsActive = (f, active) => f.shown.includes(active) || (f.switcher && !f.shown.length);
const roomFor = (header, f) => {
    const inner = header - 32, search = f.searchIcon ? base.searchIcon : base.search;
    return f.centred ? (inner - search - 2 * base.gap) / 2 : inner - search - base.right - 2 * base.gap;
};

console.log('\n--- the tabs measured are the tabs drawn ---');
check(`Layout.tsx draws tabs, and each has a measured width (${barKeys.join(', ')})`,
    ALL > 0 && TABS.every(w => typeof w === 'number'), `unmeasured: ${barKeys.filter(k => WIDTH[k] === undefined).join(', ')}`);
check('no width is kept for a tab the bar no longer has', Object.keys(WIDTH).every(k => barKeys.includes(k)),
    `stale: ${Object.keys(WIDTH).filter(k => !barKeys.includes(k)).join(', ')}`);

console.log('\n--- the widths the review hit ---');
let f = at(760);
check(`1280px window, assistant open (760px header): ${all}, whole`, f.shown.length === ALL, JSON.stringify(f));
// The centring is the first thing given up, the search's words the second.
// (With five tabs that point fell at this very width; with four it is
// narrower, so the order is checked at every width, not at one.)
const widths = Array.from({ length: (2200 - 320) / 2 + 1 }, (_, i) => 320 + 2 * i);
check('narrowing, the centring goes before the search\'s words',
    widths.every(w => { const r = at(w); return !r.searchIcon || !r.centred; })
    && widths.some(w => { const r = at(w); return r.shown.length === ALL && !r.centred && !r.searchIcon; }));
f = at(1280);
check(`no assistant (1280px header): centred search, ${all}`, f.centred && !f.searchIcon && f.shown.length === ALL, JSON.stringify(f));
f = at(1400);
check(`1920px window, assistant open: centred, ${all}`, f.centred && f.shown.length === ALL);
f = at(410);
check('1024px window, assistant at its widest (410px): the search is its icon and the rest go in More', f.searchIcon && f.shown.length >= 1 && f.shown.length < ALL, JSON.stringify(f));
f = at(410, ATLAS);
check('…and on Atlas, Atlas stays in the rail', ATLAS >= 0 && f.shown.includes(ATLAS), JSON.stringify(f));

// A 390px phone with the update button showing: four 44px touch icons on
// the right and the 44px search, so not even "Projects" fits beside More.
// It once fell through to More alone, and the page you were on was named
// nowhere on screen.
console.log('\n--- a phone with no room for a tab beside More ---');
const phone = { searchIcon: 44, right: 4 * 44 + 3 * 8, gap: 4 };
f = at(390 - 16 + 32, 1, phone);
check('on Projects: the menu button names Projects instead of "More"', f.switcher && !f.shown.length, JSON.stringify(f));
for (let a = 0; a < TABS.length; a++) {
    const r = at(390 - 16 + 32, a, phone);
    check(`…tab ${a}: on screen`, showsActive(r, a), JSON.stringify(r));
}
f = at(760);
check('a wide header never turns the tabs into a switcher', !f.switcher);

console.log('\n--- every width, every tab ---');
let overflow = [], lostActive = [], order = [];
for (let w = 320; w <= 2200; w += 2) {
    for (let a = 0; a < TABS.length; a++) {
        const r = at(w, a);
        if (railWidth(r, a) > roomFor(w, r) + 0.5) overflow.push(`${w}/${a}`);
        if (!showsActive(r, a)) lostActive.push(`${w}/${a}`);
        if (r.shown.some((x, i) => i && x < r.shown[i - 1])) order.push(`${w}/${a}`);
    }
}
check('the rail (with More) never needs more room than it is given', !overflow.length, overflow.slice(0, 5).join(', '));
check('the tab you are on is always on screen, never only inside More', !lostActive.length, lostActive.slice(0, 5).join(', '));
check('the rail keeps its order', !order.length, order.slice(0, 5).join(', '));
let prev = null, monotone = true;
for (let w = 320; w <= 2200; w += 2) { const n = at(w).shown.length; if (prev !== null && n < prev) monotone = false; prev = n; }
check('a wider header never shows fewer tabs', monotone);

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
