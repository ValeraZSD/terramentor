// Document-scanner pipeline: a phone photo of a page becomes a flat, legible
// image a vision model can actually read.
//
// This runs in the BROWSER, not on the server, for three reasons:
//   1. The learner studies on a phone over Tailscale. Uploading a 4 MB original
//      so the server can warp it spends the whole latency budget on bytes we are
//      about to throw away; warping first sends ~200 KB instead.
//   2. The corner-adjust UI needs the pixels locally anyway.
//   3. The server has no image-processing dependency and does not need one.
//
// Nothing here is clever. It is the classic four-point transform: order the
// corners, solve the homography that maps them onto a rectangle, inverse-sample
// every output pixel, then (for written work only) flatten the lighting with an
// adaptive threshold.

export type Point = { x: number; y: number };
export type Quad = [Point, Point, Point, Point];
export type ScanMode = 'document' | 'photo';

/** Long edge of the warped output. Big enough for a vision model to read small
 *  handwriting, small enough that the JPEG stays a couple of hundred KB. */
const MAX_OUTPUT_EDGE = 1600;

/**
 * Order four arbitrary points as [top-left, top-right, bottom-right, bottom-left].
 *
 * Two steps, because they solve two different problems:
 *
 *  1. Sort by angle about the centroid. This fixes ADJACENCY — consecutive
 *     entries are guaranteed to share an edge rather than be diagonal. The usual
 *     sum/difference shortcut ("TL has the smallest x+y") gets this wrong on a
 *     strongly rotated page, and photographing a page turned 40° on a desk is
 *     completely normal. atan2(dx, -dy) ascending walks clockwise in screen
 *     coordinates, where y grows downward.
 *
 *  2. Rotate the cycle so the top-left-most corner is first. The angular sort
 *     alone produces the right cycle from an arbitrary STARTING point, which
 *     warps the page 90° or 180° round — and a rotated scan is the nastiest kind
 *     of failure here, because nothing errors: the model just receives a sideways
 *     page and marks whatever it can make of it.
 */
export function orderCorners(points: Point[]): Quad {
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const cy = points.reduce((s, p) => s + p.y, 0) / points.length;

    const clockwise = [...points].sort((a, b) => (
        Math.atan2(a.x - cx, -(a.y - cy)) - Math.atan2(b.x - cx, -(b.y - cy))
    )).slice(0, 4);

    let start = 0;
    for (let i = 1; i < 4; i++) {
        if (clockwise[i].x + clockwise[i].y < clockwise[start].x + clockwise[start].y) start = i;
    }
    return [
        clockwise[start],
        clockwise[(start + 1) % 4],
        clockwise[(start + 2) % 4],
        clockwise[(start + 3) % 4],
    ];
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Output size for a quad: the longest opposing edges, so nothing in the page is
 * squeezed, capped on the long side.
 */
export function outputSizeFor(quad: Quad): { width: number; height: number } {
    const [tl, tr, br, bl] = quad;
    const width = Math.max(dist(tl, tr), dist(bl, br));
    const height = Math.max(dist(tl, bl), dist(tr, br));
    const scale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

/**
 * Solve the 3x3 homography H with H·src = dst (h22 fixed at 1), as the usual
 * 8x8 linear system by Gaussian elimination with partial pivoting.
 *
 * Returns the matrix as a flat 9-array, or null when the system is singular —
 * which happens when three corners are collinear or two coincide, i.e. exactly
 * when the user has dragged the handles into a degenerate shape. Callers must
 * treat null as "don't warp", never as "warp with garbage".
 */
export function computeHomography(src: Quad, dst: Quad): number[] | null {
    const a: number[][] = [];
    const b: number[] = [];
    for (let i = 0; i < 4; i++) {
        const { x, y } = src[i];
        const { x: u, y: v } = dst[i];
        a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
        b.push(u);
        a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
        b.push(v);
    }

    const n = 8;
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
        }
        if (Math.abs(a[pivot][col]) < 1e-10) return null; // degenerate quad
        [a[col], a[pivot]] = [a[pivot], a[col]];
        [b[col], b[pivot]] = [b[pivot], b[col]];

        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const factor = a[r][col] / a[col][col];
            if (factor === 0) continue;
            for (let c = col; c < n; c++) a[r][c] -= factor * a[col][c];
            b[r] -= factor * b[col];
        }
    }

    const h = b.map((val, i) => val / a[i][i]);
    return [...h, 1];
}

/** Bilinear sample of `src` at a fractional coordinate, edge-clamped. */
function sampleBilinear(
    src: Uint8ClampedArray, sw: number, sh: number,
    x: number, y: number, out: number[],
): void {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const cx0 = Math.min(sw - 1, Math.max(0, x0));
    const cy0 = Math.min(sh - 1, Math.max(0, y0));
    const cx1 = Math.min(sw - 1, cx0 + 1);
    const cy1 = Math.min(sh - 1, cy0 + 1);

    for (let ch = 0; ch < 3; ch++) {
        const p00 = src[(cy0 * sw + cx0) * 4 + ch];
        const p10 = src[(cy0 * sw + cx1) * 4 + ch];
        const p01 = src[(cy1 * sw + cx0) * 4 + ch];
        const p11 = src[(cy1 * sw + cx1) * 4 + ch];
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        out[ch] = top + (bottom - top) * fy;
    }
}

/**
 * Perspective-correct `source` so that `quad` fills the output rectangle.
 * Throws on a degenerate quad — the caller shows the message and lets the
 * learner drag the corners back into a sane shape.
 */
export function warpQuad(
    source: ImageData,
    quad: Quad,
    size = outputSizeFor(quad),
): ImageData {
    const { width, height } = size;
    const dstQuad: Quad = [
        { x: 0, y: 0 },
        { x: width - 1, y: 0 },
        { x: width - 1, y: height - 1 },
        { x: 0, y: height - 1 },
    ];

    // Solve dst -> src: we iterate over OUTPUT pixels and pull from the source,
    // which leaves no unwritten holes (forward-mapping would).
    const h = computeHomography(dstQuad, quad);
    if (!h) throw new Error('Those corners do not form a valid quadrilateral — drag them back onto the page.');

    const out = new ImageData(width, height);
    const rgb = [0, 0, 0];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const w = h[6] * x + h[7] * y + h[8];
            const sx = (h[0] * x + h[1] * y + h[2]) / w;
            const sy = (h[3] * x + h[4] * y + h[5]) / w;
            sampleBilinear(source.data, source.width, source.height, sx, sy, rgb);
            const o = (y * width + x) * 4;
            out.data[o] = rgb[0];
            out.data[o + 1] = rgb[1];
            out.data[o + 2] = rgb[2];
            out.data[o + 3] = 255;
        }
    }
    return out;
}

/**
 * Flatten a photo of written work to near-black-on-white.
 *
 * Adaptive (local-mean) rather than a global threshold, because a phone photo of
 * a page is never evenly lit — there is a hand shadow down one side and a bright
 * patch under the lamp, and any single global cutoff turns one of those into a
 * solid block. The local mean is computed from a summed-area table so the window
 * size costs nothing.
 *
 * `C` biases against the mean: pencil is much lower-contrast than pen, and
 * without the bias faint pencil strokes get read as paper noise and vanish.
 *
 * ONLY for `document` mode. Running this on a drawing destroys exactly what is
 * being marked — shading, tone, line weight — which is why the mode is chosen by
 * the model that authored the exercise rather than guessed at here.
 */
export function adaptiveThreshold(image: ImageData, windowFrac = 0.125, C = 10): ImageData {
    const { width: w, height: h, data } = image;

    // Grayscale first (Rec. 601 luma), into a plain array for the SAT.
    const gray = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) {
        gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }

    // Summed-area table with a zero-padded first row/column, so a window sum is
    // four lookups regardless of window size.
    const sat = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
        let rowSum = 0;
        for (let x = 0; x < w; x++) {
            rowSum += gray[y * w + x];
            sat[(y + 1) * (w + 1) + (x + 1)] = sat[y * (w + 1) + (x + 1)] + rowSum;
        }
    }

    const radius = Math.max(4, Math.floor(Math.min(w, h) * windowFrac * 0.5));
    const out = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - radius);
        const y1 = Math.min(h - 1, y + radius);
        for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - radius);
            const x1 = Math.min(w - 1, x + radius);
            const area = (x1 - x0 + 1) * (y1 - y0 + 1);
            const sum =
                sat[(y1 + 1) * (w + 1) + (x1 + 1)]
                - sat[y0 * (w + 1) + (x1 + 1)]
                - sat[(y1 + 1) * (w + 1) + x0]
                + sat[y0 * (w + 1) + x0];
            const mean = sum / area;
            const value = gray[y * w + x] < mean - C ? 0 : 255;
            const o = (y * w + x) * 4;
            out.data[o] = value;
            out.data[o + 1] = value;
            out.data[o + 2] = value;
            out.data[o + 3] = 255;
        }
    }
    return out;
}

/**
 * Gentle levels stretch for `photo` mode: pull the 2nd/98th percentiles to black
 * and white so a dim desk photo is legible, WITHOUT quantising anything. Tone
 * and line weight survive, which is the whole point of photo mode.
 */
export function autoLevels(image: ImageData): ImageData {
    const { width: w, height: h, data } = image;
    const hist = new Uint32Array(256);
    for (let i = 0; i < w * h; i++) {
        const luma = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) | 0;
        hist[luma]++;
    }
    const total = w * h;
    const lowCut = total * 0.02;
    const highCut = total * 0.98;
    let acc = 0;
    let lo = 0;
    let hi = 255;
    for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= lowCut) { lo = v; break; }
    }
    acc = 0;
    for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= highCut) { hi = v; break; }
    }
    if (hi - lo < 16) return image; // already flat or nearly blank — leave it alone

    const scale = 255 / (hi - lo);
    const out = new ImageData(w, h);
    for (let i = 0; i < w * h * 4; i += 4) {
        for (let ch = 0; ch < 3; ch++) {
            out.data[i + ch] = Math.max(0, Math.min(255, (data[i + ch] - lo) * scale));
        }
        out.data[i + 3] = 255;
    }
    return out;
}

/** Run the mode's finishing pass over a warped page. */
export function finishForMode(warped: ImageData, mode: ScanMode): ImageData {
    return mode === 'document' ? adaptiveThreshold(warped) : autoLevels(warped);
}

// --- Canvas / File plumbing ------------------------------------------------

/** Decode a File (a camera capture) into an ImageData, downscaled for processing. */
export async function fileToImageData(file: File, maxEdge = 2000): Promise<ImageData> {
    const bitmap = await createImageBitmap(file);
    try {
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Could not get a 2D canvas context');
        ctx.drawImage(bitmap, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
    } finally {
        bitmap.close();
    }
}

export function imageDataToCanvas(image: ImageData): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')!.putImageData(image, 0, 0);
    return canvas;
}

/** Encode to JPEG. Quality 0.82 keeps handwriting crisp at ~150-300 KB. */
export function imageDataToBlob(image: ImageData, quality = 0.82): Promise<Blob> {
    return new Promise((resolve, reject) => {
        imageDataToCanvas(image).toBlob(
            blob => (blob ? resolve(blob) : reject(new Error('Failed to encode the scanned image'))),
            'image/jpeg',
            quality,
        );
    });
}

/** The whole pipeline: photo + corners + mode -> an upload-ready JPEG. */
export async function scanToBlob(source: ImageData, quad: Quad, mode: ScanMode): Promise<Blob> {
    return imageDataToBlob(finishForMode(warpQuad(source, quad), mode));
}
