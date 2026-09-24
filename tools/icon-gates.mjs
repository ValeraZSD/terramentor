// tools/icon-gates.mjs — the app's icon: the three choices, the pictures they
// make, and the files a browser or a phone actually fetches.
//
// Run:  node tools/icon-gates.mjs
//
// Why these things and not others:
//
//  * A MISSING SETTING IS THE DEFAULT. `Number(null)` and `Number('')` are both
//    0, not NaN, so the first version of `clampRadius` turned an unset row into
//    a SQUARE tile — the generated icon stopped matching the one the project
//    ships, on a fresh install, silently. Every absent-value case is asserted
//    here with the square as its control.
//
//  * THE COLOUR IS AN ATTRIBUTE VALUE IN A DOCUMENT THE BROWSER PARSES. It is
//    the one field of the three that is free text, it is written into
//    `fill="…"`, and the hex pattern is the entire validation. Asserted with a
//    value that would break out of the attribute.
//
//  * A ROUNDNESS THAT DOES NOT REACH THE PIXELS is the whole feature failing
//    quietly: the SVG can carry the right `rx` and the raster still show a
//    square if a variant drops it. Measured on rendered corners, both ends of
//    the range, with the maskable variant asserted to IGNORE it (Android rounds
//    that one itself, and rounded twice is a notch).
//
//  * THE SHIPPED FILES ARE THE DEFAULT ICON, byte for byte. That is what makes
//    the tab not flicker from one mark to another as the settings load, and it
//    is the assertion that fails when someone changes the artwork and forgets
//    `node tools/brand.mjs --apply`.
//
//  * THE HASH IS A CACHE KEY WITH A YEAR ON IT. An icon URL is served
//    `immutable` when it carries the current hash, so a hash that fails to move
//    with a choice is an icon nobody can change until the cache expires.
//
//  * AND THE PLUMBING AROUND IT: the service worker must not cache the
//    generated manifest (everything else same-origin it caches first, for the
//    life of the build), and `index.html` must still carry the link tags the
//    client re-points — remove one and the feature does nothing, with no error.
//
// No model, no network, no dependency on the learner's own library.

import express from 'express';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BOOK,
    DEFAULT_BACKGROUND, DEFAULT_RADIUS, DEFAULT_STYLE, ICON_STYLES,
    appIconHash, appIconSvg, clampRadius, iconContrast, inkFor,
    normalizeAppIcon, normalizeHex,
} from '../server/iconArt.js';
import { rasterizeSvg, pngFromSvg } from '../server/iconRaster.js';
import { ICON_OUTPUTS, manifestFor, renderIcon } from '../server/appIcon.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${what}${detail ? `   ${detail}` : ''}`);
};
const eq = (what, got, want) => ok(what, JSON.stringify(got) === JSON.stringify(want),
    JSON.stringify(got) === JSON.stringify(want) ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const DEFAULT_ICON = normalizeAppIcon({});

// ------------------------------------------------- 1. reading the settings ----
console.log('\nthe three settings rows, as read');

eq('nothing stored is the shipped icon', DEFAULT_ICON,
    { style: DEFAULT_STYLE, background: DEFAULT_BACKGROUND, radius: DEFAULT_RADIUS });

// The control for the bug this rule exists for: 0 is reachable, but only by
// asking for it. Everything that is not a number is the default.
eq('an absent radius is the default, not 0', [null, undefined, '', 'x', {}].map(clampRadius),
    [DEFAULT_RADIUS, DEFAULT_RADIUS, DEFAULT_RADIUS, DEFAULT_RADIUS, DEFAULT_RADIUS]);
eq('a radius of 0 is honoured — it is a square tile, not a missing value', clampRadius('0'), 0);
eq('the radius is clamped to its own range', [clampRadius(-40), clampRadius(999)], [0, 50]);

eq('an unknown style falls back to the shipped cut', normalizeAppIcon({ style: 'cubist' }).style, DEFAULT_STYLE);
// `outline` was offered for part of an afternoon on 2026-09-17 and withdrawn.
// A row written while it existed must not draw a hollow mark on a tile.
eq('a withdrawn style falls back too', normalizeAppIcon({ style: 'outline' }).style, DEFAULT_STYLE);
eq('two cuts are offered, and they are the two the picker draws', ICON_STYLES, ['full', 'simple']);
ok('every offered style survives normalisation',
    ICON_STYLES.every((style) => normalizeAppIcon({ style }).style === style), ICON_STYLES.join(', '));

eq('a three-digit hex is expanded', normalizeHex('#ABC'), '#aabbcc');
eq('a colour that is not a colour is dropped', normalizeAppIcon({ background: 'darkslategray' }).background, DEFAULT_BACKGROUND);

// The colour lands inside fill="…" in a document the browser parses.
const HOSTILE = '#fff" onload="alert(1)';
eq('an attribute break-out is not a colour', normalizeHex(HOSTILE), null);
ok('and nothing hostile reaches the drawing',
    !appIconSvg({ background: HOSTILE }, 'tile', 64).includes('onload'));

// ------------------------------------------------------------- 2. the hash ----
console.log('\nthe hash a URL is cached by');

const h = (patch) => appIconHash({ ...DEFAULT_ICON, ...patch });
ok('the same icon hashes the same', h({}) === h({}), h({}));
ok('the style moves it', h({ style: 'simple' }) !== h({}));
ok('the colour moves it', h({ background: '#7f1d1d' }) !== h({}));
ok('the roundness moves it', h({ radius: 50 }) !== h({}));
ok('and an equivalent spelling does not', h({ background: '#0B1220' }) === h({}));

// -------------------------------------------------------- 3. the pictures ----
console.log('\nwhat the pixels say');

/** The colour at a point of a rendered icon, as `#rrggbb` + alpha. */
async function pixel(svg, size, x, y) {
    const { ctx } = await rasterizeSvg(svg, size);
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { hex: `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`, a: d[3] };
}

const SIZE = 128;
const corner = (svg) => pixel(svg, SIZE, 1, 1);

const square = await corner(appIconSvg({ radius: 0 }, 'favicon', SIZE));
eq('a square tile paints its own corner', square.hex, DEFAULT_BACKGROUND);
const round = await corner(appIconSvg({ radius: 50 }, 'favicon', SIZE));
ok('a fully round one does not', round.a === 0, `alpha ${round.a} at the corner`);
const mask = await corner(appIconSvg({ radius: 50 }, 'maskable', SIZE));
eq('and the maskable cut ignores roundness — the platform rounds it', mask.hex, DEFAULT_BACKGROUND);

const red = await pixel(appIconSvg({ background: '#7f1d1d', radius: 0 }, 'favicon', SIZE), SIZE, 2, 2);
eq('the chosen colour is the colour that is painted', red.hex, '#7f1d1d');

// The cut is a control, so it has to reach the thing the learner is looking at
// when they press it — the TAB. The favicon variant used to drop the grid at
// every size, which made "Detailed / Simple" change the settings preview and
// nothing else. The one raster that gives the choice up is the 16px PNG, where
// both cuts photograph as the same grey mush.
ok('the chosen cut reaches the tab (the SVG the document links)',
    appIconSvg({ style: 'full' }, 'favicon', 64) !== appIconSvg({ style: 'simple' }, 'favicon', 64));
ok('…and the 32px PNG beside it',
    appIconSvg({ style: 'full' }, 'favicon', 32) !== appIconSvg({ style: 'simple' }, 'favicon', 32));
ok('at 16px the two cuts are one picture — the grid is mud there',
    appIconSvg({ style: 'full' }, 'favicon', 16) === appIconSvg({ style: 'simple' }, 'favicon', 16));
ok('…and at tile size they are not',
    appIconSvg({ style: 'full' }, 'tile', 512) !== appIconSvg({ style: 'simple' }, 'tile', 512));

// Android crops a maskable icon to a circle of 80% of the width. Anything of the
// ARTWORK outside that circle is shaved off on someone's phone — for every cut,
// and at both ends of the roundness range, since neither is fixed any more.
async function outsideSafeCircle(icon) {
    const n = 240;
    const { ctx } = await rasterizeSvg(appIconSvg(icon, 'maskable', n), n);
    const { data } = ctx.getImageData(0, 0, n, n);
    const tile = [1, 3, 5].map((i) => parseInt((normalizeHex(icon.background) || DEFAULT_BACKGROUND).slice(i, i + 2), 16));
    let outside = 0;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            if (Math.hypot(x - n / 2, y - n / 2) <= n * 0.4) continue;
            const i = (y * n + x) * 4;
            const isTile = Math.abs(data[i] - tile[0]) < 12 && Math.abs(data[i + 1] - tile[1]) < 12 && Math.abs(data[i + 2] - tile[2]) < 12;
            if (!isTile && data[i + 3] > 24) outside++;
        }
    }
    return outside;
}
for (const style of ICON_STYLES) {
    for (const radius of [0, 50]) {
        const outside = await outsideSafeCircle({ style, radius });
        ok(`nothing but tile crosses the safe circle (${style}, ${radius}%)`, outside === 0, `${outside} pixels`);
    }
}

// The rasteriser trap, kept where a second renderer could reintroduce it: an SVG
// rendered at its root tag's size and then stretched smears its edges over eight
// pixels instead of one. The control is the bug.
const { canvas: small } = await rasterizeSvg(appIconSvg({}, 'tile', 64), 64);
const edgeShare = (ctx, n) => {
    const { data } = ctx.getImageData(0, 0, n, n);
    let between = 0, opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= 24) continue;
        opaque++;
        const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (lum > 40 && lum < 200) between++;
    }
    return between / opaque;
};
const sharpCtx = (await rasterizeSvg(appIconSvg({}, 'tile', 512), 512)).ctx;
const { createCanvas } = await import('@napi-rs/canvas');
const smeared = createCanvas(512, 512);
smeared.getContext('2d').drawImage(small, 0, 0, 512, 512);
const sharp = edgeShare(sharpCtx, 512), blurred = edgeShare(smeared.getContext('2d'), 512);
ok('the runtime renders at the size asked for rather than stretching',
    sharp < blurred / 3, `${(sharp * 100).toFixed(1)}% edge against ${(blurred * 100).toFixed(1)}% stretched`);

// --------------------------------------------------------- 4. the palette ----
console.log('\nthe colours the picker offers');

const panel = read('src/components/settings/AppIconPanel.tsx');
const field = read('src/components/ui/ColorField.tsx');
ok('the swatch grid fits as many chips as it can — sixteen on one line where there is room',
    /useGridColumns/.test(field) && /DENSE_COLUMNS = 16/.test(field));
ok('and the count is chosen by the CONTAINER, never a viewport breakpoint or a prop',
    /ResizeObserver/.test(field) && !/dense/.test(panel));
const palette = [...panel.matchAll(/'(#[0-9a-f]{6})',\s*\/\//g)].map((m) => m[1]);
eq('sixteen swatches, so the eight-column grid has no orphan', palette.length, 16);
const faint = palette.filter((c) => iconContrast(c) < 4.5);
ok('every swatch draws a legible mark', faint.length === 0,
    faint.length ? faint.map((c) => `${c} ${iconContrast(c).toFixed(1)}:1`).join(', ')
        : `worst ${Math.min(...palette.map(iconContrast)).toFixed(1)}:1`);
// The one light swatch is there to prove the ink is derived and not fixed.
ok('the ink flips on a light tile',
    inkFor('#f8fafc') !== inkFor('#0b1220'), `${inkFor('#f8fafc')} on paper, ${inkFor('#0b1220')} on night`);
ok('and a light tile is actually offered',
    palette.some((c) => inkFor(c) === inkFor('#f8fafc')));

// ----------------------------------------------- 5. the shipped files ----
console.log('\nthe files a build ships are the default icon');

const SHIPPED_IS = [
    ['public/icons/icon-192.png', 'tile', 192],
    ['public/icons/icon-512.png', 'tile', 512],
    ['public/icons/icon-maskable-512.png', 'maskable', 512],
    ['public/icons/apple-touch-icon.png', 'maskable', 180],
    ['public/icons/favicon-32.png', 'favicon', 32],
    ['public/icons/favicon-16.png', 'favicon', 16],
];
for (const [file, variant, size] of SHIPPED_IS) {
    const fresh = await pngFromSvg(appIconSvg(DEFAULT_ICON, variant, size), size);
    const disk = readFileSync(join(repoRoot, file));
    ok(`${file} is a fresh render of the default`, fresh.equals(disk),
        fresh.equals(disk) ? '' : `${disk.length} on disk, ${fresh.length} rendered — run \`node tools/brand.mjs --apply\``);
}
eq('favicon.svg too', read('public/icons/favicon.svg'), appIconSvg(DEFAULT_ICON, 'favicon', 64));

// -------------------------------------------------------- 6. the manifest ----
console.log('\nthe manifest and the icon endpoint');

const chosen = normalizeAppIcon({ style: 'simple', background: '#134e4a', radius: 8 });
const manifest = manifestFor(chosen);
// THE ICON'S TILE IS NOT THE SPLASH. `background_color` is the app's own page
// and `theme_color` its header — the pair the client painted, handed in by the
// caller (`manifestColors`, gated end to end in `theme-ramp-gates.mjs`). This
// file owns the other half of that claim: the icon module must not leak the
// tile into either field, which is exactly what it used to do, and what a
// person changing the manifest for an icon reason would reach for again. The
// tile here is a teal nothing else in the pair can be.
const surfaces = { background: '#f4f4f4', theme: '#ffffff' };
ok('the tile colour does not reach the splash',
    manifest.background_color !== chosen.background && manifest.theme_color !== chosen.background,
    `tile ${chosen.background}, manifest ${manifest.background_color} / ${manifest.theme_color}`);
eq('the splash is the page it was handed', manifestFor(chosen, surfaces).background_color, surfaces.background);
eq('…under the header it was handed', manifestFor(chosen, surfaces).theme_color, surfaces.theme);
const hash = appIconHash(chosen);
ok('every icon it names carries the current hash',
    manifest.icons.every((i) => i.src.endsWith(`?v=${hash}`)), manifest.icons.map((i) => i.src).join(' '));
ok('and names only files the renderer knows',
    manifest.icons.every((i) => ICON_OUTPUTS[i.src.split('/').pop().split('?')[0]]));
ok('it still carries the name and scope from the static file',
    manifest.name === 'Terramentor' && manifest.start_url === '/' && manifest.display === 'standalone');
for (const name of Object.keys(ICON_OUTPUTS)) {
    const rendered = await renderIcon(chosen, name);
    ok(`${name} renders`, rendered && rendered.body.length > 200 && rendered.type === 'image/png',
        rendered ? `${rendered.body.length} bytes` : 'nothing');
}

// A real request against a real router, because the headers are the half of
// this that no pure function can be wrong about on its own.
const app = express();
app.use((await import('../server/appIcon.js')).createAppIconRouter({ readIcon: () => chosen }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const mRes = await fetch(`${base}/manifest.webmanifest`);
ok('the served manifest is a manifest', mRes.status === 200
    && (mRes.headers.get('content-type') || '').startsWith('application/manifest+json'));
eq('and is revalidated, never stored', mRes.headers.get('cache-control'), 'no-cache');
eq('its icons match the pure function', (await mRes.json()).icons, manifest.icons);

const cur = await fetch(`${base}/api/icon/icon-192.png?v=${hash}`);
eq('an icon asked for by its hash is cacheable for a year',
    cur.headers.get('cache-control'), 'public, max-age=31536000, immutable');
const stale = await fetch(`${base}/api/icon/icon-192.png?v=lastweek`);
eq('one asked for with a stale hash must revalidate', stale.headers.get('cache-control'), 'no-cache');
eq('an unknown name is a 404, not a 500', (await fetch(`${base}/api/icon/logo.bmp`)).status, 404);
const svgRes = await fetch(`${base}/api/icon/favicon.svg`);
ok('the SVG favicon is served as SVG', svgRes.status === 200
    && (svgRes.headers.get('content-type') || '').startsWith('image/svg+xml'));
// Closed and AWAITED: `process.exit()` while a listening handle is still
// closing trips a libuv assertion on Windows, which reads as the suite
// crashing after it has already passed.
await new Promise((r) => server.close(r));

// ------------------------------------------------------- 7. the plumbing ----
console.log('\nthe three places a change could stop reaching the reader');

const sw = read('src/sw-template.js');
ok('the service worker does not cache the generated manifest',
    /url\.pathname === '\/manifest\.webmanifest'/.test(sw));
ok('…and still bypasses the icons with the rest of /api', /startsWith\('\/api'\)/.test(sw));

const html = read('index.html');
for (const tag of ['link[rel="icon"] type="image/svg+xml"', 'apple-touch-icon', 'rel="manifest"']) {
    const probe = tag === 'link[rel="icon"] type="image/svg+xml"' ? 'type="image/svg+xml"' : tag;
    ok(`index.html still carries ${tag}`, html.includes(probe));
}
ok('the boot script replays the cached icon before the first paint', html.includes('t.iconHref'));

const client = read('src/utils/appIcon.ts');
ok('the client draws from the shared module, not a copy',
    client.includes("from '../../server/iconArt.js'"));

// The UI cut strokes the mark hollow, so nothing fills the pages for it: the
// globe must be CULLED with the shared cull and the pages drawn FROM the holes,
// or the rim shows through their interiors again (the assistant avatar, reported
// 2026-09-18 — the circle was drawn unclipped behind stroke-only polygons).
const brandMark = read('src/components/BrandMark.tsx');
ok('the UI cut culls the globe with the shared cull and strokes the holes',
    /import \{[^}]*\bCULL_BOX\b[^}]*\bpageHoles\b[^}]*\} from '\.\.\/\.\.\/server\/iconArt\.js'/.test(brandMark)
    && /clipPath=\{`url\(#/.test(brandMark)
    && brandMark.includes('<path d={PAGE_D} />')
    && !brandMark.includes('368.02'));
const vite = read('vite.config.ts');
ok('dev proxies the manifest to the server that generates it',
    vite.includes("'/manifest.webmanifest'"));

// THE BOOK IS NOT SHRUNK ONTO THE BALL. This is a literal, and it is a literal
// on purpose: it is the only assertion in this file that fails when the mark is
// wrong in the one way it has actually gone wrong twice.
//
// The mark is ONE INTEGRATED DRAWING — the designer's vector
// (`Terramentor-local/logo.svg`) places the book at identity scale, its crown
// rising in the V between the page tops and a full-height spine through the
// pages. Twice now a session has read the resulting silhouette as a "tulip",
// shrunk the book to 0.70 and dropped it toward the globe's chin (2026-09-17,
// reverted; 2026-09-22, pushed to the public repo and reverted again after he
// saw it on GitHub and said it had been nicer before). Both times every other
// check here passed — 69/69 at BOTH placements — because they measure ink,
// contrast, safe circles and cache headers, and the artwork is legible either
// way. Nothing measured whether it was the RIGHT drawing.
//
// So if these numbers ever need to change, the render must be compared against
// that vector first and this comment rewritten to say who compared them. A
// failure here is not a stale expectation to update; it is the question "did
// anyone look at the designer's file?".
ok('the book is placed at identity, not shrunk onto the globe',
    BOOK.scale === 1 && Math.abs(BOOK.cy - 144.225) < 1e-9,
    `BOOK is { scale: ${BOOK.scale}, cy: ${BOOK.cy} } — expected { scale: 1, cy: 144.225 }`);

console.log(`\n${pass} passed, ${fail} failed`);
// `process.exitCode`, not `process.exit()`: the rasteriser holds a thread pool
// and forcing the process down while a handle is still closing trips a libuv
// assertion on Windows — the suite passed, printed its tally, and then reported
// 127, which the runner reads as a crash.
process.exitCode = fail ? 1 : 0;
