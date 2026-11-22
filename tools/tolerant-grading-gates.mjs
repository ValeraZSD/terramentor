// tools/tolerant-grading-gates.mjs — a typed answer with a spelling slip.
//
// A learner with dyslexia, dysgraphia or a second-language keyboard can switch
// on `forgive_spelling`: a fill-in answer a letter off a long word is then
// marked right, and the verdict shows the spelling it should have had. What can
// go wrong, and what this suite catches:
//
//   * the slip forgiven with the setting OFF (the default): spelling is the
//     skill in a language course, so off must stay exact;
//   * a different word marked right: short words (een/één, than/then), a
//     changed first letter (affect/effect) and any number (1984/1985) are
//     never forgiven, and a missing or extra word is not a slip;
//   * the client and the server disagreeing: the client grades the feed and
//     the quiz, the server grades an agent's sitting, so one table runs
//     through both;
//   * a forgiven answer shown as plain "Correct", so the slip is learned:
//     both verdict margins carry the spelling note;
//   * the setting not reaching the graders or not writable from Settings.
//
// No model, no network: the graders are pure, the rest is read from source.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'tolerant-grading-gates-'));
// The server modules open the library on import: a scratch one, never the real.
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
    if (ok) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

const server = await import(pathToFileURL(join(repoRoot, 'server/answerFormats.js')).href);

// The client grader reads the setting from the store by default; the stub
// answers OFF, which is also what a learner who never touched it has, until a
// check below turns it on (globalThis.__forgiveSpelling).
const stub = join(scratch, 'stub.js');
writeFileSync(stub, 'export const api = new Proxy({}, { get: () => () => { throw new Error("no network in a gate"); } });\nexport const k = (s) => s;\nexport default {};\n');
const storeStub = join(scratch, 'store-stub.js');
writeFileSync(storeStub, 'export const useStore = { getState: () => ({ codeRunner: false, forgiveSpelling: globalThis.__forgiveSpelling === true }) };\n');
const outfile = join(scratch, 'grading.mjs');
await esbuild.build({
    entryPoints: [join(repoRoot, 'src/utils/grading.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
    plugins: [{
        name: 'stub-runtime',
        setup(build) {
            build.onResolve({ filter: /(^|\/)(api|i18n)$/ }, () => ({ path: stub }));
            build.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: storeStub }));
        },
    }],
});
const client = await import(pathToFileURL(outfile).href);
const formatsOut = join(scratch, 'formats.mjs');
await esbuild.build({
    entryPoints: [join(repoRoot, 'src/components/answer/formats.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: formatsOut, logLevel: 'silent',
    plugins: [{ name: 'stub-i18n', setup(build) { build.onResolve({ filter: /(^|\/)i18n$/ }, () => ({ path: stub })); } }],
});
const clientFormats = await import(pathToFileURL(formatsOut).href);

const fill = (correct_answer, accept) => ({ type: 'fill_in', question: 'Fill the gap: ___', correct_answer, ...(accept ? { accept } : {}) });

// [label, question, answer, verdict with the setting off, verdict with it on]
const TABLE = [
    ['an exact answer is right either way', fill('photosynthesis'), 'Photosynthesis', true, true],
    ['one letter dropped from a long word', fill('photosynthesis'), 'photosynthsis', false, true],
    ['two slips in a word of nine or more (a dropped h, a doubled s)', fill('photosynthesis'), 'photossyntesis', false, true],
    ['three slips is not a slip', fill('photosynthesis'), 'phtossyntesis', false, false],
    ['a doubled letter (neccessary)', fill('necessary'), 'neccessary', false, true],
    ['a letter changed into another is a different word: chlorine is not chloride', fill('chlorine'), 'chloride', false, false],
    ['...sulfate is not sulfite', fill('sulfate'), 'sulfite', false, false],
    ['...alkane is not alkene', fill('alkane'), 'alkene', false, false],
    ['...hypothermia is not hyperthermia', fill('hypothermia'), 'hyperthermia', false, false],
    ['...exothermic is not endothermic', fill('exothermic'), 'endothermic', false, false],
    // Nine letters and up have two edits to spend: a letter dropped beside one
    // added is still a changed letter, and two dropped side by side a run gone.
    ['...hypothesis is not hypotheses (a drop beside an add)', fill('hypothesis'), 'hypotheses', false, false],
    ['...nucleotide is not nucleoside', fill('nucleotide'), 'nucleoside', false, false],
    ['...phosphate is not phosphite', fill('phosphate'), 'phosphite', false, false],
    ['...absorption is not adsorption', fill('absorption'), 'adsorption', false, false],
    ['...anaerobic is not aerobic (two letters gone side by side)', fill('anaerobic'), 'aerobic', false, false],
    ['a script without spaces is never forgiven: one dropped sign can be its "not"', fill('我们今天不去学校上课'), '我们今天去学校上课', false, false],
    ['...nor a long Japanese phrase', fill('ひかりごうせいのしくみ'), 'ひかりごせいのしくみ', false, false],
    ['two slips with a kept letter between them still count (necessarry)', fill('unnecessary'), 'unecessarry', false, true],
    ['a different ending is a different form: gebruik is not gebruikt', fill('gebruik'), 'gebruikt', false, false],
    ['...sulfate is not sulfates', fill('sulfate'), 'sulfates', false, false],
    ['...mitochondrion is not mitochondria', fill('mitochondrion'), 'mitochondria', false, false],
    ['two neighbours swapped (recieve) is one slip', fill('receive'), 'recieve', false, true],
    ['two letters off a word under nine is not a slip', fill('receive'), 'recevi', false, false],
    ['a short word is spelled exactly: een is not één', fill('één'), 'een', false, false],
    ['a four-letter word gets nothing: from is not form', fill('from'), 'form', false, false],
    ['a changed first letter is another word: affect is not effect', fill('effect'), 'affect', false, false],
    ['a dropped first letter is not a slip: neumonia', fill('pneumonia'), 'neumonia', false, false],
    ['a number is never forgiven: 1984 is not 1985', fill('1985'), '1984', false, false],
    ['a word holding a digit is a code, never forgiven', fill('h2so4x'), 'h2so5x', false, false],
    ['an accent off a five-letter word is a slip', fill('zoals'), 'zoáls', false, true],
    ['each word of the key gets its own budget', fill('the mitochondria'), 'the mitocondria', false, true],
    ['a short word inside a phrase is still exact', fill('de kat'), 'de kta', false, false],
    ['a missing word is not a slip', fill('the mitochondria'), 'mitochondria', false, false],
    ['an extra word is not a slip', fill('mitochondria'), 'the mitochondria', false, false],
    ['a slip from a declared variant counts', fill('colour', ['color']), 'colr', false, true],
    ['an empty box is wrong', fill('photosynthesis'), '   ', false, false],
    ['case and punctuation were never graded', fill("don't"), 'DONT', true, true],
];

section('one table, both graders, setting off and on');
for (const [label, q, answer, off, on] of TABLE) {
    const s0 = server.gradeLocally(q, answer);
    const s1 = server.gradeLocally(q, answer, { forgiveSpelling: true });
    const c0 = client.gradeLocally(q, answer);
    const c1 = client.gradeLocally(q, answer, { forgiveSpelling: true });
    check(`${label}: off ${off}, on ${on}`,
        s0 === off && s1 === on && c0 === off && c1 === on,
        `server ${s0}/${s1}, client ${c0}/${c1}`);
}

section('what the verdict shows');
check('the slip names the spelling as the author wrote it (capital and all)',
    server.spellingSlipOf(fill('Photosynthesis'), 'photosynthsis') === 'Photosynthesis');
check('...from the variant the slip came from',
    server.spellingSlipOf(fill('colour', ['color']), 'colr') === 'color');
check('an exact answer is no slip, so no note',
    server.spellingSlipOf(fill('receive'), 'Receive') === null);
check('a wrong answer is no slip either', server.spellingSlipOf(fill('effect'), 'affect') === null);
check('only fill-in has slips: a short answer goes to the checker as before',
    server.spellingSlipOf({ type: 'short_answer', correct_answer: 'photosynthesis' }, 'photosynthsis') === null
    && server.gradeLocally({ type: 'short_answer', correct_answer: 'x' }, 'x', { forgiveSpelling: true }) === null);
check('a number keeps its own tolerance, untouched by the setting',
    server.gradeLocally({ type: 'numeric', correct_answer: '9.81', tolerance: 0.01 }, '9.8', { forgiveSpelling: true }) === true
    && server.gradeLocally({ type: 'numeric', correct_answer: '9.81', tolerance: 0.001 }, '9.8', { forgiveSpelling: true }) === false);
check('the slip budget: nothing under five letters, one to eight, two from nine',
    [1, 4, 5, 8, 9, 20].map(server.slipBudget).join() === '0,0,1,1,2,2');
const disagree = TABLE.filter(([, q, a]) => server.spellingSlipOf(q, a) !== clientFormats.spellingSlipOf(q, a));
check('the client names the same spelling as the server on every row', disagree.length === 0,
    disagree.map(([label]) => label).join('; '));
check('...and the same budget', [1, 4, 5, 8, 9, 20].map(clientFormats.slipBudget).join() === '0,0,1,1,2,2');

section('the setting reaches the graders and the screen');
const { SETTINGS, SETTING_SCOPES } = await import(pathToFileURL(join(repoRoot, 'server/settingsSchema.js')).href);
check('forgive_spelling is a client-writable setting of the library',
    SETTINGS.forgive_spelling?.writable === 'client' && SETTING_SCOPES.library.includes('forgive_spelling'));
check('...that accepts on and off and nothing else',
    (() => { try { SETTINGS.forgive_spelling.validate('maybe'); return false; } catch { return true; } })());
check('the client lists it as a key a screen may write', read('src/settingKeys.ts').includes("'forgive_spelling'"));
const store = read('src/store.ts');
check('the store starts with it OFF and reads it as on only when stored on',
    /forgiveSpelling: false,/.test(store) && store.includes("settings.forgive_spelling === 'on'"));
{
    // Called with no option, as the answer screens call it: the store decides.
    const q = fill('photosynthesis');
    globalThis.__forgiveSpelling = true;
    const on = client.gradeLocally(q, 'photosynthsis');
    globalThis.__forgiveSpelling = false;
    const off = client.gradeLocally(q, 'photosynthsis');
    check('the client grader follows the store when not told: a slip is right with it on, wrong with it off', on === true && off === false, `on ${on}, off ${off}`);
}
const sittings = read('server/agentSittings.js');
check("an agent's sitting is graded under the same setting, read once per sitting",
    sittings.includes("const forgiveSpelling = getSetting('forgive_spelling', 'off') === 'on';")
    && sittings.includes('gradeLocally(q, answer, { forgiveSpelling })')
    && /gradeOne\(d\.question, answers\[i\], \{ form: s\.form, forgiveSpelling, nodeId: s\.nodeId \}\)/.test(sittings));
check('Settings → Learning has the switch', read('src/components/settings/LearningSettings.tsx').includes('setting-forgive-spelling'));
check('the line under a fill-in box says slips are forgiven only while they are',
    /forgiven/.test(clientFormats.answerHint(fill('x'), true)) && /Spelling counts/.test(clientFormats.answerHint(fill('x'), false))
    && clientFormats.answerHint({ type: 'short_answer' }, true) === clientFormats.answerHint({ type: 'short_answer' }, false));
const hintReaders = ['src/components/feed/InlineQuestion.tsx', 'src/components/QuizView.tsx', 'src/components/MasteryGateModal.tsx']
    .filter(p => /formatOf\([^)]*\)\.hint|format\.hint/.test(read(p)) || !/answerHint\(/.test(read(p)));
check('every answer screen reads the hint through answerHint, never the plain one', hintReaders.length === 0, hintReaders.join(', '));
check('the feed verdict shows the spelling note', /final\.correct && <SpellingNote/.test(read('src/components/feed/InlineQuestion.tsx')));
check('the quiz and check review show it too', /correct && answer && <SpellingNote/.test(read('src/components/answer/AnswerReviewItem.tsx')));

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
