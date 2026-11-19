/**
 * Writing flashcards: the card-generation path.
 *
 * Each case rebuilds what POST /api/ai/flashcards does (server/routes/flashcards.js:49-52):
 * buildFlashcardPrompt(node, 6), then generateResponse with the options the app passes
 * (generateMaterial, server/studyMaterial.js:426: operation 'questions'). The reply is then
 * read exactly as finalizeFlashcards reads it (server/studyMaterial.js:329-342): the first
 * [...] span, parseJsonWithRepair, a card is usable when its trimmed front and back are both
 * non-empty strings; a reply that is not a JSON array makes the app throw. The function
 * itself is NOT called because it then spends 2-3 extra model requests on checkItemKeys
 * (a cold check of the card keys), which is a different job.
 *
 * Pass: at least ceil(0.8 * 6) = 5 good cards, every usable front distinct (the app skips
 * a repeated front), no corrupted text, and the cards are in the course language.
 *
 * Proxies, named plainly:
 *  - "good" also excludes a BARE front (under three words, e.g. "Mitochondrion"): the card
 *    prompt (ai.js CARD_SHAPE_RULES) forbids a front that does not say what to do, and no
 *    app gate checks it, so a word count stands in for "says what to do".
 *  - "corrupted" means a control character (backspace, tab, form feed) in a card. The card
 *    path parses with no LaTeX-aware escaping, so a model that writes \frac or \times with
 *    a single backslash yields a form feed or a tab inside the formula, and the app keeps
 *    the card. A reply with other single-backslash TeX (\Delta, \text) is not valid JSON at
 *    all and the app throws.
 *  - language: the app's English-drift check, a function-word check for Dutch and for
 *    English (english.mjs), a letter-script check for Ukrainian that also rejects
 *    Russian-only letters.
 */
import { englishFault } from './english.mjs';

const N = 6;
const NEED = Math.ceil(0.8 * N);

const COURSES = [
    {
        key: 'cells', name: 'Cell biology', lang: 'en',
        node: {
            title: 'Cell organelles',
            description: 'The membrane-bound structures inside eukaryotic cells and what each one does: the nucleus, mitochondria, ribosomes, the Golgi apparatus, chloroplasts and the cell wall.',
            notes: 'Mitochondria release ATP. Ribosomes build proteins from mRNA. The Golgi sorts and packages. Chloroplasts hold chlorophyll. Plant cell walls are made of cellulose.',
        },
    },
    {
        key: 'suvat', name: 'Mechanics', lang: 'en',
        node: {
            title: 'Equations of motion for constant acceleration',
            description: 'The SUVAT equations for straight-line motion with constant acceleration: $v = u + at$, $s = ut + \\frac{1}{2}at^2$ and $v^2 = u^2 + 2as$. Choosing the right equation, the value of $g$ near the Earth\'s surface, and the area under a velocity-time graph.',
            notes: 'List what is given and what is wanted, then pick the equation that has exactly those four quantities. Treat up and down as opposite signs.',
        },
    },
    {
        key: 'nl', name: 'Biologie: de mens', lang: 'nl',
        node: {
            title: 'Het hart en de bloedsomloop',
            description: 'Bouw en werking van het menselijk hart: de vier hartholten, de hartkleppen, slagaders en aders, de grote en de kleine bloedsomloop en de bloeddruk.',
            notes: 'Het hart heeft twee boezems en twee kamers. De longslagader voert zuurstofarm bloed naar de longen. Bloeddruk wordt gemeten als bovendruk over onderdruk.',
        },
    },
    {
        key: 'uk', name: 'Історія України', lang: 'uk',
        node: {
            title: 'Київська Русь',
            description: 'Виникнення й розквіт Київської Русі (IX-XI ст.): князі Олег, Ігор, Ольга, Володимир і Ярослав Мудрий, хрещення Русі, «Руська правда», шлях «із варяг у греки», роль княжої дружини.',
            notes: 'Столиця — Київ. Хрещення Русі — 988 рік. Софійський собор у Києві збудовано за Ярослава Мудрого.',
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

// ---------------------------------------------------------------- run and score

/** The app's own read of the reply (server/studyMaterial.js:329-342), minus the key check. */
async function runCards(app, nodeId) {
    const { buildFlashcardPrompt } = await app.server('studyMaterial.js');
    const { parseJsonWithRepair } = await app.server('agentic.js');
    const { system, user } = buildFlashcardPrompt(nodeId, N);
    const raw = await app.ai.generateResponse(user, system, [], { operation: 'questions' });
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');
    const parsed = parseJsonWithRepair(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('Flashcard response was not a JSON array');
    const drafts = parsed.map(card => ({
        front: typeof card?.front === 'string' ? card.front.trim() : '',
        back: typeof card?.back === 'string' ? card.back.trim() : '',
    }));
    return { drafts, usable: drafts.filter(c => c.front && c.back) };
}

const wordsOf = (s) => String(s).toLowerCase().match(/\p{L}+/gu) || [];
const stripMath = (s) => String(s).replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, ' ').replace(/`[^`\n]*`/g, ' ');
const DUTCH = new Set(['de', 'het', 'een', 'van', 'en', 'is', 'in', 'op', 'te', 'dat', 'die', 'voor', 'met', 'zijn', 'niet', 'om', 'aan', 'er', 'ook', 'als', 'dan', 'bij', 'of', 'wat', 'welke', 'hoe', 'wordt', 'naar', 'door', 'uit', 'maar', 'deze', 'dit', 'ze', 'hoeveel']);

/** null when `text` reads as written in language `code`, else the reason it does not. */
async function languageProblem(app, text, code) {
    if (code === 'en') return englishFault(stripMath(text));
    const { getLanguage, driftedToEnglish } = await app.server('language.js');
    const prose = stripMath(text);
    // The app's drift check ignores samples under 60 words; repeating the text keeps the
    // ratio and clears the floor (a set of short cards is under it).
    let padded = prose;
    while (wordsOf(padded).length < 80 && wordsOf(prose).length) padded += ` ${prose}`;
    if (driftedToEnglish(padded, getLanguage(code))) return 'written in English, not the course language';
    const words = wordsOf(prose);
    if (!words.length) return 'no prose to judge';
    if (code === 'nl') {
        const share = words.filter(w => DUTCH.has(w)).length / words.length;
        if (share < 0.1) return `does not read as Dutch (function-word share ${share.toFixed(2)})`;
    }
    if (code === 'uk') {
        const letters = prose.match(/\p{L}/gu) || [];
        const cyr = letters.filter(ch => /[\u0400-\u04FF]/.test(ch)).length;
        if (cyr / letters.length < 0.8) return 'mostly not Cyrillic';
        if (/[ыэъё]/i.test(prose)) return 'has Russian-only letters in a Ukrainian course';
        if (!/[іїє]/i.test(prose)) return 'no Ukrainian letters at all';
    }
    return null;
}

function cardScore(lang) {
    return async (out, fx, app) => {
        const { usable } = out;
        const fronts = usable.map(c => c.front.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?;,:]+$/, ''));
        if (new Set(fronts).size !== fronts.length) return { pass: false, why: 'two cards share a front' };
        if (usable.some(c => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\t]/.test(`${c.front}${c.back}`))) {
            return { pass: false, why: 'a card holds a control character: a TeX command was read as a JSON escape' };
        }
        const good = usable.filter(c => wordsOf(c.front).length >= 3);
        if (good.length < NEED) return { pass: false, why: `${good.length} of ${N} cards are usable with a front that says what to do (need ${NEED}); ${usable.length} had both sides` };
        const problem = await languageProblem(app, usable.map(c => `${c.front}\n${c.back}`).join('\n'), lang);
        if (problem) return { pass: false, why: problem };
        return { pass: true, why: `${good.length} good cards of ${usable.length}` };
    };
}

// ---------------------------------------------------------------- replies

const j = (x) => JSON.stringify(x);
const card = (front, back) => ({ front, back });

const bare = (G, fronts) => G.map((c, i) => card(fronts[i], c.back));
const commonMutants = (G, bareFronts) => [
    { name: 'only three cards', reply: j(G.slice(0, 3)) },
    { name: 'prose instead of JSON', reply: 'Here are six flashcards you can use for this topic. The first one covers the main definition, the second the key example, and the rest cover the details.' },
    { name: 'half the backs are empty', reply: j(G.map((c, i) => (i % 2 ? { ...c, back: '' } : c))) },
    { name: 'the same front repeated', reply: j([G[0], G[1], G[1], G[2], G[3], G[4]]) },
    { name: 'bare terms as fronts', reply: j(bare(G, bareFronts)) },
];

const G_CELLS = [
    card('What is the main job of the mitochondrion?', 'It releases usable energy as ATP by breaking down glucose in aerobic respiration.'),
    card('What does a ribosome do?', 'It builds proteins by joining amino acids in the order coded in mRNA.'),
    card('Name the organelle where photosynthesis happens and the pigment inside it.', 'The chloroplast, which holds the green pigment chlorophyll.'),
    card('What is the function of the Golgi apparatus?', 'It modifies, sorts and packages proteins and lipids, for example into vesicles that carry them out of the cell.'),
    card('Which organelle stores the cell\'s DNA?', 'The nucleus, which is enclosed by a double membrane.'),
    card('What is the plant cell wall made of, and what does it do?', 'Mostly cellulose; it supports the cell and stops it bursting when it takes in water.'),
];

// G_CELLS translated into Dutch: the count, the fronts and the format all pass,
// so only the language check can catch it.
const G_CELLS_NL = [
    card('Wat is de belangrijkste taak van het mitochondrion?', 'Het levert bruikbare energie als ATP door glucose af te breken bij aerobe verbranding.'),
    card('Wat doet een ribosoom?', 'Het bouwt eiwitten door aminozuren te koppelen in de volgorde die in het mRNA staat.'),
    card('Noem het organel waar fotosynthese plaatsvindt en het pigment daarin.', 'De bladgroenkorrel, met het groene pigment chlorofyl.'),
    card('Wat is de functie van het Golgi-apparaat?', 'Het past eiwitten en vetten aan, sorteert en verpakt ze, bijvoorbeeld in blaasjes die ze uit de cel vervoeren.'),
    card('Welk organel bewaart het DNA van de cel?', 'De celkern, die omgeven is door een dubbel membraan.'),
    card('Waar is de celwand van een plant van gemaakt, en wat doet die?', 'Vooral cellulose; hij steunt de cel en voorkomt dat die barst als hij water opneemt.'),
];

const G_SUVAT = [
    card('Give the equation for the final velocity after time $t$ at constant acceleration $a$ from initial velocity $u$.', '$v = u + at$'),
    card('Give the equation for the displacement $s$ in terms of $u$, $a$ and $t$.', '$s = ut + \\frac{1}{2}at^2$'),
    card('Which equation links $v$, $u$, $a$ and $s$ when the time is unknown?', '$v^2 = u^2 + 2as$'),
    card('A car accelerates from rest at $2\\ \\text{m/s}^2$ for $5\\ \\text{s}$. How far does it travel?', '$s = \\frac{1}{2} \\times 2 \\times 5^2 = 25\\ \\text{m}$'),
    card('What is the value of $g$ near the Earth\'s surface, and which way does it point?', 'About $9.8\\ \\text{m/s}^2$, downward towards the centre of the Earth.'),
    card('What does the area under a velocity-time graph represent?', 'The displacement; for example, a constant 4 m/s for 3 s gives an area of 12 m.'),
];
/** The same set with TeX that survives single backslashes only when every command starts with a JSON escape letter. */
const G_SUVAT_FRAC = G_SUVAT.map((c, i) => (i === 3
    ? card(c.front.replace(/\\ \\text\{m\/s\}\^2/, ' m/s²').replace(/\\ \\text\{s\}/, ' s'), '$s = \\frac{1}{2} \\times 2 \\times 5^2 = 25$ m')
    : i === 4 ? card(c.front, 'About 9.8 m/s², downward towards the centre of the Earth.')
        : i === 1 ? card(c.front, '$s = ut + \\frac{1}{2}at^2$') : c));
const singleBackslash = (text) => text.replace(/\\\\/g, '\\');

const G_NL = [
    card('Wat is de functie van het hart?', 'Het pompt bloed door het lichaam, zodat alle organen zuurstof en voedingsstoffen krijgen.'),
    card('Hoeveel hartholten heeft het menselijk hart, en hoe heten ze?', 'Vier: twee boezems (atria) en twee kamers (ventrikels).'),
    card('Welk bloedvat voert zuurstofarm bloed van het hart naar de longen?', 'De longslagader.'),
    card('Wat is het verschil tussen een slagader en een ader?', 'Een slagader voert bloed van het hart af, een ader voert bloed naar het hart toe. Bijvoorbeeld: de aorta is een slagader, de holle ader is een ader.'),
    card('Wat doen de hartkleppen?', 'Ze zorgen ervoor dat het bloed maar in één richting door het hart stroomt en niet terugloopt.'),
    card('Welke twee getallen noemt een bloeddrukmeting, en wat betekent het eerste?', 'De bovendruk en de onderdruk; de bovendruk is de druk op het moment dat het hart samenknijpt, bijvoorbeeld 120 over 80.'),
];
const G_NL_EN = [
    card('What is the function of the heart?', 'It pumps blood around the body so every organ gets oxygen and nutrients.'),
    card('How many chambers does the human heart have, and what are they called?', 'Four: two atria and two ventricles.'),
    card('Which blood vessel carries oxygen-poor blood from the heart to the lungs?', 'The pulmonary artery.'),
    card('What is the difference between an artery and a vein?', 'An artery carries blood away from the heart, a vein carries it towards the heart. For example, the aorta is an artery.'),
    card('What do the heart valves do?', 'They make sure blood flows in one direction only and does not run back.'),
    card('Which two numbers does a blood pressure reading give, and what does the first mean?', 'The systolic and diastolic pressure; the first is the pressure when the heart contracts, for example 120 over 80.'),
];

const G_UK = [
    card('Хто охрестив Русь і в якому році це сталося?', 'Князь Володимир Великий охрестив Русь у 988 році.'),
    card('Яке місто було столицею Київської Русі?', 'Київ, розташований на Дніпрі.'),
    card('Що таке «Руська правда»?', 'Найдавніший збірник законів Київської Русі, пов\'язаний із правлінням Ярослава Мудрого.'),
    card('Чим відомий князь Ярослав Мудрий?', 'За його правління Русь досягла розквіту: у Києві збудовано Софійський собор, а закони записано в «Руській правді».'),
    card('Що означає шлях «із варяг у греки»?', 'Торговельний водний шлях від Балтійського моря Дніпром до Чорного моря й Візантії.'),
    card('Що таке княжа дружина?', 'Постійне військо князя, яке також допомагало йому керувати; наприклад, дружина збирала данину з підлеглих земель.'),
];
const G_UK_RU = [
    card('Кто крестил Русь и в каком году это произошло?', 'Князь Владимир Великий крестил Русь в 988 году.'),
    card('Какой город был столицей Киевской Руси?', 'Киев, расположенный на Днепре.'),
    card('Что такое «Русская правда»?', 'Древнейший сборник законов Киевской Руси, связанный с правлением Ярослава Мудрого.'),
    card('Чем известен князь Ярослав Мудрый?', 'При нём Русь достигла расцвета: в Киеве построен Софийский собор, а законы записаны в «Русской правде».'),
    card('Что означает путь «из варяг в греки»?', 'Торговый водный путь от Балтийского моря по Днепру к Чёрному морю и в Византию.'),
    card('Что такое княжеская дружина?', 'Постоянное войско князя, которое также помогало ему управлять; например, дружина собирала дань с подчинённых земель.'),
];

const CASES = [
    {
        id: 'cards-en-organelles', course: 'cells', lang: 'en', G: G_CELLS,
        mutants: [
            ...commonMutants(G_CELLS, ['Mitochondrion', 'Ribosome', 'Chloroplast', 'Golgi apparatus', 'Nucleus', 'Cell wall']),
            { name: 'written in Dutch', reply: j(G_CELLS_NL) },
        ],
    },
    {
        id: 'cards-en-suvat-formulas', course: 'suvat', lang: 'en', G: G_SUVAT,
        mutants: [
            ...commonMutants(G_SUVAT, ['Final velocity', 'Displacement', 'Time-free equation', 'Distance travelled', 'Gravity', 'Graph area']),
            { name: 'TeX written with single backslashes (invalid JSON)', reply: singleBackslash(j(G_SUVAT)) },
            { name: 'TeX commands read as JSON escapes (form feed, tab)', reply: singleBackslash(j(G_SUVAT_FRAC)) },
        ],
    },
    {
        id: 'cards-nl-heart', course: 'nl', lang: 'nl', G: G_NL,
        mutants: [
            ...commonMutants(G_NL, ['Hartkleppen', 'Boezems', 'Longslagader', 'Slagader', 'Bloeddruk', 'Hartslag']),
            { name: 'written in English', reply: j(G_NL_EN) },
        ],
    },
    {
        id: 'cards-uk-kyivan-rus', course: 'uk', lang: 'uk', G: G_UK,
        mutants: [
            ...commonMutants(G_UK, ['Володимир', 'Київ', 'Руська правда', 'Ярослав Мудрий', 'Варяги', 'Дружина']),
            { name: 'written in Russian', reply: j(G_UK_RU) },
            { name: 'written in English', reply: j(G_NL_EN) },
        ],
    },
];

export default {
    category: 'flashcards',
    label: 'Writing flashcards',
    setup,
    cases: CASES.map(c => ({
        id: c.id,
        run: (fx, app) => runCards(app, fx.ids[c.course]),
        score: cardScore(c.lang),
        golden: j(c.G),
        mutants: c.mutants,
    })),
};
