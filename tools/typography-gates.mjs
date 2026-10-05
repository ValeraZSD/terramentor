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

// ---------------------------------------------------------------------------
section('the app’s own text follows the interface-size setting');

// `ui_scale` works by moving the root font size, so a size written in px is a
// size the setting never reaches. Measured 2026-09-28 in Edge at 160%: 98
// `text-[11px]` / `text-[10px]` / `text-[15px]` class names stayed put beside
// 22px body text — the assistant's AI disclosure, every feed card's eyebrow,
// the calendar's day names, the schedule's card titles, the atlas's counters —
// and at 80% the same labels were LARGER than the numbers they label.
// The small sizes are `text-2xs` / `text-3xs` (tailwind.config.js, rem).
//
// BESPOKE: a file allowed a px size, with the reason. Empty, and a new entry
// should be an argument: text inside a canvas or a drawn visual is not chrome
// and is handled by its own floor above, never by a class name.
const PX_TYPE_BESPOKE = {};
const PX_CLASS = /(?<![\w\]-])(?:[\w-]+:)*text-\[(\d+(?:\.\d+)?)px\]/g;
const PX_STYLE = /\bfontSize\s*:\s*(?:['"`]\s*\d+(?:\.\d+)?px|\d+(?:\.\d+)?\s*[,}])/g;
const { globSync } = await import('node:fs');
const sourceFiles = globSync('src/**/*.{ts,tsx}', { cwd: repoRoot })
    .map(f => f.replace(/\\/g, '/'))
    .filter(f => !f.startsWith('src/locales/'));
const pxTypeSites = [];
for (const f of sourceFiles) {
    if (PX_TYPE_BESPOKE[f]) continue;
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        for (const m of line.matchAll(PX_CLASS)) pxTypeSites.push(`${f}:${i + 1} ${m[0]}`);
        // Inline style objects in components; the visual renderers draw SVG and
        // canvas text in their own units and are covered by the floors above.
        if (f.endsWith('.tsx')) for (const m of line.matchAll(PX_STYLE)) pxTypeSites.push(`${f}:${i + 1} ${m[0]}`);
    });
}
check(`no px font size in a class name or inline style (${sourceFiles.length} source files)`,
    pxTypeSites.length === 0,
    `${pxTypeSites.length} site(s):\n        ${pxTypeSites.slice(0, 12).join('\n        ')}${pxTypeSites.length > 12 ? `\n        … and ${pxTypeSites.length - 12} more` : ''}`);
check('the scan reads what it claims to (a known px class is caught)',
    [...'<span className="px-2 text-[11px] font-medium">'.matchAll(PX_CLASS)].length === 1
    && [...'<p className={`sm:text-[15px] x`}>'.matchAll(PX_CLASS)].length === 1
    && [...'<p className="text-2xs text-[0.6875rem] text-[#fff]">'.matchAll(PX_CLASS)].length === 0
    && [...'style={{ fontSize: 13, color }}'.matchAll(PX_STYLE)].length === 1
    && [..."style={{ fontSize: '0.85rem' }}".matchAll(PX_STYLE)].length === 0);
const tw = read('tailwind.config.js');
check('the small-print sizes exist, in rem',
    /'2xs':\s*'0\.6875rem'/.test(tw) && /'3xs':\s*'0\.625rem'/.test(tw));

// ---------------------------------------------------------------------------
section('a field that grows to its text is re-measured when the type size moves');

// The assistant's composer at 150%: "Ask anything…" cut off at the bottom of a
// box still 40px tall around 21px type, because the height was measured once,
// in px, and only re-measured when the TEXT changed. Two faults in one line:
// the height ignored the border (so every auto-grown field was 2px short of its
// own text, visible as a placeholder sitting on the bottom edge), and nothing
// re-measured it when `ui_scale` moved.
const grow = await bundle('src/hooks/useAutoGrow.ts');
const rootFont = await bundle('src/hooks/useRootFontSize.ts');
const fakeField = ({ scrollHeight, lineHeight = 20, padding = 10, border = 1, fontSize = 14, boxSizing = 'border-box' }) => {
    const el = { style: {}, scrollHeight, clientWidth: 300 };
    el.__cs = {
        lineHeight: `${lineHeight}px`, fontSize: `${fontSize}px`, boxSizing,
        paddingTop: `${padding}px`, paddingBottom: `${padding}px`,
        borderTopWidth: `${border}px`, borderBottomWidth: `${border}px`,
    };
    return el;
};
const realCs = globalThis.window.getComputedStyle;
globalThis.window.getComputedStyle = (el) => el.__cs ?? realCs(el);
{
    // One row of 20px type in 10px padding and a 1px border: the text needs
    // 40px of content box + padding and the box is 42px tall.
    const el = fakeField({ scrollHeight: 40 });
    grow.fitTextarea(el, { rows: 5 });
    check('the height written is the whole box, border included (one line: 42px)',
        el.style.height === '42px', el.style.height);
    const preFix = `${Math.min(40, 20 * 5 + 20 + 2)}px`; // the old formula: scrollHeight straight in
    check('control: the pre-fix formula wrote 40px, 2px short of its own text', preFix === '40px' && preFix !== el.style.height);
    check('it does not scroll while the text fits', el.style.overflowY === 'hidden');

    const tall = fakeField({ scrollHeight: 400 });
    grow.fitTextarea(tall, { rows: 5 });
    check('five rows is the ceiling, in the field’s own line height (5×20 + padding + border)',
        tall.style.height === '122px' && tall.style.overflowY === 'auto', `${tall.style.height} ${tall.style.overflowY}`);

    const at150 = fakeField({ scrollHeight: 60, lineHeight: 30, padding: 15, fontSize: 21 });
    grow.fitTextarea(at150, { rows: 5 });
    check('at 150% the same one line is re-measured to its new box (62px, not the 42px it was)',
        at150.style.height === '62px', at150.style.height);

    const unlaid = fakeField({ scrollHeight: 0 }); unlaid.clientWidth = 0;
    grow.fitTextarea(unlaid, { rows: 5 });
    check('a field that is not laid out yet is left alone (never written 0 tall)', unlaid.style.height === undefined);
}
{
    const answer = fakeField({ scrollHeight: 2000 });
    document.documentElement.style.fontSize = '16px';
    grow.fitTextarea(answer, { rem: 25 });
    const at100 = answer.style.height;
    document.documentElement.style.fontSize = '24px';
    grow.fitTextarea(answer, { rem: 25 });
    check('a length ceiling is in rem: 400px at 100%, 600px at 150% — the same amount of answer',
        at100 === '400px' && answer.style.height === '600px', `${at100} -> ${answer.style.height}`);
    document.documentElement.style.fontSize = '';
}
globalThis.window.getComputedStyle = realCs;

const hookSrc = read('src/hooks/useAutoGrow.ts');
check('the hook re-fits when the root font size changes (it is a dependency of the fit)',
    /useRootFontSize\(\)/.test(hookSrc) && /\[value, rows, rem, rootPx\]/.test(hookSrc));
check('and when the field’s WIDTH changes (the same text wraps differently)',
    /new ResizeObserver\(/.test(hookSrc) && /el\.clientWidth === width/.test(hookSrc));
check('no caller passes a px ceiling any more',
    ['src/components/AssistantDrawer.tsx', 'src/components/CaptureModal.tsx', 'src/components/answer/TextAnswerInput.tsx']
        .every(f => !/useAutoGrow\([^)]*,\s*\d+\s*\)/.test(read(f))));

{
    // The subscription: a ui_scale write wakes it, a colour-variable write on
    // the same `style` attribute does not.
    let calls = 0;
    const MO = dom.window.MutationObserver;
    globalThis.MutationObserver = MO;
    const stop = rootFont.subscribeRootFontSize(() => { calls++; });
    document.documentElement.style.fontSize = '24px';
    await new Promise(r => setTimeout(r, 0));
    const afterScale = calls;
    document.documentElement.style.setProperty('--c-slate-900', '1 2 3');
    await new Promise(r => setTimeout(r, 0));
    stop();
    document.documentElement.style.fontSize = '';
    check('a ui_scale change is heard', afterScale === 1, `${afterScale} call(s)`);
    check('a theme colour written on the same attribute is not', calls === 1, `${calls} call(s)`);
    check('the size is read off the root’s inline style, where applyUiScale writes it',
        rootFont.readRootFontSize() === 16 && /documentElement\.style\.fontSize/.test(read('src/hooks/useRootFontSize.ts')));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
