// /api/ai/quiz and /api/ai/quizzes: quiz generation, draws, attempts and answer checks.
//
// Mounted in 2 blocks (see createApp in server/app.js), because the server
// registers other areas' routes between them and Express matches in registration
// order. A new route goes in the block it belongs with.
import db from '../database.js';
import {
    AI_PROMPTS, buildNodeContext, checkAnswerWithAI, generateResponse, probeAiReachable,
    streamResponse,
} from '../ai.js';
import {
    ATTEMPT_ID_ERROR, MIN_GATE_QUESTIONS, readAttemptId, recordOnce, updateMasteryFromAttempt,
} from '../mastery.js';
import { masteryCheckTarget } from '../today.js';
import {
    drawFromNode, drawFromQuiz, logAsked, MAX_CHECK_SIZE, PRACTICE_SESSION_SIZE,
} from '../questionLog.js';
import { provenSitting } from '../questionTrust.js';
import { buildQuizPrompt, finalizeQuiz, vetQuiz } from '../studyMaterial.js';
import * as tasks from '../tasks.js';
import { getGateConfig } from '../settingsStore.js';
import { saveSittingReview } from '../sittingReview.js';
import { readAttempt } from './request.js';
import { attachTaskStream, nodeTaskInfo, requestOrigin } from './taskStream.js';
import { requireProject } from './projectRows.js';
import { routeTable } from './routeTable.js';

const app = routeTable('quizzes');

// AI QUIZ

app.post('/api/ai/quiz', async (req, res) => {
    const { nodeId, questionCount = 5, questionType = 'both', includeGhosts = false } = req.body;
    let aiResponse = null;
    try {
        const { system, user } = buildQuizPrompt(nodeId, questionCount, questionType);
        aiResponse = await generateResponse(user, system);
        const quiz = finalizeQuiz(nodeId, aiResponse, includeGhosts, { decayDays: getGateConfig().decayDays, questionType });
        res.json(await vetQuiz(nodeId, quiz));
    } catch (error) {
        console.error('Quiz generation error:', error);
        res.status(500).json({
            error: error.message,
            rawResponse: aiResponse
        });
    }
});

// Quiz generation as a background task. Ported from the old inline handler:
// probe first (fail fast when the model server is down), then a "warming up"
// heartbeat until the first token (a cold model swap holds the request open
// for up to a minute with zero bytes — without the phase events the client
// sees a dead-looking 0-char spinner and can't tell loading from failure).
async function runQuizGeneration({ nodeId, questionCount, questionType, includeGhosts, emit, signal }) {
    let aiResponse = '';
    let thinkingChars = 0;
    // Keep a bounded copy of the reasoning channel so that when a thinking model
    // spends its whole budget "thinking" and emits no answer, we can still show
    // the learner *something* as raw output instead of an empty box.
    let thinkingText = '';
    const THINKING_RAW_CAP = 8000;
    let firstTokenSeen = false;
    let loadingTimer = null;
    const startedAt = Date.now();
    const stopLoadingHeartbeat = () => {
        if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    };
    try {
        const reachable = await probeAiReachable();
        if (!reachable.ok) throw new Error(reachable.error);

        loadingTimer = setInterval(() => {
            if (!firstTokenSeen && !signal.aborted) {
                emit({ phase: 'loading_model', waitedMs: Date.now() - startedAt });
            }
        }, 2000);

        const { system, user } = buildQuizPrompt(nodeId, questionCount, questionType);
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.35, think: true })) {
            if (part && (part.type === 'content' || part.type === 'thinking') && part.content) {
                // First token of either channel means the model is loaded and
                // actively generating — drop out of the "loading model" phase.
                if (!firstTokenSeen) { firstTokenSeen = true; stopLoadingHeartbeat(); emit({ phase: 'generating' }); }
            }
            if (part && part.type === 'content' && part.content) {
                aiResponse += part.content;
                emit({ progress: aiResponse.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                if (thinkingText.length < THINKING_RAW_CAP) thinkingText += part.content;
                emit({ thinking: thinkingChars });
            }
        }
        stopLoadingHeartbeat();
        // A reasoning model can finish having emitted only a thinking stream and no
        // answer. finalizeQuiz would then throw the opaque "No JSON array found";
        // give an actionable message and surface the reasoning as raw output.
        if (!aiResponse.trim()) {
            throw Object.assign(
                new Error('The AI model returned no answer text — it may have spent its whole budget "thinking". Try again, lower the question count, or switch to a model that emits a final answer.'),
                { rawResponse: thinkingText || null }
            );
        }
        // The quiz row is saved here, server-side — so a generation whose
        // subscriber went away (modal closed, page reloaded) still lands, and
        // reopening the mastery check finds the saved questions.
        const quiz = finalizeQuiz(nodeId, aiResponse, includeGhosts, { decayDays: getGateConfig().decayDays, questionType });
        // Each question now gets solved cold by a second pass. It is the most
        // expensive thing this endpoint does after the generation itself, so it
        // reports progress on the same phase channel the "warming up" heartbeat
        // uses — a silent minute here would read as a hang.
        emit({ phase: 'verifying', verified: 0, verifyTotal: quiz.questions.filter(q => !q.isGhost).length });
        return await vetQuiz(nodeId, quiz, {
            signal,
            onProgress: (verified, verifyTotal) => emit({ phase: 'verifying', verified, verifyTotal }),
        });
    } catch (error) {
        stopLoadingHeartbeat();
        if (signal.aborted) return { cancelled: true };
        console.error('Quiz generation error:', error);
        if (error.rawResponse === undefined) {
            error.rawResponse = aiResponse || thinkingText || null;
        }
        throw error;
    }
}

app.post('/api/ai/quiz/stream', (req, res) => {
    const { nodeId, questionCount = 5, questionType = 'both', includeGhosts = false, masteryCheck = false } = req.body;
    if (!nodeId) return res.status(400).json({ error: 'Missing required field: nodeId' });
    const info = nodeTaskInfo(Number(nodeId));
    if (!info) return res.status(404).json({ error: 'Node not found' });

    // Deduped on the node: reopening the mastery check (or quiz panel) while a
    // generation is already running REATTACHES to it — replaying progress so
    // far — instead of starting a duplicate generation.
    const quizOrigin = requestOrigin(req, {
        surface: 'topic', detail: masteryCheck ? 'mastery_check' : 'quiz',
        nodeId: Number(nodeId), projectId: info.projectId,
    });
    const { task } = tasks.createTask({
        kind: masteryCheck ? 'mastery_check' : 'quiz',
        label: info.title,
        origin: quizOrigin,
        nodeId: Number(nodeId),
        projectId: info.projectId,
        projectName: info.projectName,
        projectColor: info.projectColor,
        dedupeKey: `quiz:${nodeId}`,
        run: ({ emit, signal }) => runQuizGeneration({
            nodeId: Number(nodeId), questionCount, questionType, includeGhosts, emit, signal,
        }),
    });
    attachTaskStream(req, res, task.id);
});

app.get('/api/ai/quizzes/:nodeId', (req, res) => {
    const quizzes = db.prepare(`
        SELECT q.*,
            (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) as attempt_count,
            (SELECT MAX(qa.score * 100 / qa.total) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) as best_score
        FROM quizzes q
        WHERE q.node_id = ?
        ORDER BY q.created_at DESC
    `).all(req.params.nodeId);
    res.json(quizzes.map(q => {
        try { return { ...q, questions: JSON.parse(q.questions) }; }
        catch { return { ...q, questions: [] }; }
    }));
});

/**
 * The questions a mastery check ASKS: `mastery_check_size` of them, never-asked
 * first, then least recently asked, drawn from every quiz row the node owns.
 * Empty when the node has no bank — the client generates one then and draws
 * again. Each question names where it lives (`quizId`, `index`) so the
 * submission can say which were asked; nothing about the node's other
 * questions leaves the server.
 */
app.get('/api/nodes/:nodeId/mastery-check/draw', (req, res) => {
    const nodeId = Number(req.params.nodeId);
    if (!Number.isInteger(nodeId)) return res.status(400).json({ error: 'Invalid node id' });
    const target = masteryCheckTarget(nodeId);
    if (target.refused) return res.status(target.httpStatus).json({ error: target.refused, code: target.code });
    const size = getGateConfig().checkSize;
    const { bankSize, unverified, questions } = drawFromNode(nodeId, size);
    // `status` tells the check whether this is a retake: a completed topic
    // stays completed whatever the score, and is never offered Skip.
    // `unverified` counts the questions held back for want of a verdict, so an
    // empty draw from a bank that exists is not taken for "no bank" and does
    // not have another one written. `minQuestions` is the smallest check the
    // submission will judge (MIN_GATE_QUESTIONS): a draw shorter than that is
    // not started, because it could only come back unproven.
    res.json({ size, bankSize, unverified, minQuestions: MIN_GATE_QUESTIONS, status: target.status, questions: questions.map(q => ({ ...q.question, quizId: q.quizId, index: q.index })) });
});

/**
 * One practice SITTING from a saved quiz. A bank of 112 imported questions is a
 * resource to work through, not a single sitting; the sitting is
 * `PRACTICE_SESSION_SIZE` at most, by the same draw rule as the check.
 */
app.get('/api/ai/quizzes/:quizId/draw', (req, res) => {
    const quizId = Number(req.params.quizId);
    if (!Number.isInteger(quizId)) return res.status(400).json({ error: 'Invalid quiz id' });
    const asked = Number.parseInt(String(req.query.size ?? ''), 10);
    const size = Number.isFinite(asked) ? Math.max(1, Math.min(MAX_CHECK_SIZE, asked)) : PRACTICE_SESSION_SIZE;
    // A PRACTICE sitting: a question no verifier confirmed is asked like the
    // whole-row sitting asks it — marked on screen, left out of the evidence
    // (provenSitting) — never held back, or a row that is all stamped would
    // have an empty sitting.
    const { nodeId, bankSize, unverified, questions } = drawFromQuiz(quizId, size, { practice: true });
    if (nodeId == null) return res.status(404).json({ error: 'Quiz not found' });
    res.json({ size, bankSize, unverified, questions: questions.map(q => ({ ...q.question, index: q.index })) });
});

// One sitting's writes. Run through `recordOnce` by the route below: one
// transaction, and a sitting's attemptId sent again (a retry after a lost
// response) gets the first answer back instead of a second attempt row, a
// second piece of evidence and the same questions logged twice.
function writeQuizAttempt(req, score, total) {
    const { answers, ghostResults, asked } = req.body || {};
    // score/total cover only this quiz's *own* (non-ghost) questions, so the node's
    // recorded mastery stays an honest assessment of its own material.
    const result = db.prepare('INSERT INTO quiz_attempts (quiz_id, score, total, answers) VALUES (?, ?, ?, ?)')
        .run(req.params.quizId, score, total, JSON.stringify(answers));

    // Remember which questions this sitting asked, so the next one draws the
    // rest. A sampled sitting says so (`asked`, with the bank's own indices);
    // a whole-row sitting is every index that was answered.
    try {
        const quizId = Number(req.params.quizId);
        // Found by uuid when the sitting names one (a veto moves positions).
        const entries = Array.isArray(asked)
            ? asked.map(a => ({ quizId, index: a?.index, uuid: a?.uuid, stem: a?.stem, correct: a?.correct }))
            : Object.keys(answers || {}).map(k => ({ quizId, index: Number(k) }));
        logAsked(entries, 'quiz');
    } catch (e) {
        console.error('[quiz] failed to log asked questions:', e.message);
    }

    // PHASE 3: Update mastery score for this quiz's node
    // …counting only the questions a verifier confirmed (server/questionTrust.js):
    // the attempt row above keeps the score the learner saw, the evidence
    // leaves out any question stamped unverified, looked up in the stored bank.
    // Below MIN_GATE_QUESTIONS what is left is per-question evidence (BKT's
    // single-answer path) and cannot clear the gate's assessment clause
    // (checkMasteryEligibility), so a small proven total needs no floor here.
    const proven = provenSitting({ quizId: Number(req.params.quizId), asked, score, total, ghostResults });
    let masteryResult = null;
    try {
        const quiz = db.prepare('SELECT node_id FROM quizzes WHERE id = ?').get(req.params.quizId);
        if (quiz && proven.total > 0) {
            masteryResult = updateMasteryFromAttempt(quiz.node_id, proven.score, proven.total, 'quiz', {
                quiz_id: Number(req.params.quizId),
                answers,
            });
            // What the learner saw and answered, so the sitting can be opened
            // later from the day's ledger (server/sittingReview.js).
            try { saveSittingReview(masteryResult.evidence_id, req.body?.review); }
            catch (e) { console.error('[quiz] failed to keep the review:', e.message); }
        }
    } catch (e) {
        console.error('[Mastery] Failed to update from quiz attempt:', e.message);
    }

    // "Remember" loop: credit each decaying topic that was reviewed via ghost
    // questions, refreshing its mastery and (crucially) its decay timer — as
    // provenSitting left them, without a review question no verifier confirmed.
    if (Array.isArray(proven.ghostResults)) {
        for (const g of proven.ghostResults) {
            try {
                if (g && g.nodeId && g.total > 0) {
                    updateMasteryFromAttempt(g.nodeId, g.score, g.total, 'quiz', {
                        quiz_id: Number(req.params.quizId),
                        ghost: true,
                    });
                }
            } catch (e) {
                console.error('[Ghost] Failed to update decaying-node mastery:', e.message);
            }
        }
    }

    // The pass mark rides back with the result, the way the mastery check's own
    // submission already returns `pass_threshold`. Without it the results screen
    // had no way to know what "good" is and used a hardcoded 80%, so a learner
    // who raised `mastery_check_pass` to 90% scored 5 of 6, was congratulated in
    // green, and was then refused completion by the gate on the same numbers.
    return {
        id: result.lastInsertRowid, score, total, mastery: masteryResult,
        passThreshold: getGateConfig().checkPass,
    };
}

app.post('/api/ai/quizzes/:quizId/attempt', (req, res) => {
    const attempt = readAttempt(req.body);
    if (!attempt) {
        return res.status(400).json({ error: 'score and total must be integers with 0 <= score <= total' });
    }
    const attemptId = readAttemptId(req.body.attemptId);
    if (attemptId === undefined) return res.status(400).json({ error: ATTEMPT_ID_ERROR });
    try {
        const { duplicate, outcome } = recordOnce('quiz', attemptId, () => writeQuizAttempt(req, attempt.score, attempt.total));
        res.json(duplicate ? { ...outcome, duplicate: true } : outcome);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/ai/quizzes/:quizId', (req, res) => {
    db.prepare('DELETE FROM quizzes WHERE id = ?').run(req.params.quizId);
    res.json({ success: true });
});

// AI ANSWER CHECK

// Teach one missed question, in place. Blocking JSON (like check-answer, and
// unlike the streaming tutor) because it is a short, single-shot explanation
// the learner requested from a results screen — and because it must NOT land in
// the node's tutor chat history, which streamChat would do.
app.post('/api/ai/explain-question', async (req, res) => {
    const { nodeId, question, correctAnswer, userAnswer } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });
    try {
        const node = nodeId ? db.prepare('SELECT title FROM nodes WHERE id = ?').get(nodeId) : null;
        const context = nodeId ? buildNodeContext(nodeId) : '';
        const { system, user } = AI_PROMPTS.explain_question(
            node?.title || 'this topic',
            context,
            question,
            correctAnswer || '',
            userAnswer || ''
        );
        const explanation = await generateResponse(user, system, [], { operation: 'explain' });
        if (!explanation || !explanation.trim()) {
            return res.status(502).json({ error: 'The model returned an empty explanation. Try again.' });
        }
        res.json({ explanation: explanation.trim() });
    } catch (error) {
        console.error('Explain question error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/ai/check-answer', async (req, res) => {
    const { question, correctAnswer, userAnswer, format, language } = req.body;
    if (!question || !correctAnswer || !userAnswer) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        // `format` says what the checker is reading: code is judged on
        // behaviour, prose on meaning. Anything else is graded as prose.
        const result = await checkAnswerWithAI(question, correctAnswer, userAnswer, {
            format: format === 'code' ? 'code' : 'short_answer',
            language: typeof language === 'string' ? language.slice(0, 24) : '',
        });
        res.json(result);
    } catch (error) {
        console.error('Answer check error:', error);
        res.status(500).json({ error: error.message });
    }
});

export const quizRoutes = app.takeRoutes();

// PROJECT-LEVEL QUIZ ENDPOINT

app.get('/api/projects/:projectId/quizzes', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;

    try {
        const quizzes = db.prepare(`
            SELECT q.*,
                n.title as node_title,
                (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) as attempt_count,
                (SELECT MAX(qa.score * 100 / qa.total) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) as best_score,
                (SELECT ROUND(AVG(qa.score * 100.0 / qa.total)) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) as avg_score
            FROM quizzes q
            JOIN nodes n ON n.id = q.node_id
            WHERE n.project_id = ?
            ORDER BY q.created_at DESC
        `).all(projectId);

        res.json(quizzes.map(q => {
            try { return { ...q, questions: JSON.parse(q.questions) }; }
            catch { return { ...q, questions: [] }; }
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export const projectQuizRoutes = app.takeRoutes();
