#!/usr/bin/env node
// tools/project-identity-gates.mjs — what a NEW AI project is called, what it says
// about itself, and which language it is authored in.
//
// Run:  node tools/project-identity-gates.mjs
//
// Two failures this pins, both invisible until a learner met them:
//   1. `content_language` was '' on every new project whose form was left on
//      "Follow the material", and a project that does not exist yet has no
//      material, so every creation prompt carried NO language. A Russian learner
//      with a Russian description got an English Overview.
//   2. The learner's description was discarded and replaced by the model's
//      24-word summary, good or not.
//
// Deterministic: no model, no network. The decision step is driven with an
// injected `generate`, and the prompts are read off the real `AI_PROMPTS`.
// Scratch DB + VAULT_ROOT are set IN-PROCESS before anything reaches database.js.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'identity-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.AI_PROVIDER = 'ollama';
process.env.AI_MODEL = 'gate-model:9b';

const { getLanguage } = await import('../server/language.js');
const P = await import('../server/projectIdentity.js');
const { AI_PROMPTS } = await import('../server/ai.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ru = getLanguage('ru');
const en = getLanguage('en');
const nl = getLanguage('nl');

/* ── 1. the language the learner wrote in ───────────────────────────────── */
console.log('\n--- detectWrittenLanguage ---');
const det = P.detectWrittenLanguage;
check('Russian prose -> ru', det('Хочу выучить основы термодинамики с нуля') === 'ru');
check('Ukrainian letters -> uk', det('Хочу вивчити основи програмування, я початківець') === 'uk');
check('Dutch -> nl', det('Ik wil leren programmeren voor het werk') === 'nl');
check('English -> en', det('I want to learn the basics of organic chemistry') === 'en');
check('German -> de', det('Ich will Statistik lernen und die Grundlagen verstehen') === 'de');
check('Japanese kana -> ja', det('プログラミングを学びたいです') === 'ja');
check('Han only -> zh', det('我想学习线性代数的基础知识') === 'zh');
check('a lone word is inconclusive (defers to the interface)', det('Python') === null);
check('a number-laden title is inconclusive', det('Excel 2024') === null);
check('empty is inconclusive', det('') === null && det(undefined) === null);

console.log('\n--- Accept-Language ---');
check('first catalog language wins', P.languageFromAcceptHeader('ru-RU,ru;q=0.9,en;q=0.8')?.code === 'ru');
check('q-values order the list', P.languageFromAcceptHeader('en;q=0.4, nl;q=0.9')?.code === 'nl');
check('an unknown language is skipped', P.languageFromAcceptHeader('xx, de')?.code === 'de');
check('nothing known is null', P.languageFromAcceptHeader('') === null && P.languageFromAcceptHeader('*') === null);

/* ── 2. the resolution order ────────────────────────────────────────────── */
console.log('\n--- resolveCreationLanguage: explicit > written > interface > English ---');
const R = P.resolveCreationLanguage;
let r = R({ explicit: 'nl', name: 'Физика', description: 'Хочу выучить физику с нуля', uiLanguage: ru });
check('an explicit choice beats everything', r.code === 'nl' && r.source === 'explicit');
r = R({ explicit: '', name: 'Термодинамика', description: 'Хочу выучить основы термодинамики с нуля', uiLanguage: en });
check('the language the learner WROTE beats the interface language', r.code === 'ru' && r.source === 'written', JSON.stringify(r.source));
r = R({ explicit: '', name: 'Python', description: '', uiLanguage: ru });
check('an inconclusive text takes the interface language (the reported case)', r.code === 'ru' && r.source === 'interface');
r = R({ explicit: '', name: 'Python', description: 'I am a newbie, I want to learn this', uiLanguage: ru });
check('English written under a Russian interface stays English (they typed English)', r.code === 'en' && r.source === 'written', JSON.stringify(r));
r = R({ explicit: '', name: 'Python', description: '', uiLanguage: null });
check('nothing to go on is English', r.code === 'en' && r.source === 'default');
r = R({ explicit: 'zz', name: 'Физика', description: 'Хочу выучить физику с нуля', uiLanguage: null });
check('an unknown explicit code is ignored, not trusted', r.code === 'ru' && r.source === 'written');
check('the result is always a catalog entry', !!R({}).lang?.name);
r = R({ explicit: '', name: 'Старт', description: 'Хочу вчити мови', uiLanguage: getLanguage('bg') });
check('an ambiguous Cyrillic text takes a Cyrillic interface language as its tiebreak', ['uk', 'bg', 'ru'].includes(r.code));

/* ── 3. every creation prompt carries the directive ─────────────────────── */
console.log('\n--- every creation prompt carries the language directive ---');
const hasRu = (pair) => /Russian/.test(pair.system) && /Русский/.test(pair.system);
const els = [{ title: 'Тема', description: 'Описание' }];
check('planning notes', hasRu(AI_PROMPTS.project_thinking('Физика', 'Описание', { lang: ru })));
check('summary', hasRu(AI_PROMPTS.summarizeProjectDescription('Физика', 'Описание', { lang: ru })));
check('phases', hasRu(AI_PROMPTS.generate_categories('Физика', 'Описание', '', 'Сводка', { lang: ru })));
check('topics', hasRu(AI_PROMPTS.generate_elements('Физика', 'Сводка', 'Фаза', 'Описание', { lang: ru })));
check('details (per topic)', hasRu(AI_PROMPTS.generate_sub_elements('Физика', 'Сводка', 'Описание', 'Фаза', 'Описание', 'Тема', 'Тема', 'Описание', { lang: ru })));
check('details (batched)', hasRu(AI_PROMPTS.generate_sub_elements_batch('Физика', 'Сводка', 'Описание', 'Фаза', 'Описание', els, { lang: ru })));
check('without a language the notes and summary are exactly as before',
    !/LANGUAGE/.test(AI_PROMPTS.project_thinking('x', 'y').system) && !/LANGUAGE/.test(AI_PROMPTS.summarizeProjectDescription('x', 'y').system));

/* ── 4. validation of what the model proposes ───────────────────────────── */
console.log('\n--- proposed name / description ---');
check('a plain title passes', P.cleanProposedName('Основы термодинамики', ru) === 'Основы термодинамики');
check('markdown and quotes are stripped from a name', P.cleanProposedName('**"Основы термодинамики"**', ru) === 'Основы термодинамики');
check('a trailing full stop is dropped', P.cleanProposedName('Основы термодинамики.', ru) === 'Основы термодинамики');
check('a sentence is not a name', P.cleanProposedName('Я хочу выучить основы термодинамики с нуля', ru) === null);
check('a two-sentence name is refused', P.cleanProposedName('Термодинамика. Курс для начинающих', ru) === null);
check('a question is not a name', P.cleanProposedName('Что такое термодинамика?', ru) === null);
check('a name over the cap is refused', P.cleanProposedName('а'.repeat(81), ru) === null);
check('eleven words is not a name', P.cleanProposedName('один два три четыре пять шесть семь восемь девять десять одиннадцать', ru) === null);
check('an English name in a Russian project is refused', P.cleanProposedName('Thermodynamics basics', ru) === null);
check('...but the same name in an English project passes', P.cleanProposedName('Thermodynamics basics', en) === 'Thermodynamics basics');
check('a non-string is refused', P.cleanProposedName(null, en) === null && P.cleanProposedName(42, en) === null);

const goodDesc = 'Курс для начинающих: основы термодинамики, законы, циклы и примеры расчётов.';
check('a good description passes', P.cleanProposedDescription(goodDesc, ru) === goodDesc);
check('a description in the wrong language is refused', P.cleanProposedDescription('A beginner course on thermodynamics with laws, cycles and worked examples.', ru) === null);
check('a one-word description is refused', P.cleanProposedDescription('Термодинамика', ru) === null);
check('a code fence is refused', P.cleanProposedDescription('```json\n{"x":1}\n``` курс для начинающих по термодинамике', ru) === null);
check('a 700-character description is refused', P.cleanProposedDescription('слово '.repeat(120), ru) === null);
check('bullets and headings are flattened', P.cleanProposedDescription('# Курс\n- основы термодинамики\n- циклы и законы для начинающих', ru) === 'Курс основы термодинамики циклы и законы для начинающих');
check('a Dutch description that reads as English is refused in a Dutch project',
    P.cleanProposedDescription('This is a course about the basics of physics and how it works in the world', nl) === null);

/* ── 5. the decision ─────────────────────────────────────────────────────── */
console.log('\n--- decideProjectIdentity ---');
const reply = (o) => JSON.stringify(o);
const scripted = (...replies) => {
    const calls = [];
    const generate = async (user, system, ctx, opts) => {
        calls.push({ user, system, opts });
        const next = replies[Math.min(calls.length - 1, replies.length - 1)];
        if (next instanceof Error) throw next;
        return next;
    };
    return { generate, calls };
};
const run = (extra) => P.decideProjectIdentity({ lang: ru, attemptTimeoutMs: 500, totalBudgetMs: 10_000, ...extra });

const goodName = 'Основы термодинамики';
const goodDescription = 'Хочу разобраться в законах термодинамики и научиться считать циклы для курса в университете.';

{
    const s = scripted(reply({ keep_name: true, name: goodName, keep_description: true, description: goodDescription, reason: 'both fine' }));
    const d = await run({ name: goodName, description: goodDescription, generate: s.generate });
    check('good name + good description: both kept verbatim', d.name === goodName && d.description === goodDescription && !d.nameFromAI && !d.descriptionFromAI && !d.fellBack);
    check('...in one call, at the unattended operation with a bounded timeout',
        s.calls.length === 1 && s.calls[0].opts.operation === 'project_identity' && s.calls[0].opts.timeout <= 500);
    check('...and the model is told the language', /Russian/.test(s.calls[0].system));
}
{
    const written = 'Курс для новичков: законы термодинамики, циклы и примеры расчётов с нуля.';
    const s = scripted(reply({ keep_name: true, name: goodName, keep_description: false, description: written, reason: 'no subject' }));
    const d = await run({ name: goodName, description: 'Хочу это выучить, я новичок', generate: s.generate });
    check('good name + "I want to learn this": name kept, description written', d.name === goodName && d.description === written && !d.nameFromAI && d.descriptionFromAI);
}
{
    const s = scripted(reply({ keep_name: false, name: goodName, keep_description: false, description: goodDescription, reason: 'empty' }));
    const d = await run({ name: '', description: '', generate: s.generate });
    check('empty name + empty description: both written', d.name === goodName && d.description === goodDescription && d.nameFromAI && d.descriptionFromAI);
}
{
    const s = scripted('not json at all', '{"keep_name": maybe}', '[]');
    const d = await run({ name: 'Термо', description: 'мне интересно', generate: s.generate });
    check('garbage three times: originals kept', d.name === 'Термо' && d.description === 'мне интересно' && d.fellBack && !d.nameFromAI && !d.descriptionFromAI);
    check('...after exactly three attempts', s.calls.length === 3 && d.attempts === 3);
}
{
    const s = scripted(Object.assign(new Error('Request timeout after 25s'), { name: 'TimeoutError' }));
    const d = await run({ name: 'Термо', description: '', generate: s.generate });
    check('a timeout every time: originals kept, nothing thrown', d.name === 'Термо' && d.description === '' && d.fellBack);
    check('...three attempts spent', s.calls.length === 3);
}
{
    const s = scripted(reply({ keep_name: true, name: 'x', keep_description: false, description: 'short' }), reply({ keep_name: true, name: '', keep_description: false, description: goodDescription }));
    const d = await run({ name: goodName, description: 'newbie', generate: s.generate });
    check('an unusable rewrite is retried and the next good one used', d.description === goodDescription && s.calls.length === 2);
}
{
    const s = scripted(reply({ keep_name: false, name: 'A very long sentence that the model wrote and that is certainly not a name at all, sorry', keep_description: true, description: '' }));
    const d = await run({ name: 'Термо', description: goodDescription, generate: s.generate });
    check('a rewrite that fails validation never replaces the learner name', d.name === 'Термо' && !d.nameFromAI);
}
{
    const s = scripted(reply({ keep_name: false, name: 'english title here', keep_description: true, description: '' }));
    const d = await run({ name: 'Термо', description: goodDescription, generate: s.generate });
    check('a wrong-language rewrite is refused, original kept', d.name === 'Термо');
}
{
    const s = scripted(reply({ keep_name: true, name: 'SOMETHING ELSE', keep_description: true, description: 'SOMETHING ELSE' }));
    const d = await run({ name: goodName, description: goodDescription, generate: s.generate });
    check('"keep" wins over whatever the model echoed back', d.name === goodName && d.description === goodDescription);
}
{
    const s = scripted(reply({ keep_name: false, name: goodName.toUpperCase(), keep_description: true, description: '' }));
    const d = await run({ name: goodName, description: goodDescription, generate: s.generate });
    check('a proposal equal to the original is not credited to the model', !d.nameFromAI && d.name === goodName);
}
{
    const s = scripted(reply({ keep_name: 'true', name: '', keep_description: 'false', description: goodDescription }));
    const d = await run({ name: goodName, description: 'newbie', generate: s.generate });
    check('string booleans are read, not rejected', d.description === goodDescription && !d.fellBack);
}
{
    const s = scripted('```json\n' + reply({ keep_name: true, name: goodName, keep_description: true, description: goodDescription }) + '\n```');
    const d = await run({ name: goodName, description: goodDescription, generate: s.generate });
    check('a fenced reply is repaired by the shared parser', !d.fellBack && d.name === goodName);
}
{
    const ac = new AbortController();
    const s = scripted(reply({ keep_name: true, name: goodName, keep_description: true, description: goodDescription }));
    ac.abort();
    let threw = false;
    try { await run({ name: goodName, description: goodDescription, generate: s.generate, signal: ac.signal }); } catch { threw = true; }
    check('the ONLY thing that throws is the learner cancelling', threw && s.calls.length === 0);
}
{
    let t = 0;
    const s = scripted(Object.assign(new Error('slow'), { name: 'TimeoutError' }));
    const d = await run({ name: 'Термо', description: '', generate: async (...a) => { t += 40_000; return s.generate(...a); }, now: () => t, totalBudgetMs: 60_000 });
    check('the total budget stops the retries (two 40 s attempts exhaust 60 s)', s.calls.length === 2 && d.fellBack, `calls=${s.calls.length}`);
}
{
    const prompt = P.identityPrompt({ name: 'Термо', description: '', lang: ru });
    check('the prompt marks the learner text as data and names the empty field', /data to judge/.test(prompt.system) && /\(empty\)/.test(prompt.user));
}

/* ── 6. provenance ───────────────────────────────────────────────────────── */
console.log('\n--- projects.generated_by ---');
check('nothing the model wrote: no stamp', P.addProvenanceFields(null, []) === null && P.addProvenanceFields(null, [false, null]) === null);
const stamp = JSON.parse(P.addProvenanceFields(null, ['description']));
check('a stamp names the model and the fields', stamp.model === 'gate-model:9b' && eq(stamp.fields, ['description']));
const merged = JSON.parse(P.addProvenanceFields(JSON.stringify(stamp), ['summary', 'description']));
check('later writes merge into it', eq(merged.fields, ['description', 'summary']));
check('a corrupt prior stamp does not throw', !!P.addProvenanceFields('{not json', ['name']));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
