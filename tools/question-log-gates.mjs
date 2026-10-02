// tools/question-log-gates.mjs — a bank of questions is WORKED THROUGH.
//
// Run:  node tools/question-log-gates.mjs
//
// Three surfaces read a topic's saved questions — the feed, the mastery check
// and the practice quiz — and each one reading its own way with no memory
// means the head of the newest row forever, a shuffle with no record of the
// last draw, or the whole row in one sitting (112 questions on a real
// imported topic). One log sits behind all three (server/questionLog.js),
// and this asserts the rule it draws by:
//
//   never asked first, then least recently asked, random within a tier;
//   ghosts never; what the client already holds never; a sitting is bounded;
//   a feed answer, a check and a quiz attempt all write the same log; and
//   a topic that owns a bank is asked FROM it rather than having a question
//   authored beside it.
//
// No model calls, no network. Scratch database, never the real library.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'question-log-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const {
    bankOf, orderForAsking, drawFromNode, drawFromQuiz, logAsked, askedCount, parseSavedKey,
    masteryCheckSize, DEFAULT_CHECK_SIZE, MIN_CHECK_SIZE, MAX_CHECK_SIZE, PRACTICE_SESSION_SIZE,
} = await import(B + 'questionLog.js');
const { composeFeed, consumeFeedItem } = await import(B + 'feed.js');
const { MIN_GATE_QUESTIONS } = await import(B + 'mastery.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const key = (q) => `${q.quizId}:${q.index}`;

// ---- fixture: one topic, two quiz rows, one ghost -----------------------------
const projectId = db.prepare("INSERT INTO projects (name) VALUES ('Bank')").run().lastInsertRowid;
const nodeId = db.prepare("INSERT INTO nodes (project_id, title, description) VALUES (?, 'Lidwoorden', ?)").run(projectId, 'y'.repeat(1300)).lastInsertRowid;
const mc = (i) => ({ question: `Q${i}?`, type: 'multiple_choice', options: ['de', 'het'], correct_answer: 'de', explanation: 'de' });
const quizA = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)')
    .run(nodeId, 'A', JSON.stringify([mc(1), mc(2), mc(3), { ...mc(4), isGhost: true, ghostNodeId: 999 }, mc(5)])).lastInsertRowid;
const quizB = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)')
    .run(nodeId, 'B', JSON.stringify([mc(6), mc(7), mc(8)])).lastInsertRowid;

console.log('--- the bank ---');
const bank = bankOf(nodeId);
check('every non-ghost question across every row, tagged with where it lives', bank.map(key), [`${quizA}:0`, `${quizA}:1`, `${quizA}:2`, `${quizA}:4`, `${quizB}:0`, `${quizB}:1`, `${quizB}:2`]);
check('a ghost is never in it', bank.some(b => b.question.isGhost), false);
check('the feed key round-trips', parseSavedKey(`savedq-${quizA}-4`), { quizId: quizA, index: 4 });
check('...and a key that is not one parses to nothing', parseSavedKey('fi-12'), null);

console.log('\n--- the draw: never asked first, then least recently ---');
check('nothing asked yet: the whole bank, in some order', orderForAsking(bank).length, 7);
logAsked([{ quizId: quizA, index: 0, correct: true }, { quizId: quizA, index: 1, correct: false }], 'quiz');
let ordered = orderForAsking(bank);
check('the two asked come LAST', ordered.slice(-2).map(key).sort(), [`${quizA}:0`, `${quizA}:1`]);
check('...and the five never asked come first', ordered.slice(0, 5).every(q => !['0', '1'].includes(String(q.index)) || q.quizId !== quizA), true);
// Make the first asked older than the second by asking the second again later.
logAsked([{ quizId: quizA, index: 1 }], 'feed');
ordered = orderForAsking(bank);
check('among the asked, the least recently asked comes before the more recently asked',
    ordered.slice(-2).map(key), [`${quizA}:0`, `${quizA}:1`]);
check('a wrong answer is not moved up — the estimate that decides is BKT’s, not this log’s',
    ordered.slice(0, 5).some(q => key(q) === `${quizA}:1`), false);
check('what the client already holds is excluded', orderForAsking(bank, { exclude: new Set([`${quizB}:0`, `${quizB}:1`]) }).some(q => q.quizId === quizB && q.index < 2), false);
check('a draw is bounded by its size', drawFromNode(nodeId, 3).questions.length, 3);
check('...and reports the bank it drew from', drawFromNode(nodeId, 3).bankSize, 7);
check('a draw from one row stays in that row', drawFromQuiz(quizB, 10).questions.every(q => q.quizId === quizB), true);
check('...bounded by the row', drawFromQuiz(quizB, 10).questions.length, 3);
check('...and names the row’s node', drawFromQuiz(quizB, 1).nodeId, nodeId);
check('asked count is distinct questions, not rows in the log', askedCount(nodeId), 2);

console.log('\n--- the log takes only what exists ---');
check('a quiz that does not exist is not logged', logAsked([{ quizId: 99999, index: 0 }], 'quiz'), 0);
check('a malformed entry is skipped, a good one beside it kept', logAsked([{ index: 'x' }, { quizId: quizB, index: 2 }], 'quiz'), 1);
check('the log row records where and how it went',
    db.prepare('SELECT surface, correct FROM question_log ORDER BY id DESC LIMIT 1').get(), { surface: 'quiz', correct: null });
check('a deleted quiz takes its log with it (cascade)', (() => {
    const tmp = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(nodeId, 'tmp', '[]').lastInsertRowid;
    logAsked([{ quizId: tmp, index: 0 }], 'quiz');
    db.prepare('DELETE FROM quizzes WHERE id = ?').run(tmp);
    return db.prepare('SELECT COUNT(*) AS n FROM question_log WHERE quiz_id = ?').get(tmp).n;
})(), 0);

console.log('\n--- the check’s size is a bounded setting ---');
check('default', masteryCheckSize(() => null), DEFAULT_CHECK_SIZE);
check('a value is honoured', masteryCheckSize((k, d) => (k === 'mastery_check_size' ? '12' : d)), 12);
check('too small is the floor — a two-question check is not an observation', masteryCheckSize(() => '1'), MIN_CHECK_SIZE);
check('too big is the ceiling — a sixty-question check is the sitting this exists to end', masteryCheckSize(() => '60'), MAX_CHECK_SIZE);
check('nonsense is the default', masteryCheckSize(() => 'lots'), DEFAULT_CHECK_SIZE);
check('the practice sitting is bounded too', PRACTICE_SESSION_SIZE <= MAX_CHECK_SIZE, true);

console.log('\n--- the feed asks FROM the bank ---');
// The degraded path (no plan, AI off): the topic has an overview and a bank.
db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', 'false') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
const stream = composeFeed({ limit: 20, excludeKeys: new Set(), gate: { mode: 'advisory', threshold: 0.85, checkPass: 0.8, decayDays: 14 }, nodeId });
const served = stream.items.filter(c => c.kind === 'question' && c.source === 'saved');
check('a topic stream serves saved questions', served.length, 2);
check('...the never-asked ones, not the head of the newest row',
    served.every(c => { const p = parseSavedKey(c.key); return !(p.quizId === quizA && p.index <= 1) && !(p.quizId === quizB && p.index === 2); }), true);
check('...and never the ghost', served.some(c => c.question.isGhost), false);
const heldKeys = new Set(served.map(c => c.key));
const again = composeFeed({ limit: 20, excludeKeys: heldKeys, gate: { mode: 'advisory' }, nodeId });
const servedAgain = again.items.filter(c => c.kind === 'question' && c.source === 'saved');
check('the next page never repeats what the client holds', servedAgain.every(c => !heldKeys.has(c.key)), true);

// Answering one through the feed writes the log with the outcome.
//
// What was here read `askedCount(nodeId) >= 3` — a FLOOR the three `logAsked`
// calls in the sections above had already met, so both calls below could be
// deleted and it still passed. It is a DELTA now, and the row is read back.
//
// The consume route (`POST /api/feed/consume`) makes ONE call: `consumeFeedItem`
// writes the evidence and a bank question's log row in one transaction
// (2026-09-30 — the route used to log it separately, after the evidence had
// already committed, so a failed log write left the answer counted and the
// question unlogged). So the one call is made here, and the log is counted in
// ROWS, which is what fails if the call stops writing it.
const logRows = () => db.prepare('SELECT COUNT(*) AS n FROM question_log').get().n;
const first = served[0];
const answered = parseSavedKey(first.key);
const before = askedCount(nodeId);
const rowsBefore = logRows();
const evidenceBefore = db.prepare('SELECT COUNT(*) AS n FROM mastery_evidence WHERE node_id = ?').get(nodeId).n;
consumeFeedItem({ key: first.key, kind: 'question', nodeId, result: { correct: true } });
check('a feed answer writes exactly one log row', logRows() - rowsBefore, 1);
check('a feed answer is remembered as asked — one more question, not a floor already met',
    askedCount(nodeId) - before, 1);
check('…and it is the question that was answered, logged against the feed',
    db.prepare('SELECT quiz_id AS quizId, question_index AS idx, surface, correct FROM question_log ORDER BY id DESC LIMIT 1').get(),
    { quizId: answered.quizId, idx: answered.index, surface: 'feed', correct: 1 });
check('…and the writer beside it recorded the answer as mastery evidence',
    db.prepare('SELECT COUNT(*) AS n FROM mastery_evidence WHERE node_id = ?').get(nodeId).n - evidenceBefore, 1);

// The AI path: a plan with one lesson part and no question row for it.
db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
const plan = JSON.stringify({ parts: [{ title: 'Part 1', focus: 'de/het' }, { title: 'Part 2', focus: 'plural' }] });
db.prepare("INSERT INTO feed_items (node_id, kind, seq, status, content, meta) VALUES (?, 'plan', 0, 'ready', ?, '{}')").run(nodeId, plan);
db.prepare("INSERT INTO feed_items (node_id, kind, seq, status, content, meta) VALUES (?, 'lesson', 1, 'ready', 'Part one text', ?)").run(nodeId, JSON.stringify({ partIndex: 1, partCount: 2 }));
db.prepare("INSERT INTO feed_items (node_id, kind, seq, status, content, meta) VALUES (?, 'lesson', 3, 'ready', 'Part two text', ?)").run(nodeId, JSON.stringify({ partIndex: 2, partCount: 2 }));
db.prepare("INSERT INTO feed_items (node_id, kind, seq, status, content, meta) VALUES (?, 'question', 4, 'ready', ?, '{}')").run(nodeId, JSON.stringify(mc(99)));
// A bank covers the WHOLE topic and says nothing about which part teaches what,
// so with no map placing its questions by part it is asked after the LAST part
// and never after an earlier one. What this asserted before 2026-10-01 was the
// defect: two bank questions straight after part 1, which on the Dutch course
// asked "why is the plural of maan manen?" before the part that teaches open
// syllables. The placed case is the end-to-end section below.
const streamKinds = () => composeFeed({ limit: 20, excludeKeys: new Set(), gate: { mode: 'advisory' }, nodeId })
    .items.filter(c => c.nodeId === nodeId).map(c => `${c.kind}:${c.source || ''}`);
const ai = composeFeed({ limit: 20, excludeKeys: new Set(), gate: { mode: 'advisory' }, nodeId });
check('nothing from the bank after part 1 of 2; after the last part’s generated question, one',
    streamKinds(), ['lesson:generated', 'lesson:generated', 'question:generated', 'question:saved']);
check('the bank cards carry the feed key the log reads', ai.items.filter(c => c.source === 'saved').every(c => parseSavedKey(c.key)), true);
const lastQ = db.prepare("SELECT id FROM feed_items WHERE node_id = ? AND kind = 'question' AND seq = 4").get(nodeId).id;
db.prepare("UPDATE feed_items SET status = 'skipped' WHERE id = ?").run(lastQ);
check('the last part with no generated question: two from the bank, after it',
    streamKinds(), ['lesson:generated', 'lesson:generated', 'question:saved', 'question:saved']);
db.prepare("INSERT INTO feed_items (node_id, kind, seq, status, content, meta) VALUES (?, 'question', 2, 'ready', ?, '{}')").run(nodeId, JSON.stringify(mc(98)));
check('part 1’s own question is asked after part 1, and the bank still waits for the end',
    streamKinds(), ['lesson:generated', 'question:generated', 'lesson:generated', 'question:saved', 'question:saved']);
db.prepare("DELETE FROM feed_items WHERE node_id = ? AND kind = 'question' AND seq = 2").run(nodeId);
db.prepare("UPDATE feed_items SET status = 'ready' WHERE id = ?").run(lastQ);

console.log('\n--- a topic that owns a bank: its questions are placed by part first ---');
// The bank it consults is what a draw can ASK — never a question no verifier
// confirmed (tools/question-trust-gates.mjs asserts that half).
const { nextMissing, generateForNode } = await import(B + 'feedGen.js');
const missing = () => { const m = nextMissing(nodeId); return m && { type: m.type, i: m.i }; };
const planId = db.prepare("SELECT id FROM feed_items WHERE node_id = ? AND kind = 'plan'").get(nodeId).id;
check('part 1 written, part 1 unread: place the bank by part before deciding part 1’s question', missing(), { type: 'bank-map', i: undefined });
db.prepare("UPDATE feed_items SET meta = ? WHERE id = ?").run(JSON.stringify({ bankParts: { failed: true } }), planId);
check('a map that failed: an earlier part gets its own question, written from the part', missing(), { type: 'question', i: 1 });
db.prepare("UPDATE feed_items SET status = 'consumed' WHERE node_id = ? AND kind = 'lesson' AND seq = 1").run(nodeId);
check('...unless the learner has already read that part', missing()?.type === 'question', false);
db.prepare("UPDATE feed_items SET status = 'ready' WHERE node_id = ? AND kind = 'question' AND seq = 4").run(nodeId);
db.prepare("DELETE FROM feed_items WHERE node_id = ? AND kind = 'question' AND seq = 4").run(nodeId);
check('the last part is asked from the bank, so none is authored for it', missing()?.type === 'question', false);
db.prepare("UPDATE feed_items SET status = 'ready' WHERE node_id = ? AND kind = 'lesson' AND seq = 1").run(nodeId);
check('the bank threshold is the gate’s own', MIN_GATE_QUESTIONS, 4);

console.log('\n--- end to end: the bank is placed by part, and each part asks only its own ---');
// The generator's `bank-map` step against a stub model on loopback (the app's
// own AI_BASE_URL override), then the real composer. The stub places a
// question in part 1 when its stem says so, else in part 2 — so what is
// asserted is the wiring: prompt order → uuid → stored map → the draw.
const { createServer } = await import('node:http');
let stubAnswer = (stems) => ({ parts: stems.map(s => (s.includes('part one') ? 1 : 2)) });
let mapRequests = 0;
const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const msgs = (() => { try { return JSON.parse(body).messages || []; } catch { return []; } })();
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.find(m => m.role === 'user')?.content || '';
        if (!system.includes('question bank to the lesson parts')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"stub: not part of this gate"}}'); return; }
        mapRequests++;
        const stems = user.split('QUESTIONS')[1].split('\n').filter(l => /^\d+\. /.test(l));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(stubAnswer(stems)) }, finish_reason: 'stop' }], usage: { completion_tokens: 20 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

const mkTopic = (title) => {
    const id = db.prepare("INSERT INTO nodes (project_id, title, description) VALUES (?, ?, ?)").run(projectId, title, 'z'.repeat(1300)).lastInsertRowid;
    const stems = ['about part one: alphabet', 'about part two: open syllable', 'about part one: ij', 'about part two: maan manen', 'about part two: pot potten'];
    db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(id, title, JSON.stringify(stems.map(s => ({ ...mc(0), question: s }))));
    db.prepare("INSERT INTO feed_items (node_id, kind, seq, status, content, meta) VALUES (?, 'plan', 0, 'internal', ?, '{}')").run(id, plan);
    db.prepare("INSERT INTO feed_items (node_id, kind, seq, status, content, meta) VALUES (?, 'lesson', 1, 'ready', 'Part one text', ?)").run(id, JSON.stringify({ partIndex: 1, partCount: 2 }));
    db.prepare("INSERT INTO feed_items (node_id, kind, seq, status, content, meta) VALUES (?, 'lesson', 3, 'ready', 'Part two text', ?)").run(id, JSON.stringify({ partIndex: 2, partCount: 2 }));
    return id;
};
/** Run the generator for one topic until it reaches anything but the placement step. */
const runPlacement = async (id) => {
    const ac = new AbortController();
    try { await generateForNode(id, { signal: ac.signal, onStep: (label) => { if (label !== 'question placement') ac.abort(); } }); } catch { /* the abort, by design */ }
    return JSON.parse(db.prepare("SELECT meta FROM feed_items WHERE node_id = ? AND kind = 'plan'").get(id).meta).bankParts;
};
const topicStream = (id) => composeFeed({ limit: 20, excludeKeys: new Set(), gate: { mode: 'advisory' }, nodeId: id })
    .items.filter(c => c.nodeId === id).map(c => (c.kind === 'lesson' ? `lesson ${c.partIndex}` : c.question.question));

const placed = mkTopic('Alphabet and open syllables');
const bankParts = await runPlacement(placed);
check('one model call places the bank', mapRequests, 1);
check('every question is stored under its uuid at the part the model gave it',
    Object.values(bankParts?.map || {}).sort(), [1, 1, 2, 2, 2]);
check('...and the map names the model that made it', bankParts?.generated_by?.model ?? bankParts?.model ?? null, 'stub-model');
check('part 1 is covered by the bank, so no question is authored for it — or for the last part',
    ['question', 'bank-map'].includes(nextMissing(placed)?.type), false);
// The draw is shuffled, so one composition can put the part-1 questions first
// by luck (1 in 10 with no filter at all). Twenty compositions, nothing written
// between them, all of the same shape: luck passes that 1 time in 10^20.
const shapes = new Set(Array.from({ length: 20 }, () => {
    const s = topicStream(placed);
    return JSON.stringify([s[0], s.slice(1, 3).every(q => q.includes('part one')), s[3], s.slice(4).every(q => q.includes('part two')), s.length]);
}));
check('after part 1, the two part-1 questions; after part 2, part-2 questions only (20 draws)',
    [...shapes], [JSON.stringify(['lesson 1', true, 'lesson 2', true, 6])]);

stubAnswer = () => ({ parts: [1, 2] }); // wrong length, twice
const unplaced = mkTopic('A bank the model could not place');
check('an answer that does not place every question is recorded as a failed map', (await runPlacement(unplaced))?.failed, true);
check('...after two attempts, and not retried', [mapRequests, nextMissing(unplaced)?.type], [3, 'question']);
const u = topicStream(unplaced);
check('...and the whole bank then waits for the last part', [u[0], u[1], u.slice(2).every(q => q.startsWith('about'))], ['lesson 1', 'lesson 2', true]);
// Closed and awaited before process.exit: exiting while the server's handles
// were still closing aborted node on Windows (a libuv assertion, exit 127).
stub.closeAllConnections();
await new Promise(r => stub.close(r));

try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not process.exit(): exiting while the stub's sockets were still
// closing aborted node on Windows with a libuv assertion (exit 127), as
// head-start-gates found before this file did.
process.exitCode = fail ? 1 : 0;
