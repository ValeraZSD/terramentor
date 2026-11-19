// tools/feed-retry-gates.mjs — the feed retries a busy endpoint, never a refusal.
//
// Run:  node tools/feed-retry-gates.mjs
//
// WHY. The feed's generator retries a step once when the failure is transient
// (`isTransient` in server/feedGen.js) and backs off the whole burst after it.
// It read "502", "503" or "504" anywhere in the error's text. That text names
// the endpoint ("Chat request to http://host:35030/v1 failed (400): ..."), so
// an endpoint whose port or host held those digits got every plain refusal
// retried and backed off as if the server were busy: a bad request took three
// times as long to show, and the next topic waited behind it.
//
// This drives the REAL `generateResponse` against a stub on loopback that
// listens on a port containing "503", and hands its real errors to the real
// `isTransient`. Loopback only: no model, nothing billed, a scratch DB and
// VAULT_ROOT set IN-PROCESS before any server module is imported.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'feed-retry-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let answer = { status: 400, text: 'bad request' };
const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: answer.text } }));
    });
});

// A port with "503" in it. Some are taken or in a Windows excluded range, so
// try a few; every one of them reads as "503" to a substring match.
const PORTS = [35030, 35031, 35032, 25030, 25031, 45030, 45031, 15030, 15031, 55030];
let port = null;
for (const p of PORTS) {
    try {
        await new Promise((ok, no) => { server.once('error', no); server.listen(p, '127.0.0.1', ok); });
        port = p; break;
    } catch { server.removeAllListeners('error'); }
}
if (!port) { console.log('FAIL  no port with "503" in it could be bound'); process.exit(1); }

process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.AI_MODEL = 'stub-model';

const { generateResponse } = await import('../server/ai.js');
const db = (await import('../server/database.js')).default;
db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_enabled', 'true');
const { isTransient } = await import('../server/feedGen.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

async function errorFor(status, text) {
    answer = { status, text };
    try { await generateResponse('hi', '', [], { operation: 'chat' }); return null; }
    catch (e) { return e; }
}

console.log(`\nstub endpoint on port ${port}`);

const refused = await errorFor(400, 'model "x" does not accept this request');
check('the error names the endpoint, port included (the trap is real)',
    !!refused && refused.message.includes(String(port)), refused?.message);
check('a 400 from an endpoint on a "503" port is not transient',
    !!refused && isTransient(refused) === false, refused?.message);

const unauthorised = await errorFor(401, 'invalid key');
check('a 401 from the same endpoint is not transient', !!unauthorised && isTransient(unauthorised) === false, unauthorised?.message);

const bodySays = await errorFor(400, 'upstream said 502 once, but this request is malformed');
check('a 400 whose body mentions 502 is still a refusal', !!bodySays && isTransient(bodySays) === false, bodySays?.message);

const busy = await errorFor(503, 'overloaded, try later');
check('a real 503 from that endpoint is transient', !!busy && isTransient(busy) === true, busy?.message);

const gateway = await errorFor(502, 'bad gateway');
check('a real 502 is transient', !!gateway && isTransient(gateway) === true, gateway?.message);

const limited = await errorFor(400, 'rate limit reached for this key');
check('a refusal that says it is a rate limit is transient (as before)', !!limited && isTransient(limited) === true, limited?.message);

// A dropped connection: the endpoint gone, the address still on a "503" port.
await new Promise(r => server.close(r));
const gone = await errorFor(400, '');
check('nothing listening is transient (a fetch failure)', !!gone && isTransient(gone) === true, gone?.message);

// The shapes with no HTTP status on them, as other callers raise them.
check('a bare "failed (504)" message with no status field is transient', isTransient(new Error('Chat request failed (504)')) === true);
check('a host named api503.example in a timeout-free 404 is not transient',
    isTransient(new Error('GET https://api503.example/v1/models failed (404)')) === false);
const ac = new AbortController(); ac.abort();
check('a cancel is never transient', isTransient(new Error('fetch failed'), ac.signal) === false);

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a held WAL file is fine */ }
process.exit(fail ? 1 : 0);
