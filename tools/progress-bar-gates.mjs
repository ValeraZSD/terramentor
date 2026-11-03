#!/usr/bin/env node
// progress-bar-gates.mjs — a bar's empty part is visible on every surface.
//
// About twenty thin bars each picked their own track: slate-100, 200 or 300,
// 4 to 12px tall. In light theme the chapter-end card's slate-100 track on its
// accent/5 tint measured 1.03:1 against the card, so a 0% mastery bar drew
// nothing at all (3 Nov 2026). This gate holds two things:
//
//   1. SHAPE. No component outside `src/components/ui/ProgressBar.tsx` draws
//      its own track (a thin rounded box with a grey fill and its overflow
//      clipped) or its own fill (an `h-full` box whose width is a percentage).
//      A chart that only looks like a bar (a calibration row, a replay
//      timeline) draws its track with `PROGRESS_TRACK`, so it is visible too.
//   2. CONTRAST, measured, composited, WCAG 1.4.11 (3:1 for a graphic):
//      - the track's outline against every SURFACE a bar sits on;
//      - every fill tone against the same surfaces;
//      - every fill against the empty track beside it;
//      in light and dark, under each of the 16 theme tints, and for the accent
//      fill under each of the 16 project colours plus the default. The same
//      arithmetic is run first on the OLD chapter-end track, which must fail.
//
//   node tools/progress-bar-gates.mjs              # human report
//   node tools/progress-bar-gates.mjs --worst      # the tightest pair per check
//   node tools/progress-bar-gates.mjs --root DIR   # another checkout (the pre-fix tree)

import { readFileSync, existsSync, globSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : HERE;
const COMPONENT = 'src/components/ui/ProgressBar.tsx';

const findings = [];
let checked = 0;
const ok = (name, cond, detail) => { checked++; if (!cond) findings.push({ name, detail }); return cond; };

// ---------------------------------------------------------------------------
// 1. Shape: nobody draws a track or a fill by hand.
// ---------------------------------------------------------------------------

const THIN = /\bh-(?:0\.5|1|1\.5|2|2\.5|3|4)\b/;
const GREY = /\bbg-(?:slate|gray|zinc|neutral|stone|white)(?:-\d+)?(?:\/\d+)?\b/;
const isHandTrack = (cls) => THIN.test(cls) && /(?:^|[\s"'`])rounded(?:-full|-sm)?(?=[\s"'`,)]|$)/.test(cls)
    && GREY.test(cls) && /\boverflow-hidden\b/.test(cls);
const isHandFill = (cls, style) => /\bh-full\b/.test(cls) && /width:\s*`[^`]*%`/.test(style);

/** Finds hand-made tracks and fills in one file's text; returns [{line, what}].
 *  A class list is read from `className=` to the end of its tag, so a list
 *  split over lines or built with `cx(...)` is read whole. */
function scan(text) {
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const at = lines[i].indexOf('className=');
        if (at < 0) continue;
        const rest = [lines[i].slice(at), ...lines.slice(i + 1, i + 6)].join(' ');
        // A plain string ends at its quote; an expression at the tag's end.
        const cls = rest.startsWith('className="')
            ? rest.slice(11, rest.indexOf('"', 11))
            : rest.split(/\}\s*\/?>/)[0];
        const style = lines.slice(i, i + 4).join(' ');
        const inTrack = lines.slice(Math.max(0, i - 12), i + 1).some((l) => /<ProgressTrack\b/.test(l));
        if (isHandTrack(cls)) out.push({ line: i + 1, what: 'track' });
        else if (isHandFill(cls, style) && !inTrack) out.push({ line: i + 1, what: 'fill' });
    }
    return out;
}

// The scanner, proved on fixtures before it reads the app.
ok('fixture: a hand-made track is caught',
    scan('<div className="h-2 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">').length === 1);
ok('fixture: a track split over lines is caught',
    scan('<div className={cx(\n "h-2 rounded-full",\n "bg-zinc-200 overflow-hidden")}>').length === 1);
ok('fixture: a hand-made fill is caught',
    scan('<div className="h-full bg-accent" style={{ width: `${p}%` }} />').length === 1);
ok('fixture: a chart drawn on PROGRESS_TRACK is let through',
    scan('<div className={`relative h-2 rounded-full overflow-hidden ${PROGRESS_TRACK}`}>').length === 0);
ok('fixture: a fill inside ProgressTrack is let through',
    scan('<ProgressTrack size="lg">\n<div className={`h-full ${c}`} style={{ width: `${w}%` }} />').length === 0);
ok('fixture: a dot is not a track',
    scan('<span className="w-2 h-2 rounded-full bg-slate-300" />').length === 0);

const files = globSync('src/**/*.tsx', { cwd: ROOT }).map((f) => f.split(path.sep).join('/')).filter((f) => f !== COMPONENT);
for (const file of files) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    const hits = scan(text);
    checked++;
    for (const h of hits) findings.push({ name: `hand-made ${h.what}`, detail: `${file}:${h.line} → use ui/ProgressBar (or ProgressTrack for a split bar)` });
}

// ---------------------------------------------------------------------------
// 2. Contrast, measured against the real composited surfaces.
// ---------------------------------------------------------------------------

/** Every surface a bar sits on, as layers from the bottom up. `accent/N` is the
 *  project's solid accent at N%. Light first, then dark. */
const SURFACES = {
    light: {
        'page (slate-100)': ['100'],
        'card (white)': ['white'],
        'panel (slate-50: bulk, pace, schedule)': ['white', '50'],
        'accent card on a card (chapter end)': ['white', 'accent/5'],
        'accent card on the page': ['100', 'accent/5'],
        'accent/10 on a card': ['white', 'accent/10'],
    },
    dark: {
        'page (slate-900)': ['900'],
        'card (slate-800)': ['800'],
        'panel (slate-900/40 on a card)': ['800', '900/40'],
        'panel (slate-700/50 on a card: pace)': ['800', '700/50'],
        'accent card on the page': ['900', 'accent/5'],
        'accent card on a card': ['800', 'accent/5'],
        'accent/10 on a card': ['800', 'accent/10'],
    },
};

const TAILWIND = {
    'emerald-400': '#34d399', 'emerald-700': '#047857', 'amber-400': '#fbbf24', 'amber-800': '#92400e',
    'red-300': '#fca5a5', 'red-700': '#b91c1c', 'blue-400': '#60a5fa', 'blue-700': '#1d4ed8',
};

// The arithmetic, imported rather than reimplemented.
const { relLum } = await import(pathToFileURL(path.join(HERE, 'src/utils/color.ts')).href);
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ratio = (a, b) => { const x = relLum(a), y = relLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (top, alpha, base) => top.map((c, i) => c * alpha + base[i] * (1 - alpha));
const triplet = (s) => s.trim().split(/\s+/).map(Number);
const TONES = ['accent', 'success', 'warning', 'danger', 'info', 'neutral'];

// The negative control: the OLD chapter-end track (slate-100 on an accent/5
// card over white, default theme and accent) run through the same arithmetic
// must fail, or a bug that returns a high ratio would pass everything below.
{
    const { themeRamp } = await import(pathToFileURL(path.join(HERE, 'src/utils/themeRamp.ts')).href);
    const ramp = themeRamp('light', '#ffffff');
    const card = over([14, 116, 144], 0.05, hexRgb(ramp.white));
    const old = ratio(hexRgb(ramp['100']), card);
    ok('control: the old chapter-end track measures under 3:1 on its card', old < 3, old.toFixed(2));
    ok('control: black on white measures 21:1', Math.abs(ratio([0, 0, 0], [255, 255, 255]) - 21) < 0.01);
}

if (!existsSync(path.join(ROOT, COMPONENT))) {
    findings.push({ name: 'no shared bar', detail: `${COMPONENT} does not exist: every bar draws its own track` });
} else {
    const src = readFileSync(path.join(ROOT, COMPONENT), 'utf8');
    // Read as text: Node strips types but does not compile JSX.
    const half = (name) => src.match(new RegExp(`export const ${name} = '([^']+)'`))?.[1];
    const washClasses = half('PROGRESS_TRACK_WASH'), ringClasses = half('PROGRESS_TRACK_RING');
    const PROGRESS_TRACK = washClasses && ringClasses ? `${washClasses} ${ringClasses}` : undefined;
    const fillBody = src.match(/export const PROGRESS_FILL[^=]*= \{([\s\S]*?)\};/)?.[1] ?? '';
    const PROGRESS_FILL = Object.fromEntries([...fillBody.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
    const { themeRamp } = await import(pathToFileURL(path.join(ROOT, 'src/utils/themeRamp.ts')).href);
    const { accentSolidTriplet, accentFgTriplet, DEFAULT_ACCENT_RGB, DEFAULT_ACCENT_FG_DARK_RGB } =
        await import(pathToFileURL(path.join(ROOT, 'src/utils/color.ts')).href);
    const { ACCENT_COLORS, THEME_TINTS } = { ACCENT_COLORS: listOf(src, 'ACCENT_COLORS'), THEME_TINTS: listOf(src, 'THEME_TINTS') };
    const parsed = ok('ProgressBar exports PROGRESS_TRACK_WASH and PROGRESS_TRACK_RING as literal strings', typeof PROGRESS_TRACK === 'string')
        & ok('PROGRESS_FILL parses to exactly the six tones', JSON.stringify(Object.keys(PROGRESS_FILL).sort()) === JSON.stringify([...TONES].sort()),
            Object.keys(PROGRESS_FILL).join(', ') || 'nothing parsed');
    if (parsed) await measure();

    async function measure() {

    const indexCss = readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');
    const cssDarkFg = indexCss.match(/\.dark\s*\{[^}]*--accent-fg-rgb:\s*([\d ]+);/)?.[1];

    /** A class list → { light, dark } of [rung-or-name, alpha] for one property. */
    const pick = (classes, prop) => {
        const res = {};
        for (const c of classes.split(/\s+/)) {
            const m = c.match(new RegExp(`^(dark:)?${prop}-((?:slate-\\d+|white|accent-fg|accent|[a-z]+-\\d+))(?:/(\\d+))?$`));
            if (m) res[m[1] ? 'dark' : 'light'] = [m[2], m[3] ? Number(m[3]) / 100 : 1];
        }
        res.dark ??= res.light;
        return res;
    };

    const tints = ['#ffffff', ...THEME_TINTS];
    const accents = [null, ...ACCENT_COLORS];
    const worst = {};
    const note = (key, r, ctx) => { if (!worst[key] || r < worst[key].r) worst[key] = { r, ctx }; };

    for (const mode of ['light', 'dark']) {
        const wash = pick(PROGRESS_TRACK, 'bg')[mode];
        const ring = pick(PROGRESS_TRACK, 'ring')[mode];
        ok(`${mode}: the track has a wash and an outline`, wash && ring, PROGRESS_TRACK);
        if (!wash || !ring) continue;
        for (const tint of tints) {
            const ramp = themeRamp(mode, tint);
            for (const accent of accents) {
                const solid = triplet(accent ? accentSolidTriplet(accent) : DEFAULT_ACCENT_RGB);
                const fgs = accent
                    ? [triplet(accentFgTriplet(accent, mode === 'dark', ramp[mode === 'dark' ? '800' : 'white']))]
                    : mode === 'dark' ? [triplet(DEFAULT_ACCENT_FG_DARK_RGB), ...(cssDarkFg ? [triplet(cssDarkFg)] : [])] : [triplet(DEFAULT_ACCENT_RGB)];
                const colour = (name) => {
                    if (name === 'accent') return [solid];
                    if (name === 'accent-fg') return fgs;
                    if (name === 'white') return [hexRgb(ramp.white)];
                    const s = name.match(/^slate-(\d+)$/);
                    if (s) return [hexRgb(ramp[s[1]])];
                    if (TAILWIND[name]) return [hexRgb(TAILWIND[name])];
                    throw new Error(`progress-bar-gates: no colour for "${name}"; add it to TAILWIND`);
                };
                for (const [sname, layers] of Object.entries(SURFACES[mode])) {
                    let surface = null;
                    for (const layer of layers) {
                        const [name, a] = layer.split('/');
                        const alpha = a ? Number(a) / 100 : 1;
                        const c = name.startsWith('accent') ? solid : hexRgb(ramp[name] ?? ramp.white);
                        surface = surface ? over(c, alpha, surface) : c;
                    }
                    const ctx = `${mode}, tint ${tint}, accent ${accent ?? 'default'}, on ${sname}`;
                    const empty = over(colour(wash[0])[0], wash[1], surface);
                    const edge = over(colour(ring[0])[0], ring[1], empty);
                    const rTrack = ratio(edge, surface);
                    note(`${mode} track outline vs surface`, rTrack, ctx);
                    ok(`track outline ≥ 3:1 (${ctx})`, rTrack >= 3, rTrack.toFixed(2));
                    for (const [tone, classes] of Object.entries(PROGRESS_FILL)) {
                        if (tone !== 'accent' && accent) continue; // status fills do not depend on the project colour
                        const [fname, falpha] = pick(classes, 'bg')[mode];
                        for (const fc of colour(fname)) {
                            const fill = over(fc, falpha, surface);
                            const rS = ratio(fill, surface), rE = ratio(fill, empty);
                            note(`${mode} ${tone} fill vs surface`, rS, ctx);
                            note(`${mode} ${tone} fill vs empty track`, rE, ctx);
                            ok(`${tone} fill ≥ 3:1 on the surface (${ctx})`, rS >= 3, rS.toFixed(2));
                            ok(`${tone} fill ≥ 3:1 against the empty track (${ctx})`, rE >= 3, rE.toFixed(2));
                        }
                    }
                }
            }
        }
    }
    if (process.argv.includes('--worst')) {
        for (const [k, v] of Object.entries(worst)) console.log(`  ${k.padEnd(40)} ${v.r.toFixed(2)}  ${v.ctx}`);
    }
    }
}

/** The swatch lists live in ColorField, which imports React; read them as text. */
function listOf(_src, name) {
    const cf = readFileSync(path.join(ROOT, 'src/components/ui/ColorField.tsx'), 'utf8');
    const body = cf.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`))?.[1] ?? '';
    return [...body.matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
console.log(`\n${C.b}Progress bars${C.x} ${C.d}(${files.length} files, ${ROOT === HERE ? 'this checkout' : ROOT})${C.x}\n`);
if (!findings.length) {
    console.log(`  ${C.g}${checked} passed, 0 failed${C.x} ${C.d}· every bar is ui/ProgressBar; track and fills clear 3:1 on every surface, theme and tint${C.x}\n`);
} else {
    console.log(`  ${checked - findings.length} passed, ${findings.length} failed\n`);
    for (const f of findings.slice(0, 40)) console.log(`  ${C.r}${f.name}${C.x}\n        ${C.d}${f.detail ?? ''}${C.x}`);
    if (findings.length > 40) console.log(`  … and ${findings.length - 40} more`);
    console.log('');
}
process.exit(findings.length ? 1 : 0);
