// tools/overview-math-gates.mjs — maths in a created course's Overviews is typeset.
//
// Run:  node tools/overview-math-gates.mjs
//
// A Taylor-series course built by the app's own creation run (Claude Opus 5.5,
// 2026-11-01) came back with maths in most of its 908 Overviews and not one `$`
// in any of them: "the coefficients have the form f^(n)(a)/n!", "e^x, sin x,
// 1/(1-x)". The topic panel and the feed's reading cards draw an Overview through
// `Markdown.tsx`, which runs remark-math and KaTeX, so the learner saw raw
// notation only because nothing asked the creation prompts for TeX.
//
// Three halves, each said by name so a red run says which one broke:
//   1. PROMPT   — every creation prompt that writes a node's description asks for
//                 inline `$…$` TeX, written for JSON; the prompts whose prose is
//                 drawn as plain text do not.
//   2. PARSER   — the creation reply is parsed LaTeX-safely: a model that writes
//                 `\frac` with ONE backslash (most do, inside JSON) must not get a
//                 form feed, and `\sin` must not fail the whole phase.
//   3. RENDERER — an Overview holding `$f^{(n)}(a)/n!$` comes out of the same
//                 Markdown component the topic panel uses as KaTeX, not as text.
// No model, no network, no database.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

const { AI_PROMPTS } = await import('../server/ai.js');
const agentic = await import('../server/agentic.js');

// ---------------------------------------------------------------------------
section('PROMPT: the creation prompts that write a description ask for $…$ TeX');

const dutch = { code: 'nl', name: 'Dutch', endonym: 'Nederlands' };
const sources = { system: '\nSOURCES-SYSTEM', user: '\nSOURCES-USER' };
const writers = {
    generate_categories: (o) => AI_PROMPTS.generate_categories('Taylor series', 'd', 'notes', 'summary', o),
    generate_elements: (o) => AI_PROMPTS.generate_elements('Taylor series', 'summary', 'Phase 1', 'd', o),
    generate_sub_elements: (o) => AI_PROMPTS.generate_sub_elements('Taylor series', 'summary', 'd', 'Phase 1', 'd', 'A, B', 'A', 'd', o),
    generate_sub_elements_batch: (o) => AI_PROMPTS.generate_sub_elements_batch('Taylor series', 'summary', 'd', 'Phase 1', 'd', [{ title: 'A', description: 'd' }], o),
};
for (const [name, build] of Object.entries(writers)) {
    for (const [variant, opts] of [['plain', {}], ['in Dutch', { lang: dutch }], ['from files', { sources }]]) {
        const sys = build(opts).system;
        // A formula is wrapped in single dollars, and an example shows it.
        check(`${name} (${variant}): asks for inline $…$ TeX`, /\$…\$|\$\.\.\.\$/.test(sys) && /\$f\^\{\(n\)\}\(a\)/.test(sys));
        // Inside a JSON string a TeX backslash is written twice; the example
        // must SHOW the doubled form, since an example is copied harder than a rule.
        check(`${name} (${variant}): shows the JSON-escaped backslash`, sys.includes('\\\\frac') || sys.includes('\\\\sin'));
        // Titles are drawn as plain text (sidebar, outline, search), so maths
        // there would show its dollars.
        check(`${name} (${variant}): keeps maths out of titles`, /"title"[^.]*plain/i.test(sys));
        // A subject with no maths must not be nudged into writing any.
        check(`${name} (${variant}): only where the subject has maths`, /no maths|no formulas|without maths/i.test(sys));
        // A code $ goes in backticks, and only $…$ delimits (the parser pairs on it).
        check(`${name} (${variant}): a code $ goes in backticks, no \\( delimiters`, /\$ that belongs to code[^.]*backticks/.test(sys) && !/\\\(/.test(sys));
        // The language rule still closes the prompt (learning-language-gates pins it).
        if (opts.lang) check(`${name} (${variant}): the language rule stays last`, /everything else is Dutch\.$/.test(sys));
    }
}
// The project summary is stored as the project's description and the project
// card draws it as plain text; the planning notes are never drawn as markdown.
check('summarizeProjectDescription asks for no TeX', !/\$…\$|\$\.\.\.\$|\\\\frac/.test(AI_PROMPTS.summarizeProjectDescription('Taylor series', 'd').system));
check('project_thinking asks for no TeX', !/\$…\$|\$\.\.\.\$|\\\\frac/.test(AI_PROMPTS.project_thinking('Taylor series', 'd').system));

// ---------------------------------------------------------------------------
section('PARSER: a creation reply keeps its TeX through JSON.parse');

const parse = agentic.parseCreationJson;
check('agentic.js exports parseCreationJson', typeof parse === 'function');
// Without the new parser, show what creation does today, so a red run names the
// corruption rather than only "missing".
const parseUnderTest = typeof parse === 'function' ? parse : agentic.parseJsonWithRepair;
const descOf = (raw) => {
    const r = parseUnderTest(raw);
    return r?.categories?.[0]?.description;
};
const want = String.raw`The coefficient $\frac{f^{(n)}(a)}{n!}$, then $\sin x$, $\theta$, $\nabla f$, $\binom{n}{k}$ and $\rho$.`;
// What a model writes when it forgets JSON escaping: one backslash each.
const single = String.raw`{"categories":[{"title":"Phase 2","description":"The coefficient $\frac{f^{(n)}(a)}{n!}$, then $\sin x$, $\theta$, $\nabla f$, $\binom{n}{k}$ and $\rho$."}]}`;
// What the prompt asks for: the backslash doubled.
const doubled = String.raw`{"categories":[{"title":"Phase 2","description":"The coefficient $\\frac{f^{(n)}(a)}{n!}$, then $\\sin x$, $\\theta$, $\\nabla f$, $\\binom{n}{k}$ and $\\rho$."}]}`;
const s = descOf(single);
check('single-backslash TeX parses at all (\\sin is not a JSON escape)', typeof s === 'string', `got ${JSON.stringify(s)}`);
check('single-backslash TeX arrives exactly (\\frac is not a form feed, \\theta not a tab)', s === want, `got ${JSON.stringify(s)}`);
const d = descOf(doubled);
check('doubled-backslash TeX arrives exactly', d === want, `got ${JSON.stringify(d)}`);
// The prose escapes a description may legitimately carry still mean what they say.
const prose = String.raw`{"categories":[{"title":"Q","description":"Line one\nline two, a \"quoted\" word, café, a\/b."}]}`;
check('a real \\n is still a line break, quotes and \\u escapes survive',
    descOf(prose) === 'Line one\nline two, a "quoted" word, café, a/b.', `got ${JSON.stringify(descOf(prose))}`);
check('a reply in a ```json fence with prose around it still parses',
    descOf('Here it is:\n```json\n{"categories":[{"title":"A","description":"$e^x$"}]}\n```') === '$e^x$');
check('garbage is null, not a throw', parseUnderTest('not json at all') === null);
// A correctly doubled command that starts with n is TeX, not a line break.
check('a doubled \\\\nmid stays TeX', descOf(String.raw`{"categories":[{"title":"Q","description":"$a \\nmid b$"}]}`) === String.raw`$a \nmid b$`);
// A reply that needs the repair pass (a trailing comma) must not have its
// strings repaired too: `}{` inside TeX and ", namely:" in prose are content.
const needsRepair = String.raw`{"categories":[{"title":"Phase 2","description":"Two cases, namely: $\frac{a}{b}$ and $\binom{n}{k}$."},]}`;
check('the repair pass leaves a string\'s }{ and ", word:" alone',
    descOf(needsRepair) === String.raw`Two cases, namely: $\frac{a}{b}$ and $\binom{n}{k}$.`, `got ${JSON.stringify(descOf(needsRepair))}`);
const quoted = String.raw`{"categories":[{"title":"Q","description":"The rule, 'wait': $x$ stays."},]}`;
check('the repair pass leaves a string\'s ", \'word\':" alone',
    descOf(quoted) === String.raw`The rule, 'wait': $x$ stays.`, `got ${JSON.stringify(descOf(quoted))}`);
// A quote in the prose before the JSON must not turn the strings inside out.
const prosed = 'Here is the 12" plan you asked for: ' + String.raw`{"categories":[{"title":"Q","description":"$\frac{1}{2}$"},]}`;
check('a quote in prose before the reply changes nothing inside it',
    descOf(prosed) === String.raw`$\frac{1}{2}$`, `got ${JSON.stringify(descOf(prosed))}`);
// Inside $…$ a backslash-n or -r is TeX, whatever command follows; outside,
// it is a line break, even before a word that starts like one (ne, nu).
const nr = String.raw`{"categories":[{"title":"Q","description":"$a \nless b$, $G \rtimes H$, $\nu$.\ne.g. this line\nused to vanish."}]}`;
check('\\nless and \\rtimes inside $…$ are TeX; \\n outside is a break, even before "e.g."',
    descOf(nr) === '$a \\nless b$, $G \\rtimes H$, $\\nu$.\ne.g. this line\nused to vanish.', `got ${JSON.stringify(descOf(nr))}`);
check('$$…$$ is one span (\\nless inside it is TeX)',
    descOf(String.raw`{"categories":[{"title":"Q","description":"$$\nless f$$ then\nnext"}]}`) === '$$\\nless f$$ then\nnext',
    `got ${JSON.stringify(descOf(String.raw`{"categories":[{"title":"Q","description":"$$\nless f$$ then\nnext"}]}`))}`);
// Delimiters that are not maths must not shift every span after them.
const escDollar = String.raw`{"categories":[{"title":"Q","description":"Pay \$5, then $\nless f$.\nnext"}]}`;
check('an escaped \\$ opens no span',
    descOf(escDollar) === 'Pay \\$5, then $\\nless f$.\nnext', `got ${JSON.stringify(descOf(escDollar))}`);
const codeDollar = String.raw`{"categories":[{"title":"Q","description":"Run ` + '`echo $HOME`' + String.raw`, then $\nless f$.\nnext"}]}`;
check('a $ inside backticks opens no span',
    descOf(codeDollar) === 'Run `echo $HOME`, then $\\nless f$.\nnext', `got ${JSON.stringify(descOf(codeDollar))}`);
// A stray $ leaves the spans unpaired: fall back to the closed command list
// rather than read every span after it inside out.
const strayDollar = String.raw`{"categories":[{"title":"Q","description":"It costs 5$ and $\nabla f$.\nnext"}]}`;
check('an unpaired $ falls back to the command list (\\nabla TeX, \\n a break)',
    descOf(strayDollar) === 'It costs 5$ and $\\nabla f$.\nnext', `got ${JSON.stringify(descOf(strayDollar))}`);
// Documented trade: outside maths too, \t \b \f are text, never control bytes.
check('\\theta outside $…$ is text, not a tab',
    descOf(String.raw`{"categories":[{"title":"Q","description":"angle \theta"}]}`) === String.raw`angle \theta`);

// Every creation reply goes through it: the structure phases and the batch.
const createSrc = readFileSync(join(repoRoot, 'server/routes/createProject.js'), 'utf8');
check('createProject.js parses its replies with parseCreationJson, never the bare repair',
    /parseCreationJson\(/.test(createSrc) && !/parseJsonWithRepair\(/.test(createSrc));

// ---------------------------------------------------------------------------
section('RENDERER: an Overview with $…$ is drawn as KaTeX by the topic panel');
{
    const esbuild = require('esbuild');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
    for (const k of ['window', 'document', 'navigator', 'localStorage', 'Element', 'Text', 'Node', 'HTMLElement', 'matchMedia']) {
        try { globalThis[k] = dom.window[k]; } catch { /* read-only in this Node */ }
    }
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    mkdirSync(join(repoRoot, 'node_modules', '.cache'), { recursive: true });
    const scratch = mkdtempSync(join(repoRoot, 'node_modules', '.cache', 'overview-math-'));
    try {
        const out = join(scratch, 'md.cjs');
        await esbuild.build({
            stdin: {
                contents: "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import Markdown from './src/components/Markdown';"
                    // The props MarkdownNotes passes for an Overview.
                    + " export const render = (content) => renderToStaticMarkup(createElement(Markdown, { content, surface: 'overview', autoBuild: false }));",
                resolveDir: repoRoot, loader: 'js',
            },
            bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic', logLevel: 'silent',
            loader: { '.css': 'empty' },
            define: { 'import.meta.env.DEV': 'false' },
            external: ['vega-embed', 'vega', 'vega-lite', 'mermaid', 'p5', 'smiles-drawer', '@observablehq/plot'],
            plugins: [{
                // Fenced visuals and drills are not the subject here.
                name: 'stub-blocks',
                setup(b) {
                    b.onResolve({ filter: /^\.\/(visuals\/VisualBlock|drills\/DrillLauncher)$/ }, () => ({ path: 'blocks', namespace: 'stub-blocks' }));
                    b.onLoad({ filter: /.*/, namespace: 'stub-blocks' }, () => ({ contents: 'export default function Block(){return null;} export function DrillLauncher(){return null;}', loader: 'js' }));
                },
            }],
        });
        const { render } = require(out);
        const read = (html) => { const el = dom.window.document.createElement('div'); el.innerHTML = html; return el; };

        const html = render('Understand why the coefficients have the form $f^{(n)}(a)/n!$ and how they build the series.');
        const el = read(html);
        const tex = [...el.querySelectorAll('annotation')].map(a => a.textContent);
        check('the formula is KaTeX', el.querySelectorAll('.katex').length === 1 && tex[0] === 'f^{(n)}(a)/n!', `annotations ${JSON.stringify(tex)}`);
        check('no dollar sign reaches the reader', !el.textContent.replace(/f\^\{\(n\)\}\(a\)\/n!/g, '').includes('$'));
        check('no KaTeX error', !html.includes('katex-error'));

        // What the parser hands over, drawn: \frac is a fraction, \sin an operator.
        const parsed = read(render(want));
        check('a parsed description draws a fraction and named operators',
            parsed.querySelectorAll('.katex').length === 6 && parsed.querySelector('.mfrac') && !parsed.innerHTML.includes('katex-error'));

        // The same Overview in today's stored shape stays as it was: plain text.
        const plain = read(render('Understand why the coefficients have the form f^(n)(a)/n!.'));
        check('a stored plain-text Overview is left as text (nothing guessed)', plain.querySelectorAll('.katex').length === 0);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
