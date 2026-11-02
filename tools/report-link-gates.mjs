#!/usr/bin/env node
// report-link-gates.mjs — a wrong verdict says where to report it.
//
// In the outside review of "This is wrong" (#147) all three strangers missed the
// flag in an item's corner: told "Not quite" about an answer they knew was
// right, nothing on the screen said what to do. So a verdict that marks an
// answer the learner GAVE as wrong ends with
//
//     Think the app got this one wrong? Report it
//
// where "Report it" opens that item's flag's OWN dialog: one dialog, one
// request, one endpoint, never a second copy. Mounted in jsdom from the real
// components, with the api left pending (no server, no model):
//
//   1. the link opens the flag's dialog: one dialog on the page, the flag's
//      `onOpenChange` hears it (a timed drill holds its clock by that), it is
//      a button Tab reaches, and closing the dialog gives focus back to it;
//   2. no flag in its scope, no link: nothing else can open a dialog;
//   3. once the item stands reported the link is the reported line;
//   4. on every surface that marks an answer wrong — the feed question, the
//      quiz and mastery-check results, the drill, the placement probe, the
//      paper exercise — under a wrong verdict only: never on a right one, never
//      before an answer, never on a timeout or an answer the grader did not mark.
//
//   node tools/report-link-gates.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const LINE = 'Think the app got this one wrong?';
const LINK = 'Report it';
const REPORTED_LINE = "It won't count for or against you, and it won't be asked again. You can undo this.";

// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'MutationObserver', 'File', 'SVGSVGElement', 'HTMLCanvasElement']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
class Observer { observe() { } unobserve() { } disconnect() { } }
globalThis.ResizeObserver = window.ResizeObserver = Observer;
globalThis.IntersectionObserver = window.IntersectionObserver = Observer;
window.matchMedia = (q) => ({ matches: q === '(pointer: fine)', media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
window.HTMLElement.prototype.scrollIntoView = function () { };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// A request answered by a stub settles outside `act`; React says so on every
// update, which buries the results. Any other console error still prints.
const consoleError = console.error;
console.error = (...a) => { if (!/not wrapped in act/.test(String(a[0]))) consoleError(...a); };

const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(cacheDir, 'report-link-gates-'));
const out = join(scratch, 'bundle.cjs');

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });
        export const initReactI18next = { type: '3rdParty', init() { } };`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: {
            addToast() { }, theme: 'light', searchProviders: [], projects: [], currentProjectId: null,
            drillTimeScale: '1', setDrillTimeScale() { }, loadProjectData() { },
        }, subs: new Set() };
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
    // Every request stays pending unless a case answers it (`globalThis.__api`).
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

let mod = {};
try {
    await esbuild.build({
        stdin: {
            contents: `
                export * as RI from './src/components/ui/ReportItem';
                export { default as InlineQuestion } from './src/components/feed/InlineQuestion';
                export { default as AnswerReviewItem } from './src/components/answer/AnswerReviewItem';
                export { default as DrillPlayer } from './src/components/drills/DrillPlayer';
                export { default as PlacementModal } from './src/components/PlacementModal';
                export { useItemReports } from './src/utils/itemReportStore';`,
            resolveDir: root,
            loader: 'tsx',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: out,
        jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
        packages: 'external',
        define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
        plugins: [stubPlugin],
        logLevel: 'silent',
    });
    mod = require(out);
} catch (e) {
    console.log(`  (could not bundle the surfaces: ${String(e.message).split('\n').slice(0, 3).join(' | ')})`);
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const h = React.createElement;
const doc = window.document;
const act = (fn) => React.act(fn);
const settle = (ms = 30) => act(() => new Promise(r => setTimeout(r, ms)));
const { RI = {}, InlineQuestion, AnswerReviewItem, DrillPlayer, PlacementModal, useItemReports } = mod;
const ReportItem = RI.default;
const { ReportLink, ReportScope } = RI;

/** Mount `el` in a fresh host; returns the host and an unmount. */
async function mount(el) {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const r = createRoot(host);
    await act(() => r.render(el));
    return { host, rerender: (next) => act(() => r.render(next)), unmount: async () => { await act(() => r.unmount()); host.remove(); } };
}
const linkIn = (host) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === LINK) ?? null;
const says = (host, text) => host.textContent.includes(text);
const dialogs = () => doc.querySelectorAll('[role="dialog"]').length;
/** The link's sentence, and nothing else on screen saying it. */
const hasLink = (host) => !!linkIn(host) && says(host, LINE);
const hasNoLink = (host) => !linkIn(host) && !says(host, LINE);
const reportOf = (ref, kind = 'question') => ({ id: 7, ref, kind, reason: 'wrong', note: null, surface: 'feed', editable: false, undoneAt: null, canRewrite: false, rewrite: null });
const setReport = (ref, report) => act(() => useItemReports?.getState().setReport(ref, report));

const Q_REF = 'q:11111111-1111-4111-8111-111111111111';
const QUESTION = { uuid: Q_REF.slice(2), question: 'What is 2 + 9?', type: 'multiple_choice', options: ['10', '11', '12', '13'], correct_answer: '12', explanation: 'Because 12.' };

// ---------------------------------------------------------------------------
section('1. "Report it" opens the flag\'s own dialog, by keyboard as well');
{
    const ready = !!(ReportItem && ReportLink && ReportScope && useItemReports);
    ok('ui/ReportItem exports the link and the scope that ties it to its flag', ready);
    if (ready) {
        const heard = [];
        const m = await mount(h(ReportScope, null,
            h(ReportItem, { itemRef: 'q:22222222-2222-4222-8222-222222222222', surface: 'feed', onOpenChange: (o) => heard.push(o) }),
            h('p', null, 'Not quite'),
            h(ReportLink)));
        const link = linkIn(m.host);
        ok('the line under the verdict reads "Think the app got this one wrong? Report it"', hasLink(m.host), m.host.textContent);
        ok('…"Report it" is a button Tab reaches (not disabled, not taken out of the order)',
            link?.tagName === 'BUTTON' && link.type === 'button' && !link.disabled && link.tabIndex >= 0, link?.outerHTML);
        ok('…its sentence is a polite live region, and a finger gets a 44px hit area that does not move the line',
            link?.closest('p')?.getAttribute('aria-live') === 'polite' && /(^| )touch:py-3( |$)/.test(link?.className ?? '') && /(^| )touch:-my-3( |$)/.test(link?.className ?? ''),
            link?.closest('p')?.outerHTML?.slice(0, 160));
        link?.focus();
        await act(() => link?.click());
        await settle();
        ok('pressing it opens ONE dialog, the flag\'s', dialogs() === 1 && doc.body.textContent.includes("What's wrong with it?"), `dialogs: ${dialogs()}`);
        ok('…and the flag hears it open (a timed drill holds its clock by that)', heard[0] === true, JSON.stringify(heard));
        const cancel = [...doc.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Cancel');
        await act(() => cancel?.click());
        await settle();
        ok('closing it leaves no dialog, the flag hears that too, and focus is back on "Report it"',
            dialogs() === 0 && heard.at(-1) === false && doc.activeElement === linkIn(m.host),
            `dialogs ${dialogs()}, heard ${JSON.stringify(heard)}, focus ${doc.activeElement?.outerHTML?.slice(0, 80)}`);
        const flag = m.host.querySelector('button[aria-label="This is wrong"]');
        await act(() => flag?.click());
        await settle();
        ok('the corner flag opens the same one dialog as before', dialogs() === 1);
        await act(() => [...doc.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Cancel')?.click());
        await settle();
        await m.unmount();
    }
}

section('1b. two items on one screen: each "Report it" opens its OWN item');
if (ReportItem && ReportLink && ReportScope && AnswerReviewItem) {
    // A results list: two rows, each its own scope. The dialog asks the server
    // for the item it was opened on, so the ref it asks for names the item.
    const asked = [];
    globalThis.__api = { itemReportTarget: (ref) => { asked.push(ref); return new Promise(() => { }); } };
    const A = 'q:55555555-5555-4555-8555-555555555555';
    const B = 'q:66666666-6666-4666-8666-666666666666';
    const row = (ref, stem) => h(AnswerReviewItem, {
        question: { ...QUESTION, question: stem, uuid: ref.slice(2) }, answer: '11', correct: false, nodeId: 1, surface: 'quiz-review',
        report: h(ReportItem, { itemRef: ref, surface: 'quiz', listed: true }),
    });
    const m = await mount(h('div', null, row(A, 'Row A?'), row(B, 'Row B?')));
    const links = [...m.host.querySelectorAll('button')].filter(b => b.textContent.trim() === LINK);
    ok('each wrong row has its own line', links.length === 2, `${links.length} links`);
    await act(() => links[1]?.click());
    await settle();
    ok('the second row\'s link opens one dialog, asking for the SECOND row\'s item only', dialogs() === 1 && asked.includes(B) && !asked.includes(A), JSON.stringify(asked));
    await act(() => [...doc.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Cancel')?.click());
    await settle();
    asked.length = 0;
    await act(() => links[0]?.click());
    await settle();
    ok('…and the first row\'s link the FIRST row\'s', dialogs() === 1 && asked.includes(A) && !asked.includes(B), JSON.stringify(asked));
    await act(() => [...doc.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Cancel')?.click());
    await settle();
    globalThis.__api = undefined;
    await m.unmount();
} else ok('two rows mount', false);

section('2. no flag in its scope, no link');
if (ReportLink && ReportScope) {
    const alone = await mount(h(ReportScope, null, h('p', null, 'Not quite'), h(ReportLink)));
    ok('a link with no flag beside it renders nothing (it never opens a dialog of its own)', hasNoLink(alone.host), alone.host.textContent);
    await alone.unmount();
    const outside = await mount(h('div', null, h(ReportLink)));
    ok('…nor one outside any scope', hasNoLink(outside.host), outside.host.textContent);
    await outside.unmount();
} else ok('the link exists', false);
{
    const control = read('src/components/ui/ReportItem.tsx');
    ok('the file holds one dialog: `<ReportItemDialog` once and `<Modal` once',
        (control.match(/<ReportItemDialog\b/g) || []).length === 1 && (control.match(/<Modal\b/g) || []).length === 1,
        `${(control.match(/<ReportItemDialog\b/g) || []).length} / ${(control.match(/<Modal\b/g) || []).length}`);
}

section('3. once the item is reported the link is the reported line');
if (ReportItem && ReportLink && ReportScope && useItemReports) {
    const ref = 'q:33333333-3333-4333-8333-333333333333';
    const m = await mount(h(ReportScope, null, h(ReportItem, { itemRef: ref, surface: 'quiz', listed: true }), h(ReportLink)));
    await setReport(ref, reportOf(ref));
    ok('reported: the reported line in its place, no link', !linkIn(m.host) && !says(m.host, LINE) && says(m.host, REPORTED_LINE), m.host.textContent);
    ok('…in the same polite live region, so a screen reader hears what the report did',
        [...m.host.querySelectorAll('p')].some(p => p.textContent.includes(REPORTED_LINE) && p.getAttribute('aria-live') === 'polite'));
    await setReport(ref, null);
    ok('undone: the link is back', hasLink(m.host), m.host.textContent);
    await m.unmount();
} else ok('the link exists', false);

section('3b. filed from the keyboard: focus lands on Undo, not on the page');
if (ReportItem && ReportLink && ReportScope && useItemReports) {
    // The button that opened the dialog is gone once the report is filed (the
    // link becomes the reported line, the flag becomes "Reported"), so the
    // dialog has nothing to hand focus back to.
    for (const [opener, ref] of [['"Report it"', 'q:77777777-7777-4777-8777-777777777777'], ['the corner flag', 'q:88888888-8888-4888-8888-888888888888']]) {
        globalThis.__api = {
            itemReportTarget: () => Promise.resolve({ item: null, kind: 'question', canRewrite: false, report: null }),
            reportItem: () => Promise.resolve({ report: reportOf(ref) }),
        };
        const m = await mount(h(ReportScope, null, h(ReportItem, { itemRef: ref, surface: 'quiz', listed: true }), h('p', null, 'Not quite'), h(ReportLink)));
        const button = opener === '"Report it"' ? linkIn(m.host) : m.host.querySelector('button[aria-label="This is wrong"]');
        button?.focus();
        await act(() => button?.click());
        await settle();
        await act(() => [...doc.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Report')?.click());
        await settle();
        const undo = m.host.querySelector('button[aria-label="Undo report"]');
        ok(`filed from ${opener}: the dialog is gone and focus is on Undo`,
            dialogs() === 0 && !!undo && doc.activeElement === undo,
            `dialogs ${dialogs()}, focus ${doc.activeElement?.outerHTML?.slice(0, 80)}`);
        await setReport(ref, null);
        globalThis.__api = undefined;
        await m.unmount();
    }
    // A report that was already there (loaded, or filed elsewhere) takes nothing.
    const ref = 'q:99999999-9999-4999-8999-999999999999';
    const m = await mount(h(ReportScope, null, h('input', { 'data-typing': '' }), h(ReportItem, { itemRef: ref, surface: 'quiz', listed: true }), h(ReportLink)));
    const typing = m.host.querySelector('input');
    typing.focus();
    await setReport(ref, reportOf(ref));
    await settle();
    ok('a report that arrives from the store (not filed here) leaves focus where it was', doc.activeElement === typing, doc.activeElement?.outerHTML?.slice(0, 80));
    await setReport(ref, null);
    await m.unmount();
} else ok('the link exists', false);

// ---------------------------------------------------------------------------
section('4a. the feed question: under "Not quite" only');
if (InlineQuestion && ReportItem) {
    const flag = () => h(ReportItem, { itemRef: Q_REF, surface: 'feed', inStream: true });
    const feed = (graded, reportedNote) => h(InlineQuestion, { question: QUESTION, graded, onGraded() { }, nodeId: 1, report: flag(), reportedNote });
    const m = await mount(feed(null));
    ok('before an answer: no link', hasNoLink(m.host), m.host.textContent.slice(0, 200));
    await m.rerender(feed({ correct: false, answer: '11', explanation: 'Because 12.' }));
    await settle();
    ok('marked wrong: the link, after the key', hasLink(m.host) && m.host.textContent.indexOf('Not quite') < m.host.textContent.indexOf(LINE), m.host.textContent.slice(0, 300));
    if (linkIn(m.host)) {
        await act(() => linkIn(m.host).click());
        await settle();
        ok('…and it opens the question\'s flag dialog', dialogs() === 1);
        await act(() => [...doc.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Cancel')?.click());
        await settle();
    } else ok('…and it opens the question\'s flag dialog', false, 'no link');
    await m.rerender(feed({ correct: true, answer: '12', explanation: 'Because 12.' }));
    ok('marked right: no link', hasNoLink(m.host));
    await m.rerender(feed({ correct: false, unsure: true, answer: '11' }));
    ok('not marked (the grader was unsure): no link', hasNoLink(m.host));
    await setReport(Q_REF, reportOf(Q_REF));
    await m.rerender(feed({ correct: false, answer: '11' }, h('p', null, REPORTED_LINE)));
    ok('reported: the reported line once, no link', hasNoLink(m.host) && m.host.textContent.split(REPORTED_LINE).length === 2, m.host.textContent.slice(0, 300));
    await setReport(Q_REF, null);
    await m.unmount();
} else ok('the feed question mounts', false);

section('4b. a results row (quiz, mastery check): under a wrong answer the learner gave');
if (AnswerReviewItem && ReportItem) {
    const ref = 'q:44444444-4444-4444-8444-444444444444';
    const row = (o) => h(AnswerReviewItem, {
        question: { ...QUESTION, uuid: ref.slice(2) }, answer: '11', correct: false, nodeId: 1, surface: 'quiz-review',
        report: h(ReportItem, { itemRef: ref, surface: 'quiz', listed: true }), ...o,
    });
    const m = await mount(row({}));
    ok('marked wrong: the link', hasLink(m.host), m.host.textContent.slice(0, 300));
    await m.rerender(row({ correct: true, answer: '12' }));
    ok('marked right: no link', hasNoLink(m.host));
    await m.rerender(row({ answer: '' }));
    ok('no answer given: no link', hasNoLink(m.host));
    await m.rerender(row({ report: undefined }));
    ok('a row with no flag (the day ledger\'s read-back): no link', hasNoLink(m.host));
    await m.rerender(row({}));
    await setReport(ref, reportOf(ref));
    ok('reported: the reported line in the link\'s place', !linkIn(m.host) && !says(m.host, LINE) && says(m.host, REPORTED_LINE), m.host.textContent.slice(0, 400));
    await setReport(ref, null);
    await m.unmount();
} else ok('the results row mounts', false);

section('4c. the drill: under "Not quite", not on a right answer or a timeout');
if (DrillPlayer) {
    const items = [{ prompt: '2 + 2', answer: '4' }, { prompt: '3 + 3', answer: '6' }, { prompt: '4 + 4', answer: '8' }, { prompt: '5 + 5', answer: '10' }];
    const play = async (target) => {
        // A drill's key is `f` + 8 hex (`parseDrill`), or its item has no ref and no flag.
        const m = await mount(h(DrillPlayer, { spec: { nodeId: 1, key: 'fabcdef12', modes: ['choice'], items, ...(target ? { target } : {}) } }));
        const start = [...m.host.querySelectorAll('button')].find(b => b.textContent.includes('Start drill'));
        await act(() => start?.click());
        await settle();
        return m;
    };
    const current = (host) => items.find(i => [...host.querySelectorAll('div')].some(d => d.textContent.trim() === i.prompt));
    const options = (host) => [...host.querySelectorAll('[data-answer-option]')];
    const m = await play(null);
    // Without its flag every "no link" below would pass for nothing.
    ok('the item carries its flag', m.host.querySelectorAll('[aria-label="This is wrong"]').length === 1);
    ok('before an answer: no link', hasNoLink(m.host), m.host.textContent.slice(0, 200));
    let item = current(m.host);
    const right = options(m.host).find(b => b.textContent.trim() === item?.answer);
    await act(() => right?.click());
    ok('a right answer: no link', !!right && hasNoLink(m.host));
    await settle(800);
    item = current(m.host);
    const wrong = options(m.host).find(b => b.textContent.trim() !== item?.answer);
    await act(() => wrong?.click());
    await settle();
    ok('a wrong answer: the link, under "Not quite"', !!wrong && hasLink(m.host) && says(m.host, 'Not quite'), m.host.textContent.slice(0, 300));
    if (linkIn(m.host)) {
        await act(() => linkIn(m.host).click());
        await settle();
        ok('…and it opens the item\'s flag dialog', dialogs() === 1);
        await act(() => [...doc.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Cancel')?.click());
        await settle();
    } else ok('…and it opens the item\'s flag dialog', false, 'no link');
    await m.unmount();

    // The drill reads Date.now for its countdown: pin it to a fixed instant and
    // move it by hand, so no assertion depends on the machine's clock.
    const realNow = Date.now;
    const PINNED = Date.UTC(2026, 0, 5, 9, 0, 0);
    let shift = 0;
    Date.now = () => PINNED + shift;
    try {
        const timed = await play({ secondsPerItem: 1 });
        ok('the timed drill\'s item carries its flag too', timed.host.querySelectorAll('[aria-label="This is wrong"]').length === 1);
        shift += 5000;
        await settle(300);
        ok('a timeout ("Time!", no answer given): no link', says(timed.host, 'Time!') && hasNoLink(timed.host), timed.host.textContent.slice(0, 300));
        await timed.unmount();
    } finally { Date.now = realNow; }
} else ok('the drill mounts', false);

section('4d. the placement probe: under "We\'ll cover this one."');
if (PlacementModal) {
    const question = (i, answered = false) => ({ index: i, nodeId: 1, nodeTitle: 'Adding', question: `What is ${i + 2} + 2?`, type: 'multiple_choice', options: ['3', '4', '5', '6', '7'], answered });
    const probe = (answered) => ({ id: 5, state: 'ready', total: 2, answeredCount: answered.filter(Boolean).length, questions: [question(0, answered[0]), question(1, answered[1])] });
    globalThis.__api = {
        getPlacement: () => Promise.resolve({ probe: probe([false, false]), summary: null }),
        answerPlacement: (_id, i, answer) => Promise.resolve(i === 0
            ? { correct: false, explanation: '2 + 2 is 4.', correctAnswer: '4', probe: probe([true, false]) }
            : { correct: answer === '5', explanation: '3 + 2 is 5.', correctAnswer: '5', probe: probe([true, true]) }),
    };
    const m = await mount(h(PlacementModal, { isOpen: true, onClose() { }, projectId: 1, projectName: 'Arithmetic' }));
    await settle();
    const opt = (text) => [...doc.querySelectorAll('[data-answer-option]')].find(b => b.textContent.trim() === text);
    const pageHas = () => !![...doc.querySelectorAll('button')].find(b => b.textContent.trim() === LINK) && doc.body.textContent.includes(LINE);
    const pageHasNone = () => ![...doc.querySelectorAll('button')].find(b => b.textContent.trim() === LINK) && !doc.body.textContent.includes(LINE);
    ok('before an answer: no link', !!opt('3') && pageHasNone(), doc.body.textContent.slice(0, 200));
    await act(() => opt('3')?.click());
    await settle();
    ok('marked wrong: the link', doc.body.textContent.includes("We'll cover this one.") && pageHas(), doc.body.textContent.slice(0, 400));
    const probeFlagRef = 'probe:5:0';
    await setReport(probeFlagRef, reportOf(probeFlagRef));
    ok('reported: the reported line in the link\'s place', pageHasNone() && doc.body.textContent.includes(REPORTED_LINE), doc.body.textContent.slice(0, 500));
    await setReport(probeFlagRef, null);
    await act(() => [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Next')?.click());
    await settle();
    await act(() => opt('5')?.click());
    await settle();
    ok('marked right: no link', doc.body.textContent.includes('You already have this one.') && pageHasNone(), doc.body.textContent.slice(0, 300));
    globalThis.__api = undefined;
    await m.unmount();
} else ok('the placement probe mounts', false);

section('4e. the paper exercise: under a marked result with a point not met');
{
    // The photographed path needs a camera and a canvas; the rule is read off
    // the source: the card is one scope, and the line sits in the marked
    // result, shown only when a point was not met.
    const paper = read('src/components/feed/PracticeCard.tsx');
    ok('the card is one report scope, its flag inside it', /<ReportScope>[\s\S]*<ReportItem\b[\s\S]*<\/ReportScope>/.test(paper));
    // The block runs to the `)}` at its own indent.
    const result = paper.match(/\n( *)\{phase === 'result' && grade && \([\s\S]*?\n\1\)\}/)?.[0] ?? '';
    ok('the line is in the marked result, under a point not met', /grade\.results\.some\(r => !r\.met\) && <ReportLink\b/.test(result), result ? 'not under that condition' : 'no marked-result block');
    ok('…and not where the learner marked their own work', !/<ReportLink\b/.test(paper.replace(result, '')));
}

section('5. the words are in every language');
{
    const locales = ['de', 'en', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh'];
    const missing = [];
    for (const l of locales) {
        const j = JSON.parse(read(`src/locales/${l}.json`));
        for (const k of [LINE, LINK]) {
            // English is the key itself (the key is the text); every other language is not.
            if (typeof j[k] !== 'string' || !j[k].trim() || (l === 'en' ? j[k] !== k : j[k] === k)) missing.push(`${l}: ${k}`);
        }
    }
    ok('both strings are translated in all 12 locales', missing.length === 0, missing.join('; '));
    const control = read('src/components/ui/ReportItem.tsx');
    ok('…and reach the screen through t()', control.includes(`t("${LINE}")`) && control.includes(`t("${LINK}")`));
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
