#!/usr/bin/env node
// tools/a11y-behaviour-gates.mjs — what a keyboard and a screen reader get,
// held in jsdom: where focus goes, what is said, which keys are whose.
//
// Run:  node tools/a11y-behaviour-gates.mjs
//
// WHY. tools/axe-gates.mjs measures every screen at rest in a browser. None of
// these show at rest: they happen when something changes. Each was a review
// finding on the first version of the keyboard and screen-reader work:
//   - a feed question answered earlier took focus when its card came back into
//     view (a reload, a return to the feed), and read its verdict again;
//   - the review session's first card never put focus on Reveal answer: the
//     session surface took focus as it opened, and that read as "the learner
//     is somewhere";
//   - the assistant read out the PREVIOUS answer when a turn ended with
//     nothing new (Stop, a dropped socket), and "snake_case" as "snake case";
//   - a picture the library does not hold asked the server again on every card;
//   - the outline's arrows did nothing on a drag handle with no drag going;
//   - a menu move said nothing, and a drag over a flat list named only the
//     neighbour, not the place;
//   - every outline row walked the whole node list on every store change.
// Each module is bundled on its own, so on a tree without a fix the checks
// that need it fail and the rest still run.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'MutationObserver', 'SVGSVGElement', 'HTMLCanvasElement']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
class Observer { observe() { } unobserve() { } disconnect() { } }
globalThis.ResizeObserver = window.ResizeObserver = Observer;
globalThis.IntersectionObserver = window.IntersectionObserver = Observer;
window.matchMedia = (q) => ({ matches: q === '(pointer: fine)', media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
window.HTMLElement.prototype.scrollIntoView = function () { };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const consoleError = console.error;
console.error = (...a) => { if (!/not wrapped in act/.test(String(a[0]))) consoleError(...a); };

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });
        export const initReactI18next = { type: '3rdParty', init() { } };`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: {
            addToast() { }, theme: 'light', searchProviders: [], projects: [], resources: [], nodes: [], currentProjectId: null,
            drillTimeScale: '1', setDrillTimeScale() { }, loadProjectData() { }, reorderNodes: async () => { },
            a11y: { readAloud: false },
        }, subs: new Set() };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;
        useStore.setState = (p) => { g.__st.state = { ...g.__st.state, ...(typeof p === 'function' ? p(g.__st.state) : p) }; g.__st.subs.forEach(f => f()); };
        useStore.subscribe = (f) => { g.__st.subs.add(f); return () => g.__st.subs.delete(f); };
        export const themeKeyOf = () => 'light';
        export const isDarkTheme = () => false;`,
    'Markdown': `import { createElement } from 'react'; export default function Markdown({ content }) { return createElement('div', null, content); }`,
    'MathText': `import { createElement } from 'react'; export default function MathText({ content }) { return createElement('span', null, content); }`,
    'codeLanguages': `import { createElement } from 'react'; export const highlightLanguage = (l) => l; export default function SyntaxHighlighter({ children }) { return createElement('pre', null, children); }`,
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
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*Markdown$/ }, () => ({ path: 'Markdown', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*MathText$/ }, () => ({ path: 'MathText', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*codeLanguages$/ }, () => ({ path: 'codeLanguages', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
    },
};

const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(cacheDir, 'a11y-behaviour-gates-'));
let bundles = 0;
/** One module, bundled alone; null (and a failed check) when it does not build. */
async function load(name, entry) {
    const out = join(scratch, `m${++bundles}.cjs`);
    try {
        await esbuild.build({
            stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
            bundle: true, format: 'cjs', platform: 'node', outfile: out,
            jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
            packages: 'external',
            define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
            plugins: [stubPlugin],
            logLevel: 'silent',
        });
        return require(out);
    } catch (e) {
        ok(`${name} builds`, false, String(e.message).split('\n').slice(0, 2).join(' | '));
        return null;
    }
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const h = React.createElement;
const act = (fn) => React.act(fn);
const settle = (ms = 30) => act(() => new Promise(r => setTimeout(r, ms)));
const doc = window.document;
async function mount(el) {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const r = createRoot(host);
    await act(() => r.render(el));
    return { host, rerender: (next) => act(() => r.render(next)), unmount: async () => { await act(() => r.unmount()); host.remove(); } };
}
const blur = () => { if (doc.activeElement && doc.activeElement !== doc.body) doc.activeElement.blur(); };

try {
    // -----------------------------------------------------------------------
    section('a feed question: its verdict takes focus and speaks only when it is GIVEN');
    const IQ = await load('InlineQuestion', `export { default } from './src/components/feed/InlineQuestion';`);
    if (IQ?.default) {
        const QUESTION = { uuid: '11111111-1111-4111-8111-111111111111', question: 'What is 2 + 9?', type: 'multiple_choice', options: ['10', '11', '12', '13'], correct_answer: '11', explanation: 'Nine and two.' };
        const card = (graded) => h(IQ.default, { question: QUESTION, graded, onGraded() { }, nodeId: 1 });
        const status = (host) => host.querySelector('[role="status"]')?.textContent ?? '';
        const verdictBox = (host) => [...host.querySelectorAll('[tabindex="-1"]')].find((e) => /Correct|Not quite/.test(e.textContent));

        blur();
        const back = await mount(card({ correct: true, answer: '11' }));
        await settle();
        ok('a card that mounts already answered leaves focus where it was (the page)', doc.activeElement === doc.body, doc.activeElement?.outerHTML?.slice(0, 80));
        ok('…and does not read its verdict again', status(back.host) === '', JSON.stringify(status(back.host)));
        await back.unmount();

        blur();
        const live = await mount(card(null));
        await settle();
        await live.rerender(card({ correct: false, answer: '12' }));
        await settle();
        ok('a verdict given on screen takes the focus the Check button lost', doc.activeElement === verdictBox(live.host), doc.activeElement?.outerHTML?.slice(0, 80));
        ok('…and is said once', status(live.host) === 'Not quite', JSON.stringify(status(live.host)));
        await live.unmount();

        const other = doc.createElement('button'); other.textContent = 'elsewhere'; doc.body.append(other);
        const moved = await mount(card(null));
        other.focus();
        await moved.rerender(card({ correct: true, answer: '11' }));
        await settle();
        ok('focus the learner put on another control stays there', doc.activeElement === other);
        ok('…and the verdict is still said', status(moved.host) === 'Correct', JSON.stringify(status(moved.host)));
        await moved.unmount();
        other.remove();
    }
    ok('InlineQuestion moves focus through useArrivalFocus, not on every render with a verdict',
        /useArrivalFocus</.test(read('src/components/feed/InlineQuestion.tsx')));

    // -----------------------------------------------------------------------
    section('focus that nothing holds: where a screen may move it on from');
    const A = await load('utils/a11y', `export * from './src/utils/a11y';`);
    if (A) {
        const has = typeof A.focusIsLost === 'function';
        ok('focusIsLost exists', has);
        if (has) {
            const surface = doc.createElement('div'); surface.tabIndex = -1; surface.setAttribute('data-owns-keyboard', '');
            const btn = doc.createElement('button'); surface.append(btn); doc.body.append(surface);
            ok('the body: lost', A.focusIsLost(doc.body));
            ok('nothing at all: lost', A.focusIsLost(null));
            ok('the review session surface, focused as it opens: lost (Reveal answer may take it)', A.focusIsLost(surface));
            ok('a button inside it: NOT lost', !A.focusIsLost(btn));
            surface.remove();
        }
    }
    ok('the review session uses it for its Reveal / ratings focus',
        /const lost = focusIsLost\(active\)/.test(read('src/components/GlobalFlashcardReview.tsx')));

    section('one polite region says what a menu move did');
    if (A && typeof A.announce === 'function') {
        A.announce('Moved Waves to position 2 of 3.');
        await new Promise((r) => setTimeout(r, 150));
        const region = doc.querySelector('[data-announcer]');
        ok('a polite, atomic live region', region?.getAttribute('aria-live') === 'polite' && region?.getAttribute('aria-atomic') === 'true');
        ok('it holds the words', region?.textContent === 'Moved Waves to position 2 of 3.', region?.textContent);
        ok('it is hidden from sight', region?.style.position === 'absolute' && region?.style.width === '1px' && /rect/.test(region?.style.clip ?? ''));
        A.announce('Moved Waves to position 2 of 3.');
        ok('the same words again empty it first, so they are a change', region?.textContent === '');
        await new Promise((r) => setTimeout(r, 150));
        ok('…and come back', region?.textContent === 'Moved Waves to position 2 of 3.');
        ok('one region for the page, not one per message', doc.querySelectorAll('[data-announcer]').length === 1);
    } else ok('announce exists', false);

    // -----------------------------------------------------------------------
    section('the assistant: the finished answer, said as words');
    const S = await load('speakable', `export * from './src/utils/speakable';`);
    if (S?.speakable) {
        const say = (md) => S.speakable(md).text;
        ok('snake_case stays one word', say('Call my_func_name now.') === 'Call my_func_name now.', say('Call my_func_name now.'));
        ok('2*3*4 stays a product', say('It is 2*3*4 = 24.') === 'It is 2*3*4 = 24.', say('It is 2*3*4 = 24.'));
        ok('bold and italic lose their marks', say('A **strong** and *soft* and _quiet_ word.') === 'A strong and soft and quiet word.', say('A **strong** and *soft* and _quiet_ word.'));
        ok('a heading, a list and a quote read as their words', say('## Plan\n- one\n- two\n> said') === 'Plan one two said', say('## Plan\n- one\n- two\n> said'));
        ok('a link reads as its text', say('See [the guide](https://x.example/a_b).') === 'See the guide.', say('See [the guide](https://x.example/a_b).'));
        ok('code keeps its words, not its backticks', say('Run `npm test` then\n```js\nlet a_b = 1;\n```') === 'Run npm test then let a_b = 1;', say('Run `npm test` then\n```js\nlet a_b = 1;\n```'));
        ok('a table reads cell by cell', say('| a | b |\n|---|---|\n| 1 | 2 |') === 'a, b 1, 2', JSON.stringify(say('| a | b |\n|---|---|\n| 1 | 2 |')));
        const long = Array.from({ length: 300 }, (_, i) => `Sentence ${i} is here.`).join(' ');
        const cut = S.speakable(long);
        ok('a long answer is cut, and says so', cut.cut && cut.text.length <= 2000);
        ok('…at the end of a sentence', /\.$/.test(cut.text), cut.text.slice(-30));
        ok('a short one is whole', !S.speakable('Short.').cut);
    } else ok('speakable exists', false);
    {
        const src = read('src/components/AssistantDrawer.tsx');
        ok('nothing is said on the stream ending itself (it re-read the previous answer)', !/wasStreaming/.test(src));
        const appends = [...src.matchAll(/setMessages\(prev => \[\.\.\.prev, \{\s*id: assistantId, role: 'assistant'[\s\S]*?\} as ChatMessage\]\);\s*say\(/g)].length;
        ok('both places a finished answer is put in the list say it (a send, a followed turn)', appends === 2, `${appends} of 2`);
        ok('a turn that finished while its socket was down is said from the history', /status === 'done' && last\?\.role === 'assistant'[^\n]*say\(last\.content\)/.test(src));
        ok('what is said is the readable answer (no app markers)', /speakable\(readableAnswer\(content\)\)/.test(src));
        ok('a failed turn is a role="alert" card (said on arrival)', /role="alert"/.test(read('src/components/ChatTurnError.tsx')));
    }

    // -----------------------------------------------------------------------
    section('a picture\'s stored description: asked once, a missing file not again');
    const MD = await load('mediaDescriptions', `export * from './src/utils/mediaDescriptions';`);
    if (MD?.storedInfo) {
        let calls = 0;
        const answer = (fn) => (hash) => { calls++; return fn(hash); };
        const info = (description) => ({ hash: 'h', filename: 'f.png', kind: 'image', description, described_by: description ? 'author' : null });
        const notFound = answer(() => Promise.reject(Object.assign(new Error('Not found'), { status: 404 })));
        ok('a file the library does not hold gives nothing', (await MD.storedInfo('gone', notFound)) === null);
        await MD.storedInfo('gone', notFound);
        ok('…and is not asked again (a 404 is final)', calls === 1, `${calls} requests`);
        calls = 0;
        const offline = answer(() => Promise.reject(new TypeError('Failed to fetch')));
        await MD.storedInfo('flaky', offline);
        await MD.storedInfo('flaky', offline);
        ok('a network failure is forgotten, so the next card asks again', calls === 2, `${calls} requests`);
        calls = 0;
        const busy = answer(() => Promise.reject(Object.assign(new Error('Server error'), { status: 503 })));
        await MD.storedInfo('busy', busy);
        await MD.storedInfo('busy', busy);
        ok('so is a 5xx', calls === 2, `${calls} requests`);
        calls = 0;
        const notYet = answer(() => Promise.resolve(info(null)));
        await MD.storedInfo('later', notYet);
        await MD.storedInfo('later', notYet);
        ok('a picture not described yet is asked again (the sweep may reach it)', calls === 2, `${calls} requests`);
        calls = 0;
        const has = answer(() => Promise.resolve(info('A red planet.')));
        ok('a description is read', (await MD.storedInfo('mars', has))?.description === 'A red planet.');
        await MD.storedInfo('mars', has);
        ok('…once per page load', calls === 1);
        MD.forgetStoredInfo('mars');
        await MD.storedInfo('mars', has);
        ok('…until it is edited and forgotten', calls === 2);
        for (let i = 0; i < MD.MAX_KEPT + 50; i++) await MD.storedInfo(`f${i}`, () => Promise.resolve(info('d')));
        ok(`at most ${MD.MAX_KEPT} files are remembered`, MD.keptCount() === MD.MAX_KEPT, `${MD.keptCount()}`);
    } else ok('storedInfo exists', false);
    ok('CardMedia reads descriptions through it', /keptInfo\(hash, api\.mediaInfo\)/.test(read('src/components/CardMedia.tsx')));

    // -----------------------------------------------------------------------
    section('drag and menu moves: whose keys, and what is said');
    const D = await load('useDragA11y', `export * from './src/hooks/useDragA11y';`);
    if (D) {
        const kb = typeof D.keyBelongsToDrag === 'function' ? D.keyBelongsToDrag : null;
        ok('keyBelongsToDrag exists', !!kb);
        if (kb) {
            ok('a resting handle: the tree\'s arrows still move', !kb('ArrowDown', true, false) && !kb('ArrowRight', true, false));
            ok('a resting handle: Escape is still the tree\'s', !kb('Escape', true, false));
            ok('a resting handle: Space and Enter pick it up', kb(' ', true, false) && kb('Enter', true, false));
            ok('during a drag every key is the drag\'s', kb('ArrowDown', true, true) && kb('Escape', false, true));
            ok('a title, no drag: nothing is the drag\'s', !kb('Enter', false, false) && !kb('ArrowUp', false, false));
        }
        ok('the outline sidebar asks it, with whether a drag is on',
            /keyBelongsToDrag\(e\.key, onHandle, dragging\.current\)/.test(read('src/components/Sidebar.tsx')));

        // The announcements, read from a mounted hook.
        let a11y = null;
        const names = { 1: 'Waves', 2: 'Light', 3: 'Sound' };
        const Host = ({ positions }) => { a11y = D.useDragA11y((id) => names[id], positions ? { positions: true } : undefined); return null; };
        const spot = (id, index) => ({ id, data: { current: { sortable: { containerId: 'list', index, items: [1, 2, 3] } } } });
        const flat = await mount(h(Host, { positions: true }));
        const over = a11y.announcements.onDragOver({ active: spot(1, 0), over: spot(3, 2) });
        ok('a flat list says the place as a number', over === 'Waves is at position 3 of 3.', over);
        const end = a11y.announcements.onDragEnd({ active: spot(1, 0), over: spot(2, 1) });
        ok('…and where it was dropped', end === 'Dropped Waves at position 2 of 3.', end);
        const off = a11y.announcements.onDragOver({ active: spot(1, 0), over: null });
        ok('over nothing: says so', off === 'Waves is not over a place to drop it.', off);
        await flat.unmount();
        const tree = await mount(h(Host, { positions: false }));
        const treeOver = a11y.announcements.onDragOver({ active: spot(1, 0), over: spot(3, 2) });
        ok('a tree names the row it is over (its place is a depth too)', treeOver === 'Waves is over Sound.', treeOver);
        await tree.unmount();

        // A menu move, said through the page's region.
        const st = globalThis.__st;
        const writes = [];
        st.state = { ...st.state, reorderNodes: async (ids, parent, moved) => { writes.push({ ids, parent, moved }); },
            nodes: [
                { id: 1, title: 'Waves', parent_id: 9, project_id: 5, position: 0 },
                { id: 2, title: 'Light', parent_id: 9, project_id: 5, position: 1 },
                { id: 3, title: 'Sound', parent_id: 9, project_id: 5, position: 2 },
                { id: 4, title: 'Other', parent_id: 8, project_id: 5, position: 0 },
            ] };
        let move = null;
        const Row = ({ id }) => { move = D.useSiblingMove(st.state.nodes.find((n) => n.id === id)); return null; };
        const row = await mount(h(Row, { id: 1 }));
        ok('the first of three: no Move up, a Move down', move.up === null && typeof move.down === 'function');
        await act(() => move.down());
        await settle(150);
        ok('Move down writes the swapped order under the same parent', JSON.stringify(writes[0]) === JSON.stringify({ ids: [2, 1, 3], parent: 9, moved: 1 }), JSON.stringify(writes[0]));
        ok('…and says where the item went', doc.querySelector('[data-announcer]')?.textContent === 'Moved Waves to position 2 of 3.', doc.querySelector('[data-announcer]')?.textContent);
        await row.unmount();

        if (typeof D.siblingEnds === 'function') {
            const ends = D.siblingEnds(st.state.nodes);
            ok('siblingEnds: first, middle, last, an only child', ends.get(1) === 'd' && ends.get(2) === 'ud' && ends.get(3) === 'u' && ends.get(4) === '', JSON.stringify([...ends]));
            ok('one pass per node list, shared by every row that asks', D.siblingEnds(st.state.nodes) === ends);
            ok('a new list is read again', D.siblingEnds([...st.state.nodes]) !== ends);
        } else ok('siblingEnds exists', false);
    }
    {
        const grid = read('src/components/ProjectsGrid.tsx');
        const list = read('src/components/ResourceList.tsx');
        ok('the projects grid counts positions, and its menu move says where', /useDragA11y\(projectName, \{ positions: true \}\)/.test(grid) && /sayMoved\(/.test(grid.slice(grid.indexOf('const swapProjects'))));
        ok('the resource list counts positions, and its menu move says where', /useDragA11y\(resourceTitle, \{ positions: true \}\)/.test(list) && /sayMoved\(/.test(list.slice(list.indexOf('const moveHandlers'))));
    }

    // -----------------------------------------------------------------------
    section('keys already in the PR, held here');
    const F = await load('formats', `export { submitOnEnter } from './src/components/answer/formats';`);
    if (F?.submitOnEnter) {
        let sent = 0; let stopped = 0;
        const on = F.submitOnEnter(() => { sent++; });
        const press = (key, extra = {}) => on({ key, shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() { stopped++; }, ...extra });
        press('Enter');
        ok('Enter in a one-line answer submits it', sent === 1 && stopped === 1);
        press('Enter', { nativeEvent: { isComposing: true } });
        ok('…not while an input method is composing', sent === 1);
        press('Enter', { shiftKey: true });
        ok('…not with Shift', sent === 1);
        press('a');
        ok('…and no other key', sent === 1);
        ok('no submit handler: no key handler at all', F.submitOnEnter(undefined) === undefined);
    }
    const K = await load('useFlashcardKeys', `export { useFlashcardKeys } from './src/hooks/useFlashcardKeys'; export { setSingleKeyShortcuts } from './src/utils/escapeKey';`);
    if (K?.useFlashcardKeys) {
        let flips = 0, undos = 0;
        const Session = () => { K.useFlashcardKeys({ onFlip: () => { flips++; }, onRate() { }, onUndo: () => { undos++; } }); return h('button', { id: 'own' }, 'Edit'); };
        const s = await mount(h(Session));
        const key = (target, k, extra = {}) => act(() => { target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })); });
        await key(doc.body, ' ');
        ok('Space on the page flips the card', flips === 1, `${flips}`);
        await key(s.host.querySelector('#own'), ' ');
        ok('Space on a focused button is the button\'s (no flip)', flips === 1, `${flips}`);
        K.setSingleKeyShortcuts(false);
        await key(doc.body, ' ');
        await key(doc.body, 'z');
        ok('single-key shortcuts off: Space and z do nothing', flips === 1 && undos === 0, `${flips} flips, ${undos} undos`);
        await key(doc.body, 'z', { ctrlKey: true });
        ok('…and Ctrl+Z still undoes', undos === 1, `${undos}`);
        K.setSingleKeyShortcuts(true);
        await s.unmount();
    }

    // -----------------------------------------------------------------------
    section('the axe gate: what it waits for, what it reports, how its list moves');
    const lib = join(root, 'tools', 'lib', 'axeScreens.mjs');
    const L = existsSync(lib) ? await import(pathToFileURL(lib).href) : null;
    ok('tools/lib/axeScreens.mjs exists', !!L);
    const axe = read('tools/axe-gates.mjs');
    const table = /const SCREENS = \{([\s\S]*?)\n\};/.exec(axe)?.[1] ?? '';
    const screens = [...table.matchAll(/^ {4}'?([\w-]+)'?\s*:/gm)].map((m) => m[1]);
    ok('the screen table is read', screens.length >= 15, `${screens.length} screens`);
    if (L) {
        const none = screens.filter((s) => !L.readyFor(s));
        ok('every scanned screen names what it draws once loaded', !none.length, none.join(', '));
        ok('a settings screen added later is covered too', !!L.readyFor('settings-something-new'));
        ok('the scan waits on it before axe runs', /page\.waitFor\(readyFor\(screen\)/.test(axe));
        ok('an error page is caught, not scanned as clean', /BROKEN/.test(axe) && /Something went wrong/.test(L.BROKEN));
        const r1 = L.acceptAllowlist({}, { 'home light-desktop': { 'color-contrast': 3 } });
        ok('--accept refuses to raise an EMPTY allowlist', !!r1.refused && /home light-desktop color-contrast: 0 -> 3/.test(r1.refused[0] ?? ''), JSON.stringify(r1));
        const r2 = L.acceptAllowlist({ 'home light-desktop': { 'color-contrast': 3, 'region': 1 } }, { 'home light-desktop': { 'color-contrast': 2 } });
        ok('--accept lowers a number and drops a rule gone to zero', !r2.refused && JSON.stringify(r2.allowed) === JSON.stringify({ 'home light-desktop': { 'color-contrast': 2 } }), JSON.stringify(r2));
        const r3 = L.acceptAllowlist({ 'home light-desktop': { 'color-contrast': 1 } }, { 'home light-desktop': {} });
        ok('a screen with nothing left leaves the list', !r3.refused && !('home light-desktop' in r3.allowed));
        const r4 = L.acceptAllowlist({}, { 'home light-desktop': { 'color-contrast': 3 } }, { bootstrap: true });
        ok('--bootstrap writes a rise, and names it', !r4.refused && r4.allowed['home light-desktop']['color-contrast'] === 3 && r4.raised.length === 1);
    }
    ok('axe\'s undecided results are asked for and counted', /resultTypes: \['violations', 'incomplete'\]/.test(axe) && /could not decide/.test(axe));
} finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
