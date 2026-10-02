// tools/keyboard-gates.mjs — who owns Escape, and a menu that stays on the card.
//
// Run:  node tools/keyboard-gates.mjs          (the working tree)
//       node tools/keyboard-gates.mjs --head   (the source halves against HEAD,
//                                               to watch them fail on the pre-fix code)
//
// WHY. Escape means something in a dozen places here, each a window listener
// of its own, and two of them answering one press is a bug nobody sees until it
// happens: the atlas canvas closed its card AND left full screen on one press.
// Tonight the atlas grew a third meaning for the key (a traced course → the
// clean map), so the rule is written down as a function and held here:
//   - a PAGE acts on Escape only when nothing else owns it — not while text is
//     typed, not under a modal dialog, not when someone already claimed it,
//     not when focus is outside the page (the docked assistant);
//   - the atlas takes back ONE layer per press: the card, the selection, the
//     traced course, full screen — and the surfaces register no Escape of their
//     own;
//   - a MENU claims its own Escape (so the page under it does not also act),
//     hands focus back to its button, and is placed from its measured box on
//     the button's own edge, inside the screen. "Look it up" hung from its
//     button's right edge and ran off the card's left edge on every phone.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const HEAD = process.argv.includes('--head');
const read = (p) => HEAD
    ? execFileSync('git', ['show', `HEAD:${p}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// ---------------------------------------------------------------------------
// Source halves first: these are the ones `--head` runs against the pre-fix
// tree, where each must fail.
section('the atlas has ONE Escape, and it takes back the traced course');

const atlasView = read('src/components/AtlasView.tsx');
const escapeBlock = /---- Escape -+([\s\S]*?)window\.removeEventListener\('keydown'/.exec(atlasView)?.[1] ?? '';
check('AtlasView registers the page’s Escape through the shared rule',
    /pageMayTakeEscape\(e,\s*rootRef\.current\)/.test(escapeBlock), 'no pageMayTakeEscape(e, rootRef.current) in an Escape block');
check('the first press closes the surface’s floating card',
    /stageRef\.current\?\.dismissCard\(\)/.test(escapeBlock));
check('the traced course is a layer, and clearing it stops the replay first',
    /layer === 'trace'\)\s*\{\s*s\.stop\(\);\s*setTraceId\(null\)/.test(escapeBlock));
check('the page root the rule measures focus against is the page itself',
    /<div ref=\{rootRef\}/.test(atlasView));
for (const f of ['src/components/atlas/AtlasMap.tsx', 'src/components/atlas/GlobeMap.tsx']) {
    const src = read(f);
    const acts = /const acts: Record<string, \(\) => void> = \{([\s\S]*?)\n {8}\};/.exec(src)?.[1] ?? '';
    const name = f.split('/').pop();
    check(`${name}: the canvas registers no Escape of its own (one key, one owner)`,
        acts.length > 0 && !/\bEscape\s*:/.test(acts), acts ? 'its key table still has an Escape' : 'no key table found');
    check(`${name}: it answers the page's "is a card open? close it"`,
        /dismissCard: \(\) => \{\s*if \(!hoverRef\.current && !pinnedRef\.current\) return false;/.test(src));
}

section('menus claim their own Escape');
const esb = read('src/components/ExternalSearchButton.tsx');
check('"Look it up" is a MenuPopover, not a box hung from the button’s right edge',
    /<MenuPopover\b/.test(esb) && !/className="[^"]*\babsolute right-0/.test(esb));
const dropdown = read('src/components/DropdownMenu.tsx');
check('the tree row’s ⋮ menu closes on Escape and hands focus back',
    /e\.key !== 'Escape'/.test(dropdown) && /triggerRef\.current\?\.querySelector<HTMLElement>\('button, \[tabindex\]'\)\?\.focus\(\)/.test(dropdown));
check('the tree row’s ⋮ menu is placed from its MEASURED box, not an assumed 144px',
    !/menuWidth = 144/.test(dropdown) && /placePopover\(/.test(dropdown));
const card = read('src/components/ProjectCard.tsx');
check('the project card’s ⋮ menu closes on Escape and hands focus back',
    /e\.key !== 'Escape'/.test(card) && /menuBtnRef\.current\?\.focus\(\)/.test(card));

section('a modal dialog owns Tab and Escape once, through one hook');
{
    const tryRead = (p) => { try { return read(p); } catch { return ''; } };
    const modal = read('src/components/Modal.tsx');
    const confirmDlg = read('src/components/ConfirmDialog.tsx');
    const hook = tryRead('src/hooks/useDialogFocus.ts');
    check('Modal and ConfirmDialog take Escape and Tab from useDialogFocus',
        /useDialogFocus\(/.test(modal) && /useDialogFocus\(/.test(confirmDlg));
    check('neither keeps a keydown listener of its own (two dialogs answering one press)',
        !/addEventListener\('keydown'/.test(modal) && !/addEventListener\('keydown'/.test(confirmDlg));
    check('only the topmost open dialog answers a key',
        /stack\[stack\.length - 1\] !== token\) return/.test(hook));
    check('a Tab that something already claimed (an editor) is left alone',
        /e\.key === 'Tab' && !e\.defaultPrevented/.test(hook));
}

section('Enter and Space act on the element that has them, not on the card around it');
{
    // `onActivateKey` makes a div with role="button" answer Enter and Space. A
    // project card is one, and it holds real buttons (Study, the ⋮ menu): a
    // key pressed on one of those BUBBLED to the card, which called
    // preventDefault — cancelling the button's own click — and opened the
    // card instead. The helper is pure, so the pre-fix file runs here too.
    const src = read('src/utils/a11y.ts');
    const { code } = await esbuild.transform(src, { loader: 'ts', format: 'cjs' });
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
    const { onActivateKey } = mod.exports;
    const card = { tag: 'card' }, study = { tag: 'Study button' };
    let calls = 0;
    const handler = onActivateKey(() => { calls++; });
    const key = (k, target) => { const e = { key: k, target, currentTarget: card, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; handler(e); return e; };
    let e = key('Enter', study);
    check('Enter on a button INSIDE the card does not open the card', calls === 0, `${calls} activation(s)`);
    check('and does not cancel that button\'s own click (no preventDefault)', !e.defaultPrevented);
    e = key(' ', study);
    check('Space on it is left alone too', calls === 0 && !e.defaultPrevented);
    let before = calls;
    e = key('Enter', card);
    check('Enter on the card itself still opens it', calls === before + 1 && e.defaultPrevented, `${calls - before}`);
    before = calls;
    e = key(' ', card);
    check('Space on the card itself still opens it (and does not scroll the page)', calls === before + 1 && e.defaultPrevented, `${calls - before}`);
    before = calls;
    key('a', card);
    check('another key does nothing', calls === before);
}

section('no row or card is a button with buttons inside it');
{
    // A role="button" div holding the drag handle, the chevron, Study or the ⋮
    // menu is read out as one button containing others (axe: nested-
    // interactive). The row stays a pointer target; its TITLE is the control.
    for (const [file, what] of [['src/components/Sidebar.tsx', 'sidebar row'], ['src/components/TreeItemRow.tsx', 'tree row'],
        ['src/components/ProjectCard.tsx', 'project card'], ['src/components/CategoryCard.tsx', 'category card']]) {
        const src = read(file);
        check(`the ${what} is not role="button"`, !/role="button"/.test(src));
        check(`…and its title is a real button that selects or opens it`,
            /<button\s+type="button"\s+onClick=\{\(e\) => \{ e\.stopPropagation\(\); (?:selectNode\(node\.id\)|if \(!isDragging\) (?:openProject\(project\.id\)|selectNode\(node\.id\))); \}\}/.test(src));
    }
    // The sidebar's own arrow-key handler takes Enter for its keyboard cursor;
    // a focused title button must keep its Enter, or Enter selects nothing.
    check('the sidebar leaves Enter to a focused control',
        /case 'Enter':[\s\S]{0,400}closest\('button, a\[href\], input, textarea, select'\)\) break;/.test(read('src/components/Sidebar.tsx')));
    // The ⋮ menu's own trigger is the control; a focusable wrapper round it
    // was a second Tab stop named "Open menu" holding the real button.
    const dd = read('src/components/DropdownMenu.tsx');
    check('the ⋮ menu does not wrap its button in another button', !/role="button"/.test(dd) && !/tabIndex=\{0\}/.test(dd));
    check('…and the button itself carries the menu\'s state', /'aria-haspopup': 'menu', 'aria-expanded': isOpen/.test(dd));
}

section('an expand/collapse toggle says what it is and which way it is');
{
    const sidebar = read('src/components/Sidebar.tsx');
    const toggle = /onClick=\{\(e\) => \{ e\.stopPropagation\(\); toggleExpanded\(node\.id\); \}\}([\s\S]*?)>/.exec(sidebar)?.[1] ?? '';
    check('the sidebar row\'s chevron has a name', /aria-label=/.test(toggle), 'the button is an icon with no name');
    check('and reports its state (aria-expanded)', /aria-expanded=\{isExpanded\}/.test(toggle));
    // The workspace tree draws its own rows with the same chevron.
    const row = read('src/components/TreeItemRow.tsx');
    const rowToggle = /onClick=\{\(e\) => \{ e\.stopPropagation\(\); toggleExpanded\(node\.id\); \}\}([\s\S]*?)>/.exec(row)?.[1] ?? '';
    check('the tree row\'s chevron has a name', /aria-label=/.test(rowToggle), 'the button is an icon with no name');
    check('and reports its state', /aria-expanded=\{isExpanded\}/.test(rowToggle));
    // The category card's toggle says what it DOES in words ("Collapse (8
    // items)"). A state beside a verb that flips is announced as "Collapse,
    // expanded" — one or the other, never both.
    const card = read('src/components/CategoryCard.tsx');
    const cardToggle = /onClick=\{\(e\) => \{ e\.stopPropagation\(\); toggleExpanded\(node\.id\); \}\}([\s\S]*?)<\/button>/.exec(card)?.[1] ?? '';
    check('the category card\'s toggle is a verb or a state, not both',
        !(/aria-expanded=/.test(cardToggle) && /t\("Collapse"\)/.test(cardToggle)));
}

if (HEAD) {
    console.log(`\n${pass} passed, ${fail} failed (source halves against HEAD)`);
    process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'MutationObserver', 'KeyboardEvent', 'PointerEvent', 'MouseEvent']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });

const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'keyboard-gates-'));
const out = join(scratch, 'bundle.cjs');
await esbuild.build({
    stdin: {
        contents: `
            import * as React from 'react';
            import { createRoot } from 'react-dom/client';
            import * as keys from './src/utils/escapeKey';
            import { placePopover, MenuPopover, MenuItem } from './src/components/ui/Popover';
            globalThis.__keys = keys;
            globalThis.__place = placePopover;
            globalThis.__act = (fn) => React.act(fn);
            globalThis.__mountMenu = (el) => {
                const r = createRoot(el);
                let closes = 0;
                function Host({ open }) {
                    const btn = React.useRef(null);
                    return React.createElement(React.Fragment, null,
                        React.createElement('button', { ref: btn, id: 'trigger' }, 'Look it up'),
                        React.createElement(MenuPopover, { open, onClose: () => { closes++; }, anchorRef: btn, label: 'Look this up elsewhere' },
                            React.createElement(MenuItem, { href: 'https://a.example/' }, 'Search Google'),
                            React.createElement(MenuItem, { href: 'https://b.example/' }, 'Watch on YouTube'),
                            React.createElement(MenuItem, { onSelect: () => { } }, 'Third')));
                }
                const render = (open) => React.act(() => r.render(React.createElement(Host, { open })));
                return { render, closes: () => closes, unmount: () => React.act(() => r.unmount()) };
            };`,
        resolveDir: root,
        loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out,
    jsx: 'automatic', packages: 'external', logLevel: 'silent',
});
require(out);
const { pageMayTakeEscape, atlasEscapeLayer, isTextEntry } = globalThis.__keys;
const place = globalThis.__place;
const doc = window.document;

// ---------------------------------------------------------------------------
section('a page acts on Escape only when nothing else owns it');

const page = doc.createElement('div'); page.id = 'page';
const canvas = doc.createElement('canvas'); canvas.tabIndex = 0; page.append(canvas);
const text = doc.createElement('input'); text.type = 'text'; page.append(text);
const search = doc.createElement('input'); search.type = 'search'; page.append(search);
const box = doc.createElement('input'); box.type = 'checkbox'; page.append(box);
const select = doc.createElement('select'); page.append(select);
const area = doc.createElement('textarea'); page.append(area);
const drawer = doc.createElement('aside'); const drawerBtn = doc.createElement('button'); drawer.append(drawerBtn);
doc.body.append(page, drawer);
const esc = (target, extra = {}) => ({ key: 'Escape', defaultPrevented: false, target, ...extra });

check('focus on the map’s canvas', pageMayTakeEscape(esc(canvas), page, doc));
check('focus nowhere (the body)', pageMayTakeEscape(esc(doc.body), page, doc));
check('focus on the course picker just used (a closed select is not typing)', pageMayTakeEscape(esc(select), page, doc));
check('a checkbox is not typing either', pageMayTakeEscape(esc(box), page, doc));
check('NOT while typing in a text field', !pageMayTakeEscape(esc(text), page, doc));
check('NOT in a search field (Escape clears it)', !pageMayTakeEscape(esc(search), page, doc));
check('NOT in a textarea', !pageMayTakeEscape(esc(area), page, doc));
check('NOT mid-composition (an IME owns the key)', !pageMayTakeEscape(esc(canvas, { isComposing: true }), page, doc));
check('NOT when something already claimed it', !pageMayTakeEscape(esc(canvas, { defaultPrevented: true }), page, doc));
check('NOT when focus is outside the page (the docked assistant beside it)', !pageMayTakeEscape(esc(drawerBtn), page, doc));
check('NOT another key', !pageMayTakeEscape({ key: 'Enter', defaultPrevented: false, target: canvas }, page, doc));
const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
doc.body.append(dialog);
check('NOT under a modal dialog (it closes on the same press)', !pageMayTakeEscape(esc(canvas), page, doc));
dialog.remove();
check('contentEditable counts as typing', (() => { const d = doc.createElement('div'); d.contentEditable = 'true'; return isTextEntry(d); })()
    || /isContentEditable/.test(read('src/utils/escapeKey.ts')));

section('one press, one layer: the selection, then the trace, then full screen');
check('everything open: the selection goes first',
    atlasEscapeLayer({ selected: true, traced: true, fullscreen: true }) === 'selection');
check('a traced course with nothing selected: the trace goes (the clean map)',
    atlasEscapeLayer({ selected: false, traced: true, fullscreen: true }) === 'trace');
check('full screen is last', atlasEscapeLayer({ selected: false, traced: false, fullscreen: true }) === 'fullscreen');
check('nothing open: Escape is left alone (not claimed)', atlasEscapeLayer({ selected: false, traced: false, fullscreen: false }) === null);

// ---------------------------------------------------------------------------
section('a menu is placed on its button’s edge, inside the screen');

const phone = { width: 390, height: 844 };
const desk = { width: 1440, height: 900 };
const menu = { width: 208, height: 96 };
// The answer help's "Look it up", measured: at the left of a feed card on a phone.
const leftBtn = { left: 132, top: 500, right: 262, bottom: 544 };
let p = place(leftBtn, menu, phone);
check('opens on the button’s LEFT edge when it fits', p.left === 132 && p.top === 548 && p.side === 'below', JSON.stringify(p));
// The pre-fix anchoring (`absolute right-0`) put its left edge at right − width.
check('control: the old right-edge anchoring ran off the card for a button near the left',
    leftBtn.right - menu.width < 132 && 24 + 60 - menu.width < 0);
const nearLeft = { left: 24, top: 500, right: 84, bottom: 544 };
check('a button at the screen’s left edge still gets a menu inside the screen',
    place(nearLeft, menu, phone).left >= 8);
const nearRight = { left: 300, top: 500, right: 370, bottom: 544 };
p = place(nearRight, menu, phone);
check('near the right edge it lines up with the button’s RIGHT edge instead',
    p.left === 370 - 208, JSON.stringify(p));
check('and never past the screen', p.left + 208 <= 390 - 8);
p = place({ left: 600, top: 820, right: 700, bottom: 860 }, menu, desk);
check('no room below: it opens ABOVE the button', p.side === 'above' && p.top === 820 - 4 - 96, JSON.stringify(p));
p = place({ left: 10, top: 10, right: 50, bottom: 50 }, { width: 500, height: 96 }, phone);
check('wider than the screen: clamped and told the width it must fit',
    p.left === 8 && p.maxWidth === 390 - 16, JSON.stringify(p));
p = place({ left: 1300, top: 100, right: 1340, bottom: 140 }, menu, desk, { align: 'end' });
check('the icon form (end of a header row) lines up with the END edge', p.left === 1340 - 208, JSON.stringify(p));

// ---------------------------------------------------------------------------
section('the menu’s keyboard: first row on open, arrows, Escape hands focus back');

const host = doc.getElementById('root');
const m = globalThis.__mountMenu(host);
m.render(true);
await globalThis.__act(async () => { await new Promise(r => setTimeout(r, 0)); });
const menuEl = doc.querySelector('[role="menu"]');
check('it is portalled to the body, out of the card it was written in', menuEl?.parentElement === doc.body);
const items = [...doc.querySelectorAll('[role="menuitem"]')];
check('three rows, each a menuitem', items.length === 3);
check('the first row has focus on open', doc.activeElement === items[0], doc.activeElement?.textContent);
const key = (k) => globalThis.__act(() => { doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
key('ArrowDown'); check('↓ moves to the next row', doc.activeElement === items[1]);
key('ArrowDown'); key('ArrowDown'); check('↓ past the last row wraps to the first', doc.activeElement === items[0]);
key('ArrowUp'); check('↑ from the first wraps to the last', doc.activeElement === items[2]);
key('Home'); check('Home goes to the first', doc.activeElement === items[0]);
key('End'); check('End goes to the last', doc.activeElement === items[2]);
let windowSaw = 0;
const spy = (e) => { if (e.key === 'Escape') windowSaw++; };
window.addEventListener('keydown', spy);
key('Escape');
window.removeEventListener('keydown', spy);
check('Escape asks the menu to close', m.closes() === 1, `${m.closes()} close(s)`);
check('and hands focus back to its button', doc.activeElement?.id === 'trigger', doc.activeElement?.tagName);
check('and is not heard by a page listening on the window', windowSaw === 0, `${windowSaw} window listener(s) saw it`);
// A mouse opens the menu and focus STAYS on the button (in Edge the first row
// refused focus while the menu was still hidden for measuring, and the keys,
// which listened on the menu, did nothing). The keys must work from there.
doc.getElementById('trigger').focus();
key('ArrowDown');
check('↓ with focus still on the button moves into the menu', doc.activeElement === items[0], doc.activeElement?.textContent);
doc.getElementById('trigger').focus();
key('Escape');
check('Escape with focus on the button closes the menu too', m.closes() === 2, `${m.closes()} close(s)`);
check('the first row is focused only once the menu is placed (hidden refuses focus)',
    /if \(open && placed\) focusItem\(menuRef\.current, 'first'\)/.test(read('src/components/ui/Popover.tsx')));
m.render(false);
check('closed, it leaves nothing in the body', !doc.querySelector('[role="menu"]'));
m.unmount();

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
process.exit(fail ? 1 : 0);
