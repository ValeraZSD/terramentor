// tools/creation-outline-gates.mjs — a course creation whose outline the model
// never wrote is reported as failed, never as "fully created".
//
// Run:  node tools/creation-outline-gates.mjs [--server <dir>]
//
// Each level of the outline (the phases, a phase's sections, a section's
// topics) is asked of the model up to three times, and an answer that cannot
// be parsed into at least one item is asked again. When all three fail, that
// level is empty. With the phase plan empty, the run used to write nothing, send
// `phase: 'complete'` and show "Project fully created!" over a course with
// zero topics. A phase or section left empty became a topic of its own, and the
// run was still reported complete. This asserts, against the REAL routes on
// a scratch library and a stub model on loopback (nothing billed, nothing
// leaves the machine), that:
//
//   1. a phase plan that cannot be parsed, three times, ends the run in the
//      error path: an error frame that says so, no "complete", nothing asked
//      or written below it, the project's "AI generation failed" note, and
//      the model's own answer in the task's failure record;
//   2. a phase plan that parses on its third try still builds the course;
//   3. a phase whose sections cannot be parsed, and a section whose topics
//      cannot be parsed, are named in the error; everything else in the
//      course is still written;
//   4. the creation screen's run store, fed those runs' own frames, ends with
//      nothing spinning: the part that stopped reads as failed.
//
// `--server <dir>` runs the same cases against another copy of server/ (the
// pre-change code, e.g. `git archive origin/main server | tar -x -C temp/head`);
// that code is expected to FAIL cases 1 and 3.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const B = argOf('--server')
    ? pathToFileURL(resolve(argOf('--server')) + '/').href
    : new URL('../server/', import.meta.url).href;

const scratch = mkdtempSync(join(tmpdir(), 'creation-outline-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};

// ---- the stub model -------------------------------------------------------------
const stage = (system) =>
    system.includes('review the name and description') ? 'identity'
    : system.includes('Write out your thoughts') ? 'thinking'
    : system.includes('Summarize this learning project') ? 'summary'
    : system.includes('top-level categories') ? 'categories'
    : system.includes('Create sub-topics (elements)') ? 'elements'
    : system.includes('for EVERY topic') ? 'sub_batch'
    : system.includes('detailed sub-elements (leaf nodes)') ? 'sub_one'
    : 'other';

// What a model that ignores the format sends: the cloud review's own stub.
const UNREADABLE = 'Hello from the stub model.';

function answer(st, user) {
    if (st === 'identity') return JSON.stringify({ keep_name: true, name: '', keep_description: true, description: '', reason: 'both are good' });
    if (st === 'thinking') return 'Plan: waves first, then optics.';
    if (st === 'summary') return 'A course on waves and optics.';
    if (st === 'categories') return JSON.stringify({ categories: [
        { title: 'Waves', description: 'What a wave is' },
        { title: 'Optics', description: 'Light as a wave' },
    ] });
    // Each phase its own sections: a phase that writes the earlier one's
    // again has them dropped as repeats (course-size-gates.mjs).
    if (st === 'elements') return JSON.stringify({ elements: user.includes('Learning Phase: Optics') ? [
        { title: 'Describing light', description: 'Rays and wavefronts' },
        { title: 'Lenses and mirrors', description: 'Images' },
    ] : [
        { title: 'Describing a wave', description: 'Amplitude, wavelength, frequency' },
        { title: 'Wave behaviour', description: 'Reflection, refraction, interference' },
    ] });
    if (st === 'sub_batch') {
        const listed = [...user.matchAll(/^\d+\. (.+?)(?: — .*)?$/gm)].map(m => m[1]);
        return JSON.stringify({ topics: listed.map(title => ({
            element: title,
            subElements: [{ title: `${title}: the idea`, description: 'The idea' }, { title: `${title}: in practice`, description: 'Practice' }],
        })) });
    }
    if (st === 'sub_one') return JSON.stringify({ subElements: [{ title: 'One leaf', description: 'One' }] });
    return null;
}

// Which calls get the unreadable answer: `(stage, user, nth) => boolean`,
// where `nth` counts that stage's calls from 1.
let unreadable = () => false;
let calls = {};

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
        const st = stage(system);
        calls[st] = (calls[st] || 0) + 1;
        // Numbered, so the failure record can be shown to keep the LAST answer.
        const content = unreadable(st, user, calls[st]) ? `${UNREADABLE} (${calls[st]})` : answer(st, user);
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

// ---- the real app on a scratch library ------------------------------------------
const { default: db } = await import(`${B}database.js`);
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('creation_find_resources', 'false');   // no web search from a gate
setSetting.run('embedding_enabled', 'false');
setSetting.run('ui_language', 'en');
const { createApp } = await import(`${B}app.js`);
const tasks = await import(`${B}tasks.js`);

const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const NOTE = 'AI generation failed';
async function create(name, rule = () => false) {
    unreadable = rule; calls = {};
    const res = await fetch(`${base}/api/ai/create-project`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, description: 'Waves, then optics.', content_language: 'en' }),
    });
    const frames = [];
    const text = await res.text();
    for (const line of text.split('\n\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
    const done = frames.find(f => f.phase === 'complete');
    const error = frames.find(f => f.phase === 'error');
    const id = done?.projectId ?? frames.findLast(f => f.projectId)?.projectId;
    const titles = id ? db.prepare('SELECT title FROM nodes WHERE project_id = ? AND is_note = 0 ORDER BY id').all(id).map(n => n.title) : [];
    const note = id ? db.prepare('SELECT description FROM nodes WHERE project_id = ? AND is_note = 1 AND title = ?').get(id, NOTE) : null;
    const generating = id ? db.prepare('SELECT ai_generating FROM projects WHERE id = ?').get(id)?.ai_generating : null;
    const task = tasks.listTasks().findLast(t => t.kind === 'create_project');
    return { done, error, id, titles, note, generating, task, frames, calls: { ...calls } };
}

// ---- 0. the control: every answer parses ----------------------------------------
console.log('\n=== every answer parses: the tree a creation builds ===');
let r = await create('Waves course');
ok('the run completes', !!r.done && !r.error, JSON.stringify(r.error));
ok(`its tree: 2 phases × 2 sections × 2 topics = 14 nodes (got ${r.titles.length})`, r.titles.length === 14);
ok('no "AI generation failed" note', !r.note);
const fullTree = r.titles;

// ---- 1. a phase plan that never parses ------------------------------------------
console.log('\n=== a phase plan that cannot be parsed, three times ===');
r = await create('Waves course 1', (st) => st === 'categories');
ok('the run ends in an error, not "complete"', !!r.error && !r.done, JSON.stringify(r.done));
ok('after three phase-plan answers', r.calls.categories === 3, JSON.stringify(r.calls));
ok('the error says the phase plan could not be parsed', /phase plan/i.test(r.error?.error || '') && /parse/i.test(r.error?.error || ''), r.error?.error);
ok('nothing is asked below an empty plan', !r.calls.elements && !r.calls.sub_batch && !r.calls.sub_one, JSON.stringify(r.calls));
ok('nothing is written but the project', r.titles.length === 0, JSON.stringify(r.titles));
ok('the project carries the "AI generation failed" note, with the reason', !!r.note && /phase plan/i.test(r.note.description || ''), JSON.stringify(r.note));
ok('the project is no longer marked as generating', r.generating === 0, String(r.generating));
const f = r.task?.failure || {};
ok('the task failed', r.task?.status === 'error', r.task?.status);
ok('its failure record keeps what the model said last', (f.rawResponse || '').includes(`${UNREADABLE} (3)`), JSON.stringify(f).slice(0, 300));

// ---- 2. a phase plan that parses on the third try --------------------------------
console.log('\n=== a phase plan that parses on its third try ===');
r = await create('Waves course 2', (st, _u, nth) => st === 'categories' && nth < 3);
ok('the run completes', !!r.done && !r.error, JSON.stringify(r.error));
ok('after three phase-plan answers', r.calls.categories === 3, JSON.stringify(r.calls));
ok(`the same tree as the control (${r.titles.length} nodes)`, r.titles.length === fullTree.length);

// ---- 3. a phase without sections, a section without topics ----------------------
console.log('\n=== a phase whose sections cannot be parsed ===');
r = await create('Waves course 3', (st, user) => st === 'elements' && user.includes('Learning Phase: Optics'));
ok('the run ends in an error, not "complete"', !!r.error && !r.done, JSON.stringify(r.done));
ok('the error names the phase left without sections', /sections for "Optics"/.test(r.error?.error || ''), r.error?.error);
ok('the other phase is still built in full (1 + 2 + 4 nodes), beside the empty one',
    r.titles.length === 8 && r.titles.includes('Optics') && r.titles.filter(t => / the idea$| in practice$/.test(t)).length === 4,
    JSON.stringify(r.titles));
ok('the note names it too', /Optics/.test(r.note?.description || ''), JSON.stringify(r.note));
const sectionsGapFrames = r.frames;

console.log('\n=== a section whose topics cannot be parsed ===');
r = await create('Waves course 4', (st, user) =>
    (st === 'sub_batch' && user.includes('Learning Phase: Waves'))
    || (st === 'sub_one' && user.includes('CURRENT TOPIC to expand: Wave behaviour')));
ok('the run ends in an error, not "complete"', !!r.error && !r.done, JSON.stringify(r.done));
ok('the error names the section left without topics', /topics for "Wave behaviour"/.test(r.error?.error || ''), r.error?.error);
ok('…and not the section whose own call answered', !/Describing a wave/.test(r.error?.error || ''), r.error?.error);
// Waves: the phase, two sections, one leaf from the per-topic call; Optics in full.
ok('everything else is written (4 + 7 nodes)', r.titles.length === 11 && r.titles.includes('One leaf'), JSON.stringify(r.titles));
const topicsGapFrames = r.frames;

await new Promise(r2 => server.close(r2));
await new Promise(r2 => stub.close(r2));

// ---- 4. the creation screen, fed those runs' own frames -------------------------
// `creationRuns.ts` folds each frame into the live tree the screen draws. It is
// bundled with esbuild; the api client replays recorded frames, and the app store
// and i18n are stubs. It runs after the server has closed, because the browser
// globals it needs must not sit beside a live server.
console.log('\n=== the creation screen after a run that left a part empty ===');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const stubDir = join(scratch, 'client-stubs');
mkdirSync(stubDir);
const stubs = {
    api: 'export const api = {\n'
        + '  async *createProjectWithAI() { for (const f of globalThis.__frames) yield f; },\n'
        + '  async getCreationStatus() { return { generations: [] }; },\n'
        + '  async getNodes() { return []; },\n'
        + '  async cancelProjectWithAI() {},\n'
        + '};\n',
    store: 'export const useStore = { getState: () => ({ loadProjects() {}, addToast() {} }) };\n',
    i18n: "const t = (s, o) => s.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => (o && o[n] != null ? String(o[n]) : ''));\n"
        + "export const k = (s) => s;\nexport default { t, language: 'en' };\n",
};
for (const [name, src] of Object.entries(stubs)) writeFileSync(join(stubDir, `${name}.js`), src);
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { visibilityState: 'visible' };
const runsBundle = join(scratch, 'creationRuns.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/creation/creationRuns.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: runsBundle, logLevel: 'silent',
    plugins: [{ name: 'client-stubs', setup(build) {
        build.onResolve({ filter: /^\.\.\/\.\.\/(api|store|i18n)$/ }, (a) => ({ path: join(stubDir, `${a.path.split('/').pop()}.js`) }));
    } }],
});
const client = await import(pathToFileURL(runsBundle).href);

/** Play a run's frames through the screen's store; the run it ends on. */
async function screenRun(frames) {
    globalThis.__frames = frames;
    const key = client.startCreationRun({ name: 'Waves course', description: '', color: '#3366cc', icon: 'brain', language: 'en', documents: [] });
    for (let i = 0; i < 200 && client.isRunLive(client.useCreationRuns.getState().runs[key]); i++) await new Promise(r2 => setTimeout(r2, 5));
    return client.useCreationRuns.getState().runs[key];
}
const allNodes = (tree) => tree.flatMap(n => [n, ...allNodes(n.children)]);
const spinning = (tree) => allNodes(tree).filter(n => n.status === 'generating').map(n => n.title);
const statusOf = (tree, title) => allNodes(tree).find(n => n.title === title)?.status;

let run = await screenRun(sectionsGapFrames);
ok('a phase without sections: the screen\'s run ends failed', run?.status === 'error', run?.status);
ok('nothing on the screen still spins once the run failed', spinning(run.tree).length === 0, JSON.stringify(spinning(run.tree)));
ok('the empty phase reads as failed, the written one as written',
    statusOf(run.tree, 'Optics') === 'error' && statusOf(run.tree, 'Waves') === 'created',
    `Optics ${statusOf(run.tree, 'Optics')}, Waves ${statusOf(run.tree, 'Waves')}`);
run = await screenRun(topicsGapFrames);
ok('a section without topics: nothing spins, and that section reads as failed',
    run?.status === 'error' && spinning(run.tree).length === 0 && statusOf(run.tree, 'Wave behaviour') === 'error',
    `${run?.status}; spinning ${JSON.stringify(spinning(run.tree))}, Wave behaviour ${statusOf(run.tree, 'Wave behaviour')}`);
console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
