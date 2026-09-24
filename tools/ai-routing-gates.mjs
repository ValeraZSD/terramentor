// tools/ai-routing-gates.mjs — the thinking budget and the provider preference
// reach the wire, and nothing else does.
//
// Run:  node tools/ai-routing-gates.mjs
//
// Why this exists: both settings are invisible when they fail. A `reasoning`
// field that never leaves the process looks exactly like a model that ignores
// it — the answers are simply slow and expensive, which is what they were
// before — and a provider order that quietly goes missing looks like a router
// having a bad day. Neither throws, neither logs, and the panel keeps showing
// the choice as if it were in force.
//
// So this drives the REAL `generateResponse` and `streamResponse` against a
// stub endpoint and reads the bodies that actually arrived. Loopback only: no
// model, no internet, and a scratch DB + scratch VAULT_ROOT set IN-PROCESS
// before `ai.js` is imported — `database.js` migrates and sweeps at import, and
// a shell `DB_PATH=` prefix has silently failed to apply here before.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'ai-routing-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
delete process.env.AI_EXTRA_BODY;
delete process.env.AI_PROVIDER;
delete process.env.AI_BASE_URL;
delete process.env.AI_MODEL;

let bodies = [];
const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        bodies.push({ url: req.url, body: JSON.parse(raw || '{}') });
        if (JSON.parse(raw || '{}').stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        }
    });
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const PORT = server.address().port;

const db = (await import('../server/database.js')).default;
const ai = await import('../server/ai.js');

const setting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const configure = (rows) => {
    setting.run('ai_provider', 'openai');
    setting.run('ai_openai_base_url', `http://127.0.0.1:${PORT}/v1`);
    setting.run('ai_openai_model', 'stub-model');
    setting.run('ai_enabled', 'true');
    setting.run('ai_reasoning_effort', '');
    setting.run('ai_provider_order', '');
    setting.run('ai_provider_sort', '');
    for (const [k, v] of Object.entries(rows)) setting.run(k, v);
};

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ── what aiRouting() decides ───────────────────────────────────────────── */
console.log('\n--- the preference becomes request fields ---');

// Most of what follows is about the PROVIDER fields, which the operation does
// not touch; they are read in the chat context so the automatic thinking budget
// below is not mixed into every assertion.
const chat = () => ai.aiRouting(undefined, { operation: 'chat' });

configure({});
check('nothing chosen, and somebody watching: send nothing', eq(chat(), {}), JSON.stringify(chat()));

/* The automatic budget. A reasoning-first model left to its own devices can
   spend a whole authoring call thinking and return zero characters — measured
   on OpenRouter/glm-5.3-flash, 125s and no answer — so work nobody watches asks
   for `low` unless the learner has said otherwise. */
for (const op of ['authoring', 'structure', 'summary', 'vision', 'default']) {
    check(`unattended work (${op}) asks for brief by itself`,
        eq(ai.aiRouting(undefined, { operation: op }), { reasoning: { effort: 'low' } }),
        JSON.stringify(ai.aiRouting(undefined, { operation: op })));
}
check('chat is left alone — its reasoning is on screen, not thrown away', eq(chat(), {}));

configure({ ai_reasoning_effort: 'high' });
check('a choice outranks the automatic budget everywhere',
    eq(ai.aiRouting(undefined, { operation: 'authoring' }), { reasoning: { effort: 'high' } })
    && eq(chat(), { reasoning: { effort: 'high' } }),
    JSON.stringify(ai.aiRouting(undefined, { operation: 'authoring' })));

configure({ ai_reasoning_effort: 'low' });
check('a thinking budget becomes reasoning.effort', eq(chat(), { reasoning: { effort: 'low' } }), JSON.stringify(chat()));

configure({ ai_reasoning_effort: 'off' });
check('an effort the protocol has no word for is dropped, not forwarded', eq(chat(), {}), JSON.stringify(chat()));

// Never `{enabled:false}`: endpoints refuse it outright with a 400, so the app
// must not be able to express it from a settings row.
configure({ ai_reasoning_effort: 'high' });
check('the budget never turns reasoning OFF, only down', !JSON.stringify(chat()).includes('enabled'), JSON.stringify(chat()));

configure({ ai_provider_order: JSON.stringify(['together', 'baseten']) });
check('a provider preference becomes provider.order', eq(chat(), { provider: { order: ['together', 'baseten'] } }), JSON.stringify(chat()));

check('and never provider.only — a preference must be able to fall back',
    !JSON.stringify(chat()).includes('only') && !JSON.stringify(chat()).includes('allow_fallbacks'));

configure({ ai_provider_order: JSON.stringify(['ok-slug', 'bad slug', '../etc', 42, 'x'.repeat(200)]) });
check('anything that is not a provider slug is dropped', eq(chat(), { provider: { order: ['ok-slug'] } }), JSON.stringify(chat()));

configure({ ai_provider_order: '{not json' });
check('a malformed row is no preference, not a crash', eq(chat(), {}), JSON.stringify(chat()));

configure({ ai_provider_sort: 'throughput' });
check('a sort choice becomes provider.sort', eq(chat(), { provider: { sort: 'throughput' } }), JSON.stringify(chat()));

configure({ ai_provider_sort: 'vibes' });
check('a sort the protocol has no word for is dropped', eq(chat(), {}), JSON.stringify(chat()));

configure({ ai_provider: 'ollama', ai_reasoning_effort: 'low', ai_provider_sort: 'price' });
check('a local engine is sent neither field', eq(chat(), {}), JSON.stringify(chat()));

/* ── who wins when two layers disagree ──────────────────────────────────── */
console.log('\n--- the deploy beats the panel, and the call beats both ---');

configure({ ai_reasoning_effort: 'low', ai_provider_order: JSON.stringify(['together']) });
const routing = ai.aiRouting();

process.env.AI_EXTRA_BODY = JSON.stringify({ provider: { zdr: true } });
let built = JSON.parse(ai.openAIBody({ model: 'm', messages: [] }, routing));
check('an env-set zdr does not discard the chosen order', eq(built.provider, { order: ['together'], zdr: true }), JSON.stringify(built.provider));
check('the chosen thinking budget survives an unrelated env field', eq(built.reasoning, { effort: 'low' }), JSON.stringify(built.reasoning));

process.env.AI_EXTRA_BODY = JSON.stringify({ reasoning: { effort: 'high' } });
built = JSON.parse(ai.openAIBody({ model: 'm', messages: [] }, routing));
check('when both name the same field the env wins', built.reasoning.effort === 'high', JSON.stringify(built.reasoning));

process.env.AI_EXTRA_BODY = JSON.stringify({ model: 'somebody-elses-model', stream: true, reasoning: { effort: 'high' } });
built = JSON.parse(ai.openAIBody({ model: 'm', messages: [], stream: false }, routing));
check('neither layer can re-point the model', built.model === 'm', built.model);
check('neither layer can un-stream the request', built.stream === false, String(built.stream));
delete process.env.AI_EXTRA_BODY;

/* ── and it is actually on the wire ─────────────────────────────────────── */
console.log('\n--- the bodies that really arrived ---');

configure({ ai_reasoning_effort: 'low', ai_provider_order: JSON.stringify(['together', 'baseten']), ai_provider_sort: 'throughput' });

bodies = [];
await ai.generateResponse('hello', '', [], {});
check('a plain chat request carries both', bodies.length === 1
    && eq(bodies[0].body.reasoning, { effort: 'low' })
    && eq(bodies[0].body.provider, { order: ['together', 'baseten'], sort: 'throughput' }),
    JSON.stringify(bodies[0]?.body?.provider) + ' ' + JSON.stringify(bodies[0]?.body?.reasoning));

bodies = [];
for await (const _ of ai.streamResponse('hello', '', [], {})) { /* drain */ }
check('a streamed chat request carries both', bodies.length === 1
    && eq(bodies[0].body.reasoning, { effort: 'low' })
    && bodies[0].body.stream === true,
    JSON.stringify(bodies[0]?.body?.reasoning));

bodies = [];
await ai.transcribeImageToText(Buffer.from([0x89, 0x50]), { prompt: 'read it' }).catch(() => { });
check('a vision request carries both', bodies.length === 1 && eq(bodies[0].body.reasoning, { effort: 'low' }),
    JSON.stringify(bodies[0]?.body?.reasoning));

/* ── the paths that must NOT carry it ───────────────────────────────────── */
console.log('\n--- source: the embedding path is left alone ---');

const embeddings = readFileSync(new URL('../server/embeddings.js', import.meta.url), 'utf8');
check('embeddings.js never asks for routing fields',
    !/aiRouting/.test(embeddings), 'an embedding has no reasoning channel and no provider worth pinning');

const aiSrc = readFileSync(new URL('../server/ai.js', import.meta.url), 'utf8');
const chatPosts = [...aiSrc.matchAll(/body: openAIBody\(/g)].length;
const routed = [...aiSrc.matchAll(/aiRouting\(settings[,)]/g)].length;
check('every chat and vision POST in ai.js passes the routing', routed === chatPosts, `${routed} of ${chatPosts}`);
// …and passes an operation with it, or the automatic budget cannot tell a
// lesson from a conversation and every call takes the unattended one.
const routedBlind = [...aiSrc.matchAll(/aiRouting\(settings\)/g)].length;
check('and names the operation it is for', routedBlind === 0, `${routedBlind} call(s) pass settings alone`);

// The provider table: one row per slug the preference can name. The shape is
// the one OpenRouter served for glm-5.3-flash on 2026-09-23, where BaseTen is
// listed twice under the identical tag `baseten/fp8`.
console.log('\n--- the provider table has one row per provider ---');
const listed = [
    { tag: 'deepinfra/fp4', provider_name: 'DeepInfra', quantization: 'fp4', pricing: { prompt: '0.000000075', completion: '0.00000025' } },
    { tag: 'baseten/fp8', provider_name: 'BaseTen', quantization: 'fp8', pricing: { prompt: '0.00000015', completion: '0.0000005' }, uptime_last_30m: 99.64 },
    { tag: 'morph', provider_name: 'Morph', quantization: 'unknown', pricing: { prompt: '0.00000008', completion: '0.00000028' }, uptime_last_30m: 96.9 },
    { tag: 'baseten/fp4', provider_name: 'BaseTen', quantization: 'fp4', pricing: { prompt: '0.00000012', completion: '0' }, uptime_last_30m: 99.75 },
    { tag: '', provider_name: '' },
];
const rows = ai.servingEndpointRows(listed);
const slugs = rows.map(r => r.slug);
check('every slug appears once', new Set(slugs).size === slugs.length && slugs.length === 3, slugs.join(','));
check('the first-listed order is kept', slugs.join(',') === 'deepinfra,baseten,morph', slugs.join(','));
const baseten = rows.find(r => r.slug === 'baseten');
check('twins take the cheaper price each way, and an unreported 0 never wins',
    Math.abs(baseten.promptPrice - 0.12) < 1e-9 && Math.abs(baseten.completionPrice - 0.5) < 1e-9,
    `${baseten.promptPrice} / ${baseten.completionPrice}`);
check('…the better uptime, and both quantisations named',
    baseten.uptime === 99.75 && baseten.quantization === 'fp8, fp4', `${baseten.uptime} ${baseten.quantization}`);
check('a row with no name at all is dropped', !slugs.includes(''));
// The control: the pre-fix mapping kept one row per LISTING, so this list
// produced two rows with the slug `baseten`.
const preFix = listed.map(e => String(e.tag || e.provider_name || '').split('/')[0]).filter(Boolean);
check('control: the per-listing map repeats a slug on this input', new Set(preFix).size < preFix.length);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
// Let the loop drain rather than calling process.exit: tearing down while
// better-sqlite3's handle is still closing aborts the process on Windows
// (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`), and a gate that
// exits 127 after printing "0 failed" reads as a broken suite, not a passing one.
process.exitCode = fail ? 1 : 0;
setTimeout(() => {
    try { db.close(); } catch { /* already closed */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will */ }
}, 50).unref();
