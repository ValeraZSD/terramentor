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
//   2. UNDER A FINGER (no hovering pointer, the rule `Select` always used), a
//      menu or panel opened from a button is the bottom sheet of `ui/Sheet.tsx`
//      — one sheet: `Select`'s list, every `MenuPopover`, every `PanelPopover`.
//      Held by mounting them in jsdom, and by reading the source for menus that
//      are placed by hand (their own `placePopover` call, their own portalled
//      menu panel, a panel hung `absolute … top-full` from its button).
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
                globalThis.__pop = Pop;
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
}

// ---------------------------------------------------------------------------
section('2. under a finger, what opens from a button is the ONE bottom sheet');
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
    // ModelPicker is a search field over a long list: the keyboard comes up,
    // and a sheet at the bottom of the layout viewport would sit under it. It
    // floats, placed in the same room.
    check('the model picker (a typed search) floats in the visual viewport less the insets',
        /popoverBounds\(\)/.test(read('src/components/ModelPicker.tsx')));
    check('…and moves when the keyboard it raises shrinks the visual viewport',
        /followVisualViewport\(/.test(read('src/components/ModelPicker.tsx')));
    // One sheet.
    const handles = files.filter(f => /data-sheet-handle/.test(read(f)) && f !== 'src/components/AtlasView.tsx');
    check('one sheet: only ui/Sheet.tsx draws a pull handle (the atlas\'s index is a page, not an opener)',
        handles.length === 1 && handles[0] === 'src/components/ui/Sheet.tsx', handles.join(', ') || 'none');
    check('Select opens that sheet, by the same rule', /<BottomSheet\b/.test(read('src/components/ui/Select.tsx')) && /opensAsSheet\(\)/.test(read('src/components/ui/Select.tsx')));
    check('MenuPopover and PanelPopover open it', (read('src/components/ui/Popover.tsx').match(/<BottomSheet\b/g) ?? []).length >= 2);
    const sheet = read('src/components/ui/Sheet.tsx');
    check('the sheet clears the status bar and the sides, and pads the home indicator',
        /safe-pt-0 safe-px-0/.test(sheet) && /safe-pb-0/.test(sheet));
}

const host = document.getElementById('root');
const settle = () => globalThis.__act(async () => { await new Promise(r => setTimeout(r, 30)); });
const pressKey = (k) => globalThis.__act(() => { document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const dialogOf = (el) => el?.closest('[role="dialog"][aria-modal="true"]');
// A press as a finger or a mouse makes it: pointerdown, then click.
const press = (el) => globalThis.__act(() => {
    el?.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});
const inside = (kind, root) => root?.querySelector(kind === 'menu' ? '[role="menuitem"]' : '#inside');

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
        await press(inside(kind, surface));
        check('…a press inside it is not a press on the card it opened from', m.log.card === 0, `${m.log.card} event(s) reached the card`);
        await m.render(false); m.unmount();

        // A finger: the sheet.
        hovers = false;
        m = globalThis.__mount(host, kind);
        await m.render(false);
        document.getElementById('trigger').focus();
        await m.render(true); await settle();
        const sheet = document.querySelector('[data-bottom-sheet]');
        const dlg = sheet?.querySelector('[role="dialog"][aria-modal="true"]');
        check(`${what} under a finger opens as the bottom sheet`, !!dlg, sheet ? 'a sheet with no modal dialog' : 'no sheet');
        const title = dlg && document.getElementById(dlg.getAttribute('aria-labelledby'))?.textContent;
        check('…titled with its name', title === (kind === 'menu' ? 'Project options' : 'Icon and colour'), String(title));
        if (kind === 'menu') {
            const items = [...(dlg?.querySelectorAll('[role="menu"] [role="menuitem"]') ?? [])];
            check('…its rows inside, the first one focused', items.length === 3 && document.activeElement === items[0], document.activeElement?.textContent);
        } else {
            check('…its controls inside', !!dlg?.querySelector('#inside'));
        }
        await pressKey('Escape');
        check('…Escape closes it', m.log.closes === 1, `${m.log.closes} close(s)`);
        await m.render(false); await settle();
        check('…and focus goes back to the button it opened from', document.activeElement?.id === 'trigger', document.activeElement?.tagName);
        await m.render(true); await settle();
        const backdrop = document.querySelector('[data-bottom-sheet] > [aria-hidden="true"]');
        await globalThis.__act(() => { backdrop?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
        check('…a tap outside it closes it', m.log.closes === 2, `${m.log.closes} close(s)`);
        await press(inside(kind, document.querySelector('[data-bottom-sheet]')));
        check('…and no tap on the sheet (the dimmed backdrop, a row) reaches the card behind it', m.log.card === 0, `${m.log.card} event(s) reached the card`);
        await m.render(false); m.unmount();
    }

    // The ⋮ menus written with DropdownMenu (the tree's rows, a category card).
    hovers = false;
    let m = globalThis.__mount(host, 'dropdown');
    await m.render(true); await settle();
    await globalThis.__act(() => { document.getElementById('trigger').click(); });
    await settle();
    let dlg = dialogOf(document.querySelector('[role="menu"]')) ?? dialogOf(document.querySelector('[data-bottom-sheet] [role="dialog"]'));
    check('a row\'s ⋮ menu (DropdownMenu) under a finger is the same sheet', !!dlg && !!document.querySelector('[data-bottom-sheet]'),
        document.querySelector('[role="menu"], .fixed') ? 'it floats' : 'nothing opened');
    m.unmount();

    // Select, for the record: the sheet it opened before is the shared one now.
    m = globalThis.__mount(host, 'select');
    await m.render(true); await settle();
    await globalThis.__act(() => { document.getElementById('trigger').click(); });
    await settle();
    check('Select under a finger opens the same sheet', !!document.querySelector('[data-bottom-sheet] [role="listbox"]'));
    m.unmount();
}

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
process.exit(fail ? 1 : 0);
