#!/usr/bin/env node
// popover-gates.mjs — what opens from a button stays on a phone's glass.
//
// Two rules, each made once in a shared primitive:
//
//   1. WHERE IT FLOATS (a hovering pointer), `placePopover` keeps the menu
//      inside the part of the screen it may use: the VISUAL viewport (what is
//      left above an on-screen keyboard, or of a pinch zoom) less the phone's
//      covered edges (status bar, home indicator, the corners held sideways),
//      plus an 8px margin. It used to clamp 8px inside `innerWidth/innerHeight`:
//      a menu flipped above a button near the top of a phone ran under the
//      status bar, and one opened from a field above the keyboard ran under it.
//      Held as a property over a sweep of rooms, buttons, menus and alignments,
//      and as the named cases that went wrong.
//   2. UNDER A FINGER TOO, what opens from a button opens AT the button:
//      `Select`'s list, every `MenuPopover`, every `PanelPopover`, with rows a
//      finger can hit. They were the bottom sheet of `ui/Sheet.tsx` for a
//      while, and a menu tapped open from the top bar then appeared at the far
//      end of the screen. The sheet is left to what belongs to the bottom edge.
//      Held by mounting them in jsdom, and by reading the source for menus that
//      are placed by hand (their own `placePopover` call, their own portalled
//      menu panel, a panel hung `absolute … top-full` from its button).
//      A tap outside closes it; under a finger that tap is spent on closing
//      (it presses nothing under it) and focus that was inside goes back to
//      the button. Scrolling its own rows does not re-place it.
//   3. A SWITCH ALONE ON ITS LINE (`SegmentedControl block="narrow"`) fills
//      the row it stands in while that row is narrow, and keeps its own width
//      on a wide one, or in a flex row where it shares the line. At its own
//      width on a phone it left a gap at the right that read as a layout that
//      had not finished. Held by mounting it in narrow, wide, column and row
//      parents, and by reading the Projects page's switch.
//   4. WHAT FLOATS STACKS ABOVE ITS HOST. Menus, panels, Select's list and
//      the model picker share `FLOAT_LAYER`, above every dialog, sheet and
//      viewer that can hold one (a menu at z-50 opened inside the z-[55]
//      mastery check, under it and out of reach). Held by reading every
//      full-screen layer and Modal layer in src/ against it.
//
//   node tools/popover-gates.mjs              # this checkout
//   node tools/popover-gates.mjs --root DIR   # another checkout (the pre-fix tree must fail)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, existsSync, globSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const self = resolve(here, '..');
const rootArg = process.argv.indexOf('--root');
if (rootArg > 0 && !process.argv[rootArg + 1]) { console.error('--root needs a directory'); process.exit(2); }
const ROOT = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : self;
const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } };

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// ---------------------------------------------------------------------------
// The harness: the checkout's own primitives, bundled for jsdom. Packages
// resolve from this checkout's node_modules (a bare `--root` tree has none).
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'MutationObserver', 'KeyboardEvent', 'PointerEvent', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
globalThis.ResizeObserver = window.ResizeObserver;
// The pointer under test: a mouse (hovers) or a finger (does not).
let hovers = true;
window.matchMedia = (q) => ({
    matches: /hover:\s*hover/.test(q) ? hovers : /pointer:\s*fine/.test(q) ? hovers : false,
    media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { },
});

const cacheDir = join(self, 'node_modules', '.cache');
const scratch = mkdtempSync(join(existsSync(cacheDir) ? cacheDir : self, 'popover-gates-'));
const out = join(scratch, 'bundle.cjs');
const has = (p) => existsSync(join(ROOT, p));
let bundled = true;
try {
    await esbuild.build({
        stdin: {
            contents: `
                import * as React from 'react';
                import { createRoot } from 'react-dom/client';
                import * as Pop from './src/components/ui/Popover';
                import DropdownMenu from './src/components/DropdownMenu';
                import { IconButton } from './src/components/ui/Button';
                import { Select } from './src/components/ui/Select';
                import { SegmentedControl } from './src/components/ui/SegmentedControl';
                globalThis.__pop = Pop;
                // A switch with block="narrow" in a row of a given width.
                globalThis.__switchIn = (el, width) => {
                    el.innerHTML = '';
                    Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
                    const r = createRoot(el);
                    React.act(() => r.render(h(SegmentedControl, {
                        label: 'Show', block: 'narrow', value: 'a', onChange: () => { },
                        options: [{ value: 'a', label: 'Active' }, { value: 'f', label: 'Finished' }, { value: 'x', label: 'Archived' }],
                    })));
                    const group = el.querySelector('[role="radiogroup"]');
                    const cls = group?.className ?? '';
                    React.act(() => r.unmount());
                    return cls;
                };
                globalThis.__act = (fn) => React.act(fn);
                const h = React.createElement;
                // One opener of each kind, open or shut.
                globalThis.__mount = (el, kind) => {
                    const r = createRoot(el);
                    const log = { closes: 0, card: 0 };
                    // The opener sits on a card that opens something on a press,
                    // as a project card does: a press inside the portalled menu
                    // must not be a press on the card too.
                    const card = { onClick: () => { log.card++; }, onPointerDown: () => { log.card++; } };
                    function Host({ open }) {
                        const btn = React.useRef(null);
                        const close = () => { log.closes++; };
                        const trigger = h('button', { ref: btn, id: 'trigger' }, 'Open');
                        if (kind === 'menu') return h('div', card, trigger,
                            h(Pop.MenuPopover, { open, onClose: close, anchorRef: btn, label: 'Project options' },
                                h(Pop.MenuItem, { onSelect: () => { } }, 'Edit'),
                                h(Pop.MenuItem, { onSelect: () => { } }, 'Export'),
                                h(Pop.MenuItem, { onSelect: () => { }, tone: 'danger' }, 'Delete')));
                        if (kind === 'panel') return Pop.PanelPopover
                            ? h('div', card, trigger,
                                h(Pop.PanelPopover, { open, onClose: close, anchorRef: btn, label: 'Icon and colour', width: 'w-72' },
                                    h('button', { id: 'inside' }, 'A control')))
                            : h('div', null, 'no PanelPopover');
                        if (kind === 'dropdown') return h(DropdownMenu, {
                            trigger: h(IconButton, { id: 'trigger', label: 'Actions for Algebra', tooltip: false, icon: h('span', null, '⋮') }),
                        }, h(Pop.MenuItem, { onSelect: () => { } }, 'Add Child'), h(Pop.MenuItem, { onSelect: () => { } }, 'Delete'));
                        if (kind === 'select') return h('label', null, 'Language',
                            h(Select, { id: 'trigger', value: 'en', onChange: () => { } },
                                h('option', { value: 'en' }, 'English'), h('option', { value: 'nl' }, 'Nederlands')));
                        return null;
                    }
                    const render = (open) => React.act(() => r.render(h(Host, { open })));
                    return { render, log, unmount: () => React.act(() => r.unmount()) };
                };`,
            resolveDir: ROOT,
            loader: 'tsx',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: out,
        jsx: 'automatic', external: ['react', 'react-dom', 'react-dom/client', 'react-i18next', 'i18next', 'lucide-react'],
        nodePaths: [join(self, 'node_modules')], logLevel: 'silent',
    });
    require(out);
} catch (e) {
    bundled = false;
    check('the primitives bundle', false, String(e.message ?? e).split('\n')[0]);
}
const Pop = globalThis.__pop ?? {};
const place = Pop.placePopover;

// ---------------------------------------------------------------------------
section('1. placePopover never leaves the viewport less the phone\'s covered edges');

// The rooms a menu meets, as `popoverBounds()` reports them (fixed-position
// coordinates): the visual viewport less the --safe-* insets.
const ROOMS = {
    'iPhone portrait 393×852, insets 59 top / 34 bottom': { left: 0, top: 59, right: 393, bottom: 852 - 34 },
    'the same with the keyboard up (visual viewport 516 tall)': { left: 0, top: 59, right: 393, bottom: 516 - 34 },
    'keyboard up and the page scrolled under it (visual viewport offset 220)': { left: 0, top: 220 + 59, right: 393, bottom: 220 + 516 - 34 },
    'landscape 852×393, insets 59 at the sides, 21 bottom': { left: 59, top: 0, right: 852 - 59, bottom: 393 - 21 },
    'pinch-zoomed 2× into the middle of the page': { left: 100, top: 150, right: 100 + 196, bottom: 150 + 426 },
    'a desktop window 1280×800': { left: 0, top: 0, right: 1280, bottom: 800 },
};
const MENUS = [{ width: 208, height: 96 }, { width: 224, height: 260 }, { width: 208, height: 520 }, { width: 500, height: 96 }, { width: 304, height: 900 }];
const BUTTONS = [{ w: 40, h: 40 }, { w: 130, h: 44 }];
const M = 8, EPS = 0.01;

// The pre-fix function took only the window's width and height: given a room
// it cannot read, it is called the only way it can be, against the glass.
const placeIn = (a, s, b, o) => {
    let p = place(a, s, b, o);
    if (!Number.isFinite(p?.left) || !Number.isFinite(p?.top)) p = place(a, s, { width: b.right, height: b.bottom }, o);
    return p;
};
const outside = (p, s, b) => {
    const w = Math.min(s.width, p.maxWidth ?? Infinity), h = Math.min(s.height, p.maxHeight ?? Infinity);
    const why = [];
    if (!(p.left >= b.left + M - EPS)) why.push(`left ${p.left} < ${b.left + M}`);
    if (!(p.left + w <= b.right - M + EPS)) why.push(`right ${p.left + w} > ${b.right - M}`);
    if (!(p.top >= b.top + M - EPS)) why.push(`top ${p.top} < ${b.top + M}`);
    if (!(p.top + h <= b.bottom - M + EPS)) why.push(`bottom ${p.top + h} > ${b.bottom - M}`);
    return why.join(', ');
};

if (typeof place === 'function') {
    for (const [name, b] of Object.entries(ROOMS)) {
        let n = 0, bad = 0, first = '';
        // Buttons all over the screen, past each edge too: under the status bar,
        // under the keyboard, scrolled half off.
        for (let y = b.top - 60; y <= b.bottom + 40; y += 23) {
            for (let x = b.left - 30; x <= b.right + 10; x += 37) {
                for (const bt of BUTTONS) for (const s of MENUS) for (const align of ['start', 'end']) {
                    const a = { left: x, top: y, right: x + bt.w, bottom: y + bt.h };
                    const p = placeIn(a, s, b, { align });
                    n++;
                    const why = outside(p, s, b);
                    if (why) { bad++; if (!first) first = `button ${JSON.stringify(a)}, menu ${s.width}×${s.height}, ${align}: ${why}`; }
                }
            }
        }
        check(`${name}: all ${n} placements inside`, bad === 0, `${bad} outside; first: ${first}`);
    }

    const portrait = ROOMS['iPhone portrait 393×852, insets 59 top / 34 bottom'];
    const keyboard = ROOMS['the same with the keyboard up (visual viewport 516 tall)'];
    // A ⋮ just under the header with the keyboard up: no room below, so it
    // flips ABOVE — and above is the status bar. The old clamp stopped at 8px.
    let a = { left: 345, top: 330, right: 385, bottom: 370 };
    let s = { width: 208, height: 300 };
    let p = placeIn(a, s, keyboard, { align: 'end' });
    check('a menu flipped upward near the top stops below the status bar (59 + 8)',
        p.side === 'above' && p.top >= 67 - EPS && !outside(p, s, keyboard), JSON.stringify(p));
    check('…still above its button, scrolling inside the room it has', p.top + Math.min(s.height, p.maxHeight ?? Infinity) <= a.top - 4 + EPS, JSON.stringify(p));
    // A field half-way down with the keyboard up: below it is the keyboard.
    a = { left: 16, top: 400, right: 377, bottom: 444 };
    s = { width: 361, height: 280 };
    p = placeIn(a, s, keyboard);
    check('a menu from a field above the keyboard opens above the field, not under the keyboard',
        p.side === 'above' && p.top + s.height <= keyboard.bottom - M + EPS, JSON.stringify(p));
    // At the bottom of a phone, above the home indicator.
    a = { left: 20, top: 760, right: 60, bottom: 800 };
    s = { width: 208, height: 96 };
    p = placeIn(a, s, portrait);
    check('a menu from a button over the home indicator stays above it', p.top + s.height <= portrait.bottom - M + EPS, JSON.stringify(p));
    // Landscape: the corners.
    const land = ROOMS['landscape 852×393, insets 59 at the sides, 21 bottom'];
    p = placeIn({ left: 10, top: 40, right: 50, bottom: 80 }, { width: 208, height: 96 }, land);
    check('held sideways, a menu from the left edge clears the notch side (59 + 8)', p.left >= 67 - EPS, JSON.stringify(p));
    // Nothing changes on a desktop: the cases keyboard-gates pinned on the old function.
    const desk = { left: 0, top: 0, right: 1440, bottom: 900 };
    const menu = { width: 208, height: 96 };
    p = place({ left: 132, top: 500, right: 262, bottom: 544 }, menu, desk);
    const p2 = place({ left: 600, top: 820, right: 700, bottom: 860 }, menu, desk);
    const p3 = place({ left: 1300, top: 100, right: 1340, bottom: 140 }, menu, desk, { align: 'end' });
    check('a desktop with no insets places exactly as before (start edge, flip above, end edge)',
        p.left === 132 && p.top === 548 && p.side === 'below'
        && p2.side === 'above' && p2.top === 820 - 4 - 96
        && p3.left === 1340 - 208 && p.maxHeight === undefined, JSON.stringify([p, p2, p3]));
} else {
    check('placePopover is exported', false);
}

section('…and the app gives it that room');
{
    const pop = read('src/components/ui/Popover.tsx');
    const fn = /export function popoverBounds\(\)[\s\S]*?\n\}/.exec(pop)?.[0] ?? '';
    check('popoverBounds() reads the visual viewport', /window\.visualViewport/.test(fn) && /offsetTop/.test(fn) && /offsetLeft/.test(fn));
    check('…less the --safe-* insets from computed style, never env() in script',
        /getComputedStyle\(document\.documentElement\)/.test(fn) && /--safe-\$\{side\}/.test(fn) && !/env\(/.test(fn));
    check('a floating surface follows the visual viewport (the keyboard opening moves it)',
        /visualViewport[\s\S]{0,80}addEventListener\('resize'/.test(pop) && /followVisualViewport\(measure\)/.test(pop));
    // Every caller hands it that room, not the window's size.
    const callers = globSync('src/**/*.tsx', { cwd: ROOT }).map(f => f.replace(/\\/g, '/')).filter(f => /placePopover\(/.test(read(f)));
    const bad = callers.filter(f => /placePopover\([\s\S]{0,300}?innerWidth/.test(read(f)));
    check('no caller places against innerWidth/innerHeight', bad.length === 0, bad.join(', '));

    // What it returns, not only what it reads: the keyboard up and the page
    // panned under it (the visual viewport 516 tall at offset 10, 220), with a
    // phone's insets on the root.
    if (Pop.popoverBounds) {
        const root = document.documentElement.style;
        const insets = { top: 59, right: 3, bottom: 34, left: 5 };
        for (const [side, px] of Object.entries(insets)) root.setProperty(`--safe-${side}`, `${px}px`);
        const had = Object.getOwnPropertyDescriptor(window, 'visualViewport');
        Object.defineProperty(window, 'visualViewport', { configurable: true,
            value: { offsetLeft: 10, offsetTop: 220, width: 393, height: 516, addEventListener() { }, removeEventListener() { } } });
        const got = Pop.popoverBounds();
        const want = { left: 15, top: 279, right: 400, bottom: 702 };
        check('popoverBounds() returns the visual viewport less each inset, on all four edges',
            ['left', 'top', 'right', 'bottom'].every(k => got[k] === want[k]), `${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
        if (had) Object.defineProperty(window, 'visualViewport', had); else delete window.visualViewport;
        for (const side of Object.keys(insets)) root.removeProperty(`--safe-${side}`);
    } else {
        check('popoverBounds() exists', false);
    }
}

// ---------------------------------------------------------------------------
section('2. under a finger too, what opens from a button opens at the button');
{
    // Source: no menu placed by hand outside the primitives.
    const files = globSync('src/**/*.tsx', { cwd: ROOT }).map(f => f.replace(/\\/g, '/'));
    const PRIMITIVES = new Set(['src/components/ui/Popover.tsx', 'src/components/ui/Select.tsx', 'src/components/ui/Sheet.tsx']);
    // A hover card answers a hovering pointer and never opens under a finger.
    const HOVER_ONLY = 'src/components/update/UpdateHoverCard.tsx';
    const placers = files.filter(f => !PRIMITIVES.has(f) && f !== HOVER_ONLY && /placePopover\(/.test(read(f)));
    check('no menu or panel places itself with its own placePopover call', placers.length === 0, placers.join(', '));
    check('the hover card opens only for a hovering pointer', /pointerType !== 'mouse' \|\| !canHover\(\)/.test(read(HOVER_ONLY)));
    const panels = files.filter(f => !PRIMITIVES.has(f) && f !== HOVER_ONLY && /\bMENU_(PANEL|SURFACE)\b/.test(read(f)) && /createPortal\(/.test(read(f)));
    check('no component portals a menu panel of its own', panels.length === 0, panels.join(', '));
    const hung = files.filter(f => /className="[^"]*\babsolute\b[^"]*\b(top|bottom)-full\b[^"]*\bshadow/.test(read(f)));
    check('no panel hung from its button with absolute top-full', hung.length === 0, hung.join(', '));
    // ModelPicker is a search field over a long list: the keyboard it raises
    // shrinks the visual viewport, and a list placed in the layout viewport
    // would sit under the keyboard. It is placed in the same room as the rest.
    check('the model picker (a typed search) floats in the visual viewport less the insets',
        /popoverBounds\(\)/.test(read('src/components/ModelPicker.tsx')));
    check('…and moves when the keyboard it raises shrinks the visual viewport',
        /followVisualViewport\(/.test(read('src/components/ModelPicker.tsx')));
    // One sheet.
    const handles = files.filter(f => /data-sheet-handle/.test(read(f)) && f !== 'src/components/AtlasView.tsx');
    check('one sheet: only ui/Sheet.tsx draws a pull handle (the atlas\'s index is a page, not an opener)',
        handles.length === 1 && handles[0] === 'src/components/ui/Sheet.tsx', handles.join(', ') || 'none');
    check('no opener turns into the sheet: Popover.tsx and Select.tsx draw no BottomSheet',
        !/<BottomSheet\b/.test(read('src/components/ui/Popover.tsx')) && !/<BottomSheet\b/.test(read('src/components/ui/Select.tsx')));
    // The sheet is for a panel opened from the bottom edge: the mock exam's
    // list of questions, from the number row along the bottom. A new user is
    // a decision, named here.
    const SHEET_USERS = new Set(['src/components/mockExam/CourseMock.tsx']);
    const sheetUsers = files.filter(f => f !== 'src/components/ui/Sheet.tsx' && /<BottomSheet\b/.test(read(f)));
    check('the bottom sheet opens only from the bottom edge (its users are named)',
        sheetUsers.every(f => SHEET_USERS.has(f)), sheetUsers.filter(f => !SHEET_USERS.has(f)).join(', '));
    const sheet = read('src/components/ui/Sheet.tsx');
    check('the sheet clears the status bar and the sides, and pads the home indicator',
        /safe-pt-0 safe-px-0/.test(sheet) && /safe-pb-0/.test(sheet));
}

const host = document.getElementById('root');
const settle = () => globalThis.__act(async () => { await new Promise(r => setTimeout(r, 30)); });
const pressKey = (k) => globalThis.__act(() => { document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
// A press as a finger or a mouse makes it: pointerdown, then click.
const press = (el) => globalThis.__act(() => {
    el?.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});
const inside = (kind, root) => root?.querySelector(kind === 'menu' ? '[role="menuitem"]' : '#inside');
// A finger's pointerdown (jsdom's MouseEvent carries no pointerType of its own).
const touchDown = (el) => {
    const e = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    el.dispatchEvent(e);
};
// A button beside the opener that counts the clicks reaching it.
const beside = () => {
    const b = document.createElement('button');
    b.clicks = 0;
    b.addEventListener('click', () => { b.clicks++; });
    document.body.appendChild(b);
    return b;
};

if (bundled) {
    for (const kind of ['menu', 'panel']) {
        const what = kind === 'menu' ? 'a MenuPopover' : 'a PanelPopover';
        if (kind === 'panel' && !Pop.PanelPopover) { check('a panel from a button has a shared primitive (PanelPopover)', false, 'none: each panel is placed by hand'); continue; }
        // A mouse first: it floats.
        hovers = true;
        let m = globalThis.__mount(host, kind);
        await m.render(true); await settle();
        let surface = kind === 'menu' ? document.querySelector('[role="menu"]') : document.querySelector('[role="dialog"]');
        check(`${what} with a mouse floats beside its button (no sheet)`, !!surface && !document.querySelector('[data-bottom-sheet]'));
        check('…fixed, portalled to the body (no ancestor\'s transform or overflow traps it)',
            !!surface && surface.parentElement === document.body && /(^|\s)fixed(\s|$)/.test(surface.className), surface?.parentElement?.tagName);
        {
            // Placed from the button's box: re-read when the page scrolls,
            // not when its own rows do.
            const trig = document.getElementById('trigger');
            let reads = 0;
            const real = trig.getBoundingClientRect.bind(trig);
            trig.getBoundingClientRect = () => { reads++; return real(); };
            await globalThis.__act(() => { surface?.dispatchEvent(new window.Event('scroll')); });
            const own = reads;
            await globalThis.__act(() => { document.dispatchEvent(new window.Event('scroll')); });
            check('…scrolling its own rows does not re-place it; the page scrolling does',
                own === 0 && reads > own, `${own} measure(s) on its own scroll, ${reads - own} on the page's`);
            delete trig.getBoundingClientRect;
        }
        {
            // Placed from the button's box (a 200px-tall surface, the window
            // 768px): under the button with room, over it without.
            const trig = document.getElementById('trigger');
            const P = window.HTMLElement.prototype;
            Object.defineProperty(P, 'scrollHeight', { configurable: true, get() { return 200; } });
            const at = async (top) => {
                trig.getBoundingClientRect = () => ({ top, bottom: top + 40, left: 40, right: 120, width: 80, height: 40, x: 40, y: top });
                await globalThis.__act(() => { document.dispatchEvent(new window.Event('scroll')); });
                return { top: parseFloat(surface?.style.top ?? ''), left: parseFloat(surface?.style.left ?? '') };
            };
            const low = await at(100);
            const high = await at(window.innerHeight - 60);
            check('…placed under its button with room: top just below it, left at its left edge',
                low.top >= 140 && low.top <= 160 && low.left === 40, JSON.stringify(low));
            check('…and over it when the room below is short: its bottom above the button\'s top',
                high.top + 200 <= window.innerHeight - 60 && high.top >= window.innerHeight - 60 - 200 - 20 && high.left === 40,
                `${JSON.stringify(high)} for a button at ${window.innerHeight - 60}px`);
            // Shadowed on HTMLElement for the check; deleting it uncovers Element's own.
            delete P.scrollHeight;
            delete trig.getBoundingClientRect;
        }
        await press(inside(kind, surface));
        check('…a press inside it is not a press on the card it opened from', m.log.card === 0, `${m.log.card} event(s) reached the card`);
        {
            const b = beside();
            await press(b);
            check('…a mouse press outside closes it and still presses what it lands on, as beside a desktop menu',
                m.log.closes === 1 && b.clicks === 1, `${m.log.closes} close(s), ${b.clicks} click(s) beside`);
            b.remove();
        }
        await m.render(false); m.unmount();

        // A finger: the same floating surface at the button, never the sheet.
        hovers = false;
        m = globalThis.__mount(host, kind);
        await m.render(false);
        const fingerTrigger = document.getElementById('trigger');
        fingerTrigger.focus();
        // The button 300-340px down the page: the surface belongs just under it.
        fingerTrigger.getBoundingClientRect = () => ({ top: 300, bottom: 340, left: 40, right: 120, width: 80, height: 40, x: 40, y: 300 });
        await m.render(true); await settle();
        surface = kind === 'menu' ? document.querySelector('[role="menu"]') : document.querySelector('[role="dialog"]');
        const top = parseFloat(surface?.style.top ?? '');
        check(`${what} under a finger opens at its button, not as a sheet from the bottom`,
            !!surface && !document.querySelector('[data-bottom-sheet]') && top >= 340 && top <= 360,
            document.querySelector('[data-bottom-sheet]') ? 'a bottom sheet' : surface ? `top ${surface.style.top} for a button whose bottom is at 340px` : 'nothing opened');
        delete fingerTrigger.getBoundingClientRect;
        check('…fixed, portalled to the body, as with a mouse',
            !!surface && surface.parentElement === document.body && /(^|\s)fixed(\s|$)/.test(surface.className), surface?.parentElement?.tagName);
        if (kind === 'menu') {
            const items = [...(surface?.querySelectorAll('[role="menuitem"]') ?? [])];
            check('…its rows inside, the first one focused', items.length === 3 && document.activeElement === items[0], document.activeElement?.textContent);
            check('…each row a finger can hit (44px under touch)', items.length === 3 && items.every(i => /(^|\s)touch:min-h-11(\s|$)/.test(i.className)),
                items.map(i => i.className.match(/\S*min-h-\S+/g)?.join(' ') ?? 'no min-h').join(' | '));
        } else {
            check('…its controls inside', !!surface?.querySelector('#inside'));
        }
        await pressKey('Escape');
        check('…Escape closes it', m.log.closes === 1, `${m.log.closes} close(s)`);
        await m.render(false); await settle();
        check('…and focus goes back to the button it opened from', document.activeElement?.id === 'trigger', document.activeElement?.tagName);
        await m.render(true); await settle();
        await globalThis.__act(() => { document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })); });
        check('…a tap outside it closes it', m.log.closes === 2, `${m.log.closes} close(s)`);
        surface = kind === 'menu' ? document.querySelector('[role="menu"]') : document.querySelector('[role="dialog"]');
        await press(inside(kind, surface));
        check('…and a tap on a row inside it does not reach the card behind it', m.log.card === 0, `${m.log.card} event(s) reached the card`);
        {
            // The tap that closes it is spent on closing, as a native picker
            // spends it; focus was inside it and goes back to its button.
            const b = beside();
            inside(kind, surface)?.focus();
            await globalThis.__act(() => { touchDown(b); });
            await m.render(false);
            await globalThis.__act(() => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); });
            check('…a finger\'s tap outside closes it and presses nothing under it',
                m.log.closes === 3 && b.clicks === 0, `${m.log.closes} close(s), ${b.clicks} click(s) on the button under the tap`);
            check('…and focus, which was inside it, goes back to its button (not to the page)',
                document.activeElement?.id === 'trigger', document.activeElement?.tagName);
            const before = b.clicks;
            await globalThis.__act(() => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); });
            check('…the next tap is a tap again', b.clicks === before + 1, `${b.clicks - before} click(s)`);
            b.remove();
        }
        await m.render(false); m.unmount();
    }

    // A row chosen from the floating ⋮ menu: the row goes with the menu, and
    // focus must not fall to the page — it goes back to the ⋮.
    hovers = true;
    let m = globalThis.__mount(host, 'dropdown');
    await m.render(true); await settle();
    await globalThis.__act(() => { document.getElementById('trigger').click(); });
    await settle();
    const row = document.querySelector('[role="menu"] [role="menuitem"]');
    check('a row chosen from a floating ⋮ menu: the menu was open with its first row focused', !!row && document.activeElement === row, document.activeElement?.tagName);
    await globalThis.__act(() => { row?.click(); });
    await settle();
    check('…it closes, and focus goes back to the ⋮ (not to the page)',
        !document.querySelector('[role="menu"]') && document.activeElement?.id === 'trigger', document.activeElement?.tagName);
    m.unmount();

    // The ⋮ menus written with DropdownMenu (the tree's rows, a category card).
    hovers = false;
    m = globalThis.__mount(host, 'dropdown');
    await m.render(true); await settle();
    await globalThis.__act(() => { document.getElementById('trigger').click(); });
    await settle();
    const menu = document.querySelector('[role="menu"]');
    check('a row\'s ⋮ menu (DropdownMenu) under a finger opens at the ⋮ too',
        !!menu && menu.parentElement === document.body && !document.querySelector('[data-bottom-sheet]'),
        document.querySelector('[data-bottom-sheet]') ? 'a bottom sheet' : 'nothing opened');
    m.unmount();

    // Select: its list hangs from the field under a finger as under a mouse,
    // with taller rows.
    m = globalThis.__mount(host, 'select');
    await m.render(true); await settle();
    await globalThis.__act(() => { document.getElementById('trigger').click(); });
    await settle();
    const list = document.querySelector('[role="listbox"]');
    const opts = [...(list?.querySelectorAll('[role="option"]') ?? [])];
    check('Select under a finger opens its list at the field, not as a sheet',
        !!list && !document.querySelector('[data-bottom-sheet]'), document.querySelector('[data-bottom-sheet]') ? 'a bottom sheet' : 'no list');
    check('…with rows a finger can hit (48px)', opts.length === 2 && opts.every(o => /(^|\s)min-h-12(\s|$)/.test(o.className)),
        opts.map(o => o.className.match(/\S*min-h-\S+/g)?.join(' ') ?? 'no min-h').join(' | '));
    m.unmount();
}

// ---------------------------------------------------------------------------
section('3. a switch alone on its line fills a narrow row, keeps its own width on a wide one');
if (bundled) {
    const row = document.createElement('div');
    document.body.appendChild(row);
    // 16px root: 360 is a phone, 1000 a desktop page (the line is 40rem).
    const onPhone = globalThis.__switchIn(row, 360);
    const onDesk = globalThis.__switchIn(row, 1000);
    check('block="narrow" in a 360px row spans it', /(^|\s)w-full(\s|$)/.test(onPhone), onPhone);
    check('…in a 1000px row it keeps its own width', /(^|\s)inline-flex(\s|$)/.test(onDesk) && !/(^|\s)w-full(\s|$)/.test(onDesk), onDesk);
    // The parent is the line it measures, so it must BE the line: in a flex
    // row (a settings row with the switch beside its sentence) it shares it.
    row.style.display = 'flex';
    const column = (row.style.flexDirection = 'column', globalThis.__switchIn(row, 360));
    row.style.flexDirection = 'row';
    const beside = globalThis.__switchIn(row, 360);
    check('…in a narrow flex column it spans it too', /(^|\s)w-full(\s|$)/.test(column), column);
    check('…in a narrow flex ROW, beside something else, it keeps its own width', !/(^|\s)w-full(\s|$)/.test(beside), beside);
    row.remove();
}
const projects = read('src/components/ProjectsGrid.tsx');
const projectsSwitch = projects.match(/<SegmentedControl<Show>[\s\S]*?\/>/)?.[0] ?? '';
check('the Projects page\'s Active / Finished / Archived switch fills a narrow row',
    /\bblock="narrow"/.test(projectsSwitch), projectsSwitch ? 'no block="narrow" on it' : 'no SegmentedControl<Show> found');

// ---------------------------------------------------------------------------
section('4. what floats from a button stacks above every dialog that can hold it');
{
    const zOf = (cls) => { const m = /\bz-(?:\[(\d+)\]|(\d+))/.exec(cls); return m ? Number(m[1] ?? m[2]) : null; };
    const pop = read('src/components/ui/Popover.tsx');
    const floatCls = /export const FLOAT_LAYER = '([^']+)'/.exec(pop)?.[1] ?? '';
    const FLOAT = zOf(floatCls);
    check('one shared layer for floating surfaces (FLOAT_LAYER in ui/Popover.tsx)', FLOAT != null, floatCls || 'none');
    // MenuPopover and PanelPopover take it, with no layer of their own beside it.
    const surfaces = [...pop.matchAll(/className=\{cx\('fixed[^)]*\)\}/g)].map(m => m[0]);
    check('…MenuPopover and PanelPopover take it',
        surfaces.length >= 2 && surfaces.every(s => s.includes('FLOAT_LAYER') && zOf(s) == null), surfaces.join(' | ') || 'none found');
    check('…Select\'s list takes it', /className=\{cx\('fixed[^']*', FLOAT_LAYER/.test(read('src/components/ui/Select.tsx')));
    check('…the model picker takes it', /className=\{cx\(FLOAT_LAYER\b/.test(read('src/components/ModelPicker.tsx')));
    if (FLOAT != null) {
        // Every full-screen layer (a dialog, a sheet, a viewer) and every
        // Modal layer can host a menu or a list, so each sits under FLOAT.
        // Named here: what sits at or above it, and why.
        const ABOVE = new Map([
            ['src/components/DesktopQuitScreen.tsx', 'the last thing the page shows: above everything'],
            ['src/components/SearchBar.tsx', 'the search palette holds no menu, list or picker'],
        ]);
        const SAME = new Set(['src/components/ui/Sheet.tsx']); // the bottom sheet, at the same layer
        const files = globSync('src/**/*.tsx', { cwd: ROOT }).map(f => f.replace(/\\/g, '/'));
        const over = [];
        const notAbove = [];
        for (const f of files) {
            const src = read(f);
            const layers = [
                ...src.split('\n').filter(l => /\binset-0\b/.test(l) && /\bfixed\b/.test(l)).map(zOf),
                ...[...src.matchAll(/layer(?:=|\s*=\s*)["']([^"']+)["']/g)].map(m => zOf(m[1])),
            ].filter(z => z != null);
            if (!layers.length) continue;
            const top = Math.max(...layers);
            if (ABOVE.has(f)) { if (top <= FLOAT) notAbove.push(`${f} z ${top}`); continue; }
            if (SAME.has(f) ? top > FLOAT : top >= FLOAT) over.push(`${f} z ${top}`);
        }
        check(`every dialog, sheet and viewer layer is under the floating layer (z ${FLOAT})`, over.length === 0, over.join(', '));
        check('…and what is named as above it is above it', notAbove.length === 0, notAbove.join(', '));
        const search = read('src/components/SearchBar.tsx');
        check('…the search palette still holds no menu, list or picker',
            !/<(MenuPopover|PanelPopover|Select|DropdownMenu|ModelPicker)\b/.test(search));
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
process.exit(fail ? 1 : 0);
