/**
 * Marking explain-back (lessonPrompts.js markExplanation). After a lesson part
 * the learner puts it in their own words; one call marks that against the
 * part's own text (AI_PROMPTS.explain_back) as "good" or "weak". "unsure" is the
 * prompt's answer for text too short or off-topic to judge, so every case here
 * is on-topic and long enough that one verdict is right, and "unsure" fails.
 *
 * The prompt says "ignore spelling, grammar and language", so a good account in
 * another language than the lesson is "good". A weak one is either on the topic
 * but without the main idea (a fact from around the subject), or asserts the
 * opposite of what the part says.
 */
const verdict = (v, reason) => JSON.stringify({ verdict: v, reason });

const LESSONS = [
    {
        key: 'vaccine', lang: 'en', topic: 'Vaccines', partTitle: 'How a vaccine trains the immune system',
        content: `A vaccine does not cure anything and does not fight a germ itself. It shows the immune system a harmless sample of the germ, such as a weakened or killed form or just one protein from its surface, so that the body can practise.

The immune system answers the sample as it would an infection: it makes **antibodies** that fit the germ's surface, and it keeps **memory cells** that remember it for years.

Later, when the real germ arrives, the memory cells recognise it at once. The body makes antibodies in hours instead of days, and usually clears the germ before it makes you ill.`,
    },
    {
        key: 'osmosis', lang: 'en', topic: 'Osmosis', partTitle: 'Which way the water moves',
        content: `Osmosis is the movement of water through a semipermeable membrane, a barrier that lets water pass but holds back most dissolved particles.

Water moves from the side where the solution is more dilute (less dissolved solute) to the side where it is more concentrated (more dissolved solute). The movement goes on until the two sides are equal or the pressure on the concentrated side stops it.

That is why a raisin dropped in pure water swells: the water outside is more dilute than the inside of the raisin, so water flows in.`,
    },
    {
        key: 'binary', lang: 'en', topic: 'Binary search', partTitle: 'Halving the search range',
        content: `Binary search finds a value in a **sorted** array. It compares the target with the middle element. If the target is smaller, the whole upper half is thrown away; if it is larger, the lower half is. Then it repeats on the half that is left.

Each comparison halves the range, so an array of one million items needs about 20 comparisons at most, and the cost grows as log n. On an array that is not sorted the halving rule is meaningless and the method can miss the target.`,
    },
    {
        key: 'fotosynthese', lang: 'nl', topic: 'Fotosynthese', partTitle: 'Hoe een blad suiker maakt',
        content: `In de bladeren zit bladgroen (chlorofyl). Dat vangt zonlicht op. Met de energie van dat licht maakt het blad suiker uit twee grondstoffen: koolstofdioxide uit de lucht en water uit de bodem.

Bij dit proces komt zuurstof vrij, dat via kleine openingen in het blad naar buiten gaat. De suiker is brandstof voor de plant en wordt ook opgeslagen, bijvoorbeeld in knollen en zaden.`,
    },
];

export async function setup(app) {
    const { db } = app;
    const fx = {};
    for (const l of LESSONS) {
        const project = db.prepare('INSERT INTO projects (name, content_language) VALUES (?, ?)').run(`Explain-back bench: ${l.topic}`, l.lang).lastInsertRowid;
        const node = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, 0)').run(project, l.topic).lastInsertRowid;
        fx[l.key] = db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'lesson', 1, ?, ?, 'ready')")
            .run(node, l.content, JSON.stringify({ partTitle: l.partTitle, partIndex: 1 })).lastInsertRowid;
    }
    return fx;
}

const wantVerdict = (want) => (r) => {
    if (!r || typeof r !== 'object') return { pass: false, why: 'no result' };
    if (r.verdict === want) return { pass: true, why: `marked ${want}` };
    return { pass: false, why: `marked ${r.verdict}, wanted ${want}` };
};

/** Mutants every case shares: a marker that gives no usable verdict. */
const silent = [
    { name: 'unsure', reply: verdict('unsure', 'You wrote too little for me to judge either way.') },
    { name: 'no JSON at all', reply: 'This explanation seems fine to me.' },
    { name: 'echoes the template', reply: verdict('good | weak | unsure', '...') },
];

function good(id, lesson, explanation, goldenReason) {
    return {
        id,
        run: (fx, app) => app.server('lessonPrompts.js').then(m => m.markExplanation(fx[lesson], explanation)),
        score: wantVerdict('good'),
        golden: verdict('good', goldenReason),
        mutants: [
            { name: 'marks a sound account weak', reply: verdict('weak', 'You miss the main idea of the part, so read it again.') },
            ...silent,
        ],
    };
}

function weak(id, lesson, explanation, goldenReason) {
    return {
        id,
        run: (fx, app) => app.server('lessonPrompts.js').then(m => m.markExplanation(fx[lesson], explanation)),
        score: wantVerdict('weak'),
        golden: verdict('weak', goldenReason),
        mutants: [
            { name: 'rubber-stamps it as good', reply: verdict('good', 'You state the main idea of the part correctly.') },
            ...silent,
        ],
    };
}

export default {
    category: 'explain-back',
    label: 'Marking explain-back',
    setup,
    cases: [
        good('explainback-vaccine-paraphrase-good', 'vaccine',
            'A vaccine gives your body a harmless bit of a germ so the immune system practises on it. It makes antibodies and memory cells, so when the real germ shows up later the body reacts much faster.',
            'You state the main idea: a harmless sample trains the body, which keeps antibodies and memory cells ready for the real germ. A fuller answer would say the response comes in hours instead of days.'),
        weak('explainback-vaccine-wrong-mechanism-weak', 'vaccine',
            'A vaccine is a medicine that goes into your blood and kills the germ straight away, so the germ cannot make you ill.',
            'You say the vaccine kills the germ directly, but the part says it does not fight the germ itself: it shows the immune system a harmless sample so the body can practise. Look again at the first paragraph and the antibodies and memory cells in the second.'),
        weak('explainback-vaccine-missing-mechanism-weak', 'vaccine',
            'Vaccines were first used by Edward Jenner in 1796, and today children in the Netherlands get them as part of the national programme, usually as an injection in the arm.',
            'You give facts from around the subject, but not how a vaccine works. Read the second paragraph again: the idea is that a harmless sample makes the body build antibodies and memory cells.'),
        good('explainback-nl-fotosynthese-good', 'fotosynthese',
            'Het bladgroen in het blad vangt zonlicht op. Met die energie maakt de plant suiker uit koolstofdioxide en water, en er komt zuurstof bij vrij.',
            'Je noemt de kern: bladgroen vangt licht en daarmee wordt suiker gemaakt uit koolstofdioxide en water, met zuurstof als bijproduct. Een volledig antwoord zou ook zeggen waar de suiker voor dient, namelijk brandstof en opslag.'),
        weak('explainback-osmosis-direction-reversed-weak', 'osmosis',
            'Osmosis is water moving through a semipermeable membrane, going from the side with more dissolved stuff to the side with less, until both sides are equal.',
            'You have the membrane right, but the direction is reversed: the part says water moves from the more dilute side to the more concentrated side. Look again at the second paragraph and the raisin example.'),
        good('explainback-ru-binary-search-good', 'binary',
            'Бинарный поиск работает только на отсортированном массиве: он сравнивает искомое значение со средним элементом и выбрасывает половину, где его точно нет. Так диапазон каждый раз вдвое меньше, поэтому шагов нужно порядка log n.',
            'Вы верно описали идею: сравнение со средним элементом, отбрасывание половины и условие отсортированности. Полнее было бы привести пример: для миллиона элементов хватает примерно 20 сравнений.'),
    ],
};
