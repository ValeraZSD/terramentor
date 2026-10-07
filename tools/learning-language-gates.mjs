#!/usr/bin/env node
// tools/learning-language-gates.mjs — a course that teaches a LANGUAGE, explained
// in another one.
//
// Run:  node tools/learning-language-gates.mjs
//
// A course had one language, and every lesson, question and card was written
// in it ("Write EVERY word in X … including worked examples"). So a Dutch
// course explained in Russian would translate the Dutch it was teaching, a
// Japanese course explained in English had its kana flagged as leakage, and an
// English course explained in Russian was rejected as "drifted into English".
//
// The design (2026-10-06): no second field anywhere. The language being learned
// is DERIVED and kept on the project (`projects.learning_language`):
//   1. a language the name or goal says is being learned ("Learn Dutch",
//      "Nederlands A2", "Japanese N3", "I want to learn Dutch to hold a
//      conversation"), decided by a fixed rule, no model;
//   2. failing that, files in a language other than the one the lessons are
//      written in (or a language the name mentions without saying it is being
//      learned), CONFIRMED by one field in the existing project_identity call,
//      so a Dutch physics book stays a physics course.
// Explanations stay in the course language; the learned language's words,
// sentences and script stay as they are.
//
// Deterministic: the REAL routes on a scratch library and a stub model on
// loopback — nothing billed, nothing leaves the machine.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'learning-language-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the stub model -------------------------------------------------------------
// One server for creation and the feed. The identity step answers
// `teaches_language` from what it was shown: the Dutch textbook's headings say
// it teaches Dutch, the physics book's do not.
const calls = [];
let identityMode = 'judge';
const stageOf = (system) =>
    system.includes('review the name and description') ? 'identity'
    : system.includes('Write out your thoughts') ? 'thinking'
    : system.includes('Summarize this learning project') ? 'summary'
    : system.includes('top-level categories') ? 'categories'
    : system.includes('Create sub-topics (elements)') ? 'elements'
    : system.includes('for EVERY topic') ? 'sub_batch'
    : system.includes('detailed sub-elements (leaf nodes)') ? 'sub_one'
    : system.includes('curriculum designer') ? 'outline'
    : system.includes('writing ONE segment') ? 'lesson'
    : system.includes('You write ONE question that checks') ? 'question'
    : system.includes('checking a question before it is shown') ? 'verify'
    : 'other';

// What the lesson writer returns, per course: an English explanation with
// Japanese examples, or a Russian explanation with English examples.
const LESSONS = {
    ja: 'The particle は marks the topic of a sentence: what the sentence is about. In 私は学生です (I am a student), 私 is the topic and は follows it directly. '
        + 'Compare が, which marks the grammatical subject when it carries new information: 猫が来ました (a cat came) introduces the cat for the first time. '
        + 'A useful test is to ask whether the listener already knows the thing: known things take は, new things take が. '
        + 'So 田中さんは先生です describes someone already under discussion, while 誰が先生ですか asks who, out of everyone, is the teacher.',
    en: 'В английском языке вспомогательный глагол do нужен для вопросов в Present Simple. Сравните: You like coffee — Do you like coffee? '
        + 'Глагол do ставится перед подлежащим, а основной глагол остаётся в начальной форме. С третьим лицом используется does: '
        + 'She likes tea — Does she like tea? Обратите внимание, что окончание -s переходит с основного глагола на does. '
        + 'Ещё примеры: They work here — Do they work here? He works from home — Does he work from home? '
        + 'Where do you live? What does he want? When do they start? Why does she always say that? '
        + 'В отрицании схема та же: I do not like this, she does not know the answer, they do not have time for that.',
    nl: 'В нидерландском у существительного один из двух артиклей: de или het. Слово de fiets (велосипед) — с de, а het huis (дом) — с het. '
        + 'Во множественном числе артикль всегда de: de huizen (дома), de fietsen (велосипеды). Уменьшительные слова на -je всегда с het: '
        + 'het huisje (домик), het fietsje (велосипедик). Поэтому новое слово лучше сразу учить вместе с артиклем, как одно целое.',
};
// A course that teaches no language gets the Japanese text: the control for
// the kana check.
const lessonFor = (system) =>
    system.includes('teaches English') ? LESSONS.en
    : system.includes('teaches Dutch') ? LESSONS.nl
    : LESSONS.ja;
const QUESTION = {
    question: 'Which particle marks the topic in 私は学生です?',
    type: 'multiple_choice',
    options: ['は', 'が', 'を', 'に'],
    correct_answer: 'は',
    explanation: 'は follows the topic, here 私.',
};

// The explanation language the stub picks when asked: the first code the
// prompt offers (the learner's strongest signal), unless the learner's goal
// says the class is held in the files' language.
const offeredCodes = (system) => {
    const line = system.split('\n').find(l => l.includes('"explain_in":') && l.includes('codes:')) || '';
    const list = line.slice(line.indexOf('codes:')).split('. ')[0];
    return [...list.matchAll(/\b([a-z]{2}) \(/g)].map(m => m[1]);
};
function answer(stage, system, user) {
    if (stage === 'identity') {
        if (identityMode === 'garbage') return 'What a lovely course!';
        const keep = { keep_name: true, name: '', keep_description: true, description: '', reason: 'both are good' };
        const asksTeaches = system.includes('"teaches_language"');
        const asksExplain = system.includes('"explain_in"');
        if (!asksTeaches && !asksExplain) return JSON.stringify(keep);
        if (identityMode === 'omit') return JSON.stringify(keep);
        const out = { ...keep };
        if (asksTeaches) out.teaches_language = user.includes('Woordenschat') || user.includes('Kennismaken') ? 'nl' : '';
        if (asksExplain) {
            const offered = offeredCodes(system);
            out.explain_in = /class is in Dutch|examen in het Nederlands/i.test(user) && offered.includes('nl') ? 'nl' : offered[0] || '';
        }
        return JSON.stringify(out);
    }
    if (stage === 'thinking') return 'Plan: first things first.';
    if (stage === 'summary') return 'A short course.';
    if (stage === 'categories') return JSON.stringify({ categories: [{ title: 'Phase 1: Basics', description: 'First things' }] });
    if (stage === 'elements') return JSON.stringify({ elements: [{ title: 'Getting started', description: 'Start here' }] });
    if (stage === 'sub_batch') return JSON.stringify({ topics: [{ element: 'Getting started', subElements: [{ title: 'One leaf', description: 'One' }] }] });
    if (stage === 'sub_one') return JSON.stringify({ subElements: [{ title: 'One leaf', description: 'One' }] });
    if (stage === 'outline') return JSON.stringify({ parts: [{ title: 'The idea', focus: 'The one idea of this topic' }] });
    if (stage === 'lesson') return lessonFor(system);
    if (stage === 'question') return JSON.stringify(QUESTION);
    if (stage === 'verify') return JSON.stringify({ verdict: 'ok', answer: QUESTION.correct_answer, reason: 'agrees', eliminable: 0 });
    return JSON.stringify({ verdict: 'ok', reason: 'fine' });
}

const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        const body = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
        const msgs = body.messages || [];
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
        const stage = stageOf(system);
        calls.push({ stage, system, user });
        const content = answer(stage, system, user);
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
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

const { default: db } = await import('../server/database.js');
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
setSetting('ai_enabled', 'true');
setSetting('creation_find_resources', 'false');
setSetting('embedding_enabled', 'false');
setSetting('pdf_math_recovery', 'off');
setSetting('ui_language', 'en');

const L = await import('../server/learningLanguage.js');
const P = await import('../server/projectIdentity.js');
const lang = await import('../server/language.js');
const { lessonDefects } = await import('../server/feedQuality.js');
const { AI_PROMPTS, buildNodeContext } = await import('../server/ai.js');
const { generateForNode } = await import('../server/feedGen.js');
const { createApp } = await import('../server/app.js');
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const { getLanguage } = lang;
const [en, ru, nl, ja] = ['en', 'ru', 'nl', 'ja'].map(getLanguage);

/* ── 1. the rule: a language the name or goal says is being learned ─────── */
console.log('\n--- 1. a language the name or goal names as being learned ---');
const named = (name, description = '') => L.findLearningLanguage({ name, description }).named;
const mentions = (name, description = '') => L.findLearningLanguage({ name, description }).mentioned;
for (const [name, description, want] of [
    ['Learn Dutch', '', 'nl'],
    ['Nederlands A2', '', 'nl'],
    ['Japanese N3', '', 'ja'],
    ['', 'I want to learn Dutch to be able to hold a conversation', 'nl'],
    ['Conversation', 'I want to learn Dutch to hold a conversation', 'nl'],
    ['Dutch', '', 'nl'],
    ['Английский для начинающих', '', 'en'],
    ['Английский язык', '', 'en'],
    ['', 'Хочу выучить нидерландский язык с нуля', 'nl'],
    ['Подготовка к ЕГЭ по английскому', '', 'en'],
    ['', 'Хочу научиться говорить на нидерландском', 'nl'],
    ['', 'Chcę nauczyć się mówić po niderlandzku', 'nl'],
    ['日本語を勉強したい', '', 'ja'],
    ['Вивчити англійську', '', 'en'],
    ['Deutsch lernen', '', 'de'],
    ['', 'Ik wil Nederlands leren voor mijn inburgering', 'nl'],
    ['Apprendre le néerlandais', '', 'nl'],
    ['Aprender inglés', '', 'en'],
    ['Język angielski B2', '', 'en'],
    ['日本語 N3', '', 'ja'],
    ['オランダ語の勉強', '', 'nl'],
    ['English IELTS preparation', '', 'en'],
    ['Improve my English', '', 'en'],
    ['Dutch for beginners', '', 'nl'],
    ['', 'Learn Japanese grammar and vocabulary for the JLPT', 'ja'],
    // An exam of one language names it, though the name says no language.
    ['IELTS Academic — Target Band 7.0+', '', 'en'],
    ['JLPT N3 kanji', '', 'ja'],
    ['HSK 4', '', 'zh'],
    ['DELF B2', '', 'fr'],
    ['Staatsexamen NT2 programma II', '', 'nl'],
    ['A Frequency Dictionary of Dutch', '', 'nl'],
    ['Dutch dictionary', '', 'nl'],
]) {
    check(`"${name || description}" -> ${want}`, named(name, description) === want, `got ${named(name, description)}`);
}
for (const [name, description] of [
    ['Dutch history', ''],
    ['Natuurkunde VWO', 'Examen natuurkunde in mei'],
    ['French Revolution', ''],
    ['Learn French cooking', ''],
    ['Japanese garden design', ''],
    ['', 'Learn about Japanese history before my trip'],
    ['Python', ''],
    ['Vitamin B1 and B2', ''],
    ['English literature', 'Shakespeare and the sonnets'],
    ['Organic chemistry', 'I speak Russian and want the lessons in it'],
    // Two languages named as being learned: the rule does not pick one.
    ['Learn Dutch and German', ''],
    // A language named as the MEDIUM of study, not its subject.
    ['', 'Хочу учиться на английском'],
    ['', 'Учиться по английскому учебнику'],
    ['', '日本語で物理を勉強したい'],
    ['', '用中文学习物理'],
    ['', '한국어로 물리를 공부하고 싶어요'],
    // An exam for every school subject, and a poet who is also an exam.
    ['ЕГЭ по математике', ''],
    ['Goethe: Faust and the Sturm und Drang', ''],
    ['Staatsexamen VWO wiskunde B', ''],
]) {
    check(`"${name || description}" is not a language course by the rule`, named(name, description) === null, `got ${named(name, description)}`);
}
check('a language merely mentioned is offered for confirmation', same(mentions('Dutch history'), ['nl']), JSON.stringify(mentions('Dutch history')));
check('...and "French cooking" too', mentions('Learn French cooking').includes('fr'));
check('two languages to learn: both offered, neither decided', same([...mentions('Learn Dutch and German')].sort(), ['de', 'nl']));
check('the named language is not also listed as a mention', !mentions('Learn Dutch').includes('nl'));
check('no language at all: nothing named, nothing mentioned', same(L.findLearningLanguage({ name: 'Calculus', description: 'Limits and derivatives' }), { named: null, mentioned: [] }));
check('empty and absent input are safe', same(L.findLearningLanguage({}), { named: null, mentioned: [] }) && same(L.findLearningLanguage(), { named: null, mentioned: [] }));

/* ── 2. which language the explanations are in, once one is being learned ─ */
console.log('\n--- 2. explanations are never in the language being learned, unless the learner reads it ---');
const R = P.resolveCreationLanguage;
const DUTCH_SAMPLE = 'De fiets staat voor het huis. Ik wil graag een kopje koffie met melk. Hoe gaat het met je? Het gaat goed, dank je wel. Waar woon je? Ik woon in Amsterdam, in een klein huis met een tuin.';
let r = R({ name: 'Learn Dutch', description: '', sourceSample: DUTCH_SAMPLE, uiLanguage: ru, learning: 'nl' });
check('"Learn Dutch" + a Dutch book + Russian interface: explained in Russian, not in the book\'s Dutch', r.code === 'ru' && r.source === 'interface', JSON.stringify({ code: r.code, source: r.source }));
r = R({ name: 'Learn Dutch', description: '', sourceSample: DUTCH_SAMPLE, uiLanguage: ru, learning: null });
check('...and without the rule too: the book says what is studied, not who reads it (it picked the book\'s Dutch before §9)', r.code === 'ru' && r.source === 'interface');
r = R({ name: 'Conversation', description: 'I want to learn English to hold a conversation', uiLanguage: ru, learning: 'en' });
check('a goal typed in English to learn English, Russian interface: Russian', r.code === 'ru' && r.source === 'interface', JSON.stringify({ code: r.code, source: r.source }));
r = R({ name: 'Conversation', description: 'I want to learn Dutch to hold a conversation', uiLanguage: ru, learning: 'nl' });
check('a goal typed in English to learn Dutch: English, the language they wrote', r.code === 'en' && r.source === 'written');
r = R({ name: 'Nederlands B2', description: '', sourceSample: DUTCH_SAMPLE, uiLanguage: nl, learning: 'nl' });
check('learning Dutch with a Dutch interface: Dutch (they read the app in it)', r.code === 'nl' && r.source === 'interface');
r = R({ name: 'Learn Dutch', description: '', uiLanguage: null, learning: 'nl' });
check('nothing else to go on: English', r.code === 'en' && r.source === 'default');
r = R({ explicit: 'nl', name: 'Learn Dutch', description: '', uiLanguage: ru, learning: 'nl' });
check('an explicit choice still beats everything', r.code === 'nl' && r.source === 'explicit');

// The New course dialog names what "Automatic" will pick by running the SAME
// order, given the files' language as a code (the server's own read of them).
const C = await import('../server/creationLanguage.js');
check('the server and the dialog run one function (projectIdentity re-exports it)', P.resolveCreationLanguage === C.resolveCreationLanguage && P.detectWrittenLanguage === C.detectWrittenLanguage);
r = R({ name: 'Learn Dutch', filesLanguage: 'nl', uiLanguage: ru, learning: 'nl' });
check('files given as a code: "Learn Dutch" + Dutch file + Russian interface -> Russian, as with the text', r.code === 'ru' && r.source === 'interface');
r = R({ name: 'les 11.2', filesLanguage: 'nl', uiLanguage: en });
check('...a Dutch file under an English app -> English (it was Dutch, from the files, before §9)', r.code === 'en' && r.source === 'interface');
r = R({ name: 'les 11.2', filesLanguage: 'nl' });
check('...and with nothing at all about the learner, the files\' language is the last resort', r.code === 'nl' && r.source === 'files');
check('the catalog lookup returns the same shared entries as language.js', C.catalogLanguage('nl') === nl && C.catalogLanguage('xx') === null);
const modal = (await import('node:fs')).readFileSync(new URL('../src/components/NewProjectModal.tsx', import.meta.url), 'utf8');
check('the dialog imports the resolution and the rule instead of keeping its own',
    /from '\.\.\/\.\.\/server\/creationLanguage\.js'/.test(modal) && /resolveCreationLanguage\(/.test(modal)
    && /from '\.\.\/\.\.\/server\/learningLanguage\.js'/.test(modal) && /automaticAs=\{automaticAs\}/.test(modal));

/* ── 3. the identity call carries the one question, only when there is one ─ */
console.log('\n--- 3. the confirmation rides on the existing identity call ---');
const plain = P.identityPrompt({ name: 'Physics', description: '', lang: en });
const asked = P.identityPrompt({ name: 'Physics', description: '', lang: ru, learningCandidates: [nl] });
check('no candidate: the prompt says nothing about teaching a language', !plain.system.includes('teaches_language'));
check('a candidate: the JSON shape asks for "teaches_language"', asked.system.includes('"teaches_language"'));
check('...naming the candidate and the reading language', asked.system.includes('nl (Dutch)') && asked.system.includes('Russian'));
check('...and that a subject merely written in it is not a language course', /physics/i.test(asked.system) && /written in/i.test(asked.system));
const parse = (raw, cands) => P.parseIdentityDecision(JSON.stringify(raw), { name: 'X', description: 'Some goal here', lang: ru, learningCandidates: cands })?.teachesLanguage;
const keep = { keep_name: true, name: '', keep_description: true, description: '' };
check('"nl" confirms the candidate', parse({ ...keep, teaches_language: 'nl' }, [nl]) === 'nl');
check('"NL" is the same answer', parse({ ...keep, teaches_language: 'NL' }, [nl]) === 'nl');
check('"" is "not a language course"', parse({ ...keep, teaches_language: '' }, [nl]) === null);
check('a language that was not a candidate is refused', parse({ ...keep, teaches_language: 'de' }, [nl]) === null);
check('true with exactly one candidate confirms it', parse({ ...keep, teaches_language: true }, [nl]) === 'nl');
check('true with two candidates decides nothing', parse({ ...keep, teaches_language: true }, [nl, ja]) === null);
check('an absent field decides nothing', parse(keep, [nl]) === null);
check('with no candidates the field is ignored', parse({ ...keep, teaches_language: 'nl' }, []) === null);
// A course that teaches Dutch may carry a Dutch title. A real model proposed
// "Voordat, nadat, daarvoor en daarna" three times for a Russian-explained
// course; each was refused for not being Russian, and the course took a file name.
const nameOf = (raw, opts) => P.parseIdentityDecision(JSON.stringify(raw), { name: '', description: 'Some goal here', ...opts })?.name;
const dutchTitle = { keep_name: false, name: 'Voordat, nadat, daarvoor en daarna', keep_description: true, description: '' };
check('a Dutch title is kept when the same answer confirms the course teaches Dutch',
    nameOf({ ...dutchTitle, teaches_language: 'nl' }, { lang: ru, learningCandidates: [nl] }) === 'Voordat, nadat, daarvoor en daarna');
check('...and when the rule already decided it (the course language carries Dutch)',
    nameOf(dutchTitle, { lang: lang.withLearning(ru, nl) }) === 'Voordat, nadat, daarvoor en daarna');
check('...but not for a course that teaches no Dutch (unchanged)',
    nameOf({ ...dutchTitle, teaches_language: '' }, { lang: ru, learningCandidates: [nl] }) === null);
let d = await P.decideProjectIdentity({ name: 'Boek', description: '', lang: ru, learningCandidates: [nl], generate: async () => JSON.stringify({ ...keep, teaches_language: 'nl' }) });
check('decideProjectIdentity reports the confirmed language', d.teachesLanguage === 'nl', JSON.stringify(d));
d = await P.decideProjectIdentity({ name: 'Boek', description: '', lang: ru, learningCandidates: [nl], generate: async () => { throw new Error('down'); } });
check('...and nothing when the call fails (the course stays as it would have been)', d.teachesLanguage === null);
d = await P.decideProjectIdentity({ name: 'Boek', description: '', lang: ru, generate: async () => JSON.stringify({ ...keep, teaches_language: 'nl' }) });
check('...and nothing when nothing was asked', d.teachesLanguage === null);

/* ── 4. what every authoring prompt is told ─────────────────────────────── */
console.log('\n--- 4. the directive keeps the learned language as it is ---');
const OLD_RU = 'Write EVERY word in Russian (Русский) — this project is studied in Russian, regardless of what language these instructions are written in. That includes headings, worked examples, labels inside visuals, and the explanation. Established technical terms and proper nouns keep their standard form in the field; everything else is Russian. Do not translate the topic title back into English, and never switch language part-way.';
const OLD_NONE = 'Write in the same language as the topic and its Overview, and stay in that language for every word — including inside visuals. A single word from another language is a defect.';
check('a course that teaches no language gets the directive it always got', lang.languageDirective(ru) === OLD_RU);
check('...and an unset one the old hint', lang.languageDirective(null) === OLD_NONE);
const ruNl = lang.withLearning(ru, nl);
const dir = lang.languageDirective(ruNl);
check('Dutch explained in Russian: the explanation is Russian', /explanation[^.]*in Russian/i.test(dir), dir);
check('...the Dutch being taught stays Dutch, never translated', /Dutch[^.]*stays in Dutch/i.test(dir) && /never translate/i.test(dir), dir);
check('...its meaning goes beside it', /beside it/i.test(dir));
check('...and it no longer says "EVERY word in Russian … worked examples"', !dir.includes('Write EVERY word'));
const jaDir = lang.languageDirective(lang.withLearning(en, ja));
check('Japanese explained in English: written in kana and kanji, not only romaji', /kana/.test(jaDir) && /kanji/.test(jaDir) && /Latin letters/.test(jaDir), jaDir);
check('withLearning of the same language is the language itself', lang.withLearning(nl, nl) === nl && !('learning' in nl));
check('withLearning never changes the shared catalog entry', !('learning' in ru) && lang.withLearning(ru, nl) !== ru);
check('the grader reply line is unchanged', lang.languageDirectiveForResponse(ruNl) === 'Reply in Russian (Русский).');
const outline = AI_PROMPTS.feed_outline('Артикли', 'Ctx', { lang: ruNl }).system;
check('the lesson planner keeps Dutch words in titles in Dutch', outline.includes('stays in Dutch'), outline.slice(-500));
const plainOutline = AI_PROMPTS.feed_outline('Артикли', 'Ctx', { lang: ru }).system;
check('...and a course without one is planned exactly as before', !plainOutline.includes('This course teaches') && plainOutline.endsWith('a plan in another language drags them back to it.'));
const cats = AI_PROMPTS.generate_categories('Нидерландский', 'Цель', 'notes', 'summary', { lang: ruNl }).system;
check('the creation prompts say a Dutch word in a title stays Dutch', cats.includes('teaches Dutch') && cats.includes('stays in Dutch'));
check('...and a course without one gets the old rule, byte for byte',
    AI_PROMPTS.generate_categories('Физика', 'Цель', 'notes', 'summary', { lang: ru }).system.endsWith('everything else is Russian.'));

/* ── 5. the stored half: the project, the context, the quality gates ────── */
console.log('\n--- 5. the project keeps it, and the gates read it ---');
const mkProject = (name, content, learning = '') => db.prepare('INSERT INTO projects (name, content_language, learning_language) VALUES (?, ?, ?)').run(name, content, learning).lastInsertRowid;
const mkNode = (pid, title, parent = null, position = 0) =>
    db.prepare('INSERT INTO nodes (project_id, parent_id, title, description, position) VALUES (?, ?, ?, ?, ?)').run(pid, parent, title, 'One idea.', position).lastInsertRowid;
const jaCourse = mkProject('Japanese N3', 'en', 'ja');
const jaLeaf = mkNode(jaCourse, 'Topic and subject particles');
const enOnly = mkProject('Grammar notes', 'en');
const enLeaf = mkNode(enOnly, 'Topic and subject particles');
const enInRu = mkProject('Английский', 'ru', 'en');
const enInRuLeaf = mkNode(enInRu, 'Вопросы с do');
const ruOnly = mkProject('Грамматика', 'ru');
const ruLeaf = mkNode(ruOnly, 'Вопросы с do');
const nlInRu = mkProject('Нидерландский', 'ru', 'nl');
const nlInRuLeaf = mkNode(nlInRu, 'Артикли');
const sameBoth = mkProject('Nederlands', 'nl', 'nl');
const bogus = mkProject('Bogus', 'ru', 'xx');

const pl = lang.getProjectLanguage(jaCourse);
check('getProjectLanguage carries the learned language', pl?.code === 'en' && pl?.learning?.code === 'ja');
check('a project that learns nothing has no `learning`', lang.getProjectLanguage(enOnly)?.learning === undefined);
check('learning the language it is explained in is no learning', lang.getProjectLanguage(sameBoth)?.learning === undefined);
check('an unknown stored code is ignored', lang.getProjectLanguage(bogus)?.learning === undefined && lang.getProjectLanguage(bogus)?.code === 'ru');
check('the topic context tells every surface (cards, tutor, quiz)', buildNodeContext(nlInRuLeaf).includes('teaches Dutch'), buildNodeContext(nlInRuLeaf).slice(0, 400));
check('...and a plain course reads as it always did', buildNodeContext(ruLeaf).includes('All material for it is written and studied in Russian.'));

const kanaFault = (faults) => faults.some(f => /Kana|Han/.test(f));
check('kana in a Japanese course explained in English is not leakage', !kanaFault(lessonDefects(LESSONS.ja, jaLeaf)), lessonDefects(LESSONS.ja, jaLeaf).join('; '));
check('...the same lesson in an English course that teaches no Japanese is (the check is alive)', kanaFault(lessonDefects(LESSONS.ja, enLeaf)));
const driftFault = (faults) => faults.some(f => /written in English/.test(f));
check('English examples in an English course explained in Russian are not drift', !driftFault(lessonDefects(LESSONS.en, enInRuLeaf)), lessonDefects(LESSONS.en, enInRuLeaf).join('; '));
check('...the same lesson in a Russian course that teaches no English is (the check is alive)', driftFault(lessonDefects(LESSONS.en, ruLeaf)), lessonDefects(LESSONS.en, ruLeaf).join('; '));
const allEnglish = 'The definite article in Dutch has two forms, and every noun takes one of them. There is no reliable rule that tells you which one a noun takes, so the article has to be learned together with the noun itself. '
    + 'When a noun is made plural, the article always becomes the same form, which is one of the few things that make this part of the grammar easier for a learner who is starting out with the language.';
check('a Dutch course explained in Russian that drifts into English is still caught', driftFault(lessonDefects(allEnglish, nlInRuLeaf)));

/* ── 6. a lesson written end to end ─────────────────────────────────────── */
console.log('\n--- 6. a lesson written through the real generator ---');
const runTopic = async (nodeId) => {
    const ac = new AbortController();
    calls.length = 0;
    try {
        await generateForNode(nodeId, { signal: ac.signal, onStep: (label) => { if (!['outline', 'lesson 1', 'question 1'].includes(label)) ac.abort(); } });
    } catch { /* the abort, by design */ }
    const row = db.prepare("SELECT content, meta FROM feed_items WHERE node_id = ? AND kind = 'lesson' AND seq = 1").get(nodeId);
    return { row, meta: row ? JSON.parse(row.meta || '{}') : null, lessonCalls: calls.filter(c => c.stage === 'lesson') };
};
let t = await runTopic(jaLeaf);
check('Japanese in English: the writer is told the course teaches Japanese', t.lessonCalls[0]?.system.includes('teaches Japanese'), t.lessonCalls[0]?.system.slice(0, 200));
check('...the lesson is kept on the first draft, kana and all', !!t.row && t.lessonCalls.length === 1 && !t.meta?.unresolvedFault && /私は学生です/.test(t.row.content),
    JSON.stringify({ calls: t.lessonCalls.length, fault: t.meta?.unresolvedFault }));
t = await runTopic(enLeaf);
check('...the same text in a course that teaches no Japanese is sent back for its kana (control)', t.lessonCalls.length > 1 && /Kana/.test(t.meta?.unresolvedFault?.reason || ''),
    JSON.stringify({ calls: t.lessonCalls.length, fault: t.meta?.unresolvedFault }));
t = await runTopic(enInRuLeaf);
check('English explained in Russian: kept on the first draft, not rejected as drift', !!t.row && t.lessonCalls.length === 1 && !t.meta?.unresolvedFault,
    JSON.stringify({ calls: t.lessonCalls.length, fault: t.meta?.unresolvedFault }));

/* ── 7. a course created end to end ─────────────────────────────────────── */
console.log('\n--- 7. creation: the pairs that matter ---');
async function create(payload, { acceptLanguage } = {}) {
    calls.length = 0;
    const res = await fetch(`${base}/api/ai/create-project`, {
        method: 'POST',
        // Without a header, undici sends "accept-language: *", which names no language.
        headers: { 'content-type': 'application/json', ...(acceptLanguage ? { 'accept-language': acceptLanguage } : {}) },
        body: JSON.stringify(payload),
    });
    const text = await res.text();
    const frames = text.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    const id = frames.find(f => f.phase === 'complete')?.projectId ?? frames.find(f => f.projectId)?.projectId;
    const row = id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(id) : null;
    return { row, frames, calls: calls.slice(), identity: calls.find(c => c.stage === 'identity') };
}
async function stage(name, text) {
    const form = new FormData();
    form.append('files', new Blob([Buffer.from(text, 'utf8')], { type: 'text/plain' }), name);
    const res = await fetch(`${base}/api/documents/staged`, { method: 'POST', body: form });
    const json = await res.json();
    return (json.documents || json.staged || []).map(d => d.id);
}
const DUTCH_TEXTBOOK = [
    'Hoofdstuk 1 Kennismaken',
    'Hallo, ik ben Anna. Hoe heet jij? Ik heet Pieter en ik woon in Utrecht. Waar kom je vandaan? Ik kom uit Polen, maar ik woon nu al twee jaar in Nederland.',
    'Woordenschat',
    'de fiets, het huis, de tafel, het boek, de stoel, het raam, de deur, het kopje, de straat, het station, de trein, het kind.',
    'Hoofdstuk 2 Boodschappen doen',
    'Ik wil graag een brood en een liter melk. Hoeveel kost dat? Dat is drie euro vijftig. Wilt u een tasje? Nee, dank u wel, ik heb er zelf een bij.',
].join('\n\n');
const DUTCH_PHYSICS = [
    'Hoofdstuk 1 Krachten',
    'Een kracht is een duw of een trek. De eenheid van kracht is de newton. Als er geen resulterende kracht op een voorwerp werkt, blijft het in rust of beweegt het met een constante snelheid.',
    'Hoofdstuk 2 Energie',
    'Energie kan niet verloren gaan, alleen worden omgezet. Een vallende bal zet zwaarte-energie om in bewegingsenergie, en bij het neerkomen wordt een deel daarvan warmte.',
].join('\n\n');

identityMode = 'judge';
let docs = await stage('nederlands-in-gang.txt', DUTCH_TEXTBOOK);
check('fixture: the Dutch textbook was staged', docs.length === 1, JSON.stringify(docs));
// A neutral name: "Нидерландский" alone would be decided by the rule, unasked.
let c = await create({ name: 'Учебник', description: '', content_language: 'ru', documentIds: docs });
check('a Dutch book + a Russian course: the identity call asks whether it teaches Dutch', !!c.identity && c.identity.system.includes('nl (Dutch)'), c.identity?.system.slice(-600));
const inside = (s) => { const a = s.indexOf('<<<SOURCES'), b = s.indexOf('SOURCES>>>'); return a >= 0 && b > a ? s.slice(a, b) : ''; };
check('...shown the book\'s own words, not only its name, inside the source boundary',
    inside(c.identity?.user || '').includes('Hoe heet jij') && (c.identity?.user || '').includes('REFERENCE MATERIAL'), (c.identity?.user || '').slice(0, 600));
check('...the course is explained in Russian and teaches Dutch', c.row?.content_language === 'ru' && c.row?.learning_language === 'nl', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));
check('...and its phases were planned knowing that', c.calls.some(x => x.stage === 'categories' && x.system.includes('teaches Dutch')));

docs = await stage('natuurkunde-vwo.txt', DUTCH_PHYSICS);
c = await create({ name: 'Natuurkunde', description: '', content_language: 'nl', documentIds: docs });
check('a Dutch physics book + a Dutch course: nothing to ask', !!c.identity && !c.identity.system.includes('teaches_language'));
check('...physics in Dutch, no language learned', c.row?.content_language === 'nl' && c.row?.learning_language === '', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));

docs = await stage('natuurkunde-vwo.txt', DUTCH_PHYSICS);
c = await create({ name: 'Физика', description: '', content_language: 'ru', documentIds: docs });
check('a Dutch physics book + a Russian course: asked, and the answer is no', !!c.identity?.system.includes('nl (Dutch)'));
check('...physics explained in Russian, no language learned', c.row?.content_language === 'ru' && c.row?.learning_language === '', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));

docs = await stage('nederlands-in-gang.txt', DUTCH_TEXTBOOK);
identityMode = 'garbage';
c = await create({ name: 'Учебник', description: '', content_language: 'ru', documentIds: docs });
check('a Dutch book + a Russian course with no usable identity answer: not guessed as a language course', c.row?.content_language === 'ru' && c.row?.learning_language === '', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));
identityMode = 'judge';

// A name is required without files; this one names no language.
c = await create({ name: 'Small talk', description: 'I want to learn Dutch to be able to hold a conversation', content_language: '' });
check('"I want to learn Dutch…" with no files: decided by the rule, nothing asked', !!c.identity && !c.identity.system.includes('teaches_language'));
check('...explained in English (the language the goal is written in), teaching Dutch', c.row?.content_language === 'en' && c.row?.learning_language === 'nl', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));

c = await create({ name: 'Japanese N3', description: '', content_language: '' });
check('"Japanese N3": explained in English, teaching Japanese', c.row?.content_language === 'en' && c.row?.learning_language === 'ja', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));

docs = await stage('nederlands-in-gang.txt', DUTCH_TEXTBOOK);
setSetting('ui_language', 'ru');
c = await create({ name: 'Learn Dutch', description: '', content_language: '', documentIds: docs });
check('"Learn Dutch" + a Dutch book on Automatic, Russian interface: explained in Russian, not the book\'s Dutch', c.row?.content_language === 'ru' && c.row?.learning_language === 'nl', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));
setSetting('ui_language', 'en');

// The dialog names "Automatic (X)" from each staged file's own `language`
// and the file with the most text; the creation must decide from the same
// read, or the label and the stored course disagree (CodeRabbit on #38).
async function stageMany(files) {
    const form = new FormData();
    for (const [name, text] of files) form.append('files', new Blob([Buffer.from(text, 'utf8')], { type: 'text/plain' }), name);
    const res = await fetch(`${base}/api/documents/staged`, { method: 'POST', body: form, headers: { 'accept-language': 'uk' } });
    return (await res.json()).documents || [];
}
const dialogPick = (docs) => docs.filter(d => d.ok).reduce((b, d) => (!b || d.char_count > b.char_count ? d : b), null)?.language ?? null;
setSetting('ui_language', 'uk');
// Cyrillic with none of the letters that tell Russian from Ukrainian.
const AMBIGUOUS = 'Мама мила раму. Тато читав газету. Вдома тепло, а на вулиці сніг. Діти грали в саду, потім пили чай з медом. '.replace(/і/g, 'и').repeat(6);
let staged2 = await stageMany([['zoshyt.txt', AMBIGUOUS]]);
check('fixture: the text is ambiguous Cyrillic (no letter only Russian or Ukrainian has)', !/[ыэёіїєґ]/.test(AMBIGUOUS));
c = await create({ name: 'Zoshyt', description: '', content_language: '', documentIds: staged2.map(d => d.id) });
check('an ambiguous Cyrillic file under a Ukrainian interface: the dialog\'s file language and the course agree',
    staged2[0]?.language === c.row?.content_language, JSON.stringify({ file: staged2[0]?.language, course: c.row?.content_language }));
const SPACED_DUTCH = `Ik wil graag een kopje koffie met melk.${'\n'.repeat(4000)}Waar woon je? Ik woon in Utrecht.`;
const DENSE_GERMAN = 'Ich will Statistik lernen und die Grundlagen verstehen, denn das ist für meine Arbeit sehr wichtig. '.repeat(14);
staged2 = await stageMany([['spaced.txt', SPACED_DUTCH], ['dense.txt', DENSE_GERMAN]]);
check('fixture: the Dutch file is longer in raw characters, the German one has more text',
    SPACED_DUTCH.length > DENSE_GERMAN.length && staged2[1]?.char_count > staged2[0]?.char_count, JSON.stringify(staged2.map(d => d.char_count)));
// A goal that names the files' language makes it a candidate, so the file the
// dialog reads and the file the server reads must be the same one.
const examGoal = 'My exam is in German';
c = await create({ name: 'Notes', description: examGoal, content_language: '', documentIds: staged2.map(d => d.id) });
const dialogOffer = R({ name: 'Notes', description: examGoal, filesLanguage: dialogPick(staged2), appLanguage: getLanguage('uk'), browserLanguages: [] }).candidates.map(x => x.code);
check('two files: the server offers exactly the languages the dialog names, the German file among them',
    dialogPick(staged2) === 'de' && same(offeredCodes(c.identity?.system || ''), dialogOffer) && dialogOffer.includes('de'),
    JSON.stringify({ server: offeredCodes(c.identity?.system || ''), dialog: dialogOffer }));
setSetting('ui_language', 'en');

c = await create({ name: 'Kitchen gardening', description: 'I want to grow vegetables on a balcony.', content_language: '' });
check('a course with no language in sight: nothing asked, nothing stored', !c.identity?.system.includes('teaches_language') && c.row?.learning_language === '');

/* ── 8. it travels with the course ──────────────────────────────────────── */
console.log('\n--- 8. export and import keep it ---');
const api = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
};
const exported = await api(`/api/export/${nlInRu}`);
check('the JSON export names the learned language', exported.body?.project?.learning_language === 'nl' && exported.body?.project?.content_language === 'ru');
const back = await api('/api/import', { method: 'POST', body: JSON.stringify(exported.body) });
check('JSON door: imported with it', db.prepare('SELECT learning_language FROM projects WHERE id = ?').get(back.body?.id)?.learning_language === 'nl', JSON.stringify(back.body).slice(0, 300));
const plainExport = await api(`/api/export/${ruOnly}`);
check('a course that learns nothing exports no such field', plainExport.body?.project && !('learning_language' in plainExport.body.project));
const odd = await api('/api/import', { method: 'POST', body: JSON.stringify({ ...exported.body, project: { ...exported.body.project, learning_language: 'klingon' } }) });
check('an unknown code is dropped with a warning', db.prepare('SELECT learning_language FROM projects WHERE id = ?').get(odd.body?.id)?.learning_language === ''
    && (odd.body?.warnings || []).some(w => /klingon/.test(w)), JSON.stringify(odd.body?.warnings));
const bundle = await fetch(`${base}/api/export/${nlInRu}/bundle`);
const bundleBuf = Buffer.from(await bundle.arrayBuffer());
const form = new FormData();
form.append('bundle', new Blob([bundleBuf], { type: 'application/zip' }), 'course.studyvault');
const bundleBack = await fetch(`${base}/api/import/bundle`, { method: 'POST', body: form }).then(x => x.json());
check('bundle door: imported with it', db.prepare('SELECT learning_language FROM projects WHERE id = ?').get(bundleBack?.id)?.learning_language === 'nl', JSON.stringify(bundleBack).slice(0, 300));

/* ── 9. Automatic follows the LEARNER, not the files ─────────────────────── */
// Left on Automatic, a course is explained in the learner's own language. What
// says which language that is: what they typed, the language their profile
// (About you) is written in, the app language they chose, and their browser's.
// The files say what is being STUDIED, never who studies it: a Dutch textbook
// read by a Russian speaker is explained in Russian. Signals that agree decide
// with no model; signals that disagree, or files in another language, are put
// to the identity call as ONE more field, and without an answer the course is
// what it always was.
console.log('\n--- 9. Automatic: the learner\'s language, decided once from every signal ---');
const offer = (x) => x.candidates.map(c2 => c2.code);
const signalsOf = (x) => x.candidates.map(c2 => `${c2.code}:${c2.signals.join('+')}`);
const accept = (h) => C.languagesFromAcceptHeader(h);
const PROFILE_EN = 'Name\nAnna\n\nWhat do you do?\nI work as a nurse in Utrecht and moved here from Kazan three years ago. I want to be able to talk with my patients and with the people in my street.';
const PROFILE_RU = 'Меня зовут Анна, я медсестра и три года назад переехала в Утрехт. Хочу свободно говорить с пациентами и коллегами.';

check('the browser\'s list is read in order, each language once, unknown tags skipped',
    same(accept('ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7,*;q=0.1').map(l => l.code), ['ru', 'en'])
    && same(accept('').map(l => l.code), []) && same(accept('xx-YY').map(l => l.code), []));
check('...and its first language is the one languageFromAcceptHeader always returned',
    C.languageFromAcceptHeader('de-CH;q=0.5,fr;q=0.9') === accept('de-CH;q=0.5,fr;q=0.9')[0]);

// The four cases.
r = R({ name: '', filesLanguage: 'nl', appLanguage: null, browserLanguages: accept('ru-RU,ru;q=0.9') });
check('Russian browser + Dutch textbook, nothing typed: Russian, with nothing to choose', offer(r).length === 0 && r.code === 'ru' && r.source === 'interface', JSON.stringify({ offer: offer(r), code: r.code, source: r.source }));
r = R({ name: '', filesLanguage: 'nl', appLanguage: null, browserLanguages: accept('ru'), profile: PROFILE_EN });
// A profile is often written in English by habit, so it ranks below the browser.
check('English profile + Russian browser + Dutch files: Russian and English put to the model, the browser first', same(offer(r), ['ru', 'en']) && r.code === 'ru', JSON.stringify({ offer: offer(r), code: r.code }));
// An app language the learner chose says they read it: the browser is heard
// only while the app follows it (GLM chose the browser's Russian over a chosen
// English app in 2 of 4 tries, against the stated rule, so it is not asked).
// And the files' language only when the learner's words name it (offered
// it with nothing typed, GLM chose the files' Dutch for a physics book in 2 of 3).
r = R({ name: '', filesLanguage: 'nl', appLanguage: en, browserLanguages: accept('ru') });
check('an English app chosen over a Russian browser + Dutch physics: English, nothing to choose', offer(r).length === 0 && r.code === 'en', JSON.stringify({ offer: offer(r), code: r.code }));
r = R({ name: '', description: 'Готовлюсь к экзамену по физике, экзамен будет на нидерландском', filesLanguage: 'nl', appLanguage: null, browserLanguages: accept('ru') });
check('a goal that names the files\' language ("the exam is in Dutch") makes it a candidate', same(signalsOf(r), ['ru:typed+browser', 'nl:files']) && r.code === 'ru', JSON.stringify(signalsOf(r)));
r = R({ name: 'Natuurkunde VWO', description: '', filesLanguage: 'nl', appLanguage: null, browserLanguages: accept('ru') });
check('...a name that does not: not a candidate', offer(r).length === 0 && r.code === 'ru', JSON.stringify(offer(r)));
r = R({ name: 'Natuurkunde', filesLanguage: 'nl', appLanguage: nl, browserLanguages: accept('nl-NL,nl') });
check('Dutch app + Dutch browser + Dutch physics: one language, nothing to ask', offer(r).length === 0 && r.code === 'nl', JSON.stringify({ offer: offer(r), code: r.code }));
r = R({ name: 'Natuurkunde', filesLanguage: 'nl', appLanguage: nl, browserLanguages: accept('en-US,en') });
check('...and the same under an English browser', offer(r).length === 0 && r.code === 'nl', JSON.stringify({ offer: offer(r), code: r.code }));
r = R({ name: 'Physics', appLanguage: en, browserLanguages: accept('en-US,en') });
const was = R({ name: 'Physics', uiLanguage: en });
check('nothing typed in a language, no files: nothing to ask, the same answer as before', offer(r).length === 0 && r.code === was.code && r.source === was.source, JSON.stringify({ now: [r.code, r.source], was: [was.code, was.source] }));

// The rest of the signals.
r = R({ name: 'Физика', description: 'Хочу подготовиться к экзамену за два месяца', appLanguage: null, browserLanguages: accept('ru') });
check('typed in Russian under a Russian browser: they agree, nothing asked', offer(r).length === 0 && r.code === 'ru');
r = R({ name: 'Physics', profile: PROFILE_RU });
check('a profile alone (no app language, no browser): its language', r.code === 'ru' && r.source === 'profile' && offer(r).length === 0, JSON.stringify({ code: r.code, source: r.source }));
r = R({ name: 'Physics', appLanguage: en, browserLanguages: accept('en'), profile: PROFILE_RU });
check('a Russian profile under an English app: both offered, the app first', same(offer(r), ['en', 'ru']) && r.code === 'en', JSON.stringify({ offer: offer(r), code: r.code }));
r = R({ name: 'Learn Dutch', filesLanguage: 'nl', appLanguage: null, browserLanguages: accept('ru'), learning: 'nl' });
check('"Learn Dutch" + Dutch files + Russian browser: Dutch is what is learned, not a candidate', offer(r).length === 0 && r.code === 'ru');
r = R({ name: 'Learn Dutch', appLanguage: null, browserLanguages: accept('ru'), learning: 'nl',
    profile: 'Ik ben Anna en ik woon nu drie jaar in Utrecht. Ik wil graag beter Nederlands spreken met mijn collega\'s.' });
check('...a profile written in the Dutch being learned is practice, not the learner\'s language', offer(r).length === 0 && r.code === 'ru', JSON.stringify({ offer: offer(r), code: r.code }));
r = R({ explicit: 'nl', name: '', filesLanguage: 'nl', appLanguage: null, browserLanguages: accept('ru'), profile: PROFILE_EN });
check('an explicit choice asks nothing', r.code === 'nl' && r.source === 'explicit' && offer(r).length === 0);
r = R({ name: '', filesLanguage: 'nl', appLanguage: null, browserLanguages: accept('nl,en'), profile: PROFILE_EN });
check('each candidate says which signals named it', same(signalsOf(r), ['nl:browser', 'en:profile']), JSON.stringify(signalsOf(r)));

// A name the file filled in is the file's words, not the learner's.
const fileTitle = 'Wat ik wil weten over het huis en de tuin';
check('fixture: that title reads as Dutch', C.detectWrittenLanguage(fileTitle) === 'nl');
check('typedName: the file\'s own title is not typed', C.typedName(fileTitle, [fileTitle]) === '' && C.typedName(` ${fileTitle.toUpperCase()} `, [fileTitle]) === '');
check('...a name of the learner\'s own is', C.typedName('My garden', [fileTitle]) === 'My garden' && C.typedName('My garden') === 'My garden');

// The identity prompt.
const signals = { typed: null, profile: 'en', app: null, browser: ['ru', 'en'], files: 'nl' };
const ask2 = P.identityPrompt({ name: '', description: '', lang: nl, sources: '', learningCandidates: [nl], explainCandidates: [ru, en, nl], signals });
const sys = ask2.system;
const explainLine = sys.split('\n').find(l => l.includes('"explain_in": the language')) || '';
check('the JSON shape asks for "explain_in" before the name, so the name is written after the choice',
    sys.indexOf('"explain_in"') > 0 && sys.indexOf('"explain_in"') < sys.indexOf('"keep_name"'), sys.slice(0, 300));
check('...offers the codes strongest first', explainLine.includes('codes: ru (Russian), en (English), nl (Dutch)'), explainLine);
check('...says what each signal said, the app before the browser before the profile',
    explainLine.includes('their profile (About you) is written in English') && /browser[^.;]*Russian, English/.test(explainLine) && /files[^.;]*Dutch/.test(explainLine)
    && explainLine.indexOf('follow the browser') < explainLine.indexOf('browser\'s languages') && explainLine.indexOf('browser\'s languages') < explainLine.indexOf('profile'), explainLine);
check('...what was typed counts most; a profile may be in English by habit', /typed counts most/.test(explainLine) && /English by habit/.test(explainLine));
const chosenApp = P.identityPrompt({ name: '', description: '', lang: en, learningCandidates: [nl], explainCandidates: [en, nl],
    signals: { ...signals, app: 'en', profile: null } }).system.split('\n').find(l => l.includes('"explain_in": the language')) || '';
check('...an app language the learner chose is said as chosen, and the browser it overrides is not offered as a reason',
    chosenApp.includes('they chose English as the app\'s language') && !chosenApp.includes('browser'), chosenApp);
check('...a textbook in another language is explained in the learner\'s', /textbook/.test(sys));
check('...the name and description are written in the chosen language, never a fixed one', !sys.includes('in Dutch (Nederlands). A text you KEEP') && sys.includes('the language you choose for "explain_in"'));
check('...and "teaches_language" reads that choice too', /reads this course in the language you choose for "explain_in"/.test(sys));
const noAsk = P.identityPrompt({ name: 'Physics', description: '', lang: en });
check('no candidates: the prompt is the one it always was', same(P.identityPrompt({ name: 'Physics', description: '', lang: en, explainCandidates: [], signals }), noAsk) && !noAsk.system.includes('explain_in'));

// Reading the answer.
const px = (raw) => P.parseIdentityDecision(JSON.stringify(raw), { name: '', description: 'Some goal here', lang: nl, learningCandidates: [nl], explainCandidates: [en, ru, nl] });
const kept = { keep_name: true, name: '', keep_description: true, description: 'Some goal here' };
check('"ru" picks Russian', px({ ...kept, explain_in: 'ru' })?.explainIn === 'ru');
check('"RU", "Russian" and "Русский" are the same answer', ['RU', 'Russian', 'Русский'].every(v => px({ ...kept, explain_in: v })?.explainIn === 'ru'));
check('a language that was not offered is refused', px({ ...kept, explain_in: 'de' })?.explainIn === null);
check('...also one offered only as what the course might TEACH',
    P.parseIdentityDecision(JSON.stringify({ ...kept, explain_in: 'nl' }), { name: '', description: 'Some goal here', lang: en, learningCandidates: [nl], explainCandidates: [en, ru] })?.explainIn === null);
check('an absent or empty field is no answer', px(kept)?.explainIn === null && px({ ...kept, explain_in: '' })?.explainIn === null);
check('with nothing offered the field is ignored', P.parseIdentityDecision(JSON.stringify({ ...kept, explain_in: 'ru' }), { name: '', description: 'Some goal here', lang: nl })?.explainIn === null);
const named2 = (n, code) => px({ keep_name: false, name: n, keep_description: true, description: '', explain_in: code })?.name;
check('the name is checked against the language the same reply chose: English refused for Russian', named2('Dutch for everyday life', 'ru') === null);
check('...a Russian one kept', named2('Нидерландский для жизни', 'ru') === 'Нидерландский для жизни');
check('...and the English one kept when English was chosen', named2('Dutch for everyday life', 'en') === 'Dutch for everyday life');

// The call: one decision, kept.
const reply = (o) => JSON.stringify(o);
const ruAnswer = { keep_name: false, name: 'Нидерландский с нуля', keep_description: false, description: 'Курс нидерландского языка для тех, кто говорит по-русски: слова, грамматика и разговор.', reason: 'x', explain_in: 'ru', teaches_language: 'nl' };
let decided = await P.decideProjectIdentity({ name: '', description: '', lang: nl, learningCandidates: [nl], explainCandidates: [en, ru, nl], signals, generate: async () => reply(ruAnswer) });
check('decideProjectIdentity reports the chosen language, with the name and description written in it',
    decided.explainIn === 'ru' && decided.teachesLanguage === 'nl' && decided.name === 'Нидерландский с нуля' && decided.attempts === 1, JSON.stringify(decided));
let n9 = 0;
decided = await P.decideProjectIdentity({ name: 'Boek', description: 'Some goal here', lang: nl, explainCandidates: [ru, nl], signals,
    generate: async () => reply(++n9 === 1 ? { ...kept, keep_name: true } : { ...kept, keep_name: true, explain_in: 'ru' }) });
check('a reply that leaves the language out does not settle it: one more attempt, and its answer counts', decided.explainIn === 'ru' && decided.attempts === 2, JSON.stringify(decided));
n9 = 0;
decided = await P.decideProjectIdentity({ name: '', description: '', lang: nl, explainCandidates: [en, ru], signals,
    generate: async () => reply(++n9 === 1 ? { ...ruAnswer, name: 'Dutch from zero' } : { ...ruAnswer, explain_in: 'en', name: 'Dutch from zero', description: 'A course in Dutch for people who speak English, from the first words to conversation.' }) });
check('the first answer holds: a later reply cannot switch the language, and its English name is refused under Russian',
    decided.explainIn === 'ru' && decided.name !== 'Dutch from zero', JSON.stringify(decided));
n9 = 0;
decided = await P.decideProjectIdentity({ name: '', description: 'Some goal here', lang: nl, explainCandidates: [ru, nl], signals,
    generate: async () => reply(++n9 === 1 ? { keep_name: false, name: 'Dutch from zero', keep_description: true, description: '' } : { keep_name: false, name: '', keep_description: true, description: '', explain_in: 'ru' }) });
check('a name checked before the language was chosen is dropped when another one is', decided.explainIn === 'ru' && decided.name === '', JSON.stringify(decided));
decided = await P.decideProjectIdentity({ name: 'Boek', description: 'Some goal here', lang: nl, explainCandidates: [ru, nl], signals, generate: async () => { throw new Error('down'); } });
check('no answer at all: no language decided (the caller keeps its fallback)', decided.explainIn === null && decided.name === 'Boek');

// End to end, through the real route.
setSetting('ui_language', 'auto');
docs = await stage('nederlands-in-gang.txt', DUTCH_TEXTBOOK);
c = await create({ name: '', description: '', content_language: '', documentIds: docs }, { acceptLanguage: 'ru-RU,ru;q=0.9' });
check('E2E Russian browser + Dutch textbook: no language to choose, only "does it teach Dutch" asked',
    !!c.identity && !c.identity.system.includes('"explain_in"') && c.identity.system.includes('nl (Dutch)'), c.identity?.system.slice(-500));
check('...shown the files\' own words to judge from', inside(c.identity?.user || '').includes('Hoe heet jij'), (c.identity?.user || '').slice(0, 300));
check('...and the course is explained in Russian and teaches Dutch (it was Dutch, explaining Dutch, before)', c.row?.content_language === 'ru' && c.row?.learning_language === 'nl', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));
check('...its phases were planned in Russian', c.calls.some(x => x.stage === 'categories' && x.system.includes('everything else is Russian') && x.system.includes('teaches Dutch')),
    c.calls.find(x => x.stage === 'categories')?.system.slice(-400));
identityMode = 'garbage';
docs = await stage('nederlands-in-gang.txt', DUTCH_TEXTBOOK);
c = await create({ name: '', description: '', content_language: '', documentIds: docs }, { acceptLanguage: 'ru-RU,ru;q=0.9' });
check('...with no usable answer: still Russian, nothing guessed about teaching Dutch', c.row?.content_language === 'ru' && c.row?.learning_language === '', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));
identityMode = 'judge';

setSetting('user_profile', PROFILE_EN);
docs = await stage('nederlands-in-gang.txt', DUTCH_TEXTBOOK);
c = await create({ name: '', description: '', content_language: '', documentIds: docs }, { acceptLanguage: 'ru' });
check('E2E English profile + Russian browser + Dutch textbook: Russian then English offered, not the files\' Dutch', same(offeredCodes(c.identity?.system || ''), ['ru', 'en']), c.identity?.system.split('\n').find(l => l.includes('"explain_in": the language')));
check('...explained in Russian, teaching Dutch', c.row?.content_language === 'ru' && c.row?.learning_language === 'nl', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));
identityMode = 'garbage';
docs = await stage('nederlands-in-gang.txt', DUTCH_TEXTBOOK);
c = await create({ name: '', description: '', content_language: '', documentIds: docs }, { acceptLanguage: 'ru' });
check('...with no usable answer: the strongest signal, the browser\'s Russian', c.row?.content_language === 'ru', JSON.stringify({ c: c.row?.content_language }));
identityMode = 'judge';
docs = await stage('natuurkunde-vwo.txt', DUTCH_PHYSICS);
c = await create({ name: 'Physics', description: 'My class is in Dutch', content_language: '', documentIds: docs }, { acceptLanguage: 'ru' });
check('...a goal naming the files\' Dutch puts it on offer, after the learner\'s own languages', same(offeredCodes(c.identity?.system || ''), ['en', 'ru', 'nl']),
    c.identity?.system.split('\n').find(l => l.includes('"explain_in": the language')));
check('...and an answer that is not the strongest signal is the one the course gets', c.row?.content_language === 'nl' && c.row?.learning_language === '', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));
docs = await stage('nederlands-in-gang.txt', DUTCH_TEXTBOOK);
c = await create({ name: '', description: '', content_language: '', documentIds: docs }, { acceptLanguage: 'nl-NL,nl' });
check('...a Dutch browser, an English profile and a Dutch textbook: still asked whether it teaches Dutch, though Dutch is also the browser\'s',
    (c.identity?.system || '').includes('"teaches_language"') && same(offeredCodes(c.identity?.system || ''), ['nl', 'en']), c.identity?.system.slice(-700));
check('...the profile\'s words are not sent, only its language', !(c.identity?.user || '').includes('nurse') && !(c.identity?.system || '').includes('nurse'));
docs = await stage('natuurkunde-vwo.txt', DUTCH_PHYSICS);
c = await create({ name: '', description: 'Mijn klas is in het Nederlands: examen in het Nederlands in mei', content_language: '', documentIds: docs }, { acceptLanguage: 'ru' });
check('...a goal saying the exam is in Dutch can choose the files\' Dutch (the model\'s call)', c.row?.content_language === 'nl' && c.row?.learning_language === '', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));
docs = await stage('nederlands-in-gang.txt', DUTCH_TEXTBOOK);
c = await create({ name: '', description: 'Mijn klas is in het Nederlands', content_language: '', documentIds: docs }, { acceptLanguage: 'ru' });
check('...a Dutch textbook explained in Dutch, as chosen, learns no "second" Dutch', c.row?.content_language === 'nl' && c.row?.learning_language === '', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));
setSetting('user_profile', '');

setSetting('ui_language', 'nl');
docs = await stage('natuurkunde-vwo.txt', DUTCH_PHYSICS);
c = await create({ name: 'Natuurkunde', description: '', content_language: '', documentIds: docs }, { acceptLanguage: 'nl-NL,nl' });
check('E2E Dutch app + Dutch physics: nothing asked, no language question either', !!c.identity && !c.identity.system.includes('explain_in') && !c.identity.system.includes('teaches_language'));
check('...physics in Dutch', c.row?.content_language === 'nl' && c.row?.learning_language === '', JSON.stringify({ c: c.row?.content_language, l: c.row?.learning_language }));

setSetting('ui_language', 'auto');
c = await create({ name: 'Physics', description: '', content_language: '' }, { acceptLanguage: 'en-US,en' });
check('E2E nothing typed in a language, no files: nothing asked, English', !!c.identity && !c.identity.system.includes('explain_in') && c.row?.content_language === 'en');

// A name the dialog filled in from the file does not count as typed.
docs = await stage(`${fileTitle}.txt`, DUTCH_PHYSICS);
c = await create({ name: fileTitle, description: '', content_language: '', documentIds: docs }, { acceptLanguage: 'en-US,en' });
check('E2E a Dutch file\'s own title in the name, English browser: English, nothing to choose (the title is not the learner\'s Dutch)',
    !!c.identity && !c.identity.system.includes('"explain_in"') && c.row?.content_language === 'en', JSON.stringify({ c: c.row?.content_language }));
setSetting('user_profile', PROFILE_RU);
docs = await stage(`${fileTitle}.txt`, DUTCH_PHYSICS);
c = await create({ name: fileTitle, description: '', content_language: '', documentIds: docs }, { acceptLanguage: 'en-US,en' });
check('...with a Russian profile: English and Russian offered, never the title\'s Dutch', same(offeredCodes(c.identity?.system || ''), ['en', 'ru']),
    c.identity?.system.split('\n').find(l => l.includes('"explain_in": the language')));
check('...and the model is told the name came from the file', (c.identity?.system || '').includes('filled in from a file\'s title'));
setSetting('user_profile', '');
setSetting('ui_language', 'en');

// The dialog runs the same function on the same inputs.
const fsMod = await import('node:fs');
const fieldSrc = fsMod.readFileSync(new URL('../src/components/ProjectFormFields.tsx', import.meta.url), 'utf8');
const PROBABLY = 'Automatic (probably {{language}})';
const localeFiles = fsMod.readdirSync(new URL('../src/locales/', import.meta.url)).filter(f => f.endsWith('.json'));
check('with several candidates the option names the strongest as "probably", in every interface language',
    /automaticCodes\.length > 1 \? t\("Automatic \(probably \{\{language\}\}\)"/.test(fieldSrc)
    && localeFiles.length >= 12 && localeFiles.every(f => /\{\{language\}\}/.test(JSON.parse(fsMod.readFileSync(new URL(`../src/locales/${f}`, import.meta.url), 'utf8'))[PROBABLY] || '')),
    localeFiles.filter(f => !JSON.parse(fsMod.readFileSync(new URL(`../src/locales/${f}`, import.meta.url), 'utf8'))[PROBABLY]).join(', '));
const dialogCall = modal.slice(modal.indexOf('resolveCreationLanguage({'), modal.indexOf('});', modal.indexOf('resolveCreationLanguage({')));
check('the dialog passes every signal to the shared resolution',
    ['name: typedName(', 'profile', 'browserLanguages', 'appLanguage', 'filesLanguage', 'learning:'].every(k => dialogCall.includes(k))
    && /languagesFromAcceptHeader\(/.test(modal) && /candidates/.test(modal), dialogCall);

await new Promise(r2 => server.close(r2));
await new Promise(r2 => stub.close(r2));
console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
