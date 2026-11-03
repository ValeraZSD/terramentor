// server/masteryCheck.js — writing one mastery check, for every surface that
// gives one: the app's gate dialog (POST /api/projects/:id/mastery/mastery-check)
// and the check an agent host draws in its own window (server/agentSittings.js).
// One body, so a check taken in Claude's window is the same evidence, the same
// pass bar and the same "written once" as one taken in the app.
import db from './database.js';
import { MIN_GATE_QUESTIONS, recordOnce, updateMasteryFromAttempt } from './mastery.js';
import { logAsked } from './questionLog.js';
import { provenSitting } from './questionTrust.js';
import { getGateConfig } from './settingsStore.js';
import { saveSittingReview } from './sittingReview.js';

/**
 * Record a mastery check once. `asked` names what the sitting asked
 * (`[{ quizId, index, uuid?, stem?, correct }]`), `questions` the questions as
 * shown, `review` what the learner saw and answered, and `via` where it was
 * taken when that is not the app (kept on the evidence row, never read by the
 * estimate). Returns `{ duplicate, outcome }`: the same attemptId again gets
 * the first outcome back and writes nothing.
 */
export function recordMasteryCheck({ nodeId, score, total, questions, asked, attemptId, review, via = null }) {
    // One check, one record: its writes are one transaction, and the same
    // attemptId sent again (a retry after a lost response) gets the first
    // result back rather than a second piece of evidence.
    return recordOnce('mastery_check', attemptId, () => {
        // The check drew a sample; remember it, so a retry and the next check
        // ask the rest of the bank rather than the same ten again.
        try { logAsked(Array.isArray(asked) ? asked : [], 'mastery_check'); }
        catch (e) { console.error('[mastery-check] failed to log asked questions:', e.message); }
        // Only the questions a verifier confirmed are proof, looked up in
        // the stored bank by what the check says it asked
        // (server/questionTrust.js). The draw never hands a stamped one
        // out; this is the backstop for a list that did not come from it.
        // Nothing checked left: no evidence, no pass, no attempt row, and
        // the check says it did not happen rather than that it was failed.
        // A check is also no check below MIN_GATE_QUESTIONS proven answers:
        // the draw holds stamped questions back, so a bank mostly
        // unconfirmed draws one or two, and judged on those, 2/2 would pass
        // and complete the topic (the completion is written with override,
        // past checkMasteryEligibility, which wants the same four).
        // Nothing is written then — the answers are still logged above, so
        // the next check asks the rest — and the check says it could not
        // be run, not that it was failed.
        const proven = provenSitting({ nodeId: Number(nodeId), asked: Array.isArray(asked) ? asked : null, score, total });
        const { checkPass } = getGateConfig();
        if (proven.total < MIN_GATE_QUESTIONS) {
            return {
                passed: false, unproven: true, proven_total: proven.total, min_questions: MIN_GATE_QUESTIONS,
                raw_score_pct: null, pass_threshold: checkPass,
            };
        }
        const result = updateMasteryFromAttempt(nodeId, proven.score, proven.total, 'mastery_check', {
            questions,
            type: 'mastery_check',
            ...(via ? { via } : {}),
            // Which questions, so a reported one can be taken out of this
            // check again (server/itemReports.js).
            ...(proven.items?.length ? { items: proven.items } : {}),
        });
        // What the learner saw and answered, so the result can be opened
        // later from the day's ledger. A record, not evidence: a bad one is
        // dropped, and its failure never costs the check.
        try { saveSittingReview(result.evidence_id, review); }
        catch (e) { console.error('[mastery-check] failed to keep the review:', e.message); }

        // Also record the mastery check as a quiz attempt so the node's quiz no
        // longer shows "Not taken" after the learner proves mastery. Attach it
        // to the node's most recent quiz (the mastery check draws its questions
        // from there, or generated+saved one when none existed).
        try {
            const quiz = db.prepare('SELECT id FROM quizzes WHERE node_id = ? ORDER BY id DESC LIMIT 1').get(nodeId);
            if (quiz) {
                db.prepare('INSERT INTO quiz_attempts (quiz_id, score, total, answers) VALUES (?, ?, ?, ?)')
                    .run(quiz.id, score, total, JSON.stringify({ source: 'mastery_check' }));
            }
        } catch (e) {
            console.error('[mastery-check] failed to record quiz attempt:', e.message);
        }
        // Pass/fail is based on raw score percentage, not the BKT mastery score.
        // BKT can produce counterintuitive results (e.g. 8/10 correct → ~0.67 mastery)
        // because slip/guess probabilities and update ordering distort the mapping
        // between raw accuracy and the Bayesian posterior. We use the configured raw
        // pass threshold here, and `checkMasteryEligibility` honors the same raw
        // evidence, so a passing mastery check reliably unlocks completion.
        // Judged on the proven score, the same numbers the evidence holds.
        const passed = proven.score / proven.total >= checkPass;
        // pass_threshold lets the UI show the *configured* bar instead of a
        // hardcoded percentage.
        return { ...result, passed, raw_score_pct: Math.round((proven.score / proven.total) * 100), pass_threshold: checkPass };
    });
}
