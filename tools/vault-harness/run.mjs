// Headless verification of the bundle-export options popover.
//
// The export is a two-step (open options, then export) because a single click
// would ship the learner's private notes by default. This is the jsdom route
// (the browser pane is not displaying here): behaviour, never pixels.
//
// Run:  node tools/vault-harness/run.mjs

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
    'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    // Node 24 defines `navigator` as a getter-only global, so assignment throws.
    try { globalThis[k] = window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = window.matchMedia || (q => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } }));
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => { };

// The one thing under test is what the component ASKS FOR, so the API call is
// recorded rather than performed.
const calls = [];
const store = {
    currentProjectId: 7,
    projects: [{ id: 7, name: 'Wave Optics', color: '#4F46E5', icon: 'book' }],
    addToast: (...a) => calls.push(['toast', ...a]),
};

await require('esbuild').build({
    entryPoints: [join(here, 'entry.tsx')],
    bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic',
    outfile: join(here, 'bundle.cjs'), logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{
        name: 'stubs',
        setup(build) {
            // Stub the store and api so this exercises the component, not the app.
            build.onResolve({ filter: /\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }));
            build.onResolve({ filter: /\/api$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
            build.onResolve({ filter: /VaultPanel$/ }, () => ({ path: 'panel-stub', namespace: 'stub' }));
            build.onLoad({ filter: /^store-stub$/, namespace: 'stub' }, () => ({
                contents: `export const useStore = (sel) => sel(globalThis.__store);`, loader: 'js',
            }));
            build.onLoad({ filter: /^api-stub$/, namespace: 'stub' }, () => ({
                contents: `export const api = { exportBundle: async (id, opts) => { globalThis.__calls.push(['exportBundle', id, opts]); return { blob: new Blob(['x']), filename: 'x.studyvault' }; } };`,
                loader: 'js',
            }));
            build.onLoad({ filter: /^panel-stub$/, namespace: 'stub' }, () => ({
                contents: `import * as React from 'react'; export default function VaultPanel(){ return React.createElement('div',{'data-testid':'vault-panel'}); }`,
                loader: 'jsx', resolveDir: here,
            }));
        },
    }],
});

globalThis.__store = store;
globalThis.__calls = calls;
globalThis.Blob = window.Blob;
require('./bundle.cjs');

const act = globalThis.__act;
const root = globalThis.__mount(window.document.getElementById('root'));

const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => [...window.document.querySelectorAll(sel)];
const byText = (sel, text) => $$(sel).find(e => (e.textContent || '').trim().includes(text));
const click = (el) => act(() => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));

console.log('\n--- the export button no longer exports in one click ---');
const button = byText('button', 'Export bundle');
check('the Export bundle button renders', !!button, true);
check('nothing is exported before the options are seen', calls.length, 0);
check('the options panel is closed at rest', !!byText('p', 'Choose what else to add'), false);
check('and it says so for assistive tech', button.getAttribute('aria-expanded'), 'false');

console.log('\n--- opening the options ---');
click(button);
check('the panel opens', !!byText('p', 'Choose what else to add'), true);
check('aria-expanded follows', button.getAttribute('aria-expanded'), 'true');
const boxes = $$('input[type=checkbox]');
check('both options are real checkboxes', boxes.length, 2);
// The whole point of the change: private notes must start OFF.
check('private notes default to OFF', boxes[0].checked, false);
check('progress defaults to OFF', boxes[1].checked, false);
check('the notes option warns about sharing',
    !!byText('span', 'leave off when sharing'), true);

console.log('\n--- the checkboxes are reachable, not decorative ---');
// They are visually hidden (`sr-only`) behind a styled div, which is how the
// rest of this app draws checkboxes — but sr-only keeps them focusable, unlike
// the `hidden` the older modal used.
check('the inputs are sr-only, not display:none (still focusable)',
    boxes.every(b => b.className.includes('sr-only')), true);
check('each input sits inside its own label, so the whole row is a hit target',
    boxes.every(b => b.closest('label')), true);

console.log('\n--- what the component actually asks the server for ---');
// Drive it as a real click. Pre-setting `.checked` and THEN dispatching is the
// classic jsdom trap: the click toggles the value back, so React's handler sees
// the opposite of what the test meant.
click(boxes[0]);
check('ticking private notes takes effect', $$('input[type=checkbox]')[0].checked, true);

const exportBtn = $$('button').find(b => (b.textContent || '').trim() === 'Export');
check('the panel has its own Export button', !!exportBtn, true);
click(exportBtn);
await new Promise(r => setTimeout(r, 20));

const exportCall = calls.find(c => c[0] === 'exportBundle');
check('export was requested', !!exportCall, true);
check('...for the current project', exportCall[1], 7);
check('...carrying the explicit flags (not the old no-argument call)',
    exportCall[2], { includeNotes: true, includeProgress: false });

console.log('\n--- and it closes itself afterwards ---');
check('the panel closed on export', !!byText('p', 'Choose what else to add'), false);

console.log('\n--- the choice is sticky, and VISIBLY so ---');
// Reopening keeps the previous tick. That is fine precisely because the box is
// drawn ticked — the panel always shows what the next export will actually do,
// which is the property that matters for an opt-in.
click(byText('button', 'Export bundle'));
check('the earlier tick is still shown', $$('input[type=checkbox]')[0].checked, true);
click($$('input[type=checkbox]')[0]);
check('unticking works', $$('input[type=checkbox]')[0].checked, false);
click($$('button').find(b => (b.textContent || '').trim() === 'Export'));
await new Promise(r => setTimeout(r, 20));
const second = calls.filter(c => c[0] === 'exportBundle')[1];
check('...and an untick really opts back out',
    second[2], { includeNotes: false, includeProgress: false });

act(() => root.unmount());
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
