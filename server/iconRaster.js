// Turning one of `iconArt.js`'s SVGs into pixels — in ONE place, because the
// obvious way to do it is wrong and was shipped that way for months.
//
// `loadImage` renders an SVG at the intrinsic size its ROOT TAG declares (64 for
// everything the art module writes), and `drawImage(img, 0, 0, 512, 512)` then
// merely stretches that bitmap. Every PNG icon the project shipped was therefore
// an 8x upscale of a 64px image: `icon-512.png` was visibly soft, and 77 kB of
// blur where the honest render is 22 kB. Nothing about the artwork changes when
// that breaks, so no check on ink or coverage can see it — which is why the
// rasteriser is a module with one door rather than four private copies (the
// build's assets, the runtime's PNGs, and the two suites that measure them).
//
// The fix is `atSize`: rewrite the root's width/height before loading, which
// re-renders the vectors; the viewBox makes that a scale rather than a crop.
//
// `@napi-rs/canvas` is a runtime dependency already (PDF page recovery renders
// with it), so this needs no browser and no download, and it is available inside
// the Docker image, which ships `server`, `dist` and `public` and nothing else.

import { createCanvas, loadImage } from '@napi-rs/canvas';

/** Re-declare the root's size so the vectors are rendered, not stretched. */
export function atSize(source, size) {
    return source.replace(/^(<svg\b[^>]*?)\swidth="[^"]*"\sheight="[^"]*"/, `$1 width="${size}" height="${size}"`);
}

export async function rasterizeSvg(source, size) {
    const img = await loadImage(Buffer.from(atSize(source, size)));
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    return { canvas, ctx };
}

export async function pngFromSvg(source, size) {
    const { canvas } = await rasterizeSvg(source, size);
    return canvas.toBuffer('image/png');
}
