// tools/select-gates.mjs — the app's dropdown is the app's, on a mouse and on a finger.
//
// Run:  node tools/select-gates.mjs
//
// WHY. `ui/Select` was a restyled native <select>: the closed box was ours, the
// list it opened was the operating system's — on Windows a square grey panel
// with a light-grey highlight under a dark theme, in the system font (21 Oct
// 2026), and on a phone the platform's own picker. It is now a combobox button
// with our own list (a mouse) or a bottom sheet (a finger). That trades the
// browser's free behaviour for ours, so this holds the behaviour a native
// select gave for nothing:
//   - the options are read from the same `<option>` children, fragments and
//     numbers included, and `onChange` hands back the value as a string;
//   - the keys: ↑/↓ Home/End PageUp/PageDown, Enter/Space choose, Escape and
//     Tab close, type-ahead open and closed, disabled rows stepped over;
//   - focus stays on the box (aria-activedescendant), Escape is CLAIMED (a page
//     listening on the window does not also act) and the letter shortcuts stand
//     down on it, as they did on a select;
//   - a finger gets a modal sheet titled with the field's label;
//   - no native <select> is left in src/, so no list of the OS's comes back.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// ---------------------------------------------------------------------------
section('no native <select> is left to open the operating system’s list');
{
    const hits = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) walk(p);
            else if (/\.tsx$/.test(name) && /<select\b/.test(readFileSync(p, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))) hits.push(relative(root, p));
        }
    };
    walk(join(root, 'src'));
    check('no `<select` element in any src/**/*.tsx', hits.length === 0, hits.join(', '));
    const before = execFileSync('git', ['show', 'b68e7f5:src/components/ui/Field.tsx'], { cwd: root, encoding: 'utf8' });
    check('control: the pre-fix Field.tsx rendered one, so the scan can see one', /<select\b/.test(before));
}

// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
const { window } = dom;
for (const k of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'Event', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The pointer is the test's to set: a mouse (hover) or a finger (none).
let hover = true;
window.matchMedia = (q) => ({
    matches: /hover:\s*hover/.test(q) ? hover : /pointer:\s*fine/.test(q) ? hover : false,
    media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { },
});
if (!window.HTMLElement.prototype.scrollTo) window.HTMLElement.prototype.scrollTo = function () { };

mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true });
const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'select-gates-'));
const out = join(scratch, 'bundle.cjs');
await esbuild.build({
    stdin: {
        contents: `
            import * as React from 'react';
            import { createRoot } from 'react-dom/client';
            import { Select, readOptions, listKey, typeAhead } from './src/components/ui/Select';
            import { appMayTakeShortcut } from './src/utils/escapeKey';
            globalThis.__sel = { readOptions, listKey, typeAhead, appMayTakeShortcut };
            globalThis.__act = (fn) => React.act(fn);
            globalThis.__mount = (el, { fit = false, initial = 'en', placeholder = false } = {}) => {
                const r = createRoot(el);
                const changes = [];
                function Host() {
                    const [v, setV] = React.useState(initial);
                    return React.createElement('div', null,
                        React.createElement('label', { htmlFor: 'lang' }, 'Interface language'),
                        React.createElement(Select, { id: 'lang', fit, value: v, onChange: (x) => { changes.push(x); setV(x); } },
                            placeholder && React.createElement('option', { value: '', 'data-placeholder': true }, 'Pick a language…'),
                            React.createElement('option', { value: 'auto' }, 'Same as the browser'),
                            React.createElement(React.Fragment, null,
                                ['English', 'Deutsch', 'Nederlands', 'Norsk', 'Polski'].map((n, i) =>
                                    React.createElement('option', { key: n, value: ['en', 'de', 'nl', 'no', 'pl'][i], disabled: n === 'Norsk' }, n)))));
                }
                React.act(() => r.render(React.createElement(Host)));
                return { changes, unmount: () => React.act(() => r.unmount()) };
            };`,
        resolveDir: root,
        loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out,
    jsx: 'automatic', packages: 'external', logLevel: 'silent',
});
require(out);
const { readOptions, listKey, typeAhead, appMayTakeShortcut } = globalThis.__sel;
const act = globalThis.__act;
const doc = window.document;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });

// ---------------------------------------------------------------------------
section('the options are the <option> children, as a select read them');
{
    const React = require('react');
    const opts = readOptions([
        React.createElement('option', { key: 1, value: '' }, 'Trace a course…'),
        React.createElement(React.Fragment, { key: 2 },
            React.createElement('option', { value: 7 }, 'VWO Physics', ' (36/96)'),
            null, false,
            React.createElement('option', { value: 'x', disabled: true }, 'Off')),
        React.createElement('option', { key: 3 }, 'No value'),
    ]);
    check('four options through a fragment, nulls skipped', opts.length === 4, JSON.stringify(opts.map(o => o.value)));
    check('a number value arrives as a string, as e.target.value did', opts[1].value === '7');
    check('a label in several children is read as one text', opts[1].text === 'VWO Physics (36/96)');
    check('an empty value stays empty (the "none" row)', opts[0].value === '');
    check('no value: the label is the value, as in HTML', opts[3].value === 'No value');
    check('disabled is carried', opts[2].disabled === true && !opts[1].disabled);
    const marked = readOptions([
        React.createElement('option', { key: 1, value: '', 'data-placeholder': true }, 'Trace a course…'),
        React.createElement('option', { key: 2, value: '' }, 'Automatic'),
    ]);
    check('data-placeholder marks an instruction row; an empty value alone does not ("Automatic" is a choice)',
        marked[0].placeholder === true && !marked[1].placeholder);
}

section('the keys of an open list');
{
    const o = ['a', 'b', 'c', 'd', 'e'].map(v => ({ value: v, label: v, text: v, disabled: v === 'c' }));
    const mv = (k, at) => listKey(k, at, o)?.index;
    check('↓ moves one down', mv('ArrowDown', 0) === 1);
    check('↓ steps over a disabled row', mv('ArrowDown', 1) === 3);
    check('↑ steps over it too', mv('ArrowUp', 3) === 1);
    check('↓ on the last row stays (no wrap, like a platform list)', mv('ArrowDown', 4) === 4);
    check('↑ on the first stays', mv('ArrowUp', 0) === 0);
    check('Home / End', mv('Home', 3) === 0 && mv('End', 0) === 4);
    check('PageDown stops at the last row', listKey('PageDown', 0, o, 8).index === 4);
    check('PageUp stops at the first', listKey('PageUp', 4, o, 8).index === 0);
    check('Enter and Space choose', listKey('Enter', 1, o).kind === 'choose' && listKey(' ', 1, o).kind === 'choose');
    check('Escape and Tab close', listKey('Escape', 1, o).kind === 'close' && listKey('Tab', 1, o).kind === 'close');
    check('another key is not the list’s', listKey('F5', 1, o) === null);
}

section('type-ahead');
{
    const o = ['Same as the browser', 'English', 'Deutsch', 'Nederlands', 'Norsk', 'Polski', 'Русский']
        .map(t => ({ value: t, label: t, text: t, disabled: t === 'Norsk' }));
    check('one letter finds the first row starting with it', typeAhead('n', 1, o) === 3);
    check('the same letter again walks on (Norsk is disabled, so it wraps back)', typeAhead('nn', 3, o) === 3);
    check('a word finds its row', typeAhead('po', 0, o) === 5);
    check('Cyrillic is matched lower-cased', typeAhead('р', 0, o) === 6);
    check('nothing matches: -1, nothing moves', typeAhead('q', 1, o) === -1);
    const d = ['Dansk', 'Deutsch', 'Nederlands'].map(t => ({ value: t, label: t, text: t }));
    check('a letter pressed again on a row starting with it walks to the next one', typeAhead('dd', 0, d) === 1);
}

// ---------------------------------------------------------------------------
section('with a mouse: a list hung from the box, focus kept on the box');
const host = doc.getElementById('root');
let m = globalThis.__mount(host, { fit: true });
const box = () => doc.getElementById('lang');
check('the box is a combobox button that names the chosen value', box()?.getAttribute('role') === 'combobox'
    && box().getAttribute('aria-haspopup') === 'listbox' && /English/.test(box().textContent));
check('the box is labelled by its <label for>', box()?.labels?.[0]?.textContent === 'Interface language');
{
    const stack = box().querySelectorAll('.invisible');
    check('fit: every label is laid in the box, all but the chosen one invisible (the widest sets the width)',
        stack.length === 5 && ![...stack].some(s => s.textContent === 'English'), `${stack.length} hidden`);
}
check('closed, nothing in the body', !doc.querySelector('[role="listbox"]'));
await act(() => { box().focus(); box().click(); });
await flush();
let list = doc.querySelector('[role="listbox"]');
check('a press opens the list, portalled to the body', list?.parentElement === doc.body);
check('aria-expanded says so', box().getAttribute('aria-expanded') === 'true');
const rows = () => [...doc.querySelectorAll('[role="option"]')];
check('one row per option', rows().length === 6);
check('the chosen row is marked selected', rows()[1].getAttribute('aria-selected') === 'true');
check('the lit row starts on the chosen one, named by aria-activedescendant',
    box().getAttribute('aria-activedescendant') === rows()[1].id);
check('the list is named after the field', list.getAttribute('aria-label') === 'Interface language');
const key = (k, target = doc.activeElement) => act(() => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
});
await key('ArrowDown');
check('↓ lights the next row, focus still on the box',
    box().getAttribute('aria-activedescendant') === rows()[2].id && doc.activeElement === box());
check('the chosen row keeps the chosen tint and the lit one gets the grey, so the two never look alike',
    /\bbg-accent\/10\b/.test(rows()[1].className) && /\bbg-slate-100\b/.test(rows()[2].className) && !/bg-accent/.test(rows()[2].className),
    `${rows()[1].className} | ${rows()[2].className}`);
await key('ArrowDown'); await key('ArrowDown');
check('↓ steps over the disabled row', box().getAttribute('aria-activedescendant') === rows()[5].id);
await key('Enter');
check('Enter chooses it and hands the value over as a string', m.changes.at(-1) === 'pl', JSON.stringify(m.changes));
check('and closes the list, focus on the box', !doc.querySelector('[role="listbox"]') && doc.activeElement === box());
check('the box now shows the choice', /Polski/.test([...box().querySelectorAll('span > span')].find(s => !s.className.includes('invisible'))?.textContent ?? ''));

await act(() => { box().click(); });
await flush();
let windowSaw = 0;
const spy = (e) => { if (e.key === 'Escape') windowSaw++; };
window.addEventListener('keydown', spy);
await key('Escape');
window.removeEventListener('keydown', spy);
check('Escape closes without choosing', !doc.querySelector('[role="listbox"]') && m.changes.length === 1);
check('and is not heard by a page listening on the window', windowSaw === 0, `${windowSaw}`);

await key('d');
check('a letter on the CLOSED box chooses, as a select’s does', m.changes.at(-1) === 'de', JSON.stringify(m.changes));
check('the letter shortcuts (c, a) stand down on it', !appMayTakeShortcut({ key: 'a', defaultPrevented: false, target: box() }, doc));
await key('ArrowUp');
await flush();
check('↑ on the closed box opens the list', !!doc.querySelector('[role="listbox"]'));
await act(() => { rows()[3].click(); });
check('a press on a row chooses it', m.changes.at(-1) === 'nl' && !doc.querySelector('[role="listbox"]'));
await act(() => { box().click(); });
await flush();
await act(() => { doc.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })); });
check('a press outside closes it without choosing', !doc.querySelector('[role="listbox"]') && m.changes.at(-1) === 'nl');
await act(() => { box().click(); });
await flush();
await act(() => { rows()[4].click(); });
check('a press on a disabled row chooses nothing and leaves the list open',
    m.changes.at(-1) === 'nl' && !!doc.querySelector('[role="listbox"]'));
// "Same as the browser": a space typed inside a word is part of the word, not a choice.
await key('s'); await key(' ');
check('Space inside a typed word does not choose', m.changes.at(-1) === 'nl' && !!doc.querySelector('[role="listbox"]'));
{
    const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(() => { doc.activeElement.dispatchEvent(tab); });
    check('Tab closes the list and is left to the browser, so focus moves on',
        !doc.querySelector('[role="listbox"]') && !tab.defaultPrevented);
}
m.unmount();

// ---------------------------------------------------------------------------
section('with a finger: a sheet from the bottom, titled with the field');
hover = false;
m = globalThis.__mount(host);
await act(() => { box().click(); });
await flush();
const sheet = doc.querySelector('[role="dialog"][aria-modal="true"]');
check('a press opens a modal sheet, not a hung list', !!sheet && sheet.contains(doc.querySelector('[role="listbox"]')));
check('titled with the field’s label', sheet?.querySelector('h2')?.textContent === 'Interface language', sheet?.querySelector('h2')?.textContent);
check('the sheet’s list takes focus (it holds the keys there)', doc.activeElement === doc.querySelector('[role="listbox"]'));
check('rows a thumb can hit (min-h-12)', rows().every(r => r.className.includes('min-h-12')));
check('it has a close button', !!sheet?.querySelector('button[aria-label]'));
await key('ArrowDown');
await key('Enter');
check('the keys work in the sheet too', m.changes.at(-1) === 'de', JSON.stringify(m.changes));
check('choosing closes it and focus goes back to the box', !doc.querySelector('[role="dialog"]') && doc.activeElement === box());
await act(() => { box().click(); });
await flush();
await key('Escape');
check('Escape closes the sheet', !doc.querySelector('[role="dialog"]'));
await act(() => { box().click(); });
await flush();
await act(() => { rows()[3].click(); });
check('a tap on a row chooses it', m.changes.at(-1) === 'nl' && !doc.querySelector('[role="dialog"]'));
await act(() => { box().click(); });
await flush();
await act(() => { doc.querySelector('[role="dialog"] button[aria-label]').click(); });
check('its close button closes it without choosing', !doc.querySelector('[role="dialog"]') && m.changes.at(-1) === 'nl');

// Pulled down by the header, as a phone's sheets are.
const pull = (type, y) => act(() => {
    const ev = new window.PointerEvent(type, { bubbles: true, cancelable: true, clientY: y, pointerId: 7, pointerType: 'touch' });
    doc.querySelector('[data-sheet-handle]').dispatchEvent(ev);
});
await act(() => { box().click(); });
await flush();
await pull('pointerdown', 100); await pull('pointermove', 130); await pull('pointerup', 130);
check('a short pull on the header lets it spring back open', !!doc.querySelector('[role="dialog"]'));
await pull('pointerdown', 100); await pull('pointermove', 180);
check('the sheet follows the finger', /translateY\(80px\)/.test(doc.querySelector('[role="dialog"]').getAttribute('style') ?? ''),
    doc.querySelector('[role="dialog"]').getAttribute('style'));
await pull('pointerup', 260);
check('a long pull closes it without choosing', !doc.querySelector('[role="dialog"]') && m.changes.at(-1) === 'nl');

// A list taller than its sheet says there is more, until it is scrolled to the end.
{
    // Shadowed on HTMLElement for the check, and deleted after, which uncovers Element's own.
    const P = window.HTMLElement.prototype;
    const tops = new WeakMap();
    const isList = (el) => el.getAttribute('role') === 'listbox';
    Object.defineProperty(P, 'scrollHeight', { configurable: true, get() { return isList(this) ? 1000 : 0; } });
    Object.defineProperty(P, 'clientHeight', { configurable: true, get() { return isList(this) ? 300 : 0; } });
    Object.defineProperty(P, 'scrollTop', { configurable: true, get() { return tops.get(this) ?? 0; }, set(v) { tops.set(this, v); } });
    await act(() => { box().click(); });
    await flush();
    const lb = doc.querySelector('[role="listbox"]');
    check('a list with rows out of sight shows the "more below" cue', !!lb.querySelector('[data-more-below]'));
    await act(() => { lb.scrollTop = 700; lb.dispatchEvent(new window.Event('scroll')); });
    check('scrolled to its end, the cue goes', !lb.querySelector('[data-more-below]'));
    await key('Escape');
    for (const k of ['scrollHeight', 'clientHeight', 'scrollTop']) delete P[k];
}
m.unmount();

// ---------------------------------------------------------------------------
section('an instruction row ("Trace a course…") is never shown as the choice');
hover = true;
m = globalThis.__mount(host, { placeholder: true, initial: '' });
await act(() => { box().click(); });
await flush();
{
    const first = rows()[0];
    check('standing on it, it is not ticked', first.querySelector('svg')?.getAttribute('class')?.includes('invisible'));
    check('nor marked selected for a screen reader', first.getAttribute('aria-selected') === 'false');
    check('nor lit: no row carries a fill when the list opens on it', !rows().some(r => r.dataset.active) && !/\bbg-/.test(first.className),
        first.className);
    check('its text is muted, in the list and in the box',
        /text-slate-500/.test(first.className) && /text-slate-500/.test(box().querySelector('span').className),
        `${first.className} | ${box().querySelector('span').className}`);
}
await act(() => { rows()[2].click(); });
check('a real choice from it is ticked when the list opens again', (await (async () => {
    await act(() => { box().click(); }); await flush();
    return rows()[2].getAttribute('aria-selected') === 'true' && !rows()[2].querySelector('svg').getAttribute('class').includes('invisible');
})()));
await key('Escape');
m.unmount();

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
process.exit(fail ? 1 : 0);
