#!/usr/bin/env node
// placement-footer-gates.mjs — the placement probe's buttons stay on screen.
//
// The probe dialog was ONE scroller (`overflow-y-auto` on the dialog itself)
// with "Finish now" and "Next" at the bottom of the scrolled content. A long
// explanation under an answer pushed them past the dialog's edge: at 1280x800
// the learner saw the explanation and no way
// on. Now the dialog never scrolls, the body between header and footer does,
// and the buttons sit in a footer outside it.
//
// jsdom has no layout, so this reads the STRUCTURE the browser lays out from
// (the pixels were measured in Edge at 1280x800 and 390x844 for the PR):
//
//   1. no element from a footer button up to the dialog scrolls;
//   2. the dialog does not scroll, and caps its height (`vh`, then `dvh`);
//   3. the question and a long explanation are inside a scroller that sits
//      inside the dialog, so long content can still be read;
//   4. answering brings the verdict into that scroller's view, since Next is
//      always on screen and could otherwise be pressed unread.
//
//   node tools/placement-footer-gates.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'MutationObserver', 'SVGSVGElement']) if (window[k]) globalThis[k] = window[k];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
class Observer { observe() { } unobserve() { } disconnect() { } }
globalThis.ResizeObserver = window.ResizeObserver = Observer;
globalThis.IntersectionObserver = window.IntersectionObserver = Observer;
window.matchMedia = (q) => ({ matches: q === '(pointer: fine)', media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
window.HTMLElement.prototype.scrollIntoView = function () { };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const consoleError = console.error;
console.error = (...a) => { if (!/not wrapped in act/.test(String(a[0]))) consoleError(...a); };

const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(cacheDir, 'placement-footer-gates-'));
const out = join(scratch, 'bundle.cjs');

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });
        export const initReactI18next = { type: '3rdParty', init() { } };`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: { addToast() { }, theme: 'light', searchProviders: [], projects: [], currentProjectId: null, loadProjectData() { } }, subs: new Set() };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;
        useStore.setState = (p) => { g.__st.state = { ...g.__st.state, ...(typeof p === 'function' ? p(g.__st.state) : p) }; g.__st.subs.forEach(f => f()); };
        useStore.subscribe = (f) => { g.__st.subs.add(f); return () => g.__st.subs.delete(f); };
        export const themeKeyOf = () => 'light';
        export const isDarkTheme = () => false;`,
    'Markdown': `import { createElement } from 'react'; export default function Markdown({ content }) { return createElement('div', null, content); }`,
    'MathText': `import { createElement } from 'react'; export default function MathText({ content }) { return createElement('span', null, content); }`,
    'codeLanguages': `import { createElement } from 'react'; export const highlightLanguage = (l) => l; export default function SyntaxHighlighter({ children }) { return createElement('pre', null, children); }`,
    'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => (globalThis.__api?.[name] ?? (() => new Promise(() => { })))(...args) });
        let seq = 0; export const newAttemptId = () => 'attempt-' + (++seq);`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*Markdown$/ }, () => ({ path: 'Markdown', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*MathText$/ }, () => ({ path: 'MathText', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*codeLanguages$/ }, () => ({ path: 'codeLanguages', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
    },
};

let PlacementModal = null;
try {
    await esbuild.build({
        stdin: { contents: `export { default as PlacementModal } from './src/components/PlacementModal';`, resolveDir: root, loader: 'tsx' },
        bundle: true, format: 'cjs', platform: 'node', outfile: out,
        jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' }, packages: 'external',
        define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
        plugins: [stubPlugin], logLevel: 'silent',
    });
    ({ PlacementModal } = require(out));
} catch (e) {
    console.log(`  (could not bundle the dialog: ${String(e.message).split('\n').slice(0, 3).join(' | ')})`);
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const h = React.createElement;
const doc = window.document;
const act = (fn) => React.act(fn);
const settle = (ms = 30) => act(() => new Promise(r => setTimeout(r, ms)));

/** The Tailwind classes that make an element a scroll container. */
const SCROLLS = /(^|\s)(?:[a-z]+:)*overflow(?:-y)?-(?:auto|scroll)(\s|$)/;
const scrolls = (el) => SCROLLS.test(el.getAttribute('class') ?? '');
/** Every element from `el` up to and including `top`. */
const chain = (el, top) => { const out = []; for (let n = el; n; n = n.parentElement) { out.push(n); if (n === top) break; } return out; };
const button = (text) => [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === text) ?? null;

// An explanation long enough to fill a laptop screen.
const LONG = 'Write g(x) = e^{-1/x^2} for x ≠ 0 and g(0) = 0. '.repeat(40);

if (PlacementModal) {
    const question = { index: 0, nodeId: 63, nodeTitle: 'The function e to the minus one over x squared', question: 'Is every derivative of g at 0 equal to 0?', type: 'multiple_choice', options: ['Yes', 'No'], answered: false };
    globalThis.__api = {
        getPlacement: () => Promise.resolve({ probe: { id: 5, state: 'ready', total: 2, answeredCount: 0, questions: [question, { ...question, index: 1 }] }, summary: null }),
        answerPlacement: () => Promise.resolve({ correct: false, explanation: LONG, correctAnswer: 'Yes', probe: { id: 5, state: 'ready', total: 2, answeredCount: 1, questions: [{ ...question, answered: true }, { ...question, index: 1 }] } }),
    };
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const r = createRoot(host);
    await act(() => r.render(h(PlacementModal, { isOpen: true, onClose() { }, projectId: 1, projectName: 'Calculus' })));
    await settle();
    const dialog = doc.querySelector('[role="dialog"]');
    const skip = button("I don't know — skip");
    ok('the probe is asking: a question and its skip button', !!dialog && !!skip, doc.body.textContent.slice(0, 200));

    // jsdom lays nothing out, so the body is given the sizes of a phone sheet
    // holding a long question (2000px of content in a 400px window, scrolled
    // to the top) and its `scrollTo` is recorded: answering must bring the
    // verdict, which lands below the fold, into the body's view.
    const inner = dialog && [...dialog.querySelectorAll('*')].find(scrolls);
    const scrolledTo = [];
    if (inner) {
        Object.defineProperty(inner, 'scrollHeight', { configurable: true, get: () => 2000 });
        Object.defineProperty(inner, 'clientHeight', { configurable: true, get: () => 400 });
        inner.getBoundingClientRect = () => ({ top: -1000, bottom: -600, left: 0, right: 0, width: 0, height: 400, x: 0, y: -1000 });
        inner.scrollTo = (o) => scrolledTo.push(o?.top);
        const real = window.getComputedStyle.bind(window);
        globalThis.getComputedStyle = window.getComputedStyle = (el, p) => el === inner ? { overflowY: 'auto' } : real(el, p);
    }
    // The verdict box (it holds the explanation) lands 1500px down the body's
    // content, 300px tall: in view only for a body scrolled to 1400–1500.
    const VERDICT_AT = 1500, VERDICT_H = 300, VIEW = 400;
    const plainRect = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
        const isVerdict = /^rounded-lg p-3 /.test(this.getAttribute('class') ?? '') && this.textContent.includes(LONG.slice(0, 60));
        if (!isVerdict) return plainRect.call(this);
        const top = -1000 + VERDICT_AT;
        return { top, bottom: top + VERDICT_H, left: 0, right: 0, width: 0, height: VERDICT_H, x: 0, y: top };
    };
    await act(() => [...doc.querySelectorAll('[data-answer-option]')].find(b => b.textContent.trim() === 'No')?.click());
    await settle();
    window.HTMLElement.prototype.getBoundingClientRect = plainRect;
    ok('answering scrolls the body so the whole verdict is in its view',
        !!inner && scrolledTo.some(top => top <= VERDICT_AT && VERDICT_AT + VERDICT_H <= top + VIEW), `scrollTo calls: ${JSON.stringify(scrolledTo)}`);
    const next = button('Next'), finish = button('Finish now');
    ok('answered: the long explanation, "Next" and "Finish now" are on the page', doc.body.textContent.includes(LONG.slice(0, 60)) && !!next && !!finish);

    if (dialog && next && finish) {
        for (const [name, b] of [['Next', next], ['Finish now', finish]]) {
            // The dialog's own scroll is the short-window fallback (below), so
            // the chain stops under it: no scroller BETWEEN the button and it.
            const scroller = chain(b, dialog).filter(n => n !== dialog).find(scrolls);
            ok(`"${name}" is not inside anything that scrolls within the dialog`, !scroller,
                scroller ? `inside <${scroller.tagName.toLowerCase()} class="${scroller.getAttribute('class')}">` : '');
        }
        // The scroll that brings the verdict into view must not carry the
        // learner's place away with it: the "N of M answered" line scrolled
        // out of view along with the question it counts.
        const count = [...dialog.querySelectorAll('*')].find(e => e.children.length === 0 && /^\d+ of \d+ answered$/.test(e.textContent.trim()));
        const countScroller = count && chain(count, dialog).filter(n => n !== dialog).find(scrolls);
        ok('"1 of 2 answered" is on the page and not inside anything that scrolls', !!count && !countScroller,
            !count ? 'no "answered" line' : countScroller ? `inside <${countScroller.tagName.toLowerCase()} class="${countScroller.getAttribute('class')}">` : '');
        const cls = dialog.getAttribute('class') ?? '';
        // CodeRabbit on #188: with the dialog clipping, a window shorter than
        // header + footer (a phone on its side, a zoomed page) cut Next off
        // with no way to reach it. The dialog scrolls, as a fallback only: the
        // body is the flex child that gives up its height first (next checks).
        ok('the dialog can scroll when even its header and footer do not fit, never clips them', scrolls(dialog) && !/(^|\s)overflow(?:-y)?-hidden(\s|$)/.test(cls), cls);
        // jsdom lays nothing out, so the column itself is read from the class:
        // without `flex flex-col` the body's flex-1 does nothing, the dialog
        // scrolls as a whole and Next leaves a 1280x800 window again.
        ok('the dialog is a flex column, so the body (not the dialog) takes the scroll', /(^|\s)flex(\s|$)/.test(cls) && /(^|\s)flex-col(\s|$)/.test(cls), cls);
        // The cap is a CSS pair, `vh` then `dvh`: Tailwind would emit two
        // classes the other way round, and the `vh` one would win on a phone.
        const css = readFileSync(join(root, 'src', 'index.css'), 'utf8');
        // Since the dialog-footers PR the frame is ui/Dialog's DIALOG_SHELL,
        // whose cap is the shared `.modal-shell`.
        const rules = [...css.matchAll(/\.modal-shell\s*\{([^}]*)\}/g)].map(m => m[1]);
        const pairsInOrder = rules.length === 1 && rules.every(r => /max-height:\s*\d+vh;[\s\S]*max-height:\s*\d+dvh;/.test(r));
        // A cap past the window's height lets the footer leave the window.
        const caps = rules.flatMap(r => [...r.matchAll(/max-height:\s*(\d+(?:\.\d+)?)d?vh;/g)].map(m => Number(m[1])));
        ok('…and caps its height with a vh-then-dvh pair, within the window',
            /(^|\s)modal-shell(\s|$)/.test(cls) && pairsInOrder && caps.length === 2 && caps.every(v => v <= 100),
            `${cls} | ${rules.length} .modal-shell rule(s), caps ${JSON.stringify(caps)}`);
        const explanation = [...dialog.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.startsWith(LONG.slice(0, 60)));
        const body = explanation && chain(explanation, dialog).find(scrolls);
        ok('the explanation sits in a scroller inside the dialog', !!body && body !== dialog);
        // flex-1 lets it shrink below its content; its min-height is a small
        // floor (at most 8rem), so it, not the dialog, gives up height first.
        // Never zero: at 480x220 a zero floor left a sliver of body and the
        // question could not be read (measured in Edge).
        const bodyCls = body?.getAttribute('class') ?? '';
        const floor = /(?:^|\s)min-h-(\d+)(?:\s|$)/.exec(bodyCls);
        ok('…which is a flex child that shrinks below its content to a small, non-zero floor', !!body && /(^|\s)flex-1(\s|$)/.test(bodyCls) && !!floor && Number(floor[1]) >= 16 && Number(floor[1]) <= 32,
            bodyCls || 'no scroller');
    }
    await act(() => r.unmount());
    host.remove();
    globalThis.__api = undefined;
} else ok('the dialog bundles and mounts', false);

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
process.exit(fail ? 1 : 0);
