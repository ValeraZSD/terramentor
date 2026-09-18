// tools/mastery-gates.mjs — checks the BKT learner model does what its docs say.
//
// Run:  node tools/mastery-gates.mjs
//
// Deterministic, no model, no network: a scratch database (DB_PATH) with one
// project and a few nodes, driven through the REAL `updateMasteryFromAttempt`.
//
// What is asserted is the part that was measured to be wrong on 2026-09-02:
// a 10-question assessment applied one answer at a time, with a learn
// transition after every answer, gave 0.70 for 8/10 if the correct answers were
// applied first and 0.99 if the wrong ones were — and the code always chose the
// first. An assessment is now ONE observation of a binomial outcome under one
// latent state (order cannot matter), with one transition after it, from the
// nominal prior p_L0 when the topic has never been measured here ("option
// three": the cold 0.0 start stays for single feed answers, which would otherwise
// read 65% after one lucky guess).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'mastery-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const db = (await import('../server/database.js')).default;
const {
    bktUpdate, bktBatchUpdate, updateMasteryFromAttempt, getNodeMastery, applySeededPrior,
    checkMasteryEligibility, MIN_GATE_QUESTIONS, MAX_ATTEMPT_QUESTIONS, BKT_PARAMS,
    GUESS_BY_QUESTION_TYPE,
} = await import('../server/mastery.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const projectId = Number(db.prepare(`INSERT INTO projects (name) VALUES ('gate')`).run().lastInsertRowid);
const mkNode = (title) => Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, ?, 0)`
).run(projectId, title).lastInsertRowid);

// ---- the pure function ------------------------------------------------------
console.log('\n--- bktBatchUpdate ---');
const MC = { p_G: 0.25 };
// The posterior, computed here from the model's definition rather than from the
// implementation: P(knows | k of n correct) by Bayes with a slip/guess
// likelihood, then one learning transition. This used to compare
// bktBatchUpdate(0.3, 8, 10) with itself, which held for any function at all.
const byHand = (prior, score, total, { p_G = BKT_PARAMS.p_G, p_S = BKT_PARAMS.p_S, p_T = BKT_PARAMS.p_T } = {}) => {
    const wrong = total - score;
    const know = prior * (1 - p_S) ** score * p_S ** wrong;
    const not = (1 - prior) * p_G ** score * (1 - p_G) ** wrong;
    const posterior = know / (know + not);
    const learned = posterior + (1 - posterior) * p_T;
    return Math.max(BKT_PARAMS.p_K_MIN, Math.min(BKT_PARAMS.p_K_MAX, learned));
};
check('8/10 on multiple choice is the Bayes posterior of the counts, plus one transition',
    near(bktBatchUpdate(0.3, 8, 10, MC), byHand(0.3, 8, 10, MC), 1e-12),
    `${bktBatchUpdate(0.3, 8, 10, MC)} vs ${byHand(0.3, 8, 10, MC)}`);
check('…and so is a middling 6/10, where the ceiling is not doing the work',
    near(bktBatchUpdate(0.3, 6, 10, MC), byHand(0.3, 6, 10, MC), 1e-12),
    `${bktBatchUpdate(0.3, 6, 10, MC)} vs ${byHand(0.3, 6, 10, MC)}`);
// The order-dependence the batch path exists to remove, exercised rather than
// described: the same 8-of-10 walked question by question lands somewhere else
// depending on which answers came first, and on the batch path there is only
// one number.
const sequential = (prior, pattern) => pattern.reduce((p, correct) => bktUpdate(p, correct, MC).p_K_posterior, prior);
// 6 of 10, not 8: at 8 every path is pinned to the 0.99 ceiling and any two of
// them agree for the wrong reason.
const rightFirst = sequential(0.3, [...Array(6).fill(true), false, false, false, false]);
const wrongFirst = sequential(0.3, [false, false, false, false, ...Array(6).fill(true)]);
check('the per-question path IS order-dependent — the bug the batch replaced',
    !near(rightFirst, wrongFirst, 1e-6), `${rightFirst.toFixed(3)} vs ${wrongFirst.toFixed(3)}`);
check('the batch answer is neither ordering\'s artefact',
    !near(bktBatchUpdate(0.3, 6, 10, MC), rightFirst, 1e-6)
    && !near(bktBatchUpdate(0.3, 6, 10, MC), wrongFirst, 1e-6),
    `${bktBatchUpdate(0.3, 6, 10, MC).toFixed(3)} vs ${rightFirst.toFixed(3)} / ${wrongFirst.toFixed(3)}`);
check('N = 1 equals the per-question update (same prior, same transition)',
    near(bktBatchUpdate(0.3, 1, 1, MC), bktUpdate(0.3, true, MC).p_K_posterior)
    && near(bktBatchUpdate(0.3, 0, 1, MC), bktUpdate(0.3, false, MC).p_K_posterior));
const p8 = bktBatchUpdate(BKT_PARAMS.p_L0, 8, 10, MC);
const p10 = bktBatchUpdate(BKT_PARAMS.p_L0, 10, 10, MC);
const p7 = bktBatchUpdate(BKT_PARAMS.p_L0, 7, 10, MC);
const p5 = bktBatchUpdate(BKT_PARAMS.p_L0, 5, 10, MC);
const p44 = bktBatchUpdate(BKT_PARAMS.p_L0, 4, 4, MC);
const p34 = bktBatchUpdate(BKT_PARAMS.p_L0, 3, 4, MC);
console.log(`        from p_L0=${BKT_PARAMS.p_L0}: 10/10=${p10.toFixed(3)} 8/10=${p8.toFixed(3)} 7/10=${p7.toFixed(3)} 5/10=${p5.toFixed(3)} 4/4=${p44.toFixed(3)} 3/4=${p34.toFixed(3)}`);
check('8/10 on multiple choice clears the 0.85 threshold from the nominal prior', p8 >= 0.85, p8.toFixed(3));
check('10/10 is at the ceiling', p10 >= 0.98, p10.toFixed(3));
check('4/4 (the shortest gate-eligible assessment) clears the threshold', p44 >= 0.85, p44.toFixed(3));
check('3/4 does not', p34 < 0.85, p34.toFixed(3));
check('a coin-flip result (5/10) lands BELOW the prior it started from', p5 < BKT_PARAMS.p_L0, p5.toFixed(3));
// 8/10 and up sit on the 0.99 ceiling for every format, so the comparisons
// below use 7/10 (0.90 from the nominal prior), where the arithmetic is visible.
check('monotone in the score', p10 >= p8 && p8 > p7 && p7 > p5);
const tf7 = bktBatchUpdate(BKT_PARAMS.p_L0, 7, 10, { p_G: 0.5 });
const sa7 = bktBatchUpdate(BKT_PARAMS.p_L0, 7, 10, { p_G: 0.05 });
check('the format guess floor still discounts: 7/10 true/false < 7/10 MC <= 7/10 open', tf7 < p7 && p7 <= sa7,
    `${tf7.toFixed(3)} ${p7.toFixed(3)} ${sa7.toFixed(3)}`);
// The ordering above holds for any three descending numbers. These are the
// values themselves — the formats' actual floors, which is the whole argument
// for having a table instead of one global 0.2.
check('true/false guesses at 1 in 2', GUESS_BY_QUESTION_TYPE.true_false === 0.5, String(GUESS_BY_QUESTION_TYPE.true_false));
check('four-option multiple choice at 1 in 4', GUESS_BY_QUESTION_TYPE.multiple_choice === 0.25, String(GUESS_BY_QUESTION_TYPE.multiple_choice));
check('an open answer at the small residual for bluffing past a grader', GUESS_BY_QUESTION_TYPE.short_answer === 0.05, String(GUESS_BY_QUESTION_TYPE.short_answer));
check('and the table holds exactly the registry\'s formats',
    JSON.stringify(Object.keys(GUESS_BY_QUESTION_TYPE).sort()) === '["code","fill_in","multiple_choice","numeric","sequence","short_answer","true_false"]',
    Object.keys(GUESS_BY_QUESTION_TYPE).join(','));
// A gap has nothing to eliminate either: the learner writes the word or they
// do not. Same floor as the other typed formats, and well under the tile.
check('typing the word is nothing like picking one of four',
    GUESS_BY_QUESTION_TYPE.fill_in < GUESS_BY_QUESTION_TYPE.multiple_choice, String(GUESS_BY_QUESTION_TYPE.fill_in));
// A typed number cannot be reached by elimination, so it sits with the open
// formats rather than with the four-option floor that made a calculation look
// like a coin flip with extra steps.
check('a typed number is nothing like picking one of four',
    GUESS_BY_QUESTION_TYPE.numeric < GUESS_BY_QUESTION_TYPE.multiple_choice, String(GUESS_BY_QUESTION_TYPE.numeric));
check('writing code that works is the hardest thing to fluke', GUESS_BY_QUESTION_TYPE.code < GUESS_BY_QUESTION_TYPE.short_answer, String(GUESS_BY_QUESTION_TYPE.code));
check('every floor is a probability strictly inside (0, 1)',
    Object.values(GUESS_BY_QUESTION_TYPE).every(g => typeof g === 'number' && g > 0 && g < 1));
check('an unknown format falls back to the global guess, never to a free pass',
    near(bktBatchUpdate(BKT_PARAMS.p_L0, 7, 10, { p_G: GUESS_BY_QUESTION_TYPE.essay }),
        bktBatchUpdate(BKT_PARAMS.p_L0, 7, 10, {}), 1e-12));
check('a 0.0 prior is floored, never a hard zero (the batch likelihood would otherwise be stuck at the transition)',
    bktBatchUpdate(0, 10, 10, MC) > 0.9, bktBatchUpdate(0, 10, 10, MC).toFixed(3));
check('clamped to [p_K_MIN, p_K_MAX]',
    bktBatchUpdate(0.99, 20, 20, MC) <= BKT_PARAMS.p_K_MAX && bktBatchUpdate(0.01, 0, 20, MC) >= BKT_PARAMS.p_K_MIN);

// ---- the write path ---------------------------------------------------------
console.log('\n--- updateMasteryFromAttempt ---');
const cold = mkNode('cold assessment');
const r1 = updateMasteryFromAttempt(cold, 8, 10, 'boss_fight', { questionType: 'multiple_choice' });
check('an unmeasured topic starts an assessment from the nominal prior, not from 0.0', near(r1.mastery_score, p8, 1e-9),
    `${r1.mastery_score} vs ${p8}`);
check('counters advanced', r1.total_attempts === 10 && r1.correct_attempts === 8);
check('...and the gate opens on the BKT clause alone (no raw-score help needed at 8/10)',
    checkMasteryEligibility(cold, 0.85, 0.99).eligible === true);

const cold2 = mkNode('cold assessment, worst order');
// The endpoint cannot send an order; but the OLD code applied k correct then N-k
// wrong. Prove the batch path is what runs: the result must equal the pure function.
const r2 = updateMasteryFromAttempt(cold2, 6, 10, 'quiz', { questionType: 'multiple_choice' });
check('6/10 from cold is the batch number, not the sequential 0.151',
    near(r2.mastery_score, bktBatchUpdate(BKT_PARAMS.p_L0, 6, 10, MC), 1e-9) && !near(r2.mastery_score, 0.151, 1e-3),
    r2.mastery_score.toFixed(3));

const single = mkNode('single feed answers');
const s1 = updateMasteryFromAttempt(single, 1, 1, 'quiz', { source: 'feed', questionType: 'multiple_choice' });
check('a single feed answer from cold stays on the per-question path (0.1 after one correct, as before)',
    near(s1.mastery_score, 0.1, 1e-9), String(s1.mastery_score));
const s2 = updateMasteryFromAttempt(single, 1, 1, 'quiz', { source: 'feed', questionType: 'multiple_choice' });
check('...and keeps climbing from its own posterior, not from p_L0', s2.mastery_score > s1.mastery_score && s2.mastery_score < 0.6,
    String(s2.mastery_score));

const measured = mkNode('measured then assessed');
updateMasteryFromAttempt(measured, 0, 1, 'quiz', { questionType: 'multiple_choice' });
updateMasteryFromAttempt(measured, 0, 1, 'quiz', { questionType: 'multiple_choice' });
const low = getNodeMastery(measured).mastery_score;
const r3 = updateMasteryFromAttempt(measured, 7, 10, 'quiz', { questionType: 'multiple_choice' });
check('a topic with its own (bad) evidence starts the assessment from THAT posterior, lower than the cold result',
    low < BKT_PARAMS.p_L0 && r3.mastery_score < p7 && r3.mastery_score > low,
    `prior ${low.toFixed(3)} → ${r3.mastery_score.toFixed(3)} (cold would be ${p7.toFixed(3)})`);

const seeded = mkNode('seeded by placement');
applySeededPrior(seeded, 'placement', 0.5, [{ note: 'gate' }]);
const r4 = updateMasteryFromAttempt(seeded, 7, 10, 'quiz', { questionType: 'multiple_choice' });
check('a seeded prior above p_L0 is the assessment prior (borrowed evidence counts for something)',
    r4.mastery_score > p7, `${r4.mastery_score.toFixed(3)} > ${p7.toFixed(3)}`);
check('a seeded prior BELOW p_L0 is lifted to it — the seed is never a handicap',
    (() => { const n = mkNode('seeded low'); applySeededPrior(n, 'placement', 0.2, []); return near(updateMasteryFromAttempt(n, 7, 10, 'quiz', { questionType: 'multiple_choice' }).mastery_score, p7, 1e-9); })());

const shortQuiz = mkNode('two-question quiz');
const r5 = updateMasteryFromAttempt(shortQuiz, 2, 2, 'quiz');
check(`an attempt shorter than MIN_GATE_QUESTIONS (${MIN_GATE_QUESTIONS}) stays on the per-question path`,
    near(r5.mastery_score, (() => { let p = 0; p = bktUpdate(p, true).p_K_posterior; return bktUpdate(p, true).p_K_posterior; })(), 1e-9),
    String(r5.mastery_score));

// ---- clause (b): the raw-score gate, at its two boundaries -------------------
//
// `checkMasteryEligibility` opens on a real assessment of at least
// MIN_GATE_QUESTIONS answered at at least `bossPass`. Both are `>=`, and the
// rewrite to `>` is exactly the edit a count of assertions does not notice,
// so both boundaries are tested sitting exactly ON the bar. `passed_assessment`
// is read rather than `eligible` so this measures clause (b) alone, with the BKT
// clause out of the picture whatever the posterior happens to be.
console.log('\n--- the assessment gate, exactly on its boundaries ---');
const BOSS_PASS = 0.8;
const assessed = (score, total) => {
    const n = mkNode(`assessment ${score}/${total}`);
    updateMasteryFromAttempt(n, score, total, 'boss_fight', { questionType: 'multiple_choice' });
    return checkMasteryEligibility(n, 0.85, BOSS_PASS);
};
check(`exactly MIN_GATE_QUESTIONS (${MIN_GATE_QUESTIONS}) questions, all right, counts as an assessment`,
    assessed(MIN_GATE_QUESTIONS, MIN_GATE_QUESTIONS).passed_assessment === true);
check(`one question fewer (${MIN_GATE_QUESTIONS - 1}/${MIN_GATE_QUESTIONS - 1}) does not, however well it went`,
    assessed(MIN_GATE_QUESTIONS - 1, MIN_GATE_QUESTIONS - 1).passed_assessment === false);
check(`a score exactly at the pass mark (8/10 = ${BOSS_PASS}) counts`,
    assessed(8, 10).passed_assessment === true);
check('one point lower (7/10) does not', assessed(7, 10).passed_assessment === false);
check('a topic with no evidence at all is not eligible on either clause',
    checkMasteryEligibility(mkNode('untouched'), 0.85, BOSS_PASS).eligible === false);
// Flashcard self-ratings are excluded from clause (b) on purpose: a learner
// pressing "Good" is not an assessment.
const selfRated = mkNode('self-rated only');
updateMasteryFromAttempt(selfRated, 10, 10, 'flashcard', { questionType: 'short_answer' });
check('a perfect run of flashcard self-ratings never opens the assessment clause',
    checkMasteryEligibility(selfRated, 0.85, BOSS_PASS).passed_assessment === false);

console.log('\n--- validation ---');
const v = mkNode('validation');
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
check('score above total is refused', throws(() => updateMasteryFromAttempt(v, 5, 4, 'quiz')));
check('non-integers are refused', throws(() => updateMasteryFromAttempt(v, 1.5, 4, 'quiz')));
check('NaN is refused', throws(() => updateMasteryFromAttempt(v, NaN, 4, 'quiz')));
check(`total above ${MAX_ATTEMPT_QUESTIONS} is refused`, throws(() => updateMasteryFromAttempt(v, 1, MAX_ATTEMPT_QUESTIONS + 1, 'quiz')));
check('zero questions is refused', throws(() => updateMasteryFromAttempt(v, 0, 0, 'quiz')));
check('nothing was written by the refused attempts',
    db.prepare('SELECT COUNT(*) c FROM mastery_evidence WHERE node_id = ?').get(v).c === 0);

// ---- fitting the learner's own rates -----------------------------------------
console.log('\n--- bktOptimizer ---');
{
    const { fit, evaluate, MIN_FIT_ATTEMPTS } = await import('../server/bktOptimizer.js');
    const { getLearnerBktParams, reloadLearnerBktParams } = await import('../server/mastery.js');
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    // A learner who learns faster and slips less than the defaults assume.
    const TRUE = { p_T: 0.28, p_S: 0.04 };
    const simulate = (topics, attemptsPer) => {
        const out = [];
        let t = Date.parse('2026-01-01T00:00:00Z');
        for (let n = 0; n < topics; n++) {
            let known = rnd() < 0.2;
            const attempts = [];
            for (let i = 0; i < attemptsPer; i++) {
                const total = i % 3 === 2 ? 10 : 1;
                const p_G = 0.25;
                let score = 0;
                for (let q = 0; q < total; q++) {
                    const correct = known ? rnd() > TRUE.p_S : rnd() < p_G;
                    if (correct) score++;
                    // A single question is its own attempt in the model, so it
                    // carries its own learning chance; an assessment carries ONE.
                    if (total === 1 && !known && rnd() < TRUE.p_T) known = true;
                }
                if (total > 1 && !known && rnd() < TRUE.p_T) known = true;
                attempts.push({ t: t += 3_600_000, score, total, p_G });
            }
            out.push({ nodeId: n + 1, attempts });
        }
        return out;
    };
    const tiny = simulate(5, 3);
    const r0 = fit(tiny);
    check(`refuses below ${MIN_FIT_ATTEMPTS} attempts`, r0.accepted === false && /at least/.test(r0.reason));
    const data = simulate(120, 6);
    const r = fit(data);
    console.log(`        fit: ${r.stats.evaluations} evaluations in ${r.stats.ms} ms; train ${r.stats.trainDefault.toFixed(4)} → ${r.stats.trainFitted.toFixed(4)}, val ${r.stats.valDefault.toFixed(4)} → ${r.stats.valFitted.toFixed(4)}; p_T ${r.params.p_T} p_S ${r.params.p_S}`);
    check('the fit is accepted on held-out attempts', r.accepted === true, r.reason || '');
    check('the fitted rates moved toward the truth (p_T up, p_S down from the 0.1/0.1 defaults)', r.params.p_T > 0.1 && r.params.p_S < 0.1, JSON.stringify(r.params));
    check('the true rates explain the data at least as well as the fitted ones, within grid resolution',
        evaluate(TRUE, data).loss <= evaluate(r.params, data).loss + 0.02);
    // The plumbing: an accepted pair reaches the live updates through the setting.
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('bkt_params', ?)`).run(JSON.stringify({ p_T: 0.4, p_S: 0.05 }));
    reloadLearnerBktParams();
    check('a stored pair is read back', JSON.stringify(getLearnerBktParams()) === JSON.stringify({ p_T: 0.4, p_S: 0.05 }));
    const fittedStep = bktUpdate(0.3, true, { p_G: 0.25 }).p_K_posterior;
    db.prepare(`DELETE FROM settings WHERE key = 'bkt_params'`).run();
    reloadLearnerBktParams();
    const defaultStep = bktUpdate(0.3, true, { p_G: 0.25 }).p_K_posterior;
    check('the live update uses the stored rates (a faster learner climbs more per correct answer)', fittedStep > defaultStep, `${fittedStep.toFixed(3)} vs ${defaultStep.toFixed(3)}`);
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('bkt_params', ?)`).run(JSON.stringify({ p_T: 0.9, p_S: 0.5 }));
    reloadLearnerBktParams();
    check('a pair outside the fit bounds is ignored, never applied', getLearnerBktParams() === null);
    db.prepare(`DELETE FROM settings WHERE key = 'bkt_params'`).run();
    reloadLearnerBktParams();
}

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }
process.exit(fail ? 1 : 0);
