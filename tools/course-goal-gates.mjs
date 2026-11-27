// tools/course-goal-gates.mjs — a course stays on the goal the learner typed:
// every call that writes its outline is shown that goal, in a fresh creation
// and in a continuation.
//
// Run:  node tools/course-goal-gates.mjs [--server <dir>]
//
// The outline is written level by level: the phase plan, then each phase's
// sections, then each section's topics (one batched call per phase, a call per
// section where the batch is not tried or missed one). The learner's goal is
// what keeps a narrow course narrow ("English grammar" must not grow
// vocabulary, listening and speaking phases). A level that is shown only the
// model's own ~40-word summary of the course, and not the goal, is free to
// widen it: the summary of "I want to improve my English grammar" already
// read "in both writing and speaking". This asserts, against the REAL routes
// on a scratch library and a stub model on loopback (nothing billed, nothing
// leaves the machine), that:
//
//   1. in a fresh creation, the learner's goal reaches the phase plan, every
//      phase's sections call, every batched topics call and every per-section
//      topics call, and each of those calls carries the rule that keeps the
//      level inside the goal; a section the batched call missed gets its
//      own call, which sees the goal too; the summary call is told to name
//      nothing the goal did not ask for;
//   2. a creation that stopped with a phase unwritten and is carried on with
//      POST /api/ai/continue-creation (the only path that writes AI topics
//      into a course that already exists) shows the same goal to every call
//      it makes, read back from the project, not from the stopped run;
//   3. a learner who typed no goal: the description the identity step wrote
//      is what every level sees, in the creation and in the continuation.
//
// The goal is found by its exact text, chosen so no prompt template could
// contain it by accident; the stub's summary never repeats it, so a call that
// only sees the summary fails.
//
// `--server <dir>` runs the same cases against another copy of server/ (the
// pre-change code, e.g. `git archive origin/main server src | tar -x -C temp/head`,
// then `--server temp/head/server`). On that code the goal already reached the
// phase plan and the topics calls, so those "is shown the goal" checks pass
// there too and only guard against a regression; what must FAIL there is the
// sections calls' goal (cases 1, 2, 3), every "carries the rule" check, and
// the summary's.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const B = argOf('--server')
    ? pathToFileURL(resolve(argOf('--server')) + '/').href
    : new URL('../server/', import.meta.url).href;

const scratch = mkdtempSync(join(tmpdir(), 'course-goal-gates-'));
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
    : system.includes('decide what shape a new course takes') ? 'shape'
    : system.includes('top-level categories') ? 'categories'
    : system.includes('Create sub-topics (elements)') ? 'elements'
    : system.includes('for EVERY topic') ? 'sub_batch'
    : system.includes('detailed sub-elements (leaf nodes)') ? 'sub_one'
    : 'other';
const OUTLINE = ['categories', 'elements', 'sub_batch', 'sub_one'];

// What the identity step writes when the learner typed no goal.
const WRITTEN_GOAL = 'Zq-written: the grammar of English sentences, and nothing beside it.';

// The phase "Clauses" has ONE section, so its topics come from the
// per-section call (a batch is not tried for one); "Tenses" has two and is
// batched.
function answer(st, user) {
    if (st === 'identity') {
        const typed = /Learner's description:\n"""([\s\S]*?)"""/.exec(user)?.[1] || '';
        return typed.trim() && typed.trim() !== '(empty)'
            ? JSON.stringify({ keep_name: true, name: '', keep_description: true, description: '', reason: 'both are good' })
            : JSON.stringify({ keep_name: true, name: '', keep_description: false, description: WRITTEN_GOAL, reason: 'no description' });
    }
    if (st === 'shape') return JSON.stringify({ shape: 'phased' });
    if (st === 'thinking') return 'Plan: tenses first, then clauses.';
    // A summary that widens the goal, as a real one did.
    if (st === 'summary') return 'A course on English: reading, writing, speaking and listening.';
    if (st === 'categories') return JSON.stringify({ size: 'short', categories: [
        { title: 'Tenses', description: 'Verb tenses' },
        { title: 'Clauses', description: 'Joining clauses' },
    ] });
    if (st === 'elements') return JSON.stringify({ elements: user.includes('Learning Phase: Clauses') ? [
        { title: 'Relative clauses', description: 'who, which, that' },
    ] : [
        { title: 'Present tenses', description: 'Simple and continuous' },
        { title: 'Past tenses', description: 'Simple and continuous' },
    ] });
    if (st === 'sub_batch') {
        const listed = [...user.matchAll(/^\d+\. (.+?)(?: — .*)?$/gm)].map(m => m[1]).filter(t => t !== batchMisses);
        return JSON.stringify({ topics: listed.map(title => ({
            element: title,
            subElements: [{ title: `${title}: form`, description: 'Form' }, { title: `${title}: use`, description: 'Use' }],
        })) });
    }
    if (st === 'sub_one') {
        const topic = /CURRENT TOPIC to expand: (.+)/.exec(user)?.[1]?.trim() || 'Topic';
        return JSON.stringify({ subElements: [
            { title: `${topic}: form`, description: 'Form' },
            { title: `${topic}: use`, description: 'Use' },
        ] });
    }
    return null;
}

// Calls told to answer with something unreadable: `(stage, user) => boolean`.
let unreadable = () => false;
// A section the batched topics call leaves out of its answer, or null.
let batchMisses = null;
let calls = [];

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
        calls.push({ st, system, user });
        const content = unreadable(st, user) ? 'Hello from the stub model.' : answer(st, user);
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

const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function stream(route, body) {
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const frames = [];
    for (const block of (await res.text()).split('\n\n')) if (block.startsWith('data: ')) frames.push(JSON.parse(block.slice(6)));
    return frames;
}
const titlesOf = (id) => db.prepare('SELECT title FROM nodes WHERE project_id = ? AND is_note = 0 ORDER BY id').all(id).map(n => n.title);

/** Every outline call in `list` shows `goal`, and carries the scope rule; by stage. */
function checkCalls(label, list, goal, stages) {
    for (const st of stages) {
        const of = list.filter(c => c.st === st);
        ok(`${label}: at least one ${st} call was made`, of.length > 0, JSON.stringify(list.map(c => c.st)));
        if (!of.length) continue;
        const missing = of.filter(c => !c.user.includes(goal));
        ok(`${label}: every ${st} call (${of.length}) is shown the goal`, missing.length === 0,
            missing.map(c => c.user.slice(0, 160)).join(' | '));
        const unruled = of.filter(c => !/GOAL SCOPE:/.test(c.system));
        ok(`${label}: every ${st} call carries the rule that keeps it inside the goal`, unruled.length === 0,
            unruled.map(c => c.system.slice(0, 120)).join(' | '));
    }
}

const TYPED_GOAL = 'Zq-typed: only my English grammar, tenses and clauses.';

// ---- 1. a fresh creation ----------------------------------------------------------
console.log('\n=== a fresh creation: every outline call sees the goal ===');
unreadable = () => false; calls = [];
let frames = await stream('/api/ai/create-project', { name: 'English', description: TYPED_GOAL, content_language: 'en' });
let done = frames.find(f => f.phase === 'complete');
ok('the run completes', !!done, JSON.stringify(frames.find(f => f.phase === 'error')));
const freshId = done?.projectId;
ok('its outline: 2 phases, 3 sections, 6 topics', freshId && titlesOf(freshId).length === 11, JSON.stringify(freshId && titlesOf(freshId)));
checkCalls('creation', calls, TYPED_GOAL, OUTLINE);
const summaries = calls.filter(c => c.st === 'summary');
ok('the summary call is told to name nothing the goal did not ask for',
    summaries.length > 0 && summaries.every(c => /name no skill or area they did not ask for/.test(c.system)),
    summaries.map(c => c.system.slice(0, 200)).join(' | '));

console.log('\n=== a section the batched topics call missed: its own call sees the goal ===');
batchMisses = 'Past tenses'; calls = [];
frames = await stream('/api/ai/create-project', { name: 'English 1b', description: TYPED_GOAL, content_language: 'en' });
batchMisses = null;
done = frames.find(f => f.phase === 'complete');
ok('the run completes', !!done, JSON.stringify(frames.find(f => f.phase === 'error')));
ok('the missed section is filled by its own call', done && titlesOf(done.projectId).includes('Past tenses: form'), JSON.stringify(done && titlesOf(done.projectId)));
const fallback = calls.filter(c => c.st === 'sub_one' && c.user.includes('CURRENT TOPIC to expand: Past tenses'));
ok('that call was made', fallback.length === 1, String(fallback.length));
checkCalls('missed by the batch', fallback, TYPED_GOAL, ['sub_one']);

// ---- 2. stopped with a phase unwritten, then carried on --------------------------
console.log('\n=== a stopped creation carried on: the continuation sees the goal ===');
unreadable = (st, user) => st === 'elements' && user.includes('Learning Phase: Clauses');
calls = [];
frames = await stream('/api/ai/create-project', { name: 'English 2', description: TYPED_GOAL, content_language: 'en' });
const stoppedId = frames.findLast(f => f.projectId)?.projectId;
ok('the first run stops with the second phase empty', !!frames.find(f => f.phase === 'error') && stoppedId
    && !titlesOf(stoppedId).includes('Relative clauses'), JSON.stringify(stoppedId && titlesOf(stoppedId)));
unreadable = () => false; calls = [];
frames = await stream('/api/ai/continue-creation', { projectId: stoppedId });
ok('the continuation completes', !!frames.find(f => f.phase === 'complete'), JSON.stringify(frames.find(f => f.phase === 'error')));
ok('…and writes the missing phase', titlesOf(stoppedId).includes('Relative clauses: form'), JSON.stringify(titlesOf(stoppedId)));
checkCalls('continuation', calls, TYPED_GOAL, ['elements', 'sub_one']);

// ---- 3. no goal typed: the identity step's description ---------------------------
console.log('\n=== no goal typed: the description the identity step wrote ===');
unreadable = (st, user) => st === 'elements' && user.includes('Learning Phase: Clauses');
calls = [];
frames = await stream('/api/ai/create-project', { name: 'English grammar', description: '', content_language: 'en' });
const untypedId = frames.findLast(f => f.projectId)?.projectId;
ok('the first run stops with the second phase empty', !!frames.find(f => f.phase === 'error') && untypedId
    && !titlesOf(untypedId).includes('Relative clauses'), JSON.stringify(untypedId && titlesOf(untypedId)));
checkCalls('creation, no goal typed', calls, WRITTEN_GOAL, ['categories', 'elements', 'sub_batch']);
unreadable = () => false; calls = [];
frames = await stream('/api/ai/continue-creation', { projectId: untypedId });
ok('the continuation completes', !!frames.find(f => f.phase === 'complete'), JSON.stringify(frames.find(f => f.phase === 'error')));
checkCalls('continuation, no goal typed', calls, WRITTEN_GOAL, ['elements', 'sub_one']);

await new Promise(r => server.close(r));
await new Promise(r => stub.close(r));
console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
