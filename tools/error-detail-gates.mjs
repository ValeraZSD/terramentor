// tools/error-detail-gates.mjs — what an error tells the caller.
//
// Run:  node tools/error-detail-gates.mjs
//
// A route that failed used to send the thrown error's own text back:
// `{ error: err.message }`. That text is written for whoever reads the server
// log — a file path under the account's home, a SQL constraint, an upstream
// body — and the desktop app ran without NODE_ENV=production, so the global
// handler added it as `detail` too. `clientError(err, status)`
// (server/clientError.js) decides now:
//
//   1. A message the code wrote for the learner (a 4xx answer, or an error
//      marked `expose`) is sent as written, with any file path in it replaced.
//   2. Anything else on a 5xx — and a system, SQLite or programming error at
//      any status — is a fixed sentence with a reference; the full error goes
//      to the server log under the same reference.
//   3. No route sends an error's raw message any more (a source scan; the
//      typed refusals that are checked with `instanceof` are the exception),
//      the global handler does not either, and the desktop launcher runs the
//      server with NODE_ENV=production.
//   4. On the real app, a learner-facing refusal still reads as it did.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'error-detail-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const B = new URL('../server/', import.meta.url).href;
let clientError = null;
try { ({ clientError } = await import(B + 'clientError.js')); } catch (e) { console.log(`  (server/clientError.js: ${e.code || e.message})`); }

// ── 1–2. the helper ──────────────────────────────────────────────────────────
console.log('\n--- clientError ---');
{
    const logged = [];
    const realError = console.error;
    console.error = (...a) => { logged.push(a.map(x => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' ')); };
    const run = (err, status) => { try { return clientError ? String(clientError(err, status)) : null; } catch (e) { return `threw: ${e.message}`; } };

    const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/home/ana/.local/share/Terramentor/vault/blobs/ab/abc'"), { code: 'ENOENT', errno: -2, syscall: 'open' });
    const a = run(enoent, 500);
    ok('a file-system error says no path', !!a && !a.includes('/home/ana') && !a.includes('ENOENT'), a);
    const ref = (a || '').match(/ref ([0-9a-f]{8})/)?.[1];
    ok('…it carries a reference', !!ref, a);
    ok('…and the server log has the whole error under it', !!ref && logged.some(l => l.includes(ref) && l.includes('/home/ana')), logged.join(' | '));

    const sqlite = Object.assign(new Error('UNIQUE constraint failed: nodes.uuid'), { name: 'SqliteError', code: 'SQLITE_CONSTRAINT_UNIQUE' });
    const b = run(sqlite, 400);
    ok('a SQLite error says nothing about the schema, even on a 4xx', !!b && !b.includes('nodes.uuid'), b);
    const c = run(new TypeError("Cannot read properties of undefined (reading 'id')"), 400);
    ok('a programming error says nothing about the code', !!c && !c.includes('reading'), c);
    const d = run(new Error('Chat request to http://10.0.0.5:8080/v1 failed (500): upstream body'), 500);
    ok('any other error on a 5xx is the fixed sentence', !!d && !d.includes('upstream body') && !d.includes('10.0.0.5'), d);

    ok('a refusal the code wrote, on a 4xx, is sent as written', run(new Error('A capture needs some text, a URL, or a title'), 400) === 'A capture needs some text, a URL, or a title');
    ok('…and an error marked expose, on a 5xx too', run(Object.assign(new Error('The model is not answering'), { expose: true }), 502) === 'The model is not answering');
    const e = run(new Error("Could not read C:\\Users\\ana\\Documents\\notes.pdf or /home/ana/notes.pdf"), 400);
    ok('a file path inside a learner-facing message is replaced', !!e && !e.includes('ana') && e.startsWith('Could not read'), e);
    ok('the default status is 500', !!clientError && !run(new Error('secret detail')).includes('secret detail'));

    // A model endpoint's refusal keeps what the learner can act on — the
    // status and what to change — and loses the address and the body.
    const refused = Object.assign(new Error('Chat request to http://10.0.0.5:8080/v1 failed (401): {"error":"key sk-abc invalid"}'), { httpStatus: 401, endpoint: 'http://10.0.0.5:8080/v1', responseBody: '{"error":"key sk-abc invalid"}' });
    const f = run(refused, 500);
    ok('a model endpoint\'s refusal says its status and what to check', !!f && f.includes('401') && /API key/.test(f), f);
    ok('…without the endpoint\'s address or what it answered', !!f && !f.includes('10.0.0.5') && !f.includes('sk-abc'), f);
    let learnerError = null;
    try { ({ learnerError } = await import(B + 'clientError.js')); } catch { /* reported above */ }
    const g = learnerError ? run(learnerError('No model selected — choose one in Settings → AI & Models'), 500) : null;
    ok('an error written for the learner keeps its words on a 500', g === 'No model selected — choose one in Settings → AI & Models', g);

    // The body parser's refusal of malformed JSON is a SyntaxError, but one it
    // marks `expose` and types `entity.parse.failed`: the client's fault, not
    // a bug in this server, so neither the fixed sentence nor a log entry.
    const parse = Object.assign(new SyntaxError('Unexpected token b in JSON at position 1'), { type: 'entity.parse.failed', expose: true, status: 400, statusCode: 400, body: '{bad' });
    const before = logged.length;
    const h = run(parse, 400);
    ok('malformed JSON is answered as the client\'s fault, with no reference', !!h && !/ref [0-9a-f]{8}|went wrong/.test(h), h);
    ok('…and leaves nothing in the server log', logged.length === before, logged.slice(before).join(' | '));

    // The owner's own endpoint (a model server, SearXNG, a search key): the
    // reason is built from the timeout, the network code or the HTTP status,
    // never from the message, which can name a socket path or quote a body.
    let endpointError = null;
    try { ({ endpointError } = await import(B + 'clientError.js')); } catch { /* reported above */ }
    const said = (who, err) => { try { return endpointError ? endpointError(who, err) : null; } catch (x) { return `threw: ${x.message}`; } };
    const refusedSock = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED /home/ana/.run/llama.sock'), { code: 'ECONNREFUSED', syscall: 'connect', errno: -111 }) });
    const r1 = said('SearXNG', refusedSock);
    ok('an endpoint that refused the connection says so by its code', r1 === 'SearXNG could not connect (ECONNREFUSED)', r1);
    const r2 = said('Tavily', Object.assign(new Error('Tavily declined with 401: {"detail":"key sk-abc"}'), { httpStatus: 401 }));
    ok('…a status by its number, without the body', !!r2 && r2.startsWith('Tavily answered HTTP 401') && !r2.includes('sk-abc'), r2);
    const r3 = said('OpenRouter', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    ok('…a timeout as a timeout', r3 === 'OpenRouter timed out', r3);
    const r4 = said('The endpoint', Object.assign(new Error('No such connection'), { status: 404 }));
    ok('…and a refusal this server wrote keeps its words', r4 === 'No such connection', r4);
    console.error = realError;
}

// ── 3. the source ────────────────────────────────────────────────────────────
console.log('\n--- no route sends an error\'s own text ---');
{
    const dirs = [new URL('../server/', import.meta.url), new URL('../server/routes/', import.meta.url)];
    // `err.message` or `err?.message` anywhere in the value of `error:` or
    // `detail:` (a conditional's branch included), and the same text inside
    // a template literal on a line that answers (an `error:` key, a
    // `.json(`/`.send(`, a typed refusal or learnerError, whose words reach
    // the client as written). A template that only goes to the console is
    // left alone, and so are the internal `reason:` records the quality gates
    // keep (they are stored for the task dock, never sent as a response).
    // A key is an object key (after `{`, `,` or at the start of the line), so
    // a ternary's `json.error : …` is not one.
    const KEY = String.raw`(?:^|[{,])\s*(?:error|detail)\s*:`;
    const RAW_VALUE = new RegExp(`${KEY}[^,}]*?\\b(e|err|error)\\??\\.message\\b`);
    const RAW_TEMPLATE = /\$\{[^}]*\b(e|err|error)\??\.message\b/;
    const ANSWERS = new RegExp(`${KEY}|\\.(json|send)\\(|new\\s+(BundleRefusal|ImportError|StudyTimeError|EditError)\\(|learnerError\\(`);
    const RAW = { test: (line) => !/^\s*(\/\/|\*)|console\.(log|warn|error|info)\(/.test(line)
        && (RAW_VALUE.test(line) || (RAW_TEMPLATE.test(line) && ANSWERS.test(line))) };
    // Named, not skipped: server/routes/settings.js is being rewritten in a
    // change of its own, which carries this line; it is listed so the scan
    // keeps saying it is there until that change lands.
    const PENDING = ['settings.js'];
    // Lines that carry an error's text somewhere other than a response, each
    // with where it goes. Matched on the line's text, so a new line in the
    // same file is still scanned.
    const ELSEWHERE = [
        // A reply between processes or threads. The parent rebuilds the error
        // (code and class included) and answers through clientError, or files
        // it as a task's failure record.
        { file: 'isolatedProcess.js', line: /reply = \{ error: String\(err/ },
        { file: 'fsrsOptimizerWorker.js', line: /parentPort\.postMessage\(\{ error:/ },
        // The ChatGPT adapter re-encodes ChatGPT's own answer as an
        // OpenAI-style reply for ai.js, which reads it like any provider's
        // and says it through clientError; it never answers a request itself.
        { file: 'chatgptWire.js', line: /error: \{ (code: status, )?message: / },
        // A widget build's own failure (the spec the model wrote did not
        // compile), kept so the card can say why; the same text the shared
        // build-failure record keeps.
        { file: 'feedGen.js', line: /meta\.widget = \{ failed: true, error:/ },
        // The update check; server/version.js belongs to the updater's change.
        { file: 'version.js', line: /e\.name === 'AbortError' \? 'Timed out'/ },
    ];
    const hits = [];
    const pending = [];
    for (const dir of dirs) {
        for (const f of readdirSync(dir).filter(n => n.endsWith('.js'))) {
            readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((line, i) => {
                if (!RAW.test(line)) return;
                if (ELSEWHERE.some(x => x.file === f && x.line.test(line))) return;
                // A typed refusal, checked by class on the same line: its
                // message is the refusal, written for the learner.
                if (/instanceof\s+(ImportError|BundleRefusal|StudyTimeError|EditError)\b/.test(line)) return;
                // The visual-feedback record is a local file, not a response.
                if (/recordVisualOutcome\(/.test(line)) return;
                (PENDING.includes(f) && dir.href.endsWith('/routes/') ? pending : hits).push(`${f}:${i + 1}`);
            });
        }
    }
    ok('no response carries err.message', hits.length === 0, `${hits.length}: ${hits.slice(0, 40).join(', ')}${hits.length > 40 ? ', …' : ''}`);
    if (pending.length) console.log(`  note  still to change in its own branch: ${pending.join(', ')}`);

    const app = readFileSync(new URL('../server/app.js', import.meta.url), 'utf8');
    const handler = app.slice(app.indexOf('app.use((err, req, res, next)'), app.indexOf('const tailMiddleware'));
    ok('the global error handler sends no raw message on a 500', handler.length > 0 && !/detail:[^\n]*err\.message/.test(handler) && /clientError\(/.test(handler), handler.slice(0, 80));

    const launcher = readFileSync(new URL('../desktop/launcher.js', import.meta.url), 'utf8');
    const at = launcher.search(/process\.env\.NODE_ENV\s*(\?\?|\|\|)?=\s*(process\.env\.NODE_ENV\s*\|\|\s*)?['"]production['"]/);
    const serverImport = launcher.search(/import\(pathToFileURL\(join\(appRoot, 'server', 'index\.js'\)\)/);
    ok('the desktop launcher runs the server with NODE_ENV=production', at > 0 && at < serverImport);
}

// ── 4. on the real app ───────────────────────────────────────────────────────
console.log('\n--- on the real app ---');
{
    const { default: db } = await import(B + 'database.js');
    const { createApp } = await import(B + 'app.js');
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;
    const call = (path, body, raw = false) => new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', c => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: json }); });
        });
        req.on('error', reject);
        req.write(raw ? body : JSON.stringify(body));
        req.end();
    });
    const empty = await call('/api/capture', {});
    ok('an empty capture is still refused in the learner\'s words', empty.status === 400 && empty.body?.error === 'A capture needs some text, a URL, or a title', JSON.stringify(empty.body));

    const logged = [];
    const realError = console.error;
    console.error = (...a) => { logged.push(a.map(String).join(' ')); };
    const bad = await call('/api/capture', '{bad', true);
    console.error = realError;
    ok('a malformed JSON body is a 400 that says so, with no reference', bad.status === 400 && /invalid json/i.test(bad.body?.error || '') && !/ref [0-9a-f]{8}/.test(bad.body?.error || ''), `${bad.status} ${JSON.stringify(bad.body)}`);
    ok('…and writes no stack to the server log', !logged.some(l => /\n\s+at /.test(l) || /ref [0-9a-f]{8}/.test(l)), logged.join(' | ').slice(0, 200));
    server.close();
    try { db.close(); } catch { /* closing a closed handle */ }
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
