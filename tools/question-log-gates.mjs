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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
// The production path is the consume ROUTE (`POST /api/feed/consume`,
// server/index.js): it calls `consumeFeedItem` for the mastery half and
// `logAsked` for the log half, and `consumeFeedItem` writes no log row of its
// own. So the route's two calls are made here in the route's own order, each
// with an assertion that fails without it — and the route is pinned by a
// source scan, because a pair of calls made here proves nothing about the pair
// the server makes.
const INDEX_SRC = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const ROUTE_LOGS = /const saved = kind === 'question' \? parseSavedKey\(key\) : null;[\s\S]{0,200}?logAsked\(\[\{ \.\.\.saved, correct:[^\n]*\}\], 'feed'\);/;
check('the consume route logs a saved question as asked, against the feed', ROUTE_LOGS.test(INDEX_SRC), true);
check('…and the scan is anchored on that call, not on the rest of the file',
    ROUTE_LOGS.test(INDEX_SRC.replace(ROUTE_LOGS, '')), false);

const first = served[0];
const answered = parseSavedKey(first.key);
const before = askedCount(nodeId);
const evidenceBefore = db.prepare('SELECT COUNT(*) AS n FROM mastery_evidence WHERE node_id = ?').get(nodeId).n;
consumeFeedItem({ key: first.key, kind: 'question', nodeId, result: { correct: true } });
logAsked([{ ...answered, correct: true }], 'feed');
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
const ai = composeFeed({ limit: 20, excludeKeys: new Set(), gate: { mode: 'advisory' }, nodeId });
const kinds = ai.items.filter(c => c.nodeId === nodeId).map(c => `${c.kind}:${c.source || ''}`);
check('after a part with no generated question, two from the bank; after a generated question, one more',
    kinds, ['lesson:generated', 'question:saved', 'question:saved', 'lesson:generated', 'question:generated', 'question:saved']);
check('the bank cards carry the feed key the log reads', ai.items.filter(c => c.source === 'saved').every(c => parseSavedKey(c.key)), true);

console.log('\n--- a topic that owns a bank has no question authored beside it ---');
const src = (await import('node:fs')).readFileSync(new URL('../server/feedGen.js', import.meta.url), 'utf8');
check('nextMissing consults the bank before asking for a question', /const banked = ownedQuestions\(nodeId\) >= MIN_GATE_QUESTIONS/.test(src), true);
check('...and only authors one when there is none', /if \(!banked && !bySeq\.has\(i \* 2\)/.test(src), true);
check('the bank threshold is the gate’s own', MIN_GATE_QUESTIONS, 4);

try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
