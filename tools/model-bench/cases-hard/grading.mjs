/**
 * Grading typed answers in pairs (ai.js checkAnswerWithAI). Each case marks two
 * answers to the same question: one that is right but looks unlike the key (an
 * equivalent form, a different constant of integration, an unsimplified
 * fraction, another correct algorithm) and one that is wrong but looks like
 * it (the key's own numbers in a wrong result, a reversed rule, a famous
 * confusion, code that passes the task's example and fails elsewhere). A case
 * passes only when both verdicts are right, so a marker that accepts
 * everything or rejects everything scores nothing.
 *
 * The marker's prompt says to ignore spelling and grammar, so no wrong answer
 * here is wrong only by its spelling: each is wrong in what it says. Every key
 * is 10+ characters, so the quick accepts at the top of checkAnswerWithAI
 * never answer first. The arithmetic was run: 252/1024 = 63/256 ≈ 0.246 and
 * 252/512 ≈ 0.492; the base-rate answer is 0.00099 / 0.01098 ≈ 0.090; the
 * wrong unique() returns [3, 2, 1] for the task's example.
 *
 * A verdict the app cannot read comes back `graded: false` and "unsure" comes
 * back `unsure: true`; neither counts as a verdict, whichever was expected.
 */
const j = (correct, explanation) => JSON.stringify({ correct, explanation });

const verdict = (r, want) => {
    if (!r || typeof r !== 'object') return 'no result';
    if (r.graded === false) return `no verdict (${r.unsure ? 'unsure' : 'reply not read'})`;
    if (r.unsure) return 'unsure';
    if (r.correct !== want) return want ? 'a right answer marked wrong' : 'a wrong answer marked correct';
    return null;
};

function pair({ id, q, key, right, wrong, why, format, language }) {
    return {
        id,
        key,
        run: async (fx, app) => ({
            right: await app.ai.checkAnswerWithAI(q, key, right, { format, language }),
            wrong: await app.ai.checkAnswerWithAI(q, key, wrong, { format, language }),
        }),
        score: (r) => {
            const a = verdict(r?.right, true);
            const b = verdict(r?.wrong, false);
            if (a || b) return { pass: false, why: [a && `right answer: ${a}`, b && `wrong answer: ${b}`].filter(Boolean).join('; ') };
            return { pass: true, why: 'both marked as they should be' };
        },
        golden: [j(true, 'Your answer is equivalent to the expected one.'), j(false, why)],
        mutants: [
            { name: 'accepts both', reply: [j(true, 'Correct.'), j(true, 'Correct.')] },
            { name: 'rejects both', reply: [j(false, 'Not the expected answer.'), j(false, why)] },
            { name: 'swapped verdicts', reply: [j(false, 'Not the expected answer.'), j(true, 'Correct.')] },
            { name: 'unsure about the unusual one', reply: [j('unsure', 'Could be read either way.'), j(false, why)] },
            { name: 'no JSON at all', reply: ['Looks right.', 'Looks wrong.'] },
        ],
    };
}

const cases = [
    pair({
        id: 'grade-derivative-x-to-the-x',
        q: 'Differentiate f(x) = x^x for x > 0.',
        key: "f'(x) = x^x (ln x + 1)",
        right: 'e^(x ln x) · (1 + ln x)',
        wrong: 'x^x · ln x',
        why: 'The derivative of x ln x is ln x + 1, so the factor is ln x + 1, not ln x alone.',
    }),
    pair({
        id: 'grade-integral-constant',
        q: 'Find the indefinite integral of 1/(2x) with respect to x, for x > 0.',
        key: '½ ln x + C',
        right: '½ ln(2x) + C',
        wrong: 'ln(2x) + C',
        why: 'The derivative of ln(2x) is 1/x, not 1/(2x); the factor ½ is missing.',
    }),
    pair({
        id: 'grade-five-heads',
        q: 'A fair coin is tossed 10 times. What is the probability of getting exactly 5 heads?',
        key: 'C(10,5)/2^10 = 252/1024 ≈ 0.246',
        right: '63/256',
        wrong: '252/512',
        why: 'There are 2^10 = 1024 equally likely outcomes, not 512, so the probability is 252/1024 ≈ 0.246.',
    }),
    pair({
        id: 'grade-nl-inversion-dt',
        q: 'Waarom schrijf je "hij wordt" met dt, maar "word je" zonder t?',
        key: 'Bij inversie, als je/jij achter de persoonsvorm staat, valt de t weg; "hij" krijgt altijd stam + t.',
        right: 'Staat jij of je na het werkwoord, dan schrijf je alleen de stam; bij hij is het altijd de stam met een t erachter.',
        wrong: 'Bij "je" valt de t altijd weg, ook als "je" vóór het werkwoord staat.',
        why: 'Vóór het werkwoord krijgt je/jij wel een t ("je wordt"); de t valt alleen weg als je/jij achter de persoonsvorm staat.',
    }),
    pair({
        id: 'grade-ru-double-s',
        q: 'Почему в слове «рассказ» пишутся две буквы «с»?',
        key: 'Приставка рас- оканчивается на «с», а корень -сказ- начинается на «с», поэтому на стыке две «с».',
        right: 'Одна «с» от приставки раз-/рас-, вторая от корня «сказ».',
        wrong: 'Приставка рас- сама по себе всегда пишется с двумя «с», как в слове «расстелить».',
        why: 'Приставка рас- пишется с одной «с»; вторая «с» принадлежит корню (рас-сказ, рас-стелить).',
    }),
    pair({
        id: 'grade-uk-u-v-alternation',
        q: 'Коли в українській мові пишемо прийменник «у», а коли «в»?',
        key: 'Для милозвучності: між приголосними або після приголосного перед приголосним — «у»; між голосними — «в».',
        right: 'Щоб не збігалися приголосні: після приголосного і перед приголосним ставимо «у», а коли довкола голосні, то «в».',
        wrong: '«У» ставимо між голосними, а «в» — між приголосними.',
        why: 'Навпаки: «в» між голосними, «у» між приголосними (була в Києві, брат у Львові).',
    }),
    pair({
        id: 'grade-base-rate',
        q: 'A test for a disease is 99% sensitive and 99% specific, and 1 person in 1000 has the disease. A random person tests positive. Roughly how likely is it that they have the disease?',
        key: 'About 9% (0.99 × 0.001 / (0.99 × 0.001 + 0.01 × 0.999) ≈ 0.09)',
        right: 'Roughly 1 in 11.',
        wrong: 'About 0.9%.',
        why: 'True positives 0.00099 against false positives 0.00999 give about 0.09, which is 9%, not 0.9%.',
    }),
    pair({
        id: 'grade-code-unique',
        q: 'Write a JavaScript function unique(xs) that returns the distinct values of the array xs in the order they first appear. Example: unique([3, 1, 3, 2, 1]) returns [3, 1, 2].',
        key: 'function unique(xs) {\n    return [...new Set(xs)];\n}',
        right: 'function unique(xs) {\n    const seen = new Map();\n    for (const x of xs) if (!seen.has(x)) seen.set(x, true);\n    return [...seen.keys()];\n}',
        wrong: 'function unique(xs) {\n    return xs.filter((x, i) => xs.lastIndexOf(x) === i);\n}',
        why: 'lastIndexOf keeps the last copy of each value, so the example returns [3, 2, 1], not [3, 1, 2].',
        format: 'code',
        language: 'javascript',
    }),
];

/** A key under 10 characters would let the quick accept answer before the model. */
function setup() {
    const short = cases.find(c => c.run && c.key && c.key.length < 10);
    if (short) throw new Error(`${short.id}: key under 10 characters`);
    return {};
}

export default { category: 'grading', label: 'Grading pairs: right but unusual, wrong but familiar', setup, cases };
