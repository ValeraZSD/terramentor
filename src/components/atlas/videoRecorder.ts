/**
 * Turning a canvas into a file, with nothing but what the browser already has.
 *
 * No encoder is shipped and no server is asked: `canvas.captureStream()` plus
 * `MediaRecorder` is the whole of it, which is what keeps a local-first app
 * local-first — a render never leaves the machine, and there is no ffmpeg in
 * the image, no WASM blob in the bundle and no upload.
 *
 * The price is that the CONTAINER is the browser's choice rather than ours.
 * Chromium and Firefox write WebM (VP9 if they can, VP8 if they cannot); Safari
 * writes MP4. So the format is discovered rather than assumed, the extension
 * follows the mime type it actually got, and a browser that can do neither is
 * told so before the reader picks an aspect ratio — not after watching a
 * replay for a minute.
 */

export interface VideoFormat {
    mimeType: string;
    /** …and the extension that mime type must be saved under. */
    extension: string;
    /** What to call it in a sentence to a reader. */
    label: string;
}

/**
 * In preference order. VP9 before VP8 because it is half the size at the same
 * quality for a picture that is mostly flat colour, which is exactly what this
 * map is; MP4 last because only Safari offers it, and where it does it is the
 * only thing on the list that works.
 */
const CANDIDATES: VideoFormat[] = [
    { mimeType: 'video/webm;codecs=vp9', extension: 'webm', label: 'WebM' },
    { mimeType: 'video/webm;codecs=vp8', extension: 'webm', label: 'WebM' },
    { mimeType: 'video/webm', extension: 'webm', label: 'WebM' },
    { mimeType: 'video/mp4', extension: 'mp4', label: 'MP4' },
];

/** What this browser will write, or null if it will not write video at all. */
export function pickVideoFormat(): VideoFormat | null {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const f of CANDIDATES) {
        try {
            if (MediaRecorder.isTypeSupported(f.mimeType)) return f;
        } catch { /* a browser that throws on the question cannot answer it */ }
    }
    return null;
}

/** …and whether a canvas here can be filmed at all. */
export function canRenderVideo(): boolean {
    return typeof HTMLCanvasElement !== 'undefined'
        && typeof HTMLCanvasElement.prototype.captureStream === 'function'
        && pickVideoFormat() !== null;
}

/**
 * How many bits a second to spend.
 *
 * Derived from the frame rather than fixed, because the same constant that is
 * generous for a 720×720 square starves a 1920×1080 pan. The floor matters more
 * than the ceiling here: this picture is large areas of flat colour with thin
 * bright lines over them, and a starved encoder does not blur it evenly — it
 * eats the one-pixel journey line, which is the subject.
 */
const bitrateFor = (width: number, height: number, fps: number) =>
    Math.round(Math.max(2e6, Math.min(24e6, width * height * fps * 0.1)));

export interface Recording {
    blob: Blob;
    format: VideoFormat;
    /** How long it actually ran, in ms — wall clock, which is what was filmed. */
    durationMs: number;
}

export interface CanvasRecorder {
    /** Stop, flush, and hand back the file. */
    stop: () => Promise<Recording>;
    /** Throw it away — a cancelled render leaves no blob to revoke. */
    cancel: () => void;
}

/**
 * Film a canvas until someone says stop.
 *
 * Frames are PULLED, not pushed: the stream is opened at rate 0 and this owns
 * the clock, asking for one frame every `1000/fps` ms. The alternative —
 * `captureStream(fps)` — samples whenever the canvas is painted, and both atlas
 * surfaces draw ON DEMAND: they stop entirely once the camera has settled and
 * the arrow has landed. A replay's landings, its end hold and its pull-out are
 * all stretches where nothing is redrawn, and a stream that only samples on
 * paint records them as nothing at all. Pulling means a still second of a
 * replay is a still second of video.
 *
 * `requestFrame` is not everywhere, so a browser without it gets the push model
 * and a slightly loose frame rate rather than no render.
 */
export function recordCanvas(
    canvas: HTMLCanvasElement, fps: number, format: VideoFormat,
): CanvasRecorder {
    const stream = (canvas as any).captureStream(0) as MediaStream;
    const track = stream.getVideoTracks()[0] as any;
    const pulls = typeof track?.requestFrame === 'function';
    const pushStream = pulls ? null : (canvas as any).captureStream(fps) as MediaStream;
    const live = pushStream ?? stream;

    const recorder = new MediaRecorder(live, {
        mimeType: format.mimeType,
        videoBitsPerSecond: bitrateFor(canvas.width, canvas.height, fps),
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

    const startedAt = performance.now();
    let raf = 0;
    let lastPull = 0;
    // A pull is only answered for a canvas painted since the track last looked
    // at it: a film that OPENS on a still shot (painted before the recorder was
    // made) came out with its whole opening missing — the first frame in the
    // file was the first thing that moved. So the canvas is marked painted
    // before every pull, with a stroke that changes no pixel.
    const ctx2d = canvas.getContext('2d');
    const touch = () => {
        if (!ctx2d) return;
        ctx2d.save();
        ctx2d.setTransform(1, 0, 0, 1, 0, 0);
        ctx2d.globalAlpha = 0;
        ctx2d.fillRect(0, 0, 1, 1);
        ctx2d.restore();
    };
    if (pulls) {
        const period = 1000 / fps;
        const tick = (now: number) => {
            raf = requestAnimationFrame(tick);
            // Never more often than the reader asked for, and never a burst to
            // catch up: a frame the encoder is handed twice in 4ms is a frame
            // that costs bitrate and buys nothing.
            if (now - lastPull < period - 1) return;
            lastPull = now;
            touch();
            try { track.requestFrame(); } catch { /* the track has gone */ }
        };
        raf = requestAnimationFrame(tick);
    }

    // A timeslice, so a long render is not one enormous buffer held to the end
    // — and so a browser that drops the tab still has most of the file.
    recorder.start(500);

    const shutdown = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        for (const t of live.getTracks()) t.stop();
        if (pushStream) for (const t of stream.getTracks()) t.stop();
    };

    return {
        stop: () => new Promise<Recording>((resolve, reject) => {
            if (recorder.state === 'inactive') {
                shutdown();
                reject(new Error('The recorder stopped on its own.'));
                return;
            }
            recorder.onstop = () => {
                shutdown();
                resolve({
                    blob: new Blob(chunks, { type: format.mimeType }),
                    format,
                    durationMs: performance.now() - startedAt,
                });
            };
            recorder.onerror = (e: any) => {
                shutdown();
                reject(e?.error || new Error('The recording failed.'));
            };
            recorder.stop();
        }),
        cancel: () => {
            try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* already gone */ }
            shutdown();
            chunks.length = 0;
        },
    };
}

/**
 * The one format this app encodes itself: a GIF plays inline everywhere a video
 * does not — a README, a chat, a slide — and needs no player.
 */
export const GIF_FORMAT: VideoFormat = { mimeType: 'image/gif', extension: 'gif', label: 'GIF' };

/** …which needs a canvas that can be read and a worker to encode on. */
export function canRenderGif(): boolean {
    return typeof HTMLCanvasElement !== 'undefined' && typeof Worker !== 'undefined';
}

/**
 * Film a canvas into a GIF, with the same pulled clock as `recordCanvas`.
 *
 * Each frame is copied off the canvas and transferred to the encoder worker
 * (`gifWorker.ts`); its delay is the REAL time until the next frame was taken,
 * which is why a frame is held back one tick before it is sent — a frame the
 * browser was late to paint shows for as long as it really stood, so the GIF
 * runs at the replay's speed even when it did not get every frame it asked for.
 */
export function recordCanvasGif(canvas: HTMLCanvasElement, fps: number): CanvasRecorder {
    const { width, height } = canvas;
    const worker = new Worker(new URL('./gifWorker.ts', import.meta.url), { type: 'module' });
    worker.postMessage({ type: 'start', width, height });
    // A scratch surface to read from: `getImageData` on the map's own context
    // would turn it into a CPU-backed canvas for the rest of its life.
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!;

    // Listening from the start: an encoder that fails mid-film says so then,
    // and a message nobody is listening for is dropped, not queued.
    let failed: string | null = null;
    let finished: ((bytes: Uint8Array) => void) | null = null;
    worker.onmessage = (e: MessageEvent) => {
        if (e.data?.type === 'error') failed = e.data.message || 'The GIF could not be written.';
        else if (e.data?.type === 'done') finished?.(e.data.bytes);
    };
    worker.onerror = (e) => { failed = e.message || 'The GIF encoder did not start.'; };

    const startedAt = performance.now();
    const period = 1000 / fps;
    let held: { buffer: ArrayBuffer; at: number } | null = null;
    let raf = 0;
    let lastPull = -Infinity;

    const send = (now: number) => {
        if (!held) return;
        worker.postMessage(
            { type: 'frame', buffer: held.buffer, delayMs: Math.max(20, now - held.at) },
            [held.buffer],
        );
        held = null;
    };
    const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        if (now - lastPull < period - 1) return;
        lastPull = now;
        sctx.drawImage(canvas, 0, 0);
        const { data } = sctx.getImageData(0, 0, width, height);
        send(now);
        held = { buffer: data.buffer as ArrayBuffer, at: now };
    };
    raf = requestAnimationFrame(tick);

    const shutdown = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    };

    return {
        stop: () => new Promise<Recording>((resolve, reject) => {
            shutdown();
            send(performance.now());
            if (failed) {
                worker.terminate();
                reject(new Error(failed));
                return;
            }
            finished = (bytes) => {
                worker.terminate();
                if (failed || !bytes.length) {
                    reject(new Error(failed || 'The GIF could not be written.'));
                    return;
                }
                resolve({
                    blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: GIF_FORMAT.mimeType }),
                    format: GIF_FORMAT,
                    durationMs: performance.now() - startedAt,
                });
            };
            worker.onerror = (e) => {
                worker.terminate();
                reject(new Error(e.message || 'The GIF could not be written.'));
            };
            worker.postMessage({ type: 'finish' });
        }),
        cancel: () => {
            shutdown();
            held = null;
            worker.terminate();
        },
    };
}

/**
 * A filename someone will still recognise in their downloads folder in a month:
 * the course, then the date. Everything a filesystem might object to is a
 * hyphen, and a title of nothing still produces a name.
 */
export function videoFileName(courseName: string, format: VideoFormat): string {
    const stem = courseName
        .normalize('NFC')
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    const day = new Date().toISOString().slice(0, 10);
    return `${stem || 'atlas'}-${day}.${format.extension}`;
}
