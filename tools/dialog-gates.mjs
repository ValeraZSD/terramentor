// tools/dialog-gates.mjs — what a modal dialog owes the keyboard and a screen reader.
//
// Run:  node tools/dialog-gates.mjs          (the working tree)
//       node tools/dialog-gates.mjs --head   (Modal, ConfirmDialog, Toast and the source
//                                             halves as they were at HEAD, to watch the
//                                             cases fail on the pre-fix code)
//
// WHY. `Modal` was `role="dialog" aria-modal="true"` and nothing else. It had no
// name (a screen reader announced "dialog"), it did not move focus in (the
// button that opened it kept focus underneath), Tab and Shift+Tab walked out of
// it (Shift+Tab from "Close dialog" landed on "New Project" behind the overlay),
// focus was not given back when it closed, and a ConfirmDialog over a Modal
// closed BOTH on one Escape. Its neighbours had the same faults in smaller
// form: the workspace rail's inactive tabs and the schedule button were
// `display: none` at phone width, so four buttons were announced as nothing;
// toasts were not in any live region; and a toast with details was a
// `role="button"` wrapped round the dismiss button.
//
// The dialog cases MOUNT the real Modal and ConfirmDialog (the store is a
// twenty-line stub — the components only read a few fields) and press real
// keys; the rest are source scans of files too heavy to mount, each one written
// against the shape it replaced.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const HEAD = process.argv.includes('--head');
const read = (p) => HEAD
    ? execFileSync('git', ['show', `HEAD:${p}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// ---------------------------------------------------------------------------
section('the workspace rail keeps a name for every control at every width');
{
    const ws = read('src/components/Workspace.tsx');
    check('no label is `display: none` at phone width (hidden sm:inline)', !/hidden sm:inline/.test(ws),
        'a `display: none` label takes the accessible name away from a screen reader');
    check('the collapsed label is visually hidden, not removed (sr-only)', /sr-only sm:not-sr-only/.test(ws));
    check('the schedule button keeps its name too',
        /sr-only sm:not-sr-only[^>]*>\{hasSchedule \? tr\("Open plan"\)/.test(ws));
    check('the tab you are on says so: aria-current="page" (routes, not a half tab pattern)',
        // A screen opened from a tab (the mock exam, from the Dashboard) keeps
        // that tab current through `tabView`.
        /aria-current=\{(?:workspaceView|tabView) === tab\.key \? 'page' : undefined\}/.test(ws));
    check('and it does not claim role="tab" without the keys and panels that owes',
        !/role="tab(list)?"/.test(ws));
    check('the rail is a labelled nav', /<nav ref=\{tabRailRef\} aria-label=/.test(ws));
    // `IconButton`'s `label` IS its aria-label (and its title).
    check('the drawer button has a name beyond its title', /<IconButton\b(?:(?!<IconButton\b)[\s\S])*?\blabel=\{tr\("Open navigation"\)\}/.test(ws));
}

section('every overlay shares the counted scroll lock, and one Escape closes one dialog');
{
    // A hand-rolled overlay writing `body.style.overflow = ''` on close gave
    // the page its scroll back under a Modal still open beneath it.
    const overlays = ['src/components/completion/CompletionSummary.tsx', 'src/components/drills/DrillModal.tsx'];
    for (const p of overlays) {
        const src = read(p);
        // Directly, or through useDialogFocus, which takes the same counted lock.
        check(`${p.split('/').pop()}: locks the page through the shared counted lock, never overflow by hand`,
            (/lockScroll\(\)/.test(src) || /useDialogFocus\(/.test(src)) && !/body\.style\.overflow/.test(src));
    }
    // The Remove schedule confirm opens OVER the Schedule dialog; its Escape
    // must not also close the dialog beneath. The dialog stack guarantees that,
    // and the mounted case in
    // "the hand-rolled overlays" section below presses the key.
    const schedule = read('src/components/ScheduleModal.tsx');
    check('ScheduleModal leaves an Escape a dialog above it already took',
        /e\.key === 'Escape' && !e\.defaultPrevented/.test(schedule) || /useDialogFocus\(/.test(schedule));
}

section('one h1 on the Settings screen');
{
    const layout = read('src/components/Layout.tsx');
    const settings = read('src/components/Settings.tsx');
    const h1s = [...layout.matchAll(/<h1[\s\S]*?<\/h1>/g)].map(m => m[0]);
    check('the header names the workspace in an h1', h1s.length >= 1);
    check('and does not ALSO put "Settings" in one', !h1s.some(h => /t\("Settings"\)/.test(h)),
        'Layout and Settings both rendered a "Settings" h1');
    check('Settings owns the screen\'s h1', (settings.match(/<h1\b/g) ?? []).length === 1);
}

// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'MutationObserver']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
window.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = () => { };
for (const k of ['Event', 'File', 'SVGSVGElement', 'HTMLCanvasElement']) if (window[k]) globalThis[k] = window[k];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// A mouse-and-keyboard machine unless a case says otherwise: whether a form
// dialog focuses its first field depends on it (utils/platform.ts).
let finePointer = true;
window.matchMedia = (q) => ({ matches: q === '(pointer: fine)' ? finePointer : false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });

mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true });
const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'dialog-gates-'));
const out = join(scratch, 'bundle.cjs');
const headDir = join(scratch, 'head');
// Paths under src/components. The hand-rolled overlays are mounted beside
// Modal: each was converted to the same hook and is held to the same contract.
const files = ['Modal', 'ConfirmDialog', 'Toast',
    'ScheduleModal', 'AnkiImportModal', 'BulkGenerateModal', 'PlacementModal',
    'ReportProblemDialog', 'TaskDetailModal', 'TaskFailureModal', 'visuals/ExportVisualModal', 'drills/DrillModal',
    'SearchBar', 'MasteryGateModal', 'ExternalAuthoring', 'ModelPicker', 'settings/connections/AddConnectionDialog'];
if (HEAD) {
    for (const f of files) {
        mkdirSync(dirname(join(headDir, `${f}.tsx`)), { recursive: true });
        writeFileSync(join(headDir, `${f}.tsx`), read(`src/components/${f}.tsx`));
    }
}
const from = (f) => HEAD ? join(headDir, `${f}.tsx`).replace(/\\/g, '/') : `./src/components/${f}`;

const stubs = {
    // Every call with options is kept in `__tCalls`, for a case that needs to see
    // what a sentence was handed (a number the reader's style must have written).
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => { if (o) (globalThis.__tCalls ??= []).push([k, o]); return o && o.count != null ? k.replace('{{count}}', o.count) : k; }, i18n: { language: 'en' } });`,
    // The real helpers, with the four that make a file or reach the server
    // replaceable by a case (\`globalThis.__exp\`): jsdom cannot rasterise an SVG.
    'exportVisual': `import * as real from '${join(root, 'src/utils/exportVisual.ts').replace(/\\/g, '/')}';
        const pick = (name) => (...a) => (globalThis.__exp?.[name] ?? real[name])(...a);
        export const { captionFromBrief, gifDelayCs, gifFrameCount, fileSlug, findExportable, DEFAULT_GIF_FPS } = real;
        export const downloadBlob = pick('downloadBlob'), exportAnimationGif = pick('exportAnimationGif'),
            exportStillPng = pick('exportStillPng'), previewFrame = pick('previewFrame');`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    // The fields the components read, and a `hideConfirm` the gate supplies.
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: { a11y: { readAloud: false, speechRate: 100, readingLine: false, confirmAnswers: false, cardAudioAutoplay: true } }, subs: new Set() };
        g.__setState = (patch) => { g.__st.state = { ...g.__st.state, ...patch }; g.__st.subs.forEach(f => f()); };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;
        export const themeKeyOf = () => 'light';
        export const isDarkTheme = () => false;`,
    // Rendered text is not what a dialog's keyboard contract is about, and the
    // real renderers pull in the whole visuals stack.
    'Markdown': `import { createElement } from 'react'; export default function Markdown({ content }) { return createElement('div', null, content); }`,
    'codeLanguages': `import { createElement } from 'react'; export const highlightLanguage = (l) => l; export default function SyntaxHighlighter({ children }) { return createElement('pre', null, children); }`,
    // Every request stays pending unless a case answers it: a dialog is judged
    // on its first screen, never on what the server said.
    'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => (globalThis.__api?.[name] ?? (() => new Promise(() => { })))(...args) });
        let seq = 0; export const newAttemptId = () => 'attempt-' + (++seq);`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+utils\/exportVisual$/ }, () => ({ path: 'exportVisual', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*(Markdown|MathText)$/ }, () => ({ path: 'Markdown', namespace: 'stub' }));
        // The mastery check's answer key highlights code; the Prism registry it
        // loads does not survive a CJS bundle, and no case here shows code.
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*codeLanguages$/ }, () => ({ path: 'codeLanguages', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
        // A HEAD copy was written to the scratch dir, but its imports meant the
        // directory it came from.
        b.onResolve({ filter: /^\.\.?\// }, async (args) => {
            const imp = args.importer.replace(/\\/g, '/');
            const headRoot = headDir.replace(/\\/g, '/');
            if (!HEAD || !imp.startsWith(headRoot)) return undefined;
            const rel = dirname(imp.slice(headRoot.length + 1));
            return b.resolve(args.path, { resolveDir: join(root, 'src', 'components', rel), kind: args.kind });
        });
    },
};

await esbuild.build({
    stdin: {
        contents: `
            export { default as Modal } from '${from('Modal')}';
            export { default as ConfirmDialog } from '${from('ConfirmDialog')}';
            export { default as ToastContainer } from '${from('Toast')}';
            export { default as ScheduleModal } from '${from('ScheduleModal')}';
            export { default as AnkiImportModal } from '${from('AnkiImportModal')}';
            export { default as BulkGenerateModal } from '${from('BulkGenerateModal')}';
            export { default as PlacementModal } from '${from('PlacementModal')}';
            export { default as ReportProblemDialog } from '${from('ReportProblemDialog')}';
            export { default as TaskDetailModal } from '${from('TaskDetailModal')}';
            export { default as TaskFailureModal } from '${from('TaskFailureModal')}';
            export { default as ExportVisualModal } from '${from('visuals/ExportVisualModal')}';
            export { default as DrillModal } from '${from('drills/DrillModal')}';
            export { default as SearchBar } from '${from('SearchBar')}';
            export { default as MasteryGateModal } from '${from('MasteryGateModal')}';
            export { OutlineBriefPanel, MaterialPassPanel } from '${from('ExternalAuthoring')}';
            export { default as ModelPicker } from '${from('ModelPicker')}';
            export { default as AddConnectionDialog } from '${from('settings/connections/AddConnectionDialog')}';
            export { focusableIn } from './src/hooks/useDialogFocus';
            export { setNumberPreference } from './src/utils/numberFormat';`,
        resolveDir: root,
        loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out,
    jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
    packages: 'external',
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
    plugins: [stubPlugin],
    logLevel: 'silent',
});
const React = require('react');
const { createRoot } = require('react-dom/client');
const surfaces = require(out);
const { Modal, ConfirmDialog, ToastContainer, focusableIn } = surfaces;
const h = React.createElement;
const doc = window.document;
const act = (fn) => React.act(fn);
const host = doc.getElementById('root');

const closedConfirm = { isOpen: false, title: '', message: '', confirmLabel: '', cancelLabel: '', variant: 'info', resolvePromise: null };
let confirmResults = [];
globalThis.__setState({
    confirmDialog: closedConfirm,
    toasts: [],
    removeToast() { },
    hideConfirm: (r) => { confirmResults.push(r); globalThis.__setState({ confirmDialog: closedConfirm }); },
});
const openConfirm = () => act(() => globalThis.__setState({
    confirmDialog: { isOpen: true, title: 'Delete project?', message: 'This cannot be undone.', confirmLabel: 'Delete', cancelLabel: 'Cancel', variant: 'danger', resolvePromise: null },
}));

const press = (key, extra = {}) => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    act(() => { (doc.activeElement ?? doc.body).dispatchEvent(e); });
    return e;
};
const opener = doc.createElement('button'); opener.id = 'opener'; opener.textContent = 'New Project';
const other = doc.createElement('button'); other.id = 'other'; other.textContent = 'Behind the overlay';
doc.body.prepend(opener, other);

let root1;
let closes = 0;
const form = () => h('form', null,
    h('input', { id: 'name', type: 'text' }),
    h('button', { type: 'button', id: 'cancel' }, 'Cancel'),
    h('button', { type: 'button', id: 'create' }, 'Create'));
const renderModal = (isOpen, props = {}, secondOpen = false) => act(() => {
    root1 ??= createRoot(host);
    root1.render(h(React.Fragment, null,
        h(Modal, { isOpen, onClose: () => { closes++; }, title: 'New Project', children: form(), ...props }),
        h(Modal, { isOpen: secondOpen, onClose: () => { }, title: 'Details', children: h('p', null, 'no fields here') }),
        h(ConfirmDialog),
        h(ToastContainer)));
});

// ---------------------------------------------------------------------------
section('a dialog has a name');
opener.focus();
renderModal(true);
{
    const dlg = doc.querySelector('[role="dialog"]');
    const labelId = dlg?.getAttribute('aria-labelledby');
    const label = labelId ? doc.getElementById(labelId) : null;
    check('aria-labelledby points at an element that exists', !!label, `aria-labelledby=${labelId}`);
    check('and it is the title', label?.textContent === 'New Project', label?.textContent);
    check('the label is the dialog\'s own heading', label?.tagName === 'H2' && dlg.contains(label));
}

section('focus goes in when it opens');
{
    const dlg = doc.querySelector('[role="dialog"]');
    check('a form: the first field has focus, not the Close button and not the opener',
        doc.activeElement?.id === 'name', `${doc.activeElement?.tagName}#${doc.activeElement?.id}`);
    check('the dialog itself can take focus (tabIndex -1) for content with no field', dlg?.getAttribute('tabindex') === '-1');
    // On a touchscreen a focused field opens the on-screen keyboard over half the
    // dialog before it has been read, so focus goes to the dialog instead.
    renderModal(false);
    opener.focus();
    finePointer = false;
    renderModal(true);
    const touchDlg = doc.querySelector('[role="dialog"]');
    check('a form on a touchscreen: the dialog has focus, not the field (no keyboard pops up)',
        !!touchDlg && doc.activeElement === touchDlg, `${doc.activeElement?.tagName}#${doc.activeElement?.id}`);
    renderModal(false);
    finePointer = true;
    opener.focus();
    renderModal(true);
}

section('Tab and Shift+Tab stay inside it');
{
    const dlg = doc.querySelector('[role="dialog"]');
    const close = dlg.querySelector('button[aria-label="Close dialog"]');
    const create = doc.getElementById('create');
    close?.focus();
    const back = press('Tab', { shiftKey: true });
    check('Shift+Tab from "Close dialog" wraps to the last control, not to the page behind',
        doc.activeElement === create && back.defaultPrevented, `${doc.activeElement?.id || doc.activeElement?.tagName}`);
    const fwd = press('Tab');
    check('Tab from the last control wraps to "Close dialog"',
        doc.activeElement === close && fwd.defaultPrevented, `${doc.activeElement?.id || doc.activeElement?.tagName}`);
    doc.getElementById('name').focus();
    const mid = press('Tab');
    check('Tab in the middle is left to the browser (no fake focus order)', !mid.defaultPrevented);
    other.focus();
    press('Tab');
    check('Tab with focus already OUTSIDE it pulls focus back in', dlg.contains(doc.activeElement), doc.activeElement?.id);
    doc.getElementById('name').focus();
}

section('Escape closes it once');
{
    const before = closes;
    press('Escape');
    check('Escape asks it to close', closes === before + 1, `${closes - before} call(s)`);
}

section('a ConfirmDialog over it closes only itself');
{
    const before = closes;
    doc.getElementById('create').focus();
    openConfirm();
    const cd = [...doc.querySelectorAll('[role="dialog"]')].find(d => /Delete project/.test(d.textContent));
    check('the confirm is named by its title', !!cd && doc.getElementById(cd.getAttribute('aria-labelledby') ?? '')?.textContent === 'Delete project?');
    check('and described by its message', !!cd && doc.getElementById(cd.getAttribute('aria-describedby') ?? '')?.textContent === 'This cannot be undone.');
    check('focus starts on Cancel (the safe answer)', doc.activeElement?.textContent === 'Cancel', doc.activeElement?.textContent);
    const shift = press('Tab', { shiftKey: true });
    check('Shift+Tab from Cancel wraps to Delete inside the confirm',
        doc.activeElement?.textContent === 'Delete' && shift.defaultPrevented, doc.activeElement?.textContent);
    const modalTab = press('Tab');
    check('Tab from Delete wraps to Cancel; the Modal beneath does not also move focus',
        doc.activeElement?.textContent === 'Cancel', doc.activeElement?.textContent);
    void modalTab;
    press('Escape');
    check('Escape answers the confirm "no"', confirmResults.length === 1 && confirmResults[0] === false, JSON.stringify(confirmResults));
    check('and does NOT close the Modal under it', closes === before, `${closes - before} Modal close(s)`);
    check('the page stays locked: the Modal is still open', doc.body.style.overflow === 'hidden', JSON.stringify(doc.body.style.overflow));
    check('focus went back to what opened the confirm', doc.activeElement?.id === 'create', doc.activeElement?.id);
    press('Escape');
    check('the next Escape closes the Modal', closes === before + 1, `${closes - before} Modal close(s)`);
}

section('a model list open inside a dialog takes its own Escape');
{
    // The list is portalled and the dialog hears Escape on the document, so a
    // press meant for the list also closed the dialog, and with it the step the
    // learner was in.
    const { ModelPicker } = surfaces;
    const models = [{ name: 'alpha-7b', size: 0 }, { name: 'beta-70b', size: 0 }];
    const before = closes;
    opener.focus();
    renderModal(true, {
        children: h('div', null,
            h('input', { id: 'name', type: 'text' }),
            h(ModelPicker, { value: '', onChange: () => { }, models, label: 'Model', id: 'mp' })),
    });
    act(() => { doc.getElementById('mp').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    const filter = doc.querySelector('[role="combobox"]');
    check('the list opens and its filter box has focus', !!filter && doc.activeElement === filter, `${doc.activeElement?.tagName}#${doc.activeElement?.id}`);
    press('Escape');
    check('Escape shuts the list', !doc.querySelector('[role="combobox"]'));
    check('and does NOT close the dialog it sits in', closes === before, `${closes - before} dialog close(s)`);
    check('focus went back to the picker\'s button', doc.activeElement?.id === 'mp', doc.activeElement?.id);
    press('Escape');
    check('the next Escape, with no list open, closes the dialog', closes === before + 1, `${closes - before} dialog close(s)`);
    renderModal(false);
}

section('a connection saved in the Add dialog is reported however the dialog closes');
{
    // "Test and connect" saves the connection before the model step; only the
    // step's own buttons told the list, so the X, the backdrop and Escape left
    // the panel showing none and the next try saved a second copy.
    const { AddConnectionDialog } = surfaces;
    const kinds = { ollama: { baseUrl: 'http://127.0.0.1:11434', key: 'none', editable: true, keyUrl: '' } };
    const done = [];
    let closed = 0;
    globalThis.__api = {
        addConnection: async () => ({ id: 7, activeId: 7, test: { ok: true, models: 2, listed: true } }),
        getConnectionModels: async () => ({ success: true, models: [] }),
    };
    const mountAdd = (props) => act(() => {
        root1 ??= createRoot(host);
        root1.render(h(AddConnectionDialog, {
            open: true, kinds, onClose: () => { closed++; }, onDone: (id, o) => { done.push([id, o.testIt]); }, ...props,
        }));
    });
    const connect = async () => {
        const form = doc.querySelector('[role="dialog"] form');
        await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    };
    renderModal(false);
    mountAdd({ initialKind: 'ollama' });
    press('Escape');
    check('closed before anything is saved: nothing to report', done.length === 0 && closed === 1, `${done.length} report(s), ${closed} close(s)`);

    mountAdd({ open: false });
    mountAdd({ initialKind: 'ollama' });
    await connect();
    check('Test and connect moves on to the model step', !!doc.querySelector('[role="dialog"] button[aria-haspopup="listbox"]'));
    done.length = 0; closed = 0;
    press('Escape');
    check('Escape on the model step closes it', closed === 1, `${closed} close(s)`);
    check('and the saved connection is reported, so the list reloads', done.length === 1 && done[0][0] === 7, JSON.stringify(done));

    // Finishing with its own button still reports once (the dialog's own
    // buttons already did, and closing must not say it a second time).
    mountAdd({ open: false });
    globalThis.__api.useConnection = async () => ({});
    globalThis.__api.updateConnection = async () => ({});
    mountAdd({ initialKind: 'ollama' });
    await connect();
    done.length = 0; closed = 0;
    const doneBtn = [...doc.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Done');
    await act(async () => { doneBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    check('"Done" reports the connection once and closes', done.length === 1 && closed === 1, `${done.length} report(s), ${closed} close(s)`);

    // While the test is out the dialog cannot be closed: the answer lands on
    // the dialog that asked, so the connection it saves is reported, never lost
    // to a dialog that is already gone. (Escape, the backdrop and the X all
    // follow the same `closable`.)
    mountAdd({ open: false });
    let answer;
    globalThis.__api.addConnection = () => new Promise((r) => { answer = r; });
    mountAdd({ initialKind: 'ollama' });
    await connect();
    done.length = 0; closed = 0;
    press('Escape');
    check('Escape while "Test and connect" is out does not close the dialog', closed === 0 && !!doc.querySelector('[role="dialog"] form'), `${closed} close(s)`);
    check('and the X is not offered', ![...doc.querySelectorAll('[role="dialog"] button')].some((b) => /close/i.test(b.getAttribute('aria-label') ?? '')));
    await act(async () => { answer({ id: 8, activeId: 8, test: { ok: true, models: 0, listed: true } }); });
    check('the answer lands on the open dialog: the model step', !!doc.querySelector('[role="dialog"] button[aria-haspopup="listbox"]') || [...doc.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === 'Done'));
    press('Escape');
    check('and closing it then reports the saved connection once', closed === 1 && done.length === 1 && done[0][0] === 8, `${closed} close(s), ${JSON.stringify(done)}`);

    // Back leaves the form as surely as the X does: started from the list of
    // providers, it is offered, and it waits for the save like the X.
    mountAdd({ open: false });
    globalThis.__api.addConnection = () => new Promise((r) => { answer = r; });
    mountAdd({});
    const ollamaTile = [...doc.querySelectorAll('[role="dialog"] button')].find((b) => /Ollama/.test(b.textContent));
    await act(async () => { ollamaTile?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    const back = () => [...doc.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Back');
    check('picked from the list, the form offers Back', !!back() && !back().disabled);
    await connect();
    check('and Back is disabled while "Test and connect" is out', !!back() && back().disabled, back() ? `disabled=${back().disabled}` : 'no Back');
    await act(async () => { answer({ id: 9, activeId: 9, test: { ok: true, models: 0, listed: true } }); });
    mountAdd({ open: false });
    delete globalThis.__api;
}

section('closing gives focus and scroll back');
{
    renderModal(false);
    check('the page scrolls again', doc.body.style.overflow === '', JSON.stringify(doc.body.style.overflow));
    check('focus is back on the button that opened it', doc.activeElement === opener, doc.activeElement?.id || doc.activeElement?.tagName);
}

section('the opener is remembered even when a child focuses itself on mount');
{
    // `autoFocus` runs in the commit, before any effect: reading the opener in the
    // effect found the dialog's own input, and Close left focus on the body.
    opener.focus();
    renderModal(true, { children: h('input', { id: 'auto', type: 'text', autoFocus: true }) });
    check('the child kept the focus it took', doc.activeElement?.id === 'auto', doc.activeElement?.id);
    renderModal(false);
    check('and closing still returns focus to the button that opened the dialog', doc.activeElement === opener,
        doc.activeElement?.id || doc.activeElement?.tagName);
}

section('focus is not dragged back when it should not be');
{
    opener.focus();
    renderModal(true);
    other.focus();                       // the learner (or the close action) put it somewhere on purpose
    renderModal(false);
    check('a close that left focus elsewhere keeps it there', doc.activeElement === other, doc.activeElement?.id);

    const gone = doc.createElement('button'); gone.id = 'gone'; doc.body.append(gone);
    gone.focus();
    renderModal(true);
    gone.remove();
    let threw = false;
    try { renderModal(false); } catch { threw = true; }
    check('an opener that no longer exists is skipped without an error', !threw);
    check('and focus does not land on a detached node', doc.activeElement?.isConnected !== false);
}

section('the scroll lock is counted, not toggled');
{
    renderModal(true);
    openConfirm();
    check('two open dialogs lock the page', doc.body.style.overflow === 'hidden');
    act(() => globalThis.__st.state.hideConfirm(false));
    check('closing the top one leaves it locked for the one under', doc.body.style.overflow === 'hidden', JSON.stringify(doc.body.style.overflow));
    renderModal(false);
    check('closing the last gives the page back', doc.body.style.overflow === '', JSON.stringify(doc.body.style.overflow));

    // Two Modals, as a toast's Details over a dialog: the pre-fix Modal set the
    // body to '' whenever ANY of them closed.
    renderModal(true, {}, true);
    const second = [...doc.querySelectorAll('[role="dialog"]')].find(d => /no fields here/.test(d.textContent));
    check('a dialog with no field takes focus itself', doc.activeElement === second, `${doc.activeElement?.tagName}`);
    renderModal(true, {}, false);
    check('closing one of two Modals keeps the page locked', doc.body.style.overflow === 'hidden', JSON.stringify(doc.body.style.overflow));
    renderModal(false, {}, false);
    check('and closing the other releases it', doc.body.style.overflow === '', JSON.stringify(doc.body.style.overflow));
}

section('a dialog that is not ours, open above it, keeps its own Tab');
{
    renderModal(true);
    const foreign = doc.createElement('div'); foreign.setAttribute('role', 'dialog'); foreign.setAttribute('aria-modal', 'true');
    const fb = doc.createElement('button'); fb.textContent = 'Foreign'; foreign.append(fb); doc.body.append(fb.parentElement);
    fb.focus();
    const e = press('Tab');
    check('Tab inside another modal is not hijacked', !e.defaultPrevented && doc.activeElement === fb);
    foreign.remove();
    renderModal(false);
}

// A creation run's screen had two ways to close while it ran: the head's ✕ and
// the foot's "Close — creation carries on", which also says that closing stops
// nothing. One goes: the foot's, since it carries the fact a learner needs.
section('a dialog whose foot holds its Close draws no ✕, and still closes');
{
    opener.focus();
    renderModal(true, { closeButton: false });
    const dlg = doc.querySelector('[role="dialog"]');
    check('no "Close dialog" button in its head', !!dlg && !dlg.querySelector('button[aria-label="Close dialog"]'));
    const spacer = dlg?.querySelector('h2 + span[aria-hidden="true"]');
    const spacerClasses = spacer ? spacer.className.split(/\s+/).filter(Boolean) : [];
    const before = closes;
    press('Escape');
    check('Escape still closes it', closes === before + 1, `${closes - before} call(s)`);
    renderModal(false);
    renderModal(true);
    const xButton = doc.querySelector('[role="dialog"] button[aria-label="Close dialog"]');
    check('the ✕ is back by default', !!xButton);
    // jsdom lays nothing out, so the box is compared by its classes: the head's
    // height and the title's width stay put when the ✕ comes and goes.
    const xClasses = new Set(xButton ? xButton.className.split(/\s+/) : []);
    check('without the ✕ its place keeps the ✕\'s box (size classes and margin)',
        ['h-8', 'w-8', '-mr-1.5'].every(c => spacerClasses.includes(c)) && spacerClasses.every(c => c === 'shrink-0' || xClasses.has(c)),
        `spacer "${spacerClasses.join(' ')}"`);
    renderModal(false);
    const run = read('src/components/creation/CreationRunView.tsx');
    // One value says what the foot holds; the foot's branches and the ✕ both
    // read it, so a new kind of foot cannot leave the dialog with no way out.
    const footBody = run.slice(run.indexOf('border-t border-slate-200 px-6 py-3'));
    check('the creation run hides its ✕ exactly while its foot shows a Close',
        /<Modal\b[^>]*\bcloseButton=\{!footCloses\}/.test(run)
        && /const footCloses = foot === 'live' \|\| foot === 'close';/.test(run));
    check('…and the foot picks its buttons from that same value',
        /\{stacked => foot === 'live' \? \(/.test(footBody) && /: foot === 'continue' \? \(/.test(footBody)
        && !/(\b(openable|needsSetup|live|finished)|canContinue\(run\)) \? \(/.test(footBody));
}

// ---------------------------------------------------------------------------
section('toasts are announced, and no control sits inside another');
{
    const toasts = [
        { id: 't1', type: 'success', message: 'Saved', count: 1 },
        { id: 't2', type: 'error', message: 'Could not reach the model', details: 'ECONNREFUSED', count: 2 },
        { id: 't3', type: 'info', message: 'Indexing', count: 1 },
    ];
    act(() => globalThis.__setState({ toasts }));
    const region = (text) => [...doc.querySelectorAll('[role="status"],[role="alert"]')].find(el => el.textContent.includes(text));
    check('an ordinary toast is a polite status', region('Saved')?.getAttribute('role') === 'status', region('Saved')?.getAttribute('role'));
    check('an info toast is a polite status', region('Indexing')?.getAttribute('role') === 'status');
    check('an error toast is an alert', region('Could not reach')?.getAttribute('role') === 'alert', region('Could not reach')?.getAttribute('role'));
    const err = region('Could not reach');
    check('no role="button" contains the dismiss button (a control inside a control)',
        !!err && !err.querySelector('[role="button"]') && ![...err.querySelectorAll('button')].some(b => b.closest('[role="button"]')));
    const buttons = [...(err?.querySelectorAll('button') ?? [])];
    check('the details are one real button, named by what it says',
        buttons.some(b => /Could not reach the model/.test(b.textContent) && /Click for details/.test(b.textContent)), buttons.map(b => b.textContent).join(' | '));
    check('and the dismiss button is its sibling, still named', buttons.some(b => b.getAttribute('aria-label') === 'Dismiss notification'));
    act(() => globalThis.__setState({ toasts: [] }));
}

// ---------------------------------------------------------------------------
// The hand-rolled overlays. An overlay that answers Escape from a window
// listener of its own lets Tab from its last control walk onto the page behind,
// leaves focus on the button that opened it, and closes the dialog under a
// confirm on top as well. Every one is mounted here and held to Modal's contract.
const nameOf = (el) => {
    if (!el) return '';
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map(id => doc.getElementById(id)?.textContent ?? '').join(' ').trim();
    return (el.getAttribute('aria-label') ?? '').trim();
};
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 40)); });
const confirmNode = () => [...doc.querySelectorAll('[role="dialog"]')].find(d => /Delete project/.test(d.textContent));

// A surface that throws on mount is one failed case, not a crashed suite.
async function holdsTheContract(label, surface) {
    try { await contractCases(label, surface); }
    catch (e) {
        check(`${label}: mounted and ran`, false, String(e?.message ?? e).split('\n')[0]);
        try { await surface.hide(); } catch { /* already gone */ }
    }
}
async function contractCases(label, { show, hide, closes }) {
    section(`${label}: named, focus in, Tab kept inside, one Escape per dialog, focus back`);
    opener.focus();
    await show();
    await settle();
    // The surface: its dialog element, or on a pre-fix copy with no role the
    // last full-screen overlay, so the Tab and Escape cases still run.
    const dialogs = [...doc.querySelectorAll('[role="dialog"]')].filter(d => d !== confirmNode());
    const overlays = [...doc.querySelectorAll('.fixed.inset-0')];
    const dlg = dialogs[dialogs.length - 1] ?? overlays[overlays.length - 1];
    if (!dlg) { check(`${label}: (setup) it rendered`, false); await hide(); return; }
    check(`${label}: is a modal dialog`, dlg.getAttribute('role') === 'dialog' && dlg.getAttribute('aria-modal') === 'true',
        `role=${dlg.getAttribute('role')} aria-modal=${dlg.getAttribute('aria-modal')}`);
    check(`${label}: has an accessible name`, nameOf(dlg).length > 0, 'no aria-label / aria-labelledby');
    check(`${label}: focus went in when it opened`, dlg.contains(doc.activeElement),
        `${doc.activeElement?.tagName}#${doc.activeElement?.id || ''}`);
    const items = focusableIn(dlg);
    if (items.length >= 2) {
        const first = items[0], last = items[items.length - 1];
        last.focus();
        const fwd = press('Tab');
        check(`${label}: Tab from the last control wraps inside, not to the page behind`,
            fwd.defaultPrevented && doc.activeElement === first, `${doc.activeElement?.tagName} "${doc.activeElement?.textContent?.slice(0, 30)}"`);
        first.focus();
        const back = press('Tab', { shiftKey: true });
        check(`${label}: Shift+Tab from the first control wraps to the last`,
            back.defaultPrevented && doc.activeElement === last, `${doc.activeElement?.tagName} "${doc.activeElement?.textContent?.slice(0, 30)}"`);
    } else {
        check(`${label}: (setup) at least two controls to walk`, false, `${items.length}`);
    }
    const before = closes();
    items[0]?.focus();
    confirmResults = [];
    openConfirm();
    press('Escape');
    check(`${label}: Escape with a confirm on top answers the confirm only`,
        confirmResults.length === 1 && closes() === before, `${confirmResults.length} confirm answer(s), ${closes() - before} close(s) of the dialog under it`);
    press('Escape');
    check(`${label}: the next Escape closes it, once`, closes() === before + 1, `${closes() - before} close(s)`);
    // A confirm a pre-fix dialog never let hear its Escape is still open; it
    // must not carry its lock and its Tab into the next surface's cases.
    if (globalThis.__st.state.confirmDialog?.isOpen) act(() => globalThis.__st.state.hideConfirm(false));
    await hide();
    await settle();
    check(`${label}: closing gives focus back to what opened it`, doc.activeElement === opener,
        `${doc.activeElement?.tagName}#${doc.activeElement?.id || ''}`);
    check(`${label}: and the page scrolls again`, doc.body.style.overflow === '', JSON.stringify(doc.body.style.overflow));
}

// One root per surface; the confirm is mounted beside it so it can open on top.
function propSurface(Component, props, openKey = 'open') {
    const el = doc.createElement('div'); doc.body.append(el);
    const r = createRoot(el);
    let n = 0;
    const render = (open) => act(() => r.render(h(React.Fragment, null,
        h(Component, { ...props, [openKey]: open, onClose: () => { n++; } }), h(ConfirmDialog))));
    return { show: () => render(true), hide: () => { render(false); act(() => r.unmount()); el.remove(); }, closes: () => n };
}
function mountedSurface(make) {
    const el = doc.createElement('div'); doc.body.append(el);
    const r = createRoot(el);
    let n = 0;
    return {
        show: () => act(() => r.render(h(React.Fragment, null, make(() => { n++; }), h(ConfirmDialog)))),
        hide: () => { act(() => r.unmount()); el.remove(); },
        closes: () => n,
    };
}

globalThis.__setState({
    addToast() { }, loadProjects() { }, openProject() { }, consumeAnkiImportFile: () => null,
    loadProjectData() { }, currentProjectId: 1, appVersion: null, aiProvider: '', aiModel: '',
    openAiTask: () => false, cancelAiTask() { }, accentColor: '#7c3aed',
    showConfirm: () => Promise.resolve(false),
});


{
    let n = 0;
    const el = doc.createElement('div'); doc.body.append(el);
    const r = createRoot(el);
    const setShowScheduleModal = (v) => { if (!v) n++; };
    globalThis.__setState({
        showScheduleModal: false, scheduleModalProjectId: 1, setShowScheduleModal,
        projects: [{ id: 1, name: 'Physics', kind: 'curriculum', start_date: null, deadline: null, study_days: null }],
        tree: [], paceData: null, scheduleProject: async () => true, recalibrateSchedule: async () => true, removeSchedule: async () => true,
    });
    const render = () => act(() => r.render(h(React.Fragment, null, h(surfaces.ScheduleModal), h(ConfirmDialog))));
    await holdsTheContract('Schedule', {
        show: () => { globalThis.__setState({ showScheduleModal: true }); render(); },
        hide: () => { act(() => globalThis.__setState({ showScheduleModal: false })); act(() => r.unmount()); el.remove(); },
        closes: () => n,
    });
}

await holdsTheContract('Anki import', propSurface(surfaces.AnkiImportModal, {}));
await holdsTheContract('Bulk generate', mountedSurface((onClose) => h(surfaces.BulkGenerateModal, { projectId: 1, onClose })));
await holdsTheContract('Placement', propSurface(surfaces.PlacementModal, { projectId: 1, projectName: 'Physics' }, 'isOpen'));
await holdsTheContract('Report a problem', propSurface(surfaces.ReportProblemDialog, { draftKey: 'gate' }));
const task = {
    id: 't1', kind: 'quiz', label: 'Quiz: Waves', labelKey: null, labelParams: null, projectId: 1, nodeId: 2,
    projectName: 'Physics', projectColor: '#2563eb', status: 'running', createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(), finishedAt: null, progress: { phase: 'writing', message: null, thinkingChars: 0, contentChars: 0, percent: null },
    queuePosition: null, error: null, origin: null,
};
await holdsTheContract('Task details', mountedSurface((onClose) => h(surfaces.TaskDetailModal, { task, onClose, onDismiss() { } })));
const failure = {
    message: 'The model returned an empty response', name: 'Error', at: new Date().toISOString(), kind: 'quiz', label: 'Quiz: Waves',
    projectId: 1, nodeId: 2, origin: null, phase: 'writing', lastMessage: null, produced: { thinkingChars: 0, contentChars: 0, percent: null },
    queuedAt: null, startedAt: null, elapsedMs: 1200, provider: 'openai', model: 'm', endpoint: null, httpStatus: 500, code: null,
    attempts: 1, responseBody: null, rawResponse: null, causes: [], stack: null,
};
await holdsTheContract('Task failure', mountedSurface((onClose) => h(surfaces.TaskFailureModal, { failure, onClose, onOpenOrigin() { } })));
await holdsTheContract('Save a visual', propSurface(surfaces.ExportVisualModal, {
    kind: 'mermaid', code: 'graph TD; A-->B', stage: null, palette: { bg: '#ffffff', fg: '#0f172a', muted: '#64748b', border: '#e2e8f0' },
}));
section('Save a visual: Escape stops an encode, a late caption draft is dropped, the words and the loop length are the reader\'s');
{
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const stage = doc.createElement('div');
    const svg = doc.createElementNS(SVG_NS, 'svg');
    const anim = doc.createElementNS(SVG_NS, 'animate');
    anim.setAttribute('attributeName', 'x');
    anim.setAttribute('dur', '3.5s');
    svg.append(anim);
    stage.append(svg);
    doc.body.append(stage);

    const el = doc.createElement('div'); doc.body.append(el);
    const r = createRoot(el);
    let closed = 0;
    let stageNow = stage;
    const draw = (open) => act(() => r.render(h(React.Fragment, null,
        h(surfaces.ExportVisualModal, {
            open, onClose: () => { closed++; }, kind: 'mermaid', code: 'graph TD; A-->B', stage: stageNow,
            palette: { bg: '#ffffff', fg: '#0f172a', muted: '#64748b', border: '#e2e8f0' },
        }), h(ConfirmDialog))));
    const dlg = () => doc.querySelector('[aria-labelledby="export-visual-title"]');
    const button = (label) => [...(dlg()?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === label);
    const warn = console.warn;
    console.warn = () => { };
    // No canvas backend: the preview is decorative and skips itself.
    window.HTMLCanvasElement.prototype.getContext = () => null;
    try {
        // Escape while a GIF is being made.
        let signal = null, release = () => { };
        globalThis.__exp = {
            exportAnimationGif: (_t, opts) => new Promise((_res, rej) => {
                signal = opts.signal;
                release = () => rej(new Error('cancelled'));
                signal.addEventListener('abort', release);
            }),
        };
        closed = 0;
        draw(true);
        act(() => { button('Save GIF')?.click(); });
        await settle();
        check('control: the encode is running (the footer button says Stop)', !!button('Stop'));
        press('Escape');
        await settle();
        check('Escape while a GIF is being encoded stops the encode', signal?.aborted === true, `aborted=${signal?.aborted}`);
        check('…and leaves the dialog open, like the Stop button', closed === 0 && !!dlg(), `${closed} close(s)`);
        press('Escape');
        check('the next Escape closes it', closed === 1, `${closed} close(s)`);
        draw(false);
        // A build that was never stopped (the pre-fix dialog) is let go, so
        // the cases below start from a dialog that is not still encoding.
        await act(async () => { release(); await new Promise(res => setTimeout(res, 10)); });

        // A caption draft that comes back after the dialog was closed and reopened.
        let answer = null;
        globalThis.__api = { captionVisual: () => new Promise((res) => { answer = res; }) };
        const framedFields = async () => {
            act(() => { dlg().querySelector('input[name="export-frame"][type="radio"]:not(:checked)')?.click(); });
            await settle();
            return { title: dlg().querySelector('input:not([type="radio"])'), caption: dlg().querySelector('textarea') };
        };
        draw(true);
        await framedFields();
        act(() => { button('Draft with AI')?.click(); });
        check('control: the draft was asked for', answer !== null);
        draw(false);
        draw(true);
        const after = await framedFields();
        await act(async () => { answer?.({ title: 'Old title', caption: 'Old caption' }); await new Promise(res => setTimeout(res, 10)); });
        check('a draft that arrives after the dialog was closed does not fill the reopened one',
            after.title?.value === '' && after.caption?.value === '', `title "${after.title?.value}", caption "${after.caption?.value}"`);
        check('…and the reopened dialog is not left "Drafting…"', !!button('Draft with AI') && !button('Drafting…'));
        draw(false);

        // A failure shows the sentence in the reader's language, not the encoder's.
        globalThis.__exp = { exportAnimationGif: async () => { throw new Error('the drawing could not be rasterized.'); } };
        draw(true);
        act(() => { button('Save GIF')?.click(); });
        await settle();
        const text = dlg()?.textContent ?? '';
        check('a failed encode says "The file could not be made.", not the encoder\'s own lower-case message',
            text.includes('The file could not be made.') && !text.includes('rasterized'), text.slice(-120));
        draw(false);

        // Escape while a PNG is being made: it cannot be interrupted part-way,
        // but no file may arrive after the reader stopped it.
        const still = doc.createElement('div');
        still.append(doc.createElementNS(SVG_NS, 'svg'));
        stageNow = still;
        const downloads = [];
        let finishPng = () => { };
        globalThis.__exp = {
            exportStillPng: () => new Promise((res) => { finishPng = () => res(new window.Blob(['x'])); }),
            downloadBlob: (_b, name) => { downloads.push(name); },
        };
        const savePng = async (stop) => {
            draw(true);
            act(() => { button('Save PNG')?.click(); });
            await settle();
            if (stop) { press('Escape'); await settle(); }
            await act(async () => { finishPng(); await new Promise(res => setTimeout(res, 10)); });
        };
        await savePng(true);
        check('a PNG that was stopped with Escape is not downloaded when it finishes', downloads.length === 0, JSON.stringify(downloads));
        draw(false);
        await savePng(false);
        check('control: a PNG that was not stopped is downloaded', downloads.length === 1, JSON.stringify(downloads));
        draw(false);
        stageNow = stage;

        // The loop length is written in the reader's number style.
        act(() => surfaces.setNumberPreference('1.234,5'));
        globalThis.__tCalls = [];
        draw(true);
        const loop = (globalThis.__tCalls ?? []).find(([k]) => k.startsWith('One loop'));
        check('the loop length follows the reader\'s number style (3,5 s, not 3.5 s)', loop?.[1]?.loopSeconds === '3,5', JSON.stringify(loop?.[1]));
        draw(false);
    } finally {
        act(() => surfaces.setNumberPreference('auto'));
        console.warn = warn;
        globalThis.__exp = undefined;
        globalThis.__api = undefined;
        act(() => r.unmount());
        el.remove();
        stage.remove();
    }
}

await holdsTheContract('Drill', mountedSurface((onClose) => h(surfaces.DrillModal, {
    onClose,
    spec: { title: 'Kana', modes: ['choice'], items: [{ prompt: 'あ', answer: 'a' }, { prompt: 'い', answer: 'i' }, { prompt: 'う', answer: 'u' }, { prompt: 'え', answer: 'e' }] },
})));

{
    // Search opens from its own button and keeps its open state inside, so the
    // case presses that button; the router is only there for useNavigate.
    const { MemoryRouter } = require('react-router-dom');
    let n = 0;
    globalThis.__setState({
        projects: [], nodes: [], searchResults: null, searchResultsQuery: null, searchError: null, searchLoading: false,
        performSearch: async () => { }, setSearchOpen: (v) => { if (!v) n++; },
    });
    const el = doc.createElement('div'); doc.body.append(el);
    const r = createRoot(el);
    await holdsTheContract('Search', {
        show: () => {
            act(() => r.render(h(MemoryRouter, null, h(surfaces.SearchBar), h(ConfirmDialog))));
            act(() => { el.querySelector('button[aria-label^="Search…"]').click(); });
        },
        hide: () => { act(() => r.unmount()); el.remove(); },
        closes: () => n,
    });
}

// The mastery check, drawn by a stubbed server: four questions, the smallest
// sitting the server will judge (MIN_GATE_QUESTIONS); a shorter draw is not
// started as a check at all.
const drawn = {
    questions: [
        { type: 'multiple_choice', question: 'Which wave needs a medium?', options: ['Sound', 'Light', 'Radio', 'X-ray'], correct_answer: 'Sound', quizId: 7, index: 0, uuid: 'q-0' },
        { type: 'true_false', question: 'Light is a transverse wave.', options: ['True', 'False'], correct_answer: 'True', quizId: 7, index: 1, uuid: 'q-1' },
        { type: 'true_false', question: 'Sound travels faster in water than in air.', options: ['True', 'False'], correct_answer: 'True', quizId: 7, index: 2, uuid: 'q-2' },
        { type: 'true_false', question: 'A wave carries energy without carrying matter along.', options: ['True', 'False'], correct_answer: 'True', quizId: 7, index: 3, uuid: 'q-3' },
    ],
    bankSize: 4, unverified: 0, minQuestions: 4, status: 'in_progress',
};
globalThis.__api = { drawMasteryCheck: async () => drawn };
await holdsTheContract('Mastery check', propSurface(surfaces.MasteryGateModal,
    { nodeId: 2, nodeTitle: 'Waves', projectId: 1, onPassed() { } }, 'isOpen'));

section('the mastery check keeps a half-answered sitting, and a failed send keeps the answers');
{
    let n = 0, sent = [];
    const el = doc.createElement('div'); doc.body.append(el);
    const r = createRoot(el);
    let fail = true;
    // The results screen the last send reaches offers video searches.
    globalThis.__setState({ searchProviders: [] });
    globalThis.__api = {
        drawMasteryCheck: async () => drawn,
        // The attempt id by its POSITION (projectId, nodeId, score, total,
        // questions, asked, attemptId, review) — it stopped being the last
        // argument when the sitting's review was added after it.
        submitMasteryCheck: async (...args) => { sent.push(args[6]); if (fail) throw new Error('Failed to fetch'); return { passed: true, pass_threshold: 0.8 }; },
    };
    const render = () => act(() => r.render(h(React.Fragment, null,
        h(surfaces.MasteryGateModal, { isOpen: true, nodeId: 3, nodeTitle: 'Waves', projectId: 1, onPassed() { }, onClose: () => { n++; } }),
        h(ConfirmDialog))));
    render();
    await settle();
    const dlg = () => [...doc.querySelectorAll('[role="dialog"]')].find(d => /Mastery check/.test(d.textContent));
    const button = (label) => [...(dlg()?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === label);
    act(() => { button('Sound')?.click(); });
    press('Escape');
    check('Escape does not close a check with an answer in it', n === 0 && !!dlg(), `${n} close(s)`);
    for (let q = 1; q < drawn.questions.length; q++) {
        act(() => { button('Next')?.click(); });
        act(() => { button('True')?.click(); });
    }
    await act(async () => { button('Submit mastery check')?.click(); });
    await settle();
    check('a failed submit keeps the questions on screen with Submit', !!button('Submit mastery check'),
        (dlg()?.textContent ?? '').slice(0, 120));
    check('...and says the answers were not saved', !!dlg()?.querySelector('[role="alert"]'));
    await act(async () => { button('Submit mastery check')?.click(); });
    await settle();
    check('pressing Submit again sends the same sitting (one attempt id)', sent.length === 2 && sent[0] === sent[1] && typeof sent[0] === 'string',
        JSON.stringify(sent));
    // A changed answer is a different sitting: the server would answer the old
    // id with the score it stored, not this one.
    act(() => { button('False')?.click(); });
    fail = false;
    await act(async () => { button('Submit mastery check')?.click(); });
    await settle();
    check('…but an answer changed after the failed send goes as a new attempt id', sent.length === 3 && sent[2] !== sent[0],
        JSON.stringify(sent));
    act(() => r.unmount()); el.remove();
    globalThis.__api = {};
}

// The creation-side dialogs, mounted with a stubbed server. Every case below
// is a screen a learner reaches when a request fails, a run ends, or a cap is
// hit: none of them is reachable from the contract cases above.
{
    const dialogOf = (name) => doc.querySelector(`[role="dialog"][aria-label="${name}"]`);
    const textOf = (el) => el?.textContent ?? '';
    const wait = (ms) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
    const buttonIn = (root, label) => [...(root?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === label);
    const mountNode = (node) => {
        const el = doc.createElement('div'); doc.body.append(el);
        const r = createRoot(el);
        act(() => r.render(node));
        return { el, unmount: () => { act(() => r.unmount()); el.remove(); } };
    };
    const DAY = '2026-01-01T00:00:00.000Z';
    const job = {
        id: 'j1', projectId: 1, kinds: ['flashcards'], total: 7, done: 2, failed: 0, skipped: 0, current: null, waiting: false,
        etaMs: null, status: 'running', failures: [], startedAt: DAY, finishedAt: null,
    };
    const candidate = (i) => ({
        nodeId: i, title: `Topic ${i}`, path: `Phase › Topic ${i}`, status: 'not_started', scheduledEnd: null,
        section: 'Phase', quizzes: 0, questions: 0, gateReady: false, flashcards: 0,
    });
    const BULK = 'Generate study material';

    section('the bulk-material dialog keeps following a run whose poll failed once');
    {
        let polls = 0;
        globalThis.__api = {
            getBulkCandidates: async () => ({ candidates: [candidate(1)], max: 60 }),
            getBulkStatus: async () => { polls++; if (polls === 1) throw new Error('Failed to fetch'); return job; },
        };
        const m = mountNode(h(surfaces.BulkGenerateModal, { projectId: 1, onClose() { } }));
        await wait(2400);
        check('the run panel shows the run after the failed poll (2/7)', /2\/7/.test(textOf(dialogOf(BULK))) && polls >= 2,
            `${polls} poll(s); ${textOf(dialogOf(BULK)).slice(0, 80)}`);
        m.unmount();
    }

    section('the topic list is read again when a run ends');
    {
        let polls = 0, loads = 0;
        globalThis.__api = {
            // The second list is a different one: a re-read whose answer is thrown away fails.
            getBulkCandidates: async () => { loads++; return { candidates: [loads === 1 ? candidate(1) : { ...candidate(1), title: 'Topic 1 rewritten' }], max: 60 }; },
            getBulkStatus: async () => (++polls === 1 ? job : { ...job, status: 'done', done: 7, finishedAt: DAY }),
        };
        const m = mountNode(h(surfaces.BulkGenerateModal, { projectId: 1, onClose() { } }));
        await wait(2400);
        check('the candidates are fetched a second time once the run has finished, and the new list is shown',
            loads === 2 && /Topic 1 rewritten/.test(textOf(dialogOf(BULK))), `${loads} load(s), ${polls} poll(s)`);
        m.unmount();
    }

    section('a poll that keeps failing is asked again a little later each time');
    {
        const at = [];
        globalThis.__api = {
            getBulkCandidates: async () => ({ candidates: [candidate(1)], max: 60 }),
            getBulkStatus: async () => { at.push(Date.now()); if (at.length < 3) throw new Error('Failed to fetch'); return job; },
        };
        const m = mountNode(h(surfaces.BulkGenerateModal, { projectId: 1, onClose() { } }));
        await wait(4900);
        const gaps = [at[1] - at[0], at[2] - at[1]];
        check('the second wait is about twice the first (1.5 s, then 3 s)', at.length >= 3 && gaps[0] < 2300 && gaps[1] > 2400,
            `${at.length} poll(s); gaps ${gaps.join(', ')} ms`);
        m.unmount();
    }

    section('the re-read after a run keeps the topics the learner lined up, and drops the ones just written');
    {
        let polls = 0, loads = 0;
        const rowBox = (dlg, n) => [...dlg.querySelectorAll('label')].find(l => l.textContent.includes(`Topic ${n}`))?.querySelector('input');
        globalThis.__api = {
            getBulkCandidates: async () => { loads++; return { candidates: [1, 2, 3].map(candidate), max: 60 }; },
            getBulkStatus: async () => (++polls < 3 ? job : { ...job, status: 'done', done: 7, finishedAt: DAY }),
        };
        const m = mountNode(h(surfaces.BulkGenerateModal, { projectId: 1, onClose() { } }));
        await settle();
        const dlg = () => dialogOf(BULK);
        act(() => { buttonIn(dlg(), 'None')?.click(); });
        act(() => { rowBox(dlg(), 2)?.click(); });
        await wait(4200);
        check('the candidates were read again', loads === 2, `${loads} load(s), ${polls} poll(s)`);
        check('the topic picked during the run is still picked after the re-read, the others are not',
            !!rowBox(dlg(), 2)?.checked && !rowBox(dlg(), 1)?.checked && !rowBox(dlg(), 3)?.checked,
            [1, 2, 3].map(n => rowBox(dlg(), n)?.checked).join());
        m.unmount();
    }

    section('a run that ends before the first poll still re-reads the topic list');
    {
        let loads = 0;
        globalThis.__api = {
            getBulkCandidates: async () => { loads++; return { candidates: [candidate(1)], max: 60 }; },
            getBulkStatus: async () => null,
            startBulkGeneration: async () => {
                // The run is over by the time anyone asks about it.
                globalThis.__api.getBulkStatus = async () => ({ ...job, status: 'done', done: 7, finishedAt: DAY });
                return job;
            },
        };
        const m = mountNode(h(surfaces.BulkGenerateModal, { projectId: 1, onClose() { } }));
        await settle();
        act(() => { buttonIn(dialogOf(BULK), 'Generate')?.click(); });
        await settle();
        await settle();
        check('a run that finished between two polls reloads the candidates', loads === 2, `${loads} load(s)`);
        m.unmount();
    }

    section('a failed topic read is said, can be asked again, and goes once it works');
    {
        let loads = 0;
        globalThis.__api = {
            getBulkCandidates: async () => { if (++loads === 1) throw new Error('the topic list is down'); return { candidates: [candidate(1)], max: 60 }; },
            getBulkStatus: async () => null,
        };
        const m = mountNode(h(surfaces.BulkGenerateModal, { projectId: 1, onClose() { } }));
        await settle();
        check('the failure is shown with Try again', /the topic list is down/.test(textOf(dialogOf(BULK))) && !!buttonIn(dialogOf(BULK), 'Try again'));
        act(() => { buttonIn(dialogOf(BULK), 'Try again')?.click(); });
        await settle();
        check('Try again reads the list again, and the message is gone', loads === 2 && !/the topic list is down/.test(textOf(dialogOf(BULK))) && /Topic 1/.test(textOf(dialogOf(BULK))),
            `${loads} load(s); ${textOf(dialogOf(BULK)).slice(0, 120)}`);
        m.unmount();
    }

    section('a tick the cap refuses says why');
    {
        globalThis.__api = {
            getBulkCandidates: async () => ({ candidates: [1, 2, 3].map(candidate), max: 2 }),
            getBulkStatus: async () => null,
        };
        const m = mountNode(h(surfaces.BulkGenerateModal, { projectId: 1, onClose() { } }));
        await settle();
        const dlg = () => dialogOf(BULK);
        const capNote = () => /Capped at/.test(textOf(dlg()));
        const row = (n) => [...dlg().querySelectorAll('label')].find(l => l.textContent.includes(`Topic ${n}`))?.querySelector('input');
        const sectionBox = () => dlg().querySelector('input[aria-label^="Select every topic in"]');
        check('the opening selection of 3 topics under a cap of 2 says it is capped', capNote());
        act(() => { buttonIn(dlg(), 'None')?.click(); });
        check('None clears the note', !capNote());
        act(() => { sectionBox()?.click(); });
        check('ticking a section that does not fit says it is capped', capNote(), textOf(dlg()).slice(0, 200));
        act(() => { buttonIn(dlg(), 'None')?.click(); });
        act(() => { row(1)?.click(); });
        act(() => { row(2)?.click(); });
        check('two ticks fit under the cap without a note', !capNote());
        act(() => { row(3)?.click(); });
        check('a third tick is refused, and the note says why', capNote() && !row(3)?.checked, textOf(dlg()).slice(0, 200));
        m.unmount();
    }

    section('a drag that ends on the backdrop does not close a dialog; a tap on it does');
    for (const [label, name, make] of [
        ['Bulk generate', BULK, (onClose) => h(surfaces.BulkGenerateModal, { projectId: 1, onClose })],
        ['Task details', 'Task details', (onClose) => h(surfaces.TaskDetailModal, { task, onClose, onDismiss() { } })],
        ['Task failure', 'Generation failure details', (onClose) => h(surfaces.TaskFailureModal, { failure, onClose, onOpenOrigin() { } })],
    ]) {
        globalThis.__api = { getBulkCandidates: async () => ({ candidates: [], max: 60 }), getBulkStatus: async () => null };
        const s = mountedSurface(make);
        s.show();
        await settle();
        const panel = dialogOf(name);
        const backdrop = panel?.parentElement;
        act(() => { panel?.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })); });
        act(() => { backdrop?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
        check(`${label}: a press inside that is released over the backdrop does not close it`, s.closes() === 0, `${s.closes()} close(s)`);
        act(() => { backdrop?.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })); });
        act(() => { backdrop?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
        check(`${label}: a tap on the backdrop still closes it`, s.closes() === 1, `${s.closes()} close(s)`);
        s.hide();
    }

    section('the course-writing panels say when a request failed, and offer another go');
    {
        let calls = 0;
        globalThis.__api = {
            authoringPhases: async () => { if (++calls === 1) throw new Error('the server is down'); return { project: { id: 1, name: 'P' }, phases: [] }; },
        };
        const m = mountNode(h(surfaces.MaterialPassPanel, { projectId: 1 }));
        await settle();
        check('a failed phase list says why instead of a spinner that never ends', /the server is down/.test(textOf(m.el)) && !!buttonIn(m.el, 'Try again'),
            textOf(m.el).slice(0, 120));
        act(() => { buttonIn(m.el, 'Try again')?.click(); });
        await settle();
        check('Try again asks again and shows what came back', calls === 2 && /no phases to write/.test(textOf(m.el)), `${calls} call(s); ${textOf(m.el).slice(0, 120)}`);
        m.unmount();

        let briefs = 0;
        globalThis.__api = {
            authoringPhases: async () => ({ project: { id: 1, name: 'P' }, phases: [{ id: 5, title: 'Waves', leaves: 2, withMaterial: 0 }] }),
            materialBrief: async () => { if (++briefs === 1) throw new Error('the brief failed'); return { prompt: 'PROMPT', phase: null, leaves: 2 }; },
        };
        const p = mountNode(h(surfaces.MaterialPassPanel, { projectId: 1 }));
        await settle();
        check('a failed brief request is said beside the copy button, with Try again',
            /the brief failed/.test(textOf(p.el)) && !!buttonIn(p.el, 'Try again'), textOf(p.el).slice(0, 200));
        check('with no brief there is no "Read it first (0k characters)" to open',
            !/Read it first/.test(textOf(p.el)), textOf(p.el).slice(0, 200));
        act(() => { buttonIn(p.el, 'Try again')?.click(); });
        await settle();
        check('Try again asks for the brief again, and the message goes', briefs === 2 && !/the brief failed/.test(textOf(p.el)),
            `${briefs} call(s)`);
        p.unmount();

        // Switching to a phase whose brief fails: the count of the phase before
        // is not left in the step's title beside the error.
        globalThis.__api = {
            authoringPhases: async () => ({ project: { id: 1, name: 'P' }, phases: [
                { id: 5, title: 'Waves', leaves: 2, withMaterial: 0 }, { id: 6, title: 'Optics', leaves: 3, withMaterial: 0 }] }),
            materialBrief: async (_p, phaseId) => { if (phaseId === 6) throw new Error('no brief for optics'); return { prompt: 'PROMPT', phase: null, leaves: 2 }; },
        };
        const sw = mountNode(h(surfaces.MaterialPassPanel, { projectId: 1 }));
        await settle();
        check('a phase with a brief says how many topics are still to write', /2 topics still to write/.test(textOf(sw.el)), textOf(sw.el).slice(0, 200));
        act(() => { [...sw.el.querySelectorAll('[data-row="phase"]')].find(b => /Optics/.test(b.textContent))?.click(); });
        await settle();
        check('after a failed brief the title no longer carries the other phase\'s count',
            /no brief for optics/.test(textOf(sw.el)) && !/still to write/.test(textOf(sw.el)), textOf(sw.el).slice(0, 240));
        sw.unmount();

        // A reply that merged, then a phase list that cannot be read again: the
        // counts are the old ones, and the screen says so instead of staying quiet.
        let phaseReads = 0;
        globalThis.__api = {
            authoringPhases: async () => {
                if (++phaseReads > 1) throw new Error('the phase list is down');
                return { project: { id: 1, name: 'P' }, phases: [{ id: 5, title: 'Waves', leaves: 2, withMaterial: 0 }] };
            },
            materialBrief: async () => ({ prompt: 'PROMPT', phase: null, leaves: 2 }),
            mergeMaterial: async () => ({ added: 1, topics: [1], unmatched: [], warnings: [] }),
        };
        const q = mountNode(h(surfaces.MaterialPassPanel, { projectId: 1 }));
        await settle();
        const reply = q.el.querySelector('textarea');
        act(() => {
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(reply, '{"leaves":[]}');
            reply.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
        act(() => { [...q.el.querySelectorAll('button')].find(b => /to add it/.test(b.textContent))?.click(); });
        await settle();
        check('a phase list that fails to refresh after a merge says so, with Try again',
            /the phase list is down/.test(textOf(q.el)) && !!buttonIn(q.el, 'Try again') && !!q.el.querySelector('[data-row="phase"]'),
            `${phaseReads} read(s); ${textOf(q.el).slice(0, 200)}`);
        q.unmount();

        globalThis.__api = { outlineBrief: async () => { throw new Error('the outline brief failed'); } };
        const o = mountNode(h(surfaces.OutlineBriefPanel, { subject: 'Waves', setSubject() { }, language: 'en', onImported() { } }));
        await wait(450);
        check('the outline prompt box says when its request failed', /the outline brief failed/.test(textOf(o.el)) && !!buttonIn(o.el, 'Try again'),
            textOf(o.el).slice(0, 200));
        o.unmount();
    }
    globalThis.__api = {};

    // Text that is built from pieces, or written with a bare number or unit, is
    // English in every other language: these are source reads of the call sites.
    section('numbers, units and plurals on these screens follow the interface language');
    {
        const bulk = read('src/components/BulkGenerateModal.tsx');
        check('the ETA unit comes from durationParts (translated), not a hard-coded "min"/"h"',
            /durationParts/.test(bulk) && !/\$\{mins\} min|\$\{h\} h/.test(bulk));
        check('a topic with no section is grouped under a translated heading', !/c\.section \|\| 'Topics'/.test(bulk) && /c\.section \|\| t\("Topics"\)/.test(bulk));
        check('the failure line does not add an English "e.g."', !/e\.g\. \$\{/.test(bulk));
        const runs = read('src/components/creation/creationRuns.ts');
        check('a stream that fails with no message is not "Unknown AI creation error"', !/Unknown AI creation error/.test(runs));
        const ext = read('src/components/ExternalAuthoring.tsx');
        check('the prompt size is written through the number formatter', /num\(Math\.round\(prompt\.length \/ 1000\)\)/.test(ext));
        const fail = read('src/components/TaskFailureModal.tsx');
        check('"Ran for" is written with the interface language\'s decimal and the translated unit',
            !/toFixed\(/.test(fail) && /t\("\{\{ms\}\}ms"/.test(fail) && /t\("\{\{n\}\} s"/.test(fail));
        const files = read('src/components/creation/SourceFiles.tsx');
        check('a file size is written through the number formatter', !/toFixed\(/.test(files) && /useNumberFormat/.test(files));
    }
}

// Too heavy to mount here (the whole review session; the assistant with its
// stream and tools). Their overlays go through the same hook, which the
// mounted cases above hold; this pins that they still do.
section('the review session and the phone assistant are the same kind of dialog');
{
    const review = read('src/components/GlobalFlashcardReview.tsx');
    // The session keys stand down under ANY aria-modal dialog (useFlashcardKeys),
    // so the surface keeps the keyboard contract without claiming to be one.
    check('the review session surface keeps focus and Tab the way a dialog does (it covers the whole page)',
        /useDialogFocus\(true, surfaceRef/.test(review) && /role="region"/.test(review));
    check('...and is NOT aria-modal, which would switch its own Space and 1-4 off',
        !/aria-modal=/.test(review.slice(review.indexOf('function SessionSurface'), review.indexOf('function SessionSurface') + 2500)));
    const drawer = read('src/components/AssistantDrawer.tsx');
    check('the assistant is a dialog only as an overlay (the desktop dock stays a column)',
        /useDialogFocus\(open && !docked, overlayRef/.test(drawer));
    check('and has no Escape listener of its own beside the hook',
        !/addEventListener\('keydown', onKey\)/.test(drawer.slice(0, drawer.indexOf('consumeAssistantPrefill();'))));
    const ws = read('src/components/Workspace.tsx');
    check('the phone nav drawer is a dialog while open, and inert (out of the Tab order) while slid away',
        /useDialogFocus\(isMobile && !studyView && navDrawerOpen, drawerRef/.test(ws) && /inert=\{!navDrawerOpen\}/.test(ws));
    // React 19 made `inert` a boolean attribute: `true` writes it, and the empty
    // string React 18 needed is read as FALSE (with a console warning), so a
    // panel written the old way silently stays in the Tab order.
    const probe = doc.createElement('div');
    doc.body.appendChild(probe);
    const probeRoot = createRoot(probe);
    const consoleError = console.error;
    console.error = () => { };   // the warning the empty string earns is the point
    try {
        act(() => probeRoot.render(h('div', null, h('i', { inert: true }), h('b', { inert: '' }))));
    } finally {
        console.error = consoleError;
    }
    check('React writes `inert` for true and NOT for the empty string (the React 18 form)',
        probe.querySelector('i').hasAttribute('inert') && !probe.querySelector('b').hasAttribute('inert'),
        probe.innerHTML);
    act(() => probeRoot.unmount());
    probe.remove();
    // Any string reaching `inert` — a key or a prop, either quote, a backtick,
    // or one arm of a conditional — in any source file, read by one `git grep`.
    const STRING_INERT = String.raw`['"]?inert['"]?[[:space:]]*:[[:space:]]*['"${'`'}]|inert=[[:space:]]*['"]|inert=\{[^}]*['"${'`'}]`;
    const grepArgs = ['grep', '-l', '-E', STRING_INERT, ...(HEAD ? ['HEAD'] : []), '--', 'src/*.ts', 'src/*.tsx'];
    let stringInert = '';
    try { stringInert = execFileSync('git', grepArgs, { cwd: root, encoding: 'utf8' }).trim(); }
    catch (e) { if (e.status !== 1) throw e; }   // 1 = no match
    check('no component passes `inert` a string', stringInert === '', stringInert.replace(/\n/g, ', '));
    const kinds = read('src/components/settings/VisualKindsPanel.tsx');
    check('the Settings visual samples stay inert (a thumbnail, never a control)',
        (kinds.match(/^\s+inert\s*$/gm) || []).length === 2);
    // The preview is one component, opened from the vault and from an
    // answer's Sources line; it is a Modal, and Modal takes the hook.
    const preview = read('src/components/DocumentTextDialog.tsx');
    check('the vault\'s extracted-text preview is a named dialog with the hook',
        /<DocumentTextDialog\b/.test(read('src/components/VaultPanel.tsx'))
        && /<Modal\b[^>]*\btitle=/.test(preview) && !/fixed inset-0/.test(preview)
        && /useDialogFocus\(isOpen, dialogRef/.test(read('src/components/Modal.tsx')));
    check('an answer\'s Sources line opens the same preview, not a second one',
        /<DocumentTextDialog\b/.test(read('src/components/SourceList.tsx')));
    // A name on a plain <span> is ignored by screen readers (a generic element
    // takes none), so "Step 1 of 4" never reached them; an image role gives it
    // somewhere to attach and the visible "1 / 4" stays the picture of it.
    const stepCounter = (read('src/components/welcome/WelcomeFlow.tsx').match(/<span\b[^>]*aria-label=\{t\("Step \{\{n\}\} of \{\{total\}\}"[^>]*>/) || [''])[0];
    check('the welcome step counter is named through a role that takes a name',
        /\brole="img"/.test(stepCounter), stepCounter);
    // A JSX line break between two expressions renders nothing, so the deck
    // count and its "· N sections" read "1,100· 22 sections".
    const deckRow = (read('src/components/AnkiImportModal.tsx').match(/\{num\(d\.count\)\}[\s\S]{0,800}?·\x20\{\{stages\}\} sections/) || [''])[0];
    check('the import preview puts a space between a deck\'s count and its sections',
        deckRow !== '' && /\{num\(d\.count\)\}[\s\S]*?(?:' '|\{' '\}|\{" "\})[\s\S]*?t\("· \{\{stages\}\}/.test(deckRow), deckRow.slice(0, 160));
    // The media row has the same break between the icon counts and "· N KB".
    const mediaRow = (read('src/components/AnkiImportModal.tsx').match(/<\/span>\s*(?:\{' '\}\s*)?\{t\("·\x20\{\{bytes\}\} kept on this machine/) || [''])[0];
    check('the import media row puts a space between its counts and the size',
        mediaRow !== '' && /\{' '\}/.test(mediaRow), mediaRow);
    const done = read('src/components/completion/CompletionSummary.tsx');
    check('the finished-project screen takes the hook and keeps landing on its one action',
        /useDialogFocus\(!!data, dialogRef, \{ initialFocus: primaryRef/.test(done) && !/addEventListener\('keydown'/.test(done));
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
console.log(`\ndialog gates: ${pass} passed, ${fail} failed${HEAD ? ' (against HEAD)' : ''}`);
process.exit(fail ? 1 : 0);
