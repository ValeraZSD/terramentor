// tools/question-trust-gates.mjs — a question no verifier confirmed is
// PRACTICE, NEVER PROOF.
//
// Run:  node tools/question-trust-gates.mjs [--server <dir>]
//
// Every model-written question is answered cold by a second pass before it is
// served (verifyQuestion, server/feedQuality.js). When that pass gives no
// verdict the question is still served — re-authoring would meet the same
// verifier — but before server/questionTrust.js it was then treated exactly
// like a checked one: its answer wrote mastery evidence, it sat in the
// mastery-check bank and was drawn, and a placement probe built on it seeded a
// prior. This asserts, on a scratch library, that each of those shapes now
// counts for nothing, and that a later successful verification makes it count:
//
//   1. a feed question stamped unverified (and the pre-fix shape, where only
//      the row's meta said `verified: false`) writes no evidence; a checked
//      one does; the old meta flag is carried onto the question at startup;
//   2. a bank question stamped unverified is never drawn — not by the check,
//      not by a practice sitting — and a recall card built from one writes no
//      evidence; a practice sitting's evidence leaves it out of the total;
//   3. vetQuiz, handed a verifier that answers nothing parseable, STAMPS what it
//      keeps (a stub model on loopback; nothing billed);
//   4. a placement probe question with `verified: false` or the stamp seeds no
//      prior and writes no evidence; a checked one does both;
//   5. the feed's background chain asks the verifier again about questions a
//      draw held back: a confirmed one loses its stamp and COUNTS (drawn, and
//      its feed answer writes evidence), a disputed one is deleted, a silent one
//      waits longer — each asked once, never in a loop;
//   6. a sitting's answers are found by the question's uuid, so a veto that
//      splices the bank while a sitting is open cannot land a stamped
//      question's answer on a checked one's place (evidence and ask-record);
//      an entry that cannot be identified, or a sitting with no `asked`, is
//      not proof in a bank holding a stamped question;
//   7. finalizeQuiz stores a model's bank stamped PENDING, so nothing of it is
//      proof while vetQuiz runs; vetQuiz confirms, deletes or re-stamps each
//      question by uuid; a cancelled vetting leaves the rest stamped for the
//      chain; an imported question is stamped only when its file says
//      `unchecked`;
//   8. capture's enrichment questions are stamped pending, due at once.
//
// `--server <dir>` runs the same assertions against another copy of server/
// (the pre-fix code) to prove they fail there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const si = argv.indexOf('--server');
const B = si >= 0
    ? pathToFileURL(resolve(argv[si + 1]) + '/').href
    : new URL('../server/', import.meta.url).href;

const scratch = mkdtempSync(join(tmpdir(), 'question-trust-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

// ---- the stub model: loopback only, set BEFORE any module can call out ------
// Routed by what the question SAYS, so one burst can confirm one question,
// dispute another and get nothing parseable about a third.
const verifierCalls = new Map();
const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const msgs = (() => { try { return JSON.parse(body).messages || []; } catch { return []; } })();
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.find(m => m.role === 'user')?.content || '';
        let content;
        if (/turn a raw snippet the learner saved into a studiable topic/.test(system)) {
            // Capture's enrichment model (section 8): one question, no cards.
            content = JSON.stringify({
                title: 'Adding two and two', overview: 'Two and two make four.', flashcards: [],
                questions: [{ question: 'CONFIRM capture: what is 2 + 2?', type: 'multiple_choice', options: ['3', '4', '5', '6'], correct_answer: '4', explanation: 'Two and two make four.' }],
            });
        } else if (/checking a question before it is shown/.test(system)) {
            const tag = (user.match(/\b(CONFIRM|DISPUTE|SILENT)\w*/) || [])[0] || 'SILENT';
            verifierCalls.set(tag, (verifierCalls.get(tag) || 0) + 1);
            content = tag.startsWith('CONFIRM') ? JSON.stringify({ verdict: 'ok', answer: '4', reason: 'agrees', eliminable: 0 })
                : tag.startsWith('DISPUTE') ? JSON.stringify({ verdict: 'ok', answer: '5', reason: 'the key is wrong', eliminable: 0 })
                : 'I would rather not say.';
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

const { default: db } = await import(B + 'database.js');
const { consumeFeedItem } = await import(B + 'feed.js');
const { drawFromNode, drawFromQuiz } = await import(B + 'questionLog.js');
const { vetQuiz } = await import(B + 'studyMaterial.js');
const { setProbeQuestions, recordProbeAnswer, createProbe } = await import(B + 'placement.js');
await import(B + 'feedGen.js'); // subscribes to the draw's held-back notice
let trust = null;
try { trust = await import(B + 'questionTrust.js'); } catch { /* the pre-fix tree has no such module */ }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
};
const setSetting = (k, v) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run(k, v);
setSetting('ai_enabled', 'true');

const evidence = (nodeId) => db.prepare('SELECT COUNT(*) AS n FROM mastery_evidence WHERE node_id = ?').get(nodeId).n;
const mc = (text, extra = {}) => ({ question: text, type: 'multiple_choice', options: ['3', '4', '5', '6'], correct_answer: '4', explanation: 'Two and two make four.', ...extra });
/** The stamp as the authoring paths write it, `minutesAgo` old (so it may already be due). */
const stamp = (q, minutesAgo = 0) => {
    const at = Date.now() - minutesAgo * 60000;
    return { ...q, unverified: { reason: 'verifier returned nothing usable', tries: 1, at: new Date(at).toISOString(), next: new Date(at + 15 * 60000).toISOString() } };
};
// Archived, so the burst's focus window is empty and the only work it can
// find is what this gate puts in front of it.
const mkProject = (name) => db.prepare("INSERT INTO projects (name, status) VALUES (?, 'archived')").run(name).lastInsertRowid;
const mkNode = (pid, title, position = 0) => db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, ?)').run(pid, title, position).lastInsertRowid;
const feedRow = (nodeId, seq, content, meta) => db.prepare(
    "INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'question', ?, ?, ?, 'ready')",
).run(nodeId, seq, JSON.stringify(content), JSON.stringify(meta)).lastInsertRowid;
const answer = (nodeId, feedItemId, key, kind = 'question') =>
    consumeFeedItem({ key, kind, feedItemId, nodeId, result: { correct: true, gradedBy: 'local' } });

// ---- 1. the feed ----------------------------------------------------------------
console.log('--- 1. a feed question nobody confirmed writes no evidence ---');
const feedProject = mkProject('Feed');
const fnode = mkNode(feedProject, 'Adding small numbers');
const checked = feedRow(fnode, 2, mc('What is 2 + 2?'), { questionType: 'multiple_choice', verified: true });
const legacy = feedRow(fnode, 4, mc('What is 1 + 3?'), { questionType: 'multiple_choice', verified: false, unverified: 'verifier returned nothing usable' });
const stamped = feedRow(fnode, 6, stamp(mc('What is 3 + 1?')), { questionType: 'multiple_choice', verified: false });

answer(fnode, checked, `fi-${checked}`);
check('control: a checked feed question\'s answer writes evidence', evidence(fnode) === 1, `${evidence(fnode)} rows`);
answer(fnode, legacy, `fi-${legacy}`);
check('the pre-fix shape (only the meta says verified:false) writes none', evidence(fnode) === 1, `${evidence(fnode)} rows`);
answer(fnode, stamped, `fi-${stamped}`);
check('a question stamped unverified on its content writes none', evidence(fnode) === 1, `${evidence(fnode)} rows`);

const legacy2 = feedRow(fnode, 8, mc('What is 0 + 4?'), { questionType: 'multiple_choice', verified: false, unverified: 'verifier unavailable (fetch failed)' });
const moved = trust?.adoptLegacyFeedFlags ? trust.adoptLegacyFeedFlags() : 0;
const legacyContent = JSON.parse(db.prepare('SELECT content FROM feed_items WHERE id = ?').get(legacy2).content);
check('at startup the old meta flag is carried onto the question, so the card can show it',
    !!legacyContent.unverified && legacyContent.unverified.reason === 'verifier unavailable (fetch failed)', `moved ${moved}`);
check('...and doing it again moves nothing', (trust?.adoptLegacyFeedFlags ? trust.adoptLegacyFeedFlags() : -1) === 0);

// ---- 2. the bank ------------------------------------------------------------------
console.log('\n--- 2. a bank question nobody confirmed is never drawn ---');
const bankProject = mkProject('Bank');
const bnode = mkNode(bankProject, 'Kirchhoff\'s laws');
const bankQs = [
    ...Array.from({ length: 8 }, (_, i) => mc(`Checked question ${i + 1}: what is 2 + 2?`)),
    stamp(mc('Unchecked question A: what is 2 + 2?')),
    stamp(mc('Unchecked question B: what is 2 + 2?')),
];
const bankQuiz = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(bnode, 'Bank', JSON.stringify(bankQs)).lastInsertRowid;
const checkDraw = drawFromNode(bnode, 50);
check('the mastery check\'s draw hands out only the checked questions',
    checkDraw.questions.length === 8 && !checkDraw.questions.some(q => q.question.unverified), `${checkDraw.questions.length} drawn`);
check('...and says how many it held back', checkDraw.unverified === 2 && checkDraw.bankSize === 8, JSON.stringify({ bankSize: checkDraw.bankSize, unverified: checkDraw.unverified }));
const sitting = drawFromQuiz(bankQuiz, 50);
check('a practice sitting\'s draw holds them back too', sitting.questions.length === 8, `${sitting.questions.length} drawn`);

const before = evidence(bnode);
answer(bnode, null, `recall-${bnode}-${bankQuiz}-8`, 'recall');
check('a recall card built from one writes no evidence', evidence(bnode) === before, `${evidence(bnode) - before} written`);
answer(bnode, null, `recall-${bnode}-${bankQuiz}-0`, 'recall');
check('control: a recall card from a checked one does', evidence(bnode) === before + 1);

// Named the way the sitting names them: by uuid (section 6 is why).
const bankUuids = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(bankQuiz).questions).map(q => q.uuid);
const proven = trust?.provenSitting
    ? trust.provenSitting({ quizId: bankQuiz, asked: [...Array.from({ length: 8 }, (_, i) => ({ index: i, uuid: bankUuids[i], correct: i < 6 })), { index: 8, uuid: bankUuids[8], correct: true }, { index: 9, uuid: bankUuids[9], correct: false }], score: 7, total: 10 })
    : null;
check('a whole-row practice sitting\'s evidence leaves them out: 7/10 sat, 6/8 counted',
    proven?.score === 6 && proven?.total === 8, JSON.stringify(proven));

// ---- 2b. the stream, beside a bank it cannot ask from ---------------------------------
console.log('\n--- 2b. a bank nobody confirmed does not stand in for the parts\' own questions ---');
const { nextMissing, pendingMaterial } = await import(B + 'feedGen.js');
const snode = mkNode(bankProject, 'Series circuits', 2);
db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'plan', 0, ?, '{}', 'internal')")
    .run(snode, JSON.stringify({ parts: [{ title: 'Current', focus: '' }, { title: 'Voltage', focus: '' }] }));
db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'lesson', 1, 'Part one.', '{}', 'ready')").run(snode);
db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)')
    .run(snode, 'Bank', JSON.stringify(Array.from({ length: 10 }, (_, i) => stamp(mc(`Unchecked ${i}: what is 2 + 2?`)))));
check('a topic whose whole bank is unconfirmed still gets its part\'s own question written',
    nextMissing(snode)?.type === 'question', JSON.stringify(nextMissing(snode)?.type ?? null));
db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'question', 2, ?, '{}', 'ready')").run(snode, JSON.stringify(mc('Part one question: what is 2 + 2?')));
db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'lesson', 3, 'Part two.', '{}', 'ready')").run(snode);
db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'question', 4, ?, '{}', 'ready')").run(snode, JSON.stringify(mc('Part two question: what is 2 + 2?')));
db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'practice', 100, '{}', '{}', 'ready')").run(snode);
check('...but it is not written a SECOND bank while the verifier is down (that would repeat every burst)',
    nextMissing(snode) === null && pendingMaterial(snode)?.kind === 'flashcards', JSON.stringify({ next: nextMissing(snode), material: pendingMaterial(snode)?.kind }));

// ---- 3. vetQuiz stamps what it keeps ------------------------------------------------
console.log('\n--- 3. a bank written while the verifier answers nothing is stamped ---');
const vnode = mkNode(bankProject, 'Ohm\'s law', 1);
const vqs = [mc('SILENT one: what is 2 + 2?'), mc('SILENT two: what is 2 + 2?')];
const vquiz = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(vnode, 'Vetted', JSON.stringify(vqs)).lastInsertRowid;
const vres = await vetQuiz(vnode, { id: vquiz, questions: vqs });
const vstored = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(vquiz).questions);
check('both are kept (the feed is not starved)', vstored.length === 2, `${vstored.length} kept`);
check('...and both are STAMPED on the stored row', vstored.every(q => q.unverified && q.unverified.reason), JSON.stringify(vstored.map(q => q.unverified ?? null)));
check('...and counted as unverified in what the route returns', vres.unverified === 2);
check('...so the check draws neither', drawFromNode(vnode, 10).questions.length === 0);

// ---- 4. placement ---------------------------------------------------------------------
console.log('\n--- 4. an unconfirmed probe question seeds nothing ---');
const seededIn = (pid) => db.prepare(`
    SELECT COUNT(*) AS n FROM node_mastery nm JOIN nodes n ON n.id = nm.node_id
    WHERE n.project_id = ? AND nm.placement_prior IS NOT NULL`).get(pid).n;
const placementEvidence = (pid) => db.prepare(`
    SELECT COUNT(*) AS n FROM mastery_evidence me JOIN nodes n ON n.id = me.node_id
    WHERE n.project_id = ? AND me.evidence_type = 'placement'`).get(pid).n;
const probeCase = (label, shape) => {
    const pid = db.prepare('INSERT INTO projects (name) VALUES (?)').run(`Probe ${label}`).lastInsertRowid;
    const phase = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, 0)').run(pid, 'Phase').lastInsertRowid;
    for (let i = 0; i < 8; i++) db.prepare('INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, ?, ?, ?)').run(pid, phase, `Topic ${i + 1}`, i);
    const probe = createProbe(pid, { limit: 4 });
    setProbeQuestions(probe.id, probe.targets.map((t, i) => shape({
        node_id: t.node_id, seq: t.seq, type: 'multiple_choice', question: `Probe question ${i}?`,
        options: ['a', 'b', 'c', 'd'], correct_answer: 'a', explanation: 'because', verified: true,
    })));
    recordProbeAnswer(probe.id, { questionIndex: 3, correct: true });
    // Archived afterwards, so the burst in section 5 does not try to teach it.
    db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(pid);
    return { seeded: seededIn(pid), evidence: placementEvidence(pid) };
};
const good = probeCase('checked', q => q);
check('control: a checked probe answer seeds its topic and the ones before it', good.seeded > 1 && good.evidence === 1, JSON.stringify(good));
const old = probeCase('pre-fix', q => ({ ...q, verified: false }));
check('a probe stored with verified:false (the pre-fix shape) seeds nothing', old.seeded === 0, JSON.stringify(old));
check('...and records no evidence', old.evidence === 0, JSON.stringify(old));
const st = probeCase('stamped', q => stamp(q));
check('a probe question stamped unverified seeds nothing', st.seeded === 0 && st.evidence === 0, JSON.stringify(st));

// ---- 5. asked again later -------------------------------------------------------------
console.log('\n--- 5. a later verdict decides it, asked once each, off the request path ---');
const rproject = mkProject('Reverify');
const rnode = mkNode(rproject, 'Adding small numbers again');
const rqs = [
    ...Array.from({ length: 7 }, (_, i) => mc(`Checked ${i + 1}: what is 2 + 2?`)),
    stamp(mc('CONFIRM me: what is 2 + 2?'), 60),
    stamp(mc('DISPUTE me: what is 2 + 2?'), 60),
    stamp(mc('SILENT me: what is 2 + 2?'), 60),
];
const rquiz = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(rnode, 'Bank', JSON.stringify(rqs)).lastInsertRowid;
const rfeed = feedRow(rnode, 2, stamp(mc('CONFIRMED in the feed: what is 2 + 2?'), 60), { questionType: 'multiple_choice', verified: false });
verifierCalls.clear();
const heldDraw = drawFromNode(rnode, 50); // the check opens: 3 held back → the chain is told
check('the draw that holds them back does not wait for a verdict', heldDraw.questions.length === 7 && verifierCalls.size === 0);

const waitFor = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 100)); }
    return pred();
};
const bankNow = () => JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(rquiz)?.questions || '[]');
const settled = await waitFor(() => {
    const qs = bankNow();
    const feed = JSON.parse(db.prepare('SELECT content FROM feed_items WHERE id = ?').get(rfeed).content);
    return !qs.some(q => /DISPUTE/.test(q.question)) && !feed.unverified && (qs.find(q => /SILENT/.test(q.question))?.unverified?.tries ?? 1) > 1;
});
check('the chain reached every due question', settled);
const after = bankNow();
const confirmed = after.find(q => /CONFIRM me/.test(q.question));
check('a confirmed question loses its stamp and records when', !!confirmed && !confirmed.unverified && !!confirmed.verifiedAt, JSON.stringify(confirmed ?? null));
check('...and the check now draws it', drawFromNode(rnode, 50).questions.some(q => /CONFIRM me/.test(q.question.question)));
check('a disputed question is deleted, like any vetoed one', !after.some(q => /DISPUTE/.test(q.question)));
const silent = after.find(q => /SILENT me/.test(q.question));
check('a question still without a verdict stays stamped, and waits longer', !!silent?.unverified && silent.unverified.tries === 2 && Date.parse(silent.unverified.next) > Date.now() + 20 * 60000, JSON.stringify(silent?.unverified ?? null));
check('each was asked exactly once (no loop on a silent verifier)',
    verifierCalls.get('CONFIRM') === 1 && verifierCalls.get('CONFIRMED') === 1 && verifierCalls.get('DISPUTE') === 1 && verifierCalls.get('SILENT') === 1, JSON.stringify([...verifierCalls]));
const beforeFeed = evidence(rnode);
answer(rnode, rfeed, `fi-${rfeed}`);
check('a feed question confirmed later counts: its answer writes evidence', evidence(rnode) === beforeFeed + 1, `${evidence(rnode) - beforeFeed} written`);

// ---- 6. a position is not an identity ---------------------------------------------------
console.log('\n--- 6. an asked question is found by its uuid; one that cannot be identified is not proof ---');
const { logAsked } = await import(B + 'questionLog.js');
const unode = mkNode(bankProject, 'Shifted bank', 3);
const uquiz = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(unode, 'Bank', JSON.stringify([
    stamp(mc('Shift S0: what is 2 + 2?')), stamp(mc('Shift S1: what is 2 + 2?')),
    mc('Shift C2: what is 2 + 2?'), mc('Shift C3: what is 2 + 2?'), mc('Shift C4: what is 2 + 2?'), mc('Shift C5: what is 2 + 2?'),
])).lastInsertRowid;
const uBank = () => JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(uquiz).questions);
const drawnCopy = uBank(); // what a whole-row sitting drew, with each question's place in it
// The background chain disputes S0 while the sitting is open: the row is spliced.
trust?.applyVerdict?.({ where: 'bank', quizId: uquiz, index: 0, uuid: drawnCopy[0].uuid, question: drawnCopy[0] }, { available: true, ok: false, reason: 'the key is wrong' });
check('fixture: the veto moved every later question up one place', uBank().length === 5 && uBank()[1].question.startsWith('Shift C2'));
// The learner answered S1 (unchecked, marked) and C2..C5, all right, with the
// positions the copy was drawn at.
const shiftedAsked = drawnCopy.slice(1).map((q, i) => ({ index: i + 1, uuid: q.uuid, correct: true }));
const shifted = trust?.provenSitting?.({ quizId: uquiz, asked: shiftedAsked, score: 5, total: 5 });
check('the stamped S1 stays out of the evidence after the shift: 4/4, not 5/5 (by position, index 1 is now the checked C2)',
    shifted?.score === 4 && shifted?.total === 4, JSON.stringify(shifted));
const logBefore = db.prepare('SELECT COUNT(*) AS n FROM question_log').get().n;
logAsked([{ quizId: uquiz, index: 1, uuid: drawnCopy[1].uuid, correct: true }], 'quiz');
const logged = db.prepare('SELECT question_uuid, question_index FROM question_log ORDER BY id DESC LIMIT 1').get();
check('the ask-record names the question answered (S1, now at 0), not whatever moved into its old place',
    db.prepare('SELECT COUNT(*) AS n FROM question_log').get().n === logBefore + 1 && logged?.question_uuid === drawnCopy[1].uuid && logged?.question_index === 0, JSON.stringify(logged));
const blind = trust?.provenSitting?.({ quizId: uquiz, asked: [{ index: 1, correct: true }], score: 1, total: 1 });
check('an entry with no uuid and no stem, in a bank holding a stamped question, is not proof', blind?.total === 0, JSON.stringify(blind));
const wrongStem = trust?.provenSitting?.({ quizId: uquiz, asked: [{ index: 1, stem: drawnCopy[1].question, correct: true }], score: 1, total: 1 });
check('...and one whose stem no longer matches its position is not either', wrongStem?.total === 0, JSON.stringify(wrongStem));
const rightStem = trust?.provenSitting?.({ quizId: uquiz, asked: [{ index: 1, stem: uBank()[1].question, correct: true }], score: 1, total: 1 });
check('control: a stem that matches its position counts', rightStem?.score === 1 && rightStem?.total === 1, JSON.stringify(rightStem));
const noAsked = trust?.provenSitting?.({ quizId: uquiz, asked: [], score: 5, total: 5 });
const nullAsked = trust?.provenSitting?.({ quizId: uquiz, asked: null, score: 5, total: 5 });
check('no `asked` at all, for a bank holding a stamped question: the client\'s 5/5 counts for nothing',
    noAsked?.total === 0 && nullAsked?.total === 0, JSON.stringify([noAsked, nullAsked]));
const plainBank = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(unode, 'Plain', JSON.stringify([mc('Plain P1: what is 2 + 2?')])).lastInsertRowid;
const plain = trust?.provenSitting?.({ quizId: plainBank, asked: null, score: 1, total: 1 });
check('control: with nothing stamped in the row, the client\'s numbers stand', plain?.score === 1 && plain?.total === 1, JSON.stringify(plain));
const twice = trust?.provenSitting?.({ quizId: uquiz, asked: [2, 2, 2, 2].map(() => ({ index: 1, uuid: uBank()[1].uuid, correct: true })), score: 4, total: 4 });
check('one question named four times counts once', twice?.score === 1 && twice?.total === 1, JSON.stringify(twice));

// ---- 7. a bank is stamped from the moment it is stored ---------------------------------
console.log('\n--- 7. a written bank is pending until vetQuiz confirms it; a cancelled vetting leaves it stamped ---');
const { finalizeQuiz } = await import(B + 'studyMaterial.js');
const pnode = mkNode(bankProject, 'Pending bank', 4);
const written = (tag) => JSON.stringify(['CONFIRM p1', 'DISPUTE p2', 'SILENT p3', 'CONFIRM p4'].map(s => mc(`${s} ${tag}: what is 2 + 2?`)));
const pquiz = finalizeQuiz(pnode, written('vetted'), false);
const pBank = (id) => JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(id)?.questions || '[]');
const stored = pBank(pquiz.id);
check('finalizeQuiz stores every question stamped pending ("not checked yet", no try spent)',
    stored.length === 4 && stored.every(q => q.unverified?.tries === 0 && q.unverified?.reason === 'not checked yet'), JSON.stringify(stored.map(q => q.unverified ?? null)));
check('...so while the vetting runs, the check draws none of them', drawFromNode(pnode, 10).questions.length === 0);
check('...and the background chain leaves them to vetQuiz for now (not due yet)', (trust?.pendingVerifications?.(pnode) ?? []).length === 0);
check('...and hands the caller the uuids the database gave them', pquiz.questions.every(q => typeof q.uuid === 'string') && pquiz.questions.map(q => q.uuid).join() === stored.map(q => q.uuid).join());
verifierCalls.clear();
const pvetted = await vetQuiz(pnode, pquiz);
const pafter = pBank(pquiz.id);
const pq = (t) => pafter.find(q => q.question.startsWith(t));
check('vetQuiz: a confirmed question loses the stamp and records when', ['CONFIRM p1', 'CONFIRM p4'].every(t => pq(t) && !pq(t).unverified && pq(t).verifiedAt), JSON.stringify(pafter));
check('vetQuiz: a disputed question is deleted', !pq('DISPUTE p2') && pafter.length === 3);
check('vetQuiz: a question with no verdict (asked twice) becomes a failed verification the chain retries', pq('SILENT p3')?.unverified?.tries === 1 && verifierCalls.get('SILENT') === 2, JSON.stringify(pq('SILENT p3')?.unverified ?? null));
check('the questions keep the uuids they were stored with (a rewrite from memory would re-mint them)', pafter.every(q => stored.some(s => s.uuid === q.uuid)));
check('...and the check now draws the two confirmed ones', drawFromNode(pnode, 10).questions.length === 2);
check('what vetQuiz returns is the stored row', pvetted.questions.length === 3 && pvetted.unverified === 1);

const anode = mkNode(bankProject, 'Cancelled vetting', 5);
const aquiz = finalizeQuiz(anode, written('cancelled'), false);
const cancel = new AbortController();
cancel.abort();
let abortedThrow = false;
try { await vetQuiz(anode, aquiz, { signal: cancel.signal }); } catch { abortedThrow = true; }
const astored = pBank(aquiz.id);
check('a vetting cancelled from the dock throws', abortedThrow);
check('...and leaves every question it did not decide stamped, never proof', astored.length === 4 && astored.every(q => q.unverified) && drawFromNode(anode, 10).questions.length === 0,
    JSON.stringify(astored.map(q => q.unverified ?? null)));
check('...where the background chain picks them up once the wait is over',
    (trust?.pendingVerifications?.(anode, { now: Date.now() + 16 * 60000, limit: 10 }) ?? []).length === 4);
check('a question a person wrote (an import) is stored unstamped; one a file marks unchecked is stamped pending',
    !!trust?.importedQuestion && !trust.importedQuestion(mc('Hand-written')).unverified && trust.importedQuestion({ ...mc('Marked'), unchecked: true }).unverified?.tries === 0
    && !('unchecked' in trust.importedQuestion({ ...mc('Marked'), unchecked: true })));

// ---- 8. capture's questions ------------------------------------------------------------
console.log('\n--- 8. the questions capture\'s enrichment model writes are stamped pending ---');
const { createCapture, enrichCapture } = await import(B + 'capture.js');
const cap = createCapture({ text: 'Two and two make four, which is why a pair of pairs is a quartet.' });
const enriched = await enrichCapture({ nodeId: cap.nodeId });
db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(cap.projectId);
const capBank = db.prepare('SELECT questions FROM quizzes WHERE node_id = ?').all(cap.nodeId).flatMap(r => JSON.parse(r.questions));
check('fixture: enrichment wrote one question from the stub', enriched?.questionCount === 1 && capBank.length === 1, JSON.stringify(enriched));
check('...stored stamped pending, so it is practice until a verifier confirms it', capBank[0]?.unverified?.tries === 0, JSON.stringify(capBank[0]?.unverified ?? null));
const { pendingVerification } = await import(B + 'feedGen.js');
check('...and due at once for the background chain', pendingVerification(cap.nodeId)?.entry?.question?.question === 'CONFIRM capture: what is 2 + 2?');

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise(r => stub.close(r));
db.close();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL */ }
process.exitCode = fail ? 1 : 0;
