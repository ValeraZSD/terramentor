// Emit the service worker as a BUILD ARTEFACT, not a static file.
//
// `public/sw.js` used to be copied verbatim, which meant every build shipped
// byte-identical worker source. A browser decides "is there a new worker?" by
// comparing those bytes — so there never was one, the update prompt could not
// fire, and the single fixed cache name accumulated every build's assets with
// nothing to tell them apart. See the long note at the top of
// `src/sw-template.js` for what that did to a slow launch.
//
// This stamps two things into the template:
//   __BUILD__     a hash of the emitted file names. Deterministic, so rebuilding
//                 unchanged sources produces an identical worker and browsers
//                 correctly see no update; and it moves whenever any hashed
//                 asset does, which is exactly when the cache must be replaced.
//   __PRECACHE__  the shell this build needs before it can paint.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(root, 'src', 'sw-template.js');

/** The entry chunk and everything it imports up front, plus the stylesheets:
 *  what the browser must already have to paint offline. Lazy route chunks are
 *  deliberately not here — they are cached the first time they are opened. */
function shellFiles(bundle) {
    const out = new Set(['/']);
    const seen = new Set();
    const walk = (fileName) => {
        if (seen.has(fileName)) return;
        seen.add(fileName);
        const chunk = bundle[fileName];
        if (!chunk || chunk.type !== 'chunk') return;
        out.add('/' + fileName);
        for (const css of chunk.viteMetadata?.importedCss ?? []) out.add('/' + css);
        for (const imported of chunk.imports ?? []) walk(imported);
    };
    for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) walk(fileName);
    }
    return [...out];
}

export function serviceWorkerPlugin() {
    return {
        name: 'terramentor-service-worker',
        apply: 'build',
        generateBundle(_options, bundle) {
            const names = Object.keys(bundle).sort();
            const build = createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 12);
            const source = readFileSync(TEMPLATE, 'utf8')
                .replace('__BUILD__', build)
                .replace('__PRECACHE__', JSON.stringify(shellFiles(bundle)));
            this.emitFile({ type: 'asset', fileName: 'sw.js', source });
        },
    };
}
