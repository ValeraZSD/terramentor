// The app's mark, and every file the app and the OS need it in.
//
// The GEOMETRY is not here: it is `server/iconArt.js`, because the mark is drawn
// in three places now — these build-time files, the PNGs `server/appIcon.js`
// renders for whatever icon the learner chose, and the live preview in Settings
// — and a drawing kept in three files is three drawings by the end of the year.
// What IS here is the set of files a build ships and the assertions about them.
//
// Everything written below is the DEFAULT icon: `appIconSvg` with nothing
// chosen. That is deliberate — the static files and the generated ones are then
// the same picture for a fresh install, so the tab does not change icon the
// moment the app finishes loading its settings.
//
// Two cuts, because a 16px favicon and a 512px tile are not one picture at two
// scales: the FULL mark keeps the globe's grid, and the SMALL mark drops it and
// draws heavier. Below about 32px those grid lines are sub-pixel and turn the
// middle of the mark into grey mud.
//
// `@napi-rs/canvas` rasterises the SVG — already a dependency (PDF recovery
// renders pages with it, `tools/lib/icons.mjs` builds the .ico with it), so this
// needs no browser and no download. It resolves paint by VALUE, so everything
// here carries concrete colours; `src/components/BrandMark.tsx` is the copy that
// strokes with `currentColor` for the UI.
//
//   node tools/brand.mjs --apply    write brand/*.svg and public/icons/*.png
//   node tools/brand.mjs --check    the assertions below, without writing
import { createCanvas } from '@napi-rs/canvas';
import { pngFromSvg, rasterizeSvg } from '../server/iconRaster.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DEFAULT_BACKGROUND, INK_LIGHT, appIconSvg, markArt, markOnlySvg,
    normalizeAppIcon, svgDoc,
} from '../server/iconArt.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

export const NIGHT = DEFAULT_BACKGROUND;  // the tile the mark sits on by default
export const ON_NIGHT = INK_LIGHT;        // ink on that tile — slate-200

/** Short decimals, so the wordmark's own numbers do not print as 1e-16 tails. */
const f = (n) => (Math.round(n * 1000) / 1000).toString();

/** The icon as shipped: what `appIconSvg` draws when nothing has been chosen. */
const DEFAULT_ICON = normalizeAppIcon({});

export const ARTWORK = {
    /** The mark itself: nothing behind it, so it sits on any surface. */
    'terramentor-mark': () => markOnlySvg({ grid: true, stroke: 2.2, paper: '#ffffff' }),

    /** The same mark drawn for 16–32px: no grid, a heavier line. */
    'terramentor-mark-small': () => markOnlySvg({ stroke: 3.4, paper: '#ffffff' }),

    /**
     * One colour, for print, an embroidered patch or a favicon mask. A stencil
     * has no second colour to knock the pages out with, so this is the small cut
     * drawn as pure line — the only version where hollow is the right answer.
     */
    'terramentor-mono': () => markOnlySvg({ stroke: 3.4, paper: 'none', ink: 'currentColor' }),

    /** The app icon: a tile with a margin, for the .ico, the .icns and the
     *  manifest's `any` purpose. */
    // The tile is only ever rendered at 180px and up (the manifest's 192 and 512,
    // apple-touch's 180), so it KEEPS the grid — that is the difference between
    // the mark and a plain shield outline, and at those sizes it is plainly
    // legible. Only the 16px favicon drops it.
    'terramentor-icon': () => appIconSvg(DEFAULT_ICON, 'tile'),

    /** The maskable icon: full bleed, the mark inside the 80% safe circle
     *  Android's mask can crop to. */
    'terramentor-icon-maskable': () => appIconSvg(DEFAULT_ICON, 'maskable'),

    /** The tab's icon: full bleed, because at 16px a margin is a pixel a side.
     *  Written at 64 — the browser rasterises it at whatever the screen asks
     *  for, so this document carries the chosen cut. */
    'terramentor-favicon': () => appIconSvg(DEFAULT_ICON, 'favicon'),
};

/**
 * The lockup. The text is LIVE, in the same stack the app's UI uses, so it
 * renders as the app's own type wherever it is opened — and so it is editable.
 */
export function wordmarkSvg({ ink = '#0F172A', height = 64 } = {}) {
    const W = 268;
    // A NAMED family first, and NOTHING QUOTED. A stack led by `ui-sans-serif`
    // renders in a browser and draws nothing at all in a rasteriser that
    // resolves families by name, and one quoted member ('Segoe UI') takes the
    // whole stack down with it — measured: 654 ink pixels unquoted, 0 quoted.
    const stack = 'Segoe UI, ui-sans-serif, system-ui, -apple-system, Roboto, Helvetica Neue, Arial, sans-serif';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 64" width="${f(W * height / 64)}"`
        + ` height="${height}" role="img" aria-label="Terramentor">`
        + markArt({ d: 46, stroke: 2.2, ink, paper: 'none', grid: true })
        + `<text x="76" y="41.5" font-family="${stack}" font-size="27" letter-spacing="-0.4" fill="${ink}">`
        // 600/400, not 640/380: a weight with no face behind it silently falls
        // back to regular, so the two halves of the name drew identically.
        + `<tspan font-weight="600">Terra</tspan><tspan font-weight="400">mentor</tspan></text></svg>`;
}

/** The rasteriser is `server/iconRaster.js` — the runtime renders the same
 *  pictures for a chosen icon, and the trap it documents (an SVG rendered at its
 *  root tag's size and then stretched) is not one to have two chances at. */
const rasterize = rasterizeSvg;
export const png = pngFromSvg;

// ----------------------------------------------------------------- apply ----
/**
 * `public/icons/icon-512.png` is the single source the desktop build resizes,
 * so it is the one that must be right; the rest are what the browser and the
 * manifest ask for by name.
 */
async function apply() {
    const brand = resolve(repo, 'brand');
    const icons = resolve(repo, 'public', 'icons');
    mkdirSync(brand, { recursive: true });
    mkdirSync(icons, { recursive: true });
    const wrote = [];
    const put = (path, data) => { writeFileSync(path, data); wrote.push(path.replace(repo + '\\', '').replace(repo + '/', '')); };

    for (const [name, make] of Object.entries(ARTWORK)) put(resolve(brand, `${name}.svg`), make());
    put(resolve(brand, 'terramentor-wordmark.svg'), wordmarkSvg({}));
    put(resolve(brand, 'terramentor-wordmark-dark.svg'), wordmarkSvg({ ink: '#F1F5F9' }));

    const icon = ARTWORK['terramentor-icon']();
    const maskable = ARTWORK['terramentor-icon-maskable']();
    const favicon = ARTWORK['terramentor-favicon']();
    put(resolve(icons, 'icon-192.png'), await png(icon, 192));
    put(resolve(icons, 'icon-512.png'), await png(icon, 512));
    put(resolve(icons, 'icon-maskable-512.png'), await png(maskable, 512));
    // iOS masks this itself and composites it on an opaque background, so it is
    // the full-bleed tile and never the transparent mark.
    put(resolve(icons, 'apple-touch-icon.png'), await png(maskable, 180));
    put(resolve(icons, 'favicon.svg'), favicon);
    // Each PNG is drawn from the SVG AT ITS OWN SIZE, not from one document
    // rasterised twice: the size is an argument to the artwork now, and at 16px
    // it is what drops the globe's grid (`gridFloor`). Rendering both from the
    // 64px document shipped a 16px file that no longer matched what the server
    // generates for the same setting — which is the one thing `icon-gates.mjs`
    // compares byte for byte.
    put(resolve(icons, 'favicon-32.png'), await png(appIconSvg(DEFAULT_ICON, 'favicon', 32), 32));
    put(resolve(icons, 'favicon-16.png'), await png(appIconSvg(DEFAULT_ICON, 'favicon', 16), 16));
    return wrote;
}

// ---------------------------------------------------------------- checks ----
/**
 * How much of a rendered mark is INK, as a fraction of its pixels.
 *
 * Counting every non-transparent pixel counts the paper too, and the pages are
 * opaque white — which made the two cuts measure 50.8% and 51.6%, i.e. "the
 * silhouette fills half the box", the same answer for both and an assertion that
 * pins nothing. Darkness is the thing these checks are actually about.
 */
async function coverage(source, size) {
    const { ctx } = await rasterize(source, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= 24) continue;
        const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (lum < 128) ink++;
    }
    return ink / (size * size);
}

/**
 * The share of pixels that are the INK colour — the light drawing on a coloured
 * tile, rather than "how dark is this picture". A tile is opaque and the mark is
 * painted on it, so alpha and darkness both answer the same for a blank tile as
 * for a drawn one; the ink's own colour does not.
 */
async function inkShare(source, size, ink = INK_LIGHT) {
    const { ctx } = await rasterize(source, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const want = [1, 3, 5].map((i) => parseInt(ink.slice(i, i + 2), 16));
    let hit = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= 24) continue;
        // Generous, because antialiasing means most ink pixels are blends: this
        // counts anything nearer the ink than the tile.
        const near = Math.abs(data[i] - want[0]) + Math.abs(data[i + 1] - want[1]) + Math.abs(data[i + 2] - want[2]);
        if (near < 240) hit++;
    }
    return hit / (size * size);
}

async function checks() {
    let failed = 0;
    const ok = (what, pass, detail = '') => {
        if (!pass) failed++;
        console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${what}${detail ? `   ${detail}` : ''}`);
    };

    // 1. The mark still draws at the size it is smallest at. A logo that
    //    rasterises to nothing fails silently — the favicon is just a coloured
    //    square, which is exactly what it looks like when it is working.
    //    The favicon is a TILE now (the learner can colour it), so the thing to
    //    count is the pale ink, not darkness: on the default night tile
    //    `coverage` would answer "97% dark" whether the mark drew or not.
    // The 16px document, not the 64px one rendered small: below `gridFloor` the
    // artwork itself is different, and this check is about what ships as
    // `favicon-16.png`.
    const at16 = await inkShare(appIconSvg(DEFAULT_ICON, 'favicon', 16), 16);
    ok('the favicon draws its mark at 16px', at16 > 0.10, `${(at16 * 100).toFixed(1)}% of pixels are ink`);

    // …and the mark on its own still draws, which is what every surface that
    // puts the logo on its own background uses.
    const onPaper = await coverage(ARTWORK['terramentor-mark-small'](), 16);
    ok('the transparent small mark has ink at 16px', onPaper > 0.12, `${(onPaper * 100).toFixed(1)}% of pixels`);

    // 2. Android crops a maskable icon to a circle of 80% of the width. Anything
    //    of the ARTWORK outside that circle is shaved off on someone's phone.
    const maskable = ARTWORK['terramentor-icon-maskable']();
    const size = 240;
    const { ctx } = await rasterize(maskable, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const night = [0x0b, 0x12, 0x20];
    let outside = 0, sampled = 0;
    const r = size * 0.4;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (Math.hypot(x - size / 2, y - size / 2) <= r) continue;
            sampled++;
            const i = (y * size + x) * 4;
            const isTile = Math.abs(data[i] - night[0]) < 12 && Math.abs(data[i + 1] - night[1]) < 12 && Math.abs(data[i + 2] - night[2]) < 12;
            if (!isTile && data[i + 3] > 24) outside++;
        }
    }
    ok('nothing but tile crosses the maskable safe circle', outside === 0, `${outside}/${sampled} samples are artwork`);

    // 3. Why there are two cuts at all, stated as something that can fail: at
    //    16px the grid is sub-pixel and greys out, so the full mark arrives as
    //    the same amount of ink as the cut that does not draw a grid — the
    //    detail is not small, it is GONE. At 64px it is plainly there. If these
    //    ever converge at 64, the full mark has stopped being the richer one and
    //    the second file is dead weight.
    //    The two shipped cuts differ in stroke weight as well as in the grid, so
    //    comparing them to each other measures both at once. Hold the weight and
    //    vary only the grid.
    const withGrid = (n) => coverage(svgDoc(markArt({})), n);
    const without = (n) => coverage(svgDoc(markArt({ grid: false })), n);
    const [g16, n16, g64, n64] = [await withGrid(16), await without(16), await withGrid(64), await without(64)];
    //    Measured, the grid does not VANISH at 16px — it blots: it adds 31% more
    //    dark pixels there against 23% at 64px, because sub-pixel lines land as
    //    grey wash over the middle instead of as lines. That ratio is the mud,
    //    and it is why the small cut drops the grid rather than thinning it.
    const rel = (a, b) => (a - b) / b;
    ok('the grid costs proportionally more ink at 16px than at 64px',
        rel(g16, n16) > rel(g64, n64),
        `+${(rel(g16, n16) * 100).toFixed(0)}% at 16 vs +${(rel(g64, n64) * 100).toFixed(0)}% at 64`);
    ok('the grid is real at 64px, so the full cut is worth keeping',
        g64 - n64 > 0.03, `with ${(g64 * 100).toFixed(1)}% vs without ${(n64 * 100).toFixed(1)}%`);

    // 4. The icon is RENDERED at 512, not stretched there from 64.
    //    This is the fault this file shipped with: `loadImage` renders an SVG at
    //    the size its root tag declares, so every PNG was a 64px raster blown up
    //    — `icon-512.png` was 8x, visibly soft, and 77 kB of blur where the
    //    sharp render is 22 kB. Nothing about the artwork changes when that
    //    breaks, so no check on ink or coverage can see it. What does change is
    //    the EDGE: a native render antialiases over about a pixel, an upscale
    //    smears the same edge over eight. Count the pixels that are neither the
    //    tile nor the ink and the two differ by more than an order of
    //    magnitude, which is a gate, not a judgement call.
    const icon = ARTWORK['terramentor-icon']();
    const edgeShare = (ctx, size) => {
        const { data } = ctx.getImageData(0, 0, size, size);
        let between = 0, opaque = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] <= 24) continue;
            opaque++;
            const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            if (lum > 40 && lum < 200) between++;      // neither the night tile nor the pale ink
        }
        return between / opaque;
    };
    const sharp = edgeShare((await rasterize(icon, 512)).ctx, 512);
    //    The control is the bug itself: render at 64 and stretch, exactly what
    //    this file used to do. An assertion with no failing case beside it is
    //    a number nobody can read.
    const smeared = createCanvas(512, 512);
    smeared.getContext('2d').drawImage((await rasterize(icon, 64)).canvas, 0, 0, 512, 512);
    const upscaled = edgeShare(smeared.getContext('2d'), 512);
    ok('the 512px icon is rendered at 512, not stretched from 64',
        sharp < upscaled / 3, `${(sharp * 100).toFixed(1)}% of its pixels are edge, against ${(upscaled * 100).toFixed(1)}% when stretched`);

    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
    return failed;
}

if (process.argv.includes('--apply')) console.log((await apply()).join('\n'));
if (process.argv.includes('--check')) process.exit(await checks() ? 1 : 0);
