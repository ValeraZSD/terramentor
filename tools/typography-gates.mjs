// tools/typography-gates.mjs — how big the text is, on every surface that
// draws its own.
//
// Run:  node tools/typography-gates.mjs
//
// WHY. The app has one type scale for HTML (Tailwind rem, follows `ui_scale`)
// and four surfaces that quietly have their own: KaTeX, Mermaid, an animated
// SVG, and a widget in its own document. None of them was measured against the
// prose beside it, and each drifted in its own direction. Measured in a real
// browser on 2026-09-14, against 16px body prose and the app's own 12px floor
// for the smallest deliberate text:
//
//   - a `\frac` in an answer option painted its body at 11.9px and its
//     subscripts at **8.5px** — four options a learner chooses between, at half
//     the size of the question above them;
//   - the Doppler lesson's seven-node flowchart painted 10.6px labels on a
//     DESKTOP, sitting exactly on a scale floor that was chosen as a scale and
//     never checked as a size;
//   - across 57 stored animations (543 text elements) driven through the real
//     renderer, 80% of label text reached a desktop reader under 12px and 98%
//     reached a phone reader under 12px, bottoming out at 4.3px;
//   - a widget's text ignored `ui_scale` entirely — it is a separate document.
//
// Every assertion here is arithmetic or markup over a pure function. The px
// figures above came from a browser and are not re-measured here; what IS
// asserted is the machinery that produces them, so a change that would undo
// one of those fixes fails before anyone has to look at a screen again.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const katex = require('katex');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'typography-gates-'));
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

async function bundle(entry) {
    const outfile = join(scratch, entry.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '.mjs'));
    await esbuild.build({
        entryPoints: [join(repoRoot, entry)],
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
        // The renderers import the store/api/i18n for unrelated reasons; none of
        // it runs here, and bundling it drags React in.
        plugins: [{
            name: 'stub-runtime',
            setup(build) {
                build.onResolve({ filter: /(^|\/)\.\.\/\.\.\/(api|store|i18n)$/ }, () => ({ path: 'stub', namespace: 'stub' }));
                build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const api={};export const useStore={getState:()=>({}),subscribe:()=>()=>{}};export default {};', loader: 'js' }));
            },
        }],
    });
    return import(pathToFileURL(outfile).href);
}

const mathText = await bundle('src/utils/mathText.ts');
const svgAnim = await bundle('src/components/visuals/sanitizeSvgAnim.ts');
const mermaid = await bundle('src/components/visuals/renderMermaid.ts');
const widget = await bundle('src/components/visuals/widgetTheme.ts');

// ---------------------------------------------------------------------------
section('a quiz string that is nothing but a formula is set in display style');

const { promoteInlineDisplay } = mathText;
const OPTION = String.raw`$f_s \frac{v - v_\text{run}}{v + v_\text{train}}$`;

check('a whole-string formula is promoted',
    promoteInlineDisplay(OPTION).startsWith('$\\displaystyle '));
check('a whole-string `$$…$$` is promoted too (remark-math parses it INLINE on one line)',
    promoteInlineDisplay('$$x = \\frac{a}{b}$$').startsWith('$\\displaystyle '));
check('leading/trailing whitespace does not hide a whole-string formula',
    promoteInlineDisplay('  $\\frac{a}{b}$\n').startsWith('$\\displaystyle '));
check('a formula INSIDE a sentence is left in text style',
    promoteInlineDisplay('the ratio $a/b$ rises') === 'the ratio $a/b$ rises');
check('a string holding two spans is a sentence, not a formula',
    promoteInlineDisplay('$a$ and $b$') === '$a$ and $b$');
check('prose with no math is returned untouched',
    promoteInlineDisplay('True') === 'True');
check('idempotent — a second pass changes nothing',
    promoteInlineDisplay(promoteInlineDisplay(OPTION)) === promoteInlineDisplay(OPTION));
check('an empty span is not turned into markup',
    promoteInlineDisplay('$  $') === '$  $');

// The point of the promotion is a SIZE, so assert the size, not the string.
//
// KaTeX marks every style change with a `sizing reset-sizeN sizeM` span, where
// size6 is normal and the ladder below it is size5..size1 = 0.9, 0.8, 0.7, 0.6,
// 0.5 of the base. So the SMALLEST class present is the smallest type in the
// expression, and comparing it before and after is a ruler that needs no
// browser. (It agrees with one: measured in Edge at a 14px container, the same
// option went from 11.9px/8.5px to 16.9px/11.9px.)
const smallestSizeClass = (tex) => {
    const classes = katex.renderToString(tex, { throwOnError: false }).match(/\bsize([1-9]|1[01])\b/g) || [];
    const ns = classes.map(c => Number(c.slice(4))).filter(n => n < 6);
    return ns.length ? Math.min(...ns) : 6;
};
const textStyle = smallestSizeClass(OPTION.slice(1, -1));
const displayStyle = smallestSizeClass(promoteInlineDisplay(OPTION).slice(1, -1));
check('text style really does shrink the fraction (the defect being fixed)',
    textStyle < 6, `smallest class size${textStyle}`);
check('the promotion moves the smallest type in the option UP the ladder',
    displayStyle > textStyle, `size${textStyle} -> size${displayStyle}`);
check('nothing in a promoted option is set below scriptstyle (x0.7)',
    displayStyle >= 3, `smallest class size${displayStyle}`);

check('MathText runs the promotion (it is the one funnel every quiz string takes)',
    /promoteInlineDisplay\(/.test(read('src/components/MathText.tsx')));
check('the markdown path keeps its own promotion — the two are different fixes',
    /fixMarkdownMathTypography\(/.test(read('src/components/Markdown.tsx'))
    && /promoteDisplayMath\(/.test(read('src/utils/mathText.ts')));

// ---------------------------------------------------------------------------
section('KaTeX’s 1.21em is a decision, and stays written down');

const css = read('src/index.css');
check('index.css never overrides `.katex` font-size (it is optical, not a bug)',
    !/^\s*\.katex\s*\{[^}]*font-size/m.test(css));
check('the measurement that settled it is recorded where someone would "fix" it',
    /1\.21em/.test(css) && /x-height/i.test(css));

// ---------------------------------------------------------------------------
section('a diagram’s legibility floor is a SIZE, not a scale');

check('the diagram font size is pinned by the app, not left to the library',
    typeof mermaid.DIAGRAM_FONT_PX === 'number' && mermaid.DIAGRAM_FONT_PX > 0);
check('the minimum label size is the app’s own 12px floor',
    mermaid.MIN_LABEL_PX === 12);
check('the scale floor is DERIVED from the two, so it cannot drift',
    Math.abs(mermaid.MIN_LEGIBLE_SCALE * mermaid.DIAGRAM_FONT_PX - mermaid.MIN_LABEL_PX) < 1e-9,
    `${mermaid.MIN_LEGIBLE_SCALE} x ${mermaid.DIAGRAM_FONT_PX} = ${mermaid.MIN_LEGIBLE_SCALE * mermaid.DIAGRAM_FONT_PX}px`);
check('a label at the floor still reaches the reader at 12px or more',
    mermaid.DIAGRAM_FONT_PX * mermaid.MIN_LEGIBLE_SCALE >= 12);
check('mermaid is initialized with that pinned size',
    /fontSize:\s*DIAGRAM_FONT_PX/.test(read('src/components/visuals/renderMermaid.ts')));

// ---------------------------------------------------------------------------
section('an animation’s labels are floored, proportionally to its frame');

const { floorLabelSizes, sanitizeAnimatedSvg } = svgAnim;
const svgOf = (inner, viewBox = '0 0 600 340') => {
    const d = new JSDOM(`<!doctype html><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${inner}</svg></body>`);
    return d.window.document.querySelector('svg');
};

let s = svgOf('<text font-size="8">tiny</text><text font-size="18">title</text>');
check('sub-floor text is raised', (floorLabelSizes(s), s.querySelector('text').getAttribute('font-size') === '12'));
check('text already above the floor is left exactly as authored',
    s.querySelectorAll('text')[1].getAttribute('font-size') === '18');

s = svgOf('<text font-size="16">tiny</text>', '0 0 1200 680');
floorLabelSizes(s);
check('the floor is proportional to the viewBox, not an absolute unit count',
    s.querySelector('text').getAttribute('font-size') === '24',
    s.querySelector('text').getAttribute('font-size'));

s = svgOf('<text style="font-size:9px">inline</text>');
floorLabelSizes(s);
check('an inline style carries the size just as often as the attribute',
    /12/.test(s.querySelector('text').style.fontSize));

s = svgOf('<text font-size="0.6em">relative</text>');
floorLabelSizes(s);
check('a relative unit is left alone rather than guessed at',
    s.querySelector('text').getAttribute('font-size') === '0.6em');

s = svgOf('<text>unsized</text>');
check('text with no size of its own is not given one', floorLabelSizes(s) === 0);

s = svgOf('<text font-size="8">a</text>');
floorLabelSizes(s);
const before = s.querySelector('text').getAttribute('font-size');
floorLabelSizes(s);
check('idempotent — a second pass raises nothing',
    s.querySelector('text').getAttribute('font-size') === before);

const sanitized = sanitizeAnimatedSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 340">'
    + '<text font-size="9" x="10" y="20">label</text>'
    + '<circle cx="50" cy="50" r="5"><animate attributeName="cx" values="50;100;50" dur="3s" repeatCount="indefinite"/></circle>'
    + '</svg>');
check('the floor runs as part of the real sanitizer, not only on its own',
    sanitized.querySelector('text').getAttribute('font-size') === '12');

const anim = read('src/components/visuals/renderAnimation.ts');
// The floor was computed once, before `fitSvgLabels` widened the viewBox — so
// the grow silently undid it, and the scale reached x0.391 against a floor of
// 0.62. What matters is that the recompute lives INSIDE the `if (grown)` block;
// anywhere else and it is reading the same width it already read.
const grownBlock = /if\s*\(grown\)\s*\{([\s\S]*?)\n {8}\}/.exec(anim);
check('the stage’s legibility width is re-applied after the label fit grows the frame',
    !!grownBlock && /applyLegibleWidth\(\)/.test(grownBlock[1]),
    grownBlock ? 'the grow block does not recompute the width' : 'no `if (grown)` block found');

// ---------------------------------------------------------------------------
section('the authoring brief asks for type the reader can actually read');

const brief = read('server/ai.js');
check('the brief states the unit-to-pixel truth, not just a unit count',
    /TYPE SIZE IS A FRACTION OF THE FRAME/.test(brief));
check('the stated label floor is above the old 12 units',
    /no text below 16 units/.test(brief));
check('the narrow-screen rule agrees with it', /smaller than 16 units/.test(brief));

// ---------------------------------------------------------------------------
section('a widget follows the interface-size setting');

check('the sandbox is handed a root font size',
    typeof widget.widgetRootFontCss === 'function'
    && /font-size:\s*22\.4px/.test(widget.widgetRootFontCss(22.4)));
check('a nonsense value falls back to the browser default rather than breaking the page',
    /font-size:\s*16px/.test(widget.widgetRootFontCss(NaN))
    && /font-size:\s*16px/.test(widget.widgetRootFontCss(0)));
const rw = read('src/components/visuals/renderWidget.ts');
check('it is injected on first render AND on a live re-theme (two code paths, one rule)',
    (rw.match(/hostRootFontCss\(\)/g) || []).length >= 2);
check('the host size is read from the document, where applyUiScale writes it',
    /getComputedStyle\(document\.documentElement\)\.fontSize/.test(rw));

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
