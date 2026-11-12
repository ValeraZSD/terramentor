// server/agentSittings.js — a mastery check and a card review that an agent
// host (Claude, ChatGPT, VS Code) draws in its own window: the MCP App views
// in mcp/views/, served by /api/agent/check/* and /api/agent/review/*. A host
// that draws no views but asks its user for input (a terminal agent) gets the
// check as one form instead (mcp/checkForm.js), on the same sitting.
//
// The host's MODEL never answers. It asks for a check or a review and is
// told one is open; the questions, the cards and every answer travel between
// the learner's view (or form) and this server only. Once a check is graded,
// the model is told the score and each question the learner missed, with the
// answer given and the right one (server/checkFeedback.js), as the app's own
// result screen shows them; nothing of a check still open. So:
//
//   - The check is DRAWN here (`drawFromNode`, the app's own draw), and what
//     leaves is the question without its key: no `correct_answer`, `accept`,
//     `distractors` or explanation until the whole check is submitted.
//   - Grading is the app's: `gradeLocally`, else `checkAnswerWithAI`, both
//     here. The write is `recordMasteryCheck` (server/masteryCheck.js), the
//     same body the app's gate dialog writes through, under one attempt id
//     per sitting: a second submit gets the first outcome back.
//   - A card is rated by the app's own scheduler (src/utils/srs.ts, the
//     learner's fitted weights) and written by `writeCard`
//     (server/cardWrite.js), once per presentation (`recordOnce`). It
//     writes the same card evidence a review in the app writes, no more.
//
// A sitting lives in this process, named by a random token the MCP server
// hands the view in a tool result's `_meta`, or the host in a form round's
// `requestState` (never in text the model reads). It holds nothing that is
// not in the library already; a restart ends it, and the view says to start
// again.

import { randomBytes } from 'node:crypto';
import db from './database.js';
import { masteryCheckTarget } from './today.js';
import { drawFromNode } from './questionLog.js';
import { getGateConfig, getSetting } from './settingsStore.js';
import { gradeLocally, hasUsableKey } from './answerFormats.js';
import { missedOf, missedText, shownAnswer, shownKey } from './checkFeedback.js';
import { checkAnswerWithAI } from './ai.js';
import { MIN_GATE_QUESTIONS, recordOnce } from './mastery.js';
import { recordMasteryCheck } from './masteryCheck.js';
import { globalStudyQueue, studyQueue } from './decks.js';
import { ambiguousProjectText, findProject } from './projectState.js';
import { writeCard } from './cardWrite.js';
import { noTopicText, topicFor } from './agentReads.js';
import {
    computeNextInterval, computeSrsUpdate, configureSrs, formatInterval, requeueAt, srsSnapshot,
} from '../src/utils/srs.ts';
import { stripCardMarkup } from '../src/utils/cardText.ts';

/** A sitting nobody touched for this long is gone. */
export const SITTING_IDLE_MS = 2 * 60 * 60 * 1000;
/** At most this many open at once; the longest idle goes first. */
const MAX_SITTINGS = 64;
/** A review session holds at most this many cards (the app's own session has no cap; a host window is not a day's work). */
const MAX_SESSION_CARDS = 200;
/** useReviewQueue's learn-ahead: a card coming back within this is served now rather than waited for. */
const LEARN_AHEAD_MS = 20 * 60_000;
const ANSWER_CHARS = 20_000;
const TEXT_CHARS = 8_000;
const RATINGS = ['again', 'hard', 'good', 'easy'];

/** A refusal written for the learner: the route sends its message with its status. */
export class SittingError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const sittings = new Map();

const newToken = () => randomBytes(24).toString('base64url');
/** An attempt id `readAttemptId` accepts: base64url is A-Z, a-z, 0-9, - and _. */
const newAttemptId = () => randomBytes(12).toString('base64url');

function sweep(now) {
    for (const [token, s] of sittings) if (now - s.touched > SITTING_IDLE_MS) sittings.delete(token);
    while (sittings.size >= MAX_SITTINGS) {
        let oldest = null;
        for (const [token, s] of sittings) if (!oldest || s.touched < sittings.get(oldest).touched) oldest = token;
        sittings.delete(oldest);
    }
}

function open(sitting) {
    const now = Date.now();
    sweep(now);
    const token = newToken();
    sittings.set(token, { ...sitting, touched: now });
    return token;
}

function find(token, kind) {
    const s = typeof token === 'string' && token.length <= 64 ? sittings.get(token) : null;
    if (!s || s.kind !== kind || Date.now() - s.touched > SITTING_IDLE_MS) {
        throw new SittingError(404, kind === 'check'
            ? 'This mastery check has ended. Ask for a new one.'
            : 'This review session has ended. Ask for a new one.');
    }
    s.touched = Date.now();
    return s;
}

/**
 * Whether a check on this topic is open (drawn, not yet graded). A retake can
 * draw questions the last check missed, so while one is open nothing reads
 * the last check's keys back to the agent (agentReads.js, and a graded
 * check's own result while another on its topic is open: `checkState`).
 * `except` is the sitting asking, which is never open against itself.
 */
export function checkOpenOn(nodeId, except = null) {
    const now = Date.now();
    for (const s of sittings.values()) {
        if (s !== except && s.kind === 'check' && s.nodeId === Number(nodeId) && !s.result && now - s.touched <= SITTING_IDLE_MS) return true;
    }
    return false;
}

/** What the agent is told in place of the missed questions while another check on the topic is open. */
const HELD_MISSED = 'Another mastery check on this topic is open, so the questions missed are not shown. Once none is open, get_mastery shows the missed questions of the newest graded check, which is the other one if it is graded.';

/** Forget every sitting (the gates, between cases). */
export function closeAllSittings() {
    sittings.clear();
}

/** The interface language the learner chose in the app, so the view speaks it; null = follow the host. */
function uiLanguage() {
    const v = String(getSetting('ui_language', '') || '').trim();
    return v && v !== 'auto' ? v.slice(0, 16) : null;
}

const text = (v, cap = TEXT_CHARS) => (typeof v === 'string' ? v.slice(0, cap) : '');
const strings = (v, cap = 2000) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 24).map(x => x.slice(0, cap)) : []);

// ---------------------------------------------------------------------------
// The mastery check

/**
 * A stored question as the view may hold it before the check is submitted:
 * what the learner needs to answer it and nothing that tells the answer. A
 * WHITELIST, so a field added to questions later stays on the server until it
 * is argued in here. An ordering's items and an assembly's pieces are served
 * as stored, which is never key order (`servedInKeyOrder`, the sequence
 * normaliser). A question with a picture or a sound never gets here
 * (`startCheck` leaves it in the bank).
 */
export function publicQuestion(q, n) {
    const out = { n, type: text(q.type, 40) || 'multiple_choice', question: text(q.question) };
    const options = strings(q.options);
    if (out.type === 'multiple_choice' && options.length) out.options = options;
    if (out.type === 'sequence') out.items = strings(q.items);
    if (out.type === 'assemble') {
        out.template = text(q.template);
        out.tokens = strings(q.tokens, 200);
        if (q.reuse === true) out.reuse = true;
    }
    if (out.type === 'numeric' && text(q.unit, 40)) out.unit = text(q.unit, 40);
    if (out.type === 'code') {
        if (text(q.language, 24)) out.language = text(q.language, 24);
        if (text(q.starter)) out.starter = text(q.starter);
    }
    return out;
}

/** A question that shows a picture or plays a sound (`QuizQuestion.media`, `sanitizeQuestionMedia`). */
const questionHasMedia = (q) => (Array.isArray(q?.media) ? q.media.length > 0 : !!q?.media);

/** An untouched input's answer (`defaultAnswer` in src/components/answer/formats.ts): an ordering as served, anything else nothing. */
const defaultAnswer = (q) => (q.type === 'sequence' ? JSON.stringify(Array.isArray(q.items) ? q.items : []) : '');

/**
 * One answer graded the way every question surface grades it
 * (`gradeAnswer` in src/utils/grading.ts): closed formats here by local match,
 * open ones through the checker, with the bare comparison when the checker
 * cannot be reached. Unanswered is wrong. A view's untouched ordering is the
 * order it shows; a form has no such order, so an ordering left blank there
 * is blank, and the agent is told so rather than shown an order nobody gave.
 */
async function gradeOne(q, raw, { form = false } = {}) {
    const answer = typeof raw === 'string' && raw.trim() ? raw.slice(0, ANSWER_CHARS) : (form ? '' : defaultAnswer(q));
    if (!answer.trim()) return { correct: false, answer, explanation: text(q.explanation) };
    const local = gradeLocally(q, answer);
    if (local !== null) return { correct: local, answer, explanation: text(q.explanation) };
    try {
        const res = await checkAnswerWithAI(q.question, String(q.correct_answer ?? ''), answer, {
            format: q.type === 'code' ? 'code' : 'short_answer',
            language: text(q.language, 24),
        });
        return { correct: !!res?.correct, answer, explanation: text(res?.explanation) || text(q.explanation) };
    } catch {
        const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
        return { correct: norm(answer) === norm(q.correct_answer), answer, explanation: text(q.explanation) };
    }
}

function checkState(s) {
    const { checkPass } = getGateConfig();
    return {
        kind: 'check',
        topic: { id: s.nodeId, title: s.title, projectId: s.projectId, project: s.projectName },
        questions: s.questions.map((d, i) => publicQuestion(d.question, i + 1)),
        passPct: Math.round(checkPass * 100),
        topicCompleted: s.wasCompleted,
        // Another check on the topic still open may ask these questions again.
        ...(s.result ? {
            result: checkOpenOn(s.nodeId, s) ? { ...s.result, missed: [], missedText: HELD_MISSED, missedHeld: true } : s.result,
        } : {}),
    };
}

/** A topic that may take a mastery check, or the refusal the app's own check would give. */
function checkable(topic) {
    const node = topicFor(topic);
    if (!node) throw new SittingError(404, noTopicText(topic));
    const target = masteryCheckTarget(node.id);
    if (target.refused) throw new SittingError(target.httpStatus || 400, target.refused);
    return { node, target };
}

/** Where a topic's check is, opening nothing: what a host that draws no views links to. */
export function checkTarget(topic) {
    const { node } = checkable(topic);
    return { nodeId: node.id, projectId: node.project_id, title: node.title, projectName: node.project_name };
}

/**
 * Open a mastery check on a topic (a nodeId or a title). Returns
 * `{ token, text, ...state }`, or `{ token: null, text }` when there is no
 * check to take here (too few checked questions: the app writes them when the
 * topic's check is opened there). `form`: the check is taken in a form the
 * host asks its user to fill in (mcp/checkForm.js), which has no field a code
 * answer can be written in, so a code question is passed over as a picture is.
 */
export function startCheck({ topic, form = false }) {
    const { node, target } = checkable(topic);
    const { checkSize } = getGateConfig();
    // The app's draw in its own order (never asked first), the whole bank, so
    // a question this view cannot give is passed over for the next one rather
    // than leaving a gap. A question with a picture or a sound is one: the
    // view loads nothing from outside its own document, and a question the
    // learner cannot fully see must not cost them a point.
    const usable = drawFromNode(node.id, Number.MAX_SAFE_INTEGER).questions
        .filter(d => hasUsableKey(d.question) && !(form && d.question.type === 'code'));
    const questions = usable.filter(d => !questionHasMedia(d.question)).slice(0, checkSize);
    const where = { nodeId: node.id, projectId: node.project_id, title: node.title, projectName: node.project_name };
    if (questions.length < MIN_GATE_QUESTIONS) {
        const withMedia = usable.length - usable.filter(d => !questionHasMedia(d.question)).length;
        return {
            token: null, ...where,
            text: withMedia && usable.length >= MIN_GATE_QUESTIONS
                ? `"${node.title}" has ${usable.length} checked questions, but ${withMedia} of them show a picture or play a sound, which only `
                    + `Terramentor can, and a mastery check needs ${MIN_GATE_QUESTIONS} without one here. Take this topic's mastery check in Terramentor.`
                : `"${node.title}" has ${questions.length ? `only ${questions.length} checked question${questions.length === 1 ? '' : 's'}` : 'no checked questions'} `
                    + `${form ? 'a form can ask (a code question needs Terramentor\'s editor) ' : ''}yet, `
                    + `and a mastery check needs ${MIN_GATE_QUESTIONS}. Opening the topic's mastery check in Terramentor writes them.`,
        };
    }
    const token = open({
        kind: 'check', ...where, questions, attemptId: newAttemptId(), form: form === true,
        wasCompleted: target.status === 'completed', result: null, grading: null,
    });
    // The questions are not in this answer: it reaches the host's model, and
    // the view fetches them with the token (checkQuestions).
    return {
        token, ...where, count: questions.length, language: uiLanguage(),
        text: `A mastery check of ${questions.length} questions on "${node.title}" is open for the learner in the view. `
            + 'Its questions are not shown to you while it is open, and you must not try to answer them: the learner answers in the view, '
            + 'Terramentor grades the answers and records the result. Wait for the learner to finish. Once it is graded the view passes '
            + 'on the score and each question the learner missed, with the answer given and the right one, if this host gives a '
            + 'view\'s updates to you; get_mastery shows the same either way.',
    };
}

/**
 * Close a check nobody will submit (a form the learner declined or
 * cancelled). A graded check stays, so a retry of its submit gets its result.
 */
export function closeCheck(token) {
    const s = find(token, 'check');
    const closed = !s.result && !s.grading;
    if (closed) sittings.delete(token);
    // Not closed: graded and recorded, or its answers still being graded.
    return { closed, recorded: !!s.result, nodeId: s.nodeId, title: s.title };
}

export function checkQuestions(token) {
    return checkState(find(token, 'check'));
}

/**
 * Grade and record the whole check. `answers[i]` is the answer to question
 * i + 1 as its input encodes it (an ordering and an assembly as JSON). A
 * second submit, or one racing the first, gets the first result.
 */
export async function submitCheck(token, answers) {
    const s = find(token, 'check');
    if (s.result) return { ...checkState(s), duplicate: true };
    if (!Array.isArray(answers) || answers.length !== s.questions.length
        || answers.some(a => a != null && typeof a !== 'string')) {
        throw new SittingError(400, `Send one answer per question (${s.questions.length}).`);
    }
    if (!s.grading) {
        s.grading = (async () => {
            // One answer at a time, as the app's own check grades: a burst of
            // checker calls meets a provider's rate limit, and a fallback
            // verdict there counts a right answer as wrong.
            const graded = [];
            for (const [i, d] of s.questions.entries()) graded.push(await gradeOne(d.question, answers[i], { form: s.form }));
            const score = graded.filter(g => g.correct).length;
            const total = s.questions.length;
            const asked = s.questions.map((d, i) => ({
                quizId: d.quizId, index: d.index,
                ...(typeof d.question.uuid === 'string' && d.question.uuid ? { uuid: d.question.uuid } : { stem: d.question.question }),
                correct: graded[i].correct,
            }));
            const review = s.questions.map((d, i) => ({
                question: d.question, answer: graded[i].answer, correct: graded[i].correct,
                ...(graded[i].explanation ? { explanation: graded[i].explanation } : {}),
            }));
            const { outcome } = recordMasteryCheck({
                nodeId: s.nodeId, score, total, questions: s.questions.map(d => d.question), asked,
                attemptId: s.attemptId, review, via: s.form ? 'agent_form' : 'agent_view',
            });
            // A judged check shows the counts it was judged on: a question
            // reported while the answers were graded leaves the bank, and a
            // raw 4/5 beside a proven 3/4 that failed would contradict itself.
            // An unproven check judged nothing, so it keeps the raw counts.
            const judged = !outcome.unproven && Number.isInteger(outcome.proven_total) && outcome.proven_total > 0;
            const items = s.questions.map((d, i) => ({
                n: i + 1,
                question: text(d.question.question),
                correct: graded[i].correct,
                answer: shownAnswer(d.question, graded[i].answer),
                correctAnswer: shownKey(d.question),
                explanation: graded[i].explanation,
            }));
            // What the host's model is told: each question missed, with the
            // answer given and the right one. An unproven check recorded
            // nothing and is not a result to learn from, so it tells none.
            const missed = outcome.unproven ? [] : missedOf(items);
            s.result = {
                score: judged ? outcome.proven_score : score,
                total: judged ? outcome.proven_total : total,
                passed: !!outcome.passed,
                unproven: !!outcome.unproven,
                ...(outcome.unproven ? { proven: Number(outcome.proven_total) || 0 } : {}),
                passPct: Math.round((outcome.pass_threshold ?? getGateConfig().checkPass) * 100),
                items,
                missed,
                missedText: missedText(missed),
                // The pass completed the topic in the same write that recorded it.
                completed: !!outcome.passed && outcome.completed === true,
            };
        })().finally(() => { s.grading = null; });
    }
    await s.grading;
    return checkState(s);
}

/**
 * After a pass, the topic the check proved. The pass already completed it
 * (server/masteryCheck.js); a view offers Continue only when it did not, and
 * then the completion is the app's own PUT /api/nodes/:id (the MCP server
 * sends it), whose gate reads the evidence this check wrote. This only says
 * whether the sitting earned it.
 */
export function checkCompletion(token) {
    const s = find(token, 'check');
    if (!s.result?.passed) throw new SittingError(409, 'Only a passed mastery check marks its topic completed.');
    // `completed`: the pass already completed the topic when it was recorded,
    // so the caller has nothing to write (a second write would overwrite a
    // status set since, such as a skip). `status` is the topic's status now,
    // which may no longer be the completion the pass wrote.
    const status = (topicStatusStmt ??= db.prepare('SELECT status FROM nodes WHERE id = ?')).get(s.nodeId)?.status ?? null;
    return { nodeId: s.nodeId, projectId: s.projectId, completed: s.result.completed === true, status };
}
let topicStatusStmt;

/** The view says the completion landed, so a re-mounted view does not offer it again. */
export function markCheckCompleted(token) {
    const s = find(token, 'check');
    if (s.result?.passed) s.result.completed = true;
    return checkState(s);
}

// ---------------------------------------------------------------------------
// The card review

/** The scheduler on the learner's fitted weights, as the app's store configures it on every settings load. */
function configureScheduler() {
    let w = null;
    try { w = JSON.parse(getSetting('fsrs_params', 'null')); } catch { w = null; }
    configureSrs({ w: Array.isArray(w) ? w : null });
}

/** A card's text without its markup (a ruby's base, a link's label): the view draws plain text. */
const plain = (v) => {
    const s = text(v);
    try { return stripCardMarkup(s); } catch { return s; }
};

const hasMedia = (card) => {
    if (!card.media) return false;
    try { const m = JSON.parse(card.media); return Array.isArray(m) ? m.length > 0 : !!m; } catch { return false; }
};

function cardFront(card, presentationId) {
    return {
        presentationId,
        cardId: card.id,
        front: plain(card.front),
        ...(card.extra_front ? { extraFront: plain(card.extra_front) } : {}),
        topic: text(card.node_title, 200),
        project: text(card.project_name, 200),
        ...(hasMedia(card) ? { hasMedia: true } : {}),
    };
}

// Read once per card shown (and in a loop while skipping removed cards), so
// prepared on first use and kept, never at import.
let cardRowStatement = null;
const cardRow = (id) => (cardRowStatement ??= db.prepare(`
    SELECT f.*, n.title AS node_title, p.name AS project_name
    FROM flashcards f JOIN nodes n ON n.id = f.node_id JOIN projects p ON p.id = n.project_id
    WHERE f.id = ?
`)).get(id);

/**
 * The session's counts, and the rating Undo would take back (its
 * presentationId, the name `reviewUndo` wants), or null when none is left:
 * the view shows Undo only while there is one.
 */
function reviewCounts(s) {
    return {
        total: s.queue.length, reviewed: s.reviewed.size, comingBack: s.pending.size, rated: s.ratedCount,
        undoable: s.undo.length ? s.undo[s.undo.length - 1].presentationId : null,
    };
}

/** The next card by useReviewQueue's order: a returning card whose time has come, then the next unseen, then one coming back within the learn-ahead. */
function nextIndex(s, now, anyway) {
    let due = null;
    for (const [i, at] of s.pending) if (at <= now && (due === null || at < s.pending.get(due))) due = i;
    if (due !== null) return due;
    for (let i = 0; i < s.queue.length; i++) if (!s.reviewed.has(i) && !s.pending.has(i)) return i;
    let soonest = null;
    for (const [i, at] of s.pending) if (soonest === null || at < s.pending.get(soonest)) soonest = i;
    if (soonest !== null && (anyway || s.pending.get(soonest) - now <= LEARN_AHEAD_MS)) return soonest;
    return null;
}

function scopeName(s) {
    return s.projectName ? `"${s.projectName}"` : 'every active project';
}

/**
 * Open a review session: the project's own study queue (reviews owed, then
 * the day's new cards), or every active project's. `{ token: null, text }`
 * when nothing is due.
 */
/** The project a review is for (null = every active one) and its queue: reviews owed, then the day's new cards. */
function reviewScope(project) {
    let scope = null;
    const ref = String(project ?? '').trim();
    if (ref) {
        const { project: found, candidates } = findProject(ref);
        if (candidates.length) throw new SittingError(400, ambiguousProjectText(ref, candidates));
        if (!found) throw new SittingError(404, `There is no project matching "${ref.slice(0, 120)}". Use project_state for the learner's projects.`);
        scope = found;
    }
    const { reviews, fresh } = scope ? studyQueue(scope.id) : globalStudyQueue();
    const queue = [...reviews, ...fresh].slice(0, MAX_SESSION_CARDS).map(c => c.id);
    return { scope, queue, where: { projectId: scope?.id ?? null, projectName: scope?.name ?? null } };
}

/** How many cards a review would hold, opening nothing: what a host that draws no views says. */
export function reviewTarget(project) {
    const { queue, where } = reviewScope(project);
    return { ...where, count: queue.length };
}

export function startReview({ project = '' }) {
    const { scope, queue, where } = reviewScope(project);
    if (!queue.length) {
        return { token: null, ...where, text: `No cards are due in ${scope ? `"${scope.name}"` : 'any active project'} right now.` };
    }
    const token = open({
        kind: 'review', ...where, queue, reviewed: new Set(), pending: new Map(),
        current: null, undo: [], undone: new Map(), rated: new Map(), ratedCount: 0,
    });
    const s = sittings.get(token);
    return {
        token, ...where, kind: 'review', ...reviewCounts(s), language: uiLanguage(),
        text: `A card review of ${queue.length} card${queue.length === 1 ? '' : 's'} from ${scopeName(s)} is open for the learner in the view. `
            + 'You cannot see the cards: the learner reviews them there and Terramentor schedules each one. Wait for the learner to finish.',
    };
}

/** The card on screen (the same one again until it is rated), or the end of the session. */
export function reviewNext(token, { anyway = false } = {}) {
    const s = find(token, 'review');
    const now = Date.now();
    if (!s.current) {
        const idx = nextIndex(s, now, anyway === true);
        if (idx !== null) s.current = { idx, presentationId: newAttemptId(), revealed: false };
    }
    while (s.current) {
        const card = cardRow(s.queue[s.current.idx]);
        if (card) return { kind: 'review', ...reviewCounts(s), card: cardFront(card, s.current.presentationId), revealed: s.current.revealed };
        // Deleted since the session opened: it is not owed any more.
        s.reviewed.add(s.current.idx);
        s.pending.delete(s.current.idx);
        const idx = nextIndex(s, now, anyway === true);
        s.current = idx === null ? null : { idx, presentationId: newAttemptId(), revealed: false };
    }
    let soonest = null;
    for (const at of s.pending.values()) if (soonest === null || at < soonest) soonest = at;
    return {
        kind: 'review', ...reviewCounts(s), done: true,
        ...(soonest !== null ? { waiting: { count: s.pending.size, readyIn: formatInterval(Math.max(0, soonest - now) / 86_400_000) } } : {}),
    };
}

function currentCard(s, presentationId) {
    if (!s.current || s.current.presentationId !== presentationId) {
        throw new SittingError(409, 'That card is no longer the one on screen.');
    }
    const card = cardRow(s.queue[s.current.idx]);
    if (!card) throw new SittingError(404, 'That card was deleted.');
    return card;
}

/** The answer side, and what each rating would schedule (the hint under each button). */
export function reviewReveal(token, presentationId) {
    const s = find(token, 'review');
    const card = currentCard(s, presentationId);
    s.current.revealed = true;
    configureScheduler();
    const now = new Date();
    const intervals = Object.fromEntries(RATINGS.map(r => [r, formatInterval(computeNextInterval(card, r, now).intervalDays)]));
    return {
        kind: 'review', ...reviewCounts(s),
        card: { ...cardFront(card, presentationId), back: plain(card.back), ...(card.extra ? { extra: plain(card.extra) } : {}) },
        revealed: true, intervals,
    };
}

/**
 * Rate the card on screen. Written once per presentation: a retry of a rating
 * whose answer was lost gets the first outcome and writes nothing.
 */
export function reviewRate(token, presentationId, rating) {
    const s = find(token, 'review');
    if (!RATINGS.includes(rating)) throw new SittingError(400, 'A rating is again, hard, good or easy.');
    if (typeof presentationId === 'string' && s.rated.has(presentationId)) {
        return { ...s.rated.get(presentationId), duplicate: true, ...reviewCounts(s) };
    }
    const card = currentCard(s, presentationId);
    if (!s.current.revealed) throw new SittingError(409, 'Show the answer before rating the card.');
    configureScheduler();
    const now = new Date();
    const update = computeSrsUpdate(card, rating, now);
    const { duplicate, outcome } = recordOnce('agent_review', presentationId, () => {
        const written = writeCard(card.id, update);
        if (written.status !== 200) throw new SittingError(written.status, written.json?.error || 'The rating was not saved.');
        return { rating, next_review: update.next_review };
    });
    const back = requeueAt(update);
    const idx = s.current.idx;
    if (!duplicate) {
        s.undo.push({ presentationId, idx, cardId: card.id, snapshot: srsSnapshot(card, update.last_reviewed), wasPendingAt: s.pending.get(idx) ?? null });
        s.ratedCount++;
    }
    if (back != null) s.pending.set(idx, back);
    else { s.pending.delete(idx); s.reviewed.add(idx); }
    s.current = null;
    const result = { kind: 'review', rated: outcome.rating, comesBackIn: back != null ? formatInterval(Math.max(0, back - now.getTime()) / 86_400_000) : null };
    s.rated.set(presentationId, result);
    return { ...result, ...reviewCounts(s), ...(duplicate ? { duplicate: true } : {}) };
}

/**
 * Take back the session's last rating: the card's whole prior state is
 * restored (`srsSnapshot`, the app's undo) and it is on screen again. A card
 * rated since somewhere else keeps that rating.
 *
 * The request names the rating it takes back (`presentationId`, the
 * session's `undoable`), so it is written once: a retry whose first answer
 * was lost gets that answer again, and never takes back a second rating.
 */
export function reviewUndo(token, presentationId) {
    const s = find(token, 'review');
    if (typeof presentationId !== 'string' || !presentationId) throw new SittingError(400, 'Name the rating to take back (the session\'s undoable).');
    const before = s.undone.get(presentationId);
    if (before) return { ...(before.undone ? reviewNext(token) : { kind: 'review', ...reviewCounts(s) }), ...before, duplicate: true };
    const last = s.undo[s.undo.length - 1];
    if (!last) throw new SittingError(409, 'There is no rating to take back.');
    if (last.presentationId !== presentationId) throw new SittingError(409, 'That is not the last rating any more.');
    s.undo.pop();
    const written = writeCard(last.cardId, last.snapshot);
    // Rated again since: that rating stays, for good. Any other refusal (a
    // reported card) keeps the undo for when the refusal is lifted.
    if (written.status === 409 && written.json?.conflict === 'reviewed_since') {
        const kept = { undone: false, message: 'This card was reviewed again since, so that rating stays.' };
        s.undone.set(presentationId, kept);
        return { kind: 'review', ...kept, ...reviewCounts(s) };
    }
    if (written.status !== 200) {
        s.undo.push(last);
        throw new SittingError(written.status, written.json?.error || 'The rating could not be taken back.');
    }
    s.reviewed.delete(last.idx);
    if (last.wasPendingAt != null) s.pending.set(last.idx, last.wasPendingAt);
    else s.pending.delete(last.idx);
    s.ratedCount = Math.max(0, s.ratedCount - 1);
    s.current = { idx: last.idx, presentationId: newAttemptId(), revealed: false };
    s.undone.set(presentationId, { undone: true });
    return { undone: true, ...reviewNext(token) };
}
