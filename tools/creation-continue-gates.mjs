// tools/creation-continue-gates.mjs — a creation that stopped half-way is
// carried on, not started over (POST /api/ai/continue-creation).
//
// Run:  node tools/creation-continue-gates.mjs
//
// Against the REAL routes on a scratch library, a stub model on loopback that
// fails the calls it is told to fail, and a stand-in for the web search
// (creationStages.setLinkSearchForTest): nothing billed, nothing leaves the
// machine. Asserts:
//
//   0. the door: a bad id, an unknown project, a card project and a project
//      already being written are refused before any stream opens;
//   1. a run that stopped before a phase's sections: the continuation writes
//      that phase's sections and topics, and only those (one sections call,
//      one batch, no phase call); every node that existed is untouched, the
//      frames carry the phase's own index, the notice note is gone;
//   2. continuing a finished project asks the model nothing and writes
//      nothing — not a node, not a link, not the project row;
//   3. a run that stopped between a phase's sections: the empty section gets
//      its topics from its own call, the untouched phase its whole level;
//   4. a run that stopped before any phase: the phases are planned once;
//   5. a continuation that fails keeps the notice and writes nothing; the next
//      one finishes;
//   6. links: a topic whose search ran and found nothing is not searched again,
//      a topic the run was cancelled on, and every one after it, is; with
//      resource hunting off, no search at all;
//   7. a course from a file: the continuation reads the file again, and a
//      phase's sections are written from the parts that phase covers;
//   8. the record of topics waiting for links: written as the run goes (a
//      crash keeps it), empty after a run that finished, kept whole by a
//      continuation that fails at the model check (whose failure carries the
//      server's 503), and never needed for a finished project, which no model
//      is asked about; a search cut off by a cancel keeps no links, so the
//      topic ends with one copy;
//   9. Stop and then Continue at once: the continuation waits for the stopped
//      run to let go instead of being refused;
//  11. the screen of a continuation that only writes topics: the phase being
//      written spins (its batch frame carries the phase's index, and the
//      client marks the phase from it), and nothing spins once it is done;
//  10. a request longer than the model's context is named in words and leads
//      with Set up AI, never Try again (`src/utils/failureCause.ts`);
//  12. the course page offers Continue (GET /api/ai/continue-creation/:id) from
//      what a stopped run wrote, with no notice and no run record (the app was
//      closed mid-run): an empty phase or section the model wrote, a topic
//      waiting for links, or the notice with anything missing; never for a
//      finished course, a learner's own empty phase or section, model-written
//      nodes under a learner's node, a card project, or while a run writes it;
//      the next start writes the notice for a run the app closed in;
//  13. pressing it with no run record makes one and carries it on through the
//      same screen; a second press while it runs opens that run.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'creation-continue-gates-'));
// In-process, before any import reaches database.js: never the real library.
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

const ELEMENTS = {
    Waves: [['Describing a wave', 'Amplitude, wavelength, frequency'], ['Wave behaviour', 'Reflection, refraction']],
    Light: [['Light as a wave', 'Wavelength and colour'], ['Optics', 'Lenses and mirrors']],
};

function answer(st, system, user) {
    if (st === 'identity') return JSON.stringify({ keep_name: true, name: '', keep_description: true, description: '', reason: 'both are good' });
    if (st === 'thinking') return 'Plan: waves first, then light.';
    if (st === 'summary') return 'A course on waves and light.';
    if (st === 'categories') {
        // With a file, each phase claims its own top-level part by § number.
        const part = (t) => Number((user.match(new RegExp(`§(\\d+) ${t}\\b`)) || [])[1]) || null;
        const sections = (t) => (system.includes('SOURCE MATERIAL') && part(t) ? { sections: [part(t)] } : {});
        return JSON.stringify({ categories: [
            { title: 'Waves', description: 'What a wave is', ...sections('Waves') },
            { title: 'Light', description: 'Light as a wave', ...sections('Light') },
        ] });
    }
    if (st === 'elements') {
        const phase = /Learning Phase: Light\b/.test(user) ? 'Light' : 'Waves';
        // With a file, the first section names the part it covers by its § number.
        const sec = system.includes('SOURCE MATERIAL') ? Number((user.match(/§(\d+)[^\n]*Light as a wave/) || [])[1]) || null : null;
        return JSON.stringify({ elements: ELEMENTS[phase].map(([title, description], i) => ({
            title, description, ...(i === 0 && sec ? { sections: [sec] } : {}),
        })) });
    }
    if (st === 'sub_batch') {
        const listed = [...user.matchAll(/^\d+\. (.+?)(?: — .*)?$/gm)].map(m => m[1]);
        return JSON.stringify({ topics: listed.map(title => ({
            element: title,
            subElements: [{ title: `${title}: the idea`, description: 'The idea' }, { title: `${title}: in practice`, description: 'Practice' }],
        })) });
    }
    if (st === 'sub_one') {
        const title = (user.match(/CURRENT TOPIC to expand: (.+)/) || [])[1]?.trim() || 'Section';
        return JSON.stringify({ subElements: [{ title: `${title}: one leaf`, description: 'One' }] });
    }
    return null;
}

// Which calls of each stage to refuse (1-based, counted per run): `{ elements: [2] }`
// fails the second sections call; `{ sub_batch: 'all' }` every batch. `'blank'`
// answers every call of that stage with valid JSON holding no items.
let failPlan = {};
let calls = {};
let bodies = [];
// What the model list answers: 503 is a server still loading its model.
let modelsStatus = 200;
// While set, every answer waits for it (a run held mid-call).
let stubHold = null;

const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
        if (stubHold) await stubHold;
        if (req.url.endsWith('/models')) {
            res.writeHead(modelsStatus, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(modelsStatus === 200 ? { data: [{ id: 'stub-model' }] } : { error: { message: 'Loading model' } }));
        }
        const body = JSON.parse(raw || '{}');
        const msgs = body.messages || [];
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
        const st = stage(system);
        calls[st] = (calls[st] || 0) + 1;
        bodies.push({ stage: st, system, user });
        const refuse = failPlan[st] === 'all' || (Array.isArray(failPlan[st]) && failPlan[st].includes(calls[st]));
        const content = refuse ? null : failPlan[st] === 'blank' ? '{}' : answer(st, system, user);
        if (content == null) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: refuse ? `stub: refused ${st} #${calls[st]}` : 'stub: not part of this gate' } }));
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
const { default: db } = await import('../server/database.js');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('creation_find_resources', 'false');
setSetting.run('embedding_enabled', 'false');
setSetting.run('pdf_math_recovery', 'off');
setSetting.run('ui_language', 'en');
const { createApp } = await import('../server/app.js');
const { setLinkSearchForTest } = await import('../server/creationStages.js');
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
if (!/^127\.0\.0\.1$/.test(server.address().address)) throw new Error('the app must listen on loopback');

async function stream(path, payload, plan = {}) {
    failPlan = plan; calls = {}; bodies = [];
    const res = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.headers.get('content-type')?.includes('event-stream')) return { status: res.status, json: await res.json(), frames: [] };
    const frames = [];
    for (const line of (await res.text()).split('\n\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
    return {
        status: res.status, frames,
        done: frames.find(f => f.phase === 'complete'),
        error: frames.find(f => f.phase === 'error'),
        cancelled: frames.find(f => f.phase === 'cancelled'),
        id: frames.findLast(f => f.projectId)?.projectId ?? null,
        calls: { ...calls }, bodies: bodies.slice(),
    };
}
const create = (name, plan) => stream('/api/ai/create-project', { name, description: 'Waves, then light as a wave.', content_language: 'en' }, plan);
const resume = (projectId, plan) => stream('/api/ai/continue-creation', { projectId }, plan);

const outline = (id) => db.prepare(`
    SELECT id, parent_id, title, description, position, generated_by FROM nodes
    WHERE project_id = ? AND is_note = 0 ORDER BY id
`).all(id);
const links = (id) => db.prepare(`
    SELECT r.id, r.node_id, r.url FROM resources r JOIN nodes n ON n.id = r.node_id WHERE n.project_id = ? ORDER BY r.id
`).all(id);
const notice = (id) => db.prepare(`SELECT id, notes FROM nodes WHERE project_id = ? AND is_note = 1 AND title = 'AI generation failed'`).get(id);
const projectRow = (id) => db.prepare('SELECT name, description, summary, ai_generating, updated_at FROM projects WHERE id = ?').get(id);
const pendingOf = (id) => db.prepare('SELECT creation_pending_links AS p FROM projects WHERE id = ?').get(id).p;
const structureCalls = (c) => ['categories', 'elements', 'sub_batch', 'sub_one'].reduce((n, k) => n + (c[k] || 0), 0);
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Every node of `before` is still there, byte for byte.
const untouched = (before, after) => before.every(row => sameRows(row, after.find(r => r.id === row.id)));
const childrenTitles = (id, parentTitle) => {
    const p = db.prepare('SELECT id FROM nodes WHERE project_id = ? AND title = ? AND is_note = 0').get(id, parentTitle);
    return p ? db.prepare('SELECT title FROM nodes WHERE parent_id = ? AND is_note = 0 ORDER BY position').all(p.id).map(r => r.title) : null;
};

// ---- 0. the door ------------------------------------------------------------------
console.log('\n=== the door ===');
let r = await resume('x');
ok('a missing id is refused (400) before a stream opens', r.status === 400 && !r.frames.length, JSON.stringify(r.json));
for (const loose of [true, '1e0', 1.5, '01x']) {
    r = await resume(loose);
    ok(`an id that is not a whole number (${JSON.stringify(loose)}) is refused (400)`, r.status === 400 && !r.frames.length, JSON.stringify(r.json));
}
r = await resume(999999);
ok('an unknown project is refused (404)', r.status === 404, JSON.stringify(r.json));
const deckId = db.prepare(`INSERT INTO projects (name, kind) VALUES ('Cards', 'deck')`).run().lastInsertRowid;
r = await resume(Number(deckId));
ok('a card project is refused (400)', r.status === 400, JSON.stringify(r.json));

// ---- 1. stopped before a phase's sections -----------------------------------------
console.log('\n=== stopped before the second phase\'s sections ===');
let a = await create('Waves and Light', { elements: [2] });
ok('the first run fails on the second sections call', !!a.error && !a.done, JSON.stringify(a.frames.at(-1)));
const A = a.id;
let before = outline(A);
ok(`it left phase 1 whole and phase 2 empty (2 phases + 2 sections + 4 topics = 8 nodes, got ${before.length})`, before.length === 8,
    JSON.stringify(before.map(n => [n.id, n.parent_id, n.title])));
ok('and the notice note', !!notice(A));
ok('and the project is no longer marked as generating', projectRow(A).ai_generating === 0);
const rowBefore = projectRow(A);

r = await resume(A);
ok('the continuation completes', !!r.done, JSON.stringify(r.error || r.frames.at(-1)));
let after = outline(A);
ok(`the tree is now whole: 2 phases × 2 sections × 2 topics = 14 nodes (got ${after.length})`, after.length === 14);
ok('every node that existed is untouched', untouched(before, after));
ok('the phases were not planned again', !r.calls.categories, JSON.stringify(r.calls));
ok('one sections call (the empty phase) and one batch', r.calls.elements === 1 && r.calls.sub_batch === 1 && !r.calls.sub_one, JSON.stringify(r.calls));
ok('phase 2 has its sections', sameRows(childrenTitles(A, 'Light'), ['Light as a wave', 'Optics']), JSON.stringify(childrenTitles(A, 'Light')));
ok('the frames name phase 2 by its index, and no phase frame is sent',
    r.frames.filter(f => f.phase === 'elements_generated').every(f => f.categoryIndex === 1)
    && r.frames.some(f => f.phase === 'elements_generated') && !r.frames.some(f => f.phase === 'categories_generated'));
const saved = r.frames.filter(f => f.phase === 'resources_saved');
ok('each new topic is reported done at its own coordinates (4, in phase 2)',
    saved.length === 4 && saved.every(f => f.categoryIndex === 1) && sameRows(saved.map(f => `${f.elementIndex}.${f.subElementIndex}`), ['0.0', '0.1', '1.0', '1.1']),
    JSON.stringify(saved.map(f => [f.categoryIndex, f.elementIndex, f.subElementIndex])));
ok('every frame carries the continuation\'s own run id', r.frames.every(f => typeof f.runId === 'string' && f.runId === r.frames[0].runId));
// The client clears the stopped attempt's dock chip by this id when it carries on.
ok('and its own dock task, not the stopped run\'s',
    r.frames.every(f => typeof f.taskId === 'string' && f.taskId === r.frames[0].taskId)
    && typeof a.frames[0]?.taskId === 'string' && a.frames[0].taskId !== r.frames[0].taskId,
    JSON.stringify([a.frames[0]?.taskId, r.frames[0]?.taskId]));
ok('the stats count what this run wrote (2 sections, 4 topics)', r.done?.stats?.elements === 2 && r.done?.stats?.subElements === 4, JSON.stringify(r.done?.stats));
ok('the notice note is gone', !notice(A));
const rowAfter = projectRow(A);
ok('the project is finished, its name, goal and summary as they were',
    rowAfter.ai_generating === 0 && rowAfter.name === rowBefore.name && rowAfter.description === rowBefore.description && rowAfter.summary === rowBefore.summary);
ok('new nodes name their model', after.filter(n => !before.some(b => b.id === n.id)).every(n => n.generated_by));

// ---- 2. continuing a finished project ---------------------------------------------
console.log('\n=== continuing a finished project ===');
before = outline(A);
const linksBefore = links(A);
const rowFinished = projectRow(A);
r = await resume(A);
ok('it completes', !!r.done, JSON.stringify(r.frames.at(-1)));
ok('no outline call was made', structureCalls(r.calls) === 0, JSON.stringify(r.calls));
ok('no node was written or changed', sameRows(before, outline(A)));
ok('no link was written', sameRows(linksBefore, links(A)));
ok('the project row was not touched', sameRows(rowFinished, projectRow(A)), JSON.stringify([rowFinished, projectRow(A)]));
ok('its stats are all zero', Object.values(r.done?.stats || { x: 1 }).every(v => v === 0), JSON.stringify(r.done?.stats));
// Also the fresh-run equivalent: a run that never failed.
const full = await create('Waves and Light, whole', {});
const fullBefore = outline(full.id);
r = await resume(full.id);
ok('a project a run finished is left exactly as it was', !!r.done && structureCalls(r.calls) === 0 && sameRows(fullBefore, outline(full.id)));
ok('a run that finished leaves no topic waiting for links', pendingOf(full.id) === null, String(pendingOf(full.id)));
// Nothing is missing, so no model is asked: a model server that is down
// neither fails it nor marks the finished project unfinished.
modelsStatus = 503;
r = await resume(full.id);
modelsStatus = 200;
ok('with the model server down, continuing a finished project still completes and adds no notice', !!r.done && !notice(full.id), JSON.stringify(r.frames.at(-1)));

// ---- 3. stopped between a phase's sections ----------------------------------------
console.log('\n=== stopped between sections ===');
a = await create('Waves and Light 3', { sub_batch: 'all', sub_one: [2] });
ok('the first run fails on the second section\'s topics', !!a.error, JSON.stringify(a.frames.at(-1)));
before = outline(a.id);
ok(`it left one section with topics, one without (5 nodes, got ${before.length})`, before.length === 5);
r = await resume(a.id);
ok('the continuation completes', !!r.done, JSON.stringify(r.error));
after = outline(a.id);
ok('the empty section got its topics from a call of its own; phase 2 from a sections call and a batch',
    r.calls.sub_one === 1 && r.calls.elements === 1 && r.calls.sub_batch === 1, JSON.stringify(r.calls));
ok('the section that had topics still has exactly those', sameRows(childrenTitles(a.id, 'Describing a wave'), ['Describing a wave: one leaf']),
    JSON.stringify(childrenTitles(a.id, 'Describing a wave')));
ok('the empty one has its own now', sameRows(childrenTitles(a.id, 'Wave behaviour'), ['Wave behaviour: one leaf']), JSON.stringify(childrenTitles(a.id, 'Wave behaviour')));
ok(`and the tree is whole (12 nodes, got ${after.length})`, after.length === 12 && untouched(before, after));
const s3 = r.frames.find(f => f.phase === 'sub_elements_generated' && f.categoryIndex === 0);
ok('the section\'s topics are reported at its own index (phase 0, section 1)', s3?.elementIndex === 1, JSON.stringify(s3 && [s3.categoryIndex, s3.elementIndex]));

// ---- 4. stopped before any phase --------------------------------------------------
console.log('\n=== stopped before the phases ===');
a = await create('Waves and Light 4', { categories: [1] });
ok('the first run fails on the phase call, after the project was made', !!a.error && !!a.id && outline(a.id).length === 0, JSON.stringify(a.frames.at(-1)));
r = await resume(a.id);
ok('the continuation plans the phases once and builds the course', !!r.done && r.calls.categories === 1 && outline(a.id).length === 14, JSON.stringify(r.calls));
ok('and sends the phase frame the screen draws its outline from', r.frames.filter(f => f.phase === 'categories_generated').length === 1);
ok('the notice note is gone', !notice(a.id));

// ---- 5. a continuation that fails -------------------------------------------------
console.log('\n=== a continuation that fails ===');
a = await create('Waves and Light 5', { elements: [2] });
before = outline(a.id);
r = await resume(a.id, { elements: 'all' });
ok('it says so on the stream, with the failure record', !!r.error && !!r.error.failure && r.error.projectId === a.id, JSON.stringify(r.frames.at(-1)));
ok('writes nothing', sameRows(before, outline(a.id)));
ok('keeps the notice, and the project is not left generating', !!notice(a.id) && projectRow(a.id).ai_generating === 0);
r = await resume(a.id);
ok('the next continuation finishes it', !!r.done && outline(a.id).length === 14 && !notice(a.id));

// The model answers, but no answer holds a section: a part left empty fails a
// continuation as it fails a fresh run (creationStages.js outlineGapsError),
// instead of "complete" over a phase with nothing in it.
a = await create('Waves and Light 5a', { elements: [2] });
before = outline(a.id);
r = await resume(a.id, { elements: 'blank' });
ok('a continuation whose answers hold no sections ends in an error, not "complete"', !!r.error && !r.done, JSON.stringify(r.frames.at(-1)));
ok('...after three answers, and the error names the phase left empty',
    r.calls.elements === 3 && /sections for "Light"/.test(r.error?.error || ''), JSON.stringify([r.calls, r.error?.error]));
ok('...writes nothing', sameRows(before, outline(a.id)));
ok('...and keeps the notice', !!notice(a.id));
r = await resume(a.id);
ok('the next continuation asks for that phase again and finishes it', !!r.done && r.calls.elements === 1 && outline(a.id).length === 14 && !notice(a.id),
    JSON.stringify([r.calls, outline(a.id).length]));

// The notice is the learner's once they write in it; a file they add later
// was never part of how the course was planned.
a = await create('Waves and Light 5b', { elements: [2] });
db.prepare('UPDATE nodes SET notes = ? WHERE id = ?').run('My own plan for this course.', notice(a.id).id);
db.prepare(`INSERT INTO documents (node_id, project_id, title, content, file_type, status) VALUES (NULL, ?, 'Later notes', ?, 'markdown', 'ready')`)
    .run(a.id, `# Heat\n\n${'Heat flows from hot to cold. '.repeat(40)}\n\n## Entropy\n\n${'Entropy grows. '.repeat(40)}`);
r = await resume(a.id, { elements: 'all' });
ok('a continuation that fails does not overwrite a notice the learner wrote in',
    !!r.error && notice(a.id)?.notes === 'My own plan for this course.', JSON.stringify(notice(a.id)));
r = await resume(a.id);
ok('a continuation finishes a course built without files', !!r.done, JSON.stringify(r.error));
ok('a file added to the project afterwards is not read as the course\'s source',
    r.bodies.length > 0 && r.bodies.every(b => !b.system.includes('SOURCE MATERIAL') && !b.user.includes('Heat flows')),
    r.bodies.map(b => b.stage).join(','));
ok('a notice the learner wrote in is kept', notice(a.id)?.notes === 'My own plan for this course.', JSON.stringify(notice(a.id)));

// ---- 6. links ---------------------------------------------------------------------
console.log('\n=== links ===');
setSetting.run('creation_find_resources', 'true');
let searched = [];
let onSearch = async () => { };
setLinkSearchForTest(async (title, signal) => {
    searched.push(title);
    await onSearch(title, signal);
    // A topic about practice finds nothing; every other topic one link.
    if (/in practice/.test(title)) return [];
    return [{ title: `About ${title}`, url: `https://example.org/${encodeURIComponent(title)}`, type: 'article' }];
});
const titleOf = (id) => db.prepare('SELECT title FROM nodes WHERE id = ?').get(id).title;

searched = [];
a = await create('Waves and Light 6', { elements: [2] });
ok('the first run searched phase 1\'s four topics, then failed', !!a.error && searched.length === 4, JSON.stringify(searched));
const emptyTopic = 'Wave behaviour: in practice';
ok(`its last topic ("${emptyTopic}") found nothing`, links(a.id).every(l => titleOf(l.node_id) !== emptyTopic));
searched = [];
r = await resume(a.id);
ok('the continuation searched only the four new topics', !!r.done && searched.length === 4 && searched.every(t => /^(Light as a wave|Optics)/.test(t)), JSON.stringify(searched));
ok(`a topic whose search found nothing was not searched again`, !searched.includes(emptyTopic));
ok('each new topic that found a link has it once', links(a.id).length === 2 + 2, JSON.stringify(links(a.id).map(l => titleOf(l.node_id))));
searched = [];
r = await resume(a.id);
ok('continuing again searches nothing', !!r.done && searched.length === 0, JSON.stringify(searched));

// Cancelled during the second topic's search: that topic and every later one
// never had a pass that finished, so the continuation gives them one.
const victim = 'Describing a wave: in practice';
let projectOfRun = null;
let midRun = null, atFirst = null;
onSearch = async (title, signal) => {
    const pid = projectOfRun ?? db.prepare('SELECT MAX(id) AS id FROM projects').get().id;
    // What a crash at these moments would leave behind: no catch writes it.
    if (title === 'Describing a wave: the idea') atFirst = JSON.parse(pendingOf(pid) || '[]').map(titleOf);
    if (title !== victim) return;
    onSearch = async () => { };
    midRun = JSON.parse(pendingOf(pid) || '[]').map(titleOf);
    await fetch(`${base}/api/ai/cancel-creation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: pid }) });
    if (!signal.aborted) await new Promise(res => signal.addEventListener('abort', res, { once: true }));
};
searched = [];
a = await create('Waves and Light 7', {});
ok('a run cancelled during a search stops there', !!a.cancelled && searched.length === 2 && searched[1] === victim, JSON.stringify(searched));
ok('it leaves the notice', !!notice(a.id));
ok('as soon as a section\'s topics were written, the record on the project named them all',
    !!atFirst?.includes('Describing a wave: the idea') && atFirst.includes(victim), JSON.stringify(atFirst));
ok('while it ran, the record on the project already named the topic being searched, and not the one done before it',
    !!midRun?.includes(victim) && !midRun.includes('Describing a wave: the idea'), JSON.stringify(midRun));
// A continuation that fails before it reads the outline (the model server is
// still loading) keeps the record whole, and says the failure is worth retrying.
const recordBefore = pendingOf(a.id);
// An old stamp, so a rewrite within the same second would still show.
db.prepare(`UPDATE projects SET updated_at = '2000-01-01 00:00:00' WHERE id = ?`).run(a.id);
modelsStatus = 503;
r = await resume(a.id);
modelsStatus = 200;
ok('the project row is not touched by it', projectRow(a.id).updated_at === '2000-01-01 00:00:00', projectRow(a.id).updated_at);
ok('a continuation stopped by the model check fails on the stream', !!r.error && !r.done, JSON.stringify(r.frames.at(-1)));
ok('its failure record carries the server\'s 503', r.error?.failure?.httpStatus === 503, JSON.stringify(r.error?.failure));
ok('and the record of waiting topics is exactly as it was', !!recordBefore && pendingOf(a.id) === recordBefore, JSON.stringify([recordBefore, pendingOf(a.id)]));
ok('the notice is still there', !!notice(a.id));
searched = [];
r = await resume(a.id);
ok('the continuation searches the cancelled topic and every one after it, never the first',
    !!r.done && searched[0] === victim && !searched.includes('Describing a wave: the idea') && searched.length === 2 + 4,
    JSON.stringify(searched));

// A cancelled continuation leaves the notice; the next one finishes.
a = await create('Waves and Light 8', { elements: [2] });
projectOfRun = a.id;
onSearch = async (title, signal) => {
    onSearch = async () => { };
    await fetch(`${base}/api/ai/cancel-creation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: projectOfRun }) });
    if (!signal.aborted) await new Promise(res => signal.addEventListener('abort', res, { once: true }));
};
searched = [];
const first = await resume(a.id);
ok('a continuation can be cancelled, and keeps the notice', !!first.cancelled && !!notice(a.id), JSON.stringify(first.frames.at(-1)));
ok('it was cancelled during the first new topic\'s search', sameRows(searched, ['Light as a wave: the idea']), JSON.stringify(searched));
const cutOff = 'Light as a wave: the idea';
const linksOf = (pid, title) => links(pid).filter(l => titleOf(l.node_id) === title).length;
ok('the link that search returned after the cancel was not kept', linksOf(a.id, cutOff) === 0, String(linksOf(a.id, cutOff)));
// While one is running, a second is refused (a plain request: `stream` would
// reset the running one's call counts).
onSearch = async () => { await new Promise(res => setTimeout(res, 300)); };
searched = [];
const running = resume(a.id);
await new Promise(res => setTimeout(res, 120));
const second = await fetch(`${base}/api/ai/continue-creation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: a.id }),
});
ok('a second continuation of a project being written is refused (409)', second.status === 409, await second.text());
const finished = await running;
// The cancelled one wrote phase 2's sections and the first one's topics; the
// batch's topics for the second were never written, so it gets its own call.
const sectionsWithout = db.prepare(`
    SELECT COUNT(*) AS n FROM nodes s JOIN nodes p ON p.id = s.parent_id
    WHERE s.project_id = ? AND s.is_note = 0 AND p.parent_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM nodes t WHERE t.parent_id = s.id AND t.is_note = 0)
`);
ok('the running one finishes it: every section has topics, nothing is pending',
    !!finished.done && !notice(a.id) && sectionsWithout.get(a.id).n === 0 && finished.calls.sub_one === 1 && finished.done.stats.subElements === 1
    && db.prepare('SELECT creation_pending_links AS p FROM projects WHERE id = ?').get(a.id).p === null,
    JSON.stringify([finished.calls, finished.done?.stats]));
ok('it searched the cut-off topic, the one after it and the new one, once each',
    sameRows(searched, ['Light as a wave: the idea', 'Light as a wave: in practice', 'Optics: one leaf']), JSON.stringify(searched));
ok('the cut-off topic ends with its link once, not twice', linksOf(a.id, cutOff) === 1, String(linksOf(a.id, cutOff)));

// ---- 9. Stop, then Continue at once -----------------------------------------------
// The stopped run takes a moment to unwind its last call; the continuation
// pressed in that moment waits for it instead of being told the course is
// still being written.
console.log('\n=== Stop, then Continue at once ===');
onSearch = async () => { };
// A continuation whose first search is held, then stopped and held stopped
// until `release()`: the run unwinds only when the test says so.
const continueRequest = (projectId, signal) => fetch(`${base}/api/ai/continue-creation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }), signal,
});
async function stopHeld(projectId) {
    let searching, release;
    const inSearch = new Promise(res => { searching = res; });
    const held = new Promise(res => { release = res; });
    onSearch = async (title, signal) => {
        onSearch = async () => { };
        searching();
        if (!signal.aborted) await new Promise(res => signal.addEventListener('abort', res, { once: true }));
        await held;
    };
    const stopped = resume(projectId);
    await inSearch;
    await fetch(`${base}/api/ai/cancel-creation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) });
    return { stopped, release };
}
const settleMs = (ms) => new Promise(res => setTimeout(res, ms));

a = await create('Waves and Light 10', { elements: [2] });
let held = await stopHeld(a.id);
const againP = continueRequest(a.id);
// The request reaches the route while the stopped run is still held.
await settleMs(250);
held.release();
const again = await againP;
const againText = await again.text();
ok('the stopped run ends as cancelled', !!(await held.stopped).cancelled);
ok('the continuation pressed right after Stop is not refused, and finishes the course',
    again.status === 200 && againText.includes('"phase":"complete"') && !notice(a.id), `${again.status} ${againText.slice(-300)}`);

// Stop pressed again while that continuation still waits: it was in no
// registry the Stop could reach, so the route must notice the client left.
a = await create('Waves and Light 11', { elements: [2] });
held = await stopHeld(a.id);
const before11 = outline(a.id);
const callsBefore = Object.values(calls).reduce((n, v) => n + v, 0);
const giveUp = new AbortController();
const waiting = continueRequest(a.id, giveUp.signal).catch(e => e);
await settleMs(250);
giveUp.abort();
await settleMs(100);
held.release();
await held.stopped;
await settleMs(400);
ok('a continuation the client gave up on while it waited never starts',
    (await waiting)?.name === 'AbortError' && sameRows(before11, outline(a.id)) && projectRow(a.id).ai_generating === 0
    && Object.values(calls).reduce((n, v) => n + v, 0) === callsBefore && !!notice(a.id),
    JSON.stringify({ nodes: [before11.length, outline(a.id).length], generating: projectRow(a.id).ai_generating }));
onSearch = async () => { };

// Resource hunting off: nothing is searched, the tree still advances.
setSetting.run('creation_find_resources', 'false');
a = await create('Waves and Light 9', { elements: [2] });
searched = [];
r = await resume(a.id);
ok('with resource hunting off no search runs', !!r.done && searched.length === 0, JSON.stringify(searched));
ok('and every new topic is still reported done', r.frames.filter(f => f.phase === 'resources_saved' && f.curated === false).length === 4);
setLinkSearchForTest(null);

// ---- 7. a course from a file ------------------------------------------------------
console.log('\n=== a course from a file ===');
const para = (s) => `${s} `.repeat(40);
const md = [
    '# Waves', para('A wave carries energy without carrying matter.'),
    '## Describing a wave', para('Amplitude, wavelength and frequency describe a wave.'),
    '## Wave behaviour', para('Waves reflect, refract and interfere.'),
    '# Light', para('Light behaves as a wave of the electromagnetic field.'),
    '## Light as a wave', para('Each colour of light has its own wavelength.'),
    '## Optics', para('Lenses and mirrors bend and reflect light.'),
].join('\n\n');
const form = new FormData();
form.append('files', new Blob([md], { type: 'text/markdown' }), 'waves.md');
const staged = await (await fetch(`${base}/api/documents/staged`, { method: 'POST', body: form })).json();
const docId = staged.documents?.[0]?.id;
ok('the file is staged', !!docId, JSON.stringify(staged).slice(0, 200));
r = await stream('/api/ai/create-project', { name: 'Waves from my notes', description: '', content_language: 'en', documentIds: [docId] }, { elements: [2] });
ok('the first run fails before phase 2\'s sections', !!r.error, JSON.stringify(r.frames.at(-1)));
const F = r.id;
r = await resume(F);
ok('the continuation completes', !!r.done, JSON.stringify(r.error));
const sectionsCall = r.bodies.find(b => b.stage === 'elements');
const block = sectionsCall?.user.slice(sectionsCall.user.indexOf('SOURCE MATERIAL FOR THIS PHASE')) || '';
ok('phase 2\'s sections were asked for with the file', sectionsCall?.system.includes('SOURCE MATERIAL') && block.length > 0, sectionsCall?.user.slice(-400));
ok('from the parts phase 2 covers, not phase 1\'s', /Light as a wave/.test(block) && !/Describing a wave/.test(block), block.slice(0, 600));
const lightSection = db.prepare(`SELECT id FROM nodes WHERE project_id = ? AND title = 'Light as a wave'`).get(F);
const srcRows = lightSection ? db.prepare('SELECT * FROM node_sources WHERE node_id = ?').all(lightSection.id) : [];
const docRow = db.prepare('SELECT id, content FROM documents WHERE project_id = ?').get(F);
ok('a new section records the part of the file it covers', srcRows.length === 1 && srcRows[0].document_id === docRow.id
    && docRow.content.slice(srcRows[0].char_from, srcRows[0].char_from + 40).includes('Light as a wave'), JSON.stringify(srcRows));

// ---- 10. what a stopped run's screen says about the failure --------------------
console.log('\n10. the failure in words, and which button leads');
const esbuild = (await import('node:module')).createRequire(import.meta.url)('esbuild');
const causeSrc = (await esbuild.build({
    entryPoints: [join(process.cwd(), 'src/utils/failureCause.ts')],
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
    // k() marks a key for extraction and returns it unchanged; the real module
    // would start i18next.
    plugins: [{ name: 'k-only', setup(b) {
        b.onResolve({ filter: /[\\/]i18n$/ }, a => ({ path: a.path, namespace: 'k' }));
        b.onLoad({ filter: /.*/, namespace: 'k' }, () => ({ contents: 'export const k = (s) => s;', loader: 'js' }));
    } }],
})).outputFiles[0].text;
const { plainCause, retryMayHelp } = await import(`data:text/javascript;base64,${Buffer.from(causeSrc).toString('base64')}`);
// The message the reviewers saw: the stub's own 400, as the chat client words it.
const tooLong = { message: 'Chat request to http://127.0.0.1:50205/v1 failed (400): {"error":{"message":"This model\'s maximum context length was exceeded."}}', httpStatus: 400 };
ok('a context-length 400 is named in words, not left raw', /context window/.test(plainCause(tooLong)?.messageKey || ''), JSON.stringify(plainCause(tooLong)));
ok('…and a 500 in other words is the same cause', /context window/.test(plainCause({ message: 'the request exceeds the available context size', httpStatus: 500 })?.messageKey || ''));
ok('…and leads with Set up AI: the same request again fails the same way', !retryMayHelp(tooLong) && !retryMayHelp({ message: 'prompt is too long', httpStatus: 500 }));
ok('a 503 while the model loads still leads with Try again', retryMayHelp({ message: 'model server is loading', httpStatus: 503 }));
ok('an unrelated 400 is left to its raw text', plainCause({ message: 'failed (400): invalid temperature', httpStatus: 400 }) === null);

// ---- 12. a course reopened long after its run stopped ---------------------------
// The app closed mid-run (a laptop lid, a quit): no catch runs, so no notice is
// written and the server keeps no record of the run. The course page asks
// GET /api/ai/continue-creation/:id whether to offer Continue, and it must
// answer from what the run left in the database alone. A course the learner
// built by hand may hold an empty phase on purpose: that is never an offer.
console.log('\n12. offering Continue on a course reopened later');
const offer = async (id) => {
    const res = await fetch(`${base}/api/ai/continue-creation/${id}`);
    return { status: res.status, json: await res.json().catch(() => null) };
};
const canOffer = async (id) => (await offer(id)).json?.canContinue;
const crashed = await create('Waves and Light 12', { elements: [2] });
ok('a run stops after phase 1, phase 2 an empty shell', !!crashed.error && childrenTitles(crashed.id, 'Light')?.length === 0, JSON.stringify(crashed.frames.at(-1)));
ok('with its notice, Continue is offered', (await canOffer(crashed.id)) === true, JSON.stringify(await offer(crashed.id)));
// What a shut-down leaves: the same outline, no notice, no pending record.
db.prepare('DELETE FROM nodes WHERE id = ?').run(notice(crashed.id).id);
db.prepare('UPDATE projects SET creation_pending_links = NULL WHERE id = ?').run(crashed.id);
// `creation_finished` is 0 for a run that never completed; a course created
// before that column has none, and is read from its outline alone.
const finishedState = (id) => db.prepare('SELECT creation_finished f FROM projects WHERE id = ?').get(id).f;
const setFinished = (id, v) => db.prepare('UPDATE projects SET creation_finished = ? WHERE id = ?').run(v, id);
ok('a run that stops records the course as unfinished', finishedState(crashed.id) === 0, String(finishedState(crashed.id)));
let o = await offer(crashed.id);
ok('closed mid-run (no notice, no run record, no pending links): Continue is still offered',
    o.status === 200 && o.json?.canContinue === true, JSON.stringify(o));
setFinished(crashed.id, null);
o = await offer(crashed.id);
ok('…and so is the same course from before the state was kept, from the empty phase the run wrote',
    o.status === 200 && o.json?.canContinue === true, JSON.stringify(o));
const sectionOnly = await create('Waves and Light 12b', { sub_batch: 'all', sub_one: [2] });
db.prepare('DELETE FROM nodes WHERE id = ?').run(notice(sectionOnly.id).id);
ok('closed between a phase\'s sections: offered', (await canOffer(sectionOnly.id)) === true);
setFinished(sectionOnly.id, null);
ok('…and from before the state was kept (an empty section the run wrote): offered', (await canOffer(sectionOnly.id)) === true);
// Every level written, one topic still waiting for its link pass.
const linksOnly = await create('Waves and Light 12c', {});
const someTopic = outline(linksOnly.id).find(n => !outline(linksOnly.id).some(c => c.parent_id === n.id));
ok('a run that completes records the course as finished', finishedState(linksOnly.id) === 1, String(finishedState(linksOnly.id)));
ok('a finished course is not offered', (await canOffer(linksOnly.id)) === false);
// The learner prunes it: an emptied phase still carries the model's name.
const stamp = JSON.stringify({ provider: 'openai', model: 'stub-model' });
const prunedPhase = Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, description, status, is_note, position, generated_by) VALUES (?, NULL, 'Emptied by the learner', '', 'not_started', 0, 50, ?)`,
).run(linksOnly.id, stamp).lastInsertRowid);
ok('a finished course the learner emptied a phase of is not offered', (await canOffer(linksOnly.id)) === false);
setFinished(linksOnly.id, 0);
ok('…while a run that never completed is offered for anything missing', (await canOffer(linksOnly.id)) === true);
db.prepare('DELETE FROM nodes WHERE id = ?').run(prunedPhase);
// The rest read a course from before the state was kept.
setFinished(linksOnly.id, null);
db.prepare('UPDATE projects SET creation_pending_links = ? WHERE id = ?').run(JSON.stringify([someTopic.id]), linksOnly.id);
ok('closed during the link pass (a topic recorded as waiting for links): offered', (await canOffer(linksOnly.id)) === true);
db.prepare('UPDATE projects SET creation_pending_links = ? WHERE id = ?').run(JSON.stringify([999999]), linksOnly.id);
ok('a waiting topic that has since been deleted is no reason to offer', (await canOffer(linksOnly.id)) === false);
db.prepare('UPDATE projects SET creation_pending_links = NULL WHERE id = ?').run(linksOnly.id);
// Hand-made: the learner's own phase and section, empty, no model's name on them.
const handId = Number((await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'My own plan' }),
})).json()).id);
const addNode = (projectId, parentId, title, by = null) => Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, description, status, is_note, position, generated_by) VALUES (?, ?, ?, '', 'not_started', 0, 0, ?)`,
).run(projectId, parentId, title, by).lastInsertRowid);
ok('an empty project the learner made is not offered', (await canOffer(handId)) === false);
const handPhase = addNode(handId, null, 'Later');
ok('a hand-made project with an empty phase is not offered', (await canOffer(handId)) === false);
addNode(handId, handPhase, 'Some day');
ok('…nor with an empty section', (await canOffer(handId)) === false);
// The Inbox shape: a capture is the learner's node; the model fans it out into
// children of its own, which have no children.
const inboxId = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Inbox-like')`).run().lastInsertRowid);
const capture = addNode(inboxId, null, 'A pasted article');
addNode(inboxId, capture, 'An idea the model drew out', JSON.stringify({ provider: 'openai', model: 'stub-model' }));
ok('model-written nodes under a node the learner made are not an unfinished creation', (await canOffer(inboxId)) === false);
// A learner's own empty phase in a course whose notice says the run failed:
// the notice is the run's own word that it stopped, so it is offered.
addNode(linksOnly.id, null, 'My extra phase');
ok('a finished course with a learner\'s empty phase is not offered', (await canOffer(linksOnly.id)) === false);
const noticeId = Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position) VALUES (?, NULL, 'AI generation failed', 'x', 'x', 'not_started', 1, 99)`,
).run(linksOnly.id).lastInsertRowid);
ok('…but with the stopped run\'s notice and something missing, it is', (await canOffer(linksOnly.id)) === true);
db.prepare('DELETE FROM nodes WHERE id = ?').run(noticeId);
// A card project shaped like a stopped run: only its kind keeps it off.
addNode(Number(deckId), null, 'An empty phase', stamp);
setFinished(Number(deckId), 0);
ok('the door: a bad id is 400, an unknown project 404, a card project is not offered',
    (await offer('x')).status === 400 && (await offer(999999)).status === 404 && (await offer(Number(deckId))).json?.canContinue === false,
    JSON.stringify([(await offer('x')).status, (await offer(999999)).status, (await offer(Number(deckId))).json]));
// While a continuation runs, the page must not offer a second one. The stub
// holds its answers, so the run is mid-call while the page asks.
let releaseStub;
stubHold = new Promise(res2 => { releaseStub = res2; });
const cont12 = resume(crashed.id, { elements: 'all' });
let mid12 = null;
for (let i = 0; i < 400 && !mid12?.running; i++) {
    mid12 = (await offer(crashed.id)).json;
    if (!mid12?.running) await new Promise(res2 => setTimeout(res2, 5));
}
stubHold = null;
releaseStub();
ok('while a continuation of it runs, it is not offered', mid12?.running === true && mid12.canContinue === false, JSON.stringify(mid12));
// The note's panel finds the note by the title the server writes on it.
const serverTitle = readFileSync('server/routes/createProject.js', 'utf8').match(/const NOTICE_TITLE = '([^']+)'/)?.[1];
const clientTitle = readFileSync('src/components/creation/ContinueCreationOffer.tsx', 'utf8').match(/CREATION_NOTICE_TITLE = '([^']+)'/)?.[1];
ok('the note\'s panel looks for the title the server gives the note', !!serverTitle && serverTitle === clientTitle, JSON.stringify([serverTitle, clientTitle]));
await cont12;
ok('a continuation that failed leaves it offered (and writes the notice)', (await canOffer(crashed.id)) === true && !!notice(crashed.id));
r = await resume(crashed.id);
ok('once a continuation finishes it, it is no longer offered', !!r.done && (await canOffer(crashed.id)) === false, JSON.stringify(r.error || r.frames.at(-1)));
// The next start of the app writes the notice for a run the last one was in
// the middle of (`ai_generating` still 1), so the course says what happened.
const startup = await create('Waves and Light 12d', { elements: [2] });
db.prepare('DELETE FROM nodes WHERE id = ?').run(notice(startup.id).id);
db.prepare('UPDATE projects SET ai_generating = 1 WHERE id = ?').run(startup.id);
const { execFileSync } = await import('node:child_process');
const child = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { pathToFileURL } = await import('node:url');
    await import(pathToFileURL(${JSON.stringify(join(process.cwd(), 'server/app.js'))}).href);
    const { default: db } = await import(pathToFileURL(${JSON.stringify(join(process.cwd(), 'server/database.js'))}).href);
    const row = db.prepare("SELECT notes FROM nodes WHERE project_id = ? AND is_note = 1 AND title = 'AI generation failed'").get(${Number(startup.id)});
    const flag = db.prepare('SELECT ai_generating FROM projects WHERE id = ?').get(${Number(startup.id)}).ai_generating;
    console.log('RESULT ' + JSON.stringify({ notes: row?.notes ?? null, flag }));
    process.exit(0);
`], { env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const restarted = JSON.parse((child.match(/^RESULT (.*)$/m) || [])[1] || '{}');
ok('a run the app was closed in the middle of gets its notice at the next start, saying so',
    restarted.flag === 0 && /closed while this course was being created/.test(restarted.notes || ''), JSON.stringify(restarted));

// ---- 11. the screen while a continuation writes only topics ---------------------
// Phase 2's sections were written and its topic batch refused, so the
// continuation's one call is that batch. No `generating_elements` frame comes
// first (the sections exist), so the batch frame itself must say which phase
// it is writing, or the screen leaves that phase on a grey dot while the
// headline says it is being written (seen in the 1 Nov walk).
console.log('\n11. the screen of a continuation that only writes topics');
const first11 = await create('Waves and Light 11', { sub_batch: [2], sub_one: 'all' });
ok('the first run fails on phase 2\'s topics, after its sections', !!first11.error && childrenTitles(first11.id, 'Light')?.length === 2
    && childrenTitles(first11.id, 'Light as a wave')?.length === 0, JSON.stringify([first11.frames.at(-1), childrenTitles(first11.id, 'Light')]));
const nodes11 = await (await fetch(`${base}/api/projects/${first11.id}/nodes`)).json();
const cont11 = await resume(first11.id);
ok('the continuation completes with one batch call', !!cont11.done && cont11.calls.sub_batch === 1 && !cont11.calls.elements, JSON.stringify(cont11.calls));
const batchAt = cont11.frames.findIndex(f => f.phase === 'generating_sub_elements');
ok('its batch frame names the phase it writes (index 1)', cont11.frames[batchAt]?.categoryIndex === 1, JSON.stringify(cont11.frames[batchAt]));

await new Promise(r2 => server.close(r2));
await new Promise(r2 => stub.close(r2));

// The client half runs after both servers closed: the browser globals it needs
// must not sit beside a live server. creationRuns.ts is bundled with esbuild;
// its api replays the two runs' own frames, and holds the continuation right
// after the batch frame so the tree can be read mid-run.
const stubDir = join(scratch, 'client-stubs');
mkdirSync(stubDir);
const clientStubs = {
    api: 'export const api = {\n'
        + '  async *createProjectWithAI() { for (const f of globalThis.__frames) yield f; },\n'
        + '  async *continueCreation() { const fr = globalThis.__frames2; for (let i = 0; i < fr.length; i++) { yield fr[i]; if (i === globalThis.__holdAt) await globalThis.__hold; } },\n'
        + '  async getNodes() { return globalThis.__nodes; },\n'
        + '  async getCreationStatus() { return { generations: [] }; },\n'
        + '  async cancelProjectWithAI() {},\n'
        + '  async dismissTask() {},\n'
        + '};\n',
    store: 'export const useStore = { getState: () => ({ loadProjects() {}, addToast() {} }) };\n',
    i18n: "const t = (s, o) => s.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => (o && o[n] != null ? String(o[n]) : ''));\n"
        + "export const k = (s) => s;\nexport default { t, language: 'en' };\n",
};
for (const [name, src] of Object.entries(clientStubs)) writeFileSync(join(stubDir, `${name}.js`), src);
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { visibilityState: 'visible' };
const runsBundle = join(scratch, 'creationRuns.mjs');
await esbuild.build({
    entryPoints: [join(process.cwd(), 'src/components/creation/creationRuns.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: runsBundle, logLevel: 'silent',
    plugins: [{ name: 'client-stubs', setup(b) {
        b.onResolve({ filter: /^\.\.\/\.\.\/(api|store|i18n)$/ }, (x) => ({ path: join(stubDir, `${x.path.split('/').pop()}.js`) }));
    } }],
});
const client = await import(pathToFileURL(runsBundle).href);
const runOf = (key) => client.useCreationRuns.getState().runs[key];
const waitFor = async (cond) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise(r2 => setTimeout(r2, 5)); return cond(); };
const allNodes = (tree) => tree.flatMap(n => [n, ...allNodes(n.children)]);
const spinning = (tree) => allNodes(tree).filter(n => n.status === 'generating').map(n => n.title);
const statusOf = (tree, title) => allNodes(tree).find(n => n.title === title)?.status;

globalThis.__frames = first11.frames;
const key11 = client.startCreationRun({ name: 'Waves and Light 11', description: '', color: '#3366cc', icon: 'brain', language: 'en', documents: [] });
await waitFor(() => !client.isRunLive(runOf(key11)));
ok('on the screen, the first run ends failed with its project', runOf(key11)?.status === 'error' && runOf(key11)?.projectId === first11.id, JSON.stringify([runOf(key11)?.status, runOf(key11)?.projectId]));
let release;
globalThis.__hold = new Promise(r2 => { release = r2; });
globalThis.__holdAt = batchAt;
globalThis.__frames2 = cont11.frames;
globalThis.__nodes = nodes11;
await client.continueCreationRun(key11);
await waitFor(() => runOf(key11)?.phase === 'generating_sub_elements');
const mid = runOf(key11);
ok('while the batch is written, the phase it writes spins', statusOf(mid.tree, 'Light') === 'generating',
    `Light ${statusOf(mid.tree, 'Light')}; spinning ${JSON.stringify(spinning(mid.tree))}`);
ok('…and the finished phase does not', statusOf(mid.tree, 'Waves') === 'created', `Waves ${statusOf(mid.tree, 'Waves')}`);
release();
await waitFor(() => !client.isRunLive(runOf(key11)));
ok('once it completes, nothing spins', runOf(key11)?.status === 'complete' && spinning(runOf(key11).tree).length === 0,
    `${runOf(key11)?.status}; spinning ${JSON.stringify(spinning(runOf(key11)?.tree || []))}`);

// ---- 13. Continue pressed on the course page -------------------------------------
// The page that watched the run is gone, so there is no record to continue:
// the press makes one for the project and carries it on through the same
// screen and stream consumer; a second press while it runs opens that run.
console.log('\n13. Continue from the course page, with no run record');
const recordsOf = (projectId) => Object.values(client.useCreationRuns.getState().runs).filter(x => x.projectId === projectId);
const beforeKeys = new Set(recordsOf(first11.id).map(x => x.key));
globalThis.__hold = new Promise(r2 => { release = r2; });
client.continueCreationForProject(first11.id, 'Waves and Light 11', '#3366cc');
const seeded = recordsOf(first11.id).find(x => !beforeKeys.has(x.key));
ok('a record is made for the project, and its screen is the one open',
    !!seeded && client.useCreationRuns.getState().viewing === seeded.key && seeded.name === 'Waves and Light 11',
    JSON.stringify([seeded?.key, client.useCreationRuns.getState().viewing]));
await waitFor(() => runOf(seeded.key)?.phase === 'generating_sub_elements');
ok('it is carried on: live, as a continuation', client.isRunLive(runOf(seeded.key)) && runOf(seeded.key).attempt === 1,
    JSON.stringify([runOf(seeded.key)?.status, runOf(seeded.key)?.attempt]));
client.useCreationRuns.setState({ viewing: null });
client.continueCreationForProject(first11.id, 'Waves and Light 11', '#3366cc');
ok('a second press while it runs opens that run and makes no other',
    recordsOf(first11.id).filter(x => !beforeKeys.has(x.key)).length === 1 && client.useCreationRuns.getState().viewing === seeded.key);
release();
await waitFor(() => !client.isRunLive(runOf(seeded.key)));
ok('and it completes on the replayed frames', runOf(seeded.key)?.status === 'complete', runOf(seeded.key)?.status);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
