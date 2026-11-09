#!/usr/bin/env node
/**
 * tools/practice-proof-gates.mjs — practice tunes the estimate, it never
 * proves a topic.
 *
 *   node tools/practice-proof-gates.mjs [--root DIR]
 *
 * Card ratings and drill rounds feed the topic's BKT estimate: that is what
 * keeps a topic reviewed every morning from fading. But a card is graded by
 * the learner's own press and a drill replays the same few items, so neither
 * is proof. Before this suite, four Easy ratings on a fresh topic gave an
 * estimate of 0.99, and the gate's BKT clause read that estimate whole: the
 * topic could be completed under `enforced` with no question ever answered.
 *
 * The rule pinned here: the gate's BKT clause reads the estimate with cards
 * and drills taken out (`gate_score`, a replay of the app-graded evidence with
 * any wrong agent claim's lowering kept), and never more than the stored
 * estimate, so practice never enters what the gate sees and can pull it lower.
 * Only app-graded answers (quiz, mastery check, paper) count toward
 * un-borrowing a seeded prior.
 *
 * Every case of the table in the PR is a block below, each with its expected
 * answer. --root runs the same cases against another checkout's server; on
 * the code before the fix the practice cases fail.
 *
 * Deterministic: a scratch library, no model, no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:http';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = resolve(argOf('--root') || repo);

// Set in-process, before any server module is imported.
const scratch = mkdtempSync(join(tmpdir(), 'practice-proof-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const S = pathToFileURL(join(ROOT, 'server') + '/').href;
const { default: db } = await import(S + 'database.js');
if (!process.env.DB_PATH.startsWith(scratch)) throw new Error('refusing: not the scratch library');
const mastery = await import(S + 'mastery.js');
const { updateMasteryFromAttempt, checkMasteryEligibility, applySeededPrior, getNodeMastery } = mastery;
const { recordCardEvidence } = await import(S + 'cardEvidence.js');
const { checkpointFacts } = await import(S + 'feed.js');
const { canProve } = await import(S + 'readyToProve.js');
const { agentMastery } = await import(S + 'agentReads.js');
const { projectProgress } = await import(S + 'progress.js');
const { projectCompletion } = await import(S + 'completion.js');
const { recordClaim } = await import(S + 'claims.js');
const { createApp } = await import(S + 'app.js');

const T = 0.85, PASS = 0.8;
const gate = { mode: 'enforced', threshold: T, checkPass: PASS };
const el = (id) => checkMasteryEligibility(id, T, PASS);
const score = (id) => getNodeMastery(id).mastery_score;
const show = (id) => JSON.stringify(el(id));

const course = Number(db.prepare("INSERT INTO projects (name) VALUES ('Waves')").run().lastInsertRowid);
const deck = Number(db.prepare("INSERT INTO projects (name, kind) VALUES ('Kana', 'deck')").run().lastInsertRowid);
const addNode = (pid, title, extra = {}) => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, scheduled_end) VALUES (?, NULL, ?, 0, ?)',
).run(pid, title, extra.scheduledEnd ?? null).lastInsertRowid);

let cardSeq = 0, reviewSeq = 0;
const addCards = (nodeId, n) => Array.from({ length: n }, () => Number(db.prepare(
    'INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, ?)',
).run(nodeId, `front ${++cardSeq}`, `back ${cardSeq}`).lastInsertRowid));
/** A rating as PUT /api/ai/flashcards/:id leaves it, then the evidence hook it runs. */
const rate = (cardId, rating, source = 'app') => {
    reviewSeq++;
    db.prepare(`
        INSERT INTO review_log (card_id, reviewed_at, rating, state_before, elapsed_days, scheduled_days, source)
        VALUES (?, ?, ?, 0, 0, 1, ?)
    `).run(cardId, new Date(Date.UTC(2026, 0, 1) + reviewSeq * 1000).toISOString(), rating, source);
    db.prepare(`UPDATE flashcards SET review_count = review_count + 1, last_reviewed = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(cardId);
    return recordCardEvidence(cardId);
};
const feedAnswer = (id, correct) => updateMasteryFromAttempt(id, correct ? 1 : 0, 1, 'quiz', { questionType: 'multiple_choice' });

// ---- the real app, for the completion route --------------------------------
const server = createApp().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const { port } = server.address();
const call = (method, path, body) => new Promise((ok, no) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => { text += c; });
        res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } ok({ status: res.statusCode, body: json }); });
    });
    req.on('error', no);
    req.end(JSON.stringify(body));
});
const setMode = (mode) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mastery_gate_mode', ?)").run(mode);
const reopen = (id) => db.prepare("UPDATE nodes SET status = 'in_progress', completed_at = NULL WHERE id = ?").run(id);
const statusOf = (id) => db.prepare('SELECT status FROM nodes WHERE id = ?').get(id).status;

try {
    console.log('\n--- 1. cards only (the rating path itself) ---');
    const carded = addNode(course, 'Standing waves');
    const cards = addCards(carded, 4);
    cards.forEach(c => rate(c, 4));
    check('four Easy ratings still raise the estimate (cards keep a topic fresh)', score(carded) >= T, String(score(carded)));
    check('…but the topic is not eligible', el(carded).eligible === false, show(carded));
    check('…the gate reads the estimate without the cards (gate_score 0)', el(carded).gate_score === 0, show(carded));
    check('…no rating is an answer of its own (own_answers 0)', el(carded).own_answers === 0, show(carded));
    check('…and the read says practice lifted the estimate (practice_lifted)', el(carded).practice_lifted === true, show(carded));
    check('…4 of 4 right is not 0 to the learner: the shown number rises to the practice ceiling (0.6)', el(carded).shown_score === 0.6 && mastery.PRACTICE_CEILING === 0.6, show(carded));
    check('…which stays under the line, so the shown number never reads as a pass', el(carded).shown_score < T, show(carded));
    // Two right cards of four (a batch counts from four ratings): the shown
    // number is the estimate itself, under the ceiling.
    const halfCarded = addNode(Number(db.prepare("INSERT INTO projects (name) VALUES ('Beats')").run().lastInsertRowid), 'Beats');
    addCards(halfCarded, 4).forEach((c, i) => rate(c, i < 2 ? 3 : 1));
    check('mixed cards: shown is the stored estimate when it is under the ceiling, and over 0', el(halfCarded).shown_score === Math.min(score(halfCarded), 0.6) && el(halfCarded).shown_score > 0, show(halfCarded));
    // A pass line set below the ceiling: practice still never reaches it.
    const lowLine = checkMasteryEligibility(carded, 0.5, PASS);
    check('a pass line at 50%: cards show 49%, not 60% and not eligible', lowLine.eligible === false && Math.abs(lowLine.shown_score - 0.49) < 1e-12, JSON.stringify(lowLine));
    setMode('enforced');
    let r = await call('PUT', `/api/nodes/${carded}`, { status: 'completed' });
    check('enforced: completing it is refused (400, mastery_gate, not advisory)', r.status === 400 && r.body?.mastery_gate === true && r.body?.advisory === false && statusOf(carded) !== 'completed', `${r.status} ${JSON.stringify(r.body)}`);
    check('…and the refusal asks for a quiz or check, never quoting the cards\' 99%', r.status === 400 && !/\b99%/.test(r.body?.error || '') && r.body?.mastery_score === mastery.PRACTICE_CEILING, JSON.stringify(r.body));
    r = await call('PUT', `/api/nodes/${carded}`, { status: 'skipped' });
    check('enforced: skipping it is always allowed', r.status === 200 && statusOf(carded) === 'skipped', `${r.status} ${JSON.stringify(r.body)}`);
    reopen(carded);
    setMode('advisory');
    r = await call('PUT', `/api/nodes/${carded}`, { status: 'completed' });
    check('advisory: refused as advisory (the dialog offers "Mark done without the check")', r.status === 400 && r.body?.advisory === true, `${r.status} ${JSON.stringify(r.body)}`);
    r = await call('PUT', `/api/nodes/${carded}`, { status: 'completed', override: true });
    check('advisory: marking it done without the check works', r.status === 200 && statusOf(carded) === 'completed', `${r.status} ${JSON.stringify(r.body)}`);
    reopen(carded);
    setMode('off');
    r = await call('PUT', `/api/nodes/${carded}`, { status: 'completed' });
    check('off: completes as before', r.status === 200 && statusOf(carded) === 'completed', `${r.status} ${JSON.stringify(r.body)}`);
    reopen(carded);
    setMode('enforced');

    console.log('\n--- 2. drills only ---');
    const drilled = addNode(course, 'Beats');
    for (let i = 0; i < 3; i++) updateMasteryFromAttempt(drilled, 8, 8, 'drill', { source: 'drill' });
    check('three perfect drill rounds raise the estimate', score(drilled) >= T, String(score(drilled)));
    check('…and do not make the topic eligible', el(drilled).eligible === false && el(drilled).practice_lifted === true, show(drilled));

    console.log('\n--- 3. cards on top of a failed check ---');
    const failed = addNode(course, 'Doppler effect');
    updateMasteryFromAttempt(failed, 1, 5, 'mastery_check', { type: 'mastery_check' });
    for (let i = 0; i < 3; i++) updateMasteryFromAttempt(failed, 20, 20, 'flashcard', { source: 'review' });
    check('sixty Easy ratings after a 1/5 check lift the estimate', score(failed) >= T, String(score(failed)));
    check('…but the gate still reads the failed check (not eligible)', el(failed).eligible === false && el(failed).gate_score < T, show(failed));

    console.log('\n--- 3b. cards on top of a weak quiz (the "four app-graded answers" design would pass this) ---');
    const weak = addNode(course, 'Resonance');
    updateMasteryFromAttempt(weak, 3, 5, 'quiz', { questionType: 'multiple_choice' });
    const weakAlone = score(weak);
    updateMasteryFromAttempt(weak, 20, 20, 'flashcard', { source: 'review' });
    check('a 3/5 quiz alone is under the threshold', weakAlone < T, String(weakAlone));
    check('…cards push the estimate over it', score(weak) >= T, String(score(weak)));
    check('…and the gate still says no, at the quiz\'s own estimate', el(weak).eligible === false && Math.abs(el(weak).gate_score - weakAlone) < 1e-12, show(weak));

    console.log('\n--- 4. a seeded prior plus cards ---');
    const seeded = addNode(course, 'Wave speed');
    applySeededPrior(seeded, 'placement', 0.6);
    updateMasteryFromAttempt(seeded, 4, 4, 'flashcard', { source: 'review' });
    check('four ratings do not un-borrow a placement seed (borrowed, own_answers 0)', el(seeded).borrowed_estimate === true && el(seeded).own_answers === 0, show(seeded));
    check('…and the topic is not eligible', el(seeded).eligible === false, show(seeded));
    const seededAnswered = addNode(course, 'Wavelength');
    applySeededPrior(seededAnswered, 'transfer', 0.6);
    for (let i = 0; i < 4; i++) feedAnswer(seededAnswered, true);
    check('four answered questions do un-borrow it, as before', el(seededAnswered).borrowed_estimate === false && el(seededAnswered).own_answers === 4, show(seededAnswered));
    check('…and those answers on the seed can prove it, as before', el(seededAnswered).eligible === (score(seededAnswered) >= T) && score(seededAnswered) >= T, show(seededAnswered));
    const placed = addNode(course, 'Amplitude');
    applySeededPrior(placed, 'placement', 0.6);
    // The row recordPlacementEvidence writes: evidence with no BKT update.
    db.prepare(`INSERT INTO mastery_evidence (node_id, evidence_type, score, total, metadata) VALUES (?, 'placement', 1, 1, ?)`)
        .run(placed, JSON.stringify({ questionType: 'multiple_choice', source: 'placement', probeId: 1, questionIndex: 0 }));
    for (let i = 0; i < 3; i++) feedAnswer(placed, true);
    check('the placement probe\'s own answer is part of the seed, not one of the four', el(placed).borrowed_estimate === true && el(placed).own_answers === 3, show(placed));
    feedAnswer(placed, true);
    check('…a fourth answered question un-borrows it', el(placed).borrowed_estimate === false && el(placed).own_answers === 4, show(placed));

    console.log('\n--- 5. a deck section (cards are all it has) ---');
    const s1 = addNode(deck, 'Hiragana (a named subdeck)');
    const s2 = addNode(deck, 'Katakana (a named subdeck)');
    addCards(s1, 4).forEach(c => rate(c, 4));
    addCards(s2, 4).forEach(c => rate(c, 3));
    check('a section whose every card is rated is not proven by them', el(s1).eligible === false && el(s2).eligible === false, `${show(s1)} ${show(s2)}`);
    r = await call('PUT', `/api/nodes/${s1}`, { status: 'completed' });
    check('enforced: the section cannot be completed by its ratings', r.status === 400 && r.body?.mastery_gate === true, `${r.status} ${JSON.stringify(r.body)}`);
    check('…yet the deck is finished: progress counts cards met, not sections closed', projectProgress(deck).fraction === 1, JSON.stringify(projectProgress(deck)));
    r = await call('PUT', `/api/nodes/${s2}`, { status: 'skipped' });
    check('…and a section can still be closed as skipped', r.status === 200 && statusOf(s2) === 'skipped', `${r.status} ${JSON.stringify(r.body)}`);

    console.log('\n--- 6. an Anki deck imported with its history ---');
    const imported = addNode(deck, 'Kanji (imported with its revlog)');
    addCards(imported, 10).forEach(c => rate(c, 4, 'anki'));
    check('an imported revlog is no evidence at all', el(imported).has_evidence === false && el(imported).eligible === false, show(imported));

    console.log('\n--- 7. a course topic with cards and no question bank ---');
    const past = '2026-01-01';
    const noBank = addNode(course, 'Interference', { scheduledEnd: past });
    addCards(noBank, 4).forEach(c => rate(c, 4));
    const facts = checkpointFacts(noBank, gate);
    check('its checkpoint card does not offer completion as proven', facts.eligible === false, JSON.stringify(facts));
    check('…and carries why the high estimate does not count (practiceLifted)', facts.practiceLifted === true, JSON.stringify(facts));
    check('…the gate counts 0 (gateScore), the card prints the cards up to the ceiling (shownScore 60%, not 99%, not 0%)', facts.gateScore === 0 && facts.shownScore === 0.6 && facts.practiceCeiling === 0.6 && facts.masteryScore >= T, JSON.stringify(facts));
    check('…and the cards are shown as what they did (4 of 4 right)', facts.practiceRight === 4 && facts.practiceTotal === 4, JSON.stringify(facts));
    check('it is never "ready to prove" when late', canProve(noBank, gate) === false);
    const agent = agentMastery(noBank);
    check('an agent reading it is told it has not passed, and why', agent?.mastery?.passed === false && /card reviews and drills/i.test(agent?.text || ''), agent?.text);

    console.log('\n--- 8. a passed check, then missed cards ---');
    const proven = addNode(course, 'Harmonics');
    updateMasteryFromAttempt(proven, 5, 5, 'mastery_check', { type: 'mastery_check' });
    check('a passed check makes the topic eligible', el(proven).eligible === true && el(proven).passed_assessment === true, show(proven));
    updateMasteryFromAttempt(proven, 0, 20, 'flashcard', { source: 'review' });
    check('missed cards lower the estimate', score(proven) < T, String(score(proven)));
    check('…and the pass still stands (a proof is not withdrawn by fading)', el(proven).eligible === true, show(proven));
    check('…so it is "ready to prove" (the control for case 7)', canProve(proven, gate) === true, show(proven));

    console.log('\n--- 9. answered questions still prove a topic ---');
    const answered = addNode(course, 'Nodes and antinodes');
    for (let i = 0; i < 20 && score(answered) < T; i++) feedAnswer(answered, true);
    check('feed answers alone reach the threshold and make it eligible', score(answered) >= T && el(answered).eligible === true, show(answered));
    check('with no practice, the gate reads the stored estimate exactly', el(answered).gate_score === score(answered), show(answered));
    const paper = addNode(course, 'Superposition');
    updateMasteryFromAttempt(paper, 4, 5, 'paper', {});
    check('a passed paper exercise proves it', el(paper).eligible === true, show(paper));
    const proofThenCards = addNode(course, 'Phase');
    for (let i = 0; i < 20 && score(proofThenCards) < T; i++) feedAnswer(proofThenCards, true);
    updateMasteryFromAttempt(proofThenCards, 4, 4, 'flashcard', { source: 'review' });
    check('Easy cards after a proof leave it proven', el(proofThenCards).eligible === true, show(proofThenCards));
    updateMasteryFromAttempt(proofThenCards, 0, 20, 'flashcard', { source: 'review' });
    check('missed cards can take a BKT proof back below the line (practice may lower)', el(proofThenCards).eligible === false && el(proofThenCards).gate_score <= score(proofThenCards) && el(proofThenCards).practice_lifted === false, show(proofThenCards));
    check('…and the shown number never rises above the stored estimate (missed cards show as missed)', el(proofThenCards).shown_score <= score(proofThenCards) && el(proofThenCards).shown_score >= el(proofThenCards).gate_score, show(proofThenCards));

    console.log('\n--- 9b. an agent\'s wrong claim, then cards ---');
    const claimed = addNode(course, 'Resonant frequency');
    for (let i = 0; i < 20 && score(claimed) < 0.9; i++) feedAnswer(claimed, true);
    const claim = recordClaim({ nodeId: claimed, correct: false, questionType: 'short_answer' });
    const lowered = score(claimed);
    check('a wrong claim lowers a proven estimate under the line', claim.lowered === true && lowered < T && el(claimed).eligible === false, `${JSON.stringify(claim)} ${show(claimed)}`);
    addCards(claimed, 4).forEach(c => rate(c, 4));
    check('…Easy cards after it raise the estimate again', score(claimed) >= T, String(score(claimed)));
    check('…but the gate keeps the claim\'s lowering (cards do not wash it out)', el(claimed).eligible === false && Math.abs(el(claimed).gate_score - lowered) < 1e-12, show(claimed));
    feedAnswer(claimed, true);
    check('…while an answered question after it counts, as it would have', el(claimed).gate_score > lowered, show(claimed));

    console.log('\n--- 9d. a wrong claim, then a rebuild of the estimate ---');
    // A rebuild from the app's own evidence (an item report, a cleared head
    // start) drops the claim from the stored score, as claims.js intends; the
    // gate keeps it either way, so its answer does not depend on whether the
    // topic was rebuilt or ever met a card.
    const rebuilt = addNode(course, 'Standing wave modes');
    for (let i = 0; i < 20 && score(rebuilt) < 0.9; i++) feedAnswer(rebuilt, true);
    recordClaim({ nodeId: rebuilt, correct: false, questionType: 'short_answer' });
    const claimLow = score(rebuilt);
    mastery.rescoreNode(rebuilt);
    check('a rebuild lifts the stored score back over the line (the claim is dropped there)', score(rebuilt) >= T && score(rebuilt) > claimLow, `${claimLow} -> ${score(rebuilt)}`);
    check('…and the gate still reads the claim\'s lowering', el(rebuilt).eligible === false && Math.abs(el(rebuilt).gate_score - claimLow) < 1e-12, show(rebuilt));
    check('…so estimateProven (the completion count, transfer, the Atlas) says not proven either', mastery.estimateProven?.(rebuilt, T) === false);
    check('…and nothing blames cards or drills it never had (practice_lifted false)', el(rebuilt).practice_lifted === false, show(rebuilt));

    console.log('\n--- 9e. a claim row with no evidence mark ---');
    // None is written without one (claims.js reads MAX(id) or 0); a row from
    // elsewhere is stepped after everything, never before the answers it may follow.
    const unmarked = addNode(course, 'Overtones');
    for (let i = 0; i < 20 && score(unmarked) < 0.9; i++) feedAnswer(unmarked, true);
    const high = score(unmarked);
    db.prepare(`INSERT INTO mastery_claims (node_id, source, correct, question_type, mastery_before, mastery_after, evidence_mark, created_at)
                VALUES (?, 'mcp', 0, 'short_answer', ?, ?, NULL, '2026-11-09T00:00:00.000Z')`).run(unmarked, high, high - 0.1);
    check('it lowers what the gate reads (an unknown place fails closed)', el(unmarked).gate_score < high, show(unmarked));
    // Beside a marked claim: both step, the marked one at its place and the
    // unmarked one last (one Infinity at most after the dedupe, so the sort is safe).
    const both = addNode(course, 'Fundamental frequency');
    for (let i = 0; i < 20 && score(both) < 0.9; i++) feedAnswer(both, true);
    recordClaim({ nodeId: both, correct: false, questionType: 'short_answer' });
    const afterMarked = el(both).gate_score;
    db.prepare(`INSERT INTO mastery_claims (node_id, source, correct, question_type, mastery_before, mastery_after, evidence_mark, created_at)
                VALUES (?, 'mcp', 0, 'short_answer', 0.9, 0.8, NULL, '2026-11-09T00:00:00.000Z')`).run(both);
    const g = el(both).gate_score;
    check('beside a marked claim, both lower it (a number, below the marked claim alone)', Number.isFinite(g) && g < afterMarked, `${afterMarked} -> ${g}`);

    console.log('\n--- 9f. a seed under a low bar, plus one card ---');
    // At a bar at or under the 0.6 seed cap, the seed alone clears it: what a
    // borrowed estimate is held back from. Every reader of "proven" must agree.
    const lowBar = addNode(course, 'Wave packets');
    applySeededPrior(lowBar, 'transfer', 0.6);
    updateMasteryFromAttempt(lowBar, 1, 1, 'flashcard', { source: 'review' });
    check('the gate holds the borrowed estimate back at a 0.5 bar', checkMasteryEligibility(lowBar, 0.5, PASS).eligible === false && checkMasteryEligibility(lowBar, 0.5, PASS).borrowed_estimate === true, JSON.stringify(checkMasteryEligibility(lowBar, 0.5, PASS)));
    check('…and estimateProven agrees: a seed plus a card is not proven', mastery.estimateProven?.(lowBar, 0.5) === false);

    console.log('\n--- 9c. an evidence type the gate has not heard of ---');
    const unknown = addNode(course, 'Timbre');
    updateMasteryFromAttempt(unknown, 0, 1, 'quiz', { questionType: 'multiple_choice' });
    db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total) VALUES (?, 'future_kind', 8, 8)").run(unknown);
    db.prepare('UPDATE node_mastery SET mastery_score = 0.99 WHERE node_id = ?').run(unknown);
    check('it counts as practice until listed as proving (the gate fails closed)', el(unknown).eligible === false && el(unknown).gate_score < T && el(unknown).practice_lifted === true, show(unknown));
    // Practice is everything else by definition, so "exactly one of three" is
    // the two named sets not overlapping, and cards and drills not proving.
    check('no type is both proving and the seed, and cards and drills are known and not proving',
        mastery.VALID_EVIDENCE_TYPES.every(t => (mastery.PROVING_EVIDENCE_TYPES ?? []).includes(t) + (t === 'placement') <= 1)
        && ['flashcard', 'drill'].every(t => mastery.VALID_EVIDENCE_TYPES.includes(t) && !(mastery.PROVING_EVIDENCE_TYPES ?? []).includes(t)));

    console.log('\n--- 10. what else reads "proven" ---');
    // The finished-project screen counts proven topics; transfer borrows only
    // from proven twins (its own gate pins that half).
    const counted = projectCompletion(course)?.mastery?.proven;
    const expected = db.prepare('SELECT id FROM nodes WHERE project_id = ?').all(course)
        .filter(n => { const m = db.prepare('SELECT mastery_score, total_attempts FROM node_mastery WHERE node_id = ?').get(n.id); return m && m.total_attempts > 0 && m.mastery_score >= T && el(n.id).gate_score >= T && !el(n.id).borrowed_estimate; }).length;
    const lifted = db.prepare('SELECT id FROM nodes WHERE project_id = ?').all(course).filter(n => el(n.id).practice_lifted).length;
    check(`the finished-project screen counts ${expected} proven, not the ${lifted} lifted by cards or drills`, lifted > 0 && counted === expected, `counted ${counted}, expected ${expected}`);

    console.log('\n--- 11. the gate\'s replay is the live estimate when nothing else is in it ---');
    // Proving-only histories of every shape the live update takes (single
    // answers, a first batch of four, a batch after singles, a seed then a
    // batch, mixed types). One practice row scoring nothing is added straight
    // to the evidence table, so the replay runs and the stored estimate does
    // not move: gate_score must then equal the live estimate.
    const shapes = {
        'cold singles': (id) => [1, 0, 1, 1, 1].forEach(c => feedAnswer(id, !!c)),
        'first batch of four': (id) => updateMasteryFromAttempt(id, 4, 5, 'mastery_check', { type: 'mastery_check' }),
        'batch after singles': (id) => { feedAnswer(id, true); feedAnswer(id, false); updateMasteryFromAttempt(id, 3, 4, 'quiz', {}); },
        'seed then batch': (id) => { applySeededPrior(id, 'transfer', 0.6); updateMasteryFromAttempt(id, 4, 6, 'quiz', {}); },
        'mixed types': (id) => { updateMasteryFromAttempt(id, 2, 3, 'paper', {}); feedAnswer(id, true); updateMasteryFromAttempt(id, 5, 5, 'mastery_check', { type: 'mastery_check' }); },
    };
    for (const [name, build] of Object.entries(shapes)) {
        const id = addNode(course, `Replay: ${name}`);
        build(id);
        const live = score(id);
        db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total) VALUES (?, 'flashcard', 0, 1)").run(id);
        const g = el(id).gate_score;
        check(`${name}: replay ${g?.toFixed?.(6)} = live ${live.toFixed(6)}`, typeof g === 'number' && Math.abs(g - live) < 1e-12, show(id));
    }

    console.log('\n--- 12. the gate never reads more than the estimate ---');
    const all = db.prepare('SELECT node_id FROM node_mastery').all().map(x => x.node_id);
    const over = all.filter(id => typeof el(id).gate_score !== 'number' || el(id).gate_score > score(id) + 1e-12);
    check(`gate_score <= mastery_score on every topic (${all.length})`, all.length > 10 && over.length === 0, over.join(','));
} finally {
    server.close();
    db.close();
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
