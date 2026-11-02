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
//      graders judge different screens;
//   7. `assemble` refuses every malformed item, never serves its bank in the
//      key's order, grades the same on both sides, and — like every format —
//      survives a course's export and import with its key intact.

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
    normalizeTyped, acceptedAnswers, MAX_ACCEPTED_ANSWERS, servedInKeyOrder, ASSEMBLE_LIMITS,
} = await import(B + 'answerFormats.js');
const { parseObjectResponse } = await import(B + 'agentic.js');
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
// off, rather than borrowing a node some other module happens to create: a
// missing node would fail on a constraint that says nothing about answer
// formats.
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
// verdict with no model in the room, so without this format the strongest thing
// an assessment could ask a physics topic is "pick one of four".
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
section('assemble: pieces into gaps, graded on the whole arrangement');

// The three jobs the format exists for, as an author writes them. The same
// three are the hand-made fixtures walked in the browser.
const SENTENCE = {
    question: 'Zet de woorden op hun plaats.',
    type: 'assemble',
    template: 'Ik blijf thuis, omdat ___ ___ ___ ___.',
    correct_answer: ['ik', 'morgen', 'moet', 'werken'],
    // A verb cluster in a subclause may also end on the modal.
    accept: [['ik', 'morgen', 'werken', 'moet']],
    distractors: ['werk'],
    explanation: 'In een bijzin met omdat staan de werkwoorden achteraan.',
};
const EQUATION = {
    question: 'Balance the equation for burning methane.',
    type: 'assemble',
    template: 'CH₄ + ___ O₂ → ___ CO₂ + ___ H₂O',
    correct_answer: ['2', '1', '2'],
    distractors: ['3', '4'],
    reuse: true,
    explanation: 'Four H on the left need two H₂O; then four O on the right need two O₂.',
};
// Lettered rows need their picture: an imported question carries one, and
// without it the question cannot be answered (a defect, checked below).
const PICTURE = [{ hash: 'a'.repeat(64), kind: 'image', name: 'plant-cell.png', alt: 'A plant cell with four parts lettered A to D' }];
const LABELS = {
    question: 'Name each lettered part of the plant cell.',
    type: 'assemble',
    template: 'A ___\nB ___\nC ___\nD ___',
    correct_answer: ['cell wall', 'nucleus', 'chloroplast', 'vacuole'],
    distractors: ['ribosome'],
    media: PICTURE,
    explanation: 'The wall is the outer line, the vacuole the large space in the middle.',
};

check('both halves of the registry know assemble',
    FORMAT_IDS.includes('assemble') && client.FORMAT_IDS.includes('assemble'),
    `server ${FORMAT_IDS.includes('assemble')}, client ${client.FORMAT_IDS?.includes?.('assemble')}`);
check('…and it is answered by building, not by one choice',
    client.ANSWER_FORMATS.assemble?.commitsOnSelect === false && client.ANSWER_FORMATS.assemble?.blockAnswer === true);
// An untouched ordering IS an answer (the served order); an untouched
// assembly is not one, so the empty gaps are never graded as the attempt.
check('an untouched assemble input answers nothing, unlike an untouched ordering',
    client.defaultAnswer?.({ type: 'assemble', template: 'a ___ ___', tokens: ['x', 'y', 'z'] }) === ''
    && client.defaultAnswer?.({ type: 'sequence', items: ['x', 'y', 'z'] }) === '["x","y","z"]');
{
    // A half-built answer is not checked: a stray tap on Check while gaps are
    // empty would grade the attempt wrong (both bystanders tripped on it).
    const q = { type: 'assemble', template: 'a ___ b ___', tokens: ['x', 'y', 'z'] };
    const complete = client.answerIsComplete;
    const cases = [
        [q, '', false], [q, '["x",null]', false], [q, '[null,"y"]', false], [q, '["x"]', false],
        [q, '["x","y"]', true], [q, 'not json', false],
        [{ type: 'short_answer' }, '', false], [{ type: 'short_answer' }, ' ', false], [{ type: 'short_answer' }, 'x', true],
        [{ type: 'sequence', items: ['a', 'b', 'c'] }, '["c","b","a"]', true],
    ];
    const wrong = typeof complete === 'function' ? cases.filter(([qq, a, want]) => complete(qq, a) !== want) : cases;
    check('Check waits for every gap of an assembly, and for any answer elsewhere', wrong.length === 0,
        wrong.map(([qq, a]) => `${qq.type} ${JSON.stringify(a)}`).join('; '));
    check('…and the feed card asks that, not whether anything was entered',
        /submittable\s*=\s*answerIsComplete\(\s*question\s*,\s*answer\s*\)/.test(readFileSync(new URL('../src/components/feed/InlineQuestion.tsx', import.meta.url), 'utf8')));
}
{
    // "Teach me this" sends both answers to a model, which cannot read
    // ["2","1","2"] without the equation it fills.
    const eqq = { type: 'assemble', template: 'CH₄ + ___ O₂ → ___ CO₂ + ___ H₂O' };
    const said = [
        client.answerAsText?.(eqq, '["2","1","2"]') === 'CH₄ + 2 O₂ → 1 CO₂ + 2 H₂O',
        client.answerAsText?.(eqq, '["2",null,"2"]') === 'CH₄ + 2 O₂ → ___ CO₂ + 2 H₂O',
        client.answerAsText?.({ type: 'sequence' }, '["a","b","c"]') === 'a → b → c',
        client.answerAsText?.({ type: 'short_answer' }, 'It refracts.') === 'It refracts.',
    ];
    check('an answer leaves the answer surface as a person reads it', said.every(Boolean), JSON.stringify(said));
    // Both halves: the key, and the learner's own (part-built) answer.
    const helped = ['../src/components/feed/InlineQuestion.tsx', '../src/components/answer/AnswerReviewItem.tsx']
        .filter(f => {
            const src = readFileSync(new URL(f, import.meta.url), 'utf8');
            return !/correctAnswer=\{answerAsText\(question, question\.correct_answer\)\}/.test(src)
                || !/userAnswer=\{answerAsText\(question, /.test(src);
        });
    check('…and both places that offer "Teach me this" send both answers so', helped.length === 0, helped.join(', '));
}
{
    // A format the model could not author falls back to multiple choice. The
    // picker must count that attempt, or every later part of the topic pays
    // the attempts and the verifier for the same format again.
    const feedGenSrc = readFileSync(new URL('../server/feedGen.js', import.meta.url), 'utf8');
    check('a format tried and fallen back from is recorded, and counted as used',
        /triedType:\s*qType/.test(feedGenSrc) && /json_extract\(meta,\s*'\$\.triedType'\)/.test(feedGenSrc));
}

// As a course file carries it: only a file may declare a second right order.
const sentence = normalizeQuestionFormat(SENTENCE, { stored: true });
check('a sentence to build survives the normaliser', !!sentence);
check('the key is stored as JSON, in gap order', sentence?.correct_answer === JSON.stringify(SENTENCE.correct_answer));
check('another right arrangement a file declares is kept, written the way the key is',
    JSON.stringify(sentence?.accept) === JSON.stringify([JSON.stringify(SENTENCE.accept[0])]), JSON.stringify(sentence?.accept));
// The verifier solves an assembly cold and confirms ONE fill, so another order
// a model declares would be graded right with nothing ever having read it. A
// model fixes the template instead; a question two fills answer is refused.
check('another order a model declares is dropped: no check would ever read it',
    normalizeQuestionFormat(SENTENCE)?.accept === undefined && normalizeFeedQuestion(SENTENCE)?.accept === undefined,
    `${JSON.stringify(normalizeQuestionFormat(SENTENCE)?.accept)} / ${JSON.stringify(normalizeFeedQuestion(SENTENCE)?.accept)}`);
check('…and the authoring rule no longer asks a model for one',
    !/\baccept\b/.test(formatAuthoring('assemble').rule), formatAuthoring('assemble').rule.slice(-400));
check('the bank is every key piece plus the distractor, nothing else',
    !!sentence && JSON.stringify([...sentence.tokens].sort()) === JSON.stringify([...SENTENCE.correct_answer, 'werk'].sort()),
    JSON.stringify(sentence?.tokens));
// Tapping the bank left to right must not build the answer: with the
// distractors taken out, the served order is never the key's order.
let leaks = 0;
for (let i = 0; i < 40; i++) {
    const served = normalizeQuestionFormat(SENTENCE)?.tokens ?? [];
    if (JSON.stringify(served.filter(t => t !== 'werk')) === sentence?.correct_answer) leaks++;
}
check('the bank never reads in the key\'s order (40 draws)', !!sentence && leaks === 0, `${leaks} leaks`);
// Two gaps, two key pieces: half of all shuffles are the key's order, so the
// re-draws alone leak one question in 512 — too rare for random draws to
// catch. So the shuffle is pinned to leave every row as it is (j = i at each
// step): every draw and re-draw is the key's order, and only the fallback
// can still break it.
{
    const realRandom = Math.random;
    Math.random = () => 0.999999;
    let pinned;
    try {
        pinned = [
            normalizeQuestionFormat({ ...SENTENCE, template: '___ ___', correct_answer: ['ga', 'ik'], accept: [], distractors: ['gaat'] })?.tokens,
            normalizeQuestionFormat({ ...SENTENCE, accept: [] })?.tokens,
            normalizeQuestionFormat({ ...SENTENCE, template: '___ ___ ___', correct_answer: ['de', 'kat', 'slaapt'], accept: [], distractors: [] })?.tokens,
        ];
    } finally {
        Math.random = realRandom;
    }
    const keys = [['ga', 'ik'], SENTENCE.correct_answer, ['de', 'kat', 'slaapt']];
    const leaked = pinned.map((t, i) => (!t || servedInKeyOrder(t, keys[i], ['gaat', 'werk']) ? JSON.stringify(t) : null)).filter(Boolean);
    check('…not even when every shuffle comes out in the key\'s order', leaked.length === 0, leaked.join(' | '));
}

const equation = normalizeQuestionFormat(EQUATION);
check('an equation to balance survives', !!equation);
check('a reusable bank holds each piece once, sorted as numbers',
    JSON.stringify(equation?.tokens) === JSON.stringify(['1', '2', '3', '4']), JSON.stringify(equation?.tokens));
check('…which depends on nothing in the key (another key, the same palette)',
    JSON.stringify(normalizeQuestionFormat({ ...EQUATION, correct_answer: ['4', '2', '3'], distractors: ['1'] })?.tokens) === JSON.stringify(['1', '2', '3', '4']));
check('a bank without reuse holds a repeated piece as often as the key uses it',
    normalizeQuestionFormat({ ...EQUATION, reuse: false })?.tokens.filter(t => t === '2').length === 2);

const labels = normalizeQuestionFormat(LABELS);
check('a set of labels survives, one gap per row', !!labels && labels.template === LABELS.template);

// A model's reply is read through escapeLatexBackslashes, which keeps `\n`
// as the two characters `\` `n` (in prose it is far likelier `\nabla`). The
// rows of a template the model wrote as valid JSON must still be rows, and a
// `\nu` inside a formula must still be TeX.
{
    const ROWS = { ...LABELS, template: 'the outer layer ___\nthe control centre ___\nwhere light is caught ___\nthe large store of water ___', media: undefined };
    const fromModel = normalizeFeedQuestion(parseObjectResponse(JSON.stringify(ROWS)));
    check('rows a model wrote as JSON arrive as rows, through the feed\'s reader',
        fromModel?.template === ROWS.template, JSON.stringify(fromModel?.template));
    let quizRows = null;
    try { quizRows = finalizeQuiz(quizNode, JSON.stringify([ROWS]), false).questions.find(x => x.type === 'assemble')?.template; } catch { /* reported below */ }
    check('…and through the saved quiz\'s', quizRows === ROWS.template, JSON.stringify(quizRows));
    const TEX = { ...ROWS, template: 'frequency $\\nu$ ___\nwavelength $\\lambda$ ___', correct_answer: ['Hz', 'm'], distractors: ['s'] };
    check('…while a \\nu inside a formula stays TeX',
        normalizeFeedQuestion(parseObjectResponse(JSON.stringify(TEX)))?.template === TEX.template,
        JSON.stringify(normalizeFeedQuestion(parseObjectResponse(JSON.stringify(TEX)))?.template));
    // Outside a formula too: a bare `\rightarrow` is an arrow, not a row
    // break followed by "ightarrow".
    const ARROW = { ...EQUATION, template: '___ CH₄ + ___ O₂ \\rightarrow ___ CO₂ + ___ H₂O', correct_answer: ['1', '2', '1', '2'] };
    const arrow = normalizeFeedQuestion(parseObjectResponse(JSON.stringify(ARROW)))?.template;
    check('…and so does a bare \\rightarrow between the gaps, on one row', arrow === ARROW.template, JSON.stringify(arrow));
}
const { templateParts } = await import(B + 'answerFormats.js');
check('the gaps a template holds are counted the same on both sides',
    [SENTENCE, EQUATION, LABELS, { template: 'a ____ b _____ c' }].every(q =>
        JSON.stringify(client.templateParts?.(q.template)) === JSON.stringify(templateParts?.(q.template))
        && templateParts?.(q.template)?.length === (q.correct_answer?.length ?? 2) + 1));

// What a model or a file gets wrong, each refused rather than served.
const refused = [
    [{ ...LABELS, template: 'A ___\nB ___\nC ___' }, 'a template with fewer gaps than the key has pieces'],
    [{ ...LABELS, template: 'Name the parts.' }, 'a template with no gap at all'],
    [{ ...LABELS, template: undefined }, 'no template'],
    [{ ...LABELS, template: '___', correct_answer: ['nucleus'], distractors: ['ribosome', 'golgi body'] }, 'one gap: that is a typed answer, not an assembly'],
    [{ ...LABELS, template: Array.from({ length: 9 }, () => '___').join(' '), correct_answer: Array.from({ length: 9 }, (_, i) => `p${i}`) }, 'more than eight gaps'],
    [{ ...LABELS, correct_answer: ['cell wall', '', 'chloroplast', 'vacuole'] }, 'an empty piece'],
    [{ ...LABELS, correct_answer: ['cell wall', 'the ___', 'chloroplast', 'vacuole'] }, 'a piece holding a gap marker'],
    [{ ...LABELS, correct_answer: ['cell wall', 'x'.repeat(49), 'chloroplast', 'vacuole'] }, 'a piece too long to be a piece'],
    [{ ...LABELS, correct_answer: 'cell wall, nucleus, chloroplast, vacuole' }, 'a key that is not a list'],
    [{ ...SENTENCE, template: '___ ___', correct_answer: ['ga', 'ik'], accept: [], distractors: [] }, 'fewer than three pieces in the bank: a coin toss'],
    [{ ...EQUATION, correct_answer: ['2', '2', '2'], distractors: ['1'] }, 'a reusable bank of two pieces'],
    [{ ...LABELS, template: `${'a long stretch of fixed text '.repeat(30)}A ___\nB ___\nC ___\nD ___` }, 'a template past its length: an essay with holes'],
    // Each accepted order is one more way to be right by chance; a blind fill
    // may not land more often than at a multiple choice of four.
    [{ ...SENTENCE, template: '___ ___', correct_answer: ['a', 'b'], distractors: ['c'], accept: [['b', 'a'], ['a', 'c'], ['c', 'a'], ['b', 'c']] }, 'so many orders accepted that a blind fill is right five times in six'],
    [{ ...SENTENCE, template: '___ ___', correct_answer: ['a', 'b'], distractors: ['c'], accept: [['b', 'a']] }, 'two gaps, three pieces and a second order: right one time in three'],
    [{ ...SENTENCE, template: '___ ___', correct_answer: ['2', '2'], distractors: ['3'], accept: [] }, 'two copies of one piece and one other: three fills, right one time in three'],
];
for (const [raw, why] of refused) {
    // A second order counts only where one may be declared: in a file.
    check(`refused: ${why}`, normalizeQuestionFormat(raw, { stored: true }) === null
        && (raw.accept?.length > 0 || normalizeQuestionFormat(raw) === null));
}
{
    const { fillsPossible } = await import(B + 'answerFormats.js');
    const counted = [
        fillsPossible?.(['a', 'b', 'c'], 2) === 6, fillsPossible?.(['2', '2', '3'], 2) === 3,
        fillsPossible?.(['1', '2', '3', '4'], 3, true) === 64, fillsPossible?.(['ik', 'morgen', 'moet', 'werken', 'werk'], 4) === 120,
    ];
    check('the ways to fill a bank are counted, two copies of a piece as one choice', counted.every(Boolean), JSON.stringify(counted));
    check('…while two gaps, four pieces and one other order accepted (two in twelve) is a fair question',
        !!normalizeQuestionFormat({ ...SENTENCE, template: '___ ___', correct_answer: ['a', 'b'], distractors: ['c', 'd'], accept: [['b', 'a']] }, { stored: true }));
    // The cap on a template's length, at its edge.
    const pad = (n) => `${'x'.repeat(n - LABELS.template.length)}${LABELS.template}`;
    check(`a template of exactly ${ASSEMBLE_LIMITS.maxTemplate} characters is kept, one more is refused`,
        !!normalizeQuestionFormat({ ...LABELS, template: pad(ASSEMBLE_LIMITS.maxTemplate) })
        && normalizeQuestionFormat({ ...LABELS, template: pad(ASSEMBLE_LIMITS.maxTemplate + 1) }) === null);
}
const spare = normalizeQuestionFormat({ ...LABELS, distractors: ['nucleus', 'ribosome', 'ribosome'] });
check('a distractor that is also a key piece, or twice the same, is dropped',
    spare?.tokens.filter(t => t === 'nucleus').length === 1 && spare?.tokens.filter(t => t === 'ribosome').length === 1,
    JSON.stringify(spare?.tokens));
check('no more than four distractors are kept, so a bank never passes twelve pieces',
    normalizeQuestionFormat({ ...LABELS, distractors: Array.from({ length: 12 }, (_, i) => `part ${i}`) })?.tokens.length === 8);
check('an "accept" that needs a piece the bank does not hold is dropped',
    normalizeQuestionFormat({ ...SENTENCE, accept: [['ik', 'morgen', 'moet', 'gaan']] }, { stored: true })?.accept === undefined);
check('…and so is one equal to the key', normalizeQuestionFormat({ ...SENTENCE, accept: [SENTENCE.correct_answer] }, { stored: true })?.accept === undefined);
check('a bank a file carries is ignored: the pieces come from the key and the distractors',
    !normalizeQuestionFormat({ ...LABELS, tokens: ['cell wall', 'nucleus', 'chloroplast', 'vacuole', 'golgi'] })?.tokens.includes('golgi'));

// Both graders, one table: the feed and the quiz grade on the client, and the
// server's copy is held to the same verdicts so that anything grading there
// agrees. Each row is something a learner can actually put in the gaps.
const sq = { type: 'assemble', ...sentence };
const eq = { type: 'assemble', ...equation };
const ASSEMBLED = [
    [sq, ['ik', 'morgen', 'moet', 'werken'], true, 'the key'],
    [sq, ['ik', 'morgen', 'werken', 'moet'], true, 'the other right order the author declared'],
    [sq, ['ik', 'moet', 'morgen', 'werken'], false, 'verb second inside a subclause'],
    [sq, ['ik', 'morgen', 'moet', 'werk'], false, 'the distractor in a gap'],
    [sq, ['ik', 'morgen', 'moet', null], false, 'an empty gap'],
    [sq, ['ik', 'morgen', 'moet'], false, 'one gap short'],
    [sq, [' ik ', 'morgen', 'moet', 'werken'], true, 'spacing around a piece is not an error'],
    [eq, ['2', '1', '2'], true, 'a balanced equation'],
    [eq, ['1', '2', '2'], false, 'the same pieces, unbalanced'],
    [{ type: 'assemble', template: '___ + ___ → ___', correct_answer: '["Co","O₂","CoO₂"]', tokens: ['CO', 'Co', 'CoO₂', 'O₂'] }, ['CO', 'O₂', 'CoO₂'], false, 'case is chemistry: CO is not Co'],
    [{ type: 'assemble', template: '___ en ___', correct_answer: '["café","thé"]', tokens: ['eau', 'thé', 'café'] }, ['café', 'thé'], true, 'a letter a keyboard composed another way is the same letter'],
];
// A grader that throws is reported as a failure, not as a crash of this gate.
const verdictOf = (grader, q, answer) => { try { return grader(q, answer); } catch (err) { return `threw: ${err.message}`; } };
for (const [q, fill, expected, why] of ASSEMBLED) {
    const answer = JSON.stringify(fill);
    const server = verdictOf(gradeLocally, q, answer);
    const clientVerdict = verdictOf(gradeLocallyClient, q, answer);
    check(`${JSON.stringify(fill)} is ${expected}: ${why}`, server === expected && clientVerdict === expected,
        `server ${server}, client ${clientVerdict}`);
}
check('an answer that is not a list is wrong, and never throws',
    verdictOf(gradeLocally, sq, 'ik morgen moet werken') === false && verdictOf(gradeLocallyClient, sq, 'ik morgen moet werken') === false);
check('an empty answer is wrong on both sides', verdictOf(gradeLocally, sq, '') === false && verdictOf(gradeLocallyClient, sq, '') === false);

// A course leaves as a file and comes back. The stored question is what the
// export writes, and the importer runs it through the same door a model's
// question takes; the true arrangement must still be the right one.
const { normalizeImportTree } = await import(B + 'curriculumSchema.js');
const { sanitizeQuestionMedia } = await import(B + 'agentic.js');
const { portableQuestion } = await import(B + 'questionTrust.js');
const roundTrip = (q) => normalizeImportTree(
    [{ title: 'round trip', questions: [portableQuestion(q)] }],
    { normalizeQuestionFormat, questionDefects, sanitizeQuestionMedia },
).nodes[0]?.questions?.[0] ?? null;
for (const [raw, truth, name] of [[SENTENCE, SENTENCE.correct_answer, 'a sentence'], [EQUATION, EQUATION.correct_answer, 'an equation'], [LABELS, LABELS.correct_answer, 'a set of labels']]) {
    const stored = { question: raw.question, type: 'assemble', ...normalizeQuestionFormat(raw), ...(raw.media ? { media: raw.media } : {}) };
    const back = roundTrip(stored);
    check(`${name} survives export and import, and the true arrangement still grades right`,
        !!back && gradeLocally(back, JSON.stringify(truth)) === true && back.template === raw.template,
        back ? `key ${back.correct_answer}` : 'dropped on import');
}
const backSentence = roundTrip({ question: SENTENCE.question, type: 'assemble', ...sentence });
check('…the declared other order travels too', gradeLocally(backSentence, JSON.stringify(SENTENCE.accept[0])) === true);
// Found while designing the above: an ORDERING did not survive the same trip.
// The export writes the served (shuffled) items and the importer took them as
// the correct order, so the shuffle became the key.
const storedSeq = { question: rawSeq.question, type: 'sequence', ...normalizeQuestionFormat(rawSeq) };
const backSeq = roundTrip(storedSeq);
check('an ordering survives export and import with its key, not its shuffle',
    !!backSeq && gradeLocally(backSeq, JSON.stringify(rawSeq.items)) === true,
    backSeq ? `key ${backSeq.correct_answer}` : 'dropped on import');
check('…and an ordering whose stored key is not a permutation of its items is refused on import',
    normalizeQuestionFormat({ ...storedSeq, correct_answer: '["Melt the butter","Boil the pasta","Whisk in the flour","Add the milk gradually"]' }, { stored: true }) === null
    && roundTrip({ ...storedSeq, correct_answer: '["Melt the butter","Boil the pasta","Whisk in the flour","Add the milk gradually"]' }) === null);
// A model writes the items in order and no key; a stray key it adds anyway
// (index numbers, the steps re-cased) must not cost the question.
check('…while a model\'s stray key on an ordering is ignored, as it always was',
    normalizeQuestionFormat({ ...rawSeq, correct_answer: [2, 0, 1, 3] })?.correct_answer === JSON.stringify(rawSeq.items)
    && normalizeQuestionFormat({ ...rawSeq, correct_answer: rawSeq.items.map(s => s.toUpperCase()) })?.correct_answer === JSON.stringify(rawSeq.items));

const asServed = (raw) => ({ question: raw.question, type: 'assemble', ...(normalizeQuestionFormat(raw) ?? {}), ...(raw.media ? { media: raw.media } : {}) });
check('a sound assembly has no defects',
    [SENTENCE, EQUATION, LABELS].every(raw => questionDefects(asServed(raw)).length === 0),
    [SENTENCE, EQUATION, LABELS].map(raw => questionDefects(asServed(raw)).join('; ')).join(' | '));
const defectsOf = (q) => questionDefects({ question: LABELS.question, type: 'assemble', ...labels, media: PICTURE, ...q });
// No model draws the picture lettered rows point at, so from the feed such a
// question cannot be answered by knowing the cell; described rows can.
check('lettered rows with no picture are a defect',
    defectsOf({ media: undefined }).some(d => /picture/.test(d)), defectsOf({ media: undefined }).join('; '));
check('…described rows need none',
    !defectsOf({ media: undefined, template: 'the outer layer ___\nthe control centre ___\nwhere light is caught ___\nthe large store of water ___' }).some(d => /picture/.test(d)));
check('…nor do rows that open on a short word or a symbol ("ik ___", "Na ___")',
    ['ik ___\nje ___\nwe ___\nze ___', 'Na ___\nMg ___\nAl ___\nCl ___']
        .every(template => !defectsOf({ media: undefined, template }).some(d => /picture/.test(d))));
// The same labels on ONE line point at the same missing picture.
check('lettered labels on one line with no picture are a defect too',
    ['A ___  B ___  C ___  D ___', '1. ___ 2. ___ 3. ___ 4. ___', '(a) ___ (b) ___ (c) ___ (d) ___']
        .every(template => defectsOf({ media: undefined, template }).some(d => /picture/.test(d))));
check('…but a sentence whose words are single letters is not a set of labels ("I ___ a ___")',
    ['I ___ a ___', 'x ___ y ___ z ___ w ___'].every(template => !defectsOf({ media: undefined, template }).some(d => /picture/.test(d))));
{
    // A model cannot attach a picture; one its reply claims is invented, and
    // must not count as the picture a lettered template needs.
    const { normalizeModelQuestion } = await import(B + 'feed.js');
    const fromModel = normalizeModelQuestion?.({ ...LABELS });
    check('a picture a model\'s reply claims is dropped, so lettered rows from a model are a defect',
        !!fromModel && fromModel.media === undefined && questionDefects(fromModel).some(d => /picture/.test(d))
        && normalizeFeedQuestion({ ...LABELS })?.media?.length === 1);
    const modelPaths = ['../server/feedGen.js', '../server/capture.js']
        .filter(f => {
            const src = readFileSync(new URL(f, import.meta.url), 'utf8');
            return !/normalizeModelQuestion\(/.test(src) || /normalizeFeedQuestion/.test(src);
        });
    check('…on both paths that read a model\'s questions', modelPaths.length === 0, modelPaths.join(', '));
}
check('a stem that already shows the built answer is a defect',
    questionDefects({ ...asServed(SENTENCE), question: 'Zet in de goede volgorde: ik morgen moet werken.' }).some(d => /already shows/.test(d)));
check('…also when the gaps lie apart and the stem shows the whole of it',
    questionDefects({
        ...asServed({ ...SENTENCE, template: 'Ik ___ morgen ___.', correct_answer: ['moet', 'werken'], distractors: ['werk', 'ga'], accept: [] }),
        question: 'Vertaal en bouw na: Ik moet morgen werken.',
    }).some(d => /already shows/.test(d)));
check('…but a stem naming one of the pieces is not',
    !questionDefects({ ...asServed(SENTENCE), question: 'Waar komt "moet" in deze zin?' }).some(d => /already shows/.test(d)));
{
    // Written by GLM-5.3-Flash in the first real generation (2 Nov 2026): the
    // stem copied the template under the instruction, so the learner met the
    // gaps twice, once as underscores after a literal "\n\n" (the reader keeps
    // a JSON newline in prose as those two characters) and once as the input.
    const bike = asServed({
        question: 'Build the Dutch sentence that means "Last week she bought a new bike", putting the time expression in slot 1:\\n\\n___ ___ zij een nieuwe fiets.',
        type: 'assemble', template: '___ ___ zij een nieuwe fiets.',
        correct_answer: ['Vorige week', 'kocht'], distractors: ['gekocht', 'koopt', 'gisteren'],
        explanation: 'The finite verb kocht takes slot 2, right after the one element in slot 1.',
    });
    check('a stem that repeats the template\'s gaps is a defect: the input already draws them',
        questionDefects(bike).some(d => /gaps/.test(d) && /question/.test(d)), questionDefects(bike).join('; '));
    check('…also when the copy sits on its own line',
        questionDefects({ ...bike, question: 'Build the sentence for "Last week she bought a new bike".\n\n___ ___ zij een nieuwe fiets.' })
            .some(d => /gaps/.test(d) && /question/.test(d)));
    check('…but a stem that only says what to build is not',
        !questionDefects({ ...bike, question: 'Build the Dutch sentence that means "Last week she bought a new bike", with the time expression first.' })
            .some(d => /gaps/.test(d) && /question/.test(d)));
    check('the authoring rule tells the writer to keep the template out of the question',
        /never copies the template/.test(formatAuthoring('assemble').rule), formatAuthoring('assemble').rule.slice(-200));
}
check('a key that does not fill the template\'s gaps is a defect',
    defectsOf({ template: 'A ___\nB ___' }).some(d => /gap/.test(d)));
check('a bank that does not hold the key is a defect',
    defectsOf({ tokens: ['cell wall', 'nucleus', 'chloroplast', 'ribosome'] }).some(d => /piece/.test(d)));
check('a bank served in the key\'s order is a defect',
    defectsOf({ tokens: ['cell wall', 'nucleus', 'chloroplast', 'vacuole', 'ribosome'] }).some(d => /order/.test(d)));
check('a formula that crosses a gap is a defect',
    defectsOf({ template: 'A $x ___ y$\nB ___\nC ___\nD ___' }).some(d => /formula/.test(d)));

check('the feed accepts an assembly', normalizeFeedQuestion(EQUATION)?.type === 'assemble');
let admitted = 0;
try { admitted = finalizeQuiz(quizNode, JSON.stringify([SENTENCE, EQUATION]), false).questions.filter(x => x.type === 'assemble').length; } catch { /* nothing gradeable: reported below */ }
check('a saved quiz admits it by default: it grades with no model in the room', admitted === 2, `${admitted} admitted`);
// What the format DROPPED must not survive beside what it kept: an `accept`
// that needs a piece twice, and a distractor that is a key piece.
{
    let kept = null;
    try {
        kept = finalizeQuiz(quizNode, JSON.stringify([{ ...SENTENCE, accept: [['ik', 'ik', 'moet', 'werken']], distractors: ['ik'] }]), false)
            .questions.find(x => x.type === 'assemble');
    } catch { /* reported below */ }
    check('a saved quiz keeps no field the format dropped', !!kept && kept.accept === undefined && kept.distractors === undefined,
        kept ? `accept ${JSON.stringify(kept.accept)}, distractors ${JSON.stringify(kept.distractors)}` : 'dropped');
    // A saved quiz can be a mastery check, graded with no model in the room.
    let declared = null;
    try { declared = finalizeQuiz(quizNode, JSON.stringify([SENTENCE]), false).questions.find(x => x.type === 'assemble'); } catch { /* reported below */ }
    check('…nor another order its model declared, which nothing read', !!declared && declared.accept === undefined,
        declared ? `accept ${JSON.stringify(declared.accept)}` : 'dropped');
}

// The verifier solves an assembly cold and is told to copy the pieces; a
// model writing H2O for H₂O has copied it, a model writing co for CO has not.
const { assemblyAgrees } = await import(B + 'answerFormats.js');
check('the verifier\'s fill agrees with the key, through Unicode subscripts',
    assemblyAgrees?.(['2', '1', '2'], eq) === true
    && assemblyAgrees?.(['2', 'H2O'], { type: 'assemble', correct_answer: '["2","H₂O"]' }) === true);
check('…and with a declared other order', assemblyAgrees?.(SENTENCE.accept[0], sq) === true);
check('…but not with a different arrangement, nor a different case',
    assemblyAgrees?.(['1', '2', '2'], eq) === false
    && assemblyAgrees?.(['co', 'O₂', 'CoO₂'], { type: 'assemble', correct_answer: '["CO","O₂","CoO₂"]' }) === false);
// Fe²⁺ and Fe2+ fold to one text; when both are in the bank, the distractor
// is a different piece and choosing it is a different answer.
{
    const ions = { type: 'assemble', correct_answer: '["Fe²⁺","Cl⁻"]', tokens: ['Cl⁻', 'Fe2+', 'Fe²⁺'] };
    check('…nor with a distractor that only folds to a key piece',
        assemblyAgrees?.(['Fe2+', 'Cl⁻'], ions) === false && assemblyAgrees?.(['Fe²⁺', 'Cl⁻'], ions) === true);
}

const { showsAssembly } = await import(B + 'answerFormats.js');
const SHOWS = [
    ['Burning methane: CH₄ + 2O₂ → CO₂ + 2H₂O.', true, 'a reaction with subscripts'],
    ['$$\\ce{2H2 + O2 -> 2H2O}$$', true, 'a reaction in mhchem'],
    ['Na + Cl2 → NaCl', true, 'a reaction in ASCII'],
    ['In een bijzin staat de persoonsvorm achteraan: de woordvolgorde verandert.', true, 'a segment teaching word order (Dutch)'],
    ['German word order puts the verb second in a main clause.', true, '…(English)'],
    // How the real Dutch word-order lessons said it without "word order" (2 Nov run).
    ['Why English has no V2 rule: in Dutch the finite verb always stands in the second position.', true, 'the verb-second rule by its name, V2'],
    ['The modal skeleton: the modal verb sits in position 2, the infinitive at the end.', true, '…or by its position'],
    ['After a time phrase the subject and the verb swap: this is called inversion.', true, '…or as inversion'],
    ['Модальный глагол *moet* на втором месте, *innemen* в конце.', true, '…written in Russian'],
    // The same words in other subjects, with no verb in sight.
    ['Boyle\'s law: P1V1 = P2V2, so V2 = P1V1 / P2.', false, 'a gas law\'s V2 is a volume'],
    ['A chord in second inversion has its fifth in the bass.', false, 'a chord\'s inversion is music'],
    ['Matrix inversion: A has an inverse when det A ≠ 0.', false, '…and a matrix inversion algebra'],
    ['Store the result in position 2 of the array.', false, '…and position 2 of an array is not a sentence'],
    ['Our API v2 changes the PUT verb into PATCH.', false, '…nor an API\'s version beside an HTTP verb'],
    ['If P → Q and Q → R, then P → R.', false, 'a logical implication is not a reaction'],
    ['The function maps x -> 2x.', false, 'nor is a mapping'],
    ['If A + B → C, the sum is closed.', false, 'nor algebra with no number in it'],
    ['The machine moves S1 → S2 → S3 on each input.', false, 'nor the states of a machine'],
    ['Photosynthesis happens in the chloroplast.', false, 'plain prose'],
];
for (const [text, expected, why] of SHOWS) {
    check(`the feed reads ${expected ? '' : 'no '}assembly in: ${why}`, showsAssembly?.(text) === expected);
}

// ---------------------------------------------------------------------------
section('no question surface switches on a format itself');

// Every surface that asks a question renders the answer through AnswerInput.
// A surface that hand-renders one format is a surface the next format will not
// reach. The placement probe is the one exception, by design: it asks two
// formats it grades server-side, and it is the one stem with no media either.
const EXEMPT = new Set(['src/components/PlacementModal.tsx']);
const formatSwitch = /\.type\s*[!=]==?\s*'(multiple_choice|true_false|short_answer|numeric|code|sequence|assemble)'/;
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
    [{ type: 'assemble', template: 'a ___ b ___', correct_answer: '["x","y"]', tokens: ['y', 'z', 'x'] }, true],
    [{ type: 'assemble', template: 'a ___ b ___', correct_answer: '["x","x"]', tokens: ['x', 'y', 'z'], reuse: true }, true],
    [{ type: 'assemble', template: 'a ___ b ___', correct_answer: '["x","x"]', tokens: ['x', 'y', 'z'] }, false],
    [{ type: 'assemble', template: 'a ___ b ___', correct_answer: 'x, y', tokens: ['x', 'y', 'z'] }, false],
    [{ type: 'assemble', template: 'a ___ b', correct_answer: '["x","y"]', tokens: ['x', 'y', 'z'] }, false],
    [{ type: 'assemble', template: 'a ___ b ___', correct_answer: '["x","y"]', tokens: ['y', 'z'] }, false],
    [{ type: 'assemble', template: 'a ___ b ___', correct_answer: '["x","y"]' }, false],
    // The gap limits, on both sides: one gap is a typed answer, nine is past the cap.
    [{ type: 'assemble', template: 'a ___', correct_answer: '["x"]', tokens: ['x', 'y', 'z'] }, false],
    [{ type: 'assemble', template: Array(ASSEMBLE_LIMITS.maxGaps).fill('___').join(' '), correct_answer: JSON.stringify(Array.from({ length: ASSEMBLE_LIMITS.maxGaps }, (_, i) => `p${i}`)), tokens: Array.from({ length: ASSEMBLE_LIMITS.maxGaps }, (_, i) => `p${i}`) }, true],
    [{ type: 'assemble', template: Array(ASSEMBLE_LIMITS.maxGaps + 1).fill('___').join(' '), correct_answer: JSON.stringify(Array.from({ length: ASSEMBLE_LIMITS.maxGaps + 1 }, (_, i) => `p${i}`)), tokens: Array.from({ length: ASSEMBLE_LIMITS.maxGaps + 1 }, (_, i) => `p${i}`) }, false],
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
