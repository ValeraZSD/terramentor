#!/usr/bin/env node
/**
 * `GET /api/ai/endpoints`: the machines behind a model on a router.
 *
 * The answer `available:false` means "this endpoint publishes no such list",
 * and the panel prints exactly that sentence for it and never asks again. A
 * read that did not happen (a timeout, a refused key, no credit, a 5xx, a
 * dropped connection) said the same thing, so a router that was only slow or
 * unauthorised looked like one with nothing to publish. Only a missing route
 * (404/405) and an empty list are that answer; every failed read is a 502 the
 * client can tell apart.
 *
 * The real app is booted on a scratch library, with a stub router on loopback
 * answering a different way for each model id asked about.
 *
 *   node tools/ai-endpoints-gates.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'ai-endpoints-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
// The model route goes through netSafety.js, which refuses loopback; the stub IS loopback.
process.env.ALLOW_PRIVATE_FETCH = '1';
for (const k of ['AI_EXTRA_BODY', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY', 'AI_OLLAMA_URL']) delete process.env[k];

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));

// What the stub router does for each model id: the path is /v1/models/<id>/endpoints.
const behaviour = {
    'v/ok': (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: { endpoints: [{ tag: 'alpha/fp8', provider_name: 'Alpha', pricing: { prompt: '0.000001', completion: '0.000002' }, uptime_last_30m: 99 }] } })); },
    'v/empty': (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: { endpoints: [] } })); },
    'v/gone': (res) => { res.writeHead(404); res.end('{}'); },
    'v/notallowed': (res) => { res.writeHead(405); res.end('{}'); },
    'v/down': (res) => { res.writeHead(503); res.end('{}'); },
    'v/auth': (res) => { res.writeHead(401); res.end('{}'); },
    'v/credit': (res) => { res.writeHead(402); res.end('{}'); },
    'v/garbage': (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>not json'); },
    'v/drop': (res) => { res.socket.destroy(); },
};
const stub = createServer((req, res) => {
    const m = /^\/v1\/models\/(.+)\/endpoints$/.exec(req.url.split('?')[0]);
    const act = m && behaviour[decodeURIComponent(m[1])];
    if (act) return act(res);
    res.writeHead(404); res.end();
});
const BASE = `http://127.0.0.1:${await listen(stub)}/v1`;

const { default: db } = await import('../server/database.js');
const { createApp } = await import('../server/app.js');
const appServer = createServer(createApp());
const APP = await listen(appServer);
const put = (key, value) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
put('ai_provider', 'openai');
put('ai_openai_base_url', BASE);
put('ai_openai_model', 'v/ok');

const ask = async (model) => {
    const r = await fetch(`http://127.0.0.1:${APP}/api/ai/endpoints?model=${encodeURIComponent(model)}`);
    return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('\nthe endpoint has a list');
{
    const r = await ask('v/ok');
    check('a published list is available, with its rows', r.status === 200 && r.body?.available === true && r.body.endpoints?.[0]?.slug === 'alpha', JSON.stringify(r));
}

console.log('\nthe endpoint says it has none');
for (const [model, why] of [['v/gone', 'no such route (404)'], ['v/notallowed', 'the route is not allowed (405)'], ['v/empty', 'a list with nothing in it']]) {
    const r = await ask(model);
    check(`${why}: available false, a real answer`, r.status === 200 && r.body?.available === false && Array.isArray(r.body.endpoints), JSON.stringify(r));
}

console.log('\nthe read failed, which is not the same as "no list"');
for (const [model, why] of [['v/down', 'a 5xx'], ['v/auth', 'a refused key (401)'], ['v/credit', 'no credit left (402)'], ['v/garbage', 'a body that is not JSON'], ['v/drop', 'a dropped connection']]) {
    const r = await ask(model);
    check(`${why}: not a 200, and not "available:false"`, r.status === 502 && r.body?.available === undefined && typeof r.body?.error === 'string', JSON.stringify(r));
}
{
    const r = await ask('v/auth');
    check('the failure names what happened, without the key or the address', /HTTP 401/.test(r.body?.error ?? '') && !r.body.error.includes('127.0.0.1'), r.body?.error);
}

for (const srv of [appServer, stub]) { srv.close(); srv.closeAllConnections(); }
db.close();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL a moment */ }
console.log(`\n${pass} passed, ${fail} failed`);
// Left to end by itself: an exit forced while the sockets above are closing
// trips a libuv assertion on Windows now and then.
process.exitCode = fail ? 1 : 0;
