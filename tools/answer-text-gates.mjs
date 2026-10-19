// tools/answer-text-gates.mjs — what Copy puts on the clipboard.
//
// Run:  node tools/answer-text-gates.mjs [--markdown <path to a Markdown.tsx>]
//
// Four marker conventions now live in a stored assistant message, because a
// model cannot be trusted to write a control: `[[mastery-check]]` /
// `[[next-topic]]` become the tutor's buttons, `[[open:p:n]]` becomes the
// assistant's topic chips, `[[set:key:value]]` its settings chips, `[[src:N]]`
// a citation. Rendering strips the markers a surface knows about, and Copy is
// the same boundary in a different direction: handing over `msg.content`, the
// raw row, would paste `[[next-topic]]` into whatever notes the answer lands
// in. So Copy goes through one function that knows all four, and the
// assertions below are as much about what it must NOT remove: a fenced spec is
// the diagram's source and belongs in a paste, and the resolved sources line
// is attribution that should travel with the text it supports.

import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const scratch = mkdtempSync(join(tmpdir(), 'answer-text-gates-'));
const out = join(scratch, 'answerText.mjs');

await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/answerText.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
    // assistantSettings reaches the store only for its constants.
    plugins: [{
        name: 'stub-store',
        setup(build) {
            build.onResolve({ filter: /\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }));
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                contents: `
                    export const THEME_IDS = ['light', 'warm', 'dark', 'black'];
                    export const MIN_UI_SCALE = 80;
                    export const MAX_UI_SCALE = 160;
                `,
                loader: 'js',
            }));
        },
    }],
});

const { readableAnswer } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

section('every marker convention is stripped, whichever surface owns it');
const cases = {
    'a tutor action': 'You have this now.\n\n[[next-topic]]',
    'a mastery-check offer': 'Ready when you are.\n\n[[mastery-check]]',
    'an assistant topic chip': 'Start with vectors. [[open:3:41]]',
    'a settings change': 'Switching to dark. [[set:theme:dark]]',
    'a grounding marker': 'The rule is three figures. [[src:2]]',
};
for (const [name, text] of Object.entries(cases)) {
    const copied = readableAnswer(text);
    check(`${name} never reaches the clipboard`, !copied.includes('[['), JSON.stringify(copied));
    check(`${name} leaves its sentence intact`, copied.length > 0 && !copied.endsWith('['));
}
const all = readableAnswer('Done. [[src:1]] Next up. [[open:3:41]] [[set:theme:dark]]\n\n[[next-topic]]');
check('all four in one message', !all.includes('[['), JSON.stringify(all));
check('and the prose survives', all.includes('Done.') && all.includes('Next up.'), JSON.stringify(all));

section('what a paste must KEEP');
const withVisual = 'Here is the shape:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nRead it top down. [[src:1]]';
const copiedVisual = readableAnswer(withVisual);
check('a fenced spec is the answer, not scaffolding', copiedVisual.includes('```mermaid') && copiedVisual.includes('A --> B'));
const withSources = 'The rule is three figures.\n\n---\nSources: Lecture notes week 3 · [Exam board notice](https://example.org/x)';
check('the resolved sources line travels with the text', readableAnswer(withSources) === withSources,
    JSON.stringify(readableAnswer(withSources)));
check('ordinary markdown is untouched',
    readableAnswer('**Bold**, $x^2$, a [link](https://example.org) and a list:\n\n* one\n* two')
    === '**Bold**, $x^2$, a [link](https://example.org) and a list:\n\n* one\n* two');

section('the edges');
check('empty in, empty out', readableAnswer('') === '');
check('a non-string is survivable', readableAnswer(undefined) === '' && readableAnswer(null) === '');
check('a message that is ONLY a marker copies as nothing',
    readableAnswer('[[next-topic]]') === '', JSON.stringify(readableAnswer('[[next-topic]]')));
// Mid-stream the text can end inside a marker; a Copy offered then must not
// paste half of one.
check('a half-written marker is stripped while streaming',
    readableAnswer('Almost done. [[next-to', true) === 'Almost done.',
    JSON.stringify(readableAnswer('Almost done. [[next-to', true)));
check('trailing whitespace left by a removed marker is trimmed',
    !/\s$/.test(readableAnswer('Answer here.\n\n[[mastery-check]]\n\n')));

check('a formula is copied as its TeX, exactly as it was written',
    readableAnswer('Speed is $v = \\frac{d}{t}$, and\n\n$$E = mc^2$$') === 'Speed is $v = \\frac{d}{t}$, and\n\n$$E = mc^2$$');

// ---------------------------------------------------------------------------
// The other way text leaves an answer: the learner SELECTS part of it and
// copies. Without a handler the browser serialises KaTeX's rendered glyphs —
// every symbol twice (the hidden MathML, then the drawn HTML), a fraction's
// halves on separate lines — so a pasted formula is unreadable.
// `src/utils/copyTex.ts`, imported by Markdown.tsx and MathText.tsx, swaps
// each formula in the selection for its TeX source. The real component is
// rendered here (its visual and drill blocks stubbed, they are not the
// subject) and a copy event is dispatched over a real selection. jsdom lays
// nothing out, so it has no `innerText` and the paragraph breaks are checked
// in Edge instead. `--markdown <file>` runs it against another copy: HEAD's
// has no handler and fails the checks that need one (a selection with no
// formula and the MathText import pass there), and one importing
// `katex/contrib/copy-tex` fails the word-joiner, rich-text and
// selection-widening checks.
section('a selection with formulas in it copies as TeX');
{
    const mdAt = process.argv.indexOf('--markdown');
    const mdPath = mdAt !== -1 ? resolve(process.argv[mdAt + 1]) : fileURLToPath(new URL('../src/components/Markdown.tsx', import.meta.url));
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    // A browser's own stylesheet hides MathML's TeX annotation; jsdom has none,
    // so it is written here, or a rule about hidden content passes in jsdom and
    // strips every formula's TeX in Edge (it did).
    const dom = new JSDOM('<!doctype html><html><head><style>annotation{display:none}</style></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
    for (const k of ['window', 'document', 'navigator', 'localStorage', 'Element', 'Text', 'Node', 'HTMLElement', 'matchMedia']) {
        try { globalThis[k] = dom.window[k]; } catch { /* a read-only global in this Node */ }
    }
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    // Inside node_modules so the few packages left external resolve; CJS
    // because some dependencies `require` Node built-ins.
    mkdirSync(join(repoRoot, 'node_modules', '.cache'), { recursive: true });
    const mdScratch = mkdtempSync(join(repoRoot, 'node_modules', '.cache', 'answer-text-md-'));
    const mdOut = join(mdScratch, 'md.cjs');
    await esbuild.build({
        stdin: {
            contents: "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import Markdown from 'MARKDOWN';"
                + 'export const render = (content) => renderToStaticMarkup(createElement(Markdown, { content }));',
            resolveDir: repoRoot, loader: 'js',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: mdOut, jsx: 'automatic', logLevel: 'silent',
        loader: { '.css': 'empty' },
        define: { 'import.meta.env.DEV': 'false' },
        // Reached only through dynamic imports of renderers this never draws.
        external: ['vega-embed', 'vega', 'vega-lite', 'mermaid', 'p5', 'smiles-drawer', '@observablehq/plot'],
        plugins: [{
            name: 'markdown-under-test',
            setup(b) {
                b.onResolve({ filter: /^MARKDOWN$/ }, () => ({ path: mdPath, namespace: 'markdown' }));
                b.onLoad({ filter: /.*/, namespace: 'markdown' }, (a) => ({ contents: readFileSync(a.path, 'utf8'), loader: 'tsx', resolveDir: join(repoRoot, 'src/components') }));
                b.onResolve({ filter: /^\.\/(visuals\/VisualBlock|drills\/DrillLauncher)$/ }, () => ({ path: 'blocks', namespace: 'stub-blocks' }));
                b.onLoad({ filter: /.*/, namespace: 'stub-blocks' }, () => ({ contents: 'export default function Block(){return null;} export function DrillLauncher(){return null;}', loader: 'js' }));
            },
        }],
    });
    const { render } = createRequire(import.meta.url)(mdOut);
    const doc = dom.window.document;
    doc.getElementById('root').innerHTML = render(String.raw`The speed is $v = \frac{d}{t}$ for a distance $d$, and the energy is

$$E = mc^2$$

so the units match.`);
    const copySelection = (setRange) => {
        const range = doc.createRange();
        setRange(range);
        const sel = dom.window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        // The live range is the selection's own object, so its ends are taken
        // now: a handler that widens it changes this very range.
        const before = [range.startContainer, range.startOffset, range.endContainer, range.endOffset];
        const data = {};
        const event = new dom.window.Event('copy', { bubbles: true, cancelable: true });
        event.clipboardData = { setData: (type, value) => { data[type] = value; } };
        doc.dispatchEvent(event);
        const after = sel.rangeCount ? sel.getRangeAt(0) : null;
        const kept = !!after && [after.startContainer, after.startOffset, after.endContainer, after.endOffset].every((v, i) => v === before[i]);
        return { plain: data['text/plain'], html: data['text/html'], prevented: event.defaultPrevented, kept };
    };
    const ps = doc.querySelectorAll('#root p');
    const last = ps[ps.length - 1].lastChild;
    const across = copySelection((r) => { r.setStart(ps[0].firstChild, 4); r.setEnd(last, last.textContent.length); });
    check('the copy is taken over (the browser\'s glyph text is not what lands)', across.prevented);
    check('an inline formula arrives as $…$ and a display one as $$…$$, the prose around them intact',
        typeof across.plain === 'string'
        && across.plain.includes(String.raw`speed is $v = \frac{d}{t}$ for a distance $d$`)
        && across.plain.includes('$$E = mc^2$$')
        && across.plain.trimEnd().endsWith('so the units match.'),
        JSON.stringify(across.plain));
    check('the word joiner that binds a formula to its comma is not pasted',
        typeof across.plain === 'string' && !across.plain.includes(String.fromCharCode(0x2060)) && across.plain.includes('$d$,'), JSON.stringify(across.plain));
    // A rich-text paste (a word processor, a mail) reads text/html: KaTeX's
    // markup there is the MathML and the glyphs, so the formula landed twice.
    check('the rich-text copy carries the TeX and none of the rendered formula',
        typeof across.html === 'string' && across.html.includes('$$E = mc^2$$')
        && !/katex|<math|annotation/.test(across.html), String(across.html).slice(0, 200));
    check("the learner's selection is left where they put it", across.kept);
    // A selection that starts INSIDE a formula takes the whole formula, never
    // half of its TeX.
    const inside = copySelection((r) => {
        const glyphs = doc.querySelector('#root p .katex-html');
        const textIn = doc.createTreeWalker(glyphs, dom.window.NodeFilter.SHOW_TEXT).nextNode();
        r.setStart(textIn, 0);
        r.setEnd(ps[0].lastChild, 3);
    });
    check('a selection that starts inside a formula copies the whole formula',
        typeof inside.plain === 'string' && inside.plain.startsWith(String.raw`$v = \frac{d}{t}$`), JSON.stringify(inside.plain));
    check('… without widening the selection on screen', inside.kept);
    const prose = copySelection((r) => { r.setStart(ps[ps.length - 1].firstChild, 0); r.setEnd(last, last.textContent.length); });
    check('a selection with no formula in it is left to the browser', !prose.prevented);
    // MathText draws questions, options and cards with KaTeX of its own; the
    // listener reaches it only if the module is loaded wherever MathText is.
    const mathText = readFileSync(fileURLToPath(new URL('../src/components/MathText.tsx', import.meta.url)), 'utf8');
    check('MathText loads the same copy handler', /^import '\.\.\/utils\/copyTex';/m.test(mathText));
    // What the browser's own copy would leave out: a label the learner cannot
    // select. And what must never be put into the page for the read: a frame
    // (a widget, which would load and run), media.
    const more = doc.createElement('div');
    doc.body.appendChild(more);
    more.innerHTML = render(String.raw`Mass $m$ here.

$$
a = 1 % first
+ 2
$$

The end.`);
    const firstP = more.querySelector('p');
    firstP.insertAdjacentHTML('beforeend', '<span style="user-select:none">[Copy]</span><span style="display:none">[hidden]</span><img alt="" src="data:," onerror="window.ran=1"><iframe srcdoc="<p>widget</p>"></iframe><video src="data:,"></video>');
    const attached = [];
    const watch = new dom.window.MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) attached.push(n); });
    watch.observe(doc.body, { childList: true });
    const endP = more.querySelectorAll('p')[1];
    const chrome = copySelection((r) => { r.setStart(firstP.firstChild, 0); r.setEnd(endP.firstChild, 3); });
    await new Promise((r) => setTimeout(r, 0));
    watch.disconnect();
    check('a label the learner cannot select is left out, as the browser leaves it out',
        typeof chrome.plain === 'string' && chrome.plain.includes('$m$') && !chrome.plain.includes('[Copy]')
        && !more.querySelector('[data-copy-tex-skip]'), JSON.stringify(chrome.plain));
    check('… and so is what is not shown (display: none)', typeof chrome.html === 'string' && !chrome.html.includes('[hidden]'), JSON.stringify(chrome.html));
    check('a picture is kept for the rich text, but not its inline handler',
        typeof chrome.html === 'string' && /<img /.test(chrome.html) && !/onerror/.test(chrome.html), JSON.stringify(chrome.html));
    check('no frame or media from the selection is put into the page, even for the read',
        attached.length > 0 && attached.every((n) => n.nodeType !== 1 || !n.querySelector('iframe,video'))
        && typeof chrome.html === 'string' && !/<iframe|<video/.test(chrome.html), `${attached.length} attached`);
    // A `%` comments out the rest of its TeX line, so the lines must survive
    // the read (jsdom has no innerText, so the plain half is read in Edge).
    check('a display formula keeps its line breaks',
        typeof chrome.html === 'string' && /<div style="white-space: pre-wrap;">\$\$a = 1 % first\n\+ 2\$\$<\/div>/.test(chrome.html), JSON.stringify(chrome.html));
    // A formula the learner could not select is not a reason to take the copy.
    const chromeOnly = doc.createElement('div');
    doc.body.appendChild(chromeOnly);
    chromeOnly.innerHTML = render('Plain text, then $x$ here.');
    const chromeP = chromeOnly.querySelector('p');
    const wrap = doc.createElement('span');
    wrap.style.userSelect = 'none';
    chromeP.querySelector('.katex').replaceWith(wrap);
    wrap.appendChild(chromeOnly.ownerDocument.importNode(more.querySelector('.katex'), true));
    const onlyChrome = copySelection((r) => { r.setStart(chromeP.firstChild, 0); r.setEnd(chromeP.lastChild, chromeP.lastChild.textContent.length); });
    check('a selection whose only formula cannot be selected is left to the browser', !onlyChrome.prevented, JSON.stringify(onlyChrome.plain));
    // A copy from a field is the field's own text, however it is selected.
    const field = doc.createElement('textarea');
    doc.body.appendChild(field);
    const range = doc.createRange();
    range.setStart(firstP.firstChild, 0);
    range.setEnd(endP.firstChild, 3);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(range);
    const fromField = new dom.window.Event('copy', { bubbles: true, cancelable: true });
    fromField.clipboardData = { setData() {} };
    field.dispatchEvent(fromField);
    check('a copy inside a text field is left to the browser', !fromField.defaultPrevented);
    rmSync(mdScratch, { recursive: true, force: true });
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
