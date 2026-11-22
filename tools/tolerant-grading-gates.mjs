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
    && /gradeOne\(d\.question, answers\[i\], \{ form: s\.form, forgiveSpelling \}\)/.test(sittings));
check('Settings → Learning has the switch', read('src/components/settings/LearningSettings.tsx').includes('setting-forgive-spelling'));
check('the line under a fill-in box says slips are forgiven only while they are',
    /forgiven/.test(clientFormats.answerHint(fill('x'), true)) && /Spelling counts/.test(clientFormats.answerHint(fill('x'), false))
    && clientFormats.answerHint({ type: 'short_answer' }, true) === clientFormats.answerHint({ type: 'short_answer' }, false));
const hintReaders = ['src/components/feed/InlineQuestion.tsx', 'src/components/QuizView.tsx', 'src/components/MasteryGateModal.tsx']
    .filter(p => /formatOf\([^)]*\)\.hint|format\.hint/.test(read(p)) || !/answerHint\(/.test(read(p)));
check('every answer screen reads the hint through answerHint, never the plain one', hintReaders.length === 0, hintReaders.join(', '));
check('the feed verdict shows the spelling note', /result\.correct && <SpellingNote/.test(read('src/components/feed/InlineQuestion.tsx')));
check('the quiz and check review show it too', /correct && answer && <SpellingNote/.test(read('src/components/answer/AnswerReviewItem.tsx')));

section('the headline over a forgiven slip');
check('a slip marked right is headed "Correct, with a spelling slip"',
    clientFormats.correctVerdict(fill('photosynthesis'), 'photosynthsis') === 'Correct, with a spelling slip');
check('...an exact answer plain "Correct"', clientFormats.correctVerdict(fill('photosynthesis'), 'Photosynthesis') === 'Correct');
const feedQuestion = read('src/components/feed/InlineQuestion.tsx');
check('the feed verdict and its spoken line both take that headline',
    /const correctLine = t\(correctVerdict\(question, result\?\.answer/.test(feedQuestion)
    && /result\.correct \? correctLine/.test(feedQuestion) && /shown === 'correct' \? correctLine/.test(feedQuestion));
check('...and the note under it then gives only the spelling', /<SpellingNote [^>]*headed/.test(feedQuestion));

// The real SpellingOffer and SpellingNote, mounted with React in jsdom; the
// store is a stub holding the three things they read.
section('the switch offered after a near miss');
{
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
    for (const key of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node', 'Text', 'MutationObserver', 'Event']) {
        try { globalThis[key] = dom.window[key]; } catch { /* read-only in this Node */ }
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const out = join(scratch, 'offer.cjs');
    await esbuild.build({
        stdin: {
            contents: `import React, { createElement as h } from 'react';
                import { createRoot } from 'react-dom/client';
                import i18n from 'i18next';
                import { initReactI18next } from 'react-i18next';
                import SpellingOffer from './src/components/answer/SpellingOffer';
                import SpellingNote from './src/components/answer/SpellingNote';
                export async function boot() { await i18n.use(initReactI18next).init({ lng: 'en', resources: {}, returnEmptyString: false }); }
                export function mount(el, which, props) {
                    const r = createRoot(el);
                    React.act(() => r.render(h(which === 'note' ? SpellingNote : SpellingOffer, props)));
                    return { unmount: () => React.act(() => r.unmount()) };
                }
                export const act = (fn) => React.act(fn);`,
            resolveDir: repoRoot, loader: 'js',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic', logLevel: 'silent',
        loader: { '.css': 'empty' },
        plugins: [{
            name: 'offer-under-test',
            setup(b) {
                b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub-store' }));
                // A store that re-renders on change, as zustand does: a save that fails
                // puts the setting back after the press, and the offer must follow it.
                b.onLoad({ filter: /.*/, namespace: 'stub-store' }, () => ({
                    contents: `import { useSyncExternalStore } from 'react';
                        const heard = new Set();
                        globalThis.__offerSet = (patch) => { globalThis.__offerState = { ...globalThis.__offerState, ...patch }; heard.forEach(l => l()); };
                        export const useStore = (sel) => useSyncExternalStore(l => { heard.add(l); return () => heard.delete(l); }, () => sel(globalThis.__offerState));`,
                    loader: 'js', resolveDir: repoRoot,
                }));
                b.onResolve({ filter: /(^|\/)i18n$/ }, (a) => (a.importer.includes('src') ? { path: stub } : undefined));
            },
        }],
    });
    const { boot, mount, act } = createRequire(import.meta.url)(out);
    await boot();
    const doc = dom.window.document;
    const turnedOn = [];
    const state = (over = {}) => {
        globalThis.__offerState = {
            forgiveSpelling: false,
            projects: [{ id: 1, learning_language: '' }, { id: 2, learning_language: 'nl' }],
            setForgiveSpelling: async (on) => { turnedOn.push(on); globalThis.__offerSet({ forgiveSpelling: on }); },
            ...over,
        };
    };
    const render = (which, props) => {
        const el = doc.createElement('div'); doc.body.appendChild(el);
        const m = mount(el, which, props);
        return { el, done: () => { m.unmount(); el.remove(); } };
    };
    const near = { question: fill('photosynthesis'), answer: 'photosynthsis', projectId: 1 };

    state();
    {
        const { el, done } = render('offer', near);
        const button = el.querySelector('[data-spelling-offer] button');
        check('switch off, a letter off: the line and its button are offered',
            !!button && /Only a letter or two off/.test(el.textContent) && /Forgive small spelling slips from now on/.test(button.textContent), el.innerHTML);
        check('...in a live region, as the report line beside it', el.querySelector('[data-spelling-offer]')?.getAttribute('aria-live') === 'polite');
        act(() => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
        check('pressing it turns the setting on', turnedOn.length === 1 && turnedOn[0] === true, JSON.stringify(turnedOn));
        check('...and the line then says what changed and where to undo it',
            el.querySelector('[data-spelling-offer="on"]') && /now count as right/.test(el.textContent) && /Settings, under Learning/.test(el.textContent) && !el.querySelector('button'), el.innerHTML);
        check('...and focus moves to that line, not to the page (the button left)',
            doc.activeElement === el.querySelector('[data-spelling-offer="on"]'), String(doc.activeElement?.outerHTML).slice(0, 120));
        done();
    }
    {
        // The write failed: the store puts the setting back and says so in a toast.
        // The put-back is run by hand inside a sync act: React's async act opens
        // a MessageChannel under esbuild that keeps this process alive.
        let putBack = null;
        state({
            setForgiveSpelling: async (on) => {
                globalThis.__offerSet({ forgiveSpelling: on });
                putBack = () => globalThis.__offerSet({ forgiveSpelling: false });
            },
        });
        const { el, done } = render('offer', near);
        const button = el.querySelector('[data-spelling-offer] button');
        act(() => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
        const shownWhileSaving = !!el.querySelector('[data-spelling-offer="on"]');
        act(() => putBack());
        check('while the save runs the line says it is on', shownWhileSaving, el.innerHTML);
        check('a save that failed: no "now count as right", the offer is back',
            !el.querySelector('[data-spelling-offer="on"]') && !!el.querySelector('[data-spelling-offer] button'), el.innerHTML);
        done();
    }
    state({ forgiveSpelling: true });
    { const { el, done } = render('offer', near); check('switch already on: nothing offered', el.innerHTML === '', el.innerHTML); done(); }
    state();
    { const { el, done } = render('offer', { ...near, answer: 'photosynthesys is a process' }); check('not a near miss: nothing offered', el.innerHTML === '', el.innerHTML); done(); }
    { const { el, done } = render('offer', { question: fill('chlorine'), answer: 'chloride', projectId: 1 }); check('...nor for a changed letter (chlorine typed as chloride)', el.innerHTML === ''); done(); }
    { const { el, done } = render('offer', { ...near, projectId: 2 }); check('a course that teaches a language: never offered, the spelling is the lesson', el.innerHTML === '', el.innerHTML); done(); }
    { const { el, done } = render('offer', { ...near, projectId: null }); check('no course known: nothing (it may be a language course)', el.innerHTML === '', el.innerHTML); done(); }
    state({ projects: [] });
    { const { el, done } = render('offer', near); check('...nor before the courses have loaded', el.innerHTML === '', el.innerHTML); done(); }
    state();
    { const { el, done } = render('offer', { question: { type: 'short_answer', correct_answer: 'photosynthesis' }, answer: 'photosynthsis', projectId: 1 }); check('a short answer (the checker ignores spelling already): nothing', el.innerHTML === ''); done(); }
    {
        const { el, done } = render('note', { question: fill('photosynthesis'), answer: 'photosynthsis', headed: true });
        check('under the headline the note gives only the spelling', /^It is spelled:\s*photosynthesis$/.test(el.textContent.trim()), el.textContent);
        done();
    }
    {
        const { el, done } = render('note', { question: fill('photosynthesis'), answer: 'photosynthsis' });
        check('...and the full sentence where no headline says it (the review list)', /^Accepted with a spelling slip/.test(el.textContent.trim()), el.textContent);
        done();
    }
    check('the feed offers it under a wrong verdict, not under "Not marked"',
        /!result\.correct && !result\.unsure && <SpellingOffer question=\{question\} answer=\{result\.answer\} projectId=\{projectId\}/.test(feedQuestion));
    check('the quiz and check review offer it under a wrong answer, never on a mock exam (graded strictly)',
        /!correct && answer && surface !== 'mock' && <SpellingOffer question=\{question\} answer=\{answer\} projectId=\{projectId\}/.test(read('src/components/answer/AnswerReviewItem.tsx')));
    check('...and the mock exam grades without the setting, so the line above stays needed',
        /gradeLocally\(safeParse\(part\.item\) \|\| \{\}, text\)/.test(read('server/mockExams.js')));
    // Every review mount names its course: the offer stays silent without one.
    for (const file of ['src/components/QuizView.tsx', 'src/components/MasteryGateModal.tsx', 'src/components/feed/SittingReviewView.tsx']) {
        const src = read(file);
        const at = src.indexOf('<AnswerReviewItem');
        const mount = src.slice(at, src.indexOf('/>', at));
        check(`${file.split('/').pop()} hands its review rows the course id`, /projectId=\{/.test(mount), mount.slice(0, 200));
    }
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
