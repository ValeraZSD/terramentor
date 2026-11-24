// tools/zero-retention-gates.mjs — a hosted copy sends learners' text to
// OpenRouter only on zero-retention terms, and stops rather than send it on
// any other.
//
// Run:  node tools/zero-retention-gates.mjs
//
// Why this exists: OpenRouter decides retention PER REQUEST. Without
// `provider.zdr: true` it may route a call to any endpoint that serves the
// model, including ones that keep prompts or train on them, and nothing in the
// reply says which kind answered. A copy run for other people (TERRAMENTOR_HOSTED,
// and every library of a site, which runs hosted) sends their notes, photos and
// passages, so the terms cannot depend on the operator remembering to write
// AI_EXTRA_BODY. A missing flag never throws and never shows; only the request
// body can tell, so this reads the bodies that actually left.
//
// Drives the REAL generateResponse, streamResponse, transcribeImageToText and
// embedBatch with `fetch` replaced by a recorder that answers as openrouter.ai
// would. No model, no network (the DNS check is stubbed too), and a scratch DB +
// scratch VAULT_ROOT set IN-PROCESS before anything from server/ is imported.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const scratch = mkdtempSync(join(tmpdir(), 'zero-retention-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
for (const k of ['AI_EXTRA_BODY', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY', 'AI_OLLAMA_URL', 'TERRAMENTOR_HOSTED', 'TERRAMENTOR_SITE_LIBRARY']) delete process.env[k];

const OPENROUTER = 'https://openrouter.ai/api/v1';
const MODEL = 'anthropic/claude-sonnet-5.5';
// OpenRouter's answer when no endpoint of the model fits the request's data
// policy: a 404 naming the policy (the wording seen from its API in Nov 2026).
const NO_ZDR_BODY = JSON.stringify({ error: { message: 'No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy', code: 404 } });

let sent = [];
let refuseRetention = false;
globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    let body = null;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    if (method === 'POST') sent.push({ host: u.host, path: u.pathname, body });
    const json = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    if (method !== 'POST') return json(200, { data: [] }); // the router's model catalogue
    if (refuseRetention) return json(404, NO_ZDR_BODY);
    if (u.pathname.endsWith('/embeddings')) {
        const n = Array.isArray(body?.input) ? body.input.length : 1;
        return json(200, { data: Array.from({ length: n }, (_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) });
    }
    if (body?.stream) {
        const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`;
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return json(200, { choices: [{ message: { content: 'ok' } }] });
};

const db = (await import('../server/database.js')).default;
const { setMetadataLookupForTest } = await import('../server/netSafety.js');
setMetadataLookupForTest(async () => [{ address: '104.18.2.115', family: 4 }]);
const ai = await import('../server/ai.js');
const { embedBatch } = await import('../server/embeddings.js');

let fail = 0, pass = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);
const setting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setting.run('ai_enabled', 'true');

const useEnv = ({ hosted = true, base = OPENROUTER, extra } = {}) => {
    if (hosted) process.env.TERRAMENTOR_HOSTED = '1'; else delete process.env.TERRAMENTOR_HOSTED;
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_BASE_URL = base;
    process.env.AI_MODEL = MODEL;
    process.env.AI_API_KEY = 'sk-or-gate-not-a-real-key';
    if (extra === undefined) delete process.env.AI_EXTRA_BODY; else process.env.AI_EXTRA_BODY = extra;
};
const keepsNothing = (b) => b?.provider?.zdr === true && b?.provider?.data_collection === 'deny';
const show = (b) => JSON.stringify(b?.provider ?? null);
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

/** One call of each kind that carries learner text, returning the bodies sent. */
async function everyKind() {
    sent = [];
    const out = {};
    await ai.generateResponse('What is a cell wall?', 'You are a tutor.');
    out.chat = sent.filter(s => s.path.endsWith('/chat/completions')).at(-1)?.body;
    sent = [];
    for await (const _ of ai.streamResponse('Explain osmosis.', 'You are a tutor.')) { /* drain */ }
    out.stream = sent.filter(s => s.path.endsWith('/chat/completions')).at(-1)?.body;
    sent = [];
    await ai.transcribeImageToText(PNG, {});
    out.vision = sent.filter(s => s.path.endsWith('/chat/completions')).at(-1)?.body;
    sent = [];
    await embedBatch(['a passage from the learner\'s own notes']);
    out.embeddings = sent.filter(s => s.path.endsWith('/embeddings')).at(-1)?.body;
    return out;
}

try {
    section('a hosted copy on OpenRouter asks for zero retention on every call that carries learner text');
    {
        useEnv();
        const bodies = await everyKind();
        for (const kind of ['chat', 'stream', 'vision', 'embeddings']) {
            check(`${kind}: provider.zdr is true and data_collection is deny`, keepsNothing(bodies[kind]), `provider = ${show(bodies[kind])}`);
        }
        check('…and the call itself is untouched (model and messages/input as the app wrote them)',
            bodies.chat?.model === MODEL && Array.isArray(bodies.chat?.messages) && Array.isArray(bodies.embeddings?.input));
    }

    section('a learner\'s provider preference is kept beside the terms, not replaced by them');
    {
        useEnv();
        setting.run('ai_provider_order', JSON.stringify(['google-vertex']));
        setting.run('ai_provider_sort', 'latency');
        const { chat } = await everyKind();
        check('order and sort survive, and both terms are there', keepsNothing(chat)
            && JSON.stringify(chat.provider.order) === '["google-vertex"]' && chat.provider.sort === 'latency', `provider = ${show(chat)}`);
        db.prepare("DELETE FROM settings WHERE key IN ('ai_provider_order', 'ai_provider_sort')").run();
    }

    section('AI_EXTRA_BODY can add to the terms but cannot take them away on a hosted copy');
    {
        useEnv({ extra: JSON.stringify({ provider: { zdr: false, data_collection: 'allow', only: ['amazon-bedrock'] } }) });
        let { chat, embeddings } = await everyKind();
        check('zdr:false and data_collection:allow lose to the hosted terms (chat)', keepsNothing(chat), `provider = ${show(chat)}`);
        check('…and on embeddings', keepsNothing(embeddings), `provider = ${show(embeddings)}`);
        check('…while the rest of the operator\'s provider object still arrives', JSON.stringify(chat?.provider?.only) === '["amazon-bedrock"]', `provider = ${show(chat)}`);
        useEnv({ extra: JSON.stringify({ provider: 'any' }) });
        ({ chat } = await everyKind());
        check('a provider that is not an object is replaced by one with the terms', keepsNothing(chat), `provider = ${show(chat)}`);
    }

    section('decided by where the text goes, not by a stored protocol or the exact host name');
    {
        // A library restored from a desktop copy can carry a forced protocol;
        // its requests still go to openrouter.ai.
        useEnv();
        setting.run('ai_api_format', 'qwen');
        let { chat } = await everyKind();
        check('a stored ai_api_format does not turn the terms off', keepsNothing(chat), `provider = ${show(chat)}`);
        db.prepare("DELETE FROM settings WHERE key = 'ai_api_format'").run();
        useEnv({ base: 'https://eu.openrouter.ai/api/v1' });
        const sub = await everyKind();
        check('an OpenRouter subdomain gets them on chat and embeddings', keepsNothing(sub.chat) && keepsNothing(sub.embeddings),
            `chat ${show(sub.chat)}, embeddings ${show(sub.embeddings)}`);
    }

    section('the start-up warning names an AI_EXTRA_BODY that tries to drop them');
    {
        const { zeroRetentionWarnings } = await import('../server/zeroRetention.js');
        const base = { TERRAMENTOR_HOSTED: '1', AI_PROVIDER: 'openai', AI_BASE_URL: OPENROUTER, AI_MODEL: MODEL };
        check('a hosted copy on OpenRouter with no AI_EXTRA_BODY has nothing to warn about', zeroRetentionWarnings(base).length === 0, JSON.stringify(zeroRetentionWarnings(base)));
        const dropped = zeroRetentionWarnings({ ...base, AI_EXTRA_BODY: '{"provider":{"zdr":false}}' });
        check('zdr:false is warned about, and the warning says it is ignored', dropped.length === 1 && /zdr/.test(dropped[0]) && /ignor/i.test(dropped[0]), JSON.stringify(dropped));
        const allowed = zeroRetentionWarnings({ ...base, AI_EXTRA_BODY: '{"provider":{"data_collection":"allow"}}' });
        check('data_collection:allow is warned about', allowed.length === 1 && /data_collection/.test(allowed[0]), JSON.stringify(allowed));
        const kept = zeroRetentionWarnings({ ...base, AI_EXTRA_BODY: '{"provider":{"zdr":true,"order":["google-vertex"]}}' });
        check('an AI_EXTRA_BODY that keeps them is not warned about', kept.length === 0, JSON.stringify(kept));
        const elsewhere = zeroRetentionWarnings({ ...base, AI_BASE_URL: 'https://api.example.net/v1' });
        check('a hosted copy whose model is NOT on OpenRouter is told the terms cannot be asked for there',
            elsewhere.length === 1 && /api\.example\.net/.test(elsewhere[0]) && /OpenRouter/.test(elsewhere[0]), JSON.stringify(elsewhere));
        check('a local model (Ollama) on a hosted copy has nothing to warn about', zeroRetentionWarnings({ TERRAMENTOR_HOSTED: '1', AI_PROVIDER: 'ollama' }).length === 0);
        check('a copy on the learner\'s own computer is never warned', zeroRetentionWarnings({ ...base, TERRAMENTOR_HOSTED: '', AI_EXTRA_BODY: '{"provider":{"zdr":false}}' }).length === 0);
        check('a site\'s front desk (not hosted itself, its libraries are) is warned for them',
            zeroRetentionWarnings({ ...base, TERRAMENTOR_HOSTED: '', AI_EXTRA_BODY: '{"provider":{"zdr":false}}' }, { hosted: true }).length === 1);
        const blank = zeroRetentionWarnings({ ...base, AI_BASE_URL: '' });
        check('a blank AI_BASE_URL is read as the address a library then uses, which is not OpenRouter',
            blank.length === 1 && blank[0].includes(new URL(ai.DEFAULT_OPENAI_BASE_URL).host), JSON.stringify(blank));
        const effective = zeroRetentionWarnings(base, { settings: { provider: 'openai', baseUrl: 'https://api.example.net/v1' } });
        check('a hosted copy is judged by its effective settings (a stored address), not only by its env',
            effective.length === 1 && /api\.example\.net/.test(effective[0]), JSON.stringify(effective));
        check('an OpenRouter subdomain is OpenRouter, not "another endpoint"',
            zeroRetentionWarnings({ ...base, AI_BASE_URL: 'https://eu.openrouter.ai/api/v1' }).length === 0);
        const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
        const site = readFileSync(new URL('../server/site/index.js', import.meta.url), 'utf8');
        check('server/index.js prints the warnings at start', /zeroRetentionWarnings\(/.test(index));
        check('the site front desk prints them for its libraries', /zeroRetentionWarnings\([^)]*hosted:\s*true/.test(site));
    }

    section('no zero-retention endpoint: the call stops with a reason, and nothing is sent elsewhere');
    {
        useEnv();
        refuseRetention = true;
        sent = [];
        let err = null;
        try { await ai.generateResponse('What is a cell wall?', 'You are a tutor.'); } catch (e) { err = e; }
        const posts = sent.filter(s => s.path.endsWith('/chat/completions'));
        check('the call fails', !!err);
        check('the message says no zero-retention endpoint serves the model, and names it',
            /zero.?(data.?)?retention/i.test(err?.message || '') && err?.message.includes(MODEL), err?.message);
        check('…and points the operator at what to change', /operator|AI_MODEL/i.test(err?.message || '') && /HOSTING/i.test(err?.message || ''), err?.message);
        check('it was asked once, not retried', posts.length === 1, `${posts.length} chat POSTs`);
        check('every request that left carried the terms', posts.every(p => keepsNothing(p.body)));
        check('it is said as a keyed sentence a learner can be shown, not as the endpoint\'s body',
            err?.expose === true && /^No zero-retention endpoint/.test(err?.messageKey || '') && err?.params?.model === MODEL, `${err?.messageKey} ${JSON.stringify(err?.params)}`);
        const { publicBody } = await import('../server/clientError.js');
        const answered = publicBody(err);
        check('a route answers with that sentence, not "check the model name in Settings" (locked on a hosted copy)',
            /^No zero-retention endpoint/.test(answered?.messageKey || '') && !/model name in Settings/.test(answered?.error || ''), JSON.stringify(answered));
        const { fallsOver } = await import('../server/aiJobs.js');
        const plain404 = Object.assign(new Error('Chat request failed (404): no such model'), { httpStatus: 404 });
        check('a backup model is never tried after it (the next choice may keep the text)', fallsOver(err) === false && fallsOver(plain404) === true);
        sent = [];
        let visErr = null;
        try { await ai.transcribeImageToText(PNG, {}); } catch (e) { visErr = e; }
        check('a picture read fails the same way', /^No zero-retention endpoint/.test(visErr?.messageKey || ''), visErr?.message);
        sent = [];
        let embErr = null;
        try { await embedBatch(['a passage']); } catch (e) { embErr = e; }
        const { HOSTED_EMBEDDING_DEFAULT } = await import('../server/embeddings.js');
        check('embeddings fail the same way, naming the embedding model',
            /^No zero-retention endpoint/.test(embErr?.messageKey || '') && embErr?.params?.model === HOSTED_EMBEDDING_DEFAULT, embErr?.message);
        refuseRetention = false;

        // The learner-facing diagnosis must not turn this into "the endpoint
        // does not know the model", which is the 404 arm's words.
        const esbuild = createRequire(import.meta.url)('esbuild');
        const causeSrc = (await esbuild.build({
            entryPoints: [join(process.cwd(), 'src/utils/failureCause.ts')],
            bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
            plugins: [{ name: 'k-only', setup(b) {
                b.onResolve({ filter: /[\\/]i18n$/ }, a => ({ path: a.path, namespace: 'k' }));
                b.onLoad({ filter: /.*/, namespace: 'k' }, () => ({ contents: 'export const k = (s) => s;', loader: 'js' }));
            } }],
        })).outputFiles[0].text;
        const { plainCause, retryMayHelp } = await import(`data:text/javascript;base64,${Buffer.from(causeSrc).toString('base64')}`);
        const facts = { message: err?.message || '', httpStatus: 404, model: MODEL };
        check('the failure dialog does not call it an unknown model', !/does not know the model/.test(plainCause(facts)?.messageKey || ''), JSON.stringify(plainCause(facts)));
        check('…and does not offer Try again first', !retryMayHelp(facts));
    }

    section('outside a hosted copy, or off OpenRouter, nothing is added');
    {
        useEnv({ hosted: false });
        const { chat, embeddings } = await everyKind();
        check('a copy on the learner\'s own computer sends no zdr (chat)', chat?.provider?.zdr === undefined, `provider = ${show(chat)}`);
        check('…nor on embeddings', embeddings?.provider === undefined, `provider = ${show(embeddings)}`);
        useEnv({ base: 'https://api.example.net/v1' });
        const other = await everyKind();
        check('a hosted copy on another endpoint is not sent OpenRouter\'s fields (a strict API refuses unknown ones)',
            other.chat?.provider === undefined && other.embeddings?.provider === undefined, `chat ${show(other.chat)}, embeddings ${show(other.embeddings)}`);
    }

    section('a body built on a hosted copy without knowing where it goes is refused, not sent bare');
    {
        useEnv();
        let threw = false;
        try { ai.openAIBody({ model: MODEL, messages: [] }, {}); } catch { threw = true; }
        check('openAIBody with no target throws on a hosted copy', threw);
        useEnv({ hosted: false });
        let fine = true;
        try { ai.openAIBody({ model: MODEL, messages: [] }, {}); } catch { fine = false; }
        check('…and still builds one on the learner\'s own computer', fine);
    }
} catch (e) {
    fail++;
    console.log(`  FAIL the gate itself threw: ${e?.stack || e}`);
}

console.log(`\nzero-retention-gates: ${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL a moment */ }
process.exitCode = fail ? 1 : 0;
