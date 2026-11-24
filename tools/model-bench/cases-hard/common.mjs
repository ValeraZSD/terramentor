/**
 * What the hard suite's families share.
 *
 * Solve cases go through the answer-key checker (feedQuality.js
 * verifyQuestion), which never sees the key: it solves the question cold and
 * the app compares its answer with the key. Every solve case here carries the
 * TRUE key, so the app lets it through exactly when the model solved it, and a
 * model that calls a sound question "broken", answers "unsure" or picks a
 * distractor fails. The distractors are the answers a plausible mistake leads
 * to (the classic misconception, a dropped factor, a sign slip), so guessing
 * scores below the 1-in-6 a blind pick would.
 *
 * Unsound cases are questions an expert must refuse (two right options, no
 * right option, a false premise, an item that does not belong). They pass only
 * on the verdict "broken": an answer that merely differs from the key is a
 * guess, not a refusal, even though the app would stop that question too.
 */
export const v = (o) => JSON.stringify(o);

export const mc = (question, options, key) => {
    if (!options.includes(key)) throw new Error(`key "${key}" is not an option of: ${question.slice(0, 60)}`);
    return { type: 'multiple_choice', question, options, correct_answer: key, explanation: '' };
};

/** An ordering. `shown` is the order the learner sees; `order` is the key. */
export const seq = (question, shown, order) => {
    if (shown.length !== order.length || !order.every(x => shown.includes(x))) throw new Error(`sequence items and key differ: ${question.slice(0, 60)}`);
    return { type: 'sequence', question, items: shown, correct_answer: JSON.stringify(order), explanation: '' };
};

const verify = (title, q) => (fx, app) => app.server('feedQuality.js').then(m => m.verifyQuestion(title, q));

/** Pass only when the checker gave a verdict and agreed with the true key. */
export const solved = (r) => {
    if (!r || typeof r !== 'object') return { pass: false, why: 'no result' };
    if (!r.available) return { pass: false, why: `no verdict: ${r.reason}` };
    return r.ok ? { pass: true, why: 'solved' } : { pass: false, why: String(r.reason).slice(0, 120) };
};

const DISPUTE = /^(answer key|order|arrangement) disputed/;

/** Pass only on the verdict "broken" (a dispute is a different answer, not a refusal). */
export const refused = (r) => {
    if (!r || typeof r !== 'object') return { pass: false, why: 'no result' };
    if (!r.available) return { pass: false, why: `no verdict: ${r.reason}` };
    if (r.ok) return { pass: false, why: 'answered an unsound question' };
    if (DISPUTE.test(String(r.reason))) return { pass: false, why: `answered instead of refusing: ${String(r.reason).slice(0, 90)}` };
    return { pass: true, why: `refused: ${String(r.reason).slice(0, 90)}` };
};

/**
 * A sound closed question. `lure` is the distractor the expected mistake
 * leads to (an option for a multiple-choice question, a near-right order for
 * a sequence).
 */
export function solve(id, title, q, lure) {
    const isSeq = q.type === 'sequence';
    const key = isSeq ? JSON.parse(q.correct_answer) : q.correct_answer;
    return {
        id, q, run: verify(title, q), score: solved,
        golden: v({ verdict: 'ok', answer: key, reason: 'Worked out from the subject.', eliminable: 0 }),
        mutants: [
            { name: 'falls for the lure', reply: v({ verdict: 'ok', answer: lure, reason: 'Checked.', eliminable: 0 }) },
            { name: 'calls a sound question broken', reply: v({ verdict: 'broken', answer: '', reason: 'Too hard to settle.' }) },
            { name: 'unsure', reply: v({ verdict: 'unsure', answer: '', reason: 'Not sure.' }) },
            { name: 'no JSON at all', reply: `I think the answer is ${isSeq ? key.join(', ') : key}.` },
        ],
    };
}

/**
 * A sound ordering whose lure swaps the closest pair, the items at `i` and
 * `i + 1` of the key: the mistake a model that nearly knows the values makes.
 */
export function order(id, title, question, shown, key, i) {
    const lure = [...key];
    [lure[i], lure[i + 1]] = [lure[i + 1], lure[i]];
    return solve(id, title, seq(question, shown, key), lure);
}

/** An unsound question; `pick` is what a model that does not notice answers. */
export function unsound(id, title, q, pick, why) {
    const isSeq = q.type === 'sequence';
    return {
        id, q, unsound: true, run: verify(title, q), score: refused,
        golden: v({ verdict: 'broken', answer: isSeq ? [] : '', reason: why }),
        mutants: [
            { name: 'answers it anyway', reply: v({ verdict: 'ok', answer: pick, reason: 'Checked.', eliminable: 0 }) },
            { name: 'answers with the key', reply: v({ verdict: 'ok', answer: isSeq ? JSON.parse(q.correct_answer) : q.correct_answer, reason: 'Checked.', eliminable: 0 }) },
            { name: 'no JSON at all', reply: 'This question has a problem.' },
        ],
    };
}

/**
 * Run once per library from a family's setup: no option of a multiple-choice
 * case may read as the key to the app's own comparison (sameAnswer matches a
 * contiguous run of tokens, so "2" would agree with "1/2"), or a model that
 * picks that distractor would be scored as right. Likewise no two items of an
 * ordering may read as one item (sameOption), or a swapped pair would pass.
 */
export async function checkOptions(app, cases) {
    const { sameAnswer } = await app.server('feedQuality.js');
    const { sameOption } = await app.server('questionOptions.js');
    for (const c of cases) {
        if (c.q?.type === 'sequence') {
            const items = c.q.items;
            const twin = items.findIndex((a, i) => items.some((b, k) => k > i && sameOption(a, b)));
            if (twin >= 0) throw new Error(`${c.id}: item "${items[twin]}" reads as another item`);
        }
        if (c.q?.type !== 'multiple_choice') continue;
        const others = c.q.options.filter(o => o !== c.q.correct_answer);
        const clash = others.find(o => sameAnswer(o, c.q.correct_answer));
        if (clash) throw new Error(`${c.id}: option "${clash}" reads as the key "${c.q.correct_answer}"`);
        if (!c.unsound && !others.includes(c.mutants[0].reply && JSON.parse(c.mutants[0].reply).answer)) {
            throw new Error(`${c.id}: the lure is not one of the options`);
        }
    }
    return {};
}

/** A family of solve/unsound cases with the option check as its setup. */
export const family = (category, label, cases) => ({ category, label, setup: (app) => checkOptions(app, cases), cases });
