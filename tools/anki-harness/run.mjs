// Headless verification of the Anki import preview step.
//
// The preview used to stack three full-size sample cards (each with audio
// buttons and a picture) above three native checkboxes, which put the actual
// decisions a page and a half below the fold. It now shows ONE sample with a
// stepper and draws its own option rows. That is new UI, and new UI here gets
// looked at rather than assumed — jsdom, behaviour, never pixels.
//
// Run:  node tools/anki-harness/run.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// jsdom is a devDependency, so a plain clone can run this. HARNESS_MODULES stays
// supported for an out-of-tree scratch install (how this ran before it shipped).
const SCRATCH = process.env.HARNESS_MODULES;
const jsdomSpecifier = SCRATCH ? SCRATCH + '/jsdom' : 'jsdom';
const { JSDOM } = require(jsdomSpecifier);

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const dom = new JSDOM('<!doctype html><html><body><div id="root" style="width:900px;height:600px"></div></body></html>', {
    pretendToBeVisual: true, url: 'http://localhost/',
});
const { window } = dom;
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'DOMParser', 'File', 'Blob', 'XMLSerializer']) {
    try { globalThis[k] = window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = window.matchMedia || (q => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } }));

// A deck shaped like a real vocabulary import: three samples, each carrying two
// clips and a picture — the exact payload that made the old screen unusable.
const mkSample = (front, back) => ({
    front, back, extra: 'ふるい\n犬がしっぽを振っている。',
    media: {
        front: [],
        back: [
            { hash: 'a1', kind: 'audio', name: 'word.mp3' },
            { hash: 'a2', kind: 'audio', name: 'sentence.mp3' },
            { hash: 'i1', kind: 'image', name: 'picture.webp' },
        ],
    },
});
const preview = {
    stagingId: 'stg1',
    suggestedName: 'Core 2k',
    warnings: [],
    samples: [mkSample('早い', 'early'), mkSample('振る', 'wave, shake'), mkSample('解く', 'to solve')],
    stats: {
        cards: 1501, skipped: 0, skipReasons: {},
        decks: [{ name: 'Core 2k', count: 1501, stages: 30 }],
        mediaFiles: 4345, mediaImages: 1379, mediaSounds: 2966, mediaBytes: 116 * 1024 * 1024,
    },
};

const calls = [];
const store = {
    addToast: (...a) => calls.push(['toast', ...a]),
    consumeAnkiImportFile: () => null,
    loadProjects: async () => { },
    openProject: () => { },
};

await require('esbuild').build({
    entryPoints: [join(here, 'entry.tsx')],
    bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic',
    outfile: join(here, 'bundle.cjs'), logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"development"' },
    // Styling is not what this checks — and KaTeX's stylesheet drags in font
    // binaries esbuild has no loader for.
    loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
    plugins: [{
        name: 'stubs',
        setup(build) {
            build.onResolve({ filter: /\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }));
            build.onResolve({ filter: /\/api$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
            build.onLoad({ filter: /^store-stub$/, namespace: 'stub' }, () => ({
                contents: `export const useStore = (sel) => sel(globalThis.__store);`, loader: 'js',
            }));
            build.onLoad({ filter: /^api-stub$/, namespace: 'stub' }, () => ({
                contents: `export const api = {
                    inspectAnkiDeck: async () => globalThis.__preview,
                    cancelAnkiImport: async () => {},
                    commitAnkiImport: async (opts) => { globalThis.__calls.push(['commit', opts]); return { projectId: 3, name: opts.projectName, imported: 1501, skipped: 0, stages: 30 }; },
                    deleteProject: async () => {},
                };`,
                loader: 'js',
            }));
        },
    }],
});

globalThis.__store = store;
globalThis.__calls = calls;
globalThis.__preview = preview;
require('./bundle.cjs');

const act = globalThis.__act;
const root = globalThis.__mount(window.document.getElementById('root'));

const $$ = (sel) => [...window.document.querySelectorAll(sel)];
const byText = (sel, text) => $$(sel).find(e => {
    const t = (e.textContent || '').trim();
    return text instanceof RegExp ? text.test(t) : t.includes(text);
});
const click = (el) => act(() => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const text = () => window.document.body.textContent || '';

console.log('\n--- the deck opens on a dropzone, no options ---');
check('the dropzone renders', !!byText('p', 'Drop your .apkg here'), true);
check('no checkbox is asked for before there is a preview', $$('input[type=checkbox]').length, 0);

// Drive a real file drop through the hidden input.
const input = window.document.querySelector('input[type=file]');
const file = new window.File([new Uint8Array([1, 2, 3])], 'deck.apkg');
Object.defineProperty(input, 'files', { value: [file], configurable: true });
await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
});

console.log('\n--- the preview shows ONE example, not three ---');
// The separator is the READER's preference now (Settings -> General -> Numbers,
// default: the interface language), so the number this renders with is not the
// one the machine running the tests would have produced. Asserting
// `(1501).toLocaleString()` made this test pass or fail on the OS's regional
// settings — which is the exact coupling the preference was built to remove.
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '[.,  ]?');
const CARDS = new RegExp(`${grouped(1501)} cards`);
check('the deck size is stated', CARDS.test(text()), true);
const cards = () => $$('[data-testid="anki-sample"]');
check('exactly one sample card is on screen', cards().length, 1);
check('it is the first one', cards()[0].textContent.includes('早い'), true);
check('the picture is capped at the preview size',
    $$('img').every(i => i.className.includes('max-h-32')), true);
check('both sides are labelled, so "wrong way round" is answerable',
    ['Question', 'Answer'].every(w => cards()[0].textContent.includes(w)), true);

console.log('\n--- stepping through the other examples ---');
check('the counter says where you are', !!byText('span', '1 / 3'), true);
const next = window.document.querySelector('button[aria-label="Next example"]');
const prev = window.document.querySelector('button[aria-label="Previous example"]');
check('there are stepper controls', !!next && !!prev, true);
click(next);
check('next moves to the second card', cards()[0].textContent.includes('振る'), true);
check('...and the counter follows', !!byText('span', '2 / 3'), true);
click(prev); click(prev);
check('previous wraps round rather than dead-ending', cards()[0].textContent.includes('解く'), true);
check('still exactly one card', cards().length, 1);

console.log('\n--- swap is under the card it changes ---');
const swapBtn = byText('button', 'Swap front/back');
check('the swap control renders', !!swapBtn, true);
check('and reports its state to assistive tech', swapBtn.getAttribute('aria-pressed'), 'false');
click(swapBtn);
check('swapping flips the visible card', cards()[0].textContent.indexOf('to solve') < cards()[0].textContent.indexOf('解く'), true);
check('the control says it is on', !!byText('button', 'Swapped'), true);
click(byText('button', 'Swapped'));

console.log('\n--- the options are real inputs behind drawn boxes ---');
const boxes = () => $$('input[type=checkbox]');
check('two options', boxes().length, 2);
check('they are sr-only (focusable), not hidden or bare browser widgets',
    boxes().every(b => b.className.includes('sr-only')), true);
check('none of them is left as an unstyled native box',
    boxes().every(b => !b.className.includes('accent-accent')), true);
check('each sits in its own label, so the whole row is the hit target',
    boxes().every(b => b.closest('label')), true);
check('media is on by default', boxes()[0].checked, true);
check('schedule is on by default', boxes()[1].checked, true);
check('the drawn box shows a tick when checked',
    !!boxes()[0].closest('label').querySelector('svg'), true);
click(boxes()[0]);
check('unticking works', boxes()[0].checked, false);
check('...and the drawn tick goes away',
    !!boxes()[0].closest('label').querySelector('span[aria-hidden="true"] svg'), false);
click(boxes()[0]);

console.log('\n--- the commit is pinned, and says what it will do ---');
const commit = byText('button', CARDS);
check('the button carries the number', !!commit, true);
check('it is in a sticky footer', commit.closest('div.sticky') !== null, true);
check('the undo promise is made before the click',
    text().includes('You can undo it in one click'), true);
click(commit);
await new Promise(r => setTimeout(r, 20));
const commitCall = calls.find(c => c[0] === 'commit');
check('the import was requested with the choices made', commitCall[1], {
    stagingId: 'stg1', projectName: 'Core 2k', swapFrontBack: false,
    keepSchedule: true, includeMedia: true,
});

act(() => root.unmount());
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
