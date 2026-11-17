// Headless verification of the Anki import preview step.
//
// The preview shows ONE sample card with a stepper and draws its own option
// rows, so the actual decisions are not pushed below the fold by a stack of
// full-size samples. UI like this is looked at rather than assumed — jsdom,
// behaviour, never pixels.
//
// Run:  node tools/anki-harness/run.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// jsdom is a devDependency, so a plain clone can run this. HARNESS_MODULES stays
// supported for an out-of-tree scratch install.
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
                    // A case can hold the upload or the commit open, or make the
                    // next commit fail, the way a slow or restarted server would.
                    inspectAnkiDeck: async () => { await globalThis.__inspectHold; return globalThis.__preview; },
                    cancelAnkiImport: async (id) => { globalThis.__calls.push(['cancel', id]); },
                    commitAnkiImport: async (opts) => {
                        await globalThis.__commitHold;
                        if (globalThis.__commitFails) { globalThis.__commitFails = false; throw new Error(''); }
                        globalThis.__calls.push(['commit', opts]); return { projectId: 3, name: opts.projectName, imported: 1501, skipped: 0, stages: 30 }; },
                    deleteProject: async () => {},
                    // A preview picture with no alt looks up its stored description.
                    mediaInfo: async () => null,
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
// Every other count on the screen goes through the reader's number format; the
// deck list's own counts did not, so a big deck read "1501" beside "1,501".
check("the deck list writes a deck's count in the reader's number format",
    /1\D501/.test($$('details li')[0]?.textContent ?? ''), true);
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
check('they are transparent over the drawn box (focusable), not hidden or bare browser widgets',
    boxes().every(b => b.className.includes('opacity-0') && !/\bhidden\b/.test(b.className)), true);
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
// ui/Dialog: the footer row is a sibling of the scrolling body, never inside it.
check('it is in the pinned footer, outside the scroll',
    commit.closest('div.shrink-0.border-t') !== null && commit.closest('.overscroll-contain') === null, true);
check('the undo promise is made before the click',
    text().includes('You can undo it in one click'), true);
const wait = () => new Promise(r => setTimeout(r, 20));
globalThis.__commitFails = true;
click(commit);
await wait();
check('a failed import says so and stays on the preview',
    text().includes('The import could not be completed.') && !!byText('button', CARDS), true);
click(byText('button', CARDS));
await wait();
const commitCall = calls.find(c => c[0] === 'commit');
check('the import was requested with the choices made', commitCall[1], {
    stagingId: 'stg1', projectName: 'Core 2k', swapFrontBack: false,
    keepSchedule: true, includeMedia: true,
});
check('a retry that works does not leave the earlier failure on the done screen',
    text().includes('cards imported') && !text().includes('The import could not be completed.'), true);

console.log('\n--- closing never strands or loses a deck ---');
const dropFile = async () => {
    const inp = window.document.querySelector('input[type=file]');
    if (!inp) return;   // already on a preview: the check after this reports it
    Object.defineProperty(inp, 'files', { value: [new window.File([new Uint8Array([1])], 'deck.apkg')], configurable: true });
    await act(async () => { inp.dispatchEvent(new window.Event('change', { bubbles: true })); await wait(); });
};
const dialog = () => window.document.querySelector('[role="dialog"]');
const backdropEl = () => dialog().parentElement;
const closeBtn = () => window.document.querySelector('button[aria-label="Close"]');
// The done screen is left through its close button; the harness keeps the
// modal mounted open, so a close lands back on the dropzone.
click(closeBtn());
check('closing the done screen returns to the dropzone', !!byText('p', 'Drop your .apkg here'), true);

// Closing while the deck is still being read.
let release;
globalThis.__inspectHold = new Promise(r => { release = r; });
calls.length = 0;
await dropFile();
check('the deck is being read', !!byText('p', /Uploading|Reading your deck/), true);
click(closeBtn());
release(); globalThis.__inspectHold = null;
await act(async () => { await wait(); });
check('a deck that finishes reading after the dialog was closed does not reopen it on a preview',
    !!byText('p', 'Drop your .apkg here') && !text().includes('Import 1'), true);
check('...and its staged parse is released', calls.some(c => c[0] === 'cancel' && c[1] === 'stg1'), true);

// Selecting text and letting go over the backdrop is not a tap on it.
await dropFile();
check('a preview is open', !!byText('button', CARDS), true);
const nameInput = window.document.querySelector('label input:not([type=checkbox])');
act(() => nameInput.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
click(backdropEl());
check('a drag that starts inside the dialog and ends on the backdrop keeps it open', !!byText('button', CARDS), true);
act(() => backdropEl().dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
click(backdropEl());
check('a tap on the backdrop still closes it', !!byText('p', 'Drop your .apkg here'), true);

// Closing while the import itself runs.
await dropFile();
let finish;
globalThis.__commitHold = new Promise(r => { finish = r; });
click(byText('button', CARDS));
await wait();
check('the import is running', text().includes('Importing'), true);
click(closeBtn());
act(() => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
check('the X and Escape wait for a running import instead of closing on it', text().includes('Importing'), true);
finish(); globalThis.__commitHold = null;
await act(async () => { await wait(); });
check('the import then ends on its own done screen', text().includes('cards imported'), true);

act(() => root.unmount());
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
