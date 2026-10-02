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
import { questionDefects, verifyQuestion, checkItemKeys } from './feedQuality.js';
import { getGhostQuestions } from './dailyPlan.js';
import {
    isUnverified, isPending, markUnverified, markPending, markConfirmed, REVERIFY_BASE_WAIT_MS,
} from './questionTrust.js';

const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

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
                        // A copy is never re-verified (it is checked in its own
                        // bank), so an unconfirmed one would stay unconfirmed here
                        // for good. Its refreshed decay timer is evidence; skip it.
                        if (isUnverified(gq)) continue;
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

    // Stored PENDING (server/questionTrust.js): no verifier has seen these yet,
    // so until `vetQuiz` confirms each one it is practice, never proof — the
    // draws do not hand it out and an answer to it writes no evidence. Stored
    // plain, a check drawn while the vetting runs (minutes on a local model)
    // would count every question, and a vetting cancelled from the task dock
    // would leave the whole row counting for good with nothing ever asking
    // about it again. The wait keeps the
    // background chain off questions `vetQuiz` is asking about right now; after
    // an abort it is how soon the chain takes them over. A ghost is a copy of a
    // question checked in its own bank (a stamped one was skipped above).
    const stored = questions.map(q => (q.isGhost ? q : markPending(q, { delayMs: REVERIFY_BASE_WAIT_MS })));
    const result = db.prepare('INSERT INTO quizzes (node_id, title, questions, generated_by) VALUES (?, ?, ?, ?)')
        .run(nodeId, bankTitle(nodeId), JSON.stringify(stored), aiProvenance());

    // Read back: the database gave each question its uuid on the way in
    // (database.js), and that is how `vetQuiz` finds it again after anything
    // else has touched the row.
    const saved = safeParse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(result.lastInsertRowid)?.questions);
    return { id: result.lastInsertRowid, questions: Array.isArray(saved) ? saved : stored };
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
    // The STORED row is what is vetted: it carries the uuids the database gave
    // the questions, and the verdicts are written back to it by those.
    const storedQs = safeParse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(quiz.id)?.questions);
    const source = Array.isArray(storedQs) ? storedQs : quiz.questions;
    const own = source.filter(q => q && typeof q === 'object' && !q.isGhost);

    const verdicts = new Array(own.length);
    let finished = 0;
    let cursor = 0;
    const worker = async () => {
        while (cursor < own.length) {
            const i = cursor++;
            // Asked about the question, never about its stamp.
            const { unverified: _stamp, ...question } = own[i];
            let verdict = await verifyQuestion(title, question, { signal });
            // No verdict is not a pass: ask once more before keeping the
            // question on the strength of nothing.
            if (verdict?.available === false) verdict = await verifyQuestion(title, question, { signal });
            verdicts[i] = verdict;
            onProgress?.(++finished, own.length);
        }
    };
    let aborted = null;
    try {
        await Promise.all(
            Array.from({ length: Math.min(VERIFY_CONCURRENCY, own.length) }, worker),
        );
    } catch (err) {
        // A cancel (the task dock, a closed stream) rethrows from the
        // verifier. What was decided before it is still written below; what
        // was not stays stamped pending, and the background chain asks later.
        aborted = err;
    }

    const outcome = writeVetVerdicts(nodeId, quiz.id, own, verdicts);
    if (aborted) throw aborted;

    if (outcome.unverified) console.warn(`[Quiz] ${outcome.unverified} question(s) for node ${nodeId} kept as practice, without a verdict: ${verdicts.find(v => v?.available === false)?.reason}`);
    if (!outcome.questions.some(q => q && !q.isGhost)) {
        // Every question was unsound. Leaving the row behind would hand the mastery
        // check a saved quiz it can never use, so the row went and the caller
        // reports the failure.
        throw new Error('Every question the model wrote failed the answer check — none could be graded honestly. Try again.');
    }
    return { ...quiz, questions: outcome.questions, dropped: outcome.dropped, unverified: outcome.unverified };
}

/**
 * Write `vetQuiz`'s verdicts onto the row AS IT IS NOW, each question found by
 * its uuid (the background chain may have confirmed, re-stamped or deleted one
 * while this pass ran, and a position is not an identity):
 *   - disputed → deleted, like any vetoed question;
 *   - no verdict, twice → stamped as a failed verification (`tries: 1`), so
 *     the chain asks again after its wait — unless the chain already holds it
 *     (a stamp that is no longer pending) or already confirmed it;
 *   - confirmed → the stamp comes off, and it counts from now on;
 *   - not reached (the pass was cancelled) → left exactly as stored.
 * A row left with no questions of its own is deleted, unless somebody has
 * already sat it (the whole-row practice path shows a pending bank), whose
 * attempts would go with it.
 */
function writeVetVerdicts(nodeId, quizId, own, verdicts) {
    return db.transaction(() => {
        const row = db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(quizId);
        const qs = safeParse(row?.questions);
        if (!Array.isArray(qs)) return { questions: [], dropped: [], unverified: 0 };
        const dropped = [];
        let changed = false;
        own.forEach((orig, i) => {
            const v = verdicts[i];
            if (!v) return;
            const at = orig.uuid
                ? qs.findIndex(q => q && q.uuid === orig.uuid)
                : qs.findIndex(q => q && !q.isGhost && q.question === orig.question);
            if (at < 0) return;
            const cur = qs[at];
            if (v.ok === false) {
                dropped.push({ question: cur.question, reason: v.reason });
                console.warn(`[Quiz] Vetoed a question for node ${nodeId}: ${v.reason}`);
                qs.splice(at, 1);
                changed = true;
            } else if (v.available === false) {
                if (isPending(cur) || (!isUnverified(cur) && !cur.verifiedAt)) {
                    qs[at] = markUnverified(cur, v.reason);
                    changed = true;
                }
            } else if (isUnverified(cur)) {
                qs[at] = markConfirmed(cur);
                changed = true;
            }
        });
        const emptied = !qs.some(q => q && !q.isGhost);
        const sat = emptied && !!db.prepare('SELECT 1 FROM quiz_attempts WHERE quiz_id = ? LIMIT 1').get(quizId);
        if (emptied && !sat) {
            db.prepare('DELETE FROM quizzes WHERE id = ?').run(quizId);
        } else if (changed) {
            db.prepare('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify(qs), quizId);
        }
        // Read back after the write, so the caller hands out the uuids the
        // database holds (a rewrite stamps any question that lacked one).
        const after = emptied && !sat ? qs
            : safeParse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(quizId)?.questions) || qs;
        return { questions: after, dropped, unverified: after.filter(q => q && !q.isGhost && isUnverified(q)).length };
    })();
}

/**
 * Persist generated flashcards. Duplicate fronts on the same node are skipped
 * rather than inserted: bulk generation is meant to be re-runnable ("fill in
 * whatever is missing"), and a second pass that doubles every card would make
 * the review queue worse than not running it.
 *
 * Every card is CHECKED first (`checkItemKeys`, the drill's cold check): the
 * verifier gets the fronts and the pool of backs, never the pairing, and a
 * card whose back it does not reproduce is not saved. A card is reviewed for
 * months on a schedule built to make it stick, so a wrong back is the most
 * durable mistake the app can teach; until 2026-10-01 nothing read one. A
 * checker that cannot be asked keeps the cards — a card is practice, never
 * proof (cardEvidence.js keeps it out of the gate) — and says so in the log.
 */
export async function finalizeFlashcards(nodeId, aiResponse, { signal } = {}) {
    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');

    const parsed = parseJsonWithRepair(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('Flashcard response was not a JSON array');

    const drafts = parsed
        .map(card => ({
            front: typeof card?.front === 'string' ? card.front.trim() : '',
            back: typeof card?.back === 'string' ? card.back.trim() : '',
        }));
    const usable = drafts.filter(c => c.front && c.back);
    let rejected = 0;
    let cards = drafts;
    if (usable.length >= 2) {
        const title = bankTitle(nodeId);
        const { gone, unchecked } = await checkItemKeys(title, {
            title: `${title} — flashcards`,
            items: usable.map(c => ({ prompt: c.front, answer: c.back, distractors: [] })),
        }, { signal });
        for (const [i, reason] of gone) {
            console.warn(`[Flashcards] Dropped a card on node ${nodeId}: "${usable[i].front.slice(0, 80)}" (${reason})`);
        }
        if (unchecked) console.warn(`[Flashcards] Cards on node ${nodeId} saved without a full check: ${unchecked}`);
        rejected = gone.size;
        const keep = new Set(usable.filter((_, i) => !gone.has(i)));
        cards = drafts.filter(c => keep.has(c));
    }

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

    if (insertedIds.length === 0 && drafts.length > 0) {
        throw new Error(rejected
            ? `A second check disputed ${rejected} of the cards and the rest were empty or already on this topic, so none were saved.`
            : 'Every card the model returned was empty or already on this topic.');
    }
    return { count: insertedIds.length, ids: insertedIds, skipped, rejected };
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
        return { kind, count: (await finalizeFlashcards(nodeId, raw, { signal })).count };
    }
    throw new Error(`Unknown material kind: ${kind}`);
}
