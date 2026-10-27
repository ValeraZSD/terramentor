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
//     nor a 4xx that blames what the request carried (its tools, its pictures),
//     which the caller answers itself;
//   - the row a model wrote names the model that ANSWERED, also when the reply
//     was stopped midway, inside an HTTP request and a background task alike;
//   - the main model's backups serve the jobs that follow it, and only those;
//   - a removed connection leaves an empty place; a job whose own list is all
//     removed connections stops instead of going to the main model;
//   - a batch tool's env override (AI_PROVIDER / AI_BASE_URL / AI_OLLAMA_URL /
//     AI_MODEL) still wins over everything, so a sweep never reaches the
//     learner's cloud keys;
//   - every model call and every stamp in server/ names its job.
//
// Two stub OpenAI-compatible endpoints on loopback stand in for two providers;
// each counts what reaches it. Scratch DB and VAULT_ROOT, set in-process.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
        req.on('end', async () => {
            s.hits.push({ url: req.url, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() });
            const step = s.plan.shift() ?? { status: 200 };
            if (step.hang) return; // never answers: the caller's timeout or cancel ends it
            if (step.wait) await step.wait; // answers when the test says so
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
            res.end(JSON.stringify({ error: { message: step.message ?? `${name} says ${step.status}` } }));
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
const { generateResponse, streamResponse, transcribeImageToText, aiProvenance, withAnswerScope } = ai;
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
    // Written out, not rebuilt with openAIBody: a change to the body builder
    // must turn this red too, not move both sides together. Taken from the
    // builder as it stood before jobs existed (the PR leaves it untouched).
    const expected = '{"reasoning":{"effort":"high"},"model":"model-a","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],'
        + '"stream":false,"temperature":0.4,"top_p":0.9}';
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
{
    reset();
    A.plan = [{ status: 503 }, { status: 503 }, { status: 503 }];
    B.plan = [{ stream: [{ content: 'first words' }, { content: ' and more' }] }];
    const stamp = await withAnswerScope(async () => {
        // The learner presses Stop after the first words: the reader leaves.
        for await (const part of streamResponse('hi', 'sys', [], { job: 'conversation' })) { void part; break; }
        return aiProvenance({ job: 'conversation' });
    });
    check('a reply stopped midway still names the model that wrote it', stamp === JSON.stringify({ provider: 'openai', model: 'model-b' }), stamp);
}
const TOOLS = [{ type: 'function', function: { name: 'search_web', description: 'look it up', parameters: { type: 'object', properties: {} } } }];
{
    reset();
    A.plan = [{ status: 400, message: 'this model does not support tools' }];
    const r = await readStream({ job: 'conversation', tools: TOOLS });
    check('a refusal of the TOOLS a stream carried is the caller\'s to answer: B is never asked', r.error?.httpStatus === 400 && B.hits.length === 0,
        `B ${B.hits.length}, ${r.error?.message}`);
    check('...and the error says which model refused', r.error?.failedOn?.connectionId === idA, String(r.error?.failedOn?.connectionId));
    check('...without carrying that model\'s settings into a log', !Object.keys(r.error || {}).includes('failedOn') && !JSON.stringify(r.error || {}).includes('model-a'));
}
{
    reset();
    A.plan = [{ status: 503 }, { status: 503 }, { status: 503 }];
    B.plan = [{ status: 400, message: 'tools are not supported for this model' }];
    const r = await readStream({ job: 'conversation', tools: TOOLS });
    check('after a fallback, the refusal is pinned on the model that refused, not the first choice',
        r.error?.failedOn?.connectionId === idB, String(r.error?.failedOn?.connectionId));
}
{
    reset();
    A.plan = [{ status: 400, message: 'image input is not supported' }];
    const r = await readStream({ job: 'conversation', images: ['aGk='] });
    check('nor a refusal of the PICTURES it carried', r.error?.httpStatus === 400 && B.hits.length === 0, `B ${B.hits.length}, ${r.error?.message}`);
    reset();
    A.plan = [{ status: 400, message: 'image input is not supported' }];
    B.plan = [{ stream: [{ content: 'ok' }] }];
    const plain = await readStream({ job: 'conversation' });
    check('...while the same words on a call with no pictures are an ordinary failure that moves on',
        !plain.error && B.hits.length === 1, `B ${B.hits.length}, ${plain.error?.message}`);
    reset();
    A.plan = [{ status: 404, message: 'model gpt-x-vision not found' }];
    B.plan = [{ stream: [{ content: 'ok' }] }];
    const named = await readStream({ job: 'conversation', images: ['aGk='] });
    check('a model that does not exist moves on even when its NAME says vision and the call carries pictures',
        !named.error && B.hits.length === 1, `B ${B.hits.length}, ${named.error?.message}`);
    reset();
    A.plan = [{ status: 400, message: 'model gpt-x-vision not found' }];
    B.plan = [{ stream: [{ content: 'ok' }] }];
    const named400 = await readStream({ job: 'conversation', images: ['aGk='] });
    check('...also when the provider says so with a 400', !named400.error && B.hits.length === 1, `B ${B.hits.length}, ${named400.error?.message}`);
    reset();
    A.plan = [{ status: 401, message: 'this key may not use tools' }];
    B.plan = [{ stream: [{ content: 'ok' }] }];
    const key = await readStream({ job: 'conversation', tools: TOOLS });
    check('a refused key moves on even when its message names the tools', !key.error && B.hits.length === 1, `B ${B.hits.length}, ${key.error?.message}`);
}
{
    const { fallsOver } = jobs;
    const said = (code) => Object.assign(new Error('x'), { code });
    check('a reasoning loop, an AbortError and undici\'s own header/body timeouts never move on',
        !fallsOver({ looped: true }) && !fallsOver(Object.assign(new Error('x'), { name: 'AbortError' }))
        && !fallsOver(said('UND_ERR_HEADERS_TIMEOUT')) && !fallsOver(said('UND_ERR_BODY_TIMEOUT')) && !fallsOver(said('UND_ERR_INVALID_ARG')));
    check('...while a dropped socket or a refused connection does',
        fallsOver(said('UND_ERR_SOCKET')) && fallsOver(said('ECONNREFUSED')) && fallsOver(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })));
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
        () => jobs.setJobRoute('questions', Array.from({ length: 6 }, (_, i) => ({ connectionId: idA, model: `x${i}` }))),
        () => jobs.setJobRoute('lessons', []),
    ]) { try { bad(); } catch (e) { if (e.status === 400) refused++; } }
    check('an unknown job (lessons is part of courses), connection or effort, or a list longer than five, is refused with 400', refused === 5, `${refused}/5`);
    let alsoRefused = 0;
    for (const bad of [
        () => jobs.setJobRoute('questions', [{ connectionId: String(idA), model: 'x' }]),
        () => jobs.setJobRoute('questions', [{ connectionId: true, model: 'x' }]),
        () => jobs.setJobRoute('questions', [{ connectionId: idA, model: 'x\nai.request forged' }]),
        () => jobs.setJobRoute('questions', [{ connectionId: idA, model: 'x' }, { connectionId: idA, model: ' x ' }]),
        () => jobs.setJobRoute('questions', [{ connectionId: idA, model: 'x\u007fy' }]),
        () => jobs.setJobRoute('questions', [{ connectionId: idA, model: 42 }]),
        // '' runs the connection's saved model (model-a): typed out, it is the same model.
        () => jobs.setJobRoute('questions', [{ connectionId: idA, model: '' }, { connectionId: idA, model: 'model-a' }]),
    ]) { try { bad(); } catch (e) { if (e.status === 400) alsoRefused++; } }
    check('...and so is an id that is not a number, a model name with a control character or that is not text, or the same model twice (also "its saved model" beside that model typed out)',
        alsoRefused === 7, `${alsoRefused}/7`);
}
{
    const idGone = conns.addConnection({ kind: 'custom', baseUrl: B.url, model: 'model-b' });
    jobs.setJobRoute('courses', [{ connectionId: idGone, model: 'model-b' }, { connectionId: idA, model: 'model-a' }]);
    jobs.setJobRoute('backups', [{ connectionId: idGone, model: 'model-b' }]);
    await conns.removeConnection(idGone);
    const left = jobs.getJobRoutes();
    check('a removed connection leaves an empty place in each list, in order',
        left.courses.length === 2 && left.courses[0].connectionId === null && left.courses[1].connectionId === idA
        && left.backups.length === 1 && left.backups[0].connectionId === null, JSON.stringify(left));
    reset();
    const r = await ask({ operation: 'structure' });
    check('...and the rest of that job\'s own list carries on', r.content === 'from A' && B.hits.length === 0, `${r.error?.message || r.content}`);

    const idLocal = conns.addConnection({ kind: 'custom', baseUrl: B.url, model: 'model-b' });
    jobs.setJobRoute('conversation', [{ connectionId: idLocal, model: 'model-b' }]);
    await conns.removeConnection(idLocal);
    reset();
    const gone = await ask({ operation: 'chat' });
    check('a job whose own list is all removed stops with a message, and goes NOWHERE else',
        gone.error?.jobRouteGone === true && A.hits.length === 0 && B.hits.length === 0, `A ${A.hits.length}, B ${B.hits.length}, ${gone.error?.message || gone.content}`);
    reset();
    const s = await readStream({ job: 'conversation' });
    check('...streamed or not', s.error?.jobRouteGone === true && A.hits.length === 0, `A ${A.hits.length}, ${s.error?.message}`);
    check('...while a check made before the call still has settings to ask about', jobs.firstChoice('conversation')?.model === 'model-a');
    reset();
    const other = await ask({ operation: 'summary' });
    check('a job on the main model skips a removed backup', other.content === 'from A', other.error?.message);
    jobs.clearJobRoutes();
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
    jobs.setJobRoute('conversation', [{ connectionId: idB2, model: 'model-b' }]);
    reset();
    A.plan = [{ stream: [{ content: 'swept' }] }];
    const s = await readStream({ job: 'conversation' });
    check('...streamed too', text(s.parts) === 'swept' && A.hits[0]?.json?.model === 'sweep-model' && B.hits.length === 0, `B ${B.hits.length}, ${s.error?.message}`);
    delete process.env.AI_PROVIDER; delete process.env.AI_BASE_URL; delete process.env.AI_MODEL;
    process.env.AI_OLLAMA_URL = 'http://127.0.0.1:9';
    check('AI_OLLAMA_URL alone is an override as well', jobs.chainFor('questions').length === 1 && jobs.chainFor('questions')[0].model === 'model-a');
    delete process.env.AI_OLLAMA_URL;
    jobs.clearJobRoutes();
}

section('two pieces of work at once keep their own record of who answered');
{
    reset();
    jobs.clearJobRoutes();
    const idB3 = conns.addConnection({ kind: 'custom', baseUrl: B.url, model: 'model-b' });
    jobs.setJobRoute('courses', [{ connectionId: idB3, model: 'model-b' }]);
    // The order is forced, not timed: ONE's answer lands, then TWO's, then ONE
    // reads its stamp — the reading that a shared record would get wrong.
    let oneDone, twoDone;
    const oneLanded = new Promise(r => { oneDone = r; });
    const twoLanded = new Promise(r => { twoDone = r; });
    const [one, two] = await Promise.all([
        withAnswerScope(async () => { await generateResponse('hi', '', [], { operation: 'authoring' }); oneDone(); await twoLanded; return aiProvenance(); }),
        withAnswerScope(async () => { await oneLanded; await generateResponse('hi', '', [], { operation: 'chat' }); twoDone(); return aiProvenance(); }),
    ]);
    check('a lesson written on B and a reply written on A, side by side, are each stamped right',
        one === JSON.stringify({ provider: 'openai', model: 'model-b' }) && two === JSON.stringify({ provider: 'openai', model: 'model-a' }), `${one} / ${two}`);
    const stamp = await withAnswerScope(async () => {
        await generateResponse('hi', '', [], { operation: 'authoring' });
        await generateResponse('hi', '', [], { operation: 'verify' });
        return { lesson: aiProvenance({ job: 'courses' }), last: aiProvenance() };
    });
    check('a lesson checked by another model is still stamped with the model that WROTE it',
        stamp.lesson === JSON.stringify({ provider: 'openai', model: 'model-b' }) && stamp.last === JSON.stringify({ provider: 'openai', model: 'model-a' }),
        JSON.stringify(stamp));
    jobs.setJobRoute('courses', [{ connectionId: idA, model: 'model-a' }, { connectionId: idB3, model: 'model-b' }]);
    reset();
    A.plan = [{ status: 404 }];
    const fanned = await withAnswerScope(async () => {
        const first = {}, second = {};
        await generateResponse('hi', '', [], { operation: 'structure', answered: first });
        await generateResponse('hi', '', [], { operation: 'structure', answered: second });
        return { first: aiProvenance({ job: 'courses', answered: first }), second: aiProvenance({ job: 'courses', answered: second }) };
    });
    check('two calls of one job in one run are each stamped from their own record, not the last one in',
        fanned.first === JSON.stringify({ provider: 'openai', model: 'model-b' }) && fanned.second === JSON.stringify({ provider: 'openai', model: 'model-a' }),
        JSON.stringify(fanned));
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
    check('GET lists the six jobs, the backups and an empty list for each', got.status === 200 && got.json?.jobs?.length === 6
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
    await call('PUT', '/api/ai/jobs/checks', { route: [{ connectionId: idA, model: 'model-a' }] });
    await call('PUT', '/api/ai/jobs/backups', { route: [{ connectionId: idA, model: 'model-a' }] });
    const all = await call('DELETE', '/api/ai/jobs');
    check('DELETE puts every job back on the main model and removes the backups, in one request',
        all.status === 200 && Object.values(all.json?.routes || { x: [1] }).every(l => l.length === 0)
        && Object.values(jobs.getJobRoutes()).every(l => l.length === 0), JSON.stringify(all.json));

    // A real route, a real body parser: the card it writes names the model
    // that answered, which only a scope opened for the request can know.
    const idB4 = conns.addConnection({ kind: 'custom', baseUrl: B.url, model: 'model-b' });
    conns.useConnection(idA);
    jobs.setJobRoute('questions', [{ connectionId: idA, model: 'model-a' }, { connectionId: idB4, model: 'model-b' }]);
    const projectId = db.prepare("INSERT INTO projects (name) VALUES ('Scope check')").run().lastInsertRowid;
    const nodeId = db.prepare("INSERT INTO nodes (project_id, title) VALUES (?, 'Scope topic')").run(projectId).lastInsertRowid;
    reset();
    A.plan = [{ status: 404 }];
    B.plan = [{ status: 200, content: '[{"front":"What is a scope?","back":"Its own record"}]' }];
    const made = await call('POST', '/api/ai/flashcards', { nodeId, count: 1 });
    const card = db.prepare('SELECT generated_by FROM flashcards WHERE node_id = ?').get(nodeId);
    check('a card written inside an HTTP request names the model that answered it', made.status === 200
        && card?.generated_by === JSON.stringify({ provider: 'openai', model: 'model-b' }), `${made.status} ${card?.generated_by} ${JSON.stringify(made.json)}`);

    const tasks = await import('../server/tasks.js');
    reset();
    A.plan = [{ status: 404 }];
    const taskStamp = await new Promise((resolve) => {
        tasks.createTask({
            kind: 'flashcards', label: 'scope check', origin: { surface: 'app', job: 'feed' },
            run: async () => {
                try {
                    await generateResponse('hi', '', [], { operation: 'questions' });
                    resolve(aiProvenance({ job: 'questions' }));
                } catch (e) { resolve(`error ${e.message}`); }
                return {};
            },
        });
    });
    check('...and so does work run as a background task', taskStamp === JSON.stringify({ provider: 'openai', model: 'model-b' }), taskStamp);
    jobs.clearJobRoutes();
    server.close();
}

section('the settings screen decides what to save and which answer lands');
{
    // The screen's decisions live in jobModels.ts so they can run here.
    const esbuild = await import('esbuild');
    const outfile = join(scratch, 'jobModels.mjs');
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL('../src/components/settings/jobModels.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
    });
    const ui = await import(pathToFileURL(outfile).href);
    const e = (connectionId, model = '', effort = '') => ({ connectionId, model, effort });
    const byId = new Map([[1, { id: 1, model: 'm1' }], [2, { id: 2, model: 'm2' }]]);
    const conns2 = [...byId.values()];

    check('the screen lists exactly the server\'s jobs', JSON.stringify(ui.JOB_IDS) === JSON.stringify(jobs.AI_JOBS), ui.JOB_IDS.join(','));
    check('a list with a removed connection, or one model twice, is not saved; a good list is',
        ui.listProblem([e(null)], byId) === 'removed' && ui.listProblem([e(1), e(1, 'm1')], byId) === 'duplicate'
        && ui.listProblem([e(1), e(1, 'other'), e(2)], byId) === '');
    check('a new place takes a connection whose saved model is not on the list yet',
        JSON.stringify(ui.freshEntry([e(1)], conns2, byId)) === JSON.stringify(e(2)));
    const only = ui.freshEntry([e(1)], [{ id: 1, model: 'm1' }], byId);
    check('...and with every saved model used, it names no model of its own: it is a copy the screen will not save until one is picked',
        only.connectionId === 1 && only.model === '' && ui.listProblem([e(1), only], byId) === 'duplicate', JSON.stringify(only));

    // A slow answer to an earlier save must not put back a list since changed.
    const first = [e(1)], second = [e(1), e(2)];
    const stale = ui.acceptSaved({ checks: second }, 'checks', first, { checks: first });
    check('a save\'s answer that arrives after the learner changed the list again leaves the new list on screen',
        JSON.stringify(stale.checks) === JSON.stringify(second));
    const fresh = ui.acceptSaved({ checks: [e(1, ' m1 ')] }, 'checks', [e(1, 'm1')], { checks: [e(1, 'm1')] });
    check('...while the answer to what is on screen replaces it with the saved form', JSON.stringify(fresh.checks) === JSON.stringify([e(1, 'm1')]));
    const merged = ui.mergeLoaded({ checks: [], small: [] }, { checks: [e(null)], small: [] }, { checks: [], small: [e(2)], backups: [] });
    check('a reload keeps a list the learner is half-way through and takes every other list from the server',
        JSON.stringify(merged.checks) === JSON.stringify([e(null)]) && JSON.stringify(merged.small) === JSON.stringify([e(2)]), JSON.stringify(merged));
}

section('every model call names its job');
{
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../server/', import.meta.url);
    const files = [...readdirSync(dir).filter(f => f.endsWith('.js')).map(f => `server/${f}`),
        ...readdirSync(new URL('routes/', dir)).filter(f => f.endsWith('.js')).map(f => `server/routes/${f}`)];
    // Comments mention these functions by name; only code counts.
    const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
    // The argument text of every call to `name`, brackets balanced.
    function* callsOf(src, name) {
        const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
        let m;
        while ((m = re.exec(src))) {
            const before = src.slice(Math.max(0, m.index - 40), m.index);
            if (/function\*?\s*$/.test(before)) continue; // the definition itself
            let depth = 1, i = re.lastIndex;
            for (; i < src.length && depth; i++) {
                if (src[i] === '(' || src[i] === '{' || src[i] === '[') depth++;
                else if (src[i] === ')' || src[i] === '}' || src[i] === ']') depth--;
            }
            yield { args: src.slice(re.lastIndex, i - 1), line: src.slice(0, m.index).split('\n').length };
        }
    }
    const names = { job: /\bjob:\s*'([a-z]+)'/, operation: /\boperation:\s*'([a-z_]+)'/ };
    const naked = { stream: [], generate: [], stamp: [], unknown: [] };
    for (const f of files) {
        const src = code(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
        // A streamed call says which job it is for: the default (conversation)
        // is right for a chat turn and wrong for a quiz, so it is never assumed.
        for (const c of callsOf(src, 'streamResponse')) {
            const job = c.args.match(names.job)?.[1];
            if (!job) naked.stream.push(`${f}:${c.line}`);
            else if (!jobs.AI_JOBS.includes(job)) naked.unknown.push(`${f}:${c.line} ${job}`);
        }
        // A non-streamed call names a job, or an operation the job map knows
        // (an unknown one would run as a small task, wherever that goes).
        for (const c of callsOf(src, 'generateResponse')) {
            const job = c.args.match(names.job)?.[1];
            const op = c.args.match(names.operation)?.[1];
            if (job) { if (!jobs.AI_JOBS.includes(job)) naked.unknown.push(`${f}:${c.line} ${job}`); continue; }
            if (/\.\.\.options\b/.test(c.args)) continue; // a helper passing its caller's options through
            if (!op || (op !== 'summary' && jobs.jobOf({ operation: op }) === 'small')) naked.generate.push(`${f}:${c.line} ${op || 'no operation'}`);
        }
        // A stamp says whose answer it records: without one it reads the
        // last answer of ANY job in the request.
        for (const name of ['aiProvenance', 'aiProvenanceFields']) {
            if (f === 'server/ai.js') continue;
            for (const c of callsOf(src, name)) {
                const job = c.args.match(names.job)?.[1];
                if (!job) naked.stamp.push(`${f}:${c.line}`);
                else if (!jobs.AI_JOBS.includes(job)) naked.unknown.push(`${f}:${c.line} ${job}`);
            }
        }
    }
    check('every streamResponse call passes a job', naked.stream.length === 0, naked.stream.join(', '));
    check('every generateResponse call names a job, or an operation that maps to one', naked.generate.length === 0, naked.generate.join(', '));
    check('every provenance stamp names its job', naked.stamp.length === 0, naked.stamp.join(', '));
    check('...and every job named is one of the six', naked.unknown.length === 0, naked.unknown.join(', '));

    // Two things the job map cannot see. The lookup decision reads the whole
    // conversation, so it goes where the conversation may go, not where small
    // tasks do. And background work started by a request (the feed sweep, the
    // picture descriptions, bulk material) opens its OWN record: a `.then` runs
    // in the scope it was chained from, and would stamp rows with the
    // answers of the request that happened to start it.
    const read = (f) => code(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
    const decisions = [...callsOf(read('server/aiTools.js'), 'generateResponse')];
    check('the lookup decision runs as the conversation', decisions.length > 0 && decisions.every(c => /\bjob:\s*'conversation'/.test(c.args)),
        decisions.map(c => `aiTools.js:${c.line}`).join(', '));
    const unscoped = ['server/feedGen.js', 'server/mediaDescribe.js', 'server/bulkGen.js'].filter(f => ![...callsOf(read(f), 'withAnswerScope')].length);
    check('the feed sweep, picture descriptions and bulk material each open their own record', unscoped.length === 0, unscoped.join(', '));
}

for (const s of [A, B]) s.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
