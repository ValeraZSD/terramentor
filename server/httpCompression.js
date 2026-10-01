// Compression — the app was sending everything it knows uncompressed.
//
// Measured on the real library (2026-09-09, before this existed): `/api/atlas`
// 677 KB, `/api/projects` 333 KB, `/api/ai/status` 42 KB, and the built bundle
// 962 KB of JavaScript, all in plain bytes. On loopback that is invisible; over
// `tailscale serve` to a phone it is the whole wait, and even locally it is
// hundreds of kilobytes of parse the browser did not have to do.
//
// Two halves, because the two kinds of body want opposite things:
//
//   `compressJson` — RUNTIME bodies. Every large answer goes out through
//   `res.json`, so wrapping that one method covers them all without patching
//   the write/end stream pair (which is where a hand-rolled compressor breaks
//   SSE). Gzip, not brotli: a fresh answer is compressed on the request's own
//   clock, and gzip at the default level is several times faster for a ratio
//   within a few percent on JSON.
//
//   `precompressedStatic` — BUILT files. Those never change between requests,
//   so they are compressed once at build time (`tools/precompress.mjs`, run by
//   the Vite build) and this only picks the right file. Brotli is worth it
//   there: the cost is paid once, by the build.
//
// Both set `Vary: Accept-Encoding` whether or not they compress — a response
// that varies by encoding and does not say so is what poisons a shared cache.
// Neither ever touches a body that already carries a `Content-Encoding`.

import { gzip } from 'node:zlib';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

/** Below this, the gzip header costs more than the saving. */
const MIN_COMPRESS_BYTES = 1024;

/** Which encodings the caller will take, best first. `br` only where a file for
 *  it already exists on disk; nothing here compresses with brotli live. */
function acceptedEncodings(req) {
    const header = String(req.headers['accept-encoding'] || '').toLowerCase();
    if (!header) return [];
    // Deliberately not q-value aware: the only clients that send q-values here
    // send them to express a preference between two encodings we both support,
    // and picking the stronger one is the right answer either way.
    return header.split(',').map((s) => s.trim().split(';')[0]).filter(Boolean);
}

/**
 * Gzip every JSON answer over the threshold.
 *
 * Wraps `res.json` rather than the response stream: `res.json` is where every
 * large body in this server is produced, and leaving `write`/`end` alone means
 * the SSE endpoints — which never call `res.json` — cannot be affected at all.
 */
export function compressJson() {
    return function compressJsonMiddleware(req, res, next) {
        const original = res.json.bind(res);
        res.json = (body) => {
            // Already streaming (an SSE handler reporting a late failure), or
            // nothing to serialise: both are express's own business.
            if (res.headersSent || body === undefined) return original(body);
            res.vary('Accept-Encoding');
            let text;
            try {
                text = JSON.stringify(body);
            } catch {
                return original(body);      // circular / BigInt: let express report it
            }
            const raw = Buffer.from(text ?? 'null', 'utf8');
            const wants = acceptedEncodings(req).includes('gzip');
            if (!wants || raw.length < MIN_COMPRESS_BYTES || res.getHeader('Content-Encoding')) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return res.send(raw);
            }
            gzip(raw, (err, packed) => {
                if (res.writableEnded) return;
                if (err || !packed) {
                    // Compression is an optimisation; a failure sends the answer.
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.send(raw);
                    return;
                }
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Content-Encoding', 'gzip');
                res.removeHeader('Content-Length');
                res.send(packed);
            });
            return res;
        };
        next();
    };
}

/** Content types by extension, for the pre-compressed files below. Small and
 *  explicit: only the extensions `tools/precompress.mjs` actually produces. */
const TYPES = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
};

/**
 * Serve `foo.js.br` / `foo.js.gz` when the caller accepts it and the build
 * produced one. Falls through to the ordinary static handler otherwise, so a
 * checkout that has never run the precompress step behaves exactly as before.
 */
export function precompressedStatic(distDir) {
    const root = normalize(distDir + sep);
    return function precompressedMiddleware(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const ext = extname(req.path);
        const type = TYPES[ext];
        if (!type) return next();

        // Resolve inside dist or not at all: `req.path` is attacker-shaped input
        // and `..` in it must not reach a file beside the build.
        const target = normalize(join(distDir, decodeURIComponent(req.path)));
        if (!target.startsWith(root)) return next();

        const accepted = acceptedEncodings(req);
        const candidate = accepted.includes('br') && existsSync(`${target}.br`) ? { path: `${target}.br`, encoding: 'br' }
            : accepted.includes('gzip') && existsSync(`${target}.gz`) ? { path: `${target}.gz`, encoding: 'gzip' }
                : null;
        res.vary('Accept-Encoding');
        if (!candidate) return next();

        // The hashed bundles are immutable; index.html and the worker must be
        // revalidated on every load or a rebuild is invisible. Same rule as the
        // plain static handler this stands in front of — stated twice because
        // this branch never reaches it.
        res.setHeader('Cache-Control', req.path.includes('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache');
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Encoding', candidate.encoding);
        // A weak ETag over the compressed file's own identity. Weak because it
        // describes the encoded bytes, not the resource.
        try {
            const st = statSync(candidate.path);
            res.setHeader('ETag', `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`);
        } catch { /* raced with a rebuild: send it without an ETag */ }
        return res.sendFile(candidate.path, (err) => {
            if (err && !res.headersSent) next(err);
        });
    };
}
