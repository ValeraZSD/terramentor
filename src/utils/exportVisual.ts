/**
 * Save a visual as a file: an animated SVG as a GIF, a static drawing as a
 * PNG — plain, or framed as a card with a title and a caption.
 *
 * THE ANIMATION TRICK. A browser will not rasterize a live, animated SVG
 * element, and an SVG loaded into an <img> runs its own clock from zero — so
 * "the frame at t = 3.2s" cannot be asked for directly. But SMIL allows a
 * NEGATIVE begin: an animation that began 3.2 seconds before the document
 * started is, at the document's time zero, exactly where it would be at 3.2s.
 * So each frame is its own document — the scene with every `begin` shifted by
 * -t — drawn to a canvas the instant it loads. No renderer knowledge, no
 * replaying the SMIL semantics by hand (the values/keyTimes/keySplines/mpath
 * arithmetic is the browser's, as it should be), and every frame is the
 * picture the reader actually saw.
 *
 * The GIF is encoded in the page with `gifenc` (MIT, ~10 KB): one palette is
 * quantised from a few frames spread over the loop and applied to all of
 * them, so the colours do not shimmer frame to frame the way per-frame
 * palettes do. Work is yielded between frames so the dialog's progress bar
 * moves and the tab stays responsive.
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { toPlainText } from './plainMath';
import { animationLoopSeconds, parseViewBox } from '../components/visuals/svgLabelFit';
import { loadSvgImage, pictureSize, svgDocumentAtTime } from '../components/visuals/svgFrames';

// The frame helpers live in svgFrames.ts (the animation renderer's motion
// probe needs them without the encoder); re-exported so callers and the gate
// suite keep one import path.
export { svgDocumentAtTime, pictureSize, previewFrame } from '../components/visuals/svgFrames';

export interface CardText { title: string; caption: string }

export interface ExportPalette { bg: string; fg: string; muted: string; border: string }

export interface ExportOptions {
    /** Output width in pixels of the PICTURE (the card adds its own margins). */
    width: number;
    /** Frame the picture with a title and caption. */
    card?: CardText | null;
    palette: ExportPalette;
    fps?: number;
    /** Seconds of animation to capture; defaults to one loop of the scene. */
    seconds?: number;
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
}

/* ── card layout ─────────────────────────────────────────────────────────── */

const CARD_PAD = 32;
const CARD_GAP = 18;
const TITLE_SIZE = 22;
const CAPTION_SIZE = 15;
const CAPTION_LINE = 1.45;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Greedy word wrap against a measuring function. Pure, so it is assertable. */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
    const out: string[] = [];
    for (const para of String(text || '').split(/\r?\n/)) {
        const words = para.trim().split(/\s+/).filter(Boolean);
        if (!words.length) continue;
        let line = '';
        for (const w of words) {
            const trial = line ? `${line} ${w}` : w;
            if (measure(trial) <= maxWidth || !line) line = trial;
            else { out.push(line); line = w; }
        }
        if (line) out.push(line);
    }
    return out;
}

export interface CardLayout {
    width: number;
    height: number;
    picture: { x: number; y: number; w: number; h: number };
    titleLines: string[];
    captionLines: string[];
}

/**
 * Where everything goes on the card, for a picture of `pw`×`ph`. The picture
 * keeps its own width; the card wraps it in margins, a title above and a
 * caption below, each wrapped to the picture's width.
 */
export function layoutCard(pw: number, ph: number, text: CardText, measure: (s: string, px: number, bold: boolean) => number): CardLayout {
    const width = pw + CARD_PAD * 2;
    // A canvas cannot run KaTeX, so a formula in the drafted caption would be
    // printed as its own source. Flatten it to plain Unicode instead.
    const titleLines = wrapLines(toPlainText(text.title), pw, s => measure(s, TITLE_SIZE, true)).slice(0, 2);
    const captionLines = wrapLines(toPlainText(text.caption), pw, s => measure(s, CAPTION_SIZE, false)).slice(0, 6);
    let y = CARD_PAD;
    if (titleLines.length) y += titleLines.length * Math.round(TITLE_SIZE * 1.25) + CARD_GAP;
    const picture = { x: CARD_PAD, y, w: pw, h: ph };
    y += ph;
    if (captionLines.length) y += CARD_GAP + captionLines.length * Math.round(CAPTION_SIZE * CAPTION_LINE);
    return { width, height: y + CARD_PAD, picture, titleLines, captionLines };
}

function paintCard(ctx: CanvasRenderingContext2D, layout: CardLayout, palette: ExportPalette, picture: CanvasImageSource) {
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, layout.width, layout.height);
    ctx.textBaseline = 'top';
    let y = CARD_PAD;
    if (layout.titleLines.length) {
        ctx.fillStyle = palette.fg;
        ctx.font = `600 ${TITLE_SIZE}px ${FONT}`;
        for (const line of layout.titleLines) {
            ctx.fillText(line, CARD_PAD, y);
            y += Math.round(TITLE_SIZE * 1.25);
        }
        // A hairline between the title and the picture, the width of the picture.
        ctx.fillStyle = palette.border;
        ctx.fillRect(CARD_PAD, y + Math.round(CARD_GAP / 2) - 1, layout.picture.w, 1);
    }
    const p = layout.picture;
    ctx.drawImage(picture, p.x, p.y, p.w, p.h);
    if (layout.captionLines.length) {
        y = p.y + p.h + CARD_GAP;
        ctx.fillStyle = palette.muted;
        ctx.font = `400 ${CAPTION_SIZE}px ${FONT}`;
        for (const line of layout.captionLines) {
            ctx.fillText(line, CARD_PAD, y);
            y += Math.round(CAPTION_SIZE * CAPTION_LINE);
        }
    }
}

function textMeasurer(ctx: CanvasRenderingContext2D) {
    return (s: string, px: number, bold: boolean) => {
        ctx.font = `${bold ? 600 : 400} ${px}px ${FONT}`;
        return ctx.measureText(s).width;
    };
}

/* ── frames ──────────────────────────────────────────────────────────────── */

function yieldToUi(): Promise<void> {
    return new Promise(r => setTimeout(r, 0));
}

function subsample(data: Uint8ClampedArray, step: number): Uint8ClampedArray {
    if (step <= 1) return data;
    const out = new Uint8ClampedArray(Math.ceil(data.length / 4 / step) * 4);
    let j = 0;
    for (let i = 0; i < data.length; i += 4 * step) {
        out[j++] = data[i]; out[j++] = data[i + 1]; out[j++] = data[i + 2]; out[j++] = 255;
    }
    return out;
}

/** Default frame rate for a saved animation. 12 fps read as a flip-book. */
export const DEFAULT_GIF_FPS = 30;

/** The whole-centisecond delay a GIF can store for this frame rate (2 cs is the floor browsers honour). */
export function gifDelayCs(fps: number): number {
    return Math.max(2, Math.round(100 / Math.max(4, Math.min(50, fps))));
}

/** Frames one loop of `seconds` takes at the delay `fps` rounds to. */
export function gifFrameCount(seconds: number, fps: number = DEFAULT_GIF_FPS): number {
    return Math.max(2, Math.round((seconds * 100) / gifDelayCs(fps)));
}

/**
 * Encode the animation as a GIF. Returns the bytes as a Blob.
 */
export async function exportAnimationGif(svg: SVGSVGElement, opts: ExportOptions): Promise<Blob> {
    // A GIF frame delay is stored in whole centiseconds, so the frame rate is
    // really 100/delayCs: 30 fps asks for 3.33 cs and lands on 3 cs (33 fps).
    // Deriving the frame COUNT from the delay actually written keeps one loop
    // exactly as long as the animation's own loop, whatever fps rounded to.
    const delayCs = gifDelayCs(opts.fps ?? DEFAULT_GIF_FPS);
    const delay = delayCs * 10;
    const seconds = Math.max(0.5, Math.min(15, opts.seconds ?? animationLoopSeconds(svg)));
    const frames = Math.max(2, Math.round((seconds * 1000) / delay));
    const { w: pw, h: ph } = pictureSize(svg, opts.width);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2D canvas available.');
    const layout = opts.card
        ? layoutCard(pw, ph, opts.card, textMeasurer(ctx))
        : { width: pw, height: ph, picture: { x: 0, y: 0, w: pw, h: ph }, titleLines: [], captionLines: [] };
    canvas.width = layout.width;
    canvas.height = layout.height;

    const renderFrame = async (i: number): Promise<Uint8ClampedArray> => {
        const t = (i / frames) * seconds;
        const img = await loadSvgImage(svgDocumentAtTime(svg, t, pw, ph));
        // Draw the instant it loads: the image's own clock starts at first paint.
        if (opts.card) paintCard(ctx, layout, opts.palette, img);
        else {
            ctx.fillStyle = opts.palette.bg;
            ctx.fillRect(0, 0, pw, ph);
            ctx.drawImage(img, 0, 0, pw, ph);
        }
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };

    // One palette for the whole file, learned from frames spread over the loop.
    const sampleAt = [0, Math.floor(frames / 3), Math.floor((2 * frames) / 3)];
    const samples: Uint8ClampedArray[] = [];
    for (const i of sampleAt) {
        if (opts.signal?.aborted) throw new Error('cancelled');
        samples.push(subsample(await renderFrame(i), 4));
    }
    const merged = new Uint8ClampedArray(samples.reduce((n, s) => n + s.length, 0));
    let off = 0;
    for (const s of samples) { merged.set(s, off); off += s.length; }
    const palette = quantize(merged, 256, { format: 'rgb444' });

    const gif = GIFEncoder();
    for (let i = 0; i < frames; i++) {
        if (opts.signal?.aborted) throw new Error('cancelled');
        const data = await renderFrame(i);
        const index = applyPalette(data, palette, 'rgb444');
        gif.writeFrame(index, canvas.width, canvas.height, { palette, delay, repeat: 0 });
        opts.onProgress?.(i + 1, frames);
        if (i % 3 === 2) await yieldToUi();
    }
    gif.finish();
    const bytes = gif.bytes();
    // A fresh ArrayBuffer copy: Blob's typing refuses a view over a possibly
    // shared buffer, and the encoder's view is over its own growable one.
    const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    out.set(bytes);
    return new Blob([out], { type: 'image/gif' });
}

/* ── still pictures ──────────────────────────────────────────────────────── */

/** The rasterizable thing a renderer left in its stage, if any. */
export function findExportable(container: Element | null): SVGSVGElement | HTMLCanvasElement | null {
    if (!container) return null;
    const svg = container.querySelector('svg');
    if (svg instanceof SVGSVGElement) return svg;
    const canvas = container.querySelector('canvas');
    return canvas instanceof HTMLCanvasElement ? canvas : null;
}

async function pictureOf(el: SVGSVGElement | HTMLCanvasElement, width: number): Promise<{ img: CanvasImageSource; w: number; h: number }> {
    if (el instanceof HTMLCanvasElement) {
        const w = Math.max(160, Math.round(width));
        const h = Math.max(60, Math.round((w * el.height) / Math.max(1, el.width)));
        return { img: el, w, h };
    }
    const rect = el.getBoundingClientRect();
    const vb = parseViewBox(el.getAttribute('viewBox'));
    const aspect = vb ? vb.h / vb.w : rect.width > 0 ? rect.height / rect.width : 0.6;
    const w = Math.max(160, Math.round(width));
    const h = Math.max(60, Math.round(w * aspect));
    const clone = el.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('viewBox') && rect.width > 0) clone.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    clone.removeAttribute('style');
    const img = await loadSvgImage(new XMLSerializer().serializeToString(clone));
    return { img, w, h };
}

/** A PNG of a static drawing (or the current frame of an animated one). */
export async function exportStillPng(el: SVGSVGElement | HTMLCanvasElement, opts: ExportOptions): Promise<Blob> {
    const { img, w, h } = await pictureOf(el, opts.width);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D canvas available.');
    // 2× for crisp type on a high-density screen; the card metrics stay in CSS px.
    const scale = 2;
    const layout = opts.card
        ? layoutCard(w, h, opts.card, textMeasurer(ctx))
        : { width: w, height: h, picture: { x: 0, y: 0, w, h }, titleLines: [], captionLines: [] };
    canvas.width = layout.width * scale;
    canvas.height = layout.height * scale;
    ctx.scale(scale, scale);
    if (opts.card) paintCard(ctx, layout, opts.palette, img);
    else {
        ctx.fillStyle = opts.palette.bg;
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
    }
    return new Promise((resolve, reject) => {
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the picture could not be encoded.'))), 'image/png');
    });
}

/**
 * Hand the file to the browser. The revoke is DEFERRED on purpose: a
 * synchronous revoke after click() cancels a slow-starting download silently
 * (the Anki export shipped that bug — "Deck exported" and no file).
 */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function fileSlug(title: string, fallback: string): string {
    const s = String(title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return s || fallback;
}

/** Title/caption drafted from a scene brief's own lines, with no model call. */
export function captionFromBrief(code: string): CardText | null {
    const shows = code.match(/^\s*shows\s*:\s*(.+)$/im)?.[1]?.trim();
    const notice = code.match(/^\s*notice\s*:\s*(.+)$/im)?.[1]?.trim();
    if (!shows && !notice) return null;
    const title = shows ? shows.replace(/[.;:,]+$/, '') : '';
    return { title: title.charAt(0).toUpperCase() + title.slice(1), caption: notice || '' };
}
