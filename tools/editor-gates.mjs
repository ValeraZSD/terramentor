// tools/editor-gates.mjs — an editor says "Saved" only for a write that happened,
// and nothing a learner typed is thrown away by a slip of the keyboard.
//
// Run:  node tools/editor-gates.mjs          (the working tree)
//       node tools/editor-gates.mjs --head   (MarkdownNotes and CaptureModal as they
//                                             were at HEAD, to watch the cases fail)
//
// WHY. Three ways to lose text, all found by an outside UI audit (30 Sep 2026):
//   - MarkdownNotes called `onSave`, cleared its dirty flag, said "Saved" and left
//     edit mode in one go. The Overview and My notes pass an async callback whose
//     write can fail (the store answers `false` and toasts), so a failed write
//     showed "Saved" beside "Failed to save changes", with the unsaved text in the
//     preview as if it were kept;
//   - the notes box took Tab and Shift+Tab to insert spaces, so a keyboard could
//     not leave it, and Escape — the obvious way out — threw a dirty edit away;
//   - Capture cleared its text, link, title and files every time it opened, so an
//     Escape or a stray backdrop tap lost a pasted article.
// Every case MOUNTS the real component (the store, the api and Markdown are
// stubs) and presses real keys.
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

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'Event', 'File']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// A mouse-and-keyboard machine: the keyboard hints and first-field focus follow it.
window.matchMedia = (q) => ({ matches: /pointer: fine/.test(q), media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
// jsdom has no object URLs; Capture previews a pasted image with one.
window.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = () => { };
globalThis.URL = window.URL;

const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'editor-gates-'));
const out = join(scratch, 'bundle.cjs');
const headDir = join(scratch, 'head');
const files = ['MarkdownNotes', 'CaptureModal'];
if (HEAD) {
    mkdirSync(headDir);
    for (const f of files) writeFileSync(join(headDir, `${f}.tsx`), read(`src/components/${f}.tsx`));
}
const from = (f) => HEAD && files.includes(f) ? join(headDir, `${f}.tsx`).replace(/\\/g, '/') : `./src/components/${f}`;

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => { let s = k; for (const [a, b] of Object.entries(o ?? {})) s = s.replace('{{' + a + '}}', b); return s; } });`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: {}, subs: new Set() };
        g.__setState = (patch) => { g.__st.state = { ...g.__st.state, ...patch }; g.__st.subs.forEach(f => f()); };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;`,
    'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => globalThis.__api[name](...args) });`,
    // The preview renders markdown; what matters here is the text it was given.
    'Markdown': `import { createElement } from 'react'; export default function Markdown({ content }) { return createElement('div', { 'data-markdown': '' }, content); }`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\/Markdown$/ }, () => ({ path: 'Markdown', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
        // A HEAD copy sits in the scratch dir; its relative imports meant src/components/.
        b.onResolve({ filter: /^\.\.?\// }, async (args) => {
            if (!HEAD || !args.importer.replace(/\\/g, '/').startsWith(headDir.replace(/\\/g, '/'))) return undefined;
            return b.resolve(args.path, { resolveDir: join(root, 'src', 'components'), kind: args.kind });
        });
    },
};

await esbuild.build({
    stdin: {
        contents: `
            export { default as MarkdownNotes } from '${from('MarkdownNotes')}';
            export { default as CaptureModal } from '${from('CaptureModal')}';
            export { default as ConfirmDialog } from './src/components/ConfirmDialog';`,
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
const { MarkdownNotes, CaptureModal, ConfirmDialog } = require(out);
const h = React.createElement;
const doc = window.document;
const act = (fn) => React.act(fn);
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });

const closedConfirm = { isOpen: false, title: '', message: '', confirmLabel: '', cancelLabel: '', variant: 'info', resolvePromise: null };
const toasts = [];
globalThis.__setState({
    confirmDialog: closedConfirm,
    addToast: (type, message) => { toasts.push({ type, message }); },
    showConfirm: (o) => new Promise((resolvePromise) => globalThis.__setState({
        confirmDialog: { isOpen: true, title: o.title, message: o.message, confirmLabel: o.confirmLabel ?? 'Confirm', cancelLabel: o.cancelLabel ?? 'Cancel', variant: o.variant ?? 'info', resolvePromise },
    })),
    hideConfirm: (r) => { const p = globalThis.__st.state.confirmDialog.resolvePromise; globalThis.__setState({ confirmDialog: closedConfirm }); p?.(r); },
});

const press = (key, extra = {}, target = doc.activeElement ?? doc.body) => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    act(() => { target.dispatchEvent(e); });
    return e;
};
const type = (el, value) => act(() => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
});
// A missing control is a failed case further down, never a crash of the suite.
const click = (el) => { if (el) act(() => { el.click(); }); };
const buttonNamed = (re, scope = doc) => [...scope.querySelectorAll('button')].find(b => re.test((b.getAttribute('aria-label') || b.textContent).trim()));
const confirmOpen = () => [...doc.querySelectorAll('[role="dialog"]')].find(d => /Discard your changes/.test(d.textContent));
const hasSaved = (scope) => [...scope.querySelectorAll('span')].some(s => s.textContent.trim() === 'Saved');
// HEAD's editor never awaited the callback, so a rejected write surfaced as an
// unhandled rejection; that is a failed case, not a crashed suite.
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

// ---------------------------------------------------------------------------
const host = doc.getElementById('root');
const notesRoot = createRoot(host);
let saves = [];
let pending = null;
let saveMode = 'deferred';    // deferred | sync | throw
const onSave = (v) => {
    saves.push(v);
    if (saveMode === 'sync') return undefined;
    if (saveMode === 'throw') return Promise.reject(new Error('offline'));
    return new Promise((res) => { pending = res; });
};
const renderNotes = (props = {}) => act(() => notesRoot.render(h(React.Fragment, null,
    h(MarkdownNotes, { value: 'Original text', onChange() { }, onSave, label: 'My notes', nodeId: 1, ...props }),
    h(ConfirmDialog))));
const textarea = () => host.querySelector('textarea');
const startEditing = async (text) => {
    click(buttonNamed(/^Edit/));
    await flush();
    type(textarea(), text);
};

section('a failed write never says "Saved", and the text stays in the editor');
renderNotes();
await startEditing('My new notes');
click(buttonNamed(/Save/));
check('while the write is in flight the editor stays open with the draft', textarea()?.value === 'My new notes', textarea() ? textarea().value : 'editor closed');
check('and "Saved" is not shown before the write answered', !hasSaved(host));
click(buttonNamed(/Save/));
press('Enter', { ctrlKey: true }, textarea() ?? doc.body);
check('a second Save (button or Ctrl+Enter) while one is in flight is not a second write', saves.length === 1, `${saves.length} write(s)`);
await act(async () => { pending?.(false); });
await flush();
check('the write answered false: still editing, text intact', textarea()?.value === 'My new notes', textarea() ? textarea().value : 'editor closed');
check('and no "Saved"', !hasSaved(host));
const alert = host.querySelector('[role="alert"]');
check('a message beside the editor says it was not saved', !!alert && /not saved/i.test(alert.textContent), alert?.textContent ?? 'no role="alert"');
const retry = alert ? buttonNamed(/Retry/, alert) : null;
check('with a Retry control', !!retry);
if (retry) {
    click(retry);
    check('Retry writes the same text once more', saves.length === 2 && saves[1] === 'My new notes', JSON.stringify(saves));
    await act(async () => { pending?.(true); });
    await flush();
    check('a write that succeeded leaves edit mode and says "Saved"', !textarea() && hasSaved(host), textarea() ? 'still editing' : host.textContent.slice(0, 80));
}

section('a throw is a failure too; a callback that returns nothing is a save');
saves = []; saveMode = 'throw';
renderNotes({ value: 'Second', nodeId: 2 });
await flush();
await startEditing('Typed then thrown');
click(buttonNamed(/Save/));
await flush();
check('a rejected write keeps the editor open with the text', textarea()?.value === 'Typed then thrown', textarea() ? textarea().value : 'editor closed');
check('and says so', /not saved/i.test(host.querySelector('[role="alert"]')?.textContent ?? ''));
saveMode = 'sync';
click(buttonNamed(/Retry/) ?? buttonNamed(/Save/));
await flush();
check('a plain void callback still saves as before', !textarea() && hasSaved(host));

section('moving to another topic mid-write never marks the new topic saved');
saves = []; saveMode = 'deferred';
act(() => notesRoot.unmount());
const notesRoot2 = createRoot(host);
const render2 = (props) => act(() => notesRoot2.render(h(React.Fragment, null,
    h(MarkdownNotes, { value: 'Topic A', onChange() { }, onSave, label: 'My notes', nodeId: 10, ...props }),
    h(ConfirmDialog))));
render2({});
click(buttonNamed(/^Edit/)); await flush();
type(textarea(), 'A edited');
click(buttonNamed(/Save/));
render2({ value: 'Topic B', nodeId: 11 });
await act(async () => { pending?.(true); });
await flush();
check('the reply for topic A does not put "Saved" on topic B', !hasSaved(host), host.textContent.slice(0, 80));
check('and topic B shows its own text', /Topic B/.test(host.textContent) && !/A edited/.test(host.querySelector('textarea')?.value ?? ''));
act(() => notesRoot2.unmount());

section('Tab leaves the notes box like any text field');
const notesRoot3 = createRoot(host);
act(() => notesRoot3.render(h(React.Fragment, null,
    h(MarkdownNotes, { value: 'Original text', onChange() { }, onSave, label: 'My notes', nodeId: 3 }),
    h(ConfirmDialog))));
saves = []; saveMode = 'sync';
click(buttonNamed(/^Edit/)); await flush();
type(textarea(), 'abc');
const tab = press('Tab', {}, textarea());
check('Tab is not taken by the box (the browser moves focus)', !tab.defaultPrevented);
await flush();
check('and inserts nothing', textarea()?.value === 'abc', JSON.stringify(textarea()?.value));
const shiftTab = press('Tab', { shiftKey: true }, textarea());
await flush();
check('Shift+Tab is not taken either, and inserts nothing', !shiftTab.defaultPrevented && textarea()?.value === 'abc', JSON.stringify(textarea()?.value));
check('the keyboard hint no longer promises "Tab indent"', !/indent/.test(host.textContent));

section('Escape or Cancel on a changed edit asks first; on an unchanged one it just leaves');
press('Escape', {}, textarea());
await flush();
check('Escape on a changed edit opens a confirm', !!confirmOpen());
check('the editor is still there under it, text intact', textarea()?.value === 'abc', textarea() ? textarea().value : 'editor closed');
const keep = confirmOpen() ? buttonNamed(/Keep editing/, confirmOpen()) : null;
check('the safe answer is "Keep editing" and it has focus', !!keep && doc.activeElement === keep, doc.activeElement?.textContent);
press('Escape');
await flush();
check('Escape in the confirm keeps editing', !confirmOpen() && textarea()?.value === 'abc');
click(buttonNamed(/^Cancel/, host));
await flush();
check('Cancel on a changed edit asks too', !!confirmOpen());
if (confirmOpen()) click(buttonNamed(/^Discard$/, confirmOpen()));
await flush();
check('Discard throws the edit away and shows the saved text', !textarea() && /Original text/.test(host.textContent));
check('nothing was written', saves.length === 0, JSON.stringify(saves));
click(buttonNamed(/^Edit/)); await flush();
press('Escape', {}, textarea());
await flush();
check('Escape on an unchanged edit leaves at once, no confirm', !textarea() && !confirmOpen());
click(buttonNamed(/^Edit/)); await flush();
type(textarea(), 'saved by keys');
press('Enter', { ctrlKey: true }, textarea());
await flush();
check('Ctrl+Enter still saves', saves.length === 1 && saves[0] === 'saved by keys', JSON.stringify(saves));
act(() => notesRoot3.unmount());

// ---------------------------------------------------------------------------
section('Capture keeps its draft until it is saved or discarded');
globalThis.__api = {
    capture: async () => { if (captureFails) throw new Error('offline'); return { nodeId: 5, projectId: 9, taskId: null }; },
    uploadDocumentFiles: async () => ({}),
    enrichCapture: async () => ({ taskId: null }),
};
let captureFails = false;
let open = false;
const capHost = doc.createElement('div'); doc.body.append(capHost);
let capRoot = createRoot(capHost);
const renderCapture = () => act(() => capRoot.render(h(CaptureModal, { open, onClose: () => { open = false; renderCapture(); } })));
const field = (label) => capHost.querySelector(`[aria-label="${label}"]`);
open = true; renderCapture(); await flush();
type(field('Paste what you want to keep…'), 'A long pasted article');
type(field('Source URL'), 'https://example.org/a');
type(field('Title'), 'Worth keeping');
const fileInput = capHost.querySelector('input[type="file"]');
const photo = new window.File(['x'], 'photo.png', { type: 'image/png' });
act(() => {
    Object.defineProperty(fileInput, 'files', { value: [photo], configurable: true });
    fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
});
check('(setup) the file was attached', /photo\.png/.test(capHost.textContent));
press('Escape');
await flush();
check('(setup) Escape closed it', !capHost.querySelector('[role="dialog"]'));
open = true; renderCapture(); await flush();
check('reopened after Escape: the text is still there', field('Paste what you want to keep…')?.value === 'A long pasted article', JSON.stringify(field('Paste what you want to keep…')?.value));
check('and the link and the title', field('Source URL')?.value === 'https://example.org/a' && field('Title')?.value === 'Worth keeping');
check('and the attached file', /photo\.png/.test(capHost.textContent));
click(buttonNamed(/^Close$/, capHost));
act(() => capRoot.unmount());
capRoot = createRoot(capHost);
open = true; renderCapture(); await flush();
check('a draft outlives the component (the shell remounting)', field('Paste what you want to keep…')?.value === 'A long pasted article');

captureFails = true;
click(buttonNamed(/Save to Inbox/, capHost));
await flush();
check('a failed save leaves the dialog open with the text', field('Paste what you want to keep…')?.value === 'A long pasted article');
captureFails = false;

const discard = buttonNamed(/^Discard$/, capHost);
check('there is an explicit Discard control', !!discard);
if (discard) {
    click(discard);
    await flush();
    check('Discard empties the form', field('Paste what you want to keep…')?.value === '' && !/photo\.png/.test(capHost.textContent));
    press('Escape'); await flush();
    open = true; renderCapture(); await flush();
    check('and a discarded draft does not come back', field('Paste what you want to keep…')?.value === '');
}
type(field('Paste what you want to keep…'), 'Saved for real');
click(buttonNamed(/Save to Inbox/, capHost));
await flush();
check('(setup) a successful save closes it', !capHost.querySelector('[role="dialog"]'));
open = true; renderCapture(); await flush();
check('a successful save clears the draft', field('Paste what you want to keep…')?.value === '', JSON.stringify(field('Paste what you want to keep…')?.value));
act(() => capRoot.unmount());

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
console.log(`\neditor gates: ${pass} passed, ${fail} failed${HEAD ? ' (against HEAD)' : ''}`);
process.exit(fail ? 1 : 0);
