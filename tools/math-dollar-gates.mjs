// tools/math-dollar-gates.mjs — a price written inside a formula reads as a price.
//
// Run:  node tools/math-dollar-gates.mjs
//
// A course about money writes amounts as maths: `$\$20{,}000$`. TeX reads that
// as one formula holding an escaped dollar sign. remark-math does not: inside a
// formula it honours no escapes, so the formula closes at the escaped dollar,
// its whole body is a lone backslash, and the amount prints raw:
// "\20{,}000$". With two amounts in one sentence the words BETWEEN them become
// the formula, set in italics with their spaces gone.
//
// So before the markdown reader sees a string, an escaped dollar inside a
// formula is rewritten to a form that carries no dollar character. Both
// funnels are rendered here with the real plugins (react-dom/server + jsdom):
// `MathText` (stems, options, answers, explanations) and the markdown
// pipeline's `fixMarkdownMathTypography` (lessons, the assistant).

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(join(repoRoot, 'node_modules', '.cache'), { recursive: true });
const scratch = mkdtempSync(join(repoRoot, 'node_modules', '.cache', 'math-dollar-'));
const out = join(scratch, 'gate.cjs');

try {
    await esbuild.build({
        stdin: {
            contents: "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';"
                + " import ReactMarkdown from 'react-markdown'; import remarkGfm from 'remark-gfm';"
                + " import remarkMath from 'remark-math'; import remarkBreaks from 'remark-breaks';"
                + " import { markdownRehypePlugins } from './src/utils/markdownSanitize';"
                + " import MathText from './src/components/MathText';"
                + " import { fixMarkdownMathTypography, sanitizeMathText } from './src/utils/mathText';"
                + ' export { fixMarkdownMathTypography, sanitizeMathText };'
                + ' export const inline = (content) => renderToStaticMarkup(createElement(MathText, { content }));'
                // The markdown pipeline's own plugin lists (Markdown.tsx), without its fenced visuals.
                + ' export const lesson = (content) => renderToStaticMarkup(createElement(ReactMarkdown, {'
                + '   remarkPlugins: [remarkGfm, remarkMath, remarkBreaks], rehypePlugins: markdownRehypePlugins,'
                + ' }, fixMarkdownMathTypography(content)));',
            resolveDir: repoRoot, loader: 'js',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic', logLevel: 'silent',
        loader: { '.css': 'empty' },
        define: { 'import.meta.env.DEV': 'false' },
    });
    const { inline, lesson, sanitizeMathText, fixMarkdownMathTypography } = require(out);
    const { document } = new JSDOM('').window;

    let pass = 0, fail = 0;
    const check = (label, cond, extra = '') => {
        if (cond) { pass++; console.log(`  ok    ${label}`); }
        else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
    };
    const section = (name) => console.log(`\n${name}`);

    /** What a learner reads: KaTeX's hidden MathML copy removed, the line
     *  binders' invisible characters (U+00A0, U+2060) folded away. */
    const read = (html) => {
        const root = document.createElement('div');
        root.innerHTML = html;
        const formulas = root.querySelectorAll('.katex').length;
        const errors = root.querySelectorAll('.katex-error').length;
        const inFormula = [...root.querySelectorAll('.katex-html')].map((n) => n.textContent).join(' | ');
        for (const n of root.querySelectorAll('.katex-mathml')) n.remove();
        const text = root.textContent.replace(/\u2060/g, '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
        return { text, formulas, errors, inFormula };
    };
    const shown = (r) => `read as "${r.text}" (${r.formulas} formulas, ${r.errors} errors)`;

    section('an amount written as a formula');
    const stem = read(inline("Buying a machine for $\\$20{,}000$ in cash changes the company's total assets."));
    check('the stem reads as a sentence with a price in it',
        stem.text === "Buying a machine for $20,000 in cash changes the company's total assets.", shown(stem));
    check('… as one formula KaTeX accepted', stem.formulas === 1 && stem.errors === 0, shown(stem));

    const answer = read(inline('Assets increase by $\\$8{,}000$ and liabilities increase by $\\$8{,}000$'));
    check('two amounts in one answer both read as prices',
        answer.text === 'Assets increase by $8,000 and liabilities increase by $8,000', shown(answer));
    check('the words between them are prose, not a formula',
        answer.formulas === 2 && !/and|liabilities/.test(answer.inFormula), `in formulas: ${answer.inFormula}`);

    const tf = read(inline('When a company borrows $\\$50{,}000$ from a bank, its assets and its liabilities each increase by $\\$50{,}000$, and equity is unchanged.'));
    check('a statement with a clause between two amounts keeps its spaces',
        tf.text === 'When a company borrows $50,000 from a bank, its assets and its liabilities each increase by $50,000, and equity is unchanged.', shown(tf));

    const sum = read(inline('$\\$50{,}000 - \\$20{,}000 = \\$30{,}000$'));
    check('a sum of amounts is one formula', sum.formulas === 1 && sum.errors === 0, shown(sum));
    check('… that shows all three', sum.text.replace(/\s/g, '') === '$50,000−$20,000=$30,000', shown(sum));

    const paren = read(inline('The fee is \\(\\$5\\) per order.'));
    check('the \\( \\) spelling of the same thing', paren.text === 'The fee is $5 per order.' && paren.errors === 0, shown(paren));

    const mixed = read(inline('Revenue $R = \\$400$ and cost $C$.'));
    check('an amount on the right of an equation', mixed.text.replace(/\s/g, '') === 'RevenueR=$400andcostC.' && mixed.formulas === 2, shown(mixed));

    section('a lesson (the markdown pipeline)');
    const para = read(lesson('Cash falls by $\\$20,000$ and equipment rises by $\\$20,000$.'));
    check('two amounts in a sentence', para.text === 'Cash falls by $20,000 and equipment rises by $20,000.' && para.formulas === 2 && para.errors === 0, shown(para));
    const display = read(lesson('The total:\n\n$$\n\\$8{,}000 + \\$2{,}000 = \\$10{,}000\n$$\n\nThat is all.'));
    // Passed before the fix too (a `$$` block on its own lines is read raw):
    // here so the rewrite cannot damage it.
    check('a display equation of amounts still draws',
        display.formulas === 1 && display.errors === 0 && display.text.replace(/\s/g, '') === 'Thetotal:$8,000+$2,000=$10,000Thatisall.', shown(display));

    // The `same` checks and the literal-dollar render pass without the fix:
    // they bound it, so a wider rewrite that paired prose prices or reached
    // into code would go red. The two "repairing" checks at the end fail
    // without it, and so does the tilde fence in a lesson: read as prose, its
    // lone formula line is lifted into display maths.
    section('what must stay as it was');
    const same = (label, s, fn = sanitizeMathText) => check(label, fn(s) === s, JSON.stringify(fn(s)));
    same('a literal dollar in prose', 'It costs \\$20,000 in cash.');
    same('an ordinary formula', 'The area is $x^2$ and the ratio $a/b$.');
    same('prices with bare dollars around an escaped one are not paired into a formula', 'It costs $5 and \\$10 more, or $20.');
    same('a lone unpaired dollar', 'A fee of $5 applies.');
    const plain = read(inline('It costs \\$20,000 in cash.'));
    check('… and the literal dollar still prints as one', plain.text === 'It costs $20,000 in cash.' && plain.formulas === 0, shown(plain));
    same('a fenced block reaches its renderer byte for byte', 'Run:\n\n```bash\necho "$\\$HOME$"\n```\n', fixMarkdownMathTypography);
    same('inline code is not maths', 'Type `$\\$5$` exactly.', fixMarkdownMathTypography);
    same('inline code is not maths in a quiz string either', 'Type `$\\$5$` exactly.');
    same('a tilde fence in a lesson reaches its renderer byte for byte', 'Run:\n\n~~~bash\n$x^2$\n$\\$5$\n~~~\n\nThen stop.', fixMarkdownMathTypography);
    same('… and in a quiz string', 'Run:\n\n~~~bash\necho "$\\$HOME$"\n~~~\n');
    const once = sanitizeMathText('Assets increase by $\\$8{,}000$ and $\\$2$');
    const DOLLAR = '\\text{\\textdollar}';
    check('repairing once rewrites, twice changes nothing more', once.includes(DOLLAR) && sanitizeMathText(once) === once, once);
    const mdOnce = fixMarkdownMathTypography('Cash falls by $\\$20,000$.');
    check('… in a lesson too', mdOnce.includes(DOLLAR) && fixMarkdownMathTypography(mdOnce) === mdOnce, mdOnce);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
