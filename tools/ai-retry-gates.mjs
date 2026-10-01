// tools/ai-retry-gates.mjs — transient upstream failures are retried, permanent ones are not.
//
// Run:  node tools/ai-retry-gates.mjs
//
// Why this exists: a retry that silently does not retry is indistinguishable
// from no retry at all. Nothing throws, nothing logs a difference, and the only
// symptom is the one it was written to remove — a learner's question thrown
// away by one 429 from a free tier. The inverse is worse and just as quiet:
// retrying a 401 sends a bad key three times and takes three times as long to
// tell anyone the key is bad.
//
// So this drives the REAL `generateResponse` against a stub endpoint that can be
// told what to answer, and counts the requests that actually arrive. Loopback
// only: no model, no internet, and a scratch DB + scratch VAULT_ROOT set
// IN-PROCESS before `ai.js` is imported — a shell `DB_PATH=` prefix has silently
// failed to apply here before, and `database.js` migrates and sweeps at import.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'ai-retry-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

// A stub OpenAI-compatible endpoint. `plan` is consumed one entry per request.
let plan = [];
let hits = [];
/** How many stream chunks each streamed reply managed to send before it ended or was cut. */
let streamed = [];
const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        hits.push({ url: req.url, at: Date.now(), body });
        const step = plan.shift() ?? { status: 200 };
        if (step.retryAfter !== undefined) res.setHeader('Retry-After', String(step.retryAfter));
        if (step.stream) {
            // A streamed reply: `reasoning` lines as the reasoning channel,
            // then `content`, then [DONE]. Written a chunk at a time so the
            // reader can cut it short — a loop guard that only fires after
            // the whole body has arrived has not stopped anything.
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const lines = step.stream.map(part => `data: ${JSON.stringify({ choices: [{ delta: part }] })}\n\n`);
            let i = 0;
            let sent = 0;
            const tick = () => {
                if (res.destroyed || res.writableEnded) { streamed.push(sent); return; }
                if (i >= lines.length) { res.write('data: [DONE]\n\n'); res.end(); streamed.push(sent); return; }
                res.write(lines[i++]); sent++;
                setImmediate(tick);
            };
            tick();
            return;
        }
        if (step.empty) {
            // 200 OK with no answer in it — what a reasoning-first model returns
            // when it spends the whole reply thinking. `empty` carries the
            // reply's own account of itself (finish_reason, usage), which is
            // the only thing that tells a person what happened.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ message: { content: step.empty.content ?? '' }, finish_reason: step.empty.finishReason ?? 'stop' }],
                ...(step.empty.reasoningTokens
                    ? { usage: { completion_tokens_details: { reasoning_tokens: step.empty.reasoningTokens } } }
                    : {}),
            }));
        } else if (step.status === 200) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        } else {
            res.writeHead(step.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `stub says ${step.status}` } }));
        }
    });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// The env overrides `getAISettings` honours, so the real code path is exercised
// without touching any settings row.
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.AI_MODEL = 'stub-model';

const { generateResponse, streamResponse, reasoningLoopDetected, isReasoningLoop, LOOP_WINDOW_UNITS, aiExtraBody,
    readReplyShape, emptyReplyReason } = await import('../server/ai.js');
const db = (await import('../server/database.js')).default;
db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_enabled', 'true');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

async function run(steps) {
    plan = [...steps];
    hits = [];
    const started = Date.now();
    try {
        const content = await generateResponse('hi', '', [], { operation: 'chat' });
        return { content, requests: hits.length, ms: Date.now() - started, error: null };
    } catch (e) {
        return { content: null, requests: hits.length, ms: Date.now() - started, error: e };
    }
}

section('transient failures are retried');
{
    const r = await run([{ status: 429 }, { status: 200 }]);
    check('a 429 followed by success answers, and sends 2 requests',
        r.content === 'ok' && r.requests === 2, `${r.requests} requests, err=${r.error?.message}`);
}
{
    const r = await run([{ status: 503 }, { status: 502 }, { status: 200 }]);
    check('two 5xx then success answers, and sends 3 requests',
        r.content === 'ok' && r.requests === 3, `${r.requests} requests`);
}
{
    const r = await run([{ status: 429 }, { status: 429 }, { status: 429 }]);
    check('a quota that stays spent gives up after exactly 3 attempts',
        r.error && r.requests === 3, `${r.requests} requests`);
    check('...and the error still carries the status', r.error?.httpStatus === 429, String(r.error?.httpStatus));
    check('...and records how many attempts it took', r.error?.attempts === 3, String(r.error?.attempts));
}

section('permanent failures are answers, not hiccups');
// Repeating the question does not change a bad key, an unpaid bill or a model
// that does not exist — and doing so delays the only useful message threefold.
for (const [status, what] of [[401, 'a rejected key'], [402, 'a billing refusal'], [404, 'an unknown model'], [400, 'a malformed request']]) {
    const r = await run([{ status }, { status: 200 }]);
    check(`${what} (${status}) is not retried`, r.error !== null && r.requests === 1,
        `${r.requests} requests, error=${r.error ? 'yes' : 'no'}`);
}

/* ── a reply with no answer in it ───────────────────────────────────────────
 *
 * 200 OK, a well-formed body, an empty `content`. Until 2026-09-16 every one of
 * these became `Model "X" returned an empty response.` — true, and useless: it
 * describes the hole rather than what happened, so the reader goes looking at
 * the endpoint, the key and the app. Measured on OpenRouter/glm-5.3-flash the
 * cause was the model spending its whole allowance reasoning, which the reply
 * itself reports in `finish_reason` and `usage`.
 *
 * The control this gate is written against is the OLD message: an assertion
 * that merely required an error would have passed on the code that shipped the
 * silence, so each case also demands the fact that explains it.
 */
section('a reply with no answer in it says why');
{
    const r = await run([{ empty: { reasoningTokens: 1200, finishReason: 'length' } }]);
    check('a model that thought instead of answering is an error, not an empty lesson', r.error !== null, r.content);
    check('…that is not the old six words', !/returned an empty response/.test(r.error?.message || ''), r.error?.message);
    check('…and names what it spent', /1,200 tokens of reasoning/.test(r.error?.message || ''), r.error?.message);
    check('…and points at the setting that fixes it', /think less/.test(r.error?.message || ''), r.error?.message);
    check('…flagged for the failure record', r.error?.emptyReply === true && r.error?.reasoningTokens === 1200,
        `${r.error?.emptyReply} / ${r.error?.reasoningTokens}`);
    // Asking a second time buys the same silence at twice the price.
    check('…and is asked exactly once', r.requests === 1, `${r.requests} requests`);
}
{
    const r = await run([{ empty: { finishReason: 'length' } }]);
    check('an output limit reached with nothing to show for it says so',
        /output limit/.test(r.error?.message || ''), r.error?.message);
}
{
    const r = await run([{ empty: { finishReason: '' } }]);
    check('an endpoint that explains nothing is not given an invented explanation',
        /reported no reason/.test(r.error?.message || '') && !/reasoning/.test(r.error?.message || ''), r.error?.message);
}
{
    // The same failure arriving a chunk at a time: thinking, then the end of the
    // stream. Before this the turn simply stopped — a blank answer, no error,
    // nothing to retry.
    plan = [{ stream: [{ reasoning_content: 'still thinking. ' }, { reasoning_content: 'and thinking. ' }] }];
    hits = []; streamed = [];
    let err = null, got = '';
    try {
        for await (const part of streamResponse('hi', '', [], {})) { if (part.type === 'content') got += part.content; }
    } catch (e) { err = e; }
    check('a stream that only ever thinks ends in an error, not a blank answer',
        err !== null && got === '', `${err?.message} / "${got}"`);
    check('…counting the reasoning it did send', /characters of reasoning/.test(err?.message || ''), err?.message);
}
{
    // Pure halves, against the shapes real endpoints send.
    check('OpenRouter\'s usage block is read', readReplyShape({
        choices: [{ finish_reason: 'length' }],
        usage: { completion_tokens_details: { reasoning_tokens: 42 } },
    }).reasoningTokens === 42);
    check('llama.cpp, which sends no completion_tokens_details, is read without throwing',
        readReplyShape({ choices: [{ finish_reason: 'stop' }], usage: { completion_tokens: 9 } }).reasoningTokens === 0);
    check('a body with nothing in it at all is read without throwing',
        readReplyShape({}).finishReason === '' && readReplyShape(undefined).reasoningTokens === 0);
    check('a content filter is named as itself, not as thinking',
        /content filter/.test(emptyReplyReason({ finishReason: 'content_filter' })));
    check('a local engine is not sent to a settings control it does not draw',
        !/Settings/.test(emptyReplyReason({ thinkingChars: 50, provider: 'ollama' })),
        emptyReplyReason({ thinkingChars: 50, provider: 'ollama' }));
}

section('Retry-After is honoured, and capped');
{
    const r = await run([{ status: 429, retryAfter: 1 }, { status: 200 }]);
    check('a 1-second Retry-After is waited out', r.content === 'ok' && r.ms >= 950, `${r.ms}ms`);
}
{
    // A free tier answering "3600" is telling us to give up, not to hold the
    // request open for an hour. The cap is what keeps this from becoming a hang.
    const r = await run([{ status: 429, retryAfter: 3600 }, { status: 200 }]);
    check('an hour-long Retry-After is capped, not obeyed', r.content === 'ok' && r.ms < 20000, `${r.ms}ms`);
}

section('a model looping in its reasoning is stopped, not waited for');
{
    // The real thing, verbatim from the assistant on 2026-09-07: two lines in
    // strict alternation for 29,824 characters.
    const loop = Array.from({ length: 300 }, (_, i) => (i % 2
        ? 'One detail: "write 100 words" might be interpreted as "write 100 words of explanation". I\'ll provide the paragraph.\n'
        : 'I will output the response.\n')).join('');
    check('the alternating pair is a loop', reasoningLoopDetected(loop) === true);
    const prose = Array.from({ length: 120 }, (_, i) => `Step ${i}: the ${['force', 'mass', 'field', 'charge'][i % 4]} on element ${i} is ${(i * 7) % 13} units, so the next term differs by ${i}. `).join('');
    check('a long derivation that varies is not', reasoningLoopDetected(prose) === false);
    check('too little text is never a loop', reasoningLoopDetected('I will output the response.\n'.repeat(20)) === false);
    check('a window of the same line is a loop', reasoningLoopDetected('x'.repeat(1300) + 'I will output the response.\n'.repeat(LOOP_WINDOW_UNITS)) === true);
    check('an answer repeating a word on request is not watched', reasoningLoopDetected('word '.repeat(100)) === false);

    // Streamed: the guard must CUT the request, so the server sees the socket
    // close well before it has sent everything.
    const chunks = Array.from({ length: 900 }, (_, i) => ({ reasoning_content: i % 2 ? 'One detail: the count might be words or letters. ' : 'I will verify the count.\n' }));
    chunks.push({ content: 'never reached' });
    plan = [{ stream: chunks }]; hits = []; streamed = [];
    let err = null, yielded = 0;
    try {
        for await (const part of streamResponse('hi', '', [], { think: true })) { if (part.type === 'thinking') yielded++; }
    } catch (e) { err = e; }
    await new Promise(r => setTimeout(r, 150));
    check('the loop is thrown as a tagged error', err !== null && isReasoningLoop(err), err?.message);
    check('…which names the cause in words', /repeating itself/.test(err?.message || ''), err?.message);
    check('…and the stream was cut, not drained', yielded < chunks.length && (streamed[0] ?? chunks.length) < chunks.length, `${yielded} yielded, ${streamed[0]} sent of ${chunks.length}`);

    const fine = Array.from({ length: 200 }, (_, i) => ({ reasoning_content: `Point ${i}: consider term ${i} and its neighbour ${i + 1}. ` }));
    fine.push({ content: 'the answer' });
    plan = [{ stream: fine }]; hits = [];
    let content = '', thrown = null;
    try {
        for await (const part of streamResponse('hi', '', [], { think: true })) { if (part.type === 'content') content += part.content; }
    } catch (e) { thrown = e; }
    check('a reply that reasons at length without looping is left alone', thrown === null && content === 'the answer', thrown?.message);
}

/* ── the endpoint's own request fields ──────────────────────────────────────
 *
 * `AI_EXTRA_BODY` exists so a deployment can say something the /v1 protocol has
 * no word for — the case it was built for is OpenRouter's
 * `{"provider":{"zdr":true,"data_collection":"deny"}}`, which is the only way
 * to keep a request on Zero-Data-Retention endpoints and is per-request, not an
 * account setting. A privacy flag that silently stops being sent is the worst
 * kind of bug here: nothing fails, the answers keep arriving, and the only
 * thing that changed is a promise made to whoever's notes are in the prompt.
 * So this asserts it on the WIRE, from the stub's own record of what arrived,
 * and then scans the source so a fifth call site cannot quietly skip it.
 */
section('extra request fields reach the endpoint');
{
    delete process.env.AI_EXTRA_BODY;
    await run([{ status: 200 }]);
    const sent = JSON.parse(hits[0].body);
    check('unset by default — nothing is added to the body',
        Object.keys(sent).sort().join(',') === 'messages,model,stream,temperature,top_p', Object.keys(sent).join(','));

    process.env.AI_EXTRA_BODY = '{"provider":{"zdr":true,"data_collection":"deny","order":["baseten","fireworks"]}}';
    await run([{ status: 200 }]);
    const withExtra = JSON.parse(hits[0].body);
    check('a provider block arrives verbatim',
        withExtra.provider?.zdr === true
        && withExtra.provider?.data_collection === 'deny'
        && JSON.stringify(withExtra.provider?.order) === '["baseten","fireworks"]', hits[0].body);
    check('…and the app\'s own fields are still there',
        withExtra.model === 'stub-model' && Array.isArray(withExtra.messages) && withExtra.stream === false);

    // The whole point of merging the extra object FIRST. A deployment file is
    // edited by hand, on a machine nobody is watching, by someone who is not
    // reading this code — it may add a field, never re-point a request.
    process.env.AI_EXTRA_BODY = '{"model":"hijacked","stream":true,"temperature":9,"messages":[],"provider":{"zdr":true}}';
    await run([{ status: 200 }]);
    const clash = JSON.parse(hits[0].body);
    check('it cannot override the model, the stream flag, the temperature or the messages',
        clash.model === 'stub-model' && clash.stream === false && clash.temperature !== 9 && clash.messages.length > 0,
        hits[0].body);
    check('…while the fields it is allowed to add still arrive', clash.provider?.zdr === true);

    // An unparseable env var must cost the extra fields, never the app.
    process.env.AI_EXTRA_BODY = '{"provider":{ oops';
    const broken = await run([{ status: 200 }]);
    check('malformed JSON is dropped, and the request still answers',
        broken.content === 'ok' && !('provider' in JSON.parse(hits[0].body)), broken.error?.message);

    process.env.AI_EXTRA_BODY = '["provider"]';
    check('a JSON value that is not an object is dropped', Object.keys(aiExtraBody()).length === 0);
    process.env.AI_EXTRA_BODY = '"just a string"';
    check('…a bare string too', Object.keys(aiExtraBody()).length === 0);
    delete process.env.AI_EXTRA_BODY;
    check('unsetting it empties the cache rather than keeping the last value', Object.keys(aiExtraBody()).length === 0);
}

section('every OpenAI-compatible request is built the same way');
{
    // The gate rather than the inspection: the failure this prevents is a new
    // call site written with a bare JSON.stringify, which sends a body that is
    // correct in every way except that the deployment's privacy flags are
    // missing from it. Matches only a URL built as a template literal
    // (`${base}/chat/completions`), so prose and the suffix-stripping regex in
    // normalizeOpenAIBaseUrl are not call sites.
    const target = /`\$\{[^`]*\}\/(?:chat\/completions|embeddings)`/g;
    let found = 0, bare = [];
    for (const file of ['../server/ai.js', '../server/embeddings.js']) {
        const src = readFileSync(new URL(file, import.meta.url), 'utf8');
        for (const m of src.matchAll(target)) {
            found++;
            const after = src.slice(m.index, m.index + 900);
            const body = after.match(/body:\s*([\w.]+)\s*\(/);
            if (!body) bare.push(`${file}: no body: within 900 chars of ${m[0]}`);
            else if (body[1] !== 'openAIBody') bare.push(`${file}: ${m[0]} sends body: ${body[1]}(`);
        }
    }
    check('all four OpenAI-compatible POSTs were found', found === 4, `${found} found`);
    check('every one of them builds its body with openAIBody()', bare.length === 0, bare.join('; '));

    // And the other direction, which a scan for the hosted call sites cannot
    // see: Ollama is a local engine on the learner's own machine. Handing it a
    // hosted endpoint's routing fields is meaningless at best, and it muddles
    // the one thing this mechanism is for — a flag that only makes sense where
    // the data actually leaves. (A careless sed put openAIBody here once.)
    const emb = readFileSync(new URL('../server/embeddings.js', import.meta.url), 'utf8');
    // Anchored on the template literal that BUILDS the URL, not on the first
    // mention of the path — which is in this module's header comment.
    const ollama = emb.slice(emb.indexOf('}/api/embed`'));
    check('the local Ollama endpoint is NOT handed them',
        /body:\s*JSON\.stringify\(/.test(ollama.slice(0, 400)) && !/body:\s*openAIBody\(/.test(ollama.slice(0, 400)));
}

server.close();
// Close the handle before deleting: on Windows an open better-sqlite3 file
// cannot be removed, and a scratch directory left in TEMP must not be the thing
// that fails a suite.
try { db.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
