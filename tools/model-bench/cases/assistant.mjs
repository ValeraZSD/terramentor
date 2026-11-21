/**
 * Checking the assistant's cards (assistantChecks.js checkCards). Before the
 * learner can add a flashcard the assistant proposed, a second call answers the
 * card's FRONT cold (AI_PROMPTS.feed_drill_check, it never sees the back), and
 * the app compares that answer with the back. A cold answer that differs gets
 * one more call (feed_drill_arbiter) that sees the two answers side by side,
 * unlabelled. The model requests therefore come in this order, which is also the
 * order a golden array gives its replies:
 *
 *   1. the cold answers: {"answers": [{"n": 1, "answer": "..."}]}
 *   2. only when 1 differs from the back: {"verdicts": [{"n": 1, "correct": "A"|"B"|"both"|"neither"}]}
 *
 * With one contested card the app puts the card's own back in position A (the
 * first contested row keeps the key first), so the arbiter siding with the
 * cold answer is "B". A back the arbiter sides with is `ok`; a back it rejects
 * is `disputed`; a reply the app cannot read is `unchecked`, which fails here
 * whichever verdict was expected: an unchecked card is offered to the learner
 * unchecked.
 *
 * Verdicts are kept by card content in `assistant_checks`, which would answer
 * a repeat call without a model, so each run starts from an empty cache (a live
 * run has a fresh library; the golden and the mutants share one here).
 * The dispute cards have a back that is plainly wrong, and the cold answer a
 * sound model gives is the real one.
 */
const answers = (...list) => JSON.stringify({ answers: list.map((answer, i) => ({ n: i + 1, answer })) });
const looks = (correct) => JSON.stringify({ verdicts: [{ n: 1, correct }] });

const NODES = {
    electricity: 'Electricity',
    nl: 'Nederland: ligging en bestuur',
    atmosphere: 'Earth’s atmosphere',
    ru: 'Биология человека: клетка и геном',
};

export async function setup(app) {
    const { db } = app;
    const fx = {};
    const project = db.prepare('INSERT INTO projects (name, content_language) VALUES (?, ?)').run('Assistant checks bench', 'en').lastInsertRowid;
    let position = 0;
    for (const [key, title] of Object.entries(NODES)) {
        fx[key] = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, ?)').run(project, title, position++).lastInsertRowid;
    }
    return fx;
}

const runCheck = (card) => async (fx, app) => {
    // The cache is keyed by content; every run is a first look.
    app.db.prepare('DELETE FROM assistant_checks').run();
    const m = await app.server('assistantChecks.js');
    return m.checkCards([{ nodeId: fx[card.node], front: card.front, back: card.back }]);
};

const want = (verdict) => (out) => {
    const v = Array.isArray(out) ? out[0] : null;
    if (!v) return { pass: false, why: 'no verdict returned' };
    if (v.verdict === verdict) return { pass: true, why: `card ${verdict}` };
    return { pass: false, why: `card ${v.verdict}${v.reason ? ` (${String(v.reason).slice(0, 60)})` : ''}, wanted ${verdict}` };
};

/** A card whose back is right: the cold answer agrees, so one request is made. */
function okCard(id, card, cold, otherAnswer) {
    return {
        id,
        run: runCheck(card),
        score: want('ok'),
        golden: answers(cold),
        mutants: [
            { name: 'cold answer differs and the arbiter sides with it', reply: [answers(otherAnswer), looks('B')] },
            { name: 'cold answer says the question is ambiguous', reply: answers('AMBIGUOUS') },
            { name: 'no JSON at all', reply: `The answer is ${cold}.` },
            { name: 'answers list is empty', reply: JSON.stringify({ answers: [] }) },
        ],
    };
}

/** A card whose back is wrong: the cold answer is the real one, and the arbiter backs it. */
function disputedCard(id, card, cold) {
    return {
        id,
        run: runCheck(card),
        score: want('disputed'),
        golden: [answers(cold), looks('B')],
        mutants: [
            { name: 'cold answer repeats the wrong back', reply: answers(card.back) },
            { name: 'arbiter sides with the wrong back', reply: [answers(cold), looks('A')] },
            { name: 'arbiter calls the two the same', reply: [answers(cold), looks('both')] },
            { name: 'arbiter reply unreadable', reply: [answers(cold), 'I cannot decide between them.'] },
            { name: 'no JSON at all', reply: 'Nothing to report.' },
        ],
    };
}

export default {
    category: 'assistant-check',
    label: 'Checking the assistant\'s cards',
    setup,
    cases: [
        okCard('assistant-card-ohm-ok',
            { node: 'electricity', front: 'What is the SI unit of electrical resistance?', back: 'The ohm (Ω)' },
            'ohm', 'volt'),
        okCard('assistant-card-nl-provincies-ok',
            { node: 'nl', front: 'Hoeveel provincies heeft Nederland?', back: '12' },
            '12', '11'),
        disputedCard('assistant-card-atmosphere-wrong',
            { node: 'atmosphere', front: 'Which gas makes up most of Earth’s atmosphere, by volume?', back: 'Oxygen' },
            'Nitrogen'),
        disputedCard('assistant-card-ru-chromosomes-wrong',
            { node: 'ru', front: 'Сколько хромосом в клетке тела здорового человека?', back: '48' },
            '46'),
    ],
};
