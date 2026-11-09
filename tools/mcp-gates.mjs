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
//   2. Every tool answers from the library, and the learner's private notes
//      are neither read (topic_material) nor searched (find_in_library).
//   3. No credential reaches a result: not the API key, the password, its hash,
//      the session secret or the provider key — in any answer or any error.
//   4. Nothing a tool writes can clear the mastery gate. A claim (an answer the
//      harness graded itself) never raises an estimate, never writes a
//      mastery_evidence row, and is never counted by checkMasteryEligibility;
//      a wrong one may lower it, once until the app records an answer of its
//      own on that topic or rebuilds the estimate from its own answers, and
//      never under a head start that still stands. The same attempt id twice
//      is one claim, and its retry does not repeat the first outcome; the same
//      id for another answer is refused.
//   5. A wrong claim does not take a topic off fading recall: a topic proven
//      over 0.5 and left alone stays on the plan's list, Today's and the
//      recall cards, one at 0.45 stays off, and once the app's own answers or
//      a rebuild move the estimate the topic follows its real score. Both
//      lists read one definition and agree at every step.
//   6. Without the key a password-locked app answers nothing, and the HTTP
//      listener holds no key of its own: it forwards the caller's. A redirect
//      from the app is not followed, and an unusable TERRAMENTOR_URL is
//      refused before any request, without repeating what it holds.
//   7. The HTTP listener answers loopback only: another Host, an Origin other
//      than its own (another localhost port included) or a relayed client is
//      refused, it binds no other address, it will not start on one, a path
//      it cannot parse does not take it down, and its startup line prints no
//      credential from TERRAMENTOR_URL.
//   8. Nothing under mcp/ imports the server: one process opens the library.
//   9. A library made before `mastery_claims.evidence_mark` gains the column.
//  10. The views: a host that draws MCP App views gets a mastery check and a
//      card review in its own window; one that does not gets a link to the
//      topic and no sitting. The view tools are listed to the view alone, each
//      view is one document under a CSP of hashes with no network, takes the
//      host's colours a fill and its text together or not at all, and no key
//      or explanation leaves the server before the check is submitted. The
//      check is drawn, graded and written by the app (one evidence row per
//      sitting, a second submit or one racing the grading writes nothing and
//      asks the checker nothing), a failed check completes nothing, a card is
//      rated only after its answer is shown and once per presentation, Undo
//      restores every field the rating wrote, and a rating in the view
//      writes exactly the evidence the same rating writes in the app: card
//      evidence, never an assessment.

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

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
const { buildTodayData } = await import(B + 'today.js');
const { getGhostQuestions } = await import(B + 'dailyPlan.js');
const { appOrigin, appClient, AppError, AppTimeout } = await import(new URL('../mcp/app.js', import.meta.url).href);

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

if (!DB_PATH.startsWith(scratch)) { console.error(`refusing: the library is ${DB_PATH}, not the scratch one`); process.exit(2); }

/**
 * Run a view in jsdom as its host would: answer its ui/initialize with these
 * theme variables in a dark host context, then send `changed` (if given) as
 * a host-context change. Returns the colour variables the view set on its
 * root, and with `changed` also the ones it had set `before` it.
 */
async function hostColours(html, vars, changed, { foreign = false } = {}) {
    const NAMES = ['--color-background-primary', '--color-text-primary', '--color-background-inverse', '--color-text-inverse'];
    const sent = [];
    const { window } = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(w) {
            w.postMessage = (msg) => { sent.push(msg); };
            w.ResizeObserver = class { observe() {} disconnect() {} };
        },
    });
    const read = () => Object.fromEntries(NAMES.map(n => [n, window.document.documentElement.style.getPropertyValue(n)]));
    const reply = (data) => window.dispatchEvent(new window.MessageEvent('message', { data, source: window }));
    const until = async (test) => { for (let i = 0; i < 200 && !test(); i++) await new Promise(r => setTimeout(r, 10)); return test(); };
    try {
        await until(() => sent.some(m => m.method === 'ui/initialize'));
        const init = sent.find(m => m.method === 'ui/initialize');
        if (!init) return { error: 'the view never asked for ui/initialize' };
        reply({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: init.params.protocolVersion, hostContext: { theme: 'dark', styles: { variables: vars } } } });
        if (!await until(() => sent.some(m => m.method === 'ui/notifications/initialized'))) return { error: 'no initialized notification' };
        if (!changed) return read();
        const before = read();
        const change = { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { styles: { variables: changed } } };
        // `foreign`: the same message from a window that is not the host.
        if (foreign) window.dispatchEvent(new window.MessageEvent('message', { data: change, source: null }));
        else reply(change);
        return { ...read(), before };
    } finally {
        window.close();
    }
}

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
// Due since a fixed day in the past: the gate reads no clock.
db.prepare("INSERT INTO flashcards (node_id, front, back, next_review) VALUES (?, 'v = ?', 'f * lambda', ?)")
    .run(fresh, '2026-01-05T09:00:00.000Z');
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
// Open a check or a review the learner takes in the host's window; plain text where a host draws no views.
const VIEW_TOOLS = ['mastery_check', 'review_cards'];
// What the views call: listed only to a host that draws views, and to the view alone.
const APP_TOOLS = ['check_questions', 'check_submit', 'check_complete', 'review_next', 'review_reveal', 'review_rate', 'review_undo'];

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
ok('the tools are exactly the v1 set and the two view tools', JSON.stringify(names) === JSON.stringify([...READ_TOOLS, ...PROPOSE_TOOLS, ...VIEW_TOOLS].sort()), names.join(', '));
for (const t of tools) {
    const readOnly = READ_TOOLS.includes(t.name);
    ok(`${t.name} is marked ${readOnly ? 'read-only' : 'as a write'}`, t.annotations?.readOnlyHint === readOnly);
    ok(`${t.name} says what it is for and takes an object`, String(t.description || '').length > 40 && t.inputSchema?.type === 'object');
}
// A capture with a link is saved again on every call (server/routes/capture.js
// dedupes link-less text only), so the tool may not tell a harness a retry is free.
ok('add_capture is not marked idempotent', tools.find(t => t.name === 'add_capture')?.annotations?.idempotentHint !== true);

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
    // "mixing" is in the private notes of "Wave speed" and nowhere else: a hit
    // on it would tell the agent what the notes say, snippet or not. (The
    // "nothing matches" answer echoes the query, so the canary's own query is
    // judged by its hits, not by the canary's absence.)
    const inNotes = await call('find_in_library', { query: 'mixing' });
    const canary = await call('find_in_library', { query: NOTES_CANARY });
    ok('find_in_library does not search the learner\'s private notes',
        !isErr(inNotes) && /nothing|no match/i.test(textOf(inNotes)) && !textOf(inNotes).includes('Wave speed')
        && /nothing|no match/i.test(textOf(canary)) && !textOf(canary).includes('Wave speed'),
        `${textOf(inNotes).slice(0, 160)} | ${textOf(canary).slice(0, 160)}`);
    const byTitleWord = await call('find_in_library', { query: 'wave speed' });
    ok('…nor shows them on a topic it finds by its title', textOf(byTitleWord).includes('Wave speed') && !textOf(byTitleWord).includes(NOTES_CANARY),
        textOf(byTitleWord).slice(0, 200));

    const due = await call('get_due');
    const dueProject = (due?.result?.structuredContent?.projects || []).find(p => p.projectId === pid);
    ok('get_due answers with today\'s date and the due card', !isErr(due) && /\d{4}-\d{2}-\d{2}/.test(textOf(due)) && textOf(due).includes(PROJECT)
        && due?.result?.structuredContent?.totals?.dueFlashcards === 1 && dueProject?.dueFlashcards === 1,
        `${JSON.stringify(due?.result?.structuredContent?.totals || null)} ${textOf(due).slice(0, 200)}`);

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
    ok('…and the same note twice is one capture, which the answer says', !isErr(again) && inboxAgain.length === 1
        && cap?.result?.structuredContent?.existed === false && again?.result?.structuredContent?.existed === true,
        `${JSON.stringify(cap?.result?.structuredContent || null)} → ${JSON.stringify(again?.result?.structuredContent || null)}`);
    const nodesNow = () => db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
    const nodesBeforeLink = nodesNow();
    const script = await call('add_capture', { text: 'a link', url: 'javascript:alert(1)' });
    ok('add_capture refuses a link that is not http(s)', isErr(script) && nodesNow() === nodesBeforeLink, textOf(script).slice(0, 200));
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

    const effectOf = (msg) => msg?.result?.structuredContent?.effect;
    const wrong = await call('record_claim', { topic: String(studied), correct: false });
    ok('a wrong claim may lower an estimate', !isErr(wrong) && scoreOf(studied) < studiedBefore && effectOf(wrong) === 'lowered',
        `${studiedBefore} → ${scoreOf(studied)}, ${effectOf(wrong)}`);
    ok('…and says it was recorded as a claim, not as evidence', /claim/i.test(textOf(wrong)) && !/proven|passed the gate/i.test(textOf(wrong)), textOf(wrong).slice(0, 200));
    ok('…and promises nothing the app does not do', !/sooner|bring .* back/i.test(textOf(wrong)), textOf(wrong).slice(0, 200));

    // Once per piece of the app's own evidence: an agent reads lesson text it
    // did not write, and a prompt in it must not grind a topic to the floor.
    const afterFirst = scoreOf(studied);
    let again = null;
    for (let i = 0; i < 5; i++) again = await call('record_claim', { topic: String(studied), correct: false, attempt_id: `grind-${i}` });
    ok('more wrong claims with no new evidence lower nothing more, and say why', scoreOf(studied) === afterFirst
        && effectOf(again) === 'already_lowered' && /already lowered/i.test(textOf(again)),
        `${afterFirst} → ${scoreOf(studied)}, ${effectOf(again)}`);
    mastery.updateMasteryFromAttempt(studied, 4, 4, 'quiz');
    const afterQuiz = scoreOf(studied);
    const next = await call('record_claim', { topic: String(studied), correct: false, attempt_id: 'after-quiz-1' });
    ok('…until the app records an answer of its own there', effectOf(next) === 'lowered' && scoreOf(studied) < afterQuiz,
        `${afterQuiz} → ${scoreOf(studied)}, ${effectOf(next)}`);
    // A rebuild from the app's own evidence (an item report re-scores the
    // topic) undoes a lowering without a new evidence id. The estimate is then
    // no longer what the claim left, so one more wrong claim may land, once.
    const afterNext = scoreOf(studied);
    mastery.rescoreNode(studied);
    const rebuilt = scoreOf(studied);
    const rearmed = await call('record_claim', { topic: String(studied), correct: false, attempt_id: 'after-rebuild-1' });
    const afterRearm = scoreOf(studied);
    const rearmedAgain = await call('record_claim', { topic: String(studied), correct: false, attempt_id: 'after-rebuild-2' });
    ok('…or until a rebuild from the app\'s own evidence has undone the lowering, and then once',
        rebuilt > afterNext && effectOf(rearmed) === 'lowered' && afterRearm < rebuilt
        && effectOf(rearmedAgain) === 'already_lowered' && scoreOf(studied) === afterRearm,
        `${afterNext} → rebuilt ${rebuilt} → ${afterRearm} (${effectOf(rearmed)}) → ${scoreOf(studied)} (${effectOf(rearmedAgain)})`);

    // A seed is withdrawn only by an answer the app received: wrong claims may
    // not push a head start below its seed.
    const seedBefore = scoreOf(seeded);
    let atSeed = null;
    for (let i = 0; i < 5; i++) atSeed = await call('record_claim', { topic: String(seeded), correct: false, attempt_id: `seed-${i}` });
    ok('wrong claims never take a topic below its head start', seedBefore === 0.6 && scoreOf(seeded) >= 0.6 && effectOf(atSeed) === 'at_seed',
        `${seedBefore} → ${scoreOf(seeded)}, ${effectOf(atSeed)}`);
    // …while it stands: once the learner's own answers have put the estimate
    // under it, the head start is spent and is no floor.
    // 2/4: under the seed, and high enough that one wrong step lowers (from
    // ~0.1 the step's learning transition lifts it, and that half is not taken).
    mastery.updateMasteryFromAttempt(seeded, 2, 4, 'quiz');
    const underSeed = scoreOf(seeded);
    const past = await call('record_claim', { topic: String(seeded), correct: false, attempt_id: 'seed-spent-1' });
    ok('…while it stands: under it after the app\'s own answers, a wrong claim lowers', underSeed < 0.6 && scoreOf(seeded) < underSeed && effectOf(past) === 'lowered',
        `${underSeed} → ${scoreOf(seeded)}, ${effectOf(past)}`);

    const count = () => db.prepare('SELECT COUNT(*) AS n FROM mastery_claims').get().n;
    const before = count();
    // New evidence first, so the claim below really lowers and its retry has
    // an outcome it could wrongly repeat.
    mastery.updateMasteryFromAttempt(studied, 4, 4, 'quiz');
    const first = await call('record_claim', { topic: String(studied), correct: false, attempt_id: 'same-attempt-1' });
    const retry = await call('record_claim', { topic: String(studied), correct: false, attempt_id: 'same-attempt-1' });
    ok('the same attempt id twice is one claim', count() === before + 1 && effectOf(first) === 'lowered'
        && first?.result?.structuredContent?.duplicate === false && retry?.result?.structuredContent?.duplicate === true,
        `${before} → ${count()}; ${effectOf(first)}`);
    // The retry gets the first call's outcome back, stale by now perhaps.
    ok('…and the retry says it is one, not what the first call did', /already recorded/i.test(textOf(retry)) && !/went from/i.test(textOf(retry)),
        textOf(retry).slice(0, 200));
    // The same id for ANOTHER answer is a harness reusing ids: answering with
    // the first answer's outcome would misreport this one.
    const otherTopic = await call('record_claim', { topic: String(fresh), correct: false, attempt_id: 'same-attempt-1' });
    const otherValue = await call('record_claim', { topic: String(studied), correct: true, attempt_id: 'same-attempt-1' });
    ok('the same attempt id for another topic or the other answer is refused', isErr(otherTopic) && isErr(otherValue)
        && /already used/i.test(textOf(otherTopic)) && /already used/i.test(textOf(otherValue)) && count() === before + 1,
        `${textOf(otherTopic).slice(0, 120)} | ${textOf(otherValue).slice(0, 120)}`);

    const notTopic = await call('record_claim', { topic: String(section), correct: true });
    const onNote = await call('record_claim', { topic: String(material), correct: true });
    ok('a claim on a section or a piece of Material is refused', isErr(notTopic) && isErr(onNote) && count() === before + 1);
    const noSuch = await call('record_claim', { topic: '987654', correct: true });
    ok('a claim on a topic that does not exist is refused', isErr(noSuch) && count() === before + 1);
    const noBool = await call('record_claim', { topic: String(fresh), correct: 'yes' });
    ok('a claim without a true/false answer is refused', isErr(noBool) && count() === before + 1);

    const m = await call('get_mastery', { topic: String(fresh) });
    ok('get_mastery counts the claims apart from the evidence', /claim/i.test(textOf(m)) && m?.result?.structuredContent?.claims?.total === 25, JSON.stringify(m?.result?.structuredContent?.claims || null));
}

// ---------------------------------------------------------------------------
console.log('\n--- a wrong claim keeps a topic on fading recall ---');
{
    // A claim lowers the estimate and moves nothing else, so a topic proven
    // once and left alone stays where the app would put it without the claim:
    // on fading recall when it was over 0.5, off it when it was not. Two
    // lists show it: getDecayingNodes (the feed's recall cards, the daily
    // plan's review step) and Today's decaying topics.
    // A fixed day long past for the decay timer, and a pinned instant every
    // reader's window ends at, so no assertion here reads the clock.
    const LONG_AGO = '2020-01-06 09:00:00';
    const NOW = new Date('2026-06-11T12:00:00.000Z');
    const sound = addNode('Sound', null, { position: 3 });
    const proven = addNode('Resonance', sound, { position: 0 });
    const shaky = addNode('Beats', sound, { position: 1 });
    const reported = addNode('Harmonics', sound, { position: 2 });
    // Answers of the app's own (so total_attempts > 0 and an evidence id),
    // then the estimate and the timer set to the case.
    for (const [id, right, score] of [[proven, 4, 0.85], [shaky, 2, 0.45], [reported, 4, 0.85]]) {
        mastery.updateMasteryFromAttempt(id, right, 4, 'quiz');
        db.prepare('UPDATE node_mastery SET mastery_score = ?, last_updated = ? WHERE node_id = ?').run(score, LONG_AGO, id);
    }
    db.prepare("INSERT INTO quizzes (node_id, title, questions) VALUES (?, 'Resonance', ?)").run(proven, JSON.stringify([
        // `correct_answer`, the stored key's name: a recall never serves a
        // question whose key the grader cannot read (recallOrder → bankOf).
        { type: 'true_false', question: 'A driven system answers most strongly at its natural frequency.', options: ['True', 'False'], correct_answer: 'True' },
    ]));

    const disagreed = [];
    const lists = (step) => {
        const byId = (a, b) => a - b;
        const plan = mastery.getDecayingNodes(pid, 14, NOW).map(r => r.node_id).sort(byId);
        const today = buildTodayData({ decayDays: 14, now: NOW }).decayingTopics.filter(t => t.projectId === pid).map(t => t.nodeId).sort(byId);
        if (plan.join() !== today.join()) disagreed.push(`${step}: plan [${plan}] vs Today [${today}]`);
        return { plan, today };
    };
    const on = (id, step) => { const { plan, today } = lists(step); return plan.includes(id) && today.includes(id); };
    const off = (id, step) => { const { plan, today } = lists(step); return !plan.includes(id) && !today.includes(id); };
    const shown = (step) => JSON.stringify(lists(step));
    const row = (id) => db.prepare('SELECT mastery_score, total_attempts, last_updated FROM node_mastery WHERE node_id = ?').get(id);
    const effectOf = (msg) => msg?.result?.structuredContent?.effect;

    ok('to begin with, the topics at 0.85 are on fading recall and the one at 0.45 is not',
        on(proven, 'start') && on(reported, 'start') && off(shaky, 'start'), shown('start'));

    const before = row(proven);
    const first = await call('record_claim', { topic: String(proven), correct: false, attempt_id: 'fading-1' });
    const after = row(proven);
    ok('a wrong claim takes a topic proven at 0.85 under 0.5', effectOf(first) === 'lowered' && after.mastery_score <= 0.5,
        `${before.mastery_score} → ${after.mastery_score} (${effectOf(first)})`);
    const ghosts = getGhostQuestions(pid, 5, 14, NOW).map(g => g.nodeId);
    ok('…and it stays on fading recall: the plan\'s list, Today and a recall card', on(proven, 'claimed') && ghosts.includes(proven),
        `${shown('claimed')} recall cards [${ghosts}]`);
    ok('…with its decay timer and its answer count where they were',
        after.last_updated === before.last_updated && after.total_attempts === before.total_attempts,
        `${before.last_updated}/${before.total_attempts} → ${after.last_updated}/${after.total_attempts}`);

    const weak = await call('record_claim', { topic: String(shaky), correct: false, attempt_id: 'fading-2' });
    ok('a topic at 0.45 before a wrong claim stays off it', effectOf(weak) === 'lowered' && off(shaky, 'shaky claimed'),
        `${effectOf(weak)} ${shown('shaky claimed')}`);

    // A probe answer adds evidence and no estimate (placement.js), so a second
    // wrong claim may lower the topic again, on top of the first.
    db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total, metadata) VALUES (?, 'placement', 0, 1, ?)")
        .run(proven, JSON.stringify({ source: 'placement' }));
    const second = await call('record_claim', { topic: String(proven), correct: false, attempt_id: 'fading-3' });
    ok('a second lowering stacked on the first keeps it there too',
        effectOf(second) === 'lowered' && row(proven).mastery_score < after.mastery_score && on(proven, 'stacked'),
        `${after.mastery_score} → ${row(proven).mastery_score} (${effectOf(second)}) ${shown('stacked')}`);

    // An answer of the app's own makes the estimate the app's again. A wrong
    // one, and the timer put back so only the score decides.
    mastery.updateMasteryFromAttempt(proven, 0, 4, 'quiz');
    db.prepare('UPDATE node_mastery SET last_updated = ? WHERE node_id = ?').run(LONG_AGO, proven);
    ok('after an answer of the app\'s own, it follows its real score again', row(proven).mastery_score <= 0.5 && off(proven, 'own answer'),
        `${row(proven).mastery_score} ${shown('own answer')}`);

    // A reported question takes its share out of the evidence and the topic is
    // rebuilt from what is left (itemReports.js): no new evidence id, no timer.
    const third = await call('record_claim', { topic: String(reported), correct: false, attempt_id: 'fading-4' });
    const heldOn = on(reported, 'reported claimed');
    db.prepare('UPDATE mastery_evidence SET score = 1 WHERE node_id = ?').run(reported);
    mastery.rescoreNode(reported, { score: -3 });
    ok('…and after a rebuild from its own evidence', effectOf(third) === 'lowered' && heldOn && row(reported).mastery_score <= 0.5 && off(reported, 'rebuilt'),
        `${effectOf(third)} held ${heldOn}, rebuilt to ${row(reported).mastery_score} ${shown('rebuilt')}`);

    // Three topics, under the plan's LIMIT 10: this pins the shared predicate,
    // not what either list does past a cap.
    ok('the plan\'s list and Today agree at every step, below the plan\'s cap of 10', disagreed.length === 0, disagreed.join('; '));
    // One definition, so the two cannot drift: each reader's query, from its
    // anchor to the statement's `.all(`, uses it and keeps no bar of its own.
    const queryOf = (file, anchor) => {
        const src = readFileSync(join(repoRoot, 'server', file), 'utf8');
        const at = src.indexOf(anchor);
        return at < 0 ? '' : src.slice(at, src.indexOf('.all(', at));
    };
    const ownCopy = [['mastery.js', 'export function getDecayingNodes('], ['today.js', 'const decayingRows = ']]
        .filter(([f, anchor]) => { const q = queryOf(f, anchor); return !q.includes('${FADING_TOPIC}') || /mastery_score\s*>|total_attempts\s*>/.test(q); })
        .map(([f, anchor]) => `${f} (${anchor.trim()})`);
    ok('both read the one definition in server/fading.js', ownCopy.length === 0, ownCopy.join(', '));
}

// ---------------------------------------------------------------------------
console.log('\n--- the key: none without it, and the HTTP listener holds none ---');
{
    const keyless = stdioServer({ TERRAMENTOR_URL: appUrl });
    await handshake(keyless);
    const r = record(await keyless.rpc('tools/call', { name: 'project_state', arguments: {} }));
    ok('without the key a locked app answers nothing', isErr(r) && !textOf(r).includes(PROJECT), textOf(r).slice(0, 200));
    ok('…and the error says which setting is missing, and where a key is made', /TERRAMENTOR_API_KEY/.test(textOf(r)) && /Generate key/.test(textOf(r)), textOf(r).slice(0, 300));
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

    // Two stand-ins for an app: one that redirects every request to a page of
    // its own, and a library with no password reached as another device.
    const REDIRECT_CANARY = 'REDIRECTED-PAGE-CANARY-2m';
    const stub = async (handler) => {
        const s = createServer(handler).listen(0, '127.0.0.1');
        await new Promise(r => s.once('listening', r));
        return { s, url: `http://127.0.0.1:${s.address().port}` };
    };
    const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const redirector = await stub((req, res) => {
        if (req.url.startsWith('/landed')) return json(res, 200, { text: REDIRECT_CANARY });
        res.writeHead(302, { Location: '/landed' });
        res.end();
    });
    const viaRedirect = stdioServer({ TERRAMENTOR_URL: redirector.url, TERRAMENTOR_API_KEY: API_KEY });
    await handshake(viaRedirect);
    const rd = record(await viaRedirect.rpc('tools/call', { name: 'project_state', arguments: {} }));
    ok('a redirect from the app is not followed, and the answer says it was one', isErr(rd) && !textOf(rd).includes(REDIRECT_CANARY) && /redirect/i.test(textOf(rd)),
        textOf(rd).slice(0, 200));
    viaRedirect.close();
    redirector.s.close();

    // An app that is running but slow (a check's open answers waiting on the
    // checker) is not "not running": a request that waited out its time says
    // it timed out and that the app may still be working on it.
    const held = [];
    const slow = await stub((req, res) => { held.push(res); });
    const slowClient = appClient({ origin: slow.url, keyHint: '' });
    const timedOut = await slowClient.post('/api/agent/check/submit', {}, { timeoutMs: 300 }).then(() => null, (e) => e);
    ok('a request the app is slow to answer says it timed out, never that Terramentor is not running',
        typeof AppTimeout === 'function' && timedOut instanceof AppTimeout && timedOut instanceof AppError && !/not running/i.test(timedOut.message) && /did not answer within/.test(timedOut.message),
        String(timedOut?.message));
    for (const res of held) res.destroy();
    slow.s.close();

    const unset = await stub((req, res) => json(res, 401,
        { error: 'Set a password to use this app from another device', authRequired: true, setupRequired: true }));
    const viaUnset = stdioServer({ TERRAMENTOR_URL: unset.url });
    await handshake(viaUnset);
    const us = record(await viaUnset.rpc('tools/call', { name: 'get_due', arguments: {} }));
    ok('a library with no password, reached as another device, says to set one rather than asking for a key',
        isErr(us) && /no password yet/i.test(textOf(us)) && /Generate key/.test(textOf(us)), textOf(us).slice(0, 300));
    viaUnset.close();
    unset.s.close();

    // Where the key may be sent: plain http to this computer, https anywhere.
    const originOf = (raw) => { try { return appOrigin(raw); } catch (e) { return e instanceof AppError ? 'refused' : `threw ${e.message}`; } };
    ok('TERRAMENTOR_URL: plain http to another computer is refused', originOf('http://example.com') === 'refused', originOf('http://example.com'));
    ok('TERRAMENTOR_URL: a scheme other than http(s) is refused', originOf('ftp://x') === 'refused' && originOf('file:///C:/x') === 'refused', originOf('ftp://x'));
    ok('TERRAMENTOR_URL: https to another computer and http to this one are taken, as an origin',
        originOf('https://example.com/some/path') === 'https://example.com' && originOf('http://localhost:3001/') === 'http://localhost:3001'
        && originOf('http://u:p@127.0.0.1:3001') === 'http://127.0.0.1:3001',
        `${originOf('https://example.com/some/path')} ${originOf('http://localhost:3001/')}`);
    // An address the parser rejects never got its user:password@ stripped, and
    // the refusal reaches the log and the agent's model: it must not echo it.
    const refusalOf = (raw) => { try { appOrigin(raw); return 'taken'; } catch (e) { return e instanceof AppError ? e.message : `threw ${e.message}`; } };
    const badPort = refusalOf('http://bad-user:BAD-URL-CANARY-8w@127.0.0.1:99999');
    const badHost = refusalOf('http://bad-user:BAD-URL-CANARY-8w@exa mple.com');
    ok('TERRAMENTOR_URL that is not an address is refused without echoing what it holds',
        [badPort, badHost].every(m => /not an address/.test(m) && !m.includes('BAD-URL-CANARY') && !m.includes('bad-user')),
        `${badPort} | ${badHost}`);
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
        // A page on this computer is still a page: a dev server, or the app itself.
        const devPage = await post(h.port, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'project_state', arguments: {} } },
            { ...bearer, Origin: 'http://127.0.0.1:5173' });
        const appPage = await post(h.port, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, { ...bearer, Origin: `http://localhost:${server.address().port}` });
        ok('an Origin of another localhost port is refused', devPage.status === 403 && appPage.status === 403 && !devPage.text.includes(PROJECT),
            `${devPage.status} ${appPage.status}`);
        const ownPage = await post(h.port, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, { ...bearer, Origin: `http://127.0.0.1:${h.port}` });
        ok('…and the listener\'s own Origin is not', ownPage.status === 200, `${ownPage.status} ${ownPage.text?.slice(0, 120)}`);
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
            // Nothing to connect to; the refusal to bind one is asserted below.
            console.log('  skip  no non-loopback address on this machine to connect to');
        }

        // A path URL() cannot parse ("//" reads as an empty host) must be a
        // 404, not a throw inside the request handler that ends the process.
        const odd = await new Promise((r) => {
            const req = request({ host: '127.0.0.1', port: h.port, path: '//', method: 'GET', headers: { Host: `127.0.0.1:${h.port}` } }, (res) => {
                res.resume();
                res.on('end', () => r(res.statusCode));
            });
            req.on('error', (e) => r(e.code || e.message));
            req.end();
        });
        const still = await post(h.port, { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }, bearer);
        ok('GET // is a 404 and the listener still answers after it', odd === 404 && still.status === 200, `${odd}, then ${still.status || still.error}`);
        h.child.kill();
        children.delete(h.child);
    }

    // The startup line names the app; a TERRAMENTOR_URL with user:password in it
    // must not put the password in a log.
    const URL_CANARY = 'URL-PASSWORD-CANARY-4k';
    const withCreds = await httpServer({ TERRAMENTOR_URL: appUrl.replace('http://', `http://gate-user:${URL_CANARY}@`) });
    ok('the startup line names the app without the credentials in TERRAMENTOR_URL', !!withCreds.port
        && withCreds.out.includes(`app: ${appUrl}`) && !withCreds.out.includes(URL_CANARY) && !withCreds.out.includes('gate-user'), withCreds.out.slice(-200));
    withCreds.child.kill();
    children.delete(withCreds.child);

    const wide = await httpServer({ TERRAMENTOR_URL: appUrl }, ['--host', '0.0.0.0']);
    ok('the HTTP listener refuses to start on a non-loopback address (exit 2)', !wide.port && wide.code === 2 && /loopback/i.test(wide.out),
        `exit ${wide.code}: ${wide.out.slice(-200)}`);
}

/**
 * Run a view in jsdom the way a host runs it for a learner: answer its
 * ui/initialize, send `toolResult` (the MCP answer that opened it) as the
 * tool result, pass every tools/call it makes to `callTool` (the real MCP
 * server) and answer it with that reply, and accept every model-context
 * update. `sent` holds every message the view sent; `until` waits on a test;
 * `press` clicks the control named by its data-focus.
 */
async function driveView(html, toolResult, callTool) {
    const sent = [];
    let win = null;
    const answer = (data) => win.dispatchEvent(new win.MessageEvent('message', { data, source: win }));
    const { window } = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(w) {
            win = w;
            w.postMessage = (msg) => {
                sent.push(msg);
                if (msg?.method === 'tools/call' && msg.id != null) {
                    Promise.resolve(callTool(msg.params?.name, msg.params?.arguments || {})).then((res) => answer(res?.error
                        ? { jsonrpc: '2.0', id: msg.id, error: res.error }
                        : { jsonrpc: '2.0', id: msg.id, result: res?.result }));
                } else if (msg?.method === 'ui/update-model-context' && msg.id != null) {
                    answer({ jsonrpc: '2.0', id: msg.id, result: {} });
                }
            };
            w.ResizeObserver = class { observe() {} disconnect() {} };
        },
    });
    const until = async (test, tries = 500) => { for (let i = 0; i < tries && !test(); i++) await new Promise(r => setTimeout(r, 10)); return !!test(); };
    const doc = window.document;
    const press = async (focus) => {
        if (!await until(() => { const b = doc.querySelector(`[data-focus="${focus}"]`); return b && !b.disabled; })) return false;
        doc.querySelector(`[data-focus="${focus}"]`).click();
        return true;
    };
    const calls = (name) => sent.filter(m => m?.method === 'tools/call' && m.params?.name === name);
    const contexts = () => sent.filter(m => m?.method === 'ui/update-model-context');
    await until(() => sent.some(m => m?.method === 'ui/initialize'));
    const init = sent.find(m => m?.method === 'ui/initialize');
    if (init) answer({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: init.params.protocolVersion, hostContext: { theme: 'light' } } });
    await until(() => sent.some(m => m?.method === 'ui/notifications/initialized'));
    answer({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: toolResult?.result || {} });
    return { window, doc, sent, until, press, calls, contexts, close: () => window.close() };
}

// ---------------------------------------------------------------------------
console.log('\n--- the views: a check and a review in the host\'s window ---');
{
    const UI_CAPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
    const host = stdioServer({ TERRAMENTOR_URL: appUrl, TERRAMENTOR_API_KEY: API_KEY });
    const init = record(await host.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: UI_CAPS, clientInfo: { name: 'mcp-gates-host', version: '1.0.0' } }));
    host.notify('notifications/initialized');
    ok('a host that renders views is answered', init?.result?.serverInfo?.name === 'terramentor');
    const hostCall = (name, args = {}) => call(name, args, host);
    const meta = (msg) => msg?.result?._meta || {};
    const sittingOf = (msg) => meta(msg)['terramentor/sitting'];
    const data = (msg) => msg?.result?.structuredContent || {};

    // What each host is offered.
    const hostTools = record(await host.rpc('tools/list'))?.result?.tools || [];
    const byName = Object.fromEntries(hostTools.map(t => [t.name, t]));
    const plainNames = tools.map(t => t.name);
    for (const name of VIEW_TOOLS) {
        const uri = byName[name]?._meta?.ui?.resourceUri;
        ok(`${name} names its view (ui://) and is offered to the model`, typeof uri === 'string' && uri.startsWith('ui://terramentor/')
            && !(byName[name]?._meta?.ui?.visibility || ['model']).every(v => v !== 'model'), JSON.stringify(byName[name]?._meta));
        ok(`${name} is offered to a host without views too, as a plain tool`, plainNames.includes(name));
    }
    for (const name of APP_TOOLS) {
        ok(`${name} is for the view only (visibility ["app"])`, JSON.stringify(byName[name]?._meta?.ui?.visibility) === '["app"]', JSON.stringify(byName[name]?._meta));
        ok(`${name} is not listed to a host that cannot draw views`, !plainNames.includes(name));
    }
    const plainTry = await call('check_questions', { sitting: 'x'.repeat(32) });
    ok('a host without views cannot call a view\'s tool', isErr(plainTry), textOf(plainTry).slice(0, 160));

    // The views themselves: one HTML document each, locked down.
    const resources = record(await host.rpc('resources/list'))?.result?.resources || [];
    const viewHtmlOf = {};
    const sha = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
    for (const name of VIEW_TOOLS) {
        const uri = byName[name]?._meta?.ui?.resourceUri;
        const listed = resources.find(r => r.uri === uri);
        ok(`${uri} is listed as an MCP App view`, listed?.mimeType === 'text/html;profile=mcp-app', JSON.stringify(listed));
        const read = record(await host.rpc('resources/read', { uri }));
        const item = read?.result?.contents?.[0] || {};
        const html = String(item.text || '');
        viewHtmlOf[name] = html;
        ok(`${uri} reads as one HTML document`, item.mimeType === 'text/html;profile=mcp-app' && /^<!doctype html>/i.test(html.trim()), html.slice(0, 120));
        const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html)?.[1] || '';
        const directive = (d) => (new RegExp(`(?:^|;)\\s*${d}\\s+([^;]*)`).exec(csp)?.[1] || '').trim();
        ok(`${uri} carries its own CSP, before any script`, !!csp && html.indexOf(csp) < html.search(/<script/i));
        ok(`${uri}: nothing loads or connects anywhere`, directive('default-src') === "'none'" && directive('connect-src') === "'none'"
            && directive('frame-src') === "'none'" && directive('object-src') === "'none'" && directive('base-uri') === "'none'"
            && directive('form-action') === "'none'" && /^(?:data:)?$/.test(directive('img-src')), csp);
        const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
        const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);
        const scriptSrc = directive('script-src').split(/\s+/).filter(Boolean);
        const styleSrc = directive('style-src').split(/\s+/).filter(Boolean);
        ok(`${uri}: script-src is hashes only (no 'unsafe-inline', no eval, no host)`, scriptSrc.length > 0 && scriptSrc.every(s => /^'sha256-[A-Za-z0-9+/=]+'$/.test(s)), directive('script-src'));
        ok(`${uri}: every script is the one its hash allows`, scripts.length > 0 && scripts.every(s => scriptSrc.includes(sha(s))), `${scripts.length} scripts`);
        ok(`${uri}: every style is the one its hash allows`, styles.length > 0 && styles.every(s => styleSrc.includes(sha(s))) && styleSrc.every(s => /^'sha256-/.test(s)), directive('style-src'));
        ok(`${uri}: no script from a file, no link, no inline handler, no javascript: URL`,
            !/<script[^>]+\bsrc=/i.test(html) && !/<link\b/i.test(html) && !/\son[a-z]+\s*=/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, '')) && !/javascript:/i.test(html));
        ok(`${uri}: no string becomes code or markup (eval, Function, innerHTML, document.write)`,
            !scripts.some(s => /\beval\s*\(|new\s+Function\b|\bFunction\s*\(|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|setTimeout\s*\(\s*['"`]/.test(s)));
        ok(`${uri}: no address outside the document`, !/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(html));
        // A host may write its own CSP ahead of the document, and the browser
        // then ignores the view's (MCP Inspector 2.13 does). The code itself
        // must open nothing, so "no network" does not rest on our policy.
        const opener = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|new\s+Image\b|\bWorker\s*\(|importScripts|window\.open\b|\blocation\s*(?:\.href\s*)?=|\.(?:src|href|action)\s*=/;
        ok(`${uri}: the view's code opens no connection of its own (fetch, sockets, beacons, images, workers, navigation)`,
            !scripts.some(s => opener.test(s)), scripts.map(s => opener.exec(s)?.[0]).filter(Boolean).join(', '));
        // Every sentence the view passes to t() ships with it: a key left out
        // of its list in mcp/views.js shows English in every other language
        // ("is marked completed" did, 5 Nov 2026), and nothing else notices.
        let shipped = {};
        try { shipped = JSON.parse(/<script type="application\/json" id="tm-strings">([\s\S]*?)<\/script>/.exec(html)?.[1] || '{}'); } catch { shipped = {}; }
        const ru = shipped.ru || {};
        const said = [...new Set(scripts.flatMap(s => [...s.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)]
            .map(m => m[2].replace(/\\(['"\\])/g, '$1'))))];
        const unshipped = said.filter(k => !(k in ru) && !(`${k}_one` in ru) && !(`${k}_other` in ru));
        ok(`${uri}: every sentence it says ships with its translations`, said.length > 0 && unshipped.length === 0, unshipped.join(' | '));

        // The host's colours come in pairs: MCP Inspector 2.13 sends a white
        // --color-text-inverse with no --color-background-inverse, and the
        // view's own near-white dark fill under it hid the primary button.
        const halfSent = await hostColours(html, { '--color-background-primary': '#131519', '--color-text-primary': '#c9cdd6', '--color-text-inverse': '#fff' });
        ok(`${uri}: a host's text colour sent without its fill is dropped; a whole pair is used`,
            halfSent['--color-text-inverse'] === '' && halfSent['--color-background-inverse'] === ''
            && halfSent['--color-background-primary'] === '#131519' && halfSent['--color-text-primary'] === '#c9cdd6', JSON.stringify(halfSent));
        const halfLater = await hostColours(html, { '--color-background-inverse': '#c9cdd6', '--color-text-inverse': '#131519' }, { '--color-text-inverse': '#fff' });
        ok(`${uri}: a pair sent whole is used, and a later change carrying half of it drops both`,
            halfLater.before['--color-background-inverse'] === '#c9cdd6' && halfLater.before['--color-text-inverse'] === '#131519'
            && halfLater['--color-background-inverse'] === '' && halfLater['--color-text-inverse'] === '', JSON.stringify(halfLater));
        // Only the window that framed the view is its host: the same change
        // from any other window is ignored.
        const PAIR = { '--color-background-inverse': '#c9cdd6', '--color-text-inverse': '#131519' };
        const NEW_PAIR = { '--color-background-inverse': '#204060', '--color-text-inverse': '#f0f0f0' };
        const fromHost = await hostColours(html, PAIR, NEW_PAIR);
        const fromElsewhere = await hostColours(html, PAIR, NEW_PAIR, { foreign: true });
        ok(`${uri}: a message from its host is taken, the same message from any other window is ignored`,
            fromHost['--color-background-inverse'] === '#204060' && fromHost['--color-text-inverse'] === '#f0f0f0'
            && fromElsewhere['--color-background-inverse'] === '#c9cdd6' && fromElsewhere['--color-text-inverse'] === '#131519',
            JSON.stringify({ fromHost, fromElsewhere }));
    }

    // A bank of checked questions on a topic nothing else has measured.
    const checkedTopic = addNode('Standing waves', section, { position: 3 });
    const EXPL = 'EXPLANATION-CANARY-5d1e';
    const FILL_KEY = 'interferometer';
    const BANK = [
        { uuid: 'gate-mc', type: 'multiple_choice', question: 'Which quantity sets the pitch of a vibrating string?', options: ['Its colour', 'Its frequency', 'Its amplitude', 'Its mass alone'], correct_answer: 'Its frequency', explanation: `${EXPL} Pitch is frequency.` },
        { uuid: 'gate-tf', type: 'true_false', question: 'A node of a standing wave stays still.', correct_answer: 'True', explanation: `${EXPL} Nodes do not move.` },
        { uuid: 'gate-num', type: 'numeric', question: 'A string 2 m long vibrates in its fundamental mode. How long is the wave?', correct_answer: '4', unit: 'm', explanation: `${EXPL} Twice the length.` },
        { uuid: 'gate-seq', type: 'sequence', question: 'Put the harmonics in order of frequency, lowest first.', items: ['third harmonic', 'fundamental', 'second harmonic'], correct_answer: JSON.stringify(['fundamental', 'second harmonic', 'third harmonic']), explanation: `${EXPL} Each is a whole multiple.` },
        { uuid: 'gate-fill', type: 'fill_in', question: 'An instrument that measures lengths by interference is an ___.', correct_answer: FILL_KEY, explanation: `${EXPL} It interferes light.` },
    ];
    db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(checkedTopic, 'Standing waves', JSON.stringify(BANK));
    const RIGHT = ['Its frequency', 'True', '4', JSON.stringify(['fundamental', 'second harmonic', 'third harmonic']), FILL_KEY];
    const answersFor = (questions, right) => questions.map((q) => {
        const i = BANK.findIndex(b => b.question === q.question);
        return right.includes(i) ? RIGHT[i] : (q.type === 'sequence' ? JSON.stringify(q.items) : 'no idea');
    });
    const checkEvidence = () => db.prepare("SELECT COUNT(*) AS n FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'mastery_check'").get(checkedTopic).n;
    const leaksAKey = (msg) => {
        const json = JSON.stringify(msg);
        return /correct_?answer|"accept"|distractors|explanation/i.test(json) || json.includes(EXPL) || json.includes(FILL_KEY);
    };

    // Without views: the plain tool says where to take it, and opens nothing.
    const plain = await call('mastery_check', { topic: checkedTopic });
    ok('without views, mastery_check links to the topic in Terramentor and opens no sitting',
        !isErr(plain) && textOf(plain).includes(`${appUrl}/project/${pid}/tree/${checkedTopic}`) && !sittingOf(plain), textOf(plain).slice(0, 240));

    // With views: the model is told a check is open, and sees none of it.
    const started = await hostCall('mastery_check', { topic: checkedTopic });
    const sit = sittingOf(started);
    ok('mastery_check opens a sitting and hands its token to the view in _meta', !isErr(started) && typeof sit === 'string' && sit.length >= 24, textOf(started).slice(0, 200));
    const modelSees = JSON.stringify([started?.result?.content, started?.result?.structuredContent]);
    ok('the model sees no question, no key and no token', !BANK.some(b => modelSees.includes(b.question)) && !leaksAKey({ c: started?.result?.content, s: started?.result?.structuredContent })
        && !modelSees.includes(sit), modelSees.slice(0, 300));
    ok('the model is told it must not answer the check itself', /must not/i.test(textOf(started)));
    // The score reaches the model only through the view's context update,
    // which a host may refuse: no promise of it, and the way to read it anyway.
    ok('neither the tool nor its answer promises the score; both name get_mastery for the recorded result',
        /get_mastery/.test(textOf(started)) && /get_mastery/.test(byName.mastery_check?.description || '')
        && !/then the score/.test(byName.mastery_check?.description || '') && !/only how the session ended/.test(byName.review_cards?.description || ''),
    `${textOf(started).slice(-120)} | ${byName.mastery_check?.description}`);

    const shown = await hostCall('check_questions', { sitting: sit });
    const qs = data(shown).questions || [];
    ok('the view gets the drawn questions', !isErr(shown) && qs.length === BANK.length, textOf(shown).slice(0, 200));
    ok('no key leaves before the answer: no key field, no explanation, no typed answer', !leaksAKey(shown), JSON.stringify(shown).slice(0, 400));
    const seq = qs.find(q => q.type === 'sequence');
    ok('an ordering is served in its stored order, never the key\'s', JSON.stringify(seq?.items) === JSON.stringify(BANK[3].items));

    // Red: a sitting the server did not open, or of the other kind.
    const forged = await hostCall('check_questions', { sitting: 'A'.repeat(32) });
    ok('a token the server never issued opens nothing', isErr(forged) && !leaksAKey(forged));

    // A question with a picture or a sound: the view cannot show it, so the
    // view's check passes over it for the next one, and a bank left with too
    // few without one sends the learner to the app instead.
    const MEDIA = [{ hash: 'a'.repeat(64), kind: 'image' }];
    const pictured = addNode('Wave pictures', section, { position: 7 });
    const PICTURE_BANK = [
        ...BANK.slice(0, 2).map(b => ({ ...b, uuid: `pic-${b.uuid}`, question: `Picture: ${b.question}`, media: MEDIA })),
        ...BANK.map(b => ({ ...b, uuid: `plain-${b.uuid}` })),
    ];
    db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(pictured, 'Wave pictures', JSON.stringify(PICTURE_BANK));
    const picSit = sittingOf(await hostCall('mastery_check', { topic: pictured }));
    const picQs = data(await hostCall('check_questions', { sitting: picSit })).questions || [];
    ok('the view\'s check passes over a question with a picture or sound and draws the next one',
        picQs.length === BANK.length && picQs.every(q => !q.question.startsWith('Picture:')), JSON.stringify(picQs.map(q => q.question.slice(0, 30))));
    const fewPlain = addNode('Wave photos', section, { position: 8 });
    db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(fewPlain, 'Wave photos',
        JSON.stringify([...BANK.slice(0, 3).map(b => ({ ...b, uuid: `photo-${b.uuid}`, media: MEDIA })), ...BANK.slice(3).map(b => ({ ...b, uuid: `few-${b.uuid}` }))]));
    const fewStart = await hostCall('mastery_check', { topic: fewPlain });
    ok('a bank with too few questions the view can show opens no sitting and says the check is taken in Terramentor',
        !isErr(fewStart) && !sittingOf(fewStart) && /picture or play a sound/.test(textOf(fewStart)), textOf(fewStart).slice(0, 240));

    // The result shows the counts the check was judged on. A question taken
    // out of the bank between the draw and the grading (a report does that)
    // is not proof: four right of five is 4/5, but judged 3/4, under the bar.
    const reported = addNode('Wave speed', section, { position: 9 });
    const SPEED_BANK = BANK.map(b => ({ ...b, uuid: `speed-${b.uuid}` }));
    const speedQuiz = Number(db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(reported, 'Wave speed', JSON.stringify(SPEED_BANK)).lastInsertRowid);
    const speedSit = sittingOf(await hostCall('mastery_check', { topic: reported }));
    const speedQs = data(await hostCall('check_questions', { sitting: speedSit })).questions || [];
    db.prepare('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify(SPEED_BANK.slice(1)), speedQuiz);
    const judged = data(await hostCall('check_submit', { sitting: speedSit, answers: answersFor(speedQs, [0, 1, 2, 3]) })).result || {};
    ok('a check shows the score it was judged on: 3/4 proven, not the raw 4/5, and not passed',
        speedQs.length === BANK.length && judged.score === 3 && judged.total === 4 && judged.passed === false, JSON.stringify({ ...judged, items: undefined }));

    // The check as a learner takes it in the view: one question answered, the
    // rest left alone, Next to the end, Submit. What reaches check_submit is
    // the view's own encoding: the answer as typed or chosen, an untouched
    // ordering in its served order (it counts as answered), anything else null.
    const viewed = addNode('Wave view', section, { position: 10 });
    db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(viewed, 'Wave view', JSON.stringify(BANK.map(b => ({ ...b, uuid: `view-${b.uuid}` }))));
    const opened = await hostCall('mastery_check', { topic: viewed });
    const checkView = await driveView(viewHtmlOf.mastery_check, opened, hostCall);
    try {
        const { doc, until, press, calls, contexts } = checkView;
        const shownCount = await until(() => doc.querySelector('.stem')) ? BANK.length : 0;
        const expected = [];
        let picked = null;
        for (let i = 0; i < shownCount; i++) {
            const stem = doc.querySelector('.stem')?.textContent || '';
            const b = BANK.findIndex(x => x.question === stem);
            const q = BANK[b];
            if (picked === null && q && q.type !== 'sequence') {
                picked = b;
                if (q.type === 'multiple_choice' || q.type === 'true_false') {
                    [...doc.querySelectorAll('[role="radio"]')].find(o => o.textContent === RIGHT[b])?.click();
                } else {
                    const field = doc.querySelector('[data-focus="answer"]');
                    field.value = RIGHT[b];
                    field.dispatchEvent(new checkView.window.Event('input', { bubbles: true }));
                }
                expected.push(RIGHT[b]);
            } else {
                expected.push(q?.type === 'sequence' ? JSON.stringify(q.items) : null);
            }
            if (i < shownCount - 1) await press('next');
        }
        await press('submit');
        await until(() => calls('check_submit').length > 0 && contexts().length > 0);
        const submitted = calls('check_submit')[0]?.params?.arguments || {};
        ok('the view\'s Submit sends check_submit with its sitting and each answer as its input encodes it (an untouched ordering as served, the rest null)',
            shownCount === BANK.length && picked !== null && submitted.sitting === sittingOf(opened)
            && JSON.stringify(submitted.answers) === JSON.stringify(expected), JSON.stringify({ submitted, expected }));
        const told = contexts()[0]?.params?.structuredContent || {};
        ok('the learner\'s score is passed to the model once the app has graded it', told.total === BANK.length && told.score === 1 && told.passed === false, JSON.stringify(told));
    } finally {
        checkView.close();
    }

    // A failed check: three of five.
    const evidenceBeforeCheck = checkEvidence();
    const failed = await hostCall('check_submit', { sitting: sit, answers: answersFor(qs, [0, 1, 2]) });
    const fr = data(failed).result || {};
    ok('a submitted check is graded by the app: 3 of 5, not passed', !isErr(failed) && fr.score === 3 && fr.total === 5 && fr.passed === false, JSON.stringify(fr).slice(0, 300));
    ok('the key and explanation come back only after the answer', (fr.items || []).every(i => 'correctAnswer' in i) && JSON.stringify(fr).includes(EXPL));
    ok('one check, one mastery_check evidence row, marked as taken in a view', checkEvidence() === evidenceBeforeCheck + 1
        && JSON.parse(db.prepare("SELECT metadata FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'mastery_check' ORDER BY id DESC").get(checkedTopic).metadata).via === 'agent_view');
    // Red: the same sitting submitted again, with other answers.
    const again = await hostCall('check_submit', { sitting: sit, answers: answersFor(qs, [0, 1, 2, 3, 4]) });
    ok('a second submit of one sitting writes nothing and returns the first result', !isErr(again) && data(again).result?.score === 3
        && data(again).duplicate === true && checkEvidence() === evidenceBeforeCheck + 1, JSON.stringify(data(again)).slice(0, 200));
    const early = await hostCall('check_complete', { sitting: sit });
    ok('a failed check does not complete its topic', isErr(early) && db.prepare('SELECT status FROM nodes WHERE id = ?').get(checkedTopic).status !== 'completed');

    // A passed check.
    const second = await hostCall('mastery_check', { topic: checkedTopic });
    const sit2 = sittingOf(second);
    const qs2 = data(await hostCall('check_questions', { sitting: sit2 })).questions || [];
    const passedCheck = await hostCall('check_submit', { sitting: sit2, answers: answersFor(qs2, [0, 1, 2, 3, 4]) });
    ok('a passed check writes one more evidence row', data(passedCheck).result?.passed === true && checkEvidence() === evidenceBeforeCheck + 2,
        `${checkEvidence() - evidenceBeforeCheck} rows; ${JSON.stringify(data(passedCheck).result?.score)}`);
    // The pass completes its topic in the write that records it: a host
    // window closed on the result cannot leave it open, and the view offers
    // no Continue (server/masteryCheck.js, check-pass-close-gates.mjs).
    ok('a passed check completes its topic in the same write, before any Continue',
        db.prepare('SELECT status FROM nodes WHERE id = ?').get(checkedTopic).status === 'completed' && data(passedCheck).result?.completed === true,
        JSON.stringify(data(passedCheck).result?.completed));
    // Skipped since (another tab, the app): check_complete must not write the
    // completion again over it.
    db.prepare("UPDATE nodes SET status = 'skipped' WHERE id = ?").run(checkedTopic);
    const done = await hostCall('check_complete', { sitting: sit2 });
    ok('check_complete after it writes nothing over a status set since, and fails nothing',
        !isErr(done) && db.prepare('SELECT status FROM nodes WHERE id = ?').get(checkedTopic).status === 'skipped', textOf(done).slice(0, 200));
    ok('...and says the topic was set otherwise, never "marked completed"',
        /since been set to skipped/.test(textOf(done)) && !/marked completed/.test(textOf(done)), textOf(done).slice(0, 200));
    db.prepare("UPDATE nodes SET status = 'completed' WHERE id = ?").run(checkedTopic);
    {
        // Deleted since: check_complete must not claim a topic that is gone.
        const gone = addNode('Beats', section, { position: 9 });
        db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(gone, 'Beats', JSON.stringify(BANK));
        const sitGone = sittingOf(await hostCall('mastery_check', { topic: gone }));
        const qsGone = data(await hostCall('check_questions', { sitting: sitGone })).questions || [];
        const passedGone = await hostCall('check_submit', { sitting: sitGone, answers: answersFor(qsGone, [0, 1, 2, 3, 4]) });
        db.prepare('DELETE FROM nodes WHERE id = ?').run(gone);
        const doneGone = await hostCall('check_complete', { sitting: sitGone });
        ok('check_complete on a topic deleted since says so, never "marked completed"',
            data(passedGone).result?.completed === true && !isErr(doneGone)
                && /since been deleted/.test(textOf(doneGone)) && !/marked completed/.test(textOf(doneGone)),
            `${JSON.stringify(data(passedGone).result?.completed)} ${textOf(doneGone).slice(0, 200)}`);
    }
    const crossed = await hostCall('review_next', { sitting: sit2 });
    ok('a check\'s token is not a review\'s', isErr(crossed));

    // Two submits racing on one sitting while the first is still being graded.
    // Every key above is graded locally, which is over before the second
    // request is read; an open answer goes to the checker, here a local stub
    // that takes its time and counts what it is asked.
    const raced = addNode('Beats', section, { position: 6 });
    const RACE_BANK = [
        { uuid: 'race-mc', type: 'multiple_choice', question: 'Forks of 440 Hz and 444 Hz sound together. How often does the loudness swell?', options: ['4 times a second', '440 times a second', '884 times a second', 'Never'], correct_answer: '4 times a second', explanation: 'The difference.' },
        { uuid: 'race-tf', type: 'true_false', question: 'Two waves of the same frequency make no beats.', correct_answer: 'True', explanation: 'No difference, no beats.' },
        { uuid: 'race-num', type: 'numeric', question: 'Strings at 256 Hz and 260 Hz sound together. How many beats a second?', correct_answer: '4', unit: 'Hz', explanation: '260 - 256.' },
        { uuid: 'race-fill', type: 'fill_in', question: 'Two strings are in tune when their beats ___.', correct_answer: 'vanish', explanation: 'Equal pitch.' },
        { uuid: 'race-open', type: 'short_answer', question: 'What decides how often beats are heard?', correct_answer: 'the difference between the two frequencies', explanation: 'The beat frequency.' },
    ];
    const RACE_RIGHT = ['4 times a second', 'True', '4', 'vanish', 'how far apart the two pitches are'];
    db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(raced, 'Beats', JSON.stringify(RACE_BANK));
    const racedEvidence = () => db.prepare("SELECT COUNT(*) AS n FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'mastery_check'").get(raced).n;
    let checkerCalls = 0;
    const checker = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            checkerCalls++;
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ correct: true, explanation: 'That is the beat frequency.' }) } }] }));
            }, 800);
        });
    });
    await new Promise(r => checker.listen(0, '127.0.0.1', r));
    const AI_ENV = ['AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL'];
    const envBefore = Object.fromEntries(AI_ENV.map(k => [k, process.env[k]]));
    const enabledBefore = db.prepare("SELECT value FROM settings WHERE key = 'ai_enabled'").get()?.value;
    try {
        process.env.AI_PROVIDER = 'openai';
        process.env.AI_BASE_URL = `http://127.0.0.1:${checker.address().port}/v1`;
        process.env.AI_MODEL = 'stub-checker';
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_enabled', 'true')").run();
        const sit3 = sittingOf(await hostCall('mastery_check', { topic: raced }));
        const qs3 = data(await hostCall('check_questions', { sitting: sit3 })).questions || [];
        const answers3 = qs3.map(q => RACE_RIGHT[RACE_BANK.findIndex(b => b.question === q.question)]);
        const before = racedEvidence();
        const racing = await Promise.all([1, 2].map(() => hostCall('check_submit', { sitting: sit3, answers: answers3 })));
        const scores = racing.map(m => data(m).result?.score);
        // Neither answer is the "already submitted" one: both arrived while the
        // first was still being graded, so the race really overlapped.
        ok('two submits racing on one sitting while it is graded are one check: one checker call, one score, one evidence row',
            qs3.length === RACE_BANK.length && checkerCalls === 1 && racing.every(m => !isErr(m) && data(m).result?.passed === true && data(m).duplicate !== true)
            && scores[0] === RACE_BANK.length && scores[1] === scores[0] && racedEvidence() === before + 1,
            `${qs3.length} questions; ${checkerCalls} checker calls; scores ${JSON.stringify(scores)}; ${racedEvidence() - before} rows; duplicate ${JSON.stringify(racing.map(m => data(m).duplicate ?? null))}`);
    } finally {
        for (const k of AI_ENV) { if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k]; }
        if (enabledBefore === undefined) db.prepare("DELETE FROM settings WHERE key = 'ai_enabled'").run();
        else db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_enabled', ?)").run(enabledBefore);
        checker.close();
    }

    // The card review: a topic with cards and nothing else.
    const carded = addNode('Resonance', section, { position: 4 });
    const BACK = 'BACK-CANARY-';
    for (let i = 1; i <= 4; i++) {
        db.prepare("INSERT INTO flashcards (node_id, front, back, next_review) VALUES (?, ?, ?, '2026-01-05T09:00:00.000Z')").run(carded, `Resonance fact ${i}?`, `${BACK}${i}`);
    }
    const reviewRows = () => db.prepare('SELECT COUNT(*) AS n FROM review_log').get().n;
    const plainReview = await call('review_cards', { project: String(pid) });
    ok('without views, review_cards points to Terramentor and opens no session', !isErr(plainReview) && !sittingOf(plainReview) && textOf(plainReview).includes(appUrl), textOf(plainReview).slice(0, 200));
    const review = await hostCall('review_cards', { project: String(pid) });
    const rs = sittingOf(review);
    ok('review_cards opens a session for the view and the model sees no card', typeof rs === 'string'
        && !JSON.stringify([review?.result?.content, review?.result?.structuredContent]).includes('Resonance fact'), textOf(review).slice(0, 200));
    const card = data(await hostCall('review_next', { sitting: rs })).card;
    const backOf = (id) => db.prepare('SELECT back FROM flashcards WHERE id = ?').get(id)?.back || '\u0000';
    ok('a card is shown front first: its back stays on the server', !!card?.front && !JSON.stringify(card).includes(backOf(card.cardId)) && !JSON.stringify(card).includes(BACK), JSON.stringify(card));
    const unrevealed = await hostCall('review_rate', { sitting: rs, presentationId: card?.presentationId, rating: 'easy' });
    ok('a card cannot be rated before its answer is shown', isErr(unrevealed));
    const revealed = data(await hostCall('review_reveal', { sitting: rs, presentationId: card?.presentationId }));
    ok('the answer side comes with what each rating would schedule', String(revealed.card?.back || '').length > 0
        && ['again', 'hard', 'good', 'easy'].every(r => typeof revealed.intervals?.[r] === 'string'), JSON.stringify(revealed).slice(0, 300));
    const logBefore = reviewRows();
    // Every field a review writes, as it stood before the rating: Undo must
    // put back all of them, not only the ones that are easy to see.
    const { SRS_STATE_FIELDS } = await import(new URL('../src/utils/srs.ts', import.meta.url).href);
    const schedulerOf = (id) => db.prepare(`SELECT ${SRS_STATE_FIELDS.join(', ')} FROM flashcards WHERE id = ?`).get(id);
    const beforeRating = schedulerOf(card.cardId);
    const rated = await hostCall('review_rate', { sitting: rs, presentationId: card.presentationId, rating: 'easy' });
    const cardAfter = db.prepare('SELECT review_count, next_review FROM flashcards WHERE id = ?').get(card.cardId);
    ok('a rating is the app\'s: logged and scheduled', !isErr(rated) && reviewRows() === logBefore + 1 && cardAfter.review_count === 1
        && cardAfter.next_review > '2026-01-05T09:00:00.000Z', JSON.stringify(cardAfter));
    // Red: the same presentation rated twice.
    const twice = await hostCall('review_rate', { sitting: rs, presentationId: card.presentationId, rating: 'again' });
    ok('a second rating of one presentation writes nothing', !isErr(twice) && data(twice).duplicate === true && reviewRows() === logBefore + 1
        && db.prepare('SELECT review_count FROM flashcards WHERE id = ?').get(card.cardId).review_count === 1, JSON.stringify(data(twice)));
    ok('the rating is the one Undo would take back (undoable)', data(rated).undoable === card.presentationId, JSON.stringify(data(rated)));
    const undone = data(await hostCall('review_undo', { sitting: rs, presentationId: card.presentationId }));
    ok('Undo restores the card and takes its rating out of the log, and shows the card again', undone.undone === true && reviewRows() === logBefore
        && db.prepare('SELECT review_count FROM flashcards WHERE id = ?').get(card.cardId).review_count === 0 && undone.card?.cardId === card.cardId, JSON.stringify(undone).slice(0, 300));
    const afterUndo = schedulerOf(card.cardId);
    const unrestored = SRS_STATE_FIELDS.filter(k => afterUndo[k] !== beforeRating[k]);
    ok(`Undo puts back every field the rating wrote (${SRS_STATE_FIELDS.length})`, SRS_STATE_FIELDS.length >= 10 && unrestored.length === 0,
        unrestored.map(k => `${k}: ${JSON.stringify(beforeRating[k])} → ${JSON.stringify(afterUndo[k])}`).join('; '));
    // Every card rated Easy, as fast as a script can.
    const cardOfRating = new Map();
    for (let n = 0; n < 40; n++) {
        const next = data(await hostCall('review_next', { sitting: rs }));
        if (next.done || !next.card) break;
        cardOfRating.set(next.card.presentationId, next.card.cardId);
        await hostCall('review_reveal', { sitting: rs, presentationId: next.card.presentationId });
        await hostCall('review_rate', { sitting: rs, presentationId: next.card.presentationId, rating: 'easy' });
    }
    const end = data(await hostCall('review_next', { sitting: rs }));
    ok('the session ends once every card is rated', end.done === true && end.reviewed >= 4, JSON.stringify(end));
    // Red: a rating in the view is worth exactly what the same rating is worth
    // in the app — the same evidence row, the same estimate — and never more.
    // A twin topic is rated Easy through the app's own review route.
    const { computeSrsUpdate } = await import(new URL('../src/utils/srs.ts', import.meta.url).href);
    // Pinned instants, never the clock: a new card's Easy is the same at any
    // instant after it is due, and the re-rating only needs a stamp the view's
    // own rating did not write.
    const TWIN_RATED_AT = new Date('2026-06-01T12:00:00.000Z');
    const RERATED_AT = new Date('2099-01-01T12:00:00.000Z');
    const twin = addNode('Resonance, rated in the app', section, { position: 5 });
    for (let i = 1; i <= 4; i++) {
        const id = Number(db.prepare("INSERT INTO flashcards (node_id, front, back, next_review) VALUES (?, ?, ?, '2026-01-05T09:00:00.000Z')").run(twin, `Twin fact ${i}?`, `TWIN-${i}`).lastInsertRowid);
        const update = computeSrsUpdate(db.prepare('SELECT * FROM flashcards WHERE id = ?').get(id), 'easy', TWIN_RATED_AT);
        await fetch(`${appUrl}/api/ai/flashcards/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` }, body: JSON.stringify(update) });
    }
    const evidenceOf = (id) => db.prepare('SELECT evidence_type AS type, score, total FROM mastery_evidence WHERE node_id = ? ORDER BY id').all(id);
    ok('a rating in the view writes what the same rating in the app writes', evidenceOf(carded).length > 0
        && JSON.stringify(evidenceOf(carded)) === JSON.stringify(evidenceOf(twin)) && Math.abs(scoreOf(carded) - scoreOf(twin)) < 1e-9,
    `${JSON.stringify(evidenceOf(carded))} ${scoreOf(carded)} vs ${JSON.stringify(evidenceOf(twin))} ${scoreOf(twin)}`);
    const gate = mastery.checkMasteryEligibility(carded, 0.85, 0.8);
    ok('Easy on every card in the view is card evidence only, never an assessment', gate.passed_assessment === false
        && evidenceOf(carded).every(r => r.type === 'flashcard'), JSON.stringify(gate));
    // Undo names the rating it takes back, so a retry whose answer was lost
    // takes back nothing more: the session ended with every card rated.
    const ratingOf = (id) => db.prepare('SELECT review_count FROM flashcards WHERE id = ?').get(id).review_count;
    const lastRated = end.undoable;
    const logAtEnd = reviewRows();
    const firstUndo = data(await hostCall('review_undo', { sitting: rs, presentationId: lastRated }));
    const retried = await hostCall('review_undo', { sitting: rs, presentationId: lastRated });
    ok('an Undo sent again takes back nothing more: one rating out of the log, the same card back on screen',
        firstUndo.undone === true && !isErr(retried) && data(retried).undone === true && data(retried).duplicate === true
        && reviewRows() === logAtEnd - 1 && data(retried).card?.cardId === firstUndo.card?.cardId && data(retried).undoable === firstUndo.undoable
        && firstUndo.undoable !== lastRated, `${logAtEnd} → ${reviewRows()} rows; ${JSON.stringify(data(retried)).slice(0, 240)}`);
    const stale = await hostCall('review_undo', { sitting: rs, presentationId: 'not-the-last-one' });
    ok('an Undo naming a rating that is not the last one is refused and takes back nothing', isErr(stale) && reviewRows() === logAtEnd - 1, textOf(stale).slice(0, 160));
    // The rating before it is rated again in the app: Undo cannot take it back,
    // and the session then says so by naming the next one, or none.
    const behind = firstUndo.undoable;
    const behindCard = cardOfRating.get(behind);
    if (!behindCard) ok('after an Undo the app refused (rated again since), undoable names the next rating, never the one that is gone', false, `no rating named before the last: ${JSON.stringify(firstUndo).slice(0, 200)}`);
    else {
        const reRated = computeSrsUpdate(db.prepare('SELECT * FROM flashcards WHERE id = ?').get(behindCard), 'good', RERATED_AT);
        await fetch(`${appUrl}/api/ai/flashcards/${behindCard}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` }, body: JSON.stringify(reRated) });
        const countBehind = ratingOf(behindCard);
        const kept = data(await hostCall('review_undo', { sitting: rs, presentationId: behind }));
        ok('after an Undo the app refused (rated again since), undoable names the next rating, never the one that is gone',
            kept.undone === false && kept.undoable !== behind && ratingOf(behindCard) === countBehind, JSON.stringify(kept));
    }

    // The review as a learner takes it in the view: the first card Again (it
    // comes back), the second Easy, the first again Easy. Three ratings, two
    // cards. Then Undo on the done screen reopens the session, and the model,
    // told it had ended, hears the counts again.
    const viewPid = Number(db.prepare("INSERT INTO projects (name, color) VALUES ('Optics for the view gate', '#0369a1')").run().lastInsertRowid);
    const viewTopic = Number(db.prepare('INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, ?, 0)').run(viewPid, 'Lenses').lastInsertRowid);
    for (const n of [1, 2]) db.prepare("INSERT INTO flashcards (node_id, front, back, next_review) VALUES (?, ?, ?, '2026-01-05T09:00:00.000Z')").run(viewTopic, `Lens fact ${n}?`, `LENS-${n}`);
    const reviewOpened = await hostCall('review_cards', { project: String(viewPid) });
    const reviewView = await driveView(viewHtmlOf.review_cards, reviewOpened, hostCall);
    try {
        const { doc, until, press, calls, contexts } = reviewView;
        const ratings = [];
        for (let n = 0; n < 6 && await until(() => doc.querySelector('[data-focus="reveal"], .outcome-title')); n++) {
            if (doc.querySelector('.outcome-title')) break;
            await press('reveal');
            const rating = ratings.length === 0 ? 'again' : 'easy';
            await press(`rate-${rating}`);
            ratings.push(rating);
            await until(() => calls('review_next').length > ratings.length);
        }
        await until(() => doc.querySelector('.outcome-title') && contexts().length > 0);
        const doneText = doc.querySelector('.outcome')?.textContent || '';
        const endTold = contexts()[0]?.params?.structuredContent || {};
        ok('the done screen counts cards finished, not ratings: 3 ratings, "You reviewed 2 flashcards"',
            ratings.length === 3 && /You reviewed 2 flashcards/.test(doneText) && endTold.rated === 3 && endTold.reviewed === 2, `${JSON.stringify(ratings)} ${doneText} ${JSON.stringify(endTold)}`);
        await press('undo');
        await until(() => calls('review_undo').length > 0 && contexts().length > 1);
        const undoArgs = calls('review_undo')[0]?.params?.arguments || {};
        const reopened = contexts()[1]?.params?.structuredContent || {};
        ok('Undo on the done screen names the rating it takes back, and the model hears the reopened counts',
            typeof undoArgs.presentationId === 'string' && undoArgs.presentationId.length > 0 && reopened.rated === 2 && reopened.done === false,
            JSON.stringify({ undoArgs, contexts: contexts().map(c => c.params?.structuredContent) }));
    } finally {
        reviewView.close();
    }
    const closeFromReview = await hostCall('check_complete', { sitting: rs });
    ok('a review session has no way to complete a topic', isErr(closeFromReview) && db.prepare('SELECT status FROM nodes WHERE id = ?').get(carded).status !== 'completed');
    host.close();
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

// ---------------------------------------------------------------------------
console.log('\n--- a library made before evidence_mark gains it ---');
{
    // A library from an earlier build of this branch has mastery_claims without
    // the column every wrong claim now writes. Two child processes: one drops
    // the column, the next opens the library as the app would.
    const older = join(scratch, 'older');
    const env = { ...process.env, DB_PATH: join(older, 'older.db'), VAULT_ROOT: join(older, 'vault'), DATA_DIR: older };
    const COLUMN = "SELECT COUNT(*) AS n FROM pragma_table_info('mastery_claims') WHERE name = 'evidence_mark'";
    const open = (then) => spawnSync(process.execPath, ['--input-type=module', '-e',
        `const { default: db } = await import(${JSON.stringify(B + 'database.js')}); ${then} console.log('column=' + db.prepare(${JSON.stringify(COLUMN)}).get().n); db.close(); process.exit(0);`],
    { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const dropped = open("db.exec('ALTER TABLE mastery_claims DROP COLUMN evidence_mark');");
    const reopened = open('');
    ok('an older library gains mastery_claims.evidence_mark when it is opened', /column=0/.test(dropped.stdout) && /column=1/.test(reopened.stdout),
        `${dropped.stdout.trim().split('\n').pop()} → ${reopened.stdout.trim().split('\n').pop()} ${String(reopened.stderr).slice(-200)}`);
}

main.close();
done();
