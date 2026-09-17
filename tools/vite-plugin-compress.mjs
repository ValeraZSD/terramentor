// Run `tools/precompress.mjs` over the finished build.
//
// `closeBundle`, not `writeBundle`: the service worker is emitted by another
// plugin and the public/ directory is copied late, and both must be on disk
// before anything walks the tree.

import { resolve } from 'node:path';
import { precompress } from './precompress.mjs';

export function compressPlugin() {
    let outDir = 'dist';
    return {
        name: 'terramentor-precompress',
        apply: 'build',
        enforce: 'post',
        configResolved(config) {
            outDir = resolve(config.root, config.build.outDir);
        },
        closeBundle() {
            try {
                const { files, raw, br } = precompress(outDir);
                const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
                console.log(`precompressed ${files} files — ${kb(raw)} → ${kb(br)} brotli`);
            } catch (err) {
                // Never fail a build over an optimisation: the server serves the
                // plain files when a twin is missing.
                console.warn(`precompress skipped: ${err.message}`);
            }
        },
    };
}
