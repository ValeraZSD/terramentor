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
        /sr-only sm:not-sr-only[^>]*>\{hasSchedule \? tr\("Edit Schedule"\)/.test(ws));
    check('the tab you are on says so: aria-current="page" (routes, not a half tab pattern)',
        /aria-current=\{workspaceView === tab\.key \? 'page' : undefined\}/.test(ws));
    check('and it does not claim role="tab" without the keys and panels that owes',
        !/role="tab(list)?"/.test(ws));
    check('the rail is a labelled nav', /<nav ref=\{tabRailRef\} aria-label=/.test(ws));
    check('the drawer button has a name beyond its title', /aria-label=\{tr\("Open navigation"\)\}/.test(ws));
}

section('every overlay shares the counted scroll lock, and one Escape closes one dialog');
{
    // A hand-rolled overlay writing `body.style.overflow = ''` on close gave
    // the page its scroll back under a Modal still open beneath it.
    const overlays = ['src/components/CaptureModal.tsx', 'src/components/completion/CompletionSummary.tsx', 'src/components/drills/DrillModal.tsx'];
    for (const p of overlays) {
        const src = read(p);
        // Directly, or through useDialogFocus, which takes the same counted lock.
        check(`${p.split('/').pop()}: locks the page through the shared counted lock, never overflow by hand`,
            (/lockScroll\(\)/.test(src) || /useDialogFocus\(/.test(src)) && !/body\.style\.overflow/.test(src));
    }
    // The Remove schedule confirm opens OVER the Schedule dialog; its Escape
    // must not also close the dialog beneath. Its own listener used to skip a
    // claimed Escape; the dialog stack does that now, and the mounted case in
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

const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'dialog-gates-'));
const out = join(scratch, 'bundle.cjs');
const headDir = join(scratch, 'head');
// Paths under src/components. The hand-rolled overlays are mounted beside
// Modal: each was converted to the same hook and is held to the same contract.
const files = ['Modal', 'ConfirmDialog', 'Toast',
    'CaptureModal', 'ScheduleModal', 'AnkiImportModal', 'BulkGenerateModal', 'PlacementModal',
    'ReportProblemDialog', 'TaskDetailModal', 'TaskFailureModal', 'visuals/ExportVisualModal', 'drills/DrillModal',
    'SearchBar', 'MasteryGateModal'];
if (HEAD) {
    for (const f of files) {
        mkdirSync(dirname(join(headDir, `${f}.tsx`)), { recursive: true });
        writeFileSync(join(headDir, `${f}.tsx`), read(`src/components/${f}.tsx`));
    }
}
const from = (f) => HEAD ? join(headDir, `${f}.tsx`).replace(/\\/g, '/') : `./src/components/${f}`;

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => (o && o.count != null ? k.replace('{{count}}', o.count) : k) });`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    // The fields the components read, and a `hideConfirm` the gate supplies.
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: {}, subs: new Set() };
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
            export { default as CaptureModal } from '${from('CaptureModal')}';
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
            export { focusableIn } from './src/hooks/useDialogFocus';`,
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
// The hand-rolled overlays. Each one used to answer Escape from a window
// listener of its own and nothing else: Tab from its last control walked onto
// the page behind (measured in Capture: it reached Today under the overlay),
// focus stayed on the button that opened it, and an Escape meant for a confirm
// on top closed the dialog under it as well. Schedule had no dialog role at all.
// Every one is mounted here and held to Modal's contract.
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

await holdsTheContract('Capture', propSurface(surfaces.CaptureModal, {}));

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
await holdsTheContract('Task details', mountedSurface((onClose) => h(surfaces.TaskDetailModal, { task, onClose, onDismiss() { }, onShowFailure() { } })));
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
            act(() => { el.querySelector('button[aria-label="Search"]').click(); });
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
        /useDialogFocus\(isMobile && !studyView && navDrawerOpen, drawerRef/.test(ws) && /\{ inert: '' \}/.test(ws));
    check('the vault\'s extracted-text preview is a named dialog with the hook',
        /useDialogFocus\(!!viewDoc, viewRef/.test(read('src/components/VaultPanel.tsx')));
    const done = read('src/components/completion/CompletionSummary.tsx');
    check('the finished-project screen takes the hook and keeps landing on its one action',
        /useDialogFocus\(!!data, dialogRef, \{ initialFocus: primaryRef/.test(done) && !/addEventListener\('keydown'/.test(done));
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
console.log(`\ndialog gates: ${pass} passed, ${fail} failed${HEAD ? ' (against HEAD)' : ''}`);
process.exit(fail ? 1 : 0);
