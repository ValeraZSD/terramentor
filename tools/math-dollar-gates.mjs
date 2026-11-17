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
                + " import { toPlainText } from './src/utils/plainMath';"
                + ' export { fixMarkdownMathTypography, sanitizeMathText, toPlainText };'
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
    const { inline, lesson, sanitizeMathText, fixMarkdownMathTypography, toPlainText } = require(out);
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
    // The reader pairs the first two dollars here, so the amount after them
    // is prose to it: rewriting it would print the TeX command as text.
    same('an amount whose opening dollar the reader gives to an earlier price', 'The fee is $5 and $\\$10$.');
    const spent = fixMarkdownMathTypography('The fee is $5 and $\\$10$.');
    check('… in a lesson too (its escaped dollar is left as written)', spent.includes('$\\$10$') && !spent.includes('\\text'), spent);
    const afterPair = sanitizeMathText('Area $x^2$ costs $\\$5$.');
    check('an amount after a whole formula is still repaired', afterPair === 'Area $x^2$ costs $\\text{\\textdollar}5$.', afterPair);
    const plain = read(inline('It costs \\$20,000 in cash.'));
    check('… and the literal dollar still prints as one', plain.text === 'It costs $20,000 in cash.' && plain.formulas === 0, shown(plain));
    same('a fenced block reaches its renderer byte for byte', 'Run:\n\n```bash\necho "$\\$HOME$"\n```\n', fixMarkdownMathTypography);
    same('inline code is not maths', 'Type `$\\$5$` exactly.', fixMarkdownMathTypography);
    same('inline code is not maths in a quiz string either', 'Type `$\\$5$` exactly.');
    same('a tilde fence in a lesson reaches its renderer byte for byte', 'Run:\n\n~~~bash\n$x^2$\n$\\$5$\n~~~\n\nThen stop.', fixMarkdownMathTypography);
    same('… and in a quiz string', 'Run:\n\n~~~bash\necho "$\\$HOME$"\n~~~\n');
    for (const [label, fenced] of [
        ['a shorter run of tildes inside a longer fence is code, not its close', '~~~~\n~~~\n$\\$5$\n~~~~\n'],
        ['a tilde fence indented by up to three spaces is still a fence', 'Run:\n\n  ~~~\n$x^2$\n$\\$5$\n  ~~~\n\nThen stop.'],
        ['a tilde fence nothing closes is code to the end', 'Run:\n\n~~~\n$x^2$\n$\\$5$\n'],
        ['a shorter run inside a longer fence nothing closes is still code', '~~~~\n~~~\n$\\$5$\n'],
        ['a backtick fence nothing closes is code to the end', 'Run:\n\n```bash\n$x^2$\n$\\$5$\n'],
        ['three backticks inside a four-backtick fence are code, not its close', '````\n```\n$x^2$\n$\\$5$\n````\n'],
        ['a backtick fence indented by up to three spaces is still a fence', 'Run:\n\n  ```\n$x^2$\n$\\$5$\n  ```\n\nThen stop.'],
    ]) {
        same(`${label} (lesson)`, fenced, fixMarkdownMathTypography);
        same(`${label} (quiz string)`, fenced);
    }
    const afterFence = fixMarkdownMathTypography('~~~\ncode\n~~~\n\nIt costs $\\$5$ now.');
    check('prose after a closed tilde fence is still repaired', afterFence.includes('\\text{\\textdollar}') && afterFence.startsWith('~~~\ncode\n~~~\n'), afterFence);
    same('two tildes are strikethrough, not a fence', 'It is ~~not~~ here.\n', fixMarkdownMathTypography);
    const once = sanitizeMathText('Assets increase by $\\$8{,}000$ and $\\$2$');
    const DOLLAR = '\\text{\\textdollar}';
    check('repairing once rewrites, twice changes nothing more', once.includes(DOLLAR) && sanitizeMathText(once) === once, once);
    const mdOnce = fixMarkdownMathTypography('Cash falls by $\\$20,000$.');
    check('… in a lesson too', mdOnce.includes(DOLLAR) && fixMarkdownMathTypography(mdOnce) === mdOnce, mdOnce);

    // An escape means the same thing in every funnel: `\_` in a text group is
    // the character, and a `\$` in prose is a dollar, never a formula's edge.
    section('escapes are honoured by the repairs');
    check('an escaped underscore in a text group is left as written',
        sanitizeMathText('$\\text{max\\_speed}$') === '$\\text{max\\_speed}$', sanitizeMathText('$\\text{max\\_speed}$'));
    check('… and an escaped caret',
        sanitizeMathText('$\\text{\\^e}$') === '$\\text{\\^e}$', sanitizeMathText('$\\text{\\^e}$'));
    const escScript = sanitizeMathText('$\\text{a\\_b W/m^2}$');
    check('a real script beside an escaped one is still lifted out',
        escScript === '$\\text{a\\_b W/m}^{2}$', escScript);
    const snake = read(inline('$\\text{max\\_speed}$ is the limit.'));
    check('a text group with an escaped underscore draws', snake.formulas === 1 && snake.errors === 0, shown(snake));

    const rent = 'Rent is \\$1,200 and food \\$300.';
    check('prose with two escaped dollars is not read as a formula (comma, lesson)',
        fixMarkdownMathTypography(rent) === rent, JSON.stringify(fixMarkdownMathTypography(rent)));
    const rentUnit = 'Pay \\$5 now or \\$ m later.';
    check('… nor is a unit bound across it', fixMarkdownMathTypography(rentUnit) === rentUnit, JSON.stringify(fixMarkdownMathTypography(rentUnit)));
    const rentStop = 'Spend \\$5 here, never \\$.';
    check('… nor a joiner put after it', fixMarkdownMathTypography(rentStop) === rentStop, JSON.stringify(fixMarkdownMathTypography(rentStop)));
    const rentRead = read(lesson(rent));
    check('… so the lesson prints the amounts as written', rentRead.text === 'Rent is $1,200 and food $300.', shown(rentRead));
    check('a real formula after an escaped dollar still gets its comma fix',
        fixMarkdownMathTypography('It costs \\$5 and $25,000$ more.') === 'It costs \\$5 and $25{,}000$ more.',
        fixMarkdownMathTypography('It costs \\$5 and $25,000$ more.'));

    const money = sanitizeMathText('Total: \\$5 \\times 3 = \\$15');
    check('an undelimited money formula has its dollars rewritten', !money.includes('\\$') && money.includes(DOLLAR), money);
    const moneyRead = read(inline('Total: \\$5 \\times 3 = \\$15'));
    check('… and reads as one formula with both prices',
        moneyRead.formulas === 1 && moneyRead.errors === 0 && moneyRead.text.replace(/\s/g, '') === 'Total:$5×3=$15', shown(moneyRead));
    check('… repairing it again changes nothing more', sanitizeMathText(money) === money, sanitizeMathText(money));

    section('an exported caption (plain text)');
    check('two escaped dollars in prose come out as dollars', toPlainText('Pay \\$20 or \\$30 now') === 'Pay $20 or $30 now', toPlainText('Pay \\$20 or \\$30 now'));
    check('an amount written as a formula keeps its dollar and drops its braces',
        toPlainText('Costs $\\$20{,}000$ today') === 'Costs $20,000 today', toPlainText('Costs $\\$20{,}000$ today'));
    check('two amounts written as formulas stay two amounts',
        toPlainText('$\\$5$ or $\\$10$') === '$5 or $10', toPlainText('$\\$5$ or $\\$10$'));
    check('a formula after an escaped dollar is still flattened',
        toPlainText('Save \\$5 on $x^2$') === 'Save $5 on x²', toPlainText('Save \\$5 on $x^2$'));
    check('a dollar a display span keeps is not read as a delimiter',
        toPlainText('$$\\$5$$ then $$\\$6$$') === '$5 then $6', toPlainText('$$\\$5$$ then $$\\$6$$'));
    check('degrees written as a superscript circle read as a degree sign',
        toPlainText('the angle is $30^\\circ$') === 'the angle is 30°' && toPlainText('$90^{\\circ}$') === '90°',
        `${toPlainText('the angle is $30^\\circ$')} / ${toPlainText('$90^{\\circ}$')}`);
    check('… and a temperature keeps its unit', toPlainText('$25^\\circ C$') === '25° C', toPlainText('$25^\\circ C$'));
    check('an ordinary superscript is unchanged', toPlainText('$x^2$') === 'x²' && toPlainText('$x^{n+1}$') === 'xⁿ⁺¹');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
