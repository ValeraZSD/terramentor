// What an agent is told about a graded mastery check: the questions the
// learner missed, each with the answer given, the right one and why. One
// wording for the two places an agent reads it: the result of a check taken in
// the host (server/agentSittings.js, a view or a form) and get_mastery's last
// check (server/agentReads.js, read from the kept review, sittingReview.js).
//
// Only a GRADED check: nothing here reads an open sitting, and a question the
// learner got right is not listed. A key travels only for a question the
// learner has answered and submitted, as the app's own result screen shows it.
import { readPieces, templateParts } from './answerFormats.js';

const TEXT_CHARS = 8_000;
/** How much of a stem or an explanation the agent is told; a check holds up to 30. */
const STEM_CHARS = 1_000;
const ANSWER_CHARS = 600;

const text = (v, cap = TEXT_CHARS) => (typeof v === 'string' ? v.slice(0, cap) : '');
const clip = (v, cap) => {
    const s = String(v ?? '').trim();
    return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
};

function filledTemplate(template, pieces) {
    const parts = templateParts(template);
    // A record kept before it held the template: the pieces in order.
    if (parts.length < 2) return pieces.map(p => p ?? '___').join(' … ');
    return parts.map((part, i) => part + (i < pieces.length ? (pieces[i] ?? '___') : '')).join('');
}

/** The key, as a learner reads it once the check is over. */
export function shownKey(q) {
    if (q.type === 'sequence') {
        try {
            const k = JSON.parse(String(q.correct_answer));
            if (Array.isArray(k)) return k.map(String);
        } catch { /* shown as stored */ }
    }
    if (q.type === 'assemble') {
        const pieces = readPieces(q.correct_answer);
        if (pieces) return filledTemplate(q.template, pieces);
    }
    if (q.type === 'numeric' && text(q.unit, 40)) return `${q.correct_answer} ${text(q.unit, 40)}`;
    return text(String(q.correct_answer ?? ''));
}

/** What the learner answered, read back the way the key is. */
export function shownAnswer(q, answer) {
    if (q.type === 'sequence') {
        try {
            const a = JSON.parse(answer);
            if (Array.isArray(a)) return a.map(String);
        } catch { /* as typed */ }
    }
    if (q.type === 'assemble') {
        const pieces = readPieces(answer, { holes: true });
        if (pieces) return filledTemplate(q.template, pieces);
    }
    return text(answer);
}

const said = (v) => (Array.isArray(v) ? v.join(' → ') : String(v ?? ''));

/**
 * The missed questions of a graded check, from its items
 * (`{ n, question, correct, answer, correctAnswer, explanation }`, the
 * answer and key as shownAnswer/shownKey read them).
 */
export function missedOf(items) {
    return (Array.isArray(items) ? items : []).filter(i => i && !i.correct).map(i => ({
        n: i.n,
        question: clip(i.question, STEM_CHARS),
        answer: clip(said(i.answer), ANSWER_CHARS),
        correctAnswer: clip(said(i.correctAnswer), ANSWER_CHARS),
        ...(clip(i.explanation, STEM_CHARS) ? { explanation: clip(i.explanation, STEM_CHARS) } : {}),
    }));
}

/** The kept review of a check (sittingReview.js) as missedOf's items. */
export function reviewItems(review) {
    return (review?.items || []).map((it, i) => ({
        n: i + 1,
        question: it.question?.question || '',
        correct: it.correct === true,
        answer: shownAnswer(it.question || {}, it.answer || ''),
        correctAnswer: shownKey(it.question || {}),
        explanation: it.explanation || it.question?.explanation || '',
    }));
}

/** The missed questions as lines the agent's model reads; '' when none was missed. */
export function missedText(missed) {
    if (!missed?.length) return '';
    return [
        `Missed (${missed.length}):`,
        ...missed.map(m => [
            `${m.n}. ${m.question}`,
            `   Answered: ${m.answer || '(left blank)'}`,
            `   Right answer: ${m.correctAnswer}`,
            ...(m.explanation ? [`   Why: ${m.explanation}`] : []),
        ].join('\n')),
    ].join('\n');
}
