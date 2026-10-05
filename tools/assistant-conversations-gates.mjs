// tools/assistant-conversations-gates.mjs — one assistant, many conversations.
//
// Run:  node tools/assistant-conversations-gates.mjs [--library <terramentor.db>]
//
// The app had two chats: a global assistant (one thread) and a per-topic AI
// Tutor (one thread per topic) that knew the topic but none of the assistant's
// tools, and two copies of the client code for sending, streaming and history.
// They are one assistant now. It takes the open topic's whole context from the
// page it is asked on, with no switch, and keeps a LIST of conversations
// instead of one thread that only Clear could reset. This asserts, against the
// REAL routes on a scratch library and a stub model on loopback (nothing
// billed, nothing leaves the machine):
//
//   1. a conversation's title is the first line of its first question, cut at
//      a word, and never empty for a real question;
//   2. the migration files the old global thread into one conversation and
//      each topic's tutor thread into one titled by the topic, loses no
//      message, frees the messages from their node (deleting the topic no
//      longer deletes them), and a second run changes nothing;
//   3. a turn asked with a topic open gets that topic's Overview, its next
//      topic WITH its id, and the teaching rules — and every library tool, with
//      no "Use docs" switch anywhere;
//   4. a turn with no conversation starts one (titled, remembering the topic),
//      a turn naming one continues it with ITS history and no other's, an
//      unknown id starts a new one rather than failing, and a first turn that
//      produced nothing takes its empty conversation with it;
//   5. the list is newest first, delete takes a conversation's messages, and
//      the tutor's routes are gone.
//
// `--library <path>` also runs the migration on a backup copy of a real
// library in a second process and checks every message landed somewhere.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const LIBRARY = argv.includes('--library') ? argv[argv.indexOf('--library') + 1] : null;

const scratch = mkdtempSync(join(tmpdir(), 'assistant-conversations-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};

// ---- 1. titles --------------------------------------------------------------------
console.log('\n1. a conversation is titled by its first question');
const { conversationTitle, migrateToConversations, TITLE_MAX } = await import('../server/chatConversations.js');
ok('a short question is its own title', conversationTitle('What is entropy?') === 'What is entropy?');
ok('the first non-empty line, whitespace collapsed', conversationTitle('\n\n  Why   is the sky\tblue?\nsecond line') === 'Why is the sky blue?');
const long = conversationTitle('Explain the difference between the electric field and the electric potential around a charged sphere please');
ok(`a long one is cut at a word, within ${TITLE_MAX} characters, and says it was cut`,
    long.length <= TITLE_MAX + 1 && long.endsWith('…') && !/\s…$/.test(long) && 'Explain the difference between the electric field and the electric potential'.startsWith(long.slice(0, -1)), long);
ok('one unbroken word longer than the limit is cut, not dropped', conversationTitle('x'.repeat(200)).length === TITLE_MAX + 1);

// ---- stub model --------------------------------------------------------------------
const requests = [];
let failNext = false;
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        const body = JSON.parse(raw || '{}');
        requests.push(body);
        if (failNext) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end('{"error":{"message":"stub: refused on purpose"}}');
        }
        const content = 'A stub answer.';
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 3 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

// ---- the real app on a scratch library -------------------------------------------
const { default: db } = await import('../server/database.js');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('embedding_enabled', 'false');
setSetting.run('ai_web_search', 'off');
setSetting.run('ui_language', 'en');
if (!/assistant-conversations-gates-/.test(process.env.DB_PATH)) throw new Error('refusing to run against a library that is not the scratch one');

const project = Number(db.prepare("INSERT INTO projects (name) VALUES ('Wave physics')").run().lastInsertRowid);
const addNode = (title, description, position) => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, description, position, status) VALUES (?, NULL, ?, ?, ?, ?)',
).run(project, title, description, position, 'not_started').lastInsertRowid);
const topicA = addNode('Standing waves', 'OVERVIEW-MARKER: nodes and antinodes on a string fixed at both ends.', 0);
const topicB = addNode('Doppler effect', 'The pitch of a moving source.', 1);

// ---- 2. migration ------------------------------------------------------------------
console.log('\n2. the migration files every old message into a conversation');
const oldRow = db.prepare("INSERT INTO chat_messages (node_id, project_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)");
oldRow.run(null, null, 'user', 'What should I do today?', '2026-09-01 10:00:00');
oldRow.run(null, null, 'assistant', 'Physics first.', '2026-09-01 10:00:05');
oldRow.run(topicA, project, 'user', 'Why do nodes not move?', '2026-09-02 09:00:00');
oldRow.run(topicA, project, 'assistant', 'Because the two waves cancel there.', '2026-09-02 09:00:09');
oldRow.run(topicA, project, 'user', 'And antinodes?', '2026-09-03 09:00:00');
oldRow.run(topicB, project, 'user', 'Is it like a siren?', '2026-09-04 09:00:00');
const before = db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n;
const made = migrateToConversations(db);
const convs = db.prepare('SELECT * FROM chat_conversations ORDER BY id').all();
ok('three threads become three conversations', made === 3 && convs.length === 3, JSON.stringify(convs));
ok('no message is lost and every one is filed', db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n === before
    && db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id IS NULL').get().n === 0);
const tutorA = convs.find(c => c.node_id === topicA);
ok("a topic's tutor thread is titled by the topic and remembers it", tutorA?.title === 'Standing waves');
ok('the global thread is titled by its first question', convs.some(c => c.node_id == null && c.title === 'What should I do today?'));
ok('timestamps are ISO, from the first and last message', tutorA?.created_at === '2026-09-02T09:00:00.000Z' && tutorA?.updated_at === '2026-09-03T09:00:00.000Z', JSON.stringify(tutorA));
ok('messages no longer hang off their node', db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE node_id IS NOT NULL OR project_id IS NOT NULL').get().n === 0);
ok('a second run changes nothing', migrateToConversations(db) === 0 && db.prepare('SELECT COUNT(*) AS n FROM chat_conversations').get().n === 3);
const scratchTopic = addNode('Scratch topic', '', 9);
db.prepare('UPDATE chat_conversations SET node_id = ? WHERE id = ?').run(scratchTopic, tutorA.id);
db.prepare('DELETE FROM nodes WHERE id = ?').run(scratchTopic);
ok('deleting the topic keeps the conversation and its messages, and forgets the topic',
    db.prepare('SELECT node_id FROM chat_conversations WHERE id = ?').get(tutorA.id)?.node_id == null
    && db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?').get(tutorA.id).n === 3);
// The gate's own seeded threads go, so the route half starts from an empty list.
db.prepare('DELETE FROM chat_messages').run();
db.prepare('DELETE FROM chat_conversations').run();

// ---- routes --------------------------------------------------------------------------
const { createApp } = await import('../server/app.js');
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** One assistant turn, read to its end. Returns the frames. */
async function ask(message, { conversationId, context } = {}) {
    requests.length = 0;
    const res = await fetch(`${base}/api/ai/assistant/stream`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, conversationId, context, timeZone: 'UTC' }),
    });
    const text = await res.text();
    const frames = text.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return {}; } });
    return { status: res.status, frames, conversationId: frames.find(f => typeof f.conversationId === 'number')?.conversationId ?? null };
}
const list = async () => (await fetch(`${base}/api/ai/conversations`)).json();
const messagesOf = async (id) => (await fetch(`${base}/api/ai/conversations/${id}/messages`)).json();
const systemOf = (body) => (body?.messages || []).find(m => m.role === 'system')?.content || '';

console.log('\n3. a turn asked with a topic open knows the topic, with no switch');
const first = await ask('Why are there nodes?', { context: { view: 'workspace', projectId: project, nodeId: topicA } });
const answerCall = requests.find(r => r.stream) || requests[requests.length - 1];
const sys = systemOf(answerCall);
ok('the turn finished', first.status === 200 && first.frames.some(f => f.done), JSON.stringify(first.frames.slice(-2)));
ok("the topic's Overview reaches the prompt", sys.includes('OVERVIEW-MARKER'));
ok('the next topic is named WITH its id, so the answer can point at it', sys.includes(`Next topic in this project: Doppler effect (nodeId ${topicB})`));
ok('the teaching rules are in the prompt', /TEACHING\. When the learner asks about something they are learning/.test(sys));
const toolNames = (answerCall?.tools || []).map(t => t.function?.name);
ok('every library tool rides with it — listing and reading documents too', ['find_in_library', 'project_state', 'list_documents', 'read_document', 'read_topic'].every(n => toolNames.includes(n)), toolNames.join(', '));
ok('and no web tool while the web is off', !toolNames.includes('search_web'));

console.log('\n4. conversations: start, continue, keep apart');
let rows = await list();
ok('the first turn started a conversation and said which', first.conversationId != null && rows.length === 1 && rows[0].id === first.conversationId);
ok('titled by the question, remembering the topic it began on', rows[0].title === 'Why are there nodes?' && rows[0].nodeId === topicA && rows[0].nodeTitle === 'Standing waves', JSON.stringify(rows[0]));
ok('holding the question and the answer', rows[0].messageCount === 2);

const second = await ask('And antinodes?', { conversationId: first.conversationId });
const histSecond = (requests.find(r => r.stream)?.messages || []).map(m => m.content).join('\n');
ok('naming a conversation continues it', second.conversationId === first.conversationId && (await messagesOf(first.conversationId)).length === 4);
ok('with its own history in the prompt', histSecond.includes('Why are there nodes?'));

const third = await ask('Plan my week');
const histThird = (requests.find(r => r.stream)?.messages || []).map(m => m.content).join('\n');
rows = await list();
ok('no id starts a new conversation', third.conversationId != null && third.conversationId !== first.conversationId && rows.length === 2);
ok("which does not carry another conversation's history", !histThird.includes('Why are there nodes?'));
ok('the list is newest first', rows[0].id === third.conversationId, JSON.stringify(rows.map(r => r.id)));

const ghost = await ask('Hello again', { conversationId: 999999 });
ok('an unknown id starts a new conversation rather than failing', ghost.status === 200 && ghost.conversationId != null && ghost.conversationId !== 999999 && (await list()).length === 3);

failNext = true;
const failed = await ask('This one will fail');
failNext = false;
ok('a first turn that produced nothing takes its conversation with it',
    failed.frames.some(f => f.error) && (await list()).length === 3 && !(await list()).some(r => r.title === 'This one will fail'));

console.log('\n5. delete, and the tutor routes are gone');
const del = await fetch(`${base}/api/ai/conversations/${first.conversationId}`, { method: 'DELETE' });
ok('delete removes the conversation and its messages', del.status === 200
    && !(await list()).some(r => r.id === first.conversationId)
    && db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?').get(first.conversationId).n === 0);
ok('a deleted conversation is a 404', (await fetch(`${base}/api/ai/conversations/${first.conversationId}/messages`)).status === 404);
for (const [method, path] of [['POST', '/api/ai/chat/stream'], ['POST', '/api/ai/chat'], ['GET', `/api/ai/chat/${topicA}`], ['POST', '/api/ai/today-chat/stream'], ['GET', '/api/ai/today-chat']]) {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{"message":"x","nodeId":1}' : undefined });
    ok(`${method} ${path} no longer answers`, r.status === 404, r.status);
}

server.close();
stub.close();

// ---- a real library, in a second process ------------------------------------------
if (LIBRARY) {
    console.log('\n6. the migration on a copy of a real library');
    const copyDir = mkdtempSync(join(tmpdir(), 'assistant-conversations-real-'));
    const Database = (await import('better-sqlite3')).default;
    const src = new Database(LIBRARY, { readonly: true });
    const copy = join(copyDir, 'copy.db');
    await src.backup(copy);
    const beforeRows = src.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n;
    const beforeThreads = src.prepare('SELECT COUNT(DISTINCT COALESCE(node_id, -1)) AS n FROM chat_messages').get().n;
    src.close();
    const boot = `process.env.DB_PATH=${JSON.stringify(copy)};process.env.VAULT_ROOT=${JSON.stringify(join(copyDir, 'vault'))};process.env.DATA_DIR=${JSON.stringify(copyDir)};await import(${JSON.stringify(new URL('../server/database.js', import.meta.url).href)});`;
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', boot], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
    const r1 = run();
    const after = new Database(copy, { readonly: true });
    const rowsAfter = after.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n;
    const unfiled = after.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id IS NULL').get().n;
    const convCount = after.prepare('SELECT COUNT(*) AS n FROM chat_conversations').get().n;
    after.close();
    console.log(`  (${beforeRows} messages in ${beforeThreads} threads; boot said: ${(r1.stdout.match(/filed .*/) || ['nothing'])[0]})`);
    ok('every message is still there and filed', rowsAfter === beforeRows && unfiled === 0, `${rowsAfter}/${beforeRows}, unfiled ${unfiled}${r1.stderr ? `; ${r1.stderr.slice(0, 300)}` : ''}`);
    ok('one conversation per old thread', convCount === beforeThreads, `${convCount} vs ${beforeThreads}`);
    run();
    const again = new Database(copy, { readonly: true });
    ok('a second boot changes nothing', again.prepare('SELECT COUNT(*) AS n FROM chat_conversations').get().n === convCount);
    again.close();
    rmSync(copyDir, { recursive: true, force: true });
}

try { db.close(); } catch { /* closed */ }
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
