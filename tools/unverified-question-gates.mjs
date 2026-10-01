// tools/unverified-question-gates.mjs — where a question no verifier confirmed
// can still reach: the mastery check's submission, a course export, and the
// offline quiz audit.
//
// Run:  node tools/unverified-question-gates.mjs [--root <dir>] [--port <n>]
//
// server/questionTrust.js stamps a question the verifier gave no verdict on
// (`unverified`), and question-trust-gates.mjs proves the feed, the draws and a
// practice sitting treat it as practice, never proof. Three more doors:
//
//   1. POST /api/projects/:id/mastery/mastery-check takes a score and a total
//      from the client. The draw never hands a stamped question out, but a list
//      that did not come from the draw (the modal's generated fallback, or any
//      other client) could carry one. The route now runs the score through
//      provenSitting: a stamped question leaves the score, the total and the
//      pass mark; nothing checked at all is `unproven`, with no evidence and no
//      attempt row. The draw says how many it held back, so a bank that
//      exists but is all stamped is not taken for "no bank" and the check
//      does not write another one on every open.
//   2. An export (JSON and the .studyvault bundle) carried the stamp, with this
//      machine's retry schedule in it, and `verifiedAt`. Neither travels now,
//      and the questions themselves still do and import back.
//   3. tools/quiz-audit.mjs defaulted to one machine's model server, and when
//      it confirmed a stamped question it left the stamp on. It now refuses to
//      run without AI_BASE_URL and AI_MODEL (exit 2, before touching any
//      library), and with --repair writes a stamped question's verdict through
//      applyVerdict: confirmed loses the stamp, disputed is deleted. Audit-only
//      writes nothing.
//
// `--root <dir>` runs the same assertions against another checkout's server/
// and tools/ (the pre-fix code) to prove they fail there. A scratch library,
// a stub model on loopback; nothing billed, no network.

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const ROOT = resolve(argOf('--root') || fileURLToPath(new URL('..', import.meta.url)));
const B = pathToFileURL(join(ROOT, 'server') + '/').href;
const AUDIT_TOOL = join(ROOT, 'tools', 'quiz-audit.mjs');

// ---- child mode: seed a library for the audit, in its own process ----------
// The audit writes the SQLite file directly and must not share it with a
// running server, so its library is a second one, made by a second process.
if (argv[0] === '--seed-audit') {
    const dir = argv[1];
    process.env.DB_PATH = join(dir, 'audit.db');
    process.env.VAULT_ROOT = join(dir, 'vault');
    process.env.DATA_DIR = dir;
    const { default: db } = await import(B + 'database.js');
    const pid = db.prepare("INSERT INTO projects (name, status) VALUES ('Audit fixture', 'archived')").run().lastInsertRowid;
    const nid = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, 0)').run(pid, 'Adding small numbers').lastInsertRowid;
    const mc = (text, extra = {}) => ({ question: text, type: 'multiple_choice', options: ['3', '4', '5', '6'], correct_answer: '4', explanation: 'Two and two make four.', ...extra });
    const stamp = (q) => ({ ...q, unverified: { reason: 'verifier returned nothing usable', tries: 1, at: '2026-09-30T08:00:00.000Z', next: '2026-09-30T08:15:00.000Z' } });
    const qid = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(nid, 'bank', JSON.stringify([
        mc('CONFIRM-A: What is 2 + 2?'),
        stamp(mc('CONFIRM-B: What is 1 + 3?')),
        stamp(mc('DISPUTE-C: What is 3 + 1?')),
        mc('CONFIRM-D: What is 0 + 4?'),
    ])).lastInsertRowid;
    db.prepare('INSERT INTO quiz_attempts (quiz_id, score, total, answers) VALUES (?, 1, 1, ?)').run(qid, '{}');
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    console.log(JSON.stringify({ quizId: qid }));
    process.exit(0);
}

// ---- child mode: the two client surfaces, mounted in jsdom -----------------
// In its own process: the DOM globals it installs have no business inside the
// server the parent runs. `--root` mounts that checkout's copies of the
// components (the pre-fix code); whatever a copy imports that the checkout does
// not carry resolves against this tree's src/.
if (argv[0] === '--client') {
    const { createRequire } = await import('node:module');
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const require = createRequire(import.meta.url);
    const esbuild = require('esbuild');
    const { JSDOM } = require('jsdom');
    const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const compRoot = join(ROOT, 'src', 'components');
    const realComp = join(repo, 'src', 'components');
    let pass = 0, fail = 0;
    const check = (name, ok, detail = '') => {
        ok ? pass++ : fail++;
        console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
    };

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
        'Markdown': `import { createElement } from 'react'; export default function Markdown({ content }) { return createElement('div', null, content); }`,
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
    const out = join(mkdtempSync(join(cacheDir, 'unverified-question-gates-')), 'bundle.cjs');
    const entry = (f) => join(compRoot, `${f}.tsx`).replace(/\\/g, '/');
    await esbuild.build({
        stdin: {
            contents: `export { default as MasteryGateModal } from '${entry('MasteryGateModal')}';
                       export { default as QuizView } from '${entry('QuizView')}';`,
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
    const { MasteryGateModal, QuizView } = require(out);
    const h = React.createElement;
    const act = (fn) => React.act(fn);
    const settle = () => act(async () => { await new Promise(r => setTimeout(r, 40)); });
    globalThis.__setState({ projects: [], nodes: [], searchProviders: [], addToast() { }, aiProvider: 'openai', aiModel: 'stub' });
    const mcq = (text, i, extra = {}) => ({ type: 'multiple_choice', question: text, options: ['3', '4', '5', '6'], correct_answer: '4', explanation: 'Two and two.', quizId: 7, index: i, uuid: `uuid-${i}`, ...extra });
    const mount = async (el) => {
        const host = document.createElement('div'); document.body.append(host);
        const r = createRoot(host);
        act(() => r.render(el));
        await settle();
        return { host, done: () => { act(() => r.unmount()); host.remove(); } };
    };
    const buttons = (host, label) => [...host.querySelectorAll('button')].filter(b => b.textContent.trim() === label);
    const answerAll = async (host, n, submitLabel) => {
        for (let i = 0; i < n; i++) {
            act(() => { buttons(host, '4')[0]?.click(); });
            if (i < n - 1) act(() => { buttons(host, 'Next')[0]?.click(); });
        }
        await act(async () => { buttons(host, submitLabel)[0]?.click(); });
        await settle();
    };

    console.log('--- client: the mastery check ---');
    {
        let generated = 0;
        globalThis.__api = {
            drawMasteryCheck: async () => ({ size: 10, bankSize: 2, unverified: 4, minQuestions: 4, status: 'in_progress', questions: [mcq('Checked one?', 0), mcq('Checked two?', 1)] }),
            streamGenerateQuiz: async () => { generated++; throw new Error('not in this case'); },
        };
        const m = await mount(h(MasteryGateModal, { isOpen: true, onClose() { }, nodeId: 3, nodeTitle: 'Adding', projectId: 1, onPassed() { } }));
        const text = m.host.textContent;
        check('a draw of 2 checked questions with 4 held back is not started as a check (no Submit, no "Question 1 of 2")',
            !buttons(m.host, 'Submit mastery check').length && !/Question 1 of 2/.test(text), text.slice(0, 160));
        check('...it says too few are checked yet, and writes no new bank', /Too few of this topic's questions have been checked yet/.test(text) && generated === 0, text.slice(0, 200));
        m.done();
    }
    {
        let sent = null;
        globalThis.__api = {
            drawMasteryCheck: async () => ({ size: 10, bankSize: 4, unverified: 0, minQuestions: 4, status: 'in_progress', questions: [0, 1, 2, 3].map(i => mcq(`Question ${i}?`, i)) }),
            submitMasteryCheck: async (...args) => { sent = args[5]; return { passed: false, unproven: true, proven_total: 2, pass_threshold: 0.8 }; },
        };
        const m = await mount(h(MasteryGateModal, { isOpen: true, onClose() { }, nodeId: 3, nodeTitle: 'Adding', projectId: 1, onPassed() { } }));
        await answerAll(m.host, 4, 'Submit mastery check');
        check('the submission names each question by its uuid', Array.isArray(sent) && sent.length === 4 && sent.every((a, i) => a.uuid === `uuid-${i}` && a.quizId === 7), JSON.stringify(sent));
        check('a check the server found too small says so (not "none could be checked")',
            /Too few of this topic's questions have been checked yet/.test(m.host.textContent), m.host.textContent.slice(0, 200));
        m.done();
    }

    console.log('--- client: a practice sitting ---');
    const bigQuiz = { id: 9, node_id: 3, title: 'Bank', questions: Array.from({ length: 20 }, (_, i) => mcq(`Big ${i}?`, i, { unverified: { reason: 'x', tries: 1 } })) };
    {
        globalThis.__api = { drawQuiz: async () => ({ size: 15, bankSize: 0, unverified: 20, questions: [] }) };
        const m = await mount(h(QuizView, { quiz: bigQuiz, onClose() { } }));
        check('a sampled sitting that came back empty says so, instead of "Loading…" for good',
            !/Loading…/.test(m.host.textContent) && /This quiz has no questions that can be asked\./.test(m.host.textContent), m.host.textContent.slice(0, 160));
        m.done();
    }
    {
        globalThis.__api = { drawQuiz: async () => { throw new Error('Failed to fetch'); } };
        const m = await mount(h(QuizView, { quiz: bigQuiz, onClose() { } }));
        check('...and a draw that failed says that', !/Loading…/.test(m.host.textContent) && /Failed to load quiz/.test(m.host.textContent), m.host.textContent.slice(0, 160));
        m.done();
    }
    {
        let sent = null;
        const small = { id: 9, node_id: 3, title: 'Bank', questions: [mcq('Small 0?', 0), mcq('Small 1?', 1, { unverified: { reason: 'x', tries: 1 } })].map(({ quizId: _q, index: _i, ...q }) => q) };
        globalThis.__api = { submitQuizAttempt: async (...args) => { sent = args[5]; return { id: 1, passThreshold: 0.8 }; } };
        const m = await mount(h(QuizView, { quiz: small, onClose() { } }));
        await answerAll(m.host, 2, 'Submit Quiz');
        check('a practice sitting names each question by its uuid', Array.isArray(sent) && sent.length === 2 && sent.every((a, i) => a.uuid === `uuid-${i}` && a.index === i), JSON.stringify(sent));
        m.done();
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    try { rmSync(dirname(out), { recursive: true, force: true }); } catch { /* a cache dir left behind costs nothing */ }
    process.exit(fail ? 1 : 0);
}

const scratch = mkdtempSync(join(tmpdir(), 'unverified-question-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
};

// ---- the stub verifier: loopback only ---------------------------------------
const verifierCalls = new Map();
const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const msgs = (() => { try { return JSON.parse(body).messages || []; } catch { return []; } })();
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.find(m => m.role === 'user')?.content || '';
        if (!/checking a question before it is shown/.test(system)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end('{"error":{"message":"stub: not part of this gate"}}');
            return;
        }
        const tag = (user.match(/\b(CONFIRM|DISPUTE)-[A-Z]/) || [])[0] || 'NONE';
        verifierCalls.set(tag, (verifierCalls.get(tag) || 0) + 1);
        const content = tag.startsWith('CONFIRM')
            ? JSON.stringify({ verdict: 'ok', answer: '4', reason: 'agrees', eliminable: 0 })
            : JSON.stringify({ verdict: 'ok', answer: '5', reason: 'the key is wrong', eliminable: 0 });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 20 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const STUB_URL = `http://127.0.0.1:${stub.address().port}/v1`;

/** Run a node script without blocking this process (the stub answers from here). */
const run = (args, { env = {}, cwd = scratch } = {}) => new Promise((done) => {
    const clean = { ...process.env };
    for (const k of ['AI_BASE_URL', 'AI_MODEL', 'AI_PROVIDER', 'AI_API_KEY', 'OPENAI_API_KEY', 'DB_PATH', 'VAULT_ROOT', 'DATA_DIR']) delete clean[k];
    const child = spawn(process.execPath, args, { cwd, env: { ...clean, ...env } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('close', (code) => { clearTimeout(timer); done({ code, out }); });
});

// ---- 3. the offline audit (first: it needs no server) -----------------------
console.log('--- 3. tools/quiz-audit.mjs ---');
const auditDir = join(scratch, 'audit');
const auditDb = join(auditDir, 'audit.db');
const libEnv = { DB_PATH: auditDb, VAULT_ROOT: join(auditDir, 'vault'), DATA_DIR: auditDir };

const bare = await run([AUDIT_TOOL, '--no-wait'], { env: libEnv });
check('with neither AI_BASE_URL nor AI_MODEL it refuses, exit 2', bare.code === 2 && /AI_BASE_URL and AI_MODEL are not set/.test(bare.out), `exit ${bare.code}: ${bare.out.slice(0, 160)}`);
check('...before opening any library (no database file was created)', !existsSync(auditDb));
const half = await run([AUDIT_TOOL, '--no-wait'], { env: { ...libEnv, AI_MODEL: 'stub-model' } });
check('with only AI_MODEL it names the one missing, exit 2', half.code === 2 && /^AI_BASE_URL is not set\./m.test(half.out), `exit ${half.code}: ${half.out.slice(0, 160)}`);

const seeded = await run([fileURLToPath(import.meta.url), '--seed-audit', auditDir, ...(argOf('--root') ? ['--root', ROOT] : [])]);
const { quizId: auditQuiz } = (() => { try { return JSON.parse(seeded.out.trim().split('\n').pop()); } catch { return {}; } })();
check('fixture: a bank with two checked and two stamped questions', Number.isInteger(auditQuiz), seeded.out.slice(0, 300));

const { default: Database } = await import('better-sqlite3');
const readBank = () => {
    const d = new Database(auditDb, { readonly: true });
    try { const r = d.prepare('SELECT questions FROM quizzes WHERE id = ?').get(auditQuiz); return r ? JSON.parse(r.questions) : null; }
    finally { d.close(); }
};
const aiEnv = { ...libEnv, AI_BASE_URL: STUB_URL, AI_MODEL: 'stub-model', AI_API_KEY: 'stub-key' };
const before = JSON.stringify(readBank());
const audit = await run([AUDIT_TOOL, '--no-wait'], { env: aiEnv });
check('guard: the audit ran against the stub on loopback and nothing else', audit.out.includes(`via ${STUB_URL}`), audit.out.slice(0, 200));
check('audit-only writes nothing, stamped questions included', JSON.stringify(readBank()) === before);
check('...and says what --repair would do with the confirmed stamp', /1 confirmed now; --repair clears them/.test(audit.out), audit.out.slice(-400));

const repair = await run([AUDIT_TOOL, '--no-wait', '--repair'], { env: aiEnv });
const after = readBank() || [];
const byTag = (tag) => after.find(q => String(q.question).startsWith(tag));
check('--repair: a confirmed stamped question loses its stamp', !!byTag('CONFIRM-B') && !byTag('CONFIRM-B').unverified, JSON.stringify(byTag('CONFIRM-B')));
check('...and records when it was confirmed, as applyVerdict does', typeof byTag('CONFIRM-B')?.verifiedAt === 'string');
check('--repair: a disputed stamped question is deleted, not rewritten', !byTag('DISPUTE-C') && after.length === 3, JSON.stringify(after.map(q => q.question)));
check('the checked questions are untouched', !!byTag('CONFIRM-A') && !!byTag('CONFIRM-D') && !byTag('CONFIRM-A').verifiedAt);
check('...and the tool reports it', /unverified stamps: 1 confirmed and cleared, 1 disputed and deleted/.test(repair.out), repair.out.slice(-400));
{
    const d = new Database(auditDb, { readonly: true });
    check('the quiz attempt already recorded is kept', d.prepare('SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = ?').get(auditQuiz).n === 1);
    d.close();
}

// ---- the real server, on a scratch library ----------------------------------
// A port the system hands out: a random one can land in a range Windows reserves,
// and the server then dies with EACCES before the first case (seen on a CI runner).
process.env.PORT = String(Number(argOf('--port')) || await new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
}));
process.env.HOST = '127.0.0.1';
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = STUB_URL;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';
const { default: db } = await import(B + 'database.js');
const fixture = db.prepare("INSERT INTO projects (name) VALUES ('Fixture: unverified')").run().lastInsertRowid;
const { serverReady } = await import(B + 'index.js');
const ready = await serverReady;
const { request } = await import(ready.proto === 'https' ? 'node:https' : 'node:http');
const rawReq = (path, init = {}) => new Promise((done, reject) => {
    const req = request({
        host: '127.0.0.1', port: ready.port, path, method: init.method || 'GET',
        headers: init.headers || { 'Content-Type': 'application/json' }, rejectUnauthorized: false,
    }, (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => done({ status: res.statusCode, buf: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
});
const api = async (path, init) => {
    const r = await rawReq(path, init);
    let body = null;
    try { body = JSON.parse(r.buf.toString('utf8')); } catch { /* not JSON */ }
    return { status: r.status, body };
};
const listed = await api('/api/projects');
const names = Array.isArray(listed.body) ? listed.body.map(p => p.name) : listed.body;
check('guard: the server is serving the scratch library and nothing else', JSON.stringify(names) === JSON.stringify(['Fixture: unverified']), JSON.stringify(names));
if (JSON.stringify(names) !== JSON.stringify(['Fixture: unverified'])) {
    console.log('\nRefusing to write: the server is not serving the fixture.');
    process.exit(1);
}

const mc = (text, extra = {}) => ({ question: text, type: 'multiple_choice', options: ['3', '4', '5', '6'], correct_answer: '4', explanation: 'Two and two make four.', ...extra });
const stamp = (q) => ({ ...q, unverified: { reason: 'verifier returned nothing usable', tries: 3, at: '2026-09-30T08:00:00.000Z', next: '2026-09-30T10:00:00.000Z' } });
const mkNode = (title, position) => db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, ?)').run(fixture, title, position).lastInsertRowid;
const mkBank = (nodeId, questions) => db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(nodeId, 'bank', JSON.stringify(questions)).lastInsertRowid;
const evidenceOf = (nodeId) => db.prepare("SELECT score, total FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'mastery_check'").all(nodeId);
const attemptsOf = (quizId) => db.prepare('SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = ?').get(quizId).n;
let attemptSeq = 0;
const submit = (nodeId, score, total, asked) => api(`/api/projects/${fixture}/mastery/mastery-check`, {
    method: 'POST',
    body: JSON.stringify({ nodeId, score, total, asked, questions: [], attemptId: `gate-${++attemptSeq}` }),
});

// ---- 1. the mastery check's submission --------------------------------------
console.log('--- 1. the mastery check counts only checked questions ---');
const control = mkNode('Control', 0);
const controlBank = mkBank(control, [mc('Q1'), mc('Q2'), mc('Q3'), mc('Q4'), mc('Q5')]);
let r = await submit(control, 4, 5, [0, 1, 2, 3, 4].map(i => ({ quizId: controlBank, index: i, correct: i < 4 })));
check('control: an all-checked check is judged as sent (4/5 passes at 80%)', r.body?.passed === true && JSON.stringify(evidenceOf(control)) === '[{"score":4,"total":5}]', JSON.stringify([r.body, evidenceOf(control)]));

const mixed = mkNode('Mixed', 1);
const mixedBank = mkBank(mixed, [mc('M1'), mc('M2'), mc('M3'), mc('M4'), stamp(mc('M5'))]);
const uuidsOf = (quizId) => JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(quizId).questions).map(q => q.uuid);
const mixedUuids = uuidsOf(mixedBank);
// No `asked` at all: nothing to look up, and the bank holds a stamped question,
// so the client's 4/5 is not proof.
r = await submit(mixed, 4, 5, []);
check('a submission naming no questions, for a bank holding a stamped one, proves nothing', r.body?.unproven === true && r.body?.passed === false && evidenceOf(mixed).length === 0, JSON.stringify(r.body));
// Three of the four checked answers right, and the stamped one right too: 4/5
// as sent, which passes at 80%; 3/4 as proven, which does not. Named by uuid,
// as the modal names them.
r = await submit(mixed, 4, 5, [0, 1, 2, 3, 4].map(i => ({ quizId: mixedBank, index: i, uuid: mixedUuids[i], correct: i !== 3 })));
check('a stamped question leaves the evidence: 3/4, not 4/5', JSON.stringify(evidenceOf(mixed)) === '[{"score":3,"total":4}]', JSON.stringify(evidenceOf(mixed)));
check('...and the pass mark is judged on the same numbers (3/4 fails at 80%)', r.body?.passed === false && r.body?.raw_score_pct === 75, JSON.stringify(r.body));

const allStamped = mkNode('All stamped', 2);
const stampedBank = mkBank(allStamped, [stamp(mc('S1')), stamp(mc('S2'))]);
const drawn = await api(`/api/nodes/${allStamped}/mastery-check/draw`);
check('the draw hands out none of them, and SAYS it held two back, so the check does not write another bank',
    drawn.status === 200 && drawn.body?.questions?.length === 0 && drawn.body?.unverified === 2, JSON.stringify(drawn.body));
r = await submit(allStamped, 2, 2, [0, 1].map(i => ({ quizId: stampedBank, index: i, correct: true })));
check('nothing checked at all: the check says it did not happen', r.status === 200 && r.body?.unproven === true && r.body?.passed === false, JSON.stringify(r.body));
check('...writes no evidence', evidenceOf(allStamped).length === 0, JSON.stringify(evidenceOf(allStamped)));
check('...and no attempt row that would read as "taken"', attemptsOf(stampedBank) === 0, `${attemptsOf(stampedBank)} rows`);
const again = await submit(allStamped, 2, 2, [0, 1].map(i => ({ quizId: stampedBank, index: i, correct: true })));
check('...and says so again on the next try, rather than passing', again.body?.unproven === true && evidenceOf(allStamped).length === 0, JSON.stringify(again.body));

// ---- 1b. a check too small to judge ------------------------------------------
console.log('--- 1b. fewer than MIN_GATE_QUESTIONS proven answers is not a check ---');
const mostly = mkNode('Mostly stamped', 4);
const mostlyBank = mkBank(mostly, [mc('F1'), mc('F2'), stamp(mc('F3')), stamp(mc('F4')), stamp(mc('F5')), stamp(mc('F6'))]);
const small = await api(`/api/nodes/${mostly}/mastery-check/draw`);
check('the draw hands out the two checked questions, says it held four back, and names the smallest check it will judge',
    small.body?.questions?.length === 2 && small.body?.unverified === 4 && small.body?.minQuestions === 4, JSON.stringify({ n: small.body?.questions?.length, unverified: small.body?.unverified, min: small.body?.minQuestions }));
r = await submit(mostly, 2, 2, (small.body?.questions ?? []).map(q => ({ quizId: q.quizId, index: q.index, uuid: q.uuid, correct: true })));
check('2 of 2 right is NOT a pass: the check was too small to count (judged on those two it would complete the topic)',
    r.body?.passed === false && r.body?.unproven === true && r.body?.proven_total === 2, JSON.stringify(r.body));
check('...and writes no evidence', evidenceOf(mostly).length === 0, JSON.stringify(evidenceOf(mostly)));
check('...but remembers what was asked, so the next check asks the rest',
    db.prepare("SELECT COUNT(*) AS n FROM question_log WHERE quiz_id = ? AND surface = 'mastery_check'").get(mostlyBank).n === 2);
const tiny = mkNode('Three plain questions', 5);
const tinyBank = mkBank(tiny, [mc('T1'), mc('T2'), mc('T3')]);
r = await submit(tiny, 3, 3, uuidsOf(tinyBank).map((uuid, i) => ({ quizId: tinyBank, index: i, uuid, correct: true })));
check('a bank of three unstamped questions is too small too (3/3 is not a pass)', r.body?.passed === false && r.body?.unproven === true && evidenceOf(tiny).length === 0, JSON.stringify(r.body));
const four = mkNode('Four plain questions', 6);
const fourBank = mkBank(four, [mc('U1'), mc('U2'), mc('U3'), mc('U4')]);
r = await submit(four, 4, 4, uuidsOf(fourBank).map((uuid, i) => ({ quizId: fourBank, index: i, uuid, correct: true })));
check('control: four proven answers, all right, pass', r.body?.passed === true && JSON.stringify(evidenceOf(four)) === '[{"score":4,"total":4}]', JSON.stringify(r.body));

// ---- 1c. a veto between the draw and the submission -------------------------
console.log('--- 1c. the submission finds each answer by uuid, whatever a veto moved ---');
const moving = mkNode('Moving bank', 7);
const movingBank = mkBank(moving, [stamp(mc('V0')), mc('V1'), stamp(mc('V2')), mc('V3'), mc('V4'), mc('V5'), mc('V6')]);
const movingDraw = await api(`/api/nodes/${moving}/mastery-check/draw`);
const { applyVerdict } = await import(B + 'questionTrust.js');
const v0 = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(movingBank).questions)[0];
applyVerdict({ where: 'bank', quizId: movingBank, index: 0, uuid: v0.uuid, question: v0 }, { available: true, ok: false, reason: 'the key is wrong' });
// Five drawn and checked; the learner gets V1 wrong and the rest right: 4/5.
// Each named at the place it was drawn from — which the veto has since moved.
const movingAsked = (movingDraw.body?.questions ?? []).map(q => ({ quizId: q.quizId, index: q.index, uuid: q.uuid, correct: !q.question.startsWith('V1') }));
r = await submit(moving, 4, 5, movingAsked);
check('the draw was the five checked questions', movingAsked.length === 5, JSON.stringify(movingDraw.body?.questions?.map(q => q.question)));
check('after the veto the answers still land on the questions answered: 4/5, evidence 4/5',
    r.body?.passed === true && JSON.stringify(evidenceOf(moving)) === '[{"score":4,"total":5}]', JSON.stringify([r.body?.passed, evidenceOf(moving)]));

// ---- 2. an export carries no verification record ---------------------------
console.log('--- 2. an export carries the questions, not this library\'s verification record ---');
const exp = mkNode('Exported', 3);
mkBank(exp, [
    mc('What is 2 + 2 in the exported bank?'),
    stamp(mc('What is 1 + 3 in the exported bank?')),
    { ...mc('What is 0 + 4 in the exported bank?'), verifiedAt: '2026-09-30T09:00:00.000Z' },
]);
const exported = await api(`/api/export/${fixture}`);
const eNode = exported.body?.nodes?.find(n => n.title === 'Exported');
const text = JSON.stringify(exported.body || {});
check('the JSON export still carries all three questions', eNode?.questions?.length === 3, JSON.stringify(eNode?.questions?.map(q => q.question)));
check('...with no `unverified` stamp and no retry schedule', !/"unverified"|"next":"2026|"tries"/.test(text));
check('...and no `verifiedAt`', !text.includes('verifiedAt'));
const bundle = await rawReq(`/api/export/${fixture}/bundle`);
const JSZip = (await import('jszip')).default;
const manifest = bundle.status === 200 ? await (await JSZip.loadAsync(bundle.buf)).file('manifest.json').async('string') : '';
check('the .studyvault bundle carries neither', bundle.status === 200 && manifest.includes('in the exported bank') && !/"unverified"|verifiedAt/.test(manifest), `status ${bundle.status}`);
const back = await api('/api/import', { method: 'POST', body: JSON.stringify(exported.body) });
const backNode = db.prepare("SELECT id FROM nodes WHERE project_id = ? AND title = 'Exported'").get(back.body?.id)?.id;
const backQs = backNode ? db.prepare('SELECT questions FROM quizzes WHERE node_id = ?').all(backNode).flatMap(row => JSON.parse(row.questions)) : [];
check('the file imports back with all three questions', back.status === 200 && backQs.length === 3, `status ${back.status}, ${backQs.length} questions`);
const marked = (eNode?.questions ?? []).filter(q => q.unchecked === true).map(q => q.question);
check('the export says WHICH question no verifier confirmed: `unchecked: true` on that one only',
    JSON.stringify(marked) === JSON.stringify(['What is 1 + 3 in the exported bank?']), JSON.stringify(marked));
const bundleNode = (() => { try { return JSON.parse(manifest).nodes.find(n => n.title === 'Exported'); } catch { return null; } })();
const bundleMarked = (bundleNode?.questions ?? []).filter(q => q.unchecked === true).map(q => q.question);
check('...and the bundle says the same', JSON.stringify(bundleMarked) === JSON.stringify(marked) && marked.length === 1, JSON.stringify(bundleMarked));
const backStamped = backQs.filter(q => q.unverified);
check('the import stamps it pending again (a fresh schedule, due at once), and only it',
    backStamped.length === 1 && backStamped[0].question === 'What is 1 + 3 in the exported bank?' && backStamped[0].unverified.tries === 0
    && Date.parse(backStamped[0].unverified.next) <= Date.now() && !backQs.some(q => 'unchecked' in q), JSON.stringify(backQs.map(q => [q.question, q.unverified ?? null])));
const backDraw = backNode ? await api(`/api/nodes/${backNode}/mastery-check/draw`) : { body: null };
check('...so after the round trip the check still does not draw it: two drawn, one held back',
    backDraw.body?.questions?.length === 2 && backDraw.body?.unverified === 1, JSON.stringify({ n: backDraw.body?.questions?.length, held: backDraw.body?.unverified }));

// ---- 4. a practice sitting from a big, all-stamped row -----------------------
console.log('--- 4. a practice sitting asks stamped questions as practice, drawn or whole ---');
const bigNode = mkNode('Big unchecked bank', 8);
const bigBank = mkBank(bigNode, Array.from({ length: 20 }, (_, i) => stamp(mc(`Big ${i}`))));
const sitting = await api(`/api/ai/quizzes/${bigBank}/draw?size=15`);
check('a row of twenty, all stamped: the sitting is fifteen of them, not an empty list (which leaves the page nothing to show)',
    sitting.body?.questions?.length === 15 && sitting.body.questions.every(q => q.unverified) && sitting.body?.unverified === 20, JSON.stringify({ n: sitting.body?.questions?.length, unverified: sitting.body?.unverified }));
const sat = await api(`/api/ai/quizzes/${bigBank}/attempt`, {
    method: 'POST',
    body: JSON.stringify({ answers: {}, score: 15, total: 15, asked: sitting.body.questions.map(q => ({ index: q.index, uuid: q.uuid, correct: true })), attemptId: 'gate-big-1' }),
});
check('...and 15/15 on them writes no evidence (practice, never proof)', sat.status === 200 && db.prepare('SELECT COUNT(*) AS n FROM mastery_evidence WHERE node_id = ?').get(bigNode).n === 0, JSON.stringify(sat.body));
const mockCheck = await api(`/api/nodes/${bigNode}/mastery-check/draw`);
check('control: the mastery check still draws none of them', mockCheck.body?.questions?.length === 0 && mockCheck.body?.unverified === 20);

// ---- 5. the client surfaces (a child process: jsdom stays out of the server) ----
console.log('--- 5. the mastery check and the practice quiz, mounted ---');
const client = await run([fileURLToPath(import.meta.url), '--client', ...(argOf('--root') ? ['--root', ROOT] : [])], { cwd: process.cwd() });
for (const line of client.out.split('\n')) {
    if (/^ ( ok  |FAIL )/.test(line)) { console.log(line); line.startsWith('  ok') ? pass++ : fail++; }
}
if (!/\d+ passed, \d+ failed/.test(client.out)) check('the client harness ran', false, client.out.slice(-600));

console.log(`\n${pass} passed, ${fail} failed`);
stub.close();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the open database holds it on Windows */ }
process.exit(fail ? 1 : 0);
