#!/usr/bin/env node
// explain-back-gates.mjs — what the explain-back block offers after each verdict.
//
// After a part, the learner may explain it back; the model marks it. What the
// block offers next is the whole design: one filled button, the next step, and
// never a button that marks the same words twice. Mounted in jsdom from the
// real component, with the marker answered by a stub:
//
//   1. before any verdict: no button until the first word, then one
//      "Check my explanation", not filled;
//   2. weak on unchanged words: "Read the part again" filled and alone (a
//      "Check again" that is off until you type read as broken);
//   3. weak, words rewritten: "Check again" filled and alone (three stacked
//      buttons with the part's own "Continue anyway"), and the old verdict folds to one grey "Before your edit:" line (a
//      reason left in full read as the mark of the new words);
//   4. a pass on unchanged words: no check button at all;
//   5. "Not marked": "Check again" stays without an edit;
//   6. the parent hears each verdict, and `null` when the block goes away;
//   7. a verdict that lands after the block is gone is dropped;
//   8. focus moves back to the text only after a KEYBOARD check whose button
//      went away, never after a tap (a phone would raise its keyboard);
//   9. a failed check keeps the words; a whitespace edit is not a rewrite.
//
// Mounted under StrictMode, as the app runs. Check 5 and the failure checks pass
// on the component before this design too: they guard against overcorrecting.
//
//   node tools/explain-back-gates.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'SVGSVGElement']) if (window[k]) globalThis[k] = window[k];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const consoleError = console.error;
console.error = (...a) => { if (!/not wrapped in act/.test(String(a[0]))) consoleError(...a); };

const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(cacheDir, 'explain-back-gates-'));
const out = join(scratch, 'bundle.cjs');
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* held on Windows */ } });

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });
        export const initReactI18next = { type: '3rdParty', init() { } };`,
    'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => (globalThis.__api?.[name] ?? (() => new Promise(() => { })))(...args) });
        let n = 0; export const newAttemptId = () => 'attempt-' + (++n);`,
    'store': `export const useStore = (sel) => sel({}); useStore.getState = () => ({}); useStore.setState = () => { };
        export const isDarkTheme = () => false; export const themeKeyOf = () => 'light';`,
    'css': '',
    'none': 'export default function None() { return null; }',
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        // The question renderers belong to the pre-questions beside it, and
        // pull in a highlighter that does not load under Node.
        b.onResolve({ filter: /^\.\.\/QuestionStem$|^\.\.\/answer\/AnswerInput$/ }, () => ({ path: 'none', namespace: 'stub' }));
        // A package's stylesheet (KaTeX's) would be required as JavaScript.
        b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
    },
};

let ExplainBack = null;
try {
    await esbuild.build({
        stdin: { contents: `export { ExplainBack } from './src/components/feed/LessonPrompts';`, resolveDir: root, loader: 'tsx' },
        bundle: true, format: 'cjs', platform: 'node', outfile: out,
        jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' }, packages: 'external',
        define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
        plugins: [stubPlugin], logLevel: 'silent',
    });
    ({ ExplainBack } = require(out));
} catch (e) {
    console.log(`  (could not bundle the block: ${String(e.stack).split('\n').slice(0, 4).join(' | ')})`);
}
ok('the block bundles', !!ExplainBack);

const React = require('react');
const { createRoot } = require('react-dom/client');
const h = React.createElement;
const act = (fn) => React.act(fn);
const settle = (ms = 20) => act(() => new Promise(r => setTimeout(r, ms)));

/** The block's own buttons, in order: `*` the filled one, `(off)` disabled
 *  (an empty box disables the check button too, so the opening state is
 *  typed into before it is read). */
const buttons = (host) => [...host.querySelectorAll('details button')]
    .map(b => `${b.textContent.trim()}${/\bbg-accent\b/.test(b.className) ? '*' : ''}${b.disabled ? '(off)' : ''}`);
const setText = async (host, value) => {
    const box = host.querySelector('textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    await act(async () => { set.call(box, value); box.dispatchEvent(new window.Event('input', { bubbles: true })); });
};
/** A tap (`detail` 1), or with `keyboard` the button focused and pressed
 *  from the keyboard (a click with `detail` 0, as Enter and Space give). */
const press = async (host, label, { keyboard = false } = {}) => {
    const b = [...host.querySelectorAll('details button')].find(x => x.textContent.trim() === label);
    if (!b) return false;
    if (keyboard) b.focus();
    await act(async () => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: keyboard ? 0 : 1 })); });
    await settle();
    return true;
};

/** Mounts the block open under StrictMode, as the app runs it, answering each
 *  check with the next verdict in `answers` (or with `marker`). StrictMode's
 *  trial unmount reports one `null` first. */
async function mount(answers, marker) {
    const heard = [];
    const queue = [...answers];
    globalThis.__api = { explainBack: marker ?? (() => Promise.resolve(queue.shift())) };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    await act(() => r.render(h(React.StrictMode, null, h(ExplainBack, { feedItemId: 7, onReread() { }, onVerdict: v => heard.push(v) }))));
    host.querySelector('details').open = true;
    return { host, r, heard };
}
const WEAK = { verdict: 'weak', reason: 'Mass does not set the period.' };
const GOOD = { verdict: 'good', reason: 'Length sets it.' };
const UNSURE = { verdict: 'unsure', reason: '' };

if (ExplainBack) {
    {
        const { host, r, heard } = await mount([WEAK, GOOD]);
        ok('nothing typed: no check button yet (an off button read as broken)', buttons(host).length === 0, JSON.stringify(buttons(host)));
        ok('nothing typed: the empty box says what to type', !!host.querySelector('textarea')?.getAttribute('placeholder'));
        await setText(host, 'Heavier swings slower.');
        ok('before a verdict: one check button, not filled', JSON.stringify(buttons(host)) === '["Check my explanation"]', JSON.stringify(buttons(host)));
        await press(host, 'Check my explanation');
        ok('weak on unchanged words: "Read the part again" filled and alone', JSON.stringify(buttons(host)) === '["Read the part again*"]', JSON.stringify(buttons(host)));
        ok('weak on unchanged words: a line says how to check again', host.textContent.includes('Change your words to check them again.'));
        await setText(host, 'The length sets the period, not the mass.');
        ok('weak, rewritten: one filled "Check again", nothing beside it', JSON.stringify(buttons(host)) === '["Check again*"]', JSON.stringify(buttons(host)));
        const label = () => [...host.querySelectorAll('p')].find(p => p.textContent.includes('Not there yet'));
        ok('weak, rewritten: the old verdict loses its warning colour', !!label() && !/amber/.test(label().className), label()?.className);
        ok('weak, rewritten: the old verdict says it is about the earlier words', /^Before your edit: Not there yet$/.test(label()?.textContent.trim() ?? ''), label()?.textContent);
        ok('weak, rewritten: the old reason folds away (it read as the mark of the new words)', ![...host.querySelectorAll('p')].some(p => p.textContent === WEAK.reason));
        ok('weak, rewritten: the folded line is kept out of the live region (no read-out per keystroke)', label()?.getAttribute('aria-hidden') === 'true', label()?.outerHTML.slice(0, 80));
        await setText(host, '');
        ok('weak, box emptied: no "Check again" that is off, back to the one filled step', JSON.stringify(buttons(host)) === '["Read the part again*"]', JSON.stringify(buttons(host)));
        await setText(host, 'The length sets the period, not the mass.');
        await press(host, 'Check again');
        ok('a pass on unchanged words: no check button', buttons(host).length === 0, JSON.stringify(buttons(host)));
        await setText(host, 'The length sets the period.');
        ok('a pass, then an edit: "Check again" comes back, not filled', JSON.stringify(buttons(host)) === '["Check again"]', JSON.stringify(buttons(host)));
        await act(() => r.unmount());
        ok('the parent heard weak, good, then null on unmount', JSON.stringify(heard) === '[null,"weak","good",null]', JSON.stringify(heard));
        host.remove();
    }
    {
        const { host, r } = await mount([UNSURE]);
        await setText(host, 'Something about swinging.');
        await press(host, 'Check my explanation');
        ok('"Not marked": "Check again" stays without an edit', JSON.stringify(buttons(host)) === '["Check again"]', JSON.stringify(buttons(host)));
        await act(() => r.unmount());
        host.remove();
    }
    {
        const { host, r } = await mount([WEAK, WEAK]);
        await setText(host, 'Heavier swings slower.');
        await press(host, 'Check my explanation');
        ok('a tap leaves focus where it is (no phone keyboard over the verdict)', document.activeElement !== host.querySelector('textarea'));
        await setText(host, 'Heavier swings slower, I think.');
        await press(host, 'Check again', { keyboard: true });
        ok('a keyboard check whose button went off puts focus back in the text', document.activeElement === host.querySelector('textarea'), document.activeElement?.tagName);
        await setText(host, 'Heavier swings slower, I think. ');
        ok('a whitespace-only edit is not a rewrite', JSON.stringify(buttons(host)) === '["Read the part again*"]', JSON.stringify(buttons(host)));
        await act(() => r.unmount());
        host.remove();
    }
    {
        const { host, r } = await mount([], () => Promise.reject(new Error('offline')));
        await setText(host, 'Heavier swings slower.');
        await press(host, 'Check my explanation');
        ok('a failed check keeps the words and says so', host.querySelector('textarea').value === 'Heavier swings slower.' && /Your text is kept/.test(host.textContent));
        await setText(host, 'Heavier swings slower!');
        ok('…and an edit clears the failure', !/Your text is kept/.test(host.textContent));
        await act(() => r.unmount());
        host.remove();
    }
    {
        // The marker answers only after the block is gone.
        let resolveLate;
        const { host, r, heard } = await mount([], () => new Promise(res => { resolveLate = res; }));
        await setText(host, 'Heavier swings slower.');
        await press(host, 'Check my explanation');
        await act(() => r.unmount());
        await act(async () => { resolveLate(WEAK); });
        await settle();
        ok('a verdict after the block is gone is dropped', JSON.stringify(heard) === '[null,null]', JSON.stringify(heard));
        host.remove();
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
