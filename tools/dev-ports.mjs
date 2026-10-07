// Which ports a checkout's dev servers use, and how a worktree picks its own.
//
// `npm run dev` starts two processes: Express (`npm run server`, which reads
// `.env` with --env-file-if-exists) and Vite, which proxies /api to it. The
// proxy used to name http://localhost:3001 outright, so the page talked to
// whatever held 3001 — on the maintainer's machine the INSTALLED desktop app,
// with the real library — while the server this checkout had just started
// died on EADDRINUSE. Both halves now read ONE answer, from the same places in
// the same order the server's own `Number(process.env.PORT) || 3001` does:
// the real environment, then `.env`, then the default.
//
// A linked git worktree gets its own pair, derived from its path (T3 Code's
// dev runner does the same), so several worktrees run side by side and none
// of them is ever on 3001. `tools/worktree-setup.mjs` writes the pair into the
// worktree's `.env` once, after checking both ports are free; from then on
// nothing guesses.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const DEFAULT_API_PORT = 3001;
export const DEFAULT_WEB_PORT = 5173;

/** Worktree ports: API 3101–3600, page 5201–5700. Clear of 3001 and 5173, and
 *  of each other, so a page port can never be read as an API port. */
export const WORKTREE_API_BASE = 3100;
export const WORKTREE_WEB_BASE = 5200;
export const WORKTREE_PORT_SPAN = 500;

/** The `.env` beside the app, parsed the way `node --env-file` parses it;
 *  `{}` when there is none. */
export function readDotEnv(root) {
    let text;
    try { text = readFileSync(join(root, '.env'), 'utf8'); } catch { return {}; }
    return parseEnv(text);
}

/** The server's own rule, `Number(value) || fallback`, so the proxy can never
 *  disagree with the port the server binds. */
function portOf(value, fallback) {
    return Number(value) || fallback;
}

/**
 * The API port and the page port for a checkout. A variable the environment
 * DEFINES wins over `.env`, even when it is empty, as it does for
 * `node --env-file` — so an empty PORT is the default here exactly as it is
 * for the server.
 */
export function devPorts({ root = process.cwd(), env = process.env } = {}) {
    const file = readDotEnv(root);
    const pick = (key) => (env[key] !== undefined ? env[key] : file[key]);
    return {
        api: portOf(pick('PORT'), DEFAULT_API_PORT),
        web: portOf(pick('VITE_PORT'), DEFAULT_WEB_PORT),
    };
}

/** A worktree's place in the port range, 1..WORKTREE_PORT_SPAN, stable across
 *  restarts. FNV-1a over the path as the file system compares it: separators
 *  unified, and lower-cased on Windows, where `D:\X` and `d:/x` are one folder. */
export function worktreePortOffset(path, { platform = process.platform } = {}) {
    let p = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
    if (platform === 'win32') p = p.toLowerCase();
    let h = 0x811c9dc5;
    for (let i = 0; i < p.length; i++) {
        h ^= p.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h % WORKTREE_PORT_SPAN) + 1;
}

/** The pair for an offset; an offset past the span wraps round to the start. */
export function portsForOffset(offset) {
    const o = ((offset - 1) % WORKTREE_PORT_SPAN + WORKTREE_PORT_SPAN) % WORKTREE_PORT_SPAN + 1;
    return { api: WORKTREE_API_BASE + o, web: WORKTREE_WEB_BASE + o };
}
