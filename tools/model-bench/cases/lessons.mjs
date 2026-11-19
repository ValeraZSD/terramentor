/**
 * Writing lessons: one segment of a topic's lesson in the feed.
 *
 * Each case rebuilds one pass of the lesson author in server/feedGen.js:1216-1230 for
 * part 1 of a three-part outline: AI_PROMPTS.feed_lesson with the node context the app
 * builds (buildNodeContext with completedTopics, plus courseContextForNode), the node's
 * declared language, widgets allowed per the feed settings, then
 * generateResponse(user, system, [], { temperature: 0.6, operation: 'authoring' }) and
 * stripSelfCertifyingCloser. A part-1 call has no earlier parts, so there is no running
 * example, and none of the topics below starts with an action verb (isActionNode). The
 * 12,000-character clamp (feedGen.js:907) can only shorten a reply that is already far over
 * the length bound below, so it is not repeated.
 *
 * Pass: lessonDefects (server/feedQuality.js:211) returns nothing, which covers a too-short
 * segment, a stale "as you learned in the previous lesson", an unclosed fence, a script that
 * does not belong, drift back to English, ASCII art and a sum of multiples of one symbol that
 * does not add up (linearCombinationFaults); and the segment's word count is within the
 * prompt's 200-350 words, with a fifth of slack either side (160-420), counting prose only.
 *
 * Proxies: the word bound is the prompt's with that slack. For Dutch, Russian and Ukrainian
 * the app's English-drift check is joined by a Dutch function-word check and a Cyrillic
 * letter check; the Ukrainian one also rejects Russian-only letters, the usual drift. An
 * English lesson gets the English function-word check (english.mjs): the app's drift
 * check only looks for drift towards English, so it passes a Dutch lesson.
 */
import { englishFault } from './english.mjs';

const LOW = 160;
const HIGH = 420;

const COURSES = [
    {
        key: 'waves', name: 'Physics: waves', lang: 'en',
        node: {
            title: 'Standing waves on a string',
            description: 'Why a string fixed at both ends only vibrates in certain patterns: nodes at the ends, whole numbers of half wavelengths, the harmonic series and the frequency formula $f_n = nv/2L$.',
            notes: 'Typical exam question: given the length and the wave speed, find the fundamental and the third harmonic.',
        },
        outline: [
            { title: 'Harmonics of a fixed string', focus: 'why only certain wavelengths fit between two fixed ends, and the frequencies that follow, with one worked example' },
            { title: 'Pitch, tension and mass', focus: 'how the wave speed on the string, and so the pitch, depends on tension and mass per length' },
            { title: 'Overtones in real instruments', focus: 'why a plucked string sounds like one note with a richer tone' },
        ],
    },
    {
        key: 'revolution', name: 'Modern European history', lang: 'en',
        node: {
            title: 'Causes of the French Revolution',
            description: 'The fiscal crisis of the monarchy, the unequal tax system of the three estates, the failure of reform and the calling of the Estates-General in 1789.',
            notes: 'Focus on cause and consequence rather than on dates alone.',
        },
        outline: [
            { title: 'The financial crisis of the monarchy', focus: 'war debt, the unequal tax system, and why reform failed' },
            { title: 'Bread and the harvest of 1788', focus: 'how a bad harvest turned a political crisis into popular unrest' },
            { title: 'The Estates-General', focus: 'who sat in it and why voting by order mattered' },
        ],
    },
    {
        key: 'search', name: 'Algorithms with Python', lang: 'en',
        node: {
            title: 'Binary search',
            description: 'Searching a sorted list by repeatedly halving the part still in play: the idea, the loop in Python, tracing an example and the off-by-one mistakes.',
            notes: 'Learners already know lists, indexing and while loops.',
        },
        outline: [
            { title: 'The idea and the loop', focus: 'halving a sorted list, and the Python implementation traced on a small example' },
            { title: 'How fast is it', focus: 'counting the comparisons: log2 of n versus n' },
            { title: 'Binary search beyond lists', focus: 'searching for an answer in a range, such as a square root' },
        ],
    },
    {
        key: 'nl', name: 'Geschiedenis: de Republiek', lang: 'nl',
        node: {
            title: 'De Gouden Eeuw',
            description: 'Waarom de Republiek in de zeventiende eeuw zo rijk werd: handel, de VOC, de beurs van Amsterdam en verdraagzaamheid, en ook de keerzijde met geweld en slavenhandel.',
            notes: 'Leg uit waarom handel, niet landbouw of legers, de bron van de rijkdom was.',
        },
        outline: [
            { title: 'Waarom Amsterdam rijk werd', focus: 'ligging, de VOC en verdraagzaamheid als bronnen van rijkdom' },
            { title: 'Kunst en wetenschap', focus: 'wat de rijkdom mogelijk maakte: schilderkunst, drukkerijen en de grachtengordel' },
            { title: 'De keerzijde', focus: 'geweld en slavenhandel binnen het Nederlandse handelsimperium' },
        ],
    },
    {
        key: 'ru', name: 'Физика: давление', lang: 'ru',
        node: {
            title: 'Закон Архимеда',
            description: 'Выталкивающая сила, действующая на тело в жидкости: формула $F_A = \\rho g V$, объём погружённой части, плотность жидкости и условие плавания тел.',
            notes: 'Задачи на силу Архимеда для кубика и бруска; $g = 10\\ \\text{м/с}^2$.',
        },
        outline: [
            { title: 'Выталкивающая сила', focus: 'формулировка закона, формула и один числовой пример' },
            { title: 'Плавание тел', focus: 'когда тело всплывает, плавает или тонет' },
            { title: 'Корабли и подводные лодки', focus: 'как изменение объёма вытесненной воды управляет погружением' },
        ],
    },
    {
        key: 'uk', name: 'Біологія: рослини', lang: 'uk',
        node: {
            title: 'Фотосинтез',
            description: 'Як рослина з вуглекислого газу й води за допомогою світла утворює глюкозу та кисень: хлоропласти, хлорофіл, продихи, походження кисню.',
            notes: 'Часті помилки: кисень походить із води, а не з вуглекислого газу; рослини дихають і вдень, і вночі.',
        },
        outline: [
            { title: 'Що відбувається в листку', focus: 'загальне рівняння, місце процесу в клітині та шлях газів і води' },
            { title: 'Світлова й темнова стадії', focus: 'що відбувається в тилакоїдах і в стромі' },
            { title: 'Що обмежує швидкість', focus: 'світло, температура й вуглекислий газ' },
        ],
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

async function runLesson(app, course) {
    const nodeId = course.nodeId;
    const { AI_PROMPTS, buildNodeContext, generateResponse } = app.ai;
    const { getNodeLanguage } = await app.server('language.js');
    const { getFeedSettings } = await app.server('feed.js');
    const { courseContextForNode } = await app.server('courseContext.js');
    const { stripSelfCertifyingCloser } = await app.server('feedQuality.js');
    const lang = getNodeLanguage(nodeId);
    const context = buildNodeContext(nodeId, { completedTopics: true }) + courseContextForNode(nodeId);
    const { system, user } = AI_PROMPTS.feed_lesson(
        course.node.title, course.outline, 1, context, [],
        { allowWidget: getFeedSettings().widgets, actionNode: false, runningExample: '', lang, priorFault: null, review: false },
    );
    const raw = await generateResponse(user, system, [], { temperature: 0.6, operation: 'authoring', answered: {} });
    return { md: stripSelfCertifyingCloser(raw, lang), nodeId };
}

const wordsOf = (s) => String(s).toLowerCase().match(/\p{L}+/gu) || [];
const proseOnly = (s) => String(s)
    .replace(/^```[\s\S]*?^```/gm, ' ').replace(/`[^`\n]*`/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]*\$/g, ' ');
const DUTCH = new Set(['de', 'het', 'een', 'van', 'en', 'is', 'in', 'op', 'te', 'dat', 'die', 'voor', 'met', 'zijn', 'niet', 'om', 'aan', 'er', 'ook', 'als', 'dan', 'bij', 'of', 'wat', 'hoe', 'wordt', 'naar', 'door', 'uit', 'maar', 'deze', 'dit', 'ze']);

function languageProblem(text, code) {
    const prose = proseOnly(text);
    if (code === 'en') return englishFault(prose);
    const words = wordsOf(prose);
    if (code === 'nl') {
        const share = words.filter(w => DUTCH.has(w)).length / (words.length || 1);
        if (share < 0.1) return `does not read as Dutch (function-word share ${share.toFixed(2)})`;
    }
    if (code === 'ru' || code === 'uk') {
        const letters = prose.match(/\p{L}/gu) || [];
        const cyr = letters.filter(ch => /[\u0400-\u04FF]/.test(ch)).length;
        if (cyr / (letters.length || 1) < 0.8) return 'mostly not Cyrillic';
        if (code === 'ru' && /[іїєґ]/i.test(prose)) return 'has Ukrainian-only letters in a Russian course';
        if (code === 'uk' && /[ыэъё]/i.test(prose)) return 'has Russian-only letters in a Ukrainian course';
        if (code === 'uk' && !/[іїє]/i.test(prose)) return 'no Ukrainian letters at all';
    }
    return null;
}

function lessonScore(lang) {
    return async (out, fx, app) => {
        const { lessonDefects } = await app.server('feedQuality.js');
        const defects = lessonDefects(out.md, out.nodeId);
        if (defects.length) return { pass: false, why: `lessonDefects: ${defects.join('; ').slice(0, 220)}` };
        const n = wordsOf(proseOnly(out.md)).length;
        if (n < LOW || n > HIGH) return { pass: false, why: `${n} words, outside ${LOW}-${HIGH} (the prompt asks 200-350)` };
        const problem = languageProblem(out.md, lang);
        if (problem) return { pass: false, why: problem };
        return { pass: true, why: `no defects, ${n} words` };
    };
}

// ---------------------------------------------------------------- the lessons

const L_WAVES = `A string fixed at both ends cannot vibrate in just any pattern. Its two ends are nodes, points that cannot move, so only wave patterns with a node at each end can last. That rule picks out a family of standing waves called harmonics.

The simplest pattern is one loop. It fits half a wavelength between the ends, so for a string of length $L$ the fundamental has $L = \\lambda/2$, which gives $\\lambda_1 = 2L$. The next pattern has a node in the middle and two loops, so $L = \\lambda/2 + \\lambda/2 = \\lambda$. Each extra loop adds another half wavelength:

$$\\lambda_n = \\frac{2L}{n}, \\qquad n = 1, 2, 3, \\dots$$

The frequency follows from the wave speed $v$ on the string, because $f = v/\\lambda$. Substituting $\\lambda_n$ gives

$$f_n = \\frac{nv}{2L} = n f_1.$$

Every harmonic is a whole-number multiple of the fundamental. That is why a plucked string sounds like one clear pitch with a richer tone on top.

**Worked example.** A guitar string is $L = 0.60\\ \\text{m}$ long and waves travel along it at $v = 240\\ \\text{m/s}$.

The fundamental is $f_1 = v/(2L) = 240/(2 \\times 0.60) = 240/1.2 = 200\\ \\text{Hz}$.

For the third harmonic three loops fit, so $L = \\lambda/2 + \\lambda/2 + \\lambda/2 = 3\\lambda/2$, which gives $\\lambda_3 = 2L/3 = 0.40\\ \\text{m}$. Then $f_3 = v/\\lambda_3 = 240/0.40 = 600\\ \\text{Hz}$, exactly $3 \\times 200\\ \\text{Hz}$.

A common mistake is to count nodes instead of loops. The third harmonic has four nodes, counting the two ends, but only three loops, and it is the number of loops that gives $n$.

The next part asks what happens to these frequencies when the tension in the string changes.`;

// L_WAVES translated into Dutch, the maths unchanged: it passes the word bound and the
// app's lesson checks, so only the language check can catch it in an English course.
const L_WAVES_NL = `Een snaar die aan beide uiteinden vastzit, kan niet in elk willekeurig patroon trillen. De twee uiteinden zijn knopen, punten die niet kunnen bewegen, dus alleen golfpatronen met een knoop aan elk uiteinde blijven bestaan. Die regel kiest een familie van staande golven uit, de harmonischen.

Het eenvoudigste patroon is een buik. Daarin past een halve golflengte tussen de uiteinden, dus voor een snaar met lengte $L$ geldt voor de grondtoon $L = \\lambda/2$, en dat geeft $\\lambda_1 = 2L$. Het volgende patroon heeft een knoop in het midden en twee buiken, dus $L = \\lambda/2 + \\lambda/2 = \\lambda$. Elke extra buik voegt nog een halve golflengte toe:

$$\\lambda_n = \\frac{2L}{n}, \\qquad n = 1, 2, 3, \\dots$$

De frequentie volgt uit de golfsnelheid $v$ op de snaar, want $f = v/\\lambda$. Invullen van $\\lambda_n$ geeft

$$f_n = \\frac{nv}{2L} = n f_1.$$

Elke harmonische is een geheel veelvoud van de grondtoon. Daarom klinkt een getokkelde snaar als een heldere toonhoogte met een rijkere klank erbovenop.

**Uitgewerkt voorbeeld.** Een gitaarsnaar is $L = 0.60\\ \\text{m}$ lang en golven bewegen erlangs met $v = 240\\ \\text{m/s}$.

De grondtoon is $f_1 = v/(2L) = 240/(2 \\times 0.60) = 240/1.2 = 200\\ \\text{Hz}$.

Voor de derde harmonische passen er drie buiken, dus $L = \\lambda/2 + \\lambda/2 + \\lambda/2 = 3\\lambda/2$, en dat geeft $\\lambda_3 = 2L/3 = 0.40\\ \\text{m}$. Dan is $f_3 = v/\\lambda_3 = 240/0.40 = 600\\ \\text{Hz}$, precies $3 \\times 200\\ \\text{Hz}$.

Een veelgemaakte fout is knopen tellen in plaats van buiken. De derde harmonische heeft vier knopen, de twee uiteinden meegeteld, maar maar drie buiken, en het aantal buiken geeft $n$.

Het volgende deel gaat over wat er met deze frequenties gebeurt als de spanning in de snaar verandert.`;

const L_REVOLUTION = `By 1788 the French crown was close to bankruptcy, and nearly every road out of the crisis ran through a group that refused to pay. Understanding why starts with how the state spent money and how it collected it.

The biggest costs were war and debt. France had fought Britain for decades, and its support for the American Revolution was paid for with loans at high interest. By the 1780s the interest on that debt alone took roughly half of the crown's yearly spending.

Collecting more was hard because the tax system was unequal. The clergy, the First Estate, and the nobility, the Second Estate, were largely exempt from the main direct tax, the taille. The burden fell on the Third Estate: the peasants, townspeople and professionals who made up the vast majority of the population. They also paid the church tithe, feudal dues to their landlords and heavy indirect taxes such as the salt tax, the gabelle. Raising rates on those who already paid most risked unrest.

Finance ministers saw the problem and tried reform. Turgot, Necker and Calonne each proposed ending exemptions or taxing land more evenly, and each was dismissed after the privileged orders resisted. The Parlements, law courts staffed by nobles, refused to register new taxes. In 1787 an Assembly of Notables, hand-picked to approve reform, refused as well.

With no other body able to grant a new tax, Louis XVI agreed in 1788 to summon the Estates-General, which had not met since 1614. A crisis of money had become a crisis of who held the authority to decide.

A failed harvest in 1788 and a bitter winter would soon make bread unaffordable, which is where the next part picks up.`;

const L_SEARCH = `Searching a list item by item takes up to $n$ steps for $n$ items. If the list is sorted, you can do far better by throwing away half of what is left at every step. That is binary search.

The idea: look at the middle item. If it is the one you want, you are done. If the target is smaller, it can only be in the left half, so ignore everything from the middle to the right. If it is larger, ignore the left half. Repeat on what remains until you find the target or nothing is left. A sorted list is essential: the whole argument that the target must lie "to the left" depends on the order.

Here is the loop in Python, with two indexes, \`low\` and \`high\`, that mark the part of the list still in play:

\`\`\`python
def binary_search(items, target):
    low, high = 0, len(items) - 1
    while low <= high:
        mid = (low + high) // 2
        if items[mid] == target:
            return mid
        if items[mid] < target:
            low = mid + 1
        else:
            high = mid - 1
    return -1
\`\`\`

Trace it on \`[2, 5, 8, 12, 16, 23]\` with the target \`12\`. At first \`low = 0\` and \`high = 5\`, so \`mid = 2\` and \`items[2]\` is \`8\`. That is smaller than 12, so the answer lies to the right: \`low = 3\`. Now \`mid = (3 + 5) // 2 = 4\` and \`items[4]\` is \`16\`, which is larger, so \`high = 3\`. With \`low = 3\` and \`high = 3\`, \`mid = 3\`, \`items[3]\` is \`12\`, and the function returns \`3\`. Three comparisons were enough for six items.

Two details cause most bugs. The loop condition is \`low <= high\`, not \`<\`, because a single remaining item must still be checked. And the updates are \`mid + 1\` and \`mid - 1\`, not \`mid\`: the middle was already tested, and keeping it in play can loop forever.

The next part measures how much faster this is than scanning.`;

const L_NL = `In de zeventiende eeuw werd de Republiek der Zeven Verenigde Nederlanden een van de rijkste landen van Europa. Die periode noemen we de Gouden Eeuw. De rijkdom kwam niet uit de grond of uit grote legers, maar uit handel.

Een eerste reden was de ligging. Amsterdam, Rotterdam en andere steden lagen aan zee en aan grote rivieren, zodat schepen goederen uit het Oostzeegebied, Frankrijk en later Azië naar heel Europa konden brengen. Nederlandse schippers waren goedkoop en betrouwbaar, mede dankzij het fluitschip, een schip dat veel lading droeg met weinig bemanning.

Een tweede reden was de manier waarop geld werd georganiseerd. In 1602 richtten kooplieden de Verenigde Oostindische Compagnie op, de VOC. Wie wilde, kon aandelen kopen, en zo werd het risico van een verre en gevaarlijke reis verdeeld over veel mensen. De VOC kreeg het alleenrecht op de handel tussen Nederland en Azië en bracht onder andere specerijen, zoals peper en nootmuskaat, naar Europa. Amsterdam kreeg bovendien een beurs en een bank, waar kooplieden elkaar konden vinden en geld konden lenen.

Een derde reden was verdraagzaamheid. In de Republiek konden mensen die elders werden vervolgd, zoals protestanten uit de Zuidelijke Nederlanden en joden uit Portugal, relatief veilig wonen. Zij brachten kennis, geld en handelscontacten mee.

Let op: de handel bracht niet alleen rijkdom. De VOC en de West-Indische Compagnie waren ook betrokken bij geweld tegen lokale bevolkingen en bij slavenhandel. Een goed beeld van de Gouden Eeuw bevat dus beide kanten.

In het volgende deel kijken we naar wat al dat geld mogelijk maakte: kunst, wetenschap en de bouw van de grachtengordel.`;

const L_NL_EN = `In the seventeenth century the Dutch Republic became one of the richest countries in Europe. We call this period the Golden Age. The wealth did not come from the land or from large armies, but from trade.

A first reason was the location. Amsterdam, Rotterdam and other cities lay on the sea and on large rivers, so ships could carry goods from the Baltic, France and later Asia to the whole of Europe. Dutch shippers were cheap and reliable, partly thanks to the fluyt, a ship that carried a lot of cargo with a small crew.

A second reason was how money was organised. In 1602 merchants founded the Dutch East India Company, the VOC. Anyone could buy shares, and in that way the risk of a distant and dangerous voyage was spread over many people. The VOC received the sole right to trade between the Netherlands and Asia and brought spices, such as pepper and nutmeg, to Europe. Amsterdam also had an exchange and a bank, where merchants could find each other and borrow money.

A third reason was tolerance. In the Republic people who were persecuted elsewhere could live relatively safely. They brought knowledge, money and trade contacts with them.`;

const L_RU = `Если опустить в воду мячик, он выпрыгивает на поверхность. Если опустить камень, он тонет, но в руке становится «легче». Причина одна: на любое тело, погружённое в жидкость, действует выталкивающая сила, направленная вверх.

Закон Архимеда говорит, чему она равна. Выталкивающая сила равна весу жидкости, вытесненной телом. Если тело вытесняет объём жидкости $V$, то масса этой жидкости равна $\\rho V$, где $\\rho$ — плотность жидкости, а её вес равен $\\rho V g$. Поэтому

$$F_A = \\rho g V.$$

Важны две вещи. Во-первых, в формуле стоит плотность **жидкости**, а не тела. Во-вторых, $V$ — это объём **погружённой части** тела: если брусок погружён лишь наполовину, вытесняется только половина его объёма.

**Пример.** Алюминиевый кубик с ребром 10 см полностью погружён в воду. Найдём выталкивающую силу, взяв $g = 10\\ \\text{м/с}^2$ и плотность воды $1000\\ \\text{кг/м}^3$.

Сначала объём: $V = 0{,}1 \\cdot 0{,}1 \\cdot 0{,}1 = 0{,}001\\ \\text{м}^3$. Затем сила: $F_A = 1000 \\cdot 10 \\cdot 0{,}001 = 10\\ \\text{Н}$.

Заметьте, что плотность алюминия в расчёт вообще не вошла. Выталкивающая сила была бы той же для кубика такого же размера из дерева или из свинца. От материала зависит другое: вес кубика. Алюминиевый кубик весит около 27 Н, то есть больше 10 Н, поэтому он тонет, хотя в воде «весит» лишь 17 Н.

Удобно помнить и такой факт: тело объёмом один литр вытесняет один литр воды, то есть около килограмма, а вес килограмма воды при $g = 10\\ \\text{м/с}^2$ равен 10 Н. Совпадение с нашим кубиком не случайно: его объём как раз один литр.

Типичная ошибка — подставить в формулу плотность тела и получить неверный ответ. Всегда спрашивайте себя: какая жидкость вытеснена и сколько её?

В следующей части выясним, когда тело плавает, а когда тонет.`;

const L_RU_EN = `If you lower a ball into water, it pops up to the surface. If you lower a stone, it sinks, but it feels lighter in your hand. There is one reason: any body immersed in a liquid is pushed upward by a buoyant force.

Archimedes' principle says how large it is. The buoyant force equals the weight of the liquid the body displaces. If the body displaces a volume $V$ of liquid, the mass of that liquid is $\\rho V$, where $\\rho$ is the density of the liquid, and its weight is $\\rho V g$. So $F_A = \\rho g V$.

Two things matter. First, the density in the formula is that of the liquid, not of the body. Second, $V$ is the volume of the part of the body that is under the surface: if a block is only half submerged, only half of its volume is displaced.

Example. An aluminium cube with a 10 cm edge is completely under water. Take $g = 10$ and the density of water as 1000. The volume is 0.001 cubic metres, so the force is 1000 times 10 times 0.001, which is 10 newtons. Notice that the density of aluminium never entered the calculation. The same force would act on a wooden cube or a lead cube of the same size. What depends on the material is the weight of the cube.`;

const L_UK = `Рослини не їдять, але ростуть і накопичують масу. Звідки вона береться? Головне джерело — повітря й вода, а енергію для перетворення дає світло. Цей процес називають фотосинтезом.

Загальна схема проста: з вуглекислого газу й води, використовуючи енергію світла, рослина утворює глюкозу та виділяє кисень. Її записують так:

$$6\\text{CO}_2 + 6\\text{H}_2\\text{O} \\xrightarrow{\\text{світло}} \\text{C}_6\\text{H}_{12}\\text{O}_6 + 6\\text{O}_2$$

Фотосинтез відбувається в хлоропластах, які є здебільшого в клітинах листка. Зелений пігмент хлорофіл поглинає світло, тому листки здаються зеленими: червоне й синє світло він поглинає добре, а зелене здебільшого відбиває.

Листок побудований так, щоб ловити світло: він плоский і тонкий, тож світло досягає майже всіх клітин, а найбільше хлоропластів міститься в клітинах під верхньою шкіркою.

Вуглекислий газ потрапляє в листок через дрібні отвори на нижньому боці, які називають продихами. Воду рослина бере з ґрунту корінням, і вона піднімається до листя судинами. Кисень, що утворюється, виходить назовні тими самими продихами.

Часта помилка — вважати, що кисень, який виділяє рослина, походить із вуглекислого газу. Насправді його джерело — вода: під час світлової стадії молекули води розщеплюються, і саме їхні атоми Оксигену потрапляють у молекули $\\text{O}_2$.

Інша помилка — думати, що рослини дихають лише вночі. Дихають вони постійно, а вдень фотосинтез просто йде швидше, ніж дихання, тому кисню в підсумку виділяється більше, ніж поглинається.

Далі ми розглянемо, від чого залежить швидкість фотосинтезу: від освітлення, температури та кількості вуглекислого газу.`;

const L_UK_RU = `Растения не едят, но растут и накапливают массу. Откуда она берётся? Главный источник — воздух и вода, а энергию для превращения даёт свет. Этот процесс называют фотосинтезом.

Общая схема проста: из углекислого газа и воды, используя энергию света, растение образует глюкозу и выделяет кислород. Фотосинтез происходит в хлоропластах, которые есть в основном в клетках листа. Зелёный пигмент хлорофилл поглощает свет, поэтому листья кажутся зелёными: красный и синий свет он поглощает хорошо, а зелёный в основном отражает.

Углекислый газ попадает в лист через мелкие отверстия на нижней стороне, которые называют устьицами. Воду растение берёт из почвы корнями, и она поднимается к листьям по сосудам. Образующийся кислород выходит наружу через те же устьица.

Частая ошибка — считать, что кислород, который выделяет растение, происходит из углекислого газа. На самом деле его источник — вода: во время световой стадии молекулы воды расщепляются, и именно их атомы кислорода попадают в молекулы кислорода.

Другая ошибка — думать, что растения дышат только ночью. Дышат они постоянно, а днём фотосинтез просто идёт быстрее дыхания, поэтому кислорода в итоге выделяется больше, чем поглощается.`;

const UNCLOSED = '\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]';
const shortOf = (t) => t.split('\n\n')[0].slice(0, 170);
const tooLong = (t) => `${t}\n\n${t}\n\n${t}`;
const ART = '\n\n+--------+--------+\n|  step  |  step  |\n+--------+--------+\n';

const CASES = [
    {
        id: 'lesson-en-standing-waves-worked-example', course: 'waves', lang: 'en', golden: L_WAVES,
        mutants: [
            { name: 'worked example adds up wrongly (3 half wavelengths = 2 wavelengths)', reply: L_WAVES.replace('= 3\\lambda/2$', '= 2\\lambda$') },
            { name: 'recalls the previous lesson as if just studied', reply: `As you learned in the previous lesson, waves carry energy. ${L_WAVES}` },
            { name: 'diagram fence never closed', reply: L_WAVES + UNCLOSED },
            { name: 'written in Dutch', reply: L_WAVES_NL },
        ],
    },
    {
        id: 'lesson-en-french-revolution', course: 'revolution', lang: 'en', golden: L_REVOLUTION,
        mutants: [
            { name: 'a sentence in Chinese inside the lesson', reply: L_REVOLUTION.replace('Understanding why starts', '这场危机源于财政问题。Understanding why starts') },
            { name: 'too short to teach anything', reply: shortOf(L_REVOLUTION) },
            { name: 'draws a table out of characters', reply: L_REVOLUTION + ART },
        ],
    },
    {
        id: 'lesson-en-binary-search-code', course: 'search', lang: 'en', golden: L_SEARCH,
        mutants: [
            { name: 'code fence never closed', reply: L_SEARCH.replace(/\n```\n\nTrace/, '\n\nTrace') },
            { name: 'three times the length asked for', reply: tooLong(L_SEARCH) },
            { name: 'no teaching, only one sentence', reply: 'Binary search repeatedly halves a sorted list.' },
        ],
    },
    {
        id: 'lesson-nl-golden-age', course: 'nl', lang: 'nl', golden: L_NL,
        mutants: [
            { name: 'written in English', reply: L_NL_EN },
            { name: 'too short to teach anything', reply: shortOf(L_NL) },
            { name: 'fence never closed', reply: L_NL + UNCLOSED },
        ],
    },
    {
        id: 'lesson-ru-archimedes', course: 'ru', lang: 'ru', golden: L_RU,
        mutants: [
            { name: 'written in English', reply: L_RU_EN },
            { name: 'a sentence in Chinese inside the lesson', reply: L_RU.replace('Закон Архимеда говорит', '阿基米德原理说明了浮力的大小。Закон Архимеда говорит') },
            { name: 'too short to teach anything', reply: shortOf(L_RU) },
        ],
    },
    {
        id: 'lesson-uk-photosynthesis', course: 'uk', lang: 'uk', golden: L_UK,
        mutants: [
            { name: 'written in Russian', reply: L_UK_RU },
            { name: 'written in English', reply: L_RU_EN },
            { name: 'too short to teach anything', reply: shortOf(L_UK) },
        ],
    },
];

export default {
    category: 'lessons',
    label: 'Writing lessons',
    setup,
    cases: CASES.map(c => ({
        id: c.id,
        run: (fx, app) => runLesson(app, { ...COURSES.find(k => k.key === c.course), nodeId: fx.ids[c.course] }),
        score: lessonScore(c.lang),
        golden: c.golden,
        mutants: c.mutants,
    })),
};
