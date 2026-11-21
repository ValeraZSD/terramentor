/**
 * The words in front of a topic's "Watch on YouTube" search: the real
 * `writeSearchWords` (server/searchWords.js), which reads a course's topic
 * leaves, asks once and validates the reply with `validateSearchWords`. The app
 * accepts any 1-4 word string that is no filler or refusal, so each case adds
 * what the prompt's rules demand: the course's own subject, in the language of
 * the topic titles, and no words about format or level. That part is a regex
 * over the allowed answers for the fixture.
 */
const J = (words) => JSON.stringify({ words });

/** A course with one phase and its topics as leaves; returns the course row. */
function makeCourse(db, { name, description, titles, phase = 'Phase 1' }) {
    const p = db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)').run(name, description).lastInsertRowid;
    const ph = db.prepare('INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, ?, 0)').run(p, phase).lastInsertRowid;
    titles.forEach((t, i) => db.prepare('INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, ?, ?, ?)').run(p, ph, t, i));
    return { id: Number(p), name, description };
}

const ask = (key) => async (fx, app) => {
    const { writeSearchWords } = await app.server('searchWords.js');
    return writeSearchWords(fx[key], {});
};

const expect = (re, label) => (out) => {
    if (out.words === null) return { pass: false, why: `no usable words: ${out.reason}` };
    if (!re.test(out.words)) return { pass: false, why: `"${out.words}" is not ${label}` };
    return { pass: true, why: `"${out.words}"` };
};

export default {
    category: 'search-words',
    label: 'Search words',
    async setup(app) {
        const db = app.db;
        return {
            rust: makeCourse(db, {
                name: 'Learn Rust from scratch', description: 'Systems programming without a garbage collector.',
                titles: ['Ownership', 'Borrowing and references', 'Lifetimes', 'Structs and enums', 'Error handling with Result', 'Traits and generics', 'Cargo and crates'],
            }),
            ruDutch: makeCourse(db, {
                name: 'Нидерландский язык: с нуля до B1', description: 'Хочу переехать и говорить с коллегами.',
                titles: ['Алфавит и произношение', 'Артикли de и het', 'Глагол zijn и hebben', 'Порядок слов в предложении', 'Прошедшее время', 'Числа и время', 'Разговор в магазине'],
            }),
            nlPhysics: makeCourse(db, {
                name: 'Natuurkunde havo 4: mechanica', description: 'Voorbereiding op de toets over krachten en beweging.',
                titles: ['Snelheid en versnelling', 'De wetten van Newton', 'Zwaartekracht en gewicht', 'Arbeid en kinetische energie', 'Wrijving en luchtweerstand', 'Impuls en botsingen'],
            }),
            mixed: makeCourse(db, {
                name: 'Things to get around to', description: '',
                titles: ['Sourdough starters', 'Filing a tax return', 'Swedish irregular verbs', 'Watercolour washes', 'Changing a bicycle tyre', 'Chess endgames'],
            }),
        };
    },
    cases: [
        {
            id: 'search-words-rust-english',
            run: ask('rust'),
            score: expect(/^rust( (language|lang|programming))?$/i, 'the subject (Rust)'),
            golden: J('Rust'),
            mutants: [
                { name: 'too general', reply: J('programming') },
                { name: 'a single topic', reply: J('Rust ownership') },
                { name: 'format words added', reply: J('Rust tutorial for beginners') },
                { name: 'the course name copied', reply: J('Learn Rust from scratch') },
                { name: 'a placeholder', reply: J('null') },
                { name: 'a refusal', reply: J('not applicable') },
            ],
        },
        {
            id: 'search-words-russian-titles-dutch-language',
            run: ask('ruDutch'),
            // Proxy for "the titles' language": a Cyrillic word for the Dutch language.
            score: expect(/^(нидерландск\p{L}*|голландск\p{L}*)( язык\p{L}*)?$/iu, 'the Russian name of the Dutch language'),
            golden: J('нидерландский язык'),
            mutants: [
                { name: 'English word', reply: J('Dutch') },
                { name: 'format words', reply: J('курс нидерландского') },
                { name: 'wrong language entirely', reply: J('немецкий язык') },
                { name: 'a single topic', reply: J('артикли de и het') },
                { name: 'a sentence', reply: J('Это курс нидерландского языка.') },
            ],
        },
        {
            id: 'search-words-dutch-physics',
            run: ask('nlPhysics'),
            score: expect(/^(natuurkunde|mechanica|natuurkunde mechanica|mechanica natuurkunde)$/i, 'the course subject in Dutch (natuurkunde or mechanica)'),
            golden: J('natuurkunde'),
            mutants: [
                { name: 'English word', reply: J('physics') },
                { name: 'level words', reply: J('natuurkunde voor beginners') },
                { name: 'too general', reply: J('wetenschap') },
                { name: 'a single topic', reply: J('wetten van Newton') },
                { name: 'two subjects listed', reply: J('natuurkunde, wiskunde') },
            ],
        },
        {
            // Rule 6: topics that share no subject get {"words": ""}.
            id: 'search-words-mixed-course-empty',
            run: ask('mixed'),
            score: (out) => out.words === ''
                ? { pass: true, why: 'nothing to add, as asked' }
                : { pass: false, why: out.words === null ? `no usable answer: ${out.reason}` : `invented words for unrelated topics: "${out.words}"` },
            golden: J(''),
            mutants: [
                { name: 'picks one topic', reply: J('sourdough') },
                { name: 'invents a umbrella word', reply: J('life skills') },
                { name: 'says it in words', reply: J('no specific subject') },
            ],
        },
    ],
};
