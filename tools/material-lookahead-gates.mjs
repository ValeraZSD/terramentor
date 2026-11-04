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
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'material-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

// A stub model on loopback, for the last section only (a real burst): it
// writes a quiz when asked for one, confirms every key, refuses the rest.
// Set before any server module can read the AI settings.
const quizAsks = [];
const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const msgs = (() => { try { return JSON.parse(body).messages || []; } catch { return []; } })();
        const all = msgs.map(m => m.content).join('\n');
        let content = null;
        if (/quiz generator/i.test(all)) {
            quizAsks.push(all);
            // "Short circuits" gets a bank too small to be a mastery check.
            content = JSON.stringify(Array.from({ length: /Short circuits/.test(all) ? 2 : 6 }, (_, i) => ({
                type: 'multiple_choice', question: `What is ${i} + 4 in this circuit sum?`,
                options: [`${i + 3}`, `${i + 4}`, `${i + 5}`, `${i + 6}`], correct_answer: `${i + 4}`, explanation: `${i} and 4 make ${i + 4}.`,
            })));
        } else if (/checking a question before it is shown/.test(all)) {
            const n = Number((all.match(/What is (\d+) \+ 4/) || [])[1] ?? 0);
            content = JSON.stringify({ verdict: 'ok', answer: String(n + 4), reason: 'agrees', eliminable: 0 });
        }
        if (content == null) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end('{"error":{"message":"stub: not part of this gate"}}');
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 20 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const { pendingMaterial, requestNode } = await import(B + 'feedGen.js');
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
// The focus window's look-ahead must be the LAST thing the burst reaches for:
// everything above it is a card on screen now, or the opened topic's own check.
const burst = gen.slice(gen.indexOf('async function runBurst'));
ok('the focus window\'s look-ahead is picked after the widget pre-build',
    burst.indexOf('pickTarget(teachable, f => pendingMaterial(') > burst.indexOf('pendingWidget('), true);

// ---------------------------------------------------------------------------
console.log('\n--- a topic the learner jumped to gets its check written while they read ---');
// ---------------------------------------------------------------------------
// The look-ahead walked the focus window only: the first open topics by the
// schedule. A topic opened from the outline ("Study this") is REQUESTED, and
// the burst wrote its lessons first but dropped it the moment they were done,
// so its check was written only when the learner pressed "Take the mastery
// check" and sat on the model (Taylor clip, 4 Nov 2026: topic 63 of 71). A
// real burst here, against the stub model: the requested topic is taught, the
// focus topic has everything, and the next thing written is the requested
// topic's bank.
{
    db.prepare(`UPDATE nodes SET status = 'completed'`).run();
    setSetting('feed_practice', 'false');
    setSetting('feed_focus_total', '1');
    setSetting('feed_focus_per_project', '1');
    setSetting('ai_enabled', 'true');
    const pid = db.prepare(`INSERT INTO projects (name, description) VALUES ('Circuits', 'burst fixture')`).run().lastInsertRowid;
    const topic = (title, position) => db.prepare(
        `INSERT INTO nodes (project_id, title, description, position) VALUES (?, ?, 'Currents and sums.', ?)`,
    ).run(pid, title, position).lastInsertRowid;
    const taught = (id) => {
        db.prepare(`INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'plan', 0, ?, '{}', 'internal')`)
            .run(id, JSON.stringify({ parts: [{ title: 'The one part', focus: '' }] }));
        for (const [kind, seq] of [['lesson', 1], ['question', 2]]) {
            db.prepare(`INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, ?, ?, 'x', '{}', 'consumed')`).run(id, kind, seq);
        }
    };
    const focusTopic = topic('Series circuits', 0);
    taught(focusTopic);
    db.prepare(`INSERT INTO quizzes (node_id, title, questions) VALUES (?, 'bank', ?)`)
        .run(focusTopic, JSON.stringify(Array.from({ length: MIN_GATE_QUESTIONS }, (_, i) => q(`s${i}`))));
    db.prepare(`INSERT INTO flashcards (node_id, front, back) VALUES (?, 'Q', 'A')`).run(focusTopic);
    for (let i = 1; i <= 3; i++) topic(`Filler ${i}`, i);
    const jumped = topic('Parallel circuits', 9);
    taught(jumped);
    ok('fixture: the jumped-to topic is taught and wants its check', decide(jumped), { type: 'material', kind: 'mastery_check' });
    ok('fixture: the focus topic wants nothing', decide(focusTopic), null);

    requestNode(jumped);   // what GET /api/feed?nodeId= does for the page that is open
    const bankOf = () => db.prepare(`SELECT COUNT(*) AS n FROM quizzes WHERE node_id = ?`).get(jumped).n;
    for (let waited = 0; waited < 6000 && bankOf() === 0; waited += 100) await new Promise(r => setTimeout(r, 100));
    ok('the burst asked the model for the jumped-to topic\'s check',
        quizAsks.some(a => a.includes('Parallel circuits')), true);
    ok('…and stored it as that topic\'s bank before the learner reached it', bankOf() > 0, true);

    // A write the vetting leaves short of a mastery check (two questions, not
    // four) must not be asked for again on every burst while the learner
    // stays on the page: it is recorded as skipped, like a failed write.
    const short = topic('Short circuits', 10);
    taught(short);
    requestNode(short);
    const skipped = () => !!JSON.parse(db.prepare(`SELECT meta FROM feed_items WHERE node_id = ? AND kind = 'plan'`).get(short).meta || '{}').skippedCheck;
    const asksFor = () => quizAsks.filter(a => a.includes('Short circuits')).length;
    for (let waited = 0; waited < 6000 && !skipped() && asksFor() < 3; waited += 100) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 500));
    ok('a bank written short is recorded as skipped', skipped(), true);
    ok('…and the model is asked for it once, not on every burst', asksFor(), 1);
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* already closed */ }
// better-sqlite3 can still hold the scratch file open on Windows; the OS sweeps
// the temp dir either way.
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
