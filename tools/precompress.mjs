/**
 * Write a `.br` and a `.gz` twin beside every compressible file in `dist/`.
 *
 * No shebang, unlike the other tools here: `vite.config.ts` imports this module,
 * so esbuild parses it as part of loading the config, and a `#!` line on 1:1 is
 * a syntax error there.
 *
 *   node tools/precompress.mjs [dist-dir]
 *
 * Run by the Vite build (see `tools/vite-plugin-compress.mjs`), and standalone
 * here so a hand-built or unpacked copy can be given the same treatment.
 *
 * Why at build time rather than per request: these files never change between
 * requests, so compressing them live burns CPU on every phone that opens the
 * app to produce identical bytes. Brotli at a high quality is affordable once
 * and is worth 15-20% over gzip on JavaScript. `server/httpCompression.js`
 * picks whichever twin the caller accepts, and falls through to the plain file
 * when neither exists — so skipping this step costs speed, never correctness.
 *
 * Files under the threshold are skipped: a compressed copy that is not smaller
 * is a file the server would have to stat forever for no reason.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.webmanifest']);
const MIN_BYTES = 1024;

// Not the maximum settings, on purpose — this runs inside `npm run build`, and
// the build is something a person waits for. Measured over this dist (9.0 MB
// across 99 files, 2026-09-09): brotli quality 11 + gzip 9 took 22 s and got to
// 2222 kB; quality 6 + gzip 6 takes ~2 s and gets to 2333 kB. Five percent of a
// download nobody is watching, for twenty seconds of a build somebody is.
const BROTLI_QUALITY = 6;
const GZIP_LEVEL = 6;

function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else if (entry.isFile()) yield full;
    }
}

export function precompress(distDir) {
    let files = 0;
    let raw = 0;
    let br = 0;
    for (const file of walk(distDir)) {
        if (!COMPRESSIBLE.has(extname(file))) continue;
        const bytes = readFileSync(file);
        if (bytes.length < MIN_BYTES) continue;
        const gz = gzipSync(bytes, { level: GZIP_LEVEL });
        const brotli = brotliCompressSync(bytes, {
            params: {
                [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
                [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
            },
        });
        // Only keep a twin that actually saves something — an already-packed
        // asset (a woff2, a png inlined as base64) can come out bigger.
        if (gz.length < bytes.length) writeFileSync(`${file}.gz`, gz);
        if (brotli.length < bytes.length) writeFileSync(`${file}.br`, brotli);
        files += 1;
        raw += bytes.length;
        br += Math.min(brotli.length, bytes.length);
    }
    return { files, raw, br };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
    const dist = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
    try {
        statSync(dist);
    } catch {
        console.error(`No such directory: ${dist}`);
        process.exit(2);
    }
    const { files, raw, br } = precompress(dist);
    const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
    console.log(`precompressed ${files} files — ${kb(raw)} → ${kb(br)} brotli`);
}
