// Stamp the build's own id into `index.html` as `<meta name="build-id">`.
//
// The page compares that id with what `GET /api/build` reports
// (`src/utils/freshness.ts`), and `server/buildId.js` reports the stamp it finds
// in the built file, so both sides read one value. `order: 'post'` runs after
// Vite has written the hashed script and stylesheet tags in, so the id covers
// every asset the document names.

import { stampBuildId } from '../server/buildId.js';

export function buildIdPlugin() {
    return {
        name: 'terramentor-build-id',
        apply: 'build',
        transformIndexHtml: { order: 'post', handler: (html) => stampBuildId(html) },
    };
}
