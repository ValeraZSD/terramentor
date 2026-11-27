#!/usr/bin/env node
// tools/speech-mark-gates.mjs — what a card in a language course says aloud is
// the card writer's call, checked before a learner hears it.
//
// Run:  node tools/speech-mark-gates.mjs
//
// WHY. A card line in a language course mixes languages ("de pijn (боль)",
// "Example: Het huis is groot."), and the rules that guess which words to say
// (src/utils/pronunciation.ts) cannot tell two languages in one script apart.
// The model that writes a card can, so it writes speech marks (`say`): per
// line, the words, their language and the number of voices. Pinned here:
//   - the check (server/speechMarks.js): each rule named by a literal card and
//     the literal marks it keeps, never by the check's own helpers;
//   - the prompt asks for marks only in a course that teaches a language, and
//     is unchanged elsewhere;
//   - the generator stores the checked marks, drops a bad one and keeps the card;
//   - a course file carries them in and out (import, export, update), and an
//     edition with marks updates a course installed before marks existed
//     without asking the learner about every card;
//   - a learner's edit keeps only the marks still true of the new text.
// Deterministic: a scratch library, no model, no network.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCRATCH = mkdtempSync(join(tmpdir(), 'speech-mark-gates-'));
process.env.DB_PATH = join(SCRATCH, 'gate.db');
process.env.VAULT_ROOT = join(SCRATCH, 'vault');
process.env.DATA_DIR = SCRATCH;
// No model is configured: one card per response, so the card checker is never asked.
process.env.AI_PROVIDER = 'ollama';
process.env.AI_MODEL = 'gate-model:9b';

const S = await import('../server/speechMarks.js');
const { normalizeImportTree, normalizeImportProject } = await import('../server/curriculumSchema.js');
const { default: db } = await import('../server/database.js');
const { AI_PROMPTS } = await import('../server/ai.js');
const { finalizeFlashcards, buildFlashcardPrompt } = await import('../server/studyMaterial.js');
const { insertImportedTree, exportedFlashcards, IMPORT_QUESTION_DEPS } = await import('../server/courseFiles.js');
const { isSupportedLanguage } = await import('../server/language.js');
const { recordInstalledBase, readInstalledCourse, readFileCourse, readBase, applyCourseUpdate } = await import('../server/courseUpdate.js');
const { planCourseUpdate } = await import('../server/courseMerge.js');
const { writeCard } = await import('../server/cardWrite.js');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const section = (s) => console.log(`\n${s}`);

try {
    // -----------------------------------------------------------------------
    section('the check: a mark survives only if it is true of its card');
    const ruCard = { front: 'de pijn (боль)', back: 'боль', extra: 'Voorbeeld: Ik heb pijn in mijn rug.  \nПример: у меня болит спина' };
    const check = (raw, card, learning) => S.normalizeSpeechMarks(raw, card, learning);
    let r = check([
        { at: 'de pijn (боль)', text: 'de pijn', lang: 'nl', voices: 2 },
        { at: 'voorbeeld: ik heb pijn in mijn rug.', text: 'Ik heb pijn in mijn rug.', lang: 'nl', voices: 1 },
    ], ruCard, 'nl');
    eq('two good marks are kept, `at` stored as the card writes the line',
        r.marks, [
            { at: 'de pijn (боль)', text: 'de pijn', voices: 2 },
            { at: 'Voorbeeld: Ik heb pijn in mijn rug.', text: 'Ik heb pijn in mijn rug.', voices: 1 },
        ]);
    const reasonFor = (mark, card = ruCard, learning = 'nl') => {
        const out = check([{ at: 'de pijn (боль)', text: 'de pijn' }, mark], card, learning);
        return [out.marks?.length, out.dropped.map(d => d.reason)];
    };
    eq('a line the card does not have is dropped, the good mark stays',
        reasonFor({ at: 'het huis', text: 'het huis' }), [1, ['"at" is not a line of the card']]);
    eq('words that are not in the line are dropped (no word made up)',
        reasonFor({ at: 'boль', text: 'boль' }), [1, ['"at" is not a line of the card']]);
    eq('a word of the line said differently is dropped ("pijnen" is not "pijn")',
        reasonFor({ at: 'Voorbeeld: Ik heb pijn in mijn rug.', text: 'Ik heb pijnen' }), [1, ['the words are not in the line']]);
    eq('a word found only inside a longer one is dropped ("pijn" is not in "pijnlijk")',
        reasonFor({ at: 'Het is pijnlijk.', text: 'pijn' }, { ...ruCard, extra_front: 'Het is pijnlijk.' }), [1, ['the words are not in the line']]);
    eq('`at` written with other spacing and case still names its line',
        check([{ at: '  VOORBEELD:  ik heb pijn in mijn rug. ', text: 'Ik heb pijn' }], ruCard, 'nl').marks,
        [{ at: 'Voorbeeld: Ik heb pijn in mijn rug.', text: 'Ik heb pijn', voices: 1 }]);
    eq('two pieces of one line glued into one text are dropped',
        reasonFor({ at: 'Voorbeeld: Ik heb pijn in mijn rug.', text: 'Ik heb rug' }), [1, ['the words are not in the line']]);
    eq('a stretch of the line with its punctuation is kept',
        check([{ at: 'Ja, graag. (Yes, please.)', text: 'Ja, graag.' }], { front: 'x', back: 'Ja, graag. (Yes, please.)' }, 'nl').marks,
        [{ at: 'Ja, graag. (Yes, please.)', text: 'Ja, graag.', voices: 1 }]);
    eq('words out of the line\'s order are dropped',
        reasonFor({ at: 'Voorbeeld: Ik heb pijn in mijn rug.', text: 'rug mijn' }), [1, ['the words are not in the line']]);
    eq('the Russian translation under a Dutch mark is dropped (script)',
        reasonFor({ at: 'Пример: у меня болит спина', text: 'у меня болит спина', lang: 'nl' }), [1, ["letters outside the learned language's script"]]);
    eq('a mark in another language is dropped',
        reasonFor({ at: 'боль', text: 'боль', lang: 'ru' }), [1, ['"lang" is not the language the course teaches']]);
    eq('three voices are dropped (there are two)',
        reasonFor({ at: 'Voorbeeld: Ik heb pijn in mijn rug.', text: 'Ik heb pijn in mijn rug.', voices: 3 }), [1, ['"voices" is not a whole number from 1 to 2']]);
    eq('a second mark on one line is dropped',
        reasonFor({ at: 'de pijn (боль)', text: 'pijn' }), [1, ['a second mark on one line']]);
    eq('an empty text is dropped',
        reasonFor({ at: 'Voorbeeld: Ik heb pijn in mijn rug.', text: '  ' }), [1, ['no words to say, or too many']]);
    r = check([{ at: 'de pijn (боль)', text: 'de pijn', lang: 'nl-BE' }], ruCard, 'nl');
    eq('a regional tag of the learned language is kept as the mark\'s language', r.marks, [{ at: 'de pijn (боль)', text: 'de pijn', lang: 'nl-BE', voices: 1 }]);
    eq('an empty list is kept: the writer said there is nothing to say', check([], ruCard, 'nl').marks, []);
    eq('every mark wrong: the card is not marked, so the rules read it', check([{ at: 'x', text: 'x' }], ruCard, 'nl').marks, null);
    eq('a course that teaches no language keeps no marks', check([{ at: 'de pijn (боль)', text: 'de pijn' }], ruCard, '').marks, null);
    eq('no list at all: not marked', check({ at: 'de pijn (боль)' }, ruCard, 'nl').marks, null);
    // Two languages in one script: what the rules cannot do, the marks can.
    eq('nl taught in English: the Dutch half of "the house = het huis" is kept',
        check([{ at: 'the house = het huis', text: 'het huis' }], { front: 'the house = het huis', back: 'x' }, 'nl').marks,
        [{ at: 'the house = het huis', text: 'het huis', voices: 1 }]);
    // Scripts without spaces: a word may be part of a longer run.
    eq('ja: 水 is a word of 水を飲む',
        check([{ at: '水を飲む', text: '水' }], { front: '水を飲む', back: 'to drink water' }, 'ja').marks, [{ at: '水を飲む', text: '水', voices: 1 }]);
    eq('ja: the English meaning is not Japanese',
        check([{ at: 'to drink water', text: 'to drink water' }], { front: '水を飲む', back: 'to drink water' }, 'ja').dropped.map(d => d.reason), ["letters outside the learned language's script"]);

    // -----------------------------------------------------------------------
    section('the prompt asks for marks only where a language is taught');
    const plain = AI_PROMPTS.flashcard_generator('ctx', 5);
    eq('no language: the prompt neither names spoken lines nor "say"', [/SPOKEN LINES/.test(plain.system), /"say"/.test(plain.user)], [false, false]);
    const dutch = AI_PROMPTS.flashcard_generator('ctx', 5, { code: 'nl', name: 'Dutch' });
    eq('a language: the rules and the field are asked for, with its code',
        [/SPOKEN LINES\. This course teaches Dutch\./.test(dutch.system), /"say": \[\{"at"/.test(dutch.user), /"lang": "nl"/.test(dutch.user)], [true, true, true]);

    // -----------------------------------------------------------------------
    section('the generator stores checked marks, a bad one dropped, the card kept');
    const project = (learning, content) => Number(db.prepare(
        'INSERT INTO projects (name, description, content_language, learning_language) VALUES (?, ?, ?, ?)').run('Gate', '', content, learning).lastInsertRowid);
    const topic = (projectId) => Number(db.prepare(`INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
        VALUES (?, NULL, 'Topic', '', '', 'not_started', 0, 0)`).run(projectId).lastInsertRowid);
    const nlTopic = topic(project('nl', 'ru'));
    const noLangTopic = topic(project('', 'en'));
    eq('the prompt for a Dutch course asks for marks', /SPOKEN LINES\. This course teaches Dutch\./.test(buildFlashcardPrompt(nlTopic, 3).system), true);
    eq('the prompt for a course with no taught language does not', /SPOKEN LINES/.test(buildFlashcardPrompt(noLangTopic, 3).system), false);
    const sayOf = (id) => db.prepare('SELECT say FROM flashcards WHERE id = ?').get(id).say;
    let out = await finalizeFlashcards(nlTopic, JSON.stringify([{ front: 'het huiswerk', back: 'домашнее задание',
        say: [{ at: 'het huiswerk', text: 'het huiswerk', lang: 'nl', voices: 2 }, { at: 'домашнее задание', text: 'домашнее задание', lang: 'nl' }] }]));
    eq('a Dutch course: the good mark is stored, the Russian one dropped',
        JSON.parse(sayOf(out.ids[0])), [{ at: 'het huiswerk', text: 'het huiswerk', voices: 2 }]);
    out = await finalizeFlashcards(nlTopic, JSON.stringify([{ front: 'de school', back: 'школа', say: [{ at: 'het huis', text: 'het huis' }] }]));
    eq('every mark wrong: the card is saved, unmarked', [out.count, sayOf(out.ids[0])], [1, null]);
    out = await finalizeFlashcards(nlTopic, JSON.stringify([{ front: 'de les', back: 'урок' }]));
    eq('no marks written: the card is saved, unmarked', [out.count, sayOf(out.ids[0])], [1, null]);
    out = await finalizeFlashcards(noLangTopic, JSON.stringify([{ front: 'photosynthesis', back: 'light to sugar', say: [{ at: 'photosynthesis', text: 'photosynthesis' }] }]));
    eq('a course that teaches no language stores no marks', sayOf(out.ids[0]), null);

    // -----------------------------------------------------------------------
    section('a course file carries the marks in and out');
    const fileProject = { name: 'File course', content_language: 'ru', learning_language: 'nl' };
    const fileNodes = () => [{
        title: 'Topic', flashcards: [
            { front: 'de pijn (боль)', back: 'боль', extra: 'Voorbeeld: Ik heb pijn.',
                say: [{ at: 'de pijn (боль)', text: 'de pijn', voices: 2 }, { at: 'Voorbeeld: Ik heb pijn.', text: 'Ik heb pijn.' }, { at: 'боль', text: 'боль' }],
                media: { front: [{ name: 'pijn.mp3', kind: 'audio', at: 'de pijn (боль)', say: 'de pijn' }] } },
            { front: 'het huis', back: 'дом', say: [] },
            { front: 'de stoel', back: 'стул' },
        ],
    }];
    const header = normalizeImportProject(fileProject, { isSupportedLanguage });
    const tree = normalizeImportTree(fileNodes(), { ...IMPORT_QUESTION_DEPS, learningLanguage: header.project.learning_language });
    const cards = tree.nodes[0].flashcards;
    eq('import keeps the good marks of a card', cards[0].say, [
        { at: 'de pijn (боль)', text: 'de pijn', voices: 2 }, { at: 'Voorbeeld: Ik heb pijn.', text: 'Ik heb pijn.', voices: 1 }]);
    eq('...an empty list, and nothing on a card without one', [cards[1].say, 'say' in cards[2]], [[], false]);
    eq('...says once what it dropped', tree.warnings.filter(w => /speech mark/.test(w)).length, 1);
    eq('...and a recording keeps the words it says', cards[0].media.front[0].say, 'de pijn');
    const untaught = normalizeImportTree(fileNodes(), IMPORT_QUESTION_DEPS);
    eq('a file whose course teaches no language imports no marks', untaught.nodes[0].flashcards.map(c => 'say' in c), [false, false, false]);
    // So every door must hand the file's language over, or its marks vanish there.
    const doors = [];
    for (const f of readdirSync(join(ROOT, 'server')).map(n => `server/${n}`).concat(readdirSync(join(ROOT, 'server/routes')).map(n => `server/routes/${n}`))) {
        if (!f.endsWith('.js') || f === 'server/curriculumSchema.js') continue;
        for (const call of readFileSync(join(ROOT, f), 'utf8').match(/normalizeImportTree\([^\n]*/g) ?? []) doors.push([f, /learningLanguage:/.test(call)]);
    }
    eq('every importer passes the file\'s learned language (bundle, plain file, course update)',
        doors.filter(([, passes]) => !passes).map(([f]) => f), []);
    eq('...and there are three doors', doors.length, 3);

    const importedId = Number(db.prepare('INSERT INTO projects (name, description, content_language, learning_language) VALUES (?, ?, ?, ?)')
        .run('File course', '', 'ru', 'nl').lastInsertRowid);
    insertImportedTree(importedId, tree.nodes);
    recordInstalledBase(importedId);
    const nodeId = db.prepare('SELECT id FROM nodes WHERE project_id = ?').get(importedId).id;
    const exported = exportedFlashcards(nodeId);
    eq('export writes the marks back as they were imported', exported.map(c => c.say ?? null), [cards[0].say, [], null]);

    // -----------------------------------------------------------------------
    section('a newer edition adds marks to a course installed before them');
    // A course installed before marks existed: its base names no `say` field.
    const oldId = Number(db.prepare('INSERT INTO projects (name, description, content_language, learning_language) VALUES (?, ?, ?, ?)')
        .run('Old course', '', 'ru', 'nl').lastInsertRowid);
    const plainTree = normalizeImportTree(fileNodes().map(n => ({ ...n, flashcards: n.flashcards.map(({ say, ...c }) => c) })), IMPORT_QUESTION_DEPS);
    insertImportedTree(oldId, plainTree.nodes);
    recordInstalledBase(oldId);
    db.prepare("DELETE FROM course_base WHERE project_id = ? AND field = 'say'").run(oldId);
    const oldUuids = db.prepare('SELECT f.uuid FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ? ORDER BY f.id').all(oldId).map(x => x.uuid);
    const edition = fileNodes();
    edition[0].uuid = db.prepare('SELECT uuid FROM nodes WHERE project_id = ?').get(oldId).uuid;
    edition[0].flashcards.forEach((c, i) => { c.uuid = oldUuids[i]; });
    const editionTree = normalizeImportTree(edition, { ...IMPORT_QUESTION_DEPS, learningLanguage: 'nl' });
    const plan = planCourseUpdate({
        upstream: readFileCourse(header.project, editionTree.nodes),
        local: readInstalledCourse(oldId),
        base: readBase(oldId),
    });
    eq('no question for the learner: the marks are new, not a disagreement', plan.conflicts.map(c => c.field), []);
    applyCourseUpdate(oldId, plan);
    const oldSay = db.prepare('SELECT f.say FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ? ORDER BY f.id').all(oldId).map(x => x.say && JSON.parse(x.say));
    eq('the update writes the edition\'s marks', oldSay, [cards[0].say, [], null]);
    const again = planCourseUpdate({ upstream: readFileCourse(header.project, editionTree.nodes), local: readInstalledCourse(oldId), base: readBase(oldId) });
    eq('...and the same file again plans nothing', again.ops.filter(o => o.op === 'update').length, 0);

    // -----------------------------------------------------------------------
    section('a learner\'s edit keeps only the marks still true of the new text');
    const cardId = db.prepare('SELECT f.id FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ? ORDER BY f.id').get(importedId).id;
    const say = () => db.prepare('SELECT say FROM flashcards WHERE id = ?').get(cardId).say;
    writeCard(cardId, { back: 'боль, страдание' });
    eq('the translation edited: both Dutch marks stay', JSON.parse(say()).map(m => m.text), ['de pijn', 'Ik heb pijn.']);
    writeCard(cardId, { extra: 'Voorbeeld: Mijn rug doet pijn.' });
    eq('the example rewritten: its mark goes, the word\'s stays', JSON.parse(say()).map(m => m.text), ['de pijn']);
    writeCard(cardId, { front: 'de rugpijn (боль в спине)' });
    eq('the word rewritten too: no mark is left, the rules read the card', say(), null);
} finally {
    try { db.close(); } catch { /* already closed */ }
    rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
