#!/usr/bin/env node
// finish-topic-gates.mjs — a topic is finished by its check.
//
// The chapter's end card offered "Take the mastery check" and "Complete topic"
// as two buttons of one size, so the check read as one of two equal ways out
// and the test looked skippable. In enforced mode "Complete topic" could only
// be refused; in advisory mode the refusal it led to offered three equal
// buttons and no check at all; and when the check could not be drawn, "Mark
// done anyway" was the dialog's primary. A topic that was already completed
// still ended on both buttons, as if it were open.
//
// The rule this gate holds, on the REAL components mounted in jsdom (the API
// and the store stubbed, nothing else):
//
//   * while the gate is on and the topic is not proven, the mastery check is
//     the one primary and every way to close the topic without it is `quiet`
//     and says so ("Mark done without the check", "Skip topic"); "Complete
//     topic" is not offered as if it were the ordinary finish;
//   * those ways stay reachable in one press: advisory may mark it done
//     (override), enforced may skip it (Skip is always allowed), never mark it;
//   * proven, or with the gate off, completing IS the finish and leads;
//   * a closed topic offers nothing that closes it again;
//   * inside the check (questions, a failed result, a check that could not be
//     drawn), no way out of it is ever the primary or an outlined equal.
//
//   node tools/finish-topic-gates.mjs               # this checkout
//   node tools/finish-topic-gates.mjs --root DIR    # another checkout (the pre-fix tree)

import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
if (rootArg > 0 && !process.argv[rootArg + 1]) { console.error('--root needs a directory'); process.exit(2); }
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : HERE;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { build } = await import('esbuild');

// The API is the one thing stubbed: it is the network. The store, i18n and
// every component are the app's own. The stub reads its behaviour from
// `globalThis.__finish`, set per mount, and records every call it gets.
const STUB_API = `
const h = () => globalThis.__finish;
const record = (name) => async (...a) => { h().calls.push([name, ...a]); return h()[name] ? h()[name](...a) : [] };
export const newAttemptId = () => 'attempt-' + Math.random().toString(36).slice(2);
export const setAuthRequiredHandler = () => {};
export const api = new Proxy({
    getCheckpointFacts: async (id) => { if (!h().facts) throw new Error('not asked'); return h().facts(id); },
    updateNode: record('updateNode'),
    drawMasteryCheck: async (id) => h().draw(id),
    streamGenerateQuiz: async () => { throw new Error('No model selected'); },
    submitMasteryCheck: async (...a) => h().submit(...a),
}, { get: (t, k) => k in t ? t[k] : record(String(k)) });
export default api;
`;
const stubs = {
    name: 'finish-stubs',
    setup(b) {
        b.onResolve({ filter: /^(\.\.?\/)+api$/ }, (a) => /[\\/]src[\\/]/.test(a.importer)
            ? { path: 'api', namespace: 'finish-stub' } : undefined);
        b.onLoad({ filter: /.*/, namespace: 'finish-stub' }, () => ({ contents: STUB_API, resolveDir: ROOT, loader: 'js' }));
        // Lazy chunks (CodeMirror, charts) are never reached by a multiple-choice check.
        b.onResolve({ filter: /\.(css|svg|png|woff2?)$/ }, () => ({ path: 'asset', namespace: 'finish-asset' }));
        b.onLoad({ filter: /.*/, namespace: 'finish-asset' }, () => ({ contents: 'export default ""', loader: 'js' }));
    },
};

const cache = path.join(HERE, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(path.join(cache, 'finish-topic-gates-'));
const outfile = path.join(scratch, 'finish.cjs');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const g = globalThis;
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver',
    'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage',
    'IS_REACT_ACT_ENVIRONMENT', '__finish', '__width'];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(g, k)]));
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
window.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
window.scrollTo = () => { };
window.HTMLElement.prototype.scrollIntoView = function () { };
// jsdom lays nothing out, so every width is 0 ("not measured"): a section sets
// `__width` to draw the card at a phone's or a desktop's width.
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return g.__width ?? 0; } });

try {
    await build({
        plugins: [stubs],
        stdin: {
            contents: `
                import * as React from 'react';
                import { createRoot } from 'react-dom/client';
                import { i18nReady } from './src/i18n';
                import { useStore } from './src/store';
                import CheckpointCard from './src/components/feed/CheckpointCard';
                import MasteryGateModal from './src/components/MasteryGateModal';
                export { CONTROL_VARIANT } from './src/components/ui/vocabulary';
                export const ready = () => i18nReady;
                export const gate = () => useStore.getState().masteryGate;
                export const closeGate = () => useStore.getState().closeMasteryGate();
                // What the feed does after an answer in the topic is saved.
                export const answerSaved = (id) => React.act(() => useStore.setState(s => ({
                    feedSavedByNode: { ...s.feedSavedByNode, [id]: (s.feedSavedByNode[id] ?? 0) + 1 },
                })));
                const h = React.createElement;
                function mount(el, node) {
                    const r = createRoot(el);
                    React.act(() => r.render(node));
                    return () => React.act(() => r.unmount());
                }
                // The feed holds 'done' and sets it from onDone; so does this.
                const Held = ({ card, done }) => {
                    const [isDone, setDone] = React.useState(done);
                    return h(CheckpointCard, { card, done: isDone, onDone: () => {
                        globalThis.__finish.calls.push(['onDone']); setDone(true);
                    } });
                };
                export const mountCard = (el, card, done = false) => mount(el, h(Held, { card, done }));
                export const mountModal = (el, props) => mount(el, h(MasteryGateModal, {
                    isOpen: true, onClose: () => {}, nodeId: 11, nodeTitle: 'Oven spring', projectId: 1,
                    onPassed: () => {}, onMarkAnyway: () => globalThis.__finish.calls.push(['markAnyway']),
                    onSkip: () => globalThis.__finish.calls.push(['skip']), ...props,
                }));
                export const act = (fn) => React.act(fn);`,
            resolveDir: ROOT, loader: 'tsx',
        },
        // Packages bundled in, as tools/harness does: left external, an ESM-only
        // highlighter came back through require() without its default export.
        bundle: true, format: 'cjs', platform: 'browser', outfile,
        jsx: 'automatic', logLevel: 'error',
        nodePaths: [path.join(HERE, 'node_modules')],
        define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.MODE': '"test"' },
    });

    // Everything a browser has and Node does not (DOMParser, Range, CSS…),
    // read at import by the libraries the components bundle. This is a process
    // of its own (run-gates spawns each suite), so the globals end with it.
    for (const k of Object.getOwnPropertyNames(window)) {
        if (!(k in g)) {
            try { Object.defineProperty(g, k, { value: window[k], configurable: true, writable: true }); } catch { /* not copyable */ }
        }
    }
    // Node's own `navigator` is a getter: it is redefined, not assigned.
    Object.defineProperty(g, 'navigator', { value: window.navigator, configurable: true, writable: true });
    Object.assign(g, {
        window, document: window.document, HTMLElement: window.HTMLElement,
        Element: window.Element, Node: window.Node, MutationObserver: window.MutationObserver,
        ResizeObserver: window.ResizeObserver, KeyboardEvent: window.KeyboardEvent, MouseEvent: window.MouseEvent,
        getComputedStyle: window.getComputedStyle.bind(window),
        requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
        localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    });
    const app = require(outfile);
    await app.ready();
    const doc = window.document;

    // A button's fill, read from the vocabulary's own classes (most specific match).
    const VARIANTS = Object.entries(app.CONTROL_VARIANT).map(([v, cls]) => [v, cls.split(/\s+/).filter(Boolean)]);
    const fillOf = (btn) => {
        const have = new Set(btn.className.split(/\s+/));
        const hits = VARIANTS.filter(([, cls]) => cls.every(c => have.has(c))).sort((a, b) => b[1].length - a[1].length);
        return hits[0]?.[0] ?? 'none';
    };
    const buttonsIn = (el) => [...el.querySelectorAll('button')]
        .map(b => ({ el: b, label: (b.textContent || '').trim(), fill: fillOf(b), icon: !!b.querySelector('svg') }))
        .filter(b => b.label);
    const describe = (bs) => bs.map(b => `${b.label}[${b.fill}]`).join(' | ') || '(no buttons)';

    /** Closes the topic without a pass. The words a learner reads on such a button. */
    const FINISH_WITHOUT_PROOF = /^(Complete topic|Mark done anyway|Mark done without the check|Skip|Skip topic|Skip this topic)$/;
    const CHECK = /^Take the mastery check$/;
    /** One action, one name: the check's ways out read as the card's do. */
    const SAME_NAMES = /^(Skip topic|Mark done without the check)$/;
    const settle = async (ms = 0) => { await app.act(async () => { await new Promise(r => setTimeout(r, ms)); }); };

    const harness = (over = {}) => {
        g.__finish = {
            calls: [],
            updateNode: async () => ({ id: 11 }),
            draw: async () => ({ questions: [], bankSize: 0, status: 'in_progress', minQuestions: 4 }),
            submit: async () => ({ score: 1, total: 4, passed: false, passThreshold: 0.8 }),
            ...over,
        };
        return g.__finish;
    };
    const card = (over = {}) => ({
        key: 'checkpoint-11', kind: 'checkpoint', nodeId: 11, nodeTitle: 'Oven spring', projectId: 1,
        projectName: 'How Bread Rises', projectColor: '#3B82F6',
        feedCorrect: 1, feedTotal: 2, masteryScore: 0.4, eligible: false, borrowedEstimate: false, borrowedFrom: null,
        gateMode: 'advisory', scheduledEnd: null, isOverdue: false, deadline: null, nodeStatus: 'in_progress',
        ...over,
    });
    const host = () => { const el = doc.createElement('div'); doc.body.append(el); return el; };
    const withCard = async (c, fn, done = false) => {
        const el = host();
        const unmount = app.mountCard(el, c, done);
        await settle();
        try { await fn(el); } finally { unmount(); el.remove(); }
    };
    const click = async (btn) => { await app.act(async () => { btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await settle(); };

    // -- 1. the chapter's end card, every gate mode x topic state -------------------
    console.log('\n--- the end card: the check leads while the topic is unproven ---');
    const STATES = {
        'not started': { nodeStatus: 'not_started', feedTotal: 0, feedCorrect: 0, masteryScore: 0 },
        'in progress': { nodeStatus: 'in_progress' },
        'head start': { nodeStatus: 'not_started', masteryScore: 0.5, borrowedEstimate: true, borrowedFrom: 'placement' },
        'skipped': { nodeStatus: 'skipped' },
    };
    for (const mode of ['advisory', 'enforced']) {
        for (const [state, over] of Object.entries(STATES)) {
            harness();
            await withCard(card({ gateMode: mode, ...over }), async (el) => {
                const bs = buttonsIn(el);
                const primaries = bs.filter(b => b.fill === 'primary');
                const outs = bs.filter(b => FINISH_WITHOUT_PROOF.test(b.label));
                check(`${mode}, ${state}: the mastery check is the one primary`,
                    primaries.length === 1 && CHECK.test(primaries[0].label), describe(bs));
                check(`${mode}, ${state}: every way to close it without the check is quiet`,
                    outs.every(b => b.fill === 'quiet'), describe(bs));
                check(`${mode}, ${state}: "Complete topic" is not offered as the ordinary finish`,
                    !bs.some(b => b.label === 'Complete topic'), describe(bs));
                if (mode === 'advisory' && state === 'skipped') {
                    check('advisory, skipped: a topic already skipped is not marked done from here',
                        !bs.some(b => /^Mark done/.test(b.label)), describe(bs));
                } else if (mode === 'advisory') {
                    check(`advisory, ${state}: "Mark done without the check" is one press away`,
                        bs.some(b => b.label === 'Mark done without the check'), describe(bs));
                } else {
                    check(`enforced, ${state}: nothing marks it done without the check`,
                        !bs.some(b => /^Mark done/.test(b.label)), describe(bs));
                    if (state !== 'skipped') {
                        check(`enforced, ${state}: Skip stays one press away`,
                            bs.some(b => b.label === 'Skip topic'), describe(bs));
                    }
                }
            });
        }
    }

    console.log('\n--- the end card: proven, or the gate off, completing leads ---');
    for (const [what, over] of [
        ['advisory, proven', { gateMode: 'advisory', eligible: true, masteryScore: 0.9 }],
        ['enforced, proven', { gateMode: 'enforced', eligible: true, masteryScore: 0.9 }],
        ['off, not proven', { gateMode: 'off' }],
        ['off, head start', { gateMode: 'off', masteryScore: 0.5, borrowedEstimate: true, borrowedFrom: 'placement' }],
        ['off, skipped', { gateMode: 'off', nodeStatus: 'skipped' }],
    ]) {
        harness();
        await withCard(card(over), async (el) => {
            const bs = buttonsIn(el);
            if (over.nodeStatus === 'skipped') {
                check(`${what}: the card says it was skipped`,
                    /Skipped/.test(el.textContent), el.textContent.slice(0, 200));
            }
            const primaries = bs.filter(b => b.fill === 'primary');
            check(`${what}: "Complete topic" is the one primary`,
                primaries.length === 1 && primaries[0].label === 'Complete topic', describe(bs));
            if (over.gateMode === 'off') {
                check(`${what}: with the test switched off, no check is offered`, !bs.some(b => CHECK.test(b.label)), describe(bs));
            } else {
                check(`${what}: the check is still offered beside it`, bs.some(b => CHECK.test(b.label)), describe(bs));
            }
            const group = bs.filter(b => b.label === 'Complete topic' || CHECK.test(b.label));
            check(`${what}: the pair carries an icon on both or on neither`,
                group.every(b => b.icon) || group.every(b => !b.icon), describe(bs));
        });
    }

    console.log('\n--- the end card: a closed topic is not closed again ---');
    for (const mode of ['off', 'advisory', 'enforced']) {
        for (const [what, c, done] of [
            ['completed', card({ gateMode: mode, nodeStatus: 'completed', eligible: true, masteryScore: 0.9 }), false],
            ['just completed here', card({ gateMode: mode }), true],
        ]) {
            harness();
            await withCard(c, async (el) => {
                const bs = buttonsIn(el);
                check(`${mode}, ${what}: nothing on the card finishes it again`,
                    !bs.some(b => FINISH_WITHOUT_PROOF.test(b.label)), describe(bs));
                check(`${mode}, ${what}: the card says it is completed`,
                    /Topic completed/.test(el.textContent || ''), (el.textContent || '').slice(0, 160));
            }, done);
        }
    }
    // Closed without proof must not read as passed: no green "Topic completed".
    for (const mode of ['advisory', 'enforced']) {
        harness();
        await withCard(card({ gateMode: mode, nodeStatus: 'completed' }), async (el) => {
            const text = el.textContent || '';
            check(`${mode}, completed without proof: the card says it is not proven, not "Topic completed"`,
                /Completed, not proven yet/.test(text) && !/Topic completed/.test(text), text.slice(0, 160));
            check(`${mode}, completed without proof: nothing on the card finishes it again`,
                !buttonsIn(el).some(b => FINISH_WITHOUT_PROOF.test(b.label)), describe(buttonsIn(el)));
            check(`${mode}, completed without proof: the check is still on offer, and does not shout`,
                buttonsIn(el).some(b => CHECK.test(b.label) && b.fill === 'neutral'), describe(buttonsIn(el)));
        });
    }
    {
        harness();
        await withCard(card({ gateMode: 'off', nodeStatus: 'completed' }), async (el) => {
            check('off, completed: with no gate, completed is just completed',
                /Topic completed/.test(el.textContent || ''), (el.textContent || '').slice(0, 160));
        });
    }
    // Back on the feed after leaving it: `feedDone` is the store's and outlives
    // the card, which mounts again with done=true, no memory of how it closed,
    // and the numbers it was composed with. The server's fresh facts say how.
    for (const mode of ['advisory', 'enforced']) {
        const stale = { gateMode: mode, nodeStatus: 'in_progress' };
        const fresh = { feedCorrect: 1, feedTotal: 3, masteryScore: 0.3, eligible: false, borrowedEstimate: false, borrowedFrom: null, gateMode: mode };
        harness({ facts: async () => ({ ...fresh, nodeStatus: 'skipped' }) });
        await withCard(card(stale), async (el) => {
            await settle(10);
            const text = el.textContent || '';
            check(`${mode}, skipped, card mounted again: it says skipped, not "Topic completed"`,
                /Skipped/.test(text) && !/Topic completed/.test(text), text.slice(0, 160));
        }, true);
        harness({ facts: async () => ({ ...fresh, nodeStatus: 'completed' }) });
        await withCard(card(stale), async (el) => {
            await settle(10);
            const text = el.textContent || '';
            check(`${mode}, marked done without the check, card mounted again: still not proven, check on offer`,
                /Completed, not proven yet/.test(text) && !/Topic completed/.test(text)
                && buttonsIn(el).some(b => CHECK.test(b.label)), `${text.slice(0, 160)} · ${describe(buttonsIn(el))}`);
        }, true);
        harness({ facts: async () => ({ ...fresh, masteryScore: 0.95, eligible: true, nodeStatus: 'completed' }) });
        await withCard(card(stale), async (el) => {
            await settle(10);
            check(`${mode}, passed, card mounted again: "Topic completed"`,
                /Topic completed/.test(el.textContent || ''), (el.textContent || '').slice(0, 160));
        }, true);
    }
    console.log('\n--- the end card: what each line under the gate says ---');
    for (const [mode, want] of [['advisory', /Pass it to show you know it\./], ['enforced', /Pass it to finish the topic\./]]) {
        harness();
        await withCard(card({ gateMode: mode }), async (el) => {
            check(`${mode}: the line about the check matches what the buttons allow`,
                want.test(el.textContent || ''), (el.textContent || '').slice(0, 200));
        });
    }

    console.log('\n--- the end card: each way out does what it says, in one press ---');
    {
        const h = harness();
        await withCard(card({ gateMode: 'advisory' }), async (el) => {
            const b = buttonsIn(el).find(x => x.label === 'Mark done without the check');
            if (b) await click(b.el);
            const put = h.calls.find(c => c[0] === 'updateNode');
            check('advisory: "Mark done without the check" completes it with the override, no refusal in between',
                !!put && put[2]?.status === 'completed' && put[2]?.override === true, JSON.stringify(h.calls));
            const after = el.textContent || '';
            check('advisory: once marked done that way, the card says it is not proven, not "Topic completed"',
                /Completed, not proven yet/.test(after) && !/Topic completed/.test(after), after.slice(0, 200));
            const later = buttonsIn(el).find(x => CHECK.test(x.label));
            if (later) await click(later.el);
            const opened = app.gate();
            check('advisory: marked done, the check can still be taken from the card',
                opened.isOpen && opened.nodeId === 11, describe(buttonsIn(el)));
            // The retake passes and the modal is closed with its own button.
            h.facts = async () => ({ feedCorrect: 6, feedTotal: 6, masteryScore: 0.92, eligible: true,
                borrowedEstimate: false, borrowedFrom: null, nodeStatus: 'completed', gateMode: 'advisory' });
            await app.act(async () => { app.closeGate(); });
            await settle(20);
            const proved = el.textContent || '';
            check('advisory: marked done, then the check passed: the card reads "Topic completed"',
                /Topic completed/.test(proved) && !/not proven/.test(proved), proved.slice(0, 200));
        });
    }
    {
        const h = harness();
        await withCard(card({ gateMode: 'enforced' }), async (el) => {
            const b = buttonsIn(el).find(x => x.label === 'Skip topic');
            if (b) await click(b.el);
            const puts = h.calls.filter(c => c[0] === 'updateNode');
            check('enforced: "Skip topic" skips it, and never asks to complete it',
                puts.length === 1 && puts[0][2]?.status === 'skipped', JSON.stringify(h.calls));
        });
    }
    {
        harness();
        await withCard(card({ gateMode: 'advisory' }), async (el) => {
            const b = buttonsIn(el).find(x => CHECK.test(x.label));
            if (b) await click(b.el);
            const opened = app.gate();
            check('the check opens the mastery check right here, on this topic',
                opened.isOpen && opened.nodeId === 11, JSON.stringify(opened));
            app.closeGate();
        });
    }

    // The card believed the topic proven and the server refused (the estimate
    // moved since): the refusal must hand the learner the check, not a row of equals.
    console.log('\n--- the end card: a refused completion offers the check ---');
    for (const mode of ['advisory', 'enforced']) {
        harness({
            updateNode: async () => {
                const e = new Error('Not proven yet');
                e.data = { mastery_gate: true, advisory: mode === 'advisory', mastery_score: 0.7, threshold: 0.85 };
                throw e;
            },
        });
        await withCard(card({ gateMode: mode, eligible: true, masteryScore: 0.86 }), async (el) => {
            const done = buttonsIn(el).find(x => x.label === 'Complete topic');
            if (done) await click(done.el);
            const bs = buttonsIn(el);
            const primaries = bs.filter(b => b.fill === 'primary');
            check(`${mode}, refused: the refusal is said`, /Not proven yet/.test(el.textContent || ''), (el.textContent || '').slice(0, 200));
            check(`${mode}, refused: the mastery check is the one primary`,
                primaries.length === 1 && CHECK.test(primaries[0].label), describe(bs));
            check(`${mode}, refused: the ways out are quiet`,
                bs.filter(b => FINISH_WITHOUT_PROOF.test(b.label)).every(b => b.fill === 'quiet'), describe(bs));
        });
    }
    const refuse = (advisory) => async () => {
        const e = new Error('Not proven yet');
        e.data = { mastery_gate: true, advisory, mastery_score: 0.4, threshold: 0.85 };
        throw e;
    };
    {
        // Composed while the gate was off, refused after it was switched on.
        harness({ updateNode: refuse(true) });
        await withCard(card({ gateMode: 'off' }), async (el) => {
            const done = buttonsIn(el).find(x => x.label === 'Complete topic');
            if (done) await click(done.el);
            const bs = buttonsIn(el);
            const primaries = bs.filter(b => b.fill === 'primary');
            check('composed with the gate off, then refused: the refusal is said',
                /Not proven yet/.test(el.textContent || ''), (el.textContent || '').slice(0, 200));
            check('composed with the gate off, then refused: the check leads and the way out is the mode the server named',
                primaries.length === 1 && CHECK.test(primaries[0].label)
                && bs.some(b => b.label === 'Mark done without the check' && b.fill === 'quiet'), describe(bs));
        });
    }
    {
        // Refused, then more answers prove it: completing leads again.
        const h = harness({ updateNode: refuse(false) });
        await withCard(card({ gateMode: 'enforced', eligible: true, masteryScore: 0.86 }), async (el) => {
            const done = buttonsIn(el).find(x => x.label === 'Complete topic');
            if (done) await click(done.el);
            h.facts = async () => ({ feedCorrect: 6, feedTotal: 6, masteryScore: 0.92, eligible: true,
                borrowedEstimate: false, borrowedFrom: null, nodeStatus: 'in_progress' });
            await app.answerSaved(11);
            await settle(20);
            const bs = buttonsIn(el);
            const primaries = bs.filter(b => b.fill === 'primary');
            check('refused, then proven by later answers: the refusal is gone and completing leads again',
                !/Not proven yet/.test(el.textContent || '')
                && primaries.length === 1 && primaries[0].label === 'Complete topic', describe(bs));
        });
    }

    {
        // Facts asked for BEFORE a refusal and answered after it are older than
        // the refusal: they must not put "Complete topic" back.
        const h = harness({ updateNode: refuse(false) });
        let answer;
        h.facts = () => new Promise(r => { answer = r; });
        await withCard(card({ gateMode: 'enforced', eligible: true, masteryScore: 0.86 }), async (el) => {
            await app.answerSaved(11);
            const done = buttonsIn(el).find(x => x.label === 'Complete topic');
            if (done) await click(done.el);
            await app.act(async () => { answer?.({ feedCorrect: 5, feedTotal: 6, masteryScore: 0.86, eligible: true,
                borrowedEstimate: false, borrowedFrom: null, nodeStatus: 'in_progress', gateMode: 'enforced' }); });
            await settle(20);
            const bs = buttonsIn(el);
            check('refused while older facts were on the way: the refusal stands when they land',
                /Not proven yet/.test(el.textContent || '') && !bs.some(b => b.label === 'Complete topic'), describe(bs));
        });
    }
    {
        // The setting changed after the card was composed: fresh facts carry the mode now.
        const h = harness();
        await withCard(card({ gateMode: 'enforced' }), async (el) => {
            h.facts = async () => ({ feedCorrect: 2, feedTotal: 3, masteryScore: 0.5, eligible: false,
                borrowedEstimate: false, borrowedFrom: null, nodeStatus: 'in_progress', gateMode: 'advisory' });
            await app.answerSaved(11);
            await settle(20);
            const bs = buttonsIn(el);
            check('composed enforced, facts now say advisory: the card offers what advisory allows',
                bs.some(b => b.label === 'Mark done without the check') && !bs.some(b => b.label === 'Skip topic'), describe(bs));
        });
    }
    {
        // A pass closed with the modal's own X tells the card nothing: it asks again.
        const h = harness();
        await withCard(card({ gateMode: 'enforced' }), async (el) => {
            const b = buttonsIn(el).find(x => CHECK.test(x.label));
            if (b) await click(b.el);
            h.facts = async () => ({ feedCorrect: 2, feedTotal: 3, masteryScore: 0.9, eligible: true,
                borrowedEstimate: false, borrowedFrom: null, nodeStatus: 'in_progress', gateMode: 'enforced' });
            await app.act(async () => { app.closeGate(); });
            await settle(20);
            const primaries = buttonsIn(el).filter(x => x.fill === 'primary');
            check('the check passed and its modal closed with X: completing leads on the card',
                primaries.length === 1 && primaries[0].label === 'Complete topic', describe(buttonsIn(el)));
        });
    }

    console.log('\n--- the end card: it says how the topic ended, whoever ended it ---');
    {
        harness();
        await withCard(card({ gateMode: 'enforced' }), async (el) => {
            const b = buttonsIn(el).find(x => x.label === 'Skip topic');
            if (b) await click(b.el);
            const text = el.textContent || '';
            check('"Skip topic" pressed: the card says skipped, not completed',
                /Skipped/.test(text) && !/Topic completed/.test(text), text.slice(0, 200));
        });
    }
    for (const [what, how, want, not] of [
        ['skipped inside the check', { outcome: 'skipped', proven: false }, /Skipped/, /Topic completed|Marked done/],
        ['marked done inside the check', { outcome: 'completed', proven: false }, /Completed, not proven yet/, /Topic completed/],
        ['passed the check', { outcome: 'completed', proven: true }, /Topic completed/, /not proven|Skipped/],
    ]) {
        harness();
        await withCard(card({ gateMode: 'advisory' }), async (el) => {
            const b = buttonsIn(el).find(x => CHECK.test(x.label));
            if (b) await click(b.el);
            const resolved = app.gate().onResolved;
            app.closeGate();
            if (resolved) await app.act(async () => { resolved(how); });
            await settle();
            const text = el.textContent || '';
            check(`${what}: the card says so`, want.test(text) && !not.test(text), text.slice(0, 200));
        });
    }

    console.log('\n--- the end card: narrow and wide ---');
    for (const [what, over] of [
        ['advisory, unproven', { gateMode: 'advisory' }],
        ['enforced, unproven', { gateMode: 'enforced' }],
        ['proven', { gateMode: 'advisory', eligible: true, masteryScore: 0.9 }],
    ]) {
        for (const [size, px] of [['a phone (300px)', 300], ['a desktop (800px)', 800]]) {
            g.__width = px;
            harness();
            await withCard(card(over), async (el) => {
                const bs = buttonsIn(el);
                const narrow = px < 28 * 16;
                const primaryAt = bs.findIndex(b => b.fill === 'primary');
                check(`${what}, ${size}: the primary is ${narrow ? 'first, on top' : 'last, at the end'} in the DOM and the tab order`,
                    bs.length > 1 && primaryAt === (narrow ? 0 : bs.length - 1), describe(bs));
                check(`${what}, ${size}: ${narrow ? 'every button spans the card' : 'no button spans the card'}`,
                    bs.every(b => b.el.classList.contains('w-full') === narrow), describe(bs));
            });
        }
    }
    g.__width = 0;

    // -- 2. inside the check ------------------------------------------------------
    console.log('\n--- inside the check: no way out is the primary or an outlined equal ---');
    const mc = (i) => ({
        question: `Question ${i}?`, type: 'multiple_choice', options: ['A', 'B', 'C', 'D'], correct_answer: 'A',
        explanation: 'Because.', quizId: 1, index: i, uuid: `00000000-0000-4000-8000-00000000000${i}`,
    });
    const withModal = async (over, props, fn) => {
        harness(over);
        const el = host();
        const unmount = app.mountModal(el, props);
        await settle(20);
        try { await fn(el); } finally { unmount(); el.remove(); }
    };
    for (const advisory of [true, false]) {
        const mode = advisory ? 'advisory' : 'enforced';
        // No bank and no model: the check cannot be drawn.
        await withModal({}, { advisory }, async (el) => {
            await settle(50);
            const bs = buttonsIn(el);
            const outs = bs.filter(b => FINISH_WITHOUT_PROOF.test(b.label));
            check(`${mode}, the check could not be drawn: the error is on screen`,
                /Failed|model/i.test(el.textContent || ''), (el.textContent || '').slice(0, 200));
            check(`${mode}, the check could not be drawn: no way out of it is the primary`,
                outs.length > 0 && outs.every(b => b.fill !== 'primary'), describe(bs));
            check(`${mode}, the check could not be drawn: the ways out carry the card's names`,
                outs.every(b => SAME_NAMES.test(b.label)), describe(outs));
        });
        // A drawn check: the footer while answering.
        const questions = [1, 2, 3, 4].map(mc);
        await withModal({ draw: async () => ({ questions, bankSize: 4, status: 'in_progress', minQuestions: 4 }) }, { advisory }, async (el) => {
            await settle(50);
            const bs = buttonsIn(el);
            const outs = bs.filter(b => FINISH_WITHOUT_PROOF.test(b.label));
            check(`${mode}, answering: the ways out are quiet`,
                outs.length > 0 && outs.every(b => b.fill === 'quiet'), describe(bs));
            check(`${mode}, answering: the ways out carry the card's names`,
                outs.every(b => SAME_NAMES.test(b.label)), describe(outs));
            // Answer all four and submit: a failed result.
            for (let i = 0; i < 4; i++) {
                const opt = buttonsIn(el).find(b => b.label === 'B');
                if (opt) await click(opt.el);
                const next = buttonsIn(el).find(b => b.label === 'Next' || b.label === 'Submit mastery check');
                if (next) await click(next.el);
                await settle(10);
            }
            await settle(50);
            const after = buttonsIn(el);
            const failedOuts = after.filter(b => FINISH_WITHOUT_PROOF.test(b.label));
            check(`${mode}, a failed check: the result is on screen`,
                /Not Yet Mastered/.test(el.textContent || ''), describe(after));
            check(`${mode}, a failed check: Retry is the primary and the ways out are quiet`,
                after.some(b => b.label === 'Retry the mastery check' && b.fill === 'primary')
                && failedOuts.length > 0 && failedOuts.every(b => b.fill === 'quiet'), describe(after));
            check(`${mode}, a failed check: the ways out carry the card's names`,
                failedOuts.every(b => SAME_NAMES.test(b.label)), describe(failedOuts));
        });
    }
} finally {
    for (const k of GLOBALS) {
        if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k];
    }
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
