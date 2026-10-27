// tools/stem-lines-gates.mjs — a question's lines reach the screen.
//
// Run:  node tools/stem-lines-gates.mjs
//
// A reading-comprehension question stores a whole text in its stem: an
// instruction, a letter of several paragraphs, a signature on two lines, then
// the question. `QuestionStem` draws a stem without a visual fence through
// `MathText`, which unwraps markdown's paragraphs so a formula can sit inside
// an option button, and that unwrapping ran the letter, its signature and the
// question together as one paragraph. In a true/false item the statement to
// judge read as the last sentence of the text.
//
// So a STEM keeps its paragraphs and its single line breaks, and the short
// strings that share `MathText` (options, the correct answer, explanations)
// stay inline, which is what the compact quiz layout needs. The stems below
// are written for this file. Rendered with react-dom/server and read with
// jsdom: no layout here, so the assertions are on the elements a browser
// breaks lines at (a block per paragraph, a <br> per line), checked in Edge
// by hand when this was written.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
// Inside node_modules so the packages left external resolve; CJS because some
// dependencies `require` Node built-ins.
mkdirSync(join(repoRoot, 'node_modules', '.cache'), { recursive: true });
const scratch = mkdtempSync(join(repoRoot, 'node_modules', '.cache', 'stem-lines-'));
const out = join(scratch, 'stem.cjs');

try {
    await esbuild.build({
        stdin: {
            contents: "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';"
                + " import QuestionStem from './src/components/QuestionStem'; import MathText from './src/components/MathText';"
                + ' export const stem = (content) => renderToStaticMarkup(createElement(QuestionStem, { content }));'
                + ' export const inline = (content) => renderToStaticMarkup(createElement(MathText, { content }));',
            resolveDir: repoRoot, loader: 'js',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic', logLevel: 'silent',
        loader: { '.css': 'empty' },
        define: { 'import.meta.env.DEV': 'false' },
        // Reached only through the visual registry's dynamic imports.
        external: ['vega-embed', 'vega', 'vega-lite', 'mermaid', 'p5', 'smiles-drawer', '@observablehq/plot'],
        plugins: [{
            // The fenced-visual path is Markdown's and is not the subject here.
            name: 'stub-markdown',
            setup(b) {
                b.onResolve({ filter: /^\.\/Markdown$/ }, () => ({ path: 'markdown', namespace: 'stub' }));
                b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function Markdown(){return null;}', loader: 'js' }));
            },
        }],
    });
    const { stem, inline } = require(out);
    const { document } = new JSDOM('').window;
    const read = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

    let pass = 0, fail = 0;
    const check = (label, cond, extra = '') => {
        if (cond) { pass++; console.log(`  ok    ${label}`); }
        else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
    };
    const section = (name) => console.log(`\n${name}`);

    /** The element each text sits in, nearest first. */
    const holder = (root, text) => {
        const walk = document.createTreeWalker(root, 1 /* elements */);
        let found = null;
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent.includes(text)) found = n;
        return found;
    };
    const paragraphs = (root) => [...root.querySelectorAll('[data-stem-paragraph]')];

    section('a reading text keeps its paragraphs');
    const letter = '[Reading 1] Read the notice.\n\nDear residents,\n\nThe library on Station Road closes for repairs on 3 March. Books can be returned at the town hall.\n\nKind regards,\nThe Town Council\n\nWhere can books be returned while the library is closed?';
    const letterDom = read(stem(letter));
    const paras = paragraphs(letterDom);
    check('each blank-line-separated block is its own paragraph (five here)', paras.length === 5, `${paras.length} found: ${letterDom.innerHTML.slice(0, 300)}`);
    check('every paragraph is a block, so it starts on its own line',
        paras.length > 0 && paras.every((p) => /(^|\s)block(\s|$)/.test(p.className)), paras.map((p) => p.className).join(' | '));
    check('a paragraph after the first is set apart by a gap, the first is not',
        paras.length > 1 && /(^|\s)first:mt-0(\s|$)/.test(paras[0].className) && /(^|\s)mt-\d/.test(paras[1].className),
        paras.map((p) => p.className).join(' | '));
    check('the question is not the tail of the signature',
        holder(letterDom, 'Where can books') !== holder(letterDom, 'The Town Council'));
    check('the instruction is not run into the letter',
        holder(letterDom, 'Read the notice.') !== holder(letterDom, 'Dear residents,'));

    section('a single line break stays a line break');
    const sig = paras.find((p) => p.textContent.includes('Kind regards,'));
    check('the sign-off and the sender are two lines (a <br> between them)',
        !!sig && /Kind regards,<br>\s*The Town Council/.test(sig.innerHTML), sig ? sig.innerHTML : 'no paragraph');
    const tf = read(stem('Statement 1\nThe library closes on 3 March.'));
    check('a true/false statement under its label is on its own line', tf.querySelectorAll('br').length === 1, tf.innerHTML);

    section('what must stay as it was');
    const plain = read(stem('What is the capital of the Netherlands?'));
    check('a one-line stem is one paragraph with no break in it',
        paragraphs(plain).length === 1 && plain.querySelectorAll('br').length === 0, plain.innerHTML);
    const trailing = read(stem('What is the capital of the Netherlands?\n'));
    check('a model-written stem with a stray trailing newline draws no empty line',
        trailing.querySelectorAll('br').length === 0 && paragraphs(trailing).length === 1, trailing.innerHTML);
    const trailingPara = read(stem('Read the text.\n\nWhat happens next?\n\n\n'));
    check('… nor trailing blank lines an empty paragraph',
        paragraphs(trailingPara).length === 2 && paragraphs(trailingPara).every((p) => p.textContent.trim()), trailingPara.innerHTML);
    const math = read(stem('Given $v = \\frac{d}{t}$ and\n\n$$E = mc^2$$\n\nwhich quantity is conserved?'));
    // A one-line `$$…$$` is inline math to remark-math (see `mathText.ts`), so
    // it is counted as a formula, standing in a paragraph of its own.
    const eq = paragraphs(math).find((p) => p.querySelector('.katex') && !p.textContent.includes('Given'));
    check('both formulas still render with KaTeX, the standalone one in its own paragraph',
        math.querySelectorAll('.katex-mathml').length === 2 && paragraphs(math).length === 3 && !!eq, math.innerHTML.slice(0, 200));
    check('… and the inline formula stays in its sentence',
        holder(math, 'Given') === holder(math, 'and') && !!holder(math, 'Given')?.querySelector('.katex'));
    const multi = read(stem('Line one has $x^2$\nline two has $y$'));
    check('a line break between two formulas is a <br>, not a broken formula',
        multi.querySelectorAll('br').length === 1 && multi.querySelectorAll('.katex').length === 2, multi.innerHTML.slice(0, 200));
    const blank = read(stem('The cat ___ on the mat every afternoon.'));
    check('a fill-in blank is still three underscores', blank.textContent.includes('The cat ___ on the mat'), blank.textContent);
    const twoBlanks = read(stem('Fill in both gaps.\n\nIk ___ naar school en jij ___ thuis.'));
    check('… also in a paragraph of its own', paragraphs(twoBlanks).length === 2 && twoBlanks.textContent.includes('Ik ___ naar school en jij ___ thuis.'), twoBlanks.textContent);

    section('options, answers and explanations stay inline');
    const option = read(inline('Speed is $v$\n\nand the rest'));
    check('MathText without the stem flag draws no block and no paragraph marker',
        option.querySelectorAll('[data-stem-paragraph], p, div:not(.katex-display), br').length === 0, option.innerHTML.slice(0, 200));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
