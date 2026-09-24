// tools/answer-format-gates.mjs — the answer format registry, both halves.
//
// Run:  node tools/answer-format-gates.mjs
//
// A question's format (how the learner answers) is a registry on the server
// (`server/answerFormats.js`: what the model authors, how a raw generation is
// made honest, the guess floor) mirrored on the client
// (`src/components/answer/formats.ts`: how it is rendered and whether it grades
// on the spot). Two lists, two languages — and a format present in one and not
// the other fails INVISIBLY: the server authors a question the client answers
// as prose, or the client offers a format no reducer will admit. So:
//
//   1. the key sets and the grading mode of every format agree across the two;
//   2. every authored example in a prompt passes its own normaliser — the shape
//      the model is shown is a shape the app accepts;
//   3. the new formats are made honest the way the old ones are: no key, no
//      question; the served order is never the key; the starter is never the
//      solution; a fenced solution is unwrapped, not dropped;
//   4. both reducers dispatch through the registry, and the quiz reducer admits
//      a model-graded format only by name;
//   5. no question SURFACE switches on a format itself — `AnswerInput` is the
//      one place a format becomes an input, so a sixth format reaches every
//      surface by construction;
//   6. `fill_in` folds exactly the typography a learner cannot be expected to
//      reproduce and NOTHING else — identically on both sides, because the two
//      graders judge different screens.

import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'answer-format-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const B = new URL('../server/', import.meta.url).href;
const {
    ANSWER_FORMATS, FORMAT_IDS, GUESS_BY_FORMAT, normalizeQuestionFormat, gradeLocally, formatAuthoring,
    codeLanguageIn, countsProcedure, sameCode, parseNumber, defaultTolerance,
    normalizeTyped, acceptedAnswers, MAX_ACCEPTED_ANSWERS,
} = await import(B + 'answerFormats.js');
const { normalizeFeedQuestion } = await import(B + 'feed.js');
const { finalizeQuiz } = await import(B + 'studyMaterial.js');
const { questionDefects } = await import(B + 'feedQuality.js');
const { GUESS_BY_QUESTION_TYPE } = await import(B + 'mastery.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

// ---------------------------------------------------------------------------
section('the two halves of the registry agree');

/**
 * Bundle one client module so its real code can be RUN here.
 *
 * `src/api.ts` and `src/i18n` reach for `fetch`, `window` and a locale loader
 * at import time, and a grader does not need any of them, so they are stubbed
 * rather than pulled in: what is under test is the decision, not the transport.
 */
const stub = join(scratch, 'stub.js');
writeFileSync(stub, 'export const api = new Proxy({}, { get: () => () => { throw new Error("no network in a gate"); } });\n'
    + 'export const k = (s) => s;\nexport default {};\n');
async function bundleClient(entry) {
    const outfile = join(scratch, entry.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '.mjs'));
    await esbuild.build({
        entryPoints: [join(repoRoot, entry)],
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
        plugins: [{
            name: 'stub-runtime',
            setup(build) {
                build.onResolve({ filter: /(^|\/)(api|i18n)$/ }, () => ({ path: stub }));
            },
        }],
    });
    return outfile;
}
const client = await import(pathToFileURL(await bundleClient('src/components/answer/formats.ts')).href);

check('the client knows exactly the formats the server authors',
    JSON.stringify([...client.FORMAT_IDS].sort()) === JSON.stringify([...FORMAT_IDS].sort()),
    `client ${client.FORMAT_IDS.join(',')} vs server ${FORMAT_IDS.join(',')}`);
for (const id of FORMAT_IDS) {
    check(`${id}: both sides agree on whether it grades locally`,
        client.ANSWER_FORMATS[id]?.grading === ANSWER_FORMATS[id].grading);
}
check('every format has a guess floor strictly inside (0, 1)',
    FORMAT_IDS.every(id => GUESS_BY_FORMAT[id] > 0 && GUESS_BY_FORMAT[id] < 1));
check('mastery reads the registry\'s floors, not a copy',
    GUESS_BY_QUESTION_TYPE === GUESS_BY_FORMAT || JSON.stringify(GUESS_BY_QUESTION_TYPE) === JSON.stringify(GUESS_BY_FORMAT));
check('a closed format on the client commits on select; an open one does not',
    client.ANSWER_FORMATS.multiple_choice.commitsOnSelect && client.ANSWER_FORMATS.true_false.commitsOnSelect
    && !client.ANSWER_FORMATS.short_answer.commitsOnSelect && !client.ANSWER_FORMATS.code.commitsOnSelect
    && !client.ANSWER_FORMATS.sequence.commitsOnSelect && !client.ANSWER_FORMATS.numeric.commitsOnSelect);

// ---------------------------------------------------------------------------
section('the two number parsers read every notation the same way');

// The client grades the feed and the quiz; the server grades the placement
// probe. A learner who types "0,5" must get the same verdict on both, so the
// two implementations are run against ONE table rather than trusted to match.
const NOTATIONS = [
    ['9.81', 9.81, 'a plain decimal'],
    ['0,5', 0.5, 'a decimal COMMA — half this library is Dutch'],
    ['1 000 000', 1000000, 'spaces group digits'],
    ["1'000", 1000, 'so do apostrophes'],
    ['1_000', 1000, 'and underscores'],
    ['1.234,56', 1234.56, 'both separators: the last one is the decimal point'],
    ['1,234.56', 1234.56, '…in either convention'],
    ['1,000,000', 1000000, 'one separator repeated is grouping'],
    ['3.0 × 10^8', 3e8, 'physics notation folds into an exponent'],
    ['3.0 x 10**8', 3e8, '…however it is typed'],
    ['1e5', 1e5, 'a programmer\'s exponent'],
    ['3/4', 0.75, 'a simple fraction'],
    ['9.8 m/s^2', 9.8, 'a unit typed anyway is ignored, not rejected'],
    ['50%', 50, '…including a percent sign'],
    ['≈ 9.8', 9.8, 'an approximation mark is packaging'],
    ['-40', -40, 'a negative answer'],
    ['.5', 0.5, 'a leading point'],
    ['abc', null, 'words are not a number'],
    ['', null, 'nor is nothing'],
    ['1/0', null, 'nor is a division by zero'],
];
for (const [written, expected, why] of NOTATIONS) {
    const s = parseNumber(written);
    const c = client.parseNumber(written);
    check(`${JSON.stringify(written)} reads as ${expected} — ${why}`, s === expected && c === expected,
        `server ${s}, client ${c}`);
}
// The model is asked for an ASCII unit (a caret survives JSON and every
// tokeniser; `²` does not), so the caret is turned back into a superscript on
// the way to the screen — display only, and never on the way to the grader.
const UNITS = [['m/s^2', 'm/s²'], ['cm^-1', 'cm⁻¹'], ['m^3', 'm³'], ['kg', 'kg'], ['%', '%'], ['', '']];
for (const [written, shown] of UNITS) {
    check(`the unit ${JSON.stringify(written)} is read as ${JSON.stringify(shown)}`,
        client.prettyUnit(written) === shown, client.prettyUnit(written));
}
check('prettifying a unit never changes the graded value',
    gradeLocally({ type: 'numeric', correct_answer: '-5.0', unit: 'm/s^2', tolerance: 0.1 }, '-5') === true);

const TOLERANCES = [['9.81', 0.005], ['40', 0.5], ['0.00450', 0.000005], ['1.5e3', 50], ['0', 0.5]];
for (const [written, expected] of TOLERANCES) {
    check(`with no tolerance stated, ${written} means ±${expected} (half a unit in its last place)`,
        Math.abs(defaultTolerance(written) - expected) < expected * 1e-9
        && Math.abs(client.defaultTolerance(written) - expected) < expected * 1e-9,
        `server ${defaultTolerance(written)}, client ${client.defaultTolerance(written)}`);
}

// ---------------------------------------------------------------------------
section('every authored example passes its own normaliser');

for (const id of FORMAT_IDS) {
    const { shape, rule } = formatAuthoring(id);
    let parsed = null;
    try { parsed = JSON.parse(shape); } catch { /* reported */ }
    check(`${id}: the shape shown to the model is valid JSON`, !!parsed, shape);
    check(`${id}: the shape names its own format`, parsed?.type === id);
    check(`${id}: the shape normalises to a question`, !!(parsed && normalizeQuestionFormat(parsed)));
    check(`${id}: the authoring rule is a real sentence`, typeof rule === 'string' && rule.length > 40);
}

// ---------------------------------------------------------------------------
section('code: what a model writes is made honest');

const rawCode = {
    question: 'Write a function `double(xs)` that returns a new list with every number doubled. double([1, 2]) → [2, 4].',
    type: 'code', language: 'Python', starter: 'def double(xs):\n    ...',
    correct_answer: 'def double(xs):\n    return [x * 2 for x in xs]', explanation: 'A comprehension maps each element.',
};
const code = normalizeQuestionFormat(rawCode);
check('a well-formed code question survives', !!code);
check('the language is lowercased for the editor and the grader', code?.language === 'python');
check('the starter is kept when it is not the solution', code?.starter === 'def double(xs):\n    ...');
check('a starter that IS the solution is dropped, not served',
    normalizeQuestionFormat({ ...rawCode, starter: rawCode.correct_answer }).starter === undefined);
check('a fenced solution is unwrapped rather than rejected',
    normalizeQuestionFormat({ ...rawCode, correct_answer: '```python\n' + rawCode.correct_answer + '\n```' })?.correct_answer === rawCode.correct_answer);
check('no language, no question', normalizeQuestionFormat({ ...rawCode, language: '' }) === null);
check('a visual kind is not a language', normalizeQuestionFormat({ ...rawCode, language: 'mermaid' }) === null);
check('no solution, no question', normalizeQuestionFormat({ ...rawCode, correct_answer: '' }) === null);
check('code is never graded locally', gradeLocally({ type: 'code', correct_answer: 'x' }, 'x') === null);
// escapeLatexBackslashes doubles every \n in the model's JSON (it collides with
// \nabla in prose), so a solution written as valid JSON arrives as one line
// holding the two characters "\n" — which a 9B model did on the first live run.
const flat = normalizeQuestionFormat({ ...rawCode, starter: 'def f(xs):\\n    ...', correct_answer: 'def f(xs):\\n    return [x for x in xs]' });
check('line breaks the escaper flattened into "\\n" are line breaks again', flat?.correct_answer === 'def f(xs):\n    return [x for x in xs]', JSON.stringify(flat?.correct_answer));
check('…in the starter too', flat?.starter === 'def f(xs):\n    ...');
check('a real "\\n" inside a multi-line program is left alone',
    normalizeQuestionFormat({ ...rawCode, correct_answer: 'def f():\n    return "a\\nb"' })?.correct_answer === 'def f():\n    return "a\\nb"');
check('sameCode is blind to whitespace and nothing else',
    sameCode('a =  1\n', 'a = 1') && !sameCode('a = 1', 'a = 2'));

// ---------------------------------------------------------------------------
section('sequence: the served order is never the key');

const rawSeq = {
    question: 'Put the steps of making a roux-based sauce in order.', type: 'sequence',
    items: ['Melt the butter', 'Whisk in the flour', 'Cook the paste briefly', 'Add the milk gradually'],
    explanation: 'Fat first, then starch, then liquid.',
};
const seq = normalizeQuestionFormat(rawSeq);
check('a well-formed ordering survives', !!seq);
check('the key is the authored order, as JSON', seq?.correct_answer === JSON.stringify(rawSeq.items));
check('the served items are a permutation of the key',
    !!seq && seq.items.length === 4 && rawSeq.items.every(i => seq.items.includes(i)));
let identical = 0;
for (let i = 0; i < 40; i++) if (JSON.stringify(normalizeQuestionFormat(rawSeq).items) === seq.correct_answer) identical++;
check('the served order differs from the key, every time (40 draws)', identical === 0, `${identical} identical`);
check('numbering a model added is stripped from the items',
    !normalizeQuestionFormat({ ...rawSeq, items: rawSeq.items.map((s, i) => `${i + 1}. ${s}`) }).items.some(s => /^\d\./.test(s)));
check('two items are not an ordering', normalizeQuestionFormat({ ...rawSeq, items: rawSeq.items.slice(0, 2) }) === null);
check('two items that are one thing: no honest order',
    normalizeQuestionFormat({ ...rawSeq, items: [...rawSeq.items, 'melt the butter'] }) === null);
const q = { type: 'sequence', correct_answer: seq.correct_answer, items: seq.items };
check('the right order grades correct', gradeLocally(q, seq.correct_answer) === true);
check('the served order grades wrong', gradeLocally(q, JSON.stringify(seq.items)) === false);
check('a non-JSON answer grades wrong, never throws', gradeLocally(q, 'butter first') === false);
check('multiple choice still grades case-insensitively',
    gradeLocally({ type: 'multiple_choice', correct_answer: 'Paris' }, ' paris ') === true);

// ---------------------------------------------------------------------------
section('numeric: generous about notation, strict about value');

const rawNum = {
    question: 'A stone is dropped from rest and falls for 2.0 s. How far does it fall? Use g = 9.81 m/s^2.',
    type: 'numeric', correct_answer: '19.6', unit: 'm', tolerance: 0.1,
    explanation: 's = ½gt² = 0.5 × 9.81 × 4.0 = 19.6 m.',
};
const num = normalizeQuestionFormat(rawNum);
check('a well-formed calculation survives', !!num);
check('the key keeps the significant figures it was written with', num?.correct_answer === '19.6');
check('the unit is carried for the input to display', num?.unit === 'm');
check('a stated tolerance is kept', num?.tolerance === 0.1);
check('no number, no question', normalizeQuestionFormat({ ...rawNum, correct_answer: 'about twenty' }) === null);
check('a missing tolerance becomes the key\'s own precision',
    normalizeQuestionFormat({ ...rawNum, tolerance: undefined })?.tolerance === 0.05);
check('a tolerance wider than half the answer is refused, not served',
    normalizeQuestionFormat({ ...rawNum, tolerance: 15 })?.tolerance === 0.05);
check('a negative tolerance is refused too',
    normalizeQuestionFormat({ ...rawNum, tolerance: -1 })?.tolerance === 0.05);
check('a tolerance of exactly 0 is honoured — some answers are exact counts',
    normalizeQuestionFormat({ ...rawNum, correct_answer: '7', unit: '', tolerance: 0 })?.tolerance === 0);

const gq = { type: 'numeric', correct_answer: '19.6', tolerance: 0.1 };
check('the exact answer is correct', gradeLocally(gq, '19.6') === true);
check('…and so is the same number with its unit typed in', gradeLocally(gq, '19.6 m') === true);
check('…and written with a decimal comma', gradeLocally(gq, '19,6') === true);
check('an answer at the edge of the tolerance still counts', gradeLocally(gq, '19.5') === true);
check('…and just outside it does not', gradeLocally(gq, '19.4') === false);
check('the wrong order of magnitude is wrong', gradeLocally(gq, '196') === false);
check('words are not an answer, and never throw', gradeLocally(gq, 'nineteen point six') === false);
check('an empty answer is wrong, not correct', gradeLocally(gq, '') === false);
check('a question with no tolerance falls back to the key\'s precision when graded',
    gradeLocally({ type: 'numeric', correct_answer: '9.81' }, '9.812') === true
    && gradeLocally({ type: 'numeric', correct_answer: '9.81' }, '9.9') === false);
// Floating point: 19.6 - 19.5 is 0.10000000000000142, so a tolerance of exactly
// 0.1 must not reject its own edge case.
check('binary floating point does not eat the edge of a tolerance',
    gradeLocally({ type: 'numeric', correct_answer: '0.3', tolerance: 0.1 }, '0.2') === true);
// The client's grader must reach the SAME VERDICT, and reading its source
// cannot show that. A first version of this gate asserted that `grading.ts`
// imports `parseNumber` and mentions `defaultTolerance` — and a hand mutation
// that dropped the tolerance fallback there (so an answer to a question with no
// stated tolerance needed to be exact on the client and was forgiven on the
// server) passed it. So the client's grader is bundled and RUN, against the
// same questions as the server's.
const gradeLocallyClient = (await import(pathToFileURL(await bundleClient('src/utils/grading.ts')).href)).gradeLocally;
const AGREE = [
    [{ type: 'numeric', correct_answer: '19.6', tolerance: 0.1 }, '19.6'],
    [{ type: 'numeric', correct_answer: '19.6', tolerance: 0.1 }, '19,6'],
    [{ type: 'numeric', correct_answer: '19.6', tolerance: 0.1 }, '19.5'],
    [{ type: 'numeric', correct_answer: '19.6', tolerance: 0.1 }, '19.4'],
    [{ type: 'numeric', correct_answer: '19.6', tolerance: 0.1 }, '19.6 m'],
    [{ type: 'numeric', correct_answer: '19.6', tolerance: 0.1 }, 'nineteen'],
    // No tolerance stated: both sides must fall back to the key's own precision.
    [{ type: 'numeric', correct_answer: '9.81' }, '9.812'],
    [{ type: 'numeric', correct_answer: '9.81' }, '9.9'],
    [{ type: 'numeric', correct_answer: '40' }, '40.4'],
    [{ type: 'numeric', correct_answer: '3.0e8', tolerance: 1e6 }, '2.99 × 10^8'],
    [{ type: 'multiple_choice', correct_answer: 'Paris' }, ' paris '],
    [{ type: 'true_false', correct_answer: 'True' }, 'true'],
];
for (const [q, answer] of AGREE) {
    const server = gradeLocally(q, answer);
    const clientVerdict = gradeLocallyClient(q, answer);
    check(`client and server agree on ${JSON.stringify(answer)} against ${q.correct_answer}${q.tolerance === undefined ? ' (no tolerance stated)' : ''}`,
        server === clientVerdict, `server ${server}, client ${clientVerdict}`);
}

check('a sound calculation has no defects',
    questionDefects({ question: rawNum.question, ...num, type: 'numeric' }).length === 0,
    questionDefects({ question: rawNum.question, ...num, type: 'numeric' }).join('; '));
check('a key with the unit baked into it is a defect',
    questionDefects({ question: rawNum.question, ...num, type: 'numeric', correct_answer: '19.6 m' }).some(d => /unit/.test(d)));
check('…but an exponent is not a unit',
    questionDefects({ question: rawNum.question, ...num, type: 'numeric', correct_answer: '3.0e8', tolerance: 1e6 }).length === 0);
check('a tolerance that swallows the answer is a defect',
    questionDefects({ question: rawNum.question, ...num, type: 'numeric', tolerance: 15 }).some(d => /half/.test(d)));

// ---------------------------------------------------------------------------
section('fill_in: spelling is graded, typography is not');

// The whole honesty of this format is one function, and it exists in two
// languages: the client grades the feed and the quiz, the server grades the
// placement probe and anything an assessment reaches. A fold that happens on
// one side only marks the same learner right in one screen and wrong in the
// next — so, like the number parsers above, both are run against ONE table.
// Each row is something a learner really types.
const TYPED = [
    ['om', 'om', true, 'the plain case'],
    ['Om', 'om', true, 'a capital at the start of a sentence is not an error'],
    ['  om  ', 'om', true, 'surrounding space is not an error'],
    ['om.', 'om', true, 'nor is a full stop they typed out of habit'],
    ['het boek,  het adres', 'Het boek, het adres.', true, 'a dictation cannot hear a comma'],
    ['dont', "don't", true, 'an apostrophe is DELETED, not turned into a space'],
    ['email', 'e-mail', true, '…and so is a hyphen'],
    ['’s morgens', "'s morgens", true, 'a curly apostrophe is the same apostrophe'],
    ['om ', 'op', false, 'the wrong word is still the wrong word'],
    ['een', 'één', false, 'a diacritic is a letter here, not decoration'],
    ['gewerk', 'gewerkt', false, 'a missing letter is a spelling mistake'],
    ['', 'om', false, 'an empty box answers nothing'],
    ['   ', 'om', false, '…nor does a box of spaces'],
];
for (const [typed, key, expected, why] of TYPED) {
    const q = { type: 'fill_in', correct_answer: key };
    const server = gradeLocally(q, typed);
    const clientVerdict = gradeLocallyClient(q, typed);
    check(`${JSON.stringify(typed)} vs key ${JSON.stringify(key)} is ${expected} — ${why}`,
        server === expected && clientVerdict === expected, `server ${server}, client ${clientVerdict}`);
}

check('both sides reduce a typed answer to the same string',
    TYPED.every(([typed]) => normalizeTyped(typed) === client.normalizeTyped(typed)));

// A learner who was RIGHT and was marked wrong stops trusting the course, so
// the author's declared variants are part of the key on both sides.
const withAccept = { type: 'fill_in', correct_answer: 'de krant', accept: ['het dagblad'] };
check('the accepted set is the key plus its variants, on both sides',
    JSON.stringify(acceptedAnswers(withAccept)) === JSON.stringify(['de krant', 'het dagblad'])
    && JSON.stringify(client.acceptedAnswers(withAccept)) === JSON.stringify(['de krant', 'het dagblad']),
    JSON.stringify(acceptedAnswers(withAccept)));
check('a declared variant is accepted, server and client',
    gradeLocally(withAccept, 'Het dagblad!') === true && gradeLocallyClient(withAccept, 'Het dagblad!') === true);
check('an undeclared near-miss is not',
    gradeLocally(withAccept, 'de kranten') === false && gradeLocallyClient(withAccept, 'de kranten') === false);

const rawFill = {
    question: 'Vul het juiste voorzetsel in: Wij komen ___ 9.45 uur.',
    type: 'fill_in',
    correct_answer: 'om',
    accept: ['Om.', 'omstreeks', 'omstreeks'],
    explanation: 'A clock time takes "om".',
};
const fill = normalizeQuestionFormat(rawFill);
check('a sound gap normalises', fill?.correct_answer === 'om');
check('a variant that grades the same as the key is dropped, not stored twice',
    JSON.stringify(fill?.accept) === JSON.stringify(['omstreeks']), JSON.stringify(fill?.accept));
check('a key with nothing gradeable in it is refused, never served',
    normalizeQuestionFormat({ ...rawFill, correct_answer: '...' }) === null);
check('…and so is an empty one', normalizeQuestionFormat({ ...rawFill, correct_answer: '   ' }) === null);
check(`no more than ${MAX_ACCEPTED_ANSWERS} variants are kept`,
    normalizeQuestionFormat({ ...rawFill, accept: Array.from({ length: 20 }, (_, i) => `variant ${i}`) })
        .accept.length === MAX_ACCEPTED_ANSWERS);

check('a sound gap has no defects',
    questionDefects({ question: rawFill.question, type: 'fill_in', ...fill }).length === 0,
    questionDefects({ question: rawFill.question, type: 'fill_in', ...fill }).join('; '));
// The failure this rule exists for: a question whose stem already spells the
// answer measures reading, not knowledge.
check('a stem that already contains the answer is a defect',
    questionDefects({
        question: 'Het voltooid deelwoord van werken is gewerkt. Vul in: ik heb ___.',
        type: 'fill_in', correct_answer: 'gewerkt', explanation: 'x',
    }).some(d => /already contains/.test(d)));
// Precision over recall: a two- or three-letter key inside a sentence of the
// same language is a coincidence, not a giveaway.
check('…but a short word appearing in the stem is not',
    questionDefects({
        question: 'Vul in: ik ___ de krant elke ochtend.',
        type: 'fill_in', correct_answer: 'de', explanation: 'x',
    }).length === 0);
check('…and a long key that only appears as part of another word is not',
    questionDefects({
        question: 'Wat is het voltooid deelwoord van werken?',
        type: 'fill_in', correct_answer: 'gewerkt', explanation: 'x',
    }).length === 0);
check('an answer too long to type back exactly is a defect',
    questionDefects({
        question: 'Schrijf op wat je hoort.', type: 'fill_in',
        correct_answer: 'woord '.repeat(50), explanation: 'x',
    }).some(d => /too long/.test(d)));

// ---------------------------------------------------------------------------
section('both reducers dispatch through the registry');

const HASH = 'a'.repeat(64);
const fed = normalizeFeedQuestion({ ...rawCode, media: [{ hash: HASH, kind: 'image' }] });
check('the feed accepts a code question', fed?.type === 'code' && fed.language === 'python');
check('…and still carries its media through the format dispatch', fed?.media?.[0]?.hash === HASH);
check('the feed accepts an ordering', normalizeFeedQuestion(rawSeq)?.type === 'sequence');
check('the feed still drops an unknown format', normalizeFeedQuestion({ ...rawCode, type: 'essay' }) === null);
const mc = normalizeFeedQuestion({
    question: 'Which planet is largest?', type: 'multiple_choice', options: ['Mars', 'Jupiter', 'Venus', 'Earth'],
    correct_answer: 'b) Jupiter.', explanation: 'Jupiter, by mass and radius.',
});
check('multiple choice still resolves an enumerated key against the options', mc?.correct_answer === 'Jupiter');
check('…and still shuffles them', mc?.options.length === 4 && ['Mars', 'Jupiter', 'Venus', 'Earth'].every(o => mc.options.includes(o)));

check('the feed accepts a calculation', normalizeFeedQuestion(rawNum)?.type === 'numeric');

// A quiz is a row with a real foreign key, so the gate makes the node it hangs
// off. It used to write against node 1 and pass because `database.js` seeded a
// tutorial project into every empty library — the fixture was borrowing another
// module's side effect, and the day the seed went, this failed on a constraint
// that says nothing about answer formats.
const { default: db } = await import(B + 'database.js');
const quizProject = db.prepare('INSERT INTO projects (name, position) VALUES (?, 0)').run('answer formats').lastInsertRowid;
const quizNode = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, 0)').run(quizProject, 'a topic to hang a quiz on').lastInsertRowid;

const quizText = JSON.stringify([rawCode, rawSeq, rawNum, {
    question: 'Which planet is largest?', type: 'multiple_choice', options: ['Mars', 'Jupiter', 'Venus', 'Earth'],
    correct_answer: 'Jupiter', explanation: 'Jupiter, by mass and radius.',
}]);
const defaultQuiz = finalizeQuiz(quizNode, quizText, false);
check('a saved quiz admits the locally graded ordering by default',
    defaultQuiz.questions.some(x => x.type === 'sequence'));
check('…and multiple choice', defaultQuiz.questions.some(x => x.type === 'multiple_choice'));
// The point of grading a calculation locally: a mastery check has to reach a
// verdict with no model in the room, so before this format the strongest thing
// an assessment could ask a physics topic was "pick one of four".
check('…and a calculation, which a mastery check can now grade with no model',
    defaultQuiz.questions.some(x => x.type === 'numeric'));
check('…but not code, which needs the checker', !defaultQuiz.questions.some(x => x.type === 'code'));
check('code is admitted when the learner asked for it by name',
    finalizeQuiz(quizNode, quizText, false, { questionType: 'code' }).questions.some(x => x.type === 'code'));

// ---------------------------------------------------------------------------
section('mechanical defects for the new formats');

check('a sound code question has no defects', questionDefects({ question: rawCode.question, ...code, type: 'code' }).length === 0,
    questionDefects({ question: rawCode.question, ...code, type: 'code' }).join('; '));
check('a code question with no language is a defect',
    questionDefects({ question: rawCode.question, ...code, type: 'code', language: '' }).some(d => /language/.test(d)));
check('a starter equal to the solution is a defect',
    questionDefects({ question: rawCode.question, ...code, type: 'code', starter: code.correct_answer }).some(d => /starter/.test(d)));
check('a sound ordering has no defects', questionDefects({ question: rawSeq.question, ...seq, type: 'sequence' }).length === 0,
    questionDefects({ question: rawSeq.question, ...seq, type: 'sequence' }).join('; '));
check('an ordering whose key does not list its items is a defect',
    questionDefects({ question: rawSeq.question, ...seq, type: 'sequence', correct_answer: '["x","y","z","w"]' }).some(d => /key/.test(d)));
check('a numbered item gives the order away',
    questionDefects({ question: rawSeq.question, ...seq, type: 'sequence', items: ['1. first', ...seq.items.slice(1)] }).some(d => /number/.test(d)));

// ---------------------------------------------------------------------------
section('the feed chooses a format from what the segment shows');

check('a python fence earns a code question', codeLanguageIn('Some prose.\n\n```python\nprint(1)\n```\n') === 'python');
check('a visual fence is not code', codeLanguageIn('```mermaid\ngraph TD; A-->B\n```') === null);
check('a text fence is not code, but the language after it is',
    codeLanguageIn('```text\noutput\n```\n\n```js\nlet x = 1;\n```') === 'js');
check('an untagged fence names no language', codeLanguageIn('```\nfoo\n```') === null);
check('three numbered steps read as a procedure', countsProcedure('1. Melt\n2. Whisk\n3. Cook\n'));
check('two do not', !countsProcedure('1. Melt\n2. Whisk\n'));

// ---------------------------------------------------------------------------
section('no question surface switches on a format itself');

// Every surface that asks a question renders the answer through AnswerInput.
// A surface that hand-renders one format is a surface the next format will not
// reach. The placement probe is the one exception, by design: it asks two
// formats it grades server-side, and it is the one stem with no media either.
const EXEMPT = new Set(['src/components/PlacementModal.tsx']);
const formatSwitch = /\.type\s*[!=]==?\s*'(multiple_choice|true_false|short_answer|numeric|code|sequence)'/;
const walk = (dir) => readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : (f.endsWith('.tsx') ? [p] : []);
});
const surfaces = walk(join(repoRoot, 'src/components'))
    .map(p => relative(repoRoot, p).replace(/\\/g, '/'))
    .filter(p => !p.startsWith('src/components/answer/') && !EXEMPT.has(p));
const offenders = surfaces.filter(p => formatSwitch.test(readFileSync(join(repoRoot, p), 'utf8')));
check('every question surface outside the registry renders through AnswerInput', offenders.length === 0, offenders.join(', '));
check('the exemption is still needed (or should be removed)',
    formatSwitch.test(readFileSync(join(repoRoot, 'src/components/PlacementModal.tsx'), 'utf8')));

// ---------------------------------------------------------------------------
section('A stored key the grader cannot read is never served');
// The normalisers keep broken keys out of anything this app writes; a stored
// row can still carry one (an import, a hand edit, an older rule). Both graders
// mark such a key WRONG, so it must be skipped, never asked.
const { hasUsableKey } = await import(B + 'answerFormats.js');
const keyTable = [
    [{ type: 'multiple_choice', options: ['a', 'b', 'c'], correct_answer: 'b' }, true],
    [{ type: 'multiple_choice', options: ['a', 'b', 'c'], correct_answer: 'B ' }, true],
    [{ type: 'multiple_choice', options: ['a', 'b', 'c'], correct_answer: 'd' }, false],
    [{ type: 'multiple_choice', options: ['a', 'b', 'c'] }, false],
    [{ type: 'multiple_choice', options: ['a'], correct_answer: 'a' }, false],
    [{ type: 'true_false', correct_answer: 'False' }, true],
    [{ type: 'true_false', correct_answer: 'yes' }, false],
    [{ type: 'sequence', items: ['x', 'y', 'z'], correct_answer: '["y","x","z"]' }, true],
    [{ type: 'sequence', items: ['x', 'y', 'z'], correct_answer: 'y, x, z' }, false],
    [{ type: 'sequence', items: ['x', 'y'], correct_answer: '["y","x","z"]' }, false],
    [{ type: 'numeric', correct_answer: '3,0 × 10^8' }, true],
    [{ type: 'numeric', correct_answer: 'about three' }, false],
    [{ type: 'fill_in', correct_answer: 'om' }, true],
    [{ type: 'fill_in', correct_answer: '...' }, false],
    [{ type: 'short_answer', correct_answer: 'It refracts.' }, true],
    [{ type: 'short_answer', correct_answer: '  ' }, false],
    [{ type: 'code', correct_answer: 'print(1)' }, true],
    [{ type: 'essay', correct_answer: 'x' }, false],
    [null, false],
];
const keyMisses = keyTable.filter(([q, want]) => hasUsableKey(q) !== want || client.hasUsableKey(q) !== want);
check(`server and client agree on all ${keyTable.length} stored shapes, and both are right`,
    keyMisses.length === 0, keyMisses.map(([q]) => JSON.stringify(q)).join(' | '));

const { drawFromNode, drawFromQuiz } = await import(B + 'questionLog.js');
const brokenNode = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, 1)').run(quizProject, 'a topic with one broken key').lastInsertRowid;
const brokenBank = [
    { question: 'Sound?', type: 'true_false', correct_answer: 'True', explanation: 'x' },
    { question: 'Broken?', type: 'multiple_choice', options: ['a', 'b'], correct_answer: 'c', explanation: 'x' },
    { question: 'Also sound?', type: 'numeric', correct_answer: '4', explanation: 'x' },
];
const brokenQuiz = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(brokenNode, 'broken key bank', JSON.stringify(brokenBank)).lastInsertRowid;
const nodeDraw = drawFromNode(Number(brokenNode), 10);
check('the node draw skips the broken question and counts the bank without it',
    nodeDraw.bankSize === 2 && nodeDraw.questions.every(q => q.question.question !== 'Broken?'),
    `bankSize ${nodeDraw.bankSize}`);
check('what is served keeps its STORAGE index, so the ask-record names the right question',
    nodeDraw.questions.map(q => q.index).sort().join(',') === '0,2', nodeDraw.questions.map(q => q.index).join(','));
const quizDraw = drawFromQuiz(Number(brokenQuiz), 10);
check('the quiz sitting draw skips it too', quizDraw.bankSize === 2 && quizDraw.questions.length === 2);
const quizViewSrc = readFileSync(join(repoRoot, 'src/components/QuizView.tsx'), 'utf8');
check('a whole-row quiz sitting on the client filters by the same predicate, after taking the index',
    /\.map\(\(q, index\) => \(\{ \.\.\.q, index \}\)\)\.filter\(hasUsableKey\)/.test(quizViewSrc));

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the database handle is still open on Windows; swept by the OS */ }
process.exit(fail ? 1 : 0);
