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

function answer(stage, system, user) {
    if (stage === 'identity') {
        if (identityMode === 'garbage') return 'What a lovely course!';
        const keep = { keep_name: true, name: '', keep_description: true, description: '', reason: 'both are good' };
        if (!system.includes('teaches_language')) return JSON.stringify(keep);
        if (identityMode === 'omit') return JSON.stringify(keep);
        const teaches = user.includes('Woordenschat') || user.includes('Kennismaken') ? 'nl' : '';
        return JSON.stringify({ ...keep, teaches_language: teaches });
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
check('...the same without the rule picks the book\'s Dutch (the fault)', r.code === 'nl' && r.source === 'files');
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

await new Promise(r2 => server.close(r2));
await new Promise(r2 => stub.close(r2));
console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
