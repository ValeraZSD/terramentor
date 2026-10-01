// Mastery: per-topic state, quiz and drill evidence, the mastery check, the daily plan.
import db from '../database.js';
import {
    ATTEMPT_ID_ERROR, getNodeMasteryDetail, getProjectMasteryStats, MIN_GATE_QUESTIONS,
    readAttemptId, recordOnce, updateMasteryFromAttempt,
} from '../mastery.js';
import { generateDailyPlan, getGhostQuestions } from '../dailyPlan.js';
import { logAsked } from '../questionLog.js';
import { provenSitting } from '../questionTrust.js';
import { getGateConfig } from '../settingsStore.js';
import { saveSittingReview } from '../sittingReview.js';
import { readAttempt } from './request.js';
import { routeTable } from './routeTable.js';

const app = routeTable('mastery');

// MASTERY ROUTES

app.get('/api/nodes/:nodeId/mastery', (req, res) => {
    try {
        const gate = getGateConfig();
        const detail = getNodeMasteryDetail(req.params.nodeId, { threshold: gate.threshold, checkPass: gate.checkPass });
        res.json(detail);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/projects/:projectId/mastery', (req, res) => {
    try {
        const stats = getProjectMasteryStats(req.params.projectId);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/nodes/:nodeId/mastery/quiz', (req, res) => {
    const attempt = readAttempt(req.body);
    if (!attempt) return res.status(400).json({ error: 'score and total are required' });
    const { score, total } = attempt;
    try {
        const result = updateMasteryFromAttempt(req.params.nodeId, score, total, 'quiz');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Practice-drill round (D-023). Recorded under its own `drill` evidence type:
// updateMasteryFromAttempt applies BKT for any type, so a round sharpens the
// retention estimate and refreshes the decay timer — but checkMasteryEligibility's
// raw-score clause honours only `quiz`/`mastery_check`, so a drill can never clear
// the completion gate on its own. Practice tunes the estimate; proving needs an
// assessment.
/**
 * Which drill on a topic a round was played on: `drillKeyOf` in
 * `src/components/drills/parseDrill.ts` (an 8-hex-digit hash of the fence) or
 * the one flashcard drill. Anything else is dropped rather than stored, so the
 * evidence row carries nothing a client made up.
 */
const DRILL_KEY = /^(?:f[0-9a-f]{8}|cards)$/;

app.post('/api/nodes/:nodeId/mastery/drill', (req, res) => {
    const attempt = readAttempt(req.body);
    if (!attempt) return res.status(400).json({ error: 'score and total (> 0) are required' });
    const { score, total } = attempt;
    const drillKey = typeof req.body?.drillKey === 'string' && DRILL_KEY.test(req.body.drillKey) ? req.body.drillKey : null;
    try {
        const result = updateMasteryFromAttempt(req.params.nodeId, score, total, 'drill', {
            source: 'drill', ...(drillKey ? { drillKey } : {}),
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * The last FULL round of each drill on a topic, keyed by drill. Read off the
 * evidence the rounds already wrote — a drill's score is not a second record
 * that could disagree with the one the topic's estimate was built from.
 */
app.get('/api/nodes/:nodeId/drill-scores', (req, res) => {
    const nodeId = Number(req.params.nodeId);
    if (!Number.isInteger(nodeId)) return res.status(400).json({ error: 'Invalid node id' });
    const rows = db.prepare(`
        SELECT json_extract(metadata, '$.drillKey') AS drill_key, score, total, created_at
        FROM mastery_evidence
        WHERE node_id = ? AND evidence_type = 'drill'
          AND json_valid(metadata) AND json_extract(metadata, '$.drillKey') IS NOT NULL
        ORDER BY id
    `).all(nodeId);
    const out = {};
    for (const r of rows) out[r.drill_key] = { correct: r.score, total: r.total, at: r.created_at };
    res.json(out);
});

// A flashcard's evidence has no endpoint: it is written on the rating path
// itself (server/cardEvidence.js), so every review surface produces it without
// having to remember to. A route taking one card's correct/total from a client
// would count only what the client chose to send, and a surface that forgot to
// call it would silently produce no evidence at all.

app.post('/api/projects/:projectId/mastery/mastery-check', (req, res) => {
    const { nodeId, questions, asked } = req.body || {};
    const attempt = readAttempt(req.body);
    if (!nodeId || !attempt) {
        return res.status(400).json({ error: 'nodeId, score, and total are required' });
    }
    const { score, total } = attempt;
    const attemptId = readAttemptId(req.body.attemptId);
    if (attemptId === undefined) return res.status(400).json({ error: ATTEMPT_ID_ERROR });
    try {
        // One check, one record: its writes are one transaction, and the same
        // attemptId sent again (a retry after a lost response) gets the first
        // result back rather than a second piece of evidence.
        const { duplicate, outcome } = recordOnce('mastery_check', attemptId, () => {
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
            });
            // What the learner saw and answered, so the result can be opened
            // later from the day's ledger. A record, not evidence: a bad one is
            // dropped, and its failure never costs the check.
            try { saveSittingReview(result.evidence_id, req.body.review); }
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
        res.json(duplicate ? { ...outcome, duplicate: true } : outcome);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DAILY PLAN / INTERVENTION ENGINE

app.get('/api/projects/:projectId/daily-plan', (req, res) => {
    try {
        const plan = generateDailyPlan(req.params.projectId, getGateConfig().decayDays);
        res.json(plan);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/projects/:projectId/ghost-questions', (req, res) => {
    const max = parseInt(req.query.max) || 2;
    try {
        const ghosts = getGhostQuestions(req.params.projectId, max, getGateConfig().decayDays);
        res.json(ghosts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export const routes = app.takeRoutes();
