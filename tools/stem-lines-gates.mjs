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

//
// The last section is the server's half: a stem a MODEL wrote reaches the
// database with its lines and its fenced picture. A reader that makes every
// `\n` literal and strips every ``` (even inside strings) prints a mastery check
// as `…?\n\nplot\n{"data":…}` in plain text.
// That half needs a scratch library (set below, before any server import) and
// no model: the replies are written out here.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const libDir = mkdtempSync(join(tmpdir(), 'stem-lines-lib-'));
process.env.DB_PATH = join(libDir, 'gate.db');
process.env.VAULT_ROOT = join(libDir, 'vault');
process.env.DATA_DIR = libDir;

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
                + " export { hasVisual } from './src/components/QuestionStem';"
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
    const { stem, inline, hasVisual } = require(out);
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
        paras.length > 1 && /(^|\s)first:mt-0(\s|$)/.test(paras[0].className) && /(^|\s)mt-[1-9]/.test(paras[1].className),
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
    const option = read(inline('Speed is $v$\nfor now\n\nand the rest'));
    check('MathText without the stem flag draws no block and no paragraph marker',
        option.querySelectorAll('[data-stem-paragraph], p, div:not(.katex-display), br').length === 0, option.innerHTML.slice(0, 200));

    // Every surface that draws a question's text goes through QuestionStem,
    // which sets `lines` (and draws a fenced visual or the question's photos).
    // A plain `<MathText content={q.question} />` collapsed the lines again:
    // the quiz key preview in StudyTools did.
    section('a question\'s text is drawn by QuestionStem, never plain MathText');
    const srcDir = join(repoRoot, 'src');
    const offenders = [];
    for (const f of readdirSync(srcDir, { recursive: true })) {
        if (!/\.tsx$/.test(f)) continue;
        const text = readFileSync(join(srcDir, f), 'utf8');
        for (const m of text.matchAll(/<MathText\b[^>]*content=\{[\w.?]*\bquestion\}[^>]*>/g)) offenders.push(`${f}: ${m[0]}`);
    }
    check('no component draws a question stem with plain MathText', offenders.length === 0, offenders.join('; '));

    section('a stem the model wrote keeps its picture and its lines');
    {
        const db = (await import('../server/database.js')).default;
        const { finalizeQuiz } = await import('../server/studyMaterial.js');
        const { normalizeModelQuestion } = await import('../server/feed.js');
        const agentic = await import('../server/agentic.js');
        const { questionDefects } = await import('../server/feedQuality.js');
        const pid = db.prepare("INSERT INTO projects (name) VALUES ('Calculus')").run().lastInsertRowid;
        const nid = db.prepare("INSERT INTO nodes (project_id, title, position) VALUES (?, 'The function e to the minus one over x squared', 0)").run(pid).lastInsertRowid;

        // Written the way a model writes them: TeX with single backslashes
        // (`\to` is JSON's tab, `\neq` its newline), a JSON line break as `\n`,
        // a literal backslash-n in code as `\\n`. `~~~` stands for a fence here.
        const F = (s) => s.replaceAll('~~~', '```');
        const graphStem = String.raw`The graph below shows $f(x) = e^{-1/x^2}$, which is very flat near $x = 0$.\n\n~~~plot\n{\"data\":[{\"fn\":\"exp(-1/x^2)\"}],\"xAxis\":{\"domain\":[-4,4]}}\n~~~\n\nWhat value does $f(x)$ approach as $x \to \pm\infty$?`;
        const quizReply = F(String.raw`Here is the set.
~~~json
[
 {"type": "multiple_choice", "question": "${graphStem}", "options": ["$0$", "$1$", "$e$", "$\infty$"], "correct_answer": "$1$", "explanation": "As $x \to \pm\infty$, $-1/x^2 \to 0$, so $f(x) \to e^0 = 1$; and $f(x) \neq 0$ for every $x \neq 0$."},
 {"type": "true_false", "question": "For every statement $p$, $\neg\neg p$ is equivalent to $p$, and $\nabla \cdot \vec{F}$ is a scalar.", "options": ["True", "False"], "correct_answer": "True", "explanation": "Double negation cancels; a divergence is a scalar."},
 {"type": "multiple_choice", "question": "In C, how many lines does printf(\"a\\nb\") print?", "options": ["1", "2", "3", "0"], "correct_answer": "2", "explanation": "The escape ends the first line."},
 {"type": "multiple_choice", "question": "What does this print?\n~~~python\ntotal = 0\ni = 0\nwhile i < 3:\n    total += i\n    i += 1\nu = 2\ne = 3\nprint(total + u + e)\n~~~", "options": ["3", "8", "6", "5"], "correct_answer": "8", "explanation": "The loop adds 0, 1 and 2, then 2 and 3 are added."},
 {"type": "true_false", "question": "In music the \natural sign cancels a sharp; for $x \ne 0$ and a frequency $\nu$, $x \nleqslant y$ is a relation.", "options": ["True", "False"], "correct_answer": "True", "explanation": "Both hold."}
]
~~~`);
        const want = 'The graph below shows $f(x) = e^{-1/x^2}$, which is very flat near $x = 0$.\n\n```plot\n{"data":[{"fn":"exp(-1/x^2)"}],"xAxis":{"domain":[-4,4]}}\n```\n\nWhat value does $f(x)$ approach as $x \\to \\pm\\infty$?';

        let quiz = null;
        try { quiz = finalizeQuiz(nid, quizReply, false); } catch (e) { check('the mastery-check reply is read', false, e.message); }
        const stored = (q) => quiz?.questions?.find((x) => x.question.includes(q));
        const graph = stored('graph below');
        check('the check bank stores the stem exactly as written: paragraphs, fence, TeX',
            graph?.question === want, JSON.stringify(graph?.question)?.slice(0, 260));
        check('…so the stem draws its graph (QuestionStem sees a ```plot fence)', !!graph && hasVisual(graph.question));
        check('…and the explanation keeps $\\neq$ as TeX, not a line break', !!graph && graph.explanation.includes('f(x) \\neq 0'), graph?.explanation);
        const tex = stored('statement $p$');
        check('TeX commands that start like a line break survive (\\neg, \\nabla)',
            !!tex && tex.question.includes('$\\neg\\neg p$') && tex.question.includes('$\\nabla \\cdot \\vec{F}$'), tex?.question);
        const code = stored('In C');
        check('a backslash-n written as code stays the two characters',
            !!code && code.question.includes('printf("a\\nb")') && !code.question.includes('\n'), JSON.stringify(code?.question));
        // A code line that starts with `i`, `u` or `e` begins like `\ni`,
        // `\nu`, `\ne`: outside a `$…$` span those are line breaks.
        const loop = stored('What does this print?');
        check('a code stem keeps every line, even one starting with i, u or e',
            !!loop && loop.question.includes('total = 0\ni = 0\nwhile i < 3:') && loop.question.includes('\nu = 2\ne = 3\n') && !loop.question.includes('\\'),
            JSON.stringify(loop?.question));
        const music = stored('In music');
        check('…while $x \\ne 0$, $\\nu$, \\nleqslant and \\natural stay TeX',
            !!music && ['\\natural sign', '$x \\ne 0$', '$\\nu$', '\\nleqslant'].every((s) => music.question.includes(s)), JSON.stringify(music?.question));

        // The feed's own question writer, with working before the JSON whose
        // TeX braces must not be taken for it.
        const feedReply = String.raw`The curve flattens, and $\lim_{x \to \infty} e^{-1/x^2} = 1$.
{"type": "multiple_choice", "question": "${graphStem}", "options": ["$0$", "$1$", "$e$", "$\infty$"], "correct_answer": "$1$", "explanation": "As $x \to \pm\infty$ the exponent tends to $0$."}`.replaceAll('~~~', '```');
        const fed = typeof agentic.parseQuestionReply === 'function' ? normalizeModelQuestion(agentic.parseQuestionReply(feedReply)) : null;
        check('the feed\'s question writer reads the same stem the same way', fed?.question === want, JSON.stringify(fed?.question)?.slice(0, 200));

        // Fail closed: a flattened stem as it was stored, verbatim.
        const flattened = { type: 'multiple_choice', question: 'The graph below shows $f(x) = e^{-1/x^2}$. The graph is extremely flat near $x = 0$. What value does $f(x)$ approach as $x \\to \\pm\\infty$?\\n\\nplot\\n{"data":[{"fn":"exp(-1/x^2)"}],"xAxis":{"domain":[-4,4]},"yAxis":{"domain":[-0.2,1.2]}}\\n', options: ['$\\infty$', '$0$', '$e$', '$1$'], correct_answer: '$1$', explanation: 'It tends to one.' };
        check('a stem whose picture arrived as text is a defect (vetoed before it is served)',
            questionDefects(flattened).some((d) => /picture arrived as text/.test(d)), questionDefects(flattened).join('; '));
        check('…and the stems above are not', !!graph && !!code
            && !questionDefects(graph).some((d) => /picture/.test(d)) && !questionDefects(code).some((d) => /picture/.test(d)));
        // Code that prints a visual's kind or a fence is not a flattened picture.
        const printsWords = ['What does print("plot\\n") print?', 'After plt.plot\\n(x) runs, what is drawn?', 'What does echo "```\\n" print in bash?']
            .map((question) => ({ type: 'multiple_choice', question, options: ['a', 'b', 'c', 'd'], correct_answer: 'a', explanation: 'Because.' }));
        const wrongly = printsWords.filter((q) => questionDefects(q).some((d) => /picture/.test(d))).map((q) => q.question);
        check('…nor is a code stem that prints "plot" or a fence', wrongly.length === 0, wrongly.join(' | '));
        // Its lines kept but its fence lost: the kind alone on a real line, the spec under it.
        const unfenced = { ...flattened, question: 'What value does $f(x)$ approach?\n\nplot\n{"data":[{"fn":"exp(-1/x^2)"}]}' };
        check('a stem whose spec lost its fence but kept its lines is a defect too',
            questionDefects(unfenced).some((d) => /picture arrived as text/.test(d)), questionDefects(unfenced).join('; '));
        const saysPlot = { ...flattened, question: 'Which word names the command below?\nplot\nIt draws a curve.' };
        check('…while a line that only says "plot" above prose is not', !questionDefects(saysPlot).some((d) => /picture/.test(d)), questionDefects(saysPlot).join('; '));
        const mermaid = { ...flattened, question: 'Which step runs first?\n\nmermaid\nflowchart TD\n  A --> B' };
        check('an unfenced Mermaid spec is caught by its diagram keyword', questionDefects(mermaid).some((d) => /picture arrived as text/.test(d)), questionDefects(mermaid).join('; '));
        const saysMermaid = { ...flattened, question: 'Which tool draws this?\nmermaid\nIt turns text into diagrams.' };
        check('…while a line that only says "mermaid" above prose is not', !questionDefects(saysMermaid).some((d) => /picture/.test(d)), questionDefects(saysMermaid).join('; '));
        db.close();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
} finally {
    rmSync(scratch, { recursive: true, force: true });
    try { rmSync(libDir, { recursive: true, force: true }); } catch { /* the OS sweeps tmp */ }
}
