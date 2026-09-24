// tools/material-lookahead-gates.mjs — the feed writes a topic's mastery check
// and its flashcards BEFORE the learner reaches them.
//
// Run:  node tools/material-lookahead-gates.mjs
//
// Nothing here calls a model. `pendingMaterial` (server/feedGen.js) is a pure
// decision over the database — "is there material this topic will need that is
// not written yet" — and every rule it encodes is one that, got wrong, either
// spends the learner's model budget on nothing or delays a card they are
// looking at right now:
//
//   * material is never written for a topic that has not been TAUGHT yet, so a
//     bank is never authored from half a lesson, and a question the reader is
//     waiting on is never queued behind one they have not reached;
//   * "has a bank" is counted in QUESTIONS across every quiz row, against
//     MIN_GATE_QUESTIONS — the bar the gate itself uses. Counting ROWS is the
//     pre-fix shape that reported a node holding one 2-question quiz as covered
//     forever while its gate could never fire (bulkGen carries the same rule,
//     and this is the second place it now has to be right);
//   * a GHOST question belongs to another topic and the gate filters it out, so
//     it can never make a bank look ready;
//   * each half has its own switch, because they differ in kind: a question
//     bank is inert until the gate opens it, while flashcards are permanent
//     FSRS rows that start being served;
//   * a topic the model could not write material for is marked and dropped, not
//     retried every burst until the end of time.
//
// The pre-fix shape is run through the same assertions wherever there is one.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'material-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const { pendingMaterial } = await import(B + 'feedGen.js');
const { MIN_GATE_QUESTIONS } = await import(B + 'mastery.js');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
    const good = JSON.stringify(got) === JSON.stringify(want);
    good ? pass++ : fail++;
    console.log(`${good ? '  ok  ' : ' FAIL '} ${name}${good ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
/** What pendingMaterial decided, reduced to the two things that matter. */
const decide = (nodeId) => {
    const m = pendingMaterial(nodeId);
    return m ? { type: m.type, kind: m.kind } : null;
};
const setSetting = (k, v) => db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).run(k, v);

// --- fixture ---------------------------------------------------------------
// One project, one topic, taught in two parts — the smallest shape that can be
// "fully taught" and therefore eligible for its end-of-stream material.
const projectId = db.prepare(
    `INSERT INTO projects (name, description) VALUES ('Lookahead', 'gate fixture')`,
).run().lastInsertRowid;
const nodeId = db.prepare(
    `INSERT INTO nodes (project_id, title, description, position) VALUES (?, 'Kirchhoff''s laws', 'Current in, current out.', 0)`,
).run(projectId).lastInsertRowid;

const PARTS = [{ title: 'The current law', focus: '' }, { title: 'The voltage law', focus: '' }];
const planId = db.prepare(
    `INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'plan', 0, ?, '{}', 'internal')`,
).run(nodeId, JSON.stringify({ parts: PARTS })).lastInsertRowid;
const addItem = (kind, seq) => db.prepare(
    `INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, ?, ?, 'x', '{}', 'ready')`,
).run(nodeId, kind, seq);
const planMeta = (patch) => {
    const meta = JSON.parse(db.prepare(`SELECT meta FROM feed_items WHERE id = ?`).get(planId).meta || '{}');
    db.prepare(`UPDATE feed_items SET meta = ? WHERE id = ?`).run(JSON.stringify({ ...meta, ...patch }), planId);
};

// ---------------------------------------------------------------------------
console.log('\n--- nothing is written ahead until the topic has been taught ---');
// ---------------------------------------------------------------------------
ok('an unwritten topic asks for no material', decide(nodeId), null);

addItem('lesson', 1);
ok('…nor one with a lesson but no question', decide(nodeId), null);
addItem('question', 2);
addItem('lesson', 3);
ok('…nor one still missing its last question', decide(nodeId), null);
addItem('question', 4);

// Paper exercises are on by default and sit AFTER the lessons, so a topic whose
// exercise has not been set is still being taught. This is the ordering rule
// that keeps the look-ahead behind everything the reader can see.
setSetting('feed_practice', 'true');
ok('…nor one whose paper exercise is still pending', decide(nodeId), null);
addItem('practice', 100);

ok('a fully taught topic asks for its mastery check first',
    decide(nodeId), { type: 'material', kind: 'mastery_check' });

// ---------------------------------------------------------------------------
console.log('\n--- "has a bank" is counted in questions, not rows ---');
// ---------------------------------------------------------------------------
const q = (text) => ({ question: text, type: 'true_false', options: ['True', 'False'], correct_answer: 'True', explanation: 'because' });
const ghost = (text) => ({ ...q(text), isGhost: true, ghostNodeId: 999 });
const putQuiz = (questions) => db.prepare(
    `INSERT INTO quizzes (node_id, title, questions) VALUES (?, 'bank', ?)`,
).run(nodeId, JSON.stringify(questions)).lastInsertRowid;

// THE PRE-FIX SHAPE: one quiz ROW, too few questions to be an assessment. A
// row count says covered; the gate can never fire.
const thinQuiz = putQuiz([q('a'), q('b')]);
ok(`a node with one ${MIN_GATE_QUESTIONS > 2 ? 'thin' : 'small'} quiz row still needs a bank`,
    decide(nodeId), { type: 'material', kind: 'mastery_check' });

// Ghosts belong to another topic; the gate filters them out, so they may not
// make this bank look ready.
const ghostQuiz = putQuiz([ghost('g1'), ghost('g2'), ghost('g3'), ghost('g4'), ghost('g5')]);
ok('ghost questions do not count toward the bank',
    decide(nodeId), { type: 'material', kind: 'mastery_check' });
db.prepare(`DELETE FROM quizzes WHERE id = ?`).run(ghostQuiz);

// Two rows that TOGETHER clear the bar are a bank — the gate reads every row.
putQuiz(Array.from({ length: MIN_GATE_QUESTIONS - 2 }, (_, i) => q(`c${i}`)));
const total = db.prepare(`
    SELECT COALESCE(SUM((SELECT COUNT(*) FROM json_each(q.questions) je
        WHERE COALESCE(json_extract(je.value,'$.isGhost'),0)=0)), 0) n
    FROM quizzes q WHERE q.node_id = ?`).get(nodeId).n;
ok('…and the bar is the gate\'s own MIN_GATE_QUESTIONS', total, MIN_GATE_QUESTIONS);
ok('a bank that clears the bar moves on to the flashcards',
    decide(nodeId), { type: 'material', kind: 'flashcards' });

// ---------------------------------------------------------------------------
console.log('\n--- flashcards: one card is enough, and the two halves are independent ---');
// ---------------------------------------------------------------------------
setSetting('feed_prepare_cards', 'false');
ok('with cards switched off, a taught and banked topic wants nothing', decide(nodeId), null);

setSetting('feed_prepare_cards', 'true');
db.prepare(`DELETE FROM quizzes WHERE id = ?`).run(thinQuiz);
setSetting('feed_prepare_check', 'false');
ok('with the check switched off, a bank under the bar is not written',
    decide(nodeId), { type: 'material', kind: 'flashcards' });
setSetting('feed_prepare_check', 'true');
ok('…and switching it back on puts the check first again',
    decide(nodeId), { type: 'material', kind: 'mastery_check' });
putQuiz([q('d1'), q('d2')]);   // back over the bar

const cardId = db.prepare(`INSERT INTO flashcards (node_id, front, back) VALUES (?, 'Q', 'A')`).run(nodeId).lastInsertRowid;
ok('a topic that already has a card is left alone', decide(nodeId), null);
db.prepare(`DELETE FROM flashcards WHERE id = ?`).run(cardId);
ok('…and needs them again once it has none', decide(nodeId), { type: 'material', kind: 'flashcards' });

// ---------------------------------------------------------------------------
console.log('\n--- a topic the model could not write for is attempted once ---');
// ---------------------------------------------------------------------------
planMeta({ skippedCards: true });
ok('a recorded card failure is not retried every burst', decide(nodeId), null);
db.prepare(`DELETE FROM quizzes WHERE node_id = ?`).run(nodeId);
ok('…and the check is still asked for, independently',
    decide(nodeId), { type: 'material', kind: 'mastery_check' });
planMeta({ skippedCheck: true });
ok('…until its own failure is recorded too', decide(nodeId), null);

// ---------------------------------------------------------------------------
console.log('\n--- both switches off means no background material at all ---');
// ---------------------------------------------------------------------------
planMeta({ skippedCards: false, skippedCheck: false });
setSetting('feed_prepare_check', 'false');
setSetting('feed_prepare_cards', 'false');
ok('nothing is decided when both dials are off', decide(nodeId), null);
setSetting('feed_prepare_check', 'true');
setSetting('feed_prepare_cards', 'true');

// ---------------------------------------------------------------------------
console.log('\n--- an unplanned topic has nothing to record a failure on ---');
// ---------------------------------------------------------------------------
// The plan row is where the skip markers live, so a node without one must be
// left alone rather than retried forever with nowhere to write the outcome.
const orphanId = db.prepare(
    `INSERT INTO nodes (project_id, title, position) VALUES (?, 'Never planned', 1)`,
).run(projectId).lastInsertRowid;
ok('a topic with no plan is never targeted', decide(orphanId), null);

// ---------------------------------------------------------------------------
console.log('\n--- one authoring path, not two ---');
// ---------------------------------------------------------------------------
// The bulk dialog, the feed's look-ahead and the gate must write the same rows
// the same way. Re-implementing the twelve lines is how "prepared ahead of
// time" quietly becomes the path nothing vets.
const src = (p) => readFileSync(new URL(`../server/${p}`, import.meta.url), 'utf8');
const bulk = src('bulkGen.js');
const gen = src('feedGen.js');
ok('bulkGen goes through generateMaterial', /generateMaterial\(/.test(bulk), true);
ok('…and no longer finalises a quiz itself', /finalizeQuiz\(|finalizeFlashcards\(/.test(bulk), false);
ok('feedGen goes through generateMaterial', /generateMaterial\(/.test(gen), true);
ok('…and no longer finalises a quiz itself', /finalizeQuiz\(|finalizeFlashcards\(/.test(gen), false);
// The look-ahead must be the LAST thing the burst reaches for: everything above
// it is a card on screen now.
const burst = gen.slice(gen.indexOf('async function runBurst'));
ok('the look-ahead is picked after the widget pre-build',
    burst.indexOf('pendingMaterial(') > burst.indexOf('pendingWidget('), true);

console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* already closed */ }
// better-sqlite3 can still hold the scratch file open on Windows; the OS sweeps
// the temp dir either way.
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
