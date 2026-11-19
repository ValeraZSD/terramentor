/**
 * Marking written work (paper.js gradeTranscription). A learner's handwritten
 * page is read into words, then one call rules on each rubric point
 * (AI_PROMPTS.paper_grade). The app builds the grade from the AUTHORED rubric
 * (normalizeGrade): a point is met only when the reply carries that point's id
 * with `met: true`, and the score is counted by the app, never taken from the
 * model. The scorer therefore compares the per-point `met` vector to the one
 * expected answer; no point below is borderline.
 *
 * The exercises pass through validatePaperExercise, the app's own gate for a
 * model-authored exercise, so they have exactly the shape the app stores.
 *
 * `gradeTranscription` returns null when the reply cannot be read (after two
 * tries); that is a failure here whichever vector was expected.
 *
 * The Dutch case also checks the language of the learner-facing text with
 * `driftedToEnglish`. That is a proxy (a count of English function words in at
 * least 60 words of prose), so a very short reply escapes it; the rubric vector
 * is what carries the case.
 */
// Server modules are loaded through `app.server` in setup, never imported at
// the top: the library path is fixed by the first server import.

const FALL = {
    mode: 'document',
    brief: 'A ball is dropped from rest from a height of 20 m above the ground. Take g = 10 m/s² and ignore air resistance. Find how long the ball takes to reach the ground and the speed with which it hits it. Show your working.',
    materials: 'Pen and paper',
    rubric: [
        { id: 'r1', point: 'Uses h = ½·g·t² (or an equivalent equation of motion) to relate the height to the fall time.', weight: 2 },
        { id: 'r2', point: 'The fall time works out to the value 2 (the unit is judged separately).', weight: 1 },
        { id: 'r3', point: 'Uses v = g·t (or v² = 2·g·h) to find the impact speed.', weight: 2 },
        { id: 'r4', point: 'The impact speed works out to the value 20 (the unit is judged separately).', weight: 1 },
        { id: 'r5', point: 'Writes the right unit with each final answer: seconds for the time and m/s for the speed.', weight: 1 },
    ],
    reference_solution: 'From h = ½·g·t²: 20 = 5·t², so t² = 4 and t = 2 s. The speed at impact is v = g·t = 10 × 2 = 20 m/s.',
};

const SPEED_NL = {
    mode: 'document',
    brief: 'Een auto rijdt eerst 2 uur met een constante snelheid van 90 km/u en daarna 1 uur met 60 km/u. Bereken de gemiddelde snelheid over de hele rit. Schrijf je berekening op.',
    materials: 'Pen en papier',
    rubric: [
        { id: 'r1', point: 'Berekent de afstand van het eerste deel: 90 × 2 = 180 km.', weight: 1 },
        { id: 'r2', point: 'Berekent de afstand van het tweede deel: 60 × 1 = 60 km.', weight: 1 },
        { id: 'r3', point: 'Telt de afstanden op tot 240 km en de tijden tot 3 uur.', weight: 1 },
        { id: 'r4', point: 'Deelt de totale afstand door de totale tijd (niet het gemiddelde van 90 en 60).', weight: 2 },
        { id: 'r5', point: 'Komt uit op 80 km/u, met eenheid.', weight: 1 },
    ],
    reference_solution: 'Afstand: 90 × 2 = 180 km en 60 × 1 = 60 km, samen 240 km. Tijd: 2 + 1 = 3 uur. Gemiddelde snelheid = 240 / 3 = 80 km/u.',
};

export async function setup(app) {
    const { validatePaperExercise } = await app.server('paper.js');
    const { getLanguage, driftedToEnglish } = await app.server('language.js');
    const fall = validatePaperExercise(FALL);
    const speed = validatePaperExercise(SPEED_NL);
    if (!fall || !speed) throw new Error('a paper fixture no longer passes validatePaperExercise');
    return { fall, speed, nl: getLanguage('nl'), driftedToEnglish };
}

const ALL = [true, true, true, true, true];

const reply = (met, { comments = null, feedback = 'Feedback.', readable = true } = {}) => JSON.stringify({
    readable,
    rubric_results: readable ? met.map((m, i) => ({ id: `r${i + 1}`, met: m, comment: comments?.[i] ?? (m ? 'Done.' : 'Not shown.') })) : [],
    feedback,
    next_action: 'Check your units on each final answer.',
});

/** The scorer: the grade's per-point `met` vector must be exactly `want`. */
const vector = (want, extra = () => null) => (grade, fx) => {
    if (!grade) return { pass: false, why: 'no usable grade' };
    // The photo route records nothing for a page the marker calls unreadable,
    // so a grade that awards points must also say the page was readable.
    if (grade.readable === false && want.some(Boolean)) return { pass: false, why: 'page called unreadable, so nothing would be recorded' };
    const got = grade.results.map(r => r.met);
    if (got.length !== want.length || got.some((m, i) => m !== want[i])) {
        return { pass: false, why: `met ${got.map(m => (m ? 1 : 0)).join('')}, wanted ${want.map(m => (m ? 1 : 0)).join('')}` };
    }
    const problem = extra(grade, fx);
    return problem ? { pass: false, why: problem } : { pass: true, why: `met ${got.map(m => (m ? 1 : 0)).join('')} as expected` };
};

const none = [false, false, false, false, false];

// The shared transcription of the attempt that is right in every respect.
const FULL_ATTEMPT = 'h = 20 m, g = 10 m/s².\nFalling from rest: h = ½ g t²\n20 = 5 t²\nt² = 4\nt = 2 s\n\nSpeed at impact: v = g t = 10 × 2 = 20 m/s.\n\nAnswer: the ball lands after 2 s and hits the ground at 20 m/s.';

// The same working with no unit written anywhere.
const NO_UNITS_ATTEMPT = 'h = 20, g = 10.\nh = ½ g t²\n20 = ½ × 10 × t²\n20 = 5 t²\nt² = 4\nt = 2\n\nv = g t = 10 × 2 = 20\n\nAnswer: t = 2 and v = 20.';

const NL_ATTEMPT = 'Eerste deel: 90 × 2 = 180 km.\nTweede deel: 60 × 1 = 60 km.\nTotale afstand: 180 + 60 = 240 km.\nTotale tijd: 2 + 1 = 3 uur.\nGemiddelde snelheid = totale afstand / totale tijd = 240 / 3 = 80 km/u.\n\nAntwoord: 80 km/u.';

export default {
    category: 'paper',
    label: 'Marking written work',
    setup,
    cases: [
        {
            id: 'paper-fall-complete-all-met',
            run: (fx, app) => app.server('paper.js').then(m => m.gradeTranscription(fx.fall, FULL_ATTEMPT)),
            score: vector(ALL),
            golden: reply(ALL, { feedback: 'You used h = ½gt² to get t = 2 s and v = gt to get 20 m/s, with units on both answers.' }),
            mutants: [
                { name: 'misses the speed point', reply: reply([true, true, true, false, true]) },
                { name: 'marks nothing met', reply: reply(none) },
                { name: 'wrong ids, so no point matches', reply: JSON.stringify({ readable: true, rubric_results: ALL.map((m, i) => ({ id: `point${i + 1}`, met: m, comment: 'ok' })), feedback: 'Fine.', next_action: 'None.' }) },
                { name: 'no JSON at all', reply: 'Everything on the page is correct.' },
                { name: 'marks every point but calls the page unreadable', reply: JSON.stringify({ readable: false, rubric_results: ALL.map((m, i) => ({ id: `r${i + 1}`, met: m, comment: 'Done.' })), feedback: 'Fine.', next_action: 'None.' }) },
            ],
        },
        {
            id: 'paper-fall-units-missing-one-point',
            run: (fx, app) => app.server('paper.js').then(m => m.gradeTranscription(fx.fall, NO_UNITS_ATTEMPT)),
            score: vector([true, true, true, true, false]),
            golden: reply([true, true, true, true, false], {
                comments: ['You start from h = ½gt².', 'You get t = 2.', 'You use v = gt.', 'You get v = 20.', 'You wrote t = 2 and v = 20 but no units.'],
                feedback: 'Your method and both values are right. The one thing missing is the unit on each answer: seconds for the time and m/s for the speed.',
            }),
            mutants: [
                { name: 'gives the unit point anyway', reply: reply(ALL) },
                { name: 'marks a different point missing', reply: reply([true, false, true, true, true]) },
                { name: 'marks nothing met', reply: reply(none) },
                { name: 'no JSON at all', reply: 'Nearly everything is right, only the units are left out.' },
            ],
        },
        {
            id: 'paper-blank-page-none-met',
            run: (fx, app) => app.server('paper.js').then(m => m.gradeTranscription(fx.fall, 'Shopping list: milk, eggs, bread, apples, coffee.')),
            // The app fills a point the reply never mentions as not met, so
            // "nothing met" alone would pass any reply that marks nothing. The
            // model must say so: the page is unreadable as an attempt, or it
            // comments on every point.
            score: vector(none, (grade) => (grade.readable === false || grade.results.every(r => r.comment)
                ? null : 'no verdict on the page: neither unreadable nor a comment on each point')),
            golden: reply(none, { readable: false, feedback: 'The page is a shopping list, not an attempt at the falling ball, so there is nothing to mark.' }),
            mutants: [
                { name: 'a reply that marks nothing at all', reply: JSON.stringify({ verdict: 'correct' }) },
                { name: 'invents a grade from nothing', reply: reply(ALL) },
                { name: 'gives the first two points as a kindness', reply: reply([true, true, false, false, false]) },
                { name: 'gives the unit point', reply: reply([false, false, false, false, true]) },
                { name: 'no JSON at all', reply: 'There is nothing to mark on this page.' },
            ],
        },
        {
            id: 'paper-nl-average-speed-all-met',
            run: (fx, app) => app.server('paper.js').then(m => m.gradeTranscription(fx.speed, NL_ATTEMPT, { lang: fx.nl })),
            score: vector(ALL, (grade, fx) => {
                const text = [grade.feedback, grade.nextAction, ...grade.results.map(r => r.comment)].join(' ');
                return fx.driftedToEnglish(text, fx.nl) ? 'the comments are in English, not Dutch' : null;
            }),
            golden: reply(ALL, {
                comments: [
                    'Je rekent het eerste deel goed uit: 90 × 2 = 180 km.',
                    'Het tweede deel klopt ook: 60 × 1 = 60 km.',
                    'Je telt de afstanden en de tijden goed op tot 240 km en 3 uur.',
                    'Je deelt de totale afstand door de totale tijd, en neemt dus niet het gemiddelde van 90 en 60.',
                    'Je komt uit op 80 km/u en schrijft de eenheid erbij.',
                ],
                feedback: 'Je hebt alle stappen laten zien en het juiste antwoord gevonden. Het is slim dat je de afstanden en de tijden eerst optelt, want de gemiddelde snelheid is de totale afstand gedeeld door de totale tijd.',
            }),
            mutants: [
                { name: 'accepts only the answer, not the method', reply: reply([false, false, false, false, true]) },
                { name: 'marks the average-of-averages point missing', reply: reply([true, true, true, false, true]) },
                {
                    name: 'right marks but written in English',
                    reply: reply(ALL, {
                        comments: [
                            'You work out the first part correctly as 90 times 2, which is 180 km.',
                            'The second part is also right, because 60 times 1 is 60 km.',
                            'You add the distances and the times together to get 240 km and 3 hours.',
                            'You divide the total distance by the total time and do not take the average of the two speeds.',
                            'You reach 80 km/h and you write the unit after it.',
                        ],
                        feedback: 'You have shown all of the steps and you found the right answer. It is a good idea that you add up the distances and the times first, because the average speed is the total distance divided by the total time.',
                    }),
                },
                { name: 'no JSON at all', reply: 'Alles klopt.' },
            ],
        },
    ],
};
