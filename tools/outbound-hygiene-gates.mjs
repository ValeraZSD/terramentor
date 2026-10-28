// tools/outbound-hygiene-gates.mjs — what the server's outbound requests may
// carry, where they may go on, and how much of an answer they read.
//
// Run:  node tools/outbound-hygiene-gates.mjs
//
// The app talks to model endpoints, search engines, a sign-in server and the
// learner's own local services. Each of those calls fails quietly when its
// rules slip: a redirect that takes the key along, a 2 GB answer read into
// memory, a chunk of a document sent to an endpoint nobody chose. None of it
// shows on screen, so this drives the real modules against loopback stubs and
// reads what arrived where.
//
// Sections, one per rule:
//   1  the OpenRouter sign-in only finishes the attempt this app started
//   2  a model request is never sent on to the address a redirect names
//   3  safeFetch: a redirect drops the body on a method change, and a hop to
//      another origin carries only plain headers
//   4  every answer is read with a ceiling
//   5  cloud metadata addresses are refused even where local ones are allowed,
//      and an endpoint's error body is reduced to its error fields
//   6  embeddings go only to an endpoint someone set up
//   7  finding resources makes no unasked second model call or link probe
//   8  logs name a search by its length and hash, not its words
//   9  pdf.js opens outside PDFs without code evaluation, and a page is drawn
//      into a bounded bitmap
//
// No model, no internet: `fetch` is replaced BEFORE any module loads by a spy
// that passes loopback through and refuses (and records) everything else, and
// name lookups for the metadata check are answered by a stand-in. A scratch
// library is set in-process.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { serverFiles, readServer } from './lib/serverSource.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'outbound-hygiene-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
// safeFetch refuses loopback unless told otherwise, and the stubs below are
// loopback. Read at module load, so set first.
process.env.ALLOW_PRIVATE_FETCH = '1';
for (const k of ['AI_EXTRA_BODY', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY', 'CHATGPT_API_BASE']) delete process.env[k];

// Every request to anywhere but this machine is refused and written down.
// Installed before the imports so a module that captures `fetch` at load
// captures this.
const realFetch = globalThis.fetch;
const offHost = [];
globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const host = new URL(href).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
        offHost.push(href);
        throw new Error('gate: no network');
    }
    return realFetch(input, init);
};
const reachedOff = (pattern) => offHost.some(h => pattern.test(h));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const listen = (srv) => new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const readBody = (req) => new Promise(ok => { let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => ok(raw)); });
const settle = (p) => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
// A module the fix adds is absent from older code; its checks then fail rather
// than the whole gate crashing before it can say which ones.
const optional = (path) => import(path).catch(() => ({}));

const netSafety = await import('../server/netSafety.js');
const aiWire = await import('../server/aiWire.js');
const embeddings = await import('../server/embeddings.js');
const { default: db } = await import('../server/database.js');
const httpBody = await optional('../server/httpBody.js');
const logText = await optional('../server/logText.js');
const pdfOptions = await optional('../server/pdfOptions.js');
const ollamaClient = await optional('../server/ollamaClient.js');
const { createApp } = await import('../server/app.js');

// One name answers with a metadata address; every other name "does not
// resolve", which the check passes on (the request then fails by itself).
netSafety.setMetadataLookupForTest?.(async (host) => {
    if (host === 'meta.gate.test') return [{ address: '169.254.169.254', family: 4 }];
    throw new Error('ENOTFOUND');
});

const appServer = createServer(createApp());
const APP = await listen(appServer);
const api = (path, body) => realFetch(`http://127.0.0.1:${APP}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

// ── stubs ───────────────────────────────────────────────────────────────────
// `elsewhere` stands for any address a redirect might name: it should never be
// reached by a model request, and it records what does reach it.
const elsewhere = { hits: [] };
const elsewhereSrv = createServer(async (req, res) => {
    elsewhere.hits.push({ method: req.method, url: req.url, headers: req.headers, body: await readBody(req) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"message":{"role":"assistant","content":"from elsewhere"}}]}');
});
const ELSEWHERE = await listen(elsewhereSrv);

const BIG_JSON = 17 * 1024 * 1024;
const LONG_LINE = 1536 * 1024;
const endpoint = { routes: {} };
const endpointSrv = createServer(async (req, res) => {
    await readBody(req);
    const path = req.url.split('?')[0];
    // The Anthropic wire posts to the origin's /v1/messages whatever the base
    // path, so that path redirects too.
    if (path.startsWith('/redirect/') || path === '/v1/messages') {
        res.writeHead(307, { location: `http://127.0.0.1:${ELSEWHERE}/v1/chat/completions` });
        return res.end();
    }
    if (path.startsWith('/big-json/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(`{"pad":"${'x'.repeat(BIG_JSON)}"}`);
    }
    if (path.startsWith('/long-line/')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(`data: ${'x'.repeat(LONG_LINE)}`);
    }
    if (path.startsWith('/echo-error/')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
            error: { message: 'model not found', type: 'invalid_request_error', code: 'model_not_found' },
            request: { messages: [{ role: 'user', content: 'SECRET-PROMPT-TEXT' }] },
        }));
    }
    if (path.startsWith('/html-error/')) {
        res.writeHead(502, { 'content-type': 'text/html' });
        return res.end('<html><body><pre>upstream saw: SECRET-PROMPT-TEXT</pre></body></html>');
    }
    res.writeHead(404); res.end();
});
const ENDPOINT = await listen(endpointSrv);
const at = (route) => `http://127.0.0.1:${ENDPOINT}/${route}/v1`;
const chatInit = (headers = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-gate-secret', ...headers },
    body: JSON.stringify({ model: 'stub', messages: [{ role: 'user', content: 'hi' }] }),
});

try {
    // ── 1. OpenRouter sign-in ───────────────────────────────────────────────
    console.log('\n1. the OpenRouter sign-in finishes only the attempt this app started');
    {
        const start = await api('/api/ai/openrouter/start', { callbackUrl: `http://127.0.0.1:${APP}/connect/openrouter` });
        const state = start.json.url ? new URL(start.json.url).searchParams.get('state') : null;
        check('the sign-in URL carries a state the server chose', start.status === 200 && typeof state === 'string' && state.length >= 16, JSON.stringify(start.json));

        const before = offHost.length;
        const forged = await api('/api/ai/openrouter/finish', { code: 'someone-elses-code', state: 'not-the-state' });
        check('a return with the wrong state is turned away', forged.status === 400 && /Connect button/.test(forged.json.error || ''), JSON.stringify(forged));
        const bare = await api('/api/ai/openrouter/finish', { code: 'someone-elses-code' });
        check('a return with no state is turned away', bare.status === 400 && /Connect button/.test(bare.json.error || ''), JSON.stringify(bare));
        check('neither one was sent to OpenRouter', !offHost.slice(before).some(h => /openrouter\.ai/.test(h)), offHost.slice(before).join(', '));

        // The learner's own attempt is still pending: with the right state the
        // server goes on to exchange the code (which the network spy refuses,
        // so it answers "Could not reach", not "expired").
        const real = await api('/api/ai/openrouter/finish', { code: 'the-real-code', state });
        check('the real return still finishes after a forged one', real.status === 502 && /Could not reach OpenRouter/.test(real.json.error || ''), JSON.stringify(real));
    }

    // ── 2. model requests and redirects ─────────────────────────────────────
    console.log('\n2. a model request is never sent on to the address a redirect names');
    {
        elsewhere.hits.length = 0;
        const generic = { provider: 'openai', baseUrl: at('redirect'), apiKey: 'sk-gate-secret' };
        const r = await settle(aiWire.wireFetch(generic)(`${at('redirect')}/chat/completions`, chatInit({ 'x-api-key': 'sk-gate-secret' })));
        check('an OpenAI-compatible endpoint answering 307 reaches nothing else', elsewhere.hits.length === 0, `${elsewhere.hits.length} request(s), headers ${JSON.stringify(elsewhere.hits[0]?.headers || {})}`);
        const text = r.ok ? await r.v.text() : '';
        check('the caller is told it was a redirect', r.ok && r.v.status === 307 && /redirect/i.test(text), r.ok ? `${r.v.status} ${text.slice(0, 120)}` : r.e?.message);

        elsewhere.hits.length = 0;
        // The Anthropic wire reads its route from the path after the origin's
        // /v1, so its base is the bare origin; it asks /v1/models/stub first
        // (404 here, which it shrugs off) and then posts /v1/messages.
        const anthBase = `http://127.0.0.1:${ENDPOINT}/v1`;
        const anth = { provider: 'openai', apiFormat: 'anthropic', baseUrl: anthBase, apiKey: 'sk-gate-secret' };
        const ar = await settle(aiWire.wireFetch(anth)(`${anthBase}/chat/completions`, chatInit()));
        if (ar.ok) await ar.v.body?.cancel();
        check('an Anthropic-format endpoint answering 307 reaches nothing else', elsewhere.hits.length === 0, `${elsewhere.hits.length} request(s)`);
    }

    // ── 3. safeFetch redirects ──────────────────────────────────────────────
    console.log('\n3. safeFetch: a redirect drops a body on a method change, and another origin gets only plain headers');
    {
        const landed = [];
        const otherSrv = createServer(async (req, res) => {
            landed.push({ where: 'other', method: req.method, headers: req.headers, body: await readBody(req) });
            res.writeHead(200); res.end('ok');
        });
        const OTHER = await listen(otherSrv);
        const hopSrv = createServer(async (req, res) => {
            const body = await readBody(req);
            if (req.url === '/see-other') { res.writeHead(303, { location: '/landed' }); return res.end(); }
            if (req.url === '/found') { res.writeHead(302, { location: '/landed' }); return res.end(); }
            if (req.url === '/away') { res.writeHead(307, { location: `http://127.0.0.1:${OTHER}/landed` }); return res.end(); }
            landed.push({ where: 'same', method: req.method, headers: req.headers, body });
            res.writeHead(200); res.end('ok');
        });
        const HOP = await listen(hopSrv);
        const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"secret":"body"}' };

        for (const [route, status] of [['/see-other', 303], ['/found', 302]]) {
            landed.length = 0;
            const r = await settle(netSafety.safeFetch(`http://127.0.0.1:${HOP}${route}`, post));
            if (r.ok) await r.v.body?.cancel();
            const hop = landed[0];
            check(`a POST answered ${status} lands as a GET with no body`, hop && hop.method === 'GET' && hop.body === '' && !hop.headers['content-type'], hop ? `${hop.method} body=${JSON.stringify(hop.body)} content-type=${hop.headers['content-type'] || ''}` : r.e?.message);
        }

        landed.length = 0;
        const r = await settle(netSafety.safeFetch(`http://127.0.0.1:${HOP}/away`, {
            method: 'GET',
            headers: {
                'x-goog-api-key': 'k1', 'api-key': 'k2', 'x-auth-token': 'k3', 'x-made-up-credential': 'k4',
                authorization: 'Bearer k5', accept: 'application/json', 'user-agent': 'gate',
            },
        }));
        if (r.ok) await r.v.body?.cancel();
        const hop = landed.find(l => l.where === 'other');
        const leaked = hop ? ['x-goog-api-key', 'api-key', 'x-auth-token', 'x-made-up-credential', 'authorization'].filter(h => h in hop.headers) : ['(not reached)'];
        check('a hop to another origin carries no credential header of any name', hop && leaked.length === 0, `carried: ${leaked.join(', ')}`);
        check('a hop to another origin keeps accept and user-agent', hop && hop.headers.accept === 'application/json' && hop.headers['user-agent'] === 'gate', JSON.stringify(hop?.headers || {}));
        hopSrv.close(); otherSrv.close();
    }

    // ── 4. bounded reads ────────────────────────────────────────────────────
    console.log('\n4. every answer is read with a ceiling');
    {
        const generic = (route) => ({ provider: 'openai', baseUrl: at(route) });
        const big = await settle(aiWire.wireFetch(generic('big-json'))(`${at('big-json')}/chat/completions`, chatInit()).then(r => r.text()));
        check('a model answer past 16 MB stops being read', !big.ok, big.ok ? `read ${big.v.length} characters` : '');
        const line = await settle(aiWire.wireFetch(generic('long-line'))(`${at('long-line')}/chat/completions`, chatInit()).then(r => r.text()));
        check('a streamed line past 1 MB with no end stops being read', !line.ok, line.ok ? `read ${line.v.length} characters` : '');

        const capped = httpBody.readCappedJson
            ? await settle(httpBody.readCappedJson(new Response(JSON.stringify({ pad: 'x'.repeat(4096) })), 1024))
            : { ok: true, v: '(no readCappedJson)' };
        check('readCappedJson refuses a body past its limit', !capped.ok);
        const small = httpBody.readCappedJson ? await settle(httpBody.readCappedJson(new Response('{"a":1}'), 1024)) : { ok: false };
        check('readCappedJson reads a body inside its limit', small.ok && small.v?.a === 1);

        // The hosted search backends and the ChatGPT sign-in read fixed hosts
        // this gate cannot stand in for; their reads are held by source.
        for (const file of ['searchBackends.js', 'chatgptAuth.js']) {
            const bare = readServer(file).split('\n').filter(l => /\.json\(\)/.test(l) && !/^\s*(\/\/|\*)/.test(l));
            check(`${file} reads no response with an unbounded .json()`, bare.length === 0, bare.map(l => l.trim()).join(' | '));
        }
    }

    // ── 5. metadata addresses and error bodies ──────────────────────────────
    console.log('\n5. metadata addresses are refused where local ones are allowed; error bodies say only why');
    {
        const metadata = ['http://169.254.169.254', 'http://[fd00:ec2::254]', 'http://100.100.100.200', 'http://[::ffff:169.254.169.254]', 'http://meta.gate.test'];
        for (const base of metadata) {
            const before = offHost.length;
            const r = await settle(aiWire.wireFetch({ provider: 'openai', baseUrl: `${base}/v1` })(`${base}/v1/chat/completions`, chatInit()));
            check(`a model request to ${base} is refused before it is sent`, !r.ok && r.e?.code === 'METADATA_ADDRESS' && offHost.length === before, r.ok ? `answered ${r.v.status}` : `${r.e?.code || ''} ${r.e?.message} (sent: ${offHost.slice(before).join(', ')})`);
        }

        const before = offHost.length;
        const searx = await api('/api/searxng/test', { url: 'http://169.254.169.254/latest' });
        check('the SearXNG test refuses a metadata address', searx.json.ok === false && /metadata/.test(searx.json.error || '') && offHost.length === before, `${JSON.stringify(searx.json)} (sent: ${offHost.slice(before).join(', ')})`);

        const Ollama = ollamaClient.Ollama;
        const ol = Ollama ? await settle(new Ollama({ host: 'http://100.100.100.200:11434' }).list()) : { ok: true };
        check('the Ollama client refuses a metadata address', !ol.ok && (ol.e?.code === 'METADATA_ADDRESS' || /metadata/.test(ol.e?.message || '')), ol.ok ? (Ollama ? 'answered' : '(no ollamaClient.js)') : ol.e?.message);
        check('the address check is not a blanket private-address ban', netSafety.isMetadataAddress?.('127.0.0.1') === false && netSafety.isMetadataAddress?.('192.168.1.10') === false && netSafety.isMetadataAddress?.('169.254.169.254') === true);

        const echoed = await aiWire.wireFetch({ provider: 'openai', baseUrl: at('echo-error') })(`${at('echo-error')}/chat/completions`, chatInit()).then(r => r.text());
        check('an error body keeps its error message', /model not found/.test(echoed) && /model_not_found/.test(echoed), echoed.slice(0, 200));
        check('an error body loses everything else it held', !/SECRET-PROMPT-TEXT/.test(echoed), echoed.slice(0, 200));
        const page = await aiWire.wireFetch({ provider: 'openai', baseUrl: at('html-error') })(`${at('html-error')}/chat/completions`, chatInit()).then(r => r.text());
        check('an HTML error page is not passed on', !/SECRET-PROMPT-TEXT|<html/i.test(page), page.slice(0, 200));
    }

    // ── 6. embeddings ───────────────────────────────────────────────────────
    console.log('\n6. embeddings go only to an endpoint someone set up');
    {
        embeddings.setEmbeddingSettings({ enabled: true, model: 'gate-embed', provider: 'openai' });
        const before = offHost.length;
        const fresh = await settle(embeddings.embedBatch(['a chunk of the learner\'s document']));
        check('with no endpoint stored, nothing is sent anywhere', !fresh.ok && offHost.length === before, `sent: ${offHost.slice(before).join(', ')}`);
        const list = await settle(embeddings.listEmbeddingModels());
        check('the model list asks nobody either', list.ok && list.v.available === false && offHost.length === before, `sent: ${offHost.slice(before).join(', ')}`);

        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_openai_base_url', 'https://api.anthropic.com/v1');
        const anth = await settle(embeddings.embedBatch(['a chunk']));
        check('an Anthropic connection is not asked for embeddings', !anth.ok && !reachedOff(/anthropic\.com/), `sent: ${offHost.filter(h => /anthropic/.test(h)).join(', ')}`);
        db.prepare('DELETE FROM settings WHERE key = ?').run('ai_openai_base_url');
    }

    // ── 7. resource finding ─────────────────────────────────────────────────
    console.log('\n7. finding resources makes no unasked second model call or link probe');
    {
        const agentic = readServer('agentic.js');
        check('there is no from-memory fallback after an empty curation', !/training data|internal knowledge/i.test(agentic));
        check('candidate links are not probed one by one', !/verifyResourcesBatch/.test(agentic) && !/export async function verifyResourcesBatch/.test(readServer('ai.js')));
    }

    // ── 8. logs ─────────────────────────────────────────────────────────────
    console.log('\n8. logs name a search by length and hash, never by its words');
    {
        const tag = logText.textTag ? logText.textTag('photosynthesis in C4 plants') : 'photosynthesis in C4 plants';
        check('textTag gives the length and a hash, not the text', !/photosynthesis/.test(tag) && /^27 chars #[0-9a-f]{8}$/.test(tag), tag);
        check('textTag tells two texts apart', logText.textTag?.('a') !== logText.textTag?.('b'));
        const printing = [];
        for (const file of ['ai.js', 'agentic.js', 'searchBackends.js']) {
            readServer(file).split('\n').forEach((l, i) => {
                if (/console\.(log|warn|error|info)\(/.test(l) && /\$\{(query|subElementTitle|q|searchQuery)\}/.test(l)) printing.push(`${file}:${i + 1}`);
            });
        }
        check('no log line prints a search query or topic title verbatim', printing.length === 0, printing.join(', '));
    }

    // ── 9. pdf.js ───────────────────────────────────────────────────────────
    console.log('\n9. pdf.js opens outside PDFs without evaluating code, and draws into a bounded bitmap');
    {
        check('the load options switch evaluation and font loading off', pdfOptions.PDF_LOAD_OPTIONS?.isEvalSupported === false && pdfOptions.PDF_LOAD_OPTIONS?.disableFontFace === true);
        const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const opens = [];
        for (const file of serverFiles()) {
            const src = stripComments(readServer(file));
            for (const m of src.matchAll(/\bgetDocument\(|new PDFParse\(/g)) {
                const call = src.slice(m.index, m.index + 240);
                opens.push({ where: `${file}: ${call.split('\n')[0].trim()}`, ok: /\.\.\.PDF_LOAD_OPTIONS/.test(call) });
            }
        }
        check('the scan finds the server\'s PDF openers', opens.length >= 3, `${opens.length} found`);
        const bare = opens.filter(o => !o.ok);
        check('every PDF opener spreads PDF_LOAD_OPTIONS', bare.length === 0, bare.map(o => o.where).join(' | '));

        const scale = pdfOptions.boundedScale ? pdfOptions.boundedScale(10000, 10000, 3) : 3;
        // The bound is a square root, so it lands within rounding of 40 MP;
        // a thousandth over is the float, not a missed clamp (3x is 900 MP).
        const px = (10000 * scale) * (10000 * scale);
        check('a page declared 3.5 metres square is drawn within 40 MP and 8192 px a side', px <= 40_000_000 * 1.001 && 10000 * scale <= 8192, `scale ${scale} → ${Math.round(10000 * scale)} px a side`);
        check('an A4 page keeps the scale asked for', pdfOptions.boundedScale?.(595, 842, 3) === 3);
        check('a page with no usable size is left at scale 1', pdfOptions.boundedScale?.(0, NaN, 3) === 1);
        check('the math recovery draws through boundedScale', /boundedScale\(/.test(stripComments(readServer('pdfRecovery.js'))));
    }
} finally {
    netSafety.setMetadataLookupForTest?.(null);
    appServer.close(); endpointSrv.close(); elsewhereSrv.close();
    try { db.close(); } catch { /* already closed */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL a moment */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
