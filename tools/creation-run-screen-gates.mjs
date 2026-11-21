// tools/creation-run-screen-gates.mjs — what the creation run screen shows once
// a run has stopped, how it finds the runs the server is still writing, and
// which foot it draws (Start Studying once the course's first lesson exists).
//
// Run:  node tools/creation-run-screen-gates.mjs          (the working tree)
//       node tools/creation-run-screen-gates.mjs --head   (the creation store and its tree
//                                                          helpers as they were at HEAD, to
//                                                          watch the cases fail on the pre-fix code)
//
// WHY. A run stopped at topic 40 of 80 turned every unwritten row amber ("the
// topic that stopped" is the only row meant to be), and the outline opened at
// the top of the course because the screen looks for the node being written and
// the stop had already turned that node into an error. And a launch whose first
// status request failed (the server still starting) never asked again, so a run
// the server was still writing got no chip and no screen until the next page load.
//
// `creationRuns.ts` is bundled with esbuild beside its tree helpers; its api,
// store and i18n are stubs, and the api replays the frames a case sets. No server,
// no model, nothing on the network.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const HEAD = process.argv.includes('--head');
const read = (p) => HEAD
    ? execFileSync('git', ['show', `HEAD:${p}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true });
const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'creation-run-screen-'));
const srcDir = join(scratch, 'creation');
mkdirSync(srcDir);
for (const f of ['creationRuns.ts', 'liveTree.ts', 'creationLog.ts']) {
    writeFileSync(join(srcDir, f), read(`src/components/creation/${f}`));
}
writeFileSync(join(srcDir, 'entry.ts'), "export * from './creationRuns';\nexport * from './liveTree';\n");

const stubDir = join(scratch, 'stubs');
mkdirSync(stubDir);
const stubs = {
    api: 'export const api = {\n'
        + '  async *createProjectWithAI() { for (const f of globalThis.__frames) yield f; },\n'
        + '  async getCreationStatus() { return globalThis.__status(); },\n'
        + '  async getNodes() { return []; },\n'
        + '  async cancelProjectWithAI() {},\n'
        + '  async dismissTask() {},\n'
        + '};\n',
    store: 'export const useStore = { getState: () => ({ loadProjects() {}, addToast() {} }) };\n',
    i18n: "const t = (s, o) => s.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => (o && o[n] != null ? String(o[n]) : ''));\n"
        + "export const k = (s) => s;\nexport default { t, language: 'en' };\n",
};
for (const [name, src] of Object.entries(stubs)) writeFileSync(join(stubDir, `${name}.js`), src);
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { visibilityState: 'visible' };
globalThis.__status = async () => ({ generations: [] });

const bundle = join(scratch, 'bundle.mjs');
await esbuild.build({
    entryPoints: [join(srcDir, 'entry.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent',
    plugins: [{ name: 'client-stubs', setup(b) {
        b.onResolve({ filter: /^\.\.\/\.\.\/(api|store|i18n)$/ }, (a) => ({ path: join(stubDir, `${a.path.split('/').pop()}.js`) }));
    } }],
});
const client = await import(pathToFileURL(bundle).href);

const runOf = (key) => client.useCreationRuns.getState().runs[key];
const allNodes = (tree) => tree.flatMap(n => [n, ...allNodes(n.children)]);
const statusOf = (tree, title) => allNodes(tree).find(n => n.title === title)?.status;

/** Play frames through the store; the run it ends on. */
async function play(frames) {
    globalThis.__frames = frames;
    const key = client.startCreationRun({ name: 'Waves course', description: '', color: '#3366cc', icon: 'brain', language: 'en', documents: [] });
    for (let i = 0; i < 400 && client.isRunLive(runOf(key)); i++) await new Promise(r => setTimeout(r, 5));
    return runOf(key);
}

// Phase 1 (Waves) holds one topic (Waves basics) with three details, the first
// written; phase 2 (Optics) was never reached. The run stops on "Waves basics".
const written = [
    { phase: 'categories_generated', runId: 'r1', projectId: 7, categories: [{ index: 0, title: 'Waves' }, { index: 1, title: 'Optics' }] },
    { phase: 'generating_elements', categoryIndex: 0 },
    { phase: 'elements_generated', categoryIndex: 0, elements: [{ index: 0, title: 'Waves basics' }] },
    { phase: 'generating_sub_elements', categoryIndex: 0, elementIndex: 0 },
    { phase: 'sub_elements_generated', categoryIndex: 0, elementIndex: 0, subElements: [{ index: 0, title: 'Wavelength' }, { index: 1, title: 'Frequency' }, { index: 2, title: 'Amplitude' }] },
    { phase: 'resources_saved', categoryIndex: 0, elementIndex: 0, subElementIndex: 0, resourceCount: 1 },
];

section('a run that was stopped keeps the topics it never started pending');
{
    const run = await play([...written, { phase: 'cancelled', runId: 'r1' }]);
    check('the run ends cancelled', run?.status === 'cancelled', run?.status);
    check('the topic it stopped on reads as stopped', statusOf(run.tree, 'Waves basics') === 'cancelled', statusOf(run.tree, 'Waves basics'));
    check('the detail it had written stays written', statusOf(run.tree, 'Wavelength') === 'created', statusOf(run.tree, 'Wavelength'));
    check('details it never started stay pending, not stopped',
        statusOf(run.tree, 'Frequency') === 'pending' && statusOf(run.tree, 'Amplitude') === 'pending',
        `${statusOf(run.tree, 'Frequency')}, ${statusOf(run.tree, 'Amplitude')}`);
    check('a phase it never reached stays pending', statusOf(run.tree, 'Optics') === 'pending', statusOf(run.tree, 'Optics'));
    check('the screen can find the topic it stopped on', client.stoppedLeaf?.(run.tree)?.title === 'Waves basics',
        String(client.stoppedLeaf?.(run.tree)?.title));
}

section('a run that failed opens the outline on the topic it failed on');
{
    const run = await play([...written, { phase: 'error', runId: 'r1', error: 'The model stopped answering' }]);
    check('the run ends failed', run?.status === 'error', run?.status);
    check('nothing is being written any more, so the active-topic search finds nothing', client.activeLeaf(run.tree) === null);
    check('the stopped-topic search finds the topic it failed on', client.stoppedLeaf?.(run.tree)?.title === 'Waves basics',
        String(client.stoppedLeaf?.(run.tree)?.title));
    check('topics it never started stay pending', statusOf(run.tree, 'Frequency') === 'pending' && statusOf(run.tree, 'Optics') === 'pending');
    check('the outline opens on that topic once the run is over', client.openingLeaf?.(run.tree, false)?.title === 'Waves basics',
        String(client.openingLeaf?.(run.tree, false)?.title));
    check('and on nothing while the run is still live and no topic is being written', client.openingLeaf?.(run.tree, true) === null);
    const view = read('src/components/creation/CreationRunView.tsx');
    check('the run screen asks for it with the live flag', /openingLeaf\(run\.tree, live\)/.test(view));
}

section('a failed first status request is asked again');
{
    let calls = 0;
    globalThis.__status = async () => {
        calls++;
        if (calls === 1) throw new Error('connect ECONNREFUSED');
        return { generations: [{ runId: 'srv1', name: 'Waves', outcome: 'running', phase: 'thinking', startedAt: Date.now(), thinkingVersion: 0 }] };
    };
    await client.reattachCreationRuns();
    check('the first request failed and found nothing yet', calls === 1 && !Object.values(client.useCreationRuns.getState().runs).some(r => r.runId === 'srv1'));
    for (let i = 0; i < 500 && calls < 2; i++) await new Promise(r => setTimeout(r, 10));
    for (let i = 0; i < 100 && !Object.values(client.useCreationRuns.getState().runs).some(r => r.runId === 'srv1'); i++) await new Promise(r => setTimeout(r, 10));
    check('it asks again, and the run the server is writing gets its screen',
        calls === 2 && Object.values(client.useCreationRuns.getState().runs).some(r => r.runId === 'srv1'), `${calls} call(s)`);
    await client.reattachCreationRuns();
    check('once it has answered it does not ask again', calls === 2, `${calls} call(s)`);
}

section("Start Studying is offered once the course's first lesson is written");
{
    // The foot the screen draws for a run, given whether the topic the course's
    // Study opens on has a written lesson (GET /api/feed/projects/:id/first-lesson).
    // Expected feet are written out per state, not derived from the run helpers.
    const run = (status, projectId) => ({ status, projectId, inputKnown: true });
    const cases = [
        ['live, the first lesson not written yet', run('live', 7), false, 'live'],
        ['live, the first lesson written', run('live', 7), true, 'live-study'],
        ['picked up after a reload, written', run('reattached', 7), true, 'live-study'],
        ['continued, before its stream answered, written', run('starting', 7), true, 'live-study'],
        ['still planning, no course yet', run('starting', null), true, 'live'],
        ['finished, written', run('complete', 7), true, 'finished-study'],
        ['finished, not written', run('complete', 7), false, 'finished'],
        ['finished with no course to open', run('complete', null), true, 'close'],
        ['stopped with a course, written: carrying on comes first', run('cancelled', 7), true, 'continue'],
        ['stopped with a course, not written', run('cancelled', 7), false, 'continue'],
        ['failed with a course, written', run('error', 7), true, 'continue'],
        ['failed before it made a course', run('error', null), false, 'setup'],
        ['stopped before it made a course', run('cancelled', null), false, 'close'],
    ];
    for (const [label, r, written, want] of cases) {
        const got = client.runFoot?.(r, written);
        check(`${label}: ${want}`, got === want, String(got));
    }
    // When the screen asks at all: only where a foot could offer Study.
    const asks = [
        ['live with a course', run('live', 7), true],
        ['picked up after a reload', run('reattached', 7), true],
        ['finished', run('complete', 7), true],
        ['still planning, no course yet', run('starting', null), false],
        ['stopped with a course', run('cancelled', 7), false],
        ['failed with a course', run('error', 7), false],
        ['no run on screen', undefined, false],
    ];
    for (const [label, r, want] of asks) {
        const got = client.footOffersStudy?.(r);
        check(`asks whether the lesson is written: ${label}: ${want}`, got === want, String(got));
    }
    // Shape checks of the wiring (the hook itself needs a renderer this gate
    // does not have): the view feeds the answer to runFoot and asks through
    // footOffersStudy, and the label is drawn only in the two feet.
    const view = read('src/components/creation/CreationRunView.tsx');
    check('the screen picks its foot with the first-lesson answer', /runFoot\(run, firstLesson\)/.test(view));
    check('...and asks only while a foot could offer Study',
        /useFirstLessonWritten\(run\?\.projectId \?\? null, footOffersStudy\(run\)\)/.test(view));
    const drawn = (view.match(/t\("Start Studying"\)/g) || []).length;
    check('Start Studying is drawn in exactly the two feet that offer it', drawn === 2, String(drawn));
    check("...and opens the course's Study", /studyProject\(/.test(view));
}

console.log(`\ncreation run screen gates: ${pass} passed, ${fail} failed${HEAD ? ' (against HEAD)' : ''}`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
process.exit(fail ? 1 : 0);
