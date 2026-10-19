// tools/ai-connections-gates.mjs — every way to connect a model, and what each
// one actually sends.
//
// Run:  node tools/ai-connections-gates.mjs
//
// Five protocols sit behind the app's one chat-completions shape (server/
// aiWire.js), and each fails silently when it fails: a cache breakpoint in the
// wrong place costs money and says nothing, a temperature sent to OpenAI is a
// 400 that reads as a bad key, a ChatGPT usage limit retried three times looks
// like a slow answer, a thinking block dropped between tool rounds is a refusal
// on the second round only. So this drives the REAL modules against stubs of
// Anthropic's Messages API, OpenAI's Responses API and OpenAI's sign-in server,
// all on loopback, on a scratch library set IN-PROCESS before import, and reads
// what arrived.
//
// No model, no internet, no key of anyone's.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign as signData } from 'node:crypto';

const scratch = mkdtempSync(join(tmpdir(), 'ai-connections-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
// The sign-in and OpenRouter's key check go through netSafety.js, which refuses
// loopback; the stubs below ARE loopback. Read at module load, so set first.
process.env.ALLOW_PRIVATE_FETCH = '1';
for (const k of ['AI_EXTRA_BODY', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const listen = (srv) => new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const readBody = (req) => new Promise(ok => { let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => ok(raw)); });

// ── a stub of Anthropic's API ─────────────────────────────────────────────
const CAPS = {
    id: 'stub-claude', display_name: 'Stub Claude', max_tokens: 64000,
    capabilities: {
        image_input: { supported: true },
        thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
        effort: { supported: true, low: { supported: true }, medium: { supported: false }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } },
    },
};
const anth = { requests: [], script: null, failNext: [] };
const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.end();
};
const textReply = (text, { thinking = 'Weighing it.', usage = { input_tokens: 20, cache_read_input_tokens: 700, cache_creation_input_tokens: 0, output_tokens: 5 } } = {}) => [
    { type: 'message_start', message: { id: 'msg_1', model: 'stub-claude', usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-A' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
];
const anthropicStub = createServer(async (req, res) => {
    const raw = await readBody(req);
    anth.requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (req.headers['x-api-key'] !== 'sk-ant-good-1234') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models/stub-claude')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(CAPS)); }
    if (req.method === 'GET' && req.url.startsWith('/v1/models/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"not_found_error","message":"model"}}'); }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'stub-claude', display_name: 'Stub Claude', created_at: '2026-01-01T00:00:00Z' }, { id: 'stub-haiku', display_name: 'Stub Haiku' }], has_more: false }));
    }
    if (req.method === 'POST' && req.url === '/v1/messages') {
        const f = anth.failNext.shift();
        if (f) { res.writeHead(f.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(f.body)); }
        return sse(res, anth.script ? anth.script(JSON.parse(raw)) : textReply('Hello from the stub.'));
    }
    res.writeHead(404); res.end();
});
const ANTH_PORT = await listen(anthropicStub);

// ── a stub of the Responses API (a ChatGPT plan) ─────────────────────────
const resp = { requests: [], script: null };
const responsesStub = createServer(async (req, res) => {
    const raw = await readBody(req);
    resp.requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ models: [{ slug: 'plan-model', display_name: 'Plan Model', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] }));
    }
    if (req.url === '/v1/responses') {
        const events = resp.script ? resp.script(JSON.parse(raw)) : [
            { type: 'response.reasoning_summary_text.delta', delta: 'Thinking.' },
            { type: 'response.output_text.delta', delta: 'Plan ' },
            { type: 'response.output_text.delta', delta: 'answer.' },
            { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } } } },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        return res.end();
    }
    res.writeHead(404); res.end();
});
const RESP_PORT = await listen(responsesStub);
process.env.CHATGPT_API_BASE = `http://127.0.0.1:${RESP_PORT}/v1`;

// ── a stub of OpenAI's sign-in server ─────────────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'gate-key', alg: 'RS256', use: 'sig' };
let issuedTokens = 1;
const auth = { tokenCalls: [], revoked: [], nonce: '', refreshScript: null, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' };
let AUTH_BASE = '';
const jwt = (claims, key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'gate-key', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${signData('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
};
const authStub = createServer(async (req, res) => {
    const raw = await readBody(req);
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    // `auth.redirect[path]` answers that path with a 307, which keeps method and body.
    const moved = auth.redirect?.[req.url];
    if (moved) { res.writeHead(307, { Location: moved }); return res.end(); }
    if (req.url.endsWith('-moved')) req.url = req.url.slice(0, -'-moved'.length);   // where a same-host 307 lands
    if (req.url === '/.well-known/openid-configuration') return json(200, { issuer: AUTH_BASE, jwks_uri: `${AUTH_BASE}/jwks`, revocation_endpoint: auth.revokeEndpoint || `${AUTH_BASE}/revoke` });
    if (req.url === '/jwks') return json(200, { keys: [JWK] });
    if (req.url === '/revoke') { auth.revoked.push(Object.fromEntries(new URLSearchParams(raw))); res.writeHead(200); return res.end(); }
    if (req.url === '/api/accounts/oauth/token') {
        const form = Object.fromEntries(new URLSearchParams(raw));
        auth.tokenCalls.push(form);
        if (form.grant_type === 'refresh_token') {
            await new Promise(r => setTimeout(r, 60));   // long enough for a second caller to arrive
            if (auth.refreshScript) return auth.refreshScript(json, form);
            issuedTokens++;
            return json(200, { access_token: `access-${issuedTokens}`, refresh_token: `refresh-${issuedTokens}`, expires_in: 3600, scope: auth.scope, token_type: 'Bearer' });
        }
        const now = Math.floor(Date.now() / 1000);
        return json(200, {
            access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: auth.scope, token_type: 'Bearer',
            id_token: jwt({ iss: AUTH_BASE, aud: form.client_id, sub: 'user-sub-1', email: 'learner@example.com', exp: now + 3600, iat: now, nonce: auth.nonce }),
        });
    }
    res.writeHead(404); res.end();
});
const AUTH_PORT = await listen(authStub);
AUTH_BASE = `http://127.0.0.1:${AUTH_PORT}`;
// Another origin a redirect could point at; it records every request it gets.
const collected = [];
const collector = createServer(async (req, res) => {
    collected.push({ url: req.url, body: await readBody(req) });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
});
const COLLECTOR = `http://127.0.0.1:${await listen(collector)}`;
process.env.CHATGPT_AUTH_BASE = AUTH_BASE;
process.env.CHATGPT_CALLBACK_PORT = '0';

const db = (await import('../server/database.js')).default;
const ai = await import('../server/ai.js');
const wire = await import('../server/aiWire.js');
const aw = await import('../server/anthropicWire.js');
const cw = await import('../server/chatgptWire.js');
const conns = await import('../server/aiConnections.js');
const cauth = await import('../server/chatgptAuth.js');
const { NOW_BLOCK_HEADING, chatNowBlock } = await import('../server/chatContext.js');
const { isSecretSettingKey } = await import('../server/auth.js');
const { isToolRefusalError } = await import('../server/aiTools.js');

const put = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
const del = (...ks) => db.prepare(`DELETE FROM settings WHERE key IN (${ks.map(() => '?').join(',')})`).run(...ks);
const row = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
// Keys and sign-ins are kept in the credentials file beside the library
// (server/secrets.js), so the gate reads and writes them there.
const { getSecret, connectionSecret } = await import('../server/secrets.js');
const connKey = (row) => (row?.secret_ref ? getSecret(connectionSecret(row.secret_ref, 'api_key')) : '');
const creds = (id) => conns.credentialsOf(db.prepare('SELECT * FROM ai_connections WHERE id = ?').get(id));
const ANTH_BASE = `http://127.0.0.1:${ANTH_PORT}/v1`;

/* ── 1. the Anthropic translation, pure ─────────────────────────────────── */
console.log('\n--- an OpenAI-shaped request becomes a Messages request ---');
aw.resetAnthropicWireState();
const stable = 'You are the study assistant. '.repeat(40);
const tail = chatNowBlock({ nowMs: Date.UTC(2026, 9, 12, 20, 0), timeZone: 'UTC' });
let req = aw.toAnthropicRequest({
    model: 'stub-claude', stream: false, temperature: 0.1, top_p: 0.9,
    messages: [{ role: 'system', content: `${stable}\n\n${tail}` }, { role: 'user', content: 'Hi' }],
}, { caps: CAPS });
check('chat\'s clock block is cut off the system text, at its heading', req.system?.length === 2 && req.system[1].text.startsWith(NOW_BLOCK_HEADING), JSON.stringify(req.system?.map(b => b.text.slice(0, 30))));
check('the breakpoint sits on the part that is the same every turn, not on the clock',
    eq(req.system[0].cache_control, { type: 'ephemeral' }) && !req.system[1].cache_control);
check('the system text is not changed by the cut (the parts join back to it)', req.system[0].text + req.system[1].text === `${stable}\n\n${tail}`);
check('no temperature or top_p reaches Anthropic (current models refuse them)', !('temperature' in req) && !('top_p' in req));
check('upstream always streams, whatever the caller asked', req.stream === true);
check('a one-shot request without tools caches no conversation tail (a write nobody reads)', !('cache_control' in req));
check('adaptive thinking, summarised, on a model whose catalogue offers it', eq(req.thinking, { type: 'adaptive', display: 'summarized' }));

req = aw.toAnthropicRequest({ model: 'x', messages: [{ role: 'system', content: 'Short and stable.' }, { role: 'user', content: 'Hi' }] }, { caps: null });
check('a plain system text is one block carrying the breakpoint', req.system?.length === 1 && eq(req.system[0].cache_control, { type: 'ephemeral' }));
check('a model the catalogue does not describe is sent no thinking and no effort', !('thinking' in req) && !('output_config' in req));

req = aw.toAnthropicRequest({
    model: 'stub-claude', reasoning: { effort: 'medium' },
    messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'find_in_library', arguments: '{"query":"waves"}' } }] },
        { role: 'tool', tool_call_id: 'call_9', content: 'found 2' },
        { role: 'system', content: 'Budget spent.' },
    ],
    tools: [{ type: 'function', function: { name: 'find_in_library', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }],
}, { caps: CAPS });
check('a picture rides as a base64 image block', eq(req.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }));
check('a tool call becomes tool_use with its arguments parsed', eq(req.messages[1].content[0], { type: 'tool_use', id: 'call_9', name: 'find_in_library', input: { query: 'waves' } }));
check('the tool result and a later system note share ONE user turn', req.messages.length === 3 && req.messages[2].role === 'user'
    && req.messages[2].content[0].type === 'tool_result' && req.messages[2].content[1].text === 'Budget spent.', JSON.stringify(req.messages[2]));
check('tools become input_schema tools, chosen automatically', req.tools?.[0]?.input_schema?.properties?.query && eq(req.tool_choice, { type: 'auto' }));
check('a request with tools caches its tail too (the lookup rounds resend it)', eq(req.cache_control, { type: 'ephemeral' }));
check('an automatic medium on a model offering low/high/max is sent as high — never less thinking than asked',
    eq(req.output_config, { effort: 'high' }), JSON.stringify(req.output_config));
check('…and its output cap grows with the level, within the model\'s own ceiling', req.max_tokens === 64000, String(req.max_tokens));
const low = aw.toAnthropicRequest({ model: 'stub-claude', reasoning: { effort: 'low' }, messages: [{ role: 'user', content: 'x' }] }, { caps: CAPS });
const max = aw.toAnthropicRequest({ model: 'stub-claude', reasoning: { effort: 'max' }, messages: [{ role: 'user', content: 'x' }] }, { caps: CAPS });
check('low thinks least and gets the smallest cap; max is held to the model\'s ceiling', low.max_tokens === 16000 && max.max_tokens === 64000 && max.output_config.effort === 'max', `${low.max_tokens} ${max.max_tokens}`);

console.log('\n--- a Messages stream becomes an OpenAI stream ---');
const tr = aw.createStreamTranslator();
const lines = [
    { type: 'message_start', message: { id: 'm', model: 'stub-claude', usage: { input_tokens: 3, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need the library.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-XYZ' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me look.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_7', name: 'find_in_library', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"optics"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
].flatMap(ev => tr.push(ev));
const chunks = lines.filter(l => l !== 'data: [DONE]\n\n').map(l => JSON.parse(l.slice(6)));
check('thinking arrives as reasoning_content and text as content', chunks.some(c => c.choices[0].delta.reasoning_content === 'Need the library.') && chunks.some(c => c.choices[0].delta.content === 'Let me look.'));
check('the tool call is index 0 of tool_calls, though it was content block 2', chunks.filter(c => c.choices[0].delta.tool_calls).every(c => c.choices[0].delta.tool_calls[0].index === 0));
check('its arguments arrive in pieces that join to the JSON', chunks.flatMap(c => c.choices[0].delta.tool_calls || []).map(t => t.function.arguments).join('') === '{"query":"optics"}');
const last = chunks.at(-1);
check('the stream ends with finish_reason tool_calls and [DONE]', last.choices[0].finish_reason === 'tool_calls' && lines.at(-1) === 'data: [DONE]\n\n');
check('usage counts cached input as prompt tokens and says how much was cached', last.usage.prompt_tokens === 903 && last.usage.prompt_tokens_details.cached_tokens === 900);
const next = aw.toAnthropicRequest({
    model: 'stub-claude',
    messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'toolu_7', type: 'function', function: { name: 'find_in_library', arguments: '{"query":"optics"}' } }] }, { role: 'tool', tool_call_id: 'toolu_7', content: 'r' }],
}, { caps: CAPS });
check('the next round sends that reply back WITH its signed thinking block (or the API refuses it)',
    next.messages[1].content[0].type === 'thinking' && next.messages[1].content[0].signature === 'sig-XYZ' && next.messages[1].content[2].input.query === 'optics',
    JSON.stringify(next.messages[1].content.map(b => b.type)));
const errLine = aw.createStreamTranslator().push({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
check('an overloaded error mid-stream is a 503 the retry layer knows', JSON.parse(errLine[0].slice(6)).error.code === 503);

/* ── 2. the real ai.js against the Anthropic stub ───────────────────────── */
console.log('\n--- the app\'s own calls, through a stub Anthropic ---');
const anthropicRows = () => {
    put('ai_provider', 'openai'); put('ai_openai_base_url', ANTH_BASE); put('ai_api_format', 'anthropic');
    ai.saveActiveKey('sk-ant-good-1234', `http://127.0.0.1:${ANTH_PORT}`);
    put('ai_openai_model', 'stub-claude'); put('ai_enabled', 'true'); put('ai_reasoning_effort', '');
};
anthropicRows();
aw.resetAnthropicWireState();
anth.requests = [];
const answer = await ai.generateResponse('Write a question', 'You write questions.', [], { operation: 'questions', temperature: 0.2 });
const posted = anth.requests.find(r => r.method === 'POST');
check('a generation comes back as text', answer === 'Hello from the stub.', answer);
check('the key goes as x-api-key with a version header, and no Authorization', posted?.headers['x-api-key'] === 'sk-ant-good-1234' && posted.headers['anthropic-version'] === '2023-06-01' && !posted.headers.authorization);
check('question writing asks for high (clamped onto the model\'s list) with a cap to match', posted?.body.output_config?.effort === 'high' && posted.body.max_tokens === 64000, JSON.stringify(posted?.body.output_config));
check('the model\'s catalogue entry is read once and kept', anth.requests.filter(r => r.url.startsWith('/v1/models/stub-claude')).length === 1);

const streamed = [];
for await (const part of ai.streamResponse('Hi', 'Sys', [], {})) streamed.push(part);
check('a chat stream yields thinking, then content', streamed.some(p => p.type === 'thinking' && p.content === 'Weighing it.') && streamed.some(p => p.type === 'content' && p.content === 'Hello from the stub.'));

anth.failNext = [{ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }];
anth.requests = [];
const afterBusy = await ai.generateResponse('x', 's', [], { operation: 'summary' });
check('Anthropic\'s 529 "overloaded" is retried like a 503', afterBusy === 'Hello from the stub.' && anth.requests.filter(r => r.method === 'POST').length === 2);

anth.script = () => [
    { type: 'message_start', message: { id: 'm', model: 'stub-claude', usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking '.repeat(50) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 64000 } },
    { type: 'message_stop' },
];
let emptyErr = null;
try { await ai.generateResponse('x', 's', [], { operation: 'verify' }); } catch (e) { emptyErr = e; }
check('a reply spent entirely on thinking is named as that, not returned blank',
    /returned no answer/.test(emptyErr?.message || '') && /output budget thinking|reasoning/.test(emptyErr?.message || ''), emptyErr?.message);
anth.script = null;

const listed = await ai.listModelsFor(ai.getAISettings());
check('the model list comes from Anthropic\'s catalogue', eq(listed.map(m => m.name), ['stub-claude', 'stub-haiku']));
check('the vision probe reads image_input from the catalogue', await ai.visionAvailability('stub-claude') === 'listed');

/* ── 3. the ChatGPT plan's wire ─────────────────────────────────────────── */
console.log('\n--- a ChatGPT plan, through the Responses API ---');
const rr = cw.toResponsesRequest({
    model: 'plan-model', temperature: 0.3, top_p: 0.9, stream: false, reasoning: { effort: 'high' },
    messages: [
        { role: 'system', content: 'Be a tutor.' },
        { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }] },
        { role: 'assistant', content: 'A lens.' },
        { role: 'system', content: 'Keep it short.' },
    ],
}).req;
check('every request is store:false and stream:true (the plan route\'s terms)', rr.store === false && rr.stream === true);
check('no temperature, top_p or output cap is sent (the route refuses them)', !('temperature' in rr) && !('top_p' in rr) && !('max_output_tokens' in rr));
check('the leading system text becomes instructions, a later one a developer message', rr.instructions === 'Be a tutor.' && rr.input.at(-1).role === 'developer');
check('no system-role item is sent at all', !rr.input.some(i => i.role === 'system'));
check('a picture becomes input_image, the effort reasoning.effort', rr.input[0].content[1].type === 'input_image' && eq(rr.reasoning, { effort: 'high' }));
check('native tools are refused with a reason that names tools (the assistant falls back to its text protocol)',
    /tool/i.test(cw.toResponsesRequest({ messages: [], tools: [{ type: 'function', function: { name: 'x' } }] }).refuse || ''));

// A signed-in plan connection, token not yet due for refresh.
const planId = Number(db.prepare(`INSERT INTO ai_connections (kind, base_url, account, created_at) VALUES ('chatgpt', 'https://api.openai.com/v1', 'learner@example.com', ?)`)
    .run(new Date().toISOString()).lastInsertRowid);
conns.saveCredentials(planId, { client_id: 'oaiapp_stub', access_token: 'plan-token', refresh_token: 'r', expires_at: 4_102_444_800_000, scopes: ['chatgpt.tokens.use.direct'] });
const planSettings = { ...ai.getAISettings(), provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiFormat: 'chatgpt', connectionId: planId, model: 'plan-model', apiKey: '' };
check('a plan connection speaks the chatgpt wire though it shares api.openai.com with a key', wire.wireOf(planSettings) === 'chatgpt' && wire.wireOf({ ...planSettings, apiFormat: '' }) === 'openai');
const planModels = await ai.listModelsFor(planSettings);
check('the plan\'s model list keeps only what is meant to be shown', eq(planModels.map(m => m.name), ['plan-model']));
resp.requests = [];
const planAnswer = await ai.tinyReplyFor(planSettings);
check('a one-shot call gets the streamed answer whole, sent with the plan\'s bearer token',
    planAnswer === 'Plan answer.' && resp.requests.at(-1)?.headers.authorization === 'Bearer plan-token', planAnswer);
resp.script = () => [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }];
resp.requests = [];
put('ai_provider', 'openai'); put('ai_openai_base_url', 'https://api.openai.com/v1'); put('ai_api_format', 'chatgpt');
put('ai_active_connection', String(planId)); put('ai_openai_model', 'plan-model'); ai.clearActiveKey();
let limitErr = null;
try { await ai.generateResponse('x', 's', [], { operation: 'chat' }); } catch (e) { limitErr = e; }
check('a usage limit is said in words that name where to change it', /ChatGPT → Settings → Usage/.test(limitErr?.message || ''), limitErr?.message);
check('…and is NOT retried (it will not change in seconds)', resp.requests.filter(r => r.url === '/v1/responses').length === 1, String(resp.requests.length));
resp.script = null;
const toolErr = await wire.wireFetch(planSettings)('https://api.openai.com/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'plan-model', messages: [], stream: true, tools: [{ type: 'function', function: { name: 'x' } }] }),
});
const toolBody = await toolErr.text();
check('the assistant reads that refusal as "this endpoint cannot do native tools"', isToolRefusalError({ httpStatus: toolErr.status, responseBody: toolBody }));

/* ── 4. OpenAI, Gemini and OpenRouter bodies ────────────────────────────── */
console.log('\n--- each hosted wire gets the fields it accepts ---');
const openaiSet = { ...ai.getAISettings(), provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiFormat: '', model: 'm', reasoningEffort: '', providerOrder: ['together'], providerSort: 'price' };
check('OpenAI is sent no automatic budget (a model without reasoning refuses one) and no provider routing',
    eq(ai.aiRouting(openaiSet, { operation: 'questions' }), {}), JSON.stringify(ai.aiRouting(openaiSet, { operation: 'questions' })));
// The one stored level was chosen on some other connection (Settings draws no
// thinking control for OpenAI or Gemini); a `max` meant for Claude would make
// every call to a non-reasoning OpenAI model a 400.
check('a level stored for another connection is never sent to OpenAI', eq(ai.aiRouting({ ...openaiSet, reasoningEffort: 'max' }, { operation: 'chat' }), {}));
check('nor to Gemini', eq(ai.aiRouting({ ...openaiSet, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', reasoningEffort: 'medium' }), {}));
check('…and the connection test, which asks at low, sends OpenAI no budget either',
    eq(ai.aiRouting({ ...openaiSet, reasoningEffort: 'low' }, { operation: 'default' }), {}));
let sentBody = null;
await wire.wireFetch(openaiSet, { fetchImpl: async (u, init) => { sentBody = JSON.parse(init.body); return new Response('{}'); } })(
    'https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', temperature: 0.1, top_p: 0.9, messages: [] }) });
check('OpenAI is never sent a temperature (its reasoning models refuse anything but the default)', sentBody && !('temperature' in sentBody) && !('top_p' in sentBody));

// OpenRouter's catalogue, in the shapes it really has (read 2026-10-12, 459 models).
const glm = wire.openRouterEffortsOf({ reasoning: { mandatory: true, supported_efforts: ['max', 'high', 'low'], default_effort: 'max' } });
check('a model offering max/high/low (glm-5.3-flash) gets high for an automatic medium', wire.pickEffort('medium', glm.levels) === 'high', JSON.stringify(glm));
check('…and the low a learner chose, as chosen', wire.pickEffort('low', glm.levels) === 'low');
check('a model with no reasoning, or reasoning but no levels, is sent none',
    wire.pickEffort('medium', wire.openRouterEffortsOf({}).levels) === '' && wire.pickEffort('high', wire.openRouterEffortsOf({ reasoning: { mandatory: false } }).levels) === '');
check('levels listed as null take whatever is asked', wire.pickEffort('xhigh', wire.openRouterEffortsOf({ reasoning: { supported_efforts: null } }).levels) === 'xhigh');
check('a level above everything listed falls to the strongest there is', wire.pickEffort('max', ['low', 'medium', 'high']) === 'high');

/* ── 5. the keyring on a scratch library ────────────────────────────────── */
console.log('\n--- saved connections, one in use ---');
db.prepare('DELETE FROM ai_connections').run();
del('ai_provider', 'ai_openai_base_url', 'ai_openai_model', 'ai_api_format', 'ai_active_connection', 'ai_model', 'ai_ollama_url');
ai.clearActiveKey();
let list = conns.listConnections();
check('a new library has no connection and none in use', list.connections.length === 0 && list.activeId === null);

// What the welcome screen writes, row by row.
put('ai_provider', 'openai'); put('ai_openai_base_url', 'https://openrouter.ai/api/v1');
ai.saveActiveKey('sk-or-v1-secret-9876', 'https://openrouter.ai'); put('ai_openai_model', 'z-ai/glm-5.3-flash');
list = conns.listConnections();
const orId = list.activeId;
check('rows written by hand become a saved connection, in use', list.connections.length === 1 && list.connections[0].kind === 'openrouter' && list.connections[0].active);
check('the list shows that a key is saved and its last four characters, never the key',
    list.connections[0].hasKey && list.connections[0].keyHint === '…9876' && !JSON.stringify(list).includes('secret'));
check('reading the list twice adds nothing', conns.listConnections().connections.length === 1);

const anthId = conns.addConnection({ kind: 'anthropic', apiKey: 'sk-ant-api03-key-ABCD', model: 'claude-test' });
check('a new connection is saved without taking over', conns.listConnections().activeId === orId);
conns.useConnection(anthId);
check('using it writes its address, key, model and protocol into the rows every call reads',
    row('ai_openai_base_url') === 'https://api.anthropic.com/v1' && getSecret('ai_openai_api_key') === 'sk-ant-api03-key-ABCD'
    && row('ai_openai_api_key_origin') === 'https://api.anthropic.com' && row('ai_openai_model') === 'claude-test' && row('ai_api_format') === 'anthropic');
check('getAISettings now answers with Anthropic and its key', ai.getAISettings().apiKey === 'sk-ant-api03-key-ABCD' && wire.wireOf(ai.getAISettings()) === 'anthropic');
put('ai_openai_model', 'claude-other');   // the model picker writes the row directly
conns.useConnection(orId);
check('switching back brings OpenRouter\'s own key and model back', getSecret('ai_openai_api_key') === 'sk-or-v1-secret-9876' && row('ai_openai_model') === 'z-ai/glm-5.3-flash' && !row('ai_api_format'));
check('…and Anthropic kept the model picked while it was in use', db.prepare('SELECT model FROM ai_connections WHERE id = ?').get(anthId).model === 'claude-other');

conns.updateConnection(orId, { model: 'openai/gpt-6.1-sol' });
check('changing the model of the connection in use reaches the row calls read', row('ai_openai_model') === 'openai/gpt-6.1-sol');

const customId = conns.addConnection({ kind: 'custom', baseUrl: 'http://127.0.0.1:1234', apiKey: 'local-key' });
conns.updateConnection(customId, { baseUrl: 'https://elsewhere.example/v1' });
check('moving a server\'s address does not carry its key to the new host', conns.settingsForConnection(customId).apiKey === '');
check('a per-job settings object can be built for any saved connection and model', conns.settingsForConnection(anthId, { model: 'claude-x' }).model === 'claude-x'
    && conns.settingsForConnection(anthId).apiFormat === 'anthropic' && conns.settingsForConnection(anthId).providerOrder.length === 0);

await conns.removeConnection(orId);
list = conns.listConnections();
check('removing the one in use hands over to the most recently used of the rest', list.activeId !== null && list.activeId !== orId);
for (const c of list.connections) await conns.removeConnection(c.id);
list = conns.listConnections();
check('removing the last leaves a library with no model connected', list.connections.length === 0 && list.activeId === null && !row('ai_provider') && !getSecret('ai_openai_api_key'), JSON.stringify({ n: list.connections.length, a: list.activeId, p: row('ai_provider'), k: !!getSecret('ai_openai_api_key') }));
check('the rows a connection owns are refused by the generic settings writer and kept out of its dump',
    ['ai_api_format', 'ai_active_connection', 'chatgpt_host_id'].every(isSecretSettingKey));

console.log('\n--- a failed test says why, in a word the screen can translate ---');
const why = (o) => conns.describeConnectionFailure(o).reason;
check('Anthropic\'s 401 is a refused key', why({ status: 401, body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }) === 'key');
check('Anthropic\'s "credit balance is too low" (a 400) is no credit', why({ status: 400, body: '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}' }) === 'credit');
check('OpenAI\'s insufficient_quota (a 429) is no credit, not a rate limit', why({ status: 429, body: '{"error":{"code":"insufficient_quota"}}' }) === 'credit');
check('a plain 429 is a rate limit', why({ status: 429, body: 'slow down' }) === 'rate');
check('a missing model is named as the model', why({ status: 404, body: 'model not found' }) === 'model');
check('nothing listening is unreachable; a timeout is a timeout', why({ causeCode: 'ECONNREFUSED', message: 'fetch failed' }) === 'unreachable' && why({ name: 'TimeoutError', message: 'x' }) === 'timeout');
check('a ChatGPT plan at its limit is the plan\'s limit', why({ status: 402, message: cw.USAGE_LIMIT_MESSAGE }) === 'plan_limit');

const badKey = await conns.testSettings({ ...ai.getAISettings(), provider: 'openai', baseUrl: ANTH_BASE, apiFormat: 'anthropic', apiKey: 'sk-ant-wrong', model: 'stub-claude' });
check('testing a wrong key stops at the list, and says key', !badKey.ok && badKey.step === 'list' && badKey.reason === 'key', JSON.stringify(badKey));
anth.failNext = [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }];
const noCredit = await conns.testSettings({ ...ai.getAISettings(), provider: 'openai', baseUrl: ANTH_BASE, apiFormat: 'anthropic', apiKey: 'sk-ant-good-1234', model: 'stub-claude' });
check('a key that may look but not spend is found by the one short reply', !noCredit.ok && noCredit.step === 'reply' && noCredit.reason === 'credit', JSON.stringify(noCredit));
anth.requests = [];
const good = await conns.testSettings({ ...ai.getAISettings(), provider: 'openai', baseUrl: ANTH_BASE, apiFormat: 'anthropic', apiKey: 'sk-ant-good-1234', model: 'stub-claude', reasoningEffort: 'max' });
check('a working key lists the models and gets its reply', good.ok && good.models === 2, JSON.stringify(good));
check('the test reply is asked at low whatever the learner chose (a test is not a job)', anth.requests.find(r => r.method === 'POST')?.body.output_config?.effort === 'low');

console.log('\n--- a test result belongs to what it tested ---');
// "Working: openai/gpt-6.1-sol answered" under a connection set to glm-5.3-flash
// (19 Oct): a verdict outlived the model, key or address it was about.
const testedId = conns.addConnection({ kind: 'custom', baseUrl: ANTH_BASE, apiKey: 'sk-ant-good-1234', model: 'stub-claude' });
const shown = () => conns.listConnections().connections.find(c => c.id === testedId);
const tested = await conns.testConnection(testedId);
check('a test answers with the setup it tested, the same one the list shows', tested.setup && tested.setup === shown().setup && shown().test?.ok === tested.ok, JSON.stringify({ tested, shown: shown() }));
check('the setup is a hash, never the key', /^[0-9a-f]{16}$/.test(shown().setup) && !JSON.stringify(conns.listConnections()).includes('sk-ant-good'));
conns.updateConnection(testedId, { model: 'stub-claude-2' });
check('changing the model hides the old verdict and moves the setup', shown().test === null && shown().setup !== tested.setup, JSON.stringify(shown()));
conns.updateConnection(testedId, { model: 'stub-claude' });
check('…and changing it back shows the verdict about that model again', shown().test?.ok === tested.ok && shown().setup === tested.setup);
conns.updateConnection(testedId, { apiKey: 'sk-ant-other-5678' });
check('a new key hides the verdict about the old one', shown().test === null);
await conns.testConnection(testedId);
conns.updateConnection(testedId, { baseUrl: 'https://elsewhere.example/v1' });
check('a new address hides the verdict about the old one', shown().test === null);
conns.updateConnection(testedId, { baseUrl: ANTH_BASE, apiKey: 'sk-ant-good-1234' });
await conns.testConnection(testedId);
conns.useConnection(testedId);
put('ai_openai_model', 'picked-in-the-picker');   // the model picker writes the row directly
check('a model chosen in the picker hides the verdict about the one before', shown().test === null && shown().model === 'picked-in-the-picker', JSON.stringify(shown()));
const pickedTest = await conns.testConnection(testedId);
check('…and a test then is about the picked model', pickedTest.setup === shown().setup && shown().test !== null);
await conns.removeConnection(testedId);
// The panel also keeps this visit's results; the same rule has to hold there.
const panelSource = readFileSync(new URL('../src/components/settings/connections/ConnectionsPanel.tsx', import.meta.url), 'utf8');
check('the panel shows a result of this visit only for the setup it tested', /result=\{results\[c\.id\]\?\.setup === c\.setup \?/.test(panelSource));

/* ── 6. the real routes ─────────────────────────────────────────────────── */
console.log('\n--- the routes ---');
const { createApp } = await import('../server/app.js');
const appServer = createServer(createApp());
const APP_PORT = await listen(appServer);
const api = (path, init = {}) => fetch(`http://127.0.0.1:${APP_PORT}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
// A hosted kind's address is fixed to the real host, which a gate never calls;
// `custom` aimed at the stub stands in (it refuses any key but its own).
let r = await api('/api/ai/connections', { method: 'POST', body: JSON.stringify({ kind: 'custom', baseUrl: ANTH_BASE, apiKey: 'sk-ant-nope' }) });
const refusedAdd = await r.json();
check('adding with a key the provider refuses saves nothing (422, with the reason)', r.status === 422 && refusedAdd.test?.reason === 'key' && conns.listConnections().connections.length === 0, JSON.stringify(refusedAdd));
check('…and the answer says whether the address may be saved anyway (loopback: yes)', refusedAdd.canSaveAnyway === true);
// "Save anyway" is for a server on the learner's own network only. IP literals,
// so no lookup leaves the machine.
const { isLocalNetworkUrl } = await import('../server/netSafety.js');
const localVerdicts = await Promise.all(['http://127.0.0.1:11434', 'http://localhost:1234/v1', 'http://192.168.1.20:8080/v1', 'http://100.101.1.2:11434', 'http://[::1]:8080', 'http://8.8.8.8/v1', 'https://1.1.1.1/v1', 'not a url'].map(isLocalNetworkUrl));
check('own-network addresses count as local; public ones and junk do not', JSON.stringify(localVerdicts) === JSON.stringify([true, true, true, true, true, false, false, false]), JSON.stringify(localVerdicts));
r = await api('/api/ai/connections', { method: 'POST', body: JSON.stringify({ kind: 'custom', baseUrl: 'http://127.0.0.1:9', saveAnyway: true }) });
const added = await r.json();
check('a local server that is off can still be saved when asked (start it later)', r.ok && added.id && added.test?.ok === false);
check('the first connection added is put in use', added.activeId === added.id, JSON.stringify(added));
r = await api('/api/settings');
const dump = JSON.stringify(await r.json());
check('the settings dump carries no key, no protocol row and no connection row', !/ai_api_format|ai_active_connection|chatgpt_host_id|sk-ant/.test(dump));
r = await api('/api/settings/ai_api_format', { method: 'PUT', body: JSON.stringify({ value: 'chatgpt' }) });
check('…and the generic writer refuses to set the protocol', r.status === 403);
put('ai_api_format', 'chatgpt');
await api('/api/settings/ai_openai_base_url', { method: 'PUT', body: JSON.stringify({ value: 'https://api.openai.com/v1' }) });
check('pointing the app somewhere by hand ends a forced protocol (no OpenAI key through a plan\'s route)', !row('ai_api_format'));
r = await api('/api/ai/efforts?model=stub-claude');
check('the effort list for a provider that publishes none is null (the control is hidden)', (await r.json()).levels === null);
await api(`/api/ai/connections/${added.id}`, { method: 'DELETE' });

/* ── 7. Continue with ChatGPT, against a stub sign-in server ────────────── */
console.log('\n--- Continue with ChatGPT ---');
db.prepare('DELETE FROM ai_connections').run();
del('ai_provider', 'ai_openai_base_url', 'ai_openai_model', 'ai_api_format', 'ai_active_connection');
check('only a browser on this computer can reach the 127.0.0.1 callback',
    cauth.isLocalBrowser('http://127.0.0.1:5257') && cauth.isLocalBrowser('http://localhost:3001') && !cauth.isLocalBrowser('https://100.64.0.7:3001'));
const { url: authorizeUrl } = await cauth.startSignIn({ appOrigin: 'http://127.0.0.1:5257', returnPath: '/settings#ai' });
const q = new URL(authorizeUrl).searchParams;
check('a first sign-in registers dynamically, under the app\'s own name and a host id',
    q.get('client_id') === 'dynamic_agent_client' && q.get('agent_name_hint') === 'Terramentor' && /^urn:uuid:[0-9a-f-]{36}$/.test(q.get('ext_agent_host_id')));
check('the callback is http://127.0.0.1:<port>/auth/callback, never localhost', /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(q.get('redirect_uri')));
check('it asks for plan usage and the API resource, with an S256 challenge',
    q.get('scope').split(' ').includes('chatgpt.tokens.use.direct') && q.get('resource') === 'https://api.openai.com/v1' && q.get('code_challenge_method') === 'S256');
check('the host id is the same on the next sign-in', cauth.hostId() === q.get('ext_agent_host_id'));
const callback = q.get('redirect_uri');
let cb = await fetch(`${callback}?code=c1&state=wrong`, { redirect: 'manual' });
check('a callback with another attempt\'s state is refused and saves nothing', cb.status === 400 && conns.listConnections().connections.length === 0);
auth.nonce = q.get('nonce');
auth.tokenCalls = [];
cb = await fetch(`${callback}?code=c1&state=${q.get('state')}&client_id=oaiapp_issued`, { redirect: 'manual' });
const landed = new URL(cb.headers.get('location') || 'http://x/');
check('the browser is sent back to the app\'s Settings, saying it connected', cb.status === 302 && landed.origin === 'http://127.0.0.1:5257' && landed.pathname === '/settings'
    && /^connected-\d+$/.test(landed.searchParams.get('chatgpt') || '') && landed.hash === '#ai', cb.headers.get('location'));
const exchange = auth.tokenCalls[0] || {};
check('the code is exchanged with the ISSUED client id and the verifier behind the challenge',
    exchange.client_id === 'oaiapp_issued' && createHash('sha256').update(exchange.code_verifier || '').digest('base64url') === q.get('code_challenge') && exchange.redirect_uri === callback);
list = conns.listConnections();
const chat = list.connections[0];
check('the sign-in is a saved connection showing the account and nothing secret',
    chat?.kind === 'chatgpt' && chat.account === 'learner@example.com' && chat.planEnabled && chat.needsPlanNotice && !/access-1|refresh-1|eyJ/.test(JSON.stringify(list)));
check('…NOT in use until its model is chosen (an "In use" with no model cannot answer)', !chat.active && list.activeId === null && !chat.model);
conns.updateConnection(chat.id, { model: 'plan-model' });
conns.useConnection(chat.id);
check('choosing its model and using it makes it the one every call reads', conns.listConnections().activeId === chat.id
    && row('ai_api_format') === 'chatgpt' && row('ai_openai_model') === 'plan-model');
check('the plan row says a sign-in counts as a credential', cauth.hasPlanSignIn(chat.id));
conns.markPlanNoticeSeen(chat.id);
check('the "you are using your plan" notice is shown once', conns.listConnections().connections[0].needsPlanNotice === false);

// Refresh: due, two callers at once, ONE refresh.
const stored = creds(chat.id);
conns.saveCredentials(chat.id, { ...stored, expires_at: 1 });
auth.tokenCalls = [];
const [t1, t2] = await Promise.all([cauth.accessTokenFor(chat.id), cauth.accessTokenFor(chat.id)]);
check('a lapsing token is refreshed once for two callers (the refresh token can be used once)', auth.tokenCalls.filter(c => c.grant_type === 'refresh_token').length === 1 && t1 === t2, `${auth.tokenCalls.length}`);
check('…with the issued client id and the resource', auth.tokenCalls[0]?.client_id === 'oaiapp_issued' && auth.tokenCalls[0]?.resource === 'https://api.openai.com/v1');
const after = creds(chat.id);
check('the rotated refresh token replaces the old one', after.refresh_token !== 'refresh-1' && after.refresh_token.startsWith('refresh-'));

// Second sign-in to the same account reuses its client id and hints.
const { url: again } = await cauth.startSignIn({ appOrigin: 'http://127.0.0.1:5257', connectionId: chat.id });
const q2 = new URL(again).searchParams;
check('signing in again reuses the issued client id, sends the account hints and no name hint',
    q2.get('client_id') === 'oaiapp_issued' && q2.get('id_token_hint') && q2.get('login_hint') === 'learner@example.com' && !q2.get('agent_name_hint'));
auth.nonce = 'some-other-nonce';
cb = await fetch(`${q2.get('redirect_uri')}?code=c2&state=${q2.get('state')}`, { redirect: 'manual' });
check('an ID token answering another attempt (wrong nonce) is rejected', new URL(cb.headers.get('location')).searchParams.get('chatgpt') === 'failed');

// One fixed instant for every expiry below: an assertion must not read the clock.
const PINNED_NOW = 1_790_000_000;
const verifies = (token) => { try { cauth.verifyIdToken(token, { jwks: { keys: [JWK] }, issuer: AUTH_BASE, clientId: 'c', nowSec: PINNED_NOW }); return true; } catch { return false; } };
check('a good ID token verifies (the control for the refusals below)', verifies(jwt({ iss: AUTH_BASE, aud: 'c', sub: 's', exp: PINNED_NOW + 3600 })));
check('a forged ID token does not verify', (() => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    return !verifies(jwt({ iss: AUTH_BASE, aud: 'c', sub: 's', exp: PINNED_NOW + 3600 }, other));
})());
check('an ID token for another client or an expired one does not verify', ['other', 'expired'].every(kind => {
    const t = jwt({ iss: AUTH_BASE, aud: kind === 'other' ? 'someone-else' : 'c', sub: 's', exp: kind === 'expired' ? PINNED_NOW - 1 : PINNED_NOW + 3600 });
    try { cauth.verifyIdToken(t, { jwks: { keys: [JWK] }, issuer: AUTH_BASE, clientId: 'c' }); return false; } catch { return true; }
}));

// A refresh OpenAI refuses ends the sign-in but keeps the account.
conns.saveCredentials(chat.id, { ...after, expires_at: 1 });
auth.refreshScript = (json) => json(400, { error: 'invalid_grant' });
let ended = null;
try { await cauth.accessTokenFor(chat.id); } catch (e) { ended = e; }
const keptRow = creds(chat.id);
check('a refused refresh says sign in again, drops the tokens and keeps the client id', /Sign in again/.test(ended?.message || '') && !keptRow.refresh_token && keptRow.client_id === 'oaiapp_issued');
auth.refreshScript = null;

// A sign-in that did not allow plan usage.
auth.scope = 'openid profile email offline_access';
const { url: noPlanUrl } = await cauth.startSignIn({ appOrigin: 'http://127.0.0.1:5257' });
const q3 = new URL(noPlanUrl).searchParams;
auth.nonce = q3.get('nonce');
cb = await fetch(`${q3.get('redirect_uri')}?code=c3&state=${q3.get('state')}&client_id=oaiapp_two`, { redirect: 'manual' });
check('a sign-in without plan usage lands as "noplan"', new URL(cb.headers.get('location')).searchParams.get('chatgpt') === 'noplan');
const noPlan = conns.listConnections().connections.find(c => c.id !== chat.id);
let refused = null;
try { await cauth.accessTokenFor(noPlan.id); } catch (e) { refused = e; }
check('…and is never used for a request', noPlan && !noPlan.planEnabled && /did not allow plan usage/.test(refused?.message || ''));
auth.scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

// The discovery document decides where a refresh token goes to be revoked;
// one that names another host is not followed.
check('only OpenAI\'s own hosts are trusted for keys and revocation',
    cauth.trustedAuthUrl(`${AUTH_BASE}/revoke`) && cauth.trustedAuthUrl('https://auth.openai.com/oauth/revoke')
    && !cauth.trustedAuthUrl('https://evil.example/revoke') && !cauth.trustedAuthUrl('http://auth.openai.com.evil.example/x')
    && !cauth.trustedAuthUrl('http://cdn.openai.com/jwks'));
auth.revokeEndpoint = 'https://evil.example/revoke';
cauth.resetChatgptAuthState();
auth.revoked = [];
const toEvil = await cauth.signOut({ credentials: JSON.stringify({ refresh_token: 'refresh-secret', client_id: 'oaiapp_issued' }) });
check('…so a document naming another revocation host gets no token, and the sign-out says unconfirmed', toEvil === false && auth.revoked.length === 0);
auth.revokeEndpoint = null;
cauth.resetChatgptAuthState();

// A trusted address that ANSWERS with a redirect: a 307/308 keeps method and
// body, so the refresh token would go wherever it points. The control first:
// without the per-hop check the collector does receive the body.
const { safeFetch } = await import('../server/netSafety.js');
auth.redirect = { '/revoke': `${COLLECTOR}/stolen` };
collected.length = 0;
await safeFetch(`${AUTH_BASE}/revoke`, { method: 'POST', body: 'token=control-secret' });
check('control: a plain 307 forwards a POST body to another origin', collected[0]?.body === 'token=control-secret', JSON.stringify(collected));
collected.length = 0;
auth.revoked = [];
const redirected = await cauth.signOut({ credentials: JSON.stringify({ refresh_token: 'refresh-secret', client_id: 'oaiapp_issued' }) });
check('a revocation endpoint that redirects to another host is not followed, and the sign-out says unconfirmed',
    redirected === false && collected.length === 0 && auth.revoked.length === 0, JSON.stringify(collected));
auth.redirect = { '/jwks': `${COLLECTOR}/jwks` };
cauth.resetChatgptAuthState();
const viaKeys = await cauth.signOut({ credentials: JSON.stringify({ refresh_token: 'refresh-secret', client_id: 'oaiapp_issued' }) });
check('signing keys that redirect to another host are refused (nothing reaches it, no token is sent)',
    viaKeys === false && collected.length === 0 && auth.revoked.length === 0, JSON.stringify(collected));
auth.redirect = { '/jwks': `${AUTH_BASE}/jwks-moved`, '/revoke': `${AUTH_BASE}/revoke-moved` };
cauth.resetChatgptAuthState();
const sameHost = await cauth.signOut({ credentials: JSON.stringify({ refresh_token: 'refresh-moved', client_id: 'oaiapp_issued' }) });
check('…while a redirect on the sign-in host itself is still followed', sameHost === true && auth.revoked.at(-1)?.token === 'refresh-moved');
auth.redirect = null;
cauth.resetChatgptAuthState();
// The token request carries the code verifier or the refresh token in its body
// too; every fetch in the sign-in module must name the per-hop check.
const authSource = readFileSync(new URL('../server/chatgptAuth.js', import.meta.url), 'utf8');
// Each call is read up to the `})` that closes its options, awaited or not.
const fetchCalls = authSource.split(/\bsafeFetch\(/).slice(1).map(after => {
    const end = after.indexOf('})');
    return end < 0 ? after : after.slice(0, end + 2);
});
check('every safeFetch in the sign-in module passes allowRedirect: trustedAuthUrl',
    fetchCalls.length >= 4 && fetchCalls.every(c => /allowRedirect:\s*trustedAuthUrl/.test(c)), `${fetchCalls.length} calls`);

// Removing a signed-in connection revokes its session at OpenAI: the NEWEST
// refresh token, even when a refresh is in flight as the removal starts (the
// token it is about to be issued is the live one; the stored one is spent).
conns.saveCredentials(chat.id, { ...keptRow, refresh_token: 'refresh-final', expires_at: 1 });
auth.revoked = [];
auth.refreshScript = (json) => json(200, { access_token: 'access-race', refresh_token: 'refresh-race', expires_in: 3600, scope: auth.scope, token_type: 'Bearer' });
const inFlight = cauth.accessTokenFor(chat.id);
const { revoked } = await conns.removeConnection(chat.id);
await inFlight.catch(() => { /* the in-flight call may lose its row */ });
auth.refreshScript = null;
check('removing a ChatGPT connection revokes its refresh token: the one a refresh in flight was just issued',
    revoked === true && auth.revoked.length === 1 && auth.revoked[0]?.token === 'refresh-race' && auth.revoked[0]?.client_id === 'oaiapp_issued', JSON.stringify(auth.revoked));
let afterRemoval = null;
try { await cauth.accessTokenFor(chat.id); } catch (e) { afterRemoval = e; }
check('…and nothing of the sign-in is left to use', !!afterRemoval);

/* ── 8. the labs: DeepSeek, Z.ai, Qwen, Kimi ───────────────────────────────
 * Each speaks the OpenAI shape with its own terms, read 13 Oct 2026 from the
 * labs' docs and LiteLLM's code (memory lab-connections-2026-10-13): Z.ai and
 * Qwen document no model list, Z.ai says "no balance" with a 429, DeepSeek and
 * Kimi want the thinking back on every tool round, Kimi's reasoning models
 * refuse a temperature, Z.ai's and Kimi's default thinking is MAX. One stub
 * plays all four under a path each, its wire forced by `apiFormat` because a
 * gate never calls the real hosts. */
console.log('\n--- the labs: DeepSeek, Z.ai, Qwen, Kimi ---');
const LAB_PATHS = { deepseek: '/deepseek/v1', zai: '/zai/api/paas/v4', qwen: '/qwen/compatible-mode/v1', kimi: '/kimi/v1' };
const lab = Object.fromEntries(Object.keys(LAB_PATHS).map(n => [n, { lists: n === 'deepseek' || n === 'kimi', failNext: [], requests: [] }]));
const labStub = createServer(async (req, res) => {
    const raw = await readBody(req);
    const name = Object.keys(LAB_PATHS).find(n => req.url.startsWith(LAB_PATHS[n]));
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!name) return json(404, { error: { message: 'no such lab' } });
    const L = lab[name];
    const path = req.url.slice(LAB_PATHS[name].length);
    L.requests.push({ method: req.method, path, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (path === '/models' && !L.lists) return json(404, { error: { message: 'Not Found' } });
    if (req.headers.authorization !== `Bearer good-${name}`) return json(401, { error: { message: 'Authentication Fails, invalid api key', type: 'authentication_error' } });
    if (path === '/models') return json(200, { object: 'list', data: [{ id: `${name}-one`, object: 'model' }, { id: `${name}-two`, object: 'model' }] });
    if (path === '/chat/completions') {
        const f = L.failNext.shift();
        if (f) return json(f.status, f.body);
        return json(200, { choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    }
    json(404, { error: { message: 'Not Found' } });
});
const LAB_BASE = `http://127.0.0.1:${await listen(labStub)}`;
const labSet = (name, extra = {}) => ({ ...ai.getAISettings(), provider: 'openai', baseUrl: LAB_BASE + LAB_PATHS[name], apiFormat: name, apiKey: `good-${name}`, model: '', reasoningEffort: '', providerOrder: ['together'], providerSort: 'price', connectionId: null, ...extra });
const posts = (name) => lab[name].requests.filter(q => q.method === 'POST');

// Which wire an address speaks, by its host.
const hostWire = (u) => wire.wireOf({ provider: 'openai', baseUrl: u });
check('each lab\'s hosts speak its own wire', eq(
    ['https://api.deepseek.com/v1', 'https://api.z.ai/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4',
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
        'https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1', 'https://aliyuncs.com.evil.example/v1'].map(hostWire),
    ['deepseek', 'zai', 'zai', 'qwen', 'qwen', 'kimi', 'kimi', 'generic']),
    JSON.stringify(['https://api.deepseek.com/v1', 'https://api.z.ai/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1', 'https://aliyuncs.com.evil.example/v1'].map(hostWire)));

// The table every form is drawn from.
const K = conns.CONNECTION_KINDS;
const regionIds = (k) => Object.keys(K[k]?.regions || {});
check('four lab kinds exist, each needing a key; the form asks Z.ai and Qwen for the model (neither documents a list), DeepSeek and Kimi list theirs', ['deepseek', 'zai', 'qwen', 'kimi'].every(k => K[k]?.key === 'required') && K.zai?.typedModel === true && K.qwen?.typedModel === true && !K.deepseek?.typedModel && !K.kimi?.typedModel);
check('the regions: Z.ai global/China, Qwen four, Kimi global/China, DeepSeek none',
    eq(regionIds('zai'), ['global', 'china']) && eq(regionIds('qwen'), ['singapore', 'virginia', 'beijing', 'hongkong']) && eq(regionIds('kimi'), ['global', 'china']) && regionIds('deepseek').length === 0,
    JSON.stringify(['zai', 'qwen', 'kimi', 'deepseek'].map(regionIds)));
const everyAddress = ['deepseek', 'zai', 'qwen', 'kimi'].flatMap(k => [[k, K[k]?.baseUrl], ...Object.values(K[k]?.regions || {}).map(r => [k, r.baseUrl])]);
check('every lab address is https and speaks its kind\'s wire (no address the wire would not recognise)',
    everyAddress.every(([k, u]) => u?.startsWith('https://') && hostWire(u) === k), JSON.stringify(everyAddress.filter(([k, u]) => hostWire(u) !== k)));
check('every region has its own https key page (keys are made per console)',
    ['zai', 'qwen', 'kimi'].every(k => Object.values(K[k]?.regions || { none: {} }).every(r => /^https:\/\//.test(r.keyUrl))) && /^https:\/\//.test(K.deepseek?.keyUrl || ''));
check('every lab region links the lab\'s own page of model names (the typed model has to come from somewhere)',
    ['zai', 'qwen', 'kimi'].every(k => Object.values(K[k]?.regions || { none: {} }).every(r => /^https:\/\//.test(r.modelsUrl || ''))) && /^https:\/\//.test(K.deepseek?.modelsUrl || ''));
check('no kind names a model as a default', Object.values(K).every(v => !('model' in v) && !('defaultModel' in v)));
const securityMd = readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
const unlisted = [...new Set(everyAddress.map(([, u]) => { try { return new URL(u).hostname; } catch { return String(u); } }))].filter(h => !securityMd.includes(`\`${h}\``));
check('SECURITY.md names every lab host the app can reach', everyAddress.length > 4 && unlisted.length === 0, unlisted.join(', '));

// Regions in the keyring.
db.prepare('DELETE FROM ai_connections').run();
del('ai_provider', 'ai_openai_base_url', 'ai_openai_model', 'ai_api_format', 'ai_active_connection', 'ai_model', 'ai_ollama_url');
ai.clearActiveKey();
let threw = null;
try { conns.addConnection({ kind: 'zai', region: 'mars', apiKey: 'k' }); } catch (e) { threw = e; }
check('an unknown region is refused, not guessed', threw?.status === 400 && /region/i.test(threw?.message || ''), String(threw?.message));
const tryDo = (fn) => { try { return fn(); } catch (e) { return e; } };
const zaiId = tryDo(() => conns.addConnection({ kind: 'zai', region: 'china', apiKey: 'zai-key-1111', model: 'typed-model' }));
let zrow = db.prepare('SELECT * FROM ai_connections WHERE id = ?').get(typeof zaiId === 'number' ? zaiId : -1) || {};
check('a chosen region decides the address, and the key is bound to that host', zrow.base_url === K.zai?.regions?.china?.baseUrl && zrow.key_origin === 'https://open.bigmodel.cn' && zrow.model === 'typed-model', JSON.stringify(zrow));
check('…and the list says which region it is', conns.listConnections().connections.find(c => c.id === zaiId)?.region === 'china');
tryDo(() => conns.updateConnection(zaiId, { region: 'global' }));
zrow = db.prepare('SELECT * FROM ai_connections WHERE id = ?').get(typeof zaiId === 'number' ? zaiId : -1) || {};
check('moving to another region does not carry the key there (a key works only in its own)', zrow.base_url === K.zai?.regions?.global?.baseUrl && !connKey(zrow) && !zrow.key_origin, JSON.stringify(zrow));
tryDo(() => conns.updateConnection(zaiId, { region: 'china', apiKey: 'zai-key-2222' }));
zrow = db.prepare('SELECT * FROM ai_connections WHERE id = ?').get(typeof zaiId === 'number' ? zaiId : -1) || {};
check('…with a new key it moves, and the key is bound to the new host', zrow.base_url === K.zai?.regions?.china?.baseUrl && connKey(zrow) === 'zai-key-2222' && zrow.key_origin === 'https://open.bigmodel.cn');
const dsId = tryDo(() => conns.addConnection({ kind: 'deepseek', apiKey: 'ds-key' }));
check('DeepSeek has one address', db.prepare('SELECT base_url FROM ai_connections WHERE id = ?').get(typeof dsId === 'number' ? dsId : -1)?.base_url === K.deepseek?.baseUrl);
// A lab connected before its tile existed, through "Another server".
db.prepare('DELETE FROM ai_connections').run();
const oldId = Number(db.prepare(`INSERT INTO ai_connections (kind, base_url, key_origin, model, created_at) VALUES ('custom', 'https://api.deepseek.com/v1', 'https://api.deepseek.com', 'm', ?)`).run(new Date().toISOString()).lastInsertRowid);
put('ai_provider', 'openai'); put('ai_openai_base_url', 'https://api.deepseek.com/v1'); ai.saveActiveKey('ds-old', 'https://api.deepseek.com'); put('ai_openai_model', 'm'); put('ai_active_connection', String(oldId));
list = conns.listConnections();
check('a lab saved earlier as "Another server" becomes its lab\'s connection, not a second copy',
    list.connections.length === 1 && list.connections[0].id === oldId && list.connections[0].kind === 'deepseek' && list.activeId === oldId, JSON.stringify(list.connections.map(c => [c.id, c.kind])));
db.prepare('DELETE FROM ai_connections').run();
del('ai_provider', 'ai_openai_base_url', 'ai_openai_model', 'ai_active_connection');
ai.clearActiveKey();

// Thinking: each lab its own field, or none.
const route = (name, op, effort = '') => ai.aiRouting(labSet(name, { reasoningEffort: effort, model: 'x' }), { operation: op });
check('DeepSeek gets reasoning_effort on its own list (low/high/max): automatic medium → high, heavy → high, a chosen low as chosen',
    eq(route('deepseek', 'chat'), { reasoning_effort: 'high' }) && eq(route('deepseek', 'questions'), { reasoning_effort: 'high' }) && eq(route('deepseek', 'chat', 'low'), { reasoning_effort: 'low' }),
    JSON.stringify([route('deepseek', 'chat'), route('deepseek', 'chat', 'low')]));
check('Z.ai gets reasoning_effort, never left to its default of max: medium for chat, high for heavy work',
    eq(route('zai', 'chat'), { reasoning_effort: 'medium' }) && eq(route('zai', 'structure'), { reasoning_effort: 'high' }) && eq(route('zai', 'chat', 'max'), { reasoning_effort: 'max' }),
    JSON.stringify([route('zai', 'chat'), route('zai', 'structure')]));
check('Kimi gets reasoning_effort on low/high/max, never its default of max unasked', eq(route('kimi', 'chat'), { reasoning_effort: 'high' }), JSON.stringify(route('kimi', 'chat')));
check('Qwen is sent no thinking field at all (enable_thinking breaks non-streamed calls on some models), even a chosen one',
    eq(route('qwen', 'chat'), {}) && eq(route('qwen', 'questions', 'max'), {}), JSON.stringify(route('qwen', 'chat', 'max')));
check('no lab is sent OpenRouter\'s reasoning object or provider routing', ['deepseek', 'zai', 'kimi', 'qwen'].every(n => !('reasoning' in route(n, 'chat')) && !('provider' in route(n, 'chat'))));
const levels = async (name) => (await conns.effortChoices(labSet(name, { model: 'x' }))).levels;
check('the thinking control offers each lab\'s own levels, and none for Qwen',
    eq(await levels('deepseek'), ['low', 'high', 'max']) && eq(await levels('kimi'), ['low', 'high', 'max'])
    && eq(await levels('zai'), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) && (await levels('qwen')) === null,
    JSON.stringify(await Promise.all(['deepseek', 'kimi', 'zai', 'qwen'].map(levels))));

// What each wire does to the body.
const sentTo = async (settings, body) => {
    let got = null;
    await wire.wireFetch(settings, { fetchImpl: async (u, init) => { got = JSON.parse(init.body); return new Response('{}'); } })(
        `${normalize(settings.baseUrl)}/chat/completions`, { method: 'POST', body: JSON.stringify(body) });
    return got;
};
const normalize = ai.normalizeOpenAIBaseUrl;
const toolTalk = {
    model: 'm', temperature: 0.1, tools: [{ type: 'function', function: { name: 'find_in_library' } }],
    messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'now' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find_in_library', arguments: '{}' } }], reasoning_content: 'I should look.' },
        { role: 'tool', tool_call_id: 'c1', content: 'found' },
    ],
};
let sent = await sentTo(labSet('kimi'), toolTalk);
check('Kimi is sent no temperature (its reasoning models refuse one)', sent && !('temperature' in sent));
sent = await sentTo(labSet('zai'), { ...toolTalk, temperature: 1.4 });
check('Z.ai\'s temperature is kept inside its [0, 1]', sent?.temperature === 1);
sent = await sentTo(labSet('deepseek'), toolTalk);
const asst = (s) => s.messages.filter(m => m.role === 'assistant');
check('DeepSeek gets the round\'s thinking back on the tool-call message', asst(sent)[1]?.reasoning_content === 'I should look.');
check('…and every earlier answer carries one too (a missing one is a 400 in a tool conversation)', typeof asst(sent)[0]?.reasoning_content === 'string' && asst(sent)[0].reasoning_content.length > 0, JSON.stringify(asst(sent)[0]));
sent = await sentTo(labSet('kimi'), toolTalk);
check('Kimi likewise', asst(sent).every(m => typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0));
for (const [label, s] of [['OpenAI', openaiSet], ['OpenRouter', { ...openaiSet, baseUrl: 'https://openrouter.ai/api/v1' }], ['a server of one\'s own', { ...openaiSet, baseUrl: 'http://127.0.0.1:1234/v1' }], ['Qwen', labSet('qwen')]]) {
    sent = await sentTo(s, toolTalk);
    check(`${label} is sent no reasoning_content (a field it never asked for)`, sent && sent.messages.every(m => !('reasoning_content' in m)), JSON.stringify(sent?.messages?.[3]));
}

// The assistant's tool loop keeps each round's thinking for the next request.
const { runNativeAgentTurn, chatTools } = await import('../server/aiTools.js');
const loopTools = chatTools({ library: true });
const seenRounds = [];
await runNativeAgentTurn({
    system: 'sys', message: 'q', tools: loopTools, items: [], context: [], calls: [],
    startRound: async function* (msgs) {
        seenRounds.push(JSON.parse(JSON.stringify(msgs)));
        if (seenRounds.length === 1) {
            yield { type: 'thinking', content: 'Round one thinking.' };
            yield { type: 'tool_calls', calls: [{ id: 't1', name: 'no_such_tool', arguments: '{}' }] };
        } else yield { type: 'content', content: 'Done.' };
    },
});
const carried = seenRounds[1]?.find(m => m.role === 'assistant' && m.tool_calls);
check('the tool loop sends a round\'s thinking back with its tool calls', carried?.reasoning_content === 'Round one thinking.', JSON.stringify(carried));

// Testing a lab: the list may be missing, then the typed model's one short reply decides.
let t = await conns.testSettings(labSet('zai'));
check('a lab with no model list and no model typed asks for the model, saving nothing', !t.ok && t.step === 'list' && t.reason === 'needs_model', JSON.stringify(t));
lab.zai.requests = [];
t = await conns.testSettings(labSet('zai', { model: 'typed-model' }));
check('with a model typed, the reply proves the key', t.ok && t.step === 'reply' && t.listed === false && t.model === 'typed-model', JSON.stringify(t));
check('…asked at low, in Z.ai\'s own field', posts('zai')[0]?.body?.reasoning_effort === 'low' && !('reasoning' in (posts('zai')[0]?.body || {})), JSON.stringify(posts('zai')[0]?.body));
t = await conns.testSettings(labSet('zai', { model: 'typed-model', apiKey: 'wrong' }));
check('a wrong key with no list to read is still a refused key', !t.ok && t.step === 'reply' && t.reason === 'key', JSON.stringify(t));
lab.zai.requests = [];
lab.zai.failNext = [{ status: 429, body: { error: { code: '1113', message: 'Insufficient balance or no resource package. Please recharge.' } } }];
t = await conns.testSettings(labSet('zai', { model: 'typed-model' }));
check('Z.ai\'s "no balance" (a 429) is no credit, not a rate limit', !t.ok && t.reason === 'credit', JSON.stringify(t));
check('…and is asked once, not retried as if it were busy', posts('zai').length === 1, String(posts('zai').length));
lab.zai.failNext = [{ status: 400, body: { error: { code: '1211', message: 'Unknown Model, please check the model code.' } } }];
t = await conns.testSettings(labSet('zai', { model: 'typo-model' }));
check('a mistyped model on Z.ai is named as the model', !t.ok && t.reason === 'model', JSON.stringify(t));
lab.deepseek.requests = [];
t = await conns.testSettings(labSet('deepseek', { model: 'deepseek-one' }));
check('DeepSeek lists its models and gets its reply', t.ok && t.models === 2 && t.listed !== false, JSON.stringify(t));
lab.qwen.requests = [];
t = await conns.testSettings(labSet('qwen', { model: 'typed' }));
const qBody = posts('qwen')[0]?.body || {};
check('Qwen, with no list, is tested by its reply, sent no thinking field', t.ok && !('enable_thinking' in qBody) && !('reasoning_effort' in qBody) && !('reasoning' in qBody), JSON.stringify(qBody));
t = await conns.testSettings(labSet('kimi', { apiKey: 'wrong' }));
check('Kimi with a wrong key stops at its list, and says key', !t.ok && t.step === 'list' && t.reason === 'key', JSON.stringify(t));

// Each lab's real error shapes, in words.
const labWhy = [
    // Measured 13 Oct 2026: GET /models with a made-up key at every lab address
    // (all nine answer 401 before anything else, so a wrong key is a key).
    ['Z.ai, measured (401)', { status: 401, body: '{"error":{"code":"401","message":"token expired or incorrect"}}' }, 'key'],
    ['Qwen Hong Kong, measured (401)', { status: 401, body: '{"code":"InvalidApiKey","message":"Invalid API-key provided."}' }, 'key'],
    ['Z.ai 1000 (401)', { status: 401, body: '{"error":{"code":"1000","message":"Authentication Failed"}}' }, 'key'],
    ['Z.ai 1113 (429)', { status: 429, body: '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}' }, 'credit'],
    ['Z.ai 1309 (429)', { status: 429, body: '{"error":{"code":"1309","message":"Your GLM Coding Plan package has expired and is temporarily unavailable."}}' }, 'credit'],
    ['Z.ai 1211 (400)', { status: 400, body: '{"error":{"code":"1211","message":"Unknown Model, please check the model code."}}' }, 'model'],
    ['Z.ai 1311 (429)', { status: 429, body: '{"error":{"code":"1311","message":"Your current subscription plan does not yet include access to glm-x"}}' }, 'model'],
    ['Z.ai 1302 (429)', { status: 429, body: '{"error":{"code":"1302","message":"Rate limit reached for requests"}}' }, 'rate'],
    ['DeepSeek 401', { status: 401, body: '{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid","type":"authentication_error"}}' }, 'key'],
    ['DeepSeek 402', { status: 402, body: '{"error":{"message":"Insufficient Balance","type":"unknown_error"}}' }, 'credit'],
    ['DeepSeek model (400)', { status: 400, body: '{"error":{"message":"Model Not Exist","type":"invalid_request_error"}}' }, 'model'],
    ['DeepSeek 429', { status: 429, body: '{"error":{"message":"Rate Limit Reached"}}' }, 'rate'],
    ['Qwen wrong key or region (401)', { status: 401, body: '{"error":{"message":"Incorrect API key provided.","type":"invalid_request_error","code":"invalid_api_key"}}' }, 'key'],
    ['Qwen arrears (400)', { status: 400, body: '{"error":{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}}' }, 'credit'],
    ['Qwen model (404)', { status: 404, body: '{"error":{"code":"model_not_found","message":"The model `x` does not exist or you do not have access to it."}}' }, 'model'],
    ['Qwen throttling (429)', { status: 429, body: '{"error":{"code":"Throttling","message":"Requests rate limit exceeded, please try again later."}}' }, 'rate'],
    ['Kimi 401', { status: 401, body: '{"error":{"message":"Invalid Authentication","type":"invalid_authentication_error"}}' }, 'key'],
    ['Kimi quota (429)', { status: 429, body: '{"error":{"message":"Your account org-x<ak-y> is suspended, please check your plan and billing details","type":"exceeded_current_quota_error"}}' }, 'credit'],
    ['Kimi rate (429)', { status: 429, body: '{"error":{"message":"Your account reached max request","type":"rate_limit_reached_error"}}' }, 'rate'],
    ['Kimi model (404)', { status: 404, body: '{"error":{"message":"Not found the model x or Permission denied","type":"resource_not_found_error"}}' }, 'model'],
];
const wrongWhy = labWhy.filter(([, o, want]) => why(o) !== want).map(([n, o]) => `${n} → ${why(o)}`);
check('every lab\'s error shapes become the right plain-words reason', wrongWhy.length === 0, wrongWhy.join('; '));

// The routes hand the form its regions.
r = await api('/api/ai/connections');
const kindsOut = (await r.json()).kinds;
check('the form is told each lab\'s regions and that it takes a typed model',
    eq(kindsOut?.qwen?.regions?.map(x => x.id), ['singapore', 'virginia', 'beijing', 'hongkong']) && kindsOut?.zai?.typedModel === true && kindsOut?.qwen?.regions?.every(x => x.baseUrl && x.keyUrl),
    JSON.stringify(kindsOut?.qwen));
r = await api('/api/ai/connections', { method: 'POST', body: JSON.stringify({ kind: 'kimi', region: 'moon', apiKey: 'k', model: 'm' }) });
check('adding with an unknown region is a 400 before anything is sent', r.status === 400);

// In use, a lab with no model list is reachable: the assistant, Settings and
// course creation all ask /api/ai/status (or the same check) before they start.
put('ai_provider', 'openai'); put('ai_openai_base_url', LAB_BASE + LAB_PATHS.zai); put('ai_api_format', 'zai');
ai.saveActiveKey('good-zai', LAB_BASE); put('ai_openai_model', 'typed-model');
r = await api('/api/ai/status');
const labStatus = await r.json();
check('a lab in use with no model list reads as available, not as a dead connection', labStatus.available === true && labStatus.listed === false, JSON.stringify({ a: labStatus.available, l: labStatus.listed, e: labStatus.error }));
r = await api('/api/ai/models');
const labModels = await r.json();
check('…and its model list answers "none published", not a failure', labModels.success === true && labModels.listed === false && labModels.models.length === 0, JSON.stringify(labModels));
ai.saveActiveKey('wrong', LAB_BASE); put('ai_openai_base_url', LAB_BASE + LAB_PATHS.kimi); put('ai_api_format', 'kimi');
r = await api('/api/ai/status');
check('a lab whose list refuses the key is still unavailable (only a missing list is forgiven)', (await r.json()).available === false);
del('ai_provider', 'ai_openai_base_url', 'ai_openai_model', 'ai_api_format', 'ai_active_connection');
ai.clearActiveKey();
labStub.close();

cauth.resetChatgptAuthState();
for (const s of [anthropicStub, responsesStub, authStub, collector, appServer]) s.close();
db.close();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL a moment longer */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
