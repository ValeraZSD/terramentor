#!/usr/bin/env node
// tools/form-grading-gates.mjs — grammar and spelling count when the task is
// about them, and only then.
//
// Run:  node tools/form-grading-gates.mjs [--server <dir>]
//
// The open-answer checker (`answer_checker`, server/ai.js) was told to ignore
// spelling and grammar on every answer and was never told the course
// language, so on a Dutch course "write the right verb form" passed with the
// wrong form. The rule now: an answer is judged by its meaning, unless the
// task tests FORM (a verb form, an ending, an article, agreement, word order,
// spelling); then the form counts too. The question's writer says which
// (`tests_form`), the cold verifier must agree before the flag is kept, the
// checker reads it with the course's language, and a miss on form alone gets
// one more try in the stream.
//
// Asserted here, with a stub model on loopback (nothing billed):
//   1. the checker's prompt: a content task is marked exactly as before
//      (spelling and grammar ignored, with or without a course language); a
//      form task marks them, names the language, and asks for a hint that does
//      not hand over the corrected form;
//   2. checkAnswerWithAI: a form task never takes the quick "you named the key
//      idea" path on a partial match; a form miss comes back as `formMiss`
//      with its hint (a hint holding the key is dropped); a content task never
//      has a form miss; a content answer with a typo reaches the model under
//      the ignore-spelling rule;
//   3. the route: `testsForm` and `nodeId` reach the checker, the course
//      language is the node's project's, and a non-boolean flag is no flag;
//   4. the writer: the authoring rule for typed formats names `tests_form`,
//      every reducer keeps it on the typed formats only;
//   5. the gate on the flag: the verifier is asked, blind to the writer's
//      claim, whether the task tests form; a flag it does not confirm is
//      dropped (the question is kept), on the mastery-check bank and the
//      background re-check; a question still unchecked has its flag ignored
//      when graded; every caller that stores a verified question settles it;
//   6. local grading: a form task's typed gap forgives no spelling slip, on
//      the server and in the client mirror, and its hint says so;
//   7. the client: `gradeAnswer` sends the flag and the topic, and the feed
//      question offers one more try after a form miss, with the key hidden
//      until that try or "Show the answer"; the second try records nothing.
//
// `--server <dir>` runs the server half against another copy of server/ (the
// pre-fix code) to prove it fails there.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const si = argv.indexOf('--server');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = si >= 0 ? resolve(argv[si + 1]) : join(root, 'server');
const B = pathToFileURL(serverDir + '/').href;

const scratch = mkdtempSync(join(tmpdir(), 'form-grading-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
};
const section = (s) => console.log(`\n--- ${s} ---`);
const attempt = (fn) => { try { return fn(); } catch (err) { return { threw: err?.message || String(err) }; } };

// ---- the stub model: loopback only, set BEFORE any module can call out ------
// `replies` is a queue per job: the checker's verdicts and the verifier's.
const seen = { checker: [], verifier: [], probe: [] };
const replies = { checker: [], verifier: [], probe: [] };
const CHECKER = /You mark a learner's answer and reply TO THEM/;
const VERIFIER = /checking a question before it is shown|audit the MODEL ANSWER/;
const PROBE = /You write ONE diagnostic question/;
const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const msgs = (() => { try { return JSON.parse(body).messages || []; } catch { return []; } })();
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.find(m => m.role === 'user')?.content || '';
        let content;
        if (CHECKER.test(system)) {
            seen.checker.push({ system, user });
            content = replies.checker.shift() ?? JSON.stringify({ correct: true, explanation: 'You got it.' });
        } else if (VERIFIER.test(system)) {
            seen.verifier.push({ system, user });
            // With nothing queued the verifier says nothing about form, so a
            // case that forgets to queue its answer cannot confirm a flag.
            content = replies.verifier.shift() ?? JSON.stringify({ verdict: 'ok', answer: 'x', reason: 'fine', eliminable: 0 });
        } else if (PROBE.test(system)) {
            seen.probe.push({ system, user });
            content = replies.probe.shift() ?? '{}';
        } else {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end('{"error":{"message":"stub: not part of this gate"}}');
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 20 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

const { default: db } = await import(B + 'database.js');
const ai = await import(B + 'ai.js');
const formats = await import(B + 'answerFormats.js');
const { getLanguage, withLearning } = await import(B + 'language.js');
const { normalizeFeedQuestion } = await import(B + 'feed.js');
const { finalizeQuiz, vetQuiz } = await import(B + 'studyMaterial.js');
const { verifyQuestion } = await import(B + 'feedQuality.js');
const { AI_PROMPTS, checkAnswerWithAI } = ai;
db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

// A course that teaches Dutch to someone who reads Russian.
const ruNl = withLearning(getLanguage('ru'), getLanguage('nl'));
const nlOnly = getLanguage('nl');

const VERB_Q = 'Vul de juiste vorm van "lopen" in: Hij ___ elke dag naar school.';
const IGNORE = /Ignore spelling and grammar; never mark down for them\./;
const checker = (opts) => attempt(() => AI_PROMPTS.answer_checker(VERB_Q, 'loopt', 'lopen', opts));
const lastChecker = () => seen.checker.at(-1);
const reply = (o) => JSON.stringify(o);

// ---------------------------------------------------------------------------
section('1. the checker\'s prompt');
const plain = checker(undefined);
const plainEmpty = checker({});
check('a content task: spelling and grammar are ignored, as before', IGNORE.test(plain.system || ''), plain.threw);
check('...and an empty options object changes nothing', plain.system === plainEmpty.system && plain.user === plainEmpty.user);
// The content prompt, byte for byte, as it was before form tasks existed
// (sha256 of system + "\n\0\n" + user, taken from main c82ef280). A change to
// it is a change to how every open answer is marked: update this on purpose.
const CONTENT_PROMPT_SHA = 'af346392eb8a490e8039bbcf7afffc40e95f0a2750c56a4c032708656dd2029f';
check('a content task\'s prompt is byte for byte the one before form tasks',
    createHash('sha256').update(`${plain.system}\n\u0000\n${plain.user}`).digest('hex') === CONTENT_PROMPT_SHA);
const contentOnCourse = checker({ lang: ruNl });
check('a content task on a course that teaches Dutch is marked exactly as before (a typo still passes)',
    contentOnCourse.system === plain.system && contentOnCourse.user === plain.user);
const contentFalse = checker({ testsForm: false, lang: ruNl });
check('...and so is one whose writer said it does not test form', contentFalse.system === plain.system);
const form = checker({ testsForm: true, lang: ruNl });
const fs = form.system || '';
check('a form task: no longer told to ignore spelling and grammar', !!form.system && !IGNORE.test(fs), form.threw);
check('...told that a wrong form is wrong even when the meaning is right',
    /INCORRECT,? even when (its|the) meaning is right/i.test(fs));
check('...names the forms it means (verb form, ending, article, agreement, word order, spelling)',
    ['verb form', 'ending', 'article', 'agreement', 'word order', 'spelling'].every(w => fs.toLowerCase().includes(w)));
check('...accepts every form a native speaker accepts', /native speaker/i.test(fs) && /another correct word order/i.test(fs));
check('...names the language whose form counts: Dutch, the language the course teaches', /Dutch \(Nederlands\)/.test(fs));
check('...and replies in the language the learner reads: Russian', /Reply in Russian/.test(fs));
check('...asks for "form_error" and a "hint"', /"form_error"/.test(fs) && /"hint"/.test(fs) && /"form_error"/.test(form.user || ''));
check('...a hint that points at the word and the rule WITHOUT writing the corrected form',
    /without writing the correct(ed)? (word|form)/i.test(fs));
const formNoLang = checker({ testsForm: true });
check('a form task with no course language: still marks form, names no language',
    !!formNoLang.system && !IGNORE.test(formNoLang.system) && /INCORRECT,? even when/i.test(formNoLang.system)
    && !/Dutch|Russian/.test(formNoLang.system) && !/Reply in/.test(formNoLang.system));
const formNative = checker({ testsForm: true, lang: nlOnly });
check('a form task on a course written in the language it drills (Dutch in Dutch): Dutch is the form and the reply',
    /Dutch \(Nederlands\)/.test(formNative.system || '') && /Reply in Dutch/.test(formNative.system || ''));
const formEs = checker({ testsForm: true, lang: getLanguage('es') });
check('...a course that teaches no other language names its own as the course\'s, the task\'s language decides (a Latin name in a Spanish course)',
    /course is written in Spanish/.test(formEs.system || '') && /in the language the task asks for/.test(formEs.system || '')
    && !/tests FORM in Spanish/.test(formEs.system || ''));
check('...a course that teaches Dutch: no such hedge, Dutch is the form', !/the language the task asks for/.test(fs));

// ---------------------------------------------------------------------------
section('2. checkAnswerWithAI');
const asked = async (fn) => {
    const before = seen.checker.length;
    const r = await fn();
    replies.checker.length = 0; // a reply the call did not ask for must not answer the next one
    return { r, asked: seen.checker.length > before, prompt: seen.checker.length > before ? lastChecker() : null };
};
// "hond" is inside "de hond": the content path calls that the key idea, but a
// task about the article has just been answered without one.
let t = await asked(() => checkAnswerWithAI('Welk lidwoord hoort bij "hond"? Schrijf lidwoord en woord.', 'de hond', 'hond'));
check('a content task: a word of a short key is still the quick "key idea" accept, no model', t.r?.correct === true && !t.asked);
t = await asked(() => checkAnswerWithAI('Welk lidwoord hoort bij "hond"? Schrijf lidwoord en woord.', 'de hond', 'hond', { testsForm: true, lang: ruNl }));
check('a form task: the same partial answer is NOT quick-accepted, the model judges it', t.asked && /INCORRECT,? even when/i.test(t.prompt?.system || ''));
t = await asked(() => checkAnswerWithAI('Schrijf de zin in de voltooide tijd.', 'Ik ben naar huis gelopen.', 'Ik ben naar huis gelopen.', { testsForm: true, lang: ruNl }));
check('a form task: the key typed exactly is right with no model', t.r?.correct === true && !t.asked);
t = await asked(() => checkAnswerWithAI('Schreib das Nomen mit Artikel.', 'das Haus', 'das haus', { testsForm: true, lang: getLanguage('de') }));
check('a form task: a capital letter missing is the model\'s call, never a quick accept', t.asked);

replies.checker.push(reply({ correct: false, form_error: true, hint: 'Kijk naar de uitgang: het onderwerp is "hij".', explanation: 'Na "hij" komt "loopt", met een t.' }));
t = await asked(() => checkAnswerWithAI(VERB_Q, 'loopt', 'lopen', { testsForm: true, lang: ruNl }));
check('a form miss comes back marked wrong, as a form miss, with its hint',
    t.r?.correct === false && t.r?.formMiss === true && t.r?.hint === 'Kijk naar de uitgang: het onderwerp is "hij".', JSON.stringify(t.r));
check('...and the explanation is kept for after the second try', /loopt/.test(t.r?.explanation || ''));

replies.checker.push(reply({ correct: false, form_error: true, hint: 'Write loopt here.', explanation: 'x' }));
t = await asked(() => checkAnswerWithAI(VERB_Q, 'loopt', 'lopen', { testsForm: true, lang: ruNl }));
check('a hint that writes the key is dropped (the try would be copying), the form miss stays',
    t.r?.formMiss === true && !t.r?.hint, JSON.stringify(t.r));

// A sentence key: the hint must not write the one word the answer got wrong.
const PERFECT_Q = 'Zet in de voltooide tijd: Ik loop naar huis.';
replies.checker.push(reply({ correct: false, form_error: true, hint: 'Gebruik "ben", niet "heb".', explanation: 'x' }));
t = await asked(() => checkAnswerWithAI(PERFECT_Q, 'Ik ben naar huis gelopen.', 'Ik heb naar huis gelopen.', { testsForm: true, lang: ruNl }));
check('a sentence key: a hint naming the missing word ("ben") is dropped', t.r?.formMiss === true && !t.r?.hint, JSON.stringify(t.r));
replies.checker.push(reply({ correct: false, form_error: true, hint: 'Kijk naar het hulpwerkwoord bij een beweging naar huis.', explanation: 'x' }));
t = await asked(() => checkAnswerWithAI(PERFECT_Q, 'Ik ben naar huis gelopen.', 'Ik heb naar huis gelopen.', { testsForm: true, lang: ruNl }));
check('...a hint naming only words they already wrote ("huis") is kept',
    t.r?.formMiss === true && t.r?.hint === 'Kijk naar het hulpwerkwoord bij een beweging naar huis.', JSON.stringify(t.r));
replies.checker.push(reply({ correct: false, form_error: 'True', hint: 'Kijk naar het hulpwerkwoord.', explanation: 'x' }));
t = await asked(() => checkAnswerWithAI(PERFECT_Q, 'Ik ben naar huis gelopen.', 'Ik heb naar huis gelopen.', { testsForm: true, lang: ruNl }));
check('..."form_error": "True" (a string, any case) is read as a form miss', t.r?.formMiss === true, JSON.stringify(t.r));

// Chinese and Japanese put no space between words: the guard cannot lean on them.
const ZH = withLearning(getLanguage('en'), getLanguage('zh'));
const ZH_Q = '用"了"把句子改成完成：我去学校。';
const zhHint = async (hint, answer = '我去学校。') => {
    replies.checker.push(reply({ correct: false, form_error: true, hint, explanation: 'x' }));
    const r = await asked(() => checkAnswerWithAI(ZH_Q, '我去学校了。', answer, { testsForm: true, lang: ZH }));
    replies.checker.length = 0;
    return r.r;
};
let zr = await zhHint('请把「了」放在句末，写成我去学校了');
check('Chinese: a hint that writes the key inside its own sentence is dropped', zr?.formMiss === true && !zr?.hint, JSON.stringify(zr));
zr = await zhHint('顺序不对，应该是我去学校了', '了我去学校。');
check('...and so is one that writes it when the answer has every character, in the wrong order', zr?.formMiss === true && !zr?.hint, JSON.stringify(zr));
zr = await zhHint('句末少了一个字：了');
check('...a hint naming the one missing character is dropped', zr?.formMiss === true && !zr?.hint, JSON.stringify(zr));
zr = await zhHint('注意句末的语气助词。');
check('...a hint that only points at the sentence end is kept', zr?.formMiss === true && zr?.hint === '注意句末的语气助词。', JSON.stringify(zr));

// The model down: the bare comparison a form task falls back on.
const down = async (answer) => {
    replies.checker.push('no verdict here');
    const r = await asked(() => checkAnswerWithAI(PERFECT_Q, 'Ik ben naar huis gelopen.', answer, { testsForm: true, lang: ruNl }));
    replies.checker.length = 0;
    return r.r;
};
let dr = await down('ik ben naar huis gelopen');
check('the model down, a form task: the key without its capital and full stop is right, unjudged',
    dr?.correct === true && dr?.graded === false, JSON.stringify(dr));
dr = await down('Ik heb naar huis gelopen.');
check('...and a wrong helper verb is still wrong', dr?.correct === false && dr?.graded === false, JSON.stringify(dr));

replies.checker.push(reply({ correct: false, form_error: false, hint: '', explanation: 'Fietsen is another verb.' }));
t = await asked(() => checkAnswerWithAI(VERB_Q, 'loopt', 'fietst', { testsForm: true, lang: ruNl }));
check('a form task answered with the wrong meaning: wrong, no form miss, no second try', t.r?.correct === false && !t.r?.formMiss);

replies.checker.push(reply({ correct: false, form_error: true, hint: 'Check the ending.', explanation: 'x' }));
t = await asked(() => checkAnswerWithAI('What gas do plants release in photosynthesis?', 'Oxygen, from split water.', 'Carbon dioxide'));
check('a content task never has a form miss, whatever the model says', t.r?.correct === false && !t.r?.formMiss && !t.r?.hint);

replies.checker.push(reply({ correct: true, form_error: true, hint: 'x', explanation: 'Right.' }));
t = await asked(() => checkAnswerWithAI(VERB_Q, 'loopt', 'Loopt', { testsForm: true, lang: ruNl }));
check('a right answer is never a form miss', t.r?.correct === true && !t.r?.formMiss);

replies.checker.push(reply({ correct: true, explanation: 'Oxygen it is; the spelling is oxygen.' }));
t = await asked(() => checkAnswerWithAI('What gas do plants release in photosynthesis?', 'oxygen', 'oxigen'));
check('a content answer with one typo reaches the model under the ignore-spelling rule, and is right',
    t.asked && IGNORE.test(t.prompt?.system || '') && t.r?.correct === true && !t.r?.formMiss);

// ---------------------------------------------------------------------------
section('3. the route');
const pid = db.prepare("INSERT INTO projects (name, content_language, learning_language) VALUES ('Nederlands A2', 'ru', 'nl')").run().lastInsertRowid;
const nodeId = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, 0)').run(pid, 'Werkwoorden: tegenwoordige tijd').lastInsertRowid;
const { createApp } = await import(B + 'app.js');
const appServer = createServer(createApp());
await new Promise(r => appServer.listen(0, '127.0.0.1', r));
const post = (body) => fetch(`http://127.0.0.1:${appServer.address().port}/api/ai/check-answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => { replies.checker.length = 0; return { status: r.status, body: await r.json().catch(() => null) }; });
const base = { question: VERB_Q, correctAnswer: 'loopt', userAnswer: 'lopen' };

replies.checker.push(reply({ correct: false, form_error: true, hint: 'Kijk naar het onderwerp.', explanation: 'x' }));
let r = await post({ ...base, testsForm: true, nodeId });
check('a form task through the route: the checker marks form, in Dutch, replying in Russian',
    r.status === 200 && /INCORRECT,? even when/i.test(lastChecker()?.system || '') && /Dutch \(Nederlands\)/.test(lastChecker()?.system || '')
    && /Reply in Russian/.test(lastChecker()?.system || ''), `status ${r.status}`);
check('...and the reply carries the form miss and the hint', r.body?.formMiss === true && r.body?.hint === 'Kijk naar het onderwerp.', JSON.stringify(r.body));
r = await post({ ...base, testsForm: 'true', nodeId });
check('a flag that is not the boolean true is no flag', r.status === 200 && IGNORE.test(lastChecker()?.system || ''));
r = await post({ ...base, nodeId });
check('a content task through the route: the prompt is the one it always was', r.status === 200 && lastChecker()?.system === plain.system);
r = await post({ ...base, testsForm: true, nodeId: 999999 });
check('a node that does not exist: graded as a form task with no language named', r.status === 200
    && /INCORRECT,? even when/i.test(lastChecker()?.system || '') && !/Dutch|Russian/.test(lastChecker()?.system || ''));
r = await post({ ...base, testsForm: true, nodeId: 'DROP TABLE' });
check('a node id that is not a number is ignored, not an error', r.status === 200 && !/Dutch/.test(lastChecker()?.system || ''));
appServer.close();

// ---------------------------------------------------------------------------
section('4. the writer and the reducers');
const rule = (type) => attempt(() => formats.formatAuthoring(type).rule);
check('fill_in: the authoring rule says when to set "tests_form": true', /"tests_form": true/.test(rule('fill_in') || ''));
check('short_answer: so does its rule', /"tests_form": true/.test(rule('short_answer') || ''));
check('multiple choice: its rule does not mention it (a picked option has no spelling to mark)', !/tests_form/.test(rule('multiple_choice') || ''));
const fillRaw = { question: 'Hij ___ (lopen) naar school.', type: 'fill_in', correct_answer: 'loopt', explanation: 'Hij + stam + t.' };
const shortRaw = { question: 'Zet in de voltooide tijd: "Ik loop naar huis."', type: 'short_answer', correct_answer: 'Ik ben naar huis gelopen.', explanation: 'Beweging naar een doel: zijn.' };
check('feed reducer: a typed gap keeps tests_form', normalizeFeedQuestion({ ...fillRaw, tests_form: true })?.tests_form === true);
check('...and an open answer keeps it', normalizeFeedQuestion({ ...shortRaw, tests_form: true })?.tests_form === true);
check('...a model that wrote "true" as a string still means it', normalizeFeedQuestion({ ...fillRaw, tests_form: 'true' })?.tests_form === true);
check('...false, "yes", 1 or nothing is no flag (the question itself kept)', ['false', false, 'yes', 1, undefined].every(v => {
    const q = normalizeFeedQuestion({ ...fillRaw, tests_form: v });
    return !!q && !('tests_form' in q);
}));
const mcRaw = { question: 'Welke vorm is goed?', type: 'multiple_choice', options: ['hij loopt', 'hij loop', 'hij lopen', 'hij loopte'], correct_answer: 'hij loopt', explanation: 'x', tests_form: true };
check('...a multiple-choice question drops it (graded by picking, nothing to mark)', !('tests_form' in (normalizeFeedQuestion(mcRaw) || { tests_form: 1 })));
check('...so does a numeric one', !('tests_form' in (normalizeFeedQuestion({ question: 'How many?', type: 'numeric', correct_answer: '4', explanation: 'x', tests_form: true }) || { tests_form: 1 })));
check('import door (stored: true): an author\'s flag travels', formats.normalizeQuestionFormat({ ...fillRaw, tests_form: true }, { stored: true })?.tests_form === true);
const qNode = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, 1)').run(pid, 'Werkwoorden: vormen', ).lastInsertRowid;
const quiz = attempt(() => finalizeQuiz(qNode, JSON.stringify([{ ...fillRaw, tests_form: true }]), false));
check('a saved quiz (finalizeQuiz) keeps it', quiz?.questions?.[0]?.tests_form === true, quiz?.threw);

// ---------------------------------------------------------------------------
section('5. the gate on the flag');
const vp = (q) => attempt(() => AI_PROMPTS.feed_question_verify('Werkwoorden', q));
const vFill = vp(fillRaw), vShort = vp(shortRaw), vMc = vp(mcRaw);
const FORM_ASK = /"form"/;
check('the verifier is asked whether a typed gap tests form', FORM_ASK.test(vFill.system || '') && /grammatical form or (the )?spelling/i.test(vFill.system || ''), vFill.threw);
check('...and whether an open answer does', FORM_ASK.test(vShort.system || '') && /grammatical form or (the )?spelling/i.test(vShort.system || ''));
check('...not a multiple-choice question', !FORM_ASK.test(vMc.system || ''));
const vFillFlag = vp({ ...fillRaw, tests_form: true }), vShortFlag = vp({ ...shortRaw, tests_form: true });
check('the verifier never sees the writer\'s claim (the same prompt with and without the flag)',
    vFill.system === vFillFlag.system && vFill.user === vFillFlag.user && vShort.system === vShortFlag.system && vShort.user === vShortFlag.user);
replies.verifier.push(reply({ verdict: 'ok', answer: 'loopt', reason: 'fine', eliminable: 0, form: true }));
let v = await verifyQuestion('Werkwoorden', fillRaw, { source: '' });
check('verifyQuestion reports the verifier\'s answer: form true', v?.form === true, JSON.stringify(v));
replies.verifier.push(reply({ verdict: 'ok', answer: 'loopt', reason: 'fine', eliminable: 0, form: false }));
v = await verifyQuestion('Werkwoorden', fillRaw, { source: '' });
check('...form false', v?.form === false);
replies.verifier.push(reply({ verdict: 'ok', answer: 'loopt', reason: 'fine', eliminable: 0 }));
v = await verifyQuestion('Werkwoorden', fillRaw, { source: '' });
check('...and no answer is no confirmation', v?.form !== true);

const settleFlag = (await import(B + 'questionTrust.js')).settleFormFlag;
const flagged = { ...fillRaw, tests_form: true };
check('settleFormFlag: kept when the verifier says form', settleFlag?.(flagged, { ok: true, available: true, form: true })?.tests_form === true);
check('...dropped when it says no, the question kept', (() => { const s = settleFlag?.(flagged, { ok: true, available: true, form: false }); return !!s && !('tests_form' in s) && s.correct_answer === 'loopt'; })());
check('...dropped when it does not say', (() => { const s = settleFlag?.(flagged, { ok: true, available: true }); return !!s && !('tests_form' in s); })());
check('...left as it is when no verdict came (still unchecked, and ignored while unchecked)', settleFlag?.(flagged, { ok: true, available: false })?.tests_form === true);
check('formTested: a flagged, checked question tests form', formats.formTested?.(flagged) === true);
check('...a flagged question still stamped unverified does not', formats.formTested?.({ ...flagged, unverified: { reason: 'x', tries: 0 } }) === false);
check('...an unflagged one does not', formats.formTested?.(fillRaw) === false);

// The mastery-check bank: two flagged gaps, the verifier agrees on one.
const bankNode = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, 2)').run(pid, 'Werkwoorden: bank').lastInsertRowid;
const A = { ...fillRaw, question: 'BANK-A: Hij ___ (lopen) naar school.', tests_form: true };
const Bq = { ...fillRaw, question: 'BANK-B: De hoofdstad van Nederland is ___.', correct_answer: 'Amsterdam', explanation: 'Grondwet.', tests_form: true };
const bank = finalizeQuiz(bankNode, JSON.stringify([A, Bq]), false);
// vetQuiz asks with two workers, in any order: the stub answers by the
// question it was asked (the request is recorded just before the reply).
const verdictFor = (asked) => /BANK-A/.test(asked) ? { verdict: 'ok', answer: 'loopt', reason: 'ok', eliminable: 0, form: true }
    : { verdict: 'ok', answer: 'Amsterdam', reason: 'ok', eliminable: 0, form: false };
const origShift = replies.verifier.shift.bind(replies.verifier);
replies.verifier.shift = () => reply(verdictFor(seen.verifier.at(-1)?.user || ''));
let vetted = null;
try { vetted = await vetQuiz(bankNode, bank); } catch (err) { console.log(`  (vetQuiz threw: ${err.message})`); }
replies.verifier.shift = origShift;
const storedBank = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(bank.id)?.questions || '[]');
const sA = storedBank.find(q => /BANK-A/.test(q.question));
const sB = storedBank.find(q => /BANK-B/.test(q.question));
check('mastery-check bank: the flag the verifier confirmed is kept', sA?.tests_form === true, JSON.stringify(sA));
check('...the one it did not is dropped, and that question is still in the bank', !!sB && !('tests_form' in sB), JSON.stringify(sB));
check('...vetQuiz hands back the settled questions', !!vetted && vetted.questions.some(q => /BANK-B/.test(q.question) && !('tests_form' in q)));

// The background re-check (feedGen `reverifyOne` = verifyQuestion, then
// questionTrust `applyVerdict`): stamped questions the verifier now answers.
// Driven through its two halves, since the burst only reaches it after
// steps (plans, lessons) this stub does not serve.
const { pendingVerifications, applyVerdict } = await import(B + 'questionTrust.js');
const recheckNode = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, 3)').run(pid, 'Werkwoorden: recheck').lastInsertRowid;
const at = new Date('2026-01-05T09:00:00Z');
const stamp = { reason: 'verifier returned nothing usable', tries: 1, at: at.toISOString(), next: new Date(at.getTime() + 15 * 60000).toISOString() };
db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(recheckNode, 'Bank', JSON.stringify([
    { ...fillRaw, question: 'RECHECK-NO: De hoofdstad is ___.', correct_answer: 'Amsterdam', tests_form: true, unverified: stamp },
    { ...fillRaw, question: 'RECHECK-YES: Hij ___ (lopen).', tests_form: true, unverified: stamp },
]));
const feedItem = db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'question', 2, ?, '{}', 'ready')")
    .run(recheckNode, JSON.stringify({ ...fillRaw, question: 'RECHECK-FEED: De hoofdstad is ___.', correct_answer: 'Amsterdam', tests_form: true, unverified: stamp })).lastInsertRowid;
replies.verifier.shift = () => {
    const u = seen.verifier.at(-1)?.user || '';
    return reply({ verdict: 'ok', answer: /RECHECK-YES/.test(u) ? 'loopt' : 'Amsterdam', reason: 'ok', eliminable: 0, form: /RECHECK-YES/.test(u) });
};
// The instant is pinned: an hour after the stamp, past its `next`.
const recheckAt = at.getTime() + 3.6e6;
for (const entry of pendingVerifications(recheckNode, { limit: 10, now: recheckAt }) || []) {
    const { unverified: _s, ...stored } = entry.question || {};
    applyVerdict(entry, await verifyQuestion('Werkwoorden', stored, { source: '' }), { now: recheckAt });
}
replies.verifier.shift = origShift;
const recheckBank = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE node_id = ?').get(recheckNode)?.questions || '[]');
const rNo = recheckBank.find(q => /RECHECK-NO/.test(q.question));
const rYes = recheckBank.find(q => /RECHECK-YES/.test(q.question));
const rFeed = JSON.parse(db.prepare('SELECT content FROM feed_items WHERE id = ?').get(feedItem)?.content || '{}');
check('background re-check, bank: confirmed, and a flag it did not confirm is dropped', !!rNo && !rNo.unverified && !('tests_form' in rNo), JSON.stringify(rNo));
check('...a flag it confirmed is kept', !!rYes && !rYes.unverified && rYes.tests_form === true, JSON.stringify(rYes));
check('background re-check, feed: confirmed, and the flag it did not confirm is dropped', !rFeed.unverified && !('tests_form' in rFeed) && /RECHECK-FEED/.test(rFeed.question || ''), JSON.stringify(rFeed));

// The placement probe: its open question may claim form, the verifier settles it.
const placementPrompt = (type) => attempt(() => AI_PROMPTS.placement_question('Werkwoorden', type, { lang: ruNl }));
check('placement: an open probe\'s writer is told when to set "tests_form"', /"tests_form": true/.test(placementPrompt('short_answer').system || ''));
check('...a multiple-choice probe\'s writer is not', !/tests_form/.test(placementPrompt('multiple_choice').system || ''));
const { authorProbeQuestion } = await import(B + 'placement.js');
const probeTarget = { node_id: qNode, seq: 0, title: 'Werkwoorden', phase_title: '' };
const probeQ = { question: 'Zet in de voltooide tijd: "Ik loop naar huis."', type: 'short_answer', correct_answer: 'Ik ben naar huis gelopen.', explanation: 'Beweging naar een doel: zijn.' };
const probe = async (claim, verifierSaysForm, index = 2) => {
    replies.probe.push(reply({ ...probeQ, ...(index % 3 === 2 ? {} : { type: 'multiple_choice', options: ['Ik ben naar huis gelopen.', 'Ik heb naar huis gelopen.', 'Ik ben naar huis geloopt.', 'Ik heb naar huis geloopt.'] }), tests_form: claim }));
    replies.verifier.push(reply({ verdict: 'ok', answer: probeQ.correct_answer, reason: 'ok', eliminable: 0, form: verifierSaysForm }));
    const r = await authorProbeQuestion(probeTarget, { lang: ruNl, index }).catch(e => ({ threw: e.message }));
    replies.probe.length = 0; replies.verifier.length = 0;
    return r;
};
let pq = await probe('true', true);
check('placement: an open probe that claims form, confirmed blind, keeps the flag', pq?.tests_form === true, JSON.stringify(pq).slice(0, 200));
pq = await probe(true, false);
check('...one the verifier did not confirm loses it, and the probe is kept', !!pq?.question && !('tests_form' in pq), JSON.stringify(pq).slice(0, 200));
pq = await probe(true, true, 0);
check('...a multiple-choice probe never carries it', !!pq?.question && !('tests_form' in pq), JSON.stringify(pq).slice(0, 200));

// Answering a stored probe: the checker is told the task tests form, in Dutch.
const { answerProbeQuestion } = await import(B + 'placement.js');
const probeRowId = db.prepare("INSERT INTO placement_probes (project_id, state, targets, questions) VALUES (?, 'ready', ?, ?)")
    .run(pid, JSON.stringify([probeTarget]), JSON.stringify([{ ...probeQ, node_id: qNode, tests_form: true }])).lastInsertRowid;
replies.checker.push(reply({ correct: false, form_error: true, hint: 'Kijk naar het hulpwerkwoord.', explanation: 'x' }));
const seenBefore = seen.checker.length;
const pa = await answerProbeQuestion(probeRowId, 0, 'Ik heb naar huis gelopen.').catch(e => ({ threw: e.message }));
replies.checker.length = 0;
check('placement: a probe answer that tests form is marked on it, in Dutch, and is wrong',
    pa?.correct === false && seen.checker.length === seenBefore + 1 && /in Dutch \(Nederlands\)/.test(seen.checker.at(-1)?.system || ''),
    JSON.stringify(pa).slice(0, 200));

// Every caller that stores a question it verified settles the flag: read in
// the source, so a new caller cannot forget.
const files = [];
const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (!['vault', 'logs', 'browser-profile', 'node_modules'].includes(name)) walk(p, `${prefix}${name}/`);
        } else if (name.endsWith('.js')) files.push([`${prefix}${name}`, p]);
    }
};
walk(serverDir);
// paper.js audits a paper exercise's reference, which is never a typed task.
const AUDIT_ONLY = new Set(['paper.js', 'feedQuality.js']);
let callers = 0;
for (const [rel, p] of files) {
    const text = readFileSync(p, 'utf8');
    if (!/\bverifyQuestion\(/.test(text.replace(/^\s*(\/\/|\*).*$/gm, '')) || AUDIT_ONLY.has(rel)) continue;
    callers++;
    check(`${rel} verifies questions and settles their form flag`, /\bsettleFormFlag\(/.test(text.replace(/^\s*(\/\/|\*).*$/gm, '')));
}
check('the scan found the callers (vetQuiz, the feed, placement)', callers >= 3, String(callers));
const trust = readFileSync(join(serverDir, 'questionTrust.js'), 'utf8');
check('questionTrust.js (the background re-check\'s writer) settles it on both of its confirms', (trust.match(/markConfirmed\(settleFormFlag\(/g) || []).length === 2);

// ---------------------------------------------------------------------------
section('6. a typed gap that tests form forgives no slip');
const gap = { type: 'fill_in', question: 'Ik heb gisteren ___ (werken).', correct_answer: 'gewerkt', explanation: 'x' };
const slip = 'gewerrkt';
check('server: a content gap forgives the slip when the learner asked for that', formats.gradeLocally(gap, slip, { forgiveSpelling: true }) === true);
check('server: a form gap does not', formats.gradeLocally({ ...gap, tests_form: true }, slip, { forgiveSpelling: true }) === false);
check('server: ...and names no slip to show', formats.spellingSlipOf({ ...gap, tests_form: true }, slip) === null);
check('server: ...while a form gap still unchecked forgives it like any other', formats.gradeLocally({ ...gap, tests_form: true, unverified: { reason: 'x', tries: 0 } }, slip, { forgiveSpelling: true }) === true);

// ---------------------------------------------------------------------------
section('7. the client');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'MutationObserver', 'File', 'SVGSVGElement', 'HTMLCanvasElement', 'HTMLTextAreaElement', 'HTMLInputElement']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
class Observer { observe() { } unobserve() { } disconnect() { } }
globalThis.ResizeObserver = window.ResizeObserver = Observer;
globalThis.IntersectionObserver = window.IntersectionObserver = Observer;
window.matchMedia = (q) => ({ matches: q === '(pointer: fine)', media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
window.HTMLElement.prototype.scrollIntoView = function () { };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const consoleError = console.error;
console.error = (...a) => { if (!/not wrapped in act/.test(String(a[0]))) consoleError(...a); };

const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const bundleDir = mkdtempSync(join(cacheDir, 'form-grading-gates-'));
const out = join(bundleDir, 'bundle.cjs');
const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });
        export const initReactI18next = { type: '3rdParty', init() { } };`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: {
            addToast() { }, theme: 'light', searchProviders: [], projects: [], currentProjectId: null, forgiveSpelling: true, codeRunner: false,
            a11y: { readAloud: false, confirmAnswers: false, cardAudioAutoplay: true, readingLine: false, speechRate: 100 },
        }, subs: new Set() };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;
        useStore.setState = (p) => { g.__st.state = { ...g.__st.state, ...(typeof p === 'function' ? p(g.__st.state) : p) }; g.__st.subs.forEach(f => f()); };
        useStore.subscribe = (f) => { g.__st.subs.add(f); return () => g.__st.subs.delete(f); };
        export const themeKeyOf = () => 'light';
        export const isDarkTheme = () => false;`,
    'Markdown': `import { createElement } from 'react'; export default function Markdown({ content }) { return createElement('div', null, content); }`,
    'MathText': `import { createElement } from 'react'; export default function MathText({ content }) { return createElement('span', null, content); }`,
    'codeLanguages': `import { createElement } from 'react'; export const highlightLanguage = (l) => l; export default function SyntaxHighlighter({ children }) { return createElement('pre', null, children); }`,
    'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => (globalThis.__api?.[name] ?? (() => new Promise(() => { })))(...args) });
        let seq = 0; export const newAttemptId = () => 'attempt-' + (++seq);`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*Markdown$/ }, () => ({ path: 'Markdown', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*MathText$/ }, () => ({ path: 'MathText', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*codeLanguages$/ }, () => ({ path: 'codeLanguages', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
    },
};
let mod = {};
try {
    await esbuild.build({
        stdin: {
            contents: `
                export * as F from './src/components/answer/formats';
                export { gradeAnswer } from './src/utils/grading';
                export { default as InlineQuestion } from './src/components/feed/InlineQuestion';
                export { default as QuestionCard } from './src/components/feed/QuestionCard';`,
            resolveDir: root,
            loader: 'tsx',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: out,
        jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
        packages: 'external',
        define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
        plugins: [stubPlugin],
        logLevel: 'silent',
    });
    mod = require(out);
} catch (e) {
    check('the client bundles', false, String(e?.errors?.[0]?.text || e?.message || e).slice(0, 300));
}
const { F = {}, gradeAnswer, InlineQuestion, QuestionCard } = mod;

check('client mirror: spellingSlipOf names none for a form gap',F.spellingSlipOf?.({ ...gap, tests_form: true }, slip) === null);
check('client mirror: ...and still names one for a content gap', F.spellingSlipOf?.(gap, slip) === 'gewerkt');
check('client mirror: formTested agrees with the server', typeof F.formTested === 'function'
    && F.formTested(flagged) === true && F.formTested({ ...flagged, unverified: { tries: 0 } }) === false && F.formTested(fillRaw) === false);
check('hint: a form gap never promises a forgiven slip', !!F.answerHint && F.answerHint({ ...gap, tests_form: true }, true) === 'Spelling counts; capitals and punctuation do not');
check('hint: a form open answer says grammar and spelling count', F.answerHint?.({ ...shortRaw, tests_form: true }, false) === 'Judged on meaning, grammar and spelling');
check('hint: a content open answer is unchanged', F.answerHint?.(shortRaw, false) === 'Evaluated for meaning, not exact wording');

// gradeAnswer: what it sends, what it hands back.
const sent = [];
globalThis.__api = { checkAnswer: async (...a) => { sent.push(a); return { correct: false, formMiss: true, hint: 'Kijk naar het onderwerp.', explanation: 'Hij loopt.' }; } };
let g = gradeAnswer ? await gradeAnswer({ ...shortRaw, tests_form: true }, 'Ik heb naar huis gelopen.', { nodeId: 42 }) : null;
check('gradeAnswer: a form task sends the flag and the topic', sent.at(-1)?.[3]?.testsForm === true && sent.at(-1)?.[3]?.nodeId === 42, JSON.stringify(sent.at(-1)?.[3]));
check('...and hands back the form miss and its hint', g?.formMiss === true && g?.hint === 'Kijk naar het onderwerp.' && g?.correct === false, JSON.stringify(g));
g = gradeAnswer ? await gradeAnswer(shortRaw, 'Ik heb naar huis gelopen.', { nodeId: 42 }) : null;
check('...a content task sends neither, and has no form miss even if the reply says so', !('testsForm' in (sent.at(-1)?.[3] || {})) && !('nodeId' in (sent.at(-1)?.[3] || {})) && !g?.formMiss, JSON.stringify(sent.at(-1)?.[3]));
g = gradeAnswer ? await gradeAnswer({ ...shortRaw, tests_form: true, unverified: { tries: 0 } }, 'x', { nodeId: 42 }) : null;
check('...a form task still unchecked is graded as content', !('testsForm' in (sent.at(-1)?.[3] || {})) && !g?.formMiss);
const calls = sent.length;
g = gradeAnswer ? await gradeAnswer({ ...gap, tests_form: true }, 'gewerkd') : null;
check('...a typed gap that tests form, missed: a local form miss, no model call', g?.correct === false && g?.formMiss === true && g?.gradedBy === 'local' && sent.length === calls, JSON.stringify(g));
g = gradeAnswer ? await gradeAnswer(gap, 'gewerkd') : null;
check('...a content gap missed: no form miss', g?.correct === false && !g?.formMiss);

// The feed question: one more try after a form miss.
const { createElement: h } = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const settle = async (ms = 30) => { await act(async () => { await new Promise(res => setTimeout(res, ms)); }); };
const mount = async (el) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const rootEl = createRoot(host);
    await act(async () => { rootEl.render(el); });
    return { host, rerender: async (e) => { await act(async () => { rootEl.render(e); }); }, unmount: async () => { await act(async () => rootEl.unmount()); host.remove(); } };
};
const text = (host) => host.textContent || '';
const button = (host, label) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === label);
const field = (host) => host.querySelector('textarea, input[type="text"], input:not([type])');
const typeInto = async (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    await act(async () => { el.dispatchEvent(new window.Event('input', { bubbles: true })); });
};

const KEY = 'Ik ben naar huis gelopen.';
const formQ = { ...shortRaw, tests_form: true };
const EXPLAIN = 'With movement towards a goal, Dutch uses "zijn": ik ben gelopen.';
const HINT = 'Look at the helping verb: movement towards a goal.';
if (InlineQuestion) {
    const { useState } = require('react');
    // The card around it, as QuestionCard is: it holds the recorded verdict
    // and hands it back down. Every verdict handed up is counted.
    const handedUp = [];
    const Card = ({ initial = null, question = formQ }) => {
        const [g, setG] = useState(initial);
        return h(InlineQuestion, { question, graded: g, onGraded: (r) => { handedUp.push(r); setG(r); }, nodeId: 42 });
    };
    const FIRST = 'Ik heb naar huis gelopen.';
    const firstMiss = async (...a) => { sent.push(a); return { correct: false, formMiss: true, hint: HINT, explanation: EXPLAIN }; };
    // Answer the question the way a learner does: type, then Check answer.
    // Whether the key was ever on screen on the way is watched, not sampled.
    const answerFirst = async (m) => {
        let keyShown = false;
        const watch = new window.MutationObserver(() => { if (text(m.host).includes(KEY)) keyShown = true; });
        watch.observe(m.host, { subtree: true, childList: true, characterData: true });
        await typeInto(field(m.host), FIRST);
        await act(async () => button(m.host, 'Check answer')?.click());
        await settle();
        watch.disconnect();
        return keyShown;
    };

    globalThis.__api = { checkAnswer: firstMiss };
    handedUp.length = 0;
    // jsdom leaves the caret after a value set in code, so a field that never
    // placed it would pass. Focus here puts it at the start, as a browser may.
    const protos = [window.HTMLTextAreaElement.prototype, window.HTMLInputElement.prototype];
    const realFocus = protos.map(p => p.focus);
    protos.forEach((p, i) => { p.focus = function (o) { realFocus[i].call(this, o); try { this.setSelectionRange(0, 0); } catch { /* not a text field */ } }; });
    const m = await mount(h(Card));
    const flashed = await answerFirst(m);
    check('a form miss: "Not quite" and the hint', text(m.host).includes('Not quite') && text(m.host).includes(HINT), text(m.host).slice(0, 300));
    check('...the key and the explanation stay hidden for the try, never shown even for a frame',
        !flashed && !text(m.host).includes(KEY) && !text(m.host).includes(EXPLAIN), text(m.host).slice(0, 400));
    check('...the first answer is the one handed up to be recorded', handedUp.length === 1 && handedUp[0].answer === FIRST && handedUp[0].correct === false);
    const box = field(m.host);
    check('...the answer is open again, holding what they wrote', !!box && !box.disabled && !box.readOnly && box.value === FIRST, box ? `disabled=${box.disabled} value=${box.value}` : 'no field');
    check('...with "Show the answer" and "Check again", the primary last', (() => {
        const labels = [...m.host.querySelectorAll('button')].map(b => b.textContent.trim()).filter(l => l === 'Check again' || l === 'Show the answer');
        return labels.join('|') === 'Show the answer|Check again';
    })());
    check('...and the input has focus, so they can fix it at once', !!box && document.activeElement === box, document.activeElement?.outerHTML?.slice(0, 80));
    check('...with the caret after what they wrote', !!box && box.selectionStart === FIRST.length, String(box?.selectionStart));
    protos.forEach((p, i) => { p.focus = realFocus[i]; });
    check('...and no browser spellchecker underlining the slip being marked', !!box && box.getAttribute('spellcheck') === 'false');
    const sentBefore = sent.length;
    globalThis.__api = { checkAnswer: async (...a) => { sent.push(a); return { correct: true, explanation: 'Right: ik ben gelopen.' }; } };
    if (box) await typeInto(box, KEY);
    await act(async () => button(m.host, 'Check again')?.click());
    await settle();
    check('the second try is graded, as a form task on its topic', sent.length === sentBefore + 1 && sent.at(-1)?.[2] === KEY
        && sent.at(-1)?.[3]?.testsForm === true && sent.at(-1)?.[3]?.nodeId === 42, String(sent.length - sentBefore));
    check('..."Right this time", with its explanation', text(m.host).includes('Right this time') && text(m.host).includes('Right: ik ben gelopen.'), text(m.host).slice(0, 300));
    check('...and nothing more is handed up: the first answer stays the record', handedUp.length === 1);
    check('...no third try', !button(m.host, 'Check again') && !(field(m.host) && !field(m.host).disabled && !field(m.host).readOnly));
    await m.unmount();

    // Wrong again: the key and the explanation come out.
    globalThis.__api = { checkAnswer: firstMiss };
    const m2 = await mount(h(Card));
    await answerFirst(m2);
    globalThis.__api = { checkAnswer: async (...a) => { sent.push(a); return { correct: false, formMiss: true, hint: 'again', explanation: EXPLAIN }; } };
    await typeInto(field(m2.host), 'Ik heb naar huis geloopt.');
    await act(async () => button(m2.host, 'Check again')?.click());
    await settle();
    check('wrong on the second try: "Not quite", the key and the explanation, no third try',
        text(m2.host).includes('Not quite') && text(m2.host).includes(KEY) && text(m2.host).includes(EXPLAIN) && !button(m2.host, 'Check again'), text(m2.host).slice(0, 400));
    await m2.unmount();

    // The same answer sent again: the same verdict, no second call.
    globalThis.__api = { checkAnswer: firstMiss };
    const m2b = await mount(h(Card));
    await answerFirst(m2b);
    const before2b = sent.length;
    await act(async () => button(m2b.host, 'Check again')?.click());
    await settle();
    check('the same answer again: the key and the explanation, with no second call', sent.length === before2b
        && text(m2b.host).includes(KEY) && text(m2b.host).includes(EXPLAIN) && !button(m2b.host, 'Check again'));
    await m2b.unmount();

    // "Show the answer" instead of a try.
    globalThis.__api = { checkAnswer: firstMiss };
    const m3 = await mount(h(Card));
    await answerFirst(m3);
    await act(async () => button(m3.host, 'Show the answer')?.click());
    await settle();
    check('"Show the answer": the key and the explanation, their first answer closed again',
        text(m3.host).includes(KEY) && text(m3.host).includes(EXPLAIN) && !button(m3.host, 'Check again')
        && field(m3.host)?.value === FIRST && (field(m3.host)?.disabled || field(m3.host)?.readOnly), text(m3.host).slice(0, 400));
    await m3.unmount();

    // A miss on meaning: the key and the explanation at once.
    globalThis.__api = { checkAnswer: async (...a) => { sent.push(a); return { correct: false, explanation: EXPLAIN }; } };
    const m4 = await mount(h(Card));
    await answerFirst(m4);
    check('a miss that is not on form: the key and the explanation at once, no second try',
        text(m4.host).includes(KEY) && text(m4.host).includes(EXPLAIN) && !button(m4.host, 'Check again'));
    await m4.unmount();

    // A content task, whatever the reply says: no second try.
    globalThis.__api = { checkAnswer: firstMiss };
    const m4b = await mount(h(Card, { question: shortRaw }));
    await answerFirst(m4b);
    check('a content task: no second try, the key at once', text(m4b.host).includes(KEY) && !button(m4b.host, 'Check again'));
    await m4b.unmount();

    // A typed gap that tests form: a local miss gets the try and the generic hint.
    const gapQ = { ...gap, tests_form: true };
    const m4c = await mount(h(Card, { question: gapQ }));
    const before4c = sent.length;
    await typeInto(field(m4c.host), 'gewerkd');
    await act(async () => button(m4c.host, 'Check answer')?.click());
    await settle();
    check('a typed gap that tests form, missed: one more try with the general hint, no model call',
        sent.length === before4c && !!button(m4c.host, 'Check again') && text(m4c.host).includes('Look again at the form and spelling of each word.')
        && !text(m4c.host).includes('gewerkt'), text(m4c.host).slice(0, 300));
    await m4c.unmount();

    // A verdict the card mounts with (a reload, a card scrolled back).
    const m5 = await mount(h(Card, { initial: { correct: false, answer: FIRST, gradedBy: 'ai', explanation: EXPLAIN, formMiss: true, hint: HINT } }));
    await settle();
    check('a form miss the card mounts with: the full verdict, no second try',
        text(m5.host).includes(KEY) && !button(m5.host, 'Check again'), text(m5.host).slice(0, 300));
    await m5.unmount();

    // The real feed card (QuestionCard), not a stand-in: what it SAVES.
    if (QuestionCard) {
        const saved = [];
        globalThis.__st.state = {
            ...globalThis.__st.state,
            consumeFeedCard: async (key, payload) => { saved.push({ key, ...payload }); return true; },
            openProjectNode() { }, repairFeedVisual() { }, itemReports: {},
        };
        globalThis.__api = { checkAnswer: firstMiss };
        const card = { key: 'q-7', kind: 'question', feedItemId: 7, source: 'generated', nodeId: 42, projectId: 1, projectName: 'Dutch', projectColor: '#F97316', nodeTitle: 'Perfectum', question: formQ };
        const mq = await mount(h(QuestionCard, { card, done: false, onDone() { } }));
        await answerFirst(mq);
        check('QuestionCard: a form miss saves the first answer once, as wrong', saved.length === 1 && saved[0].result?.answer === FIRST && saved[0].result?.correct === false, JSON.stringify(saved));
        globalThis.__api = { checkAnswer: async () => ({ correct: true, explanation: 'Right: ik ben gelopen.' }) };
        const qBox = field(mq.host);
        if (qBox) await typeInto(qBox, KEY);
        await act(async () => button(mq.host, 'Check again')?.click());
        await settle();
        check('...the right second try shows "Right this time" and saves nothing more', saved.length === 1 && text(mq.host).includes('Right this time'), `${saved.length} ${text(mq.host).slice(0, 200)}`);
        await mq.unmount();
    } else check('the real feed card (QuestionCard) bundles', false);
} else check('the feed question mounts', false);


stub.close();
rmSync(bundleDir, { recursive: true, force: true });
try { db.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may still hold the WAL */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
