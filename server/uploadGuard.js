/**
 * The aggregate cap on a multipart upload, checked before multer reads a byte.
 *
 * Multipart bodies are buffered in memory and multer's caps are PER FILE —
 * `files: 100` × a 25 MB file cap is 2.5 GB of buffers if they all land at
 * once. `Content-Length` is what bounds the whole body, so a request is judged
 * on it: over the cap is refused with 413, and a body that carries no usable
 * length at all (a chunked upload) is refused with 411 rather than let through
 * on the per-file caps alone, because that is the one shape the aggregate
 * check cannot see. Browsers always send `Content-Length` on a file upload, so
 * no supported client meets the 411; a scripted client that streams gets told
 * what to send.
 */
export function rejectOversizedBody(capBytes) {
    const capMb = Math.round(capBytes / (1024 * 1024));
    return (req, res, next) => {
        const raw = req.headers['content-length'];
        const len = raw === undefined ? NaN : Number(raw);
        if (!Number.isFinite(len) || len < 0) {
            return res.status(411).json({ error: 'Upload needs a Content-Length header — a chunked body is not accepted' });
        }
        if (len > capBytes) {
            return res.status(413).json({ error: `Upload too large — the limit is ${capMb} MB` });
        }
        next();
    };
}
