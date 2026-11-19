/**
 * The answer-key checker (feedQuality.js verifyQuestion): before a question
 * reaches a learner, a second call solves it cold and must agree with the key.
 * Half the keys below are right (the checker must let them through), half are
 * wrong (it must stop them). A checker that gives no verdict fails either way.
 */
const right = (r) => r.ok === true && r.available === true
    ? { pass: true, why: 'right key let through' }
    : { pass: false, why: r.available ? `right key stopped: ${r.reason}` : `no verdict: ${r.reason}` };
const wrong = (r) => r.ok === false && r.available === true
    ? { pass: true, why: `wrong key stopped: ${r.reason}` }
    : { pass: false, why: r.available ? 'wrong key let through' : `no verdict: ${r.reason}` };

const v = (o) => JSON.stringify(o);
const mc = (question, options, key) => ({ type: 'multiple_choice', question, options, correct_answer: key, explanation: '' });
const tf = (question, key) => ({ type: 'true_false', question, options: ['True', 'False'], correct_answer: key, explanation: '' });

/** A case whose key is right: golden agrees, mutants disagree or say nothing. */
function rightKey(id, title, q, otherOption) {
    return {
        id, run: (fx, app) => app.server('feedQuality.js').then(m => m.verifyQuestion(title, q)),
        score: right,
        golden: v({ verdict: 'ok', answer: q.correct_answer, reason: 'The key is correct.', eliminable: 0 }),
        mutants: [
            { name: 'solves it to another option', reply: v({ verdict: 'ok', answer: otherOption, reason: 'Checked.', eliminable: 0 }) },
            { name: 'calls a sound question broken', reply: v({ verdict: 'broken', answer: q.correct_answer, reason: 'Ambiguous.' }) },
            { name: 'no JSON at all', reply: `The answer is ${q.correct_answer}.` },
            { name: 'unsure', reply: v({ verdict: 'unsure', answer: '', reason: 'Not sure.' }) },
        ],
    };
}

/** A case whose key is wrong: golden finds the real answer, mutants rubber-stamp. */
function wrongKey(id, title, q, realAnswer) {
    return {
        id, run: (fx, app) => app.server('feedQuality.js').then(m => m.verifyQuestion(title, q)),
        score: wrong,
        golden: v({ verdict: 'ok', answer: realAnswer, reason: `The correct answer is ${realAnswer}.`, eliminable: 0 }),
        mutants: [
            { name: 'agrees with the wrong key', reply: v({ verdict: 'ok', answer: q.correct_answer, reason: 'Correct.', eliminable: 0 }) },
            { name: 'no JSON at all', reply: 'Looks fine to me.' },
            { name: 'echoes the template', reply: v({ verdict: 'ok | broken', answer: '', reason: '...' }) },
        ],
    };
}

export default {
    category: 'verify',
    label: 'Checking answer keys',
    cases: [
        rightKey('verify-mc-multiply-right', 'Multiplying two-digit numbers',
            mc('What is 17 × 23?', ['391', '381', '401', '371'], '391'), '381'),
        wrongKey('verify-mc-percent-wrong', 'Percentages',
            mc('What is 15% of 240?', ['32', '36', '24', '40'], '32'), '36'),
        rightKey('verify-mc-freefall-right', 'Free fall',
            mc('A stone is dropped from rest. Ignoring air resistance and taking g = 9.8 m/s², how fast is it falling after 3.0 s?',
                ['29.4 m/s', '9.8 m/s', '44.1 m/s', '14.7 m/s'], '29.4 m/s'), '44.1 m/s'),
        wrongKey('verify-mc-ohm-wrong', "Ohm's law",
            mc('A 12 V battery drives current through a 4 Ω resistor. What is the current?', ['3 A', '48 A', '0.33 A', '16 A'], '48 A'), '3 A'),
        rightKey('verify-tf-altitude-right', 'Boiling point and pressure',
            tf('Water boils at a lower temperature high on a mountain than at sea level.', 'True'), 'False'),
        wrongKey('verify-tf-moonlight-wrong', 'The Moon',
            tf('The Moon gives off its own visible light.', 'True'), 'False'),
        wrongKey('verify-mc-berlin-wrong', 'The end of the Cold War',
            mc('In which year did the Berlin Wall fall?', ['1987', '1989', '1991', '1993'], '1991'), '1989'),
        rightKey('verify-mc-sodium-right', 'Chemical symbols',
            mc('What is the chemical symbol for sodium?', ['Na', 'So', 'Sd', 'N'], 'Na'), 'So'),
        wrongKey('verify-mc-dutch-past-wrong', 'Sterke werkwoorden in de verleden tijd',
            mc('Wat is de verleden tijd van "lopen" bij "ik"?', ['liep', 'loopte', 'liepte', 'gelopen'], 'loopte'), 'liep'),
        wrongKey('verify-mc-russian-capital-wrong', 'Столицы государств',
            mc('Какой город является столицей Австралии?', ['Сидней', 'Канберра', 'Мельбурн', 'Перт'], 'Сидней'), 'Канберра'),
        {
            id: 'verify-sequence-planets-right',
            run: (fx, app) => app.server('feedQuality.js').then(m => m.verifyQuestion('The inner planets', {
                type: 'sequence', question: 'Put these planets in order of distance from the Sun, nearest first.',
                items: ['Mars', 'Venus', 'Earth', 'Mercury'],
                correct_answer: JSON.stringify(['Mercury', 'Venus', 'Earth', 'Mars']), explanation: '',
            })),
            score: right,
            golden: v({ verdict: 'ok', answer: ['Mercury', 'Venus', 'Earth', 'Mars'], reason: 'Order is correct.' }),
            mutants: [
                { name: 'swaps two planets', reply: v({ verdict: 'ok', answer: ['Mercury', 'Earth', 'Venus', 'Mars'], reason: 'ok' }) },
                { name: 'answer as a string', reply: v({ verdict: 'ok', answer: 'Mercury, Venus, Earth, Mars', reason: 'ok' }) },
                { name: 'no JSON at all', reply: 'Mercury, Venus, Earth, Mars.' },
            ],
        },
        {
            id: 'verify-code-off-by-one-wrong',
            run: (fx, app) => app.server('feedQuality.js').then(m => m.verifyQuestion('Loops in Python', {
                type: 'code', language: 'python',
                question: 'Write a function total(n) that returns the sum 1 + 2 + ... + n for a whole number n >= 1. Example: total(4) returns 10.',
                correct_answer: 'def total(n):\n    s = 0\n    for i in range(1, n):\n        s += i\n    return s',
                explanation: 'Add every number from 1 to n.',
            })),
            score: wrong,
            golden: v({ verdict: 'broken', answer: '', reason: 'range(1, n) stops at n-1, so total(4) returns 6, not 10.' }),
            mutants: [
                { name: 'passes the buggy solution', reply: v({ verdict: 'ok', answer: '', reason: 'Correct loop.' }) },
                { name: 'no JSON at all', reply: 'The loop is off by one.' },
            ],
        },
    ],
};
