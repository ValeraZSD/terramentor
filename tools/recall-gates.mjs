// tools/recall-gates.mjs — a fading topic is reviewed on its own, by its hardest question.
//
// Run:  node tools/recall-gates.mjs
//
// A topic answered well here and then left alone past the decay window is
// FADING (server/fading.js). The stream brings it back by itself, with no
// button to press: a review round at the TOP of the home stream and of a
// course's stream, one question from each fading topic, oldest first, at most
// `feed_recall_per_batch` of them, and only one round per visit. A topic's own
// page never carries one.
//
// Which question: picked by DIFFICULTY from the one record every surface writes
// (question_log). The hardest the learner has got right before comes first; a
// topic with no record starts from the format a guess cannot pass; a question
// only ever missed comes last; the one the topic's previous recall asked is
// never asked next. Only questions a draw could hand out at all: a usable key,
// confirmed by a verifier. A recall answer is recorded in the same log.
//
// No model calls, no network, no clock: every fading stamp sits in 2020 and
// every fresh one in 2099, and the pick takes a pinned `now`.
// Scratch database, never the real library.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'recall-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const { logAsked, recallOrder } = await import(B + 'questionLog.js');
const { getGhostQuestions } = await import(B + 'dailyPlan.js');
const { composeFeed, consumeFeedItem } = await import(B + 'feed.js');
const { markPending } = await import(B + 'questionTrust.js');

const NOW = new Date(process.env.RECALL_GATES_NOW || '2026-06-11T12:00:00.000Z');
const LONG_AGO = (d) => `2020-01-${String(d).padStart(2, '0')} 09:00:00`;
const FAR_AHEAD = '2099-01-01 09:00:00';

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- fixture ------------------------------------------------------------------
const project = (name) => db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid;
const topic = (pid, title, status = 'completed', description = '') =>
    db.prepare('INSERT INTO nodes (project_id, title, status, description) VALUES (?, ?, ?, ?)').run(pid, title, status, description).lastInsertRowid;
const mastered = (nodeId, lastUpdated) => db.prepare(
    'INSERT INTO node_mastery (node_id, mastery_score, total_attempts, correct_attempts, last_updated) VALUES (?, 0.9, 6, 5, ?)',
).run(nodeId, lastUpdated);
const bank = (nodeId, questions) => db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)')
    .run(nodeId, 'bank', JSON.stringify(questions)).lastInsertRowid;
const mc = (s) => ({ question: s, type: 'multiple_choice', options: ['yes', 'no'], correct_answer: 'yes', explanation: 'e' });
const tf = (s) => ({ question: s, type: 'true_false', correct_answer: 'True', explanation: 'e' });
const typed = (s) => ({ question: s, type: 'short_answer', correct_answer: 'an answer', explanation: 'e' });
const asked = (quizId, index, right, wrong) => logAsked([
    ...Array.from({ length: right }, () => ({ quizId, index, correct: true })),
    ...Array.from({ length: wrong }, () => ({ quizId, index, correct: false })),
], 'quiz');

const physics = project('Physics');
const dutch = project('Dutch');
const broken = project('Broken bank');

// A: answer history across two rows of its bank.
const A = topic(physics, 'Optics');
mastered(A, LONG_AGO(1));
const aRow1 = bank(A, [tf('A easy, always right'), mc('A hard, right once'), typed('A only ever missed')]);
const aRow2 = bank(A, [mc('A never asked, multiple choice'), typed('A never asked, typed'),
    { ...mc('A unusable key'), correct_answer: 'maybe' }, markPending(typed('A unverified'), { now: NOW.getTime() })]);
asked(aRow1, 0, 3, 0);
asked(aRow1, 1, 1, 2);
asked(aRow1, 2, 0, 2);

// B: no record at all, three formats.
const Bn = topic(physics, 'Waves');
mastered(Bn, LONG_AGO(20));
bank(Bn, [tf('B true/false'), mc('B multiple choice'), typed('B typed')]);

// F: fresh, never reviewed. T: an open topic the stream teaches.
const F = topic(physics, 'Fresh');
mastered(F, FAR_AHEAD);
bank(F, [mc('F fresh')]);
const T = topic(physics, 'Current topic', 'in_progress', 'y'.repeat(1300));

// C: the other course. D: fading with nothing to ask.
const C = topic(dutch, 'Lidwoorden');
mastered(C, LONG_AGO(10));
bank(C, [mc('C de or het')]);
const D = topic(dutch, 'No bank');
mastered(D, LONG_AGO(2));

// E: fading, and every question in its bank is one no draw may hand out.
const E = topic(broken, 'Unusable');
mastered(E, LONG_AGO(3));
bank(E, [{ ...mc('E unusable key'), correct_answer: 'maybe' }, markPending(mc('E unverified'), { now: NOW.getTime() })]);

// Every page is composed at the pinned instant: which topics fade, and how
// long ago, never depend on the day the gate runs.
const feed = (opts) => composeFeed({ now: NOW, ...opts });
const stems = (ghost) => ghost?.questions.map(q => q.question) ?? null;
const ghostOf = (pid, nodeId) =>
    getGhostQuestions(pid, 10, 14, NOW).find(g => g.nodeId === nodeId) ?? null;

console.log('--- which question: by difficulty ---');
check('the hardest question got right before comes first, then the rest of what was got right',
    stems(ghostOf(physics, A)), ['A hard, right once', 'A easy, always right']);
check('the whole order: got right (hardest first), then no record (typed first), then only ever missed',
    getGhostQuestions(physics, 10, 14, NOW, { perTopic: 10 }).find(g => g.nodeId === A)?.questions.map(q => q.question),
    ['A hard, right once', 'A easy, always right', 'A never asked, typed', 'A never asked, multiple choice', 'A only ever missed']);
check('the same pick every time: no lottery',
    new Set(Array.from({ length: 12 }, () => JSON.stringify(stems(ghostOf(physics, A))))).size, 1);
check('with no record, the format a guess cannot pass comes first (typed, then multiple choice)',
    stems(ghostOf(physics, Bn)), ['B typed', 'B multiple choice']);
check('a question with an unusable key or no verifier’s yes is never picked',
    getGhostQuestions(broken, 10, 14, NOW).map(g => g.nodeId), []);
check('a fresh topic is not fading, so nothing is picked from it', ghostOf(physics, F), null);
check('each pick says where it lives, so its answer is recorded against it',
    ghostOf(physics, A)?.picks?.map(p => [p.quizId, p.index]), [[aRow1, 1], [aRow1, 0]]);

console.log('\n--- the review round in the stream ---');
const recallCards = (feed) => feed.items.filter(i => i.kind === 'recall');
const home = feed({ limit: 15, excludeKeys: new Set() });
const firstOwn = home.items.findIndex(i => i.kind !== 'notice');
const homeRecall = recallCards(home);
check('the round opens the stream: the first cards after any notice are the recall questions',
    home.items.slice(firstOwn, firstOwn + homeRecall.length).every(i => i.kind === 'recall') && homeRecall.length > 0, true);
check('one question from each fading topic that has one, oldest first, across courses',
    homeRecall.map(c => c.nodeId), [A, C, Bn]);
check('...each the topic’s first pick by difficulty',
    homeRecall.map(c => c.question.question), ['A hard, right once', 'C de or het', 'B typed']);
check('every card in it is marked as the round, so the stream can say what it is',
    homeRecall.map(c => c.review), [true, true, true]);
check('the topic being taught comes after the round',
    home.items.findIndex(i => i.nodeId === T) > home.items.indexOf(homeRecall.at(-1)), true);

db.prepare(`INSERT INTO settings (key, value) VALUES ('feed_recall_per_batch', '2')`).run();
check('its size is the existing "Recall questions per batch" setting',
    recallCards(feed({ limit: 15, excludeKeys: new Set() })).map(c => c.nodeId), [A, C]);
db.prepare(`UPDATE settings SET value = '0' WHERE key = 'feed_recall_per_batch'`).run();
check('...and 0 turns it off', recallCards(feed({ limit: 15, excludeKeys: new Set() })).length, 0);
db.prepare(`DELETE FROM settings WHERE key = 'feed_recall_per_batch'`).run();

const held = new Set(home.items.map(i => i.key));
check('one round per visit: the next page of the same stream carries no recall',
    recallCards(feed({ limit: 15, excludeKeys: held })).length, 0);
check('only the opening page starts one: a later page holding no recall card (topics faded since) has none either',
    recallCards(feed({ limit: 15, excludeKeys: new Set(home.items.filter(i => i.kind !== 'recall').map(i => i.key)) })).length, 0);
check('never longer than the page asked for',
    recallCards(feed({ limit: 2, excludeKeys: new Set() })).map(c => c.nodeId), [A, C]);
check('a course’s stream reviews that course’s topics only',
    recallCards(feed({ limit: 15, excludeKeys: new Set(), projectId: dutch })).map(c => c.nodeId), [C]);
check('a topic’s own page carries no review round',
    recallCards(feed({ limit: 15, excludeKeys: new Set(), nodeId: T })).length, 0);

console.log('\n--- an answer is recorded, and moves the next pick on ---');
const card = homeRecall[0];
const stampOf = (nodeId) => db.prepare('SELECT last_updated FROM node_mastery WHERE node_id = ?').get(nodeId).last_updated;
const stampBefore = stampOf(A);
consumeFeedItem({ key: card.key, kind: 'recall', nodeId: card.nodeId, result: { correct: true }, attemptId: 'recall-gate-1', uuid: card.question.uuid ?? null });
check('a recall answer is recorded in the question log, as a recall',
    db.prepare(`SELECT surface, correct FROM question_log WHERE node_id = ? AND surface = 'recall'`).all(A), [{ surface: 'recall', correct: 1 }]);
check('...and still writes its evidence',
    db.prepare(`SELECT COUNT(*) AS n FROM mastery_evidence WHERE node_id = ? AND metadata LIKE '%"ghost":true%'`).get(A).n, 1);
check('...and restarts the topic’s decay timer',
    stampOf(A) > stampBefore, true);
// The answer stamps the wall clock; pin it to NOW so the round below reads no clock.
db.prepare('UPDATE node_mastery SET last_updated = ? WHERE node_id = ?')
    .run(NOW.toISOString().replace('T', ' ').slice(0, 19), A);
check('the answered topic is no longer fading, so the next visit’s round leaves it out',
    recallCards(feed({ limit: 15, excludeKeys: new Set() })).map(c => c.nodeId), [C, Bn]);
db.prepare('UPDATE node_mastery SET last_updated = ? WHERE node_id = ?').run(LONG_AGO(1), A);
check('when it fades again, the question its last recall asked is not asked next',
    stems(ghostOf(physics, A))?.[0], 'A easy, always right');

db.prepare('UPDATE node_mastery SET last_updated = ?').run(FAR_AHEAD);
check('nothing fading: no round at all', recallCards(feed({ limit: 15, excludeKeys: new Set() })).length, 0);

console.log('\n--- ties, and an answer nobody judged ---');
// G is not fading (its own course, a stamp in 2099): only its order is read.
const G = topic(project('Ties'), 'Tied');
mastered(G, FAR_AHEAD);
const gRow = bank(G, [mc('G asked lately'), mc('G asked long ago'), mc('G never asked, first in the bank'), mc('G never asked, second in the bank')]);
asked(gRow, 0, 1, 0);
asked(gRow, 1, 1, 0);
const askedAt = db.prepare('UPDATE question_log SET asked_at = ? WHERE quiz_id = ? AND question_index = ?');
askedAt.run('2020-03-01T09:00:00.000Z', gRow, 0);
askedAt.run('2020-01-01T09:00:00.000Z', gRow, 1);
check('tied on difficulty and format: the one asked longest ago first, then the bank’s order',
    recallOrder(G).map(b => b.question.question),
    ['G asked long ago', 'G asked lately', 'G never asked, first in the bank', 'G never asked, second in the bank']);
consumeFeedItem({ key: `recall-${G}-${gRow}-2`, kind: 'recall', nodeId: G, result: { correct: false, gradedBy: 'fallback' }, attemptId: 'recall-gate-2' });
check('an answer the grader never judged is logged as asked, never as a miss',
    db.prepare('SELECT surface, correct FROM question_log WHERE quiz_id = ? AND question_index = 2').all(gRow), [{ surface: 'recall', correct: null }]);

// K's second question answered right as a copy inside G's practice quiz: the
// log row is G's quiz, matched back to K by the uuid the copy keeps.
const K = topic(project('Copies'), 'Copied');
mastered(K, FAR_AHEAD);
const kRow = bank(K, [mc('K one'), mc('K two, answered as a copy elsewhere')]);
const kTwo = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(kRow).questions)[1];
const hostRow = bank(G, [{ ...kTwo, isGhost: true, ghostNodeId: K }]);
logAsked([{ quizId: hostRow, uuid: kTwo.uuid, correct: true }], 'quiz');
check('an answer to a copy in another topic’s practice quiz counts in the question’s record',
    recallOrder(K).map(b => b.question.question), ['K two, answered as a copy elsewhere', 'K one']);

console.log('\n--- a finished library with one topic fading ---');
db.prepare(`UPDATE nodes SET status = 'completed'`).run();
db.prepare('UPDATE node_mastery SET last_updated = ? WHERE node_id = ?').run(LONG_AGO(10), C);
const done1 = feed({ limit: 15, excludeKeys: new Set() });
check('the round is the whole stream, with no "all caught up" under it',
    done1.items.map(i => i.key), [`recall-${C}-${db.prepare('SELECT id FROM quizzes WHERE node_id = ?').get(C).id}-0`]);
check('...and the next page does not claim "no reviews due" below the round either',
    feed({ limit: 15, excludeKeys: new Set(done1.items.map(i => i.key)) }).items.map(i => i.key), []);

console.log('\n--- past the oldest ten ---');
// Eleven fading topics: the ten oldest have nothing to ask, the youngest does.
const crowded = project('Crowded');
for (let d = 1; d <= 10; d++) mastered(topic(crowded, `Nothing to ask ${d}`), LONG_AGO(d));
const asks = topic(crowded, 'Has a question');
mastered(asks, LONG_AGO(20));
bank(asks, [mc('the eleventh topic’s question')]);
check('a fading topic behind ten with nothing to ask still gets its recall',
    getGhostQuestions(crowded, 4, 14, NOW).map(g => g.nodeId), [asks]);

console.log(`\n${pass} passed, ${fail} failed`);
db.close();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a Windows handle may linger */ }
process.exit(fail ? 1 : 0);
