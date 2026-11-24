// tools/scroll-containment-gates.mjs — a list scrolls ITSELF, never the page.
//
// Run:  node tools/scroll-containment-gates.mjs
//
// Why this exists: `Element.scrollIntoView` scrolls every scrollable ancestor,
// up to and including the page, because its contract is "make this element
// visible" and not "move this list". Every surface in this app that keeps a
// list in sync with a selection is ALSO mounted somewhere the page is the only
// scroller — the ~390px workspace panel, or a phone — and there the two
// contracts are opposites.
//
// Measured on the atlas at 390x844 before the fix: one tap on a topic pinned a
// card on the map and scrolled the page 1,013px to bring the matching region
// row into view, leaving the map (and the card that had just opened on it)
// 322px above the top of the screen. The answer to the tap was off-screen.
//
// Two halves:
//   - the arithmetic of `scrollIntoViewWithin`, against a tree whose geometry
//     is stated rather than laid out — including the case that matters, where
//     the list has no scroller of its own and the right answer is to move
//     nothing at all;
//   - a source scan: no surface may go back to a forcing `scrollIntoView`
//     without saying why.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const cache = join(root, 'node_modules', '.cache');
const scratch = mkdtempSync(join(cache, 'scroll-gates-'));
const out = join(scratch, 'scrollWithin.cjs');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ── a DOM with stated geometry ───────────────────────────────────────────────
// Real layout is not needed and would not help: what is being tested is which
// element gets moved and to what, from numbers this test names.
class Box {
    constructor({ overflowY = 'visible', top = 0, height = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
        this.style = { overflowY };
        this.top = top;
        this.height = height;
        this.scrollHeight = scrollHeight;
        this.clientHeight = clientHeight;
        this.scrollTop = 0;
        this.parentElement = null;
        this.scrolled = [];
        this.behaviors = [];
        this.attrs = {};
    }
    /** Children move with the scroll, the way a real scroll container's do. */
    getBoundingClientRect() {
        let offset = 0;
        for (let n = this.parentElement; n; n = n.parentElement) offset -= n.scrollTop;
        return { top: this.top + offset, bottom: this.top + offset + this.height, height: this.height };
    }
    scrollTo({ top, behavior }) { this.scrolled.push(top); this.behaviors.push(behavior); this.scrollTop = top; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    append(child) { child.parentElement = this; return child; }
}

globalThis.getComputedStyle = (el) => el.style;
globalThis.document = { body: new Box(), documentElement: new Box() };

await esbuild.build({
    entryPoints: [join(root, 'src', 'utils', 'scrollWithin.ts')],
    bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent',
});
const { scrollIntoViewWithin, scrollerFor } = require(out);

// ── the shape that broke: a list inside a page ───────────────────────────────
/**
 * @param listScrolls whether the list has a scroller of its own — true is the
 *        desktop layout, false is the same markup on a phone, where the page
 *        does the scrolling for everything.
 */
function tree(listScrolls) {
    const page = new Box({ overflowY: 'auto', scrollHeight: 4000, clientHeight: 800 });
    const section = new Box({ top: 100, height: 700 });
    const list = new Box({
        overflowY: listScrolls ? 'auto' : 'visible',
        top: 100, height: 700, scrollHeight: 3000, clientHeight: 700,
    });
    const row = new Box({ top: 1200, height: 60 });
    page.append(section); section.append(list); list.append(row);
    return { page, section, list, row };
}

console.log('\nscrollIntoViewWithin — which element moves');
{
    const { page, section, list, row } = tree(true);
    const moved = scrollIntoViewWithin(row, { boundary: section, block: 'start' });
    check('a list with its own scroller is the thing that moves', moved && list.scrolled.length === 1);
    check('and the page is never touched', page.scrolled.length === 0,
        `page.scrollTo called ${page.scrolled.length} time(s)`);
}
{
    const { page, section, list, row } = tree(false);
    const moved = scrollIntoViewWithin(row, { boundary: section, block: 'start' });
    check('a list with NO scroller of its own moves nothing', !moved
        && list.scrolled.length === 0 && page.scrolled.length === 0,
        'this is the phone case — the page showing the row is already the answer');
}
{
    // An explicit 'smooth' wins over the stylesheet's scroll-behavior, so the
    // helper itself must honour Settings → Accessibility → Motion.
    const { list, row } = tree(true);
    scrollIntoViewWithin(row, { boundary: list, block: 'start', behavior: 'smooth' });
    document.documentElement.attrs['data-motion'] = 'reduce';
    const again = tree(true);
    scrollIntoViewWithin(again.row, { boundary: again.list, block: 'start', behavior: 'smooth' });
    delete document.documentElement.attrs['data-motion'];
    check('a smooth scroll stays smooth while motion is on', list.behaviors[0] === 'smooth', String(list.behaviors[0]));
    check('…and is instant with motion reduced', again.list.behaviors[0] === 'auto', String(again.list.behaviors[0]));
}
{
    // Without a boundary the search would climb out of the section and find the
    // page — which in a single-page app is a div like any other, with nothing
    // to distinguish it. So the boundary is required and a missing one is
    // fail-closed: a caller who has not said which list they mean moves nothing.
    const { page, section, list, row } = tree(false);
    check('the search gives up at the boundary', scrollerFor(row, section) === null);
    check('a null boundary finds nothing', scrollerFor(row, null) === null);
    const moved = scrollIntoViewWithin(row, { boundary: null, block: 'start' });
    check('and scrolls nothing', !moved && page.scrolled.length === 0 && list.scrolled.length === 0);
}

console.log('\nscrollIntoViewWithin — where the row lands');
{
    const { list, row } = tree(true);
    scrollIntoViewWithin(row, { boundary: list, block: 'start' });
    // The row sits 1,100px into the content (top 1200 against a list top of 100).
    check('block:start puts the row at the top of its scroller', list.scrollTop === 1100,
        `landed at ${list.scrollTop}`);
}
{
    const { list, row } = tree(true);
    scrollIntoViewWithin(row, { boundary: list, block: 'center' });
    // 1100 - (700 - 60) / 2
    check('block:center centres it', list.scrollTop === 780, `landed at ${list.scrollTop}`);
}
{
    const { list, row } = tree(true);
    row.top = 120; // already in view, 20px down
    scrollIntoViewWithin(row, { boundary: list, block: 'nearest' });
    check('block:nearest leaves a row that is already visible alone', list.scrolled.length === 0);
}
{
    const { list, row } = tree(true);
    row.top = 2900; // past the end of the scroll range
    scrollIntoViewWithin(row, { boundary: list, block: 'start' });
    check('the target is clamped to the scroll range', list.scrollTop === 3000 - 700,
        `landed at ${list.scrollTop}, limit is ${3000 - 700}`);
}
{
    const { list, row } = tree(true);
    // The row is the only positioned thing between itself and the scroller in
    // half this codebase; offsetTop would be measured against the wrong box.
    list.scrollTop = 500;
    row.top = 1200;
    scrollIntoViewWithin(row, { boundary: list, block: 'start' });
    check('a scroller that is already scrolled still lands the row correctly', list.scrollTop === 1100,
        `landed at ${list.scrollTop}`);
}
{
    // The feed: a pinned header sits over the top of its scroller, and the
    // stylesheet says how far below it a card must stop (the card's
    // `scroll-margin-top`, the scroller's `scroll-padding-top`). Native
    // scrollIntoView reads both; a hand-rolled scroll that ignores them puts
    // the next card's top under the header.
    const { list, row } = tree(true);
    row.style.scrollMarginTop = '96px';
    list.style.scrollPaddingTop = '52px';
    scrollIntoViewWithin(row, { boundary: list, block: 'start' });
    check('block:start stops below the scroll-margin and scroll-padding the stylesheet asks for',
        list.scrollTop === 1100 - 96 - 52, `landed at ${list.scrollTop}, want ${1100 - 96 - 52}`);
}
{
    const { list, row } = tree(true);
    row.style.scrollMarginTop = '96px';
    scrollIntoViewWithin(row, { boundary: list, block: 'start', padding: 16 });
    check('…and a caller\'s own padding adds to them', list.scrollTop === 1100 - 96 - 16,
        `landed at ${list.scrollTop}`);
}
{
    const { list, row } = tree(true);
    list.style.scrollPaddingTop = 'auto';
    row.style.scrollMarginTop = '24px'; // so a helper that reads neither fails too
    scrollIntoViewWithin(row, { boundary: list, block: 'start' });
    check('a scroll-padding of auto counts as none', list.scrollTop === 1100 - 24, `landed at ${list.scrollTop}`);
}
{
    const { list, row } = tree(true);
    list.style.scrollPaddingTop = '10%'; // of the 700px scrollport: 70px, not 10px
    scrollIntoViewWithin(row, { boundary: list, block: 'start' });
    check('a percentage scroll-padding is of the scroller\'s height', list.scrollTop === 1100 - 70,
        `landed at ${list.scrollTop}`);
}
{
    const { list, row } = tree(true);
    list.scrollTop = 1000;
    row.top = 1150; // 50px into the view: visible, but under an 80px header
    list.style.scrollPaddingTop = '80px';
    scrollIntoViewWithin(row, { boundary: list, block: 'nearest' });
    check('block:nearest treats a row under the pinned header as out of view', list.scrollTop === 1050 - 80,
        `landed at ${list.scrollTop}`);
}

// ── the source scan ─────────────────────────────────────────────────────────
// `block: 'start'` and `block: 'center'` force every ancestor to move.
// `nearest` does not: it does the least work that makes the element visible, so
// an element already on screen moves nothing. Only the forcing forms are
// listed; none is allowed, since a deliberate page scroll goes through
// `scrollPageTo`, which moves the window alone.
console.log('\nno surface goes back to a forcing scrollIntoView');
{
    /** @type {Map<string, string>} file -> why its forcing scroll is allowed */
    const allowed = new Map();
    const files = [];
    const walk = (dir) => {
        for (const e of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.tsx?$/.test(e.name)) files.push(p);
        }
    };
    walk(join(root, 'src'));

    const offenders = [];
    for (const file of files) {
        const src = readFileSync(file, 'utf8');
        const rel = file.slice(root.length + 1).replace(/\\/g, '/');
        for (const m of src.matchAll(/scrollIntoView\(\s*\{([^}]*)\}/g)) {
            if (!/block:\s*(['"])(start|center)\1/.test(m[1])) continue;
            if (allowed.has(rel)) continue;
            offenders.push(rel);
        }
    }
    check('every forcing scrollIntoView is one that means to scroll the page',
        offenders.length === 0, [...new Set(offenders)].join(', '));

    // An allowlist that has stopped describing the code is worse than none.
    for (const [rel, why] of allowed) {
        const src = readFileSync(join(root, rel), 'utf8');
        check(`${rel} still has the page scroll it is allowed (${why})`,
            /scrollIntoView\(/.test(src));
    }
}

// The atlas is the surface this was measured on; the hook is the one four more
// surfaces share. Both have to keep going through the scoped helper.
console.log('\nthe surfaces that were fixed still use the scoped helper');
for (const rel of ['src/components/AtlasView.tsx', 'src/hooks/useScrollToSelected.ts', 'src/components/creation/CreationRunParts.tsx']) {
    const src = readFileSync(join(root, rel), 'utf8');
    check(`${rel} scrolls within a boundary`,
        /scrollIntoViewWithin\(/.test(src) && /boundary:/.test(src));
    check(`${rel} does not also call scrollIntoView`, !/\.scrollIntoView\(/.test(src));
}

// The feed's "continue" scrolled the WINDOW on a desktop when anything made the
// page taller than it (an assistant reply's hidden text twin did, by 107px), and
// the app's header left the screen. Its own scroller first; the page only when
// it has none.
{
    const src = readFileSync(join(root, 'src/components/feed/FeedView.tsx'), 'utf8');
    check('the feed advances inside its own scroller first, the window only as the fallback',
        /if \(!scrollIntoViewWithin\([^)]*boundary:[^)]*\)\)\s*\{\s*scrollPageTo\(el,/.test(src));
}
{
    const src = readFileSync(join(root, 'src/components/deck/DeckStages.tsx'), 'utf8');
    check('a deck section picked on the strip is scrolled to inside its own scroller first, the window only as the fallback',
        /if \(el && !scrollIntoViewWithin\(el, \{[^}]*boundary:[^}]*\}\)\)\s*\{\s*scrollPageTo\(el,/.test(src));
}

// The phone fallback moves the window and nothing else: native scrollIntoView
// would also scroll an `overflow: hidden` box on the way up, so a desktop list
// that merely had nothing to scroll could still shift the app frame.
console.log('\nscrollPageTo — the window moves, nothing else');
{
    const { scrollPageTo } = require(out);
    const calls = [];
    globalThis.window = { scrollY: 300, innerHeight: 800, scrollTo: (o) => calls.push(o) };
    const { page, section, list, row } = tree(false);
    row.style.scrollMarginTop = '78px';
    scrollPageTo(row, { block: 'start' });
    check('block:start lands the element below its scroll-margin, in page coordinates',
        calls.length === 1 && calls[0].top === 1200 + 300 - 78, JSON.stringify(calls));
    scrollPageTo(row, { block: 'center' });
    check('block:center centres it in the window', calls[1]?.top === 1200 + 300 - (800 - 60) / 2, JSON.stringify(calls[1]));
    check('and no box on the way up is scrolled',
        [page, section, list].every((b) => b.scrolled.length === 0));
    delete globalThis.window;
}

// `nearest` cannot force a scroll while the element is on screen, but it still
// scrolls the page when the element is not (a page already moved by anything),
// and then the header leaves. So no native call is left anywhere.
console.log('\nno native scrollIntoView anywhere');
{
    const fallbacks = new Set();
    const natives = [];
    const walk = (dir) => {
        for (const e of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.tsx?$/.test(e.name)) {
                const rel = p.slice(root.length + 1).replace(/\\/g, '/');
                const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
                const n = (code.match(/\.scrollIntoView\(/g) ?? []).length;
                if (n && !fallbacks.has(rel)) natives.push(`${rel} (${n})`);
                if (fallbacks.has(rel) && n !== 1) natives.push(`${rel} has ${n} native calls, one fallback allowed`);
            }
        }
    };
    walk(join(root, 'src'));
    check('every other list moves through scrollIntoViewWithin or scrollRailTo', natives.length === 0, natives.join(', '));
    for (const rel of ['src/components/Layout.tsx', 'src/components/Workspace.tsx']) {
        check(`${rel} moves its tab rail with scrollRailTo`, /scrollRailTo\(/.test(readFileSync(join(root, rel), 'utf8')));
    }
    for (const rel of ['src/components/ModelPicker.tsx', 'src/components/SearchBar.tsx', 'src/components/Sidebar.tsx']) {
        const src = readFileSync(join(root, rel), 'utf8');
        check(`${rel} keeps its cursor row in view within a boundary`, /scrollIntoViewWithin\([^;]*boundary:/.test(src));
    }
}

// The rails' horizontal helper, against stated geometry.
console.log('\nscrollRailTo — a tab rail moves sideways and nothing else');
{
    const { scrollRailTo } = require(out);
    const rail = (scrollWidth, clientWidth, left, right) => {
        const r = { scrollWidth, clientWidth, moved: [], contains: () => true,
            getBoundingClientRect: () => ({ left, right }), scrollBy: ({ left: d }) => r.moved.push(d) };
        return r;
    };
    const tab = (left, right) => ({ getBoundingClientRect: () => ({ left, right }) });
    const past = rail(900, 400, 0, 400);
    check('a tab past the right edge moves the rail by what sticks out', scrollRailTo(tab(420, 500), past) && past.moved[0] === 100, String(past.moved));
    const before = rail(900, 400, 100, 500);
    check('a tab before the left edge moves it back', scrollRailTo(tab(40, 120), before) && before.moved[0] === -60, String(before.moved));
    const inside = rail(900, 400, 0, 400);
    check('a tab in view moves nothing', !scrollRailTo(tab(100, 180), inside) && inside.moved.length === 0);
    const fits = rail(400, 400, 0, 400);
    check('a rail with nothing to scroll moves nothing', !scrollRailTo(tab(420, 500), fits) && fits.moved.length === 0);
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will */ }
console.log(`\nscroll containment gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
