/**
 * Marking written work where the marking rules decide (paper.js
 * gradeTranscription, AI_PROMPTS.paper_grade). Every case is one of the rules
 * a lenient or a strict marker gets wrong:
 *   - a correct method the reference did not use still earns its point;
 *   - right answers with no working earn the answer points only;
 *   - working written under the wrong part earns nothing for the part asked;
 *   - half of an answer (the vertex's x without its y) is not the answer;
 *   - an error carried correctly through later steps costs only the steps it
 *     made wrong;
 *   - a page that answers a different question is not an attempt.
 * The app builds the grade from the authored rubric and the per-point `met`
 * values, so the score compares that vector with the one expected answer.
 * Each expected vector follows from the prompt's own rules, not from taste.
 *
 * The exercises pass validatePaperExercise, the app's gate for a stored
 * exercise. Their numbers: x² − 5x + 6 = (x − 2)(x − 3); x² − 4x + 1 has roots
 * 2 ± √3 and vertex (2, −3); 80 → 60 → 54 euros against 52 at 35 %; from rest
 * to 24 m/s in 8 s is 3 m/s² and 96 m, and the carried slip a = 4 gives 128 m.
 */
const QUADRATICS = {
    mode: 'document',
    brief: '(a) Solve x² − 5x + 6 = 0.\n(b) Find the coordinates of the vertex of the parabola y = x² − 4x + 1.\nShow your working for both parts.',
    materials: 'Pen and paper',
    rubric: [
        { id: 'r1', point: '(a) Factorises x² − 5x + 6 or applies the quadratic formula correctly, with the working shown.', weight: 2 },
        { id: 'r2', point: '(a) States both solutions, x = 2 and x = 3.', weight: 1 },
        { id: 'r3', point: '(b) Shows a valid method that finds the x-coordinate of the vertex (for example x = −b/(2a) or completing the square).', weight: 2 },
        { id: 'r4', point: '(b) States the vertex as (2, −3).', weight: 1 },
    ],
    reference_solution: '(a) x² − 5x + 6 = (x − 2)(x − 3) = 0, so x = 2 or x = 3.\n(b) x = −b/(2a) = 4/2 = 2, and y = 4 − 8 + 1 = −3, so the vertex is (2, −3).',
};

const DISCOUNT_NL = {
    mode: 'document',
    brief: 'Een jas kost €80. In de uitverkoop gaat er eerst 25% af en daarna nog eens 10% van de nieuwe prijs. Bereken wat je betaalt. Is dat hetzelfde als in één keer 35% korting? Leg uit waarom wel of niet.',
    materials: 'Pen en papier',
    rubric: [
        { id: 'r1', point: 'Berekent de prijs na 25% korting: €60.', weight: 1 },
        { id: 'r2', point: 'Berekent 10% korting op die nieuwe prijs en komt op €54.', weight: 1 },
        { id: 'r3', point: 'Berekent de prijs bij 35% korting (€52) en concludeert dat het niet hetzelfde is.', weight: 1 },
        { id: 'r4', point: 'Legt uit waarom: de tweede korting wordt berekend over een lager bedrag dan €80.', weight: 2 },
    ],
    reference_solution: '80 − 25% = 80 × 0,75 = €60. 60 − 10% = 60 × 0,9 = €54. Bij 35% korting: 80 × 0,65 = €52. Niet hetzelfde: de 10% gaat van €60 af en niet van €80, dus die korting is maar €6 in plaats van €8.',
};

const CAR = {
    mode: 'document',
    brief: 'A car accelerates uniformly from rest to 24 m/s in 8 s. (a) Find its acceleration. (b) Find the distance it covers in those 8 s. Show your working.',
    materials: 'Pen and paper',
    rubric: [
        { id: 'r1', point: '(a) Uses a = Δv / t (or v = u + a·t) to find the acceleration.', weight: 2 },
        { id: 'r2', point: '(a) The acceleration works out to 3 m/s².', weight: 1 },
        { id: 'r3', point: '(b) Uses s = ½·a·t² (or the average speed times the time, or v² = u² + 2·a·s) to find the distance.', weight: 2 },
        { id: 'r4', point: '(b) The distance works out to 96 m.', weight: 1 },
    ],
    reference_solution: '(a) a = Δv / t = 24 / 8 = 3 m/s².\n(b) s = ½·a·t² = ½ × 3 × 64 = 96 m (or average speed 12 m/s × 8 s = 96 m).',
};

export async function setup(app) {
    const { validatePaperExercise } = await app.server('paper.js');
    const { getLanguage, driftedToEnglish } = await app.server('language.js');
    const quad = validatePaperExercise(QUADRATICS);
    const discount = validatePaperExercise(DISCOUNT_NL);
    const car = validatePaperExercise(CAR);
    if (!quad || !discount || !car) throw new Error('a paper fixture no longer passes validatePaperExercise');
    return { quad, discount, car, nl: getLanguage('nl'), driftedToEnglish };
}

const bits = (met) => met.map(m => (m ? 1 : 0)).join('');

const reply = (met, { readable = true, feedback = 'Feedback.' } = {}) => JSON.stringify({
    readable,
    rubric_results: readable ? met.map((m, i) => ({ id: `r${i + 1}`, met: m, comment: m ? 'Shown.' : 'Not shown.' })) : [],
    feedback,
    next_action: 'Redo the part you missed.',
});

/** The grade's per-point `met` vector must be exactly `want`. */
const vector = (want, extra = () => null) => (grade, fx) => {
    if (!grade) return { pass: false, why: 'no usable grade' };
    if (grade.readable === false && want.some(Boolean)) return { pass: false, why: 'page called unreadable, so nothing would be recorded' };
    const got = grade.results.map(r => r.met);
    if (got.length !== want.length || got.some((m, i) => m !== want[i])) return { pass: false, why: `met ${bits(got)}, wanted ${bits(want)}` };
    const problem = extra(grade, fx);
    return problem ? { pass: false, why: problem } : { pass: true, why: `met ${bits(got)} as expected` };
};

/** Every one-point flip of the expected vector, plus all met and none met. */
function wrongVectors(want) {
    const out = want.map((m, i) => ({ name: `point ${i + 1} flipped`, reply: reply(want.map((x, k) => (k === i ? !x : x))) }));
    if (want.some(m => !m)) out.push({ name: 'awards everything', reply: reply(want.map(() => true)) });
    if (want.some(Boolean)) out.push({ name: 'awards nothing', reply: reply(want.map(() => false)) });
    out.push({ name: 'no JSON at all', reply: 'Good effort overall.' });
    return out;
}

function mark(id, exercise, transcription, want, { lang, extra, golden } = {}) {
    return {
        id,
        run: (fx, app) => app.server('paper.js').then(m => m.gradeTranscription(fx[exercise], transcription, lang ? { lang: fx[lang] } : {})),
        score: vector(want, extra),
        golden: golden || reply(want),
        mutants: wrongVectors(want),
    };
}

const QUAD_OTHER_METHODS = '(a) x = (5 ± √(25 − 24)) / 2 = (5 ± 1) / 2, so x = 3 or x = 2.\n\n(b) The roots of x² − 4x + 1 = 0 are x = (4 ± √12) / 2 = 2 ± √3. The parabola is symmetric, so the vertex lies halfway between the roots: x = 2. Then y = 2² − 4·2 + 1 = −3.\nVertex: (2, −3).';

const QUAD_WRONG_PLACE = '(a) x² − 5x + 6 = (x − 2)(x − 3) = 0, so x = 2 or x = 3.\nAlso y = x² − 4x + 1 = (x − 2)² − 3, so its lowest point is at (2, −3).\n\n(b) I did not have time for this one.';

const QUAD_ANSWERS_ONLY = '(a) x = 2 and x = 3\n(b) (2, −3)';

const QUAD_HALF_VERTEX = '(a) x² − 5x + 6 = (x − 2)(x − 3) = 0, so x = 2 or x = 3.\n\n(b) The vertex is at x = −b / (2a) = 4 / 2 = 2.\nSo the vertex is at x = 2.';

const DISCOUNT_NO_REASON = '€80 − 25% = €60\n€60 − 10% = €54\n€80 − 35% = €52\nDus het is niet hetzelfde, want €54 is meer dan €52.';

// The method and the slip sit on separate lines: the prompt forbids citing one
// line both as a met point and as another point's error.
const CAR_CARRIED_SLIP = '(a) a = Δv / t\nΔv = 24 − 0 = 24 m/s and t = 8 s\na = 24 / 8 = 4 m/s²\n\n(b) s = ½ a t²\ns = ½ × 4 × 8² = 2 × 64 = 128 m';

const CAR_OTHER_QUESTION = 'A ball is thrown straight up at 20 m/s, g = 10 m/s².\nTime to the top: t = v / g = 20 / 10 = 2 s.\nMaximum height: h = v² / (2g) = 400 / 20 = 20 m.';

export default {
    category: 'paper',
    label: 'Marking written work by the rules',
    setup,
    cases: [
        mark('paper-hard-other-valid-methods', 'quad', QUAD_OTHER_METHODS, [true, true, true, true]),
        mark('paper-hard-working-under-wrong-part', 'quad', QUAD_WRONG_PLACE, [true, true, false, false]),
        mark('paper-hard-answers-without-working', 'quad', QUAD_ANSWERS_ONLY, [false, true, false, true]),
        mark('paper-hard-vertex-half-given', 'quad', QUAD_HALF_VERTEX, [true, true, true, false]),
        mark('paper-hard-nl-no-explanation', 'discount', DISCOUNT_NO_REASON, [true, true, true, false], {
            lang: 'nl',
            extra: (grade, fx) => {
                const text = [grade.feedback, grade.nextAction, ...grade.results.map(r => r.comment)].join(' ');
                return fx.driftedToEnglish(text, fx.nl) ? 'the comments are in English, not Dutch' : null;
            },
        }),
        mark('paper-hard-carried-slip', 'car', CAR_CARRIED_SLIP, [true, false, true, false]),
        {
            ...mark('paper-hard-answers-another-question', 'car', CAR_OTHER_QUESTION, [false, false, false, false]),
            // The app fills a point the reply never mentions as not met, so the
            // model must say so: the page is no attempt at this task, or it
            // comments on every point.
            score: vector([false, false, false, false], (grade) => (grade.readable === false || grade.results.every(r => r.comment)
                ? null : 'no verdict on the page: neither unreadable nor a comment on each point')),
            golden: reply([false, false, false, false], { readable: false, feedback: 'This page answers a question about a ball thrown upwards, not the accelerating car.' }),
        },
    ],
};
