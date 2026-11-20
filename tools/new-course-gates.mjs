// tools/new-course-gates.mjs — one door for a new course; the AI sizes it.
//
// Run:  node tools/new-course-gates.mjs              (this checkout)
//       node tools/new-course-gates.mjs --root DIR   (another copy of server/ and src/,
//                                                     e.g. `git archive origin/main server src`,
//                                                     where it must fail)
//
// A course was started from two places: "New Project" made a course in phases
// from a name, a goal and files, and a link field on Projects made a SHORT
// course (one level of a few topics) from one link or one file. The learner had
// to know which door gave which size. Now there is one: the New course window
// opens on a choice (create or import), its Create form takes any mix of links
// and files, and the run decides the size itself (server/courseShape.js).
//
// This asserts, with a stub model on loopback, a scratch library and no
// network (nothing billed, nothing leaves the machine):
//
//   1. the shape is decided in code where code can: material longer than one
//      short course holds is a course in phases with no model call; a reply
//      that names no shape, or a call that fails, is a course in phases;
//   2. through the real create route, a small input the model calls short is
//      written as a short course at once: one level of topics, its source
//      recorded, listed among short courses; the shape call is shown the name,
//      the goal and the material's outline, never the material's text; the
//      goal reaches the short course's own prompt;
//   3. several sources make one short course that says how many more it was
//      made from; a pasted transcript is staged as a link the window can list;
//      a read nobody waits for any more leaves nothing staged; files claimed in
//      a write that rolls back queue no indexing until it commits;
//   1b. (after 3, whose route fixtures it reuses) the bounds and fallbacks of 1
//      through the real route: a book is phased with no shape call, an unusable
//      short answer builds in phases and leaves nothing behind, an open
//      language is settled before a short course;
//   4. the run's new phases map onto the progress screen's stages;
//   5. the REAL New course window (jsdom): it opens on the choice, a handed-back
//      form opens on the form, the focus follows the choice and Back, a paste
//      that is more than links stays in the field, a pasted link is read and
//      its staged id goes to the creation beside a file's, a link that could
//      not be read offers its fix (or says it will be left out) and the
//      transcript box sends the paste, a link removed while it is read lets its
//      late answer go, and many links are read four at a time up to the cap;
//   6. the REAL Projects page has no link field, and no Short courses heading
//      when there are none; a card made from several sources says "+N more".

import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : HERE;
const S = pathToFileURL(join(ROOT, 'server') + '/').href;
const require = createRequire(import.meta.url);

const scratch = mkdtempSync(join(tmpdir(), 'new-course-gates-'));
// In-process, before anything reaches database.js: never the real library.
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra !== '' ? ` — ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---- fixtures -----------------------------------------------------------------------

const SENTENCES = [
    'An index fund buys every company in an index, so its return is the return of the market it follows.',
    'Because nobody picks the shares, the fund costs very little to run, and those low costs compound over the years.',
    'A fee of one percent a year looks small, but over thirty years it can take a quarter of what you would have had.',
    'Spreading money over hundreds of companies means one company failing hardly moves the whole.',
    'Rebalancing once a year keeps the mix you chose instead of the mix the market drifted into.',
];
const prose = (n, from = 0) => Array.from({ length: n }, (_, i) => SENTENCES[(i + from) % SENTENCES.length]).join(' ');
// The body carries a marker the shape call must never see: it is shown the
// outline, not the text.
const BODY_MARK = 'BODYTEXTMARKER';
const SMALL = `# Why fees matter\n\n${prose(20)} ${BODY_MARK}\n\n# What an index holds\n\n${prose(20, 1)}\n\n# Rebalancing once a year\n\n${prose(20, 2)}\n`;
const SECOND = `# Choosing a fund\n\n${prose(18, 3)}\n\n# Costs you do not see\n\n${prose(18, 4)}\n`;
// Over 40,000 words: more than one short course holds.
const BOOK = Array.from({ length: 60 }, (_, i) => `# Chapter ${i + 1}\n\n${prose(40, i)}`).join('\n\n');
const GOAL = 'I want to pick a cheap fund before my first payday next month.';
const DUTCH = Array.from({ length: 12 }, () => 'Een indexfonds koopt alle bedrijven in een index, zodat het rendement gelijk is aan dat van de markt. Omdat niemand de aandelen kiest, kost het fonds heel weinig, en die lage kosten groeien over de jaren mee. Wie elk jaar herbalanceert, houdt de verdeling die hij zelf heeft gekozen.').join(' ');

// ---- stub model -----------------------------------------------------------------------

const calls = [];          // every model call: { kind, system, user }
let shapeReply = 'short';  // 'short' | 'phased' | 'garbage' | 'fail'
let shortReply = 'good';   // 'good' | 'garbage'
const kindOf = (system) => system.includes('You decide what shape a new course takes') ? 'shape'
    : /SHORT COURSE/.test(system) ? 'short'
        : 'other';
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        const body = JSON.parse(raw || '{}');
        const msgs = body.messages || [];
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
        const kind = kindOf(system);
        calls.push({ kind, system, user });
        let content = null;
        if (kind === 'shape' && shapeReply !== 'fail') {
            content = shapeReply === 'garbage' ? 'Hard to say, it could go either way.' : `\`\`\`json\n{"shape": "${shapeReply}"}\n\`\`\``;
        } else if (kind === 'short' && shortReply === 'garbage') {
            content = 'Here are some thoughts on index funds, in no particular format.';
        } else if (kind === 'short') {
            content = JSON.stringify({
                name: 'Index funds in a few days',
                description: 'What an index fund is, why its low cost matters, and how to keep one balanced.',
                topics: ['Why fees matter', 'What an index holds', 'Rebalancing once a year', 'Choosing a fund']
                    .map((title, i) => ({ title, description: `What ${title.toLowerCase()} means for a saver.`, sections: [Math.min(i + 1, 3)] })),
            });
        }
        // Anything else (the phased pipeline's calls) fails: a run judged
        // "phased" is seen to go on to it, and stops there.
        if (content == null) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end('{"error":{"message":"stub: not part of this gate"}}');
        }
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 20 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

// ---- the real app on a scratch library ---------------------------------------------

const { default: db } = await import(`${S}database.js`);
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('creation_find_resources', 'false');
setSetting.run('embedding_enabled', 'false');
setSetting.run('pdf_math_recovery', 'off');
setSetting.run('ui_language', 'en');
const { createApp } = await import(`${S}app.js`);
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const stage = async (name, text) => {
    const form = new FormData();
    form.append('files', new Blob([text], { type: 'text/plain' }), name);
    const r = await (await fetch(`${base}/api/documents/staged`, { method: 'POST', body: form })).json();
    return r.documents?.[0];
};
/** One creation through the real route: its frames and the model calls it made. */
async function create(payload) {
    calls.length = 0;
    const res = await fetch(`${base}/api/ai/create-project`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const frames = [];
    if (res.ok) for (const block of (await res.text()).split('\n\n')) if (block.startsWith('data: ')) frames.push(JSON.parse(block.slice(6)));
    const sized = frames.find(f => f.phase === 'sized') ?? null;
    const done = frames.find(f => f.phase === 'complete') ?? null;
    return { status: res.status, frames, sized, done, calls: calls.slice() };
}

let shape = null;
try { shape = await import(`${S}courseShape.js`); } catch { /* not in this copy */ }

// ---- 1. the bounds -----------------------------------------------------------------
section('1. the shape is decided in code where code can');
// Only that it is there: what it decides is each check below.
ok('server/courseShape.js is there', typeof shape?.decideCourseShape === 'function');
if (shape) {
    let asked = 0;
    const counting = async () => { asked++; return '{"shape":"short"}'; };
    const big = await shape.decideCourseShape({ name: 'A book', words: [25_000, 20_000], generate: counting });
    ok('over 40,000 words in all is a course in phases, and the model is not asked', big.shape === 'phased' && big.by === 'bounds' && asked === 0, big);
    const garbage = await shape.decideCourseShape({ name: 'x', words: [500], generate: async () => 'Maybe short, maybe not.' });
    ok('a reply that names no shape is a course in phases', garbage.shape === 'phased' && garbage.by === 'fallback', garbage);
    const failed = await shape.decideCourseShape({ name: 'x', words: [500], generate: async () => { throw new Error('502'); } });
    ok('a failed call is a course in phases', failed.shape === 'phased' && failed.by === 'fallback', failed);
    ok('a fenced reply and a bare word are both read', shape.readShapeReply('```json\n{"shape": "Short"}\n```') === 'short' && shape.readShapeReply('"phased".') === 'phased' && shape.readShapeReply('{"shape":"long"}') === null);
    const ac = new AbortController(); ac.abort();
    let threw = false;
    try { await shape.decideCourseShape({ name: 'x', words: [500], signal: ac.signal, generate: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } }); } catch { threw = true; }
    ok('a cancelled run is stopped, not built in phases', threw);
}

// ---- 2. a small input, judged short ------------------------------------------------
section('2. a small input the model calls short is a short course, written at once');
const smallDoc = await stage('Index funds.txt', SMALL);
ok('a file is staged', smallDoc?.ok === true, smallDoc);
shapeReply = 'short';
const one = await create({ name: '', description: GOAL, documentIds: [smallDoc?.id] });
const shapeCall = one.calls.find(c => c.kind === 'shape');
ok('the run says it is choosing the size, then which it chose', one.frames.some(f => f.phase === 'sizing') && one.sized?.shape === 'short' && one.sized?.by === 'model', one.frames.map(f => f.phase));
ok('the shape call is shown the goal and the material\'s outline', !!shapeCall && shapeCall.user.includes(GOAL) && shapeCall.user.includes('Why fees matter') && shapeCall.user.includes('Rebalancing once a year'), shapeCall?.user);
ok('the shape call is shown the headings, not one sentence of the material', !!shapeCall && ![...SENTENCES, BODY_MARK].some(s => shapeCall.user.includes(s) || shapeCall.system.includes(s)));
const { jobOf } = await import(`${S}aiJobs.js`);
ok('the shape call runs on the courses job\'s models', jobOf({ operation: 'course_shape' }) === 'courses');
const shortCall = one.calls.find(c => c.kind === 'short');
ok('the goal reaches the short course\'s prompt', !!shortCall && shortCall.user.includes(GOAL), shortCall?.user?.slice(0, 300));
ok('nothing else is asked: one shape call, one short-course call', one.calls.length === 2 && one.calls.filter(c => c.kind === 'other').length === 0, one.calls.map(c => c.kind));
ok('the run ends as a short course', one.done?.shape === 'short' && Number.isInteger(one.done?.projectId), one.done);
const madeId = one.done?.projectId;
const proj = madeId ? db.prepare('SELECT name, made_from, ai_generating, description FROM projects WHERE id = ?').get(madeId) : null;
const nodes = madeId ? db.prepare('SELECT parent_id FROM nodes WHERE project_id = ? AND is_note = 0').all(madeId) : [];
ok('it remembers what it was made from', !!proj && JSON.parse(proj.made_from || 'null')?.kind != null, proj?.made_from);
ok('it is one level of topics, not phases', nodes.length >= 3 && nodes.length <= 8 && nodes.every(n => n.parent_id == null), nodes.length);
ok('it is not left "being written"', proj?.ai_generating === 0);
ok('the goal is kept as its description', proj?.description === GOAL, proj?.description);
const listed = (await (await fetch(`${base}/api/short-courses`)).json()).courses ?? [];
ok('it is listed among short courses', listed.some(c => c.id === madeId || c.projectId === madeId), listed.map(c => c.id ?? c.projectId));

// ---- 3. several sources, a pasted transcript ----------------------------------------
section('3. several sources make one short course; a pasted transcript is a link');
const pasted = await (await fetch(`${base}/api/short-courses/read`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transcript: SECOND, title: 'Choosing a fund, explained', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
})).json();
ok('the read hands back the staged source as the window lists it', pasted?.ok === true && pasted.staged?.ok === true && pasted.staged.id === pasted.stagedId, pasted);
ok('the staged source says it is a video from youtube.com, pasted', pasted?.staged?.source?.kind === 'video' && pasted.staged.source.pasted === true && pasted.staged.source.host === 'youtube.com', pasted?.staged?.source);
// A read the window stopped waiting for (closed, or the row removed) while the
// server was still reading: what it staged goes at once, not at the daily sweep.
const stagedCount = () => db.prepare('SELECT COUNT(*) AS n FROM staged_documents').get().n;
const sc = await import(`${S}shortCourses.js`);
const beforeGone = stagedCount();
let gone = 'no readSourceFor';
try {
    if (typeof sc.readSourceFor === 'function') gone = await sc.readSourceFor({ transcript: 'The words of a video nobody waits for any more.', title: 'Left behind' }, { signal: AbortSignal.abort() });
} catch (e) { gone = e.message; }
ok('a read nobody waits for any more leaves nothing staged', gone === null && stagedCount() === beforeGone, [gone, beforeGone, stagedCount()]);
ok('the read route answers through it', /readSourceFor\(/.test(readFileSync(join(ROOT, 'server/routes/shortCourses.js'), 'utf8')));

// Files claimed inside a write that rolls back queue no indexing or PDF
// recovery for document ids that no longer exist; the jobs wait for the commit.
const sd = await import(`${S}stagedDocuments.js`);
const held = await stage('Held back.txt', SMALL.replace(BODY_MARK, ''));
const jobs = [];
try {
    db.transaction(() => {
        const pid = Number(db.prepare("INSERT INTO projects (name) VALUES ('Rolled back')").run().lastInsertRowid);
        sd.claimStaged([held?.id], pid, jobs);
        throw new Error('roll back');
    })();
} catch { /* rolled back, as a failed short write is */ }
ok('files claimed in a write that rolls back queue nothing until it commits, and stay staged', jobs.length === 1 && !!db.prepare('SELECT 1 FROM staged_documents WHERE id = ?').get(held?.id ?? ''), [jobs.length, held?.id]);
const shortSource = readFileSync(join(ROOT, 'server/shortCourses.js'), 'utf8');
ok('the short course runs them only after its write commits', /projectId, afterCommit\)/.test(shortSource) && /\}\)\(\);\s+for \(const job of afterCommit\) job\(\);/.test(shortSource));
const fileTwo = await stage('Fund costs.txt', SMALL.replace(BODY_MARK, ''));
const two = await create({ name: 'Index funds', description: '', documentIds: [pasted?.stagedId, fileTwo?.id] });
ok('a link and a file together are one short course', two.done?.shape === 'short', two.frames.map(f => f.phase));
const twoShape = two.calls.find(c => c.kind === 'shape');
ok('the shape call is told the pasted source is a video, not a text file', !!twoShape && /video/i.test(twoShape.user), twoShape?.user);
const twoRow = (await (await fetch(`${base}/api/short-courses`)).json()).courses?.find(c => (c.id ?? c.projectId) === two.done?.projectId);
ok('its card knows it was made from one more source', twoRow?.more === 1, twoRow);

// ---- 1b. the bounds and fallbacks, through the route ---------------------------------
section('1b. the same bounds through the real route');
const book = await stage('A whole book.txt', BOOK);
shapeReply = 'short';
const big = await create({ name: 'Investing', description: '', documentIds: [book?.id] });
ok('a book is a course in phases, and no shape call is made', big.sized?.shape === 'phased' && big.sized?.by === 'bounds' && !big.calls.some(c => c.kind === 'shape'), [big.sized, big.calls.map(c => c.kind)]);
ok('it goes on to the phased pipeline', big.calls.some(c => c.kind === 'other') && !big.calls.some(c => c.kind === 'short'));
{
    // What a reloaded page reattaches from keeps the reason with the shape.
    const gens = (await (await fetch(`${base}/api/ai/creation-status`)).json()).generations ?? [];
    const run = gens.find(g => g.shape === 'phased');
    ok('the run\'s snapshot says the length decided it', run?.shapeBy === 'bounds', gens.map(g => [g.name, g.shape, g.shapeBy]));
}
shapeReply = 'garbage';
const gar = await create({ name: 'Index funds again', description: '' });
ok('a reply that names no shape builds in phases', gar.sized?.shape === 'phased' && gar.sized?.by === 'fallback' && !gar.calls.some(c => c.kind === 'short'), gar.sized);
shapeReply = 'fail';
const failed = await create({ name: 'Index funds once more', description: '' });
ok('a failed shape call builds in phases', failed.sized?.shape === 'phased' && failed.sized?.by === 'fallback', failed.sized);
shapeReply = 'short';
{
    // A short answer with no topics in it: nothing half-made, built in phases.
    shortReply = 'garbage';
    const shortsBefore = (await (await fetch(`${base}/api/short-courses`)).json()).courses?.length ?? -1;
    const bad = await create({ name: 'Index funds, one more time', description: '' });
    const shortsAfter = (await (await fetch(`${base}/api/short-courses`)).json()).courses?.length ?? -2;
    shortReply = 'good';
    const sizes = bad.frames.filter(f => f.phase === 'sized').map(f => `${f.shape}/${f.by}`);
    ok('an unusable short-course answer builds in phases', sizes.join(',') === 'short/model,phased/fallback' && bad.calls.some(c => c.kind === 'other'), [sizes, bad.calls.map(c => c.kind)]);
    ok('it leaves no short course behind', shortsAfter === shortsBefore && bad.done?.shape !== 'short', [shortsBefore, shortsAfter]);
    // A name the window filled in from the file is not the learner's: the
    // short course names itself (the stub answers "Index funds in a few days").
    const fileNamed = await stage('Index funds.txt', SMALL);
    const filled = await create({ name: 'Index funds', description: '', documentIds: [fileNamed?.id] });
    const filledName = db.prepare('SELECT name FROM projects WHERE id = ?').get(filled.done?.projectId ?? -1)?.name;
    ok('a name filled in from the file is not kept as the learner\'s', filled.done?.shape === 'short' && filledName === 'Index funds in a few days', [filled.done?.shape, filledName]);
    // Material in another language than the learner writes in leaves the
    // language open: the identity call settles it before the short course.
    const dutch = await stage('Indexfondsen.txt', `# Waarom kosten tellen\n\n${DUTCH}\n\n# Wat een index bevat\n\n${DUTCH}\n`);
    const open = await create({ name: '', description: GOAL, documentIds: [dutch?.id] });
    ok('a short run whose language is open settles it first, then is a short course', open.done?.shape === 'short' && /^shape,(other,)+short$/.test(open.calls.map(c => c.kind).join(',')), [open.done?.shape, open.calls.map(c => c.kind)]);
    const plain = one.calls.map(c => c.kind).join(',');
    ok('a short run with its language settled makes no identity call', plain === 'shape,short', plain);
    ok('its "writing the topics" step is closed, not left running', bad.frames.some(f => f.phase === 'topics_written' && f.failed === true));
    const after = bad.frames.slice(bad.frames.findIndex(f => f.phase === 'sized' && f.shape === 'phased') + 1).filter(f => f.track);
    ok('the phased run that follows keeps no clock from the failed attempt', after.length > 0 && after.every(f => !f.track.stageTimes?.build), after.map(f => [f.phase, Object.keys(f.track.stageTimes || {})]));
}
{
    // The short path's frames name the course on the step that made it.
    const fin = one.frames.find(f => f.phase === 'topics_written');
    ok('the short course\'s id and name ride on its topics frame, with no second init', fin?.projectId === one.done?.projectId && typeof fin?.projectName === 'string' && fin.projectName.length > 0 && !one.frames.some(f => f.phase === 'init' && f.projectId), fin);
}
const bare = await create({ name: 'Tying a bowline knot', description: 'just the knot' });
ok('a name alone, judged short, is written from the name', bare.done?.shape === 'short' && JSON.parse(db.prepare('SELECT made_from FROM projects WHERE id = ?').get(bare.done?.projectId ?? -1)?.made_from || 'null')?.kind === 'topic', bare.done);

// ---- 4. progress stages ----------------------------------------------------------------
section('4. the new phases map onto the progress screen');
const { stageOf } = await import(`${S}creationEta.js`);
ok('sizing and sized are thinking', stageOf('sizing', 'queued') === 'think' && stageOf('sized', 'queued') === 'think', [stageOf('sizing', 'queued'), stageOf('sized', 'queued')]);
ok('writing and written topics are building', stageOf('writing_topics', 'think') === 'build' && stageOf('topics_written', 'think') === 'build', [stageOf('writing_topics', 'think'), stageOf('topics_written', 'think')]);

// ---- 5-6. the real window and the real Projects page ---------------------------------
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import NewProjectModal from './src/components/NewProjectModal';
            import ProjectsGrid from './src/components/ProjectsGrid';
            import { createElement as h, act } from 'react';
            import { createRoot } from 'react-dom/client';
            import { MemoryRouter } from 'react-router-dom';
            const mountModal = (el, draft) => {
                const r = createRoot(el);
                act(() => r.render(h(MemoryRouter, null, h(NewProjectModal, { isOpen: true, draft, onClose: () => {} }))));
                return r;
            };
            const mountProjects = (el) => {
                const r = createRoot(el);
                act(() => r.render(h(MemoryRouter, { initialEntries: ['/projects'] }, h(ProjectsGrid))));
                return r;
            };
            import * as creationLog from './src/components/creation/creationLog';
            window.__gate = { useStore, mountModal, mountProjects, act, creationLog };`,
        resolveDir: ROOT, loader: 'tsx',
    },
    // A copy outside this checkout still takes its packages from here.
    nodePaths: [join(HERE, 'node_modules')],
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
})).outputFiles[0].text;

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
// A touchscreen unless a case says otherwise: `hasPhysicalKeyboard()` reads
// `(pointer: fine)`.
let pointerFine = false;
w.matchMedia = (q) => ({ matches: pointerFine && q.includes('pointer: fine'), media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
w.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
w.IntersectionObserver = class { observe() { } unobserve() { } disconnect() { } };
w.IS_REACT_ACT_ENVIRONMENT = true;
w.MessageChannel = MessageChannel;
w.HTMLElement.prototype.scrollIntoView = function () { };
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const LINK = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';
const DEAD = 'https://www.youtube.com/watch?v=ccccccccccc';
const GONE = 'https://example.org/slow-page';
const stagedDoc = (id, title, source = null) => ({
    ok: true, id, title, suggestedTitle: title, titleFrom: 'metadata', file_type: 'text', file_size: 4000,
    page_count: null, char_count: 4000, noText: false, language: 'en', original_filename: `${title}.txt`,
    structure: { method: 'none', topCount: 0, sections: [] }, source,
});
let library = [];
let shortRows = [];
const reads = [];      // { body, answer(r) }
const discarded = [];  // staged ids let go
const sent = [];       // creation bodies
w.fetch = (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (/\/api\/projects(\?|$)/.test(u)) return Promise.resolve(json(library));
    if (/\/api\/short-courses(\?|$)/.test(u) && method === 'GET') return Promise.resolve(json({ courses: shortRows }));
    if (/\/api\/settings(\?|$)/.test(u)) return Promise.resolve(json({}));
    const del = u.match(/\/api\/(?:short-courses\/read|documents\/staged)\/([^/?]+)/);
    if (del && method === 'DELETE') { discarded.push(decodeURIComponent(del[1])); return Promise.resolve(json({ ok: true, removed: true })); }
    if (/\/api\/short-courses\/read(\?|$)/.test(u)) {
        const body = JSON.parse(String(init.body || '{}'));
        return new Promise((done, failed) => {
            reads.push({ body, answer: (r) => done(json(r)) });
            // As a real fetch does, a read fails once its signal is aborted;
            // the slow page's answer is already on its way when it is removed.
            const signal = body.url === GONE ? null : init.signal;
            if (signal) {
                const stop = () => failed(new w.DOMException('The operation was aborted.', 'AbortError'));
                if (signal.aborted) stop(); else signal.addEventListener('abort', stop);
            }
        });
    }
    if (/\/api\/documents\/staged(\?|$)/.test(u) && method === 'POST') {
        const names = [...init.body.getAll('files')].map(f => f.name);
        return Promise.resolve(json({ documents: names.map((n, i) => stagedDoc(`staged-file-${i}`, n.replace(/\.\w+$/, ''))) }));
    }
    if (/\/api\/ai\/create-project(\?|$)/.test(u)) { sent.push(JSON.parse(String(init.body || '{}'))); return new Promise(() => { }); }
    return new Promise(() => { });
};
w.eval(bundle);
const { useStore, mountModal, mountProjects, act, creationLog } = w.__gate;

// The size line says why when the material alone decided it.
const sizeSays = creationLog.shapeLine;
ok('a course in phases because the material was long says so; the model\'s call gives no reason',
    typeof sizeSays === 'function' && /long/.test(sizeSays('phased', 'bounds')) && !/long/.test(sizeSays('phased', 'model'))
    && !/long/.test(sizeSays('phased', 'fallback')) && sizeSays('short', 'model') === 'A short course: a few topics on one level',
    typeof sizeSays === 'function' ? [sizeSays('phased', 'bounds'), sizeSays('phased', 'model')] : 'no shapeLine');
useStore.setState({ projects: library, _navigate: () => { } });
const settle = async () => { await act(async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); }); };
const el = w.document.getElementById('root');
const all = () => w.document.body;
const buttons = () => [...all().querySelectorAll('button')];
const buttonNamed = (name) => buttons().find(b => b.textContent.trim() === name || b.getAttribute('aria-label') === name);
const click = async (node) => { await act(async () => { node.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }); await settle(); };
const press = async (name) => {
    const b = buttonNamed(name);
    if (!b) throw new Error(`no "${name}" button: ${all().textContent.slice(0, 300)}`);
    await click(b);
};
const fill = async (node, value) => {
    const proto = node.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value); node.dispatchEvent(new w.Event('input', { bubbles: true })); });
    await settle();
};
const paste = async (node, text) => {
    const ev = new w.Event('paste', { bubbles: true, cancelable: true });
    ev.clipboardData = { files: [], getData: () => text };
    await act(async () => { node.dispatchEvent(ev); });
    await settle();
    return ev;
};
const focused = () => w.document.activeElement;
const nameField = () => [...all().querySelectorAll('input')].find(i => /Machine Learning/.test(i.placeholder || ''));
const linkField = () => [...all().querySelectorAll('input')].find(i => /Paste a link/.test(i.placeholder || ''));

section('5. the New course window');
let r = null;
try {
    await act(async () => { r = mountModal(el, null); });
    await settle();
    ok('a plain open asks first: create a course, or import one', (buttons().some(b => b.textContent.includes('Create a course')) && buttons().some(b => b.textContent.includes('Import a course'))), all().textContent.slice(0, 300));
    ok('the choice comes before the form: no Name field yet', !nameField());
    ok('the first step has no way back', !buttonNamed('Back'));
    act(() => r.unmount());
    await act(async () => { r = mountModal(el, { name: 'Knots', description: '', color: '', icon: '', language: '', documents: [] }); });
    await settle();
    ok('a handed-back form opens on the form itself', nameField()?.value === 'Knots', nameField()?.value);
    // On a touchscreen the dialog itself takes the focus (no on-screen keyboard
    // over the form); with a keyboard, the first field does. Never the ←.
    ok('…with its ← drawn; on a touchscreen the focus is on the dialog, not the ←', !!buttonNamed('Back') && focused()?.getAttribute?.('role') === 'dialog', focused()?.outerHTML?.slice(0, 120));
    act(() => r.unmount());
    pointerFine = true;
    await act(async () => { r = mountModal(el, { name: 'Knots', description: '', color: '', icon: '', language: '', documents: [] }); });
    await settle();
    ok('…and with a keyboard on the Name field', !!buttonNamed('Back') && focused() === nameField(), focused()?.outerHTML?.slice(0, 120));
    pointerFine = false;
    act(() => r.unmount());

    await act(async () => { r = mountModal(el, null); });
    await settle();
    const create = buttons().find(b => b.textContent.includes('Create a course'));
    if (create) { await act(async () => { create.focus(); }); await click(create); }
    ok('Create a course opens one form with a material field', !!nameField() && !!linkField(), all().textContent.slice(0, 300));
    ok('the focus moves into the form, not onto the page', focused() !== w.document.body && !!focused()?.closest('[role="dialog"]'), focused()?.outerHTML?.slice(0, 120));
    // In the head, before the title: a row of its own in the body held one
    // small button.
    const backHead = buttonNamed('Back')?.parentElement;
    const head = backHead?.closest('.border-b');
    ok('past the choice, Back is a ← before the title', backHead?.querySelector('h2')?.textContent === 'New course' && !!head && !head.contains(nameField()) && !buttonNamed('Back').textContent.trim(), backHead?.outerHTML?.slice(0, 160));
    await press('Back');
    ok('Back puts the focus on the first choice', !!focused()?.hasAttribute?.('data-tile') && focused().textContent.includes('Create a course'), focused()?.outerHTML?.slice(0, 120));
    // The chatbot view is reached from Import, so its ← goes back there, then
    // to the choice.
    const imp = buttons().find(b => b.textContent.includes('Import a course'));
    if (imp) await click(imp);
    const chatbot = buttons().find(b => b.textContent.includes('Or make a course with an external chatbot'));
    if (chatbot) await click(chatbot);
    const onChatbot = all().textContent.includes('Make a course with an external chatbot');
    await press('Back');
    ok('the chatbot view\'s ← goes to Import, not to the choice', onChatbot && !!buttons().find(b => b.textContent.includes('Or make a course with an external chatbot')) && !!buttonNamed('Back'), all().textContent.slice(0, 200));
    await press('Back');
    const again = buttons().find(b => b.textContent.includes('Create a course'));
    if (again) await click(again);

    // A paste with words around its link is the learner's text: left in the field.
    const mixed = await paste(linkField(), 'Watch this first: https://example.org/intro and then the rest');
    ok('a paste with more than links in it is not taken over', reads.length === 0 && !mixed.defaultPrevented, [reads.length, mixed.defaultPrevented]);
    const bracketed = await paste(linkField(), '(https://example.org/bracketed) https://en.wikipedia.org/wiki/Mercury_(planet).');
    ok('links in brackets are read without them; a link\'s own brackets stay', bracketed.defaultPrevented && reads.map(x => x.body.url).join(' ') === 'https://example.org/bracketed https://en.wikipedia.org/wiki/Mercury_(planet)', reads.map(x => x.body.url));
    for (const x of reads.splice(0)) await act(async () => { x.answer({ ok: false, reason: 'not_found', fix: null, url: x.body.url, host: 'example.org' }); });
    await settle();
    ok('a link that cannot be read says it will be left out', /It will be left out\./.test(all().textContent), all().textContent.slice(0, 600));
    for (const b of buttons().filter(b => /^Remove .*(example\.org|wikipedia)/.test(b.getAttribute('aria-label') || ''))) await click(b);
    const quoted = await paste(linkField(), '«https://example.org/guillemets» “https://example.org/curly”');
    ok('links in « » or curly quotes are read without them', quoted.defaultPrevented && reads.map(x => x.body.url).join(' ') === 'https://example.org/guillemets https://example.org/curly', reads.map(x => x.body.url));
    for (const x of reads.splice(0)) await act(async () => { x.answer({ ok: false, reason: 'not_found', fix: null, url: x.body.url, host: 'example.org' }); });
    await settle();
    for (const b of buttons().filter(b => /^Remove .*example\.org/.test(b.getAttribute('aria-label') || ''))) await click(b);

    // A pasted link is read at once.
    await paste(linkField(), LINK);
    ok('a pasted link is read at once', reads.length === 1 && reads[0].body.url === LINK, reads.map(x => x.body));
    await act(async () => { reads[0].answer({ ok: true, stagedId: 'staged-link', kind: 'video', title: 'Index funds in 12 minutes', staged: stagedDoc('staged-link', 'Index funds in 12 minutes', { kind: 'video', url: LINK, host: 'youtube.com', minutes: 12, pasted: false }) }); });
    await settle();
    ok('a read link is listed as a video with its length and site', /Index funds in 12 minutes/.test(all().textContent) && /Video · 12 min · youtube\.com/.test(all().textContent), all().textContent.slice(0, 600));

    // A file joins the same list.
    const fileInput = [...all().querySelectorAll('input[type="file"]')].find(i => !i.hasAttribute('webkitdirectory'));
    const file = new w.File(['notes'], 'Lecture notes.txt', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    await act(async () => { fileInput.dispatchEvent(new w.Event('change', { bubbles: true })); });
    await settle();
    ok('a file joins the same list', /Lecture notes/.test(all().textContent));

    // A link that cannot be read offers its fix; the transcript box sends the paste.
    await fill(linkField(), DEAD);
    await press('Add link');
    const deadRead = reads.find(x => x.body.url === DEAD);
    await act(async () => { deadRead?.answer({ ok: false, reason: 'token_wall', fix: 'transcript', title: 'A video with no captions', url: DEAD, host: 'youtube.com' }); });
    await settle();
    ok('a link that could not be read offers to paste its transcript', !!buttonNamed('Paste the transcript'), all().textContent.slice(0, 600));
    ok('a link with a fix says it is left out unless it is fixed', /Left out unless it is fixed\./.test(all().textContent), all().textContent.slice(0, 600));
    if (buttonNamed('Paste the transcript')) await press('Paste the transcript');
    const box = all().querySelector('textarea[aria-label="The video\'s transcript"]');
    ok('the transcript box opens in the row', !!box);
    if (box) await fill(box, 'The words of the video, copied from YouTube.');
    if (buttonNamed('Add the transcript')) await press('Add the transcript');
    const pasteRead = reads.find(x => x.body.transcript);
    ok('the transcript is sent with the video\'s title and link', pasteRead?.body.transcript === 'The words of the video, copied from YouTube.' && pasteRead.body.title === 'A video with no captions' && pasteRead.body.url === DEAD, pasteRead?.body);
    await act(async () => { pasteRead?.answer({ ok: true, stagedId: 'staged-pasted', kind: 'video', title: 'A video with no captions', staged: stagedDoc('staged-pasted', 'A video with no captions', { kind: 'video', url: DEAD, host: 'youtube.com', minutes: null, pasted: true }) }); });
    await settle();
    ok('the pasted transcript is listed as one', /Transcript · youtube\.com/.test(all().textContent), all().textContent.slice(0, 700));

    // A link removed while it is read: its late answer is let go.
    await paste(linkField(), GONE);
    const slow = reads.find(x => x.body.url === GONE);
    const removeSlow = buttons().find(b => (b.getAttribute('aria-label') || '').startsWith('Remove') && (b.getAttribute('aria-label') || '').includes('example.org'));
    if (removeSlow) await click(removeSlow);
    await act(async () => { slow?.answer({ ok: true, stagedId: 'staged-late', kind: 'page', title: 'A slow page', staged: stagedDoc('staged-late', 'A slow page', { kind: 'page', url: GONE, host: 'example.org', minutes: null, pasted: false }) }); });
    await settle();
    ok('a link removed while it was read does not come back, and its source is let go', !!removeSlow && !/A slow page/.test(all().textContent) && discarded.includes('staged-late'), [!!removeSlow, discarded]);

    // Create: the links' staged ids go with the file's.
    if (buttonNamed('Create with AI')) await press('Create with AI');
    const ids = sent[0]?.documentIds ?? [];
    ok('Create sends the links and the file together', ids.includes('staged-link') && ids.includes('staged-pasted') && ids.includes('staged-file-0') && !ids.includes('staged-late'), sent[0]);
    act(() => r.unmount());

    // Many links at once are read a few at a time; links over the cap are said.
    await act(async () => { r = mountModal(el, null); });
    await settle();
    const fresh = buttons().find(b => b.textContent.includes('Create a course'));
    if (fresh) await click(fresh);
    reads.length = 0;
    const many = Array.from({ length: 6 }, (_, i) => `https://example.org/part-${i + 1}`);
    await paste(linkField(), many.join('\n'));
    ok('six links pasted at once: four are read, the rest wait their turn', reads.length === 4 && /Reading/.test(all().textContent), reads.map(x => x.body.url));
    await act(async () => { reads[0].answer({ ok: false, reason: 'not_found', fix: null, url: many[0], host: 'example.org' }); });
    await settle();
    ok('one read done, the next starts', reads.length === 5 && reads[4].body.url === many[4], reads.map(x => x.body.url));
    await act(async () => { reads[1].answer({ ok: false, reason: 'not_found', fix: 'retry', url: many[1], host: 'example.org' }); });
    await settle();
    ok('the sixth link takes the freed lane', reads.length === 6 && reads[5].body.url === many[5], reads.map(x => x.body.url));
    // One queue for the whole window: a second paste and a Try again wait
    // for the same four lanes, in the order they were asked.
    const extra = ['https://example.org/extra-1', 'https://example.org/extra-2'];
    await paste(linkField(), extra.join(' '));
    ok('a second paste waits for the same four lanes', reads.length === 6, reads.map(x => x.body.url));
    if (buttonNamed('Try again')) await press('Try again');
    ok('Try again waits its turn too', reads.length === 6 && !buttonNamed('Try again'), reads.map(x => x.body.url));
    for (const i of [2, 3, 4]) {
        await act(async () => { reads[i].answer({ ok: false, reason: 'not_found', fix: null, url: reads[i].body.url, host: 'example.org' }); });
        await settle();
    }
    ok('each freed lane takes the next ask in order: the paste, then the retry', reads.length === 9 && reads.slice(6).map(x => x.body.url).join(' ') === [...extra, many[1]].join(' '), reads.map(x => x.body.url));
    const toastsBefore = useStore.getState().toasts.length;
    await paste(linkField(), Array.from({ length: 100 }, (_, i) => `https://example.org/more-${i}`).join(' '));
    const toast = useStore.getState().toasts.slice(toastsBefore).find(x => /links were left out/.test(x.message));
    const rows = () => all().querySelectorAll('[data-material] ul > li').length;
    ok('links over the 100 a course takes are left out, and it says so', !!toast && rows() === 100, [toast?.message, rows()]);
    ok('a hundred links still go four at a time', reads.length === 9, reads.length);
} catch (e) {
    ok('the window\'s cases ran to their end', false, e.stack || e.message);
}
try { act(() => r?.unmount()); } catch { /* already gone */ }

section('6. the Projects page');
try {
    library = [{ id: 1, name: 'Organic chemistry', color: '#8B5CF6', icon: 'book', status: 'active', position: 1, topic_count: 6, completed_topic_count: 2, progress: 0.3, card_count: 0, last_done_at: null, updated_at: '2026-10-01T10:00:00.000Z' }];
    useStore.setState({ projects: library });
    shortRows = [];
    await act(async () => { r = mountProjects(el); });
    await settle();
    ok('Projects has no link field', ![...el.querySelectorAll('input')].some(i => /link|youtube|http/i.test(`${i.placeholder} ${i.getAttribute('aria-label') || ''}`)), [...el.querySelectorAll('input')].map(i => i.placeholder));
    ok('no Short courses heading when there are none', !/Short courses/.test(el.textContent), el.textContent.slice(0, 300));
    act(() => r.unmount());
    library = [...library, { id: 2, name: 'Index funds', color: '#3B82F6', icon: 'book', status: 'active', position: 2, topic_count: 4, completed_topic_count: 0, progress: 0, card_count: 0, last_done_at: null, updated_at: '2026-11-20T10:00:00.000Z' }];
    useStore.setState({ projects: library });
    shortRows = [{ id: 2, name: 'Index funds', color: '#3B82F6', kind: 'video', from: 'youtube.com', more: 2, url: LINK, minutes: 12, topics: 4, done: 0, icon: 'book', state: 'ready', taskId: null }];
    await act(async () => { r = mountProjects(el); });
    await settle();
    ok('with short courses, the heading counts them', /Short courses · 1/.test(el.textContent), el.textContent.slice(0, 400));
    ok('a card made from several sources says how many more', /\+2 more/.test(el.textContent), el.textContent.slice(0, 600));
    act(() => r.unmount());
} catch (e) {
    ok('the Projects cases ran to their end', false, e.stack || e.message);
}
w.close();
server.close();
stub.close();

console.log(`\n${pass} passed, ${fail} failed${ROOT !== HERE ? ` (server/ and src/ from ${ROOT})` : ''}`);
process.exit(fail ? 1 : 0);
