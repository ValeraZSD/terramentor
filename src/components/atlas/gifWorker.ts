/**
 * The GIF encoder, off the page's thread.
 *
 * Quantising and compressing a 854×480 frame is tens of milliseconds, and on
 * the main thread that is tens of milliseconds the replay being filmed does not
 * get — a stutter that would land in the file. The page only reads the pixels
 * and hands the buffer over (transferred, not copied).
 */
import { GifStream, createGifStream } from './gifStream';

let stream: GifStream | null = null;
const post = (msg: unknown, transfer: Transferable[] = []) =>
    (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent) => {
    const m = e.data;
    try {
        if (m.type === 'start') stream = createGifStream(m.width, m.height);
        else if (m.type === 'frame') stream?.push(new Uint8ClampedArray(m.buffer), m.delayMs);
        else if (m.type === 'finish') {
            const bytes = stream ? stream.finish() : new Uint8Array(0);
            stream = null;
            post({ type: 'done', bytes }, [bytes.buffer]);
        }
    } catch (err: any) {
        stream = null;
        post({ type: 'error', message: err?.message || String(err) });
    }
};
