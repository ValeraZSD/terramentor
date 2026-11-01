// tools/mcp-gates.mjs — the MCP server (mcp/), driven over its real wire.
//
// Run:  node tools/mcp-gates.mjs
//
// createApp() on a loopback port against a scratch library (DB_PATH, VAULT_ROOT
// and DATA_DIR set in-process), with a password, an API key and a provider key
// in its credentials file. The MCP server is started the way a harness starts
// it — `node mcp/index.js` as a child speaking JSON-RPC on stdin/stdout — and
// again as a Streamable HTTP listener, and every tool it lists is called.
//
//   1. The tool list is exactly the v1 set, each one marked read-only or not as
//      what it does: a new tool fails here until it is classified.
//   2. Every tool answers from the library, and topic_material leaves out the
//      learner's private notes.
//   3. No credential reaches a result: not the API key, the password, its hash,
//      the session secret or the provider key — in any answer or any error.
//   4. Nothing a tool writes can clear the mastery gate. A claim (an answer the
//      harness graded itself) never raises an estimate, never writes a
//      mastery_evidence row, and is never counted by checkMasteryEligibility;
//      a wrong one may lower it. The same attempt id twice is one claim.
//   5. Without the key a password-locked app answers nothing, and the HTTP
//      listener holds no key of its own: it forwards the caller's.
//   6. The HTTP listener answers loopback only: another Host, a foreign Origin
//      or a relayed client is refused, it binds no other address, and it will
//      not start on one.
//   7. Nothing under mcp/ imports the server: one process opens the library.

import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(repoRoot, 'mcp', 'index.js');

const scratch = mkdtempSync(join(tmpdir(), 'mcp-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';
delete process.env.AUTH_ALLOW_OPEN_REMOTE;

const B = new URL('../server/', import.meta.url).href;
const { default: db, DB_PATH } = await import(B + 'database.js');
const { createApp } = await import(B + 'app.js');
const auth = await import(B + 'auth.js');
const secrets = await import(B + 'secrets.js');
const mastery = await import(B + 'mastery.js');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

if (!DB_PATH.startsWith(scratch)) { console.error(`refusing: the library is ${DB_PATH}, not the scratch one`); process.exit(2); }

// ---------------------------------------------------------------------------
// The library: one course, two topics and a section, a lesson, private notes,
// cards, and real evidence on one topic.
const PROJECT = 'Wave physics for the gate';
const NOTES_CANARY = 'PRIVATE-NOTE-CANARY-7f3a';
const OVERVIEW = 'A wave carries energy without carrying matter; its speed is frequency times wavelength.';
const pid = Number(db.prepare("INSERT INTO projects (name, color) VALUES (?, '#0369a1')").run(PROJECT).lastInsertRowid);
const addNode = (title, parent, extra = {}) => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, description, notes, is_note, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
).run(pid, parent, title, extra.description || '', extra.notes || '', extra.is_note || 0, extra.position || 0).lastInsertRowid);
const section = addNode('Mechanical waves', null);
const fresh = addNode('Wave speed', section, { description: OVERVIEW, notes: `I keep mixing this up. ${NOTES_CANARY}`, position: 0 });
const studied = addNode('Doppler effect', section, { position: 1 });
// A head start from placement: 0.6 borrowed, nothing measured.
const seeded = addNode('Interference', section, { position: 2 });
const material = addNode('Worked example', fresh, { description: 'v = f * lambda = 440 * 0.78 = 343 m/s', is_note: 1 });
db.prepare("INSERT INTO flashcards (node_id, front, back, next_review) VALUES (?, 'v = ?', 'f * lambda', ?)")
    .run(fresh, new Date(Date.now() - 3600_000).toISOString());
// Real evidence on the second topic: a 3/4 quiz, below the 0.8 raw pass.
mastery.updateMasteryFromAttempt(studied, 3, 4, 'quiz');
mastery.applySeededPrior(seeded, 'placement', 0.6);

// Credentials: a password (so the app answers nothing without one), its API
// key, and a provider key — none of which may come back through a tool.
const PASSWORD = 'gate-password-canary-9q';
await auth.setPassword(PASSWORD);
const API_KEY = auth.regenerateApiKey();
const PROVIDER_KEY = 'sk-or-v1-PROVIDER-CANARY-0123456789abcdef';
secrets.setSecret('ai_openai_api_key', PROVIDER_KEY);
const SECRET_STRINGS = () => [API_KEY, PASSWORD, PROVIDER_KEY,
    secrets.getSecret('auth_password_hash'), secrets.getSecret('auth_session_secret')].filter(Boolean);

const server = createApp().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const appUrl = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// A harness's view: the child's environment is this one minus anything the
// adapter reads, plus what its config would set.
const childEnv = (extra) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('TERRAMENTOR_')) delete env[k];
    return { ...env, ...extra };
};

const children = new Set();

/** `node mcp/index.js` on stdio, as Claude Code or Claude Desktop launches it. */
function stdioServer(env) {
    const child = spawn(process.execPath, [ENTRY], { env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    let buf = '', stderr = '', exited = null, nextId = 1;
    const waiting = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id).resolve(msg); waiting.delete(msg.id); }
        }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => {
        exited = code;
        for (const w of waiting.values()) w.reject(new Error(`the MCP server exited (${code}): ${stderr.slice(-400)}`));
        waiting.clear();
    });
    const send = (msg) => { if (exited === null) child.stdin.write(`${JSON.stringify(msg)}\n`); };
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
        if (exited !== null) return reject(new Error(`the MCP server exited (${exited}): ${stderr.slice(-400)}`));
        const id = nextId++;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out; stderr: ${stderr.slice(-400)}`)); }, 20_000);
        waiting.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        send({ jsonrpc: '2.0', id, method, params });
    });
    return {
        child, rpc,
        notify: (method, params = {}) => send({ jsonrpc: '2.0', method, params }),
        stderr: () => stderr,
        close: () => { try { child.kill(); } catch { /* gone */ } children.delete(child); },
    };
}

const CLIENT = { name: 'mcp-gates', version: '1.0.0' };
async function handshake(s) {
    const init = await s.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT });
    s.notify('notifications/initialized');
    return init;
}

/** Text of a tools/call answer, and whether it is an error. */
const textOf = (msg) => (msg?.result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const isErr = (msg) => !!(msg?.error || msg?.result?.isError);

// Every byte any server sent back, for the credential sweep at the end.
const seen = [];
const record = (msg) => { seen.push(JSON.stringify(msg)); return msg; };

function done() {
    for (const c of children) { try { c.kill(); } catch { /* gone */ } }
    server.close();
    try { db.close(); } catch { /* closing a closed handle */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------------------
console.log('--- the server starts and lists the v1 tools ---');
const READ_TOOLS = ['project_state', 'find_in_library', 'get_due', 'topic_material', 'get_mastery'];
const PROPOSE_TOOLS = ['add_capture', 'record_claim'];

ok('mcp/index.js exists', existsSync(ENTRY), ENTRY);
if (!existsSync(ENTRY)) done();

const main = stdioServer({ TERRAMENTOR_URL: appUrl, TERRAMENTOR_API_KEY: API_KEY });
let tools = [];
try {
    const init = record(await handshake(main));
    ok('initialize answers with the server\'s name', init?.result?.serverInfo?.name === 'terramentor', JSON.stringify(init).slice(0, 300));
    const list = record(await main.rpc('tools/list'));
    tools = list?.result?.tools || [];
} catch (e) {
    ok('the stdio server answers initialize and tools/list', false, e.message);
    done();
}
const names = tools.map(t => t.name).sort();
ok('the tools are exactly the v1 set', JSON.stringify(names) === JSON.stringify([...READ_TOOLS, ...PROPOSE_TOOLS].sort()), names.join(', '));
for (const t of tools) {
    const readOnly = READ_TOOLS.includes(t.name);
    ok(`${t.name} is marked ${readOnly ? 'read-only' : 'as a write'}`, t.annotations?.readOnlyHint === readOnly);
    ok(`${t.name} says what it is for and takes an object`, String(t.description || '').length > 40 && t.inputSchema?.type === 'object');
}

// ---------------------------------------------------------------------------
console.log('\n--- every tool answers from the library ---');
const call = async (name, args = {}, s = main) => record(await s.rpc('tools/call', { name, arguments: args }));
const evidenceRows = () => db.prepare('SELECT COUNT(*) AS n FROM mastery_evidence').get().n;
const scoreOf = (id) => db.prepare('SELECT mastery_score FROM node_mastery WHERE node_id = ?').get(id)?.mastery_score ?? 0;
const evidenceBefore = evidenceRows();

{
    const list = await call('project_state');
    ok('project_state with no project lists the projects', !isErr(list) && textOf(list).includes(PROJECT) && textOf(list).includes(String(pid)), textOf(list).slice(0, 200));
    const one = await call('project_state', { project: 'wave physics' });
    ok('project_state by name reads that project, its topics and their ids',
        !isErr(one) && textOf(one).includes('Wave speed') && textOf(one).includes(String(fresh)) && textOf(one).includes('Doppler effect'), textOf(one).slice(0, 300));
    ok('…without the in-app assistant\'s marker instructions', !/\[\[(open|check)/.test(textOf(one)));
    const none = await call('project_state', { project: 'astrophysics of nothing' });
    ok('project_state for no such project says so and lists what exists', !isErr(none) && /no project/i.test(textOf(none)) && textOf(none).includes(PROJECT), textOf(none).slice(0, 200));

    const found = await call('find_in_library', { query: 'doppler' });
    ok('find_in_library finds a topic with its ids', !isErr(found) && textOf(found).includes('Doppler effect') && textOf(found).includes(String(studied)), textOf(found).slice(0, 300));
    const nothing = await call('find_in_library', { query: 'zzqxv' });
    ok('find_in_library says plainly when nothing matches', !isErr(nothing) && /nothing|no match/i.test(textOf(nothing)), textOf(nothing).slice(0, 200));

    const due = await call('get_due');
    ok('get_due answers with today\'s date and the due card', !isErr(due) && /\d{4}-\d{2}-\d{2}/.test(textOf(due)) && textOf(due).includes(PROJECT), textOf(due).slice(0, 300));

    const topic = await call('topic_material', { topic: String(fresh) });
    ok('topic_material reads the Overview and the Material', !isErr(topic) && textOf(topic).includes(OVERVIEW) && textOf(topic).includes('343 m/s'), textOf(topic).slice(0, 300));
    ok('…and never the learner\'s private notes', !textOf(topic).includes(NOTES_CANARY));
    const byTitle = await call('topic_material', { topic: 'Wave speed' });
    ok('topic_material finds a topic by title too', !isErr(byTitle) && textOf(byTitle).includes(OVERVIEW));
    // Models (and the Inspector CLI) send an id as a NUMBER: 3, not "3".
    const byNumber = await call('topic_material', { topic: fresh });
    const masteryByNumber = await call('get_mastery', { topic: studied });
    ok('a topic id sent as a number is read the same', !isErr(byNumber) && textOf(byNumber).includes(OVERVIEW) && !isErr(masteryByNumber),
        `${textOf(byNumber).slice(0, 120)} | ${textOf(masteryByNumber).slice(0, 120)}`);
    const noTopic = await call('topic_material', { topic: 'no such topic anywhere' });
    ok('topic_material on no such topic says so', isErr(noTopic) && /no topic/i.test(textOf(noTopic)), textOf(noTopic).slice(0, 200));

    // The app's own eligibility check CREATES the topic's mastery row; a read
    // tool must not, or merely asking about a topic writes to the library.
    const rowsOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM node_mastery WHERE node_id = ?').get(id).n;
    const hadRow = rowsOf(fresh);
    const unread = await call('get_mastery', { topic: String(fresh) });
    ok('get_mastery on a topic never studied writes no mastery row', hadRow === 0 && rowsOf(fresh) === 0 && !isErr(unread),
        `rows ${hadRow} → ${rowsOf(fresh)}; ${textOf(unread).slice(0, 120)}`);

    const m = await call('get_mastery', { topic: String(studied) });
    ok('get_mastery gives the estimate and the gate\'s answer', !isErr(m) && /\d+%/.test(textOf(m)) && /gate|check|proven|eligible/i.test(textOf(m)), textOf(m).slice(0, 300));
    ok('get_mastery returns structured content', typeof m?.result?.structuredContent?.mastery === 'number' && typeof m?.result?.structuredContent?.passed === 'boolean', JSON.stringify(m?.result?.structuredContent || null));

    const cap = await call('add_capture', { text: 'Ask about standing waves in a closed pipe' });
    const inbox = db.prepare("SELECT n.id FROM nodes n JOIN projects p ON p.id = n.project_id WHERE n.title LIKE '%standing waves%'").all();
    ok('add_capture puts a note in the Inbox', !isErr(cap) && inbox.length === 1, textOf(cap).slice(0, 200));
    const again = await call('add_capture', { text: 'Ask about standing waves in a closed pipe' });
    const inboxAgain = db.prepare("SELECT n.id FROM nodes n WHERE n.title LIKE '%standing waves%'").all();
    ok('…and the same note twice is one capture', !isErr(again) && inboxAgain.length === 1);
}

// ---------------------------------------------------------------------------
console.log('\n--- a claim cannot clear the gate ---');
{
    const gate = (id) => mastery.checkMasteryEligibility(id, 0.85, 0.8);
    const freshBefore = scoreOf(fresh);
    const studiedBefore = scoreOf(studied);
    ok('the studied topic is not past the gate to begin with', !gate(studied).eligible);

    let allOk = true;
    for (let i = 0; i < 25; i++) {
        const r = await call('record_claim', { topic: String(fresh), correct: true, question_type: 'short_answer' });
        const r2 = await call('record_claim', { topic: String(studied), correct: true, question_type: 'multiple_choice' });
        allOk = allOk && !isErr(r) && !isErr(r2);
    }
    ok('25 right answers claimed on each topic are recorded', allOk
        && db.prepare('SELECT COUNT(*) AS n FROM mastery_claims WHERE node_id IN (?, ?) AND correct = 1').get(fresh, studied).n === 50);
    ok('…raise neither estimate', scoreOf(fresh) <= freshBefore && scoreOf(studied) <= studiedBefore, `${freshBefore}→${scoreOf(fresh)}, ${studiedBefore}→${scoreOf(studied)}`);
    ok('…clear neither topic\'s gate', !gate(fresh).eligible && !gate(studied).eligible);
    ok('…and write no mastery_evidence row', evidenceRows() === evidenceBefore, `${evidenceBefore} → ${evidenceRows()}`);
    ok('…nor count as the topic\'s own answers', gate(fresh).own_answers === 0 && gate(fresh).evidence_count === 0);

    // A lower threshold must not let them through either.
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mastery_threshold', '0.3')").run();
    await call('record_claim', { topic: String(fresh), correct: true });
    ok('…even with the threshold set to 0.3', !mastery.checkMasteryEligibility(fresh, 0.3, 0.8).eligible && scoreOf(fresh) <= freshBefore);
    db.prepare("DELETE FROM settings WHERE key = 'mastery_threshold'").run();

    const wrong = await call('record_claim', { topic: String(studied), correct: false });
    ok('a wrong claim may lower an estimate', !isErr(wrong) && scoreOf(studied) < studiedBefore, `${studiedBefore} → ${scoreOf(studied)}`);
    ok('…and says it was recorded as a claim, not as evidence', /claim/i.test(textOf(wrong)) && !/proven|passed the gate/i.test(textOf(wrong)), textOf(wrong).slice(0, 200));

    // A seed is withdrawn only by an answer the app received: wrong claims may
    // not push a head start below its seed.
    const seedBefore = scoreOf(seeded);
    for (let i = 0; i < 5; i++) await call('record_claim', { topic: String(seeded), correct: false, attempt_id: `seed-${i}` });
    ok('wrong claims never take a topic below its head start', seedBefore === 0.6 && scoreOf(seeded) >= 0.6,
        `${seedBefore} → ${scoreOf(seeded)}`);

    const count = () => db.prepare('SELECT COUNT(*) AS n FROM mastery_claims').get().n;
    const before = count();
    await call('record_claim', { topic: String(fresh), correct: false, attempt_id: 'same-attempt-1' });
    const lowered = scoreOf(fresh);
    await call('record_claim', { topic: String(fresh), correct: false, attempt_id: 'same-attempt-1' });
    ok('the same attempt id twice is one claim', count() === before + 1 && scoreOf(fresh) === lowered, `${before} → ${count()}`);

    const notTopic = await call('record_claim', { topic: String(section), correct: true });
    const onNote = await call('record_claim', { topic: String(material), correct: true });
    ok('a claim on a section or a piece of Material is refused', isErr(notTopic) && isErr(onNote) && count() === before + 1);
    const noSuch = await call('record_claim', { topic: '987654', correct: true });
    ok('a claim on a topic that does not exist is refused', isErr(noSuch) && count() === before + 1);
    const noBool = await call('record_claim', { topic: String(fresh), correct: 'yes' });
    ok('a claim without a true/false answer is refused', isErr(noBool) && count() === before + 1);

    const m = await call('get_mastery', { topic: String(fresh) });
    ok('get_mastery counts the claims apart from the evidence', /claim/i.test(textOf(m)) && m?.result?.structuredContent?.claims?.total >= 27, JSON.stringify(m?.result?.structuredContent?.claims || null));
}

// ---------------------------------------------------------------------------
console.log('\n--- the key: none without it, and the HTTP listener holds none ---');
{
    const keyless = stdioServer({ TERRAMENTOR_URL: appUrl });
    await handshake(keyless);
    const r = record(await keyless.rpc('tools/call', { name: 'project_state', arguments: {} }));
    ok('without the key a locked app answers nothing', isErr(r) && !textOf(r).includes(PROJECT), textOf(r).slice(0, 200));
    ok('…and the error says which setting is missing', /TERRAMENTOR_API_KEY/.test(textOf(r)));
    keyless.close();

    const wrongKey = stdioServer({ TERRAMENTOR_URL: appUrl, TERRAMENTOR_API_KEY: 'sk_wrong' });
    await handshake(wrongKey);
    const w = record(await wrongKey.rpc('tools/call', { name: 'get_due', arguments: {} }));
    ok('a wrong key answers nothing either', isErr(w) && !textOf(w).includes(PROJECT));
    wrongKey.close();

    const down = stdioServer({ TERRAMENTOR_URL: 'http://127.0.0.1:9', TERRAMENTOR_API_KEY: API_KEY });
    await handshake(down);
    const d = record(await down.rpc('tools/call', { name: 'get_due', arguments: {} }));
    ok('with the app not running, a tool says so and where it looked', isErr(d) && /not running|could not reach/i.test(textOf(d)) && textOf(d).includes('127.0.0.1:9'), textOf(d).slice(0, 200));
    down.close();
}

// ---------------------------------------------------------------------------
console.log('\n--- the HTTP listener answers loopback only ---');

/** `node mcp/index.js --http --port 0`; resolves with the port it printed. */
function httpServer(env, args = []) {
    const child = spawn(process.execPath, [ENTRY, '--http', '--port', '0', ...args], { env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    let out = '';
    return new Promise((resolveStart) => {
        const timer = setTimeout(() => resolveStart({ child, port: null, out }), 15_000);
        const onData = (d) => {
            out += d;
            const m = /http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(out);
            if (m) { clearTimeout(timer); resolveStart({ child, port: Number(m[1]), out }); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => { clearTimeout(timer); resolveStart({ child, port: null, out, code }); });
    });
}

/** One JSON-RPC POST to /mcp; SSE or JSON, read either way. */
function post(port, body, headers = {}) {
    const data = JSON.stringify(body);
    return new Promise((resolveReq) => {
        const req = request({
            host: '127.0.0.1', port, path: '/mcp', method: 'POST',
            headers: {
                Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                'MCP-Protocol-Version': '2025-11-25', 'Content-Length': Buffer.byteLength(data), ...headers,
            },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', c => { text += c; });
            res.on('end', () => {
                let json = null;
                const sse = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).pop();
                try { json = JSON.parse(sse ?? text); } catch { /* not JSON */ }
                seen.push(text);
                resolveReq({ status: res.statusCode, json, text });
            });
        });
        req.on('error', (e) => resolveReq({ status: 0, error: e.message }));
        req.end(data);
    });
}

{
    // The key is in the listener's environment on purpose: it must not use it.
    const h = await httpServer({ TERRAMENTOR_URL: appUrl, TERRAMENTOR_API_KEY: API_KEY });
    ok('the HTTP listener starts on loopback and says where', !!h.port, h.out.slice(-300));
    if (h.port) {
        const bearer = { Authorization: `Bearer ${API_KEY}` };
        const init = await post(h.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT } }, bearer);
        ok('initialize over HTTP', init.status === 200 && init.json?.result?.serverInfo?.name === 'terramentor', `${init.status} ${init.text?.slice(0, 200)}`);
        const list = await post(h.port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, bearer);
        ok('tools/list over HTTP is the same set', JSON.stringify((list.json?.result?.tools || []).map(t => t.name).sort()) === JSON.stringify(names), `${list.status} ${list.text?.slice(0, 200)}`);
        const withKey = await post(h.port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_state', arguments: {} } }, bearer);
        ok('a call carrying the key reads the library', withKey.status === 200 && !isErr(withKey.json) && textOf(withKey.json).includes(PROJECT), withKey.text?.slice(0, 200));
        const noKey = await post(h.port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'project_state', arguments: {} } });
        ok('a call without it reads nothing, though the listener was started with the key', !textOf(noKey.json).includes(PROJECT) && (noKey.status !== 200 || isErr(noKey.json)), noKey.text?.slice(0, 200));

        const evilHost = await post(h.port, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { ...bearer, Host: 'evil.example' });
        ok('another Host is refused (DNS rebinding)', evilHost.status === 403, String(evilHost.status));
        const evilOrigin = await post(h.port, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, { ...bearer, Origin: 'http://evil.example' });
        ok('a foreign Origin is refused', evilOrigin.status === 403, String(evilOrigin.status));
        const relayed = await post(h.port, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'project_state', arguments: {} } }, { ...bearer, 'X-Forwarded-For': '203.0.113.5' });
        ok('a client relayed from elsewhere is refused', relayed.status === 403 && !relayed.text.includes(PROJECT), String(relayed.status));

        // Not listening anywhere but loopback: this machine's other addresses refuse the connection.
        const other = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
        if (other) {
            const refused = await new Promise((r) => {
                const sock = connect({ host: other, port: h.port });
                sock.setTimeout(3000, () => { sock.destroy(); r('timeout'); });
                sock.on('connect', () => { sock.destroy(); r('connected'); });
                sock.on('error', (e) => r(e.code));
            });
            ok(`nothing answers on this machine's other address (${other})`, refused !== 'connected', String(refused));
        } else {
            ok('(no non-loopback address on this machine: the bind is checked below)', true);
        }
        h.child.kill();
        children.delete(h.child);
    }

    const wide = await httpServer({ TERRAMENTOR_URL: appUrl }, ['--host', '0.0.0.0']);
    ok('the HTTP listener refuses to start on a non-loopback address', !wide.port && wide.code !== null && /loopback/i.test(wide.out), wide.out.slice(-200));
}

// ---------------------------------------------------------------------------
console.log('\n--- no credential in anything any server sent ---');
{
    const all = seen.join('\n');
    for (const s of SECRET_STRINGS()) {
        ok(`no ${s.slice(0, 6)}… anywhere in ${seen.length} answers`, !all.includes(s));
    }
}

// ---------------------------------------------------------------------------
console.log('\n--- one process opens the library ---');
{
    const mcpDir = join(repoRoot, 'mcp');
    const serverDir = join(repoRoot, 'server');
    const files = readdirSync(mcpDir).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
    // Relative specifiers only: `@modelcontextprotocol/server` is a package, not our server.
    const importsServer = files.filter((f) => [...readFileSync(join(mcpDir, f), 'utf8')
        .matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.[^'"]+)['"]/gm)]
        .some(([, spec]) => resolve(mcpDir, spec).startsWith(serverDir)));
    ok('nothing under mcp/ imports the server (it would open the library a second time)', files.length > 0 && importsServer.length === 0, importsServer.join(', '));
}

main.close();
done();
