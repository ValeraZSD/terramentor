/**
 * Planning a course: the outline stage a learner waits for first.
 *
 * Short courses go through the `short_course` prompt exactly as
 * server/shortCourses.js startBuild does (prompt, structureCall,
 * parseCreationJson, then topicsFrom); the phase plans call the real
 * `planPhases` of server/creationStages.js, which also trims and reads the
 * course size. One model request per case.
 *
 * Language checks are a proxy: function-word shares for Dutch and English,
 * letter sets for Russian and Ukrainian. Topic relevance is a keyword proxy.
 */
const J = (o) => JSON.stringify(o);

// ---- language and wording proxies ------------------------------------------------

const wordsOf = (t) => String(t || '').toLowerCase().match(/\p{L}+/gu) || [];
const share = (ws, set) => ws.filter(w => set.has(w)).length / Math.max(1, ws.length);
const EN = new Set(['the', 'and', 'that', 'with', 'this', 'are', 'can', 'you', 'your', 'how', 'what', 'when', 'from', 'which', 'will', 'into', 'using', 'its', 'their', 'why', 'learn']);
const NL = new Set(['de', 'het', 'een', 'en', 'van', 'voor', 'met', 'hoe', 'je', 'om', 'te', 'op', 'naar', 'bij', 'als', 'dat', 'die', 'wat', 'zijn', 'ook', 'aan', 'niet', 'wordt', 'worden', 'door', 'over', 'uit', 'dit', 'kunt', 'kun', 'welke', 'waarom']);

/** null when `text` reads as `code` (en, nl, ru, uk), else the reason it does not. */
function languageFault(code, text) {
    const ws = wordsOf(text);
    const letters = (String(text).match(/\p{L}/gu) || []).length || 1;
    const cyr = (String(text).match(/\p{Script=Cyrillic}/gu) || []).length / letters;
    if (code === 'en') {
        if (cyr > 0.05) return 'Cyrillic in an English course';
        if (share(ws, EN) < 0.05) return 'does not read as English';
        if (share(ws, NL) > 0.06) return 'reads as Dutch';
    } else if (code === 'nl') {
        if (cyr > 0.05) return 'Cyrillic in a Dutch course';
        if (share(ws, NL) < 0.12) return 'does not read as Dutch';
        if (share(ws, EN) > 0.04) return 'English words in a Dutch course';
    } else if (code === 'uk' || code === 'ru') {
        if (cyr < 0.85) return `not written in Cyrillic (${Math.round(cyr * 100)}%)`;
        const ukOnly = /[іїєґ]/iu.test(text), ruOnly = /[ыэъё]/iu.test(text);
        if (code === 'uk' && (ruOnly || !ukOnly)) return 'does not read as Ukrainian';
        if (code === 'ru' && ukOnly) return 'Ukrainian letters in a Russian course';
    }
    return null;
}

const BANNED = /^(introduction|overview|conclusion|summary|review)$/i;
const key = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').replace(/^[\s.,;:!?"'()]+|[\s.,;:!?"'()]+$/gu, '');

// ---- short courses -------------------------------------------------------------------

/**
 * One short course's outline call, as server/shortCourses.js does it
 * (startBuild, ~558-570), then the reading of the answer (`topicsFrom`,
 * ~592-624, which is not exported). `raw` keeps what the model wrote before
 * the app cut it to eight and put the proposed titles over it.
 */
async function writeShort(app, { title, lang, proposed = [], fromTopic = true, src = null, words = 0 }) {
    const { AI_PROMPTS } = app.ai;
    const { structureCall } = await app.server('creationCalls.js');
    const { parseCreationJson } = await app.server('agentic.js');
    const { promptTitle } = await app.server('citations.js');
    const { shortBlock, sectionRefs, withoutSourceRefs } = await app.server('sourceMaterial.js');
    const { topicCountFor, SHORT } = await app.server('shortCourses.js');
    const count = proposed.length || (src ? topicCountFor(words) : 4);
    const prompt = AI_PROMPTS.short_course(promptTitle(title), { topics: count, proposed, fromTopic, lang, sources: src ? shortBlock(src) : null });
    const text = await structureCall(prompt, { label: 'Short course', answered: {} });
    const parsed = parseCreationJson(text);
    const rawList = Array.isArray(parsed?.topics) ? parsed.topics : Array.isArray(parsed) ? parsed : [];
    const raw = rawList.map(t => ({
        title: String(withoutSourceRefs(typeof t === 'string' ? t : t?.title, src)).replace(/\s+/g, ' ').trim().slice(0, 200),
        description: String(withoutSourceRefs(t?.description ?? '', src)).trim().slice(0, 2000),
        sections: sectionRefs(t?.sections, src),
    })).filter(t => t.title);
    let items = raw.slice();
    if (proposed.length) {
        const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        items = proposed.map((p, i) => {
            const m = raw.find(t => norm(t.title) === norm(p)) || raw[i] || null;
            return { title: p, description: m?.description || '', sections: m?.sections || [] };
        });
    }
    return { raw, items: items.slice(0, SHORT.maxTopics), limits: SHORT, count, parsedName: parsed?.name };
}

/** The shape every short course must have, then the case's own `extra` check. */
function scoreShort(out, { code, relevant, extra }) {
    const { raw, items, limits } = out;
    if (!items.length) return { pass: false, why: 'no topics read from the reply' };
    // The prompt says 3 to 8; the app silently cuts a longer list to 8.
    if (raw.length < limits.minTopics || raw.length > limits.maxTopics) return { pass: false, why: `${raw.length} topics written, the rule is ${limits.minTopics} to ${limits.maxTopics}` };
    const titles = items.map(t => t.title);
    const bad = titles.find(t => BANNED.test(t.replace(/[:.]+$/, '').trim()));
    if (bad) return { pass: false, why: `banned title "${bad}"` };
    if (new Set(titles.map(key)).size !== titles.length) return { pass: false, why: 'two topics share a title' };
    if (items.some(t => !t.description.trim())) return { pass: false, why: 'a topic has no description' };
    const body = items.map(t => `${t.title}. ${t.description}`).join(' ');
    const lf = languageFault(code, body);
    if (lf) return { pass: false, why: lf };
    if (relevant && !relevant.test(body)) return { pass: false, why: 'topics do not mention the subject' };
    return extra ? extra(out) : { pass: true, why: `${items.length} topics, language ok` };
}

const topic = (title, description, sections) => ({ title, description, ...(sections ? { sections } : {}) });
const course = (name, description, topics) => J({ name, description, topics });

const heatPump = `# How a heat pump works

A heat pump moves heat instead of making it. A fridge does the same job in reverse: it pulls heat out of its inside and dumps it into your kitchen. A heat pump for a house runs that trick the other way round, pulling heat out of the cold air outside and putting it into the rooms.

## The refrigerant loop

Inside the machine a sealed loop of refrigerant fluid circulates through four parts. The evaporator, the compressor, the condenser and the expansion valve. The refrigerant boils at a very low temperature, so even winter air at minus five degrees is warm enough to make it evaporate.

## Why the compressor matters

The compressor squeezes the vapour. Squeezing a gas heats it, so the vapour leaves the compressor much hotter than the air outside, often above fifty degrees. This is the step that uses electricity, and it is why the machine needs power at all.

## Heating the house

The hot vapour flows into the condenser, where it gives its heat to the water of the heating system and turns back into a liquid. The expansion valve then drops its pressure, the liquid becomes very cold, and the cycle starts again at the evaporator.

## Efficiency and COP

One kilowatt hour of electricity can move three or four kilowatt hours of heat, because most of the energy is only carried and not made. This ratio is called the coefficient of performance, or COP. A COP of 3.5 means 3.5 units of heat for each unit of electricity. The COP falls when the outside air gets colder, because the compressor has to work harder.`;

async function heatPumpSource(app) {
    const sm = await app.server('sourceMaterial.js');
    const { buildSourceMap } = await app.server('sourceMap.js');
    const map = buildSourceMap({ text: heatPump, kind: 'text', filename: 'heat-pump.md' });
    return sm.creationSources([{ id: 'doc-1', title: 'heat-pump', file_type: 'text', content: heatPump, page_count: null, map }]);
}

const PROPOSED = ['Reading a balance sheet', 'Reading an income statement', 'Understanding cash flow', 'Key financial ratios'];

// ---- phase plans -------------------------------------------------------------------------

/**
 * The real `planPhases` (server/creationStages.js ~405) over a hand-built run
 * context, the fields routes/createProject.js ~806 gives it, with no files.
 * The app trims an over-long plan to the size's top, so only a short plan and
 * a wrong size can fail the range.
 */
async function plan(app, { name, description, summary, lang }) {
    const stages = await app.server('creationStages.js');
    const sizes = (await app.server('courseSize.js')).COURSE_SIZES;
    const ctx = {
        send() {}, signal: undefined, startCall() {}, endCall() {}, name, description, projectSummary: summary, lang, src: null,
        counts: { categories: 0, elements: 0, subElements: 0, resources: 0 }, gaps: [], work: { done: 0, total: 0 },
    };
    const phases = await stages.planPhases(ctx, {});
    return { phases, size: ctx.size, sizes };
}

function scorePlan(out, { size, code }) {
    const { phases, sizes } = out;
    if (out.size !== size) return { pass: false, why: `size judged "${out.size}", the request is a "${size}" course` };
    const [lo, hi] = sizes[size].phases;
    if (phases.length < lo || phases.length > hi) return { pass: false, why: `${phases.length} phases, "${size}" is ${lo} to ${hi}` };
    if (new Set(phases.map(p => key(p.title))).size !== phases.length) return { pass: false, why: 'two phases share a title' };
    if (phases.some(p => !p.description.trim())) return { pass: false, why: 'a phase has no description' };
    const lf = languageFault(code, phases.map(p => `${p.title}. ${p.description}`).join(' '));
    if (lf) return { pass: false, why: lf };
    return { pass: true, why: `${phases.length} phases, size ${out.size}` };
}

const phase = (title, description) => ({ title, description });
const plans = (size, categories) => J({ size, categories });

const derivP = [
    phase('Phase 1: The rule and why it works', 'What a composite function is and how the chain rule says its rate of change is a product of two rates.'),
    phase('Phase 2: Applying the rule', 'Differentiating nested functions such as sin(3x), (x^2+1)^5 and e^(2x) step by step.'),
    phase('Phase 3: Chains inside bigger problems', 'Using the chain rule together with the product and quotient rules, and checking answers.'),
];
const financeNL = [
    phase('Fase 1: Inkomsten en uitgaven in kaart', 'Je leert hoe je een maandbudget maakt en waar je geld naartoe gaat.'),
    phase('Fase 2: Sparen en buffers', 'Hoe je een noodfonds opbouwt en wat rente voor je spaargeld doet.'),
    phase('Fase 3: Lenen en kredietrisico', 'Wat een studielening of een creditcard echt kost en hoe je schulden voorkomt.'),
    phase('Fase 4: Belasting en toeslagen', 'Hoe de belastingaangifte werkt en welke toeslagen je kunt aanvragen.'),
    phase('Fase 5: Beleggen voor beginners', 'De basis van aandelen, fondsen en risico, en hoe je een langetermijnplan maakt.'),
];
const pythonP = [
    ['Phase 1: Getting started', 'Installing Python and writing your first scripts.'],
    ['Phase 2: Core language', 'Variables, types, control flow and functions.'],
    ['Phase 3: Data structures', 'Lists, dictionaries, sets and tuples in depth.'],
    ['Phase 4: Object-oriented programming', 'Classes, inheritance and the data model.'],
    ['Phase 5: Files, errors and modules', 'Reading and writing files, exceptions and packaging code.'],
    ['Phase 6: The standard library', 'Working with dates, paths, collections and itertools.'],
    ['Phase 7: Testing and tooling', 'Unit tests, virtual environments and linting.'],
    ['Phase 8: Concurrency and async', 'Threads, processes and asyncio.'],
].map(([t, d]) => phase(t, d));

export default {
    category: 'outline',
    label: 'Planning courses',
    async setup(app) {
        return { heatSrc: await heatPumpSource(app), heatWords: heatPump.split(/\s+/).length };
    },
    cases: [
        {
            id: 'outline-short-en-budgeting',
            run: async (fx, app) => writeShort(app, { title: 'Personal budgeting basics', lang: (await app.server('language.js')).getLanguage('en') }),
            score: (out) => scoreShort(out, { code: 'en', relevant: /budget|spend|saving|income|expens/i }),
            golden: course('Personal budgeting basics', 'Learn to plan your income and spending so that you save money every month.', [
                topic('Tracking where your money goes', 'How to record income and expenses for a month and why that is the first step.'),
                topic('Building a monthly budget', 'How to split your income into fixed costs, spending and savings with simple rules.'),
                topic('Saving for a goal', 'How to set a savings target and a monthly amount that gets you there.'),
                topic('Keeping a budget going', 'How to review the budget each month and adjust it when your income or costs change.'),
            ]),
            mutants: [
                { name: 'two topics only', reply: course('Budgeting', 'Learn to budget.', [topic('Tracking spending', 'Record your expenses.'), topic('Saving money', 'Set aside part of your income.')]) },
                { name: 'banned generic titles', reply: course('Budgeting', 'Learn to budget.', [topic('Introduction', 'What budgeting is.'), topic('Overview', 'The parts of a budget.'), topic('Summary', 'What you learned.'), topic('Conclusion', 'Final thoughts.')]) },
                { name: 'twelve topics', reply: course('Budgeting', 'Learn to budget.', Array.from({ length: 12 }, (_, i) => topic(`Budgeting step ${i + 1}`, `How the step number ${i + 1} helps with spending and saving.`))) },
                { name: 'repeated title', reply: course('Budgeting', 'Learn to budget.', [topic('Tracking spending', 'Record your expenses and income.'), topic('Tracking spending', 'Record your expenses and savings.'), topic('Saving money', 'Set aside part of your income.')]) },
                { name: 'answers in Dutch', reply: course('Budgetteren', 'Leer je geld plannen.', [topic('Uitgaven bijhouden', 'Hoe je inkomsten en uitgaven noteert voor een maand.'), topic('Een maandbudget maken', 'Hoe je je inkomen verdeelt over vaste lasten en sparen.'), topic('Sparen voor een doel', 'Hoe je een spaardoel bepaalt en het bedrag per maand.')]) },
                { name: 'not JSON', reply: 'Sure! A good budgeting course would start with tracking spending, then building a budget, then saving.' },
            ],
        },
        {
            id: 'outline-short-nl-statistiek',
            run: async (fx, app) => writeShort(app, { title: 'Basisbegrippen van statistiek', lang: (await app.server('language.js')).getLanguage('nl') }),
            score: (out) => scoreShort(out, { code: 'nl', relevant: /statistiek|gemiddelde|mediaan|spreiding|kans|steekproef|verdeling/i }),
            golden: course('Basisbegrippen van statistiek', 'Je leert gegevens samenvatten, de spreiding beoordelen en een eenvoudige steekproef lezen.', [
                topic('Gemiddelde, mediaan en modus', 'Hoe je met één getal het midden van een dataset beschrijft en wanneer welke maat past.'),
                topic('Spreiding en standaardafwijking', 'Hoe je laat zien hoe ver de waarden uit elkaar liggen en waarom dat ertoe doet.'),
                topic('Kansen en verdelingen', 'Hoe je de kans op een uitkomst berekent en een normale verdeling leest.'),
                topic('Steekproeven en betrouwbaarheid', 'Hoe je uit een steekproef iets zegt over een hele groep, en hoe zeker dat is.'),
            ]),
            mutants: [
                { name: 'English instead of Dutch', reply: course('Basics of statistics', 'You learn to summarise data and read a sample.', [topic('Mean, median and mode', 'How you describe the centre of a dataset with one number.'), topic('Spread and standard deviation', 'How you show how far the values lie apart.'), topic('Probability and distributions', 'How you work out the chance of an outcome.'), topic('Samples and confidence', 'How you say something about a group from a sample.')]) },
                { name: 'Dutch titles, English descriptions', reply: course('Basisbegrippen van statistiek', 'You learn to summarise data.', [topic('Gemiddelde en mediaan', 'How you describe the centre of a dataset with one number, and when to use which.'), topic('Spreiding', 'How you show how far the values lie apart and why this matters for statistics.'), topic('Kansen', 'How you work out the chance of an outcome and read a distribution of the results.')]) },
                { name: 'banned titles', reply: course('Statistiek', 'Leer statistiek.', [topic('Introduction', 'Wat statistiek is en waarom je het nodig hebt.'), topic('Overview', 'De onderdelen van de statistiek in een rij.'), topic('Samenvatting', 'Wat je hebt geleerd over de statistiek.'), topic('Summary', 'Nog een korte samenvatting van de statistiek.')]) },
                { name: 'one topic', reply: course('Statistiek', 'Leer statistiek.', [topic('Alles over statistiek', 'Het gemiddelde, de spreiding en de kans in één keer.')]) },
            ],
        },
        {
            id: 'outline-short-uk-python',
            run: async (fx, app) => writeShort(app, { title: 'Основи програмування на Python', lang: (await app.server('language.js')).getLanguage('uk') }),
            score: (out) => scoreShort(out, { code: 'uk', relevant: /python|змінн|цикл|функці|програм/i }),
            golden: course('Основи програмування на Python', 'Ви навчитеся писати прості програми: працювати зі змінними, умовами, циклами та функціями.', [
                topic('Змінні та типи даних', 'Як зберігати числа й текст у змінних і чим відрізняються типи даних.'),
                topic('Умови та цикли', 'Як змусити програму ухвалювати рішення та повторювати дії.'),
                topic('Функції', 'Як винести повторювану логіку у функцію і викликати її з різними аргументами.'),
                topic('Списки та словники', 'Як зберігати набори значень і знаходити в них потрібне.'),
            ]),
            mutants: [
                { name: 'Russian instead of Ukrainian', reply: course('Основы программирования на Python', 'Вы научитесь писать простые программы: работать с переменными, условиями, циклами и функциями.', [topic('Переменные и типы данных', 'Как хранить числа и текст в переменных и чем отличаются типы данных.'), topic('Условия и циклы', 'Как заставить программу принимать решения и повторять действия.'), topic('Функции', 'Как вынести повторяющуюся логику в функцию и вызывать её с разными аргументами.'), topic('Списки и словари', 'Как хранить наборы значений и находить в них нужное.')]) },
                { name: 'English instead of Ukrainian', reply: course('Python basics', 'You learn to write small programs.', [topic('Variables and types', 'How to store numbers and text in variables.'), topic('Conditions and loops', 'How to make a program decide and repeat.'), topic('Functions', 'How to reuse logic in a function.')]) },
                { name: 'generic titles', reply: course('Python', 'Основи програмування.', [topic('Вступ', 'Про що цей курс і навіщо він потрібен програмісту.'), topic('Introduction', 'Загальний огляд мови програмування Python для початківців.'), topic('Overview', 'Огляд основних можливостей мови програмування Python.'), topic('Summary', 'Короткий підсумок усього курсу з програмування Python.')]) },
                { name: 'two topics only', reply: course('Python', 'Основи програмування.', [topic('Змінні та типи даних', 'Як зберігати числа й текст у змінних.'), topic('Функції та цикли', 'Як писати цикли та функції у програмі на Python.')]) },
            ],
        },
        {
            // The learner showed the assistant's topic list and said yes: the app
            // keeps the titles as shown and takes only descriptions from the reply,
            // so a model that rewords or reorders them loses the match.
            id: 'outline-short-proposed-titles',
            run: (fx, app) => writeShort(app, { title: 'Understanding company accounts', proposed: PROPOSED }),
            score: (out) => {
                const got = out.raw.map(t => t.title);
                if (got.length !== PROPOSED.length) return { pass: false, why: `${got.length} topics written, ${PROPOSED.length} were proposed` };
                const off = PROPOSED.findIndex((p, i) => got[i] !== p);
                if (off >= 0) return { pass: false, why: `topic ${off + 1} is "${got[off]}", not the proposed "${PROPOSED[off]}"` };
                if (out.items.some(t => t.description.trim().length < 20)) return { pass: false, why: 'a proposed topic ended up with no description' };
                const lf = languageFault('en', out.items.map(t => t.description).join(' '));
                return lf ? { pass: false, why: lf } : { pass: true, why: 'titles copied in order, descriptions written' };
            },
            golden: course('Understanding company accounts', 'Read the main financial statements of a company and judge how healthy it is.', [
                topic(PROPOSED[0], 'What assets, liabilities and equity are and how the balance sheet shows what a company owns and owes.'),
                topic(PROPOSED[1], 'How revenue, costs and profit are laid out and how to read the result of a year.'),
                topic(PROPOSED[2], 'How cash moves in and out of a business and why profit and cash are not the same thing.'),
                topic(PROPOSED[3], 'How a few ratios summarise liquidity, debt and profitability so companies can be compared.'),
            ]),
            mutants: [
                { name: 'rewords the titles', reply: course('Company accounts', 'Read company accounts.', [topic('How to read a balance sheet', 'What the balance sheet shows about a company.'), topic('How to read an income statement', 'What the income statement shows about profit.'), topic('Cash flow explained', 'How cash moves in a business and why it matters.'), topic('Financial ratios', 'How a few ratios summarise a company at a glance.')]) },
                { name: 'reorders the titles', reply: course('Company accounts', 'Read company accounts.', [topic(PROPOSED[1], 'How revenue, costs and profit are laid out in a year.'), topic(PROPOSED[0], 'What assets, liabilities and equity are on a balance sheet.'), topic(PROPOSED[2], 'How cash moves in and out of a business and why that matters.'), topic(PROPOSED[3], 'How a few ratios summarise liquidity and debt for comparison.')]) },
                { name: 'drops the last topic', reply: course('Company accounts', 'Read company accounts.', [topic(PROPOSED[0], 'What assets, liabilities and equity are on a balance sheet.'), topic(PROPOSED[1], 'How revenue, costs and profit are laid out in a year.'), topic(PROPOSED[2], 'How cash moves in and out of a business and why that matters.')]) },
                { name: 'adds a fifth topic', reply: course('Company accounts', 'Read company accounts.', [...PROPOSED, 'Audit reports'].map(t => topic(t, `What ${t.toLowerCase()} are about and why they matter to a reader of accounts.`))) },
                { name: 'no descriptions', reply: course('Company accounts', 'Read company accounts.', PROPOSED.map(t => topic(t, ''))) },
            ],
        },
        {
            id: 'outline-short-from-source',
            run: (fx, app) => writeShort(app, { title: 'How a heat pump works', fromTopic: false, src: fx.heatSrc, words: fx.heatWords }),
            // Proxy for "built from the source": every topic cites real parts (§2 to §5
            // are the four headed parts, §1 the whole text), the parts together are all
            // taught, topics follow the source's order, and nothing talks about "the article".
            score: (out, fx) => scoreShort(out, {
                code: 'en',
                relevant: /heat|refrigerant|compressor|cop/i,
                extra: ({ items }) => {
                    if (items.some(t => !t.sections.length)) return { pass: false, why: 'a topic cites no part of the source' };
                    const firsts = items.map(t => t.sections[0]);
                    if (firsts.some((n, i) => i && n < firsts[i - 1])) return { pass: false, why: 'topics are out of the source order' };
                    const covered = new Set(items.flatMap(t => t.sections));
                    const gone = [2, 3, 4, 5].filter(n => !covered.has(n));
                    if (gone.length) return { pass: false, why: `no topic teaches part(s) ${gone.join(', ')}` };
                    if (items.some(t => /(in|from) (this|the) (article|video|text|source|page)|the (article|author|text|source) (says|explains|states)/i.test(`${t.title} ${t.description}`))) return { pass: false, why: 'a topic talks about the source instead of teaching it' };
                    return { pass: true, why: `${items.length} topics citing the source` };
                },
            }),
            golden: course('How a heat pump works', 'Understand how a heat pump moves heat into a house and what its efficiency means.', [
                topic('Moving heat with a refrigerant loop', 'How the refrigerant circulates and boils even in cold air to pick up heat.', [2]),
                topic('Compression and the condenser', 'Why squeezing the vapour makes it hot and how that heat reaches the heating water.', [3, 4]),
                topic('Efficiency and the COP', 'What the coefficient of performance means and why it falls in colder air.', [5]),
            ]),
            mutants: [
                { name: 'cites nothing', reply: course('Heat pumps', 'Understand heat pumps.', [topic('Moving heat with a refrigerant loop', 'How the refrigerant boils in cold air to pick up heat.'), topic('Compression and the condenser', 'Why squeezing the vapour makes it hot.'), topic('Efficiency and the COP', 'What the coefficient of performance means.')]) },
                { name: 'leaves the last part out', reply: course('Heat pumps', 'Understand heat pumps.', [topic('The refrigerant loop', 'How the refrigerant boils in cold air to pick up heat.', [2]), topic('Compression', 'Why squeezing the vapour makes it hot and uses electricity.', [3]), topic('Heating the house', 'How the condenser gives heat to the water of the radiators.', [4])]) },
                { name: 'out of order', reply: course('Heat pumps', 'Understand heat pumps.', [topic('Efficiency and the COP', 'What the coefficient of performance means.', [5]), topic('Compression and the condenser', 'Why squeezing the vapour makes it hot.', [3, 4]), topic('The refrigerant loop', 'How the refrigerant boils in cold air.', [2])]) },
                { name: 'talks about the article', reply: course('Heat pumps', 'Understand heat pumps.', [topic('What the article says about the loop', 'In this article the author explains the refrigerant loop and how it boils.', [2]), topic('Compression and the condenser', 'Why squeezing the vapour makes it hot.', [3, 4]), topic('Efficiency and the COP', 'What the coefficient of performance means.', [5])]) },
                { name: 'cites parts that do not exist', reply: course('Heat pumps', 'Understand heat pumps.', [topic('The refrigerant loop', 'How the refrigerant boils in cold air to pick up heat.', [12]), topic('Compression', 'Why squeezing the vapour makes it hot.', [13, 14]), topic('Efficiency', 'What the coefficient of performance means.', [15])]) },
            ],
        },
        {
            id: 'outline-phases-short-chain-rule',
            run: (fx, app) => plan(app, {
                name: 'Chain rule', description: 'I only need to learn the chain rule for differentiating composite functions before a calculus quiz on Friday.',
                summary: 'A focused course on the chain rule: differentiating composite functions.', lang: null,
            }),
            score: (out) => scorePlan(out, { size: 'short', code: 'en' }),
            golden: plans('short', derivP),
            mutants: [
                { name: 'sizes it full', reply: plans('full', [...derivP, phase('Phase 4: Implicit differentiation', 'Differentiating relations where y is not written alone.'), phase('Phase 5: Related rates', 'Using derivatives to link changing quantities in applied problems.'), phase('Phase 6: Optimisation', 'Finding maxima and minima of functions in real contexts.')]) },
                { name: 'names no size', reply: J({ categories: derivP }) },
                { name: 'one phase', reply: plans('short', [derivP[0]]) },
                { name: 'same phase three times', reply: plans('short', [derivP[0], derivP[0], derivP[0]]) },
                { name: 'phases without descriptions', reply: plans('short', derivP.map(p => ({ title: p.title }))) },
                { name: 'not JSON', reply: 'I would start with the idea of composite functions, then practise nested derivatives.' },
            ],
        },
        {
            id: 'outline-phases-standard-nl-finance',
            run: async (fx, app) => plan(app, {
                name: 'Financiën voor studenten',
                description: 'Een module van één trimester (12 weken) over vijf verbonden onderwerpen: budgetteren, sparen, lenen, belasting en beleggen voor beginners.',
                summary: 'Een module over persoonlijke financiën voor studenten: budget, sparen, lenen, belasting en beleggen.',
                lang: (await app.server('language.js')).getLanguage('nl'),
            }),
            score: (out) => scorePlan(out, { size: 'standard', code: 'nl' }),
            golden: plans('standard', financeNL),
            mutants: [
                { name: 'plans it in English', reply: plans('standard', [phase('Phase 1: Income and spending', 'You learn how to make a monthly budget and where your money goes.'), phase('Phase 2: Saving and buffers', 'How to build an emergency fund and what interest does for your savings.'), phase('Phase 3: Borrowing and credit risk', 'What a student loan or a credit card really costs and how to avoid debt.'), phase('Phase 4: Tax and allowances', 'How the tax return works and which allowances you can apply for.')]) },
                { name: 'sizes it short', reply: plans('short', financeNL.slice(0, 3)) },
                { name: 'sizes it full with ten phases', reply: plans('full', Array.from({ length: 10 }, (_, i) => phase(`Fase ${i + 1}: Financiën voor studenten deel ${i + 1}`, `Je leert hoe het onderwerp van deel ${i + 1} werkt en wat het voor je geld betekent.`))) },
                { name: 'one phase', reply: plans('standard', [financeNL[0]]) },
                { name: 'no JSON', reply: 'Een goed plan begint met een budget, daarna sparen, lenen, belasting en beleggen.' },
            ],
        },
        {
            id: 'outline-phases-full-python',
            run: (fx, app) => plan(app, {
                name: 'Python programming',
                description: 'A complete course on the whole Python language and its standard library, from zero to job-ready: the full syllabus, not one topic.',
                summary: 'A complete Python programming course covering the whole language, its standard library and professional practice.',
                lang: null,
            }),
            score: (out) => scorePlan(out, { size: 'full', code: 'en' }),
            golden: plans('full', pythonP),
            mutants: [
                { name: 'sizes it short', reply: plans('short', pythonP.slice(0, 3)) },
                { name: 'sizes it standard', reply: plans('standard', pythonP.slice(0, 5)) },
                { name: 'claims full with three phases', reply: plans('full', pythonP.slice(0, 3)) },
                { name: 'no size given', reply: J({ categories: pythonP }) },
                { name: 'not JSON', reply: 'Start with the basics and work towards concurrency.' },
            ],
        },
    ],
};
