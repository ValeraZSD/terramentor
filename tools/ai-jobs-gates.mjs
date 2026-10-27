// tools/ai-jobs-gates.mjs — every AI job runs on its own list of models, tried in order.
//
// Run:  node tools/ai-jobs-gates.mjs
//
// What it holds (server/aiJobs.js, the job loop in ai.js):
//   - a library with no per-job choice sends exactly what it sent before, to the
//     connection in use and nowhere else;
//   - a job with its own list goes to ITS first model, on its own connection;
//   - a failure the next model could fix (busy after the retries, down, no
//     credit, a refused key, an unknown model) moves to the next model in order;
//     a cancel, a timeout and a reply already streamed never do;
//   - the row a model wrote names the model that ANSWERED;
//   - the main model's backups serve the jobs that follow it, and only those;
//   - removing a connection takes its places in every list with it;
//   - a batch tool's env override (AI_PROVIDER / AI_BASE_URL / AI_MODEL) still
//     wins over everything, so a sweep never reaches the learner's cloud keys.
//
// Two stub OpenAI-compatible endpoints on loopback stand in for two providers;
// each counts what reaches it. Scratch DB and VAULT_ROOT, set in-process.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'ai-jobs-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
for (const k of ['AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_OLLAMA_URL', 'AI_API_KEY', 'OPENAI_API_KEY', 'AI_EXTRA_BODY']) delete process.env[k];

/** A stub endpoint. `plan` holds one step per request; an empty plan answers "from <name>". */
function stub(name) {
    const s = { name, plan: [], hits: [] };
    s.server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            s.hits.push({ url: req.url, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() });
            const step = s.plan.shift() ?? { status: 200 };
            if (step.hang) return; // never answers: the caller's timeout or cancel ends it
            if (step.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                for (const part of step.stream) res.write(`data: ${JSON.stringify({ choices: [{ delta: part }] })}\n\n`);
                if (step.streamError) res.write(`data: ${JSON.stringify({ error: step.streamError })}\n\n`);
                else res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            if (step.status === 200) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: step.content ?? `from ${name}` } }] }));
                return;
            }
            // Retry-After: 0, so the three tries of a busy endpoint do not sleep.
            res.writeHead(step.status, { 'Content-Type': 'application/json', 'Retry-After': '0' });
            res.end(JSON.stringify({ error: { message: `${name} says ${step.status}` } }));
        });
    });
    return s;
}
const A = stub('A'), B = stub('B');
for (const s of [A, B]) {
    await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
    s.url = `http://127.0.0.1:${s.server.address().port}/v1`;
}
const reset = () => { for (const s of [A, B]) { s.plan = []; s.hits = []; } };

const ai = await import('../server/ai.js');
const { generateResponse, streamResponse, transcribeImageToText, aiProvenance, getAISettings, openAIBody, aiRouting, withAnswerScope } = ai;
const db = (await import('../server/database.js')).default;
const conns = await import('../server/aiConnections.js');
const jobs = await import('../server/aiJobs.js');
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_enabled', 'true')").run();

const idA = conns.addConnection({ kind: 'custom', baseUrl: A.url, model: 'model-a' });
const idB = conns.addConnection({ kind: 'custom', baseUrl: B.url, model: 'model-b' });
conns.useConnection(idA);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);
const ask = async (opts = {}) => {
    try { return { content: await generateResponse('hi', 'sys', [], opts), error: null }; }
    catch (error) { return { content: null, error }; }
};
const readStream = async (opts = {}) => {
    const parts = [];
    try {
        for await (const p of streamResponse('hi', 'sys', [], opts)) parts.push(p);
        return { parts, error: null };
    } catch (error) { return { parts, error }; }
};
const text = (parts, type = 'content') => parts.filter(p => p.type === type).map(p => p.content).join('');

section('a library with no per-job choice behaves as before');
{
    reset();
    const r = await ask({ operation: 'questions', temperature: 0.4 });
    check('the call goes to the connection in use, once', r.content === 'from A' && A.hits.length === 1 && B.hits.length === 0,
        `A ${A.hits.length}, B ${B.hits.length}, ${r.error?.message || r.content}`);
    const expected = openAIBody({ model: 'model-a', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], stream: false, temperature: 0.4, top_p: 0.9 },
        aiRouting(getAISettings(), { operation: 'questions' }));
    check('...with the body the single-model app sent, byte for byte', A.hits[0]?.body === expected, `${A.hits[0]?.body}\n          vs ${expected}`);
    check('the job list reads empty for every job', Object.values(jobs.getJobRoutes()).every(l => l.length === 0));
}

section('a job with its own list goes to its own first model');
jobs.setJobRoute('questions', [{ connectionId: idB, model: 'model-b2', effort: '' }]);
{
    reset();
    const r = await ask({ operation: 'questions' });
    check('questions are written by B, with B\'s chosen model', r.content === 'from B' && B.hits[0]?.json?.model === 'model-b2' && A.hits.length === 0,
        `A ${A.hits.length}, B ${B.hits.length}, model ${B.hits[0]?.json?.model}`);
    reset();
    const c = await ask({ operation: 'chat' });
    check('...while a job without a list stays on the connection in use', c.content === 'from A' && B.hits.length === 0);
    reset();
    const v = await ask({ operation: 'verify' });
    check('...and so does another job', v.content === 'from A' && B.hits.length === 0);
}
{
    reset();
    // `questions` asks for `high` by itself, so the entry chooses another level.
    jobs.setJobRoute('questions', [{ connectionId: idB, model: '', effort: 'minimal' }]);
    await ask({ operation: 'questions' });
    check('an entry with no model uses its connection\'s own model', B.hits[0]?.json?.model === 'model-b', B.hits[0]?.json?.model);
    check('...and the effort chosen for that entry rides on the wire', B.hits[0]?.json?.reasoning?.effort === 'minimal', JSON.stringify(B.hits[0]?.json?.reasoning));
}

section('a failure the next model could fix moves to it, in order');
jobs.setJobRoute('questions', [{ connectionId: idA, model: 'model-a', effort: '' }, { connectionId: idB, model: 'model-b', effort: '' }]);
for (const [plan, what, aHits] of [
    [[{ status: 503 }, { status: 503 }, { status: 503 }], 'busy after three tries', 3],
    [[{ status: 429 }, { status: 429 }, { status: 429 }], 'rate-limited after three tries', 3],
    [[{ status: 401 }], 'a refused key', 1],
    [[{ status: 402 }], 'no credit', 1],
    [[{ status: 404 }], 'an unknown model', 1],
]) {
    reset();
    A.plan = plan;
    const r = await withAnswerScope(async () => {
        const content = await generateResponse('hi', '', [], { operation: 'questions' });
        return { content, stamp: aiProvenance() };
    }).catch(error => ({ error }));
    check(`${what}: the first model is asked ${aHits}x, then the second answers`,
        r.content === 'from B' && A.hits.length === aHits && B.hits.length === 1, `A ${A.hits.length}, B ${B.hits.length}, ${r.error?.message || r.content}`);
    check(`${what}: the stamp names the model that answered`, r.stamp === JSON.stringify({ provider: 'openai', model: 'model-b' }), r.stamp);
}
{
    reset();
    A.plan = [{ status: 401 }];
    B.plan = [{ status: 402 }];
    const r = await ask({ operation: 'questions' });
    check('when every model fails, the LAST failure is the one reported', r.error?.httpStatus === 402, String(r.error?.httpStatus));
    check('...and it says how many models were tried', r.error?.modelsTried === 2, String(r.error?.modelsTried));
}
{
    reset();
    const by = {};
    A.plan = [{ status: 404 }];
    await generateResponse('hi', '', [], { operation: 'questions', answered: by });
    check('a caller may also ask to be told who answered', by.model === 'model-b' && by.connectionId === idB, JSON.stringify(by));
}

section('what never moves to another model');
{
    reset();
    A.plan = [{ hang: true }];
    const r = await ask({ operation: 'questions', timeout: 300 });
    check('a timeout is an answer about this call: B is never asked', r.error && B.hits.length === 0, `B ${B.hits.length}, ${r.error?.message}`);
}
{
    reset();
    A.plan = [{ hang: true }];
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 150);
    const r = await ask({ operation: 'questions', signal: ctl.signal });
    check('a cancel stops the job: B is never asked', r.error && B.hits.length === 0, `B ${B.hits.length}`);
}
jobs.setJobRoute('conversation', [{ connectionId: idA, model: 'model-a', effort: '' }, { connectionId: idB, model: 'model-b', effort: '' }]);
{
    reset();
    A.plan = [{ stream: [{ content: 'half an ans' }], streamError: { code: 502, message: 'upstream died' } }];
    const r = await readStream({ job: 'conversation' });
    check('a stream that already showed words is never sent again, anywhere', r.error && B.hits.length === 0 && text(r.parts) === 'half an ans',
        `B ${B.hits.length}, text "${text(r.parts)}"`);
}
{
    reset();
    A.plan = [{ stream: [{ reasoning_content: 'let me think' }], streamError: { code: 502, message: 'upstream died' } }];
    const r = await readStream({ job: 'conversation' });
    check('...nor one that already showed its thinking', r.error && B.hits.length === 0, `B ${B.hits.length}`);
}
{
    reset();
    A.plan = [{ status: 503 }, { status: 503 }, { status: 503 }];
    B.plan = [{ stream: [{ content: 'whole answer' }] }];
    const r = await withAnswerScope(async () => {
        const out = await readStream({ job: 'conversation' });
        return { ...out, stamp: aiProvenance() };
    });
    check('a stream refused before any word moves to the next model', !r.error && text(r.parts) === 'whole answer' && A.hits.length === 3 && B.hits.length === 1,
        `A ${A.hits.length}, B ${B.hits.length}, ${r.error?.message}`);
    check('...and the stamp names it', r.stamp === JSON.stringify({ provider: 'openai', model: 'model-b' }), r.stamp);
}

section('the main model\'s backups');
jobs.clearJobRoutes();
jobs.setJobRoute('backups', [{ connectionId: idB, model: 'model-b', effort: '' }]);
{
    reset();
    A.plan = [{ status: 404 }];
    const r = await ask({ operation: 'summary' });
    check('a job on the main model falls back to the backup list', r.content === 'from B' && A.hits.length === 1 && B.hits.length === 1,
        `A ${A.hits.length}, B ${B.hits.length}`);
    reset();
    const ok = await ask({ operation: 'summary' });
    check('...and the next request starts again at the main model', ok.content === 'from A' && B.hits.length === 0);
}
jobs.setJobRoute('vision', [{ connectionId: idA, model: 'model-a', effort: '' }]);
{
    reset();
    A.plan = [{ status: 404 }];
    let err = null;
    try { await transcribeImageToText(Buffer.from('png'), { timeout: 5000 }); } catch (e) { err = e; }
    check('a job with its own list uses ONLY that list, never the backups', err && B.hits.length === 0, `B ${B.hits.length}`);
}
{
    reset();
    jobs.setJobRoute('vision', [{ connectionId: idB, model: 'eyes', effort: '' }]);
    const out = await transcribeImageToText(Buffer.from('png'), { timeout: 5000 });
    check('reading a picture goes to the vision job\'s model', out === 'from B' && B.hits[0]?.json?.model === 'eyes' && A.hits.length === 0,
        `${out}, model ${B.hits[0]?.json?.model}`);
}

section('the lists keep themselves honest');
{
    let refused = 0;
    for (const bad of [
        () => jobs.setJobRoute('nonsense', []),
        () => jobs.setJobRoute('questions', [{ connectionId: 99999, model: 'x' }]),
        () => jobs.setJobRoute('questions', [{ connectionId: idA, model: 'x', effort: 'turbo' }]),
        () => jobs.setJobRoute('questions', Array.from({ length: 6 }, () => ({ connectionId: idA, model: 'x' }))),
    ]) { try { bad(); } catch (e) { if (e.status === 400) refused++; } }
    check('an unknown job, connection or effort, or a list longer than five, is refused with 400', refused === 4, `${refused}/4`);
}
{
    jobs.setJobRoute('lessons', [{ connectionId: idB, model: 'model-b' }, { connectionId: idA, model: 'model-a' }]);
    await conns.removeConnection(idB);
    const left = jobs.getJobRoutes();
    check('removing a connection takes its places in every list with it',
        left.lessons.length === 1 && left.lessons[0].connectionId === idA && left.backups.length === 0 && left.vision.length === 0,
        JSON.stringify(left));
}

section('a batch tool\'s env override still wins');
{
    const idB2 = conns.addConnection({ kind: 'custom', baseUrl: B.url, model: 'model-b' });
    conns.useConnection(idA);
    jobs.setJobRoute('questions', [{ connectionId: idB2, model: 'model-b' }]);
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_BASE_URL = A.url;
    process.env.AI_MODEL = 'sweep-model';
    reset();
    const r = await ask({ operation: 'questions' });
    check('with AI_* set, a job with its own list still goes to the override', r.content === 'from A' && A.hits[0]?.json?.model === 'sweep-model' && B.hits.length === 0,
        `A ${A.hits.length} (${A.hits[0]?.json?.model}), B ${B.hits.length}`);
    delete process.env.AI_PROVIDER; delete process.env.AI_BASE_URL; delete process.env.AI_MODEL;
}

section('two pieces of work at once keep their own record of who answered');
{
    reset();
    jobs.clearJobRoutes();
    const idB3 = conns.addConnection({ kind: 'custom', baseUrl: B.url, model: 'model-b' });
    jobs.setJobRoute('lessons', [{ connectionId: idB3, model: 'model-b' }]);
    const [one, two] = await Promise.all([
        withAnswerScope(async () => { await generateResponse('hi', '', [], { operation: 'authoring' }); await new Promise(r => setTimeout(r, 30)); return aiProvenance(); }),
        withAnswerScope(async () => { await new Promise(r => setTimeout(r, 10)); await generateResponse('hi', '', [], { operation: 'chat' }); return aiProvenance(); }),
    ]);
    check('a lesson written on B and a reply written on A, side by side, are each stamped right',
        one === JSON.stringify({ provider: 'openai', model: 'model-b' }) && two === JSON.stringify({ provider: 'openai', model: 'model-a' }), `${one} / ${two}`);
    const stamp = await withAnswerScope(async () => {
        await generateResponse('hi', '', [], { operation: 'authoring' });
        await generateResponse('hi', '', [], { operation: 'verify' });
        return { lesson: aiProvenance({ job: 'lessons' }), last: aiProvenance() };
    });
    check('a lesson checked by another model is still stamped with the model that WROTE it',
        stamp.lesson === JSON.stringify({ provider: 'openai', model: 'model-b' }) && stamp.last === JSON.stringify({ provider: 'openai', model: 'model-a' }),
        JSON.stringify(stamp));
    jobs.clearJobRoutes();
}

section('the settings screen reads and writes the lists through the API');
{
    const { createApp } = await import('../server/app.js');
    const server = createServer(createApp());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
        const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const got = await call('GET', '/api/ai/jobs');
    check('GET lists the seven jobs, the backups and an empty list for each', got.status === 200 && got.json?.jobs?.length === 7
        && got.json.backups === 'backups' && Object.values(got.json.routes || {}).every(l => l.length === 0), JSON.stringify(got.json));
    const put = await call('PUT', '/api/ai/jobs/checks', { route: [{ connectionId: idA, model: 'model-a', effort: 'low' }] });
    check('PUT saves a job\'s list and answers with every list', put.status === 200
        && put.json?.routes?.checks?.[0]?.connectionId === idA && put.json.routes.checks[0].effort === 'low', JSON.stringify(put.json));
    const refused = await Promise.all([
        call('PUT', '/api/ai/jobs/nonsense', { route: [] }),
        call('PUT', '/api/ai/jobs/checks', { route: 'all of them' }),
        call('PUT', '/api/ai/jobs/checks', { route: [{ connectionId: 424242 }] }),
    ]);
    check('...and refuses an unknown job, a list that is not a list, or a missing connection with 400',
        refused.every(r => r.status === 400), refused.map(r => r.status).join(','));
    const cleared = await call('PUT', '/api/ai/jobs/checks', { route: [] });
    check('an empty list gives the job back to the main model', cleared.json?.routes?.checks?.length === 0);
    server.close();
}

section('every model call names its job');
{
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../server/', import.meta.url);
    const files = [...readdirSync(dir).filter(f => f.endsWith('.js')).map(f => `server/${f}`),
        ...readdirSync(new URL('routes/', dir)).filter(f => f.endsWith('.js')).map(f => `server/routes/${f}`)];
    const naked = [];
    for (const f of files) {
        const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
        // A streamed call says which job it is for: the default (conversation)
        // is right for a chat turn and wrong for a quiz, so it is never assumed.
        const re = /streamResponse\(([^;]*?)\{([^}]*)\}\s*\)/gs;
        let m;
        while ((m = re.exec(src))) {
            if (f === 'server/ai.js' && /export async function\*/.test(src.slice(Math.max(0, m.index - 30), m.index))) continue;
            if (!/\bjob\b/.test(m[2])) naked.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
        }
    }
    check('every streamResponse call passes a job', naked.length === 0, naked.join(', '));
}

for (const s of [A, B]) s.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
