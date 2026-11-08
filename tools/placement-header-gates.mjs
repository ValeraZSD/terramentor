#!/usr/bin/env node
// placement-header-gates.mjs — what the placement probe's header says, and
// that the question stays where it is when it is answered.
//
// Three strangers read the old header over screenshots and agreed on three
// faults:
//
//   1. "0 of 12 answered" on the first question read as nothing happening.
//      The counter now names the question on screen: "Question 1 of 12".
//      Still no score (the dialog never says "correct" or "wrong").
//   2. The phase name, cut to "Phase 1: Building Polynomial Approximations..."
//      on a phone and jammed against the count. It is shown whole or not at
//      all: measured on its own box, never by a viewport breakpoint.
//   3. The topic name above the question was the accent colour and read as a
//      link. It is not one; it is muted text.
//
// And the dialog jumped when an answer was picked: the verdict box grew the
// dialog, a centred dialog recentred, a bottom sheet grew upward, and the
// question moved out from under the pointer. Now a dialog from `sm` up hangs
// from a fixed top (it grows downward only), and on a phone the sheet keeps
// one height while questions are asked.
//
// jsdom has no layout, so (4) reads the classes and the CSS the browser lays
// out from; the motion itself was measured in Edge for the PR.
//
//   node tools/placement-header-gates.mjs

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
const scratch = mkdtempSync(join(cacheDir, 'placement-header-gates-'));
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
const button = (text) => [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === text) ?? null;
const leaves = () => [...doc.querySelectorAll('[role="dialog"] *')].filter(e => e.children.length === 0);
const leafWith = (text) => leaves().find(e => e.textContent.trim() === text) ?? null;
/** The counter: the one leaf that says where the learner is in the probe. */
const counter = () => leaves().find(e => /\b\d+\b.*\b\d+\b/.test(e.textContent) && /(question|answered)/i.test(e.textContent))?.textContent.trim() ?? null;
/** How full the progress bar is drawn, in percent. */
const barFill = () => {
    const fill = [...doc.querySelectorAll('[role="dialog"] [style]')].find(e => /width:\s*[\d.]+%/.test(e.getAttribute('style') ?? ''));
    return fill ? Number(/width:\s*([\d.]+)%/.exec(fill.getAttribute('style'))[1]) : null;
};
const classOf = (el) => el?.getAttribute('class') ?? '';
/** Hidden from sight and from a screen reader, while keeping its box (so it
 *  can be measured again when the dialog widens). */
const unseen = (el) => /(^|\s)invisible(\s|$)/.test(classOf(el)) && el.getAttribute('aria-hidden') === 'true';

const SHORT_PHASE = 'Phase 1';
const LONG_PHASE = 'Phase 1: Building Polynomial Approximations from Derivatives';
const TOPIC = 'Spotting Cycles and General Formulas for the nth Derivative';

// jsdom lays nothing out. A phase line is given the measurements a phone
// gives it (the long title is 400px of text in a 150px box) and a laptop gives
// the short one (100px in 150px).
const realScrollWidth = Object.getOwnPropertyDescriptor(window.Element.prototype, 'scrollWidth');
const realClientWidth = Object.getOwnPropertyDescriptor(window.Element.prototype, 'clientWidth');
Object.defineProperty(window.HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
        const t = this.textContent.trim();
        if (t === LONG_PHASE) return 400;
        if (t === SHORT_PHASE) return 100;
        return realScrollWidth.get.call(this);
    },
});
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
        const t = this.textContent.trim();
        if (t === LONG_PHASE || t === SHORT_PHASE) return 150;
        return realClientWidth.get.call(this);
    },
});

const q = (index, phaseTitle, answered = false) => ({
    index, nodeId: 60 + index, nodeTitle: TOPIC, phaseTitle,
    question: `Question text ${index}`, type: 'multiple_choice', options: ['Yes', 'No'], answered,
});
const probeOf = (questions) => ({ id: 5, state: 'ready', total: questions.length, answeredCount: questions.filter(x => x.answered).length, questions });

async function mount(questions, answerResult = null) {
    globalThis.__api = {
        getPlacement: () => Promise.resolve({ probe: probeOf(questions), summary: null }),
        answerPlacement: (_id, i) => Promise.resolve({
            correct: false, explanation: 'Because.', correctAnswer: 'Yes',
            probe: probeOf(questions.map(x => x.index === i ? { ...x, answered: true } : x)),
            ...answerResult,
        }),
        finishPlacement: () => new Promise(() => { }),
    };
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const r = createRoot(host);
    await act(() => r.render(h(PlacementModal, { isOpen: true, onClose() { }, projectId: 1, projectName: 'Calculus' })));
    await settle();
    return async () => { await act(() => r.unmount()); host.remove(); };
}

if (PlacementModal) {
    // ---- 1. the counter names the question on screen --------------------------
    {
        const unmount = await mount([q(0, SHORT_PHASE), q(1, SHORT_PHASE), q(2, SHORT_PHASE)]);
        ok('first question: the counter reads "Question 1 of 3"', counter() === 'Question 1 of 3', `counter: ${JSON.stringify(counter())}`);
        ok('…and nothing in the dialog says "0 of 3"', !/(?<!\d)0 of 3(?!\d)/.test(doc.querySelector('[role="dialog"]')?.textContent ?? ''));
        ok('…the bar is empty before the first answer', barFill() === 0, `fill ${barFill()}%`);
        await act(() => [...doc.querySelectorAll('[data-answer-option]')].find(b => b.textContent.trim() === 'No')?.click());
        await settle();
        ok('answered: the counter still names the question on screen', counter() === 'Question 1 of 3', `counter: ${JSON.stringify(counter())}`);
        ok('…and the bar moves by one question', Math.abs(barFill() - 100 / 3) < 0.1, `fill ${barFill()}%`);
        await act(() => button('Next')?.click());
        await settle();
        ok('Next: "Question 2 of 3"', counter() === 'Question 2 of 3', `counter: ${JSON.stringify(counter())}`);
        // A skipped question is passed, not answered: the counter follows the
        // learner's place, the bar what is behind them.
        await act(() => button("I don't know — skip")?.click());
        await settle();
        ok('skipped: "Question 3 of 3", the bar at two questions behind', counter() === 'Question 3 of 3' && Math.abs(barFill() - 200 / 3) < 0.1,
            `counter: ${JSON.stringify(counter())}, fill ${barFill()}%`);
        await unmount();
    }
    {
        // A probe left after its first answer opens at the second question.
        const unmount = await mount([q(0, SHORT_PHASE, true), q(1, SHORT_PHASE), q(2, SHORT_PHASE)]);
        ok('resumed after one answer: "Question 2 of 3", the bar at one question', counter() === 'Question 2 of 3' && Math.abs(barFill() - 100 / 3) < 0.1,
            `counter: ${JSON.stringify(counter())}, fill ${barFill()}%`);
        await unmount();
    }

    // ---- 2. the phase is shown whole or not at all ----------------------------
    {
        const unmount = await mount([q(0, LONG_PHASE), q(1, SHORT_PHASE)]);
        const phase = leafWith(LONG_PHASE);
        ok('a phase name too long for its room is not shown cut off', !!phase && unseen(phase),
            phase ? `class="${classOf(phase)}" aria-hidden=${phase.getAttribute('aria-hidden')}` : 'no phase line at all');
        await act(() => button("I don't know — skip")?.click());
        await settle();
        const short = leafWith(SHORT_PHASE);
        ok('…and the next phase, which fits, is shown in full', !!short && !unseen(short) && !/(^|\s)truncate(\s|$)/.test(classOf(short)),
            short ? `class="${classOf(short)}"` : 'no phase line');
        await unmount();
    }

    // ---- 3. the topic line is text, not a link --------------------------------
    {
        const unmount = await mount([q(0, SHORT_PHASE)]);
        const topic = leafWith(TOPIC);
        const cls = classOf(topic);
        ok('the topic name above the question is not in the accent colour', !!topic && !/accent/.test(cls), cls || 'no topic line');
        ok('…it is muted text in both themes', /(^|\s)text-slate-500(\s|$)/.test(cls) && /(^|\s)dark:text-slate-400(\s|$)/.test(cls), cls);
        ok('…and nothing makes it look pressable', topic?.tagName !== 'A' && topic?.tagName !== 'BUTTON' && !/underline|cursor-pointer/.test(cls), `<${topic?.tagName.toLowerCase()} class="${cls}">`);

        // ---- 4. answering does not move the question ----------------------------
        const dialog = doc.querySelector('[role="dialog"]');
        const overlay = dialog?.parentElement;
        const dcls = classOf(dialog), ocls = classOf(overlay);
        ok('from sm up the dialog hangs from the top, so a verdict grows it downward', /(^|\s)sm:items-start(\s|$)/.test(ocls) && !/(^|\s)sm:items-center(\s|$)/.test(ocls), ocls);
        ok('…from the anchored frame (dialog-top)', /(^|\s)dialog-top(\s|$)/.test(dcls), dcls);
        ok('on a phone the sheet keeps one height while it asks (sheet-stable)', /(^|\s)sheet-stable(\s|$)/.test(dcls), dcls);

        const css = readFileSync(join(root, 'src', 'index.css'), 'utf8');
        // Every declaration of the rule inside its media query, in order.
        const ruleIn = (media, selector) => {
            const at = css.search(new RegExp(`@media\\s*\\(${media}\\)\\s*\\{[^@]*?\\.${selector}\\s*\\{`));
            if (at < 0) return null;
            const open = css.indexOf(`.${selector}`, at);
            return css.slice(css.indexOf('{', open) + 1, css.indexOf('}', open));
        };
        const top = ruleIn('min-width:\\s*640px', 'dialog-top');
        // The top margin plus the tallest the frame may get, plus the overlay's
        // 1rem a side, must fit the window, or the footer leaves the screen.
        const margin = top && /margin-top:\s*(\d+(?:\.\d+)?)d?vh;/.exec(top);
        const caps = top ? [...top.matchAll(/max-height:\s*([^;]+);/g)].map(m => m[1]) : [];
        const capFits = (c) => {
            const m = /calc\(\s*(\d+(?:\.\d+)?)d?vh\s*-\s*2rem/.exec(c) ?? /calc\(\s*(\d+(?:\.\d+)?)d?vh\s*-\s*var\(--safe-top\)\s*-\s*var\(--safe-bottom\)\s*-\s*2rem/.exec(c);
            return !!m && Number(margin[1]) + Number(m[1]) <= 100;
        };
        ok('…and its margin plus its tallest frame fit the window, in vh then dvh',
            !!margin && caps.length >= 2 && /\dvh/.test(caps[0]) && /dvh/.test(caps.at(-1)) && caps.every(capFits),
            top ? `margin ${margin?.[1]}vh, caps ${JSON.stringify(caps)}` : 'no .dialog-top rule under @media (min-width: 640px)');
        const sheet = ruleIn('max-width:\\s*639\\.98px', 'sheet-stable');
        ok('…the phone sheet\'s height is set, vh then dvh, clear of the status bar and home indicator',
            !!sheet && /height:\s*min\([^;]*\d+vh/.test(sheet) && /height:\s*min\([^;]*var\(--safe-top\)[^;]*var\(--safe-bottom\)/.test(sheet),
            sheet ?? 'no .sheet-stable rule under @media (max-width: 639.98px)');
        await unmount();
    }
    {
        // Only while it asks: the offer and the summary are short and stay short.
        globalThis.__api = { getPlacement: () => Promise.resolve({ probe: null, summary: null }) };
        const host = doc.createElement('div');
        doc.body.appendChild(host);
        const r = createRoot(host);
        await act(() => r.render(h(PlacementModal, { isOpen: true, onClose() { }, projectId: 1, projectName: 'Calculus' })));
        await settle();
        const dcls = classOf(doc.querySelector('[role="dialog"]'));
        ok('the offer (before any question) keeps a content-sized sheet', !!button('Start') && !/(^|\s)sheet-stable(\s|$)/.test(dcls), dcls);
        await act(() => r.unmount());
        host.remove();
    }
    globalThis.__api = undefined;
} else ok('the dialog bundles and mounts', false);

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
process.exit(fail ? 1 : 0);
