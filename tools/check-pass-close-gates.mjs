#!/usr/bin/env node
/**
 * tools/check-pass-close-gates.mjs — a passed mastery check finishes its topic
 * however the result screen is left.
 *
 *   node tools/check-pass-close-gates.mjs [--root DIR]
 *
 * The result of a pass says "You proved it — this topic will be marked
 * completed." Only Continue kept that promise: the X in the header and Escape
 * went to onClose, which closes the dialog and writes nothing, so a learner
 * who passed and closed the window found the topic still offered under
 * "Next" (a report from a learner on 1.4.0-nightly, 5 Nov 2026: two topics,
 * 10/10 and 9/10, left open that way). Continue sits below the review of
 * every answer, often out of sight; the X never is.
 *
 * Mounts the real MasteryGateModal in jsdom (only `../api`, the store, i18n
 * and the markdown renderer stubbed), passes a check, and leaves the result
 * every way there is. --root runs the same cases against another checkout's
 * components: before the fix the X and Escape cases fail.
 */
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = resolve(argOf('--root') || repo);
const compRoot = join(ROOT, 'src', 'components');
const realComp = join(repo, 'src', 'components');

// The server half runs on a scratch library, set here before any server
// module is imported (a shell prefix has silently failed to apply before).
const scratch = mkdtempSync(join(tmpdir(), 'check-pass-close-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
};

// ---------------------------------------------------------------------------
// The server: the pass completes its topic in the write that records it, so
// nothing after the result (a closed window, a killed app, a shut-down PC)
// can leave a passed topic open.
console.log('--- the server: a pass is a completed topic ---');
{
    const S = pathToFileURL(join(ROOT, 'server') + '/').href;
    const { default: db } = await import(S + 'database.js');
    if (!process.env.DB_PATH.startsWith(scratch)) throw new Error('refusing: not the scratch library');
    const { recordMasteryCheck } = await import(S + 'masteryCheck.js');
    const pid = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: checks')`).run().lastInsertRowid);
    const addNode = (title, { status = 'in_progress', parent = null, completedAt = null } = {}) => Number(db.prepare(
        'INSERT INTO nodes (project_id, parent_id, title, status, completed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(pid, parent, title, status, completedAt).lastInsertRowid);
    const bankFor = (nodeId) => {
        const qs = [0, 1, 2, 3].map(i => ({ type: 'multiple_choice', question: `${nodeId}: ${i} + 2?`, options: ['1', '2', '3', '4'], correct_answer: '4', explanation: 'Sum.', uuid: `n${nodeId}-q${i}` }));
        const quizId = Number(db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(nodeId, 'Bank', JSON.stringify(qs)).lastInsertRowid);
        return { qs, quizId };
    };
    let seq = 0;
    const sit = (nodeId, right, attemptId = `gate-attempt-${++seq}`) => {
        const { qs, quizId } = bankFor(nodeId);
        const asked = qs.map((q, i) => ({ quizId, index: i, uuid: q.uuid, correct: i < right }));
        return recordMasteryCheck({ nodeId, score: right, total: qs.length, questions: qs, asked, attemptId });
    };
    const row = (id) => db.prepare('SELECT status, completed_at FROM nodes WHERE id = ?').get(id);
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    const open = addNode('Long and short vowels');
    const first = sit(open, 4, 'same-attempt');
    check('a passed check completes its open topic in the same write', first.outcome.passed === true && row(open).status === 'completed',
        JSON.stringify({ outcome: first.outcome.passed, row: row(open) }));
    check('...stamps completed_at as an ISO timestamp', ISO.test(row(open).completed_at ?? ''), row(open).completed_at);
    check('...and says so in its answer (completed: true)', first.outcome.completed === true, JSON.stringify(first.outcome.completed));
    const stamp = row(open).completed_at;
    const again = sit(open, 4, 'same-attempt');
    check('the same attempt sent again writes nothing and answers the same', again.duplicate === true && again.outcome.completed === true && row(open).completed_at === stamp);

    const failed = addNode('Greetings');
    const f = sit(failed, 1);
    check('a failed check leaves its topic as it was', f.outcome.passed === false && row(failed).status === 'in_progress' && f.outcome.completed === false,
        JSON.stringify({ passed: f.outcome.passed, row: row(failed), completed: f.outcome.completed }));

    const early = '2026-01-02T03:04:05.000Z';
    const done = addNode('The alphabet', { status: 'completed', completedAt: early });
    const retake = sit(done, 4);
    check('a passed retake keeps the date the topic was first completed', retake.outcome.completed === true && row(done).completed_at === early, JSON.stringify(row(done)));
    const failedRetake = addNode('Numbers', { status: 'completed', completedAt: early });
    sit(failedRetake, 0);
    check('a failed retake does not reopen a completed topic', row(failedRetake).status === 'completed' && row(failedRetake).completed_at === early, JSON.stringify(row(failedRetake)));

    const skipped = addNode('Diphthongs', { status: 'skipped' });
    sit(skipped, 4);
    check('a pass on a skipped topic completes it (it is proven now)', row(skipped).status === 'completed', JSON.stringify(row(skipped)));

    const section = addNode('Sounds');
    addNode('A topic inside', { parent: section });
    const onSection = sit(section, 4);
    check('a section is never completed by a check written against it', row(section).status === 'in_progress' && onSection.outcome.completed === false, JSON.stringify(row(section)));

    const thin = addNode('Too few checked');
    const { qs, quizId } = bankFor(thin);
    const tooFew = recordMasteryCheck({ nodeId: thin, score: 2, total: 2, questions: qs.slice(0, 2), asked: qs.slice(0, 2).map((q, i) => ({ quizId, index: i, uuid: q.uuid, correct: true })), attemptId: 'thin' });
    check('a check too small to count completes nothing', tooFew.outcome.unproven === true && row(thin).status === 'in_progress', JSON.stringify(tooFew.outcome));
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'Event', 'File', 'SVGSVGElement', 'HTMLCanvasElement']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = (q) => ({ matches: q === '(pointer: fine)', media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => (o ? k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o[n] ?? '')) : k), i18n: { language: 'en' } });`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: {}, subs: new Set() };
        g.__setState = (patch) => { g.__st.state = { ...g.__st.state, ...patch }; g.__st.subs.forEach(f => f()); };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;
        export const themeKeyOf = () => 'light';
        export const isDarkTheme = () => false;`,
    'Markdown': `import { createElement } from 'react'; export default function Markdown({ content }) { return createElement('span', null, content); }`,
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
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*(Markdown|MathText)$/ }, () => ({ path: 'Markdown', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*codeLanguages$/ }, () => ({ path: 'codeLanguages', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: repo }));
        // A copy under --root imports its neighbours: the copy's own when
        // the checkout carries one, else this tree's.
        b.onResolve({ filter: /^\.\.?\// }, async (args) => {
            const imp = args.importer.replace(/\\/g, '/');
            const from = compRoot.replace(/\\/g, '/');
            if (compRoot === realComp || !imp.startsWith(from)) return undefined;
            const rel = dirname(imp.slice(from.length + 1));
            const own = join(compRoot, rel, args.path);
            for (const ext of ['.tsx', '.ts']) if (existsSync(own + ext)) return { path: own + ext };
            return b.resolve(args.path, { resolveDir: join(realComp, rel), kind: args.kind });
        });
    },
};
const cacheDir = join(repo, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const out = join(mkdtempSync(join(cacheDir, 'check-pass-close-gates-')), 'bundle.cjs');
await esbuild.build({
    stdin: {
        contents: `export { default as MasteryGateModal } from '${join(compRoot, 'MasteryGateModal.tsx').replace(/\\/g, '/')}';`,
        resolveDir: repo, loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out,
    jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
    packages: 'external',
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
    plugins: [stubPlugin], logLevel: 'silent',
});
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MasteryGateModal } = require(out);
const h = React.createElement;
const act = (fn) => React.act(fn);
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 40)); });
globalThis.__setState({ projects: [], nodes: [], searchProviders: [], addToast() { }, aiProvider: 'openai', aiModel: 'stub' });

// `set` keeps one case's questions apart from another's: a report filed in one
// case stays in the report store for the rest of the run.
const mcq = (i, set = 0) => ({ type: 'multiple_choice', question: `Question ${i}?`, options: ['3', '4', '5', '6'], correct_answer: '4', explanation: 'Two and two.', quizId: 7, index: i, uuid: `${set}000000${i}-0000-4000-8000-000000000000` });
const buttons = (host, label) => [...host.querySelectorAll('button')].filter(b => b.textContent.trim() === label || b.getAttribute('aria-label') === label);

/**
 * Open a check on a topic with status `status`, answer every question with
 * `answer` and submit; the server says `passed`. Returns the mounted dialog
 * and a log of which callback each way out called.
 */
async function sitCheck({ status = 'in_progress', answer = '4', passed = true, set = 0 } = {}) {
    const calls = [];
    globalThis.__api = {
        drawMasteryCheck: async () => ({ size: 4, bankSize: 4, unverified: 0, minQuestions: 4, status, questions: [0, 1, 2, 3].map(i => mcq(i, set)) }),
        submitMasteryCheck: async (_p, _n, score, total) => ({ passed, pass_threshold: 0.8, score, total, completed: passed || status === 'completed' }),
    };
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const props = {
        isOpen: true, nodeId: 3, nodeTitle: 'Vowels', projectId: 1, advisory: false,
        onClose: () => calls.push('close'),
        // `passed` means onPassed was told the server already completed the
        // topic, so the store refreshes rather than writing it again.
        onPassed: (written) => calls.push(written === true ? 'passed' : 'passed, to be written'),
        onSkip: () => calls.push('skip'),
        onMarkAnyway: () => calls.push('markAnyway'),
    };
    act(() => root.render(h(MasteryGateModal, props)));
    await settle();
    for (let i = 0; i < 4; i++) {
        act(() => { buttons(host, answer)[0]?.click(); });
        if (i < 3) act(() => { buttons(host, 'Next')[0]?.click(); });
    }
    await act(async () => { buttons(host, 'Submit mastery check')[0]?.click(); });
    await settle();
    return { host, calls, done: () => { act(() => root.unmount()); host.remove(); } };
}
const pressEscape = (host) => act(() => {
    const dialog = host.querySelector('[role="dialog"]');
    (dialog ?? document).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

console.log('--- a pass, left each way ---');
{
    const m = await sitCheck();
    // Fixture check: it passes before the fix too, so it detects nothing here.
    check('the passed result is on screen', /Mastery check passed/.test(m.host.textContent), m.host.textContent.slice(0, 200));
    check('...and says the topic IS completed, not that it will be', /this topic is marked completed/.test(m.host.textContent) && !/will be marked/.test(m.host.textContent), m.host.textContent.slice(0, 300));
    act(() => { buttons(m.host, 'Continue')[0]?.click(); });
    check('Continue finishes the topic', m.calls.join() === 'passed', m.calls.join());
    m.done();
}
{
    const m = await sitCheck();
    act(() => { buttons(m.host, 'Close')[0]?.click(); });
    check('the X finishes the topic too, never a bare close', m.calls.join() === 'passed', m.calls.join() || 'nothing called');
    m.done();
}
{
    const m = await sitCheck();
    pressEscape(m.host);
    check('Escape finishes the topic too, never a bare close', m.calls.join() === 'passed', m.calls.join() || 'nothing called');
    m.done();
}

console.log('--- a pass, then a question reported on the result screen ---');
// The server completed the topic with the pass. A report filed afterwards
// leaves three graded answers of a four-question check, too few to count, so
// the screen's own score no longer passes. The topic is still completed, so
// the X and Escape must still take the refresh path, not a bare close.
for (const [set, way, leaveBy] of [[1, 'the X', (host) => act(() => { buttons(host, 'Close')[0]?.click(); })], [2, 'Escape', pressEscape]]) {
    const m = await sitCheck({ set });
    const ref = `q:${mcq(0, set).uuid}`;
    globalThis.__api.itemReportTarget = () => Promise.resolve({ item: null, kind: 'question', canRewrite: false, report: null });
    globalThis.__api.reportItem = () => Promise.resolve({ report: { id: 9, ref, kind: 'question', reason: 'wrong', note: null, surface: 'quiz', editable: false, undoneAt: null, canRewrite: false, rewrite: null } });
    await act(async () => { m.host.querySelector('button[aria-label="This is wrong"]')?.click(); });
    await settle();
    await act(async () => { [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Report')?.click(); });
    await settle();
    const reported = !!m.host.querySelector('button[aria-label="Undo report"]');
    check(`reported after the pass (${way}): the report is filed and the screen says the topic stays completed`,
        reported && /The topic stays completed/.test(m.host.textContent), `reported ${reported}; ${m.host.textContent.slice(0, 300)}`);
    leaveBy(m.host);
    check(`...and ${way} still finishes the topic, never a bare close`, m.calls.join() === 'passed', m.calls.join() || 'nothing called');
    m.done();
}

// Controls. Before the fix the X and Escape only ever closed, so every
// "only closes" case below passes on that code too. They guard the other way:
// that a check which finished nothing never takes the pass path.
console.log('--- nothing to finish (controls) ---');
{
    const m = await sitCheck({ answer: '3', passed: false });
    check('a failed result is on screen', /Not Yet Mastered/.test(m.host.textContent), m.host.textContent.slice(0, 200));
    act(() => { buttons(m.host, 'Close')[0]?.click(); });
    check('the X after a FAILED check only closes', m.calls.join() === 'close', m.calls.join());
    m.done();
}
{
    const m = await sitCheck({ answer: '3', passed: false });
    pressEscape(m.host);
    check('Escape after a FAILED check only closes', m.calls.join() === 'close', m.calls.join());
    m.done();
}
{
    const m = await sitCheck({ status: 'completed' });
    check('a retake says the topic stays completed', /the topic stays completed/.test(m.host.textContent), m.host.textContent.slice(0, 200));
    act(() => { buttons(m.host, 'Close')[0]?.click(); });
    check('the X after a passed RETAKE only closes (the topic is already completed)', m.calls.join() === 'close', m.calls.join());
    m.done();
}
{
    // Half-answered, the X is the deliberate way out and must stay a close.
    const calls = [];
    globalThis.__api = { drawMasteryCheck: async () => ({ size: 4, bankSize: 4, unverified: 0, minQuestions: 4, status: 'in_progress', questions: [0, 1, 2, 3].map(mcq) }) };
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(h(MasteryGateModal, { isOpen: true, nodeId: 3, nodeTitle: 'Vowels', projectId: 1, onClose: () => calls.push('close'), onPassed: () => calls.push('passed') })));
    await settle();
    act(() => { buttons(host, '4')[0]?.click(); });
    act(() => { buttons(host, 'Close')[0]?.click(); });
    check('the X before Submit only closes', calls.join() === 'close', calls.join());
    act(() => root.unmount()); host.remove();
}

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(dirname(out), { recursive: true, force: true }); } catch { /* a cache dir left behind costs nothing */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the library is still open on Windows */ }
process.exit(fail ? 1 : 0);
