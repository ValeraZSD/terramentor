// Files in a packaged app's node_modules that nothing runs: source maps, type
// declarations, readmes and better-sqlite3's C sources (needed only to compile
// it again, and the package ships the compiled module). Measured on the
// 1.6.0 nightly for Windows: 48.8 MB of maps, 9.7 MB of SQLite source, 7.1 MB
// of declarations and 2.7 MB of readmes in a 210 MB node_modules.
//
// Licence and notice files stay whatever their extension: the packages'
// licences ask for their text to travel with the code.

import { readdirSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_NAME = /^(licen[cs]e|licence|notice|copying|authors|patents)([.-]|$)/i;

/** True when a path under node_modules (forward slashes, no leading
 *  `node_modules/`) is a file the app never reads. */
export function strippable(rel) {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    if (KEEP_NAME.test(name)) return false;
    if (/^better-sqlite3\/(deps|src)\//.test(rel)) return true;
    if (name.endsWith('.map')) return true;
    if (/\.d\.[cm]?ts$/.test(name)) return true;
    if (/\.(md|markdown)$/i.test(name)) return true;
    return false;
}

/** Delete every strippable file under `nodeModules`; returns what went. */
export function stripNodeModules(nodeModules) {
    let files = 0;
    let bytes = 0;
    // Returns true when the folder is left empty, so it goes too.
    const walk = (dir, rel) => {
        let left = 0;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isSymbolicLink()) { left++; continue; }
            if (e.isDirectory()) {
                if (walk(p, r)) rmSync(p, { recursive: true, force: true }); else left++;
                continue;
            }
            if (!strippable(r)) { left++; continue; }
            bytes += lstatSync(p).size;
            rmSync(p, { force: true });
            files++;
        }
        return left === 0;
    };
    walk(nodeModules, '');
    return { files, bytes };
}
