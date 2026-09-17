/**
 * Frames of an animated SVG, as still pictures.
 *
 * A browser will not rasterize a live, animated SVG element, and an SVG
 * loaded into an <img> runs its own clock from zero — so "the frame at
 * t = 3.2s" cannot be asked for directly. But SMIL allows a NEGATIVE begin:
 * an animation that began 3.2 seconds before the document started is, at the
 * document's time zero, exactly where it would be at 3.2s. So each frame is
 * its own document — the scene with every `begin` shifted by -t — drawn to a
 * canvas the instant it loads. The browser does the SMIL; nothing here
 * re-implements values/keyTimes/keySplines/mpath.
 *
 * Shared by the GIF export (src/utils/exportVisual.ts) and the animation
 * renderer's motion probe, which is why it carries no encoder.
 */
import { parseClockSeconds, parseViewBox } from './svgLabelFit';

/**
 * The scene as it stands `t` seconds into its loop, as a standalone SVG
 * document string. An `indefinite` or event/syncbase begin is left alone
 * (nothing here starts those, so the scene never shows them either).
 */
export function svgDocumentAtTime(svg: SVGSVGElement, t: number, width: number, height: number): string {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    for (const a of Array.from(clone.querySelectorAll('animate, animateTransform, animateMotion, set'))) {
        const raw = a.getAttribute('begin');
        const parts = String(raw ?? '0s').split(';').map(s => s.trim()).filter(Boolean);
        const shifted = parts.map(p => {
            const secs = parseClockSeconds(p);
            return secs == null ? p : `${(secs - t).toFixed(3)}s`;
        });
        a.setAttribute('begin', shifted.join('; ') || `${(-t).toFixed(3)}s`);
    }
    // The renderer's pause rule and its play/pause class have no place in a file.
    clone.classList.remove('vb-anim-paused');
    clone.removeAttribute('class');
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.removeAttribute('style');
    return new XMLSerializer().serializeToString(clone);
}

export function loadSvgImage(doc: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([doc], { type: 'image/svg+xml;charset=utf-8' }));
        const img = new Image();
        img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 0); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('the drawing could not be rasterized.')); };
        img.src = url;
    });
}

/** Pixel size of the picture for a requested width, from the viewBox's aspect. */
export function pictureSize(svg: SVGSVGElement, width: number): { w: number; h: number } {
    const vb = parseViewBox(svg.getAttribute('viewBox'));
    const aspect = vb ? vb.h / vb.w : 0.6;
    const w = Math.max(160, Math.round(width));
    return { w, h: Math.max(60, Math.round(w * aspect)) };
}

/** One frame of an animation as an image source, `t` seconds into the loop. */
export async function previewFrame(svg: SVGSVGElement, width: number, t = 0): Promise<{ img: HTMLImageElement; w: number; h: number }> {
    const { w, h } = pictureSize(svg, width);
    const img = await loadSvgImage(svgDocumentAtTime(svg, t, w, h));
    return { img, w, h };
}

/**
 * Does anything in this scene move at all?
 *
 * Samples a few instants of the loop at thumbnail size and compares the
 * pixels. A scene whose every frame is identical is not a subtle animation,
 * it is a broken one — every SMIL element in it is being ignored — and until
 * now that rendered as a perfectly good still picture with pause and replay
 * buttons under it. Returns null when the probe itself could not run (an
 * image that will not decode), so a probe failure never blocks a render.
 */
export async function probeMotion(svg: SVGSVGElement, loopSeconds: number): Promise<boolean | null> {
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        const { w, h } = pictureSize(svg, 160);
        canvas.width = w;
        canvas.height = h;
        let first: Uint8ClampedArray | null = null;
        for (const share of [0, 0.3, 0.55, 0.8]) {
            const img = await loadSvgImage(svgDocumentAtTime(svg, share * loopSeconds, w, h));
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            const data = ctx.getImageData(0, 0, w, h).data;
            if (!first) { first = data; continue; }
            for (let i = 0; i < data.length; i += 4) {
                if (Math.abs(data[i] - first[i]) + Math.abs(data[i + 1] - first[i + 1]) + Math.abs(data[i + 2] - first[i + 2]) + Math.abs(data[i + 3] - first[i + 3]) > 24) return true;
            }
        }
        return false;
    } catch {
        return null;
    }
}
