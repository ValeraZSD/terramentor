/**
 * Naming a region of the topic map: the real `nameRegion`
 * (server/regionNaming.js), which shows the model the member titles, reads
 * `{"name": ...}` and runs `validateName` (1-6 words, no digits, no sentence,
 * nothing generic or placeholder). What the validator cannot know is whether
 * the name FITS the topics, so each case adds a regex for the acceptable
 * names; that part is a keyword proxy.
 *
 * The fixtures carry no content language (the "follow the topics" prompt):
 * regionNaming.js regionLanguage() returns the project's language code, a
 * string, to languageDirective(), which reads `.name` and `.endonym` off an
 * object, so a project with a language set sends "undefined (undefined)" in
 * the language rule.
 */
const J = (name) => JSON.stringify({ name });

const members = (project, titles) => titles.map((title, i) => ({ id: i + 1, title, project_id: 1, project_name: project, vec: null }));

const nameIt = (region) => async (fx, app) => {
    const { nameRegion } = await app.server('regionNaming.js');
    return nameRegion(fx[region], { fallback: fx[region].members[0].title });
};

const fits = (re, label, { notRe, mustNotBe } = {}) => (out) => {
    if (out.label === null) return { pass: false, why: `the app refused the name: ${out.reason}` };
    // The prompt asks for 1-4 words; validateName lets a short one-sentence answer through up to 6.
    if (out.label.split(' ').length > 4) return { pass: false, why: `"${out.label}" is more than 4 words` };
    if (!re.test(out.label)) return { pass: false, why: `"${out.label}" is not ${label}` };
    if (notRe && notRe(out.label)) return { pass: false, why: `"${out.label}" ${mustNotBe}` };
    return { pass: true, why: `"${out.label}"` };
};

export default {
    category: 'regions',
    label: 'Naming map regions',
    async setup() {
        return {
            languages: {
                centroid: null,
                members: [
                    ...members('Dutch A2', ['Dutch verb conjugation', 'Articles de and het']),
                    ...members('Spanish basics', ['Spanish verb conjugation', 'Ser and estar']),
                    ...members('Japanese', ['Japanese particles', 'Hiragana reading practice']),
                    ...members('German', ['German noun genders', 'Cases: nominative and accusative']),
                ],
            },
            geneticsNl: {
                centroid: null,
                members: members('Biologie havo 5', ['Celdeling: mitose en meiose', 'DNA en erfelijkheid', 'Genen en chromosomen', 'Dominante en recessieve allelen', 'Erfelijke aandoeningen']),
            },
            electricityRu: {
                centroid: null,
                members: members('Физика 8 класс', ['Электрический ток', 'Закон Ома', 'Сопротивление проводника', 'Напряжение и мощность', 'Последовательное и параллельное соединение']),
            },
        };
    },
    cases: [
        {
            // Rule 2: several members of one family are named by the FAMILY.
            id: 'regions-family-languages',
            run: nameIt('languages'),
            score: fits(/language|linguistic/i, 'the family of the topics (languages)', {
                notRe: (l) => /^(dutch|spanish|japanese|german)\b/i.test(l), mustNotBe: 'names one language of four',
            }),
            golden: J('Languages'),
            mutants: [
                { name: 'names one member', reply: J('Dutch Grammar') },
                { name: 'a generic name', reply: J('General Knowledge') },
                { name: 'a sentence', reply: J('These topics are about languages.') },
                { name: 'a digit', reply: J('Languages 101') },
                { name: 'too wide', reply: J('Education') },
                { name: 'a placeholder', reply: J('undefined') },
            ],
        },
        {
            id: 'regions-dutch-genetics',
            run: nameIt('geneticsNl'),
            // Proxy for "in the topics' language": a Dutch word of the subject.
            score: fits(/genetica|erfelijkheid|erfelijke|dna/i, 'the subject in Dutch (genetica, erfelijkheid)'),
            golden: J('Erfelijkheid en genetica'),
            mutants: [
                { name: 'English name', reply: J('Genetics and Heredity') },
                { name: 'too wide', reply: J('Biologie') },
                { name: 'one topic only', reply: J('Celdeling') },
                { name: 'a sentence', reply: J('Deze onderwerpen gaan over erfelijkheid.') },
                { name: 'meta answer', reply: J('The region of genetics topics') },
            ],
        },
        {
            id: 'regions-russian-electricity',
            run: nameIt('electricityRu'),
            score: (out) => {
                const r = fits(/электр/i, 'the subject in Russian (электричество, электрические цепи)')(out);
                if (!r.pass) return r;
                const cyr = (out.label.match(/\p{Script=Cyrillic}/gu) || []).length / ((out.label.match(/\p{L}/gu) || []).length || 1);
                return cyr >= 0.7 ? r : { pass: false, why: `"${out.label}" is not written in Russian` };
            },
            golden: J('Электричество'),
            mutants: [
                { name: 'English name', reply: J('Electric Circuits') },
                { name: 'too wide', reply: J('Физика') },
                { name: 'one topic only', reply: J('Закон Ома') },
                { name: 'digits', reply: J('Электричество 8 класс') },
                { name: 'a sentence', reply: J('Эти темы про электрический ток.') },
            ],
        },
    ],
};
