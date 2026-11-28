#!/usr/bin/env node
// exam-mark-gates.mjs — on the question screen of a mock or a look back,
// nothing moves unless the learner moved it.
//
// "Come back to this" used to be a quiet button with an amber dot, the same
// look as the grid's legend, so it read as plain text; pressing it swapped the
// label for a longer one, so the button grew and slid, and on a narrow card it
// wrapped and pushed the question down. Mounted in jsdom from the real
// `ExamFrame.tsx`:
//
//   1. the toggle is a framed button (the outlined `neutral` fill), its label
//      is the same marked and not, `aria-pressed` carries the state, a press
//      calls back once;
//   2. the course mock screen draws its mark with that toggle and no
//      state-dependent label;
//   3. the question row moves only when the current cell is out of sight (or
//      under a faded edge), never on a step to a cell already in view;
//   4. a look back's last button and its finish question do not call it a mock.
//
//   node tools/exam-mark-gates.mjs [--root DIR]   # DIR: another checkout; the pre-fix tree fails

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : repo;
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'MutationObserver', 'SVGSVGElement']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
class Observer { observe() { } unobserve() { } disconnect() { } }
globalThis.ResizeObserver = window.ResizeObserver = Observer;
window.matchMedia = (q) => ({ matches: q === '(pointer: fine)', media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Geometry jsdom does not lay out: the row's scroller is 300px wide; cell i
// sits at 6 + 46 i (40px cells, 6px gaps) minus what the row has scrolled,
// and the scroll stops at both ends as a browser's does (ten cells: 0..172).
let scrolled = 0;
const scrolls = [];
const MAX_SCROLL = 6 + 46 * 10 + 6 - 300;
window.HTMLElement.prototype.scrollBy = function (o) {
    scrolls.push(o?.left ?? 0);
    scrolled = Math.min(MAX_SCROLL, Math.max(0, scrolled + (o?.left ?? 0)));
};
window.HTMLElement.prototype.getBoundingClientRect = function () {
    const box = (left, width) => ({ left, right: left + width, width, top: 0, bottom: 40, height: 40, x: left, y: 0 });
    if (this.classList.contains('rail-scroll')) return box(0, 300);
    if (this.hasAttribute('data-question-cell')) {
        const i = [...this.closest('ul').querySelectorAll('[data-question-cell]')].indexOf(this);
        return box(6 + 46 * i - scrolled, 40);
    }
    return box(0, 0);
};

const cacheDir = join(repo, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(cacheDir, 'exam-mark-gates-'));
const out = join(scratch, 'bundle.cjs');

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });`,
    'store': `export const useStore = (sel) => sel({ examFocus: false, setExamFocus() { }, addToast() { } }); useStore.getState = () => ({}); useStore.setState = () => { };`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
    },
};

let mod = {};
try {
    await esbuild.build({
        stdin: { contents: `export * from './src/components/mockExam/ExamFrame';`, resolveDir: root, loader: 'tsx' },
        bundle: true, format: 'cjs', platform: 'node', outfile: out,
        jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
        nodePaths: [join(repo, 'node_modules')],
        external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'lucide-react'],
        define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
        plugins: [stubPlugin],
        logLevel: 'silent',
    });
    mod = require(out);
} catch (e) {
    ok('ExamFrame.tsx bundles', false, e.message.split('\n')[0]);
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const h = React.createElement;
const host = document.getElementById('root');
const app = createRoot(host);
const render = async (el) => { await act(async () => { app.render(el); }); };

try {
    section('1. the come-back toggle');
    const Toggle = mod.ComeBackToggle;
    ok('ExamFrame exports ComeBackToggle', typeof Toggle === 'function');
    if (typeof Toggle === 'function') {
        let presses = 0;
        await render(h(Toggle, { marked: false, onToggle: () => presses++ }));
        const off = host.querySelector('button');
        const offText = off?.textContent, offClass = off?.className ?? '';
        ok('it is a <button> carrying aria-pressed="false"', off?.getAttribute('aria-pressed') === 'false');
        ok('it has a frame at rest (an outline, not a quiet text button)', /(^|\s)border(\s|$)/.test(offClass), offClass);
        ok('it has an icon and a label', !!off?.querySelector('svg') && (offText ?? '').trim().length > 0, offText);
        await act(async () => { off.click(); });
        ok('a press calls back once', presses === 1, String(presses));
        await render(h(Toggle, { marked: true, onToggle: () => presses++ }));
        const on = host.querySelector('button');
        ok('marked: aria-pressed="true"', on?.getAttribute('aria-pressed') === 'true');
        ok('marked: the SAME label, so the button keeps its width', on?.textContent === offText, `${offText} -> ${on?.textContent}`);
        const offSet = offClass.split(/\s+/).filter(Boolean), onSet = (on?.className ?? '').split(/\s+/).filter(Boolean);
        const added = onSet.filter(c => !offSet.includes(c));
        ok('marked: only colours added (amber border, fill, text), the shape unchanged',
            added.length > 0 && offSet.every(c => onSet.includes(c)) && added.every(c => /^(dark:)?!(border|bg|text)-amber-/.test(c)),
            added.join(' '));
    }

    section('2. the course mock screen uses it');
    const screen = read('src/components/mockExam/CourseMock.tsx');
    ok('CourseMock draws the mark with <ComeBackToggle', /<ComeBackToggle\b/.test(screen));
    ok('no label switches on the mark ("Marked to come back to" is gone)', !/t\("Marked to come back to"\)/.test(screen));

    section('3. the question row moves only when it must');
    const Strip = mod.QuestionStrip;
    if (typeof Strip === 'function') {
        const items = Array.from({ length: 10 }, () => ({ answered: false, marked: false }));
        // Cells are named by their number on screen (index + 1). At scroll 0,
        // cell 5 spans 190-230 (clear of the right fade, 272-300) and cell 6
        // spans 236-276: on screen, but under the fade.
        const go = async (n) => { await render(h(Strip, { items, current: n - 1, onGo() { } })); };
        scrolled = 0; scrolls.length = 0;
        await go(1);
        scrolled = 0; const before = scrolls.length;
        for (const n of [2, 3, 4, 5]) await go(n);
        ok('a step to cells clear of the fade (2-5) does not scroll the row', scrolls.length === before, JSON.stringify(scrolls.slice(before)));
        await go(6);
        ok('a step to cell 6, on screen but under the faded edge, scrolls it clear', scrolls.length === before + 1 && scrolls.at(-1) > 0, JSON.stringify(scrolls.slice(before)));
        const afterSix = scrolled;
        await go(5);
        ok('stepping back to cell 5, now in sight, does not scroll', scrolls.length === before + 1 && scrolled === afterSix, JSON.stringify(scrolls.slice(before)));
        await go(10);
        ok('a step to a cell out of sight (10) scrolls it into sight', scrolls.length === before + 2 && scrolls.at(-1) > 0 && 6 + 46 * 9 - scrolled + 40 <= 300, JSON.stringify(scrolls.slice(before)));
        // The fade is 1.75rem: with the root at 48px (the text-size setting
        // writes it inline) the fade is 84px, so cell 5 (right edge 230) is
        // under it (edge 216) only if the fade follows the root size.
        document.documentElement.style.fontSize = '48px';
        scrolled = 0;
        await go(1);
        scrolled = 0; const big = scrolls.length;
        await go(5);
        ok('the faded edge follows the text size (cell 5 under a 1.75rem fade at 48px)', scrolls.length === big + 1, JSON.stringify(scrolls.slice(big)));
        document.documentElement.style.fontSize = '';
    } else ok('ExamFrame exports QuestionStrip', false);

    section('4. a look back is not called a mock');
    ok('the last button of a look back says Finish', /lookBack\s*\?\s*t\("Finish"\)\s*:\s*t\("Finish the mock"\)/.test(screen));
    ok('its finish question names the look back', /lookBack\s*\?\s*t\("Finish the look back\?"\)\s*:\s*t\("Finish the mock\?"\)/.test(screen));
    const en = JSON.parse(read('src/locales/en.json'));
    ok('"Finish the look back?" is in the English locale', typeof en['Finish the look back?'] === 'string');
} finally {
    await act(async () => { app.unmount(); });
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
