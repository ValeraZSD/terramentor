/**
 * Labels that run off the edge of an authored SVG.
 *
 * A model lays out an animation against a viewBox it cannot see rendered, and
 * the commonest way that goes wrong is a <text> whose x plus its glyphs lands
 * past the right edge — "v-t gra", "displacement (green, from releas", "sinks
 * wi" on real cards — or a legend row placed under the bottom edge. Nothing
 * throws: the browser clips at the viewBox and the reader sees a cut word.
 *
 * The rescue is deliberately the DUMBEST one that works: measure every label
 * where it actually lands (including the ones riding inside animated groups,
 * sampled at a few instants of the loop) and GROW the viewBox until they all
 * fit. Moving a label would put it on top of something; shrinking type would
 * make it unreadable; growing the frame costs a little margin and changes
 * nothing the author drew. Only <text> is measured — shapes are allowed, and
 * sometimes told, to extend past the frame (a wave extended one repeat past
 * each edge), so a union over everything would undo that on purpose.
 *
 * `fitViewBox` is the arithmetic and is asserted by tools/visual-author-gates.mjs;
 * `fitSvgLabels` is the DOM half (measurement needs a laid-out document).
 */

export interface Box { x: number; y: number; w: number; h: number }

export const LABEL_FIT_PAD = 6;
/** Growing the frame more than this is a broken scene, not a clipped label. */
export const LABEL_FIT_MAX_GROWTH = 0.6;

export function parseViewBox(raw: string | null | undefined): Box | null {
    const parts = String(raw || '').trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
    const [x, y, w, h] = parts;
    if (!(w > 0 && h > 0)) return null;
    return { x, y, w, h };
}

/**
 * The viewBox that contains `frame` and every box in `labels` (plus padding),
 * or null when nothing overflows. Refuses to grow past LABEL_FIT_MAX_GROWTH
 * on either axis: a label measured a whole frame away is a scene that is
 * broken in some other way, and doubling the canvas around it would only
 * shrink everything the reader could still see.
 */
export function fitViewBox(frame: Box, labels: Box[], pad = LABEL_FIT_PAD): Box | null {
    let x0 = frame.x, y0 = frame.y, x1 = frame.x + frame.w, y1 = frame.y + frame.h;
    let grew = false;
    for (const b of labels) {
        if (!(b.w > 0 && b.h > 0)) continue;
        if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) continue;
        const lx0 = b.x - pad, ly0 = b.y - pad, lx1 = b.x + b.w + pad, ly1 = b.y + b.h + pad;
        if (lx0 < x0) { x0 = lx0; grew = true; }
        if (ly0 < y0) { y0 = ly0; grew = true; }
        if (lx1 > x1) { x1 = lx1; grew = true; }
        if (ly1 > y1) { y1 = ly1; grew = true; }
    }
    if (!grew) return null;
    const w = x1 - x0, h = y1 - y0;
    if (w > frame.w * (1 + LABEL_FIT_MAX_GROWTH) || h > frame.h * (1 + LABEL_FIT_MAX_GROWTH)) return null;
    return { x: x0, y: y0, w, h };
}

/** Clock values SMIL accepts: "2s", "500ms", "1.5", "0:03". */
export function parseClockSeconds(raw: string | null | undefined): number | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    let m = s.match(/^([+-]?\d+(?:\.\d+)?)\s*(ms|s|min|h)?$/i);
    if (m) {
        const v = parseFloat(m[1]);
        const unit = (m[2] || 's').toLowerCase();
        return unit === 'ms' ? v / 1000 : unit === 'min' ? v * 60 : unit === 'h' ? v * 3600 : v;
    }
    m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    return null;
}

/**
 * How long one loop of the scene lasts: the longest (begin + dur) among its
 * SMIL animations, clamped to a sane band. Used to pick the sampling instants
 * here and the GIF length in exportVisual.ts.
 */
export function animationLoopSeconds(svg: Element, fallback = 4, max = 12): number {
    let longest = 0;
    for (const a of Array.from(svg.querySelectorAll('animate, animateTransform, animateMotion, set'))) {
        const dur = parseClockSeconds(a.getAttribute('dur'));
        if (dur == null || dur <= 0) continue;
        const begins = String(a.getAttribute('begin') || '0s').split(';')
            .map(b => parseClockSeconds(b)).filter((b): b is number => b != null && b >= 0);
        const begin = begins.length ? Math.max(...begins) : 0;
        longest = Math.max(longest, begin + dur);
    }
    if (!(longest > 0)) return fallback;
    return Math.min(max, Math.max(1, longest));
}

/** A <text>'s bounding box in the ROOT's user space, whatever groups it rides in. */
function labelBoxInRoot(root: SVGSVGElement, text: SVGGraphicsElement): Box | null {
    let bb: DOMRect;
    try { bb = text.getBBox(); } catch { return null; }
    if (!(bb.width > 0 && bb.height > 0)) return null;
    const toRoot = (() => {
        try {
            const rootCtm = root.getScreenCTM();
            const ctm = text.getScreenCTM();
            return rootCtm && ctm ? rootCtm.inverse().multiply(ctm) : null;
        } catch { return null; }
    })();
    if (!toRoot) return { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
    const corners = [
        [bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height],
    ].map(([x, y]) => {
        const p = new DOMPoint(x, y).matrixTransform(toRoot as DOMMatrixInit);
        return [p.x, p.y];
    });
    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Measure every label at a few instants of the loop and grow the viewBox to
 * hold them. Must be called on an svg that is IN the document and laid out
 * (getBBox on a detached or display:none element answers zeros). Returns the
 * new viewBox when it changed, else null. Restores the clock it paused.
 */
export function fitSvgLabels(svg: SVGSVGElement, samples = 5): Box | null {
    const frame = parseViewBox(svg.getAttribute('viewBox'));
    if (!frame) return null;
    const texts = Array.from(svg.querySelectorAll('text')) as SVGGraphicsElement[];
    if (!texts.length) return null;

    const animated = !!svg.querySelector('animate, animateTransform, animateMotion, set');
    const loop = animated ? animationLoopSeconds(svg) : 0;
    const wasPaused = animated ? svg.animationsPaused() : false;
    const t0 = animated ? svg.getCurrentTime() : 0;
    const boxes: Box[] = [];
    const measure = () => {
        for (const t of texts) {
            const b = labelBoxInRoot(svg, t);
            if (b) boxes.push(b);
        }
    };
    if (animated) {
        svg.pauseAnimations();
        for (let i = 0; i < samples; i++) {
            svg.setCurrentTime((loop * i) / samples);
            measure();
        }
        svg.setCurrentTime(t0);
        if (!wasPaused) svg.unpauseAnimations();
    } else {
        measure();
    }
    const next = fitViewBox(frame, boxes);
    if (!next) return null;
    const r = (n: number) => Math.round(n * 100) / 100;
    svg.setAttribute('viewBox', `${r(next.x)} ${r(next.y)} ${r(next.w)} ${r(next.h)}`);
    return next;
}
