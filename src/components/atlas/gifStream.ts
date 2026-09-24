import { GIFEncoder, Palette, applyPalette, quantize } from 'gifenc';

/**
 * A GIF written one frame at a time, while the replay is still running.
 *
 * A GIF has 256 colours and the whole film is not known until it ends, so the
 * usual answer — learn one palette from frames spread over the loop, as
 * `exportVisual.ts` does — needs every frame held in memory first: a 40-second
 * replay at 854×480 is ~700 MB of RGBA. Instead the palette is learned from the
 * FIRST frame, which is the opening shot: the whole course framed with its
 * whole route drawn, so every region colour, the line's ink and its halo are
 * already on it. A later frame that paints something the palette cannot carry
 * (the arrow's head, a lit region) triggers ONE re-learn over the opening
 * sample plus that frame, and from then on frames carry that palette as a local
 * table. Re-learning on every frame instead is what makes a GIF shimmer.
 *
 * Two savings that cost nothing to see:
 * - a frame identical to the one before is not written; the earlier frame's
 *   delay grows instead, so a landing or the end hold is one frame, not thirty;
 * - delays are carried to the centisecond GIF stores, with the remainder handed
 *   to the next frame, so a film of 66.7 ms frames does not drift by 7%.
 */
export interface GifStream {
    /** One frame of RGBA, and how long it stays on screen, in ms. */
    push: (rgba: Uint8ClampedArray, delayMs: number) => void;
    /** Write what is pending and close the file. */
    finish: () => Uint8Array;
    /** Frames actually written (after merging repeats) — for the gate. */
    readonly written: number;
    /** How many times the palette was re-learnt — for the gate. */
    readonly relearns: number;
}

/** Every Nth pixel is enough to judge a palette and to learn one. */
const SAMPLE_STEP = 7;
/** A pixel further than this (Euclidean, 0–255 per channel) from its colour is a miss. */
const MISS_DISTANCE = 28;
/** …and a frame with more than this share of misses needs a new palette. */
const MISS_SHARE = 0.002;
/** Frames to wait after a re-learn before judging again, so one bad frame cannot chain. */
const RELEARN_COOLDOWN = 20;
/** And never more than this many, however strange the film. */
const MAX_RELEARNS = 6;
/** Browsers draw anything shorter than 2 cs as 10 cs; never write one. */
const MIN_DELAY_CS = 2;

function subsample(rgba: Uint8ClampedArray, step: number): Uint8ClampedArray {
    const n = Math.floor(rgba.length / 4 / step);
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += step * 4) {
        out[i * 4] = rgba[j];
        out[i * 4 + 1] = rgba[j + 1];
        out[i * 4 + 2] = rgba[j + 2];
        out[i * 4 + 3] = 255;
    }
    return out;
}

function missShare(rgba: Uint8ClampedArray, index: Uint8Array, palette: Palette): number {
    const limit = MISS_DISTANCE * MISS_DISTANCE;
    let misses = 0;
    let seen = 0;
    for (let p = 0; p < index.length; p += SAMPLE_STEP) {
        const c = palette[index[p]];
        const o = p * 4;
        const dr = rgba[o] - c[0], dg = rgba[o + 1] - c[1], db = rgba[o + 2] - c[2];
        if (dr * dr + dg * dg + db * db > limit) misses++;
        seen++;
    }
    return seen ? misses / seen : 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function createGifStream(width: number, height: number): GifStream {
    const gif = GIFEncoder();
    let palette: Palette | null = null;
    let opening: Uint8ClampedArray | null = null;
    // Once the palette has moved off the one in the header, every frame must
    // name its own; before that, none need to.
    let local = false;
    let cooldown = 0;
    let relearns = 0;
    let written = 0;
    let carryMs = 0;
    let pending: { index: Uint8Array; palette: Palette; local: boolean; delayMs: number } | null = null;

    const flush = () => {
        if (!pending) return;
        const exact = pending.delayMs + carryMs;
        const cs = Math.max(MIN_DELAY_CS, Math.round(exact / 10));
        carryMs = exact - cs * 10;
        gif.writeFrame(pending.index, width, height, {
            palette: written === 0 || pending.local ? pending.palette : undefined,
            delay: cs * 10,
            repeat: 0,
        });
        written++;
        pending = null;
    };

    return {
        push(rgba, delayMs) {
            if (!palette) {
                palette = quantize(rgba, 256, { format: 'rgb444' });
                opening = subsample(rgba, SAMPLE_STEP);
            }
            let index = applyPalette(rgba, palette!, 'rgb444');
            if (cooldown > 0) cooldown--;
            else if (relearns < MAX_RELEARNS && missShare(rgba, index, palette!) > MISS_SHARE) {
                const now = subsample(rgba, SAMPLE_STEP);
                const merged = new Uint8ClampedArray(opening!.length + now.length);
                merged.set(opening!, 0);
                merged.set(now, opening!.length);
                palette = quantize(merged, 256, { format: 'rgb444' });
                index = applyPalette(rgba, palette!, 'rgb444');
                local = true;
                relearns++;
                cooldown = RELEARN_COOLDOWN;
            }
            if (pending && pending.palette === palette && sameBytes(pending.index, index)) {
                pending.delayMs += delayMs;
                return;
            }
            flush();
            pending = { index, palette: palette!, local, delayMs };
        },
        finish() {
            flush();
            gif.finish();
            return gif.bytes();
        },
        get written() { return written; },
        get relearns() { return relearns; },
    };
}
