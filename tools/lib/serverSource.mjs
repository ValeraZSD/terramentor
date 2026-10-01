// The server's source, read the way the source-scanning gates need it.
//
// server/ is not flat: the HTTP routes live in server/routes/, one file per
// area, so a gate that lists `readdirSync('server')` scans none of them and
// passes on nothing. `serverFiles()` walks the whole tree; `httpLayer()` is the
// text of every file that builds the app or registers a route, for the scans
// that ask whether ANY route does something.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const SERVER_DIR = fileURLToPath(new URL('../../server/', import.meta.url));

// In a checkout, server/ is also the dev library's data folder: its database,
// its blob store, its logs, and the desktop launcher's browser profile, whose
// extensions are .js files by the hundred. None of it is code, and all of it is
// ignored by git, which is what decides here. The names below are the fallback
// for a copy with no git.
const NOT_CODE = new Set(['vault', 'logs', 'browser-profile', 'node_modules']);
const ignoredByGit = (dir) => spawnSync('git', ['check-ignore', '-q', dir], { cwd: SERVER_DIR }).status === 0;

/**
 * Every `.js` module under server/, as a path relative to it with `/` between
 * the parts: `'feed.js'`, `'routes/chat.js'`. Sorted, so a scan reports in the
 * same order on every machine.
 */
export function serverFiles(dir = SERVER_DIR, prefix = '') {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (!NOT_CODE.has(name) && !ignoredByGit(p)) out.push(...serverFiles(p, `${prefix}${name}/`));
        } else if (name.endsWith('.js')) out.push(`${prefix}${name}`);
    }
    return out.sort();
}

/** The text of one server module, by its path under server/ (`'routes/chat.js'`). */
export const readServer = (rel) => readFileSync(join(SERVER_DIR, rel), 'utf8');

/**
 * Several modules as one text, each opened by a `// ==== server/<path>` line, so
 * a slice taken between two anchors cannot run on into the next file unnoticed.
 */
export const readServerFiles = (...rels) =>
    rels.map((rel) => `// ==== server/${rel}\n${readServer(rel)}`).join('\n');

/** The files that build the app and register its routes: index.js, app.js and server/routes/. */
export const httpLayerFiles = () =>
    ['index.js', 'app.js', ...serverFiles().filter((f) => f.startsWith('routes/'))];

/** `httpLayerFiles()` as one text. */
export const httpLayer = () => readServerFiles(...httpLayerFiles());
