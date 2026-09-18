// tools/details-gates.mjs — the <details> collapsible, as CONTENT.
//
// Run:  node tools/details-gates.mjs
//
// `<details>` is the second content tag (after <Timeline>) the model may write
// directly into prose, and it exists for one pedagogical reason: a step the
// learner should ATTEMPT before reading. Hidden-until-clicked is the whole
// point, so two properties are load-bearing and both are asserted here.
//
//   1. The BODY must be markdown. Per CommonMark an HTML block runs to the next
//      blank line, so the natural way to write a collapsible —
//
//          <details><summary>Why?</summary>Because **x**.</details>
//
//      arrives as one opaque raw-HTML lump: the stars stay stars, `$…$` never
//      reaches KaTeX, a bullet list stays literal. `expandDetailsTags` repairs
//      the shape mechanically (the same job, and the same reasoning, as
//      `expandTimelineTags` and `unwrapWrappedVisualFences`) rather than hoping
//      a small local model emits blank lines in the right places.
//
//   2. It must start CLOSED, always. A collapsible that a model opened by
//      writing `<details open>` shows the answer beside the question, which is
//      exactly the thing the tag was added to prevent — so the attribute is
//      dropped here, before it can reach the DOM.
//
// Plus the two ways a repair layer like this goes wrong: it must not touch a
// lesson that SHOWS the syntax (fenced or inline code), and mid-stream it must
// never hide text — an unclosed <details> is stripped while the message is
// still arriving, so prose stays visible until the closing tag lands.
//
// Pure string in, string out: no DOM, no model, no network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'details-gates-'));
const out = join(scratch, 'details.mjs');
const timelineOut = join(scratch, 'timeline.mjs');

await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/details.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
});
// The timeline expander shares this module's two primitives (`withCodeProtected`,
// `dedent`, in src/utils/blockTags.ts). It is bundled here too so the shared half is proven against BOTH
// callers — an inline-code hole fixed for one of them and not the other is
// exactly the failure this suite exists to catch.
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/timeline.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: timelineOut,
    logLevel: 'silent',
});

const { expandDetailsTags } = await import(pathToFileURL(out).href);
const { expandTimelineTags } = await import(pathToFileURL(timelineOut).href);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

/** A line is a lone tag when it is the whole line, with blank lines both sides. */
const isolated = (text, tag) => {
    const lines = text.split('\n');
    const i = lines.findIndex(l => l.trim() === tag);
    if (i === -1) return false;
    const before = i === 0 || lines[i - 1].trim() === '';
    const after = i === lines.length - 1 || lines[i + 1].trim() === '';
    return before && after;
};

section('the compact form a model actually writes is repaired');
const compact = expandDetailsTags('<details><summary>Why does it work?</summary>Because **x** is even.</details>');
check('<details> is alone on its line', isolated(compact, '<details>'), JSON.stringify(compact));
check('<summary> is alone on its line', isolated(compact, '<summary>'), JSON.stringify(compact));
check('</summary> is alone on its line', isolated(compact, '</summary>'), JSON.stringify(compact));
check('</details> is alone on its line', isolated(compact, '</details>'), JSON.stringify(compact));
check('the summary text becomes its own block',
    compact.split('\n').some(l => l.trim() === 'Why does it work?'), JSON.stringify(compact));
check('the body becomes its own block, markdown intact',
    compact.split('\n').some(l => l.trim() === 'Because **x** is even.'), JSON.stringify(compact));
check('tag order is preserved',
    compact.indexOf('<details>') < compact.indexOf('<summary>')
    && compact.indexOf('</summary>') < compact.indexOf('</details>'));

section('bodies are dedented (four spaces would be a code block)');
const indented = expandDetailsTags([
    '<details>',
    '    <summary>The steps</summary>',
    '    * First, **factorise**.',
    '    * Then substitute $x = 2$.',
    '</details>',
].join('\n'));
check('a bullet keeps its bullet', indented.split('\n').some(l => l === '* First, **factorise**.'),
    JSON.stringify(indented));
check('math is left for KaTeX', indented.includes('$x = 2$'));
check('no line keeps a four-space indent', !indented.split('\n').some(l => /^ {4}\S/.test(l)),
    JSON.stringify(indented));

// Measured in the app: a mermaid fence indented inside a collapsible rendered
// as a `text` code block showing its own source. Protecting code regions from
// the rewrite had also protected them from the dedent, and four spaces is an
// indented code block. The fence has to move WITH the body it sits in.
section('a fenced visual inside the body is dedented with it');
const withFence = expandDetailsTags([
    '<details>',
    '    <summary>Show the diagram</summary>',
    '    The chain of causes:',
    '',
    '    ```mermaid',
    '    flowchart TD',
    '      A["Force"] --> B["Acceleration"]',
    '    ```',
    '</details>',
].join('\n'));
check('the fence opens at column 0', withFence.split('\n').some(l => l === '```mermaid'), JSON.stringify(withFence));
check('the fence closes at column 0', withFence.split('\n').filter(l => l === '```').length === 1, JSON.stringify(withFence));
check('the diagram body keeps its own relative indent',
    withFence.split('\n').some(l => l === '  A["Force"] --> B["Acceleration"]'), JSON.stringify(withFence));
check('the prose beside it is dedented too', withFence.split('\n').some(l => l === 'The chain of causes:'));

section('it always starts closed');
check('`open` is dropped', /<details>/.test(expandDetailsTags('<details open><summary>A</summary>b</details>'))
    && !/<details[^>]/.test(expandDetailsTags('<details open><summary>A</summary>b</details>')));
check('any other attribute is dropped too',
    !/<details[^>]/.test(expandDetailsTags('<details class="x" open="open"><summary>A</summary>b</details>')));

section('it leaves alone what it must');
const noTag = 'An ordinary paragraph with **bold** and $x^2$ and no collapsible at all.';
check('content without the tag is returned identical', expandDetailsTags(noTag) === noTag);
const fenced = 'Here is the syntax:\n\n```html\n<details><summary>More</summary>text</details>\n```\n\nThat is it.';
check('a fenced example is untouched', expandDetailsTags(fenced) === fenced, JSON.stringify(expandDetailsTags(fenced)));
const inline = 'The `<details>` element toggles without JavaScript.';
check('an inline code span is untouched', expandDetailsTags(inline) === inline,
    JSON.stringify(expandDetailsTags(inline)));
check('the shared code-span guard also protects the timeline expander',
    expandTimelineTags('Write `<Timeline>` to start one.') === 'Write `<Timeline>` to start one.',
    JSON.stringify(expandTimelineTags('Write `<Timeline>` to start one.')));

// Measured in the assistant drawer, on a plain "what visuals can you do?": the
// model answered with a bulleted list of the kinds it may write, and two of the
// bullets NAMED these tags. Expanding a name tore the answer apart — a list
// item holding nothing but `**`, the rest of the sentence lifted out of the
// list, and everything below it swallowed into a summary-less collapsible whose
// label came out in the browser's language ("Подробные сведения"). Balance is
// the discriminator: markup closes, a mention does not.
section('a tag the model TALKED ABOUT is text, not markup');
const mentioned = expandDetailsTags('- **<details>** — a step the learner should TRY before reading it.');
check('no collapsible is built from a mention', !/<details>/.test(mentioned), JSON.stringify(mentioned));
check('the tag name survives as readable text', mentioned.includes('&lt;details&gt;'), JSON.stringify(mentioned));
check('the list item is left whole',
    mentioned === '- **&lt;details&gt;** — a step the learner should TRY before reading it.',
    JSON.stringify(mentioned));
const mentionedTimeline = expandTimelineTags('- **<Timeline>** — a chronology, written straight into the prose.');
check('the same holds for the timeline tag',
    mentionedTimeline === '- **&lt;Timeline&gt;** — a chronology, written straight into the prose.',
    JSON.stringify(mentionedTimeline));
const stray = expandDetailsTags('Close it with </details> when the step is written.');
check('a stray closing tag is text too', stray.includes('&lt;/details&gt;') && !/<\/details>/.test(stray),
    JSON.stringify(stray));
const mixed = expandDetailsTags('The <details> tag hides a step.\n\n<details><summary>Try it</summary>4</details>');
check('a real collapsible beside a mention still expands', isolated(mixed, '<summary>'), JSON.stringify(mixed));
check('and the mention beside it is still text',
    mixed.includes('The &lt;details&gt; tag hides a step.'), JSON.stringify(mixed));
// The exception: a model that forgot the closer, not one naming the tag. Its
// child tag follows immediately, and escaping it would print raw markup at the
// learner AND spoil the step the collapsible exists to hide.
check('an opener whose <summary> follows is still markup (a forgotten closer)',
    isolated(expandDetailsTags('<details>\n<summary>Try it first</summary>\nThe answer is 4'), '<details>'));
check('an opener whose first event follows is still markup',
    isolated(expandTimelineTags('<Timeline>\n<TimelineEvent time="Week 1">Read ch. 1</TimelineEvent>'), '<timeline>'));
check('a mention mid-stream keeps its sentence',
    expandDetailsTags('- **<details>** — a step to TRY.', { streaming: true }).includes('a step to TRY.'));

section('expanding twice changes nothing');
const once = expandDetailsTags('<details><summary>Q</summary>A **b**.</details>');
check('the expansion is a fixed point', expandDetailsTags(once) === once, JSON.stringify(once));

section('nothing is hidden mid-stream');
const partial = '<details>\n<summary>Try it first</summary>\nThe answer is 4';
const streamed = expandDetailsTags(partial, { streaming: true });
check('an unclosed <details> is stripped while streaming', !streamed.includes('<details>'), JSON.stringify(streamed));
check('its summary tags go with it', !streamed.includes('<summary>') && !streamed.includes('</summary>'),
    JSON.stringify(streamed));
check('the text itself survives', streamed.includes('Try it first') && streamed.includes('The answer is 4'));
const finished = expandDetailsTags('<details><summary>Q</summary>A.</details>', { streaming: true });
check('a CLOSED block still expands while streaming', isolated(finished, '<details>'), JSON.stringify(finished));
const closedEarlier = expandDetailsTags('<details><summary>A</summary>one</details>\n\n<details>\n<summary>B',
    { streaming: true });
check('only the unmatched opener is stripped',
    (closedEarlier.match(/<details>/g) || []).length === 1, JSON.stringify(closedEarlier));
check('an unclosed block is still expanded when NOT streaming',
    expandDetailsTags(partial).includes('<details>'));

section('shape and case');
const cased = expandDetailsTags('<DETAILS><Summary>Q</Summary>A.</DETAILS>');
check('tags are lowercased', isolated(cased, '<details>') && isolated(cased, '</details>'), JSON.stringify(cased));
const nested = expandDetailsTags('<details><summary>Outer</summary>\n\n<details><summary>Inner</summary>deep</details>\n\n</details>');
check('nesting survives', (nested.match(/<details>/g) || []).length === 2
    && (nested.match(/<\/details>/g) || []).length === 2, JSON.stringify(nested));
// Checked per result, not on a concatenation: each expansion ends in the blank
// line that separated its last tag from whatever follows, so joining two of them
// would report a run this layer never produced.
check('no run of three or more newlines is left in one expansion',
    !/\n{3,}/.test(compact) && !/\n{3,}/.test(nested) && !/\n{3,}/.test(indented));

// --- the click that belongs to the collapsible, not to the surface ----------
//
// A collapsible renders inside surfaces that are themselves click-to-do-
// something: the Overview and My-notes previews are click-to-edit. Measured in
// the real app before this rule existed — clicking a <summary> in an Overview
// opened the editor and the collapsible vanished mid-toggle. `ownsItsClick` is
// the shared fix, and it covers the working parts that were ALREADY there and
// had the same bug: a link, and a visual block's own buttons.
section('a working part inside a tap surface keeps its own click');

const { JSDOM } = require('jsdom');
const guardOut = join(scratch, 'tapGuard.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/hooks/useTapGuard.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: guardOut,
    logLevel: 'silent',
    // Only the pure predicate is under test; React is stubbed rather than
    // bundled so the suite stays a string/DOM test with no renderer in it.
    plugins: [{
        name: 'stub-react',
        setup(build) {
            build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                contents: 'export const useCallback = (f) => f; export const useRef = (v) => ({ current: v });',
                loader: 'js',
            }));
        },
    }],
});
const { ownsItsClick } = await import(pathToFileURL(guardOut).href);

const dom = new JSDOM(`<!doctype html><div id="surface" role="button" tabindex="0">
    <p id="prose">ordinary <em id="em">text</em></p>
    <details><summary id="sum">Try it first</summary><p id="inner">the answer</p></details>
    <a id="link" href="https://example.com">a source</a>
    <div class="visual-block"><button id="fix">Fix with AI</button></div>
</div>`);
const $ = (id) => dom.window.document.getElementById(id);
const surface = $('surface');

check('a click on the summary belongs to the summary', ownsItsClick($('sum'), surface));
check('a click on a link belongs to the link', ownsItsClick($('link'), surface));
check("a click on a visual's button belongs to the button", ownsItsClick($('fix'), surface));
check('a click on ordinary prose still taps the surface', !ownsItsClick($('prose'), surface));
check('a click on inline markup inside prose still taps the surface', !ownsItsClick($('em'), surface));
check('the collapsible BODY still taps the surface (only the summary toggles)', !ownsItsClick($('inner'), surface));
check('the surface never counts as its own working part', !ownsItsClick(surface, surface));
check('a null target is not a working part', !ownsItsClick(null, surface));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
