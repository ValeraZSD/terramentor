/**
 * Naming a new course: `decideProjectIdentity` (server/projectIdentity.js) reads
 * what the learner typed, keeps what is good and rewrites the rest. It never
 * throws on a bad answer; a reply it cannot use leaves the learner's own text
 * and `fellBack: true`. Each case is one model request when the reply is usable.
 *
 * The app's own cleaners decide whether a name or description is acceptable
 * (`cleanProposedName`, `cleanProposedDescription`, `inLanguage`); on top of
 * them the cases check the prompt's own limits (a name of at most 6 words and
 * 60 characters) and that the subject survived. Dutch and Russian description
 * checks are a function-word and letter-set proxy.
 */
const J = (o) => JSON.stringify(o);

const wordsOf = (t) => String(t || '').toLowerCase().match(/\p{L}+/gu) || [];
const share = (ws, set) => ws.filter(w => set.has(w)).length / Math.max(1, ws.length);
const EN = new Set(['the', 'and', 'that', 'with', 'this', 'are', 'can', 'you', 'your', 'how', 'what', 'when', 'from', 'which', 'will', 'into', 'using', 'its', 'their', 'why', 'learn']);
const NL = new Set(['de', 'het', 'een', 'en', 'van', 'voor', 'met', 'hoe', 'je', 'om', 'te', 'op', 'naar', 'bij', 'als', 'dat', 'die', 'wat', 'zijn', 'ook', 'aan', 'niet', 'wordt', 'worden', 'door', 'over', 'uit', 'dit', 'kunt', 'kun', 'welke', 'waarom']);

/** null when `text` reads as `code` (en, nl, ru), else why not. */
function languageFault(code, text) {
    const ws = wordsOf(text);
    const letters = (String(text).match(/\p{L}/gu) || []).length || 1;
    const cyr = (String(text).match(/\p{Script=Cyrillic}/gu) || []).length / letters;
    if (code === 'en') {
        if (cyr > 0.05) return 'Cyrillic in an English text';
        if (share(ws, EN) < 0.05) return 'does not read as English';
    } else if (code === 'nl') {
        if (cyr > 0.05) return 'Cyrillic in a Dutch text';
        if (share(ws, NL) < 0.12) return 'does not read as Dutch';
        if (share(ws, EN) > 0.04) return 'English words in a Dutch text';
    } else if (code === 'ru') {
        if (cyr < 0.7) return `not written in Cyrillic (${Math.round(cyr * 100)}%)`;
        if (/[іїєґ]/iu.test(text)) return 'Ukrainian letters in a Russian text';
    }
    return null;
}

async function decide(app, { name, description = '', code }) {
    const { decideProjectIdentity, cleanProposedName, cleanProposedDescription } = await app.server('projectIdentity.js');
    const lang = (await app.server('language.js')).getLanguage(code);
    const out = await decideProjectIdentity({ name, description, lang });
    return { ...out, lang, input: { name, description }, cleanProposedName, cleanProposedDescription };
}

/** A messy or empty field the model had to rewrite: both name and description come from it. */
function scoreRewrite(out, { code, nameRe, notRe }) {
    if (out.fellBack) return { pass: false, why: `no usable verdict (${out.attempts} attempts), the learner's text was kept` };
    if (!out.nameFromAI) return { pass: false, why: `name not replaced, the app kept "${out.name}"` };
    if (out.cleanProposedName(out.name, out.lang) !== out.name) return { pass: false, why: `the app's name cleaner refuses "${out.name}"` };
    // The prompt's own limit (rule 4); the cleaner alone allows ten words.
    if (out.name.split(/\s+/).length > 6 || out.name.length > 60) return { pass: false, why: `name is longer than 6 words or 60 characters: "${out.name}"` };
    if (!nameRe.test(out.name)) return { pass: false, why: `name lost the subject: "${out.name}"` };
    if (notRe && notRe.test(out.name)) return { pass: false, why: `name still carries the typo: "${out.name}"` };
    if (!out.descriptionFromAI) return { pass: false, why: 'no description was written for an empty one' };
    if (out.cleanProposedDescription(out.description, out.lang) !== out.description) return { pass: false, why: 'the app\'s description cleaner refuses it' };
    const lf = languageFault(code, out.description);
    if (lf) return { pass: false, why: `description ${lf}` };
    return { pass: true, why: `"${out.name}"` };
}

const reply = (name, description, reason = 'Name was a request.') =>
    J({ keep_name: false, name, keep_description: false, description, reason });

export default {
    category: 'identity',
    label: 'Naming courses',
    cases: [
        {
            id: 'identity-messy-english-rust',
            run: (fx, app) => decide(app, { name: 'i want to learn rust pls', code: 'en' }),
            score: (out) => scoreRewrite(out, { code: 'en', nameRe: /\brust\b/i }),
            golden: reply('Rust Programming', 'A course on the Rust programming language: ownership and borrowing, structs and enums, error handling, and building small command line programs.'),
            mutants: [
                { name: 'keeps the request as the name', reply: J({ keep_name: true, name: 'i want to learn rust pls', keep_description: false, description: 'A course on the Rust programming language: ownership, borrowing, structs and error handling.', reason: 'Fine.' }) },
                { name: 'name is still a sentence', reply: reply('I want to learn Rust', 'A course on the Rust programming language: ownership, borrowing, structs and error handling.') },
                { name: 'name drops the subject', reply: reply('Systems Programming', 'A course on systems programming with a modern language: memory safety, ownership and error handling.') },
                { name: 'name is nine words', reply: reply('The Complete Beginner Guide To Learning The Rust Language', 'A course on the Rust programming language: ownership, borrowing, structs and error handling.') },
                { name: 'description too short', reply: reply('Rust Programming', 'Rust.') },
                { name: 'not JSON', reply: 'A good name would be Rust Programming.' },
            ],
        },
        {
            id: 'identity-messy-dutch-photosynthesis',
            run: (fx, app) => decide(app, { name: 'ik wil graag leren hoe fotosynthese werkt', code: 'nl' }),
            score: (out) => scoreRewrite(out, { code: 'nl', nameRe: /fotosynthese/i }),
            golden: reply('Fotosynthese', 'Een cursus over hoe planten licht omzetten in energie: de lichtreacties, de Calvincyclus en de rol van chlorofyl in het blad.'),
            mutants: [
                { name: 'English name', reply: reply('Photosynthesis', 'Een cursus over hoe planten licht omzetten in energie: de lichtreacties en de Calvincyclus in het blad.') },
                { name: 'English description', reply: reply('Fotosynthese', 'A course about how plants turn light into energy: the light reactions, the Calvin cycle and the role of chlorophyll in the leaf.') },
                { name: 'keeps the sentence', reply: J({ keep_name: true, name: 'ik wil graag leren hoe fotosynthese werkt', keep_description: false, description: 'Een cursus over hoe planten licht omzetten in energie en suikers in het blad.', reason: 'ok' }) },
                { name: 'name loses the subject', reply: reply('Biologie voor beginners', 'Een cursus over de basis van de biologie: cellen, planten, energie en het leven in het blad.') },
                { name: 'empty JSON object', reply: '{}' },
            ],
        },
        {
            id: 'identity-messy-russian-python',
            run: (fx, app) => decide(app, { name: 'хочу выучить python для анализа данных', code: 'ru' }),
            score: (out) => scoreRewrite(out, { code: 'ru', nameRe: /python/i }),
            golden: reply('Python для анализа данных', 'Курс по языку Python для работы с данными: чтение таблиц, очистка данных, расчёт статистики и построение графиков с помощью pandas и matplotlib.'),
            mutants: [
                { name: 'Latin-only name', reply: reply('Python Data Analysis', 'Курс по языку Python для работы с данными: чтение таблиц, очистка данных и построение графиков.') },
                { name: 'name still opens with the request', reply: reply('Хочу выучить Python', 'Курс по языку Python для работы с данными: чтение таблиц, очистка данных и построение графиков.') },
                { name: 'description in Ukrainian', reply: reply('Python для аналізу даних', 'Курс із мови Python для роботи з даними: читання таблиць, очищення даних і побудова графіків за допомогою pandas.') },
                { name: 'description in English', reply: reply('Python для анализа данных', 'A course on Python for working with data: reading tables, cleaning data and drawing charts with pandas and matplotlib.') },
                { name: 'name loses the subject', reply: reply('Анализ данных', 'Курс по анализу данных: чтение таблиц, очистка данных, расчёт статистики и построение графиков.') },
            ],
        },
        {
            // A good name and a good description: nothing of the learner's may change.
            id: 'identity-good-name-kept',
            run: (fx, app) => decide(app, {
                name: 'Linear Algebra', code: 'en',
                description: 'I am in my first year of engineering and want to understand matrices, determinants and eigenvalues well enough to pass the exam in January.',
            }),
            score: (out) => {
                if (out.fellBack) return { pass: false, why: 'no usable verdict' };
                if (out.name !== out.input.name || out.nameFromAI) return { pass: false, why: `a good name was rewritten: "${out.name}"` };
                if (out.description !== out.input.description || out.descriptionFromAI) return { pass: false, why: 'a good description was rewritten' };
                return { pass: true, why: 'both kept as typed' };
            },
            golden: J({
                keep_name: true, name: 'Linear Algebra', keep_description: true,
                description: 'I am in my first year of engineering and want to understand matrices, determinants and eigenvalues well enough to pass the exam in January.',
                reason: 'Both are clear.',
            }),
            mutants: [
                { name: 'rewrites the name', reply: J({ keep_name: false, name: 'Linear Algebra for Engineers', keep_description: true, description: 'x', reason: 'More specific.' }) },
                { name: 'rewrites the description', reply: J({ keep_name: true, name: 'Linear Algebra', keep_description: false, description: 'A first-year engineering course on matrices, determinants and eigenvalues, with exam practice for the January test.', reason: 'Clearer.' }) },
                { name: 'rewrites both', reply: reply('Matrix Methods', 'A course on matrices, determinants, eigenvalues and their uses in engineering problems.') },
                { name: 'no verdict', reply: 'Both look good to me.' },
            ],
        },
        {
            id: 'identity-typo-name',
            run: (fx, app) => decide(app, { name: 'pyhton progaming for begginers', code: 'en' }),
            // Proxy: the typos are spotted by exact wrong spellings.
            score: (out) => scoreRewrite(out, { code: 'en', nameRe: /\bpython\b/i, notRe: /pyhton|progaming|begginers/i }),
            golden: reply('Python Programming for Beginners', 'A beginner course on the Python language: variables, control flow, functions, lists and dictionaries, and writing small useful scripts.', 'Fixed spelling.'),
            mutants: [
                { name: 'keeps the typos', reply: J({ keep_name: true, name: 'pyhton progaming for begginers', keep_description: false, description: 'A beginner course on the Python language: variables, control flow, functions and small scripts.', reason: 'Fine.' }) },
                { name: 'fixes only one typo', reply: reply('Python progaming for Beginners', 'A beginner course on the Python language: variables, control flow, functions and small scripts.') },
                { name: 'name drops Python', reply: reply('Programming for Beginners', 'A beginner course on programming: variables, control flow, functions and small scripts to start with.') },
                { name: 'name is a question', reply: reply('How do I start programming in Python?', 'A beginner course on the Python language: variables, control flow, functions and small scripts.') },
            ],
        },
    ],
};
