// tools/feed-gates.mjs — deterministic assertions for the feed's non-model
// quality gates.
//
// Run:  node tools/feed-gates.mjs
//
// Sibling of tools/language-gates.mjs, and the same bargain: nothing here calls
// a model, so the whole suite runs in under a second and can be run on every
// change to server/feedQuality.js, server/questionOptions.js or the feed prompt
// contracts in server/ai.js.
//
// Every case below is either a defect that actually shipped to a learner or the
// FALSE POSITIVE that the fix for it could plausibly cause — the second half
// matters as much as the first, because each of these gates can throw away good
// teaching, and a gate nobody trusts gets switched off.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'feed-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const {
    keyEchoesStem, keyIsLengthOutlier, isShapeOnlyOption, stemNumbers, optionValue,
} = await import(B + 'questionOptions.js');
const {
    hasComputation, questionDefects, questionWeaknesses, stripSelfCertifyingCloser,
    stripSpecFences, extractCheckableVisuals, sameAnswer,
} = await import(B + 'feedQuality.js');
const { linearCombinationFaults } = await import(B + 'arithmetic.js');
const { getLanguage } = await import(B + 'language.js');
const { AI_PROMPTS } = await import(B + 'ai.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

// ---------------------------------------------------------------------------
// 1. hasComputation — the gate on the (paid) numeric audit
// ---------------------------------------------------------------------------
console.log('\n--- hasComputation: does this segment compute anything? ---');

// The real card. Multiple substitutions and results: must be audited.
const WAVE_SEGMENT = `The fundamental mode fits one quarter-wavelength: $L = \\lambda_1/4$, so $\\lambda_1 = 4L$.
For a pipe of $L = 0.50\\ \\text{m}$ with $v = 340\\ \\text{m/s}$:
$\\lambda_1 = 4(0.50\\ \\text{m}) = 2.00\\ \\text{m}$
$f_1 = \\frac{340\\ \\text{m/s}}{4(0.50\\ \\text{m})} = 170\\ \\text{Hz}$`;
check('a worked numeric example is audited', hasComputation(WAVE_SEGMENT), true);

check('a history segment with dates is not audited', hasComputation(
    'The Stamp Act of 1765 provoked the first coordinated colonial response. By 1773 the ' +
    'boycott had hardened, and in 1776 the Declaration made the break formal.',
), false);

check('a purely symbolic derivation is not audited', hasComputation(
    'Frequency and wavelength are inversely related: $f = v/\\lambda$. Holding $v$ fixed, a ' +
    'shorter wavelength therefore means a higher frequency.',
), false);

check('one lone figure is not enough to audit', hasComputation(
    'The speed of sound in air is about $340\\ \\text{m/s}$, which is the value used throughout.',
), false);

// A chart's numbers are the renderer's business (D-021) and the visual checker's.
check('numbers inside a visual spec do not trigger an audit', hasComputation(
    'The curve rises steeply at first and then flattens.\n\n' +
    '```vega-lite\n{"mark":"line","data":{"sequence":{"start":0,"stop":91,"step":15,"as":"a"}},' +
    '"transform":[{"calculate":"20*cos(datum.a*PI/180)","as":"v"}]}\n```\n\nThat is the whole shape.',
), false);

// but code IS the taught material, and `// 15` is a claim worth rechecking.
check('arithmetic inside a real code block is audited', hasComputation(
    'Integer division truncates:\n\n```csharp\nint total = 5 * 3;   // 15\nint each  = total / 2; // 7, not 7.5\n```',
), true);

check('spec fences are stripped, code fences are kept', [
    /vega/.test(stripSpecFences('```vega-lite\n{"mark":"line"}\n```')),
    /int total/.test(stripSpecFences('```csharp\nint total = 5;\n```')),
], [false, true]);

// ---------------------------------------------------------------------------
// 1b. linearCombinationFaults — arithmetic settled with no model at all
//
// The first block is the shipped bug and its neighbours. The second is the
// false-positive surface, which is where the danger is: this runs inside
// lessonDefects, so a spurious fault throws away a correct lesson and spends the
// rewrite budget arguing with itself.
// ---------------------------------------------------------------------------
console.log('\n--- linearCombinationFaults: does the equation add up? ---');

const R = String.raw;
const faulty = (t) => linearCombinationFaults(t).length > 0;

check('the shipped bug: lambda/4 + lambda/2 + lambda/2 = 3lambda/4', faulty(
    R`If you see a closed pipe diagram with three loops, the total length is $L = \lambda/4 + \lambda/2 + \lambda/2 = 3\lambda/4$.`,
), true);
check('the same sum written correctly', faulty(R`$L = \lambda/4 + \lambda/2 = 3\lambda/4$`), false);
check('a \\frac sum that is wrong', faulty(R`$\frac{L}{3} + \frac{L}{3} = L$`), true);
check('a \\frac sum that is right', faulty(R`$\frac{L}{2} + \frac{L}{2} = L$`), false);
check('shares of a whole, wrong', faulty('x/2 + x/4 + x/8 = x'), true);
check('shares of a whole, right', faulty('x/2 + x/4 + x/4 = x'), false);
check('a subtraction that is wrong', faulty('y/2 - y/4 = y/2'), true);
check('a chain stated in the other order', faulty(R`$$L = 5\lambda/4 = \lambda/4 + \lambda/2 + \lambda/2$$`), false);
check('the exact fault is named', linearCombinationFaults(
    R`$L = \lambda/4 + \lambda/2 + \lambda/2 = 3\lambda/4$`,
)[0].expected, 'λ/4 + λ/2 + λ/2 = 1.25λ, but 3λ/4 = 0.75λ');

// False positives. Every one of these is correct prose that a looser scanner
// reports — the "so"/"therefore" cases in particular, where a character-class
// scan runs straight through the word joining two separate equations and
// compares the left of the first with the right of the second.
check('two equations joined by "so" are not one chain', faulty(R`$L = \lambda_1/4$ so $\lambda_1 = 4L$`), false);
check('…nor by "therefore"', faulty(R`$x/2 = y$ therefore $y = 4x$`), false);
check('…nor by a comma', faulty(R`$a = L/2$, $b = 2L$`), false);
// The four false positives this checker shipped with, all from the live DB.
// A stripped relational macro is invisible where "so" is obvious, which is
// exactly why it survived the first round of testing.
check('…nor by \\implies', faulty(R`$L = \lambda_1 / 4 \implies \lambda_1 = 4L$`), false);
check('…nor by \\implies with a coefficient', faulty(R`$L = 3\lambda_2 / 4 \implies \lambda_2 = 4L / 3$`), false);
check('…nor by \\Rightarrow', faulty(R`$L = \lambda_1 / 2 \Rightarrow \lambda_1 = 2L$`), false);
// A segment mixing two symbols is DECLINED, not evaluated: x/2 + y/4 is not
// 0.75 of anything, and a checker that adds the coefficients anyway reports
// "x/2 + y/4 = 0.75x, but x = 1x" on prose that is perfectly correct. This
// runs inside lessonDefects, so that verdict throws the lesson away.
check('a mixed-symbol sum is declined, not evaluated', faulty('x/2 + y/4 = x'), false);
check('…in the other order too', faulty('x = x/2 + y/4'), false);
check('…and with LaTeX fractions', faulty(R`$\frac{L}{2} + \frac{W}{2} = L$`), false);
// The decline must be surgical: a mixed segment in a chain must not suppress a
// wrong single-symbol segment sitting beside it.
check('but a wrong single-symbol segment in the same chain is still caught',
    faulty('x/2 + y/4 = x/2 + x/4 = x'), true);
check('\\Delta x is not x', faulty(R`$\Delta x = x - x_0$`), false);
check('a subscripted quantity is its own quantity', faulty('x/2 + x_0/2 = x'), false);
check('a subscript is an index, not a factor', faulty(R`$\lambda_1/2 + \lambda_1/2 = \lambda_1$`), false);
check('…and a wrong sum in one subscripted quantity is still caught',
    faulty(R`$\lambda_1/3 + \lambda_1/3 = \lambda_1$`), true);
check('quantities in different symbols are never compared', faulty(R`$E = mc^2$ and $p = mv$`), false);
check('values carrying units are left alone', faulty(R`$f_1 = 170\ \text{Hz}$ and $f_2 = 510\ \text{Hz}$`), false);
check('a parenthesised multiple is not evaluated', faulty(R`$L = 3(\lambda_3/2)$`), false);
check('division by zero is skipped, not reported', faulty('x/0 = x'), false);
check('ordinary prose is never touched', faulty('The next segment shows how to count the loops in a diagram.'), false);
check('assignment in real code is not an equation', faulty('int total = 5 * 3;'), false);

// ---------------------------------------------------------------------------
// 2. keyEchoesStem — the answer readable off the question
// ---------------------------------------------------------------------------
console.log('\n--- keyEchoesStem: can the key be picked without understanding? ---');

// The live card: "…fits exactly five quarter-wavelengths…" with key $5f_1$.
check('a spelled-out number echoed by the key alone', keyEchoesStem(
    'A musician plays a closed pipe of fixed length $L$. They excite a standing wave that fits ' +
    'exactly five quarter-wavelengths inside the pipe. If the fundamental frequency is $f_1$, ' +
    'what is the frequency of this new standing wave?',
    ['$5f_1$', '$4f_1$', '$3f_1$', '$6f_1$'], '$5f_1$',
), true);

check('a digit echoed by the key alone', keyEchoesStem(
    'A string vibrates with 3 loops between its fixed ends. What is $n$?',
    ['3', '2', '4', '6'], '3',
), true);

// The stem's numbers are the GIVENS and the key is derived from them — the
// normal, healthy shape of a calculation question. Must not fire.
check('a key derived from the givens is fine', keyEchoesStem(
    'A closed pipe is $0.50$ m long and the speed of sound is $340$ m/s. What is $f_1$?',
    ['$170$ Hz', '$340$ Hz', '$85$ Hz', '$510$ Hz'], '$170$ Hz',
), false);

// When a distractor echoes the stem too, the number is a shared premise and the
// echo carries no information.
check('a number shared with a distractor is a premise, not a giveaway', keyEchoesStem(
    'A pipe supports 3 loops. Which wavelength fits?',
    ['$4L/5$', '$3L$', '$L/2$', '$2L$'], '$4L/5$',
), false);

check('too few numeric options to judge', keyEchoesStem(
    'A pipe fits five quarter-wavelengths. What follows?',
    ['$5f_1$', 'the pitch falls', 'nothing changes'], '$5f_1$',
), false);

check('non-numeric options never echo', keyEchoesStem(
    'Which boundary condition holds at 1 closed end?',
    ['a displacement node', 'a displacement antinode', 'a pressure node', 'neither'],
    'a displacement node',
), false);

check('a stem with no numbers never echoes', keyEchoesStem(
    'Which end of a closed pipe carries a displacement node?',
    ['the capped end', 'the open end', 'both ends', 'neither end'], 'the capped end',
), false);

check('stemNumbers reads digits, decimals and number words', [
    [...stemNumbers('exactly five quarter-wavelengths')].sort((a, b) => a - b),
    [...stemNumbers('a 0,50 m pipe at 340 m/s')].sort((a, b) => a - b),
], [[0.25, 5], [0.5, 340]]);

// ---------------------------------------------------------------------------
// 3. keyIsLengthOutlier / isShapeOnlyOption
// ---------------------------------------------------------------------------
console.log('\n--- other distractor tells ---');

check('the key hoarding the qualifying clauses', keyIsLengthOutlier(
    [
        'Only odd multiples of the quarter-wavelength fit, because the closed end must stay a node',
        'All multiples fit',
        'Only even multiples fit',
        'No standing wave forms',
    ],
    'Only odd multiples of the quarter-wavelength fit, because the closed end must stay a node',
), true);

check('a uniformly wordy option set is fine', keyIsLengthOutlier(
    [
        'Only odd multiples of the quarter-wavelength fit inside the pipe',
        'Only even multiples of the quarter-wavelength fit inside the pipe',
        'Every integer multiple of the half-wavelength fits inside the pipe',
        'No standing wave can form inside a pipe closed at one end',
    ],
    'Only odd multiples of the quarter-wavelength fit inside the pipe',
), false);

check('a short key is never an outlier', keyIsLengthOutlier(['$5f_1$', '$4f_1$', '$3f_1$', '$6f_1$'], '$5f_1$'), false);

check('shape-only options', [
    isShapeOnlyOption('All of the above'),
    isShapeOnlyOption('none of these'),
    isShapeOnlyOption('All of the harmonics above the fundamental'),
    isShapeOnlyOption('Both ends are antinodes'),
    // NOT shape-only: in statistics, logic or graph reading these are often the
    // correct answer, and flagging them throws away good questions.
    isShapeOnlyOption('Cannot be determined'),
    isShapeOnlyOption('Not enough information'),
], [true, true, false, false, false, false]);

// ---------------------------------------------------------------------------
// 4. hard defects vs soft weaknesses — the split that stops a gate from
//    replacing a merely-easy question with no question at all
// ---------------------------------------------------------------------------
console.log('\n--- questionDefects (never serve) vs questionWeaknesses (serve, but retry) ---');

const echoQuestion = {
    type: 'multiple_choice',
    question: 'A closed pipe fits exactly five quarter-wavelengths. If the fundamental is $f_1$, what is the frequency?',
    options: ['$5f_1$', '$4f_1$', '$3f_1$', '$6f_1$'],
    correct_answer: '$5f_1$',
    explanation: 'Only odd multiples of the quarter-wavelength fit in a closed pipe.',
};
check('the live card is servable', questionDefects(echoQuestion).length, 0);
check('the live card is weak', questionWeaknesses(echoQuestion).length, 1);

const soundQuestion = {
    type: 'multiple_choice',
    question: 'A closed pipe $0.50$ m long is driven at its first overtone. With $v = 340$ m/s, what frequency sounds?',
    options: ['$510$ Hz', '$340$ Hz', '$170$ Hz', '$680$ Hz'],
    correct_answer: '$510$ Hz',
    explanation: 'The first overtone of a closed pipe is the third harmonic, three times the fundamental.',
};
check('a sound question has no defects', questionDefects(soundQuestion).length, 0);
check('a sound question has no weaknesses', questionWeaknesses(soundQuestion).length, 0);

check('a missing explanation is still hard', questionDefects({ ...soundQuestion, explanation: '' }).length, 1);
check('weaknesses ignore open questions', questionWeaknesses({ type: 'short_answer', question: 'Why?' }).length, 0);
check('weaknesses ignore true/false', questionWeaknesses({ type: 'true_false', question: 'A closed pipe has only odd harmonics.' }).length, 0);

// ---------------------------------------------------------------------------
// 5. self-certifying closers written as a subordinate clause
// ---------------------------------------------------------------------------
console.log('\n--- closers the anchored pattern could not see ---');

const body = 'For a closed pipe the first segment is a quarter-wavelength and each further loop adds a half.';
const stripped = (para, code = 'en') =>
    stripSelfCertifyingCloser(`${body}\n\n${para}`, getLanguage(code)) === body;

// The live card's actual last sentence. Begins with a gerund, so the anchored
// pattern never fired.
check('"Mastering this … ensures you can …"', stripped(
    'Mastering this visual scan ensures you can immediately bridge a diagram to a numerical answer without guessing the harmonic number.',
), true);
check('"This means you are now able to …"', stripped(
    'This means you are now able to identify the harmonic from any diagram.',
), true);
check('the anchored form still strips', stripped(
    'You can now calculate the deviation for any angle of incidence.',
), true);

// FALSE-POSITIVE GUARDS. These are real closing arguments and deleting one is
// worse than leaving a closer standing.
check('a closing argument with no learner reference survives', stripped(
    'With this equation, the period follows directly from the length of the pipe.',
), false);
check('a forward gesture survives', stripped(
    'The next segment shows how to read these patterns straight off a diagram.',
), false);
// Three sentences: the unanchored pattern is not allowed to reach it, because a
// closing argument that runs this long is teaching.
check('a three-sentence final paragraph survives the unanchored check', stripped(
    'The same counting works for a string. Each loop you see is a half-wavelength, which means the ' +
    'count is the harmonic number itself. That difference is what the closed pipe forces you to remember.',
), false);
// A decimal must not be read as a sentence boundary, or the two-sentence guard
// silently stops applying to exactly the segments that do arithmetic.
check('a decimal does not inflate the sentence count', stripped(
    'A pipe of 0.50 m gives 170 Hz. Knowing this means you can size any pipe to a pitch.',
), true);
check('Dutch subordinate certification', stripped(
    'Door deze telling kun je de harmonische direct uit een tekening aflezen.', 'nl',
), true);
// A language with no certify pattern keeps the anchored behaviour and nothing
// more — declining to strip is the documented posture, not a bug.
check('a language without a certify pattern strips nothing extra', stripped(
    'Padroneggiare questa scansione ti permette di leggere il diagramma.', 'it',
), false);

// ---------------------------------------------------------------------------
// 6. prompt contracts the generator depends on
// ---------------------------------------------------------------------------
console.log('\n--- prompt contracts ---');

const outline = [{ title: 'Closed pipes', focus: 'quarter-wavelength patterns' }, { title: 'Reading diagrams', focus: 'count the loops' }];

const clean = AI_PROMPTS.feed_lesson('Standing Waves', outline, 2, 'ctx', []);
const rewrite = AI_PROMPTS.feed_lesson('Standing Waves', outline, 2, 'ctx', [], {
    priorFault: 'the sum lambda/4 + lambda/2 + lambda/2 was given as 3lambda/4',
});
check('a first draft carries no rejection block', /PREVIOUS DRAFT/.test(clean.user), false);
check('a rewrite is told what failed', /PREVIOUS DRAFT[\s\S]*3lambda\/4/.test(rewrite.user), true);
check('the lesson prompt states the notation rule', /NOTATION FOLLOWS THE CURRICULUM/.test(clean.system), true);
check('the lesson prompt warns numbers are rechecked', /WILL BE RECHECKED/.test(clean.system), true);
check('the visuals guide demands the thing, not a picture about it', /SHOW THE THING TO READ/.test(clean.system), true);

const q = AI_PROMPTS.feed_question('Standing Waves', 'Closed pipes', 'text', 'multiple_choice', {
    priorFault: 'the key just repeated a number from the stem',
});
check('a question rewrite is told what failed', /PREVIOUS ATTEMPT[\s\S]*repeated a number/.test(q.user), true);
check('the question prompt demands surviving distractors', /EVERY DISTRACTOR MUST SURVIVE/.test(q.system), true);

const verify = AI_PROMPTS.feed_question_verify('Standing Waves', {
    type: 'multiple_choice', question: 'q', options: ['a', 'b'], correct_answer: 'a',
});
check('the verifier reports eliminable options', /"eliminable"/.test(verify.system), true);
check('the verifier is not shown the key', /correct_answer|"a"\s*is correct/.test(verify.user), false);

const visual = AI_PROMPTS.feed_visual_check('Reading diagrams', 'prose', 'mermaid', 'graph TD');
check('the visual checker can blame the prose', /"text-wrong"/.test(visual.system), true);

const audit = AI_PROMPTS.feed_lesson_audit('Standing Waves', 'Closed pipes', WAVE_SEGMENT, [
    { title: 'Open pipes', content: 'Both ends are antinodes, so $L = n\\lambda/2$.' },
]);
check('the audit sees the earlier parts', /EARLIER PARTS[\s\S]*Both ends are antinodes/.test(audit.user), true);
check('the audit is told style is not its business', /NOT your business/.test(audit.system), true);
check('the audit is told most segments are ok', /most segments are ok/.test(audit.system), true);

// ---------------------------------------------------------------------------
// 7. visual extraction still finds what the checker needs
// ---------------------------------------------------------------------------
console.log('\n--- visual extraction ---');
const withVisual = `Follow this decision sequence:\n\n\`\`\`mermaid\ngraph TD\n  A["Look at the boundaries"] --> B["Count the loops"]\n\`\`\`\n\nOnce you have $n$, substitute.`;
const found = extractCheckableVisuals(withVisual);
check('one checkable visual found', found.length, 1);
check('the prose on both sides is handed to the checker', [
    /decision sequence/.test(found[0]?.prose || ''),
    /substitute/.test(found[0]?.prose || ''),
], [true, true]);

// ---------------------------------------------------------------------------
// 10. sameAnswer — the entire verdict of the answer-key verifier
// ---------------------------------------------------------------------------
// One boolean decides whether the verifier AGREES with a stored key. It used to
// squash both strings to [a-z0-9À-ɏ] and test raw substring containment, which
// was wrong in BOTH directions at once — so both directions are asserted.
console.log('\n--- sameAnswer: packaging is forgiven ---');
check('the same answer, differently packaged', sameAnswer('525 Hz', 'The answer is 525 Hz'), true);
check('LaTeX delimiters are not a difference', sameAnswer('$525$ Hz', '525 Hz'), true);
check('trailing punctuation is not a difference', sameAnswer('525 Hz', '525 Hz.'), true);
check('decimal comma equals decimal point', sameAnswer('1,5 m', '1.5 m'), true);

console.log('\n--- sameAnswer: a different number is never the same answer ---');
// Failed OPEN before: "5 hz" is a raw substring of "525 hz", so a verifier that
// picked the giveaway distractor read as agreement with the key.
check('a shorter number inside a longer one', sameAnswer('5 Hz', '525 Hz'), false);
check('a digit dropped off the front', sameAnswer('15 Hz', '515 Hz'), false);
check('a bare number inside another', sameAnswer('2', '12'), false);
check('sign is part of the number', sameAnswer('x = 3', 'x = -3'), false);
check('sign is kept when it matches', sameAnswer('x = -3', 'x = -3'), true);
check('the two twins of an ambiguous stem differ', sameAnswer('515 Hz', '525 Hz'), false);

console.log('\n--- sameAnswer: every script, not just Latin ---');
// Failed CLOSED before: a non-Latin answer normalized to '' and came back as
// "answer key disputed", so a kana or Cyrillic project dropped every question
// whose answer is written in its own script.
check('kana agrees with itself', sameAnswer('お', 'お'), true);
check('cyrillic agrees with itself', sameAnswer('Привет', 'Привет'), true);
check('greek agrees with itself', sameAnswer('Ελλάδα', 'Ελλάδα'), true);
check('han agrees with itself', sameAnswer('你好', '你好'), true);
check('two different kana still differ', sameAnswer('お', 'あ'), false);


// ---------------------------------------------------------------------------
// ---- the symmetric-stem weakness + the grader's third verdict --------------
// This suite's check compares got === want; these are boolean conditions.
const okc = (label, cond, extra = '') => check(label + (extra ? ` (${String(extra).slice(0, 120)})` : ''), !!cond, true);
console.log('\n--- symmetric about a stem number ---');
{
    const { symmetricAboutStem } = await import(B + 'questionOptions.js');
    const beat = symmetricAboutStem(
        'A musician hears 5 beats per second when tuning their instrument to a 520 Hz reference tone. What is the frequency of their instrument?',
        ['525 Hz', '515 Hz', '520 Hz', '530 Hz'], '525 Hz');
    okc('the 520 Hz beat stem is flagged: key 525 and distractor 515 sit symmetrically about it', !!beat && beat.key === 525 && beat.distractor === 515 && beat.reference === 520, JSON.stringify(beat));
    okc('the same options without a comparative cue in the stem are not flagged',
        symmetricAboutStem('What is the frequency of the instrument, given that 520 Hz is mentioned?', ['525 Hz', '515 Hz', '520 Hz', '530 Hz'], '525 Hz') === null);
    okc('a pair symmetric only by arithmetic accident (far from the reference) is not flagged',
        symmetricAboutStem('Two tuning forks vibrate at 440 Hz and 442 Hz. What is the beat frequency compared to before?', ['2 Hz', '882 Hz', '4 Hz', '1 Hz'], '2 Hz') === null);
    okc('a stem that names the direction is still flagged by this rule (the direction word is not parsed) — the weakness is soft, so that is the accepted cost',
        !!symmetricAboutStem('Your instrument is sharp: you hear 5 beats against a 520 Hz reference. What is its frequency?', ['525 Hz', '515 Hz', '520 Hz', '530 Hz'], '525 Hz'));
    const { questionWeaknesses } = await import(B + 'feedQuality.js');
    const weak = questionWeaknesses({ type: 'multiple_choice', question: 'You hear 5 beats against a 520 Hz reference. What is your frequency?', options: ['525 Hz', '515 Hz', '520 Hz', '530 Hz'], correct_answer: '525 Hz', explanation: 'x' });
    okc('questionWeaknesses reports it as a weakness, not a defect', weak.some(w => /symmetrically/.test(w)), weak.join(' | '));
}
console.log('\n--- the grader can say "unsure" ---');
{
    const { parseAnswerVerdict } = await import(B + 'ai.js');
    okc('true → correct', parseAnswerVerdict('{"correct": true, "explanation": "yes"}')?.verdict === 'correct');
    okc('false → incorrect', parseAnswerVerdict('prefix {"correct": false, "explanation": "no"} suffix')?.verdict === 'incorrect');
    okc('"unsure" (any case) → unsure, with its explanation', (() => { const r = parseAnswerVerdict('{"correct": "Unsure", "explanation": "two readings"}'); return r?.verdict === 'unsure' && r.explanation === 'two readings'; })());
    okc('anything else is no verdict at all', parseAnswerVerdict('{"correct": "maybe"}') === null && parseAnswerVerdict('not json') === null && parseAnswerVerdict('{"explanation": "x"}') === null);
}

// --- writing a repaired visual back into the card it was read in -----------
//
// Every surface that renders AI content must own a write-back, or a
// self-healing card is an LLM call on every page load. The feed's trap is that
// `feed_items.content` has two shapes: a lesson is raw markdown, a question or
// practice card is a JSON payload whose text is JSON-ESCAPED — so the spec the
// renderer saw does not appear in the stored bytes, and the plain substring
// replace that works for a lesson silently does nothing for a question.
{
    const { replaceSpecInContent } = await import(B + 'feed.js');
    const okc = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); };
    console.log('\nfeed visual write-back');

    const lesson = 'Intro.\n\n```mermaid\nflowchart LR\n```\n\nOutro.';
    okc('a lesson is patched as plain markdown',
        replaceSpecInContent(lesson, 'flowchart LR', 'flowchart TD') === lesson.replace('flowchart LR', 'flowchart TD'));

    const question = JSON.stringify({
        question: 'Read the diagram:\n\n```mermaid\nflowchart LR\n```',
        type: 'multiple_choice',
        options: ['a', 'b'],
    });
    const patched = replaceSpecInContent(question, 'flowchart LR', 'flowchart TD');
    okc('a JSON card is patched inside its VALUES', patched !== null && JSON.parse(patched).question.includes('flowchart TD'));
    okc('the rest of the payload survives', patched !== null && JSON.parse(patched).options.length === 2);
    okc('the result is still valid JSON', patched !== null && typeof JSON.parse(patched) === 'object');

    okc('a spec that is not there returns null, never an unchanged write',
        replaceSpecInContent(lesson, 'graph TB', 'flowchart TD') === null
        && replaceSpecInContent(question, 'graph TB', 'flowchart TD') === null);
    // A lesson may legitimately begin with a digit or a quote; round-tripping it
    // through JSON would rewrite prose nobody asked to change.
    okc('markdown that merely looks scalar is not treated as JSON',
        replaceSpecInContent('42 is the answer to flowchart LR', 'flowchart LR', 'flowchart TD')
        === '42 is the answer to flowchart TD');
    okc('a nested payload is reached',
        JSON.parse(replaceSpecInContent(JSON.stringify({ a: { b: ['x flowchart LR'] } }), 'flowchart LR', 'flowchart TD')).a.b[0]
        === 'x flowchart TD');

    // The client half of the same repair: it patches the card object without
    // knowing which field holds the spec, and returns the SAME object when
    // nothing matched, so the caller skips both the re-render and the request.
    const require2 = (await import('node:module')).createRequire(import.meta.url);
    const esbuild2 = require2('esbuild');
    const dOut = join(scratch, 'deepReplace.mjs');
    await esbuild2.build({
        entryPoints: [(await import('node:url')).fileURLToPath(new URL('../src/utils/deepReplace.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: dOut, logLevel: 'silent',
    });
    const { deepReplaceStrings } = await import((await import('node:url')).pathToFileURL(dOut).href);

    const card = { key: 'k1', kind: 'question', feedItemId: 7, question: { question: 'see ```mermaid\nflowchart LR\n```' } };
    const next = deepReplaceStrings(card, 'flowchart LR', 'flowchart TD');
    okc('the client patches whatever field holds the spec', next.question.question.includes('flowchart TD'));
    okc('identity survives a miss', deepReplaceStrings(card, 'graph TB', 'flowchart TD') === card);
    okc('numbers and ids are untouched', next.feedItemId === 7 && next.key === 'k1');
}
// --- a notice can be read in the reader's language ---------------------------
//
// `composeFeed` writes its notices in English and they arrive as `card.message`,
// so NoticeCard mirrors them as `k()` markers and renders `t(card.message)`.
// Two lists, one meaning: this is what stops a fourth notice being added on the
// server and shipping untranslated on the only card that explains itself.
{
    const serverSrc = readFileSync(new URL('../server/feed.js', import.meta.url), 'utf8');
    const clientSrc = readFileSync(new URL('../src/components/feed/NoticeCard.tsx', import.meta.url), 'utf8');
    const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));

    // Every `message:` literal inside a `kind: 'notice'` item.
    const notices = [];
    for (const block of serverSrc.split("kind: 'notice',").slice(1)) {
        const head = block.slice(0, 700);
        for (const m of head.matchAll(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
            const text = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
            if (text.split(' ').length > 4) notices.push(text);
        }
        if (/\n\s*\}\);/.test(head)) continue;
    }
    okc('composeFeed still writes notices this gate can see', notices.length >= 3);
    const missing = notices.filter((n) => !clientSrc.includes(n));
    okc(`every notice is mirrored in NoticeCard (${notices.length})`, missing.length === 0, missing[0]);
    const unlisted = notices.filter((n) => !(n in en));
    okc('and every one of them is a key in en.json', unlisted.length === 0, unlisted[0]);
    okc('NoticeCard renders the message through a translator', /\{t\(card\.message\)\}/.test(clientSrc));
}
console.log(`\n${pass} passed, ${fail} failed`);
// better-sqlite3 still holds the scratch file open on Windows, where an open
// handle makes the directory undeletable. It is in the OS temp dir either way.
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail === 0 ? 0 : 1);
