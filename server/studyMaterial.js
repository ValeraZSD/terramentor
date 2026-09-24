/**
 * Authoring one topic's study material — quizzes and flashcards.
 *
 * Lifted out of index.js so the per-node endpoints and the BULK generator
 * (server/bulkGen.js) run the *same* code: a quiz made for twenty topics at
 * once must be indistinguishable from the one the mastery check makes for one, or
 * "generate for the whole phase" quietly becomes a second-class path with its
 * own bugs. Prompt building, parsing, the honesty filters and the DB write all
 * live here; the callers only decide when to run them and who watches.
 *
 * Nothing here talks to Express, and nothing here decides scheduling policy —
 * `decayDays` is passed in (the setting is read at the edge) so this module
 * stays a pure authoring library.
 */
import db from './database.js';
import { buildNodeContext, AI_PROMPTS, aiProvenance, generateResponse } from './ai.js';
import { parseJsonWithRepair, escapeLatexBackslashes, normalizeChoice } from './agentic.js';
import { normalizeQuestionFormat } from './answerFormats.js';
import { questionDefects, verifyQuestion } from './feedQuality.js';
import { getGhostQuestions } from './dailyPlan.js';

/**
 * What a saved bank is CALLED in the library.
 *
 * Never a word plus the day it was made: "Quiz" is not this app's word for a
 * node's saved questions (they are its mastery check bank, and the Tests tab
 * lists them), a bare `toLocaleDateString()` follows the OPERATING SYSTEM's
 * regional settings rather than the interface language and, unlike a rendered
 * date, a title is STORED, so one machine's format would be frozen into the
 * library for good. And a date names nothing: banks that differ only by the
 * day cannot be told apart on the screen.
 *
 * An imported course already titles each bank after the topic it belongs to, so
 * generated banks now read the same way and the two paths are indistinguishable
 * on the screen. The fallback keeps a title on a node that has since been
 * deleted, in English like every other server-written string.
 */
export function bankTitle(nodeId) {
    try {
        const title = db.prepare('SELECT title FROM nodes WHERE id = ?').get(nodeId)?.title;
        if (title && title.trim()) return title.trim().slice(0, 200);
    } catch { /* a missing node is not worth failing an authored bank over */ }
    return 'Mastery check';
}

/**
 * Build the prompt for a node's quiz, folding in the node's weak past
 * performance so the model can target known gaps.
 */
export function buildQuizPrompt(nodeId, questionCount, questionType) {
    const context = buildNodeContext(nodeId);
    let pastPerformance = [];
    try {
        const weakQuizzes = db.prepare(`
            SELECT n.title FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id JOIN nodes n ON n.id = q.node_id
            WHERE n.id = ? AND qa.score * 100.0 / qa.total < 70
        `).all(nodeId);
        pastPerformance = weakQuizzes.map(w => w.title);
    } catch { /* no history is the normal case for a new topic */ }
    return AI_PROMPTS.quiz_generator(context, questionCount, questionType, pastPerformance);
}

export function buildFlashcardPrompt(nodeId, count) {
    return AI_PROMPTS.flashcard_generator(buildNodeContext(nodeId), count);
}

/**
 * Parse the model's raw output into normalized questions, optionally interleave
 * ghost (review) questions, persist the quiz, and return { id, questions }.
 */
export function finalizeQuiz(nodeId, aiResponse, includeGhosts, { decayDays = 14, questionType = null } = {}) {
    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');

    let questions = parseJsonWithRepair(escapeLatexBackslashes(jsonMatch[0]));
    if (!Array.isArray(questions)) throw new Error('Quiz response was not a JSON array');

    // A saved quiz is reused by every mastery check on its topic, and the gate must
    // produce a verdict with no model in the room — so a format that needs the
    // checker (an open answer, code) is admitted only when the learner asked
    // for it by name. Locally graded formats are always welcome.
    const allow = (format, id) => format.grading === 'local' || id === questionType;

    // Normalize, and DROP any question we can't grade honestly. We used to
    // fabricate placeholder options and — worse — silently declare option A the
    // answer whenever correct_answer didn't string-match an option. That poisoned
    // the mastery gate with wrong keys. Now the format registry tolerant-matches
    // the intended answer to a real option and shuffles the options (local
    // models put the key first far too often; every grader matches by string
    // VALUE, so reordering cannot desync the key); if no key can be identified
    // it returns null and the question is discarded.
    questions = questions.reduce((acc, q) => {
        if (!q || typeof q !== 'object') return acc;
        const shaped = normalizeQuestionFormat(q, { allow });
        if (!shaped) return acc; // unknown or disallowed format, or no honest key
        Object.assign(q, shaped);

        // The same mechanical gate the feed applies, on the path that matters
        // MORE: this quiz can be a mastery check. It catches two options that are
        // the same value written two ways ($1.5$ vs $\frac{3}{2}$), an empty
        // explanation (a wrong answer that teaches nothing), and a true/false
        // phrased as a question. Cheap, deterministic, no model call — and a
        // dropped question is always better than an unanswerable one, because
        // the count is a request and the honesty is not.
        const defects = questionDefects(q, nodeId);
        if (defects.length) {
            console.warn(`[Quiz] Dropped a question for node ${nodeId}: ${defects.join('; ')}`);
            return acc;
        }
        acc.push(q);
        return acc;
    }, []);

    if (questions.length === 0) {
        throw new Error('The model did not return any gradeable questions. Try again or lower the question count.');
    }

    // "Remember" loop: interleave a couple of ghost questions drawn from
    // previously-mastered topics whose mastery is now decaying. This turns an
    // ordinary practice quiz into a mini cumulative exam. Opt-in (off for the
    // mastery check gate, which must stay a pure assessment of its own node).
    if (includeGhosts) {
        try {
            const nodeRow = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
            if (nodeRow) {
                const ghosts = getGhostQuestions(nodeRow.project_id, 2, decayDays);
                for (const ghost of ghosts) {
                    if (ghost.nodeId === Number(nodeId)) continue; // never ghost the node being quizzed
                    for (const gq of ghost.questions) {
                        questions.push({
                            ...gq,
                            isGhost: true,
                            ghostNodeId: ghost.nodeId,
                            ghostNodeTitle: ghost.title,
                        });
                    }
                }
            }
        } catch (ghostErr) {
            console.error('[Ghost] Failed to inject ghost questions:', ghostErr.message);
        }
    }

    const result = db.prepare('INSERT INTO quizzes (node_id, title, questions, generated_by) VALUES (?, ?, ?, ?)')
        .run(nodeId, bankTitle(nodeId), JSON.stringify(questions), aiProvenance());

    return { id: result.lastInsertRowid, questions };
}

/**
 * Second opinion on a saved quiz: solve every question cold and delete the ones
 * that do not survive it.
 *
 * Why this exists at all, given the feed has had it for months: the feed ran the
 * verifier on questions that CANNOT trip the gate's raw-assessment clause, while
 * this path — the mastery check, the one assessment that decides whether a topic
 * counts as proven — had only the mechanical checks. The stakes and the gates
 * were the wrong way round.
 *
 * The defect it is here for is not a wrong key, it is an UNDER-DETERMINED stem:
 * "you hear 5 beats against a 520 Hz reference, what is your frequency?" is
 * answered equally by 515 and 525, and a live mastery check shipped both as options
 * with 525 keyed. `OPTION_RULES` already forbids exactly this ("never ship a
 * question with two defensible answers") and the model wrote it anyway — which is
 * the whole argument for a gate over a prompt. Measured on that card: the
 * verifier called it broken 5 times out of 5, and passed a control with the stem
 * closed ("their instrument is sharp") 5 times out of 5.
 *
 * A vetoed question is DELETED rather than repaired, because repair means another
 * authoring call and this is already the slow path — `tools/quiz-audit.mjs` does
 * the repair offline, where time is free. Ghost questions are left alone: they
 * belong to another topic and were vetted (or not) when that topic authored them,
 * and re-verifying them would double the cost of every practice quiz.
 */
const VERIFY_CONCURRENCY = 2;

export async function vetQuiz(nodeId, quiz, { signal, onProgress } = {}) {
    const title = db.prepare('SELECT title FROM nodes WHERE id = ?').get(nodeId)?.title || 'this topic';
    const own = quiz.questions.filter(q => !q.isGhost);
    const ghosts = quiz.questions.filter(q => q.isGhost);

    const verdicts = new Array(own.length);
    let finished = 0;
    let cursor = 0;
    const worker = async () => {
        while (cursor < own.length) {
            const i = cursor++;
            verdicts[i] = await verifyQuestion(title, own[i], { signal });
            onProgress?.(++finished, own.length);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(VERIFY_CONCURRENCY, own.length) }, worker),
    );

    const kept = [];
    const dropped = [];
    own.forEach((q, i) => {
        if (verdicts[i]?.ok === false) {
            dropped.push({ question: q.question, reason: verdicts[i].reason });
            console.warn(`[Quiz] Vetoed a question for node ${nodeId}: ${verdicts[i].reason}`);
        } else {
            kept.push(q);
        }
    });

    if (!kept.length) {
        // Every question was unsound. Leaving the row behind would hand the mastery
        // check a saved quiz it can never use (the modal only regenerates when it
        // finds NO questions), so the row goes and the caller reports the failure.
        db.prepare('DELETE FROM quizzes WHERE id = ?').run(quiz.id);
        throw new Error('Every question the model wrote failed the answer check — none could be graded honestly. Try again.');
    }

    if (dropped.length) {
        const questions = [...kept, ...ghosts];
        db.prepare('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify(questions), quiz.id);
        return { ...quiz, questions, dropped };
    }
    return { ...quiz, dropped };
}

/**
 * Persist generated flashcards. Duplicate fronts on the same node are skipped
 * rather than inserted: bulk generation is meant to be re-runnable ("fill in
 * whatever is missing"), and a second pass that doubles every card would make
 * the review queue worse than not running it.
 */
export function finalizeFlashcards(nodeId, aiResponse) {
    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');

    const cards = parseJsonWithRepair(jsonMatch[0]);
    if (!Array.isArray(cards)) throw new Error('Flashcard response was not a JSON array');

    const existing = new Set(
        db.prepare('SELECT front FROM flashcards WHERE node_id = ?').all(nodeId)
            .map(r => normalizeChoice(r.front))
    );
    const insertStmt = db.prepare('INSERT INTO flashcards (node_id, front, back, generated_by) VALUES (?, ?, ?, ?)');
    const provenance = aiProvenance();
    const insertedIds = [];
    let skipped = 0;
    const transaction = db.transaction(() => {
        for (const card of cards) {
            const front = typeof card?.front === 'string' ? card.front.trim() : '';
            const back = typeof card?.back === 'string' ? card.back.trim() : '';
            if (!front || !back) { skipped++; continue; }
            const key = normalizeChoice(front);
            if (existing.has(key)) { skipped++; continue; }
            existing.add(key);
            insertedIds.push(insertStmt.run(nodeId, front, back, provenance).lastInsertRowid);
        }
    });
    transaction();

    if (insertedIds.length === 0 && cards.length > 0) {
        throw new Error('Every card the model returned was empty or already on this topic.');
    }
    return { count: insertedIds.length, ids: insertedIds, skipped };
}

/**
 * The two kinds of study material a topic needs at the END of its stream, and
 * the one call that writes either of them.
 *
 * Three callers now ask for exactly this: the bulk dialog ("generate for the
 * whole phase"), the feed's own look-ahead (feedGen, so the material is already
 * there when the learner arrives), and — for the mastery check — the gate
 * itself when it opens and finds nothing. They must stay indistinguishable: a
 * bank written an hour early by the background chain has to be the same bank,
 * vetted the same way, as one the learner waited 24 seconds for. Two copies of
 * these twelve lines is how "generated ahead of time" quietly becomes the
 * unchecked path.
 *
 * `includeGhosts` is not a parameter: material made before the learner reaches
 * the topic must never carry ghost questions, because a decaying-topic question
 * chosen now is not the "what is decaying right now" signal the Remember loop
 * reads. The one caller that wants ghosts (the per-node practice quiz) goes
 * through finalizeQuiz directly.
 *
 * @param {number} nodeId
 * @param {'mastery_check'|'flashcards'} kind
 * @returns {Promise<{kind: string, count: number}>} what was written
 */
export async function generateMaterial(nodeId, kind, { questionCount = 10, cardCount = 8, decayDays = 14, signal } = {}) {
    if (kind === 'mastery_check') {
        const { system, user } = buildQuizPrompt(nodeId, questionCount, 'both');
        const raw = await generateResponse(user, system, [], { signal, operation: 'authoring' });
        const vetted = await vetQuiz(nodeId, finalizeQuiz(nodeId, raw, false, { decayDays }), { signal });
        return { kind, count: vetted.questions.filter(q => !q.isGhost).length };
    }
    if (kind === 'flashcards') {
        const { system, user } = buildFlashcardPrompt(nodeId, cardCount);
        const raw = await generateResponse(user, system, [], { signal, operation: 'authoring' });
        return { kind, count: finalizeFlashcards(nodeId, raw).count };
    }
    throw new Error(`Unknown material kind: ${kind}`);
}
