// tools/creation-timeout-gates.mjs — a course creation survives one model call
// that does not answer in time.
//
// Run:  node tools/creation-timeout-gates.mjs [--server <dir>]
//
// A creation is a few dozen outline (`structure`) calls in a row, and one that
// passed its 120 s allowance ended the whole run: two of four real creations
// on 8 Oct 2026 died that way, and a third lost its batched topic expansion
// to it and crawled through one call per topic for 25 minutes. Now a timed-out
// call is asked again with a longer allowance (server/creationCalls.js). This
// asserts, against the REAL routes on a scratch library and a stub model on
// loopback that never answers the calls it is told to stall (nothing billed,
// nothing leaves the machine):
//
//   1. a sections call that stalls once is asked again and the run completes,
//      with the tree it would have had;
//   2. a batched topic expansion that stalls once is asked again, and no
//      per-topic fallback call is made;
//   3. a call that stalls every time ends the run after three attempts, and
//      says so: the error frame, the task's failure record (a timeout, 3
//      attempts, the model) and three timeouts in the activity log;
//   4. a cancel during a stalled call is not asked again.
//
// `--server <dir>` runs the same cases against another copy of server/ (the
// pre-change code, e.g. `git archive HEAD server | tar -x -C temp/head`). That
// code has no allowances to shrink, so each stall there waits out the real
// 120 s: about six minutes, and it is expected to FAIL cases 1–3.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const B = argOf('--server')
    ? pathToFileURL(resolve(argOf('--server')) + '/').href
    : new URL('../server/', import.meta.url).href;

const scratch = mkdtempSync(join(tmpdir(), 'creation-timeout-gates-'));
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

function answer(st, user) {
    if (st === 'identity') return JSON.stringify({ keep_name: true, name: '', keep_description: true, description: '', reason: 'both are good' });
    if (st === 'thinking') return 'Plan: waves first, then light.';
    if (st === 'summary') return 'A course on waves and light.';
    if (st === 'categories') return JSON.stringify({ categories: [
        { title: 'Waves', description: 'What a wave is' },
        { title: 'Light', description: 'Light as a wave' },
    ] });
    if (st === 'elements') return JSON.stringify({ elements: [
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

// How many calls of each stage to leave unanswered: `{ elements: 1 }` stalls
// the first sections call and answers the rest; Infinity stalls them all.
let stallPlan = {};
let calls = {};
let stalled = {};
let onStall = () => { };

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
        if ((stalled[st] || 0) < (stallPlan[st] || 0)) {
            // Never answered: the app's own allowance is what ends it.
            stalled[st] = (stalled[st] || 0) + 1;
            onStall(st);
            return;
        }
        const content = answer(st, user);
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
const { readActivity } = await import(`${B}activityLog.js`);
// The allowances, shrunk so a stall costs seconds. Still far above what the
// stub takes to ANSWER a call, so a busy CI host cannot time out one it was
// not told to stall. The pre-change code has no such module and waits out its
// real 120 s.
const allowances = await import(`${B}creationCalls.js`).then(m => m.STRUCTURE_ALLOWANCES_MS, () => null);
const SHORT = [1500, 2000, 2500];
if (allowances) allowances.splice(0, allowances.length, ...SHORT);
else console.log('  (no creationCalls.js in that tree: every stall waits out the real allowance)');

const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function create(name, plan, { whileStalled } = {}) {
    stallPlan = plan; calls = {}; stalled = {};
    onStall = whileStalled ? (st) => { onStall = () => { }; whileStalled(st); } : () => { };
    const res = await fetch(`${base}/api/ai/create-project`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, description: 'Waves, then light as a wave.', content_language: 'en' }),
    });
    const frames = [];
    const text = await res.text();
    for (const line of text.split('\n\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
    const done = frames.find(f => f.phase === 'complete');
    const error = frames.find(f => f.phase === 'error');
    const cancelled = frames.find(f => f.phase === 'cancelled');
    const id = done?.projectId ?? frames.findLast(f => f.projectId)?.projectId;
    const nodes = id ? db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE project_id = ? AND is_note = 0').get(id).n : 0;
    const task = tasks.listTasks().findLast(t => t.kind === 'create_project');
    return { done, error, cancelled, id, nodes, task, calls: { ...calls }, stalled: { ...stalled } };
}

const aiTimeoutsSince = (fromId) => readActivity({ limit: 200, area: 'ai' })
    .filter(r => r.id > fromId && r.event === 'ai.failed' && /\btimeout\b/.test(r.detail || ''));
const lastActivityId = () => readActivity({ limit: 1 })[0]?.id ?? 0;

// ---- 0. the control: nothing stalls ---------------------------------------------
console.log('\n=== nothing stalls: the tree a creation builds ===');
let r = await create('Waves and Light', {});
ok('an unstalled creation completes', !!r.done, JSON.stringify(r.error || r));
const fullTree = r.nodes;
ok(`its tree: 2 phases × 2 sections × 2 topics = 14 nodes (got ${fullTree})`, fullTree === 14);
ok('the topics came from the batch, no per-topic call', (r.calls.sub_one || 0) === 0, JSON.stringify(r.calls));

// ---- 1. one sections call stalls --------------------------------------------------
console.log('\n=== a sections call that stalls once ===');
r = await create('Waves and Light 1', { elements: 1 });
ok('the run completes', !!r.done, r.error?.error);
ok('the stalled call was asked again (3 sections calls for 2 phases)', r.calls.elements === 3, JSON.stringify(r.calls));
ok(`the same tree as the control (${r.nodes} nodes)`, r.nodes === fullTree);

// ---- 2. the batched topic expansion stalls once ----------------------------------
console.log('\n=== a batched topic expansion that stalls once ===');
r = await create('Waves and Light 2', { sub_batch: 1 });
ok('the run completes', !!r.done, r.error?.error);
ok('the batch was asked again (3 batch calls for 2 phases)', r.calls.sub_batch === 3, JSON.stringify(r.calls));
ok('no per-topic fallback call was made', (r.calls.sub_one || 0) === 0, JSON.stringify(r.calls));
ok(`the same tree as the control (${r.nodes} nodes)`, r.nodes === fullTree);

// ---- 3. a call that never answers ------------------------------------------------
console.log('\n=== a call that stalls every time ===');
const before = lastActivityId();
r = await create('Waves and Light 3', { categories: Infinity });
ok('the run ends in an error, not a hang', !!r.error && !r.done, JSON.stringify(r.done || r.cancelled));
ok('after three attempts', r.calls.categories === 3, JSON.stringify(r.calls));
ok('the error says the model did not answer, three times', /did not answer in time, 3 times/.test(r.error?.error || ''), r.error?.error);
const f = r.task?.failure || {};
ok('the failure record names a timeout', f.name === 'TimeoutError', JSON.stringify(f).slice(0, 300));
ok('the failure record counts 3 attempts', f.attempts === 3, String(f.attempts));
ok('the failure record names the model', f.model === 'stub-model', String(f.model));
const timeouts = aiTimeoutsSince(before);
ok(`the activity log holds one timeout per attempt (${timeouts.length})`, timeouts.length === 3);
ok('the project is marked unfinished',
    !!r.id && !!db.prepare("SELECT 1 FROM nodes WHERE project_id = ? AND is_note = 1 AND title = 'AI generation failed'").get(r.id));

// ---- 4. a cancel during a stall ---------------------------------------------------
console.log('\n=== a cancel while a call is stalled ===');
// Long allowances here: the cancel must land while the first attempt waits.
if (allowances) allowances.splice(0, allowances.length, 5000, 5000, 5000);
r = await create('Waves and Light 4', { elements: Infinity }, {
    whileStalled: () => setTimeout(() => fetch(`${base}/api/ai/cancel-creation`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }), 100),
});
ok('the run is cancelled', !!r.cancelled && !r.done, JSON.stringify(r.error || r.done));
// No clock here: a cancel that did not reach the call would leave it to its
// allowance, and the retry after that is a second sections call.
ok('the stalled call was not asked again', r.calls.elements === 1, JSON.stringify(r.calls));

await new Promise(r2 => server.close(r2));
await new Promise(r2 => stub.close(r2));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
