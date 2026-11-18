#!/usr/bin/env node
// checkpoint-card-gates.mjs — the chapter card says what the check proved.
//
// The "End of chapter" card is composed when the topic's last part is written,
// and its numbers are the topic's as it was then. It asked the server again
// after each answer saved in the topic, but never after the mastery check: the
// check is a modal, and passing it marks the card done, which also switched the
// refresh off. So a topic ended on
//
//     Estimated mastery 0%   ·   Topic completed
//
// right after a 4/4 check that had written 0.99 to the database. Mounted in
// jsdom from the real component, with the api answered by a stub:
//
//   1. a card nobody has answered on yet does not ask (no request per card);
//   2. a card marked done asks the server for its numbers again, shows them,
//      and still says "Topic completed".
//
// The card's deadline line (the lead-in and the day count read as one
// sentence; a passed deadline has no day count), and the paper exercise card
// beside it in the feed (Retake opens the file picker; the worked solution
// stays on screen after a self-mark) are mounted the same way.
//
//   node tools/checkpoint-card-gates.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'SVGSVGElement']) if (window[k]) globalThis[k] = window[k];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const consoleError = console.error;
console.error = (...a) => { if (!/not wrapped in act/.test(String(a[0]))) consoleError(...a); };

const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(cacheDir, 'checkpoint-card-gates-'));
const out = join(scratch, 'bundle.cjs');

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });
        export const initReactI18next = { type: '3rdParty', init() { } };`,
    // noteAnswerSaved as the real store has it: bump the topic's count, tell
    // every subscriber (the card re-reads on the bump).
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: { feedSavedByNode: {}, masteryGate: { isOpen: false, nodeId: null }, addToast() { }, openMasteryGate() { }, skipNode: async () => true,
            noteAnswerSaved(id) {
                g.__st.state = { ...g.__st.state, feedSavedByNode: { ...g.__st.state.feedSavedByNode, [id]: (g.__st.state.feedSavedByNode[id] ?? 0) + 1 } };
                g.__st.subs.forEach(cb => cb());
            } }, subs: new Set() };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;`,
    'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => (globalThis.__api?.[name] ?? (() => new Promise(() => { })))(...args) });`,
    // The player plays one full round as soon as it mounts.
    'player': `import { useEffect } from 'react';
        export default function DrillPlayer({ onRoundComplete }) {
            useEffect(() => { onRoundComplete({ full: true, correct: 4, total: 4, items: [] }); }, []);
            return null;
        }`,
    // The drill title's renderer (KaTeX and its stylesheet are not what is tested).
    'mathtext': `export default function MathText({ text, content }) { return text ?? content ?? null; }`,
    // The paper card's collaborators that are not what is tested: the photo
    // pipeline (canvas), the markdown renderer, the report flag.
    'warp': `export const fileToImageData = async () => ({ width: 100, height: 100 });
        export const scanToBlob = async () => new Blob();
        export const imageDataToCanvas = () => document.createElement('canvas');
        export const orderCorners = (q) => q;`,
    'markdown': `import { createElement } from 'react';
        export default function Markdown({ content }) { return createElement('div', { 'data-md': '' }, content); }`,
    'reportitem': `export default function ReportItem() { return null; }
        export function ReportLink() { return null; }
        export function ReportScope({ children }) { return children; }`,
    'unchecked': `export default function UncheckedKeyNote() { return null; }`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\/DrillPlayer$/ }, () => ({ path: 'player', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.\/MathText$/ }, () => ({ path: 'mathtext', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+utils\/scan\/warp$/ }, () => ({ path: 'warp', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.\/Markdown$/ }, () => ({ path: 'markdown', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.\/ui\/ReportItem$/ }, () => ({ path: 'reportitem', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.\/UncheckedKeyNote$/ }, () => ({ path: 'unchecked', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
    },
};

let CheckpointCard = null;
let DrillModal = null;
let PracticeCard = null;
try {
    await esbuild.build({
        stdin: { contents: `export { default as CheckpointCard } from './src/components/feed/CheckpointCard';
            export { default as PracticeCard } from './src/components/feed/PracticeCard';
            export { default as DrillModal } from './src/components/drills/DrillModal';`, resolveDir: root, loader: 'tsx' },
        bundle: true, format: 'cjs', platform: 'node', outfile: out,
        jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' }, packages: 'external',
        define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
        plugins: [stubPlugin], logLevel: 'silent',
    });
    ({ CheckpointCard, DrillModal, PracticeCard } = require(out));
} catch (e) {
    console.log(`  (could not bundle the card: ${String(e.message).split('\n').slice(0, 3).join(' | ')})`);
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const h = React.createElement;
const act = (fn) => React.act(fn);
const settle = (ms = 30) => act(() => new Promise(r => setTimeout(r, ms)));

/** The card as the feed composed it before the check: one lesson question right, no evidence yet. */
const composed = {
    kind: 'checkpoint', key: 'checkpoint-63', nodeId: 63, nodeTitle: 'The function e to the minus one over x squared', projectId: 1,
    feedCorrect: 1, feedTotal: 1, masteryScore: 0, eligible: false, borrowedEstimate: false, borrowedFrom: null,
    gateMode: 'enforced', scheduledEnd: null, isOverdue: false, deadline: null,
};
/** What GET /api/feed/nodes/63/checkpoint answers after the 4/4 check (the take's database: 0.99). */
const afterCheck = { feedCorrect: 1, feedTotal: 1, masteryScore: 0.99, eligible: true, borrowedEstimate: false, borrowedFrom: null };
const masteryShown = (host) => host.textContent.match(/Estimated mastery\s*(\d+)%/)?.[1];

if (CheckpointCard) {
    const asked = [];
    globalThis.__api = { getCheckpointFacts: (id) => { asked.push(id); return Promise.resolve(afterCheck); } };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);

    await act(() => r.render(h(CheckpointCard, { card: composed, done: false, onDone() { } })));
    await settle();
    // A baseline, true before the fix as well: the card does not ask while
    // nothing has changed, so the request after `done` below is the fix's.
    ok('before the check: the composed number, and no request yet', masteryShown(host) === '0' && asked.length === 0,
        `shown ${masteryShown(host)}%, ${asked.length} request(s)`);

    // The check passed: MasteryGateModal's callback marks the card done.
    await act(() => r.render(h(CheckpointCard, { card: composed, done: true, onDone() { } })));
    await settle();
    ok('done: the card asked the server for its numbers again', asked.includes(63), `${asked.length} request(s)`);
    ok('…and shows the estimate the check left (99%), not the composed 0%', masteryShown(host) === '99', `shown ${masteryShown(host)}%: ${host.textContent.slice(0, 160)}`);
    // Context, true before the fix too: the screen the bug showed.
    ok('…beside "Topic completed"', host.textContent.includes('Topic completed'));

    await act(() => r.unmount());
    host.remove();
    globalThis.__api = undefined;
} else ok('the card bundles and mounts', false);

// 3. A drill round played in a lesson above the card moves the estimate the
//    card shows: once its write resolved (not before), the card asks again.
if (CheckpointCard && DrillModal) {
    const asked = [];
    let saveDrill = null;
    const afterDrill = { feedCorrect: 0, feedTotal: 0, masteryScore: 0.99, gateScore: 0, shownScore: 0.6, practiceCeiling: 0.6,
        practiceRight: 4, practiceTotal: 4, practiceLifted: true, eligible: false, borrowedEstimate: false, borrowedFrom: null, gateMode: 'enforced' };
    globalThis.__api = {
        getCheckpointFacts: (id) => { asked.push(id); return Promise.resolve(afterDrill); },
        recordDrillResult: () => new Promise(r => { saveDrill = r; }),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    const card = { ...composed, key: 'checkpoint-64', nodeId: 64, feedCorrect: 0, feedTotal: 0 };
    await act(() => r.render(h(CheckpointCard, { card, done: false, onDone() { } })));
    await settle();
    const spec = { nodeId: 64, key: 'drill-1', modes: ['choice'], items: [] };
    await act(() => r.render(h('div', null, h(CheckpointCard, { card, done: false, onDone() { } }), h(DrillModal, { spec, onClose() { } }))));
    await settle();
    ok('a drill round is written, and the card does not ask before the write resolved', typeof saveDrill === 'function' && asked.length === 0, `${asked.length} request(s)`);
    await act(async () => { saveDrill?.({ mastery_score: 0.99 }); });
    await settle();
    ok('…once written, the card asks for its numbers again', asked.includes(64), `${asked.length} request(s)`);
    ok('…and shows the drill: 60% and "4 of 4 right"', masteryShown(host) === '60' && host.textContent.includes('4 of 4 right'), host.textContent.slice(0, 200));
    await act(() => r.unmount());
    host.remove();
    globalThis.__api = undefined;
} else ok('the drill dialog bundles and mounts', false);

// 4. The deadline line reads as one sentence, and a passed deadline has no
//    day count ("-12 days to the project deadline").
if (CheckpointCard) {
    globalThis.__api = { getCheckpointFacts: () => new Promise(() => { }) };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    const lineOf = async (card) => {
        await act(() => r.render(h(CheckpointCard, { card, done: false, onDone() { } })));
        await settle();
        return [...host.querySelectorAll('p')].map(p => p.textContent.trim()).find(s => /schedule|deadline|Ready to prove/.test(s)) ?? null;
    };
    const late = { ...composed, key: 'checkpoint-65', nodeId: 65, isOverdue: true, deadline: { daysLeft: 5, paceStatus: null } };
    const open = await lineOf(late);
    ok('behind schedule: a space between the lead-in and the day count', open === 'This topic is behind schedule · 5 days to the project deadline', String(open));
    const passed = await lineOf({ ...late, deadline: { daysLeft: -12, paceStatus: null } });
    ok('deadline passed: the lead-in stands without a dangling "·" and no negative count', passed === 'This topic is behind schedule', String(passed));
    const onTime = await lineOf({ ...composed, key: 'checkpoint-66', nodeId: 66, deadline: { daysLeft: 9, paceStatus: null } });
    ok('on time: the day count alone', onTime === '9 days to the project deadline', String(onTime));
    const noLine = await lineOf({ ...composed, key: 'checkpoint-67', nodeId: 67, deadline: { daysLeft: -3, paceStatus: null } });
    ok('on time and the deadline passed: no line at all', noLine === null, String(noLine));
    const today = await lineOf({ ...composed, key: 'checkpoint-68', nodeId: 68, deadline: { daysLeft: 0, paceStatus: null } });
    ok('the deadline is today: the count stays, at zero', today === '0 days to the project deadline', String(today));
    const readyCard = { ...composed, key: 'checkpoint-69', nodeId: 69, isOverdue: true, eligible: true, scheduledEnd: '2020-01-01' };
    const readyOpen = await lineOf({ ...readyCard, deadline: { daysLeft: 5, paceStatus: null } });
    ok('ready to prove: a space between the lead-in and the day count', readyOpen === 'Ready to prove · 5 days to the project deadline', String(readyOpen));
    const readyPassed = await lineOf({ ...readyCard, deadline: { daysLeft: -2, paceStatus: null } });
    ok('ready to prove and the deadline passed: the lead-in stands without a dangling "·"', readyPassed === 'Ready to prove', String(readyPassed));
    await act(() => r.unmount());
    host.remove();
    globalThis.__api = undefined;
} else ok('the card bundles and mounts (deadline line)', false);

// 5. The paper exercise card.
if (PracticeCard) {
    globalThis.__api = {
        getPaperCapability: () => Promise.resolve({ vision: true }),
        getPaperSolution: () => Promise.resolve({ referenceSolution: 'THE WORKED SOLUTION' }),
        selfGradePaperAttempt: () => Promise.resolve({ status: 'ok', unproven: false }),
    };
    const card = { kind: 'practice', key: 'practice-1', feedItemId: 1, nodeId: 70, nodeTitle: 'Limits', projectId: 1, mode: 'document',
        brief: 'THE BRIEF', materials: '', rubric: [{ id: 'a', point: 'Finds the limit', weight: 1 }] };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    const button = (label) => [...host.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(label));
    await act(() => r.render(h(PracticeCard, { card, done: false, onDone() { } })));
    await settle();

    // Photograph, then land on the corner screen and press Retake.
    const picker = host.querySelector('input[type=file]');
    Object.defineProperty(picker, 'files', { value: [new window.File(['x'], 'work.png', { type: 'image/png' })], configurable: true });
    await act(() => { picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await settle();
    ok('a picked photo opens the corner screen', !!button('Scan & submit'), host.textContent.slice(0, 200));
    let opened = 0;
    const pickerNow = host.querySelector('input[type=file]');
    if (pickerNow) pickerNow.click = () => { opened++; };
    await act(() => button('Retake')?.click());
    ok('"Retake" opens the file picker', !!pickerNow && opened === 1, pickerNow ? `${opened} click(s)` : 'no file input on the corner screen');
    await act(() => r.unmount());
    host.remove();

    // Self-mark, record: the solution the closing line points to is still there.
    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    const r2 = createRoot(host2);
    await act(() => r2.render(h(PracticeCard, { card: { ...card, key: 'practice-2', feedItemId: 2 }, done: false, onDone() { } })));
    await settle();
    const btn2 = (label) => [...host2.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(label));
    await act(() => btn2('Mark it myself')?.click());
    await settle();
    ok('self-marking shows the worked solution', host2.textContent.includes('THE WORKED SOLUTION'), host2.textContent.slice(0, 200));
    await act(() => btn2('Record')?.click());
    await settle();
    ok('recorded: the line says to compare against the solution above', host2.textContent.includes('Recorded. Compare your working against the solution above'), host2.textContent.slice(0, 300));
    ok('…and that solution is still on screen', host2.textContent.includes('THE WORKED SOLUTION'), 'the line points at a solution that is gone');
    await act(() => r2.unmount());
    host2.remove();
    globalThis.__api = undefined;
} else ok('the paper card bundles and mounts', false);

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
process.exit(fail ? 1 : 0);
