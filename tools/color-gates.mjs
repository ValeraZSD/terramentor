#!/usr/bin/env node
// color-gates.mjs — choosing a colour is one control, and the chip must not lie.
//
// There were two colour pickers, and a source scan would have called both of
// them fine: each was internally consistent. What no per-element check could see
// was that they DISAGREED — the older one had no tick, no value field, no focus
// ring, and a `ring-offset` whose gap is painted (a pale halo on Warm and on
// Black). So half of this file is sameness, like control-gates.
//
// The other half is the thing that had never been checked at all: a project's
// colour is not painted as chosen. It becomes `--accent-rgb` through
// `accentSolidTriplet`, which darkens it until white label text clears AA — so
// the palette is only honest if every entry survives that with a readable button
// AND the dialog shows the result. Measured, not scanned: the numeric gate
// taught that a source scan misses a divergence between two implementations, so
// these run the real functions over the real palettes.
//
//   node tools/color-gates.mjs
//   node tools/color-gates.mjs --json
//
// Not committed (see .gitignore `tools/`).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
/**
 * The same file with its prose removed. The first run of this gate failed on the
 * paragraph EXPLAINING why `grid-cols-4 sm:` and `ring-offset` are wrong: a
 * scanner that reads the comments is grading the argument, not the code.
 */
const code = (rel) => read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments, JSX ones included
    .replace(/^\s*\/\/.*$/gm, ' ');       // whole-line comments only, so a URL survives

const findings = [];
let checked = 0;
const ok = (name, cond, detail) => {
    checked++;
    if (!cond) findings.push({ name, detail });
};

// ---------------------------------------------------------------------------
// The palettes and the helpers, read out of the source they ship in.
// ---------------------------------------------------------------------------
const FIELD_SRC = read('src/components/ui/ColorField.tsx');
const COLOR_SRC = read('src/utils/color.ts');

const paletteOf = (name) => {
    const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(FIELD_SRC);
    if (!m) return null;
    return [...m[1].matchAll(/'(#[0-9a-fA-F]{3,8})'/g)].map((x) => x[1]);
};
const PROJECT_COLORS = paletteOf('PROJECT_COLORS');
const ACCENT_COLORS = paletteOf('ACCENT_COLORS');

// The real helpers, imported from the app rather than reimplemented here: Node
// strips the types, and a copy of this arithmetic in the gate would be free to
// drift from the arithmetic that ships — which is the divergence the numeric
// gate had to be rewritten to catch.
const { hexToRgb, rgbToHsl, accentSolidTriplet, parseCssColor } = await import('../src/utils/color.ts');

const relLum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
    const l1 = relLum(a), l2 = relLum(b);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
};
const WHITE = [255, 255, 255];
/** What the app actually paints a button with, for a given chosen colour. */
const solid = (hex) => accentSolidTriplet(hex).split(' ').map(Number);

// ---------------------------------------------------------------------------
// 1. ONE picker.
// ---------------------------------------------------------------------------
ok('the swatch grid lives in exactly one component',
    PROJECT_COLORS && ACCENT_COLORS,
    'src/components/ui/ColorField.tsx must export PROJECT_COLORS and ACCENT_COLORS');

const COLOR_INPUTS = [
    'src/components/ProjectFormFields.tsx',
    'src/components/Settings.tsx',
    'src/components/ui/ColorField.tsx',
];
for (const rel of COLOR_INPUTS) {
    const src = code(rel);
    const owns = rel.endsWith('ColorField.tsx');
    ok(`${rel} does not hand-roll a colour input`,
        owns === src.includes('type="color"'),
        owns ? 'ColorField is the one place a colour is entered' : 'use <ColorField>, not a second <input type="color">');
}

// The halo rule: the offset on a `ring` is PAINTED (`--tw-ring-offset-color`,
// white by default), which is wrong on three of the four themes. The mark that
// replaced it is an `outline`, whose offset gap is transparent.
for (const rel of ['src/components/ui/ColorField.tsx', 'src/components/IconPicker.tsx']) {
    const src = code(rel);
    ok(`${rel} marks the selection with an outline, not a painted ring offset`,
        !/ring-offset-(?!0)/.test(src) && /outline-offset-2/.test(src),
        'ring-offset paints its gap; outline-offset leaves it transparent');
}

// A viewport breakpoint deciding the shape of something that is also mounted in
// a 448px dialog on a 1200px screen is the container-width bug, again.
//
// The rule used to be spelled "the class is `grid-cols-8` and nothing else",
// which is the same thing only as long as the count is fixed. `ColorField` grew
// a `dense` mode on 2026-09-17 (half-width chips for the app icon's tile
// palette: sixteen across where there is room, eight where there is not), and a
// count that CHANGES is fine — the fault this guards against is a count that
// changes with the VIEWPORT. So: no responsive grid variant anywhere, and a
// count that is not the constant has to come from a measurement of the
// component's own box.
for (const rel of ['src/components/ui/ColorField.tsx', 'src/components/IconPicker.tsx']) {
    const src = code(rel);
    const responsive = [...src.matchAll(/\b(?:sm|md|lg|xl|2xl):grid-cols-\S*/g)].map((m) => m[0]);
    ok(`${rel} lets no viewport breakpoint set its column count`,
        responsive.length === 0, `found ${responsive.join(', ')}`);
    const fixed = [...src.matchAll(/\bgrid-cols-\d+/g)].map((m) => m[0]);
    const computed = /gridTemplateColumns/.test(src);
    ok(`${rel} draws either one fixed count or one it measured`,
        (fixed.length > 0 || computed) && (!computed || /ResizeObserver/.test(src)),
        computed ? 'a computed count with no ResizeObserver behind it' : `found ${fixed.join(', ') || 'no grid'}`);
}

// ---------------------------------------------------------------------------
// 1b. The wide shape: the palette is a BLOCK and the value stands beside it.
//
// Left to fill the width the chips always will — a `1fr` column takes whatever
// it is given, which is how sixteen swatches became a 736px stripe with the
// value they belong to on a line of its own underneath. Past the width where
// everything fits side by side the chips stop stretching.
//
// The fault worth a gate is ARITHMETIC, not taste. The shape is chosen by
// comparing the control's own box against a sum of the pieces — and the pieces
// are a different size on a finger (the 44px touch floor) than under a mouse.
// Choose the shape for the mouse's chip while drawing the finger's and the row
// does not fit: the field is pushed off the card. So the numbers are read out
// of the component that ships and the sum is re-run here.
// ---------------------------------------------------------------------------
const rem = (name) => {
    const m = new RegExp(`const ${name} = ([\\d.]+);`).exec(FIELD_SRC);
    return m ? Number(m[1]) : NaN;
};
const B = {
    cols: rem('BESIDE_COLUMNS'), chip: rem('CHIP_REM'), chipTouch: rem('CHIP_TOUCH_REM'),
    gap: rem('BESIDE_GAP_REM'), group: rem('GROUP_GAP_REM'), pipette: rem('PIPETTE_REM'),
    row: rem('ROW_GAP_REM'), valueMin: rem('VALUE_MIN_REM'),
};
ok('the wide shape states its measurements where they can be read',
    Object.values(B).every(Number.isFinite), JSON.stringify(B));

/** What the component demands before it will lay the row out, in rem. */
const threshold = (chip) =>
    B.cols * chip + (B.cols - 1) * B.gap + B.group + B.pipette + B.row + B.valueMin;
/** What the row actually DRAWS, with the field at its own `w-36` and no slack. */
const drawn = (chip) =>
    B.cols * chip + (B.cols - 1) * B.gap + B.group + B.pipette + B.row + 9;
for (const [who, chip] of [['a mouse', B.chip], ['a finger', B.chipTouch]]) {
    ok(`the row it chooses for ${who} fits the field it draws`,
        drawn(chip) <= threshold(chip),
        `needs ${drawn(chip)}rem, asks for ${threshold(chip)}rem`);
}
ok('a finger asks for more room than a mouse, because its chips are bigger',
    threshold(B.chipTouch) > threshold(B.chip),
    'the touch floor is drawn but not paid for');

// The three boxes this control is really mounted in, measured in Edge on
// 2026-09-17: a 736px settings card past 1100px, a 612px one at 900px, a 348px
// phone. A `ui_scale` of 160% is the fourth case — the sum is rem, so a bigger
// root font raises the bar rather than overflowing the card.
const fits = (px, root, touch) => px >= threshold(touch ? B.chipTouch : B.chip) * root;
ok('a 736px card takes the wide shape under either pointer',
    fits(736, 16, false) && fits(736, 16, true));
ok('a 612px card takes it under a mouse and not under a finger',
    fits(612, 16, false) && !fits(612, 16, true));
ok('a 348px phone takes it under neither',
    !fits(348, 16, false) && !fits(348, 16, true));
ok('and the bar rises with ui_scale rather than the row overflowing',
    !fits(736, 25.6, false), 'at 160% the same card no longer holds the row');

{
    const src = code('src/components/ui/ColorField.tsx');
    ok('the chips stop stretching once the value stands beside them',
        /beside[\s\S]{0,40}repeat\(\$\{columns\}, auto\)/.test(src),
        'a 1fr column beside the field is the stripe again');
    ok('the eyedropper takes the block\'s height rather than a number of its own',
        /self-stretch/.test(src),
        'a hand-set height stops matching the moment a chip changes size');
}

// ---------------------------------------------------------------------------
// 2. The palettes.
// ---------------------------------------------------------------------------
for (const [name, palette] of [['PROJECT_COLORS', PROJECT_COLORS], ['ACCENT_COLORS', ACCENT_COLORS]]) {
    if (!palette) continue;
    ok(`${name} divides evenly into the 8-column grid`,
        palette.length % 8 === 0,
        `${palette.length} swatches leaves an orphan row`);
    ok(`${name} holds no duplicate`,
        new Set(palette.map((c) => c.toLowerCase())).size === palette.length,
        'two identical chips are two ways to pick one colour');
    ok(`${name} is all parseable 6-digit hex`,
        palette.every((c) => hexToRgb(c)),
        palette.filter((c) => !hexToRgb(c)).join(' '));
}

// An ACCENT swatch is painted as chosen, so it must already clear AA itself.
for (const c of ACCENT_COLORS || []) {
    ok(`accent ${c} carries white label text as chosen`,
        contrast(hexToRgb(c), WHITE) >= 4.5,
        `${contrast(hexToRgb(c), WHITE).toFixed(2)}:1 against white`);
}

// A PROJECT swatch is darkened first — but the result must be a real colour, not
// the near-white `#ffffff` used to produce (a white button with a white label).
// This is the assertion that would have caught it.
for (const c of PROJECT_COLORS || []) {
    const s = solid(c);
    ok(`project ${c} still paints a readable button`,
        contrast(s, WHITE) >= 4.5,
        `becomes rgb(${s.join(' ')}) at ${contrast(s, WHITE).toFixed(2)}:1`);
}
// A chip must also RESEMBLE what it paints. The darkening is invisible at a
// glance for every current swatch (19 lightness points at the worst, amber) and
// enormous for anything pale — white moves 54, which is how a white chip came to
// stand for a grey button. 25 points is the line, with headroom on both sides.
for (const c of PROJECT_COLORS || []) {
    const [, , lc] = rgbToHsl(...hexToRgb(c));
    const [, , ls] = rgbToHsl(...solid(c));
    ok(`project ${c} is close to the shade it paints`,
        lc - ls <= 0.25,
        `${((lc - ls) * 100).toFixed(1)} lightness points darker once painted`);
}

// A colour within a whisker of the surface needs a drawn edge or it reads as a
// hole in the grid — slate is 1.41:1 against the dark panel it sits on.
for (const rel of ['src/components/ui/ColorField.tsx']) {
    ok(`${rel} draws an edge on every chip`,
        /shadow-\[inset_0_0_0_1px/.test(code(rel)),
        'a swatch the colour of its panel is invisible without one');
    // …and draws it in the SHADOW channel, because `ring-*` is the focus ring's
    // channel: an inset resting ring made the focus ring inset too.
    ok(`${rel} leaves the ring channel to the focus ring`,
        !/ring-inset/.test(code(rel)),
        'a resting inset ring swallows the keyboard focus indicator');
}

// And the extremes anybody can still TYPE into the value field must survive it.
for (const c of ['#ffffff', '#fff', '#000000', '#fffffe', '#010101']) {
    const s = solid(c);
    ok(`a typed ${c} is corrected to a readable button`,
        contrast(s, WHITE) >= 4.5,
        `becomes rgb(${s.join(' ')}) at ${contrast(s, WHITE).toFixed(2)}:1`);
}
ok('utils/color.ts clamps the starting lightness into the band',
    /Math\.min\(0\.98, Math\.max\(0\.02, l0\)\)/.test(COLOR_SRC),
    'without it a colour that BEGINS at a bound breaks out of the loop unchanged');

// ---------------------------------------------------------------------------
// 3. The value field takes what the sentence beside it promises.
// ---------------------------------------------------------------------------
// Run the shipped parser, rather than trusting the hint: the hint is the
// contract the learner reads.
const ACCEPT = [
    ['#0e7490', '#0e7490'], ['0e7490', '#0e7490'], ['#0E7490', '#0e7490'],
    ['#e74', '#ee7744'], ['e74', '#ee7744'],
    ['rgb(14 116 144)', '#0e7490'], ['rgb(14,116,144)', '#0e7490'], ['rgba(14, 116, 144, 0.5)', '#0e7490'],
    ['hsl(192 82% 31%)', '#0e7690'], ['hsl(192,82%,31%)', '#0e7690'],
    ['  #0e7490  ', '#0e7490'],
];
for (const [input, want] of ACCEPT) {
    const got = parseCssColor(input);
    ok(`the field reads ${JSON.stringify(input)}`, got === want, `got ${got}`);
}
// Null is the contract: a half-typed value must leave the text alone rather than
// snap the field to a guess under the cursor.
for (const input of ['', '   ', '#', '#12', '#12345', 'rebeccapurple', 'rgb(1 2)', 'hsl(a b c)', 'nope', '#gggggg']) {
    ok(`the field keeps ${JSON.stringify(input)} as text rather than guessing`,
        parseCssColor(input) === null, `got ${parseCssColor(input)}`);
}
ok('the hint names exactly the notations the parser takes',
    /Hex, rgb\(\) or hsl\(\)/.test(FIELD_SRC), 'the sentence beside the field is the contract');

// ---------------------------------------------------------------------------
// 4. The dialog previews the result rather than only the chip.
// ---------------------------------------------------------------------------
const FORM_SRC = read('src/components/ProjectFormFields.tsx');
ok('the project dialog previews the painted accent, not just the swatch',
    FORM_SRC.includes('accentSolidTriplet'),
    'all 16 project swatches paint a different colour than the chip — show it');
ok('the project dialog offers the colours the library already holds',
    /library=\{/.test(FORM_SRC) && /inUse=\{/.test(FORM_SRC),
    'an imported colour outside the palette is otherwise unrecoverable');

// ---------------------------------------------------------------------------
const json = process.argv.includes('--json');
if (json) {
    console.log(JSON.stringify({ checked, findings }, null, 2));
} else {
    const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
    console.log(`\n${C.b}Colour choosing${C.x} ${C.d}(one control, and a chip that tells the truth)${C.x}\n`);
    if (!findings.length) {
        console.log(`  ${C.g}${checked} passed, 0 failed${C.x}\n`);
    } else {
        console.log(`  ${checked - findings.length} passed, ${C.r}${findings.length} failed${C.x}\n`);
        for (const f of findings) console.log(`  ${C.r}fail${C.x} ${f.name}\n        ${C.d}${f.detail}${C.x}`);
        console.log('');
    }
}
process.exit(findings.length ? 1 : 0);
