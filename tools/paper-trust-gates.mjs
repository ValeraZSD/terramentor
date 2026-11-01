// tools/paper-trust-gates.mjs — a paper exercise whose worked answer nobody
// checked is PRACTICE, NEVER PROOF.
//
// Run:  node tools/paper-trust-gates.mjs
//
// A paper exercise's reference solution is audited before the exercise is kept
// (`generatePaperExercise`, server/paper.js, through `verifyQuestion`). It is
// what the learner's handwritten work is marked against, by a vision model or
// by the learner reading it. When the audit gives NO verdict (the model was
// down, or answered with nothing parseable) the exercise is still offered,
// like any question the verifier could not judge, but it must then follow the
// contract every other unchecked question follows (server/questionTrust.js):
// stamped `unverified`, its marked work writes no mastery evidence, and the
// feed's background chain asks again until a verdict lands. Before this gate
// the exercise was kept with no stamp, and a mark against a reference nobody
// checked wrote `paper` evidence, which counts as proof (mastery.js,
// projectState.js). This asserts, on a scratch library with a stub model on
// loopback (nothing billed, no network):
//
//   1. an exercise whose audit gave no verdict is still offered, and stamped;
//      one whose audit passed is offered unstamped; one disputed twice is not
//      offered at all;
//   2. a self-marked attempt on a stamped exercise is recorded but writes no
//      evidence; on a checked one it writes `paper` evidence as before;
//   3. a vision-marked attempt likewise; the STORED row decides at the moment
//      of writing, so a copy without the stamp changes nothing, a row
//      confirmed while the page was with the model counts, and a row vetoed
//      mid-mark is reported as no longer available (even when the photo also
//      came back unreadable);
//   4. the background chain asks the auditor again about a stamped exercise
//      still on the shelf, as an open-answer audit of its reference solution;
//      confirmed, the stamp comes off and its marked work counts; silent, it
//      waits longer; disputed, the exercise is taken off the shelf; one
//      already marked stays uncounted and is not asked about again;
//   5. the learner is told: a stamped exercise's practice card carries the
//      stamp as a flag (never the reason), a checked one's does not, and the
//      answer a second submit gets for a mark that wrote no evidence still
//      says `unproven`, decided from the evidence table, not a guess.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'paper-trust-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

// ---- the stub model: loopback only, set BEFORE any module can call out ------
// Each exercise carries a tag (PAPER-<verdict>-<name>) from its topic's title
// into its brief, so the auditor's answer is chosen per exercise and can be
// changed between one ask and the next (`auditSays`).
const auditSays = new Map();
let duringGrade = null;
let pageReadable = true;
const auditCalls = [];
const tagIn = (s) => (String(s).match(/PAPER-(SILENT|CONFIRM|DISPUTE)-[A-Z]+/) || [])[0] || null;
const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        let content;
        if (body.includes("You are marking a learner's handwritten work")) {
            // What the background chain does while a mark is with the model (section 3).
            if (duringGrade) { duringGrade(); duringGrade = null; }
            content = JSON.stringify({
                transcription: 'Line 1: 3x + 2 = 11. Line 2: 3x = 9. Line 3: x = 3. Check: 3 times 3 plus 2 is 11.',
                readable: pageReadable,
                rubric_results: ['r1', 'r2', 'r3', 'r4'].map(id => ({ id, met: true, comment: 'shown' })),
                feedback: 'Every step is shown.',
                next_action: 'Try one with fractions.',
            });
        } else if (body.includes('You audit the MODEL ANSWER to an open question')) {
            const tag = tagIn(body);
            auditCalls.push({ tag, referenceSent: body.includes('Subtract 2 from both sides') });
            const says = auditSays.get(tag) ?? (tag || 'SILENT').split('-')[1];
            content = says === 'CONFIRM' ? JSON.stringify({ verdict: 'ok', answer: 'x = 3', reason: 'the working is right', eliminable: 0 })
                : says === 'DISPUTE' ? JSON.stringify({ verdict: 'broken', reason: 'the arithmetic in step 2 is wrong' })
                : 'I would rather not say.';
        } else if (body.includes('You set ONE exercise the learner will work through BY HAND')) {
            const tag = tagIn(body) || 'PAPER-SILENT-UNTAGGED';
            content = JSON.stringify({
                mode: 'document',
                brief: `**Task.** ${tag}: solve 3x + 2 = 11 for x and show each step of the working.`,
                materials: '',
                rubric: [
                    { id: 'r1', point: 'the constant is moved to the other side', weight: 1 },
                    { id: 'r2', point: 'both sides are divided by the coefficient', weight: 2 },
                    { id: 'r3', point: 'the value of x is stated', weight: 1 },
                    { id: 'r4', point: 'the answer is checked by substitution', weight: 1 },
                ],
                reference_solution: 'Subtract 2 from both sides: 3x = 9. Divide both sides by 3: x = 3. Check: 3(3) + 2 = 11.',
            });
        } else {
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
const { generatePaperExercise, recordSelfGrade, gradePaperAttempt } = await import(B + 'paper.js');
const { consumeFeedItem, composeFeed } = await import(B + 'feed.js');
const { drawFromNode } = await import(B + 'questionLog.js');
const { pendingVerification } = await import(B + 'feedGen.js'); // also subscribes to the draw's held-back notice
const { markConfirmed, reverifyWait } = await import(B + 'questionTrust.js');
const { createApp } = await import(B + 'app.js');
const app = createServer(createApp());
await new Promise(r => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
};
const setSetting = (k, v) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run(k, v);
setSetting('ai_enabled', 'true');

/** Evidence of the kinds that count as proof (mastery.js, projectState.js). */
const proof = (nodeId) => db.prepare(
    "SELECT COUNT(*) AS n FROM mastery_evidence WHERE node_id = ? AND evidence_type IN ('quiz', 'mastery_check', 'paper')",
).get(nodeId).n;
const attempts = (nodeId) => db.prepare('SELECT COUNT(*) AS n FROM paper_attempts WHERE node_id = ?').get(nodeId).n;
// Archived, so the burst's focus window is empty and the only work it can
// find is what this gate puts in front of it.
const project = db.prepare("INSERT INTO projects (name, status) VALUES ('Paper', 'archived')").run().lastInsertRowid;
const mkNode = (title) => db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, 0)').run(project, title).lastInsertRowid;
/** Shelve an exercise the way feedGen's practice tier stores it. */
const shelve = (nodeId, exercise) => db.prepare(
    "INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'practice', 9000, ?, ?, 'ready')",
).run(nodeId, JSON.stringify(exercise), JSON.stringify({ mode: exercise.mode })).lastInsertRowid;
const stored = (feedItemId) => {
    const row = db.prepare('SELECT content FROM feed_items WHERE id = ?').get(feedItemId);
    return row ? JSON.parse(row.content) : null;
};
/** What /api/paper/:id/self-grade does: the mark and the card's consume, as one unit. */
const selfMark = (nodeId, feedItemId) => db.transaction(() => {
    const graded = recordSelfGrade({ nodeId, feedItemId, exercise: stored(feedItemId), metCount: 4 });
    consumeFeedItem({ key: `fi-${feedItemId}`, kind: 'practice', feedItemId, nodeId, result: { score: graded.score, total: graded.total, selfGraded: true } });
    return graded;
})();
/** What /api/paper/:id/grade does, with `exercise` as the copy it hands over. */
const visionMark = (nodeId, feedItemId, exercise = stored(feedItemId)) => gradePaperAttempt({
    nodeId, feedItemId, exercise, imageBuffer: Buffer.from('a photographed page'),
    claim: (grade) => !consumeFeedItem({ key: `fi-${feedItemId}`, kind: 'practice', feedItemId, nodeId, result: { score: grade.score, total: grade.total } }).duplicate,
});

// ---- 1. authoring ---------------------------------------------------------------
console.log('--- 1. an exercise whose audit gave no verdict is offered, stamped ---');
const silentNode = mkNode('Linear equations PAPER-SILENT-A');
const silentEx = await generatePaperExercise(silentNode, 'Linear equations PAPER-SILENT-A');
check('an exercise the auditor could not judge is still offered', !!silentEx && silentEx.rubric?.length === 4, JSON.stringify(silentEx));
check('...stamped unverified, so it is practice until a later audit confirms it', !!silentEx?.unverified, JSON.stringify(silentEx?.unverified ?? null));
const checkedNode = mkNode('Linear equations PAPER-CONFIRM-B');
const checkedEx = await generatePaperExercise(checkedNode, 'Linear equations PAPER-CONFIRM-B');
check('an exercise whose audit passed is offered unstamped, as before', !!checkedEx && !checkedEx.unverified, JSON.stringify(checkedEx?.unverified ?? null));
const disputedNode = mkNode('Linear equations PAPER-DISPUTE-C');
check('an exercise disputed on both attempts is not offered', (await generatePaperExercise(disputedNode, 'Linear equations PAPER-DISPUTE-C')) === null);

// ---- 2. self-marked ---------------------------------------------------------------
console.log('\n--- 2. a self-marked attempt on an unchecked exercise is not proof ---');
const silentRow = shelve(silentNode, silentEx);
const silentSelf = selfMark(silentNode, silentRow);
check('the attempt on an unchecked exercise is recorded and the card consumed',
    attempts(silentNode) === 1 && db.prepare('SELECT status FROM feed_items WHERE id = ?').get(silentRow).status === 'consumed');
check('...but writes no evidence that counts as proof', proof(silentNode) === 0, `${proof(silentNode)} proof rows`);
check('...and says so to the caller', silentSelf.unproven === true && silentSelf.mastery == null, JSON.stringify({ unproven: silentSelf.unproven, mastery: silentSelf.mastery }));
const checkedRow = shelve(checkedNode, checkedEx);
selfMark(checkedNode, checkedRow);
check('a self-marked attempt on a checked exercise writes paper evidence, as before', proof(checkedNode) === 1, `${proof(checkedNode)} proof rows`);

// ---- 3. vision-marked ---------------------------------------------------------------
console.log('\n--- 3. a vision-marked attempt on an unchecked exercise is not proof ---');
setSetting('paper_vision', 'always');
const vSilentNode = mkNode('Linear equations PAPER-SILENT-D');
const vSilentRow = shelve(vSilentNode, await generatePaperExercise(vSilentNode, 'Linear equations PAPER-SILENT-D'));
const vSilent = await visionMark(vSilentNode, vSilentRow);
check('fixture: the stub marked the page', vSilent.status === 'graded' && vSilent.grade?.score === 5, JSON.stringify({ status: vSilent.status, error: vSilent.error, reason: vSilent.reason }));
check('a vision-marked attempt on an unchecked exercise is recorded but writes no proof',
    attempts(vSilentNode) === 1 && proof(vSilentNode) === 0, `${attempts(vSilentNode)} attempts, ${proof(vSilentNode)} proof rows`);
check('...and says so to the caller', vSilent.unproven === true && vSilent.mastery == null);
const vStaleNode = mkNode('Linear equations PAPER-SILENT-E');
const vStaleEx = await generatePaperExercise(vStaleNode, 'Linear equations PAPER-SILENT-E');
const vStaleRow = shelve(vStaleNode, vStaleEx);
const { unverified: _dropped, ...unstampedCopy } = vStaleEx || {};
const vStale = await visionMark(vStaleNode, vStaleRow, unstampedCopy);
check('the stamp is read from the stored row: a copy without it is marked and writes no proof',
    !!vStaleEx?.unverified && vStale.status === 'graded' && attempts(vStaleNode) === 1 && proof(vStaleNode) === 0,
    `${vStale.status}, ${attempts(vStaleNode)} attempts, ${proof(vStaleNode)} proof rows`);
// The chain confirms the row while the page is with the model: the stamped
// copy the route loaded before the call must not outvote the stored row.
const vRaceNode = mkNode('Linear equations PAPER-SILENT-K');
const vRaceRow = shelve(vRaceNode, await generatePaperExercise(vRaceNode, 'Linear equations PAPER-SILENT-K'));
const vRaceCopy = stored(vRaceRow);
duringGrade = () => db.prepare('UPDATE feed_items SET content = ? WHERE id = ?').run(JSON.stringify(markConfirmed(stored(vRaceRow))), vRaceRow);
const vRace = await visionMark(vRaceNode, vRaceRow, vRaceCopy);
check('confirmed while the page was being marked, the mark counts (the stored row decides, not the stamped copy)',
    !!vRaceCopy?.unverified && vRace.status === 'graded' && proof(vRaceNode) === 1, `${vRace.status}, ${proof(vRaceNode)} proof rows`);
// The chain vetoes and deletes the row while the page is with the model: the
// route says the exercise is no longer available, not that it was already
// marked (and names no cause: a deleted topic takes the row the same way).
const withdrawnNode = mkNode('Linear equations PAPER-SILENT-M');
const withdrawnRow = shelve(withdrawnNode, await generatePaperExercise(withdrawnNode, 'Linear equations PAPER-SILENT-M'));
duringGrade = () => db.prepare('DELETE FROM feed_items WHERE id = ?').run(withdrawnRow);
const form = new FormData();
form.append('image', new Blob([Buffer.from('a photographed page')], { type: 'image/jpeg' }), 'page.jpg');
const withdrawn = await (await fetch(`${base}/api/paper/${withdrawnRow}/grade`, { method: 'POST', body: form })).json();
check('gone while being marked (a later veto, or its topic deleted): the route says it is no longer available and records nothing',
    withdrawn.status === 'error' && /no longer available/.test(withdrawn.error || '') && attempts(withdrawnNode) === 0 && proof(withdrawnNode) === 0,
    JSON.stringify(withdrawn));
// The same, when the photo also came back unreadable: "retake the photo" would
// send the learner to an exercise that is gone, so the route says that instead.
const goneUnreadNode = mkNode('Linear equations PAPER-SILENT-N');
const goneUnreadRow = shelve(goneUnreadNode, await generatePaperExercise(goneUnreadNode, 'Linear equations PAPER-SILENT-N'));
duringGrade = () => db.prepare('DELETE FROM feed_items WHERE id = ?').run(goneUnreadRow);
pageReadable = false;
const goneForm = new FormData();
goneForm.append('image', new Blob([Buffer.from('a blurred page')], { type: 'image/jpeg' }), 'page.jpg');
const goneUnread = await (await fetch(`${base}/api/paper/${goneUnreadRow}/grade`, { method: 'POST', body: goneForm })).json();
pageReadable = true;
check('gone while an unreadable photo was with the model: the route says it is no longer available, not "retake the photo"',
    goneUnread.status === 'error' && /no longer available/.test(goneUnread.error || '') && attempts(goneUnreadNode) === 0 && proof(goneUnreadNode) === 0,
    JSON.stringify(goneUnread));
const vCheckedNode = mkNode('Linear equations PAPER-CONFIRM-F');
const vCheckedRow = shelve(vCheckedNode, await generatePaperExercise(vCheckedNode, 'Linear equations PAPER-CONFIRM-F'));
await visionMark(vCheckedNode, vCheckedRow);
check('a vision-marked attempt on a checked exercise writes paper evidence, as before', proof(vCheckedNode) === 1, `${proof(vCheckedNode)} proof rows`);
setSetting('paper_vision', 'never');

// ---- 4. asked again later -------------------------------------------------------------
console.log('\n--- 4. the background chain audits a shelved unchecked exercise again ---');
/** Due: the stamp as authoring writes it, dated long past its first wait (a fixed instant, no clock read). */
const backdate = (feedItemId) => {
    const ex = stored(feedItemId);
    db.prepare('UPDATE feed_items SET content = ? WHERE id = ?').run(JSON.stringify({
        ...ex, unverified: { ...ex.unverified, at: '2001-01-01T00:00:00.000Z', next: '2001-01-01T00:15:00.000Z' },
    }), feedItemId);
};
/** Polls the background chain; the deadline is a test budget, not an assertion. */
const waitFor = async (pred, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 100)); }
    return pred();
};
/**
 * The chain reaches a topic when a draw had to hold a question back from it,
 * so each topic gets a bank with one stamped question that is NOT due (the
 * chain skips it and finds the exercise) and the draw is made.
 */
const holdBack = (nodeId) => {
    const q = {
        question: 'What is 2 + 2?', type: 'multiple_choice', options: ['3', '4', '5', '6'], correct_answer: '4', explanation: 'Two and two make four.',
        unverified: { reason: 'verifier returned nothing usable', tries: 1, at: '2001-01-01T00:00:00.000Z', next: '9999-12-31T00:00:00.000Z' },
    };
    db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(nodeId, 'Bank', JSON.stringify([q]));
    drawFromNode(nodeId, 50);
};

const laterNode = mkNode('Linear equations PAPER-SILENT-G');
const laterRow = shelve(laterNode, await generatePaperExercise(laterNode, 'Linear equations PAPER-SILENT-G'));
backdate(laterRow);
check('a due unchecked exercise on the shelf is a step for the background chain',
    pendingVerification(laterNode)?.entry?.feedItemId === laterRow, JSON.stringify(pendingVerification(laterNode)?.entry ?? null));
auditSays.set('PAPER-SILENT-G', 'CONFIRM');
auditCalls.length = 0;
holdBack(laterNode);
const confirmedLater = await waitFor(() => !stored(laterRow)?.unverified);
check('confirmed by a later audit, the stamp comes off and it records when', confirmedLater && !!stored(laterRow)?.verifiedAt, JSON.stringify(stored(laterRow)?.unverified ?? null));
check('...asked once, as an open-answer audit of its reference solution',
    auditCalls.filter(c => c.tag === 'PAPER-SILENT-G').length === 1 && auditCalls.every(c => c.referenceSent), JSON.stringify(auditCalls));
selfMark(laterNode, laterRow);
check('...and its marked work counts from then on', proof(laterNode) === 1, `${proof(laterNode)} proof rows`);

const quietNode = mkNode('Linear equations PAPER-SILENT-H');
const quietRow = shelve(quietNode, await generatePaperExercise(quietNode, 'Linear equations PAPER-SILENT-H'));
backdate(quietRow);
holdBack(quietNode);
const waited = await waitFor(() => (stored(quietRow)?.unverified?.tries ?? 1) > 1);
const quiet = stored(quietRow)?.unverified;
check('still no verdict: it stays stamped and waits longer',
    waited && quiet?.tries === 2 && Date.parse(quiet.next) - Date.parse(quiet.at) === reverifyWait(2), JSON.stringify(quiet ?? null));

// Marked BEFORE any later audit confirmed it: the card is consumed, the mark
// stays uncounted, and nothing asks about the exercise again (answers given
// while a question was unconfirmed stay uncounted, questionTrust.js).
const earlyNode = mkNode('Linear equations PAPER-SILENT-N');
const earlyRow = shelve(earlyNode, await generatePaperExercise(earlyNode, 'Linear equations PAPER-SILENT-N'));
backdate(earlyRow);
selfMark(earlyNode, earlyRow);
check('marked before any confirmation: the mark stays uncounted and the consumed exercise is not asked about again',
    proof(earlyNode) === 0 && pendingVerification(earlyNode) === null, JSON.stringify(pendingVerification(earlyNode)?.entry ?? null));

const vetoNode = mkNode('Linear equations PAPER-SILENT-J');
const vetoRow = shelve(vetoNode, await generatePaperExercise(vetoNode, 'Linear equations PAPER-SILENT-J'));
backdate(vetoRow);
auditSays.set('PAPER-SILENT-J', 'DISPUTE');
holdBack(vetoNode);
check('disputed by a later audit, the exercise is taken off the shelf', await waitFor(() => stored(vetoRow) === null));

// ---- 5. the learner is told ---------------------------------------------------------
console.log('\n--- 5. the card says it is practice, and a second answer still says the mark did not count ---');
/** The topic's own stream, the one the study page shows; the practice card on it, if any. */
const practiceCard = (nodeId) => composeFeed({ nodeId }).items.find(c => c.kind === 'practice') || null;
const cardSilentNode = mkNode('Linear equations PAPER-SILENT-P');
const cardSilentRow = shelve(cardSilentNode, await generatePaperExercise(cardSilentNode, 'Linear equations PAPER-SILENT-P'));
const cardCheckedNode = mkNode('Linear equations PAPER-CONFIRM-Q');
const cardCheckedRow = shelve(cardCheckedNode, await generatePaperExercise(cardCheckedNode, 'Linear equations PAPER-CONFIRM-Q'));
const silentCard = practiceCard(cardSilentNode);
const checkedCard = practiceCard(cardCheckedNode);
check('fixture: both exercises are on their topic streams', silentCard?.feedItemId === cardSilentRow && checkedCard?.feedItemId === cardCheckedRow,
    JSON.stringify({ silent: silentCard?.feedItemId ?? null, checked: checkedCard?.feedItemId ?? null }));
check('the practice card of an unchecked exercise carries the stamp, as a flag and nothing more',
    silentCard?.unchecked === true && !('unverified' in (silentCard || {})), JSON.stringify({ unchecked: silentCard?.unchecked, unverified: silentCard?.unverified }));
check('...and the card of a checked exercise does not', checkedCard?.unchecked !== true, JSON.stringify({ unchecked: checkedCard?.unchecked }));
const selfGradeRoute = async (feedItemId) => (await fetch(`${base}/api/paper/${feedItemId}/self-grade`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ metCount: 3 }),
})).json();
const firstSilent = await selfGradeRoute(cardSilentRow);
const againSilent = await selfGradeRoute(cardSilentRow);
check('a second answer for a mark that did not count says so, as the first did',
    firstSilent.unproven === true && againSilent.duplicate === true && againSilent.unproven === true,
    JSON.stringify({ first: firstSilent.unproven, again: { duplicate: againSilent.duplicate, unproven: againSilent.unproven } }));
const photoAgain = await (await fetch(`${base}/api/paper/${cardSilentRow}/grade`, { method: 'POST', body: form })).json();
check('...on the photo route too', photoAgain.duplicate === true && photoAgain.unproven === true,
    JSON.stringify({ duplicate: photoAgain.duplicate, unproven: photoAgain.unproven }));
const firstChecked = await selfGradeRoute(cardCheckedRow);
const againChecked = await selfGradeRoute(cardCheckedRow);
check('a second answer for a mark that counted does not say it did not',
    firstChecked.status === 'graded' && againChecked.duplicate === true && againChecked.unproven !== true && proof(cardCheckedNode) === 1,
    JSON.stringify({ again: { duplicate: againChecked.duplicate, unproven: againChecked.unproven }, proof: proof(cardCheckedNode) }));

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise(r => stub.close(r));
await new Promise(r => app.close(r));
db.close();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL */ }
process.exitCode = fail ? 1 : 0;
