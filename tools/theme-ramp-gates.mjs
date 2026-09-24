#!/usr/bin/env node
// theme-ramp-gates.mjs — a theme is a MODE and a COLOUR, and the twelve surface
// variables are arithmetic now rather than four hand-written blocks of CSS.
//
// That trade is only worth making if the arithmetic is held to what the blocks
// guaranteed, so this suite is in three parts and the order is the argument:
//
//   1. THE UNTINTED APP HAS NO HUE, AND COSTS NOTHING. `slate` is a blue-grey,
//      so an app drawn in it reads blue however white the swatch says it is —
//      but every contrast measurement ever taken in this project was taken
//      against that ladder, so taking the hue out may not move a ratio. Both
//      halves are re-solved here from the luminance formula rather than read
//      off the table that ships.
//   2. THE TWO HAND-MADE THEMES ARE REPRODUCED. `warm` and `black` were made by
//      eye over two years; a generator that cannot land on them is not a
//      generalisation of anything. They are also the only evidence that a tint
//      OTHER than neutral produces a usable app, because they are the only two
//      anybody has read a whole lesson on.
//   3. NOTHING A LEARNER CAN CHOOSE PRODUCES AN UNREADABLE APP. Every shipped
//      tint, in both modes, has to keep body text and muted text over their
//      floors and keep a light theme light. This is the half the old design got
//      for free by having only four answers.
//
//   node tools/theme-ramp-gates.mjs
//   node tools/theme-ramp-gates.mjs --json

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const findings = [];
let checked = 0;
const ok = (name, cond, detail) => { checked++; if (!cond) findings.push({ name, detail }); };

const { themeRamp, themeVars, themeColorFor, readTint, tintSwatch, RUNGS, varName } =
    await import('../src/utils/themeRamp.ts');

// ---------------------------------------------------------------------------
// The arithmetic, imported rather than reimplemented.
// ---------------------------------------------------------------------------
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
    const l1 = lum(hexToRgb(a)), l2 = lum(hexToRgb(b));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
const dist = (a, b) => {
    const x = hexToRgb(a), y = hexToRgb(b);
    return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
};
const lightness = (hex) => {
    const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};
/** Hue in degrees, and `null` for a grey — where "which hue" has no answer. */
const hueOf = (hex) => {
    const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 0.004) return null;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
};
/** The shorter way round the hue circle: 350° and 10° are 20 apart, not 340. */
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ---------------------------------------------------------------------------
// 1. The untinted app, to the byte.
// ---------------------------------------------------------------------------
const STOCK = {
    white: '#ffffff', 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1',
    400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a',
};
const untinted = themeRamp('light', '#ffffff');
ok('the two modes agree on what untinted means',
    RUNGS.every((r) => themeRamp('dark', '#ffffff')[r] === untinted[r]),
    'one ramp serves both ends; a mode may not have its own idea of no colour');
{
    const coloured = RUNGS.filter((r) => {
        const [x, y, z] = hexToRgb(untinted[r]);
        return x !== y || y !== z;
    });
    ok('no tint means NO HUE — every rung is a true grey',
        coloured.length === 0,
        coloured.map((r) => `${r}: ${untinted[r]}`).join(', ')
        + ' — slate is a blue-grey, and the sixteenth chip says no colour');
}
// …and taking the hue out MAY NOT MOVE A RATIO. Solved per rung from the
// luminance formula, so this fails if the table ever drifts from its own claim.
{
    const drifted = RUNGS.filter((r) => Math.abs(lum(hexToRgb(untinted[r])) - lum(hexToRgb(STOCK[r]))) > 0.004);
    ok('…at the luminance the app was contrast-audited against',
        drifted.length === 0,
        drifted.map((r) => `${r}: ${untinted[r]} is ${lum(hexToRgb(untinted[r])).toFixed(4)}, slate was ${lum(hexToRgb(STOCK[r])).toFixed(4)}`).join('; '));
}
// The pairs a reader actually reads text on, against where they have always
// been. This is the assertion that would have caught the obvious wrong fix
// (desaturating the ladder in place, which drops muted text to 4.42:1).
const TEXT_PAIRS = [
    ['light: body on the page', '800', '100'], ['light: body on a card', '800', 'white'],
    ['light: muted on a card', '500', 'white'], ['dark: body on the page', '50', '900'],
    ['dark: body on a card', '50', '800'], ['dark: muted on a card', '400', '800'],
];
for (const [name, fg, bg] of TEXT_PAIRS) {
    const was = contrast(STOCK[fg], STOCK[bg]);
    const now = contrast(untinted[fg], untinted[bg]);
    ok(`${name} is where it was`,
        Math.abs(now - was) <= 0.2,
        `${was.toFixed(2)}:1 → ${now.toFixed(2)}:1`);
}
// A half-applied ramp is worse than none: it would be a page painted in one
// theme and text in another.
for (const junk of [null, undefined, '', 'not a colour', '#xyz', 'rgb(oops)']) {
    const ramp = themeRamp('light', junk);
    ok(`an unreadable tint (${JSON.stringify(junk)}) leaves the ramp alone`,
        RUNGS.every((r) => ramp[r] === untinted[r]),
        'a tint the app cannot read must be no tint, never a guess');
}
// The stylesheet's own copy is the fallback for the instant before any script
// runs. If it still held slate, every load would flash blue and settle grey.
{
    const css = read('src/index.css');
    // A hyphen is literal outside a character class, so the variable name goes
    // into the pattern as it is written.
    const wrong = RUNGS.filter((r) => {
        const m = new RegExp(`${varName(r)}:\\s*([\\d ]+);`).exec(css);
        if (!m) return true;
        return m[1].trim() !== hexToRgb(untinted[r]).join(' ');
    });
    ok('index.css declares the same untinted ramp the generator produces',
        wrong.length === 0,
        wrong.join(', ') + ' — the pre-script fallback would flash a different theme');

    // And the third copy: the canvases read the ramp off the document, but a
    // jsdom harness renders no stylesheet, so `themeSurfaces.ts` carries its
    // own. A stale one there is a test passing against colours nobody ships.
    const surfaces = read('src/utils/themeSurfaces.ts');
    const stale = RUNGS.filter((r) => !surfaces.includes(`'${varName(r)}': '${hexToRgb(untinted[r]).join(' ')}'`));
    ok('themeSurfaces.ts falls back to the same ramp',
        stale.length === 0,
        stale.join(', ') + ' — the atlas harness would measure a ramp the app does not draw');
}

// ---------------------------------------------------------------------------
// 2. The two themes that were made by hand.
// ---------------------------------------------------------------------------
const WARM = {
    white: '#faf6ef', 50: '#f4eee4', 100: '#eee6d9', 200: '#e2d6c3', 300: '#cdbea8',
    400: '#9e8e79', 500: '#786855', 600: '#5c4e3e', 700: '#44392d', 800: '#30271e', 900: '#211a14',
};
const BLACK = { 900: '#000000', 800: '#0d0d10', 700: '#202026', 600: '#303037' };

// The tint the migration uses for `warm` — the value `LEGACY_THEMES` ships, not
// a value chosen here, so the gate is checking what a learner actually gets.
const STORE_SRC = read('src/store.ts');
const legacyTint = (name) =>
    new RegExp(`${name}:\\s*\\{[^}]*tint:\\s*'(#[0-9a-f]{6})'`).exec(STORE_SRC)?.[1] ?? null;

const warmTint = legacyTint('warm');
ok('the migration names a tint for `warm`', !!warmTint, 'LEGACY_THEMES.warm.tint not found in store.ts');
if (warmTint) {
    const ramp = themeRamp('light', warmTint);
    const worst = Math.max(...RUNGS.map((r) => dist(ramp[r], WARM[r])));
    // 8/441 of the RGB cube. Measured at 2.4 when this was written; the headroom
    // is for a rounding change, not for a different cream.
    ok('`warm` is reproduced by its migration tint',
        worst <= 8,
        `worst rung is ${worst.toFixed(1)}/441 away — ` +
        RUNGS.map((r) => `${r} ${ramp[r]}≠${WARM[r]}`).filter((_, i) => dist(themeRamp('light', warmTint)[RUNGS[i]], WARM[RUNGS[i]]) > 8).join(' '));
}

const blackTint = legacyTint('black');
ok('the migration names a tint for `black`', !!blackTint, 'LEGACY_THEMES.black.tint not found in store.ts');
if (blackTint) {
    const ramp = themeRamp('dark', blackTint);
    ok('`black` really is black',
        lightness(ramp['900']) <= 0.01,
        `the canvas is ${ramp['900']}, lightness ${(lightness(ramp['900']) * 100).toFixed(1)}%`);
    // The four rungs that theme overrode, within the same tolerance the flat
    // reproduction gets. Everything above 600 it left alone, and so does this.
    const worst = Math.max(...Object.keys(BLACK).map((r) => dist(ramp[r], BLACK[r])));
    ok('`black`\'s dark surfaces are reproduced',
        worst <= 12,
        `worst of 600…900 is ${worst.toFixed(1)}/441 away`);
    ok('…and a card is still distinguishable from the page it sits on',
        dist(ramp['800'], ramp['900']) >= 8,
        'a black theme whose cards are the page is one flat sheet');
}

// `light` and `dark` migrate to the untinted ramp, which part 1 already pins —
// what is checked here is that the TABLE says so, since the table is what runs.
for (const [name, mode] of [['light', 'light'], ['dark', 'dark']]) {
    const tint = legacyTint(name);
    ok(`\`${name}\` migrates to the untinted app`,
        tint && RUNGS.every((r) => themeRamp(mode, tint)[r] === untinted[r]),
        `tint ${tint} does not reproduce the untinted ramp in ${mode}`);
}

// ---------------------------------------------------------------------------
// 3. Nothing a learner can choose is unreadable.
// ---------------------------------------------------------------------------
// The shipped shortlist, read out of the component rather than restated here:
// a swatch added to that list and not to this gate is exactly the case this is
// for.
const FIELD_SRC = read('src/components/ui/ColorField.tsx');
const TINTS = [...(/export const THEME_TINTS = \[([\s\S]*?)\n\];/.exec(FIELD_SRC)?.[1] ?? '')
    .matchAll(/'(#[0-9a-f]{6})'/g)].map((m) => m[1]);
ok('the tint shortlist is readable from the source', TINTS.length === 16,
    `found ${TINTS.length} swatches, expected 16`);

// Which rung is the page, the card and each kind of text, per mode. The same
// table the previews in Settings use; if they disagree the previews are lying.
const ROLE = {
    light: { canvas: '100', surface: 'white', body: '800', muted: '500' },
    dark: { canvas: '900', surface: '800', body: '50', muted: '400' },
};
// AAA for body text and AA for muted, which is what the untinted app already
// clears — so this is "a tint may not make it worse", not a new standard.
const BODY_MIN = 7, MUTED_MIN = 4.5;

for (const tint of TINTS) {
    for (const mode of ['light', 'dark']) {
        const ramp = themeRamp(mode, tint);
        const r = ROLE[mode];
        const onCanvas = contrast(ramp[r.body], ramp[r.canvas]);
        const onSurface = contrast(ramp[r.body], ramp[r.surface]);
        const mutedOn = contrast(ramp[r.muted], ramp[r.surface]);
        ok(`${mode} · ${tint} · body text is legible on the page and on a card`,
            onCanvas >= BODY_MIN && onSurface >= BODY_MIN,
            `${onCanvas.toFixed(2)}:1 on the canvas, ${onSurface.toFixed(2)}:1 on a card`);
        ok(`${mode} · ${tint} · muted text clears AA on a card`,
            mutedOn >= MUTED_MIN,
            `${mutedOn.toFixed(2)}:1`);
        ok(`${mode} · ${tint} · a card is not the page`,
            dist(ramp[r.surface], ramp[r.canvas]) >= 6,
            'the surface ladder collapsed: canvas and surface are one colour');
    }
}

// THE ANSWER TO "what colour" MAY NOT OVERTURN THE ANSWER TO "light or dark".
// This is what `MAX_DEPTH` exists for, and the reason it is a gate rather than a
// comment is that the tint field takes any value at all — including black.
for (const tint of [...TINTS, '#000000', '#0f172a', '#4c1d95', '#ffffff']) {
    ok(`a light theme stays light with tint ${tint}`,
        lightness(themeRamp('light', tint)['100']) >= 0.78,
        `the canvas came out at ${(lightness(themeRamp('light', tint)['100']) * 100).toFixed(1)}% lightness`);
    ok(`a dark theme stays dark with tint ${tint}`,
        lightness(themeRamp('dark', tint)['900']) <= 0.22,
        `the canvas came out at ${(lightness(themeRamp('dark', tint)['900']) * 100).toFixed(1)}% lightness`);
}

// EVERY HUE IN THE SHORTLIST IS THE SAME STRENGTH. The ramp reads a tint's
// lightness as depth, so a palette taken off Tailwind's 200 rung is not level:
// `amber-200` is l 76.5% and `violet-200` is 92%, which asked for 14 points of
// depth and 6 — two chips that look equally pale, one of which re-colours the
// app and one of which does not. Measured in Edge, 2026-09-21.
const hues = TINTS.filter((t) => readTint(t, 'light').strength > 0);
const depths = hues.map((t) => readTint(t, 'light').depth);
const strengths = hues.map((t) => readTint(t, 'light').strength);
ok('every coloured tint asks for the same depth',
    Math.max(...depths) - Math.min(...depths) <= 0.5,
    `depths run ${Math.min(...depths).toFixed(1)}–${Math.max(...depths).toFixed(1)}`);
ok('…and the same strength',
    Math.max(...strengths) - Math.min(...strengths) <= 0.01,
    `strengths run ${Math.min(...strengths).toFixed(2)}–${Math.max(...strengths).toFixed(2)}`);
ok('the shortlist holds an achromatic pair that asks for no hue',
    TINTS.filter((t) => readTint(t, 'light').strength === 0).length === 2,
    'Ink and Paper are the two ends of the choice and must take no hue');

// THE FLOOR AND THE CEILING ON A TINT'S SATURATION, PINNED FROM BOTH SIDES.
//
// Everything above measures the sixteen SHIPPED swatches, and those are
// fourteen chromatic ones all at saturation 0.606 plus two achromatic ones at
// 0.000 — exactly TWO values of `strength`. `MIN_SATURATION` (0.02) and
// `MAX_SATURATION` (0.55) could therefore be moved anywhere between them with
// the whole suite green, and `ColorField`'s value box takes any hex a learner
// can type: a dusty rose at 14% saturation is in that untested band.
//
// So each constant is pinned by the pair of colours either side of it, and the
// pair at the floor is ONE 8-bit step apart, which is as tight as the sRGB grid
// allows. Read in DARK mode deliberately: `depth` is measured downward from a
// lightness of 0.143 there, so a mid-lightness colour asks for no depth at all
// and the ramp's other input is held still while the saturation moves. Hue 0
// and lightness 0.500 throughout, for the same reason.
{
    const NEUTRAL_RAMP = themeRamp('dark', null);            // part 1 pins this ladder
    const isNeutral = (tint) => RUNGS.every((r) => themeRamp('dark', tint)[r] === NEUTRAL_RAMP[r]);
    const sameRamp = (a, b) => RUNGS.every((r) => themeRamp('dark', a)[r] === themeRamp('dark', b)[r]);

    // The floor: HSL saturation 0.0196 and 0.0236, one unit of red apart.
    const BELOW_FLOOR = '#827d7d', ABOVE_FLOOR = '#837d7d';
    ok('a colour just UNDER the saturation floor asks for no hue at all',
        readTint(BELOW_FLOOR, 'dark').strength === 0,
        `${BELOW_FLOOR} reads strength ${readTint(BELOW_FLOOR, 'dark').strength}`);
    ok('…and is drawn on the untinted ladder, unchanged',
        isNeutral(BELOW_FLOOR),
        'a tint below the floor must be no tint, not a ramp that merely rounds to one');
    ok('a colour just OVER the floor does ask for hue',
        readTint(ABOVE_FLOOR, 'dark').strength > 0,
        `${ABOVE_FLOOR} reads strength ${readTint(ABOVE_FLOOR, 'dark').strength}`);
    ok('…and paints a ramp that is not the untinted one',
        !isNeutral(ABOVE_FLOOR),
        'the floor swallowed a colour a learner deliberately typed');

    // The ceiling: 0.5373 under it, 0.5608 just over, 0.9529 far over.
    const UNDER_CAP = '#c43b3b', OVER_CAP = '#c73838', FAR_OVER_CAP = '#f90606';
    ok('under the ceiling a tint gets its OWN saturation',
        readTint(UNDER_CAP, 'dark').strength < readTint(OVER_CAP, 'dark').strength,
        `${UNDER_CAP} reads ${readTint(UNDER_CAP, 'dark').strength.toFixed(4)}, `
        + `${OVER_CAP} reads ${readTint(OVER_CAP, 'dark').strength.toFixed(4)} — `
        + 'a ceiling below 0.5373 would flatten both to the same app');
    ok('over it, a highlighter and a strong colour are the same tint',
        readTint(OVER_CAP, 'dark').strength === readTint(FAR_OVER_CAP, 'dark').strength,
        `${OVER_CAP} reads ${readTint(OVER_CAP, 'dark').strength.toFixed(4)}, `
        + `${FAR_OVER_CAP} reads ${readTint(FAR_OVER_CAP, 'dark').strength.toFixed(4)} — `
        + 'a ceiling above 0.5608 lets a fully saturated page through');
    ok('…and they paint the same ramp, rung for rung',
        sameRamp(OVER_CAP, FAR_OVER_CAP), 'the clamp reaches `strength` but not the surfaces');
    ok('…while the one under the ceiling paints a different one',
        !sameRamp(UNDER_CAP, OVER_CAP), 'the clamp is binding below its own value');
}

// THE TINT HAS TO REACH THE SURFACES — IN BOTH MODES.
//
// Everything above this point measures a ramp that has ALREADY taken the tint,
// so all of it passed while dark mode was taking no tint at all: `themeRamp`
// returned the untouched ladder whenever the DEPTH came out at zero, and a
// pastel in dark mode always asks for zero depth (the shortlist is HSL 87% and
// the dark datum is 14.3%). Fourteen swatches, one appearance — stock Tailwind
// slate, the exact blue-grey the untinted app was moved off. Readable, level,
// correctly clamped, and not the colour anyone picked.
//
// So the claim is made directly, per mode, on the two rungs a reader actually
// sees: the page carries the tint's own hue, and no two swatches paint the same
// app. `ROLE` above already names which rung is which in each mode.
for (const tint of hues) {
    const wanted = hueOf(tint);
    for (const mode of ['light', 'dark']) {
        const ramp = themeRamp(mode, tint);
        const r = ROLE[mode];
        const page = hueOf(ramp[r.canvas]), card = hueOf(ramp[r.surface]);
        ok(`${mode} · ${tint} · the page carries the tint's own hue`,
            page !== null && hueGap(page, wanted) <= 6,
            page === null
                ? `the ${mode} canvas came out GREY (${ramp[r.canvas]}) — the tint reached nothing`
                : `canvas ${ramp[r.canvas]} is hue ${page.toFixed(0)}°, the tint is ${wanted.toFixed(0)}°`);
        ok(`${mode} · ${tint} · a card carries it too`,
            card !== null && hueGap(card, wanted) <= 6,
            card === null ? `the ${mode} surface came out GREY (${ramp[r.surface]})`
                : `surface ${ramp[r.surface]} is hue ${card.toFixed(0)}°`);
    }
}
for (const mode of ['light', 'dark']) {
    const pages = hues.map((t) => themeRamp(mode, t)[ROLE[mode].canvas]);
    ok(`${mode} · the fourteen hues paint fourteen different apps`,
        new Set(pages).size === hues.length,
        `${new Set(pages).size} distinct canvases from ${hues.length} swatches: ${[...new Set(pages)].join(' ')}`);
}

// The depth check above reads `light` only because that is the mode the levelling
// bug was found in. The dark datum is a different number, so it gets its own run:
// a pastel may legitimately ask for NO depth there — what it may not do is ask
// for DIFFERENT amounts from one swatch to the next.
const darkDepths = hues.map((t) => readTint(t, 'dark').depth);
ok('every coloured tint asks for the same depth in dark mode too',
    Math.max(...darkDepths) - Math.min(...darkDepths) <= 0.5,
    `depths run ${Math.min(...darkDepths).toFixed(1)}–${Math.max(...darkDepths).toFixed(1)}`);

// ---------------------------------------------------------------------------
// 4. What is written to the document, and what reads it before there is one.
// ---------------------------------------------------------------------------
const vars = themeVars('dark', '#caf2ee');
ok('themeVars writes one variable per rung and nothing else',
    Object.keys(vars).length === RUNGS.length
    && RUNGS.every((r) => typeof vars[varName(r)] === 'string'),
    `wrote ${Object.keys(vars).join(' ')}`);
ok('…as space-separated RGB triplets, which is what Tailwind\'s config expects',
    Object.values(vars).every((v) => /^\d{1,3} \d{1,3} \d{1,3}$/.test(v)),
    Object.entries(vars).filter(([, v]) => !/^\d{1,3} \d{1,3} \d{1,3}$/.test(v)).join(', '));

// The browser chrome above the app is the HEADER's colour, not the canvas and
// not the accent. A table of hexes per theme is the exact shape a tint
// invalidates, which is why this asserts the RUNG rather than a value.
for (const [mode, rung] of [['light', 'white'], ['dark', '800']]) {
    const tint = '#f2cade';
    ok(`the phone's status bar matches the ${mode} header`,
        themeColorFor(mode, tint) === themeRamp(mode, tint)[rung],
        `theme-color is ${themeColorFor(mode, tint)}, the header is ${themeRamp(mode, tint)[rung]}`);
}

// THE BOOT SCRIPT CANNOT CALL ANY OF THIS. It runs before a module is parsed,
// so the store caches the computed values for it; a cache the script does not
// read is a first paint in the wrong colours and a re-paint a frame later.
const INDEX_HTML = read('index.html');
ok('the boot script applies the cached surface variables',
    /themeVars/.test(INDEX_HTML) && /setProperty/.test(INDEX_HTML),
    'index.html must replay the cached ramp before the first paint');
ok('the store caches them for it',
    /themeVars\??:\s*Record<string, string>/.test(STORE_SRC) && /patchThemeCache\(\{[^}]*themeVars/.test(STORE_SRC),
    'nothing writes `themeVars` into the theme cache');
ok('the boot script no longer knows any theme NAMES',
    !/'warm'|"warm"|'black'|"black"/.test(INDEX_HTML),
    'a table of theme names in the boot script is the thing a tint invalidates');

// And the stylesheet holds the untinted ramp and nothing else: a `[data-theme]`
// block would win or lose against the inline style depending on specificity,
// which is not a thing to leave to chance.
const CSS = read('src/index.css');
ok('index.css declares no per-theme override blocks',
    !/\[data-theme="(warm|black)"\]/.test(CSS),
    'the four named themes are generated now, not declared');

// ---------------------------------------------------------------------------
// 5. The colours an INSTALLED app paints before any of this has run.
//
// The splash behind the icon is the app's own page and the strip above it its
// header — not the icon's tile, and not a colour written into the static
// manifest, either of which is a field the app never paints. The server cannot
// compute them (no `src/` in the container), so the client writes the pair it painted
// and `manifestColors` uses it only while the mode and tint it was computed
// for still match — which is the whole reason it cannot answer with a colour
// the app would not paint. Every claim below is re-run against a row that has
// gone stale in each of the ways it can.
// ---------------------------------------------------------------------------
const { manifestColors, manifestFor, DEFAULT_SURFACES } = await import('../server/appIcon.js');

// The two literals over there are the untinted page and header, and this is
// what keeps them that: a ramp change moves them and leaves the fallback behind.
for (const mode of ['light', 'dark']) {
    const page = themeRamp(mode, null)[mode === 'dark' ? '900' : '100'];
    ok(`the ${mode} fallback splash is the untinted page`,
        DEFAULT_SURFACES[mode].background === page,
        `manifest says ${DEFAULT_SURFACES[mode].background}, the ramp says ${page}`);
    ok(`the ${mode} fallback strip is the untinted header`,
        DEFAULT_SURFACES[mode].theme === themeColorFor(mode, null),
        `manifest says ${DEFAULT_SURFACES[mode].theme}, the ramp says ${themeColorFor(mode, null)}`);
}

// What the client writes, written the way the client writes it.
const painted = (mode, tint) => JSON.stringify({
    mode, tint,
    background: themeRamp(mode, tint)[mode === 'dark' ? '900' : '100'],
    theme: themeColorFor(mode, tint),
});

for (const [mode, tint] of [['dark', '#f2cad1'], ['light', '#caf2d9'], ['dark', '#000000']]) {
    const colors = manifestColors({ mode, tint, painted: painted(mode, tint) });
    ok(`an installed ${mode} app on ${tint} starts on the page it will draw`,
        colors.background === themeRamp(mode, tint)[mode === 'dark' ? '900' : '100'],
        `splash ${colors.background}, page ${themeRamp(mode, tint)[mode === 'dark' ? '900' : '100']}`);
    ok(`…under the strip it will draw (${mode} ${tint})`,
        colors.theme === themeColorFor(mode, tint),
        `strip ${colors.theme}, header ${themeColorFor(mode, tint)}`);
}

// THE PRE-FIX SHAPE: the tile is black, the app is rose. A manifest that hands
// the platform the tile paints the mark onto a field the app never shows.
const TILE = '#000000';
const rose = manifestFor({ style: 'full', background: TILE, radius: 0.4 },
    manifestColors({ mode: 'dark', tint: '#f2cad1', painted: painted('dark', '#f2cad1') }),
    { name: 'Terramentor' });
ok('the splash is not the icon tile',
    rose.background_color !== TILE && rose.background_color === themeRamp('dark', '#f2cad1')['900'],
    `background_color is ${rose.background_color}`);
ok('the static file\'s hardcoded theme_color does not survive',
    manifestFor({ style: 'full', background: TILE, radius: 0.4 },
        manifestColors({ mode: 'dark', tint: '#f2cad1', painted: painted('dark', '#f2cad1') }),
        { theme_color: '#ffffff' }).theme_color === themeColorFor('dark', '#f2cad1'),
    'the spread of the static manifest must not win over the generated pair');

// A ROW THAT NO LONGER DESCRIBES THE THEME IS NOT USED. Four ways to be stale,
// and all four have to land on a colour the app does paint.
const stale = [
    ['the mode has changed since', { mode: 'light', tint: '#f2cad1', painted: painted('dark', '#f2cad1') }, 'light'],
    ['the tint has changed since', { mode: 'dark', tint: '#caf2d9', painted: painted('dark', '#f2cad1') }, 'dark'],
    ['the row is half-written', { mode: 'dark', tint: '#f2cad1', painted: '{"mode":"dark"' }, 'dark'],
    ['the library has never been opened', { mode: 'dark', tint: '#f2cad1' }, 'dark'],
];
for (const [why, stored, mode] of stale) {
    const colors = manifestColors(stored);
    ok(`the splash falls back to the untinted page when ${why}`,
        colors.background === DEFAULT_SURFACES[mode].background && colors.theme === DEFAULT_SURFACES[mode].theme,
        `answered ${JSON.stringify(colors)}`);
}

// A LIBRARY STILL ON A NAMED THEME. Nothing rewrites `theme` on upgrade, so a
// row can still say `black` or `warm`; the client reads those as a mode and a
// tint and writes its painted row under THAT pair. The server has to read them
// the same way, or it matches nothing the client wrote — pre-fix, `black` was
// read as "not dark, so light" and an installed Black app got a white splash.
for (const [legacy, mode, tint] of [['black', 'dark', '#000000'], ['warm', 'light', '#f0e1d0']]) {
    const colors = manifestColors({ mode: legacy, tint: null, painted: painted(mode, tint) });
    ok(`a library still on "${legacy}" starts on the page it paints`,
        colors.background === themeRamp(mode, tint)[mode === 'dark' ? '900' : '100']
        && colors.theme === themeColorFor(mode, tint),
        `answered ${JSON.stringify(colors)}`);
}
ok('…and "black" with nothing painted yet falls back to a DARK page',
    manifestColors({ mode: 'black' }).background === DEFAULT_SURFACES.dark.background,
    `answered ${JSON.stringify(manifestColors({ mode: 'black' }))}`);

// And the client's half: one writer, tagged, and seeded from the settings load
// so opening the app writes nothing.
ok('the client writes the pair it just painted',
    /rememberPaintedSurfaces\(theme, tint, surface\)/.test(STORE_SRC)
    && /setSetting\('theme_surfaces'/.test(STORE_SRC),
    'nothing in the store sends the painted surfaces to the server');
ok('…tagged with the mode and tint it was computed for',
    /JSON\.stringify\(\{ mode: theme, tint, background: page, theme: header \}\)/.test(STORE_SRC),
    'an untagged row is one the server cannot tell is stale');
ok('…and seeded from the settings load, so a plain open writes nothing',
    /seedPaintedSurfaces\(settings\.theme_surfaces\)/.test(STORE_SRC),
    'without the seed every page load writes a settings row');

// ---------------------------------------------------------------------------
// 6. The palette a tint is CHOSEN from, in the mode it is being chosen in.
//
// A chip is dressed for the mode it is being chosen in: the stored pastel in
// light, that tint's panel rung in dark. The rung is the whole decision and it
// is measured, not felt — the PAGE rung is the one that sounds honest and it
// puts Rose 5 units from Red.
// ---------------------------------------------------------------------------
const SETTINGS_SRC = read('src/components/Settings.tsx');

/** The closest any two of a set of colours come. */
const apart = (colors) => {
    let min = Infinity;
    colors.forEach((a, i) => colors.forEach((b, j) => { if (i !== j) min = Math.min(min, dist(a, b)); }));
    return min;
};
const lightApart = apart(TINTS);
const darkPages = TINTS.map((t) => themeRamp('dark', t)['900']);
const darkChips = TINTS.map((t) => themeRamp('dark', t)['700']);
ok('the dark chips are at least as far apart as the light ones',
    apart(darkChips) >= lightApart,
    `dark ${apart(darkChips).toFixed(1)}, light ${lightApart.toFixed(1)}`);
ok('…which the PAGE colours are not — the reason the chip is not the page',
    apart(darkPages) < lightApart,
    `pages ${apart(darkPages).toFixed(1)} apart, the pastels ${lightApart.toFixed(1)}`);
// A chip sits on the card, which is the CURRENT tint's 800. Same-hue chip
// against same-hue card is the worst case, and it has to stay a visible object.
for (const tint of TINTS) {
    const [chip, card] = [themeRamp('dark', tint)['700'], themeRamp('dark', tint)['800']];
    ok(`the ${tint} chip is visible on its own card`, dist(chip, card) >= 20, `chip ${chip} on card ${card}`);
}

ok('a chip is painted by the swatch function, never by the raw value',
    !/style=\{\{ backgroundColor: color \}\}/.test(FIELD_SRC)
    && (FIELD_SRC.match(/backgroundColor: swatch\(/g) || []).length === 3,
    'ColorField paints the grid, the library row and the eyedropper through one function');
ok('…and the value the field, the picker and the labels carry is still the stored one',
    /value=\{swatchValue\}/.test(FIELD_SRC) && !/value=\{swatch\(/.test(FIELD_SRC),
    'the paint may move; the colour being chosen may not');
ok('the tint palette is the one that supplies a swatch',
    /swatch=\{pageOf\}/.test(SETTINGS_SRC)
    && /tintSwatch\(theme, hex\)/.test(SETTINGS_SRC),
    'the chip is painted by tintSwatch, for the mode it is chosen in');
// The function itself: a hued pastel is its own light chip, every dark chip is
// the 700 rung — and the hue-less pair, whose stored value is the DEPTH end and
// not a pastel, are painted at the light panel rung in light mode. Painted raw,
// Ink was a true-black chip for a page that comes out light grey.
for (const tint of TINTS) {
    ok(`dark chip for ${tint} is the 700 rung`, tintSwatch('dark', tint) === themeRamp('dark', tint)['700']);
    const hued = readTint(tint, 'light').strength > 0;
    ok(`light chip for ${tint} is ${hued ? 'the pastel itself' : 'the light panel rung'}`,
        tintSwatch('light', tint) === (hued ? tint : themeRamp('light', tint)['100']),
        `got ${tintSwatch('light', tint)}`);
}
const [inkChip, paperChip] = [tintSwatch('light', '#000000'), tintSwatch('light', '#ffffff')];
ok('Ink and Paper stay two chips in light mode', dist(inkChip, paperChip) >= 20, `${inkChip} vs ${paperChip}`);
ok('…and Ink is a LIGHT grey there, since that is the page it makes',
    dist(inkChip, '#ffffff') < 80 && dist(inkChip, '#000000') > 300, inkChip);

// ---------------------------------------------------------------------------
// 4. The ACCENT is read on the page the tint made, not on the one it used to.
// ---------------------------------------------------------------------------
// `--accent-fg-rgb` is the accent as TEXT: every link, every badge label, the
// `Sources:` line under a chat answer. Solving it against two constants —
// stock white and stock slate-800 — is the whole truth only for an app with one
// light surface and one dark one. A theme here is a mode and a TINT, so those
// constants name a page almost nobody is on, and an accent that clears AA on
// slate-800 is measured against nothing at all on a cream page or a true-black
// one. Five screenshots of one chat answer's sources line, 2026-09-22:
// comfortable on some tints, near-invisible on others.
//
// Three surfaces per combination, because one colour paints all three: the bare
// card/panel, and the same text inside an `accent/10` and an `accent/25` badge.
// The badge is not a detail — before this, 222 of 256 light-mode combinations
// put a badge label under 4.5:1 (worst 3.19:1), because only the dark branch
// had ever been given that check.
const { accentFgTriplet, accentSolidTriplet } = await import('../src/utils/color.ts');
const swatchesOf = (name) => [...(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(FIELD_SRC)?.[1] ?? '')
    .matchAll(/'(#[0-9a-f]{6})'/gi)].map((m) => m[1].toLowerCase());
const APP_ACCENTS = swatchesOf('ACCENT_COLORS');
ok('the accent shortlist is readable from the source', APP_ACCENTS.length === 16,
    `found ${APP_ACCENTS.length} swatches, expected 16`);
// A PROJECT's colour is an accent too — every card, feed card and chip sets
// `--accent-fg-rgb` from it — and it is the palette with the light, vivid
// colours (amber, lime, cyan) that the accent shortlist deliberately avoids.
// Measuring the shortlist alone passed while 66 of 512 project badges did not.
const PROJECT_ACCENTS = swatchesOf('PROJECT_COLORS');
ok('the project palette is readable from the source', PROJECT_ACCENTS.length >= 16,
    `found ${PROJECT_ACCENTS.length} swatches`);
const ACCENTS = [...new Set([...APP_ACCENTS, ...PROJECT_ACCENTS])];

const toHex = (triplet) => '#' + triplet.split(' ').map((n) => Number(n).toString(16).padStart(2, '0')).join('');
const over = (fg, bg, alpha) => {
    const [f, b] = [hexToRgb(fg), hexToRgb(bg)];
    return '#' + f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
};
// THE MODULE ITSELF, not a copy of its last line. A local mirror of
// `accentTextSurface` — `(mode, tint) => themeColorFor(mode, tint)`, written
// out here and kept in step by hand — leaves `accentVars.ts` unexecuted, with
// nothing reaching it but a source scan for the text
// `accentTextSurface(mode, tint)`, which matches the CALL SITE: a body changed
// to ignore the tint keeps that regex matching and clears the whole suite
// (measured 2026-09-23 on exactly that mutation, 0 failures before this
// import, 266 after). So it is imported and run.
const { accentVars, accentTextSurface } = await import('../src/utils/accentVars.ts');

/** THE GROUND TRUTH: the surface accent text is painted on — the card in light
 *  mode, the panel in dark, both the lightest surface of their mode, which is
 *  the worst case for the direction that mode drives the colour in. Read
 *  straight off the ramp and deliberately NOT through `accentTextSurface`,
 *  which is the thing under test: a measurement that asks the module under test
 *  where the page is moves both sides of its own assertion at once, and a body
 *  that ignored the tint would go on passing. */
const pageUnderAccentText = (mode, tint) => themeRamp(mode, tint)[mode === 'dark' ? '800' : 'white'];

// …and the module has to agree with it, per tint and per mode. This is the
// claim the source scan was standing in for, made directly.
for (const tint of TINTS) {
    for (const mode of ['light', 'dark']) {
        ok(`${mode} · tint ${tint} · accentTextSurface names the page accent text lands on`,
            accentTextSurface(mode, tint) === pageUnderAccentText(mode, tint),
            `the module says ${accentTextSurface(mode, tint)}, the ramp says ${pageUnderAccentText(mode, tint)}`);
    }
}

/** What `bg-accent/N` really paints with: `--accent-rgb`, the SOLID — darkened
 *  until a white label clears AA — never the colour as chosen. */
const solidOf = (accent) => toHex(accentSolidTriplet(accent));

/**
 * Every combination's worst ratio for one derivation of `--accent-fg-rgb`.
 *
 * `fgOf(accent, mode, tint, surface)` — the surface is handed over for the
 * controls below, which reconstruct an older signature; the real derivation
 * takes the theme and resolves the page itself, which is the whole point.
 */
const accentMatrix = (fgOf) => {
    const rows = [];
    for (const tint of TINTS) {
        for (const mode of ['light', 'dark']) {
            const surface = pageUnderAccentText(mode, tint);
            for (const accent of ACCENTS) {
                const fg = toHex(String(fgOf(accent, mode, tint, surface)));
                const solid = solidOf(accent);
                rows.push({
                    tint, mode, accent, seen: [
                        ['on the card', contrast(fg, surface)],
                        ['in an accent/10 badge', contrast(fg, over(solid, surface, 0.10))],
                        ['in an accent/25 badge', contrast(fg, over(solid, surface, 0.25))],
                    ],
                });
            }
        }
    }
    return rows;
};

/** The real thing: `accentVars` composing the accent, the mode and the TINT —
 *  the one function the seven surfaces that set these variables go through. */
const throughTheModule = (accent, mode, tint) => accentVars(accent, mode, tint)['--accent-fg-rgb'];

let accentWorst = [99, ''];
for (const { tint, mode, accent, seen } of accentMatrix(throughTheModule)) {
    for (const [where, ratio] of seen) {
        if (ratio < accentWorst[0]) accentWorst = [ratio, `${mode} · tint ${tint} · accent ${accent} · ${where}`];
    }
    const worst = Math.min(...seen.map(([, r]) => r));
    ok(`${mode} · tint ${tint} · accent ${accent} · accent text clears AA everywhere it is painted`,
        worst >= MUTED_MIN,
        seen.map(([where, r]) => `${r.toFixed(2)}:1 ${where}`).join(', '));
}
ok('…and the worst combination in the whole matrix is still readable',
    accentWorst[0] >= MUTED_MIN, `${accentWorst[0].toFixed(2)}:1 — ${accentWorst[1]}`);

// THE OTHER PRE-FIX SHAPE: the badge solved against the colour AS CHOSEN rather
// than the solid it is painted with. Rebuilt from this file's own source with
// the one line swapped back, and run through the same matrix — it has to fail
// on the project palette, or the matrix is not measuring the badge.
{
    const { tmpdir } = await import('node:os');
    const { pathToFileURL } = await import('node:url');
    const colorSrc = read('src/utils/color.ts');
    const FIXED = /const solid = adjustForContrast\(rgb, WHITE, 4\.5, -1\);\r?\n(\s*)const checks = \[\{ bg: blend\(solid, bg/;
    ok('the badge is solved against the solid accent', FIXED.test(colorSrc),
        'accentFgTriplet no longer blends the solid into its badge check');
    if (FIXED.test(colorSrc)) {
        const prePath = path.join(tmpdir(), `terramentor-color-prefix-${process.pid}.ts`);
        writeFileSync(prePath, colorSrc.replace(FIXED, '$1const checks = [{ bg: blend(rgb, bg'));
        const pre = await import(pathToFileURL(prePath).href);
        const broken = accentMatrix((accent, mode, tint, surface) =>
            pre.accentFgTriplet(accent, mode === 'dark', surface))
            .filter(({ seen }) => Math.min(...seen.map(([, r]) => r)) < MUTED_MIN).length;
        ok('solving the badge against the raw colour leaves unreadable project badges',
            broken > 0, 'the pre-fix shape passed — the matrix is not measuring the painted badge');
        rmSync(prePath, { force: true });
    }
}

// THE PRE-FIX SHAPE, run through the same measurement: solving against the mode
// alone is what this section exists to stop, so it has to FAIL here. Without
// this the whole matrix above passes again the day someone drops the argument.
{
    let broken = 0;
    for (const tint of TINTS) {
        for (const mode of ['light', 'dark']) {
            const surface = pageUnderAccentText(mode, tint);
            for (const accent of ACCENTS) {
                // No surface passed — the old signature, measured against the
                // page the reader is actually on.
                const fg = toHex(accentFgTriplet(accent, mode === 'dark'));
                if (contrast(fg, surface) < MUTED_MIN) broken++;
            }
        }
    }
    ok('solving the accent against the MODE alone leaves unreadable combinations',
        broken > 0, 'the pre-fix shape passed — this gate is measuring nothing');
}

// …AND ITS TWIN, one level up: the argument arriving and being DROPPED at the
// composition site. `accentVars` is the only place the tint is handed to the
// solver, so a call there that passes `null` — or a body of
// `accentTextSurface` that ignores what it was given — puts every reader back
// on stock white and stock slate-800 with no signature change to notice. The
// matrix above runs through the real module, so this has to fail, or the
// module is being run and measured against nothing.
{
    const broken = accentMatrix((accent, mode) => accentVars(accent, mode, null)['--accent-fg-rgb'])
        .filter(({ seen }) => Math.min(...seen.map(([, r]) => r)) < MUTED_MIN).length;
    ok('dropping the TINT at the composition site leaves unreadable combinations',
        broken > 0,
        'accentVars solved against no tint and every combination still cleared AA — '
        + 'the matrix is not reading the page the tint made');
}

// AN ACHROMATIC ACCENT STAYS ACHROMATIC. The saturation floor on the dark branch
// lifts a dull colour into a readable one; `Math.max(s0, floor)` made it invent a
// hue instead, and HSL's hue for a grey is 0 — so white, black and every grey in
// between came back RED on a dark theme (reported 2026-09-22 for the first and
// last swatch of the palette).
// A TRUE grey each one: `slate-200` reads as a grey and is not one (215°, HSL
// saturation 0.32), so it belongs in the muted case below, not here.
for (const grey of ['#ffffff', '#000000', '#808080', '#3a3a3a']) {
    for (const mode of ['light', 'dark']) {
        const fg = toHex(accentFgTriplet(grey, mode === 'dark', pageUnderAccentText(mode, '#ffffff')));
        ok(`${mode} · a grey accent (${grey}) stays grey`, hueOf(fg) === null,
            `came back ${fg}, hue ${hueOf(fg)?.toFixed(0)}°`);
    }
}
// …and a colour that genuinely HAS a hue still gets the floor's lift, or the fix
// above would have been "delete the floor".
{
    const dull = '#4a5a6a'; // a muted slate-blue, HSL saturation ~0.18
    const fg = toHex(accentFgTriplet(dull, true, pageUnderAccentText('dark', '#ffffff')));
    const [h0, h1] = [hueOf(dull), hueOf(fg)];
    ok('a muted colour keeps its hue and is still lifted',
        h1 !== null && Math.abs(h1 - h0) < 8 && lightness(fg) > lightness(dull),
        `${dull} (${h0?.toFixed(0)}°, l ${lightness(dull).toFixed(2)}) → ${fg} (${h1?.toFixed(0)}°, l ${lightness(fg).toFixed(2)})`);
}

// ONE DERIVATION, NOT SEVEN. Seven surfaces set this pair of variables by hand
// and each resolved the surface itself; a call site that forgets is a screen
// whose links are measured against a page nobody is on.
const ACCENT_VARS_SRC = read('src/utils/accentVars.ts');
ok('the accent variables are derived in one module',
    /export function accentVars/.test(ACCENT_VARS_SRC)
    && /accentTextSurface\(mode, tint\)/.test(ACCENT_VARS_SRC),
    'accentVars.ts must resolve the surface from the theme, not take it on trust');
for (const rel of [
    'src/components/Layout.tsx', 'src/components/ProjectCard.tsx', 'src/components/TaskDock.tsx',
    'src/components/feed/FeedCardShell.tsx', 'src/components/feed/ChapterGroup.tsx',
    'src/components/completion/CompletionSummary.tsx',
]) {
    ok(`${rel} sets the accent through the shared hook`,
        !/accentFgTriplet\(/.test(read(rel)),
        'a hand-written --accent-fg-rgb here cannot see the tint');
}

// The variable only matters if the TEXT reads it. `.prose a` applied
// `text-accent` — the solid, darkened for white labels — and as element+class
// it outranks the `text-accent-fg` class Markdown puts on the link, so every
// link in an answer painted the solid on every tint, the whole matrix above
// notwithstanding (2026-09-23: #1d4ed8 on a #411818 panel, 2.0:1). A stylesheet
// rule that colours text with the accent must name the text variable.
const solidTextRules = (css) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) => /@apply[^;]*(?<![\w-])text-accent(?![\w-])/.test(body)
        || /(?<![\w-])color:\s*rgb\(var\(--accent-rgb\)/.test(body))
    .map(([, sel]) => sel.trim().split('\n').pop().trim());
const INDEX_CSS = read('src/index.css');
ok('no stylesheet rule paints TEXT with the solid accent',
    solidTextRules(INDEX_CSS).length === 0,
    `solid accent as text colour in: ${solidTextRules(INDEX_CSS).join(', ')}`);
// Control: the rule as it shipped must be caught, or the scan measures nothing.
ok('the text-colour scan catches the pre-fix `.prose a` rule',
    solidTextRules('.prose a {\n  @apply text-accent hover:underline;\n}').length === 1
    && solidTextRules('.prose a {\n  @apply text-accent-fg hover:underline;\n}').length === 0
    && solidTextRules('.x { scrollbar-color: rgb(var(--accent-rgb) / 0.2) transparent; }').length === 0,
    'solidTextRules() no longer tells text-accent from text-accent-fg');

// ---------------------------------------------------------------------------
const json = process.argv.includes('--json');
if (json) {
    console.log(JSON.stringify({ checked, findings }, null, 2));
} else {
    const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
    console.log(`\n${C.b}The theme ramp${C.x} ${C.d}(a mode and a colour, and nothing unreadable between them)${C.x}\n`);
    if (!findings.length) {
        console.log(`  ${C.g}${checked} passed, 0 failed${C.x}\n`);
    } else {
        console.log(`  ${checked - findings.length} passed, ${C.r}${findings.length} failed${C.x}\n`);
        for (const f of findings) console.log(`  ${C.r}fail${C.x} ${f.name}\n        ${C.d}${f.detail}${C.x}`);
        console.log('');
    }
}
process.exit(findings.length ? 1 : 0);
