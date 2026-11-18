/**
 * Writing quiz questions: the mastery-check / practice-quiz path.
 *
 * Each case rebuilds exactly what POST /api/ai/quiz does (server/routes/quizzes.js:36-39)
 * minus the second-opinion pass: buildQuizPrompt(node, 5, type), then
 * generateResponse(user, system, [], { operation: 'questions' }) with the options
 * generateMaterial passes (server/studyMaterial.js:420), then finalizeQuiz, which parses
 * the reply, normalises each question to its format, DROPS what cannot be graded
 * honestly or fails questionDefects, and throws when nothing is left. vetQuiz is not
 * called: it costs one model request per question.
 *
 * Pass: at least ceil(0.8 * 5) = 4 of the 5 requested questions survive finalizeQuiz,
 * every kept question has a requested type (a "both" request must return a mix of
 * multiple_choice and true_false), and the text is in the course's language.
 *
 * Proxy: "in the course's language" has no model-free definition, so it is measured
 * with the app's own English-drift check (server/language.js driftedToEnglish), plus a
 * function-word check for Dutch and a script/letter check for Russian and Ukrainian
 * (the Ukrainian check also rejects Russian-only letters, the usual way a model drifts).
 */
const N = 5;
const NEED = Math.ceil(0.8 * N);

// ---------------------------------------------------------------- fixtures

const COURSES = [
    {
        key: 'bio', name: 'Biology foundations', lang: 'en',
        node: {
            title: 'Photosynthesis',
            description: 'How plants turn light, water and carbon dioxide into glucose and oxygen: where it happens in the cell, what the light-dependent and light-independent stages do, and what limits the rate.',
            notes: 'Chloroplasts, thylakoids, stroma. Water is split in the light stage and gives off the oxygen. Stomata let CO2 in. Plants also respire all the time, in light and in dark.',
        },
    },
    {
        key: 'physics', name: 'Electricity and circuits', lang: 'en',
        node: {
            title: "Ohm's law and series circuits",
            description: 'Voltage, current and resistance in simple circuits. V = IR, resistors in series add up, the current is the same everywhere in a series loop, and electrical power is P = VI.',
            notes: 'Practice: find the current through one resistor, the total resistance of two in series, and the current a lamp draws from the mains (230 V).',
        },
    },
    {
        key: 'history', name: 'Modern European history', lang: 'en',
        node: {
            title: 'Causes of the First World War',
            description: 'The long-term causes (alliances, militarism, imperial rivalry, nationalism) and the July Crisis of 1914 that turned a regional murder into a continental war, including the Schlieffen Plan and Britain\'s entry.',
            notes: 'Triple Entente (France, Russia, Britain) against the Triple Alliance (Germany, Austria-Hungary, Italy). Sarajevo, 28 June 1914. Belgium\'s neutrality was guaranteed by the 1839 Treaty of London.',
        },
    },
    {
        key: 'earth', name: 'Earth science', lang: 'en',
        node: {
            title: 'Plate tectonics',
            description: 'The lithosphere is split into plates that move on the asthenosphere. Divergent, convergent and transform boundaries, where crust is made and destroyed, and why earthquakes and volcanoes cluster at plate edges.',
            notes: 'Mid-ocean ridges make new oceanic crust. Subduction zones destroy it; the denser oceanic plate sinks. The San Andreas fault is a transform boundary.',
        },
    },
    {
        key: 'cells', name: 'Cell biology', lang: 'en',
        node: {
            title: 'The cell cycle and mitosis',
            description: 'The phases of the cell cycle (G1, S, G2, M) and the four stages of mitosis (prophase, metaphase, anaphase, telophase), followed by cytokinesis. What happens to the chromosomes at each step.',
            notes: 'DNA is copied in S phase. Chromosomes condense in prophase, line up at the equator in metaphase, sister chromatids are pulled apart in anaphase, two nuclei re-form in telophase. In animal cells a contractile ring pinches the cell in two.',
        },
    },
    {
        key: 'python', name: 'Python basics', lang: 'en',
        node: {
            title: 'Lists and loops in Python',
            description: 'Creating lists, indexing from zero, len(), append(), looping with for ... in and for ... in range(), accumulating a result in a variable, and returning a value from a function.',
            notes: 'Practice writing small functions that loop over a list: totals, counts, searching for an item, building a new list. Avoid built-ins like sum() when the task asks you to do the loop yourself.',
        },
    },
    {
        key: 'nl', name: 'Aardrijkskunde: Nederland', lang: 'nl',
        node: {
            title: 'Waterbeheer in Nederland: dijken, polders en gemalen',
            description: 'Een groot deel van Nederland ligt onder zeeniveau en wordt beschermd door dijken, duinen en gemalen. Het gaat om polders, de rol van waterschappen en de Deltawerken na de Watersnoodramp van 1953.',
            notes: 'De Afsluitdijk (1932) scheidt het IJsselmeer van de Waddenzee. De Oosterscheldekering is open, maar sluit bij storm. Een gemaal pompt water uit een polder naar hoger gelegen water.',
        },
    },
    {
        key: 'ru', name: 'Физика: механика', lang: 'ru',
        node: {
            title: 'Законы Ньютона',
            description: 'Три закона динамики: закон инерции, связь силы, массы и ускорения ($F = ma$) и равенство сил действия и противодействия. Типичные задачи на силу, массу и ускорение.',
            notes: 'Первый закон: если равнодействующая сил равна нулю, скорость тела не меняется. Третий закон: силы приложены к разным телам и равны по модулю. Единица силы — ньютон (Н).',
        },
    },
];

async function setup(app) {
    const ids = {};
    const proj = app.db.prepare('INSERT INTO projects (name, description, content_language) VALUES (?, ?, ?)');
    const node = app.db.prepare('INSERT INTO nodes (project_id, title, description, notes, position) VALUES (?, ?, ?, ?, 0)');
    for (const c of COURSES) {
        const pid = proj.run(c.name, '', c.lang).lastInsertRowid;
        ids[c.key] = Number(node.run(pid, c.node.title, c.node.description, c.node.notes).lastInsertRowid);
    }
    return { ids };
}

// ---------------------------------------------------------------- scoring

const wordsOf = (s) => String(s).toLowerCase().match(/\p{L}+/gu) || [];
const stripMath = (s) => String(s).replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, ' ').replace(/`[^`\n]*`/g, ' ');

const DUTCH = new Set(['de', 'het', 'een', 'van', 'en', 'is', 'in', 'op', 'te', 'dat', 'die', 'voor', 'met', 'zijn', 'niet', 'om', 'aan', 'er', 'ook', 'als', 'dan', 'bij', 'of', 'wat', 'welke', 'hoe', 'wordt', 'naar', 'door', 'uit', 'maar', 'deze', 'dit']);

/** null when `text` reads as written in language `code`, else the reason it does not. */
async function languageProblem(app, text, code) {
    if (code === 'en') return null;
    const { getLanguage, driftedToEnglish } = await app.server('language.js');
    const prose = stripMath(text);
    // The app's drift check ignores a sample under 60 words (a short sample can be
    // dominated by one quoted term). Repeating the text keeps the ratio and clears the floor.
    let padded = prose;
    while (wordsOf(padded).length < 80 && wordsOf(prose).length) padded += ` ${prose}`;
    if (driftedToEnglish(padded, getLanguage(code))) return 'written in English, not the course language';
    const words = wordsOf(prose);
    if (!words.length) return 'no prose to judge';
    if (code === 'nl') {
        const share = words.filter(w => DUTCH.has(w)).length / words.length;
        if (share < 0.1) return `does not read as Dutch (function-word share ${share.toFixed(2)})`;
    }
    if (code === 'ru' || code === 'uk') {
        const letters = prose.match(/\p{L}/gu) || [];
        const cyr = letters.filter(ch => /[Ѐ-ӿ]/.test(ch)).length;
        if (cyr / letters.length < 0.8) return 'mostly not Cyrillic';
        if (code === 'ru' && /[іїєґ]/i.test(prose)) return 'has Ukrainian-only letters in a Russian course';
        if (code === 'uk' && /[ыэъё]/i.test(prose)) return 'has Russian-only letters in a Ukrainian course';
        if (code === 'uk' && !/[іїє]/i.test(prose)) return 'no Ukrainian letters at all';
    }
    return null;
}

const proseOf = (q) => [q.question, ...(Array.isArray(q.options) ? q.options : []), ...(Array.isArray(q.items) ? q.items : []), q.explanation].filter(Boolean).join('\n');

function quizScore({ types, mix = false, lang, code = null }) {
    return async (out, fx, app) => {
        const kept = out.kept;
        if (kept.length < NEED) return { pass: false, why: `only ${kept.length} of ${N} questions survived the app's gates (need ${NEED})` };
        const wrong = kept.filter(q => !types.includes(q.type));
        if (wrong.length) return { pass: false, why: `${wrong.length} kept question(s) are ${[...new Set(wrong.map(q => q.type))].join('/')}, not ${types.join('/')}` };
        if (mix && new Set(kept.map(q => q.type)).size < types.length) return { pass: false, why: 'a mix was asked for and only one kind came back' };
        if (code) {
            const off = kept.filter(q => q.language !== code);
            if (off.length) return { pass: false, why: `${off.length} code question(s) are not in ${code}` };
        }
        const problem = await languageProblem(app, kept.map(proseOf).join('\n'), lang);
        if (problem) return { pass: false, why: problem };
        return { pass: true, why: `${kept.length} of ${N} questions kept, types ${[...new Set(kept.map(q => q.type))].join('+')}` };
    };
}

async function runQuiz(app, nodeId, type) {
    const { buildQuizPrompt, finalizeQuiz } = await app.server('studyMaterial.js');
    const { system, user } = buildQuizPrompt(nodeId, N, type);
    const raw = await app.ai.generateResponse(user, system, [], { operation: 'questions' });
    const quiz = finalizeQuiz(nodeId, raw, false, { questionType: type });
    app.db.prepare('DELETE FROM quizzes WHERE id = ?').run(quiz.id);
    return { kept: quiz.questions };
}

// ---------------------------------------------------------------- replies

const j = (x) => JSON.stringify(x);
const mc = (question, options, correct_answer, explanation) => ({ question, type: 'multiple_choice', options, correct_answer, explanation });
const tf = (question, correct_answer, explanation) => ({ question, type: 'true_false', correct_answer, explanation });
const seq = (question, items, explanation) => ({ question, type: 'sequence', items, explanation });

/** Hand-broken variants every closed-format case shares. */
function commonMutants(G) {
    return [
        { name: 'only three questions', reply: j(G.slice(0, 3)) },
        { name: 'prose instead of JSON', reply: 'Sure! Here are five quiz questions for this topic. Question 1 asks about the main idea, question 2 about an example, and so on. Let me know if you would like harder ones.' },
        { name: 'empty explanations', reply: j(G.map(q => ({ ...q, explanation: '' }))) },
    ];
}

/** Two keys that name no option: the app drops both questions. */
const breakKeys = (G) => G.map((q, i) => (i < 2 ? { ...q, correct_answer: 'None of the above' } : q));
const asTrueFalse = (G) => G.map(q => tf(q.question.replace(/\?$/, '.'), 'True', q.explanation));

// 1. photosynthesis, a mix of multiple choice and true/false
const G_BIO = [
    mc('Which gas do plants take in from the air to use as the carbon source for photosynthesis?', ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen'], 'Carbon dioxide',
        'Carbon dioxide enters through the stomata and is built into glucose in the light-independent stage.'),
    mc('Where in the plant cell do the light-dependent reactions of photosynthesis take place?', ['In the thylakoid membranes inside the chloroplast', 'In the nucleus', 'In the cell wall', 'In the matrix of the mitochondrion'], 'In the thylakoid membranes inside the chloroplast',
        'Chlorophyll sits in the thylakoid membranes, which is where light energy is captured.'),
    mc('A plant sits in bright light, but a drought makes its stomata close. What is the most direct effect on photosynthesis?', ['Less carbon dioxide reaches the leaf cells, so the rate falls', 'More oxygen is made because less water is lost', 'The chlorophyll absorbs less light, so the stomata reopen', 'Glucose is no longer needed, so the light stage speeds up'], 'Less carbon dioxide reaches the leaf cells, so the rate falls',
        'Closed stomata cut off the carbon dioxide supply, which limits the light-independent stage even in bright light.'),
    tf('The oxygen released during photosynthesis comes from the splitting of water molecules, not from carbon dioxide.', 'True',
        'Water is split in the light-dependent stage, and the oxygen atoms end up in O2; the carbon dioxide oxygen ends up in glucose and water.'),
    tf('Plants respire only at night and photosynthesise only during the day.', 'False',
        'Plants respire all the time; in daylight photosynthesis is simply faster than respiration.'),
];

// 2. Ohm's law, multiple choice
const G_PHYS = [
    mc('A 12 V battery is connected across a single 4 Ω resistor. What current flows through it?', ['3 A', '48 A', '0.33 A', '8 A'], '3 A',
        'By Ohm\'s law $I = V/R = 12/4 = 3\\ \\text{A}$.'),
    mc('Two resistors of 6 Ω and 3 Ω are connected in series. What is the total resistance?', ['9 Ω', '2 Ω', '18 Ω', '4.5 Ω'], '9 Ω',
        'Resistances in series add: $6 + 3 = 9\\ \\Omega$. The 2 Ω answer is the parallel value.'),
    mc('A 2 Ω and a 6 Ω resistor are in one series loop. How does the voltage across the 6 Ω resistor compare with that across the 2 Ω resistor?', ['Three times as large', 'One third as large', 'The same', 'Six times as large'], 'Three times as large',
        'The same current flows through both, so $V = IR$ is proportional to the resistance: 6 Ω is three times 2 Ω.'),
    mc('The voltage across a fixed ohmic resistor is doubled. What happens to the current through it?', ['It doubles', 'It halves', 'It stays the same', 'It quadruples'], 'It doubles',
        'For a fixed resistance $I = V/R$, so current is proportional to voltage.'),
    mc('A 60 W lamp is connected to a 230 V supply. About what current does it draw?', ['0.26 A', '3.8 A', '13 800 A', '0.017 A'], '0.26 A',
        'From $P = VI$, $I = 60/230 \\approx 0.26\\ \\text{A}$. The 3.8 A answer comes from dividing the wrong way round.'),
];

// 3. causes of the First World War, multiple choice
const G_HIST = [
    mc('Which event on 28 June 1914 is generally seen as the immediate trigger of the First World War?', ['The assassination of Archduke Franz Ferdinand in Sarajevo', 'The sinking of the Lusitania', 'Germany\'s invasion of Belgium', 'The signing of the Treaty of Versailles'], 'The assassination of Archduke Franz Ferdinand in Sarajevo',
        'The murder in Sarajevo set off the July Crisis; the other events came later in or after the war.'),
    mc('Which two alliance blocs faced each other in Europe in 1914?', ['The Triple Entente and the Triple Alliance', 'NATO and the Warsaw Pact', 'The Allies and the Axis', 'The Holy Alliance and the Concert of Europe'], 'The Triple Entente and the Triple Alliance',
        'France, Russia and Britain formed the Entente; Germany, Austria-Hungary and Italy the Triple Alliance. The other pairs belong to other eras.'),
    mc('To get around France\'s fortified border, the Schlieffen Plan sent the German armies through which neutral country?', ['Belgium', 'Switzerland', 'Spain', 'Denmark'], 'Belgium',
        'The plan aimed to defeat France quickly by marching through Belgium before turning on Russia.'),
    mc('Britain declared war on Germany in August 1914 mainly because Germany had', ['violated Belgian neutrality, which Britain had guaranteed', 'attacked British merchant ships in the Atlantic', 'declared war on the British Empire over colonial claims', 'occupied the Suez Canal'], 'violated Belgian neutrality, which Britain had guaranteed',
        'Britain had guaranteed Belgium\'s neutrality in 1839, and the invasion gave the government its reason to enter the war.'),
    mc('Which term describes the rapid build-up of armies and navies by the great powers in the years before 1914?', ['Militarism', 'Isolationism', 'Mercantilism', 'Appeasement'], 'Militarism',
        'Militarism, along with alliances, imperial rivalry and nationalism, is one of the long-term causes of the war.'),
];

// 4. plate tectonics, true/false
const G_EARTH = [
    tf('The Earth\'s lithosphere is broken into plates that move slowly over the softer asthenosphere beneath.', 'True',
        'Plates are rigid pieces of lithosphere carried along on the weaker, slowly flowing asthenosphere.'),
    tf('New oceanic crust is destroyed at mid-ocean ridges.', 'False',
        'Mid-ocean ridges are where new oceanic crust is made; it is destroyed at subduction zones.'),
    tf('At a transform boundary two plates slide past each other, and crust is neither made nor destroyed in large amounts.', 'True',
        'The San Andreas fault is the standard example: the plates grind sideways and cause earthquakes.'),
    tf('Most earthquakes and volcanoes occur in the middle of plates, far from their edges.', 'False',
        'They cluster along plate boundaries, where plates collide, separate or slide past each other.'),
    tf('At a subduction zone the denser oceanic plate usually sinks beneath the lighter continental plate.', 'True',
        'Oceanic crust is denser than continental crust, so it is the one that descends into the mantle.'),
];

// 5. the cell cycle and mitosis, ordering questions
const G_CELLS = [
    seq('Put the phases of the cell cycle in the order a dividing cell passes through them.', ['G1 (the cell grows)', 'S (DNA is copied)', 'G2 (the cell prepares to divide)', 'M (mitosis and cytokinesis)'],
        'The cycle runs G1, S, G2, M; DNA is only copied in S.'),
    seq('Arrange the stages of mitosis from first to last.', ['Prophase', 'Metaphase', 'Anaphase', 'Telophase'],
        'Chromosomes condense, line up, separate and are enclosed in two new nuclei, in that order.'),
    seq('Order these events in the life of one chromosome during a division.', ['The chromosome is copied into two sister chromatids', 'The chromatids condense into compact rods', 'The chromatids line up along the cell equator', 'The chromatids are pulled to opposite poles'],
        'Copying comes first, then condensing, lining up and finally separation.'),
    seq('Put these interphase events in the order they happen.', ['The cell grows and makes proteins', 'The DNA is replicated', 'The cell checks the copied DNA and prepares for division'],
        'Growth in G1 comes first, replication in S, and final preparation and checks in G2.'),
    seq('Order the steps of cytokinesis in an animal cell.', ['A ring of actin filaments forms around the equator', 'The ring contracts and a furrow deepens', 'The cell pinches in two, making two daughter cells'],
        'The contractile ring forms first, then it tightens, and the cell is finally divided.'),
];

// 6. Python, code questions
const code = (question, starter, solution, tests, explanation) => ({ question, type: 'code', language: 'python', starter, correct_answer: solution, tests, explanation });
const G_PY = [
    code('Write a function sum_list(nums) that returns the sum of a list of numbers. Do not use the built-in sum(). Example: sum_list([1, 2, 3]) returns 6.',
        'def sum_list(nums):\n    ...',
        'def sum_list(nums):\n    total = 0\n    for n in nums:\n        total += n\n    return total',
        [{ call: 'sum_list([1, 2, 3])', expect: '6' }, { call: 'sum_list([])', expect: '0' }, { call: 'sum_list([-2, 5])', expect: '3' }],
        'Start a total at 0 and add each element to it inside a for loop.'),
    code('Write a function count_even(nums) that returns how many numbers in the list are even. Example: count_even([1, 2, 4, 7]) returns 2.',
        'def count_even(nums):\n    ...',
        'def count_even(nums):\n    count = 0\n    for n in nums:\n        if n % 2 == 0:\n            count += 1\n    return count',
        [{ call: 'count_even([1, 2, 4, 7])', expect: '2' }, { call: 'count_even([])', expect: '0' }, { call: 'count_even([3, 5])', expect: '0' }, { call: 'count_even([0, 6])', expect: '2' }],
        'A number is even when n % 2 is 0; count those while looping.'),
    code('Write a function longest_word(words) that returns the longest string in a non-empty list. If several are equally long, return the first one. Example: longest_word(["cat", "horse", "dog"]) returns "horse".',
        'def longest_word(words):\n    ...',
        'def longest_word(words):\n    best = words[0]\n    for w in words:\n        if len(w) > len(best):\n            best = w\n    return best',
        [{ call: 'longest_word(["cat", "horse", "dog"])', expect: '"horse"' }, { call: 'longest_word(["ab", "cd"])', expect: '"ab"' }, { call: 'longest_word(["x"])', expect: '"x"' }],
        'Keep the best word so far and replace it only when a strictly longer word appears, so ties keep the first.'),
    code('Write a function squares(n) that returns a list of the squares 1, 4, 9, ... of the numbers from 1 to n, for a whole number n >= 0. Example: squares(4) returns [1, 4, 9, 16].',
        'def squares(n):\n    ...',
        'def squares(n):\n    result = []\n    for i in range(1, n + 1):\n        result.append(i * i)\n    return result',
        [{ call: 'squares(4)', expect: '[1, 4, 9, 16]' }, { call: 'squares(0)', expect: '[]' }, { call: 'squares(1)', expect: '[1]' }],
        'range(1, n + 1) visits 1 to n; append each square to a new list.'),
    code('Write a function index_of(items, target) that returns the position of the first element equal to target, or -1 if it is not in the list. Do not use list.index(). Example: index_of([4, 7, 9], 7) returns 1.',
        'def index_of(items, target):\n    ...',
        'def index_of(items, target):\n    for i in range(len(items)):\n        if items[i] == target:\n            return i\n    return -1',
        [{ call: 'index_of([4, 7, 9], 7)', expect: '1' }, { call: 'index_of([4, 7, 9], 5)', expect: '-1' }, { call: 'index_of([], 1)', expect: '-1' }, { call: 'index_of([2, 2], 2)', expect: '0' }],
        'Loop over the indexes with range(len(items)) and return as soon as the element matches; -1 after the loop.'),
];

// 7. Dutch water management, a mix
const G_NL = [
    mc('Wat is de belangrijkste taak van een gemaal in het Nederlandse waterbeheer?', ['Water uit een laag gelegen gebied wegpompen naar hoger gelegen water', 'Zout water omzetten in drinkwater', 'Stroom opwekken uit het getij', 'Schepen over een hoogteverschil heen tillen'], 'Water uit een laag gelegen gebied wegpompen naar hoger gelegen water',
        'Een gemaal pompt overtollig water uit een polder naar de rivier, het kanaal of de zee, zodat het land droog blijft.'),
    mc('Welk onderdeel van de Deltawerken is meestal open, maar sluit bij stormvloed de Oosterschelde af?', ['De Oosterscheldekering', 'De Afsluitdijk', 'De Maeslantkering', 'De Haringvlietdam'], 'De Oosterscheldekering',
        'De Oosterscheldekering laat het getij door, zodat de natuur behouden blijft, en sluit alleen bij een zware storm.'),
    mc('Wat is een polder?', ['Een stuk land omringd door dijken waarvan de waterstand wordt geregeld', 'Een natuurlijke duinenrij langs de kust', 'Een kanaal tussen twee rivieren', 'Een dijk van zand en klei'], 'Een stuk land omringd door dijken waarvan de waterstand wordt geregeld',
        'In een polder bepalen sloten en gemalen de waterstand, vaak lager dan het water buiten de dijk.'),
    tf('Een groot deel van Nederland ligt onder zeeniveau, daarom zijn dijken en gemalen nodig.', 'True',
        'Zonder dijken en voortdurend wegpompen zou het laaggelegen land regelmatig onderlopen.'),
    tf('De Afsluitdijk is in 1953 aangelegd als reactie op de Watersnoodramp.', 'False',
        'De Afsluitdijk is in 1932 voltooid; de Watersnoodramp van 1953 leidde tot de Deltawerken.'),
];
const NL_AS_ENGLISH = [
    mc('What is the main job of a pumping station in Dutch water management?', ['Pump water from low-lying land up to higher water', 'Turn salt water into drinking water', 'Generate power from the tide', 'Lift ships over a height difference'], 'Pump water from low-lying land up to higher water',
        'A pumping station moves excess water out of a polder so the land stays dry.'),
    mc('Which part of the Delta Works is usually open but closes the Eastern Scheldt in a storm?', ['The Eastern Scheldt barrier', 'The Afsluitdijk', 'The Maeslant barrier', 'The Haringvliet dam'], 'The Eastern Scheldt barrier',
        'The barrier lets the tide through and only closes during a severe storm.'),
    mc('What is a polder?', ['Land surrounded by dikes whose water level is controlled', 'A row of natural dunes', 'A canal between two rivers', 'A dike made of sand and clay'], 'Land surrounded by dikes whose water level is controlled',
        'In a polder, ditches and pumps decide the water level.'),
    tf('A large part of the Netherlands lies below sea level, which is why dikes and pumps are needed.', 'True', 'Without them the land would flood.'),
    tf('The Afsluitdijk was built in 1953 in response to the flood disaster.', 'False', 'It was finished in 1932.'),
];

// 8. Russian, multiple choice
const G_RU = [
    mc('Тело неподвижно лежит на горизонтальном столе. Какое утверждение о силах, действующих на него, верно?', ['Сила тяжести и сила реакции опоры уравновешивают друг друга', 'Сила тяжести равна нулю', 'Сила реакции опоры направлена вниз', 'На тело не действуют никакие силы'], 'Сила тяжести и сила реакции опоры уравновешивают друг друга',
        'Тело покоится, поэтому равнодействующая равна нулю: сила тяжести вниз компенсируется силой реакции опоры вверх.'),
    mc('Какая сила нужна, чтобы тело массой 5 кг получило ускорение 3 м/с²?', ['15 Н', '8 Н', '1,7 Н', '0,6 Н'], '15 Н',
        'По второму закону Ньютона $F = ma = 5 \\cdot 3 = 15\\ \\text{Н}$.'),
    mc('Первый закон Ньютона утверждает, что скорость тела остаётся постоянной, если', ['равнодействующая приложенных к нему сил равна нулю', 'на него действует постоянная сила', 'оно находится в вакууме', 'его масса не меняется'], 'равнодействующая приложенных к нему сил равна нулю',
        'Постоянная скорость, включая покой, возможна только при нулевой равнодействующей силе.'),
    mc('Согласно третьему закону Ньютона, когда Земля притягивает яблоко, яблоко', ['притягивает Землю с силой, равной по модулю', 'не действует на Землю, потому что она слишком массивна', 'притягивает Землю с меньшей силой', 'отталкивает Землю'], 'притягивает Землю с силой, равной по модулю',
        'Силы действия и противодействия равны по модулю и приложены к разным телам; различаются только ускорения.'),
    mc('Как изменится ускорение тела, если при той же силе увеличить его массу вдвое?', ['Уменьшится вдвое', 'Увеличится вдвое', 'Не изменится', 'Увеличится в четыре раза'], 'Уменьшится вдвое',
        'Из $a = F/m$ видно, что при постоянной силе ускорение обратно пропорционально массе.'),
];
const RU_AS_ENGLISH = [
    mc('A body lies at rest on a horizontal table. Which statement about the forces on it is true?', ['Gravity and the support force balance each other', 'Gravity is zero', 'The support force points downward', 'No forces act on the body'], 'Gravity and the support force balance each other', 'The net force is zero because the body is at rest.'),
    mc('What force gives a 5 kg body an acceleration of 3 m/s²?', ['15 N', '8 N', '1.7 N', '0.6 N'], '15 N', 'F = ma = 5 · 3 = 15 N.'),
    mc('Newton\'s first law says velocity stays constant if', ['the net force is zero', 'a constant force acts', 'the body is in a vacuum', 'its mass is constant'], 'the net force is zero', 'Zero net force means no change of velocity.'),
    mc('By Newton\'s third law, when the Earth pulls an apple, the apple', ['pulls the Earth with an equal force', 'does not act on the Earth', 'pulls the Earth with a smaller force', 'pushes the Earth away'], 'pulls the Earth with an equal force', 'Action and reaction forces are equal.'),
    mc('If the mass doubles at the same force, the acceleration', ['halves', 'doubles', 'stays the same', 'quadruples'], 'halves', 'a = F/m.'),
];

const CASES = [
    {
        id: 'quiz-both-photosynthesis', course: 'bio', type: 'both', types: ['multiple_choice', 'true_false'], mix: true, lang: 'en', G: G_BIO,
        extra: [
            { name: 'two keys name no option', reply: j(breakKeys(G_BIO)) },
            { name: 'only multiple choice', reply: j(G_BIO.slice(0, 3).concat(G_BIO.slice(0, 2).map(q => ({ ...q, question: `${q.question} (again)` })))) },
        ],
    },
    {
        id: 'quiz-mc-ohms-law', course: 'physics', type: 'multiple_choice', types: ['multiple_choice'], lang: 'en', G: G_PHYS,
        extra: [
            { name: 'two keys name no option', reply: j(breakKeys(G_PHYS)) },
            { name: 'true/false instead of multiple choice', reply: j(asTrueFalse(G_PHYS)) },
        ],
    },
    {
        id: 'quiz-mc-ww1-causes', course: 'history', type: 'multiple_choice', types: ['multiple_choice'], lang: 'en', G: G_HIST,
        extra: [
            { name: 'two keys name no option', reply: j(breakKeys(G_HIST)) },
            { name: 'open questions instead of multiple choice', reply: j(G_HIST.map(q => ({ question: q.question, type: 'short_answer', correct_answer: q.correct_answer, explanation: q.explanation }))) },
            { name: 'two options are the same value', reply: j(G_HIST.map((q, i) => (i < 2 ? { ...q, options: [q.options[0], q.options[0], q.options[2], q.options[3]] } : q))) },
        ],
    },
    {
        id: 'quiz-tf-plate-tectonics', course: 'earth', type: 'true_false', types: ['true_false'], lang: 'en', G: G_EARTH,
        extra: [
            { name: 'two keys are not True or False', reply: j(G_EARTH.map((q, i) => (i < 2 ? { ...q, correct_answer: 'Partly' } : q))) },
            { name: 'statements written as questions', reply: j(G_EARTH.map(q => ({ ...q, question: `Is it true that ${q.question.charAt(0).toLowerCase()}${q.question.slice(1).replace(/\.$/, '')}?` }))) },
            { name: 'multiple choice instead of true/false', reply: j(G_PHYS) },
        ],
    },
    {
        id: 'quiz-sequence-mitosis', course: 'cells', type: 'sequence', types: ['sequence'], lang: 'en', G: G_CELLS,
        extra: [
            { name: 'two items per ordering question', reply: j(G_CELLS.map(q => ({ ...q, items: q.items.slice(0, 2) }))) },
            { name: 'multiple choice instead of ordering', reply: j(G_BIO.slice(0, 3).concat(G_PHYS.slice(0, 2))) },
            { name: 'a step listed twice in two questions', reply: j(G_CELLS.map((q, i) => (i < 2 ? { ...q, items: [q.items[0], q.items[1], q.items[1], q.items[2]] } : q))) },
        ],
    },
    {
        id: 'quiz-code-python-lists', course: 'python', type: 'code', types: ['code'], lang: 'en', code: 'python', G: G_PY,
        extra: [
            { name: 'no language named', reply: j(G_PY.map(({ language, ...q }) => q)) },
            { name: 'solution is prose', reply: j(G_PY.map(q => ({ ...q, correct_answer: 'The function loops over the list and adds every number to a running total that it returns at the end.' }))) },
            { name: 'multiple choice instead of code', reply: j(G_PHYS) },
        ],
    },
    {
        id: 'quiz-nl-water-management', course: 'nl', type: 'both', types: ['multiple_choice', 'true_false'], mix: true, lang: 'nl', G: G_NL,
        extra: [
            { name: 'written in English', reply: j(NL_AS_ENGLISH) },
            { name: 'two keys name no option', reply: j(breakKeys(G_NL)) },
        ],
    },
    {
        id: 'quiz-ru-newton-laws', course: 'ru', type: 'multiple_choice', types: ['multiple_choice'], lang: 'ru', G: G_RU,
        extra: [
            { name: 'written in English', reply: j(RU_AS_ENGLISH) },
            { name: 'two keys name no option', reply: j(breakKeys(G_RU)) },
            { name: 'true/false instead of multiple choice', reply: j(asTrueFalse(G_RU)) },
        ],
    },
];

export default {
    category: 'quiz',
    label: 'Writing quiz questions',
    setup,
    cases: CASES.map(c => ({
        id: c.id,
        run: (fx, app) => runQuiz(app, fx.ids[c.course], c.type),
        score: quizScore(c),
        golden: j(c.G),
        mutants: [
            ...commonMutants(c.G),
            ...c.extra,
        ],
    })),
};
