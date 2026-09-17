// tools/language-gates.mjs — checks that the feed's quality gates still work in
// every language the app offers, not just English.
//
// Run:  node tools/language-gates.mjs
//
// Why this exists: content generation has always been multilingual (the prompts
// told the model to follow the material's language), but every gate that READS
// the generated text was written against English and failed open the moment the
// model wrote anything else. Those are the regressions that are invisible in
// normal use — a Ukrainian learner sees a self-certifying closer nobody catches;
// a Romanian learner gets a fabricated grade because the vision model's refusal
// was not recognised as a refusal.
//
// Nothing here calls a model, so it is cheap. Run it after touching
// server/language.js, server/feedQuality.js, or the NO_IMAGE patterns in server/paper.js.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'lang-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const { LANGUAGES, getLanguage, driftedToEnglish, englishDriftRatio, getProjectLanguage, invalidateProjectLanguage } =
    await import(B + 'language.js');
const { stripSelfCertifyingCloser } = await import(B + 'feedQuality.js');
const { isUnreadable } = await import(B + 'paper.js');
const { AI_PROMPTS, buildNodeContext } = await import(B + 'ai.js');
const db = (await import(B + 'database.js')).default;

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = got === want;
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)})`}`);
};

// ---------------------------------------------------------------------------
// 1. Self-certifying closers, per language
// ---------------------------------------------------------------------------
console.log('\n--- closer stripping ---');

const closerCases = [
    ['en', 'The refractive index sets how far light bends. A larger angle increases the deviation.',
        'You can now calculate the deviation for any angle of incidence.', true],
    // No second-person reference: a real closing argument, must survive.
    ['en', 'The refractive index sets how far light bends. A larger angle increases the deviation.',
        'With this equation, the period follows directly from the length.', false],
    ['nl', 'Het brekingsgetal bepaalt hoeveel het licht afbuigt bij de overgang.',
        'Nu kun je de afwijking voor elke invalshoek berekenen.', true],
    ['nl', 'Het brekingsgetal bepaalt hoeveel het licht afbuigt bij de overgang.',
        'Hiermee volgt de trillingstijd rechtstreeks uit de lengte.', false],
    ['de', 'Der Brechungsindex bestimmt, wie stark das Licht gebrochen wird.',
        'Jetzt kannst du die Abweichung für jeden Einfallswinkel berechnen.', true],
    // Lowercase "sie" is they/she, not the formal you — must not count as a
    // learner reference, or half of German prose looks like a closer.
    ['de', 'Der Brechungsindex bestimmt, wie stark das Licht gebrochen wird.',
        'Damit sind sie in der Lage, die Formel zu verwenden.', false],
    ['uk', 'Показник заломлення визначає, наскільки сильно відхиляється світло.',
        'Тепер ви можете обчислити відхилення для будь-якого кута падіння.', true],
    ['ru', 'Показатель преломления определяет, насколько сильно отклоняется свет.',
        'Теперь вы можете вычислить отклонение для любого угла падения.', true],
    // Pro-drop languages: the second person is in the VERB, not a pronoun.
    ['pl', 'Współczynnik załamania określa, jak mocno załamuje się światło.',
        'Teraz możesz obliczyć odchylenie dla dowolnego kąta padania.', true],
    ['ro', 'Indicele de refracție determină cât de mult se abate lumina.',
        'Acum puteți calcula abaterea pentru orice unghi de incidență.', true],
    ['es', 'El índice de refracción determina cuánto se desvía la luz.',
        'Ahora puedes calcular la desviación para cualquier ángulo.', true],
    ['it', "L'indice di rifrazione determina quanto devia la luce.",
        'Ora puoi calcolare la deviazione per qualsiasi angolo.', true],
    ['pt', 'O índice de refração determina o quanto a luz se desvia.',
        'Agora você pode calcular o desvio para qualquer ângulo.', true],
    ['fr', "L'indice de réfraction détermine la déviation de la lumière.",
        'Vous pouvez maintenant calculer la déviation pour tout angle.', true],
];

for (const [code, keep, closer, shouldStrip] of closerCases) {
    const out = stripSelfCertifyingCloser(`${keep}\n\n${closer}`, getLanguage(code));
    check(`${code}: ${shouldStrip ? 'strips' : 'keeps'} "${closer.slice(0, 38)}…"`, out === keep, shouldStrip);
}

console.log('\n--- a language with no patterns degrades safely ---');
const cs = 'Index lomu určuje, jak moc se světlo láme.\n\nNyní můžete vypočítat odchylku pro libovolný úhel.';
check('cs: strips nothing rather than guessing', stripSelfCertifyingCloser(cs, getLanguage('cs')), cs);
check('unset lang: still uses the English patterns',
    stripSelfCertifyingCloser('Light bends by an amount set by the index.\n\nYou can now do this yourself.', null),
    'Light bends by an amount set by the index.');

// ---------------------------------------------------------------------------
// 2. English drift — the failure the script check cannot see
// ---------------------------------------------------------------------------
console.log('\n--- English drift ---');

const englishLesson = `The refractive index of a medium tells you how much slower light travels
in that medium than in a vacuum. When a ray crosses from one medium into another, it bends,
and the amount that it bends is set by the ratio of the two indices. This is what Snell's law
describes, and it is the relationship you will use for every problem in this part. Consider a
ray that arrives at the boundary between air and glass with an angle of thirty degrees from the
normal. Because the glass has the higher index, the ray bends toward the normal, and the angle
inside the glass is smaller than the angle outside it.`;

const dutchLesson = `De brekingsindex van een stof geeft aan hoeveel langzamer licht zich door die
stof beweegt dan door vacuüm. Wanneer een lichtstraal van de ene stof naar de andere gaat, buigt
hij af, en hoeveel hij afbuigt wordt bepaald door de verhouding van de twee brekingsindices. Dat
is precies wat de wet van Snellius beschrijft. Denk aan een straal die onder dertig graden met de
normaal op het grensvlak tussen lucht en glas valt. Omdat glas de hogere index heeft, buigt de
straal naar de normaal toe, en is de hoek in het glas kleiner dan de hoek erbuiten.`;

// A lesson about English-named code is not a lesson that drifted into English.
const dutchWithCode = `${dutchLesson}

\`\`\`python
for i in range(10):
    print("the angle is", i)
\`\`\`

De functie \`refractive_index\` berekent dit, met $n_1 \\sin\\theta_1 = n_2 \\sin\\theta_2$.`;

check('English lesson in a Dutch project drifts', driftedToEnglish(englishLesson, getLanguage('nl')), true);
check('Dutch lesson in a Dutch project does not', driftedToEnglish(dutchLesson, getLanguage('nl')), false);
check('Dutch lesson + English code block does not', driftedToEnglish(dutchWithCode, getLanguage('nl')), false);
check('English lesson in an English project never flags', driftedToEnglish(englishLesson, getLanguage('en')), false);
check('no declared language never flags', driftedToEnglish(englishLesson, null), false);
check('a sample too short to judge is not judged', driftedToEnglish('The angle is small.', getLanguage('nl')), false);
check('Ukrainian lesson does not drift', driftedToEnglish(
    `Показник заломлення середовища показує, наскільки повільніше світло рухається в цьому
     середовищі порівняно з вакуумом. Коли промінь переходить з одного середовища в інше, він
     заломлюється, і величина заломлення визначається відношенням двох показників. Саме це описує
     закон Снелліуса, і саме цим співвідношенням ви користуватиметеся в кожній задачі цієї частини.
     Розглянемо промінь, який падає на межу між повітрям і склом під кутом тридцять градусів.`,
    getLanguage('uk')), false);

console.log(`        ratios — english=${englishDriftRatio(englishLesson).toFixed(3)} `
    + `dutch=${englishDriftRatio(dutchLesson).toFixed(3)} dutch+code=${englishDriftRatio(dutchWithCode).toFixed(3)}`);

// ---------------------------------------------------------------------------
// 3. The paper fabrication guard
// ---------------------------------------------------------------------------
console.log('\n--- vision-refusal guard (a missed refusal becomes a fabricated grade) ---');

const refusals = [
    ['en', "I'm sorry, I cannot see the image you are referring to."],
    ['nl', 'Het spijt me, ik kan de afbeelding niet zien die je hebt gestuurd.'],
    ['de', 'Es tut mir leid, ich kann das Bild nicht sehen, das Sie gesendet haben.'],
    ['fr', "Je suis désolé, je ne peux pas voir l'image que vous avez envoyée."],
    ['es', 'Lo siento, no puedo ver la imagen que has enviado para revisar.'],
    ['it', "Mi dispiace, non posso vedere l'immagine che hai inviato ora."],
    ['pt', 'Desculpe, não consigo ver a imagem que você enviou agora.'],
    ['pl', 'Przepraszam, nie mogę zobaczyć obrazu, który został przesłany.'],
    ['ro', 'Îmi pare rău, nu pot vedea imaginea pe care ați trimis-o acum.'],
    ['uk', 'Вибачте, я не можу побачити зображення, яке ви надіслали.'],
    ['ru', 'Извините, я не могу увидеть изображение, которое вы отправили.'],
];
for (const [code, text] of refusals) check(`${code}: refusal caught`, isUnreadable(text), true);

console.log('\n--- real handwritten work is NOT mistaken for a refusal ---');
const realWork = [
    ['en', 'Step 1: $n_1 \\sin\\theta_1 = n_2 \\sin\\theta_2$. Substituting gives $\\theta_2 = 19.5°$.'],
    ['nl', 'Stap 1: ik gebruik de wet van Snellius. Invullen geeft $\\theta_2 = 19{,}5°$.'],
    ['ru', 'Шаг 1: я вижу, что угол падения равен 30°. Подставляя, получаю 19,5°.'],
    ['de', 'Schritt 1: Ich kann das Snelliussche Gesetz anwenden und erhalte 19,5°.'],
    ['ro', 'Pasul 1: pot vedea că unghiul de incidență este 30°, deci rezultă 19,5°.'],
    ['it', "Passo 1: posso vedere che l'angolo è di 30°, quindi ottengo 19,5°."],
];
for (const [code, text] of realWork) check(`${code}: real working kept`, isUnreadable(text), false);
check('BLANK PAGE still caught', isUnreadable('BLANK PAGE'), true);

// ---------------------------------------------------------------------------
// 4. The declaration actually reaches the prompts
// ---------------------------------------------------------------------------
console.log('\n--- declared language reaches every authoring prompt ---');

const pid = db.prepare(
    "INSERT INTO projects (name, description, color, icon, position, content_language) "
    + "VALUES ('Natuurkunde', '', '#3B82F6', 'folder', 0, 'nl')"
).run().lastInsertRowid;
const nid = db.prepare(
    "INSERT INTO nodes (project_id, title, description, position) "
    + "VALUES (?, 'Breking van licht', 'Snellius toepassen', 0)"
).run(pid).lastInsertRowid;
invalidateProjectLanguage(Number(pid));

const lang = getProjectLanguage(Number(pid));
check('project language resolves from the DB', lang?.code, 'nl');

const ctx = buildNodeContext(nid);
check('buildNodeContext states it (reaches tutor/quiz/flashcards)',
    /Language of this project: Dutch \(Nederlands\)/.test(ctx), true);

check('feed_lesson orders Dutch', /Write EVERY word in Dutch \(Nederlands\)/.test(
    AI_PROMPTS.feed_lesson('Breking', [{ title: 'Snellius', focus: 'de wet' }], 1, ctx, [], { lang }).system), true);
check('feed_outline plans in Dutch', /in Dutch \(Nederlands\)/.test(
    AI_PROMPTS.feed_outline('Breking', ctx, { lang }).system), true);
check('feed_question asks in Dutch', /Write EVERY word in Dutch/.test(
    AI_PROMPTS.feed_question('Breking', 'Snellius', 'tekst', 'multiple_choice', { lang }).system), true);
check('paper_exercise sets the task in Dutch', /Write EVERY word in Dutch/.test(
    AI_PROMPTS.paper_exercise('Breking', ctx, { lang }).system), true);
check('paper_grade marks in Dutch', /Reply in Dutch \(Nederlands\)/.test(
    AI_PROMPTS.paper_grade({ brief: 'x', rubric: [] }, 'y', false, { lang }).system), true);
check('generate_categories names phases in Dutch', /LANGUAGE: write every "title" and "description" in Dutch/.test(
    AI_PROMPTS.generate_categories('Natuurkunde', 'd', 't', 's', { lang }).system), true);
check('generate_sub_elements_batch too', /LANGUAGE: write every "title" and "description" in Dutch/.test(
    AI_PROMPTS.generate_sub_elements_batch('P', 's', 'd', 'c', 'cd', [{ title: 'x' }], { lang }).system), true);

// An unset language must reproduce the pre-declaration prompts word for word,
// or every existing project silently changes behaviour on upgrade.
console.log('\n--- unset language reproduces the old prompts exactly ---');
check('falls back to "same language as the topic"',
    /Write in the same language as the topic and its Overview/.test(
        AI_PROMPTS.feed_lesson('T', [{ title: 'a', focus: 'b' }], 1, 'ctx', [], {}).system), true);
check('no LANGUAGE line is added when unset',
    /LANGUAGE:/.test(AI_PROMPTS.generate_categories('P', 'd', 't', 's').system), false);

// ---------------------------------------------------------------------------
// The two LANGUAGES tables
//
// These are NOT the same list and must not be asserted equal. `server/language.js`
// is the CONTENT catalogue — what a curriculum may be written in — and is
// deliberately wider than anything the app has been translated into; `src/i18n`
// is the INTERFACE list, one entry per shipped locale file. Today the content
// catalogue holds 27 codes and the interface list 12.
//
// What must hold is the containment: every language the interface is offered in
// has to exist as a content language, or a reader who picked that interface
// language cannot declare a project in it. The other direction is open by design.
// ---------------------------------------------------------------------------
console.log('\n--- the content catalogue and the interface list ---');
const i18nSrc = readFileSync(new URL('../src/i18n/index.ts', import.meta.url), 'utf8');
const uiBlock = i18nSrc.slice(i18nSrc.indexOf('export const LANGUAGES'), i18nSrc.indexOf('export const DEFAULT_LANGUAGE'));
const uiCodes = [...uiBlock.matchAll(/code:\s*'([a-z-]+)'/g)].map(m => m[1]);
check('the interface list was found in src/i18n/index.ts', uiCodes.length > 1, true);
check('every interface language is also a content language',
    uiCodes.filter(c => !getLanguage(c)).join(','), '');
check('the content catalogue is the wider of the two, as designed',
    LANGUAGES.length >= uiCodes.length, true);
check('a content language the interface does not ship is still selectable (cs)',
    !!getLanguage('cs') && !uiCodes.includes('cs'), true);

// Close before deleting: Windows refuses to unlink a file SQLite still has open,
// and a failed cleanup must not look like a failed test run.
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
