// tools/visual-theme-gates.mjs — asserts a model-authored visual survives the theme.
//
// Run:  node tools/visual-theme-gates.mjs
//
// Why this exists: every visual in this app is coloured by a model that cannot
// see the screen, and the failure it produces is SILENT. A `stroke="#1e293b"`
// arrow on the `slate-900` stage renders without an error, without a warning
// and without a line — nothing in the pipeline can tell "drew nothing" from
// "drew something invisible", so the only detector is a learner who does not
// know what they were supposed to be looking at.
//
// The rule being asserted has two halves and they pull against each other, so
// neither can be checked without the other:
//   - an ACHROMATIC colour is ink, and must land on THIS theme's ink ladder;
//   - a CHROMATIC colour is meaning, and must keep its hue and saturation while
//     moving only far enough in lightness to clear the 3:1 non-text contrast
//     floor. A pass that "fixed" contrast by desaturating would satisfy every
//     legibility check and destroy the thing the colour was drawn for.
//
// The p5 sandbox carries a JS twin of `adaptColor` (it runs inside an
// opaque-origin iframe that cannot import this module), so the twin is bundled
// here too and driven over the SAME table. Two implementations of one rule
// drifting apart is exactly the bug this file exists to prevent.
//
// No DOM, no model, no network: `readVisualPalette` reads CSS variables, so the
// palettes below are written out literally, exactly as index.css defines them.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'visual-theme-gates-'));
const out = join(scratch, 'palette.mjs');

await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/visuals/palette.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
});

const {
    adaptColor, parseColor, rgbToHex, contrastRatio, ensureContrast, luminance, themeSvgColors,
} = await import(pathToFileURL(out).href);

// The accent the learner TYPES. Every visual's `palette.accent` is this value,
// so a notation the picker silently refuses is a colour no diagram can use.
const colorOut = join(scratch, 'color.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/color.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: colorOut,
    logLevel: 'silent',
});
const { parseCssColor, accentSolidTriplet } = await import(pathToFileURL(colorOut).href);

// Mermaid's theme variables, bundled from the module that owns the mapping.
// Mermaid itself is never loaded here: the assertion is about the COLOURS handed
// to it, which is the half that was wrong, and it is a pure function.
const mermaidOut = join(scratch, 'mermaid-theme.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/visuals/mermaidTheme.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: mermaidOut,
    logLevel: 'silent',
});
const {
    mermaidThemeVariables, mermaidLabelsAreReadable, MERMAID_FILL_LABEL_PAIRS,
} = await import(pathToFileURL(mermaidOut).href);

// The p5 sandbox twin, bundled from the module that owns its source string.
const twinOut = join(scratch, 'twin.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/visuals/sandboxTheme.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: twinOut,
    logLevel: 'silent',
});
const { SANDBOX_THEME_JS, p5ThemePrelude } = await import(pathToFileURL(twinOut).href);

// The molecule renderer's theme table. `smiles-drawer` itself is left external:
// the assertion is about the COLOURS handed to it, and the library is reached
// through a dynamic import that `appTheme` never runs.
const smilesOut = join(scratch, 'smiles.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/visuals/renderSmiles.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['smiles-drawer'],
    outfile: smilesOut,
    logLevel: 'silent',
});
const { appTheme, HETEROATOMS } = await import(pathToFileURL(smilesOut).href);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

// The four themes, written out as index.css defines them.
const LIGHT = {
    theme: 'light', dark: false, bg: '#ffffff', fg: '#1e293b', muted: '#64748b',
    border: '#e2e8f0', accent: '#0e7490', accentFg: '#0e7490', accent2: '#b45309', series: [],
};
const DARK = {
    theme: 'dark', dark: true, bg: '#0f172a', fg: '#f1f5f9', muted: '#94a3b8',
    border: '#334155', accent: '#22d3ee', accentFg: '#25e3ff', accent2: '#fbbf24', series: [],
};
const WARM = {
    theme: 'warm', dark: false, bg: '#faf6ef', fg: '#302720', muted: '#786855',
    border: '#e2d6c3', accent: '#0e7490', accentFg: '#0e7490', accent2: '#b45309', series: [],
};
const BLACK = {
    theme: 'black', dark: true, bg: '#000000', fg: '#f1f5f9', muted: '#94a3b8',
    border: '#202026', accent: '#22d3ee', accentFg: '#25e3ff', accent2: '#fbbf24', series: [],
};
const THEMES = [LIGHT, DARK, WARM, BLACK];

const hue = (hex) => {
    const { r, g, b } = parseColor(hex);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
};
const sat = (hex) => {
    const { r, g, b } = parseColor(hex);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
};
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

section('parsing');
check('#rrggbb', rgbToHex(parseColor('#1e293b')) === '#1e293b');
check('#rgb shorthand expands', rgbToHex(parseColor('#abc')) === '#aabbcc');
check('rgb() function', rgbToHex(parseColor('rgb(255, 0, 0)')) === '#ff0000');
check('bare "R G B" triplet (our CSS vars hold this shape)', rgbToHex(parseColor('30 41 59')) === '#1e293b');
check('a colour keyword a model actually writes', rgbToHex(parseColor('black')) === '#000000');
check('none is not a colour', parseColor('none') === null);
check('transparent is not a colour', parseColor('transparent') === null);
check('currentColor is left to the cascade', parseColor('currentColor') === null);
check('a gradient reference is not a colour', parseColor('url(#grad)') === null);
check('an unrecognised keyword is refused, not guessed', parseColor('rebeccapurple') === null);
check('empty input', parseColor('') === null && parseColor(null) === null);

section('achromatic ink lands on the theme ladder (paper assumed)');
// This is the failure the module exists for: near-black ink drawn for white paper.
check('slate-800 ink is INK, not a blue hue (chroma 0.11, saturation 0.33)',
    adaptColor('#1e293b', DARK) === DARK.fg, adaptColor('#1e293b', DARK));
check('pure black stroke becomes the DARK theme foreground', adaptColor('#000000', DARK) === DARK.fg);
check('near-black stroke stays foreground on LIGHT', adaptColor('#1e293b', LIGHT) === LIGHT.fg);
check('mid grey becomes muted', adaptColor('#808080', DARK) === DARK.muted);
check('light grey becomes the border colour', adaptColor('#d3d3d3', DARK) === DARK.border);
check('a near-white FILL becomes the canvas (it WAS the paper)', adaptColor('#ffffff', DARK, 'fill') === DARK.bg);
check('a near-white STROKE on paper was invisible there too — a hairline, not ink',
    adaptColor('#ffffff', DARK, 'stroke') === DARK.border);
check('white ink on BLACK is not left as white paper', adaptColor('#ffffff', BLACK, 'fill') === BLACK.bg);
check('warm gets warm ink, not stock slate', adaptColor('#000000', WARM) === WARM.fg && WARM.fg !== LIGHT.fg);
for (const t of THEMES) {
    check(`[${t.theme}] adapted black ink clears 3:1 on the page`,
        contrastRatio(parseColor(adaptColor('#000000', t)), parseColor(t.bg)) >= 3,
        `${adaptColor('#000000', t)} on ${t.bg}`);
}

section('a scene drawn light-on-DARK keeps its emphasis');
// The visuals guide's own example draws stroke="white" around a dot on a dark
// scene. Judged by lightness that reads as "faint"; judged against the backdrop
// the scene declares, it is the strongest ink on the canvas — so on a LIGHT
// theme it must come out DARK. Getting this backwards erases the drawing.
const DARK_SCENE = '#0f172a';
for (const t of THEMES) {
    check(`[${t.theme}] white ink drawn on a dark scene becomes the foreground`,
        adaptColor('#ffffff', t, 'stroke', DARK_SCENE) === t.fg,
        adaptColor('#ffffff', t, 'stroke', DARK_SCENE));
    check(`[${t.theme}] and therefore clears 3:1 on the page`,
        contrastRatio(parseColor(adaptColor('#ffffff', t, 'stroke', DARK_SCENE)), parseColor(t.bg)) >= 3);
    check(`[${t.theme}] the dark scene's own backdrop colour reads as paper, not ink`,
        adaptColor(DARK_SCENE, t, 'fill', DARK_SCENE) === t.bg);
}
check('the SAME white stroke resolves differently under the two backdrops',
    adaptColor('#ffffff', DARK, 'stroke', DARK_SCENE) !== adaptColor('#ffffff', DARK, 'stroke', '#ffffff'));

section('chromatic colour keeps its meaning');
// A red vector must stay red. Recolouring it to the ink ramp would be a
// legibility "fix" that deletes the distinction the colour was drawn for.
const CHROMATIC = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#14b8a6'];
for (const t of THEMES) {
    for (const c of CHROMATIC) {
        const got = adaptColor(c, t);
        check(`[${t.theme}] ${c} keeps its hue`, hueGap(hue(got), hue(c)) <= 6, `→ ${got}`);
        check(`[${t.theme}] ${c} keeps its saturation (never greyed to "fix" contrast)`,
            sat(got) >= sat(c) - 0.12, `${sat(c).toFixed(2)} → ${sat(got).toFixed(2)}`);
        check(`[${t.theme}] ${c} clears 3:1 on the page`,
            contrastRatio(parseColor(got), parseColor(t.bg)) >= 3,
            `${got} on ${t.bg} = ${contrastRatio(parseColor(got), parseColor(t.bg)).toFixed(2)}`);
    }
}
check('a colour that already passes is left byte-identical',
    adaptColor('#ef4444', DARK) === '#ef4444', adaptColor('#ef4444', DARK));
check('the same colour IS moved where it fails',
    adaptColor('#1d4ed8', DARK) !== '#1d4ed8', 'dark blue on slate-900 is unreadable');

section('text is held to the 4.5:1 floor, not 3:1');
for (const t of THEMES) {
    const asText = adaptColor('#3b82f6', t, 'text');
    check(`[${t.theme}] chromatic text clears 4.5:1`,
        contrastRatio(parseColor(asText), parseColor(t.bg)) >= 4.5,
        `${asText} on ${t.bg}`);
}
check('a text colour is at least as strong as the same colour as a stroke',
    contrastRatio(parseColor(adaptColor('#3b82f6', DARK, 'text')), parseColor(DARK.bg))
    >= contrastRatio(parseColor(adaptColor('#3b82f6', DARK, 'stroke')), parseColor(DARK.bg)));

section('non-colours pass through untouched');
for (const v of ['none', 'transparent', 'url(#grad)', 'currentColor', 'inherit']) {
    check(`${v} is not rewritten`, adaptColor(v, DARK) === null);
}

section('ensureContrast never walks off the end');
const mid = parseColor('#808080');
check('a mid-grey background still returns a usable colour, never null/NaN',
    Number.isFinite(luminance(ensureContrast(parseColor('#3b82f6'), mid))));
check('it returns the BEST attempt when the floor is unreachable',
    contrastRatio(ensureContrast(parseColor('#7a7a85'), mid), mid)
    >= contrastRatio(parseColor('#7a7a85'), mid));

section('the p5 sandbox twin agrees with the module');
// The sandbox cannot import palette.ts, so it carries a copy. Two
// implementations of one rule are only safe while something compares them.
const twin = new Function(`${SANDBOX_THEME_JS}; return { __vtAdapt: __vtAdapt };`)();
const TWIN_CASES = [
    ['#000000', 'stroke', '#ffffff'], ['#1e293b', 'stroke', '#ffffff'],
    ['#ffffff', 'fill', '#ffffff'], ['#ffffff', 'stroke', '#ffffff'],
    ['#808080', 'stroke', '#ffffff'], ['#d3d3d3', 'stroke', '#ffffff'],
    ['#ef4444', 'fill', '#ffffff'], ['#3b82f6', 'stroke', '#ffffff'],
    ['#1d4ed8', 'stroke', '#ffffff'], ['#22c55e', 'fill', '#ffffff'],
    ['#eab308', 'stroke', '#ffffff'], ['#a855f7', 'fill', '#ffffff'],
    ['#11182740', 'fill', '#ffffff'], ['rgb(17, 24, 39)', 'fill', '#ffffff'],
    // A stated opacity is carried over, in the same notation on both sides.
    ['rgba(0,0,0,0.1)', 'stroke', '#ffffff'], ['rgba(59,130,246,0.2)', 'fill', '#ffffff'],
    ['#0002', 'stroke', '#ffffff'], ['rgb(0 0 0 / 50%)', 'stroke', '#ffffff'],
    ['rgba(255,255,255,0.3)', 'fill', '#ffffff'], ['rgba(0,0,0,1)', 'stroke', '#ffffff'],
    // The p5 case: a sketch that declared a dark canvas.
    ['#ffffff', 'stroke', '#111827'], ['#e2e8f0', 'text', '#111827'],
    ['#111827', 'fill', '#111827'], ['#94a3b8', 'stroke', '#111827'],
];
for (const t of THEMES) {
    for (const [c, role, assumed] of TWIN_CASES) {
        const a = adaptColor(c, t, role, assumed);
        const b = twin.__vtAdapt(c, t, role, assumed);
        check(`[${t.theme}] twin(${c}, ${role}, on ${assumed}) === adaptColor`, a === b, `${b} vs ${a}`);
    }
}
check('the twin refuses a non-colour exactly like the module',
    twin.__vtAdapt('none', DARK, 'fill', '#fff') === null && twin.__vtAdapt('url(#g)', DARK, 'fill', '#fff') === null);
check('the twin defaults its backdrop to paper, like the module',
    twin.__vtAdapt('#ffffff', DARK, 'stroke') === adaptColor('#ffffff', DARK, 'stroke'));

section('the p5 sandbox prelude wraps the right object');
// The bug this section exists for: p5 copies its drawing functions onto `window`
// inside the p5 CONSTRUCTOR, which runs on the load event — long after the
// prelude's own <script> has executed. Wrapping `window` there compiles, ships,
// and does exactly nothing: every sketch keeps its hardcoded near-black canvas
// on a light theme, with no error anywhere to say so. p5.prototype is populated
// as soon as p5.min.js has parsed, and the global copies are taken from it.
const prelude = p5ThemePrelude(DARK);
check('the prelude wraps p5.prototype, not window',
    /window\.p5\s*&&\s*window\.p5\.prototype/.test(prelude) && prelude.includes('proto[name]'),
    'wrapping window would be a silent no-op');
check('it falls back to window when the p5 constructor is not exposed',
    /\|\|\s*window;/.test(prelude));
check('it wraps all three colour entry points',
    ["apply('background'", "apply('fill'", "apply('stroke'"].every(s => prelude.includes(s)));
check('the theme is baked in as data, not read from the parent (the sandbox cannot reach it)',
    prelude.includes(JSON.stringify(DARK.bg)) && !prelude.includes('getComputedStyle'));
check('it carries the twin, so __vtAdapt exists in the sandbox',
    prelude.includes('function __vtAdapt('));

// Behavioural: run the prelude's wrappers against a stand-in p5 and check the
// colours a real sketch would produce. This is what the sketches in the guide
// literally do — background(17, 24, 39) then a slate-200 legend label.
function runPrelude(palette) {
    const calls = [];
    const record = (name) => function (...a) { calls.push([name, ...a]); };
    const proto = { background: record('background'), fill: record('fill'), stroke: record('stroke') };
    const win = { p5: { prototype: proto } };
    // The prelude is written for a browser global scope; give it `window`.
    new Function('window', p5ThemePrelude(palette))(win);
    return { proto, calls };
}
const hex = (r, g, b) => rgbToHex({ r: r / 255, g: g / 255, b: b / 255 });
for (const t of [LIGHT, WARM, DARK, BLACK]) {
    const { proto, calls } = runPrelude(t);
    // A guide-shaped sketch: dark canvas, then the legend's slate-200 label.
    proto.background(17, 24, 39);
    proto.fill(226, 232, 240);
    proto.stroke(56, 189, 248);
    const [bgCall, fillCall, strokeCall] = calls;
    check(`[${t.theme}] background(17,24,39) becomes the theme surface`,
        hex(bgCall[1], bgCall[2], bgCall[3]) === t.bg, hex(bgCall[1], bgCall[2], bgCall[3]));
    check(`[${t.theme}] the legend's slate-200 label becomes readable ink`,
        contrastRatio(parseColor(hex(fillCall[1], fillCall[2], fillCall[3])), parseColor(t.bg)) >= 4.5,
        hex(fillCall[1], fillCall[2], fillCall[3]));
    check(`[${t.theme}] a sky-blue stroke keeps its hue`,
        Math.abs(hue(hex(strokeCall[1], strokeCall[2], strokeCall[3])) - hue('#38bdf8')) <= 6);
}
{
    // A chromatic canvas is part of the picture, not "the page": a sky stays a sky.
    const { proto, calls } = runPrelude(LIGHT);
    proto.background(135, 206, 235);
    check('a CHROMATIC background is kept, not replaced by the theme surface',
        hue(hex(calls[0][1], calls[0][2], calls[0][3])) > 180 && hue(hex(calls[0][1], calls[0][2], calls[0][3])) < 230,
        hex(calls[0][1], calls[0][2], calls[0][3]));
}
{
    // Alpha is the author's; a translucent trail must stay translucent.
    const { proto, calls } = runPrelude(DARK);
    proto.background(17, 24, 39);
    proto.fill(226, 232, 240, 80);
    check('an alpha argument survives the remap', calls[1].length === 5 && calls[1][4] === 80);
}
{
    // A p5.Color object (or anything else unrecognised) must pass through.
    const { proto, calls } = runPrelude(DARK);
    const colorObj = { __p5Color: true };
    proto.fill(colorObj);
    check('an unrecognised argument is passed through untouched', calls[0][1] === colorObj);
}

section('Mermaid theme variables — a fill is never chosen without its label');
{
    // THE BUG THIS REPLACED. `theme: 'neutral'` handed every LIGHT theme
    // Mermaid's greyscale categorical ramp, so a mindmap drew six identical
    // grey boxes; and the mindmap ROOT reads `git0`/`gitBranchLabel0`, which
    // nothing had set for the dark themes, so the centre of the diagram was a
    // coloured blob with dark text on it.
    for (const palette of THEMES) {
        const vars = mermaidThemeVariables(palette);
        const failures = mermaidLabelsAreReadable(vars);
        check(`${palette.theme}: every fill/label pair clears 4.5:1`,
            failures.length === 0, failures.slice(0, 3).join(' · '));

        check(`${palette.theme}: the categorical ramp is not greyscale`,
            new Set(Array.from({ length: 12 }, (_, i) => vars[`cScale${i}`])).size >= 10
            && Array.from({ length: 12 }, (_, i) => vars[`cScale${i}`])
                .filter((c) => { const { r, g, b } = parseColor(c); return Math.max(r, g, b) - Math.min(r, g, b) >= 0.02; })
                .length >= 10);

        // Adjacent branches of a mindmap get consecutive indices, so the two
        // colours most likely to sit side by side are the ones that must differ.
        const adjacentSame = Array.from({ length: 11 }, (_, i) => vars[`cScale${i}`] === vars[`cScale${i + 1}`]).filter(Boolean);
        check(`${palette.theme}: no two adjacent ramp steps share a colour`, adjacentSame.length === 0);

        // The root node is the subject of a mindmap, so it carries the accent.
        check(`${palette.theme}: the mindmap root is the accent, legibly lettered`,
            vars.git0 === palette.accent && contrastRatio(parseColor(vars.git0), parseColor(vars.gitBranchLabel0)) >= 4.5,
            `${vars.git0} / ${vars.gitBranchLabel0}`);

        // An edge label sits ON the connector; the page has to show through.
        check(`${palette.theme}: edge labels are backed by the page surface`,
            vars.edgeLabelBackground === palette.bg);

        // Every node surface must be a distinct shape against the page, or a
        // flowchart is arrows with nothing on them.
        check(`${palette.theme}: the node surface is visible against the page`,
            contrastRatio(parseColor(vars.mainBkg), parseColor(palette.bg)) >= 1.05
            || vars.nodeBorder !== palette.bg);
    }
    check('every fill named by the builder is covered by a pair', MERMAID_FILL_LABEL_PAIRS.length >= 27, String(MERMAID_FILL_LABEL_PAIRS.length));
}

section('Accent input — a colour is read the way a person writes one');
{
    // The swatches are a shortlist. Someone matching a brand or a screenshot
    // has a value in hand, in whichever notation the tool they copied it from
    // uses, and all of these are the same request.
    const same = [
        ['#0e7490', '#0e7490', 'a full hex'],
        ['0e7490', '#0e7490', 'a hex typed without the #'],
        ['  #0E7490  ', '#0e7490', 'case and surrounding space'],
        ['#e74', '#ee7744', 'the three-digit shorthand'],
        ['rgb(14 116 144)', '#0e7490', 'space-separated rgb()'],
        ['rgb(14,116,144)', '#0e7490', 'comma-separated rgb()'],
        ['rgba(14, 116, 144, 0.5)', '#0e7490', 'rgba() — alpha dropped, since the app composites the accent itself'],
        ['hsl(0 100% 50%)', '#ff0000', 'hsl() red'],
        ['hsl(120, 100%, 50%)', '#00ff00', 'hsl() green'],
        ['hsl(240 100% 50%)', '#0000ff', 'hsl() blue — hue is read in degrees, not turns'],
    ];
    for (const [input, want, why] of same) {
        check(why, parseCssColor(input) === want, `${JSON.stringify(input)} → ${parseCssColor(input)}`);
    }

    // Null is the contract: the field must keep what is still being typed
    // rather than snap to a guess halfway through it.
    for (const junk of ['', '   ', 'nonsense', '#12', '#0e749', 'rgb(1,2)', 'hsl(1,2)', 'var(--x)']) {
        check(`${JSON.stringify(junk)} is not a colour`, parseCssColor(junk) === null, String(parseCssColor(junk)));
    }

    // Whatever they type still has to survive as a solid accent under white
    // text — the clamp that already guards a project colour guards this too.
    check('an arbitrary typed colour is clamped to a usable solid accent',
        /^\d+ \d+ \d+$/.test(accentSolidTriplet(parseCssColor('#ffee00'))), accentSolidTriplet(parseCssColor('#ffee00')));
}


// ── The widget's theme bridge ───────────────────────────────────────────────
//
// A widget is the one visual kind the app does not re-render on a theme change
// (it is interactive; a re-render throws away slider positions and pays another
// verification probe), so it follows the theme through variables swapped into a
// live iframe. Which means everything below is the ONLY thing standing between
// a cached build and a white card on a black theme.
const widgetOut = join(scratch, 'widget-theme.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/visuals/widgetTheme.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: widgetOut,
    logLevel: 'silent',
});
const {
    WIDGET_THEME_JS, widgetThemeCss, widgetThemeVars, widgetThemePrelude, widgetPalette,
} = await import(pathToFileURL(widgetOut).href);

section('the host owns the theme variables — a build cannot pin itself light');
// The bug this section exists for: builds that open with their own
// `:root { --w-bg: #ffffff; … }` fallback block. The
// host injects its variables at the top of <head>, so the build's copy is later
// in source order, wins at equal specificity, and pins the widget to white on
// every theme — including a re-theme, which rewrites the block that already lost.
const wcss = widgetThemeCss(DARK);
check('the variable block outranks a :root the build declares itself',
    /:root\s*,\s*:root:root\s*\{/.test(wcss), wcss.slice(0, 60));
check('background and colour outrank a body rule the build declares itself',
    /html\s+body\s*\{[^}]*background/.test(wcss), wcss);
check('font-family is NOT raised — a build may legitimately choose its own',
    /(^|})body\s*\{[^}]*font-family/.test(wcss));
// The four theme fixtures above carry no series (the other sections do not
// need them); the real palette always does, and each one is a variable the
// compiler prompt promises the builder.
const wvars = widgetThemeVars({ ...DARK, series: ['#3b82f6', '#f97316'] });
for (const name of ['--w-bg', '--w-fg', '--w-muted', '--w-border', '--w-accent', '--w-accent-2', '--w-series-1', '--w-series-2']) {
    check(`${name} is defined by the host`, wvars.includes(`${name}:`), wvars);
}

// The sandbox half, evaluated the way the p5 twin is: pure functions, no DOM.
const wt = new Function(
    `${SANDBOX_THEME_JS}${WIDGET_THEME_JS}; return { remap: __wtCssRemap, adapt: __wtAdapt };`,
)();
const wpal = (t) => widgetPalette(t);

section('a build that declares its own --w-* fallbacks is neutralised');
const OWN_VARS = ':root{--w-bg:#ffffff;--w-fg:#111827;--w-series-1:#2563eb;}';
for (const t of THEMES) {
    const css = wt.remap(OWN_VARS, wpal(t));
    check(`[${t.theme}] the build's own --w-* definitions are gone`,
        !/--w-(bg|fg|series-1)\s*:/.test(css), css);
    check(`[${t.theme}] the rule itself survives (a deleted block is not a fix)`,
        css.includes(':root') && css.includes('{') && css.includes('}'), css);
}

section('a hardcoded page follows the theme it is read in');
// What a model writes when it imagines white paper — the exact literals in the
// Doppler build that prompted this.
const PAGE = '.card{background:#ffffff;color:#111827;border:1px solid #e5e7eb;}';
for (const t of THEMES) {
    const css = wt.remap(PAGE, wpal(t));
    const got = (prop) => (css.match(new RegExp(`${prop}:\\s*([^;}]+)`)) || [])[1]?.trim();
    check(`[${t.theme}] a white card becomes this theme's surface`,
        got('background') === t.bg, got('background'));
    check(`[${t.theme}] near-black body text becomes readable ink`,
        contrastRatio(parseColor(got('color')), parseColor(t.bg)) >= 4.5,
        `${got('color')} on ${t.bg}`);
    check(`[${t.theme}] a hairline border becomes this theme's hairline`,
        css.includes(t.border), css);
}

section('a colour the host itself supplied is never re-judged');
// The trap, and it is the one that would have made this change worse than the
// bug: a compliant widget reads var(--w-fg) and hands the RESOLVED value to the
// canvas. On dark that is #f1f5f9 — achromatic, and against the paper backdrop
// a model is assumed to have drawn for it reads as "barely there", so the
// ordinary rule would demote this theme's own ink to this theme's background
// and erase every label on the card.
for (const t of THEMES) {
    for (const [name, value] of [['fg', t.fg], ['bg', t.bg], ['muted', t.muted], ['border', t.border], ['accent', t.accent]]) {
        check(`[${t.theme}] palette.${name} passes through the canvas wrapper untouched`,
            wt.adapt(value, wpal(t), 'fill') === null, String(wt.adapt(value, wpal(t), 'fill')));
    }
    check(`[${t.theme}] var(--w-fg) is left alone in CSS`,
        wt.remap('.a{color:var(--w-fg);}', wpal(t)).includes('var(--w-fg)'));
}

section('the canvas wrapper carries emphasis over, like every other visual');
// null is the contract for "leave it exactly as it was", so a colour that is
// already right on this theme reads back as itself.
const settle = (raw, t, role) => wt.adapt(raw, wpal(t), role) || raw;
for (const t of THEMES) {
    const ink = settle('#111827', t, 'fill');
    check(`[${t.theme}] a hardcoded near-black label becomes readable ink`,
        contrastRatio(parseColor(ink), parseColor(t.bg)) >= 4.5, `${ink} on ${t.bg}`);
    const series = settle('#2563eb', t, 'stroke');
    check(`[${t.theme}] a chromatic series colour keeps its hue and clears 3:1`,
        hueGap(hue(series), hue('#2563eb')) < 12
        && contrastRatio(parseColor(series), parseColor(t.bg)) >= 3,
        `${series} on ${t.bg}`);
}

section('the remap is a colour pass, not a CSS rewriter');
// It runs over model-authored stylesheets, so damaging one is a widget that
// renders wrong with nothing thrown. Selectors are not declarations.
const INTACT = [
    ['#chart{width:100%;}', 'an id selector is not a hex colour'],
    ['a:hover{text-decoration:underline;}', 'a pseudo-class is not a declaration'],
    ['@media (max-width:400px){.a{padding:4px;}}', 'an at-rule round-trips'],
    ['.a{font:12px/1.4 monospace;}', 'a shorthand with no colour is untouched'],
    ['.a{background:url(#grad);}', 'a url() reference is untouched'],
];
for (const [css, why] of INTACT) {
    check(why, wt.remap(css, wpal(DARK)) === css, wt.remap(css, wpal(DARK)));
}
check('a six-digit hex is not eaten three digits at a time',
    !/#ffffffff|fff[;}]/.test(wt.remap('.a{color:#ffffff;}', wpal(DARK))),
    wt.remap('.a{color:#ffffff;}', wpal(DARK)));

section('the widget prelude wires the sandbox up');
const wprelude = widgetThemePrelude(DARK);
check('it carries the twin, so the rule in the sandbox is the rule in the module',
    wprelude.includes('function __vtAdapt(') && wprelude.includes('function __wtCssRemap('));
check('it wraps CanvasRenderingContext2D.prototype, where the drawing colours land',
    wprelude.includes('CanvasRenderingContext2D') && wprelude.includes('fillStyle'));
check('it wraps the gradient colour stops too',
    wprelude.includes('addColorStop'));
check('it re-derives every remap from the build\'s ORIGINAL css, not from the last one',
    wprelude.includes('__wtOrig'),
    'remapping an already-remapped stylesheet compounds on every theme change');
check('it nudges a redraw, or a widget that only draws on input keeps the old canvas',
    /dispatchEvent\(new Event\('resize'\)\)/.test(wprelude));
check('the theme is baked in as data — the sandbox cannot reach the parent',
    wprelude.includes(JSON.stringify(DARK.bg)));

section('a molecule is drawn in the theme it is read in, not in CPK');
// smiles-drawer ships fixed element colours — oxygen #e74c3c, nitrogen #3498db,
// sulphur #f1c40f — that belong to no theme this app has. Beside seven
// accent-drawn samples on a dark page, aspirin's oxygens were the brightest red
// on the screen. Every atom it colours it also LABELS, so the letter carries
// the element and the colour only has to say "not carbon".
const CPK = ['#e74c3c', '#3498db', '#27ae60', '#16a085', '#d35400', '#8e44ad', '#f1c40f', '#e67e22', '#222222', '#141414'];
for (const t of THEMES) {
    const theme = appTheme(t);
    const values = Object.values(theme).map(v => v.toLowerCase());
    check(`[${t.theme}] no colour of the library's own survives`,
        !values.some(v => CPK.includes(v)), values.join(' '));
    check(`[${t.theme}] the carbon skeleton is the theme's ink`,
        theme.C === t.fg && theme.FOREGROUND === t.fg, `${theme.C} / ${t.fg}`);
    check(`[${t.theme}] every other element is the accent`,
        HETEROATOMS.every(el => theme[el] === t.accentFg), HETEROATOMS.map(el => theme[el]).join(' '));
    // An atom label is an 11px letter, so it is TEXT: the accent's 3:1 graphic
    // strength draws those thin, which is why `accentFg` is what is read here.
    check(`[${t.theme}] …at a strength a letter can be read at (4.5:1)`,
        contrastRatio(parseColor(theme.O), parseColor(t.bg)) >= 4.5,
        `${theme.O} on ${t.bg} = ${contrastRatio(parseColor(theme.O), parseColor(t.bg)).toFixed(2)}`);
    check(`[${t.theme}] hydrogen stays the quiet ink it was`,
        theme.H === t.muted, theme.H);
}

const { JSDOM } = require('jsdom');
const svgParser = new (new JSDOM('').window.DOMParser)();
const parseSvg = (inner) => svgParser.parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300">${inner}</svg>`, 'image/svg+xml').documentElement;

section('a colour that states an opacity keeps it');
// A translucent shadow, gridline or highlight band came back as a solid colour
// (parseColor reads the three channels only), so a 10% gridline became a heavy
// ink line and a 20% band became a slab over what it highlighted.
{
    const fg = parseColor(DARK.fg);
    const rgba = (c, a) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
    check('a 10% black gridline on a dark theme is 10% of the foreground, not solid ink',
        adaptColor('rgba(0,0,0,0.1)', DARK, 'stroke') === rgba(fg, 0.1), adaptColor('rgba(0,0,0,0.1)', DARK, 'stroke'));
    check('a chromatic wash keeps its hue and its 20%',
        adaptColor('rgba(59,130,246,0.2)', LIGHT, 'fill') === 'rgba(59,130,246,0.2)', adaptColor('rgba(59,130,246,0.2)', LIGHT, 'fill'));
    check('an 8-digit hex carries its alpha byte over (0x20 is 0.125)',
        /,0\.125\)$/.test(adaptColor('#00000020', DARK, 'fill')), adaptColor('#00000020', DARK, 'fill'));
    check('a 4-digit hex does too (0x2 doubled is 0.133)',
        /,0\.133\)$/.test(adaptColor('#0002', DARK, 'stroke')), adaptColor('#0002', DARK, 'stroke'));
    check('a percentage alpha after a slash is read',
        /,0\.5\)$/.test(adaptColor('rgb(0 0 0 / 50%)', DARK, 'stroke')), adaptColor('rgb(0 0 0 / 50%)', DARK, 'stroke'));
    check('an alpha of 1 is an ordinary solid colour',
        adaptColor('rgba(0,0,0,1)', DARK, 'stroke') === DARK.fg);
    check('a colour with no alpha is unchanged (hex out)', adaptColor('#000000', DARK, 'stroke') === DARK.fg);
    const svg = parseSvg('<rect width="4" height="4" fill="rgba(0,0,0,0.3)"/>');
    themeSvgColors(svg, DARK);
    check('the SVG pass keeps it on an attribute', svg.querySelector('rect').getAttribute('fill') === rgba(fg, 0.3),
        svg.querySelector('rect').getAttribute('fill'));
}

section('a backdrop stated in percent is a backdrop');
// `<rect width="100%" height="100%">` is the usual full-bleed backdrop. It was
// read as 100 units, so a dark scene arrived with its backdrop treated as ink
// and its pale elements judged against white paper: inverted, not themed.
{
    const parse = parseSvg;
    for (const [label, rect] of [
        ['100% width and height', '<rect width="100%" height="100%" fill="#0f172a"/>'],
        ['units', '<rect width="600" height="300" fill="#0f172a"/>'],
        ['percent with a zero offset', '<rect x="0%" y="0%" width="100%" height="100%" fill="#0f172a"/>'],
    ]) {
        const svg = parse(`${rect}<text x="5" y="20" fill="#ffffff">hi</text>`);
        themeSvgColors(svg, LIGHT);
        check(`[${label}] the backdrop becomes the theme surface`, svg.querySelector('rect').getAttribute('fill') === LIGHT.bg,
            svg.querySelector('rect').getAttribute('fill'));
        check(`[${label}] and white text drawn on it is the strongest ink, so it turns dark on a light page`,
            svg.querySelector('text').getAttribute('fill') === LIGHT.fg, svg.querySelector('text').getAttribute('fill'));
    }
    const part = parse('<rect width="50%" height="100%" fill="#0f172a"/>');
    themeSvgColors(part, LIGHT);
    check('half the width is not a backdrop', part.querySelector('rect').getAttribute('fill') !== LIGHT.bg,
        part.querySelector('rect').getAttribute('fill'));
    // A translucent rect over the whole drawing is a dim or a wash laid over the
    // content, not the surface the content sits on.
    for (const [label, rect] of [
        ['a fill-opacity below 1', '<rect width="100%" height="100%" fill="#0f172a" fill-opacity="0.5"/>'],
        ['an rgba fill', '<rect width="100%" height="100%" fill="rgba(15,23,42,0.08)"/>'],
        ['an opacity below 1', '<rect width="100%" height="100%" fill="#0f172a" opacity="0.3"/>'],
    ]) {
        const veil = parse(rect);
        themeSvgColors(veil, LIGHT);
        check(`${label} on a full-size rect is an overlay, not the backdrop`, veil.querySelector('rect').getAttribute('fill') !== LIGHT.bg,
            veil.querySelector('rect').getAttribute('fill'));
    }
}

section('p5 colorMode and string colours');
{
    const run = (palette, state) => {
        const calls = [];
        const record = (name) => function (...a) { calls.push([name, ...a]); };
        const proto = { background: record('background'), fill: record('fill'), stroke: record('stroke'), ...state };
        new Function('window', p5ThemePrelude(palette))({ p5: { prototype: proto } });
        return { proto, calls };
    };
    const HSB = { _colorMode: 'hsb', _colorMaxes: { rgb: [255, 255, 255, 255], hsb: [360, 100, 100, 1] } };
    const UNIT = { _colorMode: 'rgb', _colorMaxes: { rgb: [1, 1, 1, 1], hsb: [360, 100, 100, 1] } };
    const RGB = { _colorMode: 'rgb', _colorMaxes: { rgb: [255, 255, 255, 255], hsb: [360, 100, 100, 1] } };
    {
        const { proto, calls } = run(DARK, HSB);
        proto.fill(60, 100, 100);
        check('numbers in HSB mode are not read as RGB: handed to p5 exactly as written',
            JSON.stringify(calls[0]) === JSON.stringify(['fill', 60, 100, 100]), JSON.stringify(calls[0]));
        proto.stroke(200, 50, 50, 0.5);
        check('so are four numbers with an alpha', JSON.stringify(calls[1]) === JSON.stringify(['stroke', 200, 50, 50, 0.5]), JSON.stringify(calls[1]));
        proto.fill('#ffffff');
        check('a CSS string in HSB mode is still adapted (a string is CSS in every mode)',
            calls[2].length === 2 && calls[2][1] === DARK.bg, JSON.stringify(calls[2]));
    }
    {
        // The backdrop declared in numbers the sketch's colour mode owns is still
        // the backdrop: a later CSS string is judged against it.
        const asHsb = (hexOut) => ({ ...HSB, color: () => ({ toString: () => hexOut }) });
        const { proto, calls } = run(LIGHT, asHsb('#0f172a'));
        proto.background(222, 60, 15);
        proto.stroke('#e2e8f0');
        const onDark = calls[1][1];
        const plain = run(LIGHT, HSB);
        plain.proto.background(222, 60, 15);
        plain.proto.stroke('#e2e8f0');
        const onPaper = plain.calls[1][1];
        check('control: with no backdrop known, a pale stroke is judged against paper', onPaper !== onDark, `${onPaper} vs ${onDark}`);
        check('a background in HSB numbers is the backdrop later string colours are judged against',
            onDark === LIGHT.fg, `${onDark} (paper reading: ${onPaper})`);
    }
    {
        const { proto, calls } = run(DARK, UNIT);
        proto.fill(0.1, 0.1, 0.1);
        check('RGB with a 0-1 range is handed through too',
            JSON.stringify(calls[0]) === JSON.stringify(['fill', 0.1, 0.1, 0.1]), JSON.stringify(calls[0]));
    }
    {
        const { proto, calls } = run(DARK, RGB);
        proto.fill(226, 232, 240);
        check('default RGB 0-255 is still adapted', calls[0].length === 4 && hex(calls[0][1], calls[0][2], calls[0][3]) !== '#e2e8f0', JSON.stringify(calls[0]));
    }
    {
        const { proto, calls } = run(DARK, RGB);
        proto.fill('rgba(0,0,0,0.3)');
        check('a translucent CSS string keeps its alpha', calls[0][1] === 'rgba(241,245,249,0.3)', JSON.stringify(calls[0]));
        proto.background('rgba(0,0,0,0.2)');
        check('and so does a translucent background string', calls[1][1] === `rgba(15,23,42,0.2)`, JSON.stringify(calls[1]));
    }
}

section('a build\'s own --w-* variables survive unless the host defines them');
{
    const css = ':root{--w-radius:8px;--w-gap:12px;--w-height:40px;--w-bg:#ffffff;--w-accent-2:#f00;--w-series-3:#0f0;--w-fg:#111;}';
    for (const t of THEMES) {
        const got = wt.remap(css, wpal(t));
        check(`[${t.theme}] --w-radius, --w-gap and --w-height are kept`,
            ['--w-radius:8px', '--w-gap:12px', '--w-height:40px'].every((d) => got.includes(d)), got);
        check(`[${t.theme}] the host's own names are still removed`,
            !/--w-(bg|fg|accent-2|series-3)\s*:/.test(got), got);
    }
}

section('a re-theme keeps what the widget\'s own script has set');
// `__wtOrig` is the build's text at load. A re-theme that re-derived from it
// alone put a bar's height or an indicator's position back where it started,
// which is exactly what the live re-theme exists to avoid.
{
    const boot = (body, palette = DARK, extra) => {
        const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { runScripts: 'outside-only' });
        const w = dom.window;
        if (extra) extra(w);
        w.eval(widgetThemePrelude(palette));
        return w;
    };
    const asHex = (v) => rgbToHex(parseColor(v));
    const w = boot('<div id="bar" style="height:10px;background-color:#ffffff"></div>'
        + '<svg><rect id="r" fill="#ffffff"/><rect id="s" fill="#ffffff"/></svg>');
    w.__wtApply();
    const bar = w.document.getElementById('bar');
    check('the first pass themes the inline style', asHex(bar.style.backgroundColor) === DARK.bg, bar.getAttribute('style'));
    bar.style.height = '50px';
    w.document.getElementById('r').setAttribute('fill', '#ff0000');
    w.__wtRetheme(wpal(WARM));
    check('a height the script set is still there after a re-theme', bar.style.height === '50px', bar.getAttribute('style'));
    check('the colour in the same attribute follows the new theme', asHex(bar.style.backgroundColor) === WARM.bg, bar.getAttribute('style'));
    check('a fill the script set on an SVG element survives a re-theme',
        w.document.getElementById('r').getAttribute('fill') === '#ff0000', w.document.getElementById('r').getAttribute('fill'));
    w.__wtRetheme(wpal(LIGHT));
    check('an SVG fill nothing adapts on this theme goes back to the original, not the last theme\'s colour',
        w.document.getElementById('s').getAttribute('fill') === '#ffffff', w.document.getElementById('s').getAttribute('fill'));
    w.__wtRetheme(wpal(DARK));
    w.__wtRetheme(wpal(WARM));
    check('theme order does not matter: a run of re-themes lands where one would',
        asHex(bar.style.backgroundColor) === WARM.bg && bar.style.height === '50px', bar.getAttribute('style'));
}

section('a canvas gradient is not painted over by a stale fill colour');
// The full-canvas `fillRect` backdrop check reads the last string fill colour.
// After a gradient (or a restore()) that string no longer says what is painted,
// and the gradient background was overwritten with the flat theme surface.
{
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const w = dom.window;
    class Ctx {
        constructor() { this.canvas = { width: 100, height: 100 }; this._f = '#000000'; this._s = '#000000'; this._stack = []; this.painted = []; }
        get fillStyle() { return this._f; } set fillStyle(v) { this._f = v; }
        get strokeStyle() { return this._s; } set strokeStyle(v) { this._s = v; }
        get shadowColor() { return 'x'; } set shadowColor(v) { /* unused */ }
        fillRect() { this.painted.push(this._f); }
        save() { this._stack.push(this._f); }
        restore() { this._f = this._stack.pop(); }
    }
    w.CanvasRenderingContext2D = Ctx;
    w.eval(widgetThemePrelude(DARK));
    const grad = { gradient: true };
    const full = (ctx) => ctx.fillRect(0, 0, 100, 100);
    let ctx = new Ctx();
    ctx.fillStyle = '#ffffff'; full(ctx);
    check('control: a flat white full-canvas fill is still the theme surface', ctx.painted[0] === DARK.bg, String(ctx.painted[0]));
    ctx = new Ctx();
    ctx.fillStyle = '#ffffff'; ctx.fillStyle = grad; full(ctx);
    check('a gradient assigned after a colour is what the full-canvas fill paints', ctx.painted[0] === grad, String(ctx.painted[0]));
    ctx = new Ctx();
    ctx.fillStyle = grad; ctx.save(); ctx.fillStyle = '#ffffff'; ctx.restore(); full(ctx);
    check('and a restore() back to a gradient is not overwritten by the colour set in between', ctx.painted[0] === grad, String(ctx.painted[0]));
    ctx = new Ctx();
    ctx.fillStyle = grad; ctx.strokeStyle = '#ffffff'; full(ctx);
    check('a stroke colour is never read as the fill', ctx.painted[0] === grad, String(ctx.painted[0]));
    // A translucent full-canvas fill (a trail fade, a dim over the chart) is
    // laid over the frame on purpose: it keeps the opacity the author stated.
    const bgc = parseColor(DARK.bg);
    const bgAt = (a) => `rgba(${Math.round(bgc.r * 255)},${Math.round(bgc.g * 255)},${Math.round(bgc.b * 255)},${a})`;
    ctx = new Ctx();
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; full(ctx);
    check('a 5% white trail fade over the whole canvas stays 5% of the surface, not an opaque slab', ctx.painted[0] === bgAt(0.05), String(ctx.painted[0]));
    ctx = new Ctx();
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; full(ctx);
    check('a 60% black dim over the whole canvas stays 60%', ctx.painted[0] === bgAt(0.6), String(ctx.painted[0]));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
