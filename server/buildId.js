// Which build is on disk — the one fact the running page needs to know whether
// it is out of date.
//
// The problem this answers: `npm run build` replaces `dist/`, but a window that
// is already open keeps running the JavaScript it loaded, and there is nothing
// in the app that would ever tell it otherwise. Restarting the server does not
// help — the window never reloads. So the app "worked but was a build behind"
// until someone knew to press Ctrl+Shift+R, which is not a feature.
//
// The identity is a hash of `dist/index.html`, and that is exactly right rather
// than merely convenient: every code and style change reaches the page through
// a hashed filename NAMED IN THAT FILE, so the file's bytes change if and only
// if the app the browser would load has changed. A server restart on an
// unchanged build produces the same id and no reload — which is the point; a
// restart is not news, a new build is.
//
// Recomputed when the file's mtime/size moves, so a rebuild while the server is
// running (`npm run build` in another terminal, the usual way of working here)
// is picked up without a restart.

import { createHash } from 'node:crypto';
import { statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// { path, id, mtimeMs, size }. The PATH is part of the key, not decoration: two
// different files written in the same millisecond at the same length would
// otherwise share an entry, and `freshness-gates` caught exactly that.
let cached = null;

/**
 * @param {string} indexHtmlPath absolute path to the built `dist/index.html`
 * @returns {string|null} a short stable id, or null when there is no build
 *   (a dev checkout serving through Vite — there HMR is the freshness story).
 */
export function buildId(indexHtmlPath) {
    let st;
    try {
        st = statSync(indexHtmlPath);
    } catch {
        cached = null;
        return null;
    }
    if (cached && cached.path === indexHtmlPath && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.id;
    try {
        const html = readFileSync(indexHtmlPath, 'utf8');
        if (!scriptsExist(html, dirname(indexHtmlPath))) return cached ? cached.id : null;
        const id = createHash('sha256').update(html).digest('hex').slice(0, 16);
        cached = { path: indexHtmlPath, id, mtimeMs: st.mtimeMs, size: st.size };
        return id;
    } catch {
        // Mid-write during a rebuild: report the previous id rather than a wrong
        // one. The next poll a second later reads the finished file.
        return cached ? cached.id : null;
    }
}

/**
 * Is this build finished?
 *
 * A watching build (`npm run standalone:watch`) empties `dist/assets` and writes
 * `index.html` before the chunks it names are back — observed, not theorised, on
 * 2026-09-09. Announcing that id would send every open page to reload itself
 * into a document whose only script is a 404, which is a worse failure than the
 * staleness this whole mechanism exists to fix. So a build is only news once the
 * files it points at are actually there.
 */
function scriptsExist(html, distDir) {
    const srcs = [...html.matchAll(/<script[^>]+src="\/([^"]+)"/g)].map((m) => m[1]);
    if (srcs.length === 0) return false;      // no entry named at all: not a build
    return srcs.every((src) => existsSync(join(distDir, src)));
}
